import {
    generateQuietPrompt,
    getRequestHeaders,
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';

const EXTENSION_KEY = 'neteaseMusicCompanionNative';
const DEFAULT_BACKEND = '/api/plugins/netease-music-native';
const CANDIDATE_GUARD = '候选歌曲只能来自本次搜索接口返回的结果。禁止读取、引用或调用任何接口获取当前歌单中已有的歌曲作为候选。若搜索结果中没有符合角色设定的歌，返回空 selected 数组，不要从歌单中取歌补充。';

const state = {
    accounts: [],
    activeAccountId: '',
    loggedIn: false,
    busy: false,
    currentPlaylist: null,
    togetherEnabled: false,
    inTogetherRoom: false,
    currentSong: null,
    loginPollTimer: null,
    loginPollToken: 0,
    togetherPollTimer: null,
    togetherPollFailures: 0,
    playerSong: null,
    playerSearchResults: [],
    lyricLines: [],
    lyricIndex: -1,
    roomPlaylist: [],
    roomPlaylistCurrentId: '',
    comments: [],
    panelObserver: null,
};

function initializeSettings() {
    extension_settings[EXTENSION_KEY] ||= {};
    if (typeof extension_settings[EXTENSION_KEY].backendUrl !== 'string') {
        extension_settings[EXTENSION_KEY].backendUrl = DEFAULT_BACKEND;
    }
    if (extension_settings[EXTENSION_KEY].togetherCreationMode === 'poc') {
        extension_settings[EXTENSION_KEY].togetherCreationMode = 'native';
    } else if (!['local', 'native'].includes(extension_settings[EXTENSION_KEY].togetherCreationMode)) {
        extension_settings[EXTENSION_KEY].togetherCreationMode = 'local';
    }
}

function backendBase() {
    const configured = String(extension_settings[EXTENSION_KEY]?.backendUrl || DEFAULT_BACKEND).trim();
    return (configured || DEFAULT_BACKEND).replace(/\/+$/, '');
}

function element(id) {
    return document.getElementById(id);
}

function setText(id, text) {
    const node = element(id);
    if (node) {
        node.textContent = String(text ?? '');
    }
}

function setMessage(text, kind = 'info') {
    const node = element('nmcnativeOperationStatus');
    if (!node) {
        return;
    }
    node.replaceChildren();
    node.className = `nmcnative-message nmcnative-message-${kind}`;
    node.textContent = text || '';
}

function setConnectionState(text, kind = 'info') {
    const node = element('nmcnativeConnectionState');
    if (!node) {
        return;
    }
    node.textContent = text || '';
    node.dataset.kind = kind;
}

async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${backendBase()}${path}`, {
        method,
        headers: getRequestHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new Error(`后端返回了无法解析的响应 (${response.status})`);
    }
    if (!response.ok) {
        throw new Error(payload?.error || `请求失败 (${response.status})`);
    }
    return payload;
}

function setBusy(isBusy, label = '处理中...') {
    state.busy = isBusy;
    const panel = element('netease-music-companion-native');
    if (!panel) {
        return;
    }
    panel.classList.toggle('nmcnative-busy', isBusy);
    panel.querySelectorAll('button').forEach(button => {
        if (button.id === 'nmcnativeCloseQr') {
            return;
        }
        button.disabled = isBusy;
    });
    if (isBusy) {
        setConnectionState(label, 'loading');
    } else {
        renderAccounts();
        renderTogetherVisibility();
        updatePlaylistControls();
    }
}

async function withBusy(label, task) {
    setBusy(true, label);
    try {
        return await task();
    } catch (error) {
        setMessage(error?.message || String(error), 'error');
        return undefined;
    } finally {
        setBusy(false);
    }
}

function option(value, text) {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = text;
    return item;
}

function accountName(accountId) {
    const account = state.accounts.find(item => item.id === accountId);
    return account?.label || accountId || '未选择账号';
}

function renderAccounts() {
    const select = element('nmcnativeAccountSelect');
    if (!select) {
        return;
    }
    const selected = select.value || state.activeAccountId;
    select.replaceChildren();
    for (const account of state.accounts) {
        const nickname = account.nickname ? `（${account.nickname}）` : '';
        select.append(option(account.id, `${account.label}${nickname}`));
    }
    const fallback = state.accounts.some(item => item.id === selected)
        ? selected
        : state.activeAccountId;
    if (fallback) {
        select.value = fallback;
    }

    const deleteButton = element('nmcnativeDeleteAccount');
    if (deleteButton) {
        const chosen = select.value;
        deleteButton.disabled = !chosen || chosen === state.activeAccountId || state.accounts.length <= 1;
    }
}

function renderLoginStatus(status = {}) {
    const account = state.accounts.find(item => item.id === state.activeAccountId);
    const loginText = status.loggedIn ? '已登录' : '未登录或 Cookie 失效';
    setText(
        'nmcnativeLoginState',
        `活动账号：${account?.label || status.charName || '未知'} · ${account?.nickname || status.nickname || '无昵称'} · ${loginText}`,
    );
    const dot = element('nmcnativeStatusDot');
    if (dot) {
        dot.dataset.online = status.loggedIn ? 'true' : 'false';
    }
}

function renderCurrentPlaylist(playlist) {
    state.currentPlaylist = playlist?.id ? { id: String(playlist.id), name: String(playlist.name || '') } : null;
    setText(
        'nmcnativeCurrentPlaylist',
        state.currentPlaylist
            ? `${state.currentPlaylist.name || '未命名歌单'} (${state.currentPlaylist.id})`
            : '未设置',
    );
}

function renderTargetPlaylistStatus(message) {
    setText(
        'nmcnativeTargetPlaylistStatus',
        message || (state.currentPlaylist
            ? `当前目标：${state.currentPlaylist.name || '未命名歌单'}`
            : '尚未选择目标歌单'),
    );
}

function updatePlaylistControls() {
    const canUsePlaylists = state.loggedIn && !state.busy;
    const select = element('nmcnativeTargetPlaylist');
    const refresh = element('nmcnativeRefreshPlaylists');
    const use = element('nmcnativeUsePlaylist');
    if (select) {
        select.disabled = !canUsePlaylists;
    }
    if (refresh) {
        refresh.disabled = !canUsePlaylists;
    }
    if (use) {
        use.disabled = !canUsePlaylists || !select?.value;
    }
}

async function refreshCurrentPlaylist() {
    try {
        renderCurrentPlaylist(await api('/current-playlist'));
    } catch (error) {
        renderCurrentPlaylist(null);
        throw error;
    }
}

async function refreshPlaylists() {
    const select = element('nmcnativeTargetPlaylist');
    if (!select || !state.loggedIn) {
        return;
    }

    const previousValue = select.value || state.currentPlaylist?.id || '';
    select.replaceChildren(option('', '— 选择一个已有歌单 —'));
    const playlists = await api('/user-playlists');
    for (const playlist of playlists) {
        const liked = playlist.isLiked ? '（红心）' : '';
        select.append(option(
            String(playlist.id),
            `${playlist.name}（${Number(playlist.trackCount) || 0} 首）${liked}`,
        ));
    }
    if (state.currentPlaylist?.id && !playlists.some(item => String(item.id) === String(state.currentPlaylist.id))) {
        select.append(option(state.currentPlaylist.id, `${state.currentPlaylist.name || '当前歌单'}（当前）`));
    }
    const desiredValue = state.currentPlaylist?.id || previousValue;
    if (desiredValue && [...select.options].some(item => item.value === String(desiredValue))) {
        select.value = String(desiredValue);
    }
    updatePlaylistControls();
    renderTargetPlaylistStatus();
}

function resetPlaylistControls() {
    const select = element('nmcnativeTargetPlaylist');
    if (select) {
        select.replaceChildren(option('', '— 选择一个已有歌单 —'));
        select.value = '';
    }
    renderTargetPlaylistStatus('尚未选择目标歌单');
    updatePlaylistControls();
}

async function refreshStatus({ silent = false } = {}) {
    try {
        const status = await api('/status');
        state.accounts = Array.isArray(status.accounts) ? status.accounts : [];
        state.activeAccountId = String(status.activeAccountId || '');
        state.loggedIn = status.loggedIn === true;
        state.togetherEnabled = status.togetherEnabled === true;
        renderAccounts();
        renderLoginStatus(status);
        renderTogetherVisibility();
        updateActiveLabel();
        updatePlaylistControls();
        setConnectionState(status.message || '后端已连接', status.loggedIn ? 'success' : 'warning');
        if (!silent) {
            setMessage(status.loggedIn ? '登录状态有效。' : status.message || '请选择一个账号并扫码登录。', status.loggedIn ? 'success' : 'info');
        }
        return status;
    } catch (error) {
        setConnectionState('无法连接插件后端', 'error');
        if (!silent) {
            setMessage(error?.message || String(error), 'error');
        }
        throw error;
    }
}

function stopLoginPolling() {
    state.loginPollToken += 1;
    if (state.loginPollTimer) {
        clearInterval(state.loginPollTimer);
        state.loginPollTimer = null;
    }
}

function closeQrPanel() {
    stopLoginPolling();
    const panel = element('nmcnativeQrPanel');
    if (panel) {
        panel.hidden = true;
    }
    const image = element('nmcnativeQrImage');
    if (image) {
        image.removeAttribute('src');
    }
}

async function checkQr(key, targetAccountId, token) {
    try {
        const result = await api(`/login/qr/check?key=${encodeURIComponent(key)}&targetAccountId=${encodeURIComponent(targetAccountId)}`);
        if (token !== state.loginPollToken) {
            return;
        }
        if (result.code === 803) {
            stopLoginPolling();
            closeQrPanel();
            setMessage(`账号 ${accountName(targetAccountId)} 登录成功。`, 'success');
            await refreshStatus({ silent: true });
            await Promise.allSettled([refreshCurrentPlaylist(), refreshPlaylists()]);
            return;
        }
        setText('nmcnativeQrStatus', result.message || '等待登录');
    } catch (error) {
        stopLoginPolling();
        setText('nmcnativeQrStatus', error?.message || String(error));
        setMessage(error?.message || String(error), 'error');
    }
}

async function showQrLogin() {
    const targetAccountId = element('nmcnativeAccountSelect')?.value;
    if (!targetAccountId) {
        throw new Error('请先选择目标账号');
    }
    closeQrPanel();
    const panel = element('nmcnativeQrPanel');
    if (panel) {
        panel.hidden = false;
    }
    setText('nmcnativeQrTitle', `扫码登录到：${accountName(targetAccountId)}`);
    setText('nmcnativeQrStatus', '正在生成二维码...');
    const result = await api(`/login/qr?targetAccountId=${encodeURIComponent(targetAccountId)}`);
    const image = element('nmcnativeQrImage');
    if (!image || !/^(data:image\/|https?:\/\/)/i.test(String(result.qrimg || ''))) {
        throw new Error('后端返回的二维码图片无效');
    }
    image.src = result.qrimg;
    setText('nmcnativeQrStatus', '请使用网易云音乐 App 扫码');

    stopLoginPolling();
    const token = state.loginPollToken;
    state.loginPollTimer = setInterval(
        () => checkQr(result.key, result.targetAccountId, token),
        2000,
    );
}

function stopTogetherPolling() {
    if (state.togetherPollTimer) {
        clearInterval(state.togetherPollTimer);
        state.togetherPollTimer = null;
    }
    state.togetherPollFailures = 0;
    const button = element('nmcnativeToggleSongPolling');
    if (button) {
        button.textContent = '刷新当前歌曲';
    }
}

function resetTogetherPanel() {
    stopTogetherPolling();
    state.inTogetherRoom = false;
    state.currentSong = null;
    state.roomPlaylist = [];
    state.roomPlaylistCurrentId = '';
    setText('nmcnativeTogetherRoom', '未加入房间');
    setText('nmcnativeTogetherSong', '暂无歌曲信息');
    setText('nmcnativeTogetherPlaylistState', '房间歌单尚未读取');
    setText('nmcnativeCharComment', '');
    const playlist = element('nmcnativeTogetherPlaylist');
    if (playlist) {
        playlist.replaceChildren(option('', '— 刷新房间歌单后选择 —'));
    }
    const invite = element('nmcnativeInviteLink');
    if (invite) {
        invite.removeAttribute('href');
        invite.textContent = '尚未创建邀请链接';
    }
    const input = element('nmcnativeTogetherLink');
    if (input) {
        input.value = '';
    }
    const copy = element('nmcnativeCopyInvite');
    if (copy) {
        copy.disabled = true;
        copy.dataset.url = '';
    }
}

function renderTogetherVisibility() {
    const section = element('nmcnativeTogetherSection');
    if (!section) {
        return;
    }
    section.hidden = false;
    section.dataset.enabled = state.togetherEnabled ? 'true' : 'false';
    section.querySelectorAll('button').forEach(button => {
        button.disabled = !state.togetherEnabled;
    });
    const disabledNotice = element('nmcnativeTogetherDisabled');
    if (disabledNotice) {
        disabledNotice.hidden = state.togetherEnabled;
    }
    if (state.togetherEnabled) {
        const copy = element('nmcnativeCopyInvite');
        if (copy && !copy.dataset.url) {
            copy.disabled = true;
        }
        return;
    }
    if (!state.togetherEnabled) {
        resetTogetherPanel();
    }
}

function safeInviteUrl(value) {
    try {
        const parsed = new URL(String(value || ''), window.location.origin);
        const allowedHosts = new Set(['st.music.163.com', 'y.music.163.com', 'music.163.com']);
        return ['http:', 'https:'].includes(parsed.protocol) && allowedHosts.has(parsed.hostname)
            ? parsed.toString()
            : '';
    } catch {
        return '';
    }
}

function showInvite(roomId, inviteUrl, { joined = true } = {}) {
    const link = element('nmcnativeInviteLink');
    const copy = element('nmcnativeCopyInvite');
    const safeUrl = safeInviteUrl(inviteUrl);
    const urlRoomId = (() => {
        try {
            if (!safeUrl) {
                return '';
            }
            const parsed = new URL(safeUrl);
            return parsed.searchParams.get('roomId') || parsed.searchParams.get('id') || '';
        } catch {
            return '';
        }
    })();
    const resolvedRoomId = roomId || urlRoomId;
    setText(
        'nmcnativeTogetherRoom',
        resolvedRoomId
            ? `${joined ? '当前房间' : '分享链接房间'}：${resolvedRoomId}`
            : '未加入房间',
    );
    state.inTogetherRoom = joined && Boolean(resolvedRoomId);
    const input = element('nmcnativeTogetherLink');
    if (input && safeUrl) {
        input.value = safeUrl;
    }
    if (link) {
        if (safeUrl) {
            link.href = safeUrl;
            link.textContent = safeUrl;
        } else {
            link.removeAttribute('href');
            link.textContent = '尚未创建邀请链接';
        }
    }
    if (copy) {
        copy.disabled = !safeUrl;
        copy.dataset.url = safeUrl;
    }
}

function renderTogetherSong(song) {
    state.currentSong = song || null;
    if (!song?.songName) {
        setText('nmcnativeTogetherSong', '暂无歌曲信息');
        return;
    }
    const parts = [
        `《${song.songName}》`,
        song.artist || '',
        song.album ? `专辑：${song.album}` : '',
    ].filter(Boolean);
    if (Number(song.duration) > 0) {
        const seconds = Math.max(0, Math.floor(Number(song.progress || 0) / 1000));
        const duration = Math.max(0, Math.floor(Number(song.duration) / 1000));
        const format = value => `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
        parts.push(`${format(seconds)} / ${format(duration)}`);
    }
    setText('nmcnativeTogetherSong', parts.join(' · '));
}

