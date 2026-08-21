/* 万能免费在线工具箱 · Service Worker v8
 * 缓存策略：
 *  - 预缓存：app 外壳（index.html / manifest / 图标 / nav-logo / 水印 / shortcuts 用图）
 *  - 页面导航：network-first（保证拿到新版本），失败回退缓存
 *  - 第三方 CDN（jsdelivr/unpkg/esm.sh 锁版本）：cache-first
 *  - 同源静态：cache-first + 后台刷新
 *  - /search / /visit / /weather / /lookup 等 Functions：network-only（不缓存）
 *  - skipWaiting + clients.claim：新版本上线后下一次访问立即生效
 */
const VERSION = 'v8';
const SHELL_CACHE = 'app-shell-' + VERSION;
const RUNTIME_CACHE = 'runtime-' + VERSION;
const CDN_CACHE = 'cdn-' + VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './nav-logo.png',
  './bg-watermark.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png'
];

const CDN_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'esm.sh'];
const API_PATH_RE = /^\/(search|visit|weather|lookup|api)(\/|$|\?)/;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(APP_SHELL).catch(() => {})).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => !k.includes(VERSION)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Functions API：不缓存、永远走网络（避免返回过期访问量/搜索结果）
  if (API_PATH_RE.test(url.pathname)) return;

  // 页面导航：network-first + 缓存兜底（拿到新版本后才使用新 SW）
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        const c = await caches.open(RUNTIME_CACHE);
        c.put(req, net.clone());
        return net;
      } catch (_) {
        return (
          (await caches.match(req)) ||
          (await caches.match('./index.html')) ||
          (await caches.match('./'))
        );
      }
    })());
    return;
  }

  // 第三方 CDN：cache-first
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const net = await fetch(req);
        const c = await caches.open(CDN_CACHE);
        c.put(req, net.clone());
        return net;
      } catch (_) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // 同源静态：cache-first + 后台更新
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const fetchPromise = fetch(req).then((net) => {
        const c = caches.open(RUNTIME_CACHE);
        c.then((cc) => cc.put(req, net.clone())).catch(() => {});
        return net;
      }).catch(() => null);
      return cached || (await fetchPromise) || Response.error();
    })());
  }
});
