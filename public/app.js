// ========================================================
// AI PRODUCT VIDEO GENERATOR - CLIENT APPLICATION
// Realtime updates, Stepper animation & Dashboard controls
// ========================================================

const API_BASE = '';

// DOM Elements
const navItems = document.querySelectorAll('.nav-item');
const contentViews = document.querySelectorAll('.content-view');
const pageTitle = document.getElementById('pageTitle');
const btnToggleWorker = document.getElementById('btnToggleWorker');
const workerStatusText = document.getElementById('workerStatusText');
const btnOpenChrome = document.getElementById('btnOpenChrome');
const btnSuggestAI = document.getElementById('btnSuggestAI');
const inputProductName = document.getElementById('inputProductName');
const inputScript = document.getElementById('inputScript');
const createVideoForm = document.getElementById('createVideoForm');
const btnSubmitCreate = document.getElementById('btnSubmitCreate');
const workflowStepper = document.getElementById('workflowStepper');
const terminalLogBody = document.getElementById('terminalLogBody');
const miniLogsList = document.getElementById('miniLogsList');
const processingCard = document.getElementById('processingCard');
const queueTableBody = document.getElementById('queueTableBody');
const tiktokQueueTableBody = document.getElementById('tiktokQueueTableBody');
const sidebarTikTokCount = document.getElementById('sidebarTikTokCount');
const videoGalleryGrid = document.getElementById('videoGalleryGrid');
const sidebarVideoCount = document.getElementById('sidebarVideoCount');
const galleryCountTag = document.getElementById('galleryCountTag');
const videoModal = document.getElementById('videoModal');
const modalVideoPlayer = document.getElementById('modalVideoPlayer');
const modalVideoTitle = document.getElementById('modalVideoTitle');
const btnDownloadVideo = document.getElementById('btnDownloadVideo');

const titles = {
  dashboard: 'Tổng quan hệ thống',
  studio: 'Studio Tạo Video AI',
  queue: 'Hàng đợi Google Sheets',
  tiktok: 'Đăng TikTok',
  gallery: 'Kho Video Thành Phẩm',
  logs: 'Nhật ký hệ thống Realtime',
  settings: 'Cấu hình & Tích hợp'
};

const bottomNavItems = document.querySelectorAll('.bottom-nav-item[data-tab]');
const btnMobileMenu = document.getElementById('btnMobileMenu');
const btnCloseSidebar = document.getElementById('btnCloseSidebar');
const btnBottomMore = document.getElementById('btnBottomMore');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const sidebarEl = document.querySelector('.sidebar');

function openMobileSidebar() {
  if (sidebarEl) sidebarEl.classList.add('mobile-open');
  if (sidebarOverlay) sidebarOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeMobileSidebar() {
  if (sidebarEl) sidebarEl.classList.remove('mobile-open');
  if (sidebarOverlay) sidebarOverlay.classList.remove('active');
  document.body.style.overflow = '';
}

if (btnMobileMenu) btnMobileMenu.addEventListener('click', openMobileSidebar);
if (btnCloseSidebar) btnCloseSidebar.addEventListener('click', closeMobileSidebar);
if (btnBottomMore) btnBottomMore.addEventListener('click', () => {
  if (sidebarEl && sidebarEl.classList.contains('mobile-open')) {
    closeMobileSidebar();
  } else {
    openMobileSidebar();
  }
});
if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeMobileSidebar);

// 1. TAB NAVIGATION
function switchTab(tabId) {
  navItems.forEach(item => {
    if (item.dataset.tab === tabId) item.classList.add('active');
    else item.classList.remove('active');
  });

  bottomNavItems.forEach(item => {
    if (item.dataset.tab === tabId) item.classList.add('active');
    else item.classList.remove('active');
  });

  contentViews.forEach(view => {
    if (view.id === `view-${tabId}`) view.classList.add('active');
    else view.classList.remove('active');
  });

  if (pageTitle && titles[tabId]) {
    pageTitle.textContent = titles[tabId];
  }

  // Tải dữ liệu theo tab
  if (tabId === 'queue') fetchQueue();
  if (tabId === 'tiktok') fetchTikTokQueue();
  if (tabId === 'gallery') fetchVideos();

  // Tự động đóng menu trên mobile khi chọn tab
  closeMobileSidebar();
}

navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const tabId = item.dataset.tab;
    switchTab(tabId);
    window.location.hash = tabId;
  });
});

bottomNavItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const tabId = item.dataset.tab;
    switchTab(tabId);
    window.location.hash = tabId;
  });
});

// Handle hash URL
window.addEventListener('load', () => {
  const hash = window.location.hash.replace('#', '');
  if (hash && titles[hash]) switchTab(hash);
  fetchStatus();
  fetchLogs();
  fetchVideos();
  setInterval(fetchStatus, 4000);
  setInterval(fetchLogs, 3000);
});

// 2. SCHEDULE & WORKER STATE
let currentSchedule = null;
let clientCountdownSeconds = null;
let countdownInterval = null;

