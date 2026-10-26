# SillyTavern Netease Music Companion Native

Netease Music Companion Native 是面向 SillyTavern 的网易云音乐插件，提供：

- 多账号与扫码登录
- 角色歌单生成
- 现有歌单读取和目标歌单管理
- 新建歌单
- 添加歌曲到当前歌单
- 网易云原生「一起听」创建、邀请、心跳和关闭
- 当前播放歌曲查询
- 酒馆内音乐播放器
- 播放进度同步歌词
- 搜索歌曲并在酒馆中播放
- 从账号歌单选择并播放歌曲
- 向一起听伙伴发送文字消息
- 读取共享房间歌单并主动选歌、切歌
- 读取和发布网易云歌曲评论
- 手机浏览器访问
- Termux 本机访问
- 云服务器 SillyTavern 远程调用家用电脑原生服务

插件后端包含自己的 `together-native/service.py`。原生一起听服务会组合使用本地 NeteaseCloudMusicApi 和网易云桌面客户端，不需要安装其他 MCP 项目。

> 本项目是非官方第三方插件，与网易云音乐和 SillyTavern 官方均无隶属或背书关系。

## 目录

- [运行结构](#运行结构)
- [环境要求](#环境要求)
- [电脑端安装](#电脑端安装)
- [电脑端配置](#电脑端配置)
- [首次登录](#首次登录)
- [歌单功能](#歌单功能)
- [酒馆播放器与歌词](#酒馆播放器与歌词)
- [歌曲评论](#歌曲评论)
- [电脑端一起听](#电脑端一起听)
- [手机端使用](#手机端使用)
- [Termux 使用](#termux-使用)
- [云服务器 SillyTavern](#云服务器-sillytavern)
- [家用电脑作为原生服务主机](#家用电脑作为原生服务主机)
- [Tailscale 连接方式](#tailscale-连接方式)
- [HTTPS 反向代理连接方式](#https-反向代理连接方式)
- [多账号](#多账号)
- [更新与卸载](#更新与卸载)
- [安全说明](#安全说明)
- [故障排查](#故障排查)
- [开发检查](#开发检查)

## 运行结构

```text
浏览器 / 手机 / 云服务器
          │
          ▼
SillyTavern :8000
├─ 前端扩展
└─ 服务端插件
   ├─ 账号与扫码
   ├─ 歌单与角色生成
   └─ 原生一起听服务
      ├─ NeteaseCloudMusicApi :3000
      └─ 网易云桌面客户端
         └─ CDP :9222，仅本机
```

原生服务需要同时访问：

- NeteaseCloudMusicApi
- 网易云桌面客户端
- 桌面客户端的本机 CDP 端口

因此原生服务必须运行在安装了网易云桌面客户端的 Windows 或 macOS 电脑上。

## 环境要求

### 所有部署方式

- SillyTavern `1.19.0` 或兼容版本
- Node.js `20+`
- 支持 Chat Completion 的主模型连接
- 本地或可访问的 NeteaseCloudMusicApi

### 原生一起听服务

- Python `3.9+`
- Windows 或 macOS 网易云官方桌面客户端
- 桌面客户端已登录网易云账号
- 客户端可通过 CDP 启动

### 手机端

手机不需要 Node.js、Python 或桌面客户端也能打开浏览器页面。

手机网易云 App 用于：

- 扫码登录
- 接受一起听邀请
- 播放音乐

云端或插件的原生服务不能代替用户点击手机 App 内的播放按钮。

## 电脑端安装

### 1. 启动 NeteaseCloudMusicApi

准备一个 NeteaseCloudMusicApi 项目，并确认默认监听：

```text
http://localhost:3000
```

Windows PowerShell：

```powershell
cd "D:\path\to\NeteaseCloudMusicApi"
npm install
node app.js
```

macOS / Linux：

```bash
cd /path/to/NeteaseCloudMusicApi
npm install
node app.js
```

浏览器打开 `http://localhost:3000` 能访问即表示启动成功。

如果 API 不在默认地址，稍后在插件配置中修改 `api_base`。

### 2. 克隆插件

```bash
git clone https://github.com/2835273107/SillyTavern-Netease-Music-Companion-Native.git
cd SillyTavern-Netease-Music-Companion-Native
```

### 3. 一键安装

Windows：

```powershell
pwsh -ExecutionPolicy Bypass -File .\install.ps1 -SillyTavernPath "D:\SillyTavern"
```

macOS / Linux：

```bash
chmod +x install.sh
./install.sh /path/to/SillyTavern
```

安装位置：

```text
SillyTavern/
├─ public/scripts/extensions/third-party/
│  └─ netease-music-companion-native/
└─ plugins/
   └─ netease-music-companion-native/
      ├─ index.js
      ├─ together-bridge.js
      ├─ config.example.json
      └─ together-native/
         └─ service.py
```

安装器会从 `config.example.json` 创建 `config.json`，已有配置不会被覆盖。

### 4. 启用 SillyTavern 服务端插件

在 SillyTavern 的 `config.yaml` 中确认：

```yaml
enableServerPlugins: true
```

重启 SillyTavern。

### 5. 打开插件

进入：

```text
SillyTavern → 扩展程序 → Netease Music Companion Native
```

默认后端地址：

```text
/api/plugins/netease-music-native
```

## 电脑端配置

后端配置文件：

```text
SillyTavern/plugins/netease-music-companion-native/config.json
```

基础示例：

```json
{
  "api_base": "http://localhost:3000",
  "accounts": {
    "default": {
      "music_u": "",
      "csrf": "",
      "label": "默认角色账号",
      "nickname": "",
      "userId": "",
      "currentPlaylist": {
        "id": "",
        "name": ""
      }
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

### 字段说明

| 字段 | 说明 |
| --- | --- |
| `api_base` | NeteaseCloudMusicApi 地址 |
| `user_netease_id` | 接收原生一起听邀请的数字用户 ID |
| `enableTogetherListen` | 是否启用一起听 |
| `autoStart` | SillyTavern 启动时是否自动运行本地原生服务 |
| `pythonPath` | Python 可执行文件；留空时使用 `python` 或 `python3` |
| `appPath` | 网易云客户端路径；留空时自动探测常见位置 |
| `debugPort` | 桌面客户端 CDP 端口，默认 `9222` |
| `port` | 本地原生服务端口，默认 `3472` |
| `remoteUrl` | 远程原生服务地址；填写后不启动本地服务 |
| `remoteToken` | 远程原生服务 Bearer Token |

### 指定 Python

如果系统找不到 Python，在配置中写完整路径。

Windows 示例：

```json
{
  "pythonPath": "C:\\Python312\\python.exe"
}
```

macOS 示例：

```json
{
  "pythonPath": "/opt/homebrew/bin/python3"
}
```

### 指定网易云客户端

Windows 示例：

```json
{
  "appPath": "D:\\CloudMusic\\cloudmusic.exe"
}
```

macOS 通常不需要设置。

### 自动启动

测试成功后可以把：

```json
{
  "autoStart": true
}
```

设为 `true`。这样 SillyTavern 启动时会同时启动本地原生服务。

即使 `autoStart=false`，在面板选择“独立原生服务”时也会按需启动。

## 首次登录

1. 打开插件面板。
2. 使用默认账号，或点击“+ 添加账号”。
3. 点击“扫码登录”。
4. 使用网易云 App 扫码。
5. 登录成功后点击“检查登录状态”。
6. 确认账号昵称和当前账号显示正确。

扫码结果会保存到后端 `config.json`。浏览器不会读取 Cookie 原文。

## 歌单功能

### 选择目标歌单

1. 点击“刷新歌单列表”。
2. 从下拉框选择目标歌单。
3. 点击“使用选中歌单”。

只读歌单不会修改网易云数据。

### 新建歌单

点击“新建歌单”后：

1. 角色根据当前人设生成歌单名和搜索词。
2. 插件搜索候选歌曲。
3. 角色从候选中选择歌曲并给出理由。
4. 创建新歌单。
5. 添加歌曲。
6. 将新歌单设为当前目标歌单。

### 添加歌曲到当前歌单

点击“添加歌曲到当前歌单”后：

1. 使用当前选中的目标歌单。
2. 角色搜索并选择新歌曲。
3. 只添加歌曲。
4. 不新建歌单，不改变当前目标。

候选歌曲只来自本次搜索。搜索结果不合适时不会从已有歌单中补歌。

## 酒馆播放器与歌词

插件内置浏览器播放器，可以：

- 搜索网易云歌曲
- 在 SillyTavern 页面中播放歌曲
- 播放一起听当前歌曲
- 显示 LRC 歌词和翻译
- 根据播放进度高亮当前歌词
- 点击歌词跳转到对应时间

### 搜索并播放

1. 在“酒馆播放器”中输入歌曲、歌手或关键词。
2. 点击“搜索”。
3. 从搜索结果中选择歌曲。
4. 点击“播放选中歌曲”。

音频通过插件后端代理，不会把网易云临时音频地址直接交给浏览器。

### 从账号歌单播放

1. 打开“播放器”分页。
2. 在“选择歌单”中选中账号歌单。
3. 点击“加载歌单歌曲”。
4. 在“歌单歌曲”中选择歌曲。
5. 点击“播放选中歌单歌曲”。

播放器会一次加载最多 500 首歌曲供选择。

### 分页界面

插件内部使用四个分页：

- 播放器
- 一起听
- 歌单管理
- 账号

外层面板仍然可以折叠，内部当前分页会被记住。手机窄屏下分页按钮自动切换为两列。

代理支持 HTTP Range，因此可以：

- 拖动播放进度
- 分段加载
- 在播放过程中继续读取后续音频

### 播放一起听当前歌曲

1. 进入一起听房间。
2. 点击“刷新当前歌曲”，或直接使用播放器中的“播放一起听当前歌曲”。
3. 插件会读取一起听当前歌曲 ID并开始播放。

### 歌词

歌词来源为网易云 `/lyric` 接口。

播放器会：

- 解析 `[mm:ss.xxx]` 时间标签
- 合并翻译歌词
- 自动滚动到当前行
- 在当前浏览器标签中播放

点击任意歌词行可以跳转到该时间。

### 播放限制

- 会员歌曲、已下架歌曲或当前账号无权播放的歌曲可能没有可用音频地址。
- 浏览器可能阻止自动播放，此时点击播放器自身的播放按钮即可。
- 手机浏览器受 iOS/Android 自动播放策略影响。
- 酒馆播放器和网易云 App 的播放状态不是同一个播放器实例。
- 酒馆播放器不会替换桌面客户端的一起听同步状态。

## 歌曲评论

播放器下方提供歌曲评论区域：

1. 搜索、选择或播放一首歌曲。
2. 点击“读取歌曲评论”。
3. 输入不超过 140 字的评论。
4. 点击“发布评论”。

评论操作使用当前活动网易云账号。发布评论属于公开外部写入，请确认内容后再发送。

## 电脑端一起听

### 前置条件

- `enableTogetherListen: true`
- 已填写 `user_netease_id`
- 插件当前账号已登录
- NeteaseCloudMusicApi 已启动
- Python 可用
- 网易云桌面客户端已登录同一账号

### 创建房间

1. 打开“一起听”。
2. 创建方式选择“独立原生服务”。
3. 点击“创建房间”。
4. 等待状态显示服务已连接。
5. 创建成功后页面会显示房间和邀请链接。

原生服务执行流程：

1. 通过 NeteaseCloudMusicApi 创建服务端房间。
2. 读取服务端返回的完整 `roomInfo`。
3. 将 `roomInfo` 交给网易云桌面客户端激活。
4. 等待客户端进入活跃房间状态。
5. 启动客户端心跳。
6. 向 `user_netease_id` 发送原生邀请。
7. 返回房间 ID、当前歌曲和分享链接。

### 客户端 CDP

Windows 客户端可能被服务以调试参数重启：

```text
--remote-debugging-port=9222
--remote-allow-origins=*
```

CDP 只应监听本机，不要开放到公网。

### 当前歌曲

点击“刷新当前歌曲”后，插件会读取：

- 歌曲名
- 歌手
- 专辑
- 播放进度
- 播放状态
- 封面

### 共享房间歌单

点击“刷新房间歌单”后，插件从网易云桌面客户端的官方房间状态读取歌单。

房间歌单区域支持：

- 查看全部房间歌曲
- 选择房间歌曲并播放
- 上一首
- 暂停或继续
- 下一首
- 将播放器中选中的歌曲添加到房间歌单

房间歌单由官方桌面客户端维护。仅创建房间、没有第二位参与者时，客户端可能不会立即执行切歌；需要伙伴进入房间后才能完成同步播放。

添加歌曲时，如果歌曲在网易云侧不可用于一起听，客户端会拒绝添加或跳过播放。

### 一起听消息

一起听区域提供文字消息输入框。

发送流程：

1. 在输入框中填写消息。
2. 点击“发送消息”，或在输入框中按 Enter。
3. 插件通过当前网易云账号发送私信。
4. 收件人使用 `config.json` 中的 `user_netease_id`。

> 当前 Windows 网易云桌面客户端没有公开可调用的房间聊天发送接口。因此该功能通过网易云私信发送给一起听伙伴，不是直接写入原生房间聊天。

已发送消息会显示在插件本地消息记录中。该记录不会从网易云同步历史消息。

### 心脏与保活

活跃房间由官方桌面客户端维持连接和心跳。服务会确认客户端处于活跃房间状态后才报告创建成功。

### 关闭房间

点击“离开房间”：

1. 服务调用桌面客户端离开房间。
2. 等待客户端 leave 回调。
3. 清理可能残留的服务端房间。
4. 必要时重启桌面客户端，清除内存中的旧房间和心跳状态。

关闭后重新打开网易云客户端属于正常兜底行为。

## 手机端使用

手机端不需要单独安装前端 App。手机上使用浏览器访问 SillyTavern。

### 同一 Wi-Fi 访问电脑

1. 电脑上的 SillyTavern 已启动并监听网络。
2. 电脑防火墙允许 `8000` 端口。
3. 手机与电脑连接同一个 Wi-Fi。
4. 手机浏览器打开：

```text
http://电脑局域网IP:8000/
```

5. 进入“扩展程序”，打开 Netease Music Companion Native。

手机访问电脑时，原生服务继续运行在电脑上。

### 手机接受邀请

1. 在插件中填写手机网易云账号的数字用户 ID。
2. 点击“创建房间”。
3. 手机会收到网易云原生邀请。
4. 在手机网易云 App 中接受邀请。
5. 在手机 App 内播放歌曲。

### 手机添加到主屏幕

- iPhone / iPad：Safari → 分享 → 添加到主屏幕
- Android：浏览器菜单 → 安装网页应用 / 添加到主屏幕

这只是网页快捷方式，不是独立移动 App。

### 手机端限制

- 手机网易云 App 的播放按钮只能由手机上的 App 操作。
- 云端服务不能绕过 Android 或 iOS 权限直接控制手机 App。
- 二维码、歌单、账号和接受邀请可以在手机浏览器完成。
- 原生房间创建需要运行桌面客户端的电脑。

## Termux 使用

Termux 可以运行 SillyTavern 前端和后端，但不能在本机启动受控的原生一起听服务，因为 Android 手机上没有可用的网易云 Windows/macOS 桌面客户端 CDP。

### 安装

```bash
pkg update
pkg install -y git nodejs python

git clone https://github.com/2835273107/SillyTavern-Netease-Music-Companion-Native.git \
  "$HOME/SillyTavern-Netease-Music-Companion-Native"

cd "$HOME/SillyTavern-Netease-Music-Companion-Native"
chmod +x install.sh
./install.sh "$HOME/SillyTavern"
```

### 保持 Termux 运行

```bash
termux-wake-lock
```

然后启动 SillyTavern：

```bash
cd "$HOME/SillyTavern"
node server.js
```

手机浏览器打开：

```text
http://127.0.0.1:8000/
```

### Termux 配置远程服务

编辑：

```text
$HOME/SillyTavern/plugins/netease-music-companion-native/config.json
```

设置：

```json
{
  "enableTogetherListen": true,
  "user_netease_id": "接收邀请的网易云数字用户ID",
  "togetherNative": {
    "autoStart": false,
    "remoteUrl": "http://电脑私有地址:3472",
    "remoteToken": "与家用电脑服务相同的 Token"
  }
}
```

Termux 上的 SillyTavern 会请求家用电脑的原生服务，不启动手机本地 Python 一起听进程。

## 云服务器 SillyTavern

适合以下结构：

```text
云服务器：SillyTavern
    │
    │ Tailscale / VPN / HTTPS
    ▼
家用电脑：原生服务 + 网易云桌面客户端
```

云服务器负责：

- 前端页面
- 插件后端
- 账号和歌单
- 角色生成

家用电脑负责：

- 网易云桌面客户端
- CDP
- 原生房间创建
- 心跳和客户端控制

### 云端安装

```bash
git clone https://github.com/2835273107/SillyTavern-Netease-Music-Companion-Native.git
cd SillyTavern-Netease-Music-Companion-Native
chmod +x install.sh
./install.sh /path/to/SillyTavern
```

### 云端配置

```json
{
  "api_base": "http://127.0.0.1:3000",
  "activeAccountId": "default",
  "user_netease_id": "接收邀请的网易云数字用户ID",
  "enableTogetherListen": true,
  "togetherNative": {
    "autoStart": false,
    "remoteUrl": "http://100.x.y.z:3472",
    "remoteToken": "与家用电脑服务相同的 Token"
  }
}
```

云端 `api_base` 指向云端自己的 NeteaseCloudMusicApi。

家用电脑服务另有自己的：

- `NETEASE_NATIVE_SERVICE_API_BASE`
- `NETEASE_NATIVE_SERVICE_COOKIE`

两边账号必须一致。

### 云端安全

- SillyTavern 应通过 HTTPS 或可信私有网络访问。
- 不要将 NeteaseCloudMusicApi `3000` 暴露公网。
- 不要将 CDP `9222` 暴露公网。
- 原生服务 Token 必须使用强随机值。
- 公网 `remoteUrl` 必须使用 HTTPS。

## 家用电脑作为原生服务主机

### 1. 启动 NeteaseCloudMusicApi

家用电脑需要：

```text
http://127.0.0.1:3000
```

### 2. 打开原生服务目录

```text
SillyTavern/plugins/netease-music-companion-native/together-native
```

### 3. 设置环境变量

Windows PowerShell：

```powershell
$env:NETEASE_NATIVE_SERVICE_COOKIE = "MUSIC_U=你的值; __csrf=你的值"
$env:NETEASE_NATIVE_SERVICE_RECEIVER_ID = "接收方数字用户ID"
$env:NETEASE_NATIVE_SERVICE_CLIENT_PATH = "D:\CloudMusic\cloudmusic.exe"
$env:NETEASE_NATIVE_SERVICE_API_BASE = "http://127.0.0.1:3000"
$env:NETEASE_NATIVE_SERVICE_HOST = "0.0.0.0"
$env:NETEASE_NATIVE_SERVICE_PORT = "3472"
$env:NETEASE_NATIVE_SERVICE_TOKEN = "至少32字节的随机Token"
$env:NETEASE_NATIVE_SERVICE_CDP_PORT = "9222"
```

macOS / Linux 示例：

```bash
export NETEASE_NATIVE_SERVICE_COOKIE='MUSIC_U=你的值; __csrf=你的值'
export NETEASE_NATIVE_SERVICE_RECEIVER_ID='接收方数字用户ID'
export NETEASE_NATIVE_SERVICE_API_BASE='http://127.0.0.1:3000'
export NETEASE_NATIVE_SERVICE_HOST='0.0.0.0'
export NETEASE_NATIVE_SERVICE_PORT='3472'
export NETEASE_NATIVE_SERVICE_TOKEN='至少32字节的随机Token'
export NETEASE_NATIVE_SERVICE_CDP_PORT='9222'
```

macOS 客户端路径通常自动探测。

### 4. 启动服务

```bash
python3 -B service.py
```

如果使用虚拟环境或指定 Python：

```bash
/absolute/path/to/python -B service.py
```

看到以下内容表示服务已监听：

```text
[netease-companion-native] listening on http://0.0.0.0:3472
```

### 5. 健康检查

```text
http://127.0.0.1:3472/health
```

`/health` 不需要 Token；其他接口都需要：

```text
Authorization: Bearer <NETEASE_NATIVE_SERVICE_TOKEN>
```

## Tailscale 连接方式

推荐手机、Termux 或云服务器使用 Tailscale 连接家用电脑。

### 安装

在家用电脑和客户端设备上安装 Tailscale，并登录同一个 tailnet。

### 查看家用电脑地址

```bash
tailscale ip -4
```

通常类似：

```text
100.x.y.z
```

### 家用电脑监听

可使用：

```text
NETEASE_NATIVE_SERVICE_HOST=0.0.0.0
```

并用 Windows 防火墙限制到 Tailscale 网络。

### 云端或 Termux 配置

```json
{
  "remoteUrl": "http://100.x.y.z:3472"
}
```

HTTP 允许 Tailscale `100.64.0.0/10` 地址。

## HTTPS 反向代理连接方式

如果无法使用 Tailscale，可在公网使用 HTTPS 反向代理或受控隧道。

推荐：

```text
互联网
  │ HTTPS
  ▼
反向代理 / 隧道
  │ HTTP，仅本机
  ▼
NETEASE_NATIVE_SERVICE_HOST=127.0.0.1
NETEASE_NATIVE_SERVICE_PORT=3472
```

插件配置：

```json
{
  "remoteUrl": "https://music-service.example.com"
}
```

要求：

- 必须使用 HTTPS
- 必须保留 Bearer Token
- 反向代理应配置访问日志脱敏
- 不要把 `3472` 无 TLS 直接暴露
- 不要把 `3000` 或 `9222` 暴露

## 多账号

每个原生服务实例对应一个：

- 网易云 Cookie
- 桌面客户端账号
- 服务端口
- Bearer Token

多账号示例：

| 账号 | 端口 | Token | remoteUrl |
| --- | --- | --- | --- |
| 账号 A | `3472` | Token A | `http://host:3472` |
| 账号 B | `3473` | Token B | `http://host:3473` |

切换账号时，需要让 `remoteUrl` 和 `remoteToken` 对应到同一账号实例。

一个桌面客户端不能同时维持多个账号的原生房间。

## 更新与卸载

### 更新

```bash
cd SillyTavern-Netease-Music-Companion-Native
git pull
```

然后重新运行安装脚本。`config.json` 会保留。

Windows：

```powershell
pwsh -ExecutionPolicy Bypass -File .\install.ps1 -SillyTavernPath "D:\SillyTavern"
```

macOS / Linux：

```bash
./install.sh /path/to/SillyTavern
```

重启 SillyTavern。

### 卸载

删除：

```text
SillyTavern/plugins/netease-music-companion-native
SillyTavern/public/scripts/extensions/third-party/netease-music-companion-native
```

然后在 SillyTavern 设置中移除对应扩展。

## 安全说明

- `config.json` 包含网易云登录凭据，不要上传或分享。
- Token 只保存在后端配置中。
- 前端不会收到 Cookie 或远程 Token。
- 本地原生服务默认只监听 `127.0.0.1`。
- 远程服务除 `/health` 外都要求 Bearer Token。
- 公网连接必须 HTTPS。
- CDP 只接受本机 WebSocket。
- 服务不会在日志中记录 Cookie、私密房间 ID 或完整邀请链接。
- 离开房间时可能重启网易云客户端以清除残留状态。

## 故障排查

### 插件未出现

- 确认前端位于 `netease-music-companion-native`。
- 确认 `manifest.json` 和 `index.js` 存在。
- 重启 SillyTavern。
- 强制刷新浏览器。

### 后端 404

- 确认后端 ID 是 `netease-music-native`。
- 确认文件位于 `plugins/netease-music-companion-native`。
- 确认 `enableServerPlugins: true`。

### NeteaseCloudMusicApi 连接失败

- 确认 `http://127.0.0.1:3000` 可访问。
- 检查 `api_base`。
- 查看 NeteaseCloudMusicApi 控制台。

### Python 服务未启动

- 执行 `python3 --version`。
- 在 `pythonPath` 中填写完整路径。
- 检查 `together-native/service.py` 是否存在。
- 检查 `3472` 是否被占用。

### 客户端账号不一致

以下三处必须使用同一个网易云账号：

- 插件活动账号
- 服务环境变量中的 Cookie
- 桌面客户端登录账号

### 创建房间超时

- 确认网易云桌面客户端已登录。
- 尝试完全退出并重新打开客户端。
- 检查 `9222` 是否为本机 CDP 端口。
- 检查 Python 服务是否能读取客户端状态。

### 有房间但没有分享链接

- 原生服务需要房间 ID、创建者 ID 和当前歌曲 ID。
- 先确认桌面客户端正在播放歌曲。
- 重新创建房间。

### 关闭房间后客户端重启

这是清理旧房间和心跳状态的兜底机制，属于正常行为。

### 远程服务无法连接

- 检查 `remoteUrl` 和 `remoteToken`。
- 检查家用电脑防火墙。
- 尝试访问 `/health`。
- Tailscale 地址应以 `100.` 开头。
- 公网必须使用 HTTPS。

### 手机无法访问电脑

- 确认手机与电脑在同一网络。
- 检查电脑防火墙是否允许 `8000`。
- 确认 SillyTavern 监听网络接口。
- 不要使用电脑上的 `127.0.0.1` 作为手机访问地址。

## 开发检查

```bash
npm test
npm run check
python3 -m py_compile plugin/together-native/service.py
```

## 许可

本项目使用 MIT License。
