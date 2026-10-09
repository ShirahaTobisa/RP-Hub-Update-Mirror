import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FakeR2 } from './r2.mjs';
import mirrorWorker, { syncTestReleases } from '../worker.mjs';

const REPO = 'ShirahaTobisa/RP-Hub';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function bundleFor(tag, overrides = {}) {
    return new TextEncoder().encode(JSON.stringify({
        format: 'rph-release-bundle-v1',
        version: tag,
        worker: `export default { fetch() { return new Response('${tag}'); } };`,
        assets: [{ path: 'index.html', base64: Buffer.from(`<h1>${tag}</h1>`).toString('base64') }],
        ...overrides
    }));
}

// 模拟 GitHub：releases 列表 + 附件下载；记录每个附件被下载了几次。
function fakeGitHub(releases, files) {
    const downloads = new Map();
    const fetchImpl = async (url) => {
        const href = String(url);
        if (href === `https://api.github.com/repos/${REPO}/releases?per_page=30`) return Response.json(releases);
        if (files.has(href)) {
            downloads.set(href, (downloads.get(href) || 0) + 1);
            return new Response(files.get(href));
        }
        return new Response('missing', { status: 404 });
    };
    return { fetchImpl, downloads };
}

function release(tag, id, { bundle = bundleFor(tag), zip = new Uint8Array([80, 75, 3, 4, id]), notes = `更新说明 ${tag}` } = {}) {
    const bundleUrl = `https://api.github.com/assets/${id}1`;
    const zipUrl = `https://api.github.com/assets/${id}2`;
    return {
        entry: {
            tag_name: tag, name: `测试版 ${tag}`, body: notes, draft: false, published_at: '2026-10-09T00:00:00Z',
            assets: [
                { id: id * 10 + 1, name: `rph-bundle-${tag}.json`, size: bundle.byteLength, url: bundleUrl },
                { id: id * 10 + 2, name: `RP-Hub-${tag}.zip`, size: zip.byteLength, url: zipUrl }
            ]
        },
        files: [[bundleUrl, bundle], [zipUrl, zip]]
    };
}

const env = { MIRROR_BUCKET: new FakeR2(), GITHUB_TOKEN: 'fixture-token', TEST_RELEASE_REPO: REPO };
const first = release('2026.10.09', 1);
const second = release('2026.10.09.2', 2);
const broken = release('2026.10.10', 3, { bundle: bundleFor('2026.10.10', { version: '2026.10.11' }) });
const unrelated = { tag_name: 'v1.0', draft: false, assets: [] };
const draft = { ...release('2026.10.12', 4).entry, draft: true };

let github = fakeGitHub([first.entry, unrelated, second.entry, broken.entry, draft], new Map([...first.files, ...second.files, ...broken.files]));
let result = await syncTestReleases(env, { fetchImpl: github.fetchImpl, now: () => 1000 });
assert.equal(result.ok, true);
assert.deepEqual(result.skipped.map((item) => item.tag), ['2026.10.10']);
assert.match(result.skipped[0].reason, /发布包格式无效/);
let manifest = JSON.parse(await (await env.MIRROR_BUCKET.get('test-releases/manifest.json')).text());
assert.deepEqual(manifest.versions.map((version) => version.tag), ['2026.10.09.2', '2026.10.09']);
const newest = manifest.versions[0];
assert.equal(newest.notes, '更新说明 2026.10.09.2');
assert.equal(newest.bundle.path, '/test-releases/2026.10.09.2/bundle.json');
assert.equal(newest.bundle.sha256, sha256(second.files[0][1]));
assert.equal(newest.zip.path, '/test-releases/2026.10.09.2/RP-Hub-2026.10.09.2.zip');
console.log('PASS date-tagged releases stored newest first; bad bundle, draft and non-date tags skipped');

// 公开路由：清单、发布包、部署包可读；其他路径和目录穿越都是 404。
const get = (path) => mirrorWorker.fetch(new Request(`https://mirror.test${path}`), env);
assert.equal((await (await get('/test-releases/manifest.json')).json()).versions.length, 2);
const servedBundle = new Uint8Array(await (await get(newest.bundle.path)).arrayBuffer());
assert.equal(sha256(servedBundle), newest.bundle.sha256);
assert.equal((await get(newest.zip.path)).headers.get('content-type'), 'application/zip');
for (const path of ['/test-releases/2026.10.09/other.json', '/test-releases/../manifest.json', '/test-releases/2026.10.09.2/RP-Hub-2026.10.09.2.zip/x']) {
    assert.equal((await get(path)).status, 404, path);
}
const page = await (await get('/')).text();
assert.match(page, /测试版/);
assert.match(page, /RP-Hub-2026\.10\.09\.2\.zip/);
console.log('PASS manifest, bundle and zip served; other paths 404; public page lists test releases');

// 再同步：附件没变就不重复下载；GitHub 上删除的版本连文件一起下架。
github = fakeGitHub([second.entry], new Map([...first.files, ...second.files]));
result = await syncTestReleases(env, { fetchImpl: github.fetchImpl, now: () => 2000 });
assert.equal(github.downloads.size, 0, 'unchanged assets must not be downloaded again');
manifest = JSON.parse(await (await env.MIRROR_BUCKET.get('test-releases/manifest.json')).text());
assert.deepEqual(manifest.versions.map((version) => version.tag), ['2026.10.09.2']);
assert.equal(await env.MIRROR_BUCKET.get('test-releases/2026.10.09/bundle.json'), null);
assert.equal(await env.MIRROR_BUCKET.get('test-releases/2026.10.09/RP-Hub-2026.10.09.zip'), null);
assert.ok(await env.MIRROR_BUCKET.get('test-releases/2026.10.09.2/bundle.json'));
console.log('PASS unchanged releases reuse stored files; removed releases are cleaned up');

// 附件被替换（重新发布同一标签）时重新下载。
const replaced = release('2026.10.09.2', 5);
github = fakeGitHub([replaced.entry], new Map(replaced.files));
await syncTestReleases(env, { fetchImpl: github.fetchImpl, now: () => 3000 });
manifest = JSON.parse(await (await env.MIRROR_BUCKET.get('test-releases/manifest.json')).text());
assert.equal(manifest.versions[0].bundle.assetId, 51);
assert.equal(github.downloads.size, 2);
console.log('PASS re-published release assets are downloaded again');

// 管理端「同步测试版」：只拉测试版，不碰上游版本；没有管理令牌时拒绝。
const adminEnv = { ...env, ADMIN_TOKEN: 'fixture-admin-token' };
const syncTestsRequest = (token) => new Request('https://mirror.test/api/sync/test-releases', {
    method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}
});
const requested = [];
const third = release('2026.10.10', 6);
github = fakeGitHub([third.entry, replaced.entry], new Map([...replaced.files, ...third.files]));
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { requested.push(String(url)); return github.fetchImpl(url, init); };
try {
    assert.notEqual((await mirrorWorker.fetch(syncTestsRequest(null), adminEnv)).status, 200);
    assert.equal(requested.length, 0, 'unauthorized sync must not reach GitHub');
    const response = await mirrorWorker.fetch(syncTestsRequest('fixture-admin-token'), adminEnv);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.versionCount, 2);
    assert.ok(requested.every((url) => url.includes(REPO) || url.startsWith('https://api.github.com/assets/')), requested.join('\n'));
} finally {
    globalThis.fetch = previousFetch;
}
console.log('PASS admin test-release sync pulls only test releases and requires the admin token');