function startClientCountdown(sec) {
  if (countdownInterval) clearInterval(countdownInterval);
  clientCountdownSeconds = sec;
  updateCountdownDisplay();

  countdownInterval = setInterval(() => {
    if (clientCountdownSeconds !== null && clientCountdownSeconds > 0) {
      clientCountdownSeconds--;
      updateCountdownDisplay();
    } else {
      clearInterval(countdownInterval);
      countdownInterval = null;
      fetchStatus();
      if (document.getElementById('view-queue')?.classList.contains('active')) {
        fetchQueue();
      }
    }
  }, 1000);
}

function updateCountdownDisplay() {
  const cdBadge = document.getElementById('scheduleCountdownBadge');
  const cdSec = document.getElementById('countdownSec');
  if (cdBadge && cdSec) {
    if (clientCountdownSeconds !== null && clientCountdownSeconds > 0 && currentSchedule?.config?.enabled) {
      cdSec.textContent = clientCountdownSeconds;
      cdBadge.style.display = 'inline-flex';
    } else {
      cdBadge.style.display = 'none';
    }
  }

  // Cập nhật text trên Header button
  if (currentSchedule && btnToggleWorker && workerStatusText) {
    if (currentSchedule.config.enabled) {
      if (currentSchedule.state.isProcessing) {
        workerStatusText.textContent = `Đang xử lý (#${currentSchedule.state.currentProcessingRow || '...'})`;
      } else if (clientCountdownSeconds !== null && clientCountdownSeconds > 0) {
        workerStatusText.textContent = `Dừng Lên Lịch (${clientCountdownSeconds}s)`;
      } else {
        workerStatusText.textContent = 'Dừng Lên Lịch';
      }
    } else {
      workerStatusText.textContent = 'Bật Lên Lịch';
    }
  }
}

