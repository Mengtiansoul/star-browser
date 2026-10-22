// ============================================================
// 繁星独立浏览器管家 (Star Browser Host) · v2 Session 隔离版
// 运行位置: 登录用户的桌面会话 —— 由 `star-browser` CLI（bin/cli.mjs）或
//           DSH 插件的 bin/launch-session1.mjs 经计划任务注入拉起
// 职责: 用 playwright-core 管理一个独立 Edge 实例 (独立 user-data-dir,
//       与主人日常 Edge 完全隔离), 对外提供 localhost HTTP JSON API。
//
// v2 相对 v1 的变化（2026-10-21）:
//   1. 废弃全局 activePage → sessions: Map<sessionId, {page, lastActive, fps}>
//      每个调用方按 sessionId 精准路由到自己的页面, 不再互相抢。
//   2. 同一 session 内的请求串行（per-session 队列）, 不同 session 并行。
//   3. 空闲回收: 每 2 分钟扫一次, 超 10 分钟没动的 session 关页回收
//      （保留至少一个页面, 免得关掉最后一页把 Edge 一起带走）。
//   4. 防编号漂移: 快照时记录每个编号的元素指纹; click 找不到编号时用指纹
//      在页面里重新定位唯一元素再点, 定位不到/不唯一则回 ELEMENT_GONE + 新快照,
//      绝不盲点新编号（盲点会点到别的元素）。
//   5. 快照: 可见元素优先编号, 视口外的排后面; 元素被打标外的不再混进来。
//   6. 页面崩溃 / 已关闭 一律返回 {ok:false, error:'page crashed'}, 不让 RPC 抛穿。
//   7. 配置工程化（v3, 2026-10-22）: 不再写死任何绝对路径 —— 包根由
//      lib/config.mjs 从 import.meta.url 推出来, profile/shots/日志默认落在
//      <包根>/data/（并自动继承老布局的 profile, 不丢登录态）;
//      Edge 路径由 lib/edge.mjs 自适应探测（env → 常见安装位置 → PATH）。
//
// ⚠️ 以下两段逻辑是踩坑换来的, 严禁改动:
//   A. 起浏览器 = spawn Edge(detached) + 轮询 CDP + connectOverCDP。
//      不能退回 chromium.launchPersistentContext —— 它会等"完全就绪", 实测
//      Edge 已起来、CDP 也监听了它仍等不到, 挂满 180s 超时后反手把刚起来的
//      Edge 杀掉。spawn 出来的进程不归 Playwright 托管, 它关不到。
//   B. attach 来的浏览器（connectOverCDP）绝不 close: Playwright 对 CDP 连接
//      执行 browser.close()/context.close() 等于发 Browser.close, 会把主人的
//      浏览器整个关掉。只丢引用。
// ============================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

// 路径与运行时配置集中在 lib/config.mjs（跨机器/跨目录可迁移，
// 并兼容上一版把 profile 放在包根的老布局 —— 那里是已登录的 1GB profile）
import {
  PROFILE_DIR as PROFILE,
  SHOTS_DIR as SHOTS,
  LOG_FILE as LOG,
  PORT,
  CDP_ENDPOINT,
  CDP_PORT,
  HEADLESS,
  HOST_IDLE_MS as IDLE_MS,
  SESSION_IDLE_MS,
  SESSION_REAP_MS as REAP_INTERVAL_MS,
  SNAP_ITEMS as SNAP_ITEM_LIMIT,
  SNAP_TEXT as SNAP_TEXT_LIMIT,
  CDP_WAIT_MS,
  NET_MAX,
  NET_BODY_MAX,
  NET_TOTAL_BODY_MAX,
  WATCHDOG_MS,
  EVAL_TIMEOUT_MS,
  ensureDirs,
} from './lib/config.mjs';
import { findEdge } from './lib/edge.mjs';

const require = createRequire(import.meta.url);
// 依赖就近解析: 包根 node_modules 里有 playwright-core
const { chromium } = require('playwright-core');

const DEFAULT_SESSION = 'default';

// 数据目录（profile / shots / 日志）首次启动时自动建
ensureDirs();

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
  console.log(line);
}

// 进程级空闲退出（默认关闭）
let lastActivity = Date.now();
const idleTimer = setInterval(() => {
  if (IDLE_MS > 0 && Date.now() - lastActivity > IDLE_MS) {
    log('idle for ' + (IDLE_MS / 60000) + 'min, auto-quitting');
    // attach 来的浏览器只断开引用，不关别人的浏览器
    if (!attachedBrowser && context) { try { context.close().catch(() => {}); } catch {} }
    process.exit(0);
  }
}, 60 * 1000);
idleTimer.unref();

// ------------------------------------------------------------
// 浏览器与 session 状态
// ------------------------------------------------------------
let context = null;          // BrowserContext
let attachedBrowser = null;  // connectOverCDP 拿到的 Browser（只断开，绝不 close）
let spawnedEdgePid = null;   // 自己 spawn 出来的 Edge（看门狗清理时用）
let ctxUid = 0;

/** sessionId -> { page, lastActive, fps: Map<number, string>, _q: Promise } */
const sessions = new Map();
/** sessionId -> Promise（防止并发请求各建一页） */
const creating = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ensurePromise = null;
async function ensureBrowser() {
  // in-flight 锁：两个请求同时进来不能各 launch 一次（后一个会因 profile 被占超时，
  // 超时后 Playwright 把先起来、已 attach 的那个 Edge 一起杀掉）
  if (ensurePromise) return ensurePromise;
  ensurePromise = rawEnsureBrowser().finally(() => { ensurePromise = null; });
  return ensurePromise;
}

