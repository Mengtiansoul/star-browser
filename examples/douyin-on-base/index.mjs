// ============================================================
// 抖音插件（基于 star-browser 基座 v0.3.0）
//
// 能力：
//   · 专属 sessionId、接口 JSON（不走 DOM）、eval 注入滑动/点击
//   · 每日状态存储 + 防沉迷计时 + 转发配额 + 质量闸门
//
// 安装：dsh plugin add link:D:/Deepseek-Harness/Fan_xing/browser/examples/douyin-on-base
// 依赖：star-browser 管家在线（star-browser --detach）
//
// ════════════════════════════════════════════════════════════
// 实测结论（2026-10-22，Edge 155 + 已登录抖音号；改代码前先看）
// ════════════════════════════════════════════════════════════
// 1) 搜索页走 XHR：/aweme/v1/web/general/search/single/ → data[].aweme_info
//    有 aweme_id / desc / author / statistics，单条约 900KB。
// 2) **推荐流不走 XHR**（React Server Components 首屏直出），网络日志只有
//    danmaku / stats / history 旁路请求，feed 元数据只能读 DOM。
// 3) 滑动：合成 KeyboardEvent(ArrowDown) 有效，被拦退 press。
// 4) 点赞/收藏按钮 **getBoundingClientRect 是 0x0**，Playwright 普通 click 被
//    「element is not visible」拦，必须派发完整鼠标序列（pointerdown →
//    mousedown → pointerup → mouseup → click）。
// 5) 评论框要先点占位符（.comment-input-inner-container 里的 div._x9Gwl7G）
//    才会挂出 Draft.js 编辑器；Draft.js 只认真键盘（管家的 type 可用）。
//    清空 = Control+a + Delete（会剩一个 \n，是空状态）。
// 6) 点赞数在 DOM：`[data-e2e="video-player-digg"]` 的 innerText，
//    实测值是 "7.9万" 这种短单位格式 → 必须写单位解析。
// 7) 分享面板（点 video-player-share）里实测能看到：
//    「分享给朋友」分组 + 群条目（如「八方来财 65 分享」）+ 好友条目 +
//    「复制链接」按钮。**但入口存在 ≠ 送达可靠**：旧插件实测点完后群里
//    收不到、回执永远是「未确认」。所以 douyin_share 默认 dryRun，
//   真发送要显式 send:true，且结果标 uncertain（不谎报送达）。
// 8) 点赞/收藏/发评论都是对外可见动作；发评论默认只填草稿。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'douyin-on-base';
const inject = ['tools'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(HERE, 'state.json');

const HOST = (process.env.STAR_BROWSER_HOST || 'http://127.0.0.1:9443').replace(/\/+$/, '');
const SESSION_ID = process.env.DOUYIN_SESSION_ID || 'douyin-worker-1';
const RPC_TIMEOUT = 60000;

/** 每日浏览上限（秒） */
const BROWSE_LIMIT_SEC = Number(process.env.DOUYIN_BROWSE_LIMIT_SEC || 3600);
/** 两次 douyin_next 间隔在 [1s, 120s] 内才计入浏览时长 */
const MIN_GAP_MS = 1000;
const MAX_GAP_MS = 120000;
/** 转发配额 */
const GROUP_FORWARD_LIMIT = Number(process.env.DOUYIN_GROUP_FORWARD_LIMIT || 5);
const PRIVATE_FORWARD_LIMIT = Number(process.env.DOUYIN_PRIVATE_FORWARD_LIMIT || 3);
/** 质量闸门：点赞数低于这个值不许互动 */
const MIN_DIGG = Number(process.env.DOUYIN_MIN_DIGG || 5000);

const OUTPUT_TEXT = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// 状态存储（每日重置）
// ------------------------------------------------------------
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function blankState() {
  return {
    date: today(),
    browseSeconds: 0,
    groupForwards: 0,
    privateForwards: 0,
    lastNextTime: 0,
    likes: 0,
    favorites: 0,
    comments: 0,
    skippedLowQuality: 0,
  };
}

const NUMERIC_KEYS = ['browseSeconds', 'groupForwards', 'privateForwards', 'lastNextTime', 'likes', 'favorites', 'comments', 'skippedLowQuality'];

/** 读 state.json；跨天自动清零 */
function loadState() {
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { /* 第一次跑或文件坏了 */ }
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    s = blankState();
    saveState(s);
    return s;
  }
  if (s.date !== today()) {
    s = blankState();
    saveState(s);
    return s;
  }
  for (const k of NUMERIC_KEYS) {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) s[k] = 0;
  }
  return s;
}

function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch { /* 只读环境下不致命，但计时会丢 */ }
}

/** 浏览时长到了没有 */
function browseBlocked(st) {
  return st.browseSeconds >= BROWSE_LIMIT_SEC;
}

