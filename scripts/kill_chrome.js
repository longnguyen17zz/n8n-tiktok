import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);

export async function killStaleChromeProfile() {
  try {
    const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name = 'chrome.exe'\\" | Where-Object CommandLine -like '*chrome_profile*' | Stop-Process -Force -ErrorAction SilentlyContinue"`;
    await execPromise(cmd);
    console.log('Cleaned up any lingering chrome_profile processes.');
  } catch (e) {
    // ignore
  }
}

if (process.argv[1].endsWith('kill_chrome.js')) {
  killStaleChromeProfile();
}
