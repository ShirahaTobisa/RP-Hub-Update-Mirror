import assert from 'node:assert/strict';
import { FakeR2 } from './r2.mjs';
import mirrorWorker, { syncBestIps } from '../worker.mjs';

// 国内优选：定时从公开列表拿 Cloudflare 官方网段内的 IP，写成优选域名的 A 记录；手动指定优先；出错保留上次结果。
const HOST = 'yx.rph.test';
const TOKEN = 'dns-token';
const ADMIN = 'admin-token';
let sources, zones, records, ranges, calls;
const ok = (result) => Response.json({ success: true, result });
function reset() {
    sources = {
        'https://list.test/a': '172.67.148.115#CM-Default\n198.41.208.148#CU-Default\n151.241.5.88:443#JP 别人的反代\n172.67.148.115#CT-Default\n',
        'https://list.test/b': '104.16.1.1\n'
    };
    zones = [{ id: 'zone1', name: 'rph.test' }];
    records = [];
    ranges = '173.245.48.0/20\n172.64.0.0/13\n198.41.128.0/17\n104.16.0.0/13\n';
    calls = [];
}
const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    calls.push(`${method} ${url.href}`);
    if (url.href === 'https://www.cloudflare.com/ips-v4') return ranges === null ? new Response('', { status: 500 }) : new Response(ranges);
    if (url.origin === 'https://list.test') return url.href in sources ? new Response(sources[url.href]) : new Response('', { status: 404 });
    assert.equal(url.origin, 'https://api.cloudflare.com');
    assert.equal(init.headers?.authorization, `Bearer ${TOKEN}`);
    const path = url.pathname.replace('/client/v4', '');
    if (path === '/zones') return ok(zones.filter((zone) => zone.name === url.searchParams.get('name')));
    if (path === '/zones/zone1/dns_records' && method === 'GET') {
        assert.deepEqual([url.searchParams.get('type'), url.searchParams.get('name')], ['A', HOST]);
        return ok(records);
    }
    if (path === '/zones/zone1/dns_records' && method === 'POST') {
        const body = JSON.parse(init.body);
        records.push({ id: `r${records.length + 1}`, ...body });
        return ok(body);
    }
    const removal = path.match(/^\/zones\/zone1\/dns_records\/(\w+)$/);
    if (removal && method === 'DELETE') {
        records = records.filter((record) => record.id !== removal[1]);
        return ok({ id: removal[1] });
    }
    return Response.json({ success: false, errors: [{ code: 1000, message: `unexpected ${method} ${path}` }] }, { status: 404 });
};
const changes = () => calls.filter((call) => /^(POST|DELETE) https:\/\/api\.cloudflare\.com/.test(call));

const bucket = new FakeR2();
bucket.seedJson('_mirror/config.json', { bestIpSources: ['https://list.test/a', 'https://list.test/b'] });
const env = { MIRROR_BUCKET: bucket, BEST_IP_HOST: HOST, BEST_IP_DNS_TOKEN: TOKEN, ADMIN_TOKEN: ADMIN };

reset();
let result = await syncBestIps(env, { fetchImpl, now: 1000 });
assert.equal(result.ok, true, JSON.stringify(result));
assert.deepEqual(result.ips, ['172.67.148.115', '198.41.208.148'], 'only Cloudflare-range IPs, deduplicated, in list order');
assert.deepEqual(records.map((record) => [record.type, record.name, record.content, record.proxied, record.ttl]),
    [['A', HOST, '172.67.148.115', false, 300], ['A', HOST, '198.41.208.148', false, 300]]);
assert.deepEqual([result.host, result.source, result.updatedAt, result.checkedAt, result.error], [HOST, 'https://list.test/a', 1000, 1000, '']);
assert.deepEqual(bucket.json('_mirror/best-ips.json').ips, result.ips);
console.log('PASS the first sync writes the Cloudflare-range IPs of the first source as unproxied A records');

reset();
records = [{ id: 'r1', type: 'A', name: HOST, content: '172.67.148.115' }, { id: 'r2', type: 'A', name: HOST, content: '198.41.208.148' }];
result = await syncBestIps(env, { fetchImpl, now: 2000 });
assert.deepEqual([result.ok, result.updatedAt, result.checkedAt], [true, 1000, 2000]);
assert.deepEqual(changes(), [], 'identical IPs change nothing');
console.log('PASS an unchanged list leaves DNS alone and only records the check time');

reset();
records = [{ id: 'r1', type: 'A', name: HOST, content: '172.67.148.115' }, { id: 'r2', type: 'A', name: HOST, content: '198.41.208.148' }];
sources['https://list.test/a'] = '198.41.208.148\n104.16.5.5\n';
result = await syncBestIps(env, { fetchImpl, now: 3000 });
assert.deepEqual(result.ips, ['198.41.208.148', '104.16.5.5']);
assert.deepEqual(records.map((record) => record.content), ['198.41.208.148', '104.16.5.5']);
assert.ok(changes().indexOf('POST https://api.cloudflare.com/client/v4/zones/zone1/dns_records') < changes().indexOf('DELETE https://api.cloudflare.com/client/v4/zones/zone1/dns_records/r1'), 'new records are added before stale ones are removed');
assert.equal(result.updatedAt, 3000);
console.log('PASS a changed list adds the new IPs first, then removes the stale records');

