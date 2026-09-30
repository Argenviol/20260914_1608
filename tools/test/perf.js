/* 느린 CPU 에서 렉이 있는지 — 화면 전환·스크롤·패널 열기를 재어 본다.
   `node tools/test/perf.js` (중계 서버가 :8788 에 떠 있어야 한다)

   재는 것
     - long task: 50ms 넘게 메인 스레드를 잡은 작업. 사람이 '멈칫'으로 느끼는 그것.
     - 프레임 간격: 스크롤 도중 rAF 사이 간격. 16.7ms 가 60fps.
   기준 (CPU 6배 느리게 = 저가 안드로이드폰 정도)
     - 한 동작: 6배 느린 상태에서 400ms 이하 = 실제 기기로 약 65ms.
       사람이 '바로 떴다'고 느끼는 선(100ms)보다 넉넉히 안쪽이다.
     - 스크롤: 최악 프레임 60ms 이하. 여기가 진짜 렉이 보이는 곳이라 더 빡빡하게 잡는다
       (가만히 있을 때의 바닥값이 20~30ms 이므로 그 2배쯤).
   결과는 6배 느린 값과 실제 기기 환산값을 같이 찍는다. */
const H = require('./harness');

const THROTTLE = +(process.env.CPU || 6);
const MAX_TASK = 400;
const MAX_FRAME = 60;

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  if (!ok) fails++;
}

async function armLongTasks(page) {
  await page.evaluate(() => {
    window.__lt = [];
    if (window.__ltObs) window.__ltObs.disconnect();
    window.__ltObs = new PerformanceObserver(list => {
      for (const e of list.getEntries()) window.__lt.push(Math.round(e.duration));
    });
    window.__ltObs.observe({ entryTypes: ['longtask'] });
  });
}

// fn 이 도는 동안 rAF 간격을 모아 내림차순으로 준다
async function frameGaps(page, fn) {
  await page.evaluate(() => {
    window.__frames = []; window.__fr = true;
    let last = performance.now();
    const tick = () => { const n = performance.now(); window.__frames.push(Math.round(n - last)); last = n; if (window.__fr) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await fn();
  return page.evaluate(() => { window.__fr = false; return window.__frames.slice(2).sort((a, b) => b - a); });
}

async function measure(page, label, fn, budget) {
  await page.evaluate(() => { window.__lt = []; });
  await fn();
  await page.waitForTimeout(700);
  const lt = await page.evaluate(() => window.__lt.slice().sort((a, b) => b - a));
  const worst = lt[0] || 0;
  check(`${label} — 가장 긴 작업 ${worst}ms (실제 기기 약 ${Math.round(worst / THROTTLE)}ms)`,
    worst <= (budget || MAX_TASK),
    lt.length ? `50ms 넘은 작업 ${lt.length}개: ${lt.slice(0, 5).join(', ')}` : '50ms 넘은 작업 없음');
  return worst;
}

(async () => {
  const browser = await H.launch();
  const page = await H.newPage(browser, 'P');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  console.log(`CPU ${THROTTLE}배 느리게 — 기준: 한 동작 ${MAX_TASK}ms(실제 약 ${Math.round(MAX_TASK / THROTTLE)}ms) · 스크롤 프레임 ${MAX_FRAME}ms\n`);
  await armLongTasks(page);
  await page.waitForTimeout(500);

  // 스로틀만으로도 프레임이 얼마나 벌어지는지 먼저 잰다 (우리 코드 탓과 구분하려고)
  const idle = await frameGaps(page, async () => { await page.waitForTimeout(1500); });
  console.log(`가만히 있을 때 프레임: 최악 ${idle[0]}ms · 중앙값 ${idle[Math.floor(idle.length / 2)]}ms (스로틀 바닥값)\n`);

  // ── 시작 화면에서 여는 패널 ──
  await measure(page, '시작화면 → 강화 도감 열기', async () => {
    await page.click('#h-codex');
    await page.waitForSelector('.codexwrap, #codex-body, .cx', { timeout: 15000 }).catch(() => { });
    await page.waitForTimeout(300);
  });

  // ── 도감 스크롤 ──
  const frames = await frameGaps(page, async () => {
    await page.mouse.move(640, 500);
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(60); }
    await page.waitForTimeout(300);
  });
  const worstFrame = frames[0] || 0;
  const over = frames.filter(f => f > 33).length;
  // 기준은 '가만히 있을 때의 2배' 와 60ms 중 큰 쪽 — 스로틀 바닥값이 흔들려도 판단이 안 흔들리게.
  const frameBudget = Math.max(MAX_FRAME, (idle[0] || 0) * 2);
  check(`도감 스크롤 — 최악 프레임 ${worstFrame}ms (기준 ${frameBudget}ms)`, worstFrame <= frameBudget,
    `33ms(30fps) 넘은 프레임 ${over}/${frames.length} · 가만히 있을 때 최악 ${idle[0]}ms`);

  await measure(page, '도감 닫기', async () => {
    await page.click('.closebtn'); await page.waitForTimeout(300);
  });

  await measure(page, '시작화면 → 규칙/용어 열기', async () => {
    await page.click('#h-rules');
    await page.waitForTimeout(400);
  });
  await measure(page, '규칙 안에서 바로가기 누르기', async () => {
    const jump = await page.$('#codexbar button, .codexbar button');
    if (jump) await jump.click();
    await page.waitForTimeout(300);
  });
  await measure(page, '규칙 닫기', async () => {
    await page.click('.closebtn'); await page.waitForTimeout(300);
  });

  // ── 대국 시작 · 판 그리기 ──
  await measure(page, '홈 → AI 대국 시작', async () => {
    await page.click('#h-ai');
    await page.waitForFunction(() => window.Game && Game.G && !document.body.classList.contains('athome'), null, { timeout: 20000 });
    await page.waitForTimeout(400);
  });

  await measure(page, '기물 집어 갈 곳 표시', async () => {
    await page.click('#board .sq[data-i="' + H.sq('e2') + '"]');
    await page.waitForTimeout(250);
  });

  // 한 수마다 한 번 도는 것이라, 30번 중 '보통 얼마나 걸리나'(중앙값)를 기준으로 본다.
  // 최악값은 다른 프로세스에 밀리면 크게 튀어서 기준으로 쓰기에 부적절하다 — 참고로만 찍는다.
  const one = await page.evaluate(() => {
    const t = [];
    for (let i = 0; i < 30; i++) { const a = performance.now(); window.renderAll(); t.push(performance.now() - a); }
    t.sort((x, y) => x - y);
    return { mid: Math.round(t[15]), worst: Math.round(t[29]) };
  });
  check(`판 한 번 다시 그리기 — 보통 ${one.mid}ms (실제 기기 약 ${Math.round(one.mid / THROTTLE)}ms)`,
    one.mid <= 120, `30번 연속 · 최악 ${one.worst}ms`);

  await measure(page, '인게임 도감 열기', async () => {
    await page.click('#codex'); await page.waitForTimeout(400);
  });
  await measure(page, '인게임 도감 닫기', async () => {
    await page.click('.closebtn'); await page.waitForTimeout(300);
  });

  console.log('\nerrors:', page.errors);
  await browser.close();
  console.log(fails ? `\n${fails} FAIL` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
