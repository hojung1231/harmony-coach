// 이 폰의 앱 저장소 (IndexedDB). 기존 앱과 이름이 달라 서로 섞이지 않음
const NAME = 'harmony-coach-v2', STORE = 'songs';
let dbp;
function open() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await open();
  return new Promise((res, rej) => { const t = d.transaction(STORE, mode); const q = fn(t.objectStore(STORE)); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}
export const all = () => tx('readonly', (s) => s.getAll());
export const put = (v) => tx('readwrite', (s) => s.put(v));
export const del = (id) => tx('readwrite', (s) => s.delete(id));
