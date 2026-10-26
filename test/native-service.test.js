import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonCandidates = [
    process.env.PYTHON,
    process.platform === 'win32' ? 'python.exe' : 'python3',
    'python3',
    'python',
].filter(Boolean);
const python = pythonCandidates.find(candidate => (
    spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0
));

test('native service exposes health and requires its bearer token', {
    skip: python ? false : 'Python 3 is not available for the integration test',
}, async t => {
    const port = 35_000 + Math.floor(Math.random() * 1_000);
    const token = 'native-test-token';
    const child = spawn(
        python,
        ['-B', path.join(root, 'plugin', 'together-native', 'service.py')],
        {
            env: {
                ...process.env,
                NETEASE_NATIVE_SERVICE_HOST: '127.0.0.1',
                NETEASE_NATIVE_SERVICE_PORT: String(port),
                NETEASE_NATIVE_SERVICE_TOKEN: token,
                NETEASE_NATIVE_SERVICE_COOKIE: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    t.after(() => {
        if (child.exitCode === null) {
            child.kill('SIGTERM');
        }
    });

    let health;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            health = await fetch(`http://127.0.0.1:${port}/health`);
            break;
        } catch {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    assert.ok(health, 'service did not start');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
        ok: true,
        service: 'netease-companion-native',
        version: '1.0.0',
    });

    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/status`);
    assert.equal(unauthorized.status, 401);

    const status = await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(status.status, 200);
    const payload = await status.json();
    assert.equal(payload.success, true);
    assert.equal(payload.cookieConfigured, false);
    assert.equal(payload.capabilities.createRoom, true);
});
