/* 무제체스 엔진 회귀 테스트 — 브라우저도 중계 서버도 없이 `node engine.js` 로 돈다.
   engine.js 는 DOM 을 안 쓰는 순수 규칙 코드라 vm 에 가짜 window 만 하나 쥐여 주면 그대로 불린다.
   화면까지 봐야 하는 것은 online.js · augments.js 쪽이다. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({ window: {}, console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../game/src/engine.js'), 'utf8'), ctx);
const E = ctx.window.Engine;

const sq = (n) => (8 - +n[1]) * 8 + 'abcdefgh'.indexOf(n[0]);
const name = (i) => 'abcdefgh'[i & 7] + (8 - (i >> 3));

/* 한 줄 배치로 판을 만든다. moved 는 폰의 '이미 움직였다' 표시 — 기본 배치 여부를 가른다. */
function board(layout, opts) {
  opts = opts || {};
  const G = E.newGame();
  G.bd = new Array(64).fill(null);
  let i = 0;
  for (const ch of layout) {
    if (ch === '/') continue;
    if (ch >= '1' && ch <= '8') { i += +ch; continue; }
    const color = ch === ch.toUpperCase() ? 'w' : 'b';
    const p = E.mkPiece(ch.toLowerCase(), color);
    p.moved = !!opts.moved;
    G.bd[i++] = p;
  }
  G.turn = opts.turn || 'w';
  return G;
}

/* from 의 합법수 중 같은 파일로 전진하는 것만 (승격은 한 칸으로 묶어서) */
function forward(G, from) {
  const c0 = sq(from) & 7;
  const out = [];
  for (const m of E.legalMoves(G, sq(from))) {
    if ((m.to & 7) !== c0 || m.capture) continue;
    const s = name(m.to);
    if (!out.includes(s)) out.push(s);
  }
  return out.sort();
}

let pass = 0;
const fails = [];
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('PASS  ' + label); return; }
  fails.push(label);
  console.log('FAIL  ' + label + '\n        나온 값: ' + g + '\n        기대한 값: ' + w);
}

/* ─────────────────────────────────────────────────────────────
   P1b — "다음 1회, 폰이 두 칸 전진할 수 있습니다"

   한 번의 전진을 한 번 더 하는 증강이므로 최대 거리는 폰의 상태에 달려 있다.
     기본 배치 폰: (2칸 + 1칸) → 1~3칸
     이미 움직인 폰: (1칸 + 1칸) → 1~2칸
   예전에는 둘 다 3칸까지 갈 수 있었다 (피드백 '플레이 2').
   ───────────────────────────────────────────────────────────── */
{
  const open = 'k7/8/8/8/8/8/4P3/7K';   // e2 백 폰, 앞이 전부 비어 있다

  let G = board(open, { moved: false });
  G.flags.w.P1b = 1;
  check('P1b · 기본 배치 폰은 3칸까지', forward(G, 'e2'), ['e3', 'e4', 'e5']);

  G = board(open, { moved: true });
  G.flags.w.P1b = 1;
  check('P1b · 이미 움직인 폰은 2칸까지', forward(G, 'e2'), ['e3', 'e4']);

  G = board(open, { moved: false });
  check('P1b 없음 · 기본 배치 폰은 2칸까지', forward(G, 'e2'), ['e3', 'e4']);

  G = board(open, { moved: true });
  check('P1b 없음 · 이미 움직인 폰은 1칸', forward(G, 'e2'), ['e3']);
}

/* 지나갈 칸이 막히면 그만큼만 간다 — 폰은 뛰어넘지 못한다 */
{
  let G = board('k7/8/8/4n3/8/8/4P3/7K', { moved: false });   // e5 에 흑 나이트
  G.flags.w.P1b = 1;
  check('P1b · 도착 칸이 막히면 3칸은 없다', forward(G, 'e2'), ['e3', 'e4']);

  G = board('k7/8/8/8/4n3/8/4P3/7K', { moved: true });        // e4 에 흑 나이트
  G.flags.w.P1b = 1;
  check('P1b · 이미 움직인 폰, 2칸이 막히면 1칸', forward(G, 'e2'), ['e3']);

  G = board('k7/8/8/8/8/4n3/4P3/7K', { moved: false });       // e3 에 흑 나이트
  G.flags.w.P1b = 1;
  check('P1b · 바로 앞이 막히면 전진 없음', forward(G, 'e2'), []);
}