function parseLrc(lyricText, translatedText = '') {
    const translations = new Map();
    const parseLines = (text, callback) => {
        for (const rawLine of String(text || '').split(/\r?\n/)) {
            const timestamps = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g)];
            if (!timestamps.length) {
                continue;
            }
            const content = rawLine.replace(/\[[^\]]+\]/g, '').trim();
            if (!content) {
                continue;
            }
            for (const match of timestamps) {
                const seconds = Number(match[1]) * 60 + Number(match[2]);
                callback(seconds, content);
            }
        }
    };
    parseLines(translatedText, (seconds, content) => {
        translations.set(seconds.toFixed(3), content);
    });
    const lines = [];
    parseLines(lyricText, (time, text) => {
        lines.push({
            time,
            text,
            translation: translations.get(time.toFixed(3)) || '',
        });
    });
    lines.sort((left, right) => left.time - right.time);
    return lines;
}

function renderPlayerLyrics() {
    const container = element('nmcnativePlayerLyrics');
    if (!container) {
        return;
    }
    state.lyricIndex = -1;
    container.replaceChildren();
    if (!state.lyricLines.length) {
        const empty = document.createElement('p');
        empty.className = 'nmcnative-lyrics-empty';
        empty.textContent = state.playerSong ? '暂无可用歌词' : '播放或选择歌曲后显示歌词';
        container.append(empty);
        return;
    }
    state.lyricLines.forEach((line, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'nmcnative-lyric-line';
        row.dataset.index = String(index);
        row.dataset.time = String(line.time);
        row.textContent = line.text;
        if (line.translation) {
            const translation = document.createElement('span');
            translation.className = 'nmcnative-lyric-translation';
            translation.textContent = line.translation;
            row.append(translation);
        }
        row.addEventListener('click', () => {
            const audio = element('nmcnativePlayerAudio');
            if (audio && Number.isFinite(line.time)) {
                audio.currentTime = line.time;
            }
        });
        container.append(row);
    });
}

