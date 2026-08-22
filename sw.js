/* 托托工具箱 · Service Worker v11
 * 缓存策略：
 *  - 预缓存：app 外壳（index.html / manifest / 图标 / nav-logo / 水印）
 *  - 页面导航：stale-while-revalidate（先返回缓存秒开，同时后台拉新版本更新缓存）
 *           ↑ 关键优化：从图标/快捷方式进入时直接走缓存，秒进
 *  - 第三方 CDN（jsdelivr/unpkg/esm.sh 锁版本）：cache-first
 *  - 同源静态：cache-first + 后台更新
 *  - /search / /visit / /weather / /lookup / /api 等 Functions：network-only（不缓存）
 *  - /imgly-data/ 模型分块：cache-first（大文件 + 几乎不变）+ 后台静默刷新
 *  - skipWaiting + clients.claim：新版本上线后下一次访问立即生效
 *
 * 更新机制（无需用户手动清缓存）：
 *  改代码 → 改本文件顶部 VERSION → 推 GitHub → Cloudflare Pages 自动部署 →
 *  浏览器检测到 sw.js 变化，下载新 SW 并执行 skipWaiting 立即激活，
 *  activate 事件删除所有旧版本缓存，用户无需手动清缓存。
 */
const VERSION = 'v11';
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

/* 安全 fetch：修复重定向崩溃
 * 部分浏览器对导航请求以 manual 模式拦截，遇 Cloudflare Pages 的 308 重定向
 * 会返回 opaqueredirect 响应，直接 event.respondWith 会触发 ERR_FAILED。
 * 这里检测：若请求 redirect 模式不是 follow，则用显式 follow 模式重建请求重取，
 * 绝不以 opaqueredirect 响应交给 respondWith。
 */
async function safeFetch(req) {
  if (req.redirect === 'follow') {
    return fetch(req);
  }
  const safeReq = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    redirect: 'follow',
    credentials: req.credentials,
    cache: req.cache,
    integrity: (req.integrity || '') || undefined
    // 不指定 mode（避免 navigate 模式抛 TypeError）；同源文档请求用默认 cors 模式无误
  });
  return fetch(safeReq);
}

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
  // 全程 try/catch：任何异常都保证返回一个合法 Response，绝不抛出导致
  // 「网站暂时无法访问 / 空白页」（尤其从主屏快捷方式打开的 standalone 窗口）。
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const cached = await caches.match('./index.html') || await caches.match(req);
        const fetchPromise = safeFetch(req).then((net) => {
          if (net && net.ok) {
            caches.open(RUNTIME_CACHE).then(cc => cc.put('./index.html', net.clone())).catch(() => {});
          }
          return net;
        }).catch(() => null);
        const net = await fetchPromise;
        // 缓存秒开优先
        if (cached) return cached;
        // 网络成功直接返回（含 4xx/5xx 交给浏览器处理，避免空白）
        if (net) return net;
        // 兜底 1：再尝试一次直接网络
        try { const f2 = await safeFetch(req); if (f2) return f2; } catch (_) {}
        // 兜底 2：外壳缓存
        const shell = await caches.match('./index.html');
        if (shell) return shell;
        return new Response('<!doctype html><meta charset="utf-8"><h1>离线 / 网络异常</h1><p>请检查网络后下拉刷新，或重新从主屏幕打开本工具箱。</p>', { status: 503, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
      } catch (err) {
        // 任何未预期异常：尽量返回网络，再兜底缓存，最后 503
        try { const f = await safeFetch(req); if (f) return f; } catch (_) {}
        try { const shell = await caches.match('./index.html'); if (shell) return shell; } catch (_) {}
        return new Response('<!doctype html><meta charset="utf-8"><h1>离线 / 网络异常</h1><p>请检查网络后下拉刷新，或重新从主屏幕打开本工具箱。</p>', { status: 503, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
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
        const net = await safeFetch(req);
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
      const fetchPromise = safeFetch(req).then((net) => {
        if (net && net.ok) {
          caches.open(IMGLY_CACHE).then(cc => cc.put(req, net.clone())).catch(() => {});
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
      const fetchPromise = safeFetch(req).then((net) => {
        if (net && net.ok) {
          caches.open(RUNTIME_CACHE).then((cc) => cc.put(req, net.clone())).catch(() => {});
        }
        return net;
      }).catch(() => null);
      return cached || (await fetchPromise) || Response.error();
    })());
  }
});
