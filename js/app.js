// 화음 코치 2.0 — 악보 기반 화음 연습 (원곡 없이 화음음 + 가사)
import * as db from './db.js';
import { MicPitch, Voice, PATCHES } from './pitch.js';
import { readTags } from './id3.js';
import { readSheet, buildSong, alignToAudio, lyricsFromSheet, APP_PROMPT, parseSheetText, checkSheet } from './autosong.js';
import { APP_VERSION, checkUpdate, applyUpdate } from './update.js';
import { initRec } from './rec.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SOL = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
const pcOf = (m) => ((Math.round(m) % 12) + 12) % 12;
const noteLabel = (m) => `${NAMES[pcOf(m)]}${Math.floor(Math.round(m) / 12) - 1} (${SOL[pcOf(m)]})`;
const fmt = (t) => `${Math.floor(Math.max(0, t) / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, '0')}`;

/* ---------- 설정 ---------- */
const DEF = { tol: 50, octaveFree: true, patch: 'piano', toneOct: false, sync: 0, view: 'arrow', vol: 0.15, melVol: 0.12, origVol: 1.2, phoneMic: true, filter: true, orig: false, speed: 1, mel: true, harm: 'third_up', tone: true };
let S = { ...DEF };
try { S = { ...DEF, ...JSON.parse(localStorage.getItem('hc2') || '{}') }; } catch {}
const save = () => { try { localStorage.setItem('hc2', JSON.stringify(S)); } catch {} };
if (S.sv === 4) { S.origVol = Math.max(S.origVol ?? 0.8, 1.2); S.phoneMic = true; S.sv = 5; save(); }
if (!S.sv || S.sv < 4) { S.vol = DEF.vol; S.melVol = DEF.melVol; S.origVol = DEF.origVol; S.filter = true; S.mel = S.mel ?? true; S.sv = 4; save(); }   // 2.4: 스피커 소리 걸러내기 기본 켬, 볼륨 세분화

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- 화면 전환 ---------- */
let raf = 0;
let skipPop = false;
let REC = null;   // 버전 2 녹음 화면 (아래에서 만듦)
function show(id, fromPop) {
  cancelAnimationFrame(raf);
  if (id !== 'play') stopPlay();
  if (id !== 'rec' && REC) REC.leave();
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'home') renderHome();
  if (id === 'add') addRefresh();
  if (id === 'settings') renderSettings();
  // 폰의 '뒤로' 버튼: 안쪽 화면에서는 앱이 꺼지지 않고 곡 목록(홈)으로
  if (!fromPop) {
    const inner = history.state && history.state.hc;
    if (id === 'home') { if (inner) { skipPop = true; history.back(); } }
    else if (inner) history.replaceState({ hc: id }, '');
    else history.pushState({ hc: id }, '');
  }
}
window.addEventListener('popstate', () => { if (skipPop) { skipPop = false; return; } show('home', true); });
if (history.state && history.state.hc) history.replaceState(null, '');   // 새로고침 뒤 남은 기록 정리
// 설치형 안드로이드 앱의 뒤로 버튼: 열린 창 닫기 → 홈으로 → (홈이면) 앱 닫기
function onBack() {
  for (const id of ['#patchPanel', '#origPanel', '#volPop']) { const el = document.querySelector(id); if (el && !el.hidden) { el.hidden = true; return true; } }
  const cur = document.querySelector('.screen.active');
  if (cur && cur.id !== 'home') { show('home'); return true; }
  return false;
}
const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
if (CapApp && CapApp.addListener) CapApp.addListener('backButton', () => { if (!onBack()) CapApp.exitApp(); });
window.__back = onBack;
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
function cleanLyrics(text, song, trim = true) {
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
  const need = (song.notes || []).filter((x) => x[3]).length, cnt = (ls) => countSyl(ls.join('\n'));
  if (trim) {
    while (lines.length > 1 && cnt(lines) > need && cnt(lines.slice(1)) >= need) lines.shift();
    while (lines.length > 1 && cnt(lines) > need && cnt(lines.slice(0, -1)) >= need) lines.pop();
  }
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
    el.innerHTML = '<div><div class="t"></div><div class="s"></div><div class="chips"></div></div><div class="go">▶</div>';
    el.querySelector('.t').textContent = s.title;
    el.querySelector('.s').textContent = `${s.artist || ''}${s.key ? ' · ' + s.key : ''}${s.builtin ? ' · 기본곡' : ''}`;
    // 준비 상태: 가사(필수) · 원곡(선택)
    const hasLy = !!(await lyricsOf(s)), hasAu = !!(await db.get('audio:' + s.id));
    el.querySelector('.chips').innerHTML = `<span class="chip ${hasLy ? 'ok' : 'no'}">${hasLy ? '가사 ✓' : '가사 필요'}</span><span class="chip ${hasAu ? 'ok' : ''}">${hasAu ? '원곡 ✓' : '원곡 없음(선택)'}</span>`;
    el.onclick = () => openSong(s);
    if (!s.builtin) {
      const del = document.createElement('button');
      del.className = 'del'; del.textContent = '삭제'; del.setAttribute('aria-label', '곡 삭제');
      del.onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm(`'${s.title}' 곡을 지울까요? (이 폰에 저장된 원곡·가사도 함께 지워져요)`)) return;
        for (const k of [s.id, 'audio:' + s.id, 'lyrics:' + s.id, 'yt:' + s.id]) await db.del(k);
        renderHome();
      };
      el.querySelector('.chips').appendChild(del);
    }
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
    toast(`'${s.title}' 곡 파일을 추가했어요. 이제 가사를 넣어 주세요.`, 2500);
    openSong(s);   // 바로 2단계(가사)로
  } catch (err) { toast('추가 실패: ' + err.message, 3500); }
});

