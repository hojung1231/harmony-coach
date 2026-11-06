import * as db from './db.js';
import {
  segmentNotes, detectKey, harmonize, HARMONY_TYPES, noteAt, groupPhrases, scaleTonic,
  midiToLabel, keyName, fmtTime, NOTE_NAMES,
} from './music.js';
import { MicPitch, Voice } from './pitch.js';
import { drawGraph, rangeFor, COLORS } from './graph.js';

const $ = (s) => document.querySelector(s);
const audio = $('#audio');

/* ---------- 설정 ---------- */
const DEFAULTS = { tol: 35, latency: 120, octaveFree: true, aec: true, guideVol: 0.14 };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('hc-settings') || '{}') }; } catch {}
const saveSettings = () => { try { localStorage.setItem('hc-settings', JSON.stringify(settings)); } catch {} };

/* ---------- 공용 ---------- */
let actx, melVoice, harmVoice, mic;
function getCtx() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    melVoice = new Voice(actx, 'triangle');
    harmVoice = new Voice(actx, 'sine');
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
async function startMic() {
  getCtx();
  if (mic && mic.stream) return mic;
  mic = new MicPitch();
  await mic.start(actx, { aec: settings.aec });
  return mic;
}
function stopMic() { if (mic) mic.stop(); mic = null; }
function voicesOff() { melVoice && melVoice.off(); harmVoice && harmVoice.off(); }

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

let current = null; // 현재 곡
let harm = [];      // 현재 화음 음표
let rafId = 0;
const loop = (fn) => { cancelAnimationFrame(rafId); const f = () => { fn(); rafId = requestAnimationFrame(f); }; rafId = requestAnimationFrame(f); };

function show(id) {
  cancelAnimationFrame(rafId);
  if (id !== 'practice' && id !== 'step') stopMic();
  audio.pause(); voicesOff();
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
  const enter = { home: renderHome, editor: enterEditor, settings: enterSettings }[id];
  if (enter) enter();
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));

function rebuildHarm() {
  if (!current) return;
  harm = harmonize(current.notes, current.key, current.harmonyType, current.octaveShift);
}
async function saveCurrent() { if (current) await db.put(current); }

/* ---------- 홈 ---------- */
async function renderHome() {
  const songs = (await db.getAll()).sort((a, b) => b.createdAt - a.createdAt);
  const list = $('#songList'); list.innerHTML = '';
  $('#emptyMsg').classList.toggle('hidden', songs.length > 0);
  for (const s of songs) {
    const el = document.createElement('div');
    el.className = 'song';
    const ht = HARMONY_TYPES.find((h) => h.id === s.harmonyType);
    el.innerHTML = `<div><div class="t"></div><div class="s"></div></div><div class="badge"></div>`;
    el.querySelector('.t').textContent = s.name;
    el.querySelector('.s').textContent = `${keyName(s.key)} · ${ht ? ht.label.split(' —')[0] : ''} · ${fmtTime(s.duration || 0)}`;
    const b = el.querySelector('.badge');
    if (s.lastScore != null) { b.textContent = s.lastScore; b.style.color = s.lastScore >= 80 ? COLORS.good : s.lastScore >= 55 ? COLORS.warn : COLORS.bad; }
    el.onclick = () => openSong(s.id);
    list.appendChild(el);
  }
}
async function openSong(id) {
  current = await db.get(id);
  if (audio.src) URL.revokeObjectURL(audio.src);
  audio.src = URL.createObjectURL(current.blob);
  rebuildHarm();
  show('editor');
}

/* ---------- 노래 추가 ---------- */
$('#fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const name = $('#songName').value.trim() || f.name.replace(/\.[^.]+$/, '');
  e.target.value = '';
  analyzeBlob(f, name);
});

