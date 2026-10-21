// ============================================================
// 抖音插件骨架（基于 star-browser 基座 v0.3.0）
//
// 三种能力都演示了：
//   1. 申请专属 sessionId —— 自己一个页面，不与别的插件抢
//   2. get_network_log —— 直接从接口 JSON 拿视频元数据，不解析 DOM
//   3. eval 注入 —— 合成 ArrowDown 键触发下滑（实测有效）
//
// 依赖：star-browser 管家在线（star-browser --detach）
// 安装：dsh plugin add link:<这个目录>
//
// ⚠️ 实测结论（2026-10-22，本机 Edge 155 + 已登录抖音号）：
//   · 搜索页走 XHR：/aweme/v1/web/general/search/single/ 返回完整 JSON，
//     data[].aweme_info 里有 aweme_id / desc / author / statistics，
//     单条响应 900KB 左右（所以基座的单条 body 上限调到了 2MB）
//   · 推荐流 feed 不走 XHR（React Server Components 首屏直出），
//     get_network_log 截不到！它只发 danmaku / stats / history 这类旁路请求。
//     要推荐流的元数据只能从 DOM 或 RSC payload 里挖 —— 搜索/详情页用接口，
//     推荐流用 DOM/按键，这两条路别搞混。
//   · 滑动：合成 KeyboardEvent 的 ArrowDown 实测能切换（播放元素从第 1 个
//     换到第 2 个）；press（真按键）也可以。合成事件万一被拦，退 press。
// ============================================================

const name = 'douyin-on-base';
const inject = ['tools'];

const HOST = (process.env.STAR_BROWSER_HOST || 'http://127.0.0.1:9443').replace(/\/+$/, '');
/** 本插件专属页面；写死一个，重启后还是同一张页 */
const SESSION_ID = process.env.DOUYIN_SESSION_ID || 'douyin-worker-1';
const RPC_TIMEOUT = 45000;

const OUTPUT_TEXT = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 统一 RPC：自动带 sessionId，错误翻成人话 */
async function rpc(op, body = {}, ctx) {
  const res = await fetch(HOST + '/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, sessionId: SESSION_ID, ...body }),
    signal: AbortSignal.timeout(RPC_TIMEOUT),
  });
  const data = await res.json();
  return data;
}

async function hostAlive() {
  try {
    const r = await fetch(HOST + '/health', { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

const HOST_DOWN = '❌ 浏览器基座没在跑。先起它：star-browser --detach（或 star-browser 前台看窗口）';

// ------------------------------------------------------------
// 从网络日志里挖视频列表（核心：不碰 DOM）
// ------------------------------------------------------------
/** 把一条 search 接口的 JSON 摊成视频数组 */
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
      author: a.author && (a.author.nickname || a.author.unique_id) || '',
      create_time: a.create_time,
      duration_ms: a.video && a.video.duration,
      digg: a.statistics && a.statistics.digg_count,
      comment: a.statistics && a.statistics.comment_count,
      share: a.statistics && a.statistics.share_count,
      play: a.statistics && a.statistics.play_count,
      url: a.aweme_id ? 'https://www.douyin.com/video/' + a.aweme_id : '',
    });
  }
  return out;
}

async function searchAwemes(keyword, { limit = 20, reopen = true } = {}) {
  if (reopen) {
    await rpc('goto', { url: 'https://www.douyin.com/search/' + encodeURIComponent(keyword) });
    await sleep(6500); // 等首屏接口回来
  }
  const log = await rpc('get_network_log', {
    limit: 20,
    urlFilter: 'general/search',
    maxBytes: 6_000_000, // 抖音这条响应 900KB 级，默认预算会截断
  });
  if (!log.ok) throw new Error(log.error || 'get_network_log failed');
  const entries = (log.entries || []).filter((e) => e.json);
  // 取最新一条能解析出数据的
  for (let i = entries.length - 1; i >= 0; i--) {
    const list = awemesFromEntry(entries[i]);
    if (list.length) return { source: entries[i].url, total: list.length, items: list.slice(0, limit) };
  }
  return { source: null, total: 0, items: [], hint: '没截到可解析的 search 接口（可能还没加载完，或接口结构变了）' };
}

