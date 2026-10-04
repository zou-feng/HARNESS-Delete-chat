# 调参手册（自己改）

所有可调项只在这两个文件里：

| 文件 | 管什么 |
| --- | --- |
| `index.js` | **Host 半**：删哪些目录、等多久、归档策略、路由与请求上限 |
| `client.js` | **浏览器半**：菜单项位置、文案、样式、确认后的节奏 |

改完要做什么：

| 改的是 | 生效方式 |
| --- | --- |
| `index.js` | **重启 DSH**（Node ESM 按 URL 缓存模块，热重载不会重新导入） |
| `client.js` | **重启 DSH**，然后刷新页面（浏览器 bundle 在启动时组装） |
| `cordis.patch.yml`（profile 里的那段） | 即时（profile 配的是 `patchReload: live`） |

每次改完都跑一遍：

```powershell
node --check index.js
node --check client.js
node tools-selftest.cjs
```

> 下面行号按 1.0.0 版本的文件标注。改动后行号会漂，用 `Select-String` 搜关键字最稳。

---

## 一、菜单项的位置与顺序

**文件**：`client.js`　**第 369 行**

```js
order: 500,
```

宿主自己的四项是 `置顶 100 / 重命名 200 / 分叉 300 / 归档 400`，升序排列。

| 值 | 效果 |
| --- | --- |
| `500` | **默认**：排在「归档会话」下面，最靠下 |
| `450` | 仍在归档之后 |
| `410` | 紧贴归档下面 |
| `< 400` | 会插到「分叉」或更前面（不建议，红色危险项不该出现在中间） |

⚠️ **别改 `id`**（第 368 行 `'conversation-delete.delete'`）：换成宿主已有的 `pin/rename/fork/archive` 会**顶掉**那一行。

---

## 二、会话文件根目录

**文件**：`index.js`　**第 40–49 行**（`sessionsRoot()`）

解析优先级，从高到低：

1. 插件 config 的 `sessionsRoot`（下面有改法）
2. `ctx.sessionPersistence.config.root` —— **运行时读后端真实配置，一般这才是对的**
3. `$DSH_HOME\sessions`
4. `~\.dsh\sessions`

**通常不要改。** 只有在“会话根目录不是后端配置的那个”（多根、迁移、测试环境）时才手工指定：

```yaml
# $DSH_HOME\profiles\web\cordis.patch.yml 里那一行加 config：
- insert:
    - id: conversation-delete
      name: dsh-plugin-conversation-delete
      config:
        sessionsRoot: 'D:\other\dsh\sessions'
        settleMs: 4000
```

**安全范围**：必须是一个**存在且可写**的目录；填错不会自动纠正，会导致“找不到会话目录”（`removedDirs: []`）而**不会**误删别处 —— 路径守卫要求目录形状必须是 `<root>\<项目>\<会话id>` 三段。

---

## 三、等会话退出内存的时间

**文件**：`index.js`　**第 37 行**（默认值）、**第 188 行**（读 config 覆盖）

```js
const DEFAULT_SETTLE_MS = 2500
```

作用是：广播移除之后，等它从 Host 的 `ctx.sessions` 里消失，最长等这么久。

| 情况 | 实测 |
| --- | --- |
| 冷会话（没被 GUI 打开过） | 立即就不在，`settleMs` 一点不耗 |
| 被打开过的会话 | **永远不会消失**（Harness 丢掉了能释放它的句柄），所以必定等满 |

**安全范围**：`0 – 10000`。调大只是让「删除」按钮多转几秒，**不会让删除更安全**；`0` 也只是少等，不影响结果（归档已经挡住它继续跑）。

**建议**：保持 `2500`。

---

## 四、请求体上限

**文件**：`index.js`　**第 108 行**

```js
async function readJsonBody(req, limitBytes = 64 * 1024)
```

请求体里只有一个 `sessionId`（不到 100 字节），**不需要动**。

---

## 五、会话 id 白名单（路径穿越守卫）

**文件**：`index.js`　**第 34 行**

```js
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
```

想更严（只认标准会话 id）：`/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`
（注意子代理会话的 id 是**纯 UUID**，没有 `session-` 前缀，太严会让它们删不掉。）