function browseBlockedText(st) {
  const mins = Math.round(st.browseSeconds / 60);
  return `⛔ 今日浏览已达上限（${Math.round(BROWSE_LIMIT_SEC / 60)} 分钟，已刷 ${mins} 分钟），不再下滑。\n` +
    `明天 0 点自动重置（state.json 的 date 变了就清零）。`;
}

// ------------------------------------------------------------
// 数值解析："7.9万" / "1.2w" / "1,234" / "3.1亿"
// ------------------------------------------------------------
function parseCount(text) {
  const s = String(text == null ? '' : text).replace(/[,，\s]/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(亿|万|w|W|e|k|K)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  if (unit === '万' || unit === 'w' || unit === 'W') n *= 1e4;
  else if (unit === '亿' || unit === 'e') n *= 1e8;
  else if (unit === 'k' || unit === 'K') n *= 1e3;
  return Math.round(n);
}

// ------------------------------------------------------------
// RPC 基础
// ------------------------------------------------------------
async function rpc(op, body = {}) {
  const res = await fetch(HOST + '/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, sessionId: SESSION_ID, ...body }),
    signal: AbortSignal.timeout(RPC_TIMEOUT),
  });
  return await res.json();
}

async function hostAlive() {
  try {
    const r = await fetch(HOST + '/health', { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

const HOST_DOWN = '❌ 浏览器基座没在跑。先起它：star-browser --detach';

/** 最近一次搜索的结果（给 douyin_open 按序号打开用） */
let lastAwemes = [];

// ------------------------------------------------------------
// 页面脚本片段
// ------------------------------------------------------------
/** 派发完整鼠标序列（0x0 的隐藏按钮也能触发 React） */
const fireClick = (e2e) => `(() => {
  const d = document.querySelector('[data-e2e="${e2e}"]');
  if (!d) return { ok: false, error: '元素不存在: ${e2e}' };
  const r = d.getBoundingClientRect();
  const o = {
    bubbles: true, cancelable: true, view: window,
    clientX: r.x + Math.max(1, r.width / 2),
    clientY: r.y + Math.max(1, r.height / 2),
    button: 0,
  };
  d.dispatchEvent(new PointerEvent('pointerdown', o));
  d.dispatchEvent(new MouseEvent('mousedown', o));
  d.dispatchEvent(new PointerEvent('pointerup', o));
  d.dispatchEvent(new MouseEvent('mouseup', o));
  d.dispatchEvent(new MouseEvent('click', o));
  return { ok: true, rect: [Math.round(r.width), Math.round(r.height)] };
})()`;

const reactionState = (e2e) => `(() => {
  const d = document.querySelector('[data-e2e="${e2e}"]');
  return d ? (d.getAttribute('data-e2e-state') || '') : '';
})()`;

/** 点赞数字文本（"7.9万" 这种） */
const DIGG_TEXT_EXPR = `(() => {
  const d = document.querySelector('[data-e2e="video-player-digg"]');
  return d ? (d.innerText || '').trim() : '';
})()`;

const STATE_EXPR = `(() => {
  const vids = [...document.querySelectorAll('video')];
  const v = vids.find((x) => !x.paused) || vids[0] || null;
  const diggEl = document.querySelector('[data-e2e="video-player-digg"]');
  return {
    url: location.href,
    title: document.title || '',
    playing: v ? !v.paused : false,
    currentTime: v ? Math.round(v.currentTime) : 0,
    duration: v ? Math.round(v.duration || 0) : 0,
    videoCount: vids.length,
    diggText: diggEl ? (diggEl.innerText || '').trim() : '',
    diggState: diggEl ? (diggEl.getAttribute('data-e2e-state') || '') : '',
    collectState: document.querySelector('[data-e2e="video-player-collect"]')?.getAttribute('data-e2e-state') || '',
    commentOpen: !!document.querySelector('.comment-input-inner-container [contenteditable="true"]'),
  };
})()`;

/** 合成 ArrowDown：抖音网页版靠这个换下一条 */
const SLIDE_EXPR = `(() => {
  const ev = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true };
  window.dispatchEvent(new KeyboardEvent('keydown', ev));
  document.dispatchEvent(new KeyboardEvent('keydown', ev));
  const v = document.querySelector('video');
  if (v && v.paused) v.play().catch(() => {});
  return true;
})()`;

async function evalOnPage(expression, timeout = 15000) {
  const r = await rpc('eval', { expression, timeout });
  if (!r.ok) throw new Error(r.error || 'eval failed');
  return r.result;
}

async function pageState() {
  return await evalOnPage(STATE_EXPR, 8000);
}

// ------------------------------------------------------------
// 质量闸门
// ------------------------------------------------------------
/**
 * 当前视频的点赞数。
 * 优先用接口里带过来的 aweme 数据（搜索过来的那条），否则读 DOM 文本。
 * @returns {{count:number|null, source:string, raw:string}}
 */
async function currentQuality() {
  // 1) 接口数据：URL 里如果有 video/<id>，在最近一次搜索缓存里找
  const st = await pageState().catch(() => null);
  const url = (st && st.url) || '';
  const idMatch = url.match(/\/video\/(\d+)/);
  if (idMatch) {
    const hit = lastAwemes.find((a) => a.aweme_id === idMatch[1]);
    if (hit && typeof hit.digg === 'number') {
      return { count: hit.digg, source: 'api(search)', raw: String(hit.digg) };
    }
  }
  // 2) DOM 文本
  const raw = await evalOnPage(DIGG_TEXT_EXPR, 8000).catch(() => '');
  return { count: parseCount(raw), source: 'dom', raw: String(raw || '') };
}

/** 互动前的统一闸门：返回 null 表示放行，否则返回拦截文案 */
async function qualityGate(actionLabel, st) {
  const q = await currentQuality();
  if (q.count == null) {
    // 解析不出来就放行但提示（避免因为页面改版直接把功能全卡死）
    return { blocked: false, note: `⚠️ 没能解析点赞数（原文「${q.raw}」），这次不做质量判定` };
  }
  if (q.count < MIN_DIGG) {
    st.skippedLowQuality += 1;
    saveState(st);
    return {
      blocked: true,
      text: `⛔ 视频质量未达标（点赞 ${q.count} < ${MIN_DIGG}），跳过${actionLabel}，建议直接滑走：\n` +
        `  douyin_next\n（今天已因质量跳过 ${st.skippedLowQuality} 次）`,
    };
  }
  return { blocked: false, note: `点赞数 ${q.count}（${q.source}）≥ ${MIN_DIGG}，放行` };
}

// ------------------------------------------------------------
// 网络日志 → 视频列表
// ------------------------------------------------------------
function awemesFromEntry(entry) {
  const j = entry && entry.json;
  if (!j || !Array.isArray(j.data)) return [];
  const out = [];
  for (const item of j.data) {
    const a = item && item.aweme_info;
    if (!a) continue;
    out.push({
      aweme_id: a.aweme_id,
      desc: (a.desc || '').slice(0, 120),
      author: (a.author && (a.author.nickname || a.author.unique_id)) || '',
      create_time: a.create_time,
      duration_ms: a.video && a.video.duration,
      digg: a.statistics && a.statistics.digg_count,
      comment: a.statistics && a.statistics.comment_count,
      share: a.statistics && a.statistics.share_count,
      url: a.aweme_id ? 'https://www.douyin.com/video/' + a.aweme_id : '',
    });
  }
  return out;
}

async function searchAwemes(keyword, { limit = 20, reopen = true } = {}) {
  if (reopen) {
    await rpc('goto', { url: 'https://www.douyin.com/search/' + encodeURIComponent(keyword) });
    await sleep(6500);
  }
  const log = await rpc('get_network_log', {
    limit: 20,
    urlFilter: 'general/search',
    maxBytes: 6_000_000,
  });
  if (!log.ok) throw new Error(log.error || 'get_network_log failed');
  const entries = (log.entries || []).filter((e) => e.json);
  for (let i = entries.length - 1; i >= 0; i--) {
    const list = awemesFromEntry(entries[i]);
    if (list.length) return { source: entries[i].url, total: list.length, items: list.slice(0, limit) };
  }
  return { source: null, total: 0, items: [], hint: '没截到可解析的 search 接口（页面可能还没加载完，或接口结构变了）' };
}

// ------------------------------------------------------------
// 点赞 / 收藏
// ------------------------------------------------------------
async function setReaction(e2e, want) {
  const before = await evalOnPage(reactionState(e2e), 8000);
  const isOn = String(before).includes('is-');
  if (isOn === want) return { changed: false, before, after: before, note: '已经是目标状态，没动' };
  const click = await evalOnPage(fireClick(e2e), 8000);
  if (!click || !click.ok) throw new Error((click && click.error) || '没找到按钮');
  await sleep(1200);
  const after = await evalOnPage(reactionState(e2e), 8000);
  return { changed: after !== before, before, after };
}

// ------------------------------------------------------------
// 评论区
// ------------------------------------------------------------
const COMMENT = {
  check: `(() => !!document.querySelector('.comment-input-inner-container [contenteditable="true"]'))()`,
  activate: `(() => {
    const box = document.querySelector('.comment-input-inner-container');
    if (!box) return { ok: false, error: '评论输入区还没出现' };
    const ph = box.querySelector('._x9Gwl7G') || box.querySelector('span.RXtfhfhu') || box;
    const r = ph.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window,
      clientX: r.x + Math.min(60, Math.max(1, r.width / 2)), clientY: r.y + Math.max(1, r.height / 2), button: 0 };
    ph.dispatchEvent(new PointerEvent('pointerdown', o));
    ph.dispatchEvent(new MouseEvent('mousedown', o));
    ph.dispatchEvent(new PointerEvent('pointerup', o));
    ph.dispatchEvent(new MouseEvent('mouseup', o));
    ph.dispatchEvent(new MouseEvent('click', o));
    ph.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    return { ok: true };
  })()`,
  editorSel: '.comment-input-inner-container [contenteditable="true"]',
  text: `(() => {
    const ed = document.querySelector('.comment-input-inner-container [contenteditable="true"]');
    return ed ? (ed.innerText || '').trim() : null;
  })()`,
  focus: `(() => {
    const ed = document.querySelector('.comment-input-inner-container [contenteditable="true"]');
    if (!ed) return false;
    ed.focus();
    return true;
  })()`,
};

async function ensureCommentBox() {
  if (await evalOnPage(COMMENT.check, 8000)) return true;
  await evalOnPage(fireClick('feed-comment-icon'), 8000).catch(() => {});
  await sleep(2200);
  if (await evalOnPage(COMMENT.check, 8000)) return true;
  await evalOnPage(COMMENT.activate, 8000);
  await sleep(1200);
  return !!(await evalOnPage(COMMENT.check, 8000));
}

// ------------------------------------------------------------
// 分享 / 转发
// ------------------------------------------------------------
/** 打开分享面板并列出可选的转发目标（只读，不点） */
const listShareTargets = `(() => {
  const items = [...document.querySelectorAll('div,span,button')]
    .filter((e) => {
      const t = (e.innerText || '').trim();
      if (!t || t.length > 24) return false;
      if (e.children.length > 2) return false;
      if (/(分享|回复)/.test(t) && t.split('\\n').length > 1) return false;   // 跳过评论区的「N 分享 回复」
      return /(分享|群|好友|复制链接|微信|QQ|朋友圈|微博)/.test(t);
    })
    .map((e) => {
      const raw = (e.innerText || '').trim().replace(/\\s+/g, ' ');
      // 抖音的条目文字会带后缀：「八方来财 65 分享」「某某24分钟前在线分享」「复制链接抖音 app 扫码观看」
      // 给一个可当 target 用的干净名字，raw 保留原样
      const name = raw
        .replace(/\\s*抖音\\s*app\\s*扫码观看$/i, '')
        .replace(/\\s*\\d+\\s*分钟前在线\\s*/g, ' ')
        .replace(/\\s*分享$/g, '')
        .replace(/\\s+/g, ' ')
        .trim();
      return { raw, name };
    })
    .filter((v, i, a) => a.findIndex((x) => x.raw === v.raw) === i);
  return JSON.stringify({ count: items.length, items: items.slice(0, 20) });
})()`;

/**
 * 点某个分享目标。
 * 用**包含匹配**而不是全等：面板里的文字是「八方来财 65 分享」这种，
 * target 传「八方来财」也命中。命中多个时取文本最短、层级最浅的那个
 * （避免点到把整块包住的外层容器）。
 */
const clickShareTarget = (label) => `(() => {
  const want = ${JSON.stringify(label)};
  const cands = [...document.querySelectorAll('div,span,button')]
    .filter((e) => {
      const t = (e.innerText || '').trim().replace(/\\s+/g, ' ');
      if (e.children.length > 2) return false;
      // startsWith 优先：面板条目是「八方来财 65 分享」这种，
      // 而评论区的「@八方来财 你说得对」也能 includes 命中 → 会点错地方
      return t.startsWith(want) || t.includes(want);
    })
    .sort((a, b) => {
      const ta = (a.innerText || '').trim().replace(/\\s+/g, ' ');
      const tb = (b.innerText || '').trim().replace(/\\s+/g, ' ');
      const sa = ta.startsWith(want) ? 0 : 1;
      const sb = tb.startsWith(want) ? 0 : 1;
      return sa - sb || ta.length - tb.length || a.children.length - b.children.length;
    });
  if (!cands.length) return { ok: false, error: '没找到目标: ' + want };
  const el = cands[0];
  const matched = (el.innerText || '').trim().replace(/\\s+/g, ' ');
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, view: window,
    clientX: r.x + Math.max(1, r.width / 2), clientY: r.y + Math.max(1, r.height / 2), button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new MouseEvent('mousedown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.dispatchEvent(new MouseEvent('click', o));
  return { ok: true, matched, startsWith: matched.startsWith(want) };
})()`;

// ------------------------------------------------------------
// 工具注册
// ------------------------------------------------------------
async function withHost(fn, label) {
  if (!(await hostAlive())) return { text: HOST_DOWN };
  try {
    return await fn();
  } catch (e) {
    return { text: '❌ douyin_' + label + ' 失败: ' + ((e && e.message) || e) };
  }
}

async function apply(ctx) {
  const logger = ctx.logger;
  const tools = [];

  const WORKFLOW_HINT =
    '刷推荐流的标准循环：douyin_state 看进度（顺便看点赞数）→ 达标就 douyin_next ' +
    '（一次一条，别连点）→ 想互动再 douyin_like / douyin_favorite / douyin_comment。' +
    `注意：点赞数 < ${MIN_DIGG} 的会被质量闸门拦掉；每天浏览上限 ${Math.round(BROWSE_LIMIT_SEC / 60)} 分钟，` +
    '到点 douyin_next 会直接拒绝。';

  // ---- 搜索 ----
  tools.push({
    name: 'douyin_search',
    description: '在抖音搜关键词，返回视频列表(标题/作者/点赞)。数据来自接口 JSON，不解析 DOM。',
    parameters: {
      type: 'object', additionalProperties: false,
      keyword: { type: 'string', description: '搜索关键词' },
      limit: { type: 'number', description: '最多几条(默认 20)' },
    },
    timeoutMs: 90000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
      if (!args.keyword) throw new Error('需要 keyword');
      const r = await searchAwemes(args.keyword, { limit: args.limit || 20 });
      lastAwemes = r.items;
      if (!r.items.length) return { text: '没拿到视频列表。' + (r.hint || '') };
      const lines = [`✅ 从接口拿到 ${r.total} 条（源: ${r.source}）`, ''];
      r.items.forEach((it, i) => {
        const ok = typeof it.digg === 'number' && it.digg >= MIN_DIGG;
        lines.push(`${i + 1}. ${ok ? '' : '⚠️'}${it.desc || '(无标题)'}`);
        lines.push(`   @${it.author} | 赞 ${it.digg ?? '?'}${ok ? '' : `（低于 ${MIN_DIGG}，互动会被拦）`} | 评论 ${it.comment ?? '?'} | ${it.url}`);
      });
      lines.push('', '下一步：douyin_open 序号 打开某条；或 douyin_next 在页面上滑');
      return { text: lines.join('\n') };
    }, 'search'),
  });

  // ---- 打开 ----
  tools.push({
    name: 'douyin_open',
    description: '按 douyin_search 的序号或 aweme_id 打开视频详情页。',
    parameters: {
      type: 'object', additionalProperties: false,
      index: { type: 'number', description: 'douyin_search 结果里的序号(从 1 开始)' },
      aweme_id: { type: 'string', description: '直接给 aweme_id(与 index 二选一)' },
    },
    timeoutMs: 90000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
      let id = args.aweme_id;
      if (!id && args.index) {
        const hit = lastAwemes[args.index - 1];
        id = hit && hit.aweme_id;
      }
      if (!id) throw new Error('需要 index 或 aweme_id（用 index 的话要先跑 douyin_search）');
      const r = await rpc('goto', { url: 'https://www.douyin.com/video/' + id });
      if (!r.ok) throw new Error(r.error || 'goto failed');
      await sleep(1500);
      const st = await pageState().catch(() => null);
      return {
        text: `✅ 已打开 ${id}\n标题: ${(st && st.title) || r.title || ''}\n` +
          (st ? `播放: ${st.playing ? '是' : '否'} | ${st.currentTime}s/${st.duration}s | 点赞 ${st.diggText || '?'}` : ''),
      };
    }, 'open'),
  });

  // ---- 下滑（含防沉迷计时）----
  tools.push({
    name: 'douyin_next',
    description: '往下滑切下一条视频（eval 注入 ArrowDown）。' + WORKFLOW_HINT,
    parameters: {
      type: 'object', additionalProperties: false,
      times: { type: 'number', description: '滑几次(默认 1，最多 10)' },
    },
    timeoutMs: 120000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
      const st = loadState();
      if (browseBlocked(st)) return { text: browseBlockedText(st) };

      const times = Math.min(Math.max(Number(args.times) || 1, 1), 10);
      const moved = [];
      const now = Date.now();

      // 防呆计时：只有「1 秒 ~ 2 分钟」的间隔才算连着刷
      const gap = st.lastNextTime ? now - st.lastNextTime : 0;
      let counted = 0;
      if (st.lastNextTime && gap >= MIN_GAP_MS && gap <= MAX_GAP_MS) {
        counted = Math.round(gap / 1000);
        st.browseSeconds += counted;
      }
      st.lastNextTime = now;
      saveState(st);

      if (browseBlocked(st)) return { text: browseBlockedText(st) };

      for (let i = 0; i < times; i++) {
        const before = await pageState().catch(() => null);
        const r = await rpc('eval', { expression: SLIDE_EXPR, timeout: 8000 });
        if (!r.ok) await rpc('press', { key: 'ArrowDown' });
        await sleep(1000 + Math.floor(Math.random() * 900));
        const after = await pageState().catch(() => null);
        moved.push({ from: before && before.currentTime, to: after && after.currentTime });
      }

      const after = await pageState().catch(() => null);
      const q = after ? parseCount(after.diggText) : null;
      const lines = [`✅ 滑了 ${times} 次`];
      moved.forEach((m, i) => lines.push(`  ${i + 1}. 播放进度 ${m.from ?? '?'}s → ${m.to ?? '?'}s`));
      if (after) {
        lines.push(`当前: ${after.title || '(无标题)'} | 点赞 ${after.diggText || '?'}${q != null && q < MIN_DIGG ? '（低于闸门，别互动）' : ''}`);
      }
      lines.push(`今日浏览: ${Math.round(st.browseSeconds / 60)} 分钟 / 上限 ${Math.round(BROWSE_LIMIT_SEC / 60)} 分钟` +
        (counted ? `（本次 +${counted}s）` : '（间隔太久，这次不计时）'));
      return { text: lines.join('\n') };
    }, 'next'),
  });

  // ---- 状态 ----
  tools.push({
    name: 'douyin_state',
    description: '读当前视频状态：是否在播 / 进度 / 标题 / 点赞数 / 点赞收藏是否已激活 / 评论框。' +
      '刷流时用它监控进度和点赞数（决定该不该互动）。',
    parameters: { type: 'object', additionalProperties: false },
    timeoutMs: 45000,
    output: OUTPUT_TEXT,
    execute: () => withHost(async () => {
      const st = await pageState();
      const s = loadState();
      const on = (x) => (String(x).includes('is-') ? '已' : '未');
      const digg = parseCount(st.diggText);
      return {
        text: [
          `网址: ${st.url}`,
          `标题: ${st.title || '(无)'}`,
          `播放: ${st.playing ? '是' : '否'} | ${st.currentTime}s / ${st.duration}s | 视频元素 ${st.videoCount} 个`,
          `点赞: ${on(st.diggState)}（${st.diggText || '?'}${digg != null ? ' ≈ ' + digg : ''}）| 收藏: ${on(st.collectState)} | 评论框: ${st.commentOpen ? '已打开' : '未打开'}`,
          `质量闸门: ${digg == null ? '解析不出点赞数，本次不判' : digg >= MIN_DIGG ? '达标（可互动）' : `未达标（< ${MIN_DIGG}，互动会被拦）`}`,
          `今日: 浏览 ${Math.round(s.browseSeconds / 60)}/${Math.round(BROWSE_LIMIT_SEC / 60)} 分钟 | 赞 ${s.likes} 藏 ${s.favorites} 评 ${s.comments} | 转发 群 ${s.groupForwards}/${GROUP_FORWARD_LIMIT} 私 ${s.privateForwards}/${PRIVATE_FORWARD_LIMIT}`,
        ].join('\n'),
      };
    }, 'state'),
  });

  // ---- 点赞 ----
  tools.push({
    name: 'douyin_like',
    description: `给当前视频点赞（对外可见）。已点过不会重复点。传 action=unlike 取消。` +
      `点赞数低于 ${MIN_DIGG} 会被质量闸门拦掉。`,
    parameters: {
      type: 'object', additionalProperties: false,
      action: { type: 'string', description: 'like(默认) / unlike' },
    },
    timeoutMs: 60000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
      const st = loadState();
      const want = (args.action || 'like') === 'like';
      const gate = await qualityGate('点赞', st);
      if (gate.blocked) return { text: gate.text };
      const r = await setReaction('video-player-digg', want);
      if (r.changed) { st.likes += want ? 1 : -1; if (st.likes < 0) st.likes = 0; saveState(st); }
      if (!r.changed && r.note) return { text: `没动：点赞${want ? '已经是开着的' : '本来就是关着的'}（${r.after}）` };
      return {
        text: (want ? '✅ 已点赞' : '✅ 已取消点赞') + `\n状态: ${r.before || '(空)'} → ${r.after || '(空)'}` +
          (gate.note ? '\n' + gate.note : '') +
          (r.changed ? '' : '\n⚠️ 状态没变化，可能被风控或页面结构变了'),
      };
    }, 'like'),
  });

  // ---- 收藏 ----
  tools.push({
    name: 'douyin_favorite',
    description: `收藏当前视频（对外可见）。已收藏不会重复。传 action=off 取消。` +
      `点赞数低于 ${MIN_DIGG} 会被质量闸门拦掉。`,
    parameters: {
      type: 'object', additionalProperties: false,
      action: { type: 'string', description: 'on(默认) / off' },
    },
    timeoutMs: 60000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
      const st = loadState();
      const want = (args.action || 'on') !== 'off';
      const gate = await qualityGate('收藏', st);
      if (gate.blocked) return { text: gate.text };
      const r = await setReaction('video-player-collect', want);
      if (r.changed) { st.favorites += want ? 1 : -1; if (st.favorites < 0) st.favorites = 0; saveState(st); }
      if (!r.changed && r.note) return { text: `没动：收藏${want ? '已经收藏过了' : '本来就没收藏'}（${r.after}）` };
      return {
        text: (want ? '✅ 已收藏' : '✅ 已取消收藏') + `\n状态: ${r.before || '(空)'} → ${r.after || '(空)'}` +
          (gate.note ? '\n' + gate.note : '') +
          (r.changed ? '' : '\n⚠️ 状态没变化，可能被风控或页面结构变了'),
      };
    }, 'favorite'),
  });

  // ---- 评论 ----
  tools.push({
    name: 'douyin_comment',
    description: `在当前视频下写评论。默认只填草稿不发送；要真发必须传 send=true。` +
      `点赞数低于 ${MIN_DIGG} 会被质量闸门拦掉。` + WORKFLOW_HINT,
    parameters: {
      type: 'object', additionalProperties: false,
      text: { type: 'string', description: '评论内容' },
      send: { type: 'boolean', description: 'true=真的发出去(对外可见)；默认 false 只填草稿' },
      clear: { type: 'boolean', description: 'true=先清空输入框' },
    },
    timeoutMs: 90000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
      const st = loadState();
      const gate = await qualityGate('评论', st);
      if (gate.blocked) return { text: gate.text };

      const opened = await ensureCommentBox();
      if (!opened) return { text: '❌ 没打开评论输入框（评论区可能没加载出来，先 douyin_state 看看是不是在视频页）' };
      if (args.clear) {
        await evalOnPage(COMMENT.focus, 8000);
        await rpc('press', { key: 'Control+a' });
        await rpc('press', { key: 'Delete' });
        await sleep(400);
      }
      if (!args.text && !args.clear) throw new Error('需要 text，或 clear=true 先清空');
      if (args.text) {
        const t = await rpc('type', { selector: COMMENT.editorSel, text: String(args.text), replace: !!args.clear });
        if (!t.ok) throw new Error(t.error || '输入失败');
        await sleep(500);
      }
      const draft = await evalOnPage(COMMENT.text, 8000);
      const lines = [`草稿内容: ${draft === null ? '(输入框不见了)' : JSON.stringify(draft)}`];
      if (args.send) {
        if (!draft) return { text: lines.concat('⚠️ 草稿是空的，没有发送').join('\n') };
        await rpc('press', { key: 'Enter' });
        await sleep(1500);
        const after = await evalOnPage(COMMENT.text, 8000);
        if (after) {
          lines.push('⚠️ 按了回车但输入框还有内容，可能没发出去（风控/需要点发送按钮）');
        } else {
          st.comments += 1;
          saveState(st);
          lines.push('✅ 已发送（输入框已清空）');
        }
      } else {
        lines.push('（只填了草稿，没发送。要发出去再加 send=true）');
      }
      return { text: lines.join('\n') };
    }, 'comment'),
  });

  // ---- 分享 / 转发 ----
  tools.push({
    name: 'douyin_share',
    description:
      '把当前视频分享出去。true 情况说明：分享面板里实测有「群聊」和「好友」条目与「复制链接」，' +
      '但**点击后能否真的送达未经验证**（旧版插件实测点完后群里收不到）。' +
      '所以默认 mode=panel 只打开面板列出可选目标；mode=send 才真点，结果标 uncertain。' +
      `配额：群 ${GROUP_FORWARD_LIMIT} 条/天、私聊 ${PRIVATE_FORWARD_LIMIT} 条/天。`,
    parameters: {
      type: 'object', additionalProperties: false,
      mode: { type: 'string', description: 'panel(默认，只列目标) / send(真发) / copy(点复制链接)' },
      target: { type: 'string', description: '目标名称（群名或好友昵称，需与面板里的文字完全一致）' },
      kind: { type: 'string', description: 'group / private（send 时必填，用来记账）' },
    },
    timeoutMs: 90000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
      const st = loadState();
      const mode = args.mode || 'panel';

      // 配额检查（只有 send 才消耗）
      if (mode === 'send') {
        const kind = args.kind === 'group' ? 'group' : args.kind === 'private' ? 'private' : null;
        if (!kind) throw new Error('send 需要 kind=group 或 kind=private（用来记账）');
        if (!args.target) throw new Error('send 需要 target（目标名称要和面板里完全一致）');
        const used = kind === 'group' ? st.groupForwards : st.privateForwards;
        const limit = kind === 'group' ? GROUP_FORWARD_LIMIT : PRIVATE_FORWARD_LIMIT;
        if (used >= limit) {
          return { text: `⛔ 今日${kind === 'group' ? '群' : '私聊'}转发配额已用完（${used}/${limit}）。明天 0 点重置。` };
        }
      }

      // 打开分享面板
      const open = await evalOnPage(fireClick('video-player-share'), 8000);
      if (!open || !open.ok) throw new Error((open && open.error) || '没找到分享按钮');
      await sleep(2500);
      const list = await evalOnPage(listShareTargets, 8000);

      if (mode === 'panel') {
        let parsed = { count: 0, items: [] };
        try { parsed = JSON.parse(list); } catch {}
        return {
          text: [
            '📋 分享面板已打开，可选目标：',
            ...parsed.items.map((x) => `  · ${x.raw}${x.name && x.name !== x.raw ? `   → target 可写「${x.name}」` : ''}`),
            '',
            `今日配额：群 ${st.groupForwards}/${GROUP_FORWARD_LIMIT}、私聊 ${st.privateForwards}/${PRIVATE_FORWARD_LIMIT}`,
            '要真的发：mode=send + target=<上面某个名字> + kind=group|private（target 用包含匹配，写前半段就行）',
            '⚠️ 提醒：面板入口存在，但点击后的送达**未经验证**（旧版实测点完群里收不到）。',
          ].join('\n'),
        };
      }

      if (mode === 'copy') {
        const r = await evalOnPage(clickShareTarget('复制链接'), 8000);
        if (!r || !r.ok) return { text: '⚠️ 没找到「复制链接」按钮：' + ((r && r.error) || '') };
        return { text: '✅ 已点「复制链接」（链接进了浏览器剪贴板；管家是无头/独立 profile，读不到系统剪贴板）' };
      }

      // send
      const r = await evalOnPage(clickShareTarget(args.target), 8000);
      if (!r || !r.ok) throw new Error((r && r.error) || '没点到目标');
      await sleep(2000);
      // 记账：即使未确认送达也记（保守，避免超额）
      if (args.kind === 'group') st.groupForwards += 1;
      else st.privateForwards += 1;
      saveState(st);

      const usedNow = args.kind === 'group' ? st.groupForwards : st.privateForwards;
      const limit = args.kind === 'group' ? GROUP_FORWARD_LIMIT : PRIVATE_FORWARD_LIMIT;
      return {
        text: [
          `已点击目标「${args.target}」（${args.kind}）`,
          `今日配额：${usedNow}/${limit}`,
          '⚠️ 送达状态：**未确认**（unconfirmed）。',
          '抖音网页版分享面板点击后没有可读的成功回执；旧版实测出现过「点了但群里没收到」。',
          '要确认是否真发出去，得去对应的群/私聊里看一眼。',
        ].join('\n'),
      };
    }, 'share'),
  });

  // ---- 接口日志 ----
  tools.push({
    name: 'douyin_api_log',
    description: '查看本插件页面最近抓到的接口原始返回。调试接口变化时用。',
    parameters: {
      type: 'object', additionalProperties: false,
      filter: { type: 'string', description: '只显示 URL 含该子串的条目' },
      limit: { type: 'number', description: '最多几条(默认 10)' },
    },
    timeoutMs: 60000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
      const log = await rpc('get_network_log', {
        limit: args.limit || 10,
        urlFilter: args.filter,
        maxBytes: 3_000_000,
      });
      if (!log.ok) throw new Error(log.error || 'get_network_log failed');
      if (!log.entries || !log.entries.length) return { text: '(还没抓到接口。先 douyin_search 或打开一个页面)' };
      const lines = [`共 ${log.total} 条（显示 ${log.returned}，${log.bytes} 字节）`, ''];
      for (const e of log.entries) {
        lines.push(`[${e.i}] ${e.method} ${e.status} ${e.ct}`);
        lines.push('    ' + e.url.slice(0, 160));
        if (e.json) {
          lines.push('    JSON 顶层: ' + Object.keys(e.json).slice(0, 12).join(', '));
          if (Array.isArray(e.json.data)) lines.push(`    data[]: ${e.json.data.length} 项`);
        } else if (e.text) {
          lines.push('    文本: ' + String(e.text).slice(0, 120).replace(/\n/g, ' '));
        }
        if (e.error) lines.push('    错误: ' + e.error);
      }
      return { text: lines.join('\n') };
    }, 'api_log'),
  });

  // ---- 今日用量 ----
  tools.push({
    name: 'douyin_usage',
    description: '看今天的用量：浏览时长、点赞/收藏/评论次数、转发配额还剩多少、因质量跳过了几次。',
    parameters: { type: 'object', additionalProperties: false },
    timeoutMs: 30000,
    output: OUTPUT_TEXT,
    execute: () => withHost(async () => {
      const s = loadState();
      return {
        text: [
          `日期: ${s.date}`,
          `浏览: ${Math.round(s.browseSeconds / 60)} 分钟 / ${Math.round(BROWSE_LIMIT_SEC / 60)} 分钟` +
            (s.browseSeconds >= BROWSE_LIMIT_SEC ? '（已达上限，douyin_next 会被拒）' : ''),
          `互动: 赞 ${s.likes} / 藏 ${s.favorites} / 评 ${s.comments}`,
          `转发: 群 ${s.groupForwards}/${GROUP_FORWARD_LIMIT}、私聊 ${s.privateForwards}/${PRIVATE_FORWARD_LIMIT}`,
          `因质量未达标跳过: ${s.skippedLowQuality} 次（阈值 ${MIN_DIGG} 赞）`,
          `状态文件: ${STATE_FILE}`,
        ].join('\n'),
      };
    }, 'usage'),
  });

  ctx.effect(() => {
    const disposers = tools.map((t) => ctx.tools.register(t));
    logger.info(`douyin-on-base: ${tools.length} 个工具 → ${HOST} (session ${SESSION_ID})`);
    return () => { for (const d of disposers) { try { d(); } catch {} } };
  }, 'douyin-on-base: tools');
}

export { name, apply, inject };
