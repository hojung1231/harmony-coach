// 화음 코치 2.0 — 악보 기반 화음 연습 (원곡 없이 화음음 + 가사)
import * as db from './db.js';
import { MicPitch, Voice } from './pitch.js';
import { APP_VERSION, checkUpdate, applyUpdate } from './update.js';

const $ = (s) => document.querySelector(s);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SOL = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
const pcOf = (m) => ((Math.round(m) % 12) + 12) % 12;
const noteLabel = (m) => `${NAMES[pcOf(m)]}${Math.floor(Math.round(m) / 12) - 1} (${SOL[pcOf(m)]})`;
const fmt = (t) => `${Math.floor(Math.max(0, t) / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, '0')}`;

/* ---------- 설정 ---------- */
const DEF = { tol: 50, octaveFree: true, vol: 0.3, melVol: 0.3, aec: false, orig: false, speed: 1, mel: true, harm: 'third_up', tone: true };
let S = { ...DEF };
try { S = { ...DEF, ...JSON.parse(localStorage.getItem('hc2') || '{}') }; } catch {}
const save = () => { try { localStorage.setItem('hc2', JSON.stringify(S)); } catch {} };
if (!S.sv || S.sv < 3) { S.vol = DEF.vol; S.melVol = DEF.melVol; S.aec = false; S.mel = true; S.sv = 3; save(); }   // 2.3: 소리 크게, 멜로디음 기본 켬

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- 화면 전환 ---------- */
let raf = 0;
function show(id) {
  cancelAnimationFrame(raf);
  if (id !== 'play') stopPlay();
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'home') renderHome();
  if (id === 'settings') renderSettings();
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));

/* ---------- 가사 → 음절 ---------- */
function wordSyllables(w) {
  if (/[가-힣]/.test(w)) return [...w].filter((ch) => /[가-힣]/.test(ch));
  const clean = w.replace(/[^A-Za-z']/g, '');
  if (!clean) return [];
  const n = Math.max(1, (clean.toLowerCase().replace(/e$/, '').match(/[aeiouy]+/g) || []).length);
  if (n === 1) return [w];
  const k = Math.ceil(w.length / n), out = [];
  for (let i = 0; i < n; i++) out.push(w.slice(i * k, (i + 1) * k));
  return out.filter(Boolean);
}
function lineWords(text) {
  return text.replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean).map((w) => wordSyllables(w)).filter((x) => x.length);
}
/** 가사 텍스트를 악보 음표에 붙임 → [{from,to,words:[[{s,i}]]}] */
function attachLyrics(song, text) {
  const sylIdx = song.notes.map((n, i) => (n[3] ? i : -1)).filter((i) => i >= 0);
  const lines = []; let p = 0;
  for (const raw of text.split('\n')) {
    const t = raw.trim(); if (!t) continue;
    const words = lineWords(t); if (!words.length) continue;
    const ws = words.map((w) => w.map((s) => ({ s, i: sylIdx[p++] ?? -1 })));
    const idx = ws.flat().map((x) => x.i).filter((i) => i >= 0);
    if (!idx.length) continue;
    let to = idx[idx.length - 1];
    while (to + 1 < song.notes.length && !song.notes[to + 1][3]) to++;
    lines.push({ from: idx[0], to, words: ws });
  }
  return { lines, used: p, need: sylIdx.length };
}
function countSyl(text) { return text.split('\n').reduce((a, l) => a + lineWords(l).flat().length, 0); }

/* ---------- 곡 목록 ---------- */
let builtin = null;
async function loadBuiltin() {
  if (!builtin) builtin = await (await fetch('songs/sooknyeo.json')).json();
  return builtin;
}
async function allSongs() {
  const list = [];
  try { list.push(await loadBuiltin()); } catch {}
  for (const s of await db.getAll()) if (s.format === 'harmony-coach-song') list.push(s);
  return list;
}
async function renderHome() {
  const box = $('#songList'); box.innerHTML = '';
  for (const s of await allSongs()) {
    const el = document.createElement('div');
    el.className = 'song';
    el.innerHTML = '<div><div class="t"></div><div class="s"></div></div><div class="go">▶</div>';
    el.querySelector('.t').textContent = s.title;
    el.querySelector('.s').textContent = `${s.artist || ''}${s.key ? ' · ' + s.key : ''}${s.builtin ? ' · 기본곡' : ''}`;
    el.onclick = () => openSong(s);
    box.appendChild(el);
  }
}
$('#songFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (s.format !== 'harmony-coach-song' || !Array.isArray(s.notes) || !s.harmony) throw new Error('화음 코치 곡 파일이 아니에요');
    s.id = s.id && s.id !== 'builtin-sooknyeo' ? s.id : `song-${Date.now()}`;
    s.builtin = false;
    await db.put(s);
    toast(`'${s.title}'을(를) 추가했어요`);
    renderHome();
  } catch (err) { toast('추가 실패: ' + err.message, 3500); }
});

