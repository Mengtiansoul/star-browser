' 繁星独立浏览器管家 · 无窗口启动器（计划任务 dsh-star-browser-host 专用）
' 为什么需要它：计划任务若直接执行 powershell.exe，即便加 -WindowStyle Hidden，
'   在交互会话里 Task Scheduler 仍会创建控制台窗口（开机弹黑框的元凶）。
'   wscript.exe 属 GUI 子系统，用 Run 的窗口样式 0 → 控制台根本不会被创建。
' 调用链：dsh-star-browser-host 任务 → 本 VBS → launch.ps1 → node host.mjs(9443, headless Edge)
CreateObject("WScript.Shell").Run _
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""D:\Deepseek-Harness\Fan_xing\browser\launch.ps1""", 0, False
