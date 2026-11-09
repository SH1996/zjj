/* 竹间记 · 数彩实验室
 * 纯前端、可复现的历史统计与娱乐候选生成。
 * 重要边界：公平开奖相互独立，历史统计不能提高任意合法组合的中奖概率。
 * AI 只解释本模块的真实计算结果，不参与历史数据生产，也不能修改候选号码。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LotteryLab = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  var STORAGE_KEY = 'bamboo.v13.lottery.data';
  var MAX_STORED_DRAWS = 500;
  var GAMES = {
    ssq: {
      key: 'ssq', name: '双色球', mainName: '红球', subName: '蓝球',
      mainMax: 33, mainPick: 6, subMax: 16, subPick: 1,
      sourceName: '中国福彩网', sourceUrl: 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/',
      ruleUrl: 'https://www.cwl.gov.cn/fcpz/yxjs/ssq',
      directSync: false
    },
    dlt: {
      key: 'dlt', name: '超级大乐透', mainName: '前区', subName: '后区',
      mainMax: 35, mainPick: 5, subMax: 12, subPick: 2,
      sourceName: '中国体彩网', sourceUrl: 'https://www.lottery.gov.cn/kj/kjlb.html?dlt',
      ruleUrl: 'https://www.lottery.gov.cn/tzgg/20190202/72410.html',
      // 实测：体彩网关（EdgeOne WAF）会拦截浏览器跨域 GET（567），故也走引导导入，
      // 不使用任何第三方 CORS 代理，保证数据永远来自官方页面
      directSync: false
    }
  };

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function mean(a) { return a.length ? sum(a) / a.length : 0; }
  function uniqueSorted(a) {
    var seen = {}, out = [];
    for (var i = 0; i < a.length; i++) {
      if (!seen[a[i]]) { seen[a[i]] = true; out.push(a[i]); }
    }
    return out.sort(function (x, y) { return x - y; });
  }
  function combination(n, k) {
    if (k < 0 || k > n) return 0;
    k = Math.min(k, n - k);
    var r = 1;
    for (var i = 1; i <= k; i++) r = r * (n - k + i) / i;
    return Math.round(r);
  }
  function quantile(values, q) {
    if (!values.length) return 0;
    var a = values.slice().sort(function (x, y) { return x - y; });
    var pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }
  function fmt(x, digits) {
    if (!isFinite(x)) return '—';
    return Number(x).toFixed(digits == null ? 2 : digits);
  }
  function modeOf(map) {
    var best = '', count = -1;
    Object.keys(map || {}).forEach(function (k) {
      if (map[k] > count) { best = k; count = map[k]; }
    });
    return { key: best, count: Math.max(0, count) };
  }
  function intersectionCount(a, b) {
    var set = {}, n = 0;
    for (var i = 0; i < a.length; i++) set[a[i]] = true;
    for (var j = 0; j < b.length; j++) if (set[b[j]]) n++;
    return n;
  }

  function normalizeNumberList(value) {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'number') return [value];
    return String(value == null ? '' : value).trim().split(/[\s,，+、|]+/).filter(Boolean).map(Number);
  }

  function normalizeDraw(raw, gameKey) {
    var g = GAMES[gameKey];
    if (!g) throw new Error('未知彩种');
    var issue = '', date = '', main, sub;
    if (Array.isArray(raw)) {
      issue = String(raw[0] == null ? '' : raw[0]).trim();
      date = String(raw[1] == null ? '' : raw[1]).trim().slice(0, 10);
      main = normalizeNumberList(raw[2]);
      sub = normalizeNumberList(raw[3]);
    } else {
      raw = raw || {};
      issue = String(raw.issue || raw.code || raw.lotteryDrawNum || '').trim();
      date = String(raw.date || raw.lotteryDrawTime || '').trim().slice(0, 10);
      if (raw.lotteryDrawResult) {
        var all = normalizeNumberList(raw.lotteryDrawResult);
        main = all.slice(0, g.mainPick);
        sub = all.slice(g.mainPick);
      } else {
        main = normalizeNumberList(raw.main != null ? raw.main : raw.red);
        sub = normalizeNumberList(raw.sub != null ? raw.sub : raw.blue);
      }
    }
    if (!/^\d{5,8}$/.test(issue)) throw new Error('期号应为 5–8 位数字');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期应为 YYYY-MM-DD');
    if (date) {
      var dp = date.split('-').map(Number), dt = new Date(dp[0], dp[1] - 1, dp[2]);
      if (dt.getFullYear() !== dp[0] || dt.getMonth() !== dp[1] - 1 || dt.getDate() !== dp[2]) throw new Error('日期不是真实日历日期');
    }
    if (main.length !== g.mainPick || sub.length !== g.subPick) {
      throw new Error(g.name + '每期应有 ' + g.mainPick + ' 个' + g.mainName + '和 ' + g.subPick + ' 个' + g.subName);
    }
    function check(nums, max, label) {
      for (var i = 0; i < nums.length; i++) {
        if (!Number.isInteger(nums[i]) || nums[i] < 1 || nums[i] > max) {
          throw new Error(label + '存在越界或非整数号码');
        }
      }
      if (uniqueSorted(nums).length !== nums.length) throw new Error(label + '同一区号码不能重复');
    }
    check(main, g.mainMax, g.mainName);
    check(sub, g.subMax, g.subName);
    return { issue: issue, date: date, main: main.slice().sort(function (a,b){return a-b;}), sub: sub.slice().sort(function (a,b){return a-b;}) };
  }

  function sortDraws(draws) {
    return draws.slice().sort(function (a, b) {
      if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.issue < b.issue ? 1 : (a.issue > b.issue ? -1 : 0);
    });
  }

  function normalizeDraws(input, gameKey) {
    if (!Array.isArray(input)) throw new Error('历史数据必须是数组');
    var out = [], byIssue = {};
    for (var i = 0; i < input.length; i++) {
      var d;
      try { d = normalizeDraw(input[i], gameKey); }
      catch (e) { throw new Error('第 ' + (i + 1) + ' 条：' + e.message); }
      if (byIssue[d.issue]) {
        var old = byIssue[d.issue];
        if (old.main.join(',') !== d.main.join(',') || old.sub.join(',') !== d.sub.join(',')) {
          throw new Error('期号 ' + d.issue + ' 存在相互冲突的号码');
        }
        if (!old.date && d.date) old.date = d.date;
      } else {
        byIssue[d.issue] = d;
        out.push(d);
      }
    }
    if (!out.length) throw new Error('没有可用的开奖记录');
    return sortDraws(out);
  }

  function mergeDraws(existing, incoming, gameKey) {
    var old = existing && existing.length ? normalizeDraws(existing, gameKey) : [];
    var add = incoming && incoming.length ? normalizeDraws(incoming, gameKey) : [];
    if (!old.length && !add.length) throw new Error('没有可合并的开奖记录');
    return normalizeDraws(old.concat(add), gameKey).slice(0, MAX_STORED_DRAWS);
  }

  function parseImport(text, gameKey) {
    var source = String(text == null ? '' : text).trim();
    if (!source) throw new Error('请先粘贴开奖数据或选择文件');
    if (source.charAt(0) === '[' || source.charAt(0) === '{') {
      var data;
      try { data = JSON.parse(source); } catch (e) { throw new Error('JSON 格式错误：' + e.message); }
      if (!Array.isArray(data)) data = data.draws || data[gameKey] || data.result || (data.value && data.value.list);
      return normalizeDraws(data, gameKey);
    }
    var g = GAMES[gameKey], rows = [], errors = [];
    var lines = source.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      try {
        var issueMatch = line.match(/\b\d{5,8}\b/);
        if (!issueMatch) throw new Error('找不到期号');
        var issue = issueMatch[0];
        var rest = (line.slice(0, issueMatch.index) + ' ' + line.slice(issueMatch.index + issue.length));
        var dateMatch = rest.match(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/);
        var date = '';
        if (dateMatch) {
          var parts = dateMatch[0].match(/\d+/g);
          date = parts[0] + '-' + pad2(Number(parts[1])) + '-' + pad2(Number(parts[2]));
          rest = rest.replace(dateMatch[0], ' ');
        }
        var nums = (rest.match(/(?<![\d])\d{1,2}(?![\d])/g) || []).map(Number);
        var needed = g.mainPick + g.subPick;
        if (nums.length !== needed) throw new Error('需要 ' + needed + ' 个号码，实际读到 ' + nums.length + ' 个');
        rows.push({ issue: issue, date: date, main: nums.slice(0, g.mainPick), sub: nums.slice(g.mainPick) });
      } catch (e) { errors.push('第 ' + (i + 1) + ' 行：' + e.message); }
    }
    if (errors.length) throw new Error(errors.slice(0, 5).join('；') + (errors.length > 5 ? '；另有 ' + (errors.length - 5) + ' 处错误' : ''));
    return normalizeDraws(rows, gameKey);
  }

  // 正则化不完全 Gamma 函数 Q(a,x)，用于卡方检验上尾概率。
  function logGamma(x) {
    var c = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012,
      9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    x -= 1;
    var a = 0.9999999999998099, t = x + 7.5;
    for (var i = 0; i < c.length; i++) a += c[i] / (x + i + 1);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  function gammaQ(a, x) {
    if (x < 0 || a <= 0) return NaN;
    if (x === 0) return 1;
    var IT = 200, EPS = 3e-10, FPMIN = 1e-300;
    if (x < a + 1) {
      var ap = a, term = 1 / a, total = term;
      for (var n = 1; n <= IT; n++) {
        ap++; term *= x / ap; total += term;
        if (Math.abs(term) < Math.abs(total) * EPS) break;
      }
      return clamp(1 - total * Math.exp(-x + a * Math.log(x) - logGamma(a)), 0, 1);
    }
    var b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
    for (var i = 1; i <= IT; i++) {
      var an = -i * (i - a);
      b += 2; d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      var delta = d * c; h *= delta;
      if (Math.abs(delta - 1) < EPS) break;
    }
    return clamp(Math.exp(-x + a * Math.log(x) - logGamma(a)) * h, 0, 1);
  }
  function chiSquareP(chi2, df) { return gammaQ(df / 2, chi2 / 2); }

  function numberStats(draws, allDraws, max, pick, selector) {
    var counts = new Array(max + 1).fill(0), longCounts = new Array(max + 1).fill(0), gaps = new Array(max + 1).fill(draws.length);
    var i, j, nums;
    for (i = 0; i < draws.length; i++) {
      nums = selector(draws[i]);
      for (j = 0; j < nums.length; j++) counts[nums[j]]++;
    }
    for (i = 0; i < allDraws.length; i++) {
      nums = selector(allDraws[i]);
      for (j = 0; j < nums.length; j++) longCounts[nums[j]]++;
    }
    for (i = 0; i < draws.length; i++) {
      nums = selector(draws[i]);
      for (j = 0; j < nums.length; j++) if (gaps[nums[j]] === draws.length) gaps[nums[j]] = i;
    }
    var p = pick / max, expected = draws.length * p, variance = Math.max(1e-9, draws.length * p * (1 - p));
    var longExpected = allDraws.length * p, longVariance = Math.max(1e-9, allDraws.length * p * (1 - p));
    var out = [], chi2 = 0;
    for (var n = 1; n <= max; n++) {
      var z = (counts[n] - expected) / Math.sqrt(variance);
      var longZ = (longCounts[n] - longExpected) / Math.sqrt(longVariance);
      chi2 += Math.pow(counts[n] - expected, 2) / expected;
      out.push({ n: n, count: counts[n], expected: expected, z: z, longCount: longCounts[n], longZ: longZ,
        gap: gaps[n], posterior: (counts[n] + 20 * p) / (draws.length + 20) });
    }
    return { list: out, counts: counts, chi2: chi2, df: max - 1, p: chiSquareP(chi2, max - 1) };
  }

  function structureOf(main, previousMain, max) {
    var odd = 0, zones = [0,0,0], consecutive = 0;
    var bound1 = Math.ceil(max / 3), bound2 = Math.ceil(max * 2 / 3);
    for (var i = 0; i < main.length; i++) {
      if (main[i] % 2) odd++;
      zones[main[i] <= bound1 ? 0 : (main[i] <= bound2 ? 1 : 2)]++;
      if (i && main[i] === main[i - 1] + 1) consecutive++;
    }
    return { odd: odd, sum: sum(main), span: main[main.length - 1] - main[0],
      zones: zones.join(':'), consecutive: consecutive,
      repeat: previousMain ? intersectionCount(main, previousMain) : 0 };
  }

  function addCount(map, key) { map[key] = (map[key] || 0) + 1; }
  function probabilityOf(map, key, total) { return ((map[key] || 0) + 1) / (total + Object.keys(map).length + 1); }

  function analyze(input, gameKey, windowSize) {
    var g = GAMES[gameKey];
    var all = normalizeDraws(input, gameKey);
    var w = Number(windowSize) > 0 ? Math.min(Number(windowSize), all.length) : all.length;
    var draws = all.slice(0, w); // 新到旧
    var main = numberStats(draws, all, g.mainMax, g.mainPick, function(d){return d.main;});
    var sub = numberStats(draws, all, g.subMax, g.subPick, function(d){return d.sub;});
    var pairs = {}, structures = [], dist = { odd:{}, zones:{}, consecutive:{}, repeat:{}, sumBucket:{}, spanBucket:{} };
    var i, j, k;
    for (i = 0; i < draws.length; i++) {
      var st = structureOf(draws[i].main, draws[i + 1] ? draws[i + 1].main : null, g.mainMax);
      structures.push(st);
      addCount(dist.odd, st.odd); addCount(dist.zones, st.zones);
      addCount(dist.consecutive, st.consecutive > 0 ? 'yes' : 'no');
      if (draws[i + 1]) addCount(dist.repeat, st.repeat);
      addCount(dist.sumBucket, Math.floor(st.sum / 10));
      addCount(dist.spanBucket, Math.floor(st.span / 5));
      for (j = 0; j < draws[i].main.length; j++) {
        for (k = j + 1; k < draws[i].main.length; k++) {
          var key = draws[i].main[j] + '-' + draws[i].main[k];
          addCount(pairs, key);
        }
      }
    }
    var pairRows = [];
    Object.keys(pairs).forEach(function (key) {
      var ab = key.split('-').map(Number), count = pairs[key];
      var expected = draws.length * g.mainPick * (g.mainPick - 1) / (g.mainMax * (g.mainMax - 1));
      var independent = (main.counts[ab[0]] / draws.length) * (main.counts[ab[1]] / draws.length) * draws.length;
      pairRows.push({ a: ab[0], b: ab[1], count: count, expected: expected,
        lift: independent > 0 ? count / independent : 0,
        stabilized: (count + 1) / (expected + 1) });
    });
    pairRows.sort(function (a,b) { return (b.count - a.count) || (b.lift - a.lift) || (a.a - b.a) || (a.b - b.b); });
    var pairMap = {};
    pairRows.forEach(function (p) { pairMap[p.a + '-' + p.b] = p; });
    var oddMode = modeOf(dist.odd), zoneMode = modeOf(dist.zones);
    var hot = main.list.slice().sort(function(a,b){return (b.z-a.z)||(a.n-b.n);});
    var cold = hot.slice().reverse();
    var gaps = main.list.slice().sort(function(a,b){return (b.gap-a.gap)||(a.n-b.n);});
    var expectedMainHits = g.mainPick * g.mainPick / g.mainMax;
    var expectedSubHits = g.subPick * g.subPick / g.subMax;
    return {
      game: g, all: all, draws: draws, main: main, sub: sub, structures: structures, dist: dist,
      pairs: pairRows, pairMap: pairMap, hot: hot.slice(0,6), cold: cold.slice(0,6), gaps: gaps.slice(0,6),
      oddMode: oddMode, zoneMode: zoneMode,
      sumQ: [quantile(structures.map(function(s){return s.sum;}),0.25), quantile(structures.map(function(s){return s.sum;}),0.5), quantile(structures.map(function(s){return s.sum;}),0.75)],
      spanQ: [quantile(structures.map(function(s){return s.span;}),0.25), quantile(structures.map(function(s){return s.span;}),0.5), quantile(structures.map(function(s){return s.span;}),0.75)],
      consecutiveRate: structures.filter(function(s){return s.consecutive>0;}).length / structures.length,
      repeatMean: mean(structures.slice(0,-1).map(function(s){return s.repeat;})),
      expectedMainHits: expectedMainHits, expectedSubHits: expectedSubHits,
      jackpotCombinations: combination(g.mainMax,g.mainPick) * combination(g.subMax,g.subPick)
    };
  }

  function hashSeed(str) {
    var h = 1779033703 ^ String(str).length;
    for (var i = 0; i < String(str).length; i++) {
      h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353);
      h = h << 13 | h >>> 19;
    }
    return function () {
      h = Math.imul(h ^ h >>> 16, 2246822507);
      h = Math.imul(h ^ h >>> 13, 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function rngFrom(seed) {
    var a = hashSeed(seed)();
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function weightedPick(stats, count, rng, uniform) {
    var pool = stats.map(function (s) {
      var score = uniform ? 0 : clamp(0.42 * s.z + 0.16 * s.longZ, -1.4, 1.4);
      return { n: s.n, weight: Math.exp(score) };
    }), out = [];
    while (out.length < count && pool.length) {
      var total = pool.reduce(function(a,b){return a+b.weight;},0), r = rng() * total, idx = 0;
      for (; idx < pool.length - 1; idx++) { r -= pool[idx].weight; if (r <= 0) break; }
      out.push(pool[idx].n); pool.splice(idx,1);
    }
    return out.sort(function(a,b){return a-b;});
  }
  function candidateMetrics(main, sub, analysis) {
    var g = analysis.game;
    var st = structureOf(main, analysis.draws[0] ? analysis.draws[0].main : null, g.mainMax);
    st.sumBucket = Math.floor(st.sum / 10); st.spanBucket = Math.floor(st.span / 5);
    var hotCount = 0, coldCount = 0, maxGap = 0, pairLog = 0, pairN = 0;
    main.forEach(function(n){
      var s = analysis.main.list[n-1];
      if (s.z >= 0.75) hotCount++;
      if (s.z <= -0.75) coldCount++;
      maxGap = Math.max(maxGap, s.gap);
    });
    for (var i=0;i<main.length;i++) for (var j=i+1;j<main.length;j++) {
      var key=main[i]+'-'+main[j], found=analysis.pairMap[key];
      pairLog += Math.log(found ? found.stabilized : 1 / (analysis.draws.length * g.mainPick * (g.mainPick-1) / (g.mainMax*(g.mainMax-1)) + 1));
      pairN++;
    }
    var structureLog = Math.log(probabilityOf(analysis.dist.odd,st.odd,analysis.draws.length)) +
      Math.log(probabilityOf(analysis.dist.zones,st.zones,analysis.draws.length)) +
      Math.log(probabilityOf(analysis.dist.consecutive,st.consecutive>0?'yes':'no',analysis.draws.length)) +
      Math.log(probabilityOf(analysis.dist.sumBucket,st.sumBucket,analysis.draws.length)) +
      Math.log(probabilityOf(analysis.dist.spanBucket,st.spanBucket,analysis.draws.length));
    return { main:main, sub:sub, structure:st, hotCount:hotCount, coldCount:coldCount, maxGap:maxGap,
      pairMeanLog:pairN?pairLog/pairN:0, structureLog:structureLog/5 };
  }
  function candidateReasons(c, analysis) {
    var g=analysis.game, s=c.structure, out=[];
    out.push('奇偶 ' + s.odd + ':' + (g.mainPick-s.odd) + ' · 三区 ' + s.zones);
    out.push('和值 ' + s.sum + (s.sum>=analysis.sumQ[0]&&s.sum<=analysis.sumQ[2]?'（中间50%区间）':'（区间外）'));
    out.push('跨度 ' + s.span + ' · 连号 ' + s.consecutive + ' 组 · 与上期重复 ' + s.repeat + ' 个');
    out.push('近期偏高 ' + c.hotCount + ' 个 · 偏低 ' + c.coldCount + ' 个 · 最大遗漏 ' + c.maxGap + ' 期');
    return out;
  }

  // 冷门模式：均匀采样 → 按「拥挤度」升序 → 挑互相不太像的几注
  // 概率和纯随机完全一样（都是等概率抽样），区别只在挑哪几个
  function coldCandidates(analysis, gameKey, options) {
    options = options || {};
    var g = analysis.game, count = clamp(Number(options.count) || 5, 1, 10);
    var rng = rngFrom(String(options.seed || 'bamboo-cold') + '|cold|' + gameKey + '|' + (analysis.all[0] ? analysis.all[0].issue : ''));
    var prevMain = analysis.all[0] ? analysis.all[0].main : null;
    var pool = [], seen = {}, i, tries = 0;
    while (pool.length < 420 && tries++ < 2600) {
      var main = weightedPick(analysis.main.list, g.mainPick, rng, true);
      var sub = weightedPick(analysis.sub.list, g.subPick, rng, true);
      var key = main.join(',') + '+' + sub.join(',');
      if (seen[key]) continue;
      seen[key] = 1;
      pool.push({ main: main, sub: sub });
    }
    // 池里按拥挤度排序；同一热度用随机数打散，避免每次都挑到同一批
    var scored = pool.map(function (c, idx) {
      var cp = crowdProfile(c.main, c.sub, g, prevMain);
      return { main: c.main, sub: c.sub, crowd: cp, jitter: idx };
    });
    scored.sort(function (a, b) { return (a.crowd.heat - b.crowd.heat) || (a.jitter - b.jitter); });
    var out = [], maxOverlap = Math.max(1, g.mainPick - 2);
    for (i = 0; i < scored.length && out.length < count; i++) {
      var c2 = scored[i], ok = true;
      for (var j = 0; j < out.length; j++) {
        if (intersectionCount(c2.main, out[j].main) > maxOverlap) { ok = false; break; }
      }
      if (!ok) continue;
      c2.structure = structureOf(c2.main, prevMain, g.mainMax);
      c2.reasons = candidateReasons(c2, analysis);
      c2.key = c2.main.join(',') + '+' + c2.sub.join(',');
      out.push(c2);
    }
    // 候选不够（要求太严）时放宽重叠限制补足
    for (i = 0; i < scored.length && out.length < count; i++) {
      if (out.indexOf(scored[i]) > -1) continue;
      var c3 = scored[i];
      c3.structure = structureOf(c3.main, prevMain, g.mainMax);
      c3.reasons = candidateReasons(c3, analysis);
      c3.key = c3.main.join(',') + '+' + c3.sub.join(',');
      out.push(c3);
    }
    return out.slice(0, count);
  }

  function generateCandidates(input, gameKey, options) {
    options=options||{};
    var analysis=options.analysis||analyze(input,gameKey,options.windowSize||60);
    if (options.mode === 'cold') return coldCandidates(analysis, gameKey, options);
    var g=analysis.game, count=clamp(Number(options.count)||5,1,10), uniform=options.mode==='uniform';
    var seed=String(options.seed||'bamboo-lottery'), rng=rngFrom(seed+'|'+gameKey+'|'+analysis.draws[0].issue+'|'+analysis.draws.length);
    var candidates=[], seen={};
    for (var line=0;line<count;line++) {
      var best=null,bestScore=-Infinity;
      for (var attempt=0;attempt<90;attempt++) {
        var main=weightedPick(analysis.main.list,g.mainPick,rng,uniform);
        var sub=weightedPick(analysis.sub.list,g.subPick,rng,uniform);
        var key=main.join(',')+'+'+sub.join(',');
        if (seen[key]) continue;
        var c=candidateMetrics(main,sub,analysis), overlap=0;
        for (var q=0;q<candidates.length;q++) overlap=Math.max(overlap,intersectionCount(main,candidates[q].main));
        var diversityPenalty=overlap*0.22 + (candidates.length&&overlap>=g.mainPick-1?0.8:0);
        var score=(uniform?0:0.55*c.structureLog+0.30*c.pairMeanLog)-diversityPenalty+rng()*0.015;
        if (score>bestScore) {bestScore=score;best=c;}
      }
      if (!best) {
        var m=weightedPick(analysis.main.list,g.mainPick,rng,true), s=weightedPick(analysis.sub.list,g.subPick,rng,true);
        best=candidateMetrics(m,s,analysis);
      }
      var finalKey=best.main.join(',')+'+'+best.sub.join(',');
      if (seen[finalKey]) { line--; continue; }
      seen[finalKey]=true;
      best.reasons=candidateReasons(best,analysis);
      best.key=finalKey;
      candidates.push(best);
    }
    return candidates;
  }

  function hypergeometric(N,K,n,x) {
    return combination(K,x)*combination(N-K,n-x)/combination(N,n);
  }
  function backtest(input, gameKey, options) {
    options=options||{};
    var all=normalizeDraws(input,gameKey), trainMin=Number(options.trainMin)||30;
    var testCount=Number(options.testCount)||30, lines=Number(options.lines)||3;
    if (all.length<trainMin+5) return {insufficient:true,available:all.length,required:trainMin+5,rows:[]};
    var start=Math.min(all.length-trainMin-1,testCount-1), rows=[];
    for (var i=start;i>=0;i--) {
      var target=all[i], train=all.slice(i+1), w=Math.min(Number(options.windowSize)||60,train.length);
      var a=analyze(train,gameKey,w);
      var stat=generateCandidates(train,gameKey,{analysis:a,count:lines,mode:'statistical',seed:'backtest-stat-'+target.issue});
      var random=generateCandidates(train,gameKey,{analysis:a,count:lines,mode:'uniform',seed:'backtest-random-'+target.issue});
      function hits(cs) {
        var mh=0,sh=0,ge2=0,ge3=0;
        cs.forEach(function(c){var h=intersectionCount(c.main,target.main);mh+=h;sh+=intersectionCount(c.sub,target.sub);if(h>=2)ge2++;if(h>=3)ge3++;});
        return {main:mh/cs.length,sub:sh/cs.length,atLeast2:ge2/cs.length,atLeast3:ge3/cs.length};
      }
      rows.push({issue:target.issue,date:target.date,trainCount:train.length,trainLatest:train[0].issue,
        statistical:hits(stat),uniform:hits(random),actual:target});
    }
    var result={insufficient:false,rows:rows,trainMin:trainMin,lines:lines};
    ['statistical','uniform'].forEach(function(k){
      result[k]={main:mean(rows.map(function(r){return r[k].main;})),sub:mean(rows.map(function(r){return r[k].sub;})),
        atLeast2:mean(rows.map(function(r){return r[k].atLeast2;})),atLeast3:mean(rows.map(function(r){return r[k].atLeast3;}))};
    });
    result.randomAtLeast2=1-hypergeometric(GAMES[gameKey].mainMax,GAMES[gameKey].mainPick,GAMES[gameKey].mainPick,0)-hypergeometric(GAMES[gameKey].mainMax,GAMES[gameKey].mainPick,GAMES[gameKey].mainPick,1);
    return result;
  }

  // ==================== 冷门度 / 覆盖设计 / 诚实体检 ====================
  // 一句话边界：这三块都不会提高单注中奖概率。
  // 冷门度影响的是「中了以后跟多少人分」，覆盖设计提高的是「条件命中」，
  // 体检用来判断「前面这些到底有没有用」，结论允许是「没有」。

  function popcount(x) {
    x = x - ((x >> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    x = (x + (x >> 4)) & 0x0f0f0f0f;
    return (x * 0x01010101) >> 24;
  }
  function erfc(x) {
    var z = Math.abs(x), t = 1 / (1 + z / 2);
    var r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
      t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
      t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  function normalTwoTail(z) { return erfc(Math.abs(z) / Math.SQRT2); }
  function betacf(a, b, x) {
    var MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300;
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
  function betai(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
    return 1 - bt * betacf(b, a, 1 - x) / b;
  }
  function studentTTwoTail(t, df) {
    if (!isFinite(t) || df <= 0) return 1;
    return clamp(betai(df / 2, 0.5, df / (df + t * t)), 0, 1);
  }
  // t 分布双侧临界值（df 较小时用表，之后用正态近似）
  function tCritical(df, alpha) {
    var table = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306,
      9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120,
      17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064,
      25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042 };
    var a = alpha == null ? 0.05 : alpha;
    if (a === 0.05 && table[Math.round(df)]) return table[Math.round(df)];
    if (df > 200) return a === 0.05 ? 1.96 : 2.576;
    return a === 0.05 ? 1.96 + 2.4 / df : 2.576 + 3.2 / df;
  }

  /* ---------- 1. 冷门度 ---------- */
  // 号码受欢迎程度的经验权重：来自公开讨论最多的购彩习惯（生日号、吉利号、避讳号）。
  // 这是模型，不是实测销量；它只用于估算「跟多少人分」，绝不影响中奖概率。
  function numPopularity(n) {
    var w;
    if (n <= 12) w = 2.15;        // 月份和日期都能用上，最挤
    else if (n <= 31) w = 1.35;   // 只能当日期
    else w = 0.42;                // 超出日期范围，几乎没人挑
    if (n === 6 || n === 8 || n === 9 || n === 16 || n === 18 || n === 28) w *= 1.14;
    if (n === 4 || n === 13 || n === 14 || n === 24) w *= 0.86;
    return w;
  }
  function baselineLogPopularity(max) {
    var s = 0, i;
    for (i = 1; i <= max; i++) s += Math.log(numPopularity(i));
    return s / max;
  }
  function tailRepeat(main, prevMain) {
    if (!prevMain) return 0;
    var i, j, c = 0;
    for (i = 0; i < main.length; i++) for (j = 0; j < prevMain.length; j++) if (main[i] === prevMain[j]) { c++; break; }
    return c;
  }
  function crowdProfile(main, sub, game, prevMain) {
    var list = main.slice().sort(function (a, b) { return a - b; });
    var i, j, logSum = 0, factors = [];
    for (i = 0; i < list.length; i++) logSum += Math.log(numPopularity(list[i]));
    var rel = Math.exp(logSum / list.length - baselineLogPopularity(game.mainMax));

    var early = list.filter(function (n) { return n <= 12; }).length;
    if (early >= 3) {
      var ef = 1 + 0.11 * (early - 2);
      if (early >= 5) ef *= 1.25;
      if (early === list.length) ef *= 1.45;
      rel *= ef;
      factors.push({ dir: 'hot', text: early + ' 个号落在 1–12 这一段，生日号最挤的地方（拥挤 ×' + ef.toFixed(2) + '）' });
    } else if (early === 0) {
      factors.push({ dir: 'cold', text: '一个 1–12 的号都没有，避开了最大的拥挤段' });
    }

    var runs = 0, runMax = 1, cur = 1;
    for (i = 1; i < list.length; i++) {
      if (list[i] === list[i - 1] + 1) { cur++; } else { if (cur >= 2) runs++; runMax = Math.max(runMax, cur); cur = 1; }
    }
    if (cur >= 2) runs++;
    runMax = Math.max(runMax, cur);
    if (runs > 0) {
      var rf = 1 + 0.13 * runs + (runMax >= 3 ? 0.09 : 0);
      rel *= rf;
      factors.push({ dir: 'hot', text: runs + ' 组连号' + (runMax >= 3 ? '（其中一组三连）' : '') + '，跟买的人偏多（拥挤 ×' + rf.toFixed(2) + '）' });
    } else {
      factors.push({ dir: 'cold', text: '号码之间不连号，不在「看起来像中奖号」的那一堆里' });
    }

    var tail = {}, tailMax = 0;
    for (i = 0; i < list.length; i++) { tail[list[i] % 10] = (tail[list[i] % 10] || 0) + 1; }
    Object.keys(tail).forEach(function (k) { tailMax = Math.max(tailMax, tail[k]); });
    if (tailMax >= 3) {
      var tf = 1 + 0.06 * (tailMax - 2);
      rel *= tf;
      factors.push({ dir: 'hot', text: '有 ' + tailMax + ' 个号尾数相同，同尾号是常见选号套路（拥挤 ×' + tf.toFixed(2) + '）' });
    }

    var odd = list.filter(function (n) { return n % 2; }).length;
    if (odd === 0 || odd === list.length) {
      rel *= 0.90;
      factors.push({ dir: 'cold', text: '全' + (odd ? '奇' : '偶') + '，很多人觉得「不像开奖号」不去选，反而清静（拥挤 ×0.90）' });
    }

    var rep = tailRepeat(list, prevMain);
    if (rep >= 2) {
      var pf = 1 + 0.09 * (rep - 1);
      rel *= pf;
      factors.push({ dir: 'hot', text: '跟上期重了 ' + rep + ' 个号，照抄上期的人不少（拥挤 ×' + pf.toFixed(2) + '）' });
    }

    var big = list.filter(function (n) { return n > 31; }).length;
    if (big >= 2) {
      factors.push({ dir: 'cold', text: big + ' 个号在 31 以上，这一带没人抢' });
    }

    if (sub && sub.length) {
      var s0 = sub.filter(function (n) { return n <= 12; }).length;
      if (s0) rel *= 1 + 0.02 * s0;
    }

    rel = clamp(rel, 0.16, 3.4);
    var score = Math.round(clamp(72 - 60 * Math.log(rel) / Math.LN2 / 1.8, 5, 98));
    var level = score >= 82 ? '很冷' : (score >= 71 ? '偏冷' : (score >= 56 ? '一般' : (score >= 40 ? '偏挤' : '很挤')));
    if (!factors.length) factors.push({ dir: 'cold', text: '号码分布分散，没有明显的拥挤特征' });
    return {
      score: score, heat: rel, level: level, factors: factors.slice(0, 4),
      people: rel < 1 ? '≈ ' + rel.toFixed(2) + '× 普通一注' : '≈ ' + rel.toFixed(1) + '× 普通一注'
    };
  }


  /* ---------- 1b. 谁在买这种号 ---------- */
  // 按号码特征归类，配一段人物画像。画像依公开购彩习惯编写，是想象出来的典型，
  // 不是销量统计；它只帮人看懂「这一注站在人堆的哪一边」。
  var STORY = {
    birthday: {
      label: '一家人的生日',
      variants: [
        { who: '把一家人的生日凑成六个号',
          text: '爸爸三月，妈妈十一月，孩子六月，再加两个日子，刚好凑满。写这张票的时候心里是热的，可全国同一天生日的人太多——真中了一等奖，往往几十个人一起分。' },
        { who: '照着抽屉里那张纸填',
          text: '纸上记着四个日子：结婚、老大出生、老二出生、老人寿辰。每次买都照抄。它最大的问题不是不准，是太准了——跟你想得一模一样的人，少说也有几万个。' },
        { who: '年年买同一组生日号',
          text: '这组号他买了十几年，一期没落。不是相信它会出，是怕万一出了自己没买。可这十几年里，买同样一组号的人只多不少。' }
      ]
    },
    big: {
      label: '只从 30 往上挑的老彩民',
      variants: [
        { who: '买了二十年，早就不看小号',
          text: '他说小号是给过生日的人用的，他不凑那个热闹。三十往上的号摊在票面上，别人看着别扭，他反而踏实——越不像开奖号，越没人跟他抢。' },
        { who: '号码看着怪，他心里有数',
          text: '头一回买的时候他也写 1、2、3。后来听说有人中了头奖跟三十几个人分，从此只从 30 往上挑。丑是丑了点，可丑得清静。' },
        { who: '专挑别人嫌大的那几个号',
          text: '32、33 这种号，很多人一辈子没往票上写过——超出一个月的天数，看着就不像。他要的就是这个：没人写，才没人分。' }
      ]
    },
    oddEven: {
      label: '整张票一个调',
      variants: [
        { who: '整张票没有一个__TYPE__数',
          text: '朋友看了笑他：开奖机还能专挑__TYPE2__数？他也不争。开奖机不认识什么叫「像」，只认识球。可正因为大家觉得不像，这一把反而没人跟着买。' },
        { who: '就爱写六个__TYPE2__数',
          text: '不为别的，看着齐。彩票站老板说这种票一周能见好几张，不算稀奇，但也确实比不过生日号那一堆。' },
        { who: '号码清一色，图个整齐',
          text: '整齐是他的偏好，不是他的判断。他说反正概率一样，那就挑个自己看着舒服的——顺手还避开了一堆人不爱选的路。' }
      ]
    },
    run: {
      label: '顺着日历写下来的号',
      variants: [
        { who: '一路连下去，图省事',
          text: '1、2、3、4、5、6——好写也好记。彩票站里这种票最常见：大爷报数，店主一个一个按。跟的人多，是因为它太好写了。' },
        { who: '连着写，一眼能记住',
          text: '他不记号码，只记「从十几开始连着六个」。这种方式省脑子，也省不了钱——连号是最好写的一种票，写的人自然多。' },
        { who: '觉得连号「像开奖号」',
          text: '电视上开出来的号，常常真有连着的。于是有人专挑连号买。其实任何一注的连号机会都一样，只是连着写的人多，中了分的人也多。' }
      ]
    },
    tail: {
      label: '认尾数的那一派',
      variants: [
        { who: '尾数要整整齐齐',
          text: '3、13、23、33，尾数一个样。他说这样「有整体感」。这种票在票面上很显眼，跟着挑的人也不少。' },
        { who: '专挑同一个尾数',
          text: '尾数一样，号码看着像一串。老彩民里这么买的人不少，算是一种小小的仪式感，也算一种小小的拥挤。' },
        { who: '号码排得齐才舒服',
          text: '他不看走势，只看顺眼。尾数一致就是顺眼。顺眼的代价是：觉得顺眼的人不止他一个。' }
      ]
    },
    repeat: {
      label: '照着上期抄的',
      variants: [
        { who: '上期的号，这期接着买',
          text: '心里那句话是：它总能再出来一次吧。这话不对，但很多人这么想。所以上期开过的号，下一期总有人接着买。' },
        { who: '差一个号，舍不得换',
          text: '上期就差一个，这期觉得该轮到它了。这种心情很普遍，跟着买的人也多——开奖机没有记忆，人有。' },
        { who: '相信热号会热下去',
          text: '刚开过的号在眼里是「活的」，于是接着买。其实每个球下期被抽到的机会一样，只是很多人不愿意相信这一点。' }
      ]
    },
    noEarly: {
      label: '绕开生日段的老手',
      variants: [
        { who: '一个 1–12 的号都没放',
          text: '不是不喜欢小号，是知道那一段最挤。生日、纪念日、车牌尾号，全往 1–12 里挤。他把这一段整个让出去，号码看着散，分钱的人少。' },
        { who: '把生日段整段让掉',
          text: '他的规矩很简单：1 到 12 一个不碰。别人问那少了一半号怎么办，他说少的是最挤的一半，不亏。' },
        { who: '只在中后段慢慢挑',
          text: '13 到 33，一个号一个号地看。这一带不是没人买，是比生日段松得多——松一点，就够了。' }
      ]
    },
    'default': {
      label: '散着买的老手',
      variants: [
        { who: '不连号、不同尾、不扎堆',
          text: '看着像随手撒的一把，其实每一处都避开了一点：不写生日段，不连着写，不凑同一个尾数。没有哪一处特别聪明，合起来就是少人走的那条路。' },
        { who: '号码看着没什么规律',
          text: '正因为没什么规律，也就没什么人跟他撞。这注不好记，可他从来不用记——票存在手机里，开奖那天自然会提醒他。' },
        { who: '挑号只有一个原则：别扎堆',
          text: '问他不扎堆是什么意思，他说：别人爱写的，我就不写。听着像废话，可这就是全部方法。' }
      ]
    }
  };

  function classifyTicket(main, game, prevMain) {
    var list = main.slice().sort(function (a, b) { return a - b; });
    var early = list.filter(function (n) { return n <= 12; }).length;
    var big = list.filter(function (n) { return n > 31; }).length;
    var odd = list.filter(function (n) { return n % 2; }).length;
    var runs = 0, runMax = 1, cur = 1, i;
    for (i = 1; i < list.length; i++) {
      if (list[i] === list[i - 1] + 1) { cur++; if (cur > runMax) runMax = cur; }
      else { if (cur >= 2) runs++; cur = 1; }
    }
    if (cur >= 2) runs++;
    if (cur > runMax) runMax = cur;
    var tail = {}, tailMax = 0;
    for (i = 0; i < list.length; i++) tail[list[i] % 10] = (tail[list[i] % 10] || 0) + 1;
    Object.keys(tail).forEach(function (k) { if (tail[k] > tailMax) tailMax = tail[k]; });

    if (early >= 4) return 'birthday';
    if (big >= (game.mainPick >= 6 ? 4 : 3)) return 'big';
    if (odd === 0 || odd === list.length) return 'oddEven';
    // 尾数凑成三个比一组两连更显眼，先判同尾
    if (tailMax >= 3) return 'tail';
    if (runs > 0 || runMax >= 3) return 'run';
    if (tailRepeat(list, prevMain) >= 2) return 'repeat';
    if (early === 0) return 'noEarly';
    return 'default';
  }

  function fillType(t, allOdd) {
    // __TYPE__ 是「缺的那一类」：全奇就是没有偶数
    return String(t).replace(/__TYPE2__/g, allOdd ? '单' : '双').replace(/__TYPE__/g, allOdd ? '偶' : '奇');
  }

  // 同一批号码里尽量不重复用同一个故事：优先挑这一批还没用过的变体
  function pickStory(main, game, prevMain, used) {
    var key = classifyTicket(main, game, prevMain);
    var book = STORY[key] || STORY['default'];
    var h = 7, i;
    for (i = 0; i < main.length; i++) h = (h * 31 + main[i]) % 9973;
    var list = book.variants, n = list.length, start = h % n, pick = null, idx;
    for (i = 0; i < n; i++) {
      idx = (start + i) % n;
      if (!used[key + '#' + idx]) { used[key + '#' + idx] = 1; pick = list[idx]; break; }
    }
    if (!pick) pick = list[start];
    var allOdd = main.filter(function (n2) { return n2 % 2; }).length === main.length;
    var label = key === 'oddEven' ? '专写' + (allOdd ? '奇' : '偶') + '数的怪人' : book.label;
    return { label: label, who: fillType(pick.who, allOdd), text: fillType(pick.text, allOdd) };
  }

  function crowdCoda(score) {
    if (score >= 82) return '这一注，买的人很少。';
    if (score >= 71) return '这一注，买的人不多。';
    if (score >= 56) return '这一注，不算冷也不算挤。';
    if (score >= 40) return '这一注，跟你分钱的人会多一些。';
    return '这一注，跟你分钱的人不少。';
  }

  /* ---------- 2. 覆盖设计 ---------- */
  function enumerateMasks(v, k, cap) {
    var out = [], cur = [];
    (function rec(start) {
      if (out.length >= cap) return;
      if (cur.length === k) {
        var m = 0;
        for (var i = 0; i < k; i++) m |= (1 << cur[i]);
        out.push(m);
        return;
      }
      for (var j = start; j < v; j++) {
        cur.push(j); rec(j + 1); cur.pop();
        if (out.length >= cap) return;
      }
    })(0);
    return out;
  }
  function maskNums(mask, pool) {
    var out = [], i;
    for (i = 0; i < pool.length; i++) if (mask & (1 << i)) out.push(pool[i]);
    return out;
  }
  function wheelDesign(opts) {
    var pool = uniqueSorted(opts.pool || []), g = opts.game;
    var k = g.mainPick, t = Number(opts.t), m = Number(opts.m);
    var v = pool.length, cap = 6000;
    if (v < k) return { ok: false, error: '号池至少要 ' + k + ' 个号（现在是 ' + v + ' 个）' };
    if (t > v) return { ok: false, error: '保证等级里的「池中 ' + t + ' 个」超过了号池大小 ' + v };
    if (m > t || m > k) return { ok: false, error: '要中的个数不能超过「池中个数」和每注个数' };
    if (combination(v, t) > cap) return { ok: false, error: '号池太大了（需要覆盖 ' + combination(v, t).toLocaleString('zh-CN') + ' 种情况，上限 ' + cap + '）。把号池收到 12 个以内。' };

    var cands = enumerateMasks(v, k, cap);
    var targets = enumerateMasks(v, t, cap);
    var uncovered = targets.slice(), chosen = [], guard = 0;
    var t0 = Date.now();
    while (uncovered.length && guard++ < 400) {
      var best = -1, bestCov = -1, ci, si;
      for (ci = 0; ci < cands.length; ci++) {
        var T = cands[ci], cov = 0;
        for (si = 0; si < uncovered.length; si++) if (popcount(T & uncovered[si]) >= m) cov++;
        if (cov > bestCov) { bestCov = cov; best = ci; }
        if (bestCov === uncovered.length) break;
      }
      if (best < 0 || bestCov <= 0) break;
      chosen.push(best);
      var keep = [];
      for (si = 0; si < uncovered.length; si++) if (popcount(cands[best] & uncovered[si]) < m) keep.push(uncovered[si]);
      uncovered = keep;
    }
    // 反向删除：去掉冗余注，注数更少、覆盖不变
    for (var pass = 0; pass < 3; pass++) {
      for (var idx = chosen.length - 1; idx >= 0; idx--) {
        var T2 = cands[chosen[idx]], redundant = true;
        for (var s2 = 0; s2 < targets.length; s2++) {
          if (popcount(T2 & targets[s2]) >= m) {
            var other = false;
            for (var cj = 0; cj < chosen.length; cj++) {
              if (cj !== idx && popcount(cands[chosen[cj]] & targets[s2]) >= m) { other = true; break; }
            }
            if (!other) { redundant = false; break; }
          }
        }
        if (redundant) chosen.splice(idx, 1);
      }
    }
    if (!chosen.length) return { ok: false, error: '这组参数没能生成覆盖（号池或等级不合适）' };

    // 副区轮转：把副区小池的全部组合循环分配
    var subPool = uniqueSorted(opts.subPool || []);
    var subCombos = [];
    if (opts.noSub) { subCombos = []; }
    else if (subPool.length >= g.subPick) {
      var subMasks = enumerateMasks(subPool.length, g.subPick, 200);
      subCombos = subMasks.map(function (mk) { return maskNums(mk, subPool); });
    } else {
      subCombos = [subPool.length ? subPool.slice().sort(function (a, b) { return a - b; }) : []];
    }
    var tickets = chosen.map(function (ci2, i2) {
      return {
        main: maskNums(cands[ci2], pool),
        sub: subCombos.length ? subCombos[i2 % subCombos.length] : []
      };
    });

    var condProb = combination(v, t) * combination(g.mainMax - v, k - t) / combination(g.mainMax, k);
    return {
      ok: true,
      tickets: tickets,
      count: tickets.length,
      pool: pool,
      t: t, m: m, k: k,
      universe: targets.length,
      lowerBound: Math.ceil(targets.length / Math.max(1, (function () {
        var c = 0;
        for (var x = m; x <= Math.min(t, k); x++) c += combination(k, x) * combination(v - k, t - x);
        return c;
      })())),
      condProb: condProb,
      ms: Date.now() - t0,
      guarantee: '只要开奖号里有 ' + t + ' 个落在你选的 ' + v + ' 个号里，这 ' + tickets.length + ' 注里至少有一注中 ' + m + ' 个' + g.mainName
    };
  }

  /* ---------- 2b. 奖级 / 回放 / 固定奖期望 ---------- */
  // 只用来回答「万一中了能拿多少」。一、二等奖是浮动的，一律不估算，标「浮动」。
  // 奖级与金额来自官方规则：双色球六等奖、大乐透九等奖。
  var PRIZE_FIXED = {
    ssq: [[6,1,1,null],[6,0,2,null],[5,1,3,3000],[5,0,4,200],[4,1,4,200],
          [4,0,5,10],[3,1,5,10],[2,1,6,5],[1,1,6,5],[0,1,6,5]],
    dlt: [[5,2,1,null],[5,1,2,null],[5,0,3,10000],[4,2,4,3000],[4,1,5,300],
          [3,2,6,200],[4,0,7,100],[3,1,8,15],[2,2,8,15],
          [3,0,9,5],[1,2,9,5],[2,1,9,5],[0,2,9,5]]
  };
  var PRIZE_NAME = {
    ssq: {1:'一等奖',2:'二等奖',3:'三等奖',4:'四等奖',5:'五等奖',6:'六等奖'},
    dlt: {1:'一等奖',2:'二等奖',3:'三等奖',4:'四等奖',5:'五等奖',6:'六等奖',7:'七等奖',8:'八等奖',9:'九等奖'}
  };
  function prizeOf(gameKey, k, b) {
    var t = PRIZE_FIXED[gameKey] || [];
    for (var i = 0; i < t.length; i++) if (t[i][0] === k && t[i][1] === b) return { level: t[i][2], amount: t[i][3] };
    return null;
  }
  function ticketHit(ticket, draw, gameKey) {
    var g = GAMES[gameKey];
    return {
      k: intersectionCount(ticket.main, draw.main),
      b: intersectionCount(ticket.sub, draw.sub)
    };
  }
  // 单注固定奖期望：对任意合法组合都相同，这是摇奖机定的，不是选号能改的。
  function singleFixedEV(gameKey) {
    var g = GAMES[gameKey], ev = 0, k, b, p, pk, pb;
    for (k = 0; k <= g.mainPick; k++) {
      pk = hypergeometric(g.mainMax, g.mainPick, g.mainPick, k);
      for (b = 0; b <= g.subPick; b++) {
        pb = hypergeometric(g.subMax, g.subPick, g.subPick, b);
        p = prizeOf(gameKey, k, b);
        if (p && p.amount != null) ev += pk * pb * p.amount;
      }
    }
    return ev;
  }
  // 回放：把一组号码按历史逐期对一遍，算固定奖回收。浮动奖只记次数，不猜金额。
  function replay(tickets, draws, gameKey) {
    var spend = 0, fixedWin = 0, floatHits = 0, best = null, rows = [], i, j;
    for (i = 0; i < draws.length; i++) {
      var d = draws[i];
      spend += tickets.length * 2;
      for (j = 0; j < tickets.length; j++) {
        var h = ticketHit(tickets[j], d, gameKey);
        var p = prizeOf(gameKey, h.k, h.b);
        if (!p) continue;
        if (p.amount == null) { floatHits++; }
        else { fixedWin += p.amount; }
        var row = { issue: d.issue, date: d.date, k: h.k, b: h.b, level: p.level,
          name: PRIZE_NAME[gameKey][p.level], amount: p.amount };
        if (!best || (p.level < best.level) ||
            (p.level === best.level && h.k + h.b > best.k + best.b)) best = row;
        if (p.level <= 4) rows.push(row);
      }
    }
    return {
      spend: spend, fixedWin: fixedWin, floatHits: floatHits, best: best,
      rows: rows.slice(0, 12), periods: draws.length
    };
  }

  /* ---------- 2c. 小覆盖核：固定几个胆，其余轮转 ---------- */
  // 与 wheelDesign 同一套贪心 + 反向删除，但允许每注只从 pool 里取 k 个（k 可小于玩法主区个数）。
  function coverCore(pool, k, t, m, cap) {
    pool = uniqueSorted(pool || []);
    cap = cap || 8000;
    var v = pool.length;
    if (v < k) return { ok: false, error: '池子至少要 ' + k + ' 个号' };
    if (t > v) return { ok: false, error: '目标个数超过池子大小' };
    if (m > t || m > k) return { ok: false, error: '要中的个数不能超过目标个数' };
    if (combination(v, t) > cap) return { ok: false, error: '池子太大，算不动（上限 ' + cap + ' 种）' };
    var cands = enumerateMasks(v, k, cap);
    var targets = enumerateMasks(v, t, cap);
    var uncovered = targets.slice(), chosen = [], guard = 0, ci, si;
    while (uncovered.length && guard++ < 500) {
      var best = -1, bestCov = -1;
      for (ci = 0; ci < cands.length; ci++) {
        var T = cands[ci], cov = 0;
        for (si = 0; si < uncovered.length; si++) if (popcount(T & uncovered[si]) >= m) cov++;
        if (cov > bestCov) { bestCov = cov; best = ci; }
        if (bestCov === uncovered.length) break;
      }
      if (best < 0 || bestCov <= 0) break;
      chosen.push(best);
      var keep = [];
      for (si = 0; si < uncovered.length; si++) if (popcount(cands[best] & uncovered[si]) < m) keep.push(uncovered[si]);
      uncovered = keep;
    }
    for (var pass = 0; pass < 3; pass++) {
      for (var idx = chosen.length - 1; idx >= 0; idx--) {
        var T2 = cands[chosen[idx]], redundant = true;
        for (var s2 = 0; s2 < targets.length; s2++) {
          if (popcount(T2 & targets[s2]) >= m) {
            var other = false;
            for (var cj = 0; cj < chosen.length; cj++) {
              if (cj !== idx && popcount(cands[chosen[cj]] & targets[s2]) >= m) { other = true; break; }
            }
            if (!other) { redundant = false; break; }
          }
        }
        if (redundant) chosen.splice(idx, 1);
      }
    }
    var maxPer = 0;
    for (var x = m; x <= Math.min(t, k); x++) maxPer += combination(k, x) * combination(v - k, t - x);
    return {
      ok: chosen.length > 0,
      tickets: chosen.map(function (i2) { return maskNums(cands[i2], pool); }),
      count: chosen.length,
      universe: targets.length,
      lowerBound: Math.max(1, Math.ceil(targets.length / Math.max(1, maxPer)))
    };
  }

  /* ---------- 2d. 冷门采样器 ---------- */
  // 从指定号池里等概率采样，再按「拥挤度」排序。等概率保证了中奖概率不变；
  // 排序只决定「挑哪几注」，不改变任何一注出现的概率。
  function pickColdTickets(pool, subPool, game, count, seed, opts) {
    opts = opts || {};
    pool = uniqueSorted(pool || []);
    subPool = uniqueSorted(subPool || []);
    var k = game.mainPick, s = game.subPick;
    if (pool.length < k) return [];
    var rng = rngFrom(seed + '|cold|' + pool.length + '|' + k);
    var prevMain = opts.prevMain || null;
    var rounds = opts.rounds || 420;
    var seen = {}, scored = [], i, j;
    for (i = 0; i < rounds; i++) {
      var main = [], copy = pool.slice();
      for (j = 0; j < k; j++) {
        var idx = Math.floor(rng() * copy.length);
        main.push(copy[idx]); copy.splice(idx, 1);
      }
      main.sort(function (a, b) { return a - b; });
      var sub = [], subCopy = subPool.slice();
      for (j = 0; j < Math.min(s, subCopy.length); j++) {
        var si = Math.floor(rng() * subCopy.length);
        sub.push(subCopy[si]); subCopy.splice(si, 1);
      }
      sub.sort(function (a, b) { return a - b; });
      var key = main.join(',') + '+' + sub.join(',');
      if (seen[key]) continue;
      seen[key] = 1;
      scored.push({ main: main, sub: sub, crowd: crowdProfile(main, sub, game, prevMain) });
    }
    scored.sort(function (a, b) { return (a.crowd.heat - b.crowd.heat) || (a.main[0] - b.main[0]); });
    var out = [], maxOverlap = Math.max(1, k - 2);
    for (i = 0; i < scored.length && out.length < count; i++) {
      var c = scored[i], ok = true;
      for (j = 0; j < out.length; j++) {
        if (intersectionCount(c.main, out[j].main) > maxOverlap) { ok = false; break; }
      }
      if (ok) out.push(c);
    }
    for (i = 0; i < scored.length && out.length < count; i++) {
      if (out.indexOf(scored[i]) === -1) out.push(scored[i]);
    }
    return out.slice(0, count);
  }

  // 连号构造：先钉死一组 runLen 连号，再从剩下的号里挑最冷的补齐。
  function runTickets(game, count, runLen, seed, prevMain) {
    var max = game.mainMax, k = game.mainPick, rng = rngFrom(seed + '|run|' + runLen);
    var cands = [], s, i, j;
    for (s = 1; s + runLen - 1 <= max; s++) {
      var base = [];
      for (i = 0; i < runLen; i++) base.push(s + i);
      var rest = [];
      for (i = 1; i <= max; i++) if (base.indexOf(i) === -1) rest.push(i);
      rest.sort(function (a, b) { return (numPopularity(a) - numPopularity(b)) || (a - b); });
      var shortlist = rest.slice(0, Math.min(rest.length, Math.max(6, (k - runLen) * 3)));
      for (var attempt = 0; attempt < 26; attempt++) {
        var pick = base.slice(), copy = shortlist.slice();
        for (j = 0; j < k - runLen; j++) {
          var idx = Math.floor(rng() * copy.length);
          pick.push(copy[idx]); copy.splice(idx, 1);
        }
        pick.sort(function (a, b) { return a - b; });
        cands.push({ main: pick, sub: [], crowd: crowdProfile(pick, [], game, prevMain) });
      }
    }
    cands.sort(function (a, b) { return (a.crowd.heat - b.crowd.heat) || (a.main[0] - b.main[0]); });
    var out = [];
    for (i = 0; i < cands.length && out.length < count; i++) {
      var c = cands[i], ok = true;
      for (j = 0; j < out.length; j++) if (intersectionCount(c.main, out[j].main) > k - 2) { ok = false; break; }
      if (ok) out.push(c);
    }
    return out.slice(0, count);
  }

  // 热号 / 冷号是否延续：用「之前 30 期」的频率，看下一期命中几个。
  function hotColdPersistence(draws, game, windowSize, topN) {
    var g = game, w = windowSize || 30, top = topN || 8, rows = [], i, j;
    for (i = w; i < draws.length; i++) {
      var train = draws.slice(i, i + w), counts = {};
      for (j = 0; j < train.length; j++) for (var q = 0; q < train[j].main.length; q++) {
        counts[train[j].main[q]] = (counts[train[j].main[q]] || 0) + 1;
      }
      var nums = [];
      for (j = 1; j <= g.mainMax; j++) nums.push(j);
      nums.sort(function (a, b) { return (counts[b] || 0) - (counts[a] || 0) || a - b; });
      var hot = nums.slice(0, top), cold = nums.slice(-top), target = draws[i - 1].main;
      rows.push({ hot: intersectionCount(hot, target), cold: intersectionCount(cold, target) });
    }
    var n = rows.length || 1;
    return {
      periods: rows.length,
      hotMean: mean(rows.map(function (r) { return r.hot; })),
      coldMean: mean(rows.map(function (r) { return r.cold; })),
      expected: top * g.mainPick / g.mainMax,
      rows: rows
    };
  }
  // 遗漏越久是不是「越该出」：按遗漏分箱，看下一期实际出现率。
  function gapPersistence(draws, game) {
    var g = game, lastSeen = {}, bins = [[0, 4], [5, 9], [10, 19], [20, 999]];
    var stat = bins.map(function () { return { hit: 0, total: 0 }; });
    var i, j, n;
    for (i = draws.length - 1; i >= 0; i--) {
      var d = draws[i];
      if (i < draws.length - 1) {
        for (n = 1; n <= g.mainMax; n++) {
          var gap = lastSeen[n] == null ? 99 : (lastSeen[n] - i - 1);
          var bi = 0;
          for (j = 0; j < bins.length; j++) if (gap >= bins[j][0] && gap <= bins[j][1]) { bi = j; break; }
          stat[bi].total++;
          if (d.main.indexOf(n) > -1) stat[bi].hit++;
        }
      }
      for (j = 0; j < d.main.length; j++) lastSeen[d.main[j]] = i;
    }
    return {
      baseline: g.mainPick / g.mainMax,
      bins: bins.map(function (b, k) {
        return { label: b[1] >= 999 ? b[0] + ' 期以上' : b[0] + '–' + b[1] + ' 期',
          rate: stat[k].total ? stat[k].hit / stat[k].total : null, total: stat[k].total };
      })
    };
  }

  /* ---------- 2e. 12 种买法的计算内核 ---------- */
  // 每个函数都返回同一套结构，UI 只负责画。全部只做三件事之一：
  // 改变分钱人数、改变覆盖与成本、把真相摊开。没有任何一个动中奖概率。

  function playHide(st, opts) {
    var count = clamp(Number(opts.count) || 5, 1, 8);
    var g = st.game, tickets = pickColdTickets(st.pool, st.subPool, g, count, st.seed + '|hide', { prevMain: st.prevMain });
    if (!tickets.length) return { ok: false, error: '号池不够，换个种子重试。' };
    var scores = tickets.map(function (t) { return t.crowd.score; });
    return {
      ok: true, id: 'hide', tickets: tickets, count: tickets.length, cost: tickets.length * 2,
      headline: '挑出 ' + tickets.length + ' 注，买的人都少',
      summary: [
        { k: '平均冷门度', v: Math.round(mean(scores)), sub: '满分 100，越高越没人抢' },
        { k: '最冷的一注', v: Math.max.apply(null, scores), sub: tickets.length > 1 ? '最挤的一注 ' + Math.min.apply(null, scores) : '只看这一注' },
        { k: '中奖概率', v: '不变', sub: '每一注仍是 1/' + st.jackpot.toLocaleString('zh-CN') }
      ],
      truth: '这 ' + tickets.length + ' 注和随手买的 ' + tickets.length + ' 注，中奖概率完全一样。不一样的只有一件事：万一中了，跟你分钱的人少。'
    };
  }

  function playBig(st, opts) {
    var count = clamp(Number(opts.count) || 3, 1, 5);
    var g = st.game, from = Math.max(1, g.mainMax - 11), pool = [];
    for (var n = from; n <= g.mainMax; n++) pool.push(n);
    var tickets = pickColdTickets(pool, st.subPool, g, count, st.seed + '|big', { prevMain: st.prevMain });
    var avgPop = 0, i;
    for (i = 0; i < pool.length; i++) avgPop += numPopularity(pool[i]);
    avgPop /= pool.length;
    var allPop = 0;
    for (i = 1; i <= g.mainMax; i++) allPop += numPopularity(i);
    allPop /= g.mainMax;
    return {
      ok: true, id: 'big', tickets: tickets, count: tickets.length, cost: tickets.length * 2,
      pool: pool,
      headline: '只从 ' + pad2(from) + '–' + pad2(g.mainMax) + ' 这 ' + pool.length + ' 个号里挑',
      summary: [
        { k: '平均拥挤倍数', v: (avgPop / allPop).toFixed(2) + '×', sub: '全号段平均是 1.00×' },
        { k: '生日党覆盖', v: '0 个号', sub: '日期最大 31，这段基本没人写' },
        { k: '中奖概率', v: '不变', sub: '选号范围变窄 ≠ 概率变低' }
      ],
      truth: '很多人以为「只买大号，机会就少了」。不会。中奖概率只看你买了几注，不看这注长什么样。号段窄，组合少，可每一注仍然是一个独立的 1/' + st.jackpot.toLocaleString('zh-CN') + '。'
    };
  }

  function playRun(st, opts) {
    var count = clamp(Number(opts.count) || 3, 1, 5);
    var runLen = clamp(Number(opts.runLen) || 3, 2, 4);
    var g = st.game;
    var tickets = runTickets(g, count, runLen, st.seed + '|run' + runLen, st.prevMain);
    attachSub(tickets, g, autoSubPoolByGame(g));
    var share = shapeShare(st.analysis, g, function (main) { return maxRun(main) >= runLen; });
    var hist = st.analysis.draws.filter(function (d) { return maxRun(d.main) >= runLen; }).length;
    return {
      ok: true, id: 'run', tickets: tickets, count: tickets.length, cost: tickets.length * 2,
      headline: '故意买 ' + runLen + ' 连号，越不像中奖号越好',
      summary: [
        { k: '这类形状占全部组合', v: (share * 100).toFixed(1) + '%', sub: '理论比例，抽样估计' },
        { k: '最近 ' + st.analysis.draws.length + ' 期出现过', v: hist + ' 期', sub: (hist / st.analysis.draws.length * 100).toFixed(1) + '%，跟理论比例对得上' },
        { k: '中奖概率', v: '不变', sub: '连号不更容易中，也不更难中' }
      ],
      truth: '「连号不像开奖号」是错觉。摇奖机不看形状，' + runLen + ' 连号和任何一组号码的概率一模一样。它唯一的好处是：愿意买这种形状的人少，中了少分钱。'
    };
  }

  function playWheel(st, opts) {
    var g = st.game, size = clamp(Number(opts.size) || 12, 9, 12);
    var pair = (opts.guarantee || (g.mainPick >= 6 ? '5-4' : '4-3')).split('-');
    var t = Number(pair[0]), m = Number(pair[1]);
    var pool = st.analysis ? autoPoolBySize(st.analysis, size) : st.pool.slice(0, size);
    var subPool = autoSubPoolByGame(g);
    var r = wheelDesign({ pool: pool, game: g, t: t, m: m, subPool: subPool, subPick: g.subPick });
    if (!r.ok) return r;
    var avgHits = wheelAverageHits(pool, r.tickets, t, m, g);
    return {
      ok: true, id: 'wheel', tickets: r.tickets.map(function (x) { return { main: x.main, sub: x.sub }; }),
      count: r.count, cost: r.count * 2, pool: pool,
      headline: '用 ' + r.count + ' 注，兜住「池中 ' + t + ' 个」的下限',
      summary: [
        { k: '保的是什么', v: '池中 ' + t + ' → 中 ' + m, sub: '前提成立才保' },
        { k: '前提有多难', v: (r.condProb * 100).toFixed(2) + '%', sub: '开奖号里有 ' + t + ' 个落进这 ' + pool.length + ' 个' },
        { k: '成本', v: '¥' + r.count * 2, sub: r.count + ' 注 × 2 元' },
        { k: '真中 t 个时', v: '平均 ' + avgHits.toFixed(1) + ' 注中 ' + m + '+', sub: '不只是「至少一注」' }
      ],
      table: {
        head: ['保证等级', '需要注数', '成本', '前提概率'],
        rows: wheelLevels(pool, g, subPool).map(function (l) {
          return [l.label, l.count == null ? '—' : l.count + ' 注', l.count == null ? '—' : '¥' + l.count * 2, (l.cp * 100).toFixed(2) + '%'];
        }),
        note: '「要求更严反而更便宜」不是算错：池中个数越接近全中，凑够 m 个越宽松。但前提概率同时更低。先看前提那一列，再看价格。'
      },
      truth: '这句保证要连着前提读：只有开奖号里确实有 ' + t + ' 个在你圈的 ' + pool.length + ' 个里，这 ' + r.count + ' 注才保底中 ' + m + ' 个。而这件事只有 ' + (r.condProb * 100).toFixed(2) + '% 的概率发生。它不提高中奖率，只是把「恰好圈中」时的下限抬起来。'
    };
  }

  function playDan(st, opts) {
    var g = st.game, danN = 2, tuoN = 8;
    var ranked = [];
    for (var n = 1; n <= g.mainMax; n++) ranked.push(n);
    ranked.sort(function (a, b) { return (numPopularity(a) - numPopularity(b)) || (a - b); });
    var dan = ranked.slice(0, danN).sort(function (a, b) { return a - b; });
    var tuo = ranked.slice(danN, danN + tuoN).sort(function (a, b) { return a - b; });
    var k2 = g.mainPick - danN;
    var t = k2 - 1, m = k2 - 1;
    var core = coverCore(tuo, k2, t, m, 4000);
    if (!core.ok) return { ok: false, error: core.error || '这组胆拖没能缩出覆盖' };
    var tickets = core.tickets.map(function (x) {
      return { main: uniqueSorted(dan.concat(x)), sub: [] };
    });
    var full = combination(tuoN, k2);
    attachSub(tickets, g, autoSubPoolByGame(g));
    var pFull = danProb(g, danN, tuoN, t) ;
    return {
      ok: true, id: 'dan', tickets: tickets, count: tickets.length, cost: tickets.length * 2,
      dan: dan, tuo: tuo, mark: dan, layout: 'list', headline: '锁 ' + dan.map(pad2).join(' ') + ' 两个胆，' + tuoN + ' 个拖码轮着配',
      summary: [
        { k: '胆码（必须全中）', v: dan.map(pad2).join(' '), sub: '拖码 ' + tuo.map(pad2).join(' ') },
        { k: '缩水后', v: tickets.length + ' 注', sub: '全胆拖 ' + full + ' 注 → 省 ' + Math.round((1 - tickets.length / full) * 100) + '%' },
        { k: '保的是什么', v: '拖中 ' + t + ' → 中 ' + (t + danN), sub: '胆必须全中' },
        { k: '前提概率', v: (pFull * 100).toFixed(3) + '%', sub: '胆全中且拖中 ' + t + ' 个' }
      ],
      truth: '这是唯一一种真能省钱的玩法：同样的保底下限，' + full + ' 注缩成 ' + tickets.length + ' 注。代价是前提变窄了——' + danN + ' 个胆必须全中，少一个，整套票就废了。'
    };
  }

  function playBlue(st, opts) {
    var g = st.game, n = 0, tickets = [], i, j;
    if (st.key === 'ssq') {
      var red = coldestN(st, 6);
      for (i = 1; i <= 16; i++) tickets.push({ main: red.slice(), sub: [i] });
    } else {
      var front = coldestN(st, 5);
      for (i = 1; i <= 12; i++) for (j = i + 1; j <= 12; j++) tickets.push({ main: front.slice(), sub: [i, j] });
    }
    n = tickets.length;
    var ev = singleFixedEV(st.key) * n;
    var rate = ev / (n * 2) * 100;
    return {
      ok: true, id: 'blue', tickets: tickets, count: n, cost: n * 2,
      headline: st.key === 'ssq' ? '蓝球 16 个全包，必中 5 元' : '后区 66 种组合全包，必中 5 元',
      summary: [
        { k: '成本', v: '¥' + n * 2, sub: n + ' 注 × 2 元' },
        { k: '最差结果', v: '中 5 元', sub: '开奖号再离谱也跑不掉' },
        { k: '固定奖期望', v: '¥' + ev.toFixed(2), sub: '返还率 ' + rate.toFixed(0) + '%，一二等奖不计' }
      ],
      table: {
        head: ['项目', '金额'],
        rows: [
          ['投入', '−' + n * 2 + ' 元'],
          ['固定奖期望回收', '+' + ev.toFixed(2) + ' 元'],
          ['净期望', (ev - n * 2).toFixed(2) + ' 元'],
          ['返还率', rate.toFixed(1) + '%']
        ],
        note: '这是数学，不是运气：把中奖概率买成 100%，代价是每一元只换回约 ' + rate.toFixed(0) + ' 分。一等奖、二等奖是浮动的，没算进去，但它们出现的概率是 1/' + st.jackpot.toLocaleString('zh-CN') + '。'
      },
      truth: '它确实做到了「百分百中奖」。可「必中」和「划算」是两件事：花 ' + n * 2 + ' 元，最差回 5 元。这一格存在的意义，就是把这句话拍在桌上。'
    };
  }

  function playTwo(st) {
    var t = pickColdTickets(st.pool, st.subPool, st.game, 1, st.seed + '|two', { prevMain: st.prevMain });
    if (!t.length) return { ok: false, error: '没挑出号码，换个种子。' };
    return {
      ok: true, id: 'two', tickets: t, count: 1, cost: 2,
      headline: '就这一注，买完拉倒',
      summary: [
        { k: '花多少', v: '¥2', sub: '一注，不加倍' },
        { k: '中头奖概率', v: '1/' + st.jackpot.toLocaleString('zh-CN'), sub: '和任何一注一样' },
        { k: '冷门度', v: t[0].crowd.score, sub: t[0].crowd.level },
        { k: '长期期望', v: '约 −1 元', sub: '返奖率约 50%，买得越多越接近' }
      ],
      truth: '两块钱买的不是机会变大，是「这一期我也在场」。真想省钱，这一格就是终点：一注，不加倍，不追。'
    };
  }

  function playBudget(st, opts) {
    var budget = clamp(Number(opts.budget) || 20, 2, 100);
    var count = Math.floor(budget / 2);
    var tickets = pickColdTickets(st.pool, st.subPool, st.game, count, st.seed + '|budget' + budget, { prevMain: st.prevMain });
    var cost = tickets.length * 2;
    var avg = mean(tickets.map(function (t) { return t.crowd.score; }));
    return {
      ok: true, id: 'budget', tickets: tickets, count: tickets.length, cost: cost, budget: budget,
      headline: '预算 ¥' + budget + '，配 ' + tickets.length + ' 注',
      summary: [
        { k: '花掉', v: '¥' + cost, sub: '预算 ¥' + budget + '，剩 ¥' + (budget - cost) },
        { k: '平均冷门度', v: Math.round(avg), sub: '预算内尽量挑没人抢的' },
        { k: '中奖概率', v: '1/' + Math.round(st.jackpot / tickets.length).toLocaleString('zh-CN'), sub: '随注数线性变，不随选号变' }
      ],
      truth: '预算固定时，唯一能优化的是「这 ' + tickets.length + ' 注有多冷」，不是「有多容易中」。注数定了，中奖概率就定了。'
    };
  }

  function playCompound(st, opts) {
    var g = st.game, spec = opts.spec || (st.key === 'ssq' ? '7' : '6-2');
    var tickets = [], mainN, subN;
    if (st.key === 'ssq') {
      mainN = clamp(Number(spec) || 7, 7, 8);
      subN = 1;
      var reds = coldestN(st, mainN);
      var blue = st.subPool[0];
      kSubsets(reds, 6).forEach(function (c) { tickets.push({ main: c, sub: [blue] }); });
    } else {
      var parts = String(spec).indexOf('-') > -1 ? String(spec).split('-') : ['6', '2'];
      mainN = clamp(Number(parts[0]) || 6, 6, 7);
      subN = clamp(Number(parts[1]) || 2, 2, 3);
      var fronts = coldestN(st, mainN), backs = coldestSub(st, subN);
      kSubsets(fronts, 5).forEach(function (f) {
        kSubsets(backs, 2).forEach(function (b) { tickets.push({ main: f, sub: b }); });
      });
    }
    var cost = tickets.length * 2;
    var table = st.key === 'ssq' ? compoundTable(st, mainN) : dltCompoundTable(st, mainN, subN);
    return {
      ok: true, id: 'compound', tickets: tickets, count: tickets.length, cost: cost, layout: 'list',
      headline: '一张票，' + tickets.length + ' 注',
      summary: [
        { k: '票面号码', v: mainN + ' + ' + subN, sub: '打一张，出 ' + tickets.length + ' 注' },
        { k: '花多少', v: '¥' + cost, sub: '单注还是 2 元，一分没省' },
        { k: '中奖概率', v: '1/' + Math.round(st.jackpot / tickets.length).toLocaleString('zh-CN'), sub: '正好是单注的 ' + tickets.length + ' 倍' }
      ],
      table: table,
      truth: '复式不是「更聪明地买」，是「一次买 ' + tickets.length + ' 注」。概率随注数线性涨，钱也线性涨，每块钱的效率一点没变。它省的是手，不是钱。'
    };
  }

  function playBacktest(st, opts) {
    var lines = 3, bt = backtestAll(st.draws, st.key, { windowSize: 60, testCount: 40, lines: lines });
    if (bt.insufficient) return { ok: false, error: '数据不够做回测（至少 ' + bt.required + ' 期）。' };
    var cold = bt.cold, uni = bt.uniform;
    var diffs = bt.rows.map(function (r) { return r.cold.main - r.uniform.main; });
    var p = signFlipP(diffs, 3000, rngFrom('cold-bt-' + bt.rows.length));
    var ci = describeDiffs(diffs, '冷门—随机');
    var text;
    if (p < 0.05 && mean(diffs) > 0) text = '冷门策略在这 ' + bt.rows.length + ' 期里命中数高于随机，p=' + p.toFixed(3) + '。但样本只有 ' + bt.rows.length + ' 期，仍可能是运气。';
    else if (p < 0.05) text = '冷门策略命中数低于随机，p=' + p.toFixed(3) + '。这更正常——本来就是一样的概率，谁高谁低都是抽签。';
    else text = '冷门策略和纯随机的命中数没有可区分的差别（p=' + p.toFixed(3) + '）。这是数学上应该出现的结果：选号改变不了摇奖机。';
    return {
      ok: true, id: 'backtest', tickets: [], count: 0, cost: 0,
      headline: '过去 ' + bt.rows.length + ' 期，冷门 vs 机选',
      summary: [
        { k: '冷门策略', v: cold.main.toFixed(3), sub: '每注平均中 ' + st.game.mainName + '个数' },
        { k: '纯随机', v: uni.main.toFixed(3), sub: '同一套回测，只换选号方式' },
        { k: '差值', v: (mean(diffs) >= 0 ? '+' : '') + mean(diffs).toFixed(3), sub: '95% 区间 [' + ci.ci[0].toFixed(3) + ', ' + ci.ci[1].toFixed(3) + ']' },
        { k: '置换检验', v: 'p = ' + p.toFixed(3), sub: p < 0.05 ? '显著，但样本小' : '不显著，符合预期' }
      ],
      table: {
        head: ['指标', '冷门策略', '统计画像', '纯随机'],
        rows: [
          [st.game.mainName + '平均命中', cold.main.toFixed(3), bt.statistical.main.toFixed(3), uni.main.toFixed(3)],
          [st.game.subName + '平均命中', cold.sub.toFixed(3), bt.statistical.sub.toFixed(3), uni.sub.toFixed(3)],
          ['每注 ≥2 个' + st.game.mainName, (cold.atLeast2 * 100).toFixed(1) + '%', (bt.statistical.atLeast2 * 100).toFixed(1) + '%', (uni.atLeast2 * 100).toFixed(1) + '%'],
          ['每注 ≥3 个' + st.game.mainName, (cold.atLeast3 * 100).toFixed(1) + '%', (bt.statistical.atLeast3 * 100).toFixed(1) + '%', (uni.atLeast3 * 100).toFixed(1) + '%']
        ],
        note: '每一期都只用它之前的数据，绝不给模型看答案。'
      },
      truth: text + ' 冷门策略真正改变的不是「中不中」，是「中了跟几个人分」——而奖金数据我们手上没有，所以只能讲到这。'
    };
  }

  function playCheckup(st, opts) {
    var a = st.analysis, bias = biasAudit(a);
    var hc = hotColdPersistence(st.draws, st.game, 30, 8);
    var gp = gapPersistence(st.draws, st.game);
    var text = bias.flagged.length
      ? '有 ' + bias.flagged.length + ' 个号在校正后仍偏离，但样本只有 ' + a.draws.length + ' 期，先当噪声。'
      : '校正后没有任何号码显著偏离，摇奖机没露出偏心。';
    return {
      ok: true, id: 'checkup', tickets: [], count: 0, cost: 0,
      headline: '33 个号，历史上出得匀不匀',
      summary: [
        { k: '样本', v: a.draws.length + ' 期', sub: st.game.mainMax + ' 个号 · χ²=' + a.main.chi2.toFixed(2) },
        { k: '校正后显著', v: bias.flagged.length + ' 个', sub: bias.flagged.length ? '先当噪声' : '一个都没有' },
        { k: '热号延续', v: hc.hotMean.toFixed(2), sub: '期望 ' + hc.expected.toFixed(2) + '，差 ' + (hc.hotMean - hc.expected).toFixed(2) },
        { k: '漏久必出？', v: gp.bins[3].rate == null ? '—' : (gp.bins[3].rate * 100).toFixed(1) + '%', sub: '基线 ' + (gp.baseline * 100).toFixed(1) + '%' }
      ],
      table: {
        head: ['检验', '结果', '该是多少', '结论'],
        rows: [
          ['热号（前 8）下一期命中', hc.hotMean.toFixed(2), hc.expected.toFixed(2), Math.abs(hc.hotMean - hc.expected) < 0.35 ? '没有延续性' : '偏差在抽样波动内'],
          ['冷号（后 8）下一期命中', hc.coldMean.toFixed(2), hc.expected.toFixed(2), Math.abs(hc.coldMean - hc.expected) < 0.35 ? '没有补偿性' : '偏差在抽样波动内']
        ].concat(gp.bins.map(function (b) {
          return ['遗漏 ' + b.label, b.rate == null ? '—' : (b.rate * 100).toFixed(1) + '%', (gp.baseline * 100).toFixed(1) + '%',
            b.rate == null ? '样本不足' : (Math.abs(b.rate - gp.baseline) < 0.05 ? '跟新号没区别' : '偏差在抽样波动内')];
        })),
        note: '「漏久了该出」是错觉：每个球每一期都是独立重抽，它不记得自己多久没出来。上面的百分比越接近基线 ' + (gp.baseline * 100).toFixed(1) + '%，越说明这一点。'
      },
      truth: text + ' 体检能告诉你的只有一件事：这台机器目前没毛病。它不能告诉你下一期出什么。'
    };
  }

  function playHold(st, opts) {
    var t = pickColdTickets(st.pool, st.subPool, st.game, 1, 'hold-' + (opts.holdSeed || '001'), { prevMain: null });
    if (!t.length) return { ok: false, error: '没生成守号。' };
    var rp = replay(t, st.draws, st.key);
    var band = randomReplayBand(st.draws, st.game, 200, 'hold-band-' + st.key);
    var net = rp.fixedWin - rp.spend;
    var rank = band.wins.filter(function (w) { return w < rp.fixedWin; }).length / band.wins.length;
    var rankTxt = rank < 0.2 ? '比大多数随机结果低——这是这一注运气差，不是守号的问题。'
      : (rank > 0.8 ? '比大多数随机结果高——同样只是运气，不是守号的本事。'
      : '落在随机结果的正中间，说明守号和每期乱换没有区别。');
    return {
      ok: true, id: 'hold', tickets: t, count: 1, cost: 2,
      headline: '每期都买这一组，守 ' + st.draws.length + ' 期',
      summary: [
        { k: '总投入', v: '¥' + rp.spend, sub: st.draws.length + ' 期 × 2 元' },
        { k: '固定奖回收', v: '¥' + rp.fixedWin, sub: '浮动奖 ' + rp.floatHits + ' 次，不估金额' },
        { k: '账面', v: (net >= 0 ? '+' : '') + '¥' + net, sub: net >= 0 ? '这组运气不错' : '这才是常态' },
        { k: '最好的一次', v: rp.best ? rp.best.name : '没中过', sub: rp.best ? (rp.best.issue + ' 期 · ' + rp.best.k + '+' + rp.best.b) : '连末等奖都没有' }
      ],
      table: rp.rows.length ? {
        head: ['期号', '命中', '奖级', '金额'],
        rows: rp.rows.map(function (r) { return [r.issue, r.k + ' + ' + r.b, r.name, r.amount == null ? '浮动' : '¥' + r.amount]; }),
        note: '只列四等奖以上；五、六等奖等小奖已计入上面的回收总额。'
      } : null,
      truth: '同样 ' + st.draws.length + ' 期，如果每期都换一组随机号，200 次模拟的固定奖回收中位数是 ¥' + band.median +
        '（10%–90% 区间 ¥' + band.p10 + '–¥' + band.p90 + '）。你守的这一注回收 ¥' + rp.fixedWin +
        '，' + rankTxt + ' 守号的真正好处不是「早晚会中」，是「不用每期纠结」：这一注和任何一注一样，每期都是 1/' + st.jackpot.toLocaleString('zh-CN') + '。'
    };
  }

  function attachSub(tickets, g, subPool) {
    if (!subPool || !subPool.length) return tickets;
    tickets.forEach(function (tk, i) {
      if (g.subPick === 1) tk.sub = [subPool[i % subPool.length]];
      else {
        var a = subPool[i % subPool.length], b = subPool[(i + 1) % subPool.length];
        tk.sub = uniqueSorted([a, b]);
      }
    });
    return tickets;
  }
  function randomReplayBand(draws, game, trials, seed) {
    var rng = rngFrom(seed), wins = [], t, i, j;
    for (t = 0; t < trials; t++) {
      var win = 0;
      for (i = 0; i < draws.length; i++) {
        var pool = [], subPool = [], main = [], sub = [];
        for (j = 1; j <= game.mainMax; j++) pool.push(j);
        for (j = 0; j < game.mainPick; j++) { var idx = Math.floor(rng() * pool.length); main.push(pool[idx]); pool.splice(idx, 1); }
        for (j = 1; j <= game.subMax; j++) subPool.push(j);
        for (j = 0; j < game.subPick; j++) { var si = Math.floor(rng() * subPool.length); sub.push(subPool[si]); subPool.splice(si, 1); }
        var pz = prizeOf(game.key, intersectionCount(main, draws[i].main), intersectionCount(sub, draws[i].sub));
        if (pz && pz.amount != null) win += pz.amount;
      }
      wins.push(win);
    }
    wins.sort(function (a, b) { return a - b; });
    return { median: wins[Math.floor(wins.length / 2)], p10: wins[Math.floor(wins.length * 0.1)],
      p90: wins[Math.floor(wins.length * 0.9)], mean: mean(wins), trials: trials, wins: wins };
  }
  function coldestN(st, n) {
    var arr = [], i;
    for (i = 1; i <= st.game.mainMax; i++) arr.push(i);
    arr.sort(function (a, b) { return (numPopularity(a) - numPopularity(b)) || (a - b); });
    return uniqueSorted(arr.slice(0, n));
  }
  function coldestSub(st, n) {
    var arr = [], i;
    for (i = 1; i <= st.game.subMax; i++) arr.push(i);
    arr.sort(function (a, b) { return (numPopularity(a) - numPopularity(b)) || (a - b); });
    return uniqueSorted(arr.slice(0, n));
  }
  function kSubsets(arr, k) {
    var out = [], cur = [];
    (function rec(start) {
      if (cur.length === k) { out.push(cur.slice()); return; }
      for (var i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1); cur.pop(); }
    })(0);
    return out;
  }
  function maxRun(main) {
    var list = main.slice().sort(function (a, b) { return a - b; }), best = 1, cur = 1, i;
    for (i = 1; i < list.length; i++) {
      if (list[i] === list[i - 1] + 1) cur++; else cur = 1;
      if (cur > best) best = cur;
    }
    return best;
  }
  function shapeShare(analysis, game, pred) {
    var total = combination(game.mainMax, game.mainPick);
    if (total <= 40000) {
      var hits = 0, all = kSubsets((function () { var a = [], i; for (i = 1; i <= game.mainMax; i++) a.push(i); return a; })(), game.mainPick);
      all.forEach(function (c) { if (pred(c)) hits++; });
      return hits / all.length;
    }
    var rng = rngFrom('share-' + game.key + '-' + game.mainPick), hits2 = 0, n = 20000, i2, j;
    for (i2 = 0; i2 < n; i2++) {
      var pool = [], c2 = [];
      for (j = 1; j <= game.mainMax; j++) pool.push(j);
      for (j = 0; j < game.mainPick; j++) { var idx = Math.floor(rng() * pool.length); c2.push(pool[idx]); pool.splice(idx, 1); }
      if (pred(c2)) hits2++;
    }
    return hits2 / n;
  }
  function autoPoolBySize(analysis, size) {
    var g = analysis.game, seg = Math.ceil(g.mainMax / 3), pool = [];
    var bands = [[1, seg], [seg + 1, 2 * seg], [2 * seg + 1, g.mainMax]];
    var quota = [Math.max(1, Math.round(size * 0.08)), Math.round(size * 0.33), 0];
    quota[2] = size - quota[0] - quota[1];
    bands.forEach(function (b, bi) {
      var list = [], n;
      for (n = b[0]; n <= b[1]; n++) list.push(n);
      list.sort(function (x, y) { return (numPopularity(x) - numPopularity(y)) || (x - y); });
      pool = pool.concat(list.slice(0, quota[bi]));
    });
    return uniqueSorted(pool).slice(0, size);
  }
  function autoPool(size) {
    return autoPoolBySize({ game: GAMES[ui.game] || GAMES.ssq }, size);
  }
  function autoSubPoolByGame(g) {
    var list = [], n;
    for (n = 1; n <= g.subMax; n++) list.push(n);
    list.sort(function (x, y) { return (numPopularity(x) - numPopularity(y)) || (x - y); });
    return uniqueSorted(list.slice(0, Math.min(g.subMax, 4)));
  }
  function wheelLevels(pool, g, subPool) {
    var opts = g.mainPick >= 6 ? [[4, 3], [5, 3], [5, 4], [6, 4]] : [[3, 2], [4, 2], [4, 3], [5, 3]];
    return opts.map(function (o) {
      var rr = wheelDesign({ pool: pool.slice(), game: g, t: o[0], m: o[1], subPool: subPool, subPick: g.subPick, noSub: true });
      return {
        label: '池中 ' + o[0] + ' → 中 ' + o[1],
        count: rr.ok ? rr.count : null,
        cp: combination(pool.length, o[0]) * combination(g.mainMax - pool.length, g.mainPick - o[0]) / combination(g.mainMax, g.mainPick)
      };
    });
  }
  // 给定「池中恰好 t 个」时，平均有几注能中 m 个以上。比「至少一注」更细。
  function wheelAverageHits(pool, tickets, t, m, g) {
    var v = pool.length, k = g.mainPick, total = combination(v, t), sum = 0;
    if (total > 3000) return 0;
    var masks = enumerateMasks(v, t, 3000), ti;
    for (ti = 0; ti < masks.length; ti++) {
      var cover = 0;
      for (var j = 0; j < tickets.length; j++) {
        var tm = 0;
        for (var q = 0; q < tickets[j].main.length; q++) {
          var pos = pool.indexOf(tickets[j].main[q]);
          if (pos > -1 && (masks[ti] & (1 << pos))) tm++;
        }
        if (tm >= m) cover++;
      }
      sum += cover;
    }
    return sum / masks.length;
  }
  function compoundTable(st, redN) {
    var rows = [], k;
    for (k = 4; k <= 6; k++) {
      rows.push([
        '开奖红球有 ' + k + ' 个落在你的 ' + redN + ' 个里',
        String(combination(k, 6) * combination(redN - k, 0)),
        String(combination(k, 5) * combination(redN - k, 1))
      ]);
    }
    return {
      head: ['如果……', '中 6 红的注数', '中 5 红的注数'],
      rows: rows,
      note: '圈中 6 个红球，这张票必有一注 6+1；圈中 5 个，必有一注 5+1。这就是复式唯一的本事：把「6 选 6」变成「' + redN + ' 选 6」。'
    };
  }
  function dltCompoundTable(st, frontN, backN) {
    var hit4 = combination(4, 4) * combination(frontN - 4, 1);
    return {
      head: ['如果……', '这张票里'],
      rows: [
        ['前区 ' + frontN + ' 个里中 5 个', '1 注中 5 前区'],
        ['后区 ' + backN + ' 个里中 2 个', '1 注中 2 后区'],
        ['两件同时发生', '1 注一等奖'],
        ['前区中 4 个 + 后区中 2 个', hit4 + ' 注 4+2（四等奖）']
      ],
      note: '前区多圈一个号，等于多买 ' + (frontN - 5) + ' 注；后区选 ' + backN +
        ' 个，覆盖 C(' + backN + ',2)=' + combination(backN, 2) + ' 种后区组合。整张票 ' +
        (combination(frontN, 5) * combination(backN, 2)) + ' 注，一分没省。'
    };
  }
  function danProb(g, danN, tuoN, t) {
    var need = g.mainPick, rest = g.mainMax - danN - tuoN, sum = 0, x;
    for (x = t; x <= tuoN && (need - danN - x) >= 0 && (need - danN - x) <= rest; x++) {
      sum += combination(tuoN, x) * combination(rest, need - danN - x);
    }
    return sum / combination(g.mainMax, g.mainPick);
  }

  // 三路回测：冷门 / 统计画像 / 纯随机，同训练集、同注数。
  function backtestAll(input, gameKey, options) {
    options = options || {};
    var all = normalizeDraws(input, gameKey), trainMin = Number(options.trainMin) || 30;
    var testCount = Number(options.testCount) || 40, lines = Number(options.lines) || 3;
    if (all.length < trainMin + 5) return { insufficient: true, available: all.length, required: trainMin + 5, rows: [] };
    var start = Math.min(all.length - trainMin - 1, testCount - 1), rows = [];
    for (var i = start; i >= 0; i--) {
      var target = all[i], train = all.slice(i + 1), w = Math.min(Number(options.windowSize) || 60, train.length);
      var a = analyze(train, gameKey, w);
      var stat = generateCandidates(train, gameKey, { analysis: a, count: lines, mode: 'statistical', seed: 'bt-stat-' + target.issue });
      var random = generateCandidates(train, gameKey, { analysis: a, count: lines, mode: 'uniform', seed: 'bt-rand-' + target.issue });
      var pool = [], n;
      for (n = 1; n <= a.game.mainMax; n++) pool.push(n);
      var subPool = [];
      for (n = 1; n <= a.game.subMax; n++) subPool.push(n);
      var cold = pickColdTickets(pool, subPool, a.game, lines, 'bt-cold-' + target.issue + '-' + (a.all[0] ? a.all[0].issue : ''), { prevMain: a.all[0] ? a.all[0].main : null, rounds: 160 });
      function hits(cs) {
        var mh = 0, sh = 0, ge2 = 0, ge3 = 0;
        cs.forEach(function (c) {
          var h = intersectionCount(c.main, target.main);
          mh += h; sh += intersectionCount(c.sub, target.sub);
          if (h >= 2) ge2++;
          if (h >= 3) ge3++;
        });
        return { main: mh / cs.length, sub: sh / cs.length, atLeast2: ge2 / cs.length, atLeast3: ge3 / cs.length };
      }
      rows.push({ issue: target.issue, date: target.date, cold: hits(cold), statistical: hits(stat), uniform: hits(random) });
    }
    var result = { insufficient: false, rows: rows, trainMin: trainMin, lines: lines };
    ['cold', 'statistical', 'uniform'].forEach(function (k2) {
      result[k2] = {
        main: mean(rows.map(function (r) { return r[k2].main; })),
        sub: mean(rows.map(function (r) { return r[k2].sub; })),
        atLeast2: mean(rows.map(function (r) { return r[k2].atLeast2; })),
        atLeast3: mean(rows.map(function (r) { return r[k2].atLeast3; }))
      };
    });
    return result;
  }

  /* ---------- 3. 诚实体检 ---------- */
  // 配对置换检验：不假设正态，直接看「统计方法减随机方法」的差值是否显著偏离 0
  function signFlipP(diffs, reps, rng) {
    var n = diffs.length, i, r;
    if (!n) return 1;
    var observed = Math.abs(mean(diffs));
    if (observed < 1e-12) return 1;
    var hits = 0, R = reps || 4000, rr = rng || rngFrom('signflip');
    for (r = 0; r < R; r++) {
      var s = 0;
      for (i = 0; i < n; i++) s += rr() < 0.5 ? -diffs[i] : diffs[i];
      if (Math.abs(s / n) >= observed) hits++;
    }
    return (hits + 1) / (R + 1);
  }
  function describeDiffs(diffs, label) {
    var n = diffs.length;
    if (!n) return null;
    var mu = mean(diffs), sd = 0, i;
    for (i = 0; i < n; i++) sd += Math.pow(diffs[i] - mu, 2);
    sd = n > 1 ? Math.sqrt(sd / (n - 1)) : 0;
    var se = n > 1 ? sd / Math.sqrt(n) : 0;
    var t = se > 0 ? mu / se : 0, df = n - 1;
    var crit = tCritical(df, 0.05);
    return {
      label: label, n: n, mean: mu, sd: sd, se: se, t: t, df: df,
      ci: [mu - crit * se, mu + crit * se],
      p: se > 0 ? studentTTwoTail(t, df) : 1
    };
  }
  function backtestVerdict(bt, gameKey) {
    var g = GAMES[gameKey];
    if (!bt || bt.insufficient) return { ok: false, text: '数据不够做体检（至少要 ' + (bt ? bt.required : 35) + ' 期）。' };
    var rng = rngFrom('bt-verdict-' + bt.rows.length + '-' + bt.lines);
    var diffMap = {
      main: bt.rows.map(function (r) { return r.statistical.main - r.uniform.main; }),
      sub: bt.rows.map(function (r) { return r.statistical.sub - r.uniform.sub; }),
      a2: bt.rows.map(function (r) { return r.statistical.atLeast2 - r.uniform.atLeast2; })
    };
    var tests = [
      { key: 'main', label: g.mainName + '平均命中', d: describeDiffs(diffMap.main, g.mainName) },
      { key: 'sub', label: g.subName + '平均命中', d: describeDiffs(diffMap.sub, g.subName) },
      { key: 'a2', label: '每注 ≥2 个' + g.mainName, d: describeDiffs(diffMap.a2, '≥2 命中率') }
    ].filter(function (x) { return x.d; });
    tests.forEach(function (x) { x.p = signFlipP(diffMap[x.key], 3000, rngFrom('sf-' + x.key + '-' + bt.rows.length)); });
    // Benjamini–Hochberg 校正，避免「测三样总有一个显著」
    var order = tests.slice().sort(function (a, b) { return a.p - b.p; });
    var mTest = order.length, prevQ = 1;
    for (var i = order.length - 1; i >= 0; i--) {
      var q = Math.min(prevQ, order[i].p * mTest / (i + 1));
      order[i].q = q; prevQ = q;
    }
    var sig = tests.filter(function (x) { return x.q < 0.05 && x.d.mean > 0; });
    var anySig = tests.some(function (x) { return x.q < 0.05; });
    var text;
    if (!anySig) {
      text = '校正后没有任何指标显著。也就是说：这套统计方法在这 ' + bt.rows.length + ' 期里，表现和纯随机没有可区分的差别。这是正常的，也是诚实的结果。';
    } else if (sig.length) {
      text = '校正后仍有 ' + sig.length + ' 个指标显著高于随机。但样本只有 ' + bt.rows.length + ' 期，仍可能是运气；多看几十期再说。';
    } else {
      text = '有指标显著，但方向是低于随机。统计画像没有优势。';
    }
    return { ok: true, tests: tests, text: text, anySig: anySig };
  }
  function biasAudit(analysis) {
    var g = analysis.game, list = analysis.main.list, m = list.length, i;
    var rows = list.map(function (s) {
      return { n: s.n, count: s.count, z: s.z, p: normalTwoTail(s.z) };
    }).sort(function (a, b) { return a.p - b.p; });
    var prevQ = 1;
    for (i = rows.length - 1; i >= 0; i--) {
      var q = Math.min(prevQ, rows[i].p * m / (i + 1));
      rows[i].q = q; prevQ = q;
    }
    rows.sort(function (a, b) { return a.n - b.n; });
    var flagged = rows.filter(function (r) { return r.q < 0.05; });
    var pHit = g.mainPick / g.mainMax;
    var needFor1pct = Math.ceil((1.96 * 1.96) * (1 - pHit) / (0.01 * 0.01 * pHit));
    var needFor2pct = Math.ceil((1.96 * 1.96) * (1 - pHit) / (0.02 * 0.02 * pHit));
    return {
      rows: rows, flagged: flagged, draws: analysis.draws.length,
      needFor1pct: needFor1pct, needFor2pct: needFor2pct,
      text: flagged.length
        ? '有 ' + flagged.length + ' 个号码在多重比较校正后仍偏离期望（' + flagged.slice(0, 4).map(function (r) { return pad2(r.n); }).join('、') + '）。样本只有 ' + analysis.draws.length + ' 期，先当作噪声，别当规律。'
        : '校正后没有任何号码显著偏离。摇奖机没露出偏差，历史冷热就是噪声。'
    };
  }
  function coverageTruth(analysis, lines) {
    var g = analysis.game, N = g.mainMax, K = g.mainPick;
    var p1 = 1 / (combination(N, K) * combination(g.subMax, g.subPick));
    return {
      single: p1,
      atLeastOne: 1 - Math.pow(1 - p1, Math.max(1, lines)),
      expectedWin: 2 * p1 * lines
    };
  }

  function buildReport(analysis,candidates,bt,seed,mode) {
    var g=analysis.game,L=[];
    L.push('【竹间记 · 数彩实验室】');
    L.push('娱乐统计，不构成购彩建议；历史数据不能提高下一期中奖概率。未满18岁请勿购彩。');
    L.push('彩种：'+g.name+'｜数据：'+analysis.all.length+' 期｜分析窗：'+analysis.draws.length+' 期');
    L.push('最新：'+analysis.all[0].issue+' 期 '+(analysis.all[0].date||'日期未提供')+'｜来源：'+g.sourceName);
    L.push('模式：'+(mode==='uniform'?'纯随机对照':(mode==='cold'?'冷门优先（不提高概率，只降低同分人数）':'统计画像'))+'｜复现种子：'+seed);
    L.push('单注头奖理论概率：1 / '+analysis.jackpotCombinations.toLocaleString('zh-CN')+'（所有合法单式组合相同）');
    L.push('----------------------------------------');
    L.push('多维观察：');
    L.push('常见奇偶：'+analysis.oddMode.key+' 个奇数｜常见三区：'+analysis.zoneMode.key);
    L.push('和值中间50%：'+fmt(analysis.sumQ[0],1)+'～'+fmt(analysis.sumQ[2],1)+'｜跨度中间50%：'+fmt(analysis.spanQ[0],1)+'～'+fmt(analysis.spanQ[2],1));
    L.push('连号出现率：'+fmt(analysis.consecutiveRate*100,1)+'%｜相邻期平均重复：'+fmt(analysis.repeatMean,2)+' 个');
    L.push(g.mainName+'一致性检验：χ²='+fmt(analysis.main.chi2,2)+'，df='+analysis.main.df+'，p='+fmt(analysis.main.p,4)+'（仅描述样本，不代表可预测）');
    if(bt&&!bt.insufficient){
      L.push('----------------------------------------');
      L.push('逐期回测（'+bt.rows.length+' 期，每期 '+bt.lines+' 注，只用目标期之前数据）：');
      L.push('统计画像：平均'+g.mainName+'命中 '+fmt(bt.statistical.main,3)+'，'+g.subName+' '+fmt(bt.statistical.sub,3));
      L.push('随机对照：平均'+g.mainName+'命中 '+fmt(bt.uniform.main,3)+'，'+g.subName+' '+fmt(bt.uniform.sub,3));
      L.push('理论随机期望：'+g.mainName+' '+fmt(analysis.expectedMainHits,3)+'，'+g.subName+' '+fmt(analysis.expectedSubHits,3));
      L.push('样本有限，回测差异不能外推为未来优势。');
    }
    L.push('----------------------------------------');
    L.push('娱乐候选（评分不是中奖概率）：');
    candidates.forEach(function(c,i){
      L.push((i+1)+'. '+c.main.map(pad2).join(' ')+' + '+c.sub.map(pad2).join(' '));
      if(c.crowd) L.push('   冷门度 '+c.crowd.score+' / 100（'+c.crowd.level+'）· 预计同号人数 '+c.crowd.people+'（经验模型，非实测销量）');
      L.push('   '+c.reasons.join('；'));
    });
    L.push('----------------------------------------');
    L.push('方法：近期/长期频率、Beta 先验收缩、当前遗漏、和值/跨度/奇偶/三区/连号/重复、号码对共现、组合多样性与滚动回测。');
    L.push('冷门度：按生日号(1–12 最挤)、吉利号、避讳号、连号、同尾、与上期重号的公开购彩习惯建的经验模型，用来估算「同号人数」，不是销量实测。');
    L.push('理性娱乐，不借贷、不追损、不把候选当作投注建议。');
    return L.join('\n');
  }

  function buildAiPrompt(analysis,candidates,bt) {
    var g=analysis.game;
    var brief={
      game:g.name,drawCount:analysis.all.length,window:analysis.draws.length,latest:analysis.all[0],
      hot:analysis.hot.map(function(s){return {n:s.n,count:s.count,z:Number(s.z.toFixed(2))};}),
      cold:analysis.cold.map(function(s){return {n:s.n,count:s.count,z:Number(s.z.toFixed(2))};}),
      gaps:analysis.gaps.map(function(s){return {n:s.n,gap:s.gap};}),
      chiSquare:{chi2:Number(analysis.main.chi2.toFixed(2)),df:analysis.main.df,p:Number(analysis.main.p.toFixed(4))},
      structure:{odd:analysis.oddMode,zones:analysis.zoneMode,sumQ:analysis.sumQ,spanQ:analysis.spanQ,
        consecutiveRate:analysis.consecutiveRate,repeatMean:analysis.repeatMean},
      backtest:bt&&!bt.insufficient?{periods:bt.rows.length,statistical:bt.statistical,uniform:bt.uniform,
        theoretical:{main:analysis.expectedMainHits,sub:analysis.expectedSubHits}}:null,
      candidates:candidates.map(function(c){return {main:c.main,sub:c.sub,reasons:c.reasons,
        crowd:c.crowd?{score:c.crowd.score,level:c.crowd.level,people:c.crowd.people,factors:c.crowd.factors.map(function(f){return f.text;})}:null};})
    };
    return '你是严谨的彩票统计解读助手。下面是本地程序基于真实历史开奖计算出的 JSON 结果。只允许解释这些数字，不得补充、猜测或改写历史数据，不得修改候选号码。请用中文输出不超过 500 字，分「数据观察」「交叉解读」「回测结论」「边界提醒」四段。必须明确：遗漏不代表该出，冷热不代表下一期倾向；统计画像不是中奖率；公平开奖各期独立；回测样本不能证明未来优势；冷门度只影响中奖后同分人数、不影响中奖概率，且是经验模型不是实测销量；不得使用稳中、包中、精准预测、提高中奖率等措辞。语气清楚克制，不鼓励购彩。\n'+JSON.stringify(brief);
  }

  // ------------------------------ UI ------------------------------
  var ui={inited:false,openFlag:false,game:'ssq',data:{ssq:[],dlt:[]},analysis:null,candidates:[],bt:null,lastFocus:null,opts:{},tab:'pick',
    cover:{size:12,pool:[],subPool:[],t:5,m:3,result:null},
    simple:{count:5,seed:'竹间-001',analysis:null,candidates:[],bt:null,runId:0},
    play:{id:null,seed:'',params:{},result:null,tickets:[],prevMain:null}};
  function $(id){return root&&root.document?root.document.getElementById(id):null;}
  function setText(id,text){var e=$(id);if(e)e.textContent=text;}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function rowsOf(draws){return draws.map(function(d){return [d.issue,d.date,d.main.map(pad2).join(','),d.sub.map(pad2).join(',')];});}
  function notify(msg){if(ui.opts.toast)ui.opts.toast(msg);setText('ltStatus',msg);setText('ltAdvanceStatus',msg);}
  function currentGame(){return GAMES[ui.game];}
  function currentDraws(){return ui.data[ui.game];}
  function selectedWindow(){return Number($('ltWindow').value)||0;}

  function persist() {
    try {
      var payload={version:1,ssq:rowsOf(ui.data.ssq).slice(0,MAX_STORED_DRAWS),dlt:rowsOf(ui.data.dlt).slice(0,MAX_STORED_DRAWS)};
      root.localStorage.setItem(STORAGE_KEY,JSON.stringify(payload));
      return true;
    } catch(e) { notify('彩票数据未能保存到本机（' + e.message + '）；不影响笔记数据');return false; }
  }
  function loadData() {
    var seed=root.BAMBOO_LOTTERY_DATA||{};
    ui.data.ssq=normalizeDraws(seed.ssq||[],'ssq');
    ui.data.dlt=normalizeDraws(seed.dlt||[],'dlt');
    try {
      var raw=root.localStorage.getItem(STORAGE_KEY);if(!raw)return;
      var saved=JSON.parse(raw);
      if(saved&&saved.ssq)ui.data.ssq=normalizeDraws(saved.ssq,'ssq');
      if(saved&&saved.dlt)ui.data.dlt=normalizeDraws(saved.dlt,'dlt');
    } catch(e) { notify('本机彩票数据读取失败，已使用内置数据；原始彩票数据未被清除：'+e.message); }
  }

  // ===== 开奖日历：双色球 周二/四/日，大乐透 周一/三/六 =====
  // 提醒固定设在「开奖前一天 20:00」；若该时刻已过，则顺延到下一期，绝不写过去的时间。
  var DRAW_WEEKDAYS={ssq:[0,2,4],dlt:[1,3,6]};
  var REMIND_HOUR=20;
  function p2(n){return n<10?'0'+n:''+n;}
  function mdLabel(d,thisYear){
    var s=(d.getMonth()+1)+'-'+p2(d.getDate());
    return d.getFullYear()===thisYear?s:(d.getFullYear()+'-'+s);
  }
  function nextDrawSlot(game){
    var now=new Date();
    var wds=DRAW_WEEKDAYS[game]||DRAW_WEEKDAYS.ssq;
    var y=now.getFullYear();
    var base=new Date(y,now.getMonth(),now.getDate());
    var draw=null,remind=null;
    for(var i=0;i<15;i++){
      var d=new Date(base.getFullYear(),base.getMonth(),base.getDate()+i);
      if(wds.indexOf(d.getDay())===-1)continue;
      var r=new Date(d.getFullYear(),d.getMonth(),d.getDate()-1,REMIND_HOUR,0,0,0);
      if(r.getTime()>now.getTime()){draw=d;remind=r;break;}
    }
    if(!draw){
      remind=new Date(base.getFullYear(),base.getMonth(),base.getDate()+1,REMIND_HOUR,0,0,0);
      draw=new Date(remind.getFullYear(),remind.getMonth(),remind.getDate()+1);
    }
    return {
      draw:draw,remind:remind,
      slot:p2(remind.getMonth()+1)+'-'+p2(remind.getDate()),
      remindAt:remind.getFullYear()+'-'+p2(remind.getMonth()+1)+'-'+p2(remind.getDate())+'T'+p2(REMIND_HOUR)+':00',
      label:'提醒 '+mdLabel(remind,y)+' '+p2(REMIND_HOUR)+':00 · '+mdLabel(draw,y)+' 开奖'
    };
  }

  // ===== 加入待办：把号码写入主应用「待办」分类（彩种 + 号码 + 开奖前一天提醒） =====
  function pendingItem(c){
    var g=GAMES[ui.game]||GAMES.ssq;
    var slot=nextDrawSlot(ui.game);
    return {game:ui.game,name:g.name,main:c.main.slice(),sub:c.sub.slice(),
      slot:slot.slot,remindAt:slot.remindAt,remindLabel:slot.label};
  }
  function isPending(c){
    if(!ui.opts.hasPending)return false;
    try{return !!ui.opts.hasPending(pendingItem(c));}catch(e){return false;}
  }
  function addPending(c){
    if(!ui.opts.addPending){notify('加入待办暂不可用，请刷新页面后重试。');return 'error';}
    if(isPending(c))return 'duplicate';
    try{return ui.opts.addPending(pendingItem(c));}catch(e){notify('加入待办失败：'+e.message);return 'error';}
  }
  function markup() {
    return ''+
    '<div class="lt-shell">'+
      '<header class="lt-header"><div class="lt-brand"><span class="lt-logo"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="9.6" cy="12" r="5.7" fill="#ff5f6d"/><circle cx="14.6" cy="12" r="5.7" fill="#4f86ff"/><circle cx="7.6" cy="9.7" r="1.9" fill="#ffffff" opacity=".55"/><circle cx="12.6" cy="9.7" r="1.9" fill="#ffffff" opacity=".55"/></svg></span><div><h2 id="lotteryTitle">数彩助手</h2><p>十二种买法，一种真相</p></div></div>'+
      '<div class="lt-header-actions"><button class="lt-icon" id="ltHelp" type="button" aria-label="使用指南" title="使用指南"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></svg></button><button class="lt-icon" id="ltClose" type="button" aria-label="关闭数彩助手"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div></header>'+
      '<div class="lt-body">'+
      '<div class="lt-responsible lt-tiny" id="ltResponsible">娱乐统计，不是中奖承诺：每注中奖概率相同，历史数据不能提高概率。十二种买法只做三件事——中了少分钱、同样的钱覆盖更多、把真相摊开。理性娱乐、量力而行。</div>'+
      '<section id="ltHelpPanel" class="lt-help" hidden><div class="lt-help-head"><h3>十二宫格怎么用</h3><button id="ltHelpClose" type="button" aria-label="收起使用指南">收起</button></div>'+
      '<ol class="lt-steps">'+
      '<li><b>先选一个格子</b>：十二格按「你最在乎什么」分四组——中了多拿、不漏空、省着买、别被骗。点进去就是那一种买法。</li>'+
      '<li><b>每格都写清两件事</b>：换到了什么（比如「分钱人少」），换不到什么（永远是「中奖概率」）。没有一格敢写「更容易中」。</li>'+
      '<li><b>参数很少</b>：多数格子只有「买几注」一个选择，改完点「开始算」。</li>'+
      '<li><b>每注都有故事</b>：「谁在买这种号」是按常见选号习惯编的画像，不是销量统计，但它能帮你看懂自己站在人堆哪一边。</li>'+
      '<li><b>选彩种</b>：顶部切换「双色球」或「超级大乐透」，两个彩种互不影响；有些玩法只在某个彩种下成立。</li>'+
      '<li><b>存起来</b>：点「＋ 全部加入待办」，号码连彩种、开奖日一起进首页「待办」，提醒设在<b>开奖前一天 20:00</b>；只想拿号码就点「复制全部」。</li>'+
      '<li><b>想看门道</b>：右上角「专业数据」，频率、结构、逐期回测和完整报告都在那里。</li>'+
      '<li><b>更新开奖</b>：专业数据页点「更新数据」，从官网复制最新记录粘贴导入。</li>'+
      '</ol>'+
      '<p class="lt-note">重要：这是<b>娱乐数据研究</b>。公平开奖各期独立，历史冷热、遗漏都不能改变中奖概率；任何合法单式组合的中奖概率完全相同。未满 18 岁请勿购彩，不借贷、不追损。</p></section>'+
      '<div class="lt-topline"><div class="lt-games" role="tablist" aria-label="彩种"><button id="ltGameSsq" data-game="ssq" role="tab" type="button">双色球</button><button id="ltGameDlt" data-game="dlt" role="tab" type="button">超级大乐透</button></div>'+
      '<div class="lt-top-actions"><a id="ltSourceLink" class="lt-source" target="_blank" rel="noopener noreferrer">官方数据源 ↗</a><button class="lt-mini" id="ltAdvanceToggle" type="button" aria-expanded="false">专业数据 ↗</button></div></div>'+
      '<div id="ltSimpleView">'+simpleMarkup()+'</div>'+
      '<div id="ltAdvanceView" hidden>'+
      '<section class="lt-data-card"><div><span class="lt-eyebrow">DATA HEALTH</span><h3 id="ltDataTitle"></h3><p id="ltDataMeta"></p></div><div class="lt-data-actions"><button id="ltSync" type="button">更新数据</button><button id="ltImportToggle" type="button">导入 / 粘贴</button></div></section>'+
      '<section id="ltImportPanel" class="lt-import" hidden><h3>导入真实开奖记录</h3><p>支持 JSON 或逐行文本。所有记录会校验期号、日期、号码数量、范围与重复；任何一行不合格都不会写入。</p>'+
      '<textarea id="ltImportText" rows="5" spellcheck="false" placeholder="2026127 2026-11-05 13 14 19 25 29 32 + 12"></textarea>'+
      '<div class="lt-import-actions"><input id="ltImportFile" type="file" accept=".json,.txt,text/plain,application/json"><button id="ltImportApply" type="button">校验并合并</button><button id="ltImportReset" type="button">恢复内置数据</button></div>'+
      '<p class="lt-small">数据只保存在本浏览器独立键 bamboo.v13.lottery.data，不进入笔记、备份或 GitHub 同步。两家官网均不允许浏览器跨域读取（体彩网关实测会拦截），请从官方页面复制最新记录后粘贴；本模块不使用第三方代理。</p></section>'+
      '<section class="lt-controls"><label>分析窗口<select id="ltWindow"><option value="30">近 30 期</option><option value="60" selected>近 60 期</option><option value="100">近 100 期</option><option value="0">全部数据</option></select></label>'+
      '<label>候选注数<select id="ltCount"><option value="3">3 注</option><option value="5" selected>5 注</option><option value="8">8 注</option></select></label>'+
      '<label>生成模式<select id="ltMode"><option value="statistical">统计画像</option><option value="cold">冷门优先</option><option value="uniform">纯随机对照</option></select></label>'+
      '<label>复现种子<input id="ltSeed" value="竹间-001" maxlength="32" autocomplete="off"></label>'+
      '<button class="lt-primary" id="ltGenerate" type="button">生成交叉分析</button></section>'+
      '<div id="ltAdvanceStatus" class="lt-status" role="status" aria-live="polite"></div>'+
      '<section class="lt-metrics" id="ltMetrics"></section>'+
      '<div class="lt-two-col"><section class="lt-panel"><div class="lt-panel-head"><div><span class="lt-eyebrow">DISTRIBUTION</span><h3 id="ltMainFreqTitle">号码频率与遗漏</h3></div><span class="lt-tag">点击号码看细节</span></div><div id="ltMainFreq" class="lt-ball-grid"></div><h4 id="ltSubFreqTitle" class="lt-subhead"></h4><div id="ltSubFreq" class="lt-ball-grid lt-sub-grid"></div><p class="lt-note">颜色表示近期标准化频率，数字下方为当前遗漏期数。遗漏只是距上次出现的距离，不代表“该出了”。</p></section>'+
      '<section class="lt-panel"><span class="lt-eyebrow">STRUCTURE</span><h3>组合结构画像</h3><div id="ltStructure" class="lt-structure"></div><h4 class="lt-subhead">高频共现号码对</h4><div id="ltPairs" class="lt-pairs"></div><p class="lt-note">共现经过支持度与期望频次对照；小样本的高提升度不等于稳定规律。</p></section></div>'+
      '<section class="lt-panel lt-candidate-panel"><div class="lt-panel-head"><div><span class="lt-eyebrow">CANDIDATES</span><h3>娱乐候选组合</h3></div><div><button id="ltCopy" type="button">复制完整报告</button><button id="ltAi" class="lt-ai" type="button">✨ DeepSeek 交叉解读</button></div></div>'+
      '<div class="lt-responsible lt-compact">候选由所选模式与复现种子确定：冷门优先按「中了跟多少人分」挑号，统计画像按与历史样本的相似度打分。<b>两条路都不改变中奖概率，也都不是购买建议</b>。</div><div id="ltCandidates" class="lt-candidates"></div><div id="ltAiPanel" class="lt-ai-panel" hidden><h4>AI 解读（仅基于上方计算结果）</h4><div id="ltAiText"></div></div></section>'+
      '<section class="lt-panel"><div class="lt-panel-head"><div><span class="lt-eyebrow">WALK-FORWARD TEST</span><h3>逐期回测 vs 纯随机</h3></div><span class="lt-tag">无前视偏差</span></div><p class="lt-note">每一个目标期只使用该期之前的数据训练，并与同数量随机组合、理论随机期望对照。回测用于检验方法，不用于挑选“最好使”的号码。</p><div id="ltBacktest"></div></section>'+
      '<section class="lt-panel"><div class="lt-panel-head"><div><span class="lt-eyebrow">SOURCE RECORDS</span><h3>最近开奖记录</h3></div><span id="ltHistoryCount" class="lt-tag"></span></div><div class="lt-table-wrap"><table><thead><tr><th>期号</th><th>日期</th><th id="ltHistoryMainHead">主区</th><th id="ltHistorySubHead">副区</th></tr></thead><tbody id="ltHistory"></tbody></table></div></section>'+
      '<details class="lt-method"><summary>方法、公式与科学性边界</summary><div><p><b>频率：</b>同时观察近期与长期频次，并用 Beta 先验收缩，降低小样本极端值；卡方 p 值只用于描述样本与均匀分布的一致程度，不能推出下一期倾向。</p><p><b>结构：</b>统计和值、跨度、奇偶、三区分区、连号和相邻期重复；候选的结构得分是与历史画像的相似度，不是概率。</p><p><b>共现：</b>号码对同时出现次数与支持度、独立期望并列展示，并使用平滑后的比值参与组合多样性计算。</p><p><b>回测：</b>滚动训练，绝不把目标期或未来数据喂给模型；同时展示纯随机模拟和超几何分布理论期望。若统计画像偶尔领先，也可能只是抽样波动。</p><p><b>AI：</b>点击后才把统计摘要和候选发给你配置的 DeepSeek；不发送笔记、凭据或完整历史数据。AI 只生成文字解读，核心结果不依赖 AI 也能完整使用。</p><p><b>规则来源：</b><a href="https://www.cwl.gov.cn/fcpz/yxjs/ssq" target="_blank" rel="noopener noreferrer">双色球官方规则</a> · <a href="https://www.lottery.gov.cn/tzgg/20190202/72410.html" target="_blank" rel="noopener noreferrer">大乐透官方规则</a>。历史接口属于官网内部接口，并非有 SLA 的开放 API。</p></div></details>'+
      '</div>'+
      '<footer class="lt-footer">理性娱乐 · 量力而行 · 结果用于数据研究，不构成任何投注建议</footer>'+
      '</div></div>';
  }

  function renderMetrics() {
    var a=ui.analysis,g=a.game,latest=a.all[0],missing=a.all.filter(function(d){return !d.date;}).length;
    $('ltDataTitle').textContent=g.name+' · 最新 '+latest.issue+' 期';
    $('ltDataMeta').textContent='内置/本机共 '+a.all.length+' 期，最近开奖 '+(latest.date||'日期未提供')+'；范围 '+a.all[a.all.length-1].issue+'～'+latest.issue+(missing?'；'+missing+' 期缺日期':'；字段校验通过');
    var link=$('ltSourceLink');link.href=g.sourceUrl;link.textContent='查看'+g.sourceName+'数据源 ↗';
    $('ltSync').textContent=g.directSync?'同步官方数据':'导入官方更新';
    var items=[
      ['数据样本',a.draws.length+' 期','当前分析窗 / 全部 '+a.all.length+' 期'],
      ['单注头奖概率','1 / '+a.jackpotCombinations.toLocaleString('zh-CN'),'所有合法组合完全相同'],
      [g.mainName+'一致性','p = '+fmt(a.main.p,4),'χ²='+fmt(a.main.chi2,2)+'，df='+a.main.df],
      ['相邻期重复',fmt(a.repeatMean,2)+' 个','理论随机命中期望 '+fmt(a.expectedMainHits,2)]
    ];
    $('ltMetrics').innerHTML=items.map(function(x){return '<div class="lt-metric"><span>'+esc(x[0])+'</span><b>'+esc(x[1])+'</b><small>'+esc(x[2])+'</small></div>';}).join('');
  }
  function renderFrequency(stats,container,label) {
    var maxAbs=Math.max(1,Math.max.apply(null,stats.list.map(function(s){return Math.abs(s.z);})));
    $(container).innerHTML=stats.list.map(function(s){
      var intensity=clamp(Math.abs(s.z)/maxAbs,0.06,1),cls=s.z>=0?'hot':'cold';
      return '<button type="button" class="lt-num '+cls+'" style="--heat:'+intensity.toFixed(2)+'" data-n="'+s.n+'" data-count="'+s.count+'" data-z="'+s.z.toFixed(2)+'" data-gap="'+s.gap+'" aria-label="'+label+' '+pad2(s.n)+'，出现 '+s.count+' 次，遗漏 '+s.gap+' 期"><b>'+pad2(s.n)+'</b><small>'+s.gap+'</small></button>';
    }).join('');
  }
  function renderStructure() {
    var a=ui.analysis;
    var items=[
      ['常见奇偶',a.oddMode.key+' 个奇数',fmt(a.oddMode.count/a.draws.length*100,1)+'% 样本'],
      ['常见三区',a.zoneMode.key,fmt(a.zoneMode.count/a.draws.length*100,1)+'% 样本'],
      ['和值中间 50%',fmt(a.sumQ[0],1)+'～'+fmt(a.sumQ[2],1),'中位数 '+fmt(a.sumQ[1],1)],
      ['跨度中间 50%',fmt(a.spanQ[0],1)+'～'+fmt(a.spanQ[2],1),'中位数 '+fmt(a.spanQ[1],1)],
      ['含连号',fmt(a.consecutiveRate*100,1)+'%','只描述历史占比'],
      ['随机期望',fmt(a.expectedMainHits,2)+' + '+fmt(a.expectedSubHits,2),'单注主区 + 副区命中']
    ];
    $('ltStructure').innerHTML=items.map(function(x){return '<div><span>'+esc(x[0])+'</span><b>'+esc(x[1])+'</b><small>'+esc(x[2])+'</small></div>';}).join('');
    var pairs=a.pairs.filter(function(p){return p.count>=2;}).slice(0,8);
    $('ltPairs').innerHTML=pairs.length?pairs.map(function(p){return '<span><b>'+pad2(p.a)+' + '+pad2(p.b)+'</b><small>'+p.count+' 次 · 提升 '+fmt(p.lift,2)+'×</small></span>';}).join(''):'<p class="lt-note">当前窗口没有至少共现 2 次的号码对。</p>';
  }
  function renderCandidates() {
    var a=ui.analysis;
    $('ltCandidates').innerHTML=ui.candidates.map(function(c,i){
      return '<article class="lt-ticket"><div class="lt-ticket-top"><span>方案 '+pad2(i+1)+'</span><span>画像组合 · 非概率</span></div><div class="lt-ticket-balls">'+c.main.map(function(n){return '<b class="red">'+pad2(n)+'</b>';}).join('')+'<i>+</i>'+c.sub.map(function(n){return '<b class="blue">'+pad2(n)+'</b>';}).join('')+'</div><ul>'+c.reasons.map(function(r){return '<li>'+esc(r)+'</li>';}).join('')+'</ul></article>';
    }).join('');
  }
  function renderBacktest() {
    var bt=ui.bt,a=ui.analysis,g=a.game;
    if(bt.insufficient){$('ltBacktest').innerHTML='<p class="lt-note">数据不足：至少需要 '+bt.required+' 期，当前 '+bt.available+' 期。</p>';return;}
    var rows=[
      ['统计画像',bt.statistical.main,bt.statistical.sub,bt.statistical.atLeast2],
      ['纯随机对照',bt.uniform.main,bt.uniform.sub,bt.uniform.atLeast2],
      ['理论随机期望',a.expectedMainHits,a.expectedSubHits,bt.randomAtLeast2]
    ];
    var html='<div class="lt-table-wrap"><table class="lt-bt-table"><thead><tr><th>方法</th><th>平均'+g.mainName+'命中</th><th>平均'+g.subName+'命中</th><th>每注 ≥2 主区</th></tr></thead><tbody>'+rows.map(function(r){return '<tr><td>'+r[0]+'</td><td>'+fmt(r[1],3)+'</td><td>'+fmt(r[2],3)+'</td><td>'+fmt(r[3]*100,1)+'%</td></tr>';}).join('')+'</tbody></table></div>';
    html+='<p class="lt-note">回测 '+bt.rows.length+' 期 × 每期 '+bt.lines+' 注。统计与随机结果的差异没有显著性结论，不能外推为未来收益或中奖优势。</p>';
    html+='<details class="lt-bt-detail"><summary>查看逐期明细</summary><div class="lt-table-wrap"><table><thead><tr><th>目标期</th><th>训练样本</th><th>统计主/副</th><th>随机主/副</th></tr></thead><tbody>'+bt.rows.slice().reverse().map(function(r){return '<tr><td>'+r.issue+'</td><td>'+r.trainCount+' 期（至 '+r.trainLatest+'）</td><td>'+fmt(r.statistical.main,2)+' / '+fmt(r.statistical.sub,2)+'</td><td>'+fmt(r.uniform.main,2)+' / '+fmt(r.uniform.sub,2)+'</td></tr>';}).join('')+'</tbody></table></div></details>';
    $('ltBacktest').innerHTML=html;
  }
  function renderHistory() {
    var a=ui.analysis,g=a.game;
    setText('ltHistoryMainHead',g.mainName);setText('ltHistorySubHead',g.subName);
    setText('ltHistoryCount','显示最近 '+Math.min(12,a.all.length)+' / '+a.all.length+' 期');
    $('ltHistory').innerHTML=a.all.slice(0,12).map(function(d){return '<tr><td>'+d.issue+'</td><td>'+(d.date||'未提供')+'</td><td><span class="lt-table-balls red">'+d.main.map(pad2).join(' ')+'</span></td><td><span class="lt-table-balls blue">'+d.sub.map(pad2).join(' ')+'</span></td></tr>';}).join('');
  }
  function renderAll() {
    var draws=currentDraws(),w=selectedWindow(),mode=$('ltMode').value,count=Number($('ltCount').value),seed=$('ltSeed').value.trim()||'竹间-001';
    ui.analysis=analyze(draws,ui.game,w);
    ui.candidates=generateCandidates(draws,ui.game,{analysis:ui.analysis,count:count,mode:mode,seed:seed});
    ui.bt=backtest(draws,ui.game,{windowSize:w||60,testCount:30,lines:3});
    renderMetrics();
    setText('ltMainFreqTitle',ui.analysis.game.mainName+'频率与遗漏');
    setText('ltSubFreqTitle',ui.analysis.game.subName+'频率与遗漏');
    renderFrequency(ui.analysis.main,'ltMainFreq',ui.analysis.game.mainName);
    renderFrequency(ui.analysis.sub,'ltSubFreq',ui.analysis.game.subName);
    renderStructure();renderCandidates();renderBacktest();renderHistory();
    $('ltAiPanel').hidden=true;setText('ltAiText','');
    setText('ltAdvanceStatus','分析完成：'+ui.analysis.draws.length+' 期样本，'+ui.candidates.length+' 注'+(mode==='uniform'?'纯随机对照':'统计画像')+'候选；结果可用种子“'+seed+'”复现。');
  }

  // ===== 傻瓜模式 =====
  // 娱乐个性化：五行 / 星座 / 生肖映射（只影响展示与「你的标签」标记，不改号码生成、不改概率）
  /* ==================== 傻瓜模式 · 12 种买法 ==================== */
  // 只放「怎么说人话」和「怎么画」，算号全在 2e 的内核里。
  // 每一格都必须老实交代：换到了什么、换不到什么。
  var GROUPS = [
    { key: 'A', color: '#e2566a', name: '中了多拿', line: '奖金池是固定的，分的人越少，每注拿得越多。' },
    { key: 'B', color: '#3f7af0', name: '不漏空', line: '先圈一个范围，再用最少的注数兜住下限。' },
    { key: 'C', color: '#15936e', name: '省着买', line: '先定花多少，再决定买几注——顺序反过来就容易超支。' },
    { key: 'D', color: '#7c5cd6', name: '别被骗', line: '三个能把话说死的检验。结论允许是「没用」。' }
  ];
  var PLAYS = [
    { id: 'hide', no: '01', g: 'A', name: '躲人堆', cost: '¥2 起',
      line: '全号段挑最没人买的那几注',
      changed: '分钱人少', not: '概率不变',
      kicker: '最省事的一种挑法',
      title: '同样是一等奖，挑一注没人抢的',
      why: ['每注中奖概率完全一样，这是摇奖机定的，谁也改不了。',
            '能改的只有一件事：万一中了，跟你分钱的人有多少。',
            '所以这里不猜号码，只按「有多挤」从 420 组里挑最不挤的几注。'],
      params: [{ key: 'count', type: 'seg', label: '买几注', values: [1, 3, 5, 8], def: 5, suffix: ' 注' }] },

    { id: 'big', no: '02', g: 'A', name: '只挑大号', cost: '¥4 起',
      line: '只买最大的 12 个号，生日党一个都不碰',
      changed: '独中率高', not: '机会变少',
      kicker: '把生日党整段让出去',
      title: '31 以上，是整张票上最空的地方',
      why: ['日期最大只到 31，32、33 这两个号，很多人一辈子没往票上写过。',
            '只从最大的 12 个号里挑，等于主动绕开「一家人生日凑六个」的那群人。',
            '有人担心「范围窄了机会少」——不会。概率只看你买了几注，不看号码长什么样。'],
      params: [{ key: 'count', type: 'seg', label: '买几注', values: [1, 3, 5], def: 3, suffix: ' 注' }] },

    { id: 'run', no: '03', g: 'A', name: '连号怪', cost: '¥2 起',
      line: '故意买三连、四连，越不像中奖号越好',
      changed: '没人抢', not: '概率不变',
      kicker: '专挑「看着不像」的形状',
      title: '越像假号，越没人买',
      why: ['很多人觉得 05 06 07 连在一起「不可能是开奖号」，所以从来不写。',
            '可摇奖机不认形状：三连号和任何一组号码，概率一模一样。',
            '这一格专门挑连号，图的不是准，是没人跟你分。'],
      params: [
        { key: 'count', type: 'seg', label: '买几注', values: [1, 3, 5], def: 3, suffix: ' 注' },
        { key: 'runLen', type: 'seg', label: '连几个', values: [3, 4], def: 3, suffix: ' 连' }
      ] },

    { id: 'wheel', no: '04', g: 'B', name: '撒网保底', cost: '¥20 起',
      line: '圈 12 个号，用最少注数兜住下限',
      changed: '有条件保底', not: '池子要先中',
      kicker: '把「差一点」变成「至少中几个」',
      title: '圈一片水域，再算最少撒几网',
      why: ['你先圈 9–12 个号，我算出最少几注，能把这片水域铺满。',
            '只要开奖号里有 t 个落在你圈的范围里，就保证至少有一注中 m 个。',
            '但这个保证有个前提——池子本身要先中。前提概率会一并算给你看，大多数期它轮不到生效。'],
      params: [
        { key: 'size', type: 'seg', label: '圈几个号', values: [9, 10, 11, 12], def: 12, suffix: ' 个' },
        { key: 'guarantee', type: 'seg', label: '保到什么程度', values: function (g) {
          return g.mainPick >= 6 ? [['4-3', '池中 4 → 中 3'], ['5-3', '池中 5 → 中 3'], ['5-4', '池中 5 → 中 4'], ['6-4', '池中 6 → 中 4']]
                                 : [['3-2', '池中 3 → 中 2'], ['4-2', '池中 4 → 中 2'], ['4-3', '池中 4 → 中 3'], ['5-3', '池中 5 → 中 3']];
        }, def: function (g) { return g.mainPick >= 6 ? '5-4' : '4-3'; } }] },

    { id: 'dan', no: '05', g: 'B', name: '胆拖缩水', cost: '¥30 上下',
      line: '锁死 2 个号，剩下 8 个轮着配',
      changed: '真省钱', not: '胆必须全中',
      kicker: '唯一一种真能少花钱的玩法',
      title: '70 注的活，十几注干完',
      why: ['选 2 个「胆」，每注都带上；再选 8 个「拖」，轮着跟胆配对。',
            '全胆拖要 70 注、140 块；缩水之后十几注就够，保的下限一模一样。',
            '代价很硬：2 个胆必须全中。少一个，整套票当场作废。'],
      hint: '胆和拖都按冷门度自动挑，不用你选。', params: [] },

    { id: 'blue', no: '06', g: 'B', name: '包蓝保底', cost: '¥32 起',
      line: '蓝球 16 个全包，32 块必中 5 块',
      changed: '百分百中', not: '百分百亏',
      kicker: '把「必中」这件事买下来',
      title: '中奖率 100%，返还率约 24%',
      why: ['双色球蓝球只有 16 个，全包 16 注，花 32 块。',
            '无论开奖号多离谱，总有一注蓝球对得上——最差也中 5 元。',
            '这一格不是教你买，是把「必中 ≠ 划算」这句话摆到桌面上：花 32，固定奖期望只回来七八块。'],
      hint: '彩种决定注数：双色球 16 注，大乐透 66 注。', params: [] },

    { id: 'two', no: '07', g: 'C', name: '两块钱', cost: '¥2',
      line: '就一注，最冷的那注，买完拉倒',
      changed: '花得最少', not: '只有一枪',
      kicker: '给「就玩一把」的人',
      title: '两块钱，买一张入场券',
      why: ['一注，2 元，不加倍，不追。',
            '挑的还是最不挤的那一组，中了照样是一等奖，只是没人跟你抢。',
            '这一格是整站的地板价：如果你只想花两块钱，到这里就可以停了。'],
      hint: '一注，没得调。', params: [] },

    { id: 'budget', no: '08', g: 'C', name: '预算封顶', cost: '¥10 起',
      line: '给 20 块，自动配最划算的注数',
      changed: '绝不超支', not: '概率不变',
      kicker: '先定预算，再谈号码',
      title: '钱先封死，号码在里面挑',
      why: ['你说一个数，我只在这个数里配注数：20 块就是 10 注，一分不超。',
            '注数一定，中奖概率就定了，剩下的优化空间只有「这 10 注有多冷」。',
            '这一格治的是「本来想买 20，最后花了 200」。'],
      params: [{ key: 'budget', type: 'seg', label: '预算', values: [10, 20, 30, 50, 100], def: 20, prefix: '¥' }] },

    { id: 'compound', no: '09', g: 'C', name: '复式小全', cost: '¥14 起',
      line: '7 个号打成一张票，14 块 7 注',
      changed: '省事', not: '不省钱',
      kicker: '一次选 7 个，把选择压力降下来',
      title: '一张票，七个 6+1',
      why: ['平时是「6 选 6」，一个号看走眼就全废；复式是「7 选 6」，容错多一个。',
            '7 个红球打一张票，等于 7 注，14 块钱，出一张票。',
            '概率确实涨到 7 倍——因为你花了 7 倍的钱。每块钱的效率，一分没变。'],
      params: [{ key: 'spec', type: 'seg', label: '票面大小', values: function (g) {
        return g.mainPick >= 6 ? [['7', '7 红 + 1 蓝 · 7 注'], ['8', '8 红 + 1 蓝 · 28 注']]
                               : [['6-2', '6 前 + 2 后 · 6 注'], ['6-3', '6 前 + 3 后 · 18 注'], ['7-2', '7 前 + 2 后 · 21 注']];
      }, def: '7' }] },

    { id: 'backtest', no: '10', g: 'D', name: '回测对照', cost: '不花钱',
      line: '过去 120 期跑一遍，冷门到底赢没赢机选',
      changed: '可证伪', not: '结论可能是没有',
      kicker: '先证明，再相信',
      title: '把「躲人堆」放回历史里跑一遍',
      why: ['每一期都只用它之前的数据，绝不偷看答案。',
            '同一套规则跑三路：冷门挑号、统计画像、纯随机，注数完全一样。',
            '如果冷门真的更准，命中数应该明显高出一截。跑完你就知道答案了——大概率是没有。'],
      hint: '窗口固定 60 期、每期 3 注，保证三路公平。', params: [] },

    { id: 'checkup', no: '11', g: 'D', name: '号码体检', cost: '不花钱',
      line: '33 个号历史上出得匀不匀',
      changed: '查偏心', not: '不预测下期',
      kicker: '先看机器有没有病',
      title: '摇奖机偏心吗？三个检验',
      why: ['第一个：33 个号的出现次数，偏离均匀分布有多远（卡方 + 多重比较校正）。',
            '第二个：上个月的热号，下个月还会不会热。',
            '第三个：漏了十几期的号，是不是「该出了」。三个都指向同一件事——球没有记忆。'],
      hint: '三个检验固定跑，不需要参数。', params: [] },

    { id: 'hold', no: '12', g: 'D', name: '死守一注', cost: '¥2 / 期',
      line: '每期都买同一组，省得纠结',
      changed: '省决策', not: '概率不变',
      kicker: '给「不想每期想号码」的人',
      title: '守一组，然后把这事忘掉',
      why: ['固定一注，每期照打。不用研究，不用纠结，也不用怕「换了号它就开出来」。',
            '下面直接把这一注放回过去 120 期，一期一期对，看它到底中过什么。',
            '守号的好处是省心，不是「早晚会中」——它每一期都还是那个概率。'],
      hint: '号码固定，每期照打。想换号码就点「换一组」。', params: [] }
  ];
  var PLAY_MAP = {};
  PLAYS.forEach(function (p) { PLAY_MAP[p.id] = p; });

  function simpleMarkup() {
    return '' +
      '<div id="ltGrid">' +
        '<div class="lt-g-intro">' +
          '<div class="lt-g-intro-l"><span class="lt-eyebrow">12 WAYS TO PLAY</span>' +
          '<h3>先选一个你最在乎的东西</h3>' +
          '<p>中奖率一个字都改不了。能改的只有三件事：<b>中了跟几个人分</b>、<b>同样的钱覆盖多少</b>、<b>你知不知道自己买的是什么</b>。十二个格子按这三件事分，第四组专门用来打脸。</p></div>' +
          '<div class="lt-g-intro-r"><b>12</b><span>种买法</span><em>全部不改变中奖概率</em></div>' +
        '</div>' +
        '<div id="ltGridBody"></div>' +
        '<div class="lt-g-foot">每一格底下写着两行小字：左边是「换到了什么」，右边是「换不到什么」。没有一格敢写「更容易中」。</div>' +
      '</div>' +
      '<div id="ltPlayView" class="lt-p-view" hidden>' +
        '<div class="lt-p-bar">' +
          '<button class="lt-p-back" id="ltPlayBack" type="button"><span>←</span> 返回十二宫格</button>' +
          '<span class="lt-p-no" id="ltPlayNum">01</span>' +
          '<b class="lt-p-name" id="ltPlayName"></b>' +
          '<span class="lt-p-cost" id="ltPlayCost"></span>' +
        '</div>' +
        '<header class="lt-p-head">' +
          '<p class="lt-p-kicker" id="ltPlayKicker"></p>' +
          '<h3 id="ltPlayTitle"></h3>' +
          '<ol class="lt-p-why" id="ltPlayWhy"></ol>' +
          '<div class="lt-p-tags" id="ltPlayTags"></div>' +
        '</header>' +
        '<section class="lt-p-params" id="ltPlayParams"></section>' +
        '<div class="lt-p-go-wrap">' +
          '<button class="lt-p-go" id="ltPlayGo" type="button">开始算</button>' +
          '<button class="lt-p-reroll" id="ltPlayReroll" type="button">换一组</button>' +
          '<span class="lt-p-hint" id="ltPlayHint"></span>' +
        '</div>' +
        '<section class="lt-p-loading" id="ltPlayLoading" hidden><div class="lt-spin"></div><span id="ltPlayLoadText">正在算…</span></section>' +
        '<section class="lt-p-result" id="ltPlayResult" hidden></section>' +
        '<div class="lt-p-truth" id="ltPlayTruth" hidden></div>' +
      '</div>' +
      '<div id="ltStatus" class="lt-status" role="status" aria-live="polite"></div>';
  }

  function renderGrid() {
    var body = $('ltGridBody');
    if (!body) return;
    var html = '';
    GROUPS.forEach(function (grp) {
      var list = PLAYS.filter(function (p) { return p.g === grp.key; });
      html += '<section class="lt-g-group" data-g="' + grp.key + '" style="--gc:' + grp.color + '">' +
        '<div class="lt-g-head"><b>' + grp.key + '</b><div><span>' + grp.name + '</span><em>' + grp.line + '</em></div></div>' +
        '<div class="lt-g-cards">' + list.map(function (p) {
          return '<button class="lt-g-card" type="button" data-play="' + p.id + '">' +
            '<span class="lt-g-no">' + p.no + '</span>' +
            '<b class="lt-g-name">' + p.name + '</b>' +
            '<span class="lt-g-line">' + p.line + '</span>' +
            '<span class="lt-g-tags"><i>' + p.changed + '</i><s>' + p.not + '</s></span>' +
            '<span class="lt-g-arrow" aria-hidden="true">→</span>' +
          '</button>';
        }).join('') + '</div>' +
      '</section>';
    });
    body.innerHTML = html;
  }

  function currentPlayId() { return ui.play.id; }

  function openPlay(id) {
    var p = PLAY_MAP[id];
    if (!p) return;
    ui.play.id = id;
    ui.play.seed = '竹间-' + id + '-001';
    ui.play.result = null;
    $('ltGrid').hidden = true;
    $('ltPlayView').hidden = false;
    var resp = $('ltResponsible'); if (resp) resp.hidden = true;
    $('ltPlayResult').hidden = true;
    $('ltPlayTruth').hidden = true;
    $('ltPlayLoading').hidden = true;
    setText('ltPlayNum', p.no);
    setText('ltPlayName', p.name);
    setText('ltPlayCost', p.cost);
    setText('ltPlayKicker', p.kicker);
    setText('ltPlayTitle', p.title);
    $('ltPlayWhy').innerHTML = p.why.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    $('ltPlayTags').innerHTML =
      '<span class="lt-p-tag good">换到：' + esc(p.changed) + '</span>' +
      '<span class="lt-p-tag bad">换不到：' + esc(p.not) + '</span>';
    renderPlayParams(p);
    $('ltPlayGo').textContent = p.id === 'backtest' ? '跑回测' : (p.id === 'checkup' ? '做体检' : '开始算');
    var rerollable = ['hide', 'big', 'run', 'two', 'budget', 'compound', 'hold'];
    $('ltPlayReroll').hidden = rerollable.indexOf(p.id) === -1;
    setText('ltPlayHint', p.params.length ? '参数随时可以改，改完再点一次。' : '');
    $('ltPlayView').scrollIntoView({ block: 'start' });
  }

  function closePlay() {
    ui.play.id = null;
    $('ltPlayView').hidden = true;
    $('ltGrid').hidden = false;
    var resp = $('ltResponsible'); if (resp) resp.hidden = false;
    $('ltGrid').scrollIntoView({ block: 'start' });
  }

  function playParamValue(p, key) {
    if (!ui.play.params[p.id]) ui.play.params[p.id] = {};
    var store = ui.play.params[p.id];
    if (store[key] == null) {
      var def = null;
      p.params.forEach(function (x) { if (x.key === key) def = x.def; });
      if (typeof def === 'function') def = def(currentGame());
      store[key] = def;
    }
    return store[key];
  }
  function setPlayParam(p, key, val) {
    if (!ui.play.params[p.id]) ui.play.params[p.id] = {};
    ui.play.params[p.id][key] = val;
  }

  function renderPlayParams(p) {
    var host = $('ltPlayParams');
    if (!p.params.length) {
      host.innerHTML = '<p class="lt-p-noparam">' + esc(p.hint || '这一格不用调参数，直接算。') + '</p>';
      return;
    }
    var html = '';
    p.params.forEach(function (pr) {
      var vals = typeof pr.values === 'function' ? pr.values(currentGame()) : pr.values;
      var cur = playParamValue(p, pr.key);
      var exists = vals.filter(function (v) { return String(Array.isArray(v) ? v[0] : v) === String(cur); }).length > 0;
      if (!exists) {
        cur = typeof pr.def === 'function' ? pr.def(currentGame()) : pr.def;
        setPlayParam(p, pr.key, cur);
      }
      html += '<div class="lt-p-field"><span class="lt-p-label">' + esc(pr.label) + '</span><div class="lt-p-seg" role="group" aria-label="' + esc(pr.label) + '">';
      vals.forEach(function (v) {
        var val = Array.isArray(v) ? v[0] : v;
        var text = Array.isArray(v) ? v[1] : ((pr.prefix || '') + v + (pr.suffix || ''));
        html += '<button type="button" class="' + (String(cur) === String(val) ? 'on' : '') + '" data-param="' + pr.key + '" data-value="' + val + '">' + text + '</button>';
      });
      html += '</div></div>';
    });
    host.innerHTML = html;
  }

  function buildPlayState() {
    var draws = currentDraws();
    var analysis = analyze(draws, ui.game, 60);
    var pool = [], subPool = [], i;
    for (i = 1; i <= analysis.game.mainMax; i++) pool.push(i);
    for (i = 1; i <= analysis.game.subMax; i++) subPool.push(i);
    return {
      key: ui.game, game: analysis.game, analysis: analysis, draws: analysis.all,
      pool: pool, subPool: subPool,
      prevMain: analysis.all[0] ? analysis.all[0].main : null,
      jackpot: analysis.jackpotCombinations,
      seed: ui.play.seed
    };
  }

  function runPlay() {
    var p = PLAY_MAP[ui.play.id];
    if (!p) return;
    var btn = $('ltPlayGo');
    btn.disabled = true;
    $('ltPlayLoading').hidden = false;
    $('ltPlayResult').hidden = true;
    $('ltPlayTruth').hidden = true;
    setText('ltPlayLoadText', p.id === 'backtest' ? '正在逐期回测，每一期都只用它之前的数据…'
      : (p.id === 'checkup' ? '正在做卡方检验、热号延续和遗漏分箱…' : '正在从几万种组合里挑…'));
    var go = function () {
      var st = buildPlayState();
      ui.play.prevMain = st.prevMain;
      var prm = ui.play.params[p.id] || {};
      var res;
      try {
        if (p.id === 'hide') res = playHide(st, prm);
        else if (p.id === 'big') res = playBig(st, prm);
        else if (p.id === 'run') res = playRun(st, prm);
        else if (p.id === 'wheel') res = playWheel(st, prm);
        else if (p.id === 'dan') res = playDan(st, prm);
        else if (p.id === 'blue') res = playBlue(st, prm);
        else if (p.id === 'two') res = playTwo(st, prm);
        else if (p.id === 'budget') res = playBudget(st, prm);
        else if (p.id === 'compound') res = playCompound(st, prm);
        else if (p.id === 'backtest') res = playBacktest(st, prm);
        else if (p.id === 'checkup') res = playCheckup(st, prm);
        else if (p.id === 'hold') res = playHold(st, prm);
      } catch (e) {
        res = { ok: false, error: '算的时候出了点问题：' + e.message };
      }
      btn.disabled = false;
      $('ltPlayLoading').hidden = true;
      if (!res || !res.ok) {
        $('ltPlayResult').hidden = false;
        $('ltPlayResult').innerHTML = '<div class="lt-p-error">' + esc((res && res.error) || '没算出来') + '</div>';
        return;
      }
      ui.play.result = res;
      renderPlayResult(p, res);
    };
    setTimeout(go, 40);
  }

  function renderPlayResult(p, res) {
    ui.play.tickets = res.tickets || [];
    var html = '';
    html += '<div class="lt-p-result-head"><div><span class="lt-eyebrow">RESULT</span><h4>' + esc(res.headline) + '</h4></div>' +
      (res.count ? '<div class="lt-p-result-actions">' +
        '<button type="button" id="ltPlayCopy">复制全部</button>' +
        '<button type="button" id="ltPlayPend">＋ 全部加入待办</button></div>' : '') + '</div>';
    if (res.summary && res.summary.length) {
      html += '<div class="lt-p-sumgrid">' + res.summary.map(function (s) {
        return '<div class="lt-p-sum"><span>' + esc(s.k) + '</span><b>' + esc(s.v) + '</b><small>' + esc(s.sub || '') + '</small></div>';
      }).join('') + '</div>';
    }
    if (res.count) {
      if (res.layout === 'list' || res.count > 8) {
        var mark = res.mark || [];
        html += '<div class="lt-p-list">' + res.tickets.map(function (t, i) {
          return '<div class="lt-p-row"><span>' + pad2(i + 1) + '</span><b>' + t.main.map(function (n) {
            return mark.indexOf(n) > -1 ? '<em class="lt-p-dan">' + pad2(n) + '</em>' : pad2(n);
          }).join(' ') + '</b>' +
            (t.sub.length ? '<i>+</i><b class="blue">' + t.sub.map(pad2).join(' ') + '</b>' : '') + '</div>';
        }).join('') + '</div>' +
        '<p class="lt-p-small">' + res.count + ' 注，合计 ¥' + (res.cost || res.count * 2) + '。注数多的时候不逐注讲故事——故事是给「就买几注」的人看的。</p>';
      } else {
        var used = {};
        html += '<div class="lt-p-cards">' + res.tickets.map(function (t, i) {
          return ticketCardHtml(t, i, used);
        }).join('') + '</div>';
      }
    }
    if (res.table) {
      html += '<div class="lt-p-tablewrap"><table class="lt-p-table"><thead><tr>' +
        res.table.head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
        '</tr></thead><tbody>' + res.table.rows.map(function (r) {
          return '<tr>' + r.map(function (c, ci) { return '<td' + (ci === 0 ? ' class="k"' : '') + '>' + esc(c) + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table></div>' +
        (res.table.note ? '<p class="lt-p-note">' + esc(res.table.note) + '</p>' : '');
    }
    $('ltPlayResult').innerHTML = html;
    $('ltPlayResult').hidden = false;
    var truth = $('ltPlayTruth');
    truth.innerHTML = '<b>这一格改了什么、没改什么</b><p>' + esc(res.truth || p.why[p.why.length - 1]) + '</p>';
    truth.hidden = false;
    bind('ltPlayCopy', 'click', function () {
      writeClipboard(res.tickets.map(function (t, i) {
        return (i + 1) + '. ' + t.main.map(pad2).join(' ') + (t.sub.length ? ' + ' + t.sub.map(pad2).join(' ') : '');
      }).join('\n'), '已复制 ' + res.tickets.length + ' 注。');
    });
    bind('ltPlayPend', 'click', function () {
      var added = 0, dup = 0;
      res.tickets.forEach(function (t) {
        var r = addPending(t);
        if (r === 'ok') added++; else if (r === 'duplicate') dup++;
      });
      if (added) notify('已把 ' + added + ' 注加入「待办」，提醒设在开奖前一天 20:00' + (dup ? '；' + dup + ' 注之前加过' : '') + '。');
      else notify('这些号码都已经在「待办」里了。');
    });
  }

  function ticketCardHtml(t, i, used) {
    var cp = t.crowd || crowdProfile(t.main, t.sub, currentGame(), ui.play.prevMain);
    var prev = ui.play.prevMain;
    var story = pickStory(t.main, currentGame(), prev, used);
    var factors = cp.factors.map(function (f) { return '<li class="' + f.dir + '">' + esc(f.text) + '</li>'; }).join('');
    return '<article class="lt-p-card">' +
      '<div class="lt-p-card-top"><span>第 ' + (i + 1) + ' 注</span><span class="lt-p-card-people">' + esc(cp.people) + '</span></div>' +
      '<div class="lt-p-balls">' + t.main.map(function (n) { return '<b class="red">' + pad2(n) + '</b>'; }).join('') +
        '<i>+</i>' + t.sub.map(function (n) { return '<b class="blue">' + pad2(n) + '</b>'; }).join('') + '</div>' +
      '<div class="lt-p-crowd"><b>冷门度 ' + cp.score + '</b><span class="lt-p-lv">' + cp.level + '</span>' +
        '<span class="lt-p-crowdbar"><i style="width:' + cp.score + '%"></i></span></div>' +
      '<ul class="lt-p-factors">' + factors + '</ul>' +
      '<details class="lt-p-story"><summary>谁在买这种号 · ' + esc(story.label) + '</summary>' +
        '<p class="who">' + esc(story.who) + '</p><p>' + esc(story.text) + '</p>' +
        '<p class="coda">' + esc(crowdCoda(cp.score)) + '</p></details>' +
    '</article>';
  }

  function rerollPlay() {
    ui.play.seed = '竹间-' + ui.play.id + '-' + Math.random().toString(36).slice(2, 8);
    runPlay();
  }

  function setMode(simple) {
    $('ltSimpleView').hidden = !simple;
    $('ltAdvanceView').hidden = simple;
    var btn = $('ltAdvanceToggle');
    if (simple) {
      btn.textContent = '专业数据 ↗';
      btn.setAttribute('aria-expanded', 'false');
      if (ui.play.id) runPlay(); else { closePlay(); renderGrid(); }
    } else {
      btn.textContent = '← 回到傻瓜模式';
      btn.setAttribute('aria-expanded', 'true');
      renderAll();
    }
  }

  function syncOfficial() {
    var g=currentGame();
    if(!g.directSync){
      $('ltImportPanel').hidden=false;
      $('ltImportText').focus();
      notify(g.name+'官网未允许浏览器跨域读取。请从刚打开的官方数据源复制最新记录后粘贴；不会使用第三方代理。');
      root.open(g.sourceUrl,'_blank','noopener,noreferrer');
      return;
    }
    var btn=$('ltSync');btn.disabled=true;setText('ltSync','同步中…');
    var url='https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry?gameNo=85&provinceId=0&pageSize=100&pageNo=1';
    root.fetch(url,{method:'GET'}).then(function(res){if(!res.ok)throw new Error('HTTP '+res.status);return res.json();}).then(function(j){
      if(!j||!j.success||!j.value||!Array.isArray(j.value.list))throw new Error('官网返回格式变化');
      var incoming=normalizeDraws(j.value.list,'dlt'),before=currentDraws()[0];
      ui.data.dlt=mergeDraws(ui.data.dlt,incoming,'dlt');persist();renderAll();
      var after=ui.data.dlt[0];notify(before.issue===after.issue?'官网已是最新：'+after.issue+' 期':'更新成功：'+before.issue+' → '+after.issue+'，共 '+ui.data.dlt.length+' 期');
    }).catch(function(e){notify('官方同步失败：'+e.message+'。现有数据未改动，可稍后重试或手工导入。');}).then(function(){btn.disabled=false;setText('ltSync','同步官方数据');});
  }
  function applyImport() {
    try {
      var incoming=parseImport($('ltImportText').value,ui.game);
      var before=currentDraws().length;
      ui.data[ui.game]=mergeDraws(currentDraws(),incoming,ui.game);
      if(!persist())return;
      renderAll();$('ltImportText').value='';
      notify('导入成功：读取 '+incoming.length+' 期，净增 '+(currentDraws().length-before)+' 期，冲突与重复已校验。');
    } catch(e) { notify('导入未执行：'+e.message); }
  }
  function resetData() {
    if(!root.confirm('只恢复当前彩种的内置数据，清除该彩种后来导入的本机记录。笔记不受影响。继续吗？'))return;
    var seed=root.BAMBOO_LOTTERY_DATA||{};
    ui.data[ui.game]=normalizeDraws(seed[ui.game]||[],ui.game);persist();renderAll();notify('已恢复当前彩种的内置数据。');
  }
  function copyReport() {
    writeClipboard(buildReport(ui.analysis,ui.candidates,ui.bt,$('ltSeed').value.trim()||'竹间-001',$('ltMode').value),'完整分析报告已复制。');
  }
  function writeClipboard(text,okMsg) {
    function done(){notify(okMsg);}
    if(root.navigator.clipboard&&root.isSecureContext){root.navigator.clipboard.writeText(text).then(done).catch(function(){fallbackCopy(text,okMsg);});}
    else fallbackCopy(text,okMsg);
  }
  function fallbackCopy(text,okMsg) {
    var ta=root.document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';root.document.body.appendChild(ta);ta.select();
    try{root.document.execCommand('copy');notify(okMsg);}catch(e){notify('复制失败，请使用浏览器允许剪贴板后重试。');}
    ta.remove();
  }
  function aiExplain() {
    if(!ui.opts.hasAI||!ui.opts.hasAI()){notify('尚未配置 DeepSeek。本地统计与候选可完整使用；如需 AI 解读，请先到设置填写 AI 接口与密钥。');return;}
    var btn=$('ltAi');btn.disabled=true;btn.textContent='AI 分析中…';$('ltAiPanel').hidden=false;setText('ltAiText','正在只基于本地统计结果生成解读，不会修改号码…');
    ui.opts.explain(buildAiPrompt(ui.analysis,ui.candidates,ui.bt)).then(function(text){
      $('ltAiText').textContent=String(text||'AI 未返回内容');$('ltAiPanel').hidden=false;
    }).catch(function(e){setText('ltAiText','AI 解读失败：'+e.message+'\n本地统计、候选和回测不受影响。');}).then(function(){btn.disabled=false;btn.textContent='✨ DeepSeek 交叉解读';});
  }

  function open() {
    if(!ui.inited)return false;
    ui.openFlag=true;ui.lastFocus=root.document.activeElement;
    $('lotteryLab').classList.add('open');$('lotteryLab').removeAttribute('hidden');
    root.document.body.style.overflow='hidden';
    setMode(true);setTimeout(function(){$('ltClose').focus();},0);
    return true;
  }
  function close() {
    if(!ui.inited)return;ui.openFlag=false;
    $('lotteryLab').classList.remove('open');$('lotteryLab').setAttribute('hidden','');
    root.document.body.style.overflow='';
    if(ui.lastFocus&&ui.lastFocus.focus)ui.lastFocus.focus();
  }
  function switchGame(game) {
    if(!GAMES[game])return;ui.game=game;ui.play.params={};
    ['ssq','dlt'].forEach(function(k){var b=$('ltGame'+k.charAt(0).toUpperCase()+k.slice(1));if(b){b.classList.toggle('active',k===game);b.setAttribute('aria-selected',k===game?'true':'false');}});
    if(ui.openFlag){
      if(!$('ltAdvanceView').hidden){renderAll();return;}
      if(ui.play.id) {
        var cur=PLAY_MAP[ui.play.id];
        if(cur) renderPlayParams(cur);
        runPlay();
      } else renderGrid();
    }
  }
  function bind(id,event,fn){var e=$(id);if(e)e.addEventListener(event,fn);}
  function init(opts) {
    if(ui.inited||!root||!root.document)return;
    ui.opts=opts||{};
    var host=$('lotteryLab');if(!host)throw new Error('缺少 lotteryLab 容器');
    host.innerHTML=markup();loadData();ui.inited=true;
    bind('ltClose','click',close);
    bind('ltHelp','click',function(){var p=$('ltHelpPanel');p.hidden=!p.hidden;if(!p.hidden)p.scrollIntoView({block:'nearest'});});
    bind('ltHelpClose','click',function(){$('ltHelpPanel').hidden=true;});
    bind('ltGameSsq','click',function(){switchGame('ssq');});
    bind('ltGameDlt','click',function(){switchGame('dlt');});
    bind('ltGenerate','click',renderAll);
    bind('ltWindow','change',renderAll);bind('ltCount','change',renderAll);bind('ltMode','change',renderAll);
    bind('ltSeed','keydown',function(e){if(e.key==='Enter')renderAll();});
    bind('ltSync','click',syncOfficial);bind('ltImportToggle','click',function(){$('ltImportPanel').hidden=!$('ltImportPanel').hidden;});
    bind('ltImportApply','click',applyImport);bind('ltImportReset','click',resetData);
    bind('ltImportFile','change',function(e){var f=e.target.files&&e.target.files[0];if(!f)return;if(f.size>2*1024*1024){notify('文件超过 2 MB，未读取。');e.target.value='';return;}var reader=new root.FileReader();reader.onload=function(){$('ltImportText').value=String(reader.result||'');notify('文件已读取，点击“校验并合并”后才会写入。');};reader.onerror=function(){notify('文件读取失败。');};reader.readAsText(f,'utf-8');e.target.value='';});
    bind('ltCopy','click',copyReport);bind('ltAi','click',aiExplain);
    bind('ltMainFreq','click',function(e){var b=e.target.closest('.lt-num');if(b)notify(currentGame().mainName+' '+pad2(Number(b.getAttribute('data-n')))+'：当前窗口出现 '+b.getAttribute('data-count')+' 次，标准化偏差 z='+b.getAttribute('data-z')+'，当前遗漏 '+b.getAttribute('data-gap')+' 期。');});
    bind('ltSubFreq','click',function(e){var b=e.target.closest('.lt-num');if(b)notify(currentGame().subName+' '+pad2(Number(b.getAttribute('data-n')))+'：当前窗口出现 '+b.getAttribute('data-count')+' 次，标准化偏差 z='+b.getAttribute('data-z')+'，当前遗漏 '+b.getAttribute('data-gap')+' 期。');});
    bind('ltAdvanceToggle','click',function(){setMode(!$('ltAdvanceView').hidden);});
    bind('ltGridBody','click',function(e){
      var b=e.target.closest('[data-play]');if(b)openPlay(b.getAttribute('data-play'));
    });
    bind('ltPlayBack','click',closePlay);
    bind('ltPlayParams','click',function(e){
      var b=e.target.closest('[data-param]');if(!b)return;
      var p=PLAY_MAP[ui.play.id];if(!p)return;
      setPlayParam(p,b.getAttribute('data-param'),b.getAttribute('data-value'));
      renderPlayParams(p);
      $('ltPlayResult').hidden=true;$('ltPlayTruth').hidden=true;
    });
    bind('ltPlayGo','click',runPlay);
    bind('ltPlayReroll','click',rerollPlay);
    bind('ltStatus','click',function(){});
    root.document.addEventListener('keydown',function(e){
      if(!ui.openFlag)return;
      if(e.key==='Escape'){e.preventDefault();close();return;}
      if(e.key==='Tab'){
        var focusables=host.querySelectorAll('button:not([disabled]),a[href],input,select,textarea,summary'),first=focusables[0],last=focusables[focusables.length-1];
        if(e.shiftKey&&root.document.activeElement===first){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&root.document.activeElement===last){e.preventDefault();first.focus();}
      }
    });
    switchGame('ssq');
  }

  return {
    GAMES:GAMES,STORAGE_KEY:STORAGE_KEY,nextDrawSlot:nextDrawSlot,
    normalizeDraw:normalizeDraw,normalizeDraws:normalizeDraws,mergeDraws:mergeDraws,parseImport:parseImport,
    analyze:analyze,generateCandidates:generateCandidates,backtest:backtest,
    crowdProfile:crowdProfile,wheelDesign:wheelDesign,backtestVerdict:backtestVerdict,biasAudit:biasAudit,
    signFlipP:signFlipP,describeDiffs:describeDiffs,studentTTwoTail:studentTTwoTail,
    numPopularity:numPopularity,popcount:popcount,autoPool:autoPool,
    classifyTicket:classifyTicket,pickStory:pickStory,crowdCoda:crowdCoda,STORY:STORY,
    buildReport:buildReport,buildAiPrompt:buildAiPrompt,
    prizeOf:prizeOf,ticketHit:ticketHit,singleFixedEV:singleFixedEV,replay:replay,
    coverCore:coverCore,pickColdTickets:pickColdTickets,runTickets:runTickets,
    maxRun:maxRun,shapeShare:shapeShare,hotColdPersistence:hotColdPersistence,gapPersistence:gapPersistence,
    backtestAll:backtestAll,PLAYS:PLAYS,PLAY_MAP:PLAY_MAP,danProb:danProb,
    playHide:playHide,playBig:playBig,playRun:playRun,playWheel:playWheel,playDan:playDan,
    playBlue:playBlue,playTwo:playTwo,playBudget:playBudget,playCompound:playCompound,
    playBacktest:playBacktest,playCheckup:playCheckup,playHold:playHold,
    chiSquareP:chiSquareP,combination:combination,hypergeometric:hypergeometric,
    structureOf:structureOf,rngFrom:rngFrom,
    init:init,open:open,close:close,
    _ui:ui
  };
});
