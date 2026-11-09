// 실시간 마이크 음높이 감지 (YIN 알고리즘)
const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);

export class MicPitch {
  async start(ctx, { aec = true } = {}) {
    this.ctx = ctx;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: aec, noiseSuppression: false, autoGainControl: false },
    });
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
    if (rms < 0.008) { this.hist = []; return null; }

    d[0] = 1;
    let run = 0, tau = -1;
    for (let t = 1; t <= tauMax; t++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const v = x[j] - x[j + t]; s += v * v; }
      run += s;
      d[t] = run ? (s * t) / run : 1;
    }
    for (let t = tauMin; t < tauMax; t++) {
      if (d[t] < 0.15) {
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
    this.hist.push(m);
    if (this.hist.length > 3) this.hist.shift();
    const s = this.hist.slice().sort((p, q) => p - q);
    return s[s.length >> 1];
  }
}

// 기준음/멜로디음 신스
export class Voice {
  constructor(ctx, type = 'triangle') {
    this.ctx = ctx;
    if (!ctx._master) {
      // 공용 출력: 압축기로 크게, 찌그러지지 않게
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 4;
      const master = ctx.createGain(); master.gain.value = 1.6;
      master.connect(comp).connect(ctx.destination);
      ctx._master = master;
    }
    this.osc = ctx.createOscillator();
    this.osc.type = type === 'sine' ? 'triangle' : 'sawtooth';   // 배음이 있어야 폰 스피커로도 들림
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = type === 'sine' ? 1400 : 2600;
    this.g = ctx.createGain();
    this.g.gain.value = 0;
    this.osc.connect(this.lp).connect(this.g).connect(ctx._master);
    this.osc.start();
    this.cur = null;
  }
  set(midi, vol) {
    const t = this.ctx.currentTime;
    if (midi == null || !vol) {
      if (this.cur !== null) this.g.gain.setTargetAtTime(0, t, 0.03);
      this.cur = null;
      return;
    }
    if (midi !== this.cur) {
      this.osc.frequency.setValueAtTime(440 * Math.pow(2, (midi - 69) / 12), t);
      this.g.gain.cancelScheduledValues(t);
      this.g.gain.setValueAtTime(0, t);
      this.g.gain.linearRampToValueAtTime(vol, t + 0.02);
      this.cur = midi;
    } else this.g.gain.setTargetAtTime(vol, t, 0.05);
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