/* ---------- 가사 넣기 ---------- */
let current = null, lyr = null;
async function lyricsOf(song) {
  if (song.lines && song.notes.some((n) => typeof n[3] === 'string')) {
    // 곡 파일에 가사가 들어 있는 경우
    return song.lines.map(([a, b, t]) => t).join('\n');
  }
  const r = await db.get('lyrics:' + song.id);
  return r ? r.text : null;
}
async function openSong(song) {
  current = song;
  const text = await lyricsOf(song);
  if (!text) {
    $('#lyTitle').textContent = `${song.title} 가사`;
    $('#lyText').value = '';
    checkLyrics();
    show('lyrics');
    return;
  }
  startPlay(text);
}
function checkLyrics() {
  if (!current) return;
  const need = current.notes.filter((n) => n[3]).length, got = countSyl($('#lyText').value);
  $('#lyCheck').textContent = !got ? `악보 음절 ${need}개` : got === need ? `✓ 음절 ${got}개 — 악보와 딱 맞아요` : `음절 ${got}개 / 악보 ${need}개 — 조금 다르지만 그대로 쓸 수 있어요`;
}
$('#lyText').addEventListener('input', checkLyrics);
$('#lySave').onclick = async () => {
  const text = $('#lyText').value.trim();
  if (!text) return toast('가사를 붙여넣어 주세요');
  await db.put({ id: 'lyrics:' + current.id, text });
  startPlay(text);
};

/* ---------- 연습 ---------- */
let actx, voice, melVoice, mic;
const P = { t: 0, playing: false, base: 0, baseT: 0, hist: [], state: 'none', pend: 'none', pendN: 0, hit: 0, tot: 0, end: 0 };

