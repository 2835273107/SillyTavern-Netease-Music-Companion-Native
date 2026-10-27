import {
    generateQuietPrompt,
    getRequestHeaders,
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { ToolManager } from '../../../../scripts/tool-calling.js';
import { loadWorldInfo, world_info } from '../../../../scripts/world-info.js';
import { getPresetManager } from '../../../../scripts/preset-manager.js';

const EXTENSION_KEY = 'neteaseMusicCompanionNative';
const DEFAULT_BACKEND = '/api/plugins/netease-music-native';
const CANDIDATE_GUARD = '候选歌曲只能来自本次搜索接口返回的结果。禁止读取、引用或调用任何接口获取当前歌单中已有的歌曲作为候选。若搜索结果中没有符合角色设定的歌，返回空 selected 数组，不要从歌单中取歌补充。';
const TOGETHER_REPLY_CHAR_LIMIT = 60;
const SPEAK_SONG_CHAR_LIMIT = 80;
const SONG_COMMENT_CHAR_LIMIT = 120;

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
    messagePollTimer: null,
    messagePollBusy: false,
    messagePollTicks: 0,
    playerSong: null,
    playerSearchResults: [],
    playlists: [],
    playerPlaylists: [],
    playerPlaylistTracks: [],
    loadedPlaylistTracksId: '',
    playerSelectionSource: 'search',
    playerSource: 'playlist',
    playerQueue: [],
    playerQueueIndex: -1,
    playerAutoAdvancing: false,
    lyricLines: [],
    lyricCache: new Map(),
    lyricIndex: -1,
    roomPlaylist: [],
    roomPlaylistCurrentId: '',
    comments: [],
    messageContacts: [],
    selectedMessageContactId: '',
    messageHistory: [],
    generatedTogetherReplies: [],
    commentedSongIds: new Set(),
    commentingSongIds: new Set(),
    characterNameListeners: [],
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
    if (!['player', 'together', 'playlists', 'account'].includes(extension_settings[EXTENSION_KEY].activeTab)) {
        extension_settings[EXTENSION_KEY].activeTab = 'player';
    }
    if (!['playlist', 'search'].includes(extension_settings[EXTENSION_KEY].playerSource)) {
        extension_settings[EXTENSION_KEY].playerSource = 'playlist';
    }
    state.playerSource = extension_settings[EXTENSION_KEY].playerSource;
    if (typeof extension_settings[EXTENSION_KEY].continuousPlayback !== 'boolean') {
        extension_settings[EXTENSION_KEY].continuousPlayback = true;
    }
    if (typeof extension_settings[EXTENSION_KEY].characterAutoSelect !== 'boolean') {
        extension_settings[EXTENSION_KEY].characterAutoSelect = true;
    }
    if (typeof extension_settings[EXTENSION_KEY].conversationTools !== 'boolean') {
        extension_settings[EXTENSION_KEY].conversationTools = false;
    }
    if (typeof extension_settings[EXTENSION_KEY].includeTogetherLyrics !== 'boolean') {
        extension_settings[EXTENSION_KEY].includeTogetherLyrics = true;
    }
}

function privateGenerationLyricsEnabled() {
    return extension_settings[EXTENSION_KEY]?.includeTogetherLyrics !== false;
}

function backendBase() {
    const configured = String(extension_settings[EXTENSION_KEY]?.backendUrl || DEFAULT_BACKEND).trim();
    return (configured || DEFAULT_BACKEND).replace(/\/+$/, '');
}

function element(id) {
    return document.getElementById(id);
}

function activateTab(tab, { persist = true } = {}) {
    const selected = ['player', 'together', 'playlists', 'account'].includes(tab)
        ? tab
        : 'player';
    document.querySelectorAll('[data-nmcnative-tab]').forEach(button => {
        const active = button.dataset.nmcnativeTab === selected;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-nmcnative-panel]').forEach(panel => {
        panel.dataset.active = String(panel.dataset.nmcnativePanel === selected);
    });
    if (persist && extension_settings[EXTENSION_KEY]) {
        extension_settings[EXTENSION_KEY].activeTab = selected;
        saveSettingsDebounced();
    }
    if (selected === 'together') {
        startMessagePolling();
        if (element('nmcnativeTogetherMode')?.value === 'native' || state.inTogetherRoom) {
            startTogetherPolling();
        }
    } else {
        stopMessagePolling();
        stopTogetherPolling();
    }
}

function activatePlayerSource(source, { persist = true } = {}) {
    const selected = ['playlist', 'search'].includes(source) ? source : 'playlist';
    state.playerSource = selected;
    state.playerSelectionSource = selected;
    document.querySelectorAll('[data-nmcnative-player-source]').forEach(button => {
        const active = button.dataset.nmcnativePlayerSource === selected;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-nmcnative-player-source-panel]').forEach(panel => {
        panel.dataset.active = String(panel.dataset.nmcnativePlayerSourcePanel === selected);
    });
    if (persist && extension_settings[EXTENSION_KEY]) {
        extension_settings[EXTENSION_KEY].playerSource = selected;
        saveSettingsDebounced();
    }
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
        updateMessageReplyAvailability();
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
    const search = element('nmcnativeTargetPlaylistSearch');
    if (select) {
        select.disabled = !canUsePlaylists;
    }
    if (search) {
        search.disabled = !canUsePlaylists;
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

function playlistMatches(playlist, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) {
        return true;
    }
    return [playlist.name, playlist.creator]
        .some(value => String(value || '').toLowerCase().includes(needle));
}

function updatePlaylistChoiceSelection(listId, selectedId) {
    element(listId)?.querySelectorAll('.nmcnative-playlist-choice').forEach(row => {
        const selected = String(row.dataset.playlistId || '') === String(selectedId || '');
        row.classList.toggle('selected', selected);
        row.setAttribute('aria-selected', String(selected));
    });
}

function renderPlaylistChoices({
    listId,
    selectId,
    playlists,
    query = '',
    onSelect,
}) {
    const list = element(listId);
    const select = element(selectId);
    if (!list || !select) {
        return;
    }
    const filtered = playlists.filter(playlist => playlistMatches(playlist, query));
    list.replaceChildren();
    if (!playlists.length) {
        const empty = document.createElement('p');
        empty.className = 'nmcnative-list-empty';
        empty.textContent = state.loggedIn ? '没有读取到歌单' : '登录后显示歌单';
        list.append(empty);
        return;
    }
    if (!filtered.length) {
        const empty = document.createElement('p');
        empty.className = 'nmcnative-list-empty';
        empty.textContent = '没有匹配的歌单';
        list.append(empty);
        return;
    }
    filtered.forEach((playlist, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'nmcnative-playlist-choice';
        row.dataset.playlistId = String(playlist.id);
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(String(playlist.id) === String(select.value || '')));
        if (row.getAttribute('aria-selected') === 'true') {
            row.classList.add('selected');
        }

        const mark = document.createElement('span');
        mark.className = 'nmcnative-playlist-mark';
        mark.textContent = playlist.isLiked ? '♥' : String(index + 1).padStart(2, '0');

        const body = document.createElement('span');
        body.className = 'nmcnative-playlist-body';
        const name = document.createElement('span');
        name.className = 'nmcnative-playlist-name';
        name.textContent = playlist.name || '未命名歌单';
        const meta = document.createElement('span');
        meta.className = 'nmcnative-playlist-meta';
        meta.textContent = [
            `${Number(playlist.trackCount) || 0} 首`,
            playlist.creator || '',
            playlist.isLiked ? '我喜欢的音乐' : '',
        ].filter(Boolean).join(' · ');
        body.append(name, meta);
        row.append(mark, body);
        row.addEventListener('click', () => {
            select.value = String(playlist.id);
            updatePlaylistChoiceSelection(listId, select.value);
            onSelect?.(playlist);
        });
        list.append(row);
    });
}

function setPlaylistSummary(id, text) {
    setText(id, text);
}

function renderPlayerPlaylistChoices() {
    renderPlaylistChoices({
        listId: 'nmcnativePlayerPlaylistList',
        selectId: 'nmcnativePlayerPlaylist',
        playlists: state.playerPlaylists,
        query: element('nmcnativePlayerPlaylistSearch')?.value || '',
        onSelect: playlist => {
            state.playerSelectionSource = 'playlist';
            state.playerPlaylistTracks = [];
            renderPlayerPlaylistTrackChoices('正在读取歌曲...');
            setPlaylistSummary(
                'nmcnativePlayerPlaylistSummary',
                `${playlist.name || '未命名歌单'} · ${Number(playlist.trackCount) || 0} 首`,
            );
            void withBusy('正在读取歌单歌曲...', loadPlayerPlaylistTracks);
        },
    });
    const visibleCount = state.playerPlaylists.filter(
        playlist => playlistMatches(playlist, element('nmcnativePlayerPlaylistSearch')?.value),
    ).length;
    setPlaylistSummary(
        'nmcnativePlayerPlaylistSummary',
        state.playerPlaylists.length
            ? `显示 ${visibleCount} / ${state.playerPlaylists.length} 个歌单`
            : '尚未读取歌单',
    );
}

function renderTargetPlaylistChoices() {
    const select = element('nmcnativeTargetPlaylist');
    renderPlaylistChoices({
        listId: 'nmcnativeTargetPlaylistList',
        selectId: 'nmcnativeTargetPlaylist',
        playlists: state.playlists,
        query: element('nmcnativeTargetPlaylistSearch')?.value || '',
        onSelect: playlist => {
            const previousPlaylistId = String(state.currentPlaylist?.id || '');
            renderTargetPlaylistStatus(`正在切换：${playlist.name || '未命名歌单'}...`);
            void withBusy('正在切换目标歌单...', async () => {
                const playlistId = String(playlist.id || '').trim();
                const name = String(playlist.name || '未命名歌单').trim();
                if (!playlistId) {
                    throw new Error('歌单 ID 无效');
                }
                if (String(state.currentPlaylist?.id || '') !== playlistId) {
                    await api('/set-current-playlist', {
                        method: 'POST',
                        body: { playlist_id: playlistId, name },
                    });
                    state.currentPlaylist = { id: playlistId, name };
                }
                renderCurrentPlaylist(state.currentPlaylist);
                if (select) {
                    select.value = playlistId;
                }
                updatePlaylistChoiceSelection('nmcnativeTargetPlaylistList', playlistId);
                renderTargetPlaylistStatus();
                setConnectionState(`当前目标：${name}`, 'success');
                setMessage(`当前目标已切换为「${name}」。`, 'success');
                return { playlistId };
            }).then(result => {
                if (result) {
                    return;
                }
                select.value = previousPlaylistId;
                updatePlaylistChoiceSelection('nmcnativeTargetPlaylistList', previousPlaylistId);
                renderTargetPlaylistStatus();
                setConnectionState('切换目标歌单失败', 'warning');
            });
        },
    });
    const visibleCount = state.playlists.filter(
        playlist => playlistMatches(playlist, element('nmcnativeTargetPlaylistSearch')?.value),
    ).length;
    setPlaylistSummary(
        'nmcnativeTargetPlaylistSummary',
        state.playlists.length
            ? `显示 ${visibleCount} / ${state.playlists.length} 个歌单`
            : '尚未读取歌单',
    );
    updatePlaylistChoiceSelection('nmcnativeTargetPlaylistList', select?.value);
}

async function refreshPlaylists() {
    const select = element('nmcnativeTargetPlaylist');
    if (!select || !state.loggedIn) {
        return;
    }

    const previousValue = select.value || state.currentPlaylist?.id || '';
    select.replaceChildren(option('', '— 选择一个已有歌单 —'));
    const playlists = await api('/user-playlists');
    state.playlists = Array.isArray(playlists) ? playlists : [];
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
    renderTargetPlaylistChoices();
}