function syncPlayerLyrics() {
    const audio = element('nmcnativePlayerAudio');
    if (!audio || !state.lyricLines.length) {
        return;
    }
    const currentTime = Number(audio.currentTime) || 0;
    let nextIndex = -1;
    for (let index = 0; index < state.lyricLines.length; index += 1) {
        if (state.lyricLines[index].time <= currentTime + 0.08) {
            nextIndex = index;
        } else {
            break;
        }
    }
    if (nextIndex === state.lyricIndex) {
        return;
    }
    state.lyricIndex = nextIndex;
    const container = element('nmcnativePlayerLyrics');
    if (!container) {
        return;
    }
    container.querySelectorAll('.nmcnative-lyric-line').forEach((row, index) => {
        row.classList.toggle('active', index === nextIndex);
    });
    const active = container.querySelector(`.nmcnative-lyric-line[data-index="${nextIndex}"]`);
    active?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function loadPlayerSong(song, { autoplay = false } = {}) {
    if (!song?.id) {
        throw new Error('缺少歌曲 ID');
    }
    state.playerSong = {
        id: String(song.id),
        name: String(song.name || song.songName || song.song_name || '未知歌曲'),
        artist: String(song.artist || song.artists || ''),
        album: String(song.album || ''),
    };
    setText(
        'nmcnativePlayerSong',
        `《${state.playerSong.name}》${state.playerSong.artist ? ` · ${state.playerSong.artist}` : ''}${state.playerSong.album ? ` · ${state.playerSong.album}` : ''}`,
    );
    const audio = element('nmcnativePlayerAudio');
    if (!audio) {
        return;
    }
    audio.src = `${backendBase()}/song-audio/${encodeURIComponent(state.playerSong.id)}?level=standard`;
    audio.dataset.songId = state.playerSong.id;
    audio.load();
    state.lyricLines = [];
    renderPlayerLyrics();
    try {
        const lyric = await api(`/lyric?song_id=${encodeURIComponent(state.playerSong.id)}`);
        if (audio.dataset.songId === state.playerSong.id) {
            state.lyricLines = parseLrc(lyric.lyric, lyric.translated);
            renderPlayerLyrics();
        }
    } catch (error) {
        setMessage(error?.message || '歌词读取失败', 'error');
    }
    if (autoplay) {
        try {
            await audio.play();
            setMessage(`正在酒馆中播放《${state.playerSong.name}》。`, 'success');
        } catch {
            setMessage('浏览器阻止了自动播放，请点击音频播放器上的播放按钮。', 'info');
        }
    }
}

async function searchPlayerSongs() {
    const keyword = element('nmcnativePlayerSearchInput')?.value.trim();
    if (!keyword) {
        throw new Error('请输入歌曲、歌手或关键词');
    }
    const results = await api('/search-with-lyric', {
        method: 'POST',
        body: { keyword, limit: 8 },
    });
    state.playerSearchResults = Array.isArray(results) ? results : [];
    const select = element('nmcnativePlayerSearchResults');
    if (!select) {
        return;
    }
    select.replaceChildren(option('', state.playerSearchResults.length
        ? '— 选择搜索结果 —'
        : '— 没有搜索结果 —'));
    for (const song of state.playerSearchResults) {
        select.append(option(
            song.id,
            `${song.name}${song.artist ? ` · ${song.artist}` : ''}`,
        ));
    }
    if (state.playerSearchResults.length) {
        select.value = state.playerSearchResults[0].id;
    }
    setMessage(`找到 ${state.playerSearchResults.length} 首候选歌曲。`, 'success');
}

async function playSelectedPlayerSong() {
    const songId = element('nmcnativePlayerSearchResults')?.value;
    const song = state.playerSearchResults.find(item => String(item.id) === String(songId));
    if (!song) {
        throw new Error('请先搜索并选择歌曲');
    }
    await loadPlayerSong(song, { autoplay: true });
}

async function playCurrentTogetherSong() {
    await pollTogetherSongOnce();
    if (!state.currentSong?.songId) {
        throw new Error('一起听房间没有可用歌曲 ID，请先刷新当前歌曲');
    }
    await loadPlayerSong({
        id: state.currentSong.songId,
        name: state.currentSong.songName,
        artist: state.currentSong.artist,
        album: state.currentSong.album,
    }, { autoplay: true });
}

async function sendTogetherMessage() {
    const input = element('nmcnativeTogetherMessage');
    const message = input?.value.trim();
    if (!message) {
        throw new Error('请输入要发送的消息');
    }
    const result = await api('/together/send-message', {
        method: 'POST',
        body: { message },
    });
    const log = element('nmcnativeTogetherMessageLog');
    if (log) {
        const row = document.createElement('p');
        row.className = 'nmcnative-sent-message';
        row.textContent = `我：${message}`;
        log.append(row);
        log.scrollTop = log.scrollHeight;
    }
    input.value = '';
    setMessage(`消息已发送到一起听伙伴的网易云私信（${result.sentTo}）。`, 'success');
}

function renderRoomPlaylist(data) {
    state.roomPlaylist = Array.isArray(data?.songs) ? data.songs : [];
    state.roomPlaylistCurrentId = String(data?.currentSongId || '');
    const select = element('nmcnativeTogetherPlaylist');
    if (select) {
        select.replaceChildren(option('', state.roomPlaylist.length
            ? '— 选择房间歌曲 —'
            : '— 房间歌单为空 —'));
        for (const song of state.roomPlaylist) {
            const marker = String(song.id) === state.roomPlaylistCurrentId ? '（当前）' : '';
            select.append(option(song.id, `${song.name}${song.artist ? ` · ${song.artist}` : ''}${marker}`));
        }
        if (state.roomPlaylistCurrentId && state.roomPlaylist.some(song => String(song.id) === state.roomPlaylistCurrentId)) {
            select.value = state.roomPlaylistCurrentId;
        }
    }
    setText(
        'nmcnativeTogetherPlaylistState',
        state.roomPlaylist.length
            ? `房间歌单：${state.roomPlaylist.length} 首${data?.playStatus ? ` · ${data.playStatus}` : ''}`
            : '房间歌单为空',
    );
    const toggle = element('nmcnativeTogetherToggle');
    if (toggle) {
        toggle.textContent = String(data?.playStatus || '').toUpperCase() === 'PAUSE'
            ? '继续播放'
            : '暂停';
    }
}

async function refreshRoomPlaylist() {
    const data = await api('/together/room-playlist');
    renderRoomPlaylist(data);
    return data;
}

function selectedPlayerSong() {
    const selectedId = element('nmcnativePlayerSearchResults')?.value;
    const searched = state.playerSearchResults.find(item => String(item.id) === String(selectedId));
    if (searched) {
        return searched;
    }
    return state.playerSong;
}

async function addSelectedPlayerSongToRoom() {
    const song = selectedPlayerSong();
    if (!song?.id) {
        throw new Error('请先搜索并选择歌曲');
    }
    const data = await api('/together/room-playlist/add', {
        method: 'POST',
        body: { songId: String(song.id) },
    });
    renderRoomPlaylist(data);
    setMessage(`已将《${song.name || song.songName}》添加到一起听房间歌单。`, 'success');
}

async function playSelectedRoomSong() {
    const songId = element('nmcnativeTogetherPlaylist')?.value;
    if (!songId) {
        throw new Error('请先选择房间歌曲');
    }
    await api('/together/room-playlist/play', {
        method: 'POST',
        body: { songId },
    });
    await refreshRoomPlaylist();
    setMessage('已向一起听房间发送切歌指令。', 'success');
}

async function controlTogetherRoom(command) {
    await api('/together/control', {
        method: 'POST',
        body: { command },
    });
    await refreshRoomPlaylist();
    setMessage(`已发送一起听控制指令：${command}`, 'success');
}

function renderSongComments(data) {
    state.comments = Array.isArray(data?.comments) ? data.comments : [];
    const container = element('nmcnativeSongComments');
    if (!container) {
        return;
    }
    container.replaceChildren();
    if (!state.comments.length) {
        const empty = document.createElement('p');
        empty.className = 'nmcnative-comment-empty';
        empty.textContent = '暂无评论';
        container.append(empty);
        return;
    }
    for (const comment of state.comments) {
        const row = document.createElement('div');
        row.className = 'nmcnative-comment';
        const meta = document.createElement('div');
        meta.className = 'nmcnative-comment-meta';
        meta.textContent = `${comment.nickname || '网易云用户'} · 赞 ${comment.likedCount || 0}`;
        const content = document.createElement('p');
        content.textContent = comment.content || '';
        row.append(meta, content);
        container.append(row);
    }
}

function currentCommentSongId() {
    return String(state.playerSong?.id || element('nmcnativePlayerSearchResults')?.value || '');
}

async function loadSongComments() {
    const songId = currentCommentSongId();
    if (!songId) {
        throw new Error('请先搜索、选择或播放歌曲');
    }
    renderSongComments(await api(`/song-comments/${encodeURIComponent(songId)}?limit=20`));
    setMessage('歌曲评论已刷新。', 'success');
}

async function sendSongComment() {
    const songId = currentCommentSongId();
    const input = element('nmcnativeSongCommentInput');
    const content = input?.value.trim();
    if (!songId) {
        throw new Error('请先搜索、选择或播放歌曲');
    }
    if (!content) {
        throw new Error('请输入评论内容');
    }
    await api(`/song-comments/${encodeURIComponent(songId)}`, {
        method: 'POST',
        body: { content },
    });
    input.value = '';
    await loadSongComments();
    setMessage('歌曲评论已发布。', 'success');
}

async function refreshTogetherState() {
    if (!state.togetherEnabled) {
        return;
    }
    const result = await api('/together/status');
    state.inTogetherRoom = result.inRoom === true;
    if (result.inRoom) {
        showInvite(result.roomId || '', result.inviteUrl || '');
        await refreshRoomPlaylist().catch(() => {});
    } else {
        setText('nmcnativeTogetherRoom', '未加入房间');
    }
}

async function refreshNativeServiceState({ start = false } = {}) {
    const mode = element('nmcnativeTogetherMode')?.value || 'local';
    const status = element('nmcnativeTogetherServiceState');
    if (!status) {
        return;
    }
    if (mode !== 'native') {
        status.textContent = '当前创建方式：本地逆向';
        status.dataset.kind = 'local';
        return;
    }
    try {
        if (start) {
            await api('/together/native/start', { method: 'POST', body: {} });
        }
        const result = await api('/together/native/status');
        const connection = result.transport === 'remote-http'
            ? '远程服务'
            : `端口 ${result.port}`;
        const accountMismatch = result.accountMatchesClient === false
            || result.accountMatchesCookie === false;
        status.textContent = result.running
            ? accountMismatch
                ? `原生服务账号与当前账号不一致（${connection}）`
                : `独立原生服务已连接（${connection}）`
            : '独立原生服务尚未启动';
        status.dataset.kind = result.running
            ? accountMismatch ? 'native-warning' : 'native-online'
            : 'native-offline';
    } catch (error) {
        status.textContent = error?.message || '独立原生服务不可用';
        status.dataset.kind = 'native-offline';
    }
}

async function pollTogetherSongOnce() {
    try {
        const song = await api('/together/now-playing');
        renderTogetherSong(song);
        state.togetherPollFailures = 0;
    } catch (error) {
        state.togetherPollFailures += 1;
        setMessage(error?.message || String(error), 'error');
        if (state.togetherPollFailures >= 3) {
            stopTogetherPolling();
        }
    }
}

function startTogetherPolling() {
    stopTogetherPolling();
    const button = element('nmcnativeToggleSongPolling');
    if (button) {
        button.textContent = '停止刷新歌曲';
    }
    void pollTogetherSongOnce();
    state.togetherPollTimer = setInterval(() => {
        void pollTogetherSongOnce();
    }, 5000);
}

function parseJsonReply(text) {
    const raw = String(text || '').trim();
    const withoutFence = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
        return JSON.parse(withoutFence);
    } catch {
        const start = withoutFence.indexOf('{');
        const end = withoutFence.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(withoutFence.slice(start, end + 1));
        }
        throw new Error('角色返回的内容不是有效 JSON');
    }
}

