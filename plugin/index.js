import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { TogetherBridge } from './together-bridge.js';

export const info = {
    id: 'netease-music-native',
    name: 'Netease Music Companion Native',
    description: 'Independent native with secure multi-account controls and native Listen Together integration.',
};

const PLUGIN_DIR = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(PLUGIN_DIR, 'config.json');
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_]{1,32}$/;
const DEFAULT_API_BASE = 'http://localhost:3000';
const MAX_TRACKS_PER_REQUEST = 20;
const REQUEST_TIMEOUT_MS = 20_000;

let settings = null;
let uidCache = new Map();
let roomCache = new Map();
const nativeBridge = new TogetherBridge();
let shutdownHookBound = false;

class PublicError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'PublicError';
        this.status = status;
    }
}

function cleanText(value, maxLength = 200) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function emptyAccount(label = '默认账号') {
    return {
        music_u: '',
        csrf: '',
        label,
        nickname: '',
        userId: '',
        currentPlaylist: { id: '', name: '' },
    };
}

function normalizePlaylist(value) {
    return {
        id: cleanText(value?.id, 80),
        name: cleanText(value?.name, 200),
    };
}

function normalizeAccount(value, fallbackLabel = '默认账号') {
    const account = value && typeof value === 'object' ? value : {};
    return {
        music_u: cleanText(account.music_u, 4096),
        csrf: cleanText(account.csrf, 512),
        label: cleanText(account.label, 80) || fallbackLabel,
        nickname: cleanText(account.nickname, 80),
        userId: cleanText(account.userId, 80),
        currentPlaylist: normalizePlaylist(account.currentPlaylist),
    };
}

function normalizeApiBase(value) {
    const text = cleanText(value, 500) || DEFAULT_API_BASE;
    let parsed;
    try {
        parsed = new URL(text);
    } catch {
        throw new PublicError('api_base 不是有效 URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new PublicError('api_base 仅支持 http 或 https');
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
}

function writeConfig() {
    const serialized = `${JSON.stringify(settings, null, 2)}\n`;
    const temporaryFile = `${CONFIG_FILE}.tmp`;
    fs.mkdirSync(PLUGIN_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryFile, serialized, { mode: 0o600 });
    try {
        fs.chmodSync(temporaryFile, 0o600);
    } catch {
        // Some Windows and shared filesystems do not implement POSIX modes.
    }
    try {
        fs.renameSync(temporaryFile, CONFIG_FILE);
    } catch {
        fs.rmSync(CONFIG_FILE, { force: true });
        fs.renameSync(temporaryFile, CONFIG_FILE);
    }
}

function loadAndNormalizeConfig() {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true, mode: 0o700 });

    let raw = {};
    let shouldWrite = false;
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        } catch {
            throw new Error('config.json 无法解析，请先修复或移走该文件');
        }
    } else {
        shouldWrite = true;
    }

    let accounts;
    if (!raw.accounts || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts)) {
        const legacyMusicU = cleanText(raw.music_u, 4096);
        const legacyCsrf = cleanText(raw.csrf, 512);
        const envMusicU = cleanText(process.env.NETEASE_NATIVE_MUSIC_U, 4096);
        const envCsrf = cleanText(process.env.NETEASE_NATIVE_CSRF, 512);

        if (legacyMusicU) {
            accounts = {
                default: {
                    ...emptyAccount(cleanText(raw.charName, 80) || '默认账号'),
                    music_u: legacyMusicU,
                    csrf: legacyCsrf,
                    currentPlaylist: normalizePlaylist(raw.currentPlaylist),
                },
            };
        } else if (envMusicU || envCsrf) {
            accounts = {
                default: {
                    ...emptyAccount('环境变量账号'),
                    music_u: envMusicU,
                    csrf: envCsrf,
                },
            };
        } else {
            accounts = { default: emptyAccount() };
        }
        shouldWrite = true;
    } else {
        accounts = {};
        for (const [accountId, account] of Object.entries(raw.accounts)) {
            if (!ACCOUNT_ID_PATTERN.test(accountId)) {
                shouldWrite = true;
                continue;
            }
            accounts[accountId] = normalizeAccount(account, accountId);
        }
        if (Object.keys(accounts).length === 0) {
            accounts.default = emptyAccount();
            shouldWrite = true;
        }
    }

    let activeAccountId = cleanText(raw.activeAccountId, 32);
    if (!ACCOUNT_ID_PATTERN.test(activeAccountId) || !accounts[activeAccountId]) {
        activeAccountId = Object.keys(accounts)[0];
        shouldWrite = true;
    }

    const rawNative = raw.togetherNative && typeof raw.togetherNative === 'object'
        ? raw.togetherNative
        : raw.togetherPoc && typeof raw.togetherPoc === 'object'
            ? raw.togetherPoc
        : {};
    if (raw.togetherPoc && !raw.togetherNative) {
        shouldWrite = true;
    }
    const normalized = {
        api_base: normalizeApiBase(raw.api_base),
        accounts,
        activeAccountId,
        user_netease_id: cleanText(raw.user_netease_id, 80),
        enableTogetherListen: raw.enableTogetherListen === true,
        togetherNative: {
            autoStart: rawNative.autoStart === true,
            pythonPath: cleanText(rawNative.pythonPath, 1000),
            appPath: cleanText(rawNative.appPath, 1000),
            debugPort: Number.isInteger(Number(rawNative.debugPort)) ? Number(rawNative.debugPort) : 9222,
            port: Number.isInteger(Number(rawNative.port)) ? Number(rawNative.port) : 3472,
            remoteUrl: cleanText(process.env.NETEASE_NATIVE_NATIVE_URL || rawNative.remoteUrl, 1000),
            remoteToken: cleanText(process.env.NETEASE_NATIVE_NATIVE_TOKEN || rawNative.remoteToken, 1000),
        },
    };

    settings = normalized;
    if (shouldWrite) {
        writeConfig();
    }
}

function getActiveAccount() {
    const accountId = settings?.activeAccountId;
    if (!accountId || !settings?.accounts?.[accountId]) {
        throw new PublicError('没有可用的活动账号', 409);
    }
    return { accountId, account: settings.accounts[accountId] };
}

function accountCookie(account) {
    let musicU = cleanText(account?.music_u, 4096);
    let csrf = cleanText(account?.csrf, 512);

    if (!musicU) {
        musicU = cleanText(process.env.NETEASE_NATIVE_MUSIC_U, 4096);
        csrf = csrf || cleanText(process.env.NETEASE_NATIVE_CSRF, 512);
    }
    if (!musicU) {
        return '';
    }

    const parts = [`MUSIC_U=${musicU.replace(/[;\r\n]/g, '')}`];
    if (csrf) {
        parts.push(`__csrf=${csrf.replace(/[;\r\n]/g, '')}`);
    }
    return parts.join('; ');
}

function activeCookieOrThrow() {
    const { account } = getActiveAccount();
    const cookie = accountCookie(account);
    if (!cookie) {
        throw new PublicError('未登录或 Cookie 失效', 401);
    }
    return cookie;
}

function publicAccounts() {
    return Object.entries(settings.accounts).map(([id, account]) => ({
        id,
        label: account.label,
        nickname: account.nickname,
        active: id === settings.activeAccountId,
    }));
}

function getApiBase() {
    return normalizeApiBase(process.env.NETEASE_NATIVE_API_BASE || settings.api_base);
}

function buildFixedUrl(endpoint, params = {}) {
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/') || endpoint.startsWith('//')) {
        throw new PublicError('内部接口路径无效', 500);
    }
    const url = new URL(endpoint, `${getApiBase()}/`);
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') {
            continue;
        }
        url.searchParams.set(key, String(value));
    }
    return url;
}

