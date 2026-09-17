/* ============================================================
   무제체스 - UI

   배치 (왼쪽 → 오른쪽): 체스판 · 내 진영 · 상대 진영
   진행 기록은 체스판 아래.
   ============================================================ */
(function (global) {
  'use strict';
  const E = global.Engine;
  const G = () => global.Game.G;
  const Game = () => global.Game;
  const SFX = () => global.SFX;

  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined) n.textContent = txt;
    return n;
  };
  const sideName = (s) => (s === 'w' ? '백' : '흑');

  /* ───────── 상태 ───────── */
  let sel = -1;
  let dests = [];
  let pending = null;                 // 대상 지정 {squares, resolve, optional}
  let flip = false;
  let flashSquares = new Set();
  let flashTimer = null;
  let drag = null;                    // {from, ghost, moved, startX, startY}
  let review = null;                  // 지난 국면을 보는 중이면 스냅샷 객체
  let reviewIdx = -1;                 // 그 국면이 몇 번째인가 (같은 줄을 다시 누르면 나간다)
  let pathHint = null;                // {steps:[], to} — 도약 경로 표시
  let peek = null;                    // {from, dests} — 둘 수는 없고 '어디로 갈 수 있나'만 보는 중
  let draftingSide = null;            // 증강을 고르는 중인 진영 ('w'|'b'), 아니면 null
  let premove = null;                 // {from, to, type} — 상대 차례에 미리 예약해 둔 내 수
  let pmFrom = -1, pmDests = [];      // 예약할 기물을 고르는 중 (출발 칸 · 갈 수 있는 칸)
  let pmTimer = null;
  let oppDraft = null;                // {left, limit, at, piece, tier} — 상대가 증강을 고르는 중 (온라인)
  let chatLog = [];                   // [{who:'me'|'you', text, emote, at}]
  let chatUnread = 0;
  let pathTimer = null;
  let modalDepth = 0;
  let pauseDepth = 0;                 // 시계를 멈추는 모달의 수 (도감·규칙·계정 창은 세지 않는다)
  let prev = { kills: { w: 0, b: 0 }, ply: -1, result: null, check: false };
  let lowTimeWarned = { w: false, b: false };

  /* ───────── 용어 강조 ─────────
     증강 문구 안의 용어와 아래 #태그를 같은 색으로 칠한다. */
  function escapeHTML(t) {
    return t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function termHTML(text, terms) {
    let html = escapeHTML(text);
    for (const t of (terms || [])) {
      if (t === '비밀') continue;                    // 문구에 안 나오고 태그로만 표시
      const st = global.TERM_STYLES[t];
      if (!st) continue;
      html = html.split(t).join(
        `<span class="tw" data-term="${t}" role="button" tabindex="0" title="눌러서 뜻 보기"` +
        ` style="color:${st.fg};background:${st.bg};border-color:${st.line}">${t}</span>`);
    }
    return html;
  }
  /* 지속 유형 — 원본 시트가 칸 색으로 구분하던 축이다.
     기물은 카드 제목에 이미 적혀 있으므로, 색은 이 축에 쓰는 편이 훨씬 많이 알려준다. */
  const DUR = {
    '턴제한':   { cls: 'd-turn',  icon: '⏱', hint: '정해진 턴이 지나면 사라집니다' },
    '횟수제한': { cls: 'd-count', icon: '↻', hint: '정해진 횟수만 쓰고 사라집니다' },
    '영구지속': { cls: 'd-perm',  icon: '∞', hint: '판이 끝날 때까지 남습니다' },
  };
  function durOf(tag) { return DUR[tag] || { cls: 'd-none', icon: '·', hint: '지속 개념이 없는 즉시 효과입니다' }; }
  function durChip(tag) {
    const d = durOf(tag);
    const c = el('span', 'durchip ' + d.cls, d.icon + ' ' + tag);
    c.title = d.hint;
    return c;
  }

  function termTags(terms) {
    const wrap = el('div', 'termtags');
    for (const t of (terms || [])) {
      const st = global.TERM_STYLES[t];
      if (!st) continue;
      const g = global.GLOSSARY.find(x => x.term === t);
      const tag = el('span', 'ttag', '#' + t);
      tag.dataset.term = t;
      tag.setAttribute('role', 'button');
      tag.style.color = st.fg;
      tag.style.background = st.bg;
      tag.style.borderColor = st.line;
      if (g) tag.title = g.desc;
      wrap.appendChild(tag);
    }
    return wrap;
  }

  /* 용어를 누르면 뜻을 띄운다.
     증강을 고르는 화면에서는 용어가 '카드' 버튼 안에 들어 있다. 그냥 두면 뜻을 보려다
     그 증강이 골라져 버린다. 그래서 캡처 단계에서 먼저 잡고 클릭을 거기서 끊는다. */
  let termPop = null;

  function closeTermPop() {
    if (termPop) { termPop.remove(); termPop = null; }
  }

  function showTermPop(term, anchor) {
    closeTermPop();
    const gl = (global.GLOSSARY || []).find(x => x.term === term);
    if (!gl) return;
    const st = global.TERM_STYLES[term];
    const pop = el('div', 'termpop');
    const head = el('div', 'termpophead');
    const chip = el('span', 'tw', term);
    if (st) { chip.style.color = st.fg; chip.style.background = st.bg; chip.style.borderColor = st.line; }
    head.appendChild(chip);
    const x = el('button', 'termpopx', '✕');
    x.title = '닫기';
    x.onclick = closeTermPop;
    head.appendChild(x);
    pop.appendChild(head);
    pop.appendChild(el('div', 'termpopbody', gl.desc));
    document.body.appendChild(pop);

    // 누른 자리 바로 아래. 화면 밖으로 나가면 안쪽으로 당긴다.
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    termPop = pop;
  }

  function wireTerms() {
    document.addEventListener('pointerdown', (ev) => {
      const t = ev.target.closest && ev.target.closest('[data-term]');
      if (!t) {
        if (!(ev.target.closest && ev.target.closest('.termpop'))) closeTermPop();
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();              // 증강 카드가 골라지지 않게
      showTermPop(t.dataset.term, t);
      SFX().pick();
    }, true);
    // pointerdown 을 막아도 click 은 따로 온다. 그것도 카드에 닿지 않게 끊는다.
    document.addEventListener('click', (ev) => {
      if (ev.target.closest && ev.target.closest('[data-term]')) {
        ev.stopPropagation(); ev.preventDefault();
      }
    }, true);
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (termPop) { closeTermPop(); return; }
      if (premove || pmFrom >= 0) { cancelPremove(); return; }
      if (review) exitReview();
    });
    window.addEventListener('resize', closeTermPop);
  }

  /* ───────── 전적 기록 (localStorage + 계정) ─────────
     기본은 이 브라우저에만 남는다. 로그인해 두면 판이 끝날 때마다 계정과 합쳐서
     다른 기기에서도 같은 전적이 보인다. 합치는 기준은 판마다 붙인 id 다. */
  const REC_KEY = 'mujeChess.records.v1';
  function withId(r) {
    // 예전 기록에는 id 가 없다. 시각+모드로 만들어 두 번 합쳐도 겹치지 않게 한다.
    if (!r.id) r.id = 'r' + r.at + '-' + (r.mode || '');
    return r;
  }
  function loadRecords() {
    try { return JSON.parse(localStorage.getItem(REC_KEY) || '[]').map(withId); }
    catch (e) { return []; }
  }
  function storeRecords(all) {
    try { localStorage.setItem(REC_KEY, JSON.stringify(all.slice(0, 100))); }
    catch (e) { /* 사생활 보호 모드 등에서 저장이 막혀도 게임은 계속된다 */ }
  }
  function saveRecord(rec) {
    // '전적 저장 끔' 이면 아무 데도 안 남긴다
    if (global.Stats && !global.Stats.enabled()) return;
    rec.id = 'r' + rec.at + '-' + Math.random().toString(36).slice(2, 8);
    const all = loadRecords();
    all.unshift(rec);
    storeRecords(all);
    syncRecords();
  }
  // 계정과 합친다. 서버가 안 되면 조용히 넘긴다 — 브라우저 기록은 이미 남아 있다.
  let syncing = false;
  function syncRecords() {
    const A = global.Account;
    if (!A || !A.loggedIn() || syncing) return;
    syncing = true;
    A.syncRecords(loadRecords())
      .then(list => { storeRecords(list); renderHomeRecords(); })
      .catch(() => { })
      .then(() => { syncing = false; });
  }

  /* ═══════════════════ 체스판 ═══════════════════ */
  function bottomSide() { return flip ? 'b' : 'w'; }

  function renderBoard() {
    const board = $('#board');
    board.innerHTML = '';
    const g = G();
    if (review) { renderReviewBoard(board, g); return; }
    const order = [];
    for (let i = 0; i < 64; i++) order.push(i);
    if (flip) order.reverse();

    const human = Game().isHuman(g.turn) && !g.result && !Game().busy;
    const pmOk = canPremove();
    const pmSide = pmOk ? premoveSide() : null;

    for (const i of order) {
      const [r, c] = E.rc(i);
      const sq = el('div', 'sq ' + (E.lightSquare(i) ? 'light' : 'dark'));
      sq.dataset.i = i;

      /* 마지막에 둔 쪽의 수를 칠한다. 내 수만 들고 있는 Game.lastMove 를 쓰면
         온라인에서 상대 판을 받아 왔을 때(adopt) 갱신되지 않아 내 옛 수가 계속 노랗게 남았다.
         판 안의 lastBySide 는 상태 전송에 같이 실려 온다. */
      const lm = g.lastBySide[E.other(g.turn)] || g.lastBySide[g.turn];
      if (lm && (lm.from === i || lm.to === i)) sq.classList.add('last');
      if (i === sel) sq.classList.add('sel');
      if (dests.includes(i)) sq.classList.add(g.bd[i] ? 'capture' : 'dest');
      // 살펴보기 — 두는 게 아니라 사거리만 보는 중이라 다른 색으로 구분한다
      if (peek) {
        if (i === peek.from) sq.classList.add('peekfrom');
        else if (peek.dests.includes(i)) sq.classList.add(g.bd[i] ? 'peekcap' : 'peek');
      }
      if (pending && pending.squares.includes(i)) sq.classList.add('pick');
      if (flashSquares.has(i)) sq.classList.add('flash');
      // 수 예약 — 고르는 중인 기물과 갈 곳, 그리고 이미 예약한 수
      if (pmOk) {
        if (i === pmFrom) sq.classList.add('pmsel');
        else if (pmDests.includes(i)) sq.classList.add(g.bd[i] ? 'pmcap' : 'pmdest');
        if (premove && (i === premove.from || i === premove.to)) sq.classList.add('premove');
      }

      // 도약 경로 — 지나간 칸에 순번을 찍어 어떻게 간 것인지 보여 준다
      if (pathHint) {
        const k = pathHint.steps.indexOf(i);
        if (k >= 0) {
          sq.classList.add('pathstep');
          sq.appendChild(el('span', 'pathno', String(k + 1)));
        }
        if (i === pathHint.from) sq.classList.add('pathfrom');
        if (i === pathHint.to) sq.classList.add('pathend');
      }

      const p = g.bd[i];
      if (p) {
        const pe = el('div', 'pc ' + (p.color === 'w' ? 'wp' : 'bp'), GLYPH[p.type]);
        if (p.type === 'k' && E.inCheck(g, p.color) && !g.result) sq.classList.add('incheck');
        if ((human && p.color === g.turn) || (pmOk && p.color === pmSide)) pe.classList.add('grab');
        if (drag && drag.from === i) pe.classList.add('dragging');
        const ur = Game().untargetableRemain(p.id);
        if (ur !== null) {
          pe.classList.add('untouchable');
          const b = el('span', 'badge lock', String(ur));
          b.title = `지정불가 — ${ur}수 뒤 해제. 체크를 벗어나는 수는 예외로 움직일 수 있습니다.`;
          sq.appendChild(b);
        }
        if (g.eff.some(e => e.kind === 'bishopRoot' && e.ids.includes(p.id))) pe.classList.add('rooted');
        sq.appendChild(pe);
      }
      if ((flip ? c === 7 : c === 0)) sq.appendChild(el('span', 'coord rank', String(8 - r)));
      if ((flip ? r === 0 : r === 7)) sq.appendChild(el('span', 'coord file', E.FILES[c]));
      board.appendChild(sq);
    }

    const ph = $('#phased');
    ph.innerHTML = '';
    for (const x of g.phased) {
      const b = el('span', 'chip');
      b.innerHTML = `<b class="${x.owner === 'w' ? 'wp' : 'bp'}">${GLYPH[x.pc.type]}</b> ${E.sqName(x.sq)} 포영 · ${Math.max(0, x.until - g.ply)}수 남음`;
      ph.appendChild(b);
    }
  }

  // 지난 국면은 읽기 전용으로만 그린다 (조작·강조 없음)
  function renderReviewBoard(board, g) {
    const order = [];
    for (let i = 0; i < 64; i++) order.push(i);
    if (flip) order.reverse();
    for (const i of order) {
      const [r, c] = E.rc(i);
      const sq = el('div', 'sq ' + (E.lightSquare(i) ? 'light' : 'dark'));
      sq.dataset.i = i;
      if (review.from >= 0 && (i === review.from || i === review.to)) sq.classList.add('last');
      const code = review.board[i];
      if (code) {
        sq.appendChild(el('div', 'pc ' + (code[1] === 'w' ? 'wp' : 'bp'), GLYPH[code[0]]));
      }
      if ((flip ? c === 7 : c === 0)) sq.appendChild(el('span', 'coord rank', String(8 - r)));
      if ((flip ? r === 0 : r === 7)) sq.appendChild(el('span', 'coord file', E.FILES[c]));
      board.appendChild(sq);
    }
    $('#phased').innerHTML = '';
  }

  function enterReview(idx) {
    const g = G();
    const snap = g.snaps[idx];
    if (!snap) return;
    review = snap;
    SFX().pick();
    render();
    // 판 컬럼 안(턴 바 자리)에 넣는다. 화면에 띄우면 아래 진영 스트립을 가린다.
    document.body.classList.add('reviewing');
    let bar = $('#reviewbar');
    if (!bar) {
      bar = el('div', 'reviewbar'); bar.id = 'reviewbar';
      const col = document.querySelector('.board-col');
      col.insertBefore(bar, $('#oppstrip'));
    }
    /* 턴 바가 있던 자리에 그대로 들어간다. 두 바의 높이가 다르면 그 차이만큼 판이
       줄었다 늘었다 해서, 기록을 누를 때마다 화면이 출렁인다. 한 줄로 고정한다. */
    bar.innerHTML = '';
    const prev = el('button', 'skipbtn', '←');
    prev.title = '이전 국면';
    const next = el('button', 'skipbtn', '→');
    next.title = '다음 국면';
    const info = el('span', 'revinfo', snap.side
      ? `${snap.moveNo}수째 · ${snap.side === 'w' ? '백' : '흑'} 둔 뒤 · 처치 ${snap.kills.w}·${snap.kills.b}`
      : '시작 국면');
    info.title = info.textContent;
    const back = el('button', 'nav small', '현재로 ✕');
    back.title = '지금 판으로 (Esc)';
    prev.onclick = () => enterReview(Math.max(0, idx - 1));
    next.onclick = () => (idx + 1 < g.snaps.length ? enterReview(idx + 1) : exitReview());
    back.onclick = exitReview;
    bar.appendChild(prev); bar.appendChild(info); bar.appendChild(next); bar.appendChild(back);
    bar.classList.add('show');
    reviewIdx = idx;
  }

  function exitReview() {
    review = null;
    reviewIdx = -1;
    document.body.classList.remove('reviewing');
    const bar = $('#reviewbar');
    if (bar) bar.remove();
    SFX().pick();
    render();
  }

  /* 도약(나이트)처럼 '어떻게 간 건지' 가 안 보이는 수만 경로를 그린다.
     미끄러지는 기물은 사이 칸이 뻔하므로 그리지 않는다. */
  /* 보통 체스대로 움직인 수까지 경로를 그리면 오히려 어수선하다.
     증강 때문에 '평소와 다르게' 간 수만 그린다. */
  function isNormalMove(type, from, to) {
    const [r0, c0] = E.rc(from), [r1, c1] = E.rc(to);
    const dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0);
    if (type === 'n') return (dr === 2 && dc === 1) || (dr === 1 && dc === 2);
    return false;                       // 나이트 말고는 도약하지 않는다
  }

  function leapHint(from, to) {
    const g = G();
    const p = g.bd[from];
    if (!p) return null;
    if (isNormalMove(p.type, from, to)) return null;   // 평범한 나이트 수 → 안 그림
    const steps = E.leapPath(from, to);
    return steps.length ? { steps, from, to } : null;
  }

  function setPathHint(h) {
    const same = (!h && !pathHint) || (h && pathHint && pathHint.from === h.from && pathHint.to === h.to);
    if (same) return;
    clearTimeout(pathTimer); pathTimer = null;
    pathHint = h;
    renderBoard();
  }

  // 둔 뒤에 잠깐 보여 준다 (상대 화면에서도 같은 경로가 뜬다)
  function showPathFor(lm, ms) {
    if (!lm || !lm.path || !lm.path.length) return false;
    if (isNormalMove(lm.type, lm.from, lm.to)) return false;   // 평범한 수는 안 그린다
    clearTimeout(pathTimer);
    // pinned — 방금 둔 수를 보여 주는 중이다. 마우스가 판 위를 스쳐도 지우지 않는다.
    pathHint = { steps: lm.path, from: lm.from, to: lm.to, pinned: true };
    renderBoard();
    pathTimer = setTimeout(() => { pathHint = null; renderBoard(); }, ms || 3600);
    return true;
  }

  /* 아무 기물이나 눌러 '어디로 갈 수 있나' 를 본다 — 내 것이든 상대 것이든.
     상대 차례를 가정하고 계산해야 하므로 turn 을 잠시 바꿔서 뽑는다.
     두는 것과 헷갈리지 않게 색을 따로 쓴다. */
  function peekMoves(i) {
    const g = G();
    const p = g.bd[i];
    if (!p) return null;
    const save = g.turn;
    g.turn = p.color;
    let ms = [];
    try { ms = E.legalMoves(g, i); } catch (e) { ms = []; }
    g.turn = save;
    return { from: i, dests: [...new Set(ms.map(m => m.to))] };
  }

  function setPeek(p) {
    const same = (!p && !peek) || (p && peek && peek.from === p.from);
    if (same && p) { peek = null; renderBoard(); return; }   // 같은 기물 다시 누르면 끈다
    peek = p;
    renderBoard();
  }

  function squareAt(x, y) {
    const n = document.elementFromPoint(x, y);
    const sq = n && n.closest ? n.closest('#board .sq') : null;
    return sq ? +sq.dataset.i : -1;
  }

  /* ───────── 클릭 + 드래그 ───────── */
  function canControl() {
    const g = G();
    return !g.result && !Game().busy && Game().isHuman(g.turn)
      && Game().myTurn() && !pending && !review;
  }

  /* ───────── 수 예약 (상대 차례에 미리 두기) ─────────
     상대가 두는 동안 내 기물을 집어 갈 곳에 놓아 두면, 내 차례가 오는 순간 그 수를 둔다.
     그때 판에서 합법이 아니면(기물이 잡혔거나 길이 막혔거나) 조용히 취소한다.
     AI 대전과 온라인에서만 뜻이 있다 — 한 화면 2인 대전은 항상 둘 수 있는 쪽이 있다. */
  function premoveSide() {
    const gm = Game();
    return gm.mode === 'online' ? gm.mySide : gm.mode === 'ai' ? E.other(gm.aiSide) : null;
  }
  function canPremove() {
    const g = G(), gm = Game();
    if (!g || g.result || review || pending) return false;
    if (gm.mode === 'online') return g.turn !== gm.mySide;
    if (gm.mode === 'ai') return g.turn === gm.aiSide || gm.busy;
    return false;
  }
  // 내 차례라 치고 그 기물이 갈 수 있는 곳. 상대가 둔 뒤에 다시 검사하므로 지금은 대략이면 된다.
  function premoveDests(i) {
    const pk = peekMoves(i);
    return pk ? pk.dests : [];
  }
  function setPremove(from, to) {
    const p = G().bd[from];
    premove = { from, to, type: p ? p.type : 'p' };
    pmFrom = -1; pmDests = [];
    SFX().pick();
    toast(`수 예약 — ${E.KO[premove.type]} ${E.sqName(from)}→${E.sqName(to)}. 내 차례가 오면 바로 둡니다 (판을 우클릭하면 취소)`);
    render();
  }
  function cancelPremove(silent) {
    const had = premove || pmFrom >= 0;
    premove = null; pmFrom = -1; pmDests = [];
    if (had && !silent) { toast('예약한 수를 취소했습니다'); SFX().deny(); }
    if (had) render();
  }
  // 내 차례가 열리면 예약한 수를 둔다. 상대의 수를 잠깐 보여 준 뒤에.
  function schedulePremove() {
    clearTimeout(pmTimer);
    if (!premove) return;
    pmTimer = setTimeout(runPremove, 180);
  }
  async function runPremove() {
    if (!premove || !canControl()) return;
    const g = G(), gm = Game();
    if (gm.mode === 'online' && g.begunPly !== g.ply) return;   // 턴 시작 처리가 아직 안 끝났다
    const pm = premove; premove = null;
    const p = g.bd[pm.from];
    const ms = p ? gm.legalFor(pm.from).filter(m => m.to === pm.to) : [];
    if (!ms.length) {
      toast(`예약한 수(${E.sqName(pm.from)}→${E.sqName(pm.to)})를 지금 판에서는 둘 수 없어 취소했습니다`);
      SFX().deny(); render();
      return;
    }
    const m = ms.find(x => x.promo === 'q') || ms[0];   // 승격이면 퀸으로
    sel = -1; dests = []; setPeek(null);
    await gm.play(m);
  }

  function selectSquare(i) {
    const g = G();
    const p = g.bd[i];
    if (p && p.color === g.turn) {
      sel = i;
      dests = Game().legalFor(i).map(m => m.to);
      if (!dests.length) {
        const why = E.restrictedBy(g, g.turn, i, i);
        toast(why ? `이 기물은 지금 움직일 수 없습니다 — ${why}` : '둘 수 있는 곳이 없습니다');
        SFX().deny();
      } else SFX().lift();
    } else { sel = -1; dests = []; setPathHint(null); }
    renderBoard();
  }

  async function tryMove(from, to) {
    const moves = Game().legalFor(from).filter(m => m.to === to);
    if (!moves.length) return false;
    let move = moves[0];
    if (moves.length > 1 && moves[0].promo) {
      const t = await pickOption('승격할 기물을 고르세요',
        [...new Set(moves.map(m => m.promo))].map(x => ({ label: E.KO[x], value: x })));
      if (!t) return false;
      move = moves.find(m => m.promo === t);
    }
    sel = -1; dests = [];
    await Game().play(move);
    return true;
  }

  function onPointerDown(ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    SFX().unlock();
    const i = squareAt(ev.clientX, ev.clientY);
    if (i < 0) return;

    // 대상 지정 중
    if (pending) {
      if (pending.squares.includes(i)) { const r = pending.resolve; pending = null; SFX().pick(); render(); r(i); }
      else SFX().deny();
      return;
    }
    const g = G();
    const p = g.bd[i];

    // 둘 수 없는 상황(상대 차례·관전·끝난 판)에서는 '살펴보기' 로만 쓴다
    if (!canControl()) {
      if (canPremove()) {
        const me = premoveSide();
        // 예약할 기물을 고른 뒤 갈 곳을 누름 → 예약
        if (pmFrom >= 0 && pmDests.includes(i)) { setPremove(pmFrom, i); return; }
        if (p && p.color === me) {
          // 내 기물 → 예약할 출발점. 끌어서 놓을 수도 있다.
          premove = null; peek = null;
          pmFrom = i; pmDests = premoveDests(i);
          if (!pmDests.length) { toast('지금 판에서는 이 기물이 갈 곳이 없습니다'); SFX().deny(); }
          else SFX().lift();
          drag = { from: i, moved: false, startX: ev.clientX, startY: ev.clientY, type: p.type, color: p.color, premove: true };
          renderBoard();
          ev.preventDefault();
          return;
        }
        // 빈칸·상대 기물 → 예약을 접고, 상대 기물이면 사거리만 본다
        const had = premove || pmFrom >= 0;
        premove = null; pmFrom = -1; pmDests = [];
        if (had && !p) { toast('예약한 수를 취소했습니다'); }
        setPeek(p ? peekMoves(i) : null);
        if (had) render();
        return;
      }
      setPeek(p ? peekMoves(i) : null);
      return;
    }

    // 선택된 상태에서 목적지를 누름 → 이동
    if (sel >= 0 && dests.includes(i)) { setPeek(null); tryMove(sel, i); return; }

    if (p && p.color === g.turn) {
      setPeek(null);
      selectSquare(i);
      if (!dests.length) return;
      // 드래그 시작
      drag = { from: i, moved: false, startX: ev.clientX, startY: ev.clientY, type: p.type, color: p.color };
      ev.preventDefault();
    } else if (p) {
      // 내 차례여도 상대 기물을 누르면 그 기물의 사거리를 보여 준다
      sel = -1; dests = [];
      setPeek(peekMoves(i));
    } else {
      sel = -1; dests = []; setPeek(null);
    }
  }

  function onPointerMove(ev) {
    if (!drag) return;
    const dx = ev.clientX - drag.startX, dy = ev.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      const ghost = $('#dragghost');
      ghost.textContent = GLYPH[drag.type];
      ghost.className = 'show ' + (drag.color === 'w' ? 'wp' : 'bp');
      renderBoard();
    }
    const ghost = $('#dragghost');
    ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px) translate(-50%, -50%)`;
    // 호버 강조 (예약 드래그면 예약 후보 칸 기준)
    const ds = drag.premove ? pmDests : dests;
    const over = squareAt(ev.clientX, ev.clientY);
    const want = (over >= 0 && ds.includes(over)) ? leapHint(drag.from, over) : null;
    if (want) setPathHint(want);
    else if (pathHint && !pathHint.pinned) setPathHint(null);
    document.querySelectorAll('#board .sq.over').forEach(n => n.classList.remove('over'));
    if (over >= 0 && ds.includes(over)) {
      const n = document.querySelector(`#board .sq[data-i="${over}"]`);
      if (n) n.classList.add('over');
    }
  }

  // 기물을 고른 채 갈 곳 위에 올리면 그리로 가는 경로를 그려 준다
  function onBoardHover(ev) {
    if (drag || review || pending) return;
    const over = sel >= 0 ? squareAt(ev.clientX, ev.clientY) : -1;
    const want = (over >= 0 && dests.includes(over)) ? leapHint(sel, over) : null;
    // 방금 둔 수를 보여 주는 중이면, 다른 곳을 가리켜도 그대로 둔다
    if (!want && pathHint && pathHint.pinned) return;
    setPathHint(want);
  }

  async function onPointerUp(ev) {
    if (!drag) return;
    const d = drag; drag = null;
    $('#dragghost').className = '';
    document.querySelectorAll('#board .sq.over').forEach(n => n.classList.remove('over'));
    if (!d.moved) { renderBoard(); return; }            // 클릭이었음 → 선택 유지
    const to = squareAt(ev.clientX, ev.clientY);
    if (d.premove) {
      if (to >= 0 && pmDests.includes(to)) setPremove(d.from, to);
      else renderBoard();
      return;
    }
    if (to >= 0 && dests.includes(to)) { await tryMove(d.from, to); }
    else { renderBoard(); }
  }

  /* ═══════════════════ 진영 스트립 (판 위 = 상대, 판 아래 = 나) ═══════════════════ */
  function fmtClock(ms) {
    if (ms === null) return '∞';
    const s = Math.max(0, ms) / 1000;
    if (s < 10) return s.toFixed(1);
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function whoIs(side) {
    const gm = Game();
    if (gm.mode === 'online') {
      return side === gm.mySide
        ? { title: '나 (' + sideName(side) + ')', kind: 'me' }
        : { title: '상대 (' + sideName(side) + ')', kind: 'human' };
    }
    if (gm.mode === 'ai') {
      if (side === gm.aiSide) return { title: 'AI · ' + global.AI.LEVELS[gm.difficulty].label, kind: 'ai' };
      return { title: '나', kind: 'me' };
    }
    return { title: sideName(side) + ' 플레이어', kind: 'human' };
  }

  // 한 줄짜리 진영 바: 이름 · 처치 진행 · 증강 수 · 시계
  function renderStrip(side, container) {
    const g = G(), gm = Game();
    container.innerHTML = '';
    const who = whoIs(side);
    const active = g.turn === side && !g.result;

    const box = el('div', 'strip' + (active ? ' active' : ''));

    const nm = el('div', 'stripname');
    nm.appendChild(el('span', 'dot ' + (side === 'w' ? 'dw' : 'db')));
    nm.appendChild(el('b', null, sideName(side)));
    nm.appendChild(el('span', 'stripwho', who.title));
    box.appendChild(nm);

    /* 처치 진행 — 예전에는 막대 하나에 '다음 N처치' 글자만 있어서
       1·3·6·11 이 어디쯤인지 눈에 안 들어왔다. 눈금을 직접 찍고 숫자도 같이 쓴다. */
    const thr = gm.nextThreshold(g, side);
    const prog = el('div', 'stripprog');
    prog.appendChild(el('span', 'killn', '처치 ' + g.kills[side]));

    const track = el('div', 'kiltrack');
    const maxT = global.TIERS[global.TIERS.length - 1];
    const fill = el('div', 'kilfill');
    fill.style.width = Math.min(100, (g.kills[side] / maxT) * 100) + '%';
    track.appendChild(fill);
    for (const t of global.TIERS) {
      const done = g.kills[side] >= t;
      const next = thr === t;
      const pip = el('span', 'kilpip' + (done ? ' done' : '') + (next ? ' next' : ''));
      pip.style.left = (t / maxT) * 100 + '%';
      pip.appendChild(el('i', null, String(t)));
      pip.title = done ? `${t}처치 달성` : `${t}처치까지 ${t - g.kills[side]}개`;
      track.appendChild(pip);
    }
    prog.appendChild(track);
    prog.appendChild(el('span', 'killsub',
      thr === null ? '완료' : '다음 ' + Math.max(0, thr - g.kills[side])));
    box.appendChild(prog);

    /* 이 진영이 잡은 기물들. grave[색] 은 '그 색이 잃은 기물' 이므로 상대 무덤을 본다.
       값이 큰 것부터 늘어놓아야 한눈에 이득을 가늠할 수 있다. */
    const taken = g.grave[E.other(side)].slice()
      .sort((a, b) => (E.VALUE[b] || 0) - (E.VALUE[a] || 0));
    const clockBox = el('div', 'clockbox');
    const tk = el('div', 'taken' + (taken.length ? '' : ' none'));
    if (taken.length) {
      for (const t of taken) {
        const gl = el('span', 'tkpc ' + (side === 'w' ? 'bp' : 'wp'), GLYPH[t]);
        gl.title = E.KO[t];
        tk.appendChild(gl);
      }
      const adv = taken.reduce((n, t) => n + (E.VALUE[t] || 0), 0)
        - g.grave[side].reduce((n, t) => n + (E.VALUE[t] || 0), 0);
      if (adv > 0) tk.appendChild(el('span', 'tkadv', '+' + adv));
      tk.title = '잡은 기물';
    } else {
      tk.textContent = '잡은 기물 없음';
    }
    clockBox.appendChild(tk);

    const ck = el('div', 'clock' + (active ? ' running' : ''));
    ck.dataset.side = side;
    ck.textContent = fmtClock(gm.clockRemain(side));
    clockBox.appendChild(ck);
    box.appendChild(clockBox);

    container.appendChild(box);
  }

  function renderStrips() {
    const bottom = bottomSide();
    renderStrip(E.other(bottom), $('#oppstrip'));
    renderStrip(bottom, $('#mystrip'));
  }

  /* 마지막 수와 증강 수 — 예전에는 진영 스트립 안에서 처치 눈금과 한 줄을 다퉜다.
     스트립 너비는 판에 딸려 있어서 좁아지면 눈금 '11' 글자 위로 겹쳤다.
     판 옆(탭 위)으로 빼서 두 진영을 나란히 놓는다. 처치 눈금만 스트립에 남는다. */
  function lastMoveRow(side) {
    const g = G();
    const row = el('div', 'lmrow');

    const who = el('span', 'lmside');
    who.appendChild(el('span', 'dot ' + (side === 'w' ? 'dw' : 'db')));
    who.appendChild(el('b', null, sideName(side)));
    row.appendChild(who);

    const lm = g.lastBySide[side];
    if (lm) {
      const mv = el('button', 'striplast');
      const cap = lm.victim ? ' ×' + E.KO[lm.victim] : '';
      const pr = lm.promo ? '=' + E.KO[lm.promo] : '';
      mv.innerHTML = '<span class="lmpiece">' + E.KO[lm.type] + '</span>' +
        E.sqName(lm.from) + '→' + E.sqName(lm.to) + pr +
        (cap ? '<span class="lmcap">' + cap + '</span>' : '');
      mv.title = '이 수가 지나간 칸을 표시합니다';
      mv.onclick = () => { if (!showPathFor(lm)) flash([lm.from, lm.to], null, null, true); };
      row.appendChild(mv);
    } else {
      row.appendChild(el('span', 'striplast none', '아직 안 둠'));
    }

    const n = g.augs[side].length;
    const ac = el('button', 'stripaug' + (n ? '' : ' none'), '증강 ' + n);
    ac.title = '증강 탭 열기';
    ac.onclick = () => { setTab('aug'); SFX().pick(); };
    row.appendChild(ac);

    return row;
  }

  function renderLastMoves() {
    const box = $('#lastmoves');
    if (!box) return;
    const bottom = bottomSide();
    box.innerHTML = '';
    box.appendChild(lastMoveRow(E.other(bottom)));
    box.appendChild(lastMoveRow(bottom));
  }

  /* ───────── 턴 바 ───────── */
  function renderTurnbar() {
    const g = G(), gm = Game();
    const t = $('#turnbar');
    t.className = '';
    t.innerHTML = '';
    t.appendChild(el('span', 'modetag',
      gm.mode === 'ai' ? 'AI 대전' : gm.mode === 'online' ? '온라인 대전' : '2인 대전'));

    if (g.result) {
      t.classList.add('over');
      t.appendChild(el('span', 'turntext',
        (g.result.winner ? sideName(g.result.winner) + ' 승리' : '무승부') + ' — ' + g.result.reason));
      return;
    }
    t.classList.add(g.turn === 'w' ? 'tw' : 'tb');
    const who = whoIs(g.turn);
    let msg;
    if (who.kind === 'ai') msg = sideName(g.turn) + ' 차례 — AI가 생각하고 있습니다';
    else if (who.kind === 'me') msg = sideName(g.turn) + ' 차례 — 당신이 둘 차례입니다';
    else if (gm.mode === 'online') {
      /* '증강을 고르는 중' 은 상대가 실제로 드래프트 신호를 보냈을 때만.
         예전에는 시계가 멈추기만 하면 그렇게 적어서, 상대가 도감을 열어도 그 말이 떴다. */
      msg = sideName(g.turn) + ' 차례 — '
        + (oppDraft ? '상대가 증강을 고르는 중입니다'
          : gm.clockPaused ? '상대가 대상을 지정하는 중입니다' : '상대가 두는 중입니다');
    }
    else msg = sideName(g.turn) + ' 차례 — ' + sideName(g.turn) + ' 플레이어가 두세요';
    if (draftingSide) msg = sideName(draftingSide) + ' — 증강을 고르는 중입니다';
    const tt = el('span', 'turntext', msg);
    tt.title = msg;                       // 좁아서 말줄임될 때 원문을 볼 수 있게
    t.appendChild(tt);

    // 예약한 수 — 누르면 취소
    if (premove && canPremove()) {
      const b = el('button', 'pmchip',
        `예약 ${E.KO[premove.type]} ${E.sqName(premove.from)}→${E.sqName(premove.to)} ✕`);
      b.title = '내 차례가 오면 이 수를 둡니다. 누르면 취소합니다.';
      b.onclick = () => cancelPremove();
      t.appendChild(b);
    } else if (canPremove() && !premove && pmFrom < 0) {
      const h = el('span', 'pmhint', '내 기물을 끌어 두면 수를 예약할 수 있습니다');
      t.appendChild(h);
    }

    if (E.inCheck(g, g.turn)) t.appendChild(el('span', 'checkchip', '체크!'));

    const info = global.AI.lastInfo;
    if (gm.mode === 'ai' && info && !g.result) {
      const d = info.book ? '정석 오프닝'
        : info.blunder ? '감으로 둠'
          : info.depth + '수 앞 · ' + (info.nodes / 1000).toFixed(1) + 'k 검토';
      t.appendChild(el('span', 'aichip', d));
    }
  }

  /* ───────── 사용 가능 증강 ───────── */
  function renderActions() {
    const g = G(), box = $('#actions');
    box.innerHTML = '';
    // 온라인에서는 내 차례에 내 것만. 상대 차례에 상대 증강 버튼이 떠서 눌러도 안 되던 것.
    if (g.result || !Game().isHuman(g.turn) || !Game().myTurn()) return;
    const ids = Game().activatable(g.turn);
    if (!ids.length) return;
    for (const id of ids) {
      const a = global.AUG_BY_ID[id];
      const b = el('button', 'act');
      b.innerHTML = '<b>' + a.piece + ' ' + id + ' 사용</b>' +
        '<span>' + termHTML(a.text, a.terms) + '</span>';
      b.onclick = () => { SFX().pick(); Game().activate(id); };
      box.appendChild(b);
    }
  }

  /* ═══════════════════ 오른쪽 탭 패널 ═══════════════════ */
  let tab = 'aug';                    // aug | eff | log

  function setTab(t) {
    tab = t;
    if (t === 'chat') { chatUnread = 0; }
    document.querySelectorAll('#tabs button').forEach(
      b => b.classList.toggle('on', b.dataset.tab === t));
    renderTabPanel();
  }

  function augCard(id, dimSecret, side) {
    const g = G();
    const a = global.AUG_BY_ID[id];
    // 모르는 id (가면 해독 실패 등) 로 화면 전체가 멈추지는 않게 한다
    if (!a) {
      // 비밀 증강이 아니라 '해독에 실패한' 것이다. 비밀이라고 부르면 없는 정보를 지어내는 셈이다.
      const u = el('div', 'aug hidden');
      u.textContent = '표시할 수 없는 증강 (새로고침하면 돌아옵니다)';
      return u;
    }
    const hidden = a.secret && !g.revealed[id] && dimSecret;
    const c = el('div', 'aug' + (hidden ? ' hidden' : ''));
    if (hidden) {
      c.innerHTML = '<span class="tag secret">비밀</span> <b>' + a.piece + ' ' + a.tier +
        '개</b> — 발동 전까지 비공개';
    } else {
      c.classList.add(durOf(a.tag).cls);
      c.innerHTML = '<span class="tag t' + a.tier + '">' + a.tier + '</span>' +
        '<b>' + a.piece + '</b><span class="augid">' + id + '</span>' +
        (a.secret ? '<span class="tag secret">◆ 비밀</span>' : '') +
        '<div class="augtext">' + termHTML(a.text, a.terms) + '</div>';
      c.insertBefore(durChip(a.tag), c.firstChild);
      // 교환은 '누구와 바뀌었나' 를 알아야 뜻이 통한다
      const note = side && Game().augNotes && Game().augNotes[side][id];
      if (note) {
        const n = el('div', 'augnote');
        n.appendChild(el('span', 'augnotelabel', '교환'));
        n.appendChild(el('span', null, note));
        c.appendChild(n);
      }
      /* B3a·B3b — '점수 합이 홀수/짝수면' 은 지금 합이 얼마인지 알아야 대비할 수 있다.
         판정 전에는 지금 합과 조건 충족 여부를, 판정 뒤에는 결과를 적는다. */
      if ((id === 'B3a' || id === 'B3b') && side && global.parityStatus) {
        const st = global.parityStatus(g, side, id);
        const n = el('div', 'augnote');
        if (st.done) {
          n.appendChild(el('span', 'augnotelabel', '판정 끝'));
          n.appendChild(el('span', null, st.done === 'fired' ? '폰을 소환했습니다' : '조건이 맞지 않아 소환하지 않았습니다'));
          c.classList.add('spent');
        } else {
          n.appendChild(el('span', 'augnotelabel', '지금'));
          n.appendChild(el('span', null,
            `아군 점수 합 ${st.sum} (${st.odd ? '홀수' : '짝수'}) → ${st.ok ? '조건 충족 ✓' : '조건 불일치 ✕'} · 다음 내 차례에 판정`));
        }
        c.appendChild(n);
      }
      /* 아래에 #용어 태그를 또 달지 않는다 — 본문에 이미 같은 말이 색칠돼 있고
         눌러서 뜻도 볼 수 있다. 카드만 두 줄씩 길어졌다. */
    }
    return c;
  }

  /* 온라인에서만 쓰는 대화. 판을 가리지 않도록 오른쪽 탭 안에 둔다.
     이모티콘은 한글 입력 없이 한 번에 보낼 수 있는 통로다 — 대국 중에 타자를 치는 건 부담이다. */
  const EMOTES = ['👋', '👍', '😄', '😮', '😅', '🤔', '🔥', '😭', '🎉', '🙏'];

  function pushChat(who, text, emote) {
    chatLog.push({ who, text, emote, at: Date.now() });
    if (chatLog.length > 200) chatLog.shift();
    if (tab !== 'chat') { chatUnread++; syncChatTab(); }
    if (tab === 'chat') renderTabPanel();
    if (who === 'you') SFX().pick();
  }

  function syncChatTab() {
    const b = $('#tab-chat');
    if (!b) return;
    const on = Game().mode === 'online';
    b.hidden = !on;
    b.textContent = '대화';                    // 글자 폭이 흔들리면 탭이 또 밀린다
    b.dataset.n = chatUnread > 9 ? '9+' : String(chatUnread);
    b.classList.toggle('unread', chatUnread > 0);
  }

  function renderChat(box) {
    const list = el('div', 'chatlist');
    if (!chatLog.length) {
      list.appendChild(el('div', 'dim', '아직 대화가 없습니다. 아래에서 보내 보세요.'));
    }
    for (const m of chatLog) {
      const row = el('div', 'chatrow ' + m.who);
      if (m.emote) row.appendChild(el('span', 'chatemote', m.emote));
      if (m.text) row.appendChild(el('span', 'chattext', m.text));
      list.appendChild(row);
    }
    box.appendChild(list);
    list.scrollTop = list.scrollHeight;

    const em = el('div', 'emotes');
    for (const e of EMOTES) {
      const b = el('button', 'emote', e);
      b.onclick = () => sendChat('', e);
      em.appendChild(b);
    }
    box.appendChild(em);

    const row = el('div', 'chatinput');
    const inp = el('input');
    inp.type = 'text'; inp.maxLength = 200; inp.placeholder = '메시지 (Enter 로 보내기)';
    const send = el('button', 'nav small', '보내기');
    const go = () => { const t = inp.value.trim(); if (!t) return; inp.value = ''; sendChat(t, ''); };
    send.onclick = go;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    row.appendChild(inp); row.appendChild(send);
    box.appendChild(row);
    setTimeout(() => inp.focus(), 0);
  }

  function sendChat(text, emote) {
    if (Game().mode !== 'online') return;
    if (!text && !emote) return;
    global.Net.chat(text, emote);
    pushChat('me', text, emote);
  }

  function renderTabPanel() {
    const g = G(), gm = Game();
    const box = $('#tabpanel');
    if (!box) return;
    box.innerHTML = '';
    syncChatTab();
    if (tab === 'chat') { renderChat(box); return; }

    if (tab === 'aug') {
      const bottom = bottomSide();
      for (const side of [bottom, E.other(bottom)]) {
        const who = whoIs(side);
        const head = el('div', 'panelhead');
        head.appendChild(el('span', 'dot ' + (side === 'w' ? 'dw' : 'db')));
        head.appendChild(el('b', null, sideName(side) + ' · ' + who.title));
        head.appendChild(el('span', 'panelcount', String(g.augs[side].length)));
        box.appendChild(head);

        const list = el('div', 'auglist');
        const dimSecret = gm.mode === 'ai' && side === gm.aiSide;
        for (const id of g.augs[side]) list.appendChild(augCard(id, dimSecret, side));
        if (!g.augs[side].length) list.appendChild(el('div', 'dim', '아직 없음'));
        box.appendChild(list);

        const thr = gm.nextThreshold(g, side);
        const tiers = el('div', 'tiers');
        global.TIERS.forEach((t, i) => {
          tiers.appendChild(el('span', 'tier' + (i < g.tierIdx[side] ? ' done' : ''), String(t)));
        });
        box.appendChild(tiers);
        if (thr !== null) {
          box.appendChild(el('div', 'panelnote',
            '다음 증강까지 ' + Math.max(0, thr - g.kills[side]) + '처치'));
        }
      }
      return;
    }

    if (tab === 'eff') {
      const effs = gm.activeEffects();
      if (!effs.length) { box.appendChild(el('div', 'dim', '걸려 있는 효과가 없습니다')); return; }
      for (const e of effs) {
        const row = el('div', 'efrow');
        const top = el('div', 'eftop');
        const nm = el('div', 'efname');
        nm.appendChild(el('span', 'dot ' + (e.owner === 'w' ? 'dw' : 'db')));
        nm.appendChild(el('b', null, e.label));
        top.appendChild(nm);
        top.appendChild(el('span', 'efrem' + (e.remain <= 1 ? ' soon' : ''), e.remain + '수'));
        row.appendChild(top);
        if (e.detail) row.appendChild(el('div', 'efdetail', e.detail));
        if (e.squares && e.squares.length) {
          row.classList.add('clickable');
          row.onclick = () => flash(e.squares, null, null, true);
        }
        box.appendChild(row);
      }
      return;
    }

    // 진행 기록
    const items = g.log.filter(x => x.t === 'text').slice(-200);
    const wrap = el('div', 'loglist');
    if (review) {
      const b = el('button', 'logback', '지난 국면 보는 중 — 현재로 돌아가기');
      b.onclick = exitReview;
      wrap.appendChild(b);
    } else if (g.snaps.length) {
      wrap.appendChild(el('div', 'loghint', '기록을 누르면 그때 판을 볼 수 있습니다'));
    }
    let seenSnap = false;
    for (const x of items) {
      const line = el('div', 'line', x.text);
      // 마지막 스냅샷 뒤에 붙은 줄(방금 발동한 증강 등)은 지금 판이 곧 그때 판이다
      const s = x.snap !== undefined ? x.snap : (seenSnap ? g.snaps.length - 1 : undefined);
      if (s !== undefined && g.snaps[s]) {
        seenSnap = true;
        line.classList.add('replay');
        line.title = '이 시점의 판 보기';
        // 보고 있던 줄을 다시 누르면 현재로 돌아온다 — 나오는 길이 멀지 않게
        line.onclick = () => (reviewIdx === s ? exitReview() : enterReview(s));
        if (review && g.snaps[s] === review) line.classList.add('viewing');
      }
      // '처치 카운트 1·3·6·11' 같은 안내문까지 처치로 칠하지 않도록 실제 이벤트만 고른다
      if (x.text.indexOf('⚡') === 0) line.classList.add('aug');
      else if (x.text.indexOf('처치 (누적') >= 0) line.classList.add('cap');
      else if (x.text.indexOf('증강 획득') >= 0) line.classList.add('gain');
      else if (x.text === '체크!') line.classList.add('chk');
      wrap.appendChild(line);
    }
    if (!items.length) wrap.appendChild(el('div', 'dim', '아직 기록이 없습니다'));
    box.appendChild(wrap);
    wrap.scrollTop = wrap.scrollHeight;
  }

  function renderLog() { if (tab === 'log') renderTabPanel(); }

  /* 판 한 칸 크기를 실제 측정으로 맞춘다.

     CSS 만으로 하면 '판 말고 나머지가 몇 px 인지' 를 상수로 박아야 하는데,
     스트립은 잡은 기물이 쌓이면 줄이 늘어나고 좁아지면 접힌다. 상수는 그때마다 틀린다.
     그래서 한 번 그린 뒤 실제 높이를 재고, 넘치면 줄여서 다시 잰다.
     판을 줄이면 스트립도 좁아져 다시 늘어날 수 있으므로 몇 번 되풀이해 수렴시킨다. */
  function fitBoard() {
    const bc = document.querySelector('.board-col');
    const board = $('#board');
    const main = document.querySelector('main');
    if (!bc || !board || !main || document.body.classList.contains('athome')) return;

    const cs = getComputedStyle(main);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    const gap = parseFloat(cs.columnGap) || 0;

    const side = document.querySelector('.side-col');
    const sideR = side ? side.getBoundingClientRect() : null;
    // 좁은 화면에서는 오른쪽 패널이 판 아래로 내려간다 → 그때는 가로를 다 쓴다
    const stacked = !sideR || sideR.top > bc.getBoundingClientRect().top + 10;
    const availW = window.innerWidth - padL - padR - (stacked ? 0 : sideR.width + gap);

    /* 판이 칼럼 밖으로 넘치면 칼럼의 bottom 은 따라 커지지 않는다.
       그래서 칼럼이 아니라 '판 자체' 와 '판 아래에 오는 것들' 로 재야 한다. */
    const wrap = $('#boardwrap');
    const rowGap = parseFloat(getComputedStyle(bc).rowGap) || 0;

    let sq = Math.min(82, Math.floor(availW / 8));
    for (let i = 0; i < 6; i++) {
      document.documentElement.style.setProperty('--sq', Math.max(28, sq) + 'px');
      let below = 0, n = wrap.nextElementSibling;
      while (n) {
        const r = n.getBoundingClientRect();
        if (r.height) below += r.height + rowGap;
        n = n.nextElementSibling;
      }
      const bottom = wrap.getBoundingClientRect().top + board.getBoundingClientRect().height + below;
      const over = bottom + padB - window.innerHeight;
      if (over <= 0) break;
      sq -= Math.max(1, Math.ceil(over / 8));
    }
  }

  function render() {
    renderBoard(); renderStrips(); renderLastMoves();
    renderTurnbar(); renderActions(); renderTabPanel(); renderOppDraft();
    // 내가 둘 수 있으면 판 둘레가 은은하게 뛴다 — 판만 보고 있어도 차례가 보이게
    document.body.classList.toggle('myturn', canControl());
    fitBoard();
  }
  global.renderAll = render;

  /* ───────── 소리 판단 (상태 변화를 보고) ───────── */
  function soundForUpdate(kind) {
    const g = G();
    if (kind === 'start') { prev = { kills: { ...g.kills }, ply: g.ply, result: null, check: false }; return; }
    if (g.result && !prev.result) {
      prev.result = g.result;
      showEnd(g.result);
      return;
    }
    if (g.ply !== prev.ply) {
      const captured = g.kills.w !== prev.kills.w || g.kills.b !== prev.kills.b;
      // 도약으로 둔 수는 어떻게 간 것인지 잠깐 그려 준다 (양쪽 화면 모두)
      const moved = E.other(g.turn);
      showPathFor(g.lastBySide[moved]);
      const lm = Game().lastMove;
      if (lm && lm.castle) SFX().castle();
      else if (lm && lm.promo) SFX().promote();
      else if (captured) SFX().capture();
      else SFX().move();
      prev.ply = g.ply; prev.kills = { ...g.kills };
      if (E.inCheck(g, g.turn)) setTimeout(() => SFX().check(), 120);
    }
  }

  /* ═══════════════════ 모달 ═══════════════════ */
  function overlay(node, opts) {
    const ov = el('div', 'overlay' + ((opts && opts.wide) ? ' wide' : ''));
    // fill: 모달이 아니라 안쪽 본문만 스크롤한다 (스크롤바가 두 개 겹치지 않게)
    const card = el('div', 'modal' + ((opts && opts.fill) ? ' fill' : ''));
    card.appendChild(node);
    ov.appendChild(card);
    document.body.appendChild(ov);
    /* keepClock: 도감·규칙·계정 창처럼 게임 진행과 무관한 창. 시계를 멈추지 않는다.
       예전에는 모든 창이 시계를 멈춰서, 상대 차례에 도감을 열어 두면 상대 시간이
       공짜로 서고 내 화면에는 '증강을 고르는 중' 이라고 떴다. */
    const pauses = !(opts && opts.keepClock);
    modalDepth++;
    if (pauses) { pauseDepth++; Game().pauseClock(); }
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      ov.remove(); modalDepth--;
      if (modalDepth < 0) modalDepth = 0;
      if (pauses) { pauseDepth--; if (pauseDepth <= 0) { pauseDepth = 0; Game().resumeClock(); } }
    };
    close.el = ov;                 // 호출부에서 오버레이 자체가 필요할 때가 있다
    return close;
  }

  function pickOption(prompt, options) {
    return new Promise(res => {
      const wrap = el('div');
      wrap.appendChild(el('h3', null, prompt));
      const list = el('div', 'optlist');
      for (const o of options) {
        const b = el('button', 'opt' + (o.block ? ' blocked' : ''));
        b.appendChild(el('div', 'optlabel', o.label));
        if (o.desc) b.appendChild(el('div', 'optdesc', o.desc));
        if (o.block) {
          // 고른 뒤에 '안 된다' 고 알리지 않는다 — 애초에 못 고르게 하고 이유를 적어 둔다
          b.disabled = true;
          b.appendChild(el('span', 'blockx', '✕'));
          b.appendChild(el('div', 'blockwhy', o.block));
          b.onclick = () => SFX().deny();
        } else {
          b.onclick = () => { SFX().pick(); close(); res(o.value); };
        }
        list.appendChild(b);
      }
      wrap.appendChild(list);
      const close = overlay(wrap);
    });
  }

  function confirm(prompt) {
    return new Promise(res => {
      const wrap = el('div');
      wrap.appendChild(el('h3', null, prompt));
      const row = el('div', 'row');
      const yes = el('button', 'opt primary', '예'), no = el('button', 'opt', '아니오');
      yes.onclick = () => { close(); res(true); };
      no.onclick = () => { close(); res(false); };
      row.appendChild(yes); row.appendChild(no);
      wrap.appendChild(row);
      const close = overlay(wrap);
    });
  }

  function pickSquare(prompt, squares, optional) {
    return new Promise(res => {
      if (!squares || !squares.length) { res(null); return; }
      pauseDepth++; Game().pauseClock();
      const bar = el('div', 'pickbar');
      bar.appendChild(el('span', null, prompt));
      const done = (v) => {
        bar.remove();
        pauseDepth--; if (pauseDepth <= 0) { pauseDepth = 0; Game().resumeClock(); }
        res(v);
      };
      if (optional) {
        const skip = el('button', 'skipbtn', '건너뛰기');
        skip.onclick = () => { pending = null; render(); done(null); };
        bar.appendChild(skip);
      }
      document.body.appendChild(bar);
      pending = { squares, optional, resolve: done };
      render();
    });
  }

  // 원본 엑셀 증강표의 '한 칸' 을 그대로 펼친다: 같은 기물 · 같은 티어의 선택지 3개, 하나만 고름.
  function draft({ side, tier, piece, offer, round, rounds, byKo }) {
    return new Promise(async (res) => {
      /* 처치한 판을 먼저 눈으로 확인하고 나서 고르게 한다.
         예전에는 잡자마자 덮개가 떠서, 무엇을 어떻게 잡았는지 못 보고 카드부터 봤다.
         시계는 창이 뜨기 전 이 순간부터 멈춘다 — 판을 보여 주는 0.45초도 고르는 시간이다. */
      draftingSide = side;
      pauseDepth++; Game().pauseClock();
      render();
      await new Promise(r => setTimeout(r, 450));
      SFX().draft();
      const wrap = el('div', 'draft');

      const head = el('div', 'drafthead');
      const h = el('h2', null, `${piece} 증강`);
      head.appendChild(h);
      const meta = el('div', 'draftmeta');
      meta.appendChild(el('span', 'dpill', `${tier}개 처치`));
      if (byKo) meta.appendChild(el('span', 'dpill dim2', `${byKo}(으)로 처치해서 열림`));
      if (rounds > 1) meta.appendChild(el('span', 'dpill gold', `${rounds}번 중 ${round}번째`));
      head.appendChild(meta);
      wrap.appendChild(head);
      const guide = el('div', 'sub');
      guide.appendChild(document.createTextNode('하나만 고를 수 있습니다. 지금 발동할 수 없는 증강은 고를 수 없습니다.  '));
      guide.appendChild(durLegend());
      wrap.appendChild(guide);

      const cards = el('div', 'cards');
      for (const o of offer) {
        const a = o.aug;
        const c = el('button', 'card ' + durOf(a.tag).cls + (o.block ? ' blocked' : ''));
        const top = el('div', 'cardtop');
        top.appendChild(el('span', 'cardid', a.id));
        top.appendChild(durChip(a.tag));
        if (a.secret) { const b = el('span', 'cardtag secret', '◆ 비밀'); top.appendChild(b); }
        c.appendChild(top);
        const body = el('div', 'cardtext');
        body.innerHTML = termHTML(a.text, a.terms);
        c.appendChild(body);
        if (a.terms && a.terms.length) c.appendChild(termTags(a.terms));
        if (o.block) {
          c.appendChild(el('div', 'blockwhy', o.block));
          const x = el('span', 'blockx', '✕');
          c.appendChild(x);
          c.disabled = true;
          c.onclick = () => SFX().deny();
        } else {
          c.onclick = () => { SFX().augment(); finish(a.id); };
        }
        cards.appendChild(c);
      }
      wrap.appendChild(cards);

      // 판을 확인하고 고를 수 있게 — 모달을 잠시 투명하게 만든다
      const foot = el('div', 'draftfoot');
      const peek = el('button', 'nav ghost', '판 보기');
      foot.appendChild(peek);
      wrap.appendChild(foot);

      /* 30초 제한. 못 고르면 고를 수 있는 것 중에서 무작위로 하나 집는다.
         (여기서 그냥 멈춰 버리면 온라인에서는 상대가 영영 기다린다) */
      const pickable = offer.filter(o => !o.block);
      const timerWrap = el('div', 'drafttimer');
      const tbar = el('div', 'dtbar'), tfill = el('div', 'dtfill');
      tbar.appendChild(tfill);
      const tnum = el('span', 'dtnum', '30');
      timerWrap.appendChild(tnum);
      timerWrap.appendChild(tbar);
      head.appendChild(timerWrap);

      const LIMIT = 30000;
      let deadline = Date.now() + LIMIT, tick = null, done = false;

      function stopTimer() { if (tick) { clearInterval(tick); tick = null; } }

      function onTimeUp() {
        if (done || !pickable.length) { stopTimer(); return; }
        const r = pickable[(Math.random() * pickable.length) | 0];
        toast('시간이 다 되어 무작위로 골랐습니다 — ' + r.aug.id);
        finish(r.aug.id, true);
      }

      /* 온라인이면 상대 화면에도 '고르는 중 · 남은 시간' 을 띄운다.
         판 보기로 멈춰 두면 deadline 이 밀리므로, 남은 시간을 그대로 보내면 된다. */
      const online = Game().mode === 'online';
      const tellOpp = (left) => { if (online) global.Net.note('draft', null, { left, limit: LIMIT, piece, tier }); };
      tellOpp(LIMIT);
      let lastTold = LIMIT;

      tick = setInterval(() => {
        const left = peekedAt ? (deadline + (Date.now() - peekedAt) - Date.now()) : Math.max(0, deadline - Date.now());
        const sec = Math.ceil(left / 1000);
        tnum.textContent = String(sec);
        tfill.style.width = (left / LIMIT * 100) + '%';
        timerWrap.classList.toggle('urgent', left <= 10000);
        if (Math.abs(lastTold - left) >= 500) { lastTold = left; tellOpp(left); }
        if (left <= 0) { stopTimer(); onTimeUp(); }
      }, 100);

      const closeOverlay = overlay(wrap, { wide: true });
      const ov = closeOverlay.el;

      const backBar = el('div', 'peekbar');
      const bmsg = el('div', 'peekmsg');
      bmsg.appendChild(el('b', null, '판을 보는 중입니다'));
      bmsg.appendChild(el('span', 'peeksub', '증강은 아직 고르지 않았습니다'));
      backBar.appendChild(bmsg);
      const back = el('button', 'skipbtn big', '증강 고르기로 →');
      backBar.appendChild(back);
      document.body.appendChild(backBar);

      let peekedAt = 0;
      peek.onclick = () => {
        ov.classList.add('peeking'); backBar.classList.add('show'); SFX().pick();
        peekedAt = Date.now();                       // 판 보는 동안은 시간이 안 준다
      };
      back.onclick = () => {
        ov.classList.remove('peeking'); backBar.classList.remove('show'); SFX().pick();
        if (peekedAt) { deadline += Date.now() - peekedAt; peekedAt = 0; }
      };

      function close() {
        stopTimer(); closeOverlay(); backBar.remove();
        draftingSide = null;
        pauseDepth--; if (pauseDepth <= 0) { pauseDepth = 0; Game().resumeClock(); }
        if (online) global.Net.note('draftEnd');
        renderTurnbar();
      }
      function finish(id, auto) {
        if (done) return;
        done = true;
        // 얼마나 고민했는지. 판 보기로 멈춰 둔 시간은 deadline 이 밀리므로 자연히 빠진다.
        if (global.Stats) global.Stats.pickMeta(LIMIT - Math.max(0, deadline - Date.now()), !!auto);
        close(); res(id);
      }
    });
  }

  let toastTimer = null;
  function toast(text) {
    let t = $('#toast');
    if (!t) { t = el('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ───────── 증강 발동 표시 ───────── */
  function flash(squares, augId, side, quiet) {
    for (const s of squares) flashSquares.add(s);
    renderBoard();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashSquares.clear(); renderBoard(); }, 1500);
    if (quiet) return;
    SFX().augment();
    const a = augId && global.AUG_BY_ID[augId];
    const label = a ? `${a.piece} ${augId}` : augId;
    const who = side ? `${sideName(side)}의 ` : '';
    banner(`⚡ ${who}${label} 발동`, a ? a.text : '', 'fx', 2600);
    G().log.push({ t: 'text', text: `⚡ ${who}${label} 발동 — ${squares.map(E.sqName).join(' ')}` });
    renderLog();
  }

  // 증강 획득은 놓치면 안 되는 정보라 화면 한가운데에 크게 띄운다.
  const centerQueue = [];
  let centerBusy = false;

  function centerCard({ title, sub, body, terms, cls, ms }) {
    centerQueue.push({ title, sub, body, terms, cls, ms: ms || 2200 });
    if (!centerBusy) runCenterQueue();
  }

  function runCenterQueue() {
    const item = centerQueue.shift();
    if (!item) { centerBusy = false; return; }
    centerBusy = true;
    const host = $('#center');
    host.innerHTML = '';
    const card = el('div', 'centercard ' + (item.cls || ''));
    card.appendChild(el('div', 'ctitle', item.title));
    if (item.sub) card.appendChild(el('div', 'csub', item.sub));
    if (item.body) {
      const b = el('div', 'cbody');
      b.innerHTML = termHTML(item.body, item.terms);
      card.appendChild(b);
    }
    if (item.terms && item.terms.length) card.appendChild(termTags(item.terms));
    host.appendChild(card);
    host.classList.add('show');
    setTimeout(() => {
      host.classList.remove('show');
      setTimeout(runCenterQueue, 260);
    }, item.ms);
  }

  function announce(side, id, kind) {
    const a = global.AUG_BY_ID[id];
    const gm = Game();
    const isOpp = gm.mode === 'ai' ? side === gm.aiSide : gm.mode === 'online' ? side !== gm.mySide : false;
    const who = gm.mode === 'ai' ? (isOpp ? 'AI' : '내')
      : gm.mode === 'online' ? (isOpp ? '상대의' : '내')
        : `${sideName(side)} 플레이어의`;

    if (kind === 'secret') {
      centerCard({
        title: `${who} 비밀 증강 획득`,
        sub: `${a.piece} · ${a.tier}개 티어`,
        body: '발동하기 전까지는 내용이 공개되지 않습니다.',
        cls: isOpp ? 'enemy' : 'mine', ms: 2000,
      });
      if (isOpp) SFX().enemyAugment(); else SFX().augment();
      return;
    }
    if (kind === 'reveal') {
      // 내 비밀 증강이 발동한 건 발동 배너·판 효과·(B3a 같은) 판정 카드로 이미 보인다. 상대에게만 새 소식이다.
      if ((gm.mode === 'online' || gm.mode === 'ai') && !isOpp) { SFX().augment(); return; }
      centerCard({
        title: `${who} 비밀 증강이 공개되었습니다`,
        sub: `${a.piece} ${a.id}`, body: a.text, terms: a.terms,
        cls: 'reveal', ms: 3000,
      });
      SFX().enemyAugment();
      return;
    }
    centerCard({
      title: `${who} 증강 획득`,
      sub: `${a.piece} · ${a.tier}개 티어 · ${a.id}`,
      body: a.text, terms: a.terms,
      cls: isOpp ? 'enemy' : 'mine', ms: 2600,
    });
    if (isOpp) SFX().enemyAugment(); else SFX().augment();
  }

  /* 상대 화면에서 돌아간 증강이 내 판을 바꿨을 때. 예전에는 기물이 소리 없이 사라졌다.
     바뀐 칸을 빛내고, 상대 화면에만 떴던 발동 줄을 배너로 보여 준다. */
  function remoteFx(squares, lines) {
    if (squares && squares.length) {
      for (const s of squares) flashSquares.add(s);
      renderBoard();
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flashSquares.clear(); renderBoard(); }, 1800);
    }
    if (lines && lines.length) {
      SFX().enemyAugment();
      for (const t of lines.slice(-3)) {
        const m = t.match(/^⚡ \[([A-Z]\d+[a-z])\] (.*?) 발동 — (.*)$/);
        if (m) banner(`⚡ 상대의 ${m[2]} ${m[1]} 발동`, m[3], 'enemy', 3400);
        else banner(t, '', 'enemy', 3000);
      }
    } else if (squares && squares.length) {
      SFX().enemyAugment();
      banner('⚡ 상대의 증강으로 판이 바뀌었습니다', squares.map(E.sqName).join(' '), 'enemy', 2600);
    }
  }

  /* 상대가 증강을 고르는 중 (온라인) — 판 가운데 안내와 오른쪽 남은 시간.
     상대 화면의 30초 타이머와 같은 값을 보여 준다. */
  function renderOppDraft() {
    const mid = $('#oppdraft'), bar = $('#oppdrafttimer');
    if (!mid || !bar) return;
    const on = !!oppDraft && Game().mode === 'online' && G() && !G().result;
    mid.hidden = !on; bar.hidden = !on;
    if (!on) return;
    if (!mid.firstChild) {
      const c = el('div', 'oppdraftcard');
      c.appendChild(el('div', 'odtitle', '상대가 증강을 고르는 중입니다'));
      c.appendChild(el('div', 'odsub', ''));
      c.appendChild(el('div', 'odtime', ''));
      mid.appendChild(c);
      bar.appendChild(el('span', 'odlabel', '상대 증강 선택'));
      const tb = el('div', 'dtbar'); tb.appendChild(el('div', 'dtfill')); bar.appendChild(tb);
      bar.appendChild(el('span', 'dtnum', ''));
    }
    mid.querySelector('.odsub').textContent = oppDraft.piece ? `${oppDraft.piece} · ${oppDraft.tier}개 티어 증강 중 하나` : '';
    tickOppDraft();
  }
  function tickOppDraft() {
    if (!oppDraft) return;
    const mid = $('#oppdraft'), bar = $('#oppdrafttimer');
    if (!mid || mid.hidden || !mid.firstChild) return;
    const left = Math.max(0, oppDraft.left - (Date.now() - oppDraft.at));
    const sec = Math.ceil(left / 1000);
    mid.querySelector('.odtime').textContent = `남은 시간 ${sec}초`;
    bar.querySelector('.dtnum').textContent = String(sec);
    bar.querySelector('.dtfill').style.width = (left / (oppDraft.limit || 30000) * 100) + '%';
    bar.classList.toggle('urgent', left <= 10000);
  }

  function banner(title, body, cls, ms) {
    const host = $('#banners');
    const b = el('div', 'banner ' + (cls || ''));
    b.appendChild(el('div', 'btitle', title));
    if (body) b.appendChild(el('div', 'bbody', body));
    host.prepend(b);
    while (host.children.length > 3) host.lastChild.remove();
    requestAnimationFrame(() => b.classList.add('in'));
    setTimeout(() => { b.classList.remove('in'); setTimeout(() => b.remove(), 350); }, ms || 3000);
  }

  /* ───────── 종료 연출 ───────── */
  function showEnd(result) {
    const gm = Game();
    const g = G();
    const box = $('#endfx');
    box.innerHTML = '';

    // 중단은 승패가 아니다 — 전적에 남기지 않고, 연출도 조용히 한다
    if (result.aborted) {
      box.className = 'show draw';
      const c = el('div', 'endcard');
      c.appendChild(el('div', 'endtitle', '대국 중단'));
      c.appendChild(el('div', 'endsub', result.reason));
      const home = el('button', 'nav', '메인으로');
      home.onclick = () => { if (Game().mode === 'online') leaveOnline(); renderHomeRecords(); showHome(); };
      c.appendChild(home);
      box.appendChild(c);
      return;
    }

    // 전적 저장
    let outcome = 'draw';
    if (result.winner) {
      outcome = (gm.mode === 'ai')
        ? (result.winner === gm.aiSide ? 'lose' : 'win')
        : (gm.mode === 'online')
          ? (result.winner === gm.mySide ? 'win' : 'lose')
          : (result.winner === 'w' ? 'white' : 'black');
    }
    if (global.Stats) global.Stats.end(g, gm, result);
    saveRecord({
      at: Date.now(), mode: gm.mode,
      difficulty: gm.mode === 'ai' ? gm.difficulty : null,
      outcome, reason: result.reason, moves: g.moveNo,
      kills: { w: g.kills.w, b: g.kills.b },
      augs: { w: g.augs.w.length, b: g.augs.b.length },
    });
    if (typeof renderHomeRecords === 'function') renderHomeRecords();

    let cls, title, sub = result.reason;
    if (!result.winner) { cls = 'draw'; title = '무승부'; SFX().draw(); }
    else if (gm.mode === 'ai' || gm.mode === 'online') {
      const meWin = gm.mode === 'ai' ? result.winner !== gm.aiSide : result.winner === gm.mySide;
      cls = meWin ? 'win' : 'lose';
      title = meWin ? '승리!' : '패배';
      if (meWin) SFX().win(); else SFX().lose();
    } else { cls = 'win'; title = `${sideName(result.winner)} 승리!`; SFX().win(); }
    box.className = 'show ' + cls;
    const card = el('div', 'endcard');
    card.appendChild(el('div', 'endtitle', title));
    card.appendChild(el('div', 'endsub', sub));
    const again = el('button', 'nav', '한 판 더');
    if (gm.mode === 'online') {
      again.textContent = '재대국 요청';
      again.onclick = () => { global.Net.askRematch(); again.textContent = '요청함 — 상대 대기 중'; again.disabled = true; };
    } else {
      again.onclick = () => startGame(gm.mode);
    }
    card.appendChild(again);
    box.appendChild(card);
    if (cls !== 'lose') {
      for (let i = 0; i < 60; i++) {
        const c = el('i', 'confetti');
        c.style.left = Math.random() * 100 + '%';
        c.style.animationDelay = (Math.random() * 1.2) + 's';
        c.style.animationDuration = (2.2 + Math.random() * 1.6) + 's';
        c.style.background = ['#e0b155', '#7aa2ff', '#ff8fb1', '#8ee6a3', '#fff'][i % 5];
        c.style.transform = `rotate(${Math.random() * 360}deg)`;
        box.appendChild(c);
      }
    }
  }

  /* ───────── 메인 화면 전적 ───────── */
  function renderHomeRecords() {
    const box = $('#h-records');
    if (!box) return;
    renderAccountRow();
    const all = loadRecords();
    box.innerHTML = '';
    const A = global.Account;
    if (A && A.available() && !A.loggedIn()) {
      box.appendChild(el('div', 'accthint', '로그인해 두면 다른 기기에서도 전적이 이어집니다.'));
    }
    if (!all.length) {
      box.appendChild(el('div', 'recempty', '아직 기록이 없습니다. 한 판 두고 오면 여기에 쌓입니다.'));
      return;
    }
    const ai = all.filter(r => r.mode === 'ai');
    const w = ai.filter(r => r.outcome === 'win').length;
    const l = ai.filter(r => r.outcome === 'lose').length;
    const d = ai.filter(r => r.outcome === 'draw').length;

    const sum = el('div', 'recsum');
    const rate = (w + l) ? Math.round(w / (w + l) * 100) : 0;
    sum.innerHTML = `<b>AI 전적</b> <span class="rw">${w}승</span> <span class="rl">${l}패</span> <span class="rd">${d}무</span>` +
      (w + l ? ` · 승률 <b>${rate}%</b>` : '');
    box.appendChild(sum);

    // 난이도별
    const byLv = el('div', 'recrow');
    for (const lv of ['easy', 'normal', 'hard']) {
      const g = ai.filter(r => r.difficulty === lv);
      if (!g.length) continue;
      const gw = g.filter(r => r.outcome === 'win').length;
      const gl = g.filter(r => r.outcome === 'lose').length;
      const chip = el('span', 'recchip', `${global.AI.LEVELS[lv].label} ${gw}승 ${gl}패`);
      byLv.appendChild(chip);
    }
    if (byLv.children.length) box.appendChild(byLv);

    const list = el('div', 'reclist');
    for (const r of all.slice(0, 8)) {
      const row = el('div', 'recitem ' + r.outcome);
      // AI·온라인은 내 승패, 2인 대전은 어느 색이 이겼는지로 적는다
      const label = (r.mode === 'ai' || r.mode === 'online')
        ? ({ win: '승리', lose: '패배', draw: '무승부' }[r.outcome] || r.outcome)
        : ({ white: '백 승', black: '흑 승', draw: '무승부' }[r.outcome] || r.outcome);
      const when = new Date(r.at);
      const mm = `${when.getMonth() + 1}/${when.getDate()}`;
      row.innerHTML = `<span class="rres">${label}</span>` +
        `<span class="rmode">${r.mode === 'ai' ? 'AI ' + (global.AI.LEVELS[r.difficulty] || {}).label : r.mode === 'online' ? '온라인' : '2인'}</span>` +
        `<span class="rwhy">${r.reason}</span>` +
        `<span class="rwhen">${mm} · ${r.moves}수 · 증강 ${r.augs.w + r.augs.b}</span>`;
      list.appendChild(row);
    }
    box.appendChild(list);

    const clear = el('button', 'nav ghost small', '기록 지우기');
    clear.onclick = () => {
      const A = global.Account;
      const onAcct = A && A.loggedIn();
      if (!window.confirm(onAcct ? '저장된 전적을 모두 지울까요? 계정에 있는 것도 같이 지워집니다.'
        : '저장된 전적을 모두 지울까요?')) return;
      try { localStorage.removeItem(REC_KEY); } catch (e) { }
      if (onAcct) A.clearRecords().catch(() => { });
      renderHomeRecords();
    };
    box.appendChild(clear);
  }

  /* ───────── 계정 (기록 카드 머리) ───────── */
  function renderAccountRow() {
    const row = $('#h-account');
    const A = global.Account;
    if (!row || !A || !A.available()) return;
    row.innerHTML = '';
    if (A.loggedIn()) {
      const nm = el('span', 'acctname', A.name());
      nm.title = A.name();
      row.appendChild(nm);
      const out = el('button', 'nav ghost small', '로그아웃');
      out.onclick = async () => {
        SFX().pick();
        await A.logout();
        renderHomeRecords();
      };
      row.appendChild(out);
    } else {
      const btn = el('button', 'nav ghost small', '로그인');
      btn.onclick = () => { SFX().pick(); openAccountModal(); };
      row.appendChild(btn);
    }
  }

  function openAccountModal() {
    const A = global.Account;
    const wrap = el('div');
    wrap.appendChild(el('h3', null, '로그인 \u00B7 가입'));
    wrap.appendChild(el('div', 'sub', '아이디와 비밀번호만 있으면 됩니다. 로그인하면 이 브라우저의 전적이 계정으로 합쳐지고, 다른 기기에서도 이어집니다.'));
    const form = el('form', 'acctform');
    const id = el('input'); id.placeholder = '아이디 (2~16자, 한글·영문·숫자·_)'; id.maxLength = 16; id.autocomplete = 'username';
    const pw = el('input'); pw.type = 'password'; pw.placeholder = '비밀번호 (6자 이상)'; pw.maxLength = 72; pw.autocomplete = 'current-password';
    const err = el('div', 'accterr', '');
    const btns = el('div', 'acctbtns');
    const login = el('button', 'nav', '로그인'); login.type = 'submit';
    const signup = el('button', 'nav alt', '가입하고 로그인'); signup.type = 'button';
    const cancel = el('button', 'nav ghost', '닫기'); cancel.type = 'button';
    btns.append(login, signup, cancel);
    form.append(id, pw, err, btns);
    wrap.appendChild(form);
    const close = overlay(wrap, { keepClock: true });
    cancel.onclick = () => close();
    setTimeout(() => id.focus(), 0);

    let busy = false;
    async function go(fn) {
      if (busy) return;
      const n = id.value.trim(), p = pw.value;
      if (!n || !p) { err.textContent = '아이디와 비밀번호를 넣어 주세요.'; return; }
      busy = true; err.textContent = '';
      login.disabled = signup.disabled = true;
      try {
        const merged = await fn(n, p, loadRecords());
        storeRecords(merged);
        SFX().pick();
        close();
        renderHomeRecords();
      } catch (e) {
        err.textContent = e.status === 503
          ? '서버에 계정 저장소가 아직 연결되지 않았습니다. 지금은 이 브라우저에만 기록됩니다.'
          : (e.message || '실패했습니다');
      } finally {
        busy = false; login.disabled = signup.disabled = false;
      }
    }
    form.onsubmit = (ev) => { ev.preventDefault(); go(A.login); };
    signup.onclick = () => go(A.signup);
  }

  /* ═══════════════════ 도감 · 규칙 ═══════════════════ */

  // 지속 유형 색 범례 — 카드 색이 무슨 뜻인지 한 줄로 알려준다
  function durLegend() {
    const w = el('span', 'durlegend');
    for (const t of ['턴제한', '횟수제한', '영구지속']) w.appendChild(durChip(t));
    const sec = el('span', 'cardtag secret', '\u25C6 비밀');
    sec.title = '상대에게는 발동 전까지 보이지 않습니다';
    w.appendChild(sec);
    return w;
  }

  // 도감·규칙 공용: 버튼 한 줄짜리 선택기
  function segmented(items, cur, onPick) {
    const box = el('div', 'seg');
    for (const it of items) {
      const b = el('button', it.value === cur ? 'on' : null, it.label);
      b.onclick = () => { SFX().pick(); onPick(it.value); };
      box.appendChild(b);
    }
    return box;
  }

  // 증강 한 장 (도감용). 드래프트 카드와 같은 색·같은 배치로 보여 준다.
  function codexCard(a) {
    const c = el('div', 'ccard ' + durOf(a.tag).cls);
    const top = el('div', 'cardtop');
    top.appendChild(el('span', 'cardid', a.id));
    top.appendChild(durChip(a.tag));
    if (a.secret) top.appendChild(el('span', 'cardtag secret', '\u25C6 비밀'));
    c.appendChild(top);
    const body = el('div', 'ctext');
    body.innerHTML = termHTML(a.text, a.terms);
    c.appendChild(body);
    if (a.terms && a.terms.length) c.appendChild(termTags(a.terms));
    return c;
  }

  let codexPiece = '폰', codexTier = '', codexQuery = '';

  function openCodex() {
    const wrap = el('div', 'codex');

    const head = el('div', 'codexhead');
    const h = el('div');
    h.appendChild(el('h2', null, `증강 도감 \u00B7 ${global.AUGMENTS.length}종`));
    h.appendChild(el('div', 'sub', '원본 증강표와 같은 배치입니다. 칸(기물 \u00D7 처치 수)마다 선택지가 3개이고, ' +
      '게임에서는 그 칸 하나를 그대로 펼쳐 1개만 고릅니다.'));
    head.appendChild(h);
    head.appendChild(durLegend());
    wrap.appendChild(head);

    const bar = el('div', 'codexbar');
    const pieceRow = el('div', 'segrow');
    pieceRow.appendChild(el('span', 'seglabel', '기물'));
    const pieceBox = el('span'); pieceRow.appendChild(pieceBox);
    const tierRow = el('div', 'segrow');
    tierRow.appendChild(el('span', 'seglabel', '처치 수'));
    const tierBox = el('span'); tierRow.appendChild(tierBox);
    const search = el('input', 'codexsearch');
    search.type = 'search';
    search.placeholder = '문구 \u00B7 ID \u00B7 용어로 찾기';
    search.value = codexQuery;
    search.oninput = () => { codexQuery = search.value.trim(); fill(); };
    bar.appendChild(pieceRow); bar.appendChild(tierRow); bar.appendChild(search);
    wrap.appendChild(bar);

    const body = el('div', 'codexbody');
    wrap.appendChild(body);

    function drawSegs() {
      pieceBox.innerHTML = ''; tierBox.innerHTML = '';
      pieceBox.appendChild(segmented(
        [{ label: '전체', value: '' }].concat(global.PIECES_KO.map(p => ({ label: p, value: p }))),
        codexPiece, v => { codexPiece = v; drawSegs(); fill(); }));
      tierBox.appendChild(segmented(
        [{ label: '전체', value: '' }].concat(global.TIERS.map(t => ({ label: `${t}개`, value: String(t) }))),
        codexTier, v => { codexTier = v; drawSegs(); fill(); }));
    }

    function match(a) {
      if (!codexQuery) return true;
      const q = codexQuery.toLowerCase();
      return a.id.toLowerCase().includes(q) || a.text.toLowerCase().includes(q)
        || (a.terms || []).some(t => t.includes(codexQuery)) || a.tag.includes(codexQuery);
    }

    function fill() {
      body.innerHTML = '';
      const pieces = codexPiece ? [codexPiece] : global.PIECES_KO;
      const tiers = codexTier ? [+codexTier] : global.TIERS;
      let shown = 0;
      for (const p of pieces) {
        const rows = [];
        for (const t of tiers) {
          const list = global.AUGMENTS.filter(a => a.piece === p && a.tier === t && match(a));
          if (list.length) rows.push({ t, list });
        }
        if (!rows.length) continue;
        const sec = el('div', 'csec');
        const sh = el('div', 'csechead');
        sh.appendChild(el('b', null, p));
        sh.appendChild(el('span', 'dim', rows.reduce((n, r) => n + r.list.length, 0) + '종'));
        sec.appendChild(sh);
        const cols = el('div', 'ccols');
        /* 칸마다 카드 높이가 제각각이면 표가 어긋나 보인다.
           가장 많은 칸 수만큼 행을 만들어 두고 티어 칼럼이 그 행을 그대로 쓰게 한다(subgrid).
           행은 auto 다 — 같은 줄끼리만 높이를 맞추고, 문구가 짧은 카드까지
           가장 긴 카드 높이로 늘리지는 않는다. 예전에는 1fr 이라 카드마다 빈칸이 크게 남아
           한 기물 12장이 한 화면에 안 들어왔다 (피드백 '증강 도감 1'). */
        const maxN = rows.reduce((n, r) => Math.max(n, r.list.length), 0);
        cols.style.gridTemplateRows = `auto repeat(${maxN}, auto)`;
        for (const r of rows) {
          const col = el('div', 'ccol');
          col.appendChild(el('div', 'ctier', `${r.t}개 처치`));
          for (const a of r.list) { col.appendChild(codexCard(a)); shown++; }
          cols.appendChild(col);
        }
        sec.appendChild(cols);
        body.appendChild(sec);
      }
      if (!shown) body.appendChild(el('div', 'dim', '조건에 맞는 증강이 없습니다.'));
    }

    drawSegs(); fill();
    const close = overlay(wrap, { wide: true, fill: true, keepClock: true });
    const x = el('button', 'closebtn', '닫기'); x.onclick = close; wrap.appendChild(x);
  }

  function openRules() {
    const wrap = el('div', 'codex');
    const head = el('div', 'codexhead');
    const h = el('div');
    h.appendChild(el('h2', null, '규칙 \u00B7 용어'));
    h.appendChild(el('div', 'sub', '보통 체스 규칙 그대로에, 아래 내용이 더해집니다.'));
    head.appendChild(h);
    head.appendChild(durLegend());
    wrap.appendChild(head);

    /* 네 덩이가 세로로 이어져 있어 아래쪽 용어는 한참 굴려야 나왔다.
       도감과 같은 자리·같은 모양의 한 줄 차림표를 붙여 바로 건너뛰게 한다 (피드백 '규칙/용어 1'). */
    const bar = el('div', 'codexbar');
    const navRow = el('div', 'segrow');
    navRow.appendChild(el('span', 'seglabel', '바로가기'));
    const navBox = el('span'); navRow.appendChild(navBox);
    bar.appendChild(navRow);
    wrap.appendChild(bar);

    const body = el('div', 'codexbody');
    const marks = {};
    // h3 는 sticky 라 그냥 scrollIntoView 하면 제목이 윗줄에 가려진다. 직접 offset 을 계산한다.
    function jump(key) {
      const t = marks[key];
      if (t) body.scrollTo({ top: Math.max(0, t.offsetTop - body.offsetTop - 4), behavior: 'smooth' });
    }
    function section(label) {
      const t = el('h3', null, label);
      marks[label] = t;
      body.appendChild(t);
    }

    /* ── 1. 증강을 얻는 흐름 ── */
    section('증강을 얻는 흐름');
    const flow = el('div', 'flow');
    [
      ['\u2694', '처치한다', '상대 기물을 정상적인 수로 잡습니다. 증강으로 <b>제거</b>한 것은 처치로 세지 않습니다.'],
      ['\u2191', '카운트가 찬다', '누적 처치가 <b>1 \u00B7 3 \u00B7 6 \u00B7 11</b>에 닿는 순간 드래프트가 열립니다.'],
      ['\u25A6', '그 칸이 펼쳐진다', '<b>처치를 해낸 기물</b>의 칸이 열립니다. 퀸으로 잡았으면 퀸 증강 3개입니다.'],
      ['\u2714', '하나만 고른다', '지금 발동해도 아무 일이 없는 증강은 \u2715 로 잠깁니다. 이미 가진 증강도 마찬가지입니다.'],
    ].forEach(function (row, i) {
      const c = el('div', 'flowstep');
      c.innerHTML = '<div class="flowno">' + (i + 1) + '</div>' +
        '<div class="flowic">' + row[0] + '</div>' +
        '<div><div class="flowt">' + row[1] + '</div><div class="flowd">' + row[2] + '</div></div>';
      flow.appendChild(c);
    });
    body.appendChild(flow);

    /* ── 2. 조작 ── */
    section('조작');
    const basics = el('div', 'rgrid');
    for (const row of [
      ['두는 법', '기물을 클릭하거나 끌어서 놓습니다. 갈 수 있는 칸에 점이 찍힙니다.'],
      ['수 예약', '상대 차례에 내 기물을 끌어 놓아 두면 내 차례가 오는 순간 그 수를 둡니다. 우클릭이나 Esc 로 취소합니다.'],
      ['제한시간', '다 쓰면 집니다. 한 수를 둘 때마다 증분(예: 5분+3초의 3초)을 돌려받고, 증강을 고르거나 대상을 찍는 동안에는 시계가 멈춥니다.'],
      ['증강이 발동하면', '바뀐 칸이 금색으로 빛나고, 어떤 증강 때문인지 배너와 진행 기록에 남습니다.'],
      ['지난 판 보기', '진행 기록에서 착수 줄을 누르면 그때의 판을 그대로 다시 볼 수 있습니다.'],
    ]) {
      const c = el('div', 'rcard');
      c.innerHTML = '<div class="rname">' + row[0] + '</div><div class="ctext">' + row[1] + '</div>';
      basics.appendChild(c);
    }
    body.appendChild(basics);

    /* ── 3. 전역 룰 ──
       설계 사유(why)는 기획 문서에만 두고 여기서는 애초에 안 그린다.
       남은 본문도 증강 ID 가 섞인 예외 설명이라 처음 보는 사람에게는 읽을거리가 아니다.
       이름만 먼저 보여 주고 본문은 접어 둔다 — 궁금한 줄만 눌러서 편다 (피드백 '규칙/용어 2'). */
    section('전역 룰');
    body.appendChild(el('div', 'rhint', '이름만 먼저 보여 줍니다. 자세한 예외는 눌러서 펴 보세요.'));
    const rules = el('div', 'rgrid');
    for (const r of global.GLOBAL_RULES) {
      const c = el('details', 'rcard rfold');
      const sm = el('summary', 'rname', r.name);
      c.appendChild(sm);
      c.appendChild(el('div', 'ctext', r.body));
      c.ontoggle = () => { if (c.open) SFX().pick(); };
      rules.appendChild(c);
    }
    body.appendChild(rules);

    /* ── 4. 용어 (증강 문구에 칠해지는 색 그대로) ── */
    section('용어');
    const terms = el('div', 'rgrid');
    for (const g2 of global.GLOSSARY) {
      const st = global.TERM_STYLES[g2.term];
      const c = el('div', 'rcard');
      const name = el('div', 'rname');
      const chip = el('span', 'tw', g2.term);
      if (st) { chip.style.color = st.fg; chip.style.background = st.bg; chip.style.borderColor = st.line; }
      name.appendChild(chip);
      c.appendChild(name);
      c.appendChild(el('div', 'ctext', g2.desc));
      terms.appendChild(c);
    }
    body.appendChild(terms);

    wrap.appendChild(body);
    navBox.appendChild(segmented(
      Object.keys(marks).map(k => ({ label: k, value: k })),
      '', v => jump(v)));
    const close = overlay(wrap, { wide: true, fill: true, keepClock: true });
    const x = el('button', 'closebtn', '닫기'); x.onclick = close; wrap.appendChild(x);
  }


  /* ═══════════════════ 온라인 대전 ═══════════════════ */

  const ROOM_KEY = 'mujeChess.room';
  let rematchPending = false;

  function saveRoom() {
    try {
      if (global.Net.code) sessionStorage.setItem(ROOM_KEY, JSON.stringify({ code: global.Net.code, side: global.Net.side }));
      else sessionStorage.removeItem(ROOM_KEY);
    } catch (e) { /* 시크릿 창 등 */ }
  }
  function loadRoom() {
    try { return JSON.parse(sessionStorage.getItem(ROOM_KEY) || 'null'); } catch (e) { return null; }
  }
  function clearRoom() { try { sessionStorage.removeItem(ROOM_KEY); } catch (e) { } }

  function showLobby(code, status) {
    $('#lobby').classList.remove('hidden');
    $('#lb-code').textContent = code || '\u2026';
    $('#lb-status').textContent = status || '상대를 기다리는 중\u2026';
    $('#lb-copy').style.display = code ? '' : 'none';
  }
  function hideLobby() { $('#lobby').classList.add('hidden'); }

  let netbarTimer = null;
  function netBanner(text, cls, sticky) {
    const b = $('#netbar');
    if (!text) { b.classList.add('hidden'); return; }
    b.className = 'net-' + (cls || 'warn');
    b.textContent = text;
    clearTimeout(netbarTimer);
    if (!sticky) netbarTimer = setTimeout(() => b.classList.add('hidden'), 3200);
  }

  function inOnlineGame() { return Game().mode === 'online' && G(); }

  function startOnline(side, tc, pushInitial, resume) {
    rematchPending = false;
    if (!resume) { chatLog = []; chatUnread = 0; }
    // 재접속이면 가면 해독표를 되살린다. 새 판이면 지운다.
    // (여기서 무조건 지우면, 방금 되살린 표를 다시 날려 내 비밀 증강을 나도 못 읽게 된다)
    if (resume) global.Net.loadVault(); else global.Net.resetMasks();
    startGame('online', { mySide: side, timeControl: tc || null, pushInitial: !!pushInitial });
  }

  function wireNet() {
    const Net = global.Net;

    Net.onEvent = async (type, m) => {
      switch (type) {

        case 'connected':
          netBanner('서버에 연결되었습니다', 'ok');
          return;

        case 'disconnected':
          if (inOnlineGame() || $('#lobby').classList.contains('hidden') === false) {
            netBanner('연결이 끊겼습니다 — 다시 연결하는 중\u2026', 'warn', true);
          }
          return;

        case 'created':
          saveRoom();
          showLobby(m.code, `상대를 기다리는 중\u2026 \u00b7 나는 ${m.side === 'w' ? '백' : '흑'}입니다`);
          return;

        case 'joined':
          saveRoom();
          hideLobby();
          if (m.resumed) {
            // 새로고침·끊김 뒤 복귀. 판은 곧 서버가 보내 준다.
            if (Game().mode !== 'online') startOnline(m.side, m.tc, false, true);
            else global.Net.loadVault();
            netBanner('다시 연결되었습니다', 'ok');
          } else {
            startOnline(m.side, m.tc, false);      // 참가자(흑). 판은 호스트가 보낸다.
          }
          return;

        case 'peer':
          if (m.online) {
            netBanner('상대가 들어왔습니다', 'ok');
            // 호스트는 상대가 들어온 시점에 판을 연다
            // 판을 여는 건 '방을 만든 쪽'. 색과는 별개다 (방장이 흑을 고를 수 있다)
            if (Net.isHost && Game().mode !== 'online') {
              hideLobby();
              startOnline(Net.side, m.tc || pendingTC, true);
            } else {
              hideLobby();
            }
          } else if (inOnlineGame() && !(G() && G().result)) {   // 이미 끝난 판이면 알리지 않는다
            oppDraft = null; render();
            netBanner('상대의 연결이 끊겼습니다 — 돌아오기를 기다리는 중\u2026', 'warn', true);
          }
          return;

        case 'state':
          oppDraft = null;
          await Game().adoptRemote(m);
          return;

        case 'note':
          // 상대가 증강을 고르거나 대상을 지정하는 동안 이쪽 화면의 시계도 멈춘다
          if (m.kind === 'pause') { Game().clockPaused = true; }
          else if (m.kind === 'resume') {
            if (m.clock && G()) G().clock = m.clock;
            Game().clockPaused = false;
            Game().startClockTurn();
          }
          // 상대의 증강 선택 — 남은 시간은 0.5초마다 다시 온다
          else if (m.kind === 'draft') {
            const fresh = !oppDraft;
            oppDraft = { left: +m.left || 0, limit: +m.limit || 30000, piece: m.piece, tier: m.tier, at: Date.now() };
            if (fresh) SFX().draft();
            if (!fresh) { tickOppDraft(); return; }
          }
          else if (m.kind === 'draftEnd') { oppDraft = null; }
          render();
          return;

        case 'resign':
          Game().finishOnline(Net.side, '상대가 항복했습니다');
          return;

        case 'chat': {
          const txt = typeof m.text === 'string' ? m.text.slice(0, 200) : '';
          const emo = typeof m.emote === 'string' ? m.emote.slice(0, 8) : '';
          if (txt || emo) pushChat('you', txt, emo);
          return;
        }

        case 'abort':
          // 승패를 남기지 않는다. 항복과 다르다.
          netBanner('상대가 대국을 중단했습니다', 'warn', true);
          Game().abortGame('상대가 대국을 중단했습니다');
          return;

        case 'rematch':
          if (!inOnlineGame()) return;
          rematchPending = true;
          netBanner('상대가 재대국을 요청했습니다', 'ok', true);
          askRematch();
          return;

        case 'rematchOk':
          startOnline(Net.side, Game().timeControl, Net.isHost);
          return;

        case 'error':
          hideLobby();
          netBanner(m.why || '오류가 발생했습니다', 'bad');
          clearRoom();
          return;
      }
    };
  }

  function askRematch() {
    const wrap = el('div');
    wrap.appendChild(el('h3', null, '상대가 재대국을 요청했습니다'));
    wrap.appendChild(el('div', 'sub', '수락하면 같은 방에서 새 판을 시작합니다. 색은 그대로입니다.'));
    const list = el('div', 'optlist');
    const yes = el('button', 'opt primary'); yes.appendChild(el('div', 'optlabel', '수락'));
    const no = el('button', 'opt'); no.appendChild(el('div', 'optlabel', '거절'));
    yes.onclick = () => { close(); global.Net.acceptRematch(); startOnline(global.Net.side, Game().timeControl, global.Net.isHost); };
    no.onclick = () => { close(); rematchPending = false; };
    list.appendChild(yes); list.appendChild(no);
    wrap.appendChild(list);
    const close = overlay(wrap, { keepClock: true });
  }

  let pendingTC = null;

  let onlineColor = 'r';           // 'w' | 'b' | 'r'(랜덤)

  function onlineTC() {
    const sel = $('#o-tc');
    return parseTC(sel ? sel.value : $('#h-tc').value);
  }

  function hostRoom() {
    pendingTC = onlineTC();
    SFX().unlock();
    const label = onlineColor === 'w' ? '백' : onlineColor === 'b' ? '흑' : '무작위';
    showLobby(null, `서버를 깨우는 중입니다\u2026 (처음 한 번은 1분까지 걸릴 수 있습니다) \u00b7 내 색: ${label}`);
    global.Net.createRoom(pendingTC, onlineColor === 'r' ? null : onlineColor);
  }

  function joinRoom() {
    const code = ($('#h-code').value || '').toUpperCase().trim();
    if (code.length < 4) { netBanner('코드를 입력해 주세요', 'bad'); return; }
    pendingTC = onlineTC();
    SFX().unlock();
    showLobby(code, '서버를 깨우는 중입니다\u2026 (처음 한 번은 1분까지 걸릴 수 있습니다)');
    global.Net.joinRoom(code, pendingTC);
  }

  function leaveOnline() {
    global.Net.disconnect();
    clearRoom();
    hideLobby();
    netBanner(null);
  }

  /* ═══════════════════ 시계 루프 ═══════════════════ */
  function clockLoop() {
    const g = G(), gm = Game();
    if (g && g.clock && !g.result) {
      document.querySelectorAll('.clock').forEach(n => {
        const s = n.dataset.side;
        const ms = gm.clockRemain(s);
        n.textContent = fmtClock(ms);
        n.classList.toggle('low', ms !== null && ms < 20000);
        if (ms !== null && ms < 10000 && s === g.turn && !gm.clockPaused && gm.isHuman(s)) {
          const sec = Math.floor(ms / 1000);
          if (n.dataset.lastSec !== String(sec)) { n.dataset.lastSec = String(sec); SFX().tick(); }
        }
      });
      if (gm.checkFlag()) render();
    }
    if (oppDraft) tickOppDraft();
    requestAnimationFrame(clockLoop);
  }

  /* ═══════════════════ 메인 화면 · 부팅 ═══════════════════ */
  let difficulty = 'normal';        // 초급 / 중급 / 고급 (메인·인게임 공용)

  function parseTC(v) {
    if (v === 'none') return null;
    const [m, s] = v.split('+').map(Number);
    return { base: m * 60000, inc: s * 1000, label: `${m}분 + ${s}초` };
  }

  // 난이도 버튼 3개 (메인 / 인게임 양쪽을 항상 같은 값으로 유지)
  function setDifficulty(lv, announceIt) {
    difficulty = lv;
    Game().difficulty = lv;
    for (const host of [$('#h-diff'), $('#g-diff')]) {
      if (!host) continue;
      host.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.lv === lv));
    }
    if (announceIt) {
      SFX().pick();
      toast(`난이도 ${global.AI.LEVELS[lv].label} — ${global.AI.LEVELS[lv].desc}`);
    }
  }

  function wireDifficulty(hostSel, live) {
    const host = $(hostSel);
    if (!host) return;
    host.querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        setDifficulty(b.dataset.lv, true);
        if (live && Game().mode === 'ai') { render(); Game().maybeAI(); }
      };
    });
  }

  function showHome() {
    $('#home').classList.remove('hidden');
    $('#banners').innerHTML = '';
    document.body.classList.add('athome');
  }

  function hideHome() {
    $('#home').classList.add('hidden');
    document.body.classList.remove('athome');
  }

  function startGame(mode, opts) {
    opts = opts || {};
    $('#endfx').className = ''; $('#endfx').innerHTML = '';
    $('#banners').innerHTML = '';
    // 온라인에서는 내 색이 아래로 오게 둔다
    flip = mode === 'online' && opts.mySide === 'b';
    const tc = opts.timeControl !== undefined ? opts.timeControl : parseTC($('#h-tc').value);
    $('#tcinfo').textContent = tc ? tc.label : '무제한';
    hideHome();
    review = null;
    premove = null; pmFrom = -1; pmDests = []; clearTimeout(pmTimer);
    oppDraft = null;
    document.body.classList.remove('reviewing');
    const rb = $('#reviewbar'); if (rb) rb.remove();
    setTab('aug');
    SFX().unlock();
    Game().start({ mode, aiSide: 'b', difficulty, timeControl: tc, mySide: opts.mySide || 'w' });
    if (global.Stats) {
      global.Stats.begin({
        mode, difficulty: mode === 'ai' ? difficulty : null,
        tc: tc ? tc.label : null,
        room: mode === 'online' ? global.Net.code : null,
        mySide: opts.mySide || 'w',
      });
    }
    // 2인 대전·온라인에서는 난이도가 의미 없다
    $('#g-diff').style.display = mode === 'ai' ? '' : 'none';
    $('#restart').textContent = mode === 'online' ? '재대국 요청' : '다시 시작';
  }

  function boot() {
    const gm = Game();
    gm.api = {
      pickSquare, pickOption, confirm, draft, flash, announce, remoteFx,
      msg: (t) => { toast(t); G().log.push({ t: 'text', text: t }); renderLog(); },
      // 증강이 판정·소진되는 순간처럼 놓치면 안 되는 일 — 화면 가운데 카드
      event: (e) => { centerCard({ title: e.title, sub: e.sub, body: e.body, terms: e.terms, cls: e.cls, ms: e.ms || 2600 }); },
      reveal: (id) => gm.revealAug(id),
      grant: (s, id) => gm.grantAug(s, id),
    };
    gm.onUpdate = (kind) => {
      sel = -1; dests = []; peek = null;
      // 판이 끝났거나 예약할 수 없는 상황이 되면 예약을 접는다
      if (premove && !canPremove() && !canControl()) { premove = null; pmFrom = -1; pmDests = []; }
      soundForUpdate(kind); render();
      if (premove && canControl()) schedulePremove();
    };

    const board = $('#board');
    let fitTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => { fitBoard(); renderBoard(); }, 80);
    });

    wireTerms();
    board.addEventListener('pointerdown', onPointerDown);
    board.addEventListener('pointermove', onBoardHover);
    board.addEventListener('pointerleave', () => { if (!(pathHint && pathHint.pinned)) setPathHint(null); });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    board.addEventListener('contextmenu', e => { e.preventDefault(); if (premove || pmFrom >= 0) cancelPremove(); });

    // 난이도 (메인은 시작 전 설정, 인게임은 즉시 반영)
    wireDifficulty('#h-diff', false);
    wireDifficulty('#g-diff', true);
    setDifficulty('normal');

    // 메인 화면
    $('#h-ai').onclick = () => startGame('ai');
    $('#h-pvp').onclick = () => startGame('pvp');

    // 온라인 대전
    wireNet();
    $('#h-host').onclick = hostRoom;
    $('#h-join').onclick = joinRoom;
    $('#h-code').addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    $('#h-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
    $('#lb-cancel').onclick = leaveOnline;
    // 내 색 고르기 (랜덤이면 서버가 방을 열 때 정한다)
    const cp = $('#o-color');
    if (cp) {
      cp.querySelectorAll('button').forEach(b => {
        b.onclick = () => {
          onlineColor = b.dataset.c;
          cp.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
          SFX().pick();
        };
      });
    }
    $('#lb-copy').onclick = () => {
      const c = $('#lb-code').textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(c).then(() => toast('코드를 복사했습니다: ' + c));
      else toast('코드: ' + c);
    };
    // 새로고침으로 끊겼던 방이 있으면 자리로 돌아간다
    const saved = loadRoom();
    if (saved && saved.code && saved.side) {
      global.Net.code = saved.code; global.Net.side = saved.side;
      showLobby(saved.code, '두던 방으로 돌아가는 중입니다\u2026');
      global.Net.connect();
    }
    $('#h-codex').onclick = openCodex;
    $('#h-rules').onclick = openRules;

    // 인게임
    $('#tohome').onclick = () => {
      if (Game().mode === 'online') leaveOnline();
      renderHomeRecords(); showHome();
    };
    $('#restart').onclick = () => {
      if (Game().mode === 'online') {
        if (G().result) { global.Net.askRematch(); toast('재대국을 요청했습니다'); return; }
        if (!window.confirm('지금 판을 버리고 재대국을 요청할까요?')) return;
        global.Net.askRematch();
        toast('재대국을 요청했습니다');
        return;
      }
      startGame(gm.mode);
    };

    $('#resign').onclick = () => {
      const g = G();
      if (!g || g.result) return;
      const who = Game().mode === 'online'
        ? '항복하시겠습니까? 이 판은 패배로 기록됩니다.'
        : `${sideName(g.turn)}이(가) 항복합니다. 진행할까요?`;
      if (!window.confirm(who)) return;
      Game().resign();
    };
    $('#flip').onclick = () => { flip = !flip; render(); };
    $('#codex').onclick = openCodex;
    $('#rules').onclick = openRules;

    // 소리 — 켜기/끄기 + 볼륨
    const VOL_KEY = 'mujeChess.volume';
    let vol = 0.75;
    try { const v = localStorage.getItem(VOL_KEY); if (v !== null) vol = +v; } catch (e) { }
    SFX().setVolume(vol);
    SFX().setEnabled(vol > 0);

    function syncSound() {
      const on = SFX().isEnabled() && SFX().getVolume() > 0;
      const label = on ? '🔊' : '🔇';
      for (const id of ['#sound', '#h-sound']) {
        const b = $(id); if (b) b.textContent = label;
      }
      for (const id of ['#vol', '#h-vol']) {
        const r = $(id); if (r) r.value = String(Math.round(SFX().getVolume() * 100));
      }
    }
    function setVol(v, demo) {
      SFX().setVolume(v / 100);
      SFX().setEnabled(v > 0);
      try { localStorage.setItem(VOL_KEY, String(v / 100)); } catch (e) { }
      syncSound();
      if (demo && v > 0) SFX().demo();
    }
    for (const id of ['#vol', '#h-vol']) {
      const r = $(id);
      if (!r) continue;
      r.oninput = () => setVol(+r.value, false);
      r.onchange = () => setVol(+r.value, true);
    }
    const toggleSound = () => {
      SFX().unlock();
      const on = !(SFX().isEnabled() && SFX().getVolume() > 0);
      if (on) setVol(Math.max(35, Math.round(SFX().getVolume() * 100)), true);
      else { SFX().setEnabled(false); syncSound(); }
    };
    $('#sound').onclick = toggleSound;
    $('#h-sound').onclick = toggleSound;
    syncSound();
    document.addEventListener('pointerdown', () => SFX().unlock(), { once: true });

    // 테마 (라이트 / 다크) — 토큰 레이어만 갈아끼운다
    const THEME_KEY = 'mujeChess.theme';
    function applyTheme(t) {
      document.documentElement.setAttribute('data-theme', t);
      // 인게임은 아이콘 버튼(글자 없음), 메인은 글자까지
      const icon = t === 'dark' ? '🌙' : '☀️';
      const gb = $('#theme'); if (gb) gb.textContent = icon;
      const hb = $('#h-theme'); if (hb) hb.textContent = icon + ' 테마';
      try { localStorage.setItem(THEME_KEY, t); } catch (e) { }
    }
    let theme = 'dark';
    try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { }
    applyTheme(theme);
    const toggleTheme = () => {
      theme = (document.documentElement.getAttribute('data-theme') === 'dark') ? 'light' : 'dark';
      applyTheme(theme);
      SFX().pick();
    };
    $('#theme').onclick = toggleTheme;
    $('#h-theme').onclick = toggleTheme;

    /* 전적 저장 — 기본은 켬. 끄면 판이 끝나도 기록에 안 남고(브라우저·계정 모두), 익명 통계도 안 나간다.
       '통계' 라는 이름은 화면에서 달라지는 게 없어 무슨 스위치인지 알 수 없었다. 눈에 보이는 전적으로 이름을 붙인다.
       사람에 대한 건 기기마다 만든 임의의 id 말고 아무것도 안 보낸다. */
    const sb = $('#h-stats');
    if (sb && global.Stats) {
      const syncStats = () => {
        const on = global.Stats.enabled();
        sb.textContent = (on ? '📝' : '🚫') + ' 전적 저장 ' + (on ? '켬' : '끔');
        sb.title = on
          ? '판이 끝나면 전적을 남깁니다 (로그인 중이면 계정에도). 익명 통계도 함께 갑니다. 누르면 끕니다.'
          : '전적을 남기지 않는 중 — 기록에도, 계정에도, 통계에도 안 갑니다. 누르면 켭니다.';
      };
      sb.onclick = () => { global.Stats.setEnabled(!global.Stats.enabled()); syncStats(); SFX().pick(); };
      syncStats();
    }

    // 진행 기록 패널
    // 오른쪽 패널 탭
    document.querySelectorAll('#tabs button').forEach(b => {
      b.onclick = () => { setTab(b.dataset.tab); SFX().pick(); };
    });
    renderHomeRecords();
    if (global.Account && global.Account.available()) {
      global.Account.restore().then(ok => { renderHomeRecords(); if (ok) syncRecords(); });
    }

    // 화면 뒤에 유효한 판을 하나 만들어 두고 메인을 띄운다 (AI 는 아직 돌지 않음)
    gm.start({ mode: 'pvp', timeControl: null });
    showHome();
    requestAnimationFrame(clockLoop);
  }

  document.addEventListener('DOMContentLoaded', boot);
})(window);
