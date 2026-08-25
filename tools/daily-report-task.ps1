<#
    Regenerate yesterday's report data and publish it to Vercel.

    The Apps Script in the "PW Store Daily Report" sheet reads
    https://pw-orders-live.vercel.app/data/daily_report.csv at 9:00 AM. This
    script is what puts fresh numbers there, so it must finish BEFORE that.
    Scheduled for 08:15 by tools\install-daily-task.ps1.

    Order matters: the backend must be up, because the report is built from it.

    Usage:
        powershell -ExecutionPolicy Bypass -File tools\daily-report-task.ps1
        powershell -ExecutionPolicy Bypass -File tools\daily-report-task.ps1 -Date 2026-08-18
#>

param(
    [string]$Date = ''   # YYYY-MM-DD; defaults to yesterday
)

$ErrorActionPreference = 'Stop'

$repo   = Split-Path -Parent $PSScriptRoot
$trial  = Join-Path $repo 'trial'
$log    = Join-Path $env:TEMP 'pw-daily-report.log'

function Say($m, $c = 'Gray') {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Write-Host $line -ForegroundColor $c
    Add-Content -Path $log -Value $line -Encoding utf8
}

if (-not $Date) { $Date = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd') }

Say "=== daily report run for $Date ===" 'Cyan'

# ── 1. The backend must be answering, or there is nothing to report on ───────
try {
    $null = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/health' -TimeoutSec 15
    Say 'backend is up' 'Green'
} catch {
    Say 'BACKEND IS DOWN - start it, then re-run. Nothing published.' 'Red'
    Say 'The sheet will keep yesterday''s CSV and the email will be flagged STALE.' 'DarkGray'
    exit 1
}

# ── 2. Build the CSV ─────────────────────────────────────────────────────────
Push-Location $trial
try {
    Say "generating CSV (this hits Trino and can take a few minutes)..." 'Cyan'
    $out = & python scripts\daily_report.py --date $Date --csv 2>&1 | Out-String
    Write-Host $out
    Add-Content -Path $log -Value $out -Encoding utf8

    $csv = Join-Path $trial ("scripts\daily_report_{0}.csv" -f $Date)
    if (-not (Test-Path $csv)) { Say 'CSV was not produced - aborting.' 'Red'; exit 1 }

    $rows = (Get-Content $csv | Measure-Object -Line).Lines
    if ($rows -lt 20) { Say "only $rows lines in the CSV - looks wrong, aborting." 'Red'; exit 1 }
    Say "CSV built with $rows lines" 'Green'

    # ── 3. Publish it as a static asset ──────────────────────────────────────
    $dest = Join-Path $trial 'public\data\daily_report.csv'
    Copy-Item $csv $dest -Force
    Say 'copied into public\data' 'Green'

    # ── 4. Deploy ────────────────────────────────────────────────────────────
    Say 'building and deploying to Vercel...' 'Cyan'
    & npm run build 2>&1 | Select-Object -Last 3 | Write-Host
    & npx vercel deploy --prod --yes 2>&1 | Select-String -Pattern 'Production|READY' | Write-Host
} finally {
    Pop-Location
}

# ── 5. Prove the published file is the one we just built ─────────────────────
Say 'verifying the published CSV...' 'Cyan'
$ok = $false
foreach ($i in 1..5) {
    try {
        $r = Invoke-WebRequest -Uri 'https://pw-orders-live.vercel.app/data/daily_report.csv' `
                               -TimeoutSec 40 -UseBasicParsing
        $firstData = ($r.Content -split "`n")[1]
        if ($firstData -like "$Date,*") { $ok = $true; break }
        Say "served CSV is not yet for $Date, retrying..." 'DarkGray'
    } catch { }
    Start-Sleep -Seconds 6
}

if ($ok) {
    Say "published and verified for $Date - the 9 AM mailer will pick this up." 'Green'
    exit 0
} else {
    Say 'published, but the served CSV does not show the expected date.' 'Yellow'
    Say 'Vercel CDN may still be catching up; check again in a minute.' 'DarkGray'
    exit 2
}
