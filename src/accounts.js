import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from './db.js';
import { CONFIG } from './config.js';

// Các field cấu hình nghiệp vụ tách riêng theo từng account (license key). Field nào account chưa
// tự cấu hình thì fallback về giá trị chung trong CONFIG/.env (giữ tương thích ngược cho account
// bootstrap được seed từ .env hiện tại).
export const ACCOUNT_SETTINGS_FIELDS = [
  'SHEET_DOCUMENT_ID',
  'DRIVE_OUTPUT_FOLDER_ID',
  'FLOW_PROJECT_ID',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'GEMINI_API_KEY',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'ENGINE',
  'TIKTOK_SESSION_JSON',
  'TIKTOK_PROXY_URL',
  'TIKTOK_AUTO_PUBLISH',
  'TIKTOK_POST_MODE',
  'N8N_TIKTOK_WEBHOOK_URL'
];

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 ngày

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function formatLicenseKey(raw) {
  // vd "A1B2C3D4E5F6G7H8" -> "A1B2-C3D4-E5F6-G7H8"
  return raw.match(/.{1,4}/g).join('-');
}

export function generateLicenseKeyCode() {
  const raw = crypto.randomBytes(8).toString('hex').toUpperCase(); // 16 ký tự hex
  return formatLicenseKey(raw);
}

function parseSettings(settingsJson) {
  try {
    return JSON.parse(settingsJson || '{}');
  } catch (e) {
    return {};
  }
}

function rowToLicense(row) {
  if (!row) return null;
  return {
    id: row.id,
    keyCode: row.key_code,
    label: row.label,
    planLabel: row.plan_label,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at
  };
}

function isLicenseUsable(license) {
  if (!license || license.status !== 'active') return false;
  if (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now()) return false;
  return true;
}

// ---- License keys (admin) ----

export async function createLicenseKey({ label, planLabel, expiresAt } = {}) {
  const keyCode = generateLicenseKeyCode();
  const result = await pool.query(
    `INSERT INTO license_keys (key_code, label, plan_label, status, expires_at)
     VALUES ($1, $2, $3, 'active', $4) RETURNING id`,
    [keyCode, label || null, planLabel || null, expiresAt || null]
  );
  return getLicenseById(result.rows[0].id);
}

export async function getLicenseById(id) {
  const result = await pool.query('SELECT * FROM license_keys WHERE id = $1', [id]);
  return rowToLicense(result.rows[0]);
}

export async function listLicenseKeys() {
  const result = await pool.query(`
    SELECT lk.*, a.id as account_id, a.can_use_studio as account_can_use_studio
    FROM license_keys lk
    LEFT JOIN accounts a ON a.license_key_id = lk.id
    ORDER BY lk.id DESC
  `);
  return result.rows.map(row => ({
    ...rowToLicense(row),
    accountId: row.account_id || null,
    canUseStudio: !!row.account_can_use_studio
  }));
}

export async function revokeLicenseKey(id) {
  await pool.query(`UPDATE license_keys SET status = 'revoked', revoked_at = now() WHERE id = $1`, [id]);
  // Thu hồi key thì huỷ luôn mọi session đang đăng nhập của account gắn với key này.
  const account = await getAccountByLicenseId(id);
  if (account) {
    await pool.query('DELETE FROM sessions WHERE account_id = $1', [account.id]);
  }
  return getLicenseById(id);
}

export async function reactivateLicenseKey(id) {
  await pool.query(`UPDATE license_keys SET status = 'active', revoked_at = NULL WHERE id = $1`, [id]);
  return getLicenseById(id);
}

// ---- Accounts ----

function rowToAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    licenseKeyId: row.license_key_id,
    settings: parseSettings(row.settings_json),
    driveOAuthTokens: row.drive_oauth_tokens_json ? JSON.parse(row.drive_oauth_tokens_json) : null,
    chromeProfileDir: row.chrome_profile_dir,
    cdpPort: row.cdp_port,
    canUseStudio: !!row.can_use_studio,
    createdAt: row.created_at
  };
}

// Dùng bởi các vòng lặp lịch chạy nền (setTimeout/setInterval) để biết có nên tiếp tục chạy cho
// account này không — ví dụ sau khi admin thu hồi license giữa lúc lịch đang bật.
export async function isAccountLicenseActive(accountId) {
  const account = await getAccountById(accountId);
  if (!account) return false;
  const result = await pool.query('SELECT * FROM license_keys WHERE id = $1', [account.licenseKeyId]);
  return isLicenseUsable(rowToLicense(result.rows[0]));
}

export async function getAccountById(id) {
  const result = await pool.query('SELECT * FROM accounts WHERE id = $1', [id]);
  return rowToAccount(result.rows[0]);
}

async function getAccountByLicenseId(licenseKeyId) {
  const result = await pool.query('SELECT * FROM accounts WHERE license_key_id = $1', [licenseKeyId]);
  return rowToAccount(result.rows[0]);
}

async function createAccountForLicense(licenseKeyId, initialSettings = {}) {
  const result = await pool.query(
    `INSERT INTO accounts (license_key_id, settings_json) VALUES ($1, $2) RETURNING id`,
    [licenseKeyId, JSON.stringify(initialSettings)]
  );
  return getAccountById(result.rows[0].id);
}

