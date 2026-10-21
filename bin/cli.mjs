#!/usr/bin/env node
// ============================================================
// bin/cli.mjs — `star-browser` 命令行入口
//
//   star-browser                 前台起管家（Ctrl+C 结束）
//   star-browser --headless      无头（不弹窗口，适合服务器/CI）
//   star-browser --detach        甩到用户桌面会话里后台跑（Windows 走计划任务）
//   star-browser --status        看现在跑没跑
//   star-browser --doctor        环境自检（Node / Edge / 依赖 / 端口）
//   star-browser --install-task  注册「登录即静默启动」
//   star-browser --uninstall-task
//
// 参数: --port <n>  --data <dir>  --edge <path>  --cdp-port <n>  --session-user <name>
// 环境变量等价（见 lib/config.mjs），命令行优先。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

// ---- 先解析参数（要在 import config 之前把 env 塞好）----
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  return fallback;
};

if (flag('--help') || flag('-h')) {
  console.log(`star-browser ${pkg.version} — 独立 Edge 管家（繁星浏览器基座）

用法:
  star-browser [选项]

常用:
  --headless            无头模式（不弹窗口）
  --detach              后台起（Windows: 注入登录用户的桌面会话）
  --status              查看当前是否在跑
  --doctor              环境自检
  --install-task        注册开机/登录静默自启
  --uninstall-task      取消自启

参数:
  --port <n>            管家 HTTP 端口（默认 9443）
  --cdp-port <n>        Edge 调试端口（默认 9227，抖音等插件靠它复用同一浏览器）
  --data <dir>          数据目录（默认 <包>/data）
  --edge <path>         msedge 路径（默认自动探测）
  --session-user <name> 计划任务注入哪个登录用户（默认自动探测）

环境变量: STAR_BROWSER_DATA / _PROFILE / _EDGE / _HEADLESS / _CDP_PORT
          STAR_HOST_PORT / STAR_SESSION_IDLE_MS / STAR_SNAP_ITEMS ...
`);
  process.exit(0);
}
if (flag('--version') || flag('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

// 把参数翻译成 env，后续 lib/config.mjs 统一读
const setIf = (envName, value) => { if (value !== undefined && value !== null && value !== '') process.env[envName] = String(value); };
setIf('STAR_HOST_PORT', opt('--port'));
setIf('STAR_BROWSER_CDP_PORT', opt('--cdp-port'));
setIf('STAR_BROWSER_DATA', opt('--data'));
setIf('STAR_BROWSER_EDGE', opt('--edge'));
setIf('STAR_BROWSER_SESSION_USER', opt('--session-user'));
if (flag('--headless')) process.env.STAR_BROWSER_HEADLESS = '1';
else if (flag('--headed')) process.env.STAR_BROWSER_HEADLESS = '0';

const cfg = await import('../lib/config.mjs');
const { findEdge, probeEdge } = await import('../lib/edge.mjs');
const { launchOnDesktop, installAutostart, removeAutostart, interactiveUser } = await import('../lib/launch.mjs');

const wantHeadless = String(process.env.STAR_BROWSER_HEADLESS ?? '0') === '1';

function nodeOk() {
  const major = Number(process.versions.node.split('.')[0]);
  return { ok: major >= 18, version: process.versions.node };
}

async function hostAlive(port = cfg.PORT, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function rpc(port, body, timeoutMs = 8000) {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return await res.json();
}

// ---------------- --doctor ----------------
if (flag('--doctor')) {
  cfg.ensureDirs();
  const n = nodeOk();
  const edge = probeEdge();
  let pw = { ok: false };
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(path.join(PKG_ROOT, 'host.mjs'));
    const info = req.resolve('playwright-core/package.json');
    pw = { ok: true, version: JSON.parse(fs.readFileSync(info, 'utf8')).version, path: info };
  } catch (e) {
    pw = { ok: false, error: String(e.message || e) };
  }
  const alive = await hostAlive();
  const lines = [];
  lines.push(`star-browser ${pkg.version}`);
  lines.push(`${n.ok ? '✅' : '❌'} Node ${n.version}（需要 ≥ 18）`);
  lines.push(`${edge.ok ? '✅' : '❌'} Edge: ${edge.ok ? edge.path : String(edge.error).split('\n')[0]}`);
  lines.push(`${pw.ok ? '✅' : '❌'} playwright-core: ${pw.ok ? pw.version : String(pw.error).split('\n')[0]}`);
  lines.push(`${alive.ok ? '✅' : '⚪'} 管家 ${cfg.PORT}: ${alive.ok ? '在跑（' + (alive.body?.pages ?? '?') + ' 个页面）' : '没在跑'}`);
  lines.push(`   数据目录: ${cfg.DATA_ROOT}`);
  lines.push(`   profile : ${cfg.PROFILE_DIR}${fs.existsSync(cfg.PROFILE_DIR) ? '' : '(不存在，首次启动会新建)'}`);
  lines.push(`   日志    : ${cfg.LOG_FILE}`);
  lines.push(`   交互用户: ${interactiveUser() || '(探测不到，--detach 需手动 --session-user)'}`);
  console.log(lines.join('\n'));
  if (!edge.ok) {
    console.log('\nEdge 的完整说明:\n' + edge.error);
    process.exit(1);
  }
  process.exit(n.ok && pw.ok ? 0 : 1);
}

// ---------------- --status ----------------
if (flag('--status')) {
  const alive = await hostAlive();
  if (!alive.ok) {
    console.log(`管家没在跑（${cfg.PORT}）：${alive.error || 'HTTP ' + alive.status}`);
    process.exit(1);
  }
  const st = await rpc(cfg.PORT, { op: 'status' });
  const pages = await rpc(cfg.PORT, { op: 'listpages' });
  console.log(JSON.stringify({ ...st, pages: pages.pages || [] }, null, 2));
  process.exit(0);
}

// ---------------- --install-task / --uninstall-task ----------------
if (flag('--install-task')) {
  const r = installAutostart({ headless: wantHeadless, port: cfg.PORT });
  if (r.ok) {
    console.log(`✅ 已注册登录自启：计划任务 ${r.task}（用户 ${r.user}）`);
    console.log(`   启动方式: wscript "${r.vbs}"  →  node ${cfg.HOST_SCRIPT}`);
    console.log('   取消: star-browser --uninstall-task');
  } else {
    console.log(`❌ 没注册上：${r.error || ''}\n${r.hint || ''}`);
    process.exit(1);
  }
  process.exit(0);
}
if (flag('--uninstall-task')) {
  const r = removeAutostart();
  console.log(r.ok ? '✅ 已取消登录自启' : `❌ ${r.error || r.hint}`);
  process.exit(r.ok ? 0 : 1);
}

// ---------------- 默认：起管家 ----------------
if (flag('--detach')) {
  const alive = await hostAlive();
  if (alive.ok) {
    console.log(`已经在跑了（${cfg.PORT}，${alive.body?.pages ?? '?'} 个页面），不重复启动。`);
    process.exit(0);
  }
  findEdge(); // 起之前就报错，别等计划任务里静默失败
  const r = launchOnDesktop({ headless: wantHeadless, port: cfg.PORT });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 700));
    const a = await hostAlive();
    if (a.ok) {
      console.log(`✅ 已在用户会话 "${r.user}" 里起来（端口 ${cfg.PORT}）`);
      process.exit(0);
    }
  }
  console.log(`⚠️ 已触发启动（${r.mode}），但 30 秒内没等到 ${cfg.PORT} 应答。看日志: ${cfg.LOG_FILE}`);
  process.exit(2);
}

// 前台：就地起 host.mjs（能看见日志、Ctrl+C 就停）
cfg.ensureDirs();
const alive = await hostAlive();
if (alive.ok) {
  console.log(`管家已经在 ${cfg.PORT} 跑着了。要重启先关掉它，或用 --status 看看。`);
  process.exit(0);
}
let edgePath;
try {
  edgePath = findEdge();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
console.log(`star-browser ${pkg.version}`);
console.log(`  Edge    : ${edgePath}`);
console.log(`  profile : ${cfg.PROFILE_DIR}`);
console.log(`  端口    : ${cfg.PORT} (CDP ${cfg.CDP_PORT})`);
console.log(`  模式    : ${wantHeadless ? '无头' : '有界面'}`);
console.log('');

const child = spawn(process.execPath, [cfg.HOST_SCRIPT], {
  stdio: 'inherit',
  env: {
    ...process.env,
    STAR_BROWSER_HEADLESS: wantHeadless ? '1' : '0',
    STAR_BROWSER_EDGE: edgePath,
  },
});
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
for (const s of ['SIGINT', 'SIGTERM']) {
  process.on(s, () => { try { child.kill(s); } catch {} });
}