reset();
delete sources['https://list.test/a'];
ranges = null;
sources['https://list.test/b'] = '151.241.5.88\n104.16.1.1\n';
result = await syncBestIps(env, { fetchImpl, now: 4000 });
assert.deepEqual([result.ok, result.ips, result.source], [true, ['104.16.1.1'], 'https://list.test/b'], JSON.stringify(result));
console.log('PASS a failing source falls through to the next one; the built-in range list still filters when cloudflare.com is unreachable');

reset();
sources = {};
records = [{ id: 'r1', type: 'A', name: HOST, content: '104.16.1.1' }];
result = await syncBestIps(env, { fetchImpl, now: 5000 });
assert.equal(result.ok, false);
assert.match(result.error, /没有拿到优选 IP.*HTTP 404/);
assert.deepEqual([result.ips, result.updatedAt, result.checkedAt], [['104.16.1.1'], 4000, 5000], 'the previous IPs stay on record');
assert.deepEqual(changes(), [], 'DNS is not touched when no source works');
console.log('PASS when every source fails the error is recorded and the last good IPs are kept');

reset();
bucket.seedJson('_mirror/config.json', { bestIpSources: ['https://list.test/a'], bestIpManual: ['1.2.3.4', '172.67.1.1'] });
records = [{ id: 'r1', type: 'A', name: HOST, content: '104.16.1.1' }];
result = await syncBestIps(env, { fetchImpl, now: 6000 });
assert.deepEqual([result.ips, result.source], [['1.2.3.4', '172.67.1.1'], '手动指定']);
assert.ok(!calls.some((call) => call.includes('list.test') || call.includes('cloudflare.com/ips-v4')), 'manual IPs skip the sources entirely');
assert.deepEqual(records.map((record) => record.content), ['1.2.3.4', '172.67.1.1']);
console.log('PASS manually specified IPs replace the sources as given');

reset();
zones = [];
result = await syncBestIps(env, { fetchImpl, now: 7000 });
assert.match(result.error, /找不到 yx\.rph\.test 所属的域名/);
calls = [];
result = await syncBestIps({ ...env, BEST_IP_DNS_TOKEN: '' }, { fetchImpl, now: 8000 });
assert.deepEqual([result.ok, result.skipped], [false, true]);
assert.deepEqual(calls, [], 'nothing is fetched without the DNS token');
console.log('PASS a missing zone is reported and a missing token skips the sync');

// 管理接口和页面：同步要管理员令牌；状态和部署页反映当前优选情况；配置校验。
globalThis.fetch = fetchImpl;
const request = (path, init = {}, admin = true) => new Request(`https://mirror.test${path}`, {
    ...init, headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${ADMIN}` } : {}) }
});
reset();
bucket.seedJson('_mirror/config.json', { bestIpSources: ['https://list.test/a'] });
let response = await mirrorWorker.fetch(request('/api/sync/best-ips', { method: 'POST' }, false), env);
assert.notEqual(response.status, 200, 'the sync endpoint needs the admin token');
response = await mirrorWorker.fetch(request('/api/sync/best-ips', { method: 'POST' }), env);
assert.equal(response.status, 200);
assert.deepEqual((await response.json()).ips, ['172.67.148.115', '198.41.208.148']);
const status = await (await mirrorWorker.fetch(request('/api/status'), env)).json();
assert.deepEqual(status.bestIp.ips, ['172.67.148.115', '198.41.208.148']);
assert.deepEqual([status.bestIp.host, status.bestIp.source, status.bestIp.error, status.secrets.bestIpDns], [HOST, 'https://list.test/a', '', true]);
assert.deepEqual(status.config.bestIpSources, ['https://list.test/a']);
assert.deepEqual(status.config.bestIpManual, []);
let page = await (await mirrorWorker.fetch(new Request('https://mirror.test/deploy'), env)).text();
assert.match(page, /id="bestIp"/);
assert.match(page, /yx\.rph\.test/);
page = await (await mirrorWorker.fetch(new Request('https://mirror.test/deploy'), { ...env, MIRROR_BUCKET: new FakeR2() })).text();
assert.doesNotMatch(page, /id="bestIp"/, 'the option is hidden until the best-IP host has addresses');
assert.match(await (await mirrorWorker.fetch(new Request('https://mirror.test/admin'), env)).text(), /立即更新 DNS/);
console.log('PASS the admin sync endpoint, status and deploy page reflect the best-IP state');

for (const bad of [{ bestIpSources: ['http://plain.test'] }, { bestIpManual: ['1.2.3'] }, { bestIpManual: 'x' }, { bestIpSources: new Array(21).fill('https://a.test') }]) {
    response = await mirrorWorker.fetch(request('/api/config', { method: 'PUT', body: JSON.stringify(bad) }), env);
    assert.equal(response.status, 400, JSON.stringify(bad));
}
response = await mirrorWorker.fetch(request('/api/config', { method: 'PUT', body: JSON.stringify({ bestIpSources: [' https://list.test/b ', 'https://list.test/b'], bestIpManual: [] }) }), env);
assert.equal(response.status, 200);
assert.deepEqual((await response.json()).config.bestIpSources, ['https://list.test/b'], 'entries are trimmed and deduplicated');
assert.deepEqual(bucket.json('_mirror/config.json').bestIpSources, ['https://list.test/b']);
console.log('PASS best-IP config is validated, trimmed and stored');
