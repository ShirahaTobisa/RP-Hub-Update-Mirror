
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

// ---- 测试版通道：同步测试版仓库里日期标签的 Release，供各站点一键自更新 ----
const DEFAULT_TEST_RELEASE_REPO = 'ShirahaTobisa/RP-Hub';
const TEST_RELEASE_PREFIX = 'test-releases';
const TEST_RELEASE_MANIFEST_KEY = `${TEST_RELEASE_PREFIX}/manifest.json`;
const TEST_RELEASE_TAG_PATTERN = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;
const TEST_RELEASE_PATH_PATTERN = /^\/test-releases\/(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)\/(bundle\.json|RP-Hub-[\d.]+\.zip)$/;
const TEST_RELEASE_LIMIT = 10;
const MAX_TEST_RELEASE_ASSET_BYTES = 32 * 1024 * 1024;

function testReleaseRepo(env) {
    return typeof env?.TEST_RELEASE_REPO === 'string' && env.TEST_RELEASE_REPO.trim()
        ? env.TEST_RELEASE_REPO.trim()
        : DEFAULT_TEST_RELEASE_REPO;
}

function compareReleaseVersions(left, right) {
    const a = String(left).split('.').map(Number);
    const b = String(right).split('.').map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const diff = (a[index] || 0) - (b[index] || 0);
        if (diff) return diff;
    }
    return 0;
}

async function downloadReleaseAsset(fetchImpl, env, asset) {
    if (Number(asset.size) > MAX_TEST_RELEASE_ASSET_BYTES) throw new Error(`Release 附件过大：${asset.name}`);
    const response = await fetchWithTimeout(fetchImpl, asset.url, { headers: githubHeaders(env, 'application/octet-stream') });
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`下载 Release 附件失败：${asset.name}；HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

function validateTestReleaseBundle(bytes, tag) {
    let bundle;
    try {
        bundle = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new Error(`发布包不是有效 JSON：${tag}`);
    }
    const validPath = (path) => typeof path === 'string' && path && !path.startsWith('/') && !path.includes('..');
    if (bundle?.format !== 'rph-release-bundle-v1' || bundle.version !== tag || typeof bundle.worker !== 'string' || !bundle.worker
        || !Array.isArray(bundle.assets) || !bundle.assets.length
        || !bundle.assets.every((asset) => validPath(asset?.path) && typeof asset.base64 === 'string')) {
        throw new Error(`发布包格式无效：${tag}`);
    }
}

async function storeTestRelease(fetchImpl, env, bucket, release, bundleAsset, zipAsset, now) {
    const tag = release.tag_name;
    const bundleBytes = await downloadReleaseAsset(fetchImpl, env, bundleAsset);
    validateTestReleaseBundle(bundleBytes, tag);
    const zipBytes = await downloadReleaseAsset(fetchImpl, env, zipAsset);
    const base = `${TEST_RELEASE_PREFIX}/${tag}`;
    await bucket.put(`${base}/bundle.json`, bundleBytes, { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    await bucket.put(`${base}/${zipAsset.name}`, zipBytes, { httpMetadata: { contentType: 'application/zip' } });
    return {
        tag,
        name: typeof release.name === 'string' && release.name ? release.name : tag,
        notes: String(release.body || '').slice(0, 4000),
        publishedAt: Date.parse(release.published_at) || nowValue(now),
        bundle: { path: `/${base}/bundle.json`, sha256: await sha256Bytes(bundleBytes), size: bundleBytes.byteLength, assetId: bundleAsset.id },
        zip: { path: `/${base}/${zipAsset.name}`, sha256: await sha256Bytes(zipBytes), size: zipBytes.byteLength, assetId: zipAsset.id }
    };
}

// 只下载新增或附件有变化的版本；GitHub 上已删除的版本连同文件一起下架。单个版本出错不影响其他版本。
export async function syncTestReleases(env, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const now = options.now || Date.now;
    const bucket = env?.MIRROR_BUCKET;
    if (!bucket) throw new Error('缺少 MIRROR_BUCKET R2 binding。');
    const repo = testReleaseRepo(env);
    const state = await readJsonObject(bucket, TEST_RELEASE_MANIFEST_KEY);
    const previous = new Map((Array.isArray(state.value?.versions) ? state.value.versions : []).map((version) => [version.tag, version]));
    const releases = await fetchGitHubJson(fetchImpl, env, `https://api.github.com/repos/${repo}/releases?per_page=30`);
    if (!Array.isArray(releases)) throw new Error('测试版 Release 列表格式异常。');
    const candidates = releases
        .filter((release) => !release?.draft && TEST_RELEASE_TAG_PATTERN.test(release?.tag_name))
        .sort((left, right) => compareReleaseVersions(right.tag_name, left.tag_name))
        .slice(0, TEST_RELEASE_LIMIT);
    const versions = [];
    const skipped = [];
    for (const release of candidates) {
        const tag = release.tag_name;
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const bundleAsset = assets.find((asset) => asset?.name === `rph-bundle-${tag}.json`);
        const zipAsset = assets.find((asset) => asset?.name === `RP-Hub-${tag}.zip`);
        const known = previous.get(tag);
        if (!bundleAsset || !zipAsset) {
            skipped.push({ tag, reason: '附件不全，可能仍在打包' });
            continue;
        }
        if (known?.bundle?.assetId === bundleAsset.id && known?.zip?.assetId === zipAsset.id) {
            versions.push(known);
            continue;
        }
        try {
            versions.push(await storeTestRelease(fetchImpl, env, bucket, release, bundleAsset, zipAsset, now));
        } catch (error) {
            skipped.push({ tag, reason: toErrorMessage(error) });
            if (known) versions.push(known);
        }
    }
    const kept = new Set(versions.flatMap((version) => [version.bundle.path, version.zip.path]));
    const stale = [...previous.values()].flatMap((version) => [version.bundle?.path, version.zip?.path])
        .filter((path) => typeof path === 'string' && !kept.has(path)).map((path) => path.slice(1));
    const changed = JSON.stringify(state.value?.versions || []) !== JSON.stringify(versions);
    if (changed || !state.object) {
        const stored = await bucket.put(TEST_RELEASE_MANIFEST_KEY, JSON.stringify({ schema: 1, repo, updatedAt: nowValue(now), versions }, null, 2),
            manifestPutOptions(state.object));
        if (!stored) throw new ManifestConflictError();
    }
    if (stale.length) await bucket.delete(stale);
    return { ok: true, changed, versionCount: versions.length, skipped };
}

async function syncTestReleasesSafely(env, options) {
    try {
        return await syncTestReleases(env, options);
    } catch (error) {
        console.error(JSON.stringify({ message: 'test release sync failed', error: safeErrorMessage(error, env) }));
        return { ok: false, error: safeErrorMessage(error, env) };
    }
}

async function readTestReleaseVersions(bucket) {
    try {
        const value = (await readJsonObject(bucket, TEST_RELEASE_MANIFEST_KEY)).value;
        return Array.isArray(value?.versions) ? value.versions : [];
    } catch {
        return [];
    }
}

async function serveTestRelease(pathname, env) {
    const isManifest = pathname === `/${TEST_RELEASE_MANIFEST_KEY}`;
    if (!isManifest && !TEST_RELEASE_PATH_PATTERN.test(pathname)) return jsonResponse({ ok: false, error: 'Not found.' }, { status: 404 });
    const object = await env.MIRROR_BUCKET.get(pathname.slice(1));
    if (!object) return jsonResponse({ ok: false, error: 'Not found.' }, { status: 404 });
    return new Response(object.body, {
        headers: {
            'cache-control': isManifest ? 'public, max-age=60' : 'public, max-age=86400, immutable',
            'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
            'x-content-type-options': 'nosniff'
        }
    });
}

// ---- 插件工坊：作者在 /workshop/submit 投稿进待审核区，管理员在 /admin 审核上架；插件和目录都存在 R2 ----
const WORKSHOP_PREFIX = 'workshop';
const WORKSHOP_INDEX_KEY = `${WORKSHOP_PREFIX}/index.json`;
const WORKSHOP_PENDING_PREFIX = `${WORKSHOP_PREFIX}/pending/`;
const WORKSHOP_PLUGIN_PATH_PATTERN = /^\/workshop\/plugins\/([a-z0-9-]{3,32})\.js$/;
const WORKSHOP_PENDING_SOURCE_PATTERN = /^\/api\/workshop\/pending\/([a-f0-9-]{36})\.js$/;
const WORKSHOP_ID_PATTERN = /^[a-z0-9-]{3,32}$/;
const WORKSHOP_TEXT_LIMITS = { name: 40, author: 40, description: 300, contact: 100 };
const MAX_WORKSHOP_PLUGIN_BYTES = 2 * 1024 * 1024;
const MAX_WORKSHOP_PENDING = 50;
const CORS_HEADERS = { 'access-control-allow-origin': '*' };

class WorkshopRequestError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// 从插件源码里读出 register 时写的 id、version、requiresApi；要求写成字面量，真正的加载检查由站点加载器负责。
export function readPluginManifest(source) {
    const start = source.indexOf('RPHubSDK.register(');
    if (start < 0) throw new WorkshopRequestError('插件里没有找到 RPHubSDK.register(');
    const head = source.slice(start, start + 4000);
    const text = (key) => head.match(new RegExp(`\\b${key}\\s*:\\s*(['"])([^'"\\n]{1,32})\\1`))?.[2] || '';
    const id = text('id');
    const version = text('version');
    const requiresApi = Number(head.match(/\brequiresApi\s*:\s*(\d{1,3})\b/)?.[1]);
    if (!WORKSHOP_ID_PATTERN.test(id) || !version || !Number.isInteger(requiresApi) || requiresApi < 1) {
        throw new WorkshopRequestError('register 里的 id、version、requiresApi 要直接写成固定值；id 只用小写字母、数字和短横线，3～32 个字符');
    }
    return { id, version, requiresApi };
}

function readWorkshopText(body) {
    const meta = {};
    for (const [key, limit] of Object.entries(WORKSHOP_TEXT_LIMITS)) {
        const value = typeof body?.[key] === 'string' ? body[key].trim() : '';
        if ((key !== 'contact' && !value) || value.length > limit) throw new WorkshopRequestError(`${key} 需要 ${key === 'contact' ? 0 : 1}～${limit} 个字符`);
        meta[key] = value;
    }
    return meta;
}

async function listWorkshopPending(bucket) {
    const listed = await bucket.list({ prefix: WORKSHOP_PENDING_PREFIX });
    const entries = [];
    for (const object of listed.objects || []) {
        if (!object.key.endsWith('.json')) continue;
        const value = (await readJsonObject(bucket, object.key)).value;
        if (plainObject(value)) entries.push(value);
    }
    return entries.sort((left, right) => Number(left.submittedAt || 0) - Number(right.submittedAt || 0)
        || String(left.id).localeCompare(String(right.id)));
}

async function readWorkshopIndexState(bucket) {
    const state = await readJsonObject(bucket, WORKSHOP_INDEX_KEY);
    return { object: state.object, plugins: Array.isArray(state.value?.plugins) ? state.value.plugins : [] };
}

async function writeWorkshopIndex(bucket, state, plugins, now) {
    const stored = await bucket.put(WORKSHOP_INDEX_KEY, JSON.stringify({ schema: 1, updatedAt: nowValue(now), plugins }, null, 2),
        manifestPutOptions(state.object));
    if (!stored) throw new ManifestConflictError();
}