function getCtx() {
  // 아이폰: 무음 모드에서도 소리 나게 + 마이크와 함께 쓰기
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
  if (!actx) { actx = new (window.AudioContext || window.webkitAudioContext)(); voice = new Voice(actx, 'saw'); melVoice = new Voice(actx, 'sine'); }
  if (actx.state !== 'running') actx.resume();
  return actx;
}
function rate() { return S.speed || 1; }
/* 타임라인: 기본 = 악보 리듬(일정 템포), 원곡 모드 = 원곡 녹음에 정렬된 시간 */
const origEl = document.createElement('audio'); origEl.preload = 'auto'; origEl.setAttribute('playsinline', '');
let TL = [], origUrl = null;
const ORIG = () => S.orig && rate() === 1 && !!origUrl && !!current && !!current.orig;
function buildTL() {
  TL = ORIG() ? current.orig : current.notes.map((n) => [n[0], n[1]]);
  const last = TL[TL.length - 1];
  P.end = ORIG() ? (origEl.duration || current.origDuration || last[0] + last[1] + 1) : last[0] + last[1] + 1;
}
function now() {
  if (ORIG()) return origEl.currentTime;
  return P.playing ? P.baseT + ((performance.now() - P.base) / 1000) * rate() : P.t;
}
// 시간 ↔ 악보 위치(8분음표) — 두 타임라인 사이를 오갈 때 같은 자리 유지
function eighthAt(t, tl = TL) {
  const N = current.notes;
  if (!N[0] || N[0][4] == null) return t / (current.eighth || 0.28);
  if (t <= tl[0][0]) return N[0][4] - (tl[0][0] - t) / (current.eighth || 0.28);
  for (let i = 0; i < N.length; i++) {
    const [s, d] = tl[i], e = N[i][4], de = N[i][5];
    if (t < s + d) return e + ((t - s) / d) * de;
    const nx = tl[i + 1];
    if (!nx || t < nx[0]) { if (!nx) return e + de + (t - s - d) / (current.eighth || 0.28); return e + de + ((t - s - d) / (nx[0] - s - d)) * (N[i + 1][4] - e - de); }
  }
  return 0;
}
function timeAtEighth(x, tl = TL) {
  const N = current.notes;
  if (!N[0] || N[0][4] == null) return x * (current.eighth || 0.28);
  if (x <= N[0][4]) return Math.max(0, tl[0][0] - (N[0][4] - x) * (current.eighth || 0.28));
  for (let i = 0; i < N.length; i++) {
    const [s, d] = tl[i], e = N[i][4], de = N[i][5];
    if (x < e + de) return s + ((x - e) / de) * d;
    const nx = N[i + 1];
    if (!nx || x < nx[4]) { if (!nx) return s + d; return s + d + ((x - e - de) / (nx[4] - e - de)) * (tl[i + 1][0] - s - d); }
  }
  return 0;
}
// 모드 바꾸기 (재생 위치 유지)
function switchMode(fn) {
  const wasPlaying = P.playing, atStart = now() <= 0.01, pos = eighthAt(now());
  if (ORIG()) origEl.pause();
  fn();
  buildTL();
  const t = atStart ? 0 : timeAtEighth(pos);   // 처음이면 원곡도 처음(전주)부터
  if (ORIG()) { origEl.currentTime = t; if (wasPlaying) origEl.play().catch(() => {}); }
  else { P.t = t; P.baseT = t; P.base = performance.now(); }
  P.playing = wasPlaying;
  syncButtons();
}
async function loadOrig() {
  if (origUrl) { URL.revokeObjectURL(origUrl); origUrl = null; }
  const r = current && await db.get('audio:' + current.id);
  if (r && r.blob) { origUrl = URL.createObjectURL(r.blob); origEl.src = origUrl; }
  else origEl.removeAttribute('src');
}

