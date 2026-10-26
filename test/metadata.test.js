import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('keeps manifest, package and config on the native namespace', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const packageJson = JSON.parse(read('plugin/package.json'));
    const config = JSON.parse(read('plugin/config.example.json'));
    const frontend = read('index.js');
    const backend = read('plugin/index.js');

    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.homePage.endsWith('SillyTavern-Netease-Music-Companion-Native'), true);
    assert.equal(packageJson.version, '1.0.0');
    assert.equal(packageJson.name, 'sillytavern-netease-music-companion-native');
    assert.equal(config.togetherNative.port, 3472);
    assert.equal(config.togetherNative.autoStart, false);
    assert.match(frontend, /\/api\/plugins\/netease-music-native/);
    assert.match(frontend, /neteaseMusicCompanionNative/);
    assert.match(frontend, /nmcnativeTogetherMode/);
    assert.match(frontend, /\/together\/native\/create/);
    assert.match(backend, /id: 'netease-music-native'/);
    assert.match(backend, /togetherNative/);
    assert.doesNotMatch(backend, /id: 'netease-music'/);
});