// 公开投稿：存进待审核区，不会直接上架。同一插件 id 的旧投稿由新投稿替换。
export async function submitWorkshopPlugin(request, env, options = {}) {
    const now = options.now || Date.now;
    const bucket = env.MIRROR_BUCKET;
    let body;
    try {
        body = await readJsonRequest(request, MAX_WORKSHOP_PLUGIN_BYTES * 2);
    } catch (error) {
        throw new WorkshopRequestError(error.message);
    }
    const source = typeof body?.source === 'string' ? body.source : '';
    const bytes = new TextEncoder().encode(source);
    if (!source.trim() || bytes.byteLength > MAX_WORKSHOP_PLUGIN_BYTES) throw new WorkshopRequestError('插件文件不能为空，且不能超过 2MB');
    const manifest = readPluginManifest(source);
    const meta = readWorkshopText(body);
    const pending = await listWorkshopPending(bucket);
    const replaced = pending.filter((entry) => entry.id === manifest.id);
    if (pending.length - replaced.length >= MAX_WORKSHOP_PENDING) throw new WorkshopRequestError('待审核的投稿已满，请稍后再试', 429);
    const sid = crypto.randomUUID();
    const entry = { sid, ...manifest, ...meta, size: bytes.byteLength, sha256: await sha256Bytes(bytes), submittedAt: nowValue(now) };
    await bucket.put(`${WORKSHOP_PENDING_PREFIX}${sid}.js`, bytes, { httpMetadata: { contentType: 'text/javascript; charset=utf-8' } });
    await bucket.put(`${WORKSHOP_PENDING_PREFIX}${sid}.json`, JSON.stringify(entry), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    if (replaced.length) await bucket.delete(replaced.flatMap((item) => [`${WORKSHOP_PENDING_PREFIX}${item.sid}.js`, `${WORKSHOP_PENDING_PREFIX}${item.sid}.json`]));
    return { ok: true, sid, id: manifest.id, version: manifest.version };
}

async function readPendingSubmission(bucket, sid) {
    if (!/^[a-f0-9-]{36}$/.test(String(sid || ''))) throw new WorkshopRequestError('投稿编号无效');
    const entry = (await readJsonObject(bucket, `${WORKSHOP_PENDING_PREFIX}${sid}.json`)).value;
    const source = await bucket.get(`${WORKSHOP_PENDING_PREFIX}${sid}.js`);
    if (!entry || !source) throw new WorkshopRequestError('投稿不存在或已处理', 404);
    return { entry, bytes: new Uint8Array(await source.arrayBuffer()) };
}

// 管理员操作：上架（同 id 覆盖为新版本）、拒绝、下架。
async function reviewWorkshop(action, request, env, options = {}) {
    const now = options.now || Date.now;
    const bucket = env.MIRROR_BUCKET;
    const body = await readJsonRequest(request);
    if (action === 'remove') {
        const state = await readWorkshopIndexState(bucket);
        const plugins = state.plugins.filter((plugin) => plugin.id !== body?.id);
        if (plugins.length === state.plugins.length) throw new WorkshopRequestError('插件不在工坊里', 404);
        await writeWorkshopIndex(bucket, state, plugins, now);
        await bucket.delete(`${WORKSHOP_PREFIX}/plugins/${body.id}.js`);
        return { ok: true, removed: body.id };
    }
    const { entry, bytes } = await readPendingSubmission(bucket, body?.sid);
    const pendingKeys = [`${WORKSHOP_PENDING_PREFIX}${entry.sid}.js`, `${WORKSHOP_PENDING_PREFIX}${entry.sid}.json`];
    if (action === 'reject') {
        await bucket.delete(pendingKeys);
        return { ok: true, rejected: entry.sid };
    }
    if (await sha256Bytes(bytes) !== entry.sha256) throw new WorkshopRequestError('投稿文件与记录不一致，请拒绝后让作者重新投稿', 409);
    const path = `/${WORKSHOP_PREFIX}/plugins/${entry.id}.js`;
    await bucket.put(path.slice(1), bytes, { httpMetadata: { contentType: 'text/javascript; charset=utf-8' } });
    const state = await readWorkshopIndexState(bucket);
    const plugin = {
        id: entry.id, name: entry.name, version: entry.version, author: entry.author, description: entry.description,
        requiresApi: entry.requiresApi, updatedAt: nowValue(now), file: { path, sha256: entry.sha256, size: entry.size }
    };
    const plugins = [...state.plugins.filter((item) => item.id !== entry.id), plugin].sort((left, right) => left.id.localeCompare(right.id));
    await writeWorkshopIndex(bucket, state, plugins, now);
    await bucket.delete(pendingKeys);
    return { ok: true, published: plugin };
}

async function readWorkshopPlugins(bucket) {
    try {
        return (await readWorkshopIndexState(bucket)).plugins;
    } catch {
        return [];
    }
}

async function serveWorkshop(pathname, env) {
    const isIndex = pathname === `/${WORKSHOP_INDEX_KEY}`;
    if (!isIndex && !WORKSHOP_PLUGIN_PATH_PATTERN.test(pathname)) return jsonResponse({ ok: false, error: 'Not found.' }, { status: 404, headers: CORS_HEADERS });
    const object = await env.MIRROR_BUCKET.get(pathname.slice(1));
    if (!object) return jsonResponse({ ok: false, error: 'Not found.' }, { status: 404, headers: CORS_HEADERS });
    return new Response(object.body, {
        headers: {
            ...CORS_HEADERS,
            'cache-control': isIndex ? 'public, max-age=60' : 'public, max-age=300',
            'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
            'x-content-type-options': 'nosniff'
        }
    });
}

// 选好文件就在浏览器里读出 register 的 id/version/requiresApi，对照工坊目录判断新插件还是更新；规则与服务端 readPluginManifest 一致。
const SUBMIT_SCRIPT = String.raw`
const byId=(id)=>document.getElementById(id);const MAX=2*1024*1024;let source='';let catalog=[];
fetch('/workshop/index.json').then((r)=>r.ok?r.json():{plugins:[]}).then((v)=>{catalog=v.plugins||[];if(source)inspect()}).catch(()=>{});
function readManifest(text){const at=text.indexOf('RPHubSDK.register(');if(at<0)return{error:'插件里没有找到 RPHubSDK.register(。'};const head=text.slice(at,at+4000);const pick=(key)=>(head.match(new RegExp('\\b'+key+'\\s*:\\s*([\'"])([^\'"\\n]{1,40})\\1'))||[])[2]||'';const id=pick('id'),version=pick('version'),name=pick('name');const api=Number((head.match(/\brequiresApi\s*:\s*(\d{1,3})\b/)||[])[1]);if(!/^[a-z0-9-]{3,32}$/.test(id)||!version||!api)return{error:'register 里的 id、version、requiresApi 要直接写成固定值；id 只用小写字母、数字和短横线，3～32 个字符。'};return{id,version,name,requiresApi:api}}
function check(kind,message){const box=byId('check');box.className='notice '+kind;box.textContent=message;box.hidden=false}
function inspect(){const manifest=readManifest(source);byId('submit').disabled=true;if(manifest.error){byId('detected').hidden=true;check('error',manifest.error);return}const current=catalog.find((plugin)=>plugin.id===manifest.id);byId('dId').textContent=manifest.id;byId('dVersion').textContent=manifest.version;byId('dApi').textContent='API '+manifest.requiresApi;byId('dKind').textContent=current?'更新：工坊现有 v'+current.version+'（'+current.author+'）':'新插件';byId('dKind').className='badge '+(current?'warn':'ok');byId('detected').hidden=false;if(!byId('name').value&&(manifest.name||current))byId('name').value=(current&&current.name)||manifest.name;if(!byId('author').value&&current)byId('author').value=current.author;if(current&&current.version===manifest.version){check('warn','版本号和工坊里已上架的版本相同。更新插件请先改 register 里的 version。');return}check('ok','格式检查通过，填好下面的信息后提交审核。');byId('submit').disabled=false}
const drop=byId('drop');['dragenter','dragover'].forEach((type)=>drop.addEventListener(type,(event)=>{event.preventDefault();drop.classList.add('dragging')}));['dragleave','drop'].forEach((type)=>drop.addEventListener(type,()=>drop.classList.remove('dragging')));drop.addEventListener('drop',(event)=>{event.preventDefault();if(!event.dataTransfer.files.length)return;byId('file').files=event.dataTransfer.files;byId('file').dispatchEvent(new Event('change'))});
byId('file').addEventListener('change',async()=>{const file=byId('file').files[0];source='';byId('fileName').textContent=file?file.name:'选择插件文件';byId('fileHint').textContent=file?Math.max(1,Math.round(file.size/1024))+' KB · 点击更换文件':'点击选择，或把 .js 文件拖到这里，不超过 2MB';drop.classList.toggle('chosen',Boolean(file));byId('detected').hidden=true;byId('submit').disabled=true;if(!file){byId('check').hidden=true;return}if(file.size>MAX){check('error','插件文件不能超过 2MB。');return}source=await file.text();inspect()});
byId('description').addEventListener('input',()=>{byId('descCount').textContent=byId('description').value.length+' / 300'});
byId('form').addEventListener('submit',async(event)=>{event.preventDefault();if(!source)return;byId('submit').disabled=true;check('','正在提交…');try{const response=await fetch('/api/workshop/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,name:byId('name').value,author:byId('author').value,description:byId('description').value,contact:byId('contact').value})});const value=await response.json().catch(()=>({}));if(!response.ok)throw new Error(value.error||('HTTP '+response.status));byId('form').hidden=true;byId('doneText').textContent=value.id+' v'+value.version+' 已进入待审核。审核通过后会出现在首页的插件工坊里；同一插件再次投稿会替换这次的投稿。';byId('done').hidden=false}catch(error){check('error','提交失败：'+error.message);byId('submit').disabled=false}});
byId('again').addEventListener('click',()=>{location.reload()});
`;

function renderWorkshopSubmitHtml() {
    const main = `<div class="submit-layout">
<section>
<h1>投稿插件</h1>
<p class="lead">上传插件后进入待审核，维护者看过代码再上架到插件工坊。更新已有插件也在这里提交。</p>
<form id="form" class="card pad form" style="margin-top:20px">
<div class="field"><span>插件文件</span><label id="drop" class="drop"><input id="file" class="visually-hidden" type="file" accept=".js,text/javascript"><span class="drop-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M6 10l6-6 6 6M4 20h16"/></svg></span><span class="drop-text"><b id="fileName">选择插件文件</b><small id="fileHint">点击选择，或把 .js 文件拖到这里，不超过 2MB</small></span></label></div>
<div id="detected" class="detected" hidden><div class="meta"><span>id <code id="dId"></code></span><span>版本 <b id="dVersion"></b></span><span id="dApi"></span></div><span id="dKind" class="badge"></span></div>
<p id="check" class="notice" hidden></p>
<label class="field">名称<input id="name" maxlength="40" required></label>
<label class="field">作者<input id="author" maxlength="40" required></label>
<label class="field">说明<small>插件做什么；需要联网的写明会访问哪些地址。<span id="descCount">0 / 300</span></small><textarea id="description" maxlength="300" required></textarea></label>
<label class="field">联系方式<small>选填，方便审核时联系你</small><input id="contact" maxlength="100"></label>
<div class="actions"><button id="submit" class="btn primary" type="submit" disabled>提交审核</button></div>
</form>
<div id="done" class="card pad" hidden style="margin-top:20px"><h2>已提交</h2><p id="doneText" class="notes"></p><div class="actions" style="margin-top:12px"><a class="btn primary" href="/#workshop">查看插件工坊</a><button id="again" class="btn" type="button">再投一个</button></div></div>
</section>
<aside class="card pad side">
<h2>投稿须知</h2>
<ul>
<li><code>RPHubSDK.register({ id: '…', version: '…', requiresApi: 4, … })</code> 里的 id、version、requiresApi 直接写成固定值。</li>
<li>id 只用小写字母、数字和短横线，上架后不能改；更新时改 version。</li>
<li>不读取、不上传同步密码和生图密钥；需要联网的在说明里写清楚。</li>
<li>不要混淆或压缩代码，审核时要能看懂。</li>
</ul>
<h2>审核流程</h2>
<ol>
<li>提交后进入待审核区。</li>
<li>维护者阅读代码，决定上架或拒绝。</li>
<li>上架后出现在首页的插件工坊，站点在「模块管理 → 工坊」安装。</li>
</ol>
<p class="small muted">接口说明见 <a href="https://github.com/ShirahaTobisa/RP-Hub/blob/main/WORKSHOP-MOD-GUIDE.md">工坊开发指南</a>，示范插件见 <a href="https://github.com/ShirahaTobisa/RP-Hub/blob/main/examples/api-demo-module.js">api-demo-module.js</a>。</p>
</aside>
</div>`;
    const css = '.submit-layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:24px;align-items:start}.side{position:sticky;top:76px}.side h2{font-size:16px;margin-bottom:8px}.side h2:not(:first-child){margin-top:18px}.side ul,.side ol{margin:0;padding-left:20px;color:var(--muted)}.side li{margin:4px 0}.field{display:grid;gap:6px;font-weight:600}.drop{display:flex;align-items:center;gap:14px;padding:16px 18px;border:1.5px dashed var(--line);border-radius:12px;background:var(--surface-2);font-weight:400;cursor:pointer;transition:border-color .15s,background .15s}.drop:hover,.drop.dragging{border-color:var(--primary);background:var(--primary-soft)}.drop.chosen{border-style:solid}.drop:focus-within{outline:2px solid color-mix(in srgb,var(--primary) 45%,transparent);outline-offset:2px}.drop-icon{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:10px;background:var(--primary);color:#fff}.drop-text{display:grid;min-width:0}.drop-text b{overflow-wrap:anywhere}.drop-text small{color:var(--muted)}.visually-hidden{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}.detected{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-radius:10px;background:var(--surface-2)}@media(max-width:860px){.submit-layout{grid-template-columns:1fr}.side{position:static}}';
    return renderShell({ title: '投稿插件', active: '/workshop/submit', main, css, script: SUBMIT_SCRIPT });
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
        upstreamRepo: statusString(effectiveRepo(env), env, 300),
        testReleases: await readTestReleaseVersions(bucket),
        workshopPlugins: await readWorkshopPlugins(bucket),
        testReleaseRepo: statusString(testReleaseRepo(env), env, 300)
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

// ---- 页面外观：首页、投稿页、管理页共用一套样式和顶栏，跟随系统浅色/深色 ----
const SITE_CSS = String.raw`
:root{color-scheme:light;--bg:#f5f7fb;--surface:#fff;--surface-2:#f1f4f9;--line:#e3e8ef;--text:#111827;--muted:#64748b;--primary:#2563eb;--primary-soft:#e8f0fe;--primary-text:#1d4ed8;--ok:#15803d;--ok-soft:#e7f6ec;--warn:#b45309;--warn-soft:#fdf3e1;--danger:#b91c1c;--danger-soft:#fdecec;--radius:12px;--shadow:0 1px 2px rgba(16,24,40,.05),0 10px 28px -16px rgba(16,24,40,.18)}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0f1115;--surface:#171a21;--surface-2:#1e222b;--line:#2a2f3a;--text:#e6e8ec;--muted:#9aa3b2;--primary:#3b82f6;--primary-soft:#1c2a44;--primary-text:#9cc2ff;--ok:#4ade80;--ok-soft:#14301f;--warn:#fbbf24;--warn-soft:#33270f;--danger:#f87171;--danger-soft:#3a1717;--shadow:none}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;letter-spacing:0}
a{color:var(--primary-text);text-decoration:none}a:hover{text-decoration:underline}
[hidden]{display:none!important}
.wrap{width:min(1080px,calc(100% - 32px));margin:0 auto}
.topbar{position:sticky;top:0;z-index:20;background:var(--surface);border-bottom:1px solid var(--line)}
.topbar-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:56px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;color:var(--text);white-space:nowrap}.brand:hover{text-decoration:none}
.brand-mark{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--primary);color:#fff;font-size:14px;font-weight:800}
.site-nav{display:flex;gap:4px;overflow-x:auto}
.site-nav a{padding:6px 12px;border-radius:8px;color:var(--muted);white-space:nowrap}
.site-nav a:hover{background:var(--surface-2);color:var(--text);text-decoration:none}
.site-nav a[aria-current=page]{background:var(--primary-soft);color:var(--primary-text);font-weight:600}
main{padding:28px 0 40px}
h1{font-size:26px;line-height:1.3;margin:0 0 6px}h2{font-size:18px;margin:0}h3{font-size:16px;margin:0}
.lead{margin:0;color:var(--muted)}.muted{color:var(--muted)}.small{font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:20px 0 4px}
.stat{display:block;padding:14px 16px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow);color:var(--text)}
a.stat:hover{border-color:var(--primary);text-decoration:none}
.stat span{display:block;color:var(--muted);font-size:13px}.stat b{display:block;font-size:20px;overflow-wrap:anywhere}
.block{margin-top:32px;scroll-margin-top:72px}
.block-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:8px 16px;margin-bottom:12px}
.block-head p{margin:4px 0 0}
.card{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow)}
.pad{padding:16px 18px}
.list{list-style:none;margin:0;padding:0}
.list>li{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:12px 16px;border-top:1px solid var(--line)}
.list>li:first-child{border-top:0}
.grow{flex:1 1 240px;min-width:0}
.meta{display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--muted);font-size:13px}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;line-height:1.7;background:var(--surface-2);color:var(--muted);vertical-align:middle;white-space:nowrap}
.badge.primary{background:var(--primary-soft);color:var(--primary-text)}.badge.ok{background:var(--ok-soft);color:var(--ok)}.badge.warn{background:var(--warn-soft);color:var(--warn)}.badge.danger{background:var(--danger-soft);color:var(--danger)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:7px 14px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
.btn:hover{border-color:var(--primary);text-decoration:none}.btn:disabled{opacity:.5;cursor:not-allowed;border-color:var(--line)}
.btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}
.btn.danger{color:var(--danger)}.btn.danger:hover{border-color:var(--danger)}
.btn.small{min-height:30px;padding:4px 10px;font-size:13px}
.actions{display:flex;flex-wrap:wrap;gap:8px}
.notes{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
details.more{margin-top:12px}details.more>summary{cursor:pointer;color:var(--primary-text);font-weight:600;padding:4px 0}
details.more .list{margin-top:8px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.plugins{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}
.plugin{display:flex;flex-direction:column;gap:8px;padding:16px 18px}
.plugin p{margin:0;flex:1;color:var(--muted);overflow-wrap:anywhere}
.plugin-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
code,pre{font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}
.empty{padding:28px 16px;text-align:center;color:var(--muted)}
.list>li.empty{display:block}
.notice{padding:10px 14px;border-radius:10px;background:var(--surface-2);color:var(--text);overflow-wrap:anywhere}
.notice.ok{background:var(--ok-soft);color:var(--ok)}.notice.error{background:var(--danger-soft);color:var(--danger)}.notice.warn{background:var(--warn-soft);color:var(--warn)}
#announcement{margin-top:24px;padding:18px 20px;scroll-margin-top:72px;border-color:var(--primary)}
#announcement h3{margin:12px 0 4px}#announcement pre{margin:8px 0 14px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.8}
label.field{display:grid;gap:6px;font-weight:600}
label.field small{font-weight:400;color:var(--muted)}
input,textarea,select{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);font:inherit}
input:focus,textarea:focus{outline:2px solid color-mix(in srgb,var(--primary) 45%,transparent);outline-offset:1px;border-color:var(--primary)}
input[type=checkbox]{width:auto}
textarea{min-height:96px;resize:vertical}
.form{display:grid;gap:16px}.form p{margin:0}
.footer{padding:20px 0 32px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
.footer code{font-size:12px}
@media(max-width:640px){.wrap{width:calc(100% - 24px)}h1{font-size:22px}.stats{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.stat{padding:10px 12px}.stat span{font-size:12px}.stat b{font-size:14px}.topbar-inner{flex-direction:column;align-items:flex-start;gap:6px;padding:10px 0}.list>li{padding:12px}.pad{padding:14px}}
`;

// ---- 一键部署：用用户的 Cloudflare 令牌创建 Pages 项目和 R2 存储桶，部署最新测试版 ----
// 令牌只在这一次请求里使用，分发站不保存、不写日志；部署时把它作为加密密钥 CF_API_TOKEN 配进用户自己的项目，
// 之后站内「测试版更新」可以直接一键更新。
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEPLOY_PROJECT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;
const DEPLOY_BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const DEPLOY_ACCOUNT_PATTERN = /^[a-f0-9]{32}$/;
const DEPLOY_DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DEPLOY_CONTENT_TYPES = {
    html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
    wasm: 'application/wasm', webmanifest: 'application/manifest+json'
};

class DeployError extends Error {
    constructor(message, code = '', status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

// Cloudflare 的报错是英文，给不熟悉的人配上中文说明；原文附在后面方便排查。
const CF_ERROR_HINTS = [
    [/subdomain is unavailable|subdomain.*already in use/i, '这个项目名对应的 pages.dev 网址已经被别人用了（所有 Cloudflare 用户共用一套网址），请换一个更独特的项目名，比如加上你的名字缩写。'],
    [/invalid api token|invalid access token|authentication error|unauthorized/i, '令牌无效：可能复制时少了字符、已过期或已被删除。请重新创建令牌，完整复制后再填。'],
    [/permission|not authorized|forbidden|insufficient/i, '令牌缺少需要的权限：请按右侧「创建令牌」的说明，把列出的权限都加上，帐户资源要选你部署的那个帐户。'],
    [/please enable r2|r2.*(not enabled|subscri|purchase)|enable.*r2/i, '这个帐户还没开通 R2：到 Cloudflare 后台左侧「R2 对象存储」开通（免费额度内不扣费），然后再部署。'],
    [/maximum number of projects|project limit/i, '这个帐户的 Pages 项目数量已达上限：到 Cloudflare 后台删掉不用的项目再部署。'],
    [/rate limit|too many requests/i, '请求太频繁，被 Cloudflare 暂时限制了：等一两分钟再试。'],
    [/domain.*(already|in use|another project)/i, '这个域名已经绑定在别的 Pages 项目上：先在那个项目的「自定义域」里删掉，再重新部署。'],
    [/bucket.*(invalid|name)/i, '存储桶名不符合 Cloudflare 的要求：只用小写字母、数字和短横线，3～63 个字符，不能以短横线开头或结尾。'],
    [/project.*not found/i, '找不到这个 Pages 项目：可能刚被删除，请刷新页面重试。']
];

function explainCfError(detail, status) {
    const hint = CF_ERROR_HINTS.find(([pattern]) => pattern.test(detail))?.[1]
        || (status === 401 || status === 403 ? CF_ERROR_HINTS[2][1] : status >= 500 ? 'Cloudflare 那边暂时出错了，稍等几分钟再试。' : '');
    return hint ? `${hint}（Cloudflare 原文：${detail}）` : `Cloudflare 返回错误：${detail}`;
}

async function cfCall(fetchImpl, token, path, init = {}) {
    const response = await fetchImpl(CF_API_BASE + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    const data = await response.json().catch(() => null);
    if (data?.success) return data.result;
    const errors = data?.errors || [];
    const detail = errors.map((item) => item?.message).filter(Boolean).join('；') || `HTTP ${response.status}`;
    const failure = new DeployError(explainCfError(detail, response.status), '', response.status === 401 || response.status === 403 ? 403 : 502);
    failure.detail = detail;
    failure.cfStatus = response.status;
    failure.cfCodes = errors.map((item) => item?.code);
    throw failure;
}

async function listDeployAccounts(token, fetchImpl) {
    try {
        return (await cfCall(fetchImpl, token, '/accounts?per_page=50')).map((account) => ({ id: account.id, name: account.name || account.id }));
    } catch (error) {
        if (error.cfStatus === 401 || error.cfStatus === 403) throw new DeployError('令牌无效或权限不足，请按页面说明创建令牌。', 'TOKEN_INVALID', 403);
        throw error;
    }
}

async function readLatestTestBundle(bucket) {
    const manifest = await readJsonObject(bucket, TEST_RELEASE_MANIFEST_KEY).then((result) => result.value).catch(() => null);
    const version = Array.isArray(manifest?.versions) ? manifest.versions[0] : null;
    if (!version?.tag) throw new DeployError('分发站还没有测试版，暂时不能部署。', 'NO_RELEASE', 503);
    const object = await bucket.get(`${TEST_RELEASE_PREFIX}/${version.tag}/bundle.json`);
    if (!object) throw new DeployError('测试版发布包缺失，请稍后再试。', 'NO_RELEASE', 503);
    const bundle = JSON.parse(await object.text());
    if (bundle?.format !== 'rph-release-bundle-v1' || typeof bundle.worker !== 'string' || !Array.isArray(bundle.assets)) {
        throw new DeployError('测试版发布包格式无效。', 'NO_RELEASE', 503);
    }
    return bundle;
}

function deployContentType(path) {
    const name = path.split('/').pop();
    return DEPLOY_CONTENT_TYPES[name.includes('.') ? name.split('.').pop().toLowerCase() : ''] || 'application/octet-stream';
}

// Pages 直传：取上传凭证 → 上传缺失文件 → 登记 → 带外壳代码创建生产部署（与测试版站内一键更新同一流程）。
async function uploadPagesBundle(fetchImpl, token, account, project, bundle) {
    const projectPath = `/accounts/${account}/pages/projects/${project}`;
    const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const { jwt } = await cfCall(fetchImpl, token, `${projectPath}/upload-token`);
    const assets = await Promise.all(bundle.assets.map(async (asset) => {
        const name = asset.path.split('/').pop();
        const extension = name.includes('.') ? name.split('.').pop() : '';
        return { ...asset, hash: (await sha256Bytes(new TextEncoder().encode(asset.base64 + extension))).slice(0, 32) };
    }));
    const hashes = assets.map((asset) => asset.hash);
    const missing = await cfCall(fetchImpl, jwt, '/pages/assets/check-missing', post({ hashes }));
    const uploads = assets.filter((asset) => missing.includes(asset.hash))
        .map((asset) => ({ key: asset.hash, value: asset.base64, metadata: { contentType: deployContentType(asset.path) }, base64: true }));
    if (uploads.length) await cfCall(fetchImpl, jwt, '/pages/assets/upload', post(uploads));
    await cfCall(fetchImpl, jwt, '/pages/assets/upsert-hashes', post({ hashes }));
    const workerBundle = new FormData();
    workerBundle.set('metadata', JSON.stringify({ main_module: '_worker.js' }));
    workerBundle.set('_worker.js', new File([bundle.worker], '_worker.js', { type: 'application/javascript+module' }));
    const form = new FormData();
    form.set('manifest', JSON.stringify(Object.fromEntries(assets.map((asset) => [`/${asset.path}`, asset.hash]))));
    form.set('branch', 'main');
    form.set('commit_message', `RP-Hub 测试版 ${bundle.version}（分发站一键部署）`);
    form.set('_worker.bundle', new File([await new Response(workerBundle).blob()], '_worker.bundle'));
    return cfCall(fetchImpl, token, `${projectPath}/deployments`, { method: 'POST', body: form });
}

// 自定义域名：先加到 Pages 项目；域名托管在同一帐户时再补一条 CNAME。缺权限或已有记录指向别处时不覆盖，返回手动操作说明。
async function attachCustomDomain(fetchImpl, token, account, project, domain, subdomain) {
    const manual = `在域名的 DNS 里添加 CNAME 记录：${domain} → ${subdomain}`;
    try {
        await cfCall(fetchImpl, token, `/accounts/${account}/pages/projects/${project}/domains`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: domain })
        });
    } catch (error) {
        if (!/already|exist/i.test(error.detail || '') || /another project/i.test(error.detail || '')) return { name: domain, status: 'failed', message: `域名没能加到项目：${error.message}` };
    }
    const labels = domain.split('.');
    let zone = null;
    try {
        for (let index = 0; index < labels.length - 1 && !zone; index += 1) {
            const zones = await cfCall(fetchImpl, token, `/zones?name=${labels.slice(index).join('.')}&account.id=${account}`);
            zone = zones[0] || null;
        }
    } catch (_) {
        return { name: domain, status: 'manual', message: `令牌没有读取域名的权限。${manual}` };
    }
    if (!zone) return { name: domain, status: 'manual', message: `这个域名不在该 Cloudflare 帐户里。${manual}` };
    try {
        const records = await cfCall(fetchImpl, token, `/zones/${zone.id}/dns_records?name=${domain}`);
        if (records.some((item) => item.type === 'CNAME' && item.content === subdomain)) return { name: domain, status: 'ready', message: 'DNS 记录已存在。' };
        if (records.length) return { name: domain, status: 'manual', message: `${domain} 已有其他 DNS 记录，没有覆盖。需要时把它改成 CNAME → ${subdomain}。` };
        await cfCall(fetchImpl, token, `/zones/${zone.id}/dns_records`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'CNAME', name: domain, content: subdomain, proxied: true })
        });
        return { name: domain, status: 'ready', message: '已自动添加 DNS 记录，证书签发通常要几分钟。' };
    } catch (_) {
        return { name: domain, status: 'manual', message: `令牌没有修改 DNS 的权限。${manual}` };
    }
}

