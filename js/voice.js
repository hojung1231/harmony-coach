// 버전 2: 내 목소리 녹음 → 멜로디 음표(미디) → 화음 연습 곡
// 원곡/MR 을 들으며 부른 멜로디를 음높이·박자로 바꾸고, 조·템포를 찾아 곡 데이터로 만든다.
import { scaleShift, pitchClassFeatures, HOP } from './autosong.js';

export const VSR = 8000;            // 녹음 분석용 샘플레이트 (목소리 기본음엔 충분)
export const FR = 0.01;             // 분석 프레임 간격 10ms

/* ---------- 녹음 신호 → 프레임별 음높이 (YIN) ---------- */
const W = 200, TMIN = Math.floor(VSR / 1000), TMAX = Math.ceil(VSR / 70);
const dbuf = new Float32Array(TMAX + 2);
/** x[o..o+W+TMAX) 의 음높이(MIDI 실수) 또는 null */
export function yinAt(x, o) {
  if (o < 0 || o + W + TMAX >= x.length) return null;
  const d = dbuf; d[0] = 1; let run = 0, tau = -1;
  for (let t = 1; t <= TMAX; t++) {
    let s = 0;
    for (let j = 0; j < W; j++) { const v = x[o + j] - x[o + j + t]; s += v * v; }
    run += s; d[t] = run ? (s * t) / run : 1;
  }
  for (let t = TMIN; t < TMAX; t++) if (d[t] < 0.15) { while (t + 1 < TMAX && d[t + 1] < d[t]) t++; tau = t; break; }
  if (tau < 0) { let mv = 1, mi = -1; for (let t = TMIN; t < TMAX; t++) if (d[t] < mv) { mv = d[t]; mi = t; } if (mv < 0.25) tau = mi; else return null; }
  const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a - 2 * b + c;
  const tt = tau + (den ? (0.5 * (a - c)) / den : 0);
  return 69 + 12 * Math.log2(VSR / tt / 440);
}
/** 녹음(8kHz) → { f: 음높이 배열(NaN=무성), r: 세기 배열 }  (프레임 i 의 시각 = i*FR, 창 가운데 기준) */
export function pitchTrack(x) {
  const hop = Math.round(VSR * FR), n = Math.max(0, Math.floor((x.length - W - TMAX) / hop));
  const f = new Float32Array(n).fill(NaN), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * hop - Math.round(W / 2); let s = 0;
    for (let j = Math.max(0, o); j < Math.min(x.length, o + W); j++) s += x[j] * x[j];
    r[i] = Math.sqrt(s / W);
  }
  const sorted = Array.from(r).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : 0);
  // 배경 소음(가장 조용한 5%)의 4배, 단 계속 부르는 녹음에서도 목소리를 막지 않게 큰 소리(90%)의 20% 이하
  const gate = Math.max(0.002, Math.min(q(0.05) * 4, q(0.9) * 0.2));
  for (let i = 0; i < n; i++) {
    if (r[i] < gate) continue;
    const m = yinAt(x, i * hop - Math.round(W / 2));
    if (m != null && m > 38 && m < 90) f[i] = m;
  }
  return { f, r, gate };
}

/* ---------- 프레임 음높이 → 음표 ---------- */
const median = (a) => { const s = a.slice().sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };
/**
 * track → 음표 [{ t, d, m(실수), on(새 음절 시작 1/0) }], t 는 녹음 시작부터 초
 */
