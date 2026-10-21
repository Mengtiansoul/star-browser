# ============================================================
# Fan_xing standalone browser host - hidden launcher
# Called by start-host.ps1 through schtasks (powershell -WindowStyle Hidden).
# Sets the headless env var, then runs host.mjs with no visible window.
#
# Two hard-won rules for this file:
#  1. Keep it ASCII-only. Windows PowerShell 5.1 reads BOM-less files as ANSI,
#     so non-ASCII comments can corrupt parsing.
#  2. NEVER assign $HOST. It is a read-only automatic variable ($Host = the host
#     program object); assigning it throws VariableNotWritable and the script
#     dies before node ever starts (that is what broke the host from 2026-09-03).
# ============================================================
$ErrorActionPreference = 'Continue'
$env:STAR_BROWSER_HEADLESS = '0'   # headed: visible Edge window (needed to pass Cloudflare JS challenge)
$nodeExe     = 'C:\Program Files\nodejs\node.exe'
$hostScript  = 'D:\Deepseek-Harness\Fan_xing\browser\host.mjs'
$consoleLog  = 'D:\Deepseek-Harness\Fan_xing\browser\host-console.log'
# hidden window means stdout goes nowhere; keep a console log, reopen if it grows past 2MB
if ((Test-Path $consoleLog) -and (Get-Item $consoleLog).Length -gt 2MB) { Remove-Item $consoleLog -Force }
& $nodeExe $hostScript *>> $consoleLog
