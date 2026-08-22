/* 托托工具箱 · Service Worker v12
 *
 * 修复：从主屏快捷方式（standalone）打开时显示「网站暂时无法访问」。
 * 根因：导航请求 req.mode === 'navigate'，直接 fetch(req) 或 caches.match(req)
 *      会抛 TypeError（Cannot construct a Request with mode 'navigate'），
 *      导致 event.respondWith 收到非法响应 / SW 无法正确响应，浏览器报无法访问。
 * v12 改为：对导航请求始终用「非 navigate 模式」的新请求（fetch(url, {redirect:'follow'})）
 * 重新取资源；导航分支永远返回合法 Response（网络 → 缓存 → 离线页），绝不抛错。
 *
 * 缓存策略：
 *  - 预缓存：app 外壳（index.html / manifest / 图标 / nav-logo / 水印）
 *  - 页面导航：网络优先 + 缓存兜底 + 离线页
 *  - 第三方 CDN（jsdelivr/unpkg/esm.sh 锁版本）：cache-first
 *  - 同源静态：cache-first + 后台静默刷新
 *  - /imgly-data/ 模型分块：cache-first（大文件 + 几乎不变）+ 后台静默刷新
 *  - /search / /visit / /weather / /lookup / /api 等 Functions：network-only（不缓存）
 *  - skipWaiting + clients.claim：新版本上线后下一次访问立即生效，无需手动清缓存
 */
const VERSION = 'v12';
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

// 离线兜底页（永远返回合法 HTML，绝不抛错 / Response.error）
const OFFLINE_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>托托工具箱 · 离线</title></head><body style="font-family:system-ui,' +
  'sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;' +
  'margin:0;background:#f5f7fa;color:#333;text-align:center;padding:24px">' +
  '<div><h2 style="color:#1890ff">当前处于离线 / 网络异常</h2>' +
  '<p style="max-width:320px;line-height:1.7">请检查网络后重新打开本工具箱；' +
  '若已安装，可直接从主屏幕图标再次进入。</p></div></body></html>';

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: { 'Content-Type': 'text/html;charset=utf-8' }
  });
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    // 预缓存外壳（个别失败也不影响整体）
    await Promise.all(APP_SHELL.map((u) => c.add(u).catch(() => {})));
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

  // 页面导航：网络优先 + 缓存兜底 + 离线页
  // 关键修复：绝不对 navigate 模式请求直接 fetch(req) / caches.match(req)，
  // 改用 fetch(url, {redirect:'follow'})（默认 cors 模式，合法且能拿到 HTML）。
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const net = await fetch(url.href, { redirect: 'follow', credentials: 'same-origin' });
        if (net && net.ok) {
          const copy = net.clone();
          caches.open(RUNTIME_CACHE).then((cc) => cc.put('./index.html', copy)).catch(() => {});
        }
        if (net) return net;
      } catch (_) {
        /* 网络失败，走下方缓存兜底 */
      }
      // 兜底 1：缓存的外壳（根路径与 index.html 都尝试）
      try {
        const cached = (await caches.match('./index.html')) || (await caches.match('./'));
        if (cached) return cached;
      } catch (_) {}
      // 兜底 2：离线页
      return offlineResponse();
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
      if (cached) return cached;
      try {
        const net = await fetch(req);
        if (net && net.ok) {
          const c = await caches.open(IMGLY_CACHE);
          c.put(req, net.clone()).catch(() => {});
        }
        return net;
      } catch (_) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // 同源静态：cache-first + 后台静默刷新
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const net = await fetch(req);
        if (net && net.ok) {
          const c = await caches.open(RUNTIME_CACHE);
          c.put(req, net.clone()).catch(() => {});
        }
        return net;
      } catch (_) {
        return cached || Response.error();
      }
    })());
  }
});
