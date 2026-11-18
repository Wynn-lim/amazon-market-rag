import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadChunks } from '../src/kb.js';
import { BM25Retriever, tokenize } from '../src/retriever.js';
import { scoreMarket, listRules, listThresholds } from '../src/scorer.js';
import { fallbackAnswer } from '../src/answer.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const chunks = loadChunks(join(root, 'kb'));
const retriever = new BM25Retriever(chunks);
const markets = JSON.parse(readFileSync(join(root, 'data', 'markets.sample.json'), 'utf8'));
const metricsOf = (id) => markets.find((m) => m.id === id).metrics;

test('知识库被切成多个带标题路径的片段', () => {
  assert.ok(chunks.length >= 10, `期望 ≥10 个片段，实际 ${chunks.length}`);
  for (const c of chunks) {
    assert.match(c.id, /^S\d+$/);
    assert.ok(c.doc.length > 0);
    assert.ok(c.heading.length > 0);
    assert.ok(c.body.length > 20);
  }
  // 三个知识库文件都被加载
  const files = new Set(chunks.map((c) => c.file));
  assert.equal(files.size, 3);
});

test('中文分词产出单字、二元组与三元组', () => {
  const t = tokenize('月搜索量');
  assert.ok(t.includes('月'));
  assert.ok(t.includes('搜索'));
  assert.ok(t.includes('搜索量'));
  assert.deepEqual(tokenize('CPC'), ['cpc']);
});

test('BM25 检索命中正确小节', () => {
  const cases = [
    ['核心词月搜索量多少算健康', '核心关键词月搜索量'],
    ['TOP100 月均销量合理区间', '类目 TOP100 月均销量'],
    ['新品进榜数量怎么判断', '新品进榜数量（新品生存空间）'],
    ['点击集中度是什么指标', '点击集中度'],
    ['前三品牌集中度超过多少要跳过', '品牌 / 卖家集中度'],
    ['腰部以下 ASIN 的销量误差', 'BSR 分布与销量估算的误差意识'],
    ['均值高中位数低是什么市场', '评分分布与中位数意识'],
    ['工具估算误差有多大', '误差意识的三条纪律'],
  ];
  for (const [q, expectedHeading] of cases) {
    const hits = retriever.search(q, 3);
    assert.ok(hits.length > 0, `「${q}」无命中`);
    assert.equal(
      hits[0].heading,
      expectedHeading,
      `「${q}」首位命中「${hits[0].heading}」，期望「${expectedHeading}」`
    );
  }
});

test('同义词扩展提升口语查询命中', () => {
  const hits = retriever.search('CPC 太高怎么办', 3);
  assert.ok(hits.some((h) => h.heading === '点击集中度'), 'CPC 应能带到点击集中度');
});

test('降级答案：本地与 Pages 静态版共用，原因文案可区分', () => {
  const hits = retriever.search('点击集中度', 3);
  const local = fallbackAnswer('点击集中度', hits);
  const pages = fallbackAnswer('点击集中度', hits, 'GitHub Pages 静态版未接入 LLM');

  assert.ok(local.includes('当前未配置 ANTHROPIC_API_KEY'), '本地降级应说明缺少 API key');
  assert.ok(!local.includes('GitHub Pages'), '本地降级不应出现 Pages 字样');
  assert.ok(pages.includes('GitHub Pages 静态版未接入 LLM'), 'Pages 降级应说明是静态版');
  assert.ok(pages.includes('本地运行（npm start）'), '降级答案应指向可启用 LLM 的路径');

  // 两种模式列出的片段必须一致，只有原因文案不同
  const strip = (s) => s.replace(/（[^）]*）/g, '').trim();
  assert.equal(strip(pages), strip(local));

  // 无命中时给出可操作的提示，而不是空字符串
  const empty = fallbackAnswer('zzz不存在的词zzz', []);
  assert.ok(empty.includes('没有检索到'));
  assert.ok(empty.includes('月搜索量'));
});

test('评分规则覆盖两层且每条都有知识库依据', () => {
  const rules = listRules();
  assert.ok(rules.filter((r) => r.layer === 1).length >= 5);
  assert.ok(rules.filter((r) => r.layer === 2).length >= 5);
  for (const r of rules) {
    assert.ok(r.source.file.endsWith('.md'), `${r.id} 缺少依据文件`);
    assert.ok(r.source.heading.length > 0, `${r.id} 缺少依据小节`);
    // 依据必须真实存在于知识库里
    assert.ok(
      chunks.some((c) => c.file === r.source.file && c.heading === r.source.heading),
      `${r.id} 的依据 ${r.source.file} › ${r.source.heading} 不在知识库中`
    );
  }
  // 中位数意识属于第二层④，必须落在第二层计分
  const skew = rules.find((r) => r.id === 'skew');
  assert.equal(skew.layer, 2);
});

