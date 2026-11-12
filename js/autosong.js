// 악보(PDF/사진) + 원곡 MP3 → 화음 코치 곡 데이터 자동 생성
// 1) Claude 가 악보를 읽어 멜로디 음표(음높이·길이·가사 음절)로 바꿔 줌
// 2) 앱이 음표 → 곡 데이터(시간·마디·화음) 로 변환
// 3) 원곡 MP3 의 음높이 흐름과 맞춰 템포·시작 위치를 자동으로 찾음

const MODEL = 'claude-opus-5-5';
let SDK = null;
async function sdk() { if (!SDK) SDK = (await import('./vendor/anthropic.mjs')).default; return SDK; }

/* ---------- 1. 악보 읽기 (Claude) ---------- */
const NOTE = {
  type: 'object', additionalProperties: false,
  required: ['p', 'd', 'tie', 'lyric'],
  properties: {
    p: { type: 'string', description: 'Pitch in scientific notation as written, e.g. "F#4", "Bb3", "C5"; or "rest"' },
    d: { type: 'number', description: 'Duration in sixteenth notes (eighth=2, dotted quarter=6, quarter-note triplet≈2.667)' },
    tie: { type: 'boolean', description: 'true if this note is tied to the next note (same pitch)' },
    lyric: { type: 'string', description: 'The lyric syllable sung on this note exactly as printed (one Korean character, etc.), or "" if none (melisma, tie continuation, rest)' },
  },
};
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'artist', 'key_tonic', 'key_mode', 'key_signature', 'time_signature', 'tempo_bpm', 'tempo_beat_16ths', 'measures', 'notes_on_reading'],
  properties: {
    title: { type: 'string' },
    artist: { type: 'string' },
    key_tonic: { type: 'string', description: 'Tonic of the key, e.g. "D", "Bb", "F#"' },
    key_mode: { type: 'string', enum: ['major', 'minor'] },
    key_signature: { type: 'integer', description: 'Number of sharps (positive) or flats (negative) in the key signature' },
    time_signature: { type: 'string', description: 'e.g. "4/4", "12/8"' },
    tempo_bpm: { type: 'number', description: 'Printed metronome mark number (guess if missing)' },
    tempo_beat_16ths: { type: 'number', description: 'Length of the beat the metronome mark counts, in sixteenths: quarter=4, dotted quarter=6, half=8, eighth=2' },
    measures: {
      type: 'array',
      description: 'Every measure of the vocal melody IN PERFORMANCE ORDER (repeats, 1st/2nd endings, D.S./D.C./Coda expanded)',
      items: {
        type: 'object', additionalProperties: false, required: ['n', 'notes'],
        properties: {
          n: { type: 'integer', description: 'Printed measure number of this measure (repeated measures reuse their number)' },
          notes: { type: 'array', items: NOTE },
        },
      },
    },
    notes_on_reading: { type: 'string', description: 'Short note (Korean) about anything uncertain' },
  },
};
const PROMPT = `You are transcribing the VOCAL MELODY of a song from its sheet music (images or PDF pages, in order) into structured data for a singing-practice app.

Rules:
- Transcribe only the sung melody line (the staff with lyrics under it). Ignore piano/guitar accompaniment and chord symbols.
- Output every measure in PERFORMANCE ORDER: expand repeat signs, 1st/2nd endings, D.S., D.C., segno and coda so the list plays straight through exactly as the singer would perform it. When a repeated passage has several lyric verses, use the verse that belongs to that pass.
- Intro, interlude and outro measures where the singer does not sing must still be output with the correct total length, as rests (also when instrument cue notes are printed on the vocal staff without lyrics).
- A pickup (anacrusis) measure is output with only its actual length.
- Pitches are as written on the staff (do not transpose), with accidentals resolved from the key signature and earlier accidentals in the same measure.
- Durations in sixteenth notes; the durations in each full measure must add up to the time signature.
- Tied notes: one entry per written note, tie=true on all but the last of the chain; the lyric goes on the first.
- lyric: the syllable printed under that note (Korean: one character per syllable). Notes continuing a syllable (melisma/slur) get "".
Be careful and exact: the app plays these pitches and rhythms back to the singer.`;

