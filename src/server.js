import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import * as Google from './google.js';
import * as AI from './ai.js';
import { createVideoInGoogleVids } from './vids.js';
import { mergeVideosWithFfmpeg } from './ffmpeg.js';
import { runWorker, processRow, sendTelegram, resolveLogoPath, triggerTikTokUpload } from './index.js';
import { exec } from 'child_process';
import { getAuthUrl, handleCallback, getOAuthStatus, disconnectOAuth, getAuthenticatedDriveClient } from './oauth.js';
import { isTikTokConfigured, normalizeTikTokSession } from './tiktok.js';
import { ensureProductInShowcase, addProductToShowcase, getShowcaseProducts } from './showcase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = CONFIG.PORT || process.env.PORT || 3005;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/temp', express.static(path.join(__dirname, '../temp')));

// In-memory logger & worker state
const logs = [];
function addLog(level, message) {
  const entry = {
    id: Date.now() + Math.random(),
    time: new Date().toLocaleTimeString('vi-VN'),
    level, // 'info', 'success', 'warning', 'error'
    message
  };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  console.log(`[${entry.time}] [${level.toUpperCase()}] ${message}`);
}

// ================= CẤU HÌNH & TRẠNG THÁI LÊN LỊCH (SCHEDULE) =================
const scheduleConfig = {
  enabled: false,
  intervalSeconds: 60, // Mặc định 60 giây (1 phút)
  continuous: true,    // Tự động làm tiếp các hàng tiếp theo khi còn hàng "Chờ Tạo"
  timeRangeEnabled: false,
  startHour: 8,
  endHour: 22,
  maxPerBatch: 10
};

let scheduleState = {
  isProcessing: false,
  lastRunTime: null,
  nextRunTime: null,
  totalProcessedSession: 0,
  currentStatus: 'Đã tạm dừng',
  currentProcessingRow: null
};

let scheduleTimer = null;
let currentProcessingItem = null;

// ================= API ENDPOINTS =================

// 1. Trạng thái hệ thống & Thống kê
app.get('/api/status', async (req, res) => {
  const chromeProfileExists = fs.existsSync(path.resolve('chrome_profile'));
  res.json({
    status: 'online',
    workerRunning: scheduleConfig.enabled,
    currentProcessing: currentProcessingItem,
    schedule: {
      config: scheduleConfig,
      state: {
        ...scheduleState,
        secondsUntilNextRun: (scheduleState.nextRunTime && scheduleConfig.enabled && !scheduleState.isProcessing)
          ? Math.max(0, Math.round((scheduleState.nextRunTime - Date.now()) / 1000))
          : null
      }
    },
    engine: CONFIG.ENGINE || 'vids',
    plan: 'Ultra 20x',
    monthlyQuota: 1000,
    chromeConnected: chromeProfileExists,
    telegramConfigured: !!CONFIG.TELEGRAM_BOT_TOKEN,
    geminiConfigured: !!CONFIG.GEMINI_API_KEY,
    sheetConnected: !!CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON,
    googleSheetId: CONFIG.SHEET_DOCUMENT_ID,
    googleOAuth: getOAuthStatus(),
    n8nWebhookConfigured: !!CONFIG.N8N_TIKTOK_WEBHOOK_URL,
    n8nWebhookUrl: CONFIG.N8N_TIKTOK_WEBHOOK_URL,
    tiktokConfigured: isTikTokConfigured(),
    tiktokAutoPublish: CONFIG.TIKTOK_AUTO_PUBLISH
  });
});

// 2. Lấy logs thời gian thực
app.get('/api/logs', (req, res) => {
  res.json(logs);
});

