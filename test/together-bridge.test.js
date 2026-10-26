import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isPrivateHost,
    normalizeRemoteUrl,
    safeErrorText,
} from '../plugin/together-bridge.js';

test('accepts private LAN, CGNAT, Tailscale and IPv6 hosts', () => {
    for (const host of [
        'localhost',
        '127.0.0.1',
        '10.20.30.40',
        '172.16.0.1',
        '192.168.1.2',
        '100.64.0.1',
        '100.127.255.254',
        '::1',
        'fd7a:115c:a1e0::1',
        'fe80::1',
        'poc.local',
    ]) {
        assert.equal(isPrivateHost(host), true, host);
    }
});

test('rejects public hosts, spoofed private prefixes and invalid IPv4', () => {
    for (const host of [
        'example.com',
        '10.example.com',
        'fd.example.com',
        '100.63.0.1',
        '100.128.0.1',
        '172.15.0.1',
        '172.32.0.1',
        '256.1.1.1',
    ]) {
        assert.equal(isPrivateHost(host), false, host);
    }
});

test('requires HTTPS for public bridge hosts', () => {
    assert.equal(
        normalizeRemoteUrl('https://music-bridge.example.com/'),
        'https://music-bridge.example.com',
    );
    assert.equal(
        normalizeRemoteUrl('http://100.100.1.2:3472/'),
        'http://100.100.1.2:3472',
    );
    assert.throws(
        () => normalizeRemoteUrl('http://example.com:3472'),
        error => error.status === 400,
    );
    assert.throws(
        () => normalizeRemoteUrl('ftp://example.com'),
        error => error.status === 400,
    );
});

test('removes secret-looking values from bridge errors', () => {
    const message = safeErrorText('MUSIC_U=secret; __csrf=token\nrequest failed');
    assert.equal(message, '[redacted]; [redacted] request failed');
});
