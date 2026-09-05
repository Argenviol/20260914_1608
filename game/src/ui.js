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
  let modalDepth = 0;
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
        `<span class="tw" style="color:${st.fg};background:${st.bg};border-color:${st.line}">${t}</span>`);
    }
    return html;
  }
  function termTags(terms) {
    const wrap = el('div', 'termtags');
    for (const t of (terms || [])) {
      const st = global.TERM_STYLES[t];
      if (!st) continue;
      const g = global.GLOSSARY.find(x => x.term === t);
      const tag = el('span', 'ttag', '#' + t);
      tag.style.color = st.fg;
      tag.style.background = st.bg;
      tag.style.borderColor = st.line;
      if (g) tag.title = g.desc;
      wrap.appendChild(tag);
    }
    return wrap;
  }

  /* ───────── 전적 기록 (localStorage) ───────── */
  const REC_KEY = 'mujeChess.records.v1';
  function loadRecords() {
    try { return JSON.parse(localStorage.getItem(REC_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function saveRecord(rec) {
    try {
      const all = loadRecords();
      all.unshift(rec);
      localStorage.setItem(REC_KEY, JSON.stringify(all.slice(0, 100)));
    } catch (e) { /* 사생활 보호 모드 등에서 저장이 막혀도 게임은 계속된다 */ }
  }

  /* ═══════════════════ 체스판 ═══════════════════ */
  function bottomSide() { return flip ? 'b' : 'w'; }

  function renderBoard() {
    const board = $('#board');
    board.innerHTML = '';
    const g = G();
    const order = [];
    for (let i = 0; i < 64; i++) order.push(i);
    if (flip) order.reverse();

    const human = Game().isHuman(g.turn) && !g.result && !Game().busy;

    for (const i of order) {
      const [r, c] = E.rc(i);
      const sq = el('div', 'sq ' + (E.lightSquare(i) ? 'light' : 'dark'));
      sq.dataset.i = i;

      const lm = Game().lastMove;
      if (lm && (lm.from === i || lm.to === i)) sq.classList.add('last');
      if (i === sel) sq.classList.add('sel');
      if (dests.includes(i)) sq.classList.add(g.bd[i] ? 'capture' : 'dest');
      if (pending && pending.squares.includes(i)) sq.classList.add('pick');
      if (flashSquares.has(i)) sq.classList.add('flash');

      const p = g.bd[i];
      if (p) {
        const pe = el('div', 'pc ' + (p.color === 'w' ? 'wp' : 'bp'), GLYPH[p.type]);
        if (p.type === 'k' && E.inCheck(g, p.color) && !g.result) sq.classList.add('incheck');
        if (human && p.color === g.turn) pe.classList.add('grab');
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

  function squareAt(x, y) {
    const n = document.elementFromPoint(x, y);
    const sq = n && n.closest ? n.closest('#board .sq') : null;
    return sq ? +sq.dataset.i : -1;
  }

  /* ───────── 클릭 + 드래그 ───────── */
  function canControl() {
    const g = G();
    return !g.result && !Game().busy && Game().isHuman(g.turn) && !pending;
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
    } else { sel = -1; dests = []; }
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
    if (!canControl()) return;

    const g = G();
    // 선택된 상태에서 목적지를 누름 → 이동
    if (sel >= 0 && dests.includes(i)) { tryMove(sel, i); return; }

    const p = g.bd[i];
    if (p && p.color === g.turn) {
      selectSquare(i);
      if (!dests.length) return;
      // 드래그 시작
      drag = { from: i, moved: false, startX: ev.clientX, startY: ev.clientY, type: p.type, color: p.color };
      ev.preventDefault();
    } else {
      sel = -1; dests = []; renderBoard();
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
    // 호버 강조
    const over = squareAt(ev.clientX, ev.clientY);
    document.querySelectorAll('#board .sq.over').forEach(n => n.classList.remove('over'));
    if (over >= 0 && dests.includes(over)) {
      const n = document.querySelector(`#board .sq[data-i="${over}"]`);
      if (n) n.classList.add('over');
    }
  }

  async function onPointerUp(ev) {
    if (!drag) return;
    const d = drag; drag = null;
    $('#dragghost').className = '';
    document.querySelectorAll('#board .sq.over').forEach(n => n.classList.remove('over'));
    if (!d.moved) { renderBoard(); return; }            // 클릭이었음 → 선택 유지
    const to = squareAt(ev.clientX, ev.clientY);
    if (to >= 0 && dests.includes(to)) { await tryMove(d.from, to); }
    else { renderBoard(); }
  }

  /* ═══════════════════ 진영 패널 ═══════════════════ */
  function fmtClock(ms) {
    if (ms === null) return '∞';
    const s = Math.max(0, ms) / 1000;
    if (s < 10) return s.toFixed(1);
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${m}:${r < 10 ? '0' : ''}${r}`;
  }

  function whoIs(side) {
    const gm = Game();
    if (gm.mode === 'ai') {
      if (side === gm.aiSide) return { title: `AI · ${global.AI.LEVELS[gm.difficulty].label}`, kind: 'ai' };
      return { title: '나', kind: 'me' };
    }
    return { title: `${sideName(side)} 플레이어`, kind: 'human' };
  }

  function renderSide(side, container) {
    const g = G(), gm = Game();
    container.innerHTML = '';
    const who = whoIs(side);
    const active = g.turn === side && !g.result;

    const box = el('div', `sidebox ${side === 'w' ? 'sw' : 'sb'} ${active ? 'active' : ''}`);

    // 머리: 이름 + 시계
    const head = el('div', 'sidehead');
    const nm = el('div', 'sidename');
    nm.appendChild(el('span', 'dot ' + (side === 'w' ? 'dw' : 'db')));
    nm.appendChild(el('b', null, `${sideName(side)} · ${who.title}`));
    head.appendChild(nm);
    const ck = el('div', 'clock' + (active ? ' running' : ''));
    ck.dataset.side = side;
    ck.textContent = fmtClock(gm.clockRemain(side));
    head.appendChild(ck);
    box.appendChild(head);

    // AI 생각 표시
    if (who.kind === 'ai') {
      const info = global.AI.lastInfo;
      const line = el('div', 'ailine');
      if (active && gm.busy !== false && g.turn === side) line.textContent = '생각 중…';
      else if (info) {
        line.textContent = info.book ? '정석 오프닝을 따랐습니다'
          : info.blunder ? '(감으로 두었습니다)'
            : `${info.depth}수 앞을 보고 두었습니다 · ${(info.nodes / 1000).toFixed(1)}k 국면 검토`;
      } else line.textContent = global.AI.LEVELS[gm.difficulty].desc;
      box.appendChild(line);
    } else if (who.kind === 'human' && active) {
      box.appendChild(el('div', 'ailine', `${sideName(side)} 플레이어가 둘 차례입니다`));
    }

    // 처치 / 다음 증강
    const thr = gm.nextThreshold(g, side);
    const kl = el('div', 'killrow');
    kl.appendChild(el('span', 'killn', `처치 ${g.kills[side]}`));
    kl.appendChild(el('span', 'killsub', thr === null ? '모든 티어 획득' : `다음 증강까지 ${Math.max(0, thr - g.kills[side])}`));
    box.appendChild(kl);
    const bar = el('div', 'bar'), fill = el('div', 'fill');
    if (thr === null) fill.style.width = '100%';
    else {
      const prevT = g.tierIdx[side] === 0 ? 0 : Math.max(0, global.TIERS[g.tierIdx[side] - 1] - g.thrCut[side]);
      fill.style.width = Math.max(0, Math.min(100, ((g.kills[side] - prevT) / Math.max(1, thr - prevT)) * 100)) + '%';
    }
    bar.appendChild(fill); box.appendChild(bar);
    const tiers = el('div', 'tiers');
    global.TIERS.forEach((t, i) => {
      const cut = Math.max(0, t - g.thrCut[side]);
      const d = el('span', 'tier' + (i < g.tierIdx[side] ? ' done' : ''), String(cut));
      tiers.appendChild(d);
    });
    box.appendChild(tiers);

    // 보유 증강
    const hideSecret = gm.mode === 'ai' && side === gm.aiSide;
    box.appendChild(el('h5', null, `보유 증강 ${g.augs[side].length ? `(${g.augs[side].length})` : ''}`));
    const list = el('div', 'auglist');
    for (const id of g.augs[side]) {
      const a = global.AUG_BY_ID[id];
      const hidden = a.secret && !g.revealed[id] && hideSecret;
      const c = el('div', 'aug' + (hidden ? ' hidden' : ''));
      if (hidden) {
        c.innerHTML = `<span class="tag secret">비밀</span> <b>${a.piece} ${a.tier}개</b> — 발동 전까지 비공개`;
      } else {
        c.innerHTML = `<span class="tag t${a.tier}">${a.tier}</span><b>${a.piece}</b> <span class="augid">${id}</span>` +
          (a.secret ? '<span class="tag secret">비밀</span>' : '') +
          `<div class="augtext">${termHTML(a.text, a.terms)}</div>`;
        if (a.terms && a.terms.length) c.appendChild(termTags(a.terms));
      }
      list.appendChild(c);
    }
    if (!g.augs[side].length) list.appendChild(el('div', 'dim', '아직 없음'));
    box.appendChild(list);

    // 이 진영이 건 활성 효과
    const effs = gm.activeEffects().filter(e => e.owner === side);
    box.appendChild(el('h5', null, `활성 효과 ${effs.length ? `(${effs.length})` : ''}`));
    const ef = el('div', 'efflist');
    for (const e of effs) {
      const row = el('div', 'efrow');
      const top = el('div', 'eftop');
      top.appendChild(el('b', null, e.label));
      top.appendChild(el('span', 'efrem' + (e.remain <= 1 ? ' soon' : ''), `${e.remain}수 남음`));
      row.appendChild(top);
      if (e.detail) row.appendChild(el('div', 'efdetail', e.detail));
      if (e.squares && e.squares.length) {
        row.classList.add('clickable');
        row.onclick = () => flash(e.squares, null, null, true);
      }
      ef.appendChild(row);
    }
    if (!effs.length) ef.appendChild(el('div', 'dim', '없음'));
    box.appendChild(ef);

    container.appendChild(box);
  }

  function renderSides() {
    const bottom = bottomSide();
    renderSide(bottom, $('#mine'));
    renderSide(E.other(bottom), $('#theirs'));
  }

  /* ───────── 턴 바 ───────── */
  function renderTurnbar() {
    const g = G(), gm = Game();
    const t = $('#turnbar');
    t.className = '';
    if (g.result) {
      t.classList.add('over');
      t.textContent = (g.result.winner ? `${sideName(g.result.winner)} 승리` : '무승부') + ` — ${g.result.reason}`;
      addLogButton(t);
      return;
    }
    t.classList.add(g.turn === 'w' ? 'tw' : 'tb');
    const who = whoIs(g.turn);
    let msg;
    if (who.kind === 'ai') msg = `${sideName(g.turn)} 차례 — AI(${global.AI.LEVELS[gm.difficulty].label})가 생각하고 있습니다`;
    else if (who.kind === 'me') msg = `${sideName(g.turn)} 차례 — 당신이 둘 차례입니다`;
    else msg = `${sideName(g.turn)} 차례 — ${sideName(g.turn)} 플레이어가 두세요`;
    if (E.inCheck(g, g.turn)) msg += ' · 체크!';
    t.textContent = msg;
    const mode = el('span', 'modetag', gm.mode === 'ai' ? 'AI 대전' : '2인 대전');
    t.prepend(mode);
    addLogButton(t);
  }

  // 진행 기록은 턴 바 오른쪽 끝의 버튼으로 연다 (판을 가리지 않는 자리에 뜬다)
  function addLogButton(t) {
    const b = el('button', 'logbtn' + (logOpen ? ' on' : ''), '진행 기록');
    b.id = 'logbtn';
    b.onclick = () => { SFX().pick(); toggleLog(); };
    t.appendChild(b);
  }

  /* ───────── 사용 가능 증강 / 기록 ───────── */
  function renderActions() {
    const g = G(), box = $('#actions');
    box.innerHTML = '';
    if (g.result || !Game().isHuman(g.turn)) return;
    const ids = Game().activatable(g.turn);
    if (!ids.length) return;
    box.appendChild(el('div', 'seg', '지금 사용할 수 있는 증강'));
    for (const id of ids) {
      const a = global.AUG_BY_ID[id];
      const b = el('button', 'act');
      b.innerHTML = `<b>${a.piece} ${id}</b> <span>${termHTML(a.text, a.terms)}</span>`;
      b.onclick = () => { SFX().pick(); Game().activate(id); };
      box.appendChild(b);
    }
  }

  let logOpen = false;
  function toggleLog(force) {
    logOpen = (force === undefined) ? !logOpen : force;
    $('#logpanel').classList.toggle('show', logOpen);
    const b = $('#logbtn');
    if (b) b.classList.toggle('on', logOpen);
    if (logOpen) renderLog();
  }

  function renderLog() {
    const box = $('#log');
    if (!box) return;
    box.innerHTML = '';
    const items = G().log.filter(x => x.t === 'text').slice(-160);
    for (const x of items) {
      const line = el('div', 'line', x.text);
      if (x.text.startsWith('⚡')) line.classList.add('aug');
      else if (x.text.includes('처치')) line.classList.add('cap');
      else if (x.text.includes('증강 획득')) line.classList.add('gain');
      else if (x.text.includes('체크')) line.classList.add('chk');
      box.appendChild(line);
    }
    box.scrollTop = box.scrollHeight;
  }

  function render() { renderBoard(); renderSides(); renderTurnbar(); renderActions(); if (logOpen) renderLog(); }
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
    const card = el('div', 'modal');
    card.appendChild(node);
    ov.appendChild(card);
    document.body.appendChild(ov);
    modalDepth++; Game().pauseClock();
    const close = () => {
      ov.remove(); modalDepth--;
      if (modalDepth <= 0) { modalDepth = 0; Game().resumeClock(); }
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
        const b = el('button', 'opt');
        b.appendChild(el('div', 'optlabel', o.label));
        if (o.desc) b.appendChild(el('div', 'optdesc', o.desc));
        b.onclick = () => { SFX().pick(); close(); res(o.value); };
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
      Game().pauseClock();
      const bar = el('div', 'pickbar');
      bar.appendChild(el('span', null, prompt));
      const done = (v) => { bar.remove(); Game().resumeClock(); res(v); };
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
  function draft({ side, tier, piece, offer, round, rounds, victimKo }) {
    return new Promise(res => {
      SFX().draft();
      const wrap = el('div', 'draft');

      const head = el('div', 'drafthead');
      const h = el('h2', null, `${piece} 증강`);
      head.appendChild(h);
      const meta = el('div', 'draftmeta');
      meta.appendChild(el('span', 'dpill', `${tier}개 처치`));
      if (victimKo) meta.appendChild(el('span', 'dpill dim2', `${victimKo} 처치로 열림`));
      if (rounds > 1) meta.appendChild(el('span', 'dpill gold', `${rounds}번 중 ${round}번째`));
      head.appendChild(meta);
      wrap.appendChild(head);
      wrap.appendChild(el('div', 'sub', '하나만 고를 수 있습니다. 지금 발동할 수 없는 증강은 고를 수 없습니다.'));

      const cards = el('div', 'cards');
      for (const o of offer) {
        const a = o.aug;
        const c = el('button', 'card p-' + a.type + (o.block ? ' blocked' : ''));
        const top = el('div', 'cardtop');
        top.appendChild(el('span', 'cardid', a.id));
        top.appendChild(el('span', 'cardtag', a.tag));
        if (a.secret) { const b = el('span', 'cardtag secret', '비밀'); top.appendChild(b); }
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
          c.onclick = () => { SFX().augment(); close(); res(a.id); };
        }
        cards.appendChild(c);
      }
      wrap.appendChild(cards);

      // 판을 확인하고 고를 수 있게 — 모달을 잠시 투명하게 만든다
      const foot = el('div', 'draftfoot');
      const peek = el('button', 'nav ghost', '판 보기');
      foot.appendChild(peek);
      wrap.appendChild(foot);

      const closeOverlay = overlay(wrap, { wide: true });
      const ov = closeOverlay.el;

      const backBar = el('div', 'peekbar');
      backBar.appendChild(el('span', null, '판을 보는 중입니다'));
      const back = el('button', 'skipbtn', '증강 고르기로');
      backBar.appendChild(back);
      document.body.appendChild(backBar);

      peek.onclick = () => { ov.classList.add('peeking'); backBar.classList.add('show'); SFX().pick(); };
      back.onclick = () => { ov.classList.remove('peeking'); backBar.classList.remove('show'); SFX().pick(); };

      function close() { closeOverlay(); backBar.remove(); }
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
    const isOpp = gm.mode === 'ai' ? side === gm.aiSide : false;
    const who = gm.mode === 'ai' ? (isOpp ? 'AI' : '내') : `${sideName(side)} 플레이어의`;

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

    // 전적 저장
    let outcome = 'draw';
    if (result.winner) {
      outcome = (gm.mode === 'ai')
        ? (result.winner === gm.aiSide ? 'lose' : 'win')
        : (result.winner === 'w' ? 'white' : 'black');
    }
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
    else if (gm.mode === 'ai') {
      const meWin = result.winner !== gm.aiSide;
      cls = meWin ? 'win' : 'lose';
      title = meWin ? '승리!' : '패배';
      if (meWin) SFX().win(); else SFX().lose();
    } else { cls = 'win'; title = `${sideName(result.winner)} 승리!`; SFX().win(); }
    box.className = 'show ' + cls;
    const card = el('div', 'endcard');
    card.appendChild(el('div', 'endtitle', title));
    card.appendChild(el('div', 'endsub', sub));
    const again = el('button', 'nav', '한 판 더');
    again.onclick = () => startGame(gm.mode);
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
    const all = loadRecords();
    box.innerHTML = '';
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
      const label = r.mode === 'ai'
        ? ({ win: '승리', lose: '패배', draw: '무승부' }[r.outcome] || r.outcome)
        : ({ white: '백 승', black: '흑 승', draw: '무승부' }[r.outcome] || r.outcome);
      const when = new Date(r.at);
      const mm = `${when.getMonth() + 1}/${when.getDate()}`;
      row.innerHTML = `<span class="rres">${label}</span>` +
        `<span class="rmode">${r.mode === 'ai' ? 'AI ' + (global.AI.LEVELS[r.difficulty] || {}).label : '2인'}</span>` +
        `<span class="rwhy">${r.reason}</span>` +
        `<span class="rwhen">${mm} · ${r.moves}수 · 증강 ${r.augs.w + r.augs.b}</span>`;
      list.appendChild(row);
    }
    box.appendChild(list);

    const clear = el('button', 'nav ghost small', '기록 지우기');
    clear.onclick = () => {
      if (!window.confirm('저장된 전적을 모두 지울까요?')) return;
      try { localStorage.removeItem(REC_KEY); } catch (e) { }
      renderHomeRecords();
    };
    box.appendChild(clear);
  }

  /* ═══════════════════ 도감 · 규칙 ═══════════════════ */
  function openCodex() {
    const wrap = el('div', 'codex');
    wrap.appendChild(el('h2', null, `증강 도감 · ${global.AUGMENTS.length}종`));
    wrap.appendChild(el('div', 'sub', '엑셀(무제체스_증강표_v2.xlsx)과 같은 내용입니다. 왼쪽부터 1 · 3 · 6 · 11개 처치 순서.'));
    const ctl = el('div', 'row');
    const s1 = el('select'); s1.appendChild(new Option('전체 기물', ''));
    for (const p of global.PIECES_KO) s1.appendChild(new Option(p, p));
    const s2 = el('select'); s2.appendChild(new Option('전체 티어', ''));
    for (const t of global.TIERS) s2.appendChild(new Option(`${t}개`, String(t)));
    ctl.appendChild(s1); ctl.appendChild(s2);
    wrap.appendChild(ctl);
    const body = el('div', 'codexbody');
    wrap.appendChild(body);
    function fill() {
      body.innerHTML = '';
      const pieces = s1.value ? [s1.value] : global.PIECES_KO;
      const tiers = s2.value ? [+s2.value] : global.TIERS;
      for (const p of pieces) {
        const grid = el('div', 'cgrid');
        grid.appendChild(el('div', 'cpiece', p));
        for (const t of tiers) {
          const cell = el('div', 'ccell');
          cell.appendChild(el('div', 'ctier', `${t}개`));
          for (const a of global.AUGMENTS.filter(x => x.piece === p && x.tier === t)) {
            const c = el('div', 'crow');
            c.innerHTML = `<div class="chead"><span class="augid">${a.id}</span><span class="tag">${a.tag}</span>` +
              (a.secret ? '<span class="tag secret">비밀</span>' : '') + '</div>' +
              `<div class="ctext">${termHTML(a.text, a.terms)}</div>`;
            if (a.terms && a.terms.length) c.appendChild(termTags(a.terms));
            cell.appendChild(c);
          }
          grid.appendChild(cell);
        }
        body.appendChild(grid);
      }
    }
    s1.onchange = s2.onchange = fill; fill();
    const close = overlay(wrap, { wide: true });
    const x = el('button', 'closebtn', '닫기'); x.onclick = close; wrap.appendChild(x);
  }

  function openRules() {
    const wrap = el('div', 'codex');
    wrap.appendChild(el('h2', null, '규칙 · 용어'));
    const body = el('div', 'codexbody');
    body.appendChild(el('h3', null, '기본'));
    for (const t of [
      '처치 카운트가 1 · 3 · 6 · 11에 닿을 때마다 그 티어의 증강 3개 중 하나를 얻습니다.',
      '기물을 클릭하거나 끌어서 둡니다. 제한시간이 다 되면 집니다 (모달이 열려 있는 동안은 시계가 멈춥니다).',
      '지정불가 기물은 파란 숫자 배지로 남은 수가 표시되며, 체크를 벗어날 때만 예외적으로 움직일 수 있습니다.',
      '증강이 판을 바꾸면 바뀐 칸이 금색으로 빛나고 어떤 증강 때문인지 배너와 기록에 남습니다.',
    ]) { const c = el('div', 'crow'); c.appendChild(el('div', 'ctext', t)); body.appendChild(c); }
    body.appendChild(el('h3', null, '전역 룰'));
    for (const r of global.GLOBAL_RULES) {
      const c = el('div', 'crow');
      c.innerHTML = `<div class="chead"><b>${r.name}</b></div><div class="ctext">${r.body}</div><div class="corig">${r.why}</div>`;
      body.appendChild(c);
    }
    body.appendChild(el('h3', null, '용어'));
    for (const g2 of global.GLOSSARY) {
      const c = el('div', 'crow');
      c.innerHTML = `<div class="chead"><b>${g2.term}</b></div><div class="ctext">${g2.desc}</div>`;
      body.appendChild(c);
    }
    wrap.appendChild(body);
    const close = overlay(wrap, { wide: true });
    const x = el('button', 'closebtn', '닫기'); x.onclick = close; wrap.appendChild(x);
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

  function startGame(mode) {
    $('#endfx').className = ''; $('#endfx').innerHTML = '';
    $('#banners').innerHTML = '';
    flip = false;
    const tc = parseTC($('#h-tc').value);
    $('#tcinfo').textContent = tc ? tc.label : '무제한';
    hideHome();
    toggleLog(false);
    SFX().unlock();
    Game().start({ mode, aiSide: 'b', difficulty, timeControl: tc });
    // 2인 대전에서는 난이도가 의미 없다
    $('#g-diff').style.display = mode === 'ai' ? '' : 'none';
  }

  function boot() {
    const gm = Game();
    gm.api = {
      pickSquare, pickOption, confirm, draft, flash, announce,
      msg: (t) => { toast(t); G().log.push({ t: 'text', text: t }); renderLog(); },
      reveal: (id) => gm.revealAug(id),
      grant: (s, id) => gm.grantAug(s, id),
    };
    gm.onUpdate = (kind) => { sel = -1; dests = []; soundForUpdate(kind); render(); };

    const board = $('#board');
    board.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    board.addEventListener('contextmenu', e => e.preventDefault());

    // 난이도 (메인은 시작 전 설정, 인게임은 즉시 반영)
    wireDifficulty('#h-diff', false);
    wireDifficulty('#g-diff', true);
    setDifficulty('normal');

    // 메인 화면
    $('#h-ai').onclick = () => startGame('ai');
    $('#h-pvp').onclick = () => startGame('pvp');
    $('#h-codex').onclick = openCodex;
    $('#h-rules').onclick = openRules;

    // 인게임
    $('#tohome').onclick = () => { toggleLog(false); renderHomeRecords(); showHome(); };
    $('#restart').onclick = () => startGame(gm.mode);
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

    // 진행 기록 패널
    $('#logclose').onclick = () => toggleLog(false);
    renderHomeRecords();

    // 화면 뒤에 유효한 판을 하나 만들어 두고 메인을 띄운다 (AI 는 아직 돌지 않음)
    gm.start({ mode: 'pvp', timeControl: null });
    showHome();
    requestAnimationFrame(clockLoop);
  }

  document.addEventListener('DOMContentLoaded', boot);
})(window);
