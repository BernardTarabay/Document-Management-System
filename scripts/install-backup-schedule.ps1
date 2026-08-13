# Schedules the nightly database backup.
#
# Runs at logon-independent times via Task Scheduler, with StartWhenAvailable
# so a machine that was asleep at 02:00 still takes its backup once it wakes
# -- a laptop that is off overnight would otherwise simply never back up.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-backup-schedule.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-backup-schedule.ps1 -Remove
#   powershell -ExecutionPolicy Bypass -File scripts\install-backup-schedule.ps1 -At 23:30

param(
    [switch]$Remove,
    [string]$At = "02:00"
)

$ErrorActionPreference = "Stop"

$TaskName = "Atlas Database Backup"
$Root = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $Root "scripts\backup-database.ps1"

if ($Remove) {
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "Removed '$TaskName'." }
    catch { Write-Host "No such scheduled task." }
    return
}

if (-not (Test-Path $Script)) { throw "Cannot find $Script" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`"" `
    -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -Daily -At $At

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -Hidden

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Scheduled '$TaskName' daily at $At."
Write-Host "Backups:  $(Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Atlas Backups')"
Write-Host "Run now:  powershell -ExecutionPolicy Bypass -File scripts\backup-database.ps1"
Write-Host "Test it:  powershell -ExecutionPolicy Bypass -File scripts\verify-backup-restore.ps1"
