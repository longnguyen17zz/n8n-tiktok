import { google } from 'googleapis';
import axios from 'axios';
import fs from 'fs';
import { CONFIG } from './config.js';

let authClient = null;

export function getAuth() {
  if (!authClient) {
    let raw = (CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
    if (raw.startsWith("'")) raw = raw.slice(1);
    if (raw.endsWith("'")) raw = raw.slice(0, -1);
    raw = raw.trim();
    const credentials = JSON.parse(raw);
    authClient = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
      ]
    });
  }
  return authClient;
}

export function extractDriveFileId(url) {
  if (!url || typeof url !== 'string') return null;
  const s = url.trim();
  let m = s.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  m = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  return null;
}

export async function fetchQueueRow() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SHEET_DOCUMENT_ID,
    range: 'Thiết Lập!A:Z'
  });

  const rows = res.data.values;
  if (!rows || rows.length < 2) return null;

  const headers = rows[0];
  const statusIdx = headers.indexOf('Trạng Thái');
  const productIdx = headers.indexOf('Tên Sản Phẩm');

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const hasProduct = productIdx !== -1 ? (row[productIdx] && row[productIdx].trim()) : (row[0] && row[0].trim());
    if (row[statusIdx] === 'Chờ Tạo' && hasProduct) {
      const data = { rowNumber: i + 1 };
      headers.forEach((h, idx) => { data[h] = row[idx] || ''; });
      return data;
    }
  }
  return null;
}

export async function fetchQueueRows(limit = 20) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SHEET_DOCUMENT_ID,
    range: 'Thiết Lập!A:Z'
  });

  const rows = res.data.values;
  if (!rows || rows.length < 2) return [];

  const headers = rows[0];
  const statusIdx = headers.indexOf('Trạng Thái');
  const productIdx = headers.indexOf('Tên Sản Phẩm');

  const pending = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const hasProduct = productIdx !== -1 ? (row[productIdx] && row[productIdx].trim()) : (row[0] && row[0].trim());
    if (row[statusIdx] === 'Chờ Tạo' && hasProduct) {
      const data = { rowNumber: i + 1 };
      headers.forEach((h, idx) => { data[h] = row[idx] || ''; });
      pending.push(data);
      if (pending.length >= limit) break;
    }
  }
  return pending;
}

// Lấy các hàng đã có video thành phẩm (dùng cho trang riêng "Đăng TikTok"),
// mới nhất lên trước, không phụ thuộc cột "Trạng Thái" (khác với fetchQueueRows).
export async function fetchTikTokQueueRows(limit = 30) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SHEET_DOCUMENT_ID,
    range: 'Thiết Lập!A:Z'
  });

  const rows = res.data.values;
  if (!rows || rows.length < 2) return [];

  const headers = rows[0];
  const videoIdx = headers.indexOf('Link Video');
  const productIdx = headers.indexOf('Tên Sản Phẩm');

  const items = [];
  for (let i = rows.length - 1; i >= 1; i--) {
    const row = rows[i];
    const hasVideo = videoIdx !== -1 ? !!(row[videoIdx] && row[videoIdx].trim()) : false;
    const hasProduct = productIdx !== -1 ? !!(row[productIdx] && row[productIdx].trim()) : false;
    if (hasVideo && hasProduct) {
      const data = { rowNumber: i + 1 };
      headers.forEach((h, idx) => { data[h] = row[idx] || ''; });
      items.push(data);
      if (items.length >= limit) break;
    }
  }
  return items;
}

export async function getRowByNumber(rowNumber) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SHEET_DOCUMENT_ID,
    range: 'Thiết Lập!A1:Z1'
  });
  const headers = (headerRes.data.values && headerRes.data.values[0]) || [];
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SHEET_DOCUMENT_ID,
    range: `Thiết Lập!A${rowNumber}:Z${rowNumber}`
  });
  const rowValues = (res.data.values && res.data.values[0]) || [];
  const data = { rowNumber };
  headers.forEach((h, idx) => { data[h] = rowValues[idx] || ''; });
  return data;
}

