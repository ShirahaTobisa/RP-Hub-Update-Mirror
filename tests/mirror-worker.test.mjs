
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { bytesOf, FakeR2 } from './r2.mjs';
import { webcrypto } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RP_HUB_APP_PATCH_REVISION } from '../lib/app-patches.mjs';
import mirrorWorker, { syncMirror } from '../worker.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM_REPO_DIR = path.resolve(TEST_DIR, '..', '.cache', 'upstream');
const PASS_COMMIT_OLD = '53a8d80951e594e717b8081873b2f77eb809d0fc';
const PASS_COMMIT_NEW = 'ed372012fde428499d024ac3623902b754af7721';
const REJECT_COMMIT = '936b47f6e992d77d61e20b93ef24360964372e9a';
const FIXED_NOW = 1786464000000;

function gitTree(commit) {
    const output = execFileSync(
        'git',
        ['-C', UPSTREAM_REPO_DIR, 'ls-tree', '-r', '-l', commit],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
    );
    return output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
        const match = line.match(/^\d+\s+(\w+)\s+([a-f0-9]{40})\s+(\d+|-)\t(.+)$/);
        assert(match, `unexpected git ls-tree output: ${line}`);
        return {
            path: match[4],
            mode: '100644',
            type: match[1],
            sha: match[2],
            size: Number(match[3])
        };
    });
}

function gitBlob(commit, filePath) {
    return execFileSync(
        'git',
        ['-C', UPSTREAM_REPO_DIR, 'cat-file', 'blob', `${commit}:${filePath}`],
        { encoding: null, maxBuffer: 8 * 1024 * 1024 }
    );
}

function release(tag, commit, name = tag) {
    return { tag, commit, name, date: '2026-08-12T00:00:00Z' };
}

function writeOctal(bytes, offset, length, value) {
    const text = value.toString(8).padStart(length - 1, '0') + '\0';
    new TextEncoder().encode(text).slice(0, length).forEach((byte, index) => { bytes[offset + index] = byte; });
}

function tarEntry(pathname, content, type = '0') {
    const data = bytesOf(content);
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(pathname).slice(0, 100), 0);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.byteLength);
    writeOctal(header, 136, 12, 0);
    header[156] = type.charCodeAt(0);
    header.set(new TextEncoder().encode('ustar\0'), 257);
    header.set(new TextEncoder().encode('00'), 263);
    for (let index = 148; index < 156; index += 1) header[index] = 0x20;
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeOctal(header, 148, 8, checksum);
    const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
    padded.set(data);
    return { header, padded };
}

function concatBytes(...parts) {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

function makeTar(entries) {
    const parts = [];
    for (const entry of entries) {
        const item = tarEntry(entry.path, entry.bytes, entry.type || '0');
        parts.push(item.header, item.padded);
    }
    parts.push(new Uint8Array(1024));
    return concatBytes(...parts);
}

function put16(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
}

function put32(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
}

function makeZip(tarBytes, method = 0) {
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(tarBytes)) : tarBytes;
    const name = new TextEncoder().encode('artifact.tar');
    const local = new Uint8Array(30 + name.byteLength);
    put32(local, 0, 0x04034b50);
    put16(local, 4, 20);
    put16(local, 6, 0);
    put16(local, 8, method);
    put32(local, 18, compressed.byteLength);
    put32(local, 22, tarBytes.byteLength);
    put16(local, 26, name.byteLength);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.byteLength);
    put32(central, 0, 0x02014b50);
    put16(central, 4, 20);
    put16(central, 6, 20);
    put16(central, 8, 0);
    put16(central, 10, method);
    put32(central, 20, compressed.byteLength);
    put32(central, 24, tarBytes.byteLength);
    put16(central, 28, name.byteLength);
    central.set(name, 46);
    const eocd = new Uint8Array(22);
    put32(eocd, 0, 0x06054b50);
    put16(eocd, 8, 1);
    put16(eocd, 10, 1);
    put32(eocd, 12, central.byteLength);
    put32(eocd, 16, local.byteLength + compressed.byteLength);
    return concatBytes(local, compressed, central, eocd);
}

async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function artifactBytes(commit, method = 0, extraEntries = [], omitPaths = []) {
    // 额外条目与上游同名时替换上游文件（如用人造公告替换 built-in-content.js）。
    const omitted = new Set([...omitPaths, ...extraEntries.map((entry) => entry.path)]);
    const entries = gitTree(commit)
        .filter((entry) => entry.type === 'blob' && !entry.path.startsWith('DB/') && !omitted.has(entry.path))
        .map((entry) => ({ path: entry.path, bytes: gitBlob(commit, entry.path) }))
        .concat(extraEntries);
    return makeZip(makeTar(entries), method);
}

async function artifactSpec(commit, method = 0, options = {}) {
    const zip = artifactBytes(commit, method, options.extraEntries || [], options.omitPaths || []);
    return {
        name: 'github-pages',
        expired: Boolean(options.expired),
        created_at: options.created_at || '2026-08-13T14:44:42Z',
        digest: `sha256:${options.digest || await sha256Hex(zip)}`,
        workflow_run: { head_sha: commit },
        archive_download_url: options.archive_download_url
            || 'https://api.github.com/repos/STA1N156/RP-Hub/actions/artifacts/fixture/zip',
        zip,
        downloadStatus: options.downloadStatus || 200
    };
}

function createFixtureFetch(state) {
    const calls = [];
    const webhooks = [];
    const fetchImpl = async (input, options = {}) => {
        const url = new URL(String(input));
        calls.push(url.toString());
        if (url.origin === 'https://webhook.test') {
            webhooks.push({
                payload: JSON.parse(String(options.body || '{}')),
                authorization: new Headers(options.headers).get('authorization')
            });
            if (state.webhookThrows) throw new Error('fixture webhook network failure');
            const status = state.webhookStatus || 204;
            return new Response(status === 204 ? null : '', { status });
        }
        if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases')) {
            if (state.failReleases) return new Response(state.failReleaseBody || 'fixture GitHub unavailable', { status: 503 });
            return Response.json(state.releases.map((item) => ({
                tag_name: item.tag,
                name: item.name,
                published_at: item.date,
                draft: false
            })));
        }
        if (url.hostname === 'api.github.com' && url.pathname.endsWith('/actions/artifacts')) {
            if (state.failArtifacts) return new Response(state.failArtifactBody || 'fixture artifacts unavailable', { status: 503 });
            const artifacts = state.artifacts || [];
            return Response.json({
                total_count: artifacts.length,
                artifacts: artifacts.map(({ zip, downloadStatus, ...metadata }) => metadata)
            });
        }
        if (url.hostname === 'api.github.com' && url.pathname.includes('/actions/artifacts/') && url.pathname.endsWith('/zip')) {
            const accept = new Headers(options.headers).get('accept') || '';
            if (accept.includes('application/octet-stream')) {
                return Response.json({
                    message: "Unsupported 'Accept' header: 'application/octet-stream'. Must accept 'application/json'."
                }, { status: 415 });
            }
            const artifact = (state.artifacts || []).find((candidate) => candidate.archive_download_url === url.toString())
                || (state.artifacts || [])[0];
            if (!artifact) return new Response('missing artifact', { status: 404 });
            if (artifact.downloadStatus !== 200) return new Response('artifact unavailable', { status: artifact.downloadStatus });
            return new Response(artifact.zip);
        }
        const commitMatch = url.pathname.match(/\/commits\/([^/]+)$/);
        if (url.hostname === 'api.github.com' && commitMatch) {
            const tag = decodeURIComponent(commitMatch[1]);
            const item = state.releases.find((candidate) => candidate.tag === tag);
            return item ? Response.json({ sha: item.commit }) : new Response('missing tag', { status: 404 });
        }
        const treeMatch = url.pathname.match(/\/git\/trees\/([a-f0-9]{40})$/);
        if (url.hostname === 'api.github.com' && treeMatch) {
            let tree = gitTree(treeMatch[1]);
            if (typeof state.treeTransform === 'function') tree = state.treeTransform(treeMatch[1], tree);
            return Response.json({ truncated: Boolean(state.treeTruncated), tree });
        }
        if (url.hostname === 'raw.githubusercontent.com') {
            const match = url.pathname.match(/^\/STA1N156\/RP-Hub\/([a-f0-9]{40})\/(.+)$/);
            assert(match, `unexpected raw fixture URL: ${url}`);
            return new Response(gitBlob(match[1], decodeURIComponent(match[2])));
        }
        throw new Error(`fixture attempted an unexpected network request: ${url}`);
    };
    return { calls, webhooks, fetchImpl };
}

