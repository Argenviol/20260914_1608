/* ============================================================
   무제체스 - 게임 진행 (턴 흐름 / 증강 드래프트 / 승리 판정)
   ============================================================ */
(function (global) {
  'use strict';
  const E = global.Engine;

  const Game = {
    G: null,
    mode: 'pvp',          // 'pvp' | 'ai'
    aiSide: 'b',
    difficulty: 'normal', // 'easy' | 'normal' | 'hard'
    timeControl: { base: 300000, inc: 3000, label: '5분 + 3초' },  // null 이면 무제한. 메인의 기본값과 같다
    api: null,            // UI 가 주입
    busy: false,
    onUpdate: null,
    lastMove: null,
  };
  global.Game = Game;

  const opp = E.other;
  const impl = (id) => global.AugImpl[id] || {};

  /* ───────── 판 스냅샷 (증강이 무엇을 바꿨는지 추적) ───────── */
  // 기물 id 뿐 아니라 종류·색까지 담는다. 변이(type만 바뀜)도 변화로 잡아야 한다.
  function snap(G) {
    const s = new Array(64);
    for (let i = 0; i < 64; i++) {
      const p = G.bd[i];
      s[i] = p ? `${p.id}:${p.type}:${p.color}` : '';
    }
    return s;
  }
  function diffSnap(a, b) {
    const out = [];
    for (let i = 0; i < 64; i++) if (a[i] !== b[i]) out.push(i);
    return out;
  }
  // 증강 하나를 실행하고, 판이 바뀌었으면 어느 칸이 왜 바뀌었는지 알린다
  async function runHook(id, hook, side, ctx) {
    const h = impl(id)[hook];
    if (typeof h !== 'function') return;
    const before = snap(Game.G);
    Game.G.lastSwap = null;
    try { await h(Game.G, side, apiFor(side), ctx); }
    catch (err) { console.error('증강 오류', id, hook, err); }
    const changed = diffSnap(before, snap(Game.G));
    if (changed.length) {
      const a = global.AUG_BY_ID[id];
      Game.G.revealed[id] = true;                       // 발동한 비밀 증강은 공개된다
      pushLog(`⚡ [${id}] ${a.piece} ${a.tier}개 발동 — ${a.text}`);
      if (Game.api && Game.api.flash) Game.api.flash(changed, id, side);
    }
    /* 교환이 일어났으면 '누구와 바뀌었는지' 를 그 증강 카드에 적어 둔다.
       온라인으로는 안 보낸다 — 비밀 증강이면 카드의 메모가 곧 정체다.
       상대는 진행 기록의 '⇄ …' 줄로 같은 내용을 본다. */
    if (Game.G.lastSwap) {
      Game.augNotes[side][id] = Game.G.lastSwap;
      Game.G.lastSwap = null;
    }
  }

  // 판마다 비운다. 지난 판의 교환 메모가 남으면 안 된다.
  Game.augNotes = { w: {}, b: {} };

  /* ───────── 훅 디스패치 ───────── */
  async function fire(hook, side, ctx) {
    for (const id of [...Game.G.augs[side]]) await runHook(id, hook, side, ctx);
  }

  /* ───────── API (사람 / AI 분기) ───────── */
  function apiFor(side) {
    const human = !(Game.mode === 'ai' && side === Game.aiSide);
    return human ? Game.api : autoApi(side);
  }

  // AI 는 모든 선택을 자동으로 처리한다
  function autoApi(side) {
    return {
      async pickSquare(prompt, squares, optional) {
        if (!squares || !squares.length) return null;
        return squares[0];
      },
      async pickOption(prompt, options) {
        const real = options.filter(o => o.value !== null);
        return real.length ? real[0].value : null;
      },
      // 매번 발동하면 기물이 쉴 새 없이 자리를 옮겨 판이 어지러워진다
      async confirm() { return Math.random() < 0.5; },
      msg(t) { pushLog(`[AI] ${t}`); },
      flash() { },
      event() { },
      reveal(id) { revealAug(id); },
      async grant(s, id) { await grantAug(s, id); },
    };
  }

  function pushLog(text) {
    Game.G.log.push({ t: 'text', text });
    if (Game.onUpdate) Game.onUpdate('log');
  }

  /* ───────── 국면 스냅샷 ─────────
     기록에서 한 줄을 누르면 그때 판을 그대로 다시 볼 수 있도록,
     수가 끝날 때마다 판을 통째로 저장한다. 칸당 문자열 하나라 가볍다. */
  function pushSnapshot(side, from, to) {
    const G = Game.G;
    const board = new Array(64);
    for (let i = 0; i < 64; i++) {
      const p = G.bd[i];
      board[i] = p ? p.type + p.color : null;
    }
    G.snaps.push({
      ply: G.ply, moveNo: G.moveNo, side, from, to, board,
      kills: { w: G.kills.w, b: G.kills.b },
      augs: { w: G.augs.w.length, b: G.augs.b.length },
    });
    /* 이번 수에 쌓인 줄을 전부 이 스냅샷에 묶는다.
       예전에는 '→' 가 들어간 착수 줄 하나만 연결했다. 그래서 증강 획득·처치·발동 줄은
       눌러도 아무 일이 없었다 — 정작 그때 판이 궁금한 건 그런 줄인데. */
    const idx = G.snaps.length - 1;
    for (let i = G.log.length - 1; i >= 0; i--) {
      const e = G.log[i];
      if (e.t !== 'text') continue;
      if (e.snap !== undefined) break;        // 지난 수까지 왔으면 그만
      e.snap = idx;
    }
  }

  /* ───────── 증강 획득 ───────── */
  async function grantAug(side, id, capCtx) {
    if (Game.G.augs[side].includes(id)) return;
    Game.G.augs[side].push(id);
    const a = global.AUG_BY_ID[id];
    // 비밀 증강은 기록에도 이름을 남기지 않는다.
    // (온라인에서는 이 줄이 그대로 상대에게 넘어가고, AI전에서도 기록만 읽으면 다 보였다)
    pushLog(a.secret && !Game.G.revealed[id]
      ? `${side === 'w' ? '백' : '흑'} 증강 획득: 비밀 (${a.piece} ${a.tier}개) — 발동 전까지 비공개`
      : `${side === 'w' ? '백' : '흑'} 증강 획득: [${id}] ${a.piece} ${a.tier}개 — ${a.text}`);
    if (!a.secret) {
      Game.G.revealed[id] = true;
      if (Game.api && Game.api.announce) Game.api.announce(side, id, 'gain');
    } else if (Game.api && Game.api.announce) {
      Game.api.announce(side, id, 'secret');       // 무엇인지는 가리고 획득 사실만 알린다
    }
    await fire2(id, 'onGain', side, null);

    // 이 증강을 열어준 처치도 그 증강의 대상이다.
    // onCapture 는 드래프트보다 먼저 돌기 때문에, 이렇게 한 번 더 흘려보내지 않으면
    // P1c("적을 처치한 폰이 …") · B3c("방금 적을 처치한 비숍이 …") 처럼
    // 조건을 만들어 준 바로 그 수에서 정작 발동하지 않는다.
    if (capCtx && typeof impl(id).onCapture === 'function') {
      const still = Game.G.bd[capCtx.to];
      // regrant 표시 — '조건을 만든 그 처치' 에는 걸리면 안 되는 증강이 골라낼 수 있게 한다
      if (still && still.id === capCtx.mover.id) {
        await fire2(id, 'onCapture', side, Object.assign({}, capCtx, { regrant: true }));
      }
    }

    if (Game.onUpdate) Game.onUpdate('augs');
  }
  Game.grantAug = grantAug;

  // 비밀 증강이 발동해 공개되는 순간
  function revealAug(id) {
    if (Game.G.revealed[id]) return;
    Game.G.revealed[id] = true;
    const owner = Game.G.augs.w.includes(id) ? 'w' : (Game.G.augs.b.includes(id) ? 'b' : null);
    const a = global.AUG_BY_ID[id];
    if (a) pushLog(`${owner === 'w' ? '백' : '흑'} 비밀 증강 공개: [${id}] ${a.piece} ${a.tier}개 — ${a.text}`);
    if (owner && Game.api && Game.api.announce) Game.api.announce(owner, id, 'reveal');
  }
  Game.revealAug = revealAug;

  async function fire2(id, hook, side, ctx) {
    await runHook(id, hook, side, ctx);
  }

  /* ───────── 드래프트 ───────── */
  function nextThreshold(G, side) {
    const i = G.tierIdx[side];
    if (i >= global.TIERS.length) return null;
    return global.TIERS[i];
  }
  Game.nextThreshold = nextThreshold;

  function sample(arr, n) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, n);
  }

  // 원본 엑셀 증강표는 (기물 × 처치수) 칸마다 선택지가 정확히 3개다.
  // 그래서 드래프트는 '그 칸 하나'를 그대로 펼쳐 보여주고 1개만 고르게 한다.
  // 어느 기물의 칸을 펼칠지는 방금 처치한 기물의 종류로 정한다.
  function cellOffer(G, side, tier, pieceKo) {
    return global.AUGMENTS
      .filter(a => a.tier === tier && a.piece === pieceKo)
      .map(a => ({ aug: a, block: global.augBlockReason(G, side, a) }));
  }

  function pickableCount(offer) { return offer.filter(o => !o.block).length; }

  // 방금 처치한 기물의 칸을 우선 쓰고, 그 칸에서 고를 게 하나도 없으면
  // 고를 수 있는 다른 기물 칸으로 넘긴다 (드래프트가 빈손이 되지 않도록).
  function chooseCell(G, side, tier, preferKo) {
    const order = [];
    if (preferKo) order.push(preferKo);
    for (const p of global.PIECES_KO) if (p !== preferKo) order.push(p);
    let firstNonEmpty = null;
    for (const ko of order) {
      const offer = cellOffer(G, side, tier, ko);
      if (!offer.length) continue;
      if (!firstNonEmpty) firstNonEmpty = { ko, offer };
      if (pickableCount(offer) > 0) return { ko, offer };
    }
    return firstNonEmpty;
  }

  // byKo = '무엇으로 잡았는가'. 원안의 "어떤 기물로 적을 죽였냐에 따라" 기준.
  async function runDrafts(side, byKo, capCtx) {
    const G = Game.G;
    let guard = 0;
    while (guard++ < 8) {
      const thr = nextThreshold(G, side);
      if (thr === null || G.kills[side] < thr) break;
      const tier = global.TIERS[G.tierIdx[side]];
      G.tierIdx[side]++;

      /* K1b — "다음 증강을 고를 때 선택지를 두 개 고를 수 있습니다".
         펼치는 칸은 그대로 하나다. 그 칸의 선택지 3개 중 2개를 고르는 것이지,
         다른 기물 칸을 한 번 더 펼치는 것이 아니다.
         그래서 칸은 첫 번째에만 고르고, 두 번째는 같은 칸을 다시 펼친다
         (방금 고른 카드는 '이미 보유한 증강입니다' 로 잠겨서 온다). */
      let rounds = 1;
      if (G.flags[side].K1b) { rounds = 2; G.flags[side].K1b = 0; }

      let cellKo = null;
      for (let r = 0; r < rounds; r++) {
        const cell = r === 0
          ? chooseCell(G, side, tier, byKo)
          : { ko: cellKo, offer: cellOffer(G, side, tier, cellKo) };
        if (!cell || !pickableCount(cell.offer)) {
          // 같은 칸의 남은 둘이 다 잠겨 있으면 두 번째는 없다 — 다른 칸으로 넘기지 않는다
          if (r > 0) pushLog(`K1b — ${cellKo} ${tier}개 칸에 더 고를 수 있는 증강이 없어 하나만 골랐습니다.`);
          break;
        }
        cellKo = cell.ko;
        const isAI = Game.mode === 'ai' && side === Game.aiSide;
        let chosenId;
        if (isAI) {
          const pickable = cell.offer.filter(o => !o.block).map(o => o.aug);
          chosenId = global.AI.draftPick(G, side, pickable, 1, Game.difficulty)[0];
        } else {
          chosenId = await Game.api.draft({
            side, tier, piece: cell.ko, offer: cell.offer,
            round: r + 1, rounds, byKo,
          });
        }
        if (global.Stats) {
          global.Stats.picked({
            side, ply: G.ply, tier, piece: cell.ko,
            offer: cell.offer, chosen: chosenId, isAI,
          });
        }
        if (chosenId) await grantAug(side, chosenId, capCtx);
      }
    }
  }

  // 상태를 받은 쪽이 자기 기록용 스냅샷을 남길 때 쓴다
  Game.recordSnapshot = function (side, from, to) { pushSnapshot(side, from, to); };

  /* ───────── 이동 실행 ───────── */
  Game.legalFor = function (sq) {
    return E.legalMoves(Game.G, sq);
  };

  Game.play = async function (move) {
    if (Game.busy || Game.G.result) return false;
    Game.busy = true;
    try { await doMove(move); }
    finally { Game.busy = false; }
    if (Game.onUpdate) Game.onUpdate('move');
    maybeAI();
    return true;
  };

  async function doMove(move) {
    const G = Game.G;
    const side = G.turn;
    const mover = G.bd[move.from];
    const from = move.from;
    // applyRaw 가 승격 시 type 을 바꾸므로, '무엇으로 두었는지' 를 미리 기억한다
    const moverType = mover.type;

    // 처치 대상 확인
    let victim = G.bd[move.to];
    let victimSq = move.to;
    let capCtx = null;               // 이 수로 일어난 처치 (드래프트로 얻은 증강에도 넘겨준다)
    if (move.ep) { victimSq = E.idx(move.from >> 3, move.to & 7); victim = G.bd[victimSq]; }

    // 플래그 소모
    if (move.p1b && G.flags[side].P1b > 0) G.flags[side].P1b--;
    if (move.rookLike && G.flags[side].R3a) G.flags[side].R3a = null;
    if (move.teleport) G.flags[side].Q1aReady = undefined;

    E.applyRaw(G, move);
    Game.lastMove = move;
    G.flags[side].Q1aReady = undefined;
    G.hist.push(E.sqName(from) + E.sqName(move.to) + (move.promo || ''));
    G.lastBySide[side] = {
      from, to: move.to, type: moverType,
      promo: move.promo || null,
      castle: move.castle || null,
      victim: victim ? victim.type : null,
      // 도약이면 지나간 칸. 상대 화면에서도 같은 경로를 보여 주려고 판에 남긴다.
      path: moverType === 'n' ? E.leapPath(from, move.to) : [],
    };
    if (global.Stats) global.Stats.moved(side, moverType, victim ? victim.type : null);

    // 처치 처리
    if (victim) {
      G.grave[victim.color].push(victim.type);
      G._killByPawn = mover.type === 'p';
      E.addKill(G, side, 1, victim);
      G._killByPawn = false;
      pushLog(`${side === 'w' ? '백' : '흑'} ${E.KO[mover.type]} ${E.sqName(from)}→${E.sqName(move.to)} · ${E.KO[victim.type]} 처치 (누적 ${G.kills[side]})`);

      // B6a: 비숍을 처치한 기물도 함께 죽는다 (킹·퀸 제외)
      if (victim.type === 'b' && E.hasEff(G, 'bishopRevenge', victim.color)
        && !'kq'.includes(mover.type)) {
        E.removePiece(G, move.to, { force: true });
        Game.G.revealed['B6a'] = true;
        pushLog('B6a — 비숍을 처치한 기물이 함께 죽었습니다.');
      }
      capCtx = { from, to: move.to, mover, victim, victimSq };
      if (G.bd[move.to]) await fire('onCapture', side, capCtx);
    } else {
      pushLog(`${side === 'w' ? '백' : '흑'} ${E.KO[mover.type]} ${E.sqName(from)}→${E.sqName(move.to)}`);
    }

    if (G.bd[move.to]) await fire('onAfterMove', side, { move, mover });

    // K6a: 다른 기물을 움직인 뒤 킹도 한 번 더
    if (G.flags[side].K6a && mover.type !== 'k') {
      const k = E.findKing(G, side);
      const extra = E.legalMoves(Object.assign(G, { turn: side }), k);
      if (extra.length) {
        const yes = await apiFor(side).confirm('K6a — 킹을 한 번 더 움직이시겠습니까?');
        if (yes) {
          const dests = extra.map(m => m.to);
          const to = await apiFor(side).pickSquare('킹을 움직일 칸을 고르세요', dests, true);
          if (to != null) {
            const m2 = extra.find(m => m.to === to);
            const v2 = G.bd[m2.to];
            E.applyRaw(G, m2);
            if (v2) { G.grave[v2.color].push(v2.type); E.addKill(G, side, 1, v2); }
            G.flags[side].K6a = 0;
            pushLog('K6a — 킹을 추가로 움직였습니다.');
          }
        }
      }
    }

    // 승리 판정 (K11b: 상대 킹 상하좌우 3칸 점거)
    if (checkEncircle(G, side)) {
      G.result = { winner: side, reason: 'K11b — 상대 킹을 포위했습니다.' };
      return;
    }

    // 원안 그대로 '어떤 기물로 죽였냐' 기준. 승격 전 종류를 쓴다.
    await runDrafts(side, victim ? E.KO[moverType] : null, capCtx);
    if (G.result) return;

    // 시계: 이번 수에 쓴 시간을 차감하고 증분을 더한다
    Game.chargeClock(side);
    if (G.result) return;

    // 턴 종료
    G.ply++;
    if (side === 'b') G.moveNo++;
    G.turn = opp(side);

    // 만료 / 포영 복귀
    for (const e of E.expireEffects(G)) {
      if (e.expTag) await fire2(e.expTag, 'onExpire', e.owner, e);
    }
    const beforeReturn = snap(G);
    E.returnPhased(G);
    const returned = diffSnap(beforeReturn, snap(G));
    if (returned.length) {
      pushLog('포영되었던 기물이 원래 칸으로 복귀했습니다.');
      if (Game.api && Game.api.flash) Game.api.flash(returned, '포영 복귀', side);
    }

    // 이 시점의 판을 기록에서 되돌려 볼 수 있도록 남긴다
    pushSnapshot(side, from, move.to);

    /* 상대가 둔 직후 훅 (증강 소유자 기준). 구현이 B1b 하나뿐이고 사람에게 묻지 않는다.
       온라인에서는 여기서 돌리면 안 된다 — 이 화면에는 상대의 비밀 증강이 가면('?b1')으로만
       있어서 구현이 비어 있다. B1b 가 온라인에서 한 번도 발동하지 않던 원인.
       상대 화면이 판을 받았을 때(adoptRemote) 자기 증강으로 돌린다. */
    if (Game.mode !== 'online') await fire('onOppMoved', opp(side), { move });

    // 온라인 대전의 경계.
    // beginTurn 안에는 onSched(B3c 부활 선택) 처럼 '차례가 시작되는 쪽'이 답해야 하는
    // 프롬프트가 들어 있다. 그래서 여기서 판을 넘기고, beginTurn 은 상대 화면에서 돈다.
    if (Game.mode === 'online') {
      global.Net.push({ side, from, to: move.to });
      return;
    }

    await beginTurn(G.turn);
  }

  /* ───────── 온라인: 받은 판을 채택하고, 내 차례면 턴을 연다 ───────── */
  // 받은 판에서 '방금 둔 수' 가 아닌데 바뀐 칸 — 상대 증강이 지우거나 옮긴 자리다
  const shownFx = new Set();
  function remoteChanges(before, G, s) {
    const after = snap(G);
    const skip = new Set();
    const lm = s && s.snapAdd ? G.lastBySide[s.snapAdd.side] : null;
    if (lm) {
      skip.add(lm.from); skip.add(lm.to);
      const r = lm.from >> 3;
      if (lm.castle === 'k') { skip.add(E.idx(r, 7)); skip.add(E.idx(r, 5)); }
      if (lm.castle === 'q') { skip.add(E.idx(r, 0)); skip.add(E.idx(r, 3)); }
      if (lm.victim && !G.bd[lm.to]) skip.add(lm.to);
      if (lm.type === 'p' && lm.victim && ((lm.from & 7) !== (lm.to & 7))) skip.add(E.idx(lm.from >> 3, lm.to & 7));   // 앙파상
    }
    return diffSnap(before, after).filter(i => !skip.has(i));
  }
  // 받은 기록에서 마지막 착수 줄 뒤에 붙은 증강 줄 — 상대 화면에서만 배너로 떴던 것들
  function remoteLines(G) {
    const out = [];
    for (let i = G.log.length - 1; i >= 0; i--) {
      const e = G.log[i];
      if (e.t !== 'text') continue;
      if (e.text.indexOf('→') >= 0 && e.text.indexOf('⚡') < 0) break;
      // '⚡ [id] … 발동' 줄만. 화면 효과가 남긴 '⚡ 백의 … 발동 — e4' 줄은 같은 일의 중복이다.
      if (/^⚡ \[/.test(e.text) || (!/^⚡/.test(e.text) && /제거|포영|변이|소환|부활|교환|공개/.test(e.text))) out.unshift(e.text);
    }
    return out.filter(t => { const k = G.ply + '|' + t; if (shownFx.has(k)) return false; shownFx.add(k); return true; });
  }

  Game.adoptRemote = async function (s) {
    const G = Game.G;
    if (!G || Game.mode !== 'online') return;

    const me = Game.mySide, foe = opp(me);
    const before = snap(G);
    const prevFoeAugs = G.augs[foe].slice();

    const newlyRevealed = global.Net.adopt(s) || [];
    Game.oppDraft = null;                     // 판이 왔다는 건 상대의 증강 선택이 끝났다는 뜻
    for (const id of newlyRevealed) {
      const a = global.AUG_BY_ID[id];
      if (!a || a.hidden) continue;
      const owner = G.augs.w.includes(id) ? 'w' : (G.augs.b.includes(id) ? 'b' : null);
      if (!owner || owner === me || !Game.api || !Game.api.announce) continue;
      /* revealed 에는 비밀이 아닌 증강도 얻는 순간 들어간다(grantAug).
         그걸 전부 '비밀 증강 공개' 로 알리던 게, 비밀도 아닌 첫 증강이
         "비밀 증강이 공개되었습니다" 로 뜨던 원인이다. 얻은 것은 얻었다고 알린다. */
      Game.api.announce(owner, id, a.secret ? 'reveal' : 'gain');
    }
    // 상대가 새로 얻은 비밀 증강 — 가면('?w1')으로만 오지만 얻었다는 사실은 알린다
    for (const id of G.augs[foe]) {
      const a = global.AUG_BY_ID[id];
      if (a && a.hidden && prevFoeAugs.indexOf(id) < 0 && Game.api && Game.api.announce) Game.api.announce(foe, id, 'secret');
    }
    // 상대 증강이 지우거나 옮긴 칸을 이쪽 화면에서도 보여 준다 (예전에는 그냥 사라졌다)
    const changed = remoteChanges(before, G, s);
    const lines = remoteLines(G);
    if ((changed.length || lines.length) && Game.api && Game.api.remoteFx) Game.api.remoteFx(changed, lines);

    Game.startClockTurn();
    Game.clockPaused = false;
    if (Game.onUpdate) Game.onUpdate('remote');
    if (G.result) return;

    // 내 차례가 아니거나(상대의 턴 시작 결과였음), 이미 이 ply 의 턴을 연 적이 있으면 끝.
    // 두 번째 조건이 없으면 새로고침으로 재접속했을 때 예약 증강이 또 터진다.
    if (G.turn !== me || G.begunPly === G.ply) return;

    Game.busy = true;
    try {
      // 상대가 방금 둔 수에 대한 내 증강(B1b) — 내 화면에서만 실제 구현이 있다
      if (s.snapAdd && s.snapAdd.side === foe) await fire('onOppMoved', me, { move: { from: s.snapAdd.from, to: s.snapAdd.to } });
      await beginTurn(G.turn);
    }
    finally { Game.busy = false; }
    G.begunPly = G.ply;

    // beginTurn 이 판을 바꿨을 수 있다(예약 증강 부활·제거, 체크메이트 판정).
    // 상대가 그걸 못 보면 화면이 어긋나므로 항상 한 번 되돌려 보낸다.
    // 이 상태의 turn 은 여전히 내 색이라 상대는 beginTurn 을 돌리지 않는다 → 핑퐁이 생기지 않는다.
    global.Net.push(null);
    if (Game.onUpdate) Game.onUpdate('turnstart');
  };

  /* 항복. 온라인이면 상대에게도 알린다.
     AI·2인 대전에서는 지금 둘 차례인 쪽(온라인이면 나)이 진다. */
  Game.resign = function () {
    const G = Game.G;
    if (!G || G.result) return null;
    const loser = Game.mode === 'online' ? Game.mySide : G.turn;
    const who = loser === 'w' ? '백' : '흑';
    if (Game.mode === 'online') global.Net.resign();
    G.result = { winner: opp(loser), reason: `${who} 항복` };
    pushLog(`${who} 항복 — ${loser === 'w' ? '흑' : '백'} 승리`);
    if (Game.mode === 'online') global.Net.push(null);
    if (Game.onUpdate) Game.onUpdate('move');
    return loser;
  };

  /* 대국 중단 — 승패를 남기지 않고 판을 끝낸다. 항복(패배 기록)과 다르다. */
  Game.abortGame = function (reason) {
    const G = Game.G;
    if (!G || G.result) return;
    G.result = { winner: null, reason: reason || '대국을 중단했습니다', aborted: true };
    pushLog(reason || '대국을 중단했습니다');
    if (Game.onUpdate) Game.onUpdate('move');
  };

  // 상대가 항복했거나 연결이 끊겨 내가 이기는 경우
  Game.finishOnline = function (winner, reason) {
    const G = Game.G;
    if (!G || G.result) return;
    G.result = { winner, reason };
    pushLog(reason);
    if (Game.onUpdate) Game.onUpdate('move');
  };

  function checkEncircle(G, side) {
    if (!E.ownsAug(G, side, 'K11b')) return false;
    const k = E.findKing(G, opp(side));
    if (k < 0) return false;
    const [r, c] = E.rc(k);
    let n = 0, tot = 0;
    for (const [dr, dc] of E.DIR_R) {
      const rr = r + dr, cc = c + dc;
      if (!E.onBoard(rr, cc)) continue;
      tot++;
      const p = G.bd[E.idx(rr, cc)];
      if (p && p.color === side) n++;
    }
    return n >= Math.min(3, tot);
  }

  async function beginTurn(side) {
    const G = Game.G;

    // 예약 효과
    const due = G.eff.filter(e => e.kind === 'sched' && e.owner === side && G.ply >= e.fireAt);
    G.eff = G.eff.filter(e => !(e.kind === 'sched' && e.owner === side && G.ply >= e.fireAt));
    for (const e of due) await fire2(e.tag, 'onSched', side, e);

    // 지속 틱 (Q11b)
    for (const id of [...G.augs[side]]) {
      const t = impl(id).tick;
      if (typeof t === 'function') t(G, side, apiFor(side));
    }

    await fire('onTurnStart', side, null);

    /* 턴 시작에 일어난 처치(N6b 처럼)도 바로 증강으로 이어져야 한다.
       예전에는 드래프트가 doMove 안에서만 돌아서, 이런 처치는 '다음에 수를 둘 때'
       뒤늦게 창이 떴다. 잡은 것과 증강이 한 박자 어긋나 보이던 원인이다. */
    await runDrafts(side, null, null);
    if (G.result) return;

    // 체크 / 체크메이트
    const st = E.statusOf(G, side);
    if (st === 'checkmate') { G.result = { winner: opp(side), reason: '체크메이트' }; return; }
    if (st === 'stalemate') { G.result = { winner: null, reason: '스테일메이트 (무승부)' }; return; }
    if (st === 'check') {
      const kSq = E.findKing(G, side);
      let checker = -1;
      for (const i of E.piecesOf(G, opp(side))) {
        const save = G.turn; G.turn = opp(side);
        if (E.genPseudo(G, i).some(m => m.to === kSq)) checker = i;
        G.turn = save;
        if (checker >= 0) break;
      }
      pushLog('체크!');
      await fire('onCheck', side, { checkerSq: checker });
      if (E.statusOf(G, side) === 'checkmate') { G.result = { winner: opp(side), reason: '체크메이트' }; }
    }
  }

  /* ───────── 활성 효과 목록 (남은 턴 표시용) ───────── */
  const EFF_LABEL = {
    untargetable: '지정불가',
    bishopRoot: '비숍 고정',
    knightOnly: '나이트만 이동 가능',
    rookLine: '룩 기준 이동 제한',
    pawnKillDouble: '폰 처치 카운트 2배',
    bishopRevenge: '비숍 복수',
    bishopAsQueen: '비숍이 퀸처럼',
    queenNova: '퀸 포영 폭발',
    tempQueen: '임시 퀸',
    sched: '예약 발동',
  };

  function squaresOfIds(G, ids) {
    const out = [];
    if (!ids) return out;
    for (let i = 0; i < 64; i++) if (G.bd[i] && ids.includes(G.bd[i].id)) out.push(i);
    return out;
  }

  // 남은 플라이(= 한 사람이 한 번 두는 것) 수. 화면에는 '남은 수' 로 표기한다.
  Game.activeEffects = function () {
    const G = Game.G, out = [];
    for (const e of G.eff) {
      const until = e.kind === 'sched' ? e.fireAt : e.until;
      if (until === undefined) continue;
      const remain = Math.max(0, until - G.ply);
      const squares = squaresOfIds(G, e.ids);
      let label = EFF_LABEL[e.kind] || e.kind;
      let detail = '';
      if (e.kind === 'untargetable') {
        detail = squares.length
          ? squares.map(i => `${E.KO[G.bd[i].type]} ${E.sqName(i)}`).join(', ')
          : '대상 없음';
      } else if (e.kind === 'rookLine') {
        label = `상대 룩 ${e.dir === 'up' ? '위쪽' : '아래쪽'} 이동 금지`;
        detail = `대상 ${e.target === 'w' ? '백' : '흑'} · 기준 ${E.sqName(e.refSq)}`;
      } else if (e.kind === 'sched') {
        const a = global.AUG_BY_ID[e.tag];
        detail = a ? `[${e.tag}] ${a.piece} ${a.tier}개` : e.tag;
      } else if (squares.length) {
        detail = squares.map(i => E.sqName(i)).join(', ');
      }
      out.push({ kind: e.kind, label, detail, owner: e.owner, remain, squares });
    }
    for (const x of G.phased) {
      out.push({
        kind: 'phased', label: '포영', owner: x.owner,
        detail: `${E.KO[x.pc.type]} — ${E.sqName(x.sq)} 로 복귀 예정`,
        remain: Math.max(0, x.until - G.ply), squares: [],
      });
    }
    return out.sort((a, b) => a.remain - b.remain);
  };

  // 특정 기물에 걸린 지정불가의 남은 수 (보드 배지용)
  Game.untargetableRemain = function (pieceId) {
    let best = null;
    for (const e of Game.G.eff) {
      if (e.kind !== 'untargetable' || !e.ids.includes(pieceId)) continue;
      const r = Math.max(0, e.until - Game.G.ply);
      if (best === null || r > best) best = r;
    }
    return best;
  };

  /* ───────── 수동 발동 (횟수제한 증강) ───────── */
  Game.activatable = function (side) {
    return Game.G.augs[side].filter(id => {
      const c = impl(id).canActivate;
      return typeof c === 'function' && c(Game.G, side);
    });
  };

  Game.activate = async function (id) {
    const G = Game.G, side = G.turn;
    if (Game.busy || G.result) return;
    // 온라인에서는 내 차례에 내 증강만. (상대 것을 이 화면에서 돌리면 내 판만 바뀌고 곧 덮어써진다)
    if (Game.mode === 'online' && side !== Game.mySide) return;
    if (!G.augs[side].includes(id)) return;
    Game.busy = true;
    try { await fire2(id, 'activate', side, null); }
    finally { Game.busy = false; }
    if (Game.onUpdate) Game.onUpdate('activate');
    // 발동으로 바뀐 판을 바로 넘긴다 — 다음 수를 둘 때까지 상대 화면이 옛 판이던 것
    if (Game.mode === 'online' && !G.result) global.Net.push(null);
  };

  /* ───────── 대국 시계 ───────── */
  // clock = { w, b, inc, limit } (ms). null 이면 무제한.
  // 모달(증강 선택·대상 지정)이 열려 있는 동안은 Game.clockPaused 로 멈춘다.
  Game.clockPaused = false;
  let turnStartedAt = 0;

  Game.startClockTurn = function () { turnStartedAt = performance.now(); };

  Game.chargeClock = function (side) {
    const G = Game.G;
    if (!G.clock) return;
    const spent = Math.max(0, performance.now() - turnStartedAt);
    G.clock[side] = Math.max(0, G.clock[side] - spent);
    if (G.clock[side] <= 0) {
      G.result = { winner: opp(side), reason: '시간 초과' };
      return;
    }
    G.clock[side] += G.clock.inc;
    turnStartedAt = performance.now();
  };

  // 화면 표시용 남은 시간 (진행 중인 쪽은 실시간 차감)
  Game.clockRemain = function (side) {
    const G = Game.G;
    if (!G.clock) return null;
    let ms = G.clock[side];
    if (side === G.turn && !G.result && !Game.clockPaused) {
      ms -= Math.max(0, performance.now() - turnStartedAt);
    }
    return Math.max(0, ms);
  };

  // 시간 초과 감시 (UI 가 매 프레임 호출)
  Game.checkFlag = function () {
    const G = Game.G;
    if (!G || !G.clock || G.result || Game.clockPaused) return false;
    // 온라인에서는 자기 차례일 때만 판정한다.
    // 상대가 증강을 고르느라 시계를 멈췄는지는 이쪽에서 알 수 없어서,
    // 남의 시계를 대신 재면 멀쩡한 사람을 시간패로 만든다.
    if (Game.mode === 'online' && G.turn !== Game.mySide) return false;
    if (Game.clockRemain(G.turn) <= 0) {
      G.clock[G.turn] = 0;
      G.result = { winner: opp(G.turn), reason: '시간 초과' };
      pushLog(`${G.turn === 'w' ? '백' : '흑'} 시간 초과 — ${G.turn === 'w' ? '흑' : '백'} 승리`);
      if (Game.mode === 'online') global.Net.push(null);
      return true;
    }
    return false;
  };

  // 모달이 열려 있는 동안 시계를 멈춘다
  Game.pauseClock = function () {
    if (Game.clockPaused || !Game.G || !Game.G.clock) return;
    Game.chargeClockSilently();
    Game.clockPaused = true;
    // 상대 화면에서도 내 시계가 멈춰 보이게 한다 (안 그러면 내가 증강을 고르는 동안
    // 상대 화면에서는 내 시간이 계속 줄어드는 것처럼 보인다)
    if (Game.mode === 'online') global.Net.note('pause', Game.G.clock);
  };
  Game.resumeClock = function () {
    if (!Game.clockPaused) return;
    Game.clockPaused = false;
    turnStartedAt = performance.now();
    if (Game.mode === 'online') global.Net.note('resume', Game.G.clock);
  };
  Game.chargeClockSilently = function () {
    const G = Game.G;
    if (!G || !G.clock) return;
    const side = G.turn;
    const spent = Math.max(0, performance.now() - turnStartedAt);
    G.clock[side] = Math.max(0, G.clock[side] - spent);
    turnStartedAt = performance.now();
  };

  /* ───────── 진영 ───────── */
  // 이 자리에서 사람이 조작하는 진영인가
  Game.isHuman = function (side) {
    return !(Game.mode === 'ai' && side === Game.aiSide);
  };
  Game.humanSide = function () {
    if (Game.mode === 'online') return Game.mySide;
    return Game.mode === 'ai' ? opp(Game.aiSide) : Game.G.turn;
  };
  // 이 화면에서 지금 둘 수 있는가 (온라인이면 내 차례일 때만)
  Game.myTurn = function () {
    if (Game.mode !== 'online') return true;
    return Game.G.turn === Game.mySide;
  };

  /* ───────── AI ───────── */
  function maybeAI() {
    if (Game.mode !== 'ai' || Game.G.result) return;
    if (Game.G.turn !== Game.aiSide) return;
    setTimeout(async () => {
      if (Game.busy || Game.G.result || Game.G.turn !== Game.aiSide) return;
      // AI 는 사용 가능한 횟수제한 증강을 먼저 발동한다
      for (const id of Game.activatable(Game.aiSide)) {
        Game.busy = true;
        try { await fire2(id, 'activate', Game.aiSide, null); }
        finally { Game.busy = false; }
      }
      if (Game.G.result) { if (Game.onUpdate) Game.onUpdate('move'); return; }
      // 탐색은 동기라 화면이 멈춘다 → '생각 중' 을 먼저 그리고 한 프레임 쉰 뒤 계산한다
      Game.busy = true;
      if (Game.onUpdate) Game.onUpdate('thinking');
      await new Promise(r => setTimeout(r, 30));
      let m;
      try { m = global.AI.pick(Game.G, Game.aiSide, Game.difficulty); }
      finally { Game.busy = false; }
      if (!m) {
        // 합법수 없음 → 상태 확정
        const st = E.statusOf(Game.G, Game.aiSide);
        Game.G.result = st === 'checkmate'
          ? { winner: opp(Game.aiSide), reason: '체크메이트' }
          : { winner: null, reason: '스테일메이트 (무승부)' };
        if (Game.onUpdate) Game.onUpdate('move');
        return;
      }
      await Game.play(m);
    }, 350);
  }
  Game.maybeAI = maybeAI;

  /* ───────── 시작 ───────── */
  Game.start = async function (opts) {
    Game.G = E.newGame();
    Game.mode = (opts && opts.mode) || 'pvp';
    Game.aiSide = (opts && opts.aiSide) || 'b';
    Game.mySide = (opts && opts.mySide) || 'w';        // 온라인에서 내가 잡은 색
    if (opts && opts.difficulty) Game.difficulty = opts.difficulty;
    if (opts && opts.timeControl !== undefined) Game.timeControl = opts.timeControl;
    const tc = Game.timeControl;
    Game.G.clock = tc ? { w: tc.base, b: tc.base, inc: tc.inc, limit: tc.base } : null;
    Game.clockPaused = false;
    Game.oppDraft = null;
    shownFx.clear();
    Game.startClockTurn();
    Game.lastMove = null;
    Game.busy = false;
    global.ensureAugImpls();
    pushLog(Game.mode === 'ai'
      ? `게임 시작 — AI 대전 (난이도: ${global.AI.LEVELS[Game.difficulty].label}). 처치 카운트 1 · 3 · 6 · 11 에서 증강을 획득합니다.`
      : Game.mode === 'online'
        ? `게임 시작 — 온라인 대전 (나: ${Game.mySide === 'w' ? '백' : '흑'}). 처치 카운트 1 · 3 · 6 · 11 에서 증강을 획득합니다.`
        : '게임 시작 — 2인 대전. 처치 카운트 1 · 3 · 6 · 11 에서 증강을 획득합니다.');
    // 시작 국면도 한 장 남긴다. 안 그러면 '게임 시작' 줄이 첫 수 뒤 판에 붙어 버린다.
    pushSnapshot(null, -1, -1);
    if (Game.onUpdate) Game.onUpdate('start');
    // 방을 만든 쪽(백)이 첫 판을 넘겨 양쪽 기물 id 를 맞춘다.
    // 재접속으로 들어온 경우에는 보내면 안 된다 — 서버가 갖고 있는 진행 중인 판을 덮어쓴다.
    if (Game.mode === 'online' && opts && opts.pushInitial) global.Net.push(null);
    maybeAI();
  };
})(window);
