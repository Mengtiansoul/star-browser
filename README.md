# star-browser（dsh-star-browser）

一个**独立 Edge 管家**：自己开一个 Edge（独立 user-data-dir，跟你日常浏览器完全隔离），
对外开一个本地 HTTP 接口。DSH 插件、抖音自动化、网页抓取这些「租户」各带一个
`sessionId` 调它，各用各的页面，互不抢、不泄漏、不怕元素编号漂移。

它同时是 **DSH 插件**（`star_*` 工具集）和 **命令行工具**（`star-browser`）。

```
业务插件 A ──sessionId=A──┐
业务插件 B ──sessionId=B──┤──►  star-browser 管家 (127.0.0.1:9443)
抖音插件   ──CDP 直连───┘         │
                                  ├─ session A → page A
                                  ├─ session B → page B
                                  └─ 空闲 10 分钟自动回收
                                        ↓
                                  Edge (CDP 127.0.0.1:9227)
```

---

## 一、装（三种方式，选一个）

**① 用打好的 tarball（推荐，离线也能装）**

```bash
npm i -g ./dsh-star-browser-0.3.0.tgz
```

**② 直接指向源码目录**

```bash
cd <这个目录>
npm i -g .
```

**③ 开发模式（改代码立刻生效）**

```bash
npm link
```

装完先自检：

```bash
star-browser --doctor
```

```
star-browser 0.3.0
✅ Node 24.17.0（需要 ≥ 18）
✅ Edge: C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
✅ playwright-core: 1.63.0
⚪ 管家 9443: 没在跑
   数据目录: <包>/data
   profile : <包>/profile
```

## 二、跑

```bash
star-browser --headed      # 前台，能看见 Edge 窗口（首次登录抖音/B站用这个）
star-browser --headless    # 前台，无窗口
star-browser --detach      # 后台（Windows 自动注入登录用户的桌面会话）
star-browser --status      # 看当前状态 / 页面列表
star-browser --install-task    # 开机/登录静默自启（要管理员终端）
star-browser --uninstall-task  # 取消自启
```

> `postinstall` 只做检查、只打印，**不会**偷偷给你注册计划任务。
> 想自启就自己跑 `--install-task`。

## 三、推到 GitHub

包本身是个普通 Node 项目，`.gitignore` 已经排除了 `profile/`（几百 MB 登录态）、
`data/`、`node_modules/`、`*.tgz`。

```bash
cd <这个目录>
git init
git add .
git commit -m "star-browser 0.3.0"
git branch -M main
git remote add origin git@github.com:<你的账号>/star-browser.git
git push -u origin main
```

要发到 npm（别人才能直接 `npx star-browser`）：

```bash
npm login
npm publish --access public
```

> 名字 `dsh-star-browser` 得先确认没被占；占了就在 `package.json` 里改成自己的
> （`bin` 里的命令名 `star-browser` 可以保持不变）。

## 四、装成 DSH 插件

包根就是 DSH 插件（`index.mjs` + `cordis.patch.yml` + `dsh.bundle.patch`）：

```bash
node <DSH>/lib/bin.js plugin --profile web add link:<这个目录的绝对路径>
```

装完重启宿主，会多出 `star_browser_status` / `star_navigate` / `star_snapshot` /
`star_click` / `star_type` / `star_press` / `star_scroll` / `star_text` / `star_wait` /
`star_screenshot` / `star_pages` 这些工具。管家没起来时插件会自己调
`bin/launch-session1.mjs` 拉起（走计划任务，注入登录会话）。

## 五、命令参数

| 参数 | 说明 |
|---|---|
| `--headless` / `--headed` | 无头 / 有界面（默认有界面） |
| `--detach` | 后台起（Windows 借计划任务注入登录会话） |
| `--status` | 看当前状态（页面列表 / session 列表） |
| `--doctor` | 环境自检 |
| `--install-task` / `--uninstall-task` | 注册 / 取消登录自启 |
| `--port <n>` | 管家端口，默认 9443 |
| `--cdp-port <n>` | Edge 调试端口，默认 9227（别的插件靠它复用同一个浏览器） |
| `--data <dir>` | 数据目录，默认 `<包>/data` |
| `--edge <path>` | msedge 路径（默认自动探测） |
| `--session-user <name>` | 计划任务注入哪个登录用户（默认自动探测） |

