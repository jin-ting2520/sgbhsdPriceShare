'use strict';

const FORCE_HTTPS = /^(1|true|yes)$/i.test(String(process.env.FORCE_HTTPS || ''));

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
  "worker-src 'self'",
].join('; ');

function requestIsHttps(req) {
  return req.secure;
}

function headers(req, res, next) {
  const https = requestIsHttps(req);
  if (FORCE_HTTPS && !https && req.path !== '/api/health') {
    const host = String(req.get('host') || '').trim();
    if (host) return res.redirect(308, `https://${host}${req.originalUrl || req.url || '/'}`);
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path === '/' || req.path === '/admin' || req.path === '/admin/' || req.path.endsWith('.html')) {
    res.setHeader('Content-Security-Policy', https ? `${CSP}; upgrade-insecure-requests` : CSP);
  }
  if (req.path.startsWith('/api') || req.path === '/admin' || req.path === '/admin/') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
}

function jsonOnly(req, res, next) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  const length = Number(req.get('content-length') || 0);
  const hasBody = length > 0 || !!req.get('transfer-encoding');
  if (!hasBody) return next();
  if (!req.is('application/json')) {
    return res.status(415).json({ code: 415, message: '请求必须使用 application/json', data: null });
  }
  next();
}

module.exports = { headers, jsonOnly, requestIsHttps, FORCE_HTTPS };
