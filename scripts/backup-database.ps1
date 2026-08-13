# Nightly backup of the Atlas database.
#
# WHY THIS EXISTS
#
# The design guarantees the user's FILES are safe -- they are read in place
# and never modified. But everything the app ADDS lives only in Postgres:
# canonical names, subject classifications, AI titles and summaries,
# extracted text, duplicate groups, the audit trail. Lose the database and
# you keep every document and lose the entire product. Re-deriving it means
# re-reading and re-classifying everything, which is days of processing and
# real API spend.
#
# Uses pg_dump's custom format (-Fc): compressed, and restorable
# selectively with pg_restore rather than all-or-nothing.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\backup-database.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\backup-database.ps1 -KeepDays 30

param(
    [int]$KeepDays = 14,
    [string]$BackupDir
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot

# Default into Documents, which on this machine is OneDrive-synced -- that
# makes the backup offsite for free. A backup sitting on the same disk as
# the database protects against a bad migration but not a dead drive.
if (-not $BackupDir) {
    $BackupDir = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Atlas Backups"
}

# pg_dump must be at least the server's version -- an older one refuses to
# dump a newer server. Prefer the highest installed.
$PgDump = Get-ChildItem "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "bin\pg_dump.exe" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1

if (-not $PgDump) { throw "pg_dump.exe not found under C:\Program Files\PostgreSQL" }

# Read the connection string from backend\.env rather than duplicating
# credentials here -- one place to change, and nothing secret in this file
# or in the scheduled task's arguments.
#
# Parsed directly instead of shelling out to node + dotenv: a backup must
# still work when the app itself is broken, and "node_modules is missing"
# is exactly the kind of morning where you want yesterday's dump.
$EnvFile = Join-Path $Root "backend\.env"
if (-not (Test-Path $EnvFile)) { throw "Cannot find $EnvFile" }

$DbUrl = $null
foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*DATABASE_URL\s*=\s*(.+?)\s*$') {
        # Strip surrounding quotes if present.
        $DbUrl = $Matches[1] -replace '^"(.*)"$', '$1' -replace "^'(.*)'$", '$1'
        break
    }
}
if (-not $DbUrl) { throw "No DATABASE_URL found in $EnvFile" }

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$stamp  = Get-Date -Format "yyyy-MM-dd_HHmm"
$target = Join-Path $BackupDir "atlas_$stamp.dump"

# --no-owner / --no-acl so the dump restores cleanly onto a fresh install
# where the role names may differ.
& $PgDump --format=custom --no-owner --no-acl --file="$target" "$DbUrl"
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

$size = [math]::Round((Get-Item $target).Length / 1MB, 2)
Write-Host "Backed up to $target ($size MB)"

# Prune old dumps. Only ever touches files matching our own naming pattern,
# so anything else the user has put in this folder is left alone.
$cutoff = (Get-Date).AddDays(-$KeepDays)
$old = Get-ChildItem $BackupDir -Filter "atlas_*.dump" | Where-Object { $_.LastWriteTime -lt $cutoff }
foreach ($f in $old) {
    Remove-Item $f.FullName
    Write-Host "Pruned $($f.Name)"
}

$kept = (Get-ChildItem $BackupDir -Filter "atlas_*.dump").Count
Write-Host "$kept backup(s) retained in $BackupDir (keeping $KeepDays days)"
