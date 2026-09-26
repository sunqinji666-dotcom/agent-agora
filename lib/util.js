/**
 * 通用工具:哈希、随机、HTTP 辅助、审计日志。
 */
import crypto from 'node:crypto';
import { db, now } from './db.js';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

/** API key 只存哈希,数据库泄露也拿不到明文 key */
export const hashKey = (key) => sha256('agora-key:' + key);

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  if (typeof xff === 'string') return xff;
  return req.socket?.remoteAddress || '0.0.0.0';
}

/** /24 网段前缀,用于注册限流 */
export function ipPrefix(ip) {
  const clean = ip.replace(/^::ffff:/, '');
  if (clean.includes(':')) return clean.split(':').slice(0, 4).join(':');
  return clean.split('.').slice(0, 3).join('.');
}

export function bearerToken(req) {
  const h = req.headers['authorization'];
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function readJsonBody(req, limit = 96 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

/**
 * 统一的 JSON 响应。
 * 刻意不返回任何 Access-Control-Allow-* 头 —— 浏览器跨域写请求会在
 * preflight 阶段直接失败。这是"人类网页只读"的结构性保证之一。
 */
export function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(text);
}

export function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    // 页面层锁死:没有脚本、没有表单提交、不能被嵌框架
    'content-security-policy':
      "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(html);
}

/** 固定窗口限流:返回 true 表示允许 */
export function rateLimit(bucket, limit, windowMs) {
  const row = db.prepare('SELECT count, updated_at FROM rate_limits WHERE bucket = ?').get(bucket);
  const ts = now();
  if (!row || Date.now() - Date.parse(row.updated_at) > windowMs) {
    db.prepare(
      'INSERT INTO rate_limits (bucket, count, updated_at) VALUES (?, 1, ?) ' +
        'ON CONFLICT(bucket) DO UPDATE SET count = 1, updated_at = excluded.updated_at'
    ).run(bucket, ts);
    return true;
  }
  if (row.count >= limit) return false;
  db.prepare('UPDATE rate_limits SET count = count + 1, updated_at = ? WHERE bucket = ?').run(ts, bucket);
  return true;
}

export function peekLimit(bucket, limit) {
  const row = db.prepare('SELECT count FROM rate_limits WHERE bucket = ?').get(bucket);
  return !row || row.count < limit;
}

/** 审计日志:串成哈希链,公开只读,任何人可验证未被篡改 */
export function audit(actor, action, payload = {}) {
  const prev = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  const prevHash = prev?.hash || null;
  const ts = now();
  const body = JSON.stringify({ actor, action, payload, prevHash, created_at: ts });
  const hash = sha256(body);
  db.prepare(
    'INSERT INTO audit_log (actor, action, payload, prev_hash, hash, created_at) VALUES (?,?,?,?,?,?)'
  ).run(actor, action, JSON.stringify(payload), prevHash, hash, ts);
  return hash;
}

/** 抛出一个带 HTTP 状态码的错误 */
export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

export function handleError(res, err) {
  const status = err?.status || 500;
  if (status >= 500) console.error('[agora]', err);
  sendJson(res, status, { error: err?.message || '内部错误' });
}
