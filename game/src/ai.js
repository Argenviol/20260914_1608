/* ============================================================
   무제체스 - AI

   구조
     · 오프닝 북      정석 오프닝 15종. 증강이 하나도 없는 초반에만 사용
     · 평가 함수      재료 + 위치(개막/종반 보간) + 킹 안전 + 폰 구조 +
                     기동성 + 중앙 + 전개 + 증강 진행도
     · 탐색          반복심화 + 알파베타 + 정지탐색(교환 정리) +
                     MVV-LVA / 킬러 / 히스토리 정렬 + 전치표
     · 난이도        시간 예산으로 조절. 어려움은 갈 수 있는 만큼 깊게 본다
   ============================================================ */
(function (global) {
  'use strict';
  const E = global.Engine;

  /* ═══════════ 기물 가치 (개막 / 종반) ═══════════ */
  const MG = { p: 100, n: 325, b: 340, r: 500, q: 950, k: 0 };
  const EG = { p: 125, n: 320, b: 350, r: 560, q: 980, k: 0 };
  // 국면 판정용 가중치
  const PHASE_W = { p: 0, n: 1, b: 1, r: 2, q: 4, k: 0 };
  const PHASE_MAX = 24;

  /* ═══════════ 위치 테이블 (백 기준, 배열 index = 보드 index) ═══════════ */
  const PST_MG = {
    p: [
      0, 0, 0, 0, 0, 0, 0, 0,
      98, 134, 61, 95, 68, 126, 34, -11,
      -6, 7, 26, 31, 65, 56, 25, -20,
      -14, 13, 6, 21, 23, 12, 17, -23,
      -27, -2, -5, 12, 17, 6, 10, -25,
      -26, -4, -4, -10, 3, 3, 33, -12,
      -35, -1, -20, -23, -15, 24, 38, -22,
      0, 0, 0, 0, 0, 0, 0, 0],
    n: [
      -167, -89, -34, -49, 61, -97, -15, -107,
      -73, -41, 72, 36, 23, 62, 7, -17,
      -47, 60, 37, 65, 84, 129, 73, 44,
      -9, 17, 19, 53, 37, 69, 18, 22,
      -13, 4, 16, 13, 28, 19, 21, -8,
      -23, -9, 12, 10, 19, 17, 25, -16,
      -29, -53, -12, -3, -1, 18, -14, -19,
      -105, -21, -58, -33, -17, -28, -19, -23],
    b: [
      -29, 4, -82, -37, -25, -42, 7, -8,
      -26, 16, -18, -13, 30, 59, 18, -47,
      -16, 37, 43, 40, 35, 50, 37, -2,
      -4, 5, 19, 50, 37, 37, 7, -2,
      -6, 13, 13, 26, 34, 12, 10, 4,
      0, 15, 15, 15, 14, 27, 18, 10,
      4, 15, 16, 0, 7, 21, 33, 1,
      -33, -3, -14, -21, -13, -12, -39, -21],
    r: [
      32, 42, 32, 51, 63, 9, 31, 43,
      27, 32, 58, 62, 80, 67, 26, 44,
      -5, 19, 26, 36, 17, 45, 61, 16,
      -24, -11, 7, 26, 24, 35, -8, -20,
      -36, -26, -12, -1, 9, -7, 6, -23,
      -45, -25, -16, -17, 3, 0, -5, -33,
      -44, -16, -20, -9, -1, 11, -6, -71,
      -19, -13, 1, 17, 16, 7, -37, -26],
    q: [
      -28, 0, 29, 12, 59, 44, 43, 45,
      -24, -39, -5, 1, -16, 57, 28, 54,
      -13, -17, 7, 8, 29, 56, 47, 57,
      -27, -27, -16, -16, -1, 17, -2, 1,
      -9, -26, -9, -10, -2, -4, 3, -3,
      -14, 2, -11, -2, -5, 2, 14, 5,
      -35, -8, 11, 2, 8, 15, -3, 1,
      -1, -18, -9, 10, -15, -25, -31, -50],
    k: [
      -65, 23, 16, -15, -56, -34, 2, 13,
      29, -1, -20, -7, -8, -4, -38, -29,
      -9, 24, 2, -16, -20, 6, 22, -22,
      -17, -20, -12, -27, -30, -25, -14, -36,
      -49, -1, -27, -39, -46, -44, -33, -51,
      -14, -14, -22, -46, -44, -30, -15, -27,
      1, 7, -8, -64, -43, -16, 9, 8,
      -15, 36, 12, -54, 8, -28, 24, 14],
  };
  const PST_EG = {
    p: [
      0, 0, 0, 0, 0, 0, 0, 0,
      178, 173, 158, 134, 147, 132, 165, 187,
      94, 100, 85, 67, 56, 53, 82, 84,
      32, 24, 13, 5, -2, 4, 17, 17,
      13, 9, -3, -7, -7, -8, 3, -1,
      4, 7, -6, 1, 0, -5, -1, -8,
      13, 8, 8, 10, 13, 0, 2, -7,
      0, 0, 0, 0, 0, 0, 0, 0],
    n: [
      -58, -38, -13, -28, -31, -27, -63, -99,
      -25, -8, -25, -2, -9, -25, -24, -52,
      -24, -20, 10, 9, -1, -9, -19, -41,
      -17, 3, 22, 22, 22, 11, 8, -18,
      -18, -6, 16, 25, 16, 17, 4, -18,
      -23, -3, -1, 15, 10, -3, -20, -22,
      -42, -20, -10, -5, -2, -20, -23, -44,
      -29, -51, -23, -15, -22, -18, -50, -64],
    b: [
      -14, -21, -11, -8, -7, -9, -17, -24,
      -8, -4, 7, -12, -3, -13, -4, -14,
      2, -8, 0, -1, -2, 6, 0, 4,
      -3, 9, 12, 9, 14, 10, 3, 2,
      -6, 3, 13, 19, 7, 10, -3, -9,
      -12, -3, 8, 10, 13, 3, -7, -15,
      -14, -18, -7, -1, 4, -9, -15, -27,
      -23, -9, -23, -5, -9, -16, -5, -17],
    r: [
      13, 10, 18, 15, 12, 12, 8, 5,
      11, 13, 13, 11, -3, 3, 8, 3,
      7, 7, 7, 5, 4, -3, -5, -3,
      4, 3, 13, 1, 2, 1, -1, 2,
      3, 5, 8, 4, -5, -6, -8, -11,
      -4, 0, -5, -1, -7, -12, -8, -16,
      -6, -6, 0, 2, -9, -9, -11, -3,
      -9, 2, 3, -1, -5, -13, 4, -20],
    q: [
      -9, 22, 22, 27, 27, 19, 10, 20,
      -17, 20, 32, 41, 58, 25, 30, 0,
      -20, 6, 9, 49, 47, 35, 19, 9,
      3, 22, 24, 45, 57, 40, 57, 36,
      -18, 28, 19, 47, 31, 34, 39, 23,
      -16, -27, 15, 6, 9, 17, 10, 5,
      -22, -23, -30, -16, -16, -23, -36, -32,
      -33, -28, -22, -43, -5, -32, -20, -41],
    k: [
      -74, -35, -18, -18, -11, 15, 4, -17,
      -12, 17, 14, 17, 17, 38, 23, 11,
      10, 17, 23, 15, 20, 45, 44, 13,
      -8, 22, 24, 27, 26, 33, 26, 3,
      -18, -4, 21, 24, 27, 23, 9, -11,
      -19, -3, 11, 21, 23, 16, 7, -9,
      -27, -11, 4, 13, 14, 4, -5, -17,
      -53, -34, -21, -11, -28, -14, -24, -43],
  };

  // 흑은 상하 반전
  const mirror = (i) => ((7 - (i >> 3)) << 3) | (i & 7);

  /* ═══════════ 오프닝 북 ═══════════ */
  // 정석 오프닝. 각 줄은 첫 수부터의 연속수(UCI 표기).
  const BOOK_LINES = [
    // 1.e4 e5
    'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1',      // 루이 로페즈
    'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d4',      // 이탈리안 게임
    'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6 b1c3',      // 스코치 게임
    'e2e4 e7e5 g1f3 b8c6 b1c3 g8f6 f1b5 f8b4 e1g1',      // 포 나이츠
    'e2e4 e7e5 b1c3 g8f6 f2f4 d7d5 f4e5 f6e4 g1f3',      // 비엔나 게임
    'e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4 d2d4',      // 페트로프 방어
    // 1.e4 그 외
    'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3',      // 시칠리안 나이도르프 계열
    'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3',      // 시칠리안 클래식
    'e2e4 c7c5 b1c3 b8c6 g2g3 g7g6 f1g2 f8g7 d2d3',      // 클로즈드 시칠리안
    'e2e4 e7e6 d2d4 d7d5 b1c3 f8b4 e4e5 c7c5 a2a3',      // 프렌치 윈아워
    'e2e4 e7e6 d2d4 d7d5 b1d2 g8f6 e4e5 f6d7 f1d3',      // 프렌치 타라시
    'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5 e4g3',      // 카로칸 클래식
    'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6 g1f3',      // 스칸디나비안
    'e2e4 g8f6 e4e5 f6d5 d2d4 d7d6 g1f3 c8g4 f1e2',      // 알레힌 방어
    'e2e4 d7d6 d2d4 g8f6 b1c3 g7g6 g1f3 f8g7 f1e2',      // 피르츠 방어
    // 1.d4
    'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3',      // 퀸즈 갬빗 디클라인드
    'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 e7e6 e2e3',      // 슬라브 방어
    'd2d4 d7d5 c2c4 d5c4 g1f3 g8f6 e2e3 e7e6 f1c4',      // 퀸즈 갬빗 액셉티드
    'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8 f1d3',      // 님조인디언
    'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3',      // 킹스인디언
    'd2d4 g8f6 c2c4 g7g6 b1c3 d7d5 c4d5 f6d5 e2e4',      // 그륀펠트
    'd2d4 g8f6 g1f3 e7e6 c2c4 b7b6 g2g3 c8b7 f1g2',      // 퀸즈인디언
    'd2d4 d7d5 g1f3 g8f6 c2c4 e7e6 b1c3 c7c6 c1g5',      // 세미슬라브
    // 그 외 첫 수
    'c2c4 e7e5 b1c3 g8f6 g1f3 b8c6 g2g3 d7d5 c4d5',      // 잉글리시 오프닝
    'g1f3 d7d5 g2g3 g8f6 f1g2 e7e6 e1g1 f8e7 d2d3',      // 레티 오프닝
  ];

  const BOOK = (() => {
    const m = new Map();
    for (const line of BOOK_LINES) {
      const mv = line.split(' ');
      for (let i = 0; i < mv.length; i++) {
        const key = mv.slice(0, i).join(' ');
        if (!m.has(key)) m.set(key, []);
        const arr = m.get(key);
        if (!arr.includes(mv[i])) arr.push(mv[i]);
      }
    }
    return m;
  })();

  function bookMove(G, side) {
    // 증강이 하나라도 개입한 판은 정석이 의미 없다
    if (G.augs.w.length || G.augs.b.length) return null;
    if (!G.hist || G.hist.length > 12) return null;
    const cands = BOOK.get(G.hist.join(' '));
    if (!cands || !cands.length) return null;
    const legal = movesFor(G, side);
    const shuffled = cands.slice().sort(() => Math.random() - 0.5);
    for (const uci of shuffled) {
      const from = uciSq(uci.slice(0, 2)), to = uciSq(uci.slice(2, 4));
      const m = legal.find(x => x.from === from && x.to === to && !x.promo);
      if (m) return m;
    }
    return null;
  }
  function uciSq(s) { return E.idx(8 - +s[1], 'abcdefgh'.indexOf(s[0])); }

  /* ═══════════ 평가 ═══════════ */
  const FILE_OF = (i) => i & 7;
  const RANK_OF = (i) => i >> 3;
  const CENTER4 = [27, 28, 35, 36];        // d5 e5 d4 e4
  const CENTER12 = [18, 19, 20, 21, 26, 29, 34, 37, 42, 43, 44, 45];
  const IS_C4 = new Uint8Array(64), IS_C12 = new Uint8Array(64);
  CENTER4.forEach(i => IS_C4[i] = 1); CENTER12.forEach(i => IS_C12[i] = 1);

  function phaseOf(G) {
    let ph = 0;
    for (let i = 0; i < 64; i++) { const p = G.bd[i]; if (p) ph += PHASE_W[p.type]; }
    return Math.min(ph, PHASE_MAX);
  }

  // 가벼운 기동성 (증강 무시, 기하학적 근사)
  function slideCount(G, i, dirs) {
    const [r0, c0] = E.rc(i);
    let n = 0;
    for (const [dr, dc] of dirs) {
      let r = r0 + dr, c = c0 + dc;
      while (E.onBoard(r, c)) {
        n++;
        if (G.bd[E.idx(r, c)]) break;
        r += dr; c += dc;
      }
    }
    return n;
  }

  // 한 번의 스캔으로 양측 기물 목록과 폰 파일 분포를 모은다
  function scan(G) {
    const P = { w: [], b: [] }, pf = { w: new Array(8).fill(0), b: new Array(8).fill(0) };
    const K = { w: -1, b: -1 };
    for (let i = 0; i < 64; i++) {
      const p = G.bd[i];
      if (!p) continue;
      P[p.color].push(i);
      if (p.type === 'p') pf[p.color][i & 7]++;
      else if (p.type === 'k') K[p.color] = i;
    }
    return { P, pf, K };
  }

  function pawnStruct(G, side, S) {
    const files = S.pf[side], foe = E.other(side);
    let s = 0;
    for (let f = 0; f < 8; f++) {
      if (files[f] > 1) s -= 14 * (files[f] - 1);
      if (files[f] && !(f > 0 && files[f - 1]) && !(f < 7 && files[f + 1])) s -= 16;
    }
    // 통과 폰: 앞쪽 3파일에 적 폰이 없으면
    for (const i of S.P[side]) {
      if (G.bd[i].type !== 'p') continue;
      const f = FILE_OF(i), r = RANK_OF(i);
      let blocked = false;
      for (const j of S.P[foe]) {
        if (G.bd[j].type !== 'p') continue;
        const jf = FILE_OF(j), jr = RANK_OF(j);
        if (Math.abs(jf - f) > 1) continue;
        if (side === 'w' ? jr < r : jr > r) { blocked = true; break; }
      }
      if (!blocked) { const adv = side === 'w' ? (6 - r) : (r - 1); s += 12 + adv * adv * 3; }
    }
    return s;
  }

  // 킹 안전: 폰 방패 + 근처의 적 기물 무게 (attacked() 없이 근사)
  function kingSafety(G, side, ph, S) {
    const k = S.K[side];
    if (k < 0) return 0;
    const [kr, kc] = E.rc(k);
    const dir = side === 'w' ? -1 : 1;
    let shield = 0;
    for (let dc = -1; dc <= 1; dc++) {
      const c = kc + dc;
      if (c < 0 || c > 7) continue;
      for (let d = 1; d <= 2; d++) {
        const r = kr + dir * d;
        if (!E.onBoard(r, c)) break;
        const p = G.bd[E.idx(r, c)];
        if (p && p.type === 'p' && p.color === side) { shield += d === 1 ? 12 : 6; break; }
      }
    }
    let danger = 0;
    const W = { q: 5, r: 3, b: 2, n: 2, p: 1, k: 0 };
    for (const j of S.P[E.other(side)]) {
      const p = G.bd[j];
      const [r, c] = E.rc(j);
      const d = Math.max(Math.abs(r - kr), Math.abs(c - kc));
      if (d <= 2) danger += W[p.type] * (3 - d);
      else if (d === 3 && (p.type === 'q' || p.type === 'r')) danger += 1;
    }
    const f = ph / PHASE_MAX;
    return Math.round(shield * f) - Math.round(danger * danger * 1.2 * f);
  }

  // 중앙 통제: 폰·나이트의 기하학적 공격만 센다
  function centerControl(G, side, S) {
    let n = 0;
    const dir = side === 'w' ? -1 : 1;
    for (const i of S.P[side]) {
      const p = G.bd[i];
      const [r, c] = E.rc(i);
      if (p.type === 'p') {
        for (const dc of [-1, 1]) {
          const t = E.idx(r + dir, c + dc);
          if (E.onBoard(r + dir, c + dc) && IS_C4[t]) n++;
        }
      } else if (p.type === 'n') {
        for (const [dr, dc] of E.N_JUMP) {
          const rr = r + dr, cc = c + dc;
          if (E.onBoard(rr, cc) && IS_C4[E.idx(rr, cc)]) n++;
        }
      }
    }
    return n * 7;
  }

  function sideScore(G, side, ph, S) {
    let mg = 0, eg = 0, extra = 0;
    const back = side === 'w' ? 7 : 0;
    const foe = E.other(side);
    let bishops = 0, minorsHome = 0;

    for (const i of S.P[side]) {
      const p = G.bd[i];
      const pi = side === 'w' ? i : mirror(i);
      mg += MG[p.type] + PST_MG[p.type][pi];
      eg += EG[p.type] + PST_EG[p.type][pi];

      if (p.type === 'b') { bishops++; extra += slideCount(G, i, E.DIR_B) * 3; }
      else if (p.type === 'n') { if (IS_C12[i]) extra += 8; }
      else if (p.type === 'r') {
        const f = FILE_OF(i);
        if (!S.pf[side][f] && !S.pf[foe][f]) extra += 22;
        else if (!S.pf[side][f]) extra += 11;
        extra += slideCount(G, i, E.DIR_R) * 2;
      }
      else if (p.type === 'q') {
        extra += slideCount(G, i, E.DIR_Q);
        if (ph > 18 && RANK_OF(i) !== back) extra -= 18;      // 개막에 퀸 조기 출동 감점
      }
      if ((p.type === 'n' || p.type === 'b') && RANK_OF(i) === back) minorsHome++;
      if (IS_C4[i]) extra += p.type === 'p' ? 18 : 8;
    }

    if (bishops >= 2) extra += 32;
    extra -= Math.round(minorsHome * 14 * (ph / PHASE_MAX));

    const k = S.K[side];
    if (k >= 0 && ph > 12) {
      const kf = FILE_OF(k);
      if (kf <= 2 || kf >= 6) extra += 26;
      else if (!G.bd[k].moved) extra += 6;
      else extra -= 14;
    }
    extra += pawnStruct(G, side, S);
    extra += kingSafety(G, side, ph, S);
    extra += centerControl(G, side, S);

    const taper = Math.round((mg * ph + eg * (PHASE_MAX - ph)) / PHASE_MAX);
    return taper + extra;
  }

  // 무제체스 고유 항목: 증강 진행도
  function augScore(G, side) {
    let s = 0;
    const thr = global.Game.nextThreshold(G, side);
    if (thr !== null) {
      const gap = Math.max(0, thr - G.kills[side]);
      s += Math.max(0, 45 - gap * 12);
    }
    s += G.augs[side].length * 55;
    return s;
  }

  function evaluate(G, side) {
    const S = scan(G);
    let ph = 0;
    for (const c of ['w', 'b']) for (const i of S.P[c]) ph += PHASE_W[G.bd[i].type];
    ph = Math.min(ph, PHASE_MAX);
    const foe = E.other(side);
    return (sideScore(G, side, ph, S) - sideScore(G, foe, ph, S))
      + (augScore(G, side) - augScore(G, foe));
  }

  /* ═══════════ 탐색 ═══════════ */
  function movesFor(G, side) {
    const save = G.turn;
    G.turn = side;
    let ms = E.allLegal(G, side);
    if (!ms.length) ms = E.allLegalRelaxed(G, side).moves;
    G.turn = save;
    return ms;
  }

  // Zobrist
  const Z = (() => {
    let s = 1234567;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
    const t = { w: {}, b: {} };
    for (const c of ['w', 'b']) for (const p of ['p', 'n', 'b', 'r', 'q', 'k']) {
      const arr = new Uint32Array(64);
      for (let i = 0; i < 64; i++) arr[i] = rnd();
      t[c][p] = arr;
    }
    return { t, side: rnd() };
  })();

  function hashOf(G, side) {
    let h = side === 'w' ? Z.side : 0;
    const bd = G.bd, tw = Z.t.w, tb = Z.t.b;
    for (let i = 0; i < 64; i++) {
      const p = bd[i];
      if (p) h ^= (p.color === 'w' ? tw : tb)[p.type][i];
    }
    return h >>> 0;
  }

  const MVV = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 20 };

  let TT, killers, history, nodes, deadline, aborted;

  function orderMoves(G, ms, ttMove, ply) {
    const kl = killers[ply];
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      let v = 0;
      if (ttMove && m.from === ttMove.from && m.to === ttMove.to) v = 1e7;
      else {
        const vic = G.bd[m.to];
        if (vic) v = 1e6 + MVV[vic.type] * 100 - MVV[G.bd[m.from].type];
        else if (kl && ((kl[0] && kl[0].from === m.from && kl[0].to === m.to) ||
                        (kl[1] && kl[1].from === m.from && kl[1].to === m.to))) v = 9e5;
        else v = history[m.from * 64 + m.to];
        if (m.promo === 'q') v += 8e5;
      }
      m._s = v;
    }
    ms.sort((a, b) => b._s - a._s);
    return ms;
  }

  function quiesce(G, side, alpha, beta, ply) {
    nodes++;
    if ((nodes & 511) === 0 && performance.now() > deadline) { aborted = true; return alpha; }
    const stand = evaluate(G, side);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (ply > 6) return alpha;

    const save = G.turn; G.turn = side;
    const caps = E.allLegal(G, side, true).filter(m => m.promo === undefined || m.promo === 'q');
    G.turn = save;
    orderMoves(G, caps, null, 0);
    for (const m of caps) {
      const u = E.applyRaw(G, m);
      const sc = -quiesce(G, E.other(side), -beta, -alpha, ply + 1);
      E.undoRaw(G, u);
      if (aborted) return alpha;
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }

  function negamax(G, side, depth, alpha, beta, ply) {
    nodes++;
    if ((nodes & 511) === 0 && performance.now() > deadline) { aborted = true; return alpha; }

    const key = hashOf(G, side);
    const hit = TT.get(key);
    let ttMove = null;
    if (hit) {
      ttMove = hit.move;
      if (hit.depth >= depth) {
        if (hit.flag === 0) return hit.score;
        if (hit.flag === 1 && hit.score > alpha) alpha = hit.score;
        if (hit.flag === 2 && hit.score < beta) beta = hit.score;
        if (alpha >= beta) return hit.score;
      }
    }

    if (depth <= 0) return quiesce(G, side, alpha, beta, 0);

    let ms = movesFor(G, side);
    if (!ms.length) {
      const save = G.turn; G.turn = side;
      const chk = E.inCheck(G, side);
      G.turn = save;
      return chk ? -90000 + ply : 0;         // 체크메이트는 빠를수록 좋다
    }
    ms = orderMoves(G, ms, ttMove, ply);

    const alpha0 = alpha;
    let best = -Infinity, bestMove = null;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      const u = E.applyRaw(G, m);
      let sc;
      if (i === 0) sc = -negamax(G, E.other(side), depth - 1, -beta, -alpha, ply + 1);
      else {
        // 후순위 수는 축소해서 훑고, 좋으면 다시 본다
        const red = (depth >= 3 && i >= 4 && !G.bd[m.to]) ? 1 : 0;
        sc = -negamax(G, E.other(side), depth - 1 - red, -alpha - 1, -alpha, ply + 1);
        if (sc > alpha && sc < beta) sc = -negamax(G, E.other(side), depth - 1, -beta, -alpha, ply + 1);
      }
      E.undoRaw(G, u);
      if (aborted) return best === -Infinity ? alpha : best;

      if (sc > best) { best = sc; bestMove = m; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        if (!G.bd[m.to]) {
          killers[ply] = killers[ply] || [];
          killers[ply][1] = killers[ply][0];
          killers[ply][0] = { from: m.from, to: m.to };
          history[m.from * 64 + m.to] = (history[m.from * 64 + m.to] || 0) + depth * depth;
        }
        break;
      }
    }

    const flag = best <= alpha0 ? 2 : (best >= beta ? 1 : 0);
    if (TT.size < 400000) TT.set(key, { depth, score: best, flag, move: bestMove });
    return best;
  }

  /* ═══════════ 난이도 ═══════════ */
  const LEVELS = {
    easy: {
      key: 'easy', label: '초급',
      maxDepth: 3, budget: 200, noise: 55, blunder: 0.14,
      book: true, smartDraft: false,
      desc: '3수까지 보지만 판단이 거칠고 가끔 실수합니다',
    },
    normal: {
      key: 'normal', label: '중급',
      maxDepth: 6, budget: 900, noise: 14, blunder: 0.02,
      book: true, smartDraft: true,
      desc: '정석 오프닝을 따르고 6수까지 봅니다',
    },
    hard: {
      key: 'hard', label: '고급',
      maxDepth: 20, budget: 2600, noise: 0, blunder: 0,
      book: true, smartDraft: true,
      desc: '시간이 허락하는 만큼 깊게 봅니다. 실수하지 않습니다',
    },
  };

  function levelOf(x) {
    if (typeof x === 'number') return Object.assign({}, LEVELS.normal, { maxDepth: x, budget: 400 });
    if (x && x.budget) return x;
    return LEVELS[x] || LEVELS.normal;
  }

  function pick(G, side, lv) {
    const L = levelOf(lv);
    const ms = movesFor(G, side);
    if (!ms.length) return null;
    if (ms.length === 1) return ms[0];

    // 1) 오프닝 북
    if (L.book) {
      const bm = bookMove(G, side);
      if (bm) { AI.lastInfo = { book: true, depth: 0, nodes: 0, score: 0 }; return bm; }
    }

    // 2) 쉬움 난이도의 실수
    if (L.blunder && Math.random() < L.blunder) {
      const quiet = ms.filter(m => !G.bd[m.to]);
      const pool = quiet.length ? quiet : ms;
      AI.lastInfo = { book: false, depth: 0, nodes: 0, score: 0, blunder: true };
      return pool[(Math.random() * pool.length) | 0];
    }

    // 3) 반복심화
    TT = new Map();
    killers = [];
    history = new Float64Array(64 * 64);
    nodes = 0;
    aborted = false;
    deadline = performance.now() + L.budget;

    let best = ms[0], bestScore = 0, reached = 0;
    for (let d = 1; d <= L.maxDepth; d++) {
      // 루트는 반드시 전체 창으로 본다.
      // 좁은 창을 쓰면 negamax 가 정확한 점수 대신 '경계값'을 돌려주는데,
      // 그 경계값을 점수로 착각하면 (특히 난이도 잡음이 더해질 때)
      // 외통수를 찾고도 엉뚱한 수를 두게 된다.
      const ordered = orderMoves(G, ms.slice(), best, 0);
      const scored = [];
      let localBest = null, localScore = -Infinity;
      for (const m of ordered) {
        const u = E.applyRaw(G, m);
        const sc = -negamax(G, E.other(side), d - 1, -Infinity, Infinity, 1);
        E.undoRaw(G, u);
        if (aborted) break;
        scored.push({ m, sc });
        if (sc > localScore) { localScore = sc; localBest = m; }
      }
      if (localBest && !aborted) {
        best = localBest;
        bestScore = localScore;
        reached = d;
        // 난이도 잡음은 '고르는 단계'에만 준다. 점수 자체는 오염시키지 않는다.
        // 외통수를 찾았다면 잡음과 무관하게 그 수를 둔다.
        if (L.noise && Math.abs(localScore) < 80000) {
          let bn = -Infinity;
          for (const s of scored) {
            const n = s.sc + (Math.random() - 0.5) * L.noise;
            if (n > bn) { bn = n; best = s.m; }
          }
        }
      }
      if (aborted || performance.now() > deadline) break;
      if (Math.abs(bestScore) > 80000) break;          // 외통수를 찾았다
    }

    // 승격은 항상 퀸
    if (best && best.promo && best.promo !== 'q') {
      const q = ms.find(m => m.from === best.from && m.to === best.to && m.promo === 'q');
      if (q) best = q;
    }
    AI.lastInfo = { book: false, depth: reached, nodes, score: Math.round(bestScore) };
    return best;
  }

  /* ═══════════ 증강 드래프트 ═══════════ */
  const AUG_BIAS = {
    R1b: 40, N1c: 35, Q11a: 45, Q1c: 30, N11c: 30, B6c: 25, Q11b: 30, K11c: 25,
    K1c: 45, K1d: 55, K1b: 35, K3a: 30, K3c: 35, K6b: 25, K6c: 15,
    P11a: 35, N11b: 40, Q6b: 30, R11a: 25, R1a: 20, P6b: 25, R3c: 25, Q11c: 20,
    N11a: -10, B11b: -10, N3c: -15, B1a: -15, Q3a: -20, K11b: -5, R6c: -5,
  };

  function draftScore(G, side, a) {
    let s = 50 + (AUG_BIAS[a.id] || 0);
    const t = E.KO2T[a.piece];
    if (t && t !== 'k') {
      const n = E.piecesOf(G, side, t).length;
      if (n === 0) s -= 45;
      else s += Math.min(n, 4) * 6;
    }
    if (a.tag === '영구지속') s += 12;
    if (a.tag === '턴제한') s -= 6;
    if (a.secret) s += 4;
    return s;
  }

  function draftPick(G, side, offer, picks, lv) {
    const L = levelOf(lv);
    const a = offer.slice();
    if (!L.smartDraft) {
      const out = [];
      for (let i = 0; i < picks && a.length; i++) out.push(a.splice((Math.random() * a.length) | 0, 1)[0].id);
      return out;
    }
    a.sort((x, y) => (draftScore(G, side, y) + Math.random() * 8) - (draftScore(G, side, x) + Math.random() * 8));
    return a.slice(0, picks).map(x => x.id);
  }

  const AI = { pick, evaluate, draftPick, LEVELS, levelOf, lastInfo: null, BOOK_SIZE: BOOK_LINES.length };
  global.AI = AI;
})(window);
