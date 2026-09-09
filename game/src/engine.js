/* ============================================================
   무제체스 - 체스 엔진
   보드: 64칸 배열. index = r*8 + c
        r=0 이 8랭크(흑 진영), r=7 이 1랭크(백 진영)
        c=0 이 a파일
   백은 r 감소 방향(위쪽)으로 전진한다.
   ============================================================ */
(function (global) {
  'use strict';

  const FILES = 'abcdefgh';
  let UID = 0;

  const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const KO = { p: '폰', n: '나이트', b: '비숍', r: '룩', q: '퀸', k: '킹' };
  const KO2T = { '폰': 'p', '나이트': 'n', '비숍': 'b', '룩': 'r', '퀸': 'q', '킹': 'k' };

  const rc = (i) => [i >> 3, i & 7];
  const idx = (r, c) => r * 8 + c;
  const onBoard = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const sqName = (i) => FILES[i & 7] + (8 - (i >> 3));
  const other = (s) => (s === 'w' ? 'b' : 'w');
  const lightSquare = (i) => ((i >> 3) + (i & 7)) % 2 === 0;

  function mkPiece(type, color) {
    return { id: ++UID, type, color, moved: false, augLost: false };
  }

  // 온라인 대전에서 상대가 만든 판을 채택할 때, 그쪽 id 보다 뒤에서 다시 세게 한다
  function bumpUID(n) { if (n > UID) UID = n; }

  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

  function newGame() {
    const bd = new Array(64).fill(null);
    let i = 0;
    for (const ch of START) {
      if (ch === '/') continue;
      if (ch >= '1' && ch <= '8') { i += +ch; continue; }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      bd[i++] = mkPiece(ch.toLowerCase(), color);
    }
    return {
      bd,
      turn: 'w',
      ply: 0,
      ep: -1,                        // 앙파상 목표 칸
      kills: { w: 0, b: 0 },         // 처치 카운트
      augs: { w: [], b: [] },        // 보유 증강 id
      tierIdx: { w: 0, b: 0 },       // 소비한 티어 수(0~4)
      eff: [],                       // 활성 효과
      phased: [],                    // 포영 {pc, sq, owner, until, data}
      grave: { w: [], b: [] },       // 처치/제거된 아군 기물 (부활용)
      flags: { w: {}, b: {} },       // 1회성 플래그/카운터
      revealed: {},                  // 공개된 비밀 증강 id
      log: [],
      hist: [],                      // UCI 기보 (오프닝 북 조회용)
      lastBySide: { w: null, b: null },  // 진영별 마지막 수 (스트립 표시용)
      begunPly: -1,                  // beginTurn 을 이미 돌린 ply (온라인 재접속 시 중복 발동 방지)
      snaps: [],                     // 수마다의 판 스냅샷 (기록에서 되돌려 보기용)
      clock: null,                   // {w, b, inc, limit} ms. null 이면 무제한
      result: null,                  // {winner, reason}
      pendingDraft: null,
      moveNo: 1,
    };
  }

  /* ───────── 상태 조회 ───────── */

  function findKing(G, side) {
    for (let i = 0; i < 64; i++) {
      const p = G.bd[i];
      if (p && p.type === 'k' && p.color === side) return i;
    }
    return -1;
  }

  function piecesOf(G, side, type) {
    const out = [];
    for (let i = 0; i < 64; i++) {
      const p = G.bd[i];
      if (p && p.color === side && (!type || p.type === type)) out.push(i);
    }
    return out;
  }

  function materialScore(G, side) {
    let s = 0;
    for (const i of piecesOf(G, side)) s += VALUE[G.bd[i].type];
    return s;
  }

  /* ───────── 효과 헬퍼 ───────── */

  // 지속시간 계산. 증강 획득/발동 시점은 "내 수를 둔 직후"이므로
  //   내 N턴   = 2N 플라이
  //   상대 N턴 = 2N-1 플라이
  /* 두 헬퍼 모두 '호출 시점의 G.ply 는 효과 주인의 턴 ply' 라는 전제 위에 있다.
     (onGain / onCapture / onAfterMove / onTurnStart / onCheck / onOppMoved 전부 그렇다)
       주인의 턴 = P, P+2, P+4 …   /   상대의 턴 = P+1, P+3 …
     만료 검사(expireEffects)와 포영 복귀(returnPhased)는 G.ply 가 오른 '뒤'에 돌므로,
     until 은 "이 ply 가 되는 순간 사라진다" 를 뜻한다. */
  function untilMyTurns(G, n) { return G.ply + 2 * n; }        // 내 n번째 다음 턴이 시작될 때
  function untilOppTurns(G, n) { return G.ply + 2 * n; }       // 상대의 다음 n턴을 모두 덮는다

  function addEff(G, e) {
    e.uid = ++UID;
    G.eff.push(e);
    return e;
  }
  function effs(G, kind, owner) {
    return G.eff.filter(e => e.kind === kind && (owner === undefined || e.owner === owner));
  }
  function hasEff(G, kind, owner) { return effs(G, kind, owner).length > 0; }
  function dropEff(G, uid) { G.eff = G.eff.filter(e => e.uid !== uid); }

  // 만료된 효과를 떼어내 반환한다. 실제 후처리는 game.js 가 expTag 로 분기한다.
  // (G 안에는 함수를 저장하지 않는다 — AI 가 JSON 복제로 탐색하기 때문)
  function expireEffects(G) {
    const dead = G.eff.filter(e => e.until !== undefined && G.ply >= e.until);
    G.eff = G.eff.filter(e => e.until === undefined || G.ply < e.until);
    return dead;
  }

  // 지정불가: 움직일 수도, 처치 대상이 될 수도 없다
  function untouchable(G, pieceId) {
    return G.eff.some(e => e.kind === 'untargetable' && e.ids.includes(pieceId));
  }
  // 룩 면역(R3c)
  function immune(G, pc) {
    return pc && pc.type === 'r' && ownsAug(G, pc.color, 'R3c');
  }

  function ownsAug(G, side, id) { return G.augs[side].includes(id); }

  function augCountFor(G, side, koPiece) {
    return G.augs[side].filter(id => {
      const a = global.AUG_BY_ID[id];
      return a && a.piece === koPiece;
    }).length;
  }

  /* ───────── 기물 제거 / 포영 / 변이 ───────── */

  // 킹은 제거·포영·변이·교환·지정불가의 대상이 되지 않는다 (전역 룰)
  function protectedPiece(G, i) {
    const p = G.bd[i];
    return !p || p.type === 'k';
  }

  function removePiece(G, i, opts) {
    opts = opts || {};
    const p = G.bd[i];
    if (!p) return false;
    if (p.type === 'k') return false;                 // 전역 룰: 킹 보호
    if (immune(G, p) && !opts.force) return false;    // R3c
    G.bd[i] = null;
    G.grave[p.color].push(p.type);
    G.eff = G.eff.filter(e => !(e.ids && e.ids.includes(p.id) && e.dieWithPiece));
    G.log.push({ t: 'remove', sq: i, piece: p.type, color: p.color });
    // K1c: 자신의 모든 제거를 처치로 간주
    if (opts.by && ownsAug(G, opts.by, 'K1c') && p.color !== opts.by) {
      addKill(G, opts.by, 1, p);
    }
    return true;
  }

  function mutate(G, i, newType) {
    const p = G.bd[i];
    if (!p || p.type === 'k' || newType === 'k') return false;
    if (immune(G, p)) return false;
    G.log.push({ t: 'mutate', sq: i, from: p.type, to: newType });
    p.type = newType;
    return true;
  }

  function phaseOut(G, i, until, data) {
    const p = G.bd[i];
    if (!p || p.type === 'k') return false;
    if (immune(G, p)) return false;
    G.bd[i] = null;
    G.phased.push(Object.assign({ pc: p, sq: i, owner: p.color, until }, data || {}));
    G.log.push({ t: 'phase', sq: i, piece: p.type, color: p.color });
    return true;
  }

  // 포영 복귀: 그 칸에 기물이 있으면 피아 상관없이 제거
  function returnPhased(G) {
    const back = G.phased.filter(x => G.ply >= x.until);
    G.phased = G.phased.filter(x => G.ply < x.until);
    for (const x of back) {
      const occ = G.bd[x.sq];
      if (occ) {
        if (occ.type === 'k') {
          // 킹이 서 있으면 복귀 불가 → 가장 가까운 빈칸으로
          const alt = nearestEmpty(G, x.sq);
          if (alt < 0) { G.grave[x.owner].push(x.pc.type); continue; }
          G.bd[alt] = x.pc;
          G.log.push({ t: 'unphase', sq: alt, piece: x.pc.type, color: x.owner });
          continue;
        }
        removePiece(G, x.sq, { force: true });
      }
      G.bd[x.sq] = x.pc;
      G.log.push({ t: 'unphase', sq: x.sq, piece: x.pc.type, color: x.owner });
    }
  }

  function nearestEmpty(G, from) {
    const [fr, fc] = rc(from);
    let best = -1, bd = 99;
    for (let i = 0; i < 64; i++) {
      if (G.bd[i]) continue;
      const [r, c] = rc(i);
      const d = Math.max(Math.abs(r - fr), Math.abs(c - fc));
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // 교환: 어느 한쪽이라도 체크가 되면 불가
  function swapPieces(G, a, b) {
    const pa = G.bd[a], pb = G.bd[b];
    if (!pa || !pb) return false;
    if (pa.type === 'k' || pb.type === 'k') return false;
    if (immune(G, pa) || immune(G, pb)) return false;
    G.bd[a] = pb; G.bd[b] = pa;
    if (inCheck(G, 'w') || inCheck(G, 'b')) { G.bd[a] = pa; G.bd[b] = pb; return false; }
    G.log.push({ t: 'swap', a, b });
    return true;
  }

  function addKill(G, side, n, victim) {
    let mult = 1;
    // P3a: 폰으로 처치 시 카운팅 2배
    if (G._killByPawn && hasEff(G, 'pawnKillDouble', side)) mult = 2;
    // Q3c: 아군 퀸이 잡혀도 상대 카운트에 미포함
    if (victim && victim.type === 'q' && ownsAug(G, other(side), 'Q3c')) return;
    G.kills[side] += n * mult;
  }

  /* ═══════════════ 이동 생성 ═══════════════ */

  const DIR_R = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const DIR_B = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const DIR_Q = DIR_R.concat(DIR_B);
  const N_JUMP = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const N_JUMP2 = [[-4, -2], [-4, 2], [-2, -4], [-2, 4], [2, -4], [2, 4], [4, -2], [4, 2]];

  function mv(from, to, extra) {
    return Object.assign({ from, to }, extra || {});
  }

  /* 도약 기물이 '어떻게 갔는지'.
     실제로는 건너뛰므로 중간 칸이 막혀도 상관없지만, 그래서 더더욱
     어떤 길로 간 것인지 눈에 보여야 두는 쪽도 상대도 납득한다.
     from 과 to 는 빼고, 지나간 칸만 순서대로 돌려준다. */
  function leapPath(from, to) {
    const [r0, c0] = rc(from), [r1, c1] = rc(to);
    const dr = r1 - r0, dc = c1 - c0;
    const ar = Math.abs(dr), ac = Math.abs(dc);
    const sr = Math.sign(dr), sc = Math.sign(dc);

    // 보통 나이트 (2,1) — 긴 쪽으로 두 칸 간 뒤 옆으로 한 칸
    if (ar === 2 && ac === 1) return [idx(r0 + sr, c0), idx(r0 + dr, c0)];
    if (ac === 2 && ar === 1) return [idx(r0, c0 + sc), idx(r0, c0 + dc)];

    // N11b (4,2) — 직선으로 두 칸 + 대각선으로 두 칸
    if (ar === 4 && ac === 2) {
      return [idx(r0 + sr, c0), idx(r0 + 2 * sr, c0), idx(r0 + 3 * sr, c0 + sc)];
    }
    if (ac === 4 && ar === 2) {
      return [idx(r0, c0 + sc), idx(r0, c0 + 2 * sc), idx(r0 + sr, c0 + 3 * sc)];
    }
    return [];
  }

  function slide(G, from, dirs, side, out, phaseAllow) {
    phaseAllow = phaseAllow || 0;
    const [r0, c0] = rc(from);
    for (const [dr, dc] of dirs) {
      let r = r0 + dr, c = c0 + dc, passed = 0;
      while (onBoard(r, c)) {
        const i = idx(r, c), t = G.bd[i];
        if (!t) { out.push(mv(from, i)); }
        else if (untouchable(G, t.id)) {
          if (passed < phaseAllow) { passed++; } else break;
        }
        else if (t.color !== side) {
          out.push(mv(from, i, { capture: true }));
          if (passed < phaseAllow) { passed++; } else break;
        }
        else {
          if (passed < phaseAllow) { passed++; } else break;
        }
        r += dr; c += dc;
      }
    }
  }

  function jumps(G, from, offs, side, out) {
    const [r0, c0] = rc(from);
    for (const [dr, dc] of offs) {
      const r = r0 + dr, c = c0 + dc;
      if (!onBoard(r, c)) continue;
      const i = idx(r, c), t = G.bd[i];
      if (t && (t.color === side || untouchable(G, t.id))) continue;
      out.push(mv(from, i, { capture: !!t }));
    }
  }

  function promotionRank(side) { return side === 'w' ? 0 : 7; }

  // 폰 승격 판정 (P11c: 판의 어느 변이든 도달하면 승격)
  function isPromoSquare(G, side, to) {
    const [r, c] = rc(to);
    if (r === promotionRank(side)) return true;
    if (ownsAug(G, side, 'P11c')) return r === 0 || r === 7 || c === 0 || c === 7;
    return false;
  }

  function genPawn(G, from, side, out) {
    const dir = side === 'w' ? -1 : 1;
    const [r0, c0] = rc(from);
    const step = ownsAug(G, side, 'P11a') ? 2 : 1;    // P11a: 2칸씩 행동
    const push = (to, extra) => {
      if (isPromoSquare(G, side, to)) {
        for (const q of ['q', 'r', 'b', 'n']) out.push(mv(from, to, Object.assign({ promo: q }, extra)));
      } else out.push(mv(from, to, extra));
    };

    // 전진 (중간 칸 통과 불가)
    for (let k = 1; k <= step; k++) {
      const r = r0 + dir * k;
      if (!onBoard(r, c0)) break;
      const i = idx(r, c0);
      if (G.bd[i]) {
        // P6b: 정면 처치
        if (ownsAug(G, side, 'P6b') && G.bd[i].color !== side && !untouchable(G, G.bd[i].id)) {
          push(i, { capture: true });
        }
        break;
      }
      push(i);
    }
    // 초기 2칸 (기본 규칙)
    if (!G.bd[from].moved) {
      const r1 = r0 + dir, r2 = r0 + dir * 2;
      if (onBoard(r2, c0) && !G.bd[idx(r1, c0)] && !G.bd[idx(r2, c0)]) {
        out.push(mv(from, idx(r2, c0), { double: true }));
      }
    }
    // P1b: 다음 1회 두 번 전진.
    // 아직 안 움직인 폰이면 (2칸 + 1칸) = 3칸, 이미 움직인 폰이면 (1칸 + 1칸) = 2칸이 최대다.
    if (G.flags[side].P1b > 0) {
      const far = G.bd[from].moved ? 2 : 3;
      let clear = true;
      for (let k = 1; k <= far; k++) {
        const r = r0 + dir * k;
        if (!onBoard(r, c0) || G.bd[idx(r, c0)]) { clear = false; break; }
      }
      if (clear) push(idx(r0 + dir * far, c0), { p1b: true });
    }
    // 대각 처치
    for (let k = 1; k <= step; k++) {
      for (const dc of [-1, 1]) {
        const r = r0 + dir * k, c = c0 + dc * k;
        if (!onBoard(r, c)) continue;
        // 중간 칸 통과 불가
        if (k === 2) { const m = idx(r0 + dir, c0 + dc); if (G.bd[m]) continue; }
        const i = idx(r, c), t = G.bd[i];
        if (t && t.color !== side && !untouchable(G, t.id)) push(i, { capture: true });
        else if (!t && k === 1 && i === G.ep) out.push(mv(from, i, { capture: true, ep: true }));
      }
    }
    // P3b: 후진 (처치 불가)
    if (ownsAug(G, side, 'P3b')) {
      for (let k = 1; k <= step; k++) {
        const r = r0 - dir * k;
        if (!onBoard(r, c0)) break;
        const i = idx(r, c0);
        if (G.bd[i]) break;
        push(i, { back: true });
      }
    }
    // P6a: 좌우 이동 (처치 불가)
    if (ownsAug(G, side, 'P6a')) {
      for (const dc of [-1, 1]) {
        for (let k = 1; k <= step; k++) {
          const c = c0 + dc * k;
          if (!onBoard(r0, c)) break;
          const i = idx(r0, c);
          if (G.bd[i]) break;
          push(i, { side: true });
        }
      }
    }
    // R3a: 지정된 폰이 룩처럼 (처치 불가)
    if (G.flags[side].R3a && G.flags[side].R3a.id === G.bd[from].id) {
      const tmp = [];
      slide(G, from, DIR_R, side, tmp);
      for (const m of tmp) if (!m.capture) out.push(mv(from, m.to, { rookLike: true }));
    }
  }

  function genPiece(G, from, out) {
    const p = G.bd[from];
    if (!p) return;
    const side = p.color;
    switch (p.type) {
      case 'p': genPawn(G, from, side, out); break;
      case 'n':
        jumps(G, from, N_JUMP, side, out);
        if (ownsAug(G, side, 'N11b')) jumps(G, from, N_JUMP2, side, out); // 범위 2배
        break;
      case 'b':
        slide(G, from, DIR_B, side, out);
        // B11b: 퀸이 죽어있는 동안 퀸처럼
        if (hasEff(G, 'bishopAsQueen', side)) slide(G, from, DIR_R, side, out);
        break;
      case 'r': {
        const ph = ownsAug(G, side, 'R11a') ? 2 : (ownsAug(G, side, 'R1a') ? 1 : 0);
        slide(G, from, DIR_R, side, out, ph);
        break;
      }
      case 'q':
        slide(G, from, DIR_Q, side, out);
        if (ownsAug(G, side, 'Q6b') && augCountFor(G, side, '퀸') >= 1) jumps(G, from, N_JUMP, side, out);
        // Q1a: 긴 대각선 순간이동
        if (G.flags[side].Q1aReady === from) {
          for (const i of longDiagOf(from)) if (!G.bd[i]) out.push(mv(from, i, { teleport: true }));
        }
        // Q11c: 아군 킹 인접 빈칸으로 귀환
        if (ownsAug(G, side, 'Q11c')) {
          const k = findKing(G, side);
          if (k >= 0) {
            const [kr, kc] = rc(k);
            for (const [dr, dc] of DIR_Q) {
              const r = kr + dr, c = kc + dc;
              if (onBoard(r, c) && !G.bd[idx(r, c)]) out.push(mv(from, idx(r, c), { teleport: true }));
            }
          }
        }
        break;
      case 'k':
        jumps(G, from, DIR_Q, side, out);
        genCastle(G, from, side, out);
        break;
    }
  }

  function longDiagOf(i) {
    const [r, c] = rc(i);
    const out = [];
    if (r === c) for (let k = 0; k < 8; k++) out.push(idx(k, k));
    if (r + c === 7) for (let k = 0; k < 8; k++) out.push(idx(k, 7 - k));
    return out.filter(x => x !== i);
  }

  function genCastle(G, from, side, out) {
    const k = G.bd[from];
    const free = ownsAug(G, side, 'R11c');   // R11c: 조건 무시
    if (!free && (k.moved || inCheck(G, side))) return;
    const [r0] = rc(from);
    for (const rookC of [0, 7]) {
      const ri = idx(r0, rookC);
      const rook = G.bd[ri];
      if (!rook || rook.type !== 'r' || rook.color !== side) continue;
      if (!free && rook.moved) continue;
      const kc = from & 7;
      // 킹과 룩 사이가 2칸 미만이면 캐슬링 좌표가 판을 벗어난다 (R11c 로 킹이 룩 옆에 있는 경우)
      if (Math.abs(kc - rookC) < 3) continue;
      const dir = rookC === 0 ? -1 : 1;
      let ok = true;
      for (let c = kc + dir; c !== rookC; c += dir) if (G.bd[idx(r0, c)]) { ok = false; break; }
      if (!ok) continue;
      const kTo = idx(r0, kc + dir * 2);
      if (!free) {
        let safe = true;
        for (let s = 0; s <= 2; s++) {
          const t = idx(r0, kc + dir * s);
          if (attacked(G, t, other(side))) { safe = false; break; }
        }
        if (!safe) continue;
      }
      const rookTo = idx(r0, kc + dir);
      if (rookTo === ri) continue;                 // 룩이 제자리면 캐슬링이 성립하지 않는다
      out.push(mv(from, kTo, { castle: rookC === 0 ? 'q' : 'k', rookFrom: ri, rookTo }));
    }
  }

  /* ───── 공격 판정 (효과 무시, 순수 기하) ───── */
  function attacked(G, sq, by) {
    const [r0, c0] = rc(sq);
    // 폰
    const dir = by === 'w' ? -1 : 1;
    for (const dc of [-1, 1]) {
      const r = r0 - dir, c = c0 - dc;
      if (onBoard(r, c)) { const p = G.bd[idx(r, c)]; if (p && p.color === by && p.type === 'p') return true; }
    }
    if (ownsAug(G, by, 'P6b')) {
      const r = r0 - dir;
      if (onBoard(r, c0)) { const p = G.bd[idx(r, c0)]; if (p && p.color === by && p.type === 'p') return true; }
    }
    // 나이트
    const nOff = ownsAug(G, by, 'N11b') ? N_JUMP.concat(N_JUMP2) : N_JUMP;
    for (const [dr, dc] of nOff) {
      const r = r0 + dr, c = c0 + dc;
      if (onBoard(r, c)) { const p = G.bd[idx(r, c)]; if (p && p.color === by && p.type === 'n') return true; }
    }
    // 킹
    for (const [dr, dc] of DIR_Q) {
      const r = r0 + dr, c = c0 + dc;
      if (onBoard(r, c)) { const p = G.bd[idx(r, c)]; if (p && p.color === by && p.type === 'k') return true; }
    }
    // 슬라이더
    const rookPhase = ownsAug(G, by, 'R11a') ? 2 : (ownsAug(G, by, 'R1a') ? 1 : 0);
    const bishopQ = hasEff(G, 'bishopAsQueen', by);
    const scan = (dirs, types, phase) => {
      for (const [dr, dc] of dirs) {
        let r = r0 + dr, c = c0 + dc, passed = 0;
        while (onBoard(r, c)) {
          const p = G.bd[idx(r, c)];
          if (p) {
            if (p.color === by && types.includes(p.type)) return true;
            if (passed < phase) passed++; else break;
          }
          r += dr; c += dc;
        }
      }
      return false;
    };
    if (scan(DIR_R, ['r'], rookPhase)) return true;
    if (scan(DIR_R, ['q'], 0)) return true;
    if (bishopQ && scan(DIR_R, ['b'], 0)) return true;
    if (scan(DIR_B, ['b', 'q'], 0)) return true;
    // Q6b: 퀸의 나이트 이동
    if (ownsAug(G, by, 'Q6b') && augCountFor(G, by, '퀸') >= 1) {
      for (const [dr, dc] of N_JUMP) {
        const r = r0 + dr, c = c0 + dc;
        if (onBoard(r, c)) { const p = G.bd[idx(r, c)]; if (p && p.color === by && p.type === 'q') return true; }
      }
    }
    return false;
  }

  function inCheck(G, side) {
    const k = findKing(G, side);
    if (k < 0) return false;
    return attacked(G, k, other(side));
  }

  /* ───── 이동 제한 효과 ───── */
  // 체크에서 벗어나는 수에는 제한이 적용되지 않는다 (전역 룰)
  function restrictedBy(G, side, from, to) {
    const p = G.bd[from];
    if (!p) return null;

    // 지정불가 기물은 움직일 수 없다
    if (untouchable(G, p.id)) return '지정불가';

    // B1b: 비숍 고정
    if (p.type === 'b' && G.eff.some(e => e.kind === 'bishopRoot' && e.ids.includes(p.id))) return '비숍 고정';

    // N3b: 나이트만 사용 가능
    const nOnly = effs(G, 'knightOnly').length > 0;
    if (nOnly && p.type !== 'n' && piecesOf(G, side, 'n').length > 0) return '나이트만 이동 가능';

    // R6a/R6b: 기준 룩보다 위/아래로 이동 금지
    for (const e of effs(G, 'rookLine')) {
      if (e.target !== side) continue;
      const ref = e.refSq;
      if (ref === undefined || ref < 0) continue;
      const rr = ref >> 3, tr = to >> 3;
      // 'up' = 상대 진영 방향 = 랭크 번호가 커지는 쪽(화면상 위)
      const upIsMinus = side === 'w';
      const goesUp = upIsMinus ? tr < rr : tr > rr;
      if (e.dir === 'up' && goesUp) return '룩 위쪽 이동 금지';
      if (e.dir === 'down' && !goesUp && tr !== rr) return '룩 아래쪽 이동 금지';
    }
    return null;
  }

  function genPseudo(G, from) {
    const out = [];
    genPiece(G, from, out);
    return out;
  }

  function applyRaw(G, m) {
    const undo = { m, cap: G.bd[m.to], capSq: m.to, ep: G.ep, moved: null, promoFrom: null, rook: null };
    const p = G.bd[m.from];
    // 방어: 증강 효과로 기물이 사라진 뒤 낡은 수가 들어오면 조용히 무시한다
    if (!p || (m.castle && !G.bd[m.rookFrom])) {
      console.warn('applyRaw: 빈 칸에서 출발하는 수를 무시했습니다', m);
      undo.noop = true;
      return undo;
    }
    if (m.ep) { const capSq = idx(m.from >> 3, m.to & 7); undo.cap = G.bd[capSq]; undo.capSq = capSq; G.bd[capSq] = null; }
    G.bd[m.from] = null;
    G.bd[m.to] = p;
    undo.moved = p.moved;
    p.moved = true;
    if (m.promo) { undo.promoFrom = p.type; p.type = m.promo; }
    if (m.castle) { undo.rook = { from: m.rookFrom, to: m.rookTo, moved: G.bd[m.rookFrom].moved }; G.bd[m.rookTo] = G.bd[m.rookFrom]; G.bd[m.rookFrom] = null; G.bd[m.rookTo].moved = true; }
    G.ep = m.double ? idx((m.from >> 3) + ((m.to >> 3) - (m.from >> 3)) / 2, m.from & 7) : -1;
    return undo;
  }

  function undoRaw(G, u) {
    if (u.noop) return;
    const m = u.m, p = G.bd[m.to];
    G.bd[m.to] = null;
    if (u.promoFrom) p.type = u.promoFrom;
    p.moved = u.moved;
    G.bd[m.from] = p;
    if (u.cap) G.bd[u.capSq] = u.cap;
    if (u.rook) { G.bd[u.rook.from] = G.bd[u.rook.to]; G.bd[u.rook.to] = null; G.bd[u.rook.from].moved = u.rook.moved; }
    G.ep = u.ep;
  }

  // 킹과 같은 줄(가로·세로·대각)에 있지 않은 기물은 움직여도 킹을 노출시킬 수 없다
  function alignedWithKing(from, kSq) {
    if (kSq < 0) return true;
    const dr = (from >> 3) - (kSq >> 3), dc = (from & 7) - (kSq & 7);
    return dr === 0 || dc === 0 || Math.abs(dr) === Math.abs(dc);
  }

  // escaping / kSq 는 allLegal 이 한 번만 계산해 넘겨준다 (수마다 재계산하면 느리다)
  function legalMoves(G, from, escaping, kSq, capturesOnly) {
    const p = G.bd[from];
    if (!p || p.color !== G.turn) return [];
    const side = p.color;
    if (escaping === undefined) escaping = inCheck(G, side);
    if (kSq === undefined) kSq = findKing(G, side);
    const isKing = p.type === 'k';
    const needTest = escaping || isKing || alignedWithKing(from, kSq);
    const foe = other(side);
    const out = [];
    for (const m of genPseudo(G, from)) {
      if (capturesOnly && !m.capture && !m.promo) continue;
      if (!G.bd[m.from]) continue;
      if (m.castle && !G.bd[m.rookFrom]) continue;
      // 체크 중이거나, 킹 이동이거나, 핀 가능 위치거나, 앙파상(가로줄 노출)일 때만 실제 검사
      if (needTest || m.ep) {
        const u = applyRaw(G, m);
        // 킹이 움직이지 않았다면 킹 위치를 다시 찾을 필요가 없다
        const still = isKing ? inCheck(G, side) : attacked(G, kSq, foe);
        undoRaw(G, u);
        if (still) continue;
      }
      // 제한 효과 (체크 회피 시 면제)
      if (!escaping && restrictedBy(G, side, from, m.to)) continue;
      out.push(m);
    }
    return out;
  }

  function allLegal(G, side, capturesOnly) {
    side = side || G.turn;
    const out = [];
    const save = G.turn; G.turn = side;
    const kSq = findKing(G, side);
    const escaping = kSq >= 0 && attacked(G, kSq, other(side));
    for (let i = 0; i < 64; i++) {
      const p = G.bd[i];
      if (!p || p.color !== side) continue;
      const ms = legalMoves(G, i, escaping, kSq, capturesOnly);
      for (let k = 0; k < ms.length; k++) out.push(ms[k]);
    }
    G.turn = save;
    return out;
  }

  // 제한 때문에 수가 0이면 제한을 무시하고 다시 확인 (게임 정지 방지)
  function allLegalRelaxed(G, side) {
    let ms = allLegal(G, side);
    if (ms.length) return { moves: ms, relaxed: false };
    const savedEff = G.eff;
    G.eff = G.eff.filter(e => !['knightOnly', 'rookLine', 'bishopRoot'].includes(e.kind));
    ms = allLegal(G, side);
    G.eff = savedEff;
    return { moves: ms, relaxed: ms.length > 0 };
  }

  function statusOf(G, side) {
    const { moves } = allLegalRelaxed(G, side);
    if (moves.length) return inCheck(G, side) ? 'check' : 'ok';
    return inCheck(G, side) ? 'checkmate' : 'stalemate';
  }

  global.Engine = {
    FILES, VALUE, KO, KO2T, START,
    rc, idx, onBoard, sqName, other, lightSquare, mkPiece, bumpUID, leapPath,
    newGame, findKing, piecesOf, materialScore,
    untilMyTurns, untilOppTurns, addEff, effs, hasEff, dropEff, expireEffects,
    untouchable, immune, ownsAug, augCountFor, protectedPiece,
    removePiece, mutate, phaseOut, returnPhased, swapPieces, addKill, nearestEmpty,
    DIR_R, DIR_B, DIR_Q, N_JUMP, N_JUMP2, longDiagOf,
    genPseudo, legalMoves, allLegal, allLegalRelaxed, inCheck, attacked, statusOf,
    applyRaw, undoRaw, restrictedBy, isPromoSquare, promotionRank,
  };
})(window);
