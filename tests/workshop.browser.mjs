import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import worker from '../worker.mjs';
import { FakeR2 } from './r2.mjs';

// 插件工坊页面：在浏览器里走一遍投稿（前端预检）→ 后台审阅 → 上架 → 更新时看对比 → 下架。
const ADMIN = 'browser-admin-token';
const env = { MIRROR_BUCKET: new FakeR2(), ADMIN_TOKEN: ADMIN };
const pluginSource = (version, extra = '') => `RPHubSDK.register({\n    id: 'browser-demo', name: '浏览器示例', version: '${version}', requiresApi: 4,\n    init(ctx) {\n        ctx.log('ready');${extra}\n    }\n});\n`;
const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await worker.fetch(new Request(`http://127.0.0.1${request.url}`, {
        method: request.method,
        headers: request.headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks)
    }), env);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('dialog', (dialog) => dialog.accept());

async function submit(source, { name = '', author = '' } = {}) {
    await page.goto(`${base}/workshop/submit`);
    await page.setInputFiles('#file', { name: 'browser-demo.js', mimeType: 'text/javascript', buffer: Buffer.from(source) });
    await page.waitForFunction(() => !document.querySelector('#check').hidden);
    if (name) await page.fill('#name', name);
    if (author) await page.fill('#author', author);
    await page.fill('#description', '只用于测试');
}

try {
    await page.goto(`${base}/workshop/submit`);
    await page.setInputFiles('#file', { name: 'bad.js', mimeType: 'text/javascript', buffer: Buffer.from('console.log(1)') });
    await page.waitForFunction(() => document.querySelector('#check').textContent.includes('RPHubSDK.register'));
    assert.equal(await page.isDisabled('#submit'), true);
    await submit(pluginSource('1.0.0'), { name: '浏览器示例', author: '测试作者' });
    assert.equal(await page.textContent('#dKind'), '新插件');
    assert.equal(await page.textContent('#dVersion'), '1.0.0');
    await page.click('#submit');
    await page.locator('#done').waitFor();
    assert.match(await page.textContent('#doneText'), /browser-demo v1\.0\.0/);
    console.log('PASS submit page checks the file in the browser and submits into review');

    await page.goto(`${base}/admin#workshop`);
    await page.fill('#adminToken', ADMIN);
    await page.click('#authForm button[type=submit]');
    await page.locator('.ws-review').waitFor();
    await page.click('.ws-review');
    await page.waitForFunction(() => document.querySelector('#reviewCode').textContent.includes('browser-demo'));
    assert.equal(await page.isHidden('#viewDiff'), true, 'a new plugin has nothing to compare');
    await page.click('#reviewApprove');
    await page.waitForFunction(() => document.querySelector('#workshopPluginsBody').textContent.includes('browser-demo'));
    assert.deepEqual((await (await fetch(`${base}/workshop/index.json`)).json()).plugins.map((plugin) => plugin.version), ['1.0.0']);
    console.log('PASS admin reviews the full source and publishes the submission');

    await submit(pluginSource('1.0.0'));
    assert.match(await page.textContent('#check'), /版本号和工坊里已上架的版本相同/);
    assert.equal(await page.isDisabled('#submit'), true);
    await submit(pluginSource('1.1.0', "\n        ctx.ui.toast('新功能');"));
    assert.match(await page.textContent('#dKind'), /更新：工坊现有 v1\.0\.0（测试作者）/);
    assert.equal(await page.inputValue('#author'), '测试作者', 'an update keeps the published author');
    await page.click('#submit');
    await page.locator('#done').waitFor();
    await page.goto(`${base}/admin#workshop`);
    await page.locator('.ws-review').click();
    await page.waitForFunction(() => document.querySelector('#reviewCode .diff-sum'));
    assert.equal(await page.locator('#reviewCode .ln.add').count(), 2);
    assert.equal(await page.locator('#reviewCode .ln.del').count(), 1);
    await page.click('#reviewApprove');
    await page.waitForFunction(() => document.querySelector('#workshopPluginsBody').textContent.includes('v1.1.0'));
    console.log('PASS updates are detected on submit and reviewed as a diff against the published version');

    await page.locator('.ws-remove').click();
    await page.waitForFunction(() => document.querySelector('#workshopPluginsBody').textContent.includes('工坊里还没有插件'));
    assert.deepEqual(errors, []);
    console.log('PASS admin page removes a published plugin');
} finally {
    await browser.close();
    server.close();
}
