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
  id: 'douyin-on-base-ui',
  factory: function (require) {
    var React = require('react');
    var h = React.createElement;
    var module = { exports: {} };
    var exports = module.exports;

    var API = '/douyin/api';

    /** hooks 兜底：宿主基座 shim 不完整时降级成静态渲染 */
    var useState = typeof React.useState === 'function' ? React.useState : function (v) { return [v, function () {}]; };
    var useEffect = typeof React.useEffect === 'function' ? React.useEffect : function () {};

    function getJson(path) {
      return fetch(API + path, { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
    }

    function postJson(path, payload) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
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
      btn: { height: '32px', padding: '0 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px',
        border: 'none', background: 'var(--dsw-alias-button-primary-fill, #4a6cf7)', color: '#fff' },
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
        var patch = {
          vision: {
            apiBase: d.apiBase,
            model: d.model,
            prompt: d.prompt,
            timeoutSec: Number(d.timeoutSec),
            fallbacks: String(d.fallbacks || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
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
        postJson('/config', { config: patch }).then(function (r) {
          setSaving(false);
          if (r.ok && r.body && r.body.ok) {
            setInfo('✅ 已保存到 config.json，工具下一次调用就生效（不用重启宿主）');
            hydrate(r.body);
            refreshState();
          } else {
            setErr('保存失败：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
          }
        }).catch(function (e) {
          setSaving(false);
          setErr('保存失败：' + (e && e.message ? e.message : e));
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

    module.exports = {
      name: 'douyin-on-base-ui',
      apply: function (ctx) {
        ctx.effect(function () {
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
        }, 'douyin-on-base: settings section');
      },
    };

    return module.exports;
  },
});