async function quiet(prompt) {
    if (typeof generateQuietPrompt !== 'function') {
        throw new Error('当前 SillyTavern 不支持后台静默生成');
    }
    const context = getContext();
    const prepared = substituteParams(`${prompt}\n\n${CANDIDATE_GUARD}`);
    const result = await generateQuietPrompt({
        quietPrompt: prepared,
        quietName: context.name2 || 'char',
    });
    return String(result || '').trim();
}

async function generatePersonaPlan({ withName = true } = {}) {
    const shape = withName
        ? '{"playlistName":"符合你气质的歌单名","keywords":["1-3个搜索关键词"]}'
        : '{"keywords":["1-3个搜索关键词"]}';
    const reply = await quiet(`你是 {{char}}。请根据你的人格、背景和最近对话，输出严格 JSON：${shape}。只输出 JSON，不要解释。`);
    const parsed = parseJsonReply(reply);
    const keywords = (Array.isArray(parsed.keywords) ? parsed.keywords : [])
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .slice(0, 3);
    if (keywords.length === 0) {
        throw new Error('角色没有生成可用的搜索关键词');
    }
    return {
        playlistName: withName ? String(parsed.playlistName || '').trim() : '',
        keywords,
    };
}

async function searchCandidates(keywords) {
    return await api('/search-with-lyric', {
        method: 'POST',
        body: { keyword: keywords.join(' '), limit: 8 },
    });
}

async function chooseSongs(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return [];
    }
    const compact = candidates.map(song => ({
        id: String(song.id),
        name: song.name,
        artist: song.artist,
        lyric_snippet: song.lyric_snippet || '',
    }));
    const reply = await quiet(`你是 {{char}}。以下是候选歌曲及歌词片段：${JSON.stringify(compact)}。请挑选最符合角色设定的歌曲，输出严格 JSON：{"selected":[{"id":"...","reason":"一句话理由"}]}。只输出 JSON。`);
    const parsed = parseJsonReply(reply);
    const candidateIds = new Set(compact.map(song => song.id));
    const used = new Set();
    return (Array.isArray(parsed.selected) ? parsed.selected : [])
        .map(item => ({
            id: String(item?.id || '').trim(),
            reason: String(item?.reason || '').trim().slice(0, 160),
        }))
        .filter(item => item.id && candidateIds.has(item.id) && !used.has(item.id) && used.add(item.id))
        .slice(0, compact.length);
}

function renderOperationResult({ title, playlistName, selected = [], added = 0, skipped = 0, message = '' }) {
    const node = element('nmcnativeOperationStatus');
    if (!node) {
        return;
    }
    node.replaceChildren();
    node.className = 'nmcnative-message nmcnative-message-success';
    const heading = document.createElement('div');
    heading.className = 'nmcnative-result-title';
    heading.textContent = title;
    node.append(heading);

    const meta = document.createElement('div');
    meta.textContent = [
        playlistName ? `歌单：${playlistName}` : '',
        `新增：${added}`,
        `跳过：${skipped}`,
        message,
    ].filter(Boolean).join(' · ');
    node.append(meta);

    if (selected.length > 0) {
        const list = document.createElement('ul');
        list.className = 'nmcnative-result-list';
        for (const song of selected) {
            const item = document.createElement('li');
            item.textContent = song.name
                ? `《${song.name}》${song.reason ? `：${song.reason}` : ''}`
                : `${song.id}${song.reason ? `：${song.reason}` : ''}`;
            list.append(item);
        }
        node.append(list);
    }
}

async function buildSelection() {
    const plan = await generatePersonaPlan({ withName: false });
    setConnectionState('正在搜索候选歌曲...', 'loading');
    const candidates = await searchCandidates(plan.keywords);
    if (candidates.length === 0) {
        return { plan, candidates, selected: [] };
    }
    setConnectionState('正在筛选候选歌曲...', 'loading');
    const selectedIds = await chooseSongs(candidates);
    const candidateMap = new Map(candidates.map(song => [String(song.id), song]));
    const selected = selectedIds.map(item => ({
        ...item,
        name: candidateMap.get(item.id)?.name || item.id,
        artist: candidateMap.get(item.id)?.artist || '',
    }));
    return { plan, candidates, selected };
}

async function runCreateFlow() {
    const plan = await generatePersonaPlan({ withName: true });
    if (!plan.playlistName) {
        plan.playlistName = `${getContext().name2 || '角色'}的歌单`;
    }
    setConnectionState('正在搜索候选歌曲...', 'loading');
    const candidates = await searchCandidates(plan.keywords);
    if (candidates.length === 0) {
        setMessage('未找到符合角色设定的歌曲，未创建歌单。', 'info');
        return;
    }
    setConnectionState('正在筛选候选歌曲...', 'loading');
    const selected = await chooseSongs(candidates);
    if (selected.length === 0) {
        setMessage('未找到符合角色设定的歌曲，未创建歌单。', 'info');
        return;
    }

    setConnectionState('正在创建歌单...', 'loading');
    const created = await api('/create-playlist', {
        method: 'POST',
        body: { name: plan.playlistName, privacy: false },
    });
    const added = await api('/add-tracks', {
        method: 'POST',
        body: { track_ids: selected.map(item => item.id) },
    });
    const songMap = new Map(candidates.map(song => [String(song.id), song.name]));
    const enriched = selected.map(item => ({ ...item, name: songMap.get(item.id) || item.id }));
    state.currentPlaylist = { id: created.playlist_id, name: created.name };
    renderCurrentPlaylist(state.currentPlaylist);
    await refreshPlaylists().catch(() => {});
    renderTargetPlaylistStatus(`当前目标：${created.name}`);
    renderOperationResult({
        title: '已新建歌单',
        playlistName: created.name,
        selected: enriched,
        added: Number(added.added) || 0,
        skipped: Number(added.skipped) || 0,
        message: added.message || '',
    });
}

async function runAddToCurrentFlow() {
    if (!state.currentPlaylist?.id) {
        throw new Error('当前没有歌单，请先点击「新建歌单」');
    }
    const { selected } = await buildSelection();
    if (selected.length === 0) {
        setMessage('未找到符合角色设定的歌曲，未添加。', 'info');
        return;
    }
    const added = await api('/add-tracks', {
        method: 'POST',
        body: { track_ids: selected.map(item => item.id) },
    });
    renderOperationResult({
        title: '已添加歌曲到当前歌单',
        playlistName: state.currentPlaylist.name,
        selected,
        added: Number(added.added) || 0,
        skipped: Number(added.skipped) || 0,
        message: added.message || '',
    });
}

