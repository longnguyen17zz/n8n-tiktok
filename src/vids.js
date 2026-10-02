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

  // 1. Đón bắt mọi URL video AI qua mạng (loại trừ tuyệt đối video tĩnh/hướng dẫn gstatic/dialog)
  const capturedNetworkVideos = [];
  page.on('response', async (response) => {
    try {
      const url = response.url();
      const isStaticOrPromo = url.includes('gstatic.com') ||
                              url.includes('gettingstarted') ||
                              url.includes('entry_point') ||
                              url.includes('promo') ||
                              url.includes('tutorial') ||
                              url.includes('sample') ||
                              url.includes('slides_') ||
                              url.includes('dialog');
      if (isStaticOrPromo) return;

      const contentType = (response.headers()['content-type'] || '').toLowerCase();
      const contentLength = parseInt(response.headers()['content-length'] || '0', 10);
      if (contentLength > 0 && contentLength < 300000) return; // Bỏ qua file < 300KB

      if (contentType.includes('video/') || url.includes('.mp4') || url.includes('videoplayback') || url.includes('contribution-rt.usercontent.google.com')) {
        if (!capturedNetworkVideos.includes(url)) {
          capturedNetworkVideos.push(url);
          log('info', `🎥 Bắt được luồng video AI từ mạng: ${url.substring(0, 80)}...`);
        }
      }
    } catch (e) {}
  });

  // 2. Đón bắt mọi blob video được khởi tạo trong trình duyệt (hỗ trợ cả MediaSource)
  await page.evaluateOnNewDocument(() => {
    window.__capturedBlobs = [];
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function(obj) {
      const url = origCreateObjectURL.apply(this, arguments);
      try {
        const isMediaSource = typeof MediaSource !== 'undefined' && obj instanceof MediaSource;
        const isVideoBlob = obj && (obj.type?.includes('video') || (obj.size && obj.size > 250000));
        if (isMediaSource || isVideoBlob) {
          window.__capturedBlobs.push({ url, size: obj?.size || 0, isMediaSource, time: Date.now() });
        }
      } catch (e) {}
      return url;
    };
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

    // 2. Chọn định dạng video dọc (Dọc 9:16) và mở tính năng Tạo video AI
    log('info', '📱 Chọn định dạng video dọc (9:16) và khởi tạo video AI...');
    try {
      // 2.1. Chọn Dọc (9:16) nếu có modal chào mừng
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        const docBtn = buttons.find(b => (b.innerText || '').trim().includes('Dọc'));
        if (docBtn) docBtn.click();
      });
      await sleep(1000);

      // 2.2. Bấm card "Tạo video AI" bằng tọa độ chuột thật
      const aiCardHandle = await page.evaluateHandle(() => {
        const all = Array.from(document.querySelectorAll('*'));
        return all.find(c => {
          const t = (c.innerText || '').trim();
          const r = c.getBoundingClientRect();
          return (t.includes('Tạo video AI') || t.includes('Tạo mới')) && r.width > 60 && r.height > 60 && r.width < 320;
        }) || null;
      });
      const aiCardEl = aiCardHandle.asElement();
      if (aiCardEl) {
        const box = await aiCardEl.boundingBox();
        if (box && box.width > 0) {
          log('info', `🎯 Click card Tạo video AI tại (${Math.round(box.x + box.width / 2)}, ${Math.round(box.y + box.height / 2)})...`);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await page.evaluate(el => el.click(), aiCardEl);
        }
      }
      await sleep(2500);

      // 2.3. ĐÓNG HOÀN TOÀN modal chào mừng ("Xin chào ... Hãy bắt đầu sáng tạo") nếu còn che màn hình
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('*'));
        const welcome = all.find(e => {
          const t = (e.innerText || '').trim();
          return t.includes('Hãy bắt đầu sáng tạo') || t.includes('Xin chào');
        });
        if (welcome) {
          let modal = welcome;
          while (modal && modal !== document.body) {
            const r = modal.getBoundingClientRect();
            if (r.width > 350 && r.height > 250) break;
            modal = modal.parentElement;
          }
          if (modal) {
            // Click nút X góc trên bên phải của modal
            const closeBtns = Array.from(modal.querySelectorAll('button, div[role="button"], [aria-label]'));
            const xBtn = closeBtns.find(b => {
              const aria = (b.getAttribute('aria-label') || '').toLowerCase();
              const txt = (b.innerText || '').trim();
              const r = b.getBoundingClientRect();
              return (aria.includes('đóng') || aria.includes('close') || aria.includes('huỷ') || txt === '✕' || txt === '×') && r.top < window.innerHeight * 0.4;
            }) || modal.querySelector('svg')?.closest('button, div[role="button"]');
            if (xBtn) xBtn.click();
            // Ẩn modal để giải phóng màn hình tuyệt đối
            modal.style.display = 'none';
          }
        }

        // Xoá tất cả lớp phủ scrim / overlay / backdrop làm mờ màn hình
        const scrims = Array.from(document.querySelectorAll('.modal-dialog-bg, .picker-dialog-bg, [class*="scrim"], [class*="backdrop"], [class*="overlay"]'));
        scrims.forEach(s => {
          const r = s.getBoundingClientRect();
          if (r.width > window.innerWidth * 0.7 && r.height > window.innerHeight * 0.7) {
            s.style.display = 'none';
          }
        });
      });
      await page.keyboard.press('Escape');
      await sleep(1000);

      // 2.4. Kiểm tra xem panel "Đoạn video do AI tạo" đã mở chưa, nếu chưa bấm icon Video AI trên sidebar
      const isPanelOpen = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('*'));
        return all.some(e => (e.innerText || '').includes('Đoạn video do AI tạo') || (e.innerText || '').includes('Mô tả video của bạn'));
      });
      if (!isPanelOpen) {
        log('info', '🎬 Mở panel Video AI từ thanh công cụ bên phải...');
        await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('button, div[role="button"], [role="tab"]'));
          const vBtn = all.find(b => {
            const t = (b.innerText || '').trim();
            const aria = (b.getAttribute('aria-label') || '').trim();
            return t === 'Video AI' || aria === 'Video AI' || t.includes('Video AI') || aria.includes('Video AI');
          });
          if (vBtn) vBtn.click();
        });
        await sleep(2000);
      }
    } catch (eInit) {
      log('warning', `⚠️ Lưu ý khi khởi tạo giao diện: ${eInit.message}`);
    }

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
          await page.evaluate(el => {
            if (el) {
              el.setAttribute('multiple', '');
              el.multiple = true;
            }
          }, targetInput);
          const allPaths = slots.map(s => s.path);
          await targetInput.uploadFile(...allPaths);
          await page.evaluate(el => {
            if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
          }, targetInput);
          log('info', `✅ Đã nạp batch ${allPaths.length} ảnh nguyên liệu vào Google Vids!`);
          await sleep(3500);
          allBatchUploaded = true;
        }
      } catch (eBatch) {}

      // 2. Nạp từng file còn lại qua nút "+ Thêm" trên giao diện (hỗ trợ cả iframe Google Picker)
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];

        // Kiểm tra xem slot thứ (i + 1) đã có ảnh nạp chưa
        const isAlreadyUploaded = await page.evaluate((idx) => {
          const chips = Array.from(document.querySelectorAll('[role="listitem"], .videoGenCreationViewFileInputsChip, div'));
          return chips.some(c => (c.innerText || '').includes(`Hình ảnh${idx + 1}`) || (c.innerText || '').includes(`Ảnh ${idx + 1}`));
        }, i);

        if (allBatchUploaded && isAlreadyUploaded) {
          log('info', `✅ Ảnh [${slot.name}] đã có sẵn trong khung tạo!`);
          continue;
        }

        log('info', `📸 Đang tải [${slot.name}]: ${path.basename(slot.path)}...`);
        let uploaded = false;

        // Thử tìm nút "+ Thêm" dạng khung nét đứt cạnh ảnh đã nạp
        try {
          const addBtnHandle = await page.evaluateHandle(() => {
            const all = Array.from(document.querySelectorAll('button, div[role="button"], div'));
            return all.find(e => {
              const t = (e.innerText || '').trim();
              const rect = e.getBoundingClientRect();
              return (t === '+ Thêm' || t === 'Thêm' || (e.getAttribute('aria-label') || '').includes('Thêm')) && 
                     rect.width > 20 && rect.height > 20 && rect.top > window.innerHeight * 0.4 &&
                     rect.left < window.innerWidth - 65; // Tránh nhầm với rail sidebar bên phải
            }) || null;
          });

          const addBtn = addBtnHandle.asElement();
          if (addBtn) {
            await page.evaluate(el => el && el.click(), addBtn);
            await sleep(1800);

            // Tìm và click tab "Tải lên" / "Máy tính" / "Upload" trên TẤT CẢ các frame (bao gồm iframe Google Picker)
            const allFrames = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];
            for (const frame of allFrames) {
              try {
                await frame.evaluate(() => {
                  const elements = Array.from(document.querySelectorAll('div, span, button, [role="tab"], a'));
                  const uploadTab = elements.find(e => {
                    const t = (e.innerText || '').trim();
                    return t === 'Tải lên' || t === 'Máy tính' || t === 'Upload';
                  });
                  if (uploadTab) uploadTab.click();
                });
              } catch (e) {}
            }
            await sleep(1500);

            // Tìm input file trong TẤT CẢ các frame để nạp file
            for (const frame of allFrames) {
              try {
                const fInputs = await frame.$$('input[type="file"]');
                if (fInputs.length > 0) {
                  const targetInput = fInputs[fInputs.length - 1];
                  await targetInput.uploadFile(slot.path);
                  try {
                    await frame.evaluate(el => {
                      if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
                    }, targetInput);
                  } catch (e) {}
                  log('info', `✅ Đã nạp thành công [${slot.name}] qua hộp thoại Mở tệp!`);
                  await sleep(3500);
                  uploaded = true;
                  break;
                }
              } catch (e) {}
            }
          }
        } catch (eAdd) {}

        // Đóng modal Mở tệp nếu còn mở
        await page.evaluate(() => {
          const closeBtns = Array.from(document.querySelectorAll('button[aria-label="Đóng"], button[aria-label="Close"], .picker-dialog-close'));
          closeBtns.forEach(b => { try { b.click(); } catch (e) {} });
        });
        await page.keyboard.press('Escape');
        await sleep(800);

        if (!uploaded && i > 0) {
          log('info', `ℹ️ Đã hoàn tất nạp mẫu chính, tiếp tục quá trình tạo video.`);
        }
      }

      // ĐẢM BẢO ĐÓNG HOÀN TOÀN MỌI MODAL / HỘP THOẠI TRƯỚC KHI NHẬP PROMPT
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

    // 6. Bấm nút Tạo video AI (nút tròn màu xanh có icon mũi tên lên ở góc dưới cùng bên phải của panel prompt)
    log('info', '🎬 Bấm nút Tạo video AI...');
    await page.evaluate(() => {
      // Ẩn modal chào mừng nếu còn hiển thị
      const all = Array.from(document.querySelectorAll('*'));
      const welcome = all.find(e => (e.innerText || '').includes('Hãy bắt đầu sáng tạo') || (e.innerText || '').includes('Xin chào'));
      if (welcome) {
        let m = welcome;
        while (m && m !== document.body) {
          if (m.getBoundingClientRect().width > 350) { m.style.display = 'none'; break; }
          m = m.parentElement;
        }
      }
      // Bấm các nút đóng nếu có
      const closeBtns = Array.from(document.querySelectorAll('button[aria-label*="Đóng" i], button[aria-label*="Close" i], [aria-label*="Đóng" i], [aria-label*="Close" i], .picker-dialog-close'));
      closeBtns.forEach(b => { try { b.click(); } catch (e) {} });

      // Xoá tất cả scrim / backdrop
      const scrims = Array.from(document.querySelectorAll('.modal-dialog-bg, .picker-dialog-bg, [class*="scrim"], [class*="backdrop"], [class*="overlay"]'));
      scrims.forEach(s => {
        if (s.getBoundingClientRect().width > window.innerWidth * 0.7) s.style.display = 'none';
      });
    });
    await page.keyboard.press('Escape');
    await sleep(600);

    // Tìm chính xác nút tròn màu xanh ở góc dưới cùng bên phải của panel prompt (tránh tuyệt đối thanh rail bên phải và tab Tạo ở trên)
    const submitBtnHandle = await page.evaluateHandle(() => {
      // 1. Tìm trong container của textarea prompt
      const allTextareas = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'));
      const promptBox = allTextareas.find(t => {
        const r = t.getBoundingClientRect();
        return r.width > 120 && r.height > 40 && r.right > window.innerWidth * 0.4;
      });

      if (promptBox) {
        let container = promptBox.parentElement;
        for (let depth = 0; depth < 8; depth++) {
          if (!container || container === document.body) break;
          const rect = container.getBoundingClientRect();
          if (rect.width > 250 && rect.height > 200 && rect.right > window.innerWidth * 0.5) {
            const clickables = Array.from(container.querySelectorAll('button, div[role="button"], md-filled-icon-button, md-icon-button, [role="button"], div, span'));
            const promptRect = promptBox.getBoundingClientRect();
            
            // Lọc các nút nằm dưới textarea và cách lề phải một khoảng an toàn (không phải sidebar tool rail)
            const bottomBtns = clickables.filter(el => {
              const r = el.getBoundingClientRect();
              if (r.width < 20 || r.width > 70 || r.height < 20 || r.height > 70) return false;
              if (r.top < promptRect.bottom) return false;
              if (r.left > window.innerWidth - 65) return false; // Loại trừ thanh công cụ sidebar
              return true;
            });

            // Ưu tiên nút có màu nền xanh
            const blueBtn = bottomBtns.find(el => {
              const style = window.getComputedStyle(el);
              const bg = style.backgroundColor || '';
              return bg.includes('rgb(') && !bg.includes('255, 255, 255') && !bg.includes('rgba(0, 0, 0, 0)');
            });
            if (blueBtn) return blueBtn;

            // Nút có icon SVG ở góc dưới phải nhất trong container
            const svgBtns = bottomBtns.filter(el => el.querySelector('svg') || el.tagName.toLowerCase() === 'svg');
            if (svgBtns.length > 0) {
              svgBtns.sort((a, b) => {
                const rA = a.getBoundingClientRect();
                const rB = b.getBoundingClientRect();
                return (rB.top + rB.left) - (rA.top + rA.left);
              });
              return svgBtns[0];
            }
          }
          container = container.parentElement;
        }
      }

      // 2. Fallback tìm nút tròn xanh ở góc dưới bên phải (tránh nhầm với tab "Tạo" ở góc trên hoặc rail bên phải)
      const allElements = Array.from(document.querySelectorAll('button, div[role="button"], md-filled-icon-button, md-icon-button, [role="button"], div'));
      const candidates = allElements.filter(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 24 || rect.width > 65 || rect.height < 24 || rect.height > 65) return false;
        if (rect.bottom < window.innerHeight * 0.5 || rect.right < window.innerWidth * 0.6) return false;
        if (rect.left > window.innerWidth - 65) return false; // Tránh rail bên phải
        const style = window.getComputedStyle(el);
        const bg = style.backgroundColor || '';
        const isBlue = bg.includes('rgb(') && !bg.includes('255, 255, 255') && !bg.includes('rgba(0, 0, 0, 0)');
        return isBlue || (el.querySelector('svg') && rect.width === rect.height);
      });

      if (candidates.length > 0) {
        candidates.sort((a, b) => {
          const rA = a.getBoundingClientRect();
          const rB = b.getBoundingClientRect();
          return (rB.top + rB.left) - (rA.top + rA.left);
        });
        return candidates[0];
      }

      return null;
    });

    const submitEl = submitBtnHandle.asElement();
    if (submitEl) {
      const sBox = await submitEl.boundingBox();
      if (sBox && sBox.width > 0 && sBox.height > 0) {
        log('info', `🎯 Đang click nút Tạo video AI tại tọa độ (${Math.round(sBox.x + sBox.width / 2)}, ${Math.round(sBox.y + sBox.height / 2)})...`);
        await page.mouse.click(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
      } else {
        await page.evaluate(el => el.click(), submitEl);
      }
    }

    // Gửi thêm tổ hợp phím Ctrl + Enter vào textarea để chắc chắn submit
    try {
      await page.evaluate(() => {
        const ta = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
        if (ta) ta.focus();
      });
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
    } catch (eKey) {}
    await sleep(2500);

    // Kiểm tra xem đã bắt đầu sinh video chưa, nếu chưa bấm lại
    let hasStarted = false;
    for (let c = 0; c < 6; c++) {
      const isRunning = await page.evaluate(() => {
        const t = document.body.innerText || '';
        return t.includes('Đang tạo') || t.includes('Generating') || t.includes('Bản nháp') || !!t.match(/(\d+)%/);
      });
      if (isRunning) {
        log('info', '🚀 Đã kích hoạt Google Vids AI bắt đầu tạo video thành công!');
        hasStarted = true;
        break;
      }
      log('info', `🔄 Kích hoạt lại nút Tạo video AI (lần ${c + 1}/6)...`);
      if (submitEl) {
        const sBox = await submitEl.boundingBox();
        if (sBox) await page.mouse.click(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
        else await page.evaluate(el => el && el.click(), submitEl);
      }
      try {
        await page.keyboard.down('Control');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Control');
      } catch (eKey) {}
      await sleep(2500);
    }

    if (!hasStarted) {
      log('warning', '⚠️ Chưa thấy giao diện hiển thị trạng thái đang tạo video AI.');
      try {
        await page.screenshot({ path: path.resolve('temp/vids_trigger_check.png') });
      } catch (eSc) {}
      throw new Error('Google Vids chưa bắt đầu tạo video sau khi nhấn nút Tạo. Đã lưu ảnh kiểm tra tại temp/vids_trigger_check.png');
    }

    log('info', '⏳ Đang chờ Google Vids sinh video (Omni 720p 9:16)...');

    // 6. Chờ quá trình sinh video hoàn tất (120 chu kỳ x 4s = 480s = 8 phút)
    let videoSrc = null;
    let consecutiveErrors = 0;
    let reach100Cycles = 0;

    for (let i = 0; i < 120; i++) {
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

          // Helper kiểm tra URL không hợp lệ (video hướng dẫn, promo, static gstatic)
          const isInvalidVideoSrc = (src) => {
            if (!src || src.length <= 5) return true;
            const lower = src.toLowerCase();
            return lower.includes('gstatic.com') ||
                   lower.includes('gettingstarted') ||
                   lower.includes('entry_point') ||
                   lower.includes('promo') ||
                   lower.includes('tutorial') ||
                   lower.includes('sample') ||
                   lower.includes('slides_') ||
                   lower.includes('dialog');
          };

          // Kiểm tra xem đã hoàn thành chưa (chỉ xét nút trong panel bên phải, tránh menu Chèn trên thanh menu bar)
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"], md-filled-button, [role="button"]')).filter(isVisible);
          const panelButtons = buttons.filter(b => {
            const r = b.getBoundingClientRect();
            return r.top > 100 && r.left > window.innerWidth * 0.4 && r.left < window.innerWidth - 65;
          });

          const hasChen = panelButtons.some(b => {
            const t = (b.innerText || '').trim().toLowerCase();
            const a = (b.getAttribute('aria-label') || '').toLowerCase();
            return t.includes('chèn vào') || a.includes('chèn vào') || t.includes('insert into') || a.includes('insert into');
          });
          const hasTaoLai = panelButtons.some(b => {
            const t = (b.innerText || '').trim().toLowerCase();
            const a = (b.getAttribute('aria-label') || '').toLowerCase();
            return t.includes('tạo lại') || a.includes('tạo lại') || t.includes('regenerate') || a.includes('regenerate');
          });

          // LUÔN TÌM THẺ VIDEO HỢP LỆ TRÊN TRANG (loại trừ video gstatic / promo)
          const vids = Array.from(document.querySelectorAll('video')).filter(isVisible);
          const genVideo = vids.find(v => {
            const s = v.currentSrc || v.src || (v.querySelector('source') ? v.querySelector('source').src : '') || '';
            if (isInvalidVideoSrc(s)) return false;
            return s.length > 5;
          });
          const foundSrc = genVideo ? (genVideo.currentSrc || genVideo.src || (genVideo.querySelector('source') ? genVideo.querySelector('source').src : null)) : null;

          // Tìm blob mới nhất từ window.__capturedBlobs
          const captured = (window.__capturedBlobs || []).filter(b => b.url && !isInvalidVideoSrc(b.url));
          const latestBlob = captured.length > 0 ? captured[captured.length - 1].url : null;

          return {
            src: foundSrc,
            latestBlob,
            percent,
            hasError,
            errorMsg,
            hasChen,
            hasTaoLai,
            videoCount: vids.length
          };
        });
        consecutiveErrors = 0;
      } catch (evalErr) {
        consecutiveErrors++;
        log('info', `⏳ Đang đồng bộ giao diện Google Vids (${(i + 1) * 4}s)...`);
        if (consecutiveErrors > 15) {
          throw new Error('Mất kết nối với trang Google Vids: ' + evalErr.message);
        }
        continue;
      }

      if (status.percent) {
        log('info', `⏱️ Tiến độ Google Vids: ${status.percent} (${(i + 1) * 4}s)`);
      } else if (i % 3 === 0 && !status.src && !status.latestBlob) {
        log('info', `⏳ Đang xử lý tạo video AI... (${(i + 1) * 4}s)`);
      }

      if (status.hasError) {
        throw new Error(status.errorMsg || 'Google Vids thông báo lỗi tạo video hoặc vi phạm chính sách nội dung.');
      }

      // Theo dõi số chu kỳ đạt 100%
      if (status.percent === '100%') {
        reach100Cycles++;
        if (reach100Cycles === 1) {
          try {
            await page.screenshot({ path: path.resolve('temp/vids_100_percent.png') });
            log('info', '📸 Đã chụp ảnh giao diện tại mốc 100% (temp/vids_100_percent.png)');
          } catch (eSc) {}
        }
      }

      // Điều kiện hoàn thành đáng tin cậy: Đạt 100% HOẶC có nút Chèn vào / Tạo lại sau ít nhất 16s tạo
      const isComplete = (reach100Cycles >= 1) || ((status.hasChen || status.hasTaoLai) && i >= 4);

      // Ưu tiên 1: Lấy URL video bắt được từ mạng (CDP response listener)
      if (capturedNetworkVideos.length > 0 && isComplete) {
        videoSrc = capturedNetworkVideos[capturedNetworkVideos.length - 1];
        log('info', `🎉 Đã bắt được video trực tiếp từ mạng: ${videoSrc.substring(0, 80)}...`);
        break;
      }

      const activeSrc = status.src || status.latestBlob;

      // Ưu tiên 2: Kết thúc ngay khi có nguồn video và đã hoàn tất
      if (activeSrc && isComplete) {
        videoSrc = activeSrc;
        log('info', `🎉 Google Vids đã hoàn thành video (${status.percent || '100%'})!`);
        break;
      }

      // Ưu tiên 3: Quét tìm thẻ video trong tất cả iframes
      if (!videoSrc && (reach100Cycles >= 1 || (isComplete && i >= 8))) {
        for (const frame of page.frames()) {
          try {
            const fVids = await frame.evaluate(() => {
              const vs = Array.from(document.querySelectorAll('video'));
              return vs.map(v => v.currentSrc || v.src || v.querySelector('source')?.src).filter(Boolean);
            });
            const valid = fVids.find(s => {
              if (!s || s.length <= 5) return false;
              const lower = s.toLowerCase();
              return !lower.includes('gstatic.com') && !lower.includes('promo') && !lower.includes('tutorial');
            });
            if (valid) {
              videoSrc = valid;
              log('info', `🎉 Tìm thấy thẻ video trong iframe: ${videoSrc}`);
              break;
            }
          } catch (e) {}
        }
        if (videoSrc) break;
      }

      // Ưu tiên 4: Nếu đạt 100% từ 2 chu kỳ trở lên (>= 8s) mà chưa bắt được video:
      // Tự động click thumbnail video hoặc nút Chèn / Thêm để đưa video vào timeline
      if (reach100Cycles >= 2 && !videoSrc) {
        log('info', '🎬 Video đạt 100%, đang chèn video vào dòng thời gian để trích xuất...');
        await page.evaluate(() => {
          // Click thumbnail để kích hoạt player
          const thumbs = Array.from(document.querySelectorAll('[class*="Successfulvideogeneration"], [class*="thumbnail"], [class*="Thumbnail"]'));
          thumbs.forEach(t => { try { t.click(); } catch (e) {} });

          // Click nút Chèn vào video / Chèn vào timeline
          const all = Array.from(document.querySelectorAll('button, div[role="button"], md-filled-button, [role="button"]'));
          const btn = all.find(b => {
            const t = (b.innerText || '').trim().toLowerCase();
            const a = (b.getAttribute('aria-label') || '').toLowerCase();
            return t.includes('chèn vào') || a.includes('chèn vào') || t.includes('insert into') || a.includes('insert into') ||
                   t === 'chèn' || a === 'chèn';
          });
          if (btn) btn.click();
        });
        await sleep(2500);

        // Kiểm tra lại capturedNetworkVideos
        if (capturedNetworkVideos.length > 0) {
          videoSrc = capturedNetworkVideos[capturedNetworkVideos.length - 1];
          log('info', `🎉 Đã bắt được video từ mạng sau khi chèn: ${videoSrc.substring(0, 80)}...`);
          break;
        }

        // Quét lại toàn bộ thẻ video trên trang
        const insertedSrc = await page.evaluate(() => {
          const vids = Array.from(document.querySelectorAll('video'));
          const gen = vids.find(v => {
            const s = v.currentSrc || v.src || (v.querySelector('source') ? v.querySelector('source').src : '') || '';
            const lower = s.toLowerCase();
            return s && !lower.includes('gstatic.com') && !lower.includes('promo') && !lower.includes('gettingstarted') && s.length > 5;
          });
          return gen ? (gen.currentSrc || gen.src || (gen.querySelector('source') ? gen.querySelector('source').src : null)) : null;
        });

        if (insertedSrc) {
          videoSrc = insertedSrc;
          log('info', '🎉 Đã lấy được link video sau khi chèn vào timeline!');
          break;
        }

        // Kiểm tra lại capturedBlobs
        const retryBlob = await page.evaluate(() => {
          const captured = (window.__capturedBlobs || []).filter(b => {
            if (!b.url) return false;
            const lower = b.url.toLowerCase();
            return !lower.includes('promo') && !lower.includes('gstatic.com');
          });
          return captured.length > 0 ? captured[captured.length - 1].url : null;
        });
        if (retryBlob) {
          videoSrc = retryBlob;
          log('info', '🎉 Đã lấy được blob video sau khi chèn!');
          break;
        }
      }
    }

    if (!videoSrc) {
      try {
        const debugPath = path.resolve('temp/vids_timeout_debug.png');
        fs.mkdirSync(path.dirname(debugPath), { recursive: true });
        // KHÔNG dùng fullPage: true để tránh màn hình bị trắng xóa trên ứng dụng canvas Docs
        await page.screenshot({ path: debugPath });
        log('warning', `📸 Đã lưu ảnh chụp màn hình debug tại: ${debugPath}`);
      } catch (ssErr) {}
      throw new Error('Hết thời gian chờ Google Vids tạo video (quá 8 phút).');
    }

    // 7. Tải video MP4 về máy tính
    log('info', '💾 Đang tải video MP4 về máy tính...');
    let downloadedFile = null;

    // Cách 0: Nếu là URL mạng HTTP/HTTPS (từ Google Video CDN), tải trực tiếp bằng Axios
    if (videoSrc && videoSrc.startsWith('http')) {
      try {
        log('info', '📥 Đang tải video trực tiếp từ Google CDN...');
        const cookies = await page.cookies();
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const resp = await axios.get(videoSrc, {
          responseType: 'arraybuffer',
          headers: {
            'Cookie': cookieHeader,
            'User-Agent': await page.evaluate(() => navigator.userAgent)
          },
          timeout: 60000
        });
        if (resp.data && resp.data.byteLength > 300000) {
          const filename = `vids_${Date.now()}.mp4`;
          downloadedFile = path.join(outputDir, filename);
          fs.writeFileSync(downloadedFile, Buffer.from(resp.data));
          log('info', `🎉 Đã lưu video thành công từ CDN: ${downloadedFile} (${(resp.data.byteLength / 1024 / 1024).toFixed(2)} MB)`);
        } else {
          log('warning', `⚠️ Video từ CDN có dung lượng quá nhỏ (${resp.data?.byteLength || 0} bytes), bỏ qua để trích xuất blob thực...`);
        }
      } catch (httpErr) {
        log('warning', `Tải video từ CDN thất bại: ${httpErr.message}, tiếp tục thử trích xuất blob...`);
      }
    }

    // Cách 1: Nếu là blob URL, trích xuất trực tiếp buffer từ trình duyệt bằng fetch
    if (!downloadedFile && videoSrc && videoSrc.startsWith('blob:')) {
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
          if (buffer.length > 300000) {
            const filename = `vids_${Date.now()}.mp4`;
            downloadedFile = path.join(outputDir, filename);
            fs.writeFileSync(downloadedFile, buffer);
            log('info', `🎉 Đã lưu video thành công: ${downloadedFile} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
          } else {
            log('warning', `⚠️ Video blob có dung lượng quá nhỏ (${buffer.length} bytes), bỏ qua...`);
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