let rec = null;
$('#recBtn').addEventListener('click', async () => {
  if (rec) { rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const t0 = Date.now();
    const timer = setInterval(() => { $('#recTime').textContent = fmtTime((Date.now() - t0) / 1000); }, 250);
    rec.onstop = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      rec = null;
      $('#recBtn').textContent = '● 녹음 시작';
      const name = $('#songName').value.trim() || `녹음 ${new Date().toLocaleString('ko-KR')}`;
      analyzeBlob(blob, name);
    };
    rec.start(1000);
    $('#recBtn').textContent = '■ 녹음 끝내기';
    toast('다른 기기에서 노래를 재생하세요');
  } catch (err) {
    toast('마이크를 사용할 수 없어요: ' + err.message, 4000);
  }
});

async function analyzeBlob(blob, name) {
  show('analyze');
  const bar = $('#anaBar'), stage = $('#anaStage');
  bar.style.width = '0%'; stage.textContent = '음원 불러오는 중';
  try {
    const buf = await blob.arrayBuffer();
    const ctx = getCtx();
    const ab = await new Promise((res, rej) => ctx.decodeAudioData(buf, res, rej));
    stage.textContent = '보컬 멜로디 추출 중';
    const left = ab.getChannelData(0).slice();
    const right = ab.numberOfChannels > 1 ? ab.getChannelData(1).slice() : null;
    const contour = await new Promise((res, rej) => {
      const w = new Worker(new URL('./analyzer-worker.js', import.meta.url));
      w.onmessage = (e) => {
        if (e.data.type === 'progress') bar.style.width = `${Math.round(e.data.p * 100)}%`;
        else if (e.data.type === 'done') { w.terminate(); res(e.data.contour); }
        else { w.terminate(); rej(new Error(e.data.message)); }
      };
      w.onerror = (e) => { w.terminate(); rej(new Error(e.message || '분석 오류')); };
      w.postMessage({ left, right, sampleRate: ab.sampleRate }, right ? [left.buffer, right.buffer] : [left.buffer]);
    });
    stage.textContent = '화음 만드는 중';
    const notes = segmentNotes(contour, 0.5);
    if (!notes.length) throw new Error('멜로디를 찾지 못했어요. 다른 음원으로 시도해 보세요.');
    const key = detectKey(notes);
    current = {
      id: String(Date.now()), name, blob, duration: ab.duration, createdAt: Date.now(),
      contour, notes, key, harmonyType: 'third_up', octaveShift: 0, sensitivity: 0.5, edited: false, lastScore: null,
    };
    await db.put(current);
    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.src = URL.createObjectURL(blob);
    rebuildHarm();
    $('#songName').value = '';
    toast(`분석 완료! ${notes.length}개 음 · ${keyName(key)}`);
    show('editor');
  } catch (err) {
    console.error(err);
    toast('분석 실패: ' + err.message, 5000);
    show('import');
  }
}

/* ---------- 곡 설정 / 멜로디 편집 ---------- */
const ed = { t0: 0, span: 10, sel: -1, playing: false };
(() => {
  const ks = $('#edKey');
  for (let t = 0; t < 12; t++) for (const m of ['major', 'minor']) {
    const o = document.createElement('option'); o.value = `${t}:${m}`; o.textContent = keyName({ tonic: t, mode: m }); ks.appendChild(o);
  }
  const hs = $('#edHarm');
  for (const h of HARMONY_TYPES) { const o = document.createElement('option'); o.value = h.id; o.textContent = h.label; hs.appendChild(o); }
})();