export function segment({ f, r }) {
  const n = f.length;
  // 5프레임 중앙값으로 튀는 값 제거
  const sm = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (isNaN(f[i])) continue;
    const w = []; for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < n && !isNaN(f[j])) w.push(f[j]);
    sm[i] = median(w);
  }
  // 옥타브 튐 보정: 앞뒤보다 12 가까이 벗어난 값은 옥타브 맞춤
  for (let i = 1; i < n - 1; i++) {
    if (isNaN(sm[i])) continue;
    const ref = !isNaN(sm[i - 1]) ? sm[i - 1] : sm[i + 1];
    if (!isNaN(ref) && Math.abs(sm[i] - ref) > 9) sm[i] -= 12 * Math.round((sm[i] - ref) / 12);
  }
  const notes = []; let cur = null, gap = 0, dev = 0;
  const flush = (endI) => {
    if (cur && cur.v.length >= 8) {        // 80ms 이상만
      const k = Math.floor(cur.v.length * 0.2);
      const core = cur.v.length > 10 ? cur.v.slice(k, cur.v.length - k) : cur.v;
      notes.push({ t: cur.s * FR, d: (endI - cur.s) * FR, m: median(core), on: cur.on });
    }
    cur = null; gap = 0; dev = 0;
  };
  const dip = (i) => {    // i 근처에서 소리가 확 줄었다 다시 커졌는가 (자음·새 음절)
    let lo = Infinity, hiA = 0, hiB = 0;
    for (let j = i - 4; j <= i + 2; j++) if (j >= 0 && j < n) lo = Math.min(lo, r[j]);
    for (let j = i - 12; j < i - 4; j++) if (j >= 0) hiA = Math.max(hiA, r[j]);
    for (let j = i + 2; j < i + 10; j++) if (j < n) hiB = Math.max(hiB, r[j]);
    return lo < 0.55 * Math.min(hiA, hiB);
  };
  for (let i = 0; i < n; i++) {
    const m = sm[i];
    if (isNaN(m)) { if (cur && ++gap >= 4) flush(i - gap + 1); continue; }
    if (!cur) { cur = { s: i, v: [m], on: 1 }; gap = 0; continue; }
    const ref = median(cur.v.slice(-10));
    if (Math.abs(m - ref) > 0.55) {
      if (++dev >= 4) {                    // 40ms 이상 다른 음 → 새 음표 (벗어나기 시작한 곳부터)
        const st = i - dev + 1;
        cur.v.length = Math.max(1, cur.v.length - (dev - 1));
        const on = gap > 0 || dip(st) ? 1 : 0;
        flush(st);
        cur = { s: st, v: Array.from(sm.slice(st, i + 1)).filter((v) => !isNaN(v)), on };
      } else cur.v.push(m);
      gap = 0; continue;
    }
    dev = 0; gap = 0;
    // 같은 음이 이어지는 중 자음으로 끊김 → 같은 음 새 음절
    if (cur.v.length >= 12 && i >= 3 && dip(i - 1) && r[i] > r[i - 3] * 1.5) {
      const on = 1; flush(i); cur = { s: i, v: [m], on };
    } else cur.v.push(m);
  }
  if (cur) flush(n - gap);
  return notes;
}
/** 전체 음정 치우침(내가 일정하게 조금 높/낮게 부름) 찾기 → 반음 단위로 맞출 때 빼 줌 */
export function tuningOffset(notes) {
  let sx = 0, sy = 0;
  for (const n of notes) { const a = 2 * Math.PI * (n.m - Math.round(n.m)); sx += Math.cos(a) * n.d; sy += Math.sin(a) * n.d; }
  return Math.atan2(sy, sx) / (2 * Math.PI);
}

/* ---------- 조 찾기 (Krumhansl) ---------- */
const KMAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KMIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const corr = (a, b) => { const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12; let n = 0, da = 0, db = 0; for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db || 1); };
/** 멜로디 음 길이 분포(+ 원곡 12음 세기) → { tonic(0~11), mode } */
export function estimateKey(notes, chroma) {
  const h = new Array(12).fill(0);
  for (const n of notes) h[((Math.round(n.m) % 12) + 12) % 12] += Math.min(n.d, 1.5);
  const hs = h.reduce((s, v) => s + v, 0) || 1;
  const v = h.map((x, i) => x / hs + (chroma ? chroma[i] : 0));
  let best = { s: -2 };
  for (let k = 0; k < 12; k++) for (const [mode, P] of [['major', KMAJ], ['minor', KMIN]]) {
    const rot = P.map((_, i) => P[(i - k + 12) % 12]);
    const s = corr(v, rot) + (mode === 'major' ? 0.02 : 0);
    if (s > best.s) best = { s, tonic: k, mode };
  }
  return best;
}
/** 원곡 특징(pitchClassFeatures) → 곡 전체 12음 평균 세기 (0~1 정규화) */
export function meanChroma(feat) {
  const c = feat.map((a) => { let s = 0; for (const v of a) if (v > 0) s += v; return s / (a.length || 1); });
  const sum = c.reduce((s, v) => s + v, 0) || 1;
  return c.map((v) => v / sum);
}

