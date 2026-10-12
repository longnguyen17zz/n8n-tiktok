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
import { processRow, sendTelegram, resolveLogoPath, triggerTikTokUpload, runTikTokWorker } from './index.js';
import { exec } from 'child_process';
import { getAuthUrl, handleCallback, getOAuthStatus, disconnectOAuth, getAuthenticatedDriveClient } from './oauth.js';
import { isTikTokConfigured, normalizeTikTokSession } from './tiktok.js';
import { ensureProductInShowcase, addProductToShowcase, getShowcaseProducts } from './showcase.js';
import { initDb } from './db.js';
import {
  ensureBootstrapAccount,
  verifyLicenseAndLogin,
  destroySession,
  resolveSession,
  getAccountById,
  getAccountConfig,
  updateAccountSettings,
  isAccountLicenseActive,
  listLicenseKeys,
  createLicenseKey,
  revokeLicenseKey,
  reactivateLicenseKey,
  setAccountStudioAccess
} from './accounts.js';
import { requireAuth, requireAdmin, requireStudioAccess, setSessionCookie, clearSessionCookie, getSessionToken, licenseVerifyRateLimit } from './authMiddleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Giữ quyền truy cập cho chủ app sau khi nâng cấp lên multi-tenant: nếu chưa có license key nào,
// tạo 1 key bootstrap seed từ .env hiện tại và in rõ ra log để đăng nhập lần đầu.
await initDb();
const bootstrapLicense = await ensureBootstrapAccount();
if (bootstrapLicense) {
  console.log(`\n======================================================`);
  console.log(`🔑 LICENSE KEY BOOTSTRAP (đăng nhập lần đầu): ${bootstrapLicense.keyCode}`);
  console.log(`======================================================\n`);
}

const app = express();
const PORT = CONFIG.PORT || process.env.PORT || 3005;

app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/temp', express.static(path.join(__dirname, '../temp')));

// ================= TRẠNG THÁI RUNTIME THEO TỪNG ACCOUNT =================
// Mỗi account (license key) có log, lịch tạo video & lịch đăng TikTok ĐỘC LẬP hoàn toàn — không
// còn 1 biến global duy nhất dùng chung như bản single-tenant trước đây.
function createDefaultRuntime() {
  return {
    logs: [],
    currentProcessingItem: null,
    scheduleConfig: {
      enabled: false,
      intervalSeconds: 60,
      continuous: true,
      timeRangeEnabled: false,
      startHour: 8,
      endHour: 22,
      maxPerBatch: 10
    },
    scheduleState: {
      isProcessing: false,
      lastRunTime: null,
      nextRunTime: null,
      totalProcessedSession: 0,
      currentStatus: 'Đã tạm dừng',
      currentProcessingRow: null
    },
    scheduleTimer: null,
    tiktokScheduleConfig: {
      enabled: false,
      postHours: [7, 11, 17, 23]
    },
    tiktokScheduleState: {
      isProcessing: false,
      lastRunTime: null,
      lastPostedKey: null,
      totalPostedSession: 0,
      currentStatus: 'Đã tạm dừng'
    },
    tiktokScheduleCheckInterval: null
  };
}

const runtimeByAccount = new Map();
function getRuntime(accountId) {
  if (!runtimeByAccount.has(accountId)) {
    runtimeByAccount.set(accountId, createDefaultRuntime());
  }
  return runtimeByAccount.get(accountId);
}

function addLog(accountId, level, message) {
  const rt = getRuntime(accountId);
  const entry = {
    id: Date.now() + Math.random(),
    time: new Date().toLocaleTimeString('vi-VN'),
    level, // 'info', 'success', 'warning', 'error'
    message
  };
  rt.logs.unshift(entry);
  if (rt.logs.length > 200) rt.logs.pop();
  console.log(`[acc${accountId}][${entry.time}] [${level.toUpperCase()}] ${message}`);
}

// Luôn đọc lại cấu hình mới nhất từ DB cho vòng lặp lịch chạy nền (setTimeout/setInterval) — tránh
// dùng "cfg" cũ đã đóng băng từ lúc bật lịch nếu account đổi cấu hình giữa chừng.
async function loadFreshCfg(accountId) {
  const account = await getAccountById(accountId);
  if (!account) return null;
  return getAccountConfig(account);
}

// ================= HÀNG ĐỢI RENDER DÙNG CHUNG (GIỚI HẠN BỞI 1 CHROME PROFILE/CỔNG CDP) =================
// Engine Google Vids (Puppeteer) hiện vẫn dùng chung 1 Chrome profile + 1 cổng CDP cho MỌI account
// (xem kế hoạch Giai đoạn 2 để tách riêng theo từng account) — nên mọi lệnh render video thật sự
// phải đi qua hàng đợi tuần tự này, dù bao nhiêu account cùng bật lịch cùng lúc.
let renderQueueTail = Promise.resolve();
function withRenderLock(fn) {
  const run = renderQueueTail.then(fn, fn);
  renderQueueTail = run.then(() => {}, () => {});
  return run;
}

// ================= AUTH: CHẶN TOÀN BỘ /api/* NGOẠI TRỪ MỘT SỐ ROUTE CÔNG KHAI =================
const PUBLIC_API_PATHS = new Set(['/api/license/verify', '/api/license/logout', '/api/me']);
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  if (req.path.startsWith('/api/admin/')) return next(); // tự bảo vệ riêng bằng requireAdmin
  await requireAuth(req, res, next);
});