/* ---------- 새 곡 추가: 원곡 MP3 + 악보 → 자동으로 곡 만들기 ---------- */
const ADD = { mp3: null, tags: null, dur: 0, sheets: [], oct: 1, busy: false, parsed: null, mode: null };
const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };
const getKey = () => { try { return localStorage.getItem('hc-claude-key') || ''; } catch { return ''; } };
const setKey = (k) => { try { localStorage.setItem('hc-claude-key', (k || '').trim()); } catch {} };
function addReset() {
  Object.assign(ADD, { mp3: null, tags: null, dur: 0, sheets: [], oct: 1, busy: false, parsed: null });
  $('#addTitle').value = ''; $('#addArtist').value = ''; $('#addKey').value = '';
  $('#appText').value = ''; lsSet('hc-add-paste', ''); appCheck(); db.del('draft:add-mp3').catch(() => {});
  $('#addProg').hidden = true; addRefresh();
}
function addMode() { return ADD.mode || lsGet('hc-add-mode') || 'voice'; }
// 앱이 Claude 앱으로 넘어간 사이 폰이 화면을 정리해도 고른 MP3·붙여넣은 답이 남도록
let draftTried = false;
async function addRestore() {
  if (draftTried) return; draftTried = true;
  try {
    const d = await db.get('draft:add-mp3');
    if (d && d.blob && !ADD.mp3) await addSetMp3(new File([d.blob], d.name || 'song.mp3', { type: d.blob.type || 'audio/mpeg' }), d.dur, d.title, d.artist);
  } catch {}
  const t = lsGet('hc-add-paste');
  if (t && !$('#appText').value) { $('#appText').value = t; appCheck(); }
}
function addRefresh() {
  addRestore();
  const t = ADD.tags || {}, mode = addMode();
  $$('#addMode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === mode)));
  $('#modeApp').hidden = mode !== 'app'; $('#modeApi').hidden = mode !== 'api'; $('#modeVoice').hidden = mode !== 'voice';
  $('#addStep2T').textContent = mode === 'voice' ? '멜로디' : '악보';
  $('#addMp3Box').classList.toggle('done', !!ADD.mp3);
  $('#addMp3Info').innerHTML = ADD.mp3
    ? `✓ <b></b> (${fmt(ADD.dur)})<br>${t.lyrics ? '가사도 들어 있어요 ✓' : '가사가 없는 파일이에요 — 악보의 가사를 쓸게요'}`
    : '멜론·지니에서 받은 MP3면 제목·가수·가사가 자동으로 들어와요.';
  if (ADD.mp3) $('#addMp3Info b').textContent = ADD.mp3.name;
  $('#addMp3Btn').classList.toggle('ghost', !!ADD.mp3); $('#addMp3Btn').firstChild.textContent = ADD.mp3 ? '다른 MP3 고르기' : 'MP3 고르기';
  $('#addSheetBox').classList.toggle('done', mode === 'voice' ? !!ADD.mp3 : mode === 'app' ? !!ADD.parsed : ADD.sheets.length > 0);
  $('#addSheetInfo').textContent = ADD.sheets.length ? '✓ ' + ADD.sheets.map((f) => f.name).join(', ') : 'PDF 파일 또는 악보 사진(여러 장 가능, 순서대로).';
  $('#addSheetBtn').classList.toggle('ghost', ADD.sheets.length > 0); $('#addSheetBtn').firstChild.textContent = ADD.sheets.length ? '다시 고르기' : '악보 고르기';
  $('#addMeta').hidden = !ADD.mp3 && !ADD.sheets.length && !ADD.parsed;
  $('#addKeyBox').hidden = mode !== 'api' || !!getKey();
  document.querySelectorAll('#addOct button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.o === ADD.oct)));
  $('#addMake').disabled = ADD.busy || !ADD.mp3 || (mode === 'voice' ? false : mode === 'app' ? !ADD.parsed : !ADD.sheets.length);
  $('#addMake').textContent = ADD.busy ? '만드는 중…' : mode === 'voice' ? '🎤 멜로디 녹음하러 가기' : '🎵 곡 만들기';
  $('#addOctField').hidden = mode === 'voice';
}
document.querySelectorAll('#addOct button').forEach((b) => b.onclick = () => { ADD.oct = +b.dataset.o; addRefresh(); });
async function addSetMp3(f, dur, title, artist) {
  ADD.mp3 = f; ADD.dur = dur; ADD.tags = await readTags(f).catch(() => ({}));
  const base = f.name.replace(/\.[^.]+$/, '');
  const dash = base.indexOf('-');
  $('#addTitle').value = title || ADD.tags.title || (dash > 0 ? base.slice(dash + 1).trim() : base);
  $('#addArtist').value = artist || ADD.tags.artist || (dash > 0 ? base.slice(0, dash).trim() : '');
  addRefresh();
}
$('#addMp3').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const dur = await new Promise((res) => { const a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(null); a.src = URL.createObjectURL(f); });
  if (dur == null) return toast('재생할 수 없는 파일이에요. MP3 파일을 골라 주세요.', 3000);
  draftTried = true;
  await addSetMp3(f, dur);
  db.put({ id: 'draft:add-mp3', blob: f, name: f.name, dur }).catch(() => {});
});
$$('#addMode button').forEach((b) => b.onclick = () => { ADD.mode = b.dataset.m; lsSet('hc-add-mode', ADD.mode); addRefresh(); });
// Claude 앱 방법
$('#appCopy').onclick = async () => {
  const t = $('#addTitle').value.trim(), a = $('#addArtist').value.trim();
  const text = APP_PROMPT + (t ? `\n\n곡: ${t}${a ? ' - ' + a : ''}` : '');
  try { await navigator.clipboard.writeText(text); toast('지시문을 복사했어요. Claude 앱에 악보를 올리고 붙여넣어 보내세요.', 3500); }
  catch {
    $('#appText').value = text; $('#appText').select();
    toast('자동 복사가 막혀 있어요. 아래 칸의 글을 길게 눌러 전체 복사해 주세요.', 4000);
  }
};
$('#appPaste').onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (!t || !t.trim()) return toast('복사된 내용이 없어요. Claude 답의 코드 블록 복사 버튼을 먼저 눌러 주세요.', 3500);
    $('#appText').value = t; appCheck(true);
  } catch { toast('자동 붙여넣기가 막혀 있어요. 아래 칸을 길게 눌러 붙여넣어 주세요.', 3500); $('#appText').focus(); }
};
function appCheck(fromBtn) {
  const el = $('#appCheck'), v = $('#appText').value;
  el.className = 'small'; ADD.parsed = null;
  if (!v.trim() || v.startsWith(APP_PROMPT.slice(0, 30))) { el.textContent = ''; addRefreshLite(); return; }
  lsSet('hc-add-paste', v);
  try {
    const sh = parseSheetText(v), c = checkSheet(sh);
    if (!c.notes) throw new Error('음표가 하나도 없어요');
    ADD.parsed = sh;
    el.className = 'small ok';
    el.textContent = `✓ 마디 ${c.measures}개 · 음표 ${c.notes}개 · ${sh.key_tonic} ${sh.key_mode === 'minor' ? '단조' : '장조'} · ${sh.time_signature}`
      + (c.odd ? ` — 박자가 안 맞는 마디 ${c.odd}개(그대로 써도 돼요)` : '') + (c.bad ? ` — 못 읽은 음 ${c.bad}개` : '');
    if (sh.title && !$('#addTitle').value) $('#addTitle').value = sh.title;
    if (sh.artist && !$('#addArtist').value) $('#addArtist').value = sh.artist;
    if (fromBtn) toast('Claude 답을 읽었어요', 2000);
  } catch (err) { el.className = 'small bad'; el.textContent = err.message; }
  addRefreshLite();
}
function addRefreshLite() { if (!ADD.busy) addRefresh(); }
$('#appText').addEventListener('input', () => appCheck());
$('#addSheet').addEventListener('change', (e) => {
  const fs = [...e.target.files]; e.target.value = '';
  if (!fs.length) return;
  ADD.sheets = fs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  addRefresh();
});
function addProg(title, sub, pct) {
  $('#addProg').hidden = false; $('#addProgT').textContent = title; $('#addProgS').textContent = sub || '';
  if (pct != null) $('#addProgBar').style.width = Math.round(pct) + '%';
}
$('#addMake').onclick = async () => {
  if (ADD.busy) return;
  const mode = addMode();
  if (mode === 'voice') {
    if (!ADD.mp3) return;
    const t = ADD.tags || {};
    const base = { id: `song-${Date.now()}`, title: $('#addTitle').value.trim() || ADD.mp3.name.replace(/\.[^.]+$/, ''), artist: $('#addArtist').value.trim(),
      source: 'voice', rawLyrics: t.lyrics || '', rec: { notes: [] } };
    const file = ADD.mp3;
    addReset();
    REC.openRec(base, file);
    return;
  }
  const typed = $('#addKey').value.trim();
  if (typed && mode === 'api') setKey(typed);
  const apiKey = getKey();
  if (mode === 'api' && !apiKey) { $('#addKeyBox').hidden = false; $('#addKey').focus(); return toast('Claude API 키를 먼저 넣어 주세요', 2500); }
  ADD.busy = true; addRefresh();
  let wake = null; try { wake = await navigator.wakeLock.request('screen'); } catch {}
  const title = $('#addTitle').value.trim(), artist = $('#addArtist').value.trim();
  const t0 = Date.now();
  let sub = '보통 1~3분 걸려요. 화면을 켜 둔 채 기다려 주세요.', pct = 5;
  const tick = setInterval(() => { if (pct < 70) addProg('① Claude가 악보를 읽는 중…', `${sub} (${Math.round((Date.now() - t0) / 1000)}초)`, pct); }, 1000);
  try {
    let sheet;
    if (mode === 'app') { clearInterval(tick); sheet = ADD.parsed; }
    else {
      addProg('① Claude가 악보를 읽는 중…', sub, pct);
      sheet = await readSheet({
        apiKey, files: ADD.sheets, title, artist,
        onProgress: (c) => { sub = `음표 받는 중… ${Math.round(c / 100) / 10}k 글자`; pct = Math.min(69, 10 + c / 600); },
      });
    }
    pct = 100; clearInterval(tick);
    const song = buildSong(sheet, { octave: ADD.oct, title, artist });
    const info = `음표 ${song.notes.length}개 · ${song.key} · ${song.time}`;
    addProg('② 원곡에 박자 맞추는 중…', info, 75);
    try {
      const al = await alignToAudio(song, ADD.mp3, (st) => addProg('② 원곡에 박자 맞추는 중…', `${info} · ${st === 'feat' ? '원곡 음 흐름 분석' : '악보와 원곡 맞추기'}`, st === 'feat' ? 82 : 92));
      song.orig = al.orig; song.origDuration = +al.duration.toFixed(2);
      song.auto.align = { ratio: +al.ratio.toFixed(4), offset: +al.offset.toFixed(2), score: +al.score.toFixed(3) };
    } catch (err) { console.warn('align', err); }
    addProg('③ 저장하는 중…', info, 97);
    await db.put(song);
    await db.put({ id: 'audio:' + song.id, blob: ADD.mp3, name: ADD.mp3.name, duration: ADD.dur });
    const ly = ADD.tags && ADD.tags.lyrics ? cleanLyrics(ADD.tags.lyrics, song) : lyricsFromSheet(song);
    if (ly) await db.put({ id: 'lyrics:' + song.id, text: ly });
    addProg('완성!', info, 100);
    S.orig = !!song.orig; S.speed = 1; save();
    const okAlign = song.orig && song.auto.align.score > 0.4;
    toast(`'${song.title}' 완성! ${okAlign ? '원곡과 박자를 맞췄어요.' : '원곡 박자가 어긋나면 원곡을 끄고 연습해 보세요.'}`, 4500);
    ADD.busy = false; addReset();
    openSong(song);
  } catch (err) {
    console.error(err);
    clearInterval(tick);
    ADD.busy = false;
    if (err && err.name === 'SheetError' && /API 키/.test(err.message)) setKey('');
    addRefresh();
    addProg('만들지 못했어요', (err && err.message) || String(err), 0);
  } finally { clearInterval(tick); try { wake && wake.release(); } catch {} }
};