// FETCH STATUS & SCHEDULE
async function fetchStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/status`);
    const data = await res.json();

    // 1. Cập nhật Schedule State
    if (data.schedule) {
      currentSchedule = data.schedule;
      const isEnabled = data.schedule.config.enabled;
      const isProcessing = data.schedule.state.isProcessing;

      // Header button
      if (isEnabled) {
        btnToggleWorker.classList.remove('btn-primary');
        btnToggleWorker.classList.add('btn-secondary');
      } else {
        btnToggleWorker.classList.remove('btn-secondary');
        btnToggleWorker.classList.add('btn-primary');
      }

      // Schedule Controller Card (Queue view)
      const btnMainScheduleToggle = document.getElementById('btnMainScheduleToggle');
      const btnMainScheduleText = document.getElementById('btnMainScheduleText');
      const scheduleStatusDot = document.getElementById('scheduleStatusDot');
      const scheduleStatusTitle = document.getElementById('scheduleStatusTitle');
      const scheduleDetailText = document.getElementById('scheduleDetailText');
      const scheduleIntervalSelect = document.getElementById('scheduleIntervalSelect');
      const scheduleContinuous = document.getElementById('scheduleContinuous');

      if (btnMainScheduleToggle && btnMainScheduleText) {
        if (isEnabled) {
          btnMainScheduleToggle.classList.remove('btn-primary');
          btnMainScheduleToggle.classList.add('btn-secondary');
          btnMainScheduleText.textContent = '⏸ Dừng Lên Lịch';
        } else {
          btnMainScheduleToggle.classList.remove('btn-secondary');
          btnMainScheduleToggle.classList.add('btn-primary');
          btnMainScheduleText.textContent = '▶ Bật Lên Lịch';
        }
      }

      if (scheduleStatusDot && scheduleStatusTitle) {
        scheduleStatusDot.className = 'status-indicator';
        if (!isEnabled) {
          scheduleStatusDot.classList.add('offline');
          scheduleStatusTitle.textContent = 'Lên lịch: Đã tắt';
        } else if (isProcessing) {
          scheduleStatusDot.classList.add('online');
          scheduleStatusTitle.textContent = `Đang xử lý hàng #${data.schedule.state.currentProcessingRow || '...'}`;
        } else {
          scheduleStatusDot.classList.add('online');
          scheduleStatusTitle.textContent = `Lên lịch: Đang chạy (${data.schedule.config.intervalSeconds}s)`;
        }
      }

      if (scheduleDetailText) {
        if (!isEnabled) {
          scheduleDetailText.textContent = 'Tự động quét Google Sheet để tạo video theo lịch hẹn & chu kỳ thiết lập.';
        } else if (isProcessing) {
          scheduleDetailText.textContent = data.schedule.state.currentStatus || 'Hệ thống đang tự động tạo video...';
        } else {
          scheduleDetailText.textContent = `${data.schedule.state.currentStatus} • Đã xử lý ${data.schedule.state.totalProcessedSession || 0} video phiên này.`;
        }
      }

      // Đồng bộ inputs nếu người dùng chưa mở tương tác
      if (scheduleIntervalSelect && !scheduleIntervalSelect.matches(':focus')) {
        scheduleIntervalSelect.value = data.schedule.config.intervalSeconds || 60;
      }
      if (scheduleContinuous && !scheduleContinuous.matches(':focus')) {
        scheduleContinuous.checked = !!data.schedule.config.continuous;
      }

      // Đồng bộ Settings Card
      const settingsScheduleInterval = document.getElementById('settingsScheduleInterval');
      const settingsScheduleContinuous = document.getElementById('settingsScheduleContinuous');
      const settingsScheduleTimeRange = document.getElementById('settingsScheduleTimeRange');
      const settingsStartHour = document.getElementById('settingsStartHour');
      const settingsEndHour = document.getElementById('settingsEndHour');
      const settingsScheduleDot = document.getElementById('settingsScheduleDot');
      const settingsScheduleStatus = document.getElementById('settingsScheduleStatus');

      if (settingsScheduleInterval && !settingsScheduleInterval.matches(':focus')) {
        settingsScheduleInterval.value = data.schedule.config.intervalSeconds || 60;
      }
      if (settingsScheduleContinuous && !settingsScheduleContinuous.matches(':focus')) {
        settingsScheduleContinuous.checked = !!data.schedule.config.continuous;
      }
      if (settingsScheduleTimeRange && !settingsScheduleTimeRange.matches(':focus')) {
        settingsScheduleTimeRange.checked = !!data.schedule.config.timeRangeEnabled;
        toggleTimeRangeInputs();
      }
      if (settingsStartHour && !settingsStartHour.matches(':focus')) {
        settingsStartHour.value = data.schedule.config.startHour || 8;
      }
      if (settingsEndHour && !settingsEndHour.matches(':focus')) {
        settingsEndHour.value = data.schedule.config.endHour || 22;
      }
      if (settingsScheduleDot && settingsScheduleStatus) {
        settingsScheduleDot.className = 'status-indicator ' + (isEnabled ? 'online' : 'offline');
        settingsScheduleStatus.textContent = isEnabled
          ? `Trạng thái: Đang hoạt động (${data.schedule.config.intervalSeconds}s / lần)`
          : 'Trạng thái: Đã tạm dừng';
      }

      // Khởi động hoặc đồng bộ đếm ngược
      if (data.schedule.state.secondsUntilNextRun && isEnabled && !isProcessing) {
        if (clientCountdownSeconds === null || Math.abs(clientCountdownSeconds - data.schedule.state.secondsUntilNextRun) > 3) {
          startClientCountdown(data.schedule.state.secondsUntilNextRun);
        }
      } else {
        if (!isEnabled || isProcessing) {
          clientCountdownSeconds = null;
          updateCountdownDisplay();
        }
      }
    }

    // 2. Cập nhật trạng thái Google Drive OAuth
    if (data.googleOAuth) {
      const driveConnectText = document.getElementById('driveConnectText');
      const driveOAuthDot = document.getElementById('driveOAuthDot');
      const driveOAuthEmail = document.getElementById('driveOAuthEmail');
      const driveOAuthConfigForm = document.getElementById('driveOAuthConfigForm');
      const btnOAuthLogin = document.getElementById('btnOAuthLogin');
      const btnOAuthDisconnect = document.getElementById('btnOAuthDisconnect');
      const btnConnectDrive = document.getElementById('btnConnectDrive');

      if (data.googleOAuth.connected) {
        if (driveConnectText) driveConnectText.textContent = 'Drive: Đã kết nối';
        if (btnConnectDrive) {
          btnConnectDrive.classList.remove('btn-secondary');
          btnConnectDrive.classList.add('btn-emerald');
        }
        if (driveOAuthDot) {
          driveOAuthDot.classList.remove('offline');
          driveOAuthDot.classList.add('online');
        }
        if (driveOAuthEmail) driveOAuthEmail.textContent = `Đã kết nối: ${data.googleOAuth.email}`;
        if (driveOAuthConfigForm) driveOAuthConfigForm.style.display = 'none';
        if (btnOAuthLogin) btnOAuthLogin.style.display = 'none';
        if (btnOAuthDisconnect) btnOAuthDisconnect.style.display = 'inline-block';
      } else {
        if (driveConnectText) driveConnectText.textContent = 'Đăng nhập Drive (OAuth)';
        if (btnConnectDrive) {
          btnConnectDrive.classList.remove('btn-emerald');
          btnConnectDrive.classList.add('btn-secondary');
        }
        if (driveOAuthDot) {
          driveOAuthDot.classList.remove('online');
          driveOAuthDot.classList.add('offline');
        }
        if (driveOAuthEmail) driveOAuthEmail.textContent = 'Chưa kết nối tài khoản Google Drive';
        if (btnOAuthDisconnect) btnOAuthDisconnect.style.display = 'none';
        if (btnOAuthLogin) btnOAuthLogin.style.display = 'inline-block';
        if (!data.googleOAuth.hasConfig && driveOAuthConfigForm) {
          driveOAuthConfigForm.style.display = 'block';
        }
      }
    }

    // 3. Cập nhật thẻ đang xử lý
    if (data.currentProcessing) {
      processingCard.classList.remove('empty');
      processingCard.innerHTML = `
        <div class="processing-active">
          <div class="proc-header">
            <span class="dot-pulse"></span>
            <h4>${escapeHtml(data.currentProcessing.productName)}</h4>
          </div>
          <p class="proc-status">${escapeHtml(data.currentProcessing.status)}</p>
          <div class="progress-bar mt-3">
            <div class="progress-fill animating"></div>
          </div>
        </div>
      `;
    } else {
      processingCard.classList.add('empty');
      processingCard.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">☕</div>
          <h4>Hệ thống đang sẵn sàng</h4>
          <p>Tự động quét hàng đợi Google Sheets theo lịch hoặc tạo trực tiếp từ Studio.</p>
          <button class="btn btn-primary btn-sm" onclick="switchTab('studio')">Mở Studio Tạo Video</button>
        </div>
      `;
    }

    // 4. Cập nhật trạng thái TikTok Engine
    fetchTikTokConfig();
  } catch (err) {
    console.error('Lỗi lấy status:', err);
  }
}

// SCHEDULE CONTROLLER ACTIONS
async function toggleSchedule() {
  try {
    const res = await fetch(`${API_BASE}/api/schedule/toggle`, { method: 'POST' });
    const data = await res.json();
    fetchStatus();
    fetchLogs();
  } catch (err) {
    alert('Không kết nối được server để bật/tắt lịch: ' + err.message);
  }
}

// Bật / tắt từ Header
btnToggleWorker.addEventListener('click', toggleSchedule);

async function updateScheduleInterval() {
  const sel = document.getElementById('scheduleIntervalSelect');
  if (!sel) return;
  const intervalSeconds = parseInt(sel.value, 10);
  try {
    await fetch(`${API_BASE}/api/schedule/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalSeconds })
    });
    fetchStatus();
  } catch (err) {
    console.error('Lỗi đổi chu kỳ quét:', err);
  }
}

