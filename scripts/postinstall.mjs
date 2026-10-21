#!/usr/bin/env node
// ============================================================
// scripts/postinstall.mjs — 安装后自检
//
// 只检查、只提示，**不改系统**（不会偷偷给你注册自启任务）。
// 想开机静默启动，装完之后手动跑一次：star-browser --install-task
//
// postinstall 失败会让 npm install 整体报错，所以这里无论如何 exit 0。
// ============================================================
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

const ok = (m) => `✅ ${m}`;
const bad = (m) => `❌ ${m}`;
const info = (m) => `   ${m}`;

const lines = [];
lines.push('');
lines.push('── star-browser 自检 ──────────────────────────');

// 1. Node 版本
const major = Number(process.versions.node.split('.')[0]);
lines.push(major >= 18 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} 太旧，需要 ≥ 18`));

// 2. playwright-core
let pw = null;
try {
  const { createRequire } = await import('node:module');
  const req = createRequire(path.join(PKG_ROOT, 'host.mjs'));
  const p = req.resolve('playwright-core/package.json');
  pw = JSON.parse(fs.readFileSync(p, 'utf8')).version;
  lines.push(ok(`playwright-core ${pw}`));
} catch {
  lines.push(bad('playwright-core 没装上（在包目录里跑一次 npm install）'));
}

// 3. Edge
let edge = null;
try {
  const { findEdge } = await import('../lib/edge.mjs');
  edge = findEdge();
  lines.push(ok(`Microsoft Edge: ${edge}`));
} catch (e) {
  lines.push(bad('没找到 Microsoft Edge'));
  String(e.message).split('\n').forEach((l) => lines.push(info(l)));
}

// 4. 数据目录
try {
  const cfg = await import('../lib/config.mjs');
  cfg.ensureDirs();
  lines.push(ok(`数据目录 ${cfg.DATA_ROOT}`));
  const hasProfile = fs.existsSync(cfg.PROFILE_DIR);
  lines.push(info(`profile: ${cfg.PROFILE_DIR}${hasProfile ? '（已有，登录态会保留）' : '（首次启动新建，需要登录抖音/B站等）'}`));
} catch {
  lines.push(bad('数据目录初始化失败'));
}

// 5. 平台提示
if (process.platform === 'win32') {
  info('Windows 提示: 浏览器窗口必须跑在你的登录会话里。');
  info('  · 前台看窗口:   star-browser');
  info('  · 后台静默跑:   star-browser --detach');
  info('  · 开机自动起:   star-browser --install-task  (需要管理员终端)');
} else {
  info('macOS/Linux 直接前台起即可: star-browser --headless');
}

lines.push('──────────────────────────────────────────────');
lines.push('下一步: npx star-browser --doctor   （随时复查）');
lines.push('');
console.log(lines.join('\n'));
process.exit(0);
