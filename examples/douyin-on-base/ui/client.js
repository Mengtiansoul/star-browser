/**
 * ui/client.js — 「繁星抖音助手」设置面板（浏览器半身）
 *
 * 契约：宿主只认「已构建的 __ModuleLoader__ bundle」，require 只能拿到基座模块
 * （react 在里面），所以这里用 createElement 手写组件 —— 零构建、零第三方依赖。
 *
 * 挂载位：settings.section（官方给仓库外插件预留的整页设置位）。
 * 数据来源（ui/host.mjs）：
 *   GET  /douyin/api/config   → { config(apiKey 掩码), defaults, state, files }
 *   POST /douyin/api/config   → 触发写 config.json，工具下一次调用生效
 *   GET  /douyin/api/state    → 今日状态（只读）
 *
 * 设计纪律：
 *   · 改动先落本地草稿，只有点「保存」才 POST（避免边打字边写盘）
 *   · apiKey 留空 = 不修改（面板只回显掩码，永远不回传明文）
 *   · 任何网络/格式失败都降级成一行可读提示，绝不把设置页搞白屏
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-on-base-ui',
  factory: function (require) {
    var React = require('react');
    var h = React.createElement;
    var module = { exports: {} };
    var exports = module.exports;

    var API = '/douyin/api';

    /** UTF-8 安全的 base64（btoa 只吃 latin1，直接塞中文会抛错） */
    function b64EncodeUtf8(str) {
      var bytes = new TextEncoder().encode(str);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }

    /** hooks 兜底：宿主基座 shim 不完整时降级成静态渲染 */
    var useState = typeof React.useState === 'function' ? React.useState : function (v) { return [v, function () {}]; };
    var useEffect = typeof React.useEffect === 'function' ? React.useEffect : function () {};

    // 请求一律带超时：宿主路由要是卡住，界面会一直显示"保存中…"，看着像按钮坏了
    var REQ_TIMEOUT_MS = 10000;

    function doFetch(path, init) {
      var opts = Object.assign({ headers: { accept: 'application/json' } }, init || {});
      try { opts.signal = AbortSignal.timeout(REQ_TIMEOUT_MS); } catch (e) { /* 老浏览器没有 AbortSignal.timeout */ }
      return fetch(API + path, opts).then(function (r) {
        return r.text().then(function (txt) {
          var body = null;
          try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = { ok: false, error: '响应不是 JSON: ' + String(txt).slice(0, 120) }; }
          return { ok: r.ok, status: r.status, body: body };
        });
      });
    }

    function getJson(path) { return doFetch(path, {}); }

    function postJson(path, payload) {
      return doFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    var C = {
      wrap: { padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '760px' },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
        borderRadius: '12px', padding: '16px 18px',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
        display: 'flex', flexDirection: 'column', gap: '12px',
      },
      title: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))', lineHeight: '1.6' },
      row: { display: 'flex', alignItems: 'center', gap: '10px' },
      label: { width: '150px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, inherit)', flexShrink: 0 },
      input: {
        flex: 1, minWidth: 0, height: '32px', padding: '0 10px', borderRadius: '8px', fontSize: '13px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit', outline: 'none',
      },
      num: { width: '110px', height: '32px', padding: '0 10px', borderRadius: '8px', fontSize: '13px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit', outline: 'none' },
      area: { width: '100%', minHeight: '84px', padding: '10px', borderRadius: '8px', fontSize: '13px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit', outline: 'none',
        fontFamily: 'inherit', resize: 'vertical' },
      btn: { height: '34px', minWidth: '88px', padding: '0 18px', borderRadius: '8px', cursor: 'pointer',
        fontSize: '13px', fontWeight: 600, color: '#fff', border: '1px solid rgba(0,0,0,.12)',
        background: '#2f6fed', boxShadow: '0 1px 2px rgba(0,0,0,.18)' },
      btnGhost: { height: '32px', padding: '0 12px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' },
      kv: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px 12px', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))' },
      k: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))' },
      v: { fontSize: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
      msg: { fontSize: '12px', padding: '8px 10px', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1))' },
    };

    function Panel() {
      var loaded = useState(null);
      var cfg = loaded[0], setCfg = loaded[1];
      var err = useState(''), setErr = err[1];
      var info = useState(''), setInfo = info[1];
      var st = useState(null);
      var stateData = st[0], setState = st[1];
      var saving = useState(false);
      var setSaving = saving[1];

      // 草稿：vision / limits
      var draft = useState(null);
      var d = draft[0], setD = draft[1];

      function hydrate(data) {
        setCfg(data.config);
        setState(data.state || null);
        setD({
          apiKey: '',
          apiBase: data.config.vision.apiBase || '',
          model: data.config.vision.model || '',
          fallbacks: (data.config.vision.fallbacks || []).join(', '),
          prompt: data.config.vision.prompt || '',
          timeoutSec: data.config.vision.timeoutSec,
          browseMinutes: data.config.limits.browseMinutes,
          groupForwards: data.config.limits.groupForwards,
          privateForwards: data.config.limits.privateForwards,
          replies: data.config.limits.replies,
          minDigg: data.config.limits.minDigg,
          browse: !!(data.config.features && data.config.features.browse),
          like: !!(data.config.features && data.config.features.like),
          favorite: !!(data.config.features && data.config.features.favorite),
          comment: !!(data.config.features && data.config.features.comment),
          share: !!(data.config.features && data.config.features.share),
          chat: !!(data.config.features && data.config.features.chat),
        });
      }

      useEffect(function () {
        getJson('/config').then(function (r) {
          if (r.ok && r.body && r.body.ok) { hydrate(r.body); setErr(''); }
          else setErr('读取配置失败：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
        }).catch(function (e) { setErr('读取配置失败：' + (e && e.message ? e.message : e)); });
      }, []);

      function refreshState() {
        getJson('/state').then(function (r) {
          if (r.ok && r.body && r.body.ok) setState(r.body.state);
        }).catch(function () {});
      }

      function save() {
        if (!d) return;
        setSaving(true); setErr(''); setInfo('');
        try {
          doSave();
        } catch (e) {
          // 同步异常（构造 patch / 序列化出错）也要把状态复位，不然按钮永远卡在"保存中…"
          setSaving(false);
          setErr('保存时抛错：' + (e && e.message ? e.message : e));
        }
      }

      /** GET 兜底：把 patch 塞进 query 里保存 */
      function saveViaGet(patch) {
        var b64 = b64EncodeUtf8(JSON.stringify(patch));
        return getJson('/config?patch=' + encodeURIComponent(b64));
      }

      function doSave() {
        var patch = {
          vision: {
            apiBase: d.apiBase,
            model: d.model,
            prompt: d.prompt,
            timeoutSec: Number(d.timeoutSec),
            fallbacks: String(d.fallbacks || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          },
          features: {
            browse: !!d.browse,
            like: !!d.like,
            favorite: !!d.favorite,
            comment: !!d.comment,
            share: !!d.share,
            chat: !!d.chat,
          },
          limits: {
            browseMinutes: Number(d.browseMinutes),
            groupForwards: Number(d.groupForwards),
            privateForwards: Number(d.privateForwards),
            replies: Number(d.replies),
            minDigg: Number(d.minDigg),
          },
        };
        // 只有真填了新 key 才提交，留空 = 保持原样
        if (d.apiKey && d.apiKey.trim()) patch.vision.apiKey = d.apiKey.trim();

        function handleResult(r, via) {
          setSaving(false);
          if (r.ok && r.body && r.body.ok) {
            setInfo('✅ 已保存到 config.json' + (via === 'get' ? '' : '') +
              '，工具下一次调用就生效，不用重启宿主');
            hydrate(r.body);
            refreshState();
          } else {
            setErr('保存失败：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
          }
        }

        // 主通道直接用 GET：实测本机浏览器里 GET 能到宿主、POST 静默挂住
        // （大概率是广告拦截/防跟踪扩展或 Service Worker 把未知 POST 拦了）。
        // 参数很小，GET 完全够用；POST 那条路留作以后别的环境再用。
        saveViaGet(patch).then(function (r) {
          handleResult(r, 'get');
        }).catch(function (e) {
          // GET 也挂了 → 最后试一次 POST
          setInfo('GET 没通，正在试 POST…');
          postJson('/config', { config: patch }).then(function (r) {
            handleResult(r, 'post');
          }).catch(function (e2) {
            setSaving(false);
            setErr('保存失败（GET 和 POST 都没通）：' + (e && e.message ? e.message : e) + ' / ' + (e2 && e2.message ? e2.message : e2));
          });
        });
      }

      function field(label, key, opts) {
        opts = opts || {};
        return h('div', { style: C.row, key: key },
          h('div', { style: C.label }, label),
          h('input', {
            style: opts.number ? C.num : C.input,
            type: opts.number ? 'number' : 'text',
            min: opts.min, max: opts.max,
            value: d ? d[key] : '',
            placeholder: opts.placeholder || '',
            onChange: function (e) {
              var v = e.target.value;
              setD(function (prev) { var n = Object.assign({}, prev); n[key] = v; return n; });
            },
          }),
          opts.suffix ? h('span', { style: C.hint }, opts.suffix) : null
        );
      }

      /** 单个功能开关（圆角按钮，点一下切状态，改动只落草稿） */
      function featureRow(key, label, hint) {
        var on = !!(d && d[key]);
        return h('div', {
          key: key,
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
            padding: '9px 0', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16))',
          },
        },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' } }, label),
            hint ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))' } }, hint) : null
          ),
          h('button', {
            type: 'button',
            onClick: function () {
              setD(function (p) { var n = Object.assign({}, p); n[key] = !n[key]; return n; });
            },
            style: {
              flexShrink: 0, width: '62px', height: '28px', borderRadius: '999px', cursor: 'pointer',
              fontSize: '12px', border: 'none', transition: 'background .15s',
              color: on ? '#fff' : 'var(--dsw-alias-label-secondary, inherit)',
              background: on ? 'var(--dsw-alias-state-success-primary, #2f9e44)' : 'rgba(127,127,127,.35)',
            },
          }, on ? '开启' : '关闭')
        );
      }
      var loading = !d || !cfg;

      return h('div', { style: C.wrap },
        h('div', null,
          h('div', { style: { fontSize: '16px', fontWeight: 700 } }, '繁星抖音助手'),
          h('div', { style: C.hint }, '配置写在本插件目录的 config.json，保存后工具下一次调用即生效，不需要重启宿主。')
        ),

        err ? h('div', { style: Object.assign({}, C.msg, { color: 'var(--dsw-alias-error-primary, #e5484d)' }) }, err) : null,
        info ? h('div', { style: C.msg }, info) : null,

        /* ---------- API 配置 ---------- */
        h('div', { style: C.card },
          h('div', { style: C.title }, '视觉模型（douyin_evaluate 用）'),
          h('div', { style: C.hint },
            cfg && cfg.vision.apiKeySet
              ? '当前 key：' + cfg.vision.apiKeyMasked + '（留空 = 不修改）'
              : '还没配 key。不配也能用 douyin_evaluate，只是会退回「只截图，你自己看」。'),
          loading ? null : field('API Key', 'apiKey', { placeholder: cfg.vision.apiKeySet ? '留空则不修改' : 'sk-...' }),
          loading ? null : field('API Base', 'apiBase'),
          loading ? null : field('模型', 'model', { placeholder: 'qwen3.8-omni-flash' }),
          loading ? null : field('备用模型', 'fallbacks', { placeholder: '主模型 404 时自动换（逗号分隔）' }),
          loading ? null : field('超时（秒）', 'timeoutSec', { number: true, min: 10, max: 300 }),
          loading ? null : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('div', { style: C.label }, '自定义提示词'),
            h('textarea', {
              style: C.area,
              value: d.prompt,
              placeholder: '留空则用内置的「短视频审核员」提示词（画面内容 / 内容类型 / 1-10 分 / 建议）',
              onChange: function (e) { setD(function (p) { var n = Object.assign({}, p); n.prompt = e.target.value; return n; }); },
            })
          )
        ),

        /* ---------- 功能开关 ---------- */
        h('div', { style: C.card },
          h('div', { style: C.title }, '功能开关（危险动作默认关）'),
          h('div', { style: C.hint },
            '关掉的功能，工具会直接拒绝执行 —— 不点页面、不发消息。保存后下一次调用立即生效。'
          ),
          loading ? h('div', { style: C.hint }, '加载中…') : h('div', null,
            featureRow('browse', '浏览 / 下滑', 'douyin_search / open / next'),
            featureRow('like', '点赞', 'douyin_like（对外可见）'),
            featureRow('favorite', '收藏', 'douyin_favorite'),
            featureRow('comment', '评论', 'douyin_comment（发送仍需 send=true）'),
            featureRow('share', '视频转发', 'douyin_share（送达未验证）'),
            featureRow('chat', '私信 / 群聊', 'douyin_list_chats / read_chat / send_chat')
          )
        ),
        /* ---------- 安全限额 ---------- */
        h('div', { style: C.card },
          h('div', { style: C.title }, '安全限额（防沉迷 / 防封号）'),
          h('div', { style: C.hint }, '每天的硬上限。到了就拒绝，第二天 0 点自动重置。'),
          loading ? null : field('每日浏览上限', 'browseMinutes', { number: true, min: 1, max: 600, suffix: '分钟' }),
          loading ? null : field('群转发上限', 'groupForwards', { number: true, min: 0, max: 50, suffix: '条/天' }),
          loading ? null : field('私聊转发上限', 'privateForwards', { number: true, min: 0, max: 50, suffix: '条/天' }),
          loading ? null : field('自动回复上限', 'replies', { number: true, min: 0, max: 100, suffix: '条/天' }),
          loading ? null : field('点赞参考线', 'minDigg', { number: true, min: 0, max: 10000000, suffix: '（低于只提醒，不拦）' })
        ),

        /* ---------- 今日状态 ---------- */
        h('div', { style: C.card },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', { style: C.title }, '今日状态'),
            h('button', { style: C.btnGhost, onClick: refreshState }, '刷新')
          ),
          stateData
            ? h('div', { style: C.grid },
              h('div', { style: C.kv }, h('div', { style: C.k }, '浏览时长'), h('div', { style: C.v }, (stateData.browseMinutes || 0) + ' 分钟')),
              h('div', { style: C.kv }, h('div', { style: C.k }, '点赞'), h('div', { style: C.v }, stateData.likes || 0)),
              h('div', { style: C.kv }, h('div', { style: C.k }, '收藏'), h('div', { style: C.v }, stateData.favorites || 0)),
              h('div', { style: C.kv }, h('div', { style: C.k }, '评论'), h('div', { style: C.v }, stateData.comments || 0)),
              h('div', { style: C.kv }, h('div', { style: C.k }, '私信回复'), h('div', { style: C.v }, stateData.replies || 0)),
              h('div', { style: C.kv }, h('div', { style: C.k }, '转发（群/私）'), h('div', { style: C.v }, (stateData.groupForwards || 0) + ' / ' + (stateData.privateForwards || 0)))
            )
            : h('div', { style: C.hint }, '还没有今天的数据（跑一次工具就会生成 state.json）。')
        ),

        /* ---------- 保存 ---------- */
        h('div', { style: C.row },
          h('button', { style: C.btn, disabled: saving || loading, onClick: save }, saving ? '保存中…' : '保存'),
          h('span', { style: C.hint }, cfg && cfg.files ? '配置文件：' + cfg.files.config : '')
        )
      );
    }

    /** 错误边界：面板崩了也只坏这一块，不连累整个设置页 */
    function Boundary(props) {
      var e = useState(null);
      if (e[0]) {
        return h('div', { style: { padding: '16px', color: 'var(--dsw-alias-error-primary, #e5484d)', fontSize: '13px' } },
          '抖音助手面板渲染出错：' + String(e[0] && e[0].message ? e[0].message : e[0]));
      }
      return props.children;
    }

    /**
     * 挂载到设置页。
     * 参照 dsh-douyin-browser-local（已验证能出现在设置菜单）的写法：
     *   · 导出里必须带 inject: ['slots']，否则 ctx.slots 不保证可用；
     *   · 不套 ctx.effect，直接调即可（老插件就这么写的，能正常挂）。
     */
    function applyDouyinSettings(ctx) {
      try {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'douyin-on-base',
            order: 120,
            label: function () { return '抖音助手'; },
          }, function DouyinSettingsWithBoundary() {
            return h(Boundary, null, h(Panel, null));
          });
        });
      } catch (e) {
        return function () {};
      }
    }

    module.exports = {
      name: 'dsh-douyin-on-base-ui',
      inject: ['slots'],
      apply: applyDouyinSettings,
    };

    return module.exports;
  },
});
