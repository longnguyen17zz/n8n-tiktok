import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CONFIG } from './config.js';
import * as Google from './google.js';
import { ensureProductInShowcase } from './showcase.js';

const require = createRequire(import.meta.url);

// Mock n8n-workflow dependency needed by Botzvn TikTok node
const Module = require('module');
const origRequire = Module.prototype.require;

class NodeOperationError extends Error {
  constructor(node, message) {
    super(typeof message === 'string' ? message : (message?.message || String(message)));
  }
}

Module.prototype.require = function(request) {
  if (request === 'n8n-workflow') {
    return {
      NodeConnectionType: { Main: 'main' },
      NodeOperationError,
      NodeApiError: NodeOperationError
    };
  }
  return origRequire.apply(this, arguments);
};

// Khởi tạo instance của node TikTok Upload
const enginePath = path.resolve('src/tiktok_engine/nodes/Tiktok/VxVx.node.js');
let TikTokNodeClass = null;
let tikTokInstance = null;

try {
  const m = require(enginePath);
  TikTokNodeClass = Object.values(m)[0];
  if (TikTokNodeClass) {
    tikTokInstance = new TikTokNodeClass();
  }
} catch (err) {
  console.error('⚠️ Không thể nạp module TikTok Upload Engine:', err.message);
}

// [DEBUG TẠM THỜI] Log toàn bộ phản hồi gốc từ TikTok khi tạo bài đăng thất bại,
// vì engine chỉ ném ra message rút gọn ("Post creation failed: ..."), che mất chi tiết lỗi thật.
try {
  const xUPath = path.resolve('src/tiktok_engine/utils/xU.js');
  const xUModule = require.cache[xUPath];
  if (xUModule && xUModule.exports && typeof xUModule.exports.postVideo === 'function') {
    const originalPostVideo = xUModule.exports.postVideo;
    xUModule.exports.postVideo = async function(...args) {
      const result = await originalPostVideo.apply(this, args);
      console.error('🔬 [DEBUG] Full postVideo() response from TikTok:', JSON.stringify(result, null, 2));
      return result;
    };
  } else {
    console.error('⚠️ [DEBUG] Không tìm thấy xU.js trong require.cache để gắn debug hook.');
  }
} catch (e) {
  console.error('⚠️ [DEBUG] Lỗi gắn debug hook postVideo:', e.message);
}

/**
 * Chuẩn hóa chuỗi TikTok session (hỗ trợ cả JSON thô và chuỗi mã hóa Base64)
 */
export function normalizeTikTokSession(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Thử parse trực tiếp dạng JSON thô
  try {
    const obj = JSON.parse(trimmed);
    if (obj && (obj.http || obj.cookies)) {
      return JSON.stringify(obj);
    }
  } catch (e) {}

  // 2. Thử giải mã Base64 sang JSON (nếu người dùng copy từ base64 / n8n export)
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    const obj = JSON.parse(decoded);
    if (obj && (obj.http || obj.cookies)) {
      return JSON.stringify(obj);
    }
  } catch (e) {}

  return null;
}

/**
 * Kiểm tra xem cấu hình TikTok session có hợp lệ không
 */
export function isTikTokConfigured() {
  return !!normalizeTikTokSession(CONFIG.TIKTOK_SESSION_JSON);
}

/**
 * Upload và đăng video trực tiếp lên TikTok với Product Anchor (TikTok Shop)
 */
