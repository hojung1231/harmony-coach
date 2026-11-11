// 화음 코치 2 — 새 UI. 곡(MP3·가사·표지)은 이 폰의 앱 저장소(IndexedDB)에 저장
import * as db from './db.js';
const $ = (s) => document.querySelector(s);
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms); }

/* ---------- MP3 태그(ID3v2) 읽기: 제목·가수·가사·표지 ---------- */
function decodeText(b, enc) {
  try {
    if (enc === 0) return new TextDecoder('iso-8859-1').decode(b);
    if (enc === 1) return new TextDecoder(b[0] === 0xfe && b[1] === 0xff ? 'utf-16be' : 'utf-16le').decode(b[0] === 0xff || b[0] === 0xfe ? b.subarray(2) : b);
    if (enc === 2) return new TextDecoder('utf-16be').decode(b);
    return new TextDecoder('utf-8').decode(b);
  } catch { return ''; }
}
function splitNul(b, enc) {      // 인코딩에 맞는 문자열 끝(0) 위치
  if (enc === 1 || enc === 2) { for (let i = 0; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return [b.subarray(0, i), b.subarray(i + 2)]; }
  else { const i = b.indexOf(0); if (i >= 0) return [b.subarray(0, i), b.subarray(i + 1)]; }
  return [b, new Uint8Array(0)];
}
const clean = (s) => s.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
async function readTags(file) {
  const out = {};
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return out;   // 'ID3'
  const ver = head[3], size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
  const d = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
  let p = 0;
  if (head[5] & 0x40) { const ext = ver === 4 ? ((d[0] << 21) | (d[1] << 14) | (d[2] << 7) | d[3]) : ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) + 4; p = ext; }
  while (p + 10 <= d.length) {
    const id = String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const sz = ver === 4 ? (d[p + 4] << 21) | (d[p + 5] << 14) | (d[p + 6] << 7) | d[p + 7] : ((d[p + 4] << 24) | (d[p + 5] << 16) | (d[p + 6] << 8) | d[p + 7]) >>> 0;
    const body = d.subarray(p + 10, p + 10 + sz); p += 10 + sz;
    if (!sz || !body.length) continue;
    const enc = body[0];
    if (id === 'TIT2' && !out.title) out.title = clean(decodeText(body.subarray(1), enc));
    else if (id === 'TPE1' && !out.artist) out.artist = clean(decodeText(body.subarray(1), enc));
    else if (id === 'USLT' && !out.lyrics) { const [, text] = splitNul(body.subarray(4), enc); const ly = clean(decodeText(text, enc)); if (ly.length > 10) out.lyrics = ly; }
    else if (id === 'APIC' && !out.cover) {
      const r = body.subarray(1); const mEnd = r.indexOf(0); const mime = decodeText(r.subarray(0, mEnd), 0) || 'image/jpeg';
      const [, img] = splitNul(r.subarray(mEnd + 2), enc);
      if (img.length > 100) { out.coverBlob = new Blob([img], { type: mime.includes('/') ? mime : 'image/' + mime.toLowerCase() }); out.cover = URL.createObjectURL(out.coverBlob); }
    }
  }
  return out;
}

/* ---------- 상태 ---------- */
let songs = [];
const urls = new Map();   // 표지 Blob → 화면용 주소 (한 번만 만듦)
function coverUrl(s) { if (!s.coverBlob) return null; if (!urls.has(s.id)) urls.set(s.id, URL.createObjectURL(s.coverBlob)); return urls.get(s.id); }
async function loadSongs() { songs = (await db.all()).sort((a, b) => b.createdAt - a.createdAt).map((s) => ({ ...s, cover: coverUrl(s) })); }
let draft = null, step = 1;

function setCover(el, url) { el.style.backgroundImage = url ? `url("${url}")` : ''; el.textContent = url ? '' : '♪'; }
function songCard(s) {
  const el = document.createElement('div'); el.className = 'songcard';
  el.innerHTML = '<div class="cover"></div><div class="meta"><div class="t"></div><div class="a"></div></div>';
  setCover(el.querySelector('.cover'), s.cover); el.querySelector('.t').textContent = s.title; el.querySelector('.a').textContent = s.artist || '가수 정보 없음';
  return el;
}
async function renderHome() {
  await loadSongs();
  const box = $('#songs'); box.innerHTML = '';
  songs.forEach((s) => { const c = songCard(s); c.classList.add('tap'); c.onclick = () => showLyrics(s); box.appendChild(c); });
  $('#empty').hidden = songs.length > 0;
}

let sheetSong = null;
function showLyrics(s) {
  sheetSong = s; $('#shConfirm').hidden = true; $('#shDelete').hidden = false;
  const card = $('#shCard'); card.innerHTML = songCard(s).innerHTML; setCover(card.querySelector('.cover'), s.cover);
  const ly = $('#shLyrics'); ly.textContent = s.lyrics || '등록된 가사가 없어요.'; ly.classList.toggle('none', !s.lyrics); ly.scrollTop = 0;
  $('#lySheet').hidden = false;
}
$('#shClose').onclick = () => { $('#lySheet').hidden = true; };
$('#shDelete').onclick = () => { $('#shDelete').hidden = true; $('#shConfirm').hidden = false; };
$('#shNo').onclick = () => { $('#shConfirm').hidden = true; $('#shDelete').hidden = false; };
$('#shYes').onclick = async () => { if (!sheetSong) return; await db.del(sheetSong.id); urls.delete(sheetSong.id); $('#lySheet').hidden = true; toast(`'${sheetSong.title}'을(를) 삭제했어요`); renderHome(); };
$('#lySheet').onclick = (e) => { if (e.target.id === 'lySheet') $('#lySheet').hidden = true; };

