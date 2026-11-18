// 两层评分引擎：把「市场容量与需求」+「竞争格局」的经验阈值变成可计算规则。
//
// 所有阈值集中在下面的 THRESHOLDS，每条标注来源：
//   src: '原文'   —— 框架原文写明的数字
//   src: '已确认' —— 原文未给数字、由 demo 补档，用户已确认沿用
//   src: '自定'   —— 原文未给数字、由 demo 补档，尚未经用户确认
// 改口径只改这一个对象，规则逻辑和测试会跟着走。

const THRESHOLDS = {
  // ---------- 第一层：市场容量与需求 ----------
  searchVolumeMin: {
    value: 10000,
    src: '原文',
    note: '核心词月搜索量「通常应在 1 万以上；过低意味着市场偏小众或正在衰退」',
  },
  growthGood: {
    value: 0.1,
    src: '原文',
    note: '卖家精灵筛选示例「月搜索量 > 100000、月增长率 > 10%」',
  },
  top100Min: {
    value: 600,
    src: '原文',
    note: 'TOP100 月均销量「600—3000 单是相对合理的区间；太低利润空间不足」',
  },
  top100Max: {
    value: 3000,
    src: '原文',
    note: '同上；「太高容易被大卖碾压」',
  },
  newProductsMin: {
    value: 5,
    src: '原文',
    note: '新品数量「不低于 5 个说明市场对新品接纳度较高」',
  },
  newProductShareMin: {
    value: 0.1,
    src: '原文',
    note: '新品占比「低于 10%，说明这个类目对新链接不友好，进去大概率起不来」',
  },
  skewGood: {
    value: 0.6,
    src: '已确认',
    note: '中位数/均值比值，原文只要求「先看中位数而非均值」未给分档；2026-11-18 用户确认沿用',
  },
  skewBad: {
    value: 0.35,
    src: '已确认',
    note: '同上；< 0.35 判为头部拉动型，2026-11-18 用户确认沿用',
  },

  // ---------- 第二层：竞争格局 ----------
  top3BrandVeto: {
    value: 0.4,
    src: '原文',
    note: '前三品牌集中度「超过 40% 的类目，新品进去基本是炮灰，可以直接跳过」',
  },
  top3BrandWarn: {
    value: 0.3,
    src: '已确认',
    note: '原文只给了 40% 一条否决线。保留 30% 缓冲带是因为品牌集中度由工具按「同品牌多链接归属」估算，在估算值上不宜设悬崖边界；2026-11-18 用户确认保留',
  },
  top10SalesBad: {
    value: 0.6,
    src: '原文',
    note: '「如果前 10 个链接吃掉近 6 成销量，这是一个明显的头部效应市场」',
  },
  top10SalesWarn: {
    value: 0.45,
    src: '已确认',
    note: '原文只给了「近 6 成」一条线，45% 是缓冲带；2026-11-18 用户确认沿用',
  },
  reviewsGood: {
    value: 800,
    src: '原文',
    note: '「新手期可以把 Top20 平均评论数不超过 800 作为一条保守的过滤线」',
  },
  reviewsBad: {
    value: 10000,
    src: '原文',
    note: '「数万条评论」= 需巨大投入；「几百至几千条」仍算相对公平，故取 1 万为界',
  },
  clickConcBad: {
    value: 0.6,
    src: '已确认',
    note: '原文只给方向：「点击集中度越高，新品的自然点击空间越窄」未给数字；2026-11-18 用户确认沿用',
  },
  clickConcWarn: {
    value: 0.4,
    src: '已确认',
    note: '同上，40% 是自然位偏紧的缓冲带；2026-11-18 用户确认沿用',
  },
  ratingGood: {
    value: 4.3,
    src: '原文',
    note: '「市场平均评分在 4.3 星以下说明现有产品普遍有改进空间」',
  },
  ratingBad: {
    value: 4.7,
    src: '原文',
    note: '「普遍高于 4.7 星则需要显著创新才能立足」',
  },
};

const T = Object.fromEntries(Object.entries(THRESHOLDS).map(([k, v]) => [k, v.value]));

