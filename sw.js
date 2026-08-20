/* 万能免费在线工具箱 · Service Worker
 * 缓存策略：
 *  - 安装时预缓存应用外壳（index.html / manifest / 图标）
 *  - 页面导航：network-first，失败回退缓存（离线可用 + 随时拿到更新）
 *  - 第三方 CDN 库（jsdelivr/unpkg/esm.sh，均为锁定版本）：cache-first（安全且离线可用）
 *  - 同源静态资源：cache-first + 后台更新
 *  - /search 等 Functions 接口：直接走网络，不缓存
 *  - skipWaiting + clients.claim：新版本发布后下一次访问即生效，并提示用户刷新
 */
const VERSION = 'v7';
const SHELL_CACHE = 'app-shell-' + VERSION;
const RUNTIME_CACHE = 'runtime-' + VERSION;
const CDN_CACHE = 'cdn-' + VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png'
];

const CDN_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'esm.sh'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(APP_SHELL)).catch(() => {})
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

  // Functions 接口：不缓存，直接网络
  if (url.pathname.startsWith('/search') || url.pathname.startsWith('/api/')) {
    return;
  }

  // 页面导航：network-first，失败用缓存
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

  // 第三方 CDN：cache-first（版本已锁定，不会变）
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
      if (cached) return cached;
      try {
        const net = await fetch(req);
        const c = await caches.open(RUNTIME_CACHE);
        c.put(req, net.clone());
        return net;
      } catch (_) {
        return cached || Response.error();
      }
    })());
  }
});