async function requestNetease(endpoint, { method = 'GET', params = {}, cookie = '' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const upperMethod = String(method).toUpperCase();
        const payload = { ...params };
        if (cookie) {
            payload.cookie = cookie;
        }

        const url = buildFixedUrl(endpoint, upperMethod === 'GET' ? payload : {});
        const response = await fetch(url, {
            method: upperMethod,
            headers: upperMethod === 'GET' ? { Accept: 'application/json' } : {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: upperMethod === 'GET' ? undefined : JSON.stringify(payload),
            signal: controller.signal,
        });

        const text = await response.text();
        let body;
        try {
            body = text ? JSON.parse(text) : {};
        } catch {
            throw new PublicError('NeteaseCloudMusicApi 返回了无法解析的响应', 502);
        }
        if (!response.ok) {
            const upstreamMessage = cleanText(body?.message || body?.error, 240);
            throw new PublicError(upstreamMessage || `NeteaseCloudMusicApi 请求失败 (${response.status})`, 502);
        }
        const setCookies = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : [];
        return { body, setCookies };
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new PublicError('NeteaseCloudMusicApi 请求超时', 504);
        }
        if (error instanceof PublicError) {
            throw error;
        }
        throw new PublicError('无法连接 NeteaseCloudMusicApi，请确认服务已启动', 502);
    } finally {
        clearTimeout(timer);
    }
}

function upstreamData(body) {
    return body && typeof body === 'object' && body.data !== undefined ? body.data : body;
}

function extractProfile(body) {
    const data = upstreamData(body) || {};
    const profile = data.profile || body?.profile || {};
    const account = data.account || body?.account || {};
    return {
        nickname: cleanText(profile.nickname || account.nickname, 80),
        userId: cleanText(profile.userId || account.userId || account.id, 80),
    };
}

function findCookieValue(cookieText, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(cookieText || '').match(new RegExp(`(?:^|[;,\\s])${escaped}=([^;,\\s]+)`, 'i'));
    return match?.[1] || '';
}

function extractLoginCookies(body, setCookies) {
    const flatten = (value) => {
        if (Array.isArray(value)) {
            return value.map(flatten).join(';');
        }
        return typeof value === 'string' ? value : '';
    };
    const cookieText = [
        ...(Array.isArray(setCookies) ? setCookies : []),
        flatten(body?.cookie),
        flatten(body?.data?.cookie),
    ].join(';');
    return {
        musicU: findCookieValue(cookieText, 'MUSIC_U'),
        csrf: findCookieValue(cookieText, '__csrf'),
    };
}

function parseLyricSnippet(lyric = '') {
    return String(lyric)
        .split(/\r?\n/)
        .map(line => line.replace(/^\[[^\]]+\]\s*/, '').trim())
        .filter(line => line && !/^\[[^\]]+\]$/.test(line) && !/^(作词|作曲|编曲|制作人|混音|母带|出品)\s*[:：]/.test(line))
        .slice(0, 8)
        .join('\n');
}

function normalizeTrackIds(input) {
    if (!Array.isArray(input)) {
        throw new PublicError('track_ids 必须是数组');
    }
    const normalized = [];
    const seen = new Set();
    for (const value of input) {
        const id = cleanText(value, 80);
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        normalized.push(id);
    }
    const truncated = normalized.length > MAX_TRACKS_PER_REQUEST;
    return {
        ids: normalized.slice(0, MAX_TRACKS_PER_REQUEST),
        truncated,
        originalUniqueCount: normalized.length,
    };
}

async function resolveSongPlaybackUrl(songId, cookie, level = 'standard') {
    const { body } = await requestNetease('/song/url/v1', {
        params: {
            id: songId,
            level: ['standard', 'higher', 'exhigh', 'lossless'].includes(level)
                ? level
                : 'standard',
        },
        cookie,
    });
    const data = Array.isArray(body?.data)
        ? body.data
        : Array.isArray(upstreamData(body)?.data)
            ? upstreamData(body).data
            : [];
    const url = cleanText(data[0]?.url, 2000);
    if (!url) {
        throw new PublicError('网易云未返回可播放地址，歌曲可能需要会员、已下架或当前账号无权播放', 502);
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new PublicError('网易云返回了无效的歌曲地址', 502);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new PublicError('网易云返回了不支持的歌曲地址协议', 502);
    }
    return {
        url: parsed.toString(),
        type: cleanText(data[0]?.type, 40),
        level: cleanText(data[0]?.level, 40),
        size: Number(data[0]?.size) || 0,
    };
}

function normalIdList(value) {
    const source = value?.result ?? value?.list ?? value;
    if (!Array.isArray(source)) {
        return [];
    }
    return [...new Set(source
        .map(item => cleanText(item?.songId ?? item?.id ?? item, 80))
        .filter(id => /^\d{1,20}$/.test(id)))];
}

async function getTogetherSnapshot(accountId, cookie) {
    const { body: statusBody } = await requestNetease('/listentogether/status', { cookie });
    const current = parseCurrentSong(statusBody);
    const cached = roomCache.get(accountId);
    const roomId = cleanText(cached?.roomId || current.roomId, 240);
    if (!roomId) {
        throw new PublicError('当前不在一起听房间中', 409);
    }
    const { body: syncBody } = await requestNetease('/listentogether/sync/playlist/get', {
        method: 'POST',
        params: { roomId },
        cookie,
    });
    const data = upstreamData(syncBody) || {};
    const playlist = data.playlist || {};
    const displayList = normalIdList(playlist.displayList);
    const randomList = normalIdList(playlist.randomList);
    return {
        roomId,
        current,
        playlist,
        displayList,
        randomList: randomList.length ? randomList : displayList,
        playCommand: data.playCommand || data.playInfo || {},
        versions: Array.isArray(playlist.version)
            ? playlist.version.map(item => ({
                userId: cleanText(item?.userId, 80),
                version: Number(item?.version) || 0,
            }))
            : [],
    };
}

async function roomPlaylistResponse(accountId, cookie) {
    const snapshot = await getTogetherSnapshot(accountId, cookie);
    const ids = snapshot.displayList.slice(0, 100);
    let songs = [];
    if (ids.length) {
        const detail = await requestNetease('/song/detail', {
            params: { ids: ids.join(',') },
            cookie,
        });
        const rawSongs = upstreamData(detail.body)?.songs || detail.body?.songs || [];
        const byId = new Map(rawSongs.map(song => [String(song.id), song]));
        songs = ids.map(id => {
            const song = byId.get(id) || {};
            const artists = song.ar || song.artists || [];
            return {
                id,
                name: cleanText(song.name, 200) || `歌曲 ${id}`,
                artist: artists.map(item => item.name).filter(Boolean).join(', '),
                album: cleanText(song.al?.name || song.album?.name, 200),
                duration: Number(song.dt || song.duration) || 0,
            };
        });
    }
    return {
        roomId: snapshot.roomId,
        songs,
        currentSongId: cleanText(
            snapshot.playCommand.targetSongId || snapshot.current.songId,
            80,
        ),
        playStatus: cleanText(snapshot.playCommand.playStatus, 40),
        progress: Number(snapshot.playCommand.progress) || 0,
        clientSeq: Number(snapshot.playCommand.clientSeq) || 0,
    };
}

function normalizeRoomPlayStatus(value) {
    const text = String(value ?? '').toUpperCase();
    if (text === '2' || text === 'PLAY') {
        return 'PLAY';
    }
    if (text === '1' || text === 'PAUSE') {
        return 'PAUSE';
    }
    return text;
}