// ================= LICENSE: ĐĂNG NHẬP / ĐĂNG XUẤT / THÔNG TIN TÀI KHOẢN =================
app.post('/api/license/verify', licenseVerifyRateLimit, async (req, res) => {
  const { licenseKey } = req.body || {};
  const result = await verifyLicenseAndLogin(licenseKey);
  if (!result.ok) {
    return res.status(401).json({ success: false, error: result.reason });
  }
  setSessionCookie(res, result.token);
  res.json({
    success: true,
    account: { label: result.license.label, planLabel: result.license.planLabel, canUseStudio: result.account.canUseStudio }
  });
});

app.post('/api/license/logout', async (req, res) => {
  await destroySession(getSessionToken(req));
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
  const session = await resolveSession(getSessionToken(req));
  if (!session) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.json({
    success: true,
    accountId: session.account.id,
    label: session.license.label,
    planLabel: session.license.planLabel,
    canUseStudio: session.account.canUseStudio
  });
});

// ================= ADMIN: QUẢN LÝ LICENSE KEY =================
app.get('/api/admin/license-keys', requireAdmin, async (req, res) => {
  res.json({ success: true, items: await listLicenseKeys() });
});

app.post('/api/admin/license-keys', requireAdmin, async (req, res) => {
  const { label, planLabel, expiresAt } = req.body || {};
  const license = await createLicenseKey({ label, planLabel, expiresAt });
  res.json({ success: true, license });
});

app.post('/api/admin/license-keys/:id/revoke', requireAdmin, async (req, res) => {
  const license = await revokeLicenseKey(Number(req.params.id));
  res.json({ success: true, license });
});

app.post('/api/admin/license-keys/:id/reactivate', requireAdmin, async (req, res) => {
  const license = await reactivateLicenseKey(Number(req.params.id));
  res.json({ success: true, license });
});

// Cấp/thu quyền dùng engine Google Vids (tab Studio + lịch tự động tạo video) cho 1 account cụ thể
// — mặc định mọi account khách đều KHÔNG có quyền này, chỉ admin mới bật được cho ai đó nếu muốn.
app.post('/api/admin/accounts/:id/studio-access', requireAdmin, async (req, res) => {
  const account = await setAccountStudioAccess(Number(req.params.id), !!req.body?.enabled);
  res.json({ success: true, account });
});

// ================= API ENDPOINTS (yêu cầu đăng nhập — req.account / req.cfg từ requireAuth) =================

// 1. Trạng thái hệ thống & Thống kê
app.get('/api/status', async (req, res) => {
  const { cfg, account, license } = req;
  const rt = getRuntime(account.id);
  const chromeProfileExists = fs.existsSync(path.resolve('chrome_profile'));
  res.json({
    status: 'online',
    workerRunning: rt.scheduleConfig.enabled,
    currentProcessing: rt.currentProcessingItem,
    schedule: {
      config: rt.scheduleConfig,
      state: {
        ...rt.scheduleState,
        secondsUntilNextRun: (rt.scheduleState.nextRunTime && rt.scheduleConfig.enabled && !rt.scheduleState.isProcessing)
          ? Math.max(0, Math.round((rt.scheduleState.nextRunTime - Date.now()) / 1000))
          : null
      }
    },
    tiktokSchedule: {
      config: rt.tiktokScheduleConfig,
      state: {
        ...rt.tiktokScheduleState,
        secondsUntilNextRun: rt.tiktokScheduleConfig.enabled ? secondsUntilNextTikTokSlot(rt) : null
      }
    },
    engine: cfg.ENGINE || 'vids',
    plan: license.planLabel || 'Chưa gán gói',
    accountLabel: license.label || '',
    chromeConnected: chromeProfileExists,
    telegramConfigured: !!cfg.TELEGRAM_BOT_TOKEN,
    geminiConfigured: !!cfg.GEMINI_API_KEY,
    sheetConnected: !!cfg.GOOGLE_SERVICE_ACCOUNT_JSON,
    googleSheetId: cfg.SHEET_DOCUMENT_ID,
    googleOAuth: await getOAuthStatus(account.id),
    n8nWebhookConfigured: !!cfg.N8N_TIKTOK_WEBHOOK_URL,
    n8nWebhookUrl: cfg.N8N_TIKTOK_WEBHOOK_URL,
    tiktokConfigured: isTikTokConfigured(cfg.TIKTOK_SESSION_JSON),
    tiktokAutoPublish: cfg.TIKTOK_AUTO_PUBLISH
  });
});

// 2. Lấy logs thời gian thực (chỉ của account đang đăng nhập)
app.get('/api/logs', (req, res) => {
  res.json(getRuntime(req.account.id).logs);
});

