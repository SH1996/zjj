/* 竹间记 · Service Worker
   策略：页面网络优先（保证更新），静态资源缓存优先；只管同源 GET，
   GitHub / AI 等 API 请求一律直连，绝不缓存。 */
var CACHE = 'bamboo-v13-7';
var SHELL = [
  './',
  './index.html',
  './lottery-data.js',
  './lottery.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API 与跨域：直连

  var isPage = req.mode === 'navigate' ||
               url.pathname === '/' ||
               url.pathname.endsWith('/index.html') ||
               (url.pathname.endsWith('/') && url.pathname.length > 1);

  if (isPage) {
    // 页面：网络优先，离线回落缓存
    e.respondWith(
      fetch(req).then(function (res) {
        try {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        } catch (err) {}
        return res;
      }).catch(function () {
        return caches.match(req).then(function (r) {
          return r || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // 静态资源：缓存优先
  e.respondWith(
    caches.match(req).then(function (r) {
      if (r) return r;
      return fetch(req).then(function (res) {
        try {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        } catch (err) {}
        return res;
      });
    })
  );
});