function env(bucket) {
    return {
        MIRROR_BUCKET: bucket,
        GITHUB_TOKEN: 'fixture-token',
        WEBHOOK_URL: 'https://webhook.test/events',
        WEBHOOK_TOKEN: 'fixture-webhook-token',
        UPSTREAM_REPO: 'STA1N156/RP-Hub',
        RELEASE_LIMIT: '12'
    };
}

function adminEnv(bucket, overrides = {}) {
    return {
        ...env(bucket),
        ADMIN_TOKEN: 'fixture-admin-token',
        ...overrides
    };
}

async function workerFetch(request, workerEnv, fixture) {
    const previousFetch = globalThis.fetch;
    if (fixture) globalThis.fetch = fixture.fetchImpl;
    try {
        return await mirrorWorker.fetch(request, workerEnv);
    } finally {
        globalThis.fetch = previousFetch;
    }
}

function adminRequest(pathname, options = {}, token = 'fixture-admin-token') {
    const headers = new Headers(options.headers || {});
    if (token !== null) headers.set('authorization', `Bearer ${token}`);
    return new Request(`https://publisher.test${pathname}`, { ...options, headers });
}

async function runSync(bucket, state) {
    const fixture = createFixtureFetch(state);
    const result = await syncMirror(env(bucket), {
        fetchImpl: fixture.fetchImpl,
        now: () => FIXED_NOW
    });
    return { result, fixture };
}

async function testNewVersionAndWebhookFailure() {
    const bucket = new FakeR2();
    const state = {
        releases: [release('2.0.0', PASS_COMMIT_NEW, 'RP-Hub 2.0.0')],
        webhookStatus: 503
    };
    const { result, fixture } = await runSync(bucket, state);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.deepEqual(result.events, ['version_published']);
    assert.equal(fixture.webhooks.length, 1, 'publish webhook was not attempted');
    assert.equal(fixture.webhooks[0].authorization, 'Bearer fixture-webhook-token');

    const manifest = bucket.json('manifest.json');
    assert.deepEqual(Object.keys(manifest), [
        'schema', 'updatedAt', 'upstreamRepo', 'versions', 'pending'
    ]);
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.updatedAt, FIXED_NOW);
    assert.equal(manifest.upstreamRepo, 'STA1N156/RP-Hub');
    assert.deepEqual(manifest.pending, []);
    assert.equal(manifest.versions.length, 1);
    assert.deepEqual(Object.keys(manifest.versions[0]), [
        'tag', 'commit', 'name', 'date', 'precheckPatchRevision', 'files', 'publishedAt'
    ]);
    assert.equal(manifest.versions[0].commit, PASS_COMMIT_NEW);
    assert.equal(manifest.versions[0].precheckPatchRevision, RP_HUB_APP_PATCH_REVISION);
    assert.deepEqual(Object.keys(manifest.versions[0].files[0]), ['path', 'sha256', 'size']);
    assert(manifest.versions[0].files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
    assert(bucket.keys(`snapshots/2.0.0/${PASS_COMMIT_NEW}/`).length > 0);
    assert(bucket.putCalls.some((call) => call.key === 'manifest.json' && call.onlyIf?.etagDoesNotMatch === '*'));
}