/* ---------- 버전 2: 멜로디 녹음 화면 ---------- */
REC = initRec({
  $, db, show, toast, getCtx: () => getCtx(), S, save, outLat: () => outLat(), fmt, cleanLyrics,
  onDone: async (song) => {
    if (song.rawLyrics && !(await db.get('lyrics:' + song.id))) {
      const text = cleanLyrics(song.rawLyrics, song, false);   // 내 녹음은 음 개수가 가사 음절과 딱 맞지 않을 수 있어 줄을 덜어내지 않음
      if (text) await db.put({ id: 'lyrics:' + song.id, text });
    }
    S.orig = true; S.speed = 1; save();
    openSong(song);
  },
});
$('#plRec').onclick = () => { if (current && current.source === 'voice') { const s = current; stopPlay(); REC.openRec(s); } };

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
// 멜론·지니 검색 링크 (공식 사이트의 검색 결과를 여는 것 — 구매·복사는 사용자가 직접)
function storeLinks(song) {
  const q = encodeURIComponent(`${song.title} ${song.artist || ''}`.trim());
  return { melon: `https://www.melon.com/search/total/index.htm?q=${q}`, genie: `https://www.genie.co.kr/search/searchMain?query=${q}` };
}
function setLyricLinks() { const l = storeLinks(current); $('#lyMelon').href = l.melon; $('#lyGenie').href = l.genie; }
async function openSong(song) {
  current = song; setLyricLinks();
  let text = await lyricsOf(song);
  if (!text) {
    // 연결된 원곡 MP3 안에 가사가 있으면 그걸 씀
    const au = await db.get('audio:' + song.id);
    const ly = au && au.blob ? (await readTags(au.blob).catch(() => ({}))).lyrics : null;
    if (ly) { text = cleanLyrics(ly, song); await db.put({ id: 'lyrics:' + song.id, text }); toast('원곡 MP3 파일에서 가사를 가져왔어요', 2500); }
  }
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
$('#lyMp3').onclick = () => $('#lyMp3File').click();
$('#lyMp3File').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const tags = await readTags(f).catch(() => ({}));
  // 원곡으로도 연결 (재생할 수 있는 파일일 때)
  const dur = await new Promise((res) => { const a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(null); a.src = URL.createObjectURL(f); });
  if (dur != null) await db.put({ id: 'audio:' + current.id, blob: f, name: f.name, duration: dur });
  if (tags.lyrics) {
    $('#lyText').value = cleanLyrics(tags.lyrics, current); checkLyrics();
    toast(dur != null ? 'MP3에서 가사를 가져오고, 원곡으로도 연결했어요' : 'MP3에서 가사를 가져왔어요', 3000);
  } else toast(dur != null ? '이 MP3에는 가사가 없어요. 원곡으로만 연결했어요. 가사는 아래 방법으로 넣어 주세요.' : '이 파일에는 가사가 없어요', 4500);
});
$('#lyPaste').onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (!t || !t.trim()) return toast('복사된 내용이 없어요. 가사를 먼저 복사해 주세요.', 2500);
    $('#lyText').value = t; checkLyrics(); toast('붙여넣었어요. 아래 내용을 확인하고 저장하세요.', 2200);
  } catch { toast('자동 붙여넣기가 막혀 있어요. 아래 칸을 길게 눌러 붙여넣어 주세요.', 3500); $('#lyText').focus(); }
};
$('#lySave').onclick = async () => {
  const text = cleanLyrics($('#lyText').value, current);
  if (!text) return toast('가사를 붙여넣어 주세요');
  if (text !== $('#lyText').value.trim()) toast('제목·가수 같은 가사 아닌 줄은 뺐어요', 2500);
  await db.put({ id: 'lyrics:' + current.id, text });
  startPlay(text);
};