async function updateScheduleContinuous() {
  const cb = document.getElementById('scheduleContinuous');
  if (!cb) return;
  const continuous = cb.checked;
  try {
    await fetch(`${API_BASE}/api/schedule/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ continuous })
    });
    fetchStatus();
  } catch (err) {
    console.error('Lỗi đổi chế độ continuous:', err);
  }
}

async function triggerRunNow() {
  try {
    const res = await fetch(`${API_BASE}/api/schedule/run-now`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.message || 'Lỗi khi kích hoạt quét ngay.');
      return;
    }
    fetchStatus();
    switchTab('logs');
  } catch (err) {
    alert('Không thể kích hoạt quét: ' + err.message);
  }
}

async function saveScheduleConfigFromSettings() {
  const intervalSeconds = parseInt(document.getElementById('settingsScheduleInterval')?.value || '60', 10);
  const continuous = !!document.getElementById('settingsScheduleContinuous')?.checked;
  const timeRangeEnabled = !!document.getElementById('settingsScheduleTimeRange')?.checked;
  const startHour = parseInt(document.getElementById('settingsStartHour')?.value || '8', 10);
  const endHour = parseInt(document.getElementById('settingsEndHour')?.value || '22', 10);

  try {
    await fetch(`${API_BASE}/api/schedule/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalSeconds, continuous, timeRangeEnabled, startHour, endHour })
    });
    fetchStatus();
  } catch (err) {
    console.error('Lỗi lưu cấu hình Schedule từ cài đặt:', err);
  }
}

function toggleTimeRangeInputs() {
  const cb = document.getElementById('settingsScheduleTimeRange');
  const box = document.getElementById('settingsTimeRangeInputs');
  if (cb && box) {
    box.style.display = cb.checked ? 'flex' : 'none';
  }
}

// 3. FETCH LOGS
async function fetchLogs() {
  try {
    const res = await fetch(`${API_BASE}/api/logs`);
    const logs = await res.json();

    if (!logs || logs.length === 0) return;

    // Cập nhật terminal logs
    if (terminalLogBody) {
      terminalLogBody.innerHTML = logs.map(l => `
        <div class="log-line ${l.level}">
          <span class="log-time">[${l.time}]</span>
          <strong>[${l.level.toUpperCase()}]</strong> ${escapeHtml(l.message)}
        </div>
      `).join('');
    }

    // Cập nhật mini logs (top 5)
    if (miniLogsList) {
      miniLogsList.innerHTML = logs.slice(0, 5).map(l => `
        <div class="log-line ${l.level}">
          <span class="log-time">${l.time}</span> ${escapeHtml(l.message)}
        </div>
      `).join('');
    }
  } catch (err) {
    console.error('Lỗi logs:', err);
  }
}

function clearLogs() {
  if (terminalLogBody) terminalLogBody.innerHTML = '<div class="text-muted">Đã xóa màn hình nhật ký.</div>';
}

