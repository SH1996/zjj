/* 竹间记 · 接龙
 * 把微信群接龙文本拆成结构化订单：分楼栋、配泡沫箱、算金额、合成送达凭证。
 * 边界：解析以本地规则为主，AI 只在规则识别不出来时兜底；两者都不改金额口径。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JieLong = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  /* ==================== 1. 常量 ==================== */

  // 商品词表：长词在前，保证「黑豆浆」不会被切成「黑」+「豆浆」
  var ITEM_WORDS = [
    '红枣豆浆', '黑豆浆', '五谷豆浆', '原味豆浆', '甜豆浆', '咸豆浆', '豆浆',
    '玉米汁', '南瓜汁', '紫薯汁', '花生浆', '核桃浆', '米浆', '绿豆沙', '红豆沙',
    '小米粥', '八宝粥', '南瓜粥', '白粥', '瘦肉粥', '皮蛋粥', '粥',
    '肉包', '菜包', '豆沙包', '奶黄包', '叉烧包', '小笼包', '灌汤包', '包子',
    '白馒头', '红糖馒头', '馒头', '花卷', '油条', '饭团', '糯米鸡', '烧麦',
    '肠粉', '茶叶蛋', '水煮蛋', '卤蛋', '鸡蛋', '玉米', '红薯', '紫薯',
    '牛奶', '酸奶', '豆奶', '面包', '蛋糕', '煎饼', '手抓饼', '蒸饺', '云吞'
  ];

  var UNIT_CHARS = '杯份个瓶袋根只盒碗笼屉张块';
  var CN_NUM = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

  var DEFAULT_CAP = 16;      // 每个泡沫箱默认装多少杯
  var MAX_BOXES = 3;         // 最多三个箱子
  var PRICE_KEY = 'bamboo.v11.jielong.price';
  var SETTINGS_KEY = 'bamboo.v11.jielong.settings';

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
  // 「3栋 / 三栋 / 3号楼 / 3# / A栋 / A座」→ 统一的键
  function normBuilding(raw, kind) {
    var s = trim(raw);
    if (!s) return '';
    s = s.replace(/\s+/g, '');
    if (/^[A-Za-z]$/.test(s)) return s.toUpperCase() + '栋';
    var n = cnToNum(s);
    if (!isNaN(n)) return n + '栋';
    return s + '栋';
  }
  // 楼栋自然排序：数字栋按数字，字母栋排后面
  function buildingRank(key) {
    var m = String(key).match(/^(\d+)/);
    if (m) return { g: 0, n: parseInt(m[1], 10), s: key };
    var a = String(key).match(/^([A-Za-z])/);
    if (a) return { g: 1, n: a[1].charCodeAt(0), s: key };
    return { g: 2, n: 0, s: key };
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

  // 楼栋 + 房号
  function findBuilding(text) {
    var best = null;
    var patterns = [
      // 3栋301 / 3幢 301 / 3号楼2单元301
      { re: /([0-9]{1,3}|[一二三四五六七八九十]{1,3}|[A-Za-z])\s*(号楼|栋|幢|座|#)\s*(?:[0-9]{0,1}\s*单元)?\s*([0-9]{3,4})?/, kind: 'std' },
      // 3-301 / 3－301（楼栋-房号）
      { re: /(?:^|[\s，,、；;：:])([0-9]{1,3})\s*[-－—]\s*([0-9]{3,4})(?![0-9])/, kind: 'dash' }
    ];
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      var re = new RegExp(p.re.source, 'g');
      var m;
      while ((m = re.exec(text)) !== null) {
        var got;
        if (p.kind === 'std') {
          got = { raw: m[0], token: m[1], tail: m[2], room: m[3] || '', start: m.index, end: m.index + m[0].length };
        } else {
          got = { raw: m[0], token: m[1], tail: '栋', room: m[2], start: m.index, end: m.index + m[0].length };
        }
        // 「3号楼」里的 token 是 3，tail 是「号楼」，都算楼栋
        if (!best || got.end - got.start > best.end - best.start) best = got;
      }
      if (best) break;
    }
    if (!best) return null;
    return {
      key: normBuilding(best.token, best.tail),
      room: best.room || '',
      raw: best.raw,
      start: best.start,
      end: best.end
    };
  }

  // 从一行里抽出商品与数量
  function findItems(text) {
    var items = [];
    var work = text;
    // 长词优先；每命中一次就抹掉，避免「黑豆浆」再被「豆浆」命中
    for (var w = 0; w < ITEM_WORDS.length; w++) {
      var word = ITEM_WORDS[w];
      var guard = 0;
      while (guard++ < 12) {
        var idx = work.indexOf(word);
        if (idx < 0) break;
        var before = work.slice(0, idx);
        var after = work.slice(idx + word.length);
        var qty = 1;
        var consumed = 0;

        // 形式 A：豆浆x2 / 豆浆×2 / 豆浆*2 / 豆浆 2 / 豆浆2杯
        var am = after.match(/^\s*(?:[x×X*]\s*([0-9]{1,2})|([0-9]{1,2})\s*([杯份个瓶袋根只盒碗])?|([一二两三四五六七八九十])\s*([杯份个瓶袋根只盒碗]))/);
        if (am) {
          if (am[1]) { qty = parseInt(am[1], 10); consumed = am[0].length; }
          else if (am[2]) { qty = parseInt(am[2], 10); consumed = am[0].length; }
          else if (am[4]) { qty = cnToNum(am[4]) || 1; consumed = am[0].length; }
        } else {
          // 形式 B：2杯豆浆 / 两份豆浆（数量在词前）
          var bm = before.match(/([0-9]{1,2}|[一二两三四五六七八九十])\s*([杯份个瓶袋根只盒碗])?\s*$/);
          if (bm) {
            var q = /^[0-9]+$/.test(bm[1]) ? parseInt(bm[1], 10) : (cnToNum(bm[1]) || 1);
            // 只有明确带单位，或者数字紧贴商品词时才当数量，避免把「3栋」的 3 吃掉
            if (bm[2] || /[0-9]$/.test(bm[1])) {
              qty = q;
              before = before.slice(0, before.length - bm[0].length);
            }
          }
        }
        if (!(qty > 0 && qty < 100)) qty = 1;
        var at = before.length;
        items.push({ name: word, qty: qty, at: at });
        work = before + ' '.repeat(word.length + consumed) + after.slice(consumed);
      }
    }
    items.sort(function (a, b) { return a.at - b.at; });
    return { items: items, rest: work };
  }

  // 备注：括号里的内容
  function findNote(text) {
    var m = text.match(/[（(]([^）)]{1,40})[）)]/);
    if (m) return trim(m[1]);
    m = text.match(/(不要|别放|少放|多加|加|免)[^，,。；;\s]{1,12}/);
    return m ? trim(m[0]) : '';
  }

  var NAME_STOP = /^(?:要|加|来|的|了|和|跟|与|帮|给|送|杯|份|个|瓶|袋|根|只|盒|碗|谢谢|辛苦|麻烦|同上|一样|一份|两份)/;

  function findName(text) {
    // 只留中文与间隔号，再把商品、数量、单位、序号扫干净
    // 注意：量词只跟着数字剥离，「张三」的「张」不是量词
    var s = String(text == null ? '' : text);
    for (var w = 0; w < ITEM_WORDS.length; w++) {
      if (s.indexOf(ITEM_WORDS[w]) > -1) s = s.split(ITEM_WORDS[w]).join(' ');
    }
    s = s
      .replace(/[（(][^）)]*[）)]/g, ' ')
      .replace(new RegExp('([0-9]{1,3}|[一二两三四五六七八九十])\\s*[' + UNIT_CHARS + ']', 'g'), ' ')
      .replace(/[0-9]+/g, ' ')
      .replace(/[，,、；;：:.。!！?？~～\-—_/\\|]/g, ' ')
      .replace(/[x×X*]/g, ' ');
    var cands = s.match(/[\u4e00-\u9fa5·]{2,8}/g) || [];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (NAME_STOP.test(c)) continue;
      // 姓名字数：2–4 常见，少数民族名可到 6，超长就截断
      if (c.length > 6) c = c.slice(0, 4);
      return c;
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
    if (b) {
      work = text.slice(0, b.start) + ' ' + text.slice(b.end);
    }
    var note = findNote(work);
    var got = findItems(work);
    var name = findName(got.rest);
    var items = got.items.map(function (it) { return { name: it.name, qty: it.qty, unit: null }; });

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
        !findBuilding(line) && !findItems(line).items.length;
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
  function finalize(record, opts) {
    opts = opts || {};
    var price = opts.price || {};
    var settings = opts.settings || {};
    var orders = record.orders || [];

    // 金额
    var missing = {};
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      var amount = 0;
      var unknown = false;
      for (var j = 0; j < o.items.length; j++) {
        var it = o.items[j];
        var p = price[it.name];
        var unit = (p && typeof p.unit === 'number') ? p.unit : null;
        if (it.unit != null) unit = it.unit;
        if (unit == null) { unknown = true; missing[it.name] = true; }
        it.unit = unit;
        it.amount = unit == null ? null : unit * it.qty;
        amount += it.amount || 0;
      }
      o.amount = unknown ? null : amount;
      o.missingPrice = unknown;
    }

    var buildings = groupByBuilding(orders);
    var totals = sumTotals(orders, buildings);
    var plan = planBoxes(buildings, {
      cap: Number(settings.cap) || DEFAULT_CAP,
      maxBoxes: Number(settings.maxBoxes) || MAX_BOXES,
      forced: settings.boxMode || 'auto'
    });

    record.buildings = buildings;
    record.totals = totals;
    record.plan = plan;
    record.missingPrice = Object.keys(missing);
    return record;
  }

  /* ==================== 4. 分组与合计 ==================== */

  function cupCount(order) {
    var n = 0;
    for (var i = 0; i < order.items.length; i++) n += order.items[i].qty || 0;
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
  function learnedPrices(listFn) {
    var rows = typeof listFn === 'function' ? listFn() : [];
    var book = {};
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i].data;
      if (!d || !d.orders) continue;
      for (var j = 0; j < d.orders.length; j++) {
        var its = d.orders[j].items || [];
        for (var k = 0; k < its.length; k++) {
          var it = its[k];
          if (it && it.unit != null && !book[it.name]) {
            book[it.name] = { unit: it.unit, from: 'history', at: rows[i].date || '' };
          }
        }
      }
    }
    return book;
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

  function buildPrompt(text, game) {
    return '你是接龙订单识别助手。下面是一段微信群接龙原文，请把它拆成结构化订单。\n\n' +
      '【原文】\n' + String(text).slice(0, 6000) + '\n\n' +
      '【输出格式】只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。\n' +
      '{"title":"这一单的标题，可能为空","orders":[{"no":1,"name":"张三","building":"3栋","room":"301","items":[{"name":"豆浆","qty":1}],"note":""}]}\n\n' +
      '【硬性要求】\n' +
      '1. no 是接龙里的序号，没有就按顺序从 1 编。\n' +
      '2. building 统一写成「3栋」「12栋」「A栋」这种形式；原文没写楼栋就填空字符串，不要瞎猜。\n' +
      '3. items 里的 name 只用原文出现过的商品；没写商品就留空数组，不要编造。\n' +
      '4. qty 必须是 1–99 的整数；原文写「两份」就填 2，没写数量就填 1。\n' +
      '5. room 是房号，原文没有就填空字符串。\n' +
      '6. 原文里不是订单的行（如「#接龙」、日期、说明）不要出现在 orders 里。\n' +
      '7. 不要修改人名，也不要合并两条订单。\n';
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
          items.push({ name: nm, qty: q, unit: null });
        }
      }
      if (!name && !items.length && !bd) continue;
      out.push({
        no: parseInt(o.no, 10) || (out.length + 1),
        raw: trim(o.raw) || '',
        name: name,
        building: bd ? normBuilding(bd.replace(/(栋|幢|号楼|座|#)$/, ''), '') : '',
        room: trim(o.room),
        items: items,
        note: trim(o.note),
        conf: 0.9,
        issues: [],
        manual: false
      });
    }
    if (!out.length) return { ok: false, error: '一条订单都没识别出来' };
    return {
      ok: true,
      record: finalize({
        date: opts.date || todayStr(),
        title: trim(obj.title) || '',
        orders: out,
        source: 'ai',
        conf: 0.9
      }, opts)
    };
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
          items: o.items.map(function (i) { return { name: i.name, qty: i.qty, unit: i.unit }; }),
          note: o.note || '', manual: !!o.manual
        };
      }),
      photos: (record.photos || []).map(function (p) {
        return { key: p.key, building: p.building, at: p.at };
      })
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
          (o.amount != null ? '　¥' + money(o.amount) : '') +
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
    err: '',
    boxMode: 'auto',
    cap: 0,
    openBld: '',
    proofUrl: '',
    proofBlob: null
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
      '<p>把微信群接龙<b>最后一条</b>整段粘进来。它会把单子拆成楼栋、算好金额、配好箱子。</p>' +
      '</div>';

    h += '<div class="jl-paste">' +
      '<textarea id="jlText" placeholder="#接龙&#10;11月9日 早餐&#10;1. 张三 3栋301 豆浆1 玉米汁2&#10;2. 李四 5栋 502 豆浆x2"></textarea>' +
      '</div>';

    h += '<div class="jl-row-inline">' +
      '<label class="jl-date"><span>日期</span><input type="date" id="jlDate" value="' +
      esc(V.date || todayStr()) + '"></label>' +
      '</div>';

    h += '<div class="jl-actions">' +
      '<button type="button" class="jl-primary" data-act="parse">识别这一单</button>' +
      (D && D.hasAI() ? '<button type="button" class="jl-ghost" data-act="parse-ai">用 AI 读</button>' : '') +
      '</div>';

    if (!D || !D.hasAI()) {
      h += '<p class="jl-hint">先按本地规则拆（很快、不花钱）。现在还没配 AI，遇到特别乱的格式可能拆不准——' +
        '到右上角「设置」填接口、密钥、模型就能用。</p>';
    } else {
      h += '<p class="jl-hint">先按本地规则拆，很快也不花钱；格式太乱、名字商品粘在一起时，再点「用 AI 读」。</p>';
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
      '楼栋、金额、装箱都在这台设备上算出来。AI 只在你说「用 AI 读」时参与拆单，改不了价格口径。' +
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

    var noBld = 0;
    for (var z = 0; z < r.orders.length; z++) if (!r.orders[z].building) noBld++;
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
    var amt = o.amount == null ? '<em class="jl-warn">待定价</em>' : '<em>¥' + money(o.amount) + '</em>';
    return '<div class="jl-orow" data-act="edit" data-no="' + o.no + '">' +
      '<i class="jl-no">#' + o.no + '</i>' +
      '<b class="jl-name">' + (o.name ? esc(o.name) : '<em class="jl-warn">无名</em>') + '</b>' +
      (o.room ? '<span class="jl-room">' + esc(o.room) + '</span>' : '<span class="jl-room jl-room-x">—</span>') +
      '<span class="jl-goods">' + itemText(o) + (o.note ? '<u>' + esc(o.note) + '</u>' : '') + '</span>' +
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

    h += '<div class="jl-boxes">';
    for (var i = 0; i < p.boxes.length; i++) {
      var b = p.boxes[i];
      var fill = b.fill > 100 ? 100 : b.fill;
      h += '<div class="jl-box">' +
        '<div class="jl-box-h"><b>箱 ' + b.idx + '</b><span>' + b.cups + ' 件</span>' +
        '<i class="' + (fill >= 95 ? 'full' : (fill < 50 ? 'thin' : '')) + '">' + b.fill + '%</i></div>' +
        '<div class="jl-box-bar"><i style="width:' + fill + '%"></i></div>' +
        '<div class="jl-box-b">' + b.buildings.map(function (k) {
          return '<span class="jl-chip">' + esc(k) + '</span>';
        }).join('') + '</div>' +
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
      h += '<details class="jl-card"' + (c === 0 ? ' open' : '') + '>' +
        '<summary><b>' + esc(card.key) + '</b>' +
        '<span>' + card.orders + ' 单 · ' + card.cups + ' 件</span>' +
        (card.floors.length ? '<i>' + card.floors.length + ' 个楼层</i>' : '') + '</summary>' +
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
      (t.unknownAmount ? '<i>' + t.unknownAmount + ' 单还没定价，没算进来</i>' : '') + '</div>';

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
        (o.amount == null ? '<em class="jl-warn">待定价</em>' : '<em>¥' + money(o.amount) + '</em>') + '</div>';
    }
    h += '</div>';
    return h;
  }

  function tabProof(r) {
    var h = '';
    h += '<div class="jl-shot-head">' +
      '<p>每送完一处拍一张。全部拍完点下面，会拼成一张长图，直接发群里当凭证。</p>' +
      '</div>';

    h += '<div class="jl-shots">';
    for (var i = 0; i < V.photos.length; i++) {
      var p = V.photos[i];
      h += '<div class="jl-shot">' +
        '<img src="' + esc(p.url) + '" alt="">' +
        '<span>' + esc(p.building) + (p.at ? '<i>' + hhmm(p.at) + '</i>' : '') + '</span>' +
        '<button type="button" data-act="delphoto" data-k="' + esc(p.key) + '" aria-label="删除">×</button>' +
        '</div>';
    }
    h += '<label class="jl-shot-add">' +
      '<input type="file" accept="image/*" capture="environment" id="jlShotInput">' +
      '<b>+</b><span>拍照</span></label>';
    h += '</div>';

    if (V.photos.length) {
      h += '<div class="jl-shot-actions">' +
        '<button type="button" class="jl-primary" data-act="compose"' +
        (V.busy ? ' disabled' : '') + '>' + (V.busy ? '正在拼…' : '合成送达凭证') + '</button>' +
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
    var price = effectivePrice(listRecords);
    var settings = readSettings();
    settings.cap = V.cap || settings.cap || DEFAULT_CAP;
    settings.boxMode = V.boxMode === 'auto' ? '' : V.boxMode;
    V.record = finalize({
      id: V.record.id,
      date: V.record.date,
      title: V.record.title,
      orders: V.record.orders,
      source: V.record.source,
      photos: V.record.photos
    }, { price: price, settings: settings });
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

  function doParse(useAi) {
    var ta = HOST.querySelector('#jlText');
    var text = ta ? ta.value : V.text;
    if (!text || !trim(text)) { V.err = '先把接龙内容粘进来'; paint(); return; }
    V.text = text;
    V.date = currentDate();
    V.err = '';
    V.busy = true;
    paint();

    var price = effectivePrice(listRecords);
    var settings = readSettings();
    settings.cap = V.cap || settings.cap || DEFAULT_CAP;

    var finish = function (rec) {
      V.busy = false;
      if (!rec || !rec.orders.length) {
        V.err = '这一单一条都没拆出来，看看是不是粘错了段落';
        paint();
        return;
      }
      V.noteId = null;
      applyRecord(rec);
      persist(true);
      toast('拆出 ' + rec.totals.orders + ' 单，已存进「接龙」');
    };

    if (!useAi) {
      var rec = null;
      try { rec = parseText(text, { date: V.date, price: price, settings: settings }); } catch (e) { rec = null; }
      setTimeout(function () { finish(rec); }, 60);
      return;
    }

    if (!D || !D.hasAI()) { V.busy = false; V.err = '还没配 AI'; paint(); return; }
    D.askAI(buildPrompt(text)).then(function (out) {
      var r = parseAiPayload(out, { date: V.date, price: price, settings: settings });
      if (r.ok) { finish(r.record); return; }
      var local = null;
      try { local = parseText(text, { date: V.date, price: price, settings: settings }); } catch (e) {}
      if (local && local.orders.length) {
        finish(local);
        toast('AI 没拆好，已改用本地规则');
      } else {
        V.busy = false;
        V.err = 'AI 和本地都没拆出来：' + r.error;
        paint();
      }
    }).catch(function (e) {
      var local = null;
      try { local = parseText(text, { date: V.date, price: price, settings: settings }); } catch (e2) {}
      if (local && local.orders.length) {
        finish(local);
        toast('AI 调用失败，已用本地规则');
      } else {
        V.busy = false;
        V.err = 'AI 调用失败：' + (e && e.message ? e.message : '未知');
        paint();
      }
    });
  }

  function openRecord(id) {
    var rows = listRecords();
    var hit = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) hit = rows[i];
    if (!hit) return;
    var data = hit.data;
    var price = effectivePrice(listRecords);
    var settings = readSettings();
    settings.cap = settings.cap || DEFAULT_CAP;
    var rec;
    if (data) {
      rec = finalize({
        id: hit.id,
        date: data.date,
        title: data.title,
        orders: data.orders.map(function (o) {
          return {
            no: o.no, name: o.name, building: o.building, room: o.room,
            items: (o.items || []).map(function (i2) { return { name: i2.name, qty: i2.qty, unit: i2.unit }; }),
            note: o.note || '', manual: o.manual
          };
        }),
        source: data.source || 'local',
        photos: data.photos || []
      }, { price: price, settings: settings });
    } else {
      rec = parseText(stripMark(hit.text), { date: hit.date, price: price, settings: settings });
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

  function addPhoto(file) {
    if (!file || !V.record) return;
    if (!V.noteId) persist(true);
    var id = V.noteId || 'tmp' + Date.now();
    var key = photoKey(id) + Date.now() + ':' + encodeURIComponent(guess);
    var guess = guessBuilding();
    V.busy = true;
    paint();
    D.compressImage(file).then(function (out) {
      return D.putPhoto(key, out.blob).then(function () {
        V.photos.push({
          key: key,
          building: guess,
          at: new Date().toISOString(),
          url: URL.createObjectURL(out.blob)
        });
        V.busy = false;
        V.tab = 'proof';
        paint();
        toast('已加上 ' + guess + ' 的照片');
      });
    }).catch(function (e) {
      V.busy = false;
      V.err = '照片存不进去：' + (e && e.message ? e.message : '未知');
      paint();
    });
  }

  // 这一张属于哪一栋：还没拍过的第一栋
  function guessBuilding() {
    if (!V.record) return '送达';
    var done = {};
    for (var i = 0; i < V.photos.length; i++) done[V.photos[i].building] = 1;
    for (var b = 0; b < V.record.buildings.length; b++) {
      if (!done[V.record.buildings[b].key]) return V.record.buildings[b].key;
    }
    return V.record.buildings.length ? V.record.buildings[0].key : '送达';
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
    paint();
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

  function composeProof(photos, meta) {
    var PAD = 36, W = 1080;
    var n = photos.length;
    var cols = n === 1 ? 1 : (n <= 4 ? 2 : 3);
    var cellW = Math.floor((W - PAD * (cols + 1)) / cols);
    var cellH = Math.round(cellW * (n === 1 ? 0.75 : 1));
    var LABEL = 52;
    var rows = Math.ceil(n / cols);
    var HEAD = 250, FOOT = 160;
    var H = HEAD + rows * (cellH + LABEL + PAD) + FOOT;

    return Promise.all(photos.map(function (p) { return loadImg(p.url); })).then(function (imgs) {
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      if (!ctx) throw new Error('这台设备不支持合成图片');

      ctx.fillStyle = '#fdf8f0';
      ctx.fillRect(0, 0, W, H);

      var grad = ctx.createLinearGradient(0, 0, W, HEAD);
      grad.addColorStop(0, '#c9722f');
      grad.addColorStop(1, '#a8532a');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, HEAD - 36);

      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.font = '600 32px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText('今天我送完了', PAD, 82);

      ctx.fillStyle = '#ffffff';
      ctx.font = '700 58px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(meta.date, PAD, 156);

      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.font = '400 29px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(meta.line, PAD, 202);

      for (var i = 0; i < imgs.length; i++) {
        var r = Math.floor(i / cols), c = i % cols;
        var x = PAD + c * (cellW + PAD);
        var y = HEAD + r * (cellH + LABEL + PAD);
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
        ctx.fillText(lab, x + 4, y + cellH + 38);

        ctx.fillStyle = '#8a7259';
        ctx.font = '400 24px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
        var tm = hhmm(photos[i].at);
        var tw = ctx.measureText(tm).width;
        ctx.fillText(tm, x + cellW - tw - 4, y + cellH + 38);
      }

      var fy = H - FOOT + 62;
      ctx.fillStyle = '#e8dccb';
      ctx.fillRect(PAD, fy - 42, W - PAD * 2, 2);

      ctx.fillStyle = '#3a2a1c';
      ctx.font = '600 31px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(meta.foot, PAD, fy + 18);

      ctx.fillStyle = '#a89078';
      ctx.font = '400 23px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText('竹间记 · ' + new Date().toLocaleString('zh-CN', { hour12: false }), PAD, fy + 64);

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
    V.busy = true;
    V.err = '';
    paint();
    var t = V.record.totals;
    composeProof(V.photos, {
      date: mdLabel(V.record.date),
      line: t.buildings + ' 栋 · ' + t.orders + ' 单 · ' + t.cups + ' 件',
      foot: '共 ' + V.photos.length + ' 处送达 · 合计 ¥' + money(t.amount)
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
        o.room = mask.querySelector('#jlERoom').value.trim();
        o.note = mask.querySelector('#jlENote').value.trim();
        var names = mask.querySelectorAll('.jl-e-name');
        var qtys = mask.querySelectorAll('.jl-e-qty');
        var items = [];
        for (var i2 = 0; i2 < names.length; i2++) {
          var nm = names[i2].value.trim();
          var q = parseInt(qtys[i2].value, 10);
          if (!nm) continue;
          if (!(q > 0 && q < 100)) q = 1;
          items.push({ name: nm, qty: q, unit: null });
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
    if (t.id === 'jlShotInput' && t.files && t.files[0]) {
      addPhoto(t.files[0]);
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
    todayStr: todayStr,
    readPrice: readPrice,
    writePrice: writePrice,
    setPrice: setPrice,
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
