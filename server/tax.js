'use strict';

/**
 * 赋税换算：
 *   数据库只存「税前原价」，城市税率来自游戏 2104（tax，0.1~0.9），
 *   每个用户有自己的「赋税减免」百分比（商队第三辆车夫技能）。
 *   effTax   = tax × (1 − relief/100)
 *   显示卖出 = 原价 × (1 − effTax)，显示买入 = 原价 × (1 + effTax)
 */

const DEFAULT_RELIEF = 5;

const clampRelief = v => {
  if (v == null || v === '') return DEFAULT_RELIEF;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_RELIEF;
  return Math.min(Math.max(n, 0), 100);
};

const effTax = (tax, relief) => {
  const t = Number(tax);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return t * (1 - clampRelief(relief) / 100);
};

const round1 = n => Math.round(n * 10) / 10;
const round2 = n => Math.round(n * 100) / 100;

const displayBuy = (raw, tax, relief) => {
  if (raw == null) return null;
  return round1(Number(raw) * (1 + effTax(tax, relief)));
};

const displaySell = (raw, tax, relief) => {
  if (raw == null) return null;
  return round1(Number(raw) * (1 - effTax(tax, relief)));
};

const rawBuy = (displayed, tax, relief) => {
  if (displayed == null) return null;
  return round2(Number(displayed) / (1 + effTax(tax, relief)));
};

const rawSell = (displayed, tax, relief) => {
  if (displayed == null) return null;
  return round2(Number(displayed) / Math.max(0.05, 1 - effTax(tax, relief)));
};

module.exports = {
  DEFAULT_RELIEF,
  clampRelief,
  effTax,
  round1,
  round2,
  displayBuy,
  displaySell,
  rawBuy,
  rawSell,
};