async function rawEnsureBrowser() {
  if (context) {
    try {
      const pages = context.pages(); // 抛错 = 已死
      // 不碰任何 session 的页面；只要保证浏览器至少有一个页面（关掉最后一页 Edge 会退出）
      if (pages.filter((p) => !p.isClosed()).length === 0) await context.newPage().catch(() => {});
      return;
    } catch (e) {
      log('context dead, cleaning up:', e.message);
      // 只清自己 launch 的 context。attach 来的只断开引用。
      if (!attachedBrowser) { try { await context.close(); } catch {} }
      context = null; attachedBrowser = null;
    }
  }
  log('launching standalone Edge (headless=' + HEADLESS + ', profile=' + PROFILE + ')');
  // 先看 CDP 端口有没有活着的浏览器。有就直接接上，别再开第二个——
  // 同一个 user-data-dir 再开会 Edge 判成「已在已有会话中打开」然后立刻退出。
  try {
    const probe = await fetch(CDP_ENDPOINT + '/json/version', { signal: AbortSignal.timeout(2000) });
    if (probe.ok) {
      const info = await probe.json();
      log('found live CDP at ' + CDP_ENDPOINT + ' (' + info.Browser + '), attaching');
      const existing = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 15000 });
      attachedBrowser = existing; // 保留引用，退出时只断开不关闭
      context = existing.contexts()[0] || await existing.newContext();
      if (context.pages().filter((p) => !p.isClosed()).length === 0) await context.newPage().catch(() => {});
      log('attached to running Edge, pages=' + context.pages().length);
      await dropOrphanBlanks();
      return;
    }
  } catch (e) {
    log('no live CDP at ' + CDP_ENDPOINT + ' (' + String(e.message || e).split('\n')[0] + '), launching a new one');
  }
  // ⚠️ A 段：自己 spawn Edge，再用 CDP 接上（不要改回 launchPersistentContext）
  const args = [
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + CDP_PORT,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--start-maximized',
    '--mute-audio',
    '--autoplay-policy=user-gesture-required',
    '--no-proxy-server',
    '--disable-background-networking',
  ];
  if (HEADLESS) args.push('--headless=new');
  const edgeExe = findEdge(); // env → 常见安装位置 → PATH，找不到会抛一条能照着做的错误
  const child = spawn(edgeExe, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e) => log('edge spawn error:', e.message));
  child.unref();
  spawnedEdgePid = child.pid || null;
  log('spawned Edge pid=' + child.pid + ' (' + edgeExe + '), waiting for CDP at ' + CDP_ENDPOINT);
  let version = null;
  const deadline = Date.now() + CDP_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const probe = await fetch(CDP_ENDPOINT + '/json/version', { signal: AbortSignal.timeout(2000) });
      if (probe.ok) { version = await probe.json(); break; }
    } catch { /* 还没起来 */ }
  }
  if (!version) throw new Error('Edge 已启动但 ' + Math.round(CDP_WAIT_MS / 1000) + ' 秒内没等到 CDP 端点，放弃这一次');
  log('CDP ready (' + version.Browser + '), connecting');
  const launched = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 20_000 });
  attachedBrowser = launched; // 同上：断开时只丢引用，绝不 close
  context = launched.contexts()[0] || await launched.newContext();
  if (context.pages().filter((p) => !p.isClosed()).length === 0) await context.newPage().catch(() => {});
  log('Edge ready (spawned by host), pages=' + context.pages().length);
}

// 启动/接管时清掉没人认领的空白页（v1 每次重启都留一堆 about:blank 的来源）
async function dropOrphanBlanks() {
  if (!context) return;
  const live = context.pages().filter((p) => !p.isClosed());
  if (live.length <= 1) return;
  const used = new Set();
  for (const s of sessions.values()) if (s.page) used.add(s.page);
  for (const p of live) {
    if (used.has(p)) continue;
    const u = p.url();
    if (u === 'about:blank' || u === '') { try { await p.close(); } catch {} }
  }
}

// ------------------------------------------------------------
// Session 路由
// ------------------------------------------------------------
/** 给 session 挑一页：优先没被占用的空白页，否则新建 */
async function claimPage() {
  if (!context) return null;
  const live = context.pages().filter((p) => !p.isClosed());
  const used = new Set();
  for (const s of sessions.values()) if (s.page) used.add(s.page);
  const blank = live.find((p) => !used.has(p) && (p.url() === 'about:blank' || p.url() === ''));
  if (blank) return blank;
  return await context.newPage();
}

// ------------------------------------------------------------
// 网络监听（每个 session 一份）
// 只收 xhr / fetch 的响应：业务侧可以直接拿接口返回的 JSON，
// 不必再去解析 DOM（对抖音这类 SPA 尤其省事）。
//   · 环形缓冲，最多 NET_MAX 条（超了丢最老的）
//   · 单条 body 超过 NET_BODY_MAX 不读，只记字节数
//   · 同一页面最多 6 个并发 body 读取，防止接口风暴把内存打爆
// ------------------------------------------------------------
function netState(sess) {
  if (!sess.net) sess.net = { entries: [], seq: 0, bodyBytes: 0 };
  if (typeof sess.net.bodyBytes !== 'number') sess.net.bodyBytes = 0;
  return sess.net;
}

/** 入队 + 两级裁剪：条数上限，以及整个 session 的 body 总预算 */
function pushNetEntry(st, entry) {
  st.entries.push(entry);
  if (entry.bytes) st.bodyBytes += entry.bytes;
  // 1) 条数上限：丢最老的整条
  while (st.entries.length > NET_MAX) {
    const old = st.entries.shift();
    st.bodyBytes -= old && old.bytes ? old.bytes : 0;
  }
  // 2) body 总预算：超了就只回收最老的 body，元数据保留（还能看到请求过什么）
  let guard = 0;
  while (st.bodyBytes > NET_TOTAL_BODY_MAX && guard++ < NET_MAX) {
    const old = st.entries.find((e) => e.json || e.text);
    if (!old) break;
    st.bodyBytes -= old.bytes || 0;
    old.json = null;
    old.text = '(reclaimed: session body budget exceeded)';
    old.reclaimed = true;
  }
  if (st.bodyBytes < 0) st.bodyBytes = 0;
}

const netInflight = new WeakMap(); // page -> 正在读 body 的数量

