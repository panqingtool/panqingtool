/* 万能免费在线工具箱 · 联网搜索代理（Cloudflare Pages Functions）
 *
 * 作用：前端只调用同源接口 /search，由本函数在服务端去请求第三方搜索 API。
 * 好处：① 避免浏览器直连第三方导致的 CORS 报错；② API 密钥留在服务端（env），绝不进前端；
 *       ③ 所有外网请求都由 Cloudflare 边缘节点发出，不受用户本地网络（如国内 GFW）影响。
 *
 * 前端调用示例：
 *   const r = await fetch('/search?q=' + encodeURIComponent('Cloudflare Pages 教程'));
 *   const list = await r.json();  // [{ title, url, snippet }, ...]
 *
 * 在 Cloudflare Pages 控制台 → Settings → Environment variables 里添加（可选）：
 *   SEARCH_PROVIDER = brave            （可选：wikipedia / brave / google / duckduckgo；不填默认 wikipedia）
 *   BRAVE_API_KEY  = 你的 Brave Search API Key
 *   GOOGLE_API_KEY = 你的 Google API Key         （provider=google 时需要）
 *   GOOGLE_CX      = 你的 Custom Search Engine ID（provider=google 时需要）
 *
 * 说明：
 *   - 默认 wikipedia：服务端调用维基百科 API，CF 节点可达，国内浏览器无障碍，无需任何密钥，开箱即用。
 *   - duckduckgo 近期对自动化请求经常超时/返回空，仅作最后的兜底。
 */

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) {
    return json({ error: '缺少参数 q' }, 400);
  }

  // provider 优先级：请求参数 > 环境变量 > 默认 wikipedia
  const provider = (url.searchParams.get('provider') || env.SEARCH_PROVIDER || 'wikipedia').toLowerCase();
  const lang = (url.searchParams.get('lang') || env.SEARCH_LANG || 'zh').toLowerCase();
  const count = Math.min(parseInt(url.searchParams.get('count') || '10', 10) || 10, 20);

  try {
    let data = [];

    if (provider === 'brave') {
      if (!env.BRAVE_API_KEY) throw new Error('未配置 BRAVE_API_KEY（Pages 环境变量）');
      data = await braveSearch(q, env.BRAVE_API_KEY, count);
    } else if (provider === 'google') {
      if (!env.GOOGLE_API_KEY || !env.GOOGLE_CX) throw new Error('未配置 GOOGLE_API_KEY / GOOGLE_CX');
      data = await googleSearch(q, env.GOOGLE_API_KEY, env.GOOGLE_CX, count);
    } else if (provider === 'duckduckgo') {
      data = await ddgSearch(q, count);
    }

    // 默认 wikipedia，或上述 provider 返回空时回退到 wikipedia（服务端，最稳）
    if (!data || !data.length) {
      data = await wikipediaSearch(q, lang, count);
    }

    if (!data || !data.length) {
      return json({ error: '未找到相关结果，换个关键词试试。' }, 200);
    }
    return json(data, 200, { 'cache-control': 'public, max-age=300' });
  } catch (e) {
    // 任何异常都尽量用 wikipedia 兜底，仍失败才返回错误
    try {
      const fb = await wikipediaSearch(q, lang, count);
      if (fb && fb.length) return json(fb, 200, { 'cache-control': 'public, max-age=60' });
    } catch (_) {}
    return json({ error: String(e && e.message ? e.message : e) }, 502);
  }
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extraHeaders || {})
  });
}

async function wikipediaSearch(q, lang, count) {
  const api = 'https://' + lang + '.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
    encodeURIComponent(q) + '&format=json&srlimit=' + count + '&origin=*';
  const r = await fetch(api, { headers: { 'User-Agent': 'panqingtool/1.0 (search agent)' } });
  if (!r.ok) throw new Error('Wikipedia HTTP ' + r.status);
  const j = await r.json();
  const arr = (j && j.query && j.query.search) || [];
  return arr.map((it) => ({
    title: it.title,
    url: 'https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(it.title.replace(/ /g, '_')),
    snippet: (it.snippet || '').replace(/<[^>]+>/g, '')
  }));
}

async function braveSearch(q, key, count) {
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