async function runDeploy(request, env, options) {
    const fetchImpl = options.fetchImpl;
    const body = await readJsonRequest(request, 8 * 1024).catch(() => null);
    const token = String(body?.token || '').trim();
    const password = String(body?.password || '');
    const projectName = String(body?.projectName || '').trim().toLowerCase();
    const bucketName = String(body?.bucketName || '').trim().toLowerCase();
    if (!token) throw new DeployError('请填写 Cloudflare 令牌。');
    if (password.length < 6) throw new DeployError('同步密码至少 6 位。');
    if (!DEPLOY_PROJECT_PATTERN.test(projectName)) throw new DeployError('项目名只能用小写字母、数字和短横线，最多 58 个字符。');
    if (!DEPLOY_BUCKET_PATTERN.test(bucketName)) throw new DeployError('存储桶名只能用小写字母、数字和短横线，3～63 个字符。');
    const customDomain = String(body?.customDomain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (customDomain && (!DEPLOY_DOMAIN_PATTERN.test(customDomain) || customDomain.endsWith('.pages.dev'))) throw new DeployError('自定义域名格式不对，例如 rph.example.com。');
    const accounts = await listDeployAccounts(token, fetchImpl);
    let account = String(body?.accountId || '').trim();
    if (account && !DEPLOY_ACCOUNT_PATTERN.test(account)) throw new DeployError('帐户 ID 格式不对，应为 32 位字符。');
    if (!account) {
        if (accounts.length === 1) account = accounts[0].id;
        else if (accounts.length > 1) throw new DeployError('令牌能访问多个帐户，请先选择要部署到哪个帐户。', 'CHOOSE_ACCOUNT');
        else throw new DeployError('令牌查不到帐户：请给令牌加上「帐户设置：读取」权限，或手动填写帐户 ID。', 'NEED_ACCOUNT');
    } else if (accounts.length && !accounts.some((item) => item.id === account)) {
        throw new DeployError('令牌没有这个帐户的权限。', 'TOKEN_INVALID', 403);
    }
    const bundle = await readLatestTestBundle(env.MIRROR_BUCKET);

    // 项目已存在时不直接覆盖：前端确认后带 overwrite 再来。
    let projectPath = `/accounts/${account}/pages/projects/${projectName}`;
    let project = await cfCall(fetchImpl, token, projectPath).catch((error) => {
        if (error.cfStatus === 404 || error.cfCodes?.includes(8000007)) return null;
        throw error;
    });
    if (project && body?.overwrite !== true) {
        throw new DeployError(`项目「${projectName}」已存在。继续会用最新测试版覆盖它，并重新设置存储桶绑定和同步密码。`, 'PROJECT_EXISTS', 409);
    }
    // 项目名同时是 *.pages.dev 网址，全体 Cloudflare 用户共用；被别人占用时加随机后缀重试。
    for (let attempt = 0; !project; attempt += 1) {
        const name = attempt ? `${projectName.slice(0, 52)}-${crypto.randomUUID().slice(0, 4)}` : projectName;
        project = await cfCall(fetchImpl, token, `/accounts/${account}/pages/projects`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, production_branch: 'main' })
        }).catch((error) => {
            if (!/subdomain is unavailable|already in use|already exists/i.test(error.detail || '') || attempt >= 3) throw error;
            return null;
        });
        if (project) projectPath = `/accounts/${account}/pages/projects/${project.name || name}`;
    }
    const finalName = project.name || projectName;
    const bucketPath = `/accounts/${account}/r2/buckets/${bucketName}`;
    const existingBucket = await cfCall(fetchImpl, token, bucketPath).catch((error) => {
        if (error.cfStatus === 404 || error.cfCodes?.includes(10006)) return null;
        throw error;
    });
    if (!existingBucket) {
        await cfCall(fetchImpl, token, `/accounts/${account}/r2/buckets`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: bucketName })
        }).catch((error) => {
            if (/enable r2|r2.*(not enabled|subscri|purchase)|activat/i.test(error.detail || '')) {
                throw new DeployError(explainCfError(error.detail, 409).replace(/^Cloudflare 返回错误：/, '这个帐户还没开通 R2，请到 Cloudflare 后台「R2 对象存储」开通后再部署：'), 'R2_NOT_ENABLED', 409);
            }
            throw error;
        });
    }
    await cfCall(fetchImpl, token, projectPath, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            deployment_configs: {
                production: {
                    r2_buckets: { RP_SYNC_R2: { name: bucketName } },
                    env_vars: {
                        RP_SYNC_PASSWORD: { type: 'secret_text', value: password },
                        CF_API_TOKEN: { type: 'secret_text', value: token },
                        CF_ACCOUNT_ID: { type: 'plain_text', value: account }
                    }
                }
            }
        })
    });
    const deployment = await uploadPagesBundle(fetchImpl, token, account, finalName, bundle);
    const subdomain = project.subdomain || `${finalName}.pages.dev`;
    const domain = customDomain ? await attachCustomDomain(fetchImpl, token, account, finalName, customDomain, subdomain) : null;
    return {
        ok: true,
        version: bundle.version,
        projectName: finalName,
        url: `https://${subdomain}`,
        customDomain: domain,
        deploymentUrl: deployment.url || '',
        bucketCreated: !existingBucket
    };
}

