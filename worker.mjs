
import {
    patchRpHubAppJs,
    RpHubAppPatchError,
    RP_HUB_APP_PATCH_REVISION
} from './lib/app-patches.mjs';

const DEFAULT_UPSTREAM_REPO = 'STA1N156/RP-Hub';
const DEFAULT_RELEASE_LIMIT = 12;
// Free-plan Workers allow 50 external subrequests per invocation. A tree-based
// snapshot costs 1 (tree) + up to 32 (files) external fetches, plus the
// releases list and per-release commit resolution each round, so only one
// tree-based build fits per round. Artifact zip intake costs 1-2 fetches and
// R2 binding calls use the separate internal allowance, so neither is metered.
const MAX_TREE_SNAPSHOTS_PER_ROUND = 1;
const MAX_APP_UPDATE_FILES = 32;
const MAX_APP_UPDATE_TOTAL_BYTES = 160 * 1024 * 1024;
const MAX_APP_UPDATE_FILE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const MANIFEST_KEY = 'manifest.json';
const CONFIG_KEY = '_mirror/config.json';
const SYNC_ERROR_STATE_KEY = '_mirror/sync-error.json';
const SYNC_PROGRESS_KEY = '_mirror/sync-progress.json';
const ANNOUNCEMENTS_KEY = '_mirror/announcements.json';
const ANNOUNCEMENT_SOURCE_PATH = 'assets/js/built-in-content.js';
const ANNOUNCEMENT_ANCHOR = 'window.RPHubLatestUpdate = Object.freeze({';
const ANNOUNCEMENT_SCAN_WINDOW = 1024 * 1024;
const JSON_HEADERS = {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff'
};
const PRESERVED_APP_UPDATE_ROOTS = new Set([
    'DB',
    '_worker.js',
    'work.js',
    'wrangler.toml',
    'update-upstream.bat',
    '.git',
    '.github'
]);
const REQUIRED_UPSTREAM_FILES = new Set([
    'index.html',
    'assets/css/styles.css',
    'assets/js/app.js'
]);

class ReleaseIncompleteError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReleaseIncompleteError';
        this.reason = 'release-incomplete';
    }
}

class ManifestConflictError extends Error {
    constructor() {
        super('镜像 manifest 被另一轮同步更新，本轮未提交。');
        this.name = 'ManifestConflictError';
    }
}

class ArtifactUnavailableError extends Error {
    constructor(message, status = '') {
        super(message);
        this.name = 'ArtifactUnavailableError';
        this.status = status;
    }
}

class ArtifactParseError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ArtifactParseError';
    }
}

function nowValue(now) {
    return typeof now === 'function' ? Number(now()) : Number(now);
}

function toErrorMessage(error) {
    return error instanceof Error ? error.message : String(error || 'unknown error');
}

function configuredSecret(env, key) {
    return typeof env?.[key] === 'string' && env[key].trim().length > 0;
}

function redactText(value, env) {
    let message = String(value ?? '');
    const values = ['GITHUB_TOKEN', 'WEBHOOK_URL', 'WEBHOOK_TOKEN', 'ADMIN_TOKEN']
        .map((key) => typeof env?.[key] === 'string' ? env[key] : '')
        .filter(Boolean)
        .sort((left, right) => right.length - left.length);
    for (const value of values) message = message.replaceAll(value, '[redacted]');
    return message;
}

function safeErrorMessage(error, env) {
    return redactText(toErrorMessage(error), env);
}

function jsonResponse(value, init = {}) {
    const headers = new Headers(init.headers || {});
    for (const [key, headerValue] of Object.entries(JSON_HEADERS)) {
        if (!headers.has(key)) headers.set(key, headerValue);
    }
    return new Response(JSON.stringify(value), { ...init, headers });
}

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeReleaseTag(value) {
    const tag = String(value || '').trim();
    return /^[A-Za-z0-9._/-]{1,120}$/.test(tag) && !tag.includes('..') ? tag : '';
}

function encodePathSegments(value) {
    return String(value || '').split('/').map((part) => encodeURIComponent(part)).join('/');
}

function isAllowedAppUpdatePath(path) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..')) return false;
    return !PRESERVED_APP_UPDATE_ROOTS.has(path.split('/')[0]);
}

async function sha256Bytes(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetchImpl(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

function githubHeaders(env, accept = 'application/vnd.github+json') {
    const token = typeof env?.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : '';
    if (!token) throw new Error('缺少 GITHUB_TOKEN secret。');
    return {
        accept,
        authorization: `Bearer ${token}`,
        'user-agent': 'RP-Hub-R2-Mirror'
    };
}

function rawFileHeaders() {
    return {
        accept: 'application/octet-stream',
        'user-agent': 'RP-Hub-R2-Mirror'
    };
}

async function fetchGitHubJson(fetchImpl, env, url) {
    const response = await fetchWithTimeout(fetchImpl, url, {
        headers: githubHeaders(env)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub 请求失败：HTTP ${response.status} ${text.slice(0, 300)}`);
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`GitHub 返回的数据不是有效 JSON：${url}`);
    }
}

async function fetchRawFile(fetchImpl, env, repo, commit, path) {
    const url = `https://raw.githubusercontent.com/${repo}/${commit}/${encodePathSegments(path)}`;
    const response = await fetchWithTimeout(fetchImpl, url, {
        headers: rawFileHeaders()
    });
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`下载上游文件失败：${path}；HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

function normalizeReleaseLimit(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isSafeInteger(parsed) && parsed > 0
        ? Math.min(parsed, DEFAULT_RELEASE_LIMIT)
        : DEFAULT_RELEASE_LIMIT;
}

function clampReleaseLimit(value) {
    return Math.max(1, Math.min(Number(value), DEFAULT_RELEASE_LIMIT));
}

function defaultRuntimeConfig(env) {
    return {
        releaseLimit: normalizeReleaseLimit(env?.RELEASE_LIMIT),
        webhookEnabled: true
    };
}

function mergeStoredRuntimeConfig(value, fallback) {
    if (!plainObject(value)) return fallback;
    const keys = Object.keys(value);
    if (keys.some((key) => key !== 'releaseLimit' && key !== 'webhookEnabled')) return fallback;
    const config = { ...fallback };
    if (Object.hasOwn(value, 'releaseLimit')) {
        if (typeof value.releaseLimit !== 'number' || !Number.isInteger(value.releaseLimit)) return fallback;
        config.releaseLimit = clampReleaseLimit(value.releaseLimit);
    }
    if (Object.hasOwn(value, 'webhookEnabled')) {
        if (typeof value.webhookEnabled !== 'boolean') return fallback;
        config.webhookEnabled = value.webhookEnabled;
    }
    return config;
}

async function readRuntimeConfigState(bucket, env) {
    const fallback = defaultRuntimeConfig(env);
    let object = null;
    try {
        object = await bucket.get(CONFIG_KEY);
        if (!object) return { object: null, config: fallback, valid: true };
        const value = JSON.parse(await object.text());
        const config = mergeStoredRuntimeConfig(value, fallback);
        return { object, config, valid: plainObject(value) && config !== fallback };
    } catch {
        return { object, config: fallback, valid: false };
    }
}

async function readRuntimeConfig(bucket, env) {
    return (await readRuntimeConfigState(bucket, env)).config;
}

function configUpdate(value, current) {
    if (!plainObject(value)) throw new Error('配置必须是 JSON 对象。');
    const keys = Object.keys(value);
    if (keys.length === 0) throw new Error('至少提供一项配置。');
    if (keys.some((key) => key !== 'releaseLimit' && key !== 'webhookEnabled')) {
        throw new Error('只允许 releaseLimit 和 webhookEnabled。');
    }
    const config = { ...current };
    if (Object.hasOwn(value, 'releaseLimit')) {
        if (typeof value.releaseLimit !== 'number' || !Number.isInteger(value.releaseLimit)) {
            throw new Error('releaseLimit 必须是整数。');
        }
        config.releaseLimit = clampReleaseLimit(value.releaseLimit);
    }
    if (Object.hasOwn(value, 'webhookEnabled')) {
        if (typeof value.webhookEnabled !== 'boolean') {
            throw new Error('webhookEnabled 必须是布尔值。');
        }
        config.webhookEnabled = value.webhookEnabled;
    }
    return config;
}

async function constantTimeEqual(left, right) {
    const encoder = new TextEncoder();
    const [leftDigest, rightDigest] = await Promise.all([
        crypto.subtle.digest('SHA-256', encoder.encode(left)),
        crypto.subtle.digest('SHA-256', encoder.encode(right))
    ]);
    const leftBytes = new Uint8Array(leftDigest);
    const rightBytes = new Uint8Array(rightDigest);
    let difference = left.length ^ right.length;
    for (let index = 0; index < leftBytes.length; index += 1) {
        difference |= leftBytes[index] ^ rightBytes[index];
    }
    return difference === 0;
}

async function authorizeWrite(request, env) {
    const expected = typeof env?.ADMIN_TOKEN === 'string' ? env.ADMIN_TOKEN.trim() : '';
    if (!expected) {
        return jsonResponse({
            ok: false,
            error: '未配置 ADMIN_TOKEN，请先运行 wrangler secret put ADMIN_TOKEN。'
        }, { status: 403 });
    }
    const authorization = request.headers.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    const supplied = match ? match[1].trim() : '';
    if (!supplied || !(await constantTimeEqual(supplied, expected))) {
        return jsonResponse({ ok: false, error: '管理员令牌无效。' }, { status: 403 });
    }
    return null;
}

async function fetchReleases(fetchImpl, env, repo, releaseLimit) {
    const releases = await fetchGitHubJson(
        fetchImpl,
        env,
        `https://api.github.com/repos/${repo}/releases?per_page=${releaseLimit}`
    );
    if (!Array.isArray(releases)) throw new Error('GitHub Releases 列表格式异常。');
    return releases
        .filter((release) => !release?.draft)
        .map((release) => ({
            tag: sanitizeReleaseTag(release?.tag_name),
            name: typeof release?.name === 'string' && release.name ? release.name : String(release?.tag_name || ''),
            date: typeof release?.published_at === 'string' ? release.published_at : ''
        }))
        .filter((release) => release.tag)
        .slice(0, releaseLimit);
}

async function resolveReleaseCommit(fetchImpl, env, repo, tag) {
    const commit = await fetchGitHubJson(
        fetchImpl,
        env,
        `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(tag)}`
    );
    const sha = typeof commit?.sha === 'string' ? commit.sha.toLowerCase() : '';
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`GitHub 未能解析 Release tag：${tag}`);
    return sha;
}

function selectTreeFiles(tree, tag) {
    if (!tree || !Array.isArray(tree.tree) || tree.truncated) {
        throw new ReleaseIncompleteError(`Release ${tag} 的递归文件树不完整。`);
    }
    const files = [];
    for (const entry of tree.tree) {
        const path = typeof entry?.path === 'string' ? entry.path : '';
        if (entry?.type !== 'blob' || !isAllowedAppUpdatePath(path)) continue;
        const size = Number(entry.size || 0);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_APP_UPDATE_FILE_BYTES) {
            throw new ReleaseIncompleteError(`上游文件过大，已停止更新：${path}`);
        }
        files.push(path);
        if (files.length > MAX_APP_UPDATE_FILES) {
            throw new ReleaseIncompleteError(`上游文件数量超过限制（${MAX_APP_UPDATE_FILES}），已停止更新。`);
        }
    }
    files.sort((left, right) => left.localeCompare(right));
    for (const required of REQUIRED_UPSTREAM_FILES) {
        if (!files.includes(required)) throw new ReleaseIncompleteError(`上游 Release 缺少必要文件：${required}`);
    }
    return files;
}

async function fetchReleaseTree(fetchImpl, env, repo, tag, commit) {
    const tree = await fetchGitHubJson(
        fetchImpl,
        env,
        `https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`
    );
    return selectTreeFiles(tree, tag);
}

function readUint16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
    return (bytes[offset]
        | (bytes[offset + 1] << 8)
        | (bytes[offset + 2] << 16)
        | (bytes[offset + 3] << 24)) >>> 0;
}

