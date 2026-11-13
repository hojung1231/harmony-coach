// 버전 2 — 멜로디 녹음 화면: 원곡/MR 을 들으며 멜로디를 부르면 음표(미디)가 됨
import { MicPitch, Voice } from './pitch.js';
import { VSR, pitchTrack, segment, tuningOffset, estimateKey, meanChroma, estimateTempo, refineLag, buildVoiceSong, midiFile } from './voice.js';
import { pitchClassFeatures } from './autosong.js';

export function initRec(D) {
  const { $, db, show, toast, getCtx, S, save, outLat, fmt, onDone } = D;
  const R = {
    song: null, file: null, buf: null, dur: 0, pos: 0, mode: null, sel: -1,
    feat: null, chroma: null, tempo: null, analyzing: null, live: [], raf: 0,
  };
  const cv = $('#recRoll');

  /* ---------- 열기 ---------- */
  async function openRec(song, file) {
    R.song = song; R.song.rec = R.song.rec || { notes: [] }; R.file = file || null;
    R.buf = null; R.feat = null; R.tempo = null; R.analyzing = null; R.sel = -1; R.live = []; R.pos = 0;
    $('#recTitle').textContent = song.title || '멜로디 녹음';
    micLabel();
    show('rec');
    info('원곡 불러오는 중…');
    try {
      if (!R.file) { const a = await db.get('audio:' + song.id); R.file = a && a.blob; }
      if (!R.file) throw new Error('원곡 MP3가 없어요');
      const ctx = getCtx();
      R.buf = await ctx.decodeAudioData(await R.file.arrayBuffer());
      R.dur = R.buf.duration;
      $('#recSeek').max = R.dur.toFixed(1);
      const notes = R.song.rec.notes;
      if (notes.length) R.pos = Math.max(0, notes[0].t - 2);
      analyzeOrig();          // 뒤에서 미리 (조·템포·지연 보정용)
      refresh(); draw();
    } catch (e) { info('원곡을 열 수 없어요: ' + e.message); }
  }
  function analyzeOrig() {
    if (!R.analyzing) R.analyzing = (async () => {
      const sr = 11025, len = Math.ceil(R.buf.duration * sr);
      const oc = new OfflineAudioContext(1, len, sr);
      const src = oc.createBufferSource(); src.buffer = R.buf; src.connect(oc.destination); src.start();
      const mono = (await oc.startRendering()).getChannelData(0);
      await new Promise((r) => setTimeout(r, 20));
      R.feat = pitchClassFeatures(mono, sr); R.chroma = meanChroma(R.feat);
      await new Promise((r) => setTimeout(r, 20));
      R.tempo = estimateTempo(mono, sr);
    })().catch((e) => console.warn('orig analyze', e));
    return R.analyzing;
  }

  /* ---------- 마이크 고르기: 폰 마이크 / 블루투스 이어폰 마이크 ---------- */
  function micLabel() {
    const ph = S.phoneMic !== false;
    document.querySelectorAll('#recMic button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.mic === 'phone') === ph)));
    $('#recMicName').textContent = mic && mic.micName ? `사용 중: ${mic.micName}` : ph ? '노래는 폰 마이크로 받아요' : '노래는 이어폰 마이크로 받아요';
  }
  document.querySelectorAll('#recMic button').forEach((b) => b.onclick = () => {
    if (R.mode) return toast('녹음·듣기를 멈춘 뒤 바꿔 주세요');
    const ph = b.dataset.mic === 'phone';
    if ((S.phoneMic !== false) === ph) return;
    S.phoneMic = ph; save();
    if (mic) { mic.stop(); mic = null; }
    micLabel();
    toast(ph ? '폰 마이크로 바꿨어요' : '이어폰 마이크로 바꿨어요. 폰이 통화 모드가 되어 원곡이 작고 탁하게 들릴 수 있어요.', 3500);
  });

  /* ---------- 상태 표시 ---------- */
  function info(t) { $('#recInfo').textContent = t; }
  function refresh() {
    const n = R.song.rec.notes;
    const k = R.song.rec.key, names = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
    if (R.mode !== 'rec') info(n.length ? `음표 ${n.length}개${k ? ` · ${names[k.tonic]} ${k.mode === 'minor' ? '단조' : '장조'}` : ''} — 틀린 곳은 그 위치로 옮겨 다시 녹음하면 그 부분만 바뀌어요`
      : '이어폰을 끼고 ● 녹음을 누른 뒤, 원곡을 들으며 멜로디를 불러 주세요 (가사나 "라라라")');
    $('#recRec').textContent = R.mode === 'rec' ? '■ 정지' : '● 녹음';
    $('#recRec').classList.toggle('on', R.mode === 'rec');
    $('#recPlay').textContent = R.mode === 'listen' ? '■ 정지' : '▶ 듣기';
    $('#recPlay').disabled = R.mode === 'rec' || !n.length;
    $('#recDone').disabled = R.mode != null || !n.length;
    $('#recMidi').disabled = R.mode != null || !n.length;
    $('#recEdit').hidden = R.sel < 0 || R.mode != null;
    $('#recTime').textContent = `${fmt(R.pos)} / ${fmt(R.dur)}`;
    $('#recSeek').value = R.pos;
  }

  /* ---------- 원곡 재생 (녹음·듣기 공용) ---------- */
  let src = null, srcWhen = 0, srcFrom = 0, gain = null;
  function startOrig(from) {
    const ctx = getCtx();
    src = ctx.createBufferSource(); src.buffer = R.buf;
    gain = ctx.createGain(); gain.gain.value = 0.9;
    src.connect(gain).connect(ctx.destination);
    srcWhen = ctx.currentTime + 0.12; srcFrom = from;
    src.start(srcWhen, from);
    src.onended = () => { if (R.mode && src && R.mode !== null) stopAll(); };
  }
  const origNow = () => srcFrom + (getCtx().currentTime - srcWhen);    // 지금 재생 중인 원곡 시각 (출력 지연 전)
  function stopOrig() { if (src) { src.onended = null; try { src.stop(); } catch {} src.disconnect(); src = null; } }

  /* ---------- 녹음 ---------- */
  let mic = null, sp = null, sink = null, chunks = [], acc = 0, accN = 0, step = 6, firstT = null, recFrom = 0, lagEst = 0;
  async function startRec() {
    if (!R.buf) return;
    const ctx = getCtx();
    try {
      if (!mic) {
        mic = new MicPitch(); await mic.start(ctx, { aec: false, phoneMic: S.phoneMic !== false });
        if (mic.micKind === 'ear' && !mic.micFound) toast('이어폰 마이크를 찾지 못해 기본 마이크로 녹음해요. 이어폰이 연결됐는지 확인해 주세요.', 4000);
        micLabel();
      }
    } catch { mic = null; return toast('마이크를 허용해 주세요. 설정 → 앱 → 화음 코치 → 권한 → 마이크', 4500); }
    R.mode = 'rec'; R.sel = -1; R.live = [];
    recFrom = R.pos;
    const from = Math.max(0, recFrom - 3);          // 3초 앞부터 들려줌 (준비)
    chunks = []; acc = 0; accN = 0; step = ctx.sampleRate / VSR; firstT = null;
    lagEst = outLat();
    sp = ctx.createScriptProcessor(2048, 1, 1);
    sink = ctx.createGain(); sink.gain.value = 0;
    mic.src.connect(sp); sp.connect(sink).connect(ctx.destination);
    let phase = 0;
    sp.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      if (firstT == null) firstT = ctx.currentTime - x.length / ctx.sampleRate;
      const out = new Float32Array(Math.ceil(x.length / step) + 1); let k = 0;
      for (let i = 0; i < x.length; i++) {
        acc += x[i]; accN++; phase += 1;
        if (phase >= step) { phase -= step; out[k++] = acc / accN; acc = 0; accN = 0; }
      }
      chunks.push(out.subarray(0, k));
    };
    startOrig(from);
    refresh(); loop();
  }
  async function stopRec() {
    const ctx = getCtx();
    const stopAt = origNow();
    stopOrig();
    if (sp) { sp.onaudioprocess = null; try { mic.src.disconnect(sp); } catch {} sp.disconnect(); sink.disconnect(); sp = null; }
    R.mode = null; refresh();
    if (firstT == null) return;
    info('내 목소리를 음표로 바꾸는 중…');
    await new Promise((r) => setTimeout(r, 30));
    const total = chunks.reduce((s, c) => s + c.length, 0), x = new Float32Array(total);
    let o = 0; for (const c of chunks) { x.set(c, o); o += c.length; }
    chunks = [];
    // 녹음 샘플 0 의 원곡 시각 = (녹음 시작 ctx 시각 - 원곡 시작 ctx 시각) + 원곡 시작 위치 - 내 귀까지의 지연
    const t0 = srcFrom + (firstT - srcWhen) - lagEst - (ctx.baseLatency || 0);
    const tr = pitchTrack(x);
    let segs = segment(tr).map((n) => ({ ...n, t: n.t + t0 }));
    const recTo = Math.min(stopAt, R.dur);
    segs = segs.filter((n) => n.t >= recFrom - 0.15 && n.t < recTo);
    if (!segs.length) { info('목소리가 잡히지 않았어요. 이어폰을 끼고 폰 마이크 가까이에서 불러 주세요.'); return; }
    const tun = tuningOffset(segs);
    segs.forEach((n) => { n.m = Math.round(n.m - tun); });
    await analyzeOrig();
    // 지연 보정: 충분히 긴 녹음에서 한 번 찾아 두고(같은 폰·이어폰이면 그대로), 짧게 다시 부를 땐 그 값을 씀
    //  (일부러/실수로 틀리게 부른 짧은 구간은 원곡과 안 맞아 지연을 잘못 찾을 수 있음)
    const rec0 = R.song.rec;
    const kind = S.phoneMic !== false ? 'phone' : 'ear';      // 마이크마다 지연이 달라 따로 기억
    rec0.dtBy = rec0.dtBy || {};
    const known = rec0.dtBy[kind];
    let dt = known != null ? known : 0;
    if (R.feat && (segs.length >= 25 || known == null)) { dt = refineLag(segs, R.feat); if (segs.length >= 25) rec0.dtBy[kind] = dt; }
    segs.forEach((n) => { n.t += dt; });
    // 그 구간만 바꿔 끼우기
    const rec = R.song.rec;
    rec.notes = rec.notes.filter((n) => n.t < recFrom - 0.05 || n.t >= recTo).concat(segs.map((n) => ({ t: +n.t.toFixed(3), d: +n.d.toFixed(3), m: n.m, on: n.on }))).sort((a, b) => a.t - b.t);
    // 겹침 정리
    for (let i = 0; i < rec.notes.length - 1; i++) { const a = rec.notes[i], b = rec.notes[i + 1]; if (a.t + a.d > b.t) a.d = Math.max(0.05, +(b.t - a.t).toFixed(3)); }
    rec.key = estimateKey(rec.notes, R.chroma);
    if (R.tempo) rec.tempo = { bpm: R.tempo.bpm, phase: R.tempo.phase, beat: R.tempo.beat };
    await saveSong();
    toast(`${segs.length}개 음을 받았어요${R.song.rec.notes.length > segs.length ? ' (그 구간만 바꿨어요)' : ''}`, 2500);
    refresh(); draw();
  }
  async function saveSong() {
    const built = buildVoiceSong({ id: R.song.id, title: R.song.title, artist: R.song.artist, rawLyrics: R.song.rawLyrics }, R.song.rec, R.dur);
    if (!built) return;
    R.song = built;
    await db.put(built);
    if (R.file && !(await db.get('audio:' + built.id))) await db.put({ id: 'audio:' + built.id, blob: R.file, name: R.file.name || 'song.mp3', duration: R.dur });
  }

  /* ---------- 듣기 (원곡 + 내 멜로디) ---------- */
  let mv = null;
  function startListen() {
    const ctx = getCtx();
    if (!mv) mv = new Voice(ctx, 'piano');
    R.mode = 'listen'; R.sel = -1;
    startOrig(R.pos); refresh(); loop();
  }
  function stopAll() {
    if (R.mode === 'rec') return stopRec();
    stopOrig(); if (mv) mv.off();
    R.mode = null; refresh(); draw();
  }

  /* ---------- 화면 갱신 루프 ---------- */
  function loop() {
    cancelAnimationFrame(R.raf);
    const tick = () => {
      if (!R.mode) return;
      const t = origNow();
      if (t >= 0) R.pos = Math.min(R.dur, t);
      if (R.mode === 'rec' && mic) {
        const m = mic.read(), tt = t - lagEst;
        R.live.push([tt, m == null ? null : m]);
        if (R.live.length > 2000) R.live.splice(0, 500);
      }
      if (R.mode === 'listen' && mv) {
        const ns = R.song.rec.notes; let cur = -1;
        for (let i = 0; i < ns.length; i++) { if (ns[i].t > t) break; if (t < ns[i].t + ns[i].d) cur = i; }
        mv.set(cur >= 0 ? ns[cur].m : null, 0.5, cur);
      }
      $('#recTime').textContent = `${fmt(R.pos)} / ${fmt(R.dur)}`; $('#recSeek').value = R.pos;
      draw();
      R.raf = requestAnimationFrame(tick);
    };
    R.raf = requestAnimationFrame(tick);
  }

  /* ---------- 피아노롤 ---------- */
  const PPS = 90;
  function geom() {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ns = R.song ? R.song.rec.notes : [];
    let lo = 48, hi = 72;
    if (ns.length) { lo = Math.min(...ns.map((n) => n.m)) - 3; hi = Math.max(...ns.map((n) => n.m)) + 3; if (hi - lo < 14) { const c = (hi + lo) / 2; lo = Math.floor(c - 7); hi = Math.ceil(c + 7); } }
    const px = w * 0.3;
    return { dpr, w, h, lo, hi, X: (t) => px + (t - R.pos) * PPS, Y: (m) => h - 8 - ((m - lo) / (hi - lo)) * (h - 16), px };
  }
  function draw() {
    if (!R.song) return;
    const { dpr, w, h, lo, hi, X, Y, px } = geom();
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.body);
    g.fillStyle = css.getPropertyValue('--panel') || '#151a2a'; g.fillRect(0, 0, w, h);
    const NAMES = ['도', '', '레', '', '미', '파', '', '솔', '', '라', '', '시'];
    g.font = '10px sans-serif'; g.textBaseline = 'middle';
    for (let m = Math.ceil(lo); m <= hi; m++) {
      const y = Y(m), pc = ((m % 12) + 12) % 12;
      g.strokeStyle = pc === 0 ? 'rgba(150,160,200,.35)' : 'rgba(150,160,200,.1)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      if (NAMES[pc]) { g.fillStyle = 'rgba(160,170,210,.6)'; g.fillText(NAMES[pc] + (pc === 0 ? Math.floor(m / 12) - 1 : ''), 4, y); }
    }
    const rh = Math.max(4, (h - 16) / (hi - lo) * 0.8);
    const ns = R.song.rec.notes;
    ns.forEach((n, i) => {
      const x1 = X(n.t), x2 = X(n.t + n.d); if (x2 < 0 || x1 > w) return;
      g.fillStyle = i === R.sel ? '#ffb020' : (n.t <= R.pos && R.pos < n.t + n.d ? '#7fb2ff' : '#3d7dff');
      g.beginPath(); g.roundRect ? g.roundRect(x1, Y(n.m) - rh / 2, Math.max(3, x2 - x1 - 1), rh, 3) : g.rect(x1, Y(n.m) - rh / 2, Math.max(3, x2 - x1 - 1), rh); g.fill();
      if (n.on) { g.fillStyle = 'rgba(255,255,255,.7)'; g.fillRect(x1, Y(n.m) - rh / 2, 2, rh); }
    });
    // 녹음 중 실시간 목소리
    if (R.live.length) {
      g.strokeStyle = '#ff5a6e'; g.lineWidth = 2.5; g.beginPath(); let pen = false;
      for (const [t, m] of R.live) { if (m == null || m < lo - 6 || m > hi + 6) { pen = false; continue; } const x = X(t), y = Y(m); if (pen) g.lineTo(x, y); else g.moveTo(x, y); pen = true; }
      g.stroke();
    }
    g.strokeStyle = '#ffb020'; g.lineWidth = 2; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();
    if (!ns.length && !R.mode) { g.fillStyle = 'rgba(200,205,230,.7)'; g.font = '14px sans-serif'; g.textAlign = 'center'; g.fillText('녹음하면 여기에 내 멜로디 음표가 그려져요', w / 2, h / 2); g.textAlign = 'left'; }
  }

  /* ---------- 조작 ---------- */
  let drag = null;
  cv.addEventListener('pointerdown', (e) => { if (R.mode) return; drag = { x: e.clientX, y: e.clientY, pos: R.pos, moved: false }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return; const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 6) drag.moved = true;
    if (drag.moved) { R.pos = Math.max(0, Math.min(R.dur, drag.pos - dx / PPS)); refresh(); draw(); }
  });
  cv.addEventListener('pointerup', (e) => {
    if (!drag) return; const d = drag; drag = null;
    if (d.moved) return;
    const r = cv.getBoundingClientRect(), { X, Y, lo, hi, h } = geom(), x = e.clientX - r.left, y = e.clientY - r.top;
    const rh = Math.max(10, (h - 16) / (hi - lo));
    R.sel = R.song.rec.notes.findIndex((n) => x >= X(n.t) - 4 && x <= X(n.t + n.d) + 4 && Math.abs(y - Y(n.m)) <= rh);
    refresh(); draw();
  });
  $('#recSeek').addEventListener('input', (e) => { if (R.mode) return; R.pos = +e.target.value; R.sel = -1; refresh(); draw(); });
  $('#recBack5').onclick = () => { if (R.mode) return; R.pos = Math.max(0, R.pos - 5); refresh(); draw(); };
  $('#recFwd5').onclick = () => { if (R.mode) return; R.pos = Math.min(R.dur, R.pos + 5); refresh(); draw(); };
  $('#recStart').onclick = () => { if (R.mode) return; const ns = R.song.rec.notes; R.pos = ns.length && R.pos > ns[0].t ? Math.max(0, ns[0].t - 2) : 0; refresh(); draw(); };
  $('#recRec').onclick = () => (R.mode === 'rec' ? stopRec() : R.mode ? null : startRec());
  $('#recPlay').onclick = () => (R.mode === 'listen' ? stopAll() : R.mode ? null : startListen());
  const edit = async (fn) => { const n = R.song.rec.notes[R.sel]; if (!n) return; fn(n); await saveSong(); refresh(); draw(); };
  $('#recUp').onclick = () => edit((n) => { n.m += 1; if (mv || getCtx()) Voice.blip(getCtx(), n.m, 0.25, 0.3); });
  $('#recDown').onclick = () => edit((n) => { n.m -= 1; Voice.blip(getCtx(), n.m, 0.25, 0.3); });
  $('#recDel').onclick = async () => { if (R.sel < 0) return; R.song.rec.notes.splice(R.sel, 1); R.sel = -1; if (R.song.rec.notes.length) await saveSong(); refresh(); draw(); };
  $('#recDesel').onclick = () => { R.sel = -1; refresh(); draw(); };
  $('#recMidi').onclick = async () => {
    const blob = midiFile(R.song), name = `${R.song.title || 'melody'}.mid`;
    const file = new File([blob], name, { type: 'audio/midi' });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    toast('MIDI 파일을 저장했어요 (다운로드 폴더)', 3000);
  };
  $('#recDone').onclick = async () => { if (R.mode || !R.song.rec.notes.length) return; await saveSong(); leave(); onDone(R.song); };
  function leave() { if (R.mode) { stopOrig(); if (sp) { sp.onaudioprocess = null; sp.disconnect(); sp = null; } R.mode = null; } if (mv) mv.off(); if (mic) { mic.stop(); mic = null; } cancelAnimationFrame(R.raf); }
  window.addEventListener('resize', () => { if (R.song && document.querySelector('#rec.active')) draw(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && R.mode) stopAll(); });
  // 테스트용
  window.__rec = () => R;
  return { openRec, leave, isBusy: () => !!R.mode };
}
