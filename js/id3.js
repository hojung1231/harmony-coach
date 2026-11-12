// MP3 파일 안의 정보(ID3v2 태그) 읽기: 제목·가수·가사·표지
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
export async function readTags(file) {
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
    else if (id === 'APIC' && !out.coverBlob) {
      const r = body.subarray(1); const mEnd = r.indexOf(0); const mime = decodeText(r.subarray(0, mEnd), 0) || 'image/jpeg';
      const [, img] = splitNul(r.subarray(mEnd + 2), enc);
      if (img.length > 100) out.coverBlob = new Blob([img], { type: mime.includes('/') ? mime : 'image/' + mime.toLowerCase() });
    }
  }
  return out;
}

