import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import axios from 'axios';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import * as Google from './google.js';
import * as AI from './ai.js';
import * as NanoAI from './nanoai.js';
import { mergeVideosWithFfmpeg } from './ffmpeg.js';
import { createVideoInGoogleVids } from './vids.js';
import { uploadVideoToTikTok, isTikTokConfigured } from './tiktok.js';

export async function sendTelegram(msg) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN) {
    console.log('ℹ️ Chưa cấu hình TELEGRAM_BOT_TOKEN, bỏ qua gửi Telegram.');
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: msg
    });
    console.log('📱 Đã gửi thông báo Telegram thành công.');
  } catch (err) {
    console.error('Telegram gửi lỗi:', err.message);
  }
}

/**
 * Gửi video + caption qua Telegram để NGƯỜI DÙNG tự đăng tay bằng app TikTok thật — tránh đăng qua
 * API ngầm (dễ bị TikTok âm thầm giảm phát tán dẫn tới 0 view). Caption được gửi riêng trong khối
 * code (```...```) để bấm giữ/copy trên điện thoại là lấy trọn vẹn, dán thẳng vào ô caption TikTok.
 */
export async function sendForManualTikTokPost({ videoPathOrUrl, caption, productId, productName, cartDetail, stt, logger = (l, m) => console.log(`[${l}] ${m}`) }) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN) {
    throw new Error('Chưa cấu hình TELEGRAM_BOT_TOKEN, không thể gửi video để đăng tay.');
  }

  const tempDir = path.resolve('temp');
  fs.mkdirSync(tempDir, { recursive: true });

  let localVideoPath = videoPathOrUrl;
  let tempDownloaded = false;

  if (videoPathOrUrl.startsWith('http') || !fs.existsSync(videoPathOrUrl)) {
    const driveId = Google.extractDriveFileId(videoPathOrUrl);
    if (!driveId) {
      throw new Error(`Không tìm thấy file video hợp lệ từ đường dẫn: ${videoPathOrUrl}`);
    }
    logger('info', `📥 Đang tải video từ Google Drive (ID: ${driveId}) để gửi qua Telegram...`);
    localVideoPath = path.join(tempDir, `telegram_manual_${Date.now()}_${driveId}.mp4`);
    const videoBuffer = await Google.downloadFileAsBase64(driveId);
    fs.writeFileSync(localVideoPath, videoBuffer);
    tempDownloaded = true;
  }

  try {
    const form = new FormData();
    form.append('chat_id', CONFIG.TELEGRAM_CHAT_ID);
    form.append('caption', `🟡 Video sẵn sàng — bài ${stt} (${productName})\n👉 Giỏ hàng: ${cartDetail}\n\n⬇️ Caption để dán ở tin nhắn tiếp theo (bấm giữ để copy)`);
    form.append('video', fs.createReadStream(localVideoPath), { filename: path.basename(localVideoPath) });

    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendVideo`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    if (productId) {
      await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: `🏷️ ID sản phẩm (bấm giữ để copy, dán vào ô tìm sản phẩm khi gắn giỏ hàng):\n` + '```\n' + productId + '\n```',
        parse_mode: 'Markdown'
      });
    }

    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: '```\n' + caption + '\n```',
      parse_mode: 'Markdown'
    });

    logger('success', '📱 Đã gửi video + ID sản phẩm + caption qua Telegram để đăng tay.');
  } finally {
    if (tempDownloaded && fs.existsSync(localVideoPath)) {
      try { fs.unlinkSync(localVideoPath); } catch (e) {}
    }
  }
}

export async function resizeImage1080x1920(buffer) {
  return await sharp(buffer)
    .resize(1080, 1920, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export async function resolveLogoPath(logoNameOrId, logger = console.log) {
  const logosDir = path.resolve('logos');
  fs.mkdirSync(logosDir, { recursive: true });

  const raw = (logoNameOrId || 'logotest.jpg').trim();

  // 1. Kiểm tra nếu là file cục bộ có sẵn trong logos/
  const localCandidate = path.join(logosDir, path.basename(raw));
  if (fs.existsSync(localCandidate)) {
    return localCandidate;
  }

  // 2. Nếu là Google Drive URL hoặc File ID
  const driveId = Google.extractDriveFileId(raw);
  if (driveId) {
    const dest = path.join(logosDir, `logo_${driveId}.jpg`);
    if (fs.existsSync(dest)) return dest;
    try {
      logger('info', `📥 Đang tải logo từ Google Drive (ID: ${driveId})...`);
      const buf = await Google.downloadFileAsBase64(driveId);
      fs.writeFileSync(dest, buf);
      return dest;
    } catch (e) {
      logger('warning', `Lỗi tải logo từ Drive: ${e.message}`);
    }
  }

  // 3. Nếu là tên file trên Google Drive (ví dụ: logotest.jpg, logo_thoitrang.jpg)
  try {
    let drive = await Google.getAuthenticatedDriveClient();
    if (!drive && CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const auth = Google.getAuth();
      drive = (await import('googleapis')).google.drive({ version: 'v3', auth });
    }
    if (drive) {
      const res = await drive.files.list({
        q: `name = '${raw}' and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      if (res.data.files && res.data.files.length > 0) {
        const fileId = res.data.files[0].id;
        logger('info', `📥 Đang tải logo "${raw}" từ Google Drive...`);
        const buf = await Google.downloadFileAsBase64(fileId);
        fs.writeFileSync(localCandidate, buf);
        return localCandidate;
      }
    }
  } catch (e) {}

  // 4. Fallback về file mặc định logotest.jpg nếu có
  const defaultLogo = path.join(logosDir, 'logotest.jpg');
  if (fs.existsSync(defaultLogo)) return defaultLogo;

  return null;
}