环境变量：`STAR_HOST_PORT` / `STAR_BROWSER_CDP_PORT` / `STAR_BROWSER_DATA` /
`STAR_BROWSER_PROFILE` / `STAR_BROWSER_EDGE` / `STAR_BROWSER_HEADLESS` /
`STAR_SESSION_IDLE_MS` / `STAR_SNAP_ITEMS` / `STAR_NET_MAX` / `STAR_NET_BODY_MAX` /
`STAR_WATCHDOG_MS` / `STAR_EVAL_TIMEOUT_MS`。

## 六、目录结构

```
dsh-star-browser/
├── package.json          # bin / deps / dsh.bundle
├── host.mjs              # 管家（session 路由 / 回收 / 快照 / 防漂移 / 网络日志 / 看门狗）
├── index.mjs             # DSH 插件入口（star_* 工具）
├── cordis.patch.yml      # DSH bundle patch
├── bin/
│   ├── cli.mjs           # star-browser 命令
│   └── launch-session1.mjs  # 把管家注入登录用户的桌面会话
├── lib/
│   ├── config.mjs        # 路径与配置的唯一真相（跨机器可迁移）
│   ├── edge.mjs          # Edge 路径自适应探测
│   └── launch.mjs        # schtasks / vbs 生成（运行时生成，不落仓库）
├── scripts/postinstall.mjs
├── examples/
│   └── douyin-on-base/   # 业务插件接入范例（用接口 JSON，不解析 DOM）
└── data/                 # 运行时生成（profile 登录态在这）
```

**老布局兼容**：上一版把 profile 放在 `<包>/profile`、截图在 `<包>/shots`。
`lib/config.mjs` 会优先复用这些目录，升级不会让抖音/B站掉登录。

## 七、HTTP 接口

```
GET  /health            → {ok, ts, sessions, pages}
POST /rpc  {op, sessionId?, ...}
```

| op | 说明 |
|---|---|
| `status` | 运行状态、当前 session 的页面 |
| `snapshot` | 标题/网址/正文/带编号的可交互元素（可见元素优先） |
| `goto` / `back` / `forward` / `reload` | 导航 |
| `click` | `{i}` 或 `{selector}`；编号漂移按元素指纹重定位，失败回 `409 ELEMENT_GONE` + 新快照 |
| `type` / `press` / `scroll` / `wait` / `text` | 输入与读取 |
| `get_network_log` | 本 session 页面的 xhr/fetch 响应（含解析好的 JSON） |
| `eval` | 执行页面脚本，超时回 `504` 并强制中断 |
| `screenshot` / `newpage` / `switchpage` / `close` / `listpages` | 页面与截图 |
| `listsessions` / `closesession` / `quit` | 会话与退出 |

### 网络日志（给业务插件用）

```js
POST /rpc { op:'get_network_log', sessionId:'douyin-worker-1',
            limit:20, urlFilter:'/aweme/v1/', sinceSeq:0, maxBytes:6e6 }
→ { ok, total, returned, seq, bytes,
    entries:[{ i, ts, method, url, status, ct, json, text, bytes, error }] }
```

- 只收 `xhr` / `fetch`（图片、字体不占位）
- 条数上限 `STAR_NET_MAX`（100）、单条 body 上限 `STAR_NET_BODY_MAX`（2MB）、
  整个 session body 预算 `STAR_NET_TOTAL_BODY_MAX`（20MB，超了回收最老的 body 只留元数据）
- 同一页面最多 6 个并发 body 读取，防接口风暴
- 返回总量有预算（默认 1.5MB），超出的条目给 `omitted: true`
- ⚠️ 响应里可能有 token / cookie，别把日志原样外传

### eval 熔断

