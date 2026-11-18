// 同构前端：同一份代码在两种环境下运行
//   本地模式（npm start）   —— 有 Node 服务端，知识问答走 SSE 流式 + Claude
//   静态模式（GitHub Pages）—— 无服务端，评分与检索全部在浏览器里跑，问答退化为检索直出
// scorer / retriever / answer 都是零 import 的纯模块，两边共用同一份代码。

import { scoreMarket } from '../src/scorer.js';
import { BM25Retriever } from '../src/retriever.js';
import { fallbackAnswer } from '../src/answer.js';

const FIELDS = [
  ['keywordSearchVolume', '核心词月搜索量', '次/月', { min: 0, step: 100 }],
  ['keywordGrowthRate', '核心词月增长率', '%', { pct: true, step: 0.5 }],
  ['top100AvgMonthlySales', 'TOP100 月均销量', '单/月', { min: 0, step: 10 }],
  ['top20MonthlySalesSum', '前 20 名月销求和', '单/月', { min: 0, step: 100 }],
  ['avgPrice', '客单价', '$', { min: 0, step: 0.5 }],
  ['newProducts6m', '近 6 个月新品进榜', '个', { min: 0, step: 1 }],
  ['newProductShare', '新品占比', '%', { pct: true, step: 0.5 }],
  ['medianMonthlySales', '月销量中位数', '单/月', { min: 0, step: 10 }],
  ['meanMonthlySales', '月销量均值', '单/月', { min: 0, step: 10 }],
  ['top3BrandShare', '前三品牌集中度', '%', { pct: true, step: 0.5 }],
  ['top10SalesShare', 'Top10 销量集中度', '%', { pct: true, step: 0.5 }],
  ['top20AvgReviews', 'Top20 平均评论数', '条', { min: 0, step: 10 }],
  ['clickConcentration', '点击集中度', '%', { pct: true, step: 0.5 }],
  ['avgRating', '市场平均评分', '星', { min: 0, max: 5, step: 0.1 }],
];

const STATUS = {
  pass: { word: '通过', icon: '✓' },
  warn: { word: '需论证', icon: '!' },
  fail: { word: '不利', icon: '✕' },
  info: { word: '参考', icon: 'i' },
};

const VERDICT = {
  go: { word: '可以进入细评', icon: '✓' },
  conditional: { word: '有条件进入', icon: '!' },
  risky: { word: '风险偏高', icon: '!' },
  reject: { word: '建议放弃', icon: '✕' },
};

const state = {
  markets: [],
  retriever: null,
  server: false, // 是否连着本地 Node 服务端
  active: null,
  busy: false,
};

const $ = (sel) => document.querySelector(sel);
// 服务端下发的文本统一转义后再进 innerHTML
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => {
  if (typeof v !== 'number') return v;
  const r = Math.round(v * 100) / 100; // 0.29 * 100 会得到 28.999…，先规整再格式化
  return Number.isInteger(r) ? r.toLocaleString('en-US') : r.toFixed(1);
};
const fillColor = (pct) => (pct >= 75 ? 'var(--good)' : pct >= 50 ? 'var(--warning)' : 'var(--critical)');

