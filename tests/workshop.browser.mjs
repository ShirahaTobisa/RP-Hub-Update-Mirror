import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import worker from '../worker.mjs';
import { FakeR2 } from './r2.mjs';

// 插件工坊页面：在浏览器里走一遍投稿 → 后台查看代码 → 上架 → 下架。
const ADMIN = 'browser-admin-token';
const env = { MIRROR_BUCKET: new FakeR2(), ADMIN_TOKEN: ADMIN };
const pluginSource = "RPHubSDK.register({ id: 'browser-demo', name: '浏览器示例', version: '1.0.0', requiresApi: 4, init() {} });";
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
try {
    await page.goto(`${base}/workshop/submit`);
    await page.setInputFiles('#file', { name: 'browser-demo.js', mimeType: 'text/javascript', buffer: Buffer.from(pluginSource) });
    await page.fill('#name', '浏览器示例');
    await page.fill('#author', '测试作者');
    await page.fill('#description', '只用于测试');
    await page.click('#submit');
    await page.waitForFunction(() => document.querySelector('#result').textContent.includes('已提交'));
    assert.match(await page.textContent('#result'), /browser-demo v1\.0\.0/);
    console.log('PASS submit page uploads a plugin into review');

    await page.goto(`${base}/admin`);
    await page.fill('#adminToken', ADMIN);
    await page.click('#saveToken');
    await page.click('#workshopRefresh');
    await page.locator('.ws-view').waitFor();
    await page.click('.ws-view');
    await page.waitForFunction(() => document.querySelector('#workshopSource').textContent.includes('browser-demo'));
    await page.click('.ws-approve');
    await page.waitForFunction(() => document.querySelector('#workshopPluginsBody').textContent.includes('browser-demo'));
    assert.match(await page.textContent('#workshopPendingBody'), /没有待审核的投稿/);
    const index = await (await fetch(`${base}/workshop/index.json`)).json();
    assert.deepEqual(index.plugins.map((plugin) => plugin.id), ['browser-demo']);
    console.log('PASS admin page shows the source and publishes the submission');

    await page.click('.ws-remove');
    await page.waitForFunction(() => document.querySelector('#workshopPluginsBody').textContent.includes('工坊暂无插件'));
    assert.deepEqual(errors, []);
    console.log('PASS admin page removes a published plugin');
} finally {
    await browser.close();
    server.close();
}
