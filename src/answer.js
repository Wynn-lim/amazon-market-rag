// RAG 问答：BM25 检索知识库 → 组装上下文 → 流式生成答案。
// 有 ANTHROPIC_API_KEY 时调用 Claude；没有时降级为「检索结果直出」，demo 零配置可跑。

const MODEL = 'claude-opus-5-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 16000;

const SYSTEM = `你是「亚马逊市场两层筛选框架」的选品分析助手。
规则：
1. 只能依据下方「知识库片段」回答，禁止引入片段之外的平台数据或经验值。
2. 引用依据时用片段编号，如 [S3]。
3. 回答用简体中文，先给结论，再给依据与可执行动作。
4. 片段没覆盖的部分，明确说「知识库未覆盖」，不要编。
5. 涉及阈值时，说明它来自哪一篇、并提醒这些是行业经验值而非精确值。`;

export function llmEnabled() {
  return typeof process !== 'undefined' && Boolean(process.env.ANTHROPIC_API_KEY);
}

function buildContext(hits) {
  return hits
    .map((h) => `[${h.id}] 《${h.doc}》› ${h.heading}\n${h.body}`)
    .join('\n\n——————\n\n');
}

// 无 LLM 时的降级答案：把最相关的片段要点直接摆出来。
// 纯函数、零依赖，Node 和浏览器都能用（GitHub Pages 静态版走这条）。
export function fallbackAnswer(question, hits, reason = '当前未配置 ANTHROPIC_API_KEY') {
  if (hits.length === 0) {
    return `没有检索到与「${question}」相关的知识库片段。\n\n可以换个说法，例如：月搜索量、TOP100 月均销量、新品进榜、品牌集中度、点击集中度、评论门槛、中位数、BSR 误差。`;
  }
  const lines = [
    `（${reason}，以下为知识库检索结果直出，未经过 LLM 归纳）`,
    ``,
    `与「${question}」最相关的 ${hits.length} 个片段：`,
  ];
  for (const h of hits) {
    lines.push(``, `▸ [${h.id}] 《${h.doc}》› ${h.heading}`);
    const bullets = h.body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('>'))
      .slice(0, 4);
    for (const b of bullets) lines.push(`  ${b}`);
  }
  lines.push(``, `本地运行（npm start）并配置 ANTHROPIC_API_KEY 后，同样的检索结果会交给 Claude 归纳成结论 + 依据 + 动作。`);
  return lines.join('\n');
}

async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
}

async function callClaude(prompt, { withFallbacks }) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    stream: true,
    messages: [{ role: 'user', content: prompt }],
  };
  if (withFallbacks) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  return fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });
}

// 返回异步生成器：{type:'delta'|'done', ...}
export async function* ask(question, retriever, topK = 5) {
  const hits = retriever.search(question, topK);
  const sources = hits.map((h) => ({ id: h.id, doc: h.doc, heading: h.heading, score: h.score }));

  if (!llmEnabled()) {
    yield { type: 'delta', text: fallbackAnswer(question, hits) };
    yield { type: 'done', sources, mode: 'retrieval-only' };
    return;
  }

  const prompt = `知识库片段：\n\n${buildContext(hits)}\n\n——————\n\n问题：${question}`;

  let response = await callClaude(prompt, { withFallbacks: true });
  if (response.status === 400 && (await response.clone().text()).includes('fallback')) {
    response = await callClaude(prompt, { withFallbacks: false });
  }
  if (!response.ok) {
    const detail = await response.text();
    yield { type: 'delta', text: `Claude 调用失败（HTTP ${response.status}）：${detail.slice(0, 400)}` };
    yield { type: 'done', sources, mode: 'error' };
    return;
  }

  let text = '';
  try {
    for await (const event of sseEvents(response)) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        text += event.delta.text;
        yield { type: 'delta', text: event.delta.text };
      } else if (event.type === 'error') {
        yield { type: 'delta', text: `\n[流式错误] ${JSON.stringify(event.error).slice(0, 300)}` };
      }
    }
  } catch (err) {
    yield { type: 'delta', text: `\n[流式中断] ${err.message}` };
  }

  yield { type: 'done', sources, mode: 'claude', model: MODEL, text };
}
