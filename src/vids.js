import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';

import axios from 'axios';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA_DIR = path.resolve('chrome_profile');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Khởi tạo trình duyệt: ưu tiên kết nối vào Chrome Profile 23 đang mở cổng 9224
 */
export async function getVidsBrowser(headless = false) {
  // 1. Kiểm tra xem có Chrome Profile 23 đang mở ở port 9224 không
  try {
    const res = await axios.get('http://127.0.0.1:9224/json/version', { timeout: 1500 });
    if (res.status === 200) {
      console.log('🔗 Đã phát hiện Chrome Profile 23 (Port 9224). Đang kết nối trực tiếp...');
      const browser = await puppeteer.connect({
        browserURL: 'http://127.0.0.1:9224',
        defaultViewport: null
      });
      browser.__isRemote = true;
      return browser;
    }
  } catch (e) {
    // Port 9224 chưa mở, fallback sang launch profile độc lập
  }

  // Dọn dẹp tiến trình Chrome cũ nếu bị kẹt để không bao giờ bị lỗi 'browser is already running'
  try {
    const killScript = path.resolve('scripts/kill_chrome.ps1');
    const { execSync } = await import('child_process');
    execSync(`powershell -ExecutionPolicy Bypass -File "${killScript}"`, { stdio: 'ignore' });
  } catch (e) {}

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: USER_DATA_DIR,
    headless: headless ? 'new' : false,
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });
  browser.__isRemote = false;
  return browser;
}

/**
 * Tự động tạo video trên Google Vids từ hình ảnh & kịch bản
 * @param {Object} options
 * @param {string} options.prompt - Kịch bản / câu lệnh tạo video
 * @param {Array<string>} options.imagePaths - Danh sách đường dẫn ảnh nguyên liệu (nếu có)
 * @param {string} options.outputDir - Thư mục lưu video tải về
 * @returns {Promise<string>} Đường dẫn file video MP4 đã tải về
 */
