@echo off
title Ket Noi Chrome Profile 1 - Tool Video
echo =======================================================
echo    DANG KHOI CHAY CHROME PROFILE 1 CHO TOOL VIDEO
echo =======================================================
echo.
echo 1. Dang dong cac tien trinh Chrome cu de mo cong ket noi...
taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo 2. Dang mo Chrome Profile 1 voi cong ket noi 9224...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9224 --remote-allow-origins=* --user-data-dir="C:\Users\ADMIN\AppData\Local\Google\Chrome\User Data" --profile-directory="Profile 1" "http://localhost:3000/#queue"

echo.
echo =======================================================
echo [OK] Chrome Profile 1 da duoc mo thanh cong tren man hinh!
echo Ban co the bam "Chay WF" ngay tren cua so vua mo len!
echo =======================================================
pause
