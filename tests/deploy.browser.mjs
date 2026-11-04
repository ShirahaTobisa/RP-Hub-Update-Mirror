import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import worker from '../worker.mjs';
import { FakeR2 } from './r2.mjs';

// 部署页：令牌能看到多个帐户时点选帐户、项目已存在时确认覆盖，都不用浏览器自带的下拉框和弹窗。接口是假的。
const server = http.createServer(async (request, response) => {
    const result = await worker.fetch(new Request(`http://127.0.0.1${request.url}`, { method: request.method, headers: request.headers }), { MIRROR_BUCKET: new FakeR2() });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
const deploys = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('dialog', (dialog) => { errors.push('browser dialog: ' + dialog.message()); dialog.dismiss(); });
await page.route('**/api/deploy/accounts', (route) => route.fulfill({ json: { ok: true, accounts: [{ id: 'aaaaaaaa1111', name: '帐户甲' }, { id: 'bbbbbbbb2222', name: '帐户乙' }] } }));
await page.route('**/api/deploy', (route) => {
    const body = route.request().postDataJSON();
    deploys.push(body);
    if (!body.accountId) return route.fulfill({ json: { ok: false, code: 'CHOOSE_ACCOUNT', error: '这个令牌能看到多个帐户，请选一个。' } });
    if (!body.overwrite) return route.fulfill({ json: { ok: false, code: 'PROJECT_EXISTS', error: '项目已存在，继续会覆盖。' } });
    return route.fulfill({ json: { ok: true, url: 'https://demo.pages.dev', version: '2026.11.04', customDomain: '' } });
});

try {
    await page.goto(`${base}/deploy`);
    await page.fill('#token', 'fixture-token');
    await page.fill('#project', 'demo');
    await page.fill('#bucket', 'demo-bucket');
    await page.fill('#password', 'fixture-password');
    await page.click('#deploy');

    const choices = page.locator('#accountChoices button');
    await choices.nth(1).waitFor();
    assert.equal(await page.locator('select:visible').count(), 0, 'no browser dropdown');
    assert.deepEqual(await choices.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-pressed'))), ['true', 'false']);
    await choices.nth(1).click();
    assert.deepEqual(await choices.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-pressed'))), ['false', 'true']);
    console.log('PASS several accounts show as a list to pick from');

    await page.click('#deploy');
    const ask = page.locator('dialog.ask');
    await ask.waitFor();
    assert.equal(deploys.at(-1).accountId, 'bbbbbbbb2222');
    assert.match(await ask.innerText(), /项目已存在/);
    if (process.env.DEPLOY_SHOT) await page.screenshot({ path: process.env.DEPLOY_SHOT });
    await ask.locator('.btn', { hasText: '取消' }).click();
    await page.locator('#status', { hasText: '已取消' }).waitFor();
    assert.equal(await ask.count(), 0);
    console.log('PASS cancelling the overwrite question keeps the project');

    await page.click('#deploy');
    await ask.locator('.btn.primary').click();
    await page.waitForFunction(() => document.querySelector('#doneUrl')?.textContent.includes('demo.pages.dev'));
    assert.equal(deploys.at(-1).overwrite, true);
    console.log('PASS confirming the overwrite question deploys over the project');

    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    server.close();
}