function resetPlaylistControls() {
    const select = element('nmcnativeTargetPlaylist');
    if (select) {
        select.replaceChildren(option('', '— 选择一个已有歌单 —'));
        select.value = '';
    }
    state.playlists = [];
    state.playerPlaylists = [];
    state.playerPlaylistTracks = [];
    state.loadedPlaylistTracksId = '';
    renderTargetPlaylistChoices();
    renderPlayerPlaylistChoices();
    renderPlayerPlaylistTrackChoices();
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
        const apiState = status.neteaseApi || {};
        const apiMessage = apiState.managed
            ? '网易云 API 已由插件自动启动'
            : apiState.autoStart
                ? '网易云 API 自动管理已启用'
                : '网易云 API 自动启动已关闭';
        setConnectionState(
            `${apiMessage} · ${status.message || '后端已连接'}`,
            apiState.error ? 'warning' : status.loggedIn ? 'success' : 'warning',
        );
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
    renderRoomPlaylistChoices();
    const playlistSearch = element('nmcnativeTogetherPlaylistSearch');
    if (playlistSearch) {
        playlistSearch.value = '';
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

function resetTogetherMessageState() {
    stopMessagePolling();
    state.messageContacts = [];
    state.selectedMessageContactId = '';
    state.messageHistory = [];
    state.generatedTogetherReplies = [];
    renderMessageContacts();
    renderTogetherMessageHistory();
    setText('nmcnativeTogetherMessageState', '尚未读取网易云私信');
    updateMessageReplyAvailability();
    renderTogetherReplyLog();
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
        updateMessageReplyAvailability();
        return;
    }
    if (!state.togetherEnabled) {
        resetTogetherPanel();
        resetTogetherMessageState();
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

function lyricLinesAsText(lines) {
    return (Array.isArray(lines) ? lines : [])
        .map(line => {
            const text = String(line.text || '').trim();
            const translation = String(line.translation || '').trim();
            return translation ? `${text}\n${translation}` : text;
        })
        .filter(Boolean)
        .join('\n');
}

async function getSongLyricsText(song, { maxChars = 0 } = {}) {
    const songId = String(song?.id || song?.songId || '').trim();
    if (!/^\d{1,20}$/.test(songId)) {
        return '';
    }
    let lyrics = state.lyricCache.get(songId) || '';
    if (!lyrics) {
        if (String(state.playerSong?.id || '') === songId && state.lyricLines.length) {
            lyrics = lyricLinesAsText(state.lyricLines);
        } else {
            try {
                const data = await api(`/lyric?song_id=${encodeURIComponent(songId)}`);
                lyrics = lyricLinesAsText(parseLrc(data?.lyric, data?.translated));
            } catch {
                lyrics = '';
            }
        }
        if (lyrics) {
            state.lyricCache.set(songId, lyrics);
        }
    }
    return Number(maxChars) > 0 ? lyrics.slice(0, maxChars) : lyrics;
}

async function songContextForGeneration(song, { maxLyricChars = 0 } = {}) {
    const name = song?.name || song?.songName || song?.song_name || '未知歌曲';
    const artist = song?.artist || '';
    const album = song?.album || '';
    const lyrics = await getSongLyricsText(song, { maxChars: maxLyricChars });
    return {
        name,
        artist,
        album,
        lyrics,
        text: [
            `歌曲：《${name}》`,
            artist ? `歌手：${artist}` : '',
            album ? `专辑：${album}` : '',
            lyrics ? `歌词：\n${lyrics}` : '歌词：网易云未返回可用歌词。请只根据已知歌曲信息表达，不要编造具体歌词。',
        ].filter(Boolean).join('\n'),
    };
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
}

async function loadPlayerSong(song, { autoplay = false, queue = null } = {}) {
    if (!song?.id) {
        throw new Error('缺少歌曲 ID');
    }
    state.playerSong = {
        id: String(song.id),
        name: String(song.name || song.songName || song.song_name || '未知歌曲'),
        artist: String(song.artist || song.artists || ''),
        album: String(song.album || ''),
    };
    if (Array.isArray(queue)) {
        state.playerQueue = queue.filter(item => item?.id);
        state.playerQueueIndex = state.playerQueue.findIndex(
            item => String(item.id) === String(state.playerSong.id),
        );
    } else if (!state.playerQueue.some(item => String(item.id) === String(state.playerSong.id))) {
        state.playerQueue = [state.playerSong];
        state.playerQueueIndex = 0;
    }
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

async function refreshPlayerPlaylists() {
    if (!state.loggedIn) {
        return;
    }
    const playlists = await api('/user-playlists');
    state.playerPlaylists = Array.isArray(playlists) ? playlists : [];
    const select = element('nmcnativePlayerPlaylist');
    if (!select) {
        return;
    }
    const previous = select.value || state.currentPlaylist?.id || '';
    select.replaceChildren(option('', '— 选择一个歌单 —'));
    for (const playlist of state.playerPlaylists) {
        select.append(option(
            playlist.id,
            `${playlist.name}（${playlist.trackCount || 0} 首）`,
        ));
    }
    if (state.playerPlaylists.some(playlist => String(playlist.id) === String(previous))) {
        select.value = String(previous);
    } else if (state.playerPlaylists.length) {
        select.value = String(state.playerPlaylists[0].id);
    }
    renderPlayerPlaylistChoices();
}

function trackMatches(track, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) {
        return true;
    }
    return [track.name, track.artist, track.album]
        .some(value => String(value || '').toLowerCase().includes(needle));
}

function formatTrackDuration(value) {
    const seconds = Math.max(0, Math.floor((Number(value) || 0) / 1000));
    if (!seconds) {
        return '';
    }
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderPlayerPlaylistTrackChoices(emptyText = '') {
    const list = element('nmcnativePlayerTrackList');
    const select = element('nmcnativePlayerPlaylistTrack');
    if (!list || !select) {
        return;
    }
    const filtered = state.playerPlaylistTracks.filter(
        track => trackMatches(track, element('nmcnativePlayerTrackSearch')?.value),
    );
    list.replaceChildren();
    setPlaylistSummary(
        'nmcnativePlayerTrackSummary',
        state.playerPlaylistTracks.length
            ? `显示 ${filtered.length} / ${state.playerPlaylistTracks.length} 首`
            : emptyText || '尚未读取歌曲',
    );
    if (!state.playerPlaylistTracks.length) {
        const empty = document.createElement('p');
        empty.className = 'nmcnative-list-empty';
        empty.textContent = emptyText || '选择歌单后显示歌曲';
        list.append(empty);
        return;
    }
    if (!filtered.length) {
        const empty = document.createElement('p');
        empty.className = 'nmcnative-list-empty';
        empty.textContent = '没有匹配的歌曲';
        list.append(empty);
        return;
    }
    filtered.forEach((track, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'nmcnative-track-choice';
        row.dataset.songId = String(track.id);
        row.setAttribute('role', 'option');
        const selected = String(track.id) === String(select.value || '');
        row.classList.toggle('selected', selected);
        row.setAttribute('aria-selected', String(selected));

        const number = document.createElement('span');
        number.className = 'nmcnative-track-number';
        number.textContent = String(index + 1).padStart(2, '0');
        const body = document.createElement('span');
        body.className = 'nmcnative-track-body';
        const name = document.createElement('span');
        name.className = 'nmcnative-track-name';
        name.textContent = track.name || '未知歌曲';
        const meta = document.createElement('span');
        meta.className = 'nmcnative-track-meta';
        meta.textContent = [
            track.artist || '未知歌手',
            track.album || '',
            formatTrackDuration(track.duration),
        ].filter(Boolean).join(' · ');
        const stateLabel = document.createElement('span');
        stateLabel.className = 'nmcnative-track-state';
        stateLabel.textContent = selected ? '已选' : '选择';
        body.append(name, meta);
        row.append(number, body, stateLabel);
        row.addEventListener('click', () => {
            select.value = String(track.id);
            list.querySelectorAll('.nmcnative-track-choice').forEach(item => {
                const isSelected = item.dataset.songId === String(track.id);
                item.classList.toggle('selected', isSelected);
                item.setAttribute('aria-selected', String(isSelected));
                const itemState = item.querySelector('.nmcnative-track-state');
                if (itemState) {
                    itemState.textContent = isSelected ? '已选' : '选择';
                }
            });
        });
        list.append(row);
    });
}

async function loadPlayerPlaylistTracks() {
    const playlistId = element('nmcnativePlayerPlaylist')?.value;
    if (!playlistId) {
        throw new Error('请先选择歌单');
    }
    const result = await api(`/player/playlist-tracks/${encodeURIComponent(playlistId)}?limit=500`);
    state.playerPlaylistTracks = Array.isArray(result.songs) ? result.songs : [];
    state.loadedPlaylistTracksId = String(playlistId);
    state.playerSelectionSource = 'playlist';
    const select = element('nmcnativePlayerPlaylistTrack');
    if (select) {
        select.replaceChildren(option('', state.playerPlaylistTracks.length
            ? '— 选择歌单歌曲 —'
            : '— 歌单中没有歌曲 —'));
        for (const song of state.playerPlaylistTracks) {
            select.append(option(song.id, `${song.name}${song.artist ? ` · ${song.artist}` : ''}`));
        }
        if (state.playerPlaylistTracks.length) {
            select.value = String(state.playerPlaylistTracks[0].id);
        }
    }
    renderPlayerPlaylistTrackChoices();
    const playlist = state.playerPlaylists.find(
        item => String(item.id) === String(playlistId),
    );
    if (playlist) {
        setPlaylistSummary(
            'nmcnativePlayerPlaylistSummary',
            `${playlist.name || '未命名歌单'} · ${Number(playlist.trackCount) || 0} 首 · 已读取`,
        );
    }
    setMessage(`已加载歌单中的 ${state.playerPlaylistTracks.length} 首歌曲。`, 'success');
}

async function playSelectedPlayerPlaylistSong() {
    const songId = element('nmcnativePlayerPlaylistTrack')?.value;
    const song = state.playerPlaylistTracks.find(item => String(item.id) === String(songId));
    if (!song) {
        throw new Error('请先加载歌单并选择歌曲');
    }
    state.playerSelectionSource = 'playlist';
    await loadPlayerSong(song, {
        autoplay: true,
        queue: state.playerPlaylistTracks,
    });
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
    state.playerSelectionSource = 'search';
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
    await loadPlayerSong(song, {
        autoplay: true,
        queue: state.playerSearchResults,
    });
}

async function playCurrentTogetherSong() {
    await pollTogetherSongOnce();
    if (!state.currentSong?.songId) {
        throw new Error('一起听房间没有可用歌曲 ID，请先刷新当前歌曲');
    }
    const roomSong = {
        id: state.currentSong.songId,
        name: state.currentSong.songName,
        artist: state.currentSong.artist,
        album: state.currentSong.album,
    };
    await loadPlayerSong(roomSong, {
        autoplay: true,
        queue: state.roomPlaylist.length ? state.roomPlaylist : [roomSong],
    });
}

async function playNextPlayerSong({ automatic = false } = {}) {
    if (automatic && !extension_settings[EXTENSION_KEY].continuousPlayback) {
        return;
    }
    if (!state.playerQueue.length) {
        throw new Error('播放队列为空');
    }
    if (state.playerAutoAdvancing) {
        return;
    }
    state.playerAutoAdvancing = true;
    try {
        const currentId = String(state.playerSong?.id || '');
        const currentIndex = state.playerQueue.findIndex(
            item => String(item.id) === currentId,
        );
        let selected = null;
        if (
            extension_settings[EXTENSION_KEY].characterAutoSelect
            && state.playerQueue.length > 1
        ) {
            const queueCandidates = state.playerQueue
                .filter(item => String(item.id) !== currentId)
                .slice(0, 8);
            const [currentSongContext, candidates] = await Promise.all([
                songContextForGeneration(state.playerSong, { maxLyricChars: 1000 }),
                Promise.all(queueCandidates.map(async item => ({
                    songId: String(item.id),
                    name: item.name,
                    artist: item.artist || '',
                    lyrics: await getSongLyricsText(item, { maxChars: 600 }),
                }))),
            ]);
            try {
                const reply = await quiet(
                    `你是 {{char}}。${currentSongContext.text}\n请根据你的人格、背景、最近对话以及当前歌曲歌词，从以下候选歌曲及其歌词中选择下一首：${JSON.stringify(candidates)}。选择理由必须结合歌词，禁止只根据歌名选择或编造歌词。输出严格 JSON：{"songId":"候选中的歌曲ID","reason":"一句角色口吻短句"}。只输出 JSON。`,
                    { candidateGuard: false },
                );
                const parsed = parseJsonReply(reply);
                selected = state.playerQueue.find(
                    item => String(item.id) === String(parsed.songId),
                ) || null;
            } catch {
                selected = null;
            }
        }
        if (!selected) {
            const fallbackIndex = currentIndex >= 0
                ? (currentIndex + 1) % state.playerQueue.length
                : 0;
            selected = state.playerQueue[fallbackIndex];
        }
        if (!selected) {
            throw new Error('无法选择下一首歌曲');
        }
        await loadPlayerSong(selected, {
            autoplay: true,
            queue: state.playerQueue,
        });
        setMessage(
            automatic
                ? `已自动切换到《${selected.name || '下一首'}》。`
                : `已切换到《${selected.name || '下一首'}》。`,
            'success',
        );
    } finally {
        state.playerAutoAdvancing = false;
    }
}

async function playPreviousPlayerSong() {
    if (!state.playerQueue.length) {
        throw new Error('播放队列为空');
    }
    const currentId = String(state.playerSong?.id || '');
    const currentIndex = state.playerQueue.findIndex(
        item => String(item.id) === currentId,
    );
    const previousIndex = currentIndex >= 0
        ? (currentIndex - 1 + state.playerQueue.length) % state.playerQueue.length
        : 0;
    const selected = state.playerQueue[previousIndex];
    await loadPlayerSong(selected, {
        autoplay: true,
        queue: state.playerQueue,
    });
}

async function controlPlayer(action) {
    const audio = element('nmcnativePlayerAudio');
    const normalized = String(action || '').toLowerCase();
    if (normalized === 'play') {
        if (!audio?.src) {
            throw new Error('播放器尚未载入歌曲');
        }
        await audio.play();
        return { action: normalized, songId: state.playerSong?.id || '' };
    }
    if (normalized === 'pause') {
        audio?.pause();
        return { action: normalized, songId: state.playerSong?.id || '' };
    }
    if (normalized === 'next') {
        await playNextPlayerSong();
        return { action: normalized, songId: state.playerSong?.id || '' };
    }
    if (normalized === 'previous') {
        await playPreviousPlayerSong();
        return { action: normalized, songId: state.playerSong?.id || '' };
    }
    throw new Error('播放控制仅支持 play、pause、next、previous');
}

function activeCharacterName() {
    const context = getContext();
    const cardName = context.characters?.[context.characterId]?.name;
    if (cardName) {
        return String(cardName).trim();
    }
    const macroName = String(substituteParams('{{char}}') || '').trim();
    if (macroName
        && macroName !== '{{char}}'
        && macroName !== 'SillyTavern System'
        && macroName !== 'char') {
        return macroName;
    }
    return context.name2 && context.name2 !== 'SillyTavern System'
        ? String(context.name2).trim()
        : 'char';
}

function activeUserName() {
    const context = getContext();
    const macroName = String(substituteParams('{{user}}') || '').trim();
    if (macroName && macroName !== '{{user}}' && macroName !== 'User') {
        return macroName;
    }
    return String(context.name1 || 'user').trim() || 'user';
}

function activePresetName() {
    try {
        return String(getPresetManager()?.getSelectedPresetName?.() || '').trim();
    } catch {
        return '';
    }
}

function applyCharacterNameCopy(root = element('netease-music-companion-native')) {
    if (!root) {
        return;
    }
    const characterName = activeCharacterName();
    root.querySelectorAll('[data-nmcnative-char-template]').forEach(node => {
        node.textContent = String(node.dataset.nmcnativeCharTemplate || '')
            .replaceAll('{char}', characterName);
    });
}

function renderTogetherReplyLog() {
    const log = element('nmcnativeTogetherMessageLog');
    if (!log) {
        return;
    }
    log.replaceChildren();
    const characterName = activeCharacterName();
    for (const reply of state.generatedTogetherReplies) {
        const text = typeof reply === 'string' ? reply : reply.text;
        const status = typeof reply === 'string' ? 'sent' : reply.status;
        const row = document.createElement('p');
        row.className = 'nmcnative-sent-message';
        row.dataset.status = status;
        row.textContent = [
            `${characterName}：${text}`,
            status === 'pending' ? '（等待合并发送）' : '',
            status === 'merged' ? '（已合并发送）' : '',
            status === 'failed' ? '（发送失败）' : '',
        ].filter(Boolean).join(' ');
        log.append(row);
    }
    updateMessageReplyAvailability();
}

function bindCharacterNameEvents() {
    if (state.characterNameListeners.length > 0) {
        return;
    }
    const context = getContext();
    const refreshLabels = () => {
            applyCharacterNameCopy();
        renderMessageContacts();
        renderTogetherMessageHistory();
        renderTogetherReplyLog();
        if (extension_settings[EXTENSION_KEY]?.conversationTools) {
            syncConversationTools();
        }
    };
    const eventNames = [
        context.eventTypes?.CHAT_CHANGED,
        context.eventTypes?.CHARACTER_EDITED,
        context.eventTypes?.CHARACTER_PAGE_LOADED,
        context.eventTypes?.GROUP_UPDATED,
    ].filter(Boolean);
    for (const eventName of new Set(eventNames)) {
        context.eventSource.on(eventName, refreshLabels);
        state.characterNameListeners.push({ eventSource: context.eventSource, eventName, handler: refreshLabels });
    }
}

function unbindCharacterNameEvents() {
    for (const listener of state.characterNameListeners) {
        listener.eventSource.removeListener(listener.eventName, listener.handler);
    }
    state.characterNameListeners = [];
}

function formatPrivateMessageTime(value) {
    const timestamp = Number(value) || 0;
    if (!timestamp) {
        return '';
    }
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date(timestamp));
    } catch {
        return '';
    }
}

function selectedMessageContact() {
    return state.messageContacts.find(
        contact => String(contact.id) === String(state.selectedMessageContactId),
    ) || null;
}

function updateMessageReplyAvailability() {
    const generateButton = element('nmcnativeGenerateTogetherReply');
    if (generateButton) {
        generateButton.disabled = state.busy
            || !state.selectedMessageContactId
            || state.messageHistory.length === 0;
    }
    const resendButton = element('nmcnativeResendTogetherReply');
    if (resendButton) {
        resendButton.disabled = state.busy
            || !state.selectedMessageContactId
            || state.generatedTogetherReplies.length === 0;
    }
}

function renderMessageContacts() {
    const list = element('nmcnativeTogetherMessageContacts');
    if (!list) {
        return;
    }
    list.replaceChildren();
    if (!state.messageContacts.length) {
        const empty = document.createElement('p');
        empty.className = 'nmcnative-list-empty';
        empty.textContent = '没有读取到网易云私信联系人';
        list.append(empty);
        updateMessageReplyAvailability();
        return;
    }
    const characterName = activeCharacterName();
    for (const contact of state.messageContacts) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'nmcnative-contact-choice';
        row.dataset.contactId = String(contact.id);
        row.setAttribute('role', 'option');
        const selected = String(contact.id) === String(state.selectedMessageContactId);
        row.classList.toggle('selected', selected);
        row.setAttribute('aria-selected', String(selected));

        const avatar = document.createElement('span');
        avatar.className = 'nmcnative-contact-avatar';
        avatar.textContent = String(contact.name || '云').slice(0, 1);
        const body = document.createElement('span');
        body.className = 'nmcnative-contact-body';
        const name = document.createElement('span');
        name.className = 'nmcnative-contact-name';
        name.textContent = contact.name || '网易云用户';
        const preview = document.createElement('span');
        preview.className = 'nmcnative-contact-preview';
        preview.textContent = `${contact.lastFromSelf ? `${characterName}：` : ''}${contact.lastMessage || '暂无文字消息'}`;
        body.append(name, preview);
        const meta = document.createElement('span');
        meta.className = 'nmcnative-contact-meta';
        meta.textContent = contact.unread > 0
            ? `${contact.unread} 条未读`
            : formatPrivateMessageTime(contact.lastMessageAt);
        row.append(avatar, body, meta);
        row.addEventListener('click', () => {
            state.selectedMessageContactId = String(contact.id);
            renderMessageContacts();
            void withBusy('正在读取网易云聊天记录...', () => loadTogetherMessageHistory(contact.id));
        });
        list.append(row);
    }
    updateMessageReplyAvailability();
}

function renderTogetherMessageHistory() {
    const container = element('nmcnativeTogetherMessageHistory');
    if (!container) {
        return;
    }
    container.replaceChildren();
    if (!state.messageHistory.length) {
        const empty = document.createElement('p');
        empty.className = 'nmcnative-list-empty';
        empty.textContent = state.selectedMessageContactId
            ? '这段私信还没有可显示的文字消息'
            : '选择一个联系人后显示聊天记录';
        container.append(empty);
        updateMessageReplyAvailability();
        return;
    }
    const characterName = activeCharacterName();
    const userName = activeUserName();
    for (const message of state.messageHistory) {
        const bubble = document.createElement('div');
        const side = message.sender === 'contact' ? 'contact' : message.sender === 'character' ? 'character' : 'user';
        bubble.className = `nmcnative-chat-bubble nmcnative-chat-${side}`;
        const meta = document.createElement('span');
        meta.className = 'nmcnative-chat-meta';
        meta.textContent = [
            message.sender === 'user' || message.sender === 'character' ? characterName : userName,
            formatPrivateMessageTime(message.time),
        ].filter(Boolean).join(' · ');
        const text = document.createElement('span');
        text.className = 'nmcnative-chat-text';
        text.textContent = message.text || '';
        bubble.append(meta, text);
        container.append(bubble);
    }
    container.scrollTop = container.scrollHeight;
    updateMessageReplyAvailability();
}

async function loadTogetherMessageHistory(contactId) {
    const result = await api(`/together/message-history/${encodeURIComponent(contactId)}?limit=30`);
    state.selectedMessageContactId = String(result.userId || contactId);
    state.messageHistory = Array.isArray(result.messages) ? result.messages : [];
    setText(
        'nmcnativeTogetherMessageState',
        `${selectedMessageContact()?.name || '联系人'} · ${state.messageHistory.length} 条文字消息`,
    );
    renderMessageContacts();
    renderTogetherMessageHistory();
    return result;
}

async function refreshTogetherMessageContacts() {
    const result = await api('/together/message-contacts');
    state.messageContacts = Array.isArray(result.contacts) ? result.contacts : [];
    const selectedStillExists = state.messageContacts.some(
        contact => String(contact.id) === String(state.selectedMessageContactId),
    );
    if (!selectedStillExists) {
        const preferred = state.messageContacts.find(
            contact => String(contact.id) === String(result.preferredUserId || ''),
        );
        state.selectedMessageContactId = String(
            preferred?.id || state.messageContacts[0]?.id || '',
        );
    }
    renderMessageContacts();
    if (state.selectedMessageContactId) {
        await loadTogetherMessageHistory(state.selectedMessageContactId);
    } else {
        state.messageHistory = [];
        setText('nmcnativeTogetherMessageState', '没有可读取的私信联系人');
        renderTogetherMessageHistory();
    }
    return result;
}

function stopMessagePolling() {
    if (state.messagePollTimer) {
        clearInterval(state.messagePollTimer);
        state.messagePollTimer = null;
    }
    state.messagePollBusy = false;
    state.messagePollTicks = 0;
}

async function pollTogetherMessagesOnce() {
    if (state.messagePollBusy || state.busy || !state.togetherEnabled) {
        return;
    }
    const section = element('nmcnativeTogetherSection');
    const details = element('nmcnativeTogetherReplyDetails');
    if (!details?.open || section?.dataset.active !== 'true' || section?.hidden) {
        return;
    }
    state.messagePollBusy = true;
    try {
        if (!state.selectedMessageContactId || state.messagePollTicks % 3 === 0) {
            await refreshTogetherMessageContacts();
        } else {
            await loadTogetherMessageHistory(state.selectedMessageContactId);
        }
        state.messagePollTicks += 1;
    } catch (error) {
        setText(
            'nmcnativeTogetherMessageState',
            `自动刷新失败：${error?.message || error}`,
        );
    } finally {
        state.messagePollBusy = false;
    }
}

function startMessagePolling() {
    stopMessagePolling();
    const section = element('nmcnativeTogetherSection');
    const details = element('nmcnativeTogetherReplyDetails');
    if (!state.togetherEnabled || !details?.open || section?.dataset.active !== 'true') {
        return;
    }
    void pollTogetherMessagesOnce();
    state.messagePollTimer = setInterval(() => {
        void pollTogetherMessagesOnce();
    }, 4000);
}

function parseCharacterMessages(reply) {
    let values = [];
    try {
        const parsed = parseJsonReply(reply);
        if (Array.isArray(parsed?.messages)) {
            values = parsed.messages;
        } else if (typeof parsed?.message === 'string') {
            values = [parsed.message];
        }
    } catch {
        // Fall back to one message per line below.
    }
    if (!values.length) {
        values = String(reply || '')
            .split(/\n+/)
            .map(value => value.replace(/^[-*\d.、\s]+/, ''));
    }
    return values
        .map(value => String(value || '')
            .replace(/^[“”"'「」]+|[“”"'「」]+$/g, '')
            .trim())
        .filter(Boolean)
        .slice(0, 3)
        .map(value => value.slice(0, TOGETHER_REPLY_CHAR_LIMIT));
}

async function sendCharacterPrivateMessage(message, contactId) {
    const content = String(message || '').trim().slice(0, 500);
    if (!content) {
        throw new Error('没有可发送的私信内容');
    }
    await api('/together/send-message', {
        method: 'POST',
        body: { message: content, userId: String(contactId) },
    });
    state.messageHistory.push({
        id: `local-${Date.now()}-${state.messageHistory.length}`,
        sender: 'character',
        senderName: activeCharacterName(),
        text: content,
        time: Date.now(),
    });
    renderTogetherMessageHistory();
    return content;
}

async function generateTogetherReply() {
    const contact = selectedMessageContact();
    if (!contact) {
        throw new Error('请先选择一个网易云私信联系人');
    }
    if (!state.messageHistory.length) {
        throw new Error('当前聊天没有可回复的文字消息');
    }
    const includeLyrics = privateGenerationLyricsEnabled();
    const currentSong = state.currentSong || state.playerSong;
    const songContext = includeLyrics
        ? currentSong
            ? (await songContextForGeneration(currentSong, { maxLyricChars: 6000 })).text
            : '当前没有读取到正在播放的歌曲，也没有可用歌词。'
        : '本次私信生成未启用歌词参考。只根据聊天记录、角色人设、世界书和预设回复；不要引用或编造歌词。';
    const conversation = state.messageHistory
        .slice(-12)
        .map(message => {
            const speaker = message.sender === 'contact' ? '{{user}}' : '{{char}}';
            return `${speaker}：${String(message.text || '').replace(/\s+/g, ' ').slice(0, 260)}`;
        })
        .join('\n');
    const prompt = [
        `你正在阅读 {{char}} 在网易云音乐与“${contact.name}”（对应当前 {{user}}）的私信聊天记录。`,
        '聊天记录中由当前网易云账号发出的消息都代表 {{char}}，不是 {{user}}。',
        songContext,
        includeLyrics && currentSong
            ? '如果提供了歌词，回复必须结合歌词中的具体意象、句子或情绪，禁止只复述歌名。'
            : '',
        `聊天记录：\n${conversation}`,
        '请以 {{char}} 的身份，根据这段聊天接续回复 1 到 3 条连续的短句。每条都像真实私信，可分别表达情绪、回应和补充，不要重复，不要添加角色名前缀或动作说明。',
        `只输出严格 JSON：{"messages":["第一条","第二条"]}。每条不超过 ${TOGETHER_REPLY_CHAR_LIMIT} 个中文字符。`,
    ].join('\n\n');
    const reply = await quiet(prompt, { candidateGuard: false, responseLength: 300 });
    const messages = parseCharacterMessages(reply);
    if (!messages.length) {
        throw new Error(`${activeCharacterName()} 没有生成可发送的回复`);
    }

    const characterName = activeCharacterName();
    state.generatedTogetherReplies = messages.map(text => ({ text, status: 'pending' }));
    renderTogetherReplyLog();
    const combinedMessage = messages.join('\n\n').slice(0, 500);
    setConnectionState(`${characterName} 正在合并为一条私信发送...`, 'loading');
    try {
        await sendCharacterPrivateMessage(combinedMessage, contact.id);
        for (const reply of state.generatedTogetherReplies) {
            reply.status = 'merged';
        }
        renderTogetherReplyLog();
        setMessage(
            `${characterName} 已将 ${messages.length} 段回复合并为一条私信发送。`,
            'success',
        );
        setConnectionState(`${characterName} 已合并发送 ${messages.length} 段`, 'success');
    } catch (error) {
        for (const reply of state.generatedTogetherReplies) {
            reply.status = 'failed';
            reply.error = String(error?.message || error);
        }
        renderTogetherReplyLog();
        setMessage(
            `${characterName} 的合并私信发送失败：${error?.message || error}`,
            'error',
        );
        setConnectionState(`${characterName} 私信发送失败`, 'warning');
    }
    return { messages, combinedMessage };
}

async function speakCurrentSongToUser() {
    if (!state.currentSong && !state.playerSong) {
        await pollTogetherSongOnce();
    }
    const song = state.currentSong || state.playerSong;
    if (!song?.songName && !song?.name) {
        throw new Error('请先播放歌曲或刷新一起听当前歌曲');
    }
    let contact = selectedMessageContact();
    if (!contact) {
        await refreshTogetherMessageContacts();
        contact = selectedMessageContact();
    }
    if (!contact) {
        throw new Error('请先读取并选择一个网易云私信联系人');
    }
    const includeLyrics = privateGenerationLyricsEnabled();
    const songDetails = includeLyrics
        ? await songContextForGeneration(song, { maxLyricChars: 6000 })
        : {
            text: [
                `歌曲：《${song?.name || song?.songName || song?.song_name || '未知歌曲'}》`,
                song?.artist ? `歌手：${song.artist}` : '',
                '本次私信生成未启用歌词参考。不要引用或编造歌词。',
            ].filter(Boolean).join('\n'),
        };
    const recentConversation = state.messageHistory
        .slice(-8)
        .map(message => {
            const speaker = message.sender === 'contact' ? '{{user}}' : '{{char}}';
            return `${speaker}：${String(message.text || '').replace(/\s+/g, ' ').slice(0, 180)}`;
        })
        .join('\n');
    const reply = await quiet([
        `你正在和 {{user}} 一起听这首歌。`,
        songDetails.text,
        includeLyrics
            ? '必须结合歌词中的具体意象、句子或情绪写这条短句，禁止只重复歌名或歌手。'
            : '只根据歌曲名称、歌手和当前聊天表达这一刻的感受，不要引用或编造歌词。',
        recentConversation ? `最近的网易云私信：\n${recentConversation}` : '',
        `请以 {{char}} 的身份，写一句想直接私信给 {{user}} 的听歌短句。只写一句，不超过 ${SPEAK_SONG_CHAR_LIMIT} 个中文字符，不要加引号、角色名前缀或解释。`,
    ].filter(Boolean).join('\n\n'), {
        candidateGuard: false,
        responseLength: 160,
    });
    const content = String(reply)
        .replace(/^[“”"'「」]+|[“”"'「」]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SPEAK_SONG_CHAR_LIMIT);
    if (!content) {
        throw new Error(`${activeCharacterName()} 没有生成可发送的听歌短句`);
    }
    state.generatedTogetherReplies = [{ text: content, status: 'pending' }];
    renderTogetherReplyLog();
    try {
        await sendCharacterPrivateMessage(content, contact.id);
        state.generatedTogetherReplies[0].status = 'sent';
        renderTogetherReplyLog();
        setText('nmcnativeCharComment', `${activeCharacterName()} 已私信：${content}`);
        setMessage(`${activeCharacterName()} 已将听歌短句私信给 ${activeUserName()}。`, 'success');
        setConnectionState(`${activeCharacterName()} 已私信听歌短句`, 'success');
        return content;
    } catch (error) {
        state.generatedTogetherReplies[0].status = 'failed';
        state.generatedTogetherReplies[0].error = String(error?.message || error);
        renderTogetherReplyLog();
        setText('nmcnativeCharComment', `${activeCharacterName()} 的听歌短句尚未发送，可点击“重发最近生成内容”。`);
        setMessage(`听歌短句发送失败：${error?.message || error}`, 'error');
        setConnectionState(`${activeCharacterName()} 听歌短句发送失败`, 'warning');
        return { content, error: String(error?.message || error) };
    }
}

async function resendGeneratedTogetherMessage() {
    const messages = state.generatedTogetherReplies
        .map(reply => typeof reply === 'string' ? reply : reply.text)
        .map(text => String(text || '').trim())
        .filter(Boolean);
    if (!messages.length) {
        throw new Error('当前没有可重发的生成内容');
    }
    let contact = selectedMessageContact();
    if (!contact) {
        await refreshTogetherMessageContacts();
        contact = selectedMessageContact();
    }
    if (!contact) {
        throw new Error('请先选择要发送到的网易云私信联系人');
    }
    const characterName = activeCharacterName();
    const content = messages.join('\n\n').slice(0, 500);
    setConnectionState(`${characterName} 正在手动重发私信...`, 'loading');
    try {
        await sendCharacterPrivateMessage(content, contact.id);
        const status = messages.length > 1 ? 'merged' : 'sent';
        state.generatedTogetherReplies.forEach(reply => {
            if (typeof reply === 'object') {
                reply.status = status;
                delete reply.error;
            }
        });
        renderTogetherReplyLog();
        setText('nmcnativeCharComment', `${characterName} 已重发：${content}`);
        setMessage(
            `${characterName} 已手动重发${messages.length > 1 ? ` ${messages.length} 段合并内容` : '生成内容'}。`,
            'success',
        );
        setConnectionState(`${characterName} 已手动重发私信`, 'success');
        return { messages, content };
    } catch (error) {
        state.generatedTogetherReplies.forEach(reply => {
            if (typeof reply === 'object') {
                reply.status = 'failed';
                reply.error = String(error?.message || error);
            }
        });
        renderTogetherReplyLog();
        setText('nmcnativeCharComment', `${characterName} 的重发仍未成功，可稍后再试。`);
        setMessage(`手动重发失败：${error?.message || error}`, 'error');
        setConnectionState(`${characterName} 手动重发失败`, 'warning');
        return { messages, content, error: String(error?.message || error) };
    }
}

function renderRoomPlaylist(data) {
    state.roomPlaylist = Array.isArray(data?.songs) ? data.songs : [];
    state.roomPlaylistCurrentId = String(data?.currentSongId || '');
    const select = element('nmcnativeTogetherPlaylist');
    const previousSelection = select?.value || state.roomPlaylistCurrentId;
    if (select) {
        select.replaceChildren(option('', state.roomPlaylist.length
            ? '— 选择房间歌曲 —'
            : '— 房间歌单为空 —'));
        for (const song of state.roomPlaylist) {
            const marker = String(song.id) === state.roomPlaylistCurrentId ? '（当前）' : '';
            select.append(option(song.id, `${song.name}${song.artist ? ` · ${song.artist}` : ''}${marker}`));
        }
        const desiredSelection = state.roomPlaylist.some(song => String(song.id) === String(previousSelection))
            ? previousSelection
            : state.roomPlaylistCurrentId;
        if (desiredSelection && state.roomPlaylist.some(song => String(song.id) === String(desiredSelection))) {
            select.value = String(desiredSelection);
        }
    }
    setText(
        'nmcnativeTogetherPlaylistState',
        state.roomPlaylist.length
            ? `房间歌单：${state.roomPlaylist.length} 首${data?.playStatus ? ` · ${data.playStatus}` : ''}`
            : '房间歌单为空',
    );
    renderRoomPlaylistChoices();
    const toggle = element('nmcnativeTogetherToggle');
    if (toggle) {
        toggle.textContent = String(data?.playStatus || '').toUpperCase() === 'PAUSE'
            ? '继续播放'
            : '暂停';
    }
}

function renderRoomPlaylistChoices() {
    const list = element('nmcnativeTogetherPlaylistList');
    const select = element('nmcnativeTogetherPlaylist');
    if (!list || !select) {
        return;
    }
    const query = element('nmcnativeTogetherPlaylistSearch')?.value || '';
    const filtered = state.roomPlaylist.filter(song => trackMatches(song, query));
    list.replaceChildren();
    if (!state.roomPlaylist.length) {
        const empty = document.createElement('p');
        empty.className = 'nmcnative-list-empty';
        empty.textContent = '房间歌单为空';
        list.append(empty);
        return;
    }
    if (!filtered.length) {
        const empty = document.createElement('p');
        empty.className = 'nmcnative-list-empty';
        empty.textContent = '没有匹配的房间歌曲';
        list.append(empty);
        return;
    }
    filtered.forEach((song, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'nmcnative-track-choice';
        row.dataset.songId = String(song.id);
        row.setAttribute('role', 'option');
        const selected = String(song.id) === String(select.value || '');
        const current = String(song.id) === String(state.roomPlaylistCurrentId || '');
        row.classList.toggle('selected', selected);
        row.classList.toggle('current', current);
        row.setAttribute('aria-selected', String(selected));

        const number = document.createElement('span');
        number.className = 'nmcnative-track-number';
        number.textContent = String(index + 1).padStart(2, '0');
        const body = document.createElement('span');
        body.className = 'nmcnative-track-body';
        const name = document.createElement('span');
        name.className = 'nmcnative-track-name';
        name.textContent = song.name || '未知歌曲';
        const meta = document.createElement('span');
        meta.className = 'nmcnative-track-meta';
        meta.textContent = [
            song.artist || '未知歌手',
            song.album || '',
            formatTrackDuration(song.duration),
        ].filter(Boolean).join(' · ');
        const stateLabel = document.createElement('span');
        stateLabel.className = 'nmcnative-track-state';
        stateLabel.textContent = current
            ? '当前'
            : selected ? '已选' : '选择';
        body.append(name, meta);
        row.append(number, body, stateLabel);
        row.addEventListener('click', () => {
            select.value = String(song.id);
            list.querySelectorAll('.nmcnative-track-choice').forEach(item => {
                const isSelected = item.dataset.songId === String(song.id);
                const isCurrent = item.dataset.songId === state.roomPlaylistCurrentId;
                item.classList.toggle('selected', isSelected);
                item.setAttribute('aria-selected', String(isSelected));
                const itemState = item.querySelector('.nmcnative-track-state');
                if (itemState) {
                    itemState.textContent = isCurrent
                        ? '当前'
                        : isSelected ? '已选' : '选择';
                }
            });
        });
        list.append(row);
    });
}

async function refreshRoomPlaylist() {
    const data = await api('/together/room-playlist');
    renderRoomPlaylist(data);
    return data;
}

function selectedPlayerSong() {
    if (state.playerSelectionSource === 'playlist') {
        const playlistTrackId = element('nmcnativePlayerPlaylistTrack')?.value;
        const playlistSong = state.playerPlaylistTracks.find(
            item => String(item.id) === String(playlistTrackId),
        );
        if (playlistSong) {
            return playlistSong;
        }
    }
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
    return String(selectedPlayerSong()?.id || state.playerSong?.id || '');
}

async function loadSongComments() {
    const songId = currentCommentSongId();
    if (!songId) {
        throw new Error('请先搜索、选择或播放歌曲');
    }
    renderSongComments(await api(`/song-comments/${encodeURIComponent(songId)}?limit=20`));
    setMessage('歌曲评论已刷新。', 'success');
}

async function postSongComment(songId, content) {
    const commentKey = commentSessionKey(songId);
    if (state.commentedSongIds.has(commentKey)) {
        throw new Error('本会话已经评论过这首歌，请选择另一首歌曲');
    }
    if (state.commentingSongIds.has(commentKey)) {
        throw new Error('这首歌正在发布评论，请稍候');
    }
    const normalizedContent = String(content || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SONG_COMMENT_CHAR_LIMIT);
    if (!normalizedContent) {
        throw new Error('评论内容不能为空');
    }
    state.commentingSongIds.add(commentKey);
    try {
        await api(`/song-comments/${encodeURIComponent(songId)}`, {
            method: 'POST',
            body: { content: normalizedContent },
        });
        state.commentedSongIds.add(commentKey);
        await loadSongComments().catch(() => {});
        return normalizedContent;
    } finally {
        state.commentingSongIds.delete(commentKey);
    }
}

function commentSessionKey(songId) {
    return `${state.activeAccountId || 'account'}:${String(songId || '')}`;
}

function assertSongCommentAvailable(songId) {
    const commentKey = commentSessionKey(songId);
    if (state.commentedSongIds.has(commentKey)) {
        throw new Error('本会话已经评论过这首歌，请选择另一首歌曲');
    }
    if (state.commentingSongIds.has(commentKey)) {
        throw new Error('这首歌正在发布评论，请稍候');
    }
}

async function characterCommentOnSong() {
    const songId = currentCommentSongId();
    if (!songId) {
        throw new Error('请先搜索、选择或播放歌曲');
    }
    const song = state.playerSong?.id === songId
        ? state.playerSong
        : selectedPlayerSong();
    if (!song) {
        throw new Error('缺少歌曲信息');
    }
    assertSongCommentAvailable(songId);
    const songDetails = await songContextForGeneration(song, { maxLyricChars: 6000 });
    const generated = await quiet(
        `你是 {{char}}。${songDetails.text}\n请完全以角色本人的人格、经历和说话方式，结合歌词中的具体意象、句子或情绪，写一段发布在网易云歌曲评论区的短评论，不超过 ${SONG_COMMENT_CHAR_LIMIT} 个中文字符。禁止只复述歌名，不要自称 AI，不要解释，不要加引号，只输出评论正文。`,
        { candidateGuard: false, responseLength: 220 },
    );
    const content = await postSongComment(songId, generated);
    setText('nmcnativeGeneratedComment', content);
    setMessage(`${activeCharacterName()} 评论已发布：${content}`, 'success');
    return content;
}

async function resolveSongForTool({ query = '', songId = '', limit = 5 } = {}) {
    if (songId) {
        return await api(`/song-info/${encodeURIComponent(String(songId))}`);
    }
    const keyword = String(query || '').trim();
    if (!keyword) {
        throw new Error('必须提供 query 或 songId');
    }
    const candidates = await api('/search-with-lyric', {
        method: 'POST',
        body: { keyword, limit: Math.min(10, Math.max(1, Number(limit) || 5)) },
    });
    if (!Array.isArray(candidates) || !candidates.length) {
        throw new Error(`没有找到与「${keyword}」匹配的歌曲`);
    }
    return candidates[0];
}

async function toolPlaySong(args = {}) {
    const song = await resolveSongForTool(args);
    state.playerSelectionSource = 'search';
    await loadPlayerSong(song, {
        autoplay: true,
        queue: [song],
    });
    return { ok: true, song };
}

async function toolAddSongToRoom(args = {}) {
    const song = await resolveSongForTool(args);
    await api('/together/room-playlist/add', {
        method: 'POST',
        body: { songId: String(song.id) },
    });
    await refreshRoomPlaylist().catch(() => {});
    return { ok: true, song };
}

async function toolCommentSong(args = {}) {
    const song = args.songId
        ? await resolveSongForTool({ songId: args.songId })
        : selectedPlayerSong();
    if (!song?.id) {
        throw new Error('当前没有可用于评论的歌曲');
    }
    assertSongCommentAvailable(song.id);
    let content = String(args.content || '').trim();
    if (!content) {
        const songDetails = await songContextForGeneration(song, { maxLyricChars: 6000 });
        content = await quiet(
            `你是 {{char}}。${songDetails.text}\n请以角色本人的口吻，结合歌词中的具体意象、句子或情绪，写一段网易云歌曲短评论，不超过 ${SONG_COMMENT_CHAR_LIMIT} 个中文字符。禁止只复述歌名，不要自称 AI，不要解释，只输出评论正文。`,
            { candidateGuard: false, responseLength: 220 },
        );
    }
    const posted = await postSongComment(song.id, content);
    setText('nmcnativeGeneratedComment', posted);
    return { ok: true, songId: String(song.id), content: posted };
}

async function toolGetMusicState() {
    const audio = element('nmcnativePlayerAudio');
    const lyrics = state.playerSong
        ? await getSongLyricsText(state.playerSong, { maxChars: 2000 })
        : '';
    const currentLyricLine = state.lyricIndex >= 0
        ? state.lyricLines[state.lyricIndex]?.text || ''
        : '';
    return {
        player: state.playerSong
            ? {
                songId: state.playerSong.id,
                name: state.playerSong.name,
                artist: state.playerSong.artist,
                playing: Boolean(audio && !audio.paused),
                currentTime: Number(audio?.currentTime) || 0,
                currentLyric: currentLyricLine,
                lyrics,
                queueLength: state.playerQueue.length,
            }
            : null,
        togetherRoom: state.inTogetherRoom,
        roomPlaylistCount: state.roomPlaylist.length,
    };
}

const FUNCTION_TOOL_NAMES = [
    'netease_companion_search',
    'netease_companion_play',
    'netease_companion_control',
    'netease_companion_add_to_room',
    'netease_companion_room_control',
    'netease_companion_comment',
    'netease_companion_state',
];

function unregisterConversationTools() {
    for (const name of FUNCTION_TOOL_NAMES) {
        ToolManager.unregisterFunctionTool(name);
    }
}

function syncConversationTools() {
    unregisterConversationTools();
    if (!extension_settings[EXTENSION_KEY]?.conversationTools) {
        return;
    }
    const shouldRegister = () => extension_settings[EXTENSION_KEY]?.conversationTools === true;
    ToolManager.registerFunctionTool({
        name: 'netease_companion_search',
        displayName: '搜索网易云歌曲',
        description: `搜索网易云歌曲并返回歌曲 ID、名称、歌手和歌词片段。需要主动为 ${activeCharacterName()} 选歌时可先搜索。`,
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '歌曲、歌手或关键词' },
                limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
            },
            required: ['query'],
        },
        action: async args => JSON.stringify(
            await api('/search-with-lyric', {
                method: 'POST',
                body: { keyword: args.query, limit: args.limit || 5 },
            }),
        ),
        shouldRegister,
    });
    ToolManager.registerFunctionTool({
        name: 'netease_companion_play',
        displayName: '在酒馆播放网易云歌曲',
        description: '在 SillyTavern 内播放歌曲。可根据关键词选择第一首匹配歌曲，也可使用明确 songId。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '歌曲名称和歌手' },
                songId: { type: 'string', description: '网易云数字歌曲 ID' },
            },
        },
        action: async args => JSON.stringify(await toolPlaySong(args)),
        shouldRegister,
    });
    ToolManager.registerFunctionTool({
        name: 'netease_companion_control',
        displayName: '控制酒馆播放器',
        description: '控制 SillyTavern 播放器的播放、暂停、上一首和下一首。',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['play', 'pause', 'next', 'previous'],
                },
            },
            required: ['action'],
        },
        action: async args => JSON.stringify(await controlPlayer(args.action)),
        shouldRegister,
    });
    ToolManager.registerFunctionTool({
        name: 'netease_companion_add_to_room',
        displayName: '添加歌曲到一起听房间',
        description: '把匹配歌曲添加到当前一起听房间歌单，需要房间已经创建。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '歌曲名称和歌手' },
                songId: { type: 'string', description: '网易云数字歌曲 ID' },
            },
        },
        action: async args => JSON.stringify(await toolAddSongToRoom(args)),
        shouldRegister,
    });
    ToolManager.registerFunctionTool({
        name: 'netease_companion_room_control',
        displayName: '控制一起听房间',
        description: '控制当前一起听房间的播放、暂停、上一首和下一首。',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['play', 'pause', 'next', 'previous'],
                },
            },
            required: ['action'],
        },
        action: async args => JSON.stringify({
            ok: true,
            ...(await api('/together/control', {
                method: 'POST',
                body: { command: args.action },
            })),
        }),
        shouldRegister,
    });
    ToolManager.registerFunctionTool({
        name: 'netease_companion_comment',
        displayName: `以 ${activeCharacterName()} 身份评论歌曲`,
        description: `以 ${activeCharacterName()} 的人设发布网易云歌曲评论。可由该角色生成内容或使用给定内容。`,
        parameters: {
            type: 'object',
            properties: {
                songId: { type: 'string', description: '可选网易云数字歌曲 ID' },
                content: { type: 'string', description: '可选评论正文，最多 120 字' },
            },
        },
        action: async args => JSON.stringify(await toolCommentSong(args)),
        shouldRegister,
    });
    ToolManager.registerFunctionTool({
        name: 'netease_companion_state',
        displayName: '读取网易云播放状态',
        description: '读取酒馆播放器当前歌曲、播放状态、队列长度和一起听房间状态。',
        parameters: { type: 'object', properties: {} },
        action: async () => JSON.stringify(await toolGetMusicState()),
        shouldRegister,
    });
}

