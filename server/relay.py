# -*- coding: utf-8 -*-
"""무제체스 온라인 대전 — 중계 서버 (파이썬 표준 라이브러리만)

이 서버는 체스를 모른다. 방을 열어 두 사람을 이어 주고,
한쪽이 보낸 상태를 반대쪽에 그대로 넘길 뿐이다.
(판을 바꾼 쪽이 결과를 보내는 구조라 서버가 판정할 게 없다)

같은 프로세스가 game/ 의 정적 파일도 함께 서빙한다. 주소 하나, CORS 없음.
대국 통계(/api/stat)와 계정·전적(/api/auth/*, /api/records)도 여기서 받아 수퍼베이스에 적는다.

파이썬만 있으면 돌아간다 — 설치할 것도, 빌드할 것도 없다.
(예전에는 Node + ws 패키지가 필요했는데, 컴퓨터를 옮길 때마다
 npm install 을 다시 해야 해서 온라인 대전이 조용히 꺼져 있곤 했다)

    python server/relay.py            # 기본 8788
    PORT=10000 python server/relay.py # 배포용
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import posixpath
import random
import re
import secrets
import socket
import socketserver
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "game"))
PORT = int(os.environ.get("PORT", "8788"))

# ── 대국 통계 (수퍼베이스) ──
# 키는 서버에만 둔다. 정적 사이트라 브라우저에 넣으면 누구나 볼 수 있다.
# 둘 다 비어 있으면 통계는 조용히 버린다 — 로컬에서 돌릴 때 오류가 나면 안 된다.
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

STAT_MAX_BODY = 64 * 1024      # 한 번에 받는 최대 크기
STAT_MAX_PLAYS = 4
STAT_MAX_PICKS = 40
STAT_RATE_N = 40               # IP 당
STAT_RATE_SEC = 300            # 이 시간 안에
_stat_hits = {}
_stat_lock = threading.Lock()

# service_role 키는 RLS 를 무시한다. 그러니 '아는 칸' 만 골라 담는다 —
# 브라우저가 보낸 걸 그대로 넘기면 아무 열에나 아무거나 쓸 수 있게 된다.
# (이름, 종류, 최대길이) — 종류: s 글자, i 정수, b 참거짓, a 글자배열, o 객체
PLAY_COLS = [
    ("id", "s", 40), ("client_id", "s", 40), ("app_version", "s", 20),
    ("mode", "s", 10), ("difficulty", "s", 10), ("tc", "s", 20), ("room", "s", 10),
    ("side", "s", 1), ("is_ai", "b", 0), ("outcome", "s", 10), ("reason", "s", 200),
    ("moves", "i", 0), ("plies", "i", 0), ("duration_ms", "i", 0),
    ("kills", "i", 0), ("opp_kills", "i", 0), ("tier_reached", "i", 0),
    ("augs", "a", 24), ("piece_moves", "o", 0), ("piece_kills", "o", 0),
]
PICK_COLS = [
    ("id", "s", 40), ("play_id", "s", 40), ("ply", "i", 0), ("tier", "i", 0),
    ("piece", "s", 10), ("offered", "a", 8), ("blocked", "a", 8),
    ("chosen", "s", 10), ("think_ms", "i", 0), ("auto", "b", 0), ("is_ai", "b", 0),
]


def clean_row(row, cols):
    """정해 둔 칸만, 정해 둔 모양으로 옮겨 담는다."""
    if not isinstance(row, dict):
        return None
    out = {}
    for name, kind, cap in cols:
        v = row.get(name)
        if v is None:
            out[name] = None
        elif kind == "s":
            out[name] = str(v)[:cap] if isinstance(v, str) else None
        elif kind == "i":
            out[name] = max(-10 ** 9, min(10 ** 9, int(v))) if isinstance(v, (int, float)) else None
        elif kind == "b":
            out[name] = bool(v)
        elif kind == "a":
            out[name] = [str(x)[:20] for x in v[:cap]] if isinstance(v, list) else []
        elif kind == "o":
            out[name] = ({str(k)[:4]: int(x) for k, x in list(v.items())[:16]
                          if isinstance(x, (int, float))} if isinstance(v, dict) else {})
    return out


def stat_allowed(ip):
    now = time.time()
    with _stat_lock:
        hits = [t for t in _stat_hits.get(ip, []) if now - t < STAT_RATE_SEC]
        if len(hits) >= STAT_RATE_N:
            _stat_hits[ip] = hits
            return False
        hits.append(now)
        _stat_hits[ip] = hits
        if len(_stat_hits) > 5000:      # 오래된 것 청소
            for k in [k for k, v in _stat_hits.items() if not v or now - v[-1] > STAT_RATE_SEC]:
                _stat_hits.pop(k, None)
    return True


# ── 계정 · 전적 (수퍼베이스) ──
# 로그인하면 전적이 기기와 상관없이 이어진다. 비밀번호는 서버에서만 다루고
# 해시(PBKDF2)로만 저장한다. 세션 토큰도 해시로만 저장한다 — 표가 새어도 그대로 못 쓴다.
ACCT_RATE_N = 12               # 로그인·가입 시도, IP 당
ACCT_RATE_SEC = 300            # 이 시간 안에
SESSION_DAYS = 90
NAME_RE = re.compile(r"^[0-9A-Za-z가-힣_]{2,16}$")
PW_MIN, PW_MAX = 6, 72
PW_ITER = 200_000
REC_MAX = 100                  # 한 사람이 보관하는 전적 수 (브라우저와 같다)
API_MAX_BODY = 128 * 1024
_acct_hits = {}


def rate_allowed(store, ip, n, sec):
    """IP 당 sec 초 안에 n 번까지. 넘으면 False."""
    now = time.time()
    with _stat_lock:
        hits = [t for t in store.get(ip, []) if now - t < sec]
        if len(hits) >= n:
            store[ip] = hits
            return False
        hits.append(now)
        store[ip] = hits
        if len(store) > 5000:
            for k in [k for k, v in store.items() if not v or now - v[-1] > sec]:
                store.pop(k, None)
    return True


def supabase_req(method, table, params=None, rows=None, prefer="return=representation"):
    """수퍼베이스 REST 한 번. 응답 본문이 있으면 JSON 으로 돌려준다."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        data=json.dumps(rows).encode("utf-8") if rows is not None else None,
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": "Bearer " + SUPABASE_KEY,
            "Content-Type": "application/json",
            "Prefer": prefer,
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        body = r.read()
    return json.loads(body.decode("utf-8")) if body else None


