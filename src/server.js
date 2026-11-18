import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { loadChunks } from './kb.js';
import { BM25Retriever } from './retriever.js';
import { scoreMarket, listRules, listThresholds } from './scorer.js';
import { ask, llmEnabled } from './answer.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT ?? 8787);

const chunks = loadChunks(join(root, 'kb'));
const retriever = new BM25Retriever(chunks);
const markets = JSON.parse(readFileSync(join(root, 'data', 'markets.sample.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      // 注入模式标记：前端据此判断能否用服务端能力，避免为探测而发必然失败的请求
      const html = readFileSync(join(root, 'public', 'index.html'), 'utf8').replace(
        '</head>',
        '<meta name="demo-mode" content="server">\n</head>'
      );
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(html);
    }
    if (req.method === 'GET' && path.startsWith('/static/')) {
      const rel = normalize(path.slice('/static/'.length)).replace(/^(\.\.[/\\])+/, '');
      const file = join(root, 'public', rel);
      if (!file.startsWith(join(root, 'public'))) {
        res.writeHead(403);
        return res.end('forbidden');
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      return res.end(readFileSync(file));
    }
    // 前端要直接 import src/ 下的纯模块（scorer / retriever / answer），与 Pages 静态版共用同一份代码
    if (req.method === 'GET' && path.startsWith('/src/')) {
      const rel = normalize(path.slice('/src/'.length)).replace(/^(\.\.[/\\])+/, '');
      const file = join(root, 'src', rel);
      if (!file.startsWith(join(root, 'src')) || extname(file) !== '.js') {
        res.writeHead(403);
        return res.end('forbidden');
      }
      res.writeHead(200, { 'content-type': MIME['.js'] });
      return res.end(readFileSync(file));
    }

    if (req.method === 'GET' && path === '/api/markets') {
      return sendJson(res, 200, {
        markets,
        rules: listRules(),
        thresholds: listThresholds(),
        llm: llmEnabled(),
        model: llmEnabled() ? 'claude-opus-5-5' : null,
        chunks: chunks.length,
      });
    }

    if (req.method === 'POST' && path === '/api/score') {
      const { metrics } = await readBody(req);
      if (!metrics || typeof metrics !== 'object') return sendJson(res, 400, { error: '缺少 metrics' });
      return sendJson(res, 200, scoreMarket(metrics));
    }

    if (req.method === 'POST' && path === '/api/ask') {
      const { question } = await readBody(req);
      if (!question || !String(question).trim()) return sendJson(res, 400, { error: '缺少 question' });

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const push = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      try {
        for await (const ev of ask(String(question).slice(0, 500), retriever)) {
          push(ev);
          if (ev.type === 'done') break;
        }
      } catch (err) {
        push({ type: 'delta', text: `\n[服务端错误] ${err.message}` });
        push({ type: 'done', sources: [], mode: 'error' });
      }
      return res.end();
    }

    if (req.method === 'GET' && path === '/api/search') {
      const q = url.searchParams.get('q') ?? '';
      const k = Math.min(Number(url.searchParams.get('k') ?? 5), 10);
      return sendJson(res, 200, { query: q, hits: q.trim() ? retriever.search(q, k) : [] });
    }

    if (req.method === 'GET' && path === '/api/kb') {
      // 返回完整片段：前端要在浏览器里重建 BM25 索引，需要 text 与 body
      return sendJson(res, 200, {
        chunks: chunks.map((c) => ({ id: c.id, file: c.file, doc: c.doc, heading: c.heading, text: c.text, body: c.body })),
      });
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`两层框架 RAG demo → http://localhost:${PORT}`);
  console.log(`知识库 ${chunks.length} 个片段 | 生成模式：${llmEnabled() ? 'Claude (claude-opus-5-5)' : '纯检索（设置 ANTHROPIC_API_KEY 后启用 LLM）'}`);
});
