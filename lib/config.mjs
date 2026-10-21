// ============================================================
// lib/config.mjs — 全项目的路径与运行时配置（唯一真相来源）
//
// 设计原则:
//   1. 不再写死 D:\... 这种绝对路径。包根由 import.meta.url 推出来，
//      换机器/换目录/装全局都一样能跑。
//   2. 数据默认落在 <包根>/data/（profile / shots / host.log / tmp）。
//   3. 老布局兼容: 上一版把 profile 放在 <包根>/profile、
//      shots 放在 <包根>/shots。这些目录（profile 里是抖音/B站/DeepSeek
//      的登录态，1GB+）不会因为升级被丢弃 —— 探测到就继续用。
//   4. 一切都能被 env 覆盖（STAR_BROWSER_DATA / _PROFILE / _PORT ...）。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 包根目录（本文件在 <包根>/lib/ 下） */
export const PKG_ROOT = path.resolve(HERE, '..');

export const exists = (p) => {
  try { return !!p && fs.existsSync(p); } catch { return false; }
};

const envStr = (name) => {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : '';
};

/** 数据根目录：默认 <包根>/data，可用 STAR_BROWSER_DATA 指到别处 */
export const DATA_ROOT = path.resolve(envStr('STAR_BROWSER_DATA') || path.join(PKG_ROOT, 'data'));

export const TMP_DIR = path.join(DATA_ROOT, 'tmp');
export const LOG_FILE = path.resolve(envStr('STAR_BROWSER_LOG') || path.join(DATA_ROOT, 'host.log'));

/**
 * Edge 的 user-data-dir。
 * 优先级：env > data/profile（存在） > <包根>/profile（老布局，存在） > data/profile（待创建）
 * 第二/三条就是「升级不丢登录态」的那一步。
 */
export const PROFILE_DIR = (() => {
  const explicit = envStr('STAR_BROWSER_PROFILE');
  if (explicit) return path.resolve(explicit);
  const fresh = path.join(DATA_ROOT, 'profile');
  if (exists(fresh)) return fresh;
  const legacy = path.join(PKG_ROOT, 'profile');
  if (exists(legacy)) return legacy;      // 老布局，里面是已登录的 profile
  return fresh;
})();

/** 截图目录（同样兼容老布局） */
export const SHOTS_DIR = (() => {
  const explicit = envStr('STAR_BROWSER_SHOTS');
  if (explicit) return path.resolve(explicit);
  const fresh = path.join(DATA_ROOT, 'shots');
  if (exists(fresh)) return fresh;
  const legacy = path.join(PKG_ROOT, 'shots');
  if (exists(legacy)) return legacy;
  return fresh;
})();

export const HOST_SCRIPT = path.join(PKG_ROOT, 'host.mjs');
export const LAUNCH_SCRIPT = path.join(PKG_ROOT, 'bin', 'launch-session1.mjs');

const num = (name, fallback) => {
  const raw = envStr(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/** 管家 HTTP 端口（插件按这个找它） */
export const PORT = num('STAR_HOST_PORT', 9443);
/** Edge 的 CDP 端口（抖音等插件直连这个复用同一个浏览器） */
export const CDP_PORT = num('STAR_BROWSER_CDP_PORT', 9227);
export const CDP_ENDPOINT = (envStr('STAR_BROWSER_CDP') || `http://127.0.0.1:${CDP_PORT}`).replace(/\/+$/, '');
/** 1 = 无头（服务/后台用）；0 = 有头（要过 Cloudflare 之类的人机验证时用） */
export const HEADLESS = String(process.env.STAR_BROWSER_HEADLESS ?? '1') === '1';
/** 0 = 管家常驻不自动退出 */
export const HOST_IDLE_MS = num('STAR_HOST_IDLE_MS', 0);
/** session 空闲多久回收（默认 10 分钟） */
export const SESSION_IDLE_MS = num('STAR_SESSION_IDLE_MS', 10 * 60 * 1000);
/** 多久扫一次空闲 session（默认 2 分钟） */
export const SESSION_REAP_MS = num('STAR_SESSION_REAP_MS', 2 * 60 * 1000);
/** 快照规模 */
export const SNAP_ITEMS = num('STAR_SNAP_ITEMS', 80);
export const SNAP_TEXT = num('STAR_SNAP_TEXT', 8000);
/** 拉起浏览器最多等多久 CDP 就绪 */
export const CDP_WAIT_MS = num('STAR_CDP_WAIT_MS', 60_000);
/** 网络日志：每个 session 保留多少条、单条 body 上限（字节）、整 session body 总预算 */
export const NET_MAX = num('STAR_NET_MAX', 100);
// 200KB 太小：抖音的搜索接口实测单条 900KB+，直接被跳过
export const NET_BODY_MAX = num('STAR_NET_BODY_MAX', 2_000_000);
export const NET_TOTAL_BODY_MAX = num('STAR_NET_TOTAL_BODY_MAX', 20_000_000);
/** 看门狗：多久检查一次「浏览器是不是死了」 */
export const WATCHDOG_MS = num('STAR_WATCHDOG_MS', 30_000);
/** eval 硬超时：超了就强制中断页面脚本（Runtime.terminateExecution） */
export const EVAL_TIMEOUT_MS = num('STAR_EVAL_TIMEOUT_MS', 15_000);
/** 拉起管家时，计划任务用的会话用户名（留空=自动探测） */
export const SESSION_USER = envStr('STAR_BROWSER_SESSION_USER');
/** 计划任务名 */
export const TASK_NAME = envStr('STAR_BROWSER_TASK') || 'dsh-star-browser-host';
export const AUTOSTART_TASK = envStr('STAR_BROWSER_AUTOSTART_TASK') || 'dsh-star-browser-autostart';

/** 确保运行时目录存在（幂等） */
export function ensureDirs() {
  for (const d of [DATA_ROOT, TMP_DIR, SHOTS_DIR, path.dirname(LOG_FILE)]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* 只读环境下不致命 */ }
  }
}

/** 给日志/自检用的一行摘要 */
export function describePaths() {
  return {
    pkgRoot: PKG_ROOT,
    dataRoot: DATA_ROOT,
    profile: PROFILE_DIR,
    shots: SHOTS_DIR,
    log: LOG_FILE,
    port: PORT,
    cdp: CDP_ENDPOINT,
    headless: HEADLESS,
  };
}