export async function triggerTikTokUpload(row, logger = (level, msg) => console.log(`[${level}] ${msg}`)) {
  logger('info', `📱 Bắt đầu luồng đăng bài trực tiếp lên TikTok cho hàng #${row.rowNumber} ("${row['Tên Sản Phẩm']}")`);

  const videoUrl = row['Link Video'];
  if (!videoUrl) {
    const errMsg = 'Hàng chưa có [Link Video] thành phẩm. Hãy chạy WF tạo video trước!';
    logger('error', `❌ ${errMsg}`);
    throw new Error(errMsg);
  }

  // Caption: lấy từ cột "Caption Sản Phẩm", fallback về AI tạo mới hoặc Content Video
  let caption = (row['Caption Sản Phẩm'] || '').trim();
  if (!caption) {
    if (CONFIG.GEMINI_API_KEY) {
      logger('info', '📝 Hàng chưa có caption, đang tự động tạo caption TikTok với AI...');
      caption = await AI.generateCaption({
        productName: row['Tên Sản Phẩm'],
        contentVideo: row['Content Video'],
        productAnalysis: row['Phân Tích SP']
      });
    } else {
      caption = AI.createSmartFallbackCaption(row['Tên Sản Phẩm'], row['Content Video'], row['Phân Tích SP']);
    }
  }

  const productId = (row['ID Sản Phẩm'] || '').trim();
  // Ưu tiên cột "Tên Hiển Thị Sản Phẩm", fallback về "Tên Sản Phẩm", giới hạn chuẩn TikTok <= 30 ký tự
  const rawName = (row['Tên Hiển Thị Sản Phẩm'] || row['Tên Sản Phẩm'] || 'Mua ngay').trim();
  const productName = rawName.slice(0, 30) || 'Mua ngay';

  const stt = row.STT || row.rowNumber;
  let cartDetail = productId ? `${productName} [${productId}]` : 'Không có';

  // CHẾ ĐỘ MẶC ĐỊNH (manual): gửi video + caption qua Telegram để tự đăng tay bằng app TikTok thật,
  // KHÔNG gọi API đăng ngầm (tránh bị TikTok giảm phát tán do IP datacenter lệch vùng). Xem
  // CONFIG.TIKTOK_POST_MODE trong config.js để bật lại chế độ 'auto' (đăng thẳng như cũ) nếu cần.
  if (CONFIG.TIKTOK_POST_MODE !== 'auto') {
    try {
      await sendForManualTikTokPost({ videoPathOrUrl: videoUrl, caption, productId, productName, cartDetail, stt, logger });

      if (CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
        try {
          await Google.updateRowStatus(row.rowNumber, 'Thành Công', {
            'Trạng Thái upload': 'Chờ Đăng Tay',
            'Note': new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })
          });
          logger('success', `📝 Đã cập nhật [Trạng Thái upload]: "Chờ Đăng Tay" trên Google Sheet cho hàng #${row.rowNumber}.`);
        } catch (sheetErr) {
          logger('warning', `Lỗi cập nhật Google Sheet: ${sheetErr.message}`);
        }
      }

      logger('success', `✨ Đã gửi bài #${row.rowNumber} qua Telegram, chờ bạn đăng tay!`);
      return { success: true, manual: true };
    } catch (err) {
      logger('error', `❌ Gửi Telegram để đăng tay cho hàng #${row.rowNumber} thất bại: ${err.message}`);
      if (CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
        try {
          await Google.updateRowStatus(row.rowNumber, row['Trạng Thái'] || 'Thành Công', {
            'Trạng Thái upload': 'Chờ Đăng',
            'Note': `Lỗi gửi Telegram: ${err.message}`
          });
        } catch (e) {}
      }
      throw err;
    }
  }

  // Cập nhật Google Sheet sang "Đang Đăng"
  if (CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      await Google.updateRowStatus(row.rowNumber, row['Trạng Thái'] || 'Thành Công', {
        'Trạng Thái upload': 'Đang Đăng'
      });
    } catch (e) {}
  }

  try {
    // 1. Thực hiện đăng bài trực tiếp bằng TikTok Engine tích hợp
    const result = await uploadVideoToTikTok({
      videoPathOrUrl: videoUrl,
      caption,
      productId,
      productName,
      logger
    });

    const nowStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

    // 2. Cập nhật Google Sheet sang "Đã Đăng" (đồng bộ cột với n8n)
    if (CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
      try {
        await Google.updateRowStatus(row.rowNumber, 'Thành Công', {
          'Trạng Thái upload': 'Đã Đăng',
          'Note': nowStr,
          'Phân Tích SP': row['Phân Tích SP'] || ''
        });
        logger('success', `📝 Đã cập nhật [Trạng Thái upload]: "Đã Đăng" trên Google Sheet cho hàng #${row.rowNumber}.`);
      } catch (sheetErr) {
        logger('warning', `Lỗi cập nhật Google Sheet: ${sheetErr.message}`);
      }
    }

    // 3. Gửi thông báo Telegram (giống hệt node Tele của n8n)
    if (result.showcaseStatus) {
      if (result.showcaseStatus.inStock === false) {
        cartDetail += `\n⚠️ CẢNH BÁO: Sản phẩm HẾT HÀNG (tồn kho: 0), TikTok có thể ẩn giỏ vàng!`;
      } else if (result.showcaseStatus.newlyAdded) {
        cartDetail += ` (🎉 Tự động thêm vào sàn)`;
      } else if (result.showcaseStatus.inStock) {
        cartDetail += ` (Tồn kho: ${result.showcaseStatus.stockNum || 'Còn'})`;
      }
    }
    await sendTelegram(`🟢 TIKTOKsongkhoecungthaomoc: Đăng thành công bài ${stt} (${productName})\n👉 Giỏ hàng: ${cartDetail}\n\n📝 ${caption}`);

    logger('success', `✨ Hoàn tất 100% đăng TikTok cho hàng #${row.rowNumber}!`);
    return { success: true, result };

  } catch (err) {
    logger('error', `❌ Đăng TikTok hàng #${row.rowNumber} thất bại: ${err.message}`);

    if (CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
      try {
        await Google.updateRowStatus(row.rowNumber, row['Trạng Thái'] || 'Thành Công', {
          'Trạng Thái upload': 'Chờ Đăng',
          'Note': `Lỗi TikTok: ${err.message}`
        });
      } catch (e) {}
    }

    throw err;
  }
}

