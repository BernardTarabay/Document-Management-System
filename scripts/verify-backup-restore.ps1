# Proves the newest backup actually restores.
#
# An untested backup is not a backup -- it is a file you hope about. This
# restores the latest dump into a THROWAWAY database, counts what came
# back, and drops it again. It never touches the live database.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-backup-restore.ps1

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$BackupDir = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Atlas Backups"

$PgBin = Get-ChildItem "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
$PgRestore = Join-Path $PgBin "bin\pg_restore.exe"
$Psql      = Join-Path $PgBin "bin\psql.exe"

$latest = Get-ChildItem $BackupDir -Filter "atlas_*.dump" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $latest) { throw "No backups found in $BackupDir" }
Write-Host "Testing: $($latest.Name) ($([math]::Round($latest.Length/1MB,2)) MB)"

# Reuse the live credentials but point at a different database name.
$EnvFile = Join-Path $Root "backend\.env"
$DbUrl = $null
foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*DATABASE_URL\s*=\s*(.+?)\s*$') {
        $DbUrl = $Matches[1] -replace '^"(.*)"$', '$1' -replace "^'(.*)'$", '$1'; break
    }
}
$uri = [Uri]$DbUrl
$TestDb = "atlas_restore_test"
$adminUrl = "$($uri.Scheme)://$($uri.UserInfo)@$($uri.Host):$($uri.Port)/postgres"
$testUrl  = "$($uri.Scheme)://$($uri.UserInfo)@$($uri.Host):$($uri.Port)/$TestDb"

try {
    & $Psql "$adminUrl" -q -c "DROP DATABASE IF EXISTS $TestDb;" | Out-Null
    & $Psql "$adminUrl" -q -c "CREATE DATABASE $TestDb;" | Out-Null
    Write-Host "Created throwaway database '$TestDb'"

    # pg_restore reports non-fatal notices on stderr and can exit non-zero
    # for those alone, so the real check is the row counts below.
    & $PgRestore --dbname="$testUrl" --no-owner --no-acl "$($latest.FullName)" 2>$null

    Write-Host "`nRestored contents:"
    $tables = @("users", "storage_locations", "files", "file_content", "subjects",
                "rename_proposals", "classification_results", "duplicate_groups", "audit_logs")
    $failed = $false
    foreach ($t in $tables) {
        $n = (& $Psql "$testUrl" -t -A -c "SELECT count(*) FROM $t;" 2>$null)
        if ($LASTEXITCODE -ne 0 -or $null -eq $n) { Write-Host "  $($t.PadRight(24)) MISSING"; $failed = $true }
        else { Write-Host "  $($t.PadRight(24)) $($n.Trim())" }
    }

    # The thing that actually matters: the work the app added, not just that
    # tables exist.
    $named = (& $Psql "$testUrl" -t -A -c "SELECT count(*) FROM files WHERE canonical_filename IS NOT NULL;" 2>$null)
    $text  = (& $Psql "$testUrl" -t -A -c "SELECT count(*) FROM file_content WHERE length(extracted_text) > 0;" 2>$null)
    Write-Host "`n  files with a canonical name   $($named.Trim())"
    Write-Host "  files with extracted text     $($text.Trim())"

    # Full-text search is a generated column -- confirm it survived and works.
    $hits = (& $Psql "$testUrl" -t -A -c "SELECT count(*) FROM file_content WHERE search_vector @@ websearch_to_tsquery('french','carmelites');" 2>$null)
    Write-Host "  search index still queryable  $($hits.Trim()) hit(s) for 'carmelites'"

    Write-Host "`n$(if ($failed) { 'RESTORE INCOMPLETE -- see MISSING above' } else { 'RESTORE OK' })"
}
finally {
    & $Psql "$adminUrl" -q -c "DROP DATABASE IF EXISTS $TestDb;" | Out-Null
    Write-Host "Dropped '$TestDb'. The live database was never touched."
}
