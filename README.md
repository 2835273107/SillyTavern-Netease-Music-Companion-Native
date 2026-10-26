# SillyTavern Netease Music Companion Native

Netease Music Companion Native 是面向 SillyTavern 的网易云音乐插件，包含多账号扫码登录、角色歌单生成、目标歌单管理和内置原生一起听服务。

Native 使用独立插件 ID、配置目录、环境变量和端口，可与旧版并行安装。原生一起听服务由本项目直接提供，不克隆、不启动、也不依赖第三方 MCP 服务。

> 本项目是非官方第三方插件，与网易云音乐和 SillyTavern 官方均无隶属关系。

## 功能

- 多账号管理，每个账号独立保存登录凭据、昵称和当前目标歌单。
- 网易云 App 扫码登录。
- 读取账号歌单并选择目标歌单。
- 「新建歌单」：角色根据当前人设生成歌单名与搜索词，筛选后建单并加歌。
- 「添加歌曲到当前歌单」：只加歌，不新建歌单，不改变当前目标。
- 角色选歌使用 `generateQuietPrompt`，不写聊天历史，不触发普通回复。
- 一起听本地逆向创建与邀请。
- 内置原生服务：通过网易云桌面客户端创建房间、发送原生邀请、检查心跳并退出房间。
- 接受新版分享链接、兼容旧版房间 ID。
- 远程模式：Termux 或云服务器上的 SillyTavern 可调用家用电脑上的内置服务。
- 面板可折叠，并记住展开状态。
- 前端响应不包含 Cookie、Cookie UID 或远程服务 Token。

## 与 V1 隔离

| 资源 | V1 | Native |
| --- | --- | --- |
| 后端 ID | `netease-music` | `netease-music-native` |
| 前端目录 | `netease-music-companion` | `netease-music-companion-native` |
| 后端目录 | `netease-music-companion` | `netease-music-companion-native` |
| 设置键 | `neteaseMusicCompanion` | `neteaseMusicCompanionNative` |
| DOM 前缀 | `nmc` | `nmcnative` |
| 环境变量 | `NETEASE_*` | `NETEASE_NATIVE_*` |
| 默认原生服务端口 | `3456` | `3472` |

两个版本可以同时安装，不会覆盖彼此的配置或前端节点。

## 环境要求