async function nativeRoomPlaylistResponse(cookie) {
    const state = await nativeBridge.getRoomPlaylist();
    const ids = Array.isArray(state.trackIds)
        ? state.trackIds.map(id => cleanText(id, 80)).filter(Boolean)
        : [];
    let songs = [];
    if (ids.length) {
        const detail = await requestNetease('/song/detail', {
            params: { ids: ids.join(',') },
            cookie,
        });
        const rawSongs = upstreamData(detail.body)?.songs || detail.body?.songs || [];
        const byId = new Map(rawSongs.map(song => [String(song.id), song]));
        songs = ids.map(id => {
            const song = byId.get(id) || {};
            return {
                id,
                name: cleanText(song.name, 200) || `歌曲 ${id}`,
                artist: (song.ar || song.artists || [])
                    .map(item => item.name)
                    .filter(Boolean)
                    .join(', '),
                album: cleanText(song.al?.name || song.album?.name, 200),
                duration: Number(song.dt || song.duration) || 0,
            };
        });
    }
    return {
        roomId: '',
        songs,
        currentSongId: cleanText(state.currentSongId, 80),
        playStatus: normalizeRoomPlayStatus(state.playStatus),
        progress: Number(state.progress) || 0,
        clientSeq: Number(state.clientSeq) || 0,
    };
}

async function replaceTogetherRoomPlaylist(accountId, cookie, nextIds) {
    const snapshot = await getTogetherSnapshot(accountId, cookie);
    const { account } = getActiveAccount();
    const userId = cleanText(account.userId, 80);
    if (!userId) {
        throw new PublicError('当前账号缺少网易云数字用户 ID，请重新检查登录状态');
    }
    const versions = snapshot.versions.map(item => ({ ...item }));
    const mine = versions.find(item => item.userId === userId);
    if (mine) {
        mine.version += 1;
    } else {
        versions.push({ userId, version: 1 });
    }
    const displayList = [...new Set(nextIds)];
    await requestNetease('/api', {
        method: 'POST',
        params: {
            uri: '/api/listen/together/sync/list/command/report',
            crypto: 'eapi',
            data: JSON.stringify({
                roomId: snapshot.roomId,
                playlistParam: JSON.stringify({
                    commandType: 'REPLACE',
                    version: versions,
                    anchorSongId: '',
                    anchorPosition: -1,
                    playMode: 'ORDER_LOOP',
                    randomList: displayList,
                    displayList,
                }),
            }),
        },
        cookie,
    });
    return { ...snapshot, displayList, versions };
}

async function playTogetherRoomSong(accountId, cookie, targetSongId) {
    const snapshot = await getTogetherSnapshot(accountId, cookie);
    const target = cleanText(targetSongId, 80);
    if (!/^\d{1,20}$/.test(target)) {
        throw new PublicError('targetSongId 无效');
    }
    if (!snapshot.displayList.includes(target)) {
        throw new PublicError('目标歌曲不在当前一起听房间歌单中');
    }
    const formerSongId = cleanText(
        snapshot.playCommand.targetSongId || snapshot.current.songId,
        80,
    ) || '-1';
    const nextSeq = (Number(snapshot.playCommand.clientSeq) || 0) + 1;
    await requestNetease('/listentogether/play/command', {
        method: 'POST',
        params: {
            roomId: snapshot.roomId,
            commandType: 'GOTO',
            progress: 0,
            playStatus: 'PLAY',
            formerSongId,
            targetSongId: target,
            clientSeq: nextSeq,
        },
        cookie,
    });
    return { roomId: snapshot.roomId, targetSongId: target, clientSeq: nextSeq };
}

async function controlTogetherRoom(accountId, cookie, command) {
    const normalized = cleanText(command, 20).toLowerCase();
    if (!['play', 'pause', 'next', 'previous'].includes(normalized)) {
        throw new PublicError('command 仅支持 play、pause、next、previous');
    }
    const snapshot = await getTogetherSnapshot(accountId, cookie);
    const list = snapshot.displayList;
    if (!list.length) {
        throw new PublicError('当前一起听房间歌单为空');
    }
    const currentSongId = cleanText(
        snapshot.playCommand.targetSongId || snapshot.current.songId,
        80,
    ) || list[0];
    const currentIndex = Math.max(0, list.indexOf(currentSongId));
    let targetSongId = currentSongId;
    let commandType;
    if (normalized === 'next') {
        targetSongId = list[(currentIndex + 1) % list.length];
        commandType = 'GOTO';
    } else if (normalized === 'previous') {
        targetSongId = list[(currentIndex - 1 + list.length) % list.length];
        commandType = 'GOTO';
    } else {
        commandType = normalized === 'play' ? 'PLAY' : 'PAUSE';
    }
    const nextSeq = (Number(snapshot.playCommand.clientSeq) || 0) + 1;
    await requestNetease('/listentogether/play/command', {
        method: 'POST',
        params: {
            roomId: snapshot.roomId,
            commandType,
            progress: commandType === 'GOTO'
                ? 0
                : Number(snapshot.playCommand.progress) || 0,
            playStatus: normalized === 'pause' ? 'PAUSE' : 'PLAY',
            formerSongId: currentSongId || '-1',
            targetSongId,
            clientSeq: nextSeq,
        },
        cookie,
    });
    return {
        roomId: snapshot.roomId,
        command: normalized,
        targetSongId,
        clientSeq: nextSeq,
    };
}

async function fetchPlaylistTrackIds(playlistId, cookie) {
    const { body } = await requestNetease('/playlist/detail', {
        params: { id: playlistId },
        cookie,
    });
    const playlist = body?.playlist || upstreamData(body)?.playlist || {};
    if (Array.isArray(playlist.trackIds)) {
        return playlist.trackIds.map(item => cleanText(item?.id ?? item, 80)).filter(Boolean);
    }
    if (Array.isArray(playlist.tracks)) {
        return playlist.tracks.map(item => cleanText(item?.id, 80)).filter(Boolean);
    }
    return [];
}

async function addTracksToPlaylist(playlistId, requestedIds, cookie) {
    const existingIds = new Set(await fetchPlaylistTrackIds(playlistId, cookie));
    const toAdd = requestedIds.filter(id => !existingIds.has(id));
    const skipped = requestedIds.length - toAdd.length;
    if (toAdd.length === 0) {
        return { added: 0, skipped };
    }

    const { body } = await requestNetease('/playlist/tracks', {
        method: 'POST',
        params: {
            op: 'add',
            pid: playlistId,
            tracks: toAdd.join(','),
        },
        cookie,
    });
    const code = Number(body?.code ?? upstreamData(body)?.code);
    if (Number.isFinite(code) && code !== 200) {
        throw new PublicError(cleanText(body?.message || body?.error, 240) || '添加歌曲失败', 502);
    }
    return { added: toAdd.length, skipped };
}

function normalizeSearchSongs(body) {
    const data = upstreamData(body) || {};
    const songs = Array.isArray(data.songs) ? data.songs
        : Array.isArray(data.result?.songs) ? data.result.songs
            : Array.isArray(body?.result?.songs) ? body.result.songs : [];
    return songs.map(song => ({
        id: cleanText(song.id, 80),
        name: cleanText(song.name, 200),
        artist: (song.artists || song.ar || []).map(item => cleanText(item.name, 80)).filter(Boolean).join(', '),
    })).filter(song => song.id && song.name);
}

function togetherDisabled() {
    return settings.enableTogetherListen !== true;
}

function rejectTogetherDisabled(response) {
    if (!togetherDisabled()) {
        return false;
    }
    response.status(403).json({ error: '一起听模块未启用，请在 config.json 中设置 enableTogetherListen: true' });
    return true;
}

