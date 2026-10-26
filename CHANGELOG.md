# Changelog

## 1.0.0

- Introduced a standalone SillyTavern plugin namespace: backend ID
  `netease-music-native`, frontend folder `netease-music-companion-native`,
  settings key `neteaseMusicCompanionNative` and DOM prefix `nmcnative`.
- Bundled `together-native/service.py`, a standard-library-only service for
  Windows and macOS client integration.
- Added native room creation, invitation, heartbeat inspection, current-song
  reading and room leave.
- Removed all third-party MCP downloads and stdio fallback paths.
- Added Bearer authentication, loopback-only CDP validation, account matching
  and remote HTTPS/private-network rules.
- Added migration from the original plugin while dropping obsolete external
  POC paths.
- Added GitHub Actions and automated service, security and migration tests.
