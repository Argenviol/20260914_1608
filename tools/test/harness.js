/* 무제체스 온라인 테스트 하네스 — 두 브라우저를 한 방에 앉히고 수를 둔다 */
const { chromium } = require('playwright-core');
const URL = 'http://127.0.0.1:8788/';
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const sq = (name) => (8 - +name[1]) * 8 + 'abcdefgh'.indexOf(name[0]);

async function launch() {
  const browser = await chromium.launch({ executablePath: EXE });
  return browser;
}

async function newPage(browser, tag) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(tag + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(tag + ' console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  // 화면 가운데 카드 · 토스트 · 배너를 시간순으로 모아 둔다
  await page.evaluate(() => {
    window.__seen = [];
    const rec = (kind, t) => { if (t) window.__seen.push({ kind, t: t.trim(), at: Date.now() }); };
    const mo = new MutationObserver(() => {
      const c = document.querySelector('#center .ctitle');
      if (c && document.querySelector('#center').classList.contains('show')) {
        const s = document.querySelector('#center .csub');
        const key = 'center|' + c.textContent + '|' + (s ? s.textContent : '');
        if (!window.__seen.some(x => x.key === key)) window.__seen.push({ kind: 'center', t: c.textContent + ' / ' + (s ? s.textContent : ''), key, at: Date.now() });
      }
      const t = document.querySelector('#toast');
      if (t && t.classList.contains('show')) {
        const key = 'toast|' + t.textContent;
        if (!window.__seen.some(x => x.key === key)) window.__seen.push({ kind: 'toast', t: t.textContent, key, at: Date.now() });
      }
      document.querySelectorAll('#banners .banner').forEach(b => {
        const key = 'banner|' + b.textContent;
        if (!window.__seen.some(x => x.key === key)) window.__seen.push({ kind: 'banner', t: b.textContent, key, at: Date.now() });
      });
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  page.tag = tag;
  return page;
}

async function hostAndJoin(browser, tc) {
  const A = await newPage(browser, 'A');
  const B = await newPage(browser, 'B');
  if (tc) { await A.selectOption('#o-tc', tc); await B.selectOption('#o-tc', tc); }
  await A.click('#o-color button[data-c="w"]');
  await A.click('#h-host');
  await A.waitForFunction(() => /^[A-Z0-9]{4,6}$/.test(document.querySelector('#lb-code').textContent));
  const code = await A.$eval('#lb-code', n => n.textContent);
  await B.fill('#h-code', code);
  await B.click('#h-join');
  for (const p of [A, B]) {
    await p.waitForFunction(() => window.Game && Game.mode === 'online' && Game.G && Game.mySide && !document.body.classList.contains('athome'), null, { timeout: 15000 });
  }
  return { A, B, code };
}

// 수 두기 — 합법수 목록에서 찾아 Game.play 로 넘긴다
async function move(page, from, to, promo) {
  const ok = await page.evaluate(([f, t, pr]) => {
    const ms = Game.legalFor(f).filter(m => m.to === t && (!pr || m.promo === pr));
    if (!ms.length) return false;
    Game.play(ms[0]);
    return true;
  }, [sq(from), sq(to), promo || null]);
  if (!ok) throw new Error(`${page.tag}: ${from}→${to} 는 합법수가 아님`);
}

// 드래프트 창이 뜨면 고른다. 프롬프트(칸 지정)가 이어지면 첫 칸을 누른다.
async function pickDraft(page, wantId, pickSquares) {
  await page.waitForSelector('.draft .card', { timeout: 8000 });
  const cards = await page.$$eval('.draft .card', cs => cs.map(c => ({ id: c.querySelector('.cardid').textContent, blocked: c.classList.contains('blocked') })));
  let id = wantId && cards.find(c => c.id === wantId && !c.blocked) ? wantId : (cards.find(c => !c.blocked) || {}).id;
  if (!id) throw new Error('고를 카드가 없음: ' + JSON.stringify(cards));
  const card = (await page.$$('.draft .card')).find(async () => true);
  const handles = await page.$$('.draft .card');
  for (const h of handles) {
    const cid = await h.$eval('.cardid', n => n.textContent);
    if (cid === id) { await h.click(); break; }
  }
  await answerPrompts(page, pickSquares);
  return id;
}

async function answerPrompts(page, squares) {
  // 칸 지정 · 선택지 · 확인 프롬프트를 자동으로 넘긴다
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(250);
    const pick = await page.$('.pickbar');
    if (pick) {
      const want = squares && squares.length ? sq(squares.shift()) : null;
      const sel = want !== null ? `#board .sq[data-i="${want}"].pick` : '#board .sq.pick';
      const el = await page.$(sel);
      if (el) { await el.click(); continue; }
      const skip = await page.$('.pickbar .skipbtn');
      if (skip) { await skip.click(); continue; }
    }
    const opt = await page.$('.optlist .opt:not(.blocked)');
    if (opt) { await opt.click(); continue; }
    const yes = await page.$('.modal .opt.primary');
    if (yes) { await yes.click(); continue; }
    if (!(await page.$('.pickbar')) && !(await page.$('.optlist')) && !(await page.$('.draft'))) break;
  }
}

async function waitPly(page, ply) {
  await page.waitForFunction((p) => Game.G && Game.G.ply >= p && !Game.busy, ply, { timeout: 15000 });
}

async function state(page) {
  return page.evaluate(() => ({
    side: Game.mySide, turn: Game.G.turn, ply: Game.G.ply, busy: Game.busy,
    paused: Game.clockPaused, kills: Game.G.kills, augs: Game.G.augs, revealed: Game.G.revealed,
    turnbar: (document.querySelector('#turnbar .turntext') || {}).textContent,
    actions: [...document.querySelectorAll('#actions .act b')].map(b => b.textContent),
    clocks: [...document.querySelectorAll('.clock')].map(c => c.dataset.side + '=' + c.textContent),
    seen: window.__seen.map(x => x.kind + ': ' + x.t),
  }));
}

module.exports = { launch, newPage, hostAndJoin, move, pickDraft, answerPrompts, waitPly, state, sq };
