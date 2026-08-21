/* Cloudflare Pages Functions — 云端代理（免墙 / 免 CORS）
 * 用途：前端工具（AI 抠图 / OCR / 证件照换背景 / Office 转 PDF / PDF 签章 等）
 *        在直连公共 CDN 失败或缓慢时，经本函数服务端拉取资源再回传，
 *        绕过网络限制与跨域限制。仅允许白名单内的公共 CDN，避免被当作开放代理滥用。
 */
const ALLOW_HOSTS = [
  'cdn.jsdelivr.net',
  'fastly.jsdelivr.net',
  'unpkg.com',
  'esm.sh',
  'cdnjs.cloudflare.com',
  'raw.githubusercontent.com',
  'github.com',
  'huggingface.co',
  'tessdata.projectnaptha.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'open.er-api.com',
  'api.frankfurter.app',
];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequest({ request, url }) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });
  }
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('Missing "url" parameter', { status: 400, headers: corsHeaders() });
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    return new Response('Invalid "url"', { status: 400, headers: corsHeaders() });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return new Response('Unsupported protocol', { status: 400, headers: corsHeaders() });
  }
  if (ALLOW_HOSTS.indexOf(parsed.hostname) < 0) {
    return new Response('Host not allowed: ' + parsed.hostname, { status: 403, headers: corsHeaders() });
  }

  const upstreamHeaders = new Headers();
  upstreamHeaders.set('User-Agent', request.headers.get('User-Agent') || 'Mozilla/5.0 (compatible; panqingtool-proxy)');
  upstreamHeaders.set('Accept', '*/*');
  const ref = request.headers.get('Referer');
  if (ref) upstreamHeaders.set('Referer', ref);

  let upstream;
  try {
    upstream = await fetch(new Request(parsed.toString(), { method: 'GET', headers: upstreamHeaders, redirect: 'follow' }));
  } catch (e) {
    return new Response('Upstream fetch failed: ' + (e && e.message ? e.message : 'unknown'), { status: 502, headers: corsHeaders() });
  }

  const headers = new Headers(upstream.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
  // 让大体积模型 / 语言包可缓存，提升二次加载速度
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'public, max-age=86400');
  }
  // 移除可能干扰的头部
  headers.delete('Content-Security-Policy');
  headers.delete('X-Frame-Options');

  return new Response(upstream.body, { status: upstream.status, headers });
}
