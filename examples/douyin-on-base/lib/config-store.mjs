// ============================================================
// lib/config-store.mjs — 配置中心（config.json）
//
// 为什么不再用环境变量：DSH 宿主是 SYSTEM 服务，用户级 setx 读不到；
// 改系统环境变量要重启宿主，而且 key 会散落在服务配置里。改成插件目录下的
// config.json，一次读写、设置面板直接改、工具下一次调用就生效（不用重启）。
//
// 读取纪律：
//   · 文件不存在 → 写一份默认值
//   · JSON 坏了 → 不覆盖（抛错让调用方提示），避免把用户的 key 冲掉
//   · 返回值永远是「默认值 + 文件值」深合并后的完整对象，工具不必自己兜底
//   · 环境变量仍然支持，但只作为**回落**（config.json 里没写才看 env），
//     这样老部署不用改就能继续跑
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** examples/douyin-on-base/config.json（lib 的上一级） */
export const CONFIG_FILE = path.join(HERE, '..', 'config.json');
/** examples/douyin-on-base/state.json */
export const STATE_FILE = path.join(HERE, '..', 'state.json');

export const DEFAULT_CONFIG = {
  vision: {
    apiKey: '',
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-omni-flash',
    fallbacks: ['qwen-vl-plus'],
    prompt: '',
    timeoutSec: 90,
  },
  /**
   * 功能总开关。关掉 = 工具直接拒绝执行，连 DOM 都不碰。
   * 默认值按「危险的先关」：评论/转发/私信默认关，点赞开，收藏关。
   */
  features: {
    browse: true,
    like: true,
    favorite: false,
    comment: false,
    share: false,
    chat: false,
  },
  limits: {
    browseMinutes: 60,
    groupForwards: 5,
    privateForwards: 3,
    replies: 10,
    minDigg: 5000,
  },
  /** 身份信息：群聊里判断「有没有 @ 我」要靠昵称 */
  identity: {
    selfNickname: '繁星',
  },
  behavior: {
    /** 点赞/收藏/评论前的数值参考线（低于它只警告，不拦） */
    warnOnly: true,
    /** 发评论/发消息默认是否要显式 send:true 才真发 */
    requireExplicitSend: true,
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 深合并：数组整体替换，对象递归，其它直接覆盖 */
function merge(base, patch) {
  if (!isObj(patch)) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(out[k])) out[k] = merge(out[k], v);
    else out[k] = v;
  }
  return out;
}

const envStr = (n) => {
  const v = process.env[n];
  return typeof v === 'string' && v.trim() ? v.trim() : '';
};
const envNum = (n) => {
  const v = envStr(n);
  // 关键：环境变量不存在时 envStr 返回 ''，而 Number('') === 0 ——
  // 之前没拦这一下，导致 fromEnv() 拿 0 把 config.json 里的限额全盖掉
  // （groupForwards/privateForwards/replies/minDigg 全变 0）。
  if (v === '') return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};

/** 环境变量回落（只在 config.json 没给值的时候用） */
function fromEnv() {
  const patch = { vision: {}, limits: {} };
  const key = envStr('VISION_API_KEY');
  if (key) patch.vision.apiKey = key;
  const base = envStr('VISION_API_BASE');
  if (base) patch.vision.apiBase = base;
  const model = envStr('VISION_MODEL');
  if (model) patch.vision.model = model;
  const fb = envStr('VISION_MODEL_FALLBACKS');
  if (fb) patch.vision.fallbacks = fb.split(',').map((s) => s.trim()).filter(Boolean);
  const lim = {
    browseMinutes: envNum('DOUYIN_BROWSE_LIMIT_SEC'),
    groupForwards: envNum('DOUYIN_GROUP_FORWARD_LIMIT'),
    privateForwards: envNum('DOUYIN_PRIVATE_FORWARD_LIMIT'),
    replies: envNum('DOUYIN_REPLY_LIMIT'),
    minDigg: envNum('DOUYIN_MIN_DIGG'),
  };
  if (lim.browseMinutes != null) lim.browseMinutes = Math.round(lim.browseMinutes / 60) || 60;
  for (const [k, v] of Object.entries(lim)) if (v != null) patch.limits[k] = v;
  return patch;
}

/**
 * 读配置。
 * @param {{ seedEnv?: boolean }} opts seedEnv=false 时不看环境变量（面板展示用纯文件值）
 */
