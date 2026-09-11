/* 대국 통계 — 판이 끝날 때 요약 한 번만 보낸다.

   보내는 곳은 수퍼베이스가 아니라 우리 릴레이(`/api/stat`)다.
   정적 사이트라 브라우저에 넣은 키는 누구나 볼 수 있어서, 키는 서버에만 둔다.

   단위는 '한 판' 이 아니라 '한 사람이 겪은 한 판' 이다.
   온라인에서는 상대의 비밀 증강이 내 화면에 가면으로만 오므로 상대 줄을 대신 쓸 수 없다.
   그래서 각자 자기 것만 보낸다 — 두 컴퓨터가 대국 id 를 맞출 필요도 없어진다. */
(function (global) {
  'use strict';

  const ENDPOINT = '/api/stat';
  const CID_KEY = 'mujeChess.cid';
  const OPT_KEY = 'mujeChess.stats';       // 'off' 면 안 보낸다

  const Stats = {};
  let cur = null;                          // 지금 판의 수집통

  /* ───────── 익명 id ─────────
     기기를 세기 위한 임의의 값이다. 이것 말고는 사람에 대한 건 아무것도 안 보낸다. */
  function uuid() {
    try { if (global.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { }
    // randomUUID 가 없는 브라우저(구형·http 환경)용
    const b = new Uint8Array(16);
    (global.crypto && crypto.getRandomValues)
      ? crypto.getRandomValues(b)
      : b.forEach((_, i) => { b[i] = (Math.random() * 256) | 0; });
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function clientId() {
    try {
      let v = localStorage.getItem(CID_KEY);
      if (!v) { v = uuid(); localStorage.setItem(CID_KEY, v); }
      return v;
    } catch (e) { return null; }          // 저장을 막아 둔 브라우저면 그냥 없이 간다
  }

  Stats.enabled = function () {
    try { return localStorage.getItem(OPT_KEY) !== 'off'; } catch (e) { return true; }
  };
  Stats.setEnabled = function (on) {
    try { localStorage.setItem(OPT_KEY, on ? 'on' : 'off'); } catch (e) { }
  };

  // 배포된 버전. bump.py 가 갱신하는 ?v= 스탬프를 그대로 쓴다 — 따로 관리할 필요가 없다.
  function appVersion() {
    try {
      const s = document.querySelector('script[src*="stats.js"]');
      const m = s && s.src.match(/[?&]v=([0-9a-z]+)/);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  /* ───────── 수집 ───────── */

  function blank() {
    return { moves: {}, kills: {} };
  }

  /* 고민 시간과 '시간초과로 무작위' 여부는 화면 쪽만 안다.
     기록은 game.js 의 드래프트 자리 한 곳에서 남기므로, 화면이 여기에 얹어 두고 그때 같이 담는다. */
  let pendingMeta = null;
  Stats.pickMeta = function (thinkMs, auto) { pendingMeta = { thinkMs: thinkMs, auto: auto }; };

  Stats.begin = function (meta) {
    cur = {
      startedAt: Date.now(),
      mode: meta.mode,
      difficulty: meta.difficulty || null,
      tc: meta.tc || null,
      room: meta.room || null,
      mySide: meta.mySide || null,
      per: { w: blank(), b: blank() },
      picks: [],
    };
  };

  /** 수 하나. 승격 전 종류로 센다 — '무엇으로 두었나' 가 궁금한 것이라서. */
  Stats.moved = function (side, type, victimType) {
    if (!cur) return;
    const p = cur.per[side];
    if (!p) return;
    p.moves[type] = (p.moves[type] || 0) + 1;
    if (victimType) p.kills[type] = (p.kills[type] || 0) + 1;
  };

  /** 증강을 고른 순간. 안 고르고 지나간 경우(chosen 없음)도 남긴다. */
  Stats.picked = function (o) {
    const meta = pendingMeta; pendingMeta = null;
    if (!cur || cur.picks.length >= 40) return;
    cur.picks.push({
      side: o.side,
      ply: o.ply | 0,
      tier: o.tier | 0,
      piece: o.piece || null,
      offered: (o.offer || []).map(x => x.aug.id),
      blocked: (o.offer || []).filter(x => x.block).map(x => x.aug.id),
      chosen: o.chosen || null,
      think_ms: meta ? Math.max(0, meta.thinkMs | 0) : null,
      auto: meta ? !!meta.auto : false,
      is_ai: !!o.isAI,
    });
  };

  /* ───────── 전송 ───────── */

  function post(body) {
    const json = JSON.stringify(body);
    try {
      // 판이 끝나고 바로 창을 닫아도 나가도록
      if (navigator.sendBeacon) {
        const ok = navigator.sendBeacon(ENDPOINT, new Blob([json], { type: 'application/json' }));
        if (ok) return;
      }
    } catch (e) { }
    try {
      fetch(ENDPOINT, {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: json,
      }).catch(() => { });
    } catch (e) { }
  }

  /**
   * 판이 끝났을 때. 중단(aborted)은 부르지 않는다 — 승패가 아니라서 통계로 의미가 없다.
   * @param G  엔진 상태
   * @param gm Game 모듈 (mode·aiSide·mySide)
   */
  Stats.end = function (G, gm, result) {
    const c = cur;
    cur = null;
    if (!c || !G || !result || result.aborted) return;
    if (!Stats.enabled()) return;

    const dur = Date.now() - c.startedAt;
    // 온라인은 내 것만. 상대의 비밀 증강을 내가 모르니 상대 줄을 대신 쓸 수 없다.
    const sides = (c.mode === 'online')
      ? (c.mySide ? [c.mySide] : [])
      : ['w', 'b'];

    const playId = {};
    const plays = sides.map(side => {
      const id = uuid();
      playId[side] = id;
      const opp = side === 'w' ? 'b' : 'w';
      return {
        id,
        client_id: clientId(),
        app_version: appVersion(),
        mode: c.mode,
        difficulty: c.difficulty,
        tc: c.tc,
        room: c.room,
        side,
        is_ai: c.mode === 'ai' && side === gm.aiSide,
        outcome: !result.winner ? 'draw' : (result.winner === side ? 'win' : 'lose'),
        reason: result.reason || null,
        moves: G.moveNo | 0,
        plies: G.ply | 0,
        duration_ms: dur,
        kills: G.kills[side] | 0,
        opp_kills: G.kills[opp] | 0,
        tier_reached: G.tierIdx[side] | 0,
        augs: (G.augs[side] || []).slice(),
        piece_moves: c.per[side].moves,
        piece_kills: c.per[side].kills,
      };
    });
    if (!plays.length) return;

    const picks = c.picks
      .filter(p => playId[p.side])
      .map(p => {
        const row = Object.assign({ id: uuid(), play_id: playId[p.side] }, p);
        delete row.side;                   // play_id 로 이미 알 수 있다
        return row;
      });

    post({ plays, picks });
  };

  global.Stats = Stats;
})(window);