/* ---------------- tabs ---------------- */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${btn.dataset.tab}`; });
  });
});
function showTab(name) {
  document.querySelector(`.tab[data-tab="${name}"]`)?.click();
}

/* ---------------- 表单 ---------------- */
function buildForm() {
  const form = $('#metricForm');
  const grid = document.createDocumentFragment();
  for (const [key, label, unit, opt] of FIELDS) {
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `<label for="f-${key}">${label}<span style="color:var(--muted)"> · ${unit}</span></label>`;
    const input = document.createElement('input');
    input.id = `f-${key}`;
    input.type = 'number';
    input.step = String(opt.step ?? 1);
    if (opt.min !== undefined) input.min = String(opt.min);
    if (opt.max !== undefined) input.max = String(opt.max);
    input.dataset.key = key;
    if (opt.pct) input.dataset.pct = '1';
    input.addEventListener('input', scheduleScore);
    row.appendChild(input);
    grid.appendChild(row);
  }
  form.appendChild(grid);

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  actions.innerHTML = `<button type="submit" class="btn primary">重新体检</button><button type="button" class="btn" id="resetBtn">清空</button>`;
  form.appendChild(actions);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    runScore();
  });
  $('#resetBtn').addEventListener('click', () => {
    form.querySelectorAll('input').forEach((i) => { i.value = ''; });
    state.active = null;
    renderSamples();
    $('#scoreOut').innerHTML = '<p class="empty">已清空。填入数值后会自动重新体检。</p>';
  });
}

function readForm() {
  const metrics = {};
  for (const input of $('#metricForm').querySelectorAll('input')) {
    if (input.value === '') continue;
    const n = Number(input.value);
    if (Number.isNaN(n)) continue;
    metrics[input.dataset.key] = input.dataset.pct ? n / 100 : n;
  }
  return metrics;
}

function fillForm(metrics) {
  for (const input of $('#metricForm').querySelectorAll('input')) {
    const v = metrics[input.dataset.key];
    input.value = v === undefined ? '' : input.dataset.pct ? (v * 100).toFixed(0) : String(v);
  }
}

let timer = null;
function scheduleScore() {
  clearTimeout(timer);
  timer = setTimeout(runScore, 300);
}

/* ---------------- 示例市场 ---------------- */
function renderSamples() {
  const wrap = $('#samples');
  wrap.innerHTML = '';
  for (const m of state.markets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `sample${state.active === m.id ? ' active' : ''}`;
    btn.innerHTML = `<strong>${esc(m.name)}</strong><span>${esc(m.note)}</span>`;
    btn.addEventListener('click', () => {
      state.active = m.id;
      fillForm(m.metrics);
      renderSamples();
      runScore();
    });
    wrap.appendChild(btn);
  }
}

/* ---------------- 体检结果 ---------------- */
function renderScore(data) {
  const out = $('#scoreOut');
  const v = VERDICT[data.verdict];
  const veto = data.vetoed.map((x) => `${x.label}：${x.detail}`).join('；');

  const meter = (label, l, cls = '') => `
    <div class="meter ${cls}">
      <span class="m-label">${label}</span>
      <span class="track"><span class="fill" style="width:${l.pct}%;background:${fillColor(l.pct)}"></span></span>
      <span class="num">${l.got} / ${l.max} · ${l.pct}%</span>
    </div>`;

  const ruleRow = (r) => {
    const s = STATUS[r.status];
    const advice = r.status !== 'pass' && r.advice ? `<div class="r-advice"><b>动作：</b>${esc(r.advice)}</div>` : '';
    return `
      <div class="rule s-${r.status}">
        <span class="s-icon" aria-hidden="true">${s.icon}</span>
        <div class="r-main">
          <span class="r-label">${esc(r.label)}</span><span class="r-threshold">${esc(r.threshold)}</span>
          ${r.thresholdSrc ? `<span class="origin-chip${r.thresholdSrc.includes('自定') ? ' pending' : ''}">${esc(r.thresholdSrc)}</span>` : ''}
          <span class="status-word">${s.word}</span>
          <button class="src-chip" type="button" data-src="${esc(r.source.file)}||${esc(r.source.heading)}">依据：${esc(r.source.heading)}</button>
          <div class="r-detail">${esc(r.detail)}</div>
          ${advice}
        </div>
        <div class="r-value">${fmt(r.value)}<small>${r.unit}</small></div>
      </div>`;
  };

  const layer = (n, title) => `
    <div class="layer-head">第${n}层 · ${title}<span>　${data.layers[n].pct}%</span></div>
    ${data.results.filter((r) => r.layer === n).map(ruleRow).join('')}`;

  out.innerHTML = `
    <div class="verdict verdict-${data.verdict}">
      <span class="v-icon" aria-hidden="true">${v.icon}</span>
      <div>
        <h2>${v.word}</h2>
        <p>${veto ? `命中否决线 — ${veto}` : `总分 ${data.total.got} / ${data.total.max}（${data.total.pct}%）`}</p>
      </div>
    </div>
    <div class="meters">
      ${meter('第一层 · 容量与需求', data.layers[1])}
      ${meter('第二层 · 竞争格局', data.layers[2])}
      ${meter('合计', data.total, 'meter-total')}
    </div>
    ${layer(1, '市场容量与需求')}
    ${layer(2, '竞争格局')}
  `;

  out.querySelectorAll('[data-src]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [, heading] = btn.dataset.src.split('||');
      showTab('kb');
      $('#kbInput').value = heading;
      kbSearch(heading);
    });
  });
}

// 评分始终在浏览器里跑：scorer 是零依赖纯模块，本地和 Pages 走同一份代码、同一套结果
function runScore() {
  const metrics = readForm();
  if (Object.keys(metrics).length < 5) {
    $('#scoreOut').innerHTML = '<p class="empty">至少填入 5 个指标才会给出结论。</p>';
    return;
  }
  renderScore(scoreMarket(metrics));
}

/* ---------------- 知识问答 ---------------- */
const SUGGESTIONS = [
  '点击集中度多高算危险？',
  '新品进榜数量怎么看？',
  '月销 8000+ 能当精确值用吗？',
  '均值高中位数低说明什么？',
];

function renderChips() {
  const wrap = $('#chips');
  wrap.innerHTML = '';
  for (const q of SUGGESTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = q;
    b.addEventListener('click', () => askQuestion(q));
    wrap.appendChild(b);
  }
}

function addMsg(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  const who = role === 'user' ? '你' : state.server ? 'Claude · 基于知识库' : '检索模式';
  el.innerHTML = `<span class="who">${who}</span><div class="bubble"></div>`;
  el.querySelector('.bubble').textContent = text;
  $('#chat').appendChild(el);
  $('#chat').scrollTop = $('#chat').scrollHeight;
  return el;
}

async function askQuestion(question) {
  if (state.busy) return;
  state.busy = true;
  addMsg('user', question);

  // 静态模式：没有服务端，直接用检索结果拼答案
  if (!state.server) {
    const hits = state.retriever.search(question, 5);
    const el = addMsg('bot', fallbackAnswer(question, hits, 'GitHub Pages 静态版未接入 LLM'));
    appendCites(el, hits.map((h) => ({ id: h.id, doc: h.doc, heading: h.heading })));
    state.busy = false;
    return;
  }

  const el = addMsg('bot', '…');
  const bubble = el.querySelector('.bubble');
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let acc = '';
    let cites = [];

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (!data) continue;
        const ev = JSON.parse(data);
        if (ev.type === 'delta') {
          acc += ev.text;
          bubble.textContent = acc;
          $('#chat').scrollTop = $('#chat').scrollHeight;
        } else if (ev.type === 'done') {
          cites = ev.sources ?? [];
        }
      }
    }
    appendCites(el, cites);
  } catch (err) {
    bubble.textContent = `请求失败：${err.message}`;
  } finally {
    state.busy = false;
    $('#chat').scrollTop = $('#chat').scrollHeight;
  }
}

function appendCites(msgEl, cites) {
  if (!cites.length) return;
  const row = document.createElement('div');
  row.className = 'cites';
  row.innerHTML = cites.map((c) => `<span class="cite">[${esc(c.id)}] ${esc(c.doc)} › ${esc(c.heading)}</span>`).join('');
  msgEl.appendChild(row);
}

$('#askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#askInput').value.trim();
  if (!q) return;
  $('#askInput').value = '';
  askQuestion(q);
});

/* ---------------- 检索试玩 ---------------- */
function kbSearch(q) {
  const out = $('#kbOut');
  if (!q.trim()) {
    out.innerHTML = '<p class="empty">输入关键词开始检索。</p>';
    return;
  }
  const hits = state.retriever.search(q, 5);
  if (!hits.length) {
    out.innerHTML = '<p class="empty">没有命中。换个说法试试。</p>';
    return;
  }
  out.innerHTML = hits
    .map(
      (h) => `
    <div class="hit">
      <header><span>[${esc(h.id)}] ${esc(h.doc)} › ${esc(h.heading)}</span><span class="score">BM25 ${esc(h.score)}</span></header>
      <pre>${esc(h.body.slice(0, 320))}${h.body.length > 320 ? '…' : ''}</pre>
    </div>`
    )
    .join('');
}

$('#kbForm').addEventListener('submit', (e) => {
  e.preventDefault();
  kbSearch($('#kbInput').value);
});

/* ---------------- 启动 ---------------- */
async function loadStatic() {
  const [markets, chunks] = await Promise.all([
    fetch('markets.json').then((r) => r.json()),
    fetch('kb.chunks.json').then((r) => r.json()),
  ]);
  state.markets = markets;
  state.retriever = new BM25Retriever(chunks);
}

async function loadFromServer() {
  const data = await (await fetch('/api/markets')).json();
  state.markets = data.markets;
  // 服务端模式下检索也走同一份代码，只是数据来自同一个 kb 目录
  const chunks = await (await fetch('/api/kb')).json();
  state.retriever = new BM25Retriever(chunks.chunks);
}

async function init() {
  buildForm();
  renderChips();
  // 服务端会在 HTML 里注入 <meta name="demo-mode" content="server">；静态版没有这个标记
  state.server = document.querySelector('meta[name="demo-mode"]')?.content === 'server';
  if (state.server) await loadFromServer();
  else await loadStatic();

  const badge = $('#modeBadge');
  badge.textContent = state.server
    ? '本地模式 · Claude 流式问答可用'
    : '静态版 · 纯检索模式（LLM 问答需本地 npm start）';
  badge.classList.toggle('on', state.server);
  $('#kbStat').textContent = state.server
    ? '本地模式 · 评分与检索在浏览器运行，问答走服务端流式'
    : 'GitHub Pages 静态版 · 评分与检索全部在浏览器运行';
  renderSamples();
  kbSearch($('#kbInput').value);
}

init();
