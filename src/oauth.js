import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

const TOKENS_FILE = path.resolve('google_tokens.json');

export function getOAuth2Client() {
  if (!CONFIG.GOOGLE_CLIENT_ID || !CONFIG.GOOGLE_CLIENT_SECRET) {
    return null;
  }
  return new google.auth.OAuth2(
    CONFIG.GOOGLE_CLIENT_ID,
    CONFIG.GOOGLE_CLIENT_SECRET,
    CONFIG.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl() {
  const client = getOAuth2Client();
  if (!client) {
    throw new Error('Chưa cấu hình GOOGLE_CLIENT_ID và GOOGLE_CLIENT_SECRET trong file .env');
  }

  const scopes = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ];

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes
  });
}

export async function handleCallback(code) {
  const client = getOAuth2Client();
  if (!client) throw new Error('OAuth2 client chưa được cấu hình.');

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Lấy email người dùng đã đăng nhập
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  let userEmail = '';
  try {
    const userInfo = await oauth2.userinfo.get();
    userEmail = userInfo.data.email || '';
  } catch (e) {}

  const dataToSave = {
    tokens,
    email: userEmail,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(TOKENS_FILE, JSON.stringify(dataToSave, null, 2));
  return dataToSave;
}

export function getOAuthStatus() {
  const hasConfig = !!(CONFIG.GOOGLE_CLIENT_ID && CONFIG.GOOGLE_CLIENT_SECRET);
  if (!fs.existsSync(TOKENS_FILE)) {
    return {
      connected: false,
      hasConfig,
      email: null
    };
  }

  try {
    const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    return {
      connected: !!(data && data.tokens && data.tokens.refresh_token),
      hasConfig,
      email: data.email || 'Tài khoản Google đã kết nối',
      updatedAt: data.updatedAt
    };
  } catch (e) {
    return {
      connected: false,
      hasConfig,
      email: null
    };
  }
}

export function disconnectOAuth() {
  if (fs.existsSync(TOKENS_FILE)) {
    fs.unlinkSync(TOKENS_FILE);
  }
  return { success: true };
}

export async function getAuthenticatedDriveClient() {
  if (!fs.existsSync(TOKENS_FILE)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    if (!data.tokens) return null;

    const client = getOAuth2Client();
    if (!client) return null;

    client.setCredentials(data.tokens);

    // Tự động lưu refresh token mới nếu được cấp lại
    client.on('tokens', (newTokens) => {
      const current = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
      current.tokens = { ...current.tokens, ...newTokens };
      fs.writeFileSync(TOKENS_FILE, JSON.stringify(current, null, 2));
    });

    return google.drive({ version: 'v3', auth: client });
  } catch (e) {
    console.error('Lỗi khởi tạo Drive OAuth2 client:', e.message);
    return null;
  }
}

/**
 * Upload video trực tiếp bằng tài khoản Google đã đăng nhập OAuth2
 */
export async function uploadVideoViaOAuth(filePath, fileName, folderId = CONFIG.DRIVE_OUTPUT_FOLDER_ID) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 1000) {
    throw new Error(`File video rỗng hoặc không tồn tại, không thể tải lên Drive: ${filePath}`);
  }

  const drive = await getAuthenticatedDriveClient();
  if (!drive) {
    throw new Error('Chưa đăng nhập Google Drive OAuth2.');
  }

  const fileMetadata = {
    name: fileName,
    parents: folderId ? [folderId] : []
  };

  const media = {
    mimeType: 'video/mp4',
    body: fs.createReadStream(filePath)
  };

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    supportsAllDrives: true,
    fields: 'id, name, size, webViewLink, webContentLink'
  });

  const uploadedSize = parseInt(res.data?.size, 10);
  if (!res.data?.size || isNaN(uploadedSize) || uploadedSize === 0) {
    console.warn(`[WARN] File tải lên Drive bằng Stream có size = 0, đang khắc phục bằng Buffer...`);
    const buffer = fs.readFileSync(filePath);
    const { Readable } = await import('stream');
    await drive.files.update({
      fileId: res.data.id,
      media: {
        mimeType: 'video/mp4',
        body: Readable.from(buffer)
      },
      fields: 'id, name, size'
    });
  }

  return res.data.id;
}