/* ---------- 화면 이동 ---------- */
function route() {
  const add = location.hash === '#add';
  $('#home').hidden = add; $('#add').hidden = !add; $('#addSong').hidden = add; $('#dock').hidden = !add;
  if (add && !draft) reset();
  if (!add) { draft = null; renderHome(); }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
$('#addSong').onclick = () => { location.hash = 'add'; };
$('#addBack').onclick = () => { if (step === 2) return go(1); history.back(); };

function reset() { draft = null; $('#mp3').value = ''; $('#lyText').value = ''; go(1); }
function go(n) {
  step = n;
  $('#s1').hidden = n !== 1; $('#s2').hidden = n !== 2; $('#s3').hidden = n !== 3;
  $('#drop').hidden = !!draft; $('#picked').hidden = !draft;
  const total = draft && draft.lyricsFromFile ? 1 : 2;
  $('#stepNo').textContent = n === 3 ? '' : `${Math.min(n, total)} / ${total}`;
  $('#addBack').hidden = n === 3;
  const next = $('#next'), alt = $('#alt');
  alt.hidden = true;
  if (n === 1) {
    if (!draft) { next.textContent = '다음'; next.disabled = true; }
    else if (draft.lyricsFromFile) { next.textContent = '곡 추가하기'; next.disabled = false; }
    else { next.textContent = '다음 · 가사 넣기'; next.disabled = false; }
  } else if (n === 2) { next.textContent = '곡 추가하기'; next.disabled = !$('#lyText').value.trim(); }
  else { next.textContent = '목록으로'; next.disabled = false; }
  window.scrollTo(0, 0);
}

/* ---------- 1단계: MP3 고르기 ---------- */
$('#mp3').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const tags = await readTags(f).catch(() => ({}));
  const base = f.name.replace(/\.[^.]+$/, '');
  draft = { file: f, title: tags.title || base, artist: tags.artist || '', cover: tags.cover || null, coverBlob: tags.coverBlob || null, lyrics: tags.lyrics || '', lyricsFromFile: !!tags.lyrics };
  $('#pTitle').textContent = draft.title; $('#pArtist').textContent = draft.artist || '가수 정보 없음'; setCover($('#pCover'), draft.cover);
  const note = $('#pNote');
  if (draft.lyricsFromFile) { note.className = 'note ok'; note.innerHTML = `<span>✓</span><span><b>가사도 파일에 들어 있어요.</b> 가사 ${draft.lyrics.split('\n').filter((l) => l.trim()).length}줄을 읽었어요. 아래에서 확인하고 바로 추가할 수 있어요.</span>`; }
  else { note.className = 'note warn'; note.innerHTML = '<span>!</span><span><b>이 파일에는 가사가 없어요.</b> 다음 단계에서 가사를 넣어 주세요.</span>'; }
  $('#pLy').hidden = !draft.lyricsFromFile; $('#pLy').classList.remove('open'); $('#pLyMore').textContent = '가사 전체 보기';
  $('#pLyBody').textContent = draft.lyrics || '';
  go(1);
});
$('#pLyMore').onclick = () => { const o = $('#pLy').classList.toggle('open'); $('#pLyMore').textContent = o ? '접기' : '가사 전체 보기'; };
$('#pLyEdit').onclick = () => openLyrics();
$('#pChange').onclick = () => { draft = null; $('#mp3').value = ''; go(1); $('#mp3').click(); };

/* ---------- 2단계: 가사 ---------- */
function openLyrics() {
  const q = encodeURIComponent(`${draft.title} ${draft.artist}`.trim());
  $('#lyMelon').href = `https://www.melon.com/search/total/index.htm?q=${q}`; $('#lyGenie').href = `https://www.genie.co.kr/search/searchMain?query=${q}`;
  const fromFile = draft.lyricsFromFile;
  $('#lyQ').textContent = fromFile ? '가사를 확인해 주세요' : '가사를 넣어 주세요';
  $('#lySub').textContent = fromFile ? '파일에서 읽은 가사예요. 틀린 곳이 있으면 고쳐 주세요.' : '이 파일에는 가사가 들어 있지 않아요. 멜론·지니에서 가사를 복사해 붙여넣어 주세요.';
  $('#lyLinks').hidden = fromFile; $('#lyPaste').parentElement.hidden = fromFile;
  if (fromFile) $('#lyText').value = draft.lyrics;
  go(2);
}
$('#lyText').addEventListener('input', () => { if (step === 2) $('#next').disabled = !$('#lyText').value.trim(); });
$('#lyPaste').onclick = async () => {
  try { const t = await navigator.clipboard.readText(); if (t && t.trim()) { $('#lyText').value = t.trim(); $('#next').disabled = false; } }
  catch { $('#lyText').focus(); }
};

/* ---------- 버튼 ---------- */
function finish() {
  if (step === 2) { draft.lyrics = $('#lyText').value.trim(); if (draft.lyricsFromFile) $('#pLyBody').textContent = draft.lyrics; }
  const rec = { id: 'song-' + Date.now(), title: draft.title, artist: draft.artist, lyrics: draft.lyrics, mp3: draft.file, mp3Name: draft.file.name, coverBlob: draft.coverBlob, createdAt: Date.now() };
  db.put(rec).then(() => { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); })
    .catch((e) => toast('저장하지 못했어요: ' + (e && e.message || e), 4000));
  $('#dTitle').textContent = draft.title; $('#dArtist').textContent = draft.artist || '가수 정보 없음'; setCover($('#dCover'), draft.cover);
  go(3);
}
$('#next').onclick = () => {
  if (step === 1) return draft.lyricsFromFile ? finish() : openLyrics();
  if (step === 2) return finish();
  draft = null; location.hash = '';
};
$('#alt').onclick = () => openLyrics();

route();