// 4. AI SUGGEST SCRIPT
btnSuggestAI.addEventListener('click', async () => {
  const name = inputProductName.value.trim();
  if (!name) {
    alert('Vui lòng nhập tên sản phẩm trước khi tạo kịch bản!');
    inputProductName.focus();
    return;
  }

  btnSuggestAI.disabled = true;
  btnSuggestAI.innerHTML = '<span>⏳ Đang viết kịch bản...</span>';

  try {
    const res = await fetch(`${API_BASE}/api/ai/suggest-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productName: name })
    });
    const data = await res.json();

    if (data.success && data.script) {
      inputScript.value = data.script;
    }
  } catch (err) {
    alert('Lỗi tạo kịch bản: ' + err.message);
  } finally {
    btnSuggestAI.disabled = false;
    btnSuggestAI.innerHTML = '<span>✨ AI Viết Kịch Bản</span>';
  }
});

// 5. CREATE VIDEO SUBMISSION & STEPPER ANIMATION
createVideoForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = inputProductName.value.trim();
  const script = inputScript.value.trim();
  const ratio = document.querySelector('input[name="ratio"]:checked')?.value || '9:16';
  const duration = document.querySelector('input[name="duration"]:checked')?.value || '10s';

  if (!name) return;

  btnSubmitCreate.disabled = true;
  btnSubmitCreate.innerHTML = '<span>⏳ Đang khởi tạo...</span>';
  animateStepper(1);

  try {
    const res = await fetch(`${API_BASE}/api/create-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productName: name, script, ratio, duration })
    });
    const data = await res.json();

    if (data.success) {
      animateStepper(2);
      fetchStatus();
      alert('Đã gửi lệnh tạo video tới Google Vids! Bạn có thể xem tiến trình trực tiếp trong tab Nhật ký.');
    } else {
      alert('Lỗi: ' + data.error);
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ: ' + err.message);
  } finally {
    btnSubmitCreate.disabled = false;
    btnSubmitCreate.innerHTML = '<span class="btn-icon">⚡</span><span>Bắt đầu tạo video ngay (0 Credit)</span>';
  }
});

function animateStepper(activeStep) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`step-${i}`);
    if (!el) continue;
    if (i <= activeStep) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  }
}

function getSvgBadge(text) {
  const bg = text === 'MA' ? '%231e293b' : (text === 'BG' ? '%230f172a' : '%231f293d');
  const color = text === 'MA' ? '%23818cf8' : (text === 'BG' ? '%2338bdf8' : '%23ffffff');
  return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" rx="8" fill="${bg}" stroke="rgba(255,255,255,0.15)" stroke-width="1.5"/><text x="50%" y="54%" font-family="sans-serif" font-weight="700" font-size="14" fill="${color}" dominant-baseline="middle" text-anchor="middle">${text}</text></svg>`;
}

function formatImageUrl(url, fallbackText = 'IMG') {
  if (!url || typeof url !== 'string' || !url.trim()) {
    return getSvgBadge(fallbackText);
  }
  const u = url.trim();
  if (u.includes('drive.google.com')) {
    return `${API_BASE}/api/drive/image?url=${encodeURIComponent(u)}`;
  }
  return u;
}

// 6. FETCH QUEUE (GOOGLE SHEETS)
async function fetchQueue() {
  if (!queueTableBody) return;
  queueTableBody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">Đang tải hàng đợi...</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/api/queue`);
    const data = await res.json();

    if (!data.items || data.items.length === 0) {
      queueTableBody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">Không có hàng nào đang chờ tạo.</td></tr>';
      return;
    }

    window._queueItems = {};
    data.items.forEach(item => {
      window._queueItems[item.rowNumber] = item;
    });

    queueTableBody.innerHTML = data.items.map(item => `
      <tr>
        <td><strong>#${item.rowNumber}</strong></td>
        <td><strong>${escapeHtml(item['Tên Sản Phẩm'] || '')}</strong></td>
        <td><div class="line-clamp-2">${escapeHtml(item['Content Video'] || 'Review chi tiết')}</div></td>
        <td style="white-space: nowrap;">
          <div class="thumb-stack" style="display: flex; gap: 8px; align-items: center;">
            <img src="${formatImageUrl(item['Link Sản Phẩm'], 'SP')}" class="tiny-thumb" title="Ảnh sản phẩm" style="width: 48px; height: 48px; min-width: 48px; min-height: 48px; max-width: 48px; max-height: 48px; object-fit: cover; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); display: inline-block;" onerror="this.onerror=null; this.src=getSvgBadge('SP');">
            <img src="${formatImageUrl(item['Link Mẫu Ảnh'], 'MA')}" class="tiny-thumb" title="Mẫu ảnh" style="width: 48px; height: 48px; min-width: 48px; min-height: 48px; max-width: 48px; max-height: 48px; object-fit: cover; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); display: inline-block;" onerror="this.onerror=null; this.src=getSvgBadge('MA');">
            ${item['Link Background'] ? `<img src="${formatImageUrl(item['Link Background'], 'BG')}" class="tiny-thumb" title="Ảnh nền / Background" style="width: 48px; height: 48px; min-width: 48px; min-height: 48px; max-width: 48px; max-height: 48px; object-fit: cover; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); display: inline-block;" onerror="this.onerror=null; this.src=getSvgBadge('BG');">` : ''}
          </div>
        </td>
        <td>
          <span class="status-badge ${getStatusClass(item['Trạng Thái'])}">
            ${item['Trạng Thái'] || 'Chờ Tạo'}
          </span>
        </td>
        <td>
          <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
            <button class="btn btn-primary btn-sm" onclick="runSingleQueueDirect(${item.rowNumber})" title="Chạy luồng tạo video đầy đủ: Render -> Drive -> Sheet -> Telegram">
              ▶ Chạy WF
            </button>
            <button class="btn btn-ghost btn-sm" onclick="runSingleQueue(${item.rowNumber})" title="Mở kịch bản trong Studio">
              Sửa
            </button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    queueTableBody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-danger">Lỗi tải dữ liệu: ${err.message}</td></tr>`;
  }
}