def pw_hash(pw: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, PW_ITER).hex()


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def clean_record(r):
    """브라우저가 보낸 전적 한 줄을 아는 칸만 골라 담는다. (clean_row 는 정수 상한이 작아 시각에 못 쓴다)"""
    if not isinstance(r, dict):
        return None
    at = r.get("at")
    if not isinstance(at, (int, float)) or at <= 0:
        return None
    out = {"at": int(at)}
    rid = r.get("id")
    out["id"] = str(rid)[:48] if isinstance(rid, str) and rid else f"r{out['at']}-{r.get('mode', '')}"[:48]
    for k, cap in (("mode", 10), ("difficulty", 10), ("outcome", 10), ("reason", 200)):
        v = r.get(k)
        out[k] = str(v)[:cap] if isinstance(v, str) else None
    mv = r.get("moves")
    out["moves"] = max(0, min(100000, int(mv))) if isinstance(mv, (int, float)) else 0
    for k in ("kills", "augs"):
        v = r.get(k)
        out[k] = ({"w": int(v.get("w") or 0), "b": int(v.get("b") or 0)}
                  if isinstance(v, dict) else {"w": 0, "b": 0})
    return out


def merge_records(server_rows, client_rows):
    """id 로 합친다. 같은 id 면 서버 것을 둔다. 최신이 앞, REC_MAX 개까지."""
    by_id = {}
    for r in list(client_rows or []) + list(server_rows or []):
        c = clean_record(r)
        if c:
            by_id[c["id"]] = c
    out = sorted(by_id.values(), key=lambda x: -x["at"])
    return out[:REC_MAX]


def acct_by_name(name_lower):
    rows = supabase_req("GET", "accounts", {"select": "id,name,pw_hash,salt",
                                            "name_lower": "eq." + name_lower, "limit": "1"})
    return rows[0] if rows else None