function enterEditor() {
  if (!current) return show('home');
  $('#edTitle').textContent = current.name;
  $('#edKey').value = `${current.key.tonic}:${current.key.mode}`;
  $('#edHarm').value = current.harmonyType;
  $('#edOct').value = String(current.octaveShift);
  $('#edSens').value = current.sensitivity;
  ed.sel = -1; ed.playing = false; $('#edPlay').textContent = '▶ 미리듣기';
  updateNoteBar();
  if (current.notes.length) ed.t0 = Math.max(0, current.notes[0].start - 1);
  loop(drawEditor);
}
$('#edKey').onchange = (e) => { const [t, m] = e.target.value.split(':'); current.key = { tonic: +t, mode: m }; rebuildHarm(); saveCurrent(); };
$('#edHarm').onchange = (e) => { current.harmonyType = e.target.value; rebuildHarm(); saveCurrent(); };
$('#edOct').onchange = (e) => { current.octaveShift = +e.target.value; rebuildHarm(); saveCurrent(); };
$('#edSens').onchange = (e) => {
  if (current.edited && !confirm('감도를 바꾸면 직접 고친 음이 초기화돼요. 계속할까요?')) { e.target.value = current.sensitivity; return; }
  current.sensitivity = +e.target.value;
  current.notes = segmentNotes(current.contour, current.sensitivity);
  current.edited = false; ed.sel = -1; updateNoteBar();
  rebuildHarm(); saveCurrent();
  toast(`${current.notes.length}개 음`);
};
$('#edZoomIn').onclick = () => { ed.span = Math.max(3, ed.span / 1.5); };
$('#edZoomOut').onclick = () => { ed.span = Math.min(60, ed.span * 1.5); };
$('#edPlay').onclick = () => {
  getCtx();
  if (ed.playing) { audio.pause(); voicesOff(); ed.playing = false; $('#edPlay').textContent = '▶ 미리듣기'; return; }
  audio.muted = false; audio.playbackRate = 1;
  audio.currentTime = Math.max(0, ed.t0 + ed.span * 0.1);
  audio.play(); ed.playing = true; $('#edPlay').textContent = '⏸ 정지';
};
audio.addEventListener('ended', () => {
  if (ed.playing) { ed.playing = false; $('#edPlay').textContent = '▶ 미리듣기'; voicesOff(); }
});

let edGeo = null;
function drawEditor() {
  const cv = $('#edCanvas');
  if (ed.playing) {
    const t = audio.currentTime;
    if (t > ed.t0 + ed.span * 0.8 || t < ed.t0) ed.t0 = t - ed.span * 0.2;
    melVoice.set($('#edMelTone').checked ? (noteAt(current.notes, t) || {}).midi : null, 0.1);
    harmVoice.set($('#edHarmTone').checked ? (noteAt(harm, t) || {}).midi : null, settings.guideVol);
  }
  const t1 = ed.t0 + ed.span;
  const r = rangeFor([current.notes, harm], ed.t0, t1, 14) || { lo: 52, hi: 76 };
  edGeo = drawGraph(cv, {
    t0: ed.t0, t1, lo: r.lo, hi: r.hi, melody: current.notes, harm, tol: settings.tol,
    selected: ed.sel, now: ed.playing ? audio.currentTime : null, scaleTonic: scaleTonic(current.key),
  });
}
(() => {
  const cv = $('#edCanvas');
  let down = null;
  cv.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t0: ed.t0, moved: false }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    if (!down || !edGeo) return;
    const dx = e.clientX - down.x;
    if (Math.abs(dx) > 6) down.moved = true;
    if (down.moved) ed.t0 = Math.max(-1, down.t0 - (dx / (edGeo.w - edGeo.LM)) * ed.span);
  });
  cv.addEventListener('pointerup', (e) => {
    if (down && !down.moved && edGeo) {
      const rect = cv.getBoundingClientRect();
      const t = edGeo.tAt(e.clientX - rect.left), m = edGeo.mAt(e.clientY - rect.top);
      let best = -1, bd = Infinity;
      current.notes.forEach((n, i) => {
        const dt = t < n.start ? n.start - t : t > n.end ? t - n.end : 0;
        const d = dt * 8 + Math.abs(n.midi - m) * 0.5;
        if (d < bd) { bd = d; best = i; }
      });
      ed.sel = bd < 2.5 ? best : -1;
      updateNoteBar();
      if (ed.sel >= 0) { getCtx(); melVoice.set(current.notes[ed.sel].midi, 0.12); setTimeout(() => melVoice.off(), 350); }
    }
    down = null;
  });
})();
function updateNoteBar() {
  const n = current && current.notes[ed.sel];
  $('#edNoteBar').classList.toggle('hidden', !n);
  if (n) $('#edNoteInfo').textContent = `${midiToLabel(n.midi)} · ${fmtTime(n.start)}`;
}
document.querySelectorAll('[data-ed]').forEach((b) => b.addEventListener('click', () => {
  const n = current.notes[ed.sel];
  if (!n) return;
  if (b.dataset.ed === 'del') { current.notes.splice(ed.sel, 1); ed.sel = -1; }
  else { n.midi += +b.dataset.ed; getCtx(); melVoice.set(n.midi, 0.12); setTimeout(() => melVoice.off(), 350); }
  current.edited = true; rebuildHarm(); updateNoteBar(); saveCurrent();
}));
$('#edStart').onclick = () => startPractice(null);
$('#edStep').onclick = () => startStep(null);
$('#edDelete').onclick = async () => {
  if (!confirm(`'${current.name}'을(를) 삭제할까요?`)) return;
  await db.del(current.id); current = null; show('home');
};