function startPlay(text) {
  lyr = attachLyrics(current, text);
  buildNoteSyl();
  buildTL();
  loadOrig().then(() => { buildTL(); syncButtons(); });
  P.t = 0; P.playing = false; P.hit = 0; P.tot = 0; P.hist = []; setState('none');
  $('#plTitle').textContent = current.title;
  $('#plPlay').textContent = '▶';
  syncButtons();
  show('play');
  raf = requestAnimationFrame(frame);
}
function stopPlay() {
  P.playing = false;
  origEl.pause();
  if (voice) voice.off();
  if (melVoice) melVoice.off();
  if (mic) { mic.stop(); mic = null; }
}
async function togglePlay() {
  getCtx();
  if (!mic) {
    try { mic = new MicPitch(); await mic.start(actx, { aec: S.aec }); }
    catch (err) { mic = null; toast('마이크를 허용해 주세요', 3000); }
    try { await actx.resume(); } catch {}   // 마이크 켤 때 소리가 멈추는 기기 대비
  }
  if (P.playing) { P.t = now(); P.playing = false; origEl.pause(); voice.off(); melVoice.off(); $('#plPlay').textContent = '▶'; }
  else {
    if (now() >= P.end - 0.05) { P.t = 0; P.hit = 0; P.tot = 0; if (ORIG()) origEl.currentTime = 0; }
    P.baseT = P.t; P.base = performance.now(); P.playing = true; $('#plPlay').textContent = '⏸';
    if (ORIG()) { try { await origEl.play(); } catch (e) { toast('원곡을 재생할 수 없어요: ' + e.message); } }
  }
}
$('#plPlay').onclick = togglePlay;
$('#plRestart').onclick = () => { P.t = 0; P.baseT = 0; P.base = performance.now(); P.hit = 0; P.tot = 0; origEl.currentTime = 0; };
$('#plTone').onclick = () => { S.tone = !S.tone; save(); syncButtons(); toast(S.tone ? '화음음 켬' : '화음음 끔', 900); };
$('#plMel').onclick = () => { S.mel = !S.mel; save(); syncButtons(); toast(S.mel ? '멜로디음 켬' : '멜로디음 끔', 900); };
document.querySelectorAll('#speedSeg button').forEach((b) => b.onclick = () => {
  const r = +b.dataset.r;
  if (r !== 1 && ORIG()) toast('원곡은 1배에서만 나와요. 화음음·멜로디음으로 연습해요.', 2500);
  switchMode(() => { S.speed = r; if (r !== 1) S.orig = false; save(); });
});
// 원곡 버튼: 처음엔 폰의 음원 파일을 한 번 연결
$('#plOrig').onclick = () => {
  if (!origUrl) { $('#origFile').click(); return; }
  const on = !ORIG();
  switchMode(() => { S.orig = on; if (on) S.speed = 1; save(); });
  toast(on ? '원곡 켬 (원곡 박자에 맞춰 진행)' : '원곡 끔 (악보 박자로 진행)', 1800);
};
$('#origFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const dur = await new Promise((res) => { const a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(null); a.src = URL.createObjectURL(f); });
  if (dur == null) return toast('이 파일은 재생할 수 없어요');
  await db.put({ id: 'audio:' + current.id, blob: f, name: f.name, duration: dur });
  await loadOrig();
  const diff = current.origDuration ? Math.abs(dur - current.origDuration) : 0;
  switchMode(() => { S.orig = true; S.speed = 1; save(); });
  toast(diff > 3 ? `원곡을 연결했어요. 길이가 ${fmt(dur)}로 맞춘 음원(${fmt(current.origDuration)})과 달라 박자가 어긋날 수 있어요.` : '원곡을 연결했어요. 1배에서 원곡과 함께 연습해요.', 4000);
});
origEl.addEventListener('ended', () => { if (P.playing && ORIG()) finish(); });
$('#plBack').onclick = () => show('home');
document.querySelectorAll('#harmSeg button').forEach((b) => b.onclick = () => { S.harm = b.dataset.h; save(); syncButtons(); });
function syncButtons() {
  $('#plTone').classList.toggle('off', !S.tone);
  $('#plMel').classList.toggle('off', !S.mel);
  $('#plOrig').classList.toggle('off', !ORIG());
  $('#plOrig').textContent = origUrl ? '원곡' : '원곡+';
  document.querySelectorAll('#speedSeg button').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.r === (S.speed || 1)));
  document.querySelectorAll('#harmSeg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.h === S.harm));
}

function noteIndexAt(t) {
  const N = current.notes;
  let lo = 0, hi = N.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, n = TL[m];
    if (n[0] + n[1] < t) lo = m + 1; else if (n[0] > t) hi = m - 1; else return m;
  }
  return -1;
}
function setState(s) {
  if (s === P.state) return;
  P.state = s;
  $('#fb').className = 'fb ' + (s === 'none' ? '' : s);
  $('#arrow').textContent = s === 'up' ? '▲' : s === 'down' ? '▼' : s === 'ok' ? '✓' : '';
}

let lastLineKey = '';
function renderLyrics(t, ni) {
  const L = lyr.lines;
  let li = L.findIndex((l) => ni >= l.from && ni <= l.to);
  if (li < 0) li = L.findIndex((l) => TL[l.from][0] > t);   // 다음에 올 줄
  const line = L[li], next = L[li + 1];
  const key = `${li}:${ni}`;
  if (key === lastLineKey) return;
  lastLineKey = key;
  const nowEl = $('#lyNow'); nowEl.innerHTML = '';
  if (line) {
    // 지금 부르는 음절: ni 이하 중 가장 가까운 가사 음절
    let curSyl = -1;
    if (ni >= line.from) for (let k = ni; k >= line.from; k--) if (current.notes[k][3]) { curSyl = k; break; }
    line.words.forEach((w, wi) => {
      if (wi) nowEl.appendChild(document.createTextNode(' '));
      for (const { s, i } of w) {
        const sp = document.createElement('span');
        sp.textContent = s;
        sp.className = i === curSyl ? 'cur' : curSyl >= 0 && i < curSyl ? 'done' : 'todo';
        nowEl.appendChild(sp);
      }
    });
  }
  $('#lyNext').textContent = next ? next.words.map((w) => w.map((x) => x.s).join('')).join(' ') : '';
}