async function handleDeployApi(request, env, options, action) {
    try {
        if (action === 'accounts') {
            const body = await readJsonRequest(request, 4 * 1024).catch(() => null);
            const token = String(body?.token || '').trim();
            if (!token) throw new DeployError('请填写 Cloudflare 令牌。');
            return jsonResponse({ ok: true, accounts: await listDeployAccounts(token, options.fetchImpl) });
        }
        return jsonResponse(await runDeploy(request, env, options));
    } catch (error) {
        const known = error instanceof DeployError;
        return jsonResponse({ ok: false, code: known ? error.code : '', error: known ? error.message : `部署失败：${safeErrorMessage(error, env)}` }, { status: known ? error.status : 500 });
    }
}

const DEPLOY_SCRIPT = String.raw`
const byId=(id)=>document.getElementById(id);
const form=byId('deployForm'),status=byId('deployStatus'),accountField=byId('accountField'),accountSelect=byId('account'),submit=byId('deploy');
let overwrite=false;
function say(text,kind){status.textContent=text;status.className='notice'+(kind?' '+kind:'');status.hidden=!text;}
async function post(path,body){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json().catch(()=>({ok:false,error:'HTTP '+response.status}));return value;}
function payload(){return{token:byId('token').value.trim(),accountId:accountField.hidden?'':accountSelect.value,projectName:byId('project').value.trim(),customDomain:byId('domain').value.trim(),bucketName:byId('bucket').value.trim(),password:byId('password').value,overwrite};}
byId('token').addEventListener('change',()=>{accountField.hidden=true;accountSelect.innerHTML='';overwrite=false;});
byId('project').addEventListener('input',()=>{overwrite=false;});
form.addEventListener('submit',async(event)=>{event.preventDefault();submit.disabled=true;say('正在部署，约需半分钟，请不要关闭页面…');
try{const result=await post('/api/deploy',payload());
if(result.ok){say('');byId('doneUrl').href=result.url;byId('doneUrl').textContent=result.url;byId('doneVersion').textContent=result.version;byId('doneDomain').textContent=result.customDomain?('自定义域名 '+result.customDomain.name+'：'+result.customDomain.message):'';byId('doneDomain').hidden=!result.customDomain;byId('doneName').textContent=result.projectName;form.hidden=true;byId('done').hidden=false;return;}
if(result.code==='CHOOSE_ACCOUNT'||result.code==='NEED_ACCOUNT'){const list=await post('/api/deploy/accounts',{token:byId('token').value.trim()});accountSelect.innerHTML='';(list.accounts||[]).forEach((item)=>{const option=document.createElement('option');option.value=item.id;option.textContent=item.name+'（'+item.id.slice(0,8)+'…）';accountSelect.appendChild(option);});if(result.code==='NEED_ACCOUNT'){byId('accountManual').hidden=false;}accountField.hidden=false;say(result.error,'warn');return;}
if(result.code==='PROJECT_EXISTS'){if(confirm(result.error+'\n\n确定继续吗？')){overwrite=true;submit.disabled=false;form.requestSubmit();return;}say('已取消。换个项目名再部署，或确认覆盖。','warn');return;}
say(result.error||'部署失败','error');}catch(error){say('部署失败：'+error.message,'error');}finally{submit.disabled=false;}});
byId('accountManualInput').addEventListener('input',(event)=>{const value=event.target.value.trim();accountSelect.innerHTML='';if(value){const option=document.createElement('option');option.value=value;option.textContent=value;accountSelect.appendChild(option);}});
`;