/* ---------- 템포·박 찾기 (원곡 온셋 자기상관) ---------- */
function fftMag(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const k = i + j + len / 2, tr = re[k] * cr - im[k] * ci, ti = re[k] * ci + im[k] * cr; re[k] = re[i + j] - tr; im[k] = im[i + j] - ti; re[i + j] += tr; im[i + j] += ti; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}
/** 모노 신호(sr) → { bpm(4분음표), phase(첫 박 시각), env } */
export function estimateTempo(x, sr) {
  const N = 1024, hop = Math.round(sr * FR), F = Math.max(0, Math.floor((x.length - N) / hop));
  const re = new Float32Array(N), im = new Float32Array(N), prev = new Float32Array(N / 2), env = new Float32Array(F);
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  for (let f = 0; f < F; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fftMag(re, im);
    let s = 0;
    for (let i = 2; i < N / 2; i++) { const m = Math.log1p(100 * Math.hypot(re[i], im[i])); const dlt = m - prev[i]; if (dlt > 0) s += dlt; prev[i] = m; }
    env[f] = s;
  }
  // 국소 평균 빼기
  const e = new Float32Array(F); let acc = 0; const L = 30;
  for (let i = 0; i < F; i++) { acc += env[i]; if (i >= L) acc -= env[i - L]; e[i] = Math.max(0, env[i] - acc / Math.min(i + 1, L)); }
  // 자기상관: 60~180 BPM, 100 BPM 근처를 조금 선호
  let best = { s: -1, lag: 60 };
  const fps = 1 / FR;
  for (let lag = Math.round(fps * 60 / 180); lag <= Math.round(fps * 60 / 60); lag++) {
    let s = 0; for (let i = lag; i < F; i++) s += e[i] * e[i - lag];
    s /= (F - lag);
    const bpm = 60 * fps / lag, w = Math.exp(-0.5 * (Math.log2(bpm / 100) / 0.9) ** 2);
    if (s * w > best.s) best = { s: s * w, lag };
  }
  // 소수점 박 길이로 다듬기 (긴 곡에서 밀리지 않게)
  let lag = best.lag, bs = -1;
  for (let L2 = best.lag - 1; L2 <= best.lag + 1; L2 += 0.02) {
    const k = Math.floor(F / L2);
    let comb = 0; for (let ph = 0; ph < L2; ph += 1) { let c = 0; for (let j = 0; j < k; j++) { const a = Math.round(ph + j * L2); if (a < F) c += e[a]; } comb = Math.max(comb, c); }
    if (comb > bs) { bs = comb; lag = L2; }
  }
  let bp = 0, bv = -1;
  for (let ph = 0; ph < lag; ph++) { let c = 0; for (let a = ph; a < F; a += lag) c += e[Math.round(a)] || 0; if (c > bv) { bv = c; bp = ph; } }
  return { bpm: 60 * fps / lag, phase: bp * FR + (N / 2) / sr, beat: lag * FR };
}

/* ---------- 원곡과 내 녹음의 시간 차 (지연) 다듬기 ---------- */
/** notes(원곡 시각) 를 dt 만큼 옮겼을 때 원곡 12음 세기와 가장 잘 맞는 dt (범위 [lo, hi]) */
export function refineLag(notes, feat, lo = -0.35, hi = 0.35) {
  const F = feat[0].length, C = feat.center || 0;
  const cum = feat.map((a) => { const c = new Float64Array(a.length + 1); for (let i = 0; i < a.length; i++) c[i + 1] = c[i] + a[i]; return c; });
  const score = (dt) => {
    let s = 0, w = 0;
    for (const n of notes) {
      const pc = ((Math.round(n.m) % 12) + 12) % 12, a = Math.round((n.t + dt + 0.03 - C) / HOP), b = Math.max(a + 1, Math.round((n.t + dt + n.d * 0.8 - C) / HOP));
      if (a < 0 || b > F) continue;
      const wt = Math.min(n.d, 1); s += (cum[pc][b] - cum[pc][a]) / (b - a) * wt; w += wt;
    }
    return w ? s / w : 0;
  };
  let best = { dt: 0, s: score(0) }; const base = best.s;
  for (let dt = lo; dt <= hi + 1e-9; dt += 0.01) { const s = score(dt); if (s > best.s) best = { dt, s }; }
  return best.s - base > 0.03 ? best.dt : 0;
}

/* ---------- 음표 → 곡 데이터 ---------- */
const KS_MAJOR = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
const NAMES_S = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'], NAMES_F = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
/**
 * rec: { notes:[{t,d,m,on}] (원곡 시각, m=반음 정수), key:{tonic,mode}, tempo:{bpm,phase} }
 */
