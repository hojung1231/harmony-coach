// 음높이 그래프 렌더러: 목표 화음(밴드) + 멜로디 + 내 목소리 궤적
import { NOTE_NAMES, SOLFEGE } from './music.js';

const C = {
  bg: '#0f1220', grid: '#1f2438', gridC: '#323a5a', label: '#6c7499',
  mel: 'rgba(160,168,200,0.35)', harm: 'rgba(80,150,255,0.30)', harmLine: '#5aa0ff',
  good: '#3ddc84', warn: '#ffc93c', bad: '#ff5c6c', none: 'rgba(255,255,255,0.55)', now: '#ffffff', sel: '#ff9f43',
};
export const COLORS = C;

export function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

export const errColor = (e, tol) => (e == null ? C.none : Math.abs(e) <= tol ? C.good : Math.abs(e) <= tol * 2.5 ? C.warn : C.bad);

/**
 * o: { t0, t1, lo, hi, melody, harm, trace, now, tol, selected, noteColors, scaleTonic }
 */
export function drawGraph(cv, o) {
  const { g, w, h } = fitCanvas(cv);
  const LM = 40;
  const X = (t) => LM + ((t - o.t0) / (o.t1 - o.t0)) * (w - LM);
  const Y = (m) => h - ((m - o.lo) / (o.hi - o.lo)) * h;
  const semi = h / (o.hi - o.lo);
  g.fillStyle = C.bg; g.fillRect(0, 0, w, h);

  // 반음 격자
  g.font = '10px system-ui, sans-serif'; g.textBaseline = 'middle';
  for (let m = Math.ceil(o.lo); m <= Math.floor(o.hi); m++) {
    const p = ((m % 12) + 12) % 12, y = Y(m);
    const inScale = o.scaleTonic == null || [0, 2, 4, 5, 7, 9, 11].includes((p - o.scaleTonic + 12) % 12);
    g.strokeStyle = p === 0 ? C.gridC : C.grid; g.lineWidth = 1;
    if (inScale || semi > 14) { g.beginPath(); g.moveTo(LM, y); g.lineTo(w, y); g.stroke(); }
    if (semi > 9 || p === 0) {
      g.fillStyle = inScale ? C.label : '#454b69';
      g.fillText(semi > 13 ? `${NOTE_NAMES[p]}${Math.floor(m / 12) - 1} ${SOLFEGE[p]}` : `${NOTE_NAMES[p]}${Math.floor(m / 12) - 1}`, 2, y);
    }
  }

  const vis = (n) => n.end >= o.t0 && n.start <= o.t1;
  // 멜로디 (원곡 주선율)
  if (o.melody) {
    g.fillStyle = C.mel;
    o.melody.forEach((n, i) => {
      if (!vis(n)) return;
      const x0 = X(n.start), x1 = X(n.end);
      g.fillStyle = o.selected === i ? C.sel : C.mel;
      g.fillRect(x0, Y(n.midi) - Math.max(2, semi * 0.18), Math.max(1, x1 - x0), Math.max(4, semi * 0.36));
    });
  }
  // 목표 화음: 허용범위 밴드 + 중심선
  if (o.harm) {
    const band = Math.max(3, (semi * (o.tol || 35)) / 100);
    o.harm.forEach((n, i) => {
      if (!vis(n)) return;
      const x0 = X(n.start), x1 = X(n.end), y = Y(n.midi);
      const col = o.noteColors && o.noteColors[i];
      g.fillStyle = col ? col + '44' : C.harm;
      g.fillRect(x0, y - band, Math.max(1, x1 - x0), band * 2);
      g.strokeStyle = col || C.harmLine; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    });
  }
  // 내 목소리 궤적
  if (o.trace && o.trace.length) {
    g.lineWidth = 3.5; g.lineCap = 'round';
    let prev = null;
    for (const p of o.trace) {
      if (p.t < o.t0 - 0.2 || p.t > o.t1 + 0.2) { prev = null; continue; }
      if (prev && p.t - prev.t < 0.12 && p.t >= prev.t) {
        g.strokeStyle = errColor(p.e, o.tol || 35);
        g.beginPath(); g.moveTo(X(prev.t), Y(prev.m)); g.lineTo(X(p.t), Y(p.m)); g.stroke();
      } else {
        g.fillStyle = errColor(p.e, o.tol || 35);
        g.beginPath(); g.arc(X(p.t), Y(p.m), 1.8, 0, 7); g.fill();
      }
      prev = p;
    }
  }
  if (o.now != null) {
    const x = X(o.now);
    g.strokeStyle = C.now; g.globalAlpha = 0.6; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.globalAlpha = 1;
  }
  if (o.live != null) {
    // 현재 내 음 위치 마커
    const x = X(o.now), y = Y(o.live.m);
    g.fillStyle = errColor(o.live.e, o.tol || 35);
    g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill();
    g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke();
  }
  return { X, Y, LM, w, h, tAt: (px) => o.t0 + ((px - LM) / (w - LM)) * (o.t1 - o.t0), mAt: (py) => o.lo + ((h - py) / h) * (o.hi - o.lo) };
}

export function rangeFor(notesList, t0, t1, minSpan = 12) {
  let lo = Infinity, hi = -Infinity;
  for (const notes of notesList) if (notes) for (const n of notes) {
    if (n.end < t0 || n.start > t1) continue;
    lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi);
  }
  if (!isFinite(lo)) return null;
  lo -= 3; hi += 3;
  if (hi - lo < minSpan) { const c = (lo + hi) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
  return { lo, hi };
}
