/* 托托工具箱 · Service Worker v22
 *
 * 目标：PWA 快捷方式「稳定可访问 + 自动更新 + 秒开」。
 *
 * v12 修复 standalone 打开崩溃（导航请求永远用 fetch(url,{redirect:'follow'}) 非 navigate 模式取资源）。
 * v14 采用最稳妥策略：导航 = 网络优先 + 缓存兜底 + 离线页兜底，全程 try/catch，绝不返回 Response.error()。
 * v16 加固 CDN / imgly 模型分块的缓存策略，避免把网络抖动产生的坏/不完整响应写进缓存。
 * v18 关键修复（根治 2026-08-24 三类回归）：
 *   ① 手机 PWA「选择/添加文件按钮无反应、按钮变淡」——根因是弱网下导航回退到【旧缓存壳】（旧版 opacity 覆盖层），
 *      现改为：导航永远优先取【最新 HTML】，仅当完全离线才回退缓存壳 / 离线页；activate 删除全部旧缓存，杜绝旧壳。
 *   ② 在线 OCR「进度一直不动」——根因是 SW 对跨域 CDN（jsdelivr 等）做了 cache-first，弱网命中后缓存了不完整/
 *      挂起的响应，或直接返回 Response.error() 导致 Tesseract core/worker 永久卡死。现改为：跨域 CDN **纯网络透传、
 *      不缓存、绝不返回 Response.error()**，把控制权完全交还浏览器原生 fetch（OCR 自身另有超时与多源兜底）。
 *   ③ 证件照换背景「卡在 91%」——同②的跨域缓存干扰；且本版主站 /imgly-data/ 已验证完整，改为前端优先用同源数据，
 *      SW 对 /imgly-data/ 同样纯透传不缓存。
 *
 * 原则：跨域资源（CDN / imgly 官方 / 本站 imgly 数据）一律纯透传，SW 不参与缓存，避免任何坏缓存；
 *      仅同源静态外壳走 cache-first 加速；任何分支失败都返回合法 Response，绝不把 Response.error() 交给 event.respondWith。
 * v19 关键变更（2026-08-24-g）：① 新增 Web Share Target——拦截 POST /_share，把分享进来的文件存入 IndexedDB 后 303 回首页，
 *      页面读取后注入目标工具，彻底解决 standalone PWA 下「选择 / 添加文件按钮无反应」；② 删除 imgly 模型路由（证件照换背景已下架）。
 *
 * v23 清理（2026-09-04）：升版强制失效并删除所有旧缓存（app-shell-v22 / runtime-v22 等历史缓存壳），
 *      同时给同源 runtime 缓存加上限清理，避免长期累积旧文件占用空间。
 *      导航策略、跨域 CDN 纯透传等核心逻辑保持不变。
 *
 * activate 阶段自动删除所有「不含当前 VERSION」的旧缓存 → 旧缓存（含坏缓存壳）被自动清理。
 */
const VERSION = 'v23';
const SHELL_CACHE = 'app-shell-' + VERSION;
const RUNTIME_CACHE = 'runtime-' + VERSION;
const RUNTIME_MAX = 60; // 同源 runtime 缓存条目上限，超出按最旧淘汰

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

const API_PATH_RE = /^\/(search|visit|weather|lookup|api)(\/|$|\?)/;

// 导航请求：永远优先取【最新 HTML】。仅当完全离线（网络与缓存都失败）才回退离线页。
// 绝不返回旧缓存壳（旧壳可能含坏 JS / opacity 覆盖层导致「按钮变淡、无反应」）。
async function safeNavigate(url) {
  const cacheKey = './index.html';
  // 1) 网络优先（强制取最新 index.html）
  try {
    const net = await fetch(url.href, { redirect: 'follow', credentials: 'same-origin', cache: 'no-cache' });
    if (net && net.ok) {
      const copy = net.clone();
      caches.open(RUNTIME_CACHE).then((cc) => cc.put(cacheKey, copy)).catch(() => {});
      return net;            // 返回最新页
    }
  } catch (_) { /* 网络失败，走下方缓存兜底 */ }

  // 2) 缓存兜底（仅用于完全离线的合法回退，缓存内容为本版本外壳，无坏 JS）
  try {
    const cached =
      (await caches.match(cacheKey, { cacheName: RUNTIME_CACHE })) ||
      (await caches.match(cacheKey, { cacheName: SHELL_CACHE })) ||
      (await caches.match('./'));
    if (cached) return cached;
  } catch (_) { /* 缓存读取失败，走离线页 */ }

  // 3) 离线页兜底（永远合法 503 HTML，绝不 Response.error()）
  return offlineResponse();
}

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

