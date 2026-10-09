import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { chromium } from 'playwright';
import worker from '../worker.mjs';
import { fixture, title, content } from './public-fixture.mjs';

const { bucket, env } = fixture();
const server = http.createServer(async (request, response) => {
    try {
        const result = await worker.fetch(new Request('http://127.0.0.1' + request.url, { method: request.method }), env);
        response.writeHead(result.status, Object.fromEntries(result.headers));
        if (result.body) Readable.fromWeb(result.body).pipe(response);
        else response.end();
    } catch (error) { response.writeHead(500); response.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const errors = [];
await fs.mkdir('evidence', { recursive: true });
try {
    for (const mobile of [false, true]) {
        const context = await browser.newContext({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
            javaScriptEnabled: !mobile, colorScheme: mobile ? 'dark' : 'light'
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(base);
        await page.getByRole('link', { name: '查看公告' }).first().click();
        await page.waitForURL(/tag=1.9.6#announcement/);
        assert.equal(await page.locator('#announcement h3').textContent(), title);
        assert.equal(await page.locator('#announcement pre').textContent(), content);
        assert.equal(await page.locator('#announcement script, #announcement img').count(), 0);
        const bounds = await page.locator('#announcement').boundingBox();
        assert(bounds.width <= (mobile ? 390 : 1280));
        await page.screenshot({ path: 'evidence/public-' + (mobile ? 'mobile' : 'desktop') + '.png', fullPage: true });
        await page.getByRole('link', { name: '返回版本列表' }).click();
        assert.equal(await page.locator('#announcement').count(), 0);
        await page.getByRole('link', { name: '查看公告' }).nth(1).click();
        assert.match(await page.locator('#announcement').textContent(), /该版本暂无公告/);
        await context.close();
    }
    const page = await browser.newPage();
    await bucket.delete('_mirror/announcements.json');
    await page.goto(base + '/?tag=1.9.6#announcement');
    assert.match(await page.locator('#announcement').textContent(), /公告暂时无法读取/);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    assert.match(await page.locator('#announcement').textContent(), /公告暂时无法读取/);
    const restored = fixture().bucket.records.get('_mirror/announcements.json');
    bucket.seedText('_mirror/announcements.json', new TextDecoder().decode(restored.bytes));
    await page.getByRole('button', { name: '重试', exact: true }).click();
    assert.equal(await page.locator('#announcement pre').textContent(), content);
    assert.deepEqual(errors, []);
    assert.equal(bucket.putCalls.length, 0);
    console.log('Browser checks passed: desktop, mobile dark mode without JavaScript, safe complete text, empty state, retry, no writes.');
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