function frame() {
  const t = now();
  if (P.playing && t >= P.end) { finish(); return; }
  const ni = noteIndexAt(t);
  const harm = current.harmony[S.harm];
  const target = ni >= 0 ? harm[ni] : null;

  // 시작 전 카운트 (박마다 '틱')
  if (P.playing && !ORIG() && current.eighth && t < TL[0][0]) {
    const beat = Math.floor(t / (current.eighth * 3));
    if (beat !== P.lastBeat) { P.lastBeat = beat; Voice.blip(actx, 84); }
  } else P.lastBeat = -1;
  // 화음음
  if (voice) voice.set(P.playing && S.tone && target != null ? target : null, S.vol);
  if (melVoice) melVoice.set(P.playing && S.mel && ni >= 0 ? current.notes[ni][2] : null, S.melVol);

  // 내 목소리 (반응 시간 0.12초 감안)
  const sung = mic ? mic.read() : null;
  if (sung != null) { P.hist.push(sung); if (P.hist.length > 5) P.hist.shift(); } else P.hist = [];
  const tj = noteIndexAt(t - 0.12 * rate());
  const tgt = tj >= 0 ? harm[tj] : target;
  let st = 'none', cents = null;
  if (P.playing && tgt != null && P.hist.length >= 3) {
    const v = P.hist.slice().sort((a, b) => a - b)[P.hist.length >> 1];
    let d = v - tgt;
    if (S.octaveFree) d -= 12 * Math.round(d / 12);
    cents = d * 100;
    st = Math.abs(cents) <= S.tol ? 'ok' : cents < 0 ? 'up' : 'down';
  }
  // 깜빡임 방지: 같은 판정이 3프레임 이어질 때 바꿈
  if (st === P.pend) P.pendN++; else { P.pend = st; P.pendN = 1; }
  if (P.pendN >= 3 || st === 'none') setState(st);
  // 점수: 화음 음이 있는 시간 중 초록인 비율
  if (P.playing && tgt != null && ni >= 0 && t - TL[ni][0] > 0.1) { P.tot++; if (st === 'ok') P.hit++; }

  // 안내 문구
  const hint = $('#hint');
  if (!P.playing) hint.textContent = P.t > 0 ? '일시정지' : '▶ 를 누르면 시작해요';
  else if (target == null) {
    const nx = TL.findIndex((n) => n[0] > t);
    hint.textContent = nx >= 0 && TL[nx][0] - t < 2.5 ? `${Math.ceil(TL[nx][0] - t)}…` : ORIG() ? '전주·간주' : '쉬는 구간';
  } else if (!mic) hint.textContent = `목표 ${noteLabel(target)} · 마이크 꺼짐`;
  else if (sung == null) hint.textContent = `목표 ${noteLabel(target)} · 불러보세요`;
  else hint.textContent = `목표 ${noteLabel(tgt)} · ${cents == null ? '' : (cents > 0 ? '+' : '') + Math.round(cents) + '센트'}`;

  renderLyrics(t, ni);
  drawStaff(t, ni);
  $('#plTime').textContent = `${fmt(t / rate())} / ${fmt(P.end / rate())}${rate() !== 1 ? ' · ' + rate() + '배' : ''}${ORIG() ? ' · 원곡' : ''}`;
  $('#prog').style.width = `${Math.min(100, (t / P.end) * 100)}%`;
  raf = requestAnimationFrame(frame);
}