export async function updateAccountSettings(accountId, partialSettings) {
  const account = await getAccountById(accountId);
  if (!account) throw new Error('Account không tồn tại');
  const merged = { ...account.settings };
  for (const [key, value] of Object.entries(partialSettings)) {
    if (!ACCOUNT_SETTINGS_FIELDS.includes(key)) continue;
    merged[key] = value;
  }
  await pool.query('UPDATE accounts SET settings_json = $1 WHERE id = $2', [JSON.stringify(merged), accountId]);
  return getAccountById(accountId);
}

// Engine Google Vids dùng chung 1 Chrome profile/tài khoản Google của chủ app — KHÔNG an toàn để
// mở cho mọi account. Mặc định account mới (khách được cấp license key) KHÔNG có quyền này; chỉ
// account bootstrap (chủ app) hoặc account được admin cấp riêng mới dùng được tab Studio/Hàng đợi Sheet.
export async function setAccountStudioAccess(accountId, enabled) {
  await pool.query('UPDATE accounts SET can_use_studio = $1 WHERE id = $2', [!!enabled, accountId]);
  return getAccountById(accountId);
}

export async function saveAccountDriveTokens(accountId, tokensData) {
  await pool.query(
    'UPDATE accounts SET drive_oauth_tokens_json = $1 WHERE id = $2',
    [tokensData ? JSON.stringify(tokensData) : null, accountId]
  );
}

export async function getAccountDriveTokens(accountId) {
  const account = await getAccountById(accountId);
  return account ? account.driveOAuthTokens : null;
}

// Merge cấu hình theo account (settings_json) đè lên giá trị mặc định dùng chung trong CONFIG.
// Field nào account chưa set (undefined/null/'') thì lấy từ CONFIG làm fallback.
export function getAccountConfig(account) {
  const cfg = { ...CONFIG, accountId: account.id };
  for (const field of ACCOUNT_SETTINGS_FIELDS) {
    const accountValue = account.settings[field];
    if (accountValue !== undefined && accountValue !== null && accountValue !== '') {
      cfg[field] = accountValue;
    }
  }
  return cfg;
}

// ---- License verify / session (login) ----

export async function verifyLicenseAndLogin(keyCode) {
  const normalized = (keyCode || '').trim().toUpperCase();
  if (!normalized) return { ok: false, reason: 'Vui lòng nhập license key.' };

  const result = await pool.query('SELECT * FROM license_keys WHERE key_code = $1', [normalized]);
  const license = rowToLicense(result.rows[0]);

  if (!license) return { ok: false, reason: 'License key không tồn tại.' };
  if (license.status === 'revoked') return { ok: false, reason: 'License key đã bị thu hồi.' };
  if (!isLicenseUsable(license)) return { ok: false, reason: 'License key đã hết hạn.' };

  let account = await getAccountByLicenseId(license.id);
  if (!account) account = await createAccountForLicense(license.id);

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await pool.query(
    'INSERT INTO sessions (id, account_id, expires_at) VALUES ($1, $2, $3)',
    [tokenHash, account.id, expiresAt]
  );

  return { ok: true, token, account, license };
}

export async function resolveSession(token) {
  if (!token) return null;
  const tokenHash = sha256(token);
  const result = await pool.query('SELECT * FROM sessions WHERE id = $1', [tokenHash]);
  const row = result.rows[0];
  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query('DELETE FROM sessions WHERE id = $1', [tokenHash]);
    return null;
  }

  const account = await getAccountById(row.account_id);
  if (!account) return null;

  const licenseResult = await pool.query('SELECT * FROM license_keys WHERE id = $1', [account.licenseKeyId]);
  const license = rowToLicense(licenseResult.rows[0]);
  if (!isLicenseUsable(license)) {
    await pool.query('DELETE FROM sessions WHERE id = $1', [tokenHash]);
    return null;
  }

  return { account, license };
}

export async function destroySession(token) {
  if (!token) return;
  await pool.query('DELETE FROM sessions WHERE id = $1', [sha256(token)]);
}

// ---- Bootstrap: giữ quyền truy cập cho chủ app sau khi nâng cấp lên multi-tenant ----

export async function ensureBootstrapAccount() {
  const countResult = await pool.query('SELECT COUNT(*)::int as c FROM license_keys');
  if (countResult.rows[0].c > 0) return null;

  const bootstrapSettings = {};
  for (const field of ACCOUNT_SETTINGS_FIELDS) {
    if (CONFIG[field] !== undefined && CONFIG[field] !== '') {
      bootstrapSettings[field] = CONFIG[field];
    }
  }

  const license = await createLicenseKey({ label: 'Chủ app (bootstrap)', planLabel: 'Unlimited' });
  const account = await createAccountForLicense(license.id, bootstrapSettings);
  await setAccountStudioAccess(account.id, true); // chỉ account bootstrap (chủ app) được dùng engine Vids

  // Di chuyển kết nối Google Drive OAuth đã có sẵn từ bản single-tenant cũ (file google_tokens.json
  // dùng chung) sang account bootstrap, để không bị mất kết nối Drive đã đăng nhập từ trước.
  const legacyTokensPath = path.resolve('google_tokens.json');
  if (fs.existsSync(legacyTokensPath)) {
    try {
      const legacyData = JSON.parse(fs.readFileSync(legacyTokensPath, 'utf-8'));
      if (legacyData && legacyData.tokens) {
        await saveAccountDriveTokens(account.id, legacyData);
      }
    } catch (e) {
      // File cũ lỗi/hỏng định dạng -> bỏ qua, người dùng chỉ cần đăng nhập lại Drive OAuth qua giao diện.
    }
  }

  return license;
}
