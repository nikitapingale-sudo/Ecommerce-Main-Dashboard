<#
    Restart the Cloudflare quick tunnel and repoint Vercel at it.

    The dashboard's backend runs on this machine; Vercel reaches it through a
    Cloudflare quick tunnel whose hostname is random and changes every time the
    tunnel restarts. When the tunnel dies, Vercel keeps rewriting /api to a host
    that no longer resolves and the browser shows "API error 502". The backend
    itself is almost never the problem.

    This script does the whole recovery: start a tunnel, wait for its URL,
    write that URL into trial/vercel.json, redeploy, and verify end to end.

    Usage (from the repo root):
        powershell -ExecutionPolicy Bypass -File tools\restart-tunnel.ps1

    Requires: the backend already listening on http://127.0.0.1:8000
#>

$ErrorActionPreference = 'Stop'

$repo    = Split-Path -Parent $PSScriptRoot
$exe     = Join-Path $PSScriptRoot 'cloudflared.exe'
$vercel  = Join-Path $repo 'trial\vercel.json'
$logFile = Join-Path $env:TEMP 'pw-tunnel.log'

function Say($msg, $colour = 'Gray') { Write-Host $msg -ForegroundColor $colour }

# ── 0. Preconditions ────────────────────────────────────────────────────────
if (-not (Test-Path $exe)) {
    Say "cloudflared.exe is missing from tools\. Download it with:" 'Yellow'
    Say '  curl -L -o tools\cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    exit 1
}

Say 'Checking the local backend on port 8000...' 'Cyan'
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/health' -TimeoutSec 10
    Say "  backend is up (engine: $($health.engine))" 'Green'
} catch {
    Say '  backend is NOT running. Start it first, then re-run this script.' 'Red'
    Say '  (the tunnel would come up fine and still serve 502s)' 'DarkGray'
    exit 1
}

# ── 1. Kill any tunnel already running, so we do not leave orphans ──────────
Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
    Say "  stopping an existing cloudflared (pid $($_.Id))" 'DarkGray'
    try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {}
}

# ── 2. Start the tunnel ─────────────────────────────────────────────────────
if (Test-Path $logFile) { Remove-Item $logFile -Force }
Say 'Starting a new quick tunnel...' 'Cyan'
Start-Process -FilePath $exe `
              -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:8000', '--no-autoupdate' `
              -RedirectStandardError $logFile `
              -WindowStyle Hidden

# ── 3. Wait for Cloudflare to hand out a hostname ────────────────────────────
$url = $null
foreach ($i in 1..60) {
    Start-Sleep -Seconds 1
    if (-not (Test-Path $logFile)) { continue }
    $text = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
    if ($text -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
        $url = $Matches[0]
        break
    }
}
if (-not $url) {
    Say 'Timed out waiting for a tunnel URL. Log:' 'Red'
    if (Test-Path $logFile) { Get-Content $logFile -Tail 20 }
    exit 1
}
Say "  tunnel URL: $url" 'Green'

# ── 4. Confirm the tunnel actually reaches the backend ──────────────────────
# The first DNS lookup for a brand-new hostname usually times out; retry.
Say 'Verifying the tunnel reaches the backend...' 'Cyan'
$ok = $false
foreach ($i in 1..10) {
    try {
        $r = Invoke-WebRequest -Uri "$url/api/health" -TimeoutSec 25 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { Start-Sleep -Seconds 3 }
}
if (-not $ok) { Say '  tunnel did not answer in time - check the log above.' 'Red'; exit 1 }
Say '  tunnel -> backend OK' 'Green'

# ── 5. Rewrite vercel.json, WITHOUT a byte-order mark ────────────────────────
# Vercel rejects vercel.json if it starts with a BOM, and PowerShell's
# Set-Content -Encoding utf8 writes one. Use .NET with a BOM-less encoder.
Say 'Updating trial/vercel.json...' 'Cyan'
$json = [System.IO.File]::ReadAllText($vercel)
$new  = [regex]::Replace($json, 'https://[a-z0-9-]+\.trycloudflare\.com', $url)
if ($new -eq $json) {
    Say '  already pointing at this URL, nothing to change' 'DarkGray'
} else {
    [System.IO.File]::WriteAllText($vercel, $new, (New-Object System.Text.UTF8Encoding $false))
    Say '  rewritten (BOM-free)' 'Green'
}

# ── 6. Deploy ───────────────────────────────────────────────────────────────
Say 'Deploying to Vercel...' 'Cyan'
Push-Location (Join-Path $repo 'trial')
try { npx vercel deploy --prod --yes | Out-String | Write-Host } finally { Pop-Location }

# ── 7. Prove it end to end ──────────────────────────────────────────────────
Say 'Checking https://pw-orders-live.vercel.app/api/health ...' 'Cyan'
$live = $false
foreach ($i in 1..5) {
    try {
        $r = Invoke-WebRequest -Uri 'https://pw-orders-live.vercel.app/api/health' -TimeoutSec 40 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $live = $true; break }
    } catch { Start-Sleep -Seconds 4 }
}

if ($live) {
    Say ''
    Say 'Done - the dashboard is talking to the backend again.' 'Green'
    Say "Leave this machine on and awake; the tunnel dies with it." 'DarkGray'
} else {
    Say 'Vercel still is not reaching the tunnel. Re-run, or check the log:' 'Red'
    Say "  $logFile"
}