async function fileBlock(f) {
  const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(await f.arrayBuffer()) } };
  }
  // 사진은 긴 변 2400px JPEG 로 줄여 보냄 (용량 제한·속도)
  const bmp = await createImageBitmap(f);
  const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.9);
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) } };
}

export class SheetError extends Error { constructor(m) { super(m); this.name = 'SheetError'; } }

export async function readSheet({ apiKey, files, title, artist, onProgress, signal }) {
  const Anthropic = await sdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const content = [];
  for (const f of files) content.push(await fileBlock(f));
  content.push({ type: 'text', text: `${PROMPT}\n\nSong: "${title || '?'}" by ${artist || '?'}.` });
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  }, { signal });
  let chars = 0;
  stream.on('text', (d) => { chars += d.length; onProgress && onProgress(chars); });
  let msg;
  try { msg = await stream.finalMessage(); }
  catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new SheetError('API 키가 맞지 않아요. 설정에서 키를 다시 넣어 주세요.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new SheetError('이 API 키로는 사용할 수 없어요 (권한·결제 확인).');
    if (e instanceof Anthropic.RateLimitError) throw new SheetError('요청이 많아 잠시 막혔어요. 1분 뒤 다시 해 주세요.');
    if (e instanceof Anthropic.BadRequestError) throw new SheetError('악보 파일을 보낼 수 없어요: ' + (e.message || '').slice(0, 160));
    if (e instanceof Anthropic.APIError) throw new SheetError(`Claude 서버 오류(${e.status || '연결'}). 잠시 뒤 다시 해 주세요.`);
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new SheetError('Claude 가 이 악보를 처리하지 않았어요.');
  if (msg.stop_reason === 'max_tokens') throw new SheetError('악보가 너무 길어 끝까지 읽지 못했어요. 페이지를 나눠 보세요.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); } catch { throw new SheetError('악보 읽기 결과를 해석하지 못했어요. 다시 해 주세요.'); }
}

/* ---------- 2. 음표 → 곡 데이터 ---------- */
const LET = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function parsePitch(p) {
  const m = /^\s*([A-Ga-g])\s*(##|bb|x|#|♯|b|♭|n|♮)?\s*(-?\d)\s*$/.exec(p || '');
  if (!m) return null;
  const acc = { '#': 1, '♯': 1, '##': 2, x: 2, b: -1, '♭': -1, bb: -2 }[m[2]] || 0;
  return 12 * (+m[3] + 1) + LET[m[1].toUpperCase()] + acc;
}
const pcOf = (name) => { const v = parsePitch((name || 'C') + '4'); return v == null ? 0 : v % 12; };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
// 장조 음계 기준 n도 이동 (단조는 나란한조 장조 음계)
export function scaleShift(m, steps, tonic) {
  const rel = m - tonic, oct = Math.floor(rel / 12), idx = MAJOR.indexOf(((rel % 12) + 12) % 12);
  if (idx >= 0) { const d = oct * 7 + idx + steps, no = Math.floor(d / 7), ni = ((d % 7) + 7) % 7; return tonic + no * 12 + MAJOR[ni]; }
  // 임시표 음: 반음 내려/올려 음계음으로 계산한 뒤 같은 만큼 되돌림
  return scaleShift(m - 1, steps, tonic) + 1;
}
const SHARPS = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];

/**
 * sheet: readSheet 결과. opts.octave: 악보보다 몇 옥타브 아래로 부르는지 (남자 1, 여자 0)
 */
export function buildSong(sheet, { octave = 1, title, artist } = {}) {
  const beat16 = sheet.tempo_beat_16ths > 0 ? sheet.tempo_beat_16ths : 4;
  const bpm = sheet.tempo_bpm > 20 && sheet.tempo_bpm < 260 ? sheet.tempo_bpm : 80;
  const eighth = +((60 / bpm) / (beat16 / 2)).toFixed(4);
  const W = 12 * octave;
  const notes = [], bars = [], syl = [];
  let pos = 0;            // 16분음표 단위
  let pend = null;        // 붙임줄로 이어지는 음
  const push = (n) => { notes.push(n); };
  for (const [mi, ms] of (sheet.measures || []).entries()) {
    if (mi > 0) bars.push(pos / 2);
    for (const x of ms.notes || []) {
      const d = Math.max(0, +x.d || 0);
      const midi = /^\s*rest\s*$/i.test(x.p) ? null : parsePitch(x.p);
      if (midi == null) { if (pend) { push(pend); pend = null; } pos += d; continue; }
      if (pend && pend.m === midi) { pend.d += d; }
      else {
        if (pend) push(pend);
        pend = { s: pos, d, m: midi, ly: (x.lyric || '').trim() };
      }
      if (!x.tie) { push(pend); pend = null; }
      pos += d;
    }
  }
  if (pend) push(pend);
  if (!notes.length) throw new SheetError('악보에서 멜로디 음표를 찾지 못했어요.');
  const out = notes.map((n) => {
    const e = n.s / 2, de = n.d / 2;
    syl.push(n.ly);
    return [+(e * eighth).toFixed(3), +(de * eighth).toFixed(3), n.m - W, n.ly ? 1 : 0, e, de];
  });
  // 가사가 전혀 없으면 모든 음을 음절 시작으로
  if (!syl.some(Boolean)) out.forEach((n) => { n[3] = 1; });
  const tonicPc = pcOf(sheet.key_tonic);
  const majPc = sheet.key_mode === 'minor' ? (tonicPc + 3) % 12 : tonicPc;
  const up = out.map((n) => scaleShift(n[2], 2, majPc));
  const ks = Math.max(-7, Math.min(7, sheet.key_signature | 0));
  const tonicName = (sheet.key_tonic || '').replace('#', '♯').replace(/b$/, '♭');
  return {
    format: 'harmony-coach-song', version: 2,
    id: `song-${Date.now()}`, builtin: false,
    title: title || sheet.title || '새 곡', artist: artist || sheet.artist || '',
    key: `${tonicName} ${sheet.key_mode === 'minor' ? '단조' : '장조'}`,
    keySig: ks, time: sheet.time_signature || '4/4', tempo: bpm, writtenOctave: W, eighth,
    notes: out, bars,
    harmony: {
      third_up: up,
      third_down: out.map((n) => scaleShift(n[2], -2, majPc)),
      sixth_down: up.map((m) => m - 12),
    },
    sheetLyrics: syl,
    auto: { model: MODEL, note: sheet.notes_on_reading || '', created: Date.now() },
  };
}

// 악보 음절로 가사 텍스트 만들기 (MP3 에 가사가 없을 때) — 쉼표(1박 이상)에서 줄바꿈
export function lyricsFromSheet(song) {
  const lines = []; let cur = '';
  song.notes.forEach((n, i) => {
    const s = song.sheetLyrics[i], prev = song.notes[i - 1];
    const gap = prev ? n[4] - (prev[4] + prev[5]) : 0, len = [...cur].length;
    if (cur && s && (gap >= 2 || (gap >= 1 && len >= 5) || (len >= 14 && song.bars.some((x) => x > prev[4] && x <= n[4])))) { lines.push(cur.trim()); cur = ''; }
    if (s) cur += s;
  });
  if (cur.trim()) lines.push(cur.trim());
  return lines.join('\n');
}

/* ---------- 3. 원곡 MP3 에 맞추기 ---------- */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const k = i + j + len / 2, tr = re[k] * cr - im[k] * ci, ti = re[k] * ci + im[k] * cr;
        re[k] = re[i + j] - tr; im[k] = im[i + j] - ti; re[i + j] += tr; im[i + j] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
export const HOP = 0.05;
/** 모노 신호(sr) → 프레임별 12음 세기 (노래 음역 위주, 화성 합) */
export function pitchClassFeatures(x, sr) {
  const N = 4096, hop = Math.round(sr * HOP), F = Math.max(0, Math.floor((x.length - N) / hop));
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(N / 2);
  const feat = Array.from({ length: 12 }, () => new Float32Array(F));
  const bin = (f) => f * N / sr;
  const lo = 45, hi = 84;
  const sal = new Float32Array(hi - lo + 1);
  for (let f = 0; f < F; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < N / 2; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    for (let m = lo; m <= hi; m++) {
      const f0 = 440 * Math.pow(2, (m - 69) / 12);
      let s = 0;
      for (let h = 1; h <= 4; h++) {
        const b = bin(f0 * h); if (b >= N / 2 - 1) break;
        const b0 = Math.floor(b), w = b - b0;
        s += (mag[b0] * (1 - w) + mag[b0 + 1] * w) * Math.pow(0.8, h - 1);
      }
      sal[m - lo] = Math.log1p(s * 10);
    }
    const pcs = new Float32Array(12);
    for (let m = lo; m <= hi; m++) pcs[m % 12] = Math.max(pcs[m % 12], sal[m - lo]);
    let mean = 0, sd = 0; for (const v of pcs) mean += v / 12;
    for (const v of pcs) sd += (v - mean) ** 2 / 12; sd = Math.sqrt(sd) || 1;
    for (let k = 0; k < 12; k++) feat[k][f] = (pcs[k] - mean) / sd;
  }
  feat.center = N / 2 / sr;
  return feat;
}
/** 곡 음표가 원곡 어디에 놓이는지 찾음 → song.orig (음표별 [시작, 길이]) */
export function alignToFeatures(song, feat, duration) {
  const F = feat[0].length, C = feat.center || 0;
  const cum = feat.map((a) => { const c = new Float64Array(a.length + 1); for (let i = 0; i < a.length; i++) c[i + 1] = c[i] + a[i]; return c; });
  const N = song.notes, pcs = N.map((n) => ((n[2] % 12) + 12) % 12);
  const seg = (k, t0, t1) => {      // 음 k 의 시간 구간 평균 세기
    let a = Math.round((t0 - C) / HOP), b = Math.round((t1 - C) / HOP);
    if (b <= a) b = a + 1; if (a < 0 || b > F) return -0.5;
    return (cum[pcs[k]][b] - cum[pcs[k]][a]) / (b - a);
  };
  const score = (idx, off, r) => {
    let s = 0, w = 0;
    for (const k of idx) {
      const st = off + N[k][0] * r, d = Math.max(0.1, N[k][1] * r);
      const wt = Math.min(d, 1.2);
      s += seg(k, st + Math.min(0.06, d * 0.2), st + d * 0.85) * wt; w += wt;
    }
    return w ? s / w : -9;
  };
  // 쉬는 구간(2.5초 이상)으로 부분을 나눔 — 악보는 간주를 줄여 적는 경우가 많아 부분마다 시작 위치를 따로 찾음
  const parts = []; let cur = [0];
  for (let i = 1; i < N.length; i++) {
    if (N[i][0] - (N[i - 1][0] + N[i - 1][1]) >= 2.5) { parts.push(cur); cur = []; }
    cur.push(i);
  }
  parts.push(cur);
  const span = (p) => [N[p[0]][0], N[p[p.length - 1]][0] + N[p[p.length - 1]][1]];
  const wts = parts.map((p) => p.length);
  const OS = 0.1, O0 = -N[0][0] * 1.15 - 2, NO = Math.ceil((duration - O0) / OS);
  // 템포 비율 r 마다: 부분별 점수표 → 순서(앞 부분이 끝난 뒤 다음 부분 시작)를 지키며 합이 최대인 조합 (DP)
  const solve = (r, idxOf, offAt, nOff) => {
    let prev = null;
    const choice = [];
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi], ids = idxOf(p), [a, b] = span(p);
      const cur = new Float64Array(nOff).fill(-1e9), arg = new Int32Array(nOff).fill(-1);
      const pm = prev && new Float64Array(nOff), pa = prev && new Int32Array(nOff);
      if (prev) { let m = -1e9, mi = -1; for (let o = 0; o < nOff; o++) { if (prev[o] > m) { m = prev[o]; mi = o; } pm[o] = m; pa[o] = mi; } }
      const pb = pi ? span(parts[pi - 1])[1] : 0;
      for (let o = 0; o < nOff; o++) {
        const off = offAt(o), st = off + a * r;
        if (st < -0.5 || off + b * r > duration + 2) continue;
        let base = 0, from = -1;
        if (prev) {
          // 앞 부분 끝(오프셋 o') ≤ 이 부분 시작 + 0.5 → o' ≤ (st + 0.5 - pb*r - O0)/OS
          const lim = Math.min(nOff - 1, Math.floor((st + 0.5 - pb * r - offAt(0)) / (offAt(1) - offAt(0))));
          if (lim < 0 || pm[lim] < -1e8) continue;
          base = pm[lim]; from = pa[lim];
        }
        cur[o] = base + score(ids, off, r) * wts[pi]; arg[o] = from;
      }
      choice.push(arg); prev = cur;
    }
    let bo = 0; for (let o = 1; o < nOff; o++) if (prev[o] > prev[bo]) bo = o;
    const offs = new Array(parts.length); let o = bo;
    for (let pi = parts.length - 1; pi >= 0; pi--) { offs[pi] = offAt(o); o = choice[pi][o]; }
    return { s: prev[bo] / N.length, offs };
  };
  let best = { s: -1e9 };
  const half = (p) => p.filter((_, j) => j % 2 === 0);
  for (let r = 0.88; r <= 1.1201; r += 0.004) {
    const res = solve(r, half, (o) => O0 + o * OS, NO);
    if (res.s > best.s) best = { ...res, r };
  }
  // 촘촘히 다듬기: 비율 ±, 각 부분 시작 ±0.3초
  for (let it = 0; it < 2; it++) {
    const b0 = best, sr = it ? 0.0003 : 0.001;
    for (let r = b0.r - sr * 6; r <= b0.r + sr * 6 + 1e-9; r += sr) {
      const res = { r, offs: b0.offs.map((o0, pi) => {
        let bo = o0, bs = -1e9;
        for (let off = o0 - 0.3; off <= o0 + 0.3; off += 0.01) { const s = score(parts[pi], off, r); if (s > bs) { bs = s; bo = off; } }
        return bo;
      }) };
      res.s = res.offs.reduce((t, off, pi) => t + score(parts[pi], off, r) * wts[pi], 0) / N.length;
      if (res.s > best.s) best = res;
    }
  }
  const offs = best.offs;
  const orig = [];
  parts.forEach((p, pi) => { for (const k of p) orig.push([+(offs[pi] + N[k][0] * best.r).toFixed(3), +(N[k][1] * best.r).toFixed(3)]); });
  return { orig, ratio: best.r, offset: offs[0], score: best.s, partOffsets: offs };
}
export async function alignToAudio(song, blob, onStage) {
  const buf = await blob.arrayBuffer();
  const ac = new OfflineAudioContext(1, 1, 44100);
  const dec = await ac.decodeAudioData(buf);
  const sr = 11025, len = Math.ceil(dec.duration * sr);
  const oc = new OfflineAudioContext(1, len, sr);
  const src = oc.createBufferSource(); src.buffer = dec; src.connect(oc.destination); src.start();
  const mono = (await oc.startRendering()).getChannelData(0);
  onStage && onStage('feat');
  await new Promise((r) => setTimeout(r, 30));
  const feat = pitchClassFeatures(mono, sr);
  onStage && onStage('fit');
  await new Promise((r) => setTimeout(r, 30));
  const res = alignToFeatures(song, feat, dec.duration);
  return { ...res, duration: dec.duration };
}