/* ---------- 실시간 연습 (그래프) ---------- */
const pr = { range: null, frames: [], trace: [], full: [], live: null, lo: 55, hi: 72 };

async function startPractice(range) {
  pr.range = range; pr.frames = []; pr.trace = []; pr.full = []; pr.live = null; pr.lastTarget = null;
  show('practice');
  $('#prTitle').textContent = range ? `${current.name} · ${fmtTime(range.start)}~${fmtTime(range.end)}` : current.name;
  $('#prLoopWrap').classList.toggle('hidden', !range);
  $('#prPlay').textContent = '▶ 시작';
  audio.currentTime = range ? Math.max(0, range.start - 1.5) : 0;
  audio.playbackRate = +$('#prSpeed').value;
  audio.muted = !$('#prOrig').checked;
  try { await startMic(); } catch (err) { toast('마이크 권한이 필요해요: ' + err.message, 4000); }
  loop(practiceFrame);
}
$('#prSpeed').onchange = (e) => { audio.playbackRate = +e.target.value; };
$('#prOrig').onchange = (e) => { audio.muted = !e.target.checked; };
$('#prPlay').onclick = async () => {
  getCtx();
  if (!mic) { try { await startMic(); } catch (err) { return toast('마이크 권한이 필요해요', 3000); } }
  if (audio.paused) { await audio.play(); $('#prPlay').textContent = '⏸ 일시정지'; }
  else { audio.pause(); voicesOff(); $('#prPlay').textContent = '▶ 계속'; }
};
$('#prRestart').onclick = () => { audio.currentTime = pr.range ? Math.max(0, pr.range.start - 1.5) : 0; pr.trace = []; };
$('#prFinish').onclick = () => finishPractice();
$('#prBack').onclick = () => show('editor');
audio.addEventListener('ended', () => { if ($('#practice').classList.contains('active')) finishPractice(); });

function foldErr(sung, target) {
  let m = sung;
  if (settings.octaveFree) m = sung - 12 * Math.round((sung - target) / 12);
  return { m, e: (m - target) * 100 };
}