function renderDeployHtml() {
    const main = `<div class="submit-layout">
<section>
<h1>一键部署</h1>
<p class="lead">在你自己的 Cloudflare 帐户里创建 RP-Hub 测试版站点：自动建 Pages 项目和 R2 存储桶、绑定、设置同步密码并部署最新测试版。免费计划即可。</p>
<form id="deployForm" class="card pad form" style="margin-top:20px">
<label class="field">Cloudflare 令牌<small>按「创建令牌」里的说明创建；分发站只在这次部署中使用，不保存。</small><input id="token" type="password" autocomplete="off" required></label>
<div id="accountField" class="field" hidden><span>部署到哪个帐户</span><select id="account"></select><label id="accountManual" class="field" hidden>帐户 ID<small>后台网址 dash.cloudflare.com/ 后面那串 32 位字符</small><input id="accountManualInput" maxlength="32"></label></div>
<label class="field">项目名<small>会成为网址 <code>项目名.pages.dev</code>；小写字母、数字和短横线；被别人用过会自动加后缀</small><input id="project" maxlength="58" required placeholder="my-rph"></label>
<label class="field">自定义域名<small>选填，例如 rph.example.com；不填就用 pages.dev 网址</small><input id="domain" maxlength="253" placeholder="rph.example.com"></label>
<label class="field">存储桶名<small>云同步、图片都存在这里；已有同名桶会直接使用</small><input id="bucket" maxlength="63" required value="rph-data"></label>
<label class="field">同步密码<small>至少 6 位；以后在站点里同步、管理图片都要用</small><input id="password" type="password" autocomplete="new-password" minlength="6" required></label>
<p id="deployStatus" class="notice" hidden></p>
<div class="actions"><button id="deploy" class="btn primary" type="submit">部署</button></div>
</form>
<div id="done" class="card pad" hidden style="margin-top:20px"><h2>部署完成</h2><p class="notes">测试版 <b id="doneVersion"></b> 已部署到 <a id="doneUrl" target="_blank" rel="noopener"></a>。第一次打开可能要等半分钟生效。</p><p class="notes">项目名：<code id="doneName"></code>（原名被占用时会自动加后缀）。</p><p id="doneDomain" class="notes" hidden></p><p class="notes">之后在站点「同步 → 测试版更新」里就能一键更新，不需要再来这里。</p></div>
</section>
<aside class="card pad side">
<h2>创建令牌</h2>
<ol>
<li>打开 <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener">API 令牌</a> →「创建令牌」→「创建自定义令牌」。</li>
<li>权限添加三项：<br>帐户 → Cloudflare Pages → 编辑<br>帐户 → Workers R2 存储 → 编辑<br>帐户 → 帐户设置 → 读取</li>
<li>要用自定义域名，再加两项：区域 → 区域 → 读取、区域 → DNS → 编辑（区域资源选你的域名）。不加也能部署，只是要自己去加 DNS 记录。</li>
<li>帐户资源选你要部署的帐户，创建后复制令牌。</li>
</ol>
<h2>这个令牌会被怎样使用</h2>
<ul>
<li>分发站只在这次部署中用它调用 Cloudflare 接口，不保存、不写日志。</li>
<li>部署时它会作为加密密钥 <code>CF_API_TOKEN</code> 存进你自己的 Pages 项目，站点以后用它一键更新。不想要这个功能，可以在项目设置里删掉它。</li>
<li>令牌只发给你自己，不要发给别人或贴到群里。</li>
</ul>
<p class="small muted">想手动部署，见 <a href="https://github.com/ShirahaTobisa/RP-Hub/blob/main/docs/INSTALL.md">安装说明</a>。</p>
</aside>
</div>`;
    const css = '.submit-layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:24px;align-items:start}.side{position:sticky;top:76px}.side h2{font-size:16px;margin-bottom:8px}.side h2:not(:first-child){margin-top:18px}.side ul,.side ol{margin:0;padding-left:20px;color:var(--muted)}.side li{margin:6px 0}select{width:100%}@media(max-width:860px){.submit-layout{grid-template-columns:1fr}.side{position:static}}';
    return renderShell({ title: '一键部署', active: '/deploy', main, css, script: DEPLOY_SCRIPT });
}

const SITE_NAV = [['/', '首页'], ['/deploy', '一键部署'], ['/workshop/submit', '投稿插件'], ['/admin', '管理']];

