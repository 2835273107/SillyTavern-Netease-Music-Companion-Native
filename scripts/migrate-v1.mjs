#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '');
const force = process.argv.includes('--force');

if (!process.argv[2] || !fs.existsSync(path.join(root, 'config.yaml'))) {
    console.error('用法: node scripts/migrate-v1.mjs /path/to/SillyTavern [--force]');
    process.exit(1);
}

const source = path.join(root, 'plugins', 'netease-music-companion', 'config.json');
const targetDirectory = path.join(root, 'plugins', 'netease-music-companion-native');
const target = path.join(targetDirectory, 'config.json');

function isBlankNativeConfig(file) {
    if (!fs.existsSync(file)) {
        return true;
    }
    try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (
            !current.accounts
            || typeof current.accounts !== 'object'
            || Array.isArray(current.accounts)
        ) {
            return false;
        }
        const accountsAreBlank = Object.values(current.accounts).every(account => (
            !account?.music_u
            && !account?.csrf
            && !account?.nickname
            && !account?.userId
            && !account?.currentPlaylist?.id
        ));
        return accountsAreBlank
            && !current.user_netease_id
            && current.enableTogetherListen !== true
            && !current.togetherNative?.remoteUrl
            && !current.togetherNative?.remoteToken;
    } catch {
        return false;
    }
}

if (!fs.existsSync(source)) {
    console.error(`未找到 v1 配置: ${source}`);
    process.exit(1);
}
if (!isBlankNativeConfig(target) && !force) {
    console.error(`native 配置已存在，拒绝覆盖: ${target}`);
    console.error('确认要覆盖时追加 --force。');
    process.exit(1);
}

const previous = JSON.parse(fs.readFileSync(source, 'utf8'));
const previousAccounts = (
    previous.accounts
    && typeof previous.accounts === 'object'
    && !Array.isArray(previous.accounts)
)
    ? previous.accounts
    : (
        previous.music_u
            ? {
                default: {
                    music_u: String(previous.music_u),
                    csrf: String(previous.csrf || ''),
                    label: String(previous.charName || '默认账号'),
                    nickname: '',
                    userId: '',
                    currentPlaylist: previous.currentPlaylist || { id: '', name: '' },
                },
            }
            : {}
    );
const poc = previous.togetherPoc && typeof previous.togetherPoc === 'object'
    ? previous.togetherPoc
    : {};
const migrated = {
    api_base: previous.api_base || 'http://localhost:3000',
    accounts: previousAccounts,
    activeAccountId: previous.activeAccountId || Object.keys(previousAccounts)[0] || 'default',
    user_netease_id: String(previous.user_netease_id || ''),
    enableTogetherListen: previous.enableTogetherListen === true,
    togetherNative: {
        autoStart: false,
        pythonPath: poc.pythonPath || '',
        appPath: poc.appPath || '',
        debugPort: Number(poc.debugPort) || 9222,
        port: 3472,
        remoteUrl: poc.remoteUrl || '',
        remoteToken: poc.remoteToken || '',
    },
};

fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(migrated, null, 2)}\n`, { mode: 0o600 });
try {
    fs.chmodSync(`${target}.tmp`, 0o600);
} catch {
    // Windows and some shared filesystems do not implement POSIX modes.
}
fs.rmSync(target, { force: true });
fs.renameSync(`${target}.tmp`, target);

console.log(`已迁移账号和配置: ${target}`);
console.log('v1 配置未被修改；Native 版默认不自动启动原生服务，并使用 3472 端口。');