/* ---------- 연습 ---------- */
let actx, voice, melVoice, mic, origGain = null;
function applyOrigVol() { if (origGain) origGain.gain.value = S.origVol; else origEl.volume = Math.min(1, S.origVol); if (yt.player && yt.ready) { try { yt.player.setVolume(Math.min(100, Math.round(S.origVol * 100))); } catch {} } }
const P = { trace: [], t: 0, playing: false, base: 0, baseT: 0, hist: [], state: 'none', pend: 'none', pendN: 0, hit: 0, tot: 0, end: 0 };

function getCtx() {
  // 아이폰: 무음 모드에서도 소리 나게 + 마이크와 함께 쓰기
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)(); voice = new Voice(actx, S.patch || 'piano'); melVoice = new Voice(actx, 'mel');
    try {
      const src = actx.createMediaElementSource(origEl); origGain = actx.createGain();
      const lim = actx.createDynamicsCompressor(); lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.2;
      src.connect(origGain).connect(lim).connect(actx.destination);
    } catch {}
    applyOrigVol();
  }
  if (actx.state !== 'running') actx.resume();
  return actx;
}
function rate() { return S.speed || 1; }
/* 타임라인: 기본 = 악보 리듬(일정 템포), 원곡 모드 = 원곡 녹음에 정렬된 시간 */
const origEl = document.createElement('audio'); origEl.preload = 'auto'; origEl.setAttribute('playsinline', '');
let TL = [], origUrl = null;
const ORIG = () => S.orig && rate() === 1 && !!origUrl && !!current && !!current.orig && !yt.use;
/* 유튜브 영상을 원곡으로 (실험): 영상의 재생 시간을 시계로 씀. off = 영상 시간 − 곡 시간표 */
const yt = { id: null, off: 0, use: false, player: null, ready: false, lastT: -1, lastP: 0, state: -1, dur: 0 };
const YTM = () => S.orig && rate() === 1 && yt.use && !!yt.id && yt.ready && !!current;
const EXT = () => ORIG() || YTM();
function ytNow() {
  let c = 0; try { c = yt.player.getCurrentTime() || 0; } catch {}
  const perf = performance.now();
  if (c !== yt.lastT) { yt.lastT = c; yt.lastP = perf; }
  // 플레이어가 알려주는 시간은 띄엄띄엄 갱신됨 → 재생 중엔 그 사이를 이어서 계산 (최대 0.5초)
  return yt.state === 1 ? yt.lastT + Math.min(0.5, (perf - yt.lastP) / 1000) : c;
}
const ytCall = (fn, ...a) => { try { yt.player && yt.player[fn] && yt.player[fn](...a); } catch {} };
function ytId(url) {
  const m = String(url).trim().match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/) || String(url).trim().match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}
let ytApi = null;
function loadYtApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (!ytApi) ytApi = new Promise((res, rej) => {
    const prev = window.onYouTubeIframeAPIReady; window.onYouTubeIframeAPIReady = () => { prev && prev(); res(); };
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = () => { ytApi = null; rej(new Error('유튜브에 연결할 수 없어요')); }; document.head.appendChild(s);
  });
  return ytApi;
}
let ytBusy = false;
async function ytMount() {
  yt.ready = false; yt.state = -1; yt.lastT = -1;
  if (yt.player) { try { yt.player.destroy(); } catch {} yt.player = null; }
  $('#ytWrap').innerHTML = '<div id="ytBox"></div>';
  if (!yt.id || !yt.use) return;
  try { await loadYtApi(); } catch (e) { toast(e.message, 3500); return; }
  yt.player = new window.YT.Player('ytBox', {
    width: '100%', height: '100%', videoId: yt.id, playerVars: { playsinline: 1, rel: 0 },
    events: {
      onReady: () => { yt.ready = true; try { yt.dur = yt.player.getDuration() || 0; } catch {} applyOrigVol(); buildTL(); syncButtons(); },
      onStateChange: (e) => {
        yt.state = e.data;
        if (!yt.dur) { try { yt.dur = yt.player.getDuration() || 0; buildTL(); } catch {} }
        if (!YTM() || ytBusy) return;
        if (e.data === 0 && P.playing) finish();
        else if (e.data === 1 && !P.playing) togglePlay();        // 영상 안의 재생 버튼을 직접 누른 경우
        else if (e.data === 2 && P.playing) togglePlay();
      },
      onError: () => toast('이 영상은 앱 안에서 재생할 수 없어요(퍼가기가 막힌 영상일 수 있어요). 다른 영상을 연결해 주세요.', 5000),
    },
  });
}
async function ytSave() { if (current) await db.put({ id: 'yt:' + current.id, videoId: yt.id, off: yt.off, use: yt.use }); }
function buildTL() {
  const score = current.notes.map((n) => [n[0], n[1]]);
  if (YTM()) { const base = current.orig || score; TL = base.map(([s, d]) => [s + yt.off, d]); }
  else TL = ORIG() ? current.orig : score;
  const last = TL[TL.length - 1];
  P.end = YTM() ? (yt.dur || last[0] + last[1] + 5) : ORIG() ? (origEl.duration || current.origDuration || last[0] + last[1] + 1) : last[0] + last[1] + 1;
}
function now() {
  if (YTM()) return ytNow();
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
  if (YTM()) { ytBusy = true; ytCall('pauseVideo'); }
  fn();
  buildTL();
  const t = atStart ? 0 : timeAtEighth(pos);   // 처음이면 원곡도 처음(전주)부터
  if (ORIG()) { origEl.currentTime = t; if (wasPlaying) origEl.play().catch(() => {}); }
  else if (YTM()) { ytCall('seekTo', t, true); yt.lastT = t; yt.lastP = performance.now(); if (wasPlaying) ytCall('playVideo'); }
  else { P.t = t; P.baseT = t; P.base = performance.now(); }
  P.playing = wasPlaying;
  setTimeout(() => { ytBusy = false; }, 600);
  syncButtons();
}
async function loadOrig() {
  if (origUrl) { URL.revokeObjectURL(origUrl); origUrl = null; }
  const r = current && await db.get('audio:' + current.id);
  if (r && r.blob) { origUrl = URL.createObjectURL(r.blob); origEl.src = origUrl; }
  else origEl.removeAttribute('src');
  const y = current && await db.get('yt:' + current.id);
  yt.id = y ? y.videoId : null; yt.off = y ? y.off || 0 : 0; yt.use = !!(y && y.use);
  await ytMount();
}