function decodeZipName(bytes) {
    return new TextDecoder().decode(bytes);
}

async function inflateZipEntry(bytes) {
    if (typeof DecompressionStream !== 'function') {
        throw new ArtifactParseError('当前 Worker 不支持 ZIP deflate 解压。');
    }
    try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
        throw new ArtifactParseError(`ZIP deflate 解压失败：${toErrorMessage(error)}`);
    }
}

async function extractArtifactTar(zipBytes) {
    if (!(zipBytes instanceof Uint8Array) || zipBytes.byteLength < 22) {
        throw new ArtifactParseError('artifact ZIP 过短。');
    }
    let eocd = -1;
    const searchStart = Math.max(0, zipBytes.byteLength - 0xffff - 22);
    for (let offset = zipBytes.byteLength - 22; offset >= searchStart; offset -= 1) {
        if (readUint32(zipBytes, offset) === 0x06054b50) {
            eocd = offset;
            break;
        }
    }
    if (eocd < 0) throw new ArtifactParseError('ZIP 缺少中央目录结束记录。');
    const disk = readUint16(zipBytes, eocd + 4);
    const centralDisk = readUint16(zipBytes, eocd + 6);
    const entriesOnDisk = readUint16(zipBytes, eocd + 8);
    const entries = readUint16(zipBytes, eocd + 10);
    const centralSize = readUint32(zipBytes, eocd + 12);
    const centralOffset = readUint32(zipBytes, eocd + 16);
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries
        || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
        || centralOffset + centralSize > zipBytes.byteLength) {
        throw new ArtifactParseError('ZIP 使用了不支持的 ZIP64 或多磁盘结构。');
    }

    let offset = centralOffset;
    const found = [];
    for (let index = 0; index < entries; index += 1) {
        if (offset + 46 > zipBytes.byteLength || readUint32(zipBytes, offset) !== 0x02014b50) {
            throw new ArtifactParseError('ZIP 中央目录条目无效。');
        }
        const flags = readUint16(zipBytes, offset + 8);
        const method = readUint16(zipBytes, offset + 10);
        const compressedSize = readUint32(zipBytes, offset + 20);
        const uncompressedSize = readUint32(zipBytes, offset + 24);
        const nameLength = readUint16(zipBytes, offset + 28);
        const extraLength = readUint16(zipBytes, offset + 30);
        const commentLength = readUint16(zipBytes, offset + 32);
        const localOffset = readUint32(zipBytes, offset + 42);
        const end = offset + 46 + nameLength + extraLength + commentLength;
        if (end > zipBytes.byteLength || compressedSize === 0xffffffff
            || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
            throw new ArtifactParseError('ZIP 条目使用了不支持的 ZIP64 字段。');
        }
        const name = decodeZipName(zipBytes.slice(offset + 46, offset + 46 + nameLength));
        offset = end;
        if ((flags & 0x01) !== 0) throw new ArtifactParseError('artifact ZIP 使用了加密条目。');
        if (name.endsWith('/')) continue;
        found.push({ name, method, compressedSize, uncompressedSize, localOffset });
    }
    if (found.length !== 1 || found[0].name !== 'artifact.tar') {
        throw new ArtifactParseError('artifact ZIP 必须只包含唯一的 artifact.tar。');
    }
    const entry = found[0];
    if (entry.localOffset + 30 > zipBytes.byteLength
        || readUint32(zipBytes, entry.localOffset) !== 0x04034b50) {
        throw new ArtifactParseError('artifact.tar 的 ZIP 本地头无效。');
    }
    const localNameLength = readUint16(zipBytes, entry.localOffset + 26);
    const localExtraLength = readUint16(zipBytes, entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > zipBytes.byteLength) throw new ArtifactParseError('artifact.tar 的 ZIP 数据越界。');
    const compressed = zipBytes.slice(dataStart, dataEnd);
    let tarBytes;
    if (entry.method === 0) tarBytes = compressed;
    else if (entry.method === 8) tarBytes = await inflateZipEntry(compressed);
    else throw new ArtifactParseError(`ZIP 压缩方式不支持：${entry.method}`);
    if (tarBytes.byteLength !== entry.uncompressedSize) {
        throw new ArtifactParseError('artifact.tar 解压大小校验失败。');
    }
    return tarBytes;
}

function tarText(bytes, offset, length) {
    const end = Math.min(bytes.byteLength, offset + length);
    let stop = offset;
    while (stop < end && bytes[stop] !== 0) stop += 1;
    return new TextDecoder().decode(bytes.slice(offset, stop));
}

function tarSize(bytes, offset) {
    const text = tarText(bytes, offset, 12).trim();
    if (!text) return 0;
    if (/^[0-7]+$/.test(text)) return Number.parseInt(text, 8);
    throw new ArtifactParseError('TAR 文件大小字段无效。');
}

function validateTarChecksum(header) {
    const recordedText = tarText(header, 148, 8).trim();
    if (!recordedText || !/^[0-7]+$/.test(recordedText)) {
        throw new ArtifactParseError('TAR header 校验和无效。');
    }
    const recorded = Number.parseInt(recordedText, 8);
    let sum = 0;
    for (let index = 0; index < header.byteLength; index += 1) {
        sum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (sum !== recorded) throw new ArtifactParseError('TAR header 校验和不匹配。');
}

function normalizeArtifactPath(value) {
    let path = String(value || '').replaceAll('\\', '/');
    while (path.startsWith('./')) path = path.slice(2);
    if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
        throw new ArtifactParseError(`TAR 路径无效：${value}`);
    }
    const parts = path.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) {
        throw new ArtifactParseError(`TAR 路径含非法段：${value}`);
    }
    return parts.join('/');
}

function parsePaxPath(bytes) {
    const text = new TextDecoder().decode(bytes);
    let path = '';
    let offset = 0;
    while (offset < text.length) {
        const space = text.indexOf(' ', offset);
        if (space < 0) throw new ArtifactParseError('TAR PAX 扩展头无效。');
        const length = Number.parseInt(text.slice(offset, space), 10);
        if (!Number.isSafeInteger(length) || length <= 0 || offset + length > text.length) {
            throw new ArtifactParseError('TAR PAX 扩展头长度无效。');
        }
        const record = text.slice(space + 1, offset + length);
        if (record.startsWith('path=')) path = record.slice(5).replace(/\n$/, '');
        offset += length;
    }
    return path;
}

