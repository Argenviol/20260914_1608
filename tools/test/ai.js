/* 평가·탐색 최적화 회귀 — 브라우저도 중계 서버도 없이 `node tools/test/ai.js` 로 돈다.

   2026-09-19 에 evaluate 를 2배 넘게 빠르게 만들면서 자료구조를 바꿨다
   (scan 이 파일별 최전진 폰과 국면 가중치를 같이 모으고, 통과폰 판정이 그걸 조회한다).
   값이 한 점이라도 달라지면 AI 가 다른 수를 두므로, '예전 방식으로 손으로 센 값' 과
   무작위 판 여러 개에서 대조한다. 숫자를 박아 두지 않으니 평가식을 손봐도 이 테스트는 안 깨진다. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '../../game/src');
const win = {};
const ctx = vm.createContext({ window: win, console, performance, Math });
for (const f of ['engine.js', 'ai.js']) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx);
const E = win.Engine, AI = win.AI;
// augScore 가 Game.nextThreshold 를 본다
win.Game = { nextThreshold: (G, s) => { const T = [1, 3, 6, 11]; const i = G.tierIdx[s]; return i >= T.length ? null : T[i]; } };

let pass = 0;
const fails = [];
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('PASS  ' + label); return; }
  fails.push(label);
  console.log('FAIL  ' + label + '\n        나온 값: ' + g + '\n        기대한 값: ' + w);
}

/* 씨앗 고정 난수 — 같은 판이 매번 나온다 */
let seed = 20260919;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

function randomBoard() {
  const G = E.newGame();
  G.bd = new Array(64).fill(null);
  const place = (t, c) => {
    for (let tries = 0; tries < 40; tries++) {
      const i = rnd(64);
      if (G.bd[i]) continue;
      if (t === 'p' && (i < 8 || i >= 56)) continue;      // 폰은 1·8랭크에 못 선다
      const p = E.mkPiece(t, c); p.moved = true; G.bd[i] = p; return;
    }
  };
  place('k', 'w'); place('k', 'b');
  for (const c of ['w', 'b']) {
    for (let i = 0, n = rnd(9); i < n; i++) place('p', c);
    for (const t of ['n', 'b', 'r', 'q']) if (rnd(2)) place(t, c);
  }
  G.turn = rnd(2) ? 'w' : 'b';
  return G;
}

/* ───── 통과폰: 예전의 '상대 기물 전부 훑기' 를 그대로 옮겨 적은 기준값 ───── */
function passedBrute(G, side) {
  const foe = E.other(side);
  let n = 0;
  for (let i = 0; i < 64; i++) {
    const p = G.bd[i];
    if (!p || p.color !== side || p.type !== 'p') continue;
    const f = i & 7, r = i >> 3;
    let blocked = false;
    for (let j = 0; j < 64; j++) {
      const q = G.bd[j];
      if (!q || q.color !== foe || q.type !== 'p') continue;
      const jf = j & 7, jr = j >> 3;
      if (Math.abs(jf - f) > 1) continue;
      if (side === 'w' ? jr < r : jr > r) { blocked = true; break; }
    }
    if (!blocked) n++;
  }
  return n;
}
// 지금 코드가 쓰는 길: scan 의 pmin/pmax 조회
function passedFast(G, side) {
  const foe = E.other(side), white = side === 'w';
  const pmin = new Array(8).fill(99), pmax = new Array(8).fill(-1);
  for (let i = 0; i < 64; i++) {
    const p = G.bd[i];
    if (!p || p.color !== foe || p.type !== 'p') continue;
    const f = i & 7, r = i >> 3;
    if (r < pmin[f]) pmin[f] = r;
    if (r > pmax[f]) pmax[f] = r;
  }
  const front = white ? pmin : pmax;
  let n = 0;
  for (let i = 0; i < 64; i++) {
    const p = G.bd[i];
    if (!p || p.color !== side || p.type !== 'p') continue;
    const f = i & 7, r = i >> 3;
    let blocked = false;
    for (let jf = f - 1; jf <= f + 1; jf++) {
      if (jf < 0 || jf > 7) continue;
      const fr = front[jf];
      if (white ? fr < r : fr > r) { blocked = true; break; }
    }
    if (!blocked) n++;
  }
  return n;
}

{
  let same = 0;
  const bad = [];
  for (let t = 0; t < 400; t++) {
    const G = randomBoard();
    for (const side of ['w', 'b']) {
      if (passedBrute(G, side) === passedFast(G, side)) same++;
      else bad.push(G.bd.map(p => p ? p.type + p.color : '.').join('') + ' ' + side);
    }
  }
  check('통과폰 판정 — 파일 조회가 전수 훑기와 같다 (무작위 400판)', [same, bad.slice(0, 1)], [800, []]);
}

/* ───── evaluate: 양쪽에서 본 점수는 부호만 다르다 ───── */
{
  let ok = 0;
  for (let t = 0; t < 200; t++) {
    const G = randomBoard();
    if (AI.evaluate(G, 'w') === -AI.evaluate(G, 'b')) ok++;
  }
  check('evaluate 는 양쪽에서 부호만 다르다 (무작위 200판)', ok, 200);
}

/* ───── hasEff: 목록을 만들지 않는 판정이 예전 결과와 같다 ───── */
{
  const G = E.newGame();
  const mk = (kind, owner) => E.addEff(G, { kind, owner, ids: [] });
  mk('knightOnly', 'w'); mk('rookLine', 'b'); mk('bishopAsQueen', 'w');
  const old = (kind, owner) => E.effs(G, kind, owner).length > 0;
  const rows = [];
  for (const kind of ['knightOnly', 'rookLine', 'bishopAsQueen', 'untargetable']) {
    for (const owner of [undefined, 'w', 'b']) {
      rows.push(E.hasEff(G, kind, owner) === old(kind, owner));
    }
  }
  check('hasEff 가 effs().length > 0 과 같다', rows.every(Boolean), true);
}

/* ───── attacked: 훑기 함수를 밖으로 뺀 뒤에도 슬라이더 판정이 같다 ───── */
{
  const sq = (n) => (8 - +n[1]) * 8 + 'abcdefgh'.indexOf(n[0]);
  const G = E.newGame();
  G.bd = new Array(64).fill(null);
  const put = (n, t, c) => { const p = E.mkPiece(t, c); p.moved = true; G.bd[sq(n)] = p; };
  put('e1', 'k', 'w'); put('e8', 'k', 'b');
  put('a1', 'r', 'w'); put('c3', 'b', 'w'); put('h5', 'q', 'w'); put('g1', 'n', 'w');
  /* a8 룩(세로) · d4 비숍 · e2 킹/나이트 · f3 나이트 · b1 룩(가로) ·
     d5 퀸(h5 에서 5랭크를 따라) · h8 비숍(c3-h8 대각) · b8 은 아무도 안 닿는다 */
  const got = ['a8', 'd4', 'e2', 'f3', 'b1', 'd5', 'h8', 'b8'].map(n => E.attacked(G, sq(n), 'w'));
  check('attacked — 룩·비숍·퀸·나이트 사거리', got, [true, true, true, true, true, true, true, false]);
  // 사이에 기물이 끼면 막힌다
  put('a4', 'p', 'b');
  check('attacked — 가로막히면 끊긴다', E.attacked(G, sq('a8'), 'w'), false);
}

console.log('\n' + pass + ' pass, ' + fails.length + ' fail' + (fails.length ? ': ' + fails.join(' / ') : ''));
process.exit(fails.length ? 1 : 0);
