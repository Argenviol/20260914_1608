/* ============================================================
   무제체스 온라인 대전 — 중계 서버

   이 서버는 체스를 모른다. 방을 열어 두 사람을 이어 주고,
   한쪽이 보낸 상태를 반대쪽에 그대로 넘길 뿐이다.
   (판을 바꾼 쪽이 결과를 보내는 구조라 서버가 판정할 게 없다)

   같은 프로세스가 game/ 의 정적 파일도 함께 서빙한다.
   서비스 하나, 주소 하나, CORS 없음.
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8788;
const ROOT = path.join(__dirname, '..', 'game');

/* ───────────────────── 정적 파일 ───────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 경로 탈출 차단 — ROOT 밖으로 나가는 요청은 받지 않는다
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('없는 파일입니다'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      // 파일 이름에 ?v= 스탬프가 붙어 있어서 캐시를 길게 잡아도 안전하다
      'cache-control': rel === '/index.html' ? 'no-cache' : 'public, max-age=604800',
    }).end(buf);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200).end('ok'); return; }
  serveStatic(req, res);
});

/* ───────────────────── 방 ───────────────────── */

// 헷갈리는 글자(O/0, I/1, S/5)를 뺀 알파벳
const CODE_CHARS = 'ABCDEFGHJKLMNPQRTUVWXY2346789';
const CODE_LEN = 5;
const ROOM_TTL = 1000 * 60 * 60 * 3;      // 3시간 동안 아무 일도 없으면 방을 버린다

/** code -> { code, tc, seats:{w,b}, lastState, createdAt, touchedAt } */
const rooms = new Map();

function newCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let c = '';
    for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    if (!rooms.has(c)) return c;
  }
  // 거의 일어나지 않는다. 그래도 조용히 실패하지는 않게.
  return null;
}

function touch(room) { room.touchedAt = Date.now(); }

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function peerOf(room, side) { return room.seats[side === 'w' ? 'b' : 'w']; }

function sweep() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const empty = !room.seats.w && !room.seats.b;
    if (now - room.touchedAt > ROOM_TTL || (empty && now - room.touchedAt > 1000 * 60 * 10)) {
      rooms.delete(code);
    }
  }
}
setInterval(sweep, 1000 * 60).unref();

/* ───────────────────── WebSocket ───────────────────── */

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.side = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    handle(ws, m);
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    if (room.seats[ws.side] === ws) room.seats[ws.side] = null;
    touch(room);
    send(peerOf(room, ws.side), { t: 'peer', online: false });
  });
});

function handle(ws, m) {
  switch (m.t) {

    // 방 만들기 — 만든 사람이 백
    case 'create': {
      const code = newCode();
      if (!code) { send(ws, { t: 'error', why: '방을 만들지 못했습니다. 다시 시도해 주세요.' }); return; }
      const room = {
        code, tc: m.tc || null,
        seats: { w: ws, b: null },
        lastState: null,
        createdAt: Date.now(), touchedAt: Date.now(),
      };
      rooms.set(code, room);
      ws.room = room; ws.side = 'w';
      send(ws, { t: 'created', code, side: 'w', tc: room.tc });
      return;
    }

    // 참가 — 들어온 사람이 흑
    case 'join': {
      const code = String(m.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(ws, { t: 'error', why: '그런 방이 없습니다. 코드를 확인해 주세요.' }); return; }
      if (room.seats.b && room.seats.b.readyState === room.seats.b.OPEN) {
        send(ws, { t: 'error', why: '이미 두 명이 들어와 있는 방입니다.' }); return;
      }
      room.seats.b = ws; ws.room = room; ws.side = 'b'; touch(room);
      send(ws, { t: 'joined', code, side: 'b', tc: room.tc });
      if (room.lastState) send(ws, { t: 'state', s: room.lastState });   // 진행 중이던 판이면 이어서
      send(room.seats.w, { t: 'peer', online: true });
      return;
    }

    // 재접속 — 새로고침하거나 잠깐 끊겼을 때
    case 'rejoin': {
      const code = String(m.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      const side = m.side === 'b' ? 'b' : 'w';
      if (!room) { send(ws, { t: 'error', why: '방이 사라졌습니다. 새로 만들어 주세요.' }); return; }
      const held = room.seats[side];
      if (held && held !== ws && held.readyState === held.OPEN) {
        send(ws, { t: 'error', why: '그 자리에 이미 다른 사람이 앉아 있습니다.' }); return;
      }
      room.seats[side] = ws; ws.room = room; ws.side = side; touch(room);
      send(ws, { t: 'joined', code, side, tc: room.tc, resumed: true });
      if (room.lastState) send(ws, { t: 'state', s: room.lastState });
      const peer = peerOf(room, side);
      send(peer, { t: 'peer', online: true });
      send(ws, { t: 'peer', online: !!(peer && peer.readyState === peer.OPEN) });
      return;
    }

    // 판이 바뀌었다 — 보관하고 상대에게 넘긴다. 서버는 내용을 보지 않는다.
    case 'state': {
      const room = ws.room;
      if (!room || room.seats[ws.side] !== ws) return;
      room.lastState = m.s;
      touch(room);
      send(peerOf(room, ws.side), { t: 'state', s: m.s });
      return;
    }

    // 그 외(항복·재대국 요청·수락)는 그대로 흘려 보낸다
    case 'note':
    case 'resign':
    case 'rematch':
    case 'rematchOk': {
      const room = ws.room;
      if (!room || room.seats[ws.side] !== ws) return;
      touch(room);
      if (m.t === 'rematch' || m.t === 'rematchOk') room.lastState = null;
      send(peerOf(room, ws.side), Object.assign({}, m, { from: ws.side }));
      return;
    }

    case 'ping': send(ws, { t: 'pong' }); return;
  }
}

// 죽은 연결 정리 (프록시가 조용히 끊는 경우가 있다)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* 이미 닫힘 */ }
  }
}, 30000).unref();

server.listen(PORT, () => {
  console.log(`무제체스 서버 http://localhost:${PORT}  (방 ${rooms.size}개)`);
});
