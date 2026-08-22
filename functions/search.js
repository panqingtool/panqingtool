/* 联网搜索代理（Cloudflare Pages Functions）
 *
 * 路由：
 *   GET /search?q=xxx[&count=10][&provider=auto|brave|google|duckduckgo|wikipedia|bing]
 *
 * 行为：
 *   - 默认 provider=auto：依次尝试 brave → google → wikipedia，命中即返回。
 *   - wikipedia 走服务端 API（zh.wikipedia.org / en.wikipedia.org），CF 边缘节点请求，国内访问不受影响。
 *   - 全部失败时返回兜底（502 + 错误信息），前端展示明确提示。
 *
 * 环境变量（在 Cloudflare Pages 控制台 Settings → Environment variables）：
 *   SEARCH_PROVIDER  = brave / google / duckduckgo / wikipedia（可选；缺省为 auto）
 *   BRAVE_API_KEY    = Brave Search API Key
 *   GOOGLE_API_KEY   = Google API Key
 *   GOOGLE_CX        = Google CSE ID
 *   BING_API_KEY     = Bing Web Search API Key
 */

const UA = 'Mozilla/5.0 (compatible; PanQingToolbox/1.0; +https://panqingtool.pages.dev)';

// 规整搜索结果链接：解码双重编码、补齐协议、去除追踪尾参（rut / uddg），保证可打开
function cleanUrl(raw) {
  if (!raw) return '';
  let u = String(raw).trim();
  // 去掉 DuckDuckGo 中转页的 rut 等尾参
  u = u.replace(/[?&]rut=[^&]+/i, '').replace(/[?&]ia=[^&]+/i, '');
  // 处理 DuckDuckGo 中转：uddg=ENCODED_URL（可能双重编码）
  const m = u.match(/[?&]uddg=([^&]+)/i);
  if (m) {
    try { u = decodeURIComponent(m[1]); } catch (_) {}
  }
  // 反复解码直到稳定（处理 %25 等二次编码）
  let prev;
  let guard = 0;
  do {
    prev = u;
    try { u = decodeURIComponent(u); } catch (_) { break; }
  } while (u !== prev && ++guard < 5);
  u = u.trim();
  if (/^\/\//.test(u)) u = 'https:' + u;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) u = 'https://' + u;
  // 最终校验：必须是合法 http(s) URL，否则回退空
  if (!/^https?:\/\//i.test(u)) return '';
  return u;
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign(
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=120' },
      extraHeaders || {}
    )
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ ok: false, error: '缺少参数 q' }, 400);
  const wantProvider = (url.searchParams.get('provider') || env.SEARCH_PROVIDER || 'auto').toLowerCase();
  const count = Math.min(parseInt(url.searchParams.get('count') || '10', 10) || 10, 20);

  // auto：依次尝试各 provider，第一个成功的就返回
  if (wantProvider === 'auto') {
    const chain = ['brave', 'google', 'wikipedia', 'duckduckgo', 'bing'];
    const tried = [];
    for (const p of chain) {
      try {
        const r = await run(p, q, count, env);
        r.provider = p + (p === 'wikipedia' ? '(zh)' : '');
        return json(r, 200);
      } catch (e) {
        tried.push({ provider: p, error: String(e && e.message ? e.message : e) });
      }
    }
    return json({ ok: false, error: '所有搜索引擎暂不可用', tried }, 502);
  }
  try {
    const r = await run(wantProvider, q, count, env);
    r.provider = wantProvider;
    return json(r, 200);
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e), provider: wantProvider }, 502);
  }
}

async function run(provider, q, count, env) {
  if (provider === 'brave')          return await braveSearch(q, env.BRAVE_API_KEY, count);
  if (provider === 'google')         return await googleSearch(q, env.GOOGLE_API_KEY, env.GOOGLE_CX, count);
  if (provider === 'bing')           return await bingSearch(q, env.BING_API_KEY, count);
  if (provider === 'duckduckgo')     return await ddgSearch(q, count);
  if (provider === 'wikipedia')      return await wikiSearch(q, count, 'zh');
  throw new Error('未知的 provider: ' + provider);
}

