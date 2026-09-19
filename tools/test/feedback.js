/* 피드백 항목을 '실제 화면' 에서 확인한다.

   augments.js 는 Game.api 를 가짜로 바꿔 훅만 본다 — 증강이 판을 바꾸는지는 알지만
   사람이 화면에서 겪는 것(칸에 점이 찍히는지 · 배지가 붙는지 · 선택지가 잠겨서 오는지)은 못 본다.
   여기서는 판만 차려 놓고 그 뒤로는 전부 진짜다 — 진짜 칸을 눌러서 두고, 진짜 드래프트 창의
   카드를 누르고, 진짜 대상 지정 바에서 칸을 찍는다. Game.api 는 손대지 않는다.

     python server/relay.py
     node tools/test/feedback.js
*/
const H = require('./harness');

let pass = 0;
const fails = [];
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('PASS  ' + label); return true; }
  fails.push(label);
  console.log('FAIL  ' + label + '\n        나온 값: ' + g + '\n        기대한 값: ' + w);
  return false;
}

const idx = (n) => (8 - +n[1]) * 8 + 'abcdefgh'.indexOf(n[0]);

/* ───────── 화면 조작 (사람이 하는 것과 같은 길) ───────── */

// 판만 차려 놓는다. 여기서만 내부를 건드리고, 이 뒤로는 화면만 만진다.
async function setup(p, pieces, opts) {
  await p.evaluate(({ pieces, opts }) => {
    const E = Engine, G = E.newGame();
    G.bd = new Array(64).fill(null);
    for (const row of pieces) {
      const pc = E.mkPiece(row[1], row[2]);
      pc.moved = !!row[3];
      G.bd[(8 - +row[0][1]) * 8 + 'abcdefgh'.indexOf(row[0][0])] = pc;
    }
    G.turn = opts.turn || 'w';
    G.clock = null;
    if (opts.kills) G.kills.w = opts.kills;
    if (opts.tierIdx !== undefined) G.tierIdx = { w: opts.tierIdx, b: opts.tierIdx };
    if (opts.grave) G.grave.w = opts.grave.slice();
    Game.G = G; Game.mode = 'pvp'; Game.busy = false; Game.clockPaused = false;
    Game.lastMove = null;
    renderAll();
  }, { pieces, opts: opts || {} });
  await p.waitForTimeout(120);
}

const clickSq = (p, n) => p.click(`#board .sq[data-i="${idx(n)}"]`);

// 지금 눌러 둔 기물이 갈 수 있다고 화면에 찍힌 칸
async function shownDests(p) {
  return p.$$eval('#board .sq.dest, #board .sq.capture',
    ns => ns.map(n => 'abcdefgh'[(+n.dataset.i) & 7] + (8 - ((+n.dataset.i) >> 3))).sort());
}
// 같은 파일(세로줄)로 나아가는 칸만 — 폰 전진 거리를 볼 때 쓴다
const sameFile = (ds, from) => ds.filter(s => s[0] === from[0]).sort();

async function select(p, from) { await clickSq(p, from); await p.waitForTimeout(120); }
async function move(p, from, to) {
  await select(p, from);
  await clickSq(p, to);
  await p.waitForTimeout(250);
}

async function draftCards(p) {
  await p.waitForSelector('.draft .card', { timeout: 8000 });
  await p.waitForTimeout(150);
  return p.$$eval('.draft .card', cs => cs.map(c => ({
    id: c.querySelector('.cardid').textContent,
    blocked: c.classList.contains('blocked'),
    dur: ['d-turn', 'd-count', 'd-perm'].find(x => c.classList.contains(x)) || null,
  })));
}
// 카드 누르기 — 가운데 안내 카드가 잠깐 겹치므로 요소에 직접 클릭을 보낸다
async function pickCard(p, id) {
  await p.waitForSelector('.draft .card', { timeout: 8000 });
  const ok = await p.evaluate((want) => {
    const c = [...document.querySelectorAll('.draft .card')]
      .find(x => x.querySelector('.cardid').textContent === want);
    if (!c || c.classList.contains('blocked')) return false;
    c.click(); return true;
  }, id);
  if (!ok) throw new Error(`${id} 카드를 고를 수 없다`);
  await p.waitForTimeout(400);
}
// 대상 지정 바에서 칸 찍기
async function pickTarget(p, n) {
  await p.waitForSelector('.pickbar', { timeout: 6000 });
  await p.waitForTimeout(150);
  await p.click(`#board .sq.pick[data-i="${idx(n)}"]`);
  await p.waitForTimeout(300);
}
// 'grab' 같은 조작용 클래스는 빼고 '무슨 기물인지' 만 본다 (예: 'pc bp')
const pieceAt = (p, n) => p.$$eval(`#board .sq[data-i="${idx(n)}"] .pc`,
  ns => ns.length ? ns[0].className.split(' ').filter(c => c === 'pc' || c === 'wp' || c === 'bp').join(' ') : null);
