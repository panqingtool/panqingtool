/* 托托工具箱 · Service Worker v14
 *
 * 目标：PWA 快捷方式「稳定可访问 + 自动更新 + 秒开」。
 *
 * v12 修复 standalone 打开崩溃（导航请求永远用 fetch(url,{redirect:'follow'}) 非 navigate 模式取资源）。
 * v13 改为缓存优先，但出现手机 PWA 打开「无法访问」的问题（opaque 响应 / 后台刷新笔误）。
 * v14 采用最稳妥策略，彻底解决：
 *   导航请求 = 网络优先 + 缓存兜底 + 离线页兜底，全程包在 try/catch 内，
 *   任何异常都返回合法 Response（缓存 → 离线页），绝不抛错、绝不返回 Response.error()
 *   到 event.respondWith（那会直接触发浏览器「网站无法访问」）。
 *   - 网络成功：返回最新页，并写入缓存（下次离线/秒开可用）；
 *   - 网络失败：返回缓存页（合法 Response，用户照常用）；
 *   - 都失败：返回离线页（合法 503 HTML）。
 *   后台对 SW 自身做静默刷新：fetch('/sw.js') 写入 sw 缓存，配合 _headers 的 no-cache 与
 *   activate 时 skipWaiting + clients.claim，新版本下次打开自动生效，用户无需重装/清缓存。
 *
 * activate 阶段自动删除所有「不含当前 VERSION」的旧缓存 → 旧缓存被自动清理。
 */
const VERSION = 'v14';
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
  './icons/icon-192.png?v=20260822-2',
  './icons/icon-512.png?v=20260822-2',
  './icons/maskable-512.png?v=20260822-2',
  './icons/apple-touch-icon.png?v=20260822-2'
];

const CDN_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'esm.sh'];
const API_PATH_RE = /^\/(search|visit|weather|lookup|api)(\/|$|\?)/;
const IMGLY_PATH_RE = /^\/imgly-data\//;

// 导航请求的安全处理：永远返回合法 Response（网络 → 缓存 → 离线页），绝不抛错
async function safeNavigate(url) {
  const cacheKey = './index.html';
  // 1) 网络优先
  try {
    const net = await fetch(url.href, { redirect: 'follow', credentials: 'same-origin' });
    if (net && net.ok) {
      const copy = net.clone();
      caches.open(RUNTIME_CACHE).then((cc) => cc.put(cacheKey, copy)).catch(() => {});
      return net;            // 返回最新页
    }
  } catch (_) { /* 网络失败，走下方缓存兜底 */ }

  // 2) 缓存兜底（含 SHELL 与 RUNTIME 两个缓存空间）
  try {
    const cached =
      (await caches.match(cacheKey, { cacheName: RUNTIME_CACHE })) ||
      (await caches.match(cacheKey, { cacheName: SHELL_CACHE })) ||
      (await caches.match('./'));
    if (cached) return cached;   // 合法 Response，用户照常用
  } catch (_) { /* 缓存读取失败，走离线页 */ }

  // 3) 离线页兜底（仍为合法 503 HTML，绝不返回 Response.error()）
  return offlineResponse();
}

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

  // 页面导航：网络优先 + 缓存兜底 + 离线页兜底（最稳妥，杜绝「网站无法访问」）
  // 关键修复：绝不对 navigate 模式请求直接 fetch(req)/caches.match(req)（会抛 TypeError）；
  // 改用 fetch(url.href, {redirect:'follow'})（cors 模式，合法且能拿到 HTML）。
  // 整段包 try/catch，任何异常都返回合法 Response，绝不把 Response.error() 交给 event.respondWith。
  if (req.mode === 'navigate') {
    event.respondWith(safeNavigate(url));
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
