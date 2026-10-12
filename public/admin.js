// ========================================================
// TRANG QUẢN TRỊ LICENSE KEY (độc lập với SPA chính, bảo vệ bằng ADMIN_SECRET)
// ========================================================
const API_BASE = '';
const SECRET_STORAGE_KEY = 'videogen_admin_secret';

const unlockBox = document.getElementById('unlockBox');
const adminApp = document.getElementById('adminApp');
const adminSecretInput = document.getElementById('adminSecretInput');
const btnUnlock = document.getElementById('btnUnlock');
const unlockError = document.getElementById('unlockError');
const btnLockAgain = document.getElementById('btnLockAgain');
const createKeyForm = document.getElementById('createKeyForm');
const newKeyLabel = document.getElementById('newKeyLabel');
const newKeyPlan = document.getElementById('newKeyPlan');
const newKeyExpires = document.getElementById('newKeyExpires');
const newKeyResult = document.getElementById('newKeyResult');
const licenseTableBody = document.getElementById('licenseTableBody');

function getAdminSecret() {
  return sessionStorage.getItem(SECRET_STORAGE_KEY) || '';
}

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-Admin-Secret': getAdminSecret()
    }
  });
}

async function tryUnlock(secret) {
  sessionStorage.setItem(SECRET_STORAGE_KEY, secret);
  const res = await adminFetch('/api/admin/license-keys');
  if (!res.ok) {
    sessionStorage.removeItem(SECRET_STORAGE_KEY);
    throw new Error('Admin Secret không đúng.');
  }
  unlockBox.style.display = 'none';
  adminApp.style.display = 'block';
  await loadLicenseKeys();
}

btnUnlock.addEventListener('click', async () => {
  const secret = (adminSecretInput.value || '').trim();
  if (!secret) return;
  unlockError.style.display = 'none';
  try {
    await tryUnlock(secret);
  } catch (err) {
    unlockError.textContent = err.message;
    unlockError.style.display = 'block';
  }
});

adminSecretInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnUnlock.click();
});

btnLockAgain.addEventListener('click', () => {
  sessionStorage.removeItem(SECRET_STORAGE_KEY);
  window.location.reload();
});

async function loadLicenseKeys() {
  licenseTableBody.innerHTML = '<tr><td colspan="8">Đang tải...</td></tr>';
  try {
    const res = await adminFetch('/api/admin/license-keys');
    const data = await res.json();
    renderLicenseKeys(data.items || []);
  } catch (err) {
    licenseTableBody.innerHTML = `<tr><td colspan="8">Lỗi tải danh sách: ${err.message}</td></tr>`;
  }
}

function renderLicenseKeys(items) {
  if (items.length === 0) {
    licenseTableBody.innerHTML = '<tr><td colspan="8">Chưa có license key nào.</td></tr>';
    return;
  }

  licenseTableBody.innerHTML = items.map(item => `
    <tr>
      <td class="key-code">${item.keyCode}</td>
      <td>${item.label || '-'}</td>
      <td>${item.planLabel || '-'}</td>
      <td><span class="status-pill ${item.status}">${item.status === 'active' ? 'Hoạt động' : 'Đã thu hồi'}</span></td>
      <td>
        ${item.accountId
          ? `<button class="btn btn-sm ${item.canUseStudio ? 'btn-emerald' : 'btn-secondary'}" onclick="toggleStudioAccess(${item.accountId}, ${!item.canUseStudio})">${item.canUseStudio ? 'Đang BẬT' : 'Đang TẮT'}</button>`
          : '<span class="text-muted" style="font-size:0.8rem;">Chưa đăng nhập lần nào</span>'}
      </td>
      <td>${item.expiresAt ? new Date(item.expiresAt).toLocaleDateString('vi-VN') : 'Không hết hạn'}</td>
      <td>${new Date(item.createdAt).toLocaleDateString('vi-VN')}</td>
      <td>
        ${item.status === 'active'
          ? `<button class="btn btn-secondary btn-sm" onclick="revokeKey(${item.id})">Thu hồi</button>`
          : `<button class="btn btn-secondary btn-sm" onclick="reactivateKey(${item.id})">Kích hoạt lại</button>`}
      </td>
    </tr>
  `).join('');
}

async function toggleStudioAccess(accountId, enabled) {
  await adminFetch(`/api/admin/accounts/${accountId}/studio-access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled })
  });
  loadLicenseKeys();
}

async function revokeKey(id) {
  if (!confirm('Thu hồi license key này? Tài khoản đang đăng nhập bằng key này sẽ bị đăng xuất ngay.')) return;
  await adminFetch(`/api/admin/license-keys/${id}/revoke`, { method: 'POST' });
  loadLicenseKeys();
}

async function reactivateKey(id) {
  await adminFetch(`/api/admin/license-keys/${id}/reactivate`, { method: 'POST' });
  loadLicenseKeys();
}

createKeyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  newKeyResult.style.display = 'none';

  const label = newKeyLabel.value.trim();
  const planLabel = newKeyPlan.value.trim();
  const expiresAt = newKeyExpires.value ? new Date(newKeyExpires.value).toISOString() : null;

  try {
    const res = await adminFetch('/api/admin/license-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, planLabel, expiresAt })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Lỗi tạo key');

    newKeyResult.textContent = `✅ Key mới: ${data.license.keyCode} (đã tạo cho "${label || 'chưa đặt tên'}") — hãy copy gửi cho khách ngay, key không hiển thị lại.`;
    newKeyResult.style.display = 'block';
    createKeyForm.reset();
    loadLicenseKeys();
  } catch (err) {
    newKeyResult.textContent = `❌ ${err.message}`;
    newKeyResult.style.display = 'block';
  }
});

// Tự mở khoá luôn nếu đã có admin secret lưu trong phiên trình duyệt này
(async function autoUnlock() {
  const saved = getAdminSecret();
  if (!saved) return;
  try {
    await tryUnlock(saved);
  } catch (err) {
    // secret cũ không còn hợp lệ -> để màn hình nhập lại
  }
})();
