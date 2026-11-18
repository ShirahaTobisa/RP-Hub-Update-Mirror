import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FakeR2 } from './r2.mjs';
import mirrorWorker, { readSkinPackage } from '../worker.mjs';

// 皮肤工坊：皮肤包只收图和颜色；公开投稿进待审核区，管理员看图后上架、拒绝、下架；站点读取的目录、皮肤包和封面带 CORS。
const ADMIN = 'fixture-admin-token';
const env = { MIRROR_BUCKET: new FakeR2(), ADMIN_TOKEN: ADMIN };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const WEBP = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const image = (suffix = '') => `data:image/webp;base64,${WEBP}${suffix}`;
const skin = (id, version = '1.0.0', extra = {}) => ({
    schema: 1, id, version, name: `皮肤 ${id}`, note: '某个游戏', accent: '#8b66d9', neutral: '#8c80b8', colors: ['#8b66d9', '#2fa7c9'],
    art: [image(), image()], wide: [image('#left'), image('#right')], icons: image(), ...extra
});
const call = (path, { method = 'GET', body, admin = false } = {}) => mirrorWorker.fetch(new Request(`https://mirror.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${ADMIN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
}), env);
const submit = (value, extra = {}) => call('/api/workshop/skins/submit', { method: 'POST', body: { source: JSON.stringify(value), author: '作者', ...extra } });
const pending = async () => (await (await call('/api/workshop/skins/pending', { admin: true })).json());

assert.equal(readSkinPackage(JSON.stringify(skin('lily'))).name, '皮肤 lily');
for (const [bad, pattern] of [
    [{ css: 'body{display:none}' }, /只能有图片和配色/], [{ apply: 'x' }, /只能有图片和配色/], [{ schema: 2 }, /schema/],
    [{ id: 'Lily!' }, /id/], [{ accent: 'red' }, /accent/], [{ art: [] }, /art/], [{ art: ['https://example.com/a.webp'] }, /art/],
    [{ art: [image().replace('webp', 'svg+xml')] }, /art/], [{ wide: [image('#top')] }, /wide/], [{ colors: ['#123456', 'blue'] }, /colors/]
]) assert.throws(() => readSkinPackage(JSON.stringify(skin('lily', '1.0.0', bad))), pattern);
assert.throws(() => readSkinPackage('not json'), /JSON/);
console.log('PASS a skin package holds only pictures and colors; code, remote images and bad values are rejected');

let response = await submit(skin('lily'));
assert.equal(response.status, 200, await response.clone().text());
assert.equal((await response.json()).id, 'lily');
assert.equal((await call('/workshop/skins/index.json')).status, 404, 'a submission must not be published before review');
for (const [value, extra, pattern] of [[skin('lily'), { author: '' }, /author/], [skin('lily', '1.0.0', { css: 'x' }), {}, /只能有图片和配色/]]) {
    response = await submit(value, extra);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, pattern);
}
console.log('PASS public submission goes to review only; invalid submissions are rejected');

for (const [path, method] of [['/api/workshop/skins/pending', 'GET'], ['/api/workshop/skins/approve', 'POST']]) {
    assert.equal((await call(path, { method, body: method === 'POST' ? {} : undefined })).status, 403);
}
let review = await pending();
assert.deepEqual(review.pending.map((item) => `${item.id}@${item.version}`), ['lily@1.0.0']);
const sid = review.pending[0].sid;
assert.deepEqual(await (await call(`/api/workshop/skins/pending/${sid}.json`, { admin: true })).json(), readSkinPackage(JSON.stringify(skin('lily'))));
console.log('PASS review routes require the admin token; the admin can read the pending package');

response = await call('/api/workshop/skins/approve', { method: 'POST', admin: true, body: { sid } });
assert.equal(response.status, 200, await response.clone().text());
let index = await (await call('/workshop/skins/index.json')).json();
const published = index.skins[0];
assert.deepEqual([published.id, published.version, published.author, published.cover.path], ['lily', '1.0.0', '作者', '/workshop/skins/lily.webp']);
response = await call(published.file.path);
assert.equal(response.headers.get('access-control-allow-origin'), '*');
assert.equal(response.headers.get('cache-control'), 'no-cache');
const bytes = new Uint8Array(await response.arrayBuffer());
assert.equal(sha256(bytes), published.file.sha256);
assert.equal(JSON.parse(new TextDecoder().decode(bytes)).wide[1], image('#right'));
response = await call('/workshop/skins/lily.webp');
assert.equal(response.headers.get('content-type'), 'image/webp');
assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array(Buffer.from(WEBP, 'base64')));
assert.equal((await pending()).pending.length, 0);
console.log('PASS approval publishes the package and its cover with CORS and clears the submission');

// 投稿页可以改 id、名称、出处（从「自定义」导出的包就是这么投的）；同一 id 新投稿顶掉旧投稿；上架新版本覆盖旧版本。
await submit(skin('my-skin'), { id: 'mornye', name: '莫宁', note: '鸣潮' });
await submit(skin('lily', '1.1.0'));
await submit(skin('lily', '1.2.0'));
review = await pending();
assert.deepEqual(review.pending.map((item) => `${item.id}@${item.version}:${item.name}`), ['mornye@1.0.0:莫宁', 'lily@1.2.0:皮肤 lily']);
await call('/api/workshop/skins/approve', { method: 'POST', admin: true, body: { sid: review.pending[1].sid } });
await call('/api/workshop/skins/reject', { method: 'POST', admin: true, body: { sid: review.pending[0].sid } });
index = await (await call('/workshop/skins/index.json')).json();
assert.deepEqual(index.skins.map((item) => `${item.id}@${item.version}`), ['lily@1.2.0']);
assert.equal((await pending()).pending.length, 0);
assert.equal((await submit(skin('bad'), { id: 'Bad Id' })).status, 400);
console.log('PASS the submit form can rename a package; updates replace the published version; rejected submissions are deleted');

const home = await call('/');
assert.match(home.headers.get('content-security-policy'), /img-src 'self'/);
const html = await home.text();
assert.match(html, /皮肤工坊/);
assert.match(html, /<img src="\/workshop\/skins\/lily\.webp"/);
assert.match(html, /href="\/workshop\/skins\/submit"/);
const page = await call('/workshop/skins/submit');
assert.equal(page.status, 200);
assert.match(page.headers.get('content-security-policy'), /img-src data:/);
assert.match(await page.text(), /投稿皮肤/);
assert.match((await call('/admin')).headers.get('content-security-policy'), /img-src 'self' data:/);
response = await call('/api/workshop/skins/remove', { method: 'POST', admin: true, body: { id: 'lily' } });
assert.equal(response.status, 200);
assert.deepEqual((await (await call('/workshop/skins/index.json')).json()).skins, []);
assert.equal((await call('/workshop/skins/lily.json')).status, 404);
assert.equal((await call('/workshop/skins/lily.webp')).status, 404);
console.log('PASS the home page shows the skins with covers and links the submit page; removal unpublishes the package and cover');