// 6b. FETCH TIKTOK QUEUE (các hàng đã có video, trang riêng "Đăng TikTok")
async function fetchTikTokQueue() {
  if (!tiktokQueueTableBody) return;
  tiktokQueueTableBody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">Đang tải danh sách video...</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/api/tiktok/queue`);
    const data = await res.json();

    if (sidebarTikTokCount) sidebarTikTokCount.textContent = (data.items || []).length;

    const filterEl = document.getElementById('tiktokStatusFilter');
    const filterValue = filterEl ? filterEl.value : 'cho_dang';
    const allItems = data.items || [];
    const filteredItems = allItems.filter(item => {
      const s = (item['Trạng Thái upload'] || '').toLowerCase();
      const posted = s.includes('đã đăng') || s.includes('thành công');
      const pending = s.includes('chờ đăng');
      if (filterValue === 'cho_dang') return pending;
      if (filterValue === 'da_dang') return posted;
      return true; // 'all'
    });

    if (allItems.length === 0) {
      tiktokQueueTableBody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">Chưa có video nào đã tạo xong để đăng.</td></tr>';
      return;
    }
    if (filteredItems.length === 0) {
      tiktokQueueTableBody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">Không có video nào khớp bộ lọc hiện tại.</td></tr>';
      return;
    }

    window._tiktokItems = {};
    allItems.forEach(item => {
      window._tiktokItems[item.rowNumber] = item;
    });

    tiktokQueueTableBody.innerHTML = filteredItems.map(item => {
      const uploadStatus = (item['Trạng Thái upload'] || '').toLowerCase();
      const alreadyPosted = uploadStatus.includes('đã đăng') || uploadStatus.includes('thành công');
      return `
      <tr>
        <td><strong>#${item.rowNumber}</strong></td>
        <td><strong>${escapeHtml(item['Tên Sản Phẩm'] || '')}</strong></td>
        <td>
          <a href="${escapeHtml(item['Link Video'] || '#')}" target="_blank" class="btn btn-ghost btn-sm" style="text-decoration: none;">▶ Xem video</a>
        </td>
        <td>${item['ID Sản Phẩm'] ? escapeHtml(item['ID Sản Phẩm']) : '<span class="text-muted">(Không có)</span>'}</td>
        <td>${getUploadStatusBadge(item['Trạng Thái upload'])}</td>
        <td>
          <button class="btn ${alreadyPosted ? 'btn-ghost' : 'btn-secondary'} btn-sm" onclick="publishTikTok(${item.rowNumber})" title="Đăng video này lên kênh TikTok" style="white-space: nowrap;">
            ${alreadyPosted ? '🔁 Đăng lại' : '📱 Đăng TikTok'}
          </button>
        </td>
      </tr>
    `;
    }).join('');
  } catch (err) {
    tiktokQueueTableBody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-danger">Lỗi tải dữ liệu: ${err.message}</td></tr>`;
  }
}

function getStatusClass(status) {
  if (!status) return 'queue';
  const s = status.toLowerCase();
  if (s.includes('thành công') || s.includes('done')) return 'success';
  if (s.includes('lỗi') || s.includes('error')) return 'error';
  return 'queue';
}

function getUploadStatusBadge(status) {
  if (!status) {
    return `<span class="status-badge" style="background: rgba(255,255,255,0.06); color: #94a3b8; border: 1px solid rgba(255,255,255,0.1);">Chưa Đăng</span>`;
  }
  const s = status.toLowerCase();
  if (s.includes('đã đăng') || s.includes('thành công')) {
    return `<span class="status-badge success" style="background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4);">✓ Đã Đăng</span>`;
  }
  if (s.includes('chờ đăng')) {
    return `<span class="status-badge queue" style="background: rgba(245, 158, 11, 0.2); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.4);">⏳ Chờ Đăng</span>`;
  }
  if (s.includes('lỗi')) {
    return `<span class="status-badge error">❌ ${escapeHtml(status)}</span>`;
  }
  return `<span class="status-badge queue">${escapeHtml(status)}</span>`;
}

async function publishTikTok(rowNumber) {
  const row = (window._tiktokItems && window._tiktokItems[rowNumber])
    || (window._queueItems && window._queueItems[rowNumber])
    || null;
  if (!row) {
    alert(`Không tìm thấy dữ liệu hàng #${rowNumber}. Vui lòng làm mới trang.`);
    return;
  }

  const productName = row['Tên Sản Phẩm'] || `Hàng #${rowNumber}`;
  const productId = row['ID Sản Phẩm'];
  const hasVideo = !!row['Link Video'];

  if (!hasVideo) {
    alert(`Hàng #${rowNumber} chưa có video thành phẩm trên Google Drive. Vui lòng bấm "▶ Chạy WF" để tạo video trước!`);
    return;
  }

  const confirmMsg = `Xác nhận đăng trực tiếp lên kênh TikTok cho hàng #${rowNumber}?\n\n• Sản phẩm: ${productName}\n• Giỏ hàng TikTok Shop: ${productId ? `ID: ${productId}` : '(Không có ID sản phẩm)'}\n• Động cơ: Tích hợp trực tiếp (không qua n8n)`;
  if (!confirm(confirmMsg)) {
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/tiktok/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowNumber, row })
    });
    const data = await res.json();
    if (data.success) {
      alert(`Đã gửi lệnh đăng TikTok cho hàng #${rowNumber}!\nBạn có thể theo dõi tiến trình trong tab Nhật ký.`);
      switchTab('logs');
      fetchQueue();
      fetchTikTokQueue();
    } else {
      alert('Lỗi: ' + (data.error || 'Không thể đăng'));
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ: ' + err.message);
  }
}

