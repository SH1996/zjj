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

  /* 本店价目表：店里两块牌子和「上新了」海报上抄下来的，当基准价。
   * 「问题清单」说的「少给」，对的就是这张表——没历史价、没人填过单价也能比。
   * half：这一样可以卖半笼，半价 = 价 ÷ 2（只有小笼包、蒸饺、灌汤小笼包）。 */
  var MENU = [
    // 包子
    { name: '红烧肉包', price: 2.5, by: '个' },
    { name: '鲜肉包', price: 2.5, by: '个', alias: ['鲜肉'] },
    { name: '酱肉包', price: 2.5, by: '个', alias: ['酱肉'] },
    { name: '麻辣牛肉包', price: 2.5, by: '个' },
    { name: '豆腐包', price: 2, by: '个', alias: ['麻辣豆腐包'] },
    { name: '豆沙包', price: 2, by: '个' },
    { name: '豇豆包', price: 2, by: '个' },
    { name: '香菇青菜包', price: 2, by: '个', alias: ['香菇青菜'] },
    { name: '香辣粉丝包', price: 2, by: '个' },
    { name: '梅干菜包', price: 2, by: '个' },
    { name: '香辣雪菜包', price: 2, by: '个' },
    { name: '肉沫茄子包', price: 2, by: '个', alias: ['茄包', '茄子包'] },
    { name: '香辣海带丝包', price: 2, by: '个' },
    { name: '香菇冬笋包', price: 2, by: '个', alias: ['香菇竹笋包', '冬笋包', '竹笋包', '香菇冬笋'] },
    { name: '麻辣土豆包', price: 2, by: '个', alias: ['土豆包', '土豆'] },
    // 按笼卖，可以半笼
    { name: '小笼包', price: 6, by: '笼', half: true, alias: ['鲜肉小笼包', '酱肉小笼包'] },
    { name: '灌汤小笼包', price: 7, by: '笼', half: true, alias: ['灌汤包'] },
    { name: '玉米鲜肉蒸饺', price: 6, by: '笼', half: true, alias: ['玉米蒸饺', '玉米饺', '鲜肉蒸饺', '蒸饺', '鲜肉玉米蒸饺'] },
    // 其它
    // 牌子上没写蛋，但店里白水蛋一直是 1.5 一个。名字写法五花八门，全归到这一样，
    // 免得「白水蛋 1.5」「白鸡蛋 3.5」各存一份，问题清单拿着错的那个去算少给。
    { name: '白鸡蛋', price: 1.5, by: '个', alias: ['鸡蛋', '白水蛋', '水煮蛋', '水煮鸡蛋', '白蛋', '清水蛋'] },
    { name: '烧麦', price: 1.5, by: '个', alias: ['烧卖'] },
    // 群里常写、两块牌子上没单列：价格取自接龙原文（油条 2、菜角 2.5、红薯 2、茶叶蛋 2）
    { name: '油条', price: 2, by: '根' },
    { name: '菜角', price: 2.5, by: '个' },
    { name: '红薯', price: 2, by: '个' },
    { name: '茶叶蛋', price: 2, by: '个' },
    { name: '玉米', price: 5, by: '个' },
    { name: '老面馒头', price: 1, by: '个', alias: ['白馒头', '白面馒头'] },
    { name: '红糖馒头', price: 2, by: '个' },
    { name: '南瓜馒头', price: 2, by: '个' },
    { name: '豆浆', price: 2, by: '杯' },
    { name: '红枣燕麦枸杞豆浆', price: 3, by: '杯', alias: ['红枣枸杞豆浆', '红枣燕麦豆浆', '燕麦枸杞豆浆'] },
    { name: '三黑豆浆', price: 3, by: '杯', alias: ['黑豆浆'] },
    { name: '五谷豆浆', price: 3, by: '杯' },
    { name: '皮蛋瘦肉粥', price: 3, by: '杯', alias: ['皮蛋粥', '瘦肉粥'] },
    { name: '黑米粥', price: 2, by: '杯' },
    { name: '南瓜小米粥', price: 2, by: '杯', alias: ['小米粥', '南瓜粥'] },
    { name: '玉米汁', price: 3, by: '个' },
    { name: '韭菜鸡蛋饼', price: 3, by: '个', alias: ['鸡蛋饼', '韭菜饼'] },
    { name: '鲜肉饼', price: 3.5, by: '个' },
    { name: '鸡蛋汉堡', price: 5, by: '个' },
    { name: '鸡蛋卷饼', price: 5, by: '个' }
  ];

  // 价目表里有的名字也要能认出来，不然「老面馒头」「三黑豆浆」整行丢
  (function () {
    var have = {};
    for (var a = 0; a < ITEM_WORDS.length; a++) have[ITEM_WORDS[a]] = 1;
    for (var b = 0; b < MENU.length; b++) {
      var m = MENU[b];
      if (!have[m.name]) { ITEM_WORDS.push(m.name); have[m.name] = 1; }
      var al = m.alias || [];
      for (var c = 0; c < al.length; c++) {
        if (!have[al[c]]) { ITEM_WORDS.push(al[c]); have[al[c]] = 1; }
      }
    }
    ITEM_SORTED = ITEM_WORDS.slice().sort(function (x, y) { return y.length - x.length; });
  })();

  /* 词表永远补不全（「三鲜包」「粉丝包」「萝卜丝包」…）。
   * 所以再加一层「后缀扩展」：以这些字结尾的中文串基本一定是吃的，
   * 从尾字往左吞并，遇到数量词、标点、数字就停，取最长的那一段。
   * 这样不管同学写什么包子，只要带「包」就不会整行丢掉。 */
  var TAIL_CHARS = '包子馒饺饼粥浆脑条糕团卷饭面粉汤肠挞司堡';
  var TAIL_STOP = '的个份杯瓶碗根只盒袋笼屉张块颗串支片斤半要和与跟给帮是加来我他她您你这那有请把从到吃';
  var TAIL_BAD = ['面包', '打包', '红包', '书包', '背包', '钱包', '包裹', '包括', '包好', '包起来', '包子铺', '包邮',
    '早饭', '早餐', '午饭', '午餐', '晚饭', '晚餐', '夜宵', '宵夜', '加餐', '送餐', '订餐', '点餐', '用餐', '吃饭', '做饭'];
  var TAIL_MAX = 5;   // 最多向前吞 5 个字：「香菇青菜包」正好 5

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

  /* 楼栋：四档优先级
   * ① 带「栋/幢/号楼/座/#」——最可信，允许「A 栋」空格、也允许房号前带 - ， 、
   * ② 字母+数字但没写「栋」——G1 / G2-. / g1姗 / G-1（宿舍楼常见写法）
   * ③ 数字-房号——5-402 / 3－301
   * ④ 行首或名字后的单个大写字母——「a，😴，一杯…」「张三 A 一个肉包」
   *    小写单字母不认：那是昵称（「h 一个白水蛋」）
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

    // ① 「A栋」「3 号楼」「G2栋」；房号可跟 - ， 、 或空格（E栋-301 / 6栋，402 / 5栋 302）
    var re1 = /([0-9]{1,3}|[一二三四五六七八九十]{1,3}|[A-Za-z][0-9]{0,2})\s*(号楼|栋|幢|座|#)\s*(?:[-－—，,、]\s*)?(?:[0-9]\s*单元\s*)?([0-9]{3,4})?(?![0-9])/g;
    while ((m = re1.exec(text)) !== null) {
      better({ raw: m[0], token: m[1], room: m[3] || '', start: m.index, end: m.index + m[0].length }, 0);
    }

    // ② 「G1」「G-1」「g2-」，以及「A201」= A 栋 201
    var re2 = /(?:^|[\s，,、；;：:])([A-Ha-h])\s*([-－])?\s*([0-9]{1,3})(?![0-9])\s*[-－.]?\s*([0-9]{3,4})?/g;
    while ((m = re2.exec(text)) !== null) {
      var cut = m[0].length - m[0].replace(/^[\s，,、；;：:]/, '').length;
      var dg = m[3];
      var token = dg.length >= 3 ? m[1] : m[1] + dg;      // A201 → A栋+201，G1 → G1栋
      var room = dg.length >= 3 ? dg : (m[4] || '');
      better({ raw: m[0], token: token, room: room, start: m.index + cut, end: m.index + m[0].length }, 1);
    }

    // ③ 楼栋-房号：5-402 / 3－301（不要碰 G2-. 这种，后面不是 3~4 位数字就不算）
    var re3 = /(?:^|[\s，,、；;：:])([0-9]{1,3})\s*[-－—]\s*([0-9]{3,4})(?![0-9])/g;
    while ((m = re3.exec(text)) !== null) {
      var cut3 = m[0].length - m[0].replace(/^[\s，,、；;：:]/, '').length;
      better({ raw: m[0], token: m[1], room: m[2], start: m.index + cut3, end: m.index + m[0].length }, 1);
    }

    // ④ 行首单字母 + 逗号：「a，😴，一杯…」
    //    只认逗号，不认空格——「h 一个白水蛋」里的 h 是名字
    var m3 = text.match(/^\s*([A-Ha-h])\s*[，,、]/);
    if (m3) {
      var st = m3.index + m3[0].indexOf(m3[1]);
      better({ raw: m3[0], token: m3[1], room: '', start: st, end: st + 1 }, 2);
    }

    // ⑤ 名字后面的孤立大写字母：「张三 A 一个肉包」。小写不认（「h」是昵称）
    var re5 = /(?:^|[\s，,、；;：:])([A-H])(?=[\s，,、；;：:.]|$)/g;
    while ((m = re5.exec(text)) !== null) {
      var cut5 = m[0].length - m[0].replace(/^[\s，,、；;：:]/, '').length;
      var at = m.index + cut5;
      // 前面 8 个字里得有人名（中文），否则「A 一个肉包」这种就是楼栋写在行首，交给 ④
      if (!/[\u4e00-\u9fa5]/.test(text.slice(Math.max(0, at - 8), at))) continue;
      better({ raw: m[0], token: m[1], room: '', start: at, end: at + 1 }, 2);
    }

    // ⑥ 行首单个大写字母也是楼栋：「E huh 一个鲜肉」「D朱柳臻 一个白鸡蛋」
    //    后面紧跟另一个字母就不算（Aurora 不是 A 栋）；④ 只认逗号，这两条都不认，以前整栋丢。
    var m6 = text.match(/^\s*([A-H])(?![A-Za-z])/);
    if (m6) {
      var st6 = m6[0].lastIndexOf(m6[1]);
      better({ raw: m6[1], token: m6[1], room: '', start: st6, end: st6 + 1 }, 2);
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

  /* 后缀扩展：找出「…包 / …馒头 / …饼 / …粥 / …脑」这类词
   * 例：「三鲜包」「粉丝包」「萝卜丝包」「玉米馒头」「南瓜饼」「鸡蛋灌饼」「豆腐脑」
   */
  function tailHits(s) {
    var out = [];
    for (var j = 0; j < s.length; j++) {
      if (TAIL_CHARS.indexOf(s.charAt(j)) < 0) continue;
      var end = j + 1;
      if (s.charAt(j) === '包' && s.charAt(j + 1) === '子') end = j + 2;   // 菜包子
      if (s.charAt(j) === '馒' && s.charAt(j + 1) === '头') end = j + 2;   // 玉米馒头
      var start = j, steps = 0;
      while (start > 0 && steps < TAIL_MAX) {
        var ch = s.charAt(start - 1);
        if (!/[\u4e00-\u9fa5]/.test(ch)) break;            // 数字、字母、空格、标点一律停
        if (TAIL_STOP.indexOf(ch) > -1) break;             // 「一个」「的」「要」都是边界
        start--; steps++;
      }
      if (j + 1 - start < 2) continue;                     // 光一个「包」不算商品
      var word = s.slice(start, end);
      if (TAIL_BAD.indexOf(word) > -1) continue;
      out.push({ name: word, start: start, end: end });
    }
    return out;
  }

  /* 词表 + 后缀扩展合并：长的优先，重叠的丢短的 */
  function collectHits(s) {
    var all = [];
    for (var w = 0; w < ITEM_WORDS.length; w++) {
      var word = ITEM_WORDS[w], from = 0, idx;
      while ((idx = s.indexOf(word, from)) > -1) {
        all.push({ name: word, start: idx, end: idx + word.length });
        from = idx + word.length;
      }
    }
    all = all.concat(tailHits(s));
    all.sort(function (a, b) {
      var la = a.end - a.start, lb = b.end - b.start;
      if (lb !== la) return lb - la;                         // 越长越可信
      return a.start - b.start;
    });
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      var h = all[i], clash = false;
      for (var c = 0; c < hits.length; c++) {
        if (h.start < hits[c].end && h.end > hits[c].start) { clash = true; break; }
      }
      if (!clash) hits.push(h);
    }
    hits.sort(function (a, b) { return a.start - b.start; });
    return hits;
  }

  /* 把一段拆成「商品 + 数量 + 这一段的钱」
   * 钱的三种写法都收：3 元 / 3块 / ￥3；以及贴着商品的裸数字「红薯2」
   */
  function parseSeg(seg) {
    var money = [];
    // 中文数字金额也要收：「七块」「十块」「两块五」的前半截。以前只认阿拉伯数字，
    // 「半笼酱肉小笼包＋土豆包＋豆浆 七块」整单金额就算不出来（合计直接少了这一单）。
    // 「两块五」「三块五」：块后面的中文数字是角（五 = 0.5），不是另一笔钱
    var s = String(seg).replace(/(?:[￥¥]\s*)?([0-9]+(?:\.[0-9]+)?|[一二两三四五六七八九十]{1,3})\s*(元|块钱|块|圆)([一二两三四五六七八九])?(?![0-9])/g,
      function (m, num, u, jiao, off) {
        var v = /^[0-9]/.test(num) ? parseFloat(num) : cnToNum(num);
        if (isNaN(v)) return m;                 // 认不出的中文数字原样留着，别吞
        if (jiao) {
          var j = cnToNum(jiao);
          if (!isNaN(j) && j < 10) v = round2(v + j / 10);
        }
        money.push({ val: v, at: off, len: m.length });
        return blank(m.length);
      });

    var hits = collectHits(s);

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

    var out = { items: items, amt: amt, amtCount: amtCount, nums: nums, moneyCount: money.length, totalLike: false };

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
      // 名字和商品连写（「蔡徐坤一个鲜肉一个香菇青菜」）时，商品剥掉后还粘着「一个」，
      // 不截掉就会把名字认成「蔡徐坤一个」，整单商品也跟着一起被吞
      p = p.replace(/(?:半|[0-9]{1,2}|[一二两三四五六七八九十])\s*[杯份个瓶袋根只盒碗笼屉张块条颗串支片斤]$/, '');
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
    if (b) {
      work = text.slice(0, b.start) + ' ' + text.slice(b.end);
      // 房号没被楼栋整段吃掉的（「E栋-301」老写法、「6栋，402」），单独再剥一次，
      // 否则 301 会被当成单价，一单肉包变成 ¥301
      if (b.room) {
        var reRoomStr = '(?:^|[\\s，,、；;：:\\-－—])' + b.room + '(?![0-9])';
        work = work.replace(new RegExp(reRoomStr), ' ');
      }
    }

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
          } else if (g2.nums && g2.nums.length === 1 && g2.moneyCount > 0) {
            // 「一个豇豆包2 … 4元」：2 是这一样的价，4 元才是整单总价。
            // 只有同时出现「带元的总价」和「裸数字」时才这么拆；
            // 光一个行末「3.5」是整单总价，别贴成豆浆单价（会显示成 ¥3.5 冤枉人）。
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
      // 日期行最容易装成订单：「11.10 早饭接龙」会被读成第 11 单、金额 10 元
      var looksDate = /^\s*[0-9]{1,2}\s*[.\-\/月]\s*[0-9]{1,2}\s*日?(?![0-9])/.test(line) &&
        !findBuilding(line) && !segHasItems(line);
      // 纯标题行（没有序号、没有楼栋、没有商品）跳过
      var looksTitle = !/^\s*[0-9]{1,3}\s*[.、．)）:：]/.test(line) &&
        !findBuilding(line) && !segHasItems(line);
      if (looksDate || looksTitle) { skipped.push(line); continue; }
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

  // 按名字在过往接龙记录里找这个人的楼栋：精确优先，再放宽到「去掉常见称呼后缀」
  // （张三 → 张三姐 / 张三哥 / 小张）。查不到返回 null。
  function lookupBuildingByName(name) {
    name = trim(name || '');
    if (!name) return null;
    var book = residentBook(listRecords);
    if (book[name] && book[name].building) return { building: book[name].building, room: book[name].room || '', at: book[name].at || '' };
    var strip = function (x) { return trim(x).replace(/(姐|哥|阿姨|叔|先生|女士|老板|小|老|大)$/, ''); };
    var sName = strip(name);
    if (sName && book[sName] && book[sName].building) {
      return { building: book[sName].building, room: book[sName].room || '', at: book[sName].at || '' };
    }
    var ks = Object.keys(book);
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i];
      if (book[k].building && strip(k) === name) {
        return { building: book[k].building, room: book[k].room || '', at: book[k].at || '' };
      }
    }
    return null;
  }

  // 问题清单里「没写楼栋」那一行的按钮：去过往记录按名字查，查到就填、查不到记一笔
  function lookupBld(no) {
    var rec = V.record;
    if (!rec || !rec.orders) return;
    var o = null;
    for (var i = 0; i < rec.orders.length; i++) if (rec.orders[i].no === no) { o = rec.orders[i]; break; }
    if (!o || o.building) return;
    var nm = trim(o.name || '');
    var hit = nm ? lookupBuildingByName(nm) : null;
    if (hit) {
      o.building = hit.building;
      if (!o.room && hit.room) o.room = hit.room;
      o.buildingFrom = 'history';
      o.bldLookedUp = false;
      rec.buildings = groupByBuilding(rec.orders);
      persist(true);
      paint();
      toast('已在过往记录找到「' + nm + '」：' + hit.building + (hit.room ? (' ' + hit.room) : '') + '，已补上');
    } else {
      o.bldLookedUp = true;
      persist(true);
      paint();
      toast(nm ? ('过往记录里没找到「' + nm + '」的楼栋') : '这条没写名字，没法按名字查');
    }
  }

  // 「没写楼栋」问题行底部：没查过出按钮，查过没找到出灰字提示
  function bldLookupHtml(no) {
    var rec = V.record;
    if (!rec || !rec.orders) return '';
    var o = null;
    for (var i = 0; i < rec.orders.length; i++) if (rec.orders[i].no === no) { o = rec.orders[i]; break; }
    if (!o || o.building) return '';
    if (o.bldLookedUp) return '<p class="jl-looked">已查过往记录，没找到这个人的楼栋</p>';
    return '<button type="button" class="jl-issue-act" data-act="lookupbld" data-no="' + no + '">在过往接龙里按名字查楼栋</button>';
  }

  /* 半笼兜底：原文写了「半笼」，可 AI 拆单常把 half 弄丢，还会把「玉米饺」
   * 归一成全称「玉米鲜肉蒸饺」——原来那个拿名字硬套原文的正则就找不着了。
   * 改成按整单判：这单里能半笼、且只点一份的，就是那一半。 */
  function applyHalfFromRaw(o) {
    var raw = String(o.raw || '');
    if (!raw || !/半\s*(?:笼|屉|份)/.test(raw)) return;
    var cand = [];
    for (var i = 0; i < o.items.length; i++) {
      var t = o.items[i];
      if (!t.half && canHalf(t.name) && t.qty === 1) cand.push(t);
    }
    if (!cand.length) return;
    var m = /半\s*(?:笼|屉|份)\s*([\u4e00-\u9fa5]{1,10})/.exec(raw);
    var near = m ? m[1] : '';
    for (var j = 0; j < cand.length; j++) {
      var nm = cand[j].name;
      var core = nm.replace(/^.*?(蒸饺|小笼包|灌汤包)/, '$1');
      if (near.indexOf(nm) > -1 || (core && core !== nm && near.indexOf(core) > -1) ||
          (nm.length > 2 && near.indexOf(nm.slice(-2)) > -1)) { cand[j].half = true; return; }
    }
    cand[0].half = true;   // 一行里只有一个可半笼的，那就是它
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
      applyHalfFromRaw(o);   // 原文写了「半笼」就一定要认出来，AI 拆单常丢这个标记
      for (var j = 0; j < o.items.length; j++) {
        var it = o.items[j];
        // AI 常回原文的简称／别名（「鲜肉」「麻辣豆腐包」「鲜肉玉米蒸饺」），
        // 价格本里没这个 key 时再按价目表归一一次，否则明明表里有价还显示「没定价」
        var p = price[it.name] || menuOf(it.name);
        var bookUnit = (p && typeof p.unit === 'number') ? p.unit : null;
        if (bookUnit != null && it.half && canHalf(it.name)) bookUnit = round2(bookUnit / 2);
        /* 这个 unit 是哪来的：
         * text  原文写了价；fixed 外面直接给定的价（改单弹层里手填的、测试造的单）
         * book  价目表/历史价带出来的——这种每次重算都要跟着价目表走，
         *       否则老板在金额页改了单价，这一单还咬着旧价不放。 */
        var unit, src;
        if (it.unit != null && it.priceFrom !== 'book') { unit = it.unit; src = it.fromText ? 'text' : 'fixed'; }
        else if (bookUnit != null) { unit = bookUnit; src = 'book'; }
        else { unit = it.unit; src = it.unit != null ? 'fixed' : ''; }
        /* 半笼：AI 常把整笼价（玉米蒸饺 ¥6）填进来、同时也标了 half，
         * 金额页就会显示 ¥6、送达清单也按 6 算。按本店半价纠正；
         * 老板自己在金额页手填的（fixed）不动。 */
        var moHalf = (it.half && canHalf(it.name)) ? menuOf(it.name) : null;
        // 手填价一般不动；唯独「半笼却记着整笼价」是明显错数据，按半价纠正
        if (moHalf && (src !== 'fixed' || Math.abs(Number(unit) - moHalf.unit) < 0.01)) {
          unit = round2(moHalf.unit / 2); src = 'book';
        }
        if (unit == null) { unknown = true; } else {
          it.amount = round2(unit * it.qty);
          amount += it.amount;
        }
        it.unit = unit;
        it.priceFrom = src;
        if (unit == null) it.amount = null;
      }

      // 原文写的是「这一单多少钱」：以总价为准，不再逼你逐样填单价
      if (o.total != null && o.total >= 0) {
        o.amount = round2(o.total);
        o.missingPrice = false;
        o.payMode = 'total';
        fromTotal++;
        // 只有一种商品时，能安心反推单价（多商品均摊会算出假价，不做）
        // 半笼反推出来的是半价（3 块），不能当成「一笼多少钱」记进价格本
        if (o.items.length === 1 && o.items[0].qty > 0 && !o.items[0].half) {
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
    var boxOpts = {
      cap: Number(settings.cap) || DEFAULT_CAP,
      maxBoxes: Number(settings.maxBoxes) || MAX_BOXES,
      forced: settings.boxMode || 'auto'
    };
    var plan = settings.warm ? planWarmBoxes(buildings, boxOpts) : planBoxes(buildings, boxOpts);
    // AI 排的箱：过校验才用，过不了就用本地这套（件数守恒不能破）。
    // 保温模式不看 AI——一箱一栋是硬规矩，混装会把这箱的暖跑光。
    if (opts.aiBoxes && !settings.warm) {
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

  /* 冬天保温：一箱只装一栋，最多三箱。
   * 楼栋按件数从多到少排，前几个各占一箱；剩下的没箱子，用保温袋拎着。
   * 资料库里写过「这栋单独一箱」的，不管件数多少先给它留一箱——
   * 老板既然专门记过，那多半是老人、孩子多、或者路远的那一栋。 */
  function planWarmBoxes(buildings, opts) {
    opts = opts || {};
    var cap = opts.cap > 0 ? opts.cap : DEFAULT_CAP;
    var maxBoxes = opts.maxBoxes > 0 ? opts.maxBoxes : MAX_BOXES;
    var forced = Number(opts.forced) || 0;          // 今天只带了两个箱子，就按两个算
    if (forced >= 1 && forced <= maxBoxes) maxBoxes = forced;
    var list = (buildings || []).filter(function (b) { return b.cups > 0; });
    var total = list.reduce(function (a, b) { return a + b.cups; }, 0);
    if (!list.length) {
      return { mode: 0, cap: cap, total: 0, boxes: [], overflow: [], warm: true,
        reason: '这一单还没有杯数，先确认商品和数量。' };
    }

    var pins = {};
    var mem = readMemory();
    for (var i = 0; i < mem.length; i++) {
      if (mem[i].code === 'warmbld' && mem[i].name) pins[mem[i].name] = 1;
    }

    var sorted = list.slice().sort(function (a, b) {
      // 没写楼栋的一箱装不了——都不知道往哪送，先排到最后，等补上楼栋再说
      var ua = a.key === '未写楼栋' ? 1 : 0, ub = b.key === '未写楼栋' ? 1 : 0;
      if (ua !== ub) return ua - ub;
      var pa = pins[a.key] ? 1 : 0, pb = pins[b.key] ? 1 : 0;
      if (pa !== pb) return pb - pa;                       // 记过的先拿箱
      if (b.cups !== a.cups) return b.cups - a.cups;       // 件数多的先拿箱
      if (b.orders.length !== a.orders.length) return b.orders.length - a.orders.length;
      return compareBuilding(a, b);
    });

    var picked = sorted.slice(0, maxBoxes);
    var rest = sorted.slice(maxBoxes);

    var boxes = [];
    for (var j = 0; j < picked.length; j++) {
      var b = picked[j];
      boxes.push({
        idx: j + 1, cups: b.cups, buildings: [b.key], orders: b.orders,
        rooms: b.orders.map(function (o) { return o.room || ''; }).filter(Boolean).sort(),
        fill: Math.round(b.cups / cap * 100),
        pinned: !!pins[b.key],
        over: b.cups > cap
      });
    }

    var overflow = [];
    for (var k = 0; k < rest.length; k++) {
      overflow.push({ key: rest[k].key, cups: rest[k].cups, orders: rest[k].orders.length });
    }

    var reason = [];
    reason.push('一箱一栋：' + picked.map(function (x) { return x.key + ' ' + x.cups + ' 件'; }).join('、') +
      ' 各占一箱。');
    // 没分到箱子的那几栋，上面已经用警示块列清楚了，这里不再重复一遍
    var over = boxes.filter(function (x) { return x.over; });
    if (over.length) {
      reason.push(over.map(function (x) { return x.buildings[0] + ' 有 ' + x.cups + ' 件'; }).join('、') +
        '，超过一箱 ' + cap + ' 件，得分两袋或者换大箱。');
    }

    return {
      mode: boxes.length, cap: cap, total: total, boxes: boxes, overflow: overflow,
      warm: true, reason: reason.join('')
    };
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

  /* 加长版的名单：这一单所有接龙号，按号从小到大排，带名字和楼栋。
   * 号是群里接龙的序号，取餐的人念号，老板照着这张表喊名字。
   *
   * record.namesFix 是老板事后改的。群里有人撤回接龙，号就对不上了：
   * 说有哪几个号不存在、哪个号是别人，改过的记在这里，
   * 每次重拼图都先套一遍，拼出来的还是改过的那版。
   * 只动凭证上这一栏，订单、金额、件数一概不碰——那得去楼栋页删单。 */
  function proofNameList(record) {
    var out = proofNameBase(record);
    var fixes = (record && record.namesFix) || [];
    for (var f = 0; f < fixes.length; f++) {
      var ops = fixes[f] && fixes[f].ops ? fixes[f].ops : fixes[f];
      if (ops) out = applyNameFix(out, ops);
    }
    return out;
  }

  /* 原始名单，没改过的：直接按接龙号排 */
  function proofNameBase(record) {
    var out = [];
    var bs = (record && record.buildings) || [];
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      var os = b.orders || [];
      for (var j = 0; j < os.length; j++) {
        var o = os[j];
        if (!(o.no > 0)) continue;
        out.push({ no: o.no, name: o.name || '', bld: b.key });
      }
    }
    out.sort(function (x, y) { return x.no - y.no; });
    return out;
  }

  /* 一条改动套到名单上：
   * drop  去掉这些号（有人撤回了）
   * set   改名字／楼栋
   * add   补一条（漏接龙的）
   * shift 去掉之后，比 shiftFrom 大的号依次减 1（群里重排了才用，不乱挪） */
  function applyNameFix(list, fix) {
    fix = fix || {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      out.push({ no: list[i].no, name: list[i].name || '', bld: list[i].bld || '' });
    }
    var drops = fix.drop || [];
    if (drops.length) {
      out = out.filter(function (x) { return drops.indexOf(x.no) < 0; });
    }
    var sets = fix.set || [];
    for (var s = 0; s < sets.length; s++) {
      var one = sets[s];
      if (!(one && one.no > 0)) continue;
      for (var t = 0; t < out.length; t++) {
        if (out[t].no !== one.no) continue;
        if (one.name) out[t].name = one.name;
        if (one.bld) out[t].bld = one.bld;
        break;
      }
    }
    if (fix.shift && drops.length) {
      var from = fix.shiftFrom > 0 ? fix.shiftFrom : Math.min.apply(null, drops);
      for (var m = 0; m < out.length; m++) {
        if (out[m].no > from) out[m].no -= 1;
      }
      // 挪完可能撞号（老板报的号本来就有重复），撞了就留前一个，别让同一行出现两次
      var seen = {};
      out = out.filter(function (x) {
        if (seen[x.no]) return false;
        seen[x.no] = 1;
        return true;
      });
    }
    var adds = fix.add || [];
    for (var a = 0; a < adds.length; a++) {
      var n = adds[a];
      if (!(n && n.no > 0)) continue;
      var dup = false;
      for (var q = 0; q < out.length; q++) if (out[q].no === n.no) { dup = true; break; }
      if (dup) continue;
      out.push({ no: n.no, name: n.name || '', bld: n.bld || '' });
    }
    // 事后想补断号：把 1..最大 里缺的那个洞填上，后面的号依次往前
    if (fix.fill) out = fillNameGap(out);
    out.sort(function (x, y) { return x.no - y.no; });
    return out;
  }

  /* 补断号：找到最小的那个空号，把比它大的都减 1，反复做到没有空号。
   * 只给「有人说撤回了，群里把号重排了」这种情况用，不自动干。 */
  function fillNameGap(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push({ no: list[i].no, name: list[i].name || '', bld: list[i].bld || '' });
    var guard = out.length + 2;
    while (guard-- > 0) {
      var max = 0, seen = {}, j;
      for (j = 0; j < out.length; j++) {
        seen[out[j].no] = 1;
        if (out[j].no > max) max = out[j].no;
      }
      var gap = 0;
      for (var n = 1; n <= max; n++) if (!seen[n]) { gap = n; break; }
      if (!gap) break;
      for (j = 0; j < out.length; j++) if (out[j].no > gap) out[j].no -= 1;
    }
    return out;
  }

  /* 让 AI 把老板那句话翻译成改动。名单一起给它，它才知道 8 号现在是谁，
   * 也才不会把「3栋」当成 3 号。 */
  function buildNameFixPrompt(list, say) {
    var L = [];
    L.push('你在帮早餐店老板改「送达凭证」上的接龙名单。这张图要发到群里，取餐的人照着号认名字。');
    L.push('多半是群里有人撤回了接龙，号对人就对不上了，老板要你把名单改对。');
    L.push('');
    L.push('【现在的名单】' + list.length + ' 个号');
    for (var i = 0; i < list.length; i++) {
      L.push('#' + list[i].no + ' ' + (list[i].name || '（没写名字）') +
        (list[i].bld ? '（' + list[i].bld + '）' : ''));
    }
    L.push('');
    L.push('【老板的话】');
    L.push(trim(say) || '（什么也没说）');
    L.push('');
    L.push('【怎么判断】');
    L.push('1. 「几号撤回了 / 没有了 / 不存在了 / 退单了」→ 只删掉这一条，别的号不动。微信群接龙的号撤回后一般不重排。');
    L.push('2. 只有老板明说「后面的往前挪 / 顺延 / 重排 / 重新编号」，才把比它大的号依次减 1，shift 填 true。');
    L.push('3. 「几号是某某 / 几号改名叫某某」→ 改名字；说的名字后面带楼栋（5栋）就一起改。');
    L.push('4. 「再加一个 / 补一个」→ 新增一条，号由你按上下文定。');
    L.push('5. 说「4栋那单撤了」这种按楼栋说的：名单里这栋只有一个人才删；有两个以上就别乱删，在 say 里问是哪一位。');
    L.push('6. 老板的话跟序号对不上、认不出要改哪个号，就什么都别改：drop / set / add 全给空数组，在 say 里直说没懂。');
    L.push('7. 「3栋」是楼栋不是 3 号，别混。');
    L.push('');
    L.push('【只输出这个 JSON，不要任何解释文字】');
    L.push('{"drop":[3],"set":[{"no":4,"name":"王姐","bld":"5栋"}],"add":[{"no":9,"name":"某某","bld":"3栋"}],"shift":false,"say":"3号撤回了，别的号不动"}');
    return L.join('\n');
  }

  // AI 回的那段话里挑 JSON。它偶尔会包一层 ``` 或者先客套一句，兜着走。
  function parseNameFixReply(text) {
    var s = String(text || '');
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    var obj = null;
    try { obj = JSON.parse(s.slice(a, b + 1)); }
    catch (e) {
      try { obj = JSON.parse(s.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"')); }
      catch (e2) { return null; }
    }
    if (!obj || typeof obj !== 'object') return null;
    var out = { drop: [], set: [], add: [], shift: !!obj.shift, say: trim(obj.say || '') };
    var i;
    if (Array.isArray(obj.drop)) {
      for (i = 0; i < obj.drop.length; i++) {
        var n = parseInt(obj.drop[i], 10);
        if (n > 0) out.drop.push(n);
      }
    }
    if (Array.isArray(obj.set)) {
      for (i = 0; i < obj.set.length; i++) {
        var st = obj.set[i];
        var no = parseInt(st && st.no, 10);
        if (!(no > 0)) continue;
        out.set.push({ no: no, name: trim(st.name || ''), bld: trim(st.bld || '') });
      }
    }
    if (Array.isArray(obj.add)) {
      for (i = 0; i < obj.add.length; i++) {
        var ad = obj.add[i];
        var ano = parseInt(ad && ad.no, 10);
        if (!(ano > 0)) continue;
        out.add.push({ no: ano, name: trim(ad.name || ''), bld: trim(ad.bld || '') });
      }
    }
    return out;
  }

  /* 没配 AI、或者 AI 那边断了，就自己抠。只认最常见的两句：
   * 「3号撤回了」「3、4号没有了」「8号是王姐 5栋」。
   * 抠不准就不改，让人再说一遍，总比改错了强。 */
  function parseNameSay(list, say) {
    var s = trim(say || '');
    var ops = { drop: [], set: [], add: [], shift: false, say: s };
    if (!s) return ops;
    if (/往前挪|顺延|重排|重新编号|补位|往前补|往前移/.test(s)) ops.shift = true;

    var DROP = /撤回|撤了|撤掉|取消|删|去掉|去除|不要|没了|没有|不存在|退了|退单|不算|不送|不做了|漏了/;
    var SET = /改成|换成|改为|改到|搬到|挪到|就是|是|叫/;
    var segs = s.split(/[，,。;；\n]+/);
    for (var i = 0; i < segs.length; i++) {
      var seg = trim(segs[i]);
      if (!seg) continue;
      // 「3栋」「5栋」里的数字是楼栋，先挪开，免得当成号
      var blds = [], work = seg.replace(/(\d{1,3}|[A-Za-z])\s*栋/g, function (m) { blds.push(m.replace(/\s+/g, '')); return '〔楼〕'; });
      var nos = [], m;
      var re = /(\d{1,3}(?:\s*[、和及]\s*\d{1,3})*)\s*(?:号|#)/g;
      while ((m = re.exec(work))) {
        var part = m[1].split(/[、和及]/);
        for (var p = 0; p < part.length; p++) {
          var v = parseInt(trim(part[p]), 10);
          if (v > 0 && nos.indexOf(v) < 0) nos.push(v);
        }
      }
      // 没写「号」的裸数字：只在句首、且这句明显在说号的时候认（「3撤回」）
      if (!nos.length) {
        var m2 = work.match(/^\s*(\d{1,3}(?:\s*[、和及]\s*\d{1,3})*)(?!\s*[元个杯笼])/);
        if (m2) {
          var q = m2[1].split(/[、和及]/);
          for (var q2 = 0; q2 < q.length; q2++) {
            var w = parseInt(trim(q[q2]), 10);
            if (w > 0) nos.push(w);
          }
        }
      }
      if (!nos.length) continue;

      if (DROP.test(seg) && !SET.test(seg)) {
        for (var d = 0; d < nos.length; d++) if (ops.drop.indexOf(nos[d]) < 0) ops.drop.push(nos[d]);
        continue;
      }
      if (SET.test(seg)) {
        var name = seg
          .replace(/(\d{1,3}|[A-Za-z])\s*栋/g, '')
          .replace(/\d{1,3}\s*(?:号|#)/g, '')
          .replace(/应该|其实|好像|名字|改成|换成|改为|改到|搬到|挪到|就是|叫作|叫做|叫|是|的/g, '')
          .replace(/[，,。;；、\s]/g, '');
        if (/^[了的啊吧呢嘛]$/.test(name)) name = '';
        var okName = !!name && name.length <= 6 && /^[\u4e00-\u9fa5A-Za-z·]+$/.test(name);
        // 「4号改成5栋」只改楼栋、名字不动，也算说得通
        if (okName || blds.length) {
          var bld = blds.length ? blds[blds.length - 1] : '';
          for (var k = 0; k < nos.length; k++) {
            ops.set.push({ no: nos[k], name: okName ? name : '', bld: bld });
          }
        }
        continue;
      }
      if (DROP.test(seg)) {
        for (var d2 = 0; d2 < nos.length; d2++) if (ops.drop.indexOf(nos[d2]) < 0) ops.drop.push(nos[d2]);
      }
    }
    return ops;
  }

  // 把一条改动说成人话，给老板过目：「去掉 #3；#4 改成「王姐」（5栋）」
  function nameFixText(ops, list) {
    if (!ops) return '';
    var L = [], i;
    for (i = 0; i < (ops.drop || []).length; i++) {
      var no = ops.drop[i], who = '';
      for (var j = 0; j < list.length; j++) if (list[j].no === no) who = list[j].name;
      L.push('去掉 #' + no + (who ? '（' + who + '）' : ''));
    }
    for (i = 0; i < (ops.set || []).length; i++) {
      var s = ops.set[i];
      L.push('#' + s.no + ' 改成「' + (s.name || '？') + '」' + (s.bld ? '（' + s.bld + '）' : ''));
    }
    for (i = 0; i < (ops.add || []).length; i++) {
      var a = ops.add[i];
      L.push('加上 #' + a.no + ' ' + (a.name || '（没名字）') + (a.bld ? '（' + a.bld + '）' : ''));
    }
    if (ops.shift && (ops.drop || []).length) L.push('后面的号往前补一位');
    if (!L.length) return '';
    return L.join('；');
  }

  function nameFixCount(record) {
    return ((record && record.namesFix) || []).length;
  }

  /* ==================== 6. 价格本 ==================== */

  /* 本店价目表的查表口：名字 → {unit, by, half}。
   * 「小笼包（鲜肉）」这种带括号的、多个空格的，先归一化再查；
   * 查不到就退一步按包含关系找最长的那个名字（「鲜肉小笼包2个」→ 小笼包）。 */
  var MENU_IDX = null;
  function normItemName(s) {
    return trim(s).replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '');
  }
  function menuIndex() {
    if (MENU_IDX) return MENU_IDX;
    MENU_IDX = {};
    for (var i = 0; i < MENU.length; i++) {
      var m = MENU[i];
      var rec = { name: m.name, unit: m.price, by: m.by || '个', half: !!m.half };
      if (!MENU_IDX[normItemName(m.name)]) MENU_IDX[normItemName(m.name)] = rec;
      var al = m.alias || [];
      for (var j = 0; j < al.length; j++) {
        if (!MENU_IDX[normItemName(al[j])]) MENU_IDX[normItemName(al[j])] = rec;
      }
    }
    return MENU_IDX;
  }
  function menuOf(name) {
    var k = normItemName(name);
    if (!k) return null;
    var idx = menuIndex();
    if (idx[k]) return idx[k];
    var best = null, bl = 0;
    for (var key in idx) {
      if (!idx.hasOwnProperty(key) || key.length < 2 || key.length <= bl) continue;
      if (k.indexOf(key) > -1) { best = idx[key]; bl = key.length; }
    }
    return best;
  }
  function menuList() { return MENU.slice(); }


  /* 价目表的一段文字，给 AI 看：同价的归一行，能半笼的单独写清楚半价 */
  function menuText() {
    var lines = [], group = {}, order = [];
    for (var i = 0; i < MENU.length; i++) {
      var m = MENU[i];
      var k = m.price + '|' + (m.by || '个');
      if (m.half) {
        order.push({ half: true, m: m });
      } else {
        if (!group[k]) { group[k] = []; order.push({ k: k }); }
        group[k].push(m.name);
      }
    }
    for (var j = 0; j < order.length; j++) {
      var o = order[j];
      if (o.half) {
        lines.push(o.m.name + ' ' + money(o.m.price) + ' 元/' + (o.m.by || '个') +
          '（可半笼 ' + money(round2(o.m.price / 2)) + ' 元）');
      } else {
        var p = o.k.split('|');
        lines.push(group[o.k].join('、') + ' ' + money(Number(p[0])) + ' 元/' + p[1]);
      }
    }
    return lines.join('\n');
  }

  // 金额页那张价目表（点开看的）
  function menuRows() {
    var h = '';
    for (var i = 0; i < MENU.length; i++) {
      var m = MENU[i];
      h += '<div class="jl-menu-row"><b>' + esc(m.name) + '</b>' +
        '<em>¥' + money(m.price) + '/' + (m.by || '个') +
        (m.half ? '<u>半笼 ¥' + money(round2(m.price / 2)) + '</u>' : '') + '</em></div>';
    }
    return h;
  }
  function canHalf(name) {
    var e = menuOf(name);
    return !!(e && e.half);
  }
  /* 基准单价：半笼折半，只折价目表里写明能半笼的那几样 */
  function basePriceOf(name, half) {
    var e = menuOf(name);
    if (!e) return null;
    return round2(e.unit / (half && e.half ? 2 : 1));
  }

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

  /* 三档价，从硬到软：
   * 1. 本店价目表——老板定的价，最硬；
   * 2. 历史价——只补价目表里没有的（油条、红薯、菜角这些）；
   * 3. 金额页手填的——最高，改一次就按你的来。
   * 以前历史价能盖掉本店价：有人写错一次（三个酱肉包 6 元）就被记成 2 元，
   * 「谁给少了」从此永远查不出来。现在记价时也跳过价目表里有的商品，
   * 自动学来的旧价也不许盖回去（白鸡蛋曾被学成 3.5，店里其实是 1.5）。 */
  function effectivePrice(listFn) {
    var out = {};
    var idx = menuIndex();
    var k;
    for (k in idx) {
      if (idx.hasOwnProperty(k)) out[k] = { unit: idx[k].unit, from: 'menu', by: idx[k].by };
    }
    var hist = learnedPrices(listFn);
    for (k in hist) {
      if (hist.hasOwnProperty(k) && !out[k]) out[k] = hist[k];
    }
    var own = readPrice();
    for (k in own) {
      if (!own.hasOwnProperty(k)) continue;
      /* 本店价目表里有的商品，不让「以前自动学来的旧价」盖掉。
       * 例：某单把白鸡蛋学成 3.5 存进价格本，后来店里明确说蛋是 1.5，
       * 老价还赖着不走，问题清单就会一直拿 3.5 去冤枉人。
       * 老板自己在金额页手填的（manual）仍然最大，那是他主动改的价。 */
      if (out[k] && out[k].from === 'menu' && own[k].from !== 'manual') continue;
      out[k] = { unit: own[k].unit, from: own[k].from || 'manual', at: own[k].at };
    }
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

  /* ==================== 6.5 核单记忆：老板教过的规矩 ====================
   * AI 认字比人快，可它不认识这些客人。谁家群里从不写楼栋、谁回回抹零、
   * 哪样东西绝不能按整笼算——只有老板知道。所以问题清单每条后面留个「教它」：
   * 把原文摊开给他看，他一句话说清，这条规矩就存进本机。
   * 往后三处都用得上：
   *   ① 挑疑点前先过一遍（他说没事的，压根不放出来）；
   *   ② AI 核对的提示词里带着（少犯同一回错）；
   *   ③ 拆单的提示词里也带一句（认名字、认楼栋时就长记性）。
   * 跟价格本一样只存这一台设备，随时能删。 */
  var MEMORY_KEY = 'bamboo.v11.jielong.memory';
  var MEMORY_MAX = 48;

  var MEM_CODE_LABEL = {
    noname: '没写名字', oddname: '名字认得不准', nobld: '没写楼栋', histbld: '楼栋按历史补的',
    noitem: '没认出商品', zeroqty: '件数是 0', bigqty: '件数比平常多', noprice: '没定价',
    oddunit: '单价看着不对', short: '少给了', over: '多给了', pricelow: '比本店价少',
    dup: '同一个人下了好几单', aiadd: '别的问题',
    warmbld: '单独一箱保温'
  };

  // 资料库分栏：认人 / 认货 / 价钱 / 装箱 / 其他——按老板找东西的习惯分，不按代码分
  var MEM_GROUP = {
    noname: '人', oddname: '人', nobld: '人', histbld: '人', dup: '人',
    noitem: '货', zeroqty: '货', bigqty: '货',
    noprice: '钱', oddunit: '钱', short: '钱', over: '钱', pricelow: '钱',
    warmbld: '箱', aiadd: '其他'
  };
  var MEM_GROUP_ORDER = ['人', '货', '钱', '箱', '其他'];
  var MEM_GROUP_DESC = {
    '人': '谁的名字、住哪栋——拆单时先照这个认',
    '货': '哪样东西怎么认、算几件',
    '钱': '谁回回抹零、哪样不能按整笼算',
    '箱': '冬天谁要单独一箱保温',
    '其他': '别的零碎规矩'
  };

  function readMemory() {
    try {
      if (!root || !root.localStorage) return [];
      var raw = root.localStorage.getItem(MEMORY_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (m) { return m && m.code; });
    } catch (e) { return []; }
  }

  function writeMemory(arr) {
    try {
      if (!root || !root.localStorage) return false;
      root.localStorage.setItem(MEMORY_KEY, JSON.stringify((arr || []).slice(0, MEMORY_MAX)));
      return true;
    } catch (e) { return false; }
  }

  function memKeyOf(m) {
    return [m.code, m.name || '', m.item || '', m.frag || '', m.verdict || ''].join('|');
  }

  /* 一条规矩管不管这一条的闲事：类型相同，再对上人／货／原话里的那一截 */
  function memHit(m, code, order) {
    if (!m || !order || m.code !== code) return false;
    if (m.name && trim(order.name || '') !== m.name) return false;
    if (m.item) {
      var its = order.items || [], has = false;
      for (var i = 0; i < its.length; i++) if (its[i].name === m.item) { has = true; break; }
      if (!has) return false;
    }
    if (m.frag && String(order.raw || '').replace(/\s+/g, '').indexOf(m.frag) < 0) return false;
    return true;
  }

  // 越具体的规矩越先说话：「王姐不写楼栋」压过「谁不写楼栋都不算事」
  function memFind(mem, code, order) {
    var wide = null;
    for (var i = 0; i < mem.length; i++) {
      if (!memHit(mem[i], code, order)) continue;
      if (mem[i].name || mem[i].item || mem[i].frag) return mem[i];
      if (!wide) wide = mem[i];
    }
    return wide;
  }

  function memSave(m) {
    var arr = readMemory();
    var k = memKeyOf(m);
    var out = [m];
    for (var i = 0; i < arr.length && out.length < MEMORY_MAX; i++) {
      if (memKeyOf(arr[i]) !== k) out.push(arr[i]);
    }
    var ok = writeMemory(out);
    return { list: out, ok: ok };
  }

  /* ---------- 老板的一大段话 → 一句能照着做的规矩 ---------- */

  function cleanRule(s) {
    var rows = String(s || '').split('\n'), line = '';
    for (var i = 0; i < rows.length; i++) {
      var x = trim(rows[i]).replace(/^[-*•·]\s*/, '').replace(/^\d+[.、)）]\s*/, '');
      if (x) { line = x; break; }
    }
    line = line.replace(/^(规矩|规则|记下|这一句)[:：]\s*/, '');
    line = line.replace(/^["'“”「『（(]+/, '').replace(/["'“”」』）)]+$/, '');
    line = line.replace(/[。；;]\s*$/, '');
    return trim(line).slice(0, 48);
  }

  // 没接 AI、或 AI 没吭声时：从原话里挑一句最像规矩的，别把一大段生塞进记忆
  function fallbackRule(say) {
    var s = trim(say);
    if (!s) return '';
    var NEG = /别|不要|不用|不必|记得|以后|下次/;      // 带这些字的，通常才是「规矩」本身
    var HARD = /(\d+|[一二三四五六七八九十两]+)\s*(栋|幢|号楼|单元|室|号|楼)|门牌|电话|微信/;

    var atoms = [], raw = s.split(/[。；！？!?;，,、\n]+/);
    for (var i = 0; i < raw.length; i++) {
      if (trim(raw[i])) atoms.push(trim(raw[i]));
    }
    if (!atoms.length) return '';

    var hard = -1, neg = -1;
    for (var j = 0; j < atoms.length; j++) {
      if (hard < 0 && HARD.test(atoms[j])) hard = j;
      if (neg < 0 && NEG.test(atoms[j])) neg = j;
    }

    // 楼栋、门牌这种眼见为实的东西，只要有就必须带上——丢了它就等于没教
    if (hard >= 0) {
      var head = atoms[hard];
      if (head.length > 30) head = head.slice(0, 28) + '…';
      if (neg >= 0 && neg !== hard) {
        var tail = atoms[neg];
        var pair = neg < hard ? (tail + '，' + head) : (head + '，' + tail);
        if (pair.length <= 30) return cleanRule(pair);
      }
      return cleanRule(head);
    }

    if (neg >= 0) {
      // 没硬信息，就把带「别」的那句连同前一句带上，别超过 30 字
      for (var st = Math.max(0, neg - 2); st <= neg; st++) {
        var cand = atoms.slice(st, neg + 1).join('，');
        if (cand.length <= 30 || st === neg) return cleanRule(cand);
      }
    }

    var first = atoms.slice(0, 2).join('，');
    if (first.length > 30) first = atoms[0].slice(0, 28) + '…';
    return cleanRule(first);
  }

  function distillPrompt(issue, order, verdict, say) {
    var L = [];
    L.push('你是早餐铺的记账帮手。老板刚指正了你一条判断，他用大白话讲了一段，你把它收成一句能直接照着做的规矩。');
    L.push('');
    L.push('【你挑的毛病】' + (MEM_CODE_LABEL[issue.code] || issue.title || ''));
    if (order) L.push('【那一单】#' + order.no + ' ' + String(order.raw || '').slice(0, 120));
    L.push('【老板的结论】' + (verdict === 'keep' ? '这条确实有问题，以后要当回事' : '这条不算问题，以后别再挑出来'));
    L.push('');
    L.push('【老板的原话】');
    L.push(say);
    L.push('');
    // 已经记过的规矩摆出来，免得同一件事记成两条、或者前后打架
    var old = memPromptText(10);
    if (old) {
      L.push('【资料库里已经有的规矩】别重复，也别写反；这次说的跟它冲突，就按这次写');
      L.push(old);
      L.push('');
    }
    L.push('【怎么写这句规矩】');
    L.push('- 只写一句，20 字以内，用「……就……」「……要……」「……别……」这种能直接执行的口气');
    L.push('- 说人话，别用「用户」「该客户」「需注意」「建议」这类字眼');
    L.push('- 他提到的人名、楼栋、门牌、叫法，原样照抄，一个字都别改');
    L.push('- 不要引号、不要编号、不要解释，只给这一句');
    return L.join('\n');
  }

  /* 把老板的长段话交给 AI 收成一句。8 秒不回来就先按本地挑的记下，
   * 绝不让「记下」这个按钮卡在半路。 */
  function distillRule(issue, order, verdict, say) {
    var src = trim(say);
    if (!src) return Promise.resolve('');
    var local = function () { return fallbackRule(src); };
    if (!auditAiReady()) return Promise.resolve(local());
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      var timer = setTimeout(function () { finish(local()); }, 8000);
      try {
        D.askAI(distillPrompt(issue, order, verdict, src), { maxTokens: 120 }).then(function (out) {
          clearTimeout(timer);
          finish(cleanRule(out) || local());
        }).catch(function () {
          clearTimeout(timer);
          finish(local());
        });
      } catch (e) {
        clearTimeout(timer);
        finish(local());
      }
    });
  }

  /* 老板点下「记下」的那一下，把这条判断收成规矩：
   * 记人（名字／楼栋类）、记货（商品类）、记原话，实在没有才只记类型。 */
  function memFromIssue(code, order, verdict, note, wide, srcRaw, say) {
    var m = {
      id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      at: Date.now(), day: todayStr(),
      code: code || 'aiadd',
      verdict: verdict === 'keep' ? 'keep' : 'drop',
      note: trim(note).slice(0, 48),
      say: trim(say).slice(0, 200),
      src: trim(srcRaw || (order && order.raw) || '').slice(0, 90)
    };
    if (!wide && order) {
      var nm = trim(order.name || '');
      var item = (order.items && order.items[0]) ? order.items[0].name : '';
      if (/^(noname|oddname|nobld|histbld|dup)$/.test(m.code)) {
        if (nm) m.name = nm; else if (item) m.item = item;
      } else if (/^(noitem|zeroqty|bigqty|noprice|oddunit|pricelow)$/.test(m.code)) {
        if (item) m.item = item; else if (nm) m.name = nm;
      } else {
        // 少给、多给、AI 另外看出来的：多半是这个人的习惯，认人不认货
        if (nm) m.name = nm;
        else if (item) m.item = item;
      }
      if (!m.name && !m.item) {
        var frag = String((order && order.raw) || '').replace(/\s+/g, '').slice(0, 16);
        if (frag) m.frag = frag;
      }
    }
    return m;
  }

  // 给 AI 看的规矩：说人话，一条一行。codes 限定只带哪几类，forParse 换一种口气（拆单用）
  function memPromptText(limit, codes, forParse, skip) {
    var arr = readMemory();
    if (codes && codes.length) {
      arr = arr.filter(function (m) { return codes.indexOf(m.code) >= 0; });
    }
    if (skip && skip.length) {
      arr = arr.filter(function (m) { return skip.indexOf(m.code) < 0; });
    }
    arr = arr.slice(0, limit || 12);
    if (!arr.length) return '';
    var L = [];
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i];
      // 装进箱的规矩说的是楼栋，不是人；别写成「客人「4栋」」闹笑话
      var isBox = m.code === 'warmbld';
      var who = m.name ? (isBox ? '「' + m.name + '」这栋' : '客人「' + m.name + '」的') : '';
      var what = m.item ? '「' + m.item + '」的' : '';
      var lab = isBox ? '' : '「' + (MEM_CODE_LABEL[m.code] || m.code) + '」';
      var scope = (!isBox && !m.name && !m.item) ? '（不分人和货）' : '';
      var tail = m.note ? '：' + m.note : '';
      if (isBox) {
        L.push((i + 1) + ') ' + who + '要单独装一箱保温，派箱子时先给它留一个' + tail);
      } else if (m.hand) {
        // 老板自己写的一条，本来就写成一句人能懂的话，别再套「某个毛病确有其事」的壳
        var hWho = m.name ? '客人「' + m.name + '」：' : (m.item ? '「' + m.item + '」：' : '');
        L.push((i + 1) + ') ' + hWho + (m.note || '') + '（老板自己写的规矩，照办）');
      } else if (forParse) {
        L.push((i + 1) + ') ' + who + what + lab + scope +
          (m.verdict === 'drop'
            ? '不算问题（老板确认过），照原样认，不要自作聪明去补、去改'
            : '确有其事（老板确认过），照这个认，别改回去') + tail);
      } else if (m.verdict === 'drop') {
        L.push((i + 1) + ') ' + who + what + lab + scope + '不算问题，别再挑出来' + tail);
      } else {
        L.push((i + 1) + ') ' + who + what + lab + scope + '要当真问题，必须留着' + tail);
      }
    }
    return L.join('\n');
  }

  /* ==================== 7. AI 兜底 ==================== */

  function buildPrompt(text, residents) {
    var res = '';
    if (typeof residents === 'string') res = residents;
    else if (residents && typeof residents === 'object') res = residentsText(residents);

    // 群里爱写简称／漏「包」字，列给 AI 让它统一写回价目表里的规范名。
    // 以前提示词第 13 条写着「单价照【本店价目表】填」，可整张表压根没塞进来，AI 是盲拆。
    var aliasLines = [];
    for (var ai = 0; ai < MENU.length; ai++) {
      var am = MENU[ai];
      if (am.alias && am.alias.length) aliasLines.push(am.name + ' ← ' + am.alias.join('、'));
    }
    // 认人认货的规矩在拆单这一步就用得上：谁的名字是昵称、哪一栋从不写、谁常有两单
    var memTxt = memPromptText(10, ['noname', 'oddname', 'nobld', 'histbld', 'noitem', 'zeroqty', 'bigqty', 'pricelow', 'oddunit', 'dup'], true);

    return '你是早餐接龙的拆单助手。下面是一条微信群接龙原文，请拆成结构化订单。\n\n' +
      '【本店价目表】（填 unit、算钱一律以这张表为准；表里没有的商品 unit 留空，绝对不要猜）\n' +
      menuText() + '\n\n' +
      '【简称对照】原文写左边的叫法，items.name 一律写成箭头右边的规范名\n' +
      aliasLines.join('\n') + '\n\n' +
      (res ? '【这群人的历史住处】（原文没写楼栋时按名字查这里补，buildingFrom 填 "history"；原文写了就填 "text"，不要改）\n' + res + '\n\n' : '') +
      (memTxt ? '【老板交代过的】（他确认过的实情，遇到相近的照这个认，别自作聪明改回去）\n' + memTxt + '\n\n' : '') +
      '【原文】\n' + String(text).slice(0, 6000) + '\n\n' +
      '【输出格式】只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。\n' +
      '{"title":"","orders":[{"no":1,"name":"张三","building":"3栋","room":"301","buildingFrom":"text","raw":"1. 3栋张三 豆浆2杯 10元","items":[{"name":"豆浆","qty":2,"unit":null,"half":false}],"total":10,"note":""}]}\n' +
      '（raw 必须是这一单的原文整行，含序号，程序要用它认「半笼」和核对问题清单）\n\n' +
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
      '11. 不要改人名，也不要把两个人合并成一条。\n' +
      '12. 「半笼小笼包」「半笼蒸饺」这种：qty 填 1，half 填 true（小笼包、灌汤小笼包、玉米蒸饺都可以半笼）。原文出现「半笼/半份」就一定要给 half:true，别丢。\n' +
      '13. 单价照【本店价目表】填：白鸡蛋／鸡蛋／白水蛋／白蛋一律 1.5 元一个，不是 3.5；半笼蒸饺 3 元、半笼小笼包 3 元、半笼灌汤小笼包 3.5 元。\n' +
      '14. 名字和商品连写、中间没空格也要拆开：「A栋，蔡徐坤一个鲜肉一个香菇青菜4.5」\n' +
      '    → building「A栋」、name「蔡徐坤」、items 两条（鲜肉包 ×1、香菇青菜包 ×1）、total 4.5。\n' +
      '    「E huh 一个鲜肉，一个酱肉，5」→ building「E栋」、name「huh」、items 鲜肉包 ×1＋酱肉包 ×1、total 5。\n' +
      '    行首单个大写字母（E / D / A）是楼栋，不是名字的一部分；「Aurora(A栋)」里的 A 不是楼栋。\n' +
      '15. 中文数字金额照样认：「七块」= 7、「十块」= 10、「两块五」= 2.5，填进 total。\n' +
      '16. 行末孤立的小数也是整单总价：「1土豆1茄包1白蛋。5.5，」的 5.5 填 total，\n' +
      '    别当成某样商品的单价；「3r」「2.5r」的 r 就是「元」，同样按整单总价处理。\n' +
      '17. items.name 一律用【本店价目表】里的规范名，别保留原文简称，\n' +
      '    否则「白鸡蛋／白蛋／水煮蛋」会在金额页被当成三样不同商品分开装箱。\n' +
      '18. 「一个香菇冬笋」「1土豆」这种漏了「包」字的，按【简称对照】补成规范名，不要整样丢掉。\n';
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
          items.push({ name: nm, qty: q, unit: u, fromText: u != null, half: it.half ? true : null });
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
    var rawRec = {
      date: opts.date || todayStr(),
      title: trim(obj.title) || '',
      orders: out,
      source: 'ai',
      conf: 0.9
    };
    // AI 也会漏：不认识的包子它干脆不提。本地已经认得「…包」了，补回来
    if (opts.sourceText) {
      try { rescueItems(rawRec, opts.sourceText); } catch (e) { }
      try { backfillRaw(rawRec, opts.sourceText); } catch (e) { }
      /* 不在新拆的单上改单价：收款金额得按原文／AI 认出来的算，涨价、特价都算数。
       * 本店价只用于「问题清单」比价；旧笔记里的错价在 decodeNote 时才校准。 */
    }
    var rec = finalize(rawRec, opts);
    if (obj.boxes && Array.isArray(obj.boxes)) rec.boxAi = obj.boxes;
    return { ok: true, record: rec };
  }

  /* AI 常常不把原文行带回来。没有原文，问题清单就没了「原句」，
   * 「半笼」也没处认。本地逐行拆出来的 raw 才是真原文，按序号回填。 */
  function backfillRaw(record, text) {
    var local;
    try { local = parseText(text, { date: record.date }); } catch (e) { return; }
    if (!local || !local.orders) return;
    var byNo = {};
    for (var i = 0; i < local.orders.length; i++) {
      if (local.orders[i].raw) byNo[local.orders[i].no] = local.orders[i].raw;
    }
    for (var j = 0; j < record.orders.length; j++) {
      var o = record.orders[j];
      if (byNo[o.no]) o.raw = byNo[o.no];
      // AI 有时会重新从 1 编号，按 no 就对不上了，退一步按位置兜底
      else if (!o.raw && local.orders[j] && local.orders[j].raw) o.raw = local.orders[j].raw;
    }
  }

  /* AI 漏商品兜底：只补「AI 完全没有这一样」，不跟 AI 争件数和价钱。
   * 因为「少一件没送到」比「多算一件」严重得多。
   */
  function rescueItems(record, text) {
    var local;
    try { local = parseText(text, { date: record.date }); } catch (e) { return; }
    if (!local || !local.orders || !local.orders.length) return;

    var added = 0;
    for (var i = 0; i < record.orders.length; i++) {
      var o = record.orders[i];
      // 先按序号找，序号丢了再按名字找
      var l = null, k;
      for (k = 0; k < local.orders.length; k++) {
        if (local.orders[k].no === o.no) { l = local.orders[k]; break; }
      }
      if (!l && o.name) {
        for (k = 0; k < local.orders.length; k++) {
          if (local.orders[k].name && local.orders[k].name === o.name) { l = local.orders[k]; break; }
        }
      }
      if (!l || !l.items.length) continue;

      // AI 爱写全称、本地认别名（玉米鲜肉蒸饺 / 玉米饺），不归一就会重复补一份
      var canon = function (n) {
        var mo = menuOf(n);
        return normItemName(mo ? mo.name : n);
      };
      var have = {};
      for (k = 0; k < o.items.length; k++) have[canon(o.items[k].name)] = true;

      for (k = 0; k < l.items.length; k++) {
        var it = l.items[k];
        if (!it.name || have[canon(it.name)]) continue;
        if (!(it.qty > 0 && it.qty < 50)) continue;
        o.items.push({
          name: it.name, qty: it.qty,
          unit: it.fromText ? it.unit : null,   // 原文明确写了价的才带上，不猜
          fromText: !!it.fromText, fromLocal: true
        });
        added += it.qty;
      }
    }
    if (added) record.rescued = added;
    return added;
  }

  /* 让 AI 看着这一单排箱：只回「哪几栋放一箱、为什么」，件数本地自己算 */
  function buildBoxPrompt(record, cap) {
    var b = record.buildings || [];
    var lines = [];
    for (var i = 0; i < b.length; i++) {
      var rooms = b[i].orders.map(function (o) { return o.room || '?'; }).join(' ');
      lines.push(b[i].key + '：' + b[i].cups + ' 件，' + b[i].orders.length + ' 单，房号 ' + (rooms || '—'));
    }
    // 资料库里跟装箱有关的：哪栋要单独一箱、哪几栋总是混着装
    var memTxt = memPromptText(8, ['warmbld'], true);
    return '你是早餐配送的装箱助手。我骑电动车送学校，有 3 个泡沫箱，每箱最多装 ' + cap + ' 件杯装（豆浆、玉米汁，容易洒）。\n\n' +
      '这一单的楼栋：\n' + lines.join('\n') + '\n合计 ' + record.totals.cups + ' 件。\n\n' +
      (memTxt ? '【老板交代过的装箱规矩】跟下面冲突时以这里为准：\n' + memTxt + '\n\n' : '') +
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
          raw: trim(o.raw || '').slice(0, 90),
          items: o.items.map(function (i) { return { name: i.name, qty: i.qty, unit: i.unit, fromText: !!i.fromText, half: i.half == null ? null : !!i.half, priceFrom: i.priceFrom || '' }; }),
          total: o.total == null ? null : o.total,
          note: o.note || '', manual: !!o.manual
        };
      }),
      photos: (record.photos || []).map(function (p) {
        return { key: p.key, building: p.building, at: p.at };
      }),
      boxAi: record.boxAi || null,
      // 送达凭证上改过的名单（谁撤回了、几号改成谁）。只影响那张图，不动订单
      namesFix: (record.namesFix && record.namesFix.length) ? record.namesFix : null,
      issueSkip: (record.issueSkip && Object.keys(record.issueSkip).length) ? record.issueSkip : null,
      audit: record.audit || null,
      auditErr: trim(record.auditErr || '').slice(0, 160) || null,
      srcText: trim(record.sourceText || '').slice(0, 3000) || null
    };
    return plain + '\n' + MARK + JSON.stringify(data);
  }

  /* 打开旧笔记时校准单价：v15.10 之前白鸡蛋被学成 ¥3.5、半笼蒸饺按整笼 ¥6 存过，
   * 那些都是程序／AI 填的，不是老板手填的。本店价目表定了的，一律按表重算，
   * 不然老板点开旧记录，金额页和问题清单里还挂着错的 3.5。 */
  function calibrateSavedRecord(rec) {
    if (!rec || !Array.isArray(rec.orders)) return rec;
    for (var i = 0; i < rec.orders.length; i++) {
      var o = rec.orders[i];
      applyHalfFromRaw(o);                 // 原文写了「半笼」，旧笔记里可能没存下来
      // 没有原句的（测试造的单、别人手工拼的记录）别乱改人家的单价
      if (!o.raw) continue;
      var its = o.items || [];
      for (var j = 0; j < its.length; j++) {
        var it = its[j], mo = menuOf(it.name);
        if (!mo) continue;
        var h = !!(it.half && mo.half);
        // 老板手填的最大，不改；唯独「半笼却记着整笼价」是明显错数据
        if (it.priceFrom === 'fixed' && !(h && Math.abs(Number(it.unit) - mo.unit) < 0.01)) continue;
        it.unit = round2(mo.unit / (h ? 2 : 1));
        it.priceFrom = 'book';
        it.fromText = false;
        if (it.amount != null && it.qty > 0) it.amount = round2(it.unit * it.qty);
      }
    }
    return rec;
  }

  function decodeNote(text) {
    var s = String(text == null ? '' : text);
    var i = s.lastIndexOf(MARK);
    if (i < 0) return null;
    var json = s.slice(i + MARK.length);
    try {
      var d = JSON.parse(json);
      if (!d || !Array.isArray(d.orders)) return null;
      return calibrateSavedRecord(d);
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
          var oi = o.items[k];
          parts.push(oi.name + (oi.half ? ' 半笼' + (oi.qty > 1 ? '×' + oi.qty : '') : '×' + oi.qty));
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
    warm: false,      // 冬天保温：一箱只装一栋
    proofNames: true, // 送达凭证加长版：图下方附「接龙号 · 名字」
    memFrom: 'home',  // 从哪进来资料库的，返回时回哪去
    openBld: '',
    proofUrl: '',
    proofBlob: null,
    proofBld: '',
    refPrice: null,   // 价格本快照，判断「这次比平时给少了」用
    auditBusy: false, // AI 正在逐条核问题
    auditErr: '',     // 上次核对失败的原因
    lpAt: 0           // 长按发生的时刻，抬手那一下别当成选楼栋
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
    var aiDone = !!(V.record && V.record.audit);
    var issueN = V.record ? auditIssues(V.record, V.refPrice).issues.length : 0;
    var tabs = [['bld', '楼栋'], ['box', '装箱'], ['money', '金额'], ['proof', '送达'], ['issue', '问题']];
    return '<div class="jl-tabs">' + tabs.map(function (x) {
      return '<button type="button" data-act="tab" data-v="' + x[0] + '"' +
        (V.tab === x[0] ? ' class="on"' : '') + '>' + x[1] +
        (x[0] === 'proof' && V.photos.length ? '<i>' + V.photos.length + '</i>' : '') +
        (x[0] === 'issue' && issueN
          ? '<i class="jl-tab-issue' + (aiDone ? '' : ' todo') + '">' + issueN + '</i>' : '') +
        '</button>';
    }).join('') + '</div>';
  }

  function itemText(o) {
    if (!o.items.length) return '<em class="jl-warn">没写商品</em>';
    return o.items.map(function (i) {
      var q = i.half
        ? ('半' + (canHalf(i.name) ? '笼' : '份') + (i.qty > 1 ? '×' + i.qty : ''))
        : ('×' + i.qty);
      return '<span class="jl-gi">' + esc(i.name) + '<b>' + q + '</b></span>';
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

    /* AI 资料库：这一页先摆出来，让人知道它一直在背后记着 */
    var memN = readMemory().length;
    var memo = memorySummary();
    h += '<div class="jl-memcard" data-act="openmem">' +
      '<div class="jl-memcard-l"><b>AI 资料库</b>' +
      '<span>' + (memN
        ? '记着 ' + memN + ' 条你的规矩，每回拆单、核对、排箱都先走一遍'
        : '还没有规矩。在「问题」里点「教它」，它就一直记着') + '</span>' +
      (memo ? '<em>' + esc(memo) + '</em>' : '') +
      '</div>' +
      '<div class="jl-memcard-r"><b>' + memN + '</b><i>条</i></div>' +
      '</div>';
    return h;
  }

  /* 首页卡片上那一行摘要：挑最近记的一条说，比光报数字有用 */
  function memorySummary() {
    var arr = readMemory();
    if (!arr.length) return '';
    var m = arr[0];
    var g = MEM_GROUP[m.code] || '其他';
    return '最近记的：' + (m.note || MEM_CODE_LABEL[m.code] || '') + '（' + g + '）';
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
    else if (V.tab === 'issue') h += tabIssues(r);
    else h += tabProof(r);
    h += '<div class="jl-detail-acts">' +
      '<button type="button" class="jl-ghost" data-act="newone">再拆一单</button>' +
      '<button type="button" class="jl-danger" data-act="removeone">删掉这一单</button>' +
      '</div>';

    h += '<div class="jl-foot-note">' +
      'AI 负责认人认规格、分清总价还是单价、按名字补楼栋、排箱，也逐条对着原文核问题清单；' +
      '件数和金额始终在这台设备上算，价格本也只存在本机。' +
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

    /* 冬天这条：一箱只装一栋，箱子先给单量最大的几栋 */
    h += '<button type="button" class="jl-warm' + (V.warm ? ' on' : '') + '" data-act="warmmode">' +
      '<i class="jl-warm-sw"></i>' +
      '<span><b>冬天保温：一箱只装一栋</b>' +
      '<em>' + (V.warm
        ? '已开 · 箱子先给份量最大的 ' + Math.min(MAX_BOXES, r.buildings.filter(function(x){return x.cups>0;}).length) + ' 栋，剩下的装保温袋'
        : '开着的话，最多三箱各装一栋，不会把两栋混一箱') + '</em></span>' +
      '</button>';

    if (!p.mode) {
      h += '<div class="jl-empty">还没有件数，先在「楼栋」里补上商品</div>';
      return h;
    }

    if (D && D.hasAI() && !p.warm) {
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
    if (p.warm) {
      var pinnedN = p.boxes.filter(function (x) { return x.pinned; }).length;
      h += '<div class="jl-alert jl-alert-soft"><b>保温模式：一箱一栋</b>' +
        '<span>按件数从多到少发箱子（件多说明这栋要保温的量最大；件数一样看单数），最多 ' + MAX_BOXES + ' 个。' +
        (pinnedN ? '其中 ' + pinnedN + ' 栋是你教过要单独一箱的，先给它们留了。' : '') +
        '没分到箱子的那几栋，装保温袋拎着就行。</span></div>';
    }

    h += '<div class="jl-boxes">';
    for (var i = 0; i < p.boxes.length; i++) {
      var b = p.boxes[i];
      var fill = b.fill > 100 ? 100 : b.fill;
      h += '<div class="jl-box' + (p.warm ? ' jl-box-warm' : '') + '">' +
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
        (b.orders.length ? '<div class="jl-box-f">' + b.orders.length + ' 单' +
          (p.warm ? '，一箱就这一栋，到楼下直接拎上去' : '，一栋一栋送') + '</div>' : '') +
        (b.pinned ? '<div class="jl-box-pin">你教过：这栋单独一箱</div>' : '') +
        (b.over ? '<div class="jl-box-over">这栋 ' + b.cups + ' 件，超过一箱 ' + p.cap + ' 件，得再带一个袋子</div>' : '') +
        '</div>';
    }
    h += '</div>';

    if (p.overflow.length) {
      var ov = 0;
      for (var q = 0; q < p.overflow.length; q++) ov += p.overflow[q].cups;
      if (p.warm) {
        h += '<div class="jl-alert">' +
          '<b>这 ' + p.overflow.length + ' 栋没分到箱子（共 ' + ov + ' 件）</b>' +
          '<span>' + p.overflow.map(function (x) {
            return esc(x.key) + ' ' + x.cups + ' 件' + (x.orders ? ' / ' + x.orders + ' 单' : '');
          }).join('、') + ' —— 装保温袋拎着，或者回头再跑一趟</span></div>';
        var pinCand = p.overflow.filter(function (x) { return x.key !== '未写楼栋'; });
        if (pinCand.length) {
          h += '<div class="jl-warm-pins"><b>哪栋以后都得单独一箱？点一下，我记住</b><div>' +
            pinCand.map(function (x) {
              return '<button type="button" class="jl-chip-pin" data-act="pinwarm" data-k="' + esc(x.key) + '">' +
                esc(x.key) + '＋</button>';
            }).join('') + '</div></div>';
        }
      } else {
        h += '<div class="jl-alert">' +
          '<b>还有 ' + ov + ' 件装不进箱子</b>' +
          '<span>' + p.overflow.map(function (x) { return esc(x.key) + ' ' + x.cups + ' 件'; }).join('、') +
          ' —— 单独保温袋拎着</span></div>';
      }
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

  /* ==================== 挑毛病：哪些单要回头核 ====================
   * 只按本地算得出来的东西挑，不猜：名字、楼栋、件数、单价、总价对不对得上。
   * 每条问题都挂在一个接龙序号上，点一下就能去改那一单。
   */

  function issueKey(it) { return it.no + '|' + it.code; }

  /* 这一样「应该」多少钱：本店价目表里有的，一律按本店价（半笼折半）。
   * 问题清单写着「按本店价算是」，就得真拿本店价算。以前先信拆单时记下的 it.unit，
   * 可那个价常常是 AI 照旧价目表／价格本填的——白鸡蛋被填成 3.5，就一直拿 3.5 冤枉人。
   * 牌子以外的商品（油条、红薯、菜角）没有本店价，才退回原文单价／学来的价。 */
  function expectUnit(it, ref) {
    var mo = menuOf(it.name);
    if (mo) return round2(mo.unit / ((it.half && mo.half) ? 2 : 1));
    if (it.unit != null && it.fromText !== false) return it.unit;
    var u = baseUnitOf(it, ref);
    if (u != null) return u;
    return it.unit != null ? it.unit : null;
  }
  // 基准价：本店价目表优先，没有才用价格本里学来的／手填的
  function baseUnitOf(it, ref) {
    var e = menuOf(it.name) || (ref && ref[it.name]);
    if (!e || typeof e.unit !== 'number') return null;
    var h = !!it.half && canHalf(it.name);
    return round2(e.unit / (h ? 2 : 1));
  }
  // 这个价是「本店定的」还是「平时学来的」——文案要说清，不然老板不知道该信谁
  function isMenuPrice(name, ref) {
    var e = ref && ref[name];
    if (e) return e.from === 'menu';
    return !!menuOf(name);
  }

  /* 本地初筛：规则能挑出来的疑点，不是结论。
   * 每条都带上原文那一行——AI 核实时必须对着原文看，只看拆出来的结果会把好人冤枉。 */
  function auditCandidates(record, refPrice) {
    var orders = (record && record.orders) || [];
    var ref = (refPrice && typeof refPrice === 'object') ? refPrice : {};
    var skip = (record && record.issueSkip) || {};
    var raw = [];
    var shortSum = 0, overSum = 0;
    var names = {};

    for (var i = 0; i < orders.length; i++) {
      var nm = trim(orders[i].name || '');
      if (nm) names[nm] = (names[nm] || 0) + 1;
    }

    // diff：正数是少收、负数是多收。AI 判成误报时要按它把钱退回去
    function put(o, code, level, title, detail, diff) {
      raw.push({
        no: o.no, code: code, level: level, title: title, detail: detail || '',
        src: trim(o.raw || ''), diff: diff || 0
      });
    }

    var seenName = {};
    for (var k = 0; k < orders.length; k++) {
      var o = orders[k];
      var c = cupCount(o);
      var name = trim(o.name || '');

      /* 1. 名字 */
      if (!name) put(o, 'noname', 'warn', '没写名字', '群里按 #' + o.no + ' 问一句是谁的');
      else if (name.length > 8 || /[块杯个碗份笼瓶盘栋楼室]/.test(name) ||
        findItems(name).items.length) {           // 名字里带着商品名，多半是把商品当人了
        put(o, 'oddname', 'info', '名字可能认得不准', '现在写的是「' + name + '」');
      }

      /* 2. 楼栋 */
      if (!o.building) {
        put(o, 'nobld', 'warn', '没写楼栋', '送货前先问清哪一栋，或者去历史记录里按名字找');
      } else if (o.buildingFrom === 'history') {
        put(o, 'histbld', 'info', '楼栋是按历史记录补的', '以前记的是 ' + o.building + '，顺口确认一下');
      }

      /* 3. 商品与数量 */
      if (!o.items.length) put(o, 'noitem', 'error', '没认出来买的是什么', '回原文补一下，不然没法配货');
      if (!c) put(o, 'zeroqty', 'error', '件数是 0', '数量没认出来，补一下');
      else if (c > 15) put(o, 'bigqty', 'warn', '这一单 ' + c + ' 件，比平常多', '核对下是不是数量认错了');

      /* 4. 单价：没填的、离谱的 */
      var lack = [];
      for (var m = 0; m < o.items.length; m++) {
        var it = o.items[m];
        if (it.unit == null) lack.push(it.name);
        if (it.unit != null && (it.unit > 30 || it.unit === 0)) {
          put(o, 'oddunit', 'warn', '「' + it.name + '」单价 ¥' + money(it.unit) + ' 看着不对',
            '可能是房号、件数被当成了钱，去金额页改一下');
        }
      }
      if (lack.length) {
        put(o, 'noprice', 'warn', '没定价：' + lack.join('、'), '金额页填一次单价，下回自动带出来');
      }

      /* 5. 原文写了总价：按本店价重算一遍，看多给少给
       * 以前是拿「拆出来的单价」对总价，可单价本身就是从总价反推的，永远对得上——
       * 「两个酱肉包 4 元」这种少给一直查不出来。现在改成跟价目表比。 */
      var totalCase = (o.total != null && o.items.length > 0);
      if (totalCase) {
        var expSum = 0, expOk = true, brief = [];
        for (var t1 = 0; t1 < o.items.length; t1++) {
          var ti = o.items[t1];
          var eu = expectUnit(ti, ref);
          if (eu == null) { expOk = false; break; }
          expSum = round2(expSum + eu * ti.qty);
          brief.push(ti.name + (ti.half ? '半笼' : '') + ' ¥' + money(eu) + '×' + ti.qty);
        }
        if (expOk) {
          var diff = round2(expSum - o.total);
          var why = '原文写 ¥' + money(o.total) + '，按本店价算是 ¥' + money(expSum) +
            (brief.length > 1 ? '（' + brief.join('、') + '）' : '');
          if (diff >= 0.5) {
            shortSum = round2(shortSum + diff);
            put(o, 'short', 'error', '少给了 ¥' + money(diff), why, diff);
          } else if (diff <= -0.5) {
            overSum = round2(overSum - diff);
            put(o, 'over', 'warn', '多给了 ¥' + money(-diff), why, diff);
          }
        }
      }

      /* 6. 没写总价的：逐样跟本店价比。半笼按半价（小笼包 ¥3、灌汤小笼包 ¥3.5、蒸饺 ¥3） */
      if (!totalCase) {
        for (var n2 = 0; n2 < o.items.length; n2++) {
          var it2 = o.items[n2];
          if (!it2.fromText || it2.unit == null || !(it2.qty > 0)) continue;
          var half2 = !!it2.half && canHalf(it2.name);
          var oldUnit = baseUnitOf(it2, ref);
          if (oldUnit == null || oldUnit <= 0) continue;
          var gap = round2((oldUnit - it2.unit) * it2.qty);
          var menuRef = isMenuPrice(it2.name, ref);
          if (gap >= (menuRef ? 0.5 : 1)) {
            shortSum = round2(shortSum + gap);
            put(o, 'pricelow', 'error',
              '「' + it2.name + '」' + (menuRef ? '比本店价少' : '比平时少') + ' ¥' + money(gap),
              '这单记 ¥' + money(it2.unit) + '/' + (half2 ? '半笼' : '份') +
              '，' + (menuRef ? '本店价 ¥' + money(oldUnit) : '平时 ¥' + money(oldUnit)) +
              '/' + (half2 ? '半笼' : '份') + (it2.qty > 1 ? '，' + it2.qty + ' 份共少 ¥' + money(gap) : ''), gap);
          }
        }
      }

      /* 7. 同一个人下了好几单 */
      if (name && names[name] > 1 && !seenName[name]) {
        seenName[name] = 1;
        put(o, 'dup', 'info', name + ' 下了 ' + names[name] + ' 单', '合在一起送，别漏了其中一单');
      }
    }

    /* 8. 先过一遍老板教过的规矩。
     * 他说「这条不算事」的，压根不放出来（钱也跟着退回去，不能一边说没事一边还算少收）；
     * 他说「这条要当真」的，抬成红字，AI 判成误报也翻不掉。 */
    var mem = readMemory();
    var byNo = {};
    for (var q = 0; q < orders.length; q++) byNo[orders[q].no] = orders[q];
    var kept = [], memDrop = 0, memKeep = 0;
    for (var w = 0; w < raw.length; w++) {
      var one = raw[w];
      var rule = mem ? memFind(mem, one.code, byNo[one.no]) : null;
      if (rule && rule.verdict === 'drop') {
        memDrop++;
        if (one.diff > 0) shortSum = round2(shortSum - one.diff);
        else if (one.diff < 0) overSum = round2(overSum + one.diff);
        continue;
      }
      if (rule && rule.verdict === 'keep') {
        memKeep++;
        one.memWhy = trim(rule.note) || '你说过这条要留意';
        if (one.level !== 'error') one.level = 'error';
      }
      kept.push(one);
    }

    return {
      raw: kept, short: shortSum, over: overSum, orders: orders.length,
      memDrop: memDrop, memKeep: memKeep
    };
  }

  /* 把 AI 的核实结果套在候选上。AI 说「不是问题」的挪进 dropped，不直接删——
   * 它也会看错，随时能点回来；钱也跟着退回去，不能一边说没事一边还算少收。 */
  function auditIssues(record, refPrice) {
    var cands = auditCandidates(record, refPrice);
    var audit = (record && record.audit) || null;
    var skip = (record && record.issueSkip) || {};
    var overrule = (audit && audit.overrule) || {};
    var vd = (audit && audit.verdict) || {};
    var orders = (record && record.orders) || [];
    var shortSum = cands.short, overSum = cands.over;
    var issues = [], dropped = [], hidden = 0;

    function undo(it) {
      if (!it.diff) return;
      if (it.diff > 0) shortSum = round2(shortSum - it.diff);
      else overSum = round2(overSum + it.diff);
    }

    for (var q = 0; q < cands.raw.length; q++) {
      var it = cands.raw[q];
      var key = issueKey(it);
      if (skip[key]) { hidden++; continue; }
      var v = vd[key];
      var one = {
        no: it.no, code: it.code, level: it.level, title: it.title, detail: it.detail,
        src: it.src, key: key, aiWhy: '', aiDrop: '', aiAdd: false, memWhy: it.memWhy || ''
      };
      // 老板亲手教的比 AI 的话硬：他说这条要当真，AI 判成误报也留下
      if (v && v.v === 'drop' && !overrule[key] && !it.memWhy) {
        one.aiDrop = v.why || '对着原文看，这条不成立';
        undo(it);
        dropped.push(one);
        continue;
      }
      if (v && v.v === 'keep') one.aiWhy = v.why || '对着原文核过，确实是这样';
      issues.push(one);
    }

    /* AI 自己看出来的：本地规则没想到的漏单、漏样、件数不符 */
    if (audit && audit.add && audit.add.length) {
      var nums = {};
      for (var a1 = 0; a1 < orders.length; a1++) nums[orders[a1].no] = 1;
      for (var a2 = 0; a2 < audit.add.length; a2++) {
        var ad = audit.add[a2];
        if (!nums[ad.no]) continue;
        // 这一单本地已经挑出毛病了，就不再叠一条，免得一单两行
        var dup = false;
        for (var a3 = 0; a3 < issues.length; a3++) {
          if (issues[a3].no === ad.no && issues[a3].code !== 'aiadd') { dup = true; break; }
        }
        if (dup) continue;
        issues.push({
          no: ad.no, code: 'aiadd', level: ad.level || 'warn',
          title: ad.title, detail: ad.detail || '', src: '', key: ad.no + '|aiadd',
          aiWhy: '', aiDrop: '', aiAdd: true
        });
      }
    }

    var W = { error: 0, warn: 1, info: 2 };
    issues.sort(function (x, y) {
      if (W[x.level] !== W[y.level]) return W[x.level] - W[y.level];
      return x.no - y.no;
    });

    var kept = 0;
    for (var k1 = 0; k1 < issues.length; k1++) if (issues[k1].aiWhy) kept++;

    return {
      issues: issues,
      dropped: dropped,
      hidden: hidden,
      total: cands.raw.length,
      short: round2(shortSum),
      over: round2(overSum),
      orders: orders.length,
      error: issues.filter(function (x) { return x.level === 'error'; }).length,
      ai: audit ? { at: audit.at || 0, kept: kept, drop: dropped.length } : null,
      aiCands: cands.raw.length,
      memDrop: cands.memDrop || 0,
      memKeep: cands.memKeep || 0,
      memCount: readMemory().length
    };
  }

  /* ---------- 让 AI 逐条核对 ---------- */

  function auditAiReady() {
    return !!(D && D.askAI && (!D.hasAI || D.hasAI()));
  }

  function auditSrcText(record) {
    var t = trim((record && record.sourceText) || '');
    if (t) return t.slice(0, 4000);
    var rows = [];
    var os = (record && record.orders) || [];
    for (var i = 0; i < os.length; i++) if (os[i].raw) rows.push('#' + os[i].no + ' ' + os[i].raw);
    return rows.join('\n');
  }

  function buildAuditPrompt(record, cands) {
    var L = [];
    L.push('你是早餐接龙的核单助手。下面是一条微信群接龙的原文、程序拆出来的订单、以及程序按规则挑出来的「疑点」。');
    L.push('请对着原文逐条判断：这条疑点是真的，还是程序看错了。只判断，不要改金额和件数。');
    L.push('');
    L.push('【接龙原文】');
    L.push(auditSrcText(record));
    L.push('');
    L.push('【程序拆出来的】');
    var os = (record && record.orders) || [];
    for (var i = 0; i < os.length; i++) {
      var o = os[i];
      var parts = [];
      for (var j = 0; j < o.items.length; j++) {
        var it = o.items[j];
        parts.push(it.name + (it.half ? '(半笼)' : '') + '×' + it.qty + (it.unit == null ? '(没价)' : ' ¥' + money(it.unit) + '/份'));
      }
      L.push('#' + o.no + ' ' + (o.name || '无名') + ' · ' + (o.building || '没楼栋') +
        (o.room ? ' ' + o.room : '') + ' | ' + (parts.length ? parts.join('，') : '没认出商品') +
        (o.total == null ? '' : ' | 原文总价 ¥' + money(o.total)) +
        ' | 原句：' + (o.raw || '（无）'));
    }
    L.push('');
    L.push('【本店价目表】（算钱一律以这张表为准）');
    L.push(menuText());
    L.push('');
    L.push('【疑点】');
    for (var k = 0; k < cands.raw.length; k++) {
      var c = cands.raw[k];
      L.push((k + 1) + ') #' + c.no + ' 类型' + c.code + ' 标题：' + c.title +
        (c.detail ? ' ｜ ' + c.detail : ''));
    }
    L.push('');
    var memTxt = memPromptText(18, null, false, ['warmbld']);
    if (memTxt) {
      L.push('【老板教过的规矩】他亲手确认过的，跟下面任何一条冲突都以这里为准：');
      L.push(memTxt);
      L.push('');
    }
    L.push('【怎么判断】');
    L.push('- 数字要看语境：写在行末、前面一串商品的（「…一杯豆浆 15 块」），那是整单总价，逐样单价加起来对不上很正常（会抹零、按份算），差不到 1 块不算少给。');
    L.push('- 「半笼」「一份」「两个」「x2」是数量，不是钱。');
    L.push('- 名字是昵称、emoji、字母加数字（y2、魚脆²⁵、😴、h、U）都正常，不像真名不代表是错的。');
    L.push('- 楼栋写成 A、G1、G2-、E栋-301、a栋 都算写了，不要判成「没写楼栋」。');
    L.push('- 「半笼」是半价不是少给：小笼包 ¥3、灌汤小笼包 ¥3.5、玉米蒸饺 ¥3。「半笼玉米蒸饺 3 元」是对的；只写「蒸饺」「玉米饺」也多半是半笼，按 ¥3 算，别按整笼 ¥6 冤枉人。');
    L.push('- 白鸡蛋／鸡蛋／白水蛋／白蛋都是同一个，本店 ¥1.5 一个，不是 ¥3.5；「白鸡蛋+豆浆 3.5 元」正好对得上，不算少给。');
    L.push('- 价格先看【本店价目表】，表里没有的才看历史价。表里有的，按表算；差不到 1 块是抹零，不算少给。');
    L.push('- 一单里被拆成两样的（「玉米蒸饺」拆成玉米+蒸饺）、件数明显跟「两个」对不上的，是真的问题。');
    L.push('');
    L.push('【输出】只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。');
    L.push('{"verdict":[{"no":2,"code":"pricelow","v":"drop","why":"行末 6 元是总价，2 元是单价，跟平时一样"}],"add":[]}');
    L.push('- verdict 要把上面每一条疑点都判一遍，v 只能是 keep（确实有问题）或 drop（程序看错了）。');
    L.push('- why 不超过 30 个字，写清依据；drop 时要指出程序错在哪。');
    L.push('- add 最多 3 条，只加原文里明确看得到的：漏了一整单、某样没算钱、件数跟原文不符。add 的 no 必须是上面出现过的单号，没看出来就给空数组。');
    return L.join('\n');
  }

  /* AI 的话不能直接信：单号要真存在、键要对得上候选、条数要有上限。
   * 不合格的整条丢掉，本地判断照旧——宁可多留一条疑点，也不能让 AI 把真问题说没了。 */
  function parseAuditPayload(text, cands, record) {
    var str = String(text == null ? '' : text);
    var a = str.indexOf('{'), b = str.lastIndexOf('}');
    if (a < 0 || b <= a) return { ok: false, error: 'AI 没返回 JSON' };
    var obj = null;
    try { obj = JSON.parse(str.slice(a, b + 1)); }
    catch (e) {
      var fixed = str.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"');
      try { obj = JSON.parse(fixed); } catch (e2) { return { ok: false, error: 'JSON 解析失败' }; }
    }
    if (!obj || !Array.isArray(obj.verdict)) return { ok: false, error: '没有 verdict' };

    var known = {};
    for (var i = 0; i < cands.raw.length; i++) known[issueKey(cands.raw[i])] = 1;

    var verdict = {}, kept = 0, drop = 0;
    for (var j = 0; j < obj.verdict.length; j++) {
      var v = obj.verdict[j];
      if (!v || typeof v !== 'object') continue;
      var no = parseInt(v.no, 10);
      var code = trim(v.code);
      var key = no + '|' + code;
      if (!known[key] || verdict[key]) continue;
      var d = v.v === 'drop' ? 'drop' : (v.v === 'keep' ? 'keep' : '');
      if (!d) continue;
      verdict[key] = { v: d, why: trim(v.why).slice(0, 40) };
      if (d === 'keep') kept++; else drop++;
    }
    if (!kept && !drop) return { ok: false, error: 'AI 一条都没判对' };

    var add = [], usedNo = {};
    var nums = {};
    var os = (record && record.orders) || [];
    for (var n1 = 0; n1 < os.length; n1++) nums[os[n1].no] = 1;
    if (Array.isArray(obj.add)) {
      for (var m = 0; m < obj.add.length && add.length < 3; m++) {
        var x = obj.add[m];
        if (!x || typeof x !== 'object') continue;
        var no2 = parseInt(x.no, 10);
        if (!nums[no2] || usedNo[no2]) continue;
        var tt = trim(x.title).slice(0, 30);
        if (!tt) continue;
        usedNo[no2] = 1;
        add.push({
          no: no2,
          level: x.level === 'error' ? 'error' : (x.level === 'info' ? 'info' : 'warn'),
          title: tt,
          detail: trim(x.detail).slice(0, 60)
        });
      }
    }
    return {
      ok: true,
      kept: kept,
      drop: drop,
      audit: { at: Date.now(), verdict: verdict, add: add, overrule: {} }
    };
  }

  function applyAudit(rec, audit) {
    rec.audit = audit;
    persist(true);
  }

  // 只改 tab 上的角标，不整页重绘：用户可能正在金额页填单价，重绘会把输入框里的字弄丢
  function refreshIssueBadge() {
    if (!HOST) return;
    var btn = HOST.querySelector('[data-act="tab"][data-v="issue"]');
    if (!btn) return;
    var n = V.record ? auditIssues(V.record, V.refPrice).issues.length : 0;
    var i = btn.querySelector('i');
    if (!n) {
      if (i && i.className === 'jl-tab-issue' && i.parentNode) i.parentNode.removeChild(i);
      return;
    }
    if (!i) {
      i = document.createElement('i');
      i.className = 'jl-tab-issue';
      btn.appendChild(i);
    }
    i.textContent = n;
  }

  function kickAuditAI(rec, manual) {
    if (!rec) return;
    if (!auditAiReady()) {
      if (manual) toast('这台设备还没接上 AI，先按本地规则看');
      return;
    }
    if (V.auditBusy) return;
    var cands = auditCandidates(rec, V.refPrice || effectivePrice(listRecords));
    if (!cands.raw.length) {
      // 本来就没疑点，也算核过了，页面不用一直挂着「还没核」
      rec.audit = { at: Date.now(), verdict: {}, add: [], overrule: {} };
      persist(true);
      if (V.tab === 'issue') paint(); else refreshIssueBadge();
      return;
    }
    V.auditBusy = true;
    if (V.tab === 'issue') paint();
    var token = rec;
    D.askAI(buildAuditPrompt(rec, cands), { maxTokens: 2400 }).then(function (out) {
      if (V.record !== token) { V.auditBusy = false; return; }
      V.auditBusy = false;
      var r = parseAuditPayload(out, cands, rec);
      if (!r.ok) {
        V.auditErr = r.error;
        rec.auditErr = r.error;
        persist(true);
        if (V.tab === 'issue') paint(); else refreshIssueBadge();
        toast('AI 没核成：' + r.error);
        return;
      }
      V.auditErr = '';
      rec.auditErr = '';
      applyAudit(rec, r.audit);
      if (V.tab === 'issue') paint(); else refreshIssueBadge();
      if (manual) toast('核完了：确认 ' + r.kept + ' 条，判为误报 ' + r.drop + ' 条');
    }).catch(function (e) {
      V.auditBusy = false;
      var msg = (e && e.message) ? String(e.message) : 'AI 没回应';
      V.auditErr = msg;
      rec.auditErr = msg;
      persist(true);
      if (V.tab === 'issue') paint(); else refreshIssueBadge();
      toast('AI 没核成：' + msg);
    });
  }

  function tabIssues(r) {
    var a = auditIssues(r, V.refPrice);
    var aiOn = auditAiReady();
    var h = '';

    /* ---------- 顶部：先说清这些结论是谁下的 ---------- */
    var state = 'todo', note = '';
    if (V.auditBusy) {
      state = 'busy';
      note = '正在对着原文逐条看…';
    } else if (a.ai) {
      state = 'done';
      note = a.issues.length
        ? '确认 ' + a.ai.kept + ' 条' + (a.ai.drop ? '，判为误报 ' + a.ai.drop + ' 条' : '')
        : (a.dropped.length ? a.dropped.length + ' 条疑点都判为误报了' : '没挑出疑点，也没看出漏的');
    } else if (!aiOn) {
      state = 'off';
      note = '这台设备没接 AI，下面是本机规则挑的';
    } else if (V.auditErr) {
      state = 'err';
      note = '上次没核成：' + V.auditErr;
    } else {
      note = '还没核过，下面是本机规则挑的';
    }
    if (V.auditErr && !V.auditBusy) note = '上次没核成：' + V.auditErr;
    if (a.memDrop && !V.auditBusy) {
      note = (note ? note + ' · ' : '') + '按你的规矩滤掉 ' + a.memDrop + ' 条';
    }
    // 让它自己说出来：这本资料库确实读过了
    if (a.ai && a.memCount && !V.auditBusy) {
      note = (note ? note + ' · ' : '') + '读了你 ' + a.memCount + ' 条规矩';
    }

    h += '<div class="jl-ai-bar' + (V.auditBusy ? ' busy' : '') + '">' +
      '<div class="jl-ai-bar-l"><em class="jl-ai-dot ' + state + '"></em>' +
      '<b>AI 核对</b><span>' + esc(note) + '</span></div>' +
      (aiOn
        ? '<button type="button" class="jl-ai-btn" data-act="audit"' + (V.auditBusy ? ' disabled' : '') + '>' +
          (V.auditBusy ? '核对中…' : (V.auditErr && !a.ai ? '重试核对' : (a.ai ? '重新核对' : '让 AI 核一遍'))) + '</button>'
        : '') +
      '</div>';
    if (V.auditErr && !V.auditBusy && aiOn) {
      h += '<p class="jl-ai-err-tip">AI 没连上不影响拆单。常见是 Key 过期、余额不足、接口地址填错：到右上角「设置 → 测一下能不能连上」能看到具体是哪一样。</p>';
    }

    /* ---------- 一条都没剩 ---------- */
    if (!a.issues.length) {
      var clearTitle, clearDesc;
      if (!a.orders) {
        clearTitle = '还没有订单';
        clearDesc = '先把接龙贴进来。';
      } else if (a.hidden) {
        clearTitle = '都标成「不用管」了';
        clearDesc = '这一单还有 ' + a.hidden + ' 条是你手动跳过的，放回来还在下面那个按钮里。';
      } else if (a.dropped.length) {
        clearTitle = 'AI 核对完了，都不成立';
        clearDesc = a.dropped.length + ' 条疑点是对着原文看过的，程序想多了。觉得哪条其实是问题，点开下面那条恢复。';
      } else {
        clearTitle = a.ai ? 'AI 核对过，没查出问题' : '没查出问题';
        clearDesc = a.orders + ' 单都对得上：名字、楼栋、件数、金额都跟本店价目表对过。';
      }
      h += '<div class="jl-audit-clear">' +
        '<b>' + clearTitle + '</b>' +
        '<p>' + clearDesc + '</p></div>';
    } else {
      /* ---------- 汇总 ---------- */
      h += '<div class="jl-audit-top">' +
        '<div class="jl-audit-n"><b>' + a.issues.length + '</b><span>条要核对</span>' +
        (a.error ? '<i>' + a.error + ' 条对不上账</i>' : '') + '</div>' +
        '<div class="jl-audit-m">' +
        (a.short > 0 ? '<em>少收 ¥' + money(a.short) + '</em>' : '') +
        (a.over > 0 ? '<em>多收 ¥' + money(a.over) + '</em>' : '') +
        '</div></div>';

      h += '<p class="jl-hint jl-basis">价格对着本店价目表算的：白鸡蛋 ¥1.5、豆浆 ¥2、包子 ¥2～2.5；半笼按一半：小笼包 ¥3、灌汤小笼包 ¥3.5、玉米蒸饺 ¥3。</p>';

      h += '<div class="jl-issues">';
      for (var i = 0; i < a.issues.length; i++) {
        var it = a.issues[i];
        var lv = it.level === 'error' ? ' e' : (it.level === 'warn' ? ' w' : '');
        h += '<div class="jl-issue' + lv + '" data-act="edit" data-no="' + it.no + '">' +
          '<div class="jl-issue-h">' +
          '<i>#' + it.no + '</i>' +
          '<b>' + esc(it.title) + '</b>' +
          (it.aiAdd ? '<em class="jl-ai-tag new">AI 发现</em>'
            : (it.memWhy ? '<em class="jl-ai-tag mine">你说过</em>'
              : (it.aiWhy ? '<em class="jl-ai-tag ok">AI 已确认</em>' : ''))) +
          '<button type="button" class="jl-issue-x jl-issue-teach" data-act="teachissue" data-k="' + esc(it.key) + '">教它</button>' +
          '<button type="button" class="jl-issue-x" data-act="skipissue" data-k="' + esc(it.key) + '">不用管</button>' +
          '</div>' +
          (it.detail ? '<p>' + esc(it.detail) + '</p>' : '') +
          (it.code === 'nobld' ? bldLookupHtml(it.no) : '') +
          (it.memWhy ? '<p class="jl-mem-why">你的规矩：' + esc(it.memWhy) + '</p>' : '') +
          (it.aiWhy ? '<p class="jl-ai-why">AI：' + esc(it.aiWhy) + '</p>' : '') +
          '</div>';
      }
      h += '</div>';

      h += '<p class="jl-hint">点哪条就改哪一单；改完这条自己会消失。它看得不对的，点「教它」说一句，往后先照你的规矩来。</p>';
    }

    /* ---------- AI 判成误报的：不能直接删，随时能捡回来 ---------- */
    if (a.dropped.length) {
      h += '<details class="jl-dropbox"><summary>AI 判为误报 <b>' + a.dropped.length +
        '</b> 条 · 点开看看它怎么说的</summary><div class="jl-issues">';
      for (var j = 0; j < a.dropped.length; j++) {
        var d = a.dropped[j];
        h += '<div class="jl-issue d" data-act="edit" data-no="' + d.no + '">' +
          '<div class="jl-issue-h">' +
          '<i>#' + d.no + '</i>' +
          '<b>' + esc(d.title) + '</b>' +
          '<button type="button" class="jl-issue-x" data-act="restoreissue" data-k="' + esc(d.key) + '">其实是问题</button>' +
          '</div>' +
          (d.src ? '<p class="jl-issue-src">原文：' + esc(d.src) + '</p>' : '') +
          '<p class="jl-ai-why">AI：' + esc(d.aiDrop) + '</p>' +
          '</div>';
      }
      h += '</div></details>';
    }

    if (a.hidden) {
      h += '<button type="button" class="jl-ghost jl-audit-back" data-act="unskipall">' +
        '把忽略的 ' + a.hidden + ' 条放回来</button>';
    }

    /* ---------- 资料库入口：教过什么，摆在这儿，点开能逐条看 ---------- */
    var mem = readMemory();
    h += '<button type="button" class="jl-membox jl-membox-btn" data-act="openmem">' +
      '<b>AI 资料库</b>' +
      '<span>' + (mem.length
        ? '已记 ' + mem.length + ' 条 · 每回拆单、核对、排箱都先读一遍'
        : '还空着 · 点「教它」说一句，往后它就照你的规矩来') + '</span>' +
      '<i>›</i></button>';
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
      var mo = menuOf(it.name);
      var off = !!(mo && it.unit != null && it.unit !== mo.unit && it.unit !== round2(mo.unit / 2));
      h += '<tr><td><span class="jl-td-name">' + esc(it.name) + '</span>' +
        (mo ? '<i class="jl-menu">本店 ¥' + money(mo.unit) + '/' + mo.by +
          (mo.half ? '，半笼 ¥' + money(round2(mo.unit / 2)) : '') + '</i>' : '') +
        '</td><td>' + it.qty + '</td>' +
        '<td><input type="number" min="0" step="0.5" class="jl-price' + (off ? ' jl-price-off' : '') +
        '" data-name="' + esc(it.name) + '" value="' + (it.unit == null ? '' : it.unit) +
        '" placeholder="' + (mo ? money(mo.unit) : '填') + '"></td>' +
        '<td>' + (it.unit == null ? '<em class="jl-warn">—</em>' : '¥' + money(it.amount)) + '</td></tr>';
    }
    h += '</tbody><tfoot><tr><td>合计</td><td>' + t.cups + '</td><td></td><td>' +
      amtLabel(t.amount, t.unknownAmount) + '</td></tr></tfoot></table>';

    h += '<p class="jl-hint">单价按本店价目表带出来；改过的只存本机，下一单还是先按本店价。</p>';

    h += '<details class="jl-menu-book"><summary>本店价目表 · ' + MENU.length + ' 样 · 点开对一下</summary>' +
      '<div class="jl-menu-grid">' + menuRows() + '</div></details>';

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
      '<span>' + (blds.length ? '点楼栋选好再拍照 · 长按看这一栋的序号' : '这一单还没有楼栋') + '</span></div>';

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
      var nmList = proofNameList(r);
      var nNames = nmList.length;
      var nRaw = proofNameBase(r).length;
      var nFix = nameFixCount(r);
      h += '<button type="button" class="jl-opt' + (V.proofNames ? ' on' : '') + '" data-act="proofnames">' +
        '<i class="jl-opt-sw"></i>' +
        '<span><b>加长版：图下方附「接龙号 · 名字」</b>' +
        '<em>' + (!nNames
          ? '这一单还没有接龙号，名单为空，合出来的还是原来那张'
          : (V.proofNames
            ? '已开 · 拼出来的图下面多一栏，' + nNames + ' 个号对名字，取餐的照着认人'
            : '开着的话，图上会多一栏号对名字；关掉就是原来那张短图')) + '</em></span>' +
        '</button>';

      if (V.proofNames && (nNames || nFix)) {
        h += '<button type="button" class="jl-namesline' + (nFix ? ' chg' : '') + '" data-act="editnames">' +
          '<b>名单 ' + nNames + ' 个号</b>' +
          '<span>' + (!nNames
            ? '删空了 · 点这里撤回来'
            : (nFix
              ? '改过 ' + nFix + ' 次' + (nRaw !== nNames ? '（原来 ' + nRaw + ' 个）' : '') + ' · 再改'
              : '有人撤回接龙、号对不上？点这里改')) + '</span>' +
          '<i>›</i></button>';
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

  /* ==================== AI 资料库 ====================
   * 这不是设置在深山里的一张表。它就是老板自己的笔记本：
   * 记着谁住哪栋、谁总抹零、哪栋冬天要单独一箱。
   * 拆单前、核对前、排箱前，三处 AI 都先读这一本，再干活。
   */
  function viewMemory() {
    var mem = readMemory();
    var h = '';

    h += '<div class="jl-memlead">' +
      '<b>它每次动手前，先把这一本读一遍</b>' +
      '<p>拆单认人认货、核单挑毛病、排箱分箱子，三处都先照这里来。' +
      '所以教过一次，往后不用再说。</p></div>';

    if (!mem.length) {
      h += '<div class="jl-empty">这本还是空的<br><span>在「问题」页点「教它」说一句，就从那儿开始记</span></div>';
      return h + memAddBtn();
    }

    // 按 人 / 货 / 钱 / 箱 / 其他 分组，组内新的在前
    var groups = {};
    for (var i = 0; i < mem.length; i++) {
      var g = MEM_GROUP[mem[i].code] || '其他';
      if (!groups[g]) groups[g] = [];
      groups[g].push(mem[i]);
    }
    var used = MEM_GROUP_ORDER.filter(function (k) { return groups[k] && groups[k].length; });
    var rest = Object.keys(groups).filter(function (k) { return used.indexOf(k) < 0; });

    h += '<div class="jl-memstat">' +
      used.concat(rest).map(function (k) {
        return '<span>' + k + ' <b>' + groups[k].length + '</b></span>';
      }).join('') +
      '</div>';

    var list = used.concat(rest);
    for (var a = 0; a < list.length; a++) {
      var key = list[a];
      var arr = groups[key];
      h += '<div class="jl-memgrp">' +
        '<div class="jl-memgrp-h"><b>' + esc(key) + '</b><em>' + arr.length + ' 条</em>' +
        '<span>' + esc(MEM_GROUP_DESC[key] || '') + '</span></div>';
      for (var b = 0; b < arr.length; b++) {
        var m = arr[b];
        var who = m.name ? m.name : (m.item ? m.item : '');
        var tagCls = m.hand ? 'hand' : (m.code === 'warmbld' ? 'warm' : (m.verdict === 'drop' ? 'drop' : 'keep'));
        var tagTxt = m.hand ? '手写'
          : (m.code === 'warmbld' ? '单独一箱' : (m.verdict === 'drop' ? '不算问题' : '要留意'));
        var subTxt = m.hand ? '你自己写的' : (MEM_CODE_LABEL[m.code] || m.code);
        h += '<div class="jl-memrow jl-memrow-lib">' +
          '<em class="' + tagCls + '">' + tagTxt + '</em>' +
          '<div><b>' + esc(who || MEM_CODE_LABEL[m.code] || '这一条') + '</b>' +
          '<span>' + esc(subTxt) + '</span>' +
          (m.note ? '<p>' + esc(m.note) + '</p>' : '') +
          (m.say && m.say !== m.note ? '<p class="jl-mem-say">你原话：' + esc(m.say) + '</p>' : '') +
          (m.day ? '<p class="jl-mem-day">' + esc(mdLabel(m.day)) + ' 记的</p>' : '') +
          '</div>' +
          '<button type="button" data-act="delmem" data-k="' + esc(m.id) + '">删</button>' +
          '</div>';
      }
      h += '</div>';
    }

    h += '<p class="jl-hint">这些只存这台设备，跟价格本一样不上传。哪条记拧了，点「删」就恢复原样。</p>';
    return h + memAddBtn();
  }

  function memAddBtn() {
    return '<button type="button" class="jl-ghost jl-memadd" data-act="addmem">＋ 自己写一条规矩</button>';
  }

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
    if (V.view === 'detail' && V.record && !V.refPrice) V.refPrice = effectivePrice(listRecords);
    var title = '接龙', sub = '', back = V.view !== 'home';
    if (V.view === 'detail' && V.record) {
      title = mdLabel(V.record.date);
      sub = V.record.totals.orders + ' 单 · ' + amtLabel(V.record.totals.amount, V.record.totals.unknownAmount);
    } else if (V.view === 'history') {
      title = '接龙记录';
      sub = listRecords().length + ' 单';
    } else if (V.view === 'memory') {
      title = 'AI 资料库';
      sub = readMemory().length + ' 条规矩';
    } else {
      sub = '粘一段，拆成楼栋和箱子';
    }

    var body;
    if (V.view === 'home') body = viewHome();
    else if (V.view === 'history') body = viewHistory();
    else if (V.view === 'memory') body = viewMemory();
    else body = viewDetail();

    HOST.innerHTML =
      '<div class="jl-top">' +
      (V.view === 'home'
        ? '<button type="button" class="jl-back jl-x" data-act="close" aria-label="关闭">×</button>'
        : '<button type="button" class="jl-back" data-act="back" aria-label="返回">‹</button>') +
      '<div class="jl-head"><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></div>' +
      (V.view === 'detail'
        ? '<button type="button" class="jl-topbtn" data-act="save">保存</button>'
        : (V.view === 'history' || V.view === 'memory'
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
    V.refPrice = null;
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
    V.refPrice = null;
    V.auditErr = rec.auditErr || '';
    V.auditBusy = false;
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
      boxAi: V.record.boxAi,
      // 这三样以前一编辑就丢：跳过的问题又冒出来、AI 结论和原文全没了
      issueSkip: V.record.issueSkip,
      audit: V.record.audit,
      auditErr: V.record.auditErr || '',
      namesFix: V.record.namesFix,   // 改过的凭证名单，一编辑就丢的话下次拼图又对不上
      sourceText: V.record.sourceText
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
    settings.warm = !!V.warm;
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
        if (menuOf(it.name)) continue;   // 本店有价的以价目表为准，不拿这一单去改它
        var own = readPrice();   // 每样重新读，别把这一轮刚学的价再覆盖回去
        // 已经有价就不再自动改：这个价是「平时多少钱」的基准，被本单自己改掉，
        // 「谁给少了」就永远查不出来。要改价去金额页手填（manual 最大）。
        if (own[it.name]) continue;
        setPrice(it.name, u, 'learned');
      }
    }
  }

  // 拆完顺手让 AI 看一眼怎么装箱（不阻塞，失败就静默用本地方案）
  function kickBoxAI(rec) {
    if (!D || !D.hasAI() || !rec) return;
    if (V.warm) return;    // 保温模式一箱一栋，AI 那套混装用不上，别白跑一趟
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
      // 原文留着：AI 核问题时必须对着原句看，光看拆出来的结果会把好人冤枉
      rec.sourceText = trim(text).slice(0, 3000);
      applyRecord(rec);
      persist(true);
      var t = rec.orders.length, b = rec.buildings.length;
      toast('拆出 ' + t + ' 单 / ' + b + ' 栋，已存进「接龙」');
      if (src === 'ai') kickBoxAI(rec);
      // 排箱先跑，核对晚一步，别把两个 AI 请求挤在一起
      var autoRec = rec;
      setTimeout(function () {
        if (V.record === autoRec && !autoRec.audit) kickAuditAI(autoRec, false);
      }, 1400);
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
      var opts2 = {};
      for (var kk in opts) if (Object.prototype.hasOwnProperty.call(opts, kk)) opts2[kk] = opts[kk];
      opts2.sourceText = text;
      var r = parseAiPayload(out, opts2);
      if (r.ok) { finish(r.record, 'ai'); return; }
      localFallback('AI 没拆好（' + r.error + '），已改用本地规则');
    }).catch(function (e) {
      var msg = (e && e.message) ? String(e.message) : 'AI 没回应';
      localFallback('AI 没连上（' + msg + '），已用本地规则');
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
            raw: o.raw || '',
            items: (o.items || []).map(function (i2) { return { name: i2.name, qty: i2.qty, unit: i2.unit, fromText: !!i2.fromText, half: i2.half == null ? null : !!i2.half, priceFrom: i2.priceFrom || '' }; }),
            total: o.total == null ? null : o.total,
            note: o.note || '', manual: o.manual
          };
        }),
        source: data.source || 'local',
        photos: data.photos || [],
        boxAi: data.boxAi || null,
        issueSkip: data.issueSkip || null,
        audit: data.audit || null,
        auditErr: data.auditErr || '',
        namesFix: data.namesFix || null,   // 上次改过的凭证名单，重开还得是改过的那版
        sourceText: data.srcText || ''
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
    V.refPrice = null;
    V.auditErr = data.auditErr || '';   // 这一条上次没核成的原因，打开就该看得见
    V.auditBusy = false;
    V.photos = [];
    paint();
    loadPhotos(hit.id);
    // 老记录没核过的，打开时顺手核一遍；核过的就用存下来的结论，不重复花钱
    if (!rec.audit) {
      var autoRec2 = rec;
      setTimeout(function () {
        if (V.record === autoRec2 && !autoRec2.audit) kickAuditAI(autoRec2, false);
      }, 900);
    }
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

  /* 合成图的尺寸：顶部一行日期，中间照片 + 楼栋标注，底部一句提醒。
   * 日期是为了让群里的人一眼知道这是哪天的；提醒是给取餐同学看的。
   * legendRows > 0 时，照片和提醒之间多一块「接龙号 · 名字」名单（加长版）。
   */
  var LEG_HEAD = 84, LEG_ROW = 48, LEG_PAD = 16;
  function proofSize(n, legendRows) {
    var PAD = 36, W = 1080;
    var HEAD = 128;      // 顶部日期
    var FOOT = 148;      // 底部提醒
    var cols = n <= 1 ? 1 : (n <= 4 ? 2 : 3);
    var cellW = Math.floor((W - PAD * (cols + 1)) / cols);
    var cellH = Math.round(cellW * (n === 1 ? 0.75 : 1));
    var LABEL = 56;
    var rows = Math.max(1, Math.ceil(n / cols));
    var body = rows * (cellH + LABEL) + (rows - 1) * PAD;
    var LEG = legendRows > 0 ? (LEG_HEAD + legendRows * LEG_ROW + LEG_PAD) : 0;
    var H = HEAD + body + PAD + LEG + FOOT;
    return { PAD: PAD, W: W, HEAD: HEAD, FOOT: FOOT, cols: cols, cellW: cellW, cellH: cellH, LABEL: LABEL, rows: rows, LEG: LEG, LEG_ROWS: legendRows || 0, H: H };
  }

  var WEEK_CN = '日一二三四五六';
  function weekdayOf(dateStr) {
    var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    var d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return isNaN(d.getTime()) ? '' : WEEK_CN.charAt(d.getDay());
  }

  /* 底部提醒：天冷就提盖子，天热就提趁热吃。两句话，不啰嗦 */
  function proofTip(dateStr) {
    var m = String(dateStr || '').match(/^\d{4}-(\d{2})-/);
    var mon = m ? parseInt(m[1], 10) : (new Date().getMonth() + 1);
    var cold = mon >= 11 || mon <= 3;
    return {
      main: '早点拿，趁热吃',
      sub: cold ? '天冷了，泡沫箱盖子盖好' : '泡沫箱盖子记得盖好'
    };
  }

  function composeProof(photos, meta) {
    meta = meta || {};
    // 加长版：图下方补一块「接龙号 · 名字」，两列排，取餐的人照着号认人
    var names = (meta.names || []).filter(function (x) { return x && x.no != null; });
    var nameRows = names.length ? Math.ceil(names.length / 2) : 0;
    var s = proofSize(photos.length, nameRows);
    var PAD = s.PAD, W = s.W, cols = s.cols, cellW = s.cellW, cellH = s.cellH, LABEL = s.LABEL, H = s.H;
    var HEAD = s.HEAD, FOOT = s.FOOT;
    var tip = meta.tip || proofTip(meta.rawDate || meta.date);

    return Promise.all(photos.map(function (p) { return loadImg(p.url); })).then(function (imgs) {
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      if (!ctx) throw new Error('这台设备不支持合成图片');

      ctx.fillStyle = '#fdf8f0';
      ctx.fillRect(0, 0, W, H);

      /* 顶部：接龙日期，让群里的人一眼知道这是哪天的 */
      var headCx = W / 2;
      ctx.fillStyle = '#3a2a1c';
      ctx.font = '600 46px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      var headTxt = meta.date || '';
      if (meta.week) headTxt += ' · 周' + meta.week;
      ctx.fillText(headTxt, headCx, 82);
      ctx.textAlign = 'left';

      var lastRowN = imgs.length - (s.rows - 1) * cols;   // 末行几张，单张时居中放
      for (var i = 0; i < imgs.length; i++) {
        var r = Math.floor(i / cols), c = i % cols;
        var x = PAD + c * (cellW + PAD);
        if (r === s.rows - 1 && lastRowN === 1) x = (W - cellW) / 2;
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
        ctx.fillText(lab, x + 4, y + cellH + 40);

        ctx.fillStyle = '#8a7259';
        ctx.font = '400 24px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
        var tm = hhmm(photos[i].at);
        var tw = ctx.measureText(tm).width;
        ctx.fillText(tm, x + cellW - tw - 4, y + cellH + 40);
      }

      /* 加长版：照片下面补一栏「接龙号 · 名字」，让人照着号认人 */
      if (nameRows) {
        var legTop = H - FOOT - s.LEG;
        ctx.fillStyle = '#eadfce';
        ctx.fillRect(PAD * 2, legTop, W - PAD * 4, 2);

        ctx.textAlign = 'center';
        ctx.fillStyle = '#3a2a1c';
        ctx.font = '600 34px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
        ctx.fillText('接龙号 · 名字', headCx, legTop + 56);

        var GAP = 32;
        var colW = Math.floor((W - PAD * 2 - GAP) / 2);
        var rowTop = legTop + LEG_HEAD;
        for (var k = 0; k < names.length; k++) {
          var rc = Math.floor(k / 2), cc = k % 2;
          var cx = PAD + cc * (colW + GAP);
          var cy = rowTop + rc * LEG_ROW + 34;
          var noTxt = '#' + names[k].no;

          ctx.textAlign = 'left';
          ctx.fillStyle = '#3a2a1c';
          ctx.font = '600 30px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
          ctx.fillText(noTxt, cx, cy);
          var nw = ctx.measureText(noTxt).width;

          // 没写楼栋的标个「未写楼栋」，比空着更像话——空着容易被当成没渲染出来
          var bldTxt = names[k].bld || '';
          ctx.font = '400 22px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
          var bw = bldTxt ? ctx.measureText(bldTxt).width + 12 : 0;

          var nm = names[k].name || '—';
          ctx.font = '400 30px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
          var room = colW - nw - 14 - bw;
          while (nm.length > 1 && ctx.measureText(nm).width > room) nm = nm.slice(0, nm.length - 2) + '…';
          ctx.fillStyle = '#6b5544';
          ctx.fillText(nm, cx + nw + 14, cy);

          if (bldTxt) {
            // 楼栋紧跟在名字后面，别右对齐——右对齐会贴到下一列的号上，看着像别人的
            var nmW = ctx.measureText(nm).width;
            ctx.fillStyle = bldTxt === '未写楼栋' ? '#c0a892' : '#a08a72';
            ctx.font = '400 22px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
            ctx.fillText(bldTxt, cx + nw + 14 + nmW + 10, cy - 2);
          }
        }
        ctx.textAlign = 'left';
      }

      /* 底部：一句提醒，两行，中间一根细线隔开 */
      var tipTop = H - FOOT;
      ctx.fillStyle = '#eadfce';
      ctx.fillRect(PAD * 2, tipTop, W - PAD * 4, 2);

      ctx.textAlign = 'center';
      ctx.fillStyle = '#3a2a1c';
      ctx.font = '600 36px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(tip.main, headCx, tipTop + 62);

      ctx.fillStyle = '#8a7259';
      ctx.font = '400 30px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(tip.sub, headCx, tipTop + 108);
      ctx.textAlign = 'left';

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
    composeProof(V.photos, {
      date: mdLabel(V.record.date),
      week: weekdayOf(V.record.date),
      tip: proofTip(V.record.date),
      names: V.proofNames ? proofNameList(V.record) : null
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

    // 这一单改完，之前对着旧内容下的结论就不算数了；其它单的结论留着，不用整份重核
    function dropAuditFor(n) {
      var a = V.record.audit;
      if (!a) return;
      if (a.verdict) {
        for (var k in a.verdict) {
          if (!Object.prototype.hasOwnProperty.call(a.verdict, k)) continue;
          if (parseInt(String(k).split('|')[0], 10) === n) delete a.verdict[k];
        }
      }
      if (a.add) {
        a.add = a.add.filter(function (x) { return x.no !== n; });
      }
    }

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
        dropAuditFor(no);
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
        dropAuditFor(no);
        close();
        rebuild();
        persist(true);
        toast('改好了');
      }
    });
  }

  /* 手写的一条规矩，尽量认出它管的是谁／哪样货／哪栋。
   * 认不出来就是全局规矩——这个必须让人看见，不然一句「谁不写楼栋都不算事」
   * 会把所有人的楼栋疑点都放过去，越教越松。 */
  function guessMemScope(note, code) {
    var s = trim(note);
    var out = { name: '', item: '', frag: '' };
    if (!s) return out;

    if (code === 'warmbld' || code === 'boxnote') {
      var mb = s.match(/([0-9]{1,2}|[A-Za-z]|[一二三四五六七八九十]{1,2})\s*(栋|幢|号楼|座)/);
      if (mb) {
        var fb = findBuilding(mb[0]);
        out.name = fb ? fb.key : mb[0];
      }
      return out;
    }

    // 商品先认：价目表里的名字（含别名）出现了，就认定是这条货的规矩
    for (var i = 0; i < MENU.length; i++) {
      if (s.indexOf(MENU[i].name) >= 0) { out.item = MENU[i].name; break; }
      var al = MENU[i].alias || [];
      for (var j = 0; j < al.length; j++) {
        if (al[j] && s.indexOf(al[j]) >= 0) { out.item = MENU[i].name; break; }
      }
      if (out.item) break;
    }

    // 名字：句首那两三个字，后面跟着「住／是／家／每次／总／从来」这类词
    var mn = s.match(/^([\u4e00-\u9fa5]{2,4}?)(住|家|是|每次|天天|老|总|从来|不写|只写|爱|喜欢)/);
    if (mn) {
      var cand = mn[1];
      var BAD = ['有的', '有些', '这个', '那个', '他们', '我们', '客人', '大家', '以后', '下次', '凡是', '所有'];
      if (BAD.indexOf(cand) < 0) out.name = cand;
    }
    return out;
  }

  function memScopeText(scope) {
    if (scope.name) return '只管「' + scope.name + '」';
    if (scope.item) return '只管「' + scope.item + '」';
    return '对谁都算——这条会用在所有单上，慎用';
  }

  /* ---------- 自己写一条规矩（不用等它挑错，先把话说在前头） ---------- */

  function addMemSheet() {
    var CATS = [
      { g: '人', code: 'nobld', hint: '例：王姐住 3 栋，她从来不写楼栋' },
      { g: '货', code: 'noitem', hint: '例：豆浆只写「浆」也是豆浆' },
      { g: '钱', code: 'pricelow', hint: '例：张阿姨每次都抹零，差一块别当少给' },
      { g: '箱', code: 'warmbld', hint: '例：5栋冬天单独一箱保温' },
      { g: '其他', code: 'aiadd', hint: '例：下雨天不送 G 栋' }
    ];
    var mask = document.createElement('div');
    mask.className = 'jl-mask';
    mask.innerHTML =
      '<div class="jl-sheet-edit jl-sheet-addmem">' +
      '<div class="jl-ehead"><b>写一条规矩</b><button type="button" data-x="close" aria-label="关闭">×</button></div>' +
      '<p class="jl-mem-lead">写给以后的自己看，也写给 AI 看。往后拆单、核对、排箱都会先读这一条。</p>' +
      '<div class="jl-addcats">' + CATS.map(function (c, i) {
        return '<button type="button" class="jl-addcat' + (i === 0 ? ' on' : '') +
          '" data-x="cat" data-g="' + c.g + '" data-code="' + c.code + '" data-hint="' + esc(c.hint) + '">' +
          c.g + '</button>';
      }).join('') + '</div>' +
      '<label class="jl-mem-note"><span>规矩</span>' +
      '<textarea id="jlAddNote" rows="3" maxlength="60" placeholder="' + esc(CATS[0].hint) + '"></textarea></label>' +
      '<p class="jl-mem-aihint"><span id="jlAddScope">对谁都算</span><em id="jlAddCount">0/60</em></p>' +
      '<div class="jl-eacts">' +
      '<button type="button" class="jl-ghost" data-x="close">先不写</button>' +
      '<button type="button" class="jl-primary" data-x="ok">记下</button>' +
      '</div></div>';

    document.body.appendChild(mask);
    var cat = CATS[0];
    var ta = mask.querySelector('#jlAddNote');
    var cnt = mask.querySelector('#jlAddCount');
    var scEl = mask.querySelector('#jlAddScope');

    function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }

    // 一边写一边告诉它管着谁，写歪了当场能看见
    function refreshScope() {
      var sc = guessMemScope(ta.value, cat.code);
      scEl.textContent = memScopeText(sc);
      var scoped = !!(sc.name || sc.item);
      scEl.className = scoped ? 'on' : (trim(ta.value) ? 'warn' : '');
      return sc;
    }

    mask.addEventListener('click', function (ev) {
      var t = ev.target;
      var x = t.getAttribute ? t.getAttribute('data-x') : null;
      if (t === mask) { close(); return; }
      if (x === 'close') { close(); return; }
      if (x === 'cat') {
        var bs = mask.querySelectorAll('.jl-addcat');
        for (var i = 0; i < bs.length; i++) {
          if (bs[i] === t) bs[i].classList.add('on'); else bs[i].classList.remove('on');
        }
        cat = { g: t.getAttribute('data-g'), code: t.getAttribute('data-code'), hint: t.getAttribute('data-hint') };
        ta.setAttribute('placeholder', cat.hint);
        refreshScope();
        ta.focus();
        return;
      }
      if (x === 'ok') {
        var note = trim(ta.value);
        if (!note) { toast('写一句话再按记下'); ta.focus(); return; }
        var sc = refreshScope();
        var saved = memSave({
          id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          at: Date.now(), day: todayStr(),
          code: cat.code, verdict: 'keep', hand: true,
          name: sc.name, item: sc.item, frag: sc.frag,
          note: note, say: ''
        });
        if (saved && saved.ok === false) { toast('这台设备没存上，多半是存储满了'); return; }
        close();
        // 有当前单就整份重算——新规矩可能改了排箱（比如「这栋单独一箱」）
        if (V.record) rebuild(); else paint();
        toast('记住了 · ' + (sc.name || sc.item ? memScopeText(sc) : note));
      }
    });
    ta.addEventListener('input', function () {
      cnt.textContent = ta.value.length + '/60';
      refreshScope();
    });
    setTimeout(function () { try { ta.focus(); } catch (e) {} }, 60);
  }

  /* ---------- 改名单：有人撤回接龙，凭证上的号跟人对不上了 ---------- */

  /* 这层只改那张图下面那一栏。订单还在，金额、件数、箱子一概不动——
   * 真要把那单也去掉，得回楼栋页删单，这里不替你做这个决定。
   * 两条路：点号后面的 × 直接去掉；或者把话写下来，让它翻成改动。 */
  function nameSheet() {
    if (!V.record) return;
    var mask = document.createElement('div');
    mask.className = 'jl-mask';
    mask.innerHTML =
      '<div class="jl-sheet-edit jl-sheet-names">' +
      '<div class="jl-ehead"><b>改名单</b><button type="button" data-x="close" aria-label="关闭">×</button></div>' +
      '<p class="jl-mem-lead">群里有人撤回接龙，号就跟人对不上了。点号后面的 × 去掉，或者写一句让它自己改。' +
      '<b>只改这张凭证上那一栏，订单和金额不动。</b></p>' +
      '<div class="jl-namechips" id="jlNameChips"></div>' +
      '<div class="jl-nametools"><button type="button" class="jl-namelink" data-x="fill">号是断的？往前补一位</button></div>' +
      '<label class="jl-mem-note"><span>说一句</span>' +
      '<textarea id="jlNameSay" rows="2" maxlength="120" placeholder="例：3号撤回了 · 8号是王姐 · 后面的往前挪一位"></textarea></label>' +
      '<p class="jl-mem-aihint"><span id="jlNameHint">写完点「改」，它按你说的改</span></p>' +
      '<div class="jl-eacts">' +
      '<button type="button" class="jl-ghost" data-x="undo">撤销上次</button>' +
      '<button type="button" class="jl-primary" data-x="ok">改</button>' +
      '</div></div>';

    document.body.appendChild(mask);
    var chipsEl = mask.querySelector('#jlNameChips');
    var hintEl = mask.querySelector('#jlNameHint');
    var ta = mask.querySelector('#jlNameSay');
    var okBtn = mask.querySelector('[data-x="ok"]');
    var undoBtn = mask.querySelector('[data-x="undo"]');
    var pending = null;

    function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }

    function chipsHtml() {
      var list = proofNameList(V.record);
      if (!list.length) return '<span class="jl-nameempty">名单空了 · 点「撤销上次」能退回去</span>';
      return list.map(function (x) {
        return '<span class="jl-namechip"><b>#' + x.no + '</b>' + esc(x.name || '（没名字）') +
          (x.bld ? '<em>' + esc(x.bld) + '</em>' : '') +
          '<button type="button" data-x="drop" data-k="' + x.no + '" aria-label="去掉这个号">×</button></span>';
      }).join('');
    }

    function refresh() {
      chipsEl.innerHTML = chipsHtml();
      var n = nameFixCount(V.record);
      undoBtn.disabled = !n;
      undoBtn.textContent = n ? '撤销上次' : '还没改过';
    }

    function hint(txt, cls) {
      hintEl.textContent = txt;
      hintEl.className = cls || '';
    }

    function resetBtn() {
      okBtn.disabled = false;
      okBtn.textContent = '改';
      okBtn.setAttribute('data-x', 'ok');
    }

    /* 改动落地：记进 record，存一份，图重拼一张 */
    function commit(ops, say) {
      if (!V.record) return;
      if (!V.record.namesFix) V.record.namesFix = [];
      V.record.namesFix.push({ at: Date.now(), say: say || '', ops: ops });
      persist(true);
      refresh();
      pending = null;
      resetBtn();
      hint('改好了，正在重拼图…', 'on');
      V.proofUrl ? doCompose() : paint();
      if (V.proofUrl) toast('名单改好了，图重拼好了');
      setTimeout(function () {
        if (mask.parentNode) hint('改好了 · 还能接着改', 'on');
      }, 700);
    }

    // 把认出来的改动先摆出来给人看，点「就这么改」才动
    function offer(ops, say, fromAI) {
      var txt = nameFixText(ops, proofNameList(V.record));
      if (!txt) {
        hint('没听出要改哪个号。换个说法，比如「3号撤回了」', 'warn');
        pending = null;
        resetBtn();
        return;
      }
      pending = { ops: ops, say: say };
      hint((fromAI ? 'AI 认出来：' : '按你说的：') + txt, 'on');
      okBtn.textContent = '就这么改';
      okBtn.setAttribute('data-x', 'apply');
      okBtn.disabled = false;
    }

    function ask() {
      var say = trim(ta.value);
      if (!say) { hint('先写一句，比如「3号撤回了」', 'warn'); ta.focus(); return; }
      var list = proofNameList(V.record);
      var localOps = parseNameSay(list, say);
      // 没配 AI 就别等，本地抠一遍；抠不出来再明说
      if (!D || !D.askAI || (D.hasAI && !D.hasAI())) {
        offer(localOps, say, false);
        return;
      }
      okBtn.disabled = true;
      okBtn.textContent = '认…';
      hint('正在认…', '');
      D.askAI(buildNameFixPrompt(list, say), { maxTokens: 500 }).then(function (out) {
        var ops = parseNameFixReply(out);
        if (!ops) ops = localOps;
        offer(ops, say, true);
      }).catch(function () {
        offer(localOps, say, false);
      });
    }

    mask.addEventListener('click', function (ev) {
      var t = ev.target;
      var x = t.getAttribute ? t.getAttribute('data-x') : null;
      if (t === mask) { close(); return; }
      if (x === 'close') { close(); return; }
      if (x === 'drop') {
        var no = parseInt(t.getAttribute('data-k'), 10);
        if (!(no > 0)) return;
        commit({ drop: [no], set: [], add: [], shift: false }, no + ' 号撤回了');
        return;
      }
      if (x === 'undo') {
        if (!V.record.namesFix || !V.record.namesFix.length) return;
        V.record.namesFix.pop();
        persist(true);
        refresh();
        hint('退回上一次改之前了', 'on');
        V.proofUrl ? doCompose() : paint();
        return;
      }
      if (x === 'ok') { ask(); return; }
      if (x === 'fill') {
        var nowList = proofNameList(V.record);
        if (!nowList.length) { hint('名单是空的，先点「撤销上次」退回去', 'warn'); return; }
        var before = nowList.map(function (p) { return p.no; }).join(',');
        var after = fillNameGap(nowList).map(function (p) { return p.no; }).join(',');
        if (before === after) { hint('号是连着的，不用补', 'on'); return; }
        commit({ fill: true, drop: [], set: [], add: [], shift: false }, '号往前补一位');
        return;
      }
      if (x === 'apply' && pending) { commit(pending.ops, pending.say); return; }
    });

    refresh();
    setTimeout(function () { try { ta.focus(); } catch (e) {} }, 60);
  }

  /* ---------- 教它一句：把老板的判断收成规矩 ---------- */

  function teachIssue(key) {
    var rec = V.record;
    if (!rec || !key) return;
    var a = auditIssues(rec, V.refPrice);
    var issue = null, i, j, k;
    for (i = 0; i < a.issues.length; i++) if (a.issues[i].key === key) { issue = a.issues[i]; break; }
    if (!issue) for (j = 0; j < a.dropped.length; j++) if (a.dropped[j].key === key) { issue = a.dropped[j]; break; }
    if (!issue) { toast('这条已经不在了'); return; }

    var order = null;
    for (k = 0; k < rec.orders.length; k++) if (rec.orders[k].no === issue.no) order = rec.orders[k];
    if (!order) return;

    /* 原文整段摊开——老板要认的是「我当初怎么发的」，不是程序拆完的样子。
     * 这一单那几行标上色，免得在一长串里找。 */
    var src = trim(rec.sourceText || '');
    if (!src) {
      var rows = [];
      for (var r = 0; r < rec.orders.length; r++) {
        if (rec.orders[r].raw) rows.push('#' + rec.orders[r].no + ' ' + rec.orders[r].raw);
      }
      src = rows.join('\n');
    }
    var lines = src ? src.split('\n').slice(0, 80) : [];
    var flatRaw = String(order.raw || '').replace(/\s+/g, '');
    var lineHtml = '';
    for (var l = 0; l < lines.length; l++) {
      var flat = String(lines[l]).replace(/\s+/g, '');
      var hit = !!(flatRaw && (flat.indexOf(flatRaw) >= 0 || (flat.length > 6 && flatRaw.indexOf(flat) >= 0)));
      lineHtml += '<div class="jl-mem-line' + (hit ? ' hit' : '') + '">' +
        (trim(lines[l]) ? esc(lines[l]) : '&nbsp;') + '</div>';
    }

    var mask = document.createElement('div');
    mask.className = 'jl-mask';
    mask.innerHTML =
      '<div class="jl-sheet-edit jl-sheet-mem">' +
      '<div class="jl-ehead"><b>教它一句</b><button type="button" data-x="close" aria-label="关闭">×</button></div>' +
      '<p class="jl-mem-lead">先看一眼群里发的原话。这条是它自己挑出来的——你觉得不对，就说清该怎么看，往后它先照你的规矩来。</p>' +
      '<div class="jl-mem-src"><div class="jl-mem-src-h"><span>接龙原文</span>' +
      '<em>第 ' + issue.no + ' 条已标色</em></div>' +
      (lineHtml || '<div class="jl-mem-line">' + esc(order.raw || '（没有原文）') + '</div>') + '</div>' +
      '<div class="jl-mem-issue"><b>' + esc(issue.title) + '</b>' +
      (issue.detail ? '<p>' + esc(issue.detail) + '</p>' : '') +
      (issue.aiWhy ? '<p class="jl-mem-ai">AI 说：' + esc(issue.aiWhy) + '</p>' : '') +
      (issue.aiDrop ? '<p class="jl-mem-ai">AI 说：' + esc(issue.aiDrop) + '</p>' : '') + '</div>' +
      '<p class="jl-mem-ask">这条，它是不是看错了？<em>选一个</em></p>' +
      '<div class="jl-mem-picks">' +
      '<button type="button" class="jl-mem-pick" data-x="v" data-v="drop">它看错了</button>' +
      '<button type="button" class="jl-mem-pick" data-x="v" data-v="keep">确实有问题</button>' +
      '</div>' +
      '<div class="jl-mem-tip" id="jlMemTip" role="status"></div>' +
      '<label class="jl-mem-note"><span>怎么说</span>' +
      '<textarea id="jlMemNote" rows="2" maxlength="200" ' +
      'placeholder="照平时说话那样写就行，啰嗦也没关系。例：王姐住 3 栋，她从来不在群里写楼栋，你别老问她"></textarea></label>' +
      '<p class="jl-mem-aihint">' +
      (auditAiReady() ? '写完 AI 会替你收成一句规矩存起来' : '没接 AI，会从这段话里挑一句当规矩') +
      '<em id="jlMemCount">0/200</em></p>' +
      '<label class="jl-mem-wide"><input type="checkbox" id="jlMemWide">' +
      '<i>以后凡是这一类都不必再提醒（不分人和货）</i></label>' +
      '<div class="jl-eacts">' +
      '<button type="button" class="jl-ghost" data-x="close">先不教</button>' +
      '<button type="button" class="jl-primary" data-x="ok">记下，让它重核</button>' +
      '</div></div>';

    document.body.appendChild(mask);

    // 原文长的时候，先把标了色的那一行滚到眼前，别让老板自己找
    var srcBox = mask.querySelector('.jl-mem-src');
    var hitLine = mask.querySelector('.jl-mem-line.hit');
    if (srcBox && hitLine) {
      var hr = hitLine.getBoundingClientRect(), br = srcBox.getBoundingClientRect();
      srcBox.scrollTop = Math.max(0, srcBox.scrollTop + (hr.top - br.top) - srcBox.clientHeight / 2 + hr.height / 2);
    }

    var pick = '';
    var tipEl = mask.querySelector('#jlMemTip');
    var picksEl = mask.querySelector('.jl-mem-picks');
    function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }

    /* 弹框里的提示必须画在弹框里。宿主那枚 toast 的层级压不过遮罩，
     * 以前点了「记下」没选就会像死机一样毫无动静。 */
    function warn(html) {
      if (!tipEl) return;
      tipEl.innerHTML = html;
      tipEl.classList.add('show');
      if (picksEl) {
        picksEl.classList.remove('warn');
        void picksEl.offsetWidth;
        picksEl.classList.add('warn');
      }
      // 底下的「记下」是吸底的，提示得自己滚到弹框中间，别被它压住
      requestAnimationFrame(function () {
        if (!mask.parentNode) return;
        var sheet = mask.querySelector('.jl-sheet-mem');
        if (sheet) {
          try {
            var sr = sheet.getBoundingClientRect(), tr = tipEl.getBoundingClientRect();
            sheet.scrollTop += (tr.top - sr.top) - sheet.clientHeight / 2 + tr.height / 2;
          } catch (e) {}
        }
        try { tipEl.scrollIntoView({ block: 'nearest' }); }
        catch (e) {}
      });
    }
    function clearWarn() {
      if (tipEl) { tipEl.classList.remove('show'); tipEl.innerHTML = ''; }
      if (picksEl) picksEl.classList.remove('warn');
    }

    // 多行输入：跟着字长，最多长到五行的样子，再多就在框里滚
    var noteEl = mask.querySelector('#jlMemNote');
    var countEl = mask.querySelector('#jlMemCount');
    function growNote() {
      if (!noteEl) return;
      noteEl.style.height = 'auto';
      var h = noteEl.scrollHeight;
      if (h > 128) h = 128;
      noteEl.style.height = h + 'px';
      if (countEl) countEl.textContent = noteEl.value.length + '/200';
    }
    if (noteEl) {
      noteEl.addEventListener('input', growNote);
      growNote();
      // 文本框里回车是换行，要提交得按 Ctrl/⌘ + 回车
      noteEl.addEventListener('keydown', function (ev) {
        if ((ev.key === 'Enter' || ev.keyCode === 13) && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          noteEl.blur();
          var okBtn = mask.querySelector('[data-x="ok"]');
          if (okBtn) okBtn.click();
        }
      });
    }

    /* 「记下」在处理中时不能重复点，也要让人看得见它在忙 */
    function busy(on, label) {
      var b = mask.querySelector('[data-x="ok"]');
      if (!b) return;
      if (on) {
        if (!b.getAttribute('data-old')) b.setAttribute('data-old', b.textContent);
        b.disabled = true;
        b.textContent = label || '正在理…';
      } else {
        b.disabled = false;
        b.textContent = b.getAttribute('data-old') || '记下，让它重核';
      }
    }

    mask.addEventListener('click', function (ev) {
      var t = ev.target;
      var x = t.getAttribute ? t.getAttribute('data-x') : null;
      if (t === mask) { close(); return; }
      if (x === 'close') { close(); return; }
      if (x === 'v') {
        pick = t.getAttribute('data-v') || '';
        var bs = mask.querySelectorAll('.jl-mem-pick');
        for (var b = 0; b < bs.length; b++) {
          if (bs[b] === t) bs[b].classList.add('on');
          else bs[b].classList.remove('on');
        }
        clearWarn();
        return;
      }
      if (x === 'ok') {
        var btn = mask.querySelector('[data-x="ok"]');
        if (btn && btn.disabled) return;
        var ni = mask.querySelector('#jlMemNote');
        if (ni && document.activeElement === ni) ni.blur();
        var say = trim(ni ? ni.value : '');
        var wide = !!mask.querySelector('#jlMemWide').checked;
        if (!pick) {
          warn('还差一步：这条是<b>它看错了</b>，还是<b>确实有问题</b>？' +
            '<br>把上面那个选了，再按「记下」。');
          return;
        }
        clearWarn();

        var commit = function (rule) {
          var saved = memSave(memFromIssue(issue.code, order, pick, rule, wide, order.raw, say));
          if (saved && saved.ok === false) {
            busy(false);
            warn('这台设备没存上，多半是存储满了。' +
              '<br>翻到底下「核单记忆」，删两条旧的再试。');
            return;
          }
          close();
          paint();
          toast(rule
            ? ('记下了 · ' + rule)
            : (pick === 'drop' ? '记下了 · 往后这条不再挑出来' : '记下了 · 往后这条要盯着'));
          // 本地已经先生效；再让 AI 拿着新规矩核一遍，让它也记住
          if (V.record === rec && auditAiReady()) {
            setTimeout(function () {
              if (V.record === rec) kickAuditAI(rec, true);
            }, 320);
          }
        };

        // 没写字就不用麻烦 AI，直接记
        if (!say) { commit(''); return; }

        busy(true, auditAiReady() ? 'AI 正在收…' : '正在记…');
        distillRule(issue, order, pick, say).then(function (rule) {
          if (!mask.parentNode) return;   // 等的时候人已经把弹框关了
          commit(rule);
        });
        return;
      }
    });
  }

  /* ---------- 长按楼栋：这一栋有哪几个接龙序号 ---------- */

  var LP_MS = 650;                       // 按住这么久就算长按
  var lpTimer = null, lpKey = '', lpEl = null, lpX = 0, lpY = 0;

  function lpClear() {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    if (lpEl && lpEl.classList) lpEl.classList.remove('lp');
    lpEl = null;
  }

  function lpDown(ev) {
    var t = ev.target;
    while (t && t !== HOST) {
      if (t.getAttribute && t.getAttribute('data-act') === 'setbld') break;
      t = t.parentNode;
    }
    if (!t || t === HOST) return;
    lpClear();
    lpEl = t;
    lpKey = t.getAttribute('data-v') || '';
    var pt = (ev.touches && ev.touches[0]) || ev;
    lpX = typeof pt.clientX === 'number' ? pt.clientX : 0;
    lpY = typeof pt.clientY === 'number' ? pt.clientY : 0;
    if (t.classList) t.classList.add('lp');
    lpTimer = setTimeout(function () {
      lpTimer = null;
      if (lpEl && lpEl.classList) lpEl.classList.remove('lp');
      lpEl = null;
      V.lpAt = Date.now();             // 手抬起来那一下别再当成选楼栋
      try { if (navigator.vibrate) navigator.vibrate(20); } catch (e) { }
      bldOrdersSheet(lpKey);
    }, LP_MS);
  }

  function lpMove(ev) {
    if (!lpTimer) return;
    var pt = (ev.touches && ev.touches[0]) || ev;
    if (typeof pt.clientX !== 'number') return;
    if (Math.abs(pt.clientX - lpX) > 12 || Math.abs(pt.clientY - lpY) > 12) lpClear();
  }

  function itemBrief(o) {
    var parts = [];
    var its = (o && o.items) || [];
    for (var i = 0; i < its.length; i++) {
      if (!its[i] || !its[i].name) continue;
      parts.push((its[i].qty > 1 ? its[i].qty + '×' : '') + its[i].name);
    }
    return parts.join(' + ');
  }

  function pickThisBuilding(key) {
    V.proofBld = key;
    paint();
    var el = HOST && HOST.querySelector ? HOST.querySelector('.jl-shots') : null;
    if (el && el.scrollIntoView) { try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { } }
    toast('拍照会记到 ' + key);
  }

  function bldOrdersSheet(key) {
    if (!V.record || !key) return;
    var b = null;
    for (var i = 0; i < V.record.buildings.length; i++) {
      if (V.record.buildings[i].key === key) { b = V.record.buildings[i]; break; }
    }
    if (!b) return;

    var nos = b.orders.map(function (o) { return '#' + o.no; }).join('、');
    var rows = b.orders.map(function (o) {
      var amt = o.amount == null ? '—' : '¥' + money(o.amount);
      return '<li class="jl-brow" data-no="' + o.no + '">' +
        '<i>#' + o.no + '</i>' +
        '<div><b>' + esc(o.name || '没写名字') + '</b>' +
        (o.room ? '<em>' + esc(o.room) + '</em>' : '') +
        '<p>' + esc(itemBrief(o) || '没有写商品') + '</p></div>' +
        '<span>' + cupCount(o) + ' 件<b>' + amt + '</b></span>' +
        '</li>';
    }).join('');

    var mask = document.createElement('div');
    mask.className = 'jl-mask';
    mask.innerHTML =
      '<div class="jl-sheet-edit jl-sheet-bld">' +
      '<div class="jl-ehead"><b>' + esc(key) + ' · ' + b.orders.length + ' 单</b>' +
      '<button type="button" data-x="close">×</button></div>' +
      '<p class="jl-pick-lead">这一栋的接龙序号：' + esc(nos) + '。点哪一行就改哪一单。</p>' +
      '<ul class="jl-brows">' + rows + '</ul>' +
      '<div class="jl-bsum"><span>' + b.cups + ' 件 · ' + esc(key) + '</span>' +
      '<b>' + (b.unknown ? '还有 ' + b.unknown + ' 单没价钱' : '¥' + money(b.amount)) + '</b></div>' +
      '<div class="jl-eacts">' +
      '<button type="button" class="jl-primary" data-x="pick">就送' + esc(key) + '</button>' +
      '<button type="button" class="jl-ghost" data-x="close">关闭</button>' +
      '</div></div>';

    document.body.appendChild(mask);

    function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }

    var bornAt = Date.now();
    mask.addEventListener('click', function (ev) {
      // 长按弹层是「按着就出来」的，松手那一下会飘一个 click 过来，别让它把弹层关掉
      if (Date.now() - bornAt < 320) return;
      var t = ev.target;
      var x = t.getAttribute ? t.getAttribute('data-x') : null;
      if (t === mask || x === 'close') { close(); return; }
      if (x === 'pick') { close(); pickThisBuilding(key); return; }
      var row = t;
      while (row && row !== mask && !(row.getAttribute && row.getAttribute('data-no'))) row = row.parentNode;
      if (row && row !== mask) {
        var no = parseInt(row.getAttribute('data-no'), 10);
        close();
        if (no) editOrder(no);
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
    var justLong = V.lpAt && (Date.now() - V.lpAt < 700);
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
      else if (V.view === 'memory' && V.memFrom === 'detail' && V.record) { V.view = 'detail'; paint(); }
      else goHome();
      return;
    }
    if (act === 'history') { V.view = 'history'; paint(); return; }
    if (act === 'openmem') {
      V.memFrom = V.view;
      V.view = 'memory';
      paint();
      return;
    }
    if (act === 'addmem') { addMemSheet(); return; }
    if (act === 'pinwarm') {
      var pk = btn.getAttribute('data-k') || '';
      if (!pk || !V.record) return;
      memSave({
        id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        at: Date.now(), day: todayStr(),
        code: 'warmbld', verdict: 'keep',
        name: pk, note: pk + ' 冬天单独一箱',
        say: ''
      });
      rebuild();
      toast('记住了：' + pk + ' 以后单独一箱');
      return;
    }
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
    if (act === 'warmmode') {
      V.warm = !V.warm;
      var s2 = readSettings();
      s2.warm = V.warm;
      s2.cap = V.cap || s2.cap || DEFAULT_CAP;
      writeSettings(s2);
      // 保温模式不用 AI 排的那套，先清掉，免得跟「一箱一栋」打架
      if (V.warm && V.record) {
        V.record.boxAi = null;
        V.record.plan.aiRejected = false;
      }
      rebuild();
      toast(V.warm ? '保温模式：一箱只装一栋' : '按箱子容量混装');
      return;
    }
    if (act === 'delphoto') { delPhoto(btn.getAttribute('data-k')); return; }
    if (act === 'audit') {
      if (V.record && !V.auditBusy) {
        V.record.audit = null;      // 旧结论先撤掉，重新看一遍
        V.auditErr = '';
        kickAuditAI(V.record, true);
      }
      return;
    }
    if (act === 'restoreissue') {
      var rik = btn.getAttribute('data-k') || '';
      if (V.record && rik) {
        V.record.audit = V.record.audit || {};
        V.record.audit.overrule = V.record.audit.overrule || {};
        V.record.audit.overrule[rik] = 1;
        persist(true);
        paint();
        toast('已恢复成问题');
      }
      return;
    }
    if (act === 'teachissue') { teachIssue(btn.getAttribute('data-k') || ''); return; }
    if (act === 'skipissue') {
      var ik = btn.getAttribute('data-k') || '';
      if (V.record && ik) {
        V.record.issueSkip = V.record.issueSkip || {};
        V.record.issueSkip[ik] = 1;
        persist(true);
        paint();
        toast('这条不再提醒');
      }
      return;
    }
    if (act === 'lookupbld') {
      lookupBld(parseInt(btn.getAttribute('data-no'), 10));
      return;
    }
    if (act === 'unskipall') {
      if (V.record) {
        V.record.issueSkip = {};
        persist(true);
        paint();
      }
      return;
    }
    if (act === 'delmem') {
      var mid = btn.getAttribute('data-k') || '';
      writeMemory(readMemory().filter(function (x) { return x.id !== mid; }));
      // 删完重算当前单：那条「这栋单独一箱」撤了，箱子该还回去
      if (V.record) rebuild(); else paint();
      toast('删了，往后还照原来的规矩');
      return;
    }
    if (act === 'setbld') {
      if (justLong) { V.lpAt = 0; return; }     // 长按是来看序号的，不切楼栋
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
    if (act === 'editnames') { nameSheet(); return; }
    if (act === 'proofnames') {
      V.proofNames = !V.proofNames;
      var s3 = readSettings();
      s3.proofNames = V.proofNames;
      writeSettings(s3);
      if (V.proofUrl) { doCompose(); }   // 已经拼过就照新选择重拼一张
      else paint();
      toast(V.proofNames ? '加长版：图下方附上号和人' : '改回原来那张短图');
      return;
    }
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
      V.refPrice = null;            // 刚填的价要马上参与「比平时少」的比对
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
    V.warm = !!st.warm;
    V.proofNames = st.proofNames !== false;   // 没设过就默认加长（老板要的就是号对名字）
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    host.addEventListener('input', onInput);
    // 长按楼栋胶囊 0.65 秒 → 看这一栋的接龙序号
    host.addEventListener('pointerdown', lpDown);
    host.addEventListener('pointerup', lpClear);
    host.addEventListener('pointercancel', lpClear);
    host.addEventListener('pointermove', lpMove);
    host.addEventListener('touchstart', lpDown, { passive: true });
    host.addEventListener('touchend', lpClear);
    host.addEventListener('touchcancel', lpClear);
    host.addEventListener('touchmove', lpMove, { passive: true });
    host.addEventListener('contextmenu', function (ev) {
      var n = ev.target;
      while (n && n !== host) {
        if (n.getAttribute && n.getAttribute('data-act') === 'setbld') { ev.preventDefault(); return; }
        n = n.parentNode;
      }
    });
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
    composeProof: composeProof,
    proofNameList: proofNameList,
    proofNameBase: proofNameBase,
    applyNameFix: applyNameFix,
    parseNameSay: parseNameSay,
    buildNameFixPrompt: buildNameFixPrompt,
    nameFixText: nameFixText,
    proofTip: proofTip,
    weekdayOf: weekdayOf,
    residentBook: residentBook,
    residentsText: residentsText,
    fillMissingBuildings: fillMissingBuildings,
    lookupBuildingByName: lookupBuildingByName,
    lookupBld: lookupBld,
    getRecord: function () { return V.record; },
    finalize: finalize,
    groupByBuilding: groupByBuilding,
    sumTotals: sumTotals,
    planBoxes: planBoxes,
    planWarmBoxes: planWarmBoxes,
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
    auditIssues: auditIssues,
    auditCandidates: auditCandidates,
    buildAuditPrompt: buildAuditPrompt,
    parseAuditPayload: parseAuditPayload,
    kickAuditAI: kickAuditAI,
    todayStr: todayStr,
    readPrice: readPrice,
    writePrice: writePrice,
    setPrice: setPrice,
    learnedPrices: learnedPrices,
    learnPrices: learnPrices,
    effectivePrice: effectivePrice,
    MENU: MENU,
    menuOf: menuOf,
    menuText: menuText,
    menuList: menuList,
    canHalf: canHalf,
    basePriceOf: basePriceOf,
    expectUnit: expectUnit,
    readSettings: readSettings,
    writeSettings: writeSettings,
    readMemory: readMemory,
    writeMemory: writeMemory,
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