function attachNet(sess, page) {
  if (!page || sess.netPage === page) return;
  sess.netPage = page;
  const st = netState(sess);
  page.on('response', (res) => {
    (async () => {
      try {
        const req = res.request();
        const type = req.resourceType();
        if (type !== 'xhr' && type !== 'fetch') return;
        const headers = res.headers();
        const ct = String(headers['content-type'] || '').toLowerCase();
        const entry = {
          i: ++st.seq,
          ts: Date.now(),
          method: req.method(),
          url: res.url(),
          status: res.status(),
          ct,
          json: null,
          text: null,
          bytes: null,
          error: null,
        };
        // 只对可能是 JSON/文本的响应读 body（图片、字体直接跳过）
        if (/json|javascript|text\/plain|text\//.test(ct)) {
          const n = netInflight.get(page) || 0;
          if (n >= 6) {
            entry.error = 'skipped: too many concurrent body reads';
          } else {
            netInflight.set(page, n + 1);
            try {
              const body = await res.body();
              entry.bytes = body ? body.length : 0;
              if (body && body.length <= NET_BODY_MAX) {
                const txt = body.toString('utf8');
                try { entry.json = JSON.parse(txt); } catch { entry.text = txt.slice(0, 4000); }
              } else if (body) {
                entry.text = '(body ' + body.length + ' bytes, over limit ' + NET_BODY_MAX + ')';
                entry.truncated = true;
              }
            } catch (e) {
              entry.error = 'body: ' + String((e && e.message) || e).split('\n')[0];
            } finally {
              netInflight.set(page, Math.max(0, (netInflight.get(page) || 1) - 1));
            }
          }
        }
        pushNetEntry(st, entry);      } catch { /* 页面正在导航，丢弃这一条 */ }
    })();
  });
}

// ============================================================
// DOM 事件通道：页面里挂 MutationObserver → CDP binding → SSE 推给订阅方
//   只用来回答「现在有新消息了没」，内容永远由订阅方自己抓 DOM。
//   payload 只带 { added, ts }，绝不传原始 Buffer / HTML，避免序列化开销。
// ============================================================
const sseClients = new Set();
const domCdpByPage = new WeakMap();

function broadcastSse(obj) {
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of sseClients) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
  log('sse broadcast: ' + JSON.stringify(obj) + ' -> ' + sseClients.size + ' client(s)');
}

// 注入进页面的脚本：只盯着「新增了消息气泡」这一件事，500ms 防抖。
const INJECT_DOM_WATCHER = `(() => {
  const KEY = '__starDomWatchInstalled';
  if (window[KEY]) return 'already';
  window[KEY] = true;
  const send = (obj) => {
    try {
      if (typeof window.__starDomEvent === 'function') window.__starDomEvent(JSON.stringify(obj));
    } catch (e) {}
  };
  let timer = 0;
  let pending = 0;
  const flush = () => {
    timer = 0;
    if (pending > 0) { send({ kind: 'new_msg', added: pending, ts: Date.now() }); pending = 0; }
  };
  const looksLikeMsg = (node) => {
    if (!node || node.nodeType !== 1) return false;
    try {
      if (node.matches && node.matches('[data-e2e="msg-item-content"]')) return true;
      if (node.querySelector && node.querySelector('[data-e2e="msg-item-content"]')) return true;
    } catch (e) {}
    return false;
  };
  // 会话行：未读数字、最后一条消息预览、时间戳，任何一个变了都算「有新消息」。
  // 这一路是必需的 —— 聊天窗只渲染当前打开的那个会话，别人在别的会话发消息，
  // 消息气泡根本不在 DOM 里，只有会话列表会动。
  const inConvRow = (node) => {
    let el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    if (!el || !el.closest) return false;
    try { return !!el.closest('[data-e2e="conversation-item"]'); } catch (e) { return false; }
  };
  const onMut = (muts) => {
    let n = 0;
    for (const m of muts) {
      if (m.type === 'characterData') { if (inConvRow(m.target)) n++; continue; }
      if (!m.addedNodes) continue;
      for (const node of m.addedNodes) {
        if (looksLikeMsg(node)) n++;
        else if (inConvRow(node)) n++;
      }
    }
    if (!n) return;
    pending += n;
    if (timer) return;
    timer = setTimeout(flush, 500);   // 防抖：突发一堆只报一次
  };
  const start = () => {
    try {
      new MutationObserver(onMut).observe(document.documentElement, {
        childList: true, subtree: true, characterData: true,
      });
      return 'observing';
    } catch (e) { return 'error:' + e.message; }
  };
  return document.documentElement ? start() : (document.addEventListener('DOMContentLoaded', start, { once: true }), 'waiting-dom');
})()`;

/** 给某个 page 挂上 DOM 监听（幂等：CDP 会话复用，脚本重复注入会被页面自己挡掉） */
async function attachDomWatcher(page) {
  if (!page || page.isClosed()) return;
  try {
    let cdp = domCdpByPage.get(page);
    if (!cdp) {
      cdp = await page.context().newCDPSession(page);
      await cdp.send('Runtime.enable');
      await cdp.send('Runtime.addBinding', { name: '__starDomEvent' });
      cdp.on('Runtime.bindingCalled', (ev) => {
        if (ev.name !== '__starDomEvent') return;
        let payload = {};
        try { payload = JSON.parse(ev.payload || '{}'); } catch { payload = {}; }
        broadcastSse({ type: payload.kind || 'new_msg', added: payload.added || 0, ts: payload.ts || Date.now() });
      });
      domCdpByPage.set(page, cdp);
      page.on('close', () => { domCdpByPage.delete(page); });
      log('dom watcher: cdp session ready for ' + page.url().slice(0, 60));
    }
    const r = await cdp.send('Runtime.evaluate', { expression: INJECT_DOM_WATCHER, returnByValue: true }).catch(() => null);
    const state = r && r.result ? r.result.value : '(no value)';
    log('dom watcher inject -> ' + state);
  } catch (e) {
    log('dom watcher failed: ' + ((e && e.message) || e));
  }
}
async function getSession(sessionId, createIfNotExist = false) {
  const id = String(sessionId || DEFAULT_SESSION);
  const cur = sessions.get(id);
  if (cur && cur.page && !cur.page.isClosed()) {
    cur.lastActive = Date.now();
    attachNet(cur, cur.page);   // 页面可能刚被 newpage/switchpage 换过
    primeCdp(cur.page).catch(() => {});  // 提前建好 CDP，卡死时才有中断的机会
    attachDomWatcher(cur.page).catch(() => {});
    return cur;
  }
  if (cur) { sessions.delete(id); }           // 页面没了 → 丢掉记录重建
  if (!createIfNotExist) return null;
  if (creating.has(id)) return creating.get(id); // 并发请求共用一次创建
  const job = (async () => {
    const page = await claimPage();
    if (!page) return null;
    const sess = { id, page, lastActive: Date.now(), fps: new Map(), _q: null };
    sessions.set(id, sess);
    attachNet(sess, page);
    primeCdp(page).catch(() => {});
    attachDomWatcher(page).catch(() => {});
    log('session ' + id + ' -> new page (' + page.url() + ')');
    return sess;
  })();
  creating.set(id, job);
  try { return await job; } finally { creating.delete(id); }
}

