$procs = Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" | Where-Object CommandLine -like "*chrome_profile*"
foreach ($p in $procs) {
    try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "Da dong tien trinh:" $p.ProcessId
    } catch {}
}