function renderShell({ title, active, main, css = '', script = '' }) {
    const nav = SITE_NAV.map(([href, label]) => `<a href="${href}"${href === active ? ' aria-current="page"' : ''}>${label}</a>`).join('');
    return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · RP-Hub 分发站</title>
<style>${SITE_CSS}${css}</style>
</head>
<body>
<header class="topbar"><div class="wrap topbar-inner"><a class="brand" href="/"><span class="brand-mark">R</span>RP-Hub 分发站</a><nav class="site-nav">${nav}</nav></div></header>
<main class="wrap">
${main}
</main>
<footer class="wrap footer">公开数据：<code>/manifest.json</code> · <code>/test-releases/manifest.json</code> · <code>/workshop/index.json</code></footer>
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

// 管理页：概览、上游版本、测试版、插件审核、设置。数据都从现有接口读取，写操作带管理员令牌。
const ADMIN_SCRIPT = String.raw`
const byId=(id)=>document.getElementById(id);const esc=(value)=>String(value??'').replace(/[&<>"']/g,(character)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));const time=(value)=>{if(!(Number(value)>0))return '尚无记录';const parts=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(Number(value)));const get=(type)=>parts.find((part)=>part.type===type)?.value||'';return get('year')+'-'+get('month')+'-'+get('day')+' '+get('hour')+':'+get('minute')};const kb=(bytes)=>Math.max(1,Math.round(Number(bytes||0)/1024))+' KB';
const configured=(value)=>value?'<span class="badge ok">已配置</span>':'<span class="badge danger">未配置</span>';const notice=(message,type)=>{const box=byId('notice');box.textContent=message;box.className='notice '+(type||'')};const storedToken=()=>localStorage.getItem('mirrorAdminToken')||'';
async function api(path,options={}){const headers=new Headers(options.headers||{});const token=storedToken();if(token)headers.set('authorization','Bearer '+token);if(options.body)headers.set('content-type','application/json');const response=await fetch(path,{...options,headers});let value;try{value=await response.json()}catch{value={ok:false,error:'响应不是有效 JSON。'}}if(!response.ok)throw new Error(value.error||('HTTP '+response.status));return value}
function renderAuth(){const signedIn=Boolean(storedToken());byId('authForm').hidden=signedIn;byId('authState').hidden=!signedIn}
byId('authForm').addEventListener('submit',(event)=>{event.preventDefault();const token=byId('adminToken').value.trim();if(!token)return;localStorage.setItem('mirrorAdminToken',token);byId('adminToken').value='';renderAuth();notice('管理员令牌已保存到此浏览器。','ok');refreshWorkshop()});
byId('logout').addEventListener('click',()=>{localStorage.removeItem('mirrorAdminToken');renderAuth();notice('已退出，令牌已从此浏览器删除。')});
function showTab(name){if(!document.querySelector('[data-panel="'+name+'"]'))name='overview';document.querySelectorAll('[data-tab]').forEach((button)=>button.setAttribute('aria-selected',String(button.dataset.tab===name)));document.querySelectorAll('[data-panel]').forEach((panel)=>{panel.hidden=panel.dataset.panel!==name});history.replaceState(null,'','#'+name);if(name==='tests')refreshTests();if(name==='workshop')refreshWorkshop()}
document.querySelectorAll('[data-tab]').forEach((button)=>button.addEventListener('click',()=>showTab(button.dataset.tab)));window.addEventListener('hashchange',()=>showTab(location.hash.slice(1)));
function versionItems(versions){return versions.length?versions.map((item,index)=>'<li><div class="grow"><b>'+esc(item.tag)+'</b> '+(index===0?'<span class="badge primary">最新</span>':'')+'<div class="meta"><span>commit <code>'+esc(String(item.commit).slice(0,12))+'</code></span><span>收录 '+esc(time(item.publishedAt))+'</span><span>'+Number(item.fileCount||0)+' 个文件</span></div></div><div class="actions"><button class="btn small show-announcement" data-tag="'+esc(item.tag)+'">公告</button><button class="btn small danger delete-version" data-tag="'+esc(item.tag)+'" data-commit="'+esc(item.commit)+'">删除</button></div></li>').join(''):'<li class="empty">尚无已发布版本</li>'}
function pendingItems(pending){return pending.length?pending.map((item)=>'<li><div class="grow"><b>'+esc(item.tag)+'</b> <span class="badge warn">'+esc(item.reason)+'</span><div class="meta"><span>commit <code>'+esc(String(item.commit).slice(0,12))+'</code></span><span>发现 '+esc(time(item.seenAt))+'</span></div><div class="notes small muted">'+esc(item.detail)+'</div></div><button class="btn small retry" data-tag="'+esc(item.tag)+'" data-commit="'+esc(item.commit)+'">重试</button></li>').join(''):'<li class="empty">没有挂起的版本</li>'}
function bindRetry(){document.querySelectorAll('.retry').forEach((button)=>button.addEventListener('click',async()=>{button.disabled=true;notice('正在重试 '+button.dataset.tag+'…');try{const result=await api('/api/pending/retry',{method:'POST',body:JSON.stringify({tag:button.dataset.tag,commit:button.dataset.commit})});notice(result.sync?.ok?'重试完成。':'重试已执行，同步仍有错误。',result.sync?.ok?'ok':'error');await refresh()}catch(error){notice(error.message,'error')}finally{button.disabled=false}}))}
function bindDelete(){document.querySelectorAll('.delete-version').forEach((button)=>button.addEventListener('click',async()=>{if(!confirm('确认删除版本 '+button.dataset.tag+'？快照文件一并清理；如果它仍是上游现行 Release，下次同步会重新上架。'))return;button.disabled=true;notice('正在删除 '+button.dataset.tag+'…');try{const result=await api('/api/versions/delete',{method:'POST',body:JSON.stringify({tag:button.dataset.tag,commit:button.dataset.commit})});notice('已删除 '+button.dataset.tag+'（清理快照 '+(result.snapshotsDeleted||0)+' 个）。','ok');await refresh()}catch(error){notice(error.message,'error');button.disabled=false}}))}
function bindAnnouncements(){document.querySelectorAll('.show-announcement').forEach((button)=>button.addEventListener('click',async()=>{button.disabled=true;const panel=byId('announcementPanel');panel.textContent='公告加载中…';panel.hidden=false;try{const response=await fetch('/announcements.json?tag='+encodeURIComponent(button.dataset.tag));let value=null;try{value=await response.json()}catch{value=null}panel.textContent='';const head=document.createElement('h3');head.textContent='公告 · '+button.dataset.tag;panel.appendChild(head);if(!response.ok||!value){const message=document.createElement('p');message.textContent=response.status===404?'公告索引尚未生成，请先点一次「同步上游版本」。':'公告加载失败：HTTP '+response.status;panel.appendChild(message)}else{const entry=(Array.isArray(value.entries)?value.entries:[]).find((item)=>item&&item.tag===button.dataset.tag)||null;const body=document.createElement(entry&&entry.announcement?'pre':'p');body.textContent=entry&&entry.announcement?'[ID '+entry.announcement.id+'] '+entry.announcement.title+'\n\n'+entry.announcement.content:'该版本暂无公告'+(entry&&entry.reason?'（'+entry.reason+'）。':'。');panel.appendChild(body)}panel.scrollIntoView({block:'nearest'})}catch(error){panel.textContent='公告加载失败：'+error.message}finally{button.disabled=false}}))}
function render(status){byId('pageStamp').textContent='状态时间 '+time(Date.now());byId('manifestState').textContent=status.manifest.valid?'正常':'格式无效';byId('updatedAt').textContent=time(status.manifest.updatedAt);byId('counts').textContent=status.manifest.versions.length+' / '+status.manifest.pending.length;const error=status.syncError;byId('syncError').textContent=error?((error.valid?'有同步错误':'错误状态无效')+' · '+time(error.at)):'无';const detail=error&&error.detail?((error.tag?'['+error.tag+'] ':'')+error.detail):'';byId('syncErrorDetail').textContent=detail;byId('syncErrorDetail').hidden=!detail;const progress=status.syncProgress;const box=byId('syncProgress');box.textContent='同步进度：'+(progress?((progress.state==='running'?'进行中':(progress.state==='done'?'已完成':'出错'))+' · 第 '+progress.step+' 步：'+progress.phase+(progress.detail?' — '+progress.detail:'')+' · '+time(progress.at)):'尚未同步过');box.className='notice '+(progress?(progress.state==='running'?'':(progress.state==='done'?'ok':'error')):'');byId('releaseLimit').value=status.config.releaseLimit;byId('webhookEnabled').checked=status.config.webhookEnabled;byId('upstreamRepo').textContent=status.config.upstreamRepo;byId('patchRevision').textContent=status.RP_HUB_APP_PATCH_REVISION;byId('secretGithub').innerHTML=configured(status.secrets.github);byId('secretWebhook').innerHTML=configured(status.secrets.webhook);byId('secretWebhookAuth').innerHTML=configured(status.secrets.webhookAuth);byId('secretAdmin').innerHTML=configured(status.secrets.admin);byId('versionsBody').innerHTML=versionItems(status.manifest.versions);byId('pendingBody').innerHTML=pendingItems(status.manifest.pending);byId('pendingCount').textContent=status.manifest.pending.length?String(status.manifest.pending.length):'';bindRetry();bindDelete();byId('announcementPanel').hidden=true;bindAnnouncements()}
let progressTimer=null;function startProgressPolling(){if(progressTimer)return;progressTimer=setInterval(async()=>{try{const status=await api('/api/status');render(status);if(!status.syncProgress||status.syncProgress.state!=='running'){clearInterval(progressTimer);progressTimer=null}}catch{}},2000)}
function syncSummary(result){const parts=[];const published=(result.events||[]).filter((event)=>event==='version_published'||event==='retag_republished').length;const failed=(result.events||[]).filter((event)=>event.indexOf('precheck_failed')>=0).length;if(published)parts.push('上架 '+published+' 个上游版本');if(failed)parts.push(failed+' 个预检失败转挂起');if(!published&&!failed)parts.push(result.changed?'状态已更新':'上游无新版本');parts.push('累计 '+result.versionCount+' 个');if(result.snapshotBudget&&result.snapshotBudget.deferred)parts.push('还有版本待回填，请再点一次「同步上游版本」');return parts.join('；')+'。'}
async function refresh(){try{render(await api('/api/status'))}catch(error){notice(error.message,'error')}}
byId('refresh').addEventListener('click',async()=>{await refresh();notice('状态已刷新。','ok')});
byId('syncNow').addEventListener('click',async(event)=>{const button=event.currentTarget;button.disabled=true;notice('正在同步…（进度每 2 秒刷新）');startProgressPolling();try{const result=await api('/api/sync',{method:'POST'});notice(result.ok?'同步完成：'+syncSummary(result):'同步失败：'+(result.error||'未知错误'),result.ok?'ok':'error');await refresh()}catch(error){notice('同步失败：'+error.message,'error')}finally{button.disabled=false}});
byId('syncTests').addEventListener('click',async(event)=>{const button=event.currentTarget;button.disabled=true;notice('正在同步测试版…');try{const result=await api('/api/sync/test-releases',{method:'POST'});notice(result.ok?'测试版同步完成：共 '+result.versionCount+' 个。':'测试版同步失败：'+(result.error||'未知错误'),result.ok?'ok':'error');await refreshTests()}catch(error){notice('测试版同步失败：'+error.message,'error')}finally{button.disabled=false}});
byId('webhookTest').addEventListener('click',async(event)=>{const button=event.currentTarget;button.disabled=true;notice('正在测试 Webhook…');try{const result=await api('/api/webhook-test',{method:'POST'});notice(result.sent?'Webhook 已发送。':(result.disabled?'Webhook 已禁用。':'Webhook 未发送。'),result.sent?'ok':'error')}catch(error){notice(error.message,'error')}finally{button.disabled=false}});
byId('configForm').addEventListener('submit',async(event)=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{await api('/api/config',{method:'PUT',body:JSON.stringify({releaseLimit:Number(byId('releaseLimit').value),webhookEnabled:byId('webhookEnabled').checked})});notice('配置已保存。','ok');await refresh()}catch(error){notice(error.message,'error')}finally{button.disabled=false}});
async function refreshTests(){const box=byId('testsBody');try{const response=await fetch('/test-releases/manifest.json',{cache:'no-store'});if(response.status===404){box.innerHTML='<li class="empty">还没有测试版</li>';return}const value=await response.json();const versions=value.versions||[];box.innerHTML=versions.length?versions.map((item,index)=>'<li><div class="grow"><b>'+esc(item.tag)+'</b> '+(index===0?'<span class="badge primary">最新</span>':'')+'<div class="meta"><span>发布 '+esc(time(item.publishedAt))+'</span><span>发布包 '+kb(item.bundle&&item.bundle.size)+'</span>'+(item.zip?'<span>部署包 '+kb(item.zip.size)+'</span>':'')+'</div><p class="notes small">'+esc(item.notes||'无更新说明')+'</p></div>'+(item.zip?'<a class="btn small" href="'+esc(item.zip.path)+'">部署包</a>':'')+'</li>').join(''):'<li class="empty">还没有测试版</li>'}catch(error){box.innerHTML='<li class="empty">读取失败：'+esc(error.message)+'</li>'}}
let workshop={pending:[],plugins:[]};let review=null;
async function refreshWorkshop(){if(!storedToken()){byId('workshopPendingBody').innerHTML='<li class="empty">保存管理员令牌后才能查看投稿</li>';byId('workshopPluginsBody').innerHTML='';return}try{workshop=await api('/api/workshop/pending');renderWorkshop()}catch(error){notice(error.message,'error')}}
function renderWorkshop(){byId('workshopCount').textContent=workshop.pending.length?String(workshop.pending.length):'';byId('workshopPendingBody').innerHTML=workshop.pending.length?workshop.pending.map((item)=>{const current=workshop.plugins.find((plugin)=>plugin.id===item.id);return '<li><div class="grow"><b>'+esc(item.name)+'</b> <code>'+esc(item.id)+'</code> '+(current?'<span class="badge warn">更新 '+esc(current.version)+' → '+esc(item.version)+'</span>':'<span class="badge ok">新插件 '+esc(item.version)+'</span>')+'<div class="meta"><span>'+esc(item.author)+'</span><span>投稿 '+esc(time(item.submittedAt))+'</span><span>'+kb(item.size)+'</span><span>API '+esc(item.requiresApi)+'</span>'+(item.contact?'<span>联系 '+esc(item.contact)+'</span>':'')+'</div><p class="notes small">'+esc(item.description)+'</p></div><button class="btn small primary ws-review" data-sid="'+esc(item.sid)+'">审阅</button></li>'}).join(''):'<li class="empty">没有待审核的投稿</li>';byId('workshopPluginsBody').innerHTML=workshop.plugins.length?workshop.plugins.map((plugin)=>'<li><div class="grow"><b>'+esc(plugin.name)+'</b> <code>'+esc(plugin.id)+'</code> <span class="badge">v'+esc(plugin.version)+'</span><div class="meta"><span>'+esc(plugin.author)+'</span><span>更新 '+esc(time(plugin.updatedAt))+'</span><span>'+kb(plugin.file&&plugin.file.size)+'</span></div></div><div class="actions"><a class="btn small" href="'+esc(plugin.file.path)+'" target="_blank" rel="noopener">源码</a><button class="btn small danger ws-remove" data-id="'+esc(plugin.id)+'">下架</button></div></li>').join(''):'<li class="empty">工坊里还没有插件</li>';document.querySelectorAll('.ws-review').forEach((button)=>button.addEventListener('click',()=>openReview(button.dataset.sid).catch((error)=>notice(error.message,'error'))));document.querySelectorAll('.ws-remove').forEach((button)=>button.addEventListener('click',async()=>{if(!confirm('确认下架 '+button.dataset.id+'？已经装了的站点不受影响，但工坊里不再显示。'))return;button.disabled=true;try{await api('/api/workshop/remove',{method:'POST',body:JSON.stringify({id:button.dataset.id})});notice('已下架 '+button.dataset.id+'。','ok');await refreshWorkshop()}catch(error){notice(error.message,'error');button.disabled=false}}))}
async function openReview(sid){const item=workshop.pending.find((entry)=>entry.sid===sid);if(!item)return;const current=workshop.plugins.find((plugin)=>plugin.id===item.id)||null;notice('正在读取投稿代码…');const response=await fetch('/api/workshop/pending/'+sid+'.js',{headers:{authorization:'Bearer '+storedToken()}});if(!response.ok)throw new Error('读取投稿代码失败：HTTP '+response.status);const text=await response.text();let old=null;if(current){const published=await fetch(current.file.path,{cache:'no-store'});if(published.ok)old=await published.text()}review={item,current,text,old};byId('reviewTitle').textContent=item.name+' · '+item.id+' v'+item.version;byId('reviewMeta').innerHTML='<span>作者 '+esc(item.author)+'</span><span>'+kb(item.size)+'</span><span>API '+esc(item.requiresApi)+'</span><span>SHA-256 <code>'+esc(String(item.sha256).slice(0,16))+'…</code></span>'+(item.contact?'<span>联系 '+esc(item.contact)+'</span>':'')+(current?'<span>当前上架 v'+esc(current.version)+'（'+esc(current.author)+'）</span>':'<span>新插件</span>');byId('reviewDescription').textContent=item.description;byId('viewDiff').hidden=!old;showCode(old?'diff':'full');byId('reviewPanel').hidden=false;byId('reviewPanel').scrollIntoView({block:'start'});notice('请读完代码再决定上架或拒绝。')}
function showCode(mode){byId('viewDiff').setAttribute('aria-selected',String(mode==='diff'));byId('viewFull').setAttribute('aria-selected',String(mode==='full'));byId('reviewCode').innerHTML=mode==='diff'?renderDiff(review.old,review.text):renderFull(review.text)}
byId('viewDiff').addEventListener('click',()=>showCode('diff'));byId('viewFull').addEventListener('click',()=>showCode('full'));
function renderFull(text){return text.split('\n').map((line,index)=>'<div class="ln"><span>'+(index+1)+'</span><code>'+esc(line)+'</code></div>').join('')}
function diffLines(a,b){let start=0;while(start<a.length&&start<b.length&&a[start]===b[start])start++;let endA=a.length,endB=b.length;while(endA>start&&endB>start&&a[endA-1]===b[endB-1]){endA--;endB--}const ops=[];for(let i=0;i<start;i++)ops.push(['=',a[i],i+1,i+1]);const x=a.slice(start,endA),y=b.slice(start,endB);if(x.length*y.length<=4000000){const n=x.length,m=y.length,w=m+1,dp=new Uint32Array((n+1)*w);for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)dp[i*w+j]=x[i]===y[j]?dp[(i+1)*w+j+1]+1:Math.max(dp[(i+1)*w+j],dp[i*w+j+1]);let i=0,j=0;while(i<n||j<m){if(i<n&&j<m&&x[i]===y[j]){ops.push(['=',x[i],start+i+1,start+j+1]);i++;j++}else if(j<m&&(i>=n||dp[i*w+j+1]>dp[(i+1)*w+j])){ops.push(['+',y[j],0,start+j+1]);j++}else{ops.push(['-',x[i],start+i+1,0]);i++}}}else{x.forEach((line,k)=>ops.push(['-',line,start+k+1,0]));y.forEach((line,k)=>ops.push(['+',line,0,start+k+1]))}for(let k=0;k<a.length-endA;k++)ops.push(['=',a[endA+k],endA+k+1,endB+k+1]);return ops}
function renderDiff(oldText,newText){const ops=diffLines(oldText.split('\n'),newText.split('\n'));const keep=new Uint8Array(ops.length);let added=0,removed=0;ops.forEach((op,index)=>{if(op[0]==='+')added++;if(op[0]==='-')removed++;if(op[0]!=='=')for(let d=-3;d<=3;d++)if(index+d>=0&&index+d<ops.length)keep[index+d]=1});if(!added&&!removed)return '<div class="empty">代码和已上架版本完全相同</div>';let html='<div class="diff-sum"><span class="badge ok">+'+added+' 行</span> <span class="badge danger">-'+removed+' 行</span> <span class="muted small">只显示改动和前后 3 行</span></div>',skipped=0;const gap=()=>{if(skipped)html+='<div class="ln gap"><span></span><code>… 省略 '+skipped+' 行未改动 …</code></div>';skipped=0};ops.forEach((op,index)=>{if(!keep[index]){skipped++;return}gap();html+='<div class="ln'+(op[0]==='+'?' add':op[0]==='-'?' del':'')+'"><span>'+(op[0]==='-'?op[2]:op[3])+'</span><code>'+(op[0]==='='?' ':op[0])+' '+esc(op[1])+'</code></div>'});gap();return html}
async function decide(action){if(!review)return;const label=action==='approve'?'上架':'拒绝';if(!confirm(action==='approve'?'确认上架？插件会拥有安装它的站点的全部权限。':'确认拒绝这条投稿？投稿文件会被删除。'))return;try{const result=await api('/api/workshop/'+action,{method:'POST',body:JSON.stringify({sid:review.item.sid})});byId('reviewPanel').hidden=true;review=null;await refreshWorkshop();notice(action==='approve'?'已上架 '+result.published.id+' v'+result.published.version+'。':'已'+label+'。','ok')}catch(error){notice(label+'失败：'+error.message,'error')}}
byId('reviewApprove').addEventListener('click',()=>decide('approve'));byId('reviewReject').addEventListener('click',()=>decide('reject'));byId('reviewClose').addEventListener('click',()=>{byId('reviewPanel').hidden=true});byId('workshopRefresh').addEventListener('click',async()=>{await refreshWorkshop();notice('工坊已刷新。','ok')});
renderAuth();refresh();showTab(location.hash.slice(1)||'overview');if(storedToken())refreshWorkshop();
`;

const ADMIN_CSS = '.admin-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px 20px;margin-bottom:16px}.auth{display:flex;gap:8px;align-items:center}.auth input{width:240px}.tabs{display:flex;gap:4px;margin:18px 0 16px;border-bottom:1px solid var(--line);overflow-x:auto}.tabs button{position:relative;padding:9px 14px;border:0;border-bottom:2px solid transparent;background:none;color:var(--muted);font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}.tabs button[aria-selected=true]{color:var(--primary-text);border-bottom-color:var(--primary)}.tabs .count:not(:empty){margin-left:6px;padding:0 7px;border-radius:999px;background:var(--danger);color:#fff;font-size:12px}.panel-grid{display:grid;gap:16px}.panel-grid h2{margin-bottom:10px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}.kv{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--line)}.kv:first-of-type{border-top:0}.inline-form{display:flex;flex-wrap:wrap;align-items:center;gap:10px}.inline-form input[type=number]{width:90px}#announcementPanel h3{margin-bottom:8px}#announcementPanel pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.review-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:10px}.code-tabs{display:flex;gap:6px;margin:12px 0 8px}.code-tabs button[aria-selected=true]{border-color:var(--primary);color:var(--primary-text)}.code{max-height:560px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--surface-2)}.ln{display:grid;grid-template-columns:52px minmax(0,1fr);font:12.5px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.ln span{padding:0 8px;text-align:right;color:var(--muted);user-select:none;border-right:1px solid var(--line)}.ln code{padding:0 10px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.ln.add{background:var(--ok-soft)}.ln.del{background:var(--danger-soft)}.ln.gap code{color:var(--muted);font-style:italic}.diff-sum{display:flex;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--line)}@media(max-width:640px){.auth{width:100%}.auth input{flex:1;width:auto}}';

function renderConsoleHtml() {
    const main = `<div class="admin-head">
<div><h1>管理</h1><p id="pageStamp" class="lead small"></p></div>
<div class="auth"><form id="authForm" class="auth"><input id="adminToken" type="password" autocomplete="off" placeholder="管理员令牌" aria-label="管理员令牌"><button class="btn primary" type="submit">保存令牌</button></form><div id="authState" class="auth" hidden><span class="badge ok">已保存令牌</span><button id="logout" class="btn small" type="button">退出</button></div></div>
</div>
<div id="notice" class="notice">就绪</div>
<div class="tabs" role="tablist">
<button type="button" role="tab" data-tab="overview">概览</button>
<button type="button" role="tab" data-tab="upstream">上游版本<span id="pendingCount" class="count"></span></button>
<button type="button" role="tab" data-tab="tests">测试版</button>
<button type="button" role="tab" data-tab="workshop">插件审核<span id="workshopCount" class="count"></span></button>
<button type="button" role="tab" data-tab="settings">设置</button>
</div>
<section data-panel="overview" class="panel-grid">
<div class="metrics">
<div class="stat"><span>清单状态</span><b id="manifestState">—</b></div>
<div class="stat"><span>最后更新</span><b id="updatedAt">—</b></div>
<div class="stat"><span>上游已发布 / 挂起</span><b id="counts">—</b></div>
<div class="stat"><span>同步错误</span><b id="syncError">—</b></div>
</div>
<div id="syncProgress" class="notice">同步进度：读取中…</div>
<div id="syncErrorDetail" class="notice error" hidden></div>
<div class="actions"><button id="syncNow" class="btn primary" type="button">同步上游版本</button><button id="refresh" class="btn" type="button">刷新状态</button></div>
<p class="muted small">「同步上游版本」只拉取 RPH 上游；测试版在「测试版」一栏单独同步；插件工坊不需要同步，审核上架后立即生效。</p>
</section>
<section data-panel="upstream" class="panel-grid" hidden>
<div><h2>已发布版本</h2><ul id="versionsBody" class="list card"></ul></div>
<div id="announcementPanel" class="card pad" hidden></div>
<div><h2>挂起的版本</h2><ul id="pendingBody" class="list card"></ul></div>
</section>
<section data-panel="tests" class="panel-grid" hidden>
<div><h2>测试版</h2><div class="actions"><button id="syncTests" class="btn" type="button">同步测试版</button></div><p class="muted small">来自 GitHub 上的日期标签 Release，每小时 07 分、37 分自动同步，也可以手动同步。</p><ul id="testsBody" class="list card"><li class="empty">读取中…</li></ul></div>
</section>
<section data-panel="workshop" class="panel-grid" hidden>
<div class="block-head" style="margin:0"><div><h2>待审核投稿</h2><p class="muted small">投稿页：<a href="/workshop/submit">/workshop/submit</a>。同一 id 上架会覆盖旧版本。</p></div><button id="workshopRefresh" class="btn" type="button">刷新</button></div>
<ul id="workshopPendingBody" class="list card"></ul>
<div id="reviewPanel" class="card pad" hidden>
<div class="review-head"><div><h2 id="reviewTitle"></h2><div id="reviewMeta" class="meta"></div></div><button id="reviewClose" class="btn small" type="button">关闭</button></div>
<p id="reviewDescription" class="notes"></p>
<div class="code-tabs"><button id="viewDiff" class="btn small" type="button">和已上架版本对比</button><button id="viewFull" class="btn small" type="button">完整代码</button></div>
<div id="reviewCode" class="code"></div>
<div class="actions" style="margin-top:12px"><button id="reviewApprove" class="btn primary" type="button">上架</button><button id="reviewReject" class="btn danger" type="button">拒绝</button></div>
</div>
<div><h2>已上架插件</h2><ul id="workshopPluginsBody" class="list card"></ul></div>
</section>
<section data-panel="settings" class="settings" hidden>
<div class="card pad"><h2>运行配置</h2><form id="configForm" class="inline-form" style="margin-top:10px"><label for="releaseLimit">保留上游 Release 数</label><input id="releaseLimit" type="number" min="1" max="12" step="1"><label><input id="webhookEnabled" type="checkbox"> 启用 Webhook 通知</label><button class="btn primary" type="submit">保存</button></form><div class="actions" style="margin-top:12px"><button id="webhookTest" class="btn" type="button">测试 Webhook</button></div></div>
<div class="card pad"><h2>环境</h2><div class="kv"><span>GitHub 令牌</span><span id="secretGithub"></span></div><div class="kv"><span>Webhook 地址</span><span id="secretWebhook"></span></div><div class="kv"><span>Webhook 鉴权</span><span id="secretWebhookAuth"></span></div><div class="kv"><span>管理员令牌</span><span id="secretAdmin"></span></div><div class="kv"><span>上游仓库</span><span id="upstreamRepo"></span></div><div class="kv"><span>补丁修订</span><code id="patchRevision"></code></div></div>
</section>`;
    return renderShell({ title: '管理', active: '/admin', main, css: ADMIN_CSS, script: ADMIN_SCRIPT });
}

function publicPendingReason(reason) {
    if (reason === 'patch-rejected') return '适配未通过，等待维护';
    if (reason === 'release-incomplete') return '上游发布内容不完整';
    return '暂不可用';
}

function publicDate(value) {
    const text = String(value || '').trim();
    return text ? text.slice(0, 10) : '未知';
}

// 公开页的时间精确到分钟，不带时区后缀（页面说明里统一注明 UTC+8）。
function formatShortTime(value) {
    return formatStatusTime(value).replace(/:\d{2} \(UTC\+8\)$/, '');
}

function formatKilobytes(bytes) {
    return `${Math.max(1, Math.round(Number(bytes || 0) / 1024))} KB`;
}

// 公告展开不依赖 JavaScript：通过 /?tag=…#announcement 在服务端渲染，读取失败时给出重试表单。
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
            : '<p class="muted">该版本暂无公告。</p>';
    } catch {
        body = `<p class="notice error">公告暂时无法读取，请稍后重试。</p><form method="get" action="/" class="actions" style="margin:12px 0"><input type="hidden" name="tag" value="${escapeHtml(tag)}"><button class="btn" type="submit">重试</button></form>`;
    }
    return `<section id="announcement" class="card" aria-labelledby="announcement-title"><h2 id="announcement-title">公告 · ${escapeHtml(tag)}</h2>${body}<a class="btn small" href="/">返回版本列表</a></section>`;
}