/* ---------- 악보 그리기 (오선, D장조 조표, 멜로디=회색, 화음=파랑) ---------- */
const SPELL = { 0: [0, '♮'], 1: [0, ''], 2: [1, ''], 3: [1, '♯'], 4: [2, ''], 5: [3, '♮'], 6: [3, ''], 7: [4, ''], 8: [4, '♯'], 9: [5, ''], 10: [6, '♭'], 11: [6, ''] };
// D장조 기준 표기: C#·F# 는 조표에 있어 임시표 없음
function staffPos(midi) {           // 아래 첫 줄(E4)=0, 한 칸=1/2줄
  const pc = ((midi % 12) + 12) % 12, oct = Math.floor(midi / 12) - 1;
  const [letter, acc] = SPELL[pc];
  return { step: oct * 7 + letter - (4 * 7 + 2), acc };
}
let noteSyl = [];
function buildNoteSyl() {
  noteSyl = new Array(current.notes.length).fill('');
  for (const l of lyr.lines) for (const w of l.words) for (const x of w) if (x.i >= 0) noteSyl[x.i] = x.s;
}
function drawStaff(t, ni) {
  const cv = $('#staff');
  if (!current.eighth) { cv.style.display = 'none'; return; }
  cv.style.display = '';
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const gap = 13, bottom = h - 64, LX = 44, playX = Math.max(90, w * 0.3), px = 30;   // 8분음표 하나 = 30px
  const curE = eighthAt(t);
  const X = (e) => playX + (e - curE) * px;
  const Y = (step) => bottom - step * (gap / 2);
  const ink = '#1b2033', soft = '#9aa0b8', blue = '#2f6fe0', hot = '#e8a000';
  // 오선
  g.strokeStyle = ink; g.lineWidth = 1;
  for (let i = 0; i < 5; i++) { const y = Y(i * 2); g.beginPath(); g.moveTo(LX, y); g.lineTo(w - 6, y); g.stroke(); }
  // 높은음자리표 대신 조표 영역 (흰 배경으로 지나가는 음 가림)
  // 마디선
  g.strokeStyle = '#555b75';
  for (const b of current.bars) { const x = X(b); if (x > LX + 30 && x < w) { g.beginPath(); g.moveTo(x, Y(8)); g.lineTo(x, Y(0)); g.stroke(); } }
  const harm = current.harmony[S.harm], W = current.writtenOctave || 0;
  const drawNote = (i, midi, color, isHarm) => {
    const n = current.notes[i], x = X(n[4]), x2 = X(n[4] + n[5]);
    if (x2 < LX + 30 || x > w + 10) return;
    const { step, acc } = staffPos(midi + W), y = Y(step);
    // 덧줄
    g.strokeStyle = color; g.lineWidth = 1;
    for (let s = 10; s <= step; s += 2) { g.beginPath(); g.moveTo(x - 9, Y(s)); g.lineTo(x + 9, Y(s)); g.stroke(); }
    for (let s = -2; s >= step; s -= 2) { g.beginPath(); g.moveTo(x - 9, Y(s)); g.lineTo(x + 9, Y(s)); g.stroke(); }
    // 길이 막대 (음 길이만큼)
    g.fillStyle = color; g.globalAlpha = 0.28; g.fillRect(x, y - 3, Math.max(4, x2 - x - 3), 6); g.globalAlpha = 1;
    // 음표 머리
    g.beginPath(); g.ellipse(x, y, 6.2, 4.6, -0.35, 0, 7); g.fill();
    if (acc) { g.font = '15px serif'; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(acc, x - 8, y); g.textAlign = 'left'; }
    // 기둥 (8분음표 이상 길이 감각용 아주 짧게)
    g.strokeStyle = color; g.lineWidth = 1.4; g.beginPath();
    if (step < 4) { g.moveTo(x + 5.6, y); g.lineTo(x + 5.6, y - 26); } else { g.moveTo(x - 5.6, y); g.lineTo(x - 5.6, y + 26); }
    g.stroke();
  };
  for (let i = 0; i < current.notes.length; i++) {
    const on = i === ni;
    drawNote(i, current.notes[i][2], on ? hot : soft, false);
  }
  for (let i = 0; i < current.notes.length; i++) drawNote(i, harm[i], i === ni ? hot : blue, true);
  // 가사
  g.font = '600 14px -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; g.textBaseline = 'top'; g.textAlign = 'left';
  for (let i = 0; i < current.notes.length; i++) {
    const s = noteSyl[i]; if (!s) continue;
    const x = X(current.notes[i][4]); if (x < LX + 26 || x > w) continue;
    g.fillStyle = i === ni ? hot : ink; g.fillText(s, x - 6, Y(-6) + 4);
  }
  // 왼쪽: 흰 가림 + 조표 (♯♯: F5, C5)
  g.fillStyle = 'rgba(255,255,255,.94)'; g.fillRect(0, 0, LX + 30, h);
  g.strokeStyle = ink; g.lineWidth = 1;
  for (let i = 0; i < 5; i++) { const y = Y(i * 2); g.beginPath(); g.moveTo(8, y); g.lineTo(LX + 30, y); g.stroke(); }
  g.fillStyle = ink; g.font = '22px serif'; g.textBaseline = 'middle';
  g.fillText('♯', 14, Y(8)); g.fillText('♯', 28, Y(5));
  if (current.time) { const [a, b] = current.time.split('/'); g.font = 'bold 15px serif'; g.fillStyle = ink; g.textAlign = 'center'; g.fillText(a, 58, Y(6)); g.fillText(b, 58, Y(2)); g.textAlign = 'left'; }
  // 지금 위치
  g.strokeStyle = hot; g.lineWidth = 2; g.beginPath(); g.moveTo(playX, 8); g.lineTo(playX, h - 8); g.stroke();
}

