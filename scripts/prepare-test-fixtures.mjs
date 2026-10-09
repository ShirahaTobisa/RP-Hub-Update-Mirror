import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../.cache/upstream', import.meta.url));
const commits = [
    '53a8d80951e594e717b8081873b2f77eb809d0fc',
    'ed372012fde428499d024ac3623902b754af7721',
    '936b47f6e992d77d61e20b93ef24360964372e9a'
];
fs.mkdirSync(directory, { recursive: true });
if (!fs.existsSync(directory + '/.git')) {
    execFileSync('git', ['init', '-q', directory], { stdio: 'inherit', windowsHide: true });
}
for (const commit of commits) {
    const exists = spawnSync('git', ['-C', directory, 'cat-file', '-e', commit + '^{commit}'], { windowsHide: true });
    if (exists.error) throw exists.error;
    if (exists.status !== 0) {
        execFileSync('git', ['-C', directory, 'fetch', '--depth=1', 'https://github.com/STA1N156/RP-Hub.git', commit], {
            stdio: 'inherit', windowsHide: true
        });
    }
    execFileSync('git', ['-C', directory, 'cat-file', '-e', commit + '^{commit}'], { windowsHide: true });
}
console.log('Pinned upstream test fixtures ready.');
