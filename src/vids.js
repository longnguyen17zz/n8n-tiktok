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
    await sleep(4000);

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

    // 4. Phân loại và nạp ảnh nguyên liệu theo đúng slot trong Google Vids:
    // - MẪU ẢNH (avatar) -> Nạp vào "Hình đại diện" (Avatar) để AI dùng đúng mặt người mẫu làm nhân vật chính
    // - SẢN PHẨM (product) -> Nạp vào "Thành phần" (Components) để người mẫu cầm đúng sản phẩm trên tay
    // - BACKGROUND (background) -> Nạp bổ sung vào "Thành phần"
    const slots = [];
    if (avatarPath && fs.existsSync(avatarPath)) {
      slots.push({ path: path.resolve(avatarPath), type: 'avatar', name: 'Mẫu ảnh (Hình đại diện)' });
    }
    if (productPath && fs.existsSync(productPath)) {
      slots.push({ path: path.resolve(productPath), type: 'component', name: 'Sản phẩm (Thành phần)' });
    }
    if (backgroundPath && fs.existsSync(backgroundPath)) {
      slots.push({ path: path.resolve(backgroundPath), type: 'component', name: 'Background (Thành phần)' });
    }

    // Fallback nếu người dùng truyền danh sách imagePaths truyền thống
    if (slots.length === 0 && imagePaths && imagePaths.length > 0) {
      const validImages = imagePaths.filter(img => img && fs.existsSync(img));
      validImages.forEach((img, idx) => {
        const isAvatar = path.basename(img).includes('mau_anh') || idx === 1;
        slots.push({
          path: path.resolve(img),
          type: isAvatar ? 'avatar' : 'component',
          name: isAvatar ? 'Mẫu ảnh (Hình đại diện)' : 'Sản phẩm (Thành phần)'
        });
      });
      // Ưu tiên nạp avatar vào Hình đại diện trước
      slots.sort((a, b) => (a.type === 'avatar' ? -1 : 1));
    }

    if (slots.length > 0) {
      log('info', `🖼️ Đang nạp ${slots.length} ảnh nguyên liệu vào Google Vids: ${slots.map(s => s.name).join(' + ')}...`);

      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        log('info', `📸 Đang tải [${slot.name}]: ${path.basename(slot.path)}...`);

        // Đảm bảo tab "Tạo" đang được chọn
        await page.evaluate(() => {
          const tabs = Array.from(document.querySelectorAll('button, div[role="button"], div[role="tab"]'));
          const taoTab = tabs.find(t => (t.innerText || '').trim() === 'Tạo');
          if (taoTab && !taoTab.className.includes('Selected')) {
            taoTab.click();
          }
        });
        await sleep(600);

        let uploaded = false;
        const isAvatarSlot = slot.type === 'avatar';

        // 1. Thử click trực tiếp vào nút slot hiển thị trên khung tạo (nếu có ô trống "Hình đại diện" hoặc "Thành phần")
        try {
          const slotBtnHandle = await page.evaluateHandle((isAvatar) => {
            const isVisible = (el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            };

            const scope = document.querySelector('.videoGenCreationView, [role="dialog"], .collapsiblePromptBox') || document.body;
            const candidates = Array.from(scope.querySelectorAll('button, div[role="button"], [tabindex="0"]')).filter(isVisible);

            const btn = candidates.find(e => {
              const txt = (e.innerText || '').trim().toLowerCase();
              const aria = (e.getAttribute('aria-label') || '').trim().toLowerCase();
              if (isAvatar) {
                return (txt.includes('hình đại diện') || aria.includes('hình đại diện') || txt === 'avatar') && !txt.includes('chọn');
              } else {
                return txt.includes('thành phần') || aria.includes('thành phần');
              }
            });
            return btn || null;
          }, isAvatarSlot);

          const slotBtn = slotBtnHandle.asElement();
          if (slotBtn) {
            const fcPromise = page.waitForFileChooser({ timeout: 4000 }).catch(() => null);
            await page.evaluate(el => {
              if (el) {
                el.scrollIntoView({ behavior: 'instant', block: 'center' });
                el.click();
              }
            }, slotBtn);

            const fc = await fcPromise;
            if (fc) {
              await fc.accept([slot.path]);
              log('info', `✅ Đã nạp thành công [${slot.name}] vào đúng ô trên giao diện!`);
              await sleep(3000);
              uploaded = true;
            }
          }
        } catch (e1) {
          // Bỏ qua và chuyển sang bước 2
        }

        // 2. Nếu chưa nạp được, bấm nút "+ Thêm" (Thêm hình đại diện hoặc thành phần)
        if (!uploaded) {
          try {
            const addBtnHandle = await page.evaluateHandle(() => {
              const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
              };

              const exactBtn = document.querySelector('button[aria-label="Thêm hình đại diện hoặc thành phần"], .videoGenCreationViewFileInputsInputSelectButton');
              if (exactBtn && isVisible(exactBtn)) return exactBtn;

              const scope = document.querySelector('.videoGenCreationView, [role="dialog"], .collapsiblePromptBox') || document.body;
              const buttons = Array.from(scope.querySelectorAll('button, div[role="button"]')).filter(isVisible);
              return buttons.find(e => {
                const aria = (e.getAttribute('aria-label') || '').toLowerCase();
                const txt = (e.innerText || '').toLowerCase();
                return aria.includes('thêm') || txt.includes('thêm') || aria.includes('add') || txt.includes('add');
              }) || null;
            });

            const addBtn = addBtnHandle.asElement();
            if (addBtn) {
              await page.evaluate(el => {
                if (el) {
                  el.scrollIntoView({ behavior: 'instant', block: 'center' });
                  el.click();
                }
              }, addBtn);
              await sleep(1200);

              // Menu popup xổ ra: chọn "Hình đại diện" hoặc "Thành phần" tương ứng
              const menuItemHandle = await page.evaluateHandle((isAvatar) => {
                const isVisible = (el) => {
                  if (!el) return false;
                  const style = window.getComputedStyle(el);
                  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                  const rect = el.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0;
                };

                const allItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, div[role="button"], span, div')).filter(isVisible);
                let target = allItems.find(e => {
                  const txt = (e.innerText || '').trim().toLowerCase();
                  const aria = (e.getAttribute('aria-label') || '').trim().toLowerCase();
                  if (isAvatar) {
                    return (txt.includes('hình đại diện') || aria.includes('hình đại diện') || txt.includes('avatar')) && !txt.includes('thêm');
                  }
                  return (txt.includes('thành phần') || aria.includes('thành phần') || txt.includes('element')) && !txt.includes('thêm');
                });

                if (!target) {
                  target = allItems.find(e => {
                    const txt = (e.innerText || '').trim().toLowerCase();
                    return txt.includes('tải lên') || txt.includes('upload') || txt.includes('tệp') || txt.includes('máy tính');
                  });
                }
                return target ? (target.closest('[role="menuitem"], [role="option"], button, div[role="button"]') || target) : null;
              }, isAvatarSlot);

              const menuItem = menuItemHandle.asElement();
              if (menuItem) {
                const fcPromise = page.waitForFileChooser({ timeout: 5000 }).catch(() => null);
                await page.evaluate(el => {
                  if (el) {
                    el.scrollIntoView({ behavior: 'instant', block: 'center' });
                    el.click();
                  }
                }, menuItem);

                let fc = await fcPromise;

                // Nếu click vào mục menu lại mở tiếp 1 menu con có chữ "Tải lên" / "Từ máy tính"
                if (!fc) {
                  await sleep(800);
                  const subItemHandle = await page.evaluateHandle(() => {
                    const all = Array.from(document.querySelectorAll('[role="menuitem"], button, div[role="button"]'));
                    return all.find(e => {
                      const txt = (e.innerText || '').trim().toLowerCase();
                      return txt.includes('tải lên') || txt.includes('máy tính') || txt.includes('upload');
                    }) || null;
                  });
                  const subItem = subItemHandle.asElement();
                  if (subItem) {
                    const subFcPromise = page.waitForFileChooser({ timeout: 5000 }).catch(() => null);
                    await page.evaluate(el => el && el.click(), subItem);
                    fc = await subFcPromise;
                  }
                }

                if (fc) {
                  await fc.accept([slot.path]);
                  log('info', `✅ Đã nạp thành công [${slot.name}] qua menu Thêm!`);
                  await sleep(3500);
                  uploaded = true;
                }
              }
            }
          } catch (e2) {
            // Bỏ qua và chuyển sang fallback input[type="file"]
          }
        }

        // 3. Fallback: nạp qua input[type="file"]
        if (!uploaded) {
          try {
            // Đóng menu popup nếu còn lơ lửng trên màn hình
            await page.keyboard.press('Escape');
            await sleep(600);

            const fileInputs = await page.$$('input[type="file"]');
            if (fileInputs.length > 0) {
              const targetInput = fileInputs[fileInputs.length - 1];
              // Xóa giá trị cũ để kích hoạt lại sự kiện change cho file tiếp theo (Background)
              await page.evaluate(el => { if (el) el.value = ''; }, targetInput);
              await targetInput.uploadFile(slot.path);
              await page.evaluate(el => {
                if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
              }, targetInput);
              log('info', `✅ Đã nạp [${slot.name}] qua input file fallback.`);
              await sleep(3500);
              uploaded = true;
            } else {
              log('warning', `⚠️ Không tìm thấy ô tải tệp cho [${slot.name}]`);
            }
          } catch (e3) {
            log('warning', `⚠️ Cảnh báo tải [${slot.name}]: ${e3.message}`);
          }
        }
      }

      // Quay lại tab "Tạo"
      await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('button, div[role="button"], div[role="tab"]'));
        const tao = tabs.find(b => (b.innerText || '').trim() === 'Tạo');
        if (tao) tao.click();
      });
      await sleep(1000);
    }

    // 5. Tìm ô nhập prompt kịch bản và gõ nội dung
    log('info', `📝 Đang nhập kịch bản: "${prompt.substring(0, 60)}..."`);
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const target = all.find(el => (el.innerText || '').includes('Mô tả video của bạn') || el.getAttribute('role') === 'textbox');
      if (target) {
        const input = target.querySelector('textarea, [contenteditable="true"]') || target;
        input.focus();
      }
    });

    // Nhập prompt vào ô
    await page.keyboard.type(prompt, { delay: 10 });
    await sleep(1500);

    // 6. Bấm nút Tạo video AI (nút mũi tên tròn xanh .collapsiblePromptBoxGenerateButton)
    log('info', '🎬 Bấm nút Tạo video AI...');
    const submitBtnHandle = await page.evaluateHandle(() => {
      return document.querySelector('button.collapsiblePromptBoxGenerateButton, button[aria-label="Tạo"].collapsiblePromptBoxGenerateButton');
    });
    const submitEl = submitBtnHandle.asElement();
    if (submitEl) {
      const sBox = await submitEl.boundingBox();
      if (sBox) {
        await page.mouse.click(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
      } else {
        await page.evaluate(el => el.click(), submitEl);
      }
    } else {
      await page.keyboard.press('Enter');
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

          // Tìm đúng video do AI sinh ra (bỏ qua video quảng cáo mẫu)
          const vids = Array.from(document.querySelectorAll('video'));
          const genVideo = vids.find(v => {
            const s = v.currentSrc || v.src || (v.querySelector('source') ? v.querySelector('source').src : '') || '';
            if (s.includes('video_gen_cartoon_avatar_promo')) return false;
            return s.includes('contribution-rt.usercontent.google.com') ||
                   s.includes('googleusercontent.com') ||
                   s.includes('blob:') ||
                   (v.className && v.className.includes('Successfulvideogenerationthumbnail')) ||
                   (v.duration && v.duration > 3) ||
                   ((hasChen || hasTaoLai) && s.length > 5);
          });

          let foundSrc = null;
          if (genVideo) {
            foundSrc = genVideo.currentSrc || genVideo.src || (genVideo.querySelector('source') ? genVideo.querySelector('source').src : null);
          }

          return {
            src: foundSrc,
            percent,
            hasError,
            errorMsg,
            hasChen: hasChen || hasTaoLai,
            hasTaoLai,
            videoCount: vids.length
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
      } else if (i % 3 === 0 && !status.src && !status.hasChen) {
        log('info', `⏳ Đang xử lý tạo video... (${(i + 1) * 4}s)`);
      }

      if (status.hasError) {
        throw new Error(status.errorMsg || 'Google Vids thông báo lỗi tạo video hoặc vi phạm chính sách nội dung.');
      }

      if (status.src) {
        videoSrc = status.src;
        log('info', '🎉 Google Vids đã hoàn thành video!');
        break;
      }

      // Trường hợp video đã xong (có nút Chèn/Tạo lại) nhưng src đang tải
      if (status.hasChen && status.videoCount > 0) {
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

    // 7. Tải video MP4 về máy tính qua CDP download
    console.log('💾 Đang tải video MP4 về máy tính...');
    let downloadedFile = null;

    try {
      const bClient = await browser.target().createCDPSession();
      await bClient.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: path.resolve(outputDir),
        eventsEnabled: true
      });
    } catch (e) {}

    try {
      const pClient = await page.target().createCDPSession();
      await pClient.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: path.resolve(outputDir)
      });
    } catch (e) {}

    await page.evaluate((url) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = 'video.mp4';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
    }, videoSrc);

    // Chờ file tải về hoàn tất trong outputDir
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const files = fs.readdirSync(outputDir);
      const mp4Files = files.filter(f => f.endsWith('.mp4') && !f.endsWith('.crdownload'));
      if (mp4Files.length > 0) {
        downloadedFile = path.join(outputDir, mp4Files[mp4Files.length - 1]);
        console.log(`🎉 Đã tải video thành công: ${downloadedFile} (${(fs.statSync(downloadedFile).size / 1024 / 1024).toFixed(2)} MB)`);
        break;
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