function practiceFrame() {
  const t = audio.currentTime, lat = settings.latency / 1000;
  const tc = t - lat * audio.playbackRate;
  const playing = !audio.paused;
  const sung = mic ? mic.read() : null;
  const tgt = noteAt(harm, tc);

  pr.live = null;
  if (sung != null) {
    const p = tgt ? { t: tc, ...foldErr(sung, tgt.midi) } : { t: tc, m: sung, e: null };
    if (!tgt && pr.lastTarget != null && settings.octaveFree) p.m = sung - 12 * Math.round((sung - pr.lastTarget) / 12);
    pr.live = p;
    if (playing) { pr.trace.push(p); pr.full.push(p); }
  }
  if (tgt) pr.lastTarget = tgt.midi;
  if (playing && tgt) pr.frames.push({ t: tc, target: tgt.midi, e: pr.live ? pr.live.e : null });
  if (pr.trace.length > 4000) pr.trace.splice(0, 1000);

  // 가이드음
  if (playing) {
    const nowH = noteAt(harm, t), nowM = noteAt(current.notes, t);
    harmVoice.set($('#prGuide').checked && nowH ? nowH.midi : null, settings.guideVol);
    melVoice.set($('#prMel').checked && nowM ? nowM.midi : null, 0.1);
  }
  // 구간 반복
  if (pr.range && playing && t > pr.range.end + 0.6) {
    if ($('#prLoop').checked) { audio.currentTime = Math.max(0, pr.range.start - 1.5); pr.trace = []; }
    else { finishPractice(); return; }
  }

  // 화면
  $('#prTime').textContent = `${fmtTime(t)} / ${fmtTime(current.duration)}`;
  $('#prTarget').textContent = tgt ? `목표 ${midiToLabel(tgt.midi)}` : '목표 — (쉬는 구간)';
  const sEl = $('#prSung');
  if (pr.live && pr.live.e != null) {
    const c = Math.round(pr.live.e);
    sEl.textContent = `${c > 0 ? '+' : ''}${c}¢`;
    sEl.style.color = Math.abs(c) <= settings.tol ? COLORS.good : Math.abs(c) <= settings.tol * 2.5 ? COLORS.warn : COLORS.bad;
  } else { sEl.textContent = pr.live ? midiToLabel(pr.live.m) : '내 음 -'; sEl.style.color = ''; }

  const t0 = t - 3.5, t1 = t + 3.5;
  const r = rangeFor([harm], t0, t1, 12);
  if (r) { pr.lo += (r.lo - pr.lo) * 0.05; pr.hi += (r.hi - pr.hi) * 0.05; }
  drawGraph($('#prCanvas'), {
    t0, t1, lo: pr.lo, hi: pr.hi, harm, melody: $('#prMel').checked ? current.notes : null,
    trace: pr.trace, now: tc, live: pr.live, tol: settings.tol, scaleTonic: scaleTonic(current.key),
  });
}

/* ---------- 리뷰 ---------- */
const rv = { notes: [], phrases: [], sel: 0, frames: [], range: null, stats: [] };

function finishPractice() {
  cancelAnimationFrame(rafId);
  audio.pause(); voicesOff(); stopMic();
  if (!pr.frames.length) { toast('기록된 노래가 없어요'); show('editor'); return; }
  computeReview();
  show('review');
  renderReview();
}