/** 同一 session 内串行（不同 session 并行） */
function serialize(sess, fn) {
  const prev = sess._q || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  sess._q = next.catch(() => {});
  return next;
}

/** 空闲回收：超时没动静的 session 关页；至少留一页，别把 Edge 带走 */
async function reapSessions() {
  if (SESSION_IDLE_MS <= 0) return;
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (!sess.page || sess.page.isClosed()) { sessions.delete(id); continue; }
    if (now - sess.lastActive <= SESSION_IDLE_MS) continue;
    const live = context ? context.pages().filter((p) => !p.isClosed()) : [];
    if (live.length <= 1) { sess.lastActive = now; continue; } // 最后一页，留着
    try { await sess.page.close(); } catch {}
    sessions.delete(id);
    log('reaped idle session ' + id + ' (idle ' + Math.round((now - sess.lastActive) / 1000) + 's)');
  }
}
const reapTimer = setInterval(() => { reapSessions().catch((e) => log('reap error:', e.message)); }, REAP_INTERVAL_MS);
reapTimer.unref();

// ------------------------------------------------------------
// 看门狗：浏览器彻底死了就自愈
// 判据 = Playwright 的 context 抛错 **或** CDP 端点不再应答。
// 连续两轮不通才动手（约 60 秒），避免一次网络抖动就重启。
// 重启前只杀「自己 spawn 的那个 Edge」（attachedBrowser 是别人的，只丢引用）。
// ------------------------------------------------------------
let watchdogBusy = false;
let cdpMisses = 0;

async function watchdogTick() {
  if (watchdogBusy) return;
  watchdogBusy = true;
  try {
    let alive = false;
    if (context) {
      try { context.pages(); alive = true; } catch { alive = false; }
    }
    if (alive) {
      try {
        const r = await fetch(CDP_ENDPOINT + '/json/version', { signal: AbortSignal.timeout(3000) });
        alive = r.ok;
      } catch { alive = false; }
    }
    if (alive) { cdpMisses = 0; return; }

    cdpMisses++;
    if (cdpMisses < 2) {
      log('watchdog: browser not answering (' + cdpMisses + '/2), will re-check next round');
      return;
    }
    cdpMisses = 0;
    log('watchdog: browser is dead, dropping ' + sessions.size + ' session(s) and relaunching');
    for (const [, s] of sessions) {
      try { if (s.page && !s.page.isClosed()) await s.page.close(); } catch {}
    }
    sessions.clear();
    // 自己 spawn 的 Edge 如果还赖在 profile 上，新 Edge 会被它转交然后自己退出。
    // attach 来的（attachedBrowser）不碰，那可能是用户/别的插件起的。
    if (spawnedEdgePid && !attachedBrowser) {
      try { process.kill(spawnedEdgePid); log('watchdog: killed stale edge pid=' + spawnedEdgePid); } catch {}
    }
    context = null;
    attachedBrowser = null;
    spawnedEdgePid = null;
    await ensureBrowser();
    log('watchdog: relaunched, pages=' + countPages());
  } catch (e) {
    log('watchdog error:', (e && e.message) || String(e));
  } finally {
    watchdogBusy = false;
  }
}

if (WATCHDOG_MS > 0) {
  const watchdogTimer = setInterval(() => { watchdogTick().catch(() => {}); }, WATCHDOG_MS);
  watchdogTimer.unref();
}

// ------------------------------------------------------------
// 页内扫描（快照 + 指纹重定位共用，必须是自包含函数）
// ------------------------------------------------------------
function pageScanFn(opts) {
  const SELS = [
    'a[href]', 'button',
    'input:not([type=hidden]):not([type=submit])', 'textarea', 'select', 'input[type="submit"]',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="textbox"]', '[role="radio"]',
    '[contenteditable="true"]',
  ];
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    return clean(el.innerText || el.value || el.placeholder || aria || el.textContent || '').slice(0, 90);
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return null;
    const tag = el.tagName.toLowerCase();
    const type = (el.type || '').toLowerCase();
    if (tag === 'input' && ['hidden', 'button', 'image', 'file'].includes(type)) return null;
    if (el.disabled) return null;
    const label = labelOf(el);
    if (tag === 'a' && !label) return null; // 无文字的裸链接跳过
    const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
    const visible = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    const href = tag === 'a' ? (el.getAttribute('href') || '') : '';
    return { el, tag, type, label, href, visible };
  };
  const fpOf = (d) => [d.tag, d.type, d.label, d.href].join('\u0001');

  const all = [];
  for (const el of document.querySelectorAll(SELS.join(','))) {
    const d = describe(el);
    if (d) all.push(d);
  }

  if (opts.mode === 'locate') {
    // 不改编号、不清属性；只给指纹命中的元素打临时标记，交给 Node 侧判断唯一性
    for (const o of document.querySelectorAll('[data-star-relocate]')) o.removeAttribute('data-star-relocate');
    let hits = 0;
    for (const d of all) {
      if (fpOf(d) === opts.fp) { d.el.setAttribute('data-star-relocate', '1'); hits++; }
    }
    return { hits };
  }

  // snapshot 模式：清掉上一轮编号/标记后重新排
  for (const o of document.querySelectorAll('[data-star-i]')) {
    o.removeAttribute('data-star-i'); o.removeAttribute('data-star-fid');
  }
  for (const o of document.querySelectorAll('[data-star-relocate]')) o.removeAttribute('data-star-relocate');

  const out = {
    title: document.title || '',
    url: location.href,
    text: '',
    items: [],
    iframes: document.querySelectorAll('iframe').length,
    offscreen: 0,
    fps: {},
  };
  try {
    out.text = (document.body ? document.body.innerText : '')
      .replace(/\u00a0/g, ' ')
      .split('\n').map((l) => l.trim()).filter((l) => l).join('\n')
      .slice(0, opts.textLimit || 8000);
  } catch { /* 页面在导航中 */ }

  // 可见元素优先编号，视口外的排后面（原来纯 DOM 顺序，长列表里前面的全是导航）
  const ordered = all
    .map((d, idx) => ({ d, idx, v: d.visible ? 0 : 1 }))
    .sort((a, b) => (a.v - b.v) || (a.idx - b.idx))
    .map((x) => x.d);

  const limit = opts.limit || 80;
  let n = 0;
  for (const d of ordered) {
    if (n >= limit) { if (!d.visible) out.offscreen++; continue; }
    n++;
    const i = n;
    try {
      d.el.setAttribute('data-star-i', String(i));
      if (d.tag === 'input' || d.tag === 'textarea' || d.tag === 'select' || d.el.isContentEditable) {
        d.el.setAttribute('data-star-fid', 'star-f' + i);
      }
    } catch {}
    out.fps[i] = fpOf(d);
    out.items.push({
      i,
      tag: d.tag,
      type: d.type || '',
      label: d.label,
      href: d.href,
      value: (d.el.value !== undefined ? String(d.el.value) : '').slice(0, 50),
      placeholder: d.el.placeholder || '',
      input: d.tag === 'input' || d.tag === 'textarea' || d.tag === 'select' || d.el.isContentEditable,
      visible: d.visible,
    });
  }
  return out;
}