function parseArtifactTar(tarBytes) {
    if (!(tarBytes instanceof Uint8Array) || tarBytes.byteLength < 1024) {
        throw new ArtifactParseError('artifact.tar 过短。');
    }
    const files = new Map();
    let offset = 0;
    let zeroBlocks = 0;
    let pendingLongName = '';
    let pendingPaxPath = '';
    while (offset + 512 <= tarBytes.byteLength) {
        const header = tarBytes.slice(offset, offset + 512);
        const allZero = header.every((byte) => byte === 0);
        if (allZero) {
            zeroBlocks += 1;
            offset += 512;
            if (zeroBlocks >= 2) break;
            continue;
        }
        zeroBlocks = 0;
        validateTarChecksum(header);
        const name = tarText(header, 0, 100);
        const prefix = tarText(header, 345, 155);
        const type = String.fromCharCode(header[156] || 0);
        const size = tarSize(header, 124);
        if (!Number.isSafeInteger(size) || size < 0) {
            throw new ArtifactParseError(`TAR 文件过大：${name}`);
        }
        const dataStart = offset + 512;
        const dataEnd = dataStart + size;
        const paddedEnd = dataStart + Math.ceil(size / 512) * 512;
        if (paddedEnd > tarBytes.byteLength) throw new ArtifactParseError('TAR 文件数据越界。');
        const data = tarBytes.slice(dataStart, dataEnd);
        const headerPath = prefix ? `${prefix}/${name}` : name;
        const entryPath = pendingPaxPath || pendingLongName || headerPath;
        if (!['L', 'K', 'x', 'g'].includes(type)) {
            const candidatePath = type === '5'
                ? String(entryPath || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
                : entryPath;
            if (candidatePath) normalizeArtifactPath(candidatePath);
        }
        if (type === 'L') {
            pendingLongName = new TextDecoder().decode(data).replace(/\0+$/, '');
        } else if (type === 'x' || type === 'g') {
            const paxPath = parsePaxPath(data);
            if (type === 'x' && paxPath) pendingPaxPath = paxPath;
        } else if (type === '0' || type === '\0' || type === '7') {
            const rawPath = entryPath;
            pendingPaxPath = '';
            pendingLongName = '';
            const path = normalizeArtifactPath(rawPath);
            if (isAllowedAppUpdatePath(path) && size > MAX_APP_UPDATE_FILE_BYTES) {
                throw new ReleaseIncompleteError(`上游文件过大，已停止更新：${path}`);
            }
            if (files.has(path)) throw new ArtifactParseError(`TAR 存在重复文件：${path}`);
            files.set(path, data);
        } else if (type === '5') {
            const directoryPath = String(entryPath || '').replaceAll('\\', '/');
            const normalizedDirectory = directoryPath.replace(/^\.\//, '').replace(/\/+$/, '');
            if (normalizedDirectory) normalizeArtifactPath(normalizedDirectory);
            pendingPaxPath = '';
            pendingLongName = '';
        } else {
            pendingPaxPath = '';
            pendingLongName = '';
        }
        offset = paddedEnd;
    }
    if (zeroBlocks < 2) throw new ArtifactParseError('TAR 缺少结束块。');
    return files;
}

async function fetchLatestArtifact(fetchImpl, env, repo) {
    const payload = await fetchGitHubJson(
        fetchImpl,
        env,
        `https://api.github.com/repos/${repo}/actions/artifacts?per_page=10`
    );
    if (!plainObject(payload) || !Array.isArray(payload.artifacts)) {
        throw new Error('GitHub Artifacts 列表格式异常。');
    }
    const candidates = payload.artifacts
        .filter((artifact) => artifact?.name === 'github-pages')
        .sort((left, right) => String(right?.created_at || '').localeCompare(String(left?.created_at || '')));
    if (!candidates.length) return null;
    const active = candidates.find((artifact) => artifact?.expired === false);
    const selected = active || { ...candidates[0], expired: true };
    return { artifact: selected, expired: !active };
}

function artifactHeadSha(artifact) {
    const value = artifact?.workflow_run?.head_sha || artifact?.head_sha;
    const sha = typeof value === 'string' ? value.toLowerCase() : '';
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new ArtifactParseError('github-pages artifact 缺少有效 head_sha。');
    return sha;
}

async function downloadArtifact(fetchImpl, env, artifact) {
    if (artifact?.expired === true) throw new ArtifactUnavailableError('github-pages artifact 已过期。', 'expired');
    const url = typeof artifact?.archive_download_url === 'string' ? artifact.archive_download_url : '';
    if (!url) throw new ArtifactParseError('github-pages artifact 缺少下载地址。');
    // GitHub's artifact zip endpoint rejects Accept: application/octet-stream
    // with HTTP 415; it requires a JSON-compatible Accept before redirecting.
    const response = await fetchWithTimeout(fetchImpl, url, {
        headers: githubHeaders(env)
    });
    if ([401, 403, 410].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw new ArtifactUnavailableError(`github-pages artifact 下载不可用：HTTP ${response.status}`, response.status);
    }
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`github-pages artifact 下载失败：HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const expected = String(artifact?.digest || '').toLowerCase().replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new ArtifactParseError('github-pages artifact 缺少有效 digest。');
    const actual = await sha256Bytes(bytes);
    if (actual !== expected) throw new ArtifactParseError(`github-pages artifact digest 校验失败：${actual}`);
    return bytes;
}

function artifactDateParts(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new ArtifactParseError('github-pages artifact created_at 无效。');
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const valueOf = (type) => parts.find((part) => part.type === type)?.value || '';
    return { mmdd: `${valueOf('month')}${valueOf('day')}`, hhmm: `${valueOf('hour')}${valueOf('minute')}` };
}

function isDerivedTag(tag) {
    return /(?:^|-)\d{4}(?:-\d{4})?(?:-[a-f0-9]{8})?$/.test(String(tag || ''));
}

function deriveArtifactTag(baseTag, createdAt, commit, manifest, releases) {
    const { mmdd, hhmm } = artifactDateParts(createdAt);
    const base = sanitizeReleaseTag(`${baseTag || '0.0.0'}-${mmdd}`);
    if (!base) throw new ArtifactParseError('无法生成合法的 artifact 衍生版本号。');
    const used = new Map([
        ...manifest.versions.map((version) => [version.tag, version.commit]),
        ...manifest.pending.map((pending) => [pending.tag, pending.commit]),
        ...releases.map((release) => [release.tag, 'release'])
    ]);
    if (!used.has(base) || used.get(base) === commit) return base;
    const withTime = sanitizeReleaseTag(`${base}-${hhmm}`);
    if (!withTime) throw new ArtifactParseError('无法生成合法的 artifact 冲突版本号。');
    if (!used.has(withTime) || used.get(withTime) === commit) return withTime;
    return sanitizeReleaseTag(`${withTime}-${String(commit).slice(0, 8)}`);
}

async function storeSnapshotFile(bucket, key, bytes, descriptor) {
    await bucket.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: {
            sha256: descriptor.sha256,
            size: String(descriptor.size)
        }
    });
}

function validateArtifactFiles(files) {
    if (!(files instanceof Map)) throw new ArtifactParseError('artifact 文件集格式无效。');
    const paths = [];
    let totalBytes = 0;
    for (const [path, bytes] of files.entries()) {
        if (!isAllowedAppUpdatePath(path)) continue;
        if (!(bytes instanceof Uint8Array)) throw new ArtifactParseError(`artifact 文件字节无效：${path}`);
        if (bytes.byteLength > MAX_APP_UPDATE_FILE_BYTES) {
            throw new ReleaseIncompleteError(`上游文件过大，已停止更新：${path}`);
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_APP_UPDATE_TOTAL_BYTES) {
            throw new ReleaseIncompleteError('上游文件总大小超过限制（160MiB），已停止更新。');
        }
        paths.push(path);
        if (paths.length > MAX_APP_UPDATE_FILES) {
            throw new ReleaseIncompleteError(`上游文件数量超过限制（${MAX_APP_UPDATE_FILES}），已停止更新。`);
        }
    }
    paths.sort((left, right) => left.localeCompare(right));
    for (const required of REQUIRED_UPSTREAM_FILES) {
        if (!paths.includes(required)) throw new ReleaseIncompleteError(`上游 Release 缺少必要文件：${required}`);
    }
    return paths;
}

async function buildVersionSnapshotFromFiles(bucket, release, commit, files, announcementSources) {
    const paths = validateArtifactFiles(files);
    const descriptors = [];
    let appJsBytes = null;
    let nonAppTotalBytes = 0;
    for (const path of paths) {
        const bytes = files.get(path);
        const descriptor = {
            path,
            sha256: await sha256Bytes(bytes),
            size: bytes.byteLength
        };
        await storeSnapshotFile(
            bucket,
            `snapshots/${release.tag}/${commit}/${path}`,
            bytes,
            descriptor
        );
        if (path === ANNOUNCEMENT_SOURCE_PATH && announcementSources) {
            announcementSources.set(`${release.tag}\0${commit}`, bytes);
        }
        if (path === 'assets/js/app.js') appJsBytes = bytes;
        else nonAppTotalBytes += bytes.byteLength;
        descriptors.push(descriptor);
    }

    const patchedAppJs = new TextEncoder().encode(
        patchRpHubAppJs(new TextDecoder().decode(appJsBytes), { version: release.tag }).code
    );
    if (patchedAppJs.byteLength > MAX_APP_UPDATE_FILE_BYTES) {
        throw new ReleaseIncompleteError('上游文件过大，已停止更新：assets/js/app.js');
    }
    if (nonAppTotalBytes + patchedAppJs.byteLength > MAX_APP_UPDATE_TOTAL_BYTES) {
        throw new ReleaseIncompleteError('上游文件总大小超过限制（160MiB），已停止更新。');
    }
    return {
        tag: release.tag,
        commit,
        name: release.name || release.tag,
        date: release.date || '',
        precheckPatchRevision: RP_HUB_APP_PATCH_REVISION,
        files: descriptors
    };
}

async function buildVersionSnapshot(fetchImpl, env, bucket, repo, release, commit, announcementSources) {
    const paths = await fetchReleaseTree(fetchImpl, env, repo, release.tag, commit);
    const files = new Map();
    for (const path of paths) files.set(path, await fetchRawFile(fetchImpl, env, repo, commit, path));
    return buildVersionSnapshotFromFiles(bucket, release, commit, files, announcementSources);
}

function emptyManifest(repo) {
    return {
        schema: 1,
        updatedAt: 0,
        upstreamRepo: repo,
        versions: [],
        pending: []
    };
}

async function readJsonObject(bucket, key) {
    const object = await bucket.get(key);
    if (!object) return { object: null, value: null };
    return { object, value: JSON.parse(await object.text()) };
}

function validateStoredManifest(value, repo) {
    if (value === null) return emptyManifest(repo);
    if (
        !value
        || value.schema !== 1
        || value.upstreamRepo !== repo
        || !Array.isArray(value.versions)
        || !Array.isArray(value.pending)
    ) {
        throw new Error('现有镜像 manifest 格式无效，已拒绝覆盖。');
    }
    return structuredClone(value);
}

function manifestPutOptions(object) {
    return {
        onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    };
}

function pendingKey(entry) {
    return `${entry.tag}\0${entry.commit}`;
}

function addPending(manifest, entry) {
    const key = pendingKey(entry);
    manifest.pending = manifest.pending.filter((item) => pendingKey(item) !== key);
    manifest.pending.push(entry);
}

function removePending(manifest, tag, commit) {
    const key = `${tag}\0${commit}`;
    manifest.pending = manifest.pending.filter((item) => pendingKey(item) !== key);
}

async function sendWebhook(fetchImpl, env, payload, enabled = true) {
    if (!enabled) return { sent: false, skipped: true, disabled: true };
    const url = typeof env?.WEBHOOK_URL === 'string' ? env.WEBHOOK_URL.trim() : '';
    if (!url) return { sent: false, skipped: true, disabled: false };
    const safePayload = Object.fromEntries(Object.entries(payload).map(([key, value]) => [
        key,
        typeof value === 'string' ? redactText(value, env) : value
    ]));
    const headers = { 'content-type': 'application/json' };
    const token = typeof env?.WEBHOOK_TOKEN === 'string' ? env.WEBHOOK_TOKEN.trim() : '';
    if (token) headers.authorization = `Bearer ${token}`;
    try {
        const response = await fetchWithTimeout(fetchImpl, url, {
            method: 'POST',
            headers,
            body: JSON.stringify(safePayload)
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new Error(`HTTP ${response.status}`);
        }
        return { sent: true, skipped: false, disabled: false };
    } catch (error) {
        console.error(JSON.stringify({
            message: 'mirror webhook failed',
            event: payload.event,
            tag: redactText(payload.tag, env),
            error: safeErrorMessage(error, env)
        }));
        return { sent: false, skipped: false, disabled: false };
    }
}

async function reportSyncError(fetchImpl, env, bucket, context, error, at, webhookEnabled) {
    const detail = safeErrorMessage(error, env).slice(0, 1000);
    const fingerprint = await sha256Bytes(new TextEncoder().encode(JSON.stringify([
        context.tag || '',
        context.commit || '',
        detail
    ])));
    let prior = null;
    try {
        prior = (await readJsonObject(bucket, SYNC_ERROR_STATE_KEY)).value;
    } catch (stateError) {
        console.error(JSON.stringify({ message: 'mirror sync-error state read failed', error: safeErrorMessage(stateError, env) }));
    }
    if (prior?.fingerprint === fingerprint) return false;
    await sendWebhook(fetchImpl, env, {
        event: 'sync_error',
        tag: context.tag || '',
        commit: context.commit || '',
        detail,
        at
    }, webhookEnabled);
    try {
        await bucket.put(SYNC_ERROR_STATE_KEY, JSON.stringify({
            fingerprint,
            at,
            tag: context.tag || '',
            commit: context.commit || '',
            detail
        }), {
            httpMetadata: { contentType: 'application/json; charset=utf-8' }
        });
    } catch (stateError) {
        console.error(JSON.stringify({ message: 'mirror sync-error state write failed', error: safeErrorMessage(stateError, env) }));
    }
    return webhookEnabled;
}

async function clearSyncErrorState(bucket, env) {
    try {
        await bucket.delete(SYNC_ERROR_STATE_KEY);
    } catch (error) {
        console.error(JSON.stringify({ message: 'mirror sync-error state clear failed', error: safeErrorMessage(error, env) }));
    }
}

function createSyncProgressReporter(bucket, env, now) {
    const startedAt = nowValue(now);
    let step = 0;
    return async (state, phase, detail = '') => {
        step += 1;
        try {
            await bucket.put(SYNC_PROGRESS_KEY, JSON.stringify({
                state,
                step,
                phase,
                detail: redactText(String(detail || ''), env).slice(0, 500),
                startedAt,
                at: nowValue(now)
            }), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
        } catch (error) {
            console.error(JSON.stringify({ message: 'mirror sync-progress write failed', error: safeErrorMessage(error, env) }));
        }
    };
}

function announcementFailed(reason) {
    return { announcement: null, reason };
}

function scanDelimitedSource(text, start, quote) {
    // Delimiter-aware scan over raw source text: a `\x` pair is kept verbatim
    // and can never close the string, so an escaped \` inside the template
    // literal cannot terminate extraction. No unescaping, no evaluation.
    if (text[start] !== quote) return null;
    let value = '';
    let index = start + 1;
    while (index < text.length) {
        const character = text[index];
        if (character === '\\') {
            const next = text[index + 1];
            if (next === undefined) return null;
            value += character + next;
            index += 2;
            continue;
        }
        if (character === quote) return { value, end: index + 1 };
        value += character;
        index += 1;
    }
    return null;
}

function extractAnnouncement(source) {
    // Anchor + sequential regex extraction only; the snapshot file is untrusted
    // upstream text and must never reach eval/Function/import. `${` inside the
    // template literal means interpolation ambiguity -> parse-failed.
    try {
        const text = String(source ?? '');
        const anchorIndex = text.indexOf(ANNOUNCEMENT_ANCHOR);
        if (anchorIndex < 0) return announcementFailed('not-found');
        const bodyStart = anchorIndex + ANNOUNCEMENT_ANCHOR.length;
        const body = text.slice(bodyStart, bodyStart + ANNOUNCEMENT_SCAN_WINDOW);
        const idMatch = /\bid\s*:\s*(\d{1,10})\s*[,}]/.exec(body);
        if (!idMatch) return announcementFailed('parse-failed');
        const firstLiteral = body.search(/['`]/);
        if (firstLiteral >= 0 && idMatch.index > firstLiteral) return announcementFailed('parse-failed');
        const id = Number.parseInt(idMatch[1], 10);
        const afterId = idMatch.index + idMatch[0].length;
        const titleMatch = /\btitle\s*:\s*'/.exec(body.slice(afterId));
        if (!titleMatch) return announcementFailed('parse-failed');
        const titleQuoteAt = afterId + titleMatch.index + titleMatch[0].length - 1;
        const title = scanDelimitedSource(body, titleQuoteAt, "'");
        if (!title) return announcementFailed('parse-failed');
        const contentMatch = /\bcontent\s*:\s*`/.exec(body.slice(title.end));
        if (!contentMatch) return announcementFailed('parse-failed');
        const contentQuoteAt = title.end + contentMatch.index + contentMatch[0].length - 1;
        const content = scanDelimitedSource(body, contentQuoteAt, '`');
        if (!content || content.value.includes('${')) return announcementFailed('parse-failed');
        return { announcement: { id, title: title.value, content: content.value } };
    } catch {
        return announcementFailed('parse-failed');
    }
}

