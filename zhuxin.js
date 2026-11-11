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

  var V = '2.0.0';
  var KEY = {
    states: 'bamboo.v19.zx.states',
    tickets: 'bamboo.v19.zx.tickets',
    issues: 'bamboo.v19.zx.issues',
    logs: 'bamboo.v19.zx.logs',
    cfg: 'bamboo.v19.zx.cfg'
  };
  var LIM = { tickets: 800, logs: 400, issues: 240 };
  var BASE_P = 0.0625;   /* 最低奖级门槛：双色球中蓝球 1/16，任何选法都改不了 */
  var PRIOR_K = 40;      /* 先验强度：相当于 40 次虚拟观测，样本超过它，数据才开始说话 */
  var PER_ISSUE = 3;     /* 每期出 3 注，样本攒得快一点 */

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

  function ctxOf(gameKey) {
    var g = gameOf(gameKey);
    var draws = loadDraws(gameKey);
    var prev = draws[0] || null;
    var omission = {}, hot = {};
    var n, i;
    for (n = 1; n <= g.mainMax; n++) { omission[n] = 99; hot[n] = 0; }
    for (i = 0; i < draws.length && i < 60; i++) {
      (draws[i].main || []).forEach(function (x) {
        hot[x] = (hot[x] || 0) + 1;
        if (omission[x] === 99) omission[x] = i;
      });
    }
    for (n = 1; n <= g.mainMax; n++) if (omission[n] === 99) omission[n] = 60;
    return {
      g: g, draws: draws,
      prevMain: prev ? prev.main : null,
      prevSub: prev ? prev.sub : null,
      omission: omission, hot: hot, count: draws.length
    };
  }

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
  function postOf(st, prior) {
    var p0 = (prior == null ? BASE_P : prior);
    var a = p0 * PRIOR_K + st.k;
    var b = (1 - p0) * PRIOR_K + (st.n - st.k);
    return {
      a: a, b: b,
      mean: betaMean(a, b),
      sd: betaSd(a, b),
      lo: betaInv(a, b, 0.05),
      hi: betaInv(a, b, 0.95),
      priorMean: p0,
      shift: betaMean(a, b) - p0
    };
  }
  function evidenceOf(st) {
    if (!st || st.n <= 0) return { level: 0, text: '无样本' };
    if (st.n < 20) return { level: 1, text: '样本不足，当前数字基本是噪声' };
    if (st.n < 60) return { level: 2, text: '样本偏少，只能看方向' };
    if (st.n < 150) return { level: 3, text: '样本可用，仍可能有偶然' };
    return { level: 4, text: '样本较足，可信度较高' };
  }

  /* 逼近度 = 证据量折算。不是中奖率，是这台机器攒了多少次真实观测。
     260 注到 63%，600 注到 90%——永远逼近，永远不到。
     同时给出"后验收窄"这个物理量，供状态详情核对。 */
  function convergence(states) {
    var total = 0, n0 = 0, covered = 0, sd0 = 0, sd1 = 0;
    CATALOG.forEach(function (c) {
      var st = states[c.id] || { n: 0, k: 0 };
      total += st.n;
      n0++;
      if (st.n > 0) covered++;
      var a0 = c.prior * PRIOR_K, b0 = (1 - c.prior) * PRIOR_K;
      sd0 += betaSd(a0, b0);
      sd1 += betaSd(a0 + st.k, b0 + (st.n - st.k));
    });
    return {
      pct: clamp((1 - Math.exp(-total / 260)) * 100, 0, 99.5),
      shrink: sd0 > 0 ? (1 - sd1 / sd0) * 100 : 0,
      samples: total, states: n0, covered: covered
    };
  }

  /* ============ 选状态：Thompson 采样 + 探索保底 ============ */
  function pickStates(k, states, ctx) {
    var draws = CATALOG.map(function (c) {
      var st = states[c.id] || { n: 0, k: 0 };
      var a0 = c.prior * PRIOR_K, b0 = (1 - c.prior) * PRIOR_K;
      var a = a0 + st.k, b = b0 + (st.n - st.k);
      return { id: c.id, v: betaDraw(a, b, Math.random), n: st.n };
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
    var hit = 0, spend = 0, back = 0, floatN = 0, touched = [];

    tickets.forEach(function (t) {
      if (t.game !== gameKey || t.issue !== issue || t.settled) return;
      var r = judge(gameKey, t, { main: dm, sub: ds });
      t.settled = true;
      t.result = r;
      hit += r.hit ? 1 : 0;
      spend += 2;
      if (r.money > 0) back += r.money;
      else if (r.money < 0) floatN++;

      var st = states[t.stateId];
      if (!st) return;
      st.n += 1;
      if (r.hit) { st.k += 1; st.win += 1; st.money += (r.money > 0 ? r.money : 0); }
      if (r.tier && (!st.best || r.tier < st.best)) st.best = r.tier;
      var pc = CAT_MAP[t.stateId].prior;
      st.trail = (st.trail || []).concat([{
        i: issue, n: st.n, k: st.k,
        p: Number(betaMean(pc * PRIOR_K + st.k, (1 - pc) * PRIOR_K + st.n - st.k).toFixed(4))
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

    var log = buildLog(gameKey, issue, dm, ds, touched, states, { hit: hit, spend: spend, back: back, floatN: floatN });
    var logs = readLogs();
    logs.unshift(log);
    writeLogs(logs);

    return { ok: true, issue: issue, hit: hit, spend: spend, back: back, log: log, draw: { main: dm, sub: ds } };
  }

  /* ============ 反思 ============ */
  function buildLog(gameKey, issue, dm, ds, touched, states, tally) {
    var rises = [], falls = [], refuted = [], thin = [];
    var starts = [], thin = [];
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
      thinCount: thin.length,
      text: lines.join('\n'),
      ai: ''
    };
  }

  /* ============ 统计 ============ */
  function exportAll() {
    return JSON.stringify({
      app: 'zhuxin', v: V, at: nowISO(),
      states: readStates(), tickets: readTickets(),
      issues: readIssues(), logs: readLogs(), cfg: readCfg()
    }, null, 2);
  }
  function wipe() {
    Object.keys(KEY).forEach(function (k) {
      try { root.localStorage.removeItem(KEY[k]); } catch (e) { }
    });
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
  var ui = { open: false, tab: 'core', game: 'ssq', plan: null, fam: {}, detail: null, toastT: 0, el: null };

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
      '<button data-tab="issue">开一期</button>' +
      '<button data-tab="lib">状态库</button>' +
      '<button data-tab="settle">结算</button>' +
      '<button data-tab="log">反思</button>' +
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
      '<div><b id="zxSamp">' + conv.samples + '</b><i>累计样本</i></div>' +
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
      '<span>样本 <b>' + conv.samples + '</b></span>' +
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
      h += '<section class="zx-blk">';
      h += secHead('第 ' + cur.issue + ' 期', '三注 · 三个状态');
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
    var h = '';
    h += '<section class="zx-blk">';
    h += '<div class="zx-libtop">' +
      '<div><b>' + CATALOG.length + '</b><i>个状态</i></div>' +
      '<div><b>' + fams.length + '</b><i>个族</i></div>' +
      '<div><b>' + CATALOG.filter(function (c) { return states[c.id] && states[c.id].n > 0; }).length + '</b><i>有样本</i></div>' +
      '</div>';
    h += '<p class="zx-fine">族是方向，型是手法，状态才是真正拿去下注的那一格。点开看每个状态的编号、规则和它的偏见。</p>';
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
    h += '<span class="zx-st-l"><code>' + esc(sid.replace(/^S\./, '')) + '</code><b>' + esc(c.name) + '</b></span>';
    h += '<span class="zx-st-r"><i>' + pct(p.mean, 1) + '</i><em>' + st.n + ' 注</em></span>';
    h += '<span class="zx-st-bar"><i style="width:' + w.toFixed(1) + '%"></i></span>';
    h += '</button>';
    if (det) h += stateDetail(c, st, p);
    return h;
  }

  function stateDetail(c, st, p) {
    var ev = evidenceOf(st);
    var h = '<div class="zx-det">';
    h += '<div class="zx-det-id"><code>' + esc(c.id) + '</code></div>';
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
      '样本 ' + st.n + ' 注、中 ' + st.k + ' 次。' + esc(ev.text) + '。</p>';
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

    h += '<section class="zx-blk">';
    h += secHead('录入开奖', '第 ' + def + ' 期 · ' + tickets.filter(function (t) { return t.issue === def; }).length + ' 注待结');
    h += '<div class="zx-form">' +
      '<label><span>期号</span><input id="zxIssue" value="' + esc(def) + '" inputmode="numeric"></label>' +
      '<label><span>主号（' + g.mainCount + ' 个）</span><input id="zxMain" placeholder="' + (ui.game === 'ssq' ? '01 05 12 18 23 30' : '02 09 17 24 33') + '" inputmode="numeric"></label>' +
      '<label><span>' + g.subName + '（' + g.subCount + ' 个）</span><input id="zxSub" placeholder="' + (ui.game === 'ssq' ? '08' : '03 11') + '" inputmode="numeric"></label>' +
      '</div>';
    h += '<button class="zx-btn primary wide" data-act="settle">结算这一期</button>';
    h += '<p class="zx-fine">奖级按官方奖级表在本机算，不联网、不问模型。号码超出范围的会被拦下。</p>';
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
        ui.plan = null; paint(); return;
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
        toast(res.hit ? '中了 ' + res.hit + ' 注' : '这期没中');
        ui.tab = 'log';
        paint();
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
    V: V, KEY: KEY, BASE_P: BASE_P, PRIOR_K: PRIOR_K, PER_ISSUE: PER_ISSUE,
    GAMES: GAMES, gameOf: gameOf, CATALOG: CATALOG, CAT_MAP: CAT_MAP,
    families: families, judge: judge,
    pct: pct, esc: esc, pad2: pad2, sum: sum, sortNum: sortNum, numArr: numArr, toInt: toInt,
    betaMean: betaMean, betaSd: betaSd, betaInv: betaInv,
    ctxOf: ctxOf, loadDraws: loadDraws,
    makeTicket: makeTicket, buildMain: buildMain,
    readStates: readStates, writeStates: writeStates,
    readTickets: readTickets, writeTickets: writeTickets,
    readIssues: readIssues, writeIssues: writeIssues,
    readLogs: readLogs, writeLogs: writeLogs,
    readCfg: readCfg, writeCfg: writeCfg,
    postOf: postOf, evidenceOf: evidenceOf, convergence: convergence,
    nextIssue: nextIssue, planIssue: planIssue, issueTickets: issueTickets, settleIssue: settleIssue,
    stats: stats, exportAll: exportAll, wipe: wipe,
    open: open, close: close, isOpen: function () { return !!(ui && ui.open); },
    _ui: function () { return ui; }
  };
});
