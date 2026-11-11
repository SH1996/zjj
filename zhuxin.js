/* 竹间记 · 竹芯 ZhuXin
 * 一个「状态 → 号码」的归纳机。不是预测器。
 *
 * 边界（写在代码里，也写在界面上）：
 *   公平开奖各期独立，任何状态都不能改变一注号码的中奖概率。
 *   竹芯做的是：把「买之前我是什么状态」记下来，让同样的状态永远出同样的号，
 *   再按期对比「哪种状态写出来的号更像开奖号的结构」。
 *   它积累的是你自己的样本，不是宇宙的规律。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ZhuXin = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  var V = '1.0.0';
  var KEY = {
    states: 'bamboo.v18.zx.states',
    rounds: 'bamboo.v18.zx.rounds',
    notes: 'bamboo.v18.zx.insights',
    cfg: 'bamboo.v18.zx.cfg'
  };
  var MAX_STATES = 160;
  var MAX_ROUNDS = 120;
  var MAX_NOTES = 240;

  /* =========================================================
     一、六个维度
     一个状态 = 六个词。六个词定死一注号。
  ========================================================= */

  var DIMS = [
    { key: 'mood', label: '心情', q: '买之前那会儿，心里是什么样', values: [
      { v: '亢奋', d: '手快，想多买' },
      { v: '平静', d: '就是顺手' },
      { v: '发闷', d: '堵着一口气' },
      { v: '焦虑', d: '想抓住点什么' },
      { v: '空落', d: '没什么感觉' },
      { v: '侥幸', d: '觉得这次也许' }
    ]},
    { key: 'hour', label: '时辰', q: '几点买的', values: [
      { v: '清晨', d: '五六点' }, { v: '上午', d: '九点到十一点' },
      { v: '午后', d: '一两点' }, { v: '黄昏', d: '天刚暗' },
      { v: '夜里', d: '八九点' }, { v: '深夜', d: '过了十一点' }
    ]},
    { key: 'body', label: '身体', q: '身上什么感觉', values: [
      { v: '清爽', d: '睡够了' }, { v: '饱胀', d: '刚吃完' },
      { v: '饿', d: '还没吃' }, { v: '困', d: '眼睛发涩' },
      { v: '发冷', d: '手脚凉' }, { v: '出汗', d: '黏糊糊' }
    ]},
    { key: 'scene', label: '场景', q: '人在哪儿', values: [
      { v: '店里', d: '收银台后' }, { v: '路上', d: '走着' },
      { v: '床上', d: '躺着' }, { v: '门口', d: '抽根烟' },
      { v: '刷手机', d: '划着划着' }, { v: '等车', d: '站着发呆' }
    ]},
    { key: 'trigger', label: '起因', q: '怎么想起买的', values: [
      { v: '做梦', d: '醒来还记得' }, { v: '看见数', d: '车牌门牌、电梯楼层' },
      { v: '纯直觉', d: '说不上来' }, { v: '谁说的', d: '别人提了一句' },
      { v: '差一个', d: '上期差一个号，不服' }, { v: '想买', d: '没理由，就是想买' }
    ]},
    { key: 'source', label: '取号法', q: '号是怎么写出来的', values: [
      { v: '生日', d: '家里人的日子' }, { v: '车牌', d: '车牌门牌，眼前看到的数' },
      { v: '手感', d: '随手点' }, { v: '改一个', d: '上期改一两个号' },
      { v: '随手划', d: '闭眼乱写' }, { v: '竹芯给', d: '交给它挑' }
    ]}
  ];

  var DIM_MAP = {};
  DIMS.forEach(function (d) { DIM_MAP[d.key] = d; });

  /* =========================================================
     二、工具
  ========================================================= */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function toInt(x) { var n = Number(x); return isFinite(n) ? Math.round(n) : 0; }
  function uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) if (!s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } return o; }
  function sortNum(a) { return a.slice().sort(function (x, y) { return x - y; }); }
  function inter(a, b) {
    var s = {}, n = 0;
    for (var i = 0; i < a.length; i++) s[a[i]] = 1;
    for (var j = 0; j < b.length; j++) if (s[b[j]]) n++;
    return n;
  }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fnv(str) {
    var h = 2166136261, s = String(str);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function todayKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function nowISO() { return new Date().toISOString(); }

  /* =========================================================
     三、彩种（优先用数彩实验室的定义，避免两套参数）
  ========================================================= */

  var FALLBACK_GAMES = {
    ssq: { key: 'ssq', name: '双色球', mainName: '红球', subName: '蓝球', mainMax: 33, mainPick: 6, subMax: 16, subPick: 1 },
    dlt: { key: 'dlt', name: '超级大乐透', mainName: '前区', subName: '后区', mainMax: 35, mainPick: 5, subMax: 12, subPick: 2 }
  };
  function games() {
    var L = root && root.LotteryLab;
    return (L && L.GAMES) ? L.GAMES : FALLBACK_GAMES;
  }
  function gameOf(k) { return games()[k] || FALLBACK_GAMES.ssq; }
  function LL() { return (root && root.LotteryLab) || null; }

  /* =========================================================
     四、状态 → 权重倾向
     每个词只贡献几条倾向，叠起来就是「这个人的选号手感」。
  ========================================================= */

  // low/high/mid：偏小、偏大、偏中段
  // odd/even：偏奇、偏偶
  // spread：跨度要大（散）
  // cluster：要连号（挤）
  // near：贴着上期号 ±1~3
  // repeat：含上期号
  var BIAS = {
    mood: {
      '亢奋': { odd: .55, high: .35, spread: .5 },
      '平静': {},
      '发闷': { mid: .8, cluster: .5 },
      '焦虑': { spread: .7, high: .25, odd: .2 },
      '空落': { low: .55, even: .35 },
      '侥幸': { near: .6, repeat: .5 }
    },
    hour: {
      '清晨': { low: .7, even: .2 },
      '上午': { low: .35, mid: .3 },
      '午后': { mid: .55 },
      '黄昏': { high: .3, odd: .25 },
      '夜里': { high: .45, spread: .3 },
      '深夜': { high: .6, spread: .45, odd: .2 }
    },
    body: {
      '清爽': { spread: .2 },
      '饱胀': { mid: .6, cluster: .3 },
      '饿': { low: .5, cluster: .45 },
      '困': { cluster: .8, low: .3 },
      '发冷': { high: .45, odd: .3 },
      '出汗': { odd: .5, spread: .3 }
    },
    scene: {
      '店里': { mid: .3, repeat: .2 },
      '路上': { spread: .4, odd: .2 },
      '床上': { low: .4, cluster: .5 },
      '门口': { spread: .3, even: .2 },
      '刷手机': { near: .5, high: .2 },
      '等车': { mid: .4, even: .25 }
    },
    trigger: {
      '做梦': { low: .3, cluster: .6, even: .2 },
      '看见数': { near: .9, repeat: .4 },
      '纯直觉': { spread: .35 },
      '谁说的': { mid: .45, repeat: .3 },
      '差一个': { repeat: 1.1, near: .7 },
      '想买': {}
    },
    source: {
      '生日': { low: 1.15, even: .25 },
      '车牌': { mid: .5, cluster: .35 },
      '手感': { spread: .5 },
      '改一个': { repeat: 1.25, near: .5 },
      '随手划': { spread: .6, odd: .2 },
      '竹芯给': { spread: .3, mid: .2 }
    }
  };

  function biasOf(dims) {
    var b = {}, i, d, map, add;
    for (i = 0; i < DIMS.length; i++) {
      d = DIMS[i];
      map = BIAS[d.key] && BIAS[d.key][dims[d.key]];
      if (!map) continue;
      for (var k in map) {
        if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
        add = map[k];
        // 同一族取「更大那个 + 小幅叠加」，避免六维叠成一团
        if (b[k] == null) b[k] = add;
        else b[k] = Math.max(b[k], add) + Math.min(b[k], add) * 0.28;
      }
    }
    return b;
  }

  function nearFactor(n, prevMain) {
    if (!prevMain || !prevMain.length) return 0;
    var best = 99;
    for (var i = 0; i < prevMain.length; i++) best = Math.min(best, Math.abs(n - prevMain[i]));
    if (best === 0) return 0;
    if (best <= 3) return (4 - best) / 3;
    return 0;
  }

  function numberWeight(n, max, b, prevMain) {
    var t = max > 1 ? (n - 1) / (max - 1) : 0;
    var w = 1;
    if (b.low) w *= 1 + b.low * Math.pow(1 - t, 1.6);
    if (b.high) w *= 1 + b.high * Math.pow(t, 1.6);
    if (b.mid) w *= 1 + b.mid * Math.exp(-Math.pow((t - .5) / .26, 2));
    if (b.odd) w *= (n % 2 ? 1 + b.odd : 1);
    if (b.even) w *= (n % 2 ? 1 : 1 + b.even);
    if (b.near && prevMain && prevMain.length) w *= 1 + b.near * nearFactor(n, prevMain);
    if (b.repeat && prevMain && prevMain.indexOf(n) >= 0) w *= 1 + b.repeat;
    return w;
  }

  function weightedPick(pool, k, rng) {
    var left = pool.slice(), out = [];
    while (out.length < k && left.length) {
      var tot = 0, i;
      for (i = 0; i < left.length; i++) tot += left[i].w;
      var r = rng() * tot, acc = 0, idx = left.length - 1;
      for (i = 0; i < left.length; i++) { acc += left[i].w; if (r <= acc) { idx = i; break; } }
      out.push(left[idx].n);
      left.splice(idx, 1);
    }
    return sortNum(out);
  }

  /* 抽完再做一次「结构归位」：让状态里写的那几条倾向真的落在号上 */
  function shapeUp(main, g, b, prevMain, rng, q) {
    var arr = sortNum(uniq(main));
    var i, cand;

    function freeIn(lo, hi, used) {
      var pool = [];
      for (var n = lo; n <= hi; n++) if (used.indexOf(n) < 0) pool.push(n);
      return pool.length ? pool[Math.floor(rng() * pool.length)] : 0;
    }
    function has(n, a) { return a.indexOf(n) >= 0; }

    // 1) 上期号：说了要贴，就保证至少带一个
    if (b.repeat && b.repeat >= 0.8 && prevMain && prevMain.length) {
      var hit = prevMain.filter(function (n) { return has(n, arr); });
      if (!hit.length) {
        var fromPrev = prevMain[Math.floor(rng() * prevMain.length)];
        var dropIdx = rng() < .5 ? 0 : arr.length - 1;
        arr.splice(dropIdx, 1);
        arr.push(fromPrev);
        arr = sortNum(uniq(arr));
      }
    }

    // 2) 连号：说了要挤，就保证一对
    if (b.cluster && b.cluster >= 0.6) {
      var pair = false;
      for (i = 1; i < arr.length; i++) if (arr[i] === arr[i - 1] + 1) { pair = true; break; }
      if (!pair) {
        var base = arr[1 + Math.floor(rng() * (arr.length - 1))];
        var nb = base + 1 <= g.mainMax && !has(base + 1, arr) ? base + 1
               : (base - 1 >= 1 && !has(base - 1, arr) ? base - 1 : 0);
        if (nb) {
          var far = arr.slice().sort(function (x, y) {
            return Math.abs(y - base) - Math.abs(x - base);
          })[0];
          var at = arr.indexOf(far);
          if (at >= 0) { arr[at] = nb; arr = sortNum(uniq(arr)); }
        }
      }
    }

    // 3) 跨度：说了要散，就把最挤那头的号换到远端
    if (b.spread && b.spread >= 0.55) {
      var want = Math.ceil(g.mainMax * 0.62);
      if (arr[arr.length - 1] - arr[0] < want) {
        var mid = (arr[0] + arr[arr.length - 1]) / 2;
        var nearest = arr.slice().sort(function (x, y) { return Math.abs(x - mid) - Math.abs(y - mid); })[0];
        var rep = rng() < .5
          ? freeIn(g.mainMax - Math.floor(g.mainMax * .2), g.mainMax, arr)
          : freeIn(1, Math.max(2, Math.floor(g.mainMax * .2)), arr);
        if (rep) {
          var p = arr.indexOf(nearest);
          if (p >= 0) { arr[p] = rep; arr = sortNum(uniq(arr)); }
        }
      }
    }

    // 4) 和值：只在偏得离谱时拉一把。
    //    不强制落进 IQR —— 一强制，所有状态的和值就都一样，状态之间的差别被抹平了，
    //    后面「结构分」也就没有区分度。
    if (q && q[0] > 0 && q[2] > 0) {
      for (var tryN = 0; tryN < 6; tryN++) {
        var s = sum(arr), lo = q[0] * 0.62, hi = q[2] * 1.45;
        if (s >= lo && s <= hi) break;
        var worst, to;
        if (s < lo) { worst = arr[0]; to = freeIn(Math.ceil(g.mainMax * .55), g.mainMax, arr); }
        else { worst = arr[arr.length - 1]; to = freeIn(1, Math.floor(g.mainMax * .45), arr); }
        if (!to) break;
        var wi = arr.indexOf(worst);
        arr[wi] = to;
        arr = sortNum(uniq(arr));
      }
    }
    return arr;
  }

  function subWeights(max, b, prevSub, rng) {
    var pool = [], n;
    for (n = 1; n <= max; n++) {
      var w = 1;
      // 蓝球/后区不吃大小区偏好（只有 12~16 个号），只吃奇偶与贴号
      if (b.odd) w *= (n % 2 ? 1 + b.odd * .5 : 1);
      if (b.even) w *= (n % 2 ? 1 : 1 + b.even * .5);
      if (b.near && prevSub && prevSub.length) w *= 1 + b.near * .5 * nearFactor(n, prevSub);
      if (b.repeat && prevSub && prevSub.indexOf(n) >= 0) w *= 1 + b.repeat * .5;
      w *= 0.94 + rng() * 0.12;
      pool.push({ n: n, w: w });
    }
    return pool;
  }

  /* =========================================================
     五、基站点：同一个状态，永远出同一注
     seed = 状态 + 彩种 + 锚期（不给锚期就是固定的一注）
  ========================================================= */

  function stateKeyOf(dims) {
    return DIMS.map(function (d) { return d.key + ':' + (dims[d.key] || ''); }).join('|');
  }
  function normalizeDims(dims) {
    var o = {};
    DIMS.forEach(function (d) {
      var v = dims && dims[d.key];
      var ok = d.values.some(function (x) { return x.v === v; });
      o[d.key] = ok ? v : d.values[0].v;
    });
    return o;
  }
  function stateNameOf(dims) {
    return [dims.hour, dims.body, dims.source].filter(Boolean).join(' · ');
  }

  function basePoint(dims, gameKey, opts) {
    opts = opts || {};
    var g = gameOf(gameKey);
    var b = biasOf(dims);
    var prevMain = opts.prevMain || null, prevSub = opts.prevSub || null;
    var q = opts.sumQ || null;
    var anchor = opts.anchor || 'base';
    var seed = fnv(stateKeyOf(dims) + '#' + gameKey + '#' + anchor);
    var rng = mulberry32(seed);

    var pool = [], n;
    for (n = 1; n <= g.mainMax; n++) pool.push({ n: n, w: numberWeight(n, g.mainMax, b, prevMain) });
    var main = weightedPick(pool, g.mainPick, rng);
    main = shapeUp(main, g, b, prevMain, rng, q);
    var sub = weightedPick(subWeights(g.subMax, b, prevSub, rng), g.subPick, rng);

    return { main: main, sub: sub, seed: seed.toString(36), anchor: anchor };
  }

  /* =========================================================
     六、竹芯分
     五项：结构 / 贴合 / 稀缺 / 状态 / 老实
     100 分是「这一注写得像不像话」，不是中奖概率。
  ========================================================= */

  function quantileOf(values, q) {
    if (!values.length) return 0;
    var a = values.slice().sort(function (x, y) { return x - y; });
    var pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  function analysisOf(draws, gameKey, win) {
    var L = LL();
    if (L && L.analyze && draws && draws.length >= 8) {
      try { return L.analyze(draws, gameKey, win || 60); } catch (e) {}
    }
    return null;
  }

  function localStructure(main, prevMain, max) {
    var odd = 0, zones = [0, 0, 0], cons = 0, i;
    var b1 = Math.ceil(max / 3), b2 = Math.ceil(max * 2 / 3);
    for (i = 0; i < main.length; i++) {
      if (main[i] % 2) odd++;
      zones[main[i] <= b1 ? 0 : (main[i] <= b2 ? 1 : 2)]++;
      if (i && main[i] === main[i - 1] + 1) cons++;
    }
    return {
      odd: odd, sum: sum(main), span: main[main.length - 1] - main[0],
      zones: zones, consecutive: cons, repeat: prevMain ? inter(main, prevMain) : 0
    };
  }

  function scoreTicket(ticket, gameKey, ctx) {
    ctx = ctx || {};
    var g = gameOf(gameKey);
    var main = sortNum(ticket.main), sub = sortNum(ticket.sub);
    var draws = ctx.draws || [];
    var a = ctx.analysis || analysisOf(draws, gameKey, 60);
    var prev = ctx.prevMain || (draws[0] ? draws[0].main : null);
    var st = localStructure(main, prev, g.mainMax);

    var parts = [], total = 0;

    /* 结构 26：和值、跨度、奇偶、三区。全是连续函数——擦边的给擦边的分。 */
    var sSum = 7, sSpan = 3, sOdd = 3, sZone = 3, structNotes = [];
    if (a && a.sumQ && a.sumQ[1] > 0) {
      var med = a.sumQ[1], iqr = Math.max(2, a.sumQ[2] - a.sumQ[0]);
      sSum = 12 * Math.exp(-Math.pow((st.sum - med) / (iqr * 1.05), 2));
      if (Math.abs(st.sum - med) > iqr) structNotes.push('和值 ' + st.sum + ' 离常见带有点远');
      var spMed = a.spanQ[1], spIqr = Math.max(2, a.spanQ[2] - a.spanQ[0]);
      sSpan = 5 * Math.exp(-Math.pow((st.span - spMed) / (spIqr * 1.35), 2));
      if (st.span < spIqr) structNotes.push('跨度 ' + st.span + ' 偏窄');
      var oddMode = toInt(a.oddMode && a.oddMode.key);
      sOdd = 5 * Math.exp(-Math.pow(st.odd - oddMode, 2) / 0.55);
      if (Math.abs(st.odd - oddMode) >= 2) structNotes.push('奇偶 ' + st.odd + ':' + (g.mainPick - st.odd) + ' 偏');
      var zc = st.zones.filter(function (x) { return x > 0; }).length;
      sZone = 4 * Math.pow(zc / 3, 1.5);
      if (zc < 3) structNotes.push('三区断了一区');
    } else {
      sSum = 7; sSpan = 3; sOdd = 3; sZone = 3;
    }
    var sStruct = clamp(sSum + sSpan + sOdd + sZone, 0, 26);
    parts.push({ k: '结构', v: Math.round(sStruct), max: 26, hint: '和值、跨度、奇偶、三区' });
    total += sStruct;

    /* 贴合 18：跟近 20 期平均重合，太冷太热都掉分 */
    var sFit = 9, fitNote = '', avgOv = 0;
    if (draws.length >= 5) {
      var recent = draws.slice(0, 20), acc = 0;
      recent.forEach(function (d) { acc += inter(main, d.main); });
      avgOv = acc / recent.length;
      sFit = 18 * Math.exp(-Math.pow((avgOv - 1.35) / 0.62, 2));
      if (avgOv > 2.4) { sFit *= 0.62; fitNote = '和近 20 期重合 ' + avgOv.toFixed(1) + ' 个，太跟风'; }
      else if (avgOv < 0.6) { sFit *= 0.8; fitNote = '和近 20 期重合 ' + avgOv.toFixed(1) + ' 个，偏冷'; }
      else fitNote = '和近 20 期重合 ' + avgOv.toFixed(1) + ' 个';
      if (prev && inter(main, prev) === g.mainPick) { sFit = 2; fitNote = '和上一期一模一样'; }
    }
    parts.push({ k: '贴合', v: Math.round(sFit), max: 18, hint: fitNote || '近 20 期重合度' });
    total += sFit;

    /* 稀缺 22：一半看「这个和值+奇偶的历史少见度」，一半看「这几个号被开出的频率」 */
    var sFp = 11, sFq = 11, fpCnt = 0, freq = 0, freqExp = 0;
    if (draws.length >= 12) {
      // 指纹：和值按 10 一档 + 奇偶个数，历史里同指纹出现几次
      var sumBucket = Math.floor(st.sum / 10);
      for (var i = 0; i < draws.length; i++) {
        var ds = sum(draws[i].main);
        var dOdd = draws[i].main.filter(function (n) { return n % 2; }).length;
        if (Math.floor(ds / 10) === sumBucket && dOdd === st.odd) fpCnt++;
      }
      sFp = 11 * Math.pow(1 - Math.min(fpCnt, 4) / 4, 1.1);

      // 热频：这注 6 个号在过去 80 期里被开出多少次
      var freqMap = {};
      draws.forEach(function (d) { d.main.forEach(function (n) { freqMap[n] = (freqMap[n] || 0) + 1; }); });
      main.forEach(function (n) { freq += (freqMap[n] || 0); });
      freqExp = main.length * draws.length * g.mainPick / g.mainMax;
      sFq = 11 * clamp(1.16 - (freq / freqExp) * 0.46, 0, 1);
    }
    var sRare = clamp(sFp + sFq, 0, 22);
    var rareHint = fpCnt >= 3 ? ('这种和值+奇偶的组合，历史里出现过 ' + fpCnt + ' 次')
      : ('这几个号累计被开出 ' + freq + ' 次（平均 ' + Math.round(freqExp) + ' 次）');
    parts.push({ k: '稀缺', v: Math.round(sRare), max: 22, hint: rareHint });
    total += sRare;

    /* 状态 24：这个状态以前的成绩，样本少就往中间收 */
    var sState = 12, stNote = '这个状态还是头一回，先给中间分';
    var s = ctx.state;
    if (s && s.used > 0) {
      var rate = (s.mainHits || 0) / s.used;
      var exp0 = g.mainPick * g.mainPick / g.mainMax;
      var shrunk = (rate * s.used + exp0 * 5) / (s.used + 5);
      sState = clamp(24 * (0.16 + 0.34 * (shrunk / exp0)), 0, 24);
      stNote = '用过 ' + s.used + ' 次，平均中 ' + rate.toFixed(2) + ' 个（任意一注约 ' + exp0.toFixed(2) + '）';
    }
    parts.push({ k: '状态', v: Math.round(sState), max: 24, hint: stNote });
    total += sState;

    /* 老实 10：扣掉那些看着就像「随手糊出来」的写法 */
    var sHon = 10, honNotes = [];
    if (main[main.length - 1] <= 31 && g.mainMax > 31) { sHon -= 3; honNotes.push('全是 31 以内的号，像生日'); }
    if (st.consecutive >= 3) { sHon -= 2; honNotes.push('连号太多'); }
    if (st.odd === 0 || st.odd === g.mainPick) { sHon -= 2; honNotes.push('全奇或全偶'); }
    var tails = {}, maxTail = 0;
    main.forEach(function (n) { var t = n % 10; tails[t] = (tails[t] || 0) + 1; maxTail = Math.max(maxTail, tails[t]); });
    if (maxTail >= 4) { sHon -= 2; honNotes.push('同尾太多'); }
    if (prev && inter(main, prev) >= g.mainPick - 1) { sHon -= 4; honNotes.push('几乎照抄上期'); }
    sHon = clamp(sHon, 0, 10);
    parts.push({ k: '老实', v: Math.round(sHon), max: 10, hint: honNotes.length ? honNotes.join('；') : '没有明显糊弄的结构' });
    total += sHon;

    /* 总分：五项取几何平均再放大。
       加法分的问题是「五项都及格 = 80 分」，看不出短板；
       几何平均会把最差那项拽住——四项好、一项塌，就是起不来。 */
    var ws = [
      clamp(sStruct / 26, 0.02, 1),
      clamp(sFit / 18, 0.02, 1),
      clamp(sRare / 22, 0.02, 1),
      clamp(sState / 24, 0.02, 1),
      clamp(sHon / 10, 0.02, 1)
    ];
    var geo = Math.pow(ws[0] * ws[1] * ws[2] * ws[3] * ws[4], 0.2);
    total = clamp(Math.round(92 * Math.pow(geo, 1.35)), 0, 100);

    return {
      total: total,
      parts: parts,
      band: bandOf(total),
      struct: st,
      avgOverlap: avgOv,
      freq: freq, freqExp: freqExp,
      expectMain: g.mainPick * g.mainPick / g.mainMax,
      notes: structNotes.concat(honNotes)
    };
  }

  function bandOf(s) {
    if (s >= 60) return { k: '极罕见', d: '结构、稀缺、状态三项都站住了' };
    if (s >= 54) return { k: '少见', d: '比大多数随手写的号更成形状' };
    if (s >= 47) return { k: '有骨架', d: '结构没大毛病，还能再挑' };
    if (s >= 38) return { k: '寻常', d: '就是普通人会写出来的那种号' };
    return { k: '松散', d: '结构偏得比较远，或者太像生日号' };
  }

  /* =========================================================
     七、存储
  ========================================================= */

  function lsGet(k, dft) {
    try {
      var raw = root.localStorage.getItem(k);
      if (!raw) return dft;
      var v = JSON.parse(raw);
      return v == null ? dft : v;
    } catch (e) { return dft; }
  }
  function lsSet(k, v) {
    try { root.localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { return false; }
  }

  var cfgDefault = function () {
    return {
      v: 1, game: 'ssq', perRound: 3, autoSettle: true,
      createdAt: nowISO(), lastAt: null, seeded: false
    };
  };

  function readStates() {
    var a = lsGet(KEY.states, []);
    if (!Array.isArray(a)) return [];
    return a.filter(function (s) { return s && s.id && s.dims; }).map(function (s) {
      s.used = toInt(s.used); s.mainHits = toInt(s.mainHits); s.subHits = toInt(s.subHits);
      s.dims = normalizeDims(s.dims);
      if (!s.game) s.game = 'ssq';
      if (!s.name) s.name = stateNameOf(s.dims);
      return s;
    });
  }
  function writeStates(a) {
    a = (a || []).slice(0, MAX_STATES);
    return lsSet(KEY.states, a);
  }
  function readRounds() {
    var a = lsGet(KEY.rounds, []);
    return Array.isArray(a) ? a.filter(function (r) { return r && r.id && r.game; }) : [];
  }
  function writeRounds(a) { return lsSet(KEY.rounds, (a || []).slice(0, MAX_ROUNDS)); }
  function readInsights() {
    var a = lsGet(KEY.notes, []);
    return Array.isArray(a) ? a.filter(function (x) { return x && x.id; }) : [];
  }
  function writeInsights(a) { return lsSet(KEY.notes, (a || []).slice(0, MAX_NOTES)); }
  function readCfg() {
    var c = lsGet(KEY.cfg, null);
    var d = cfgDefault();
    if (!c || typeof c !== 'object') return d;
    for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k) && c[k] != null) d[k] = c[k];
    return d;
  }
  function writeCfg(c) { return lsSet(KEY.cfg, c); }

  /* 数彩实验室里的历史开奖（新到旧）。没有就返回空数组，竹芯照样能跑，只是评分会粗一些。 */
  function loadDraws(gameKey) {
    var L = LL();
    function rowsOf(list) {
      return list.map(function (r) {
        if (Array.isArray(r)) {
          return { issue: String(r[0]), date: String(r[1]),
            main: String(r[2]).split(/[,\s]+/).map(toInt).filter(Boolean),
            sub: String(r[3]).split(/[,\s]+/).map(toInt).filter(Boolean) };
        }
        return r;
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
    } catch (e) {}
    return [];
  }

  /* 一个状态的「名片号」：只由六个词决定，加上建立当时的那一期。
     存下来之后就不再变——预览、保存、每一期排出来的，都是这一注。 */
  function makeBase(dims, gameKey) {
    var draws = loadDraws(gameKey);
    var a = analysisOf(draws, gameKey, 60);
    return basePoint(dims, gameKey, {
      prevMain: draws[0] ? draws[0].main : null,
      prevSub: draws[0] ? draws[0].sub : null,
      sumQ: a && a.sumQ ? a.sumQ : null,
      anchor: 'base'
    });
  }

  /* =========================================================
     八、状态库
  ========================================================= */

  function findState(states, id) {
    for (var i = 0; i < states.length; i++) if (states[i].id === id) return states[i];
    return null;
  }

  function upsertState(dims, opts) {
    opts = opts || {};
    dims = normalizeDims(dims);
    var key = stateKeyOf(dims);
    var g = gameOf(opts.game || readCfg().game);
    var all = readStates();
    var hit = null;
    // 同样的六个词，在双色球和大乐透是不同的两注，不能合并
    all.forEach(function (s) { if (s.key === key && (s.game || 'ssq') === g.key) hit = s; });
    if (hit) {
      hit.lastAt = nowISO();
      if (opts.name) hit.name = String(opts.name).slice(0, 20);
      writeStates(all);
      return { state: hit, created: false };
    }
    var bp = makeBase(dims, g.key);
    var autoName = opts.name ? String(opts.name).slice(0, 20) : stateNameOf(dims);
    // 名字只取三个词，难免撞；撞了就加个号，别让两注看起来一样
    if (!opts.name) {
      var used = {};
      all.forEach(function (x) { used[x.name] = 1; });
      if (used[autoName]) {
        var k = 2;
        while (used[autoName + ' #' + k]) k++;
        autoName = autoName + ' #' + k;
      }
    }
    var st = {
      id: 'st' + fnv(key + '#' + g.key).toString(36),
      key: key,
      name: autoName,
      dims: dims,
      base: bp,
      game: g.key,
      used: 0, mainHits: 0, subHits: 0, best: null,
      createdAt: nowISO(), lastAt: nowISO(),
      note: ''
    };
    all.unshift(st);
    writeStates(all);
    return { state: st, created: true };
  }

  function bumpState(stateId, hit, prize, roundId) {
    var all = readStates(), s = findState(all, stateId);
    if (!s) return null;
    s.used = toInt(s.used) + 1;
    s.mainHits = toInt(s.mainHits) + toInt(hit.k);
    s.subHits = toInt(s.subHits) + toInt(hit.b);
    if (prize && prize.level) {
      if (!s.best || prize.level < s.best.level) {
        s.best = { level: prize.level, amount: prize.amount == null ? null : prize.amount,
          at: nowISO(), roundId: roundId || null };
      }
    }
    s.lastAt = nowISO();
    writeStates(all);
    return s;
  }

  /* =========================================================
     九、期次与推演
  ========================================================= */

  function nextIssue(draws, gameKey) {
    if (!draws || !draws.length) return '';
    var max = 0, width = 0;
    function take(v) {
      v = String(v || '');
      if (!/^\d{5,8}$/.test(v)) return;
      var n = Number(v);
      if (n > max) { max = n; width = v.length; }
    }
    draws.forEach(function (d) { take(d && d.issue); });
    // 已经排过、还没开奖的期也算上，不然会排出同一个期号
    readRounds().forEach(function (r) { if (r && r.game === gameKey) take(r.issue); });
    if (!max) return '';
    var s = String(max + 1);
    while (s.length < width) s = '0' + s;
    return s;
  }

  var DRAW_WD = { ssq: [0, 2, 4], dlt: [1, 3, 6] };
  function nextDrawAfter(gameKey, from) {
    var wd = DRAW_WD[gameKey] || DRAW_WD.ssq;
    var d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    for (var i = 1; i <= 14; i++) {
      var x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
      if (wd.indexOf(x.getDay()) >= 0) return x;
    }
    return d;
  }

  function drawWhen(gameKey) {
    var L = LL();
    var now = new Date();
    // 已经排过、还没开奖的期如果就在今天或以后，下一期要从它往后数，
    // 不然连着排两期会排出同一个开奖日
    var latest = null;
    readRounds().forEach(function (r) {
      if (r.game !== gameKey || !r.date) return;
      var d = new Date(r.date + 'T00:00:00');
      if (isNaN(d.getTime())) return;
      if (d >= new Date(now.getFullYear(), now.getMonth(), now.getDate()) && (!latest || d > latest)) latest = d;
    });
    if (latest) {
      var nd = nextDrawAfter(gameKey, latest);
      return {
        date: todayKey(nd), hour: 21, minute: gameKey === 'ssq' ? 15 : 25,
        at: new Date(nd.getFullYear(), nd.getMonth(), nd.getDate(), 21, gameKey === 'ssq' ? 15 : 25, 0, 0)
      };
    }
    if (L && L.nextDrawSlot) {
      try {
        var s = L.nextDrawSlot(gameKey);
        if (s && s.draw) {
          var d = s.draw;
          return {
            date: todayKey(d),
            hour: gameKey === 'ssq' ? 21 : 21,
            minute: gameKey === 'ssq' ? 15 : 25,
            at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 21, gameKey === 'ssq' ? 15 : 25, 0, 0)
          };
        }
      } catch (e) {}
    }
    return { date: todayKey(now), hour: 21, minute: 15, at: now };
  }

  function planRound(gameKey, picks, opts) {
    opts = opts || {};
    var g = gameOf(gameKey);
    var draws = opts.draws || [];
    var a = opts.analysis || analysisOf(draws, gameKey, 60);
    var prevMain = draws[0] ? draws[0].main : null;
    var prevSub = draws[0] ? draws[0].sub : null;
    var sumQ = a && a.sumQ ? a.sumQ : null;
    var states = readStates();
    var when = drawWhen(gameKey);
    var issue = opts.issue || nextIssue(draws, gameKey);

    var items = [];
    picks.forEach(function (p) {
      var st = p.state || findState(states, p.stateId);
      if (!st) return;
      // 一注 = 一个状态。号就是它存下来的那注，不每期换——
      // 不然「这个状态到底买了什么」就说不清了，也没法按期比。
      var bp = (st.base && st.base.main && st.base.main.length) ? st.base : makeBase(st.dims, gameKey);
      var sc = scoreTicket(bp, gameKey, { draws: draws, analysis: a, state: st, prevMain: prevMain });
      items.push({
        stateId: st.id, stateName: st.name, dims: st.dims,
        ticket: { main: bp.main, sub: bp.sub },
        score: sc.total, parts: sc.parts, band: sc.band.k,
        expectMain: sc.expectMain, used: st.used || 0
      });
    });

    var round = {
      id: 'rd' + fnv((issue || '') + '#' + (gameKey) + '#' + Date.now()).toString(36),
      game: gameKey, gameName: g.name, issue: issue, date: when.date,
      drawAt: when.date + 'T' + pad2(when.hour) + ':' + pad2(when.minute) + ':00',
      phase: 'locked',
      items: items,
      spend: items.length * 2,
      actual: null, result: null, reflect: null,
      createdAt: nowISO(), lockedAt: nowISO(), drawnAt: null
    };
    if (!opts.dry) commitRound(round);
    return round;
  }

  function commitRound(round) {
    if (!round || !round.id) return null;
    var all = readRounds();
    for (var i = 0; i < all.length; i++) if (all[i].id === round.id) return round;
    all.unshift(round);
    writeRounds(all);
    return round;
  }

  function settleRound(roundId, actual) {
    var all = readRounds();
    var r = null;
    all.forEach(function (x) { if (x.id === roundId) r = x; });
    if (!r) return { ok: false, error: '没找到这一期' };
    if (r.phase === 'drawn') return { ok: false, error: '这一期已经对过了' };
    var g = gameOf(r.game);
    var main = sortNum(uniq((actual.main || []).map(toInt).filter(function (n) { return n >= 1 && n <= g.mainMax; })));
    var sub = sortNum(uniq((actual.sub || []).map(toInt).filter(function (n) { return n >= 1 && n <= g.subMax; })));
    if (main.length !== g.mainPick) return { ok: false, error: g.mainName + '要 ' + g.mainPick + ' 个，现在是 ' + main.length + ' 个' };
    if (sub.length !== g.subPick) return { ok: false, error: g.subName + '要 ' + g.subPick + ' 个，现在是 ' + sub.length + ' 个' };

    var L = LL();
    var results = [], totalWin = 0, bestLevel = null, bestIdx = -1;
    r.items.forEach(function (it, i) {
      var hit = L && L.ticketHit ? L.ticketHit(it.ticket, { main: main, sub: sub }, r.game)
        : { k: inter(it.ticket.main, main), b: inter(it.ticket.sub, sub) };
      var prize = L && L.prizeOf ? L.prizeOf(r.game, hit.k, hit.b) : null;
      var row = {
        stateId: it.stateId, stateName: it.stateName, score: it.score,
        main: it.ticket.main, sub: it.ticket.sub,
        k: hit.k, b: hit.b,
        level: prize ? prize.level : 0,
        levelName: prize ? prizeName(r.game, prize.level) : '',
        amount: prize && prize.amount != null ? prize.amount : null,
        float: !!(prize && prize.amount == null)
      };
      if (prize) {
        if (prize.amount != null) totalWin += prize.amount;
        if (bestLevel == null || prize.level < bestLevel) { bestLevel = prize.level; bestIdx = i; }
      }
      results.push(row);
      bumpState(it.stateId, hit, prize, r.id);
    });

    r.phase = 'drawn';
    r.drawnAt = nowISO();
    r.actual = { main: main, sub: sub, issue: actual.issue || r.issue, date: actual.date || r.date, by: actual.by || 'manual' };
    r.result = { rows: results, totalWin: totalWin, bestLevel: bestLevel, bestIdx: bestIdx };
    r.reflect = reflectLocal(r);
    writeRounds(all);

    // 归纳：每期出 1~3 条
    var news = insightsFromRound(r);
    if (news.length) {
      var old = readInsights();
      writeInsights(news.concat(old));
    }
    return { ok: true, round: r, insights: news };
  }

  function prizeName(gameKey, level) {
    var L = LL();
    if (L && L.prizeOf) {
      var names = { 1: '一等奖', 2: '二等奖', 3: '三等奖', 4: '四等奖', 5: '五等奖', 6: '六等奖', 7: '七等奖', 8: '八等奖', 9: '九等奖' };
      return names[level] || '';
    }
    return '';
  }

  /* =========================================================
     十、复盘（本机算，不编数字）
  ========================================================= */

  function missText(k, b, gameKey) {
    var g = gameOf(gameKey);
    var L = LL();
    // 差多少到下一档：从当前 (k,b) 往上找一个有奖的组合
    var best = null;
    for (var kk = k; kk <= g.mainPick; kk++) {
      for (var bb = b; bb <= g.subPick; bb++) {
        if (kk === k && bb === b) continue;
        var p = L && L.prizeOf ? L.prizeOf(gameKey, kk, bb) : null;
        if (!p) continue;
        var dk = kk - k, db = bb - b;
        if (!best || (dk + db) < (best.dk + best.db)) { best = { dk: dk, db: db, level: p.level, name: prizeName(gameKey, p.level) }; }
      }
    }
    return best;
  }

  function reflectLocal(r) {
    var g = gameOf(r.game);
    var rows = (r.result && r.result.rows) || [];
    var hitRows = rows.filter(function (x) { return x.k > 0 || x.b > 0; });
    var best = null;
    rows.forEach(function (x) { if (!best || (x.k + x.b) > (best.k + best.b)) best = x; });

    var lines = [], tags = [];
    if (!rows.length) return { headline: '这一期没有下注', lines: [], tags: [] };

    var won = rows.filter(function (x) { return x.level > 0; });
    var headline;
    if (won.length) {
      headline = won.length === 1
        ? ('中了' + won[0].levelName + (won[0].amount != null ? '，¥' + won[0].amount.toLocaleString('zh-CN') : '，奖金浮动'))
        : ('中了 ' + won.length + ' 注，最小的是' + won.reduce(function (a, x) { return x.level < a.level ? x : a; }, won[0]).levelName);
      tags.push('win');
    } else if (best && (best.k + best.b) > 0) {
      headline = '没中，最好那注' + (best.k ? (g.mainName + '中 ' + best.k + ' 个') : '') +
        (best.b ? ((best.k ? '、' : '') + g.subName + '中 ' + best.b + ' 个') : '');
      tags.push('near');
    } else {
      headline = '没中，一注都没沾上边';
      tags.push('far');
    }

    if (best) {
      lines.push({
        k: '最好那注', v: '「' + best.stateName + '」' +
          (best.k || best.b ? (g.mainName + ' ' + best.k + ' / ' + g.subName + ' ' + best.b) : '一个没中')
      });
      var gap = missText(best.k, best.b, r.game);
      if (gap && gap.dk + gap.db <= 2) {
        lines.push({ k: '差多少', v: '再对 ' + (gap.dk ? (gap.dk + ' 个' + g.mainName) : '') + (gap.db ? ((gap.dk ? '、' : '') + gap.db + ' 个' + g.subName) : '') + '，就是' + gap.name });
      } else if (gap) {
        lines.push({ k: '差多少', v: '离' + gap.name + '还差 ' + (gap.dk + gap.db) + ' 个号' });
      }
    }

    // 结构偏差：这一注的和值/奇偶，跟开奖号比
    if (best && r.actual) {
      var sMine = localStructure(best.main, null, g.mainMax);
      var sDraw = localStructure(r.actual.main, null, g.mainMax);
      var dSum = sMine.sum - sDraw.sum;
      var dOdd = sMine.odd - sDraw.odd;
      var dSpan = sMine.span - sDraw.span;
      var bits = [];
      if (Math.abs(dSum) >= 12) bits.push('和值差 ' + Math.abs(dSum) + '（你 ' + sMine.sum + '，开 ' + sDraw.sum + '）');
      if (Math.abs(dOdd) >= 2) bits.push('奇偶差 ' + Math.abs(dOdd) + ' 个');
      if (Math.abs(dSpan) >= 8) bits.push('跨度差 ' + Math.abs(dSpan));
      lines.push({ k: '差在结构', v: bits.length ? bits.join('；') : '最好那注的结构跟开奖号挺接近，是号没押中' });
      tags.push(bits.length ? 'struct' : 'plain');
    }

    // 状态分与结果的关系
    var hi = rows.filter(function (x) { return x.score >= 60; });
    var lo = rows.filter(function (x) { return x.score < 60; });
    if (hi.length && lo.length) {
      var hiHit = hi.reduce(function (a, x) { return a + x.k + x.b; }, 0) / hi.length;
      var loHit = lo.reduce(function (a, x) { return a + x.k + x.b; }, 0) / lo.length;
      lines.push({
        k: '分数说话', v: hiHit > loHit + 0.3 ? '高分那几注确实更贴（' + hiHit.toFixed(1) + ' vs ' + loHit.toFixed(1) + '）'
          : hiHit < loHit - 0.3 ? '这一期反过来了，低分的反而更贴（' + hiHit.toFixed(1) + ' vs ' + loHit.toFixed(1) + '）'
          : '分数高低这一期没差出来（' + hiHit.toFixed(1) + ' vs ' + loHit.toFixed(1) + '）'
      });
      tags.push('scorecheck');
    }

    return {
      headline: headline, lines: lines, tags: uniq(tags),
      at: nowISO(), by: 'local',
      bestState: best ? best.stateId : null,
      summary: buildSummary(r, rows, best)
    };
  }

  function buildSummary(r, rows, best) {
    var parts = [];
    parts.push('第 ' + (r.issue || '—') + ' 期，' + rows.length + ' 注，投入 ¥' + (rows.length * 2));
    if (r.result && r.result.totalWin) parts.push('回收 ¥' + r.result.totalWin);
    if (best) parts.push('最好的是「' + best.stateName + '」');
    return parts.join(' · ');
  }

  /* =========================================================
     十一、归纳
  ========================================================= */

  function insightsFromRound(r) {
    var out = [];
    var rows = (r.result && r.result.rows) || [];
    if (!rows.length) return out;
    var best = rows.reduce(function (a, x) { return (x.k + x.b) > (a.k + a.b) ? x : a; }, rows[0]);

    // 1) 状态维度对照：这一期谁写得最像
    if (rows.length >= 2) {
      var sorted = rows.slice().sort(function (a, b) { return (b.k + b.b) - (a.k + a.b); });
      var top = sorted[0], bottom = sorted[sorted.length - 1];
      if ((top.k + top.b) - (bottom.k + bottom.b) >= 2) {
        out.push(mkInsight('cross', '第 ' + r.issue + ' 期：「' + top.stateName + '」比「' + bottom.stateName + '」贴 ' +
          ((top.k + top.b) - (bottom.k + bottom.b)) + ' 个号',
          { roundId: r.id, game: r.game, top: top.stateId, bottom: bottom.stateId }));
      }
    }

    // 2) 分数是否兑现
    var hi = rows.filter(function (x) { return x.score >= 60; });
    var lo = rows.filter(function (x) { return x.score < 60; });
    if (hi.length && lo.length) {
      var a1 = hi.reduce(function (a, x) { return a + x.k + x.b; }, 0) / hi.length;
      var a2 = lo.reduce(function (a, x) { return a + x.k + x.b; }, 0) / lo.length;
      if (Math.abs(a1 - a2) >= 0.8) {
        out.push(mkInsight('trend', '第 ' + r.issue + ' 期：' + (a1 > a2 ? '高分的更贴' : '低分的反而更贴') +
          '（' + a1.toFixed(1) + ' vs ' + a2.toFixed(1) + '）',
          { roundId: r.id, game: r.game, hi: a1, lo: a2 }));
      }
    }

    // 3) 号段集中：同一个号段反复出现，说明状态差异被号段吃掉了
    var zoneHit = [0, 0, 0], g = gameOf(r.game);
    rows.forEach(function (x) {
      x.main.forEach(function (n) {
        var z = n <= Math.ceil(g.mainMax / 3) ? 0 : (n <= Math.ceil(g.mainMax * 2 / 3) ? 1 : 2);
        zoneHit[z]++;
      });
    });
    var tot = zoneHit[0] + zoneHit[1] + zoneHit[2];
    if (tot >= rows.length * 3) {
      var mx = Math.max.apply(null, zoneHit);
      if (mx / tot >= 0.5) {
        var zi = zoneHit.indexOf(mx);
        out.push(mkInsight('zone', '这一期 ' + Math.round(mx / tot * 100) + '% 的号都挤在' +
          ['低号段（1–' + Math.ceil(g.mainMax / 3) + '）', '中号段', '高号段'][zi] + '，状态之间没拉开',
          { roundId: r.id, game: r.game, zone: zi, share: mx / tot }));
      }
    }

    // 4) 第一次中奖，单独记一条
    if (r.result && r.result.bestLevel) {
      out.push(mkInsight('win', '第 ' + r.issue + ' 期第一次出现「' + best.stateName + '」中' +
        prizeName(r.game, r.result.bestLevel),
        { roundId: r.id, game: r.game, stateId: best.stateId, level: r.result.bestLevel }));
    }
    return out;
  }

  function mkInsight(kind, text, data) {
    return {
      id: 'in' + fnv(kind + text + Math.random()).toString(36),
      kind: kind, text: text, data: data || {}, at: nowISO()
    };
  }

  /* 跨期归纳：按维度聚合，找出「哪种状态更成形状」 */
  function aggregate(states, rounds) {
    var byDim = {}, byState = [];
    DIMS.forEach(function (d) { byDim[d.key] = {}; d.values.forEach(function (v) { byDim[d.key][v.v] = { v: v.v, n: 0, hits: 0, score: 0, best: null }; }); });

    // 状态样本
    states.forEach(function (s) {
      if (!s.used) return;
      byState.push({
        id: s.id, name: s.name, used: s.used,
        avgHit: s.mainHits / s.used, avgScore: 0, best: s.best || null, dims: s.dims
      });
      DIMS.forEach(function (d) {
        var b = byDim[d.key][s.dims[d.key]];
        if (!b) return;
        b.n += s.used; b.hits += s.mainHits;
        if (s.best && (!b.best || s.best.level < b.best.level)) b.best = s.best;
      });
    });

    // 用每一注的实际得分补 avgScore
    var scoreAcc = {};
    rounds.forEach(function (r) {
      if (r.phase !== 'drawn') return;
      (r.items || []).forEach(function (it) {
        if (!scoreAcc[it.stateId]) scoreAcc[it.stateId] = { n: 0, s: 0 };
        scoreAcc[it.stateId].n++;
        scoreAcc[it.stateId].s += it.score;
      });
    });
    byState.forEach(function (x) {
      var a = scoreAcc[x.id];
      x.avgScore = a && a.n ? a.s / a.n : 0;
    });
    DIMS.forEach(function (d) {
      d.values.forEach(function (v) {
        var b = byDim[d.key][v.v];
        if (!b.n) { b.avg = 0; return; }
        b.avg = b.hits / b.n;
      });
    });

    return { byDim: byDim, byState: byState.sort(function (a, b) { return b.avgHit - a.avgHit; }) };
  }

  function insightLines(agg, rounds) {
    var out = [];
    var drawn = rounds.filter(function (r) { return r.phase === 'drawn'; });
    if (!drawn.length) return out;

    // 每个维度里最好的值和最差的值，样本至少 2 次
    DIMS.forEach(function (d) {
      var arr = d.values.map(function (v) { return agg.byDim[d.key][v.v]; })
        .filter(function (x) { return x && x.n >= 2; })
        .sort(function (a, b) { return b.avg - a.avg; });
      if (arr.length < 2) return;
      var hi = arr[0], lo = arr[arr.length - 1];
      if (hi.avg - lo.avg >= 0.35) {
        out.push({
          kind: 'dim', key: d.key,
          text: '「' + hi.v + '」这个' + d.label + '平均中 ' + hi.avg.toFixed(2) + ' 个，比「' + lo.v + '」的 ' +
            lo.avg.toFixed(2) + ' 高（' + hi.n + ' 次 vs ' + lo.n + ' 次）',
          n: hi.n + lo.n
        });
      }
    });

    // 样本量提示
    var totalUsed = 0;
    agg.byState.forEach(function (s) { totalUsed += s.used; });
    if (totalUsed < 12) {
      out.push({ kind: 'small', text: '到现在才 ' + totalUsed + ' 注样本，下面的对比只能当参考，别急着下结论', n: totalUsed });
    }
    return out.slice(0, 6);
  }

  /* =========================================================
     十二、给 AI 的材料（只给事实，不让它编）
  ========================================================= */

  function aiMaterial(r) {
    var g = gameOf(r.game);
    var L = [];
    L.push('彩种：' + g.name + '（' + g.mainName + ' ' + g.mainPick + ' 个／1–' + g.mainMax + '，' + g.subName + ' ' + g.subPick + ' 个／1–' + g.subMax + '）');
    L.push('期号：' + (r.issue || '—') + '，开奖日：' + (r.date || '—'));
    if (r.actual) {
      L.push('开奖号码：' + r.actual.main.map(pad2).join(' ') + ' + ' + r.actual.sub.map(pad2).join(' '));
      L.push('开奖号结构：和值 ' + sum(r.actual.main) + '，跨度 ' + (r.actual.main[r.actual.main.length - 1] - r.actual.main[0]) +
        '，奇偶 ' + r.actual.main.filter(function (n) { return n % 2; }).length + ':' + r.actual.main.filter(function (n) { return !(n % 2); }).length);
    }
    L.push('');
    L.push('这一期下了 ' + (r.items || []).length + ' 注：');
    (r.result && r.result.rows || []).forEach(function (x, i) {
      var st = localStructure(x.main, null, g.mainMax);
      L.push((i + 1) + ') 状态「' + x.stateName + '」：' + x.main.map(pad2).join(' ') + ' + ' + x.sub.map(pad2).join(' ') +
        '｜和值 ' + st.sum + '，跨度 ' + st.span + '，奇偶 ' + st.odd + ':' + (g.mainPick - st.odd) +
        '｜竹芯分 ' + x.score + '｜中 ' + x.k + ' 个' + g.mainName + '、' + x.b + ' 个' + g.subName +
        (x.level ? ('｜' + x.levelName) : '｜没中'));
    });
    return L.join('\n');
  }

  function buildReflectPrompt(r) {
    var mat = aiMaterial(r);
    return '你是「竹芯」，一个帮人记录买彩状态的归纳机。下面是这一期的真实数据，请只根据这些数据说话，不要编造任何数字、不要预测下一期会开什么、不要说「必中」「规律」「提高概率」这类话。\n\n' +
      mat + '\n\n' +
      '请写 150–220 字，分三段，用平实的中文：\n' +
      '1）这一期到底差在哪（用上面的号码和结构说，具体到号或结构）；\n' +
      '2）哪一注的状态写法更接近开奖号的结构，为什么；\n' +
      '3）下一期值得试的一种状态组合（从心情/时辰/身体/场景/起因/取号法里各挑一个词），并说明只是换个写法，不改变中奖概率。\n' +
      '不要用小标题，不要用列表符号，直接三段话。';
  }

  function buildInsightPrompt(lines, agg, rounds) {
    var mat = lines.map(function (x) { return '· ' + x.text; }).join('\n');
    var st = agg.byState.slice(0, 8).map(function (s) {
      return '· 「' + s.name + '」用过 ' + s.used + ' 次，平均中 ' + s.avgHit.toFixed(2) + ' 个，均分 ' + Math.round(s.avgScore);
    }).join('\n');
    return '你是「竹芯」。下面是一个人自己记录的买彩状态样本，以及从里面算出来的对照。请只根据这些写一段 200 字以内的手记，像一个人在翻自己的本子，不要励志，不要承诺，不要出现「规律」「必中」「提高概率」。\n\n' +
      '【按维度对照】\n' + (mat || '（还没有足够的对照）') + '\n\n【状态成绩】\n' + (st || '（还没有成绩）') + '\n\n' +
      '样本量：' + rounds.filter(function (r) { return r.phase === 'drawn'; }).length + ' 期。\n' +
      '要求：第一句说现在样本够不够；第二句说一个具体的、下次可以试的写法；第三句提醒这只是记录，不是预测。';
  }

  /* =========================================================
     十三、导入导出
  ========================================================= */

  function exportAll() {
    return {
      app: '竹间记', module: '竹芯', v: 1, at: nowISO(),
      states: readStates(), rounds: readRounds(), insights: readInsights(), cfg: readCfg()
    };
  }

  function importAll(obj) {
    if (!obj || obj.module !== '竹芯') return { ok: false, error: '不是竹芯的档案' };
    var s = Array.isArray(obj.states) ? obj.states : [];
    var r = Array.isArray(obj.rounds) ? obj.rounds : [];
    var n = Array.isArray(obj.insights) ? obj.insights : [];
    // 合并：按 id 去重，本地优先
    var cur = readStates(), ids = {};
    cur.forEach(function (x) { ids[x.id] = 1; });
    s.forEach(function (x) { if (x && x.id && !ids[x.id]) { ids[x.id] = 1; cur.push(x); } });
    writeStates(cur);

    var curR = readRounds(), rids = {};
    curR.forEach(function (x) { rids[x.id] = 1; });
    r.forEach(function (x) { if (x && x.id && !rids[x.id]) { rids[x.id] = 1; curR.push(x); } });
    curR.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    writeRounds(curR);

    var curN = readInsights(), nids = {};
    curN.forEach(function (x) { nids[x.id] = 1; });
    n.forEach(function (x) { if (x && x.id && !nids[x.id]) { nids[x.id] = 1; curN.push(x); } });
    writeInsights(curN);

    if (obj.cfg && typeof obj.cfg === 'object') {
      var c = readCfg();
      for (var k in obj.cfg) if (Object.prototype.hasOwnProperty.call(obj.cfg, k) && obj.cfg[k] != null) c[k] = obj.cfg[k];
      writeCfg(c);
    }
    return { ok: true, states: s.length, rounds: r.length, insights: n.length };
  }

  function wipe() {
    try {
      Object.keys(KEY).forEach(function (k) { root.localStorage.removeItem(KEY[k]); });
    } catch (e) {}
  }

  /* =========================================================
     十四、界面
  ========================================================= */

  var ui = null;

  function ensureUI() {
    if (ui) return ui;
    var cfg = readCfg();
    ui = {
      open: false, tab: 'state', game: cfg.game || 'ssq',
      draft: guessDims(), preview: null,
      plan: null, busy: '', err: '', detail: null,
      modal: null, toast: '', toastAt: 0, noteBusy: false, showAllStates: false
    };
    return ui;
  }

  function guessDims() {
    var h = new Date().getHours();
    var hour = h < 7 ? '清晨' : h < 12 ? '上午' : h < 16 ? '午后' : h < 19 ? '黄昏' : h < 23 ? '夜里' : '深夜';
    return { mood: '平静', hour: hour, body: '清爽', scene: '店里', trigger: '纯直觉', source: '手感' };
  }

  function toast(msg) {
    ensureUI();
    ui.toast = String(msg || '');
    ui.toastAt = Date.now();
    var el = root.document.getElementById('zxToast');
    if (el) {
      el.textContent = ui.toast;
      el.classList.add('on');
      clearTimeout(ui._tt);
      ui._tt = setTimeout(function () { el.classList.remove('on'); }, 2400);
    }
  }

  function balls(main, sub, gameKey, dMain, dSub) {
    var out = '<div class="zx-balls">';
    (main || []).forEach(function (n) {
      var hit = dMain && dMain.indexOf(n) >= 0;
      out += '<b class="zx-b zx-rd' + (dMain ? (hit ? ' hit' : ' miss') : '') + '">' + pad2(n) + '</b>';
    });
    if (sub && sub.length) {
      out += '<i class="zx-bsep"></i>';
      sub.forEach(function (n) {
        var hit = dSub && dSub.indexOf(n) >= 0;
        out += '<b class="zx-b zx-bl' + (dSub ? (hit ? ' hit' : ' miss') : '') + '">' + pad2(n) + '</b>';
      });
    }
    out += '</div>';
    return out;
  }

  function ringHTML(score) {
    var r = 21, c = 2 * Math.PI * r;
    var off = c * (1 - clamp(score, 0, 100) / 100);
    var cls = score >= 60 ? ' hi' : score >= 47 ? ' mid' : ' lo';
    return '<div class="zx-ring' + cls + '">' +
      '<svg viewBox="0 0 52 52" aria-hidden="true">' +
      '<circle cx="26" cy="26" r="' + r + '" class="zx-ring-bg"/>' +
      '<circle cx="26" cy="26" r="' + r + '" class="zx-ring-fg" stroke-dasharray="' + c.toFixed(1) +
      '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 26 26)"/>' +
      '</svg><b>' + score + '</b></div>';
  }

  function barsHTML(parts) {
    var h = '<div class="zx-bars">';
    parts.forEach(function (p) {
      var pct = Math.round(p.v / p.max * 100);
      h += '<div class="zx-bar" title="' + esc(p.hint) + '">' +
        '<span>' + p.k + '</span>' +
        '<div class="zx-bar-t"><i style="width:' + pct + '%"></i></div>' +
        '<b>' + p.v + '<em>/' + p.max + '</em></b></div>';
    });
    h += '</div>';
    return h;
  }

  /* ---------- 主页骨架 ---------- */

  function buildShell() {
    var doc = root.document;
    var el = doc.createElement('div');
    el.id = 'zxPage';
    el.className = 'zx-page';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
      '<div class="zx-aurora" aria-hidden="true"></div>' +
      '<div class="zx-grid" aria-hidden="true"></div>' +
      '<div class="zx-wrap">' +
        '<header class="zx-top">' +
          '<button class="zx-ico" type="button" data-act="close" aria-label="关闭竹芯">' +
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>' +
          '</button>' +
          '<div class="zx-brand"><b>竹芯</b><i>ZHU XIN · 无限归纳机</i></div>' +
          '<button class="zx-ico" type="button" data-act="tab" data-tab="core" aria-label="芯核设置">' +
            '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>' +
          '</button>' +
        '</header>' +
        '<div class="zx-core" id="zxCore"></div>' +
        '<nav class="zx-tabs" id="zxTabs">' +
          '<button type="button" data-act="tab" data-tab="state">状态</button>' +
          '<button type="button" data-act="tab" data-tab="round">推演</button>' +
          '<button type="button" data-act="tab" data-tab="insight">归纳</button>' +
          '<button type="button" data-act="tab" data-tab="core">芯核</button>' +
        '</nav>' +
        '<main class="zx-body" id="zxBody"></main>' +
      '</div>' +
      '<div class="zx-toast" id="zxToast" role="status" aria-live="polite"></div>';
    doc.body.appendChild(el);

    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    return el;
  }

  function paint(keepScroll) {
    ensureUI();
    var doc = root.document;
    var body = doc.getElementById('zxBody');
    if (!body) return;
    // 真正滚动的是 .zx-wrap，不是 #zxBody——之前一直改错了元素，切页签不会回到顶部
    var wrap = doc.querySelector('.zx-wrap');
    var top = (keepScroll && wrap) ? wrap.scrollTop : 0;

    var html = '';
    if (ui.tab === 'state') html = stateHTML();
    else if (ui.tab === 'round') html = roundHTML();
    else if (ui.tab === 'insight') html = insightHTML();
    else html = coreHTML();

    body.innerHTML = html;
    if (wrap) wrap.scrollTop = top;

    // 顶部读数：只换数字，不重建那颗球，否则每次点一下动画都从头开始闪
    updateCore();

    var tabs = doc.querySelectorAll('#zxTabs button');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === ui.tab);
    }

    // 弹层
    var mask = doc.getElementById('zxMask');
    if (mask) {
      if (ui.modal) {
        mask.className = 'zx-mask on';
        var box = doc.getElementById('zxMaskBox');
        if (box) box.innerHTML = modalHTML();
      } else {
        mask.className = 'zx-mask';
      }
    }
  }

  function updateCore() {
    var doc = root.document;
    var core = doc.getElementById('zxCore');
    if (!core) return;
    if (!core.querySelector('.zx-orb')) core.innerHTML = coreHTML0();
    var states = readStates(), rounds = readRounds();
    var drawn = rounds.filter(function (r) { return r.phase === 'drawn'; });
    var bets = 0, spend = 0, win = 0, used = 0;
    drawn.forEach(function (r) {
      bets += (r.items || []).length;
      spend += (r.items || []).length * 2;
      win += (r.result && r.result.totalWin) || 0;
    });
    states.forEach(function (x) { used += (x.used || 0); });

    var bs = core.querySelectorAll('.zx-readout b');
    if (bs.length === 4) {
      bs[0].textContent = states.length;
      bs[1].textContent = drawn.length;
      bs[2].textContent = bets;
      bs[3].textContent = spend ? ((win - spend >= 0 ? '+¥' : '−¥') + Math.abs(win - spend)) : '—';
      bs[3].className = (win - spend >= 0 ? 'up' : 'down');
    }
    var cap = core.querySelector('.zx-caption');
    if (cap) {
      cap.textContent = used
        ? ('这台机器一共看过你 ' + used + ' 次下注，还在往里堆。')
        : (states.length
            ? ('状态库里有 ' + states.length + ' 个，都还没上过场。')
            : '还没记录过一次。先挑一个状态，给它一注号。');
    }
  }

  function coreHTML0() {
    var states = readStates(), rounds = readRounds();
    var drawn = rounds.filter(function (r) { return r.phase === 'drawn'; });
    var bets = 0, spend = 0, win = 0;
    drawn.forEach(function (r) {
      bets += (r.items || []).length;
      spend += (r.items || []).length * 2;
      win += (r.result && r.result.totalWin) || 0;
    });
    var used = states.reduce(function (a, s) { return a + (s.used || 0); }, 0);
    return '' +
      '<div class="zx-orb"><span class="zx-orb-r"></span><span class="zx-orb-r2"></span><b>芯</b></div>' +
      '<div class="zx-readout">' +
        '<div><b>' + states.length + '</b><i>状态</i></div>' +
        '<div><b>' + drawn.length + '</b><i>期</i></div>' +
        '<div><b>' + bets + '</b><i>注</i></div>' +
        '<div><b class="' + (win - spend >= 0 ? 'up' : 'down') + '">' +
          (spend ? ((win - spend >= 0 ? '+¥' : '−¥') + Math.abs(win - spend)) : '—') + '</b><i>盈亏</i></div>' +
      '</div>' +
      '<div class="zx-caption">' + (used
        ? ('这台机器一共看过你 ' + used + ' 次下注，还在往里堆。')
        : (states.length
            ? ('状态库里有 ' + states.length + ' 个，都还没上过场。')
            : '还没记录过一次。先挑一个状态，给它一注号。')) + '</div>';
  }

  /* ---------- 状态页 ---------- */

  function stateHTML() {
    var d = ui.draft;
    var states = readStates().filter(function (s) { return (s.game || 'ssq') === ui.game; })
      .sort(function (a, b) {
        return String(b.lastAt || b.createdAt || '').localeCompare(String(a.lastAt || a.createdAt || ''));
      });
    var h = '';

    h += '<section class="zx-note"><p>你现在是什么状态？六个词，定一注号。<b>同样的词永远出同样的号</b>——这样开奖后才知道是哪种状态写出来的。</p></section>';

    h += '<section class="zx-dims">';
    DIMS.forEach(function (dim) {
      h += '<div class="zx-dim">' +
        '<div class="zx-dim-h"><b>' + dim.label + '</b><i>' + dim.q + '</i></div>' +
        '<div class="zx-chips">';
      dim.values.forEach(function (v) {
        h += '<button type="button" class="zx-chip' + (d[dim.key] === v.v ? ' on' : '') +
          '" data-act="dim" data-dim="' + dim.key + '" data-val="' + esc(v.v) + '" title="' + esc(v.d) + '">' + esc(v.v) + '</button>';
      });
      h += '</div></div>';
    });
    h += '</section>';

    if (!ui.preview) ui.preview = computePreview();
    h += previewHTML(ui.preview, states);

    h += '<section class="zx-sec">' +
      '<div class="zx-sec-h"><h3>状态库</h3><span>' + gameOf(ui.game).name + ' · ' + states.length + ' 个</span></div>';
    if (!states.length) {
      h += '<div class="zx-empty">还没有状态。上面挑好六个词，点「把这个状态记下来」，它就在这儿了。</div>';
    } else {
      var shown = ui.showAllStates ? states : states.slice(0, 10);
      h += '<div class="zx-stlist">';
      shown.forEach(function (s) { h += stateCardHTML(s); });
      h += '</div>';
      if (states.length > 10) {
        h += '<button type="button" class="zx-more" data-act="toggle-states">' +
          (ui.showAllStates ? '收起来，只看最近的 10 个' : ('展开全部 ' + states.length + ' 个')) + '</button>';
      }
    }
    h += '</section>';

    return h;
  }

  function stateCardHTML(s) {
    var best = s.best && s.best.level ? ('最好 ' + prizeName(ui.game, s.best.level)) : '还没中过';
    var used = s.used || 0;
    var avg = used ? ((s.mainHits || 0) / used).toFixed(2) : '—';
    var bp = s.base || basePoint(s.dims, ui.game, {});
    return '<article class="zx-st" data-id="' + esc(s.id) + '">' +
      '<div class="zx-st-h"><b>' + esc(s.name) + '</b><span>' + (used ? (used + ' 次') : '没用过') + '</span></div>' +
      '<div class="zx-st-tags">' + DIMS.map(function (d) { return esc(s.dims[d.key]); }).join(' · ') + '</div>' +
      balls(bp.main, bp.sub, ui.game) +
      '<div class="zx-st-m">' + (used ? ('用过 ' + used + ' 次 · 平均中 ' + avg + ' 个 · ' + best) : '基站点已定，还没上过场') + '</div>' +
      '<div class="zx-st-a">' +
        '<button type="button" data-act="use-state" data-id="' + esc(s.id) + '">用它排一期</button>' +
        '<button type="button" class="ghost" data-act="del-state" data-id="' + esc(s.id) + '">删掉</button>' +
      '</div></article>';
  }

  function computePreview() {
    ensureUI();
    var cfg = readCfg();
    var gameKey = ui.game || cfg.game || 'ssq';
    var draws = loadDraws(gameKey);
    var a = analysisOf(draws, gameKey, 60);
    var prevMain = draws[0] ? draws[0].main : null;
    var key = stateKeyOf(ui.draft);
    var st = null;
    readStates().forEach(function (x) { if (x.key === key && (x.game || 'ssq') === gameKey) st = x; });
    // 存过的，直接用它存下来的那一注；没存过的，按「马上要存」的算法先算一注。
    // 两边必须是同一套参数，否则会出现「预览一注、存下来另一注」。
    var bp = (st && st.base && st.base.main && st.base.main.length) ? st.base : makeBase(ui.draft, gameKey);
    var sc = scoreTicket(bp, gameKey, { draws: draws, analysis: a, state: st, prevMain: prevMain });
    return { ticket: bp, score: sc, saved: !!st, key: key, game: gameKey };
  }

  function previewHTML(pv, states) {
    var sc = pv.score;
    var h = '<section class="zx-card zx-pv">';
    h += '<div class="zx-pv-top">' +
      '<div><div class="zx-pv-k">这个状态的基站点</div>' +
      '<div class="zx-pv-sub">' + stateNameOf(ui.draft) + '</div></div>' +
      ringHTML(sc.total) + '</div>';
    h += balls(pv.ticket.main, pv.ticket.sub, pv.game);
    h += barsHTML(sc.parts);
    h += '<div class="zx-verdict"><b>' + sc.band.k + '</b><span>' + sc.band.d + '</span></div>';
    h += '<p class="zx-fine">这是「写得像不像话」的分，不是中奖概率。任何一注中头奖的概率都是同一个数，' +
      '这一注的主区期望命中是 ' + sc.expectMain.toFixed(2) + ' 个，跟你写什么号无关。</p>';
    h += pv.saved
      ? '<div class="zx-saved">这个状态已经在库里，用的是它的历史成绩</div>'
      : '<button type="button" class="zx-btn" data-act="save-state">把这个状态记下来</button>';
    h += '</section>';
    return h;
  }

  /* ---------- 推演页 ---------- */

  function roundHTML() {
    var rounds = readRounds();
    var open0 = null;
    for (var i = 0; i < rounds.length; i++) if (rounds[i].phase !== 'drawn') { open0 = rounds[i]; break; }
    var h = '';

    if (ui.plan) {
      h += planPreviewHTML(ui.plan);
    } else if (open0) {
      h += lockedHTML(open0);
    } else {
      h += startHTML();
    }

    var hist = rounds.filter(function (r) { return r.phase === 'drawn'; });
    if (hist.length) {
      h += '<section class="zx-sec"><div class="zx-sec-h"><h3>开过的期</h3><span>' + hist.length + ' 期</span></div>';
      hist.slice(0, 12).forEach(function (r) {
        h += roundItemHTML(r);
      });
      h += '</section>';
    }
    return h;
  }

  function startHTML() {
    var cfg = readCfg();
    var gameKey = ui.game || cfg.game || 'ssq';
    var g = gameOf(gameKey);
    var draws = loadDraws(gameKey);
    var issue = nextIssue(draws, gameKey);
    var when = drawWhen(gameKey);
    var states = readStates().filter(function (s) { return (s.game || 'ssq') === gameKey; });
    return '<section class="zx-card zx-phase">' +
      '<div class="zx-phase-tag">下一期</div>' +
      '<div class="zx-phase-t">第 ' + esc(issue || '—') + ' 期 · ' + esc(g.name) + '</div>' +
      '<div class="zx-phase-s">' + esc(when.date) + ' ' + pad2(when.hour) + ':' + pad2(when.minute) + ' 开奖 · ' + countdown(when.at) + '</div>' +
      '<p class="zx-phase-p">' + (states.length
        ? ('从状态库里挑 ' + Math.min(toInt(cfg.perRound) || 3, states.length) + ' 个状态，各出一注。挑的时候会避开号码撞在一起。')
        : '状态库还是空的。我先按现在的时辰，临时给你排 ' + (toInt(cfg.perRound) || 3) + ' 个常见状态试试，不用先存。') + '</p>' +
      '<button type="button" class="zx-btn" data-act="plan">让竹芯排这一期</button>' +
      '</section>' +
      carryHTML(gameKey) +
      '<section class="zx-note zx-note-s"><p>排出来的号是<b>几条状态各写一注</b>，不是几注追一个号。这样开奖后能看出哪种状态更像开奖号。</p></section>';
  }

  /* 上一期最贴的是谁——这一期排之前先看一眼，才叫「一层一层往上叠」 */
  function carryHTML(gameKey) {
    var rounds = readRounds().filter(function (r) { return r.phase === 'drawn' && r.game === gameKey; });
    if (!rounds.length) return '';
    var r = rounds[0];
    var rows = (r.result && r.result.rows) || [];
    if (!rows.length) return '';
    var g = gameOf(r.game);
    var best = rows.reduce(function (a, x) { return (x.k + x.b) > (a.k + a.b) ? x : a; }, rows[0]);
    var won = r.result && r.result.bestLevel;
    var hitTxt = (best.k ? (best.k + ' 个' + g.mainName) : '') +
      (best.b ? ((best.k ? '、' : '') + best.b + ' 个' + g.subName) : '');
    return '<section class="zx-carry">' +
      '<div class="zx-carry-h"><span>上一期 · 第 ' + esc(r.issue || '—') + ' 期</span>' +
        (won ? '<em>中了' + esc(prizeName(r.game, r.result.bestLevel)) + '</em>' : '<em class="dim">没中</em>') + '</div>' +
      '<p>最贴的是<b>「' + esc(best.stateName) + '」</b>' +
        (hitTxt ? ('，' + hitTxt) : '，一个也没沾上') +
        '。这一期它还在候选里，分数重新算过。</p>' +
      '</section>';
  }

  function countdown(at) {
    var d = at.getTime() - Date.now();
    if (d <= 0) return '已经过了开奖时间';
    var day = Math.floor(d / 86400000), hr = Math.floor(d % 86400000 / 3600000), mn = Math.floor(d % 3600000 / 60000);
    if (day > 0) return '还有 ' + day + ' 天 ' + hr + ' 小时';
    if (hr > 0) return '还有 ' + hr + ' 小时 ' + mn + ' 分';
    return '还有 ' + mn + ' 分';
  }

  function planPreviewHTML(plan) {
    var h = '<section class="zx-card zx-phase">' +
      '<div class="zx-phase-tag">待锁定</div>' +
      '<div class="zx-phase-t">第 ' + esc(plan.issue || '—') + ' 期 · ' + esc(gameOf(plan.game).name) + '</div>' +
      '<div class="zx-phase-s">' + esc(plan.date) + ' 开奖 · 一共 ' + plan.items.length + ' 注 · ¥' + (plan.items.length * 2) + '</div>' +
      '</section>';
    h += '<section class="zx-planlist">';
    // 全是新面孔的时候不用挨个标「新」，那反而吵
    var hasOld = plan.items.some(function (x) { return x.used; });
    plan.items.forEach(function (it, i) {
      h += '<article class="zx-plan">' +
        '<div class="zx-plan-h"><span class="zx-seed">' + (i + 1) + '</span><b>' + esc(it.stateName) + '</b>' +
          (hasOld && !it.used ? '<i class="zx-fresh">新</i>' : '') + '<em>' + it.score + ' 分</em></div>' +
        balls(it.ticket.main, it.ticket.sub, plan.game) +
        '<div class="zx-plan-m">' + esc(it.band) + ' · ' + (it.used ? ('用过 ' + it.used + ' 次') : '头一次用') + '</div>' +
        '</article>';
    });
    h += '</section>';
    h += '<div class="zx-actions">' +
      '<button type="button" class="zx-btn" data-act="lock">锁定这 ' + plan.items.length + ' 注 · ¥' + (plan.items.length * 2) + '</button>' +
      '<button type="button" class="zx-btn ghost" data-act="replan">换一组</button>' +
      '<button type="button" class="zx-btn ghost" data-act="cancel-plan">先不排</button>' +
      '</div>';
    return h;
  }

  function lockedHTML(r) {
    var g = gameOf(r.game);
    var when = r.drawAt ? new Date(r.drawAt) : null;
    var h = '<section class="zx-card zx-phase">' +
      '<div class="zx-phase-tag locked">等开奖</div>' +
      '<div class="zx-phase-t">第 ' + esc(r.issue || '—') + ' 期 · ' + esc(g.name) + '</div>' +
      '<div class="zx-phase-s">' + esc(r.date) + ' ' + (r.drawAt ? r.drawAt.slice(11, 16) : '21:15') + ' 开奖' +
      (when && when.getTime() > Date.now() ? ' · ' + countdown(when) : ' · 已经开完，可以对了') + '</div>' +
      '</section>';
    h += '<section class="zx-planlist">';
    (r.items || []).forEach(function (it, i) {
      h += '<article class="zx-plan">' +
        '<div class="zx-plan-h"><span class="zx-seed">' + (i + 1) + '</span><b>' + esc(it.stateName) + '</b><em>' + it.score + ' 分</em></div>' +
        balls(it.ticket.main, it.ticket.sub, r.game) +
        '</article>';
    });
    h += '</section>';
    if (ui.err) h += '<div class="zx-err">' + esc(ui.err) + '</div>';
    h += '<div class="zx-actions">' +
      '<button type="button" class="zx-btn" data-act="ask-draw"' + (ui.busy === 'draw' ? ' disabled' : '') + '>' +
        (ui.busy === 'draw' ? '正在联网查这一期…' : '对开奖（让竹芯联网查）') + '</button>' +
      '<button type="button" class="zx-btn ghost" data-act="manual-draw">自己填开奖号</button>' +
      '</div>';
    h += '<section class="zx-note zx-note-s"><p>AI 查回来的是<b>官方号码</b>，你可以再核一眼。号码不对就自己填，竹芯不猜。</p></section>';
    return h;
  }

  function roundItemHTML(r) {
    var g = gameOf(r.game);
    var rows = (r.result && r.result.rows) || [];
    var best = null;
    rows.forEach(function (x) { if (!best || (x.k + x.b) > (best.k + best.b)) best = x; });
    var winTxt = r.result && r.result.totalWin ? ('回收 ¥' + r.result.totalWin) : '没中';
    var open = ui.detail === r.id;
    var h = '<article class="zx-hist' + (open ? ' open' : '') + '" data-id="' + esc(r.id) + '">' +
      '<div class="zx-hist-h" data-act="toggle-round" data-id="' + esc(r.id) + '">' +
        '<div><b>第 ' + esc(r.issue || '—') + ' 期</b><span>' + esc(r.date || '') + ' · ' + esc(g.name) + '</span></div>' +
        '<em class="' + (r.result && r.result.totalWin ? 'win' : '') + '">' + esc(winTxt) + '</em>' +
      '</div>';
    if (open) {
      h += '<div class="zx-hist-b">';
      h += '<div class="zx-drawline"><span>开奖</span>' + balls(r.actual.main, r.actual.sub, r.game) + '</div>';
      rows.forEach(function (x) {
        h += '<div class="zx-res">' +
          '<div class="zx-res-h"><b>' + esc(x.stateName) + '</b><em>' + x.score + ' 分</em></div>' +
          balls(x.main, x.sub, r.game, r.actual.main, r.actual.sub) +
          '<div class="zx-res-m">' + (x.k || x.b
            ? ('中 ' + (x.k ? (x.k + ' 个' + g.mainName) : '') + (x.k && x.b ? '、' : '') + (x.b ? (x.b + ' 个' + g.subName) : ''))
            : '一个都没沾上') +
            (x.level ? (' · <b class="win">' + esc(x.levelName) + '</b>' + (x.amount != null ? (' ¥' + x.amount.toLocaleString('zh-CN')) : '')) : ' · 没中') + '</div>' +
          '</div>';
      });
      if (r.reflect) {
        h += '<div class="zx-reflect"><div class="zx-reflect-h">竹芯记下的</div><p class="zx-reflect-t">' + esc(r.reflect.headline) + '</p><ul>';
        (r.reflect.lines || []).forEach(function (l) {
          h += '<li><span>' + esc(l.k) + '</span><em>' + esc(l.v) + '</em></li>';
        });
        h += '</ul>';
        if (r.reflect.ai) h += '<p class="zx-reflect-ai">' + esc(r.reflect.ai) + '</p>';
        h += '<button type="button" class="zx-mini" data-act="ai-reflect" data-id="' + esc(r.id) + '">' +
          (r.aiBusy ? '正在写…' : (r.reflect.ai ? '重新让竹芯写一遍' : '让竹芯说这一段')) + '</button>';
        h += '</div>';
      }
      h += '</div>';
    }
    h += '</article>';
    return h;
  }

  /* ---------- 归纳页 ---------- */

  function insightHTML() {
    var rounds = readRounds(), states = readStates(), notes = readInsights();
    var st = statsOf(rounds);
    var agg = aggregate(states, rounds);
    var lines = insightLines(agg, rounds);
    var h = '';

    h += '<section class="zx-stats">' +
      '<div><b>' + st.drawn + '</b><span>已开奖</span></div>' +
      '<div><b>' + st.bets + '</b><span>总注数</span></div>' +
      '<div><b>¥' + st.spend + '</b><span>投入</span></div>' +
      '<div><b class="' + (st.win - st.spend >= 0 ? 'up' : 'down') + '">¥' + st.win + '</b><span>回收</span></div>' +
      '</section>';

    h += '<section class="zx-card">' +
      '<div class="zx-card-h"><b>均分走势</b><span>' + (st.avg ? (st.avg.toFixed(1) + ' / 100') : '—') + '</span></div>' +
      sparkHTML(st.series) +
      '<p class="zx-fine">每一期几注的平均竹芯分。分高只说明写法更成形状，不说明更容易中。</p>' +
      '</section>';

    h += '<section class="zx-card">' +
      '<div class="zx-card-h"><b>竹芯读出来的</b><span>' + (lines.length ? (lines.length + ' 条') : '还不够') + '</span></div>';
    if (!lines.length) {
      h += '<p class="zx-empty-s">样本还不够。开过三五期之后，这里会开始出现对照。</p>';
    } else {
      h += '<ul class="zx-ins">';
      lines.forEach(function (x) {
        h += '<li class="' + esc(x.kind) + '"><i></i><span>' + esc(x.text) + '</span></li>';
      });
      h += '</ul>';
    }
    h += '</section>';

    var rank = agg.byState.filter(function (x) { return x.used > 0; }).slice(0, 8);
    h += '<section class="zx-card">' +
      '<div class="zx-card-h"><b>状态排行</b><span>按平均命中</span></div>';
    if (!rank.length) {
      h += '<p class="zx-empty-s">还没有用过的状态。开过一期、对完号之后，这里就有名次了。</p>';
    } else {
      h += '<div class="zx-rank">';
      rank.forEach(function (x, i) {
        h += '<div class="zx-rk">' +
          '<span class="n">' + (i + 1) + '</span>' +
          '<b>' + esc(x.name) + '</b>' +
          '<span class="m">' + x.used + ' 次' + (x.avgScore ? (' · 均分 ' + Math.round(x.avgScore)) : '') + '</span>' +
          '<em' + (x.used < 3 ? ' class="weak"' : '') + '>' + x.avgHit.toFixed(2) + '<small>个</small></em>' +
          '</div>';
      });
      h += '</div>';
      h += '<p class="zx-fine">右边是平均每注主区中几个。任意一注的期望都是 ' +
        (gameOf(ui.game).mainPick * gameOf(ui.game).mainPick / gameOf(ui.game).mainMax).toFixed(2) +
        ' 个，高出这个数才说明这个状态写得有点东西。</p>';
    }
    h += '</section>';

    h += '<section class="zx-sec">' +
      '<div class="zx-sec-h"><h3>手记</h3><span>' + notes.length + ' 条</span></div>';
    if (!notes.length) {
      h += '<div class="zx-empty">还没有手记。开过一期、对完号，这里就有了。</div>';
    } else {
      h += '<div class="zx-timeline">';
      notes.slice(0, 20).forEach(function (n) {
        h += '<div class="zx-tl"><i></i><p>' + esc(n.text) + '</p><time>' + esc(fmtWhen(n.at)) + '</time></div>';
      });
      h += '</div>';
    }
    h += '</section>';

    h += '<div class="zx-actions">' +
      '<button type="button" class="zx-btn ghost" data-act="ai-hand"' + (ui.noteBusy ? ' disabled' : '') + '>' +
      (ui.noteBusy ? '竹芯在想…' : '让竹芯把这几条写成一段') + '</button></div>';

    return h;
  }

  function statsOf(rounds) {
    var drawn = rounds.filter(function (r) { return r.phase === 'drawn'; });
    var bets = 0, spend = 0, win = 0, all = [], series = [];
    drawn.forEach(function (r) {
      var its = r.items || [];
      bets += its.length; spend += its.length * 2;
      win += (r.result && r.result.totalWin) || 0;
      var s = 0;
      its.forEach(function (x) { all.push(x.score); s += x.score; });
      if (its.length) series.unshift(s / its.length);
    });
    // series 现在是旧→新
    return {
      drawn: drawn.length, bets: bets, spend: spend, win: win,
      avg: all.length ? all.reduce(function (a, b) { return a + b; }, 0) / all.length : 0,
      series: series.slice(-14)
    };
  }

  function sparkHTML(vals) {
    if (!vals || !vals.length) {
      return '<div class="zx-spark-empty">还没有开过的期</div>';
    }
    if (vals.length === 1) {
      // 只有一期时画折线会退化成一条粗横条，不如直接给数字
      return '<div class="zx-spark-one"><b>' + vals[0].toFixed(1) + '</b>' +
        '<span>这一期几注的平均分。到第 2 期就画得出走势。</span></div>';
    }
    var w = 300, hgt = 56, pad = 6;
    var min = Math.min.apply(null, vals) - 2, max = Math.max.apply(null, vals) + 2;
    var span = Math.max(1, max - min);
    var pts = vals.map(function (v, i) {
      var x = pad + (w - pad * 2) * (i / (vals.length - 1));
      var y = hgt - pad - (hgt - pad * 2) * ((v - min) / span);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    return '<svg class="zx-spark" viewBox="0 0 ' + w + ' ' + hgt + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline class="fill" points="' + pad + ',' + (hgt - pad) + ' ' + pts.join(' ') + ' ' + (w - pad) + ',' + (hgt - pad) + '"/>' +
      '<polyline class="line" vector-effect="non-scaling-stroke" points="' + pts.join(' ') + '"/></svg>';
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ---------- 芯核页 ---------- */

  function coreHTML() {
    var cfg = readCfg();
    var states = readStates(), rounds = readRounds(), notes = readInsights();
    var h = '';

    h += '<section class="zx-card zx-oath">' +
      '<div class="zx-oath-h">先把话说清楚</div>' +
      '<p>开奖机没有记忆。上一期开什么，不会影响下一期；你那天心情如何，也不会影响摇出来的球。<b>任何一注合法的号码，中头奖的概率都完全一样。</b>这一条不会因为竹芯记了多少期而改变。</p>' +
      '<p>那竹芯在做什么？它在记<b>你自己</b>：你在什么状态下会写出什么样的号，哪种状态写出来的号更像开奖号的结构。它堆的是你的样本，不是宇宙的规律。样本多了，你对自己的了解会变清楚——这本身有用，但它不能把 1/1772 万变成 1/100 万。</p>' +
      '<p>所以这里所有的「分」，都是<b>拿来自省的分</b>，不是中奖概率。别为它加钱，别为它借钱。</p>' +
      '</section>';

    h += '<section class="zx-sec">' +
      '<div class="zx-sec-h"><h3>这台机器</h3><span>v' + V + '</span></div>' +
      '<div class="zx-set">' +
        '<label class="zx-setrow"><span>默认彩种</span>' +
          '<select data-set="game">' +
            '<option value="ssq"' + (cfg.game === 'ssq' ? ' selected' : '') + '>双色球</option>' +
            '<option value="dlt"' + (cfg.game === 'dlt' ? ' selected' : '') + '>超级大乐透</option>' +
          '</select></label>' +
        '<label class="zx-setrow"><span>每期排几注</span>' +
          '<select data-set="perRound">' +
            [1, 2, 3, 4, 5].map(function (n) {
              return '<option value="' + n + '"' + (toInt(cfg.perRound) === n ? ' selected' : '') + '>' + n + ' 注</option>';
            }).join('') +
          '</select></label>' +
        '<div class="zx-setrow"><span>数据存在哪</span><em>本机浏览器，共 ' + (states.length + rounds.length + notes.length) + ' 条</em></div>' +
      '</div>' +
      '<p class="zx-fine">竹芯的数据不进笔记、不跟着云同步走，只在这台设备的这个浏览器里。换设备要用下面的导出带过去。</p>' +
      '</section>';

    h += '<section class="zx-sec">' +
      '<div class="zx-sec-h"><h3>档案</h3><span>可以带走</span></div>' +
      '<div class="zx-actions col">' +
        '<button type="button" class="zx-btn ghost" data-act="export">导出档案（JSON）</button>' +
        '<button type="button" class="zx-btn ghost" data-act="import">导入档案</button>' +
        '<button type="button" class="zx-btn danger" data-act="wipe">清空竹芯的全部记录</button>' +
      '</div>' +
      '<p class="zx-fine">导出的是状态、期次、手记三样，换手机时导进来就能接着用。</p>' +
      '</section>';

    return h;
  }

  /* ---------- 弹层 ---------- */

  function modalHTML() {
    var m = ui.modal;
    if (!m) return '';
    if (m.type === 'manual') {
      var r = m.round;
      var g = gameOf(r.game);
      return '<div class="zx-modal" role="dialog" aria-modal="true" aria-label="手动填开奖号">' +
        '<div class="zx-modal-h"><b>第 ' + esc(r.issue || '—') + ' 期开奖号</b><button type="button" class="zx-x" data-act="modal-close" aria-label="关闭">×</button></div>' +
        '<p class="zx-modal-p">按官方公告填，' + g.mainName + ' ' + g.mainPick + ' 个、' + g.subName + ' ' + g.subPick + ' 个，用空格或逗号隔开。</p>' +
        '<label class="zx-field"><span>' + g.mainName + '</span><input id="zxM1" inputmode="numeric" autocomplete="off" placeholder="如 04 09 15 21 23 30" value="' + esc(m.m1 || '') + '"></label>' +
        '<label class="zx-field"><span>' + g.subName + '</span><input id="zxM2" inputmode="numeric" autocomplete="off" placeholder="如 07" value="' + esc(m.m2 || '') + '"></label>' +
        (m.err ? '<div class="zx-err">' + esc(m.err) + '</div>' : '') +
        '<div class="zx-actions"><button type="button" class="zx-btn" data-act="submit-manual">对号</button></div>' +
        '</div>';
    }
    if (m.type === 'confirm') {
      return '<div class="zx-modal" role="dialog" aria-modal="true">' +
        '<div class="zx-modal-h"><b>' + esc(m.title || '确定？') + '</b><button type="button" class="zx-x" data-act="modal-close" aria-label="关闭">×</button></div>' +
        '<p class="zx-modal-p">' + esc(m.body || '') + '</p>' +
        '<div class="zx-actions"><button type="button" class="zx-btn danger" data-act="' + esc(m.okAct) + '"' +
        (m.okData ? (' data-id="' + esc(m.okData) + '"') : '') + '>' + esc(m.okText || '确定') + '</button>' +
        '<button type="button" class="zx-btn ghost" data-act="modal-close">算了</button></div>' +
        '</div>';
    }
    if (m.type === 'ai') {
      return '<div class="zx-modal" role="dialog" aria-modal="true">' +
        '<div class="zx-modal-h"><b>竹芯写的</b><button type="button" class="zx-x" data-act="modal-close" aria-label="关闭">×</button></div>' +
        '<div class="zx-aiout">' + esc(m.text || '').replace(/\n/g, '<br>') + '</div>' +
        '<div class="zx-actions"><button type="button" class="zx-btn ghost" data-act="modal-close">收起来</button></div>' +
        '</div>';
    }
    return '';
  }

  function ensureMask() {
    var doc = root.document;
    var m = doc.getElementById('zxMask');
    if (m) return m;
    m = doc.createElement('div');
    m.id = 'zxMask';
    m.className = 'zx-mask';
    m.innerHTML = '<div class="zx-maskbox" id="zxMaskBox"></div>';
    m.addEventListener('click', function (e) {
      if (e.target === m || (e.target.closest && e.target.closest('#zxMaskBox') && !e.target.closest('.zx-modal'))) {
        ui.modal = null; paint(true);
      }
    });
    doc.getElementById('zxPage').appendChild(m);
    return m;
  }

  /* ---------- 事件 ---------- */

  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-act');

    if (act === 'close') { close(); return; }
    if (act === 'modal-close') { ui.modal = null; paint(true); return; }

    if (act === 'tab') {
      var tab = t.getAttribute('data-tab');
      if (tab && tab !== ui.tab) { ui.tab = tab; paint(false); }
      return;
    }

    if (act === 'dim') {
      var dim = t.getAttribute('data-dim'), val = t.getAttribute('data-val');
      if (dim && val) {
        ui.draft[dim] = val;
        ui.preview = computePreview();
        paint(true);
      }
      return;
    }

    if (act === 'save-state') { saveDraft(); return; }
    if (act === 'toggle-states') { ui.showAllStates = !ui.showAllStates; paint(true); return; }

    if (act === 'use-state') {
      var id = t.getAttribute('data-id');
      var s = findState(readStates(), id);
      if (!s) return;
      ui.draft = normalizeDims(s.dims);
      ui.preview = computePreview();
      ui.tab = 'round';
      paint(false);
      toast('已切到「' + s.name + '」，去推演页排这一期');
      return;
    }

    if (act === 'del-state') {
      var did = t.getAttribute('data-id');
      var ds = findState(readStates(), did);
      if (!ds) return;
      ui.modal = { type: 'confirm', title: '删掉「' + ds.name + '」？', body: '它的记录会一起删掉，已经对过的期不受影响。', okText: '删掉', okAct: 'do-del-state', okData: did };
      ensureMask(); paint(true);
      return;
    }
    if (act === 'do-del-state') {
      var rid = t.getAttribute('data-id');
      var all = readStates().filter(function (x) { return x.id !== rid; });
      writeStates(all);
      ui.modal = null; ui.preview = computePreview(); paint(true);
      toast('删掉了');
      return;
    }

    if (act === 'plan') { doPlan(); return; }
    if (act === 'replan') { doPlan(true); return; }
    if (act === 'cancel-plan') { ui.plan = null; paint(true); return; }
    if (act === 'lock') { doLock(); return; }

    if (act === 'ask-draw') { doAskDraw(); return; }
    if (act === 'manual-draw') {
      var r = latestOpen();
      if (!r) return;
      ui.modal = { type: 'manual', round: r, m1: '', m2: '', err: '' };
      ensureMask(); paint(true);
      return;
    }
    if (act === 'submit-manual') { submitManual(); return; }
    if (act === 'toggle-round') {
      var tid = t.getAttribute('data-id');
      ui.detail = ui.detail === tid ? null : tid;
      paint(true);
      return;
    }
    if (act === 'ai-reflect') { doAiReflect(t.getAttribute('data-id')); return; }
    if (act === 'ai-hand') { doAiHand(); return; }
    if (act === 'export') { doExport(); return; }
    if (act === 'import') { doImport(); return; }
    if (act === 'wipe') {
      ui.modal = { type: 'confirm', title: '清空竹芯？', body: '状态、期次、手记全部删掉，删了找不回来。想留就先导出。', okText: '清空', okAct: 'do-wipe' };
      ensureMask(); paint(true);
      return;
    }
    if (act === 'do-wipe') {
      wipe(); ui.modal = null; ui.preview = null; paint(false);
      toast('清空了');
      return;
    }
  }

  function onChange(e) {
    var el = e.target;
    if (el.getAttribute && el.getAttribute('data-set')) {
      var k = el.getAttribute('data-set');
      var c = readCfg();
      if (k === 'game') { c.game = el.value; ui.game = el.value; ui.preview = null; }
      else if (k === 'perRound') { c.perRound = toInt(el.value) || 3; }
      writeCfg(c);
      paint(true);
    }
  }

  function onInput(e) {
    var el = e.target;
    if (ui.modal && ui.modal.type === 'manual') {
      if (el.id === 'zxM1') ui.modal.m1 = el.value;
      if (el.id === 'zxM2') ui.modal.m2 = el.value;
    }
  }

  /* ---------- 动作 ---------- */

  function saveDraft() {
    var res = upsertState(ui.draft, { game: ui.game });
    ui.preview = computePreview();
    paint(true);
    toast(res.created ? '记住了。以后同样六个词，还是这一注。' : '这个状态本来就在库里，刚给你更新了');
  }

  function doPlan(force) {
    var cfg = readCfg();
    var gameKey = ui.game || cfg.game || 'ssq';
    var draws = loadDraws(gameKey);
    var a = analysisOf(draws, gameKey, 60);
    var pool = readStates().filter(function (s) { return (s.game || 'ssq') === gameKey; });
    var n = clamp(toInt(cfg.perRound) || 3, 1, 5);
    var picks = [];

    if (!pool.length) {
      // 库里空着：临时按现在的时辰造几个，不写库
      var base = guessDims();
      var moods = ['平静', '发闷', '侥幸'];
      var srcs = ['手感', '生日', '上期改一个'];
      for (var i = 0; i < Math.min(n, 3); i++) {
        picks.push({ dims: { mood: moods[i], hour: base.hour, body: base.body, scene: base.scene, trigger: base.trigger, source: srcs[i] } });
      }
    } else {
      // 先给每个状态按这一期算一遍分
      var scored = pool.map(function (s) {
        var bp = basePoint(s.dims, gameKey, {
          prevMain: draws[0] ? draws[0].main : null, prevSub: draws[0] ? draws[0].sub : null,
          sumQ: a && a.sumQ ? a.sumQ : null, anchor: 'pick'
        });
        var sc = scoreTicket(bp, gameKey, { draws: draws, analysis: a, state: s });
        return { state: s, ticket: bp, score: sc.total };
      });
      scored.sort(function (x, y) { return y.score - x.score; });

      // 贪心：先拿分最高的，之后每次拿「分数 - 跟已选重合」最高的
      var taken = [];
      while (taken.length < n && scored.length) {
        var bestI = 0, bestV = -1e9;
        for (var j = 0; j < scored.length; j++) {
          var ov = 0;
          taken.forEach(function (x) { ov = Math.max(ov, inter(scored[j].ticket.main, x.ticket.main)); });
          // 第一位给最高分；从第二位起给新面孔加权。
          // 不然永远是那三注，状态库看着在长，样本却一直没摊开。
          var wear = (scored[j].state.used || 0) * 5;
          var v = scored[j].score - ov * 6 - wear;
          if (taken.length > 0 && !(scored[j].state.used || 0)) v += 16;
          if (v > bestV) { bestV = v; bestI = j; }
        }
        taken.push(scored[bestI]);
        scored.splice(bestI, 1);
      }
      picks = taken.map(function (x) { return { state: x.state }; });
    }

    ui.busy = '';
    ui.plan = planRound(gameKey, picks, { draws: draws, analysis: a, issue: nextIssue(draws, gameKey), dry: true });
    ui.plan.dry = true;
    paint(true);
  }

  function doLock() {
    if (!ui.plan) return;
    var plan = ui.plan;
    plan.dry = false;
    commitRound(plan);
    ui.plan = null;
    paint(false);
    toast('锁定了。开奖后回来对号。');
  }

  function latestOpen() {
    var rounds = readRounds();
    for (var i = 0; i < rounds.length; i++) if (rounds[i].phase !== 'drawn') return rounds[i];
    return null;
  }

  function doAskDraw() {
    var r = latestOpen();
    if (!r) return;
    ensureUI();
    ui.busy = 'draw';
    ui.err = '';
    paint(true);
    askDrawAI(r).then(function (data) {
      ui.busy = '';
      if (!data || !data.main || !data.sub) {
        ui.err = (data && data.reason) || '没查到这一期';
        paint(true);
        return;
      }
      var res = settleRound(r.id, { main: data.main, sub: data.sub, issue: data.issue || r.issue, date: data.date || r.date, by: 'ai' });
      if (!res.ok) { ui.err = res.error; paint(true); return; }
      ui.err = '';
      ui.detail = r.id;
      paint(false);
      scrollToDetail();
      toast(res.round.result && res.round.result.totalWin ? ('对上了，回收 ¥' + res.round.result.totalWin) : '对上了，这期没中');
    }).catch(function (err) {
      ui.busy = '';
      ui.err = (err && err.message) || '联网没成';
      paint(true);
    });
  }

  function askDrawAI(r) {
    var opts = root.__zxOpts || {};
    if (!opts.aiChat) return Promise.reject(new Error('还没配 AI。回首页，右上角齿轮 → 填上 DeepSeek 的接口和密钥，再回来点这里。'));
    var g = gameOf(r.game);
    var gn = g.name;
    var subj = r.issue ? ('第 ' + r.issue + ' 期') : (r.date ? (r.date + ' 那一期') : '最近一期');
    var q = gn + ' ' + (r.issue ? ('第' + r.issue + '期') : (r.date || '最近一期')) + ' 开奖结果 开奖号码';
    var want = [
      '只输出一个 JSON 对象，不要解释，不要代码块。',
      '{"found":true,"issue":"期号","date":"YYYY-MM-DD","main":[...],"sub":[...]}',
      'main 必须是 ' + g.mainPick + ' 个 1-' + g.mainMax + ' 的整数，sub 必须是 ' + g.subPick + ' 个 1-' + g.subMax + ' 的整数。',
      '找不到就输出 {"found":false,"reason":"还没开奖"} 或 {"found":false,"reason":"没查到"}。',
      '绝对不能编号码：资料里没有就是没有。'
    ].join('\n');
    return opts.aiChat('请从资料里找出「' + gn + '」' + subj + '的开奖结果。', 0.2, {
      webSearch: true, query: q,
      lead: '以下是刚刚联网搜到的真实资料。只依据这些资料作答，不要凭记忆补：\n',
      hint: want
    }).then(function (text) {
      var cut = String(text || '');
      var refs = '';
      var ri = cut.indexOf('__WEB_REFS__');
      if (ri >= 0) { refs = cut.slice(ri + 12); cut = cut.slice(0, ri); }
      var j = pickJson(cut);
      if (!j || (j.found !== true && j.found !== 'true')) {
        return { found: false, reason: (j && j.reason) ? String(j.reason).slice(0, 30) : '没查到' };
      }
      var main = numArr(j.main), sub = numArr(j.sub);
      var okMain = main.length === g.mainPick && main.every(function (n) { return n >= 1 && n <= g.mainMax; });
      var okSub = sub.length === g.subPick && sub.every(function (n) { return n >= 1 && n <= g.subMax; });
      if (!okMain || !okSub) return { found: false, reason: '号码格式不对，没敢用' };
      return { found: true, main: sortNum(main), sub: sortNum(sub), issue: j.issue || r.issue, date: j.date || r.date };
    });
  }

  function pickJson(text) {
    var s = String(text || '');
    var i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    var body = s.slice(i, j + 1);
    try { return JSON.parse(body); } catch (e) {}
    // 去掉尾逗号再试一次
    try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch (e) {}
    return null;
  }

  function numArr(v) {
    if (Array.isArray(v)) return v.map(toInt).filter(function (n) { return n > 0; });
    if (typeof v === 'string') return (v.match(/\d{1,2}/g) || []).map(toInt).filter(function (n) { return n > 0; });
    return [];
  }

  function submitManual() {
    var m = ui.modal;
    if (!m || m.type !== 'manual') return;
    var r = m.round;
    var g = gameOf(r.game);
    var main = numArr(m.m1 || ''), sub = numArr(m.m2 || '');
    if (main.length !== g.mainPick) { m.err = g.mainName + '要 ' + g.mainPick + ' 个，现在是 ' + main.length + ' 个'; paint(true); return; }
    if (sub.length !== g.subPick) { m.err = g.subName + '要 ' + g.subPick + ' 个，现在是 ' + sub.length + ' 个'; paint(true); return; }
    var res = settleRound(r.id, { main: main, sub: sub, by: 'manual' });
    if (!res.ok) { m.err = res.error; paint(true); return; }
    ui.modal = null;
    ui.detail = r.id;
    paint(false);
    scrollToDetail();
    toast(res.round.result && res.round.result.totalWin ? ('对上了，回收 ¥' + res.round.result.totalWin) : '对上了，这期没中');
  }

  function scrollToDetail() {
    setTimeout(function () {
      var el = root.document.querySelector('.zx-hist.open');
      if (el && el.scrollIntoView) {
        try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) {}
      }
    }, 60);
  }

  function doAiReflect(id) {
    var rounds = readRounds();
    var r = null;
    rounds.forEach(function (x) { if (x.id === id) r = x; });
    if (!r) return;
    var opts = root.__zxOpts || {};
    if (!opts.aiChat) { toast('还没配 AI'); return; }
    if (r.aiBusy) return;
    r.aiBusy = true;
    writeRounds(rounds);
    paint(true);
    opts.aiChat(buildReflectPrompt(r), 0.5).then(function (text) {
      var all = readRounds();
      all.forEach(function (x) {
        if (x.id === id) {
          x.reflect = x.reflect || {};
          x.reflect.ai = String(text || '').trim();
        }
      });
      writeRounds(all);
      var rr = null; all.forEach(function (x) { if (x.id === id) rr = x; });
      if (rr) { rr.aiBusy = false; }
      writeRounds(all);
      paint(true);
    }).catch(function (e) {
      var all = readRounds();
      all.forEach(function (x) { if (x.id === id) x.aiBusy = false; });
      writeRounds(all);
      paint(true);
      toast('没写成：' + ((e && e.message) || '接口没回'));
    });
  }

  function doAiHand() {
    var opts = root.__zxOpts || {};
    if (!opts.aiChat) { toast('还没配 AI'); return; }
    if (ui.noteBusy) return;
    var rounds = readRounds(), states = readStates();
    var agg = aggregate(states, rounds);
    var lines = insightLines(agg, rounds);
    if (!rounds.filter(function (r) { return r.phase === 'drawn'; }).length) {
      toast('还没开过一期，没什么可写的');
      return;
    }
    ui.noteBusy = true;
    paint(true);
    opts.aiChat(buildInsightPrompt(lines, agg, rounds), 0.6).then(function (text) {
      ui.noteBusy = false;
      var old = readInsights();
      old.unshift(mkInsight('ai', String(text || '').trim()));
      writeInsights(old);
      ui.modal = { type: 'ai', text: String(text || '').trim() };
      ensureMask(); paint(true);
    }).catch(function (e) {
      ui.noteBusy = false;
      paint(true);
      toast('没写成：' + ((e && e.message) || '接口没回'));
    });
  }

  function doExport() {
    var doc = root.document;
    var data = JSON.stringify(exportAll(), null, 2);
    try {
      var blob = new root.Blob([data], { type: 'application/json' });
      var a = doc.createElement('a');
      a.href = root.URL.createObjectURL(blob);
      a.download = '竹芯-档案-' + todayKey() + '.json';
      doc.body.appendChild(a);
      a.click();
      setTimeout(function () { root.URL.revokeObjectURL(a.href); a.remove(); }, 800);
      toast('导出好了');
    } catch (e) { toast('导出没成'); }
  }

  function doImport() {
    var doc = root.document;
    var f = doc.getElementById('zxImportFile');
    if (!f) {
      f = doc.createElement('input');
      f.type = 'file';
      f.accept = '.json,application/json';
      f.id = 'zxImportFile';
      f.style.display = 'none';
      doc.getElementById('zxPage').appendChild(f);
      f.addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var rd = new root.FileReader();
        rd.onload = function () {
          try {
            var obj = JSON.parse(String(rd.result || ''));
            var res = importAll(obj);
            toast(res.ok ? ('导入好了：' + res.states + ' 个状态、' + res.rounds + ' 期') : res.error);
            paint(false);
          } catch (err) { toast('这个文件读不出来'); }
        };
        rd.readAsText(file, 'utf-8');
        e.target.value = '';
      });
    }
    f.click();
  }

  /* ---------- 开关 ---------- */

  function open() {
    ensureUI();
    var doc = root.document;
    if (!doc.getElementById('zxPage')) buildShell();
    ensureMask();
    var el = doc.getElementById('zxPage');
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    doc.body.classList.add('zx-locked');
    ui.open = true;
    ui.err = '';
    ui.plan = null;
    ui.preview = computePreview();
    paint(false);
    return true;
  }

  function close() {
    var doc = root.document;
    var el = doc.getElementById('zxPage');
    if (el) {
      el.classList.remove('open');
      el.setAttribute('aria-hidden', 'true');
    }
    doc.body.classList.remove('zx-locked');
    ensureUI().open = false;
  }

  function isOpen() { return !!(ui && ui.open); }

  return {
    V: V, KEY: KEY, DIMS: DIMS, DIM_MAP: DIM_MAP,
    gameOf: gameOf, games: games,
    stateKeyOf: stateKeyOf, stateNameOf: stateNameOf, normalizeDims: normalizeDims,
    biasOf: biasOf, numberWeight: numberWeight, basePoint: basePoint,
    scoreTicket: scoreTicket, bandOf: bandOf, localStructure: localStructure,
    analysisOf: analysisOf, aggregate: aggregate,
    readStates: readStates, writeStates: writeStates,
    readRounds: readRounds, writeRounds: writeRounds,
    readInsights: readInsights, writeInsights: writeInsights,
    readCfg: readCfg, writeCfg: writeCfg,
    upsertState: upsertState, findState: findState, bumpState: bumpState,
    nextIssue: nextIssue, drawWhen: drawWhen, planRound: planRound, settleRound: settleRound,
    reflectLocal: reflectLocal, insightsFromRound: insightsFromRound, insightLines: insightLines,
    buildReflectPrompt: buildReflectPrompt, buildInsightPrompt: buildInsightPrompt, aiMaterial: aiMaterial,
    exportAll: exportAll, importAll: importAll, wipe: wipe,
    commitRound: commitRound,
    pad2: pad2, esc: esc, toInt: toInt,
    open: open, close: close, isOpen: isOpen,
    _ui: function () { return ui; }
  };
});
