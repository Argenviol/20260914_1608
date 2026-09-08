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
    timeControl: { base: 600000, inc: 5000, label: '10분 + 5초' },  // null 이면 무제한
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
    try { await h(Game.G, side, apiFor(side), ctx); }
    catch (err) { console.error('증강 오류', id, hook, err); }
    const changed = diffSnap(before, snap(Game.G));
    if (changed.length) {
      const a = global.AUG_BY_ID[id];
      Game.G.revealed[id] = true;                       // 발동한 비밀 증강은 공개된다
      pushLog(`⚡ [${id}] ${a.piece} ${a.tier}개 발동 — ${a.text}`);
      if (Game.api && Game.api.flash) Game.api.flash(changed, id, side);
    }
  }

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
    // 방금 남긴 스냅샷을 마지막 착수 로그 줄에 연결한다
    for (let i = G.log.length - 1; i >= 0; i--) {
      const e = G.log[i];
      if (e.t !== 'text') continue;
      if (e.snap === undefined && (e.text.indexOf('→') >= 0)) { e.snap = G.snaps.length - 1; }
      break;
    }
  }

  /* ───────── 증강 획득 ───────── */
  async function grantAug(side, id) {
    if (Game.G.augs[side].includes(id)) return;
    Game.G.augs[side].push(id);
    const a = global.AUG_BY_ID[id];
    pushLog(`${side === 'w' ? '백' : '흑'} 증강 획득: [${id}] ${a.piece} ${a.tier}개 — ${a.text}`);
    if (!a.secret) {
      Game.G.revealed[id] = true;
      if (Game.api && Game.api.announce) Game.api.announce(side, id, 'gain');
    } else if (Game.api && Game.api.announce) {
      Game.api.announce(side, id, 'secret');       // 무엇인지는 가리고 획득 사실만 알린다
    }
    await fire2(id, 'onGain', side, null);
    if (Game.onUpdate) Game.onUpdate('augs');
  }
  Game.grantAug = grantAug;

  // 비밀 증강이 발동해 공개되는 순간
  function revealAug(id) {
    if (Game.G.revealed[id]) return;
    Game.G.revealed[id] = true;
    const owner = Game.G.augs.w.includes(id) ? 'w' : (Game.G.augs.b.includes(id) ? 'b' : null);
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
    return Math.max(0, global.TIERS[i] - G.thrCut[side]);
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
  async function runDrafts(side, byKo) {
    const G = Game.G;
    let guard = 0;
    while (guard++ < 8) {
      const thr = nextThreshold(G, side);
      if (thr === null || G.kills[side] < thr) break;
      const tier = global.TIERS[G.tierIdx[side]];
      G.tierIdx[side]++;

      // K1b 는 '선택지 2개' 가 아니라 '드래프트를 한 번 더' 로 처리한다.
      // (증강은 언제나 한 번에 하나만 고른다)
      let rounds = 1;
      if (G.flags[side].K1b) { rounds = 2; G.flags[side].K1b = 0; }

      for (let r = 0; r < rounds; r++) {
        const cell = chooseCell(G, side, tier, byKo);
        if (!cell || !pickableCount(cell.offer)) break;
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
        if (chosenId) await grantAug(side, chosenId);
      }
    }
  }

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
    };

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
      if (G.bd[move.to]) await fire('onCapture', side, { from, to: move.to, mover, victim, victimSq });
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
    await runDrafts(side, victim ? E.KO[moverType] : null);
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

    // 상대가 둔 직후 훅 (증강 소유자 기준)
    await fire('onOppMoved', opp(side), { move });

    await beginTurn(G.turn);
  }

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
    Game.busy = true;
    try { await fire2(id, 'activate', side, null); }
    finally { Game.busy = false; }
    if (Game.onUpdate) Game.onUpdate('activate');
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
    if (Game.clockRemain(G.turn) <= 0) {
      G.clock[G.turn] = 0;
      G.result = { winner: opp(G.turn), reason: '시간 초과' };
      pushLog(`${G.turn === 'w' ? '백' : '흑'} 시간 초과 — ${G.turn === 'w' ? '흑' : '백'} 승리`);
      return true;
    }
    return false;
  };

  // 모달이 열려 있는 동안 시계를 멈춘다
  Game.pauseClock = function () {
    if (Game.clockPaused || !Game.G || !Game.G.clock) return;
    Game.chargeClockSilently();
    Game.clockPaused = true;
  };
  Game.resumeClock = function () {
    if (!Game.clockPaused) return;
    Game.clockPaused = false;
    turnStartedAt = performance.now();
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
    return Game.mode === 'ai' ? opp(Game.aiSide) : Game.G.turn;
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
    if (opts && opts.difficulty) Game.difficulty = opts.difficulty;
    if (opts && opts.timeControl !== undefined) Game.timeControl = opts.timeControl;
    const tc = Game.timeControl;
    Game.G.clock = tc ? { w: tc.base, b: tc.base, inc: tc.inc, limit: tc.base } : null;
    Game.clockPaused = false;
    Game.startClockTurn();
    Game.lastMove = null;
    Game.busy = false;
    global.ensureAugImpls();
    pushLog(Game.mode === 'ai'
      ? `게임 시작 — AI 대전 (난이도: ${global.AI.LEVELS[Game.difficulty].label}). 처치 카운트 1 · 3 · 6 · 11 에서 증강을 획득합니다.`
      : '게임 시작 — 2인 대전. 처치 카운트 1 · 3 · 6 · 11 에서 증강을 획득합니다.');
    if (Game.onUpdate) Game.onUpdate('start');
    maybeAI();
  };
})(window);
