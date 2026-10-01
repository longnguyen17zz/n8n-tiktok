@echo off
title Dang Nhap Tai Khoan Google Ultra
echo =======================================================
echo    DANG NHAP TAI KHOAN GOOGLE ULTRA CHO TOOL
echo =======================================================
echo.
echo Dang mo trinh duyet Chrome tren man hinh...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%~dp0chrome_profile" "https://vids.new"
echo.
echo Cua so Chrome da mo tren man hinh!
echo Ban hay dang nhap tai khoan: trankaka024@gmail.com vao do nhe!
echo Sau khi dang nhap xong va thay giao dien Google Vids, ban co the dong lai.
echo.
pause