// Web Share Target：把分享进来的文件存入 IndexedDB（含二进制），随后 303 重定向回首页
// 页面加载时读取该记录，弹出「选择要使用的工具」面板，把文件注入对应工具。
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pt-share', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function handleShare(req) {
  let target = './?shared=1';
  try {
    const fd = await req.formData();
    const files = [];
    const raw = fd.getAll('file');
    for (const f of raw) {
      if (f && typeof f === 'object' && 'arrayBuffer' in f) {
        files.push({ name: f.name || 'file', type: f.type || '', size: f.size || 0, buf: Array.from(new Uint8Array(await f.arrayBuffer())) });
      }
    }
    const value = {
      ts: Date.now(),
      title: fd.get('title') || '',
      text: fd.get('text') || '',
      url: fd.get('url') || '',
      files
    };
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, 'pendingShare');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) { /* 存储失败也不阻塞重定向 */ }
  return Response.redirect(target, 303);
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await Promise.all(APP_SHELL.map((u) => c.add(u).catch(() => {})));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // 删除所有不含当前 VERSION 的旧缓存（含 v22 及更早的坏缓存壳 / 跨域坏缓存）
    await Promise.all(
      keys.filter((k) => !k.includes(VERSION)).map((k) => caches.delete(k))
    );
    // 同源 runtime 缓存条目上限清理：超出则淘汰最早写入的条目，避免长期累积占用空间
    try {
      const rc = await caches.open(RUNTIME_CACHE);
      const reqs = await rc.keys();
      if (reqs.length > RUNTIME_MAX) {
        await Promise.all(reqs.slice(0, reqs.length - RUNTIME_MAX).map((r) => rc.delete(r)));
      }
    } catch (_) { /* 清理失败不影响主流程 */ }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Web Share Target：分享进来的文件存入 IndexedDB 后 303 回首页（页面读取后注入目标工具）
  if (req.method === 'POST' && url.pathname.endsWith('/_share')) {
    event.respondWith(handleShare(req));
    return;
  }

  // 其余非 GET（如 Functions 之外的 POST）走浏览器原生处理
  if (req.method !== 'GET') return;

  // Functions API：不缓存、永远走网络
  if (API_PATH_RE.test(url.pathname)) return;

  // 页面导航：网络优先 + 缓存兜底 + 离线页兜底（最稳妥，杜绝「网站无法访问」）
  if (req.mode === 'navigate') {
    event.respondWith(safeNavigate(url));
    return;
  }

  // 跨域 CDN（jsdelivr / unpkg / esm.sh）：【纯网络透传，不缓存，绝不返回 Response.error()】。
  // v17 曾对这里 cache-first，弱网把挂起/不完整的 tesseract core、worker、库脚本缓存成坏响应，
  // 或直接返回 Response.error()，导致 OCR「进度一直不动」、各类 CDN 工具偶发失败。
  // 现改为完全透传，交还浏览器原生 fetch（OCR 自身另有多源 + 超时兜底）。
  if (['cdn.jsdelivr.net', 'unpkg.com', 'esm.sh'].includes(url.hostname)) {
    event.respondWith(fetch(req));
    return;
  }

  // 同源静态：cache-first + 后台静默刷新（仅用于外壳加速；失败回退缓存或原生错误，不主动制造坏响应）
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