// ------------------------------------------------------------
// 页面状态 / 滑动
// ------------------------------------------------------------
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
    muted: v ? v.muted : null,
  };
})()`;

async function pageState() {
  const r = await rpc('eval', { expression: STATE_EXPR, timeout: 8000 });
  if (!r.ok) throw new Error(r.error || 'eval failed');
  return r.result;
}

/** 合成 ArrowDown：抖音网页版就是靠这个换下一条 */
const SLIDE_EXPR = `(() => {
  const ev = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true };
  window.dispatchEvent(new KeyboardEvent('keydown', ev));
  document.dispatchEvent(new KeyboardEvent('keydown', ev));
  const v = document.querySelector('video');
  if (v) { v.play().catch(() => {}); }
  return true;
})()`;

async function slideNext(times = 1) {
  const moved = [];
  for (let i = 0; i < times; i++) {
    const before = await pageState().catch(() => null);
    const r = await rpc('eval', { expression: SLIDE_EXPR, timeout: 8000 });
    if (!r.ok) {
      // 合成事件被拦的话，退到真按键（真事件一定过）
      await rpc('press', { key: 'ArrowDown' });
    }
    await sleep(1000 + Math.floor(Math.random() * 900)); // 拟人一点，别连点
    const after = await pageState().catch(() => null);
    moved.push({ before: before && before.currentTime, after: after && after.currentTime, url: after && after.url });
  }
  return moved;
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

  tools.push({
    name: 'douyin_search',
    description: '在抖音里搜关键词，返回视频列表(标题/作者/点赞)。数据来自接口 JSON, 不解析 DOM。',
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
      if (!r.items.length) return { text: '没拿到视频列表。' + (r.hint || '') };
      const lines = [`✅ 从接口拿到 ${r.total} 条（源: ${r.source}）`, ''];
      r.items.forEach((it, i) => {
        lines.push(`${i + 1}. ${it.desc || '(无标题)'}`);
        lines.push(`   @${it.author} | 赞 ${it.digg ?? '?'} | 评论 ${it.comment ?? '?'} | ${it.url}`);
      });
      lines.push('');
      lines.push('下一步: douyin_open <序号> 打开某条; douyin_next 往下滑');
      return { text: lines.join('\n') };
    }, 'search'),
  });

  tools.push({
    name: 'douyin_open',
    description: '按 douyin_search 返回的 aweme_id 或序号打开视频详情页。',
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
        // 从最近一次搜索的日志里按序号取
        const log = await rpc('get_network_log', { limit: 20, urlFilter: 'general/search', maxBytes: 6_000_000 });
        const entries = (log.entries || []).filter((e) => e.json);
        const hit = entries.length ? awemesFromEntry(entries[entries.length - 1])[args.index - 1] : null;
        id = hit && hit.aweme_id;
      }
      if (!id) throw new Error('需要 index 或 aweme_id');
      const r = await rpc('goto', { url: 'https://www.douyin.com/video/' + id });
      if (!r.ok) throw new Error(r.error || 'goto failed');
      const st = await pageState().catch(() => null);
      return { text: `✅ 已打开 ${id}\n标题: ${r.title || st?.title || ''}\n${st ? '播放中: ' + st.playing + ' | ' + st.currentTime + 's/' + st.duration + 's' : ''}` };
    }, 'open'),
  });

  tools.push({
    name: 'douyin_next',
    description: '抖音往下滑(切换下一条视频)。通过 eval 注入 ArrowDown, 不依赖页面元素定位。',
    parameters: {
      type: 'object', additionalProperties: false,
      times: { type: 'number', description: '滑几次(默认 1)' },
    },
    timeoutMs: 120000,
    output: OUTPUT_TEXT,
    execute: (args) => withHost(async () => {
      const times = Math.min(Math.max(Number(args.times) || 1, 1), 10);
      const moved = await slideNext(times);
      const st = await pageState().catch(() => null);
      const lines = [`✅ 滑了 ${times} 次`];
      moved.forEach((m, i) => lines.push(`  ${i + 1}. 播放进度 ${m.before ?? '?'}s → ${m.after ?? '?'}s`));
      if (st) lines.push(`当前: ${st.title || '(无标题)'} | ${st.url}`);
      return { text: lines.join('\n') };
    }, 'next'),
  });

  tools.push({
    name: 'douyin_state',
    description: '读当前视频页状态(是否在播/进度/时长/标题/网址)。',
    parameters: { type: 'object', additionalProperties: false },
    timeoutMs: 45000,
    output: OUTPUT_TEXT,
    execute: () => withHost(async () => {
      const st = await pageState();
      return {
        text: [
          `网址: ${st.url}`,
          `标题: ${st.title || '(无)'}`,
          `播放: ${st.playing ? '是' : '否'} | ${st.currentTime}s / ${st.duration}s | 页面视频元素 ${st.videoCount} 个`,
        ].join('\n'),
      };
    }, 'state'),
  });

  tools.push({
    name: 'douyin_api_log',
    description: '查看本插件页面最近抓到的接口(原始返回)。调试接口变化时用。',
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
      if (!log.entries || !log.entries.length) return { text: '(还没有抓到接口。先 douyin_search 或打开一个页面)' };
      const lines = [`共 ${log.total} 条（显示 ${log.returned}，${log.bytes} 字节）`, ''];
      for (const e of log.entries) {
        lines.push(`[${e.i}] ${e.method} ${e.status} ${e.ct}`);
        lines.push('    ' + e.url.slice(0, 160));
        if (e.json) {
          const keys = Object.keys(e.json).slice(0, 12).join(', ');
          lines.push('    JSON 顶层: ' + keys);
          if (Array.isArray(e.json.data)) lines.push('    data[]: ' + e.json.data.length + ' 项');
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