const RULES = [
  // ---------- 第一层：市场容量与需求 ----------
  {
    id: 'searchVolume',
    layer: 1,
    label: '核心词月搜索量',
    field: 'keywordSearchVolume',
    unit: '次/月',
    threshold: `≥ ${T.searchVolumeMin.toLocaleString('en-US')} 为健康线`,
    thresholdKey: 'searchVolumeMin',
    source: { file: '01-市场容量与需求.md', heading: '核心关键词月搜索量' },
    veto: true,
    evaluate: (m) => {
      const v = m.keywordSearchVolume;
      if (v >= T.searchVolumeMin) return { status: 'pass', value: v, detail: '需求基本盘成立' };
      return { status: 'fail', value: v, detail: '低于 1 万，市场偏小众或正在衰退' };
    },
    advice: '换更宽的核心词重算，或把主词 + 长尾词的总搜索量加总后再判断。',
  },
  {
    id: 'keywordGrowth',
    layer: 1,
    label: '核心词月增长率',
    field: 'keywordGrowthRate',
    unit: '%',
    threshold: `> ${T.growthGood * 100}% 为上升期`,
    thresholdKey: 'growthGood',
    source: { file: '01-市场容量与需求.md', heading: '核心关键词月搜索量' },
    evaluate: (m) => {
      const v = m.keywordGrowthRate * 100;
      if (v > T.growthGood * 100) return { status: 'pass', value: v, detail: '处于上升期' };
      if (v >= 0) return { status: 'warn', value: v, detail: '需求平稳，吃的是存量份额' };
      return { status: 'fail', value: v, detail: '需求在萎缩' };
    },
    advice: '确认增速是否被季节性拉高，用同比而不是环比再看一次。',
  },
  {
    id: 'top100Avg',
    layer: 1,
    label: 'TOP100 月均销量',
    field: 'top100AvgMonthlySales',
    unit: '单/月',
    threshold: `${T.top100Min}—${T.top100Max.toLocaleString('en-US')} 为合理区间`,
    thresholdKeys: ['top100Min', 'top100Max'],
    source: { file: '01-市场容量与需求.md', heading: '类目 TOP100 月均销量' },
    evaluate: (m) => {
      const v = m.top100AvgMonthlySales;
      if (v < T.top100Min) return { status: 'fail', value: v, detail: '低于 600，利润空间不足，扛不住广告与退货' };
      if (v <= T.top100Max) return { status: 'pass', value: v, detail: '落在合理区间' };
      return { status: 'warn', value: v, detail: '高于 3000，容易被大卖碾压，进场成本高' };
    },
    advice: '低于 600 时先看客单价与毛利率，低于区间不代表一定不能做。',
  },
  {
    id: 'capacity',
    layer: 1,
    label: '类目月总容量（前 20 名求和）',
    field: 'top20MonthlySalesSum',
    unit: '单/月',
    threshold: '参考项，需结合客单价看 GMV',
    source: { file: '01-市场容量与需求.md', heading: '类目 TOP100 月均销量' },
    kind: 'info',
    evaluate: (m) => {
      const sum = m.top20MonthlySalesSum;
      const gmv = sum * m.avgPrice;
      return {
        status: 'info',
        value: sum,
        detail: `折合月 GMV 约 $${Math.round(gmv).toLocaleString('en-US')}（客单价 $${m.avgPrice}）`,
      };
    },
  },
  {
    id: 'newProducts',
    layer: 1,
    label: '新品进榜数量与占比',
    field: 'newProducts6m',
    unit: '',
    threshold: `数量 ≥ ${T.newProductsMin} 且占比 ≥ ${T.newProductShareMin * 100}%`,
    thresholdKeys: ['newProductsMin', 'newProductShareMin'],
    source: { file: '01-市场容量与需求.md', heading: '新品进榜数量（新品生存空间）' },
    veto: true,
    evaluate: (m) => {
      const { newProducts6m: n, newProductShare: s } = m;
      const shown = `${n} 个 / ${(s * 100).toFixed(0)}%`;
      if (n >= T.newProductsMin && s >= T.newProductShareMin) {
        return { status: 'pass', value: shown, detail: '格局仍在流动，对新品接纳度高' };
      }
      if (s < T.newProductShareMin) {
        return { status: 'fail', value: shown, detail: `新品占比 ${(s * 100).toFixed(0)}% 低于 10%，类目对新链接不友好` };
      }
      return { status: 'warn', value: shown, detail: `进榜数量 ${n} 个低于 5 个，样本不足以说明格局流动` };
    },
    advice: '交叉验证新品进榜后守不守得住：只撑 1—2 个月的多半是测评或站外冲量。',
  },

  // ---------- 第二层：竞争格局 ----------
  {
    id: 'top3Brand',
    layer: 2,
    label: '前三品牌集中度',
    field: 'top3BrandShare',
    unit: '%',
    threshold: `> ${T.top3BrandVeto * 100}% 直接跳过`,
    thresholdKeys: ['top3BrandVeto', 'top3BrandWarn'],
    source: { file: '02-竞争格局.md', heading: '品牌 / 卖家集中度' },
    veto: true,
    evaluate: (m) => {
      const v = m.top3BrandShare * 100;
      if (v > T.top3BrandVeto * 100) return { status: 'fail', value: v, detail: '品牌锁死，新品进去基本是炮灰' };
      if (v > T.top3BrandWarn * 100) return { status: 'warn', value: v, detail: '集中度偏高，需要明确的差异化理由' };
      return { status: 'pass', value: v, detail: '品牌格局分散' };
    },
    advice: '>40% 时只有显著差异化或显著成本优势能破，否则换细分场景。',
  },
  {
    id: 'top10Sales',
    layer: 2,
    label: 'Top10 销量集中度',
    field: 'top10SalesShare',
    unit: '%',
    threshold: `> ${T.top10SalesBad * 100}% 为头部效应`,
    thresholdKeys: ['top10SalesBad', 'top10SalesWarn'],
    source: { file: '02-竞争格局.md', heading: '品牌 / 卖家集中度' },
    evaluate: (m) => {
      const v = m.top10SalesShare * 100;
      if (v > T.top10SalesBad * 100) return { status: 'fail', value: v, detail: '前 10 个链接吃掉近 6 成销量，头部效应明显' };
      if (v > T.top10SalesWarn * 100) return { status: 'warn', value: v, detail: '头部略重' };
      return { status: 'pass', value: v, detail: '销量分布尚有空间' };
    },
    advice: '头部效应市场不能用普通款、普通图、普通广告指望慢慢磨出来。',
  },
  {
    id: 'reviews',
    layer: 2,
    label: 'Top20 平均评论数',
    field: 'top20AvgReviews',
    unit: '条',
    threshold: `≤ ${T.reviewsGood} 新手可切入，≥ ${T.reviewsBad.toLocaleString('en-US')} 壁垒极高`,
    thresholdKeys: ['reviewsGood', 'reviewsBad'],
    source: { file: '02-竞争格局.md', heading: '头部评论数门槛' },
    evaluate: (m) => {
      const v = m.top20AvgReviews;
      if (v <= T.reviewsGood) return { status: 'pass', value: v, detail: '评论多在几百条，切入机会相对公平' };
      if (v < T.reviewsBad) return { status: 'warn', value: v, detail: '几千条级别，需要一定评论积累，节奏要放长' };
      return { status: 'fail', value: v, detail: '数万条评论级别，需要巨大投入才可能竞争' };
    },
    advice: '评论是时间 + 销量的累积。老类目增速放缓时，反而是评论不再快速堆积的窗口期。',
  },
  {
    id: 'clickConc',
    layer: 2,
    label: '点击集中度（前三 ASIN）',
    field: 'clickConcentration',
    unit: '%',
    threshold: `< ${T.clickConcWarn * 100}% 有自然空间，> ${T.clickConcBad * 100}% 自然位被锁死`,
    thresholdKeys: ['clickConcWarn', 'clickConcBad'],
    source: { file: '02-竞争格局.md', heading: '点击集中度' },
    evaluate: (m) => {
      const v = m.clickConcentration * 100;
      if (v > T.clickConcBad * 100) return { status: 'fail', value: v, detail: '自然点击空间极窄，只能靠广告买位置' };
      if (v > T.clickConcWarn * 100) return { status: 'warn', value: v, detail: '自然位偏紧' };
      return { status: 'pass', value: v, detail: '自然流量分散，长尾词有机会' };
    },
    advice: '点击集中度高叠加头部 CPC 高 = 自然拿不到、付费买不起的双重挤压。',
  },
  {
    id: 'rating',
    layer: 2,
    label: '市场平均评分',
    field: 'avgRating',
    unit: '星',
    threshold: `≤ ${T.ratingGood} 有改进空间，> ${T.ratingBad} 需显著创新`,
    thresholdKeys: ['ratingGood', 'ratingBad'],
    source: { file: '02-竞争格局.md', heading: '评分分布与中位数意识' },
    evaluate: (m) => {
      const v = m.avgRating;
      if (v <= T.ratingGood) return { status: 'pass', value: v, detail: '现有产品普遍有改进空间，差评点就是切入点' };
      if (v <= T.ratingBad) return { status: 'warn', value: v, detail: '改良空间有限' };
      return { status: 'fail', value: v, detail: '用户已普遍满意，需要显著创新才能立足' };
    },
    advice: '把头部 20 个链接的差评按主题聚类，频率最高的 2—3 个主题就是差异化清单。',
  },
  {
    id: 'skew',
    layer: 2,
    label: '中位数 / 均值（分布形态）',
    field: 'medianMonthlySales',
    unit: '单/月',
    threshold: `比值 ≥ ${T.skewGood} 分布均匀，< ${T.skewBad} 为头部拉动型`,
    thresholdKeys: ['skewGood', 'skewBad'],
    source: { file: '02-竞争格局.md', heading: '评分分布与中位数意识' },
    evaluate: (m) => {
      const ratio = m.medianMonthlySales / m.meanMonthlySales;
      const v = `${m.medianMonthlySales} / ${m.meanMonthlySales} = ${ratio.toFixed(2)}`;
      if (ratio >= T.skewGood) return { status: 'pass', value: v, detail: '分布均匀，普通产品也能分到份额' };
      if (ratio >= T.skewBad) return { status: 'warn', value: v, detail: '有一定头部拉动，用中位数做测算' };
      return { status: 'fail', value: v, detail: '典型头部拉动型市场，进场大概率落在中位数档' };
    },
    advice: '用中位数而不是均值估算自己的销量；把差评主题聚类，找最小可行差异化。',
  },
];

