// 把项目构建成可托管在 GitHub Pages 上的纯静态站点。
//   node scripts/build-static.mjs
// 产出 site/：
//   site/index.html              入口（资源路径已从 /static/ 改写为 public/）
//   site/public/{app.js,style.css}  前端逻辑与样式
//   site/src/*.js                评分 / 检索 / 降级答案（零 import 纯模块）
//   site/{markets.json,kb.chunks.json}  本地服务端缺失时，浏览器直接读这两份数据
//
// 本地开发不需要这一步，npm start 直接跑服务端版本（服务端实时读 kb/，无生成物、无漂移）。

import { mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadChunks } from '../src/kb.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const site = join(root, 'site');

rmSync(site, { recursive: true, force: true });
mkdirSync(join(site, 'public'), { recursive: true });
mkdirSync(join(site, 'src'), { recursive: true });

// 静态站没有 /static/ 路由，把资源路径改写成相对 public/
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8').replaceAll('/static/', 'public/');
writeFileSync(join(site, 'index.html'), html);

copyFileSync(join(root, 'public', 'app.js'), join(site, 'public', 'app.js'));
copyFileSync(join(root, 'public', 'style.css'), join(site, 'public', 'style.css'));

// scorer / retriever / answer 都是零 import 的纯 ESM，原样拷过去即可在浏览器运行
for (const f of ['scorer.js', 'retriever.js', 'answer.js']) {
  copyFileSync(join(root, 'src', f), join(site, 'src', f));
}

// 知识库在 Node 侧切好，浏览器直接拿片段重建 BM25 索引
const chunks = loadChunks(join(root, 'kb'));
writeFileSync(
  join(site, 'kb.chunks.json'),
  JSON.stringify(chunks.map((c) => ({ id: c.id, file: c.file, doc: c.doc, heading: c.heading, text: c.text, body: c.body })))
);
writeFileSync(join(site, 'markets.json'), readFileSync(join(root, 'data', 'markets.sample.json'), 'utf8'));

console.log(`静态站点已生成 → site/（${chunks.length} 个知识库片段）`);
