# Makes Atlas start automatically at logon and puts a shortcut on the
# Desktop, so the person using it never opens a terminal.
#
# Deliberately a Scheduled Task at logon rather than a Windows Service:
#  - A service runs as SYSTEM, which cannot see the user's mapped drives,
#    OneDrive folder, or iCloud folder -- exactly the places the documents
#    live. Running at logon as the user is what makes those paths reachable.
#  - It needs no extra dependency (no NSSM, no node-windows).
#
# Usage (normal PowerShell, no admin needed):
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove

param([switch]$Remove)

$ErrorActionPreference = "Stop"

$TaskName = "Atlas Document Platform"
$Root     = Split-Path -Parent $PSScriptRoot
$StartBat = Join-Path $Root "scripts\start-atlas.bat"
$Desktop  = [Environment]::GetFolderPath("Desktop")
$Shortcut = Join-Path $Desktop "Atlas Documents.url"

if ($Remove) {
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "Removed the scheduled task." }
    catch { Write-Host "No scheduled task to remove." }
    if (Test-Path $Shortcut) { Remove-Item $Shortcut; Write-Host "Removed the desktop shortcut." }
    return
}

if (-not (Test-Path $StartBat)) { throw "Cannot find $StartBat" }

# Warn rather than fail: the app still runs, it just serves the dev-server
# message instead of the UI until the frontend is built.
$Dist = Join-Path $Root "frontend\dist\index.html"
if (-not (Test-Path $Dist)) {
    Write-Warning "frontend\dist not found -- run 'npm run build' in frontend\ so the API can serve the UI."
}

# -WindowStyle Hidden on the action keeps the console from flashing at logon.
$action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$StartBat`"" -WorkingDirectory $Root
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' (runs at logon as $env:USERNAME)."

# A .url shortcut rather than a .lnk: it opens in the default browser with
# no console window and needs no target executable path.
@"
[InternetShortcut]
URL=http://localhost:5000
IconIndex=0
"@ | Set-Content -Path $Shortcut -Encoding ASCII

Write-Host "Created desktop shortcut: $Shortcut"
Write-Host ""
Write-Host "Start it now without rebooting:  $StartBat"
Write-Host "Then open:                       http://localhost:5000"