function toggleTikTokSessionVisibility() {
  const textarea = document.getElementById('tiktokSessionInput');
  const masked = document.getElementById('tiktokSessionMasked');
  if (!textarea || !masked) return;
  if (textarea.style.display === 'none') {
    textarea.style.display = 'block';
    masked.style.display = 'none';
    textarea.focus();
  } else {
    textarea.style.display = 'none';
    masked.style.display = 'block';
  }
}

async function fetchTikTokConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/tiktok/config`);
    const data = await res.json();

    const dot = document.getElementById('tiktokEngineDot');
    const statusText = document.getElementById('tiktokEngineStatusText');
    const placeholderText = document.getElementById('tiktokSessionPlaceholderText');
    const proxyInput = document.getElementById('tiktokProxyInput');
    const autoCheck = document.getElementById('tiktokAutoPublishCheck');

    if (dot && statusText) {
      if (data.configured) {
        dot.className = 'status-indicator online';
        statusText.textContent = 'Trạng thái: Đã kết nối Session TikTok (Sẵn sàng đăng)';
      } else {
        dot.className = 'status-indicator offline';
        statusText.textContent = 'Trạng thái: Chưa cấu hình TikTok Session';
      }
    }

    if (placeholderText) {
      if (data.configured) {
        placeholderText.textContent = '🔒 Đã cấu hình TikTok Session hợp lệ. Bấm "Hiện/Ẩn" nếu bạn muốn thay session mới.';
      } else {
        placeholderText.textContent = 'Chưa có session được lưu. Bấm "Hiện/Ẩn" để dán session mới.';
      }
    }

    if (proxyInput && !proxyInput.matches(':focus')) {
      proxyInput.value = data.proxyUrl || '';
    }

    if (autoCheck) {
      autoCheck.checked = !!data.autoPublish;
    }
  } catch (err) {
    console.error('Lỗi lấy cấu hình TikTok:', err);
  }
}

async function saveTikTokConfig() {
  const sessionInput = document.getElementById('tiktokSessionInput');
  const proxyInput = document.getElementById('tiktokProxyInput');
  const autoCheck = document.getElementById('tiktokAutoPublishCheck');

  const sessionJson = sessionInput ? sessionInput.value.trim() : '';
  const proxyUrl = proxyInput ? proxyInput.value.trim() : '';
  const autoPublish = autoCheck ? autoCheck.checked : false;

  const payload = { proxyUrl, autoPublish };
  if (sessionJson) {
    let isValid = false;
    try {
      JSON.parse(sessionJson);
      isValid = true;
    } catch (e) {
      try {
        const decoded = atob(sessionJson);
        JSON.parse(decoded);
        isValid = true;
      } catch (e2) {}
    }

    if (!isValid) {
      alert('Định dạng TikTok Session không hợp lệ! Vui lòng dán chuỗi JSON hoặc chuỗi Base64 hợp lệ (từ tiện ích Cookie/Session TikTok).');
      return;
    }
    payload.sessionJson = sessionJson;
  }

  try {
    const res = await fetch(`${API_BASE}/api/tiktok/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      alert('Đã lưu cấu hình TikTok Engine thành công!');
      if (sessionInput) sessionInput.value = '';
      toggleTikTokSessionVisibility();
      fetchTikTokConfig();
    } else {
      alert('Lỗi lưu cấu hình: ' + (data.error || 'Thất bại'));
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ: ' + err.message);
  }
}