async function switchAccount() {
    const accountId = element('nmcnativeAccountSelect')?.value;
    if (!accountId) {
        throw new Error('请先选择账号');
    }
    if (state.togetherEnabled && state.inTogetherRoom) {
        setMessage('切换账号将离开当前一起听房间。', 'info');
    }
    await api('/switch-account', { method: 'POST', body: { accountId } });
    closeQrPanel();
    stopTogetherPolling();
    resetTogetherPanel();
    const status = await refreshStatus({ silent: true });
    const tasks = [refreshCurrentPlaylist()];
    if (status.loggedIn) {
        tasks.push(refreshPlaylists());
    } else {
        resetPlaylistControls();
    }
    if (status.togetherEnabled) {
        tasks.push(refreshTogetherState());
    }
    await Promise.allSettled(tasks);
    setMessage(`已切换到 ${accountName(accountId)}。`, 'success');
}

function injectStyles() {
    if (element('nmcnativeStyles')) {
        return;
    }
    const style = document.createElement('style');
    style.id = 'nmcnativeStyles';
    style.textContent = `
        #netease-music-companion-native {
            margin: 10px 0 16px;
            padding: 14px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 72%, transparent);
            border-radius: 12px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 78%, transparent);
        }
        #netease-music-companion-native .inline-drawer-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 3px 0;
        }
        #netease-music-companion-native .nmcnative-header-copy {
            min-width: 0;
        }
        #netease-music-companion-native .nmcnative-header-tail {
            display: flex;
            align-items: center;
            gap: 12px;
            flex: 0 0 auto;
        }
        #netease-music-companion-native .inline-drawer-content {
            padding-top: 9px;
        }
        #netease-music-companion-native .nmcnative-first-section {
            margin-top: 0;
        }
        #netease-music-companion-native h3 {
            margin: 0;
            color: var(--SmartThemeBodyColor);
            font-size: 1.05rem;
            line-height: 1.25;
            overflow-wrap: anywhere;
        }
        #netease-music-companion-native .nmcnative-kicker {
            margin: 2px 0 0;
            opacity: .72;
            font-size: .82rem;
        }
        #netease-music-companion-native .nmcnative-status-dot {
            width: 9px;
            height: 9px;
            border-radius: 50%;
            background: #8c8c8c;
            box-shadow: 0 0 0 4px rgba(140,140,140,.12);
        }
        #netease-music-companion-native .nmcnative-status-dot[data-online="true"] {
            background: #45b36b;
            box-shadow: 0 0 0 4px rgba(69,179,107,.14);
        }
        #netease-music-companion-native .nmcnative-section {
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 48%, transparent);
        }
        #netease-music-companion-native .nmcnative-section:first-of-type {
            border-top: 0;
            padding-top: 0;
        }
        #netease-music-companion-native .nmcnative-section-title {
            margin: 0 0 8px;
            font-size: .88rem;
            font-weight: 650;
            letter-spacing: .01em;
        }
        #netease-music-companion-native .nmcnative-grid,
        #netease-music-companion-native .nmcnative-actions {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 8px;
        }
        #netease-music-companion-native .nmcnative-field {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        #netease-music-companion-native .nmcnative-field-wide {
            grid-column: 1 / -1;
        }
        #netease-music-companion-native label {
            font-size: .78rem;
            opacity: .78;
        }
        #netease-music-companion-native select,
        #netease-music-companion-native input {
            width: 100%;
            min-width: 0;
            box-sizing: border-box;
        }
        #netease-music-companion-native button {
            min-height: 34px;
            line-height: 1.25;
            color: var(--SmartThemeBodyColor);
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 82%, transparent);
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 92%, transparent);
        }
        #netease-music-companion-native button:hover:not(:disabled) {
            border-color: color-mix(in srgb, var(--SmartThemeBodyColor) 36%, transparent);
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 12%, var(--SmartThemeBlurTintColor));
        }
        #netease-music-companion-native button:disabled {
            opacity: .48;
            cursor: not-allowed;
        }
        #netease-music-companion-native .nmcnative-actions {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        #netease-music-companion-native .nmcnative-wide-button {
            grid-column: 1 / -1;
        }
        #netease-music-companion-native .nmcnative-note {
            margin: 7px 0 0;
            font-size: .78rem;
            line-height: 1.45;
            opacity: .72;
        }
        #netease-music-companion-native .nmcnative-module-disabled {
            margin: 8px 0 10px;
            padding: 8px 9px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 72%, transparent);
            border-radius: 8px;
            font-size: .8rem;
            line-height: 1.5;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 80%, transparent);
        }
        #netease-music-companion-native .nmcnative-qr {
            margin-top: 10px;
            padding: 10px;
            border: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor) 72%, transparent);
            border-radius: 10px;
        }
        #netease-music-companion-native .nmcnative-qr img {
            display: block;
            width: min(220px, 100%);
            height: auto;
            margin: 8px auto;
            image-rendering: crisp-edges;
            background: white;
            border-radius: 8px;
        }
        #netease-music-companion-native .nmcnative-status-line,
        #netease-music-companion-native .nmcnative-readonly {
            margin: 7px 0;
            font-size: .82rem;
            line-height: 1.5;
        }
        #netease-music-companion-native #nmcnativeTogetherServiceState[data-kind="native-online"] {
            color: #65c88a;
        }
        #netease-music-companion-native #nmcnativeTogetherServiceState[data-kind="native-warning"] {
            color: #e4b964;
        }
        #netease-music-companion-native #nmcnativeTogetherServiceState[data-kind="native-offline"] {
            opacity: .68;
        }
        #netease-music-companion-native .nmcnative-readonly strong {
            font-weight: 650;
        }
        #netease-music-companion-native .nmcnative-invite {
            overflow-wrap: anywhere;
        }
        #netease-music-companion-native audio {
            width: 100%;
            margin-top: 8px;
        }
        #netease-music-companion-native textarea {
            width: 100%;
            min-height: 64px;
            box-sizing: border-box;
            resize: vertical;
            color: var(--SmartThemeBodyColor);
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 92%, transparent);
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 82%, transparent);
            border-radius: 8px;
            padding: 8px 9px;
            font: inherit;
        }
        #netease-music-companion-native .nmcnative-lyrics {
            max-height: 230px;
            overflow-y: auto;
            margin-top: 9px;
            padding: 8px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 48%, transparent);
            border-radius: 9px;
            scroll-behavior: smooth;
        }
        #netease-music-companion-native .nmcnative-lyric-line {
            display: block;
            width: 100%;
            min-height: 0;
            padding: 6px 8px;
            border: 0;
            border-radius: 6px;
            text-align: left;
            white-space: normal;
            opacity: .54;
            background: transparent;
            transition: opacity .16s ease, background-color .16s ease;
        }
        #netease-music-companion-native .nmcnative-lyric-line.active {
            opacity: 1;
            font-weight: 700;
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 14%, transparent);
        }
        #netease-music-companion-native .nmcnative-lyric-translation {
            display: block;
            margin-top: 2px;
            font-size: .76rem;
            font-weight: 400;
            opacity: .72;
        }
        #netease-music-companion-native .nmcnative-lyrics-empty {
            margin: 0;
            padding: 14px 8px;
            text-align: center;
            font-size: .8rem;
            opacity: .65;
        }
        #netease-music-companion-native .nmcnative-message-log {
            max-height: 130px;
            overflow-y: auto;
            margin-top: 8px;
            padding: 7px 9px;
            border-radius: 8px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 80%, transparent);
        }
        #netease-music-companion-native .nmcnative-message-log:empty {
            display: none;
        }
        #netease-music-companion-native .nmcnative-sent-message {
            margin: 3px 0;
            font-size: .8rem;
            overflow-wrap: anywhere;
        }
        #netease-music-companion-native .nmcnative-comments {
            max-height: 240px;
            overflow-y: auto;
            margin-top: 8px;
            padding: 7px;
            border-radius: 8px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 80%, transparent);
        }
        #netease-music-companion-native .nmcnative-comment {
            padding: 7px 8px;
            border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 32%, transparent);
        }
        #netease-music-companion-native .nmcnative-comment:last-child {
            border-bottom: 0;
        }
        #netease-music-companion-native .nmcnative-comment-meta {
            font-size: .72rem;
            opacity: .62;
        }
        #netease-music-companion-native .nmcnative-comment p {
            margin: 3px 0 0;
            font-size: .82rem;
            line-height: 1.45;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }
        #netease-music-companion-native .nmcnative-comment-empty {
            margin: 0;
            padding: 10px;
            text-align: center;
            font-size: .8rem;
            opacity: .62;
        }
        #netease-music-companion-native .nmcnative-message {
            margin-top: 12px;
            padding: 9px 10px;
            border-radius: 9px;
            font-size: .82rem;
            line-height: 1.5;
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 10%, transparent);
        }
        #netease-music-companion-native .nmcnative-message-error {
            background: rgba(180, 54, 54, .12);
        }
        #netease-music-companion-native .nmcnative-message-success {
            background: rgba(57, 150, 91, .11);
        }
        #netease-music-companion-native .nmcnative-result-title {
            font-weight: 650;
            margin-bottom: 3px;
        }
        #netease-music-companion-native .nmcnative-result-list {
            margin: 6px 0 0;
            padding-left: 18px;
        }
        #netease-music-companion-native .nmcnative-busy {
            cursor: progress;
        }
        #netease-music-companion-native [hidden] {
            display: none !important;
        }
        @media (max-width: 700px) {
            #netease-music-companion-native .nmcnative-grid,
            #netease-music-companion-native .nmcnative-actions {
                grid-template-columns: 1fr;
            }
        }
    `;
    document.head.append(style);
}

