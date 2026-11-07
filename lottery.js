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

  function generateCandidates(input, gameKey, options) {
    options=options||{};
    var analysis=options.analysis||analyze(input,gameKey,options.windowSize||60);
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

  function buildReport(analysis,candidates,bt,seed,mode) {
    var g=analysis.game,L=[];
    L.push('【竹间记 · 数彩实验室】');
    L.push('娱乐统计，不构成购彩建议；历史数据不能提高下一期中奖概率。未满18岁请勿购彩。');
    L.push('彩种：'+g.name+'｜数据：'+analysis.all.length+' 期｜分析窗：'+analysis.draws.length+' 期');
    L.push('最新：'+analysis.all[0].issue+' 期 '+(analysis.all[0].date||'日期未提供')+'｜来源：'+g.sourceName);
    L.push('模式：'+(mode==='uniform'?'纯随机对照':'统计画像')+'｜复现种子：'+seed);
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
    L.push('娱乐候选（统计画像评分不是中奖概率）：');
    candidates.forEach(function(c,i){
      L.push((i+1)+'. '+c.main.map(pad2).join(' ')+' + '+c.sub.map(pad2).join(' '));
      L.push('   '+c.reasons.join('；'));
    });
    L.push('----------------------------------------');
    L.push('方法：近期/长期频率、Beta 先验收缩、当前遗漏、和值/跨度/奇偶/三区/连号/重复、号码对共现、组合多样性与滚动回测。');
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
      candidates:candidates.map(function(c){return {main:c.main,sub:c.sub,reasons:c.reasons};})
    };
    return '你是严谨的彩票统计解读助手。下面是本地程序基于真实历史开奖计算出的 JSON 结果。只允许解释这些数字，不得补充、猜测或改写历史数据，不得修改候选号码。请用中文输出不超过 500 字，分「数据观察」「交叉解读」「回测结论」「边界提醒」四段。必须明确：遗漏不代表该出，冷热不代表下一期倾向；统计画像不是中奖率；公平开奖各期独立；回测样本不能证明未来优势；不得使用稳中、包中、精准预测、提高中奖率等措辞。语气清楚克制，不鼓励购彩。\n'+JSON.stringify(brief);
  }

  // ------------------------------ UI ------------------------------
  var ui={inited:false,openFlag:false,game:'ssq',data:{ssq:[],dlt:[]},analysis:null,candidates:[],bt:null,lastFocus:null,opts:{},simple:{count:5,seed:'竹间-001',analysis:null,candidates:[],bt:null,runId:0}};
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

  function markup() {
    return ''+
    '<div class="lt-shell">'+
      '<header class="lt-header"><div class="lt-brand"><span class="lt-logo"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="9.6" cy="12" r="5.7" fill="#ff5f6d"/><circle cx="14.6" cy="12" r="5.7" fill="#4f86ff"/><circle cx="7.6" cy="9.7" r="1.9" fill="#ffffff" opacity=".55"/><circle cx="12.6" cy="9.7" r="1.9" fill="#ffffff" opacity=".55"/></svg></span><div><h2 id="lotteryTitle">数彩助手</h2><p>复杂分析帮你做，只留一看就懂的号码</p></div></div>'+
      '<div class="lt-header-actions"><button class="lt-icon" id="ltHelp" type="button" aria-label="使用指南" title="使用指南"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></svg></button><button class="lt-icon" id="ltClose" type="button" aria-label="关闭数彩助手"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div></header>'+
      '<div class="lt-body">'+
      '<div class="lt-responsible lt-tiny">娱乐统计，不是中奖承诺：每注中奖概率相同，历史数据不能提高概率。理性娱乐、量力而行。</div>'+
      '<section id="ltHelpPanel" class="lt-help" hidden><div class="lt-help-head"><h3>傻瓜式使用指南</h3><button id="ltHelpClose" type="button" aria-label="收起使用指南">收起</button></div>'+
      '<ol class="lt-steps">'+
      '<li><b>打开就有</b>：点首页「数彩」按钮，助手自动算好，屏幕扫过分析过程后直接给你号码。</li>'+
      '<li><b>选彩种</b>：顶部切换「双色球」或「超级大乐透」，两个彩种互不影响。</li>'+
      '<li><b>选几注</b>：点 3 / 5 / 8 注，再点「帮我选」或「换一组」都能重新出号。</li>'+
      '<li><b>照着填</b>：红球在前、蓝球在后，点「复制号码」或每注右上角「复制这注」带走。</li>'+
      '<li><b>想看门道</b>：点顶部「专业数据」，能看到频率、结构、回测等完整分析。</li>'+
      '<li><b>更新开奖</b>：在「专业数据」页点「更新数据」，从官网复制最新记录粘贴导入。</li>'+
      '<li><b>AI 解读</b>：在「专业数据」页点「✨ DeepSeek 解读」，用大白话解释（可选）。</li>'+
      '</ol>'+
      '<p class="lt-note">重要：这是<b>娱乐数据研究</b>。公平开奖各期独立，历史冷热、遗漏、AI 解读都不能改变中奖概率；任何合法单式组合的中奖概率完全相同。未满 18 岁请勿购彩，不借贷、不追损。</p></section>'+
      '<div class="lt-topline"><div class="lt-games" role="tablist" aria-label="彩种"><button id="ltGameSsq" data-game="ssq" role="tab" type="button">双色球</button><button id="ltGameDlt" data-game="dlt" role="tab" type="button">超级大乐透</button></div>'+
      '<div class="lt-top-actions"><a id="ltSourceLink" class="lt-source" target="_blank" rel="noopener noreferrer">官方数据源 ↗</a><button class="lt-mini" id="ltAdvanceToggle" type="button" aria-expanded="false">专业数据 ↗</button></div></div>'+
      '<div id="ltSimpleView">'+
        '<section class="lt-hero">'+
          '<h3>帮你把复杂的概率分析，变成一注号码</h3>'+
          '<p class="lt-hero-sub">选个注数，剩下的交给它。分析过程会一闪而过，你只看结果就好。</p>'+
          '<div class="lt-count-choice" role="group" aria-label="选择注数">'+
            '<button type="button" id="ltPick1" data-count="1">1 注</button>'+
            '<button type="button" id="ltPick3" data-count="3">3 注</button>'+
            '<button type="button" id="ltPick5" data-count="5" class="active">5 注</button>'+
            '<button type="button" id="ltPick8" data-count="8">8 注</button>'+
          '</div>'+
          '<details class="lt-persona" id="ltPersona"><summary>🎯 可选：告诉我你的星座 / 生肖 / 性别，帮你挑最配的一注</summary>'+
          '<div class="lt-persona-fields">'+
          '<label>星座<select id="ltSign"><option value="">不选</option><option>白羊座</option><option>金牛座</option><option>双子座</option><option>巨蟹座</option><option>狮子座</option><option>处女座</option><option>天秤座</option><option>天蝎座</option><option>射手座</option><option>摩羯座</option><option>水瓶座</option><option>双鱼座</option></select></label>'+
          '<label>生肖<select id="ltZodiac"><option value="">不选</option><option>鼠</option><option>牛</option><option>虎</option><option>兔</option><option>龙</option><option>蛇</option><option>马</option><option>羊</option><option>猴</option><option>鸡</option><option>狗</option><option>猪</option></select></label>'+
          '<label>性别<select id="ltGender"><option value="">不选</option><option>男</option><option>女</option></select></label>'+
          '</div><p class="lt-persona-note">只是娱乐标签，用来区分每注的“气质”，不会提高中奖概率。</p></details>'+
          '<button class="lt-go" id="ltSimpleGo" type="button">✨ 帮我选一组号码</button>'+
        '</section>'+
        '<section id="ltScan" class="lt-scan" hidden><div class="lt-scan-inner"><div class="lt-spin"></div><div id="ltScanText" class="lt-scan-text">正在读取最近开奖数据…</div><div class="lt-scan-dots"><i>·</i><i>·</i><i>·</i></div></div></section>'+
        '<section id="ltSimpleResult" hidden>'+
          '<div class="lt-result-head"><div><span class="lt-eyebrow">YOUR PICKS</span><h3 id="ltResultTitle">帮你选好了，照着填就行</h3></div>'+
          '<div class="lt-result-actions"><button id="ltSimpleCopy" type="button">复制号码</button><button id="ltSimpleReroll" class="lt-ai" type="button">换一组</button></div></div>'+
          '<div class="lt-plain-note">红球在前、蓝球在后。号码经过多维统计，但<b>任何号码中奖概率都相同</b>，把它当娱乐就好。</div>'+
          '<div id="ltSimpleTickets" class="lt-simple-tickets"></div>'+
        '</section>'+
        '<div id="ltStatus" class="lt-status" role="status" aria-live="polite"></div>'+
      '</div>'+
      '<div id="ltAdvanceView" hidden>'+
      '<section class="lt-data-card"><div><span class="lt-eyebrow">DATA HEALTH</span><h3 id="ltDataTitle"></h3><p id="ltDataMeta"></p></div><div class="lt-data-actions"><button id="ltSync" type="button">更新数据</button><button id="ltImportToggle" type="button">导入 / 粘贴</button></div></section>'+
      '<section id="ltImportPanel" class="lt-import" hidden><h3>导入真实开奖记录</h3><p>支持 JSON 或逐行文本。所有记录会校验期号、日期、号码数量、范围与重复；任何一行不合格都不会写入。</p>'+
      '<textarea id="ltImportText" rows="5" spellcheck="false" placeholder="2026127 2026-11-05 13 14 19 25 29 32 + 12"></textarea>'+
      '<div class="lt-import-actions"><input id="ltImportFile" type="file" accept=".json,.txt,text/plain,application/json"><button id="ltImportApply" type="button">校验并合并</button><button id="ltImportReset" type="button">恢复内置数据</button></div>'+
      '<p class="lt-small">数据只保存在本浏览器独立键 bamboo.v13.lottery.data，不进入笔记、备份或 GitHub 同步。两家官网均不允许浏览器跨域读取（体彩网关实测会拦截），请从官方页面复制最新记录后粘贴；本模块不使用第三方代理。</p></section>'+
      '<section class="lt-controls"><label>分析窗口<select id="ltWindow"><option value="30">近 30 期</option><option value="60" selected>近 60 期</option><option value="100">近 100 期</option><option value="0">全部数据</option></select></label>'+
      '<label>候选注数<select id="ltCount"><option value="3">3 注</option><option value="5" selected>5 注</option><option value="8">8 注</option></select></label>'+
      '<label>生成模式<select id="ltMode"><option value="statistical">统计画像</option><option value="uniform">纯随机对照</option></select></label>'+
      '<label>复现种子<input id="ltSeed" value="竹间-001" maxlength="32" autocomplete="off"></label>'+
      '<button class="lt-primary" id="ltGenerate" type="button">生成交叉分析</button></section>'+
      '<div id="ltAdvanceStatus" class="lt-status" role="status" aria-live="polite"></div>'+
      '<section class="lt-metrics" id="ltMetrics"></section>'+
      '<div class="lt-two-col"><section class="lt-panel"><div class="lt-panel-head"><div><span class="lt-eyebrow">DISTRIBUTION</span><h3 id="ltMainFreqTitle">号码频率与遗漏</h3></div><span class="lt-tag">点击号码看细节</span></div><div id="ltMainFreq" class="lt-ball-grid"></div><h4 id="ltSubFreqTitle" class="lt-subhead"></h4><div id="ltSubFreq" class="lt-ball-grid lt-sub-grid"></div><p class="lt-note">颜色表示近期标准化频率，数字下方为当前遗漏期数。遗漏只是距上次出现的距离，不代表“该出了”。</p></section>'+
      '<section class="lt-panel"><span class="lt-eyebrow">STRUCTURE</span><h3>组合结构画像</h3><div id="ltStructure" class="lt-structure"></div><h4 class="lt-subhead">高频共现号码对</h4><div id="ltPairs" class="lt-pairs"></div><p class="lt-note">共现经过支持度与期望频次对照；小样本的高提升度不等于稳定规律。</p></section></div>'+
      '<section class="lt-panel lt-candidate-panel"><div class="lt-panel-head"><div><span class="lt-eyebrow">CANDIDATES</span><h3>娱乐候选组合</h3></div><div><button id="ltCopy" type="button">复制完整报告</button><button id="ltAi" class="lt-ai" type="button">✨ DeepSeek 交叉解读</button></div></div>'+
      '<div class="lt-responsible lt-compact">候选由所选模式与复现种子确定。“画像依据”只描述它与历史样本的相似程度，<b>不是中奖率、不是推荐购买</b>。</div><div id="ltCandidates" class="lt-candidates"></div><div id="ltAiPanel" class="lt-ai-panel" hidden><h4>AI 解读（仅基于上方计算结果）</h4><div id="ltAiText"></div></div></section>'+
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
  // 娱乐个性化：五行 / 星座 / 生肖映射（只影响展示与推荐指数，不改号码生成、不改概率）
  var WX_ORDER=['木','火','土','金','水'];
  var SIGNS=[['白羊座','火'],['金牛座','土'],['双子座','金'],['巨蟹座','水'],['狮子座','火'],['处女座','土'],['天秤座','金'],['天蝎座','水'],['射手座','火'],['摩羯座','土'],['水瓶座','金'],['双鱼座','水']];
  var ZODIAC=[['鼠','水'],['牛','土'],['虎','木'],['兔','木'],['龙','土'],['蛇','火'],['马','火'],['羊','土'],['猴','金'],['鸡','金'],['狗','土'],['猪','水']];
  var WX_TAG={
    '木':{who:'属虎、属兔', note:'春生 · 有冲劲、爱尝鲜'},
    '火':{who:'白羊 / 狮子 / 射手', note:'热情、果断'},
    '土':{who:'金牛 / 处女 / 摩羯', note:'稳重、踏实'},
    '金':{who:'双子 / 天秤 / 水瓶', note:'理性、干脆'},
    '水':{who:'巨蟹 / 天蝎 / 双鱼', note:'敏锐、细腻'}
  };
  function wuxingOfNumber(n){var t=n%10;if(t===1||t===6)return '水';if(t===2||t===7)return '火';if(t===3||t===8)return '木';if(t===4||t===9)return '金';return '土';}
  function wuxingOfTicket(c){
    var cnt={'木':0,'火':0,'土':0,'金':0,'水':0}, total=0, main='土', max=0;
    c.main.concat(c.sub).forEach(function(n){var w=wuxingOfNumber(n);cnt[w]++;total++;});
    WX_ORDER.forEach(function(k){if(cnt[k]>max){max=cnt[k];main=k;}});
    return {main:main,count:max,total:total,cnt:cnt};
  }
  function ticketRecommend(c){
    var s=clamp(-c.structureLog,0,2.5), p=clamp(-c.pairMeanLog,0,1.2);
    var wx=wuxingOfTicket(c);
    var wxScore=Math.round((wx.count/wx.total)*5);
    var hc=(c.hotCount>0&&c.coldCount>0)?2:1;
    return Math.round(clamp(60 + s*10 + p*9 + wxScore + hc, 60, 99));
  }
  function starsOf(idx){var n=Math.max(1,Math.min(5,Math.round(idx/20)));return '★★★★★'.slice(0,n)+'☆☆☆☆☆'.slice(0,5-n);}
  function userTargetWx(){
    var set={}, i, sv=($('ltSign')||{}).value, zv=($('ltZodiac')||{}).value, gv=($('ltGender')||{}).value;
    for(i=0;i<SIGNS.length;i++)if(SIGNS[i][0]===sv)set[SIGNS[i][1]]=1;
    for(i=0;i<ZODIAC.length;i++)if(ZODIAC[i][0]===zv)set[ZODIAC[i][1]]=1;
    if(gv==='男'){set['火']=1;set['木']=1;}
    if(gv==='女'){set['水']=1;set['金']=1;}
    return Object.keys(set);
  }
  function plainReasons(c, a) {
    var s=c.structure, g=a.game, out=[];
    var sumLabel = s.sum>=a.sumQ[0]&&s.sum<=a.sumQ[2] ? '落在历史常见的中间区间' : (s.sum<a.sumQ[0]?'比多数历史偏小':'比多数历史偏大');
    out.push('奇偶搭配是 '+s.odd+' 个奇数、'+(g.mainPick-s.odd)+' 个偶数，和值 '+s.sum+' '+sumLabel+'。');
    if (s.consecutive>0) out.push('里面有 '+s.consecutive+' 组连号，和不少开奖常见的形态类似。');
    else out.push('号码之间没有连号，分布比较均匀。');
    var hot=c.hotCount, cold=c.coldCount;
    if(hot>0&&cold>0) out.push('选了 '+hot+' 个近期偏热、'+cold+' 个久未出现的号码，冷热搭配。');
    else if(hot>0) out.push('以近期偏热的号码为主，共 '+hot+' 个。');
    else if(cold>0) out.push('偏向久未出现的冷号，共 '+cold+' 个。');
    else out.push('号码冷热比较均衡。');
    return out;
  }
  function renderSimpleTickets() {
    var s=ui.simple;
    var target=userTargetWx();
    var rows=s.candidates.map(function(c,i){
      var wx=wuxingOfTicket(c);
      return {i:i, c:c, wx:wx, rec:ticketRecommend(c), fit:(target.length>0 && target.indexOf(wx.main)>-1)};
    });
    // 选了标签却没有任何注的五行命中时，退而推荐指数最高的一注（保证总有“最适合你”）
    if(target.length>0 && !rows.some(function(r){return r.fit;})){
      rows.slice().sort(function(a,b){return b.rec-a.rec;})[0].fit=true;
    }
    var items=rows.map(function(r){
      var i=r.i, c=r.c, wx=r.wx, fit=r.fit;
      var finalRec=Math.min(99, r.rec + (fit?5:0));
      var balls=c.main.map(function(n){return '<b class="red">'+pad2(n)+'</b>';}).join('')+'<i>+</i>'+c.sub.map(function(n){return '<b class="blue">'+pad2(n)+'</b>';}).join('');
      var reasons=plainReasons(c,s.analysis).map(function(x){return '<li>'+esc(x)+'</li>';}).join('');
      var tag=WX_TAG[wx.main];
      var fitBadge = fit ? '<span class="lt-fit-badge">⭐ 最适合你</span>' : '';
      return '<article class="lt-big-ticket'+(fit?' lt-fit':'')+'">'+
        '<div class="lt-big-top"><span>第 '+(i+1)+' 注</span><span class="lt-big-actions">'+fitBadge+'<button class="lt-big-copy-one" type="button" data-idx="'+i+'">复制这注</button></span></div>'+
        '<div class="lt-big-balls">'+balls+'</div>'+
        '<div class="lt-reco"><span class="lt-reco-score">推荐指数 '+finalRec+'</span><span class="lt-reco-stars" aria-label="'+starsOf(finalRec)+'">'+starsOf(finalRec)+'</span><span class="lt-reco-wx">五行属'+wx.main+'</span></div>'+
        '<div class="lt-fit-tag">适合：'+esc(tag.who)+' · '+esc(tag.note)+'</div>'+
        '<ul class="lt-plain-reasons">'+reasons+'</ul></article>';
    });
    $('ltSimpleTickets').innerHTML=items.join('');
    setText('ltResultTitle','帮你选好了 '+s.candidates.length+' 注，照着填就行');
  }
  function rerenderSimple() {
    if(!ui.simple.candidates.length)return;
    renderSimpleTickets();
  }
  function simpleNumbersText() {
    return ui.simple.candidates.map(function(c,i){return (i+1)+'. '+c.main.map(pad2).join(' ')+' + '+c.sub.map(pad2).join(' ');}).join('\n');
  }
  function runSimple() {
    var my=++ui.simple.runId;
    var steps=['读取最近开奖数据…','统计每个号码出现频率…','识别冷号与热号…','检查奇偶 · 三区 · 连号…','和值 · 跨度结构画像…','号码组合交叉验证…','滚动回测对照随机…','生成候选组合 ✓'];
    $('ltSimpleResult').hidden=true;
    $('ltScan').hidden=false;
    setText('ltScanText',steps[0]);
    var draws=currentDraws(), count=ui.simple.count, seed=ui.simple.seed;
    var analysis=analyze(draws,ui.game,60);
    var candidates=generateCandidates(draws,ui.game,{analysis:analysis,count:count,mode:'statistical',seed:seed});
    var bt=backtest(draws,ui.game,{windowSize:60,testCount:30,lines:3});
    ui.simple.analysis=analysis;ui.simple.candidates=candidates;ui.simple.bt=bt;
    var i=0;
    var timer=setInterval(function(){
      if(my!==ui.simple.runId){clearInterval(timer);return;}
      i++;
      if(i>=steps.length){
        clearInterval(timer);
        $('ltScan').hidden=true;
        renderSimpleTickets();
        $('ltSimpleResult').hidden=false;
        setText('ltStatus','分析完成：基于 '+analysis.draws.length+' 期真实开奖，帮你生成了 '+candidates.length+' 注娱乐候选。');
        return;
      }
      setText('ltScanText',steps[i]);
    },185);
  }
  function rerollSimple() {
    ui.simple.seed='竹间-'+Math.random().toString(36).slice(2,8);
    runSimple();
  }
  function setSimpleCount(n) {
    ui.simple.count=n;
    [1,3,5,8].forEach(function(k){var b=$('ltPick'+k);if(b)b.classList.toggle('active',k===n);});
    runSimple();
  }
  function setMode(simple) {
    $('ltSimpleView').hidden=!simple;
    $('ltAdvanceView').hidden=simple;
    var btn=$('ltAdvanceToggle');
    if(simple){btn.textContent='专业数据 ↗';btn.setAttribute('aria-expanded','false');runSimple();}
    else{btn.textContent='← 回到傻瓜模式';btn.setAttribute('aria-expanded','true');renderAll();}
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
  function copySimple(idx) {
    var text;
    if(idx<0){text=simpleNumbersText();}
    else{var c=ui.simple.candidates[idx];text=c?(c.main.map(pad2).join(' ')+' + '+c.sub.map(pad2).join(' ')):'';}
    if(!text){notify('没有可复制的号码。');return;}
    writeClipboard(text,'号码已复制。');
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
    if(!GAMES[game])return;ui.game=game;
    ['ssq','dlt'].forEach(function(k){var b=$('ltGame'+k.charAt(0).toUpperCase()+k.slice(1));if(b){b.classList.toggle('active',k===game);b.setAttribute('aria-selected',k===game?'true':'false');}});
    if(ui.openFlag){if(!$('ltAdvanceView').hidden)renderAll();runSimple();}
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
    bind('ltSimpleGo','click',runSimple);
    bind('ltSimpleReroll','click',rerollSimple);
    bind('ltSimpleCopy','click',function(){copySimple(-1);});
    bind('ltPick1','click',function(){setSimpleCount(1);});
    bind('ltPick3','click',function(){setSimpleCount(3);});
    bind('ltPick5','click',function(){setSimpleCount(5);});
    bind('ltPick8','click',function(){setSimpleCount(8);});
    bind('ltSign','change',rerenderSimple);
    bind('ltZodiac','change',rerenderSimple);
    bind('ltGender','change',rerenderSimple);
    bind('ltSimpleTickets','click',function(e){var t=e.target.closest('.lt-big-copy-one');if(t)copySimple(Number(t.getAttribute('data-idx')));});
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
    GAMES:GAMES,STORAGE_KEY:STORAGE_KEY,
    normalizeDraw:normalizeDraw,normalizeDraws:normalizeDraws,mergeDraws:mergeDraws,parseImport:parseImport,
    analyze:analyze,generateCandidates:generateCandidates,backtest:backtest,
    buildReport:buildReport,buildAiPrompt:buildAiPrompt,
    chiSquareP:chiSquareP,combination:combination,hypergeometric:hypergeometric,
    structureOf:structureOf,rngFrom:rngFrom,
    init:init,open:open,close:close,
    _ui:ui
  };
});
