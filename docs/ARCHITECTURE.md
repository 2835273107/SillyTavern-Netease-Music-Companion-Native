# Architecture

## Runtime

```text
SillyTavern
├─ frontend extension: netease-music-companion-native
└─ server plugin: netease-music-native
   ├─ multi-account store and QR login
   ├─ NeteaseCloudMusicApi adapter
   ├─ local-reverse Listen Together routes
   └─ TogetherBridge
      ├─ spawn together-native/service.py
      └─ or call a configured remote native service
```

The frontend calls only `/api/plugins/netease-music-native`.

## Native service

`plugin/together-native/service.py` is bundled with this repository. It uses
only the Python standard library and exposes:

- `GET /health`
- `GET /v1/status`
- `GET /v1/current`
- `POST /v1/rooms/create`
- `POST /v1/rooms/close`

For local use, the Node plugin generates a random Bearer token and spawns the
service. For remote use, the operator starts the service separately and gives
the plugin its URL and token.

The service controls the official desktop client through its loopback CDP
endpoint. Room creation first uses the configured NeteaseCloudMusicApi to get
the server-side `roomInfo`, then activates that room in the official client.
The service verifies that the Cookie account, desktop-client account and plugin
account are consistent before reporting success.

## Isolation from v1

| Resource | v1 | native |
| --- | --- | --- |
| Backend ID | `netease-music` | `netease-music-native` |
| Frontend folder | `netease-music-companion` | `netease-music-companion-native` |
| Backend folder | `netease-music-companion` | `netease-music-companion-native` |
| Settings object | `neteaseMusicCompanion` | `neteaseMusicCompanionNative` |
| DOM prefix | `nmc` | `nmcnative` |
| Environment prefix | `NETEASE_` | `NETEASE_NATIVE_` |
| Default native port | `3456` | `3472` |

## Lifecycle

- `autoStart: true` starts the local service during plugin initialization.
- Switching the active account stops the local service.
- `SIGINT` and `SIGTERM` stop locally spawned service processes.
- Remote services are managed by their operator and are not terminated by
  SillyTavern.
- Native-service failures return a scoped error and do not block QR login,
  playlists, character generation or the local-reverse route.
