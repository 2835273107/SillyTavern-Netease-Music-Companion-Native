# Changelog

## 1.11.1

- Made target-playlist selection apply immediately when a playlist row is
  clicked.
- Removed the redundant “Use selected playlist” confirmation button.
- Removed the separate playlist-refresh button; the list still loads on plugin
  startup and after account changes.
- Shortened the add-to-playlist action label to reduce crowding on mobile.

## 1.11.0

- Added a persisted private-message option for including or excluding current
  song lyrics and translations. When disabled, lyric lookup is skipped.
- Added target-playlist duplicate prevention using both song IDs and normalized
  title/artist identity keys.
- Passed a bounded list of existing playlist songs to the character and
  explicitly prohibited selecting or commenting on those songs again.
- Added per-account session guards against publishing multiple comments for the
  same song.
- Combined playlist creation and initial track addition into one frontend
  request and removed the follow-up playlist refresh request.
- Reused lyric snippets returned by candidate search instead of issuing one
  extra lyric request per candidate.

## 1.10.0

- Added managed NeteaseCloudMusicApi installation and automatic process
  lifecycle.
- Starts the local API with SillyTavern, waits for readiness, reuses an existing
  external API and stops only plugin-owned processes on shutdown.
- Supports custom API project paths while defaulting to the bundled npm runtime.
- Exposes API management state to the frontend status line.

## 1.9.2

- Read the desktop client's actual `curPlaying` song before waiting for the
  potentially stale room play command.
- Kept native song polling active while the Listen Together tab is open and
  refreshed the room playlist when the current song changes.
- Replaced the Listen Together room-song selector with a filterable song list
  showing the current track.
- Added no-store requests to the native bridge to avoid stale client state.

## 1.9.1

- Added native-client current-song refresh with on-demand native service start
  and local reverse fallback.
- Changed “Refresh current song” into a one-shot action while automatic polling
  continues separately.
- Added four-second private-message polling and periodic contact refresh while
  the reply panel is open.
- Reworked the mobile layout with four-column tabs, two-column action grids,
  larger touch targets and bounded internal scrolling.

## 1.9.0

- Added a shared lyric extractor that reuses loaded LRC data or fetches lyrics
  and translations from NetEase by song ID.
- Included lyrics in song comments, Listen Together replies, standalone song
  messages, recommendation reasons, automatic next-song selection and music
  state tool responses.
- Required song evaluations to use lyric imagery or wording instead of relying
  only on the title and artist.

## 1.8.2

- Added a manual “resend last generated content” button for generated private
  messages that do not appear in NetEase.
- Preserved generated multi-paragraph or song-message content after a failed
  send so it can be retried without regenerating.
- Reused the selected NetEase contact and sent the original content unchanged.

## 1.8.1

- Changed song recommendation reasons to direct `{{char}}`-to-`{{user}}`
  short lines instead of third-person persona analysis.
- Required every generated recommendation to contain both “我” and “你” and
  limited it to 40 Chinese characters.
- Added a deterministic fallback that rewrites analytical or non-direct model
  output into a character-voice recommendation.

## 1.8.0

- Sent the “let the character talk about this song” result directly to the
  selected NetEase private-chat contact.
- Followed the active SillyTavern preset explicitly and removed the 6000
  character cap from character-bound world books.
- Limited private-chat reply segments to 60 Chinese characters, standalone
  song messages to 80 characters and song comments to one 120-character
  paragraph.
- Added generation token caps alongside hard post-generation character limits.

## 1.7.4

- Replaced unreliable back-to-back multi-message delivery with one NetEase
  private message containing all generated paragraphs separated by blank lines.
- Preserved line breaks in outgoing private messages instead of stripping them
  during backend sanitization.
- Kept generated paragraph statuses in the plugin while making the NetEase
  conversation and platform result a single delivered message.

## 1.7.3

- Queued multi-message character replies and added a 2.2-second delivery
  interval so NetEase does not merge consecutive private messages.
- Added per-message waiting, sent and failed states, while keeping successfully
  delivered messages in the local conversation.
- Continued later messages after an individual delivery failure and reports the
  final sent/failed counts.

## 1.7.2

- Replaced user-facing generic "character" labels throughout the extension
  copy with the live `{{char}}` name.
- Changed NetEase private-chat alignment so `{{char}}` appears on the left and
  `{{user}}` appears on the right.
- Refresh character-aware copy, bubbles, contact previews and reply logs after
  character card, chat or group changes.

## 1.7.1

- Mapped private messages sent by the active NetEase account to the current
  SillyTavern character instead of a hard-coded user label.
- Chat bubbles, contact previews, character-reply logs and generation prompts
  now use the live `{{char}}` name.
- Chat labels refresh automatically when switching character cards, chats or
  groups.

## 1.7.0

- Added NetEase private-message contact and conversation-history reading to
  the Listen Together character reply module.
- Decoded nested NetEase message payloads into readable text and displayed
  user/contact chat bubbles.
- Character replies now use the selected NetEase conversation, current song,
  world books and persona.
- Character replies can be generated and sent as one to three consecutive
  private messages.

## 1.6.1

- Replaced the manual Listen Together message form with a character-generated
  private-message reply.
- Character replies now use the current room or player song, the latest chat
  messages, the bound world books and the active character persona.
- Removed the recipient ID from the success message shown in the interface.

## 1.6.0

- Replaced the player playlist and track selectors with searchable playlist and
  track lists.
- Replaced the playlist-management target selector with the same browsable
  playlist list while preserving the hidden compatibility controls.
- Added playlist creator, track count, liked-list marker and selected-track
  states, with bounded internal scrolling on desktop and mobile.

## 1.5.1

- Stopped lyric progress updates from scrolling the SillyTavern page to the
  lyrics panel. Active-line highlighting and click-to-seek remain available.

## 1.5.0

- Included the active character's primary and additional world books in
  background song selection, comments, Listen Together narration and
  conversation-tool generation, with a 6000-character context limit.
- Simplified the player with a playlist/search source switch, inline source
  controls and one focused now-playing area.
- Collapsed comments, playback settings, room playlist, invitations and room
  messages into optional detail panels.
- Added a compact responsive visual refresh for desktop and mobile.

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
