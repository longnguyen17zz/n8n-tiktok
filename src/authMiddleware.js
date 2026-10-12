import crypto from 'crypto';
import { CONFIG } from './config.js';
import { resolveSession, getAccountConfig } from './accounts.js';

const COOKIE_NAME = CONFIG.SESSION_COOKIE_NAME;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// Chỉ 1 cookie session đơn giản (tên cố định, giá trị là token hex) nên tự parse/serialize bằng
// tay thay vì thêm dependency ngoài — tránh phải theo kịp API của 1 package cookie-parsing đổi version.
function buildSetCookie(value, maxAgeSeconds) {
  const attrs = [`${COOKIE_NAME}=${encodeURIComponent(value)}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (CONFIG.NODE_ENV === 'production') attrs.push('Secure');
  attrs.push(`Max-Age=${maxAgeSeconds}`);
  return attrs.join('; ');
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', buildSetCookie(token, SESSION_MAX_AGE_SECONDS));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', buildSetCookie('', 0));
}

export function getSessionToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === COOKIE_NAME) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export async function requireAuth(req, res, next) {
  const token = getSessionToken(req);
  const session = await resolveSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Chưa đăng nhập hoặc license key không còn hiệu lực.' });
  }
  req.account = session.account;
  req.license = session.license;
  req.cfg = getAccountConfig(session.account);
  next();
}

// Engine Google Vids dùng chung 1 Chrome profile/tài khoản Google của chủ app — chỉ account được
// cấp quyền (account.canUseStudio) mới được gọi các route tạo video/lên lịch tự động.
export function requireStudioAccess(req, res, next) {
  if (!req.account?.canUseStudio) {
    return res.status(403).json({ error: 'Tính năng tạo video tự động (Google Vids) không khả dụng cho tài khoản của bạn.' });
  }
  next();
}

export function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'] || '';
  const expected = CONFIG.ADMIN_SECRET || '';
  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(String(expected));
  const match = providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
  if (!expected || !match) {
    return res.status(401).json({ error: 'ADMIN_SECRET không hợp lệ.' });
  }
  next();
}

// Giới hạn tốc độ đơn giản cho endpoint verify license (chặn brute-force cơ bản), không cần thêm
// dependency: cửa sổ cố định theo IP, reset sau mỗi WINDOW_MS.
const WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 10;
const attemptsByIp = new Map();

export function licenseVerifyRateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = attemptsByIp.get(ip);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attemptsByIp.set(ip, { windowStart: now, count: 1 });
    return next();
  }

  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS_PER_WINDOW) {
    return res.status(429).json({ error: 'Thử lại quá nhiều lần, vui lòng chờ 1 phút rồi thử lại.' });
  }
  next();
}
