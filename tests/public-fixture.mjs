import { FakeR2 } from './r2.mjs';

export const title = '<i>网站公告</i>';
export const content = '第一行\n<script>alert("untrusted")</script>\n<img src=x onerror=alert(1)>\n' + '完整公告正文。'.repeat(100);
export function fixture(tag = '1.9.6') {
    const bucket = new FakeR2();
    const version = { tag, commit: 'a'.repeat(40), date: '2026-09-20T00:00:00Z', publishedAt: 1789862400000, files: [{ path: 'index.html' }] };
    bucket.seedJson('manifest.json', {
        schema: 1, updatedAt: 1789862400000, upstreamRepo: 'STA1N156/RP-Hub',
        versions: [version, { ...version, tag: '1.9.5', commit: 'b'.repeat(40) }], pending: []
    });
    bucket.seedJson('_mirror/announcements.json', {
        generatedAt: 1789862400000,
        entries: [{ tag, commit: version.commit, announcement: { id: 10196, title, content } }]
    });
    return { bucket, env: { MIRROR_BUCKET: bucket, ADMIN_TOKEN: 'test-admin-only', GITHUB_TOKEN: 'test-github-only' } };
}
