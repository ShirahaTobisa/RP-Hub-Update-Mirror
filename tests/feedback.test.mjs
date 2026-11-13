import assert from 'node:assert/strict';
import worker from '../worker.mjs';
import { FakeR2 } from './r2.mjs';

const bucket = new FakeR2();
bucket.list = async ({ prefix = '', cursor = '', limit = 1000 } = {}) => {
    const keys = bucket.keys(prefix).filter(key => key > cursor).sort();
    const page = keys.slice(0, limit);
    return { objects: page.map(key => ({ key, customMetadata: bucket.records.get(key).customMetadata })),
        truncated: keys.length > limit, cursor: keys.length > limit ? page.at(-1) : undefined };
};
const env = { MIRROR_BUCKET: bucket, ADMIN_TOKEN: 'fixture-admin' };
const call = (route, method = 'GET', body, admin = false) => worker.fetch(new Request('https://mirror.test/api/feedback/' + route, {
    method, headers: { 'content-type': 'application/json', ...(admin ? { authorization: 'Bearer fixture-admin' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
}), env);

for (const account of ['a', 'a', 'b']) {
    assert.equal((await call('usage', 'POST', { account: account.repeat(64), release: '2026.11.13', upstream: '2.0.6' })).status, 200);
}
let stats = await (await call('stats', 'GET', undefined, true)).json();
assert.deepEqual([stats.today, stats.week, stats.month, stats.total], [2, 2, 2, 2]);
bucket.records.get('_feedback/usage/' + 'a'.repeat(64)).customMetadata.at = String(Date.now() - 31 * 86400000);
stats = await (await call('stats', 'GET', undefined, true)).json();
assert.deepEqual([stats.today, stats.week, stats.month, stats.total], [1, 1, 1, 2]);

const report = { schema: 1, issue: 'image', release: '2026.11.13', upstream: '2.0.6',
    plugins: [{ id: 'fixture', version: '1', source: 'do-not-store' }],
    events: [{ at: Date.now(), session: '12345678', kind: 'image-reroll-end', owner: 'C1', current: 'C2', password: 'do-not-store' }], apiKey: 'do-not-store' };
const sent = await call('reports', 'POST', report);
assert.equal(sent.status, 200);
const { id } = await sent.json();
const stored = await (await call('reports/' + id, 'GET', undefined, true)).json();
assert.equal(stored.events[0].owner, 'C1');
assert.equal(stored.events[0].current, 'C2');
assert.ok(!JSON.stringify(stored).includes('do-not-store'));
assert.equal((await call('reports', 'POST', { ...report, note: 'x'.repeat(128 * 1024) })).status, 400);
assert.equal((await call('reports', 'POST', { schema: 3 })).status, 400);
for (const route of ['stats', 'reports', 'reports/' + id]) assert.equal((await call(route)).status, 403);
assert.equal((await worker.fetch(new Request('https://mirror.test/_feedback/reports/' + id), env)).status, 404);
assert.equal((await (await call('reports', 'GET', undefined, true)).json()).reports[0].id, id);
await call('reports/' + id, 'DELETE', undefined, true);
assert.equal((await call('reports/' + id, 'GET', undefined, true)).status, 404);
console.log('PASS account deduplication, active windows, report fields, size limits, private access and deletion');