def acct_by_token(token):
    if not token:
        return None
    rows = supabase_req("GET", "account_sessions", {
        "select": "account_id,expires_at,accounts(name)",
        "token_hash": "eq." + token_hash(token), "limit": "1"})
    if not rows:
        return None
    row = rows[0]
    exp = row.get("expires_at") or ""
    # ISO 8601 → epoch. 수퍼베이스는 '+00:00' 로 준다.
    try:
        exp_t = time.mktime(time.strptime(exp[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except Exception:
        exp_t = 0
    if exp_t < time.time():
        return None
    acc = row.get("accounts") or {}
    return {"id": row["account_id"], "name": acc.get("name") or ""}


def new_session(account_id):
    token = secrets.token_urlsafe(32)
    exp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + SESSION_DAYS * 86400))
    supabase_req("POST", "account_sessions",
                 rows=[{"token_hash": token_hash(token), "account_id": account_id, "expires_at": exp}],
                 prefer="return=minimal")
    return token


def records_get(account_id):
    rows = supabase_req("GET", "account_records", {"select": "records", "account_id": "eq." + account_id})
    return (rows[0].get("records") or []) if rows else []


def records_put(account_id, records):
    supabase_req("POST", "account_records", {"on_conflict": "account_id"},
                 rows=[{"account_id": account_id, "records": records,
                        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}],
                 prefer="resolution=merge-duplicates,return=minimal")


def supabase_insert(table, rows):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{table}",
        data=json.dumps(rows).encode("utf-8"),
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": "Bearer " + SUPABASE_KEY,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        r.read()


def stat_forward(plays, picks):
    """응답을 이미 보낸 뒤 따로 돈다 — 수퍼베이스가 느려도 게임이 기다리지 않게."""
    try:
        if plays:
            supabase_insert("plays", plays)
        if picks:
            supabase_insert("aug_picks", picks)
    except Exception as e:
        # 통계 때문에 서버가 시끄러워지면 안 된다. 한 줄만 남긴다.
        print("[stat] 전송 실패:", e, flush=True)


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

            if path.split("?")[0].startswith("/api/"):
                self.do_api(method, path.split("?")[0], headers)
                return

            if method not in ("GET", "HEAD"):
                self.respond(405, b"method not allowed", "text/plain; charset=utf-8")
                return

            self.do_static(path, head_only=(method == "HEAD"))
        except (OSError, socket.timeout):
            pass

    # ── API ──
    def json_out(self, code, obj):
        self.respond(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                     "application/json; charset=utf-8", extra={"Cache-Control": "no-store"})

    def read_body(self, headers, cap):
        try:
            n = int(headers.get("content-length", "0"))
        except ValueError:
            n = 0
        if n > cap:
            return None
        return self.rfile.read(n) if n > 0 else b""

    def do_api(self, method, path, headers):
        if path == "/api/stat":
            if method == "POST":
                self.do_stat(headers)
            else:
                self.respond(405, b"method not allowed", "text/plain; charset=utf-8")
            return
        try:
            self.do_account(method, path, headers)
        except urllib.error.HTTPError as e:
            # 수퍼베이스가 거절했다. 표가 없거나 키가 틀린 경우가 대부분이다.
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:200]
            except Exception:
                pass
            print("[account] 수퍼베이스 오류:", e.code, detail, flush=True)
            self.json_out(502, {"error": "계정 저장소가 요청을 거절했습니다"})
        except Exception as e:
            print("[account] 오류:", e, flush=True)
            self.json_out(502, {"error": "계정 저장소에 연결하지 못했습니다"})

    def do_account(self, method, path, headers):
        """계정 · 전적. 브라우저는 Authorization: Bearer <토큰> 으로 자기를 밝힌다.

        POST /api/auth/signup  {name, pw, records?}   → {token, name, records}
        POST /api/auth/login   {name, pw, records?}   → {token, name, records}
        POST /api/auth/logout                          → 204
        GET  /api/auth/me                              → {name}
        GET  /api/records                              → {records}
        POST /api/records      {records}               → {records}   (합친 결과)
        DELETE /api/records                            → 204
        records 는 브라우저에 있던 전적. 로그인할 때 같이 보내면 계정 것과 합쳐 준다."""
        if not SUPABASE_URL or not SUPABASE_KEY:
            self.json_out(503, {"error": "서버에 계정 저장소가 아직 연결되지 않았습니다"})
            return
        body = self.read_body(headers, API_MAX_BODY)
        if body is None:
            self.json_out(413, {"error": "너무 큽니다"})
            return
        m = {}
        if body:
            try:
                m = json.loads(body.decode("utf-8"))
            except Exception:
                m = {}
            if not isinstance(m, dict):
                m = {}
        auth = headers.get("authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        ip = self.client_address[0]

        if path in ("/api/auth/signup", "/api/auth/login") and method == "POST":
            if not rate_allowed(_acct_hits, ip, ACCT_RATE_N, ACCT_RATE_SEC):
                self.json_out(429, {"error": "시도가 너무 잦습니다. 잠시 뒤에 다시 해 주세요"})
                return
            name = m.get("name") if isinstance(m.get("name"), str) else ""
            pw = m.get("pw") if isinstance(m.get("pw"), str) else ""
            name = name.strip()
            if not NAME_RE.match(name):
                self.json_out(400, {"error": "아이디는 2~16자, 한글·영문·숫자·_ 만 됩니다"})
                return
            if not (PW_MIN <= len(pw) <= PW_MAX):
                self.json_out(400, {"error": f"비밀번호는 {PW_MIN}자 이상이어야 합니다"})
                return
            existing = acct_by_name(name.lower())
            if path.endswith("signup"):
                if existing:
                    self.json_out(409, {"error": "이미 있는 아이디입니다"})
                    return
                salt = secrets.token_bytes(16)
                rows = supabase_req("POST", "accounts", rows=[{
                    "name": name, "name_lower": name.lower(),
                    "pw_hash": pw_hash(pw, salt), "salt": salt.hex(),
                }])
                account = {"id": rows[0]["id"], "name": name}
            else:
                if not existing or not hmac.compare_digest(
                        existing.get("pw_hash") or "", pw_hash(pw, bytes.fromhex(existing.get("salt") or ""))):
                    self.json_out(401, {"error": "아이디나 비밀번호가 맞지 않습니다"})
                    return
                account = {"id": existing["id"], "name": existing["name"]}
            tok = new_session(account["id"])
            merged = merge_records(records_get(account["id"]), m.get("records") or [])
            records_put(account["id"], merged)
            self.json_out(200, {"token": tok, "name": account["name"], "records": merged})
            return

        # 여기서부터는 로그인이 필요하다
        account = acct_by_token(token)
        if path == "/api/auth/logout" and method == "POST":
            if token:
                supabase_req("DELETE", "account_sessions", {"token_hash": "eq." + token_hash(token)},
                             prefer="return=minimal")
            self.respond(204, b"", "text/plain; charset=utf-8")
            return
        if not account:
            self.json_out(401, {"error": "로그인이 필요합니다"})
            return
        if path == "/api/auth/me" and method == "GET":
            self.json_out(200, {"name": account["name"]})
        elif path == "/api/records" and method == "GET":
            self.json_out(200, {"records": records_get(account["id"])})
        elif path == "/api/records" and method == "POST":
            merged = merge_records(records_get(account["id"]), m.get("records") or [])
            records_put(account["id"], merged)
            self.json_out(200, {"records": merged})
        elif path == "/api/records" and method == "DELETE":
            records_put(account["id"], [])
            self.respond(204, b"", "text/plain; charset=utf-8")
        else:
            self.json_out(404, {"error": "없는 주소입니다"})

    # ── 대국 통계 ──
    def do_stat(self, headers):
        """받아서 걸러 낸 뒤 수퍼베이스로 넘긴다.

        보내는 쪽(브라우저)은 답을 안 기다린다. 그래서 무슨 일이 있어도 204 만 준다 —
        통계가 안 되는 것 때문에 게임 화면에 오류가 뜨면 안 된다."""
        try:
            n = int(headers.get("content-length", "0"))
        except ValueError:
            n = 0
        body = self.rfile.read(n) if 0 < n <= STAT_MAX_BODY else b""
        self.respond(204, b"", "text/plain; charset=utf-8")

        if not body or not SUPABASE_URL or not SUPABASE_KEY:
            return
        ip = self.client_address[0]
        if not stat_allowed(ip):
            return
        try:
            m = json.loads(body.decode("utf-8"))
        except Exception:
            return
        if not isinstance(m, dict):
            return

        plays = [clean_row(r, PLAY_COLS) for r in (m.get("plays") or [])[:STAT_MAX_PLAYS]]
        picks = [clean_row(r, PICK_COLS) for r in (m.get("picks") or [])[:STAT_MAX_PICKS]]
        plays = [r for r in plays if r and r.get("id")]
        picks = [r for r in picks if r and r.get("id") and r.get("play_id")]
        if not plays:
            return
        threading.Thread(target=stat_forward, args=(plays, picks), daemon=True).start()

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
        reason = {200: "OK", 204: "No Content", 400: "Bad Request", 401: "Unauthorized",
                  403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict",
                  413: "Payload Too Large", 429: "Too Many Requests", 502: "Bad Gateway",
                  503: "Service Unavailable"}.get(code, "OK")
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