async function regenerateAnnouncements(bucket, manifest, announcementSources, generatedAt) {
    const versions = Array.isArray(manifest?.versions) ? manifest.versions : [];
    const entries = [];
    for (const version of versions) {
        const tag = typeof version?.tag === 'string' ? version.tag : '';
        const commit = typeof version?.commit === 'string' ? version.commit : '';
        const missing = { tag, commit, announcement: null, reason: 'not-found' };
        if (!tag || !commit) {
            entries.push(missing);
            continue;
        }
        try {
            let text = null;
            const bytes = announcementSources instanceof Map
                ? announcementSources.get(`${tag}\0${commit}`)
                : null;
            if (bytes) {
                text = new TextDecoder().decode(bytes);
            } else {
                const object = await bucket.get(`snapshots/${tag}/${commit}/${ANNOUNCEMENT_SOURCE_PATH}`);
                if (object) text = await object.text();
            }
            if (text === null) {
                entries.push(missing);
                continue;
            }
            const extracted = extractAnnouncement(text);
            entries.push(extracted.announcement
                ? { tag, commit, announcement: extracted.announcement }
                : { tag, commit, announcement: null, reason: extracted.reason || 'parse-failed' });
        } catch {
            entries.push({ tag, commit, announcement: null, reason: 'parse-failed' });
        }
    }
    await bucket.put(ANNOUNCEMENTS_KEY, JSON.stringify({ generatedAt, entries }, null, 2), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });
}

async function pruneAnnouncementEntry(bucket, tag, commit) {
    const state = await readJsonObject(bucket, ANNOUNCEMENTS_KEY);
    if (!state.object || !plainObject(state.value) || !Array.isArray(state.value.entries)) return;
    const entries = state.value.entries.filter((entry) => !(entry?.tag === tag && entry?.commit === commit));
    if (entries.length === state.value.entries.length) return;
    const stored = await bucket.put(ANNOUNCEMENTS_KEY, JSON.stringify({ ...state.value, entries }, null, 2), {
        onlyIf: { etagMatches: state.object.etag },
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });
    if (!stored) {
        console.error(JSON.stringify({ message: 'mirror announcements prune lost a concurrent update; next sync regenerates' }));
    }
}

export async function syncMirror(env, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const now = options.now || Date.now;
    const bucket = env?.MIRROR_BUCKET;
    if (!bucket) throw new Error('缺少 MIRROR_BUCKET R2 binding。');
    const repo = typeof env.UPSTREAM_REPO === 'string' && env.UPSTREAM_REPO.trim()
        ? env.UPSTREAM_REPO.trim()
        : DEFAULT_UPSTREAM_REPO;
    const runtimeConfig = await readRuntimeConfig(bucket, env);
    const releaseLimit = runtimeConfig.releaseLimit;
    const context = { tag: '', commit: '' };
    const reportProgress = createSyncProgressReporter(bucket, env, now);
    const announcementSources = new Map();
    try {
        await reportProgress('running', '开始同步', '读取 manifest 与上游 Release 列表');
        const manifestState = await readJsonObject(bucket, MANIFEST_KEY);
        const manifest = validateStoredManifest(manifestState.value, repo);
        const releases = await fetchReleases(fetchImpl, env, repo, releaseLimit);
        const existingByTag = new Map(manifest.versions.map((version) => [version.tag, version]));
        const pendingPairs = new Set(manifest.pending.map(pendingKey));
        const releaseCommits = new Map();
        const officialTags = new Set(releases.map((release) => release.tag));
        const events = [];
        let changed = false;
        let snapshotsBuilt = 0;
        let snapshotBudgetExhausted = false;
        let artifactSyncError = null;
        let artifactFallbackWarning = null;
        let artifactTag = '';
        let artifactCommit = '';

        for (const release of releases) {
            context.tag = release.tag;
            context.commit = await resolveReleaseCommit(fetchImpl, env, repo, release.tag);
            releaseCommits.set(release.tag, context.commit);
            const existing = existingByTag.get(release.tag);
            const pairKey = `${release.tag}\0${context.commit}`;
            if (existing?.commit === context.commit || pendingPairs.has(pairKey)) continue;
            if (snapshotsBuilt >= MAX_TREE_SNAPSHOTS_PER_ROUND) {
                snapshotBudgetExhausted = true;
                continue;
            }
            const retag = Boolean(existing && existing.commit !== context.commit);
            try {
                snapshotsBuilt += 1;
                await reportProgress('running', `构建快照 ${release.tag}`, `逐文件拉取 commit ${context.commit.slice(0, 12)}`);
                const version = await buildVersionSnapshot(
                    fetchImpl,
                    env,
                    bucket,
                    repo,
                    release,
                    context.commit,
                    announcementSources
                );
                version.publishedAt = nowValue(now);
                existingByTag.set(release.tag, version);
                removePending(manifest, release.tag, context.commit);
                changed = true;
                events.push({
                    event: retag ? 'retag_republished' : 'version_published',
                    tag: release.tag,
                    commit: context.commit,
                    detail: retag ? `retag ${existing.commit} -> ${context.commit}` : release.name,
                    at: version.publishedAt
                });
            } catch (error) {
                if (!(error instanceof RpHubAppPatchError) && !(error instanceof ReleaseIncompleteError)) throw error;
                const reason = error instanceof RpHubAppPatchError ? 'patch-rejected' : 'release-incomplete';
                const seenAt = nowValue(now);
                const pending = {
                    tag: release.tag,
                    commit: context.commit,
                    reason,
                    detail: toErrorMessage(error),
                    seenAt
                };
                addPending(manifest, pending);
                pendingPairs.add(pairKey);
                changed = true;
                events.push({
                    event: retag ? 'retag_precheck_failed' : 'precheck_failed',
                    tag: release.tag,
                    commit: context.commit,
                    detail: pending.detail,
                    at: seenAt
                });
            }
        }

        let latestArtifact = null;
        try {
            await reportProgress('running', '检查 artifact', '拉取 github-pages artifact 列表');
            latestArtifact = await fetchLatestArtifact(fetchImpl, env, repo);
        } catch (error) {
            console.error(JSON.stringify({
                message: 'mirror artifact list unavailable; release pipeline continued',
                error: safeErrorMessage(error, env)
            }));
        }
        if (latestArtifact) {
            try {
                artifactCommit = artifactHeadSha(latestArtifact.artifact);
                const knownCommit = [...manifest.versions, ...manifest.pending]
                    .some((entry) => entry?.commit === artifactCommit);
                const releaseForCommit = releases.find((release) => releaseCommits.get(release.tag) === artifactCommit);
                if (releaseForCommit) {
                    const officialVersion = existingByTag.get(releaseForCommit.tag);
                    // Latest main build equals a published release: every derived
                    // preview entry is stale, not just the same-commit one — a
                    // lingering derived entry would keep outranking the release
                    // at versions[0], the client's default update target.
                    for (const [tag, version] of existingByTag.entries()) {
                        if (officialVersion?.commit === artifactCommit
                            && !officialTags.has(tag)
                            && (version?.commit === artifactCommit || isDerivedTag(tag))) {
                            existingByTag.delete(tag);
                            changed = true;
                        }
                    }
                    if (officialVersion?.commit === artifactCommit) {
                        const beforePending = manifest.pending.length;
                        manifest.pending = manifest.pending.filter((pending) => (
                            pending?.commit !== artifactCommit || officialTags.has(pending?.tag)
                        ));
                        if (manifest.pending.length !== beforePending) changed = true;
                    }
                } else if (!knownCommit) {
                    const baseRelease = releases[0]?.tag || '0.0.0';
                    artifactTag = deriveArtifactTag(
                        baseRelease,
                        latestArtifact.artifact.created_at,
                        artifactCommit,
                        manifest,
                        releases
                    );
                    context.tag = artifactTag;
                    context.commit = artifactCommit;
                    const derivedExisting = existingByTag.get(artifactTag);
                    const derivedPair = `${artifactTag}\0${artifactCommit}`;
                    if (!derivedExisting && !pendingPairs.has(derivedPair)) {
                        const artifactRelease = {
                            tag: artifactTag,
                            name: `github-pages artifact ${artifactTag}`,
                            date: typeof latestArtifact.artifact.created_at === 'string'
                                ? latestArtifact.artifact.created_at
                                : ''
                        };
                        let version;
                        let detail = 'artifact direct intake';
                        try {
                            let files;
                            try {
                                await reportProgress('running', `下载 artifact ${artifactTag}`, `commit ${artifactCommit.slice(0, 12)}`);
                                const zipBytes = await downloadArtifact(fetchImpl, env, latestArtifact.artifact);
                                files = parseArtifactTar(await extractArtifactTar(zipBytes));
                            } catch (error) {
                                if (!(error instanceof ArtifactUnavailableError)) throw error;
                                if (snapshotsBuilt >= MAX_TREE_SNAPSHOTS_PER_ROUND) {
                                    snapshotBudgetExhausted = true;
                                } else {
                                    detail = 'artifact unavailable; commit tree fallback';
                                    if ([401, 403, 410].includes(error.status)) {
                                        artifactFallbackWarning = new ArtifactUnavailableError(
                                            `artifact unavailable; commit tree fallback: ${toErrorMessage(error)}`,
                                            error.status
                                        );
                                    }
                                    snapshotsBuilt += 1;
                                    version = await buildVersionSnapshot(
                                        fetchImpl,
                                        env,
                                        bucket,
                                        repo,
                                        artifactRelease,
                                        artifactCommit,
                                        announcementSources
                                    );
                                }
                            }
                            if (version || files) {
                            if (!version) {
                                version = await buildVersionSnapshotFromFiles(
                                    bucket,
                                    artifactRelease,
                                    artifactCommit,
                                    files,
                                    announcementSources
                                );
                            }
                            version.publishedAt = nowValue(now);
                            for (const [tag, previous] of existingByTag.entries()) {
                                if (!officialTags.has(tag) && isDerivedTag(tag) && previous?.commit !== artifactCommit) {
                                    existingByTag.delete(tag);
                                    changed = true;
                                }
                            }
                            const beforeDerivedPending = manifest.pending.length;
                            manifest.pending = manifest.pending.filter((pending) => (
                                officialTags.has(pending?.tag)
                                || !isDerivedTag(pending?.tag)
                                || pending?.commit === artifactCommit
                            ));
                            if (manifest.pending.length !== beforeDerivedPending) changed = true;
                            existingByTag.set(artifactTag, version);
                            removePending(manifest, artifactTag, artifactCommit);
                            changed = true;
                            events.push({
                                event: 'version_published',
                                tag: artifactTag,
                                commit: artifactCommit,
                                detail,
                                at: version.publishedAt
                            });
                            }
                            } catch (error) {
                                if (error instanceof ArtifactParseError) {
                                    artifactSyncError = error;
                            } else if (error instanceof RpHubAppPatchError || error instanceof ReleaseIncompleteError) {
                                const seenAt = nowValue(now);
                                const pending = {
                                    tag: artifactTag,
                                    commit: artifactCommit,
                                    reason: error instanceof RpHubAppPatchError ? 'patch-rejected' : 'release-incomplete',
                                    detail: `${detail}: ${toErrorMessage(error)}`,
                                    seenAt
                                };
                                addPending(manifest, pending);
                                pendingPairs.add(derivedPair);
                                changed = true;
                                events.push({
                                    event: 'precheck_failed',
                                    tag: artifactTag,
                                    commit: artifactCommit,
                                    detail: pending.detail,
                                    at: seenAt
                                });
                            } else {
                                throw error;
                            }
                        }
                    }
                }
            } catch (error) {
                if (error instanceof ArtifactParseError) artifactSyncError = error;
                else throw error;
            }
        }

        const orderedVersions = [];
        const derivedVersions = [...existingByTag.values()]
            .filter((version) => version && !officialTags.has(version.tag) && isDerivedTag(version.tag))
            .sort((left, right) => Number(right.publishedAt || 0) - Number(left.publishedAt || 0))
            .slice(0, 1);
        // A derived preview only outranks releases while it is at least as
        // fresh as the newest release build; when the artifact check could
        // not run (list unavailable) a stale one must still not sit at
        // versions[0], the client's default update target.
        const newestReleaseVersion = releases.length ? existingByTag.get(releases[0].tag) : null;
        const newestReleasePublishedAt = Number(newestReleaseVersion?.publishedAt || 0);
        const freshDerived = derivedVersions
            .filter((version) => Number(version.publishedAt || 0) >= newestReleasePublishedAt);
        const staleDerived = derivedVersions
            .filter((version) => Number(version.publishedAt || 0) < newestReleasePublishedAt);
        for (const version of freshDerived) orderedVersions.push(version);
        for (const release of releases) {
            const version = existingByTag.get(release.tag);
            if (version) orderedVersions.push(version);
        }
        for (const version of staleDerived) orderedVersions.push(version);
        if (JSON.stringify(manifest.versions) !== JSON.stringify(orderedVersions)) changed = true;
        const derivedCount = derivedVersions.length;
        manifest.versions = orderedVersions.slice(0, releaseLimit + derivedCount);

        if (changed || (!manifestState.object && !artifactSyncError)) {
            manifest.updatedAt = nowValue(now);
            const stored = await bucket.put(
                MANIFEST_KEY,
                JSON.stringify(manifest, null, 2),
                manifestPutOptions(manifestState.object)
            );
            if (!stored) throw new ManifestConflictError();
        }
        // Announcements are regenerated wholesale on every sync; any failure
        // here is logged and swallowed so the sidecar can never break syncing.
        try {
            await regenerateAnnouncements(bucket, manifest, announcementSources, nowValue(now));
        } catch (announcementError) {
            console.error(JSON.stringify({
                message: 'mirror announcements regeneration failed',
                error: safeErrorMessage(announcementError, env)
            }));
        }
        let artifactErrorNotified = false;
        if (artifactSyncError) {
            artifactErrorNotified = await reportSyncError(
                fetchImpl,
                env,
                bucket,
                { tag: artifactTag || context.tag, commit: artifactCommit || context.commit },
                artifactSyncError,
                nowValue(now),
                runtimeConfig.webhookEnabled
            );
        } else if (artifactFallbackWarning) {
            artifactErrorNotified = await reportSyncError(
                fetchImpl,
                env,
                bucket,
                { tag: artifactTag || context.tag, commit: artifactCommit || context.commit },
                artifactFallbackWarning,
                nowValue(now),
                runtimeConfig.webhookEnabled
            );
        } else {
            await clearSyncErrorState(bucket, env);
        }
        for (const event of events) await sendWebhook(fetchImpl, env, event, runtimeConfig.webhookEnabled);
        const snapshotBudget = {
            used: snapshotsBuilt,
            limit: MAX_TREE_SNAPSHOTS_PER_ROUND,
            deferred: snapshotBudgetExhausted
        };
        await reportProgress(
            artifactSyncError ? 'error' : 'done',
            artifactSyncError ? '同步失败' : (snapshotBudgetExhausted ? '本轮完成，仍有版本待回填' : '同步完成'),
            `已发布 ${manifest.versions.length} 个版本`
        );
        if (artifactSyncError) {
            return {
                ok: false,
                changed,
                versionCount: manifest.versions.length,
                pendingCount: manifest.pending.length,
                events: events.map((event) => event.event),
                snapshotBudget,
                error: safeErrorMessage(artifactSyncError, env),
                notified: artifactErrorNotified
            };
        }
        return {
            ok: true,
            changed,
            versionCount: manifest.versions.length,
            pendingCount: manifest.pending.length,
            events: events.map((event) => event.event),
            snapshotBudget
        };
    } catch (error) {
        const at = nowValue(now);
        const notified = await reportSyncError(
            fetchImpl,
            env,
            bucket,
            context,
            error,
            at,
            runtimeConfig.webhookEnabled
        );
        const safeError = safeErrorMessage(error, env);
        await reportProgress('error', context.tag ? `同步失败于 ${context.tag}` : '同步失败', safeError);
        console.error(JSON.stringify({
            message: 'mirror sync failed',
            tag: redactText(context.tag, env),
            commit: redactText(context.commit, env),
            error: safeError,
            notified
        }));
        return { ok: false, error: safeError, notified };
    }
}

