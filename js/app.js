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
const DEF = { tol: 50, octaveFree: true, view: 'arrow', vol: 0.15, melVol: 0.12, origVol: 0.8, filter: true, orig: false, speed: 1, mel: true, harm: 'third_up', tone: true };
let S = { ...DEF };
try { S = { ...DEF, ...JSON.parse(localStorage.getItem('hc2') || '{}') }; } catch {}
const save = () => { try { localStorage.setItem('hc2', JSON.stringify(S)); } catch {} };
if (!S.sv || S.sv < 4) { S.vol = DEF.vol; S.melVol = DEF.melVol; S.origVol = DEF.origVol; S.filter = true; S.mel = S.mel ?? true; S.sv = 4; save(); }   // 2.4: 스피커 소리 걸러내기 기본 켬, 볼륨 세분화

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
/** 복사할 때 딸려 온 제목·가수·작사/작곡 줄 빼기, 그래도 음절이 많으면 앞뒤 줄을 맞을 때까지 덜어냄 */
function cleanLyrics(text, song) {
  const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
  const title = norm(song.title || ''), artist = norm(song.artist || '');
  let lines = text.split('\n').filter((raw) => {
    const n = norm(raw);
    if (!n) return true;
    if (n === title || n === artist || n === title + artist || n === artist + title) return false;
    if (title && n.includes(title) && n.length <= title.length + artist.length + 4) return false;
    if (/^(작사|작곡|편곡|노래|가수|가사|lyrics|앨범|발매)/i.test(raw.trim()) || /(작사|작곡|편곡)\s*[:：]/.test(raw)) return false;
    return true;
  });
  const need = song.notes.filter((x) => x[3]).length, cnt = (ls) => countSyl(ls.join('\n'));
  while (lines.length > 1 && cnt(lines) > need && cnt(lines.slice(1)) >= need) lines.shift();
  while (lines.length > 1 && cnt(lines) > need && cnt(lines.slice(0, -1)) >= need) lines.pop();
  return lines.join('\n').trim();
}

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
  const need = current.notes.filter((n) => n[3]).length, got = countSyl(cleanLyrics($('#lyText').value, current));
  $('#lyCheck').textContent = !got ? `악보 음절 ${need}개` : got === need ? `✓ 음절 ${got}개 — 악보와 딱 맞아요` : `음절 ${got}개 / 악보 ${need}개 — 조금 다르지만 그대로 쓸 수 있어요`;
}
$('#lyText').addEventListener('input', checkLyrics);
$('#lySave').onclick = async () => {
  const text = cleanLyrics($('#lyText').value, current);
  if (!text) return toast('가사를 붙여넣어 주세요');
  if (text !== $('#lyText').value.trim()) toast('제목·가수 같은 가사 아닌 줄은 뺐어요', 2500);
  await db.put({ id: 'lyrics:' + current.id, text });
  startPlay(text);
};

/* ---------- 연습 ---------- */
let actx, voice, melVoice, mic, origGain = null;
function applyOrigVol() { if (origGain) origGain.gain.value = S.origVol; else origEl.volume = Math.min(1, S.origVol); }
const P = { trace: [], t: 0, playing: false, base: 0, baseT: 0, hist: [], state: 'none', pend: 'none', pendN: 0, hit: 0, tot: 0, end: 0 };

