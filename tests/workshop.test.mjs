import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FakeR2 } from './r2.mjs';
import mirrorWorker, { syncWorkshop } from '../worker.mjs';

const REPO = 'ShirahaTobisa/RP-Hub-Workshop';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const meta = (id, version = '1.0.0', extra = {}) => JSON.stringify({ id, name: `插件 ${id}`, version, author: '作者', description: `说明 ${id}`, requiresApi: 4, ...extra });
const source = (id, version = '1.0.0') => `RPHubSDK.register({ id: '${id}', name: '${id}', version: '${version}', requiresApi: 4, init() {} });`;

// 模拟 GitHub：主分支 commit、递归文件树、raw 文件；记录 raw 下载次数。
function fakeGitHub(commit, files) {
    const raw = [];
    const fetchImpl = async (url) => {
        const href = String(url);
        if (href === `https://api.github.com/repos/${REPO}/commits/main`) return Response.json({ sha: commit });
        if (href === `https://api.github.com/repos/${REPO}/git/trees/${commit}?recursive=1`) {
            return Response.json({ truncated: false, tree: Object.entries(files).map(([path, text]) => ({ path, type: 'blob', size: text.length })) });
        }
        const prefix = `https://raw.githubusercontent.com/${REPO}/${commit}/`;
        if (href.startsWith(prefix)) {
            const path = decodeURIComponent(href.slice(prefix.length));
            raw.push(path);
            return path in files ? new Response(files[path]) : new Response('missing', { status: 404 });
        }
        return new Response('unexpected', { status: 500 });
    };
    return { fetchImpl, raw };
}

const env = { MIRROR_BUCKET: new FakeR2(), GITHUB_TOKEN: 'fixture-token', WORKSHOP_REPO: REPO };
const commitA = 'a'.repeat(40);
let github = fakeGitHub(commitA, {
    'README.md': '# 工坊',
    'plugins/alpha/plugin.json': meta('alpha'),
    'plugins/alpha/alpha.js': source('alpha'),
    'plugins/beta/plugin.json': meta('beta'),
    'plugins/beta/beta.js': source('beta'),
    'plugins/wrong/plugin.json': meta('other'),
    'plugins/wrong/wrong.js': source('wrong'),
    'plugins/nofile/plugin.json': meta('nofile')
});
let result = await syncWorkshop(env, { fetchImpl: github.fetchImpl, now: () => 1000 });
assert.equal(result.changed, true);
assert.deepEqual(result.skipped.map((item) => item.id), ['nofile', 'wrong']);
let index = JSON.parse(await (await env.MIRROR_BUCKET.get('workshop/index.json')).text());
assert.equal(index.commit, commitA);
assert.deepEqual(index.plugins.map((plugin) => plugin.id), ['alpha', 'beta']);
assert.deepEqual(index.plugins[0], {
    id: 'alpha', name: '插件 alpha', version: '1.0.0', author: '作者', description: '说明 alpha', requiresApi: 4, updatedAt: 1000,
    file: { path: '/workshop/plugins/alpha.js', sha256: sha256(source('alpha')), size: source('alpha').length }
});
console.log('PASS valid plugins listed; mismatched id and missing file skipped');

const get = (path) => mirrorWorker.fetch(new Request(`https://mirror.test${path}`), env);
let response = await get('/workshop/plugins/alpha.js');
assert.equal(response.headers.get('access-control-allow-origin'), '*');
assert.equal(await response.text(), source('alpha'));
response = await get('/workshop/index.json');
assert.equal(response.headers.get('access-control-allow-origin'), '*');
assert.equal((await response.json()).plugins.length, 2);
for (const path of ['/workshop/plugins/Alpha.js', '/workshop/plugins/alpha.json', '/workshop/other.json', '/workshop/plugins/alpha.js.bak', '/workshop/plugins/alpha/alpha.js']) {
    assert.equal((await get(path)).status, 404, path);
}
assert.match(await (await get('/')).text(), /插件工坊[\s\S]*插件 alpha/);
console.log('PASS index and plugin files served with CORS; other paths 404; public page lists plugins');

github = fakeGitHub(commitA, {});
result = await syncWorkshop(env, { fetchImpl: github.fetchImpl, now: () => 2000 });
assert.equal(result.changed, false);
assert.equal(github.raw.length, 0, 'unchanged main branch must not download plugin files');
console.log('PASS unchanged main branch is skipped');

// 新提交：beta 升级、alpha 删除、gamma 新增；beta 变成无效时保留上一次上架的版本。
const commitB = 'b'.repeat(40);
github = fakeGitHub(commitB, {
    'plugins/beta/plugin.json': meta('beta', '1.1.0'),
    'plugins/beta/beta.js': source('beta', '1.1.0'),
    'plugins/gamma/plugin.json': meta('gamma'),
    'plugins/gamma/gamma.js': source('gamma')
});
await syncWorkshop(env, { fetchImpl: github.fetchImpl, now: () => 3000 });
index = JSON.parse(await (await env.MIRROR_BUCKET.get('workshop/index.json')).text());
assert.deepEqual(index.plugins.map((plugin) => `${plugin.id}@${plugin.version}:${plugin.updatedAt}`), ['beta@1.1.0:3000', 'gamma@1.0.0:3000']);
assert.equal(await env.MIRROR_BUCKET.get('workshop/plugins/alpha.js'), null);
assert.equal(await (await env.MIRROR_BUCKET.get('workshop/plugins/beta.js')).text(), source('beta', '1.1.0'));

const commitC = 'c'.repeat(40);
github = fakeGitHub(commitC, {
    'plugins/beta/plugin.json': meta('beta', '1.2.0', { requiresApi: 'four' }),
    'plugins/beta/beta.js': source('beta', '1.2.0'),
    'plugins/gamma/plugin.json': meta('gamma'),
    'plugins/gamma/gamma.js': source('gamma')
});
result = await syncWorkshop(env, { fetchImpl: github.fetchImpl, now: () => 4000 });
index = JSON.parse(await (await env.MIRROR_BUCKET.get('workshop/index.json')).text());
assert.deepEqual(result.skipped.map((item) => item.id), ['beta']);
assert.deepEqual(index.plugins.map((plugin) => `${plugin.id}@${plugin.version}:${plugin.updatedAt}`), ['beta@1.1.0:3000', 'gamma@1.0.0:3000']);
console.log('PASS updates, removals and additions sync; an invalid update keeps the last good version');
