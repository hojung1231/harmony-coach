// IndexedDB 저장소 (곡, 분석 결과, 연습 기록)
const DB = 'harmony-coach', STORE = 'songs';
let dbp;
function open() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}
export const getAll = () => tx('readonly', (s) => s.getAll());
export const get = (id) => tx('readonly', (s) => s.get(id));
export const put = (song) => tx('readwrite', (s) => s.put(song));
export const del = (id) => tx('readwrite', (s) => s.delete(id));
