import dotenv from 'dotenv';
dotenv.config();

// TIKTOK_SESSION_JSON được lưu dạng base64 trong .env để tránh dotenv làm hỏng
// các ký tự escape (\n, \") bên trong chuỗi JSON gốc. Hàm này giải mã lại,
// đồng thời vẫn nhận chuỗi JSON thô (chưa base64) để tương thích ngược.
function decodeTikTokSession(raw) {
  if (!raw) return '';
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    JSON.parse(decoded);
    return decoded;
  } catch (e) {
    return raw;
  }
}

export const CONFIG = {
  SHEET_DOCUMENT_ID: process.env.SHEET_DOCUMENT_ID || '1PmES7DW57525MR2j6Ab4CjZDrvgPmr3CWZcuM0eMmVw',
  SETTING_SHEET_GID: 1515331998,
  ACCOUNT_SHEET_GID: 1585747049,
  FLOW_PROJECT_ID: process.env.FLOW_PROJECT_ID || '',
  DRIVE_OUTPUT_FOLDER_ID: process.env.DRIVE_OUTPUT_FOLDER_ID || '1J5GhIPlemmMWPmxWhrsRvtcUJAlo3SCD',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '5683477257',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ENGINE: process.env.ENGINE || 'vids',
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3005}/api/auth/google/callback`,
  PORT: parseInt(process.env.PORT, 10) || 3005,
  N8N_TIKTOK_WEBHOOK_URL: process.env.N8N_TIKTOK_WEBHOOK_URL || '',
  TIKTOK_SESSION_JSON: decodeTikTokSession(process.env.TIKTOK_SESSION_JSON),
  TIKTOK_PROXY_URL: process.env.TIKTOK_PROXY_URL || '',
  TIKTOK_AUTO_PUBLISH: process.env.TIKTOK_AUTO_PUBLISH === 'true'
};

