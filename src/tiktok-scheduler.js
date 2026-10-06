import fs from 'fs';
import path from 'path';
import { runTikTokWorker } from './index.js';

// Khung giờ đăng cố định trong ngày (giờ Việt Nam, UTC+7). Sửa ở đây nếu cần đổi khung giờ.
export const POST_HOURS_VN = [7, 11, 17, 23];

// File trạng thái lưu lại khung giờ (ngày + giờ) vừa đăng gần nhất, để GitHub Actions — vốn chạy
// container RIÊNG BIỆT mỗi lần, không nhớ gì giữa các lần chạy — biết là khung giờ hôm nay đã xử lý
// rồi hay chưa. Nếu không có file này, mỗi lần cron bắn trong cùng 1 khung giờ (chạy lặp vài lần để
// tăng cơ hội trúng đúng giờ dù GitHub Actions có thể trễ) sẽ đăng NHIỀU video khác nhau thay vì chỉ 1.
const STATE_FILE = path.resolve('.tiktok-schedule-state.json');

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (e) {
    return { lastPostedKey: null };
  }
}

export function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Quy đổi 1 thời điểm (Date, theo epoch UTC thật) sang giờ Việt Nam (UTC+7) không phụ thuộc
// timezone của máy chạy — runner GitHub Actions mặc định chạy UTC nên cộng thẳng 7 tiếng là ra
// đúng giờ VN theo lịch, bất kể hệ thống đang đặt timezone gì.
export function toVnParts(date) {
  const vn = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return {
    hour: vn.getUTCHours(),
    minute: vn.getUTCMinutes(),
    dateStr: `${vn.getUTCFullYear()}-${pad2(vn.getUTCMonth() + 1)}-${pad2(vn.getUTCDate())}`
  };
}

export function slotKeyFor(date) {
  const { hour, dateStr } = toVnParts(date);
  return `${dateStr}-${pad2(hour)}`;
}

/**
 * Quyết định có nên đăng tại thời điểm `date` hay không, dựa trên khung giờ cấu hình và trạng thái
 * đã lưu — KHÔNG gọi bất kỳ hành động đăng bài thật nào, chỉ tính toán thuần tuý nên an toàn để test.
 */
export function shouldPostNow(date, state) {
  const { hour, dateStr } = toVnParts(date);
  if (!POST_HOURS_VN.includes(hour)) {
    return { post: false, reason: `Giờ ${hour}h không thuộc khung giờ cấu hình (${POST_HOURS_VN.join(', ')})`, slotKey: null };
  }
  const slotKey = `${dateStr}-${pad2(hour)}`;
  if (state.lastPostedKey === slotKey) {
    return { post: false, reason: `Khung giờ ${slotKey} đã xử lý rồi`, slotKey };
  }
  return { post: true, reason: `Đúng khung giờ ${slotKey}, chưa xử lý`, slotKey };
}

async function main() {
  const now = new Date();
  const { hour, minute, dateStr } = toVnParts(now);
  const state = readState();
  const decision = shouldPostNow(now, state);

  console.log(`[TikTok Scheduler] Giờ VN hiện tại: ${dateStr} ${pad2(hour)}h${pad2(minute)} — Khung giờ cấu hình: ${POST_HOURS_VN.map(h => h + 'h').join(', ')}`);
  console.log(`[TikTok Scheduler] ${decision.reason}`);

  if (!decision.post) return;

  console.log(`[TikTok Scheduler] Đang đăng video cho khung giờ ${decision.slotKey}...`);
  const result = await runTikTokWorker((level, msg) => console.log(`[${level}] ${msg}`));

  // Đánh dấu đã xử lý khung giờ này DÙ CÓ ĐĂNG ĐƯỢC HAY KHÔNG (kể cả khi không có video nào đang
  // "Chờ Đăng") — tránh các lần chạy tiếp theo trong cùng khung giờ cứ quét đi quét lại vô ích.
  writeState({ lastPostedKey: decision.slotKey, lastRunAt: now.toISOString() });

  if (result) {
    console.log(`[TikTok Scheduler] ✅ Đã đăng xong 1 video cho khung giờ ${decision.slotKey}.`);
  } else {
    console.log(`[TikTok Scheduler] Không có video nào đang "Chờ Đăng" cho khung giờ ${decision.slotKey}.`);
  }
}

// Chỉ tự chạy main() khi file này được gọi trực tiếp (node src/tiktok-scheduler.js), KHÔNG chạy khi
// được import để test (import { shouldPostNow } ... từ script test sẽ không vô tình đăng bài thật).
import { fileURLToPath } from 'url';
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch(err => {
    console.error('[TikTok Scheduler] Lỗi:', err.message);
    process.exit(1);
  });
}