/** 快照（永不抛穿：页面崩了/关了都返回 ok:false） */
async function snapshotOf(page, sess) {
  if (!page) return { ok: false, error: 'page crashed' };
  try {
    if (page.isClosed()) return { ok: false, error: 'page crashed' };
    const data = await page.evaluate(pageScanFn, {
      mode: 'snapshot',
      limit: SNAP_ITEM_LIMIT,
      textLimit: SNAP_TEXT_LIMIT,
    });
    if (sess) {
      const m = new Map();
      for (const [k, v] of Object.entries(data.fps || {})) m.set(Number(k), v);
      sess.fps = m;
    }
    delete data.fps;
    return data;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/closed|crashed|Target page|navigation/i.test(msg)) return { ok: false, error: 'page crashed' };
    return { ok: false, error: 'snapshot failed: ' + msg };
  }
}

/** 取正文（同上的保护） */
async function textOf(page) {
  try {
    if (!page || page.isClosed()) return { ok: false, error: 'page crashed' };
    const t = await page.evaluate(() => (document.body ? document.body.innerText : '')
      .replace(/\u00a0/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l).join('\n'));
    return { ok: true, text: t };
  } catch (e) {
    return { ok: false, error: 'page crashed' };
  }
}

/** 点击：编号不在就按指纹重定位；定位不到/不唯一 → gone（绝不盲点新编号） */
async function clickTarget(page, sess, { i, selector }) {
  if (selector) {
    const loc = page.locator(selector).first();
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await loc.click({ timeout: 8000 });
    return { via: 'selector' };
  }
  const byIndex = page.locator('[data-star-i="' + i + '"]').first();
  const count = await byIndex.count().catch(() => 0);
  if (count > 0) {
    await byIndex.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await byIndex.click({ timeout: 8000 });
    return { via: 'index' };
  }
  // 编号漂移：用快照时记下的指纹在页面里找
  const fp = sess && sess.fps ? sess.fps.get(Number(i)) : undefined;
  if (!fp) return { gone: true, hits: 0 };
  const hit = await page.evaluate(pageScanFn, { mode: 'locate', fp }).catch(() => null);
  if (!hit || hit.hits !== 1) return { gone: true, hits: hit ? hit.hits : 0 };
  const loc = page.locator('[data-star-relocate="1"]').first();
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await loc.click({ timeout: 8000 });
  await page.evaluate(() => {
    const e = document.querySelector('[data-star-relocate]');
    if (e) e.removeAttribute('data-star-relocate');
  }).catch(() => {});
  return { via: 'relocated' };
}

/** 点击后等稳定 + 拍新快照 */
async function afterAction(page, sess) {
  await Promise.race([
    page.waitForLoadState('load', { timeout: 12000 }).catch(() => {}),
    sleep(2500),
  ]).catch(() => {});
  await sleep(500);
  return await snapshotOf(page, sess);
}

// ------------------------------------------------------------
// eval 熔断
// page.evaluate 本身没有超时：页面里一个 while(true) 就能把渲染进程卡死，
// 之后所有命令一起超时（管家是单线程，等下去等于陪着死）。
//
// 关键点（2026-10-22 实测踩出来的）：
//   1. **CDP 会话必须提前建好**。渲染进程卡死时 newCDPSession 也会卡住
//      （它要等 renderer 响应），那时候再建就等于连中断的机会都没有。
//      所以页面一绑定就 primeCdp() 建好缓存。
//   2. 中断指令发出去不 await 结果：renderer 卡着时 send() 可能永远不 resolve，
//      await 它会让 504 也回不去（第一次实现就是这么翻车的：客户端 40s 超时）。
//   3. 页面被卡过的 session 打 wedged 标记，下一次请求先尝试 reload 自愈，
//      reload 也不行就换一张新页（旧页关掉）。
// ------------------------------------------------------------
const cdpCache = new WeakMap(); // page -> CDPSession | null

/** 提前建 CDP 会话（fire-and-forget，失败就记 null，不影响主流程） */
async function primeCdp(page) {
  if (!page || cdpCache.has(page)) return;
  cdpCache.set(page, null); // 先占位，防止并发重复建
  try {
    const s = await page.context().newCDPSession(page);
    cdpCache.set(page, s);
  } catch {
    cdpCache.set(page, null);
  }
}

/** 强制中断页面脚本执行；最多等 graceMs（超时视为没成功，但不阻塞调用方） */
async function terminatePageExecution(page, graceMs = 3000) {
  const c = cdpCache.get(page);
  if (!c) return false;
  try {
    return await Promise.race([
      c.send('Runtime.terminateExecution').then(() => true),
      sleep(graceMs).then(() => false),
    ]);
  } catch {
    return false;
  }
}

const TIMEOUT = Symbol('timeout');

