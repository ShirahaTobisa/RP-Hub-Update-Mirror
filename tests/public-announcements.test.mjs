import assert from 'node:assert/strict';
import worker from '../worker.mjs';
import { fixture } from './public-fixture.mjs';

const { bucket, env } = fixture();
const get = url => worker.fetch(new Request('https://mirror.test' + url), env);
const home = await get('/');
assert.equal(home.status, 200);
const homeHtml = await home.text();
assert.match(homeHtml, /href="\/\?tag=1\.9\.6#announcement"/);
assert.doesNotMatch(homeHtml, /<script|ADMIN_TOKEN|test-admin-only|test-github-only/);
assert.equal(home.headers.get('content-security-policy').includes("default-src 'none'"), true);

const announcement = await get('/?tag=1.9.6');
assert.equal(announcement.status, 200);
const html = await announcement.text();
assert.match(html, /公告 · 1\.9\.6/);
assert.match(html, /&lt;i&gt;网站公告&lt;\/i&gt;/);
assert.match(html, /&lt;script&gt;alert/);
assert.match(html, /&lt;img src=x onerror/);
assert.doesNotMatch(html, /<script|<img|test-admin-only/);
assert.match(html, /完整公告正文。/);
assert.match(await (await get('/?tag=1.9.5')).text(), /该版本暂无公告/);
assert.equal(bucket.putCalls.length, 0, 'public reads must not sync upstream or write R2');

for (const corrupt of [null, 'not-json']) {
    if (corrupt === null) await bucket.delete('_mirror/announcements.json');
    else bucket.seedText('_mirror/announcements.json', corrupt);
    const response = await get('/?tag=1.9.6');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /公告暂时无法读取/);
    assert.match(body, /重试/);
    assert.match(body, /可更新版本/);
    assert.doesNotMatch(body, /请先在管理端/);
}
for (const [method, route] of [
    ['POST', '/api/sync'], ['POST', '/api/versions/delete'],
    ['POST', '/api/pending/retry'], ['PUT', '/api/config']
]) {
    const response = await worker.fetch(new Request('https://mirror.test' + route, { method, body: '{}' }), env);
    assert.equal(response.status, 403, route);
}
const tag = 'preview /?&"<x>';
const special = fixture(tag);
const specialHome = await worker.fetch(new Request('https://mirror.test/'), special.env);
assert((await specialHome.text()).includes('/?tag=' + encodeURIComponent(tag) + '#announcement'));
const specialPage = await worker.fetch(new Request('https://mirror.test/?tag=' + encodeURIComponent(tag)), special.env);
const specialHtml = await specialPage.text();
assert.match(specialHtml, /公告 · preview \/\?&amp;&quot;&lt;x&gt;/);
assert.doesNotMatch(specialHtml, /<x>/);
console.log('Public announcements: anonymous access, escaping, full text, empty/error/retry states, encoded tags and write protection passed.');