export async function getAccountCookie() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SHEET_DOCUMENT_ID,
    range: 'Tài Khoản!A:Z'
  });
  const rows = res.data.values;
  const headers = rows[0];
  const statusIdx = headers.indexOf('Trạng Thái');
  const cookieIdx = headers.indexOf('Cookie');
  const nanoIdx = headers.indexOf('Nanoai');
  const projectIdx = headers.findIndex(h => /project/i.test(h));

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][statusIdx]).toLowerCase() === 'true') {
      const sheetProjectId = projectIdx !== -1 ? (rows[i][projectIdx] || '').trim() : '';
      return {
        cookie: rows[i][cookieIdx],
        nanoai: rows[i][nanoIdx] || 'nano_T8sy1HzP699bzAJaRNlJxfzLmJDFKEAnGCfQ02xtpisHHvmlRD4DFn3I53DvSKSg',
        projectId: sheetProjectId || CONFIG.FLOW_PROJECT_ID
      };
    }
  }
  throw new Error('Không tìm thấy tài khoản có Trạng Thái = true trên sheet Tài Khoản');
}

export async function updateRowStatus(rowNumber, status, extraFields = {}) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SHEET_DOCUMENT_ID,
    range: 'Thiết Lập!1:1'
  });
  const headers = headerRes.data.values[0];

  const updates = { 'Trạng Thái': status, ...extraFields };
  const requests = Object.entries(updates).map(([colName, val]) => {
    const colIdx = headers.indexOf(colName);
    if (colIdx === -1) return null;
    const colLetter = String.fromCharCode(65 + colIdx);
    return sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.SHEET_DOCUMENT_ID,
      range: `Thiết Lập!${colLetter}${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[val]] }
    });
  }).filter(Boolean);

  await Promise.all(requests);
}

import { uploadVideoViaOAuth, getOAuthStatus, getAuthenticatedDriveClient } from './oauth.js';

export async function downloadFileAsBase64(urlOrId) {
  // Chấp nhận cả URL Drive đầy đủ lẫn File ID trần (không có dấu / hay ?)
  const trimmed = (urlOrId || '').trim();
  const driveId = extractDriveFileId(trimmed) || (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed) ? trimmed : null);
  let buffer;
  if (driveId) {
    let drive = await getAuthenticatedDriveClient();
    if (!drive) {
      const auth = getAuth();
      drive = google.drive({ version: 'v3', auth });
    }
    const res = await drive.files.get({ fileId: driveId, alt: 'media' }, { responseType: 'arraybuffer' });
    buffer = Buffer.from(res.data);
  } else {
    const res = await axios.get(urlOrId, { responseType: 'arraybuffer' });
    buffer = Buffer.from(res.data);
  }
  return buffer;
}

export async function uploadVideoToDrive(filePath, fileName) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 1000) {
    throw new Error(`File video rỗng hoặc không tồn tại, không thể tải lên Drive: ${filePath}`);
  }

  // Ưu tiên 1: Upload bằng tài khoản chính chủ qua OAuth2 (như n8n)
  const oauthStatus = getOAuthStatus();
  if (oauthStatus.connected) {
    try {
      const fileId = await uploadVideoViaOAuth(filePath, fileName);
      return fileId;
    } catch (err) {
      console.warn('OAuth Drive upload thất bại, thử qua Service Account:', err.message);
    }
  }

  // Ưu tiên 2: Fallback qua Service Account
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const fileMetadata = {
    name: fileName,
    parents: [CONFIG.DRIVE_OUTPUT_FOLDER_ID]
  };
  const media = {
    mimeType: 'video/mp4',
    body: fs.createReadStream(filePath)
  };
  const file = await drive.files.create({
    resource: fileMetadata,
    media: media,
    supportsAllDrives: true,
    fields: 'id, size'
  });

  const uploadedSize = parseInt(file.data?.size, 10);
  if (!file.data?.size || isNaN(uploadedSize) || uploadedSize === 0) {
    console.warn(`[WARN] Service Account upload Stream có size = 0, đang khắc phục bằng Buffer...`);
    const buffer = fs.readFileSync(filePath);
    const { Readable } = await import('stream');
    await drive.files.update({
      fileId: file.data.id,
      media: {
        mimeType: 'video/mp4',
        body: Readable.from(buffer)
      },
      fields: 'id, size'
    });
  }

  return file.data.id;
}