async function refreshTogetherState() {
    if (!state.togetherEnabled) {
        return;
    }
    const mode = element('nmcnativeTogetherMode')?.value || 'local';
    if (mode === 'native') {
        try {
            const nativeState = await api('/together/native/status');
            const client = nativeState?.details?.client || {};
            if (nativeState.running && client.available) {
                const roomActive = Boolean(client.roomId)
                    && ['waiting', 'togetherOwner', 'together'].includes(String(client.status || ''));
                state.inTogetherRoom = roomActive;
                setText(
                    'nmcnativeTogetherRoom',
                    roomActive
                        ? '已加入一起听房间 · 原生客户端'
                        : '原生服务已连接，当前未加入一起听房间',
                );
                if (roomActive) {
                    await refreshRoomPlaylist().catch(() => {});
                    if (extension_settings[EXTENSION_KEY]?.activeTab === 'together'
                        && !state.togetherPollTimer) {
                        startTogetherPolling();
                    }
                }
                return;
            }
        } catch {
            // Fall through to the local reverse status when native state is unavailable.
        }
    }
    const result = await api('/together/status');
    state.inTogetherRoom = result.inRoom === true;
    if (result.inRoom) {
        showInvite(result.roomId || '', result.inviteUrl || '');
        await refreshRoomPlaylist().catch(() => {});
        if (extension_settings[EXTENSION_KEY]?.activeTab === 'together' && !state.togetherPollTimer) {
            startTogetherPolling();
        }
    } else {
        setText('nmcnativeTogetherRoom', '未加入房间');
        stopTogetherPolling();
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

async function refreshCurrentTogetherSong({ startNative = false } = {}) {
    const mode = element('nmcnativeTogetherMode')?.value || 'local';
    const errors = [];
    const applyRefreshedSong = song => {
        const previousSongId = String(state.currentSong?.songId || '');
        renderTogetherSong(song);
        const nextSongId = String(song?.songId || '');
        if (nextSongId
            && (previousSongId !== nextSongId || state.roomPlaylistCurrentId !== nextSongId)) {
            void refreshRoomPlaylist().catch(() => {});
        }
    };
    if (mode === 'native') {
        try {
            if (startNative) {
                await api('/together/native/start', { method: 'POST', body: {} });
            }
            const song = await api('/together/native/now-playing');
            applyRefreshedSong(song);
            state.togetherPollFailures = 0;
            await refreshNativeServiceState().catch(() => {});
            return song;
        } catch (error) {
            errors.push(`原生服务：${error?.message || error}`);
        }
    }
    try {
        const song = await api('/together/now-playing');
        applyRefreshedSong(song);
        state.togetherPollFailures = 0;
        return song;
    } catch (error) {
        errors.push(`本地逆向：${error?.message || error}`);
    }
    const message = errors.join('；');
    setText('nmcnativeTogetherSong', `读取失败：${message}`);
    throw new Error(message);
}

async function pollTogetherSongOnce() {
    try {
        await refreshCurrentTogetherSong();
    } catch (error) {
        state.togetherPollFailures += 1;
        if (state.togetherPollFailures === 1 || state.togetherPollFailures % 5 === 0) {
            setMessage(error?.message || String(error), 'error');
        }
    }
}

function startTogetherPolling({ pollNow = true } = {}) {
    stopTogetherPolling();
    const button = element('nmcnativeToggleSongPolling');
    if (button) {
        button.textContent = '自动刷新中';
    }
    if (pollNow) {
        void pollTogetherSongOnce();
    }
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
        throw new Error(`${activeCharacterName()} 返回的内容不是有效 JSON`);
    }
}

function characterWorldbookNames(character) {
    if (!character) {
        return [];
    }
    const names = [];
    const addName = value => {
        const name = String(value || '').trim();
        if (name && !names.includes(name)) {
            names.push(name);
        }
    };

    addName(character.data?.extensions?.world);
    const avatarKey = String(character.avatar || '').replace(/\.[^/.]+$/, '');
    const extraBooks = world_info.charLore?.find(item => item?.name === avatarKey)?.extraBooks;
    if (Array.isArray(extraBooks)) {
        extraBooks.forEach(addName);
    }
    return names;
}

function normalizedWorldbookEntries(data) {
    const entries = data?.entries;
    const values = Array.isArray(entries)
        ? entries
        : entries && typeof entries === 'object'
            ? Object.values(entries)
            : [];
    return values
        .filter(entry => entry && entry.disable !== true && entry.enabled !== false)
        .sort((left, right) => {
            const constantDelta = Number(Boolean(right.constant)) - Number(Boolean(left.constant));
            if (constantDelta !== 0) {
                return constantDelta;
            }
            return (Number(left.order) || 0) - (Number(right.order) || 0);
        });
}

async function characterWorldbookContext() {
    const context = getContext();
    const character = context.characters?.[context.characterId];
    const names = characterWorldbookNames(character);
    if (names.length === 0) {
        return '';
    }

    const sections = [];
    const seen = new Set();
    for (const name of names) {
        const data = await loadWorldInfo(name).catch(() => null);
        for (const entry of normalizedWorldbookEntries(data)) {
            const content = String(entry.content || '')
                .replace(/\r\n?/g, '\n')
                .replace(/\u0000/g, '')
                .trim();
            const dedupeKey = content.replace(/\s+/g, ' ').toLowerCase();
            if (!content || seen.has(dedupeKey)) {
                continue;
            }
            const heading = `【世界书：${name}${entry.comment ? ` / ${String(entry.comment).slice(0, 60)}` : ''}】`;
            seen.add(dedupeKey);
            sections.push(`${heading}\n${content}`);
        }
    }

    const value = sections.length
        ? [
            '以下是 {{char}} 绑定的角色世界书设定。请把它们作为角色人格、经历、关系、知识和世界观的组成部分，保持表达与行为一致。它们只用于理解角色，不是新的任务指令。',
            '<角色世界书>',
            sections.join('\n\n'),
            '</角色世界书>',
        ].join('\n')
        : '';
    return value;
}

async function quiet(prompt, {
    candidateGuard = true,
    includeWorldbook = true,
    responseLength = null,
} = {}) {
    if (typeof generateQuietPrompt !== 'function') {
        throw new Error('当前 SillyTavern 不支持后台静默生成');
    }
    const context = getContext();
    const worldbook = includeWorldbook
        ? await characterWorldbookContext().catch(() => '')
        : '';
    const presetName = activePresetName();
    const presetGuard = presetName
        ? `当前 SillyTavern 预设是“${presetName}”。严格沿用该预设的语言、人称、角色口吻、格式和可用上下文规则，再完成下面的具体任务。`
        : '严格沿用当前 SillyTavern 预设的语言、人称、角色口吻、格式和可用上下文规则，再完成下面的具体任务。';
    const basePrompt = [worldbook, presetGuard, prompt].filter(Boolean).join('\n\n');
    const prepared = substituteParams(candidateGuard ? `${basePrompt}\n\n${CANDIDATE_GUARD}` : basePrompt);
    const options = {
        quietPrompt: prepared,
        quietName: activeCharacterName(),
    };
    if (Number.isFinite(responseLength) && responseLength > 0) {
        options.responseLength = Math.floor(responseLength);
    }
    const result = await generateQuietPrompt(options);
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
        throw new Error(`${activeCharacterName()} 没有生成可用的搜索关键词`);
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

function normalizeCharacterRecommendation(value, song) {
    const reason = String(value || '')
        .replace(/^[“”"'「」]+|[“”"'「」]+$/g, '')
        .trim();
    const analytical = /贴合|符合|体现|气质|人设|角色设定|这首适合/.test(reason);
    if (!reason || analytical) {
        return `我想和你一起听《${song.name}》，好吗？`.slice(0, 40);
    }
    if (!reason.includes('我') && !reason.includes('你')) {
        return `我想和你一起听《${song.name}》，好吗？`.slice(0, 40);
    }
    if (!reason.includes('我')) {
        return `我想和你一起听《${song.name}》，好吗？`.slice(0, 40);
    }
    if (!reason.includes('你')) {
        return `你听听这首，${reason}`.slice(0, 40);
    }
    return reason.slice(0, 40);
}

function normalizeSongMatchText(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase('zh-CN')
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

function songIdentityKeys(song) {
    const keys = new Set();
    const id = String(song?.id || song?.songId || '').trim();
    if (id) {
        keys.add(`id:${id}`);
    }
    const name = normalizeSongMatchText(song?.name || song?.songName || song?.song_name);
    const artist = normalizeSongMatchText(song?.artist || song?.artists);
    if (name) {
        keys.add(`title:${name}|artist:${artist}`);
        const baseName = normalizeSongMatchText(
            String(song?.name || song?.songName || song?.song_name || '')
                .replace(/[\(（\[【][^\)）\]】]*[\)）\]】]/g, ''),
        );
        if (baseName && baseName !== name) {
            keys.add(`title:${baseName}|artist:${artist}`);
        }
    }
    return keys;
}

function filterNewSongCandidates(candidates, existingTracks = []) {
    const occupiedKeys = new Set();
    for (const song of Array.isArray(existingTracks) ? existingTracks : []) {
        songIdentityKeys(song).forEach(key => occupiedKeys.add(key));
    }
    const accepted = [];
    for (const song of Array.isArray(candidates) ? candidates : []) {
        const keys = [...songIdentityKeys(song)];
        if (!keys.length || keys.some(key => occupiedKeys.has(key))) {
            continue;
        }
        accepted.push(song);
        keys.forEach(key => occupiedKeys.add(key));
    }
    return accepted;
}

function existingSongsPrompt(tracks, { maxChars = 5000, maxItems = 120 } = {}) {
    const lines = [];
    let usedChars = 0;
    let skipped = 0;
    for (const song of Array.isArray(tracks) ? tracks : []) {
        if (lines.length >= maxItems) {
            skipped += 1;
            continue;
        }
        const line = `- ${song.name || song.songName || song.id || '未知歌曲'}${
            song.artist ? ` · ${song.artist}` : ''
        }`;
        if (usedChars + line.length > maxChars) {
            skipped += 1;
            continue;
        }
        lines.push(line);
        usedChars += line.length + 1;
    }
    if (!lines.length) {
        return '当前目标歌单为空。';
    }
    return [
        '当前目标歌单中已有以下歌曲。它们绝对不能再次被选为候选、重复添加或在本轮流程中评论：',
        ...lines,
        skipped ? `另有 ${skipped} 首未展开；即使未展开，也必须通过歌曲 ID 和歌名硬过滤，禁止重复。` : '',
    ].filter(Boolean).join('\n');
}

async function loadCurrentPlaylistTracksForSelection() {
    const playlistId = String(state.currentPlaylist?.id || '').trim();
    if (!playlistId) {
        throw new Error('当前没有歌单，请先点击「新建歌单」');
    }
    const selectedPlayerPlaylistId = String(element('nmcnativePlayerPlaylist')?.value || '');
    if (
        selectedPlayerPlaylistId === playlistId
        && state.loadedPlaylistTracksId === playlistId
    ) {
        return state.playerPlaylistTracks;
    }
    try {
        const result = await api(
            `/player/playlist-tracks/${encodeURIComponent(playlistId)}?limit=1000`,
        );
        return Array.isArray(result.songs) ? result.songs : [];
    } catch (error) {
        throw new Error(`无法读取当前歌单歌曲，已停止选歌以避免重复添加：${error?.message || error}`);
    }
}

async function chooseSongs(candidates, { existingPlaylistTracks = [] } = {}) {
    const availableCandidates = filterNewSongCandidates(candidates, existingPlaylistTracks);
    if (availableCandidates.length === 0) {
        return [];
    }
    const compact = await Promise.all(availableCandidates.map(async song => {
        const lyrics = String(song.lyric_snippet || '').slice(0, 700)
            || await getSongLyricsText(song, { maxChars: 700 });
        return {
            id: String(song.id),
            name: song.name,
            artist: song.artist,
            lyrics,
        };
    }));
    const existingSongs = existingSongsPrompt(existingPlaylistTracks);
    const reply = await quiet(`你是 {{char}}。请从以下候选歌曲及其歌词中挑选想推荐给 {{user}} 的歌曲：${JSON.stringify(compact)}。
${existingSongs}
reason 不是分析或第三人称评价，而是 {{char}} 当场直接对 {{user}} 说的一句推荐语，必须自然延续你的人格、关系、预设语气和最近对话。
每条 reason 必须是一句完整短句，并且同时包含第一人称“我”和对 {{user}} 说的“你”。
禁止出现“贴合、符合、体现、气质、人设、角色设定、这首适合”等分析词，禁止解释为什么适合角色，禁止使用第三人称称呼 {{char}}。
只能在上述候选中选歌；候选已经排除目标歌单现有歌曲及同名版本，禁止尝试选回、替换或评论这些已有歌曲。
推荐语必须结合该歌曲歌词中的具体意象、句子或情绪；歌词为空时才可以只根据歌名和歌手推荐，禁止编造歌词。
每首推荐语不超过 40 个中文字符，不同歌曲之间不要重复。
输出严格 JSON：{"selected":[{"id":"候选ID","reason":"我对 {{user}} 说的推荐短句"}]}。只输出 JSON。`);
    const parsed = parseJsonReply(reply);
    const candidateIds = new Set(compact.map(song => song.id));
    const used = new Set();
    return (Array.isArray(parsed.selected) ? parsed.selected : [])
        .map(item => {
            const id = String(item?.id || '').trim();
            const song = compact.find(candidate => candidate.id === id);
            return {
                id,
                reason: song ? normalizeCharacterRecommendation(item?.reason, song) : '',
            };
        })
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

async function buildSelection({ existingPlaylistTracks = [] } = {}) {
    const plan = await generatePersonaPlan({ withName: false });
    setConnectionState('正在搜索候选歌曲...', 'loading');
    const candidates = await searchCandidates(plan.keywords);
    const availableCandidates = filterNewSongCandidates(candidates, existingPlaylistTracks);
    const skippedExisting = candidates.length - availableCandidates.length;
    if (availableCandidates.length === 0) {
        return { plan, candidates, availableCandidates, selected: [], skippedExisting };
    }
    setConnectionState('正在筛选候选歌曲...', 'loading');
    const selectedIds = await chooseSongs(availableCandidates, { existingPlaylistTracks });
    const candidateMap = new Map(availableCandidates.map(song => [String(song.id), song]));
    const selected = selectedIds.map(item => ({
        ...item,
        name: candidateMap.get(item.id)?.name || item.id,
        artist: candidateMap.get(item.id)?.artist || '',
    }));
    return { plan, candidates, availableCandidates, selected, skippedExisting };
}

async function runCreateFlow() {
    const plan = await generatePersonaPlan({ withName: true });
    if (!plan.playlistName) {
        plan.playlistName = `${activeCharacterName()}的歌单`;
    }
    setConnectionState('正在搜索候选歌曲...', 'loading');
    const candidates = await searchCandidates(plan.keywords);
    if (candidates.length === 0) {
        setMessage(`没有找到符合 ${activeCharacterName()} 设定的歌曲，未创建歌单。`, 'info');
        return;
    }
    setConnectionState('正在筛选候选歌曲...', 'loading');
    const selected = await chooseSongs(candidates);
    if (selected.length === 0) {
        setMessage(`没有找到符合 ${activeCharacterName()} 设定的歌曲，未创建歌单。`, 'info');
        return;
    }

    setConnectionState('正在创建歌单并添加歌曲...', 'loading');
    const created = await api('/create-playlist-with-tracks', {
        method: 'POST',
        body: {
            name: plan.playlistName,
            privacy: false,
            track_ids: selected.map(item => item.id),
        },
    });
    const songMap = new Map(candidates.map(song => [String(song.id), song.name]));
    const enriched = selected.map(item => ({ ...item, name: songMap.get(item.id) || item.id }));
    state.currentPlaylist = { id: created.playlist_id, name: created.name };
    renderCurrentPlaylist(state.currentPlaylist);
    upsertPlaylistLocally(created, enriched.length);
    renderTargetPlaylistStatus(`当前目标：${created.name}`);
    renderOperationResult({
        title: '已新建歌单',
        playlistName: created.name,
        selected: enriched,
        added: Number(created.added) || 0,
        skipped: Number(created.skipped) || 0,
        message: created.message || '',
    });
}

function upsertPlaylistLocally(playlist, trackCount) {
    const playlistId = String(playlist?.playlist_id || '').trim();
    if (!playlistId) {
        return;
    }
    const item = {
        id: playlistId,
        name: String(playlist.name || '未命名歌单'),
        trackCount: Math.max(0, Number(trackCount) || 0),
        creator: '',
        isLiked: false,
    };
    const replace = playlists => [
        item,
        ...(Array.isArray(playlists) ? playlists : []).filter(
            existing => String(existing.id) !== playlistId,
        ),
    ];
    state.playlists = replace(state.playlists);
    state.playerPlaylists = replace(state.playerPlaylists);

    const targetSelect = element('nmcnativeTargetPlaylist');
    if (targetSelect) {
        if (![...targetSelect.options].some(optionNode => optionNode.value === playlistId)) {
            targetSelect.append(option(playlistId, `${item.name}（${item.trackCount} 首）`));
        }
        targetSelect.value = playlistId;
    }
    renderTargetPlaylistChoices();
    renderPlayerPlaylistChoices();
    updatePlaylistControls();
}

async function runAddToCurrentFlow() {
    if (!state.currentPlaylist?.id) {
        throw new Error('当前没有歌单，请先点击「新建歌单」');
    }
    setConnectionState('正在读取目标歌单现有歌曲...', 'loading');
    const existingPlaylistTracks = await loadCurrentPlaylistTracksForSelection();
    const { selected, skippedExisting } = await buildSelection({ existingPlaylistTracks });
    if (selected.length === 0) {
        setMessage(
            `没有找到可添加的新歌${skippedExisting ? `（已排除 ${skippedExisting} 首歌单中已有的歌曲）` : ''}，未添加。`,
            'info',
        );
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
        skipped: Number(added.skipped) + Number(skippedExisting || 0),
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
    resetTogetherMessageState();
    const status = await refreshStatus({ silent: true });
    const tasks = [refreshCurrentPlaylist()];
    if (status.loggedIn) {
        tasks.push(refreshPlaylists());
        tasks.push(refreshPlayerPlaylists());
    } else {
        resetPlaylistControls();
    }
    if (status.togetherEnabled) {
        tasks.push(refreshTogetherState());
        tasks.push(refreshTogetherMessageContacts());
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
            padding: 12px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 42%, transparent);
            border-radius: 14px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 62%, transparent);
            box-shadow: inset 0 1px 0 color-mix(in srgb, white 7%, transparent);
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
        #netease-music-companion-native .nmcnative-title-row {
            display: flex;
            align-items: center;
            gap: 7px;
        }
        #netease-music-companion-native .nmcnative-header-badge {
            padding: 1px 6px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 36%, transparent);
            border-radius: 999px;
            color: color-mix(in srgb, var(--SmartThemeQuoteColor) 74%, var(--SmartThemeBodyColor));
            font-size: .66rem;
            font-weight: 700;
            letter-spacing: .04em;
            line-height: 1.45;
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
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 34%, transparent);
        }
        #netease-music-companion-native .nmcnative-section:first-of-type {
            border-top: 0;
            padding-top: 0;
        }
        #netease-music-companion-native .nmcnative-section-title {
            margin: 0 0 9px;
            font-size: .9rem;
            font-weight: 700;
            letter-spacing: .01em;
        }
        #netease-music-companion-native .nmcnative-subsection-title {
            margin: 13px 0 7px;
            padding-top: 11px;
            border-top: 1px dashed color-mix(in srgb, var(--SmartThemeBorderColor) 38%, transparent);
            font-size: .82rem;
            font-weight: 650;
            opacity: .86;
        }
        #netease-music-companion-native .nmcnative-toggle-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 6px;
            margin-bottom: 10px;
        }
        #netease-music-companion-native .nmcnative-toggle {
            display: flex;
            align-items: center;
            gap: 7px;
            padding: 6px 8px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 42%, transparent);
            border-radius: 8px;
            font-size: .8rem;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 62%, transparent);
        }
        #netease-music-companion-native .nmcnative-toggle-wide {
            grid-column: 1 / -1;
        }
        #netease-music-companion-native input[type="checkbox"] {
            width: auto;
            margin: 0;
            flex: 0 0 auto;
        }
        #netease-music-companion-native .nmcnative-tabs {
            position: sticky;
            top: 0;
            z-index: 2;
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 3px;
            margin: 0 0 10px;
            padding: 3px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 32%, transparent);
            border-radius: 11px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 92%, transparent);
            backdrop-filter: blur(10px);
        }
        #netease-music-companion-native .nmcnative-tab-button {
            min-height: 31px;
            padding: 5px 6px;
            border-color: transparent;
            border-radius: 8px;
            background: transparent;
            font-size: .8rem;
        }
        #netease-music-companion-native .nmcnative-tab-button.active {
            border-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 28%, transparent);
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 16%, var(--SmartThemeBlurTintColor));
            font-weight: 700;
        }
        #netease-music-companion-native [data-nmcnative-panel][data-active="false"] {
            display: none !important;
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
            margin-bottom: 8px;
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
            border-radius: 8px;
        }
        #netease-music-companion-native button {
            min-height: 33px;
            padding: 6px 9px;
            line-height: 1.25;
            color: var(--SmartThemeBodyColor);
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 54%, transparent);
            border-radius: 9px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 82%, transparent);
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
        #netease-music-companion-native .nmcnative-primary {
            border-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 48%, var(--SmartThemeBorderColor));
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, var(--SmartThemeBlurTintColor));
            font-weight: 700;
        }
        #netease-music-companion-native .nmcnative-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            align-items: end;
            gap: 7px;
            margin-bottom: 8px;
        }
        #netease-music-companion-native .nmcnative-row .nmcnative-field {
            margin-bottom: 0;
        }
        #netease-music-companion-native .nmcnative-list-summary {
            margin: 0 0 6px;
            font-size: .74rem;
            opacity: .66;
        }
        #netease-music-companion-native .nmcnative-playlist-list,
        #netease-music-companion-native .nmcnative-track-list {
            display: flex;
            flex-direction: column;
            gap: 3px;
            max-height: 232px;
            overflow-y: auto;
            margin: 0 0 9px;
            padding: 4px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 36%, transparent);
            border-radius: 10px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 56%, transparent);
            scrollbar-gutter: stable;
        }
        #netease-music-companion-native .nmcnative-track-list {
            max-height: 276px;
        }
        #netease-music-companion-native .nmcnative-playlist-choice,
        #netease-music-companion-native .nmcnative-track-choice {
            display: grid;
            width: 100%;
            min-height: 43px;
            margin: 0;
            padding: 6px 7px;
            text-align: left;
            border-color: transparent;
            background: transparent;
        }
        #netease-music-companion-native .nmcnative-playlist-choice {
            grid-template-columns: 28px minmax(0, 1fr);
            align-items: center;
            gap: 7px;
        }
        #netease-music-companion-native .nmcnative-playlist-choice:hover,
        #netease-music-companion-native .nmcnative-track-choice:hover {
            border-color: color-mix(in srgb, var(--SmartThemeBorderColor) 36%, transparent);
        }
        #netease-music-companion-native .nmcnative-playlist-choice.selected,
        #netease-music-companion-native .nmcnative-track-choice.selected {
            border-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 38%, var(--SmartThemeBorderColor));
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 15%, transparent);
        }
        #netease-music-companion-native .nmcnative-track-choice.current {
            box-shadow: inset 3px 0 color-mix(in srgb, var(--SmartThemeQuoteColor) 72%, transparent);
        }
        #netease-music-companion-native .nmcnative-playlist-mark {
            display: grid;
            place-items: center;
            width: 27px;
            height: 27px;
            border-radius: 7px;
            color: color-mix(in srgb, var(--SmartThemeQuoteColor) 82%, var(--SmartThemeBodyColor));
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 12%, transparent);
            font-size: .69rem;
            font-weight: 750;
        }
        #netease-music-companion-native .nmcnative-playlist-body,
        #netease-music-companion-native .nmcnative-track-body {
            display: flex;
            min-width: 0;
            flex-direction: column;
            gap: 1px;
        }
        #netease-music-companion-native .nmcnative-playlist-name,
        #netease-music-companion-native .nmcnative-track-name {
            display: block;
            overflow: hidden;
            font-size: .79rem;
            font-weight: 650;
            line-height: 1.35;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        #netease-music-companion-native .nmcnative-playlist-meta,
        #netease-music-companion-native .nmcnative-track-meta {
            display: block;
            overflow: hidden;
            font-size: .7rem;
            line-height: 1.35;
            opacity: .6;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        #netease-music-companion-native .nmcnative-track-choice {
            grid-template-columns: 25px minmax(0, 1fr) auto;
            align-items: center;
            gap: 6px;
        }
        #netease-music-companion-native .nmcnative-track-number {
            font-size: .66rem;
            font-variant-numeric: tabular-nums;
            opacity: .46;
            text-align: center;
        }
        #netease-music-companion-native .nmcnative-track-state {
            font-size: .67rem;
            opacity: .52;
            white-space: nowrap;
        }
        #netease-music-companion-native .nmcnative-track-choice.selected .nmcnative-track-state {
            color: color-mix(in srgb, var(--SmartThemeQuoteColor) 76%, var(--SmartThemeBodyColor));
            opacity: .9;
        }
        #netease-music-companion-native .nmcnative-list-empty {
            margin: 0;
            padding: 14px 8px;
            text-align: center;
            font-size: .76rem;
            line-height: 1.45;
            opacity: .58;
        }
        #netease-music-companion-native .nmcnative-source-switch {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 3px;
            margin: 2px 0 10px;
            padding: 3px;
            border-radius: 10px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 88%, transparent);
        }
        #netease-music-companion-native .nmcnative-source-button {
            min-height: 30px;
            border-color: transparent;
            background: transparent;
        }
        #netease-music-companion-native .nmcnative-source-button.active {
            border-color: color-mix(in srgb, var(--SmartThemeBorderColor) 42%, transparent);
            background: color-mix(in srgb, var(--SmartThemeBodyColor) 8%, var(--SmartThemeBlurTintColor));
            font-weight: 700;
        }
        #netease-music-companion-native [data-nmcnative-player-source-panel][data-active="false"] {
            display: none !important;
        }
        #netease-music-companion-native .nmcnative-now-playing {
            margin-top: 10px;
            padding: 10px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 38%, transparent);
            border-radius: 11px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 72%, transparent);
        }
        #netease-music-companion-native .nmcnative-now-playing .nmcnative-status-line {
            margin: 0 0 7px;
            font-size: .84rem;
            font-weight: 650;
        }
        #netease-music-companion-native details.nmcnative-details {
            margin-top: 9px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 34%, transparent);
            border-radius: 9px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 48%, transparent);
        }
        #netease-music-companion-native details.nmcnative-details > summary {
            cursor: pointer;
            padding: 8px 10px;
            list-style: none;
            font-size: .8rem;
            font-weight: 650;
            user-select: none;
        }
        #netease-music-companion-native details.nmcnative-details > summary::-webkit-details-marker {
            display: none;
        }
        #netease-music-companion-native details.nmcnative-details > summary::before {
            content: "▸";
            display: inline-block;
            width: 1em;
            opacity: .62;
        }
        #netease-music-companion-native details.nmcnative-details[open] > summary::before {
            content: "▾";
        }
        #netease-music-companion-native details.nmcnative-details > :not(summary) {
            margin-left: 10px;
            margin-right: 10px;
        }
        #netease-music-companion-native details.nmcnative-details > :last-child {
            margin-bottom: 9px;
        }
        #netease-music-companion-native .nmcnative-room-card {
            margin: 7px 0 9px;
            padding: 9px 10px;
            border-radius: 10px;
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 7%, transparent);
        }
        #netease-music-companion-native .nmcnative-room-card .nmcnative-status-line {
            margin: 3px 0;
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
        #netease-music-companion-native .nmcnative-chat-toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin: 7px 0 8px;
        }
        #netease-music-companion-native .nmcnative-chat-toolbar .nmcnative-list-summary {
            margin: 0;
        }
        #netease-music-companion-native .nmcnative-chat-toolbar button {
            min-height: 29px;
            padding: 4px 8px;
            font-size: .74rem;
            white-space: nowrap;
        }
        #netease-music-companion-native .nmcnative-contact-list {
            display: flex;
            flex-direction: column;
            gap: 3px;
            max-height: 166px;
            overflow-y: auto;
            margin-bottom: 8px;
            padding: 4px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 34%, transparent);
            border-radius: 9px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 54%, transparent);
            scrollbar-gutter: stable;
        }
        #netease-music-companion-native .nmcnative-contact-choice {
            display: grid;
            grid-template-columns: 30px minmax(0, 1fr) auto;
            align-items: center;
            gap: 7px;
            width: 100%;
            min-height: 42px;
            padding: 5px 6px;
            text-align: left;
            border-color: transparent;
            background: transparent;
        }
        #netease-music-companion-native .nmcnative-contact-choice.selected {
            border-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 36%, var(--SmartThemeBorderColor));
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 14%, transparent);
        }
        #netease-music-companion-native .nmcnative-contact-avatar {
            display: grid;
            place-items: center;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            color: color-mix(in srgb, var(--SmartThemeQuoteColor) 82%, var(--SmartThemeBodyColor));
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 13%, transparent);
            font-size: .75rem;
            font-weight: 750;
        }
        #netease-music-companion-native .nmcnative-contact-body {
            display: flex;
            min-width: 0;
            flex-direction: column;
            gap: 1px;
        }
        #netease-music-companion-native .nmcnative-contact-name,
        #netease-music-companion-native .nmcnative-contact-preview {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        #netease-music-companion-native .nmcnative-contact-name {
            font-size: .78rem;
            font-weight: 650;
        }
        #netease-music-companion-native .nmcnative-contact-preview {
            font-size: .7rem;
            opacity: .56;
        }
        #netease-music-companion-native .nmcnative-contact-meta {
            font-size: .66rem;
            opacity: .5;
            white-space: nowrap;
        }
        #netease-music-companion-native .nmcnative-chat-history {
            display: flex;
            flex-direction: column;
            gap: 7px;
            max-height: 320px;
            min-height: 86px;
            overflow-y: auto;
            margin: 8px 0;
            padding: 9px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 34%, transparent);
            border-radius: 10px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 56%, transparent);
            scrollbar-gutter: stable;
        }
        #netease-music-companion-native .nmcnative-chat-bubble {
            display: flex;
            max-width: 86%;
            flex-direction: column;
            gap: 2px;
            padding: 7px 9px;
            border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 36%, transparent);
            border-radius: 10px;
            background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 84%, transparent);
        }
        #netease-music-companion-native .nmcnative-chat-bubble.nmcnative-chat-user {
            align-self: flex-start;
            border-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 30%, var(--SmartThemeBorderColor));
            background: color-mix(in srgb, var(--SmartThemeQuoteColor) 13%, var(--SmartThemeBlurTintColor));
        }
        #netease-music-companion-native .nmcnative-chat-bubble.nmcnative-chat-contact {
            align-self: flex-end;
        }
        #netease-music-companion-native .nmcnative-chat-bubble.nmcnative-chat-character {
            align-self: flex-start;
            border-style: dashed;
            border-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 48%, var(--SmartThemeBorderColor));
        }
        #netease-music-companion-native .nmcnative-chat-meta {
            font-size: .63rem;
            opacity: .52;
        }
        #netease-music-companion-native .nmcnative-chat-text {
            font-size: .78rem;
            line-height: 1.45;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
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
        #netease-music-companion-native .nmcnative-sent-message[data-status="pending"] {
            opacity: .62;
        }
        #netease-music-companion-native .nmcnative-sent-message[data-status="failed"] {
            color: #e48b8b;
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
            #netease-music-companion-native {
                max-width: 100%;
                margin: 6px 0 10px;
                padding: 8px;
                overflow-x: hidden;
                border-radius: 10px;
            }
            #netease-music-companion-native .inline-drawer-header {
                gap: 7px;
                padding: 1px 0;
            }
            #netease-music-companion-native h3 {
                font-size: .96rem;
            }
            #netease-music-companion-native .nmcnative-kicker {
                margin-top: 1px;
                font-size: .72rem;
            }
            #netease-music-companion-native .nmcnative-header-tail {
                gap: 8px;
            }
            #netease-music-companion-native .nmcnative-tabs {
                grid-template-columns: repeat(4, minmax(0, 1fr));
                gap: 2px;
                margin-bottom: 8px;
                padding: 2px;
            }
            #netease-music-companion-native .nmcnative-tab-button {
                min-height: 38px;
                padding: 4px 2px;
                font-size: .72rem;
                white-space: nowrap;
            }
            #netease-music-companion-native .nmcnative-section {
                margin-top: 8px;
                padding-top: 8px;
            }
            #netease-music-companion-native .nmcnative-section-title {
                margin-bottom: 7px;
                font-size: .86rem;
            }
            #netease-music-companion-native .nmcnative-grid {
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }
            #netease-music-companion-native .nmcnative-actions,
            #netease-music-companion-native .nmcnative-toggle-grid {
                grid-template-columns: 1fr;
            }
            #netease-music-companion-native .nmcnative-actions {
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 6px;
            }
            #netease-music-companion-native .nmcnative-row {
                grid-template-columns: 1fr;
                gap: 5px;
            }
            #netease-music-companion-native .nmcnative-row > button {
                width: 100%;
            }
            #netease-music-companion-native .nmcnative-field {
                margin-bottom: 6px;
            }
            #netease-music-companion-native label {
                font-size: .72rem;
            }
            #netease-music-companion-native select,
            #netease-music-companion-native input {
                min-height: 40px;
                font-size: .86rem;
            }
            #netease-music-companion-native button {
                min-height: 42px;
                padding: 7px 5px;
                font-size: .78rem;
                touch-action: manipulation;
            }
            #netease-music-companion-native .nmcnative-source-switch {
                margin-bottom: 8px;
            }
            #netease-music-companion-native .nmcnative-source-button {
                min-height: 36px;
            }
            #netease-music-companion-native .nmcnative-now-playing {
                padding: 8px;
            }
            #netease-music-companion-native audio {
                display: block;
                max-width: 100%;
            }
            #netease-music-companion-native .nmcnative-lyrics {
                max-height: 200px;
                padding: 6px;
            }
            #netease-music-companion-native .nmcnative-lyric-line {
                padding: 5px 6px;
            }
            #netease-music-companion-native details.nmcnative-details > summary {
                min-height: 40px;
                padding: 9px 8px;
                font-size: .78rem;
            }
            #netease-music-companion-native .nmcnative-chat-toolbar {
                flex-wrap: wrap;
                gap: 5px;
            }
            #netease-music-companion-native .nmcnative-contact-list {
                max-height: 116px;
                overscroll-behavior: contain;
            }
            #netease-music-companion-native .nmcnative-contact-choice {
                min-height: 40px;
            }
            #netease-music-companion-native .nmcnative-chat-history {
                max-height: 240px;
                padding: 7px;
                overscroll-behavior: contain;
            }
            #netease-music-companion-native .nmcnative-chat-bubble {
                max-width: 94%;
                padding: 6px 8px;
            }
            #netease-music-companion-native .nmcnative-chat-text {
                font-size: .8rem;
            }
            #netease-music-companion-native .nmcnative-playlist-list,
            #netease-music-companion-native .nmcnative-track-list {
                max-height: 210px;
                overscroll-behavior: contain;
            }
            #netease-music-companion-native .nmcnative-message-log,
            #netease-music-companion-native .nmcnative-comments {
                max-height: 160px;
                overscroll-behavior: contain;
            }
            #netease-music-companion-native .nmcnative-note,
            #netease-music-companion-native .nmcnative-status-line {
                font-size: .74rem;
            }
            #netease-music-companion-native .nmcnative-readonly {
                padding-top: 8px;
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
                        <div class="nmcnative-title-row">
                            <h3>网易云音乐</h3>
                            <span class="nmcnative-header-badge">NATIVE</span>
                        </div>
                        <p class="nmcnative-kicker" data-nmcnative-char-template="播放器 · 一起听 · {char}歌单">播放器 · 一起听 · 角色歌单</p>
                    </div>
                    <div class="nmcnative-header-tail">
                        <span id="nmcnativeStatusDot" class="nmcnative-status-dot" aria-label="登录状态"></span>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" aria-hidden="true"></div>
                    </div>
                </div>

                <div class="inline-drawer-content">
            <div class="nmcnative-tabs" role="tablist" aria-label="Netease Music Companion">
                <button id="nmcnativeTabPlayer" class="nmcnative-tab-button active" type="button" data-nmcnative-tab="player">播放器</button>
                <button id="nmcnativeTabTogether" class="nmcnative-tab-button" type="button" data-nmcnative-tab="together">一起听</button>
                <button id="nmcnativeTabPlaylists" class="nmcnative-tab-button" type="button" data-nmcnative-tab="playlists">歌单管理</button>
                <button id="nmcnativeTabAccount" class="nmcnative-tab-button" type="button" data-nmcnative-tab="account">账号</button>
            </div>
            <section class="nmcnative-section nmcnative-first-section" data-nmcnative-panel="account" data-active="false">
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

            <section class="nmcnative-section" data-nmcnative-panel="player" data-active="true">
                <p class="nmcnative-section-title">播放器</p>
                <div class="nmcnative-source-switch" role="tablist" aria-label="歌曲来源">
                    <button id="nmcnativeSourcePlaylist" class="nmcnative-source-button active" type="button" data-nmcnative-player-source="playlist" aria-selected="true">从歌单</button>
                    <button id="nmcnativeSourceSearch" class="nmcnative-source-button" type="button" data-nmcnative-player-source="search" aria-selected="false">搜索</button>
                </div>

                <div data-nmcnative-player-source-panel="playlist" data-active="true">
                    <div class="nmcnative-row">
                        <div class="nmcnative-field">
                            <label for="nmcnativePlayerPlaylistSearch">筛选歌单</label>
                            <input id="nmcnativePlayerPlaylistSearch" type="search" placeholder="歌单名或创建者">
                        </div>
                        <button id="nmcnativeRefreshPlayerPlaylists" type="button">刷新歌单</button>
                    </div>
                    <p id="nmcnativePlayerPlaylistSummary" class="nmcnative-list-summary">尚未读取歌单</p>
                    <div id="nmcnativePlayerPlaylistList" class="nmcnative-playlist-list" role="listbox" aria-label="账号歌单">
                        <p class="nmcnative-list-empty">正在读取歌单...</p>
                    </div>
                    <select id="nmcnativePlayerPlaylist" hidden aria-hidden="true">
                        <option value="">— 刷新歌单后选择 —</option>
                    </select>
                    <p class="nmcnative-subsection-title">歌曲列表</p>
                    <div class="nmcnative-field">
                        <label for="nmcnativePlayerTrackSearch">筛选歌曲</label>
                        <input id="nmcnativePlayerTrackSearch" type="search" placeholder="歌曲、歌手或专辑">
                    </div>
                    <p id="nmcnativePlayerTrackSummary" class="nmcnative-list-summary">尚未读取歌曲</p>
                    <div id="nmcnativePlayerTrackList" class="nmcnative-track-list" role="listbox" aria-label="歌单歌曲">
                        <p class="nmcnative-list-empty">选择歌单后显示歌曲</p>
                    </div>
                    <select id="nmcnativePlayerPlaylistTrack" hidden aria-hidden="true">
                        <option value="">— 先读取歌单 —</option>
                    </select>
                    <div class="nmcnative-actions">
                        <button id="nmcnativePlayPlaylistTrack" class="nmcnative-primary" type="button">播放选中歌曲</button>
                        <button id="nmcnativeLoadPlayerPlaylist" type="button">重新读取歌曲</button>
                    </div>
                </div>

                <div data-nmcnative-player-source-panel="search" data-active="false">
                    <div class="nmcnative-row">
                        <div class="nmcnative-field">
                            <label for="nmcnativePlayerSearchInput">歌曲、歌手或关键词</label>
                            <input id="nmcnativePlayerSearchInput" type="search" placeholder="例如：夏夜晚风">
                        </div>
                        <button id="nmcnativePlayerSearch" type="button">搜索</button>
                    </div>
                    <div class="nmcnative-field">
                        <label for="nmcnativePlayerSearchResults">搜索结果</label>
                        <select id="nmcnativePlayerSearchResults">
                            <option value="">— 先搜索歌曲 —</option>
                        </select>
                    </div>
                    <button id="nmcnativePlaySelectedSong" class="nmcnative-primary nmcnative-wide-button" type="button">播放选中歌曲</button>
                </div>

                <div class="nmcnative-now-playing">
                    <p id="nmcnativePlayerSong" class="nmcnative-status-line">尚未载入歌曲</p>
                    <audio id="nmcnativePlayerAudio" controls preload="metadata"></audio>
                    <div class="nmcnative-actions" style="margin-top:8px">
                        <button id="nmcnativePlayerPrevious" type="button">上一首</button>
                        <button id="nmcnativePlayerNext" type="button">下一首</button>
                        <button id="nmcnativePlayTogetherSong" class="nmcnative-wide-button" type="button">播放一起听当前歌曲</button>
                    </div>
                </div>

                <div id="nmcnativePlayerLyrics" class="nmcnative-lyrics">
                    <p class="nmcnative-lyrics-empty">播放或选择歌曲后显示歌词</p>
                </div>

                <details class="nmcnative-details">
                    <summary>歌曲评论</summary>
                    <div class="nmcnative-actions">
                        <button id="nmcnativeLoadSongComments" type="button">读取评论</button>
                        <button id="nmcnativeCharacterSongComment" type="button" data-nmcnative-char-template="以 {char} 身份评论">以角色身份评论</button>
                    </div>
                    <p class="nmcnative-note">生成评论时会读取当前歌曲的完整歌词与翻译，不会只根据歌名评价。</p>
                    <p id="nmcnativeGeneratedComment" class="nmcnative-status-line"></p>
                    <div id="nmcnativeSongComments" class="nmcnative-comments">
                        <p class="nmcnative-comment-empty">载入歌曲后可读取评论</p>
                    </div>
                </details>

                <details class="nmcnative-details">
                    <summary data-nmcnative-char-template="播放与 {char} 设置">播放与角色设置</summary>
                    <div class="nmcnative-toggle-grid">
                        <label class="nmcnative-toggle"><input id="nmcnativeContinuousPlayback" type="checkbox"> 连续播放</label>
                        <label class="nmcnative-toggle"><input id="nmcnativeCharacterAutoSelect" type="checkbox"> <span data-nmcnative-char-template="{char} 自动选下一首">角色自动选下一首</span></label>
                        <label class="nmcnative-toggle nmcnative-toggle-wide"><input id="nmcnativeConversationTools" type="checkbox"> <span data-nmcnative-char-template="允许 {char} 在对话中调用网易云工具">允许角色在对话中调用网易云工具</span></label>
                    </div>
                    <p class="nmcnative-note" data-nmcnative-char-template="{char} 的后台生成会沿用当前 SillyTavern 预设，并完整读取绑定的主世界书与附加世界书。对话工具仍需在 SillyTavern 的 Function Calling 设置中启用。">角色的后台生成会沿用当前 SillyTavern 预设，并完整读取绑定的主世界书与附加世界书。对话工具仍需在 SillyTavern 的 Function Calling 设置中启用。</p>
                </details>
            </section>

            <section id="nmcnativeTogetherSection" class="nmcnative-section" data-nmcnative-panel="together" data-active="false">
                <p class="nmcnative-section-title">一起听</p>
                <div class="nmcnative-room-card">
                    <p id="nmcnativeTogetherRoom" class="nmcnative-status-line">未加入房间</p>
                    <p id="nmcnativeTogetherSong" class="nmcnative-status-line">暂无歌曲信息</p>
                    <p id="nmcnativeTogetherServiceState" class="nmcnative-status-line">当前创建方式：本地逆向</p>
                </div>
                <p id="nmcnativeTogetherDisabled" class="nmcnative-module-disabled">一起听当前未启用。将 config.json 中的 enableTogetherListen 改为 true 并重启 SillyTavern 后即可使用。</p>
                <div class="nmcnative-actions">
                    <button id="nmcnativeCreateRoom" class="nmcnative-primary" type="button">创建房间</button>
                    <button id="nmcnativeToggleSongPolling" type="button">刷新当前歌曲</button>
                    <button id="nmcnativeSpeakSong" type="button" data-nmcnative-char-template="让 {char} 私信说说这首歌">让角色说说这首歌</button>
                    <button id="nmcnativeLeaveRoom" type="button">离开房间</button>
                </div>
                <div class="nmcnative-row" style="margin-top:8px">
                    <div class="nmcnative-field">
                        <label for="nmcnativeTogetherMode">创建方式</label>
                        <select id="nmcnativeTogetherMode">
                            <option value="local">本地逆向</option>
                            <option value="native">独立原生服务</option>
                        </select>
                    </div>
                </div>
                <p id="nmcnativeCharComment" class="nmcnative-status-line"></p>

                <div class="nmcnative-actions">
                    <button id="nmcnativeTogetherPrevious" type="button">上一首</button>
                    <button id="nmcnativeTogetherToggle" type="button">暂停</button>
                    <button id="nmcnativeTogetherNext" type="button">下一首</button>
                    <button id="nmcnativeRefreshRoomPlaylist" class="nmcnative-wide-button" type="button">刷新房间歌单</button>
                </div>

                <details class="nmcnative-details">
                    <summary>房间歌单</summary>
                    <div class="nmcnative-field">
                        <label for="nmcnativeTogetherPlaylistSearch">筛选房间歌曲</label>
                        <input id="nmcnativeTogetherPlaylistSearch" type="search" placeholder="歌曲、歌手或专辑">
                    </div>
                    <p id="nmcnativeTogetherPlaylistState" class="nmcnative-status-line">房间歌单尚未读取</p>
                    <div id="nmcnativeTogetherPlaylistList" class="nmcnative-track-list" role="listbox" aria-label="一起听房间歌曲">
                        <p class="nmcnative-list-empty">刷新房间歌单后显示歌曲</p>
                    </div>
                    <select id="nmcnativeTogetherPlaylist" hidden aria-hidden="true">
                        <option value="">— 刷新房间歌单后选择 —</option>
                    </select>
                    <div class="nmcnative-actions">
                        <button id="nmcnativeAddToRoomPlaylist" type="button">添加播放器选中歌曲</button>
                        <button id="nmcnativePlayRoomSong" class="nmcnative-primary" type="button">播放选中歌曲</button>
                    </div>
                </details>

                <details class="nmcnative-details">
                    <summary>邀请与加入</summary>
                    <div class="nmcnative-field">
                        <label for="nmcnativeTogetherLink">分享链接或房间 ID</label>
                        <input id="nmcnativeTogetherLink" type="text" spellcheck="false" placeholder="粘贴网易云一起听分享链接或房间 ID">
                    </div>
                    <p class="nmcnative-status-line"><a id="nmcnativeInviteLink" class="nmcnative-invite" target="_blank" rel="noopener noreferrer">尚未创建邀请链接</a></p>
                    <div class="nmcnative-actions">
                        <button id="nmcnativeJoinRoom" type="button">加入分享房间</button>
                        <button id="nmcnativeJoinRoomById" type="button">按房间号加入</button>
                        <button id="nmcnativeCopyInvite" type="button" disabled>复制链接</button>
                        <button id="nmcnativeSendInviteDm" type="button">发送邀请到私信</button>
                    </div>
                    <p class="nmcnative-note">支持当前分享链接和旧版房间 ID；创建方式可在房间卡片下方切换。</p>
                </details>

                <details id="nmcnativeTogetherReplyDetails" class="nmcnative-details">
                    <summary data-nmcnative-char-template="{char} 私信回复">角色私信回复</summary>
                    <div class="nmcnative-chat-toolbar">
                        <span id="nmcnativeTogetherMessageState" class="nmcnative-list-summary">正在读取网易云私信...</span>
                        <button id="nmcnativeRefreshTogetherMessages" type="button">刷新聊天记录</button>
                    </div>
                    <p id="nmcnativeTogetherReplyContext" class="nmcnative-note" data-nmcnative-char-template="读取你在网易云平台的私信记录，{char} 会结合聊天内容、绑定人设和预设生成 1–3 段回复，并合并为一条多段私信发送。是否参考当前歌曲歌词由下方开关决定。">读取你在网易云平台的私信记录，角色会结合聊天内容、绑定人设和预设生成 1–3 段回复，并合并为一条多段私信发送。是否参考当前歌曲歌词由下方开关决定。</p>
                    <label class="nmcnative-toggle nmcnative-toggle-wide">
                        <input id="nmcnativeTogetherIncludeLyrics" type="checkbox">
                        <span>私信生成时参考当前歌曲歌词与翻译</span>
                    </label>
                    <div id="nmcnativeTogetherMessageContacts" class="nmcnative-contact-list" role="listbox" aria-label="网易云私信联系人">
                        <p class="nmcnative-list-empty">正在读取联系人...</p>
                    </div>
                    <div id="nmcnativeTogetherMessageHistory" class="nmcnative-chat-history" aria-live="polite">
                        <p class="nmcnative-list-empty">选择联系人后显示聊天记录</p>
                    </div>
                    <button id="nmcnativeGenerateTogetherReply" class="nmcnative-primary nmcnative-wide-button" type="button" data-nmcnative-char-template="让 {char} 回应并发送">让角色回应并发送</button>
                    <button id="nmcnativeResendTogetherReply" class="nmcnative-wide-button" type="button" data-nmcnative-char-template="重发最近生成内容（{char}）" disabled>重发最近生成内容（角色）</button>
                    <div id="nmcnativeTogetherMessageLog" class="nmcnative-message-log" aria-live="polite"></div>
                    <p class="nmcnative-note">网易云连续私信接口存在发送频率限制，因此多段内容会写入同一条消息，并保留空行分段。如果生成成功但网易云没有显示，可点击“重发最近生成内容”。</p>
                </details>
            </section>

            <section class="nmcnative-section" data-nmcnative-panel="playlists" data-active="false">
                <p class="nmcnative-section-title">歌单管理</p>
                <div class="nmcnative-field">
                    <label for="nmcnativeTargetPlaylistSearch">筛选目标歌单</label>
                    <input id="nmcnativeTargetPlaylistSearch" type="search" placeholder="歌单名或创建者">
                </div>
                <p id="nmcnativeTargetPlaylistSummary" class="nmcnative-list-summary">尚未读取歌单</p>
                <div id="nmcnativeTargetPlaylistList" class="nmcnative-playlist-list nmcnative-target-playlist-list" role="listbox" aria-label="目标歌单">
                    <p class="nmcnative-list-empty">正在读取歌单...</p>
                </div>
                <select id="nmcnativeTargetPlaylist" hidden aria-hidden="true">
                        <option value="">— 选择一个已有歌单 —</option>
                </select>
                <p id="nmcnativeTargetPlaylistStatus" class="nmcnative-status-line">尚未选择目标歌单</p>
                <p class="nmcnative-note" data-nmcnative-char-template="点击歌单会立即切换为目标歌单，不需要再次确认。{char} 会先搜索候选歌曲，再根据角色设定选择；候选歌曲不会从当前歌单中读取。">点击歌单会立即切换为目标歌单，不需要再次确认。角色会先搜索候选歌曲，再根据角色设定选择；候选歌曲不会从当前歌单中读取。</p>
                <div class="nmcnative-actions">
                    <button id="nmcnativeCreateByPersona" class="nmcnative-primary" type="button">新建歌单</button>
                    <button id="nmcnativeAddToCurrent" type="button">为当前歌单加歌</button>
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
    bindCharacterNameEvents();
    document.querySelectorAll('[data-nmcnative-tab]').forEach(button => {
        button.addEventListener('click', () => activateTab(button.dataset.nmcnativeTab));
    });
    document.querySelectorAll('[data-nmcnative-player-source]').forEach(button => {
        button.addEventListener('click', () => {
            const source = button.dataset.nmcnativePlayerSource;
            activatePlayerSource(source);
            if (source === 'playlist'
                && element('nmcnativePlayerPlaylist')?.value
                && state.playerPlaylistTracks.length === 0) {
                void withBusy('正在读取歌单歌曲...', loadPlayerPlaylistTracks);
            }
        });
    });
    element('nmcnativeTogetherMode').addEventListener('change', event => {
        extension_settings[EXTENSION_KEY].togetherCreationMode = event.target.value;
        saveSettingsDebounced();
        void withBusy(
            '正在检查一起听服务...',
            () => refreshNativeServiceState({ start: event.target.value === 'native' }),
        ).then(() => {
            if (event.target.value === 'native') {
                startTogetherPolling();
            } else if (!state.inTogetherRoom) {
                stopTogetherPolling();
            }
        });
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
            const label = window.prompt(`账号标签，例如：${activeCharacterName()}小号`)?.trim();
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
            resetTogetherMessageState();
            await refreshStatus({ silent: true });
            resetPlaylistControls();
            setMessage(`账号 ${accountName(accountId)} 已退出登录。`, 'success');
        });
    });

    element('nmcnativeTargetPlaylist').addEventListener('change', () => {
        updatePlaylistControls();
    });
    element('nmcnativeTargetPlaylistSearch').addEventListener('input', () => {
        renderTargetPlaylistChoices();
    });
    element('nmcnativeCreateByPersona').addEventListener('click', () => {
        void withBusy(`${activeCharacterName()} 正在策划歌单...`, () => runCreateFlow());
    });
    element('nmcnativeAddToCurrent').addEventListener('click', () => {
        void withBusy(`${activeCharacterName()} 正在为当前歌单选歌...`, () => runAddToCurrentFlow());
    });

    element('nmcnativeRefreshPlayerPlaylists').addEventListener('click', () => {
        void withBusy('正在读取播放器歌单...', refreshPlayerPlaylists);
    });
    element('nmcnativePlayerPlaylistSearch').addEventListener('input', () => {
        renderPlayerPlaylistChoices();
    });
    element('nmcnativePlayerTrackSearch').addEventListener('input', () => {
        renderPlayerPlaylistTrackChoices();
    });
    element('nmcnativePlayerPlaylist').addEventListener('change', () => {
        if (element('nmcnativePlayerPlaylist')?.value) {
            void withBusy('正在读取歌单歌曲...', loadPlayerPlaylistTracks);
        }
    });
    element('nmcnativeLoadPlayerPlaylist').addEventListener('click', () => {
        void withBusy('正在加载歌单歌曲...', loadPlayerPlaylistTracks);
    });
    element('nmcnativePlayPlaylistTrack').addEventListener('click', () => {
        void withBusy('正在载入歌单歌曲...', playSelectedPlayerPlaylistSong);
    });
    element('nmcnativePlayerPlaylistTrack').addEventListener('change', () => {
        state.playerSelectionSource = 'playlist';
    });
    element('nmcnativePlayerSearchResults').addEventListener('change', () => {
        state.playerSelectionSource = 'search';
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
    element('nmcnativePlayerPrevious').addEventListener('click', () => {
        void withBusy('正在切换上一首...', playPreviousPlayerSong);
    });
    element('nmcnativePlayerNext').addEventListener('click', () => {
        void withBusy(`${activeCharacterName()} 正在选择下一首...`, () => playNextPlayerSong());
    });
    element('nmcnativeContinuousPlayback').addEventListener('change', event => {
        extension_settings[EXTENSION_KEY].continuousPlayback = event.target.checked;
        saveSettingsDebounced();
    });
    element('nmcnativeCharacterAutoSelect').addEventListener('change', event => {
        extension_settings[EXTENSION_KEY].characterAutoSelect = event.target.checked;
        saveSettingsDebounced();
    });
    element('nmcnativeConversationTools').addEventListener('change', event => {
        extension_settings[EXTENSION_KEY].conversationTools = event.target.checked;
        saveSettingsDebounced();
        syncConversationTools();
        setMessage(
            event.target.checked
                ? '已注册网易云对话工具。还需在 SillyTavern 函数调用设置中启用 Function Calling。'
                : '已关闭网易云对话工具。',
            'info',
        );
    });
    element('nmcnativePlayerAudio').addEventListener('timeupdate', syncPlayerLyrics);
    element('nmcnativePlayerAudio').addEventListener('seeked', syncPlayerLyrics);
    element('nmcnativePlayerAudio').addEventListener('ended', () => {
        void playNextPlayerSong({ automatic: true }).catch(error => {
            setMessage(error?.message || '自动播放下一首失败', 'error');
        });
    });
    element('nmcnativePlayerAudio').addEventListener('error', () => {
        if (element('nmcnativePlayerAudio')?.src) {
            setMessage('音频加载失败。歌曲可能需要会员、已下架或当前账号无权播放。', 'error');
        }
    });
    element('nmcnativeGenerateTogetherReply').addEventListener('click', () => {
        void withBusy(`${activeCharacterName()} 正在回复...`, generateTogetherReply);
    });
    element('nmcnativeResendTogetherReply').addEventListener('click', () => {
        void withBusy(`${activeCharacterName()} 正在重发私信...`, resendGeneratedTogetherMessage);
    });
    element('nmcnativeTogetherIncludeLyrics').addEventListener('change', event => {
        extension_settings[EXTENSION_KEY].includeTogetherLyrics = event.target.checked;
        saveSettingsDebounced();
        setMessage(
            event.target.checked
                ? '私信生成将参考当前歌曲歌词与翻译。'
                : '私信生成只使用聊天、人设、世界书和预设，不读取歌词。',
            'info',
        );
    });
    element('nmcnativeRefreshTogetherMessages').addEventListener('click', () => {
        void withBusy('正在刷新网易云聊天记录...', async () => {
            await refreshTogetherMessageContacts();
            startMessagePolling();
            setMessage('网易云聊天记录已刷新。', 'success');
        });
    });
    element('nmcnativeTogetherReplyDetails').addEventListener('toggle', event => {
        if (event.target.open && state.togetherEnabled && state.messageContacts.length === 0) {
            void withBusy('正在读取网易云私信...', refreshTogetherMessageContacts);
            startMessagePolling();
        } else if (event.target.open) {
            startMessagePolling();
        } else {
            stopMessagePolling();
        }
    });
    element('nmcnativeLoadSongComments').addEventListener('click', () => {
        void withBusy('正在读取评论...', loadSongComments);
    });
    element('nmcnativeCharacterSongComment').addEventListener('click', () => {
        void withBusy(`${activeCharacterName()} 正在写评论...`, characterCommentOnSong);
    });
    element('nmcnativeRefreshRoomPlaylist').addEventListener('click', () => {
        void withBusy('正在读取一起听房间歌单...', refreshRoomPlaylist);
    });
    element('nmcnativeTogetherPlaylistSearch').addEventListener('input', () => {
        renderRoomPlaylistChoices();
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
        void withBusy('正在刷新当前歌曲...', async () => {
            await refreshCurrentTogetherSong({ startNative: true });
            if (!state.togetherPollTimer) {
                startTogetherPolling({ pollNow: false });
            }
            setMessage('已刷新网易云当前播放歌曲。', 'success');
        });
    });
    element('nmcnativeSpeakSong').addEventListener('click', () => {
        void withBusy(`${activeCharacterName()} 正在写听歌短句...`, speakCurrentSongToUser);
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
            stopMessagePolling();
        } else if (extension_settings[EXTENSION_KEY]?.activeTab === 'together') {
            startMessagePolling();
        }
    });

    if (!state.panelObserver) {
        state.panelObserver = new MutationObserver(() => {
            const panel = element('netease-music-companion-native');
            if (panel && panel.offsetParent === null) {
                stopTogetherPolling();
                stopMessagePolling();
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
    applyCharacterNameCopy(element('netease-music-companion-native'));
    element('nmcnativeBackendUrl').value = extension_settings[EXTENSION_KEY].backendUrl;
    element('nmcnativeTogetherMode').value = extension_settings[EXTENSION_KEY].togetherCreationMode;
    element('nmcnativeContinuousPlayback').checked = extension_settings[EXTENSION_KEY].continuousPlayback;
    element('nmcnativeCharacterAutoSelect').checked = extension_settings[EXTENSION_KEY].characterAutoSelect;
    element('nmcnativeConversationTools').checked = extension_settings[EXTENSION_KEY].conversationTools;
    element('nmcnativeTogetherIncludeLyrics').checked = extension_settings[EXTENSION_KEY].includeTogetherLyrics;
    activateTab(extension_settings[EXTENSION_KEY].activeTab, { persist: false });
    activatePlayerSource(extension_settings[EXTENSION_KEY].playerSource, { persist: false });
    bindEvents();
    syncConversationTools();
    resetPlaylistControls();
    renderTogetherVisibility();
    try {
        const status = await refreshStatus({ silent: true });
        updateActiveLabel();
        await refreshCurrentPlaylist();
        if (status.loggedIn) {
            await refreshPlaylists().catch(() => {});
            await refreshPlayerPlaylists().catch(() => {});
        }
        if (status.togetherEnabled) {
            await refreshTogetherState().catch(() => {});
            await refreshNativeServiceState().catch(() => {});
            await refreshTogetherMessageContacts().catch(() => {});
            startMessagePolling();
        }
    } catch {
        setMessage('插件后端不可用。请确认 SillyTavern 已启用服务端插件并重启。', 'error');
    }
}

export function exit() {
    unbindCharacterNameEvents();
    unregisterConversationTools();
}

jQuery(async () => {
    await initializePanel();
});