function panelHtml() {
    return `
        <div id="netease-music-companion-native">
            <div class="inline-drawer">
                <div id="nmcnativeDrawerHeader" class="inline-drawer-toggle inline-drawer-header" role="button" tabindex="0" aria-expanded="false">
                    <div class="nmcnative-header-copy">
                        <h3>Netease Music Companion Native</h3>
                        <p class="nmcnative-kicker">多账号歌单整理与一起听助手</p>
                    </div>
                    <div class="nmcnative-header-tail">
                        <span id="nmcnativeStatusDot" class="nmcnative-status-dot" aria-label="登录状态"></span>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" aria-hidden="true"></div>
                    </div>
                </div>

                <div class="inline-drawer-content">
            <section class="nmcnative-section nmcnative-first-section">
                <div class="nmcnative-grid">
                    <div class="nmcnative-field nmcnative-field-wide">
                        <label for="nmcnativeBackendUrl">后端地址</label>
                        <input id="nmcnativeBackendUrl" type="text" spellcheck="false">
                    </div>
                    <div class="nmcnative-field nmcnative-field-wide">
                        <label for="nmcnativeAccountSelect">选择账号</label>
                        <select id="nmcnativeAccountSelect"></select>
                    </div>
                    <button id="nmcnativeSwitchAccount" type="button">切换</button>
                    <button id="nmcnativeAddAccount" type="button">+ 添加账号</button>
                    <button id="nmcnativeDeleteAccount" type="button">删除账号</button>
                    <button id="nmcnativeRenameAccount" type="button">重命名</button>
                    <button id="nmcnativeCheckStatus" type="button">检查登录状态</button>
                    <button id="nmcnativeQrLogin" type="button">扫码登录</button>
                    <button id="nmcnativeLogout" type="button">退出登录</button>
                </div>
                <p id="nmcnativeLoginState" class="nmcnative-status-line">正在读取账号状态...</p>
            </section>

            <section id="nmcnativeQrPanel" class="nmcnative-qr" hidden>
                <strong id="nmcnativeQrTitle">扫码登录</strong>
                <img id="nmcnativeQrImage" alt="网易云音乐登录二维码">
                <p id="nmcnativeQrStatus" class="nmcnative-status-line">正在生成二维码...</p>
                <div class="nmcnative-grid">
                    <button id="nmcnativeRefreshQr" type="button">刷新二维码</button>
                    <button id="nmcnativeCloseQr" type="button">关闭</button>
                </div>
            </section>

            <section class="nmcnative-section">
                <p class="nmcnative-section-title">酒馆播放器</p>
                <div class="nmcnative-field">
                    <label for="nmcnativePlayerSearchInput">搜索歌曲</label>
                    <input id="nmcnativePlayerSearchInput" type="search" placeholder="歌曲、歌手或关键词">
                </div>
                <div class="nmcnative-actions">
                    <button id="nmcnativePlayerSearch" type="button">搜索</button>
                    <button id="nmcnativePlayTogetherSong" type="button">播放一起听当前歌曲</button>
                </div>
                <div class="nmcnative-field">
                    <label for="nmcnativePlayerSearchResults">搜索结果</label>
                    <select id="nmcnativePlayerSearchResults">
                        <option value="">— 先搜索歌曲 —</option>
                    </select>
                </div>
                <button id="nmcnativePlaySelectedSong" class="nmcnative-wide-button" type="button">播放选中歌曲</button>
                <p id="nmcnativePlayerSong" class="nmcnative-status-line">尚未载入歌曲</p>
                <audio id="nmcnativePlayerAudio" controls preload="metadata"></audio>
                <div id="nmcnativePlayerLyrics" class="nmcnative-lyrics">
                    <p class="nmcnative-lyrics-empty">播放或选择歌曲后显示歌词</p>
                </div>
                <div class="nmcnative-actions">
                    <button id="nmcnativeLoadSongComments" type="button">读取歌曲评论</button>
                    <button id="nmcnativeSendSongComment" type="button">发布评论</button>
                </div>
                <div class="nmcnative-field">
                    <label for="nmcnativeSongCommentInput">歌曲评论</label>
                    <textarea id="nmcnativeSongCommentInput" maxlength="140" placeholder="写一条不超过 140 字的评论"></textarea>
                </div>
                <div id="nmcnativeSongComments" class="nmcnative-comments">
                    <p class="nmcnative-comment-empty">载入歌曲后可读取评论</p>
                </div>
                <p class="nmcnative-note">音频通过插件后端代理播放。歌词会自动跟随播放进度，点击歌词可跳转。</p>
            </section>

            <section id="nmcnativeTogetherSection" class="nmcnative-section">
                <p class="nmcnative-section-title">一起听</p>
                <div class="nmcnative-field">
                    <label for="nmcnativeTogetherMode">创建方式</label>
                    <select id="nmcnativeTogetherMode">
                        <option value="local">本地逆向</option>
                        <option value="native">独立原生服务</option>
                    </select>
                </div>
                <p id="nmcnativeTogetherServiceState" class="nmcnative-status-line">当前创建方式：本地逆向</p>
                <p id="nmcnativeTogetherDisabled" class="nmcnative-module-disabled">一起听当前未启用。将 config.json 中的 enableTogetherListen 改为 true 并重启 SillyTavern 后即可使用。</p>
                <p id="nmcnativeTogetherRoom" class="nmcnative-status-line">未加入房间</p>
                <p id="nmcnativeTogetherSong" class="nmcnative-status-line">暂无歌曲信息</p>
                <div class="nmcnative-field">
                    <label for="nmcnativeTogetherLink">一起听分享链接或房间 ID</label>
                    <input id="nmcnativeTogetherLink" type="text" spellcheck="false" placeholder="https://st.music.163.com/listen-together/share/index.html?roomId=...">
                </div>
                <p class="nmcnative-status-line"><a id="nmcnativeInviteLink" class="nmcnative-invite" target="_blank" rel="noopener noreferrer">尚未创建邀请链接</a></p>
                <div class="nmcnative-actions">
                    <button id="nmcnativeCopyInvite" type="button" disabled>复制链接</button>
                    <button id="nmcnativeSendInviteDm" type="button">发送邀请到私信</button>
                    <button id="nmcnativeJoinRoom" type="button">加入分享房间</button>
                    <button id="nmcnativeJoinRoomById" type="button">按房间号加入</button>
                    <button id="nmcnativeCreateRoom" type="button">创建房间</button>
                    <button id="nmcnativeToggleSongPolling" type="button">刷新当前歌曲</button>
                    <button id="nmcnativeSpeakSong" type="button">让角色说说这首歌</button>
                    <button id="nmcnativeLeaveRoom" type="button">离开房间</button>
                </div>
                <p id="nmcnativeCharComment" class="nmcnative-status-line"></p>
                <div class="nmcnative-field">
                    <label for="nmcnativeTogetherPlaylist">房间歌单</label>
                    <select id="nmcnativeTogetherPlaylist">
                        <option value="">— 刷新房间歌单后选择 —</option>
                    </select>
                </div>
                <p id="nmcnativeTogetherPlaylistState" class="nmcnative-status-line">房间歌单尚未读取</p>
                <div class="nmcnative-actions">
                    <button id="nmcnativeRefreshRoomPlaylist" type="button">刷新房间歌单</button>
                    <button id="nmcnativeAddToRoomPlaylist" type="button">添加播放器选中歌曲</button>
                    <button id="nmcnativePlayRoomSong" type="button">播放选中房间歌曲</button>
                    <button id="nmcnativeTogetherPrevious" type="button">上一首</button>
                    <button id="nmcnativeTogetherToggle" type="button">暂停</button>
                    <button id="nmcnativeTogetherNext" type="button">下一首</button>
                </div>
                <div class="nmcnative-field">
                    <label for="nmcnativeTogetherMessage">发送给一起听伙伴的消息</label>
                    <textarea id="nmcnativeTogetherMessage" maxlength="500" placeholder="输入消息..."></textarea>
                </div>
                <button id="nmcnativeSendTogetherMessage" class="nmcnative-wide-button" type="button">发送消息</button>
                <div id="nmcnativeTogetherMessageLog" class="nmcnative-message-log" aria-live="polite"></div>
                <p class="nmcnative-note">当前桌面客户端未公开房间聊天发送接口，此功能通过网易云私信发送给 config.json 中的一起听伙伴。</p>
                <p class="nmcnative-note">可以直接创建房间，也可以粘贴网易云 App 分享链接或旧版房间号。两种模式均会保留。</p>
            </section>

            <section class="nmcnative-section">
                <p class="nmcnative-section-title">歌单操作</p>
                <div class="nmcnative-field">
                    <label for="nmcnativeTargetPlaylist">目标歌单</label>
                    <select id="nmcnativeTargetPlaylist">
                        <option value="">— 选择一个已有歌单 —</option>
                    </select>
                </div>
                <div class="nmcnative-grid">
                    <button id="nmcnativeRefreshPlaylists" type="button">刷新歌单列表</button>
                    <button id="nmcnativeUsePlaylist" type="button">使用选中歌单</button>
                </div>
                <p id="nmcnativeTargetPlaylistStatus" class="nmcnative-status-line">尚未选择目标歌单</p>
                <p class="nmcnative-note">角色会先搜索候选歌曲，再根据角色设定选择。候选歌曲不会从当前歌单中读取。</p>
                <div class="nmcnative-actions">
                    <button id="nmcnativeCreateByPersona" type="button">新建歌单</button>
                    <button id="nmcnativeAddToCurrent" type="button">添加歌曲到当前歌单</button>
                </div>
            </section>

            <section class="nmcnative-section nmcnative-readonly">
                <p><strong>活动账号：</strong><span id="nmcnativeActiveLabel">—</span></p>
                <p><strong>当前歌单：</strong><span id="nmcnativeCurrentPlaylist">未设置</span></p>
                <p id="nmcnativeConnectionState" class="nmcnative-status-line">等待连接后端...</p>
            </section>

            <div id="nmcnativeOperationStatus" class="nmcnative-message">所有生成均在后台完成，不会写入聊天历史。</div>
                </div>
            </div>
        </div>
    `;
}

