/* 竹间记 · 竹芯 ZhuXin v2 —— 状态计算机
   核心：把"买法"切成三层（族 → 型 → 状态），每个状态一个唯一标识符、一个信念值；
   开奖后用贝叶斯把信念值往现实拉；每期做一次反思，递归地逼近。

   一条纪律：这里出现的每一个概率，都是先验（偏见）。样本足够时它们都会向基线靠拢。
   —— 这不是功能缺陷，这是这台机器唯一诚实的地方。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(root); }
  else { var api = factory(root); if (root) root.ZhuXin = api; }
})(typeof window !== 'undefined' ? window : this, function (root) {
  'use strict';

  var V = '3.1.1';
  var KEY = {
    states: 'bamboo.v19.zx.states',
    tickets: 'bamboo.v19.zx.tickets',
    issues: 'bamboo.v19.zx.issues',
    logs: 'bamboo.v19.zx.logs',
    cfg: 'bamboo.v19.zx.cfg',
    ai: 'bamboo.v19.zx.ai',
    bt: 'bamboo.v19.zx.bt'
  };
  var LIM = { tickets: 800, logs: 400, issues: 240 };
  var BASE_P = 0.0625;   /* 最低奖级门槛：双色球中蓝球 1/16，任何选法都改不了 */
  var PRIOR_K = 40;      /* 先验强度：相当于 40 次虚拟观测，样本超过它，数据才开始说话 */
  var PER_ISSUE = 3;     /* 每期出 3 注，样本攒得快一点 */
  var BT_W = 0.3;        /* 回放样本的打折系数：参数是今天定的，回放历史必然偏乐观 */
  var BT_MAX = 40;       /* 一次最多回放多少期，跑太久不如分几次 */

  /* ============ 小工具 ============ */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function toInt(x) { var n = Number(x); return isFinite(n) ? Math.round(n) : 0; }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) if (!s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } return o; }
  function sortNum(a) { return a.slice().sort(function (x, y) { return x - y; }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fnv(str) {
    var h = 2166136261, i;
    for (i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pct(x, d) { return (x * 100).toFixed(d == null ? 2 : d) + '%'; }
  function nowISO() { return new Date().toISOString(); }
  function numArr(v) {
    if (Array.isArray(v)) return v.map(toInt).filter(function (n) { return n > 0; });
    return String(v == null ? '' : v).split(/[,\s，、+]+/).map(toInt).filter(function (n) { return n > 0; });
  }

  /* ============ 彩种 ============ */
  var GAMES = {
    ssq: { key: 'ssq', name: '双色球', mainMax: 33, mainCount: 6, subMax: 16, subCount: 1,
      zones: [[1, 11], [12, 22], [23, 33]], subName: '蓝球' },
    dlt: { key: 'dlt', name: '大乐透', mainMax: 35, mainCount: 5, subMax: 12, subCount: 2,
      zones: [[1, 12], [13, 24], [25, 35]], subName: '后区' }
  };
  function gameOf(k) { return GAMES[k] || GAMES.ssq; }

  var PRIMES = { 2: 1, 3: 1, 5: 1, 7: 1, 11: 1, 13: 1, 17: 1, 19: 1, 23: 1, 29: 1, 31: 1 };

  /* ============ 奖级 ============ */
  function judge(gameKey, mine, draw) {
    var hit = 0, i, j;
    for (i = 0; i < mine.main.length; i++)
      for (j = 0; j < draw.main.length; j++)
        if (mine.main[i] === draw.main[j]) hit++;
    var bhit = 0;
    for (i = 0; i < (mine.sub || []).length; i++)
      for (j = 0; j < (draw.sub || []).length; j++)
        if (mine.sub[i] === draw.sub[j]) bhit++;
    var lv = gameKey === 'dlt' ? dltLevel(hit, bhit) : ssqLevel(hit, bhit);
    return {
      h: hit, b: bhit,
      hit: !!lv,
      tier: lv ? lv.tier : 0,
      name: lv ? lv.name : '',
      money: lv ? lv.money : 0,
      text: lv ? (lv.name + (lv.money < 0 ? '（浮动）' : ' · ' + lv.money + ' 元')) : '未中'
    };
  }
  function ssqLevel(h, b) {
    if (h === 6 && b === 1) return { name: '一等奖', money: -1, tier: 1 };
    if (h === 6 && b === 0) return { name: '二等奖', money: -1, tier: 2 };
    if (h === 5 && b === 1) return { name: '三等奖', money: 3000, tier: 3 };
    if (h === 5 && b === 0) return { name: '四等奖', money: 200, tier: 4 };
    if (h === 4 && b === 1) return { name: '四等奖', money: 200, tier: 4 };
    if (h === 4 && b === 0) return { name: '五等奖', money: 10, tier: 5 };
    if (h === 3 && b === 1) return { name: '五等奖', money: 10, tier: 5 };
    if (b === 1) return { name: '六等奖', money: 5, tier: 6 };
    return null;
  }
  function dltLevel(h, b) {
    if (h === 5 && b === 2) return { name: '一等奖', money: -1, tier: 1 };
    if (h === 5 && b === 1) return { name: '二等奖', money: -1, tier: 2 };
    if (h === 5 && b === 0) return { name: '三等奖', money: 10000, tier: 3 };
    if (h === 4 && b === 2) return { name: '四等奖', money: 3000, tier: 4 };
    if (h === 4 && b === 1) return { name: '五等奖', money: 300, tier: 5 };
    if (h === 3 && b === 2) return { name: '六等奖', money: 200, tier: 6 };
    if (h === 4 && b === 0) return { name: '七等奖', money: 100, tier: 7 };
    if (h === 3 && b === 1) return { name: '八等奖', money: 15, tier: 8 };
    if (h === 2 && b === 2) return { name: '八等奖', money: 15, tier: 8 };
    if (h === 3 && b === 0) return { name: '九等奖', money: 5, tier: 9 };
    if (h === 1 && b === 2) return { name: '九等奖', money: 5, tier: 9 };
    if (h === 2 && b === 1) return { name: '九等奖', money: 5, tier: 9 };
    if (h === 0 && b === 2) return { name: '九等奖', money: 5, tier: 9 };
    return null;
  }

  /* ============ Beta 分布：信念的唯一度量 ============ */
  function logGamma(x) {
    var cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    var y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    var ser = 1.000000000190015;
    for (var j = 0; j < 6; j++) ser += cof[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
  function betacf(a, b, x) {
    var MAXIT = 200, EPS = 3e-12, FPMIN = 1e-30;
    var qab = a + b, qap = a + 1, qam = a - 1;
    var c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    var h = d, m, m2, aa, del;
    for (m = 1; m <= MAXIT; m++) {
      m2 = 2 * m;
      aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  function betaInc(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) +
      a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
    return 1 - bt * betacf(b, a, 1 - x) / b;
  }
  function betaInv(a, b, q) {
    var lo = 0, hi = 1, i, mid;
    for (i = 0; i < 64; i++) {
      mid = (lo + hi) / 2;
      if (betaInc(a, b, mid) < q) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  function betaMean(a, b) { return a / (a + b); }
  function betaSd(a, b) { return Math.sqrt(a * b / ((a + b) * (a + b) * (a + b + 1))); }
  function betaDraw(a, b, rng) {
    var g1 = gammaDraw(a, rng), g2 = gammaDraw(b, rng);
    if (g1 + g2 <= 0) return a / (a + b);
    return g1 / (g1 + g2);
  }
  function gammaDraw(k, rng) {
    if (k < 1) return gammaDraw(k + 1, rng) * Math.pow(rng(), 1 / k);
    var d = k - 1 / 3, c = 1 / Math.sqrt(9 * d), x, v, u;
    for (var i = 0; i < 50; i++) {
      do { x = gauss(rng); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      u = rng();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
    return d;
  }
  function gauss(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ============ 状态目录：族 → 型 → 状态 ============ */
  var FAMILY = {
    'F.RAND': '随机族', 'F.EVEN': '均衡族', 'F.SUM': '和值族', 'F.SPAN': '跨度族',
    'F.LIAN': '连号族', 'F.REP': '重号族', 'F.COLD': '冷号族', 'F.HOT': '热号族',
    'F.ZONE': '区间族', 'F.TAIL': '尾数族', 'F.PRIME': '质合族', 'F.SEQ': '图形族',
    'F.MIX': '复合族'
  };

  /* [id, 名字, 族, 型, 规则, 参数, 先验, 为什么是这个先验] */
  var CAT_RAW = [
    ['S.RAND.PURE', '纯机选', 'F.RAND', 'T.RAND', '完全随机，不施加任何约束', {}, 0.0625,
      '基线。别的买法跟它比没有优势，就等于白做。'],
    ['S.RAND.SEED', '定种机选', 'F.RAND', 'T.RAND', '固定种子，同一期永远同一注', { fixed: 1 }, 0.0625,
      '和纯机选唯一的区别是可复现。用来证明随机也能被记账。'],

    ['S.EVEN.222.O3', '三区均摊·奇3', 'F.EVEN', 'T.EVEN.222', '三区 2:2:2，奇偶 3:3', { zone: [2, 2, 2], oddMin: 3, oddMax: 3 }, 0.066,
      '覆盖最广，但每期都有一大票人这么买。'],
    ['S.EVEN.222.O4', '三区均摊·奇4', 'F.EVEN', 'T.EVEN.222', '三区 2:2:2，奇数 4 个', { zone: [2, 2, 2], oddMin: 4 }, 0.062,
      '偏奇一点，覆盖略窄。'],
    ['S.EVEN.222.O2', '三区均摊·偶4', 'F.EVEN', 'T.EVEN.222', '三区 2:2:2，奇数 2 个', { zone: [2, 2, 2], oddMax: 2 }, 0.058,
      '偏偶一点，同理。'],
    ['S.EVEN.132.O3', '前轻后重·1:3:2', 'F.EVEN', 'T.EVEN.132', '三区 1:3:2，奇偶 3:3', { zone: [1, 3, 2], oddMin: 3, oddMax: 3 }, 0.06,
      '把重心压在中间区，中间区号最多，天然如此。'],
    ['S.EVEN.231.O3', '中后重·2:3:1', 'F.EVEN', 'T.EVEN.231', '三区 2:3:1，奇偶 3:3', { zone: [2, 3, 1], oddMin: 3, oddMax: 3 }, 0.061,
      '中区多吃，尾区让位。'],
    ['S.EVEN.123.O3', '后重·1:2:3', 'F.EVEN', 'T.EVEN.123', '三区 1:2:3，奇偶 3:3', { zone: [1, 2, 3], oddMin: 3, oddMax: 3 }, 0.059,
      '重仓大号区，和值自然偏高。'],
    ['S.EVEN.141.O3', '中区独大·1:4:1', 'F.EVEN', 'T.EVEN.141', '三区 1:4:1，奇偶 3:3', { zone: [1, 4, 1], oddMin: 3, oddMax: 3 }, 0.052,
      '四号挤在中间，形态很特殊，所以我给得低一点。'],
    ['S.EVEN.312.O4', '前重·3:1:2', 'F.EVEN', 'T.EVEN.312', '三区 3:1:2，奇数 4 个', { zone: [3, 1, 2], oddMin: 4 }, 0.055,
      '重仓小号加偏奇，两个偏见叠一起。'],

    ['S.SUM.LT85', '低和值 <85', 'F.SUM', 'T.SUM.LOW', '和值压在 85 以下', { sumHi: 84 }, 0.042,
      '号码整体偏小，覆盖的形态太窄，我先打个折。'],
    ['S.SUM.85.100', '偏低和 85-100', 'F.SUM', 'T.SUM.LOWMID', '和值落在 85-100', { sumLo: 85, sumHi: 100 }, 0.056,
      '偏低但不极端，是最常见的区间之一。'],
    ['S.SUM.100.115', '中段和 100-115', 'F.SUM', 'T.SUM.MID', '和值落在 100-115', { sumLo: 100, sumHi: 115 }, 0.068,
      '历史上中段和值出现最多，这是最"正"的一档。'],
    ['S.SUM.115.130', '偏高和 115-130', 'F.SUM', 'T.SUM.HIMID', '和值落在 115-130', { sumLo: 115, sumHi: 130 }, 0.058,
      '偏高一点，还算常见。'],
    ['S.SUM.GT130', '高和值 >130', 'F.SUM', 'T.SUM.HIGH', '和值顶到 130 以上', { sumLo: 131 }, 0.04,
      '大号扎堆，形态很窄，我不太信。'],
    ['S.SUM.MID.O4', '中段和·奇4', 'F.SUM', 'T.SUM.MID', '和值 100-115，奇数 4 个', { sumLo: 100, sumHi: 115, oddMin: 4 }, 0.06,
      '两个都还行的条件叠一起，等于加了约束。'],
    ['S.SUM.MID.O2', '中段和·偶4', 'F.SUM', 'T.SUM.MID', '和值 100-115，奇数 2 个', { sumLo: 100, sumHi: 115, oddMax: 2 }, 0.057,
      '同上，方向相反。'],
    ['S.SUM.LOW.O4', '偏低和·奇4', 'F.SUM', 'T.SUM.LOWMID', '和值 85-100，奇数 4 个', { sumLo: 85, sumHi: 100, oddMin: 4 }, 0.05,
      '低和值还偏奇，约束叠了两层。'],

    ['S.SPAN.S', '小跨 <22', 'F.SPAN', 'T.SPAN', '首尾差小于 22', { spanHi: 21 }, 0.05,
      '号码挤在一头，形态少见。'],
    ['S.SPAN.M', '中跨 22-28', 'F.SPAN', 'T.SPAN', '首尾差 22-28', { spanLo: 22, spanHi: 28 }, 0.07,
      '最常见的跨度区间，我给最高。'],
    ['S.SPAN.L', '大跨 28-32', 'F.SPAN', 'T.SPAN', '首尾差 28-32', { spanLo: 28, spanHi: 32 }, 0.062,
      '一头一尾拉开，也常见。'],
    ['S.SPAN.XL', '满跨 32', 'F.SPAN', 'T.SPAN', '必须包含 1 和 33', { spanLo: 32 }, 0.038,
      '卡死在两端，只有一种开局，太窄了。'],

    ['S.LIAN.2.HEAD', '两连·头区', 'F.LIAN', 'T.LIAN.2', '01-11 内出一组两连', { consecLen: 2, consecZone: 'head', consecMin: 1 }, 0.066,
      '连号整体出现率过半，头区占三分之一。'],
    ['S.LIAN.2.MID', '两连·中区', 'F.LIAN', 'T.LIAN.2', '12-22 内出一组两连', { consecLen: 2, consecZone: 'mid', consecMin: 1 }, 0.068,
      '中间区号码最密，连号也最多。'],
    ['S.LIAN.2.TAIL', '两连·尾区', 'F.LIAN', 'T.LIAN.2', '23-33 内出一组两连', { consecLen: 2, consecZone: 'tail', consecMin: 1 }, 0.064,
      '尾区稍窄，给得略低。'],
    ['S.LIAN.3.HEAD', '三连·头区', 'F.LIAN', 'T.LIAN.3', '01-11 内出一组三连', { consecLen: 3, consecZone: 'head', consecMin: 1 }, 0.04,
      '三连本来就少，再锁头区更少。'],
    ['S.LIAN.3.MID', '三连·中区', 'F.LIAN', 'T.LIAN.3', '12-22 内出一组三连', { consecLen: 3, consecZone: 'mid', consecMin: 1 }, 0.044,
      '三连里最有机会的一档。'],
    ['S.LIAN.3.TAIL', '三连·尾区', 'F.LIAN', 'T.LIAN.3', '23-33 内出一组三连', { consecLen: 3, consecZone: 'tail', consecMin: 1 }, 0.038,
      '最难的一档，我明说不看好。'],

    ['S.REP.1.BIG', '保1个·大号', 'F.REP', 'T.REP.1', '保留上期 1 个偏大的号', { keepN: 1, keepSide: 'big' }, 0.07,
      '重号每期平均一个上下，这是有据可依的少数几个判断之一。'],
    ['S.REP.1.SMALL', '保1个·小号', 'F.REP', 'T.REP.1', '保留上期 1 个偏小的号', { keepN: 1, keepSide: 'small' }, 0.07,
      '同上，方向换到小号。'],
    ['S.REP.2.BIG', '保2个·大号', 'F.REP', 'T.REP.2', '保留上期 2 个偏大的号', { keepN: 2, keepSide: 'big' }, 0.056,
      '两个都保，就有点赌上期的形状会延续。'],
    ['S.REP.2.SMALL', '保2个·小号', 'F.REP', 'T.REP.2', '保留上期 2 个偏小的号', { keepN: 2, keepSide: 'small' }, 0.054,
      '同上。'],
    ['S.REP.2.ADJ', '保2个·相邻', 'F.REP', 'T.REP.2', '保留上期一对相邻号', { keepN: 2, keepAdj: 1 }, 0.045,
      '要求两个还挨着，条件太苛刻。'],
    ['S.REP.3.MIX', '保3个', 'F.REP', 'T.REP.3', '保留上期 3 个号', { keepN: 3 }, 0.038,
      '三期连号概率很低，我知道这个先验会挨打。'],

    ['S.COLD.1.MAX', '冷号1个·最久', 'F.COLD', 'T.COLD.MAX', '取遗漏最久的 1 个号', { coldN: 1 }, 0.052,
      '赌徒谬误的典型：遗漏久不代表会出。我先给个中低分，等着被证伪。'],
    ['S.COLD.2.MAX', '冷号2个·最久', 'F.COLD', 'T.COLD.MAX', '取遗漏最久的 2 个号', { coldN: 2 }, 0.046,
      '两个都在赌同一件事，风险翻倍。'],
    ['S.COLD.3.MAX', '冷号3个·最久', 'F.COLD', 'T.COLD.MAX', '取遗漏最久的 3 个号', { coldN: 3 }, 0.04,
      '三个一起赌，我最不看好的之一。'],
    ['S.COLD.2.HIGH', '冷号2个·次冷', 'F.COLD', 'T.COLD.HIGH', '取遗漏 8-15 期的 2 个号', { coldHigh: 2 }, 0.05,
      '不追最冷的，取次冷，稍微讲点道理。'],

    ['S.HOT.1', '热号1个', 'F.HOT', 'T.HOT.MAX', '取近 30 期出现最多的 1 个号', { hotN: 1 }, 0.068,
      '热号是趋势外推，跟冷号是同一枚硬币的两面。'],
    ['S.HOT.2', '热号2个', 'F.HOT', 'T.HOT.MAX', '取近 30 期出现最多的 2 个号', { hotN: 2 }, 0.062,
      '两个都追热，形状会很集中。'],
    ['S.HOT.3', '热号3个', 'F.HOT', 'T.HOT.MAX', '取近 30 期出现最多的 3 个号', { hotN: 3 }, 0.052,
      '三个热号堆一起，和值容易失控。'],
    ['S.HOT.2.WARM', '温热2个', 'F.HOT', 'T.HOT.WARM', '取频次排 4-8 名的 2 个号', { hotWarm: 2 }, 0.058,
      '不追最热的，取温的，算折中。'],

    ['S.ZONE.114', '极端·1:1:4', 'F.ZONE', 'T.ZONE', '三区 1:1:4，尾区四连', { zone: [1, 1, 4] }, 0.042,
      '四号挤在尾区，形态极窄。'],
    ['S.ZONE.411', '极端·4:1:1', 'F.ZONE', 'T.ZONE', '三区 4:1:1，头区四连', { zone: [4, 1, 1] }, 0.042,
      '同上，方向相反。'],
    ['S.ZONE.141', '极端·1:4:1', 'F.ZONE', 'T.ZONE', '三区 1:4:1，中区四连', { zone: [1, 4, 1] }, 0.044,
      '中间区号多，四连比两端稍容易。'],
    ['S.ZONE.033', '两极·0:3:3', 'F.ZONE', 'T.ZONE', '三区 0:3:3，前区空', { zone: [0, 3, 3] }, 0.038,
      '完全放弃前区，我不太信。'],
    ['S.ZONE.330', '两极·3:3:0', 'F.ZONE', 'T.ZONE', '三区 3:3:0，尾区空', { zone: [3, 3, 0] }, 0.038,
      '同上。'],

    ['S.TAIL.SAME2', '一对同尾', 'F.TAIL', 'T.TAIL', '至少两个号尾数相同', { tailSame: 2 }, 0.066,
      '同尾很常见，六个数分十个尾，撞车是必然。'],
    ['S.TAIL.SAME3', '三同尾', 'F.TAIL', 'T.TAIL', '至少三个号尾数相同', { tailSame: 3 }, 0.038,
      '三个撞同一个尾，概率掉得厉害。'],
    ['S.TAIL.SCAT', '六尾全散', 'F.TAIL', 'T.TAIL', '六个号尾数各不相同', { tailScat: 1 }, 0.058,
      '全散是"整齐"的一种，人容易觉得好看。'],
    ['S.TAIL.BIG', '大尾为主', 'F.TAIL', 'T.TAIL', '尾数 ≥5 的至少 4 个', { tailBig: 1 }, 0.055,
      '大尾多意味着尾段号多，和值偏高。'],
    ['S.TAIL.SMALL', '小尾为主', 'F.TAIL', 'T.TAIL', '尾数 <5 的至少 4 个', { tailSmall: 1 }, 0.055,
      '同上，方向相反。'],

    ['S.PRIME.1', '质数1个', 'F.PRIME', 'T.PRIME', '质数恰好 1 个', { primeMin: 1, primeMax: 1 }, 0.052,
      '33 里有 11 个质数，只出一个偏少。'],
    ['S.PRIME.2', '质数2个', 'F.PRIME', 'T.PRIME', '质数恰好 2 个', { primeMin: 2, primeMax: 2 }, 0.068,
      '两个质数最接近自然比例。'],
    ['S.PRIME.3', '质数3个', 'F.PRIME', 'T.PRIME', '质数恰好 3 个', { primeMin: 3, primeMax: 3 }, 0.06,
      '三个也常见，略过一点。'],
    ['S.PRIME.4', '质数4个+', 'F.PRIME', 'T.PRIME', '质数至少 4 个', { primeMin: 4 }, 0.038,
      '质数扎堆，形态窄。'],

    ['S.SEQ.ARITH', '等差数列', 'F.SEQ', 'T.SEQ', '六个号构成等差', { arith: 1 }, 0.028,
      '人眼爱看图形，但图形在随机里最不该出现。我给最低。'],
    ['S.SEQ.STEP5', '斜连·步长5', 'F.SEQ', 'T.SEQ', '按固定步长 5 取号', { step: 5 }, 0.03,
      '走势图上的斜线，是最经典的自我欺骗。'],
    ['S.SEQ.MIRROR', '镜像对', 'F.SEQ', 'T.SEQ', '至少含一组 n 与 34-n', { mirror: 1 }, 0.036,
      '对称是一种美感，不是概率。'],
    ['S.SEQ.PARITY', '全奇或全偶', 'F.SEQ', 'T.SEQ', '六个号奇偶一致', { sameParity: 1 }, 0.03,
      '极端形态，我几乎不信。'],

    ['S.MIX.LIAN2.SUM', '两连+中段和', 'F.MIX', 'T.MIX', '带一组两连，和值 95-120', { consecLen: 2, consecMin: 1, sumLo: 95, sumHi: 120 }, 0.058,
      '两个都还行的条件叠一起，覆盖面被切掉一块。'],
    ['S.MIX.REP1.LOW', '保1个+低和', 'F.MIX', 'T.MIX', '保留上期 1 个，和值 ≤105', { keepN: 1, sumHi: 105 }, 0.056,
      '承接上期又压和值，两个方向互相拉扯。'],
    ['S.MIX.COLD2.EVEN', '冷2个+三区均', 'F.MIX', 'T.MIX', '取两个最冷号，三区 2:2:2', { coldN: 2, zone: [2, 2, 2] }, 0.044,
      '冷号要塞进均摊的骨架里，常常打架。'],
    ['S.MIX.HOT2.SPS', '热2个+小跨', 'F.MIX', 'T.MIX', '取两个热号，跨度 ≤24', { hotN: 2, spanHi: 24 }, 0.05,
      '热号通常散，硬压跨度会打架。'],
    ['S.MIX.PRIME3.SPAN', '质3个+大跨', 'F.MIX', 'T.MIX', '三个质数，跨度 ≥25', { primeMin: 3, spanLo: 25 }, 0.046,
      '质数就那几个，还要拉开，很受限。'],
    ['S.MIX.TAIL2.ZONE', '同尾+三区均', 'F.MIX', 'T.MIX', '一对同尾，三区 2:2:2', { tailSame: 2, zone: [2, 2, 2] }, 0.06,
      '同尾和三区均摊相容度还行，给得稍高。'],
    ['S.MIX.EVEN.COLD', '三区均+冷1个', 'F.MIX', 'T.MIX', '三区 2:2:2，含一个最冷号', { zone: [2, 2, 2], coldN: 1 }, 0.052,
      '在均摊骨架上塞一个冷号，克制版追冷。'],
    ['S.MIX.SUM.HOT', '中段和+热2个', 'F.MIX', 'T.MIX', '和值 100-115，含两个热号', { sumLo: 100, sumHi: 115, hotN: 2 }, 0.062,
      '中段和值本来就最正，加热号算顺着来。']
  ];

  var TYPE_NAME = {
    'T.RAND': '纯随机',
    'T.EVEN.222': '三区 2:2:2', 'T.EVEN.132': '三区 1:3:2', 'T.EVEN.231': '三区 2:3:1',
    'T.EVEN.123': '三区 1:2:3', 'T.EVEN.141': '三区 1:4:1', 'T.EVEN.312': '三区 3:1:2',
    'T.SUM.LOW': '和值 <85', 'T.SUM.LOWMID': '和值 85-100', 'T.SUM.MID': '和值 100-115',
    'T.SUM.HIMID': '和值 115-130', 'T.SUM.HIGH': '和值 >130',
    'T.SPAN': '跨度', 'T.LIAN.2': '两连', 'T.LIAN.3': '三连',
    'T.REP.1': '保 1 个', 'T.REP.2': '保 2 个', 'T.REP.3': '保 3 个',
    'T.COLD.MAX': '取最冷', 'T.COLD.HIGH': '取次冷',
    'T.HOT.MAX': '取最热', 'T.HOT.WARM': '取温热',
    'T.ZONE': '极端区间', 'T.TAIL': '尾数分布', 'T.PRIME': '质数个数',
    'T.SEQ': '图形', 'T.MIX': '两个约束叠加'
  };

  var CATALOG = CAT_RAW.map(function (r) {
    return {
      id: r[0], name: r[1], family: r[2], familyName: FAMILY[r[2]] || r[2],
      type: r[3], rule: r[4], params: r[5] || {}, prior: r[6], why: r[7]
    };
  });
  var CAT_MAP = {};
  CATALOG.forEach(function (s) { CAT_MAP[s.id] = s; });

  function resetCatalog() {
    CATALOG.length = CAT_RAW.length;
    CAT_MAP = {};
    CATALOG.forEach(function (s) { CAT_MAP[s.id] = s; });
  }

  function families() {
    var seen = {}, out = [];
    CATALOG.forEach(function (s) {
      if (!seen[s.family]) {
        seen[s.family] = { id: s.family, name: s.familyName, types: [], count: 0 };
        out.push(seen[s.family]);
      }
      var f = seen[s.family];
      f.count++;
      var t = null;
      for (var i = 0; i < f.types.length; i++) if (f.types[i].id === s.type) t = f.types[i];
      if (!t) { t = { id: s.type, states: [] }; f.types.push(t); }
      t.states.push(s.id);
    });
    return out;
  }

  /* ==================================================================
     AI 层
     边界：AI 提假设、查事实，本机做验证、算账、判决。
     模型说错一个号码，会被范围校验拦下；说错一个概率，会被样本数压住。
     ================================================================== */
  var KEYAI = KEY.ai;
  var PROP_MAX = 12;

  function readAI() {
    var a = lsGet(KEYAI, null);
    if (!a || typeof a !== 'object') a = {};
    if (!a.bias || typeof a.bias !== 'object') a.bias = {};
    if (!a.logs) a.logs = [];
    if (!a.props) a.props = [];
    return a;
  }
  function writeAI(a) { return lsSet(KEYAI, a); }

  function aiOn() {
    var o = root.__zxOpts;
    if (!o || typeof o.aiChat !== 'function') return false;
    /* 光有函数不算接上，得真的填了接口和 Key */
    if (typeof o.aiReady === 'function') return !!o.aiReady();
    return true;
  }
  function aiAsk(prompt, opts) {
    if (!aiOn()) return Promise.reject(new Error('这台上没有配置 AI'));
    return root.__zxOpts.aiChat(prompt, 0.25, opts || {});
  }

  /* ---------- 解析模型回复 ----------
     现实里模型不总听话：带讲解、带 ``` 围栏、把号码写成 03、用中文引号、
     末尾多个逗号，或者干脆回一段人话。旧实现遇到这些就"没读懂"，
     更糟的是会捡到 __WEB_REFS__ 里的搜索结果数组、或 main 子数组当答案。
     所以这里分三步：
       1) 剥掉我们自己追加的 __WEB_REFS__（那是传输层元数据，不是答案）
       2) 收集所有能 parse 的候选，按用途打分（找对象 / 找数组）
       3) 一个对象都没有时，交给 scanDraw 从人话里认号码 */
  function stripMeta(s) {
    return String(s == null ? '' : s).split('__WEB_REFS__')[0];
  }

  /* 只在 parse 失败后动刀，且只修结构性毛病，不改语义 */
  function repairJSON(t) {
    return String(t)
      .replace(/[\u201c\u201d\u201e]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/：/g, ':').replace(/，/g, ',').replace(/【/g, '[').replace(/】/g, ']')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([\[,]\s*)0+(\d)/g, '$1$2')
      .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
  }
  function parseLoose(str) {
    var s = String(str == null ? '' : str).trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (e) { }
    try { return JSON.parse(repairJSON(s)); } catch (e) { }
    return null;
  }

  /* mode: 'obj' 只收对象 | 'arr' 只收数组 | 不传则都收 */
  function pickJSON(text, mode) {
    var s = stripMeta(text);
    if (!s) return null;

    var cands = [], seen = {};
    function push(v) {
      if (!v || typeof v !== 'object') return;
      if (mode === 'obj' && Array.isArray(v)) return;
      if (mode === 'arr' && !Array.isArray(v)) return;
      var k = JSON.stringify(v);
      if (seen[k]) return;
      seen[k] = 1;
      cands.push(v);
    }

    /* 代码围栏优先：模型把答案放围栏里，围栏外多半是废话 */
    var fr = /```[a-zA-Z]*\s*([\s\S]*?)```/g, fm;
    while ((fm = fr.exec(s))) push(parseLoose(fm[1]));
    push(parseLoose(s));

    /* 再扫全文的 { } 和 [ ] 片段 */
    ['{', '['].forEach(function (open) {
      var close = open === '{' ? '}' : ']';
      for (var i = 0; i < s.length; i++) {
        if (s.charAt(i) !== open) continue;
        var depth = 0, inStr = false, escd = false;
        for (var j = i; j < s.length; j++) {
          var ch = s.charAt(j);
          if (inStr) {
            if (escd) escd = false;
            else if (ch === '\\') escd = true;
            else if (ch === '"') inStr = false;
            continue;
          }
          if (ch === '"') { inStr = true; continue; }
          if (ch === open) depth++;
          else if (ch === close) {
            depth--;
            if (depth === 0) { push(parseLoose(s.slice(i, j + 1))); break; }
          }
        }
      }
    });
    if (!cands.length) return null;

    /* 打分：先看用途，再看关键字段，最后才看体量。
       这一步就是旧版翻车的地方——main 子数组和 refs 数组都不能算答案。 */
    function score(v) {
      var arr = Array.isArray(v), sc = 0;
      if (mode === 'obj') sc += arr ? -500 : 100;
      if (mode === 'arr') sc += arr ? 100 : -500;
      if (!arr) {
        if (typeof v.found !== 'undefined') sc += 140;
        if (v.main || v.sub) sc += 60;
        if (v.bias || v.families || v.proposals || v.states) sc += 80;
      } else if (v.length && typeof v[0] === 'object' && !Array.isArray(v[0])) {
        sc += 40;
      }
      sc += Math.min(24, JSON.stringify(v).length / 60);
      return sc;
    }
    var best = null, bestS = -Infinity;
    cands.forEach(function (v) { var sc = score(v); if (sc > bestS) { bestS = sc; best = v; } });
    return best;
  }

  /* 模型有时把数组包一层：{"states":[...]} / {"proposals":[...]}。
     名字不止一种，按常见顺序找一遍，找不到才认它没给。 */
  var ARR_KEYS = ['states', 'proposals', 'items', 'list', 'result', 'data', 'bias', 'watch'];
  function arrOf(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      for (var i = 0; i < ARR_KEYS.length; i++) {
        if (Array.isArray(v[ARR_KEYS[i]])) return v[ARR_KEYS[i]];
      }
    }
    return [];
  }

  /* 最后一层：模型不给 JSON 时，从人话里认号码。
     开奖号码有强格式——一串严格递增、互不重复、落在范围内的整数。
     日期、期号、链接先剔掉，免得把 11 月 5 日认成红球。
     两道闸门防"认错期"：
       · 正文出现"还没开奖 / 未公布"，直接放弃；
       · 正文提到的期号全都不是要查的那期，也放弃。
     认出来也不等于对，UI 会标明"从原话里认的，请核对"。 */
  function drawGate(s, wantIssue) {
    /* 闸门一：它自己都说没开，就别从别处捡号 */
    if (/(还没|尚未|暂未|未曾|没有|未)[^。；\n]{0,6}(开奖|公布|开出|结果)/.test(s) ||
        /(没查到|查不到|没有找到|未能找到)/.test(s)) return '这期还没开奖，或资料里没有';
    /* 闸门二：通篇在说别的期 */
    if (wantIssue) {
      var tail = String(toInt(wantIssue)).slice(-5);
      var said = s.match(/\d{5,7}(?=\s*期)/g) || [];
      if (said.length && !said.some(function (x) { return String(toInt(x)).slice(-5) === tail; })) {
        return '它只查到别的期';
      }
    }
    return '';
  }

  function scanDraw(text, g, wantIssue) {
    var s = stripMeta(text);
    if (drawGate(s, wantIssue)) return null;
    s = s
      .replace(/https?:\/\/[^\s)）】,，]+/g, ' ')
      .replace(/\d{4}\s*[-\/年.]\s*\d{1,2}\s*[-\/月.]\s*\d{1,2}\s*[日号]?/g, ' ')
      .replace(/第?\s*\d{5,7}\s*期/g, ' ');
    var toks = s.match(/\d+/g) || [], seq = [], i;
    for (i = 0; i < toks.length; i++) if (toks[i].length <= 2) seq.push(parseInt(toks[i], 10));

    var best = [], cur = [], bestEnd = 0;
    for (var k = 0; k <= seq.length; k++) {
      var v = seq[k];
      if (k < seq.length && v >= 1 && v <= g.mainMax && (!cur.length || v > cur[cur.length - 1])) {
        cur.push(v);
        continue;
      }
      if (cur.length > best.length) { best = cur; bestEnd = k; }
      cur = (k < seq.length && v >= 1 && v <= g.mainMax) ? [v] : [];
    }
    if (best.length < g.mainCount) return null;

    var main = best.slice(0, g.mainCount), sub = [];
    /* 号码可能连成一串（小主号 + 大蓝球），多出来的先当蓝球看 */
    for (i = g.mainCount; i < best.length && sub.length < g.subCount; i++) {
      if (best[i] <= g.subMax && main.indexOf(best[i]) < 0 && sub.indexOf(best[i]) < 0) sub.push(best[i]);
    }
    for (var q = bestEnd; q < seq.length && sub.length < g.subCount; q++) {
      var w = seq[q];
      if (w >= 1 && w <= g.subMax && main.indexOf(w) < 0 && sub.indexOf(w) < 0) sub.push(w);
    }
    if (sub.length < g.subCount) return null;
    return { main: main, sub: sub };
  }

  /* ---------- 偏见乘子：AI 的话只能撬动 ±18% ---------- */
  function biasMul(familyId) {
    var v = readAI().bias[familyId];
    if (!v) return 1;
    return clamp(1 + 0.18 * clamp(Number(v) || 0, -1, 1), 0.82, 1.18);
  }
  /* 每两期减半：说对了影响留两期，说错了八期左右归零 */
  function decayBias() {
    var a = readAI();
    a.turns = (a.turns || 0) + 1;
    if (a.turns % 2 === 0) {
      Object.keys(a.bias).forEach(function (k) {
        a.bias[k] = Number(a.bias[k]) * 0.5;
        if (Math.abs(a.bias[k]) < 0.06) delete a.bias[k];
      });
    }
    writeAI(a);
    return Object.keys(a.bias).length;
  }

  /* ---------- 接入点一：联网查开奖 ---------- */
  function aiDraw(gameKey, issue) {
    var g = gameOf(gameKey);
    var q = g.name + ' 第' + issue + '期 开奖结果 开奖号码';
    var want = [
      '只输出一个 JSON 对象：不要解释，不要 markdown 代码块。',
      '{"found":true,"issue":"期号","date":"YYYY-MM-DD","main":[...],"sub":[...],"source":"来源网址"}',
      g.key === 'ssq'
        ? 'main 必须是 6 个 1-33 的整数，sub 必须是 1 个 1-16 的整数。'
        : 'main 必须是 5 个 1-35 的整数，sub 必须是 2 个 1-12 的整数。',
      '号码必须是 JSON 整数，不要字符串，不要前导零，不要混日期。',
      '资料里没有第 ' + issue + ' 期，就输出 {"found":false,"reason":"还没开奖"} 或 {"found":false,"reason":"没查到"}。',
      '绝对不要拿别的期的号码来顶，也不要凭记忆猜。'
    ].join('\n');

    return aiAsk('请从资料里找出「' + g.name + '」第 ' + issue + ' 期的开奖号码。', {
      webSearch: true,
      query: q,
      lead: '以下是刚刚联网搜到的真实资料。只依据这些资料作答，不要凭记忆补，也不要编号码：\n',
      hint: want, maxTokens: 900
    }).then(function (text) {
      var raw = stripMeta(text).replace(/\s+/g, ' ').trim().slice(0, 600);
      var j = pickJSON(text, 'obj');

      function wellFormed(main, sub) {
        return main.length === g.mainCount && sub.length === g.subCount &&
          uniq(main).length === main.length && uniq(sub).length === sub.length &&
          main.every(function (x) { return x >= 1 && x <= g.mainMax; }) &&
          sub.every(function (x) { return x >= 1 && x <= g.subMax; });
      }

      /* 模型明说没查到：尊重它，不要顺手从正文里认一组号来顶 */
      if (j) {
        var f = j.found;
        if (f === false || f === 'false' || f === 0 || f === '0') {
          return { ok: false, msg: (j.reason ? String(j.reason).slice(0, 24) : '没查到'), raw: raw };
        }
      }

      var main = j ? numArr(j.main).slice(0, g.mainCount) : [];
      var sub = j ? numArr(j.sub).slice(0, g.subCount) : [];
      var guessed = false;
      if (!wellFormed(main, sub)) {
        /* 模型没给 JSON，或 JSON 里的号码不成形——从原话里认 */
        var sc = scanDraw(text, g, issue);
        if (sc && wellFormed(sc.main, sc.sub)) {
          main = sc.main; sub = sc.sub; guessed = true;
        }
      }
      if (!wellFormed(main, sub)) {
        var why = drawGate(stripMeta(text), issue);
        return {
          ok: false,
          msg: why || (j ? '查到的号码不成形' : '没读懂 AI 的回复'),
          raw: raw
        };
      }

      var refs = [];
      var m = String(text).match(/__WEB_REFS__(\[[\s\S]*\])/);
      if (m) { try { refs = JSON.parse(m[1]).slice(0, 3); } catch (e) { refs = []; } }
      return {
        ok: true, issue: String((j && j.issue) || issue).slice(0, 12),
        date: String((j && j.date) || '').slice(0, 10),
        main: sortNum(main), sub: sortNum(sub),
        source: String((j && j.source) || '').slice(0, 120),
        refs: refs, guessed: guessed, raw: raw
      };
    });
  }

  /* ---------- 接入点二：AI 读账，提出偏见 ---------- */
  function aiDigest(limit) {
    var states = readStates(), logs = readLogs().slice(0, limit || 16);
    var lines = ['最近 ' + logs.length + ' 期记录：'];
    logs.forEach(function (g) {
      var tks = [];
      (g.items || []).forEach(function (it) {
        tks.push(it.id + (it.hit ? '✓' : '✗'));
      });
      lines.push('第' + g.issue + '期 开 ' + (g.draw && g.draw.main ? g.draw.main.join(' ') : '?') +
        (g.draw && g.draw.sub && g.draw.sub.length ? ' + ' + g.draw.sub.join(' ') : '') +
        ' | ' + (tks.length ? tks.join(' ') : '无票'));
    });
    lines.push('');
    lines.push('各族累计（样本 / 中奖 / 实测率 / 我先前的先验）。样本已含回放，回放按 ' +
      Math.round(BT_W * 100) + '% 折算：');
    var fam = {};
    CATALOG.forEach(function (c) {
      var st = states[c.id] || { n: 0, k: 0 };
      var e = btEff(st);
      if (!fam[c.family]) fam[c.family] = { n: 0, k: 0, prior: 0, c: 0 };
      fam[c.family].n += st.n + e.n; fam[c.family].k += st.k + e.k;
      fam[c.family].prior += c.prior; fam[c.family].c++;
    });
    Object.keys(fam).forEach(function (f) {
      var o = fam[f];
      if (!o.n) return;
      lines.push((FAMILY[f] || f) + ' ' + f + '：' + o.n + ' 注 / 中 ' + o.k + ' / 实测 ' +
        (o.k / o.n * 100).toFixed(2) + '% / 先验 ' + (o.prior / o.c * 100).toFixed(2) + '%');
    });
    lines.push('');
    lines.push('样本最多的八个状态：');
    Object.keys(states).map(function (id) {
      var e = btEff(states[id]);
      return { id: id, n: states[id].n + e.n, k: states[id].k + e.k, real: states[id].n, bt: e.raw };
    })
      .filter(function (x) { return x.n >= 3; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 8)
      .forEach(function (x) {
        var c = CAT_MAP[x.id] || {};
        lines.push(x.id + ' ' + (c.name || '') + '：' + x.n.toFixed(1) + ' 注（实盘 ' + x.real +
          ' / 回放 ' + x.bt + '）/ 中 ' + x.k.toFixed(1) + ' / 实测 ' +
          (x.k / x.n * 100).toFixed(1) + '% / 先验 ' + ((c.prior || 0) * 100).toFixed(1) + '%');
      });
    return lines.join('\n');
  }

  function aiReflect() {
    var digest = aiDigest(16);
    var fams = Object.keys(FAMILY).map(function (k) { return k + '=' + FAMILY[k]; }).join('，');
    var want = [
      '只输出一个 JSON 对象，不要解释，不要 markdown 代码块：',
      '{"read":"一句话说这批账最刺眼的地方（40 字内）",',
      ' "bias":[{"family":"F.XXX","delta":-1到1的小数,"why":"证据（30字内）"}],',
      ' "watch":["S.XXX"],"next":"下一批该重点验什么（40 字内）"}',
      'bias 最多 3 条，delta 为正表示这个族的表现好于我先前的先验，为负表示更差。',
      '族的可用值：' + fams + '。',
      '样本少于 12 注的族不要写进 bias——那是噪声，不是证据。',
      'watch 里放 1-3 个状态 id，只能从上面出现过的 id 里挑。',
      '你是被请来挑刺的，不是来安慰我的。有反例就直说。'
    ].join('\n');

    return aiAsk('这是一台记账机器攒下的开奖记录。请你通读，指出我先前的判断哪里错了。\n\n' + digest, {
      hint: want, maxTokens: 1100
    }).then(function (text) {
      var j = pickJSON(text, 'obj');
      if (!j) return { ok: false, msg: '它没按格式回', raw: stripMeta(text).replace(/\s+/g, ' ').slice(0, 600) };
      var bias = [];
      (Array.isArray(j.bias) ? j.bias : []).slice(0, 3).forEach(function (b) {
        if (!b || !FAMILY[b.family]) return;
        var d = Number(b.delta);
        if (!isFinite(d) || Math.abs(d) < 0.05) return;
        bias.push({ family: b.family, name: FAMILY[b.family], delta: clamp(d, -1, 1), why: String(b.why || '').slice(0, 60) });
      });
      var watch = (Array.isArray(j.watch) ? j.watch : [])
        .filter(function (id) { return !!CAT_MAP[id]; }).slice(0, 3);
      return {
        ok: true, at: nowISO(), read: String(j.read || '').slice(0, 80),
        bias: bias, watch: watch, next: String(j.next || '').slice(0, 80),
        n: readLogs().length, samples: stats().samples
      };
    });
  }

  /* ---------- 接入点三：AI 提新状态，本机验证准入 ---------- */
  var PARAM_DOC = [
    'sumLo,sumHi：和值上下限（整数）',
    'spanLo,spanHi：跨度上下限',
    'oddMin,oddMax：奇数个数的上下限',
    'zone：[三区个数] 如 [2,2,2]',
    'primeMin,primeMax：质数个数上下限',
    'consecLen + consecMin：必须有一组连续 consecLen 个（consecMin 填 1）',
    'consecZone：head / mid / tail，连号必须落在这个区',
    'keepN,keepSide：保留上期 keepN 个，keepSide 取 big（大号优先）或 small',
    'coldN：取遗漏最久的 coldN 个；coldHigh：取次冷的几个',
    'hotN：取最热的几个；hotWarm：取温热的几个',
    'tailSame：至少几个同尾；tailScat：尾数全不同（填 1）',
    'tailBig：尾数 ≥5 的至少 4 个；tailSmall：尾数 <5 的至少 4 个',
    'arith：等差（填 1）；step：固定步长；mirror：必须有一对镜像号（和为 mainMax+1）',
    'sameParity：全奇或全偶（填 1）'
  ].join('\n');

  function aiPropose(k) {
    k = k || 3;
    var ids = CATALOG.map(function (c) { return c.id; });
    var fams = Object.keys(FAMILY).map(function (x) { return x + '=' + FAMILY[x]; }).join('，');
    var want = [
      '只输出一个 JSON 数组，不要解释，不要 markdown 代码块：',
      '[{"id":"S.XXX","name":"中文名(6字内)","family":"F.XXX","type":"T.XXX",',
      '  "rule":"一句话规则","params":{...},"prior":0.03,"why":"为什么值得一试（30字内）"}]',
      '一共 ' + k + ' 个。id 用大写字母数字和点，必须以 S. 开头，不能和已有 id 重复。',
      'family 只能取：' + fams + '。type 自拟，同族的放同一个 type。',
      'params 只能用下面这些键：\n' + PARAM_DOC,
      'params 至少两个约束，别只写一个——一个约束的买法库里已经有了。',
      'prior 一律填 0.03，不要给我更高的数：你提的东西还没有任何证据。'
    ].join('\n');

    return aiAsk('竹芯的状态库里现有 ' + CATALOG.length + ' 个状态。已有 id：\n' +
      ids.join(' ') + '\n\n请提出 ' + k + ' 个现有库里没有的买法状态，要求是：' +
      '把两个以上约束叠在一起，且这个组合在直觉上有一点道理（不是纯随机拼）。', {
      hint: want, maxTokens: 1800
    }).then(function (text) {
      var raw = stripMeta(text).replace(/\s+/g, ' ').trim().slice(0, 600);
      var arr = pickJSON(text, 'arr');
      if (!Array.isArray(arr)) arr = arrOf(pickJSON(text, 'obj'));
      if (!Array.isArray(arr) || !arr.length) {
        return { ok: false, msg: '它没按格式回', raw: raw };
      }

      var ctx = ctxOf(readCfg().game || 'ssq');
      var ok = [], rejected = [];
      arr.slice(0, k + 2).forEach(function (p) {
        if (!p || typeof p !== 'object') return;
        var id = String(p.id || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
        if (!/^S\.[A-Z0-9.]{2,26}$/.test(id)) { rejected.push('编号不成形'); return; }
        if (CAT_MAP[id]) { rejected.push(id + ' 已存在'); return; }
        if (!FAMILY[p.family]) { rejected.push(id + ' 族不认'); return; }
        var params = (p.params && typeof p.params === 'object') ? p.params : null;
        if (!params || !Object.keys(params).length) { rejected.push(id + ' 没有参数'); return; }
        if (Object.keys(params).length < 2) { rejected.push(id + ' 约束太少'); return; }

        var cand = {
          id: id, name: String(p.name || id).slice(0, 10), family: p.family,
          familyName: FAMILY[p.family], type: String(p.type || ('T.' + p.family.replace(/^F\./, ''))).slice(0, 20),
          rule: String(p.rule || '').slice(0, 60), params: params,
          prior: clamp(Number(p.prior) || 0.03, 0.02, 0.05), why: String(p.why || '').slice(0, 80), by: 'ai'
        };
        CAT_MAP[id] = cand;
        var t = makeTicket(id, '2025001', readCfg().game || 'ssq', ctx);
        delete CAT_MAP[id];
        if (!t || t.main.length !== ctx.g.mainCount || t.residual > 0.6) {
          rejected.push(id + ' 出不了票');
          return;
        }
        cand.residual = t.residual;
        cand.sample = t.main;
        ok.push(cand);
      });

      if (!ok.length) return { ok: false, msg: rejected[0] || 'AI 提的都不合格' };

      // 准入：进目录
      ok.forEach(function (c) {
        CATALOG.push(c);
        CAT_MAP[c.id] = c;
      });
      var a = readAI();
      a.props = ok.concat(a.props).slice(0, PROP_MAX);
      writeAI(a);
      return { ok: true, added: ok, rejected: rejected };
    });
  }

  /* AI 读完账，本机决定要不要听：偏见写入，下期采样生效，然后逐期衰减 */
  function applyBias(r) {
    if (!r || !r.ok) return 0;
    var a = readAI();
    (r.bias || []).forEach(function (b) { a.bias[b.family] = b.delta; });
    a.logs = [r].concat(a.logs || []).slice(0, 20);
    writeAI(a);
    return (r.bias || []).length;
  }

  /* 结算完自己去看一眼：不点按钮也会读，但一分钟内不重复读，失败就闭嘴 */
  function autoReflect() {
    if (!aiOn() || ui.autoBusy) return;
    var a = readAI();
    var last = a.logs[0];
    if (last && last.at && (Date.now() - new Date(last.at).getTime()) < 60000) return;
    var s = stats();
    if (s.settled < 3 || s.samples < 9) return;

    ui.autoBusy = true;
    aiReflect().then(function (r) {
      ui.autoBusy = false;
      if (!r || !r.ok) {
        ui.aiRefErr = { msg: (r && r.msg) || '它没按格式回', raw: (r && r.raw) || '', auto: true };
        if (ui.open && ui.tab === 'log') paint(false);
        return;
      }
      ui.aiRefErr = null;
      applyBias(r);
      if (ui.open && ui.tab === 'log') { paint(false); }
    }).catch(function () { ui.autoBusy = false; });
  }

  /* 启动时把已准入的 AI 提案装回目录 */
  function loadProps() {
    var a = readAI();
    (a.props || []).forEach(function (p) {
      if (!p || !p.id || CAT_MAP[p.id]) return;
      CAT_MAP[p.id] = p;
      CATALOG.push(p);
    });
  }
  loadProps();

  /* ============ 历史数据 ============ */
  function LL() { return (root && root.LotteryLab) || null; }
  function loadDraws(gameKey) {
    var L = LL();
    function rowsOf(list) {
      return (list || []).map(function (r) {
        if (Array.isArray(r)) {
          return { issue: String(r[0]), date: String(r[1]), main: numArr(r[2]), sub: numArr(r[3]) };
        }
        return { issue: String(r.issue), date: String(r.date || ''), main: numArr(r.main), sub: numArr(r.sub) };
      });
    }
    try {
      var raw = root.localStorage.getItem(L && L.STORAGE_KEY ? L.STORAGE_KEY : 'bamboo.v13.lottery.data');
      if (raw) {
        var obj = JSON.parse(raw);
        if (obj && obj[gameKey]) {
          var a = rowsOf(obj[gameKey]);
          return L && L.normalizeDraws ? L.normalizeDraws(a, gameKey) : a;
        }
      }
      var seed = root.BAMBOO_LOTTERY_DATA || {};
      if (seed[gameKey]) {
        var b = rowsOf(seed[gameKey]);
        return L && L.normalizeDraws ? L.normalizeDraws(b, gameKey) : b;
      }
    } catch (e) { }
    return [];
  }

  /* draws 必须按"新 → 老"排，且只包含这一期之前的数据。
     回放历史时传 draws.slice(i + 1)，这样第 i 期看不到它自己和它的未来。 */
  function ctxFrom(draws, gameKey) {
    var g = gameOf(gameKey);
    var ds = draws || [];
    var prev = ds[0] || null;
    var omission = {}, hot = {};
    var n, i;
    for (n = 1; n <= g.mainMax; n++) { omission[n] = 99; hot[n] = 0; }
    for (i = 0; i < ds.length && i < 60; i++) {
      (ds[i].main || []).forEach(function (x) {
        hot[x] = (hot[x] || 0) + 1;
        if (omission[x] === 99) omission[x] = i;
      });
    }
    for (n = 1; n <= g.mainMax; n++) if (omission[n] === 99) omission[n] = 60;
    return {
      g: g, draws: ds,
      prevMain: prev ? prev.main : null,
      prevSub: prev ? prev.sub : null,
      omission: omission, hot: hot, count: ds.length
    };
  }
  function ctxOf(gameKey) { return ctxFrom(loadDraws(gameKey), gameKey); }

  /* ============ 出号引擎 ============ */
  function resid(main, P, ctx) {
    var g = ctx.g, r = 0, s = sum(main), sp = main[main.length - 1] - main[0];
    var odd = main.filter(function (x) { return x % 2 === 1; }).length;
    var k;
    if (P.sumLo != null && s < P.sumLo) r += (P.sumLo - s) / 12;
    if (P.sumHi != null && s > P.sumHi) r += (s - P.sumHi) / 12;
    if (P.spanLo != null && sp < P.spanLo) r += (P.spanLo - sp) / 4;
    if (P.spanHi != null && sp > P.spanHi) r += (sp - P.spanHi) / 4;
    if (P.oddMin != null && odd < P.oddMin) r += (P.oddMin - odd) * 2;
    if (P.oddMax != null && odd > P.oddMax) r += (odd - P.oddMax) * 2;
    if (P.zone) {
      var qz = fitZone(P.zone, main.length) || P.zone;
      var cnt = [0, 0, 0];
      main.forEach(function (x) {
        for (var k2 = 0; k2 < 3; k2++) if (x >= g.zones[k2][0] && x <= g.zones[k2][1]) cnt[k2]++;
      });
      for (k = 0; k < 3; k++) r += Math.abs(cnt[k] - qz[k]) * 2.2;
    }
    if (P.primeMin != null) {
      var pc = main.filter(function (x) { return PRIMES[x]; }).length;
      if (pc < P.primeMin) r += (P.primeMin - pc) * 2;
      if (P.primeMax != null && pc > P.primeMax) r += (pc - P.primeMax) * 2;
    }
    if (P.consecMin) {
      var runs = 1, best = 1, q;
      for (q = 1; q < main.length; q++) {
        if (main[q] === main[q - 1] + 1) { runs++; if (runs > best) best = runs; } else runs = 1;
      }
      if (best < P.consecLen) r += (P.consecLen - best) * 2.5;
      if (P.consecZone) {
        var zr = g.zones[P.consecZone === 'head' ? 0 : P.consecZone === 'mid' ? 1 : 2];
        var ok = false, w;
        for (w = 0; w < main.length - 1; w++)
          if (main[w + 1] === main[w] + 1 && main[w] >= zr[0] && main[w + 1] <= zr[1]) ok = true;
        if (!ok) r += 2.5;
      }
    }
    if (P.keepN && ctx.prevMain) {
      var keep = main.filter(function (x) { return ctx.prevMain.indexOf(x) >= 0; }).length;
      r += Math.abs(keep - P.keepN) * 2.6;
    }
    if (P.coldN) {
      var top = coldList(ctx, 8).slice(0, P.coldN);
      var c = main.filter(function (x) { return top.indexOf(x) >= 0; }).length;
      r += Math.abs(c - P.coldN) * 1.6;
    }
    if (P.coldHigh) {
      var mid = coldList(ctx, 16).slice(8, 16).slice(0, P.coldHigh);
      var c2 = main.filter(function (x) { return mid.indexOf(x) >= 0; }).length;
      r += Math.abs(c2 - P.coldHigh) * 1.4;
    }
    if (P.hotN) {
      var ht = hotList(ctx, 8).slice(0, P.hotN);
      var c3 = main.filter(function (x) { return ht.indexOf(x) >= 0; }).length;
      r += Math.abs(c3 - P.hotN) * 1.6;
    }
    if (P.hotWarm) {
      var warm = hotList(ctx, 12).slice(3, 8).slice(0, P.hotWarm);
      var c4 = main.filter(function (x) { return warm.indexOf(x) >= 0; }).length;
      r += Math.abs(c4 - P.hotWarm) * 1.3;
    }
    if (P.tailSame) {
      var tm = {}, mx = 0;
      main.forEach(function (x) { var t = x % 10; tm[t] = (tm[t] || 0) + 1; if (tm[t] > mx) mx = tm[t]; });
      if (mx < P.tailSame) r += (P.tailSame - mx) * 2;
    }
    if (P.tailScat) {
      var ts = {};
      main.forEach(function (x) { ts[x % 10] = 1; });
      r += (main.length - Object.keys(ts).length) * 2.2;
    }
    if (P.tailBig) {
      var tb = main.filter(function (x) { return x % 10 >= 5; }).length;
      if (tb < 4) r += (4 - tb) * 1.8;
    }
    if (P.tailSmall) {
      var tsm = main.filter(function (x) { return x % 10 < 5; }).length;
      if (tsm < 4) r += (4 - tsm) * 1.8;
    }
    if (P.arith) {
      var d0 = main[1] - main[0], okA = true, e;
      for (e = 2; e < main.length; e++) if (main[e] - main[e - 1] !== d0) okA = false;
      if (!okA) r += 3;
    }
    if (P.step) {
      var okS = true, e2;
      for (e2 = 1; e2 < main.length; e2++) if (main[e2] - main[e2 - 1] !== P.step) okS = false;
      if (!okS) r += 3;
    }
    if (P.mirror) {
      var mid2 = g.mainMax + 1, okM = false, a1, a2;
      for (a1 = 0; a1 < main.length; a1++)
        for (a2 = a1 + 1; a2 < main.length; a2++)
          if (main[a1] + main[a2] === mid2) okM = true;
      if (!okM) r += 2.4;
    }
    if (P.sameParity) {
      var allOdd = main.every(function (x) { return x % 2 === 1; });
      var allEven = main.every(function (x) { return x % 2 === 0; });
      if (!allOdd && !allEven) r += 3;
    }
    return r;
  }

  function coldList(ctx, n) {
    var arr = [], i;
    for (i = 1; i <= ctx.g.mainMax; i++) arr.push({ n: i, o: ctx.omission[i] || 0 });
    arr.sort(function (a, b) { return b.o - a.o || a.n - b.n; });
    return arr.slice(0, n).map(function (x) { return x.n; });
  }
  function hotList(ctx, n) {
    var arr = [], i;
    for (i = 1; i <= ctx.g.mainMax; i++) arr.push({ n: i, h: ctx.hot[i] || 0 });
    arr.sort(function (a, b) { return b.h - a.h || a.n - b.n; });
    return arr.slice(0, n).map(function (x) { return x.n; });
  }

  function zoneIdx(n, g) {
    for (var k = 0; k < 3; k++) if (n >= g.zones[k][0] && n <= g.zones[k][1]) return k;
    return -1;
  }

  /* 三区配额按实际号数缩放：大乐透 5 个号也要能用 */
  function fitZone(z, n) {
    if (!z) return null;
    var s = z[0] + z[1] + z[2];
    if (!s) return null;
    if (s === n) return z.slice();
    var out = [0, 0, 0], i, acc, guard = 0;
    for (i = 0; i < 3; i++) out[i] = Math.round(z[i] * n / s);
    acc = out[0] + out[1] + out[2];
    while (acc > n && guard++ < 30) {
      var mi = out[0] >= out[1] && out[0] >= out[2] ? 0 : (out[1] >= out[2] ? 1 : 2);
      if (out[mi] > 0) { out[mi]--; acc--; } else break;
    }
    while (acc < n && guard++ < 60) { out[0]++; acc++; }
    return out;
  }

  /* 按约束直接构造一副骨架，而不是先乱填再修 */
  function seedMain(P, ctx, rng) {
    var g = ctx.g, n = g.mainCount, pool = [], must = [], i, k;
    for (i = 1; i <= g.mainMax; i++) pool.push(i);

    /* 构造型：图形法直接算 */
    if (P.arith) {
      var d = 1 + Math.floor(rng() * 4);
      var a = 1 + Math.floor(rng() * Math.max(1, g.mainMax - (n - 1) * d));
      var arr = [];
      for (i = 0; i < n; i++) arr.push(a + i * d);
      if (arr[n - 1] <= g.mainMax) return sortNum(arr);
    }
    if (P.step) {
      var b = 1 + Math.floor(rng() * Math.max(1, g.mainMax - (n - 1) * P.step));
      var s2 = [];
      for (i = 0; i < n; i++) s2.push(b + i * P.step);
      if (s2[n - 1] <= g.mainMax) return sortNum(s2);
    }
    if (P.sameParity) {
      var wantOdd = rng() < 0.5;
      var ok = pool.filter(function (x) { return (x % 2 === 1) === wantOdd; });
      var out0 = [];
      while (out0.length < n && ok.length) {
        var pi = Math.floor(rng() * ok.length);
        out0.push(ok[pi]); ok.splice(pi, 1);
      }
      if (out0.length === n) return sortNum(out0);
    }

    /* 强制位 */
    if (P.keepN && ctx.prevMain && ctx.prevMain.length) {
      var cand = ctx.prevMain.slice().sort(function (a2, b2) { return a2 - b2; });
      if (P.keepSide === 'big') cand.sort(function (a2, b2) { return b2 - a2; });
      for (i = 0; i < Math.min(P.keepN, cand.length); i++) if (must.indexOf(cand[i]) < 0) must.push(cand[i]);
    }
    if (P.coldN) coldList(ctx, 8).slice(0, P.coldN).forEach(function (x) { if (must.indexOf(x) < 0) must.push(x); });
    if (P.coldHigh) coldList(ctx, 16).slice(8, 16).slice(0, P.coldHigh).forEach(function (x) { if (must.indexOf(x) < 0) must.push(x); });
    if (P.hotN) hotList(ctx, 8).slice(0, P.hotN).forEach(function (x) { if (must.indexOf(x) < 0) must.push(x); });
    if (P.hotWarm) hotList(ctx, 12).slice(3, 8).slice(0, P.hotWarm).forEach(function (x) { if (must.indexOf(x) < 0) must.push(x); });
    if (P.consecLen) {
      var zr = P.consecZone === 'head' ? g.zones[0] : P.consecZone === 'mid' ? g.zones[1] : P.consecZone === 'tail' ? g.zones[2] : [1, g.mainMax];
      var startHi = zr[1] - P.consecLen + 1;
      var st = zr[0] + Math.floor(rng() * Math.max(1, startHi - zr[0] + 1));
      for (i = 0; i < P.consecLen; i++) if (must.indexOf(st + i) < 0) must.push(st + i);
    }
    if (P.mirror) {
      var mid3 = g.mainMax + 1, a3 = 1 + Math.floor(rng() * Math.floor(g.mainMax / 2));
      if (must.indexOf(a3) < 0) must.push(a3);
      if (mid3 - a3 !== a3 && must.indexOf(mid3 - a3) < 0) must.push(mid3 - a3);
    }

    must = uniq(must.filter(function (x) { return x >= 1 && x <= g.mainMax; })).slice(0, n);
    var main = sortNum(must);

    /* 按配额补齐：这一步保证三区配比先天就是对的 */
    var quota = fitZone(P.zone, n);
    var cnt = [0, 0, 0];
    main.forEach(function (x) { var z = zoneIdx(x, g); if (z >= 0) cnt[z]++; });

    for (k = 0; k < 3; k++) {
      var need = quota ? quota[k] - cnt[k] : 0;
      if (need <= 0) continue;
      var avail = pool.filter(function (x) { return main.indexOf(x) < 0 && zoneIdx(x, g) === k; });
      for (i = 0; i < need && avail.length; i++) {
        var pj = Math.floor(rng() * avail.length);
        main.push(avail[pj]); avail.splice(pj, 1);
      }
    }
    var guard = 0;
    while (main.length < n && guard++ < 200) {
      var rest = pool.filter(function (x) { return main.indexOf(x) < 0; });
      if (!rest.length) break;
      main.push(rest[Math.floor(rng() * rest.length)]);
    }
    return sortNum(main.slice(0, n));
  }

  /* 模拟退火：允许暂时变差，才走得出一换就破坏别的约束的死角 */
  function anneal(main, P, ctx, rng) {
    var g = ctx.g, pool = [], i;
    for (i = 1; i <= g.mainMax; i++) pool.push(i);
    var cur = main.slice(), curR = resid(cur, P, ctx);
    var best = cur.slice(), bestR = curR, T = 1.4, step;
    for (step = 0; step < 150; step++) {
      if (bestR < 0.02) break;
      T *= 0.974;
      var idx = Math.floor(rng() * cur.length);
      var free = pool.filter(function (x) { return cur.indexOf(x) < 0; });
      if (!free.length) break;
      var oldZ = zoneIdx(cur[idx], g);
      var near = free.filter(function (x) { return zoneIdx(x, g) === oldZ; });
      var list = (near.length && rng() < 0.72) ? near : free;
      var cand = list[Math.floor(rng() * list.length)];
      var t = cur.slice(); t[idx] = cand; t = sortNum(t);
      var r = resid(t, P, ctx);
      if (r < curR || rng() < Math.exp(-(r - curR) / Math.max(0.06, T))) { cur = t; curR = r; }
      if (r < bestR - 1e-9) { best = t; bestR = r; }
    }
    return { main: best, residual: bestR };
  }

  function buildMain(P, ctx, rng) {
    var best = null, bestR = Infinity, i;
    for (i = 0; i < 9; i++) {
      var s = seedMain(P, ctx, rng);
      var r = anneal(s, P, ctx, rng);
      if (r.residual < bestR - 1e-9) { bestR = r.residual; best = r.main; }
      if (bestR < 0.05) break;
    }
    if (!best) best = seedMain(P, ctx, rng);
    return { main: best, residual: bestR };
  }

  function buildSub(P, ctx, rng) {
    var g = ctx.g, out = [], i;
    for (i = 0; i < g.subCount; i++) {
      var n;
      do { n = 1 + Math.floor(rng() * g.subMax); } while (out.indexOf(n) >= 0);
      out.push(n);
    }
    return sortNum(out);
  }

  function makeTicket(stateId, issue, gameKey, ctx) {
    var st = CAT_MAP[stateId];
    if (!st) return null;
    var rng = mulberry32(fnv(issue + '|' + stateId + '|' + gameKey));
    var built = buildMain(st.params, ctx, rng);
    return {
      main: built.main,
      sub: buildSub(st.params, ctx, rng),
      residual: built.residual,
      fit: clamp(1 - built.residual / 6, 0, 1)
    };
  }

  /* ============ 存储 ============ */
  function lsGet(k, dft) {
    try { var raw = root.localStorage.getItem(k); return raw ? JSON.parse(raw) : dft; }
    catch (e) { return dft; }
  }
  function lsSet(k, v) { try { root.localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  function readStates() {
    var m = lsGet(KEY.states, {}) || {};
    CATALOG.forEach(function (s) {
      if (!m[s.id]) m[s.id] = { id: s.id, n: 0, k: 0, win: 0, money: 0, best: 0, trail: [] };
      if (typeof m[s.id].bn !== 'number') m[s.id].bn = 0;
      if (typeof m[s.id].bk !== 'number') m[s.id].bk = 0;
    });
    return m;
  }
  function writeStates(m) { return lsSet(KEY.states, m); }
  function readTickets() { return lsGet(KEY.tickets, []) || []; }
  function writeTickets(a) { return lsSet(KEY.tickets, (a || []).slice(0, LIM.tickets)); }
  function readIssues() { return lsGet(KEY.issues, []) || []; }
  function writeIssues(a) { return lsSet(KEY.issues, (a || []).slice(0, LIM.issues)); }
  function readLogs() { return lsGet(KEY.logs, []) || []; }
  function writeLogs(a) { return lsSet(KEY.logs, (a || []).slice(0, LIM.logs)); }
  function readCfg() { return lsGet(KEY.cfg, { game: 'ssq' }) || { game: 'ssq' }; }
  function writeCfg(c) { return lsSet(KEY.cfg, c); }

  /* ============ 信念：先验 → 后验 ============ */
  /* 回放样本是"用今天的参数去走一遍昨天"，必然比真实前向观测乐观，
     所以按 BT_W 折算后才进后验：40 期回放只算 12 期的分量。
     实盘 n / k 与回放 bn / bk 分两笔账，随时能拆开看。 */
  function btEff(st) {
    var n = (st && st.bn) || 0, k = (st && st.bk) || 0;
    return { n: n * BT_W, k: k * BT_W, raw: n, rawK: k };
  }
  function postOf(st, prior) {
    var p0 = (prior == null ? BASE_P : prior);
    var e = btEff(st);
    var a = p0 * PRIOR_K + st.k + e.k;
    var b = (1 - p0) * PRIOR_K + (st.n - st.k) + (e.n - e.k);
    return {
      a: a, b: b,
      mean: betaMean(a, b),
      sd: betaSd(a, b),
      lo: betaInv(a, b, 0.05),
      hi: betaInv(a, b, 0.95),
      priorMean: p0,
      shift: betaMean(a, b) - p0,
      bn: e.raw, bk: e.rawK, btN: e.n
    };
  }
  function evidenceOf(st) {
    var real = (st && st.n) || 0;
    var bt = ((st && st.bn) || 0) * BT_W;
    var n = real + bt;
    if (n <= 0) return { level: 0, text: '还没有任何样本' };
    if (real < 20 && bt > 0) return { level: 1, text: '实盘还太少，眼下基本靠回放撑着' };
    if (n < 20) return { level: 1, text: '样本不足，当前数字基本是噪声' };
    if (n < 60) return { level: 2, text: '样本偏少，只能看方向' };
    if (n < 150) return { level: 3, text: '样本可用，仍可能有偶然' };
    return { level: 4, text: '样本较足，可信度较高' };
  }

  /* 逼近度 = 证据量折算。不是中奖率，是这台机器攒了多少次真实观测。
     260 注到 63%，600 注到 90%——永远逼近，永远不到。
     同时给出"后验收窄"这个物理量，供状态详情核对。 */
  function convergence(states) {
    var total = 0, n0 = 0, covered = 0, sd0 = 0, sd1 = 0, bt = 0;
    CATALOG.forEach(function (c) {
      var st = states[c.id] || { n: 0, k: 0 };
      var e = btEff(st);
      total += st.n;
      bt += e.raw;
      n0++;
      if (st.n > 0) covered++;
      var a0 = c.prior * PRIOR_K, b0 = (1 - c.prior) * PRIOR_K;
      sd0 += betaSd(a0, b0);
      sd1 += betaSd(a0 + st.k + e.k, b0 + (st.n - st.k) + (e.n - e.k));
    });
    return {
      pct: clamp((1 - Math.exp(-total / 260)) * 100, 0, 99.5),
      shrink: sd0 > 0 ? (1 - sd1 / sd0) * 100 : 0,
      samples: total, states: n0, covered: covered, bt: bt
    };
  }

  /* ============ 选状态：Thompson 采样 + 探索保底 ============ */
  function pickStates(k, states, ctx) {
    var draws = CATALOG.map(function (c) {
      var st = states[c.id] || { n: 0, k: 0 };
      var e = btEff(st);
      var a0 = c.prior * PRIOR_K, b0 = (1 - c.prior) * PRIOR_K;
      var a = a0 + st.k + e.k, b = b0 + (st.n - st.k) + (e.n - e.k);
      /* AI 的偏见在这里生效：只撬动采样权重，不动先验，也进不了账本 */
      return { id: c.id, v: betaDraw(a, b, Math.random) * biasMul(c.family), n: st.n };
    });
    draws.sort(function (x, y) { return y.v - x.v; });
    var out = [];
    for (var i = 0; i < draws.length && out.length < k; i++) out.push(draws[i].id);

    var minN = Infinity;
    CATALOG.forEach(function (c) {
      var st = states[c.id];
      if (st && st.n < minN) minN = st.n;
    });
    if (k > 1 && minN < 8) {
      var fresh = CATALOG.filter(function (c) { return (states[c.id] || {}).n === minN; });
      if (fresh.length) {
        var f = fresh[Math.floor(Math.random() * fresh.length)];
        if (out.indexOf(f.id) < 0) out[k - 1] = f.id;
      }
    }
    return uniq(out);
  }

  /* ============ 期号 ============ */
  function nextIssue(gameKey) {
    var draws = loadDraws(gameKey);
    var issues = readIssues().filter(function (x) { return x.game === gameKey; });
    var mx = 0;
    draws.forEach(function (d) { var v = toInt(d.issue); if (v > mx) mx = v; });
    issues.forEach(function (x) { var v = toInt(x.id); if (v > mx) mx = v; });
    if (!mx) {
      return String(new Date().getFullYear()) + '001';
    }
    return String(mx + 1);
  }

  /* ============ 一期 ============ */
  function planIssue(gameKey, k) {
    gameKey = gameKey || readCfg().game || 'ssq';
    var states = readStates();
    var issues = readIssues();
    var tickets = readTickets();

    var issue = nextIssue(gameKey);
    var ctx = ctxOf(gameKey);
    var ids = pickStates(k || PER_ISSUE, states, ctx);
    var made = [];
    ids.forEach(function (sid) {
      var t = makeTicket(sid, issue, gameKey, ctx);
      if (!t) return;
      var tk = {
        id: 'tk' + fnv(issue + sid).toString(36),
        issue: issue, game: gameKey, stateId: sid,
        main: t.main, sub: t.sub, fit: t.fit,
        madeAt: nowISO(), settled: false, result: null
      };
      made.push(tk);
    });

    var ids2 = made.map(function (m) { return m.id; });
    tickets = made.concat(tickets.filter(function (x) { return ids2.indexOf(x.id) < 0; })).slice(0, LIM.tickets);
    writeTickets(tickets);

    if (!issues.some(function (x) { return x.id === issue && x.game === gameKey; })) {
      issues.unshift({ id: issue, game: gameKey, createdAt: nowISO(), settled: false, draw: null });
      writeIssues(issues);
    }
    return { issue: issue, tickets: made };
  }

  function issueTickets(gameKey, issue) {
    return readTickets().filter(function (t) { return t.game === gameKey && t.issue === issue; });
  }

  /* ============ 结算 ============ */
  function settleIssue(gameKey, issue, drawMain, drawSub) {
    gameKey = gameKey || 'ssq';
    var g = gameOf(gameKey);
    var dm = numArr(drawMain).slice(0, g.mainCount);
    var ds = numArr(drawSub).slice(0, g.subCount);
    if (dm.length < g.mainCount) return { ok: false, msg: '开奖号码不够 ' + g.mainCount + ' 个' };
    if (uniq(dm).length < dm.length) return { ok: false, msg: '主号有重复' };
    if (uniq(ds).length < ds.length) return { ok: false, msg: g.subName + '有重复' };
    if (dm.some(function (x) { return x < 1 || x > g.mainMax; })) return { ok: false, msg: '主号超出 1-' + g.mainMax };
    if (ds.some(function (x) { return x < 1 || x > g.subMax; })) return { ok: false, msg: g.subName + '超出范围' };

    var tickets = readTickets();
    var states = readStates();
    var issues = readIssues();
    var hit = 0, spend = 0, back = 0, floatN = 0, touched = [], items = [];

    tickets.forEach(function (t) {
      if (t.game !== gameKey || t.issue !== issue || t.settled) return;
      var r = judge(gameKey, t, { main: dm, sub: ds });
      t.settled = true;
      t.result = r;
      hit += r.hit ? 1 : 0;
      spend += 2;
      if (r.money > 0) back += r.money;
      else if (r.money < 0) floatN++;

      items.push({ id: t.stateId, hit: r.hit ? 1 : 0, k: r.k || 0, b: r.b || 0 });

      var st = states[t.stateId];
      if (!st) return;
      st.n += 1;
      if (r.hit) { st.k += 1; st.win += 1; st.money += (r.money > 0 ? r.money : 0); }
      if (r.tier && (!st.best || r.tier < st.best)) st.best = r.tier;
      var pc = CAT_MAP[t.stateId].prior;
      st.trail = (st.trail || []).concat([{
        i: issue, n: st.n, k: st.k,
        p: Number(postOf(st, pc).mean.toFixed(4))
      }]).slice(-40);
      touched.push(t.stateId);
    });

    writeTickets(tickets);
    writeStates(states);

    var iss = null;
    for (var i = 0; i < issues.length; i++) if (issues[i].id === issue && issues[i].game === gameKey) iss = issues[i];
    if (iss) { iss.settled = true; iss.draw = { main: dm, sub: ds }; iss.settledAt = nowISO(); }
    else issues.unshift({ id: issue, game: gameKey, createdAt: nowISO(), settled: true, draw: { main: dm, sub: ds }, settledAt: nowISO() });
    writeIssues(issues);

    var log = buildLog(gameKey, issue, dm, ds, touched, states,
      { hit: hit, spend: spend, back: back, floatN: floatN }, items);
    var logs = readLogs();
    logs.unshift(log);
    writeLogs(logs);

    /* 旧偏见减半：AI 的判断必须每期重新挣一次 */
    decayBias();

    return { ok: true, issue: issue, hit: hit, spend: spend, back: back, log: log, draw: { main: dm, sub: ds } };
  }

  /* ============ 回放历史：把攒样本这件事一次做完 ============ */
  /* 参数指纹：状态参数一变，旧回放就作废——它测的不是现在这台机器 */
  function catSig() {
    var s = CATALOG.map(function (c) {
      return c.id + '|' + c.family + '|' + JSON.stringify(c.params);
    }).join(';');
    return fnv(s).toString(36) + '.' + CATALOG.length;
  }

  function btInfo(gameKey) {
    gameKey = gameKey || readCfg().game || 'ssq';
    var st = readStates();
    var bt = lsGet(KEY.bt, {}) || {};
    var rec = bt[gameKey] || null;
    var n = 0, k = 0;
    CATALOG.forEach(function (c) {
      var s = st[c.id];
      if (s) { n += s.bn || 0; k += s.bk || 0; }
    });
    return {
      n: n, k: k, sig: catSig(),
      issues: rec ? (rec.issues || []).length : 0,
      at: rec ? rec.at : '',
      stale: !!(rec && rec.sig !== catSig()),
      pool: loadDraws(gameKey).length
    };
  }

  /* 每一期只用"比它更老"的开奖来构造上下文，绝不让它看到自己和未来。
     这是回放和作弊的分界线。 */
  var btRunning = false;
  function backfill(gameKey, limit, tick) {
    if (btRunning) { if (tick) tick(0, 0, { done: true, busy: true }); return; }
    gameKey = gameKey || readCfg().game || 'ssq';
    var draws = loadDraws(gameKey);
    var states = readStates();
    var sig = catSig();
    var bt = lsGet(KEY.bt, {}) || {};
    var rec = bt[gameKey];

    if (!rec || rec.sig !== sig) {
      /* 参数变了：旧回放测的是另一台机器，清零重来 */
      CATALOG.forEach(function (c) {
        var s = states[c.id];
        if (s) { s.bn = 0; s.bk = 0; }
      });
      rec = { sig: sig, issues: [], at: '' };
      bt[gameKey] = rec;
    }

    var done = {};
    (rec.issues || []).forEach(function (x) { done[x] = 1; });
    var todo = [];
    for (var i = 0; i < draws.length && todo.length < (limit || BT_MAX); i++) {
      if (!done[draws[i].issue]) todo.push(i);
    }

    if (!todo.length) {
      writeStates(states); lsSet(KEY.bt, bt);
      if (tick) tick(0, 0, { done: true, n: 0, hit: 0, dup: true });
      return;
    }

    btRunning = true;
    var ptr = 0, n = 0, hit = 0;
    function step() {
      var t0 = Date.now();
      while (ptr < todo.length && Date.now() - t0 < 60) {
        var idx = todo[ptr++];
        var d = draws[idx];
        var ctx = ctxFrom(draws.slice(idx + 1), gameKey);
        for (var ci = 0; ci < CATALOG.length; ci++) {
          var c = CATALOG[ci];
          var t = makeTicket(c.id, d.issue, gameKey, ctx);
          if (!t) continue;
          var r = judge(gameKey, t, { main: d.main, sub: d.sub });
          var st = states[c.id];
          if (!st) continue;
          st.bn = (st.bn || 0) + 1;
          n++;
          if (r.hit) { st.bk = (st.bk || 0) + 1; hit++; }
        }
        rec.issues.push(d.issue);
      }
      writeStates(states); lsSet(KEY.bt, bt);
      if (tick) tick(ptr, todo.length, { n: n, hit: hit });
      if (ptr < todo.length) { setTimeout(step, 12); return; }
      rec.at = nowISO();
      rec.issues = rec.issues.slice(-600);
      rec.last = { n: n, hit: hit, periods: todo.length, at: rec.at };
      writeStates(states); lsSet(KEY.bt, bt);
      btRunning = false;
      if (tick) tick(ptr, todo.length, { n: n, hit: hit, periods: todo.length, done: true });
    }
    step();
  }

  /* ============ 反思 ============ */
  function buildLog(gameKey, issue, dm, ds, touched, states, tally, items) {
    var rises = [], falls = [], refuted = [], thin = [], starts = [];
    touched.forEach(function (id) {
      var c = CAT_MAP[id], st = states[id];
      if (!c || !st) return;
      var p = postOf(st, c.prior);
      var item = { id: id, name: c.name, n: st.n, k: st.k, post: p.mean, prior: c.prior, shift: p.shift };
      /* 样本太少时，后验的跳动全是噪声。不放进来，也不写进反思。 */
      if (st.n < 8) { thin.push(item); starts.push(item); return; }
      if (p.shift > 0.012) rises.push(item);
      else if (p.shift < -0.012) falls.push(item);
      if (st.n >= 20 && Math.abs(p.mean - c.prior) > 0.03) refuted.push(item);
    });
    rises.sort(function (a, b) { return b.shift - a.shift; });
    falls.sort(function (a, b) { return a.shift - b.shift; });

    var conv = convergence(states);
    var lines = [];
    lines.push('第 ' + issue + ' 期结算：' + tally.hit + ' / ' + (tally.spend / 2) + ' 注中奖，投入 ' +
      tally.spend + ' 元，固定奖回收 ' + tally.back + ' 元' +
      (tally.floatN ? '，另有 ' + tally.floatN + ' 注一/二等奖，金额等官方公布' : '') + '。');
    if (rises.length) lines.push('信念上调：' + rises[0].name + ' ' + pct(rises[0].prior, 2) + ' → ' + pct(rises[0].post, 2) + '（样本 ' + rises[0].n + '）。');
    if (falls.length) lines.push('信念下调：' + falls[0].name + ' ' + pct(falls[0].prior, 2) + ' → ' + pct(falls[0].post, 2) + '。');
    if (refuted.length) lines.push('被打脸：' + refuted[0].name + '，先验 ' + pct(refuted[0].prior, 2) + '，实测 ' + pct(refuted[0].k / refuted[0].n, 2) + '。这个偏见要记下来。');
    if (thin.length) lines.push('本期有 ' + thin.length + ' 个状态样本仍不到 8 注，后验会跳，但那是噪声，不算数。');
    lines.push('逼近度 ' + conv.pct.toFixed(1) + '%，累计 ' + conv.samples + ' 注，覆盖 ' + conv.covered + ' 个状态。');

    return {
      id: 'lg' + issue + gameKey,
      at: nowISO(), game: gameKey, issue: issue,
      draw: { main: dm, sub: ds },
      tally: tally, conv: conv,
      rises: rises.slice(0, 3), falls: falls.slice(0, 3), refuted: refuted.slice(0, 3),
      thinCount: thin.length, starts: starts.length,
      items: (items || []).slice(0, 12),
      text: lines.join('\n'),
      ai: ''
    };
  }

  /* ============ 统计 ============ */
  function exportAll() {
    return JSON.stringify({
      app: 'zhuxin', v: V, at: nowISO(),
      states: readStates(), tickets: readTickets(),
      issues: readIssues(), logs: readLogs(), cfg: readCfg(),
      ai: readAI(), bt: lsGet(KEY.bt, {})
    }, null, 2);
  }
  function wipe() {
    Object.keys(KEY).forEach(function (k) {
      try { root.localStorage.removeItem(KEY[k]); } catch (e) { }
    });
    /* 状态目录回到出厂的 68 格，AI 提的提案一并退出 */
    resetCatalog();
  }

  function stats() {
    var states = readStates();
    var tickets = readTickets();
    var conv = convergence(states);
    var best = null, bestP = -1, most = null, mostN = -1;
    CATALOG.forEach(function (c) {
      var st = states[c.id];
      if (!st || st.n < 1) return;
      var p = postOf(st, c.prior);
      if (st.n > mostN) { mostN = st.n; most = { c: c, st: st, p: p }; }
      if (st.n >= 3 && p.mean > bestP) { bestP = p.mean; best = { c: c, st: st, p: p }; }
    });
    if (!best) best = most;
    return {
      states: CATALOG.length,
      families: families().length,
      samples: conv.samples,
      conv: conv,
      tickets: tickets.length,
      settled: tickets.filter(function (t) { return t.settled; }).length,
      best: best
    };
  }

  /* ==================================================================
     UI
     ================================================================== */
  var ui = {
    open: false, tab: 'core', game: 'ssq', plan: null, fam: {}, detail: null, toastT: 0, el: null,
    aiDraw: null, aiDrawBusy: false, aiErr: '', aiIssue: '', aiRaw: '',
    aiRefBusy: false, aiRefErr: null, aiPropBusy: false, aiProp: null, autoBusy: false,
    btBusy: false, btPct: 0, btMsg: ''
  };

  function $(id) { return root.document.getElementById(id); }
  function up(node, sel) {
    while (node && node !== root.document) {
      if (node.matches && node.matches(sel)) return node;
      node = node.parentNode;
    }
    return null;
  }
  function toast(msg) {
    var t = $('zxToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.remove('on'); }, 2100);
  }

  function shell() {
    return '' +
      '<div class="zx-scan"></div>' +
      '<div class="zx-wrap" id="zxWrap">' +
      '<header class="zx-head">' +
      '<button class="zx-back" data-act="close" aria-label="返回"><svg viewBox="0 0 24 24" width="17" height="17"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
      '<div class="zx-title"><b>竹 芯</b><em>STATE ENGINE</em></div>' +
      '<span class="zx-vbadge">v' + V + '</span>' +
      '</header>' +
      '<section class="zx-hero" id="zxHero"></section>' +
      '<nav class="zx-tabs" id="zxTabs">' +
      '<button data-tab="core" class="on">芯核</button>' +
      '<button data-tab="issue">出票</button>' +
      '<button data-tab="lib">状态</button>' +
      '<button data-tab="settle">结算</button>' +
      '<button data-tab="log">反思</button>' +
      '<button data-tab="flow">回路</button>' +
      '</nav>' +
      '<main id="zxBody"></main>' +
      '<div class="zx-foot">竹芯不预测。它只记账、算账、认错。</div>' +
      '</div>' +
      '<div class="zx-toast" id="zxToast"></div>';
  }

  function heroHTML() {
    var s = stats();
    var conv = s.conv;
    var cap;
    if (!s.best) cap = '还没有状态开过张';
    else if (s.best.st.n >= 3) cap = '信念最高 · ' + s.best.c.name + ' ' + pct(s.best.p.mean, 1) + '（' + s.best.st.n + ' 注）';
    else cap = '样本最多 · ' + s.best.c.name + '（' + s.best.st.n + ' 注，还太少）';
    return '' +
      '<div class="zx-orb' + (conv.pct > 0 ? ' live' : '') + '">' +
      '<svg viewBox="0 0 120 120" class="zx-ring">' +
      '<circle cx="60" cy="60" r="52" class="zx-ring-bg"/>' +
      '<circle cx="60" cy="60" r="52" class="zx-ring-fg" stroke-dasharray="' +
      (2 * Math.PI * 52).toFixed(1) + '" stroke-dashoffset="' +
      (2 * Math.PI * 52 * (1 - conv.pct / 100)).toFixed(1) + '"/>' +
      '</svg>' +
      '<div class="zx-orb-in"><b id="zxConv">' + conv.pct.toFixed(1) + '</b><i>逼近度 %</i></div>' +
      '</div>' +
      '<div class="zx-mets">' +
      '<div><b id="zxSamp">' + conv.samples + '</b><i>实盘样本</i>' +
      (conv.bt ? '<u>+' + conv.bt + ' 回放</u>' : '') + '</div>' +
      '<div><b id="zxStat">' + conv.covered + '/' + s.states + '</b><i>开过张</i></div>' +
      '<div><b id="zxSet">' + s.settled + '</b><i>已结算</i></div>' +
      '</div>' +
      '<p class="zx-hero-cap">' + esc(cap) + '</p>' +
      sideHTML();
  }

  function sideHTML() {
    var pend = readTickets().filter(function (t) { return !t.settled; }).length;
    var logs = readLogs();
    var last = logs[0];
    var h = '<div class="zx-side">';
    if (last && last.draw && last.draw.main) {
      h += '<div class="zx-side-card">' +
        '<i>最近结算 · 第 ' + esc(last.issue) + ' 期</i>' +
        '<span class="zx-side-num">' + last.draw.main.map(pad2).join(' ') +
        (last.draw.sub && last.draw.sub.length ? ' <em>+ ' + last.draw.sub.map(pad2).join(' ') + '</em>' : '') +
        '</span>' +
        '<b>' + (last.tally ? last.tally.hit : 0) + ' / ' + (last.tally ? Math.round(last.tally.spend / 2) : 0) + ' 注中奖</b>' +
        '</div>';
    }
    h += '<button class="zx-btn wide' + (pend ? '' : ' primary') + '" data-act="goto" data-to="' +
      (pend ? 'settle' : 'issue') + '">' + (pend ? '结算 ' + pend + ' 注待开奖' : '让竹芯开一期') +
      '</button>';
    h += '<p class="zx-side-note">竹芯不预测。<br>它只记账、算账、认错。</p></div>';
    return h;
  }

  function miniHTML() {
    var s = stats();
    var conv = s.conv;
    return '<div class="zx-mini">' +
      '<span>逼近 <b>' + conv.pct.toFixed(1) + '%</b></span>' +
      '<span>样本 <b>' + conv.samples + '</b>' + (conv.bt ? '<u>· 回 ' + conv.bt + '</u>' : '') + '</span>' +
      '<span>开过张 <b>' + conv.covered + '/' + s.states + '</b></span>' +
      '</div>';
  }

  function paint(scrollTop) {
    var hero = $('zxHero');
    var wide = (root.innerWidth || 0) >= 900;
    if (hero) hero.innerHTML = (ui.tab === 'core' || wide) ? heroHTML() : miniHTML();
    var body = $('zxBody');
    if (!body) return;
    var h = '';
    if (ui.tab === 'core') h = coreHTML();
    else if (ui.tab === 'issue') h = issueHTML();
    else if (ui.tab === 'lib') h = libHTML();
    else if (ui.tab === 'settle') h = settleHTML();
    else if (ui.tab === 'flow') h = flowHTML();
    else h = logHTML();
    body.innerHTML = h;
    var tabs = $('zxTabs');
    if (tabs) {
      var bs = tabs.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) bs[i].className = bs[i].getAttribute('data-tab') === ui.tab ? 'on' : '';
    }
    if (scrollTop !== false) {
      var wrap = $('zxWrap');
      if (wrap) wrap.scrollTop = 0;
    }
  }

  function secHead(t, s) {
    return '<div class="zx-sh"><h3>' + t + '</h3><span>' + s + '</span></div>';
  }

  /* ---------- 回路 ---------- */
  function flowHTML() {
    var a = readAI();
    var biasKeys = Object.keys(a.bias || {});
    var aiOk = aiOn();
    var pts = [[110, 30], [179.3, 70], [179.3, 150], [110, 190], [40.7, 150], [40.7, 70]];

    var svg = '<svg viewBox="0 0 220 220" class="zx-loop-svg">' +
      '<circle cx="110" cy="110" r="80" class="zx-loop-bg"/>' +
      '<circle cx="110" cy="110" r="80" class="zx-loop-dash" transform="rotate(-90 110 110)" stroke-dasharray="52 31.78"/>';
    for (var i = 0; i < 6; i++) {
      svg += '<circle cx="' + pts[i][0] + '" cy="' + pts[i][1] + '" r="14" class="zx-loop-pt' +
        (i === 3 ? ' real' : '') + '"/>' +
        '<text x="' + pts[i][0] + '" y="' + (pts[i][1] + 3.6) + '" class="zx-loop-n">' + (i + 1) + '</text>';
    }
    svg += '<text x="110" y="103" class="zx-loop-c1">竹 芯</text>' +
      '<text x="110" y="123" class="zx-loop-c2">一圈 = 一期</text>' +
      '</svg>';

    var steps = [
      ['状态库', '本机',
        '族是方向，型是手法，状态才是下注的那一格。每一格由一组约束定义，配一个先验和一句「为什么是这个数」。先验是偏见，不是事实。',
        '先验 = 手填 2.0%–6.6%\n强度 = 40 次虚拟观测',
        'bamboo.v19.zx.states'],
      ['采样', '本机 + AI',
        '对每一格抽一次 Beta 分布，取最大的三个。后验高的容易被挑中，但每期硬留一个名额给样本最少的那格——只挑高分，就永远不知道低分的有没有被冤枉。',
        'a = 先验×40 + 中奖数\nb = (1−先验)×40 + 未中数\n取 β(a,b) 最大的 3 个\nAI 偏见 ×0.82–1.18',
        'bamboo.v19.zx.ai'],
      ['出票', '本机',
        '约束交给出号引擎：先按三区配额造骨架，再用模拟退火换号，直到残差归零。同一期、同一状态，永远出同一注——所以每一注都能复核。',
        '残差 = Σ 各维偏差\n残差 = 0 才出票\n种子 = 期号 + 状态 + 彩种',
        'bamboo.v19.zx.tickets'],
      ['开奖', '现实 / AI',
        '号码不是算出来的，是开出来的。AI 联网只做一件事：把号码抄回来。个数不对、范围超了、有重复，一律退回。',
        '双色球 6+1｜大乐透 5+2\n越界 / 重复 / 缺号 → 拒收',
        '只取当次，不落账'],
      ['结算', '本机',
        '官方奖级表在本机跑。AI 不碰钱，也不碰概率——它编一个数，你可能信三个月。账本按 2 元一注记投入，一、二等奖只记次数，不猜金额。',
        '命中 = |票 ∩ 开奖|\n奖级 → 固定奖金额\n一/二等奖：只记次数',
        'bamboo.v19.zx.logs'],
      ['后验 · 反思', '本机 + AI',
        '中没中写回状态，先验被后验顶掉一点。AI 通读最近 16 期，指出哪个族的先验错得最离谱；本机把它折成采样权重，然后每期减半——它的判断必须重新挣。',
        'a += 中｜b += 未中\n逼近度 = 1 − e^(-n/260)\nAI 偏见每期 ×0.5',
        'bamboo.v19.zx.states']
    ];

    var h = '<section class="zx-blk">';
    h += '<div class="zx-loop">' + svg + '</div>';
    h += '<p class="zx-loop-cap">顺时针走一圈，就是一期。<br>每一圈都让某个先验离现实近一点。</p>';
    h += '</section>';

    h += '<div class="zx-steps">';
    steps.forEach(function (st, i) {
      var w = st[1];
      var wcls = w.indexOf('AI') >= 0 ? ' ai' : (w.indexOf('现实') >= 0 ? ' real' : '');
      h += '<section class="zx-step">' +
        '<div class="zx-step-n">' + pad2(i + 1) + '</div>' +
        '<div class="zx-step-b">' +
        '<div class="zx-step-h"><b>' + st[0] + '</b><span class="zx-step-w' + wcls + '">' + w + '</span></div>' +
        '<p>' + st[2] + '</p>' +
        '<code>' + st[3] + '</code>' +
        '<div class="zx-step-k">存 → ' + st[4] + '</div>' +
        '</div></section>';
    });
    h += '</div>';

    h += '<section class="zx-blk">';
    h += secHead('旁路 · 回放', '不在这一圈里');
    h += '<p class="zx-flow-p">主回路一圈一期，太慢。还有一条旁路：把往期开奖逐期重走，每期让 ' +
      CATALOG.length + ' 个状态各出一注，跟真实结果对账。样本能一夜从 0 涨到几千。' +
      '但它<b>不是前向观测</b>——参数是今天才定的，回放历史必然偏乐观。' +
      '所以只按 ' + Math.round(BT_W * 100) + '% 折算进信念，单独记一笔，不写进账本，也不算逼近度。' +
      '回放到第 i 期时，只让它看见比 i 更老的开奖。</p>';
    h += '</section>';

    h += '<section class="zx-blk">';
    h += secHead('谁说了算', aiOk ? 'AI 已接上' : 'AI 没配置');
    h += '<div class="zx-who">' +
      '<div><b class="real">现实</b><span>决定开什么号。它不解释，只出结果。</span></div>' +
      '<div><b>本机</b><span>出票、算奖级、更新后验、落账。所有数字都在这儿写。</span></div>' +
      '<div><b class="ai">AI</b><span>查开奖、读账挑刺、提新买法。只能提议，不能落账。</span></div>' +
      '</div>';
    if (biasKeys.length) {
      h += '<div class="zx-chips2">';
      biasKeys.forEach(function (k) {
        var v = a.bias[k], up = v > 0;
        h += '<span class="' + (up ? 'up' : 'down') + '">' + esc(FAMILY[k] || k) + ' ' +
          (up ? '+' : '') + Math.round(v * 18) + '% 权重</span>';
      });
      h += '</div>';
      h += '<p class="zx-fine">这是 AI 上回读账留下的偏见，正在逐期减半。它不改先验，只改下一期先挑谁。</p>';
    } else {
      h += '<p class="zx-fine">AI 的偏见没有存量。每次结算后自动减半，三期左右归零——它说的话有保质期。</p>';
    }
    h += '</section>';

    h += '<section class="zx-blk">';
    h += secHead('为什么不让 AI 算账', aiOk ? 'DeepSeek 已连' : '未配置 AI');
    h += '<p class="zx-flow-p">模型会编。编一个号码，这一期的账就废了；编一个概率，你可能信三个月。' +
      '所以竹芯只让它做两件不碰账的事：<b>抄事实</b>、<b>提假设</b>。' +
      '抄错被范围校验拦下，提错被样本数压住。</p>';
    h += '<p class="zx-fine">' + CATALOG.length + ' 个状态数学上完全等价。样本足够时它们都会向 6.25% 靠拢——' +
      '那一天不是找到规律，是认清没有。</p>';
    h += '</section>';

    return h;
  }

  /* ---------- 芯核 ---------- */
  function coreHTML() {
    var s = stats();
    var states = readStates();
    var logs = readLogs();
    var h = '';

    var young = 0, solid = 0, cold = 0;
    CATALOG.forEach(function (c) {
      var st = states[c.id];
      if (!st || st.n === 0) cold++;
      else if (st.n < 8) young++;
      else solid++;
    });

    h += '<section class="zx-blk">';
    h += '<div class="zx-quote">' +
      '<p>一台机器如果只记自己想记的，那它记的是自己。</p>' +
      '<p>竹芯记的是<b>买法</b>：' + CATALOG.length + ' 个状态，每个都有自己的编号、自己的规则、自己的信念值。' +
      '开奖一次，改一次分。改得多了，偏见会自己显形。</p>' +
      '</div>';
    h += '</section>';

    h += '<section class="zx-blk">';
    h += secHead('状态分布', '共 ' + CATALOG.length + ' 个');
    h += '<div class="zx-three">' +
      '<div><b>' + cold + '</b><i>没开过张</i></div>' +
      '<div><b>' + young + '</b><i>一至七注</i></div>' +
      '<div><b>' + solid + '</b><i>八注以上</i></div>' +
      '</div>';
    h += '<p class="zx-fine">八注以下的状态，后验基本还停在先验上，会跟着开奖乱跳。这是对的——没数据就不该改主意。</p>';
    h += '</section>';

    h += '<section class="zx-blk">';
    h += secHead('逼近曲线', logs.length ? '最近 ' + Math.min(logs.length, 12) + ' 期' : '还没有数据');
    if (logs.length) {
      var arr = logs.slice(0, 12).reverse();
      h += '<div class="zx-spark">';
      var mx = 0.01;
      arr.forEach(function (g) { if (g.conv && g.conv.pct > mx) mx = g.conv.pct; });
      arr.forEach(function (g) {
        var v = g.conv ? g.conv.pct : 0;
        h += '<i style="height:' + Math.max(4, (v / mx) * 100) + '%" title="' + g.issue + ' · ' + v.toFixed(1) + '%"></i>';
      });
      h += '</div>';
      h += '<p class="zx-fine">每结算一期，每个状态的后验收窄一点。曲线往上走，说明这台机器在认识现实；走平，说明样本还不够拉动先验。</p>';
    } else {
      h += '<div class="zx-empty">还没有结算过。去「开一期」出三注，开奖后到「结算」录一次。</div>';
    }
    h += '</section>';

    if (logs.length) {
      h += '<section class="zx-blk">';
      h += secHead('最近一次反思', '第 ' + logs[0].issue + ' 期');
      h += '<div class="zx-logbox">' + esc(logs[0].text).replace(/\n/g, '<br>') + '</div>';
      h += '</section>';
    }

    var pend = readTickets().filter(function (t) { return !t.settled; });
    h += '<section class="zx-blk zx-only-m">';
    h += secHead('待办', pend.length ? pend.length + ' 注未结算' : '干净');
    if (pend.length) {
      h += '<button class="zx-btn" data-act="goto" data-to="settle">去结算这 ' + pend.length + ' 注</button>';
    } else {
      h += '<button class="zx-btn primary" data-act="goto" data-to="issue">开一期</button>';
    }
    h += '</section>';

    h += edgeHTML();
    h += '<div class="zx-acts">' +
      '<button data-act="export">导出账本</button>' +
      '<button data-act="wipe">清空重来</button>' +
      '</div>';
    return h;
  }

  function edgeHTML() {
    return '<section class="zx-blk zx-edge">' +
      '<div class="zx-sh"><h3>边界</h3><span>写在代码里</span></div>' +
      '<p>开奖是独立的。蓝球永远 1/16，红球永远是超几何分布，' +
      '任何"买法"都改变不了一注票的中奖概率。这 ' + CATALOG.length + ' 个状态，数学上完全等价。</p>' +
      '<p>那它算的是什么？算的是<b>你相信的那套东西，能不能扛住开奖</b>。' +
      '先验是你此刻的偏见，后验是现实的说服力。样本越多，所有状态都会向 ' + pct(BASE_P, 2) + ' 靠拢。' +
      '那一天，不是找到了规律，是认清没有规律。</p>' +
      '<p class="zx-edge-k">这句话不好听。但一台不肯说这句话的机器，只会陪你一起骗自己。</p>' +
      '</section>';
  }

  /* ---------- 开一期 ---------- */
  function issueHTML() {
    var g = gameOf(ui.game);
    var h = '';
    var pend = readTickets().filter(function (t) { return t.game === ui.game && !t.settled; });
    var cur = ui.plan;

    h += '<section class="zx-blk">';
    h += '<div class="zx-games">' +
      '<button data-act="game" data-g="ssq" class="' + (ui.game === 'ssq' ? 'on' : '') + '">双色球</button>' +
      '<button data-act="game" data-g="dlt" class="' + (ui.game === 'dlt' ? 'on' : '') + '">大乐透</button>' +
      '</div>';
    h += '</section>';

    if (cur && cur.tickets && cur.tickets.length) {
      var clean = cur.tickets.every(function (t) { return !t.residual || t.residual < 0.005; });
      h += '<section class="zx-blk">';
      h += secHead('第 ' + cur.issue + ' 期',
        '三注 · ' + (clean ? '残差全 0' : '残差 ' + cur.tickets.map(function (t) { return (t.residual || 0).toFixed(2); }).join('/')));
      cur.tickets.forEach(function (t, i) { h += ticketCard(t, i); });
      h += '<div class="zx-row">' +
        '<button class="zx-btn" data-act="goto" data-to="settle">去结算</button>' +
        '<button class="zx-btn ghost" data-act="replan">换一组</button>' +
        '</div>';
      h += '<p class="zx-fine">每注都带出生证明：它是哪个状态生的、规则是什么、先验几分。开奖后回头对，才知道这个状态该加分还是减分。</p>';
      h += '</section>';
    } else if (pend.length) {
      h += '<section class="zx-blk">';
      h += secHead('还有 ' + pend.length + ' 注没结算', '先结算，再开新的');
      pend.forEach(function (t, i) { h += ticketCard(t, i); });
      h += '<button class="zx-btn" data-act="goto" data-to="settle">去结算</button>';
      h += '</section>';
    } else {
      h += '<section class="zx-blk">';
      h += '<div class="zx-empty big">' +
        '<p>竹芯会按 Thompson 采样挑三个状态：<br>后验越高的越容易被挑中，' +
        '但样本最少的那个，每期保留一个名额。</p>' +
        '<p class="dim">这叫做"利用"和"探索"的平衡——只挑高分，永远不知道低分的是不是被冤枉了。</p>' +
        '</div>';
      h += '<button class="zx-btn primary wide" data-act="plan">让竹芯出 3 注</button>';
      h += '</section>';
    }

    h += '<section class="zx-blk">';
    h += secHead('这一期的基础', '来自最近 ' + Math.min(60, loadDraws(ui.game).length) + ' 期');
    var ctx = ctxOf(ui.game);
    var prev = ctx.prevMain;
    h += '<div class="zx-kv">' +
      '<div><i>上期号码</i><b>' + (prev && prev.length ? prev.map(pad2).join(' ') : '—') + '</b></div>' +
      '<div><i>最冷号</i><b>' + coldList(ctx, 3).map(pad2).join(' ') + '</b></div>' +
      '<div><i>最热号</i><b>' + hotList(ctx, 3).map(pad2).join(' ') + '</b></div>' +
      '</div>';
    h += '<p class="zx-fine">冷热只用于出号，不代表它们更容易出。这一段是"状态"要吃的原料。</p>';
    h += '</section>';
    return h;
  }

  function ballsHTML(main, sub, cls) {
    var h = '<div class="zx-balls ' + (cls || '') + '">';
    main.forEach(function (n) { h += '<span class="zx-b">' + pad2(n) + '</span>'; });
    if (sub && sub.length) {
      h += '<span class="zx-bsep"></span>';
      sub.forEach(function (n) { h += '<span class="zx-b sub">' + pad2(n) + '</span>'; });
    }
    h += '</div>';
    return h;
  }

  function ticketCard(t, i) {
    var c = CAT_MAP[t.stateId];
    if (!c) return '';
    var st = readStates()[t.stateId] || { n: 0, k: 0 };
    var p = postOf(st, c.prior);
    var h = '<div class="zx-tk">';
    h += '<div class="zx-tk-top"><span class="zx-tk-i">#' + (i + 1) + '</span>' +
      '<code class="zx-sid">' + esc(c.id) + '</code></div>';
    h += ballsHTML(t.main, t.sub);
    h += '<div class="zx-tk-name">' + esc(c.name) + '<em>' + esc(c.familyName) + '</em></div>';
    h += '<p class="zx-tk-rule">' + esc(c.rule) + '</p>';
    if (t.settled && t.result) {
      h += '<div class="zx-tk-res ' + (t.result.hit ? 'hit' : 'miss') + '">' +
        (t.result.hit ? '中了 · ' + esc(t.result.text) : '未中 · 红 ' + t.result.h + ' 蓝 ' + t.result.b) + '</div>';
    }
    h += '<div class="zx-tk-bel"><span>先验 <b>' + pct(c.prior, 2) + '</b></span>' +
      '<span>现在 <b>' + pct(p.mean, 2) + '</b></span>' +
      '<span>样本 <b>' + st.n + '</b></span></div>';
    return h + '</div>';
  }

  /* ---------- 状态库 ---------- */
  function libHTML() {
    var states = readStates();
    var fams = families();
    var bi = btInfo(ui.game);
    var conv = convergence(states);
    var h = '';

    h += '<section class="zx-blk zx-bt">';
    h += secHead('样本', '实盘 ' + conv.samples + ' 注 · 回放 ' + bi.n + ' 注');
    h += '<div class="zx-bt-num">' +
      '<div><b>' + conv.samples + '</b><i>实盘观测</i></div>' +
      '<div><b>' + bi.n + '</b><i>回放注数</i></div>' +
      '<div><b>' + (bi.n ? pct(bi.k / bi.n, 2) : '—') + '</b><i>回放命中</i></div>' +
      '</div>';
    if (ui.btBusy) {
      h += '<button class="zx-btn wide" disabled><span class="zx-spin2"></span>' + esc(ui.btMsg || '正在回放…') + '</button>' +
        '<div class="zx-bt-bar"><i style="width:' + ui.btPct.toFixed(1) + '%"></i></div>';
    } else {
      var left = Math.max(0, bi.pool - bi.issues);
      var label = !bi.pool ? '本机还没有开奖历史'
        : (left <= 0 ? '已回放完全部 ' + bi.pool + ' 期'
          : (bi.issues ? '再往前回放 ' + Math.min(BT_MAX, left) + ' 期' : '回放最近 ' + Math.min(BT_MAX, left) + ' 期'));
      h += '<button class="zx-btn wide" data-act="bt"' + (left <= 0 ? ' disabled' : '') + '>' + esc(label) + '</button>';
    }
    h += '<p class="zx-fine">回放 = 用今天的参数把往期逐期重走：每期只吃比它更老的开奖，不看自己、不看未来。' +
      '它必然比真实前向观测乐观（参数是今天才定的），所以只按 ' + Math.round(BT_W * 100) + '% 折算进信念，' +
      '单独记一笔，不写进账本。</p>';
    if (bi.stale) h += '<p class="zx-warn">状态参数变过，旧回放已作废，得重来。</p>';
    h += '</section>';

    h += '<section class="zx-blk">';
    h += '<div class="zx-libtop">' +
      '<div><b>' + CATALOG.length + '</b><i>个状态</i></div>' +
      '<div><b>' + fams.length + '</b><i>个族</i></div>' +
      '<div><b>' + CATALOG.filter(function (c) { return states[c.id] && (states[c.id].n > 0 || states[c.id].bn > 0); }).length + '</b><i>有数据</i></div>' +
      '</div>';
    h += '<p class="zx-fine">族是方向，型是手法，状态才是真正拿去下注的那一格。点开看每个状态的编号、规则和它的偏见。</p>';
    if (aiOn()) {
      h += '<button class="zx-btn wide zx-ai-btn" data-act="aipropose"' + (ui.aiPropBusy ? ' disabled' : '') + '>' +
        (ui.aiPropBusy ? '<span class="zx-spin2"></span>DeepSeek 正在想新买法…' : '<i class="zx-ai-ico">✦</i>让 AI 提 3 个库里没有的买法') + '</button>';
      h += '<p class="zx-fine">AI 提的进不进得来，由本机验：编号不能重、约束至少两条、必须出得了票、残差归零。' +
        '过了才收，先验一律压到 3% 以下——它还没有任何证据。</p>';
    }
    if (ui.aiProp) {
      if (ui.aiProp.ok) {
        h += '<div class="zx-aiprop">' +
          '<b>收了 ' + ui.aiProp.added.length + ' 个</b>' +
          ui.aiProp.added.map(function (x) {
            return '<p><code>' + esc(x.id) + '</code>' + esc(x.name) + ' · 残差 ' + x.residual.toFixed(2) +
              ' · 样票 ' + x.sample.map(pad2).join(' ') + '</p>';
          }).join('') +
          (ui.aiProp.rejected.length ? '<i>退回：' + esc(ui.aiProp.rejected.join('；')) + '</i>' : '') +
          '</div>';
      } else {
        h += '<div class="zx-aierr">' + esc(ui.aiProp.msg) +
          '<span>' + (ui.aiProp.raw
            ? '原话在下面。多半是写成了一段人话——它懂，只是没照格式给。'
            : '它提的东西本机验不过，就不收。') + '</span>' +
          (ui.aiProp.raw ? '<details><summary>看 AI 原话</summary><pre>' + esc(ui.aiProp.raw) + '</pre></details>' : '') +
          '</div>';
      }
    }
    h += '</section>';

    fams.forEach(function (f) {
      var open = !!ui.fam[f.id];
      h += '<section class="zx-fam' + (open ? ' open' : '') + '">';
      h += '<button class="zx-fam-h" data-act="fam" data-f="' + f.id + '">' +
        '<span class="zx-fam-n">' + esc(f.name) + '</span>' +
        '<span class="zx-fam-c">' + f.count + ' 态 · ' + f.types.length + ' 型</span>' +
        '<span class="zx-fam-a">' + (open ? '−' : '+') + '</span>' +
        '</button>';
      if (open) {
        f.types.forEach(function (tp) {
          if (f.types.length > 1) {
            h += '<div class="zx-type-h">' + esc(TYPE_NAME[tp.id] || tp.id) +
              '<span>' + tp.states.length + ' 态</span></div>';
          }
          tp.states.forEach(function (sid) {
            h += stateRow(sid, states);
          });
        });
      }
      h += '</section>';
    });
    return h;
  }

  function stateRow(sid, states) {
    var c = CAT_MAP[sid];
    var st = states[sid] || { n: 0, k: 0 };
    var p = postOf(st, c.prior);
    var w = Math.min(100, (p.mean / 0.14) * 100);
    var det = ui.detail === sid;
    var h = '<button class="zx-st' + (det ? ' on' : '') + '" data-act="st" data-s="' + sid + '">';
    h += '<span class="zx-st-l"><code>' + esc(sid.replace(/^S\./, '')) + '</code><b>' + esc(c.name) +
      (c.by === 'ai' ? '<em class="zx-st-ai">AI</em>' : '') + '</b></span>';
    h += '<span class="zx-st-r"><i>' + pct(p.mean, 1) + '</i><em>' +
      (st.n ? st.n + ' 注' : '') + (st.n && p.bn ? ' · ' : '') +
      (p.bn ? p.bn + ' 回' : '') + (!st.n && !p.bn ? '0 注' : '') + '</em></span>';
    h += '<span class="zx-st-bar"><i style="width:' + w.toFixed(1) + '%"></i></span>';
    h += '</button>';
    if (det) h += stateDetail(c, st, p);
    return h;
  }

  function stateDetail(c, st, p) {
    var ev = evidenceOf(st);
    var h = '<div class="zx-det">';
    h += '<div class="zx-det-id"><code>' + esc(c.id) + '</code>' +
      (c.by === 'ai' ? '<span class="zx-det-ai">AI 提的 · 本机验过票 · 等开奖</span>' : '') + '</div>';
    h += '<p class="zx-det-rule"><b>规则</b>' + esc(c.rule) + '</p>';
    h += '<p class="zx-det-why"><b>为什么先验是 ' + pct(c.prior, 2) + '</b>' + esc(c.why) + '</p>';
    h += '<div class="zx-ci">' +
      '<div class="zx-ci-bar">' +
      '<span class="zx-ci-range" style="left:' + (p.lo * 100 / 0.2).toFixed(1) + '%;width:' + Math.max(2, ((p.hi - p.lo) * 100 / 0.2)).toFixed(1) + '%"></span>' +
      '<span class="zx-ci-mid" style="left:' + (p.mean * 100 / 0.2).toFixed(1) + '%"></span>' +
      '<span class="zx-ci-base" style="left:' + (BASE_P * 100 / 0.2).toFixed(1) + '%"></span>' +
      '</div>' +
      '<div class="zx-ci-lab"><span>0</span><span>6.25% 基线</span><span>20%</span></div>' +
      '</div>';
    h += '<p class="zx-det-ci">现在信 <b>' + pct(p.mean, 2) + '</b>，九成把握在 ' + pct(p.lo, 2) + ' ~ ' + pct(p.hi, 2) + ' 之间。' +
      '实盘 ' + st.n + ' 注、中 ' + st.k + ' 次' +
      (p.bn
        ? '；回放 ' + p.bn + ' 注、中 ' + p.bk + ' 次，按 ' + Math.round(BT_W * 100) + '% 折算成 ' +
          p.btN.toFixed(1) + ' 注的分量'
        : '') +
      '。' + esc(ev.text) + '。</p>';
    if (st.trail && st.trail.length > 1) {
      h += '<div class="zx-det-trail">';
      st.trail.slice(-10).forEach(function (x) {
        h += '<i style="height:' + Math.max(3, Math.min(100, (x.p / 0.16) * 100)) + '%" title="第' + x.i + '期 ' + (x.p * 100).toFixed(1) + '%"></i>';
      });
      h += '</div><p class="zx-fine">这条是信念的移动轨迹。往下走，说明开奖在教训它。</p>';
    }
    h += '</div>';
    return h;
  }

  function ballRow(arr) {
    var h = '';
    arr.forEach(function (n) { h += '<b class="zx-b">' + pad2(n) + '</b>'; });
    return h;
  }

  /* ---------- 结算 ---------- */
  function settleHTML() {
    var g = gameOf(ui.game);
    var tickets = readTickets().filter(function (t) { return t.game === ui.game && !t.settled; });
    var issues = {};
    tickets.forEach(function (t) { issues[t.issue] = (issues[t.issue] || 0) + 1; });
    var list = Object.keys(issues).sort();
    var def = list.length ? list[list.length - 1] : nextIssue(ui.game);

    var h = '';
    h += '<section class="zx-blk">';
    h += '<div class="zx-games">' +
      '<button data-act="game" data-g="ssq" class="' + (ui.game === 'ssq' ? 'on' : '') + '">双色球</button>' +
      '<button data-act="game" data-g="dlt" class="' + (ui.game === 'dlt' ? 'on' : '') + '">大乐透</button>' +
      '</div>';
    h += '</section>';

    if (!tickets.length) {
      h += '<section class="zx-blk"><div class="zx-empty">这一边没有等结算的票。<br>去「开一期」先出几注。</div></section>';
      return h;
    }

    var aiD = (ui.aiDraw && ui.aiDraw.queryIssue === def) ? ui.aiDraw : null;
    var preMain = aiD ? aiD.main.map(pad2).join(' ') : '';
    var preSub = aiD ? aiD.sub.map(pad2).join(' ') : '';

    h += '<section class="zx-blk">';
    h += secHead('录入开奖', '第 ' + def + ' 期 · ' + tickets.filter(function (t) { return t.issue === def; }).length + ' 注待结');
    h += '<div class="zx-form">' +
      '<label><span>期号</span><input id="zxIssue" value="' + esc(ui.aiIssue || def) + '" inputmode="numeric"></label>' +
      '<label><span>主号（' + g.mainCount + ' 个）</span><input id="zxMain" value="' + preMain + '" placeholder="' + (ui.game === 'ssq' ? '01 05 12 18 23 30' : '02 09 17 24 33') + '" inputmode="numeric"></label>' +
      '<label><span>' + g.subName + '（' + g.subCount + ' 个）</span><input id="zxSub" value="' + preSub + '" placeholder="' + (ui.game === 'ssq' ? '08' : '03 11') + '" inputmode="numeric"></label>' +
      '</div>';

    if (aiOn()) {
      h += '<button class="zx-btn wide zx-ai-btn" data-act="aidraw"' + (ui.aiDrawBusy ? ' disabled' : '') + '>' +
        (ui.aiDrawBusy
          ? '<span class="zx-spin2"></span>DeepSeek 正在联网查第 ' + esc(ui.aiIssue || def) + ' 期…'
          : '<i class="zx-ai-ico">✦</i>让 AI 联网查这一期') + '</button>';
    } else {
      h += '<p class="zx-fine">这台还没接 AI。到设置里填上 DeepSeek 的接口和 Key，它就能自己去查开奖。</p>';
    }

    if (aiD) {
      h += '<div class="zx-aidraw">' +
        '<div class="zx-aidraw-h"><span>AI 查到 · 第 ' + esc(aiD.issue) + ' 期</span><i>' + esc(aiD.date || '') + '</i></div>' +
        '<div class="zx-aidraw-b">' + ballRow(aiD.main) +
        (aiD.sub.length ? '<span class="zx-bsep"></span>' + ballRow(aiD.sub) : '') + '</div>' +
        (aiD.source ? '<a class="zx-aidraw-s" href="' + esc(aiD.source) + '" target="_blank" rel="noopener">' +
          esc(aiD.source.replace(/^https?:\/\//, '').slice(0, 42)) + '</a>' : '') +
        (aiD.guessed
          ? '<p class="zx-warn">它没给结构化的号码，这组是从它的原话里认出来的。填进下面的框，请对一眼。</p>'
          : '') +
        (aiD.issue !== aiD.queryIssue
          ? '<p class="zx-warn">它回复里写的是第 ' + esc(aiD.issue) + ' 期，跟你查的 ' + esc(aiD.queryIssue) +
            ' 对不上。这组号先别用。</p>' : '') +
        '<p class="zx-fine">AI 只抄号码。命中数、奖级、金额还是本机算。核对无误再结算。</p>' +
        '</div>';
    }
    if (ui.aiErr) {
      h += '<div class="zx-aierr">' + esc(ui.aiErr) +
        '<span>没关系，手动填一样能结算。</span>' +
        (ui.aiRaw ? '<details><summary>看 AI 原话</summary><pre>' + esc(ui.aiRaw) + '</pre></details>' : '') +
        '</div>';
    }

    h += '<button class="zx-btn primary wide" data-act="settle">' +
      (aiD ? '确认这组号，结算' : '结算这一期') + '</button>';
    h += '<p class="zx-fine">奖级在本机按官方奖级表算。越界、重复、缺号，一律拦下。</p>';
    h += '</section>';

    if (list.length > 1) {
      h += '<section class="zx-blk">';
      h += secHead('还有这些期没结', list.length + ' 期');
      list.forEach(function (iss) {
        h += '<button class="zx-iss" data-act="pick" data-i="' + iss + '">' +
          '<b>第 ' + esc(iss) + ' 期</b><i>' + issues[iss] + ' 注</i></button>';
      });
      h += '</section>';
    }

    return h;
  }

  /* ---------- 反思 ---------- */
  function logHTML() {
    var logs = readLogs();
    var h = '';
    if (!logs.length) {
      return '<section class="zx-blk"><div class="zx-empty">反思是结算之后自己写出来的。<br>还没有一期走到那一步。</div></section>';
    }
    var sum = { spend: 0, back: 0, hit: 0, n: 0, floatN: 0 };
    logs.forEach(function (g) {
      if (!g.tally) return;
      sum.spend += g.tally.spend; sum.back += g.tally.back; sum.hit += g.tally.hit;
      sum.floatN += (g.tally.floatN || 0);
      sum.n += Math.round(g.tally.spend / 2);
    });
    h += '<section class="zx-blk">';
    h += '<div class="zx-ledger">' +
      '<div><b>' + sum.n + '</b><i>注</i></div>' +
      '<div><b>¥' + sum.spend + '</b><i>投入</i></div>' +
      '<div><b class="' + (sum.back - sum.spend >= 0 ? 'up' : 'down') + '">¥' + (sum.back - sum.spend) + '</b><i>净' +
      (sum.floatN ? ' · 不含浮动' : '') + '</i></div>' +
      '</div>';
    h += '<p class="zx-fine">这本账一直记着。中奖 ' + sum.hit + ' 次' +
      (sum.floatN ? '，其中 ' + sum.floatN + ' 注是一/二等奖，金额浮动，没有计入上面的净额' : '') +
      '。竹芯不替你判断值不值，只保证数字不撒谎。</p>';
    h += '</section>';

    /* AI 读账 */
    var aiLog = readAI().logs[0];
    h += '<section class="zx-blk">';
    h += secHead('AI 读账', aiOn()
      ? (ui.aiRefErr ? '上次没读成' : (aiLog ? esc(aiLog.at.slice(5, 16).replace('T', ' ')) : '还没读过'))
      : '未配置 AI');
    if (aiOn()) {
      h += '<button class="zx-btn wide zx-ai-btn" data-act="aireflect"' + (ui.aiRefBusy ? ' disabled' : '') + '>' +
        (ui.aiRefBusy ? '<span class="zx-spin2"></span>DeepSeek 正在通读这批账…' : '<i class="zx-ai-ico">✦</i>让 AI 通读这批账，指出我错在哪') + '</button>';
    } else {
      h += '<p class="zx-fine">接上 AI 之后，它会通读最近 16 期，指出哪个族的先验错得最离谱。</p>';
    }
    if (ui.aiRefErr) {
      h += '<div class="zx-aierr">' + esc(ui.aiRefErr.msg) +
        '<span>' + (ui.aiRefErr.auto ? '它自己读的那一遍没按格式回，账本没动，也不影响出票。'
          : '原话在下面。它懂你的账，只是没照格式给结论。账本没动。') + '</span>' +
        (ui.aiRefErr.raw ? '<details><summary>看 AI 原话</summary><pre>' + esc(ui.aiRefErr.raw) + '</pre></details>' : '') +
        '</div>';
    }
    if (aiLog) {
      h += '<div class="zx-airead">';
      if (aiLog.read) h += '<p class="zx-airead-r">「' + esc(aiLog.read) + '」</p>';
      if (aiLog.bias && aiLog.bias.length) {
        h += '<div class="zx-chips2">';
        aiLog.bias.forEach(function (b) {
          h += '<span class="' + (b.delta > 0 ? 'up' : 'down') + '">' + esc(b.name) + ' ' +
            (b.delta > 0 ? '+' : '') + Math.round(b.delta * 18) + '% 权重</span>';
        });
        h += '</div>';
        h += '<div class="zx-airead-why">';
        aiLog.bias.forEach(function (b) {
          h += '<p><b>' + esc(b.name) + '</b>' + esc(b.why) + '</p>';
        });
        h += '</div>';
      }
      if (aiLog.watch && aiLog.watch.length) {
        h += '<p class="zx-airead-k">盯 · ' + aiLog.watch.map(function (x) { return '<code>' + esc(x) + '</code>'; }).join(' ') + '</p>';
      }
      if (aiLog.next) h += '<p class="zx-airead-k">下一批 · ' + esc(aiLog.next) + '</p>';
      h += '<p class="zx-fine">这些话只换成下期采样里 ±18% 的权重，不改先验，也不进账本。每两期减半——' +
        '说对了，影响留两期；说错了，八期左右归零。</p>';
      h += '</div>';
    }
    h += '</section>';

    logs.slice(0, 40).forEach(function (g) {
      h += '<section class="zx-log">';
      h += '<div class="zx-log-h"><b>第 ' + esc(g.issue) + ' 期</b>' +
        '<span>' + (g.draw && g.draw.main ? g.draw.main.map(pad2).join(' ') +
          (g.draw.sub && g.draw.sub.length ? ' + ' + g.draw.sub.map(pad2).join(' ') : '') : '') + '</span></div>';
      h += '<p class="zx-log-t">' + esc(g.text).replace(/\n/g, '<br>') + '</p>';
      if (g.rises && g.rises.length) {
        h += '<div class="zx-chips2">';
        g.rises.forEach(function (r) { h += '<span class="up">↑ ' + esc(r.name) + ' ' + pct(r.post, 1) + '</span>'; });
        g.falls.forEach(function (r) { h += '<span class="down">↓ ' + esc(r.name) + ' ' + pct(r.post, 1) + '</span>'; });
        h += '</div>';
      }
      h += '</section>';
    });
    return h;
  }

  /* ---------- 事件 ---------- */
  function bind(el) {
    el.addEventListener('click', function (e) {
      var tabBtn = up(e.target, '[data-tab]');
      if (tabBtn) { ui.tab = tabBtn.getAttribute('data-tab'); paint(); return; }

      var btn = up(e.target, '[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');

      if (act === 'close') { close(); return; }
      if (act === 'goto') { ui.tab = btn.getAttribute('data-to'); paint(); return; }
      if (act === 'game') {
        ui.game = btn.getAttribute('data-g');
        var c = readCfg(); c.game = ui.game; writeCfg(c);
        ui.plan = null; ui.aiDraw = null; ui.aiErr = ''; ui.aiRaw = ''; ui.aiIssue = '';
        paint(); return;
      }
      if (act === 'plan') {
        var r = planIssue(ui.game, PER_ISSUE);
        ui.plan = r;
        toast('出了 ' + r.tickets.length + ' 注，等开奖');
        paint(); return;
      }
      if (act === 'replan') {
        if (ui.plan && ui.plan.tickets && ui.plan.tickets.length) {
          var ids = ui.plan.tickets.map(function (t) { return t.id; });
          writeTickets(readTickets().filter(function (t) { return ids.indexOf(t.id) < 0; }));
          writeIssues(readIssues().filter(function (x) {
            return !(x.id === ui.plan.issue && x.game === ui.game);
          }));
        }
        ui.plan = null;
        paint();
        return;
      }
      if (act === 'aidraw') {
        if (ui.aiDrawBusy) return;
        var el = $('zxIssue');
        var want = (el && el.value.trim()) || nextIssue(ui.game);
        ui.aiIssue = want; ui.aiErr = ''; ui.aiDraw = null; ui.aiDrawBusy = true; ui.aiRaw = '';
        paint(false);
        aiDraw(ui.game, want).then(function (r) {
          ui.aiDrawBusy = false;
          if (r.ok && toInt(r.issue) !== toInt(want)) {
            ui.aiErr = '它查到的是第 ' + r.issue + ' 期，不是你要的 ' + want + ' 期。这组号不用。';
            ui.aiRaw = r.raw || '';
          } else if (r.ok) {
            r.queryIssue = want; ui.aiDraw = r; ui.aiIssue = want; ui.aiRaw = '';
            toast(r.guessed ? '认出来了，请核对号码' : '查到了，核对一下');
          } else {
            ui.aiErr = (r.msg === '没读懂 AI 的回复' ? '没读懂 AI 的回复' : '没查到：' + r.msg);
            ui.aiRaw = r.raw || '';
          }
          paint(false);
        }).catch(function (e) {
          ui.aiDrawBusy = false;
          ui.aiErr = (e && e.message) ? e.message : '联网失败';
          ui.aiRaw = '';
          paint(false);
        });
        return;
      }
      if (act === 'aireflect') {
        if (ui.aiRefBusy) return;
        ui.aiRefBusy = true;
        paint(false);
        aiReflect().then(function (r) {
          ui.aiRefBusy = false;
          if (!r.ok) {
            ui.aiRefErr = { msg: r.msg || '它没按格式回', raw: r.raw || '' };
            paint(false); return;
          }
          ui.aiRefErr = null;
          var n = applyBias(r);
          toast(n ? 'AI 动了 ' + n + ' 个族的权重' : '读了，但它没找到站得住的证据');
          paint(false);
        }).catch(function (e) {
          ui.aiRefBusy = false;
          toast((e && e.message) ? e.message : '联网失败');
          paint(false);
        });
        return;
      }
      if (act === 'aipropose') {
        if (ui.aiPropBusy) return;
        ui.aiPropBusy = true; ui.aiProp = null;
        paint(false);
        aiPropose(3).then(function (r) {
          ui.aiPropBusy = false;
          ui.aiProp = r;
          /* 结果就写在按钮下面，不再弹条子盖住"退回"那一行 */
          paint(false);
        }).catch(function (e) {
          ui.aiPropBusy = false;
          ui.aiProp = { ok: false, msg: (e && e.message) ? e.message : '联网失败' };
          paint(false);
        });
        return;
      }
      if (act === 'bt') {
        if (ui.btBusy) return;
        var bi0 = btInfo(ui.game);
        if (!bi0.pool) { toast('本机还没有开奖历史'); return; }
        ui.btBusy = true; ui.btPct = 0; ui.btMsg = '准备回放…';
        paint(false);
        backfill(ui.game, BT_MAX, function (i, total, r) {
          if (r.done) {
            ui.btBusy = false; ui.btPct = 100; ui.btMsg = '';
            if (r.dup) toast('这批已经回放过了');
            else toast('回放 ' + (r.periods || total) + ' 期 · ' + r.n + ' 注 · 中 ' + r.hit);
            paint(false);
            return;
          }
          ui.btPct = total ? (i / total) * 100 : 0;
          ui.btMsg = '正在回放 ' + i + '/' + total + ' 期…';
          paint(false);
        });
        return;
      }
      if (act === 'export') {
        try {
          var blob = new Blob([exportAll()], { type: 'application/json' });
          var a = root.document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'zhuxin-' + new Date().toISOString().slice(0, 10) + '.json';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
          toast('账本已导出');
        } catch (e) { toast('这台设备不允许下载'); }
        return;
      }
      if (act === 'wipe') {
        if (!root.confirm('清空所有状态样本、票和反思？这一步不可撤销。')) return;
        wipe();
        ui.plan = null;
        toast('清空了');
        paint();
        return;
      }
      if (act === 'fam') {
        var f = btn.getAttribute('data-f');
        ui.fam[f] = !ui.fam[f];
        paint(false); return;
      }
      if (act === 'st') {
        var sid = btn.getAttribute('data-s');
        ui.detail = ui.detail === sid ? null : sid;
        paint(false); return;
      }
      if (act === 'pick') {
        var i = $('zxIssue'); if (i) i.value = btn.getAttribute('data-i');
        var wrap = $('zxWrap'); if (wrap) wrap.scrollTop = 0;
        return;
      }
      if (act === 'settle') {
        var iss = ($('zxIssue') || {}).value || '';
        var dm = numArr(($('zxMain') || {}).value || '');
        var ds = numArr(($('zxSub') || {}).value || '');
        var g = gameOf(ui.game);
        if (dm.length !== g.mainCount) { toast('主号要 ' + g.mainCount + ' 个'); return; }
        if (ds.length !== g.subCount) { toast(g.subName + '要 ' + g.subCount + ' 个'); return; }
        var bad = dm.some(function (n) { return n < 1 || n > g.mainMax; }) ||
          ds.some(function (n) { return n < 1 || n > g.subMax; });
        if (bad) { toast('号码超出范围了'); return; }
        var res = settleIssue(ui.game, iss, dm, ds);
        if (!res.ok) { toast(res.msg || '结算失败'); return; }
        ui.plan = null;
        ui.aiDraw = null; ui.aiIssue = ''; ui.aiErr = ''; ui.aiRaw = '';
        toast(res.hit ? '中了 ' + res.hit + ' 注' : '这期没中');
        ui.tab = 'log';
        paint();
        autoReflect();
        return;
      }
    });
  }

  function ensureUI() {
    var doc = root.document;
    var el = doc.getElementById('zxPage');
    if (el && el.parentNode) { ui.el = el; return el; }
    el = doc.createElement('div');
    el.className = 'zx-page';
    el.id = 'zxPage';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = shell();
    doc.body.appendChild(el);
    ui.el = el;
    bind(el);
    return el;
  }

  function open() {
    var el = ensureUI();
    var cfg = readCfg();
    ui.game = cfg.game || 'ssq';
    ui.open = true;
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    root.document.body.classList.add('zx-locked');
    paint();
  }

  function close() {
    var el = root.document.getElementById('zxPage');
    if (el) { el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); }
    root.document.body.classList.remove('zx-locked');
    ui.open = false;
  }

  return {
    V: V, KEY: KEY, BASE_P: BASE_P, PRIOR_K: PRIOR_K, PER_ISSUE: PER_ISSUE, BT_W: BT_W,
    GAMES: GAMES, gameOf: gameOf, CATALOG: CATALOG, CAT_MAP: CAT_MAP,
    families: families, judge: judge,
    pct: pct, esc: esc, pad2: pad2, sum: sum, sortNum: sortNum, numArr: numArr, toInt: toInt,
    betaMean: betaMean, betaSd: betaSd, betaInv: betaInv,
    ctxOf: ctxOf, ctxFrom: ctxFrom, loadDraws: loadDraws,
    makeTicket: makeTicket, buildMain: buildMain,
    readStates: readStates, writeStates: writeStates,
    readTickets: readTickets, writeTickets: writeTickets,
    readIssues: readIssues, writeIssues: writeIssues,
    readLogs: readLogs, writeLogs: writeLogs,
    readCfg: readCfg, writeCfg: writeCfg,
    postOf: postOf, evidenceOf: evidenceOf, convergence: convergence,
    nextIssue: nextIssue, planIssue: planIssue, issueTickets: issueTickets, settleIssue: settleIssue,
    backfill: backfill, btInfo: btInfo, catSig: catSig,
    stats: stats, exportAll: exportAll, wipe: wipe,
    _ai: {
      on: aiOn, draw: aiDraw, reflect: aiReflect, propose: aiPropose,
      applyBias: applyBias, bias: function () { return readAI().bias; },
      log: function () { return readAI().logs[0] || null; },
      logs: function () { return readAI().logs; },
      props: function () { return readAI().props; }
    },
    open: open, close: close, isOpen: function () { return !!(ui && ui.open); },
    _ui: function () { return ui; }
  };
});
