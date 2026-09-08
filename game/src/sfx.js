/* ============================================================
   무제체스 - 효과음
   외부 파일 없이 Web Audio 로 합성한다. (file:// 에서도 동작)
   브라우저 정책상 첫 사용자 입력이 있어야 소리가 난다 → unlock()
   ============================================================ */
(function (global) {
  'use strict';

  let ctx = null;
  let master = null;
  let enabled = true;
  let volume = 0.75;                 // 0 ~ 1 (기본값을 크게 잡았다)
  const CEIL = 1.6;                  // 슬라이더 최대치에서의 실제 게인

  function ensure() {
    if (ctx) return ctx;
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume * CEIL;
    // 볼륨을 키워도 찢어지지 않도록 리미터를 하나 물린다
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 12;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    master.connect(comp);
    comp.connect(ctx.destination);
    return ctx;
  }

  function unlock() {
    const c = ensure();
    if (c && c.state === 'suspended') c.resume();
  }

  // 기본 톤
  function tone(freq, t0, dur, type, vol, glideTo) {
    const c = ensure();
    if (!c || !enabled) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.25, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  // 잡음 기반 타격음
  function noise(t0, dur, vol, freq) {
    const c = ensure();
    if (!c || !enabled) return;
    const n = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.2);
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq || 1400;
    bp.Q.value = 0.9;
    const g = c.createGain();
    g.gain.value = vol || 0.3;
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(t0);
  }

  const now = () => { const c = ensure(); return c ? c.currentTime : 0; };

  const SFX = {
    setEnabled(v) { enabled = !!v; if (enabled) unlock(); },
    isEnabled() { return enabled; },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      const c = ensure();
      if (master && c) master.gain.setTargetAtTime(volume * CEIL, c.currentTime, 0.01);
    },
    getVolume() { return volume; },
    // 슬라이더를 움직일 때 크기를 귀로 확인할 수 있게
    demo() { const t = now(); tone(660, t, 0.09, 'sine', 0.3); noise(t + 0.02, 0.05, 0.25, 1200); },
    unlock,

    // 기물을 든다
    lift() { const t = now(); tone(420, t, 0.05, 'sine', 0.10); },
    // 평범한 착수 — 나무 두는 소리
    move() { const t = now(); noise(t, 0.06, 0.30, 900); tone(180, t, 0.07, 'sine', 0.16, 120); },
    // 처치 — 조금 더 둔탁하고 낮게
    capture() {
      const t = now();
      noise(t, 0.10, 0.46, 520);
      tone(140, t, 0.13, 'triangle', 0.24, 70);
    },
    // 캐슬링
    castle() { const t = now(); noise(t, 0.06, 0.26, 900); noise(t + 0.09, 0.06, 0.26, 900); },
    // 승격
    promote() {
      const t = now();
      [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.06, 0.16, 'triangle', 0.20));
    },
    // 체크 — 날카로운 경고
    check() {
      const t = now();
      tone(880, t, 0.11, 'square', 0.16);
      tone(1175, t + 0.10, 0.14, 'square', 0.16);
    },
    // 증강 카드가 열림
    draft() {
      const t = now();
      [392, 523, 659, 880].forEach((f, i) => tone(f, t + i * 0.07, 0.30, 'sine', 0.16));
    },
    // 증강 발동 — 반짝이는 소리
    augment() {
      const t = now();
      tone(1320, t, 0.10, 'triangle', 0.14);
      tone(1760, t + 0.06, 0.14, 'triangle', 0.12);
      tone(2637, t + 0.12, 0.18, 'sine', 0.08);
    },
    // 상대가 증강을 얻음 — 낮고 불길하게
    enemyAugment() {
      const t = now();
      tone(330, t, 0.18, 'sawtooth', 0.10, 247);
      tone(165, t + 0.05, 0.24, 'triangle', 0.12);
    },
    // 대상 지정 클릭
    pick() { const t = now(); tone(660, t, 0.06, 'sine', 0.14); },
    // 시간 촉박
    tick() { const t = now(); tone(1500, t, 0.04, 'square', 0.10); },
    // 승리 팡파르
    win() {
      const t = now();
      [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, t + i * 0.11, 0.42, 'triangle', 0.22));
      noise(t + 0.55, 0.5, 0.16, 2600);
    },
    // 패배
    lose() {
      const t = now();
      [523, 466, 392, 311].forEach((f, i) => tone(f, t + i * 0.16, 0.5, 'sine', 0.20));
    },
    // 무승부
    draw() {
      const t = now();
      [440, 440, 392].forEach((f, i) => tone(f, t + i * 0.16, 0.4, 'sine', 0.18));
    },
    // 잘못된 조작
    deny() { const t = now(); tone(150, t, 0.14, 'square', 0.13, 90); },
  };

  global.SFX = SFX;
})(window);
