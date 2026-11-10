// 실시간 마이크 음높이 감지 (YIN 알고리즘)
const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);

export class MicPitch {
  async start(ctx, { aec = true, phoneMic = true } = {}) {
    this.ctx = ctx;
    const base = { echoCancellation: aec, noiseSuppression: false, autoGainControl: false };
    let deviceId;
    if (phoneMic) {
      // 블루투스 이어폰 마이크를 쓰면 폰이 '통화 모드'로 바뀌어 소리가 작고 탁해짐 → 폰 마이크를 고름
      try {
        let devs = await navigator.mediaDevices.enumerateDevices();
        if (!devs.some((d) => d.kind === 'audioinput' && d.label)) {   // 처음엔 이름이 안 보여서 한 번 허용 받은 뒤 다시 확인
          const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop());
          devs = await navigator.mediaDevices.enumerateDevices();
        }
        const BT = /bluetooth|headset|hands[- ]?free|블루투스|핸즈프리|airpods|buds|shokz|aftershokz|openrun|wh-|wf-|bose|jabra|sco/i;
        const ins = devs.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications');
        const phone = ins.find((d) => /built-?in|internal|내장|phone|bottom|마이크|microphone/i.test(d.label) && !BT.test(d.label)) || ins.find((d) => d.deviceId !== 'default' && !BT.test(d.label));
        const def = ins.find((d) => d.deviceId === 'default');
        if (phone && (!def || BT.test(def.label) || def.groupId !== phone.groupId)) deviceId = phone.deviceId;
        this.micName = (phone || def || {}).label || '';
      } catch {}
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base })
      .catch(() => navigator.mediaDevices.getUserMedia({ audio: base }));
    this.src = ctx.createMediaStreamSource(this.stream);
    this.an = ctx.createAnalyser();
    this.an.fftSize = 2048;
    this.src.connect(this.an);
    this.buf = new Float32Array(this.an.fftSize);
    const ds = ctx.sampleRate > 32000 ? 2 : 1;
    this.ds = ds;
    this.fs = ctx.sampleRate / ds;
    this.x = new Float32Array(this.buf.length / ds);
    this.W = this.x.length >> 1;
    this.tauMin = Math.floor(this.fs / 1100);
    this.tauMax = Math.min(this.W - 2, Math.ceil(this.fs / 70));
    this.d = new Float32Array(this.tauMax + 2);
    this.hist = [];
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.src) this.src.disconnect();
    this.stream = null;
  }

  /** 반환: midi(실수) 또는 null */
  read() {
    if (!this.an) return null;
    this.an.getFloatTimeDomainData(this.buf);
    const { x, ds, W, d, tauMin, tauMax } = this;
    let rms = 0;
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (let j = 0; j < ds; j++) s += this.buf[i * ds + j];
      x[i] = s / ds;
      rms += x[i] * x[i];
    }
    rms = Math.sqrt(rms / x.length);
    this.level = rms;
    if (rms < 0.005) { this.hist = []; return null; }

    d[0] = 1;
    let run = 0, tau = -1;
    for (let t = 1; t <= tauMax; t++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const v = x[j] - x[j + t]; s += v * v; }
      run += s;
      d[t] = run ? (s * t) / run : 1;
    }
    for (let t = tauMin; t < tauMax; t++) {
      if (d[t] < 0.17) {
        while (t + 1 < tauMax && d[t + 1] < d[t]) t++;
        tau = t; break;
      }
    }
    if (tau < 0) {
      let mv = 1, mi = -1;
      for (let t = tauMin; t < tauMax; t++) if (d[t] < mv) { mv = d[t]; mi = t; }
      if (mv < 0.3) tau = mi; else { this.hist = []; return null; }
    }
    const a = d[tau - 1], b = d[tau], c = d[tau + 1];
    const den = a - 2 * b + c;
    const tt = tau + (den ? (0.5 * (a - c)) / den : 0);
    const m = freqToMidi(this.fs / tt);
    this.lastRaw = m;   // 다듬지 않은 값 (떨림 측정용)
    this.hist.push(m);
    if (this.hist.length > 3) this.hist.shift();
    const s = this.hist.slice().sort((p, q) => p - q);
    return s[s.length >> 1];
  }
}

