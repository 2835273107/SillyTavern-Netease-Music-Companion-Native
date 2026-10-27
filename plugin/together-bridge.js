import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HEALTH_TIMEOUT_MS = 15_000;
const SERVICE_SCRIPT = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'together-native',
    'service.py',
);

export class TogetherBridgeError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.name = 'TogetherBridgeError';
        this.status = status;
    }
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function safeErrorText(value) {
    return String(value || '')
        .replace(/(?:MUSIC_U|__csrf)=[^;\s]+/gi, '[redacted]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
}

export function isPrivateHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.local')) {
        return true;
    }
    if (
        host === '::1'
        || (
            host.includes(':')
            && (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host))
        )
    ) {
        return true;
    }
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) {
        return false;
    }
    const octets = match.slice(1).map(Number);
    if (octets.some(octet => octet > 255)) {
        return false;
    }
    const [first, second] = octets;
    if (first === 127 || first === 10 || (first === 192 && second === 168)) {
        return true;
    }
    // Tailscale assigns IPv4 addresses from the 100.64.0.0/10 CGNAT range.
    if (first === 100 && second >= 64 && second <= 127) {
        return true;
    }
    return first === 172 && second >= 16 && second <= 31;
}

export function normalizeRemoteUrl(value) {
    let parsed;
    try {
        parsed = new URL(String(value || '').trim());
    } catch {
        throw new TogetherBridgeError('remoteUrl 不是有效 URL', 400);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new TogetherBridgeError('远程一起听服务仅支持 HTTP 或 HTTPS', 400);
    }
    if (parsed.protocol === 'http:' && !isPrivateHost(parsed.hostname)) {
        throw new TogetherBridgeError('公网一起听服务必须使用 HTTPS；HTTP 仅允许本机或私有网段', 400);
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
}

export class TogetherBridge {
    constructor() {
        this.service = null;
    }

    async health(service = this.service) {
        if (!service) {
            return false;
        }
        try {
            const response = await fetch(`${service.baseUrl}/health`, {
                signal: AbortSignal.timeout(1500),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    async request(route, { method = 'GET', body } = {}) {
        const service = this.service;
        if (!service || !(await this.health(service))) {
            throw new TogetherBridgeError('独立一起听服务未启动，请检查 together-native', 503);
        }
        const response = await fetch(`${service.baseUrl}${route}`, {
            method,
            cache: 'no-store',
            headers: {
                Authorization: `Bearer ${service.token}`,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(45_000),
        });
        const text = await response.text();
        let payload;
        try {
            payload = text ? JSON.parse(text) : {};
        } catch {
            throw new TogetherBridgeError('独立一起听服务返回了无法解析的响应');
        }
        if (!response.ok) {
            throw new TogetherBridgeError(
                safeErrorText(payload.error || payload.message) || `独立一起听服务请求失败 (${response.status})`,
                response.status >= 400 ? response.status : 502,
            );
        }
        if (payload.success === false) {
            throw new TogetherBridgeError(
                safeErrorText(payload.message) || '独立一起听服务操作失败',
                /does not match|不一致/i.test(payload.message || '') ? 409 : 502,
            );
        }
        return payload;
    }

    async startService({
        accountId,
        cookie,
        targetUserId,
        pythonPath,
        apiBase,
        appPath,
        debugPort = 9222,
        preferredPort = 3472,
        remoteUrl = '',
        remoteToken = '',
        forceRestart = false,
    }) {
        const normalizedRemoteUrl = remoteUrl ? normalizeRemoteUrl(remoteUrl) : '';
        const serviceMatchesTarget = this.service && (
            normalizedRemoteUrl
                ? this.service.transport === 'remote-http'
                    && this.service.baseUrl === normalizedRemoteUrl
                    && this.service.token === remoteToken
                : this.service.transport !== 'remote-http'
        );
        if (
            serviceMatchesTarget
            && this.service.accountId === accountId
            && !forceRestart
            && await this.health()
        ) {
            return this.describe();
        }
        await this.stopService();

        if (!cookie) {
            throw new TogetherBridgeError('当前账号未登录，无法启动独立一起听服务', 409);
        }
        if (normalizedRemoteUrl) {
            if (!remoteToken) {
                throw new TogetherBridgeError('使用远程一起听服务时必须配置 remoteToken', 400);
            }
            const service = {
                accountId,
                baseUrl: normalizedRemoteUrl,
                token: remoteToken,
                transport: 'remote-http',
            };
            this.service = service;
            if (!(await this.health(service))) {
                this.service = null;
                throw new TogetherBridgeError('无法连接远程一起听服务，请检查 remoteUrl、Token、HTTPS 和服务状态', 503);
            }
            try {
                // /health is intentionally public; an authenticated status call
                // validates the token before the service is reported as ready.
                await this.getStatus();
            } catch (error) {
                this.service = null;
                throw error;
            }
            return this.describe();
        }
        if (!fs.existsSync(SERVICE_SCRIPT)) {
            throw new TogetherBridgeError('未找到内置一起听服务，请重新安装插件', 503);
        }

        let lastError = '';
        for (let offset = 0; offset < 6; offset += 1) {
            const port = Number(preferredPort) + offset;
            const token = crypto.randomBytes(32).toString('hex');
            const child = spawn(
                String(pythonPath || 'python'),
                ['-B', 'service.py'],
                {
                    cwd: path.dirname(SERVICE_SCRIPT),
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: {
                        ...process.env,
                        PYTHONUNBUFFERED: '1',
                        NETEASE_NATIVE_SERVICE_COOKIE: cookie,
                        NETEASE_NATIVE_SERVICE_API_BASE: String(apiBase || ''),
                        NETEASE_NATIVE_SERVICE_RECEIVER_ID: String(targetUserId || ''),
                        NETEASE_NATIVE_SERVICE_CLIENT_PATH: String(appPath || ''),
                        NETEASE_NATIVE_SERVICE_CDP_PORT: String(debugPort),
                        NETEASE_NATIVE_SERVICE_HOST: '127.0.0.1',
                        NETEASE_NATIVE_SERVICE_PORT: String(port),
                        NETEASE_NATIVE_SERVICE_TOKEN: token,
                    },
                },
            );
            const service = {
                accountId,
                child,
                port,
                token,
                transport: 'native-http',
                baseUrl: `http://127.0.0.1:${port}`,
                lastError: '',
            };
            this.service = service;

            child.stdout.on('data', () => {});
            child.stderr.on('data', chunk => {
                service.lastError = safeErrorText(chunk);
            });
            child.once('exit', () => {
                if (this.service === service) {
                    this.service = null;
                }
            });

            lastError = '';
            const deadline = Date.now() + HEALTH_TIMEOUT_MS;
            while (Date.now() < deadline) {
                if (child.exitCode !== null) {
                    lastError = service.lastError || `Native service exited with code ${child.exitCode}`;
                    break;
                }
                if (await this.health(service)) {
                    return this.describe();
                }
                await wait(250);
            }
            if (!lastError) {
                lastError = service.lastError || `Native service did not become healthy on port ${port}`;
            }
            this.stopServiceNow(service);
            if (this.service === service) {
                this.service = null;
            }
        }

        throw new TogetherBridgeError(
            safeErrorText(lastError) || '独立一起听服务启动失败',
            503,
        );
    }

    async createRoom() {
        return this.request('/v1/rooms/create', { method: 'POST', body: {} });
    }

    async getStatus() {
        return this.request('/v1/status');
    }

    async closeRoom() {
        return this.request('/v1/rooms/close', { method: 'POST', body: {} });
    }

    async getRoomPlaylist() {
        return this.request('/v1/rooms/playlist');
    }

    async addRoomTrack(trackId) {
        return this.request('/v1/rooms/add', {
            method: 'POST',
            body: { trackId: String(trackId) },
        });
    }

    async playRoomTrack(trackId) {
        return this.request('/v1/rooms/play', {
            method: 'POST',
            body: { trackId: String(trackId) },
        });
    }

    async controlRoom(command) {
        return this.request('/v1/rooms/control', {
            method: 'POST',
            body: { command: String(command) },
        });
    }

    describe() {
        if (!this.service) {
            return { running: false, source: 'native' };
        }
        return {
            running: true,
            source: 'native',
            accountId: this.service.accountId,
            port: this.service.port,
            transport: this.service.transport,
            remote: this.service.transport === 'remote-http',
        };
    }

    stopServiceNow(service) {
        if (!service?.child || service.child.exitCode !== null) {
            return;
        }
        try {
            service.child.kill('SIGTERM');
        } catch {
            try {
                service.child.kill();
            } catch {
                // The process may already have exited.
            }
        }
    }

    async stopService() {
        const service = this.service;
        this.service = null;
        if (!service || !service.child) {
            return;
        }
        this.stopServiceNow(service);
        const deadline = Date.now() + 3000;
        while (service.child.exitCode === null && Date.now() < deadline) {
            await wait(100);
        }
        if (service.child.exitCode === null) {
            try {
                service.child.kill('SIGKILL');
            } catch {
                // Best effort during shutdown.
            }
        }
    }
}