async function testRetagPassSwitchesCommit() {
    const bucket = new FakeR2();
    await runSync(bucket, { releases: [release('2.0.0', PASS_COMMIT_OLD)] });
    const oldSnapshotKeys = bucket.keys(`snapshots/2.0.0/${PASS_COMMIT_OLD}/`);
    assert(oldSnapshotKeys.length > 0);

    const { result, fixture } = await runSync(bucket, { releases: [release('2.0.0', PASS_COMMIT_NEW)] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.events, ['retag_republished']);
    assert.equal(bucket.json('manifest.json').versions[0].commit, PASS_COMMIT_NEW);
    assert.deepEqual(bucket.keys(`snapshots/2.0.0/${PASS_COMMIT_OLD}/`), oldSnapshotKeys,
        'retag removed the old immutable snapshot');
    assert(bucket.keys(`snapshots/2.0.0/${PASS_COMMIT_NEW}/`).length > 0);
    assert.equal(fixture.webhooks.at(-1).payload.event, 'retag_republished');
}

async function testRetagRejectKeepsOldCommit() {
    const bucket = new FakeR2();
    await runSync(bucket, { releases: [release('2.0.0', PASS_COMMIT_NEW)] });

    const { result, fixture } = await runSync(bucket, { releases: [release('2.0.0', REJECT_COMMIT)] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.events, ['retag_precheck_failed']);
    const manifest = bucket.json('manifest.json');
    assert.equal(manifest.versions[0].commit, PASS_COMMIT_NEW, 'rejected retag broke the old manifest anchor');
    assert.equal(manifest.pending.length, 1);
    assert.deepEqual(
        { tag: manifest.pending[0].tag, commit: manifest.pending[0].commit, reason: manifest.pending[0].reason },
        { tag: '2.0.0', commit: REJECT_COMMIT, reason: 'patch-rejected' }
    );
    assert.equal(
        bucket.keys(`snapshots/2.0.0/${REJECT_COMMIT}/`).length,
        gitTree(REJECT_COMMIT).length,
        'rejected retag did not retain its complete raw snapshot'
    );
    assert.equal(fixture.webhooks.at(-1).payload.event, 'retag_precheck_failed');
}

async function testReleaseIncompleteGoesPending() {
    const bucket = new FakeR2();
    const state = {
        releases: [release('incomplete', PASS_COMMIT_NEW)],
        treeTransform(commit, tree) {
            assert.equal(commit, PASS_COMMIT_NEW);
            return tree.filter((entry) => entry.path !== 'index.html');
        }
    };
    const { result, fixture } = await runSync(bucket, state);
    assert.equal(result.ok, true);
    assert.deepEqual(result.events, ['precheck_failed']);
    const manifest = bucket.json('manifest.json');
    assert.deepEqual(manifest.versions, []);
    assert.equal(manifest.pending[0].reason, 'release-incomplete');
    assert.match(manifest.pending[0].detail, /缺少必要文件：index\.html/);
    assert.equal(fixture.webhooks[0].payload.event, 'precheck_failed');
}

async function testArtifactDirectIntakeStoredAndDeflated() {
    for (const method of [0, 8]) {
        const bucket = new FakeR2();
        const artifact = await artifactSpec(PASS_COMMIT_NEW, method, {
            created_at: '2026-08-13T14:44:42Z'
        });
        const fixture = createFixtureFetch({
            releases: [release('2.0.0', PASS_COMMIT_OLD)],
            artifacts: [artifact]
        });
        const result = await syncMirror(env(bucket), { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW });
        assert.equal(result.ok, true);
        const manifest = bucket.json('manifest.json');
        assert.equal(manifest.versions.length, 2);
        assert.equal(manifest.versions[0].tag, '2.0.0-0813');
        assert.equal(manifest.versions[0].commit, PASS_COMMIT_NEW);
        assert.equal(bucket.keys(`snapshots/2.0.0-0813/${PASS_COMMIT_NEW}/`).length > 0, true);
        assert(fixture.calls.some((url) => url.endsWith('/actions/artifacts/fixture/zip')));
        for (const key of bucket.keys(`snapshots/2.0.0-0813/${PASS_COMMIT_NEW}/`)) {
            const pathInSnapshot = key.slice(`snapshots/2.0.0-0813/${PASS_COMMIT_NEW}/`.length);
            assert.deepEqual(
                new Uint8Array(bucket.records.get(key).bytes),
                new Uint8Array(gitBlob(PASS_COMMIT_NEW, pathInSnapshot)),
                `artifact snapshot changed bytes for ${pathInSnapshot}`
            );
        }
    }
}

async function testArtifactSelectionUsesNewestActiveCreatedAt() {
    const bucket = new FakeR2();
    const older = await artifactSpec(PASS_COMMIT_OLD, 0, {
        created_at: '2026-08-13T14:00:00Z',
        archive_download_url: 'https://api.github.com/repos/STA1N156/RP-Hub/actions/artifacts/older/zip'
    });
    const newer = await artifactSpec(PASS_COMMIT_NEW, 0, {
        created_at: '2026-08-13T15:00:00Z',
        archive_download_url: 'https://api.github.com/repos/STA1N156/RP-Hub/actions/artifacts/newer/zip'
    });
    const fixture = createFixtureFetch({ releases: [], artifacts: [newer, older] });
    const result = await syncMirror(env(bucket), { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW });
    assert.equal(result.ok, true);
    assert.equal(bucket.json('manifest.json').versions[0].commit, PASS_COMMIT_NEW);
    assert(fixture.calls.includes(newer.archive_download_url));
    assert.equal(fixture.calls.includes(older.archive_download_url), false);
}

async function testArtifactReleaseCommitUsesOfficialTreePipeline() {
    const bucket = new FakeR2();
    const artifact = await artifactSpec(PASS_COMMIT_NEW, 0);
    const fixture = createFixtureFetch({
        releases: [release('2.0.0', PASS_COMMIT_NEW)],
        artifacts: [artifact]
    });
    const result = await syncMirror(env(bucket), { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW });
    assert.equal(result.ok, true);
    assert.equal(bucket.json('manifest.json').versions[0].tag, '2.0.0');
    assert(fixture.calls.some((url) => url.includes(`/git/trees/${PASS_COMMIT_NEW}`)));
    assert.equal(fixture.calls.some((url) => url.endsWith('/actions/artifacts/fixture/zip')), false);
}

async function testArtifactListFailureDoesNotBlockOfficialPipeline() {
    const bucket = new FakeR2();
    const fixture = createFixtureFetch({
        releases: [release('2.0.0', PASS_COMMIT_NEW)],
        failArtifacts: true
    });
    const result = await syncMirror(env(bucket), { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW });
    assert.equal(result.ok, true);
    assert.equal(bucket.json('manifest.json').versions[0].commit, PASS_COMMIT_NEW);
    assert.equal(bucket.records.has('_mirror/sync-error.json'), false);
}

async function testDerivedArtifactPrecheckFailuresBecomePending() {
    const patchRejectedBucket = new FakeR2();
    const patchRejectedFixture = createFixtureFetch({
        releases: [],
        artifacts: [await artifactSpec(REJECT_COMMIT, 0)]
    });
    const patchRejectedResult = await syncMirror(env(patchRejectedBucket), {
        fetchImpl: patchRejectedFixture.fetchImpl,
        now: () => FIXED_NOW
    });
    assert.equal(patchRejectedResult.ok, true);
    assert.equal(patchRejectedBucket.json('manifest.json').versions.length, 0);
    assert.equal(patchRejectedBucket.json('manifest.json').pending[0].reason, 'patch-rejected');
    assert.match(patchRejectedBucket.json('manifest.json').pending[0].detail, /artifact direct intake/);

    const incompleteBucket = new FakeR2();
    const incompleteFixture = createFixtureFetch({
        releases: [],
        artifacts: [await artifactSpec(PASS_COMMIT_NEW, 0, { omitPaths: ['index.html'] })]
    });
    const incompleteResult = await syncMirror(env(incompleteBucket), {
        fetchImpl: incompleteFixture.fetchImpl,
        now: () => FIXED_NOW
    });
    assert.equal(incompleteResult.ok, true);
    assert.equal(incompleteBucket.json('manifest.json').versions.length, 0);
    assert.equal(incompleteBucket.json('manifest.json').pending[0].reason, 'release-incomplete');
}

async function testArtifactDigestAndPathFailuresDoNotFallback() {
    const badDigestBucket = new FakeR2();
    const badDigest = await artifactSpec(PASS_COMMIT_NEW, 0, { digest: '0'.repeat(64) });
    const badDigestFixture = createFixtureFetch({ releases: [], artifacts: [badDigest] });
    const badDigestResult = await syncMirror(env(badDigestBucket), {
        fetchImpl: badDigestFixture.fetchImpl,
        now: () => FIXED_NOW
    });
    assert.equal(badDigestResult.ok, false);
    assert.equal(badDigestBucket.records.has('manifest.json'), false);
    assert(badDigestBucket.records.has('_mirror/sync-error.json'));
    assert.equal(badDigestFixture.calls.some((url) => url.includes('/git/trees/')), false);

    const badPathBucket = new FakeR2();
    const badPath = await artifactSpec(PASS_COMMIT_NEW, 0, {
        extraEntries: [{ path: '../escape.txt', bytes: 'bad' }]
    });
    const badPathFixture = createFixtureFetch({ releases: [], artifacts: [badPath] });
    const badPathResult = await syncMirror(env(badPathBucket), {
        fetchImpl: badPathFixture.fetchImpl,
        now: () => FIXED_NOW
    });
    assert.equal(badPathResult.ok, false);
    assert.equal(badPathBucket.records.has('manifest.json'), false);
    assert(badPathBucket.records.has('_mirror/sync-error.json'));
    assert.equal(badPathFixture.calls.some((url) => url.includes('/git/trees/')), false);

    for (const invalidPath of ['/absolute.txt', '']) {
        const bucket = new FakeR2();
        const artifact = await artifactSpec(PASS_COMMIT_NEW, 0, {
            extraEntries: [{ path: invalidPath, bytes: 'bad' }]
        });
        const fixture = createFixtureFetch({ releases: [], artifacts: [artifact] });
        const result = await syncMirror(env(bucket), { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW });
        assert.equal(result.ok, false, `accepted invalid TAR path: ${JSON.stringify(invalidPath)}`);
        assert(bucket.records.has('_mirror/sync-error.json'));
        assert.equal(fixture.calls.some((url) => url.includes('/git/trees/')), false);
    }
}

async function testArtifactUnavailableFallsBackToTree() {
    const bucket = new FakeR2();
    const artifact = await artifactSpec(PASS_COMMIT_NEW, 0, { downloadStatus: 403 });
    const fixture = createFixtureFetch({ releases: [], artifacts: [artifact] });
    const result = await syncMirror(env(bucket), { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW });
    assert.equal(result.ok, true);
    assert.equal(bucket.json('manifest.json').versions[0].tag, '0.0.0-0813');
    assert.match(fixture.webhooks[0].payload.detail, /fallback/);
    assert(fixture.calls.some((url) => url.includes(`/git/trees/${PASS_COMMIT_NEW}`)));
}

async function testArtifactMetadataFailureDoesNotFallback() {
    const bucket = new FakeR2();
    const artifact = await artifactSpec(PASS_COMMIT_NEW, 0);
    delete artifact.archive_download_url;
    const fixture = createFixtureFetch({ releases: [], artifacts: [artifact] });
    const result = await syncMirror(env(bucket), { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW });
    assert.equal(result.ok, false);
    assert(bucket.records.has('_mirror/sync-error.json'));
    assert.equal(fixture.calls.some((url) => url.includes(`/git/trees/${PASS_COMMIT_NEW}`)), false);
}

async function testArtifactOnReleaseCommitSweepsStaleDerived() {
    const bucket = new FakeR2();
    const derivedArtifact = await artifactSpec(PASS_COMMIT_OLD, 0);
    await syncMirror(env(bucket), {
        fetchImpl: createFixtureFetch({ releases: [], artifacts: [derivedArtifact] }).fetchImpl,
        now: () => FIXED_NOW
    });
    assert.equal(bucket.json('manifest.json').versions[0].tag, '0.0.0-0813');

    const releaseArtifact = await artifactSpec(PASS_COMMIT_NEW, 0);
    const fixture = createFixtureFetch({
        releases: [release('2.0.0', PASS_COMMIT_NEW)],
        artifacts: [releaseArtifact]
    });
    const result = await syncMirror(env(bucket), { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW + 1000 });
    assert.equal(result.ok, true);
    assert.deepEqual(
        bucket.json('manifest.json').versions.map((version) => version.tag),
        ['2.0.0'],
        'stale derived preview (different commit) survived a release-commit artifact round'
    );
}

async function testStaleDerivedDemotedWhenArtifactCheckUnavailable() {
    const bucket = new FakeR2();
    const derivedArtifact = await artifactSpec(PASS_COMMIT_OLD, 0);
    await syncMirror(env(bucket), {
        fetchImpl: createFixtureFetch({ releases: [], artifacts: [derivedArtifact] }).fetchImpl,
        now: () => FIXED_NOW
    });
    const fixture = createFixtureFetch({
        releases: [release('2.0.0', PASS_COMMIT_NEW)],
        failArtifacts: true
    });
    const result = await syncMirror(env(bucket), { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW + 1000 });
    assert.equal(result.ok, true);
    assert.deepEqual(
        bucket.json('manifest.json').versions.map((version) => version.tag),
        ['2.0.0', '0.0.0-0813'],
        'older derived preview must not outrank a newer release at versions[0]'
    );
}

async function testManualVersionDelete() {
    const bucket = new FakeR2();
    await runSync(bucket, { releases: [release('2.0.0', PASS_COMMIT_NEW)] });
    const snapshotKeys = bucket.keys(`snapshots/2.0.0/${PASS_COMMIT_NEW}/`);
    assert(snapshotKeys.length > 0);

    const badRequest = await workerFetch(
        adminRequest('/api/versions/delete', {
            method: 'POST',
            body: JSON.stringify({ tag: 'bad..tag', commit: PASS_COMMIT_NEW })
        }),
        adminEnv(bucket)
    );
    assert.equal(badRequest.status, 400);

    const missing = await workerFetch(
        adminRequest('/api/versions/delete', {
            method: 'POST',
            body: JSON.stringify({ tag: '9.9.9', commit: PASS_COMMIT_NEW })
        }),
        adminEnv(bucket)
    );
    assert.equal(missing.status, 404);

    const response = await workerFetch(
        adminRequest('/api/versions/delete', {
            method: 'POST',
            body: JSON.stringify({ tag: '2.0.0', commit: PASS_COMMIT_NEW })
        }),
        adminEnv(bucket)
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.deleted, { tag: '2.0.0', commit: PASS_COMMIT_NEW });
    assert.equal(result.snapshotsDeleted, snapshotKeys.length);
    const manifest = bucket.json('manifest.json');
    assert.deepEqual(manifest.versions, []);
    assert.deepEqual(bucket.keys(`snapshots/2.0.0/${PASS_COMMIT_NEW}/`), [],
        'manual delete must reclaim the version snapshot objects');
    assert(bucket.putCalls.some((call) => call.key === 'manifest.json' && call.onlyIf?.etagMatches !== undefined),
        'manual delete must commit the manifest with a CAS put');
}

async function testArtifactReleaseCommitPromotesDerivedVersion() {
    const bucket = new FakeR2();
    const artifact = await artifactSpec(PASS_COMMIT_NEW, 0);
    await syncMirror(env(bucket), {
        fetchImpl: createFixtureFetch({ releases: [], artifacts: [artifact] }).fetchImpl,
        now: () => FIXED_NOW
    });
    assert.equal(bucket.json('manifest.json').versions[0].tag, '0.0.0-0813');
    const fixture = createFixtureFetch({
        releases: [release('2.0.0', PASS_COMMIT_NEW)],
        artifacts: [artifact]
    });
    const result = await syncMirror(env(bucket), { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW });
    assert.equal(result.ok, true);
    const manifest = bucket.json('manifest.json');
    assert.equal(manifest.versions.length, 1);
    assert.equal(manifest.versions[0].tag, '2.0.0');
    assert.equal(manifest.versions[0].commit, PASS_COMMIT_NEW);
    assert.equal(manifest.versions.some((version) => version.tag === '0.0.0-0813'), false);
}

async function testArtifactSameDayConflictUsesTimeSuffix() {
    const bucket = new FakeR2();
    const firstArtifact = await artifactSpec(PASS_COMMIT_NEW, 0, {
        created_at: '2026-08-13T14:44:42Z'
    });
    const firstFixture = createFixtureFetch({ releases: [], artifacts: [firstArtifact] });
    const firstResult = await syncMirror(env(bucket), { fetchImpl: firstFixture.fetchImpl, now: () => FIXED_NOW });
    assert.equal(firstResult.ok, true);
    assert.equal(bucket.json('manifest.json').versions[0]?.tag, '0.0.0-0813');
    const secondArtifact = await artifactSpec(PASS_COMMIT_OLD, 8, {
        created_at: '2026-08-13T15:01:00Z'
    });
    const secondFixture = createFixtureFetch({ releases: [], artifacts: [secondArtifact] });
    const result = await syncMirror(env(bucket), { fetchImpl: secondFixture.fetchImpl, now: () => FIXED_NOW });
    assert.equal(result.ok, true);
    const versions = bucket.json('manifest.json').versions;
    assert.equal(versions[0].tag, '0.0.0-0813-2301');
    assert.equal(versions[0].commit, PASS_COMMIT_OLD);
    assert.equal(versions.some((version) => version.tag === '0.0.0-0813'), false);
}

async function testExpiredArtifactFallsBackToTree() {
    const bucket = new FakeR2();
    const artifact = await artifactSpec(PASS_COMMIT_NEW, 0, { expired: true });
    const fixture = createFixtureFetch({ releases: [], artifacts: [artifact] });
    const result = await syncMirror(env(bucket), { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW });
    assert.equal(result.ok, true);
    assert.equal(bucket.json('manifest.json').versions[0].commit, PASS_COMMIT_NEW);
    assert.match(fixture.webhooks[0].payload.detail, /fallback/);
    assert.equal(fixture.calls.some((url) => url.endsWith('/actions/artifacts/fixture/zip')), false);
}

async function testSnapshotBudgetSpreadsBuildsAcrossRounds() {
    const bucket = new FakeR2();
    const state = {
        releases: [release('2.0.0', PASS_COMMIT_NEW), release('1.9.8', PASS_COMMIT_OLD)]
    };
    const fixture = createFixtureFetch(state);
    const options = { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW };
    const first = await syncMirror(env(bucket), options);
    assert.equal(first.ok, true);
    assert.deepEqual(first.snapshotBudget, { used: 1, limit: 1, deferred: true });
    const progressAfterFirst = bucket.json('_mirror/sync-progress.json');
    assert.equal(progressAfterFirst.state, 'done');
    assert(progressAfterFirst.step > 0);
    assert.match(progressAfterFirst.phase, /待回填/);
    const firstManifest = bucket.json('manifest.json');
    assert.equal(firstManifest.versions.length, 1);
    assert.equal(firstManifest.versions[0].tag, '2.0.0');
    assert.deepEqual(firstManifest.pending, [], 'deferred release must not be marked pending');
    assert.equal(bucket.keys(`snapshots/1.9.8/${PASS_COMMIT_OLD}/`).length, 0);

    const second = await syncMirror(env(bucket), options);
    assert.equal(second.ok, true);
    assert.deepEqual(second.snapshotBudget, { used: 1, limit: 1, deferred: false });
    const secondManifest = bucket.json('manifest.json');
    assert.equal(secondManifest.versions.length, 2);
    assert.deepEqual(secondManifest.versions.map((version) => version.tag), ['2.0.0', '1.9.8']);
    assert(bucket.keys(`snapshots/1.9.8/${PASS_COMMIT_OLD}/`).length > 0);

    const third = await syncMirror(env(bucket), options);
    assert.equal(third.ok, true);
    assert.deepEqual(third.snapshotBudget, { used: 0, limit: 1, deferred: false });
    assert.equal(third.changed, false);
}

async function testSnapshotBudgetDefersTreeFallbackNotZipIntake() {
    const bucket = new FakeR2();
    const expiredArtifact = await artifactSpec(PASS_COMMIT_NEW, 0, { expired: true });
    const treeState = {
        releases: [release('1.9.8', PASS_COMMIT_OLD)],
        artifacts: [expiredArtifact]
    };
    const treeFixture = createFixtureFetch(treeState);
    const options = { fetchImpl: treeFixture.fetchImpl, now: () => FIXED_NOW };
    const first = await syncMirror(env(bucket), options);
    assert.equal(first.ok, true);
    assert.deepEqual(first.snapshotBudget, { used: 1, limit: 1, deferred: true });
    const firstManifest = bucket.json('manifest.json');
    assert.deepEqual(firstManifest.versions.map((version) => version.tag), ['1.9.8'],
        'release build must win the round budget over the derived tree fallback');
    const second = await syncMirror(env(bucket), options);
    assert.equal(second.ok, true);
    assert.deepEqual(second.snapshotBudget, { used: 1, limit: 1, deferred: false });
    assert.deepEqual(bucket.json('manifest.json').versions.map((version) => version.tag), ['1.9.8-0813', '1.9.8']);

    const zipBucket = new FakeR2();
    const zipState = {
        releases: [release('1.9.8', PASS_COMMIT_OLD)],
        artifacts: [await artifactSpec(PASS_COMMIT_NEW, 0)]
    };
    const zipFixture = createFixtureFetch(zipState);
    const zipResult = await syncMirror(env(zipBucket), { fetchImpl: zipFixture.fetchImpl, now: () => FIXED_NOW });
    assert.equal(zipResult.ok, true);
    assert.deepEqual(zipResult.snapshotBudget, { used: 1, limit: 1, deferred: false });
    assert.deepEqual(zipBucket.json('manifest.json').versions.map((version) => version.tag), ['1.9.8-0813', '1.9.8'],
        'zip intake is not tree-metered and must land in the same round as one release build');
}

async function testSyncErrorWebhookIsDeduplicated() {
    const bucket = new FakeR2();
    const state = { releases: [], failReleases: true };
    const fixture = createFixtureFetch(state);
    const options = { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW };
    const first = await syncMirror(env(bucket), options);
    const second = await syncMirror(env(bucket), options);
    assert.equal(first.ok, false);
    assert.equal(first.notified, true);
    assert.equal(second.ok, false);
    assert.equal(second.notified, false);
    assert.equal(fixture.webhooks.filter((item) => item.payload.event === 'sync_error').length, 1);
    assert(bucket.records.has('_mirror/sync-error.json'));
    assert.equal(bucket.records.has('manifest.json'), false);
}

function authRouteCase(pathname) {
    const bucket = new FakeR2();
    const fixture = createFixtureFetch({ releases: [release('2.0.0', PASS_COMMIT_NEW)] });
    if (pathname === '/api/pending/retry') {
        bucket.seedJson('manifest.json', {
            schema: 1,
            updatedAt: FIXED_NOW,
            upstreamRepo: 'STA1N156/RP-Hub',
            versions: [],
            pending: [{
                tag: '2.0.0',
                commit: PASS_COMMIT_NEW,
                reason: 'release-incomplete',
                detail: 'fixture pending',
                seenAt: FIXED_NOW
            }]
        });
    }
    if (pathname === '/api/versions/delete') {
        bucket.seedJson('manifest.json', {
            schema: 1,
            updatedAt: FIXED_NOW,
            upstreamRepo: 'STA1N156/RP-Hub',
            versions: [{
                tag: '2.0.0',
                commit: PASS_COMMIT_NEW,
                name: '2.0.0',
                date: '2026-08-12T00:00:00Z',
                precheckPatchRevision: RP_HUB_APP_PATCH_REVISION,
                publishedAt: FIXED_NOW,
                files: [{ path: 'index.html', sha256: '0'.repeat(64), size: 1 }]
            }],
            pending: []
        });
    }
    const request = (token) => {
        if (pathname === '/api/config') {
            return adminRequest(pathname, {
                method: 'PUT',
                body: JSON.stringify({ releaseLimit: 6, webhookEnabled: true })
            }, token);
        }
        if (pathname === '/api/pending/retry' || pathname === '/api/versions/delete') {
            return adminRequest(pathname, {
                method: 'POST',
                body: JSON.stringify({ tag: '2.0.0', commit: PASS_COMMIT_NEW })
            }, token);
        }
        return adminRequest(pathname, { method: 'POST' }, token);
    };
    return { bucket, fixture, request };
}

async function testWriteAuthenticationMatrix() {
    const routes = ['/api/sync', '/api/pending/retry', '/api/versions/delete', '/api/webhook-test', '/api/config'];
    for (const pathname of routes) {
        {
            const { bucket, fixture, request } = authRouteCase(pathname);
            const response = await workerFetch(request(null), env(bucket), fixture);
            assert.equal(response.status, 403, `${pathname} allowed writes without ADMIN_TOKEN configured`);
            assert.match((await response.json()).error, /ADMIN_TOKEN/);
        }
        {
            const { bucket, fixture, request } = authRouteCase(pathname);
            const response = await workerFetch(request('wrong-token'), adminEnv(bucket), fixture);
            assert.equal(response.status, 403, `${pathname} accepted a wrong bearer token`);
        }
        {
            const { bucket, fixture, request } = authRouteCase(pathname);
            const response = await workerFetch(request('fixture-admin-token'), adminEnv(bucket), fixture);
            assert.equal(response.status, 200, `${pathname} rejected the configured bearer token`);
        }
    }
}

async function testStatusAndConsoleEscapeSecrets() {
    const bucket = new FakeR2();
    const secretValues = {
        GITHUB_TOKEN: 'github-secret-value',
        WEBHOOK_URL: 'https://webhook.test/private-secret-path',
        WEBHOOK_TOKEN: 'webhook-secret-value',
        ADMIN_TOKEN: 'admin-secret-value'
    };
    bucket.seedJson('manifest.json', {
        schema: 1,
        updatedAt: FIXED_NOW,
        upstreamRepo: 'STA1N156/RP-Hub',
        versions: [{
            tag: '<img src=x onerror=alert(1)>',
            commit: `abc${secretValues.ADMIN_TOKEN}`,
            publishedAt: FIXED_NOW,
            files: [{ path: 'index.html' }]
        }],
        pending: [{
            tag: 'bad" data-break="yes',
            commit: REJECT_COMMIT,
            reason: '<script>alert(2)</script>',
            detail: `unsafe & ${secretValues.GITHUB_TOKEN}`,
            seenAt: FIXED_NOW
        }, {
            tag: '<script>alert(3)</script>',
            commit: PASS_COMMIT_NEW,
            reason: 'patch-rejected',
            detail: 'fixture patch rejection',
            seenAt: FIXED_NOW
        }, {
            tag: 'incomplete-release',
            commit: PASS_COMMIT_OLD,
            reason: 'release-incomplete',
            detail: 'fixture incomplete release',
            seenAt: FIXED_NOW
        }]
    });
    bucket.seedJson('_mirror/sync-error.json', { fingerprint: secretValues.WEBHOOK_TOKEN, at: FIXED_NOW });
    const workerEnv = adminEnv(bucket, {
        ...secretValues,
        UPSTREAM_REPO: '<b>STA1N156/RP-Hub</b>'
    });

    const statusResponse = await workerFetch(new Request('https://publisher.test/api/status'), workerEnv);
    assert.equal(statusResponse.status, 200);
    const statusText = await statusResponse.text();
    for (const value of Object.values(secretValues)) assert.equal(statusText.includes(value), false);
    for (const name of Object.keys(secretValues)) assert.equal(statusText.includes(name), false);
    const status = JSON.parse(statusText);
    assert.deepEqual(Object.keys(status.secrets), ['github', 'webhook', 'webhookAuth', 'admin']);
    assert(Object.values(status.secrets).every((value) => typeof value === 'boolean' && value));
    assert.deepEqual(Object.keys(status.manifest.versions[0]), ['tag', 'commit', 'publishedAt', 'fileCount']);
    assert.deepEqual(Object.keys(status.manifest.pending[0]), ['tag', 'commit', 'reason', 'detail', 'seenAt']);
    assert.equal(status.config.releaseLimit, 12);
    assert.equal(status.config.webhookEnabled, true);
    assert.equal(status.RP_HUB_APP_PATCH_REVISION, RP_HUB_APP_PATCH_REVISION);

    const htmlResponse = await workerFetch(new Request('https://publisher.test/admin'), workerEnv);
    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await htmlResponse.text();
    for (const value of Object.values(secretValues)) assert.equal(html.includes(value), false);
    assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
    assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.equal(html.includes('<script>alert(2)</script>'), false);
    assert(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
    assert(html.includes('&lt;b&gt;STA1N156/RP-Hub&lt;/b&gt;'));
    assert.equal(/https?:\/\/[^\s"']*(github-secret-value|webhook-secret-value|admin-secret-value)/.test(html), false);

    const publicResponse = await workerFetch(new Request('https://publisher.test/'), workerEnv);
    assert.equal(publicResponse.status, 200);
    assert.match(publicResponse.headers.get('content-security-policy'), /default-src 'none'/);
    const publicHtml = await publicResponse.text();
    assert(publicHtml.includes('可更新版本'));
    assert(publicHtml.includes('适配未通过，等待维护'));
    assert(publicHtml.includes('上游发布内容不完整'));
    assert(publicHtml.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert(publicHtml.includes('&lt;script&gt;alert(2)&lt;/script&gt;') || !publicHtml.includes('<script>alert(2)</script>'));
    assert.equal(/<script\b/i.test(publicHtml), false);
    for (const forbidden of ['config', 'secrets', '管理员令牌', '运行时配置', 'Webhook']) {
        assert.equal(publicHtml.toLowerCase().includes(forbidden.toLowerCase()), false, `public page leaked ${forbidden}`);
    }
    const redirect = await workerFetch(new Request('https://publisher.test/index.html'), workerEnv);
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/');
}

async function testPublicMirrorRoutes() {
    const bucket = new FakeR2();
    const manifestBytes = '{"schema":1,"versions":[],"pending":[]}';
    const snapshotBytes = new Uint8Array([0, 1, 2, 255, 10, 13]);
    bucket.seedText('manifest.json', manifestBytes);
    bucket.seedText('snapshots/v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin.dat', snapshotBytes, {
        contentType: 'application/x-test'
    });
    bucket.seedText('_mirror/config.json', '{"releaseLimit":12}');
    const workerEnv = adminEnv(bucket);

    const manifest = await workerFetch(new Request('https://publisher.test/manifest.json'), workerEnv);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(manifest.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(await manifest.text(), manifestBytes);

    const snapshot = await workerFetch(new Request('https://publisher.test/snapshots/v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin.dat'), workerEnv);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.headers.get('cache-control'), 'public, max-age=86400, immutable');
    assert.equal(snapshot.headers.get('content-type'), 'application/x-test');
    assert.deepEqual(new Uint8Array(await snapshot.arrayBuffer()), snapshotBytes);

    const missing = await workerFetch(new Request('https://publisher.test/manifest.json?missing=1'), { MIRROR_BUCKET: new FakeR2() });
    assert.equal(missing.status, 404);
    for (const pathname of [
        '/snapshots/%252e%252e/manifest.json',
        '/snapshots/%2e%2e/x',
        '/snapshots//x',
        '/_mirror/config.json',
        '/_mirror/sync-error.json',
        '/other'
    ]) {
        const response = await workerFetch(new Request(`https://publisher.test${pathname}`), workerEnv);
        assert.equal(response.status, 404, pathname);
    }
    const rawTraversal = await workerFetch({
        method: 'GET',
        url: 'https://publisher.test/snapshots/../manifest.json',
        headers: new Headers()
    }, workerEnv);
    assert.equal(rawTraversal.status, 404);
}

async function testManualSyncUsesPublisherSyncPath() {
    const bucket = new FakeR2();
    const fixture = createFixtureFetch({ releases: [release('2.0.0', PASS_COMMIT_NEW)] });
    const response = await workerFetch(
        adminRequest('/api/sync', { method: 'POST' }),
        adminEnv(bucket),
        fixture
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.events, ['version_published']);
    assert.equal(bucket.json('manifest.json').versions[0].commit, PASS_COMMIT_NEW);
    assert(fixture.calls.some((url) => url.includes('/releases?per_page=12')));
    assert(fixture.calls.some((url) => url.includes(`/git/trees/${PASS_COMMIT_NEW}`)));
}

async function testPendingRetryReallyRetries() {
    const bucket = new FakeR2();
    await runSync(bucket, {
        releases: [release('retry-me', PASS_COMMIT_NEW)],
        treeTransform(commit, tree) {
            assert.equal(commit, PASS_COMMIT_NEW);
            return tree.filter((entry) => entry.path !== 'index.html');
        }
    });
    assert.equal(bucket.json('manifest.json').pending.length, 1);

    const fixture = createFixtureFetch({ releases: [release('retry-me', PASS_COMMIT_NEW)] });
    const response = await workerFetch(
        adminRequest('/api/pending/retry', {
            method: 'POST',
            body: JSON.stringify({ tag: 'retry-me', commit: PASS_COMMIT_NEW })
        }),
        adminEnv(bucket),
        fixture
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.removed, true);
    assert.equal(result.sync.ok, true);
    assert.deepEqual(result.sync.events, ['version_published']);
    const manifest = bucket.json('manifest.json');
    assert.equal(manifest.pending.length, 0);
    assert.equal(manifest.versions[0].commit, PASS_COMMIT_NEW);
    assert(fixture.calls.some((url) => url.includes(`/git/trees/${PASS_COMMIT_NEW}`)), 'retry skipped the pending pair');
    assert(bucket.records.has(`snapshots/retry-me/${PASS_COMMIT_NEW}/index.html`));
}

async function testRuntimeConfigClampFailSoftAndWebhookDisable() {
    const bucket = new FakeR2();
    let response = await workerFetch(
        adminRequest('/api/config', {
            method: 'PUT',
            body: JSON.stringify({ releaseLimit: 0, webhookEnabled: true })
        }),
        adminEnv(bucket)
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).config.releaseLimit, 1);

    response = await workerFetch(
        adminRequest('/api/config', {
            method: 'PUT',
            body: JSON.stringify({ releaseLimit: 13 })
        }),
        adminEnv(bucket)
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).config, { releaseLimit: 12, webhookEnabled: true });
    assert.deepEqual(bucket.json('_mirror/config.json'), { releaseLimit: 12, webhookEnabled: true });

    response = await workerFetch(
        adminRequest('/api/config', {
            method: 'PUT',
            body: JSON.stringify({ releaseLimit: '8', upstreamRepo: 'forbidden/repo' })
        }),
        adminEnv(bucket)
    );
    assert.equal(response.status, 400);

    const invalidBucket = new FakeR2();
    invalidBucket.seedText('_mirror/config.json', '{invalid json');
    const invalidFixture = createFixtureFetch({ releases: [] });
    const invalidResult = await syncMirror({ ...env(invalidBucket), RELEASE_LIMIT: '3' }, {
        fetchImpl: invalidFixture.fetchImpl,
        now: () => FIXED_NOW
    });
    assert.equal(invalidResult.ok, true);
    assert(invalidFixture.calls.some((url) => url.includes('/releases?per_page=3')));

    const readFailureBucket = new FakeR2();
    const baseGet = readFailureBucket.get.bind(readFailureBucket);
    readFailureBucket.get = async (key) => {
        if (key === '_mirror/config.json') throw new Error('fixture R2 config read failure');
        return await baseGet(key);
    };
    const readFailureFixture = createFixtureFetch({ releases: [] });
    const readFailureResult = await syncMirror({ ...env(readFailureBucket), RELEASE_LIMIT: '4' }, {
        fetchImpl: readFailureFixture.fetchImpl,
        now: () => FIXED_NOW
    });
    assert.equal(readFailureResult.ok, true);
    assert(readFailureFixture.calls.some((url) => url.includes('/releases?per_page=4')));

    const disabledBucket = new FakeR2();
    disabledBucket.seedJson('_mirror/config.json', { releaseLimit: 12, webhookEnabled: false });
    const disabledFixture = createFixtureFetch({ releases: [release('2.0.0', PASS_COMMIT_NEW)] });
    const disabledResult = await syncMirror(env(disabledBucket), {
        fetchImpl: disabledFixture.fetchImpl,
        now: () => FIXED_NOW
    });
    assert.equal(disabledResult.ok, true);
    assert.equal(disabledFixture.webhooks.length, 0);

    const disabledErrorBucket = new FakeR2();
    disabledErrorBucket.seedJson('_mirror/config.json', { releaseLimit: 12, webhookEnabled: false });
    const disabledErrorFixture = createFixtureFetch({ releases: [], failReleases: true });
    const disabledErrorResult = await syncMirror(env(disabledErrorBucket), {
        fetchImpl: disabledErrorFixture.fetchImpl,
        now: () => FIXED_NOW
    });
    assert.equal(disabledErrorResult.ok, false);
    assert.equal(disabledErrorResult.notified, false);
    assert.equal(disabledErrorFixture.webhooks.length, 0);
}

async function testSecretRedactionInErrorsAndLogs() {
    const bucket = new FakeR2();
    const workerEnv = adminEnv(bucket, {
        GITHUB_TOKEN: 'log-secret-value',
        WEBHOOK_URL: 'https://webhook.test/log-secret-url',
        WEBHOOK_TOKEN: 'log-webhook-secret'
    });
    const fixture = createFixtureFetch({
        releases: [],
        failReleases: true,
        failReleaseBody: 'failure log-secret-value https://webhook.test/log-secret-url log-webhook-secret fixture-admin-token'
    });
    const logged = [];
    const previousError = console.error;
    console.error = (value) => logged.push(String(value));
    try {
        const result = await syncMirror(workerEnv, { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW });
        assert.equal(result.ok, false);
        const storedError = bucket.json('_mirror/sync-error.json');
        assert.equal(typeof storedError.detail, 'string');
        assert(storedError.detail.length > 0, 'sync-error state must carry the error detail for /admin');
        const storedProgress = bucket.json('_mirror/sync-progress.json');
        assert.equal(storedProgress.state, 'error');
        const statusResponse = await workerFetch(new Request('https://publisher.test/api/status'), workerEnv);
        const statusPayload = await statusResponse.json();
        assert.equal(typeof statusPayload.syncError.detail, 'string');
        assert(statusPayload.syncError.detail.length > 0, 'status must expose the sync error detail');
        const combined = `${JSON.stringify(result)}\n${logged.join('\n')}\n${JSON.stringify(storedError)}\n${JSON.stringify(statusPayload)}`;
        for (const secret of [workerEnv.GITHUB_TOKEN, workerEnv.WEBHOOK_URL, workerEnv.WEBHOOK_TOKEN, workerEnv.ADMIN_TOKEN]) {
            assert.equal(combined.includes(secret), false);
        }
    } finally {
        console.error = previousError;
    }
}

const ANNOUNCEMENT_SOURCE_PATH = 'assets/js/built-in-content.js';

function builtInContentJs({ id = 10195, title = '网站公告', content }) {
    return `window.RPHubLatestUpdate = Object.freeze({ id: ${id}, title: '${title}', content: \`${content}\` });\n`;
}

function realShapeAnnouncementFixture() {
    const content = [
        '## RP-Hub 1.8.2 更新公告',
        '',
        '- 新增各版本公告提取与查询',
        '- 优化镜像同步日志',
        '',
        '**注意**：升级前请先备份存档。',
        ''
    ].join('\n');
    return { source: builtInContentJs({ id: 10195, title: '网站公告', content }), id: 10195, title: '网站公告', content };
}

async function testAnnouncementExtractedForPublishedVersion() {
    const bucket = new FakeR2();
    const { result } = await runSync(bucket, { releases: [release('2.0.0', PASS_COMMIT_NEW, 'RP-Hub 2.0.0')] });
    assert.equal(result.ok, true);
    assert.deepEqual(
        Object.keys(result).sort(),
        ['changed', 'events', 'ok', 'pendingCount', 'snapshotBudget', 'versionCount'],
        'announcement generation must not alter the sync return shape'
    );
    assert.equal(bucket.records.has('manifest.json'), true);
    const announcements = bucket.json('_mirror/announcements.json');
    assert.equal(announcements.generatedAt, FIXED_NOW);
    assert.equal(announcements.entries.length, 1);
    const entry = announcements.entries[0];
    assert.deepEqual({ tag: entry.tag, commit: entry.commit }, { tag: '2.0.0', commit: PASS_COMMIT_NEW });
    assert.equal(entry.reason, undefined);
    assert.deepEqual(Object.keys(entry.announcement), ['id', 'title', 'content']);
    assert.equal(entry.announcement.id, 10217, 'real 2.0.0 upstream bytes must yield its announcement id');
    assert.equal(entry.announcement.title, '网站公告');
    assert(entry.announcement.content.includes('### RP-Hub 2.0.0'));
    assert(entry.announcement.content.includes('\n'), 'markdown content must keep raw newlines');
    assert(entry.announcement.content.includes('#### 更新时间：10/09/12:19'));
}

async function testAnnouncementFailSoftShapes() {
    const good = realShapeAnnouncementFixture();
    const cases = [
        {
            name: 'real-shape fixture keeps markdown verbatim',
            source: good.source,
            expect: { announcement: { id: good.id, title: good.title, content: good.content } }
        },
        {
            name: 'template interpolation is parse-failed',
            source: builtInContentJs({ content: '第一行\n价格是 ${price} 元\n最后一行' }),
            expect: { announcement: null, reason: 'parse-failed' }
        },
        {
            name: 'malformed object is parse-failed',
            source: 'window.RPHubLatestUpdate = Object.freeze({\n    id: 7,\n    body: "no title field"\n});\n',
            expect: { announcement: null, reason: 'parse-failed' }
        },
        {
            name: 'missing anchor is not-found',
            source: 'window.RPHubLatestUpdate=Object.freeze({id:8,title:\'x\',content:`y`});\n',
            expect: { announcement: null, reason: 'not-found' }
        }
    ];
    for (const item of cases) {
        const bucket = new FakeR2();
        const artifact = await artifactSpec(PASS_COMMIT_OLD, 0, {
            extraEntries: [{ path: ANNOUNCEMENT_SOURCE_PATH, bytes: item.source }]
        });
        const fixture = createFixtureFetch({ releases: [], artifacts: [artifact] });
        const result = await syncMirror(env(bucket), { fetchImpl: fixture.fetchImpl, now: () => FIXED_NOW });
        assert.equal(result.ok, true, `${item.name}: sync must stay ok`);
        assert.equal(result.versionCount, 1, item.name);
        assert.deepEqual(result.events, ['version_published'], `${item.name}: sync events must be unaffected`);
        const announcements = bucket.json('_mirror/announcements.json');
        assert.equal(announcements.entries.length, 1, item.name);
        const entry = announcements.entries[0];
        assert.equal(entry.tag, '0.0.0-0813', item.name);
        if (item.expect.announcement) {
            assert.deepEqual(entry.announcement, item.expect.announcement, item.name);
            assert.equal(entry.reason, undefined, item.name);
        } else {
            assert.equal(entry.announcement, null, item.name);
            assert.equal(entry.reason, item.expect.reason, item.name);
        }
    }

    // 1.7.x-style snapshot: no built-in-content.js at all.
    const noFileBucket = new FakeR2();
    const noFileArtifact = await artifactSpec(PASS_COMMIT_OLD, 0, { omitPaths: [ANNOUNCEMENT_SOURCE_PATH] });
    const result = await syncMirror(env(noFileBucket), {
        fetchImpl: createFixtureFetch({ releases: [], artifacts: [noFileArtifact] }).fetchImpl,
        now: () => FIXED_NOW
    });
    assert.equal(result.ok, true);
    assert.equal(result.versionCount, 1);
    const announcements = noFileBucket.json('_mirror/announcements.json');
    assert.equal(announcements.entries.length, 1);
    assert.equal(announcements.entries[0].announcement, null);
    assert.equal(announcements.entries[0].reason, 'not-found');
}

async function testAnnouncementsMirrorManifestAndDelete() {
    const bucket = new FakeR2();
    bucket.seedJson('manifest.json', {
        schema: 1,
        updatedAt: FIXED_NOW,
        upstreamRepo: 'STA1N156/RP-Hub',
        versions: [
            { tag: '2.0.0', commit: PASS_COMMIT_NEW, name: '2.0.0', date: '', publishedAt: FIXED_NOW, files: [] },
            { tag: '1.9.8', commit: PASS_COMMIT_OLD, name: '1.9.8', date: '', publishedAt: FIXED_NOW - 1, files: [] }
        ],
        pending: []
    });
    bucket.seedText(
        `snapshots/2.0.0/${PASS_COMMIT_NEW}/${ANNOUNCEMENT_SOURCE_PATH}`,
        'window.RPHubLatestUpdate = Object.freeze({\n    id: 10165,\n    title: \'网站公告\',\n    content: `正文A`\n});\n'
    );
    bucket.seedText(`snapshots/1.9.8/${PASS_COMMIT_OLD}/${ANNOUNCEMENT_SOURCE_PATH}`, 'const legacy = 1;\n');
    const { result } = await runSync(bucket, {
        releases: [release('2.0.0', PASS_COMMIT_NEW), release('1.9.8', PASS_COMMIT_OLD)]
    });
    assert.equal(result.ok, true);
    assert.equal(result.versionCount, 2);
    const announcements = bucket.json('_mirror/announcements.json');
    assert.deepEqual(
        announcements.entries.map((entry) => [entry.tag, entry.commit]),
        [['2.0.0', PASS_COMMIT_NEW], ['1.9.8', PASS_COMMIT_OLD]],
        'entries must cover manifest versions one-to-one, in manifest order'
    );
    assert.equal(announcements.entries[0].announcement.id, 10165);
    assert.equal(announcements.entries[1].announcement, null);
    assert.equal(announcements.entries[1].reason, 'not-found');

    const response = await workerFetch(
        adminRequest('/api/versions/delete', {
            method: 'POST',
            body: JSON.stringify({ tag: '2.0.0', commit: PASS_COMMIT_NEW })
        }),
        adminEnv(bucket)
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    const after = bucket.json('_mirror/announcements.json');
    assert.deepEqual(
        after.entries.map((entry) => entry.tag),
        ['1.9.8'],
        'deleted version must leave the announcement index'
    );
}

async function testAnnouncementsPublicRoutes() {
    const bucket = new FakeR2();
    const workerEnv = adminEnv(bucket);
    const missing = await workerFetch(new Request('https://publisher.test/announcements.json'), workerEnv);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /同步/, '404 body must tell the operator to sync first');
    const missingFiltered = await workerFetch(new Request('https://publisher.test/announcements.json?tag=2.0.0'), workerEnv);
    assert.equal(missingFiltered.status, 404);

    const payload = JSON.stringify({
        generatedAt: FIXED_NOW,
        entries: [
            { tag: '2.0.0', commit: PASS_COMMIT_NEW, announcement: { id: 10195, title: '网站公告', content: '正文' } },
            { tag: '1.9.8', commit: PASS_COMMIT_OLD, announcement: null, reason: 'not-found' }
        ]
    });
    bucket.seedText('_mirror/announcements.json', payload);
    const full = await workerFetch(new Request('https://publisher.test/announcements.json'), workerEnv);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(full.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(await full.text(), payload, 'route must stream the sidecar object verbatim');

    const filtered = await workerFetch(new Request('https://publisher.test/announcements.json?tag=2.0.0'), workerEnv);
    assert.equal(filtered.status, 200);
    const filteredValue = await filtered.json();
    assert.equal(filteredValue.generatedAt, FIXED_NOW);
    assert.deepEqual(filteredValue.entries.map((entry) => entry.tag), ['2.0.0']);
    assert.equal(filteredValue.entries[0].announcement.id, 10195);

    const none = await workerFetch(new Request('https://publisher.test/announcements.json?tag=9.9.9'), workerEnv);
    assert.equal(none.status, 200);
    assert.deepEqual((await none.json()).entries, []);

    const direct = await workerFetch(new Request('https://publisher.test/_mirror/announcements.json'), workerEnv);
    assert.equal(direct.status, 404, '_mirror/ prefix must stay unreachable');
}

async function testAdminAnnouncementExpansionUsesPlainText() {
    const bucket = new FakeR2();
    const response = await workerFetch(new Request('https://publisher.test/admin'), adminEnv(bucket));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert(html.includes('id="announcementPanel"'), 'admin console lacks the announcement panel');
    assert(html.includes('show-announcement'), 'admin version rows lack the announcement toggle');
    const bindSource = html.match(/function bindAnnouncements\(\)\{[\s\S]*?\n/);
    assert(bindSource, 'bindAnnouncements implementation not found in admin page');
    const source = bindSource[0];
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
        assert.equal(source.includes(forbidden), false, `announcement expansion used ${forbidden}`);
    }
    assert(source.includes('.textContent'), 'announcement expansion must render via textContent');
    assert(source.includes("'/announcements.json?tag='"), 'announcement expansion must read the public route');
}

await testNewVersionAndWebhookFailure();
await testRetagPassSwitchesCommit();
await testRetagRejectKeepsOldCommit();
await testReleaseIncompleteGoesPending();
await testArtifactDirectIntakeStoredAndDeflated();
await testArtifactSelectionUsesNewestActiveCreatedAt();
await testArtifactReleaseCommitUsesOfficialTreePipeline();
await testArtifactListFailureDoesNotBlockOfficialPipeline();
await testDerivedArtifactPrecheckFailuresBecomePending();
await testArtifactDigestAndPathFailuresDoNotFallback();
await testArtifactUnavailableFallsBackToTree();
await testArtifactMetadataFailureDoesNotFallback();
await testArtifactOnReleaseCommitSweepsStaleDerived();
await testStaleDerivedDemotedWhenArtifactCheckUnavailable();
await testManualVersionDelete();
await testArtifactReleaseCommitPromotesDerivedVersion();
await testArtifactSameDayConflictUsesTimeSuffix();
await testExpiredArtifactFallsBackToTree();
await testSnapshotBudgetSpreadsBuildsAcrossRounds();
await testSnapshotBudgetDefersTreeFallbackNotZipIntake();
await testSyncErrorWebhookIsDeduplicated();
await testWriteAuthenticationMatrix();
await testStatusAndConsoleEscapeSecrets();
await testPublicMirrorRoutes();
await testManualSyncUsesPublisherSyncPath();
await testPendingRetryReallyRetries();
await testRuntimeConfigClampFailSoftAndWebhookDisable();
await testSecretRedactionInErrorsAndLogs();
await testAnnouncementExtractedForPublishedVersion();
await testAnnouncementFailSoftShapes();
await testAnnouncementsMirrorManifestAndDelete();
await testAnnouncementsPublicRoutes();
await testAdminAnnouncementExpansionUsesPlainText();

console.log('mirror-worker.test.mjs: publish, retag, derived cleanup, version delete, pending retry, auth, config, console, webhook, announcements, and schema assertions passed');