function computeReview() {
  const tol = settings.tol;
  const fr = pr.frames.slice().sort((a, b) => a.t - b.t);
  const lo = fr[0].t, hi = fr[fr.length - 1].t;
  const notes = harm.map((n, i) => ({ ...n, i })).filter((n) => n.end > lo && n.start < hi);
  let fi = 0;
  const stats = notes.map((n) => {
    while (fi < fr.length && fr[fi].t < n.start) fi++;
    const errs = []; let tot = 0, good = 0;
    for (let j = fi; j < fr.length && fr[j].t <= n.end; j++) {
      if (fr[j].t < n.start + Math.min(0.08, (n.end - n.start) * 0.25)) continue;
      tot++;
      if (fr[j].e != null) { errs.push(fr[j].e); if (Math.abs(fr[j].e) <= tol) good++; }
    }
    errs.sort((a, b) => a - b);
    const med = errs.length ? errs[errs.length >> 1] : null;
    const score = tot ? good / tot : 0;
    const sungRatio = tot ? errs.length / tot : 0;
    let verdict;
    if (!tot) verdict = 'none';
    else if (sungRatio < 0.3) verdict = 'silent';
    else if (score >= 0.65) verdict = 'good';
    else if (med > tol) verdict = 'high';
    else if (med < -tol) verdict = 'low';
    else verdict = 'unstable';
    return { note: n, score, med, verdict, dur: n.end - n.start, tot };
  }).filter((s) => s.tot > 0);
  rv.stats = stats;
  rv.frames = fr;
  const phrases = groupPhrases(stats.map((s) => s.note));
  rv.phrases = phrases.map((p) => {
    const ss = stats.slice(p.from, p.to + 1);
    const w = ss.reduce((a, s) => a + s.dur, 0) || 1;
    return { ...p, stats: ss, score: Math.round((100 * ss.reduce((a, s) => a + s.score * s.dur, 0)) / w) };
  });
  const W = stats.reduce((a, s) => a + s.dur, 0) || 1;
  rv.score = Math.round((100 * stats.reduce((a, s) => a + s.score * s.dur, 0)) / W);
  rv.sel = 0;
  rv.trace = pr.full;
}

const scoreColor = (s) => (s >= 80 ? COLORS.good : s >= 55 ? COLORS.warn : COLORS.bad);
const VERDICT = {
  good: '정확해요 👍', high: '높게 불렀어요 → 조금 내리세요', low: '낮게 불렀어요 → 조금 올리세요',
  unstable: '음이 흔들려요', silent: '거의 안 불렀어요', none: '-',
};

function renderReview() {
  $('#rvScore').textContent = rv.score;
  $('#rvScore').style.color = scoreColor(rv.score);
  const c = { good: 0, high: 0, low: 0, unstable: 0, silent: 0 };
  rv.stats.forEach((s) => c[s.verdict] != null && c[s.verdict]++);
  $('#rvSummary').textContent = `음 ${rv.stats.length}개 중 정확 ${c.good} · 높음 ${c.high} · 낮음 ${c.low} · 흔들림 ${c.unstable} · 안 부름 ${c.silent}`;
  current.lastScore = rv.score; saveCurrent();

  const strip = $('#rvStrip'); strip.innerHTML = '';
  rv.phrases.forEach((p, i) => {
    const b = document.createElement('button');
    b.textContent = `${i + 1}\n${p.score}`;
    b.style.whiteSpace = 'pre';
    b.style.borderColor = scoreColor(p.score);
    b.onclick = () => { rv.sel = i; renderPhrase(); };
    strip.appendChild(b);
  });
  // 가장 못한 구간을 기본 선택
  let worst = 0;
  rv.phrases.forEach((p, i) => { if (p.score < rv.phrases[worst].score) worst = i; });
  rv.sel = worst;
  renderPhrase();
}

