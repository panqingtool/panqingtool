/* 综合查询代理（手机归属 / 汇率 / 词典 / 翻译 / IP 归属）
 * GET /lookup?type=phone&q=13800138000
 * GET /lookup?type=fx&from=USD&to=CNY
 * GET /lookup?type=dict&w=hello
 * GET /lookup?type=ip
 *
 * 注：以下服务均为公开免费接口，CF 边缘节点请求规避国内 CORS/墙；如配 Key 可走更稳定的源。
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const type = (url.searchParams.get('type') || '').toLowerCase();
  try {
    if (type === 'phone') return await phone(url.searchParams.get('q') || '');
    if (type === 'fx')    return json(ok({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), rates: await fx(url) }));
    if (type === 'dict')  return json(ok(await dict(url.searchParams.get('w') || '')));
    if (type === 'ip')    return json(ok(await ipSelf(request)));
    return json({ ok: false, error: '未知 type，可选 phone / fx / dict / ip' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 502);
  }
}

function ok(data) { return { ok: true, data }; }
function json(obj, status) { return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=120' } }); }

/* ---------- 手机归属（Taobao 公开接口，无需 Key） ---------- */
async function phone(q) {
  const m = /^(?:\+?86)?(1[3-9]\d{9})$/.exec((q || '').replace(/\s|-/g, ''));
  if (!m) throw new Error('手机号格式错误');
  const num = m[1];
  const u = 'https://tcc.taobao.com/cc/json/mobile_tel_segment.htm?tel=' + num;
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const txt = await r.text();
  const j = JSON.parse(txt.replace(/^\s*__getZoneResult_=/, '').replace(/;?\s*$/, ''));
  return { number: num, province: j.province || '', city: j.cityName || '', operator: j.carrier || '', sim: j.catName || '' };
}

/* ---------- 汇率（exchangerate.host / frankfurter，均为开源接口） ---------- */
async function fx(url) {
  const from = (url.searchParams.get('from') || 'USD').toUpperCase();
  const to = (url.searchParams.get('to') || 'CNY').toUpperCase();
  const r = await fetch('https://api.frankfurter.app/latest?from=' + from + '&to=' + to);
  if (!r.ok) throw new Error('fx http ' + r.status);
  const j = await r.json();
  return { rate: (j.rates && j.rates[to]) || null, date: j.date, base: from };
}

/* ---------- 词典（free dictionary api） ---------- */
async function dict(w) {
  const word = (w || '').trim();
  if (!word) throw new Error('缺少单词');
  const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
  if (!r.ok) throw new Error('dict http ' + r.status);
  const j = await r.json();
  if (Array.isArray(j) && j.length) {
    const e = j[0];
    const phonetic = e.phonetic || (e.phonetics && e.phonetics[0] && e.phonetics[0].text) || '';
    const meanings = (e.meanings || []).map((m) => ({
      pos: m.partOfSpeech,
      defs: (m.definitions || []).slice(0, 3).map((d) => ({ definition: d.definition, example: d.example || '' }))
    }));
    return { word: e.word, phonetic, meanings };
  }
  throw new Error('未查到该单词');
}

/* ---------- IP 归属 ---------- */
async function ipSelf(request) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!ip) return { ip: '' };
  const r = await fetch('https://ipwho.is/' + ip);
  if (!r.ok) return { ip };
  const j = await r.json();
  return { ip, country: j.country, region: j.region, city: j.city, latitude: j.latitude, longitude: j.longitude, isp: j.connection && j.connection.org };
}
