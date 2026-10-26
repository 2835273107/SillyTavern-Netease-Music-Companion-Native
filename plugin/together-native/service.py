#!/usr/bin/env python3
"""Native NetEase Listen Together service for Netease Music Companion Native.

This service owns the desktop-client integration used by the SillyTavern
plugin. It exposes a small authenticated HTTP API to the Node.js backend and
keeps all account credentials and client-debugger access in this process.
"""

from __future__ import annotations

import base64
import hmac
import json
import os
import platform
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


SERVICE_VERSION = "1.1.0"
HOST = os.environ.get("NETEASE_NATIVE_SERVICE_HOST", "127.0.0.1").strip()
PORT = int(os.environ.get("NETEASE_NATIVE_SERVICE_PORT", "3472"))
TOKEN = os.environ.get("NETEASE_NATIVE_SERVICE_TOKEN", "").strip()
COOKIE = os.environ.get("NETEASE_NATIVE_SERVICE_COOKIE", "").strip()
RECEIVER_ID = os.environ.get(
    "NETEASE_NATIVE_SERVICE_RECEIVER_ID",
    "",
).strip()
CDP_PORT = int(os.environ.get("NETEASE_NATIVE_SERVICE_CDP_PORT", "9222"))
CLIENT_OVERRIDE = os.environ.get("NETEASE_NATIVE_SERVICE_CLIENT_PATH", "").strip()
API_BASE = os.environ.get(
    "NETEASE_NATIVE_SERVICE_API_BASE",
    "http://127.0.0.1:3000",
).rstrip("/")

API_ORIGIN = "https://music.163.com"
SHARE_ORIGIN = "https://st.music.163.com/listen-together/share/index.html"

CLIENT_LOCK = threading.RLock()


class ServiceError(RuntimeError):
    """A failure that can be returned safely to the plugin."""


def _json_response(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _redact(value: Any) -> str:
    text = str(value or "")
    for marker in ("MUSIC_U=", "__csrf="):
        while marker in text:
            start = text.index(marker)
            end = text.find(";", start)
            if end < 0:
                end = len(text)
            text = text[:start] + marker + "[redacted]" + text[end:]
    return text[:600]


def _csrf_from_cookie() -> str:
    for item in COOKIE.split(";"):
        name, separator, value = item.strip().partition("=")
        if separator and name == "__csrf":
            return value
    return ""


def _api_request(
    path: str,
    form: dict[str, Any] | None = None,
    *,
    timeout: int = 12,
) -> dict[str, Any]:
    if not COOKIE:
        raise ServiceError("NETEASE_NATIVE_SERVICE_COOKIE is not configured")
    csrf = _csrf_from_cookie()
    url = API_ORIGIN + path
    if csrf:
        url += ("&" if "?" in url else "?") + "csrf_token=" + urllib.parse.quote(csrf)
    body = None
    headers = {
        "Cookie": COOKIE,
        "Referer": API_ORIGIN + "/",
        "User-Agent": "Mozilla/5.0",
    }
    if form is not None:
        payload = dict(form)
        if csrf:
            payload.setdefault("csrf_token", csrf)
        body = urllib.parse.urlencode(payload).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError) as exc:
        raise ServiceError("NetEase API request failed: " + _redact(exc)) from exc


