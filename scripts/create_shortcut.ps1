$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopPath "Chrome Profile 23 (Ket Noi Tool).lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$Shortcut.Arguments = '--remote-debugging-port=9224 --profile-directory="Profile 23"'
$Shortcut.IconLocation = "C:\Program Files\Google\Chrome\Application\chrome.exe,0"
$Shortcut.Description = "Chrome Profile 23 voi cong Debugging 9224 cho Tool Video"
$Shortcut.Save()
Write-Host "Da tao thanh cong Shortcut tai: $ShortcutPath"
