<#
    Register the tunnel watchdog: every 15 minutes, check whether the dashboard
    can reach its API and repair the tunnel if not.

    Run ONCE from an elevated PowerShell (Run as administrator):
        powershell -ExecutionPolicy Bypass -File tools\install-watchdog.ps1

    To remove:
        Unregister-ScheduledTask -TaskName 'PW Tunnel Watchdog' -Confirm:$false
#>

$ErrorActionPreference = 'Stop'

$repo   = Split-Path -Parent $PSScriptRoot
$task   = 'PW Tunnel Watchdog'
$script = Join-Path $PSScriptRoot 'tunnel-watchdog.ps1'

if (-not (Test-Path $script)) { throw "missing $script" }

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $script) `
    -WorkingDirectory $repo

# Every 15 minutes, indefinitely, starting a minute from now.
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes 15)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 12)

try { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction Stop } catch {}

Register-ScheduledTask `
    -TaskName $task `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Checks the public PW Orders API every 15 min and rebuilds the Cloudflare tunnel if it has died.' `
    -RunLevel Limited | Out-Null

Write-Host "Registered '$task' - runs every 15 minutes." -ForegroundColor Green
Write-Host "Log: $env:TEMP\pw-tunnel-watchdog.log" -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Test it now (safe - reports what it would do, changes nothing):' -ForegroundColor Cyan
Write-Host '  powershell -ExecutionPolicy Bypass -File tools\tunnel-watchdog.ps1 -WhatIf'