def _local_api_request(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(
        {**payload, "cookie": COOKIE},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        API_BASE + path,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError) as exc:
        raise ServiceError(
            "NeteaseCloudMusicApi request failed: " + _redact(exc)
        ) from exc
    code = result.get("code")
    if code is not None and int(code) != 200:
        raise ServiceError(
            result.get("message")
            or result.get("msg")
            or "NeteaseCloudMusicApi room creation failed"
        )
    return result


def _account_uid() -> str:
    payload = _api_request("/api/nuser/account/get")
    uid = (payload.get("profile") or {}).get("userId")
    uid = uid or (payload.get("account") or {}).get("id")
    return str(uid or "")


def _default_client_path() -> str:
    if sys.platform == "darwin":
        return "/Applications/NeteaseMusic.app"
    if sys.platform == "win32":
        candidates = [
            CLIENT_OVERRIDE,
            Path(r"D:\CloudMusic\cloudmusic.exe"),
            Path(os.environ.get("ProgramFiles", "")) / "Netease" / "CloudMusic" / "cloudmusic.exe",
            Path(os.environ.get("ProgramFiles(x86)", "")) / "Netease" / "CloudMusic" / "cloudmusic.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Netease" / "CloudMusic" / "cloudmusic.exe",
        ]
        for candidate in candidates:
            if candidate and Path(candidate).is_file():
                return str(candidate)
        return str(candidates[1])
    return ""


CLIENT_PATH = CLIENT_OVERRIDE or _default_client_path()


def _client_exists() -> bool:
    return (
        Path(CLIENT_PATH).is_file()
        if sys.platform == "win32"
        else Path(CLIENT_PATH).is_dir()
    )


def _process_running() -> bool:
    if not CLIENT_PATH:
        return False
    if sys.platform == "win32":
        command = [
            "tasklist",
            "/FI",
            f"IMAGENAME eq {Path(CLIENT_PATH).name}",
            "/FO",
            "CSV",
            "/NH",
        ]
    elif sys.platform == "darwin":
        command = ["/usr/bin/pgrep", "-x", Path(CLIENT_PATH).stem]
    else:
        return False
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if result.returncode != 0:
            return False
        if sys.platform == "win32":
            return Path(CLIENT_PATH).name.casefold() in result.stdout.casefold()
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def _debug_target() -> str | None:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{CDP_PORT}/json/list",
            timeout=1.5,
        ) as response:
            targets = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return None
    pages = [
        item for item in targets
        if item.get("type") == "page"
        and (
            item.get("url") == "orpheus://orpheus/app.html"
            or item.get("url") == "orpheus://orpheus/pub/app.html"
        )
    ]
    return pages[0].get("webSocketDebuggerUrl") if pages else None


