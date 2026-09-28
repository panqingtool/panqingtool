/* 去 AI 味 · 联网大模型改写代理（Cloudflare Pages Functions）
 *
 * 路由：POST /api/humanize
 *
 * 行为：
 *   - 接收前端提交的 { text, level }，调用配置的「大模型」把文本重写为更自然的人写风格，
 *     目标是降低被 AI 检测工具判为机器生成的概率。
 *   - 文本会经本函数转发给模型提供方（默认 DeepSeek）。函数不记录文本正文，仅透传。
 *
 * 环境变量（Cloudflare Pages 控制台 → Settings → Environment variables，Production）：
 *   HUMANIZE_API_KEY  = 模型提供方的 API Key（必填）
 *   HUMANIZE_BASE_URL = OpenAI 兼容的 /v1 基地址（可选，默认 https://api.deepseek.com/v1）
 *   HUMANIZE_MODEL    = 模型名（可选，默认 deepseek-chat；可用 gpt-4o-mini / qwen-plus 等）
 *
 * 未配置 HUMANIZE_API_KEY 时返回 503，前端自动降级为离线规则改写。
 */

const DEFAULT_BASE = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';

const SYSTEM_PROMPT = `你是一个专业的「去 AI 味」文本改写助手。请把用户提供的文本改写为更自然、更像人写的版本，目标是降低被 AI 检测工具判为机器生成的概率，同时绝对保证正确与忠实。要求：
1) 严格保持原意与所有关键信息、数据、人名、地名、专有名词、术语原义不变；绝不增删事实、绝不编造数据或引用；
2) 句式长短交错，多用口语化短句，避免整齐划一的排比和「首先 / 其次 / 最后」式三段结构；
3) 去掉套话与填充词（如「综上所述」「值得注意的是」「值得一提的是」「毋庸置疑」「显而易见」「换言之」「从这个角度来看」「由此可见」等）；
4) 禁止滥用破折号；显著降低「其」字密度（改用「它的 / 他的 / 这个 / 那个」等自然指代，但不要产生「它的能够」之类生硬表达）；
5) 把 AI 高频词与行业黑话（赋能、闭环、抓手、颗粒度、底层逻辑、一站式、里程碑、组合拳、认知、维度、保驾护航、添砖加瓦、行稳致远、砥砺前行 等）换成通俗自然的表达，但必须换成正确同义、不得改成错别字或错误词语；
6) 注意：绝不破坏原词正确含义——例如「增强现实」是 AR 术语不得改动、「进行曲」不得改成「曲」、其它专有名词原样保留；
7) 可适当加入自然的人称与语气，但绝不编造；
8) 不要加「希望这对你有帮助」之类的客套结尾；
9) 直接输出改写后的文本，不要解释、不要加引号、不要写「改写如下：」等引导语；
10) 输出前务必通读自检：确认没有错别字、没有错用的同义词、没有遗漏或曲解原意，若发现立即修正后再输出。`;

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign(
      { 'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'cache-control': 'no-store' },
      extra || {}
    )
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: '请求格式错误（需 JSON）' }, 400);
  }

  // 健康检查（ping）：只回是否配置了密钥，不调用模型
  if (body && body.ping) {
    const configured = !!(env.HUMANIZE_API_KEY && env.HUMANIZE_API_KEY.length > 0);
    return json({ ok: true, configured });
  }

  const text = (body && body.text ? body.text : '').toString();
  const level = (body && body.level ? body.level : 'std').toString();
  if (!text.trim()) return json({ ok: false, error: '文本为空' }, 400);

  const key = env.HUMANIZE_API_KEY;
  if (!key) {
    return json({
      ok: false,
      error: '后端未配置模型密钥：请在 Cloudflare Pages 控制台 Settings → Environment variables 添加 HUMANIZE_API_KEY（可选 HUMANIZE_BASE_URL / HUMANIZE_MODEL）。未配置时前端会自动使用离线改写（效果较弱）。'
    }, 503);
  }

  const base = (env.HUMANIZE_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const model = env.HUMANIZE_MODEL || DEFAULT_MODEL;

  const levelNote =
    level === 'light' ? '只去除最明显的套话，尽量保留原文结构与篇幅。' :
    level === 'deep'  ? '更大幅度打乱句式、更口语化、更自然，可适度调整段落顺序让节奏更像人写。' :
                        '适度重写，自然且不僵硬，保留原信息。';

  try {
    const upstream = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: levelNote + '\n\n请改写下面这段文本：\n' + text }
        ],
        temperature: 0.9,
        max_tokens: 4096
      })
    });
    if (!upstream.ok) {
      const t = await upstream.text();
      return json({ ok: false, error: '模型接口返回 ' + upstream.status + '：' + t.slice(0, 300) }, 502);
    }
    const data = await upstream.json();
    const out = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    if (!out) return json({ ok: false, error: '模型返回为空' }, 502);
    return json({ ok: true, out });
  } catch (e) {
    return json({ ok: false, error: '调用模型失败：' + (e && e.message ? e.message : String(e)) }, 502);
  }
}
