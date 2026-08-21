/* Cloudflare Pages Functions — 安全头
 * 给所有响应（含静态资源）加上业界推荐的安全相关 header：
 *  - X-Content-Type-Options: nosniff（拒绝 MIME 嗅探，避免"网站风险"判定）
 *  - X-Frame-Options: DENY（拒绝被 iframe 嵌套，抵御 clickjacking）
 *  - Referrer-Policy: strict-origin-when-cross-origin（外链时只携带源信息）
 *  - Permissions-Policy: 关闭摄像头/麦克风/地理/支付等敏感 API 默认授权
 *    （需要时由工具代码用 Permissions.request 显式申请）
 *  - Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy / Resource-Opener-Policy
 *  - Strict-Transport-Security（HTTPS 时长 1 年）
 * 注：Cloudflare 自动注入 CSP 也可以通过 _headers 设置；本文件不动静态资源的 CSP。
 */
export async function onRequest(context) {
  const resp = await context.next();
  const h = new Headers(resp.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'SAMEORIGIN');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy',
    'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=(), magnetometer=(self), accelerometer=(self), gyroscope=(self), interest-cohort=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  return new Response(resp.body, { status: resp.status, headers: h });
}