/** 带硬超时的 evaluate（超时只返回标记，中断交给调用方异步做） */
async function evalWithTimeout(page, expression, timeoutMs) {
  let timer;
  const timeoutP = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  try {
    const result = await Promise.race([page.evaluate(expression), timeoutP]);
    if (result === TIMEOUT) return { ok: false, timeout: true };
    return { ok: true, result };
  } finally {
    clearTimeout(timer);
  }
}

/** 把被 eval 卡住的页面救回来：先 reload，不行就换新页 */
async function unwedge(sess) {
  if (!sess || !sess.page) return;
  if (sess.unwedging) return;          // 并发请求只救一次
  sess.unwedging = true;
  sess.wedged = false;
  try {
    log('session ' + sess.id + ' wedged by stuck eval, reloading page');
    try {
      await sess.page.reload({ timeout: 15000, waitUntil: 'domcontentloaded' });
      return;
    } catch { /* 落到换页 */ }
    try {
      const fresh = await Promise.race([context.newPage(), sleep(10000).then(() => null)]);
      if (fresh) {
        const dead = sess.page;
        sess.page = fresh;
        sess.fps = new Map();
        sess.net = { entries: [], seq: 0 };
        attachNet(sess, fresh);
        primeCdp(fresh).catch(() => {});
        log('session ' + sess.id + ' got a fresh page (old one was stuck)');
        Promise.race([dead.close(), sleep(5000)]).catch(() => {});
      }
    } catch (e) {
      log('unwedge failed for session ' + sess.id + ': ' + ((e && e.message) || e));
    }
  } finally {
    sess.unwedging = false;
  }
}

// ------------------------------------------------------------
// HTTP / RPC
// ------------------------------------------------------------
const NO_PAGE_OPS = [
  'status', 'listpages', 'listsessions', 'closesession', 'quit',
];