/* 흑도 같다 — 진행 방향만 반대 */
{
  const G = board('7k/4p3/8/8/8/8/8/K7', { moved: false, turn: 'b' });
  G.flags.b.P1b = 1;
  check('P1b · 흑 기본 배치 폰도 3칸까지', forward(G, 'e7'), ['e4', 'e5', 'e6']);
}

/* 횟수를 깎는 것은 p1b 표시가 붙은 수뿐이다 (game.js 의 소모 조건).
   기본 배치 폰의 2칸 전진은 원래 규칙이라 증강을 쓰지 않아야 한다. */
{
  const G = board('k7/8/8/8/8/8/4P3/7K', { moved: false });
  G.flags.w.P1b = 1;
  const flag = {};
  for (const m of E.legalMoves(G, sq('e2'))) if (!m.capture) flag[name(m.to)] = !!m.p1b;
  check('P1b · 표시는 3칸 전진에만 붙는다', flag, { e3: false, e4: false, e5: true });
}

/* p1b 로 승격 칸에 닿으면 승격 선택이 그대로 나온다 */
{
  const G = board('k7/8/4P3/8/8/8/8/7K', { moved: true });    // e6 백 폰, 이미 움직였다
  G.flags.w.P1b = 1;
  const promos = E.legalMoves(G, sq('e6')).filter(m => m.to === sq('e8')).map(m => m.promo).sort();
  check('P1b · 승격 칸에 닿으면 네 가지 승격', promos, ['b', 'n', 'q', 'r']);
}

/* ─────────────────────────────────────────────────────────────
   지정불가 · 포영 — 피드백 '플레이 1'("포영/지정불가 작동안함")

   둘 다 여러 증강이 공유하는 상태라, 증강 하나가 아니라 엔진 쪽 규칙을 잠가 둔다.
     지정불가: 움직일 수도, 처치 대상이 될 수도 없다. 정해진 ply 에 정확히 풀린다.
     포영    : 칸을 비우고 판 밖으로 나갔다가, 정해진 ply 에 그 칸으로 돌아온다.
               돌아올 때 그 칸에 기물이 있으면 피아 상관없이 그 기물을 제거한다.
   ───────────────────────────────────────────────────────────── */

// 합법수 칸 이름만 뽑는다 (처치에는 x 를 붙인다)
function movesOf(G, from) {
  return E.legalMoves(G, sq(from)).map(m => name(m.to) + (m.capture ? 'x' : '')).sort();
}

/* ── 지정불가 ── */
{
  const G = board('4k3/8/8/3p4/4P3/8/8/4K3', { moved: true });
  const foe = G.bd[sq('d5')];
  check('지정불가 · 걸기 전에는 잡을 수 있다', movesOf(G, 'e4'), ['d5x', 'e5']);

  E.addEff(G, { kind: 'untargetable', owner: 'b', ids: [foe.id], until: E.untilOppTurns(G, 1) });
  check('지정불가 · 처치 대상에서 빠진다', movesOf(G, 'e4'), ['e5']);

  G.turn = 'b';
  check('지정불가 · 자기도 못 움직인다', movesOf(G, 'd5'), []);
  check('지정불가 · 이유를 이름으로 돌려준다', E.restrictedBy(G, 'b', sq('d5'), sq('d4')), '지정불가');

  // 상대의 다음 1턴 = ply+2. 그 ply 가 되는 순간 풀린다.
  G.turn = 'w'; G.ply += 1; E.expireEffects(G);
  check('지정불가 · 한 ply 지나도 아직 걸려 있다', movesOf(G, 'e4'), ['e5']);
  G.ply += 1; E.expireEffects(G);
  check('지정불가 · 정해진 ply 에 풀린다', movesOf(G, 'e4'), ['d5x', 'e5']);
}