// 화음 가이드음 / 멜로디음 신스
// 음색: MR·가수 목소리 사이에서도 구별되도록 — 때리는 소리(어택), 목소리 위 음역, 목소리와 다른 배음 구조
export const PATCHES = {
  piano:   { label: '피아노', desc: '톡 치고 서서히 줄어듦 · 음이 바뀌는 순간이 또렷', parts: [{ wave: [1, 0.55, 0.38, 0.22, 0.14, 0.09, 0.05, 0.03], ratio: 1, lv: 1 }], A: 0.004, D: 0.4, S: 0.22, lp: 5200, amp: 1.5 },
  bell:    { label: '벨', desc: '한 옥타브 위에서 맑게 울림 · 목소리 위로 가장 잘 빠져나옴', parts: [{ type: 'sine', ratio: 2, lv: 0.8 }, { type: 'sine', ratio: 5.52, lv: 0.28 }, { type: 'sine', ratio: 10.8, lv: 0.12 }], A: 0.003, D: 0.45, S: 0.14, lp: 9000, amp: 1.4 },
  marimba: { label: '마림바', desc: '짧게 톡 · 내 목소리를 가장 덜 가림', parts: [{ type: 'sine', ratio: 1, lv: 1 }, { type: 'sine', ratio: 4, lv: 0.22 }], A: 0.002, D: 0.14, S: 0.1, lp: 7000, amp: 2.0 },
  organ:   { label: '오르간', desc: '끝까지 일정하게 이어짐 · 긴 음을 맞추기 좋음', parts: [{ wave: [1, 0.8, 0.55, 0.45, 0, 0.3, 0, 0.22], ratio: 1, lv: 1 }], A: 0.012, D: 0.1, S: 0.9, lp: 6000, amp: 0.8 },
  whistle: { label: '휘슬', desc: '한 옥타브 위의 깨끗한 소리 · 끝까지 이어짐', parts: [{ type: 'sine', ratio: 2, lv: 1 }, { type: 'sine', ratio: 4, lv: 0.1 }], A: 0.03, D: 0.1, S: 1, lp: 9000, amp: 0.65 },
  saw:     { label: '신스(기존)', desc: '이전 버전의 소리 · 목소리와 비슷해 섞이기 쉬움', parts: [{ type: 'sawtooth', ratio: 1, lv: 0.55 }], A: 0.02, D: 0.1, S: 1, lp: 2600, amp: 1.0 },
  mel:     { hidden: true, label: '멜로디', parts: [{ type: 'square', ratio: 1, lv: 0.5 }], A: 0.02, D: 0.1, S: 1, lp: 2000, amp: 1.0 },
};

export class Voice {
  constructor(ctx, patch = 'piano') {
    this.ctx = ctx;
    if (!ctx._master) {
      // 공용 출력: 압축기로 크게, 찌그러지지 않게
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 4;
      const master = ctx.createGain(); master.gain.value = 1;
      master.connect(comp).connect(ctx.destination);
      ctx._master = master;
    }
    this.env = ctx.createGain(); this.env.gain.value = 0;      // 음마다의 세기 변화(어택·감쇠)
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass';
    this.g = ctx.createGain(); this.g.gain.value = 0;          // 음량
    this.env.connect(this.lp).connect(this.g).connect(ctx._master);
    this.slots = [0, 1, 2].map(() => { const o = ctx.createOscillator(), pg = ctx.createGain(); pg.gain.value = 0; o.connect(pg).connect(this.env); o.start(); return { o, pg }; });
    this.cur = null; this.key = null;
    this.setPatch(patch);
  }
  setPatch(name) {
    const P = PATCHES[name] || PATCHES.piano; this.patch = P; this.patchName = name;
    this.lp.frequency.value = P.lp;
    this.slots.forEach((sl, i) => {
      const part = P.parts[i];
      if (!part) { sl.pg.gain.value = 0; return; }
      if (part.wave) { const n = part.wave.length + 1, re = new Float32Array(n), im = new Float32Array(n); part.wave.forEach((v, k) => (im[k + 1] = v)); sl.o.setPeriodicWave(this.ctx.createPeriodicWave(re, im)); }
      else sl.o.type = part.type;
      sl.pg.gain.value = part.lv;
    });
    this.cur = null; this.key = null;     // 다음 음부터 새 음색으로 다시 울림
  }
  /** midi: 낼 음(null=끔), vol: 음량, key: 음표 번호(같은 음이 이어져도 음표가 바뀌면 다시 침) */
  set(midi, vol, key = null) {
    const t = this.ctx.currentTime, P = this.patch;
    if (midi == null || !vol) {
      if (this.cur !== null) { this.env.gain.cancelScheduledValues(t); this.env.gain.setTargetAtTime(0, t, 0.03); }
      this.cur = null; this.key = null;
      return;
    }
    this.g.gain.setTargetAtTime(vol * P.amp, t, 0.03);
    if (midi !== this.cur || key !== this.key) {
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      this.slots.forEach((sl, i) => { if (P.parts[i]) sl.o.frequency.setValueAtTime(f * P.parts[i].ratio, t); });
      const e = this.env.gain;
      e.cancelScheduledValues(t); e.setValueAtTime(Math.min(e.value, 0.3), t);
      e.linearRampToValueAtTime(1, t + P.A); e.setTargetAtTime(P.S, t + P.A, P.D);
      this.cur = midi; this.key = key;
    }
  }
  off() { this.set(null, 0); }
  /** 짧은 소리 (카운트·테스트용) */
  static blip(ctx, midi, dur = 0.08, vol = 0.3) {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.type = 'square'; o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(ctx._master || ctx.destination); o.start(t); o.stop(t + dur + 0.02);
  }
}