export async function uploadVideoToTikTok({
  videoPathOrUrl,
  caption,
  productId,
  productName,
  sessionJson = null,
  proxyUrl = null,
  visibilityType = 0, // 0: Public, 1: Private, 2: Friends
  allowComment = 1,
  scheduleTime = 0,
  logger = (level, msg) => console.log(`[${level}] ${msg}`)
}) {
  if (!tikTokInstance) {
    throw new Error('TikTok Engine chưa được khởi tạo thành công.');
  }

  const rawSession = (sessionJson || CONFIG.TIKTOK_SESSION_JSON || '').trim();
  const validSessionJson = normalizeTikTokSession(rawSession);
  if (!validSessionJson) {
    throw new Error('Chưa cấu hình TikTok Session hoặc định dạng Session không hợp lệ! Vui lòng vào tab Cấu hình trên Web để dán TikTok Session (JSON hoặc Base64).');
  }

  const tempDir = path.resolve('temp');
  fs.mkdirSync(tempDir, { recursive: true });

  let localVideoPath = videoPathOrUrl;
  let tempDownloaded = false;

  // 1. Nếu video là link Google Drive hoặc ID
  if (videoPathOrUrl.startsWith('http') || !fs.existsSync(videoPathOrUrl)) {
    const driveId = Google.extractDriveFileId(videoPathOrUrl);
    if (driveId) {
      logger('info', `📥 Đang tải video từ Google Drive (ID: ${driveId}) để chuẩn bị đăng TikTok...`);
      localVideoPath = path.join(tempDir, `tiktok_upload_${Date.now()}_${driveId}.mp4`);
      const videoBuffer = await Google.downloadFileAsBase64(driveId);
      fs.writeFileSync(localVideoPath, videoBuffer);
      tempDownloaded = true;
      logger('success', `Đã tải video tạm về: ${path.basename(localVideoPath)} (${(videoBuffer.length / (1024 * 1024)).toFixed(2)} MB)`);
    } else {
      throw new Error(`Không tìm thấy file video hợp lệ từ đường dẫn: ${videoPathOrUrl}`);
    }
  }

  if (!fs.existsSync(localVideoPath)) {
    throw new Error(`File video không tồn tại tại đường dẫn: ${localVideoPath}`);
  }

  logger('info', `🚀 Bắt đầu quá trình đăng video lên kênh TikTok...`);
  
  let showcaseStatus = null;
  if (productId) {
    logger('info', `🏷️ Gắn giỏ hàng TikTok Shop: [ID: ${productId}] - "${productName || 'Sản phẩm'}"`);
    try {
      showcaseStatus = await ensureProductInShowcase({
        productId,
        productName,
        sessionJson: validSessionJson,
        logger
      });
      if (showcaseStatus.inStock === false) {
        logger('warning', `⚠️ Lưu ý: Giỏ hàng có thể không hiển thị trên video vì sản phẩm đã HẾT HÀNG trên TikTok Shop.`);
      }
    } catch (e) {
      logger('warning', `⚠️ Lỗi kiểm tra sàn Showcase: ${e.message}`);
    }
  }
  logger('info', `📝 Caption: "${caption}"`);

  // Tạo ngữ cảnh thực thi cho Botzvn TikTok Upload node
  const executionContext = {
    getNode() {
      return { name: 'TikTok Upload' };
    },
    getInputData() {
      return [{ json: {} }];
    },
    async getCredentials(type) {
      return {
        tiktokSession: validSessionJson,
        proxyUrl: (proxyUrl || CONFIG.TIKTOK_PROXY_URL || '').trim()
      };
    },
    getNodeParameter(name) {
      const anchorsList = [];
      if (productId) {
        anchorsList.push({
          type: 'product',
          productId: String(productId).trim(),
          displayName: String(productName || 'Mua ngay').trim().slice(0, 30) || 'Mua ngay'
        });
      }

      const postSettingsObj = {
        text: caption || '',
        visibilityType: parseInt(visibilityType, 10) || 0,
        allowComment: parseInt(allowComment, 10) !== 0 ? 1 : 0,
        scheduleTime: parseInt(scheduleTime, 10) || 0,
        anchors: {
          anchor: anchorsList
        }
      };

      if (name === 'videoInputType') return 'filepath';
      if (name === 'videoFilePath') return localVideoPath;
      if (name === 'coverInputType') return 'none';
      if (name === 'postSettings') return postSettingsObj;
      if (name === 'postSettings.text') return postSettingsObj.text;
      if (name === 'postSettings.visibilityType') return postSettingsObj.visibilityType;
      if (name === 'postSettings.allowComment') return postSettingsObj.allowComment;
      if (name === 'postSettings.scheduleTime') return postSettingsObj.scheduleTime;
      if (name === 'postSettings.anchors') return { anchor: anchorsList };
      return '';
    }
  };

  Object.setPrototypeOf(executionContext, tikTokInstance);

  try {
    const uploadResult = await tikTokInstance.execute.call(executionContext);
    logger('success', '🎉 Đã đăng video thành công lên kênh TikTok!');
    return {
      success: true,
      result: uploadResult,
      showcaseStatus
    };
  } catch (uploadErr) {
    logger('error', `❌ Đăng video TikTok thất bại: ${uploadErr.message}`);
    console.error('[TikTok Engine stack trace]', uploadErr.stack);
    throw uploadErr;
  } finally {
    if (tempDownloaded && fs.existsSync(localVideoPath)) {
      try {
        fs.unlinkSync(localVideoPath);
      } catch (e) {}
    }
  }
}