function updateActiveLabel() {
    setText('nmcnativeActiveLabel', `${accountName(state.activeAccountId)}${state.activeAccountId ? ` (${state.activeAccountId})` : ''}`);
}

function initializeCollapsibleDrawer() {
    const header = element('nmcnativeDrawerHeader');
    const content = header?.closest('.inline-drawer')?.querySelector(':scope > .inline-drawer-content');
    const icon = header?.querySelector('.inline-drawer-icon');
    if (!header || !content || !icon) {
        return;
    }

    const storageKey = 'netease-music-companion-native-drawer-open';
    let initiallyOpen = false;
    try {
        initiallyOpen = localStorage.getItem(storageKey) === 'true';
    } catch {
        // Local storage can be unavailable in restricted browser contexts.
    }

    const applyExpandedState = expanded => {
        header.setAttribute('aria-expanded', String(expanded));
        if (expanded) {
            content.style.display = 'block';
            icon.classList.remove('down', 'fa-circle-chevron-down');
            icon.classList.add('up', 'fa-circle-chevron-up');
        } else {
            content.style.display = 'none';
            icon.classList.remove('up', 'fa-circle-chevron-up');
            icon.classList.add('down', 'fa-circle-chevron-down');
        }
    };

    applyExpandedState(initiallyOpen);
    header.addEventListener('click', () => {
        window.setTimeout(() => {
            const expanded = window.getComputedStyle(content).display !== 'none';
            header.setAttribute('aria-expanded', String(expanded));
            try {
                localStorage.setItem(storageKey, String(expanded));
            } catch {
                // Keep the drawer usable even if persistence is unavailable.
            }
        }, 500);
    });
    header.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            header.click();
        }
    });
}