/* 킹은 전역 룰로 지정불가 대상이 아니다 — 증강 쪽에서 막지만 엔진도 같이 잠가 둔다 */
{
  const G = board('4k3/8/8/8/8/8/8/4K3');
  check('지정불가 · 킹은 애초에 대상이 아니다', E.protectedPiece(G, sq('e8')), true);
}

/* ── 포영 ── */
{
  const G = board('4k3/8/8/3n4/8/8/8/R3K3');     // d5 흑 나이트, a1 백 룩
  const n = G.bd[sq('d5')];
  check('포영 · 걸기 전에는 그 칸이 막혀 있다', movesOf(G, 'a1').includes('e1'), false);

  check('포영 · phaseOut 이 성공한다', E.phaseOut(G, sq('d5'), G.ply + 2), true);
  check('포영 · 칸이 빈다', G.bd[sq('d5')] === null, true);
  check('포영 · 판 밖에 한 개 올라간다', G.phased.length, 1);

  // 포영된 칸은 빈칸이므로 룩이 가로줄을 끝까지 지나간다
  G.bd[sq('a5')] = E.mkPiece('r', 'w');
  check('포영 · 빈 칸이라 지나갈 수 있다', movesOf(G, 'a5').includes('h5'), true);

  G.ply += 2;
  E.returnPhased(G);
  check('포영 · 정해진 ply 에 제자리로 돌아온다', G.bd[sq('d5')] && G.bd[sq('d5')].id === n.id, true);
  check('포영 · 판 밖 목록이 빈다', G.phased.length, 0);
}

/* 복귀 칸에 남의 기물이 서 있으면 피아 상관없이 그 기물이 제거된다 */
{
  const G = board('4k3/8/8/3n4/8/8/8/4K3');
  E.phaseOut(G, sq('d5'), G.ply + 2);
  G.bd[sq('d5')] = E.mkPiece('r', 'w');          // 그 사이 백 룩이 들어왔다
  G.ply += 2;
  E.returnPhased(G);
  const back = G.bd[sq('d5')];
  check('포영 · 복귀 칸을 차지한 기물은 제거된다', [back.type, back.color], ['n', 'b']);
  check('포영 · 제거된 기물은 무덤으로 간다', G.grave.w, ['r']);
}

/* 킹은 포영되지 않는다 (전역 룰). 룩 면역(R3c)도 포영을 막는다. */
{
  const G = board('4k3/8/8/8/8/8/8/4K3');
  check('포영 · 킹은 나가지 않는다', E.phaseOut(G, sq('e8'), G.ply + 2), false);

  const H = board('4k3/8/8/3r4/8/8/8/4K3');
  H.augs.b.push('R3c');
  check('포영 · R3c 룩은 면역이다', E.phaseOut(H, sq('d5'), H.ply + 2), false);
}