let rvGeo = null;
function renderPhrase() {
  const p = rv.phrases[rv.sel];
  [...$('#rvStrip').children].forEach((b, i) => b.classList.toggle('sel', i === rv.sel));
  if (!p) return;
  const t0 = p.start - 0.4, t1 = p.end + 0.4;
  const notes = p.stats.map((s) => s.note);
  const colors = {};
  const hn = p.stats.map((s, k) => { colors[k] = s.verdict === 'good' ? COLORS.good : s.verdict === 'silent' ? '#888888' : s.verdict === 'unstable' ? COLORS.warn : COLORS.bad; return s.note; });
  const r = rangeFor([notes], t0, t1, 10);
  rvGeo = drawGraph($('#rvCanvas'), {
    t0, t1, lo: r.lo, hi: r.hi, harm: hn, noteColors: colors, melody: current.notes,
    trace: (rv.trace || []).filter((x) => x.t >= t0 && x.t <= t1), tol: settings.tol, scaleTonic: scaleTonic(current.key),
  });
  const bad = p.stats.filter((s) => s.verdict !== 'good');
  $('#rvDetail').innerHTML = `<b>${rv.sel + 1}번 구간</b> (${fmtTime(p.start)}~${fmtTime(p.end)}) · ${p.score}점<br>` +
    (bad.length ? bad.slice(0, 6).map((s) => `${midiToLabel(s.note.midi)}: ${VERDICT[s.verdict]}${s.med != null && s.verdict !== 'silent' ? ` (${s.med > 0 ? '+' : ''}${Math.round(s.med)}¢)` : ''}`).join('<br>') : '모든 음이 정확했어요! 🎉') +
    '<br><span class="small">그래프의 음을 누르면 그 음의 결과를 볼 수 있어요.</span>';
}
$('#rvCanvas').addEventListener('click', (e) => {
  const p = rv.phrases[rv.sel];
  if (!p || !rvGeo) return;
  const rect = e.target.getBoundingClientRect();
  const t = rvGeo.tAt(e.clientX - rect.left);
  const s = p.stats.find((s) => t >= s.note.start - 0.05 && t <= s.note.end + 0.05);
  if (!s) return;
  getCtx(); harmVoice.set(s.note.midi, settings.guideVol); setTimeout(() => harmVoice.off(), 600);
  $('#rvDetail').innerHTML = `<b>${midiToLabel(s.note.midi)}</b> (${fmtTime(s.note.start)})<br>${VERDICT[s.verdict]}` +
    (s.med != null ? `<br>평균 오차 ${s.med > 0 ? '+' : ''}${Math.round(s.med)}센트 · 정확도 ${Math.round(s.score * 100)}%` : '') +
    `<br>원곡 멜로디: ${midiToLabel(s.note.mel)}`;
});
$('#rvPractice').onclick = () => { const p = rv.phrases[rv.sel]; if (p) startPractice({ start: p.start, end: p.end }); };
$('#rvStep').onclick = () => { const p = rv.phrases[rv.sel]; if (p) startStep({ start: p.start, end: p.end }); };
$('#rvAgain').onclick = () => startPractice(null);

/* ---------- 한 음씩 연습 ---------- */
const st = { notes: [], i: 0, trace: [], hold: 0, done: false, lastT: 0, lo: 55, hi: 70 };

async function startStep(range) {
  st.notes = range ? harm.filter((n) => n.end > range.start && n.start < range.end) : harm.slice();
  if (!st.notes.length) return toast('연습할 음이 없어요');
  st.i = 0; resetStepNote();
  show('step');
  try { await startMic(); } catch (err) { toast('마이크 권한이 필요해요: ' + err.message, 4000); }
  loop(stepFrame);
}
function resetStepNote() {
  st.trace = []; st.hold = 0; st.done = false; st.lastT = performance.now() / 1000;
  const n = st.notes[st.i];
  if (n) { const c = (n.midi + n.mel) / 2; st.lo = Math.min(n.midi, n.mel) - 4; st.hi = Math.max(n.midi, n.mel) + 4; if (st.hi - st.lo < 10) { st.lo = c - 5; st.hi = c + 5; } }
}
function playRef() {
  const n = st.notes[st.i]; if (!n) return;
  getCtx(); harmVoice.set(n.midi, settings.guideVol * 1.3);
  clearTimeout(playRef._t);
  playRef._t = setTimeout(() => { if (!$('#stGuideOn').checked) harmVoice.off(); }, 1200);
}
$('#stRef').onclick = playRef;
$('#stPrev').onclick = () => { if (st.i > 0) { st.i--; resetStepNote(); playRef(); } };
$('#stNext').onclick = () => { if (st.i < st.notes.length - 1) { st.i++; resetStepNote(); playRef(); } else toast('마지막 음이에요'); };