/**
 * Xử lý hoàn chỉnh 1 hàng sản phẩm từ Google Sheets
 */
export async function processRow(row, logger = (level, msg) => console.log(`[${level}] ${msg}`)) {
  logger('info', `📌 Bắt đầu xử lý hàng #${row.rowNumber}: "${row['Tên Sản Phẩm']}"`);
  
  if (CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      await Google.updateRowStatus(row.rowNumber, 'Queue');
    } catch (e) {
      logger('warning', `Không cập nhật được trạng thái Sheet: ${e.message}`);
    }
  }

  const workDir = path.resolve(`temp/run_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    let pAnalysis = row['Phân Tích SP'] || 'Sản phẩm chất lượng cao';
    let maAnalysis = '';
    let bgAnalysis = '';
    let imgSP, imgMA, imgBG;

    // Tải và chuẩn bị ảnh nếu có link
    if (row['Link Sản Phẩm'] || row['Link Mẫu Ảnh'] || row['Link Background']) {
      logger('info', '⬇️ Đang tải ảnh nguyên liệu đầu vào (Sản phẩm, Mẫu ảnh, Background)...');
      try {
        const [rawSP, rawMA, rawBG] = await Promise.all([
          row['Link Sản Phẩm'] ? Google.downloadFileAsBase64(row['Link Sản Phẩm']).catch(() => null) : null,
          row['Link Mẫu Ảnh'] ? Google.downloadFileAsBase64(row['Link Mẫu Ảnh']).catch(() => null) : null,
          row['Link Background'] ? Google.downloadFileAsBase64(row['Link Background']).catch(() => null) : null
        ]);

        if (rawSP) imgSP = await resizeImage1080x1920(rawSP);
        if (rawMA) imgMA = await resizeImage1080x1920(rawMA);
        if (rawBG) imgBG = await resizeImage1080x1920(rawBG);

        if (CONFIG.GEMINI_API_KEY) {
          if (imgMA) {
            logger('info', '🤖 Gemini Vision đang phân tích nhân vật Mẫu ảnh...');
            maAnalysis = await AI.analyzeModel(imgMA).catch(() => '');
          }
          if (imgBG) {
            logger('info', '🤖 Gemini Vision đang phân tích không gian Background...');
            bgAnalysis = await AI.analyzeBackground(imgBG).catch(() => '');
          }
          if (imgSP && (!row['Phân Tích SP'] || row['Phân Tích SP'].length < 20)) {
            logger('info', '🤖 Gemini Vision đang phân tích sản phẩm...');
            pAnalysis = await AI.analyzeProduct(imgSP, row['Tên Sản Phẩm']).catch(() => pAnalysis);
          }
        }
      } catch (err) {
        logger('warning', `Lỗi tải ảnh: ${err.message}. Tiếp tục với thông tin văn bản.`);
      }
    }

    let finalOutPath = path.join(workDir, 'final_video.mp4');

    if (CONFIG.ENGINE === 'vids') {
      logger('info', '🎬 Đang kết nối Google Vids (0 Credit, gói Ultra)...');
      // Mỗi cảnh Google Vids thực tế chỉ sinh ra ~5s (dù cài đặt độ dài hiển thị 10s), nên mặc định
      // 3 cảnh nối tiếp (~15s) để đạt độ dài video review tiêu chuẩn 12-20s thay vì 2 cảnh (~8-10s).
      const numVideos = parseInt(row['Số Video'] || '3', 10);
      
      // Lưu file ảnh chuẩn bị cho Google Vids:
      // - MẪU ẢNH (imgMA) -> Nạp chuẩn xác vào ô "Hình đại diện" (Avatar) để AI nhận diện đúng mặt người mẫu
      // - SẢN PHẨM (imgSP) -> Nạp chuẩn xác vào ô "Thành phần" (Components) để người mẫu cầm đúng sản phẩm
      // - BACKGROUND (imgBG) -> Nạp bổ sung vào ô "Thành phần"
      let pMA = null;
      let pSP = null;
      let pBG = null;
      const imageFiles = [];

      if (imgMA) {
        pMA = path.join(workDir, 'input_mau_anh.jpg');
        fs.writeFileSync(pMA, imgMA);
        imageFiles.push(pMA);
      }
      if (imgSP) {
        pSP = path.join(workDir, 'input_san_pham.jpg');
        fs.writeFileSync(pSP, imgSP);
        imageFiles.push(pSP);
      }
      if (imgBG) {
        pBG = path.join(workDir, 'input_background.jpg');
        fs.writeFileSync(pBG, imgBG);
        imageFiles.push(pBG);
      }

      const hasRefImages = imageFiles.length > 0;
      let vidsPrompts = [];
      try {
        logger('info', `✨ Gemini AI đang thiết lập ${numVideos} phân cảnh (Mẫu ảnh -> Avatar, Sản phẩm -> Thành phần)...`);
        if ((row['Kịch Bản'] || '').trim()) {
          logger('info', `📜 Áp dụng Kịch Bản từ Sheet: "${row['Kịch Bản'].trim().slice(0, 80)}..."`);
        }
        vidsPrompts = await AI.generateVidsPrompts(numVideos, row['Tên Sản Phẩm'], row['Content Video'], pAnalysis, maAnalysis, bgAnalysis, hasRefImages, row['Kịch Bản']);
      } catch (e) {
        logger('warning', `Lỗi AI thiết lập kịch bản: ${e.message}. Sử dụng kịch bản tiếng Việt chuẩn.`);
        vidsPrompts = await AI.generateVidsPrompts(numVideos, row['Tên Sản Phẩm'], row['Content Video'], null, null, null, hasRefImages, row['Kịch Bản']);
      }

      logger('info', `🎥 Đang tạo ${vidsPrompts.length} cảnh nối tiếp liền mạch (cảnh 1 dùng ảnh Avatar/Thành phần, các cảnh sau dùng "Kéo dài" để giữ đúng nhân vật & sản phẩm)...`);
      const clipDir = path.join(workDir, 'clip_final');
      const clipFile = await createVideoInGoogleVids({
        prompts: vidsPrompts,
        avatarPath: pMA,
        productPath: pSP,
        backgroundPath: pBG,
        imagePaths: imageFiles,
        outputDir: clipDir,
        logger: (level, msg) => logger(level, msg)
      });

      const logoFile = await resolveLogoPath(row.Logo, logger);
      if (logoFile) {
        logger('info', `🏷️ Gắn logo thương hiệu kênh: ${path.basename(logoFile)} (góc dưới phải)...`);
      }
      logger('info', `🎞️ FFmpeg đang xử lý tăng tốc video & gắn logo...`);
      await mergeVideosWithFfmpeg([clipFile], logoFile, finalOutPath);
    } else {
      // Flow / Veo cũ
      logger('info', '🎬 Đang tạo video qua Veo Flow...');
      const acc = await Google.getAccountCookie();
      const accessToken = await NanoAI.getGoogleLabsSession(acc.cookie);
      const projectId = acc.projectId || CONFIG.FLOW_PROJECT_ID;

      const numVideos = parseInt(row['Số Video'] || '2', 10);
      const videoPrompts = await AI.generateVideoPrompts(numVideos, row['Tên Sản Phẩm'], row['Content Video'], pAnalysis);

      const videoUrls = await NanoAI.generateVideosVeo(acc.nanoai, accessToken, projectId, videoPrompts, 'start_media');
      const clipPaths = [];
      for (let i = 0; i < videoUrls.length; i++) {
        const cPath = path.join(workDir, `clip_${i + 1}.mp4`);
        const vRes = await axios.get(videoUrls[i], { responseType: 'arraybuffer', headers: { cookie: acc.cookie } });
        fs.writeFileSync(cPath, Buffer.from(vRes.data));
        clipPaths.push(cPath);
      }
      const logoFile = await resolveLogoPath(row.Logo, logger);
      await mergeVideosWithFfmpeg(clipPaths, logoFile, finalOutPath);
    }

    // 1. Kiểm tra tính hợp lệ của video thành phẩm trước khi tải lên Google Drive
    if (!fs.existsSync(finalOutPath) || fs.statSync(finalOutPath).size < 10000) {
      throw new Error(`File video thành phẩm không hợp lệ hoặc rỗng (${fs.existsSync(finalOutPath) ? fs.statSync(finalOutPath).size : 0} bytes)`);
    }

    const cleanTitle = (row['Tên Sản Phẩm'] || 'final').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ');
    const driveFileName = `${Date.now()}_${cleanTitle}.mp4`;

    logger('info', `☁️ Tải video thành phẩm lên Google Drive: ${driveFileName}...`);
    const driveFileId = await Google.uploadVideoToDrive(finalOutPath, driveFileName);
    const finalVideoUrl = `https://drive.google.com/file/d/${driveFileId}`;
    logger('success', `Đã lưu Drive: ${finalVideoUrl}`);

    // Xóa file video tạm sau khi đã tải lên Drive thành công
    try {
      if (fs.existsSync(finalOutPath)) fs.unlinkSync(finalOutPath);
    } catch (cleanErr) {}

    // Tạo caption TikTok (ưu tiên caption người dùng đã nhập, nếu chưa có thì dùng AI sinh đầy đủ nội dung + hashtag)
    let caption = (row['Caption Sản Phẩm'] || '').trim();
    if (!caption) {
      logger('info', '📝 Đang dùng Gemini AI tạo Caption TikTok cuốn hút cho sản phẩm...');
      caption = await AI.generateCaption({
        productName: row['Tên Sản Phẩm'],
        contentVideo: row['Content Video'],
        productAnalysis: pAnalysis
      });
      logger('success', `✨ Caption TikTok mới: "${caption.slice(0, 80)}..."`);
    } else {
      logger('info', `📝 Giữ nguyên Caption có sẵn từ Google Sheet: "${caption.slice(0, 80)}..."`);
    }

    // Cập nhật Google Sheet
    if (CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
      try {
        logger('info', '📝 Cập nhật trạng thái "Thành Công" & "Chờ Đăng" lên Google Sheet...');
        await Google.updateRowStatus(row.rowNumber, 'Thành Công', {
          'Link Video': finalVideoUrl,
          'Time': new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }),
          'Phân Tích SP': pAnalysis,
          'Caption Sản Phẩm': caption,
          'Trạng Thái upload': 'Chờ Đăng'
        });
      } catch (err) {
        logger('warning', `Cập nhật Sheet thất bại: ${err.message}`);
      }
    }

    // Tự động đăng TikTok nếu bật chế độ tự động và đã cấu hình Session
    if (CONFIG.TIKTOK_AUTO_PUBLISH && isTikTokConfigured()) {
      try {
        logger('info', '📱 Tự động đăng video vừa tạo lên TikTok qua TikTok Engine...');
        const updatedRow = {
          ...row,
          'Link Video': finalVideoUrl,
          'Caption Sản Phẩm': caption,
          'Phân Tích SP': pAnalysis
        };
        await triggerTikTokUpload(updatedRow, logger);
      } catch (autoErr) {
        logger('warning', `⚠️ Tự động đăng TikTok gặp lỗi: ${autoErr.message}. Hàng giữ trạng thái "Chờ Đăng".`);
      }
    }

    // Gửi thông báo Telegram
    await sendTelegram(`🟢 Review Sản Phẩm: Tạo Thành Công Video hàng ${row.rowNumber} (${row['Tên Sản Phẩm']})\n👉 Link: ${finalVideoUrl}\n\n📝 Caption: ${caption}`);

    logger('success', `✅ Hoàn thành 100% video hàng #${row.rowNumber}!`);
    return { success: true, videoUrl: finalVideoUrl, caption };

  } catch (err) {
    logger('error', `❌ Lỗi xử lý hàng #${row.rowNumber}: ${err.message}`);
    if (CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
      await Google.updateRowStatus(row.rowNumber, 'Lỗi', { Note: err.message }).catch(() => {});
    }
    throw err;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * CHẾ ĐỘ 1: Chỉ chạy đăng TikTok cho các video đã sẵn sàng ("Chờ Đăng")
 */
export async function runTikTokWorker(logger = (level, msg) => console.log(`[${level}] ${msg}`)) {
  logger('info', '📱 [TikTok Worker] Bắt đầu quét các video "Chờ Đăng" trên Google Sheet...');

  if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
    logger('warning', 'Chưa có cấu hình Google Service Account, không thể quét Sheet.');
    return null;
  }

  if (CONFIG.TIKTOK_POST_MODE === 'auto' && !isTikTokConfigured()) {
    logger('error', '❌ Chưa cấu hình TIKTOK_SESSION_JSON hợp lệ.');
    return null;
  }

  // Không truyền limit — quét toàn bộ sheet (1 lần gọi API duy nhất, không tốn thêm chi phí) để
  // không bao giờ bỏ sót video "Chờ Đăng" cũ hơn N hàng gần nhất.
  const tiktokQueue = await Google.fetchTikTokQueueRows();
  const pendingList = tiktokQueue
    .filter(r => (r['Trạng Thái upload'] || '').trim() === 'Chờ Đăng' && (r['Link Video'] || '').trim())
    .sort((a, b) => (a.rowNumber || 0) - (b.rowNumber || 0)); // Đăng theo thứ tự từ trên xuống dưới

  if (pendingList.length === 0) {
    logger('info', 'ℹ️ Không có video nào đang ở trạng thái "Chờ Đăng" có Link Video hợp lệ.');
    return null;
  }

  const targetRow = pendingList[0];
  logger('info', `🎯 Tìm thấy ${pendingList.length} video chờ đăng. Tiến hành đăng hàng #${targetRow.rowNumber} ("${targetRow['Tên Sản Phẩm']}")`);
  return await triggerTikTokUpload(targetRow, logger);
}

