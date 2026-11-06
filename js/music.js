// 음악 이론 / 멜로디 분할 / 화음 생성 유틸리티

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SOLFEGE = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

export const pc = (m) => ((Math.round(m) % 12) + 12) % 12;
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const midiToName = (m) => NOTE_NAMES[pc(m)] + (Math.floor(Math.round(m) / 12) - 1);
export const midiToLabel = (m) => `${midiToName(m)} (${SOLFEGE[pc(m)]})`;

export function keyName(key) {
  if (!key) return '-';
  return `${NOTE_NAMES[key.tonic]} ${key.mode === 'minor' ? '단조(minor)' : '장조(major)'}`;
}

/* ---------- 멜로디 컨투어 → 음표 ---------- */

function quantile(arr, q) {
  const a = Array.from(arr).filter((v) => v > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
}

/**
 * contour: { midi: Float32Array, sal: Float32Array, hop, offset }
 * sensitivity: 0(엄격) ~ 1(관대)
 */
export function segmentNotes(contour, sensitivity = 0.5) {
  const { midi, sal, hop, offset } = contour;
  const n = midi.length;
  const thr = quantile(sal, 0.6 - 0.5 * sensitivity);
  const voiced = new Uint8Array(n);
  for (let i = 0; i < n; i++) voiced[i] = sal[i] > thr && sal[i] > 0.01 ? 1 : 0;

  // 전체 튜닝 오프셋 (원곡이 A=440에서 살짝 벗어난 경우)
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) if (voiced[i]) {
    const a = 2 * Math.PI * (midi[i] - Math.round(midi[i]));
    sx += Math.cos(a) * sal[i]; sy += Math.sin(a) * sal[i];
  }
  const tuning = Math.atan2(sy, sx) / (2 * Math.PI);

  // 5프레임 중앙값 필터
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = [];
    for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < n && voiced[j]) w.push(midi[j]);
    w.sort((a, b) => a - b);
    sm[i] = w.length ? w[w.length >> 1] : midi[i];
  }

  const notes = [];
  const minFrames = Math.max(2, Math.round(0.09 / hop));
  let cur = null, gap = 0;
  const flush = () => {
    if (cur && cur.vals.length >= minFrames) {
      const v = cur.vals.slice().sort((a, b) => a - b);
      notes.push({
        start: offset + cur.s * hop,
        end: offset + (cur.e + 1) * hop,
        midi: Math.round(v[v.length >> 1] - tuning),
      });
    }
    cur = null; gap = 0;
  };
  for (let i = 0; i < n; i++) {
    if (!voiced[i]) {
      if (cur && ++gap > 3) flush();
      continue;
    }
    const m = sm[i];
    if (cur) {
      const v = cur.vals.slice(-8).sort((a, b) => a - b);
      const ref = v[v.length >> 1];
      if (Math.abs(m - ref) < 0.75) { cur.vals.push(m); cur.e = i; gap = 0; continue; }
      flush();
    }
    cur = { s: i, e: i, vals: [m] };
  }
  flush();

  // 같은 음 + 짧은 간격 병합
  const merged = [];
  for (const nt of notes) {
    const last = merged[merged.length - 1];
    if (last && last.midi === nt.midi && nt.start - last.end < 0.07) last.end = nt.end;
    else merged.push({ ...nt });
  }
  return merged;
}

/* ---------- 조성 추정 (Krumhansl-Kessler) ---------- */
const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a, b) {
  const ma = a.reduce((s, x) => s + x, 0) / 12, mb = b.reduce((s, x) => s + x, 0) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db || 1);
}

export function detectKey(notes) {
  const h = new Array(12).fill(0);
  for (const n of notes) h[pc(n.midi)] += n.end - n.start;
  let best = { tonic: 0, mode: 'major', score: -2 };
  for (let t = 0; t < 12; t++) {
    const rot = h.map((_, i) => h[(i + t) % 12]);
    const sMaj = corr(rot, KK_MAJ), sMin = corr(rot, KK_MIN);
    if (sMaj > best.score) best = { tonic: t, mode: 'major', score: sMaj };
    if (sMin > best.score) best = { tonic: t, mode: 'minor', score: sMin };
  }
  return { tonic: best.tonic, mode: best.mode };
}

/* ---------- 화음 생성 ---------- */
export const HARMONY_TYPES = [
  { id: 'third_up', label: '3도 위 — 가요에서 가장 흔한 화음', steps: 2 },
  { id: 'third_down', label: '3도 아래', steps: -2 },
  { id: 'sixth_down', label: '6도 아래 (3도 위를 한 옥타브 내림)', steps: -5 },
  { id: 'fifth_up', label: '5도 위', steps: 4 },
  { id: 'fourth_down', label: '4도 아래 (5도 위를 한 옥타브 내림)', steps: -3 },
  { id: 'octave_down', label: '옥타브 아래', steps: -7 },
  { id: 'octave_up', label: '옥타브 위', steps: 7 },
  { id: 'unison', label: '멜로디 그대로 (원음 연습)', steps: 0 },
];
const FALLBACK = { 2: [4, 3], '-2': [-3, -4], '-5': [-8, -9], 4: [7], '-3': [-5], 7: [12], '-7': [-12], 0: [0] };

export function scaleTonic(key) {
  return key.mode === 'minor' ? (key.tonic + 3) % 12 : key.tonic;
}

export function scaleShift(m, steps, majTonic) {
  const rel = m - majTonic;
  const oct = Math.floor(rel / 12);
  const idx = MAJOR.indexOf(((rel % 12) + 12) % 12);
  if (idx >= 0) {
    const d = oct * 7 + idx + steps;
    const no = Math.floor(d / 7), ni = ((d % 7) + 7) % 7;
    return majTonic + no * 12 + MAJOR[ni];
  }
  const cands = FALLBACK[steps] || [0];
  for (const c of cands) if (MAJOR.includes((((m + c - majTonic) % 12) + 12) % 12)) return m + c;
  return m + cands[0];
}

export function harmonize(notes, key, typeId, octaveShift = 0) {
  const t = HARMONY_TYPES.find((x) => x.id === typeId) || HARMONY_TYPES[0];
  const mt = scaleTonic(key);
  return notes.map((n) => ({ start: n.start, end: n.end, midi: scaleShift(n.midi, t.steps, mt) + 12 * octaveShift, mel: n.midi }));
}

export function noteAt(notes, t) {
  let lo = 0, hi = notes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].end < t) lo = mid + 1;
    else if (notes[mid].start > t) hi = mid - 1;
    else return notes[mid];
  }
  return null;
}

export function groupPhrases(notes, gap = 0.7) {
  const out = [];
  let cur = null;
  notes.forEach((n, i) => {
    if (!cur || n.start - cur.end > gap) { cur = { start: n.start, end: n.end, from: i, to: i }; out.push(cur); }
    else { cur.end = n.end; cur.to = i; }
  });
  return out;
}

export const fmtTime = (t) => {
  t = Math.max(0, t);
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
};
