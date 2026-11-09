// 오프라인 캐시 (네트워크 우선, 실패 시 캐시)
const CACHE = 'harmony-coach-2.4.3';
const ASSETS = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/pitch.js', 'js/db.js', 'js/update.js',
  'songs/sooknyeo.json', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  // 안드로이드 '공유하기' → 화음 코치 로 받은 음악 파일
  if (e.request.method === 'POST' && u.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const cache = await caches.open('hc-shared');
        let i = 0;
        for (const f of fd.getAll('audio')) {
          if (!f || !f.size) continue;
          const name = encodeURIComponent(f.name || `공유된 노래 ${++i}.mp3`);
          await cache.put(new Request(`./shared/${Date.now()}-${i++}/${name}`), new Response(f, { headers: { 'Content-Type': f.type || 'audio/mpeg' } }));
        }
      } catch (err) { /* 무시하고 앱으로 이동 */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.endsWith('version.json')) return;
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
