<#
    Register the 08:15 Windows scheduled task that refreshes the daily report.

    Timing: the Apps Script mails at 09:00, so the data has to be published
    before then. 08:15 leaves ~45 minutes, which covers a cold Trino load
    (~100s) plus the Vercel deploy with a wide margin.

    Run this ONCE, from an elevated PowerShell (Run as administrator):
        powershell -ExecutionPolicy Bypass -File tools\install-daily-task.ps1

    To remove it:
        Unregister-ScheduledTask -TaskName 'PW Daily Report' -Confirm:$false
#>

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$task = 'PW Daily Report'
$script = Join-Path $PSScriptRoot 'daily-report-task.ps1'

if (-not (Test-Path $script)) { throw "missing $script" }

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $script) `
    -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -Daily -At 8:15am

# StartWhenAvailable matters: if the laptop was asleep at 08:15, Windows runs
# the task as soon as it wakes instead of skipping the day entirely.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 40) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 10)

try { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction Stop } catch {}

Register-ScheduledTask `
    -TaskName $task `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Rebuilds yesterday PW Store report data and publishes it to Vercel for the 9 AM sheet mailer.' `
    -RunLevel Limited | Out-Null

Write-Host "Registered '$task' - runs daily at 08:15." -ForegroundColor Green
Write-Host "Log: $env:TEMP\pw-daily-report.log" -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Test it now without waiting for tomorrow:' -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName '$task'"
