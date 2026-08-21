/* 托托工具箱 · Service Worker v9
 * 缓存策略：
 *  - 预缓存：app 外壳（index.html / manifest / 图标 / nav-logo / 水印）
 *  - 页面导航：stale-while-revalidate（先返回缓存秒开，同时后台拉新版本更新缓存）
 *           ↑ 关键优化：从图标/快捷方式进入时直接走缓存，秒进
 *  - 第三方 CDN（jsdelivr/unpkg/esm.sh 锁版本）：cache-first
 *  - 同源静态：cache-first + 后台更新
 *  - /search / /visit / /weather / /lookup / /api 等 Functions：network-only（不缓存）
 *  - /imgly-data/ 模型分块：cache-first（大文件 + 几乎不变）+ 后台静默刷新
 *  - skipWaiting + clients.claim：新版本上线后下一次访问立即生效
 */
const VERSION = 'v9';
const SHELL_CACHE = 'app-shell-' + VERSION;
const RUNTIME_CACHE = 'runtime-' + VERSION;
const CDN_CACHE = 'cdn-' + VERSION;
const IMGLY_CACHE = 'imgly-' + VERSION;

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
const IMGLY_PATH_RE = /^\/imgly-data\//;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    // 预缓存外壳（个别失败也不影响整体）
    await Promise.all(APP_SHELL.map(u => c.add(u).catch(() => {})));
  })());
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

  // Functions API：不缓存、永远走网络
  if (API_PATH_RE.test(url.pathname)) return;

  // 页面导航：stale-while-revalidate（关键优化 → 快捷方式秒开）
  // 先返回缓存里的旧 index.html（如果有），同时后台拉新版更新缓存
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html') || await caches.match(req);
      const fetchPromise = fetch(req).then((net) => {
        if (net && net.ok) {
          const c = caches.open(RUNTIME_CACHE);
          c.then(cc => cc.put('./index.html', net.clone())).catch(() => {});
        }
        return net;
      }).catch(() => null);
      // 有缓存就立即返回（秒开），网络结果会更新到缓存供下次使用
      return cached || (await fetchPromise) || new Response('<h1>离线中</h1>', { status: 503, headers: { 'Content-Type': 'text/html' } });
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

  // imgly-data 模型分块：cache-first（首次拉取较慢，二次秒开）
  if (IMGLY_PATH_RE.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const fetchPromise = fetch(req).then((net) => {
        if (net && net.ok) {
          const c = caches.open(IMGLY_CACHE);
          c.then(cc => cc.put(req, net.clone())).catch(() => {});
        }
        return net;
      }).catch(() => null);
      return cached || (await fetchPromise) || Response.error();
    })());
    return;
  }

  // 同源静态：cache-first + 后台静默刷新
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const fetchPromise = fetch(req).then((net) => {
        if (net && net.ok) {
          const c = caches.open(RUNTIME_CACHE);
          c.then((cc) => cc.put(req, net.clone())).catch(() => {});
        }
        return net;
      }).catch(() => null);
      return cached || (await fetchPromise) || Response.error();
    })());
  }
});