export async function createVideoInGoogleVids({ prompt, imagePaths = [], avatarPath = null, productPath = null, backgroundPath = null, outputDir, logger = null }) {
  fs.mkdirSync(outputDir, { recursive: true });

  const log = (level, msg) => {
    if (level === 'error') console.error(msg);
    else if (level === 'warning') console.warn(msg);
    else console.log(msg);

    if (logger && typeof logger === 'function') {
      try { logger(level, msg); } catch (e) {}
    }
  };

  log('info', '🚀 Đang mở Google Vids để tự động tạo video...');
  const browser = await getVidsBrowser(false);
  const page = await browser.newPage();

  // Đóng các tab rỗng hoặc tab Docs cũ để tránh xung đột quota đồng thời
  try {
    const allPages = await browser.pages();
    for (let p of allPages) {
      if (p !== page && allPages.length > 1) {
        const u = p.url();
        if (u.includes('docs.google.com') || u.includes('vids.new') || u === 'about:blank') {
          await p.close().catch(() => {});
        }
      }
    }
  } catch (e) {}

  // Cấu hình thư mục tải xuống tự động
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: path.resolve(outputDir)
  });

  try {
    // 1. Mở trang tạo video mới
    await page.goto('https://vids.new', { waitUntil: 'networkidle2', timeout: 60000 });

    // Kiểm tra xem có đang ở trang đăng nhập Google không
    if (page.url().includes('accounts.google.com')) {
      log('warning', '⚠️ Trình duyệt đang ở trang đăng nhập Google.');
      log('info', '👉 Vui lòng đăng nhập tài khoản Ultra trên cửa sổ Chrome...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 300000 });
    }

    log('info', `📄 Đã vào trang Google Vids editor: ${page.url()}`);
    await sleep(3000);

    // Đóng bất kỳ modal / popup còn sót lại (như "Huỷ tạo hình đại diện?", "Chọn hình đại diện")
    await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const closeBtn = allBtns.find(b => {
        const t = (b.innerText || '').trim();
        const aria = (b.getAttribute('aria-label') || '').trim();
        return t === 'Huỷ' || t === 'Đóng' || aria === 'Đóng' || aria === 'Huỷ';
      });
      if (closeBtn) closeBtn.click();
    });
    await page.keyboard.press('Escape');
    await sleep(800);

    // 2. Chọn định dạng video dọc (Dọc 9:16)
    log('info', '📱 Chọn định dạng video dọc (9:16)...');
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText && b.innerText.includes('Dọc'));
      if (btn) btn.click();
    });
    await sleep(1000);

    // 3. Mở tính năng "Tạo video AI"
    log('info', '🤖 Bấm chọn "Tạo video AI"...');
    await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const aiCard = cards.find(c => c.innerText && c.innerText.includes('Tạo video AI'));
      if (aiCard) aiCard.click();
    });
    await sleep(2500);

    // 4. Nạp tất cả ảnh nguyên liệu (Mẫu ảnh, Sản phẩm, Background) vào Thành phần của Video AI:
    const slots = [];
    if (avatarPath && fs.existsSync(avatarPath)) {
      slots.push({ path: path.resolve(avatarPath), name: 'Mẫu ảnh (Chân dung)' });
    }
    if (productPath && fs.existsSync(productPath)) {
      slots.push({ path: path.resolve(productPath), name: 'Sản phẩm' });
    }
    if (backgroundPath && fs.existsSync(backgroundPath)) {
      slots.push({ path: path.resolve(backgroundPath), name: 'Background' });
    }

    if (slots.length === 0 && imagePaths && imagePaths.length > 0) {
      const validImages = imagePaths.filter(img => img && fs.existsSync(img));
      validImages.forEach((img, idx) => {
        slots.push({
          path: path.resolve(img),
          name: idx === 0 ? 'Mẫu ảnh' : (idx === 1 ? 'Sản phẩm' : `Nguyên liệu #${idx + 1}`)
        });
      });
    }

    if (slots.length > 0) {
      log('info', `🖼️ Đang nạp ${slots.length} ảnh nguyên liệu vào Google Vids: ${slots.map(s => s.name).join(' + ')}...`);

      // 1. Thử nạp đồng thời toàn bộ ảnh vào input[type="file"] có sẵn trên trang
      let allBatchUploaded = false;
      try {
        const fileInputs = await page.$$('input[type="file"]');
        if (fileInputs.length > 0) {
          const targetInput = fileInputs[fileInputs.length - 1];
          const allPaths = slots.map(s => s.path);
          await targetInput.uploadFile(...allPaths);
          await page.evaluate(el => {
            if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
          }, targetInput);
          log('info', `✅ Đã nạp ${allPaths.length} ảnh nguyên liệu vào Google Vids!`);
          await sleep(3500);
          allBatchUploaded = true;
        }
      } catch (eBatch) {}

      // 2. Nếu nạp đồng loạt chưa được, nạp từng file và xử lý modal Mở tệp nếu xuất hiện
      if (!allBatchUploaded) {
        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          log('info', `📸 Đang tải [${slot.name}]: ${path.basename(slot.path)}...`);

          let uploaded = false;

          // Thử nạp qua thẻ input file
          try {
            const fileInputs = await page.$$('input[type="file"]');
            if (fileInputs.length > 0) {
              const targetInput = fileInputs[fileInputs.length - 1];
              await page.evaluate(el => { if (el) el.value = ''; }, targetInput);
              await targetInput.uploadFile(slot.path);
              await page.evaluate(el => {
                if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
              }, targetInput);
              log('info', `✅ Đã nạp thành công [${slot.name}] vào nguyên liệu AI!`);
              await sleep(3000);
              uploaded = true;
            }
          } catch (e1) {}

          // Nếu chưa được, bấm nút "+ Thêm"
          if (!uploaded) {
            try {
              const addBtnHandle = await page.evaluateHandle(() => {
                const scope = document.querySelector('.videoGenCreationView, [role="dialog"], .collapsiblePromptBox') || document.body;
                const buttons = Array.from(scope.querySelectorAll('button, div[role="button"]'));
                return buttons.find(e => {
                  const aria = (e.getAttribute('aria-label') || '').toLowerCase();
                  const txt = (e.innerText || '').toLowerCase();
                  return aria.includes('thêm') || txt.includes('thêm') || aria.includes('thành phần') || txt.includes('thành phần');
                }) || null;
              });

              const addBtn = addBtnHandle.asElement();
              if (addBtn) {
                await page.evaluate(el => { if (el) el.click(); }, addBtn);
                await sleep(1500);

                // Nếu xuất hiện modal "Mở tệp" của Google Picker: bấm vào tab "Tải lên" / "Máy tính"
                await page.evaluate(() => {
                  const allElements = Array.from(document.querySelectorAll('div, span, button, [role="tab"]'));
                  const uploadTab = allElements.find(e => {
                    const t = (e.innerText || '').trim();
                    return t === 'Tải lên' || t === 'Máy tính' || t === 'Upload';
                  });
                  if (uploadTab) uploadTab.click();
                });
                await sleep(1200);

                // Tìm input file bên trong modal Mở tệp để tải file
                const pickerInputs = await page.$$('input[type="file"]');
                if (pickerInputs.length > 0) {
                  const pInput = pickerInputs[pickerInputs.length - 1];
                  await pInput.uploadFile(slot.path);
                  log('info', `✅ Đã nạp thành công [${slot.name}] qua hộp thoại Mở tệp!`);
                  await sleep(3500);
                  uploaded = true;
                }
              }
            } catch (e2) {}
          }

          if (!uploaded) {
            log('warning', `⚠️ Chưa thể nạp file [${slot.name}], tiếp tục với các nguyên liệu khác.`);
          }
        }
      }

      // ĐẢM BẢO ĐÓNG HOÀN TOÀN MỌI MODAL / HỘP THOẠI "MỞ TỆP" TRƯỚC KHI NHẬP PROMPT
      await page.evaluate(() => {
        const closeBtns = Array.from(document.querySelectorAll('button[aria-label="Đóng"], button[aria-label="Close"], .picker-dialog-close, [aria-label="Huỷ"]'));
        closeBtns.forEach(b => { try { b.click(); } catch (e) {} });
      });
      await page.keyboard.press('Escape');
      await sleep(1000);
    }

    // 5. Đảm bảo đóng mọi dialog che màn hình, tìm ô nhập prompt kịch bản và gõ nội dung
    await page.keyboard.press('Escape');
    await sleep(500);

    log('info', `📝 Đang nhập kịch bản: "${prompt.substring(0, 60)}..."`);
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const target = all.find(el => (el.innerText || '').includes('Mô tả video của bạn') || el.getAttribute('role') === 'textbox');
      if (target) {
        const input = target.querySelector('textarea, [contenteditable="true"]') || target;
        input.focus();
        input.click();
      }
    });

    // Nhập prompt vào ô
    await page.keyboard.type(prompt, { delay: 10 });
    await sleep(1500);

    // 6. Bấm nút Tạo video AI (nút mũi tên tròn xanh .collapsiblePromptBoxGenerateButton)
    log('info', '🎬 Bấm nút Tạo video AI...');
    // Đảm bảo không còn modal nào che chắn trước khi click nút Tạo
    await page.evaluate(() => {
      const closeBtns = Array.from(document.querySelectorAll('button[aria-label="Đóng"], button[aria-label="Close"], .picker-dialog-close'));
      closeBtns.forEach(b => { try { b.click(); } catch (e) {} });
    });
    await page.keyboard.press('Escape');
    await sleep(600);

    const submitBtnHandle = await page.evaluateHandle(() => {
      return document.querySelector('button.collapsiblePromptBoxGenerateButton, button[aria-label="Tạo"].collapsiblePromptBoxGenerateButton, button[aria-label="Tạo"], button[aria-label="Generate"]');
    });
    const submitEl = submitBtnHandle.asElement();
    if (submitEl) {
      await page.evaluate(el => {
        if (el) {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          el.click();
        }
      }, submitEl);
    }
    await page.keyboard.press('Enter');
    await sleep(2000);

    // Kiểm tra xem đã bắt đầu sinh video chưa, nếu chưa bấm lại
    for (let c = 0; c < 3; c++) {
      const isRunning = await page.evaluate(() => {
        const t = document.body.innerText || '';
        return t.includes('Đang tạo') || t.includes('Generating') || !!t.match(/(\d+)%/);
      });
      if (isRunning) break;
      if (submitEl) {
        await page.evaluate(el => el && el.click(), submitEl);
      }
      await page.keyboard.press('Enter');
      await sleep(2000);
    }

    log('info', '⏳ Đang chờ Google Vids sinh video (Omni 720p 9:16)...');

    // 6. Chờ quá trình sinh video hoàn tất (tăng lên 360s = 6 phút để đủ thời gian render đa ảnh)
    let videoSrc = null;
    let consecutiveErrors = 0;
    for (let i = 0; i < 90; i++) {
      await sleep(4000);
      let status = null;
      try {
        status = await page.evaluate(() => {
          const text = document.body.innerText || '';
          const match = text.match(/(\d+)%/);
          const percent = match ? match[0] : null;

          // Chỉ kiểm tra các thông báo lỗi ĐANG THỰC SỰ HIỂN THỊ TRÊN MÀN HÌNH (loại trừ các thẻ ẩn display: none)
          const isVisible = (el) => {
            if (!el) return false;
            if (el.closest('.templates-view-container-hidden, .insertabletemplates-gallery-load-failure-container, [style*="display: none"]')) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };

          const toastEls = Array.from(document.querySelectorAll('.docs-toast, .jfk-butterBar, [role="alert"]')).filter(isVisible);
          const toastTexts = toastEls.map(el => (el.innerText || '').trim()).filter(Boolean);

          const visibleError = toastTexts.find(t => 
            !t.includes('tải lại trang') && (
              t.includes('chính sách') ||
              t.includes('không thể tạo') ||
              t.includes('sự cố khi tạo') ||
              t.includes('vi phạm')
            )
          );

          const hasError = !!visibleError;
          const errorMsg = visibleError || null;

          // Kiểm tra xem đã hoàn thành chưa (xuất hiện nút Chèn, Insert, Tạo lại, Regenerate)
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
          const hasChen = buttons.some(b => {
            const t = (b.innerText || '').trim();
            return t.includes('Chèn') || t.includes('Insert');
          });
          const hasTaoLai = buttons.some(b => {
            const t = (b.innerText || '').trim();
            return t.includes('Tạo lại') || t.includes('Regenerate');
          });

          // QUAN TRỌNG: Chỉ tìm video AI khi nút Chèn hoặc Tạo lại đã thực sự xuất hiện!
          let foundSrc = null;
          if (hasChen || hasTaoLai) {
            const vids = Array.from(document.querySelectorAll('video')).filter(isVisible);
            const genVideo = vids.find(v => {
              const s = v.currentSrc || v.src || (v.querySelector('source') ? v.querySelector('source').src : '') || '';
              if (s.includes('video_gen_cartoon_avatar_promo')) return false;
              return s.length > 5;
            });
            if (genVideo) {
              foundSrc = genVideo.currentSrc || genVideo.src || (genVideo.querySelector('source') ? genVideo.querySelector('source').src : null);
            }
          }

          return {
            src: foundSrc,
            percent,
            hasError,
            errorMsg,
            hasChen: hasChen || hasTaoLai,
            hasTaoLai,
            videoCount: (hasChen || hasTaoLai) ? 1 : 0
          };
        });
        consecutiveErrors = 0;
      } catch (evalErr) {
        // Frame detachment hoặc Docs URL transition - an toàn bỏ qua và chờ lượt poll tiếp theo
        consecutiveErrors++;
        log('info', `⏳ Đang đồng bộ giao diện Google Vids (${(i + 1) * 4}s)...`);
        if (consecutiveErrors > 15) {
          throw new Error('Mất kết nối với trang Google Vids: ' + evalErr.message);
        }
        continue;
      }

      if (status.percent) {
        log('info', `⏱️ Tiến độ Google Vids: ${status.percent} (${(i + 1) * 4}s)`);
      } else if (i % 3 === 0 && !status.src) {
        log('info', `⏳ Đang xử lý tạo video AI... (${(i + 1) * 4}s)`);
      }

      if (status.hasError) {
        throw new Error(status.errorMsg || 'Google Vids thông báo lỗi tạo video hoặc vi phạm chính sách nội dung.');
      }

      // CHỈ KẾT THÚC KHI ĐÃ CÓ NÚT CHÈN/TẠO LẠI VÀ THỜI GIAN TỐI THIỂU 15 GIÂY!
      if ((status.hasChen || status.hasTaoLai) && status.src && i >= 4) {
        videoSrc = status.src;
        log('info', '🎉 Google Vids đã hoàn thành video!');
        break;
      }

      // Trường hợp video đã xong (có nút Chèn/Tạo lại) nhưng src đang tải
      if (status.hasChen && i >= 4) {
        await sleep(3000);
        const retrySrc = await page.evaluate(() => {
          const vids = Array.from(document.querySelectorAll('video'));
          const v = vids.find(x => !x.src?.includes('promo') && !x.currentSrc?.includes('promo'));
          return v ? (v.currentSrc || v.src || (v.querySelector('source') ? v.querySelector('source').src : null)) : null;
        }).catch(() => null);
        if (retrySrc) {
          videoSrc = retrySrc;
          log('info', '🎉 Google Vids đã hoàn thành video!');
          break;
        }
      }
    }

    if (!videoSrc) {
      try {
        const debugPath = path.resolve('temp/vids_timeout_debug.png');
        fs.mkdirSync(path.dirname(debugPath), { recursive: true });
        await page.screenshot({ path: debugPath, fullPage: true });
        log('warning', `📸 Đã lưu ảnh chụp màn hình debug tại: ${debugPath}`);
      } catch (ssErr) {}
      throw new Error('Hết thời gian chờ Google Vids tạo video (quá 6 phút).');
    }

    // 7. Tải video MP4 về máy tính
    log('info', '💾 Đang tải video MP4 về máy tính...');
    let downloadedFile = null;

    // Cách 1: Nếu là blob URL, trích xuất trực tiếp buffer từ trình duyệt bằng fetch
    if (videoSrc && videoSrc.startsWith('blob:')) {
      try {
        log('info', '📥 Đang trích xuất dữ liệu video MP4 từ trình duyệt (blob stream)...');
        const base64Data = await page.evaluate(async (url) => {
          const resp = await fetch(url);
          const blob = await resp.blob();
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        }, videoSrc);

        if (base64Data && base64Data.includes(',')) {
          const buffer = Buffer.from(base64Data.split(',')[1], 'base64');
          if (buffer.length > 50000) {
            const filename = `vids_${Date.now()}.mp4`;
            downloadedFile = path.join(outputDir, filename);
            fs.writeFileSync(downloadedFile, buffer);
            log('info', `🎉 Đã lưu video thành công: ${downloadedFile} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
          }
        }
      } catch (blobErr) {
        log('warning', `Trích xuất blob thất bại: ${blobErr.message}, tiếp tục thử phương thức tải xuống khác...`);
      }
    }

    // Cách 2: Bấm nút Chèn (Insert) vào timeline, sau đó tải qua CDP
    if (!downloadedFile) {
      try {
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
          const chenBtn = buttons.find(b => {
            const t = (b.innerText || '').trim();
            return t === 'Chèn' || t === 'Insert' || t.includes('Chèn video');
          });
          if (chenBtn) chenBtn.click();
        });
        await sleep(3000);
      } catch (e) {}

      try {
        const bClient = await browser.target().createCDPSession();
        await bClient.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: path.resolve(outputDir),
          eventsEnabled: true
        });
      } catch (e) {}

      await page.evaluate((url) => {
        const a = document.createElement('a');
        a.href = url;
        a.download = `video_${Date.now()}.mp4`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 1000);
      }, videoSrc);

      for (let j = 0; j < 30; j++) {
        await sleep(2000);
        const files = fs.readdirSync(outputDir);
        const mp4Files = files.filter(f => f.endsWith('.mp4') && !f.endsWith('.crdownload'));
        if (mp4Files.length > 0) {
          downloadedFile = path.join(outputDir, mp4Files[mp4Files.length - 1]);
          log('info', `🎉 Đã tải video thành công: ${downloadedFile} (${(fs.statSync(downloadedFile).size / 1024 / 1024).toFixed(2)} MB)`);
          break;
        }
      }
    }

    if (!downloadedFile) {
      throw new Error('Hết thời gian chờ tải file MP4 từ Google Vids.');
    }

    // 8. Chèn vào timeline và lưu dự án trên Google Vids
    try {
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        const chenBtn = buttons.find(b => b.innerText && b.innerText.trim().includes('Chèn'));
        if (chenBtn) chenBtn.click();
      });
      await sleep(2000);
    } catch (e) {}

    return downloadedFile;

  } finally {
    if (browser.__isRemote) {
      try { await page.close(); } catch (e) {}
    } else {
      try {
        await page.close().catch(() => {});
        await Promise.race([
          browser.close(),
          sleep(4000)
        ]);
      } catch (e) {}
    }
  }
}
