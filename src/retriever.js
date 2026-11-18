// 中文友好的 BM25 检索器：零依赖，不需要嵌入模型。
// 分词策略：CJK 连续段切「单字 + 二元组」，拉丁/数字整词保留。
// 单字保证召回（问"评论"能命中"评论数"），二元组保证精度。

const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff';
const CJK_RUN = new RegExp(`[${CJK}]+`, 'g');
const LATIN_RUN = /[a-z0-9][a-z0-9.+#%-]*/g;

// 查询扩展：把口语/缩写映射到知识库里的写法，显著提升命中率
const SYNONYMS = {
  cpc: '广告 点击 成本 出价',
  acos: '广告 成本 销售额 比率',
  bsr: '销量 排名 畅销榜',
  asin: '链接 商品',
  差评: '评分 差评 退货',
  退货: '差评 评分 质量',
  新品: '新链接 新品 进榜',
  新链接: '新品 进榜',
  集中度: '集中度 垄断 占比',
  垄断: '集中度 头部效应',
  搜索量: '搜索量 月搜索量 需求',
  容量: '容量 月均销量 top100',
  利润: '利润 客单价 毛利率',
  广告: '广告 cpc 点击',
  评分: '评分 星级 差评',
  门槛: '门槛 评论数 标准',
  误差: '误差 估算 区间',
  中位数: '中位数 均值 头部拉动',
  工具: '卖家精灵 工具 选市场',
  卖家精灵: '卖家精灵 选市场 关键词选品',
};

export function tokenize(text, { expand = false } = {}) {
  const lower = String(text).toLowerCase();
  const tokens = [];

  for (const run of lower.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]);
      if (i < run.length - 1) tokens.push(run.slice(i, i + 2));
      if (i < run.length - 2) tokens.push(run.slice(i, i + 3));
    }
  }
  for (const word of lower.match(LATIN_RUN) ?? []) tokens.push(word);

  if (expand) {
    for (const [key, extra] of Object.entries(SYNONYMS)) {
      if (lower.includes(key.toLowerCase())) tokens.push(...tokenize(extra));
    }
  }
  return tokens;
}

export class BM25Retriever {
  constructor(chunks, { k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = chunks.map((c) => ({ ...c, tokens: tokenize(c.text) }));
    this.df = new Map();
    for (const doc of this.docs) {
      for (const term of new Set(doc.tokens)) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.tokens.length, 0) / this.docs.length;
  }

  idf(term) {
    const df = this.df.get(term) ?? 0;
    if (df === 0) return 0;
    const n = this.docs.length;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  search(query, topK = 5) {
    const terms = tokenize(query, { expand: true });
    const qTerms = new Set(terms);
    const scored = this.docs.map((doc) => {
      const tf = new Map();
      for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const term of qTerms) {
        const f = tf.get(term);
        if (!f) continue;
        const denom = f + this.k1 * (1 - this.b + (this.b * doc.tokens.length) / this.avgLen);
        score += this.idf(term) * ((f * (this.k1 + 1)) / denom);
      }
      // 长度归一：短 chunk 更聚焦，给一点优势
      return { doc, score: score / Math.sqrt(doc.tokens.length) };
    });

    return scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ doc, score }) => ({
        id: doc.id,
        file: doc.file,
        doc: doc.doc,
        heading: doc.heading,
        body: doc.body,
        score: Number(score.toFixed(3)),
      }));
  }
}
