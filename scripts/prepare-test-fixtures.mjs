import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 测试用的上游提交，放在 .cache/upstream/：
// - 新旧两个“通过”锚点：线上分发端已收录（补丁预检通过）的最新两个正式版本，自动跟随，不用手工更新；
//   分发端暂时不可用时沿用上次的锚点。
// - “拒绝”锚点：固定的历史提交，补丁必须拒绝它。
const directory = fileURLToPath(new URL('../.cache/upstream', import.meta.url));
const anchorsPath = `${directory}/anchors.json`;
const mirror = (process.env.MIRROR_BASE || 'https://update.rph.mornye.uk').replace(/\/+$/, '');
const REJECT_COMMIT = '936b47f6e992d77d61e20b93ef24360964372e9a';

async function resolveAnchors() {
    try {
        const response = await fetch(`${mirror}/manifest.json`, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const releases = (await response.json()).versions.filter((version) => /^\d+(?:\.\d+)+$/.test(version.tag));
        if (releases.length < 2) throw new Error('分发端清单里少于两个正式版本');
        return { new: { tag: releases[0].tag, commit: releases[0].commit }, old: { tag: releases[1].tag, commit: releases[1].commit }, reject: REJECT_COMMIT };
    } catch (error) {
        if (!fs.existsSync(anchorsPath)) throw new Error(`无法从分发端读取测试锚点：${error.message}`);
        console.warn(`分发端暂时不可用，沿用上次的测试锚点：${error.message}`);
        return JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
    }
}

fs.mkdirSync(directory, { recursive: true });
if (!fs.existsSync(directory + '/.git')) {
    execFileSync('git', ['init', '-q', directory], { stdio: 'inherit', windowsHide: true });
}
const anchors = await resolveAnchors();
for (const commit of [anchors.old.commit, anchors.new.commit, anchors.reject]) {
    const exists = spawnSync('git', ['-C', directory, 'cat-file', '-e', commit + '^{commit}'], { windowsHide: true });
    if (exists.error) throw exists.error;
    if (exists.status !== 0) {
        execFileSync('git', ['-C', directory, 'fetch', '--depth=1', 'https://github.com/STA1N156/RP-Hub.git', commit], {
            stdio: 'inherit', windowsHide: true
        });
    }
    execFileSync('git', ['-C', directory, 'cat-file', '-e', commit + '^{commit}'], { windowsHide: true });
}
fs.writeFileSync(anchorsPath, JSON.stringify(anchors, null, 2));
console.log(`Upstream test anchors ready: old ${anchors.old.tag}, new ${anchors.new.tag}, reject ${anchors.reject.slice(0, 7)}.`);