// 3. Lấy hàng đợi từ Google Sheets
app.get('/api/queue', async (req, res) => {
  if (CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const items = await Google.fetchQueueRows(30);
      return res.json({
        success: true,
        source: 'google_sheets',
        activeRow: items[0] || null,
        items: items
      });
    } catch (err) {
      addLog('warning', `Lỗi kết nối Google Sheet: ${err.message}.`);
    }
  }

  // Dữ liệu mẫu minh họa nếu chưa nhập Google Service Account
  res.json({
    success: true,
    source: 'local',
    notice: 'Chưa cấu hình GOOGLE_SERVICE_ACCOUNT_JSON trong file .env để đồng bộ trực tiếp với Google Sheet.',
    items: [
      {
        rowNumber: 2,
        'Tên Sản Phẩm': 'Bộ Dao Thớt Kháng Khuẩn Đa Năng',
        'Link Sản Phẩm': 'https://images.unsplash.com/photo-1590794056226-79ef3a8147e1?w=800',
        'Link Mẫu Ảnh': 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=800',
        'Link Background': 'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?w=800',
        'Content Video': 'Review chi tiết bộ dao thớt kháng khuẩn, cắt gọt siêu mượt',
        'Trạng Thái': 'Chờ Tạo',
        'Time': '27/09/2026, 17:00'
      }
    ]
  });
});

// 3b. Lấy danh sách hàng đã có video (trang riêng "Đăng TikTok")
app.get('/api/tiktok/queue', async (req, res) => {
  if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return res.json({ success: true, items: [], notice: 'Chưa cấu hình GOOGLE_SERVICE_ACCOUNT_JSON trong file .env.' });
  }
  try {
    const items = await Google.fetchTikTokQueueRows(30);
    res.json({ success: true, items });
  } catch (err) {
    addLog('warning', `Lỗi tải danh sách video chờ đăng TikTok: ${err.message}`);
    res.status(500).json({ success: false, error: err.message, items: [] });
  }
});

// Proxy hiển thị ảnh từ Google Drive trực tiếp lên giao diện
app.get('/api/drive/image', async (req, res) => {
  const { url, id } = req.query;
  const fileId = id || Google.extractDriveFileId(url);
  if (!fileId) {
    return res.status(400).send('Thiếu fileId hoặc URL Google Drive hợp lệ');
  }

  try {
    let drive = await getAuthenticatedDriveClient();
    if (!drive && CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const auth = Google.getAuth();
      drive = google.drive({ version: 'v3', auth });
    }

    if (!drive) {
      return res.status(503).send('Chưa kết nối Google Drive');
    }

    const driveRes = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Type', driveRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    driveRes.data.pipe(res);
  } catch (err) {
    res.status(500).send('Không thể tải ảnh từ Google Drive: ' + err.message);
  }
});

