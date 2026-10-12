import { google } from 'googleapis';
import fs from 'fs';
import { CONFIG } from './config.js';
import { getAccountDriveTokens, saveAccountDriveTokens } from './accounts.js';

// Mỗi account tự "Đăng nhập Drive (OAuth)" và kết nối Drive riêng của họ — token lưu trong cột
// accounts.drive_oauth_tokens_json (DB) thay vì 1 file google_tokens.json dùng chung như trước.
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

export async function handleCallback(code, accountId) {
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

  await saveAccountDriveTokens(accountId, dataToSave);
  return dataToSave;
}

export async function getOAuthStatus(accountId) {
  const hasConfig = !!(CONFIG.GOOGLE_CLIENT_ID && CONFIG.GOOGLE_CLIENT_SECRET);
  const data = accountId ? await getAccountDriveTokens(accountId) : null;

  if (!data) {
    return { connected: false, hasConfig, email: null };
  }

  return {
    connected: !!(data.tokens && data.tokens.refresh_token),
    hasConfig,
    email: data.email || 'Tài khoản Google đã kết nối',
    updatedAt: data.updatedAt
  };
}

export async function disconnectOAuth(accountId) {
  await saveAccountDriveTokens(accountId, null);
  return { success: true };
}

export async function getAuthenticatedDriveClient(accountId) {
  if (!accountId) return null;
  const data = await getAccountDriveTokens(accountId);
  if (!data || !data.tokens) return null;

  try {
    const client = getOAuth2Client();
    if (!client) return null;

    client.setCredentials(data.tokens);

    // Tự động lưu refresh token mới nếu được cấp lại
    client.on('tokens', (newTokens) => {
      getAccountDriveTokens(accountId)
        .then(current => saveAccountDriveTokens(accountId, { ...(current || data), tokens: { ...(current || data).tokens, ...newTokens } }))
        .catch(e => console.error('Lỗi lưu refresh token mới:', e.message));
    });

    return google.drive({ version: 'v3', auth: client });
  } catch (e) {
    console.error('Lỗi khởi tạo Drive OAuth2 client:', e.message);
    return null;
  }
}

/**
 * Upload video trực tiếp bằng tài khoản Google đã đăng nhập OAuth2 của account
 */
export async function uploadVideoViaOAuth(filePath, fileName, accountId, folderId) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 1000) {
    throw new Error(`File video rỗng hoặc không tồn tại, không thể tải lên Drive: ${filePath}`);
  }

  const drive = await getAuthenticatedDriveClient(accountId);
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
