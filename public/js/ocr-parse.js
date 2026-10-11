/* OCR 市场截图文本解析（纯函数，浏览器与 Node 测试共用）
   输入 OCR 文本 + 已知商品名列表，输出 [{ commodity, buy, sell, burden }]
   策略：商品名锚定 → 标签行定位 → 数值行顺序取价（价、负重） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OcrParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 全角数字/标点 → 半角 */
  function normalizeText(s) {
    return String(s == null ? '' : s)
      .replace(/[\uFF10-\uFF19]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[\uFF0E\u3002]/g, '.')
      .replace(/[\uFF0C\u3001]/g, ' ')
      .replace(/[\uFF1A\uFF1B]/g, ' ')
      .replace(/\u3000/g, ' ');
  }

  /** 单个 token → 价格数值；'--'、空、非数字 → null */
  function parsePriceToken(tok) {
    if (!tok) return null;
    let t = String(tok).trim();
    if (!t || /^[-—–_.]+$/.test(t)) return null;
    t = t.replace(/[^\d.]/g, '');
    if (!t || t === '.') return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /** 在行文本中模糊匹配商品名（容忍 1 字 OCR 误差，名称 ≥2 字） */
  function matchCommodity(line, names) {
    if (!line || !names || !names.length) return null;
    const compact = String(line).replace(/[\s:：]/g, '');
    if (!compact) return null;
    for (let i = 0; i < names.length; i++) {
      if (compact.indexOf(names[i]) >= 0) return names[i];
    }
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (name.length < 2) continue;
      for (let j = 0; j + name.length <= compact.length; j++) {
        let diff = 0;
        for (let k = 0; k < name.length; k++) {
          if (compact[j + k] !== name[k] && ++diff > 1) break;
        }
        if (diff <= 1) return name;
      }
    }
    return null;
  }

  /** 自动判定买/卖界面：卖出字样多 → sell */
  function detectMode(text) {
    const sell = (String(text).match(/卖出价格|卖出/g) || []).length;
    const buy = (String(text).match(/买入价格|买入/g) || []).length;
    if (sell === 0 && buy === 0) return 'sell';
    return sell >= buy ? 'sell' : 'buy';
  }

  /** 从商品名片段（本行起至下一商品前）提取价格与负重 */
  function extractFromWindow(winLines) {
    let price = null;
    let burden = null;

    // 1) 标签行定位：含 卖出价格/买入价格/成本价/负重 的行为标签行，其后的数值行按序取
    let labelIdx = -1;
    for (let i = 0; i < winLines.length; i++) {
      if (/卖出价格|买入价格|成本价|负重/.test(winLines[i])) { labelIdx = i; break; }
    }
    const seq = [];
    if (labelIdx >= 0) {
      if (/\d/.test(winLines[labelIdx])) seq.push(winLines[labelIdx]);
      for (let i = labelIdx + 1; i < winLines.length; i++) {
        if (/\d/.test(winLines[i])) seq.push(winLines[i]);
        if (seq.length >= 2) break;
      }
    }
    for (let i = 0; i < seq.length; i++) {
      // 用正则抽出连续数字块，避免「卖出价格12.5负重6」被当成 12.56
      const nums = seq[i].match(/\d+(?:\.\d+)?/g) || [];
      for (let j = 0; j < nums.length; j++) {
        const v = parsePriceToken(nums[j]);
        if (v == null) continue;
        if (price == null) { price = v; continue; }
        if (burden == null && Number.isInteger(v) && v >= 1 && v <= 999) burden = v;
      }
    }

    // 2) 同行/紧邻标签数字回退：卖出价格……19.7（标签与数字间允许少量非数字）
    if (price == null) {
      const joined = winLines.join(' ');
      const m = joined.match(/(?:卖出价格|买入价格|卖出|买入|价格)\s*[^\d]{0,12}(\d+(?:\.\d+)?)/);
      if (m) price = parsePriceToken(m[1]);
    }

    // 3) 负重标签回退（仅取整数，避免把 19.7 价格当成负重）
    if (burden == null) {
      const m = winLines.join(' ').match(/负重\s*[^\d]{0,6}(\d+)(?!\d*\.)/);
      if (m) {
        const v = parsePriceToken(m[1]);
        if (v != null && Number.isInteger(v) && v >= 1 && v <= 999 && v !== price) burden = v;
      }
    }

    return { price, burden };
  }

  /**
   * 主入口
   * @param {string} rawText OCR 全文
   * @param {object} opts { commodityNames: string[], mode?: 'auto'|'buy'|'sell' }
   * @returns {{ mode: 'buy'|'sell', rows: Array<{commodity,buy,sell,burden}> }}
   */
  function parse(rawText, opts) {
    opts = opts || {};
    const names = opts.commodityNames || [];
    const text = normalizeText(rawText);
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const mode = opts.mode === 'buy' || opts.mode === 'sell' ? opts.mode : detectMode(text);

    const rows = [];
    const used = Object.create(null);

    for (let i = 0; i < lines.length; i++) {
      const commodity = matchCommodity(lines[i], names);
      if (!commodity || used[commodity]) continue;
      used[commodity] = true;
      // 窗口：本行 + 后续 9 行（卡片≈ 名称/标签×3/数值×3/按钮）
      const win = lines.slice(i, i + 10);
      const { price, burden } = extractFromWindow(win);
      if (price == null && burden == null) continue;
      rows.push({
        commodity,
        buy: mode === 'buy' ? price : null,
        sell: mode === 'sell' ? price : null,
        burden: burden != null ? burden : null,
      });
    }

    return { mode, rows };
  }

  /** 多图结果按商品合并（后图覆盖非空字段） */
  function mergeRows(list) {
    const map = new Map();
    for (const rows of list) {
      for (const r of rows || []) {
        const cur = map.get(r.commodity) || { commodity: r.commodity, buy: null, sell: null, burden: null };
        if (r.buy != null) cur.buy = r.buy;
        if (r.sell != null) cur.sell = r.sell;
        if (r.burden != null) cur.burden = r.burden;
        map.set(r.commodity, cur);
      }
    }
    return [...map.values()];
  }

  return { normalizeText, parsePriceToken, matchCommodity, detectMode, parse, mergeRows };
});
