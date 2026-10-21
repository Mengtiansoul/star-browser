' 繁星独立浏览器管家 · 无窗口启动器
' 供计划任务 dsh-star-browser-autostart 调用（替代直接跑 powershell，避免登录时弹出黑框）
' 用 WScript.Shell.Run 的窗口样式 0 = 完全隐藏：控制台窗口根本不会被创建，连闪一下都没有
CreateObject("WScript.Shell").Run _
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""D:\Deepseek-Harness\Fan_xing\browser\start-host.ps1""", 0, False