export function loadConfig({ seedEnv = true } = {}) {
  let file = null;
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // 第一次跑：落一份默认值，方便用户直接改
      try { saveConfig(DEFAULT_CONFIG, { allowOverwriteBad: false }); } catch { /* 只读环境下不致命 */ }
      file = null;
    } else {
      // 坏 JSON：不覆盖，抛给调用方
      const err = new Error('config.json 不是合法 JSON：' + ((e && e.message) || e));
      err.code = 'CONFIG_CORRUPT';
      throw err;
    }
  }
  let merged = merge(DEFAULT_CONFIG, file || {});
  if (seedEnv) merged = merge(merged, fromEnv());
  return merged;
}

/**
 * 写配置（深合并到现有文件上，未知键保留）。
 * @param {object} patch 只写想改的字段即可
 */
export function saveConfig(patch, { allowOverwriteBad = false } = {}) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e && e.code !== 'ENOENT' && !allowOverwriteBad) {
      const err = new Error('现有 config.json 是坏 JSON，拒绝覆盖（先修好或删掉它）');
      err.code = 'CONFIG_CORRUPT';
      throw err;
    }
    current = {};
  }
  const next = merge(merge({}, current), patch);
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** 给设置面板看的：key 打码，其余原样 */
export function maskedForPanel(cfg) {
  const key = String(cfg.vision.apiKey || '');
  let masked = '';
  if (key.length > 12) masked = key.slice(0, 6) + '…' + key.slice(-4);
  else if (key) masked = '已设置';
  return {
    ...cfg,
    vision: {
      ...cfg.vision,
      apiKey: '',
      apiKeyMasked: masked,
      apiKeySet: !!key,
    },
  };
}

/** 读今日状态（state.json），坏文件当空 */
export function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return isObj(s) ? s : {};
  } catch {
    return {};
  }
}

/** 面板友好的状态摘要 */
export function stateSummary() {
  const s = readState();
  const num = (k) => (typeof s[k] === 'number' && Number.isFinite(s[k]) ? s[k] : 0);
  return {
    date: s.date || '',
    browseMinutes: Math.round(num('browseSeconds') / 60),
    likes: num('likes'),
    favorites: num('favorites'),
    comments: num('comments'),
    replies: num('replies'),
    groupForwards: num('groupForwards'),
    privateForwards: num('privateForwards'),
    lowQualityWarnings: num('lowQualityWarnings'),
  };
}

/** 校验面板提交的补丁（类型/范围），返回 { ok, patch } 或 { ok:false, error } */
export function sanitizePatch(input) {
  if (!isObj(input)) return { ok: false, error: 'config 必须是对象' };
  const out = { vision: {}, limits: {} };
  const v = input.vision;
  if (isObj(v)) {
    if (typeof v.apiKey === 'string' && v.apiKey.trim()) out.vision.apiKey = v.apiKey.trim();
    if (typeof v.apiBase === 'string' && v.apiBase.trim()) out.vision.apiBase = v.apiBase.trim();
    if (typeof v.model === 'string' && v.model.trim()) out.vision.model = v.model.trim();
    if (typeof v.prompt === 'string') out.vision.prompt = v.prompt;
    if (Array.isArray(v.fallbacks)) out.vision.fallbacks = v.fallbacks.map(String).filter(Boolean).slice(0, 5);
    if (v.timeoutSec != null) {
      const n = Number(v.timeoutSec);
      if (!Number.isFinite(n) || n < 10 || n > 300) return { ok: false, error: 'timeoutSec 要在 10-300 之间' };
      out.vision.timeoutSec = Math.round(n);
    }
  }
  if (isObj(input.identity)) {
    if (typeof input.identity.selfNickname === 'string' && input.identity.selfNickname.trim()) {
      out.identity = { selfNickname: input.identity.selfNickname.trim().slice(0, 32) };
    }
  }
  if (isObj(input.features)) {
    out.features = {};
    for (const k of Object.keys(DEFAULT_CONFIG.features)) {
      if (input.features[k] == null) continue;
      if (typeof input.features[k] !== 'boolean') return { ok: false, error: 'features.' + k + ' 必须是 true/false' };
      out.features[k] = input.features[k];
    }
  }
  const l = input.limits;
  if (isObj(l)) {
    const ranges = {
      browseMinutes: [1, 600],
      groupForwards: [0, 50],
      privateForwards: [0, 50],
      replies: [0, 100],
      minDigg: [0, 10_000_000],
    };
    for (const [k, [lo, hi]] of Object.entries(ranges)) {
      if (l[k] == null) continue;
      const n = Number(l[k]);
      if (!Number.isFinite(n) || n < lo || n > hi) {
        return { ok: false, error: `${k} 要在 ${lo}-${hi} 之间` };
      }
      out.limits[k] = Math.round(n);
    }
  }
  return { ok: true, patch: out };
}
