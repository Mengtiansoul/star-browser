// ============================================================
// ui/host.mjs — 设置面板的「宿主半身」
//
// 只做两件事：给浏览器半身读配置、接一次保存。
// 挂载方式（profile 的 cordis.patch.yml）：
//   - insert:
//       - id: douyin-on-base-ui
//         name: './ui/host.mjs'
//
// 访问守卫：只允许本机回环，或 tailnet 的 *.ts.net（主人偶尔从笔记本开 GUI）。
// 跨站请求一律拒（看 origin + sec-fetch-site）。
// ============================================================
import {
  loadConfig, saveConfig, maskedForPanel, stateSummary, sanitizePatch,
  CONFIG_FILE, STATE_FILE, DEFAULT_CONFIG,
} from '../lib/config-store.mjs';

export const name = 'douyin-on-base-ui';
/** 只依赖宿主 webServer：开 HTTP 路由给浏览器半身用 */
export const inject = ['webServer'];

const API_PATH = '/douyin/api';

function hostnameOf(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']'));
  return raw.split(':')[0];
}

function isAllowedHost(h) {
  if (!h) return false;
  if (h === '127.0.0.1' || h === 'localhost' || h === '::1') return true;
  return /\.ts\.net$/i.test(h); // tailnet 入口
}

function guard(req) {
  const host = hostnameOf(req.headers && req.headers.host);
  if (!isAllowedHost(host)) return { code: 403, error: 'host not allowed' };
  const origin = req.headers && req.headers.origin;
  if (origin && String(origin) !== 'null') {
    let oh = '';
    try { oh = hostnameOf(new URL(String(origin)).host); } catch { return { code: 403, error: 'origin not allowed' }; }
    if (!isAllowedHost(oh)) return { code: 403, error: 'origin not allowed' };
  }
  // 浏览器跨站请求会带这个头
  const site = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
  if (site === 'cross-site') return { code: 403, error: 'cross-site request blocked' };
  return null;
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      const send = (code, payload) => {
        try {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(payload));
        } catch { /* 客户端已断开 */ }
      };
      try {
        const blocked = guard(req);
        if (blocked) return send(blocked.code, { ok: false, error: blocked.error });

        const url = new URL(req.url, 'http://127.0.0.1');

        // 读配置 + 今日状态
        if (url.pathname === API_PATH + '/config' && req.method === 'GET') {
          let cfg;
          try {
            cfg = loadConfig({ seedEnv: false }); // 面板只看文件值，不掺环境变量
          } catch (e) {
            return send(409, { ok: false, error: String((e && e.message) || e), configPath: CONFIG_FILE });
          }
          return send(200, {
            ok: true,
            config: maskedForPanel(cfg),
            defaults: DEFAULT_CONFIG,
            state: stateSummary(),
            files: { config: CONFIG_FILE, state: STATE_FILE },
          });
        }

        // 保存（唯一写入口）
        if (url.pathname === API_PATH + '/config' && req.method === 'POST') {
          const ct = String((req.headers && req.headers['content-type']) || '').toLowerCase();
          if (!ct.includes('application/json')) return send(415, { ok: false, error: 'content-type must be application/json' });
          let body;
          try { body = JSON.parse(await readBody(req)); } catch (e) {
            return send(400, { ok: false, error: 'body is not valid JSON: ' + String((e && e.message) || e) });
          }
          const check = sanitizePatch(body && body.config);
          if (!check.ok) return send(400, { ok: false, error: check.error });
          try {
            const next = saveConfig(check.patch);
            return send(200, {
              ok: true,
              config: maskedForPanel(loadConfig({ seedEnv: false })),
              savedAt: Date.now(),
              // 告诉面板哪些是即时生效的
              note: '已写入 config.json，工具下一次调用就生效（不用重启宿主）',
            });
          } catch (e) {
            return send(409, { ok: false, error: String((e && e.message) || e) });
          }
        }

        // 只读状态
        if (url.pathname === API_PATH + '/state' && req.method === 'GET') {
          return send(200, { ok: true, state: stateSummary() });
        }

        return send(404, { ok: false, error: 'not found' });
      } catch (e) {
        return send(500, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }), 'douyin-on-base: settings api');
}
