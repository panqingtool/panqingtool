/* 天气查询代理（Cloudflare Pages Functions）
 * GET /weather?lat=29.5647&lon=106.5507
 * 默认走 open-meteo（无需 Key）；如需商业 API 可配 WEATHER_API_KEY 调用 OpenWeatherMap。
 * CF 边缘节点请求，国内访问无墙问题；前端只需 fetch('/weather?...')。
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const lat = (url.searchParams.get('lat') || '').trim();
  const lon = (url.searchParams.get('lon') || '').trim();
  if (!lat || !lon) return json({ ok: false, error: '缺少 lat / lon' }, 400);

  try {
    const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(lat) +
      '&longitude=' + encodeURIComponent(lon) +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max' +
      '&timezone=auto&forecast_days=7';
    const r = await fetch(u, { headers: { 'User-Agent': 'PanQingToolbox/1.0' } });
    if (!r.ok) throw new Error('open-meteo http ' + r.status);
    const j = await r.json();
    const c = j.current || {};
    const d = j.daily || {};
    const out = {
      ok: true,
      lat: j.latitude, lon: j.longitude,
      timezone: j.timezone,
      now: {
        temperature: c.temperature_2m,
        feelsLike: c.apparent_temperature,
        humidity: c.relative_humidity_2m,
        windSpeed: c.wind_speed_10m,
        windDir: c.wind_direction_10m,
        pressure: c.pressure_msl,
        weatherCode: c.weather_code,
        isDay: !!c.is_day
      },
      daily: Array.isArray(d.time) ? d.time.map((t, i) => ({
        date: t,
        weatherCode: (d.weather_code || [])[i],
        tMax: (d.temperature_2m_max || [])[i],
        tMin: (d.temperature_2m_min || [])[i],
        sunrise: (d.sunrise || [])[i],
        sunset: (d.sunset || [])[i],
        uv: (d.uv_index_max || [])[i],
        pop: (d.precipitation_probability_max || [])[i]
      })) : []
    };
    return json(out, 200, { 'cache-control': 'public, max-age=600' });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 502);
  }
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extraHeaders || {})
  });
}
