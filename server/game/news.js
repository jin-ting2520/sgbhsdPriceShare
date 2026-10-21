'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');

let NEWS_CONFIG;
try {
  NEWS_CONFIG = JSON.parse(fs.readFileSync(nodePath.join(__dirname, 'data', 'monopoly_news.json'), 'utf8'));
} catch (err) {
  throw new Error(`缺少 server/game/data/monopoly_news.json 或格式错误: ${err.message}`);
}

function newsConfig(metaId) {
  const key = String(metaId == null ? '' : metaId).trim();
  return key ? NEWS_CONFIG[key] || null : null;
}

function correctionText(correction) {
  const n = Number(correction);
  if (!Number.isFinite(n)) return '0%';
  const percent = Math.floor(Math.abs(n) * 10000 + 0.5) / 100;
  return `${percent}%`;
}

function newsDescription(metaId, city, commodity) {
  const cfg = newsConfig(metaId);
  if (!cfg || !cfg.des) return null;
  return cfg.des
    .replace(/\{0\}/g, city == null ? '' : String(city))
    .replace(/\{1\}/g, commodity == null ? '' : String(commodity))
    .replace(/\{2\}/g, correctionText(cfg.priceCorrection));
}

function correctionOf(event) {
  if (event && event.priceCorrection != null) {
    const n = Number(event.priceCorrection);
    return Number.isFinite(n) ? n : 0;
  }
  const cfg = newsConfig(event && event.metaId);
  return cfg ? Number(cfg.priceCorrection) || 0 : 0;
}

function monopolyCorrection(events) {
  const list = Array.isArray(events)
    ? [...events].sort((a, b) => String(a && a.startsAt || '').localeCompare(String(b && b.startsAt || '')))
    : [];
  return list.length ? correctionOf(list[0]) : 0;
}

function enrichMonopolyEvent(event, city, commodity) {
  if (!event) return event;
  const cfg = newsConfig(event.metaId);
  if (!cfg) return { ...event, description: null, priceCorrection: null, direction: null };
  const priceCorrection = Number(cfg.priceCorrection) || 0;
  return {
    ...event,
    description: newsDescription(event.metaId, city, commodity),
    priceCorrection,
    direction: priceCorrection > 0 ? 'up' : (priceCorrection < 0 ? 'down' : 'flat'),
  };
}

module.exports = {
  newsConfig,
  newsDescription,
  correctionOf,
  monopolyCorrection,
  enrichMonopolyEvent,
};