function stepFrame() {
  const now = performance.now() / 1000, dt = Math.min(0.1, now - st.lastT); st.lastT = now;
  const n = st.notes[st.i];
  const sung = mic ? mic.read() : null;
  let live = null;
  if (sung != null) { live = { t: now, ...foldErr(sung, n.midi) }; st.trace.push(live); }
  if (st.trace.length > 1500) st.trace.splice(0, 500);
  if (!st.done) {
    if (live && Math.abs(live.e) <= settings.tol) st.hold += dt; else st.hold = Math.max(0, st.hold - dt * 0.5);
    if (st.hold >= 0.6) {
      st.done = true;
      toast('좋아요! ✓', 800);
      if ($('#stAuto').checked) setTimeout(() => {
        if (!$('#step').classList.contains('active')) return;
        if (st.i < st.notes.length - 1) { st.i++; resetStepNote(); playRef(); } else toast('구간 완료! 🎉', 2500);
      }, 500);
    }
  }
  melVoice.set($('#stMelOn').checked ? n.mel : null, 0.09);
  if ($('#stGuideOn').checked) harmVoice.set(n.midi, settings.guideVol);

  $('#stCount').textContent = `${st.i + 1} / ${st.notes.length}`;
  $('#stTarget').textContent = `목표 ${midiToLabel(n.midi)}`;
  $('#stMel').textContent = `멜로디 ${midiToLabel(n.mel)}`;
  $('#stHold').style.width = `${Math.min(100, (st.hold / 0.6) * 100)}%`;
  $('#stHold').style.background = st.done ? COLORS.good : COLORS.harmLine;

  const next = st.notes[st.i + 1], prev = st.notes[st.i - 1];
  const view = [
    prev && { start: now - 6, end: now - 4.2, midi: prev.midi, mel: prev.mel },
    { start: now - 4, end: now + 1, midi: n.midi, mel: n.mel },
    next && { start: now + 1.3, end: now + 3, midi: next.midi, mel: next.mel },
  ].filter(Boolean);
  drawGraph($('#stCanvas'), {
    t0: now - 4, t1: now + 3, lo: st.lo, hi: st.hi, harm: view,
    melody: $('#stMelOn').checked ? view.map((v) => ({ start: v.start, end: v.end, midi: v.mel })) : null,
    noteColors: { 0: prev ? '#555a7a' : undefined }, trace: st.trace, now, live, tol: settings.tol, scaleTonic: scaleTonic(current.key),
  });
}
$('#stGuideOn').onchange = (e) => { if (!e.target.checked) harmVoice.off(); };

/* ---------- 설정 ---------- */
function enterSettings() {
  $('#setTol').value = settings.tol; $('#setLat').value = settings.latency;
  $('#setOct').checked = settings.octaveFree; $('#setAec').checked = settings.aec; $('#setVol').value = settings.guideVol;
}
$('#setTol').onchange = (e) => { settings.tol = Math.max(10, +e.target.value || 35); saveSettings(); };
$('#setLat').onchange = (e) => { settings.latency = Math.max(0, +e.target.value || 0); saveSettings(); };
$('#setOct').onchange = (e) => { settings.octaveFree = e.target.checked; saveSettings(); };
$('#setAec').onchange = (e) => { settings.aec = e.target.checked; saveSettings(); stopMic(); };
$('#setVol').onchange = (e) => { settings.guideVol = +e.target.value; saveSettings(); };
$('#micTest').onclick = async () => {
  try {
    await startMic();
    const end = Date.now() + 8000;
    const tick = () => {
      if (!$('#settings').classList.contains('active') || Date.now() > end) { stopMic(); $('#micOut').textContent += ' (종료)'; return; }
      const m = mic && mic.read();
      $('#micOut').textContent = m != null ? `${midiToLabel(m)} ${Math.round((m - Math.round(m)) * 100)}¢` : '소리 없음';
      requestAnimationFrame(tick);
    };
    tick();
  } catch (err) { toast('마이크 오류: ' + err.message); }
};

/* ---------- PWA ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
renderHome();
