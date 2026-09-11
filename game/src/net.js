/* ============================================================
   무제체스 온라인 대전 — 네트워크 계층

   서버는 판을 모른다. "판을 바꾼 쪽이 결과를 보낸다".
   받는 쪽은 계산하지 않고 그대로 채택하므로 어긋날 수가 없다.

   비밀 증강
     자기편의 아직 공개되지 않은 비밀 증강 id 는 '?w1' 같은 가면으로 바꿔 보낸다.
     가면에는 기물·티어만 담는다 — 지금 화면이 숨김 증강에 보여 주는 것과 같은 양이다.
     진짜 id 는 이 클라이언트 밖으로 나가지 않고, 발동해서 공개되는 순간부터 실린다.
   ============================================================ */
(function (global) {
  'use strict';

  const Net = {};
  global.Net = Net;

  const E = () => global.Engine;
  const Game = () => global.Game;

  /* ───────────────────── 상태 ───────────────────── */

  let ws = null;
  let wantOpen = false;             // 일부러 끊은 것인지, 사고인지 구분
  let retry = 0, retryTimer = null;
  let everConnected = false;        // 한 번도 못 붙었으면 서버가 없는 주소다

  Net.connected = false;
  Net.peerOnline = false;
  Net.code = null;
  Net.side = null;                  // 'w' | 'b'
  Net.isHost = false;               // 방을 만든 쪽인가. 색과는 별개다 (방장이 흑을 고를 수 있다)
  Net.onEvent = null;               // (type, payload) => void  — ui.js 가 붙는다

  function emit(type, payload) { if (Net.onEvent) Net.onEvent(type, payload); }

  Net.isMyTurn = function () {
    const g = Game() && Game().G;
    return !!(g && Net.side && g.turn === Net.side);
  };

  /* ───────────────────── 소켓 ───────────────────── */

  function wsURL() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  Net.connect = function () {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    wantOpen = true;
    try { ws = new WebSocket(wsURL()); }
    catch (e) { emit('error', { why: '서버에 연결할 수 없습니다.' }); return; }

    ws.onopen = () => {
      retry = 0;
      everConnected = true;
      Net.connected = true;
      emit('connected', null);
      // 끊겼다 붙은 거라면 앉아 있던 자리로 돌아간다
      if (Net.code && Net.side) raw({ t: 'rejoin', code: Net.code, side: Net.side });
    };

    ws.onclose = () => {
      Net.connected = false;
      Net.peerOnline = false;
      emit('disconnected', null);
      if (!wantOpen) return;
      // 한 번도 붙어 본 적이 없다면 중계 서버가 없는 주소다 (예: 파일 열기, 정적 서버).
      // 여기서 멈추지 않으면 영원히 재시도하며 아무 말도 안 한다.
      if (!everConnected && retry >= 3) {
        wantOpen = false;
        emit('error', { why: '이 주소에서는 온라인 대전을 쓸 수 없습니다. server 폴더의 중계 서버로 실행해 주세요.' });
        return;
      }
      // 지수 백오프 — 잠자던 무료 서버가 깨어나는 데 시간이 걸린다
      const wait = Math.min(1000 * Math.pow(1.6, retry++), 8000);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => Net.connect(), wait);
    };

    ws.onerror = () => { /* onclose 가 이어서 온다 */ };

    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      receive(m);
    };
  };

  Net.disconnect = function () {
    wantOpen = false;
    clearTimeout(retryTimer);
    Net.code = null; Net.side = null; Net.isHost = false; Net.peerOnline = false;
    resetMasks();
    if (ws) { try { ws.close(); } catch (e) { } ws = null; }
  };

  function raw(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
    return false;
  }

  Net.createRoom = function (tc, side) { Net.connect(); waitOpen(() => raw({ t: 'create', tc, side })); };
  Net.joinRoom = function (code, tc) { Net.connect(); waitOpen(() => raw({ t: 'join', code, tc })); };
  Net.resign = function () { raw({ t: 'resign' }); };
  // 시계 멈춤/재개처럼 판을 바꾸지 않는 짧은 신호
  Net.note = function (kind, clock) { raw({ t: 'note', kind, clock }); };
  Net.askRematch = function () { raw({ t: 'rematch' }); };
  Net.abort = function () { raw({ t: 'abort' }); };
  Net.chat = function (text, emote) { raw({ t: 'chat', text, emote }); };
  Net.acceptRematch = function () { raw({ t: 'rematchOk' }); };

  function waitOpen(fn, tries) {
    tries = tries || 0;
    if (ws && ws.readyState === WebSocket.OPEN) { fn(); return; }
    if (tries > 200) { emit('error', { why: '서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.' }); return; }
    setTimeout(() => waitOpen(fn, tries + 1), 150);
  }

  function receive(m) {
    switch (m.t) {
      case 'created': Net.code = m.code; Net.side = m.side; Net.isHost = true; emit('created', m); return;
      case 'joined':
        Net.code = m.code; Net.side = m.side;
        if (!m.resumed) Net.isHost = false;
        if (m.resumed) loadVault();
        emit('joined', m);
        return;
      case 'peer': Net.peerOnline = !!m.online; emit('peer', m); return;
      case 'state': emit('state', m.s); return;
      case 'note': emit('note', m); return;
      case 'resign': emit('resign', m); return;
      case 'rematch': emit('rematch', m); return;
      case 'rematchOk': emit('rematchOk', m); return;
      case 'abort': emit('abort', m); return;
      case 'chat': emit('chat', m); return;
      case 'error': emit('error', m); return;
    }
  }

  /* ═══════════════════ 비밀 증강 가면 ═══════════════════ */

  let maskSeq = 0;
  const toMask = Object.create(null);     // 'B1c' -> '?w1'   (내 것만. 밖으로 안 나간다)
  const toReal = Object.create(null);     // '?w1' -> 'B1c'

  function resetMasks() {
    maskSeq = 0;
    sideCar = { flags: {}, tags: {} };
    for (const k of Object.keys(toMask)) delete toMask[k];
    for (const k of Object.keys(toReal)) delete toReal[k];
    try { sessionStorage.removeItem(VAULT_KEY); } catch (e) { }
  }
  Net.resetMasks = resetMasks;

  /* 가면 해독표는 주인 컴퓨터에만 있다. 새로고침으로 날아가면 서버에 보관된 판을
     다시 받았을 때 내 비밀 증강을 나조차 못 읽는다. 그래서 이 탭에 남겨 둔다.
     서버로도, 상대에게도 나가지 않는다. */
  const VAULT_KEY = 'mujeChess.vault';

  function saveVault() {
    try {
      sessionStorage.setItem(VAULT_KEY, JSON.stringify({
        code: Net.code, side: Net.side, seq: maskSeq, toReal, sideCar,
      }));
    } catch (e) { /* 시크릿 창 등 — 재접속 때만 아쉬워진다 */ }
  }

  function loadVault() {
    let v = null;
    try { v = JSON.parse(sessionStorage.getItem(VAULT_KEY) || 'null'); } catch (e) { return; }
    if (!v || v.code !== Net.code || v.side !== Net.side) return;   // 다른 방 것이면 버린다
    maskSeq = v.seq || 0;
    sideCar = v.sideCar || { flags: {}, tags: {} };
    for (const m of Object.keys(v.toReal || {})) { toReal[m] = v.toReal[m]; toMask[v.toReal[m]] = m; }
  }
  Net.loadVault = loadVault;

  // 상대가 보낸 가면을 UI·증강 코드가 다룰 수 있게 등록해 둔다.
  // B11c 가 AUG_BY_ID[id].piece 를 읽고, augCountFor 도 piece 로 세기 때문에
  // 기물·티어는 반드시 들어 있어야 한다.
  function registerStub(id, meta) {
    if (global.AUG_BY_ID[id]) return;
    global.AUG_BY_ID[id] = {
      id, piece: meta.piece, tier: meta.tier, type: meta.type || 'p',
      tag: '비밀', secret: true, hidden: true,
      text: '상대가 아직 공개하지 않은 비밀 증강입니다.', terms: [],
    };
  }

  // 내 비밀 증강 → 가면. 공개된 것은 그대로 둔다.
  function maskMine(ids, out) {
    return ids.map(id => {
      const a = global.AUG_BY_ID[id];
      if (!a || !a.secret || Game().G.revealed[id]) return id;      // 공개됐거나 비밀이 아님
      if (!toMask[id]) {
        const m = '?' + Net.side + (++maskSeq);
        toMask[id] = m; toReal[m] = id;
      }
      const m = toMask[id];
      out[m] = { piece: a.piece, tier: a.tier, type: a.type };
      return m;
    });
  }

  // 상대가 돌려준 내 목록에서 가면을 벗긴다 (내 map 으로만 가능하다)
  function unmaskMine(ids) { return ids.map(id => toReal[id] || id); }

  // 아직 공개되지 않은 내 비밀 증강 id 목록
  function mySecretIds() {
    const G = Game().G;
    if (!G || !Net.side) return [];
    return G.augs[Net.side].filter(id => {
      const a = global.AUG_BY_ID[id];
      return a && a.secret && !G.revealed[id];
    });
  }

  /* 증강 id 는 목록 말고도 두 군데에 그대로 남는다.
       - 예약 효과의 tag / 만료 효과의 expTag  (예: sched tag:'B1c')
       - flags 의 키                            (예: flags.b.B6c, flags.b.B11bArmed)
     둘 다 내보내기 전에 지우고, 되받을 때 내 기억으로 되돌린다.
     상대는 내 예약 효과를 발동시키지 않고(주인 검사가 있다), 엔진이 읽는 flags 는
     P1b·R3a·Q1aReady 뿐이라 비밀 증강 쪽을 지워도 상대 계산이 틀어지지 않는다. */
  let sideCar = { flags: {}, tags: {} };

  function hideMine(s) {
    const G = Game().G;
    const secrets = mySecretIds();
    sideCar = { flags: {}, tags: {} };
    if (!secrets.length) return s;

    const isMine = (v) => secrets.some(id => v === id || v.indexOf(id) === 0);

    // flags — 내 쪽에서 비밀 증강 이름을 딴 키만 들어낸다
    const mineFlags = {};
    for (const k of Object.keys(s.flags[Net.side] || {})) {
      if (isMine(k)) { sideCar.flags[k] = s.flags[Net.side][k]; continue; }
      mineFlags[k] = s.flags[Net.side][k];
    }
    s.flags = Object.assign({}, s.flags);
    s.flags[Net.side] = mineFlags;

    // 예약/만료 tag — 가면으로 바꾼다
    s.eff = s.eff.map(e => {
      if (e.owner !== Net.side) return e;
      const hit = ['tag', 'expTag'].filter(k => e[k] && isMine(e[k]));
      if (!hit.length) return e;
      const copy = Object.assign({}, e);
      sideCar.tags[e.uid] = {};
      for (const k of hit) { sideCar.tags[e.uid][k] = e[k]; copy[k] = toMask[e[k]] || '?'; }
      return copy;
    });
    return s;
  }

  function restoreMine(G) {
    Object.assign(G.flags[Net.side], sideCar.flags);
    for (const e of G.eff) {
      const keep = e.owner === Net.side && sideCar.tags[e.uid];
      if (keep) for (const k of Object.keys(keep)) e[k] = keep[k];
    }
  }

  /* ═══════════════════ 상태 직렬화 ═══════════════════ */

  const MAX_LOG = 400;

  function packBoard(bd) {
    const out = new Array(64);
    for (let i = 0; i < 64; i++) {
      const p = bd[i];
      out[i] = p ? [p.id, p.type, p.color, p.moved ? 1 : 0, p.augLost ? 1 : 0] : 0;
    }
    return out;
  }

  function unpackBoard(arr) {
    const bd = new Array(64).fill(null);
    for (let i = 0; i < 64; i++) {
      const c = arr[i];
      if (!c) continue;
      bd[i] = { id: c[0], type: c[1], color: c[2], moved: !!c[3], augLost: !!c[4] };
    }
    return bd;
  }

  /**
   * 지금 판을 상대에게 보낼 꼴로 만든다.
   * @param snapAdd 이 상태가 착수 때문이라면 {side, from, to} — 받는 쪽이 기록용 스냅샷을 만든다
   */
  Net.serialize = function (snapAdd) {
    const G = Game().G;
    const masks = {};
    const augs = {
      w: Net.side === 'w' ? maskMine(G.augs.w, masks) : G.augs.w.slice(),
      b: Net.side === 'b' ? maskMine(G.augs.b, masks) : G.augs.b.slice(),
    };
    // revealed 는 공개된 것만 담기므로 가릴 게 없다
    return hideMine({
      v: 1,
      bd: packBoard(G.bd),
      turn: G.turn, ply: G.ply, ep: G.ep, moveNo: G.moveNo, begunPly: G.begunPly,
      kills: G.kills, tierIdx: G.tierIdx,
      augs, masks,
      eff: G.eff, phased: G.phased, grave: G.grave,
      flags: G.flags, revealed: G.revealed,
      hist: G.hist, lastBySide: G.lastBySide,
      clock: G.clock, result: G.result,
      log: G.log.slice(-MAX_LOG),
      snapAdd: snapAdd || null,
      by: Net.side,
    });
  };

  // serialize 가 가면·sideCar 를 새로 만들므로, 내보낸 직후에 저장한다
  function afterSerialize() { saveVault(); }

  /** 받은 상태를 그대로 채택한다. 계산하지 않는다. */
  Net.adopt = function (s) {
    const G = Game().G;
    if (!G || !s) return;

    for (const id of Object.keys(s.masks || {})) registerStub(id, s.masks[id]);

    const prevRevealed = Object.keys(G.revealed || {});

    G.bd = unpackBoard(s.bd);
    G.turn = s.turn; G.ply = s.ply; G.ep = s.ep; G.moveNo = s.moveNo;
    G.begunPly = (s.begunPly === undefined ? -1 : s.begunPly);
    G.kills = s.kills; G.tierIdx = s.tierIdx;
    G.eff = s.eff || []; G.phased = s.phased || []; G.grave = s.grave;
    G.flags = s.flags; G.revealed = s.revealed || {};
    G.hist = s.hist || []; G.lastBySide = s.lastBySide || { w: null, b: null };
    G.clock = s.clock; G.result = s.result;
    G.log = s.log || [];

    // 내 쪽 목록에 내 가면이 섞여 돌아온다. 내 map 으로만 벗길 수 있다.
    G.augs = {
      w: Net.side === 'w' ? unmaskMine(s.augs.w) : s.augs.w.slice(),
      b: Net.side === 'b' ? unmaskMine(s.augs.b) : s.augs.b.slice(),
    };

    // 상대가 만든 기물·효과 id 와 부딪히지 않게 내 카운터를 밀어 올린다
    let maxId = 0;
    for (const p of G.bd) if (p && p.id > maxId) maxId = p.id;
    for (const e of G.eff) if (e.uid > maxId) maxId = e.uid;
    for (const x of G.phased) if (x.pc && x.pc.id > maxId) maxId = x.pc.id;
    E().bumpUID(maxId);

    restoreMine(G);

    if (s.snapAdd) Game().recordSnapshot(s.snapAdd.side, s.snapAdd.from, s.snapAdd.to);

    // 이번에 새로 공개된 비밀 증강을 알린다
    const now = Object.keys(G.revealed);
    return now.filter(id => prevRevealed.indexOf(id) < 0);
  };

  Net.push = function (snapAdd) {
    if (!Net.code) return false;
    const s = Net.serialize(snapAdd);
    afterSerialize();
    return raw({ t: 'state', s });
  };

})(window);
