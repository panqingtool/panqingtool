/* 万能免费在线工具箱 · 联网搜索代理（Cloudflare Pages Functions）
 *
 * 作用：前端只调用同源接口 /search，由本函数在服务端去请求第三方搜索 API。
 * 好处：① 避免浏览器直连第三方导致的 CORS 报错；② API 密钥留在服务端（env），绝不进前端。
 *
 * 前端调用示例：
 *   const r = await fetch('/search?q=' + encodeURIComponent('Cloudflare Pages 教程'));
 *   const list = await r.json();  // [{ title, url, snippet }, ...]
 *
 * 在 Cloudflare Pages 控制台 → Settings → Environment variables 里添加：
 *   SEARCH_PROVIDER = brave            （可选：brave / google / duckduckgo）
 *   BRAVE_API_KEY   = 你的 Brave Search API Key
 *   GOOGLE_API_KEY  = 你的 Google API Key        （provider=google 时需要）
 *   GOOGLE_CX       = 你的 Custom Search Engine ID（provider=google 时需要）
 * 说明：DuckDuckGo 走 HTML 接口、无需密钥，但稳定性一般，仅作兜底。
 */

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) {
    return json({ error: '缺少参数 q' }, 400);
  }

  const provider = (env.SEARCH_PROVIDER || 'duckduckgo').toLowerCase();
  const count = Math.min(parseInt(url.searchParams.get('count') || '10', 10) || 10, 20);

  try {
    let data;
    if (provider === 'brave') {
      data = await braveSearch(q, env.BRAVE_API_KEY, count);
    } else if (provider === 'google') {
      data = await googleSearch(q, env.GOOGLE_API_KEY, env.GOOGLE_CX, count);
    } else if (provider === 'duckduckgo') {
      data = await ddgSearch(q, count);
    } else {
      return json({ error: '未知的 SEARCH_PROVIDER：' + provider }, 400);
    }
    return json(data, 200, { 'cache-control': 'public, max-age=300' });
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 502);
  }
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extraHeaders || {})
  });
}

async function braveSearch(q, key, count) {
  if (!key) throw new Error('未配置 BRAVE_API_KEY（Pages 环境变量）');
  const u = 'https://api.search.brave.com/res/v1/web/search?q=' +
    encodeURIComponent(q) + '&count=' + count;
  const r = await fetch(u, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key }
  });
  const j = await r.json();
  const items = (j && j.web && j.web.results) || [];
  return items.map((x) => ({ title: x.title, url: x.url, snippet: x.description || '' }));
}

async function googleSearch(q, key, cx, count) {
  if (!key || !cx) throw new Error('未配置 GOOGLE_API_KEY / GOOGLE_CX');
  const u = 'https://www.googleapis.com/customsearch/v1?q=' +
    encodeURIComponent(q) + '&key=' + key + '&cx=' + cx + '&num=' + count;
  const r = await fetch(u);
  const j = await r.json();
  const items = j.items || [];
  return items.map((x) => ({ title: x.title, url: x.link, snippet: x.snippet || '' }));
}

async function ddgSearch(q, count) {
  const u = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await r.text();
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)</g;
  const out = [];
  let m;
  while ((m = re.exec(html)) && out.length < count) {
    const href = m[1].replace(/^\/l\/\?uddg=/, '');
    out.push({ title: m[2].trim(), url: decodeURIComponent(href), snippet: '' });
  }
  return out;
}
