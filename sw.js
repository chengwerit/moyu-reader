/* 墨语 · Service Worker
   ---------------------------------------------------------------------------
   依赖库已本地化到 lib/，因此离线完全可用，无需缓存任何 CDN 资源。

   注意：这里只缓存「应用壳层」这类静态文件，绝不碰 /api/ 数据接口——
   一旦把书籍数据缓进 Cache Storage，用户会读到过期内容，且难以排查。
*/

const CACHE = 'moyu-v2';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/engine.js',
  './js/parsers.js',
  './js/ai.js',
  './lib/jszip.min.js',
  './lib/marked.min.js',
  './lib/pdf.min.js',
  './lib/pdf.worker.min.js',
  './manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 数据接口一律直连服务器，绝不走缓存
  if (url.pathname.startsWith('/api/')) return;

  // 静态资源：网络优先，断网时回落缓存
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});