// Proxy phát stream video từ Google Drive trực tiếp lên giao diện (hỗ trợ HTTP Range 206 để tua/phát mượt mà)
app.get('/api/drive/video', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('Thiếu fileId');

  try {
    let drive = await getAuthenticatedDriveClient();
    if (!drive && CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const auth = Google.getAuth();
      drive = google.drive({ version: 'v3', auth });
    }

    if (!drive) {
      return res.status(503).send('Chưa kết nối Google Drive');
    }

    const meta = await drive.files.get({
      fileId: id,
      fields: 'size, mimeType, name',
      supportsAllDrives: true
    });

    const fileSize = parseInt(meta.data.size, 10);
    const mimeType = meta.data.mimeType || 'video/mp4';
    const rawName = (meta.data.name || 'video').trim();
    const safeName = rawName.endsWith('.mp4') ? rawName : `${rawName}.mp4`;
    const safeAscii = safeName.replace(/[^\x20-\x7E]/g, '_');
    const range = req.headers.range;

    res.setHeader('Content-Disposition', `inline; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);

    if (fileSize === 0) {
      return res.status(400).send('Tệp video trên Drive rỗng (0 bytes)');
    }

    if (range && fileSize && fileSize > 0) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=3600'
      });

      const videoStream = await drive.files.get(
        { fileId: id, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
      );
      videoStream.data.pipe(res);
    } else {
      const headers = {
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      };
      if (fileSize && fileSize > 0) {
        headers['Content-Length'] = fileSize;
      }
      res.writeHead(200, headers);
      const videoStream = await drive.files.get(
        { fileId: id, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      videoStream.data.pipe(res);
    }
  } catch (err) {
    console.error('Lỗi stream video Drive:', err.message);
    res.status(500).send('Không thể phát video từ Google Drive: ' + err.message);
  }
});

// 4. Lên lịch tự động (Schedule API)
app.get('/api/schedule', (req, res) => {
  res.json({
    success: true,
    config: scheduleConfig,
    state: {
      ...scheduleState,
      secondsUntilNextRun: (scheduleState.nextRunTime && scheduleConfig.enabled && !scheduleState.isProcessing)
        ? Math.max(0, Math.round((scheduleState.nextRunTime - Date.now()) / 1000))
        : null
    }
  });
});

app.post('/api/schedule/toggle', (req, res) => {
  scheduleConfig.enabled = !scheduleConfig.enabled;
  if (scheduleConfig.enabled) {
    addLog('info', `🟢 Đã BẬT lịch chạy tự động (Chu kỳ quét: ${scheduleConfig.intervalSeconds}s, Chế độ liên tiếp: ${scheduleConfig.continuous ? 'BẬT' : 'TẮT'}).`);
    executeScheduledRun();
  } else {
    addLog('warning', '🔴 Đã TẮT lịch chạy tự động.');
    if (scheduleTimer) clearTimeout(scheduleTimer);
    scheduleState.nextRunTime = null;
    scheduleState.currentStatus = 'Đã tạm dừng';
  }

  res.json({
    success: true,
    enabled: scheduleConfig.enabled,
    config: scheduleConfig,
    state: scheduleState
  });
});

app.post('/api/schedule/config', (req, res) => {
  const { intervalSeconds, continuous, timeRangeEnabled, startHour, endHour, maxPerBatch } = req.body;

  if (intervalSeconds !== undefined) {
    scheduleConfig.intervalSeconds = Math.max(10, parseInt(intervalSeconds, 10));
  }
  if (continuous !== undefined) {
    scheduleConfig.continuous = !!continuous;
  }
  if (timeRangeEnabled !== undefined) {
    scheduleConfig.timeRangeEnabled = !!timeRangeEnabled;
  }
  if (startHour !== undefined) {
    scheduleConfig.startHour = parseInt(startHour, 10);
  }
  if (endHour !== undefined) {
    scheduleConfig.endHour = parseInt(endHour, 10);
  }
  if (maxPerBatch !== undefined) {
    scheduleConfig.maxPerBatch = Math.max(1, parseInt(maxPerBatch, 10));
  }

  addLog('info', `⚙️ Đã cập nhật cấu hình Schedule: Chu kỳ ${scheduleConfig.intervalSeconds}s, Làm liên tiếp: ${scheduleConfig.continuous ? 'Có' : 'Không'}.`);

  // Nếu đang bật và không đang xử lý hàng, lập lịch lại theo chu kỳ mới
  if (scheduleConfig.enabled && !scheduleState.isProcessing) {
    scheduleNextRun();
  }

  res.json({
    success: true,
    config: scheduleConfig,
    state: scheduleState
  });
});

app.post('/api/schedule/run-now', async (req, res) => {
  if (scheduleState.isProcessing) {
    return res.status(409).json({ success: false, message: 'Đang có tiến trình tạo video đang chạy.' });
  }

  addLog('info', '⚡ Kích hoạt quét và xử lý hàng đợi ngay lập tức...');
  res.json({ success: true, message: 'Bắt đầu quét ngay lập tức.' });

  // Chạy ngay không cần chờ scheduleTimer
  executeScheduledRun();
});

// Tương thích ngược với nút bật tắt cũ
app.post('/api/worker/toggle', (req, res) => {
  scheduleConfig.enabled = !scheduleConfig.enabled;
  if (scheduleConfig.enabled) {
    addLog('info', `🟢 Đã BẬT lịch chạy tự động.`);
    executeScheduledRun();
  } else {
    addLog('warning', '🔴 Đã TẮT lịch chạy tự động.');
    if (scheduleTimer) clearTimeout(scheduleTimer);
    scheduleState.nextRunTime = null;
    scheduleState.currentStatus = 'Đã tạm dừng';
  }
  res.json({ workerRunning: scheduleConfig.enabled });
});

// 5. Chạy tạo video cho 1 dòng cụ thể từ Google Sheet
app.post('/api/queue/run-item', async (req, res) => {
  const { row } = req.body;
  if (!row) return res.status(400).json({ error: 'Thiếu thông tin hàng' });

  addLog('info', `🚀 Nhận lệnh xử lý hàng #${row.rowNumber} (${row['Tên Sản Phẩm']})...`);
  currentProcessingItem = { productName: row['Tên Sản Phẩm'], status: 'Đang khởi chạy luồng xử lý...', startTime: Date.now() };

  res.json({ success: true, message: `Bắt đầu xử lý hàng #${row.rowNumber}` });

  (async () => {
    try {
      await processRow(row, addLog);
    } catch (e) {
      addLog('error', `Lỗi xử lý hàng #${row.rowNumber}: ${e.message}`);
    } finally {
      currentProcessingItem = null;
    }
  })();
});

// 6. Kích hoạt Đăng bài TikTok (đồng bộ n8n)
app.post('/api/tiktok/publish', async (req, res) => {
  const { rowNumber, row } = req.body;
  if (!rowNumber && !row) return res.status(400).json({ error: 'Thiếu thông tin hàng' });

  let targetRow = row;
  if (!targetRow && rowNumber) {
    targetRow = await Google.getRowByNumber(rowNumber);
  }

  if (!targetRow) {
    return res.status(404).json({ error: 'Không tìm thấy dữ liệu hàng' });
  }

  addLog('info', `📱 Nhận yêu cầu đăng TikTok cho hàng #${targetRow.rowNumber} ("${targetRow['Tên Sản Phẩm']}")...`);
  res.json({ success: true, message: `Bắt đầu tiến trình đăng TikTok cho hàng #${targetRow.rowNumber}` });

  (async () => {
    try {
      await triggerTikTokUpload(targetRow, addLog);
    } catch (err) {
      addLog('error', `Lỗi đăng TikTok hàng #${targetRow.rowNumber}: ${err.message}`);
    }
  })();
});

// Cấu hình TikTok Direct Engine
app.get('/api/tiktok/config', (req, res) => {
  res.json({
    configured: isTikTokConfigured(),
    hasSession: !!CONFIG.TIKTOK_SESSION_JSON,
    proxyUrl: CONFIG.TIKTOK_PROXY_URL || '',
    autoPublish: CONFIG.TIKTOK_AUTO_PUBLISH
  });
});

app.post('/api/tiktok/config', (req, res) => {
  const { sessionJson, proxyUrl, autoPublish } = req.body;
  
  if (sessionJson !== undefined) {
    const normalized = normalizeTikTokSession(sessionJson);
    CONFIG.TIKTOK_SESSION_JSON = normalized || (sessionJson || '').trim();
  }
  if (proxyUrl !== undefined) {
    CONFIG.TIKTOK_PROXY_URL = (proxyUrl || '').trim();
  }
  if (autoPublish !== undefined) {
    CONFIG.TIKTOK_AUTO_PUBLISH = !!autoPublish;
  }

  try {
    const envPath = path.resolve('.env');
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, 'utf8');
      
      const updateEnvVar = (name, val) => {
        if (content.includes(`${name}=`)) {
          content = content.replace(new RegExp(`${name}=.*`), `${name}=${val}`);
        } else {
          content += `\n${name}=${val}\n`;
        }
      };

      if (sessionJson !== undefined) {
        const toSave = normalizeTikTokSession(CONFIG.TIKTOK_SESSION_JSON) || CONFIG.TIKTOK_SESSION_JSON;
        updateEnvVar('TIKTOK_SESSION_JSON', Buffer.from(toSave, 'utf8').toString('base64'));
      }
      if (proxyUrl !== undefined) {
        updateEnvVar('TIKTOK_PROXY_URL', CONFIG.TIKTOK_PROXY_URL);
      }
      if (autoPublish !== undefined) {
        updateEnvVar('TIKTOK_AUTO_PUBLISH', CONFIG.TIKTOK_AUTO_PUBLISH ? 'true' : 'false');
      }

      fs.writeFileSync(envPath, content, 'utf8');
    }
  } catch (e) {
    console.error('Lỗi ghi .env:', e.message);
  }

  addLog('info', `⚙️ Đã cập nhật cấu hình TikTok Engine: Session=${isTikTokConfigured() ? 'Hợp lệ' : 'Trống/Chưa đúng định dạng'}, Auto-Publish=${CONFIG.TIKTOK_AUTO_PUBLISH ? 'Bật' : 'Tắt'}`);
  res.json({
    success: true,
    configured: isTikTokConfigured(),
    autoPublish: CONFIG.TIKTOK_AUTO_PUBLISH
  });
});

