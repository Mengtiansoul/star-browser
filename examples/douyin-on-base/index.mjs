// ============================================================
// 抖音插件（基于 star-browser 基座 v0.3.0）
//
// 能力：
//   · 专属 sessionId —— 自己一张页，不和别的插件抢
//   · get_network_log —— 从接口 JSON 拿视频元数据，不解析 DOM
//   · eval 注入 —— 合成 ArrowDown 滑动、派发鼠标序列触发点赞/收藏
//
// 安装：dsh plugin add link:D:/Deepseek-Harness/Fan_xing/browser/examples/douyin-on-base
// 依赖：star-browser 管家在线（star-browser --detach）
//
// ════════════════════════════════════════════════════════════
// 实测结论（2026-10-22，Edge 155 + 已登录抖音号；改代码前先看这里）
// ════════════════════════════════════════════════════════════
// 1) 搜索页走 XHR：/aweme/v1/web/general/search/single/ 返回完整 JSON，
//    data[].aweme_info 有 aweme_id / desc / author / statistics，单条约 900KB。
// 2) **推荐流不走 XHR**（React Server Components 首屏直出）。网络日志里只有
//    danmaku / stats / history 这些旁路请求，feed 元数据只能从 DOM 读。
// 3) 滑动：eval 里合成 KeyboardEvent(ArrowDown) 有效；被拦就退 press。
// 4) 点赞 / 收藏：按钮虽然渲染了，但 **getBoundingClientRect 是 0x0**（完全隐藏），
//    Playwright 的 normal click 会被「element is not visible」拦下。
//    正解 = 往里派发完整鼠标序列（pointerdown → mousedown → pointerup →
//    mouseup → click），React 的合成事件监听在容器上，冒泡到了就生效。
//    实测：video-player-no-digged → video-player-is-digged（再点一次可撤销）。
// 5) 评论框：不是一直存在的 contenteditable！
//    .comment-input-inner-container 里先是个占位符「留下你的精彩评论吧」，
//    **点它之后**才挂出 Draft.js 编辑器（div.public-DraftEditor-content）。
//    Draft.js 只认真键盘事件（管家的 type 用 pressSequentially，可用）；
//    直接改 innerText 不会触发 React onChange。
//    清空用 Control+a + Delete（会剩一个 \n，是 Draft.js 空状态，正常）。
// 6) 点赞 / 收藏 / 发评论都是**对外可见**动作：作者能看到。工具默认只做
//    「点一下」和「填草稿」，发评论必须显式传 send:true 才真发。
// ============================================================

const name = 'douyin-on-base';
const inject = ['tools'];

const HOST = (process.env.STAR_BROWSER_HOST || 'http://127.0.0.1:9443').replace(/\/+$/, '');
/** 本插件专属页面；固定一个，管家重启后还是同一张页 */
const SESSION_ID = process.env.DOUYIN_SESSION_ID || 'douyin-worker-1';
const RPC_TIMEOUT = 60000;

const OUTPUT_TEXT = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
/** 派发完整鼠标序列（隐藏按钮也能触发 React 处理） */
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

/** 读某个反应按钮的状态（video-player-no-digged / is-digged …） */
const reactionState = (e2e) => `(() => {
  const d = document.querySelector('[data-e2e="${e2e}"]');
  return d ? (d.getAttribute('data-e2e-state') || '') : '';
})()`;

const STATE_EXPR = `(() => {
  const vids = [...document.querySelectorAll('video')];
  const v = vids.find((x) => !x.paused) || vids[0] || null;
  return {
    url: location.href,
    title: document.title || '',
    playing: v ? !v.paused : false,
    currentTime: v ? Math.round(v.currentTime) : 0,
    duration: v ? Math.round(v.duration || 0) : 0,
    videoCount: vids.length,
    diggState: document.querySelector('[data-e2e="video-player-digg"]')?.getAttribute('data-e2e-state') || '',
    collectState: document.querySelector('[data-e2e="video-player-collect"]')?.getAttribute('data-e2e-state') || '',
    commentOpen: !!document.querySelector('.comment-input-inner-container [contenteditable="true"]'),
  };
})()`;

/** 合成 ArrowDown：抖音网页版就是靠这个换下一条 */
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
    maxBytes: 6_000_000, // 抖音这条 900KB 级，默认预算会截断
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
// 互动动作（点赞 / 收藏）
// ------------------------------------------------------------
/**
 * 把某个反应按钮拨到目标状态。
 * @param {string} e2e 按钮的 data-e2e
 * @param {boolean} want true=想要已激活，false=想要取消
 */
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