function finish() {
  P.playing = false; P.t = P.end; stopPlay(); setState('none');
  const pct = P.tot ? Math.round((100 * P.hit) / P.tot) : 0;
  $('#rsScore').textContent = pct;
  $('#rsText').textContent = `화음을 불러야 하는 시간 중 ${pct}%를 초록색(허용 오차 ±${S.tol}센트${rate() !== 1 ? ', ' + rate() + '배속' : ''})으로 맞췄어요.`;
  show('result');
}
$('#rsAgain').onclick = () => openSong(current);

/* ---------- 설정 ---------- */
function renderSettings() {
  document.querySelectorAll('#tolSeg button').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.t === S.tol));
  $('#setAec').checked = S.aec; $('#setOct').checked = S.octaveFree; $('#setVol').value = S.vol; $('#setMelVol').value = S.melVol;
  $('#appVer').textContent = APP_VERSION;
}
document.querySelectorAll('#tolSeg button').forEach((b) => b.onclick = () => { S.tol = +b.dataset.t; save(); renderSettings(); });
$('#setOct').onchange = (e) => { S.octaveFree = e.target.checked; save(); };
$('#setAec').onchange = (e) => { S.aec = e.target.checked; save(); };
$('#soundTest').onclick = () => {
  getCtx();
  voice.set(57, S.vol); setTimeout(() => voice.set(61, S.vol), 400); setTimeout(() => voice.set(64, S.vol), 800); setTimeout(() => voice.off(), 1300);
  toast('라·도#·미 소리가 들리면 정상이에요. 안 들리면 미디어 볼륨과 무음 모드를 확인하세요.', 3500);
};
$('#setVol').onchange = (e) => { S.vol = +e.target.value; save(); };
$('#setMelVol').onchange = (e) => { S.melVol = +e.target.value; save(); };
$('#origClear').onclick = async () => {
  for (const s of await db.getAll()) if (String(s.id).startsWith('audio:')) await db.del(s.id);
  S.orig = false; save(); toast('연결한 원곡 파일을 지웠어요');
};

/* ---------- 업데이트 ---------- */
async function doUpdate(btn) {
  btn.disabled = true; btn.textContent = '업데이트 중…';
  try { await applyUpdate(); } catch (err) { toast('업데이트 실패: ' + err.message); btn.disabled = false; btn.textContent = '업데이트'; }
}
$('#updateNow').onclick = (e) => doUpdate(e.target);
$('#updateCheck').onclick = async (e) => {
  const btn = e.target; btn.disabled = true; btn.textContent = '확인 중…';
  try {
    const v = await checkUpdate();
    if (v) { btn.disabled = false; btn.textContent = `${v}로 업데이트`; btn.onclick = () => doUpdate(btn); return; }
    toast(`최신 버전이에요 (${APP_VERSION})`);
  } catch (err) { toast('확인 실패: ' + err.message); }
  btn.disabled = false; btn.textContent = '업데이트 확인';
};
checkUpdate().then((v) => { if (v) { $('#updateVer').textContent = v; $('#updateBanner').classList.remove('hidden'); } }).catch(() => {});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
renderHome();
// 점검용: 소리 상태 (개발자 도구에서 __hc() 로 확인)
window.__hc = () => ({ ctx: actx && actx.state, harm: voice && voice.cur, harmGain: voice && +voice.g.gain.value.toFixed(3), mel: melVoice && melVoice.cur });
window.__seek = (t) => { if (ORIG()) origEl.currentTime = t; else { P.t = t; P.baseT = t; P.base = performance.now(); } };
