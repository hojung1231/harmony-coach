// 음원에서 주 멜로디(보컬) 음높이 컨투어를 추출하는 웹 워커
// - 스테레오 중앙(보컬이 주로 위치) 강조 마스크
// - 하모닉 합산 기반 음높이 살리언스 (Melodia 방식 단순화)
// - 비터비로 연속적인 음높이 경로 추적

const FS = 22050, N = 2048, HOP = 512;
const CENT_MIN = 600, CENT_MAX = 5200, CBIN = 10; // 55Hz 기준 센트
const NB = Math.floor((CENT_MAX - CENT_MIN) / CBIN) + 1;
const H = 8, ALPHA = 0.8, K = 4, LAMBDA = 0.25;
let HPSS = false, HPSS_T = 8, HPSS_F = 8;

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
  const NBIN = maxBin + 2;
  const spec = new Float32Array(nFrames * NBIN);

  // 1단계: 스펙트로그램 (보컬 중앙 강조)
  for (let fr = 0; fr < nFrames; fr++) {
    const o = fr * HOP;
    for (let i = 0; i < N; i++) {
      const idx = o + i;
      re[i] = idx < len ? l[idx] * win[i] : 0;
      im[i] = r && idx < len ? r[idx] * win[i] : 0;
    }
    fft(re, im);
    for (let k = 1; k <= maxBin + 1; k++) {
      let m;
      if (r) {
        const zr = re[k], zi = im[k], cr = re[N - k], ci = -im[N - k];
        const Lr = (zr + cr) / 2, Li = (zi + ci) / 2;
        const Rr = (zi - ci) / 2, Ri = -(zr - cr) / 2;
        const pl = Lr * Lr + Li * Li, pr = Rr * Rr + Ri * Ri;
        const sim = Math.max(0, (2 * (Lr * Rr + Li * Ri)) / (pl + pr + 1e-12));
        const mr = (Lr + Rr) / 2, mi = (Li + Ri) / 2;
        m = Math.sqrt(mr * mr + mi * mi) * sim * sim;
      } else m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      spec[fr * NBIN + k] = m * fw[k];
    }
    if (fr % 200 === 0) progress(0.4 * (fr / nFrames));
  }

  // 2단계: 타악기(드럼) 성분 억제 — HPSS 중앙값 필터
  if (HPSS) {
    const TW = HPSS_T, FW = HPSS_F, buf = new Float32Array(Math.max(TW, FW) * 2 + 1);
    const med = (n) => { const a = buf.subarray(0, n); a.sort(); return a[n >> 1]; };
    const col = new Float32Array(nFrames);
    const H = new Float32Array(nFrames * NBIN);
    for (let k = 1; k <= maxBin + 1; k++) {
      for (let fr = 0; fr < nFrames; fr++) col[fr] = spec[fr * NBIN + k];
      for (let fr = 0; fr < nFrames; fr++) {
        let c = 0;
        for (let j = fr - TW; j <= fr + TW; j++) buf[c++] = col[Math.min(nFrames - 1, Math.max(0, j))];
        H[fr * NBIN + k] = med(c);
      }
      if (k % 40 === 0) progress(0.4 + 0.25 * (k / maxBin));
    }
    for (let fr = 0; fr < nFrames; fr++) {
      const row = fr * NBIN;
      for (let k = 1; k <= maxBin + 1; k++) {
        let c = 0;
        for (let j = k - FW; j <= k + FW; j++) buf[c++] = spec[row + Math.min(maxBin + 1, Math.max(1, j))];
        const P = med(c), h = H[row + k], h2 = h * h, p2 = P * P;
        mag[k] = spec[row + k] * (h2 + p2 > 0 ? h2 / (h2 + p2) : 0);
      }
      for (let k = 1; k <= maxBin + 1; k++) spec[row + k] = mag[k];
    }
  }

  // 3단계: 하모닉 합산 살리언스
  for (let fr = 0; fr < nFrames; fr++) {
    let fmax = 0;
    for (let k = 1; k <= maxBin + 1; k++) {
      const m = spec[fr * NBIN + k];
      mag[k] = m; lmag[k] = Math.log(m + 1e-9);
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
    if (fr % 200 === 0) progress(0.65 + 0.3 * (fr / nFrames));
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

/* ---------- 옥타브 오류 보정: 주변 3초 멜로디 흐름에서 7반음 넘게 벗어난 프레임을 옥타브 이동 ---------- */
function octaveFix(midi, sal, hop, voicedOnly) {
  const n = midi.length, half = Math.round(1.5 / hop), step = Math.max(1, Math.round(0.1 / hop));
  for (let pass = 0; pass < 2; pass++) {
    const traj = new Float32Array(n);
    for (let c = 0; c < n; c += step) {
      const v = [];
      for (let j = Math.max(0, c - half); j < Math.min(n, c + half); j += 2) if (sal[j] > 0 && (!voicedOnly || sal[j] > 0.05)) v.push(midi[j]);
      v.sort((a, b) => a - b);
      const m = v.length ? v[v.length >> 1] : NaN;
      for (let j = c; j < Math.min(n, c + step); j++) traj[j] = m;
    }
    for (let i = 0; i < n; i++) {
      if (!(sal[i] > 0) || isNaN(traj[i])) continue;
      while (midi[i] - traj[i] > 7.5) midi[i] -= 12;
      while (midi[i] - traj[i] < -7.5) midi[i] += 12;
    }
  }
}

/* ---------- 보컬 전용(분리된 목소리 파일) 정밀 분석: pYIN 방식 ---------- */
function analyzeVocal(L, R, sr, progress) {
  const FSV = 11025, W = 512, HOPV = 128, NF = 1024;
  // 모노 + 2단계 다운샘플
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = R ? (L[i] + R[i]) / 2 : L[i];
  const f = sr / FSV, n = Math.floor(mono.length / f), x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * f), b = Math.max(a + 1, Math.floor((i + 1) * f));
    let s = 0; for (let j = a; j < b; j++) s += mono[j]; x[i] = s / (b - a);
  }
  const nFrames = Math.max(1, Math.floor((n - 2 * W) / HOPV) + 1);
  const tauMin = Math.floor(FSV / 1100), tauMax = Math.ceil(FSV / 65);
  const fft = makeFFT(NF);
  const ar = new Float64Array(NF), ai = new Float64Array(NF), br = new Float64Array(NF), bi = new Float64Array(NF);
  const d = new Float64Array(tauMax + 2), sq = new Float64Array(2 * W + 1);
  const KC = 4;
  const cMidi = new Float32Array(nFrames * KC), cP = new Float32Array(nFrames * KC), rms = new Float32Array(nFrames);
  // pYIN 문턱값 분포 (베타분포 근사, 0.1~0.15 근처에 집중)
  const TH = [], TW = [];
  for (let t = 0.025; t <= 0.5; t += 0.025) { TH.push(t); TW.push(Math.pow(t, 1) * Math.pow(1 - t, 9)); }
  const tws = TW.reduce((a, b) => a + b, 0); for (let i = 0; i < TW.length; i++) TW[i] /= tws;
  let maxRms = 0;
  for (let fr = 0; fr < nFrames; fr++) {
    const o = fr * HOPV;
    for (let i = 0; i < NF; i++) { ar[i] = i < W ? x[o + i] : 0; ai[i] = 0; br[i] = x[o + i] || 0; bi[i] = 0; }
    sq[0] = 0; for (let i = 0; i < 2 * W; i++) sq[i + 1] = sq[i] + br[i] * br[i];
    rms[fr] = Math.sqrt(sq[W] / W); if (rms[fr] > maxRms) maxRms = rms[fr];
    fft(ar, ai); fft(br, bi);
    // 교차상관: conj(A)·B 의 역FFT
    for (let k = 0; k < NF; k++) { const r0 = ar[k] * br[k] + ai[k] * bi[k], i0 = ar[k] * bi[k] - ai[k] * br[k]; ar[k] = r0; ai[k] = -i0; }
    fft(ar, ai); // 역변환 = conj 후 FFT
    let run = 0; d[0] = 1;
    for (let t = 1; t <= tauMax + 1; t++) {
      const c = ar[t] / NF;
      const dt = sq[W] + (sq[t + W] - sq[t]) - 2 * c;
      run += dt; d[t] = run > 0 ? (dt * t) / run : 1;
    }
    // 문턱값별 첫 번째 골짜기에 확률 배분
    const cand = new Map();
    for (let h = 0; h < TH.length; h++) {
      for (let t = tauMin; t < tauMax; t++) {
        if (d[t] < TH[h] && d[t] <= d[t - 1] && d[t] <= d[t + 1]) { cand.set(t, (cand.get(t) || 0) + TW[h]); break; }
      }
    }
    const list = [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, KC);
    for (let k = 0; k < KC; k++) {
      if (k < list.length) {
        const t = list[k][0], a = d[t - 1], b = d[t], c = d[t + 1], den = a - 2 * b + c;
        const tt = t + (den ? (0.5 * (a - c)) / den : 0);
        cMidi[fr * KC + k] = 69 + 12 * Math.log2(FSV / tt / 440); cP[fr * KC + k] = list[k][1];
      } else { cMidi[fr * KC + k] = 0; cP[fr * KC + k] = 0; }
    }
    if (fr % 500 === 0) progress(0.85 * fr / nFrames);
  }
  // 에너지가 너무 작으면 무성
  const gate = maxRms * 0.012;
  for (let fr = 0; fr < nFrames; fr++) if (rms[fr] < gate) for (let k = 0; k < KC; k++) cP[fr * KC + k] = 0;
  // HMM 비터비: 상태 0..KC-1 = 후보 음, KC = 무성
  const S = KC + 1, back = new Uint8Array(nFrames * S);
  let prev = new Float64Array(S), cur = new Float64Array(S);
  const em = (fr, k) => {
    if (k === KC) { let p = 0; for (let j = 0; j < KC; j++) p += cP[fr * KC + j]; return -Math.log(Math.max(1e-4, 1 - p * 0.9)); }
    return cP[fr * KC + k] > 0 ? -Math.log(cP[fr * KC + k] * 0.9 + 1e-4) : 50;
  };
  const LAM = 0.35, SW = 2.5;
  for (let k = 0; k < S; k++) prev[k] = em(0, k);
  for (let fr = 1; fr < nFrames; fr++) {
    for (let k = 0; k < S; k++) {
      let best = Infinity, bj = 0;
      for (let j = 0; j < S; j++) {
        let c = prev[j];
        if (k === KC || j === KC) c += k === j ? 0 : SW;
        else c += LAM * Math.abs(cMidi[fr * KC + k] - cMidi[(fr - 1) * KC + j]);
        if (c < best) { best = c; bj = j; }
      }
      cur[k] = best + em(fr, k); back[fr * S + k] = bj;
    }
    [prev, cur] = [cur, prev];
  }
  let bk = 0; for (let k = 1; k < S; k++) if (prev[k] < prev[bk]) bk = k;
  const midi = new Float32Array(nFrames), sal = new Float32Array(nFrames);
  for (let fr = nFrames - 1; fr >= 0; fr--) {
    if (bk < KC) { midi[fr] = cMidi[fr * KC + bk]; sal[fr] = Math.max(0.06, cP[fr * KC + bk]); }
    bk = back[fr * S + bk];
  }
  // 무성 프레임 음높이는 이전 값 유지 (그래프용)
  for (let i = 1; i < nFrames; i++) if (!sal[i]) midi[i] = midi[i - 1];
  octaveFix(midi, sal, HOPV / FSV, true);
  progress(1);
  return { midi, sal, hop: HOPV / FSV, offset: W / 2 / FSV, voicing: true };
}

self.onmessage = (e) => {
  const { left, right, sampleRate, mode } = e.data;
  try {
    const prog = (p) => self.postMessage({ type: 'progress', p });
    const res = mode === 'vocal' ? analyzeVocal(left, right, sampleRate, prog) : analyze(left, right, sampleRate, prog);
    self.postMessage({ type: 'done', contour: res }, [res.midi.buffer, res.sal.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