function extractRoomId(body) {
    const data = upstreamData(body) || {};
    return cleanText(
        data.roomInfo?.roomId || data.roomId || data.room?.roomId || body?.roomInfo?.roomId || body?.roomId,
        200,
    );
}

function extractInviteCode(body) {
    const data = upstreamData(body) || {};
    return cleanText(
        data.roomInfo?.inviteCode || data.inviteCode || data.room?.inviteCode || body?.inviteCode,
        200,
    );
}

function roomInviteUrl(roomId, inviterId, songId = '') {
    if (!roomId || !inviterId) {
        return '';
    }
    const url = new URL('https://st.music.163.com/listen-together/share/index.html');
    url.searchParams.set('roomId', roomId);
    url.searchParams.set('inviterId', inviterId);
    if (songId) {
        url.searchParams.set('songId', songId);
    }
    return url.toString();
}

function legacyRoomInviteUrl(roomId) {
    return roomId
        ? `https://y.music.163.com/m/together/room?id=${encodeURIComponent(roomId)}`
        : '';
}

function extractTogetherInviteUrl(body) {
    const data = upstreamData(body) || {};
    const candidate = cleanText(
        data.inviteUrl
        || data.shareUrl
        || data.roomInfo?.inviteUrl
        || data.roomInfo?.shareUrl
        || data.room?.inviteUrl
        || body?.inviteUrl,
        1000,
    );
    if (!candidate) {
        return '';
    }
    try {
        const parsed = new URL(candidate);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
    } catch {
        return '';
    }
}

function parseTogetherShareLink(value) {
    const text = cleanText(value, 2000);
    if (!text) {
        throw new PublicError('请粘贴一起听分享链接');
    }
    let url;
    try {
        url = new URL(text);
    } catch {
        throw new PublicError('一起听分享链接格式无效');
    }
    const allowedHosts = new Set([
        'st.music.163.com',
        'y.music.163.com',
        'music.163.com',
    ]);
    if (!['http:', 'https:'].includes(url.protocol) || !allowedHosts.has(url.hostname)) {
        throw new PublicError('仅支持网易云音乐的一起听分享链接');
    }
    const roomId = cleanText(url.searchParams.get('roomId') || url.searchParams.get('id'), 240);
    const inviterId = cleanText(url.searchParams.get('inviterId'), 80);
    const songId = cleanText(url.searchParams.get('songId'), 80);
    if (!roomId) {
        throw new PublicError('分享链接缺少 roomId');
    }
    return {
        roomId,
        inviterId,
        songId,
        inviteUrl: roomInviteUrl(roomId, inviterId, songId) || url.toString(),
    };
}

async function createTogetherRoom(accountId, cookie) {
    const { body } = await requestNetease('/listentogether/room/create', { cookie });
    const data = upstreamData(body) || {};
    const roomId = extractRoomId(body);
    if (!roomId) {
        throw new PublicError('一起听房间创建成功，但本地 API 未返回 roomId', 502);
    }
    const inviteCode = extractInviteCode(body);
    const creatorId = cleanText(
        data.roomInfo?.creatorId || data.creatorId || body?.creatorId,
        80,
    );
    const inviteUrl = extractTogetherInviteUrl(body) || legacyRoomInviteUrl(roomId);
    roomCache.set(accountId, { roomId, inviteUrl });
    return { roomId, inviteUrl, inviteCode: inviteCode || undefined };
}

function parseCurrentSong(body) {
    const data = upstreamData(body) || {};
    const roomInfo = data.roomInfo || data.room || {};
    const playing = data.playingInfo || data.playInfo || data.currentSong || data.song || {};
    const song = playing.song || playing;
    const artists = song.artists || song.ar || playing.artists || [];
    const album = song.album || song.al || playing.album || {};
    return {
        inRoom: data.inRoom === true || data.isInRoom === true || Boolean(data.roomInfo),
        roomId: cleanText(data.roomInfo?.roomId || roomInfo.roomId || data.roomId, 200),
        songId: cleanText(
            playing.songId || roomInfo.songId || data.songId || data.currentSongId || song.id,
            80,
        ),
        songName: cleanText(song.name || playing.songName || roomInfo.songName || data.songName, 200),
        artist: cleanText(
            (Array.isArray(artists) ? artists.map(item => item.name).filter(Boolean).join(', ') : artists)
            || playing.artist
            || roomInfo.artist
            || data.artist,
            200,
        ),
        album: cleanText(album.name || playing.album || roomInfo.album || data.album, 200),
        progress: Number(playing.progress ?? roomInfo.progress ?? data.progress) || 0,
        duration: Number(song.duration || playing.duration || roomInfo.duration || data.duration) || 0,
        coverUrl: cleanText(album.picUrl || playing.coverUrl || roomInfo.coverUrl || data.coverUrl, 1000),
    };
}

async function ensureNativeService({ forceRestart = false } = {}) {
    if (!settings.enableTogetherListen) {
        throw new PublicError('一起听模块未启用，请在 config.json 中设置 enableTogetherListen: true', 403);
    }
    const { accountId, account } = getActiveAccount();
    const cookie = activeCookieOrThrow();
    const nativeService = settings.togetherNative || {};
    if (!settings.user_netease_id) {
        throw new PublicError('请先在 config.json 配置 user_netease_id');
    }
    return nativeBridge.startService({
        accountId,
        cookie,
        targetUserId: settings.user_netease_id,
        apiBase: getApiBase(),
        pythonPath: nativeService.pythonPath || process.env.NETEASE_NATIVE_NATIVE_PYTHON || 'python',
        appPath: nativeService.appPath || process.env.NETEASE_NATIVE_NATIVE_CLIENT_PATH || '',
        debugPort: nativeService.debugPort || 9222,
        preferredPort: nativeService.port || 3472,
        remoteUrl: nativeService.remoteUrl,
        remoteToken: nativeService.remoteToken,
        forceRestart,
    });
}

function wrapRoute(handler) {
    return (request, response, next) => {
        Promise.resolve(handler(request, response, next)).catch(error => {
            if (response.headersSent) {
                return;
            }
            const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500;
            const message = error instanceof PublicError || error?.name === 'TogetherBridgeError'
                ? error.message
                : '插件处理请求失败';
            // Never print cookies, query strings, request bodies, or upstream payloads.
            console.warn(`[netease-music-native] ${request.method} ${request.path}: ${message}`);
            response.status(status).json({ error: message });
        });
    };
}

