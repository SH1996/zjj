/* 竹间记 · Service Worker
   策略：页面与脚本都网络优先（改完立刻生效），断网才回落缓存；
   只管同源 GET，GitHub / AI 等 API 请求一律直连，绝不缓存。 */
var CACHE = 'bamboo-v15-14-1';
var SHELL = [
  './',
  './index.html',
  './lottery-data.js',
  './lottery.js',
  './jielong.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 装的时候绕开浏览器 HTTP 缓存，别把旧脚本装进新壳子
      return Promise.all(SHELL.map(function (u) {
        return fetch(new Request(u, { cache: 'reload' })).then(function (res) {
          if (res && res.ok) return c.put(u, res);
        }).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
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

  // 其余同源资源：也是网络优先（no-cache 只验证、变了才重下），断网用缓存
  e.respondWith(
    fetch(new Request(req, { cache: 'no-cache' })).then(function (res) {
      if (res && res.ok) {
        try {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        } catch (err) {}
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (r) {
        return r || new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});