// Cấu hình Webhook n8n cho TikTok (Dự phòng nếu cần)
app.get('/api/config/n8n', (req, res) => {
  res.json({
    webhookUrl: CONFIG.N8N_TIKTOK_WEBHOOK_URL || '',
    configured: !!CONFIG.N8N_TIKTOK_WEBHOOK_URL
  });
});

app.post('/api/config/n8n', (req, res) => {
  const { webhookUrl } = req.body;
  CONFIG.N8N_TIKTOK_WEBHOOK_URL = (webhookUrl || '').trim();

  try {
    const envPath = path.resolve('.env');
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, 'utf8');
      if (content.includes('N8N_TIKTOK_WEBHOOK_URL=')) {
        content = content.replace(/N8N_TIKTOK_WEBHOOK_URL=.*/g, `N8N_TIKTOK_WEBHOOK_URL=${CONFIG.N8N_TIKTOK_WEBHOOK_URL}`);
      } else {
        content += `\nN8N_TIKTOK_WEBHOOK_URL=${CONFIG.N8N_TIKTOK_WEBHOOK_URL}\n`;
      }
      fs.writeFileSync(envPath, content, 'utf8');
    }
  } catch (e) {}

  addLog('info', `⚙️ Đã lưu cấu hình n8n Webhook: ${CONFIG.N8N_TIKTOK_WEBHOOK_URL || '(Chưa điền, dùng chế độ Cron Sheet)'}`);
  res.json({ success: true, webhookUrl: CONFIG.N8N_TIKTOK_WEBHOOK_URL });
});

