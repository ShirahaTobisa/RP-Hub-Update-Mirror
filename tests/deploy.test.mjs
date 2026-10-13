import assert from 'node:assert/strict';
import { FakeR2 } from './r2.mjs';
import mirrorWorker from '../worker.mjs';

// 一键部署：用用户令牌建 Pages 项目和 R2 桶、配置绑定与加密密钥、部署最新测试版；各种拒绝情形。
const ACCOUNT_A = 'a'.repeat(32);
const ACCOUNT_B = 'b'.repeat(32);
const bucket = new FakeR2();
bucket.seedJson('test-releases/manifest.json', { schema: 1, versions: [{ tag: '2026.10.10.6' }] });
bucket.seedJson('test-releases/2026.10.10.6/bundle.json', {
    format: 'rph-release-bundle-v1', version: '2026.10.10.6',
    worker: "export default { fetch() { return new Response('rph'); } };",
    assets: [{ path: 'index.html', base64: Buffer.from('<h1>RP</h1>').toString('base64') }, { path: 'DB/styles.css', base64: Buffer.from('a{}').toString('base64') }]
});
const env = { MIRROR_BUCKET: bucket };

let accounts, projects, buckets, r2Enabled, takenNames, zones, dnsRecords, objects;
const calls = [];
const ok = (result) => Response.json({ success: true, result });
const fail = (status, message, code = 1000) => Response.json({ success: false, errors: [{ code, message }] }, { status });
function reset() {
    accounts = [{ id: ACCOUNT_A, name: '主帐户' }];
    projects = new Map();
    buckets = new Set();
    r2Enabled = true;
    takenNames = new Set();
    zones = [];
    dnsRecords = [];
    objects = new Map();
    calls.length = 0;
}
globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.cloudflare.com');
    const path = url.pathname.replace('/client/v4', '');
    const method = init.method || 'GET';
    calls.push({ method, path, auth: init.headers?.authorization, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    if (init.headers?.authorization === 'Bearer bad') return fail(401, 'Invalid API Token');
    if (path === '/accounts') return ok(accounts);
    if (/^\/accounts\/\w+\/pages\/projects$/.test(path) && method === 'GET') return ok(url.searchParams.get('page') === '1' ? [...projects.values()] : []);
    const object = path.match(/^\/accounts\/\w+\/r2\/buckets\/([\w-]+)\/objects\/(.+)$/);
    if (object) return objects.has(`${object[1]}/${object[2]}`) ? Response.json(objects.get(`${object[1]}/${object[2]}`)) : new Response('', { status: 404 });
    const project = path.match(/^\/accounts\/(\w+)\/pages\/projects\/([\w-]+)$/);
    if (project && method === 'GET') return projects.has(project[2]) ? ok(projects.get(project[2])) : fail(404, 'Project not found.', 8000007);
    if (project && method === 'PATCH') return ok({ ...projects.get(project[2]), patched: true });
    if (/\/pages\/projects$/.test(path) && method === 'POST') {
        const name = JSON.parse(init.body).name;
        if (takenNames.has(name) || takenNames.has('*')) return fail(400, 'Subdomain is unavailable. This `*.pages.dev` subdomain is already in use. Select another subdomain.', 8000000);
        projects.set(name, { name, subdomain: `${name}-x1.pages.dev` });
        return ok(projects.get(name));
    }
    const r2 = path.match(/^\/accounts\/\w+\/r2\/buckets\/([\w-]+)$/);
    if (r2) return buckets.has(r2[1]) ? ok({ name: r2[1] }) : fail(404, 'The specified bucket does not exist.', 10006);
    if (/\/r2\/buckets$/.test(path)) {
        if (!r2Enabled) return fail(403, 'Please enable R2 through the Cloudflare Dashboard.', 10042);
        buckets.add(JSON.parse(init.body).name);
        return ok({ name: JSON.parse(init.body).name });
    }
    if (path.endsWith('/upload-token')) return ok({ jwt: 'upload-jwt' });
    if (/\/pages\/projects\/[\w-]+\/domains$/.test(path)) return ok({ name: JSON.parse(init.body).name, status: 'pending' });
    if (path === '/zones') return ok(zones.filter((zone) => zone.name === url.searchParams.get('name')));
    const dns = path.match(/^\/zones\/(\w+)\/dns_records$/);
    if (dns && method === 'GET') return ok(dnsRecords.filter((item) => item.name === url.searchParams.get('name')));
    if (dns && method === 'POST') { dnsRecords.push(JSON.parse(init.body)); return ok(JSON.parse(init.body)); }
    if (path === '/pages/assets/check-missing') return ok(JSON.parse(init.body).hashes);
    if (path === '/pages/assets/upload' || path === '/pages/assets/upsert-hashes') return ok(true);
    if (path.endsWith('/deployments') && method === 'POST') return ok({ id: 'dep-1', url: 'https://dep-1.my-rph-x1.pages.dev' });
    return fail(404, `unexpected ${method} ${path}`);
};

const deploy = async (body) => {
    const response = await mirrorWorker.fetch(new Request('https://mirror.test/api/deploy', { method: 'POST', body: JSON.stringify(body) }), env);
    return { status: response.status, body: await response.json() };
};
const base = { token: 'cf-token', projectName: 'my-rph', bucketName: 'rph-data', password: 'secret-pass' };

reset();
let result = await deploy(base);
assert.equal(result.status, 200, JSON.stringify(result.body));
assert.deepEqual(result.body, { ok: true, version: '2026.10.10.6', projectName: 'my-rph', url: 'https://my-rph-x1.pages.dev', customDomain: null, deploymentUrl: 'https://dep-1.my-rph-x1.pages.dev', bucketCreated: true });
const patch = calls.find((call) => call.method === 'PATCH').body.deployment_configs.production;
assert.deepEqual(patch.r2_buckets, { RP_SYNC_R2: { name: 'rph-data' } });
assert.deepEqual(patch.env_vars.RP_SYNC_PASSWORD, { type: 'secret_text', value: 'secret-pass' });
assert.deepEqual(patch.env_vars.CF_API_TOKEN, { type: 'secret_text', value: 'cf-token' }, 'the token goes into the user project as an encrypted secret for one-click updates');
assert.deepEqual(patch.env_vars.CF_ACCOUNT_ID, { type: 'plain_text', value: ACCOUNT_A });
const order = calls.map((call) => `${call.method} ${call.path.replace(ACCOUNT_A, 'A')}`);
assert.ok(order.indexOf('PATCH /accounts/A/pages/projects/my-rph') < order.indexOf('POST /accounts/A/pages/projects/my-rph/deployments'), 'bindings are set before the deployment so they apply to it');
const form = calls.find((call) => call.path.endsWith('/deployments')).body;
assert.deepEqual(Object.keys(JSON.parse(form.get('manifest'))).sort(), ['/DB/styles.css', '/index.html']);
assert.equal(calls.find((call) => call.path === '/pages/assets/check-missing').auth, 'Bearer upload-jwt');
console.log('PASS deploy creates the project and bucket, stores password and token as secrets, then deploys the latest test build');

reset();
accounts.push({ id: ACCOUNT_B, name: '空帐户' });
result = await deploy(base);
assert.deepEqual([result.status, result.body.code], [400, 'CHOOSE_ACCOUNT']);
assert.ok(!calls.some((call) => call.method !== 'GET'), 'nothing is created before the account is chosen');
const listed = await mirrorWorker.fetch(new Request('https://mirror.test/api/deploy/accounts', { method: 'POST', body: JSON.stringify({ token: 'cf-token' }) }), env);
assert.deepEqual((await listed.json()).accounts.map((item) => item.name), ['主帐户', '空帐户']);
result = await deploy({ ...base, accountId: ACCOUNT_B });
assert.equal(result.body.ok, true);
assert.ok(calls.some((call) => call.path === `/accounts/${ACCOUNT_B}/pages/projects`));
console.log('PASS several accounts require an explicit choice instead of silently using the first one');

reset();
projects.set('my-rph', { name: 'my-rph', subdomain: 'my-rph.pages.dev' });
buckets.add('rph-data');
result = await deploy(base);
assert.deepEqual([result.status, result.body.code], [409, 'PROJECT_EXISTS']);
assert.ok(!calls.some((call) => call.method === 'PATCH' || call.path.endsWith('/deployments')));
result = await deploy({ ...base, overwrite: true });
assert.equal(result.body.ok, true);
assert.equal(result.body.bucketCreated, false);
console.log('PASS an existing project is only overwritten after confirmation; an existing bucket is reused');

reset();
r2Enabled = false;
result = await deploy(base);
assert.deepEqual([result.status, result.body.code], [409, 'R2_NOT_ENABLED']);
assert.match(result.body.error, /开通/);
reset();
result = await deploy({ ...base, token: 'bad' });
assert.deepEqual([result.status, result.body.code], [403, 'TOKEN_INVALID']);
for (const bad of [{ password: '123' }, { projectName: 'Bad_Name' }, { bucketName: 'x' }, { token: '' }]) {
    assert.equal((await deploy({ ...base, ...bad })).status, 400, JSON.stringify(bad));
}
console.log('PASS R2 not enabled, invalid tokens and invalid inputs return clear errors');

// 项目名对应的 pages.dev 网址被别人占用：自动加后缀重试，返回实际项目名。
reset();
takenNames.add('my-rph');
result = await deploy(base);
assert.equal(result.body.ok, true, JSON.stringify(result.body));
assert.match(result.body.projectName, /^my-rph-[a-z0-9]{4}$/);
assert.ok(calls.some((call) => call.path.endsWith(`/pages/projects/${result.body.projectName}/deployments`)), 'the deployment goes to the renamed project');
console.log('PASS a taken pages.dev name is retried with a short suffix');

// Cloudflare 的英文报错配上中文说明，原文附在后面。
reset();
takenNames.add('*');
result = await deploy(base);
assert.match(result.body.error, /^这个项目名对应的 pages\.dev 网址已经被别人用了.*（Cloudflare 原文：Subdomain is unavailable/);
reset();
r2Enabled = false;
assert.match((await deploy(base)).body.error, /开通.*（Cloudflare 原文：Please enable R2/);
console.log('PASS Cloudflare errors are explained in Chinese with the original text attached');

// 自定义域名：同帐户里的域名自动加 CNAME；不在帐户里或已有其他记录时只给出手动说明，不覆盖。
reset();
zones = [{ id: 'zone1', name: 'example.com' }];
result = await deploy({ ...base, customDomain: 'https://RPH.example.com/' });
assert.equal(result.body.customDomain.status, 'ready', JSON.stringify(result.body.customDomain));
assert.deepEqual(dnsRecords, [{ type: 'CNAME', name: 'rph.example.com', content: 'my-rph-x1.pages.dev', proxied: true }]);
assert.ok(calls.some((call) => call.path.endsWith('/pages/projects/my-rph/domains') && call.body.name === 'rph.example.com'));
reset();
zones = [{ id: 'zone1', name: 'example.com' }];
dnsRecords = [{ type: 'A', name: 'rph.example.com', content: '1.2.3.4' }];
result = await deploy({ ...base, customDomain: 'rph.example.com' });
assert.equal(result.body.customDomain.status, 'manual');
assert.equal(dnsRecords.length, 1, 'an existing record is never overwritten');
reset();
result = await deploy({ ...base, customDomain: 'rph.other.org' });
assert.equal(result.body.customDomain.status, 'manual');
assert.match(result.body.customDomain.message, /CNAME 记录：rph\.other\.org → my-rph-x1\.pages\.dev/);
assert.equal((await deploy({ ...base, customDomain: 'x.pages.dev' })).status, 400);
console.log('PASS custom domains are attached; DNS is added only in the same account and never overwritten');

const page = await mirrorWorker.fetch(new Request('https://mirror.test/deploy'), env);
const html = await page.text();
assert.match(html, /一键部署/);
assert.match(html, /不保存/);
assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
console.log('PASS deploy page explains how the token is used');

// 魔改版迁移：列出绑定了存储桶的站点，按云端总清单和最近一次部署分出魔改版和测试版；
// 迁移时沿用站点原来的存储桶，重新设置同步密码和更新用的令牌，部署最新测试版；不建项目、不建桶、不碰数据。
const migrateApi = async (action, body) => {
    const response = await mirrorWorker.fetch(new Request(`https://mirror.test/api/deploy/${action}`, { method: 'POST', body: JSON.stringify(body) }), env);
    return { status: response.status, body: await response.json() };
};
const site = (name, bucketName, extra = {}) => ({
    name, subdomain: `${name}.pages.dev`, domains: [`${name}.pages.dev`],
    deployment_configs: { production: { r2_buckets: { RP_SYNC_R2: { name: bucketName } }, env_vars: { RP_SYNC_PASSWORD: { type: 'secret_text' } } } },
    ...extra
});
reset();
projects.set('mogai', site('mogai', 'mogai-data', { domains: ['mogai.pages.dev', 'rp.example.com'] }));
projects.set('ours', site('ours', 'ours-data', { latest_deployment: { deployment_trigger: { metadata: { commit_message: 'RP-Hub 测试版 2026.10.10.6（站内一键更新）' } } } }));
projects.set('fresh', site('fresh', 'fresh-data'));
projects.set('blog', { name: 'blog', subdomain: 'blog.pages.dev', deployment_configs: { production: {} } });
objects.set('mogai-data/rp-sync/main/manifest.json', { format: 'rp-sync-manifest-root-v1', version: 9, updatedAt: 1760300000000 });
objects.set('ours-data/rp-sync/main/manifest.json', { mode: 'r2-chunk-manifest-v1', version: 3 });
const found = await migrateApi('sites', { token: 'cf-token' });
assert.deepEqual(found.body.sites, [
    { name: 'mogai', url: 'https://rp.example.com', kind: 'fork', syncedAt: 1760300000000 },
    { name: 'ours', url: 'https://ours.pages.dev', kind: 'test', syncedAt: 0 },
    { name: 'fresh', url: 'https://fresh.pages.dev', kind: 'unknown', syncedAt: 0 }
]);
assert.ok(!calls.some((call) => call.method !== 'GET'), 'listing changes nothing');
console.log('PASS the migrate page lists sites with a bucket and tells fork sites from test build sites');

calls.length = 0;
result = await migrateApi('migrate', { token: 'cf-token', projectName: 'mogai', password: 'fork-pass' });
assert.equal(result.status, 200, JSON.stringify(result.body));
assert.deepEqual(result.body, { ok: true, version: '2026.10.10.6', projectName: 'mogai', url: 'https://rp.example.com', deploymentUrl: 'https://dep-1.my-rph-x1.pages.dev' });
const migratePatch = calls.find((call) => call.method === 'PATCH').body.deployment_configs.production;
assert.deepEqual(migratePatch.r2_buckets, { RP_SYNC_R2: { name: 'mogai-data' } }, 'the site keeps its own bucket');
assert.deepEqual(migratePatch.env_vars.RP_SYNC_PASSWORD, { type: 'secret_text', value: 'fork-pass' });
assert.deepEqual(migratePatch.env_vars.CF_API_TOKEN, { type: 'secret_text', value: 'cf-token' });
assert.ok(calls.some((call) => call.method === 'POST' && call.path === `/accounts/${ACCOUNT_A}/pages/projects/mogai/deployments`));
assert.ok(!calls.some((call) => /\/pages\/projects$|\/r2\/buckets$|\/objects\//.test(call.path)), 'no project or bucket is created and no data is touched');
console.log('PASS migrating keeps the site bucket, resets the password and update token, and deploys the latest test build');

for (const [bad, pattern] of [[{ projectName: 'mogai', password: '123' }, /至少 6 位/], [{ password: 'fork-pass' }, /选择/], [{ projectName: 'blog', password: 'fork-pass' }, /没有绑定/]]) {
    const refused = await migrateApi('migrate', { token: 'cf-token', ...bad });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.match(refused.body.error, pattern);
}
accounts.push({ id: ACCOUNT_B, name: '空帐户' });
assert.equal((await migrateApi('sites', { token: 'cf-token' })).body.code, 'CHOOSE_ACCOUNT');
accounts.pop();
assert.equal((await migrateApi('sites', { token: 'bad' })).body.code, 'TOKEN_INVALID');
console.log('PASS migration refuses short passwords, missing choices, sites without a bucket and ambiguous accounts');

const migratePage = await mirrorWorker.fetch(new Request('https://mirror.test/migrate'), env);
const migrateHtml = await migratePage.text();
assert.match(migrateHtml, /从魔改版迁移/);
assert.match(migrateHtml, /「下载」/);
assert.match(migratePage.headers.get('content-security-policy'), /connect-src 'self'/);
console.log('PASS migrate page explains what happens before and after');
