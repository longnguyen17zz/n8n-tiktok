@echo off
title Ket Noi Chrome Profile 23 - Google Ultra
echo =======================================================
echo    DANG KHOI CHAY CHROME PROFILE 23 CHO TOOL VIDEO
echo =======================================================
echo.
echo 1. Dang dong cac tien trinh Chrome cu de mo cong ket noi...
taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo 2. Dang mo Chrome Profile 23 voi cong ket noi 9224...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9224 --remote-allow-origins=* --user-data-dir="C:\Users\ADMIN\AppData\Local\Google\Chrome\User Data" --profile-directory="Profile 23" "https://vids.new"

echo.
echo =======================================================
echo [OK] Chrome Profile 23 da duoc mo thanh cong tren man hinh!
echo Ban co the vao: http://localhost:3000/#queue va bam Chay WF!
echo =======================================================
pause
