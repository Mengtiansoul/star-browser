# ============================================================
# 繁星独立浏览器管家 · 启动器 (schtasks 版)
# 用途: DSH (Session 0, SYSTEM) 把 host.mjs 启动到主人桌面会话 (Session 1) 运行
#        Task Scheduler 负责会话注入, 可靠避开 CreateProcessAsUser 的 DLL 问题
# 用法: powershell -ExecutionPolicy Bypass -File D:\Deepseek-Harness\Fan_xing\browser\start-host.ps1
# 参数: -Force → 强制重启 (先停旧的)
# ============================================================
param([switch]$Force)

$ErrorActionPreference = 'Continue'   # schtasks 的 WARNING 走 stderr, 不能 Stop
$NODE  = 'C:\Program Files\nodejs\node.exe'
$HOST_SCRIPT = 'D:\Deepseek-Harness\Fan_xing\browser\host.mjs'
$PORT  = 9443
$TASK  = 'dsh-star-browser-host'
$LOG   = 'D:\Deepseek-Harness\Fan_xing\browser\host.log'

function Test-Alive {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$PORT/health" -UseBasicParsing -TimeoutSec 2
    return $r.StatusCode -eq 200
  } catch { return $false }
}

$alive = Test-Alive
if ($alive -and -not $Force) {
  Write-Output "star-browser host already running on port $PORT"
  exit 0
}
if ($alive) {
  Write-Output 'force mode: stopping old host via /rpc quit'
  try { Invoke-WebRequest -Uri "http://127.0.0.1:$PORT/rpc" -Method POST -ContentType 'application/json' -Body '{"op":"quit"}' -UseBasicParsing -TimeoutSec 3 | Out-Null } catch {}
  Start-Sleep -Seconds 3
}

# 任务命令 (schtasks 引号规则: 内部路径引号用 \" 转义)
# 经 powershell -WindowStyle Hidden 启动 → node 无控制台窗口;
# launch.ps1 内部设 STAR_BROWSER_HEADLESS=1 → 无头 Edge, 不弹窗口不抢焦点
$PS = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$LAUNCH = 'D:\Deepseek-Harness\Fan_xing\browser\launch.ps1'
# 2026-09-25 fix: the task must go through wscript + a VBS (GUI subsystem, window
# style 0). Running powershell.exe directly - even with -WindowStyle Hidden - still
# makes Task Scheduler create a visible console window in the interactive session
# (that was the black box popping up at logon). Keep this file ASCII-only.
$VBS = 'D:\Deepseek-Harness\Fan_xing\browser\start-launch-hidden.vbs'
$taskCmd = "\`"$env:SystemRoot\System32\wscript.exe\`" \`"$VBS\`""
cmd /c "schtasks /create /tn $TASK /tr `"$taskCmd`" /sc once /st 00:00 /ru 32320 /it /f" 2>&1 | Out-Null
cmd /c "schtasks /run /tn $TASK" 2>&1 | Out-Null
Write-Output "task triggered: $TASK (headless)"

# 等待就绪
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 800
  if (Test-Alive) { $ready = $true; break }
}
if (-not $ready) {
  Write-Output 'WARN: host not answering yet; tail of log:'
  Get-Content $LOG -Tail 15 -ErrorAction SilentlyContinue
  exit 2
}
# /rpc status 可能在 Edge 尚未完全就绪时返回 500(启动竞态), 重试几次即可;
# 端口已监听即算启动成功, 不因这一次探活失败而报错退出。
$printed = $false
for ($i = 0; $i -lt 6; $i++) {
  try {
    $status = Invoke-WebRequest -Uri "http://127.0.0.1:$PORT/rpc" -Method POST -ContentType 'application/json' -Body '{"op":"status"}' -UseBasicParsing -TimeoutSec 10
    Write-Output "READY: $($status.Content)"
    $printed = $true
    break
  } catch {
    Start-Sleep -Seconds 2
  }
}
if (-not $printed) {
  Write-Output 'READY (端口已监听; /rpc status 首探失败, Edge 可能仍在启动, 稍后调用工具即可)'
}
exit 0