// 3. Lấy hàng đợi từ Google Sheets
app.get('/api/queue', async (req, res) => {
  const { cfg, account } = req;
  if (cfg.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const items = await Google.fetchQueueRows(30, cfg);
      return res.json({
        success: true,
        source: 'google_sheets',
        activeRow: items[0] || null,
        items: items
      });
    } catch (err) {
      addLog(account.id, 'warning', `Lỗi kết nối Google Sheet: ${err.message}.`);
    }
  }

  // Dữ liệu mẫu minh họa nếu chưa cấu hình Google Service Account cho account này
  res.json({
    success: true,
    source: 'local',
    notice: 'Chưa cấu hình Google Service Account trong Cấu hình & Tích hợp để đồng bộ trực tiếp với Google Sheet.',
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
  const { cfg, account } = req;
  if (!cfg.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return res.json({ success: true, items: [], notice: 'Chưa cấu hình Google Service Account.' });
  }
  try {
    const items = await Google.fetchTikTokQueueRows(300, cfg);
    res.json({ success: true, items });
  } catch (err) {
    addLog(account.id, 'warning', `Lỗi tải danh sách video chờ đăng TikTok: ${err.message}`);
    res.status(500).json({ success: false, error: err.message, items: [] });
  }
});

// Proxy hiển thị ảnh từ Google Drive trực tiếp lên giao diện
app.get('/api/drive/image', async (req, res) => {
  const { cfg, account } = req;
  const { url, id } = req.query;
  const fileId = id || Google.extractDriveFileId(url);
  if (!fileId) {
    return res.status(400).send('Thiếu fileId hoặc URL Google Drive hợp lệ');
  }

  try {
    let drive = await getAuthenticatedDriveClient(account.id);
    if (!drive && cfg.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const auth = Google.getAuth(cfg);
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
  const { cfg, account } = req;
  const { id } = req.query;
  if (!id) return res.status(400).send('Thiếu fileId');

  try {
    let drive = await getAuthenticatedDriveClient(account.id);
    if (!drive && cfg.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const auth = Google.getAuth(cfg);
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
  const rt = getRuntime(req.account.id);
  res.json({
    success: true,
    config: rt.scheduleConfig,
    state: {
      ...rt.scheduleState,
      secondsUntilNextRun: (rt.scheduleState.nextRunTime && rt.scheduleConfig.enabled && !rt.scheduleState.isProcessing)
        ? Math.max(0, Math.round((rt.scheduleState.nextRunTime - Date.now()) / 1000))
        : null
    }
  });
});

app.post('/api/schedule/toggle', requireStudioAccess, (req, res) => {
  const { account } = req;
  const rt = getRuntime(account.id);
  rt.scheduleConfig.enabled = !rt.scheduleConfig.enabled;
  if (rt.scheduleConfig.enabled) {
    addLog(account.id, 'info', `🟢 Đã BẬT lịch chạy tự động (Chu kỳ quét: ${rt.scheduleConfig.intervalSeconds}s, Chế độ liên tiếp: ${rt.scheduleConfig.continuous ? 'BẬT' : 'TẮT'}).`);
    executeScheduledRun(account.id);
  } else {
    addLog(account.id, 'warning', '🔴 Đã TẮT lịch chạy tự động.');
    if (rt.scheduleTimer) clearTimeout(rt.scheduleTimer);
    rt.scheduleState.nextRunTime = null;
    rt.scheduleState.currentStatus = 'Đã tạm dừng';
  }

  res.json({
    success: true,
    enabled: rt.scheduleConfig.enabled,
    config: rt.scheduleConfig,
    state: rt.scheduleState
  });
});

app.post('/api/schedule/config', requireStudioAccess, (req, res) => {
  const { account } = req;
  const rt = getRuntime(account.id);
  const { intervalSeconds, continuous, timeRangeEnabled, startHour, endHour, maxPerBatch } = req.body;

  if (intervalSeconds !== undefined) {
    rt.scheduleConfig.intervalSeconds = Math.max(10, parseInt(intervalSeconds, 10));
  }
  if (continuous !== undefined) {
    rt.scheduleConfig.continuous = !!continuous;
  }
  if (timeRangeEnabled !== undefined) {
    rt.scheduleConfig.timeRangeEnabled = !!timeRangeEnabled;
  }
  if (startHour !== undefined) {
    rt.scheduleConfig.startHour = parseInt(startHour, 10);
  }
  if (endHour !== undefined) {
    rt.scheduleConfig.endHour = parseInt(endHour, 10);
  }
  if (maxPerBatch !== undefined) {
    rt.scheduleConfig.maxPerBatch = Math.max(1, parseInt(maxPerBatch, 10));
  }

  addLog(account.id, 'info', `⚙️ Đã cập nhật cấu hình Schedule: Chu kỳ ${rt.scheduleConfig.intervalSeconds}s, Làm liên tiếp: ${rt.scheduleConfig.continuous ? 'Có' : 'Không'}.`);

  if (rt.scheduleConfig.enabled && !rt.scheduleState.isProcessing) {
    scheduleNextRun(account.id);
  }

  res.json({
    success: true,
    config: rt.scheduleConfig,
    state: rt.scheduleState
  });
});

app.post('/api/schedule/run-now', requireStudioAccess, async (req, res) => {
  const { account } = req;
  const rt = getRuntime(account.id);
  if (rt.scheduleState.isProcessing) {
    return res.status(409).json({ success: false, message: 'Đang có tiến trình tạo video đang chạy.' });
  }

  addLog(account.id, 'info', '⚡ Kích hoạt quét và xử lý hàng đợi ngay lập tức...');
  res.json({ success: true, message: 'Bắt đầu quét ngay lập tức.' });

  executeScheduledRun(account.id);
});

// Tương thích ngược với nút bật tắt cũ
app.post('/api/worker/toggle', requireStudioAccess, (req, res) => {
  const { account } = req;
  const rt = getRuntime(account.id);
  rt.scheduleConfig.enabled = !rt.scheduleConfig.enabled;
  if (rt.scheduleConfig.enabled) {
    addLog(account.id, 'info', `🟢 Đã BẬT lịch chạy tự động.`);
    executeScheduledRun(account.id);
  } else {
    addLog(account.id, 'warning', '🔴 Đã TẮT lịch chạy tự động.');
    if (rt.scheduleTimer) clearTimeout(rt.scheduleTimer);
    rt.scheduleState.nextRunTime = null;
    rt.scheduleState.currentStatus = 'Đã tạm dừng';
  }
  res.json({ workerRunning: rt.scheduleConfig.enabled });
});

// 4b. Lên lịch đăng TikTok tự động theo KHUNG GIỜ CỐ ĐỊNH (TÁCH RIÊNG khỏi lịch tạo video ở trên)
app.get('/api/tiktok/schedule', (req, res) => {
  const rt = getRuntime(req.account.id);
  res.json({
    success: true,
    config: rt.tiktokScheduleConfig,
    state: {
      ...rt.tiktokScheduleState,
      secondsUntilNextRun: rt.tiktokScheduleConfig.enabled ? secondsUntilNextTikTokSlot(rt) : null
    }
  });
});

app.post('/api/tiktok/schedule/toggle', (req, res) => {
  const { account } = req;
  const rt = getRuntime(account.id);
  rt.tiktokScheduleConfig.enabled = !rt.tiktokScheduleConfig.enabled;
  if (rt.tiktokScheduleConfig.enabled) {
    addLog(account.id, 'info', `🟢 Đã BẬT đăng TikTok tự động theo khung giờ: ${rt.tiktokScheduleConfig.postHours.map(h => h + 'h').join(', ')} mỗi ngày.`);
    startTikTokScheduleChecker(account.id);
  } else {
    addLog(account.id, 'warning', '🔴 Đã TẮT đăng TikTok tự động.');
    stopTikTokScheduleChecker(account.id);
    rt.tiktokScheduleState.currentStatus = 'Đã tạm dừng';
  }
  res.json({
    success: true,
    enabled: rt.tiktokScheduleConfig.enabled,
    config: rt.tiktokScheduleConfig,
    state: rt.tiktokScheduleState
  });
});

app.post('/api/tiktok/schedule/config', (req, res) => {
  const { account } = req;
  const rt = getRuntime(account.id);
  const { postHours } = req.body;
  if (Array.isArray(postHours)) {
    const cleaned = postHours
      .map(h => parseInt(h, 10))
      .filter(h => Number.isInteger(h) && h >= 0 && h <= 23);
    if (cleaned.length > 0) {
      rt.tiktokScheduleConfig.postHours = [...new Set(cleaned)].sort((a, b) => a - b);
    }
  }
  addLog(account.id, 'info', `⚙️ Đã cập nhật khung giờ đăng TikTok tự động: ${rt.tiktokScheduleConfig.postHours.map(h => h + 'h').join(', ')}.`);
  res.json({ success: true, config: rt.tiktokScheduleConfig, state: rt.tiktokScheduleState });
});

// 5. Chạy tạo video cho 1 dòng cụ thể từ Google Sheet
app.post('/api/queue/run-item', requireStudioAccess, async (req, res) => {
  const { cfg, account } = req;
  const rt = getRuntime(account.id);
  const { row } = req.body;
  if (!row) return res.status(400).json({ error: 'Thiếu thông tin hàng' });

  addLog(account.id, 'info', `🚀 Nhận lệnh xử lý hàng #${row.rowNumber} (${row['Tên Sản Phẩm']})...`);
  rt.currentProcessingItem = { productName: row['Tên Sản Phẩm'], status: 'Đang khởi chạy luồng xử lý...', startTime: Date.now() };

  res.json({ success: true, message: `Bắt đầu xử lý hàng #${row.rowNumber}` });

  withRenderLock(async () => {
    try {
      await processRow(row, (lvl, msg) => addLog(account.id, lvl, msg), cfg);
    } catch (e) {
      addLog(account.id, 'error', `Lỗi xử lý hàng #${row.rowNumber}: ${e.message}`);
    } finally {
      rt.currentProcessingItem = null;
    }
  });
});

// 6. Kích hoạt Đăng bài TikTok (đồng bộ n8n)
app.post('/api/tiktok/publish', async (req, res) => {
  const { cfg, account } = req;
  const { rowNumber, row } = req.body;
  if (!rowNumber && !row) return res.status(400).json({ error: 'Thiếu thông tin hàng' });

  let targetRow = row;
  if (!targetRow && rowNumber) {
    targetRow = await Google.getRowByNumber(rowNumber, cfg);
  }

  if (!targetRow) {
    return res.status(404).json({ error: 'Không tìm thấy dữ liệu hàng' });
  }

  addLog(account.id, 'info', `📱 Nhận yêu cầu đăng TikTok cho hàng #${targetRow.rowNumber} ("${targetRow['Tên Sản Phẩm']}")...`);
  res.json({ success: true, message: `Bắt đầu tiến trình đăng TikTok cho hàng #${targetRow.rowNumber}` });

  (async () => {
    try {
      await triggerTikTokUpload(targetRow, (lvl, msg) => addLog(account.id, lvl, msg), cfg);
    } catch (err) {
      addLog(account.id, 'error', `Lỗi đăng TikTok hàng #${targetRow.rowNumber}: ${err.message}`);
    }
  })();
});

// Cấu hình TikTok Direct Engine (theo account)
app.get('/api/tiktok/config', (req, res) => {
  const { cfg } = req;
  res.json({
    configured: isTikTokConfigured(cfg.TIKTOK_SESSION_JSON),
    hasSession: !!cfg.TIKTOK_SESSION_JSON,
    proxyUrl: cfg.TIKTOK_PROXY_URL || '',
    autoPublish: cfg.TIKTOK_AUTO_PUBLISH
  });
});

app.post('/api/tiktok/config', async (req, res) => {
  const { account } = req;
  const { sessionJson, proxyUrl, autoPublish } = req.body;
  const patch = {};

  if (sessionJson !== undefined) {
    const normalized = normalizeTikTokSession(sessionJson);
    patch.TIKTOK_SESSION_JSON = normalized || (sessionJson || '').trim();
  }
  if (proxyUrl !== undefined) {
    patch.TIKTOK_PROXY_URL = (proxyUrl || '').trim();
  }
  if (autoPublish !== undefined) {
    patch.TIKTOK_AUTO_PUBLISH = !!autoPublish;
  }

  const updated = await updateAccountSettings(account.id, patch);
  const newCfg = getAccountConfig(updated);

  addLog(account.id, 'info', `⚙️ Đã cập nhật cấu hình TikTok Engine: Session=${isTikTokConfigured(newCfg.TIKTOK_SESSION_JSON) ? 'Hợp lệ' : 'Trống/Chưa đúng định dạng'}, Auto-Publish=${newCfg.TIKTOK_AUTO_PUBLISH ? 'Bật' : 'Tắt'}`);
  res.json({
    success: true,
    configured: isTikTokConfigured(newCfg.TIKTOK_SESSION_JSON),
    autoPublish: newCfg.TIKTOK_AUTO_PUBLISH
  });
});

// Cấu hình Webhook n8n cho TikTok (theo account, dự phòng nếu cần)
app.get('/api/config/n8n', (req, res) => {
  const { cfg } = req;
  res.json({
    webhookUrl: cfg.N8N_TIKTOK_WEBHOOK_URL || '',
    configured: !!cfg.N8N_TIKTOK_WEBHOOK_URL
  });
});

app.post('/api/config/n8n', async (req, res) => {
  const { account } = req;
  const { webhookUrl } = req.body;
  const updated = await updateAccountSettings(account.id, { N8N_TIKTOK_WEBHOOK_URL: (webhookUrl || '').trim() });
  const newCfg = getAccountConfig(updated);

  addLog(account.id, 'info', `⚙️ Đã lưu cấu hình n8n Webhook: ${newCfg.N8N_TIKTOK_WEBHOOK_URL || '(Chưa điền, dùng chế độ Cron Sheet)'}`);
  res.json({ success: true, webhookUrl: newCfg.N8N_TIKTOK_WEBHOOK_URL });
});

// Cấu hình nghiệp vụ chung theo account (Sheet ID, Drive folder, Telegram, Gemini key, Flow Project, Engine)
app.get('/api/config/account', (req, res) => {
  const { cfg } = req;
  res.json({
    success: true,
    settings: {
      SHEET_DOCUMENT_ID: cfg.SHEET_DOCUMENT_ID || '',
      DRIVE_OUTPUT_FOLDER_ID: cfg.DRIVE_OUTPUT_FOLDER_ID || '',
      FLOW_PROJECT_ID: cfg.FLOW_PROJECT_ID || '',
      TELEGRAM_BOT_TOKEN: cfg.TELEGRAM_BOT_TOKEN || '',
      TELEGRAM_CHAT_ID: cfg.TELEGRAM_CHAT_ID || '',
      GEMINI_API_KEY: cfg.GEMINI_API_KEY || '',
      ENGINE: cfg.ENGINE || 'vids'
    }
  });
});

app.post('/api/config/account', async (req, res) => {
  const { account } = req;
  const allowed = ['SHEET_DOCUMENT_ID', 'DRIVE_OUTPUT_FOLDER_ID', 'FLOW_PROJECT_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GEMINI_API_KEY', 'ENGINE'];
  const patch = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) patch[key] = String(req.body[key]).trim();
  }
  await updateAccountSettings(account.id, patch);
  addLog(account.id, 'info', '⚙️ Đã cập nhật cấu hình tài khoản (Sheet/Drive/Telegram/Gemini/Engine).');
  res.json({ success: true });
});

// 6. Gợi ý kịch bản video AI từ tên sản phẩm
app.post('/api/ai/suggest-script', async (req, res) => {
  const { cfg, account } = req;
  const { productName } = req.body;
  if (!productName) return res.status(400).json({ error: 'Thiếu tên sản phẩm' });

  try {
    addLog(account.id, 'info', `🤖 Gemini đang viết kịch bản và caption review TikTok cho: ${productName}...`);
    const script = `Review chân thực ${productName}: Thiết kế hiện đại, tiện lợi. Dùng thử siêu ưng ý, xem ngay tại giỏ hàng góc trái bên dưới nha!`;
    const caption = await AI.generateCaption({ productName, contentVideo: script }, cfg.GEMINI_API_KEY);

    addLog(account.id, 'success', '✨ Đã tạo kịch bản và caption review thành công!');
    res.json({ success: true, script, caption });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Kích hoạt mở Chrome đăng nhập Ultra — thao tác trên Chrome profile DÙNG CHUNG của engine Google
// Vids (xem Giai đoạn 2 trong kế hoạch để tách riêng theo account), nên chỉ admin mới được gọi.
app.post('/api/chrome/login', requireAdmin, (req, res) => {
  exec('npm run login', (err) => {
    if (err) console.error(`Lỗi mở Chrome: ${err.message}`);
  });
  res.json({ success: true, message: 'Chrome đang được mở trên máy chủ.' });
});

// OAuth 2.0 cho Google Drive — mỗi account tự kết nối Drive riêng của họ
app.get('/api/auth/google/url', (req, res) => {
  try {
    const url = getAuthUrl();
    res.json({ success: true, url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { account } = req;
  const { code } = req.query;
  if (!code) return res.status(400).send('Thiếu OAuth authorization code.');

  try {
    const result = await handleCallback(code, account.id);
    addLog(account.id, 'success', `🎉 Đã kết nối Google Drive OAuth2 thành công với tài khoản: ${result.email}!`);
    res.redirect('/#settings?oauth=success');
  } catch (err) {
    addLog(account.id, 'error', `Lỗi kết nối Google Drive OAuth2: ${err.message}`);
    res.redirect('/#settings?oauth=error&message=' + encodeURIComponent(err.message));
  }
});

app.get('/api/auth/google/status', async (req, res) => {
  res.json(await getOAuthStatus(req.account.id));
});

app.post('/api/auth/google/disconnect', async (req, res) => {
  await disconnectOAuth(req.account.id);
  addLog(req.account.id, 'warning', 'Đã ngắt kết nối Google Drive OAuth2.');
  res.json({ success: true });
});

// Cấu hình OAuth Client ID/Secret — dùng CHUNG cho toàn bộ app (giống mọi SaaS dùng 1 OAuth app,
// mỗi account tự cấp quyền/token riêng), nên chỉ admin mới được đổi, tránh 1 tenant làm hỏng OAuth
// của tất cả mọi người.
app.post('/api/auth/google/config', requireAdmin, (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'Vui lòng cung cấp cả Client ID và Client Secret' });
  }

  CONFIG.GOOGLE_CLIENT_ID = clientId.trim();
  CONFIG.GOOGLE_CLIENT_SECRET = clientSecret.trim();

  try {
    const envPath = path.resolve('.env');
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    if (!envContent.includes('GOOGLE_CLIENT_ID=')) {
      envContent += `\nGOOGLE_CLIENT_ID=${clientId.trim()}\nGOOGLE_CLIENT_SECRET=${clientSecret.trim()}\n`;
    } else {
      envContent = envContent.replace(/GOOGLE_CLIENT_ID=.*/g, `GOOGLE_CLIENT_ID=${clientId.trim()}`);
      envContent = envContent.replace(/GOOGLE_CLIENT_SECRET=.*/g, `GOOGLE_CLIENT_SECRET=${clientSecret.trim()}`);
    }
    fs.writeFileSync(envPath, envContent);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Lỗi ghi file .env: ' + e.message });
  }
});

// 8. Tạo video trực tiếp từ Studio & Tự động đẩy Drive + Telegram
app.post('/api/create-video', requireStudioAccess, async (req, res) => {
  const { cfg, account } = req;
  const rt = getRuntime(account.id);
  const { productName, script } = req.body;
  if (!productName) return res.status(400).json({ error: 'Vui lòng nhập tên sản phẩm' });

  addLog(account.id, 'info', `🚀 Bắt đầu tạo video từ Studio cho sản phẩm: "${productName}"`);
  rt.currentProcessingItem = { productName, status: 'Đang tạo video bằng Google Vids...', startTime: Date.now() };

  res.json({ success: true, message: 'Đã tiếp nhận yêu cầu. Theo dõi tiến trình trong nhật ký.' });

  withRenderLock(async () => {
    const workDir = path.resolve(`temp/run_${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      addLog(account.id, 'info', '🎬 Đang kết nối Google Vids...');
      const fullPrompt = `tạo cho tôi 1 video review sản phẩm ${productName}, người mẫu giới thiệu tự nhiên, cầm sản phẩm trên tay mỉm cười. Khung hình dọc 9:16. ${script || ''}`.trim();

      const videoFile = await createVideoInGoogleVids({
        prompt: fullPrompt,
        outputDir: workDir
      });

      addLog(account.id, 'success', `🎉 Video đã được tạo thành công: ${path.basename(videoFile)}`);

      let fileToUpload = videoFile;
      const logoFile = await resolveLogoPath(null, (lvl, msg) => addLog(account.id, lvl, msg), cfg);
      if (logoFile && fs.existsSync(logoFile)) {
        addLog(account.id, 'info', `🏷️ Gắn logo kênh: ${path.basename(logoFile)} (góc dưới phải)...`);
        const videoWithLogo = path.join(workDir, 'video_with_logo.mp4');
        try {
          await mergeVideosWithFfmpeg([videoFile], logoFile, videoWithLogo);
          if (fs.existsSync(videoWithLogo)) fileToUpload = videoWithLogo;
        } catch (logoErr) {
          addLog(account.id, 'warning', `Lỗi gắn logo: ${logoErr.message}`);
        }
      }

      let finalVideoUrl = '';
      try {
        addLog(account.id, 'info', '☁️ Đang upload video lên Google Drive...');
        const fileId = await Google.uploadVideoToDrive(fileToUpload, `${Date.now()}_${productName}.mp4`, cfg);
        finalVideoUrl = `https://drive.google.com/file/d/${fileId}`;
        addLog(account.id, 'success', `Đã lưu Drive: ${finalVideoUrl}`);

        try {
          if (fs.existsSync(videoFile)) fs.unlinkSync(videoFile);
          if (fs.existsSync(fileToUpload)) fs.unlinkSync(fileToUpload);
        } catch (cleanErr) {}
      } catch (err) {
        addLog(account.id, 'warning', `Upload Drive lỗi: ${err.message}`);
      }

      addLog(account.id, 'info', '📝 Đang dùng AI tạo Caption TikTok cuốn hút cho sản phẩm...');
      let caption = '';
      if (cfg.GEMINI_API_KEY) {
        caption = await AI.generateCaption({ productName, contentVideo: script }, cfg.GEMINI_API_KEY);
      } else {
        caption = AI.createSmartFallbackCaption(productName, script);
      }

      addLog(account.id, 'info', '📱 Đang gửi thông báo Telegram...');
      await sendTelegram(`🟢 Review Sản Phẩm: Tạo Thành Công Video "${productName}" từ Studio Web!\n👉 Link Video: ${finalVideoUrl}\n\n📝 Caption: ${caption}`, cfg);

      addLog(account.id, 'success', '✨ Toàn bộ quy trình Studio hoàn tất 100%!');
    } catch (err) {
      addLog(account.id, 'error', `Tạo video thất bại: ${err.message}`);
    } finally {
      rt.currentProcessingItem = null;
    }
  });
});

// 9. Lấy danh sách video từ Google Drive (Kho Video)
app.get('/api/videos', async (req, res) => {
  const { cfg, account } = req;
  try {
    let drive = await getAuthenticatedDriveClient(account.id);
    if (!drive && cfg.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const auth = Google.getAuth(cfg);
      drive = google.drive({ version: 'v3', auth });
    }

    if (!drive) {
      return res.json([]);
    }

    const driveRes = await drive.files.list({
      q: `'${cfg.DRIVE_OUTPUT_FOLDER_ID}' in parents and trashed = false`,
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
  const { cfg, account } = req;
  try {
    const { productId, productName } = req.body;
    if (!productId) return res.status(400).json({ error: 'Thiếu productId' });
    const result = await ensureProductInShowcase({
      productId,
      productName,
      sessionJson: cfg.TIKTOK_SESSION_JSON,
      logger: (lvl, msg) => addLog(account.id, lvl, msg)
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/showcase/add', async (req, res) => {
  const { cfg } = req;
  try {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ error: 'Thiếu productId' });
    const result = await addProductToShowcase(productId, cfg.TIKTOK_SESSION_JSON);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/showcase/list', async (req, res) => {
  const { cfg } = req;
  try {
    const products = await getShowcaseProducts(cfg.TIKTOK_SESSION_JSON, req.query.refresh === 'true');
    res.json({ total: products.length, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= HỆ THỐNG LẬP LỊCH SCHEDULE WORKER (theo account) =================

function scheduleNextRun(accountId, delayMs = null) {
  const rt = getRuntime(accountId);
  if (rt.scheduleTimer) {
    clearTimeout(rt.scheduleTimer);
    rt.scheduleTimer = null;
  }

  if (!rt.scheduleConfig.enabled) {
    rt.scheduleState.nextRunTime = null;
    rt.scheduleState.currentStatus = 'Đã tạm dừng';
    return;
  }

  const waitMs = delayMs !== null ? delayMs : (rt.scheduleConfig.intervalSeconds * 1000);
  rt.scheduleState.nextRunTime = Date.now() + waitMs;
  rt.scheduleState.currentStatus = `Chờ đợt quét tiếp theo (${Math.round(waitMs / 1000)}s)...`;

  rt.scheduleTimer = setTimeout(() => executeScheduledRun(accountId), waitMs);
}

async function executeScheduledRun(accountId) {
  const rt = getRuntime(accountId);
  if (!rt.scheduleConfig.enabled) return;
  if (rt.scheduleState.isProcessing) return;
  if (!(await isAccountLicenseActive(accountId))) {
    rt.scheduleConfig.enabled = false;
    rt.scheduleState.currentStatus = 'Đã tạm dừng (license không còn hiệu lực)';
    return;
  }

  const cfg = await loadFreshCfg(accountId);
  if (!cfg) return;

  if (rt.scheduleConfig.timeRangeEnabled) {
    const currentHour = new Date().getHours();
    if (currentHour < rt.scheduleConfig.startHour || currentHour >= rt.scheduleConfig.endHour) {
      rt.scheduleState.currentStatus = `Ngoài khung giờ hẹn (${rt.scheduleConfig.startHour}h - ${rt.scheduleConfig.endHour}h)`;
      scheduleNextRun(accountId, 60000);
      return;
    }
  }

  rt.scheduleState.isProcessing = true;
  rt.scheduleState.lastRunTime = Date.now();
  rt.scheduleState.currentStatus = 'Đang quét hàng đợi Google Sheets...';

  try {
    let processedInThisBatch = 0;
    while (rt.scheduleConfig.enabled && processedInThisBatch < (rt.scheduleConfig.maxPerBatch || 10)) {
      const row = await Google.fetchQueueRow(cfg);
      if (!row) {
        addLog(accountId, 'info', 'ℹ️ Hàng đợi Google Sheets không còn dòng nào "Chờ Tạo".');
        rt.scheduleState.currentStatus = 'Hết hàng chờ tạo';
        break;
      }

      rt.scheduleState.currentProcessingRow = row.rowNumber;
      rt.scheduleState.currentStatus = `Đang xử lý hàng #${row.rowNumber} (${row['Tên Sản Phẩm']})...`;
      rt.currentProcessingItem = { productName: row['Tên Sản Phẩm'], status: `Đang xử lý hàng #${row.rowNumber}...`, startTime: Date.now() };

      addLog(accountId, 'info', `⏰ [Schedule] Tự động xử lý hàng #${row.rowNumber}: "${row['Tên Sản Phẩm']}"`);
      await withRenderLock(() => processRow(row, (lvl, msg) => addLog(accountId, lvl, msg), cfg));

      processedInThisBatch++;
      rt.scheduleState.totalProcessedSession++;
      rt.currentProcessingItem = null;
      rt.scheduleState.currentProcessingRow = null;

      if (!rt.scheduleConfig.continuous) {
        break;
      }

      // Nghỉ nhẹ 3 giây giữa các hàng để Google Vids và Chrome giải phóng bộ nhớ
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (err) {
    addLog(accountId, 'error', `[Schedule] Lỗi trong tiến trình tự động: ${err.message}`);
    rt.scheduleState.currentStatus = `Lỗi: ${err.message}`;
  } finally {
    rt.scheduleState.isProcessing = false;
    rt.currentProcessingItem = null;
    rt.scheduleState.currentProcessingRow = null;

    if (rt.scheduleConfig.enabled) {
      scheduleNextRun(accountId);
    } else {
      rt.scheduleState.currentStatus = 'Đã tạm dừng';
    }
  }
}

// ================= HỆ THỐNG LẬP LỊCH ĐĂNG TIKTOK TỰ ĐỘNG THEO KHUNG GIỜ (theo account) =================

const pad2 = (n) => String(n).padStart(2, '0');

function slotKeyFor(date, hour) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}-${pad2(hour)}`;
}

function secondsUntilNextTikTokSlot(rt) {
  if (!rt.tiktokScheduleConfig.postHours || rt.tiktokScheduleConfig.postHours.length === 0) return null;
  const now = new Date();
  const sorted = [...rt.tiktokScheduleConfig.postHours].sort((a, b) => a - b);
  for (const h of sorted) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0, 0);
    if (candidate.getTime() > now.getTime()) {
      return Math.round((candidate.getTime() - now.getTime()) / 1000);
    }
  }
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, sorted[0], 0, 0, 0);
  return Math.round((tomorrow.getTime() - now.getTime()) / 1000);
}

function startTikTokScheduleChecker(accountId) {
  const rt = getRuntime(accountId);
  if (rt.tiktokScheduleCheckInterval) return;
  rt.tiktokScheduleState.currentStatus = 'Đang chờ khung giờ đăng tiếp theo...';
  rt.tiktokScheduleCheckInterval = setInterval(() => checkTikTokScheduleSlot(accountId), 30000);
  checkTikTokScheduleSlot(accountId);
}

function stopTikTokScheduleChecker(accountId) {
  const rt = getRuntime(accountId);
  if (rt.tiktokScheduleCheckInterval) {
    clearInterval(rt.tiktokScheduleCheckInterval);
    rt.tiktokScheduleCheckInterval = null;
  }
}

async function checkTikTokScheduleSlot(accountId) {
  const rt = getRuntime(accountId);
  if (!rt.tiktokScheduleConfig.enabled) return;
  if (rt.tiktokScheduleState.isProcessing) return;
  if (!(await isAccountLicenseActive(accountId))) {
    rt.tiktokScheduleConfig.enabled = false;
    stopTikTokScheduleChecker(accountId);
    rt.tiktokScheduleState.currentStatus = 'Đã tạm dừng (license không còn hiệu lực)';
    return;
  }

  const now = new Date();
  const currentHour = now.getHours();
  if (!rt.tiktokScheduleConfig.postHours.includes(currentHour)) return;

  const slotKey = slotKeyFor(now, currentHour);
  if (rt.tiktokScheduleState.lastPostedKey === slotKey) return;

  const cfg = await loadFreshCfg(accountId);
  if (!cfg) return;

  rt.tiktokScheduleState.isProcessing = true;
  rt.tiktokScheduleState.lastRunTime = Date.now();
  rt.tiktokScheduleState.currentStatus = `Đang đăng video cho khung giờ ${currentHour}h...`;

  try {
    const result = await runTikTokWorker((lvl, msg) => addLog(accountId, lvl, msg), cfg);
    rt.tiktokScheduleState.lastPostedKey = slotKey;
    if (result) {
      rt.tiktokScheduleState.totalPostedSession++;
      rt.tiktokScheduleState.currentStatus = `Đã đăng xong video cho khung giờ ${currentHour}h.`;
    } else {
      rt.tiktokScheduleState.currentStatus = `Khung giờ ${currentHour}h: không có video nào đang "Chờ Đăng".`;
    }
  } catch (err) {
    addLog(accountId, 'error', `[TikTok Schedule] Lỗi: ${err.message}`);
    rt.tiktokScheduleState.currentStatus = `Lỗi: ${err.message}`;
    rt.tiktokScheduleState.lastPostedKey = slotKey;
  } finally {
    rt.tiktokScheduleState.isProcessing = false;
  }
}

// Khởi động server
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🌐 TRUY CẬP GIAO DIỆN TẠI: http://localhost:${PORT}`);
  console.log(`🔧 TRANG QUẢN TRỊ LICENSE: http://localhost:${PORT}/admin.html`);
  console.log(`======================================================\n`);
});