def _stop_client() -> bool:
    if not _process_running():
        return True
    if sys.platform == "win32":
        command = ["taskkill", "/IM", Path(CLIENT_PATH).name, "/F"]
    elif sys.platform == "darwin":
        command = ["/usr/bin/osascript", "-e", 'tell application "NeteaseMusic" to quit']
    else:
        return False
    try:
        subprocess.run(command, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    for _ in range(60):
        if not _process_running():
            return True
        time.sleep(0.1)
    return False


def _start_debug_client() -> None:
    if not _client_exists():
        raise ServiceError(f"NetEase desktop client was not found at {CLIENT_PATH}")
    if _debug_target():
        return
    if not _stop_client():
        raise ServiceError("The existing NetEase client did not close")
    args = [
        f"--remote-debugging-port={CDP_PORT}",
        "--remote-allow-origins=*",
    ]
    try:
        if sys.platform == "win32":
            subprocess.Popen(
                [CLIENT_PATH, *args],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
        elif sys.platform == "darwin":
            subprocess.run(
                ["/usr/bin/open", "-n", "-a", CLIENT_PATH, "--args", *args],
                capture_output=True,
                timeout=10,
                check=True,
            )
        else:
            raise ServiceError("Native Listen Together requires Windows or macOS")
    except (OSError, subprocess.SubprocessError) as exc:
        raise ServiceError("Could not start the NetEase client: " + _redact(exc)) from exc
    for _ in range(48):
        if _debug_target():
            return
        time.sleep(0.25)
    raise ServiceError("The NetEase client did not expose its local debugger")


class WebSocket:
    def __init__(self, url: str):
        parsed = urllib.parse.urlparse(url)
        if (
            parsed.scheme != "ws"
            or parsed.hostname not in {"127.0.0.1", "localhost"}
            or not parsed.port
        ):
            raise ServiceError("Refusing a non-local debugger endpoint")
        self.socket = socket.create_connection((parsed.hostname, parsed.port), timeout=30)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        handshake = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode("ascii")
        self.socket.sendall(handshake)
        header = b""
        while b"\r\n\r\n" not in header:
            chunk = self.socket.recv(1)
            if not chunk:
                raise ServiceError("Debugger handshake closed unexpectedly")
            header += chunk
        if b" 101 " not in header.split(b"\r\n", 1)[0]:
            raise ServiceError("Debugger WebSocket handshake failed")
        self.next_id = 1
        self.closed = False

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            self._write_frame(0x8, b"")
        except OSError:
            pass
        try:
            self.socket.close()
        except OSError:
            pass

    def _read_exact(self, count: int) -> bytes:
        parts = []
        remaining = count
        while remaining:
            chunk = self.socket.recv(remaining)
            if not chunk:
                raise ServiceError("Debugger connection closed")
            parts.append(chunk)
            remaining -= len(chunk)
        return b"".join(parts)

    def _read_frame(self) -> tuple[bool, int, bytes]:
        first, second = self._read_exact(2)
        final = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        size = second & 0x7F
        if size == 126:
            size = struct.unpack("!H", self._read_exact(2))[0]
        elif size == 127:
            size = struct.unpack("!Q", self._read_exact(8))[0]
        mask = self._read_exact(4) if masked else b""
        payload = self._read_exact(size) if size else b""
        if masked:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        return final, opcode, payload

    def _write_frame(self, opcode: int, payload: bytes) -> None:
        payload = bytes(payload)
        size = len(payload)
        first = 0x80 | opcode
        mask = os.urandom(4)
        if size < 126:
            header = bytes((first, 0x80 | size))
        elif size < 65536:
            header = bytes((first, 0x80 | 126)) + struct.pack("!H", size)
        else:
            header = bytes((first, 0x80 | 127)) + struct.pack("!Q", size)
        encoded = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.socket.sendall(header + mask + encoded)

    def evaluate(self, expression: str, *, await_promise: bool = False) -> Any:
        request_id = self.next_id
        self.next_id += 1
        request = {
            "id": request_id,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
            },
        }
        self._write_frame(0x1, json.dumps(request, separators=(",", ":")).encode("utf-8"))
        fragments: list[bytes] = []
        while True:
            final, opcode, payload = self._read_frame()
            if opcode == 0x9:
                self._write_frame(0xA, payload)
                continue
            if opcode == 0x8:
                raise ServiceError("Debugger connection closed before returning a result")
            if opcode not in {0x0, 0x1}:
                continue
            fragments.append(payload)
            if not final:
                continue
            message = json.loads(b"".join(fragments).decode("utf-8"))
            fragments.clear()
            if message.get("id") != request_id:
                continue
            result = message.get("result") or {}
            exception = result.get("exceptionDetails")
            if exception:
                details = exception.get("exception") or {}
                raise ServiceError(
                    details.get("description")
                    or exception.get("text")
                    or "Client evaluation failed"
                )
            return (result.get("result") or {}).get("value")


def _with_debugger(callback):
    _start_debug_client()
    target = _debug_target()
    if not target:
        raise ServiceError("NetEase debugger is unavailable")
    websocket = WebSocket(target)
    try:
        return callback(websocket)
    finally:
        websocket.close()


BOOTSTRAP = r"""
(() => {
  if (window.__neteaseCompanionRequire) return true;
  if (typeof webpackJsonp === "undefined" || !Array.isArray(webpackJsonp)) return false;
  const marker = "neteaseCompanion" + Date.now();
  webpackJsonp.push([
    [marker],
    { [marker]: function(_module, _exports, require) {
        window.__neteaseCompanionRequire = require;
      }
    },
    [[marker]]
  ]);
  return Boolean(window.__neteaseCompanionRequire);
})()
"""


def _module_ids() -> dict[str, int]:
    if sys.platform == "win32":
        return {"core": 8, "modal": 31, "utility": 75}
    return {"core": 11, "modal": 28, "utility": 58}


def _client_state(websocket: WebSocket) -> dict[str, Any]:
    ids = _module_ids()
    script = r"""
(() => {
  const require = window.__neteaseCompanionRequire;
  const core = require(__CORE__).a;
  const utility = require(__UTILITY__).c;
  const store = core.getStore();
  const roomStore = store["async:listenTogether"] || {};
  const room = roomStore.roomInfo || {};
  const playing = store.playing || {};
  return {
    ready: Boolean(roomStore),
    status: utility.utilStatus,
    heartbeatActive: utility.heartbeatCounting != null,
    roomId: String(room.roomId || ""),
    creatorId: String(room.creatorId || ""),
    hostUid: String((store.host || {}).uid || ""),
    songId: String(
      playing.resourceTrackId
      || (playing.curPlaying || {}).resourceId
      || ""
    )
  };
})()
""".replace("__CORE__", str(ids["core"])).replace(
        "__UTILITY__", str(ids["utility"])
    )
    result = websocket.evaluate(script)
    if not isinstance(result, dict):
        raise ServiceError("Unexpected client state response")
    return result


def _share_url(room_id: str, creator_id: str, song_id: str) -> str:
    if not room_id or not creator_id:
        return ""
    query = urllib.parse.urlencode(
        {
            "roomId": room_id,
            "inviterId": creator_id,
            **({"songId": song_id} if song_id else {}),
        }
    )
    return f"{SHARE_ORIGIN}?{query}"


def _clear_stale_room() -> None:
    try:
        payload = _api_request("/api/listen/together/status/get", {})
        data = payload.get("data") or {}
        room = data.get("roomInfo") or {}
        if data.get("inRoom") and room.get("roomId"):
            _api_request(
                "/api/listen/together/end/v2",
                {
                    "roomId": str(room["roomId"]),
                    "shareInfo": "{}",
                },
            )
    except ServiceError:
        return


def _activate_room_on_client(
    websocket: WebSocket,
    room_info: dict[str, Any],
) -> dict[str, Any]:
    ids = _module_ids()
    script = r"""
(async roomInfo => {
  const require = window.__neteaseCompanionRequire;
  const core = require(__CORE__).a;
  const utility = require(__UTILITY__).c;
  const modal = require(__MODAL__).default;
  const originalInvite = modal.listenTogetherInvite;
  modal.listenTogetherInvite = () => Promise.resolve({ inviteFriendHandle: () => {} });
  try {
    await utility.createListeningRoomAfterServerCheck({
      data: { type: "NEW_ROOM", roomInfo },
      refer: "songplay_more",
      target: "renew_invite"
    }, false);
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const current = core.getStore()["async:listenTogether"] || {};
      const room = current.roomInfo || {};
      if (
        room.roomId
        && room.creatorId
        && room.roomId === roomInfo.roomId
        && ["waiting", "togetherOwner"].includes(utility.utilStatus)
        && utility.heartbeatCounting != null
      ) {
        return {
          roomId: String(room.roomId),
          creatorId: String(room.creatorId),
          status: utility.utilStatus,
          heartbeatActive: true
        };
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("The official client did not activate the room");
  } finally {
    modal.listenTogetherInvite = originalInvite;
  }
})(__ROOM_INFO__)
""".replace("__CORE__", str(ids["core"])).replace(
        "__UTILITY__", str(ids["utility"])
    ).replace("__MODAL__", str(ids["modal"])).replace(
        "__ROOM_INFO__",
        json.dumps(room_info, ensure_ascii=False, separators=(",", ":")),
    )
    result = websocket.evaluate(script, await_promise=True)
    if not isinstance(result, dict) or not result.get("roomId"):
        raise ServiceError("The official client did not activate the room")
    return result


def _current_song_on_client(websocket: WebSocket) -> dict[str, Any]:
    ids = _module_ids()
    script = r"""
(() => {
  const require = window.__neteaseCompanionRequire;
  const store = require(__CORE__).a.getStore();
  const playing = store.playing || {};
  const item = playing.curPlaying || {};
  const track = item.track || {};
  return {
    songId: String(item.resourceId || track.id || ""),
    name: String(track.name || playing.resourceName || ""),
    artists: (track.artists || playing.resourceArtists || []).map(value => value.name).filter(Boolean),
    album: String((track.album || {}).name || ""),
    durationMs: Number(track.duration || playing.resourceDuration || 0),
    playing: playing.playingState === 2
  };
})()
""".replace("__CORE__", str(ids["core"]))
    result = websocket.evaluate(script)
    return result if isinstance(result, dict) else {}


def status_payload() -> dict[str, Any]:
    payload: dict[str, Any] = {
        "success": True,
        "service": "netease-companion-native",
        "version": SERVICE_VERSION,
        "platform": platform.system().lower(),
        "client": {
            "available": False,
            "path": CLIENT_PATH,
            "processRunning": _process_running(),
            "debuggerAvailable": bool(_debug_target()),
        },
        "capabilities": {
            "createRoom": True,
            "nativeInvite": bool(RECEIVER_ID),
            "heartbeat": True,
            "leaveRoom": True,
        },
    }
    if COOKIE:
        try:
            payload["cookieUid"] = _account_uid()
            payload["cookieConfigured"] = True
        except ServiceError:
            payload["cookieConfigured"] = True
            payload["cookieUid"] = ""
    else:
        payload["cookieConfigured"] = False
        payload["cookieUid"] = ""
    if _debug_target():
        try:
            def read(websocket: WebSocket):
                if not websocket.evaluate(BOOTSTRAP):
                    raise ServiceError("Could not access the NetEase client runtime")
                return _client_state(websocket)

            state = _with_debugger(read)
            payload["client"].update({"available": True, **state})
        except ServiceError as exc:
            payload["client"]["error"] = _redact(exc)
    return payload


def create_room() -> dict[str, Any]:
    if not COOKIE:
        raise ServiceError("NETEASE_NATIVE_SERVICE_COOKIE is not configured")
    if not RECEIVER_ID:
        raise ServiceError("NETEASE_NATIVE_SERVICE_RECEIVER_ID is not configured")

    def create(websocket: WebSocket) -> dict[str, Any]:
        if not websocket.evaluate(BOOTSTRAP):
            raise ServiceError("Could not access the NetEase client runtime")
        state = _client_state(websocket)
        if (
            state.get("roomId")
            and state.get("heartbeatActive")
            and state.get("status") in {"waiting", "togetherOwner", "together"}
        ):
            creator = state.get("creatorId") or state.get("hostUid") or ""
            return {
                "success": True,
                "alreadyActive": True,
                "roomId": state["roomId"],
                "creatorId": creator,
                "currentSongId": state.get("songId") or "",
                "inviteUrl": _share_url(
                    state["roomId"],
                    creator,
                    state.get("songId") or "",
                ),
                "heartbeatActive": True,
            }
        _clear_stale_room()
        created = _local_api_request("/listentogether/room/create", {})
        created_data = created.get("data") or {}
        created_room = created_data.get("roomInfo") or {}
        if not created_room.get("roomId") or not created_room.get("creatorId"):
            raise ServiceError("NeteaseCloudMusicApi did not return roomInfo")
        room = _activate_room_on_client(websocket, created_room)
        state = _client_state(websocket)
        cookie_uid = _account_uid()
        host_uid = str(state.get("hostUid") or "")
        if cookie_uid and host_uid and cookie_uid != host_uid:
            try:
                utility_id = _module_ids()["utility"]
                websocket.evaluate(
                    f"window.__neteaseCompanionRequire({utility_id}).c"
                    ".leaveListenTogether({silent:true}); true"
                )
            except ServiceError:
                pass
            raise ServiceError(
                "The desktop client account does not match the configured Cookie"
            )
        response = _api_request(
            "/api/listen/together/invite/message/send",
            {
                "roomId": room["roomId"],
                "acceptorId": RECEIVER_ID,
            },
        )
        invite_sent = response.get("code") == 200 and bool(
            (response.get("data") or {}).get("result")
        )
        song_id = str(state.get("songId") or "")
        return {
            "success": True,
            "roomCreated": True,
            "roomId": str(room["roomId"]),
            "creatorId": str(room["creatorId"]),
            "currentSongId": song_id,
            "inviteUrl": _share_url(room["roomId"], room["creatorId"], song_id),
            "heartbeatActive": True,
            "clientUid": host_uid,
            "cookieUid": cookie_uid,
            "nativeInviteSent": invite_sent,
            "acceptorId": RECEIVER_ID if invite_sent else None,
        }

    with CLIENT_LOCK:
        return _with_debugger(create)


def close_room() -> dict[str, Any]:
    def leave(websocket: WebSocket) -> dict[str, Any]:
        if not websocket.evaluate(BOOTSTRAP):
            raise ServiceError("Could not access the NetEase client runtime")
        state = _client_state(websocket)
        if not state.get("roomId"):
            return {"success": True, "alreadyLeft": True}
        utility_id = _module_ids()["utility"]
        result = websocket.evaluate(
            f"""new Promise(resolve => {{
  window.__neteaseCompanionRequire({utility_id}).c.leaveListenTogether({{
    silent: true,
    roomId: {json.dumps(str(state["roomId"]))},
    callback: (ok, detail) => resolve({{ ok: Boolean(ok), detail: detail || null }})
  }});
}})""",
            await_promise=True,
        )
        if isinstance(result, dict) and result.get("ok"):
            return {
                "success": True,
                "roomId": state["roomId"],
                "detail": result.get("detail"),
            }
        return {
            "success": False,
            "roomId": state["roomId"],
            "message": "The official client did not complete the leave callback",
        }

    with CLIENT_LOCK:
        result = _with_debugger(leave)
    _clear_stale_room()
    for _ in range(20):
        time.sleep(0.25)
        payload = _api_request("/api/listen/together/status/get", {})
        data = payload.get("data") or {}
        if not data.get("inRoom"):
            break
    else:
        raise ServiceError("The room could not be closed on the server")

    with CLIENT_LOCK:
        if not _stop_client():
            raise ServiceError("The client could not be restarted after closing")
        _start_debug_client()
    return {
        "success": True,
        "roomId": result.get("roomId"),
        "leaveCallbackOk": result.get("success") is True,
        "clientReset": True,
    }


def current_song() -> dict[str, Any]:
    def read(websocket: WebSocket) -> dict[str, Any]:
        if not websocket.evaluate(BOOTSTRAP):
            raise ServiceError("Could not access the NetEase client runtime")
        return {"success": True, **_current_song_on_client(websocket)}

    with CLIENT_LOCK:
        return _with_debugger(read)


class Handler(BaseHTTPRequestHandler):
    server_version = "NeteaseCompanionNative/1.0"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = _json_response(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if not TOKEN:
            return False
        supplied = self.headers.get("Authorization", "")
        return hmac.compare_digest(supplied, "Bearer " + TOKEN)

    def _path(self) -> str:
        return urllib.parse.urlparse(self.path).path

    def do_GET(self) -> None:
        path = self._path()
        if path == "/health":
            self._send(
                200,
                {
                    "ok": True,
                    "service": "netease-companion-native",
                    "version": SERVICE_VERSION,
                },
            )
            return
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        try:
            if path == "/v1/status":
                self._send(200, status_payload())
            elif path == "/v1/current":
                self._send(200, current_song())
            else:
                self._send(404, {"error": "not found"})
        except Exception as exc:
            self._send(502, {"error": _redact(exc)})

    def do_POST(self) -> None:
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        path = self._path()
        try:
            if path == "/v1/rooms/create":
                self._send(200, create_room())
            elif path == "/v1/rooms/close":
                self._send(200, close_room())
            else:
                self._send(404, {"error": "not found"})
        except Exception as exc:
            self._send(502, {"error": _redact(exc)})


def main() -> None:
    if not TOKEN:
        raise SystemExit("NETEASE_NATIVE_SERVICE_TOKEN is required")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        print(
            f"[netease-companion-native] listening on http://{HOST}:{PORT}",
            flush=True,
        )
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