async function runSingleQueueDirect(rowNumber) {
  const row = (window._queueItems && window._queueItems[rowNumber]) || null;
  if (!row) {
    alert(`Không tìm thấy dữ liệu hàng #${rowNumber}. Vui lòng làm mới trang.`);
    return;
  }

  if (!confirm(`Bạn có muốn xử lý tự động ngay cho hàng #${row.rowNumber} ("${row['Tên Sản Phẩm']}")?\n\nLuồng sẽ tự động:\n1. Sinh 2 clip Google Vids (kịch bản nối tiếp & 3 ảnh tham chiếu)\n2. Ghép FFmpeg thành video ~20s gắn logo\n3. Tải lên Google Drive\n4. Cập nhật Google Sheet\n5. Báo tin Telegram`)) return;

  try {
    const res = await fetch(`${API_BASE}/api/queue/run-item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ row })
    });
    const data = await res.json();
    switchTab('logs');
  } catch (err) {
    alert('Lỗi: ' + err.message);
  }
}

function runSingleQueue(rowNumber) {
  const row = (window._queueItems && window._queueItems[rowNumber]) || null;
  if (!row) return;
  inputProductName.value = row['Tên Sản Phẩm'] || '';
  inputScript.value = row['Content Video'] || '';
  switchTab('studio');
}

// 7. VIDEO GALLERY (LẤY TỪ GOOGLE DRIVE)
async function fetchVideos() {
  try {
    const res = await fetch(`${API_BASE}/api/videos`);
    const data = await res.json();
    const videos = Array.isArray(data) ? data : (data.list || []);

    if (sidebarVideoCount) sidebarVideoCount.textContent = videos.length;
    if (galleryCountTag) galleryCountTag.textContent = `${videos.length} video trên Drive`;

    if (!videoGalleryGrid) return;

    if (videos.length === 0) {
      videoGalleryGrid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="empty-icon">☁️</div>
          <h4>Chưa có video nào trên Google Drive</h4>
          <p>Thư mục Google Drive (Video-Veo3) hiện chưa có video thành phẩm hoặc chưa tải xong.</p>
        </div>
      `;
      return;
    }

    videoGalleryGrid.innerHTML = videos.map(v => `
      <div class="video-card">
        <div class="video-thumb-container" onclick="openVideoModal('${v.url}', '${escapeHtml(v.filename)}', '${v.driveUrl || ''}')">
          ${v.thumbnail ? 
            `<img src="${v.thumbnail}" class="video-thumb-img" alt="${escapeHtml(v.filename)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
             <video src="${v.url}#t=0.5" preload="metadata" style="display: none;"></video>` :
            `<video src="${v.url}#t=0.5" preload="metadata"></video>`
          }
          <div class="play-overlay">▶</div>
          <span class="drive-badge" title="Lưu trữ trên Google Drive">☁️ Drive</span>
        </div>
        <div class="video-card-body">
          <div class="video-filename" title="${escapeHtml(v.filename)}">${escapeHtml(v.filename)}</div>
          <div class="video-meta">${v.size} &bull; ${v.createdAt}</div>
          <div class="video-actions" style="margin-top: 8px; display: flex; gap: 8px;">
            <button class="btn btn-primary btn-sm" style="flex: 1; padding: 4px 8px; font-size: 11px;" onclick="openVideoModal('${v.url}', '${escapeHtml(v.filename)}', '${v.driveUrl || ''}')">
              ▶ Phát Video
            </button>
            <a href="${v.driveUrl || '#'}" target="_blank" class="btn btn-secondary btn-sm" style="padding: 4px 8px; font-size: 11px; text-decoration: none;" title="Mở trên Google Drive">
              ☁️ Drive
            </a>
          </div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Lỗi gallery:', err);
  }
}

function openVideoModal(url, title, driveUrl) {
  if (!videoModal || !modalVideoPlayer) return;
  modalVideoPlayer.src = url;
  modalVideoTitle.textContent = title;

  const cleanTitle = (title || 'video').trim();
  const downloadFileName = cleanTitle.endsWith('.mp4') ? cleanTitle : `${cleanTitle}.mp4`;
  btnDownloadVideo.href = url;
  btnDownloadVideo.setAttribute('download', downloadFileName);

  const driveBtn = document.getElementById('btnDriveOpenVideo');
  if (driveBtn) {
    if (driveUrl) {
      driveBtn.href = driveUrl;
      driveBtn.style.display = 'inline-flex';
    } else {
      driveBtn.style.display = 'none';
    }
  }
  videoModal.classList.add('active');
  modalVideoPlayer.play().catch(() => {});
}

function closeVideoModal() {
  if (!videoModal || !modalVideoPlayer) return;
  modalVideoPlayer.pause();
  modalVideoPlayer.src = '';
  videoModal.classList.remove('active');
}

// 8. CHROME LOGIN ACTION
btnOpenChrome.addEventListener('click', openChromeLogin);

async function openChromeLogin() {
  try {
    alert('Đang mở trình duyệt Chrome trên máy tính của bạn...\nVui lòng đăng nhập tài khoản Google Ultra nếu chưa đăng nhập.');
    await fetch(`${API_BASE}/api/chrome/login`, { method: 'POST' });
  } catch (err) {
    alert('Lỗi: ' + err.message);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 9. GOOGLE DRIVE OAUTH ACTIONS
async function connectGoogleDrive() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/google/url`);
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      switchTab('settings');
      const form = document.getElementById('driveOAuthConfigForm');
      if (form) form.style.display = 'block';
      const clientId = document.getElementById('oauthClientId');
      if (clientId) clientId.focus();
    }
  } catch (err) {
    switchTab('settings');
    const form = document.getElementById('driveOAuthConfigForm');
    if (form) form.style.display = 'block';
  }
}

async function saveOAuthConfigAndLogin() {
  const clientId = document.getElementById('oauthClientId').value.trim();
  const clientSecret = document.getElementById('oauthClientSecret').value.trim();
  if (!clientId || !clientSecret) {
    alert('Vui lòng nhập cả Google OAuth Client ID và Client Secret.');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/google/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi lưu cấu hình');

    connectGoogleDrive();
  } catch (err) {
    alert('Lỗi: ' + err.message);
  }
}

async function disconnectGoogleDrive() {
  if (!confirm('Bạn có chắc muốn ngắt kết nối Google Drive?')) return;
  try {
    await fetch(`${API_BASE}/api/auth/google/disconnect`, { method: 'POST' });
    fetchStatus();
  } catch (err) {
    alert('Lỗi: ' + err.message);
  }
}
