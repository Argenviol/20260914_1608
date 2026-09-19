/* 증강 72종 발동 감사 — 각 증강의 조건이 성립하는 판을 만들고, 훅이 실제로 무언가를 바꾸는지 본다.
   2인 대전 한 화면. 프롬프트는 전부 첫 번째 선택지로 자동 응답. 드래프트는 tierIdx 를 끝으로 밀어 막는다. */
const H = require('./harness');
(async () => {
  const browser = await H.launch();
  const P = await H.newPage(browser, 'P');
  await P.click('#h-pvp');
  await P.waitForFunction(() => Game.mode === 'pvp' && !document.body.classList.contains('athome'));

  await P.evaluate(() => {
    const E = Engine;
    window.T = {
      msgs: [],
      sq: (n) => (8 - +n[1]) * 8 + 'abcdefgh'.indexOf(n[0]),
      fen(f, opts) {
        opts = opts || {};
        const G = E.newGame();
        G.bd = new Array(64).fill(null);
        let i = 0;
        for (const ch of f) {
          if (ch === '/') continue;
          if (ch >= '1' && ch <= '8') { i += +ch; continue; }
          const color = ch === ch.toUpperCase() ? 'w' : 'b';
          const p = E.mkPiece(ch.toLowerCase(), color);
          p.moved = !!opts.moved;
          G.bd[i++] = p;
        }
        G.turn = opts.turn || 'w';
        G.tierIdx = { w: 4, b: 4 };          // 드래프트가 끼어들지 않게
        G.clock = null;
        Game.G = G; Game.mode = 'pvp'; Game.busy = false; Game.clockPaused = false;
        Game.augNotes = { w: {}, b: {} };
        T.msgs = [];
        renderAll();
        return G;
      },
      board() { return Game.G.bd.map(p => p ? p.type + p.color : '.').join(''); },
      at(n) { const p = Game.G.bd[T.sq(n)]; return p ? p.type + p.color : null; },
      async grant(side, id) { await Game.grantAug(side, id); },
      async play(from, to, promo) {
        const ms = Game.legalFor(T.sq(from)).filter(m => m.to === T.sq(to) && (!promo || m.promo === promo));
        if (!ms.length) throw new Error(from + '→' + to + ' 합법수 아님 (turn ' + Game.G.turn + ')');
        const ok = await Game.play(ms[0]);
        if (!ok) throw new Error('play 거부');
      },
      legal(from) { return Game.legalFor(T.sq(from)).map(m => 'abcdefgh'[m.to & 7] + (8 - (m.to >> 3))); },
      effs() { return Game.G.eff.map(e => e.kind); },
      flags(s) { return Game.G.flags[s]; },
      fired(id) { return Game.G.log.some(x => x.t === 'text' && x.text.indexOf('⚡ [' + id + ']') === 0); },
    };
    // 자동 응답 api
    const orig = Game.api;
    Game.api = {
      async pickSquare(prompt, squares) { T.msgs.push('pickSquare: ' + prompt); return squares && squares.length ? squares[0] : null; },
      async pickOption(prompt, options) {
        T.msgs.push('pickOption: ' + prompt);
        // 무엇이 잠겨서 왔는지도 남긴다 — '고를 수 없는 건 처음부터 잠겨 있어야 한다' 를 보려면 필요하다
        T.opts = options.map(o => ({ label: o.label, block: !!o.block }));
        const r = options.filter(o => o.value !== null && !o.block); return r.length ? r[0].value : null;
      },
      async confirm(prompt) { T.msgs.push('confirm: ' + prompt); return true; },
      async draft(o) { const p = o.offer.filter(x => !x.block); return p.length ? p[0].aug.id : null; },
      flash() { }, announce() { }, remoteFx() { },
      event(e) { T.msgs.push('event: ' + e.title); },
      msg(t) { T.msgs.push('msg: ' + t); },
      reveal: (id) => Game.revealAug(id),
      grant: (s, id) => Game.grantAug(s, id),
    };
    Game.onUpdate = () => { };
  });

  // ── 시나리오 ──  (백이 증강 주인. FEN 은 8랭크부터)
  const S = [
    // 폰
    { id: 'P1a', fen: '4k3/8/8/8/8/8/4P3/4K3', ok: 'T.effs().includes("untargetable")' },
    { id: 'P1b', fen: '4k3/8/8/8/8/8/4P3/4K3', ok: 'T.legal("e2").includes("e5")' },
    { id: 'P1c', fen: '4k3/p7/8/3p4/4P3/8/8/4K3', act: 'await T.play("e4","d5")', ok: 'Game.G.phased.length === 2' },
    { id: 'P3a', fen: '4k3/8/8/8/8/8/4P3/4K3', ok: 'T.effs().includes("pawnKillDouble")' },
    { id: 'P3b', fen: '4k3/8/8/8/4P3/8/8/4K3', ok: 'T.legal("e4").includes("e3")' },
    { id: 'P3c', fen: '4k3/8/8/3p4/4P3/8/8/4K3', act: 'await T.play("e4","d5")', ok: 'T.at("e4") === "pw" && T.at("d5") === null' },
    { id: 'P6a', fen: '4k3/8/8/8/4P3/8/8/4K3', ok: 'T.legal("e4").includes("d4") && T.legal("e4").includes("f4")' },
    { id: 'P6b', fen: '4k3/8/8/4p3/4P3/8/8/4K3', ok: 'T.legal("e4").includes("e5")' },
    { id: 'P6c', fen: '4k3/8/3r4/3p4/4P3/8/8/4K3', act: 'await T.play("e4","d5")', ok: 'T.at("d6") === "pw" && T.at("d5") === "pb"' },
    { id: 'P11a', fen: '4k3/8/8/8/4P3/8/8/4K3', ok: 'T.legal("e4").includes("e6")' },
    { id: 'P11b', fen: '4k3/8/8/8/8/8/4P3/4K3', ok: 'T.at("e2") === "qw" && T.effs().includes("tempQueen")' },
    { id: 'P11c', fen: '4k3/8/8/n7/1P6/8/8/4K3', act: 'await T.play("b4","a5","q")', ok: 'T.at("a5") === "qw"' },
    // 룩
    { id: 'R1a', fen: '4k3/8/8/8/8/8/R1p5/4K3', pre: 'Game.G.bd[T.sq("b2")] = Engine.mkPiece("p","w")', ok: 'T.legal("a2").includes("c2")' },
    { id: 'R1b', fen: '4k3/8/8/8/8/8/R1p1p3/4K3', ok: 'T.at("c2") === null && T.at("e2") === null' },
    { id: 'R1c', fen: '4k3/8/8/8/8/8/R2p4/4K3', act: 'await T.play("a2","d2")', ok: 'T.effs().includes("untargetable")' },
    /* R3c 룩은 '제거 · 포영 · 교환 · 지정불가' 에 면역이다. 지정불가만 구현이 빠져 있었다.
       R1c 는 처치한 룩과 지정한 상대 기물을 함께 지정불가로 만드는데, 그 룩이 R3c 면 룩은 빠져야 한다. */
    { id: 'R1c', fen: '4k2n/8/8/8/8/8/R2p4/4K3', act: 'await T.play("a2","d2")',
      ok: '(() => { const rid = Game.G.bd[T.sq("d2")].id; const e = Game.G.eff.filter(x => x.kind === "untargetable"); return e.length === 1 && e[0].ids.includes(rid); })()' },
    { id: 'R1c', fen: '4k2n/8/8/8/8/8/R2p4/4K3', pre: 'Game.G.augs.w.push("R3c")', act: 'await T.play("a2","d2")',
      ok: '(() => { const rid = Game.G.bd[T.sq("d2")].id; const e = Game.G.eff.filter(x => x.kind === "untargetable"); return e.length === 1 && !e[0].ids.includes(rid) && e[0].ids.length === 1; })()' },
    { id: 'R3a', fen: '4k3/8/8/8/8/8/R3P3/4K3', ok: 'T.legal("e2").includes("h2")' },
    { id: 'R3b', fen: '4k3/8/n7/8/8/8/R2n4/4K3', act: 'await T.play("a2","d2")', ok: 'Game.G.phased.length === 1 && T.at("a6") === null' },
    { id: 'R3c', fen: '4k3/8/8/8/8/8/R7/4K3', ok: 'Engine.removePiece(Game.G, T.sq("a2")) === false' },
    { id: 'R6a', fen: '4k3/8/8/8/8/8/r7/R3K3', ok: 'T.effs().includes("rookLine")' },
    { id: 'R6b', fen: '4k3/8/8/8/8/8/r7/R3K3', ok: 'T.effs().includes("rookLine")' },
    { id: 'R6c', fen: '4k3/p7/8/8/8/8/R7/4K3', ok: 'T.at("a7") === "rw" && T.at("a2") === "pb"' },
    { id: 'R11a', fen: '4k3/8/8/8/8/8/RPp5/4K3', ok: 'T.legal("a2").includes("d2")' },
    { id: 'R11b', fen: '4k3/8/8/8/8/8/8/1N2K3', ok: 'T.at("b1") === "rw"' },
    { id: 'R11c', fen: '4k3/8/8/8/8/8/8/R3K3', pre: 'Game.G.bd[T.sq("e1")].moved = true', ok: 'T.legal("e1").includes("c1")' },
    // 나이트
    { id: 'N1a', fen: '4k3/8/8/8/8/8/8/1N2K3', ok: 'T.effs().includes("untargetable")' },
    { id: 'N1b', fen: '4k3/8/8/8/8/2p5/8/1NB1K3', act: 'await T.play("b1","c3")', ok: 'T.at("c3") === "bw" && T.at("c1") === "nw"' },
    { id: 'N1c', fen: '4k3/8/8/8/1p6/2p5/8/1N2K3', act: 'await T.play("b1","c3")', ok: 'T.at("b4") === null' },
    { id: 'N3a', fen: '4k3/8/8/8/8/8/1P6/1N2K3', ok: 'Game.activatable("w").includes("N3a")', act2: 'await Game.activate("N3a")', ok2: 'T.at("b1") === "pw" && T.at("b2") === "nw"' },
    { id: 'N3b', fen: '4k3/8/8/8/8/8/8/1N2K3', ok: 'T.effs().includes("knightOnly")' },
    { id: 'N3c', fen: '4k3/8/8/8/8/8/8/rNq1K3', ok: 'T.at("b1") === "rw"' },
    { id: 'N6a', fen: '4k3/8/8/8/8/8/1p6/1N2K3', act: 'await T.play("b1","c3")', ok: 'Game.G.phased.length === 1' },
    { id: 'N6b', fen: '4k2n/8/8/8/8/8/8/1N2K3', act: 'await T.play("e1","d1"); await T.play("e8","d8")', ok: 'T.at("h8") === null && Game.G.kills.w === 1' },
    { id: 'N6c', fen: '4k3/p7/8/8/8/8/8/1N2K3', ok: 'T.at("a7") === "nw" && T.at("b1") === null' },
    { id: 'N11a', fen: '4k3/8/8/8/8/8/8/1N2K3', pre: 'Game.G.augs.w.push("N1a","N3b")', ok: 'Engine.piecesOf(Game.G,"w","n").length === 3' },
    { id: 'N11b', fen: '4k3/8/8/8/8/8/8/1N2K3', ok: 'T.legal("b1").includes("d5")' },
    { id: 'N11c', fen: '3qk3/8/8/8/8/8/8/1N2K3', ok: 'T.at("d8") === null && T.at("b1") === null' },
    // 비숍 (비밀)
    { id: 'B1a', fen: '4k3/8/8/p7/7P/8/8/2B1K3', act: 'await T.play("e1","d1"); await T.play("e8","d8")', ok: 'T.at("a5") === "pw" && T.at("h4") === "pb"' },
    { id: 'B1b', fen: '4k3/8/8/8/8/8/1p6/2B1K3', act: 'await T.play("e1","d1"); await T.play("e8","d8")', ok: 'T.at("b2") === null' },
    { id: 'B1c', fen: '4k3/p7/8/8/8/8/8/2B1K3', act: 'await T.play("e1","d1"); await T.play("e8","d8"); await T.play("d1","e1"); await T.play("d8","e8")', ok: 'T.at("a7") === null' },
    { id: 'B3a', fen: '4k3/8/8/8/8/8/P7/2B1K3', act: 'await T.play("e1","d1"); await T.play("e8","d8")', ok: 'Engine.piecesOf(Game.G,"w","p").length === 1 && T.flags("w").B3aDone === "miss"' },
    { id: 'B3a', fen: '4k3/8/8/8/8/8/8/2B1K3', act: 'await T.play("e1","d1"); await T.play("e8","d8")', ok: 'Engine.piecesOf(Game.G,"w","p").length === 1 && T.flags("w").B3aDone === "fired"' },
    { id: 'B3b', fen: '4k3/8/8/8/8/8/P7/2B1K3', act: 'await T.play("e1","d1"); await T.play("e8","d8")', ok: 'Engine.piecesOf(Game.G,"w","p").length === 2 && T.flags("w").B3bDone === "fired"' },
    { id: 'B3c', fen: '4k3/8/8/8/8/2p5/8/B3K3', pre: 'Game.G.grave.w.push("n")', act: 'await T.play("a1","c3"); await T.play("e8","d8"); await T.play("e1","d1"); await T.play("d8","e8"); await T.play("d1","e1"); await T.play("e8","d8")', ok: 'T.at("b1") === "nw"' },
    /* 스폰 칸이 막힌 종류는 고른 뒤에 '불가' 를 보여 주면 안 되고, 처음부터 잠겨서 와야 한다
       (피드백 '플레이 3'). b1·g1 을 나이트가 막고 있으니 나이트는 잠기고 룩만 고를 수 있다. */
    { id: 'B3c', fen: '4k3/8/8/8/8/2p5/8/BN2K1N1', pre: 'Game.G.grave.w.push("n"); Game.G.grave.w.push("r")', act: 'await T.play("a1","c3"); await T.play("e8","d8"); await T.play("e1","d1"); await T.play("d8","e8"); await T.play("d1","e1"); await T.play("e8","d8")', ok: 'T.opts.some(o => o.label === "나이트" && o.block) && T.opts.some(o => o.label === "룩" && !o.block) && (T.at("a1") === "rw" || T.at("h1") === "rw")' },
    { id: 'B6a', fen: '4k3/8/8/8/8/8/8/1nB1K3', ok: 'T.effs().includes("bishopRevenge")' },
    { id: 'B6a', fen: '4k3/8/8/8/8/8/2r5/2B1K3', act: 'await T.play("e1","d1"); await T.play("c2","c1")', ok: 'T.at("c1") === null' },
    { id: 'B6b', fen: '4k3/8/8/8/8/8/8/n1B1K3', act: 'await T.play("e1","d1"); await T.play("e8","d8")', ok: 'T.at("a1") === null' },
    { id: 'B6c', fen: '4k3/8/8/8/1p6/2p5/1p6/B3K3', act: 'await T.play("a1","b2")', ok: 'T.at("c3") === null' },
    { id: 'B11a', fen: '4k3/8/8/8/8/7r/8/2B1K3', act: 'await T.play("e1","d1"); await T.play("h3","h1")', ok: 'T.effs().includes("untargetable")' },
    { id: 'B11b', fen: '4k3/8/8/8/8/8/8/2B1K3', ok: 'T.effs().includes("bishopAsQueen") && T.legal("c1").includes("c8")' },
    { id: 'B11c', fen: '4k3/8/8/8/8/8/8/n1B1K3', pre: 'Game.G.augs.b.push("N1a")', act: 'await T.play("e1","d1"); await T.play("e8","d8"); await T.play("d1","e1"); await T.play("d8","e8")', ok: '!Game.G.augs.b.includes("N1a")' },
    // 퀸
    { id: 'Q1a', fen: '4k3/8/8/8/8/8/8/3QK3', act: 'await T.play("d1","a1"); await T.play("e8","d8")', ok: 'T.legal("a1").includes("h8")' },
    { id: 'Q1b', fen: '3qk3/8/8/8/8/8/8/3QK3', ok: 'T.effs().includes("untargetable")' },
    { id: 'Q1c', fen: '3qk3/8/8/8/8/8/8/3QK3', ok: 'T.at("d1") === null && T.at("d8") === null' },
    { id: 'Q3a', fen: '4k3/8/8/8/8/8/8/3QK3', pre: 'Game.G.augs.w.push("P1b"); Game.G.augs.b.push("N1a")', ok: 'Game.G.augs.w.length === 0 && Game.G.augs.b.length === 0' },
    { id: 'Q3b', fen: '4k3/8/8/8/8/8/8/3QK3', ok: 'Game.G.phased.length === 1' },
    { id: 'Q3c', fen: '4k3/8/8/8/8/8/8/3QK2r', act: 'await T.play("e1","e2"); await T.play("h1","d1")', ok: 'Game.G.kills.b === 0' },
    { id: 'Q6a', fen: '4k3/8/8/8/8/8/8/1NQ1K3', ok: 'Game.G.phased.length === 2' },
    { id: 'Q6b', fen: '4k3/8/8/8/8/8/8/3QK3', ok: 'T.legal("d1").includes("c3")' },
    { id: 'Q6c', fen: '4k3/8/8/r6Q/8/8/8/4K3', ok: 'T.at("a5") === "qw" && T.at("h5") === "rb"' },
    { id: 'Q11a', fen: '4k3/n7/8/8/8/8/2n5/3QK3', ok: 'T.at("a7") === null && T.at("c2") === null && T.at("d1") === null' },
    { id: 'Q11b', fen: '4k3/8/8/8/8/8/2n5/3QK3', act: 'await T.play("e1","f1"); await T.play("e8","d8")', ok: 'T.at("c2") === null' },
    { id: 'Q11c', fen: '4k3/8/8/8/8/8/8/Q3K3', ok: 'T.legal("a1").includes("d1")' },
    // 킹
    { id: 'K1a', fen: '4k3/8/8/8/8/7r/8/2QK4', act: 'await T.play("d1","e1"); await T.play("h3","h1")', ok: 'T.at("c1") === "kw" && T.at("e1") === "qw"' },
    { id: 'K1b', fen: '4k3/8/8/8/8/8/8/4K3', ok: 'T.flags("w").K1b === 1' },
    /* K1b 는 '다른 칸을 한 번 더' 가 아니라 '그 칸의 3개 중 2개' 다.
       tierIdx 를 되돌려 드래프트를 실제로 열고, 나이트로 처치해 나이트 1개 칸을 펼친다.
       K1b 를 뺀 나머지 둘이 모두 N1* 이어야 같은 칸에서 두 개를 고른 것이다. */
    { id: 'K1b', fen: '4k3/8/8/3p4/8/2N5/8/4K3', pre: 'Game.G.tierIdx = { w: 0, b: 0 }', act: 'await T.play("c3","d5")', ok: '(() => { const a = Game.G.augs.w.filter(x => x !== "K1b"); return a.length === 2 && a.every(x => x.slice(0, 2) === "N1"); })()' },
    /* 같은 칸의 남은 둘이 다 잠겨 있으면 두 번째는 없다 — 다른 기물 칸으로 넘어가면 안 된다.
       흑 퀸이 없으면 퀸 1개 칸에서 Q1b·Q1c 가 잠기므로 고를 수 있는 건 Q1a 하나뿐이다. */
    { id: 'K1b', fen: '4k3/8/8/3p4/8/8/8/3QK3', pre: 'Game.G.tierIdx = { w: 0, b: 0 }', act: 'await T.play("d1","d5")', ok: '(() => { const a = Game.G.augs.w.filter(x => x !== "K1b"); return a.length === 1 && a[0] === "Q1a"; })()' },
    { id: 'K1c', fen: '4k3/8/8/8/8/8/8/4K3', pre: 'Game.G.bd[T.sq("a1")] = Engine.mkPiece("p","b")', act: 'Engine.removePiece(Game.G, T.sq("a1"), { by: "w" })', ok: 'Game.G.kills.w === 1' },
    { id: 'K3a', fen: '4k3/8/8/8/8/8/8/1NB1K3', ok: 'Game.G.augs.w.length === 2' },
    { id: 'K3b', fen: '4k3/8/8/8/8/8/8/1N2K3', ok: 'Engine.piecesOf(Game.G,"w").length >= 3' },
    { id: 'K3c', fen: '4k3/8/8/8/8/8/8/R2QK3', ok: 'Game.G.augs.w.length === 2' },
    { id: 'K6a', fen: '4k3/8/8/8/8/8/8/1N2K3', act: 'await T.play("b1","c3")', ok: 'T.at("e1") === null && T.flags("w").K6a === 0' },
    { id: 'K6b', fen: '4k3/8/8/8/8/8/8/1N2K3', pre: 'Game.G.augs.w.push("N1a","N3b")', ok: 'Game.G.augs.w.length === 4' },
    { id: 'K6c', fen: '4k3/8/8/8/8/8/8/1N2K3', pre: 'Game.G.augs.w.push("N1a")', ok: '!Game.G.augs.w.includes("N1a") && Game.G.augs.w.length === 2' },
    { id: 'K11a', fen: '4k3/8/8/8/8/8/4P3/4K3', ok: 'Game.activatable("w").includes("K11a")', act2: 'await Game.activate("K11a")', ok2: 'T.at("e2") === null && Engine.piecesOf(Game.G,"w","p").length === 1' },
    { id: 'K11b', fen: '3NkN2/8/4P3/8/8/8/8/4K3', act: 'await T.play("e6","e7")', ok: 'Game.G.result && Game.G.result.winner === "w"' },
    { id: 'K11c', fen: '4k3/8/8/8/8/8/8/1NBQK3', ok: 'T.at("b1") === "pw" && T.at("d1") === "pw"' },
  ];

  const results = [];
  for (const sc of S) {
    const r = await P.evaluate(async (sc) => {
      const out = { id: sc.id, ok: false, err: null, msgs: [] };
      try {
        T.fen(sc.fen, { turn: sc.turn });
        if (sc.pre) await eval('(async()=>{' + sc.pre + '})()');
        const boardBefore = T.board();
        await T.grant('w', sc.id);
        if (sc.act) await eval('(async()=>{' + sc.act + '})()');
        out.ok = !!eval(sc.ok);
        if (sc.ok2) {
          if (sc.act2) await eval('(async()=>{' + sc.act2 + '})()');
          out.ok = out.ok && !!eval(sc.ok2);
        }
        out.fired = T.fired(sc.id);
        out.changed = boardBefore !== T.board();
        out.msgs = T.msgs.slice(0, 4);
      } catch (e) { out.err = String(e.message || e); }
      return out;
    }, sc);
    if (sc.note && !r.ok) r.skipped = sc.note;
    results.push(r);
    console.log((r.ok ? 'PASS' : (r.skipped ? 'SKIP' : 'FAIL')) + ' ' + r.id.padEnd(5) + (r.err ? ' ERR ' + r.err : '') + (!r.ok && !r.skipped ? '  msgs=' + JSON.stringify(r.msgs) : ''));
  }
  const fails = results.filter(r => !r.ok && !r.skipped);
  console.log('\n' + results.filter(r => r.ok).length + ' pass, ' + fails.length + ' fail: ' + fails.map(f => f.id).join(' '));
  console.log('errors:', P.errors.slice(0, 5));
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