test('标注「原文」的阈值，数字确实写在知识库里', () => {
  // 这些阈值声称来自原文，就必须能在对应小节里找到同样的数字
  const arabic = {
    top100Min: ['600', '类目 TOP100 月均销量'],
    top100Max: ['3000', '类目 TOP100 月均销量'],
    reviewsGood: ['800', '头部评论数门槛'],
    ratingGood: ['4.3', '评分分布与中位数意识'],
    ratingBad: ['4.7', '评分分布与中位数意识'],
    top3BrandVeto: ['40%', '品牌 / 卖家集中度'],
    top10SalesBad: ['6 成', '品牌 / 卖家集中度'],
    newProductsMin: ['5 个', '新品进榜数量（新品生存空间）'],
    newProductShareMin: ['10%', '新品进榜数量（新品生存空间）'],
    growthGood: ['10%', '核心关键词月搜索量'],
  };
  for (const [key, [literal, heading]] of Object.entries(arabic)) {
    const t = listThresholds().find((x) => x.key === key);
    assert.equal(t.src, '原文', `${key} 应标注为原文`);
    const chunk = chunks.find((c) => c.heading === heading);
    assert.ok(chunk, `找不到小节 ${heading}`);
    assert.ok(chunk.body.includes(literal), `「${key}」声称原文阈值 ${literal}，但 ${heading} 里找不到`);
  }
});

test('阈值来源标注完整，不再有未经确认的补档', () => {
  const all = listThresholds();
  const bySrc = (s) => all.filter((t) => t.src === s).map((t) => t.key).sort();
  // 用户 2026-11-18 确认了全部补档沿用
  assert.deepEqual(
    bySrc('已确认'),
    ['clickConcBad', 'clickConcWarn', 'skewBad', 'skewGood', 'top10SalesWarn', 'top3BrandWarn'].sort()
  );
  assert.deepEqual(bySrc('自定'), [], '所有补档阈值均应已有明确确认状态');
  for (const t of all) {
    assert.ok(t.note && t.note.length > 5, `${t.key} 缺少阈值说明`);
  }
});

test('规则的来源标注与其阈值的真实来源一致', () => {
  // 这条是回归测试：混合标注曾经被硬编码成「原文+自定」，导致补档已确认后仍显示待确认
  const byKey = new Map(listThresholds().map((t) => [t.key, t]));
  for (const r of listRules()) {
    if (!r.thresholdKeys.length) continue;
    const srcs = [...new Set(r.thresholdKeys.map((k) => byKey.get(k).src))];
    assert.equal(r.thresholdSrc, srcs.join('+'), `${r.id} 的标注与阈值真实来源不符`);
    if (r.thresholdSrc === '原文') {
      assert.ok(srcs.every((s) => s === '原文'), `${r.id} 含补档阈值却标成纯原文`);
    }
    assert.ok(!r.thresholdSrc.includes('自定'), `${r.id} 仍含未经确认的阈值`);
  }
});

test('健康市场：两层都过，判定可以进入', () => {
  const s = scoreMarket(metricsOf('posture-cushion'));
  assert.equal(s.verdict, 'go');
  assert.equal(s.vetoed.length, 0);
  assert.equal(s.layers[1].pct, 100, '第一层四项全过');
  assert.ok(s.layers[2].pct >= 70, `第二层 ${s.layers[2].pct}%`);
});

test('红海市场：命中否决线，判定放弃', () => {
  const s = scoreMarket(metricsOf('yoga-mat'));
  assert.equal(s.verdict, 'reject');
  const vetoIds = s.vetoed.map((v) => v.id);
  assert.ok(vetoIds.includes('top3Brand'), '前三品牌集中度应命中否决');
  assert.ok(vetoIds.includes('newProducts'), '新品占比应命中否决');
  assert.ok(s.actions.length >= 4);
});

test('需求不足市场：第一层否决，第二层再好看也放弃', () => {
  const s = scoreMarket(metricsOf('pet-cooling-mat'));
  assert.equal(s.verdict, 'reject');
  assert.ok(s.layers[2].pct >= 80, '反例的第二层应当是健康的，否则测不出第一层的作用');
  assert.ok(s.vetoed.some((v) => v.id === 'searchVolume'));
});

test('第一层过、第二层全 warn：判定有条件进入', () => {
  const s = scoreMarket(metricsOf('shower-chair'));
  assert.equal(s.verdict, 'conditional');
  assert.ok(s.layers[1].pct >= 60);
  assert.equal(s.layers[2].pct, 50);
  assert.equal(s.results.filter((r) => r.layer === 2 && r.status === 'warn').length, 6, '洗澡椅第二层应当六项全部需论证');
  assert.equal(s.vetoed.length, 0);
});

test('参考项不计分，中位数意识生效', () => {
  const s = scoreMarket(metricsOf('yoga-mat'));
  const info = s.results.find((r) => r.id === 'capacity');
  assert.equal(info.kind, 'info');
  const skew = s.results.find((r) => r.id === 'skew');
  assert.equal(skew.status, 'fail', '瑜伽垫中位数/均值 0.05，应是头部拉动型');
});