超过 `STAR_EVAL_TIMEOUT_MS`（15s）回 `504 EVAL_TIMEOUT`，并用 CDP
`Runtime.terminateExecution` 强制中断页面脚本；被卡过的 session 打 wedged 标记，
下次请求自动 reload（reload 也不行就换新页）。

> 实现要点：CDP 会话必须**提前建好**。渲染进程卡死时 `newCDPSession` 自己也会卡住，
> 那时候再建就等于没有中断的机会 —— 这是第一版翻车的地方（客户端 40s 超时）。

### 看门狗

每 `STAR_WATCHDOG_MS`（30s）检查：context 抛错或 CDP 端点不应答 → 连续两轮（约 60s）
判死 → 清 session → 杀自己 spawn 的 Edge（`attachedBrowser` 是别人的，不碰）→ 重新拉起。
不动 profile，登录态不丢。

## 八、接业务插件

看 `examples/douyin-on-base/index.mjs`：申请专属 `sessionId`、用 `get_network_log`
从接口拿视频列表、用 `eval` 注入 ArrowDown 滑动的完整骨架。

**实测结论（写业务前先看，能省两天）**：

- 抖音**搜索页走 XHR**：`/aweme/v1/web/general/search/single/` 返回完整 JSON，
  `data[].aweme_info` 里有 `aweme_id` / `desc` / `author` / `statistics`，单条约 900KB
- 抖音**推荐流不走 XHR**（React Server Components 首屏直出），网络日志截不到 feed；
  它只发 `danmaku` / `stats` / `history` 这类旁路请求 → 推荐流的元数据只能从 DOM/RSC 挖
- **滑动**：合成 `KeyboardEvent('keydown', {key:'ArrowDown'})` 实测有效；被拦就退 `press`

## 九、三个坑（别改）

1. **起浏览器必须 spawn + CDP**，不能用 `launchPersistentContext`：实测 Edge 已起来、
   CDP 已监听，它仍会等满 180 秒然后把手起的 Edge 杀掉。
2. **attach 来的浏览器绝不能 `close()`**：Playwright 对 CDP 连接调 close 等于发
   `Browser.close`，会把用户正在用的 Edge 整个关掉。只丢引用。
3. **Windows 的 Edge 必须在登录用户的会话里起**：服务会话（Session 0）启动会立刻退出
   （exitCode 1002，连 `--headless` 也不行）。所以后台启动一律走「计划任务 + 临时 vbs」。

## 十、平台

- **Windows**：后台启动走计划任务注入（CLI 自动处理，需要能拿到登录用户名；
  拿不到就设 `STAR_BROWSER_SESSION_USER`）。
- **macOS / Linux**：直接前台起（`star-browser --headless` 适合服务器）。
  登录自启用 launchd / systemd --user。

## 十一、FAQ

**Q：全局装之后抖音/B站要重新登录？**

会。`npm i -g <tgz>` 把包装到全局目录，`<包>/data/profile` 是全新的空 profile，
原来的登录态还在旧的 `<包>/profile` 里。三种解法（选一个）：

```bash
# ① 环境变量指回原来的数据目录（最干净）
setx STAR_BROWSER_DATA "D:\path\to\old\data"

# ② 给全局包建个目录联接（Windows，立即生效）
mklink /J "%APPDATA%\npm\node_modules\dsh-star-browser\data" "D:\path\to\old\data"

# ③ 别用 tgz 装，改用 npm link 指向源码目录（profile 就是源码那份）
cd <源码目录> && npm link
```

**Q：`star-browser` 命令找不到？**

`%APPDATA%\npm` 不在 PATH 里。跑一次
`setx PATH "%PATH%;%APPDATA%\npm"` 然后重开终端。

**Q：`--install-task` 报权限错误？**

注册登录自启要管理员权限。用「以管理员身份运行」的终端再跑一次。

**Q：`--detach` 说探测不到交互用户？**

服务身份下读不到登录用户。设 `STAR_BROWSER_SESSION_USER=<你的用户名>`。

## License

MIT