const POINTS = { pass: 1, warn: 0.5, fail: 0 };

// 一条规则可能混用多种来源的阈值，按 thresholdKeys 的顺序如实拼接，不假装全是原文
const srcOf = (rule) => {
  const keys = rule.thresholdKeys ?? (rule.thresholdKey ? [rule.thresholdKey] : []);
  const srcs = [...new Set(keys.map((k) => THRESHOLDS[k]?.src).filter(Boolean))];
  if (srcs.length === 0) return null;
  return srcs.join('+');
};

export function listRules() {
  return RULES.map((r) => ({
    id: r.id,
    layer: r.layer,
    label: r.label,
    field: r.field,
    threshold: r.threshold,
    thresholdKeys: r.thresholdKeys ?? (r.thresholdKey ? [r.thresholdKey] : []),
    thresholdSrc: srcOf(r),
    source: r.source,
    veto: Boolean(r.veto),
    kind: r.kind ?? 'score',
  }));
}

export function listThresholds() {
  return Object.entries(THRESHOLDS).map(([key, v]) => ({ key, ...v }));
}

export function scoreMarket(metrics) {
  const results = RULES.map((rule) => {
    const r = rule.evaluate(metrics);
    return {
      id: rule.id,
      layer: rule.layer,
      label: rule.label,
      unit: rule.unit,
      threshold: rule.threshold,
      thresholdSrc: srcOf(rule),
      source: rule.source,
      veto: Boolean(rule.veto),
      kind: rule.kind ?? 'score',
      advice: rule.advice,
      ...r,
    };
  });

  const layerScore = (layer) => {
    const items = results.filter((r) => r.layer === layer && r.kind === 'score');
    const max = items.length;
    const got = items.reduce((s, r) => s + POINTS[r.status], 0);
    return { got: Number(got.toFixed(2)), max, pct: max ? Math.round((got / max) * 100) : 0 };
  };

  const l1 = layerScore(1);
  const l2 = layerScore(2);
  const totalMax = l1.max + l2.max;
  const totalGot = l1.got + l2.got;

  const vetoed = results.filter((r) => r.veto && r.status === 'fail');
  const failed = results.filter((r) => r.kind === 'score' && r.status === 'fail');
  const warned = results.filter((r) => r.kind === 'score' && r.status === 'warn');

  let verdict;
  if (vetoed.length > 0) verdict = 'reject';
  else if (l1.pct < 60) verdict = 'reject';
  else if (l2.pct < 50) verdict = 'risky';
  else if (failed.length > 0 || warned.length >= 3) verdict = 'conditional';
  else verdict = 'go';

  return {
    metrics,
    results,
    layers: { 1: l1, 2: l2 },
    total: { got: Number(totalGot.toFixed(2)), max: totalMax, pct: Math.round((totalGot / totalMax) * 100) },
    verdict,
    vetoed: vetoed.map((r) => ({ id: r.id, label: r.label, detail: r.detail })),
    actions: results.filter((r) => r.status !== 'pass' && r.kind === 'score').map((r) => ({ id: r.id, label: r.label, advice: r.advice })),
  };
}
