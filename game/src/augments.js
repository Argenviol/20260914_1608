/* ============================================================
   무제체스 - 증강 구현 (73종)

   훅
     onGain(G, side, api)          증강 획득 즉시
     onCapture(G, side, api, ctx)  처치 발생 시  ctx={to, mover, victim, victimSq}
     onAfterMove(G, side, api, ctx) 이동 완료 후 ctx={move, mover}
     onTurnStart(G, side, api)     자신의 턴 시작
     onOppMoved(G, side, api, ctx) 상대가 한 수 둔 직후
     onCheck(G, side, api, ctx)    아군 킹이 체크당함 ctx={checkerSq}
     onSched(G, side, api, e)      예약 효과 발동
     onExpire(G, side, api, e)     지속 효과 만료
     canActivate(G, side)/activate 횟수제한 수동 발동
   ============================================================ */
(function (global) {
  'use strict';
  const E = global.Engine;
  const A = {};                       // 구현 레지스트리
  global.AugImpl = A;

  /* ───────── 공용 헬퍼 ───────── */
  const opp = E.other;
  const val = (t) => E.VALUE[t];
  const rc = E.rc, idx = E.idx, ok = E.onBoard;

  function sched(G, side, tag, fireAt, data) {
    return E.addEff(G, Object.assign({ kind: 'sched', owner: side, tag, fireAt }, data || {}));
  }
  function untarget(G, side, ids, until) {
    return E.addEff(G, { kind: 'untargetable', owner: side, ids: ids.filter(Boolean), until });
  }
  function adj(i, includeDiag) {
    const [r, c] = rc(i), out = [];
    const dirs = includeDiag === false ? E.DIR_R : E.DIR_Q;
    for (const [dr, dc] of dirs) { const rr = r + dr, cc = c + dc; if (ok(rr, cc)) out.push(idx(rr, cc)); }
    return out;
  }
  function within(i, j, d) {
    const [r1, c1] = rc(i), [r2, c2] = rc(j);
    return Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2)) <= d;
  }
  function ownSquares(G, side, type) { return E.piecesOf(G, side, type); }
  function homeRanks(side) { return side === 'w' ? [7, 6] : [0, 1]; }
  function emptyHome(G, side) {
    const out = [];
    for (const r of homeRanks(side)) for (let c = 0; c < 8; c++) if (!G.bd[idx(r, c)]) out.push(idx(r, c));
    return out;
  }
  // 광역 제거 (킹 제외)
  function wipe(G, squares, by) {
    let n = 0;
    for (const s of squares) if (G.bd[s] && G.bd[s].type !== 'k') { if (E.removePiece(G, s, { by })) n++; }
    return n;
  }

  const def = (id, impl) => { A[id] = impl; };

  /* ══════════════════════════ 폰 ══════════════════════════ */

  def('P1a', {
    async onGain(G, side, api) {
      const sq = await api.pickSquare('지정불가로 만들 아군 폰을 고르세요', ownSquares(G, side, 'p'));
      if (sq == null) return;
      untarget(G, side, [G.bd[sq].id], E.untilOppTurns(G, 1));
      api.msg(`${E.sqName(sq)} 폰이 지정불가 상태가 되었습니다.`);
    }
  });

  def('P1b', { async onGain(G, side) { G.flags[side].P1b = (G.flags[side].P1b || 0) + 1; } });

  def('P1c', {
    async onCapture(G, side, api, ctx) {
      if (ctx.mover.type !== 'p') return;
      const foes = ownSquares(G, opp(side), 'p');
      if (!foes.length) return;
      let best = foes[0], bd = 99;
      for (const f of foes) {
        const [r1, c1] = rc(ctx.to), [r2, c2] = rc(f);
        const d = Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2));
        if (d < bd) { bd = d; best = f; }
      }
      const until = E.untilOppTurns(G, 1);
      E.phaseOut(G, ctx.to, until);
      E.phaseOut(G, best, until);
      api.msg('P1c — 처치한 폰과 가장 가까운 상대 폰이 함께 포영되었습니다.');
    }
  });

  def('P3a', {
    async onGain(G, side) {
      E.addEff(G, { kind: 'pawnKillDouble', owner: side, until: E.untilMyTurns(G, 2) });
    }
  });

  def('P3b', {});   // 패시브 (engine.genPawn)
  def('P6a', {});
  def('P6b', {});
  def('P11a', {});
  def('P11c', {});

  def('P3c', {
    async onCapture(G, side, api, ctx) {
      if (ctx.mover.type !== 'p' || G.bd[ctx.from]) return;
      const yes = await api.confirm(`P3c — ${E.sqName(ctx.to)} 폰을 원래 자리(${E.sqName(ctx.from)})로 되돌릴까요?`);
      if (!yes) return;
      G.bd[ctx.from] = G.bd[ctx.to];
      G.bd[ctx.to] = null;
    }
  });

  def('P6c', {
    async onCapture(G, side, api, ctx) {
      if (ctx.mover.type !== 'p') return;
      const dir = side === 'w' ? -1 : 1;
      const [r0, c0] = rc(ctx.to);
      const cands = [];
      for (let k = 1; k <= 2; k++) for (let dc = -2; dc <= 2; dc++) {
        const r = r0 + dir * k, c = c0 + dc;
        if (!ok(r, c) || Math.abs(dc) > k) continue;
        const p = G.bd[idx(r, c)];
        if (p && p.color !== side && p.type !== 'k') cands.push(idx(r, c));
      }
      if (!cands.length) return;
      const sq = await api.pickSquare('P6c — 교환할 전방 2칸 이내의 상대 기물을 고르세요', cands, true);
      if (sq == null) return;
      const foe = G.bd[sq];
      const higher = val(foe.type) > val('p');
      if (!E.swapPieces(G, ctx.to, sq)) { api.msg('P6c — 교환 시 체크가 발생해 취소되었습니다.'); return; }
      if (higher) { E.mutate(G, ctx.to, 'p'); api.msg('P6c — 교환 후 상대 기물이 폰으로 변이했습니다.'); }
      else api.msg('P6c — 교환했습니다.');
    }
  });

  def('P11b', {
    async onGain(G, side, api) {
      const sq = await api.pickSquare('퀸으로 바꿀 아군 폰을 고르세요 (3턴 후 제거됩니다)', ownSquares(G, side, 'p'));
      if (sq == null) return;
      const pid = G.bd[sq].id;
      E.mutate(G, sq, 'q');
      E.addEff(G, { kind: 'tempQueen', owner: side, ids: [pid], expTag: 'P11b', until: E.untilMyTurns(G, 3), dieWithPiece: true });
      api.msg('P11b — 폰이 3턴 동안 퀸이 됩니다.');
    },
    onExpire(G, side, api, e) {
      for (let i = 0; i < 64; i++) if (G.bd[i] && e.ids && e.ids.includes(G.bd[i].id)) {
        E.removePiece(G, i, { force: true });
        api.msg('P11b — 임시 퀸이 제거되었습니다.');
      }
    }
  });

  /* ══════════════════════════ 룩 ══════════════════════════ */

  def('R1a', {}); def('R11a', {}); def('R3c', {}); def('R11c', {});

  def('R1b', {
    async onGain(G, side, api) {
      const rooks = ownSquares(G, side, 'r');
      if (!rooks.length) { api.msg('R1b — 아군 룩이 없어 발동하지 못했습니다.'); return; }
      const from = rooks.length === 1 ? rooks[0]
        : await api.pickSquare('기준이 될 아군 룩을 고르세요', rooks);
      if (from == null) return;
      const dir = await api.pickOption('제거할 방향을 고르세요', [
        { label: '가로 (같은 랭크)', value: 'row' },
        { label: '세로 (같은 파일)', value: 'col' },
      ]);
      if (!dir) return;
      const [r0, c0] = rc(from), targets = [];
      for (let k = 1; k <= 4; k++) for (const s of [-1, 1]) {
        const r = dir === 'col' ? r0 + s * k : r0;
        const c = dir === 'row' ? c0 + s * k : c0;
        if (ok(r, c)) targets.push(idx(r, c));
      }
      const n = wipe(G, targets.filter(t => t !== from), side);
      api.msg(`R1b — ${dir === 'row' ? '가로' : '세로'} 4칸 이내 기물 ${n}개를 제거했습니다. (아군 포함, 킹 제외)`);
    }
  });

  def('R1c', {
    async onCapture(G, side, api, ctx) {
      if (ctx.mover.type !== 'r') return;
      const foes = E.piecesOf(G, opp(side)).filter(i => G.bd[i].type !== 'k');
      const sq = await api.pickSquare('R1c — 함께 지정불가로 만들 상대 기물을 고르세요', foes, true);
      const ids = [ctx.mover.id];
      if (sq != null) ids.push(G.bd[sq].id);
      untarget(G, side, ids, E.untilMyTurns(G, 2));
      api.msg('R1c — 2턴 동안 지정불가 상태가 되었습니다.');
    }
  });

  def('R3a', {
    async onGain(G, side, api) {
      const sq = await api.pickSquare('룩처럼 움직일 아군 폰을 고르세요 (1회, 처치 불가)', ownSquares(G, side, 'p'));
      if (sq == null) return;
      G.flags[side].R3a = { id: G.bd[sq].id };
      api.msg('R3a — 지정한 폰이 다음 1회 룩처럼 움직입니다.');
    }
  });

  def('R3b', {
    async onCapture(G, side, api, ctx) {
      if (ctx.mover.type !== 'r') return;
      const t = ctx.victim.type;
      if (t === 'k') return;
      const until = E.untilMyTurns(G, 2);
      const list = ownSquares(G, opp(side), t);
      let n = 0;
      for (const s of list) if (E.phaseOut(G, s, until)) n++;
      if (n) api.msg(`R3b — 상대 ${E.KO[t]} ${n}개가 2턴 동안 포영되었습니다.`);
    }
  });

  function rookLine(dirName) {
    return {
      async onGain(G, side, api) {
        const foe = opp(side);
        const rooks = ownSquares(G, foe, 'r');
        if (!rooks.length) { api.msg('상대에게 룩이 없어 효과가 없습니다.'); return; }
        // 상대가 기준 룩을 고른다 → 가장 제한이 약한 룩을 자동 선택
        const upIsMinus = foe === 'w';
        let ref = rooks[0];
        for (const r of rooks) {
          const a = r >> 3, b = ref >> 3;
          const better = dirName === 'up' ? (upIsMinus ? a < b : a > b) : (upIsMinus ? a > b : a < b);
          if (better) ref = r;
        }
        E.addEff(G, {
          kind: 'rookLine', owner: side, target: foe, dir: dirName,
          refSq: ref, until: E.untilOppTurns(G, 1),
        });
        api.msg(`상대는 ${E.sqName(ref)} 룩보다 ${dirName === 'up' ? '위' : '아래'}로 움직일 수 없습니다. (체크 회피 제외)`);
      }
    };
  }
  def('R6a', rookLine('up'));
  def('R6b', rookLine('down'));

  def('R6c', {
    async onGain(G, side, api) {
      const rooks = ownSquares(G, side, 'r'), pawns = ownSquares(G, opp(side), 'p');
      if (!rooks.length || !pawns.length) { api.msg('R6c — 교환할 대상이 없습니다.'); return; }
      const a = await api.pickSquare('교환할 아군 룩을 고르세요', rooks);
      if (a == null) return;
      const b = await api.pickSquare('교환할 상대 폰을 고르세요', pawns);
      if (b == null) return;
      api.msg(E.swapPieces(G, a, b) ? 'R6c — 교환했습니다.' : 'R6c — 체크가 발생해 교환할 수 없습니다.');
    }
  });

  def('R11b', {
    async onGain(G, side, api) {
      const cands = E.piecesOf(G, side).filter(i => !G.bd[i].moved && G.bd[i].type !== 'k' && G.bd[i].type !== 'r');
      if (!cands.length) { api.msg('R11b — 한 번도 움직이지 않은 기물이 없습니다.'); return; }
      const sq = await api.pickSquare('룩으로 만들 아군 기물을 고르세요 (한 번도 움직이지 않은 기물)', cands);
      if (sq == null) return;
      E.mutate(G, sq, 'r');
      api.msg('R11b — 룩이 되었습니다.');
    }
  });

  /* ═════════════════════════ 나이트 ═════════════════════════ */

  def('N11b', {});

  def('N1a', {
    async onGain(G, side, api) {
      const ns = ownSquares(G, side, 'n');
      if (!ns.length) { api.msg('아군 나이트가 없습니다.'); return; }
      const sq = await api.pickSquare('지정불가로 만들 아군 나이트를 고르세요', ns);
      if (sq == null) return;
      untarget(G, side, [G.bd[sq].id], E.untilOppTurns(G, 1));
      api.msg('N1a — 나이트가 지정불가 상태가 되었습니다.');
    }
  });

  def('N1b', {
    async onCapture(G, side, api, ctx) {
      if (ctx.mover.type !== 'n') return;
      const bs = ownSquares(G, side, 'b');
      if (!bs.length) return;
      const sq = await api.pickSquare('N1b — 위치를 교환할 아군 비숍을 고르세요', bs, true);
      if (sq == null) return;
      const pa = G.bd[ctx.to], pb = G.bd[sq];
      G.bd[ctx.to] = pb; G.bd[sq] = pa;
      if (E.inCheck(G, side)) { G.bd[ctx.to] = pa; G.bd[sq] = pb; api.msg('N1b — 체크가 발생해 취소되었습니다.'); return; }
      api.msg('N1b — 나이트와 비숍의 위치를 교환했습니다.');
    }
  });

  def('N1c', {
    async onGain(G, side) { G.flags[side].N1c = 1; },
    async onCapture(G, side, api, ctx) {
      // 이 증강을 열어 준 바로 그 처치에는 걸리지 않는다. 다음 처치부터다.
      if (ctx.regrant) return;
      if (ctx.mover.type !== 'n') return;
      if (!(G.flags[side].N1c > 0)) return;
      const n = wipe(G, adj(ctx.to), side);
      // 주변이 비어 있었으면 쓴 것으로 치지 않는다 — 허공에 날리면 억울하다
      if (!n) { api.msg('N1c — 나이트 주변에 제거할 기물이 없었습니다. (아직 1회 남음)'); return; }
      G.flags[side].N1c--;
      api.msg(`N1c — 나이트 주변 기물 ${n}개를 제거했습니다. (아군 포함, 킹 제외 · 남은 횟수 0)`);
    }
  });

  def('N3a', {
    async onGain(G, side) { G.flags[side].N3a = (G.flags[side].N3a || 0) + 2; },
    canActivate(G, side) {
      if (!(G.flags[side].N3a > 0)) return false;
      return ownSquares(G, side, 'n').some(i => adj(i, false).some(j => {
        const p = G.bd[j]; return p && p.color === side && p.type === 'p';
      }));
    },
    async activate(G, side, api) {
      const ns = ownSquares(G, side, 'n').filter(i => adj(i, false).some(j => {
        const p = G.bd[j]; return p && p.color === side && p.type === 'p';
      }));
      const nsq = await api.pickSquare('위치를 바꿀 아군 나이트를 고르세요', ns);
      if (nsq == null) return false;
      const pawns = adj(nsq, false).filter(j => { const p = G.bd[j]; return p && p.color === side && p.type === 'p'; });
      const psq = await api.pickSquare('교환할 인접 아군 폰을 고르세요', pawns);
      if (psq == null) return false;
      const a = G.bd[nsq], b = G.bd[psq];
      G.bd[nsq] = b; G.bd[psq] = a;
      if (E.inCheck(G, side)) { G.bd[nsq] = a; G.bd[psq] = b; api.msg('체크가 발생해 취소되었습니다.'); return false; }
      G.flags[side].N3a--;
      api.msg(`N3a — 나이트와 폰의 위치를 바꿨습니다. (남은 횟수 ${G.flags[side].N3a})`);
      return true;
    }
  });

  def('N3b', {
    async onGain(G, side, api) {
      // 양쪽이 한 턴씩. 예전에는 '내 2턴' 기준이라 상대 2턴 + 내 1턴으로 양쪽이 안 맞았다.
      E.addEff(G, { kind: 'knightOnly', owner: side, until: E.untilEachTurns(G, 1) });
      api.msg('N3b — 양쪽이 한 턴씩 나이트만 움직일 수 있습니다. (나이트가 없거나 체크 상태면 예외)');
    }
  });

  def('N3c', {
    async onGain(G, side, api) {
      const cands = ownSquares(G, side, 'n').filter(i => {
        const [r, c] = rc(i);
        if (!ok(r, c - 1) || !ok(r, c + 1)) return false;
        const L = G.bd[idx(r, c - 1)], R = G.bd[idx(r, c + 1)];
        return L && R && L.color !== side && R.color !== side &&
          L.type !== 'k' && R.type !== 'k' && val(L.type) > 3 && val(R.type) > 3;
      });
      if (!cands.length) { api.msg('N3c — 조건을 만족하는 나이트가 없습니다. (좌우 모두 나이트보다 높은 점수의 적 기물)'); return; }
      const sq = await api.pickSquare('변이시킬 아군 나이트를 고르세요', cands);
      if (sq == null) return;
      const [r, c] = rc(sq);
      const L = G.bd[idx(r, c - 1)], R = G.bd[idx(r, c + 1)];
      const t = val(L.type) <= val(R.type) ? L.type : R.type;
      E.mutate(G, sq, t);
      api.msg(`N3c — 나이트가 ${E.KO[t]}(으)로 변이했습니다.`);
    }
  });

  def('N6a', {
    async onAfterMove(G, side, api, ctx) {
      if (ctx.mover.type !== 'n') return;
      // 경로 계산은 엔진의 leapPath 하나로 모았다.
      // 여기서 따로 세던 시절에는 N11b(범위 2배)를 만나면 엉뚱한 칸을 집었다.
      const path = E.leapPath(ctx.move.from, ctx.move.to);
      const until = E.untilMyTurns(G, 2);
      let n = 0;
      for (const s of path) if (s !== ctx.move.to && G.bd[s] && E.phaseOut(G, s, until)) n++;
      if (n) api.msg(`N6a — 나이트가 밟고 간 기물 ${n}개가 2턴 동안 포영되었습니다.`);
    }
  });

  def('N6b', {
    async onTurnStart(G, side, api) {
      const mine = ownSquares(G, side, 'n'), foes = ownSquares(G, opp(side), 'n');
      const hits = [];
      for (const m of mine) for (const f of foes) {
        const [r1, c1] = rc(m), [r2, c2] = rc(f);
        if (Math.abs(r1 - r2) >= 5 && Math.abs(c1 - c2) >= 5 && !E.untouchable(G, G.bd[f].id)) hits.push(f);
      }
      const uniq = [...new Set(hits)];
      if (!uniq.length) return;
      const sq = uniq.length === 1 ? uniq[0]
        : await api.pickSquare('N6b — 처치할 상대 나이트를 고르세요 (가로·세로 5칸 이상)', uniq);
      if (sq == null) return;
      const v = G.bd[sq];
      G.bd[sq] = null; G.grave[v.color].push(v.type);
      E.addKill(G, side, 1, v);
      api.msg(`N6b — ${E.sqName(sq)} 상대 나이트를 처치했습니다.`);
    }
  });

  def('N6c', {
    async onGain(G, side, api) {
      const ns = ownSquares(G, side, 'n');
      if (!ns.length) { api.msg('아군 나이트가 없습니다.'); return; }
      const foes = E.piecesOf(G, opp(side)).filter(i => !'kq'.includes(G.bd[i].type));
      if (!foes.length) { api.msg('대상이 없습니다.'); return; }
      const lowest = Math.min(...foes.map(i => val(G.bd[i].type)));
      const targets = foes.filter(i => val(G.bd[i].type) === lowest);
      const nsq = ns.length === 1 ? ns[0] : await api.pickSquare('이동할 아군 나이트를 고르세요', ns);
      if (nsq == null) return;
      const tsq = targets.length === 1 ? targets[0]
        : await api.pickSquare('제거할 상대의 최저 점수 기물을 고르세요', targets);
      if (tsq == null) return;
      E.removePiece(G, tsq, { by: side, force: true });
      G.bd[tsq] = G.bd[nsq]; G.bd[nsq] = null;
      api.msg(`N6c — ${E.sqName(tsq)}의 기물을 제거하고 나이트가 이동했습니다.`);
    }
  });

  def('N11a', {
    async onGain(G, side, api) {
      if (E.augCountFor(G, side, '나이트') < 2) { api.msg('N11a — 나이트를 2회 이상 강화하지 않아 발동하지 않았습니다.'); return; }
      const ids = [];
      for (let k = 0; k < 2; k++) {
        const empties = [];
        for (let i = 0; i < 64; i++) if (!G.bd[i]) empties.push(i);
        const sq = await api.pickSquare(`소환할 위치를 고르세요 (${k + 1}/2)`, empties);
        if (sq == null) break;
        const p = E.mkPiece('n', side);
        p.moved = true;
        G.bd[sq] = p; ids.push(p.id);
      }
      if (ids.length) {
        untarget(G, side, ids, E.untilOppTurns(G, 1));
        api.msg(`N11a — 나이트 ${ids.length}개를 소환했습니다. (1턴 지정불가)`);
      }
    }
  });

  def('N11c', {
    async onGain(G, side, api) {
      const ns = ownSquares(G, side, 'n'), q = ownSquares(G, opp(side), 'q');
      if (!ns.length || !q.length) { api.msg('N11c — 아군 나이트 또는 상대 퀸이 없어 발동하지 않았습니다.'); return; }
      const nsq = ns.length === 1 ? ns[0] : await api.pickSquare('희생할 아군 나이트를 고르세요', ns);
      if (nsq == null) return;
      E.removePiece(G, nsq, { force: true });
      E.removePiece(G, q[0], { by: side, force: true });
      api.msg('N11c — 아군 나이트와 상대 퀸이 함께 제거되었습니다.');
    }
  });

  /* ══════════════════════════ 비숍 (비밀) ══════════════════════════ */

  def('B1a', {
    async onGain(G, side) { G.flags[side].B1a = 1; },
    async onTurnStart(G, side, api) {
      if (!G.flags[side].B1a) return;
      const mid = [3, 4];   // 4~5랭크
      const mine = [], foes = [];
      for (const r of mid) for (let c = 0; c < 8; c++) {
        const p = G.bd[idx(r, c)];
        if (p && p.type === 'p') (p.color === side ? mine : foes).push(idx(r, c));
      }
      if (!mine.length || !foes.length) return;
      const a = await api.pickSquare('B1a — 교환할 내 폰을 고르세요 (4~5랭크)', mine, true);
      if (a == null) return;
      const b = await api.pickSquare('B1a — 교환할 상대 폰을 고르세요', foes, true);
      if (b == null) return;
      G.flags[side].B1a = 0;
      api.reveal('B1a');
      api.msg(E.swapPieces(G, a, b) ? 'B1a — 폰을 교환했습니다.' : 'B1a — 체크가 발생해 교환하지 못했습니다.');
    }
  });

  def('B1b', {
    async onGain(G, side, api) {
      const bs = ownSquares(G, side, 'b');
      if (!bs.length) { api.msg('아군 비숍이 없습니다.'); return; }
      E.addEff(G, {
        kind: 'bishopRoot', owner: side, ids: bs.map(i => G.bd[i].id),
        until: E.untilMyTurns(G, 2),
      });
      api.msg('B1b — 2턴 동안 비숍이 움직이지 못하며, 같은 색 칸의 인접 적 기물을 제거합니다.');
    },
    async onOppMoved(G, side, api) {
      if (!E.effs(G, 'bishopRoot', side).length) return;
      let n = 0;
      for (const i of ownSquares(G, side, 'b')) {
        const light = E.lightSquare(i);
        for (const j of adj(i)) {
          const p = G.bd[j];
          if (p && p.color !== side && p.type !== 'k' && E.lightSquare(j) === light) {
            if (E.removePiece(G, j, { by: side })) n++;
          }
        }
      }
      if (n) { api.reveal('B1b'); api.msg(`B1b — 비숍이 인접한 적 기물 ${n}개를 제거했습니다.`); }
    }
  });

  def('B1c', {
    async onGain(G, side, api) {
      const pawns = ownSquares(G, opp(side), 'p');
      if (!pawns.length) { api.msg('상대 폰이 없습니다.'); return; }
      const sq = await api.pickSquare('2턴 동안 움직이지 않으면 제거될 상대 폰을 고르세요', pawns, false, true);
      if (sq == null) return;
      sched(G, side, 'B1c', E.untilOppTurns(G, 2), { watchId: G.bd[sq].id, watchSq: sq });
    },
    async onSched(G, side, api, e) {
      for (let i = 0; i < 64; i++) {
        const p = G.bd[i];
        if (p && p.id === e.watchId && i === e.watchSq) {
          E.removePiece(G, i, { by: side });
          api.reveal('B1c');
          api.msg(`B1c — 2턴 동안 움직이지 않은 ${E.sqName(i)} 폰을 제거했습니다.`);
          return;
        }
      }
    }
  });

  function parityPawn(parityIsOdd, id) {
    return {
      async onGain(G, side) { sched(G, side, id, E.untilMyTurns(G, 1), {}); },
      async onSched(G, side, api) {
        const s = E.materialScore(G, side);
        const isOdd = s % 2 === 1;
        if (isOdd !== parityIsOdd) { api.msg(`${id} — 기물점수 합 ${s} (조건 불일치, 발동하지 않음)`); return; }
        const empties = emptyHome(G, side);
        if (!empties.length) { api.msg(`${id} — 아군 진영에 빈칸이 없습니다.`); return; }
        const sq = await api.pickSquare(`${id} — 폰을 소환할 아군 진영 빈칸을 고르세요 (기물점수 합 ${s})`, empties);
        if (sq == null) return;
        const p = E.mkPiece('p', side); p.moved = true;
        G.bd[sq] = p;
        api.reveal(id);
        api.msg(`${id} — 기물점수 합이 ${parityIsOdd ? '홀' : '짝'}수(${s})라 폰을 소환했습니다.`);
      }
    };
  }
  def('B3a', parityPawn(true, 'B3a'));
  def('B3b', parityPawn(false, 'B3b'));

  def('B3c', {
    // 원문은 "방금 적을 처치한 비숍이". 이 증강을 열어준 처치도 game.js 의 grantAug 가
    // 여기로 한 번 더 흘려보내 주므로, 그 비숍부터 지켜보게 된다.
    async onCapture(G, side, api, ctx) {
      if (ctx.mover.type !== 'b') return;
      sched(G, side, 'B3c', E.untilMyTurns(G, 2), { watchId: ctx.mover.id });
    },
    async onSched(G, side, api, e) {
      const alive = E.piecesOf(G, side).some(i => G.bd[i].id === e.watchId);
      if (!alive) return;
      // 스폰 칸이 막힌 종류는 고른 뒤에 '불가' 를 보여주지 않고, 처음부터 잠가서 보여준다.
      const gy = [...new Set(G.grave[side])].filter(t => t !== 'k');
      if (!gy.length) return;
      const opts = gy.map(x => {
        const free = spawnSquaresFor(side, x).filter(s => !G.bd[s]);
        const home = spawnSquaresFor(side, x).map(E.sqName).join(' · ');
        return {
          label: E.KO[x], value: x,
          desc: free.length ? `스폰 칸 ${free.map(E.sqName).join(' · ')}` : `스폰 칸(${home})이 막혀 있습니다`,
          block: free.length ? null : '스폰 칸이 비어 있지 않습니다',
        };
      });
      if (!opts.some(o => !o.block)) {
        api.msg('B3c — 부활할 기물의 스폰 칸이 모두 막혀 있습니다.');
        return;
      }
      const t = await api.pickOption('B3c — 부활시킬 아군 기물을 고르세요', opts);
      if (!t) return;
      const spawns = spawnSquaresFor(side, t).filter(s => !G.bd[s]);
      if (!spawns.length) { api.msg('B3c — 스폰 위치가 비어있지 않아 부활할 수 없습니다.'); return; }
      const sq = spawns.length === 1 ? spawns[0] : await api.pickSquare('부활 위치를 고르세요', spawns);
      if (sq == null) return;
      const p = E.mkPiece(t, side); p.moved = true;
      G.bd[sq] = p;
      G.grave[side].splice(G.grave[side].indexOf(t), 1);
      api.reveal('B3c');
      api.msg(`B3c — ${E.KO[t]}이(가) 부활했습니다.`);
    }
  });

  function spawnSquaresFor(side, t) {
    const back = side === 'w' ? 7 : 0, front = side === 'w' ? 6 : 1;
    const map = { r: [0, 7], n: [1, 6], b: [2, 5], q: [3], k: [4] };
    if (t === 'p') return [0, 1, 2, 3, 4, 5, 6, 7].map(c => idx(front, c));
    return (map[t] || []).map(c => idx(back, c));
  }

  def('B6a', {
    async onGain(G, side, api) {
      E.addEff(G, { kind: 'bishopRevenge', owner: side, until: E.untilOppTurns(G, 2) });
      api.msg('B6a — 2턴 동안 비숍을 처치한 기물도 함께 죽습니다. (킹·퀸 제외)');
    }
  });

  def('B6b', {
    async onGain(G, side, api) {
      const foes = E.piecesOf(G, opp(side)).filter(i => !'kq'.includes(G.bd[i].type));
      if (!foes.length) { api.msg('대상이 없습니다.'); return; }
      const sq = await api.pickSquare('1턴 동안 움직이지 않으면 제거될 상대 기물을 고르세요', foes, false, true);
      if (sq == null) return;
      sched(G, side, 'B6b', E.untilOppTurns(G, 1), { watchId: G.bd[sq].id, watchSq: sq });
    },
    async onSched(G, side, api, e) {
      for (let i = 0; i < 64; i++) {
        const p = G.bd[i];
        if (p && p.id === e.watchId && i === e.watchSq) {
          E.removePiece(G, i, { by: side });
          api.reveal('B6b');
          api.msg(`B6b — 움직이지 않은 ${E.sqName(i)} 기물을 제거했습니다.`);
          return;
        }
      }
    }
  });

  def('B6c', {
    async onGain(G, side) { G.flags[side].B6c = 1; },
    async onCapture(G, side, api, ctx) {
      if (ctx.mover.type !== 'b' || !G.flags[side].B6c) return;
      G.flags[side].B6c = 0;
      const n = wipe(G, adj(ctx.to), side);
      api.reveal('B6c');
      api.msg(`B6c — 처치 지점 주변 기물 ${n}개를 추가로 제거했습니다.`);
    }
  });

  def('B11a', {
    async onGain(G, side) { G.flags[side].B11a = 1; },
    async onCheck(G, side, api, ctx) {
      if (!G.flags[side].B11a || ctx.checkerSq < 0) return;
      const p = G.bd[ctx.checkerSq];
      if (!p) return;
      G.flags[side].B11a = 0;
      untarget(G, side, [p.id], E.untilOppTurns(G, 1));
      api.reveal('B11a');
      api.msg(`B11a — 체크를 건 ${E.sqName(ctx.checkerSq)} 기물이 1턴 동안 지정불가 상태가 되었습니다.`);
    }
  });

  def('B11b', {
    async onGain(G, side, api) {
      if (!ownSquares(G, side, 'q').length) {
        E.addEff(G, { kind: 'bishopAsQueen', owner: side, until: E.untilMyTurns(G, 3) });
        api.msg('B11b — 3턴 동안 비숍이 퀸처럼 움직입니다.');
      } else {
        G.flags[side].B11bArmed = 1;
        api.msg('B11b — 아군 퀸이 살아있어 대기 상태입니다. 퀸이 죽는 순간 발동합니다.');
      }
    },
    async onTurnStart(G, side, api) {
      if (!G.flags[side].B11bArmed) return;
      if (ownSquares(G, side, 'q').length) return;
      G.flags[side].B11bArmed = 0;
      E.addEff(G, { kind: 'bishopAsQueen', owner: side, until: E.untilMyTurns(G, 3) });
      api.reveal('B11b');
      api.msg('B11b — 퀸이 죽어 3턴 동안 비숍이 퀸처럼 움직입니다.');
    }
  });

  def('B11c', {
    async onGain(G, side, api) {
      const foes = E.piecesOf(G, opp(side)).filter(i => G.bd[i].type !== 'k');
      if (!foes.length) { api.msg('대상이 없습니다.'); return; }
      const sq = await api.pickSquare('2턴 동안 살아남으면 강화가 사라질 상대 기물을 고르세요', foes, false, true);
      if (sq == null) return;
      sched(G, side, 'B11c', E.untilOppTurns(G, 2), { watchId: G.bd[sq].id, watchType: G.bd[sq].type });
    },
    async onSched(G, side, api, e) {
      const alive = E.piecesOf(G, opp(side)).some(i => G.bd[i].id === e.watchId);
      if (!alive) { api.msg('B11c — 지정 기물이 사라져 발동하지 않았습니다.'); return; }
      const ko = E.KO[e.watchType];
      const lost = G.augs[opp(side)].filter(id => global.AUG_BY_ID[id].piece === ko);
      G.augs[opp(side)] = G.augs[opp(side)].filter(id => global.AUG_BY_ID[id].piece !== ko);
      api.reveal('B11c');
      api.msg(`B11c — 상대의 ${ko} 강화 ${lost.length}개가 사라졌습니다.`);
    }
  });

  /* ══════════════════════════ 퀸 ══════════════════════════ */

  def('Q6b', {}); def('Q11c', {}); def('Q3c', {});

  def('Q1a', {
    async onAfterMove(G, side, api, ctx) {
      if (ctx.mover.type !== 'q') return;
      const [r, c] = rc(ctx.move.to);
      G.flags[side].Q1aReady = (r === c || r + c === 7) ? ctx.move.to : undefined;
      if (G.flags[side].Q1aReady !== undefined) api.msg('Q1a — 다음 턴에 긴 대각선 위 빈칸으로 순간이동할 수 있습니다.');
    }
  });

  def('Q1b', {
    async onGain(G, side, api) {
      const ids = [];
      for (const s of ownSquares(G, side, 'q')) ids.push(G.bd[s].id);
      for (const s of ownSquares(G, opp(side), 'q')) ids.push(G.bd[s].id);
      if (!ids.length) { api.msg('퀸이 없습니다.'); return; }
      untarget(G, side, ids, E.untilMyTurns(G, 5));
      api.msg('Q1b — 5턴 동안 양쪽 퀸이 지정불가 상태입니다.');
    }
  });

  def('Q1c', {
    async onGain(G, side, api) {
      const a = ownSquares(G, side, 'q'), b = ownSquares(G, opp(side), 'q');
      if (!a.length || !b.length) { api.msg('Q1c — 양쪽 퀸이 모두 살아있지 않아 발동하지 않았습니다.'); return; }
      E.removePiece(G, a[0], { force: true });
      E.removePiece(G, b[0], { by: side, force: true });
      api.msg('Q1c — 양쪽 퀸이 함께 제거되었습니다.');
    }
  });

  def('Q3a', {
    async onGain(G, side, api) {
      const n = G.augs.w.length + G.augs.b.length;
      G.augs.w = []; G.augs.b = [];
      G.eff = G.eff.filter(e => e.kind === 'sched' ? false : false);
      G.flags.w = {}; G.flags.b = {};
      api.msg(`Q3a — 양측의 모든 강화 ${n}개가 사라졌습니다. (이 강화 자신 포함)`);
    }
  });

  def('Q3b', {
    /* 예전에는 '충전' 을 주고 다음 내 차례에 눌러 쓰게 했다.
       그러면 증강을 고른 뒤 상대 턴이 한 번 끼어서, 정작 지키려던 퀸이 그 사이에 잡혔다.
       다른 포영 증강처럼 증강을 얻는 그 턴에 바로 걸리게 한다. */
    async onGain(G, side, api) {
      const q = ownSquares(G, side, 'q')[0];
      if (q === undefined) { api.msg('아군 퀸이 없습니다.'); return; }
      E.phaseOut(G, q, E.untilOppTurns(G, 1));
      api.msg('Q3b — 아군 퀸이 다음 상대턴 동안 포영되었습니다.');
    }
  });

  def('Q6a', {
    async onGain(G, side, api) {
      const q = ownSquares(G, side, 'q')[0];
      if (q === undefined) { api.msg('아군 퀸이 없습니다.'); return; }
      const cands = [];
      for (let i = 0; i < 64; i++) if (G.bd[i] && i !== q && G.bd[i].type !== 'k') cands.push(i);
      const sq = await api.pickSquare('퀸과 함께 포영시킬 기물을 고르세요', cands);
      const until = E.untilOppTurns(G, 1);
      E.phaseOut(G, q, until);
      if (sq != null) E.phaseOut(G, sq, until);
      api.msg('Q6a — 포영되었습니다.');
    }
  });

  def('Q6c', {
    async onGain(G, side, api) {
      const q = ownSquares(G, side, 'q')[0];
      if (q === undefined) { api.msg('아군 퀸이 없습니다.'); return; }
      const foes = E.piecesOf(G, opp(side)).filter(i => G.bd[i].type !== 'k');
      if (!foes.length) { api.msg('대상이 없습니다.'); return; }
      const hi = Math.max(...foes.map(i => val(G.bd[i].type)));
      const tops = foes.filter(i => val(G.bd[i].type) === hi);
      const t = tops.length === 1 ? tops[0] : await api.pickSquare('교환할 상대 기물을 고르세요', tops);
      if (t == null) return;
      api.msg(E.swapPieces(G, q, t) ? 'Q6c — 퀸이 상대 최고 점수 기물과 교환되었습니다.' : 'Q6c — 체크가 발생해 교환할 수 없습니다.');
    }
  });

  def('Q11a', {
    async onGain(G, side, api) {
      const q = ownSquares(G, side, 'q')[0];
      if (q === undefined) { api.msg('아군 퀸이 없습니다.'); return; }
      const types = new Set();
      for (const j of adj(q)) if (G.bd[j] && G.bd[j].type !== 'k') types.add(G.bd[j].type);
      const targets = [];
      for (let i = 0; i < 64; i++) if (G.bd[i] && G.bd[i].type !== 'k' && types.has(G.bd[i].type)) targets.push(i);
      const n = wipe(G, targets, side);
      E.removePiece(G, q, { force: true });
      api.msg(`Q11a — 인접 기물과 같은 종류의 기물 ${n}개를 제거하고 퀸도 함께 제거되었습니다.`);
    }
  });

  def('Q11b', {
    async onGain(G, side, api) {
      const q = ownSquares(G, side, 'q')[0];
      if (q === undefined) { api.msg('아군 퀸이 없습니다.'); return; }
      const until = E.untilMyTurns(G, 2);
      E.phaseOut(G, q, until);
      E.addEff(G, { kind: 'queenNova', owner: side, sq: q, until });
      api.msg('Q11b — 퀸이 2턴 동안 포영되며 주변 2칸의 적 기물을 제거합니다.');
    },
    tick(G, side, api) {
      for (const e of E.effs(G, 'queenNova', side)) {
        let n = 0;
        for (let i = 0; i < 64; i++) {
          const p = G.bd[i];
          if (p && p.color !== side && p.type !== 'k' && within(i, e.sq, 2)) {
            if (E.removePiece(G, i, { by: side })) n++;
          }
        }
        if (n) api.msg(`Q11b — 포영 지점 2칸 이내 적 기물 ${n}개를 제거했습니다.`);
      }
    }
  });

  /* ══════════════════════════ 킹 ══════════════════════════ */

  def('K1c', {}); def('K11b', {});

  def('K1a', {
    async onGain(G, side) { G.flags[side].K1a = 1; },
    async onCheck(G, side, api) {
      if (!G.flags[side].K1a) return;
      const k = E.findKing(G, side), q = ownSquares(G, side, 'q')[0];
      if (q === undefined) return;
      const yes = await api.confirm('K1a — 체크! 킹과 퀸의 위치를 바꾸시겠습니까?');
      if (!yes) return;
      const pk = G.bd[k], pq = G.bd[q];
      G.bd[k] = pq; G.bd[q] = pk;
      if (E.inCheck(G, side)) { G.bd[k] = pk; G.bd[q] = pq; api.msg('K1a — 바꿔도 체크라 취소되었습니다.'); return; }
      G.flags[side].K1a = 0;
      api.msg('K1a — 킹과 퀸의 위치를 바꿨습니다.');
    }
  });

  def('K1b', { async onGain(G, side, api) { G.flags[side].K1b = 1; api.msg('K1b — 다음 강화에서 선택지를 2개 고릅니다.'); } });


  function grantFrom(pieces, tier, label) {
    return {
      async onGain(G, side, api) {
        const pool = global.AUGMENTS.filter(a => pieces.includes(a.piece) && a.tier === tier && !G.augs[side].includes(a.id));
        if (!pool.length) { api.msg(`${label} — 얻을 수 있는 강화가 없습니다.`); return; }
        const pick = await api.pickOption(`${label} — 추가로 얻을 강화를 고르세요`,
          pool.map(a => ({ label: `[${a.id}] ${a.piece} ${a.tier}개`, desc: a.text, value: a.id })));
        if (!pick) return;
        await api.grant(side, pick);
      }
    };
  }
  def('K3a', grantFrom(['나이트', '비숍'], 6, 'K3a'));
  def('K3c', grantFrom(['룩', '퀸'], 11, 'K3c'));

  def('K3b', {
    async onGain(G, side, api) {
      let budget = Math.abs(E.materialScore(G, side) - E.materialScore(G, opp(side)));
      if (budget <= 0) { api.msg('K3b — 점수 차이가 0이라 배치할 수 없습니다.'); return; }
      const k = E.findKing(G, side);
      const menu = [['p', 1], ['n', 3], ['b', 3], ['r', 5], ['q', 9]];
      api.msg(`K3b — 배치 예산 ${budget}점. 킹 상하좌우 빈칸에 배치합니다.`);
      while (budget > 0) {
        const slots = adj(k, false).filter(s => !G.bd[s]);
        if (!slots.length) break;
        const opts = menu.filter(([, v]) => v <= budget)
          .map(([t, v]) => ({ label: `${E.KO[t]} (${v}점)`, value: t }));
        if (!opts.length) break;
        opts.push({ label: '배치 종료', value: null });
        const t = await api.pickOption(`배치할 기물을 고르세요 (남은 예산 ${budget})`, opts);
        if (!t) break;
        const sq = await api.pickSquare('배치할 칸을 고르세요', slots);
        if (sq == null) break;
        const p = E.mkPiece(t, side); p.moved = true;
        G.bd[sq] = p;
        budget -= menu.find(m => m[0] === t)[1];
      }
      api.msg('K3b — 배치를 마쳤습니다.');
    }
  });

  def('K6a', {
    async onGain(G, side, api) { G.flags[side].K6a = 1; api.msg('K6a — 다음 1회, 다른 기물을 움직인 뒤 킹도 한 번 더 움직일 수 있습니다.'); }
  });

  def('K6b', {
    async onGain(G, side, api) {
      const eligible = global.PIECES_KO.filter(p => E.augCountFor(G, side, p) >= 2);
      if (!eligible.length) { api.msg('K6b — 2회 이상 강화한 기물이 없습니다.'); return; }
      const ko = eligible.length === 1 ? eligible[0]
        : await api.pickOption('K6b — 추가 강화를 받을 기물을 고르세요', eligible.map(p => ({ label: p, value: p })));
      if (!ko) return;
      const pool = global.AUGMENTS.filter(a => a.piece === ko && a.tier === 1 && !G.augs[side].includes(a.id));
      if (!pool.length) { api.msg('K6b — 남은 1개 티어 강화가 없습니다.'); return; }
      const pick = await api.pickOption(`${ko} 1개 티어 강화를 고르세요`,
        pool.map(a => ({ label: `[${a.id}]`, desc: a.text, value: a.id })));
      if (!pick) return;
      await api.grant(side, pick);
    }
  });

  def('K6c', {
    async onGain(G, side, api) {
      const owned = G.augs[side].filter(id => id !== 'K6c');
      if (!owned.length) { api.msg('K6c — 교체할 강화가 없습니다.'); return; }
      const old = await api.pickOption('K6c — 교체할 강화를 고르세요',
        owned.map(id => {
          const a = global.AUG_BY_ID[id];
          return { label: `[${id}] ${a.piece} ${a.tier}개`, desc: a.text, value: id };
        }));
      if (!old) return;
      const oa = global.AUG_BY_ID[old];
      const pool = global.AUGMENTS.filter(a => a.piece === oa.piece && a.tier === oa.tier && !G.augs[side].includes(a.id));
      if (!pool.length) { api.msg('K6c — 같은 기물·티어에 남은 강화가 없습니다.'); return; }
      const pick = await api.pickOption('새로 받을 강화를 고르세요',
        pool.map(a => ({ label: `[${a.id}]`, desc: a.text, value: a.id })));
      if (!pick) return;
      G.augs[side] = G.augs[side].filter(x => x !== old);
      await api.grant(side, pick);
      api.msg(`K6c — [${old}] 를 [${pick}] 로 교체했습니다.`);
    }
  });

  def('K11a', {
    async onGain(G, side) { G.flags[side].K11a = (G.flags[side].K11a || 0) + 1; },
    canActivate(G, side) { return G.flags[side].K11a > 0 && ownSquares(G, side, 'p').length > 0; },
    async activate(G, side, api) {
      const sq = await api.pickSquare('K11a — 이동시킬 아군 폰을 고르세요', ownSquares(G, side, 'p'));
      if (sq == null) return false;
      const [r0, c0] = rc(sq), dests = [];
      for (const d of [-1, 1]) for (let r = r0 + d; r >= 0 && r < 8; r += d) {
        if (G.bd[idx(r, c0)]) break;
        dests.push(idx(r, c0));
      }
      if (!dests.length) { api.msg('이동할 수 있는 칸이 없습니다.'); return false; }
      const to = await api.pickSquare('이동할 위치를 고르세요 (상하, 기물을 넘을 수 없음)', dests);
      if (to == null) return false;
      G.bd[to] = G.bd[sq]; G.bd[sq] = null; G.bd[to].moved = true;
      if (E.inCheck(G, side)) { G.bd[sq] = G.bd[to]; G.bd[to] = null; api.msg('체크가 발생해 취소되었습니다.'); return false; }
      G.flags[side].K11a--;
      api.msg('K11a — 폰을 이동시켰습니다.');
      return true;
    }
  });

  def('K11c', {
    async onGain(G, side, api) {
      let n = 0;
      for (let i = 0; i < 64; i++) {
        const p = G.bd[i];
        if (p && p.type !== 'k' && p.type !== 'p') { if (E.mutate(G, i, 'p')) n++; }
      }
      api.msg(`K11c — 킹을 제외한 기물 ${n}개가 폰으로 변이했습니다.`);
    }
  });

  /* ═══════════ 지금 발동할 수 있는가 ═══════════
     드래프트에서 "고를 수는 있는데 아무 일도 안 일어나는" 증강을 막는다.
     null 을 돌려주면 선택 가능, 문자열을 돌려주면 그 이유로 잠긴다.
     기본 규칙(아래 defaultBlock)은 "해당 기물이 판에 없으면 잠금".        */

  function need(cond, why) { return cond ? null : why; }

  const BLOCK = {
    // ── 폰 ──
    P1a: (G, s) => need(ownSquares(G, s, 'p').length, '아군 폰이 없습니다'),
    P11b: (G, s) => need(ownSquares(G, s, 'p').length, '아군 폰이 없습니다'),
    // ── 룩 ──
    R3a: (G, s) => need(ownSquares(G, s, 'r').length && ownSquares(G, s, 'p').length,
      '아군 룩과 폰이 모두 있어야 합니다'),
    R6a: (G, s) => need(ownSquares(G, opp(s), 'r').length, '상대에게 룩이 없습니다'),
    R6b: (G, s) => need(ownSquares(G, opp(s), 'r').length, '상대에게 룩이 없습니다'),
    R6c: (G, s) => need(ownSquares(G, s, 'r').length && ownSquares(G, opp(s), 'p').length,
      '아군 룩과 상대 폰이 모두 있어야 합니다'),
    R11b: (G, s) => need(
      E.piecesOf(G, s).some(i => !G.bd[i].moved && !'kr'.includes(G.bd[i].type)),
      '한 번도 움직이지 않은 기물이 없습니다'),
    R11c: (G, s) => need(ownSquares(G, s, 'r').length, '아군 룩이 없습니다'),
    // ── 나이트 ──
    N1b: (G, s) => need(ownSquares(G, s, 'n').length && ownSquares(G, s, 'b').length,
      '아군 나이트와 비숍이 모두 있어야 합니다'),
    N3a: (G, s) => need(ownSquares(G, s, 'n').length && ownSquares(G, s, 'p').length,
      '아군 나이트와 폰이 모두 있어야 합니다'),
    N3c: (G, s) => need(ownSquares(G, s, 'n').some(i => {
      const [r, c] = rc(i);
      if (!ok(r, c - 1) || !ok(r, c + 1)) return false;
      const L = G.bd[idx(r, c - 1)], R = G.bd[idx(r, c + 1)];
      return L && R && L.color !== s && R.color !== s
        && L.type !== 'k' && R.type !== 'k' && val(L.type) > 3 && val(R.type) > 3;
    }), '좌우가 모두 더 높은 점수의 적 기물인 나이트가 없습니다'),
    N6b: (G, s) => need(ownSquares(G, s, 'n').length && ownSquares(G, opp(s), 'n').length,
      '양쪽에 나이트가 있어야 합니다'),
    N6c: (G, s) => need(
      ownSquares(G, s, 'n').length && E.piecesOf(G, opp(s)).some(i => !'kq'.includes(G.bd[i].type)),
      '아군 나이트와, 킹·퀸이 아닌 상대 기물이 필요합니다'),
    N11a: (G, s) => need(E.augCountFor(G, s, '나이트') >= 2, '나이트를 2회 이상 강화해야 합니다'),
    N11c: (G, s) => need(ownSquares(G, s, 'n').length && ownSquares(G, opp(s), 'q').length,
      '아군 나이트와 상대 퀸이 모두 살아있어야 합니다'),
    // ── 비숍 ──
    B1a: (G, s) => {
      if (!ownSquares(G, s, 'b').length) return '아군 비숍이 없습니다';
      return null;
    },
    B1c: (G, s) => need(ownSquares(G, opp(s), 'p').length, '상대 폰이 없습니다'),
    B6b: (G, s) => need(E.piecesOf(G, opp(s)).some(i => !'kq'.includes(G.bd[i].type)),
      '킹·퀸이 아닌 상대 기물이 없습니다'),
    B11c: (G, s) => need(E.piecesOf(G, opp(s)).some(i => G.bd[i].type !== 'k'),
      '지정할 상대 기물이 없습니다'),
    // ── 퀸 ──
    Q1b: (G, s) => need(ownSquares(G, s, 'q').length && ownSquares(G, opp(s), 'q').length,
      '양쪽 퀸이 모두 살아있어야 합니다'),
    Q1c: (G, s) => need(ownSquares(G, s, 'q').length && ownSquares(G, opp(s), 'q').length,
      '양쪽 퀸이 모두 살아있어야 합니다'),
    Q3a: () => null,                       // 강화가 없어도 '초기화'라는 효과는 성립
    Q6c: (G, s) => need(ownSquares(G, s, 'q').length
      && E.piecesOf(G, opp(s)).some(i => G.bd[i].type !== 'k'),
      '아군 퀸과 교환할 상대 기물이 필요합니다'),
    Q11c: (G, s) => need(ownSquares(G, s, 'q').length, '아군 퀸이 없습니다'),
    // ── 킹 (대부분 판 상태와 무관한 메타 증강) ──
    K1a: (G, s) => need(ownSquares(G, s, 'q').length, '아군 퀸이 없습니다'),
    K1b: () => null,
    K1c: () => null,
    K3a: (G, s) => need(
      global.AUGMENTS.some(a => ['나이트', '비숍'].includes(a.piece) && a.tier === 6 && !G.augs[s].includes(a.id)),
      '얻을 수 있는 나이트·비숍 6개 강화가 없습니다'),
    K3b: (G, s) => need(E.materialScore(G, s) !== E.materialScore(G, opp(s)),
      '양측 기물 점수가 같아 배치할 수 없습니다'),
    K3c: (G, s) => need(
      global.AUGMENTS.some(a => ['룩', '퀸'].includes(a.piece) && a.tier === 11 && !G.augs[s].includes(a.id)),
      '얻을 수 있는 룩·퀸 11개 강화가 없습니다'),
    K6a: () => null,
    K6b: (G, s) => need(global.PIECES_KO.some(p => E.augCountFor(G, s, p) >= 2),
      '같은 기물을 2회 이상 강화하지 않았습니다'),
    K6c: (G, s) => need(G.augs[s].some(id => {
      const a = global.AUG_BY_ID[id];
      return global.AUGMENTS.some(x => x.piece === a.piece && x.tier === a.tier && !G.augs[s].includes(x.id));
    }), '교체할 수 있는 강화가 없습니다'),
    K11a: (G, s) => need(ownSquares(G, s, 'p').length, '아군 폰이 없습니다'),
    K11b: () => null,
    K11c: (G, s) => need(E.piecesOf(G, 'w').concat(E.piecesOf(G, 'b'))
      .some(i => !'kp'.includes(G.bd[i].type)), '폰으로 바꿀 기물이 없습니다'),
  };

  // 받침이 있으면 '이', 없으면 '가'
  function josaIGa(word) {
    const c = word.charCodeAt(word.length - 1);
    if (c < 0xac00 || c > 0xd7a3) return '가';
    return ((c - 0xac00) % 28) ? '이' : '가';
  }

  // 기본: 그 기물이 판에 하나도 없으면 발동할 수 없다 (킹은 항상 있으므로 예외)
  function defaultBlock(G, side, a) {
    const t = E.KO2T[a.piece];
    if (!t || t === 'k') return null;
    return ownSquares(G, side, t).length
      ? null
      : `아군 ${a.piece}${josaIGa(a.piece)} 없습니다`;
  }

  // 잠금 사유를 돌려준다. null 이면 고를 수 있다.
  global.augBlockReason = function (G, side, a) {
    if (G.augs[side].includes(a.id)) return '이미 보유한 증강입니다';
    const f = BLOCK[a.id];
    if (f) { try { return f(G, side); } catch (e) { return null; } }
    return defaultBlock(G, side, a);
  };

  /* ───────── 미구현 방지: 모든 증강에 빈 구현 보장 ───────── */
  global.ensureAugImpls = function () {
    const missing = [];
    for (const a of global.AUGMENTS) if (!A[a.id]) { A[a.id] = {}; missing.push(a.id); }
    return missing;
  };
})(window);