export function buildVoiceSong(base, rec, duration) {
  const ns = rec.notes.slice().sort((a, b) => a.t - b.t);
  if (!ns.length) return null;
  const { tonic, mode } = rec.key;
  const majPc = mode === 'minor' ? (tonic + 3) % 12 : tonic;
  const ks = KS_MAJOR[majPc];
  const nm = (ks < 0 ? NAMES_F : NAMES_S)[tonic];
  const bpm = rec.tempo && rec.tempo.bpm > 30 ? rec.tempo.bpm : 90;
  const beat = 60 / bpm, ph = rec.tempo ? rec.tempo.phase : 0;
  // 박을 2로 나누는지(4/4) 3으로 나누는지(12/8) — 내가 부른 음 시작이 어느 격자에 더 잘 맞는지
  const fit = (sub) => { const st = beat / sub; let e = 0; for (const n of ns) { const q = (n.t - ph) / st; e += Math.abs(q - Math.round(q)); } return e / ns.length; };
  const sub = fit(3) < fit(2) - 0.04 ? 3 : 2;
  const eighth = beat / sub, perBar = sub * 4;
  const shift = Math.max(0, ns[0].t - 2);
  const notes = [], orig = [];
  let lastE = -1;
  for (const n of ns) {
    let e = Math.round(((n.t - ph) / eighth) * 2) / 2;
    if (e <= lastE) e = lastE + 0.5;
    const de = Math.max(0.5, Math.round((n.d / eighth) * 2) / 2);
    lastE = e;
    notes.push([+(n.t - shift).toFixed(3), +n.d.toFixed(3), n.m, n.on ? 1 : 0, e, de]);
    orig.push([+n.t.toFixed(3), +n.d.toFixed(3)]);
  }
  if (!notes.some((n) => n[3])) notes.forEach((n) => { n[3] = 1; });
  // 마디: 한 마디 4박, 첫 음이 들어 있는 마디부터
  const bars = [], e0 = Math.floor(notes[0][4] / perBar) * perBar, eEnd = notes[notes.length - 1][4] + notes[notes.length - 1][5];
  for (let b = e0 + perBar; b < eEnd; b += perBar) bars.push(b);
  const up = notes.map((n) => scaleShift(n[2], 2, majPc));
  // 악보 표시는 남자 음역이면 한 옥타브 위로 (높은음자리표)
  const avg = notes.reduce((s, n) => s + n[2], 0) / notes.length;
  return {
    ...base,
    format: 'harmony-coach-song', version: 2, builtin: false, source: 'voice',
    key: `${nm} ${mode === 'minor' ? '단조' : '장조'}`, keySig: ks, time: sub === 3 ? '12/8' : '4/4', tempo: Math.round(bpm), eighth: +eighth.toFixed(4),
    writtenOctave: avg < 63 ? 12 : 0,
    notes, bars, orig, origDuration: duration ? +duration.toFixed(2) : undefined,
    harmony: { third_up: up, third_down: notes.map((n) => scaleShift(n[2], -2, majPc)), sixth_down: up.map((m) => m - 12) },
    rec,
  };
}

/* ---------- 표준 MIDI 파일 ---------- */
export function midiFile(song) {
  const PPQ = 480, spb = song.eighth ? song.eighth * 2 : 60 / (song.tempo || 90);   // 4분음표 길이(초)
  const t0 = Math.min(...song.orig.map((o) => o[0]));
  const start = Math.max(0, t0 - spb * 4);
  const vlq = (v) => { const b = [v & 0x7f]; while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80); return b; };
  const str = (s) => Array.from(new TextEncoder().encode(s));
  const track = (ev) => { // ev: [tick, bytes]
    ev.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    const out = []; let last = 0;
    for (const [tk, bytes] of ev) { out.push(...vlq(Math.max(0, tk - last)), ...bytes); last = Math.max(last, tk); }
    out.push(0, 0xff, 0x2f, 0);
    return [...str('MTrk'), (out.length >>> 24) & 255, (out.length >>> 16) & 255, (out.length >>> 8) & 255, out.length & 255, ...out];
  };
  const tick = (sec) => Math.round(((sec - start) / spb) * PPQ);
  const us = Math.round(spb * 1e6);
  const ts = song.time === '12/8' ? [12, 3] : [4, 2];
  const t0ev = [[0, [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255], 0], [0, [0xff, 0x58, 4, ts[0], ts[1], 24, 8], 0]];
  const title = str(song.title || '');
  t0ev.push([0, [0xff, 0x03, ...vlq(title.length), ...title], 0]);
  const notesTrack = (name, pitches, ch) => {
    const nb = str(name), ev = [[0, [0xff, 0x03, ...vlq(nb.length), ...nb], 0]];
    song.orig.forEach(([s, d], i) => {
      const p = pitches[i]; if (p == null) return;
      const a = tick(s), b = Math.max(a + 10, tick(s + d));
      ev.push([a, [0x90 | ch, p, 96], 1], [b, [0x80 | ch, p, 0], 0]);
    });
    return track(ev);
  };
  const head = [...str('MThd'), 0, 0, 0, 6, 0, 1, 0, 4, (PPQ >> 8) & 255, PPQ & 255];
  const bytes = [...head, ...track(t0ev),
    ...notesTrack('멜로디', song.notes.map((n) => n[2]), 0),
    ...notesTrack('화음 3도 위', song.harmony.third_up, 1),
    ...notesTrack('화음 3도 아래', song.harmony.third_down, 2)];
  return new Blob([new Uint8Array(bytes)], { type: 'audio/midi' });
}
