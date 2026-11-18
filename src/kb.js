import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

// 把 Markdown 知识库切成检索单元：一个 "## " 小节一个 chunk，
// 标题路径会一起进索引，这样"第几层/哪一条"也能被检索到。
export function loadChunks(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const chunks = [];

  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf8');
    const lines = raw.split(/\r?\n/);
    let docTitle = basename(file, '.md');
    let heading = null;
    let body = [];

    const flush = () => {
      const text = body.join('\n').trim();
      if (!heading || !text) return;
      chunks.push({
        id: `S${chunks.length + 1}`,
        file,
        doc: docTitle,
        heading,
        // 索引文本 = 文档标题 + 小节标题（重复一次以加权）+ 正文，
        // 这样"第几层/哪一篇"能被检索到，标题命中也更有分量
        text: `${docTitle} > ${heading}\n${heading}\n${text}`,
        body: text,
      });
    };

    for (const line of lines) {
      if (line.startsWith('# ') && !line.startsWith('## ')) {
        flush();
        body = [];
        docTitle = line.slice(2).trim();
      } else if (line.startsWith('## ')) {
        flush();
        body = [];
        heading = line.slice(3).trim();
      } else if (heading) {
        body.push(line);
      }
    }
    flush();
  }

  return chunks;
}
