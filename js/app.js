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
const DEF = { tol: 50, octaveFree: true, vol: 0.14, slow: false, harm: 'third_up', tone: true };
let S = { ...DEF };
try { S = { ...DEF, ...JSON.parse(localStorage.getItem('hc2') || '{}') }; } catch {}
const save = () => { try { localStorage.setItem('hc2', JSON.stringify(S)); } catch {} };

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
let actx, voice, mic;
const P = { t: 0, playing: false, base: 0, baseT: 0, hist: [], state: 'none', pend: 'none', pendN: 0, hit: 0, tot: 0, end: 0 };

function getCtx() {
  if (!actx) { actx = new (window.AudioContext || window.webkitAudioContext)(); voice = new Voice(actx, 'triangle'); }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function rate() { return S.slow ? 0.8 : 1; }
function now() { return P.playing ? P.baseT + ((performance.now() - P.base) / 1000) * rate() : P.t; }

function startPlay(text) {
  lyr = attachLyrics(current, text);
  const last = current.notes[current.notes.length - 1];
  P.end = last[0] + last[1] + 1;
  P.t = 0; P.playing = false; P.hit = 0; P.tot = 0; P.hist = []; setState('none');
  $('#plTitle').textContent = current.title;
  $('#plPlay').textContent = '▶';
  syncButtons();
  show('play');
  raf = requestAnimationFrame(frame);
}
function stopPlay() {
  P.playing = false;
  if (voice) voice.off();
  if (mic) { mic.stop(); mic = null; }
}
async function togglePlay() {
  getCtx();
  if (!mic) {
    try { mic = new MicPitch(); await mic.start(actx, { aec: true }); }
    catch (err) { mic = null; toast('마이크를 허용해 주세요', 3000); }
  }
  if (P.playing) { P.t = now(); P.playing = false; voice.off(); $('#plPlay').textContent = '▶'; }
  else {
    if (P.t >= P.end) { P.t = 0; P.hit = 0; P.tot = 0; }
    P.baseT = P.t; P.base = performance.now(); P.playing = true; $('#plPlay').textContent = '⏸';
  }
}
$('#plPlay').onclick = togglePlay;
$('#plRestart').onclick = () => { P.t = 0; P.baseT = 0; P.base = performance.now(); P.hit = 0; P.tot = 0; };
$('#plTone').onclick = () => { S.tone = !S.tone; save(); syncButtons(); };
$('#plBack').onclick = () => show('home');
document.querySelectorAll('#harmSeg button').forEach((b) => b.onclick = () => { S.harm = b.dataset.h; save(); syncButtons(); });
function syncButtons() {
  $('#plTone').classList.toggle('off', !S.tone);
  document.querySelectorAll('#harmSeg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.h === S.harm));
}

function noteIndexAt(t) {
  const N = current.notes;
  let lo = 0, hi = N.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, n = N[m];
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
  if (li < 0) li = L.findIndex((l) => current.notes[l.from][0] > t);   // 다음에 올 줄
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

  // 화음음
  if (voice) voice.set(P.playing && S.tone && target != null ? target : null, S.vol);

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
  if (P.playing && tgt != null && ni >= 0 && t - current.notes[ni][0] > 0.1) { P.tot++; if (st === 'ok') P.hit++; }

  // 안내 문구
  const hint = $('#hint');
  if (!P.playing) hint.textContent = P.t > 0 ? '일시정지' : '▶ 를 누르면 시작해요';
  else if (target == null) {
    const nx = current.notes.findIndex((n) => n[0] > t);
    hint.textContent = nx >= 0 && current.notes[nx][0] - t < 2.5 ? `${Math.ceil(current.notes[nx][0] - t)}…` : '쉬는 구간';
  } else if (!mic) hint.textContent = `목표 ${noteLabel(target)} · 마이크 꺼짐`;
  else if (sung == null) hint.textContent = `목표 ${noteLabel(target)} · 불러보세요`;
  else hint.textContent = `목표 ${noteLabel(tgt)} · ${cents == null ? '' : (cents > 0 ? '+' : '') + Math.round(cents) + '센트'}`;

  renderLyrics(t, ni);
  $('#plTime').textContent = `${fmt(t)} / ${fmt(P.end)}`;
  $('#prog').style.width = `${Math.min(100, (t / P.end) * 100)}%`;
  raf = requestAnimationFrame(frame);
}

function finish() {
  P.playing = false; P.t = P.end; stopPlay(); setState('none');
  const pct = P.tot ? Math.round((100 * P.hit) / P.tot) : 0;
  $('#rsScore').textContent = pct;
  $('#rsText').textContent = `화음을 불러야 하는 시간 중 ${pct}%를 초록색(허용 오차 ±${S.tol}센트)으로 맞췄어요.`;
  show('result');
}
$('#rsAgain').onclick = () => openSong(current);

/* ---------- 설정 ---------- */
function renderSettings() {
  document.querySelectorAll('#tolSeg button').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.t === S.tol));
  $('#setOct').checked = S.octaveFree; $('#setVol').value = S.vol; $('#setSlow').checked = S.slow;
  $('#appVer').textContent = APP_VERSION;
}
document.querySelectorAll('#tolSeg button').forEach((b) => b.onclick = () => { S.tol = +b.dataset.t; save(); renderSettings(); });
$('#setOct').onchange = (e) => { S.octaveFree = e.target.checked; save(); };
$('#setVol').onchange = (e) => { S.vol = +e.target.value; save(); };
$('#setSlow').onchange = (e) => { S.slow = e.target.checked; save(); };

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