/* ─────────────────────────────────────────────────────────────
   P11a — "모든 폰이 한 번에 두 칸까지 움직이고 처치할 수 있습니다"

   이동 생성(genPawn)에만 들어가 있고 공격 판정(attacked)에는 빠져 있어서,
   P11a 폰이 킹을 잡을 수 있는데도 체크로 안 잡혔다. 체크메이트·스테일메이트까지 틀어진다.
   또 전진 루프와 '초기 2칸' 규칙이 같은 칸을 두 번 내면서, 먼저 나온 쪽에 double 표시가 없어
   ui 가 그걸 집는 바람에 앙파상이 영영 안 걸렸다.
   ───────────────────────────────────────────────────────────── */
{
  const G = board('5k2/8/8/8/3P4/8/8/4K3', { moved: true });
  G.augs.w.push('P11a');
  check('P11a · 폰이 두 칸 대각까지 잡는다',
    E.legalMoves(G, sq('d4')).filter(m => m.capture).map(m => name(m.to)), []);

  const H = board('5k2/8/5K2/8/3P4/8/8/8', { moved: true });   // f6 에 흑 킹, d4 백 폰
  H.bd[sq('f6')] = E.mkPiece('k', 'b');
  H.bd[sq('e1')] = E.mkPiece('k', 'w');
  H.bd[sq('f8')] = null;
  H.augs.w.push('P11a');
  check('P11a · 두 칸 대각에 있는 킹을 잡을 수 있다',
    E.legalMoves(H, sq('d4')).some(m => m.to === sq('f6') && m.capture), true);
  check('P11a · 그 칸을 공격 중이라고 본다', E.attacked(H, sq('f6'), 'w'), true);
  H.turn = 'b';
  check('P11a · 그래서 체크가 잡힌다', E.inCheck(H, 'b'), true);

  /* 중간 칸이 막혀 있으면 두 칸 대각은 못 온다 (생성 쪽과 같은 규칙).
     막는 기물은 f6 를 직접 때리지 않는 것으로 골라야 한다 — e5 에 폰을 두면
     그 폰이 한 칸 대각으로 f6 를 때려서 검사가 무의미해진다. 나이트는 f6 에 안 닿는다. */
  const I = board('5k2/8/5K2/4N3/3P4/8/8/8', { moved: true });
  I.bd[sq('f6')] = E.mkPiece('k', 'b');
  I.bd[sq('e1')] = E.mkPiece('k', 'w');
  I.bd[sq('f8')] = null;
  I.augs.w.push('P11a');
  check('P11a · 중간 칸이 막히면 공격이 아니다', E.attacked(I, sq('f6'), 'w'), false);
}

/* 같은 칸이 두 번 나오지 않고, 초기 2칸에는 double 표시가 붙는다 */
{
  const G = board('4k3/8/8/8/8/8/3P4/4K3', { moved: false });
  G.augs.w.push('P11a');
  const fwd = E.legalMoves(G, sq('d2')).filter(m => !m.capture);
  check('P11a · 기본 배치 폰의 전진은 d3 · d4 둘뿐', fwd.map(m => name(m.to)).sort(), ['d3', 'd4']);
  check('P11a · 2칸 전진에 double 이 붙는다',
    fwd.filter(m => m.to === sq('d4')).map(m => !!m.double), [true]);

  // 증강이 없을 때와 같은 모양인지도 함께
  const H = board('4k3/8/8/8/8/8/3P4/4K3', { moved: false });
  const hf = E.legalMoves(H, sq('d2')).filter(m => !m.capture);
  check('증강 없음 · 전진은 d3 · d4, 2칸에 double',
    [hf.map(m => name(m.to)).sort(), hf.filter(m => m.to === sq('d4')).map(m => !!m.double)],
    [['d3', 'd4'], [true]]);
}

/* ─────────────────────────────────────────────────────────────
   R3c — "룩이 제거, 포영, 교환, 지정불가 효과에 면역이 됩니다"
   제거·포영·교환은 engine 이 막고 있었는데 지정불가만 빠져 있었다.
   ───────────────────────────────────────────────────────────── */
{
  const G = board('4k3/8/8/3r4/8/8/8/4K3');
  const r = G.bd[sq('d5')];
  G.augs.b.push('R3c');
  check('R3c · 제거 면역', E.removePiece(G, sq('d5')), false);
  check('R3c · 포영 면역', E.phaseOut(G, sq('d5'), G.ply + 2), false);
  check('R3c · 변이 면역', E.mutate(G, sq('d5'), 'q'), false);
  // 지정불가는 augments.js 의 untarget 이 거른다 — 엔진 쪽 판정만 여기서 잠가 둔다
  check('R3c · immune 이 룩을 가려낸다', E.immune(G, r), true);
  check('R3c · 룩이 아니면 면역이 아니다', E.immune(G, E.mkPiece('n', 'b')), false);
}

console.log('\n' + pass + ' pass, ' + fails.length + ' fail' + (fails.length ? ': ' + fails.join(' / ') : ''));
process.exit(fails.length ? 1 : 0);