function startPlay(text) {
  lyr = attachLyrics(current, cleanLyrics(text, current));
  buildNoteSyl();
  buildTL();
  loadOrig().then(() => { buildTL(); syncButtons(); });
  P.t = 0; P.playing = false; P.hit = 0; P.tot = 0; P.hist = []; P.trace = []; setState('none');
  applyView();
  $('#plTitle').textContent = current.title;
  $('#plRec').hidden = current.source !== 'voice';
  $('#plPlay').textContent = '▶';
  syncButtons();
  show('play');
  raf = requestAnimationFrame(frame);
}
function stopPlay() {
  P.playing = false;
  origEl.pause(); ytCall('pauseVideo');
  if (voice) voice.off();
  if (melVoice) melVoice.off();
}
async function togglePlay() {
  getCtx();
  if (!mic) {
    try { mic = new MicPitch(); await mic.start(actx, { aec: false, phoneMic: S.phoneMic !== false }); }   // 폰 에코 제거는 긴 음을 지워 버려서 끔 — 앱이 직접 거름
    catch (err) { mic = null; toast('마이크를 허용해 주세요. 설정 → 앱 → 화음 코치 → 권한 → 마이크 → "앱 사용 중에만 허용"', 5000); }
    try { await actx.resume(); } catch {}   // 마이크 켤 때 소리가 멈추는 기기 대비
  }
  if (P.playing) { P.t = now(); P.playing = false; origEl.pause(); if (YTM()) ytCall('pauseVideo'); voice.off(); melVoice.off(); $('#plPlay').textContent = '▶'; }
  else {
    if (now() >= P.end - 0.05) { P.t = 0; P.hit = 0; P.tot = 0; if (ORIG()) origEl.currentTime = 0; if (YTM()) ytCall('seekTo', 0, true); }
    P.baseT = P.t; P.base = performance.now(); P.playing = true; $('#plPlay').textContent = '⏸';
    P.calib = { t0: performance.now(), lv: [], amp: [] };
    if (ORIG()) { try { await origEl.play(); } catch (e) { toast('원곡을 재생할 수 없어요: ' + e.message); } }
    if (YTM()) ytCall('playVideo');
  }
}
$('#plPlay').onclick = togglePlay;
/* ---------- 이동: 재생 바, 이전/다음 마디, 반주 넘기기 ---------- */
function outLat() {
  let l = actx ? (actx.outputLatency || 0) + (actx.baseLatency || 0) : 0;
  if (!(l >= 0) || l > 0.6) l = 0;                      // 이상한 값은 무시
  return Math.max(-0.3, Math.min(0.9, l + (S.sync || 0) / 1000));
}
function seekTo(t) {
  t = Math.max(0, Math.min(P.end - 0.3, t));
  if (ORIG()) origEl.currentTime = t; else if (YTM()) { ytCall('seekTo', t, true); yt.lastT = t; yt.lastP = performance.now(); } else { P.t = t; P.baseT = t; P.base = performance.now(); }
  P.trace = []; P.hist = []; P.raw = []; P.jit = []; P.lock = null; lastLineKey = '';
}
let seeking = false;
(() => {
  const bar = $('#seek');
  const at = (e) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const show = (f) => { $('#prog').style.width = `${f * 100}%`; $('#thumb').style.left = `${f * 100}%`; $('#plTime').textContent = `${fmt((f * P.end) / rate())} / ${fmt(P.end / rate())}`; };
  bar.addEventListener('pointerdown', (e) => { seeking = true; bar.setPointerCapture(e.pointerId); bar.classList.add('drag'); show(at(e)); });
  bar.addEventListener('pointermove', (e) => { if (seeking) show(at(e)); });
  const end = (e) => { if (!seeking) return; seeking = false; bar.classList.remove('drag'); seekTo(at(e) * P.end); };
  bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', () => { seeking = false; bar.classList.remove('drag'); });
})();
function barJump(dir) {
  const t = now(), bars = current.bars;
  if (!bars || !bars.length || current.notes[0][4] == null) return seekTo(t + dir * 4);
  const pos = eighthAt(t);
  let dest;
  if (dir < 0) { const c = bars.filter((b) => b <= pos - 2); dest = c.length ? c[c.length - 1] : null; }   // 마디 초반(약 0.5초 이내)이면 그 앞 마디로
  else dest = bars.find((b) => b > pos + 0.05);
  if (dest == null) { if (dir > 0) return toast('마지막 마디예요', 900); const first = Math.max(0, TL[0][0] - 2); return seekTo(t > first + 0.5 ? first : 0); }   // 첫 마디에서는 노래 시작 직전으로
  seekTo(timeAtEighth(dest));
}
$('#plPrevBar').onclick = () => barJump(-1);
$('#plNextBar').onclick = () => barJump(1);
$('#plSkip').onclick = () => {
  const t = now();
  // 지금 위치 뒤에서, 3초 이상 노래가 비었다가 다시 시작하는 곳(= 전주·간주가 끝나는 곳)
  let j = -1;
  for (let i = 0; i < TL.length; i++) { if (TL[i][0] <= t + 2.2) continue; const gap = i === 0 ? TL[0][0] : TL[i][0] - (TL[i - 1][0] + TL[i - 1][1]); if (gap >= 3) { j = i; break; } }
  if (j < 0) return toast('건너뛸 반주가 없어요', 1200);
  seekTo(TL[j][0] - 2);
  toast('반주를 건너뛰었어요', 900);
};
$('#plRestart').onclick = () => { P.hit = 0; P.tot = 0; seekTo(0); };
const tapTone = () => { S.tone = !S.tone; save(); syncButtons(); toast(S.tone ? '화음음 켬' : '화음음 끔', 900); };
const tapMel = () => { S.mel = !S.mel; save(); syncButtons(); toast(S.mel ? '멜로디음 켬' : '멜로디음 끔', 900); };
document.querySelectorAll('#speedSeg button').forEach((b) => b.onclick = () => {
  const r = +b.dataset.r;
  if (r !== 1 && EXT()) toast('원곡은 1배에서만 나와요. 화음음·멜로디음으로 연습해요.', 2500);
  switchMode(() => { S.speed = r; if (r !== 1) S.orig = false; save(); });
});
// 원곡 버튼: 처음엔 폰의 음원 파일을 한 번 연결
const tapOrig = () => {
  if (!origUrl && !(yt.id && yt.use)) { const l = storeLinks(current); $('#ytFind').href = `https://www.youtube.com/results?search_query=${encodeURIComponent(current.title + ' ' + (current.artist || ''))}`; $('#orMelon').href = l.melon; $('#orGenie').href = l.genie; $('#origPanel').hidden = false; return; }
  const on = !EXT();
  switchMode(() => { S.orig = on; if (on) S.speed = 1; save(); });
  toast(on ? '원곡 켬 (원곡 박자에 맞춰 진행)' : '원곡 끔 (악보 박자로 진행)', 1800);
};
$('#origFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const dur = await new Promise((res) => { const a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(null); a.src = URL.createObjectURL(f); });
  if (dur == null) return toast('이 파일은 재생할 수 없어요 (보호된 파일일 수 있어요. MP3 다운로드로 받은 파일인지 확인해 주세요)', 4500);
  $('#origPanel').hidden = true;
  await db.put({ id: 'audio:' + current.id, blob: f, name: f.name, duration: dur });
  if (yt.use) { yt.use = false; await ytSave(); }
  await loadOrig();
  const diff = current.origDuration ? Math.abs(dur - current.origDuration) : 0;
  switchMode(() => { S.orig = true; S.speed = 1; save(); });
  toast(diff > 3 ? `원곡을 연결했어요. 길이가 ${fmt(dur)}로 맞춘 음원(${fmt(current.origDuration)})과 달라 박자가 어긋날 수 있어요.` : '원곡을 연결했어요. 1배에서 원곡과 함께 연습해요.', 4000);
});
$('#origPick').onclick = () => $('#origFile').click();
$('#ytConnect').onclick = async () => {
  const id = ytId($('#ytUrl').value);
  if (!id) return toast('유튜브 링크를 알아볼 수 없어요. 영상의 "공유 → 링크 복사"로 복사해 붙여넣어 주세요.', 4000);
  if (P.playing) await togglePlay();
  yt.id = id; yt.use = true; yt.off = 0; await ytSave(); await ytMount();
  $('#origPanel').hidden = true; $('#ytUrl').value = '';
  switchMode(() => { S.orig = true; S.speed = 1; save(); });
  toast('유튜브 영상을 연결했어요. 재생한 뒤 "첫 가사에 맞추기"로 박자를 맞춰 주세요.', 5000);
};
// 박자 맞춤: 가수가 첫 가사를 부르기 시작하는 순간 누르면, 그 영상 시간을 곡의 첫 음에 맞춤
async function ytSetOff(v) { const pos = now(); yt.off = Math.round(v * 100) / 100; await ytSave(); buildTL(); syncButtons(); P.trace = []; lastLineKey = ''; void pos; }
$('#ytTap').onclick = () => { if (!YTM()) return; const base = (current.orig || current.notes)[0][0]; ytSetOff(ytNow() - 0.2 - base); toast('첫 가사 위치를 맞췄어요. 어긋나면 아래 버튼으로 조금씩 옮기세요.', 3000); };
$('#ytLater').onclick = () => ytSetOff(yt.off + 0.1);
$('#ytEarlier').onclick = () => ytSetOff(yt.off - 0.1);
$('#ytChange').onclick = () => { yt.use = false; ytSave(); ytMount(); syncButtons(); $('#plOrig').click(); };
$('#origClose').onclick = () => { $('#origPanel').hidden = true; };
origEl.addEventListener('ended', () => { if (P.playing && ORIG()) finish(); });
$('#plBack').onclick = () => show('home');
/* ---------- 화음 가이드음 음색 고르기 ---------- */
function renderPatches() {
  const box = $('#patchList'); box.innerHTML = '';
  for (const [id, pt] of Object.entries(PATCHES)) {
    if (pt.hidden) continue;
    const b = document.createElement('button');
    b.className = 'patch' + ((S.patch || 'piano') === id ? ' sel' : '');
    b.innerHTML = '<b></b><span></span>'; b.firstChild.textContent = pt.label; b.lastChild.textContent = pt.desc;
    b.onclick = () => { S.patch = id; save(); getCtx(); voice.setPatch(id); renderPatches(); if (!P.playing) previewTone(); };
    box.appendChild(b);
  }
  $('#toneOct').checked = !!S.toneOct;
}
let pvT = [];
function previewTone() {
  getCtx(); pvT.forEach(clearTimeout); const o = S.toneOct ? 12 : 0;
  pvT = [[57, 0], [61, 420], [64, 840], [61, 1260]].map(([m, d], i) => setTimeout(() => voice.set(m + o, S.vol, 'pv' + i), d));
  pvT.push(setTimeout(() => { if (!P.playing) voice.off(); }, 2000));
}
$('#plPatch').onclick = () => { const v = $('#patchPanel'); v.hidden = !v.hidden; if (!v.hidden) renderPatches(); };
$('#patchClose').onclick = () => { $('#patchPanel').hidden = true; };
$('#toneOct').onchange = (e) => { S.toneOct = e.target.checked; save(); if (!P.playing) previewTone(); };
function applyView() {
  const g = S.view === 'graph';
  $('#play').classList.toggle('graph-mode', g);
  $('#plView').textContent = g ? '화살표' : '그래프';
  $('#plView').setAttribute('aria-label', g ? '화살표 모드로 바꾸기' : '그래프 모드로 바꾸기');
}
$('#plView').onclick = () => { S.view = S.view === 'graph' ? 'arrow' : 'graph'; save(); applyView(); toast(S.view === 'graph' ? '그래프 모드' : '화살표 모드', 900); };
$('#plLyrics').onclick = async () => {
  setLyricLinks();
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
volButton('#plOrig', 'origVol', 2, '원곡', tapOrig);
document.querySelectorAll('#harmSeg button').forEach((b) => b.onclick = () => { S.harm = b.dataset.h; save(); syncButtons(); });
function syncButtons() {
  for (const [id, on] of [['#plTone', S.tone], ['#plMel', S.mel], ['#plOrig', EXT()]]) { $(id).classList.toggle('off', !on); $(id).setAttribute('aria-pressed', on); }
  $('#plOrig').textContent = origUrl || (yt.id && yt.use) ? '원곡' : '원곡+';
  const ym = YTM(); $('#play').classList.toggle('yt-mode', ym); $('#ytWrap').hidden = !(yt.id && yt.use); $('#ytSync').hidden = !ym; $('#ytOffN').textContent = `${yt.off >= 0 ? '+' : ''}${yt.off.toFixed(1)}초`;
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
  const tA = now();                                  // 앱이 지금 '내보내는' 소리의 시간
  if (P.playing && tA >= P.end) { finish(); return; }
  // 귀에 '들리는' 시간: 블루투스 이어폰 등은 소리가 늦게 도착 → 화면·판정은 그만큼 늦춰서 소리와 맞춤
  const t = tA - outLat() * (EXT() ? 1 : rate());
  const niA = noteIndexAt(tA), ni = noteIndexAt(t);
  const harm = current.harmony[S.harm];
  const target = ni >= 0 ? harm[ni] : null;

  // 시작 전 카운트 (박마다 '틱')
  if (P.playing && !EXT() && current.eighth && tA < TL[0][0]) {
    const beat = Math.floor(tA / (current.eighth * 3));
    if (beat !== P.lastBeat) { P.lastBeat = beat; Voice.blip(actx, 84); }
  } else P.lastBeat = -1;
  // 화음음: 계속 들려줌. 시작 카운트 동안엔 첫 화음음을 미리 들려줘서 첫 음을 잡게 함
  const preRoll = P.playing && !EXT() && tA < TL[0][0];
  const toneMidi = !P.playing || !S.tone ? null : preRoll ? (tA > TL[0][0] - 1.0 ? harm[0] : null) : (niA >= 0 ? harm[niA] : null);
  // 음표 번호: 같은 음이 이어져도 새 음절이면 다시 침 (이음줄로 끄는 음은 그대로 이어짐)
  let nk = niA; while (nk > 0 && !current.notes[nk][3] && current.notes[nk][2] === current.notes[nk - 1][2] && TL[nk][0] - (TL[nk - 1][0] + TL[nk - 1][1]) < 0.05) nk--;
  if (voice) voice.set(toneMidi == null ? null : toneMidi + (S.toneOct ? 12 : 0), S.vol, preRoll ? -1 : nk);
  const melMidi = P.playing && S.mel && niA >= 0 ? current.notes[niA][2] : null;
  if (melVoice) melVoice.set(melMidi, S.melVol, nk);
  // 반주(전주·간주) 구간이면 '반주 넘기기' 버튼 강조
  const nxA = TL.findIndex((n) => n[0] > tA);
  $('#plSkip').classList.toggle('hot', niA < 0 && nxA >= 0 && TL[nxA][0] - tA > 4);

  // 내 목소리 (반응 시간 0.12초 감안)
  let sung = mic ? mic.read() : null;
  const lvl = mic ? (mic.level || 0) : 0;
  // 지금 앱이 내는 소리 크기(스피커 누출이 이 크기에 비례한다고 봄)
  const outAmp = (toneMidi != null ? S.vol : 0) + (melMidi != null ? S.melVol : 0) + ((ORIG() && !origEl.paused) || (YTM() && yt.state === 1) ? S.origVol * 0.5 : 0);
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
    // ⑥ 앱이 만든 소리 구별: 화음음·멜로디음은 음높이가 '완벽하게' 고정(떨림 3센트 미만)이고 그 음과 딱 같음.
    //    사람 목소리는 아무리 곧게 내도 미세하게 떨림 → 앱 소리와 같은 음 + 떨림 없음 = 스피커 소리로 보고 버림
    (P.jit ||= []).push(mic.lastRaw); if (P.jit.length > 10) P.jit.shift();
    if (sung != null && P.jit.length >= 8) {
      const mean = P.jit.reduce((a, b) => a + b, 0) / P.jit.length;
      const sd = Math.sqrt(P.jit.reduce((a, b) => a + (b - mean) ** 2, 0) / P.jit.length) * 100;   // 센트
      const synth = [toneMidi, melMidi].some((o) => { if (o == null) return false; let d = mean - o; d -= 12 * Math.round(d / 12); return Math.abs(d) < 0.12; });
      P.synthLike = synth && sd < 3;
    } else P.synthLike = false;
  } else { P.raw = []; P.jit = []; }
  if (sung != null) {
    const locked = P.lock && P.lock.ni === ni && Math.abs(((sung - P.lock.m + 6) % 12 + 12) % 12 - 6) < 0.8;
    // 앱 소리처럼 완벽히 고정된 음은 음의 시작으로 인정하지 않음 (사람은 음을 낼 때 반드시 흔들림). 이미 인정된 음은 끝까지 유지
    // 소리는 충분히 큰데 들리는 음이 앱 소리처럼 고정 → 스피커 소리가 내 목소리를 덮고 있음
    P.drowned = !locked && P.synthLike && lvl > expect * 1.8 && P.playing;
    if (P.drowned) P.drownedAt = performance.now();
    if (!locked && P.synthLike) sung = null;
    // ④ 소음·스피커 소리보다 확실히 커야 목소리 (긴 음은 시작이 또렷했으면 끝까지 기준을 낮춤)
    const minLv = Math.max(0.006, expect * (locked ? 1.25 : 1.8));
    if (lvl < minLv) sung = null;
    else if (S.filter) {
      // ⑤ 앱이 지금 내는 음(화음음·멜로디음·원곡 노래)과 같은 음이면 더 커야 함
      const outs = [];
      if (toneMidi != null) outs.push(toneMidi);
      if (melMidi != null) outs.push(melMidi);
      if (EXT() && ni >= 0) outs.push(current.notes[ni][2]);
      if (!locked && outs.some((o) => near(sung, o)) && lvl < expect * 2.0) sung = null;
    }
    if (sung != null && ni >= 0) { if (!locked) P.lock = { ni, m: sung }; else P.lock.m += (sung - P.lock.m) * 0.3; }   // 인정된 음은 그 음 끝까지 잠금 (기준 음은 실제로 내는 음을 따라감)
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
    hint.textContent = nx >= 0 && TL[nx][0] - t < 2.5 ? `${Math.ceil(TL[nx][0] - t)}…` : EXT() ? '전주·간주' : '쉬는 구간';
  } else if (!mic) hint.textContent = `목표 ${noteLabel(target)} · 마이크 꺼짐`;
  else if (sung == null && performance.now() - (P.drownedAt || 0) < 1500) hint.textContent = '화음음이 커서 내 목소리가 안 들려요 · 화음음을 줄이거나 이어폰을 쓰세요';
  else if (sung == null) hint.textContent = `목표 ${noteLabel(target)} · ${mic.level > 0.004 && rawSung == null ? '소리가 작거나 음이 흐려요' : '불러보세요'}`;
  else hint.textContent = `목표 ${noteLabel(tgt)} · ${cents == null ? '' : (cents > 0 ? '+' : '') + Math.round(cents) + '센트'}`;

  renderLyrics(t, ni);
  if (S.view === 'graph') drawPitchGraph(t, ni); else drawStaff(t, ni);
  $('#plTime').textContent = `${fmt(tA / rate())} / ${fmt(P.end / rate())}${rate() !== 1 ? ' · ' + rate() + '배' : ''}`;
  if (!seeking) { const pc = Math.min(100, Math.max(0, (tA / P.end) * 100)); $('#prog').style.width = `${pc}%`; $('#thumb').style.left = `${pc}%`; }
  raf = requestAnimationFrame(frame);
}