function effectiveRepo(env) {
    return typeof env?.UPSTREAM_REPO === 'string' && env.UPSTREAM_REPO.trim()
        ? env.UPSTREAM_REPO.trim()
        : DEFAULT_UPSTREAM_REPO;
}

function statusString(value, env, maxLength = 1000) {
    return redactText(typeof value === 'string' ? value : String(value ?? ''), env).slice(0, maxLength);
}

function statusManifest(value, env) {
    if (!plainObject(value) || !Array.isArray(value.versions) || !Array.isArray(value.pending)) {
        return { updatedAt: 0, versions: [], pending: [], valid: value === null };
    }
    return {
        updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
        versions: value.versions.map((version) => ({
            tag: statusString(version?.tag, env, 120),
            commit: statusString(version?.commit, env, 80),
            publishedAt: Number.isFinite(Number(version?.publishedAt)) ? Number(version.publishedAt) : 0,
            fileCount: Array.isArray(version?.files) ? version.files.length : 0
        })),
        pending: value.pending.map((pending) => ({
            tag: statusString(pending?.tag, env, 120),
            commit: statusString(pending?.commit, env, 80),
            reason: statusString(pending?.reason, env, 120),
            detail: statusString(pending?.detail, env),
            seenAt: Number.isFinite(Number(pending?.seenAt)) ? Number(pending.seenAt) : 0
        })),
        valid: true
    };
}

function publicManifest(value, env) {
    if (!plainObject(value) || !Array.isArray(value.versions) || !Array.isArray(value.pending)) {
        return { updatedAt: 0, versions: [], pending: [], valid: value === null };
    }
    return {
        updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
        versions: value.versions.map((version) => ({
            tag: statusString(version?.tag, env, 120),
            commit: statusString(version?.commit, env, 80),
            date: statusString(version?.date, env, 120),
            publishedAt: Number.isFinite(Number(version?.publishedAt)) ? Number(version.publishedAt) : 0,
            fileCount: Array.isArray(version?.files) ? version.files.length : 0
        })),
        pending: value.pending.map((pending) => ({
            tag: statusString(pending?.tag, env, 120),
            commit: statusString(pending?.commit, env, 80),
            reason: statusString(pending?.reason, env, 120),
            seenAt: Number.isFinite(Number(pending?.seenAt)) ? Number(pending.seenAt) : 0
        })),
        valid: true
    };
}

async function buildStatus(env) {
    const bucket = env?.MIRROR_BUCKET;
    if (!bucket) throw new Error('缺少 MIRROR_BUCKET R2 binding。');
    let manifestValue = null;
    let syncError = null;
    try {
        manifestValue = (await readJsonObject(bucket, MANIFEST_KEY)).value;
    } catch {
        manifestValue = undefined;
    }
    try {
        const value = (await readJsonObject(bucket, SYNC_ERROR_STATE_KEY)).value;
        if (value !== null) {
            syncError = plainObject(value) ? {
                fingerprint: statusString(value.fingerprint, env, 128),
                at: Number.isFinite(Number(value.at)) ? Number(value.at) : 0,
                tag: statusString(value.tag, env, 120),
                commit: statusString(value.commit, env, 80),
                detail: statusString(value.detail, env, 1000),
                valid: true
            } : { fingerprint: '', at: 0, tag: '', commit: '', detail: '', valid: false };
        }
    } catch {
        syncError = { fingerprint: '', at: 0, tag: '', commit: '', detail: '', valid: false };
    }
    let syncProgress = null;
    try {
        const value = (await readJsonObject(bucket, SYNC_PROGRESS_KEY)).value;
        if (plainObject(value)) {
            syncProgress = {
                state: ['running', 'done', 'error'].includes(value.state) ? value.state : 'unknown',
                step: Number.isFinite(Number(value.step)) ? Number(value.step) : 0,
                phase: statusString(value.phase, env, 200),
                detail: statusString(value.detail, env, 500),
                startedAt: Number.isFinite(Number(value.startedAt)) ? Number(value.startedAt) : 0,
                at: Number.isFinite(Number(value.at)) ? Number(value.at) : 0
            };
        }
    } catch {
        syncProgress = null;
    }
    const configState = await readRuntimeConfigState(bucket, env);
    return {
        ok: true,
        manifest: statusManifest(manifestValue, env),
        syncError,
        syncProgress,
        config: {
            releaseLimit: configState.config.releaseLimit,
            webhookEnabled: configState.config.webhookEnabled,
            upstreamRepo: statusString(effectiveRepo(env), env, 300)
        },
        secrets: {
            github: configuredSecret(env, 'GITHUB_TOKEN'),
            webhook: configuredSecret(env, 'WEBHOOK_URL'),
            webhookAuth: configuredSecret(env, 'WEBHOOK_TOKEN'),
            admin: configuredSecret(env, 'ADMIN_TOKEN')
        },
        RP_HUB_APP_PATCH_REVISION
    };
}

async function buildPublicStatus(env) {
    const bucket = env?.MIRROR_BUCKET;
    if (!bucket) throw new Error('缺少 MIRROR_BUCKET R2 binding。');
    let manifestValue = null;
    try {
        manifestValue = (await readJsonObject(bucket, MANIFEST_KEY)).value;
    } catch {
        manifestValue = undefined;
    }
    return {
        manifest: publicManifest(manifestValue, env),
        upstreamRepo: statusString(effectiveRepo(env), env, 300)
    };
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function formatStatusTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '尚无记录';
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date(timestamp));
    const valueOf = (type) => parts.find((part) => part.type === type)?.value || '';
    return `${valueOf('year')}-${valueOf('month')}-${valueOf('day')} ${valueOf('hour')}:${valueOf('minute')}:${valueOf('second')} (UTC+8)`;
}

function versionRows(versions) {
    if (!versions.length) return '<tr><td colspan="5" class="empty">尚无已发布版本</td></tr>';
    return versions.map((version) => `<tr>
        <td>${escapeHtml(version.tag)}</td>
        <td><code>${escapeHtml(version.commit)}</code></td>
        <td>${escapeHtml(formatStatusTime(version.publishedAt))}</td>
        <td>${Number(version.fileCount) || 0}</td>
        <td><button class="secondary show-announcement" data-tag="${escapeHtml(version.tag)}">公告</button> <button class="secondary delete-version" data-tag="${escapeHtml(version.tag)}" data-commit="${escapeHtml(version.commit)}">删除</button></td>
    </tr>`).join('');
}