// 6. Gợi ý kịch bản video AI từ tên sản phẩm
app.post('/api/ai/suggest-script', async (req, res) => {
  const { productName } = req.body;
  if (!productName) return res.status(400).json({ error: 'Thiếu tên sản phẩm' });

  try {
    addLog('info', `🤖 Gemini đang viết kịch bản và caption review TikTok cho: ${productName}...`);
    const script = `Review chân thực ${productName}: Thiết kế hiện đại, tiện lợi. Dùng thử siêu ưng ý, xem ngay tại giỏ hàng góc trái bên dưới nha!`;
    const caption = await AI.generateCaption({ productName, contentVideo: script });
    
    addLog('success', '✨ Đã tạo kịch bản và caption review thành công!');
    res.json({ success: true, script, caption });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Kích hoạt mở Chrome đăng nhập Ultra
app.post('/api/chrome/login', (req, res) => {
  addLog('info', '🌐 Đang khởi động Chrome để đăng nhập tài khoản Google Ultra...');
  exec('npm run login', (err, stdout, stderr) => {
    if (err) addLog('error', `Lỗi mở Chrome: ${err.message}`);
    else addLog('success', 'Đã mở cửa sổ Chrome thành công.');
  });
  res.json({ success: true, message: 'Chrome đang được mở trên máy tính của bạn.' });
});

// OAuth 2.0 cho Google Drive (giống n8n)
app.get('/api/auth/google/url', (req, res) => {
  try {
    const url = getAuthUrl();
    res.json({ success: true, url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Thiếu OAuth authorization code.');

  try {
    const result = await handleCallback(code);
    addLog('success', `🎉 Đã kết nối Google Drive OAuth2 thành công với tài khoản: ${result.email}!`);
    res.redirect('/#settings?oauth=success');
  } catch (err) {
    addLog('error', `Lỗi kết nối Google Drive OAuth2: ${err.message}`);
    res.redirect('/#settings?oauth=error&message=' + encodeURIComponent(err.message));
  }
});

app.get('/api/auth/google/status', (req, res) => {
  res.json(getOAuthStatus());
});

app.post('/api/auth/google/disconnect', (req, res) => {
  disconnectOAuth();
  addLog('warning', 'Đã ngắt kết nối Google Drive OAuth2.');
  res.json({ success: true });
});

app.post('/api/auth/google/config', (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'Vui lòng cung cấp cả Client ID và Client Secret' });
  }

  CONFIG.GOOGLE_CLIENT_ID = clientId.trim();
  CONFIG.GOOGLE_CLIENT_SECRET = clientSecret.trim();

  // Lưu vào .env
  try {
    const envPath = path.resolve('.env');
    let envContent = fs.readFileSync(envPath, 'utf-8');
    if (!envContent.includes('GOOGLE_CLIENT_ID=')) {
      envContent += `\nGOOGLE_CLIENT_ID=${clientId.trim()}\nGOOGLE_CLIENT_SECRET=${clientSecret.trim()}\n`;
    } else {
      envContent = envContent.replace(/GOOGLE_CLIENT_ID=.*/g, `GOOGLE_CLIENT_ID=${clientId.trim()}`);
      envContent = envContent.replace(/GOOGLE_CLIENT_SECRET=.*/g, `GOOGLE_CLIENT_SECRET=${clientSecret.trim()}`);
    }
    fs.writeFileSync(envPath, envContent);
    addLog('success', 'Đã lưu cấu hình Google OAuth Client ID & Secret thành công!');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Lỗi ghi file .env: ' + e.message });
  }
});

// 8. Tạo video trực tiếp từ Studio & Tự động đẩy Drive + Telegram
app.post('/api/create-video', async (req, res) => {
  const { productName, script, ratio = '9:16', duration = '10s' } = req.body;
  if (!productName) return res.status(400).json({ error: 'Vui lòng nhập tên sản phẩm' });

  addLog('info', `🚀 Bắt đầu tạo video từ Studio cho sản phẩm: "${productName}"`);
  currentProcessingItem = { productName, status: 'Đang tạo video bằng Google Vids...', startTime: Date.now() };

  res.json({ success: true, message: 'Đã tiếp nhận yêu cầu. Theo dõi tiến trình trong nhật ký.' });

  // Xử lý bất đồng bộ
  (async () => {
    const workDir = path.resolve(`temp/run_${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      addLog('info', '🎬 Đang kết nối Google Vids với gói Ultra (0 credit)...');
      const fullPrompt = `tạo cho tôi 1 video review sản phẩm ${productName}, người mẫu giới thiệu tự nhiên, cầm sản phẩm trên tay mỉm cười. Khung hình dọc 9:16. ${script || ''}`.trim();

      const videoFile = await createVideoInGoogleVids({
        prompt: fullPrompt,
        outputDir: workDir
      });

      addLog('success', `🎉 Video đã được tạo thành công: ${path.basename(videoFile)}`);

      // Gắn logo kênh vào góc dưới phải
      let fileToUpload = videoFile;
      const logoFile = await resolveLogoPath(null, (lvl, msg) => addLog(lvl, msg));
      if (logoFile && fs.existsSync(logoFile)) {
        addLog('info', `🏷️ Gắn logo kênh: ${path.basename(logoFile)} (góc dưới phải)...`);
        const videoWithLogo = path.join(workDir, 'video_with_logo.mp4');
        try {
          await mergeVideosWithFfmpeg([videoFile], logoFile, videoWithLogo);
          if (fs.existsSync(videoWithLogo)) fileToUpload = videoWithLogo;
        } catch (logoErr) {
          addLog('warning', `Lỗi gắn logo: ${logoErr.message}`);
        }
      }

      // Tải video trực tiếp lên Google Drive (không lưu cục bộ vào videos/)
      let finalVideoUrl = '';
      try {
        addLog('info', '☁️ Đang upload video lên Google Drive...');
        const fileId = await Google.uploadVideoToDrive(fileToUpload, `${Date.now()}_${productName}.mp4`);
        finalVideoUrl = `https://drive.google.com/file/d/${fileId}`;
        addLog('success', `Đã lưu Drive: ${finalVideoUrl}`);

        // Xóa file video tạm sau khi đã tải lên Drive
        try {
          if (fs.existsSync(videoFile)) fs.unlinkSync(videoFile);
          if (fs.existsSync(fileToUpload)) fs.unlinkSync(fileToUpload);
        } catch (cleanErr) {}
      } catch (err) {
        addLog('warning', `Upload Drive lỗi: ${err.message}`);
      }

      // 2. Tạo caption TikTok
      addLog('info', '📝 Đang dùng AI tạo Caption TikTok cuốn hút cho sản phẩm...');
      let caption = '';
      if (CONFIG.GEMINI_API_KEY) {
        caption = await AI.generateCaption({ productName, contentVideo: script });
      } else {
        caption = AI.createSmartFallbackCaption(productName, script);
      }

      // 3. Gửi thông báo Telegram
      addLog('info', '📱 Đang gửi thông báo Telegram...');
      await sendTelegram(`🟢 Review Sản Phẩm: Tạo Thành Công Video "${productName}" từ Studio Web!\n👉 Link Video: ${finalVideoUrl}\n\n📝 Caption: ${caption}`);

      addLog('success', '✨ Toàn bộ quy trình Studio hoàn tất 100%!');
    } catch (err) {
      addLog('error', `Tạo video thất bại: ${err.message}`);
    } finally {
      currentProcessingItem = null;
    }
  })();
});

// 9. Lấy danh sách video từ Google Drive (Kho Video)
app.get('/api/videos', async (req, res) => {
  try {
    let drive = await getAuthenticatedDriveClient();
    if (!drive && CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const auth = Google.getAuth();
      drive = google.drive({ version: 'v3', auth });
    }

    if (!drive) {
      return res.json([]);
    }

    const driveRes = await drive.files.list({
      q: `'${CONFIG.DRIVE_OUTPUT_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, size, createdTime, thumbnailLink, webViewLink, webContentLink)',
      orderBy: 'createdTime desc',
      pageSize: 50,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    const files = driveRes.data.files || [];
    const list = files
      .filter(f => (f.mimeType && f.mimeType.includes('video')) || (f.name && f.name.endsWith('.mp4')))
      .map(file => {
        const bytes = file.size ? parseInt(file.size, 10) : 0;
        let formattedSize = 'N/A';
        if (file.size !== undefined && file.size !== null) {
          if (bytes === 0) {
            formattedSize = '0 MB (Lỗi file)';
          } else if (bytes < 1024 * 1024) {
            formattedSize = `${(bytes / 1024).toFixed(0)} KB`;
          } else {
            formattedSize = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
          }
        }
        const d = file.createdTime ? new Date(file.createdTime) : new Date();
        return {
          id: file.id,
          filename: file.name,
          url: `/api/drive/video?id=${file.id}`,
          driveUrl: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
          downloadUrl: `/api/drive/video?id=${file.id}`,
          thumbnail: file.thumbnailLink || '',
          size: formattedSize,
          createdAt: d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })
        };
      });

    res.json(list);
  } catch (err) {
    console.error('Lỗi lấy danh sách video từ Drive:', err.message);
    res.status(500).json({ error: err.message, list: [] });
  }
});

// ================= SHOWCASE API ENDPOINTS =================
app.post('/api/showcase/check', async (req, res) => {
  try {
    const { productId, productName } = req.body;
    if (!productId) return res.status(400).json({ error: 'Thiếu productId' });
    const result = await ensureProductInShowcase({
      productId,
      productName,
      logger: addLog
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/showcase/add', async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ error: 'Thiếu productId' });
    const result = await addProductToShowcase(productId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/showcase/list', async (req, res) => {
  try {
    const products = await getShowcaseProducts(null, req.query.refresh === 'true');
    res.json({ total: products.length, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= HỆ THỐNG LẬP LỊCH SCHEDULE WORKER =================

function scheduleNextRun(delayMs = null) {
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }

  if (!scheduleConfig.enabled) {
    scheduleState.nextRunTime = null;
    scheduleState.currentStatus = 'Đã tạm dừng';
    return;
  }

  const waitMs = delayMs !== null ? delayMs : (scheduleConfig.intervalSeconds * 1000);
  scheduleState.nextRunTime = Date.now() + waitMs;
  scheduleState.currentStatus = `Chờ đợt quét tiếp theo (${Math.round(waitMs / 1000)}s)...`;

  scheduleTimer = setTimeout(executeScheduledRun, waitMs);
}

async function executeScheduledRun() {
  if (!scheduleConfig.enabled) return;
  if (scheduleState.isProcessing) return;

  // Kiểm tra khung giờ hoạt động nếu có bật
  if (scheduleConfig.timeRangeEnabled) {
    const currentHour = new Date().getHours();
    if (currentHour < scheduleConfig.startHour || currentHour >= scheduleConfig.endHour) {
      scheduleState.currentStatus = `Ngoài khung giờ hẹn (${scheduleConfig.startHour}h - ${scheduleConfig.endHour}h)`;
      scheduleNextRun(60000);
      return;
    }
  }

  scheduleState.isProcessing = true;
  scheduleState.lastRunTime = Date.now();
  scheduleState.currentStatus = 'Đang quét hàng đợi Google Sheets...';

  try {
    let processedInThisBatch = 0;
    while (scheduleConfig.enabled && processedInThisBatch < (scheduleConfig.maxPerBatch || 10)) {
      const row = await Google.fetchQueueRow();
      if (!row) {
        addLog('info', 'ℹ️ Hàng đợi Google Sheets không còn dòng nào "Chờ Tạo".');
        scheduleState.currentStatus = 'Hết hàng chờ tạo';
        break;
      }

      scheduleState.currentProcessingRow = row.rowNumber;
      scheduleState.currentStatus = `Đang xử lý hàng #${row.rowNumber} (${row['Tên Sản Phẩm']})...`;
      currentProcessingItem = { productName: row['Tên Sản Phẩm'], status: `Đang xử lý hàng #${row.rowNumber}...`, startTime: Date.now() };

      addLog('info', `⏰ [Schedule] Tự động xử lý hàng #${row.rowNumber}: "${row['Tên Sản Phẩm']}"`);
      await processRow(row, addLog);

      processedInThisBatch++;
      scheduleState.totalProcessedSession++;
      currentProcessingItem = null;
      scheduleState.currentProcessingRow = null;

      // Nếu không bật chế độ làm liên tiếp, xử lý 1 hàng rồi nghỉ hết chu kỳ
      if (!scheduleConfig.continuous) {
        break;
      }

      // Nghỉ nhẹ 3 giây giữa các hàng để Google Vids và Chrome giải phóng bộ nhớ
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (err) {
    addLog('error', `[Schedule] Lỗi trong tiến trình tự động: ${err.message}`);
    scheduleState.currentStatus = `Lỗi: ${err.message}`;
  } finally {
    scheduleState.isProcessing = false;
    currentProcessingItem = null;
    scheduleState.currentProcessingRow = null;

    if (scheduleConfig.enabled) {
      scheduleNextRun();
    } else {
      scheduleState.currentStatus = 'Đã tạm dừng';
    }
  }
}

// Khởi động server
app.listen(PORT, () => {
  addLog('success', `🌟 Product Video Generator UI Server đang chạy tại: http://localhost:${PORT}`);
  console.log(`\n======================================================`);
  console.log(`🌐 TRUY CẬP GIAO DIỆN TẠI: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
