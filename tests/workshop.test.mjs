import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FakeR2 } from './r2.mjs';
import mirrorWorker, { readPluginManifest } from '../worker.mjs';

// 插件工坊：公开投稿进待审核区，管理员审核上架、拒绝、下架；站点读取的目录和插件文件带 CORS。
const ADMIN = 'fixture-admin-token';
const env = { MIRROR_BUCKET: new FakeR2(), ADMIN_TOKEN: ADMIN };
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const source = (id, version = '1.0.0') => `(() => {\n    RPHubSDK.register({\n        id: '${id}', name: '${id}', version: "${version}", requiresApi: 4,\n        init(ctx) { ctx.log('${id}'); }\n    });\n})();`;
const call = (path, { method = 'GET', body, admin = false } = {}) => mirrorWorker.fetch(new Request(`https://mirror.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${ADMIN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
}), env);
const submit = (id, version, extra = {}) => call('/api/workshop/submit', {
    method: 'POST', body: { source: source(id, version), name: `插件 ${id}`, author: '作者', description: `说明 ${id}`, ...extra }
});
const pending = async () => (await (await call('/api/workshop/pending', { admin: true })).json());

assert.deepEqual(readPluginManifest(source('alpha')), { id: 'alpha', version: '1.0.0', requiresApi: 4 });
assert.throws(() => readPluginManifest('console.log(1)'), /RPHubSDK\.register/);
assert.throws(() => readPluginManifest("RPHubSDK.register({ id: name, version: '1', requiresApi: 4 })"), /固定值/);
console.log('PASS manifest read from register literals; missing or computed values rejected');

let response = await submit('alpha');
assert.equal(response.status, 200, await response.clone().text());
assert.equal((await response.json()).id, 'alpha');
assert.equal((await call('/workshop/index.json')).status, 404, 'a submission must not be published before review');
for (const [extra, pattern] of [[{ name: '' }, /name/], [{ description: 'x'.repeat(301) }, /description/], [{ source: 'nothing here' }, /RPHubSDK\.register/]]) {
    response = await call('/api/workshop/submit', { method: 'POST', body: { source: source('beta'), name: 'n', author: 'a', description: 'd', ...extra } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, pattern);
}
console.log('PASS public submission goes to review only; invalid submissions are rejected');

for (const path of ['/api/workshop/pending', '/api/workshop/approve']) {
    assert.equal((await call(path, { method: path.endsWith('pending') ? 'GET' : 'POST', body: path.endsWith('pending') ? undefined : {} })).status, 403);
}
let review = await pending();
assert.deepEqual(review.pending.map((item) => `${item.id}@${item.version}`), ['alpha@1.0.0']);
const sid = review.pending[0].sid;
assert.equal(await (await call(`/api/workshop/pending/${sid}.js`, { admin: true })).text(), source('alpha'));
console.log('PASS review routes require the admin token; pending list and source are readable by the admin');

response = await call('/api/workshop/approve', { method: 'POST', admin: true, body: { sid } });
assert.equal(response.status, 200);
let index = await (await call('/workshop/index.json')).json();
assert.deepEqual(index.plugins.map((plugin) => [plugin.id, plugin.version, plugin.file.sha256]), [['alpha', '1.0.0', sha256(source('alpha'))]]);
response = await call('/workshop/plugins/alpha.js');
assert.equal(response.headers.get('access-control-allow-origin'), '*');
assert.equal(await response.text(), source('alpha'));
assert.equal((await pending()).pending.length, 0);
console.log('PASS approval publishes the plugin with CORS and clears the submission');

await submit('alpha', '1.1.0');
await submit('alpha', '1.2.0');
await submit('gamma');
review = await pending();
assert.deepEqual(review.pending.map((item) => `${item.id}@${item.version}`), ['alpha@1.2.0', 'gamma@1.0.0'], 'a newer submission replaces the older one for the same id');
await call('/api/workshop/approve', { method: 'POST', admin: true, body: { sid: review.pending[0].sid } });
await call('/api/workshop/reject', { method: 'POST', admin: true, body: { sid: review.pending[1].sid } });
index = await (await call('/workshop/index.json')).json();
assert.deepEqual(index.plugins.map((plugin) => `${plugin.id}@${plugin.version}`), ['alpha@1.2.0']);
assert.equal((await pending()).pending.length, 0);
assert.equal(env.MIRROR_BUCKET.records.size, 2, 'only the index and the published file remain');
console.log('PASS updates replace the published version; rejected submissions are deleted');

const page = await (await call('/')).text();
assert.match(page, /插件 alpha/);
assert.match(page, /\/workshop\/submit/);
assert.match(await (await call('/workshop/submit')).text(), /提交审核/);
await call('/api/workshop/remove', { method: 'POST', admin: true, body: { id: 'alpha' } });
assert.deepEqual((await (await call('/workshop/index.json')).json()).plugins, []);
assert.equal((await call('/workshop/plugins/alpha.js')).status, 404);
console.log('PASS public pages list plugins and link the submit page; removal unpublishes');

for (let index = 0; index < 50; index += 1) assert.equal((await submit(`bulk-${String(index).padStart(2, '0')}`)).status, 200);
response = await submit('one-too-many');
assert.equal(response.status, 429);
assert.equal((await submit('bulk-00', '2.0.0')).status, 200, 'replacing an existing pending id is still allowed when full');
console.log('PASS pending queue is capped at 50 submissions');