**绝对不要**放宽到允许 `/`、`\`、`:`、空白或控制字符。改完必须重跑自测：
`node tools-selftest.cjs`（第 4 节会拿这个正则去撞 `../../evil` 等样本）。

---

## 六、文案（中英）

**文件**：`client.js`　**第 44–68 行**（`zh` 第 44 行、`en` 第 57 行）

| 键 | 含义 |
| --- | --- |
| `menu.deleteConversation` | 菜单里那行的文字 |
| `confirm.title` | 弹窗标题 |
| `confirm.desc` | 第一段说明，含 `{title}` |
| `confirm.note` | 第二段说明（明确“不动工作目录”） |
| `confirm.action` / `confirm.pending` | 危险按钮：常态 / 进行中 |
| `cancel` / `close` | 取消按钮 / 关闭按钮的 aria-label |
| `row.aria` | 行的无障碍标签，含 `{name}` |
| `error.prefix` | 失败提示前缀，含 `{message}` |

`{title}`、`{message}`、`{name}` 是插值占位符：**位置可以搬，名字不能改**（改了就不替换，会原样显示 `{title}`）。

---

## 七、样式与主题令牌

**文件**：`client.js`　**第 76–117 行**（`CSS` 数组，一个字符串拼起来注入 `<style>`）

| 想调什么 | 行 | 现值 |
| --- | --- | --- |
| 菜单行高度 / 字号 | 80–83 | `min-height:34px`、`font-size:13px`（与宿主菜单一致） |
| 弹窗宽度 | 94–96 | `width:min(380px,100%)`（与宿主 Modal 同宽） |
| 遮罩 | 90–93 | `--dsw-alias-bg-mask-1` + `--dsw-mask-blur` |
| 危险色（文字/边框） | 113 | `--dsw-alias-state-error-primary` |
| 危险色（悬停底） | 82–83 | `--dsw-alias-interactive-bg-hover-danger` |
| 圆角 | 各处 | `--dsw-radius-md` / `--dsw-radius-sm` / `--dsw-radius-panel` |

**规矩**：

- **只引用 `var(--dsw-*)` / `var(--dsh-*)` 令牌**，不要写死颜色 —— 明暗主题靠它。
  唯一允许写死的是 `icon.svg` 里的品牌红（图标是“美术资源”，不是一个 UI 表面）。
- 令牌白名单在 `tools-selftest.cjs` 第 8 节；引用了白名单外的令牌，自测会失败。
- 类名统一 `dshcd-` 前缀：宿主 primitives 的类名是构建期哈希，插件既拿不到也不该依赖。
- 浮层入口必须保留 `pointer-events:auto`（第 90 行）：`shell.overlay` 的容器是
  `pointer-events:none`，只有**直接子元素**会被宿主 CSS 自动打开点击（`.overlayLayer>*`），
  自己再声明一次最稳 —— 宿主 `Modal` 也是这么做的。

---

## 八、点确认后等多久再发请求

**文件**：`client.js`　**第 227 行**

```js
.then(function () { return new Promise(function (done) { window.setTimeout(done, 400) }) })
```

顺序是：**先**调宿主的归档动作（`uiWorkspace.archiveSession(id, {stopActivity:true})`，
它会清掉“当前选中会话”的状态）→ 等 400ms 让前端把这步落定 → **再**请求 Host 删文件。

**安全范围**：`0 – 2000`。太快也不致命（归档已经挡住该会话继续跑），只是体验上可能看到界面还在过渡。

---

## 九、归档策略（**风险最高的一项，别乱改**）

**文件**：`index.js`　**第 169 行**

```js
await registry.archiveSession(sessionId, { stopActivity: true })
```

- `{ stopActivity: true }` **必须保留**：它先落盘归档集合，再让所有 `workspace/session-stop`
  提供者去停活；归档集合正是 `agent/pre-step` 闸门读的东西，所以停下来的会话**不会被再次唤醒**。
  去掉它，会话仍在跑的时候删日志，就会和写入者打架。
- **故意不撤销归档。** 别在删除后加 `unarchiveSession`：
  被 GUI 打开过的会话会一直留在 Host 内存里（Harness 自己丢掉了能释放它的 Agent 句柄），
  撤销归档 = 让它立刻回到侧边栏 —— 文件已经删了，行却还在。
  完整解释见 README「设计要点 2」。自测第 6 节会把这条钉成断言。

想连这个也改，请先读 README 的设计要点，别只看代码。

---

## 十、自带的量测与校验

```powershell
node tools-selftest.cjs
```

`tools-selftest.cjs` 会做 10 组检查（清单 / 语法 / Host 导出 / 会话 id 正则 / 路径守卫 /
危险行为 / 浏览器槽位 / 主题令牌白名单 / 版本一致性 / 令牌不入库），
全过退出码 0，有任何一条不过就打印失败清单并退 1。上传前必须全绿。

手动探一下 Host 路由（不需要删除任何东西）：

```powershell
# 期望 405 + {"ok":false,"error":"POST required"}：路由在，只是要 POST
curl.exe -s -i http://127.0.0.1:3080/conversation-delete/delete

# 期望 409 + "invalid session id"：路径穿越守卫在工作，不会删任何文件
$b = Join-Path $env:TEMP 'probe.json'
[IO.File]::WriteAllText($b, '{"sessionId":"../../evil"}')
curl.exe -s -X POST -H "content-type: application/json" --data-binary "@$b" http://127.0.0.1:3080/conversation-delete/delete
```

> 想端到端试删除，**先造一个一次性会话**（新开会话随便发一句），别拿真在用的对话试。

---

## 十一、改动生效范围与检查清单

| 改了 | 生效 |
| --- | --- |
| `index.js` | 重启 DSH |
| `client.js` | 重启 DSH + 刷新页面 |
| profile 的 `cordis.patch.yml` | 即时 |
| 只改文档（`*.md`） | 不需要重启 |

发版前的固定动作：

- [ ] 改完跑 `node --check index.js`、`node --check client.js`、`node tools-selftest.cjs`
- [ ] `package.json` 的 `version` 已更新
- [ ] `CHANGELOG.md` 新增了一节（自测第 9 节会比对顶部版本号）
- [ ] `README.md` 的「版本与下载」表已加行（自测第 9 节会比对）
- [ ] `INSTALL.md` 里出现产物名的地方已更新
- [ ] 重新打 tarball 并确认能装、能用
- [ ] 确认仓库里没有任何令牌（自测第 10 节会自动扫）
