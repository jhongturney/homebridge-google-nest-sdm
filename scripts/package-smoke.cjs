const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {stdio: 'inherit', ...options});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${command} failed (${result.status ?? result.signal})`);
    return result.stdout;
}

const homebridgeVersion = process.argv[2];
assert.match(homebridgeVersion ?? '', /^\d+\.\d+\.\d+$/, 'An exact Homebridge version is required');
const root = path.resolve(__dirname, '..');
const expected = require(path.join(root, 'package.json'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-package-smoke-'));

try {
    let archive = process.argv[3] && path.resolve(process.argv[3]);
    if (!archive) {
        const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], {
            cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']
        }));
        archive = path.join(temporary, packed[0].filename);
    }

    // Match the existing Pi update command. CI's npm ci separately exercises
    // install scripts; this isolated install intentionally skips ffmpeg setup.
    run('npm', ['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund',
        '--package-lock=false', archive, `homebridge@${homebridgeVersion}`], {cwd: temporary});

    // Resolve only from the isolated installation: workspace devDependencies
    // must not hide missing package contents or runtime dependencies.
    run(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const path = require('node:path');
        const {createRequire} = require('node:module');
        const installedRequire = createRequire(path.join(process.argv[1], 'package.json'));
        const metadata = installedRequire('homebridge-google-nest-sdm/package.json');
        assert.equal(metadata.version, process.argv[2]);
        const initialize = installedRequire('homebridge-google-nest-sdm');
        assert.equal(typeof initialize, 'function');
        let registrations = 0;
        initialize({registerPlatform(name, platform) {
            assert.equal(name, 'homebridge-google-nest-sdm');
            assert.equal(typeof platform, 'function');
            registrations++;
        }});
        assert.equal(registrations, 1);
        for (const name of ['google-logo.jpg', 'nest-logo.jpg']) {
            const resource = path.join(process.argv[1], 'node_modules', metadata.name, 'dist', 'res', name);
            assert.ok(fs.statSync(resource).size > 0, 'Missing packaged resource: ' + name);
        }
        console.log('Installed plugin ' + metadata.version + ' loads and registers successfully');
    `, temporary, expected.version], {cwd: temporary, env: {...process.env, NODE_PATH: ''}});
} finally {
    fs.rmSync(temporary, {recursive: true, force: true});
}