- SillyTavern `1.19.0` 或兼容版本。
- Node.js `20+`。
- [NeteaseCloudMusicApi](https://gitlab.com/Binaryify/NeteaseCloudMusicApi)，默认地址 `http://localhost:3000`。
- 支持 Chat Completion 的主模型连接。
- 使用内置原生一起听服务时：
  - Python `3.9+`；
  - Windows 或 macOS 上的网易云官方桌面客户端；
  - 允许服务通过 CDP 启动或重启桌面客户端。

插件不需要额外 npm 包，原生服务只使用 Python 标准库。

## 安装

### 一键安装

```bash
git clone https://github.com/2835273107/SillyTavern-Netease-Music-Companion-Native.git
cd SillyTavern-Netease-Music-Companion-Native
```

Windows：

```powershell
pwsh -ExecutionPolicy Bypass -File .\install.ps1 -SillyTavernPath "D:\SillyTavern"
```

Linux、macOS 或 Termux：

```bash
chmod +x install.sh
./install.sh /path/to/SillyTavern
```

安装器会复制：

```text
public/scripts/extensions/third-party/netease-music-companion-native/
plugins/netease-music-companion-native/
├── together-bridge.js
└── together-native/
    └── service.py
```

安装器不会下载第三方 MCP，也不会修改旧版目录。

### 启用服务端插件

在 SillyTavern 的 `config.yaml` 中确认：

```yaml
enableServerPlugins: true
```

重启 SillyTavern。前端请求路径为：

```text
/api/plugins/netease-music-native
```

## 从 V1 迁移

```bash
node scripts/migrate-v1.mjs /path/to/SillyTavern
```

全新安装生成的空白 Native 配置可以被自动替换。若 Native 中已有账号或远程服务设置，脚本会拒绝覆盖；确认要替换时：

```bash
node scripts/migrate-v1.mjs /path/to/SillyTavern --force
```

迁移会复制账号、Cookie、目标歌单和一起听设置。旧版兼容字段 `togetherPoc` 会转换为 Native 的 `togetherNative`；旧 POC 路径不会保留，因为 Native 使用内置服务。

## 配置

```json
{
  "api_base": "http://localhost:3000",
  "accounts": {
    "default": {
      "music_u": "",
      "csrf": "",
      "label": "默认账号",
      "nickname": "",
      "userId": "",
      "currentPlaylist": {
        "id": "",
        "name": ""
      }
    }
  },
  "activeAccountId": "default",
  "user_netease_id": "",
  "enableTogetherListen": false,
  "togetherNative": {
    "autoStart": false,
    "pythonPath": "",
    "appPath": "",
    "debugPort": 9222,
    "port": 3472,
    "remoteUrl": "",
    "remoteToken": ""
  }
}
```

| 字段 | 用途 |
| --- | --- |
| `api_base` | NeteaseCloudMusicApi 地址 |
| `accounts` | 独立账号配置 |
| `activeAccountId` | 当前活动账号 |
| `user_netease_id` | 接收原生一起听邀请的数字用户 ID |
| `enableTogetherListen` | 启用一起听 |
| `togetherNative.autoStart` | 酒馆启动时自动运行内置服务 |
| `togetherNative.pythonPath` | Python 可执行文件 |
| `togetherNative.appPath` | 网易云桌面客户端路径 |
| `togetherNative.debugPort` | 客户端 CDP 端口 |
| `togetherNative.port` | 内置 HTTP 服务端口，默认 `3472` |
| `togetherNative.remoteUrl` | 远程内置服务地址；填写后不启动本地服务 |
| `togetherNative.remoteToken` | 远程服务 Bearer Token |

Native 环境变量：

```text
NETEASE_NATIVE_API_BASE
NETEASE_NATIVE_MUSIC_U
NETEASE_NATIVE_CSRF
NETEASE_NATIVE_NATIVE_PYTHON
NETEASE_NATIVE_NATIVE_CLIENT_PATH
NETEASE_NATIVE_NATIVE_URL
NETEASE_NATIVE_NATIVE_TOKEN
```

## 首次使用

1. 打开 SillyTavern → 扩展程序 → Netease Music Companion Native。
2. 添加或选择账号。
3. 点击「扫码登录」。
4. 刷新歌单并选择目标歌单。
5. 使用「新建歌单」或「添加歌曲到当前歌单」。

角色候选歌曲只来自本次搜索。搜索无合适结果时返回空选择，不使用当前歌单已有歌曲补位。

## 一起听

设置：

```json
{
  "enableTogetherListen": true,
  "user_netease_id": "接收方数字用户ID"
}
```

### 本地逆向

沿用插件通过 NeteaseCloudMusicApi 调用一起听接口的兼容方式。该模式适合接受已有邀请或旧流程，但无法独立维持完整客户端心跳。

### 独立原生服务

选择「独立原生服务」后，插件会：

1. 启动内置 `together-native/service.py`。
2. 检查桌面客户端和 CDP。
3. 读取当前客户端账号与房间状态。
4. 创建房间并确认客户端心跳。
5. 向 `user_netease_id` 发送原生邀请。
6. 返回房间 ID 和分享链接。
7. 退出时调用桌面客户端离开房间。

Windows 客户端首次使用时，服务会以调试参数重启客户端。房间创建与心跳由官方桌面客户端维持。

### 远程服务

```text
手机/云 SillyTavern
        │ HTTPS 或可信私有网络
        ▼
家用电脑 service.py :3472
        │ CDP :9222，仅本机
        ▼
网易云桌面客户端
```

家用电脑：

```powershell
$env:NETEASE_NATIVE_SERVICE_COOKIE = "MUSIC_U=你的值; __csrf=你的值"
$env:NETEASE_NATIVE_SERVICE_RECEIVER_ID = "接收方数字用户ID"
$env:NETEASE_NATIVE_SERVICE_CLIENT_PATH = "D:\CloudMusic\cloudmusic.exe"
$env:NETEASE_NATIVE_SERVICE_HOST = "0.0.0.0"
$env:NETEASE_NATIVE_SERVICE_PORT = "3472"
$env:NETEASE_NATIVE_SERVICE_TOKEN = "至少32字节的随机值"
python -B service.py
```

Native 配置：

```json
{
  "togetherNative": {
    "autoStart": false,
    "remoteUrl": "http://100.x.y.z:3472",
    "remoteToken": "与 NETEASE_NATIVE_SERVICE_TOKEN 相同"
  }
}
```

- 同一 Wi-Fi：`http://电脑局域网IP:3472`
- Tailscale：`http://电脑的100.x.y.z:3472`
- 公网：必须使用 HTTPS 反向代理或受控隧道

明文 HTTP 仅允许 localhost、私有网段、IPv6 ULA、链路本地地址和 Tailscale `100.64.0.0/10`。

远程服务不会收到 SillyTavern 本地的 NetEase Cookie。它使用自身 `NETEASE_NATIVE_SERVICE_COOKIE`，并返回脱敏的 Cookie 账号 ID 供插件比对。

## 手机和云端

扫码、多账号、歌单和接受已有邀请不需要桌面客户端。

云服务器无法直接点击手机网易云 App 内的按钮。手机负责接受邀请；电脑上的内置服务负责创建并维持桌面客户端房间。云服务器无法直接访问家庭局域网时，可使用 Tailscale、VPN 或 HTTPS 隧道。

## 多账号

- 每个插件账号独立保存 Cookie 和当前歌单。
- 一次只运行一个本地内置服务。
- 切换活动账号会停止旧服务。
- 远程服务需要运维者为不同账号分别启动实例并使用不同端口和 Token。

## 安全

- Cookie 只保存在后端配置中。
- `config.json` 已被 `.gitignore` 排除。
- 服务除 `/health` 外都要求 Bearer Token。
- 公网远程地址强制 HTTPS。
- 客户端 CDP 只接受本机 WebSocket。
- 服务不记录请求头、Cookie 或邀请链接。
- 本地服务随 SillyTavern 退出。

详见 [SECURITY.md](SECURITY.md)。

## 常见问题

### 面板没有出现

确认前端位于 `netease-music-companion-native/`，然后重启酒馆并强制刷新浏览器。

### 后端 404

确认后端 `info.id` 为 `netease-music-native`，文件位于 `plugins/netease-music-companion-native/`。

### 独立原生服务未启动

检查 Python 路径、`together-native/service.py`、客户端路径和 `3472` 端口。

### 客户端账号不一致

插件活动账号、配置 Cookie 和网易云桌面客户端必须登录同一个账号。

### 远程服务无法连接

检查 `remoteUrl`、`remoteToken`、防火墙和服务进程。公网只允许 HTTPS，Tailscale 地址通常以 `100.` 开头。

### 邀请链接 404

使用完整官方分享参数：

```text
https://st.music.163.com/listen-together/share/index.html?roomId=...&inviterId=...&songId=...
```

## 开发

```bash
npm test
npm run check
python -m py_compile plugin/together-native/service.py
```

架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可

本项目使用 MIT License。原生服务的实现和 HTTP 接口由本项目维护；运行时不需要安装第三方 MCP。

协议兼容研究阶段的鸣谢见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
