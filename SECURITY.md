# Security

## Secrets

- Never commit `config.json`, `.env`, NetEase cookies, service tokens, QR
  screenshots, private room IDs or private invitation URLs.
- `config.json` is ignored by Git and written with owner-only permissions where
  supported.
- API responses do not expose `MUSIC_U`, `__csrf` or the remote service token.
- Service errors redact values that resemble NetEase credential fields.

## Native service

- Local service instances bind to `127.0.0.1` by default.
- Every route except `/health` requires a Bearer token.
- Both the plugin and the service reject unavailable or malformed secrets.
- The service accepts debugger WebSocket URLs only on loopback.
- Remote public endpoints must use HTTPS. Plain HTTP is allowed only for
  loopback, private LAN, link-local, IPv6 ULA and Tailscale CGNAT addresses.
- Do not expose NeteaseCloudMusicApi port `3000` or client CDP port `9222`.

The service token permits control of the configured NetEase desktop account.
Treat it as a password and rotate it after disclosure.

## Reporting

Use a private GitHub security advisory. Remove credentials and private invite
links from reports and logs.
