import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_PATCH_IMPORT = /^import\s*\{\s*patchRpHubAppJs\s*,\s*RpHubAppPatchError\s*,\s*RP_HUB_APP_PATCH_REVISION\s*\}\s*from\s*['"]\.\/lib\/app-patches\.mjs['"]\s*;\s*/;
const MODULE_EXPORT = /^export\s+(const|class|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm;
const EXPECTED_MODULE_EXPORTS = [
    'const:RP_HUB_APP_PATH',
    'const:RP_HUB_APP_PATCH_REVISION',
    'const:APP_PATCH_MODES',
    'class:RpHubAppPatchError',
    'function:verifyRpHubAppJs',
    'function:patchRpHubAppJs'
];
const STATIC_IMPORT = /^\s*import\b/m;
const ANY_EXPORT = /^\s*export\s+/gm;
const DEFAULT_EXPORT = /^\s*export\s+default\b/gm;
// 测试要用的函数：打包时去掉 export，只保留 export default。
const SYNC_EXPORT_NAMES = ['syncMirror', 'syncTestReleases', 'submitWorkshopPlugin', 'readPluginManifest'];

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(scriptDirectory, '..');

function parseArguments(argv) {
    const options = {
        distRoot: path.join(sourceRoot, 'dist'),
        releaseRoot: path.join(sourceRoot, 'release')
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--dist') options.distRoot = path.resolve(argv[++index]);
        else if (argument === '--release-dir') options.releaseRoot = path.resolve(argv[++index]);
        else throw new Error(`Unknown argument: ${argument}`);
    }
    return options;
}

function assertExists(target, label) {
    if (!fs.existsSync(target)) throw new Error(`${label} does not exist: ${target}`);
}

function inlineAppPatcher(workerSource, patcherSource) {
    const importExpression = new RegExp(APP_PATCH_IMPORT.source, 'm');
    const importMatches = workerSource.match(new RegExp(APP_PATCH_IMPORT.source, 'gm')) || [];
    if (importMatches.length !== 1) {
        throw new Error('Expected exactly one ./lib/app-patches.mjs import at the start of worker.mjs.');
    }
    if (STATIC_IMPORT.test(patcherSource)) {
        throw new Error('lib/app-patches.mjs gained an import; mirror packaging must be adapted explicitly.');
    }

    const moduleExports = [...patcherSource.matchAll(MODULE_EXPORT)]
        .map((match) => `${match[1]}:${match[2]}`);
    if (JSON.stringify(moduleExports) !== JSON.stringify(EXPECTED_MODULE_EXPORTS)) {
        throw new Error(`Unexpected lib/app-patches.mjs exports: ${moduleExports.join(', ')}`);
    }
    const patcherBody = patcherSource.replace(MODULE_EXPORT, '$1 $2').trim();
    if (ANY_EXPORT.test(patcherBody)) {
        throw new Error('lib/app-patches.mjs contains an unsupported export form.');
    }

    const inlinedModule = [
        '// Inlined from lib/app-patches.mjs by scripts/package.mjs.',
        'const { patchRpHubAppJs, RpHubAppPatchError, RP_HUB_APP_PATCH_REVISION } = (() => {',
        patcherBody,
        'return { patchRpHubAppJs, RpHubAppPatchError, RP_HUB_APP_PATCH_REVISION };',
        '})();',
        ''
    ].join('\n');
    let bundled = workerSource.replace(importExpression, () => inlinedModule);
    for (const name of SYNC_EXPORT_NAMES) {
        const syncExport = new RegExp(`^export\\s+((?:async\\s+)?function\\s+${name})\\b`, 'gm');
        const syncExports = bundled.match(syncExport) || [];
        if (syncExports.length !== 1) {
            throw new Error(`Expected exactly one exported ${name}; found ${syncExports.length}.`);
        }
        bundled = bundled.replace(syncExport, '$1');
    }

    if (STATIC_IMPORT.test(bundled) || /\bimport\s*\(/.test(bundled)) {
        throw new Error('Bundled worker.js still contains an import statement.');
    }
    const exports = bundled.match(ANY_EXPORT) || [];
    const defaultExports = bundled.match(DEFAULT_EXPORT) || [];
    if (exports.length !== 1 || defaultExports.length !== 1) {
        throw new Error('Bundled worker.js must retain exactly one export default and no other exports.');
    }

    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
        input: bundled,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024
    });
    if (syntax.status !== 0) {
        throw new Error(`Bundled worker.js failed syntax validation:\n${syntax.stderr || syntax.stdout}`);
    }
    return bundled;
}

function packagedWrangler(source) {
    const mainMatches = source.match(/^main\s*=\s*['"][^'"]+['"]\s*$/gm) || [];
    if (mainMatches.length !== 1 || !/^main\s*=\s*['"]worker\.mjs['"]\s*$/m.test(source)) {
        throw new Error('wrangler.toml must contain exactly one main = "worker.mjs" entry.');
    }
    return source.replace(/^main\s*=\s*['"]worker\.mjs['"]\s*$/m, 'main = "worker.js"');
}

function deployReadme(sourceReadme) {
    return [
        '# RP-Hub mirror publisher deployment',
        '',
        'This package contains only the unified mirror publisher Worker.',
        'It does not contain or replace either site package.',
        '',
        '## Deploy',
        '',
        '1. Create a **private** `rp-hub-update-mirror` R2 bucket. Keep Public Access disabled and do not attach an R2 bucket domain.',
        '2. For a new installation, set required `GITHUB_TOKEN` and `ADMIN_TOKEN` secrets, plus optional `WEBHOOK_URL` and `WEBHOOK_TOKEN`, then run `npx wrangler deploy`.',
        '3. In Worker Settings > Domains & Routes, bind the Custom Domain `update.rph.mornye.uk`.',
        '4. Update the existing mirror Worker with this package. Verify `/`, the public announcement links, and `/manifest.json`. Use `/admin` for management.',
        '5. Keep the existing R2 binding and secrets. Main site packages are deployed separately.',
        '',
        'No deployment was performed while creating this package.',
        '',
        '---',
        '',
        sourceReadme.trim(),
        ''
    ].join('\n');
}

function scanForSensitiveValues(root) {
    const patterns = [
        { label: 'Cloudflare API token', expression: /cfat_[A-Za-z0-9_-]{20,}/ },
        { label: 'assigned secret value', expression: /(?:GITHUB_TOKEN|WEBHOOK_URL|WEBHOOK_TOKEN|ADMIN_TOKEN)\s*=\s*['"][^'"]+['"]/ }
    ];
    const findings = [];
    for (const file of fs.readdirSync(root)) {
        const absolute = path.join(root, file);
        if (!fs.statSync(absolute).isFile()) continue;
        const text = fs.readFileSync(absolute, 'utf8');
        for (const pattern of patterns) {
            if (pattern.expression.test(text)) findings.push(`${pattern.label}: ${file}`);
        }
    }
    if (findings.length) throw new Error(`Sensitive-value scan failed:\n${findings.join('\n')}`);
}

function formatTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join('');
}

function powershellLiteral(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

function createZip(distRoot, releaseRoot) {
    fs.mkdirSync(releaseRoot, { recursive: true });
    const timestamp = formatTimestamp();
    const zipPath = path.join(releaseRoot, `RP-Hub-update-mirror-publisher-${timestamp}.zip`);
    const temporaryZip = path.join(releaseRoot, `.RP-Hub-update-mirror-publisher-${timestamp}-${process.pid}.tmp.zip`);
    fs.rmSync(temporaryZip, { force: true });
    try {
        const command = [
            "$ErrorActionPreference = 'Stop'",
            `Compress-Archive -Path (Join-Path ${powershellLiteral(distRoot)} '*') -DestinationPath ${powershellLiteral(temporaryZip)} -CompressionLevel Optimal -Force`
        ].join('; ');
        execFileSync('powershell.exe', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            command
        ], { stdio: 'pipe', windowsHide: true });
        if (!fs.existsSync(temporaryZip) || fs.statSync(temporaryZip).size === 0) {
            throw new Error('Compress-Archive did not produce a non-empty ZIP.');
        }
        fs.rmSync(zipPath, { force: true });
        fs.renameSync(temporaryZip, zipPath);
        return zipPath;
    } finally {
        fs.rmSync(temporaryZip, { force: true });
    }
}

function buildDist(distRoot) {
    const stageRoot = path.join(path.dirname(distRoot), `.rph-mirror-stage-${process.pid}-${Date.now()}`);
    fs.rmSync(stageRoot, { recursive: true, force: true });
    try {
        fs.mkdirSync(stageRoot, { recursive: true });
        const workerFile = path.join(sourceRoot, 'worker.mjs');
        const patcherFile = path.join(sourceRoot, 'lib', 'app-patches.mjs');
        const wranglerFile = path.join(sourceRoot, 'wrangler.toml');
        const readmeFile = path.join(sourceRoot, 'README.md');
        for (const [file, label] of [
            [workerFile, 'Mirror Worker'],
            [patcherFile, 'App patcher'],
            [wranglerFile, 'Mirror Wrangler config'],
            [readmeFile, 'Mirror README']
        ]) assertExists(file, label);

        fs.writeFileSync(
            path.join(stageRoot, 'worker.js'),
            inlineAppPatcher(fs.readFileSync(workerFile, 'utf8'), fs.readFileSync(patcherFile, 'utf8')),
            'utf8'
        );
        fs.writeFileSync(
            path.join(stageRoot, 'wrangler.toml'),
            packagedWrangler(fs.readFileSync(wranglerFile, 'utf8')),
            'utf8'
        );
        fs.writeFileSync(
            path.join(stageRoot, 'README-DEPLOY.md'),
            deployReadme(fs.readFileSync(readmeFile, 'utf8')),
            'utf8'
        );
        scanForSensitiveValues(stageRoot);

        const entries = fs.readdirSync(stageRoot).sort();
        if (JSON.stringify(entries) !== JSON.stringify(['README-DEPLOY.md', 'worker.js', 'wrangler.toml'])) {
            throw new Error(`Unexpected mirror package entries: ${entries.join(', ')}`);
        }
        fs.rmSync(distRoot, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(distRoot), { recursive: true });
        fs.renameSync(stageRoot, distRoot);
        return entries;
    } finally {
        fs.rmSync(stageRoot, { recursive: true, force: true });
    }
}

function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    const entries = buildDist(options.distRoot);
    const zipPath = createZip(options.distRoot, options.releaseRoot);
    process.stdout.write(`${JSON.stringify({
        ok: true,
        dist: options.distRoot,
        zip: zipPath,
        entries,
        zipBytes: fs.statSync(zipPath).size
    }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