/* ---------- brave ---------- */
async function braveSearch(q, key, count) {
  if (!key) throw new Error('未配置 BRAVE_API_KEY');
  const u = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q) + '&count=' + count;
  const r = await fetch(u, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } });
  if (!r.ok) throw new Error('brave http ' + r.status);
  const j = await r.json();
  const items = (j && j.web && j.web.results) || [];
  if (!items.length) throw new Error('brave 无结果');
  return { ok: true, query: q, results: items.slice(0, count).map((x) => ({ title: x.title, url: cleanUrl(x.url), snippet: x.description || '' })) };
}

/* ---------- google ---------- */
async function googleSearch(q, key, cx, count) {
  if (!key || !cx) throw new Error('未配置 GOOGLE_API_KEY / GOOGLE_CX');
  const u = 'https://www.googleapis.com/customsearch/v1?q=' + encodeURIComponent(q) + '&key=' + key + '&cx=' + cx + '&num=' + count;
  const r = await fetch(u);
  if (!r.ok) throw new Error('google http ' + r.status);
  const j = await r.json();
  const items = (j.items || []);
  if (!items.length) throw new Error('google 无结果');
  return { ok: true, query: q, results: items.slice(0, count).map((x) => ({ title: x.title, url: cleanUrl(x.link), snippet: x.snippet || '' })) };
}

/* ---------- bing ---------- */
async function bingSearch(q, key, count) {
  if (!key) throw new Error('未配置 BING_API_KEY');
  const u = 'https://api.bing.microsoft.com/v7.0/search?q=' + encodeURIComponent(q) + '&count=' + count;
  const r = await fetch(u, { headers: { 'Ocp-Apim-Subscription-Key': key } });
  if (!r.ok) throw new Error('bing http ' + r.status);
  const j = await r.json();
  const items = (j.webPages && j.webPages.value) || [];
  if (!items.length) throw new Error('bing 无结果');
  return { ok: true, query: q, results: items.slice(0, count).map((x) => ({ title: x.name, url: cleanUrl(x.url), snippet: x.snippet || '' })) };
}

/* ---------- wikipedia（服务端，免墙） ---------- */
async function wikiSearch(q, count, lang) {
  const endpoints = ['zh', 'en'];
  const errs = [];
  for (const l of endpoints) {
    try {
      const api = 'https://' + l + '.wikipedia.org/w/api.php?action=opensearch&limit=' + count + '&namespace=0&format=json&origin=*&search=' + encodeURIComponent(q);
      const r = await fetch(api, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) { errs.push(l + ':http ' + r.status); continue; }
      const j = await r.json();
      if (Array.isArray(j) && Array.isArray(j[1]) && j[1].length) {
        const titles = j[1], descs = j[2] || [], urls = j[3] || [];
        return {
          ok: true,
          query: q,
          results: titles.slice(0, count).map((t, i) => ({
            title: t,
            url: cleanUrl(urls[i] || ('https://' + l + '.wikipedia.org/wiki/' + encodeURIComponent(t))),
            snippet: (descs[i] || ('维基百科 · ' + l)).slice(0, 240)
          }))
        };
      }
      errs.push(l + ':空');
    } catch (e) {
      errs.push(l + ':' + String(e && e.message ? e.message : e));
    }
  }
  throw new Error('wikipedia 失败: ' + errs.join(','));
}

/* ---------- duckduckgo html（兜底） ---------- */
async function ddgSearch(q, count) {
  const u = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!r.ok) throw new Error('ddg http ' + r.status);
  const html = await r.text();
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const out = []; let m;
  while ((m = re.exec(html)) && out.length < count) {
    const url = cleanUrl(m[1]);
    const title = String(m[2] || '').replace(/<[^>]+>/g, '').trim();
    if (!url || !title) continue;
    out.push({ title, url, snippet: '' });
  }
  if (!out.length) throw new Error('ddg 无结果');
  return { ok: true, query: q, results: out };
}