/**
 * CHẾ ĐỘ 2: Chỉ chạy tạo video (Lưu vào Google Drive, gán trạng thái "Chờ Đăng", KHÔNG đăng TikTok)
 */
export async function runGenerateWorker(logger = (level, msg) => console.log(`[${level}] ${msg}`)) {
  logger('info', '🎬 [Video Generator] Bắt đầu quét hàng đợi "Chờ Tạo" từ Google Sheets...');

  if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
    logger('warning', 'Chưa có cấu hình Google Service Account, không thể quét Sheet.');
    return null;
  }

  const row = await Google.fetchQueueRow();
  if (!row) {
    logger('info', 'ℹ️ Không có hàng nào ở trạng thái "Chờ Tạo".');
    return null;
  }

  // Tạm tắt auto publish TikTok trong quá trình tạo video để đảm bảo chỉ tạo và lưu Drive
  const origAutoPublish = CONFIG.TIKTOK_AUTO_PUBLISH;
  CONFIG.TIKTOK_AUTO_PUBLISH = false;
  try {
    return await processRow(row, logger);
  } finally {
    CONFIG.TIKTOK_AUTO_PUBLISH = origAutoPublish;
  }
}

/**
 * Quét và chạy hàng đợi tổng hợp
 */
export async function runWorker(logger = (level, msg) => console.log(`[${level}] ${msg}`)) {
  logger('info', '🚀 Bắt đầu quét hàng đợi từ Google Sheets...');
  
  if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
    logger('warning', 'Chưa có cấu hình Google Service Account, không thể quét Sheet.');
    return null;
  }

  // 1. Quét xem có video nào đang ở trạng thái "Chờ Đăng" TikTok không
  if (CONFIG.TIKTOK_AUTO_PUBLISH && isTikTokConfigured()) {
    const posted = await runTikTokWorker(logger);
    if (posted) return posted;
  }

  // 2. Quét hàng đợi tạo video mới
  const row = await Google.fetchQueueRow();
  if (!row) {
    logger('info', 'ℹ️ Không có hàng nào ở trạng thái "Chờ Đăng" hoặc "Chờ Tạo".');
    return null;
  }

  return await processRow(row, logger);
}

// Nếu chạy trực tiếp từ CLI
const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectRun) {
  const arg = process.argv[2] || '';
  // process.exit() sau khi xong việc — nếu không, 1 handle đang mở đâu đó (axios keep-alive, client
  // googleapis, v.v.) có thể giữ Node sống tới khi GitHub Actions timeout 15 phút rồi mới bị huỷ,
  // dù việc đăng/tạo video thực tế đã xong từ lâu (đã xác nhận qua lần chạy thật trên CI).
  const exitOnSettle = (p) => p.then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
  if (arg === '--post-tiktok' || arg === 'post') {
    exitOnSettle(runTikTokWorker());
  } else if (arg === '--generate' || arg === 'generate') {
    exitOnSettle(runGenerateWorker());
  } else {
    exitOnSettle(runWorker());
  }
}

