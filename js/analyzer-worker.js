// 음원에서 주 멜로디(보컬) 음높이 컨투어를 추출하는 웹 워커
// - 스테레오 중앙(보컬이 주로 위치) 강조 마스크
// - 하모닉 합산 기반 음높이 살리언스 (Melodia 방식 단순화)
// - 비터비로 연속적인 음높이 경로 추적

const FS = 22050, N = 2048, HOP = 512;
const CENT_MIN = 600, CENT_MAX = 5200, CBIN = 10; // 55Hz 기준 센트
const NB = Math.floor((CENT_MAX - CENT_MIN) / CBIN) + 1;
const H = 8, ALPHA = 0.8, K = 4, LAMBDA = 0.25;

function downsample(x, sr) {
  if (sr <= FS * 1.01) return { y: x, fs: sr };
  const f = sr / FS, n = Math.floor(x.length / f), y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * f), b = Math.max(a + 1, Math.floor((i + 1) * f));
    let s = 0;
    for (let j = a; j < b; j++) s += x[j];
    y[i] = s / (b - a);
  }
  return { y, fs: sr / f };
}

// 복소 FFT (in-place, radix-2)
function makeFFT(n) {
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  return (re, im) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k], ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

function analyze(L, R, sr, progress) {
  const dl = downsample(L, sr), fs = dl.fs;
  const l = dl.y, r = R ? downsample(R, sr).y : null;
  const len = l.length;
  const nFrames = Math.max(1, Math.floor((len - N) / HOP) + 1);
  const fft = makeFFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const binHz = fs / N, maxBin = Math.min(N / 2 - 1, Math.floor(5000 / binHz));
  const mag = new Float64Array(maxBin + 2), lmag = new Float64Array(maxBin + 2);
  const fw = new Float64Array(maxBin + 2);
  for (let k = 0; k <= maxBin + 1; k++) {
    const f = k * binHz;
    fw[k] = f < 180 ? Math.pow(f / 180, 1.5) : f > 3500 ? Math.exp(-(f - 3500) / 1500) : 1;
  }
  const sal = new Float64Array(NB);
  const cBin = new Float32Array(nFrames * K), cVal = new Float32Array(nFrames * K);
  const pkF = new Float64Array(400), pkM = new Float64Array(400);

  for (let fr = 0; fr < nFrames; fr++) {
    const o = fr * HOP;
    for (let i = 0; i < N; i++) {
      const idx = o + i;
      re[i] = idx < len ? l[idx] * win[i] : 0;
      im[i] = r && idx < len ? r[idx] * win[i] : 0;
    }
    fft(re, im);
    let fmax = 0;
    for (let k = 1; k <= maxBin + 1; k++) {
      let m;
      if (r) {
        // Z = L + iR → L, R 분리
        const zr = re[k], zi = im[k], cr = re[N - k], ci = -im[N - k];
        const Lr = (zr + cr) / 2, Li = (zi + ci) / 2;
        const Rr = (zi - ci) / 2, Ri = -(zr - cr) / 2;
        const pl = Lr * Lr + Li * Li, pr = Rr * Rr + Ri * Ri;
        const sim = Math.max(0, (2 * (Lr * Rr + Li * Ri)) / (pl + pr + 1e-12));
        const mr = (Lr + Rr) / 2, mi = (Li + Ri) / 2;
        m = Math.sqrt(mr * mr + mi * mi) * sim * sim;
      } else m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      m *= fw[k];
      mag[k] = m;
      lmag[k] = Math.log(m + 1e-9);
      if (m > fmax) fmax = m;
    }
    // 스펙트럼 피크
    let np = 0;
    const floor = fmax * 0.01;
    for (let k = 2; k <= maxBin && np < 400; k++) {
      if (mag[k] > floor && mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
        const a = lmag[k - 1], b = lmag[k], c = lmag[k + 1];
        const den = a - 2 * b + c;
        const p = den !== 0 ? (0.5 * (a - c)) / den : 0;
        pkF[np] = (k + p) * binHz;
        pkM[np] = Math.exp(b - 0.25 * (a - c) * p);
        np++;
      }
    }
    sal.fill(0);
    for (let p = 0; p < np; p++) {
      let wh = 1;
      for (let h = 1; h <= H; h++, wh *= ALPHA) {
        const f0 = pkF[p] / h;
        if (f0 < 70) break;
        const bc = (1200 * Math.log2(f0 / 55) - CENT_MIN) / CBIN;
        if (bc > NB + 10) continue;
        const b0 = Math.max(0, Math.ceil(bc - 10)), b1 = Math.min(NB - 1, Math.floor(bc + 10));
        for (let b = b0; b <= b1; b++) {
          const d = Math.abs(b - bc) / 10;
          const w = Math.cos((d * Math.PI) / 2);
          sal[b] += w * w * wh * pkM[p];
        }
      }
    }
    // 상위 K개 후보
    for (let k = 0; k < K; k++) { cBin[fr * K + k] = 0; cVal[fr * K + k] = 0; }
    for (let b = 1; b < NB - 1; b++) {
      const v = sal[b];
      if (v > sal[b - 1] && v >= sal[b + 1]) {
        let mi = -1, mv = Infinity;
        for (let k = 0; k < K; k++) if (cVal[fr * K + k] < mv) { mv = cVal[fr * K + k]; mi = k; }
        if (v > mv) {
          const a = sal[b - 1], c = sal[b + 1], den = a - 2 * v + c;
          cBin[fr * K + mi] = b + (den !== 0 ? (0.5 * (a - c)) / den : 0);
          cVal[fr * K + mi] = v;
        }
      }
    }
    if (fr % 200 === 0) progress(0.95 * (fr / nFrames));
  }

  // 비터비
  let G = 0;
  for (let i = 0; i < cVal.length; i++) if (cVal[i] > G) G = cVal[i];
  G = G || 1;
  const cost = new Float64Array(K), back = new Uint8Array(nFrames * K);
  let prev = new Float64Array(K);
  const em = (fr, k) => -Math.log(cVal[fr * K + k] / G + 1e-4);
  for (let k = 0; k < K; k++) prev[k] = em(0, k);
  for (let fr = 1; fr < nFrames; fr++) {
    for (let k = 0; k < K; k++) {
      let best = Infinity, bi = 0;
      const bk = cBin[fr * K + k];
      for (let j = 0; j < K; j++) {
        const c = prev[j] + (LAMBDA * Math.abs(bk - cBin[(fr - 1) * K + j]) * CBIN) / 100;
        if (c < best) { best = c; bi = j; }
      }
      cost[k] = best + em(fr, k);
      back[fr * K + k] = bi;
    }
    prev = Float64Array.from(cost);
  }
  let bk = 0;
  for (let k = 1; k < K; k++) if (prev[k] < prev[bk]) bk = k;
  const midi = new Float32Array(nFrames), salOut = new Float32Array(nFrames);
  for (let fr = nFrames - 1; fr >= 0; fr--) {
    midi[fr] = 33 + (CENT_MIN + cBin[fr * K + bk] * CBIN) / 100;
    salOut[fr] = cVal[fr * K + bk] / G;
    bk = back[fr * K + bk];
  }
  progress(1);
  return { midi, sal: salOut, hop: HOP / fs, offset: N / 2 / fs };
}

self.onmessage = (e) => {
  const { left, right, sampleRate } = e.data;
  try {
    const res = analyze(left, right, sampleRate, (p) => self.postMessage({ type: 'progress', p }));
    self.postMessage({ type: 'done', contour: res }, [res.midi.buffer, res.sal.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
