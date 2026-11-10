// 앱 업데이트 확인 / 적용
export const APP_VERSION = '2.6.1';

const ASSETS = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/pitch.js', 'js/db.js', 'js/update.js',
  'songs/sooknyeo.json', 'manifest.webmanifest', 'sw.js'];

const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

/** 서버의 최신 버전 확인. 반환: 새 버전 문자열 또는 null */
export async function checkUpdate() {
  const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('서버에 연결할 수 없어요');
  const { version } = await r.json();
  return newer(version, APP_VERSION) ? version : null;
}

/** 캐시를 모두 지우고 최신 파일을 받아 다시 시작 (저장한 노래는 그대로 유지) */
export async function applyUpdate() {
  if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  await Promise.all(ASSETS.map((a) => fetch(a, { cache: 'reload' }).catch(() => {})));
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.unregister();
  }
  location.reload();
}
