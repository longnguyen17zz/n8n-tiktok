import puppeteer from 'puppeteer-core';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA_DIR = path.resolve('chrome_profile');

async function login() {
  console.log('🌐 Đang mở trình duyệt Chrome để bạn đăng nhập tài khoản Google Ultra...');
  console.log('📌 Vui lòng đăng nhập trên cửa sổ Chrome vừa mở ra.');
  console.log('💡 Phiên đăng nhập sẽ được lưu tự động vĩnh viễn trong thư mục chrome_profile (chỉ cần làm 1 lần).');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: USER_DATA_DIR,
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  });

  const page = await browser.newPage();
  await page.goto('https://vids.new');

  console.log('\n👉 Sau khi bạn đã đăng nhập và vào được giao diện Google Vids, bạn có thể đóng cửa sổ Chrome lại.');
}

login().catch(console.error);