function renderPublicHtml(status, announcement = '') {
    const versions = status.manifest.versions;
    const testReleases = status.testReleases || [];
    const plugins = status.workshopPlugins || [];
    const latestTest = testReleases[0];

    const versionItem = (version, index) => `<li>
        <div class="grow"><b>${escapeHtml(version.tag)}</b> ${index === 0 ? '<span class="badge primary">最新</span>' : ''}${isDerivedTag(version.tag) ? ' <span class="badge warn">预览</span>' : ''}
        <div class="meta"><span>上游发布 ${escapeHtml(publicDate(version.date))}</span><span>收录 ${escapeHtml(formatShortTime(version.publishedAt))}</span></div></div>
        <a class="btn small" href="/?tag=${encodeURIComponent(version.tag)}#announcement">查看公告</a>
    </li>`;
    const versionItems = versions.length ? versions.slice(0, 3).map(versionItem).join('') : '<li class="empty">暂无可更新版本</li>';
    const olderVersions = versions.length > 3
        ? `<details class="more"><summary>更早的版本（${versions.length - 3}）</summary><ul class="list">${versions.slice(3).map((version, index) => versionItem(version, index + 3)).join('')}</ul></details>`
        : '';
    const pending = status.manifest.pending.length
        ? `<details class="more"><summary>暂不可用的版本（${status.manifest.pending.length}）</summary><ul class="list">${status.manifest.pending.map((item) => `<li>
        <div class="grow"><b>${escapeHtml(item.tag)}</b> <span class="badge warn">${escapeHtml(publicPendingReason(item.reason))}</span>
        <div class="meta"><span>发现于 ${escapeHtml(formatShortTime(item.seenAt))}</span></div></div></li>`).join('')}</ul></details>`
        : '';

    const testItem = (release) => `<div class="grow"><b>${escapeHtml(release.tag)}</b>
        <div class="meta"><span>发布 ${escapeHtml(formatShortTime(release.publishedAt))}</span>${release.zip ? `<span>部署包 ${formatKilobytes(release.zip.size)}</span>` : ''}</div>
        <p class="notes">${escapeHtml(release.notes || '无更新说明')}</p></div>
        ${release.zip ? `<a class="btn small" href="${escapeHtml(release.zip.path)}">下载部署包</a>` : ''}`;
    const tests = latestTest
        ? `<div class="card pad"><div class="block-head" style="margin:0"><div class="grow"><b style="font-size:18px">${escapeHtml(latestTest.tag)}</b> <span class="badge primary">最新</span>
        <div class="meta"><span>发布 ${escapeHtml(formatShortTime(latestTest.publishedAt))}</span>${latestTest.zip ? `<span>部署包 ${formatKilobytes(latestTest.zip.size)}</span>` : ''}</div></div>
        ${latestTest.zip ? `<a class="btn primary" href="${escapeHtml(latestTest.zip.path)}">下载部署包</a>` : ''}</div>
        <p class="notes">${escapeHtml(latestTest.notes || '无更新说明')}</p></div>
        ${testReleases.length > 1 ? `<details class="more"><summary>更早的测试版（${testReleases.length - 1}）</summary><ul class="list">${testReleases.slice(1).map((release) => `<li>${testItem(release)}</li>`).join('')}</ul></details>` : ''}`
        : '<div class="card empty">暂无测试版</div>';

    const pluginCards = plugins.length
        ? `<div class="plugins">${plugins.map((plugin) => `<article class="card plugin">
        <div class="plugin-head"><h3>${escapeHtml(plugin.name)}</h3><span class="badge">v${escapeHtml(plugin.version)}</span></div>
        <div class="meta"><span>${escapeHtml(plugin.author)}</span><span><code>${escapeHtml(plugin.id)}</code></span><span>需要 API ${Number(plugin.requiresApi) || '?'}</span></div>
        <p>${escapeHtml(plugin.description)}</p>
        <div class="meta"><span>更新于 ${escapeHtml(formatShortTime(plugin.updatedAt))}</span><a href="${escapeHtml(plugin.file.path)}">查看源码</a></div>
    </article>`).join('')}</div>`
        : '<div class="card empty">工坊里还没有插件。<a href="/workshop/submit">投稿第一个插件</a></div>';

    const main = `<section class="hero">
<h1>RP-Hub 分发站</h1>
<p class="lead">为 RP-Hub 测试版站点提供上游页面更新、测试版自更新和插件工坊。站点在「云同步」和「模块管理」里直接使用，这里可以查看可用版本和插件。</p>
<div class="stats">
<a class="stat" href="#upstream"><span>上游最新版本</span><b>${escapeHtml(versions[0]?.tag || '—')}</b></a>
<a class="stat" href="#test-builds"><span>测试版最新版本</span><b>${escapeHtml(latestTest?.tag || '—')}</b></a>
<a class="stat" href="#workshop"><span>工坊插件</span><b>${plugins.length} 个</b></a>
</div>
</section>
${announcement}
<section id="upstream" class="block" aria-labelledby="upstream-title">
<div class="block-head"><div><h2 id="upstream-title">上游版本</h2><p class="muted small">来自 <a href="https://github.com/${escapeHtml(status.upstreamRepo)}">${escapeHtml(status.upstreamRepo)}</a>，补丁预检通过后收录。站点在「云同步 → 程序更新」选择版本。清单更新于 ${escapeHtml(formatShortTime(status.manifest.updatedAt))}（时间均为 UTC+8）。</p></div></div>
<ul class="list card">${versionItems}</ul>
${olderVersions}
${pending}
</section>
<section id="test-builds" class="block" aria-labelledby="test-title">
<div class="block-head"><div><h2 id="test-title">测试版</h2><p class="muted small">来自 ${escapeHtml(status.testReleaseRepo || '')}。设置了 CF_API_TOKEN 的站点在「云同步 → 测试版更新」一键更新；其他站点下载部署包后上传到 Cloudflare Pages。第一次部署见 <a href="https://github.com/ShirahaTobisa/RP-Hub/blob/main/docs/INSTALL.md">安装与更新</a>。</p></div></div>
${tests}
</section>
<section id="workshop" class="block" aria-labelledby="workshop-title">
<div class="block-head"><div><h2 id="workshop-title">插件工坊</h2><p class="muted small">经审核上架，测试版站点在「模块管理 → 工坊」一键安装和更新。插件拥有页面全部权限，请只安装信任的插件。</p></div><a class="btn primary" href="/workshop/submit">投稿插件</a></div>
${pluginCards}
</section>`;
    return renderShell({ title: '首页', active: '/', main });
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
    if (request.method === 'GET' && url.pathname.startsWith(`/${WORKSHOP_PREFIX}/`) && url.pathname !== '/workshop/submit') {
        try {
            return await serveWorkshop(url.pathname, env);
        } catch (error) {
            return jsonResponse({ ok: false, error: safeErrorMessage(error, env) }, { status: 500 });
        }
    }
    if (request.method === 'GET' && url.pathname.startsWith(`/${TEST_RELEASE_PREFIX}/`)) {
        try {
            return await serveTestRelease(url.pathname, env);
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
    if (request.method === 'GET' && url.pathname === '/deploy') {
        return new Response(renderDeployHtml(), {
            headers: {
                'cache-control': 'no-store',
                'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
                'content-type': 'text/html; charset=utf-8',
                'referrer-policy': 'no-referrer',
                'x-content-type-options': 'nosniff',
                'x-frame-options': 'DENY'
            }
        });
    }
    if (request.method === 'POST' && (url.pathname === '/api/deploy' || url.pathname === '/api/deploy/accounts')) {
        return handleDeployApi(request, env, runtimeOptions, url.pathname === '/api/deploy' ? 'deploy' : 'accounts');
    }
    if (request.method === 'GET' && url.pathname === '/workshop/submit') {
        return new Response(renderWorkshopSubmitHtml(), {
            headers: {
                'cache-control': 'no-store',
                'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
                'content-type': 'text/html; charset=utf-8',
                'referrer-policy': 'no-referrer',
                'x-content-type-options': 'nosniff',
                'x-frame-options': 'DENY'
            }
        });
    }
    if (request.method === 'POST' && url.pathname === '/api/workshop/submit') {
        try {
            return jsonResponse(await submitWorkshopPlugin(request, env, runtimeOptions));
        } catch (error) {
            return jsonResponse({ ok: false, error: error instanceof WorkshopRequestError ? error.message : safeErrorMessage(error, env) }, { status: error.status || 500 });
        }
    }
    const workshopAdminRoute = (request.method === 'GET' && (url.pathname === '/api/workshop/pending' || WORKSHOP_PENDING_SOURCE_PATTERN.test(url.pathname)))
        || (request.method === 'POST' && ['/api/workshop/approve', '/api/workshop/reject', '/api/workshop/remove'].includes(url.pathname));
    if (workshopAdminRoute) {
        const forbidden = await authorizeWrite(request, env);
        if (forbidden) return forbidden;
        try {
            if (url.pathname === '/api/workshop/pending') {
                return jsonResponse({ ok: true, pending: await listWorkshopPending(env.MIRROR_BUCKET), plugins: await readWorkshopPlugins(env.MIRROR_BUCKET) });
            }
            const sourceMatch = url.pathname.match(WORKSHOP_PENDING_SOURCE_PATTERN);
            if (sourceMatch) {
                const { bytes } = await readPendingSubmission(env.MIRROR_BUCKET, sourceMatch[1]);
                return new Response(bytes, { headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } });
            }
            return jsonResponse(await reviewWorkshop(url.pathname.split('/').pop(), request, env, runtimeOptions));
        } catch (error) {
            return jsonResponse({ ok: false, error: error instanceof WorkshopRequestError ? error.message : safeErrorMessage(error, env) }, { status: error.status || 400 });
        }
    }
    const writeRoute = (
        (request.method === 'POST' && ['/api/sync', '/api/sync/test-releases', '/api/pending/retry', '/api/versions/delete', '/api/webhook-test'].includes(url.pathname))
        || (request.method === 'PUT' && url.pathname === '/api/config')
    );
    if (writeRoute) {
        const forbidden = await authorizeWrite(request, env);
        if (forbidden) return forbidden;
        try {
            if (url.pathname === '/api/sync') return jsonResponse(await syncMirror(env, runtimeOptions));
            if (url.pathname === '/api/sync/test-releases') return jsonResponse(await syncTestReleasesSafely(env, runtimeOptions));
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
        ctx.waitUntil(syncTestReleasesSafely(env).then((result) => {
            console.log(JSON.stringify({ message: 'test release scheduled sync complete', cron: controller.cron, ...result }));
        }));
    }
};