/** 打开评论输入框：点评论图标 → 点占位符 → 等 Draft.js 编辑器出现 */
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
    '刷推荐流的标准循环：先 douyin_state 看当前进度/是否在播 → 该换就 douyin_next' +
    '（一次一条，别连点）→ 想互动再 douyin_like / douyin_favorite / douyin_comment。' +
    '任何一步失败先 douyin_state 确认还在视频页，必要时 douyin_next 一次再继续。';

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
        lines.push(`${i + 1}. ${it.desc || '(无标题)'}`);
        lines.push(`   @${it.author} | 赞 ${it.digg ?? '?'} | 评论 ${it.comment ?? '?'} | ${it.url}`);
      });
      lines.push('', '下一步：douyin_open 序号 打开某条；或 douyin_next 在页面上滑');
      return { text: lines.join('\n') };
    }, 'search'),
  });

  tools.push({
    name: 'douyin_open',
    description: '按 douyin_search 的序号或 aweme_id 打开视频详情页（打开后可直接点赞/收藏/评论）。',
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
          (st ? `播放: ${st.playing ? '是' : '否'} | ${st.currentTime}s/${st.duration}s | 视频元素 ${st.videoCount} 个` : ''),
      };
    }, 'open'),
  });

  tools.push({
    name: 'douyin_next',
    description: '往下滑切下一条视频（eval 注入 ArrowDown，不依赖元素定位）。一次一条，别连点。' + WORKFLOW_HINT,
    parameters: {
      type: 'object', additionalProperties: false,
      times: { type: 'number', description: '滑几次(默认 1，最多 10)' },
    },
    timeoutMs: 120000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
      const times = Math.min(Math.max(Number(args.times) || 1, 1), 10);
      const moved = [];
      for (let i = 0; i < times; i++) {
        const before = await pageState().catch(() => null);
        const r = await rpc('eval', { expression: SLIDE_EXPR, timeout: 8000 });
        if (!r.ok) await rpc('press', { key: 'ArrowDown' }); // 合成被拦就退真按键
        await sleep(1000 + Math.floor(Math.random() * 900));  // 拟人，别连点
        const after = await pageState().catch(() => null);
        moved.push({ from: before && before.currentTime, to: after && after.currentTime });
      }
      const st = await pageState().catch(() => null);
      const lines = [`✅ 滑了 ${times} 次`];
      moved.forEach((m, i) => lines.push(`  ${i + 1}. 播放进度 ${m.from ?? '?'}s → ${m.to ?? '?'}s`));
      if (st) lines.push(`当前: ${st.title || '(无标题)'} | ${st.url}`);
      return { text: lines.join('\n') };
    }, 'next'),
  });

  tools.push({
    name: 'douyin_state',
    description: '读当前视频页状态：是否在播 / 进度 / 时长 / 标题 / 点赞收藏是否已激活 / 评论框开没开。' +
      '刷推荐流时用它监控进度，决定什么时候 douyin_next。',
    parameters: { type: 'object', additionalProperties: false },
    timeoutMs: 45000,
    output: OUTPUT_TEXT,
    execute: () => withHost(async () => {
      const st = await pageState();
      const on = (s) => (String(s).includes('is-') ? '已' : '未');
      return {
        text: [
          `网址: ${st.url}`,
          `标题: ${st.title || '(无)'}`,
          `播放: ${st.playing ? '是' : '否'} | ${st.currentTime}s / ${st.duration}s | 页面视频元素 ${st.videoCount} 个`,
          `点赞: ${on(st.diggState)} | 收藏: ${on(st.collectState)} | 评论框: ${st.commentOpen ? '已打开' : '未打开'}`,
        ].join('\n'),
      };
    }, 'state'),
  });

  tools.push({
    name: 'douyin_like',
    description: '给当前视频点赞（对外可见，作者能看到）。默认 like；已点过不会重复点。传 action=unlike 可取消。',
    parameters: {
      type: 'object', additionalProperties: false,
      action: { type: 'string', description: 'like(默认) / unlike' },
    },
    timeoutMs: 60000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
      const want = (args.action || 'like') === 'like';
      const r = await setReaction('video-player-digg', want);
      if (!r.changed && r.note) return { text: `没动：点赞${want ? '已经是开着的' : '本来就是关着的'}（${r.after}）` };
      return {
        text: (want ? '✅ 已点赞' : '✅ 已取消点赞') +
          `\n状态: ${r.before || '(空)'} → ${r.after || '(空)'}` +
          (r.changed ? '' : '\n⚠️ 状态没变化，可能被风控或页面结构变了'),
      };
    }, 'like'),
  });

  tools.push({
    name: 'douyin_favorite',
    description: '收藏当前视频（对外可见）。默认 on；已收藏不会重复。传 action=off 取消收藏。',
    parameters: {
      type: 'object', additionalProperties: false,
      action: { type: 'string', description: 'on(默认) / off' },
    },
    timeoutMs: 60000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
      const want = (args.action || 'on') !== 'off';
      const r = await setReaction('video-player-collect', want);
      if (!r.changed && r.note) return { text: `没动：收藏${want ? '已经收藏过了' : '本来就没收藏'}（${r.after}）` };
      return {
        text: (want ? '✅ 已收藏' : '✅ 已取消收藏') +
          `\n状态: ${r.before || '(空)'} → ${r.after || '(空)'}` +
          (r.changed ? '' : '\n⚠️ 状态没变化，可能被风控或页面结构变了'),
      };
    }, 'favorite'),
  });

  tools.push({
    name: 'douyin_comment',
    description: '在当前视频下写评论。默认只填草稿不发送（安全）；要真发必须传 send=true。' +
      '清空用 clear=true。' + WORKFLOW_HINT,
    parameters: {
      type: 'object', additionalProperties: false,
      text: { type: 'string', description: '评论内容' },
      send: { type: 'boolean', description: 'true=真的发出去(对外可见)；默认 false 只填草稿' },
      clear: { type: 'boolean', description: 'true=先清空输入框' },
    },
    timeoutMs: 90000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
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
        const t = await rpc('type', {
          selector: COMMENT.editorSel,
          text: String(args.text),
          replace: !!args.clear,
        });
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
        lines.push(after ? '⚠️ 按了回车但输入框还有内容，可能没发出去（风控/需要点发送按钮）' : '✅ 已发送（输入框已清空）');
      } else {
        lines.push('（只填了草稿，没发送。要发出去再加 send=true）');
      }
      return { text: lines.join('\n') };
    }, 'comment'),
  });

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

  ctx.effect(() => {
    const disposers = tools.map((t) => ctx.tools.register(t));
    logger.info(`douyin-on-base: ${tools.length} 个工具 → ${HOST} (session ${SESSION_ID})`);
    return () => { for (const d of disposers) { try { d(); } catch {} } };
  }, 'douyin-on-base: tools');
}

export { name, apply, inject };
