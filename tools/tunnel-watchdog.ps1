<#
    Detect a dead tunnel and repair it automatically.

    The quick tunnel fails in a way that is invisible from the outside: the
    cloudflared process stays in the task list, but its control stream drops and
    the *.trycloudflare.com hostname stops resolving. Checking "is cloudflared
    running" therefore tells you nothing - this script checks the thing that
    actually matters, which is whether the dashboard can reach its API.

    Runs every 15 minutes via tools\install-watchdog.ps1. Silent when healthy.

    Deliberately conservative:
      - If the BACKEND is down it does nothing. Restarting a tunnel in front of
        a dead backend produces a healthy-looking tunnel that still serves 502s,
        which is harder to diagnose than an obvious outage.
      - It will not restart more than MaxRepairsPerDay times, so a persistent
        fault surfaces as an outage instead of an endless deploy loop.
#>

param(
    [int]$MaxRepairsPerDay = 6,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

$repo    = Split-Path -Parent $PSScriptRoot
$restart = Join-Path $PSScriptRoot 'restart-tunnel.ps1'
$log     = Join-Path $env:TEMP 'pw-tunnel-watchdog.log'
$state   = Join-Path $env:TEMP 'pw-tunnel-watchdog.state'
$publicUrl = 'https://pw-orders-live.vercel.app/api/health'

function Say($m) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Add-Content -Path $log -Value $line -Encoding utf8
    Write-Host $line
}

# ── Is the public endpoint healthy? Two attempts: the first DNS lookup of a
#    fresh hostname often times out on this network, and a single failure is
#    not evidence of a dead tunnel. ────────────────────────────────────────────
$healthy = $false
foreach ($i in 1..2) {
    try {
        $r = Invoke-WebRequest -Uri $publicUrl -TimeoutSec 30 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 5 }
}

if ($healthy) { exit 0 }          # the common case - stay quiet

Say 'public API is NOT healthy'

# ── Backend first. If it is down, a tunnel restart cannot help. ──────────────
try {
    $null = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/health' -TimeoutSec 15
    Say 'backend is up, so the tunnel is the problem'
} catch {
    Say 'backend is DOWN - not touching the tunnel. Start it with: python scripts/api.py'
    exit 1
}

# ── Rate-limit repairs so a persistent fault does not loop all day. ─────────
$today = (Get-Date).ToString('yyyy-MM-dd')
$count = 0
if (Test-Path $state) {
    $parts = (Get-Content $state -Raw).Trim() -split ','
    if ($parts.Count -eq 2 -and $parts[0] -eq $today) { $count = [int]$parts[1] }
}

if ($count -ge $MaxRepairsPerDay) {
    Say "already repaired $count times today (limit $MaxRepairsPerDay) - standing down."
    Say 'A tunnel failing this often is not a blip. Host the backend properly.'
    exit 2
}

if ($WhatIf) { Say 'WhatIf: would run restart-tunnel.ps1'; exit 0 }

Say ("repairing (attempt {0} today)..." -f ($count + 1))
Set-Content -Path $state -Value ("{0},{1}" -f $today, ($count + 1)) -Encoding utf8

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restart 2>&1 |
    ForEach-Object { Add-Content -Path $log -Value ('    ' + $_) -Encoding utf8 }

# ── Confirm the repair actually worked. ─────────────────────────────────────
Start-Sleep -Seconds 5
try {
    $r = Invoke-WebRequest -Uri $publicUrl -TimeoutSec 40 -UseBasicParsing
    if ($r.StatusCode -eq 200) { Say 'repaired - API is answering again'; exit 0 }
} catch { }

Say 'repair did not restore the API; will try again on the next run'
exit 3