const lockAt = (p, n) => p.$$eval(`#board .sq[data-i="${idx(n)}"] .badge.lock`, ns => ns.length ? ns[0].textContent : null);
const phasedChips = (p) => p.$$eval('#phased .chip', ns => ns.map(n => n.textContent.trim()));

const K = ['e1', 'k', 'w'], k = ['e8', 'k', 'b'];

(async () => {
  const browser = await H.launch();
  const P = await H.newPage(browser, 'P');

  /* ── 시작화면: 도감 · 규칙 (피드백 '시작화면 1') ── */
  {
    await P.click('#h-codex');
    await P.waitForTimeout(500);
    check('시작화면에서 증강 도감이 열린다', await P.$$eval('.codex .ccard', n => n.length > 0), true);

    /* 가독성 (피드백 '증강 도감 1') — 기물별 · 티어별로 볼 수 있고,
       한 기물 12장이 한 화면에 (거의) 들어오는지 */
    const seg = (label) => P.evaluate((t) => {
      const b = [...document.querySelectorAll('.codexbar .seg button')].find(x => x.textContent === t);
      if (!b) throw new Error('차림표에 ' + t + ' 가 없다'); b.click();
    }, label);
    await seg('킹'); await P.waitForTimeout(300);
    check('기물별로 볼 수 있다', await P.$$eval('.codexbody .ccard .cardid', ns => ns.map(n => n.textContent)),
      ['K1a', 'K1b', 'K1c', 'K3a', 'K3b', 'K3c', 'K6a', 'K6b', 'K6c', 'K11a', 'K11b', 'K11c']);
    const box = await P.evaluate(() => {
      const b = document.querySelector('.codexbody');
      return { 내용: b.scrollHeight, 보이는: b.clientHeight };
    });
    check('한 기물 12장이 한 화면에 거의 들어온다', box.내용 <= box.보이는 * 1.1, true);
    await seg('1개'); await P.waitForTimeout(300);
    check('티어별로도 볼 수 있다 (킹 1개 티어는 3장)',
      await P.$$eval('.codexbody .ccard .cardid', ns => ns.map(n => n.textContent)), ['K1a', 'K1b', 'K1c']);
    await seg('전체'); await P.waitForTimeout(300);

    await P.click('.codex .closebtn');
    await P.waitForTimeout(300);
    await P.click('#h-rules');
    await P.waitForTimeout(500);
    check('시작화면에서 규칙 · 용어가 열린다', await P.$$eval('.codex .rcard', n => n.length > 0), true);
    check('규칙 화면에 바로가기 줄이 있다',
      await P.$$eval('.codexbar .seg button', ns => ns.map(n => n.textContent)),
      ['증강을 얻는 흐름', '조작', '전역 룰', '용어']);
    check('전역 룰은 접혀서 온다 (피드백 규칙/용어 2)', await P.$$eval('.rfold[open]', n => n.length), 0);

    // 바로가기로 실제로 건너뛰는지
    check('처음에는 맨 위', await P.$eval('.codexbody', n => n.scrollTop), 0);
    await P.evaluate(() => [...document.querySelectorAll('.codexbar .seg button')].find(b => b.textContent === '용어').click());
    await P.waitForTimeout(900);
    check('바로가기를 누르면 그 자리로 내려간다', await P.$eval('.codexbody', n => n.scrollTop > 100), true);

    // 접힌 전역 룰은 눌러서 편다
    await P.evaluate(() => [...document.querySelectorAll('.codexbar .seg button')].find(b => b.textContent === '전역 룰').click());
    await P.waitForTimeout(700);
    await P.evaluate(() => document.querySelector('.rfold > summary').click());
    await P.waitForTimeout(300);
    check('눌러서 펴면 본문이 나온다', await P.$$eval('.rfold[open] .ctext', ns => ns.length && ns[0].textContent.length > 10), true);

    await P.click('.codex .closebtn');
    await P.waitForTimeout(300);
  }

  await P.click('#h-pvp');
  await P.waitForFunction(() => window.Game && Game.G && !document.body.classList.contains('athome'));

  /* ── 판에서도 같은 창이 열린다 ── */
  {
    await P.click('#codex'); await P.waitForTimeout(500);
    check('판에서도 도감이 열린다', await P.$$eval('.codex .ccard', n => n.length > 0), true);
    await P.click('.codex .closebtn'); await P.waitForTimeout(300);
    await P.click('#rules'); await P.waitForTimeout(500);
    check('판에서도 규칙이 열린다', await P.$$eval('.codex .rcard', n => n.length > 0), true);
    await P.click('.codex .closebtn'); await P.waitForTimeout(300);
  }

  /* ── 드래프트 창 자체 (피드백 '규칙/용어 3' · '플레이화면 1' · '플레이화면 2')
        폰으로 처치 → 폰 칸 3개가 그대로 펼쳐지는지, 색이 갈리는지, 판 보기 바가 큰지 ── */
  {
    await setup(P, [K, k, ['e4', 'p', 'w', true], ['d5', 'p', 'b', true], ['a2', 'p', 'w'], ['a8', 'r', 'b']]);
    await move(P, 'e4', 'd5');
    const cards = await draftCards(P);
    check('폰으로 처치 → 폰 칸 선택지 3개', cards.map(c => c.id), ['P1a', 'P1b', 'P1c']);
    check('드래프트 머리말이 처치한 기물 칸', await P.$eval('.draft h2', n => n.textContent), '폰 증강');
    check('카드마다 지속 유형 색이 붙는다', cards.map(c => c.dur), ['d-turn', 'd-count', 'd-perm']);
    check('색 범례가 있다', await P.$$eval('.draft .durlegend > *', n => n.length >= 3), true);

    // 판 보기 — 글씨가 판에 묻히지 않을 만큼 큰지
    await P.evaluate(() => document.querySelector('.draftfoot .nav').click());
    await P.waitForTimeout(400);
    const sizes = await P.evaluate(() => {
      const px = (s, k) => Math.round(parseFloat(getComputedStyle(document.querySelector(s))[k]));
      return { 제목: px('.peekbar .peekmsg b', 'fontSize'), 부제: px('.peekbar .peeksub', 'fontSize'), 버튼: px('.peekbar .skipbtn.big', 'fontSize') };
    });
    check("'판을 보는 중입니다' 제목 22px 이상", sizes.제목 >= 22, true);
    check("'증강 고르기로' 버튼 18px 이상", sizes.버튼 >= 18, true);
    check('판 보기 중에는 덮개가 걷힌다', await P.$$eval('.overlay.peeking', n => n.length), 1);
    check('판 보기 중에도 기물이 다 보인다', await P.$$eval('#board .pc', n => n.length), 5);
    await P.evaluate(() => document.querySelector('.peekbar .skipbtn.big').click());
    await P.waitForTimeout(300);

    /* ── 지정불가 (피드백 '플레이 1') ──
       P1a 로 a2 폰을 지정불가로 만들고, 흑 룩이 정말 못 잡는지 화면에서 본다 */
    await pickCard(P, 'P1a');
    await pickTarget(P, 'a2');
    check('지정불가 배지가 붙는다', (await lockAt(P, 'a2')) !== null, true);

    await select(P, 'a8');                                   // 흑 차례 — 룩을 눌러 본다
    let ds = await shownDests(P);
    check('지정불가 폰은 잡을 칸으로 안 찍힌다', ds.includes('a2'), false);
    check('같은 줄의 다른 칸은 그대로 찍힌다', ds.includes('a3'), true);

    await move(P, 'a8', 'a3');                               // 흑 한 수
    await move(P, 'd5', 'd6');                               // 백 한 수 — 상대턴이 지났다
    check('상대턴이 지나면 배지가 사라진다', await lockAt(P, 'a2'), null);
    await select(P, 'a3');
    ds = await shownDests(P);
    check('풀린 뒤에는 다시 잡을 수 있다', ds.includes('a2'), true);
  }

  /* ── 포영 (피드백 '플레이 1') ──
     P1c — 처치한 폰과 가장 가까운 상대 폰이 함께 판 밖으로 나갔다가 제자리로 돌아온다 ── */
  {
    await setup(P, [K, k, ['e4', 'p', 'w', true], ['d5', 'p', 'b', true], ['a7', 'p', 'b']]);
    await move(P, 'e4', 'd5');
    await pickCard(P, 'P1c');
    await P.waitForTimeout(400);
    check('포영된 기물이 판에서 사라진다', [await pieceAt(P, 'd5'), await pieceAt(P, 'a7')], [null, null]);
    check('판 밖 목록에 두 개가 올라온다', (await phasedChips(P)).length, 2);
    check('포영 칩에 남은 수가 적힌다', (await phasedChips(P))[0].includes('포영'), true);

    await move(P, 'e8', 'd8');                               // 흑 한 수
    await move(P, 'e1', 'd1');                               // 백 한 수
    check('제자리로 돌아온다', [await pieceAt(P, 'd5'), await pieceAt(P, 'a7')],
      ['pc wp', 'pc bp']);
    check('판 밖 목록이 빈다', (await phasedChips(P)).length, 0);
  }

  /* ── 포영 복귀 칸을 차지하고 있으면 피아 상관없이 그 기물이 제거된다 ──
        포영은 '다음 상대턴 동안' 이라 그 칸에 들어갈 수 있는 건 상대뿐이다.
        흑 룩이 제 폰이 나가 있는 칸으로 들어가면, 돌아온 폰이 제 룩을 밀어낸다. ── */
  {
    await setup(P, [K, k, ['e4', 'p', 'w', true], ['d5', 'p', 'b', true], ['a7', 'p', 'b'], ['a8', 'r', 'b']]);
    await move(P, 'e4', 'd5');
    await pickCard(P, 'P1c');
    await P.waitForTimeout(400);
    check('포영된 칸으로 들어갈 수 있다', (await (async () => { await select(P, 'a8'); return shownDests(P); })()).includes('a7'), true);
    await clickSq(P, 'a7');                                  // 흑 룩이 포영된 칸으로 들어간다
    await P.waitForTimeout(400);
    check('복귀 칸을 차지한 기물은 피아 상관없이 제거된다', await pieceAt(P, 'a7'), 'pc bp');
    check('복귀가 끝나면 판 밖 목록이 빈다', (await phasedChips(P)).length, 0);
  }

  /* ── P1b 폰 전진 거리 (피드백 '플레이 2') ── */
  {
    await setup(P, [K, k, ['b4', 'p', 'w', true], ['c5', 'p', 'b', true], ['e2', 'p', 'w'], ['g4', 'p', 'w', true]]);
    await move(P, 'b4', 'c5');
    await pickCard(P, 'P1b');
    await P.waitForTimeout(300);
    await move(P, 'e8', 'd8');                               // 흑 한 수 — 백 차례로 되돌린다

    await select(P, 'e2');
    check('기본 배치 폰은 1~3칸', sameFile(await shownDests(P), 'e2'), ['e3', 'e4', 'e5']);
    await select(P, 'g4');
    check('이미 움직인 폰은 1~2칸', sameFile(await shownDests(P), 'g4'), ['g5', 'g6']);
  }

  /* ── B3c 비숍 '비밀' (피드백 '플레이 3') ──
     방금 적을 처치한 그 비숍이 2턴을 살아남으면 부활. 스폰 칸이 막힌 종류는 잠겨서 와야 한다 ── */
  {
    await setup(P, [K, k, ['a1', 'b', 'w'], ['c3', 'p', 'b'], ['b1', 'n', 'w'], ['g1', 'n', 'w']],
      { kills: 2, tierIdx: 1, grave: ['n', 'r'] });
    await move(P, 'a1', 'c3');
    const cards = await draftCards(P);
    check('비숍으로 처치 → 비숍 3개 칸', cards.map(c => c.id), ['B3a', 'B3b', 'B3c']);
    await pickCard(P, 'B3c');
    await P.waitForTimeout(300);

    /* "2턴을 살아남으면" — 처치한 그 수(백 T0) 뒤로 백이 한 턴(T1)을 더 두고,
       백의 두 번째 차례(T2)가 시작될 때 부활 선택이 뜬다. */
    await move(P, 'e8', 'd8');                               // 흑
    await move(P, 'e1', 'd1');                               // 백 T1
    await move(P, 'd8', 'e8');                               // 흑 — 여기서 백 T2 가 시작된다
    await P.waitForSelector('.optlist .opt', { timeout: 8000 });
    const opts = await P.$$eval('.optlist .opt', ns => ns.map(n => ({
      label: n.querySelector('.optlabel').textContent,
      blocked: n.classList.contains('blocked'),
      why: (n.querySelector('.blockwhy') || {}).textContent || null,
    })));
    check('그 처치를 한 비숍으로 2턴 뒤 부활 선택이 뜬다', opts.length > 0, true);
    check('스폰 칸이 막힌 나이트는 처음부터 잠겨서 온다',
      opts.filter(o => o.label === '나이트').map(o => o.blocked), [true]);
    check('빈 칸이 있는 룩은 고를 수 있다',
      opts.filter(o => o.label === '룩').map(o => o.blocked), [false]);

    await P.evaluate(() => [...document.querySelectorAll('.optlist .opt')]
      .find(n => n.querySelector('.optlabel').textContent === '룩' && !n.classList.contains('blocked')).click());
    await pickTarget(P, 'a1');
    check('고른 기물이 시작 칸에 되살아난다', await pieceAt(P, 'a1'), 'pc wp');
  }

  /* ── K1b — 그 칸의 3개 중 2개 (피드백 '증강 도감 2') ──
     킹으로 처치해 킹 1개 칸에서 K1b 를 고르면, 이어지는 3개 티어 드래프트가
     같은 칸을 두 번 펼친다 ── */
  {
    await setup(P, [K, k, ['d2', 'p', 'b', true], ['a7', 'r', 'w']], { kills: 2, tierIdx: 0 });
    await move(P, 'e1', 'd2');
    check('킹으로 처치 → 킹 1개 칸', (await draftCards(P)).map(c => c.id), ['K1a', 'K1b', 'K1c']);
    await pickCard(P, 'K1b');
    await P.waitForTimeout(600);

    const r1 = await draftCards(P);
    const pill1 = await P.$$eval('.draft .dpill.gold', ns => ns.map(n => n.textContent));
    check('이어지는 드래프트는 킹 3개 칸', r1.map(c => c.id), ['K3a', 'K3b', 'K3c']);
    check('K1b 표시가 칸 기준으로 뜬다', pill1, ['K1b · 이 칸에서 2개 · 1번째']);

    await pickCard(P, 'K3b');
    await H.answerPrompts(P);
    await P.waitForTimeout(400);
    const r2 = await draftCards(P);
    const pill2 = await P.$$eval('.draft .dpill.gold', ns => ns.map(n => n.textContent));
    check('두 번째도 같은 킹 3개 칸', r2.map(c => c.id), ['K3a', 'K3b', 'K3c']);
    check('방금 고른 카드는 잠겨서 온다', r2.filter(c => c.blocked).map(c => c.id), ['K3b']);
    check('두 번째 표시', pill2, ['K1b · 이 칸에서 2개 · 2번째']);
    await pickCard(P, 'K3a');
    await H.answerPrompts(P);
    /* 드래프트로 고른 것은 K1b(1개 칸) + 킹 3개 칸에서 둘.
       K3a 는 "나이트·비숍 중 한 기물의 6개 티어 증강을 추가로 얻는다" 라 그 몫이 하나 더 붙는데,
       그건 K3a 가 하는 일이지 드래프트가 칸을 넘어간 것이 아니다. */
    const augs = await P.evaluate(() => Game.G.augs.w.slice());
    check('드래프트로 고른 것은 전부 킹 칸', augs.filter(x => x[0] === 'K'), ['K1b', 'K3b', 'K3a']);
    check('킹 칸 밖의 증강은 K3a 가 준 것 하나뿐', augs.filter(x => x[0] !== 'K').length, 1);
  }

  /* ── 제한시간 칸 ──
     예전에는 아래 줄에 하나(AI·2인용) · 온라인 카드에 하나라 똑같이 '제한시간' 인 칸이 둘이었고,
     어느 쪽이 먹는지 알 수 없었다. 이제 카드마다 하나씩, 누르는 버튼 바로 위에 있다. ── */
  {
    const home = async () => {
      await P.goto('http://127.0.0.1:8788/', { waitUntil: 'networkidle' });
      await P.selectOption('#ai-tc', '10+5');
      await P.selectOption('#pvp-tc', 'none');
      await P.selectOption('#o-tc', '3+2');
    };
    await home();
    check('제한시간 칸은 카드마다 하나씩 셋',
      await P.$$eval('#home select', ns => ns.map(n => n.id)), ['ai-tc', 'pvp-tc', 'o-tc']);
    check('아래 줄에는 제한시간 칸이 없다', await P.$$eval('.homefoot select', n => n.length), 0);
    check('칸마다 자기 카드 안에 있다', await P.$$eval('.modecard .tcsel', n => n.length), 3);

    await P.click('#h-ai');
    await P.waitForFunction(() => window.Game && Game.G && !document.body.classList.contains('athome'));
    check('AI 대전은 AI 카드의 칸을 쓴다', await P.$eval('#tcinfo', n => n.textContent), '10분 + 5초');

    await home();
    await P.click('#h-pvp');
    await P.waitForFunction(() => window.Game && Game.G && !document.body.classList.contains('athome'));
    check('2인 대전은 2인 카드의 칸을 쓴다', await P.$eval('#tcinfo', n => n.textContent), '무제한');
  }

  console.log('\n' + pass + ' pass, ' + fails.length + ' fail' + (fails.length ? ': ' + fails.join(' / ') : ''));
  console.log('errors:', P.errors.slice(0, 5));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
