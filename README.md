# SillyTavern Netease Music Companion Native

![version](https://img.shields.io/badge/version-1.13.1-e60026)
![SillyTavern](https://img.shields.io/badge/SillyTavern-1.19%2B-7c4dff)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933)
![license](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)

让 SillyTavern 里的角色陪你听网易云音乐：在酒馆里播放歌曲、同步歌词与悬浮歌词，让角色根据人设和世界书选歌、建歌单、写评论、回私信，还能创建网易云原生「一起听」房间。

> 本项目是非官方第三方插件，与网易云音乐和 SillyTavern 官方均无隶属或背书关系。
>
> 本人有受到天赋狗权、初中辍学纹身师、三水影响下做的插件。

## 目录

- [功能一览](#功能一览)
- [快速开始](#快速开始)
- [界面导览](#界面导览)
- [播放器与歌词](#播放器与歌词)
- [角色互动](#角色互动)
- [歌单管理](#歌单管理)
- [一起听](#一起听)
- [配置参考](#配置参考)
- [手机、Termux 与云服务器](#手机termux-与云服务器)
- [更新与卸载](#更新与卸载)
- [安全说明](#安全说明)
- [故障排查](#故障排查)
- [开发](#开发)

## 功能一览

| 模块 | 能做什么 |
| --- | --- |
| 播放器 | 搜索或从歌单播放，拖动进度，上一首/下一首，连续播放 |
| 歌词 | 跟随进度高亮，点击跳转；外语歌原文与中文翻译并排，可关闭翻译 |
| 悬浮歌词 | 平时透明只显示歌词，点一下展开播放/暂停、下一首、翻译开关 |
| 角色选歌 | 角色根据人设、世界书、当前歌曲和最近对话选择下一首 |
| 歌单 | 多账号读取歌单，角色生成新歌单，向目标歌单添加歌曲（自动去重） |
| 评论 | 读取歌曲评论，让角色结合歌词写评论并发布 |
| 私信 | 读取网易云私信，让角色结合聊天和歌词回复 |
| 一起听 | 创建、邀请、关闭原生房间，读取当前歌曲与房间歌单，切歌 |
| 函数工具 | 对话中让角色调用搜索、播放、评论、房间控制等工具 |
| 副 API | 可选 OpenAI 兼容接口分担选歌、评论、私信等生成任务，失败自动回退主 AI |
| 多端 | 电脑、手机浏览器、Termux、云服务器 + 家用电脑原生服务 |

## 快速开始

### 环境要求

- SillyTavern `1.19.0` 或兼容版本
- Node.js `20+`
- 支持 Chat Completion 的主模型连接
- 只有「一起听」需要：Python `3.9+`，以及已登录的 Windows / macOS 网易云官方桌面客户端

### 1. 安装

```bash
git clone https://github.com/2835273107/SillyTavern-Netease-Music-Companion-Native.git
cd SillyTavern-Netease-Music-Companion-Native
```

Windows：

```powershell
pwsh -ExecutionPolicy Bypass -File .\install.ps1 -SillyTavernPath "D:\SillyTavern"
```

macOS / Linux：

```bash
chmod +x install.sh
./install.sh /path/to/SillyTavern
```

安装器会复制前端和后端，从 `config.example.json` 创建 `config.json`（已有配置不会被覆盖），并在首次安装时准备受管的 NeteaseCloudMusicApi，不需要再手动运行 `node app.js`。

### 2. 启用服务端插件

在 SillyTavern 的 `config.yaml` 中确认：

```yaml
enableServerPlugins: true
```

然后重启 SillyTavern。

### 3. 登录

1. 打开「扩展程序 → Netease Music Companion Native」。
2. 进入「账号」分页，点击「扫码登录」，用网易云 App 扫码。
3. 二维码过期会提示，重新获取即可。登录结果只保存在后端 `config.json`，浏览器读不到 Cookie。

### 4. 开始听歌

进入「播放器」分页，搜索一首歌并点击播放。想要悬浮歌词，点击歌词区域上方的「悬浮歌词」按钮。

## 界面导览

插件面板分为四个分页，当前分页、歌曲来源和选择状态会被记住：

| 分页 | 内容 |
| --- | --- |
| 播放器 | 当前歌曲、播放控制、歌词、搜索/歌单选歌；「更多」中是连续播放、角色选歌、歌词显示、函数工具、副 API |
| 一起听 | 创建与离开房间、当前歌曲、房间歌单、角色私信回复 |
| 歌单管理 | 选择目标歌单、角色新建歌单、添加歌曲 |
| 账号 | 多账号切换、扫码登录、登录状态 |

次要操作默认收起。手机窄屏会自动改为单列布局并加大触控区域，列表在各自区域内滚动，面板不会被无限拉长。

## 播放器与歌词

### 播放

- **搜索**：输入歌名、歌手或关键词，点击结果直接播放。
- **从歌单**：选择账号歌单后点击曲目播放，单次最多加载 500 首，支持按名称、歌手、专辑筛选。
- **一起听当前歌曲**：读取房间当前歌曲并在酒馆中播放。
- **连续播放**：歌曲结束自动播放下一首；关闭「角色自动选下一首」时按歌单顺序循环。

音频经由插件后端代理并支持 HTTP Range，可以拖动进度和分段加载。

### 歌词与翻译

歌词来自网易云 `/lyric` 接口，按播放进度高亮当前行，点击任意行可跳转到对应时间，不会自动滚动整个酒馆页面。

- 外语歌曲：原文与中文翻译并排显示。
- 中文歌曲：只显示歌词。
- 不想看翻译：点击歌词区域上方的「翻译」按钮关闭，设置会保存。

### 悬浮歌词

点击「悬浮歌词」后，页面上会出现一条悬浮歌词：

- **平时透明**：没有背景和按钮，只有带描边阴影的歌词文字浮在页面上，不挡视线。
- **点一下展开**：点击歌词会显示半透明背景、歌名和工具栏（播放/暂停、下一首、切换翻译、关闭）；再点歌词或点页面其他地方就会收起。
- 第一行是当前歌词；第二行是中文翻译，关闭翻译或没有翻译时显示下一句。
- 展开后拖动顶部工具栏可以移动位置，位置会保存；双击工具栏恢复默认位置。

「翻译」和「悬浮歌词」也可以在播放器「更多」设置里开关。

### 播放限制

- 会员歌曲、已下架歌曲或当前账号无权播放的歌曲可能没有可用音频。
- 浏览器可能阻止自动播放，点击播放器的播放按钮即可。
- 酒馆播放器与网易云 App / 桌面客户端不是同一个播放器实例，不会替换一起听同步状态。

## 角色互动

### 世界书与人设

新建歌单、添加歌曲、自动选下一首、歌曲评论、私信回复和对话工具都会带上当前角色卡、主世界书和附加世界书（完整读取启用条目，常驻条目优先），并沿用当前 SillyTavern 预设的语言、人称和文风。没有绑定世界书时照常工作。世界书内容不会显示在界面上，也不会写入浏览器日志。

插件会自动清理生成结果中的思考块（`thinking`、`analysis` 等）、HTML 残片和装饰性尾注，并尽量在完整句子处截断。

### 角色自动选下一首

在播放器「更多」中开启后，角色会根据人设、当前歌曲和最近对话挑选下一首。每轮需要两次模型调用：一次决定搜索方向，一次根据真实搜索结果和歌词选歌。

### 歌曲评论

1. 选择或播放一首歌，可先点击「读取歌曲评论」。
2. 点击「让角色评论这首歌」，角色会结合该歌的歌词和翻译写一段约 120 字（最多 140 字）的评论，并以当前账号发布。

发布评论是公开操作，请先确认角色和歌曲。同一账号在一次会话中每首歌只评论一次。

### 对话中的网易云工具

开启「允许角色在对话中调用网易云工具」，并在 SillyTavern 中启用 Function Calling、选择支持工具调用的模型后，角色可以：

- 搜索、播放歌曲，控制播放/暂停/上一首/下一首
- 添加歌曲到一起听房间并控制房间
- 评论歌曲
- 读取当前音乐和房间状态

关闭开关后工具会立即注销。

### 副 AI API（可选）

可以配置一个 OpenAI Chat Completions 兼容接口，分别勾选用于「歌单策划与选歌」「自动下一首」「歌曲评论」「私信回复」。

- `API URL` 填到 `/v1` 即可，例如 `https://example.com/v1`。
- `API Key` 只保存在后端，不会回传浏览器；留空表示保留已保存的密钥。
- 「保存并测试」会尝试读取 `/v1/models` 列出模型。
- 公网地址必须使用 HTTPS，HTTP 只允许本机或私有网段。
- 副 API 超时或出错时自动回退主 AI。

## 歌单管理

- **选择目标歌单**：插件启动或切换账号时自动读取歌单，点击即设为目标，无需确认。
- **新建歌单**：角色根据人设生成歌单名和搜索词，从真实搜索结果中选歌，一次请求完成创建和添加，并设为新的目标歌单。
- **添加歌曲到当前歌单**：角色在已有歌曲之外搜索并挑选新歌，只添加不新建。

去重规则：目标歌单已有的歌曲（按 ID 和「歌名 + 歌手」）、翻唱、吉他/钢琴/指弹、现场、伴奏、Remix、重制版等同名版本，以及本次会话已评论过的歌曲，都不会被再次选中。推荐理由由角色直接对 `{{user}}` 说出，每条不超过 40 字。

## 一起听

### 运行结构

```text
浏览器 / 手机 / 云服务器
          │
          ▼
SillyTavern :8000
├─ 前端扩展
└─ 服务端插件
   ├─ 账号与扫码
   ├─ 歌单与角色生成
   └─ 原生一起听服务 (together-native/service.py)
      ├─ NeteaseCloudMusicApi :3000
      └─ 网易云桌面客户端
         └─ CDP :9222，仅本机
```

原生服务需要访问桌面客户端，因此必须运行在安装了网易云桌面客户端的 Windows 或 macOS 电脑上，不需要安装其他 MCP 项目。

### 前置条件

- `enableTogetherListen: true`，并填写接收邀请的 `user_netease_id`
- 插件当前账号与桌面客户端登录的是同一个网易云账号
- Python 可用

### 创建与离开房间

1. 打开「一起听」，创建方式选择「独立原生服务」，点击「创建房间」。
2. 服务会创建房间、让桌面客户端进入房间、启动心跳，并向 `user_netease_id` 发送原生邀请。
3. 在手机网易云 App 中接受邀请并播放。
4. 点击「离开房间」时，服务会让客户端离开并清理残留房间，必要时会重启客户端，这是正常的兜底行为。

Windows 客户端可能会被以 `--remote-debugging-port=9222 --remote-allow-origins=*` 参数重启。CDP 只应监听本机。

### 当前歌曲与房间歌单

- 「刷新当前歌曲」优先读取桌面客户端实际播放的歌曲，后台也会定时刷新。
- 「刷新房间歌单」读取官方房间歌单，当前歌曲会被标记；可以选歌播放、切歌、暂停，或把播放器中的歌曲添加进房间。
- 只有自己在房间里时，客户端可能不会立即切歌，需要伙伴进入后才同步。

### 角色私信回复

1. 展开「角色私信回复」，选择一个网易云私信联系人，查看最近聊天。
2. 点击「让角色回应并发送」，角色会生成 1–3 段回复（每段不超过 60 字），合并为一条私信发送。
3. 「私信生成时参考当前歌曲歌词与翻译」默认开启，可关闭。
4. 「让角色说说这首歌」会生成不超过 80 字的听歌短句并私信给当前联系人。
5. 发送失败或网易云没显示时，可点击「重发最近生成内容」。

聊天中 `{{char}}` 在左、`{{user}}` 在右。打开私信详情时，会话每 4 秒自动刷新。

> Windows 网易云桌面客户端没有公开的房间聊天发送接口，所以这里通过私信发送，不是写入原生房间聊天。

## 配置参考

后端配置文件：`SillyTavern/plugins/netease-music-companion-native/config.json`

```json
{
  "api_base": "http://localhost:3000",
  "neteaseApi": {
    "autoStart": true,
    "projectPath": "",
    "entry": "",
    "nodePath": "",
    "startupTimeoutMs": 30000
  },
  "accounts": {
    "default": {
      "music_u": "",
      "csrf": "",
      "label": "默认角色账号",
      "nickname": "",
      "userId": "",
      "currentPlaylist": { "id": "", "name": "" }
    }
  },
  "activeAccountId": "default",
  "user_netease_id": "接收邀请的网易云数字用户ID",
  "enableTogetherListen": true,
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

| 字段 | 说明 |
| --- | --- |
| `api_base` | NeteaseCloudMusicApi 地址 |
| `neteaseApi.autoStart` | 随 SillyTavern 自动启动 API；`3000` 端口已有 API 时直接复用 |
| `neteaseApi.projectPath` | 自有 API 项目目录，留空使用受管运行时 |
| `neteaseApi.entry` | 自有项目入口，留空自动查找 `app.js` / `server.js` |
| `neteaseApi.nodePath` | 启动 API 的 Node.js，留空使用 SillyTavern 当前 Node.js |
| `neteaseApi.startupTimeoutMs` | 等待 API 就绪的最长时间 |
| `user_netease_id` | 接收一起听邀请的数字用户 ID |
| `enableTogetherListen` | 是否启用一起听 |
| `togetherNative.autoStart` | 随 SillyTavern 启动本地原生服务；关闭时也会在需要时按需启动 |
| `togetherNative.pythonPath` | Python 路径，留空使用 `python` / `python3` |
| `togetherNative.appPath` | 网易云客户端路径，留空自动探测，例如 `D:\\CloudMusic\\cloudmusic.exe` |
| `togetherNative.debugPort` | 桌面客户端 CDP 端口，默认 `9222` |
| `togetherNative.port` | 本地原生服务端口，默认 `3472` |
| `togetherNative.remoteUrl` | 远程原生服务地址，填写后不启动本地服务 |
| `togetherNative.remoteToken` | 远程原生服务 Bearer Token |

受管 API 位于 `plugins/netease-music-companion-native/netease-api-runtime/`，由插件启动的 API 会随 SillyTavern 退出而关闭。

## 手机、Termux 与云服务器

### 手机浏览器

手机不需要安装任何东西。电脑上的 SillyTavern 监听局域网、防火墙放行 `8000` 后，手机浏览器打开 `http://电脑局域网IP:8000/` 即可。扫码、歌单、播放和接受邀请都能在手机上完成；创建原生房间仍需要电脑上的桌面客户端。可以通过浏览器「添加到主屏幕」做成网页快捷方式。

### Termux

```bash
pkg update
pkg install -y git nodejs python
git clone https://github.com/2835273107/SillyTavern-Netease-Music-Companion-Native.git "$HOME/SillyTavern-Netease-Music-Companion-Native"
cd "$HOME/SillyTavern-Netease-Music-Companion-Native"
chmod +x install.sh
./install.sh "$HOME/SillyTavern"
termux-wake-lock
cd "$HOME/SillyTavern" && node server.js
```

Termux 没有网易云桌面客户端，一起听需要连接家用电脑上的原生服务，见下文。

### 云服务器 / Termux 连接家用电脑

```text
云服务器或 Termux：SillyTavern + 插件
        │  Tailscale / VPN / HTTPS
        ▼
家用电脑：原生服务 + 网易云桌面客户端
```

在云端或 Termux 的 `config.json` 中设置：

```json
{
  "enableTogetherListen": true,
  "user_netease_id": "接收邀请的网易云数字用户ID",
  "togetherNative": {
    "autoStart": false,
    "remoteUrl": "http://100.x.y.z:3472",
    "remoteToken": "与家用电脑服务相同的 Token"
  }
}
```

在家用电脑的 `plugins/netease-music-companion-native/together-native` 目录启动服务（PowerShell 示例，macOS / Linux 用 `export` 设置同名变量）：

```powershell
$env:NETEASE_NATIVE_SERVICE_COOKIE = "MUSIC_U=你的值; __csrf=你的值"
$env:NETEASE_NATIVE_SERVICE_RECEIVER_ID = "接收方数字用户ID"
$env:NETEASE_NATIVE_SERVICE_CLIENT_PATH = "D:\CloudMusic\cloudmusic.exe"
$env:NETEASE_NATIVE_SERVICE_API_BASE = "http://127.0.0.1:3000"
$env:NETEASE_NATIVE_SERVICE_HOST = "0.0.0.0"
$env:NETEASE_NATIVE_SERVICE_PORT = "3472"
$env:NETEASE_NATIVE_SERVICE_TOKEN = "至少32字节的随机Token"
$env:NETEASE_NATIVE_SERVICE_CDP_PORT = "9222"
python -B service.py
```

看到 `listening on http://0.0.0.0:3472` 即启动成功，可用 `http://127.0.0.1:3472/health` 检查。除 `/health` 外的接口都需要 `Authorization: Bearer <Token>`。

连接方式：

- **Tailscale（推荐）**：两端登录同一个 tailnet，用 `tailscale ip -4` 查看家用电脑的 `100.x.y.z` 地址，这个网段允许使用 HTTP。
- **HTTPS 反向代理**：服务只监听 `127.0.0.1:3472`，由反向代理或隧道对外提供 HTTPS，`remoteUrl` 填 `https://...`。

插件账号、服务 Cookie 和桌面客户端必须是同一个网易云账号。多账号时每个账号单独运行一个服务实例（不同端口和 Token），切换账号时同步修改 `remoteUrl` 和 `remoteToken`。一个桌面客户端不能同时维持多个账号的房间。

## 更新与卸载

更新：

```bash
cd SillyTavern-Netease-Music-Companion-Native
git pull
```

然后重新运行安装脚本，重启 SillyTavern 并强制刷新浏览器，`config.json` 会保留。

卸载：删除以下两个目录，再在 SillyTavern 中移除扩展。

```text
SillyTavern/plugins/netease-music-companion-native
SillyTavern/public/scripts/extensions/third-party/netease-music-companion-native
```

## 安全说明

- `config.json` 包含网易云登录凭据和 API Key，不要上传或分享。
- 前端不会收到 Cookie、副 API Key 或远程 Token。
- 本地原生服务默认只监听 `127.0.0.1`，远程服务要求 Bearer Token，公网必须 HTTPS。
- 不要把 `3000`（API）、`9222`（CDP）或无 TLS 的 `3472` 暴露到公网。
- 日志不会记录 Cookie、私密房间 ID 或完整邀请链接。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 插件没出现 | 前端目录是否为 `third-party/netease-music-companion-native`，含 `manifest.json` 和 `index.js`；重启并强制刷新浏览器 |
| 后端 404 | `config.yaml` 中 `enableServerPlugins: true`；后端位于 `plugins/netease-music-companion-native` |
| 更新后界面没变 | 完全重启 SillyTavern，再强制刷新浏览器（Ctrl+F5） |
| API 连接失败 | `http://127.0.0.1:3000` 能否访问；`neteaseApi.autoStart` 是否为 `true`；受管运行时缺失时重新运行安装器 |
| 二维码过期 | 重新点击「扫码登录」 |
| 没有歌词翻译 | 中文歌曲本身没有翻译；外语歌确认「翻译」已开启 |
| 悬浮歌词看不到按钮 | 这是透明模式，点一下歌词即可展开 |
| 悬浮歌词跑出屏幕 | 点开后双击工具栏恢复默认位置 |
| 歌曲无法播放 | 可能是会员、下架或无版权歌曲；浏览器阻止自动播放时手动点播放 |
| Python 服务未启动 | `python3 --version`；在 `pythonPath` 填完整路径；检查 `3472` 是否被占用 |
| 创建房间超时 | 客户端是否已登录同一账号；完全退出后重开客户端；检查 `9222` |
| 有房间但无分享链接 | 让桌面客户端先播放一首歌，再重新创建 |
| 刷新当前歌曲失败 | API 与桌面客户端是否运行；提示会分别列出原生服务和本地逆向的错误 |
| 远程服务连不上 | 检查 `remoteUrl`、`remoteToken`、防火墙，访问 `/health`；公网必须 HTTPS |
| 手机打不开 | 同一网络、防火墙放行 `8000`、SillyTavern 监听网络；不要用 `127.0.0.1` |

## 开发

```bash
npm test
npm run check
python3 -m py_compile plugin/together-native/service.py
```

更新记录见 [CHANGELOG.md](CHANGELOG.md)，架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可

本项目采用 [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/) 许可证。

- ✅ 允许：个人使用、学习、研究、公益等非商业用途
- ❌ 禁止：任何形式的商业使用，包括但不限于销售、付费服务、商业产品集成