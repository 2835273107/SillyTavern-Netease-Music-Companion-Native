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
    const service = read('plugin/together-native/service.py');

    assert.equal(manifest.version, '1.5.1');
    assert.equal(manifest.homePage.endsWith('SillyTavern-Netease-Music-Companion-Native'), true);
    assert.equal(packageJson.version, '1.5.1');
    assert.match(frontend, /nmcnativePlayerLyrics/);
    assert.match(backend, /\/song-audio\/:songId/);
    assert.match(backend, /\/together\/send-message/);
    assert.match(backend, /\/together\/room-playlist/);
    assert.match(backend, /\/song-comments\/:songId/);
    assert.match(service, /\/v1\/rooms\/playlist/);
    assert.match(backend, /\/player\/playlist-tracks\/:playlistId/);
    assert.match(frontend, /nmcnativePlayerPlaylistTrack/);
    assert.match(frontend, /data-nmcnative-player-source/);
    assert.match(frontend, /characterWorldbookContext/);
    assert.match(frontend, /WORLDBOOK_CONTEXT_LIMIT = 6000/);
    assert.doesNotMatch(frontend, /\.scrollIntoView\(/);
    assert.match(frontend, /data-nmcnative-tab/);
    assert.match(frontend, /ToolManager\.registerFunctionTool/);
    assert.match(frontend, /characterCommentOnSong/);
    assert.match(frontend, /playNextPlayerSong/);
    assert.match(backend, /\/song-info\/:songId/);
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