/* ---------- 악보 그리기 (오선, 조표, 멜로디=회색, 화음=파랑) ---------- */
// 조표에 맞춘 표기: 조표에 있는 음은 임시표 없이, 벗어난 음만 ♯·♭·♮
const NAT = [0, 2, 4, 5, 7, 9, 11];            // C D E F G A B
const SH_ORDER = [3, 0, 4, 1, 5, 2, 6], FL_ORDER = [6, 2, 5, 1, 4, 0, 3];   // F C G D A E B / B E A D G C F
const keyAccOf = (ks) => { const a = [0, 0, 0, 0, 0, 0, 0]; for (let i = 0; i < Math.abs(ks); i++) a[(ks > 0 ? SH_ORDER : FL_ORDER)[i]] = ks > 0 ? 1 : -1; return a; };
function staffPos(midi) {           // 아래 첫 줄(E4)=0, 한 칸=1/2줄
  const ks = current && current.keySig != null ? current.keySig : 2, ka = keyAccOf(ks);
  const pc = ((midi % 12) + 12) % 12;
  const cands = [];
  for (let l = 0; l < 7; l++) for (const acc of [0, 1, -1]) if ((NAT[l] + acc + 12) % 12 === pc) cands.push({ l, acc });
  const pick = cands.find((c) => c.acc === ka[c.l]) || cands.find((c) => c.acc === 0)
    || cands.find((c) => c.acc === (ks < 0 || pc === 10 ? -1 : 1)) || cands[0];
  const oct = Math.floor((midi - pick.acc) / 12) - 1;
  const acc = pick.acc === ka[pick.l] ? '' : pick.acc === 1 ? '♯' : pick.acc === -1 ? '♭' : '♮';
  return { step: oct * 7 + pick.l - (4 * 7 + 2), acc };
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
  const ksN = Math.abs(current.keySig != null ? current.keySig : 2), tsX = 22 + ksN * 10, LX = Math.max(44, tsX - 14), gap = 12, bottom = h - 54, playX = Math.max(90, w * 0.3), px = 30;   // 8분음표 하나 = 30px
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
  { const ks = current.keySig != null ? current.keySig : 2, SH = [8, 5, 9, 6, 3, 7, 4], FL = [4, 7, 3, 6, 2, 5, 1];
    for (let i = 0; i < Math.abs(ks); i++) g.fillText(ks > 0 ? '♯' : '♭', 12 + i * 10, Y((ks > 0 ? SH : FL)[i])); }
  if (current.time) { const [a, b] = current.time.split('/'); g.font = 'bold 15px serif'; g.fillStyle = ink; g.textAlign = 'center'; g.fillText(a, tsX, Y(6)); g.fillText(b, tsX, Y(2)); g.textAlign = 'left'; }
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
  $('#setAec').checked = S.filter; $('#setPhoneMic').checked = S.phoneMic !== false; $('#setOct').checked = S.octaveFree;
  $('#appVer').textContent = APP_VERSION;
  $('#setSync').value = S.sync || 0; syncLabel();
  $('#setKey').value = getKey();
}
document.querySelectorAll('#tolSeg button').forEach((b) => b.onclick = () => { S.tol = +b.dataset.t; save(); renderSettings(); });
function syncLabel() {
  const auto = actx ? Math.round(((actx.outputLatency || 0) + (actx.baseLatency || 0)) * 1000) : null, v = S.sync || 0;
  $('#syncN').textContent = `${v > 0 ? '+' : ''}${v}ms` + (auto != null ? ` (자동 감지한 소리 지연 ${auto}ms에 더함)` : '');
}
$('#setSync').oninput = (e) => { S.sync = +e.target.value; save(); syncLabel(); };
$('#setKey').onchange = (e) => { setKey(e.target.value); toast(e.target.value.trim() ? 'API 키를 저장했어요' : 'API 키를 지웠어요'); };
$('#setOct').onchange = (e) => { S.octaveFree = e.target.checked; save(); };
$('#setPhoneMic').onchange = (e) => { S.phoneMic = e.target.checked; save(); if (mic) { mic.stop(); mic = null; } toast('다음 재생부터 적용돼요'); };
$('#setAec').onchange = (e) => { S.filter = e.target.checked; save(); if (mic) { mic.stop(); mic = null; } };
// 앱을 닫거나 다른 앱으로 가면 마이크 끔 (돌아오면 다음 재생 때 다시 켬 — 권한은 다시 묻지 않음)
document.addEventListener('visibilitychange', () => { if (document.hidden && mic) { if (P.playing) togglePlay(); mic.stop(); mic = null; } });
$('#soundTest').onclick = () => {
  getCtx();
  previewTone();
  toast('라·도#·미 소리가 들리면 정상이에요. 안 들리면 미디어 볼륨과 무음 모드를 확인하세요.', 3500);
};
$('#origClear').onclick = async () => {
  for (const s of await db.getAll()) if (String(s.id).startsWith('audio:') || String(s.id).startsWith('yt:')) await db.del(s.id);
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
window.__seek = (t) => seekTo(t);
window.__leak = () => ({ noise: P.noise, leakPerAmp: P.leakPerAmp });

window.__dbgAudio = () => ({ actx, origEl, origGain, now: now(), pos: current ? eighthAt(now()) : 0, mel: melVoice && melVoice.cur, playing: P.playing, orig: ORIG() });