function pendingRows(pending) {
    if (!pending.length) return '<tr><td colspan="6" class="empty">当前没有 pending</td></tr>';
    return pending.map((item) => `<tr>
        <td>${escapeHtml(item.tag)}</td>
        <td><code>${escapeHtml(item.commit)}</code></td>
        <td>${escapeHtml(item.reason)}</td>
        <td class="detail">${escapeHtml(item.detail)}</td>
        <td>${escapeHtml(formatStatusTime(item.seenAt))}</td>
        <td><button class="secondary retry" data-tag="${escapeHtml(item.tag)}" data-commit="${escapeHtml(item.commit)}">重试</button></td>
    </tr>`).join('');
}

function configuredLabel(value) {
    return value ? '<span class="configured">已配置</span>' : '<span class="missing">未配置</span>';
}

function renderConsoleHtml(status) {
    const manifestState = status.manifest.valid ? '正常' : '格式无效';
    const syncErrorText = status.syncError
        ? `${status.syncError.valid ? '存在同步错误' : '错误状态格式无效'} · ${formatStatusTime(status.syncError.at)}`
        : '无同步错误';
    const syncErrorDetail = status.syncError?.detail
        ? `${status.syncError.tag ? `[${status.syncError.tag}] ` : ''}${status.syncError.detail}`
        : '';
    const progressText = status.syncProgress
        ? `${status.syncProgress.state === 'running' ? '进行中' : (status.syncProgress.state === 'done' ? '已完成' : '出错')} · 第 ${status.syncProgress.step} 步：${status.syncProgress.phase}${status.syncProgress.detail ? ` — ${status.syncProgress.detail}` : ''} · ${formatStatusTime(status.syncProgress.at)}`
        : '尚未同步过';
    return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>RP-Hub 镜像发布端</title>
<style>
:root{color-scheme:light;--bg:#f4f6f8;--panel:#fff;--line:#d8dde3;--text:#17202a;--muted:#66717d;--accent:#146c43;--danger:#b42318;--button:#1f2937;--buttonText:#fff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0}header{background:#fff;border-bottom:1px solid var(--line)}.wrap{width:min(1180px,calc(100% - 32px));margin:auto}.top{min-height:68px;display:flex;align-items:center;justify-content:space-between;gap:16px}h1{font-size:20px;margin:0}h2{font-size:16px;margin:0 0 14px}.stamp{color:var(--muted);font-size:12px}main{padding:22px 0 40px}.band{padding:20px 0;border-bottom:1px solid var(--line)}.band:last-child{border-bottom:0}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric{min-height:78px;padding:12px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}.metric b{display:block;font-size:18px;margin-top:4px;overflow-wrap:anywhere}.label{color:var(--muted);font-size:12px}.grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:20px}.controls{display:grid;gap:14px}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}label{font-weight:600}input[type=password],input[type=number]{height:38px;border:1px solid #aeb6bf;border-radius:5px;background:var(--panel);color:var(--text);padding:0 10px}input[type=password]{width:min(360px,100%)}input[type=number]{width:84px}button{height:38px;border:1px solid var(--button);border-radius:5px;background:var(--button);color:var(--buttonText);padding:0 14px;font-weight:650;cursor:pointer}button.secondary{background:var(--panel);color:var(--text);border-color:#98a2ad}button:disabled{cursor:wait;opacity:.55}.secret-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.secret{display:flex;justify-content:space-between;gap:12px;padding:9px 10px;border:1px solid var(--line);border-radius:5px}.configured{color:var(--accent);font-weight:700}.missing{color:var(--danger);font-weight:700}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:6px;background:var(--panel)}table{width:100%;border-collapse:collapse;min-width:720px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{background:#eef1f4;color:#3d4854;font-size:12px}tr:last-child td{border-bottom:0}code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.detail{max-width:420px;white-space:normal}.empty{text-align:center;color:var(--muted);padding:24px}.notice{min-height:42px;margin-bottom:14px;padding:10px 12px;border-left:4px solid #6b7280;background:#e9edf1;white-space:pre-wrap}.notice.ok{border-color:var(--accent);background:#e7f5ed}.notice.error{border-color:var(--danger);background:#fdeceb}.switch{display:inline-flex;align-items:center;gap:8px}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted)}@media(max-width:800px){.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:1fr}.secret-grid{grid-template-columns:1fr}.wrap{width:min(100% - 20px,1180px)}}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111417;--panel:#191d21;--line:#343b43;--text:#eef1f4;--muted:#a6afb9;--button:#eef1f4;--buttonText:#111417}header{background:#191d21}th{background:#252b31}.notice{background:#242a30}.notice.ok{background:#153225}.notice.error{background:#3a1e1c}input[type=password],input[type=number]{border-color:#59636e}}
</style>
</head>
<body>
<header><div class="wrap top"><h1>RP-Hub 镜像发布端</h1><span id="pageStamp" class="stamp">${escapeHtml(formatStatusTime(Date.now()))}</span></div></header>
<main class="wrap">
<div id="notice" class="notice">就绪</div>
<section class="band"><div class="summary">
<div class="metric"><span class="label">Manifest</span><b id="manifestState">${escapeHtml(manifestState)}</b></div>
<div class="metric"><span class="label">最后更新</span><b id="updatedAt">${escapeHtml(formatStatusTime(status.manifest.updatedAt))}</b></div>
<div class="metric"><span class="label">已发布 / Pending</span><b id="counts">${status.manifest.versions.length} / ${status.manifest.pending.length}</b></div>
<div class="metric"><span class="label">同步错误</span><b id="syncError">${escapeHtml(syncErrorText)}</b></div>
</div>
<div id="syncProgress" class="notice" style="margin-top:12px">同步进度：${escapeHtml(progressText)}</div>
<div id="syncErrorDetail" class="notice error" style="margin-top:12px${syncErrorDetail ? '' : ';display:none'}">${escapeHtml(syncErrorDetail)}</div></section>
<section class="band grid">
<div class="controls">
<div><h2>管理员令牌</h2><div class="row"><input id="adminToken" type="password" autocomplete="off" aria-label="管理员令牌"><button id="saveToken" class="secondary">保存令牌</button></div></div>
<div><h2>运行时配置</h2><form id="configForm" class="row"><label for="releaseLimit">Release 数量</label><input id="releaseLimit" type="number" min="1" max="12" step="1" value="${status.config.releaseLimit}"><label class="switch"><input id="webhookEnabled" type="checkbox"${status.config.webhookEnabled ? ' checked' : ''}>Webhook</label><button type="submit">保存配置</button></form></div>
<div><h2>操作</h2><div class="row"><button id="syncNow">立即同步</button><button id="webhookTest" class="secondary">测试 Webhook</button><button id="refresh" class="secondary">刷新状态</button></div></div>
</div>
<div><h2>环境</h2><div class="secret-grid">
<div class="secret"><span>GitHub</span><span id="secretGithub">${configuredLabel(status.secrets.github)}</span></div>
<div class="secret"><span>Webhook</span><span id="secretWebhook">${configuredLabel(status.secrets.webhook)}</span></div>
<div class="secret"><span>Webhook 鉴权</span><span id="secretWebhookAuth">${configuredLabel(status.secrets.webhookAuth)}</span></div>
<div class="secret"><span>管理员</span><span id="secretAdmin">${configuredLabel(status.secrets.admin)}</span></div>
</div><p class="stamp">上游：<span id="upstreamRepo">${escapeHtml(status.config.upstreamRepo)}</span><br>预检修订：<code id="patchRevision">${escapeHtml(status.RP_HUB_APP_PATCH_REVISION)}</code></p></div>
</section>
<section class="band"><h2>已发布版本</h2><div class="table-wrap"><table><thead><tr><th>Tag</th><th>Commit</th><th>发布时间</th><th>文件数</th><th>操作</th></tr></thead><tbody id="versionsBody">${versionRows(status.manifest.versions)}</tbody></table></div><div id="announcementPanel" class="notice" style="display:none;margin-top:12px"></div></section>
<section class="band"><h2>Pending</h2><div class="table-wrap"><table><thead><tr><th>Tag</th><th>Commit</th><th>原因</th><th>详情</th><th>发现时间</th><th>操作</th></tr></thead><tbody id="pendingBody">${pendingRows(status.manifest.pending)}</tbody></table></div></section>
</main>
<script>
const byId=(id)=>document.getElementById(id);const esc=(value)=>String(value??'').replace(/[&<>"']/g,(character)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));const time=(value)=>{if(!(Number(value)>0))return '尚无记录';const parts=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(Number(value)));const get=(type)=>parts.find((part)=>part.type===type)?.value||'';return get('year')+'-'+get('month')+'-'+get('day')+' '+get('hour')+':'+get('minute')+':'+get('second')+' (UTC+8)'};const configured=(value)=>value?'<span class="configured">已配置</span>':'<span class="missing">未配置</span>';const notice=(message,type='')=>{byId('notice').textContent=message;byId('notice').className='notice '+type};const storedToken=()=>localStorage.getItem('mirrorAdminToken')||'';byId('adminToken').value=storedToken();
async function api(path,options={}){const headers=new Headers(options.headers||{});const token=storedToken();if(token)headers.set('authorization','Bearer '+token);if(options.body)headers.set('content-type','application/json');const response=await fetch(path,{...options,headers});let value;try{value=await response.json()}catch{value={ok:false,error:'响应不是有效 JSON。'}}if(!response.ok)throw new Error(value.error||('HTTP '+response.status));return value}
function bindRetry(){document.querySelectorAll('.retry').forEach((button)=>button.addEventListener('click',async()=>{button.disabled=true;notice('正在重试 '+button.dataset.tag+'…');try{const result=await api('/api/pending/retry',{method:'POST',body:JSON.stringify({tag:button.dataset.tag,commit:button.dataset.commit})});notice(result.sync?.ok?'重试完成。':'重试已执行，同步仍有错误。',result.sync?.ok?'ok':'error');await refresh()}catch(error){notice(error.message,'error')}finally{button.disabled=false}}))}
function bindDelete(){document.querySelectorAll('.delete-version').forEach((button)=>button.addEventListener('click',async()=>{if(!confirm('确认删除版本 '+button.dataset.tag+'？其快照文件将一并清理；若它仍是上游现行 Release，下次同步会重新上架。'))return;button.disabled=true;notice('正在删除 '+button.dataset.tag+'…');try{const result=await api('/api/versions/delete',{method:'POST',body:JSON.stringify({tag:button.dataset.tag,commit:button.dataset.commit})});notice('已删除 '+button.dataset.tag+'（清理快照 '+(result.snapshotsDeleted||0)+' 个）。','ok');await refresh()}catch(error){notice(error.message,'error');button.disabled=false}}))}
function bindAnnouncements(){document.querySelectorAll('.show-announcement').forEach((button)=>button.addEventListener('click',async()=>{button.disabled=true;const panel=byId('announcementPanel');panel.textContent='公告加载中…';panel.style.display='';try{const response=await fetch('/announcements.json?tag='+encodeURIComponent(button.dataset.tag));let value=null;try{value=await response.json()}catch{value=null}panel.textContent='';const head=document.createElement('b');head.textContent='公告 · '+button.dataset.tag;panel.appendChild(head);panel.appendChild(document.createElement('br'));if(!response.ok||!value){panel.appendChild(document.createTextNode(response.status===404?'公告索引尚未生成，请先在管理端点一次「立即同步」。':'公告加载失败：HTTP '+response.status))}else{const entry=(Array.isArray(value.entries)?value.entries:[]).find((item)=>item&&item.tag===button.dataset.tag)||null;if(!entry||!entry.announcement){panel.appendChild(document.createTextNode('该版本暂无公告'+(entry&&entry.reason?'（'+entry.reason+'）。':'。')))}else{const info=document.createElement('span');info.textContent='[ID '+entry.announcement.id+'] '+entry.announcement.title;panel.appendChild(info);panel.appendChild(document.createElement('br'));const pre=document.createElement('pre');pre.textContent=entry.announcement.content;panel.appendChild(pre)}}}catch(error){panel.textContent='公告加载失败：'+error.message;panel.style.display=''}finally{button.disabled=false}}))}
function render(status){byId('pageStamp').textContent=time(Date.now());byId('manifestState').textContent=status.manifest.valid?'正常':'格式无效';byId('updatedAt').textContent=time(status.manifest.updatedAt);byId('counts').textContent=status.manifest.versions.length+' / '+status.manifest.pending.length;byId('syncError').textContent=status.syncError?((status.syncError.valid?'存在同步错误':'错误状态格式无效')+' · '+time(status.syncError.at)):'无同步错误';const detailBox=byId('syncErrorDetail');const detailText=status.syncError&&status.syncError.detail?((status.syncError.tag?'['+status.syncError.tag+'] ':'')+status.syncError.detail):'';detailBox.textContent=detailText;detailBox.style.display=detailText?'':'none';const progress=status.syncProgress;const progressBox=byId('syncProgress');progressBox.textContent='同步进度：'+(progress?((progress.state==='running'?'进行中':(progress.state==='done'?'已完成':'出错'))+' · 第 '+progress.step+' 步：'+progress.phase+(progress.detail?' — '+progress.detail:'')+' · '+time(progress.at)):'尚未同步过');progressBox.className='notice '+(progress?(progress.state==='running'?'':(progress.state==='done'?'ok':'error')):'');byId('releaseLimit').value=status.config.releaseLimit;byId('webhookEnabled').checked=status.config.webhookEnabled;byId('upstreamRepo').textContent=status.config.upstreamRepo;byId('patchRevision').textContent=status.RP_HUB_APP_PATCH_REVISION;byId('secretGithub').innerHTML=configured(status.secrets.github);byId('secretWebhook').innerHTML=configured(status.secrets.webhook);byId('secretWebhookAuth').innerHTML=configured(status.secrets.webhookAuth);byId('secretAdmin').innerHTML=configured(status.secrets.admin);byId('versionsBody').innerHTML=status.manifest.versions.length?status.manifest.versions.map((item)=>'<tr><td>'+esc(item.tag)+'</td><td><code>'+esc(item.commit)+'</code></td><td>'+esc(time(item.publishedAt))+'</td><td>'+Number(item.fileCount||0)+'</td><td><button class="secondary show-announcement" data-tag="'+esc(item.tag)+'">公告</button> <button class="secondary delete-version" data-tag="'+esc(item.tag)+'" data-commit="'+esc(item.commit)+'">删除</button></td></tr>').join(''):'<tr><td colspan="5" class="empty">尚无已发布版本</td></tr>';byId('pendingBody').innerHTML=status.manifest.pending.length?status.manifest.pending.map((item)=>'<tr><td>'+esc(item.tag)+'</td><td><code>'+esc(item.commit)+'</code></td><td>'+esc(item.reason)+'</td><td class="detail">'+esc(item.detail)+'</td><td>'+esc(time(item.seenAt))+'</td><td><button class="secondary retry" data-tag="'+esc(item.tag)+'" data-commit="'+esc(item.commit)+'">重试</button></td></tr>').join(''):'<tr><td colspan="6" class="empty">当前没有 pending</td></tr>';bindRetry();bindDelete();byId('announcementPanel').style.display='none';bindAnnouncements()}
let progressTimer=null;function startProgressPolling(){if(progressTimer)return;progressTimer=setInterval(async()=>{try{const status=await api('/api/status');render(status);if(!status.syncProgress||status.syncProgress.state!=='running'){clearInterval(progressTimer);progressTimer=null}}catch{}},2000)}
function syncSummary(result){const parts=[];const published=(result.events||[]).filter((event)=>event==='version_published'||event==='retag_republished').length;const failed=(result.events||[]).filter((event)=>event.indexOf('precheck_failed')>=0).length;if(published)parts.push('本轮上架 '+published+' 个版本');if(failed)parts.push(failed+' 个预检失败转 pending');if(!published&&!failed)parts.push(result.changed?'状态已更新':'无新版本');parts.push('累计已发布 '+result.versionCount+' 个');if(result.snapshotBudget&&result.snapshotBudget.deferred)parts.push('还有版本待回填，请再点一次「立即同步」');return parts.join('；')+'。'}
async function refresh(){try{render(await api('/api/status'));notice('状态已刷新。','ok')}catch(error){notice(error.message,'error')}}
byId('saveToken').addEventListener('click',()=>{localStorage.setItem('mirrorAdminToken',byId('adminToken').value.trim());notice('管理员令牌已保存到此浏览器。','ok')});byId('refresh').addEventListener('click',refresh);byId('syncNow').addEventListener('click',async(event)=>{event.currentTarget.disabled=true;notice('正在同步…（下方进度条每 2 秒自动刷新）');startProgressPolling();try{const result=await api('/api/sync',{method:'POST'});notice(result.ok?'同步完成：'+syncSummary(result):'同步失败：'+(result.error||'未知错误'),result.ok?'ok':'error');await refresh()}catch(error){notice('同步失败：'+error.message,'error')}finally{event.currentTarget.disabled=false}});byId('webhookTest').addEventListener('click',async(event)=>{event.currentTarget.disabled=true;notice('正在测试 Webhook…');try{const result=await api('/api/webhook-test',{method:'POST'});notice(result.sent?'Webhook 已发送。':(result.disabled?'Webhook 已禁用。':'Webhook 未发送。'),result.sent?'ok':'error')}catch(error){notice(error.message,'error')}finally{event.currentTarget.disabled=false}});byId('configForm').addEventListener('submit',async(event)=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const config=await api('/api/config',{method:'PUT',body:JSON.stringify({releaseLimit:Number(byId('releaseLimit').value),webhookEnabled:byId('webhookEnabled').checked})});notice('配置已保存。','ok');byId('releaseLimit').value=config.config.releaseLimit}catch(error){notice(error.message,'error')}finally{button.disabled=false}});bindRetry();bindDelete();bindAnnouncements();
</script>
</body>
</html>`;
}

function publicPendingReason(reason) {
    if (reason === 'patch-rejected') return '适配未通过，等待维护';
    if (reason === 'release-incomplete') return '上游发布内容不完整';
    return '暂不可用';
}

function publicDate(value) {
    const text = String(value || '').trim();
    return text || '未知';
}

async function publicAnnouncement(env, url) {
    const tag = url.searchParams.get('tag');
    if (tag === null) return '';
    let body;
    try {
        const response = await serveAnnouncements(env, url);
        const value = await response.json();
        if (!response.ok) throw new Error('unavailable');
        const entry = value.entries?.find((item) => item?.tag === tag);
        body = entry?.announcement
            ? `<h3>${escapeHtml(entry.announcement.title)}</h3><pre>${escapeHtml(entry.announcement.content)}</pre>`
            : '<p>该版本暂无公告。</p>';
    } catch {
        body = `<p>公告暂时无法读取，请稍后重试。</p><form method="get" action="/"><input type="hidden" name="tag" value="${escapeHtml(tag)}"><button type="submit">重试</button></form>`;
    }
    return `<section id="announcement" class="band" aria-labelledby="announcement-title"><h2 id="announcement-title">公告 · ${escapeHtml(tag)}</h2>${body}<a href="/">返回版本列表</a></section>`;
}

function renderPublicHtml(status, announcement = '') {
    const versions = status.manifest.versions.length
        ? status.manifest.versions.map((version) => `<tr>
        <td>${escapeHtml(version.tag)}<br><a class="announcement-link" href="/?tag=${encodeURIComponent(version.tag)}#announcement">查看公告</a></td>
        <td><code>${escapeHtml(String(version.commit).slice(0, 12))}</code></td>
        <td>${escapeHtml(publicDate(version.date))}</td>
        <td>${escapeHtml(formatStatusTime(version.publishedAt))}</td>
        <td>${Number(version.fileCount) || 0}</td>
    </tr>`).join('')
        : '<tr><td colspan="5" class="empty">暂无可更新版本</td></tr>';
    const pending = status.manifest.pending.length
        ? status.manifest.pending.map((item) => `<tr>
        <td>${escapeHtml(item.tag)}</td>
        <td><code>${escapeHtml(String(item.commit).slice(0, 12))}</code></td>
        <td>${escapeHtml(publicPendingReason(item.reason))}</td>
        <td>${escapeHtml(formatStatusTime(item.seenAt))}</td>
    </tr>`).join('')
        : '<tr><td colspan="4" class="empty">无</td></tr>';
    return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>RP-Hub 镜像状态</title>
<style>
a{color:var(--accent)}.announcement-link{display:inline-block;white-space:nowrap;padding:3px 0}#announcement{scroll-margin-top:16px}#announcement pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:12px 0;line-height:1.8}#announcement h3{font-size:16px}#announcement button{font:inherit;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:5px 12px;cursor:pointer}
:root{color-scheme:light;--bg:#f4f6f8;--panel:#fff;--line:#d8dde3;--text:#17202a;--muted:#66717d;--accent:#146c43}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0}header{background:var(--panel);border-bottom:1px solid var(--line)}.wrap{width:min(1080px,calc(100% - 32px));margin:auto}.top{padding:26px 0 22px}h1{font-size:25px;margin:0 0 6px}h2{font-size:17px;margin:0 0 12px}.muted,.stamp{color:var(--muted)}main{padding:24px 0 42px}.meta{display:flex;flex-wrap:wrap;gap:8px 26px;padding:14px 0 20px;border-bottom:1px solid var(--line)}.meta span{overflow-wrap:anywhere}.band{padding:22px 0;border-bottom:1px solid var(--line)}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:6px;background:var(--panel)}table{width:100%;border-collapse:collapse;min-width:720px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{background:#eef1f4;color:#3d4854;font-size:12px}tr:last-child td{border-bottom:0}code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.empty{text-align:center;color:var(--muted);padding:24px}footer{padding-top:22px;color:var(--muted);font-size:12px}@media(max-width:800px){.wrap{width:min(100% - 20px,1080px)}h1{font-size:22px}}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111417;--panel:#191d21;--line:#343b43;--text:#eef1f4;--muted:#a6afb9;--accent:#78d9ac}th{background:#252b31;color:var(--muted)}}
</style>
</head>
<body>
<header><div class="wrap top"><h1>RP-Hub 镜像状态</h1><div>可更新版本信息</div></div></header>
<main class="wrap">
<div class="meta"><span>上游仓库：<b>${escapeHtml(status.upstreamRepo)}</b></span><span>页面生成时间：<b>${escapeHtml(formatStatusTime(Date.now()))}</b></span><span>清单更新时间：<b>${escapeHtml(formatStatusTime(status.manifest.updatedAt))}</b></span></div>
${announcement}
<section class="band"><h2>可更新版本</h2><p class="muted">点击“查看公告”可直接获取各版本公告，无需管理员口令。在站点更新页面点击“检测版本”即可获取最新清单。</p><div class="table-wrap"><table><thead><tr><th>Tag</th><th>Commit（前 12 位）</th><th>上游日期</th><th>上架时间</th><th>文件数</th></tr></thead><tbody>${versions}</tbody></table></div></section>
<section class="band"><h2>暂不可用版本</h2><div class="table-wrap"><table><thead><tr><th>Tag</th><th>Commit（前 12 位）</th><th>原因</th><th>发现时间</th></tr></thead><tbody>${pending}</tbody></table></div></section>
<footer>清单可直接访问：<code>/manifest.json</code></footer>
</main>
</body>
</html>`;
}

function snapshotObjectKey(pathname) {
    let decoded = pathname;
    try {
        for (let pass = 0; pass < 5; pass += 1) {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
        }
    } catch {
        return null;
    }
    if (!decoded.startsWith('/snapshots/')) return null;
    const key = decoded.slice(1);
    const segments = key.split('/');
    if (segments.length < 4 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        return null;
    }
    return key;
}

function isRawSnapshotTraversal(request) {
    const rawUrl = typeof request?.url === 'string' ? request.url : '';
    const rawPath = rawUrl.split(/[?#]/, 1)[0];
    return /\/snapshots\/(?:\.\.?|%2e?%2e?|%252e%252e)(?:\/|$)/i.test(rawPath);
}

async function serveManifest(env) {
    const object = await env.MIRROR_BUCKET.get(MANIFEST_KEY);
    if (!object) return jsonResponse({ ok: false, error: 'Not found.' }, { status: 404 });
    return new Response(object.body, {
        headers: {
            'cache-control': 'public, max-age=60',
            'content-type': 'application/json; charset=utf-8',
            'x-content-type-options': 'nosniff'
        }
    });
}

async function serveAnnouncements(env, url) {
    // Explicit single-point passthrough of the private _mirror/ sidecar; the
    // _mirror/ prefix itself stays unreachable from public routes.
    const object = await env.MIRROR_BUCKET.get(ANNOUNCEMENTS_KEY);
    if (!object) {
        return jsonResponse({ ok: false, error: '公告索引尚未生成，请先在管理端执行一次同步。' }, { status: 404 });
    }
    const filterTag = url.searchParams.get('tag');
    if (filterTag === null) {
        return new Response(object.body, {
            headers: {
                'cache-control': 'public, max-age=60',
                'content-type': 'application/json; charset=utf-8',
                'x-content-type-options': 'nosniff'
            }
        });
    }
    const value = JSON.parse(await object.text());
    const entries = plainObject(value) && Array.isArray(value.entries) ? value.entries : [];
    const generatedAt = plainObject(value) && Number.isFinite(Number(value.generatedAt))
        ? Number(value.generatedAt)
        : 0;
    return jsonResponse({ generatedAt, entries: entries.filter((entry) => entry?.tag === filterTag) });
}

async function serveSnapshot(pathname, env) {
    const key = snapshotObjectKey(pathname);
    if (!key) return jsonResponse({ ok: false, error: 'Not found.' }, { status: 404 });
    const object = await env.MIRROR_BUCKET.get(key);
    if (!object) return jsonResponse({ ok: false, error: 'Not found.' }, { status: 404 });
    const contentType = typeof object.httpMetadata?.contentType === 'string' && object.httpMetadata.contentType
        ? object.httpMetadata.contentType
        : 'application/octet-stream';
    return new Response(object.body, {
        headers: {
            'cache-control': 'public, max-age=86400, immutable',
            'content-type': contentType,
            'x-content-type-options': 'nosniff'
        }
    });
}

async function readJsonRequest(request, maxBytes = 16 * 1024) {
    if (!request.body) throw new Error('请求体不能为空。');
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new Error('请求体过大。');
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new Error('请求体不是有效 JSON。');
    }
}

async function retryPending(request, env, options) {
    const body = await readJsonRequest(request);
    const tag = typeof body?.tag === 'string' ? body.tag.trim() : '';
    const commit = typeof body?.commit === 'string' ? body.commit.trim().toLowerCase() : '';
    if (!tag || sanitizeReleaseTag(tag) !== tag || !/^[a-f0-9]{40}$/.test(commit)) {
        return jsonResponse({ ok: false, error: 'tag 或 commit 无效。' }, { status: 400 });
    }
    const bucket = env.MIRROR_BUCKET;
    const repo = effectiveRepo(env);
    const manifestState = await readJsonObject(bucket, MANIFEST_KEY);
    const manifest = validateStoredManifest(manifestState.value, repo);
    if (!manifest.pending.some((item) => item?.tag === tag && item?.commit === commit)) {
        return jsonResponse({ ok: false, error: '未找到指定 pending。' }, { status: 404 });
    }
    removePending(manifest, tag, commit);
    manifest.updatedAt = nowValue(options.now);
    const stored = await bucket.put(
        MANIFEST_KEY,
        JSON.stringify(manifest, null, 2),
        manifestPutOptions(manifestState.object)
    );
    if (!stored) return jsonResponse({ ok: false, error: 'Manifest 已被另一请求更新，请刷新后重试。' }, { status: 409 });
    const sync = await syncMirror(env, options);
    return jsonResponse({ ok: sync.ok, removed: true, sync });
}

async function deleteVersion(request, env, options) {
    const body = await readJsonRequest(request);
    const tag = typeof body?.tag === 'string' ? body.tag.trim() : '';
    const commit = typeof body?.commit === 'string' ? body.commit.trim().toLowerCase() : '';
    if (!tag || sanitizeReleaseTag(tag) !== tag || !/^[a-f0-9]{40}$/.test(commit)) {
        return jsonResponse({ ok: false, error: 'tag 或 commit 无效。' }, { status: 400 });
    }
    const bucket = env.MIRROR_BUCKET;
    const repo = effectiveRepo(env);
    const manifestState = await readJsonObject(bucket, MANIFEST_KEY);
    const manifest = validateStoredManifest(manifestState.value, repo);
    const target = manifest.versions.find((item) => item?.tag === tag && item?.commit === commit);
    if (!target) return jsonResponse({ ok: false, error: '未找到指定版本。' }, { status: 404 });
    manifest.versions = manifest.versions.filter((item) => !(item?.tag === tag && item?.commit === commit));
    manifest.updatedAt = nowValue(options.now);
    const stored = await bucket.put(
        MANIFEST_KEY,
        JSON.stringify(manifest, null, 2),
        manifestPutOptions(manifestState.object)
    );
    if (!stored) return jsonResponse({ ok: false, error: 'Manifest 已被另一请求更新，请刷新后重试。' }, { status: 409 });
    // Snapshot keys are addressed by tag+commit, so after the manifest entry
    // is gone nothing references them and the R2 objects can be reclaimed.
    // If the tag is still a live upstream release, the next sync re-publishes
    // it from scratch.
    const snapshotKeys = Array.isArray(target.files)
        ? target.files
            .filter((file) => typeof file?.path === 'string' && file.path)
            .map((file) => `snapshots/${tag}/${commit}/${file.path}`)
        : [];
    for (const key of snapshotKeys) await bucket.delete(key);
    try {
        await pruneAnnouncementEntry(bucket, tag, commit);
    } catch (announcementError) {
        console.error(JSON.stringify({
            message: 'mirror announcements prune failed',
            error: safeErrorMessage(announcementError, env)
        }));
    }
    return jsonResponse({ ok: true, deleted: { tag, commit }, snapshotsDeleted: snapshotKeys.length });
}

async function updateRuntimeConfig(request, env) {
    const body = await readJsonRequest(request);
    const state = await readRuntimeConfigState(env.MIRROR_BUCKET, env);
    let config;
    try {
        config = configUpdate(body, state.config);
    } catch (error) {
        return jsonResponse({ ok: false, error: safeErrorMessage(error, env) }, { status: 400 });
    }
    const stored = await env.MIRROR_BUCKET.put(CONFIG_KEY, JSON.stringify(config, null, 2), {
        onlyIf: state.object ? { etagMatches: state.object.etag } : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });
    if (!stored) return jsonResponse({ ok: false, error: '配置已被另一请求更新，请刷新后重试。' }, { status: 409 });
    return jsonResponse({ ok: true, config });
}

async function handleRequest(request, env, options = {}) {
    if (request.method === 'GET' && isRawSnapshotTraversal(request)) {
        return jsonResponse({ ok: false, error: 'Not found.' }, { status: 404 });
    }
    const url = new URL(request.url);
    const runtimeOptions = {
        fetchImpl: options.fetchImpl || fetch,
        now: options.now || Date.now
    };
    if (request.method === 'GET' && url.pathname === '/health') {
        return Response.json({ ok: true, service: 'rp-hub-update-mirror' });
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
        try {
            return jsonResponse(await buildStatus(env));
        } catch (error) {
            return jsonResponse({ ok: false, error: safeErrorMessage(error, env) }, { status: 500 });
        }
    }
    if (request.method === 'GET' && url.pathname === '/index.html') {
        return new Response(null, { status: 301, headers: { location: '/' } });
    }
    if (request.method === 'GET' && url.pathname === '/manifest.json') {
        try {
            return await serveManifest(env);
        } catch (error) {
            return jsonResponse({ ok: false, error: safeErrorMessage(error, env) }, { status: 500 });
        }
    }
    if (request.method === 'GET' && url.pathname === '/announcements.json') {
        try {
            return await serveAnnouncements(env, url);
        } catch (error) {
            return jsonResponse({ ok: false, error: safeErrorMessage(error, env) }, { status: 500 });
        }
    }
    if (request.method === 'GET' && url.pathname.startsWith('/snapshots/')) {
        try {
            return await serveSnapshot(url.pathname, env);
        } catch (error) {
            return jsonResponse({ ok: false, error: safeErrorMessage(error, env) }, { status: 500 });
        }
    }
    if (request.method === 'GET' && url.pathname === '/') {
        try {
            const status = await buildPublicStatus(env);
            return new Response(renderPublicHtml(status, await publicAnnouncement(env, url)), {
                headers: {
                    'cache-control': 'no-store',
                    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
                    'content-type': 'text/html; charset=utf-8',
                    'referrer-policy': 'no-referrer',
                    'x-content-type-options': 'nosniff',
                    'x-frame-options': 'DENY'
                }
            });
        } catch (error) {
            return jsonResponse({ ok: false, error: safeErrorMessage(error, env) }, { status: 500 });
        }
    }
    if (request.method === 'GET' && url.pathname === '/admin') {
        try {
            const status = await buildStatus(env);
            return new Response(renderConsoleHtml(status), {
                headers: {
                    'cache-control': 'no-store',
                    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
                    'content-type': 'text/html; charset=utf-8',
                    'referrer-policy': 'no-referrer',
                    'x-content-type-options': 'nosniff',
                    'x-frame-options': 'DENY'
                }
            });
        } catch (error) {
            return jsonResponse({ ok: false, error: safeErrorMessage(error, env) }, { status: 500 });
        }
    }
    const writeRoute = (
        (request.method === 'POST' && ['/api/sync', '/api/pending/retry', '/api/versions/delete', '/api/webhook-test'].includes(url.pathname))
        || (request.method === 'PUT' && url.pathname === '/api/config')
    );
    if (writeRoute) {
        const forbidden = await authorizeWrite(request, env);
        if (forbidden) return forbidden;
        try {
            if (url.pathname === '/api/sync') return jsonResponse(await syncMirror(env, runtimeOptions));
            if (url.pathname === '/api/pending/retry') return await retryPending(request, env, runtimeOptions);
            if (url.pathname === '/api/versions/delete') return await deleteVersion(request, env, runtimeOptions);
            if (url.pathname === '/api/config') return await updateRuntimeConfig(request, env);
            const config = await readRuntimeConfig(env.MIRROR_BUCKET, env);
            const result = await sendWebhook(runtimeOptions.fetchImpl, env, {
                event: 'webhook_test',
                detail: 'Mirror publisher console test.',
                at: nowValue(runtimeOptions.now)
            }, config.webhookEnabled);
            return jsonResponse({ ok: result.sent, ...result });
        } catch (error) {
            return jsonResponse({ ok: false, error: safeErrorMessage(error, env) }, { status: 400 });
        }
    }
    return jsonResponse({ ok: false, error: 'Not found.' }, { status: 404 });
}

export default {
    async fetch(request, env) {
        return await handleRequest(request, env);
    },
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(syncMirror(env).then((result) => {
            console.log(JSON.stringify({
                message: 'mirror scheduled sync complete',
                cron: controller.cron,
                ...result
            }));
        }));
    }
};