const server = http.createServer(async (req, res) => {
  lastActivity = Date.now();
  const send = (code, obj) => {
    let body;
    try { body = JSON.stringify(obj); } catch (e) { body = JSON.stringify({ ok: false, error: 'serialize failed: ' + e.message }); }
    try {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    } catch {}
  };
  if (req.method === 'GET' && req.url === '/health') {
    return send(200, {
      ok: true,
      ts: Date.now(),
      sessions: sessions.size,
      pages: context ? context.pages().filter((p) => !p.isClosed()).length : 0,
    });
  }
  // SSE 长连接：订阅「页面有新消息」这一件事
  if (req.method === 'GET' && req.url.startsWith('/events')) {
    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      res.write(': hello\n\n');
      sseClients.add(res);
      log('sse client attached, total ' + sseClients.size);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(res); log('sse client gone, left ' + sseClients.size); });
      return;
    } catch (e) { return; }
  }
  if (req.method !== 'POST' || !req.url.startsWith('/rpc')) return send(404, { ok: false, error: 'not found' });

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let rpc;
  try { rpc = JSON.parse(raw || '{}'); } catch { return send(400, { ok: false, error: 'bad json' }); }

  const op = rpc.op;
  const sid = String(rpc.sessionId || DEFAULT_SESSION);

  try {
    // ---- 不需要页面的 op ----
    if (op === 'quit') {
      log('quit requested by session ' + sid);
      setTimeout(() => {
        // attach 来的浏览器不能 close（会整个关掉），只退出进程断开连接
        if (!attachedBrowser) { try { if (context) context.close().catch(() => {}); } catch {} }
        process.exit(0);
      }, 300);
      return send(200, { ok: true });
    }

    if (op === 'status') {
      const pages = context ? context.pages().filter((p) => !p.isClosed()) : [];
      const own = sessions.get(sid);
      const p = own && own.page && !own.page.isClosed() ? own.page : null;
      let url = '', title = '';
      if (p) {
        url = p.url();
        title = await p.title().catch(() => '');
      }
      return send(200, {
        ok: true,
        running: !!context,
        pageCount: pages.length,
        sessionCount: sessions.size,
        sessionId: sid,
        hasPage: !!p,
        activeUrl: url,
        activeTitle: title,
        headless: HEADLESS,
        sessionIdleMs: SESSION_IDLE_MS,
      });
    }

    if (op === 'listsessions') {
      const list = [];
      for (const [id, s] of sessions) {
        list.push({
          sessionId: id,
          url: s.page && !s.page.isClosed() ? s.page.url() : '(closed)',
          idleMs: Date.now() - s.lastActive,
        });
      }
      return send(200, { ok: true, sessions: list });
    }

    if (op === 'closesession') {
      const s = sessions.get(sid);
      if (!s) return send(200, { ok: true, closed: false, reason: 'no such session' });
      const live = context ? context.pages().filter((p) => !p.isClosed()) : [];
      if (live.length <= 1) { sessions.delete(sid); return send(200, { ok: true, closed: false, reason: 'last page kept' }); }
      try { await s.page.close(); } catch {}
      sessions.delete(sid);
      return send(200, { ok: true, closed: true });
    }

    if (op === 'listpages') {
      const pages = context ? context.pages().filter((p) => !p.isClosed()) : [];
      const list = [];
      for (const p of pages) {
        list.push({ url: p.url(), title: await p.title().catch(() => ''), session: ownerOf(p) });
      }
      return send(200, { ok: true, pages: list });
    }

    // 网络日志：本 session 页面最近抓到的 xhr/fetch 响应（含 JSON）
    if (op === 'get_network_log') {
      const s = sessions.get(sid);
      if (!s) return send(200, { ok: true, sessionId: sid, total: 0, seq: 0, entries: [] });
      if (s.page && !s.page.isClosed()) attachNet(s, s.page);
      const st = netState(s);
      if (rpc.clear) st.entries = [];
      let list = st.entries;
      if (rpc.urlFilter) list = list.filter((e) => e.url.includes(String(rpc.urlFilter)));
      if (rpc.sinceSeq) list = list.filter((e) => e.i > Number(rpc.sinceSeq));
      const limit = Math.min(Math.max(Number(rpc.limit) || 30, 1), 100);
      // 总量预算：别一次回几十兆 JSON 把调用方打爆
      const budget = Math.min(Math.max(Number(rpc.maxBytes) || 1_500_000, 50_000), 8_000_000);
      const picked = [];
      let used = 0;
      for (let k = list.length - 1; k >= 0 && picked.length < limit; k--) {
        const e = list[k];
        let size = 0;
        try {
          size = e.json ? JSON.stringify(e.json).length : (e.text ? e.text.length : 0);
        } catch { size = 0; }
        if (used + size > budget) {
          picked.unshift({ ...e, json: null, text: '(omitted: response too large)', omitted: true });
          continue;
        }
        used += size;
        picked.unshift(e);
      }
      return send(200, {
        ok: true,
        sessionId: sid,
        total: st.entries.length,
        returned: picked.length,
        seq: st.seq,
        bytes: used,
        entries: picked,
      });
    }

    // ---- 需要页面的 op ----
    await ensureBrowser();
    const sess = await getSession(sid, true);
    if (!sess || !sess.page) return send(500, { ok: false, error: 'no page for session ' + sid });
    // 上一轮 eval 把页面卡过 → 先自愈（reload，不行就换新页）
    if (sess.wedged) await unwedge(sess);
    if (!sess.page || sess.page.isClosed()) return send(500, { ok: false, error: 'page crashed', sessionId: sid });
    const page = sess.page;

    return await serialize(sess, async () => {
      switch (op) {
        case 'goto': {
          if (!rpc.url) return send(400, { ok: false, error: 'url required' });
          await page.goto(rpc.url, { timeout: rpc.timeout || 30000, waitUntil: rpc.waitUntil || 'domcontentloaded' });
          await sleep(300);
          attachDomWatcher(page).catch(() => {});
          return send(200, { ok: true, sessionId: sid, ...(await snapshotOf(page, sess)) });
        }
        case 'back': {
          await page.goBack({ timeout: 20000 }).catch(() => {});
          await sleep(300);
          attachDomWatcher(page).catch(() => {});
          return send(200, { ok: true, sessionId: sid, ...(await snapshotOf(page, sess)) });
        }
        case 'forward': {
          await page.goForward({ timeout: 20000 }).catch(() => {});
          await sleep(300);
          attachDomWatcher(page).catch(() => {});
          return send(200, { ok: true, sessionId: sid, ...(await snapshotOf(page, sess)) });
        }
        case 'reload': {
          await page.reload({ timeout: 25000 }).catch(() => {});
          await sleep(400);
          attachDomWatcher(page).catch(() => {});
          return send(200, { ok: true, sessionId: sid, ...(await snapshotOf(page, sess)) });
        }
        case 'snapshot': {
          const snap = await snapshotOf(page, sess);
          return send(200, { ok: true, sessionId: sid, pageCount: countPages(), ...snap });
        }
        case 'text': {
          const r = await textOf(page);
          if (!r.ok) return send(500, { ok: false, error: r.error });
          return send(200, { ok: true, text: r.text.slice(0, rpc.limit || 20000) });
        }
        case 'click': {
          const i = rpc.i ?? rpc.index;
          if (i == null && !rpc.selector) return send(400, { ok: false, error: 'i or selector required' });
          let hit;
          try {
            hit = await clickTarget(page, sess, { i, selector: rpc.selector });
          } catch (e) {
            // 点击本身失败（被遮挡/不可点）不算漂移，原样报
            return send(500, { ok: false, error: 'click failed: ' + e.message, op });
          }
          if (hit.gone) {
            const snap = await snapshotOf(page, sess);
            return send(409, {
              ok: false,
              code: 'ELEMENT_GONE',
              error: hit.hits ? '编号 [' + i + '] 已漂移且无法唯一确定（命中 ' + hit.hits + ' 个）' : '编号 [' + i + '] 对应的元素已消失',
              i,
              snapshot: snap,
            });
          }
          const snap = await afterAction(page, sess);
          return send(200, { ok: true, sessionId: sid, via: hit.via, ...snap });
        }
        case 'type': {
          const i = rpc.i ?? rpc.index;
          const tsel = rpc.selector;
          if (i == null && !tsel) return send(400, { ok: false, error: 'i or selector required' });
          if (rpc.text == null) return send(400, { ok: false, error: 'text required' });
          // 一个选择器可能匹配到多个元素（抖音评论区里就有两个 Draft.js 编辑器，
          // 第一个是 0×0 的隐藏备用）—— 必须挑「看得见」的那个，否则点它必然超时。
          const loc0 = tsel
            ? page.locator(tsel)
            : page.locator('[data-star-i="' + i + '"]');
          let loc = loc0.first();
          const total = await loc0.count().catch(() => 1);
          if (total > 1) {
            for (let k = 0; k < total; k++) {
              const cand = loc0.nth(k);
              const box = await cand.boundingBox().catch(() => null);
              if (box && box.width > 2 && box.height > 2) { loc = cand; break; }
            }
          }
          if (!tsel) {
            const cnt = await loc.count().catch(() => 0);
            if (cnt === 0) {
              return send(409, {
                ok: false,
                code: 'ELEMENT_GONE',
                error: '编号 [' + i + '] 对应的输入框已消失（页面变了）',
                i,
                snapshot: await snapshotOf(page, sess),
              });
            }
          }
          await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          // 点一下让元素获得焦点；有些输入框（比如抖音图文页收起状态的 Draft.js 编辑器）
          // 虽然挂在 DOM 里但尺寸为 0，Playwright 的 click 会报 element is not visible。
          // 这时候退化成 JS focus —— 键盘事件照样能进去，不必要求可见。
          let viaClick = true;
          try {
            await loc.click({ timeout: 5000 });
          } catch (e) {
            viaClick = false;
            await loc.evaluate((el) => { try { el.focus(); } catch {} }).catch(() => {});
            await sleep(150);
          }
          if (rpc.replace) await loc.fill(rpc.text);
          else await loc.pressSequentially(rpc.text, { delay: 8 });
          return send(200, { ok: true, focusedBy: viaClick ? 'click' : 'js' });
        }
        case 'press': {
          if (!rpc.key) return send(400, { ok: false, error: 'key required' });
          await page.keyboard.press(rpc.key);
          await sleep(250);
          return send(200, { ok: true });
        }
        case 'scroll': {
          const d = rpc.direction || 'down';
          if (d === 'top') await page.evaluate(() => window.scrollTo(0, 0));
          else if (d === 'bottom') await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          else await page.mouse.wheel(0, (rpc.amount || 600) * (d === 'up' ? -1 : 1));
          await sleep(250);
          return send(200, { ok: true });
        }
        case 'wait': {
          await sleep(rpc.ms || 1000);
          return send(200, { ok: true });
        }
        case 'newpage': {
          // 给这个 session 换一张新页（旧页若是空白就关掉，有内容则留着）
          const fresh = await context.newPage();
          const old = sess.page;
          sess.page = fresh;
          sess.fps = new Map();
          sess.lastActive = Date.now();
          if (old && old !== fresh && !old.isClosed() && old.url() === 'about:blank' && countPages() > 1) {
            try { await old.close(); } catch {}
          }
          if (rpc.url) {
            await fresh.goto(rpc.url, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
            await sleep(300);
          }
          return send(200, { ok: true, sessionId: sid, ...(await snapshotOf(fresh, sess)) });
        }
        case 'switchpage': {
          const pages = context.pages().filter((p) => !p.isClosed());
          const target = (rpc.index != null) ? pages[rpc.index]
            : pages.find((p) => p.url().includes(rpc.urlPart || '')) || pages[rpc.index || 0];
          if (!target) return send(404, { ok: false, error: 'page not found' });
          sess.page = target;
          sess.fps = new Map();
          try { await target.bringToFront(); } catch {}
          return send(200, { ok: true, sessionId: sid, ...(await snapshotOf(target, sess)) });
        }
        case 'screenshot': {
          const nm = (rpc.name || ('shot-' + Date.now())) + '.png';
          const fp = path.join(SHOTS, nm);
          const opts = { path: fp, fullPage: !!rpc.fullPage };
          // 区域截图：clip 是**页面坐标**（不是视口坐标），调用方要自己加上
          // scrollX/scrollY。只截视频画面就靠它（2026-10-22 加）。
          if (rpc.clip && typeof rpc.clip === 'object' && !opts.fullPage) {
            const c = rpc.clip;
            const x = Number(c.x);
            const y = Number(c.y);
            const w = Number(c.width);
            const h = Number(c.height);
            if ([x, y, w, h].every(Number.isFinite) && w > 1 && h > 1) {
              opts.clip = { x: Math.max(0, x), y: Math.max(0, y), width: w, height: h };
            } else {
              return send(400, { ok: false, error: 'clip 需要合法的 {x,y,width,height}' });
            }
          }
          await page.screenshot(opts);
          return send(200, { ok: true, path: fp });
        }
        case 'close': {
          const pages = context.pages().filter((p) => !p.isClosed());
          let target = page;
          if (rpc.index != null && pages[rpc.index]) target = pages[rpc.index];
          if (target && pages.length > 1) await target.close().catch(() => {});
          const rest = countPages();
          if (sess.page && sess.page.isClosed()) {
            const next = context.pages().find((p) => !p.isClosed());
            if (next) { sess.page = next; sess.fps = new Map(); }
          }
          return send(200, { ok: true, pageCount: rest });
        }
        case 'eval': {
          const timeoutMs = Math.min(Math.max(Number(rpc.timeout) || EVAL_TIMEOUT_MS, 500), 60000);
          const r = await evalWithTimeout(page, rpc.expression, timeoutMs);
          if (!r.ok) {
            // 中断指令发出去就不管了：页面卡死时 send() 可能永远不 resolve，
            // await 它连 504 都回不去（第一次实现就是这么翻车的）
            terminatePageExecution(page, 2000).catch(() => {});
            sess.wedged = true;
            return send(504, {
              ok: false,
              code: 'EVAL_TIMEOUT',
              error: 'eval 超过 ' + timeoutMs + 'ms，已发出中断指令。页面若仍无响应，下一次操作会自动 reload 自愈。',
              timeoutMs,
            });
          }
          sess.wedged = false;
          return send(200, { ok: true, result: r.result });
        }
        default:
          return send(400, { ok: false, error: 'unknown op: ' + op });
      }
    });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log('rpc error [' + op + '/' + sid + ']:', msg);
    if (/browser.*closed|context.*closed|Target closed|page.*closed|crash/i.test(msg)) {
      // 同一 session 的页跟着没了就清掉，下次自动重建
      const s = sessions.get(sid);
      if (s && (!s.page || s.page.isClosed())) sessions.delete(sid);
      // 整个 context 死了才清（attach 的只丢引用，绝不 close）
      try {
        const alive = context ? context.pages().filter((p) => !p.isClosed()) : [];
        if (!context || alive.length === 0) {
          if (!attachedBrowser) { try { await context.close(); } catch {} }
          context = null; attachedBrowser = null;
        }
      } catch {
        if (!attachedBrowser) { try { await context.close(); } catch {} }
        context = null; attachedBrowser = null;
      }
      return send(500, { ok: false, error: 'page crashed', op, sessionId: sid });
    }
    return send(500, { ok: false, error: msg, op, sessionId: sid });
  }
});