function bindEvents() {
    initializeCollapsibleDrawer();
    element('nmcnativeTogetherMode').addEventListener('change', event => {
        extension_settings[EXTENSION_KEY].togetherCreationMode = event.target.value;
        saveSettingsDebounced();
        void withBusy('正在检查一起听服务...', () => refreshNativeServiceState({ start: event.target.value === 'native' }));
    });
    element('nmcnativeBackendUrl').addEventListener('change', event => {
        extension_settings[EXTENSION_KEY].backendUrl = event.target.value.trim() || DEFAULT_BACKEND;
        saveSettingsDebounced();
        void refreshStatus();
    });

    element('nmcnativeAccountSelect').addEventListener('change', () => {
        const button = element('nmcnativeDeleteAccount');
        const chosen = element('nmcnativeAccountSelect').value;
        button.disabled = !chosen || chosen === state.activeAccountId || state.accounts.length <= 1;
    });

    element('nmcnativeSwitchAccount').addEventListener('click', () => {
        void withBusy('正在切换账号...', () => switchAccount());
    });
    element('nmcnativeDeleteAccount').addEventListener('click', () => {
        void withBusy('正在删除账号...', async () => {
            const accountId = element('nmcnativeAccountSelect').value;
            if (!confirm(`确定删除账号 ${accountName(accountId)}？`)) {
                return;
            }
            await api('/remove-account', { method: 'POST', body: { accountId } });
            await refreshStatus({ silent: true });
            setMessage('账号已删除。', 'success');
        });
    });
    element('nmcnativeRenameAccount').addEventListener('click', () => {
        void withBusy('正在重命名账号...', async () => {
            const accountId = element('nmcnativeAccountSelect').value;
            const label = window.prompt('新的账号标签', accountName(accountId))?.trim();
            if (!label) {
                return;
            }
            await api('/rename-account', { method: 'POST', body: { accountId, label } });
            await refreshStatus({ silent: true });
            setMessage('账号标签已更新。', 'success');
        });
    });
    element('nmcnativeAddAccount').addEventListener('click', () => {
        void withBusy('正在添加账号...', async () => {
            const accountId = window.prompt('账号 ID（1-32 位字母、数字或下划线）')?.trim();
            if (!accountId) {
                return;
            }
            const label = window.prompt('账号标签，例如：角色小号')?.trim();
            if (!label) {
                throw new Error('账号标签不能为空');
            }
            await api('/add-account', { method: 'POST', body: { accountId, label } });
            await refreshStatus({ silent: true });
            element('nmcnativeAccountSelect').value = accountId;
            setMessage(`账号 ${label} 已添加，请扫码登录。`, 'success');
        });
    });
    element('nmcnativeCheckStatus').addEventListener('click', () => {
        void withBusy('正在检查登录状态...', async () => {
            const status = await refreshStatus();
            if (status.loggedIn) {
                await refreshCurrentPlaylist();
            }
        });
    });
    element('nmcnativeQrLogin').addEventListener('click', () => {
        void withBusy('正在生成二维码...', () => showQrLogin());
    });
    element('nmcnativeRefreshQr').addEventListener('click', () => {
        void withBusy('正在刷新二维码...', () => showQrLogin());
    });
    element('nmcnativeCloseQr').addEventListener('click', closeQrPanel);
    element('nmcnativeLogout').addEventListener('click', () => {
        void withBusy('正在退出账号...', async () => {
            const accountId = element('nmcnativeAccountSelect').value;
            await api('/logout', { method: 'POST', body: { accountId } });
            closeQrPanel();
            resetTogetherPanel();
            await refreshStatus({ silent: true });
            resetPlaylistControls();
            setMessage(`账号 ${accountName(accountId)} 已退出登录。`, 'success');
        });
    });

    element('nmcnativeTargetPlaylist').addEventListener('change', () => {
        updatePlaylistControls();
    });
    element('nmcnativeRefreshPlaylists').addEventListener('click', () => {
        void withBusy('正在刷新歌单...', async () => {
            await refreshPlaylists();
            setMessage('歌单列表已刷新。', 'success');
        });
    });
    element('nmcnativeUsePlaylist').addEventListener('click', () => {
        void withBusy('正在设置目标歌单...', async () => {
            const select = element('nmcnativeTargetPlaylist');
            const playlistId = select.value;
            const selectedOption = select.selectedOptions[0];
            if (!playlistId || !selectedOption) {
                throw new Error('请先选择一个目标歌单');
            }
            const name = selectedOption.textContent
                .replace(/（\d+ 首）（红心）?$/, '')
                .replace(/（当前）$/, '')
                .trim();
            await api('/set-current-playlist', {
                method: 'POST',
                body: { playlist_id: playlistId, name },
            });
            state.currentPlaylist = { id: playlistId, name };
            renderCurrentPlaylist(state.currentPlaylist);
            renderTargetPlaylistStatus(`当前目标：${name}`);
            setMessage(`已将「${name}」设为当前歌单。`, 'success');
        });
    });

    element('nmcnativeCreateByPersona').addEventListener('click', () => {
        void withBusy('角色正在策划歌单...', () => runCreateFlow());
    });
    element('nmcnativeAddToCurrent').addEventListener('click', () => {
        void withBusy('角色正在为当前歌单选歌...', () => runAddToCurrentFlow());
    });

    element('nmcnativePlayerSearch').addEventListener('click', () => {
        void withBusy('正在搜索歌曲...', searchPlayerSongs);
    });
    element('nmcnativePlayerSearchInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void withBusy('正在搜索歌曲...', searchPlayerSongs);
        }
    });
    element('nmcnativePlaySelectedSong').addEventListener('click', () => {
        void withBusy('正在载入歌曲...', playSelectedPlayerSong);
    });
    element('nmcnativePlayTogetherSong').addEventListener('click', () => {
        void withBusy('正在读取一起听歌曲...', playCurrentTogetherSong);
    });
    element('nmcnativePlayerAudio').addEventListener('timeupdate', syncPlayerLyrics);
    element('nmcnativePlayerAudio').addEventListener('seeked', syncPlayerLyrics);
    element('nmcnativePlayerAudio').addEventListener('error', () => {
        if (element('nmcnativePlayerAudio')?.src) {
            setMessage('音频加载失败。歌曲可能需要会员、已下架或当前账号无权播放。', 'error');
        }
    });
    element('nmcnativeSendTogetherMessage').addEventListener('click', () => {
        void withBusy('正在发送消息...', sendTogetherMessage);
    });
    element('nmcnativeTogetherMessage').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void withBusy('正在发送消息...', sendTogetherMessage);
        }
    });
    element('nmcnativeLoadSongComments').addEventListener('click', () => {
        void withBusy('正在读取评论...', loadSongComments);
    });
    element('nmcnativeSendSongComment').addEventListener('click', () => {
        void withBusy('正在发布评论...', sendSongComment);
    });
    element('nmcnativeRefreshRoomPlaylist').addEventListener('click', () => {
        void withBusy('正在读取一起听房间歌单...', refreshRoomPlaylist);
    });
    element('nmcnativeAddToRoomPlaylist').addEventListener('click', () => {
        void withBusy('正在添加歌曲到房间...', addSelectedPlayerSongToRoom);
    });
    element('nmcnativePlayRoomSong').addEventListener('click', () => {
        void withBusy('正在切换房间歌曲...', playSelectedRoomSong);
    });
    element('nmcnativeTogetherPrevious').addEventListener('click', () => {
        void withBusy('正在切换上一首...', () => controlTogetherRoom('previous'));
    });
    element('nmcnativeTogetherToggle').addEventListener('click', () => {
        const command = element('nmcnativeTogetherToggle').textContent.includes('继续')
            ? 'play'
            : 'pause';
        void withBusy('正在同步播放状态...', () => controlTogetherRoom(command));
    });
    element('nmcnativeTogetherNext').addEventListener('click', () => {
        void withBusy('正在切换下一首...', () => controlTogetherRoom('next'));
    });

    element('nmcnativeTogetherLink').addEventListener('change', () => {
        const value = element('nmcnativeTogetherLink').value.trim();
        if (!value) {
            showInvite('', '');
            return;
        }
        if (/^[A-Za-z0-9_-]{8,240}$/.test(value)) {
            setMessage('已填写房间 ID，可点击「按房间号加入」。', 'info');
            return;
        }
        const safeUrl = safeInviteUrl(value);
        if (!safeUrl) {
            setMessage('仅支持网易云音乐的一起听分享链接。', 'error');
            return;
        }
        showInvite('', safeUrl, { joined: false });
        setMessage('分享链接可用，点击「加入分享房间」后生效。', 'info');
    });
    element('nmcnativeCopyInvite').addEventListener('click', () => {
        void (async () => {
            const url = element('nmcnativeTogetherLink').value.trim() || element('nmcnativeCopyInvite').dataset.url;
            if (!url) {
                return;
            }
            try {
                await navigator.clipboard.writeText(url);
                setMessage('邀请链接已复制。', 'success');
            } catch {
                setMessage('浏览器未允许写入剪贴板，请手动选中链接复制。', 'error');
            }
        })();
    });
    element('nmcnativeSendInviteDm').addEventListener('click', () => {
        void withBusy('正在发送文字私信...', async () => {
            const inviteUrl = element('nmcnativeTogetherLink').value.trim();
            if (!safeInviteUrl(inviteUrl)) {
                throw new Error('请先粘贴有效的一起听分享链接');
            }
            const wasJoined = state.inTogetherRoom;
            const result = await api('/together/send-invite-dm', {
                method: 'POST',
                body: { inviteUrl },
            });
            showInvite('', result.inviteUrl, { joined: wasJoined });
            setMessage('已发送到你的网易云私信，请打开 App 点击链接加入。', 'success');
        });
    });
    element('nmcnativeJoinRoom').addEventListener('click', () => {
        void withBusy('正在加入房间...', async () => {
            const inviteUrl = element('nmcnativeTogetherLink').value.trim();
            if (!safeInviteUrl(inviteUrl)) {
                throw new Error('请先粘贴有效的一起听分享链接');
            }
            const result = await api('/together/join', {
                method: 'POST',
                body: { inviteUrl },
            });
            showInvite(result.roomId, result.inviteUrl);
            await refreshTogetherState().catch(() => {});
            setMessage('已加入一起听房间。', 'success');
        });
    });
    element('nmcnativeJoinRoomById').addEventListener('click', () => {
        void withBusy('正在按房间号加入...', async () => {
            const inputValue = element('nmcnativeTogetherLink').value.trim();
            const roomId = /^[A-Za-z0-9_-]{8,240}$/.test(inputValue)
                ? inputValue
                : window.prompt('输入一起听房间 ID')?.trim();
            if (!roomId) {
                return;
            }
            const result = await api('/together/join', {
                method: 'POST',
                body: { roomId },
            });
            showInvite(result.roomId, result.inviteUrl);
            await refreshTogetherState().catch(() => {});
            setMessage('已提交按房间号加入请求。', 'success');
        });
    });
    element('nmcnativeCreateRoom').addEventListener('click', () => {
        void withBusy('正在创建房间...', async () => {
            const mode = element('nmcnativeTogetherMode').value;
            const result = mode === 'native'
                ? await api('/together/native/create', { method: 'POST', body: {} })
                : await api('/together/create', { method: 'POST', body: {} });
            showInvite(result.roomId, result.inviteUrl);
            await refreshNativeServiceState();
            if (result.roomId) {
                await refreshRoomPlaylist().catch(() => {});
            }
            setMessage(
                mode === 'native'
                    ? '独立原生服务已创建并激活房间，邀请已由桌面客户端发送。'
                    : '房间已创建，可复制链接、按房间号邀请或发送到私信。',
                'success',
            );
        });
    });
    element('nmcnativeToggleSongPolling').addEventListener('click', () => {
        if (state.togetherPollTimer) {
            stopTogetherPolling();
            setMessage('已停止刷新当前歌曲。', 'info');
        } else {
            startTogetherPolling();
        }
    });
    element('nmcnativeSpeakSong').addEventListener('click', () => {
        void withBusy('角色正在听歌...', async () => {
            if (!state.currentSong) {
                await pollTogetherSongOnce();
            }
            if (!state.currentSong?.songName) {
                throw new Error('请先刷新当前歌曲');
            }
            const reply = await quiet(`你是 {{char}}。你正在和我一起听歌，当前播放的是《${state.currentSong.songName}》- ${state.currentSong.artist || '未知歌手'}。请用你的人格和语气，对这首歌说一两句话（不超过 60 字），可以是感受、联想或对我说的悄悄话。只输出这句话，不要解释。`);
            setText('nmcnativeCharComment', String(reply).trim().slice(0, 120));
        });
    });
    element('nmcnativeLeaveRoom').addEventListener('click', () => {
        void withBusy('正在离开房间...', async () => {
            if (element('nmcnativeTogetherMode').value === 'native') {
                await api('/together/native/close', { method: 'POST', body: {} });
            } else {
                await api('/together/leave', { method: 'POST', body: {} });
            }
            resetTogetherPanel();
            setMessage('已离开一起听房间。', 'success');
        });
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopLoginPolling();
            stopTogetherPolling();
        }
    });

    if (!state.panelObserver) {
        state.panelObserver = new MutationObserver(() => {
            const panel = element('netease-music-companion-native');
            if (panel && panel.offsetParent === null) {
                stopTogetherPolling();
            }
        });
        state.panelObserver.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden'],
        });
    }
}

async function initializePanel() {
    initializeSettings();
    injectStyles();
    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.error('[Netease Music Companion Native] #extensions_settings was not found');
        return;
    }
    container.insertAdjacentHTML('beforeend', panelHtml());
    element('nmcnativeBackendUrl').value = extension_settings[EXTENSION_KEY].backendUrl;
    element('nmcnativeTogetherMode').value = extension_settings[EXTENSION_KEY].togetherCreationMode;
    bindEvents();
    resetPlaylistControls();
    renderTogetherVisibility();
    try {
        const status = await refreshStatus({ silent: true });
        updateActiveLabel();
        await refreshCurrentPlaylist();
        if (status.loggedIn) {
            await refreshPlaylists().catch(() => {});
        }
        if (status.togetherEnabled) {
            await refreshTogetherState().catch(() => {});
            await refreshNativeServiceState().catch(() => {});
        }
    } catch {
        setMessage('插件后端不可用。请确认 SillyTavern 已启用服务端插件并重启。', 'error');
    }
}

jQuery(async () => {
    await initializePanel();
});