function getCtx() {
  // 아이폰: 무음 모드에서도 소리 나게 + 마이크와 함께 쓰기
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)(); voice = new Voice(actx, 'saw'); melVoice = new Voice(actx, 'sine');
    try { const src = actx.createMediaElementSource(origEl); origGain = actx.createGain(); src.connect(origGain).connect(actx.destination); } catch {}
    applyOrigVol();
  }
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
  P.trace = [];
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
  lyr = attachLyrics(current, cleanLyrics(text, current));
  buildNoteSyl();
  buildTL();
  loadOrig().then(() => { buildTL(); syncButtons(); });
  P.t = 0; P.playing = false; P.hit = 0; P.tot = 0; P.hist = []; P.trace = []; setState('none');
  applyView();
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
}
async function togglePlay() {
  getCtx();
  if (!mic) {
    try { mic = new MicPitch(); await mic.start(actx, { aec: false }); }   // 폰 에코 제거는 긴 음을 지워 버려서 끔 — 앱이 직접 거름
    catch (err) { mic = null; toast('마이크를 허용해 주세요. 설정 → 앱 → 화음 코치 → 권한 → 마이크 → "앱 사용 중에만 허용"', 5000); }
    try { await actx.resume(); } catch {}   // 마이크 켤 때 소리가 멈추는 기기 대비
  }
  if (P.playing) { P.t = now(); P.playing = false; origEl.pause(); voice.off(); melVoice.off(); $('#plPlay').textContent = '▶'; }
  else {
    if (now() >= P.end - 0.05) { P.t = 0; P.hit = 0; P.tot = 0; if (ORIG()) origEl.currentTime = 0; }
    P.baseT = P.t; P.base = performance.now(); P.playing = true; $('#plPlay').textContent = '⏸';
    P.calib = { t0: performance.now(), lv: [], amp: [] };
    if (ORIG()) { try { await origEl.play(); } catch (e) { toast('원곡을 재생할 수 없어요: ' + e.message); } }
  }
}
$('#plPlay').onclick = togglePlay;
$('#plRestart').onclick = () => { P.t = 0; P.baseT = 0; P.base = performance.now(); P.hit = 0; P.tot = 0; P.trace = []; origEl.currentTime = 0; };
const tapTone = () => { S.tone = !S.tone; save(); syncButtons(); toast(S.tone ? '화음음 켬' : '화음음 끔', 900); };
const tapMel = () => { S.mel = !S.mel; save(); syncButtons(); toast(S.mel ? '멜로디음 켬' : '멜로디음 끔', 900); };
document.querySelectorAll('#speedSeg button').forEach((b) => b.onclick = () => {
  const r = +b.dataset.r;
  if (r !== 1 && ORIG()) toast('원곡은 1배에서만 나와요. 화음음·멜로디음으로 연습해요.', 2500);
  switchMode(() => { S.speed = r; if (r !== 1) S.orig = false; save(); });
});
// 원곡 버튼: 처음엔 폰의 음원 파일을 한 번 연결
const tapOrig = () => {
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
function applyView() {
  const g = S.view === 'graph';
  $('#play').classList.toggle('graph-mode', g);
  $('#plView').textContent = g ? '화살표' : '그래프';
  $('#plView').setAttribute('aria-label', g ? '화살표 모드로 바꾸기' : '그래프 모드로 바꾸기');
}
$('#plView').onclick = () => { S.view = S.view === 'graph' ? 'arrow' : 'graph'; save(); applyView(); toast(S.view === 'graph' ? '그래프 모드' : '화살표 모드', 900); };
$('#plLyrics').onclick = async () => {
  $('#lyTitle').textContent = `${current.title} 가사`;
  $('#lyText').value = (await lyricsOf(current)) || '';
  checkLyrics(); show('lyrics');
};
// 화음음·멜로디음·원곡 버튼: 탭 = 켜기/끄기, 누른 채 위아래로 끌기 = 음량
const toGain = (x, max) => max * Math.pow(x / 100, 2);       // 0~100 → 0~max (작은 소리 쪽을 촘촘하게)
const toSlider = (g, max) => Math.round(Math.sqrt(Math.max(0, g) / max) * 100);
function volButton(id, key, max, label, onTap) {
  const btn = $(id), pop = $('#volPop');
  let st = null;
  btn.addEventListener('pointerdown', (e) => {
    st = { y: e.clientY, v: toSlider(S[key], max), drag: false };
    btn.setPointerCapture(e.pointerId);
  });
  btn.addEventListener('pointermove', (e) => {
    if (!st) return;
    const dy = st.y - e.clientY;
    if (!st.drag && Math.abs(dy) > 10) {
      st.drag = true;
      const r = btn.getBoundingClientRect();
      pop.style.left = `${r.left + r.width / 2}px`; pop.style.bottom = `${window.innerHeight - r.top + 10}px`;
      pop.hidden = false; $('#volPopLabel').textContent = label;
      getCtx();
    }
    if (st.drag) {
      const v = Math.max(0, Math.min(100, Math.round(st.v + dy / 1.6)));   // 1.6px = 1
      S[key] = toGain(v, max); applyOrigVol();
      $('#volPopFill').style.height = `${v}%`; $('#volPopNum').textContent = v;
    }
  });
  const end = () => {
    if (!st) return;
    const wasDrag = st.drag; st = null; pop.hidden = true;
    if (wasDrag) save(); else onTap();
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', () => { if (st && st.drag) save(); st = null; pop.hidden = true; });
}
volButton('#plTone', 'vol', 0.6, '화음음', tapTone);
volButton('#plMel', 'melVol', 0.6, '멜로디음', tapMel);
volButton('#plOrig', 'origVol', 1, '원곡', tapOrig);
document.querySelectorAll('#harmSeg button').forEach((b) => b.onclick = () => { S.harm = b.dataset.h; save(); syncButtons(); });
function syncButtons() {
  for (const [id, on] of [['#plTone', S.tone], ['#plMel', S.mel], ['#plOrig', ORIG()]]) { $(id).classList.toggle('off', !on); $(id).setAttribute('aria-pressed', on); }
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
  // 지금(또는 방금) 부른 음: 줄 중간 쉼표에서도 그 줄을 유지
  let k = ni;
  if (k < 0) { k = -1; for (let i = 0; i < TL.length && TL[i][0] <= t; i++) k = i; }
  let li = L.findIndex((l) => k >= l.from && k <= l.to);
  // 줄의 마지막 음까지 끝났으면 다음 줄을 보여 줌
  if (li >= 0 && k === L[li].to && t > TL[k][0] + TL[k][1]) li++;
  if (li < 0) li = L.findIndex((l) => TL[l.from][0] > t);
  const line = L[li], next = L[li + 1];
  const key = `${li}:${k}:${ni >= 0}`;
  if (key === lastLineKey) return;
  lastLineKey = key;
  const nowEl = $('#lyNow'); nowEl.innerHTML = '';
  if (line) {
    // 지금 부르는 음절: ni 이하 중 가장 가까운 가사 음절
    let curSyl = -1;
    if (k >= line.from) for (let j = Math.min(k, line.to); j >= line.from; j--) if (current.notes[j][3]) { curSyl = j; break; }
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
  // 화음음: 계속 들려줌. 시작 카운트 동안엔 첫 화음음을 미리 들려줘서 첫 음을 잡게 함
  const preRoll = P.playing && !ORIG() && t < TL[0][0];
  const toneMidi = !P.playing || !S.tone ? null : preRoll ? (t > TL[0][0] - 1.0 ? harm[0] : null) : target;
  if (voice) voice.set(toneMidi, S.vol);
  const melMidi = P.playing && S.mel && ni >= 0 ? current.notes[ni][2] : null;
  if (melVoice) melVoice.set(melMidi, S.melVol);

  // 내 목소리 (반응 시간 0.12초 감안)
  let sung = mic ? mic.read() : null;
  const lvl = mic ? (mic.level || 0) : 0;
  // 지금 앱이 내는 소리 크기(스피커 누출이 이 크기에 비례한다고 봄)
  const outAmp = (toneMidi != null ? S.vol : 0) + (melMidi != null ? S.melVol : 0) + (ORIG() && origEl && !origEl.paused ? S.origVol * 0.5 : 0);
  // ① 시작 카운트 동안(사용자 조용) 마이크로 들어오는 소리 = 방 소음 + 스피커 누출
  if (mic && P.playing && P.calib && performance.now() - P.calib.t0 < 900) { P.calib.lv.push(lvl); P.calib.amp.push(outAmp); }
  else if (P.calib && P.calib.lv.length) {
    const a = P.calib.lv.slice().sort((x, y) => x - y);
    const on = P.calib.lv.filter((_, i) => P.calib.amp[i] > 0.01).sort((x, y) => x - y), off = P.calib.lv.filter((_, i) => P.calib.amp[i] <= 0.01).sort((x, y) => x - y);
    const ampOn = P.calib.amp.filter((x) => x > 0.01), amp = ampOn.length ? ampOn.reduce((x, y) => x + y, 0) / ampOn.length : 0;
    const q = on.length ? on[Math.floor(on.length * 0.8)] : (a[Math.floor(a.length * 0.8)] || 0);
    P.noise = off.length >= 3 ? off[Math.floor(off.length * 0.6)] : Math.min(q, a[Math.floor(a.length * 0.2)] || 0);   // 아무것도 안 날 때의 바닥 소음
    P.noiseCal = P.noise;
    P.leakPerAmp = amp > 0.01 ? Math.max(0, q - P.noise) / amp : (P.leakPerAmp || 0);
    P.calib = null;
  }
  // ② 쉬는 구간(목표 음 없음, 다음 음까지 0.4초 이상)엔 사용자도 조용하다고 보고 계속 다시 잼
  if (mic && P.playing && !P.calib && target == null && !(TL.find((n) => n[0] > t && n[0] - t < 0.4))) {
    (P.restLv ||= []).push({ lvl, outAmp }); if (P.restLv.length > 90) P.restLv.shift();
    if (P.restLv.length >= 20) {
      const quietOnes = P.restLv.filter((r) => r.outAmp < 0.01).map((r) => r.lvl).sort((x, y) => x - y);
      // 쉬는 구간에 흥얼거려도 기준이 크게 오르지 않게: 시작 때 잰 값의 2배까지만
      if (quietOnes.length >= 10) P.noise = Math.min(quietOnes[Math.floor(quietOnes.length * 0.6)], Math.max(0.004, (P.noiseCal ?? 0.003) * 2));
    }
  }
  // 지금 예상되는 '내 목소리가 아닌' 소리 크기
  const expect = Math.max(0.003, (P.noise ?? 0.003)) + (P.leakPerAmp || 0) * outAmp;
  const rawSung = sung;
  if (P.lock && P.lock.ni !== ni && ni >= 0) {
    // 다음 음이 같은 화음 음(이음줄·같은 음 반복)이면 잠금 이어감
    if (harm[ni] === harm[P.lock.ni] && TL[ni][0] - (TL[P.lock.ni][0] + TL[P.lock.ni][1]) < 0.15) P.lock.ni = ni; else P.lock = null;
  }
  const near = (x, y) => { let d = x - y; d -= 12 * Math.round(d / 12); return Math.abs(d) < 0.4; };
  if (sung != null) {
    // ③ 음이 안정적이어야 함: 최근 감지값들이 1반음 안에서 모여 있어야 (소음은 마구 튐)
    (P.raw ||= []).push(sung); if (P.raw.length > 4) P.raw.shift();
    const r = P.raw.slice().sort((x, y) => x - y);
    if (P.raw.length < 3 || r[r.length - 1] - r[0] > 1.2) sung = null;
  } else P.raw = [];
  if (sung != null) {
    const locked = P.lock && P.lock.ni === ni && near(sung, P.lock.m);
    // ④ 소음·스피커 소리보다 확실히 커야 목소리 (긴 음은 시작이 또렷했으면 끝까지 기준을 낮춤)
    const minLv = Math.max(0.006, expect * (locked ? 1.25 : 1.8));
    if (lvl < minLv) sung = null;
    else if (S.filter) {
      // ⑤ 앱이 지금 내는 음(화음음·멜로디음·원곡 노래)과 같은 음이면 더 커야 함
      const outs = [];
      if (toneMidi != null) outs.push(toneMidi);
      if (melMidi != null) outs.push(melMidi);
      if (ORIG() && ni >= 0) outs.push(current.notes[ni][2]);
      if (!locked && outs.some((o) => near(sung, o)) && lvl < expect * 2.0) sung = null;
    }
    if (sung != null && ni >= 0 && !locked) P.lock = { ni, m: sung };   // 인정된 음은 그 음 끝까지 잠금
  }
  const nowMs = performance.now();
  if (sung != null) { P.hist.push(sung); if (P.hist.length > 5) P.hist.shift(); P.lastVoice = nowMs; }
  else if (nowMs - (P.lastVoice || 0) > 250) P.hist = [];          // 잠깐(0.25초 이하) 못 잡은 건 무시
  const tj = noteIndexAt(t - 0.12 * rate());
  let tgt = tj >= 0 ? harm[tj] : target;
  if (tgt == null && P.playing) {
    // 짧은 쉼표(0.6초 이하) 동안 계속 부르면: 앞 음(또는 곧 시작할 다음 음) 기준으로 판정
    let k = -1; for (let i = 0; i < TL.length && TL[i][0] <= t; i++) k = i;
    const prevEnd = k >= 0 ? TL[k][0] + TL[k][1] : -1, next = TL[k + 1];
    if (next && next[0] - t < 0.3 * rate()) tgt = harm[k + 1];
    else if (k >= 0 && t - prevEnd < 0.6 * rate() && (!next || next[0] - prevEnd < 1.2 * rate())) tgt = harm[k];
  }
  let st = 'none', cents = null;
  if (P.playing && tgt != null && P.hist.length >= 3) {
    const v = P.hist.slice().sort((a, b) => a - b)[P.hist.length >> 1];
    let d = v - tgt;
    if (S.octaveFree) d -= 12 * Math.round(d / 12);
    cents = d * 100;
    st = Math.abs(cents) <= S.tol ? 'ok' : cents < 0 ? 'up' : 'down';
  }
  // 그래프 모드용 내 목소리 궤적 (반응 시간만큼 앞으로 당겨 악보 시간에 맞춤)
  if (P.playing && sung != null) {
    let m = sung;
    const ref = tgt != null ? tgt : P.lastTgt;
    if (S.octaveFree && ref != null) m -= 12 * Math.round((m - ref) / 12);
    const dc = tgt != null ? (m - tgt) * 100 : null;
    P.trace.push({ t: t - 0.12 * rate(), m, s: dc == null ? 'none' : Math.abs(dc) <= S.tol ? 'ok' : dc < 0 ? 'up' : 'down' });
    if (P.trace.length > 2400) P.trace.splice(0, 600);
  }
  if (tgt != null) P.lastTgt = tgt;
  // 깜빡임 방지: 같은 판정이 3프레임 이어질 때 바꿈. 판정이 끊겨도 0.5초는 마지막 판정 유지
  if (st !== 'none') P.lastJudge = nowMs;
  if (st === 'none' && P.playing && nowMs - (P.lastJudge || 0) < 500) st = P.state;
  if (st === P.pend) P.pendN++; else { P.pend = st; P.pendN = 1; }
  if (P.pendN >= 3 || (st === 'none' && !P.playing)) setState(st);
  // 점수: 화음 음이 있는 시간 중 초록인 비율
  if (P.playing && tgt != null && ni >= 0 && t - TL[ni][0] > 0.1) { P.tot++; if (st === 'ok') P.hit++; }

  // 안내 문구
  const hint = $('#hint');
  if (!P.playing) hint.textContent = P.t > 0 ? '일시정지' : '▶ 를 누르면 시작해요';
  else if (target == null) {
    const nx = TL.findIndex((n) => n[0] > t);
    hint.textContent = nx >= 0 && TL[nx][0] - t < 2.5 ? `${Math.ceil(TL[nx][0] - t)}…` : ORIG() ? '전주·간주' : '쉬는 구간';
  } else if (!mic) hint.textContent = `목표 ${noteLabel(target)} · 마이크 꺼짐`;
  else if (sung == null) hint.textContent = `목표 ${noteLabel(target)} · ${mic.level > 0.004 && rawSung == null ? '소리가 작거나 음이 흐려요' : '불러보세요'}`;
  else hint.textContent = `목표 ${noteLabel(tgt)} · ${cents == null ? '' : (cents > 0 ? '+' : '') + Math.round(cents) + '센트'}`;

  renderLyrics(t, ni);
  if (S.view === 'graph') drawPitchGraph(t, ni); else drawStaff(t, ni);
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
  const gap = 12, bottom = h - 54, LX = 44, playX = Math.max(90, w * 0.3), px = 30;   // 8분음표 하나 = 30px
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

/* ---------- 그래프 모드: 화음 음(파란 막대 + 허용 범위) 위에 내 목소리 궤적 ---------- */
function drawPitchGraph(t, ni) {
  const cv = $('#pgraph');
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const harm = current.harmony[S.harm];
  const span = 7 * rate(), t0 = t - span * 0.38, t1 = t + span * 0.62, LM = 46;
  // 보이는 음들로 세로 범위 (부드럽게 따라감)
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < TL.length; i++) {
    if (TL[i][0] + TL[i][1] < t0 || TL[i][0] > t1) continue;
    lo = Math.min(lo, harm[i], S.mel ? current.notes[i][2] : harm[i]); hi = Math.max(hi, harm[i], S.mel ? current.notes[i][2] : harm[i]);
  }
  if (isFinite(lo)) {
    lo -= 3; hi += 3; if (hi - lo < 12) { const c = (hi + lo) / 2; lo = c - 6; hi = c + 6; }
    P.glo = P.glo == null ? lo : P.glo + (lo - P.glo) * 0.06; P.ghi = P.ghi == null ? hi : P.ghi + (hi - P.ghi) * 0.06;
  }
  const L0 = P.glo ?? 50, L1 = P.ghi ?? 64;
  const X = (x) => LM + ((x - t0) / (t1 - t0)) * (w - LM), Y = (m) => h - 8 - ((m - L0) / (L1 - L0)) * (h - 16), row = (h - 16) / (L1 - L0);
  g.fillStyle = 'rgba(8,10,20,.72)'; g.fillRect(0, 0, w, h);
  // 반음 격자 + 음이름
  g.font = '11px ui-monospace, Menlo, monospace'; g.textBaseline = 'middle';
  for (let m = Math.ceil(L0); m <= L1; m++) {
    const y = Y(m), pc = ((m % 12) + 12) % 12, inKey = [1, 2, 4, 6, 7, 9, 11].includes(pc);   // D장조 음
    g.strokeStyle = inKey ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.05)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(LM, y); g.lineTo(w, y); g.stroke();
    if (inKey && row > 9) { g.fillStyle = 'rgba(255,255,255,.55)'; g.fillText(`${NAMES[pc]}${Math.floor(m / 12) - 1}`, 4, y); }
  }
  const band = Math.max(3, (row * S.tol) / 100);
  // 멜로디(참고, 회색)
  if (S.mel) for (let i = 0; i < TL.length; i++) {
    const [s, d] = TL[i]; if (s + d < t0 || s > t1) continue;
    g.fillStyle = 'rgba(200,205,230,.22)'; g.fillRect(X(s), Y(current.notes[i][2]) - 2.5, Math.max(2, X(s + d) - X(s) - 1), 5);
  }
  // 화음 목표: 허용 범위 띠 + 중심선
  for (let i = 0; i < TL.length; i++) {
    const [s, d] = TL[i]; if (s + d < t0 || s > t1) continue;
    const x0 = X(s), x1 = X(s + d) - 1, y = Y(harm[i]), on = i === ni;
    g.fillStyle = on ? 'rgba(255,224,102,.30)' : 'rgba(90,160,255,.28)'; g.fillRect(x0, y - band, Math.max(2, x1 - x0), band * 2);
    g.strokeStyle = on ? '#ffe066' : '#5aa0ff'; g.lineWidth = 3; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    if (noteSyl[i] && x1 - x0 > 8) { g.fillStyle = on ? '#ffe066' : 'rgba(255,255,255,.7)'; g.font = '600 13px -apple-system, "Apple SD Gothic Neo", sans-serif'; g.textBaseline = 'bottom'; g.fillText(noteSyl[i], x0, y - band - 2); g.textBaseline = 'middle'; g.font = '11px ui-monospace, Menlo, monospace'; }
  }
  // 내 목소리 궤적
  const col = { ok: '#3ddc84', up: '#ff5c6c', down: '#5aa0ff', none: 'rgba(255,255,255,.75)' };
  g.lineWidth = 4; g.lineCap = 'round';
  let prev = null;
  for (const p of P.trace) {
    if (p.t < t0 - 0.5) { prev = null; continue; }
    if (prev && p.t - prev.t < 0.15 && p.t >= prev.t) { g.strokeStyle = col[p.s]; g.beginPath(); g.moveTo(X(prev.t), Y(prev.m)); g.lineTo(X(p.t), Y(p.m)); g.stroke(); }
    prev = p;
  }
  // 지금 위치 + 지금 내 음 점
  const nowX = X(t);
  g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(nowX, 0); g.lineTo(nowX, h); g.stroke();
  const last = P.trace[P.trace.length - 1];
  if (last && t - 0.12 * rate() - last.t < 0.2) { g.fillStyle = col[last.s]; g.beginPath(); g.arc(nowX, Y(last.m), 7, 0, 7); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke(); }
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
  $('#setAec').checked = S.filter; $('#setOct').checked = S.octaveFree;
  $('#appVer').textContent = APP_VERSION;
}
document.querySelectorAll('#tolSeg button').forEach((b) => b.onclick = () => { S.tol = +b.dataset.t; save(); renderSettings(); });
$('#setOct').onchange = (e) => { S.octaveFree = e.target.checked; save(); };
$('#setAec').onchange = (e) => { S.filter = e.target.checked; save(); if (mic) { mic.stop(); mic = null; } };
// 앱을 닫거나 다른 앱으로 가면 마이크 끔 (돌아오면 다음 재생 때 다시 켬 — 권한은 다시 묻지 않음)
document.addEventListener('visibilitychange', () => { if (document.hidden && mic) { if (P.playing) togglePlay(); mic.stop(); mic = null; } });
$('#soundTest').onclick = () => {
  getCtx();
  voice.set(57, S.vol); setTimeout(() => voice.set(61, S.vol), 400); setTimeout(() => voice.set(64, S.vol), 800); setTimeout(() => voice.off(), 1300);
  toast('라·도#·미 소리가 들리면 정상이에요. 안 들리면 미디어 볼륨과 무음 모드를 확인하세요.', 3500);
};
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
window.__hc = () => ({ ctx: actx && actx.state, harm: voice && voice.cur, harmGain: voice && +voice.g.gain.value.toFixed(3), mel: melVoice && melVoice.cur, melGain: melVoice && +melVoice.g.gain.value.toFixed(3), vol: S.vol, melVol: S.melVol });
window.__seek = (t) => { if (ORIG()) origEl.currentTime = t; else { P.t = t; P.baseT = t; P.base = performance.now(); } };
window.__leak = () => ({ noise: P.noise, leakPerAmp: P.leakPerAmp });
