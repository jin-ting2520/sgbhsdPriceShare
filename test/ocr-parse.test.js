import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OcrParse = require('../public/js/ocr-parse.js');

const NAMES = ['谷物', '毛皮', '黏土', '葡萄', '木材', '麻布'];

/* ------------------------------- normalizeText ------------------------------- */

test('normalizeText：全角数字与标点转半角', () => {
  assert.equal(OcrParse.normalizeText('１９．７'), '19.7');
  assert.equal(OcrParse.normalizeText('卖出价格：'), '卖出价格 ');
  assert.equal(OcrParse.normalizeText('，、'), '  ');
});

/* ------------------------------ parsePriceToken ------------------------------ */

test('parsePriceToken：合法价格 / -- / 空', () => {
  assert.equal(OcrParse.parsePriceToken('19.7'), 19.7);
  assert.equal(OcrParse.parsePriceToken('--'), null);
  assert.equal(OcrParse.parsePriceToken('—'), null);
  assert.equal(OcrParse.parsePriceToken(''), null);
  assert.equal(OcrParse.parsePriceToken('10%'), 10, '尾部百分号剥离');
});

/* ------------------------------ matchCommodity ------------------------------ */

test('matchCommodity：精确匹配 + 容忍 1 字误差', () => {
  assert.equal(OcrParse.matchCommodity('谷物 卖出价格', NAMES), '谷物');
  assert.equal(OcrParse.matchCommodity('谷勿', NAMES), '谷物', '1 字 OCR 误差');
  assert.equal(OcrParse.matchCommodity('不存在的东西', NAMES), null);
});

/* -------------------------------- detectMode -------------------------------- */

test('detectMode：卖出多→sell，买入多→buy，默认 sell', () => {
  assert.equal(OcrParse.detectMode('卖出价格 卖出 卖出'), 'sell');
  assert.equal(OcrParse.detectMode('买入价格 买入'), 'buy');
  assert.equal(OcrParse.detectMode('没有任何关键词'), 'sell');
});

/* ----------------------------------- parse ----------------------------------- */

test('parse：卖出坊市截图（谷物/黏土/葡萄），过滤 -- 成本价与赋税噪声', () => {
  const text = [
    '赋税 10%    6.6万    0/8000',
    '谷物',
    '卖出价格',
    '成本价',
    '负重',
    '19.7',
    '--',
    '10',
    '卖出',
    '黏土',
    '卖出价格',
    '成本价',
    '负重',
    '14',
    '--',
    '8',
    '卖出',
    '葡萄',
    '卖出价格',
    '成本价',
    '负重',
    '9.5',
    '--',
    '12',
    '卖出',
  ].join('\n');

  const { mode, rows } = OcrParse.parse(text, { commodityNames: NAMES });
  assert.equal(mode, 'sell');
  assert.equal(rows.length, 3);

  const gu = rows.find(r => r.commodity === '谷物');
  assert.ok(gu);
  assert.equal(gu.sell, 19.7);
  assert.equal(gu.buy, null, '卖出模式买价为 null');
  assert.equal(gu.burden, 10);

  const ni = rows.find(r => r.commodity === '黏土');
  assert.equal(ni.sell, 14);
  assert.equal(ni.burden, 8);

  const pu = rows.find(r => r.commodity === '葡萄');
  assert.equal(pu.sell, 9.5);
  assert.equal(pu.burden, 12);
});

test('parse：买入坊市截图 → buy 价', () => {
  const text = [
    '毛皮',
    '买入价格',
    '成本价',
    '负重',
    '10.5',
    '--',
    '18',
    '买入',
  ].join('\n');
  const { mode, rows } = OcrParse.parse(text, { commodityNames: NAMES });
  assert.equal(mode, 'buy');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].commodity, '毛皮');
  assert.equal(rows[0].buy, 10.5);
  assert.equal(rows[0].sell, null);
  assert.equal(rows[0].burden, 18);
});

test('parse：全角数字与标签同行回退', () => {
  const text = [
    '木材卖出价格１２．５负重６',
    '卖出',
  ].join('\n');
  const { rows } = OcrParse.parse(text, { commodityNames: NAMES, mode: 'sell' });
  const row = rows.find(r => r.commodity === '木材');
  assert.ok(row);
  assert.equal(row.sell, 12.5);
  assert.equal(row.burden, 6);
});

/* --------------------------------- mergeRows --------------------------------- */

test('mergeRows：多图按商品合并非空字段', () => {
  const sellRows = [
    { commodity: '谷物', buy: null, sell: 19.7, burden: 10 },
    { commodity: '毛皮', buy: null, sell: 15, burden: 18 },
  ];
  const buyRows = [
    { commodity: '谷物', buy: 12, sell: null, burden: null },
    { commodity: '木材', buy: 8, sell: null, burden: 5 },
  ];
  const merged = OcrParse.mergeRows([sellRows, buyRows]);
  const byName = Object.fromEntries(merged.map(r => [r.commodity, r]));

  assert.equal(byName['谷物'].buy, 12, '买图补买价');
  assert.equal(byName['谷物'].sell, 19.7, '卖图保留卖价');
  assert.equal(byName['谷物'].burden, 10, '负重保留');
  assert.equal(byName['毛皮'].sell, 15);
  assert.equal(byName['毛皮'].buy, null);
  assert.equal(byName['木材'].buy, 8);
  assert.equal(merged.length, 3);
});
