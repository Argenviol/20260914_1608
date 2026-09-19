/* 고친 뒤 확인 — 온라인 두 화면 */
const H = require('./harness');
const sq = H.sq;
let fails = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : '')); if (!ok) fails++; }

(async () => {
  const browser = await H.launch();
  const { A, B } = await H.hostAndJoin(browser, '5+3');

  // ── 1. 비밀 아닌 증강 획득 알림 ──
  await H.move(A, 'e2', 'e4'); await H.waitPly(B, 1);
  await H.move(B, 'd7', 'd5'); await H.waitPly(A, 2);
  await H.move(A, 'e4', 'd5');
  await A.waitForSelector('.draft .card');
  await B.waitForTimeout(900);
  let sB = await H.state(B);
  const od = await B.evaluate(() => ({ mid: !document.querySelector('#oppdraft').hidden, midText: document.querySelector('#oppdraft').textContent, bar: !document.querySelector('#oppdrafttimer').hidden, barNum: (document.querySelector('#oppdrafttimer .dtnum') || {}).textContent }));
  check('상대 드래프트 중 판 가운데 안내', od.mid && /고르는 중/.test(od.midText) && /남은 시간 \d+초/.test(od.midText), od.midText);
  check('상대 드래프트 중 오른쪽 남은 시간', od.bar && /^\d+$/.test(od.barNum), 'num=' + od.barNum);
  check('턴바: 상대가 증강을 고르는 중', /증강을 고르는 중/.test(sB.turnbar), sB.turnbar);
  check('드래프트 중 상대 시계 멈춤', sB.paused === true);
  const clocksBefore = sB.clocks.join(' ');
  await B.waitForTimeout(2000);
  sB = await H.state(B);
  check('2초 뒤에도 시계 그대로', sB.clocks.join(' ') === clocksBefore, clocksBefore + ' → ' + sB.clocks.join(' '));

  await H.pickDraft(A, 'P1b');
  await H.waitPly(B, 3);
  await B.waitForTimeout(800);
  sB = await H.state(B);
  const od2 = await B.evaluate(() => ({ mid: !document.querySelector('#oppdraft').hidden, bar: !document.querySelector('#oppdrafttimer').hidden }));
  check('드래프트 끝나면 안내 사라짐', !od2.mid && !od2.bar);
  check('B 알림: 비밀이 아니라 "증강 획득"', sB.seen.some(t => /center: 상대의 증강 획득/.test(t)) && !sB.seen.some(t => /비밀/.test(t)), JSON.stringify(sB.seen));

  // ── 2. 도감을 열어도 시계는 안 멈추고, 상대 화면에 '증강 고르는 중' 안 뜸 ──
  // 지금 흑(B) 차례. B 가 도감을 연다.
  await B.click('#codex');
  await B.waitForTimeout(500);
  const sA2 = await H.state(A); const sB2 = await H.state(B);
  check('도감 열어도 내 시계 안 멈춤', sB2.paused === false, 'B paused=' + sB2.paused);
  check('상대 화면도 그대로 "두는 중"', /두는 중/.test(sA2.turnbar) && sA2.paused === false, sA2.turnbar + ' paused=' + sA2.paused);
  await B.click('.closebtn');
  await B.waitForTimeout(200);

  // ── 3. 상대 차례에 상대 증강 버튼이 안 뜸 · 내 차례엔 뜸 ──
  // 흑(B) 차례. 백(A)이 N3a 를 갖고 있다고 양쪽에 심는다.
  for (const p of [A, B]) await p.evaluate(() => { Game.G.augs.w.push('N3a'); Game.G.flags.w.N3a = 2; renderAll(); });
  sB = await H.state(B); let sA = await H.state(A);
  check('흑 차례: 흑 화면에 백 N3a 버튼 없음', sB.actions.length === 0, JSON.stringify(sB.actions));
  check('흑 차례: 백 화면에도 버튼 없음(내 차례 아님)', sA.actions.length === 0, JSON.stringify(sA.actions));

  // ── 4. 수 예약: 백(A) 차례가 아닐 때… 지금은 흑 차례이므로 A 가 예약한다: a2→a3 ──
  await A.click('#board .sq[data-i="' + sq('a2') + '"]');
  await A.waitForTimeout(150);
  const pmSel = await A.$eval('#board .sq.pmsel', n => n.dataset.i).catch(() => null);
  check('예약할 기물 선택 표시', pmSel === String(sq('a2')), 'pmsel=' + pmSel);
  await A.click('#board .sq[data-i="' + sq('a3') + '"]');
  await A.waitForTimeout(200);
  sA = await H.state(A);
  const chip = await A.$eval('#turnbar .pmchip', n => n.textContent).catch(() => null);
  check('예약 칩 표시', chip && /a2→a3/.test(chip), chip);
  // 흑이 둔다 → 백 차례 → 예약한 수가 자동으로 나간다
  await H.move(B, 'g8', 'f6');
  await H.waitPly(A, 4);
  await A.waitForFunction(() => Game.G.ply >= 5 && !Game.busy, null, { timeout: 8000 }).catch(() => { });
  sA = await H.state(A);
  const a3 = await A.evaluate(() => !!Game.G.bd[(8 - 3) * 8 + 0] && !Game.G.bd[(8 - 2) * 8 + 0]);
  check('내 차례가 오자 예약한 수(a2→a3)가 두어짐', a3 && sA.ply === 5, 'ply=' + sA.ply);
  await H.waitPly(B, 5);
  // 백 화면(내 차례=흑)에서 N3a 버튼: 이제 흑 차례이므로 백에는 없음. 흑 차례에 흑이 갖고 있으면 뜨는지 — 흑에게 N3a
  for (const p of [A, B]) await p.evaluate(() => { Game.G.augs.b.push('N3a'); Game.G.flags.b.N3a = 2; renderAll(); });
  sB = await H.state(B);
  check('내 차례: 내 N3a 버튼 뜸', sB.actions.length === 1, JSON.stringify(sB.actions));

  // ── 5. 수동 발동이 바로 상대 화면에 반영됨 (N3a: b8 나이트 ↔ b7 폰) ──
  await B.click('#actions .act');
  await H.answerPrompts(B, ['b8', 'b7']);
  await B.waitForTimeout(600);
  const swapped = await A.evaluate(() => Game.G.bd[(8 - 8) * 8 + 1].type === 'p' && Game.G.bd[(8 - 7) * 8 + 1].type === 'n');
  check('발동 결과가 상대 화면에 바로 옴', swapped);

  // ── 6. 상대 증강이 내 기물을 지우면 내 화면에서 빛나고 배너가 뜸 (Q1c: 양쪽 퀸 제거) ──
  // 흑 차례. 흑(B)이 Q1c 를 얻는다(발동은 즉시). 그 뒤 흑이 둔다 → 백(A) 화면.
  const sizeBefore = await A.evaluate(() => document.querySelectorAll('#banners .banner').length);
  await B.evaluate(async () => { await Game.grantAug('b', 'Q1c'); renderAll(); });
  await H.move(B, 'e7', 'e6');
  await H.waitPly(A, 6);
  await A.waitForTimeout(700);
  sA = await H.state(A);
  const fxA = await A.evaluate(() => ({ flashed: document.querySelectorAll('#board .sq.flash').length, banners: [...document.querySelectorAll('#banners .banner')].map(b => b.textContent) }));
  check('상대 증강으로 사라진 칸이 빛남', fxA.flashed >= 2, 'flash=' + fxA.flashed);
  check('상대 증강 발동 배너', fxA.banners.some(t => /Q1c|판이 바뀌었습니다/.test(t)), JSON.stringify(fxA.banners));
  check('상대 증강 획득 알림도 옴', sA.seen.some(t => /상대의 증강 획득.*Q1c/.test(t)), JSON.stringify(sA.seen.filter(t => /center/.test(t))));

  // ── 7. B1b (비밀) 가 온라인에서도 발동 훅을 탐 ──
  await A.evaluate(() => {
    window.__b1b = 0;
    const orig = AugImpl.B1b.onOppMoved;
    AugImpl.B1b.onOppMoved = async function (G, side, api, ctx) { window.__b1b++; return orig.call(this, G, side, api, ctx); };
  });
  // 백 차례. 백이 B1b 를 얻고 둔다 → 흑이 둔다 → 백 화면에서 onOppMoved 가 돌아야 한다
  await A.evaluate(async () => { await Game.grantAug('w', 'B1b'); renderAll(); });
  await H.move(A, 'b2', 'b3'); await H.waitPly(B, 7);
  await H.move(B, 'h7', 'h6'); await H.waitPly(A, 8);
  await A.waitForTimeout(400);
  const b1b = await A.evaluate(() => window.__b1b);
  check('B1b onOppMoved 가 내 화면에서 돎', b1b >= 1, 'calls=' + b1b);

  // ── 8. B3a 카드에 지금 점수 합 표시 ──
  await A.evaluate(async () => { Game.G.augs.w.push('B3a'); renderAll(); });
  const noteA = await A.evaluate(() => [...document.querySelectorAll('.aug .augnote')].map(n => n.textContent).join(' | '));
  check('B3a 카드에 점수 합·조건', /점수 합 \d+ \((홀|짝)수\)/.test(noteA), noteA);

  // ── 9. 턴 시작 예약 증강(B3a/B3b)이 온라인에서 받은 쪽 화면에서 돌고 양쪽에 반영됨 ──
  // 백(A) 차례 → 백이 둔다 → 흑 차례에 흑(B)이 지금 점수 합에 맞는 쪽을 얻는다(실전처럼 자기 턴에) → 흑이 둔다 → 백이 둔다
  // → 흑 턴 시작에 판정 → 폰 소환(칸 지정 프롬프트) → 백 화면에도 폰
  await H.move(A, 'a3', 'a4'); await H.waitPly(B, 9);
  const pid = await B.evaluate(() => (Engine.materialScore(Game.G, 'b') % 2 === 1) ? 'B3a' : 'B3b');
  const pawnsBefore = await A.evaluate(() => Engine.piecesOf(Game.G, 'b', 'p').length);
  await B.evaluate(async (id) => { await Game.grantAug('b', id); renderAll(); }, pid);
  await H.move(B, 'a7', 'a6'); await H.waitPly(A, 10);
  await H.move(A, 'a4', 'a5');
  await B.waitForSelector('.pickbar', { timeout: 8000 });
  const prompt = await B.$eval('.pickbar', n => n.textContent);
  check('턴 시작 예약 증강 프롬프트가 받은 쪽에 뜸', /소환할/.test(prompt), prompt);
  await H.answerPrompts(B);
  await B.waitForTimeout(800);
  const pawnsA = await A.evaluate(() => Engine.piecesOf(Game.G, 'b', 'p').length);
  const doneB = await B.evaluate((id) => Game.G.flags.b[id + 'Done'], pid);
  check('소환된 폰이 상대 화면에도 옴', pawnsA === pawnsBefore + 1, pawnsBefore + ' → ' + pawnsA + ' done=' + doneB);
  const cardB = await B.evaluate(() => [...document.querySelectorAll('.aug .augnote')].map(n => n.textContent).join(' | '));
  check('카드에 판정 끝 표시', /판정 끝/.test(cardB), cardB);
  sB = await H.state(B);
  // 가운데 카드는 큐로 차례로 뜨므로 잠시 기다린다
  const gotCard = await B.waitForFunction(() => window.__seen.some(x => x.kind === 'center' && /B3[ab] 발동/.test(x.t)), null, { timeout: 12000 }).then(() => true).catch(() => false);
  sB = await H.state(B);
  check('판정 순간 가운데 카드', gotCard, JSON.stringify(sB.seen.filter(t => /center/.test(t))));
  check('내 비밀 증강 공개 카드는 안 뜸(중복)', !sB.seen.some(t => /center: 내 비밀 증강이 공개/.test(t)));

  console.log('errors:', A.errors.concat(B.errors));
  await browser.close();
  console.log(fails ? `\n${fails} FAIL` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
