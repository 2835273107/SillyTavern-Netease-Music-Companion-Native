# Changelog

## 1.4.0

- Changed song comments to be generated and published in the character's voice.
- Added continuous queue playback and automatic next-song advancement.
- Added optional character-driven next-song selection.
- Added an opt-in SillyTavern function-tool toggle with tools for search,
  playback, room control, room additions, comments and state queries.
- Added manual previous/next controls and removed the manual comment editor.

## 1.3.0

- Added account playlist selection and track loading to the in-SillyTavern
  player.
- Added playlist-backed playback alongside song search.
- Added a persistent four-tab interface for Player, Listen Together, Playlist
  Management and Account.
- Added mobile two-column tab sizing and more compact sub-sections.
- Added playlist track and UI metadata regression checks.

## 1.2.0

- Added the official desktop client's live room playlist to the plugin.
- Added room song selection, add-to-room and play/previous/pause/next controls.
- Added song-comment reading and publishing.
- Added native service room playlist, add, play and control endpoints.
- Documented shared room playlist, song switching, comments and the
  participant requirement for synchronized playback.

## 1.1.0

- Added an in-SillyTavern music player with same-origin audio proxying and
  HTTP Range support.
- Added timed LRC lyric parsing, translation display, active-line tracking and
  click-to-seek behavior.
- Added song search and direct playback of the current Listen Together song.
- Added a Listen Together message box that sends through the official NetEase
  private-message endpoint to the configured room partner.
- Added backend tests for the new routes and synchronized desktop/mobile usage
  documentation.

## 1.0.1

- Create the server-side room through the configured NeteaseCloudMusicApi,
  then activate the returned `roomInfo` in the official desktop client.
- Replace the unstable Redux room-creation dispatch with the client's room
  activation method and invite-modal override.
- Correct stale-room cleanup to use `/api/listen/together/end/v2`.
- Wait for the desktop client's leave callback and reset the client when stale
  room state remains.
- Verified room creation, heartbeat, share URL, native invitation and close
  against the real Windows desktop client.

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
