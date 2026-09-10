# -*- coding: utf-8 -*-
"""무제체스 온라인 대전 — 중계 서버 (파이썬 표준 라이브러리만)

이 서버는 체스를 모른다. 방을 열어 두 사람을 이어 주고,
한쪽이 보낸 상태를 반대쪽에 그대로 넘길 뿐이다.
(판을 바꾼 쪽이 결과를 보내는 구조라 서버가 판정할 게 없다)

같은 프로세스가 game/ 의 정적 파일도 함께 서빙한다. 주소 하나, CORS 없음.

파이썬만 있으면 돌아간다 — 설치할 것도, 빌드할 것도 없다.
(예전에는 Node + ws 패키지가 필요했는데, 컴퓨터를 옮길 때마다
 npm install 을 다시 해야 해서 온라인 대전이 조용히 꺼져 있곤 했다)

    python server/relay.py            # 기본 8788
    PORT=10000 python server/relay.py # 배포용
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import posixpath
import random
import socket
import socketserver
import struct
import sys
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "game"))
PORT = int(os.environ.get("PORT", "8788"))

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

# 헷갈리는 글자(O/0, I/1, S/5)를 뺀 알파벳
CODE_CHARS = "ABCDEFGHJKLMNPQRTUVWXY2346789"
CODE_LEN = 5
ROOM_TTL = 60 * 60 * 3          # 3시간 동안 아무 일도 없으면 방을 버린다
EMPTY_TTL = 60 * 10             # 아무도 없는 방은 10분

rooms: dict[str, "Room"] = {}
lock = threading.RLock()


class Room:
    __slots__ = ("code", "tc", "seats", "last_state", "touched")

    def __init__(self, code, tc):
        self.code = code
        self.tc = tc
        self.seats = {"w": None, "b": None}     # side -> Conn
        self.last_state = None
        self.touched = time.time()

    def peer(self, side):
        return self.seats["b" if side == "w" else "w"]


def new_code():
    for _ in range(50):
        c = "".join(random.choice(CODE_CHARS) for _ in range(CODE_LEN))
        if c not in rooms:
            return c
    return None                                  # 거의 안 일어난다. 조용히 실패하진 않게.


def sweep():
    """죽은 방 정리. 데몬 스레드로 돈다."""
    while True:
        time.sleep(60)
        now = time.time()
        with lock:
            for code in [c for c, r in rooms.items()
                         if now - r.touched > ROOM_TTL
                         or (not r.seats["w"] and not r.seats["b"] and now - r.touched > EMPTY_TTL)]:
                rooms.pop(code, None)


# ───────────────────────── WebSocket 프레임 ─────────────────────────

class WSClosed(Exception):
    pass


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise WSClosed()
        buf += chunk
    return buf


def ws_recv(sock):
    """프레임 하나를 읽어 (opcode, payload) 로 돌려준다. 조각난 프레임도 이어 붙인다."""
    opcode0, data = None, b""
    while True:
        b1, b2 = recv_exact(sock, 2)
        fin = b1 & 0x80
        opcode = b1 & 0x0F
        masked = b2 & 0x80
        ln = b2 & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", recv_exact(sock, 2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", recv_exact(sock, 8))[0]
        if ln > 8 * 1024 * 1024:                 # 한 판 상태가 8MB 를 넘을 일은 없다
            raise WSClosed()
        mask = recv_exact(sock, 4) if masked else None
        payload = recv_exact(sock, ln) if ln else b""
        if mask:
            payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))

        if opcode in (0x8, 0x9, 0xA):            # close / ping / pong 은 조각나지 않는다
            return opcode, payload
        if opcode0 is None:
            opcode0 = opcode
        data += payload
        if fin:
            return opcode0, data


def ws_send(sock, payload: bytes, opcode=0x1):
    n = len(payload)
    if n < 126:
        head = struct.pack(">BB", 0x80 | opcode, n)
    elif n < (1 << 16):
        head = struct.pack(">BBH", 0x80 | opcode, 126, n)
    else:
        head = struct.pack(">BBQ", 0x80 | opcode, 127, n)
    sock.sendall(head + payload)                 # 서버 → 클라이언트는 마스킹하지 않는다


# ───────────────────────── 연결 ─────────────────────────

class Conn:
    """한 사람의 WebSocket 연결. 보내기는 잠금으로 직렬화한다."""

    def __init__(self, sock):
        self.sock = sock
        self.room = None
        self.side = None
        self.alive = True
        self.wlock = threading.Lock()

    def send(self, obj):
        if not self.alive:
            return
        try:
            with self.wlock:
                ws_send(self.sock, json.dumps(obj, ensure_ascii=False).encode("utf-8"))
        except OSError:
            self.alive = False


def send_to(conn, obj):
    if conn is not None and conn.alive:
        conn.send(obj)


def handle_message(conn: Conn, m: dict):
    t = m.get("t")

    # 방 만들기 — 만든 사람이 색을 고른다 (랜덤이면 여기서 정한다)
    if t == "create":
        want = m.get("side")
        if want not in ("w", "b"):
            want = random.choice(("w", "b"))
        with lock:
            code = new_code()
            if not code:
                conn.send({"t": "error", "why": "방을 만들지 못했습니다. 다시 시도해 주세요."})
                return
            room = Room(code, m.get("tc"))
            room.seats[want] = conn
            rooms[code] = room
        conn.room, conn.side = room, want
        conn.send({"t": "created", "code": code, "side": want, "tc": room.tc})
        return

    # 참가 — 남은 자리에 앉는다 (방장이 고른 색의 반대)
    if t == "join":
        code = str(m.get("code") or "").upper().strip()
        with lock:
            room = rooms.get(code)
            if not room:
                conn.send({"t": "error", "why": "그런 방이 없습니다. 코드를 확인해 주세요."})
                return
            free = None
            for c in ("w", "b"):
                held = room.seats[c]
                if held is None or not held.alive:
                    free = c
                    break
            if free is None:
                conn.send({"t": "error", "why": "이미 두 명이 들어와 있는 방입니다."})
                return
            room.seats[free] = conn
            room.touched = time.time()
            last, host = room.last_state, room.peer(free)
        conn.room, conn.side = room, free
        conn.send({"t": "joined", "code": code, "side": free, "tc": room.tc})
        if last:
            conn.send({"t": "state", "s": last})     # 진행 중이던 판이면 이어서
        send_to(host, {"t": "peer", "online": True})
        return

    # 재접속 — 새로고침하거나 잠깐 끊겼을 때
    if t == "rejoin":
        code = str(m.get("code") or "").upper().strip()
        side = "b" if m.get("side") == "b" else "w"
        with lock:
            room = rooms.get(code)
            if not room:
                conn.send({"t": "error", "why": "방이 사라졌습니다. 새로 만들어 주세요."})
                return
            held = room.seats[side]
            if held is not None and held is not conn and held.alive:
                conn.send({"t": "error", "why": "그 자리에 이미 다른 사람이 앉아 있습니다."})
                return
            room.seats[side] = conn
            room.touched = time.time()
            last, peer = room.last_state, room.peer(side)
        conn.room, conn.side = room, side
        conn.send({"t": "joined", "code": code, "side": side, "tc": room.tc, "resumed": True})
        if last:
            conn.send({"t": "state", "s": last})
        send_to(peer, {"t": "peer", "online": True})
        conn.send({"t": "peer", "online": bool(peer is not None and peer.alive)})
        return

    room = conn.room
    if room is None or room.seats.get(conn.side) is not conn:
        return

    # 판이 바뀌었다 — 보관하고 상대에게 넘긴다. 서버는 내용을 보지 않는다.
    if t == "state":
        with lock:
            room.last_state = m.get("s")
            room.touched = time.time()
            peer = room.peer(conn.side)
        send_to(peer, {"t": "state", "s": m.get("s")})
        return

    # 그 외(시계 신호·항복·재대국)는 그대로 흘려 보낸다
    if t in ("note", "resign", "rematch", "rematchOk", "abort", "chat"):
        with lock:
            room.touched = time.time()
            if t in ("rematch", "rematchOk", "abort"):
                room.last_state = None
            peer = room.peer(conn.side)
        out = dict(m)
        out["from"] = conn.side
        send_to(peer, out)
        return

    if t == "ping":
        conn.send({"t": "pong"})


def ws_loop(conn: Conn):
    sock = conn.sock
    try:
        while True:
            opcode, payload = ws_recv(sock)
            if opcode == 0x8:                        # close
                break
            if opcode == 0x9:                        # ping → pong
                with conn.wlock:
                    ws_send(sock, payload, 0xA)
                continue
            if opcode != 0x1:
                continue
            try:
                m = json.loads(payload.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(m, dict) and isinstance(m.get("t"), str):
                handle_message(conn, m)
    except (WSClosed, OSError):
        pass
    finally:
        conn.alive = False
        room = conn.room
        if room is not None:
            with lock:
                if room.seats.get(conn.side) is conn:
                    room.seats[conn.side] = None
                room.touched = time.time()
                peer = room.peer(conn.side)
            send_to(peer, {"t": "peer", "online": False})


# ───────────────────────── HTTP ─────────────────────────

def safe_path(rel: str):
    """ROOT 밖으로 나가는 요청은 받지 않는다."""
    rel = urllib.parse.unquote(rel.split("?", 1)[0])
    if rel in ("", "/"):
        rel = "/index.html"
    full = os.path.normpath(os.path.join(ROOT, rel.lstrip("/")))
    if not full.startswith(ROOT):
        return None
    return full


class Handler(socketserver.StreamRequestHandler):
    # 상태 전송이 커질 수 있으니 넉넉히
    rbufsize = 65536
    wbufsize = 0
    timeout = 300

    def handle(self):
        try:
            line = self.rfile.readline(65536)
            if not line:
                return
            parts = line.decode("latin-1").strip().split()
            if len(parts) < 2:
                return
            method, path = parts[0], parts[1]

            headers = {}
            while True:
                h = self.rfile.readline(65536)
                if not h or h in (b"\r\n", b"\n"):
                    break
                k, _, v = h.decode("latin-1").partition(":")
                headers[k.strip().lower()] = v.strip()

            if path.split("?")[0] == "/ws" and "websocket" in headers.get("upgrade", "").lower():
                self.do_websocket(headers)
                return

            if path.split("?")[0] == "/healthz":
                # 실행기가 '이미 떠 있는 무제체스 서버' 를 알아보는 표식이기도 하다
                self.respond(200, b"muje-chess ok", "text/plain; charset=utf-8")
                return

            if method not in ("GET", "HEAD"):
                self.respond(405, b"method not allowed", "text/plain; charset=utf-8")
                return

            self.do_static(path, head_only=(method == "HEAD"))
        except (OSError, socket.timeout):
            pass

    # ── 정적 파일 ──
    def do_static(self, path, head_only=False):
        full = safe_path(path)
        if full is None:
            self.respond(403, b"forbidden", "text/plain; charset=utf-8")
            return
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            self.respond(404, "없는 파일입니다".encode("utf-8"), "text/plain; charset=utf-8")
            return
        ext = posixpath.splitext(full)[1].lower()
        # 파일 이름에 ?v= 스탬프가 붙어 있어서 캐시를 길게 잡아도 안전하다
        cache = "no-cache" if full.endswith("index.html") else "public, max-age=604800"
        self.respond(200, b"" if head_only else body,
                     MIME.get(ext, "application/octet-stream"),
                     extra={"Cache-Control": cache, "Content-Length": str(len(body))})

    def respond(self, code, body: bytes, ctype: str, extra=None):
        reason = {200: "OK", 403: "Forbidden", 404: "Not Found",
                  405: "Method Not Allowed", 400: "Bad Request"}.get(code, "OK")
        head = [f"HTTP/1.1 {code} {reason}", f"Content-Type: {ctype}"]
        fields = {"Content-Length": str(len(body)), "Connection": "close"}
        if extra:
            fields.update(extra)
        head += [f"{k}: {v}" for k, v in fields.items()]
        self.wfile.write(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + body)

    # ── WebSocket 업그레이드 ──
    def do_websocket(self, headers):
        key = headers.get("sec-websocket-key")
        if not key:
            self.respond(400, b"bad handshake", "text/plain; charset=utf-8")
            return
        accept = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode("latin-1")).digest()).decode("latin-1")
        self.wfile.write((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode("latin-1"))
        self.connection.settimeout(None)
        ws_loop(Conn(self.connection))


class Server(socketserver.ThreadingTCPServer):
    """같은 포트에 서버가 두 개 뜨지 못하게 한다.

    Windows 의 SO_REUSEADDR 는 리눅스와 달리 '이미 듣고 있는 포트에 또 바인드' 까지
    허용한다. 그대로 두면 실행기를 두 번 누른 것만으로 서버가 둘이 되고, 접속이 둘로
    갈려서 방을 만든 사람과 들어오는 사람이 서로 다른 프로세스에 붙는다.
    → 들어온 쪽에는 "그런 방이 없습니다" 만 뜬다. 방은 프로세스 메모리에 있으니까.
    """
    daemon_threads = True
    allow_reuse_address = (os.name != "nt")

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        pass
    if not os.path.exists(os.path.join(ROOT, "index.html")):
        print(f"[오류] 게임 파일을 찾지 못했습니다: {ROOT}")
        return 1
    threading.Thread(target=sweep, daemon=True).start()
    try:
        srv = Server(("0.0.0.0", PORT), Handler)
    except OSError:
        print(f"[오류] 포트 {PORT} 는 이미 쓰이고 있습니다.")
        print("       이미 떠 있는 무제체스 창을 쓰거나, 그 창을 닫고 다시 실행해 주세요.")
        print("       (서버가 둘이 되면 방을 만든 사람과 들어오는 사람이 갈라집니다)")
        return 1
    print(f"무제체스 중계 서버 http://localhost:{PORT}  (온라인 대전 가능)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n   종료합니다.")
    finally:
        srv.shutdown()
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