function countPages() {
  try { return context ? context.pages().filter((p) => !p.isClosed()).length : 0; } catch { return 0; }
}

function ownerOf(page) {
  for (const [id, s] of sessions) if (s.page === page) return id;
  return null;
}

// ------------------------------------------------------------
// 单实例守卫：9443 已有管家在服务 → 本进程直接退出，连 attach 都不做。
// （插件在 9227 不通时可能再拉一个 host，它落 Session 0，起不了带界面的
//   Edge，只会 attach 到已有 CDP 上；那个实例一退出就把浏览器带走了。）
// ------------------------------------------------------------
try {
  const existingHost = await fetch('http://127.0.0.1:' + PORT + '/health', { signal: AbortSignal.timeout(1500) });
  if (existingHost.ok) {
    log('another host already serving ' + PORT + ', exiting without touching the browser');
    process.exit(0);
  }
} catch { /* 没有别的管家，正常启动 */ }

server.listen(PORT, '127.0.0.1', async () => {
  log('star-browser host v2 listening on http://127.0.0.1:' + PORT +
    ' (headless=' + HEADLESS + ', sessionIdle=' + Math.round(SESSION_IDLE_MS / 1000) + 's)');
  try { await ensureBrowser(); await dropOrphanBlanks(); log('browser ready at startup'); }
  catch (e) { log('startup ensureBrowser failed: ' + e.message); }
});

process.on('uncaughtException', (e) => log('uncaught:', e && e.message));
process.on('unhandledRejection', (e) => log('unhandled:', e && e.message));
