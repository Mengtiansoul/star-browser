#!/usr/bin/env node
// ============================================================
// bin/launch-session1.mjs — 「把管家塞进登录用户的桌面会话」的薄入口
//
// 给 DSH 插件（dsh-star-browser）用：插件跑在 SYSTEM 服务里，自己
// spawn 出来的 Edge 会立刻退出（Session 0 起不了 GUI Edge），所以只能
// 调这个脚本，由它去借 Task Scheduler 落到交互会话。
//
// 参数: --headless / --headed / --port <n> / --cdp-port <n> / --profile <dir>
//       --data <dir> / --log <file> / --task <name> / --keep-task
// 输出: 一行 JSON（{ok, host, mode, task, vbs, user}）
// ============================================================
import { HOST_SCRIPT, PORT, HEADLESS } from '../lib/config.mjs';
import { launchOnDesktop } from '../lib/launch.mjs';
import { findEdge } from '../lib/edge.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
};

const headless = argv.includes('--headless') ? true : (argv.includes('--headed') ? false : HEADLESS);
const port = Number(opt('--port', PORT));
const task = opt('--task', undefined);

// 额外环境注入（调试多实例用得上：独立 profile + 独立 CDP 端口 + 独立日志）
const extraEnv = {};
if (opt('--cdp-port')) extraEnv.STAR_BROWSER_CDP_PORT = String(opt('--cdp-port'));
if (opt('--profile')) extraEnv.STAR_BROWSER_PROFILE = String(opt('--profile'));
if (opt('--data')) extraEnv.STAR_BROWSER_DATA = String(opt('--data'));
if (opt('--log')) extraEnv.STAR_BROWSER_LOG = String(opt('--log'));

try {
  // 起之前先确认 Edge 找得到，否则计划任务里失败是静默的，很难查
  findEdge();
  const r = launchOnDesktop({ headless, port, task, extraEnv });
  console.log(JSON.stringify({ ok: true, host: HOST_SCRIPT, ...r }));
  process.exit(0);
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String(e.message || e) }));
  process.exit(1);
}