export async function init(router) {
    loadAndNormalizeConfig();

    if (!shutdownHookBound) {
        shutdownHookBound = true;
        const stopNative = () => {
            void nativeBridge.stopService();
        };
        process.once('SIGINT', stopNative);
        process.once('SIGTERM', stopNative);
    }
    if (
        settings.enableTogetherListen
        && settings.togetherNative?.autoStart
    ) {
        ensureNativeService().catch(error => {
            console.warn('[netease-music-native] native service auto-start failed:', error?.message || 'unknown error');
        });
    }

    router.get('/accounts', wrapRoute(async (_request, response) => {
        response.json(publicAccounts());
    }));

    router.post('/switch-account', wrapRoute(async (request, response) => {
        const accountId = cleanText(request.body?.accountId, 32);
        if (!settings.accounts[accountId]) {
            throw new PublicError('账号不存在');
        }
        settings.activeAccountId = accountId;
        uidCache.delete(accountId);
        writeConfig();
        await nativeBridge.stopService();
        response.json({
            ok: true,
            activeAccountId: accountId,
            currentPlaylist: settings.accounts[accountId].currentPlaylist,
        });
    }));

    router.post('/add-account', wrapRoute(async (request, response) => {
        const accountId = cleanText(request.body?.accountId, 32);
        const label = cleanText(request.body?.label, 80);
        if (!ACCOUNT_ID_PATTERN.test(accountId)) {
            throw new PublicError('accountId 必须为 1-32 位字母、数字或下划线');
        }
        if (!label) {
            throw new PublicError('label 不能为空');
        }
        if (settings.accounts[accountId]) {
            throw new PublicError('账号 id 已存在');
        }
        settings.accounts[accountId] = emptyAccount(label);
        writeConfig();
        response.json({ ok: true, accountId });
    }));

    router.post('/remove-account', wrapRoute(async (request, response) => {
        const accountId = cleanText(request.body?.accountId, 32);
        if (!settings.accounts[accountId]) {
            throw new PublicError('账号不存在');
        }
        if (accountId === settings.activeAccountId) {
            throw new PublicError('不能删除当前活动账号');
        }
        if (Object.keys(settings.accounts).length <= 1) {
            throw new PublicError('不能删除唯一账号');
        }
        delete settings.accounts[accountId];
        uidCache.delete(accountId);
        roomCache.delete(accountId);
        writeConfig();
        if (accountId === settings.activeAccountId) {
            await nativeBridge.stopService();
        }
        response.json({ ok: true });
    }));

    router.post('/rename-account', wrapRoute(async (request, response) => {
        const accountId = cleanText(request.body?.accountId, 32);
        const label = cleanText(request.body?.label, 80);
        if (!settings.accounts[accountId]) {
            throw new PublicError('账号不存在');
        }
        if (!label) {
            throw new PublicError('label 不能为空');
        }
        settings.accounts[accountId].label = label;
        writeConfig();
        response.json({ ok: true });
    }));

    router.get('/login/qr', wrapRoute(async (request, response) => {
        const targetAccountId = cleanText(request.query.targetAccountId, 32) || settings.activeAccountId;
        if (!settings.accounts[targetAccountId]) {
            throw new PublicError('目标账号不存在');
        }
        try {
            const keyResponse = await requestNetease('/login/qr/key');
            const keyData = upstreamData(keyResponse.body) || {};
            const key = cleanText(keyData.unikey || keyData.key || keyResponse.body?.unikey, 200);
            if (!key) {
                throw new PublicError('NeteaseCloudMusicApi 未返回二维码 key', 502);
            }
            const createResponse = await requestNetease('/login/qr/create', {
                params: { key, qrimg: 'true' },
            });
            const createData = upstreamData(createResponse.body) || {};
            const qrimg = cleanText(createData.qrimg || createResponse.body?.qrimg, 2_000_000);
            if (!qrimg) {
                throw new PublicError('NeteaseCloudMusicApi 未返回二维码图片', 502);
            }
            response.json({ key, qrimg, targetAccountId });
        } catch (error) {
            if (error instanceof PublicError && error.status !== 502) {
                throw error;
            }
            throw new PublicError('无法生成二维码，请确认 NeteaseCloudMusicApi 服务已启动', 502);
        }
    }));

    router.get('/login/qr/check', wrapRoute(async (request, response) => {
        const key = cleanText(request.query.key, 200);
        const targetAccountId = cleanText(request.query.targetAccountId, 32) || settings.activeAccountId;
        if (!key) {
            throw new PublicError('缺少二维码 key');
        }
        if (!settings.accounts[targetAccountId]) {
            throw new PublicError('目标账号不存在');
        }

        const result = await requestNetease('/login/qr/check', { params: { key } });
        const data = upstreamData(result.body) || {};
        const code = Number(data.code ?? result.body?.code);
        if (code !== 803) {
            const messages = {
                800: '二维码已过期',
                801: '等待扫码',
                802: '已扫码，请在手机上确认',
            };
            response.json({ code, message: messages[code] || cleanText(data.message, 200) || '等待登录' });
            return;
        }

        const loginCookies = extractLoginCookies(result.body, result.setCookies);
        if (!loginCookies.musicU) {
            throw new PublicError('扫码成功，但本地 API 未返回登录 Cookie', 502);
        }
        const loginCookie = [
            `MUSIC_U=${loginCookies.musicU}`,
            loginCookies.csrf ? `__csrf=${loginCookies.csrf}` : '',
        ].filter(Boolean).join('; ');
        const accountResponse = await requestNetease('/user/account', { cookie: loginCookie });
        const profile = extractProfile(accountResponse.body);
        const account = settings.accounts[targetAccountId];
        account.music_u = loginCookies.musicU;
        account.csrf = loginCookies.csrf;
        account.nickname = profile.nickname;
        account.userId = profile.userId;
        uidCache.delete(targetAccountId);
        writeConfig();
        response.json({
            code: 803,
            message: '登录成功',
            accountId: targetAccountId,
            nickname: profile.nickname,
        });
    }));

    router.post('/logout', wrapRoute(async (request, response) => {
        const accountId = cleanText(request.body?.accountId, 32) || settings.activeAccountId;
        const account = settings.accounts[accountId];
        if (!account) {
            throw new PublicError('账号不存在');
        }
        account.music_u = '';
        account.csrf = '';
        account.nickname = '';
        account.userId = '';
        uidCache.delete(accountId);
        roomCache.delete(accountId);
        writeConfig();
        response.json({ ok: true });
    }));

    router.get('/status', wrapRoute(async (_request, response) => {
        const { accountId, account } = getActiveAccount();
        const cookie = accountCookie(account);
        let loggedIn = false;
        let message = '未登录';
        let nickname = account.nickname;
        if (cookie) {
            try {
                const accountResponse = await requestNetease('/user/account', { cookie });
                const profile = extractProfile(accountResponse.body);
                loggedIn = Boolean(profile.userId);
                nickname = profile.nickname || nickname;
                if (loggedIn && profile.userId) {
                    account.userId = profile.userId;
                    account.nickname = profile.nickname;
                    uidCache.set(accountId, profile.userId);
                }
                message = loggedIn ? '登录有效' : 'Cookie 已失效';
            } catch {
                message = 'Cookie 已失效或 API 不可用';
            }
        }
        response.json({
            loggedIn,
            message,
            nickname,
            charName: account.label,
            togetherEnabled: settings.enableTogetherListen === true,
            accountMode: 'alt',
            activeAccountId: accountId,
            accounts: publicAccounts(),
        });
    }));

    router.get('/user-playlists', wrapRoute(async (_request, response) => {
        const { accountId, account } = getActiveAccount();
        const cookie = accountCookie(account);
        if (!cookie) {
            throw new PublicError('未登录或 Cookie 失效', 401);
        }

        let uid = uidCache.get(accountId);
        if (!uid) {
            const accountResponse = await requestNetease('/user/account', { cookie });
            const profile = extractProfile(accountResponse.body);
            uid = profile.userId;
            if (!uid) {
                throw new PublicError('未登录或 Cookie 失效', 401);
            }
            account.userId = uid;
            account.nickname = profile.nickname || account.nickname;
            uidCache.set(accountId, uid);
        }

        const { body } = await requestNetease('/user/playlist', {
            params: { uid, limit: 1000 },
            cookie,
        });
        const data = upstreamData(body) || {};
        const playlists = Array.isArray(data.playlist) ? data.playlist : [];
        response.json(playlists.map(playlist => ({
            id: cleanText(playlist.id, 80),
            name: cleanText(playlist.name, 200),
            trackCount: Number(playlist.trackCount) || 0,
            creator: cleanText(playlist.creator?.nickname, 80),
            isLiked: Number(playlist.specialType) === 5,
        })));
    }));

    router.post('/search-with-lyric', wrapRoute(async (request, response) => {
        const keyword = cleanText(request.body?.keyword, 200);
        const requestedLimit = Number(request.body?.limit);
        if (!keyword) {
            throw new PublicError('keyword 不能为空');
        }
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 10) {
            throw new PublicError('limit 必须为 1-10 的整数');
        }
        const cookie = activeCookieOrThrow();

        // This route intentionally searches only the fixed /search endpoint.
        // It must never use playlist/detail, user/playlist, or playlist tracks as song candidates.
        const searchResponse = await requestNetease('/search', {
            params: { keywords: keyword, limit: requestedLimit, type: 1 },
            cookie,
        });
        const candidates = normalizeSearchSongs(searchResponse.body);

        const lyrics = await Promise.allSettled(candidates.map(async song => {
            const lyricResponse = await requestNetease('/lyric', {
                params: { id: song.id },
                cookie,
            });
            const lyricBody = lyricResponse.body || {};
            return {
                ...song,
                lyric_snippet: parseLyricSnippet(lyricBody?.lrc?.lyric || upstreamData(lyricBody)?.lrc?.lyric),
            };
        }));
        response.json(lyrics.map(result => result.status === 'fulfilled' ? result.value : null).filter(Boolean));
    }));

    router.post('/create-playlist', wrapRoute(async (request, response) => {
        const { account } = getActiveAccount();
        const cookie = activeCookieOrThrow();
        const name = cleanText(request.body?.name, 80);
        if (!name) {
            throw new PublicError('name 不能为空');
        }

        let privacy;
        if (typeof request.body?.privacy === 'boolean') {
            // NeteaseCloudMusicApi 4.x uses 0 for public and 10 for private.
            privacy = request.body.privacy ? '10' : '0';
        } else if ([0, 10, '0', '10'].includes(request.body?.privacy)) {
            privacy = String(request.body.privacy);
        } else {
            privacy = '0';
        }

        const { body } = await requestNetease('/playlist/create', {
            method: 'POST',
            params: { name, privacy },
            cookie,
        });
        const data = upstreamData(body) || {};
        const playlistId = cleanText(data.id || data.playlist?.id || data.playlistId, 80);
        if (!playlistId) {
            throw new PublicError(cleanText(body?.message, 240) || '创建歌单失败', 502);
        }
        account.currentPlaylist = { id: playlistId, name };
        writeConfig();
        response.json({ playlist_id: playlistId, name });
    }));

    router.post('/add-tracks', wrapRoute(async (request, response) => {
        const { account } = getActiveAccount();
        const cookie = activeCookieOrThrow();
        const requestedPlaylistId = cleanText(request.body?.playlist_id, 80);
        const playlistId = requestedPlaylistId || account.currentPlaylist?.id;
        if (!playlistId) {
            throw new PublicError('当前没有歌单');
        }
        const trackIds = normalizeTrackIds(request.body?.track_ids);
        if (trackIds.ids.length === 0) {
            throw new PublicError('track_ids 不能为空');
        }
        const result = await addTracksToPlaylist(playlistId, trackIds.ids, cookie);
        if (trackIds.truncated) {
            result.message = 'track_ids 超过 20 个，已截断';
        }
        response.json(result);
    }));

    router.post('/add-tracks-to-playlist', wrapRoute(async (request, response) => {
        const cookie = activeCookieOrThrow();
        const playlistId = cleanText(request.body?.playlist_id, 80);
        if (!playlistId) {
            throw new PublicError('playlist_id 不能为空');
        }
        const trackIds = normalizeTrackIds(request.body?.track_ids);
        if (trackIds.ids.length === 0) {
            throw new PublicError('track_ids 不能为空');
        }
        const result = await addTracksToPlaylist(playlistId, trackIds.ids, cookie);
        if (trackIds.truncated) {
            result.message = 'track_ids 超过 20 个，已截断';
        }
        response.json(result);
    }));

    router.get('/current-playlist', wrapRoute(async (_request, response) => {
        const { account } = getActiveAccount();
        response.json(account.currentPlaylist);
    }));

    router.post('/set-current-playlist', wrapRoute(async (request, response) => {
        const { account } = getActiveAccount();
        const playlistId = cleanText(request.body?.playlist_id, 80);
        const name = cleanText(request.body?.name, 200);
        if (!playlistId) {
            throw new PublicError('playlist_id 不能为空');
        }
        account.currentPlaylist = { id: playlistId, name };
        writeConfig();
        response.json({ ok: true });
    }));

    router.get('/lyric', wrapRoute(async (request, response) => {
        const songId = cleanText(request.query.song_id, 80);
        if (!songId) {
            throw new PublicError('song_id 不能为空');
        }
        const cookie = activeCookieOrThrow();
        const { body } = await requestNetease('/lyric', {
            params: { id: songId },
            cookie,
        });
        response.json({
            lyric: String(body?.lrc?.lyric || upstreamData(body)?.lrc?.lyric || ''),
            translated: String(body?.tlyric?.lyric || upstreamData(body)?.tlyric?.lyric || ''),
        });
    }));

    router.get('/song-audio/:songId', wrapRoute(async (request, response) => {
        const songId = cleanText(request.params.songId, 80);
        if (!/^\d{1,20}$/.test(songId)) {
            throw new PublicError('songId 必须是数字歌曲 ID');
        }
        const cookie = activeCookieOrThrow();
        const playback = await resolveSongPlaybackUrl(
            songId,
            cookie,
            cleanText(request.query.level, 40) || 'standard',
        );
        const upstreamHeaders = {
            Accept: '*/*',
            Referer: 'https://music.163.com/',
            'User-Agent': 'Mozilla/5.0',
        };
        if (request.headers.range) {
            upstreamHeaders.Range = request.headers.range;
        }
        let upstream;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try {
            upstream = await fetch(playback.url, {
                headers: upstreamHeaders,
                signal: controller.signal,
            });
        } catch {
            throw new PublicError('读取网易云音频失败，请稍后重试', 502);
        } finally {
            clearTimeout(timeout);
        }
        if (!upstream.ok) {
            throw new PublicError(`网易云音频请求失败 (${upstream.status})`, 502);
        }
        response.status(upstream.status);
        for (const name of [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges',
        ]) {
            const value = upstream.headers.get(name);
            if (value) {
                response.setHeader(name, value);
            }
        }
        response.setHeader('Cache-Control', 'private, max-age=300');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (!upstream.body) {
            response.end();
            return;
        }
        Readable.fromWeb(upstream.body).pipe(response);
    }));

    router.get('/song-comments/:songId', wrapRoute(async (request, response) => {
        const songId = cleanText(request.params.songId, 80);
        const offset = Math.max(0, Number(request.query.offset) || 0);
        const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));
        if (!/^\d{1,20}$/.test(songId)) {
            throw new PublicError('songId 必须是数字歌曲 ID');
        }
        const cookie = activeCookieOrThrow();
        const { body } = await requestNetease('/comment/music', {
            params: { id: songId, limit, offset },
            cookie,
        });
        const data = upstreamData(body) || {};
        const hot = Array.isArray(data.hotComments) ? data.hotComments : [];
        const comments = Array.isArray(data.comments) ? data.comments : [];
        const seen = new Set();
        const normalized = [...hot, ...comments]
            .filter(item => {
                const id = cleanText(item?.commentId, 80);
                if (!id || seen.has(id)) {
                    return false;
                }
                seen.add(id);
                return true;
            })
            .map(item => ({
                id: cleanText(item?.commentId, 80),
                content: cleanText(item?.content, 500),
                nickname: cleanText(item?.user?.nickname, 80),
                avatarUrl: cleanText(item?.user?.avatarUrl, 1000),
                likedCount: Number(item?.likedCount) || 0,
                time: Number(item?.time) || 0,
                replyCount: Number(item?.replyCount) || 0,
            }));
        response.json({
            songId,
            total: Number(data.total) || normalized.length,
            more: data.more === true,
            comments: normalized,
        });
    }));

    router.post('/song-comments/:songId', wrapRoute(async (request, response) => {
        const songId = cleanText(request.params.songId, 80);
        const content = cleanText(request.body?.content, 140);
        if (!/^\d{1,20}$/.test(songId)) {
            throw new PublicError('songId 必须是数字歌曲 ID');
        }
        if (!content) {
            throw new PublicError('评论内容不能为空');
        }
        const cookie = activeCookieOrThrow();
        const { body } = await requestNetease('/comment', {
            method: 'POST',
            params: {
                id: songId,
                type: 0,
                t: 1,
                content,
            },
            cookie,
        });
        const data = upstreamData(body) || {};
        const code = Number(body?.code ?? data.code);
        if (Number.isFinite(code) && code !== 200) {
            throw new PublicError(
                cleanText(body?.message || data.message, 240) || '评论发布失败',
                502,
            );
        }
        response.json({
            ok: true,
            songId,
            content,
            comment: data.comment || null,
        });
    }));

    router.get('/together/status', wrapRoute(async (_request, response) => {
        if (rejectTogetherDisabled(response)) {
            return;
        }
        const { accountId, account } = getActiveAccount();
        const cookie = activeCookieOrThrow();
        const { body } = await requestNetease('/listentogether/status', { cookie });
        const current = parseCurrentSong(body);
        const cached = roomCache.get(accountId);
        response.json({
            inRoom: current.inRoom,
            roomId: cached?.roomId || current.roomId || undefined,
            inviteUrl: cached?.inviteUrl || undefined,
            songName: current.songName || undefined,
            artist: current.artist || undefined,
            progress: current.progress || undefined,
            nickname: account.nickname || undefined,
        });
    }));

    router.post('/together/native/start', wrapRoute(async (_request, response) => {
        const service = await ensureNativeService();
        response.json({ ok: true, ...service });
    }));

    router.get('/together/native/status', wrapRoute(async (_request, response) => {
        const { account } = getActiveAccount();
        const service = nativeBridge.describe();
        if (!service.running) {
            response.json({ ...service, message: '独立原生服务尚未启动' });
            return;
        }
        const details = await nativeBridge.getStatus();
        const clientUid = cleanText(details?.client?.hostUid, 80);
        const cookieUid = cleanText(details?.cookieUid, 80);
        const accountUid = String(account.userId || '');
        response.json({
            ...service,
            details,
            accountUid,
            clientUid,
            cookieUid,
            accountMatchesClient: !clientUid || !accountUid || clientUid === accountUid,
            accountMatchesCookie: !cookieUid || !accountUid || cookieUid === accountUid,
        });
    }));

    router.get('/together/room-playlist', wrapRoute(async (_request, response) => {
        if (rejectTogetherDisabled(response)) {
            return;
        }
        const { accountId } = getActiveAccount();
        const cookie = activeCookieOrThrow();
        response.json(nativeBridge.describe().running
            ? await nativeRoomPlaylistResponse(cookie)
            : await roomPlaylistResponse(accountId, cookie));
    }));

    router.post('/together/room-playlist/add', wrapRoute(async (request, response) => {
        if (rejectTogetherDisabled(response)) {
            return;
        }
        const songId = cleanText(request.body?.songId, 80);
        if (!/^\d{1,20}$/.test(songId)) {
            throw new PublicError('songId 必须是数字歌曲 ID');
        }
        const { accountId } = getActiveAccount();
        const cookie = activeCookieOrThrow();
        if (nativeBridge.describe().running) {
            await nativeBridge.addRoomTrack(songId);
            response.json(await nativeRoomPlaylistResponse(cookie));
            return;
        }
        const snapshot = await getTogetherSnapshot(accountId, cookie);
        if (!snapshot.displayList.includes(songId)) {
            await replaceTogetherRoomPlaylist(
                accountId,
                cookie,
                [...snapshot.displayList, songId],
            );
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        response.json(await roomPlaylistResponse(accountId, cookie));
    }));

    router.post('/together/room-playlist/play', wrapRoute(async (request, response) => {
        if (rejectTogetherDisabled(response)) {
            return;
        }
        const songId = cleanText(request.body?.songId, 80);
        const { accountId } = getActiveAccount();
        const cookie = activeCookieOrThrow();
        if (nativeBridge.describe().running) {
            await nativeBridge.playRoomTrack(songId);
            response.json(await nativeRoomPlaylistResponse(cookie));
            return;
        }
        response.json(await playTogetherRoomSong(accountId, cookie, songId));
    }));

    router.post('/together/control', wrapRoute(async (request, response) => {
        if (rejectTogetherDisabled(response)) {
            return;
        }
        const { accountId } = getActiveAccount();
        const cookie = activeCookieOrThrow();
        const command = request.body?.command;
        if (nativeBridge.describe().running) {
            await nativeBridge.controlRoom(command);
            response.json(await nativeRoomPlaylistResponse(cookie));
            return;
        }
        response.json(await controlTogetherRoom(accountId, cookie, command));
    }));

    router.post('/together/native/create', wrapRoute(async (_request, response) => {
        const { accountId, account } = getActiveAccount();
        await ensureNativeService();
        let result;
        try {
            result = await nativeBridge.createRoom();
        } catch (error) {
            if (/does not match|不一致/i.test(error?.message || '')) {
                throw new PublicError(
                    '原生服务使用的网易云桌面客户端与当前活动账号不一致。请先在网易云客户端切换到当前账号后再创建房间',
                    409,
                );
            }
            throw error;
        }
        const creatorId = cleanText(result.creatorId, 80);
        if (creatorId && account.userId && creatorId !== String(account.userId)) {
            await nativeBridge.closeRoom().catch(() => {});
            throw new PublicError(
                `独立原生服务控制的是桌面客户端账号 ${creatorId}，当前插件账号是 ${account.userId}。请让网易云客户端登录与当前账号一致后重试`,
                409,
            );
        }
        const inviteUrl = cleanText(result.inviteUrl, 1000)
            || roomInviteUrl(result.roomId, creatorId, result.currentSongId);
        roomCache.set(accountId, {
            roomId: cleanText(result.roomId, 240),
            inviterId: creatorId,
            songId: cleanText(result.currentSongId, 80),
            inviteUrl,
        });
        response.json({
            ...result,
            success: true,
            source: 'native',
            creatorId,
            inviteUrl,
        });
    }));

    router.post('/together/native/close', wrapRoute(async (_request, response) => {
        const { accountId } = getActiveAccount();
        const result = await nativeBridge.closeRoom();
        roomCache.delete(accountId);
        response.json({ ...result, ok: true, source: 'native' });
    }));

    router.post('/together/create', wrapRoute(async (_request, response) => {
        if (rejectTogetherDisabled(response)) {
            return;
        }
        const { accountId } = getActiveAccount();
        const cookie = activeCookieOrThrow();
        const room = await createTogetherRoom(accountId, cookie);
        // 本接口不发送官方邀请卡片，用户需手动加入。
        response.json(room);
    }));

    router.post('/together/join', wrapRoute(async (request, response) => {
        if (rejectTogetherDisabled(response)) {
            return;
        }
        const { accountId } = getActiveAccount();
        const cookie = activeCookieOrThrow();
        const share = request.body?.inviteUrl
            ? parseTogetherShareLink(request.body.inviteUrl)
            : {
                roomId: cleanText(request.body?.roomId, 240),
                inviterId: cleanText(request.body?.inviterId, 80),
                songId: cleanText(request.body?.songId, 80),
                inviteUrl: '',
            };
        if (!share.roomId) {
            throw new PublicError('roomId 不能为空');
        }
        if (!share.inviterId) {
            const check = await requestNetease('/listentogether/room/check', {
                method: 'POST',
                params: { roomId: share.roomId },
                cookie,
            });
            const checkData = upstreamData(check.body) || {};
            share.inviterId = cleanText(
                checkData.inviterId || checkData.roomInfo?.inviterId || checkData.room?.inviterId,
                80,
            );
        }
        if (!share.inviterId) {
            throw new PublicError('旧版链接缺少 inviterId，无法自动加入；请在网易云 App 中打开该链接手动加入，或重新复制官方分享链接');
        }
        const accepted = await requestNetease('/listentogether/accept', {
            method: 'POST',
            params: {
                roomId: share.roomId,
                ...(share.inviterId ? { inviterId: share.inviterId } : {}),
            },
            cookie,
        });
        const acceptedData = upstreamData(accepted.body) || {};
        const acceptedCode = Number(accepted.body?.code ?? acceptedData.code);
        if (Number.isFinite(acceptedCode) && acceptedCode !== 200) {
            throw new PublicError(cleanText(accepted.body?.message, 240) || '加入一起听房间失败', 502);
        }
        share.inviteUrl = share.inviteUrl || roomInviteUrl(share.roomId, share.inviterId, share.songId);
        roomCache.set(accountId, share);
        response.json({
            ok: true,
            roomId: share.roomId,
            inviterId: share.inviterId,
            songId: share.songId || undefined,
            inviteUrl: share.inviteUrl,
        });
    }));

    router.get('/together/now-playing', wrapRoute(async (_request, response) => {
        if (rejectTogetherDisabled(response)) {
            return;
        }
        const { accountId } = getActiveAccount();
        const cookie = activeCookieOrThrow();
        const { body } = await requestNetease('/listentogether/status', { cookie });
        const current = parseCurrentSong(body);
        const cachedRoom = roomCache.get(accountId);
        const roomId = cachedRoom?.roomId || current.roomId;
        if (!current.inRoom && !roomId) {
            throw new PublicError('当前不在一起听房间中', 409);
        }

        let syncData = {};
        if (roomId) {
            const sync = await requestNetease('/listentogether/sync/playlist/get', {
                params: { roomId },
                cookie,
            });
            syncData = upstreamData(sync.body) || {};
        }
        const playCommand = syncData.playCommand || syncData.playInfo || {};
        let song = {
            ...current,
            inRoom: true,
            songId: cleanText(
                playCommand.targetSongId
                || playCommand.songId
                || syncData.targetSongId
                || cachedRoom?.songId
                || current.songId,
                80,
            ),
            progress: Number(playCommand.progress ?? current.progress) || 0,
        };
        if ((!song.songName || !song.artist) && song.songId) {
            const detail = await requestNetease('/song/detail', {
                params: { ids: song.songId },
                cookie,
            });
            const rawSong = upstreamData(detail.body)?.songs?.[0];
            if (rawSong) {
                song = {
                    ...song,
                    songName: cleanText(rawSong.name, 200),
                    artist: (rawSong.ar || rawSong.artists || []).map(item => item.name).filter(Boolean).join(', '),
                    album: cleanText(rawSong.al?.name || rawSong.album?.name, 200),
                    duration: Number(rawSong.dt || rawSong.duration) || song.duration,
                    coverUrl: cleanText(rawSong.al?.picUrl || rawSong.album?.picUrl, 1000),
                };
            }
        }
        if (!song.songName) {
            throw new PublicError('本地 API 暂未返回当前歌曲信息', 502);
        }
        response.json({
            songId: song.songId,
            songName: song.songName,
            artist: song.artist,
            album: song.album,
            progress: song.progress,
            duration: song.duration,
            coverUrl: song.coverUrl,
        });
    }));

    router.post('/together/leave', wrapRoute(async (_request, response) => {
        if (rejectTogetherDisabled(response)) {
            return;
        }
        const { accountId } = getActiveAccount();
        const cookie = activeCookieOrThrow();
        const cached = roomCache.get(accountId);
        if (cached?.roomId) {
            await requestNetease('/listentogether/end', {
                method: 'POST',
                params: { roomId: cached.roomId },
                cookie,
            });
        }
        roomCache.delete(accountId);
        response.json({ ok: true });
    }));

    router.post('/together/send-invite-dm', wrapRoute(async (request, response) => {
        if (rejectTogetherDisabled(response)) {
            return;
        }
        const { accountId, account } = getActiveAccount();
        const cookie = activeCookieOrThrow();
        if (!settings.user_netease_id) {
            throw new PublicError('请先在 config.json 配置 user_netease_id');
        }

        const suppliedRoomId = cleanText(request.body?.roomId, 240);
        let suppliedInvite = null;
        if (request.body?.inviteUrl) {
            suppliedInvite = parseTogetherShareLink(request.body.inviteUrl);
        }
        let room = roomCache.get(accountId);
        if (suppliedInvite) {
            room = suppliedInvite;
            roomCache.set(accountId, room);
        } else if (suppliedRoomId) {
            const inviterId = cleanText(request.body?.inviterId || room?.inviterId, 80);
            const songId = cleanText(request.body?.songId || room?.songId, 80);
            const inviteUrl = roomInviteUrl(suppliedRoomId, inviterId, songId);
            if (!inviteUrl) {
                throw new PublicError('请提供完整的一起听分享链接');
            }
            room = { roomId: suppliedRoomId, inviterId, songId, inviteUrl };
            roomCache.set(accountId, room);
        }
        if (!room) {
            room = await createTogetherRoom(accountId, cookie);
        }
        if (!room.inviteUrl) {
            throw new PublicError('当前房间缺少有效分享链接，请先在网易云 App 中创建并复制分享链接');
        }

        const message = `${account.label}邀请你一起听歌：${room.inviteUrl}`;
        const { body } = await requestNetease('/send/text', {
            method: 'POST',
            params: { msg: message, user_ids: settings.user_netease_id },
            cookie,
        });
        const code = Number(body?.code ?? upstreamData(body)?.code);
        if (Number.isFinite(code) && code !== 200) {
            throw new PublicError(cleanText(body?.message || body?.error, 240) || '私信发送失败', 502);
        }
        // 发送的是普通文字私信，不是官方邀请卡片；收件人需手动点击链接加入。
        response.json({
            ok: true,
            sentTo: settings.user_netease_id,
            inviteUrl: room.inviteUrl,
        });
    }));

    router.post('/together/send-message', wrapRoute(async (request, response) => {
        if (rejectTogetherDisabled(response)) {
            return;
        }
        const cookie = activeCookieOrThrow();
        const recipientId = cleanText(
            request.body?.userId || settings.user_netease_id,
            80,
        );
        const message = cleanText(request.body?.message, 500);
        if (!/^\d{1,20}$/.test(recipientId)) {
            throw new PublicError('请先在 config.json 配置有效的 user_netease_id');
        }
        if (!message) {
            throw new PublicError('消息不能为空');
        }
        const { body } = await requestNetease('/send/text', {
            method: 'POST',
            params: {
                msg: message,
                user_ids: recipientId,
            },
            cookie,
        });
        const code = Number(body?.code ?? upstreamData(body)?.code);
        if (Number.isFinite(code) && code !== 200) {
            throw new PublicError(
                cleanText(body?.message || body?.error, 240) || '一起听消息发送失败',
                502,
            );
        }
        response.json({
            ok: true,
            sentTo: recipientId,
            delivery: 'private-message',
        });
    }));
}

export async function exit() {
    await nativeBridge.stopService();
    uidCache = new Map();
    roomCache = new Map();
}
