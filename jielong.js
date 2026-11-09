/* 竹间记 · 接龙
 * 把微信群接龙文本拆成结构化订单：分楼栋、配泡沫箱、算金额、合成送达凭证。
 * v15.3：以 AI 为主拆单（认规格、认总价/单价、按名字补楼栋、给装箱建议）；
 *        本地规则负责兜底与守恒校验——AI 说怎么装，件数对不对由本地算。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JieLong = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  /* ==================== 1. 常量 ==================== */

  // 商品词表：长短混排，匹配前统一按长度降序（保证「红烧肉包」不被拆成「红烧」+「肉包」）
  var ITEM_WORDS = [
    '红枣枸杞豆浆', '红枣豆浆', '枸杞豆浆', '黑豆浆', '五谷豆浆', '原味豆浆', '甜豆浆', '咸豆浆', '黄豆浆', '豆浆',
    '玉米汁', '南瓜汁', '紫薯汁', '花生浆', '核桃浆', '米浆', '绿豆沙', '红豆沙', '绿豆汤', '银耳汤',
    '皮蛋瘦肉粥', '瘦肉粥', '皮蛋粥', '小米粥', '八宝粥', '南瓜粥', '黑米粥', '红枣粥', '白粥', '粥',
    '红烧肉包', '酱肉包', '麻辣牛肉包', '牛肉包', '鲜肉包', '豆沙包', '奶黄包', '叉烧包',
    '香菇竹笋包', '竹笋包', '豇豆包', '豆腐包', '菜角', '菜包', '肉包', '小笼包', '灌汤包', '包子',
    '白水蛋', '白鸡蛋', '白蛋', '茶叶蛋', '水煮蛋', '卤蛋', '煎蛋', '鸡蛋',
    '玉米蒸饺', '玉米饺', '蒸饺', '水饺', '烧麦', '烧卖', '云吞', '馄饨',
    '油条', '麻团', '糖糕', '糍粑', '煎饼', '手抓饼', '鸡蛋饼', '葱油饼', '烧饼',
    '饭团', '糯米鸡', '肠粉', '粽子', '发糕', '马拉糕', '蛋挞', '三明治', '寿司',
    '白馒头', '红糖馒头', '馒头', '花卷', '面包', '蛋糕',
    '红薯', '紫薯', '玉米', '南瓜', '山药', '芋头',
    '牛奶', '酸奶', '豆奶', '咖啡', '奶茶'
  ];

  var ITEM_SORTED = ITEM_WORDS.slice().sort(function (a, b) { return b.length - a.length; });

  var DEFAULT_CAP = 16;      // 每个泡沫箱默认装多少件
  var MAX_BOXES = 3;         // 最多三个箱子
  var PRICE_KEY = 'bamboo.v11.jielong.price';
  var SETTINGS_KEY = 'bamboo.v11.jielong.settings';

  var UNIT_CHARS = '杯份个瓶袋根只盒碗笼屉张块条颗串支片斤';
  var CN_NUM = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

  /* ==================== 2. 小工具 ==================== */

  function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function pad2(n) { n = Number(n) || 0; return n < 10 ? '0' + n : String(n); }
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function cnToNum(s) {
    s = String(s || '');
    if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
    if (s.length === 1) return CN_NUM[s] == null ? NaN : CN_NUM[s];
    if (s === '十') return 10;
    var m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
    if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0);
    return NaN;
  }
  function blank(n) { var s = ''; for (var i = 0; i < n; i++) s += ' '; return s; }
  function replaceRange(s, a, b) {
    if (a < 0 || b > s.length || a >= b) return s;
    return s.slice(0, a) + blank(b - a) + s.slice(b);
  }

  // 「3栋 / 三栋 / 3号楼 / 3# / A栋 / G1 / g2-」→ 统一的键
  function normBuilding(raw) {
    var s = trim(raw).replace(/\s+/g, '');
    if (!s) return '';
    s = s.replace(/[-－—.。]+$/, '');                 // G2-. → G2
    if (/^[A-Za-z][0-9]{0,2}$/.test(s)) return s.toUpperCase() + '栋';
    var n = cnToNum(s);
    if (!isNaN(n)) return n + '栋';
    return s + '栋';
  }
  // 楼栋自然排序：数字栋按数字，字母栋按字母（G1 在 G2 前），未写楼栋排最后
  function buildingRank(key) {
    var s = String(key);
    var m = s.match(/^([0-9]+)/);
    if (m) return { g: 0, n: parseInt(m[1], 10), s: s };
    var a = s.match(/^([A-Za-z])([0-9]*)/);
    if (a) {
      return { g: 1, n: a[1].toUpperCase().charCodeAt(0) * 100 + (a[2] ? parseInt(a[2], 10) : 0), s: s };
    }
    return { g: 2, n: 0, s: s };
  }
  function compareBuilding(a, b) {
    var x = buildingRank(a.key), y = buildingRank(b.key);
    if (x.g !== y.g) return x.g - y.g;
    if (x.n !== y.n) return x.n - y.n;
    return x.s < y.s ? -1 : (x.s > y.s ? 1 : 0);
  }

  /* ==================== 3. 解析 ==================== */

  // 去掉微信接龙自带的装饰行
  function cleanLines(text) {
    var raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    var lines = raw.split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i];
      s = s.replace(/^\s*#?接龙\s*$/, '');
      s = s.replace(/^\s*[-—=*_·]{3,}\s*$/, '');
      s = s.replace(/^\s*@?微信接龙.*$/, '');
      s = s.replace(/^\s*点击.*接龙.*$/, '');
      s = s.replace(/\u200b/g, '');
      if (!trim(s)) continue;
      out.push(s);
    }
    return out;
  }

  /* 楼栋：三档优先级
   * ① 带「栋/幢/号楼/座/#」——最可信，且允许「A 栋」中间有空格
   * ② 字母+数字但没写「栋」——G1 / G2-. / g1姗（宿舍楼常见写法）
   * ③ 行首单个字母 + 逗号——「a，😴，一杯…」，只认 A–H，避免把名字首字母当楼栋
   */
  function findBuilding(text) {
    var best = null, m;

    function better(got, rank) {
      if (!best || rank < best.rank ||
        (rank === best.rank && (got.end - got.start) > (best.end - best.start))) {
        got.rank = rank;
        best = got;
      }
    }

    var re1 = /([0-9]{1,3}|[一二三四五六七八九十]{1,3}|[A-Za-z][0-9]{0,2})\s*(号楼|栋|幢|座|#)\s*(?:[0-9]\s*单元)?\s*([0-9]{3,4})?/g;
    while ((m = re1.exec(text)) !== null) {
      better({ raw: m[0], token: m[1], room: m[3] || '', start: m.index, end: m.index + m[0].length }, 0);
    }

    var re2 = /(?:^|[\s，,、；;：:])([A-Za-z][0-9]{1,2})\s*[-－.]?\s*([0-9]{3,4})?/g;
    while ((m = re2.exec(text)) !== null) {
      var cut = m[0].length - m[0].replace(/^[\s，,、；;：:]/, '').length;
      better({ raw: m[0], token: m[1], room: m[2] || '', start: m.index + cut, end: m.index + m[0].length }, 1);
    }

    // ③ 楼栋-房号：5-402 / 3－301（不要碰 G2-. 这种，后面不是 3~4 位数字就不算）
    var re3 = /(?:^|[\s，,、；;：:])([0-9]{1,3})\s*[-－—]\s*([0-9]{3,4})(?![0-9])/g;
    while ((m = re3.exec(text)) !== null) {
      var cut3 = m[0].length - m[0].replace(/^[\s，,、；;：:]/, '').length;
      better({ raw: m[0], token: m[1], room: m[2], start: m.index + cut3, end: m.index + m[0].length }, 1);
    }

    var m3 = text.match(/^\s*([A-Ha-h])\s*[，,、.。\s]/);
    if (m3) {
      var st = m3.index + m3[0].indexOf(m3[1]);
      better({ raw: m3[0], token: m3[1], room: '', start: st, end: st + 1 }, 2);
    }

    if (!best) return null;
    return { key: normBuilding(best.token), room: best.room, raw: best.raw, start: best.start, end: best.end };
  }

  /* 数量：只认紧挨着商品的那一个
   * 前置「一杯 / 两个 / 半笼 / 2杯」，后置「x2 / 2个 / 两份」，或紧贴的裸数字「豆浆2」
   * 关键：裸数字带空格的一律不当数量——「豆浆 3 元」的 3 是钱
   */
  function qtyBefore(s, start) {
    var before = s.slice(0, start);
    var reU = new RegExp('(半|[0-9]{1,2}|[一二两三四五六七八九十])\\s*([' + UNIT_CHARS + '])\\s*$');
    var m = before.match(reU);
    if (m) {
      var q = m[1] === '半' ? 1 : (/^[0-9]+$/.test(m[1]) ? parseInt(m[1], 10) : (cnToNum(m[1]) || 1));
      return { qty: q, len: m[0].length, half: m[1] === '半' };
    }
    m = before.match(/([0-9]{1,2})$/);
    if (m) return { qty: parseInt(m[1], 10), len: m[0].length, bare: true };
    return null;
  }

  function qtyAfter(s, end) {
    var after = s.slice(end);
    var reU = new RegExp('^\\s*(?:[x×X*]\\s*([0-9]{1,2})|([0-9]{1,2})\\s*([' + UNIT_CHARS + '])|([一二两三四五六七八九十])\\s*([' + UNIT_CHARS + ']))');
    var m = after.match(reU);
    if (m) {
      if (m[1]) return { qty: parseInt(m[1], 10), len: m[0].length };
      if (m[2]) return { qty: parseInt(m[2], 10), len: m[0].length };
      if (m[4]) return { qty: cnToNum(m[4]) || 1, len: m[0].length };
    }
    m = after.match(/^([0-9]{1,2})(?![0-9.])/);
    if (m) return { qty: parseInt(m[1], 10), len: m[0].length, bare: true };
    return null;
  }

  /* 把一段拆成「商品 + 数量 + 这一段的钱」
   * 钱的三种写法都收：3 元 / 3块 / ￥3；以及贴着商品的裸数字「红薯2」
   */
  function parseSeg(seg) {
    var money = [];
    var s = String(seg).replace(/(?:[￥¥]\s*)?([0-9]+(?:\.[0-9]+)?)\s*(元|块钱|块|圆)/g, function (m, num, u, off) {
      money.push({ val: parseFloat(num), at: off, len: m.length });
      return blank(m.length);
    });

    var hits = [];
    for (var w = 0; w < ITEM_SORTED.length; w++) {
      var word = ITEM_SORTED[w];
      var from = 0, idx;
      while ((idx = s.indexOf(word, from)) > -1) {
        var end = idx + word.length, clash = false;
        for (var c = 0; c < hits.length; c++) {
          if (idx < hits[c].end && end > hits[c].start) { clash = true; break; }
        }
        if (!clash) hits.push({ name: word, start: idx, end: end });
        from = end;
      }
    }
    hits.sort(function (a, b) { return a.start - b.start; });

    var used = [];
    var items = [];
    for (var h = 0; h < hits.length; h++) {
      var it = hits[h];
      var qb = qtyBefore(s, it.start);
      var qa = qtyAfter(s, it.end);
      var qty = 1, half = false;
      if (qb && !qb.bare) { qty = qb.qty; half = !!qb.half; used.push([it.start - qb.len, it.start]); }
      else if (qa && !qa.bare) { qty = qa.qty; used.push([it.end, it.end + qa.len]); }
      else if (qb && qb.bare) { qty = qb.qty; used.push([it.start - qb.len, it.start]); }
      else if (qa && qa.bare) { qty = qa.qty; used.push([it.end, it.end + qa.len]); }
      if (!(qty > 0 && qty < 100)) qty = 1;
      items.push({ name: it.name, qty: qty, half: half, start: it.start, end: it.end });
    }

    var nums = [];
    var reN = /[0-9]+(?:\.[0-9]+)?/g, mn;
    while ((mn = reN.exec(s)) !== null) {
      var inUse = false;
      for (var u = 0; u < used.length; u++) {
        if (mn.index >= used[u][0] && mn.index < used[u][1]) { inUse = true; break; }
      }
      // 紧跟在字母后面的数字是昵称（y2 / A3），不是钱
      if (mn.index > 0 && /[A-Za-z]/.test(s.charAt(mn.index - 1))) continue;
      if (!inUse) nums.push({ val: parseFloat(mn[0]), at: mn.index, len: mn[0].length });
    }

    var amtCount = money.length + nums.length;
    var amt = money.length ? money[0].val : (nums.length ? nums[0].val : null);

    var out = { items: items, amt: amt, amtCount: amtCount, nums: nums, totalLike: false };

    // 一样东西给一个数 → 这项的小计；几样东西只给一个数 → 这一单多少钱
    if (amt != null && items.length && amtCount < items.length) out.totalLike = true;
    // 「一个红薯2 … 4元」：带元的那个是整单总价，裸数字才是商品价
    if (money.length && nums.length && items.length === 1) out.totalLike = true;
    // 单独一段只有钱，没有商品（「，15 块」）
    if (amt != null && !items.length) out.totalLike = true;

    // 剥商品、数量、金额，剩下的才是名字；名字里的数字（y2、²⁵）要留住
    var rest = s;
    for (var r0 = 0; r0 < items.length; r0++) rest = replaceRange(rest, items[r0].start, items[r0].end);
    for (var r1 = 0; r1 < used.length; r1++) rest = replaceRange(rest, used[r1][0], used[r1][1]);
    for (var r2 = 0; r2 < money.length; r2++) rest = replaceRange(rest, money[r2].at, money[r2].at + money[r2].len);
    for (var r3 = 0; r3 < nums.length; r3++) rest = replaceRange(rest, nums[r3].at, nums[r3].at + nums[r3].len);
    out.rest = rest;
    return out;
  }

  var SEG_SPLIT = /[+＋➕，,、；;]/;

  // 兼容旧接口：只给一段文本，返回商品与剥完的剩余
  function findItems(text) {
    var sg = parseSeg(text);
    return { items: sg.items, rest: sg.rest };
  }

  function segHasItems(line) {
    var parts = String(line).split(SEG_SPLIT);
    for (var i = 0; i < parts.length; i++) {
      if (parseSeg(parts[i]).items.length) return true;
    }
    return false;
  }

  // 备注：括号里的内容
  function findNote(text) {
    var m = text.match(/[（(]([^）)]{1,40})[）)]/);
    if (m) return trim(m[1]);
    m = text.match(/(不要|别放|少放|多加|免)[^，,。；;\s]{1,12}/);
    return m ? trim(m[0]) : '';
  }

  // 名字：把楼栋、商品、数量、金额都剥掉以后，剩下第一个像人名的片段
  // 允许单字（「g1姗」）、字母（「h」「U」）、带数字的昵称（「y2」）、emoji（「😴」）
  function hasEmoji(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x2600 && c <= 0x27BF) return true;
      if (c >= 0xD800 && c <= 0xDBFF) return true;
    }
    return false;
  }

  function findName(text) {
    var s = String(text == null ? '' : text);
    // 单独调用时（比如只给「豆浆 张三」）也要先剥商品词
    for (var w = 0; w < ITEM_SORTED.length; w++) {
      if (s.indexOf(ITEM_SORTED[w]) > -1) s = s.split(ITEM_SORTED[w]).join(' ');
    }
    s = s
      .replace(/[（(][^）)]*[）)]/g, ' ')
      .replace(/[，,、；;：:。.！!？?~～\-—_/\\|+＋➕=＝"'“”‘’\[\]【】]/g, ' ');
    var parts = s.split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      var p = trim(parts[i]);
      if (!p) continue;
      if (/^[0-9.]+$/.test(p)) continue;                       // 房号 / 金额残渣
      if (hasEmoji(p)) return p.slice(0, 8);
      if (/^[A-Za-z0-9]+$/.test(p)) return p.slice(0, 12);      // h / U / y2
      if (/[\u4e00-\u9fa5]/.test(p)) return p.slice(0, 8);
    }
    return '';
  }

  function parseLine(line, idx) {
    var raw = trim(line);
    var text = raw;
    var no = null;
    // 序号必须带分隔符（1. / 1、/ 1) / 1：），否则「3栋301」的 3 会被误认成序号
    var mNo = raw.match(/^\s*([0-9]{1,3})\s*[.、．)）:：]\s*/);
    if (mNo && mNo[0].length < raw.length) {
      no = parseInt(mNo[1], 10);
      text = raw.slice(mNo[0].length);
    }
    if (!trim(text)) text = raw;

    var b = findBuilding(text);
    var work = text;
    if (b) work = text.slice(0, b.start) + ' ' + text.slice(b.end);

    var note = findNote(work);

    var segs = [];
    var restChunks = [];          // 连纯名字段（「😴」）也要留，不然名字会丢
    var parts = work.split(SEG_SPLIT);
    for (var p = 0; p < parts.length; p++) {
      if (!trim(parts[p])) continue;
      var sg = parseSeg(parts[p]);
      restChunks.push(sg.rest);
      if (!sg.items.length && sg.amt == null) continue;
      segs.push(sg);
    }

    // 最后一段的钱，若前面有「写了商品却没写钱」的段，这笔就是整单总价
    var lastPaid = -1;
    for (var q = segs.length - 1; q >= 0; q--) if (segs[q].amt != null) { lastPaid = q; break; }
    if (lastPaid > 0 && segs[lastPaid].items.length) {
      for (var q2 = 0; q2 < lastPaid; q2++) {
        if (segs[q2].items.length && segs[q2].amt == null) { segs[lastPaid].totalLike = true; break; }
      }
    }

    var total = null;
    for (var t = segs.length - 1; t >= 0; t--) {
      if (segs[t].totalLike && segs[t].amt > 0) { total = segs[t].amt; break; }
    }

    var items = [];
    for (var s2 = 0; s2 < segs.length; s2++) {
      var g2 = segs[s2];
      for (var i2 = 0; i2 < g2.items.length; i2++) {
        var one = g2.items[i2];
        var unit = null;
        if (g2.amt != null && g2.items.length === 1 && one.qty > 0) {
          if (!g2.totalLike) {
            unit = round2(g2.amt / one.qty);
          } else if (g2.nums && g2.nums.length === 1) {
            // 「一个豇豆包2 … 4元」：2 是这一样的价，4 是整单总价
            unit = round2(g2.nums[0].val / one.qty);
          }
          if (!(unit > 0 && unit < 1000)) unit = null;
        }
        items.push({ name: one.name, qty: one.qty, unit: unit, fromText: unit != null });
      }
    }

    var restAll = restChunks.join(' ');
    var name = findName(restAll);

    var issues = [];
    var conf = 0;
    if (b) conf += 0.34;
    if (name) conf += 0.28;
    if (items.length) conf += 0.28;
    if (no != null) conf += 0.1;
    if (!b) issues.push('没写楼栋');
    if (!name) issues.push('没看出名字');
    if (!items.length) issues.push('没写商品');

    return {
      no: no == null ? idx + 1 : no,
      raw: raw,
      name: name,
      building: b ? b.key : '',
      room: b ? b.room : '',
      items: items,
      total: total,
      note: note,
      conf: Math.min(1, conf),
      issues: issues,
      manual: false
    };
  }

  /* ---- 主解析 ---- */
  function parseText(text, opts) {
    opts = opts || {};
    var lines = cleanLines(text);
    var orders = [];
    var skipped = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // 纯标题行（没有序号、没有楼栋、没有商品）跳过
      var looksTitle = !/^\s*[0-9]{1,3}\s*[.、．)）:：]/.test(line) &&
        !findBuilding(line) && !segHasItems(line);
      if (looksTitle && orders.length === 0) { skipped.push(line); continue; }
      if (looksTitle && orders.length > 0) { skipped.push(line); continue; }
      var o = parseLine(line, orders.length);
      // 完全没有有效信息的行不要
      if (!o.building && !o.name && !o.items.length) { skipped.push(line); continue; }
      orders.push(o);
    }
    var conf = orders.length ? orders.reduce(function (a, o) { return a + o.conf; }, 0) / orders.length : 0;
    var record = {
      date: opts.date || todayStr(),
      title: opts.title || (skipped[0] || ''),
      orders: orders,
      source: 'local',
      conf: conf,
      skipped: skipped
    };
    return finalize(record, opts);
  }

  // 补齐：分组、金额、装箱
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  // 原文没写楼栋的人，用历史记录里的住处补上
  function fillMissingBuildings(record, residents) {
    if (!residents) return 0;
    var n = 0;
    var orders = record.orders || [];
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      if (o.building || !o.name) continue;
      var hit = residents[o.name];
      if (!hit || !hit.building) continue;
      o.building = hit.building;
      if (!o.room && hit.room) o.room = hit.room;
      o.buildingFrom = 'history';
      n++;
    }
    return n;
  }

  function finalize(record, opts) {
    opts = opts || {};
    var price = opts.price || {};
    var settings = opts.settings || {};
    var orders = record.orders || [];

    for (var z0 = 0; z0 < orders.length; z0++) {
      if (orders[z0].buildingFrom !== 'history') orders[z0].buildingFrom = '';
    }
    if (opts.residents) fillMissingBuildings(record, opts.residents);

    // 金额
    var missing = {};
    var fromTotal = 0;
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      var amount = 0;
      var unknown = false;
      for (var j = 0; j < o.items.length; j++) {
        var it = o.items[j];
        var p = price[it.name];
        var unit = (p && typeof p.unit === 'number') ? p.unit : null;
        if (it.unit != null) unit = it.unit;
        if (unit == null) { unknown = true; } else {
          it.amount = round2(unit * it.qty);
          amount += it.amount;
        }
        it.unit = unit;
        if (unit == null) it.amount = null;
      }

      // 原文写的是「这一单多少钱」：以总价为准，不再逼你逐样填单价
      if (o.total != null && o.total >= 0) {
        o.amount = round2(o.total);
        o.missingPrice = false;
        o.payMode = 'total';
        fromTotal++;
        // 只有一种商品时，能安心反推单价（多商品均摊会算出假价，不做）
        if (o.items.length === 1 && o.items[0].qty > 0) {
          var d = round2(o.total / o.items[0].qty);
          if (o.items[0].unit == null) o.items[0].unit = d;
          o.items[0].amount = round2(o.total);
          if (d > 0 && d < 1000) o.items[0].derivedUnit = d;
        }
      } else {
        o.amount = unknown ? null : round2(amount);
        o.missingPrice = unknown;
        o.payMode = unknown ? '' : 'unit';
        for (var k = 0; k < o.items.length; k++) {
          if (o.items[k].unit == null) missing[o.items[k].name] = true;
        }
      }
    }

    var buildings = groupByBuilding(orders);
    var totals = sumTotals(orders, buildings);
    totals.fromTotal = fromTotal;
    var plan = planBoxes(buildings, {
      cap: Number(settings.cap) || DEFAULT_CAP,
      maxBoxes: Number(settings.maxBoxes) || MAX_BOXES,
      forced: settings.boxMode || 'auto'
    });
    // AI 排的箱：过校验才用，过不了就用本地这套（件数守恒不能破）
    if (opts.aiBoxes) {
      var ai = useAiBoxes(plan, opts.aiBoxes, buildings, plan.cap);
      if (ai) {
        plan = ai;
        plan.ai = true;
      } else {
        plan.aiRejected = true;
      }
    }

    record.buildings = buildings;
    record.totals = totals;
    record.plan = plan;
    record.missingPrice = Object.keys(missing);
    return record;
  }

  /* ==================== 4. 分组与合计 ==================== */

  function cupCount(order) {
    var n = 0;
    var its = (order && order.items) || [];
    for (var i = 0; i < its.length; i++) n += its[i].qty || 0;
    return n;
  }

  function groupByBuilding(orders) {
    var map = {};
    var list = [];
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      var key = o.building || '未写楼栋';
      if (!map[key]) {
        map[key] = { key: key, orders: [], cups: 0, amount: 0, unknown: 0, rooms: [] };
        list.push(map[key]);
      }
      var g = map[key];
      g.orders.push(o);
      g.cups += cupCount(o);
      if (o.amount == null) g.unknown += 1; else g.amount += o.amount;
      if (o.room) g.rooms.push(o.room);
    }
    list.sort(compareBuilding);
    for (var k = 0; k < list.length; k++) {
      list[k].orders.sort(function (a, b) { return a.no - b.no; });
      list[k].rooms.sort();
      list[k].roomSpan = list[k].rooms.length ? (list[k].rooms[0] + (list[k].rooms.length > 1 ? '–' + list[k].rooms[list[k].rooms.length - 1] : '')) : '';
    }
    return list;
  }

  function sumTotals(orders, buildings) {
    var cups = 0, amount = 0, unknown = 0, items = {};
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      cups += cupCount(o);
      if (o.amount == null) unknown += 1; else amount += o.amount;
      for (var j = 0; j < o.items.length; j++) {
        var it = o.items[j];
        if (!items[it.name]) items[it.name] = { name: it.name, qty: 0, amount: 0, unit: it.unit };
        items[it.name].qty += it.qty;
        if (it.amount != null) items[it.name].amount += it.amount;
        if (it.unit != null) items[it.name].unit = it.unit;
      }
    }
    var itemList = Object.keys(items).map(function (k) { return items[k]; })
      .sort(function (a, b) { return b.qty - a.qty; });
    return {
      orders: orders.length,
      buildings: buildings.length,
      cups: cups,
      amount: amount,
      unknownAmount: unknown,
      items: itemList
    };
  }

  /* ==================== 5. 装箱 ==================== */

  /* 三个泡沫箱怎么装：
   * 1. 先把楼栋按杯数从多到少排，用「总装到当前最空的箱子」的方式摊平，尽量不拆楼栋
   * 2. 用几箱由总量决定：装得下 2 箱就不用 3 箱（少搬一趟）
   * 3. 任何一箱超过容量上限，就把它单列出来提示「这箱会压到杯口」
   * 4. 超过 3 箱装不下的部分，标「单独保温」
   */
  function planBoxes(buildings, opts) {
    opts = opts || {};
    var cap = opts.cap > 0 ? opts.cap : DEFAULT_CAP;
    var maxBoxes = opts.maxBoxes > 0 ? opts.maxBoxes : MAX_BOXES;
    var list = (buildings || []).filter(function (b) { return b.cups > 0; });
    var total = list.reduce(function (a, b) { return a + b.cups; }, 0);

    var need = total === 0 ? 0 : Math.ceil(total / cap);
    var mode = Math.min(maxBoxes, Math.max(need, total > 0 ? 1 : 0));
    var forced = Number(opts.forced) || 0;   // 设置里存的是字符串 '2' / '3'
    if (forced >= 1 && forced <= maxBoxes) mode = forced;
    if (mode === 0) {
      return { mode: 0, cap: cap, total: 0, boxes: [], overflow: [], reason: '这一单还没有杯数，先确认商品和数量。' };
    }

    var slots = [];
    for (var i = 0; i < mode; i++) slots.push({ idx: i + 1, cups: 0, buildings: [], orders: [] });

    var sorted = list.slice().sort(function (a, b) { return b.cups - a.cups || compareBuilding(a, b); });
    var overflow = [];

    // 用户明说要 2 箱 / 3 箱：那就按目标容量摊平，箱子都别空着
    if (forced >= 1) {
      var target = Math.min(cap, Math.ceil(total / mode));
      for (var f = 0; f < sorted.length; f++) {
        var bf = sorted[f];
        var left = bf.cups;
        var guard2 = 0;
        while (left > 0 && guard2++ < 24) {
          var pick = null;
          for (var a1 = 0; a1 < slots.length; a1++) {
            if (slots[a1].cups < target && (!pick || slots[a1].cups < pick.cups)) pick = slots[a1];
          }
          if (!pick) {
            for (var a2 = 0; a2 < slots.length; a2++) {
              if (slots[a2].cups < cap && (!pick || slots[a2].cups < pick.cups)) pick = slots[a2];
            }
          }
          if (!pick) { overflow.push({ key: bf.key, cups: left }); break; }
          var put2 = Math.min(target - pick.cups, cap - pick.cups, left);
          if (put2 <= 0) { overflow.push({ key: bf.key, cups: left }); break; }
          pick.cups += put2;
          var tag = (put2 === bf.cups) ? bf.key : (bf.key + '（' + put2 + ' 件）');
          if (pick.buildings.indexOf(bf.key) < 0) pick.buildings.push(tag);
          left -= put2;
        }
      }
    } else {

    for (var s = 0; s < sorted.length; s++) {
      var b = sorted[s];
      var remain = b.cups;

      // 第一轮：能整栋塞进某个箱子，就整栋放（送的时候一箱对应几栋，不用翻）
      var whole = null;
      for (var t0 = 0; t0 < slots.length; t0++) {
        if (cap - slots[t0].cups >= remain) {
          if (!whole || slots[t0].cups < whole.cups) whole = slots[t0];
        }
      }
      if (whole) {
        whole.cups += remain;
        whole.buildings.push(b.key);
        whole.orders = whole.orders.concat(b.orders);
        continue;
      }

      // 第二轮：整栋放不下，就拆开按「最空的箱先填」摊平，保证一杯不丢
      var guard = 0;
      while (remain > 0 && guard++ < 12) {
        var target = null;
        for (var t1 = 0; t1 < slots.length; t1++) {
          if (cap - slots[t1].cups <= 0) continue;
          if (!target || slots[t1].cups < target.cups) target = slots[t1];
        }
        if (!target) { overflow.push({ key: b.key, cups: remain }); remain = 0; break; }
        var put = Math.min(cap - target.cups, remain);
        target.cups += put;
        var partKey = b.key + '（' + put + ' 件）';
        if (target.buildings.indexOf(b.key) < 0 && target.buildings.indexOf(partKey) < 0) {
          target.buildings.push(partKey);
        }
        remain -= put;
      }
    }
    }

    // 收尾：把空箱去掉，重新编号
    var boxes = slots.filter(function (x) { return x.cups > 0; });
    boxes.sort(function (a, b) { return b.cups - a.cups; });
    for (var q = 0; q < boxes.length; q++) {
      boxes[q].idx = q + 1;
      boxes[q].rooms = boxes[q].orders.map(function (o) { return o.room || ''; }).filter(Boolean).sort();
      boxes[q].buildings.sort(function (a, b) {
        var ka = a.replace(/（[^）]*）/g, ''), kb = b.replace(/（[^）]*）/g, '');
        var ra = buildingRank(ka), rb = buildingRank(kb);
        if (ra.g !== rb.g) return ra.g - rb.g;
        return ra.n - rb.n;
      });
      boxes[q].fill = Math.round(boxes[q].cups / cap * 100);
    }

    var reason = [];
    if (total <= cap) reason.push('一箱就够（' + total + ' / ' + cap + ' 杯），另一箱空着不用带。');
    else if (boxes.length === 2) reason.push('两箱刚好装下（' + total + ' 杯，每箱上限 ' + cap + ' 杯），第三箱不用带。');
    else reason.push('三箱都带上：' + total + ' 杯，平均每箱 ' + Math.ceil(total / boxes.length) + ' 杯。');
    if (overflow.length) {
      reason.push(overflow.map(function (x) { return x.key + ' 多出的 ' + x.cups + ' 杯'; }).join('、') + ' 装不进去，单独保温袋拎着。');
    }
    if (boxes.some(function (x) { return x.fill >= 95; })) {
      reason.push('接近满的箱子别再往上叠，杯盖会压开。');
    }
    var thin = boxes.filter(function (x) { return x.fill < 40; });
    if (thin.length) {
      reason.push(thin.map(function (x) { return '箱 ' + x.idx; }).join('、') +
        ' 只有 ' + thin.reduce(function (a, x) { return a + x.cups; }, 0) +
        ' 件，可以直接换手提袋，把箱子省下来。');
    }

    return { mode: boxes.length, cap: cap, total: total, boxes: boxes, overflow: overflow, reason: reason.join('') };
  }

  /* AI 给的箱子方案：AI 决定「先装哪几栋、怎么顺路」，本地负责按容量切箱。
   * 这样一栋 21 件、箱子只装得下 16 件时，AI 的方案照样能用——从中间切开，一杯不丢。
   * 楼栋漏了、重了、超过三个箱子，整份作废回落到本地算法。
   */
  function useAiBoxes(base, suggestion, buildings, cap) {
    if (Array.isArray(suggestion)) suggestion = { boxes: suggestion };   // 兼容只存了箱子数组的旧数据
    if (!suggestion || !Array.isArray(suggestion.boxes) || !suggestion.boxes.length) return null;
    if (!base || !base.mode) return null;

    var map = {};
    for (var i = 0; i < buildings.length; i++) {
      if (buildings[i].cups > 0) map[buildings[i].key] = buildings[i];
    }

    var seen = {}, seq = [];
    for (var s = 0; s < suggestion.boxes.length; s++) {
      var one = suggestion.boxes[s] || {};
      var ks = Array.isArray(one.buildings) ? one.buildings : [];
      var why = trim(one.why);
      for (var j = 0; j < ks.length; j++) {
        var fb = findBuilding(String(ks[j]));
        var k = fb && map[fb.key] ? fb.key : null;
        if (!k || seen[k]) return null;
        seen[k] = 1;
        var bl = map[k];
        for (var q = 0; q < bl.orders.length; q++) seq.push({ key: k, order: bl.orders[q], why: why });
      }
    }
    var keysAll = Object.keys(map);
    for (var a = 0; a < keysAll.length; a++) if (!seen[keysAll[a]]) return null;
    if (!seq.length) return null;

    var boxes = [];
    var cur = null;
    function openBox(why) {
      cur = { cups: 0, orders: [], buildings: [], parts: {}, why: why || '' };
      boxes.push(cur);
    }
    openBox(seq[0].why);
    for (var t = 0; t < seq.length; t++) {
      var it = seq[t];
      var n = cupCount(it.order);
      if (cur.cups > 0 && cur.cups + n > cap) openBox(it.why);
      cur.cups += n;
      cur.orders.push(it.order);
      cur.parts[it.key] = (cur.parts[it.key] || 0) + n;
      if (cur.buildings.indexOf(it.key) < 0) cur.buildings.push(it.key);
    }

    boxes = boxes.filter(function (x) { return x.cups > 0; });
    if (!boxes.length || boxes.length > MAX_BOXES) return null;
    var sum = boxes.reduce(function (x, b) { return x + b.cups; }, 0);
    if (sum !== base.total) return null;

    // 同一句理由被拆到两箱时只留第一箱的，免得两箱写一样的话
    var usedWhy = {};

    for (var z = 0; z < boxes.length; z++) {
      if (boxes[z].why) {
        if (usedWhy[boxes[z].why]) boxes[z].why = '';
        else usedWhy[boxes[z].why] = 1;
      }
      boxes[z].idx = z + 1;
      boxes[z].rooms = boxes[z].orders.map(function (o) { return o.room || ''; }).filter(Boolean).sort();
      boxes[z].fill = Math.round(boxes[z].cups / cap * 100);
      boxes[z].buildings.sort(function (p1, p2) {
        var ra = buildingRank(p1), rb = buildingRank(p2);
        if (ra.g !== rb.g) return ra.g - rb.g;
        return ra.n - rb.n;
      });
    }

    var advice = trim(suggestion.advice);
    var reason = 'AI 按楼栋和送餐动线排的：' + (advice || ('每箱装 ' + Math.ceil(base.total / boxes.length) + ' 件左右，一栋尽量不拆开'));
    return { mode: boxes.length, cap: cap, total: base.total, boxes: boxes, overflow: [], reason: reason, advice: advice };
  }

  /* 送餐卡：一栋一张，按楼层排好，一路送下去不用来回跑 */
  function deliveryCards(buildings, opts) {
    opts = opts || {};
    var desc = opts.floorOrder !== 'asc'; // 默认先高后低：电梯上去，一层层下来
    var cards = [];
    for (var i = 0; i < buildings.length; i++) {
      var b = buildings[i];
      var rows = b.orders.slice().sort(function (x, y) {
        var rx = parseInt(x.room, 10), ry = parseInt(y.room, 10);
        if (isNaN(rx)) rx = 0;
        if (isNaN(ry)) ry = 0;
        if (rx !== ry) return desc ? ry - rx : rx - ry;
        return x.no - y.no;
      });
      var floors = {};
      for (var j = 0; j < rows.length; j++) {
        var r = rows[j].room;
        var fl = r && r.length >= 3 ? parseInt(r.slice(0, r.length - 2), 10) : 0;
        if (!isNaN(fl) && fl > 0) floors[fl] = (floors[fl] || 0) + 1;
      }
      cards.push({
        key: b.key, cups: b.cups, orders: rows.length, amount: b.amount,
        rows: rows, floors: Object.keys(floors).map(Number).sort(function (a, b2) { return desc ? b2 - a : a - b2; })
      });
    }
    return cards;
  }

  /* ==================== 6. 价格本 ==================== */

  function readPrice() {
    try {
      if (!root || !root.localStorage) return {};
      var raw = root.localStorage.getItem(PRICE_KEY);
      if (!raw) return {};
      var o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }
  function writePrice(book) {
    try {
      if (!root || !root.localStorage) return false;
      root.localStorage.setItem(PRICE_KEY, JSON.stringify(book)); return true;
    } catch (e) { return false; }
  }
  function setPrice(name, unit, from) {
    var book = readPrice();
    var n = Number(unit);
    if (!name || !(n >= 0)) return book;
    book[name] = { unit: n, from: from || 'manual', at: todayStr() };
    writePrice(book);
    return book;
  }
  // 从过往接龙里学单价：同一个商品，取最近一次定过的价
  // 手动在价格本里填的优先（readPrice 覆盖 history）
  // v15.3：这一单只写了「总价 38」也能学——单商品时用 38 ÷ 件数 反推单价
  function learnedPrices(listFn) {
    var rows = typeof listFn === 'function' ? listFn() : [];
    var book = {};
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i].data;
      if (!d || !d.orders) continue;
      for (var j = 0; j < d.orders.length; j++) {
        var o = d.orders[j];
        var its = o.items || [];
        for (var k = 0; k < its.length; k++) {
          var it = its[k];
          if (!it || book[it.name]) continue;
          var u = it.unit;
          if (u == null && it.derivedUnit != null) u = it.derivedUnit;
          if (u == null && o.total != null && its.length === 1 && it.qty > 0) {
            u = round2(o.total / it.qty);
          }
          if (u != null && u >= 0 && u < 1000) {
            book[it.name] = { unit: u, from: 'history', at: rows[i].date || '' };
          }
        }
      }
    }
    return book;
  }

  /* 住户簿：名字 → 常住的楼栋房号。
   * 有人接龙忘写楼栋，就靠这个按名字补——次数多的楼栋优先，房号取最近一次。
   */
  function residentBook(listFn) {
    var rows = typeof listFn === 'function' ? listFn() : [];
    var tmp = {};
    for (var i = rows.length - 1; i >= 0; i--) {   // 从旧到新扫，新的覆盖旧的
      var d = rows[i].data;
      if (!d || !d.orders) continue;
      for (var j = 0; j < d.orders.length; j++) {
        var o = d.orders[j];
        var nm = trim(o.name);
        if (!nm || !o.building) continue;
        if (!tmp[nm]) tmp[nm] = { name: nm, count: {}, room: '', at: '' };
        var t = tmp[nm];
        t.count[o.building] = (t.count[o.building] || 0) + 1;
        if (o.room) t.room = o.room;
        t.at = rows[i].date || t.at;
      }
    }
    var out = {};
    var names = Object.keys(tmp);
    for (var n = 0; n < names.length; n++) {
      var r = tmp[names[n]];
      var best = '', bc = 0;
      var ks = Object.keys(r.count);
      for (var k = 0; k < ks.length; k++) {
        if (r.count[ks[k]] >= bc) { bc = r.count[ks[k]]; best = ks[k]; }
      }
      out[names[n]] = { building: best, room: r.room, hits: bc, at: r.at };
    }
    return out;
  }

  // 给 AI 看的住户名单，只保留常出现的，别把 prompt 撑爆
  function residentsText(book) {
    var list = [];
    var names = Object.keys(book || {});
    for (var i = 0; i < names.length; i++) {
      var r = book[names[i]];
      if (!r || !r.building) continue;
      list.push({ name: names[i], building: r.building, room: r.room || '', hits: r.hits || 1 });
    }
    list.sort(function (a, b) { return b.hits - a.hits; });
    var out = [];
    for (var j = 0; j < list.length && j < 80; j++) {
      out.push(list[j].name + '→' + list[j].building + (list[j].room ? list[j].room : ''));
    }
    return out.join('；');
  }

  function effectivePrice(listFn) {
    var hist = learnedPrices(listFn);
    var own = readPrice();
    var out = {};
    var k;
    for (k in hist) { if (hist.hasOwnProperty(k)) out[k] = hist[k]; }
    for (k in own) { if (own.hasOwnProperty(k)) out[k] = own[k]; }
    return out;
  }

  function readSettings() {
    try {
      if (!root || !root.localStorage) return {};
      var raw = root.localStorage.getItem(SETTINGS_KEY);
      if (!raw) return {};
      var o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }
  function writeSettings(s) {
    try {
      if (!root || !root.localStorage) return false;
      root.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); return true;
    } catch (e) { return false; }
  }

  /* ==================== 7. AI 兜底 ==================== */

  function buildPrompt(text, residents) {
    var res = '';
    if (typeof residents === 'string') res = residents;
    else if (residents && typeof residents === 'object') res = residentsText(residents);

    return '你是早餐接龙的拆单助手。下面是一条微信群接龙原文，请拆成结构化订单。\n\n' +
      (res ? '【这群人的历史住处】（原文没写楼栋时按名字查这里补，buildingFrom 填 "history"；原文写了就填 "text"，不要改）\n' + res + '\n\n' : '') +
      '【原文】\n' + String(text).slice(0, 6000) + '\n\n' +
      '【输出格式】只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。\n' +
      '{"title":"","orders":[{"no":1,"name":"张三","building":"3栋","room":"301","buildingFrom":"text","items":[{"name":"豆浆","qty":2,"unit":5}],"total":null,"note":""}]}\n\n' +
      '【金额：末尾的数字要分清是哪种，这是最容易错的地方】\n' +
      '1.「张三 豆浆2杯 10元」——10 是这一单的总价 → total:10，items 里的 unit 留空。\n' +
      '2.「豆浆 5元/杯」「豆浆5元」且这一行只有这一样——5 是单价 → items[0].unit:5，total 留空。\n' +
      '3.「豆浆2」——2 是数量不是钱 → qty:2，unit 和 total 都留空。\n' +
      '4. 一行里两样以上商品、末尾只给一个数 → 当总价填 total，不要硬摊成单价。\n' +
      '5. 完全没写钱的，unit 和 total 都留空，绝对不要猜价格。\n\n' +
      '【其它硬性要求】\n' +
      '6. no 是接龙里的序号；没有就按顺序从 1 编。\n' +
      '7. building 统一写成「3栋」「12栋」「A栋」这种形式。原文没写、历史住处里也没有，就填空字符串。\n' +
      '8. items 的 name 只用原文出现过的商品，不要编造；「豆浆玉米汁各一」要拆成两条，各 qty 1。\n' +
      '9. qty 必须是 1–99 的整数；「两份」填 2，没写数量填 1。\n' +
      '10. 不是订单的行（#接龙、日期、说明、接龙格式提示）不要进 orders。\n' +
      '11. 不要改人名，也不要把两个人合并成一条。\n';
  }

  function parseAiPayload(text, opts) {
    opts = opts || {};
    var s = String(text || '').replace(/^\uFEFF/, '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return { ok: false, error: '模型没有返回 JSON' };
    var obj;
    try { obj = JSON.parse(s.slice(a, b + 1)); }
    catch (e) {
      // 容错：去掉尾逗号、中文引号
      var fixed = s.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"');
      try { obj = JSON.parse(fixed); } catch (e2) { return { ok: false, error: 'JSON 解析失败' }; }
    }
    if (!obj || !Array.isArray(obj.orders)) return { ok: false, error: '缺少 orders 数组' };
    var out = [];
    for (var i = 0; i < obj.orders.length; i++) {
      var o = obj.orders[i];
      if (!o || typeof o !== 'object') continue;
      var name = trim(o.name);
      var bd = trim(o.building);
      var items = [];
      if (Array.isArray(o.items)) {
        for (var j = 0; j < o.items.length; j++) {
          var it = o.items[j];
          if (!it || typeof it !== 'object') continue;
          var nm = trim(it.name);
          var q = parseInt(it.qty, 10);
          if (!nm) continue;
          if (!(q > 0 && q < 100)) q = 1;
          var u = parseFloat(it.unit);
          if (!(u >= 0 && u < 1000)) u = null;
          items.push({ name: nm, qty: q, unit: u, fromText: u != null });
        }
      }
      var total = parseFloat(o.total);
      if (!(total >= 0 && total < 100000)) total = null;
      if (!name && !items.length && !bd) continue;
      out.push({
        no: parseInt(o.no, 10) || (out.length + 1),
        raw: trim(o.raw) || '',
        name: name,
        building: bd ? normBuilding(bd.replace(/(栋|幢|号楼|座|#)$/, ''), '') : '',
        room: trim(o.room),
        buildingFrom: trim(o.buildingFrom) === 'history' ? 'history' : '',
        items: items,
        total: total,
        note: trim(o.note),
        conf: 0.9,
        issues: [],
        manual: false
      });
    }
    if (!out.length) return { ok: false, error: '一条订单都没识别出来' };
    var rec = finalize({
      date: opts.date || todayStr(),
      title: trim(obj.title) || '',
      orders: out,
      source: 'ai',
      conf: 0.9
    }, opts);
    if (obj.boxes && Array.isArray(obj.boxes)) rec.boxAi = obj.boxes;
    return { ok: true, record: rec };
  }

  /* 让 AI 看着这一单排箱：只回「哪几栋放一箱、为什么」，件数本地自己算 */
  function buildBoxPrompt(record, cap) {
    var b = record.buildings || [];
    var lines = [];
    for (var i = 0; i < b.length; i++) {
      var rooms = b[i].orders.map(function (o) { return o.room || '?'; }).join(' ');
      lines.push(b[i].key + '：' + b[i].cups + ' 件，' + b[i].orders.length + ' 单，房号 ' + (rooms || '—'));
    }
    return '你是早餐配送的装箱助手。我骑电动车送学校，有 3 个泡沫箱，每箱最多装 ' + cap + ' 件杯装（豆浆、玉米汁，容易洒）。\n\n' +
      '这一单的楼栋：\n' + lines.join('\n') + '\n合计 ' + record.totals.cups + ' 件。\n\n' +
      '【怎么排更合理】\n' +
      '1. 尽量让一栋的货在同一箱，送到一栋只开一个箱子。\n' +
      '2. 3 个箱子够装就别硬用 3 个；装不下才用 3 个。\n' +
      '3. 相邻楼栋、件数少的可以合并到一箱。\n' +
      '4. 每箱不能超过 ' + cap + ' 件，所有楼栋都必须出现且只出现一次。\n\n' +
      '【输出】只输出 JSON，不要解释：\n' +
      '{"boxes":[{"buildings":["3栋","12栋"],"why":"这两栋挨着，一共 9 件"}],"advice":"两句话说明为什么这么装"}\n';
  }

  function parseBoxPayload(text, opts) {
    var s = String(text || '').replace(/^\uFEFF/, '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    var obj = null;
    try { obj = JSON.parse(s.slice(a, b + 1)); }
    catch (e) {
      try { obj = JSON.parse(s.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"')); } catch (e2) { return null; }
    }
    if (!obj || !Array.isArray(obj.boxes)) return null;
    return { boxes: obj.boxes, advice: trim(obj.advice) };
  }

  /* ==================== 8. 文本回写（存进笔记用） ==================== */

  var MARK = '⟨JL⟩';

  function encodeNote(record) {
    var plain = toPlainText(record);
    var data = {
      v: 1,
      id: record.id || '',
      date: record.date,
      title: record.title || '',
      source: record.source || 'local',
      orders: record.orders.map(function (o) {
        return {
          no: o.no, name: o.name, building: o.building, room: o.room,
          buildingFrom: o.buildingFrom || '',
          items: o.items.map(function (i) { return { name: i.name, qty: i.qty, unit: i.unit, fromText: !!i.fromText }; }),
          total: o.total == null ? null : o.total,
          note: o.note || '', manual: !!o.manual
        };
      }),
      photos: (record.photos || []).map(function (p) {
        return { key: p.key, building: p.building, at: p.at };
      }),
      boxAi: record.boxAi || null
    };
    return plain + '\n' + MARK + JSON.stringify(data);
  }

  function decodeNote(text) {
    var s = String(text == null ? '' : text);
    var i = s.lastIndexOf(MARK);
    if (i < 0) return null;
    var json = s.slice(i + MARK.length);
    try {
      var d = JSON.parse(json);
      if (!d || !Array.isArray(d.orders)) return null;
      return d;
    } catch (e) { return null; }
  }

  function stripMark(text) {
    var s = String(text == null ? '' : text);
    var i = s.lastIndexOf(MARK);
    return i < 0 ? s : s.slice(0, i).replace(/\s+$/, '');
  }

  // 人能读的版本：一栋一段，带序号、房号、商品、金额
  function toPlainText(record) {
    var lines = [];
    var d = record.date || todayStr();
    lines.push('【接龙】' + d + (record.title ? ' · ' + record.title : ''));
    var bs = record.buildings || groupByBuilding(record.orders || []);
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      lines.push('');
      lines.push(b.key + ' · ' + b.orders.length + ' 单 · ' + b.cups + ' 件' + (b.amount ? ' · ¥' + money(b.amount) : ''));
      for (var j = 0; j < b.orders.length; j++) {
        var o = b.orders[j];
        var parts = [];
        for (var k = 0; k < o.items.length; k++) {
          parts.push(o.items[k].name + '×' + o.items[k].qty);
        }
        lines.push('  #' + o.no + ' ' + (o.name || '（无名字）') + (o.room ? ' ' + o.room : '') +
          '　' + (parts.length ? parts.join(' ') : '（没写商品）') +
          (o.amount != null ? '　' + (o.payMode === 'total' ? '总价 ¥' : '¥') + money(o.amount) : '') +
          (o.buildingFrom === 'history' ? '　楼栋按记录补' : '') +
          (o.note ? '　注：' + o.note : ''));
      }
    }
    var t = record.totals;
    if (t) lines.push('', '合计：' + t.orders + ' 单 / ' + t.cups + ' 件 / ¥' + money(t.amount) +
      (t.unknownAmount ? '（' + t.unknownAmount + ' 单未定价）' : ''));
    return lines.join('\n');
  }

  // 金额显示：一单都没定价时不能显示 ¥0，那会被读成"不用付钱"
  function amtLabel(amount, unknownCount) {
    var n = Number(amount) || 0;
    if (unknownCount && n === 0) return '—';
    return '¥' + money(n);
  }

  function money(n) {
    n = Number(n) || 0;
    return (Math.round(n * 100) / 100).toFixed(n % 1 === 0 ? 0 : 2);
  }

  /* ==================== 9. 界面 ==================== */

  var V = {
    view: 'home',     // home | detail | history
    tab: 'bld',       // bld | box | money | proof
    text: '',
    date: '',
    record: null,
    noteId: null,
    photos: [],       // [{key, building, at, url}]
    busy: false,
    boxBusy: false,   // AI 正在排箱
    err: '',
    boxMode: 'auto',
    cap: 0,
    openBld: '',
    proofUrl: '',
    proofBlob: null,
    proofBld: ''
  };
  var D = null;
  var HOST = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function hhmm(d) {
    d = d ? new Date(d) : new Date();
    if (isNaN(d.getTime())) return '';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function mdLabel(dateStr) {
    var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return dateStr || '';
    return parseInt(m[2], 10) + '月' + parseInt(m[3], 10) + '日';
  }

  /* ---------- 小零件 ---------- */

  function kpiRow(t) {
    return '<div class="jl-kpi-row">' +
      '<div class="jl-kpi"><b>' + t.orders + '</b><span>单</span></div>' +
      '<div class="jl-kpi"><b>' + t.buildings + '</b><span>栋</span></div>' +
      '<div class="jl-kpi"><b>' + t.cups + '</b><span>件</span></div>' +
      '<div class="jl-kpi jl-kpi-amt"><b>' + amtLabel(t.amount, t.unknownAmount) + '</b><span>' +
      (t.unknownAmount ? t.unknownAmount + ' 单未定价' : '合计') + '</span></div>' +
      '</div>';
  }

  function tabBar() {
    var tabs = [['bld', '楼栋'], ['box', '装箱'], ['money', '金额'], ['proof', '送达']];
    return '<div class="jl-tabs">' + tabs.map(function (x) {
      return '<button type="button" data-act="tab" data-v="' + x[0] + '"' +
        (V.tab === x[0] ? ' class="on"' : '') + '>' + x[1] +
        (x[0] === 'proof' && V.photos.length ? '<i>' + V.photos.length + '</i>' : '') +
        '</button>';
    }).join('') + '</div>';
  }

  function itemText(o) {
    if (!o.items.length) return '<em class="jl-warn">没写商品</em>';
    return o.items.map(function (i) {
      return '<span class="jl-gi">' + esc(i.name) + '<b>×' + i.qty + '</b></span>';
    }).join('');
  }

  /* ---------- 首页 ---------- */

  function viewHome() {
    var h = '';
    h += '<div class="jl-lead">' +
      '<p>把微信群接龙<b>最后一条</b>整段粘进来。AI 会拆成楼栋、认规格和价钱、配好箱子。</p>' +
      '</div>';

    h += '<div class="jl-paste">' +
      '<textarea id="jlText" placeholder="#接龙&#10;11月9日 早餐&#10;1. 张三 3栋301 豆浆2杯 玉米汁1 共12元&#10;2. 李四 502 豆浆x2（忘写楼栋）"></textarea>' +
      '</div>';

    h += '<div class="jl-row-inline">' +
      '<label class="jl-date"><span>日期</span><input type="date" id="jlDate" value="' +
      esc(V.date || todayStr()) + '"></label>' +
      '</div>';

    var ai = !!(D && D.hasAI());
    h += '<div class="jl-actions">' +
      '<button type="button" class="jl-primary" data-act="' + (ai ? 'parse-ai' : 'parse') + '"' +
      (V.busy ? ' disabled' : '') + '>' +
      (V.busy ? '正在读这一单…' : (ai ? 'AI 识别这一单' : '识别这一单')) + '</button>' +
      (ai ? '<button type="button" class="jl-ghost" data-act="parse"' + (V.busy ? ' disabled' : '') + '>不联网，本地拆</button>' : '') +
      '</div>';

    if (!ai) {
      h += '<p class="jl-hint">还没配 AI，只能按字面拆：规格写得乱、只写「共 12 元」的那种会拆不准。' +
        '到右上角「设置」填接口和密钥就能用 AI。</p>';
    } else {
      h += '<p class="jl-hint">AI 会认「两杯/两份」这类规格，分清末尾是<b>总价</b>还是<b>单价</b>，' +
        '忘写楼栋的按名字从过往记录里补。要等十几秒，正常。</p>';
    }

    var hist = listRecords().slice(0, 3);
    if (hist.length) {
      h += '<div class="jl-sec-title">最近几单</div>';
      h += hist.map(function (r) { return historyCard(r, true); }).join('');
    }
    return h;
  }

  function listRecords() {
    if (!D) return [];
    var notes = D.getNotes() || [];
    var out = [];
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (!n || n.status === 'trash') continue;
      var tg = n.tags || [];
      if (tg.indexOf('接龙') === -1) continue;
      var d = decodeNote(n.text);
      out.push({
        id: n.id,
        text: n.text,
        createdAt: n.createdAt,
        data: d,
        date: d && d.date ? d.date : String(n.createdAt || '').slice(0, 10),
        title: d && d.title ? d.title : ''
      });
    }
    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return String(b.createdAt) < String(a.createdAt) ? -1 : 1;
    });
    return out;
  }

  function recordStats(d) {
    var blds = {}, cups = 0, amount = 0, unknown = 0;
    if (!d) return { blds: [], cups: 0, amount: 0, unknown: 0, orders: 0 };
    var price = effectivePrice(listRecords);
    for (var i = 0; i < d.orders.length; i++) {
      var o = d.orders[i];
      blds[o.building || '未写楼栋'] = 1;
      var sum = 0, miss = false;
      for (var j = 0; j < o.items.length; j++) {
        var it = o.items[j];
        cups += it.qty || 0;
        var u = it.unit != null ? it.unit : (price[it.name] ? price[it.name].unit : null);
        if (u == null) miss = true; else sum += u * it.qty;
      }
      if (miss) unknown++; else amount += sum;
    }
    return { blds: Object.keys(blds), cups: cups, amount: amount, unknown: unknown, orders: d.orders.length };
  }

  function historyCard(r, compact) {
    var st = recordStats(r.data);
    var meta = r.data
      ? (st.blds.length + ' 栋 · ' + st.orders + ' 单 · ' + st.cups + ' 件')
      : '没有结构化数据，点开可重新拆';
    var sub = r.data
      ? (amtLabel(st.amount, st.unknown) + (st.unknown ? ' · ' + st.unknown + ' 单未定价' : ''))
      : '——';
    return '<div class="jl-hist' + (compact ? ' jl-hist-sm' : '') + '" data-act="open" data-id="' + esc(r.id) + '">' +
      '<div class="jl-hist-main">' +
      '<div class="jl-hist-date">' + esc(mdLabel(r.date)) + (r.title ? '<small>' + esc(r.title) + '</small>' : '') + '</div>' +
      '<div class="jl-hist-meta">' + esc(meta) + '</div>' +
      '</div>' +
      '<div class="jl-hist-right"><b>' + esc(sub) + '</b><span>›</span></div>' +
      '</div>';
  }

  /* ---------- 详情 ---------- */

  function viewDetail() {
    var r = V.record;
    if (!r) return '<div class="jl-empty">还没有单子</div>';
    var h = '';
    h += kpiRow(r.totals);
    h += tabBar();
    if (V.tab === 'bld') h += tabBuildings(r);
    else if (V.tab === 'box') h += tabBoxes(r);
    else if (V.tab === 'money') h += tabMoney(r);
    else h += tabProof(r);
    h += '<div class="jl-detail-acts">' +
      '<button type="button" class="jl-ghost" data-act="newone">再拆一单</button>' +
      '<button type="button" class="jl-danger" data-act="removeone">删掉这一单</button>' +
      '</div>';

    h += '<div class="jl-foot-note">' +
      'AI 负责认人和规格、分清总价还是单价、按名字补楼栋、给装箱建议；' +
      '件数和金额的核对始终在这台设备上算，价格本也只存在本机。' +
      '</div>';
    return h;
  }

  function tabBuildings(r) {
    var h = '';
    if (!r.buildings.length) return '<div class="jl-empty">一条订单都没拆出来</div>';

    var missing = r.missingPrice;
    if (missing.length) {
      h += '<div class="jl-alert" data-act="tab" data-v="money">' +
        '<b>' + missing.length + ' 个商品还没定价</b>' +
        '<span>' + esc(missing.join('、')) + ' —— 点这里填单价，填一次就记住</span>' +
        '</div>';
    }

    var noBld = 0, inferred = 0;
    for (var z = 0; z < r.orders.length; z++) {
      if (!r.orders[z].building) noBld++;
      if (r.orders[z].buildingFrom === 'history') inferred++;
    }
    if (inferred) {
      h += '<div class="jl-alert jl-alert-soft">' +
        '<b>' + inferred + ' 条没写楼栋，已按名字补上</b>' +
        '<span>取自他们最近几次接龙的住处，标着「按记录」的就是补的，点开能改</span></div>';
    }
    if (noBld) {
      h += '<div class="jl-alert jl-alert-soft">' +
        '<b>' + noBld + ' 条没写楼栋</b><span>已归到「未写楼栋」，点单条可以补</span></div>';
    }

    for (var i = 0; i < r.buildings.length; i++) {
      var b = r.buildings[i];
      var open = (V.openBld === b.key) || (i === 0 && !V.openBld);
      h += '<div class="jl-bld' + (open ? ' open' : '') + '">' +
        '<button type="button" class="jl-bld-h" data-act="bld" data-k="' + esc(b.key) + '">' +
        '<span class="jl-bld-k">' + esc(b.key) + '</span>' +
        '<span class="jl-bld-m">' + b.orders.length + ' 单 · ' + b.cups + ' 件' +
        (b.roomSpan ? ' · ' + esc(b.roomSpan) : '') + '</span>' +
        '<em>' + (b.amount ? '¥' + money(b.amount) : (b.unknown ? '待定价' : '¥0')) + '</em>' +
        '<i class="jl-caret">' + (open ? '−' : '+') + '</i>' +
        '</button>' +
        (open ? '<div class="jl-rows">' + b.orders.map(orderRow).join('') + '</div>' : '') +
        '</div>';
    }
    h += '<p class="jl-hint">点任何一条能改楼栋、房号、数量和商品；改完金额和装箱会自动重算。</p>';
    return h;
  }

  function orderRow(o) {
    var amt = o.amount == null ? '<em class="jl-warn">待定价</em>'
      : '<em>' + (o.payMode === 'total' ? '总价 ¥' : '¥') + money(o.amount) + '</em>';
    return '<div class="jl-orow" data-act="edit" data-no="' + o.no + '">' +
      '<i class="jl-no">#' + o.no + '</i>' +
      '<b class="jl-name">' + (o.name ? esc(o.name) : '<em class="jl-warn">无名</em>') + '</b>' +
      (o.room ? '<span class="jl-room">' + esc(o.room) + '</span>' : '<span class="jl-room jl-room-x">—</span>') +
      '<span class="jl-goods">' + itemText(o) + (o.note ? '<u>' + esc(o.note) + '</u>' : '') +
      (o.buildingFrom === 'history' ? '<u class="jl-infer">楼栋按记录</u>' : '') + '</span>' +
      amt +
      '</div>';
  }

  function tabBoxes(r) {
    var p = r.plan;
    var h = '';
    h += '<div class="jl-set">' +
      '<label class="jl-cap"><span>每箱最多</span><input type="number" id="jlCap" min="4" max="40" value="' +
      p.cap + '"><span>件</span></label>' +
      '<div class="jl-seg">' +
      ['auto', '2', '3'].map(function (v) {
        var on = (V.boxMode === v) || (v === 'auto' && V.boxMode === 'auto');
        return '<button type="button" data-act="boxmode" data-v="' + v + '"' + (on ? ' class="on"' : '') + '>' +
          (v === 'auto' ? '自动' : v + ' 箱') + '</button>';
      }).join('') +
      '</div></div>';

    if (!p.mode) {
      h += '<div class="jl-empty">还没有件数，先在「楼栋」里补上商品</div>';
      return h;
    }

    if (D && D.hasAI()) {
      h += '<div class="jl-aiwire">' +
        '<div><b>装箱建议' + (p.ai ? ' · AI 排的' : '') + '</b>' +
        '<span>' + (p.ai ? '件数本地核过，一栋尽量不拆' : '按楼栋和送餐动线排，少开箱') + '</span></div>' +
        '<button type="button" data-act="aibox"' + (V.boxBusy ? ' disabled' : '') + '>' +
        (V.boxBusy ? '正在看…' : (p.ai ? '重排' : '让 AI 排')) + '</button>' +
        '</div>';
      if (p.aiRejected) {
        h += '<div class="jl-alert jl-alert-soft"><b>AI 的装法有一栋漏了或超了</b>' +
          '<span>已按本地规则重装，件数不会少</span></div>';
      }
    }

    h += '<div class="jl-boxes">';
    for (var i = 0; i < p.boxes.length; i++) {
      var b = p.boxes[i];
      var fill = b.fill > 100 ? 100 : b.fill;
      h += '<div class="jl-box">' +
        '<div class="jl-box-h"><b>箱 ' + b.idx + '</b><span>' + b.cups + ' 件</span>' +
        '<i class="' + (fill >= 95 ? 'full' : (fill < 50 ? 'thin' : '')) + '">' + b.fill + '%</i></div>' +
        '<div class="jl-box-bar"><i style="width:' + fill + '%"></i></div>' +
        '<div class="jl-box-b">' + b.buildings.map(function (k) {
          var part = b.parts && b.parts[k];
          var tot = 0;
          for (var q2 = 0; q2 < r.buildings.length; q2++) if (r.buildings[q2].key === k) tot = r.buildings[q2].cups;
          var tag = (part && tot && part < tot) ? k + '（' + part + ' 件）' : k;
          return '<span class="jl-chip">' + esc(tag) + '</span>';
        }).join('') + '</div>' +
        (b.why ? '<div class="jl-box-w">' + esc(b.why) + '</div>' : '') +
        (b.orders.length ? '<div class="jl-box-f">' + b.orders.length + ' 单，一栋一栋送</div>' : '') +
        '</div>';
    }
    h += '</div>';

    if (p.overflow.length) {
      var ov = 0;
      for (var q = 0; q < p.overflow.length; q++) ov += p.overflow[q].cups;
      h += '<div class="jl-alert">' +
        '<b>还有 ' + ov + ' 件装不进箱子</b>' +
        '<span>' + p.overflow.map(function (x) { return esc(x.key) + ' ' + x.cups + ' 件'; }).join('、') +
        ' —— 单独保温袋拎着</span></div>';
    }

    h += '<p class="jl-note">' + esc(p.reason) + '</p>';

    h += '<div class="jl-sec-title">一栋一张，照着送</div>';
    var cards = deliveryCards(r.buildings);
    for (var c = 0; c < cards.length; c++) {
      var card = cards[c];
      var peek = card.rows.map(function (o) { return o.room || '—'; }).slice(0, 6).join(' · ');
      if (card.rows.length > 6) peek += ' …';
      h += '<details class="jl-card"' + (c === 0 ? ' open' : '') + '>' +
        '<summary><b>' + esc(card.key) + '</b>' +
        '<span>' + card.orders + ' 单 · ' + card.cups + ' 件</span>' +
        (card.floors.length ? '<i>' + card.floors.length + ' 个楼层</i>' : '') + '</summary>' +
        '<p class="jl-card-peek">' + esc(peek) + '</p>' +
        '<div class="jl-card-b">' + card.rows.map(function (o) {
          return '<div class="jl-crow"><i>#' + o.no + '</i><b>' + (o.room ? esc(o.room) : '—') +
            '</b><span>' + esc(o.name || '') + '</span><em>' + itemText(o) + '</em></div>';
        }).join('') + '</div></details>';
    }
    return h;
  }

  function tabMoney(r) {
    var t = r.totals;
    var h = '';
    h += '<div class="jl-money-top"><span>合计</span><b>' + amtLabel(t.amount, t.unknownAmount) + '</b>' +
      (t.unknownAmount ? '<i>' + t.unknownAmount + ' 单还没定价，没算进来</i>' : '') +
      (t.fromTotal ? '<i>' + t.fromTotal + ' 单按原文总价记，不用逐样填单价</i>' : '') + '</div>';

    h += '<table class="jl-tb"><thead><tr><th>商品</th><th>数量</th><th>单价</th><th>小计</th></tr></thead><tbody>';
    for (var i = 0; i < t.items.length; i++) {
      var it = t.items[i];
      h += '<tr><td>' + esc(it.name) + '</td><td>' + it.qty + '</td>' +
        '<td><input type="number" min="0" step="0.5" class="jl-price" data-name="' + esc(it.name) +
        '" value="' + (it.unit == null ? '' : it.unit) + '" placeholder="填"></td>' +
        '<td>' + (it.unit == null ? '<em class="jl-warn">—</em>' : '¥' + money(it.amount)) + '</td></tr>';
    }
    h += '</tbody><tfoot><tr><td>合计</td><td>' + t.cups + '</td><td></td><td>' +
      amtLabel(t.amount, t.unknownAmount) + '</td></tr></tfoot></table>';

    h += '<p class="jl-hint">单价填一次就存在本机，下一单同样的商品自动带出来。</p>';

    h += '<div class="jl-sec-title">按人核一遍</div>';
    h += '<div class="jl-people">';
    var all = [];
    for (var b = 0; b < r.buildings.length; b++) all = all.concat(r.buildings[b].orders);
    all.sort(function (a, c) {
      var x = a.amount == null ? -1 : a.amount;
      var y = c.amount == null ? -1 : c.amount;
      return x - y;
    });
    for (var k = 0; k < all.length; k++) {
      var o = all[k];
      h += '<div class="jl-prow"><i>#' + o.no + '</i><b>' + esc(o.name || '无名') + '</b>' +
        '<span>' + esc(o.building || '—') + (o.room ? ' ' + esc(o.room) : '') + '</span>' +
        (o.amount == null ? '<em class="jl-warn">待定价</em>'
          : '<em>' + (o.payMode === 'total' ? '总价 ¥' : '¥') + money(o.amount) + '</em>') + '</div>';
    }
    h += '</div>';
    return h;
  }

  function shotCount() {
    var m = {};
    for (var i = 0; i < V.photos.length; i++) {
      var k = V.photos[i].building || '';
      m[k] = (m[k] || 0) + 1;
    }
    return m;
  }

  // 还有哪一栋没拍：拍完一张就自动跳到它
  function nextUnshot() {
    if (!V.record) return '';
    var done = shotCount();
    for (var b = 0; b < V.record.buildings.length; b++) {
      var k = V.record.buildings[b].key;
      if (k === '未写楼栋') continue;
      if (!done[k]) return k;
    }
    return '';
  }

  function tabProof(r) {
    var h = '';
    var blds = (r.buildings || []).filter(function (b) { return b.key !== '未写楼栋'; });
    var cnt = shotCount();

    // 默认站到「还没拍的第一栋」
    if (!V.proofBld || !blds.some(function (b) { return b.key === V.proofBld; })) {
      V.proofBld = nextUnshot() || (blds.length ? blds[0].key : '');
    }

    h += '<div class="jl-pickbar">' +
      '<div class="jl-pickbar-h"><b>这次送哪儿</b>' +
      '<span>' + (blds.length ? '点楼栋选好，再按下面拍照' : '这一单还没有楼栋') + '</span></div>';

    if (blds.length) {
      h += '<div class="jl-picks">' +
        blds.map(function (b) {
          var n = cnt[b.key] || 0;
          var on = b.key === V.proofBld;
          return '<button type="button" class="jl-pick' + (on ? ' on' : '') + (n ? ' done' : '') +
            '" data-act="setbld" data-v="' + esc(b.key) + '">' +
            '<b>' + esc(b.key) + '</b>' +
            '<i>' + (n ? '已拍 ' + n + ' 张' : b.orders.length + ' 单') + '</i>' +
            (n ? '<u>✓</u>' : '') +
            '</button>';
        }).join('') +
        '</div>';
    }
    h += '</div>';

    h += '<div class="jl-shots">';
    for (var i = 0; i < V.photos.length; i++) {
      var p = V.photos[i];
      var un = !p.building;
      h += '<div class="jl-shot' + (un ? ' jl-shot-un' : '') + '" data-act="pickbld" data-k="' + esc(p.key) + '">' +
        '<img src="' + esc(p.url) + '" alt="">' +
        '<span class="jl-shot-tag">' + (un ? '点这里选楼栋'
          : esc(p.building) + (p.at ? '<i>' + hhmm(p.at) + '</i>' : '')) + '</span>' +
        '<button type="button" data-act="delphoto" data-k="' + esc(p.key) + '" aria-label="删除">×</button>' +
        '</div>';
    }
    var whom = V.proofBld ? V.proofBld : '这一栋';
    h += '<label class="jl-shot-add">' +
      '<input type="file" accept="image/*" capture="environment" id="jlShotCam">' +
      '<b>+</b><span>拍照<i>' + esc(whom) + '</i></span></label>' +
      '<label class="jl-shot-add">' +
      '<input type="file" accept="image/*" id="jlShotPick" multiple>' +
      '<b>+</b><span>相册<i>' + esc(whom) + '</i></span></label>';
    h += '</div>';

    var unCount = 0, doneBld = 0;
    for (var u = 0; u < V.photos.length; u++) if (!V.photos[u].building) unCount++;
    for (var d = 0; d < blds.length; d++) if (cnt[blds[d].key]) doneBld++;

    if (V.photos.length) {
      if (blds.length && doneBld === blds.length) {
        h += '<p class="jl-all-done">' + blds.length + ' 栋都拍齐了，可以合成一张发群里。</p>';
      } else if (blds.length) {
        h += '<p class="jl-hint">还差 ' + (blds.length - doneBld) + ' 栋没拍，接着拍就行。</p>';
      }
      h += '<div class="jl-shot-actions">' +
        '<button type="button" class="jl-primary" data-act="compose"' +
        (V.busy || unCount ? ' disabled' : '') + '>' +
        (V.busy ? '正在拼…' : (unCount ? '先给 ' + unCount + ' 张选楼栋' : '合成送达凭证')) + '</button>' +
        '<button type="button" class="jl-ghost" data-act="clearshots">全部重拍</button>' +
        '</div>';
    } else {
      h += '<p class="jl-hint">照片只留在这台设备上，不会上传。拼好的图可以直接长按保存或分享。</p>';
    }

    if (V.proofUrl) {
      h += '<div class="jl-proof">' +
        '<img src="' + esc(V.proofUrl) + '" alt="送达凭证">' +
        '<div class="jl-proof-acts">' +
        '<a class="jl-primary" download="送达凭证-' + esc(r.date || todayStr()) + '.jpg" href="' + esc(V.proofUrl) + '">保存图片</a>' +
        '<button type="button" class="jl-ghost" data-act="shareproof">分享</button>' +
        '</div>' +
        '<p class="jl-hint">长按上面这张图也能直接存进相册。</p>' +
        '</div>';
    }
    return h;
  }

  /* ---------- 历史 ---------- */

  function viewHistory() {
    var rows = listRecords();
    if (!rows.length) {
      return '<div class="jl-empty">还没有存过接龙<br><span>识别完一单会自动存进「接龙」分类</span></div>';
    }
    var byMonth = {}, order = [];
    for (var i = 0; i < rows.length; i++) {
      var m = String(rows[i].date || '').slice(0, 7);
      if (!byMonth[m]) { byMonth[m] = []; order.push(m); }
      byMonth[m].push(rows[i]);
    }
    order.sort().reverse();
    var h = '';
    for (var k = 0; k < order.length; k++) {
      var mm = order[k].split('-');
      h += '<div class="jl-month">' + (mm.length === 2 ? parseInt(mm[0], 10) + ' 年 ' + parseInt(mm[1], 10) + ' 月' : order[k]) +
        '<i>' + byMonth[order[k]].length + ' 单</i></div>';
      for (var j = 0; j < byMonth[order[k]].length; j++) {
        h += historyCard(byMonth[order[k]][j], false);
      }
    }
    h += '<p class="jl-hint">这些记录也在「接龙」分类里，跟笔记一样会同步，能删能改。</p>';
    return h;
  }

  /* ---------- 主渲染 ---------- */

  function paint() {
    if (!HOST) return;
    var title = '接龙', sub = '', back = V.view !== 'home';
    if (V.view === 'detail' && V.record) {
      title = mdLabel(V.record.date);
      sub = V.record.totals.orders + ' 单 · ' + amtLabel(V.record.totals.amount, V.record.totals.unknownAmount);
    } else if (V.view === 'history') {
      title = '接龙记录';
      sub = listRecords().length + ' 单';
    } else {
      sub = '粘一段，拆成楼栋和箱子';
    }

    var body;
    if (V.view === 'home') body = viewHome();
    else if (V.view === 'history') body = viewHistory();
    else body = viewDetail();

    HOST.innerHTML =
      '<div class="jl-top">' +
      (V.view === 'home'
        ? '<button type="button" class="jl-back jl-x" data-act="close" aria-label="关闭">×</button>'
        : '<button type="button" class="jl-back" data-act="back" aria-label="返回">‹</button>') +
      '<div class="jl-head"><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></div>' +
      (V.view === 'detail'
        ? '<button type="button" class="jl-topbtn" data-act="save">保存</button>'
        : (V.view === 'history'
          ? '<button type="button" class="jl-topbtn" data-act="close">关闭</button>'
          : '<button type="button" class="jl-topbtn" data-act="history">记录</button>')) +
      '</div>' +
      '<div class="jl-body">' +
      (V.err ? '<div class="jl-errbar">' + esc(V.err) + '</div>' : '') +
      body + '</div>';

    if (V.view === 'home') {
      var ta = HOST.querySelector('#jlText');
      if (ta) ta.value = V.text || '';
    }
  }

  /* ---------- 动作 ---------- */

  function toast(msg) {
    if (D && D.toast) D.toast(msg);
  }

  function goHome() {
    V.view = 'home';
    V.record = null;
    V.noteId = null;
    V.photos = [];
    V.proofUrl = '';
    V.err = '';
    V.openBld = '';
    paint();
  }

  function currentDate() {
    var el = HOST && HOST.querySelector('#jlDate');
    if (el && el.value) return el.value;
    return V.date || todayStr();
  }

  function applyRecord(rec) {
    V.record = rec;
    V.view = 'detail';
    V.tab = 'bld';
    V.err = '';
    V.proofUrl = '';
    V.openBld = '';
    if (!V.cap) V.cap = rec.plan.cap;
    paint();
  }

  function rebuild() {
    if (!V.record) return;
    var opts = parseOpts();
    opts.aiBoxes = V.record.boxAi;
    V.record = finalize({
      id: V.record.id,
      date: V.record.date,
      title: V.record.title,
      orders: V.record.orders,
      source: V.record.source,
      photos: V.record.photos,
      boxAi: V.record.boxAi
    }, opts);
    paint();
    if (V.view === 'detail' && V.tab === 'proof') updateProofBadge();
  }

  function persist(silent) {
    if (!V.record || !D) return;
    var text = encodeNote(V.record);
    if (V.noteId) {
      D.updateNote(V.noteId, text);
    } else {
      V.noteId = D.addNote(text, ['接龙']);
      V.record.id = V.noteId;
    }
    if (!silent) toast('已存到「接龙」分类');
  }

  // 这一单的解析参数：价格本、箱子设置、以及「谁住哪儿」的历史住户簿
  function parseOpts() {
    var price = effectivePrice(listRecords);
    var settings = readSettings();
    settings.cap = V.cap || settings.cap || DEFAULT_CAP;
    settings.boxMode = V.boxMode === 'auto' ? '' : V.boxMode;
    return { date: V.date, price: price, settings: settings, residents: residentBook(listRecords) };
  }

  // AI 在原文里认出来的单价，记进价格本——下一单同样的商品就不用再问
  function learnPrices(rec) {
    if (!rec || !rec.orders) return;
    for (var i = 0; i < rec.orders.length; i++) {
      var its = rec.orders[i].items || [];
      for (var j = 0; j < its.length; j++) {
        var it = its[j];
        // 只学「原文里写出来的价」或「总价反推的价」，不把历史填进来的价再写回去
        var u = it.fromText ? it.unit : (it.derivedUnit != null ? it.derivedUnit : null);
        if (u == null || !(u > 0 && u < 1000)) continue;
        var own = readPrice();   // 每样重新读，别把这一轮刚学的价再覆盖回去
        if (own[it.name] && own[it.name].from === 'manual') continue;   // 手填的最大，绝不覆盖
        if (own[it.name] && Number(own[it.name].unit) === Number(u)) continue;
        setPrice(it.name, u, 'learned');
      }
    }
  }

  // 拆完顺手让 AI 看一眼怎么装箱（不阻塞，失败就静默用本地方案）
  function kickBoxAI(rec) {
    if (!D || !D.hasAI() || !rec) return;
    V.boxBusy = true;
    if (V.view === 'detail' && V.tab === 'box') paint();
    var token = rec;
    D.askAI(buildBoxPrompt(rec, rec.plan.cap), { maxTokens: 900 }).then(function (out) {
      if (V.record !== token) return;
      V.boxBusy = false;
      var s = parseBoxPayload(out);
      var ai = s ? useAiBoxes(rec.plan, s, rec.buildings, rec.plan.cap) : null;
      if (ai) {
        ai.ai = true;
        rec.plan = ai;
        rec.boxAi = s;
        persist(true);
      } else if (s) {
        rec.plan.aiRejected = true;
      }
      if (V.view === 'detail') paint();
    }).catch(function () {
      V.boxBusy = false;
      if (V.view === 'detail') paint();
    });
  }

  function doParse(useAi) {
    var ta = HOST.querySelector('#jlText');
    var text = ta ? ta.value : V.text;
    if (!text || !trim(text)) { V.err = '先把接龙内容粘进来'; paint(); return; }
    V.text = text;
    V.date = currentDate();
    V.err = '';
    V.busy = true;
    V.tab = 'bld';
    paint();

    var opts = parseOpts();

    var finish = function (rec, src) {
      V.busy = false;
      if (!rec || !rec.orders.length) {
        V.err = '这一单一条都没拆出来，看看是不是粘错了段落';
        paint();
        return;
      }
      V.noteId = null;
      learnPrices(rec);
      applyRecord(rec);
      persist(true);
      var t = rec.orders.length, b = rec.buildings.length;
      toast('拆出 ' + t + ' 单 / ' + b + ' 栋，已存进「接龙」');
      if (src === 'ai') kickBoxAI(rec);
    };

    var localFallback = function (why) {
      var local = null;
      try { local = parseText(text, opts); } catch (e) {}
      if (local && local.orders.length) {
        finish(local, 'local');
        if (why) toast(why);
      } else {
        V.busy = false;
        V.err = 'AI 和本地都没拆出来：' + (why || '格式太乱');
        paint();
      }
    };

    if (!useAi) {
      var rec = null;
      try { rec = parseText(text, opts); } catch (e) { rec = null; }
      setTimeout(function () { finish(rec, 'local'); }, 60);
      return;
    }

    if (!D || !D.hasAI()) { V.busy = false; V.err = '还没配 AI'; paint(); return; }
    D.askAI(buildPrompt(text, opts.residents), { maxTokens: 4000 }).then(function (out) {
      var r = parseAiPayload(out, opts);
      if (r.ok) { finish(r.record, 'ai'); return; }
      localFallback('AI 没拆好（' + r.error + '），已改用本地规则');
    }).catch(function (e) {
      localFallback('AI 调用失败，已用本地规则');
    });
  }

  function openRecord(id) {
    var rows = listRecords();
    var hit = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) hit = rows[i];
    if (!hit) return;
    var data = hit.data;
    V.date = hit.date || V.date;
    var opts = parseOpts();
    opts.aiBoxes = data && data.boxAi ? data.boxAi : null;
    var rec;
    if (data) {
      rec = finalize({
        id: hit.id,
        date: data.date,
        title: data.title,
        orders: data.orders.map(function (o) {
          return {
            no: o.no, name: o.name, building: o.building, room: o.room,
            buildingFrom: o.buildingFrom || '',
            items: (o.items || []).map(function (i2) { return { name: i2.name, qty: i2.qty, unit: i2.unit, fromText: !!i2.fromText }; }),
            total: o.total == null ? null : o.total,
            note: o.note || '', manual: o.manual
          };
        }),
        source: data.source || 'local',
        photos: data.photos || [],
        boxAi: data.boxAi || null
      }, opts);
    } else {
      rec = parseText(stripMark(hit.text), opts);
    }
    V.noteId = hit.id;
    V.cap = rec.plan.cap;
    V.record = rec;
    V.view = 'detail';
    V.tab = 'bld';
    V.err = '';
    V.proofUrl = '';
    V.openBld = '';
    V.photos = [];
    paint();
    loadPhotos(hit.id);
  }

  /* ---------- 照片 ---------- */

  function photoKey(id) { return 'jl:' + id + ':'; }

  function loadPhotos(id) {
    if (!D || !D.listPhotos) return;
    D.listPhotos(photoKey(id)).then(function (arr) {
      var list = [];
      for (var i = 0; i < (arr || []).length; i++) list.push(arr[i]);
      list.sort(function (a, b) { return String(a.at) < String(b.at) ? -1 : 1; });
      V.photos = list;
      if (V.view === 'detail' && V.tab === 'proof') paint();
      else if (V.view === 'detail') updateProofBadge();
    }).catch(function () {});
  }

  function updateProofBadge() {
    if (!HOST) return;
    var btn = HOST.querySelector('[data-act="tab"][data-v="proof"]');
    if (!btn) return;
    var old = btn.querySelector('i');
    if (V.photos.length) {
      if (old) old.textContent = V.photos.length;
      else {
        var i = document.createElement('i');
        i.textContent = V.photos.length;
        btn.appendChild(i);
      }
    } else if (old) old.parentNode.removeChild(old);
  }

  var photoSeq = 0;

  // 存一张：楼栋先按「还没拍过的第一栋」预填，拍歪了点一下就能改
  function addPhoto(file, bld) {
    if (!file || !V.record) return Promise.resolve(false);
    if (!V.noteId) persist(true);
    var id = V.noteId || 'tmp' + Date.now();
    var guess = bld != null ? bld : guessBuilding();
    var ts = Date.now() + (photoSeq++);
    var key = photoKey(id) + ts + ':' + encodeURIComponent(guess || '');
    return D.compressImage(file).then(function (out) {
      return D.putPhoto(key, out.blob).then(function () {
        V.photos.push({
          key: key,
          building: guess,
          at: new Date(ts).toISOString(),
          url: URL.createObjectURL(out.blob)
        });
        return true;
      });
    });
  }

  // 一次可以来多张（相册多选）
  function addPhotos(files, bld) {
    var list = [];
    for (var i = 0; i < (files || []).length; i++) list.push(files[i]);
    if (!list.length || !V.record) return;
    V.busy = true;
    V.tab = 'proof';
    V.err = '';
    paint();
    var added = 0;
    var chain = Promise.resolve();
    list.forEach(function (f) {
      chain = chain.then(function () {
        return addPhoto(f, bld).then(function (ok) { if (ok) added++; });
      }).catch(function () {});
    });
    chain.then(function () {
      V.busy = false;
      if (added) dropProof();
      // 这一栋拍完，自动站到下一栋
      V.proofBld = nextUnshot() || V.proofBld;
      paint();
      if (added) {
        persist(true);
        toast('已加上 ' + added + ' 张，点照片能改楼栋');
      } else {
        V.err = '这几张没存进去，换个格式再试';
        paint();
      }
    });
  }

  // 这一张属于哪一栋：还没拍过的第一栋（「未写楼栋」那种不算一栋）
  function guessBuilding() {
    if (!V.record) return '';
    var done = {};
    for (var i = 0; i < V.photos.length; i++) done[V.photos[i].building] = 1;
    for (var b = 0; b < V.record.buildings.length; b++) {
      var k = V.record.buildings[b].key;
      if (k === '未写楼栋') continue;
      if (!done[k]) return k;
    }
    return '';
  }

  // 给一张照片换楼栋：IndexedDB 的 key 里就带着楼栋，所以要换个 key 重存
  function setPhotoBuilding(key, bld) {
    var p = null;
    for (var i = 0; i < V.photos.length; i++) if (V.photos[i].key === key) p = V.photos[i];
    if (!p) return;
    var seg = String(key).split(':');
    var newKey = seg.slice(0, 3).join(':') + ':' + encodeURIComponent(bld || '');
    V.busy = true;
    paint();
    D.getPhoto(key).then(function (blob) {
      if (!blob) throw new Error('照片读不出来');
      return D.putPhoto(newKey, blob).then(function () {
        return D.delPhoto(key);
      }).then(function () {
        try { URL.revokeObjectURL(p.url); } catch (e) {}
        p.key = newKey;
        p.building = bld || '';
        p.url = URL.createObjectURL(blob);
        V.photos = V.photos.slice();
        V.busy = false;
        dropProof();
        paint();
        persist(true);
        toast(bld ? '标成 ' + bld : '已清掉楼栋标注');
      });
    }).catch(function (e) {
      V.busy = false;
      V.err = '改不了这张的楼栋：' + (e && e.message ? e.message : '未知');
      paint();
    });
  }

  function delPhoto(key) {
    if (D && D.delPhoto) D.delPhoto(key).catch(function () {});
    var keep = [];
    for (var i = 0; i < V.photos.length; i++) {
      if (V.photos[i].key === key) {
        try { URL.revokeObjectURL(V.photos[i].url); } catch (e) {}
      } else keep.push(V.photos[i]);
    }
    V.photos = keep;
    dropProof();
    paint();
  }

  // 照片一变，之前拼的图就不作数了
  function dropProof() {
    if (V.proofUrl) { try { URL.revokeObjectURL(V.proofUrl); } catch (e) {} }
    V.proofUrl = '';
    V.proofBlob = null;
  }

  /* ---------- 合成送达凭证 ---------- */

  function loadImg(url) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('图片读不出来')); };
      im.src = url;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // 合成图的尺寸：只有照片和每张下面的楼栋标注，没有标题栏、没有页脚
  function proofSize(n) {
    var PAD = 36, W = 1080;
    var cols = n <= 1 ? 1 : (n <= 4 ? 2 : 3);
    var cellW = Math.floor((W - PAD * (cols + 1)) / cols);
    var cellH = Math.round(cellW * (n === 1 ? 0.75 : 1));
    var LABEL = 56;
    var rows = Math.max(1, Math.ceil(n / cols));
    var H = PAD + rows * (cellH + LABEL + PAD);
    return { PAD: PAD, W: W, cols: cols, cellW: cellW, cellH: cellH, LABEL: LABEL, rows: rows, H: H };
  }

  function composeProof(photos, meta) {
    var s = proofSize(photos.length);
    var PAD = s.PAD, W = s.W, cols = s.cols, cellW = s.cellW, cellH = s.cellH, LABEL = s.LABEL, H = s.H;

    return Promise.all(photos.map(function (p) { return loadImg(p.url); })).then(function (imgs) {
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      if (!ctx) throw new Error('这台设备不支持合成图片');

      ctx.fillStyle = '#fdf8f0';
      ctx.fillRect(0, 0, W, H);

      for (var i = 0; i < imgs.length; i++) {
        var r = Math.floor(i / cols), c = i % cols;
        var x = PAD + c * (cellW + PAD);
        var y = PAD + r * (cellH + LABEL + PAD);
        var im = imgs[i];

        ctx.save();
        roundRect(ctx, x, y, cellW, cellH, 16);
        ctx.clip();
        var sw = im.naturalWidth || im.width, sh = im.naturalHeight || im.height;
        if (sw && sh) {
          var scale = Math.max(cellW / sw, cellH / sh);
          var dw = sw * scale, dh = sh * scale;
          ctx.drawImage(im, x + (cellW - dw) / 2, y + (cellH - dh) / 2, dw, dh);
        }
        ctx.restore();

        ctx.fillStyle = '#3a2a1c';
        ctx.font = '600 30px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
        var label = photos[i].building || '送达';
        var lab = '✓ ' + label;
        while (ctx.measureText(lab).width > cellW - 120 && lab.length > 3) {
          lab = lab.slice(0, lab.length - 2) + '…';
        }
        ctx.fillText(lab, x + 4, y + cellH + 40);

        ctx.fillStyle = '#8a7259';
        ctx.font = '400 24px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
        var tm = hhmm(photos[i].at);
        var tw = ctx.measureText(tm).width;
        ctx.fillText(tm, x + cellW - tw - 4, y + cellH + 40);
      }

      return new Promise(function (resolve, reject) {
        cv.toBlob(function (blob) {
          if (!blob) { reject(new Error('合成失败')); return; }
          resolve({ blob: blob, url: URL.createObjectURL(blob), w: W, h: H });
        }, 'image/jpeg', 0.9);
      });
    });
  }

  function doCompose() {
    if (!V.photos.length || !V.record) return;
    var un = 0;
    for (var i = 0; i < V.photos.length; i++) if (!V.photos[i].building) un++;
    if (un) { toast('还有 ' + un + ' 张没选楼栋，点照片选一下'); return; }
    V.busy = true;
    V.err = '';
    paint();
    var t = V.record.totals;
    composeProof(V.photos, {
      date: mdLabel(V.record.date),
      line: t.buildings + ' 栋 · ' + t.orders + ' 单 · ' + t.cups + ' 件',
      foot: '共 ' + V.photos.length + ' 处送达'
    }).then(function (out) {
      V.busy = false;
      if (V.proofUrl) { try { URL.revokeObjectURL(V.proofUrl); } catch (e) {} }
      V.proofUrl = out.url;
      V.proofBlob = out.blob;
      paint();
      toast('拼好了，长按图就能存');
    }).catch(function (e) {
      V.busy = false;
      V.err = '合成失败：' + (e && e.message ? e.message : '未知');
      paint();
    });
  }

  function shareProof() {
    if (!V.proofBlob) return;
    var name = '送达凭证-' + (V.record ? V.record.date : todayStr()) + '.jpg';
    var file;
    try { file = new File([V.proofBlob], name, { type: 'image/jpeg' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: '送达凭证' }).catch(function () {});
    } else {
      toast('这台设备不支持直接分享，长按图片存到相册再发');
    }
  }

  /* ---------- 单条编辑 ---------- */

  function editOrder(no) {
    if (!V.record) return;
    var o = null;
    for (var i = 0; i < V.record.orders.length; i++) if (V.record.orders[i].no === no) o = V.record.orders[i];
    if (!o) return;

    var blds = [];
    for (var b = 0; b < V.record.buildings.length; b++) {
      var k = V.record.buildings[b].key;
      if (k !== '未写楼栋') blds.push(k);
    }
    var opt = blds.map(function (k2) {
      return '<option value="' + esc(k2) + '"' + (k2 === o.building ? ' selected' : '') + '>' + esc(k2) + '</option>';
    }).join('');

    var goods = o.items.map(function (it, idx) {
      return '<div class="jl-erow"><input class="jl-e-name" data-i="' + idx + '" value="' + esc(it.name) + '">' +
        '<input class="jl-e-qty" type="number" min="1" max="99" data-i="' + idx + '" value="' + it.qty + '"></div>';
    }).join('');

    var mask = document.createElement('div');
    mask.className = 'jl-mask';
    mask.innerHTML =
      '<div class="jl-sheet-edit">' +
      '<div class="jl-ehead"><b>改第 ' + no + ' 条</b><button type="button" data-x="close">×</button></div>' +
      '<label class="jl-efield"><span>名字</span><input id="jlEName" value="' + esc(o.name) + '"></label>' +
      '<label class="jl-efield"><span>楼栋</span><select id="jlEBld"><option value="">（不写）</option>' + opt +
      '<option value="__new">+ 新楼栋…</option></select></label>' +
      '<label class="jl-efield"><span>房号</span><input id="jlERoom" value="' + esc(o.room) + '" inputmode="numeric"></label>' +
      '<label class="jl-efield"><span>这单总价</span><input id="jlETotal" type="number" min="0" step="0.5" value="' +
      (o.total == null ? '' : o.total) + '" placeholder="原文说共多少就填这"></label>' +
      '<div class="jl-efield jl-efield-top"><span>商品</span><div class="jl-egoods" id="jlEGoods">' + goods + '</div></div>' +
      '<button type="button" class="jl-ghost jl-addgood" data-x="addgood">+ 加一样</button>' +
      '<label class="jl-efield"><span>备注</span><input id="jlENote" value="' + esc(o.note) + '"></label>' +
      '<div class="jl-eacts">' +
      '<button type="button" class="jl-danger" data-x="del">删掉这条</button>' +
      '<button type="button" class="jl-primary" data-x="ok">改好了</button>' +
      '</div></div>';

    document.body.appendChild(mask);

    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
    }

    mask.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t === mask) { close(); return; }
      var x = t.getAttribute ? t.getAttribute('data-x') : null;
      if (x === 'close') { close(); return; }
      if (x === 'addgood') {
        var box = mask.querySelector('#jlEGoods');
        var idx = box.children.length;
        var d = document.createElement('div');
        d.className = 'jl-erow';
        d.innerHTML = '<input class="jl-e-name" data-i="' + idx + '" placeholder="商品">' +
          '<input class="jl-e-qty" type="number" min="1" max="99" data-i="' + idx + '" value="1">';
        box.appendChild(d);
        return;
      }
      if (x === 'del') {
        V.record.orders = V.record.orders.filter(function (x2) { return x2.no !== no; });
        close();
        rebuild();
        persist(true);
        toast('已删掉第 ' + no + ' 条');
        return;
      }
      if (x === 'ok') {
        o.name = mask.querySelector('#jlEName').value.trim();
        var bv = mask.querySelector('#jlEBld').value;
        if (bv === '__new') {
          var nv = window.prompt('新楼栋，比如 7栋 或 A栋');
          if (nv) bv = normBuilding(String(nv).replace(/(栋|幢|号楼|座|#)$/, ''), '');
        }
        o.building = bv || '';
        o.buildingFrom = 'manual';   // 人改过的，别再拿历史去覆盖
        o.room = mask.querySelector('#jlERoom').value.trim();
        o.note = mask.querySelector('#jlENote').value.trim();
        var tv = mask.querySelector('#jlETotal').value;
        var tn = parseFloat(tv);
        o.total = (trim(tv) !== '' && tn >= 0 && tn < 100000) ? tn : null;
        var oldUnits = o.items.map(function (x3) { return x3.unit; });
        var names = mask.querySelectorAll('.jl-e-name');
        var qtys = mask.querySelectorAll('.jl-e-qty');
        var items = [];
        for (var i2 = 0; i2 < names.length; i2++) {
          var nm = names[i2].value.trim();
          var q = parseInt(qtys[i2].value, 10);
          if (!nm) continue;
          if (!(q > 0 && q < 100)) q = 1;
          items.push({ name: nm, qty: q, unit: oldUnits[i2] == null ? null : oldUnits[i2] });
        }
        o.items = items;
        o.manual = true;
        close();
        rebuild();
        persist(true);
        toast('改好了');
      }
    });
  }

  /* ---------- 给照片标楼栋 ---------- */

  function pickBuildingFor(key) {
    if (!V.record) return;
    var p = null;
    for (var i = 0; i < V.photos.length; i++) if (V.photos[i].key === key) p = V.photos[i];
    if (!p) return;

    var seen = {};
    var picks = [];
    for (var b = 0; b < V.record.buildings.length; b++) {
      var k = V.record.buildings[b].key;
      if (k === '未写楼栋' || seen[k]) continue;
      seen[k] = 1;
      picks.push('<button type="button" data-b="' + esc(k) + '"' + (k === p.building ? ' class="on"' : '') + '>' +
        esc(k) + '<i>' + V.record.buildings[b].cups + ' 件</i></button>');
    }

    var mask = document.createElement('div');
    mask.className = 'jl-mask';
    mask.innerHTML =
      '<div class="jl-sheet-edit jl-sheet-pick">' +
      '<div class="jl-ehead"><b>这张是哪一栋</b><button type="button" data-x="close">×</button></div>' +
      '<p class="jl-pick-lead">标了之后，拼图下面就会写这一栋，按你选的来。</p>' +
      '<div class="jl-picks">' + picks.join('') + '</div>' +
      '<div class="jl-pickfree"><input id="jlPickFree" placeholder="不在这几栋？写 7栋 或 A栋">' +
      '<button type="button" data-x="free">用这个</button></div>' +
      '<div class="jl-eacts">' +
      '<button type="button" class="jl-ghost" data-x="none">不标楼栋</button>' +
      '<button type="button" class="jl-ghost" data-x="close">取消</button>' +
      '</div></div>';

    document.body.appendChild(mask);

    function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }

    mask.addEventListener('click', function (ev) {
      var t = ev.target;
      var x = t.getAttribute ? t.getAttribute('data-x') : null;
      var bv = t.getAttribute ? t.getAttribute('data-b') : null;
      if (t === mask || x === 'close') { close(); return; }
      if (bv) { close(); setPhotoBuilding(key, bv); return; }
      if (x === 'none') { close(); setPhotoBuilding(key, ''); return; }
      if (x === 'free') {
        var v = mask.querySelector('#jlPickFree').value;
        if (!trim(v)) { toast('先写个楼栋名'); return; }
        var nb = normBuilding(String(v).replace(/(栋|幢|号楼|座|#)$/, ''), '');
        close();
        setPhotoBuilding(key, nb);
      }
    });
  }

  /* ---------- 事件 ---------- */

  function onClick(ev) {
    var t = ev.target;
    var btn = null;
    while (t && t !== HOST) {
      if (t.getAttribute && t.getAttribute('data-act')) { btn = t; break; }
      t = t.parentNode;
    }
    if (!btn) return;
    var act = btn.getAttribute('data-act');

    if (act === 'close') { if (D && D.close) D.close(); return; }
    if (act === 'back') {
      if (V.view === 'detail') { V.view = 'history'; paint(); }
      else goHome();
      return;
    }
    if (act === 'history') { V.view = 'history'; paint(); return; }
    if (act === 'save') { persist(false); return; }
    if (act === 'newone') { goHome(); return; }
    if (act === 'removeone') {
      if (!window.confirm('删掉这一单？照片也会一起清掉，删了找不回来。')) return;
      var id = V.noteId;
      if (id && D && D.listPhotos) {
        D.listPhotos(photoKey(id)).then(function (arr) {
          for (var i = 0; i < (arr || []).length; i++) { try { D.delPhoto(arr[i].key); } catch (e) {} }
        }).catch(function () {});
      }
      if (id && D && D.removeNote) D.removeNote(id);
      V.noteId = null;
      V.record = null;
      V.view = 'history';
      paint();
      toast('已删掉');
      return;
    }
    if (act === 'parse') { doParse(false); return; }
    if (act === 'parse-ai') { doParse(true); return; }
    if (act === 'open') { openRecord(btn.getAttribute('data-id')); return; }
    if (act === 'tab') { V.tab = btn.getAttribute('data-v'); paint(); return; }
    if (act === 'bld') {
      var k = btn.getAttribute('data-k');
      V.openBld = (V.openBld === k) ? '' : k;
      paint();
      return;
    }
    if (act === 'edit') { editOrder(parseInt(btn.getAttribute('data-no'), 10)); return; }
    if (act === 'boxmode') {
      V.boxMode = btn.getAttribute('data-v');
      var s = readSettings();
      s.boxMode = V.boxMode === 'auto' ? '' : V.boxMode;
      s.cap = V.cap || s.cap || DEFAULT_CAP;
      writeSettings(s);
      rebuild();
      return;
    }
    if (act === 'delphoto') { delPhoto(btn.getAttribute('data-k')); return; }
    if (act === 'setbld') {
      V.proofBld = btn.getAttribute('data-v') || '';
      paint();
      return;
    }
    if (act === 'pickbld') { pickBuildingFor(btn.getAttribute('data-k')); return; }
    if (act === 'aibox') {
      if (V.record) V.record.plan.aiRejected = false;
      kickBoxAI(V.record);
      return;
    }
    if (act === 'compose') { doCompose(); return; }
    if (act === 'shareproof') { shareProof(); return; }
    if (act === 'clearshots') {
      if (!window.confirm('把已拍的 ' + V.photos.length + ' 张都删掉？')) return;
      V.photos.slice().forEach(function (p) { delPhoto(p.key); });
      return;
    }
  }

  function onChange(ev) {
    var t = ev.target;
    if ((t.id === 'jlShotCam' || t.id === 'jlShotPick') && t.files && t.files.length) {
      addPhotos(t.files, V.proofBld);
      t.value = '';
      return;
    }
    if (t.id === 'jlCap') {
      var v = parseInt(t.value, 10);
      if (!(v >= 4 && v <= 40)) return;
      V.cap = v;
      var s = readSettings();
      s.cap = v;
      writeSettings(s);
      rebuild();
      return;
    }
    if (t.classList && t.classList.contains('jl-price')) {
      var name = t.getAttribute('data-name');
      var unit = parseFloat(t.value);
      if (!(unit >= 0)) return;
      setPrice(name, unit, 'manual');
      rebuild();
      toast('记住「' + name + '」¥' + unit);
    }
  }

  function onInput(ev) {
    var t = ev.target;
    if (t.id === 'jlText') V.text = t.value;
  }

  function mount(host, deps) {
    HOST = host;
    D = deps;
    var st = readSettings();
    V.cap = st.cap || DEFAULT_CAP;
    V.boxMode = st.boxMode || 'auto';
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    host.addEventListener('input', onInput);
    return { paint: paint, goHome: goHome, openRecord: openRecord, list: listRecords };
  }

  function open() {
    V.view = 'home';
    V.record = null;
    V.noteId = null;
    V.photos = [];
    V.proofUrl = '';
    V.err = '';
    V.openBld = '';
    paint();
  }

  return {
    ITEM_WORDS: ITEM_WORDS,
    MOUNT_READY: true,
    MARK: MARK,
    DEFAULT_CAP: DEFAULT_CAP,
    MAX_BOXES: MAX_BOXES,
    parseText: parseText,
    parseLine: parseLine,
    parseAiPayload: parseAiPayload,
    buildPrompt: buildPrompt,
    buildBoxPrompt: buildBoxPrompt,
    parseBoxPayload: parseBoxPayload,
    useAiBoxes: useAiBoxes,
    proofSize: proofSize,
    residentBook: residentBook,
    residentsText: residentsText,
    fillMissingBuildings: fillMissingBuildings,
    finalize: finalize,
    groupByBuilding: groupByBuilding,
    sumTotals: sumTotals,
    planBoxes: planBoxes,
    deliveryCards: deliveryCards,
    encodeNote: encodeNote,
    decodeNote: decodeNote,
    stripMark: stripMark,
    toPlainText: toPlainText,
    normBuilding: normBuilding,
    compareBuilding: compareBuilding,
    cnToNum: cnToNum,
    findBuilding: findBuilding,
    findItems: findItems,
    findName: findName,
    money: money,
    amtLabel: amtLabel,
    todayStr: todayStr,
    readPrice: readPrice,
    writePrice: writePrice,
    setPrice: setPrice,
    learnedPrices: learnedPrices,
    effectivePrice: effectivePrice,
    readSettings: readSettings,
    writeSettings: writeSettings,
    cupCount: cupCount,
    mount: mount,
    open: open,
    showHistory: function () { V.view = 'history'; paint(); },
    goHome: goHome,
    openRecord: openRecord,
    list: listRecords,
    view: V
  };
});
