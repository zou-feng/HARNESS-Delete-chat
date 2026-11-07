# 调参手册（自己改）

所有可调项只在这三个文件里：

| 文件 | 管什么 |
| --- | --- |
| `index.js` | **Host 半**：五个路由、删哪些目录、等多久、大小上限、定位超时、导入与换区的策略 |
| `client.js` | **浏览器半**：菜单位置与顺序、底部全局入口、文案、样式、交互节奏 |
| `format.js` | **格式层（纯函数）**：zstd 多帧、ZIP 读取、JSONL、头记录规范化与改挂 cwd |

改完要做什么：

| 改的是 | 生效方式 |
| --- | --- |
| `index.js` / `format.js` | **重启 DSH**（Node ESM 按 URL 缓存模块，热重载不会重新导入） |
| `client.js` | **重启 DSH**，然后刷新页面（浏览器 bundle 在启动时组装） |
| `cordis.patch.yml`（profile 里的那段） | 即时（profile 配的是 `patchReload: live`） |
| 只改 `*.md` | 不需要重启 |

每次改完都跑一遍：

```powershell
node --check index.js
node --check client.js
node --check format.js
node tools-selftest.cjs
```

> 下面行号按 1.1.0 的文件标注。改动后行号会漂，用 `Select-String` 搜关键字最稳。

---

## 一、菜单位置与顺序

### 1.1 会话行“…”菜单里的四项

**文件**：`client.js`　**第 801–804 行**

| 行 | id | order | 是什么 |
| --- | --- | --- | --- |
| 801 | `conversation-delete.export` | `410` | 导出对话 |
| 802 | `conversation-delete.reveal` | `420` | 打开文件位置 |
| 803 | `conversation-delete.move` | `440` | 更换工作区… |
| 804 | `conversation-delete.delete` | `500` | 删除对话（危险色，放最后） |

宿主自己的四项是 `置顶 100 / 重命名 200 / 分叉 300 / 归档 400`，升序排列。
本插件用 `410/420/440` 挤在归档之后、`500` 留给删除。

### 1.2 侧边栏底部的全局「导入对话」

**文件**：`client.js`　**第 808–816 行**（注册在 `sidebar.footer.action`，`order: 100`）

**为什么在这**：导入是**全局**动作 —— 它不属于某一条对话，所以不能挂在会话右键菜单里。
`sidebar.footer.action` 是「Settings 旁边那一排可选动作」，宽栏时显示图标 + 文字，
侧边栏收成 56px 导轨时只剩图标（宿主把 `wide` 传进来，组件按它决定要不要渲染文字）。

| 想调什么 | 怎么做 |
| --- | --- |
| 换个顺序 | 改各自的 order；整数比较，允许 411/412 这种细调 |
| 把导入挪回会话行菜单 | **不建议**（逻辑错位）；真要挪就把 808–816 的注册改成 `MENU_SLOT` + `createActionRow` |
| 底部入口放到最前/最后 | 改它的 order（同一槽位里其它插件目前只有 `cordis-panel`） |

⚠️ **别改 `id`**：换成宿主已有的 `pin/rename/fork/archive` 会**顶掉**那一行。
分隔线（`separatorBefore`）在 `client.js` 的 `apply` 里写死：导出行与删除行各一条。

---

## 二、会话文件根目录

**文件**：`index.js`　**第 113–116 行**（`sessionsRoot()`，内部走第 88–101 行的 `resolveRoot()`）

解析优先级，从高到低：

1. 插件 config 的 `sessionsRoot`
2. `ctx.sessionPersistence.config.root` / 后端自己的 `root` 字段 —— **运行时读后端真实配置，一般这才是对的**
3. `$DSH_HOME\sessions`
4. `~\.dsh\sessions`

**通常不要改。** 只有多根 / 迁移 / 测试环境才手工指定：

```yaml
# $DSH_HOME\profiles\web\cordis.patch.yml 里那一行加 config：
- insert:
    - id: conversation-delete
      name: dsh-plugin-conversation-delete
      config:
        sessionsRoot: 'D:\other\dsh\sessions'
        settleMs: 4000
```

**安全范围**：必须是一个存在且可写的目录。填错不会误删别处 ——
删除 / 导入 / 换区的目标都必须满足 `<root>\<项目>\<会话id>` 三段形状
（第 174–180 行的 `isInsideSessionDir`），不满足就拒绝。

---

## 三、附件对象根目录

**文件**：`index.js`　**第 118–120 行**（`attachmentsRoot()`）

默认 `$DSH_HOME\attachments`，其下 `v1\objects\<sha256 前两位>\<sha256>` 是内容寻址的对象仓。
导入 ZIP 时会往这里还原图片（先校验 sha256 必须等于条目 id 才写）。
只有在附件仓不在 `$DSH_HOME` 之下时才需要配 `attachmentsRoot`。

---

## 四、等会话退出内存的时间

**文件**：`index.js`　**第 54 行**（默认值）、**第 318 行**（删除）、**第 739 行**（换区）

```js
const DEFAULT_SETTLE_MS = 2500
```

删除与更换工作区都会先归档停活，然后等它从 Host 的 `ctx.sessions` 里消失，最长等这么久。

| 情况 | 实测 |
| --- | --- |
| 冷会话（没被 GUI 打开过） | 立即就不在，一点不耗 |
| 被打开过的会话 | **永远不会消失**（Harness 丢掉了能释放它的句柄），所以必定等满 |

**安全范围**：`0 – 10000`。调大只是让按钮多转几秒，**不会更安全**；建议保持 `2500`。

> 注意两者含义不同：**删除**等不到也能继续（文件照删，靠归档隐藏）；
> **换区**等不到就**拒绝**（不能在 Agent 脚下改它的 cwd）。

---

## 五、导入 / 导出的大小上限

**文件**：`index.js`

| 项 | 行 | 默认 | 说明 |
| --- | --- | --- | --- |
| 导入上传上限 | 57 & 990 | `64 MiB` | 超过就 `400`；config `maxImportBytes` 可覆盖 |
| 导出读取上限 | 60 & 386 | `256 MiB` | 超过就拒绝导出并给出字节数；config `maxExportBytes` 可覆盖 |
| JSON 请求体上限 | 63 | `64 KiB` | `delete`/`reveal`/`move`/`export` 的请求体，只装 id |

都是**整体读进内存**的，不要设成几个 GB。

---

## 六、打开文件位置的超时

**文件**：`index.js`　**第 66 行**（值）、**第 645 行**（调用处）

```js
await controller.openWorkspacePath({ path: target, action: 'reveal' }, AbortSignal.timeout(REVEAL_TIMEOUT_MS))
```

`revealNativePath` 把请求交给桌面进程后立刻返回（Windows 上 Explorer 退出码 1 也算成功），
这个 15 s 只是兜底。**一般不用改。**

---

## 七、会话 id 白名单（路径穿越守卫）

**文件**：`index.js`　**第 51 行**

```js
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
```

想更严（只认标准会话 id）：`/^session-[0-9a-f]{8}-\d{4}-\d{4}-\d{4}-[0-9a-f]{12}$/`
—— 但注意子代理会话的 id 是**纯 UUID**（没有 `session-` 前缀），太严会让它们删不掉/导不进来。

**绝对不要**放宽到允许 `/`、`\`、`:`、空白或控制字符。改完必须重跑自测
（第 4 组会拿这个正则去撞 `../../evil` 等样本）。

---

## 八、文案（中英）

**文件**：`client.js`　**第 50–138 行**（`zh` 第 50 行、`en` 第 92 行）

| 键前缀 | 用在哪 |
| --- | --- |
| `menu.*` | 会话行菜单四项 + 底部「导入对话」的文字 |
| `confirm.*` | 删除确认框（含 `{title}`） |
| `import.*` | 导入弹窗（`{id}`、`{kind}`、`{events}`、`{bytes}`、`{media}`、`{files}`、`{count}`） |
| `move.*` | 更换工作区弹窗（`{title}`、`{workspace}`、`{path}`） |
| `notice.*` | 打开文件位置失败时的提示框 |
| `copy` / `copied` / `cancel` / `close` / `confirmClose` | 按钮与无障碍标签 |
| `error.prefix` | 失败前缀，含 `{message}` |

`{title}` 这类是插值占位符：**位置可以搬，名字不能改**（改了就不原样替换，会显示成 `{title}`）。

---

## 九、样式与主题令牌

**文件**：`client.js`　**第 140–197 行**（`CSS` 数组，拼成一个字符串注入 `<style>`）

| 想调什么 | 行 | 现值 |
| --- | --- | --- |
| 菜单行高度 / 字号 | 144–147 | `min-height:34px`、`font-size:13px`（与宿主菜单一致） |
| 危险行配色 | 150–153 | `.dshcd-row-danger`，`--dsw-alias-state-error-primary` + `…-hover-danger` |
| 图标色 | 154–156 | `--dsw-alias-menu-icon` |
| 弹窗宽度 | 163 | `width:min(420px,100%)`（比宿主 380px 略宽，为放导入/换区结果） |
| 遮罩 | 159–162 | `--dsw-alias-bg-mask-1` + `--dsw-mask-blur` |
| 路径块（等宽） | 175–178 | `ui-monospace` 字体栈 + `--dsw-alias-bg-layer-1` |
| **底部全局按钮** | 190–195 | `.dshcd-footer-action`，`height:32px`、图标 16px、`label-secondary` |
| 工作区列表 | 196–204 | `.dshcd-ws*`，`--dsw-radius-sm` + `--dsw-alias-interactive-bg-hover` |
| 危险按钮 | 205–206 | `.dshcd-button-danger` |

**规矩**：

- **只引用 `var(--dsw-*)` / `var(--dsh-*)` 令牌**，不要写死颜色 —— 明暗主题靠它。
  唯一允许写死的是 `icon.svg` 里的品牌红（图标是美术资源，不是 UI 表面）。
- 令牌白名单在 `tools-selftest.cjs` 第 8 组；引用了白名单外的令牌，自测直接失败。
- 类名统一 `dshcd-` 前缀：宿主 primitives 的类名是构建期哈希，插件既拿不到也不该依赖。
- 浮层入口必须保留 `pointer-events:auto`（第 159 行）：`shell.overlay` 的容器是
  `pointer-events:none`，只有**直接子元素**会被宿主 CSS 自动打开点击（`.overlayLayer>*`）。
- 注意 `.dshcd-row-danger` 与 `.dshcd-button-danger` 是**两个**类，别合并：
  行的变体只改颜色/悬停底，按钮的变体还要加边框。
- 底部全局按钮要能在「宽栏 / 56px 导轨」两种形态下都不难看：组件按 `props.wide` 决定是否渲染文字。

---

## 十、删除前的节奏

**文件**：`client.js`　**第 404 行**

```js
.then(function () { return new Promise(function (done) { window.setTimeout(done, 400) }) })
```

顺序是：**先**调宿主的归档动作（`uiWorkspace.archiveSession(id, {stopActivity:true})`，
它会清掉「当前选中会话」的状态）→ 等 400 ms 让前端落定 → **再**请求 Host 删文件。

**安全范围**：`0 – 2000`。太快也不致命（归档已经挡住该会话继续跑）。

---

## 十一、归档策略（**风险最高的一项，别乱改**）

**文件**：`index.js`　**第 299 行**（删除）、**第 735 行**（换区）

```js
await registry.archiveSession(sessionId, { stopActivity: true })
```

- `{ stopActivity: true }` **必须保留**：它先落盘归档集合，再让所有 `workspace/session-stop`
  提供者去停活；归档集合正是 `agent/pre-step` 闸门读的东西，所以停下来的会话**不会被再次唤醒**。
- **删除时故意不撤销归档。** 别在删除后加 `unarchiveSession`：被 GUI 打开过的会话会一直留在
  Host 内存里（Harness 自己丢掉了能释放它的 Agent 句柄），撤销归档 = 让它立刻回到侧边栏 ——
  文件已经删了行却还在。自测第 6 组把「绝不出现 unarchiveSession」钉成了断言。
- **换区**用同一个调用，但目的是另一件事：把会话停到能安全改写它 cwd 的程度。

---

## 十二、更换工作区的策略与安全顺序（代码级，没有 config）

**文件**：`index.js`（`moveConversation()`，**第 685–905 行**）

**为什么必须搬家**：工作区归属 = 会话头的 `cwd` 等于工作区路径（`Workspace` 的契约，
`attachSession()` 对不匹配的直接拒绝）。所以改 cwd 之后日志也必须跟着到新 cwd 的项目目录。

**目标怎么选（客户端 `client.js` 的 `MoveDialog`）**：两条路 ——
① 列表里已有的工作区；②「选择目录…」，依次调两个宿主提供的客户端服务：
`ctx.get('uiWorkspace').pickDirectory()`（原生目录选择器，取消返回 `null`）→
`ctx.get('workspaces').create({ path })`（为该目录建立**或复用**工作区，返回带 `workspaceId` 的视图）
→ 再 `POST /move`。**只列已有工作区是不够的**：实测注册表里往往只有一个（当前那个），那就等于没得选。

| 步骤 | 行 | 说明 |
| --- | --- | --- |
| 目标工作区必须存在且目录在 | 703–733 | 目录不在就拒绝（`stat().isDirectory()`） |
| 活着的会话先归档停活 | 733–747 | 等不到就拒绝：`this conversation is still open on the Host` |
| 拿当前日志路径 | 749–770 | `stat` + `locate`；stat 失败会先清注册表头缓存再重试一次 |
| 已经在该工作区 | 772–784 | 只补一次 `attachSession`，不搬文件，`note: 'already in that workspace'` |
| 改写 cwd | 795 | `retargetHeader(parsed.header, targetPath)` —— **保留血缘** |
| 新位置守卫 | 815–822 | 三段形状 + 拒绝覆盖已有日志 + 拒绝并入已存在的目标会话目录 |
| **整目录内容一起搬** | 830–860 | 旧目录里的**每个条目**（含 `session.v3.jsonl.zstd` 这类历史代际）都 `rename` 进新目录 |
| 改写权威代际 | 862–870 | 临时文件 + `rename` 覆盖刚搬过来的 `session.v4.jsonl.zstd`（cwd 已改写） |
| **回读验证** | 872–885 | `stat` + `locate` 都必须指向新路径 |
| 失败回滚 | 887–900 | 搬回去 + 按**原始字节**写回权威代际 + 删掉新目录 + 清头缓存 |
| **清注册表头缓存** | 990–995 | 见下，必须做 |
| 成功清理 | 997–1004 | 旧目录此时已空，`rm -rf` 删掉 |
| 账户归属 | 1006–1019 | `target.attachSession()` 然后遍历其它工作区 `detachSession()` |
| 缓存失效工具 | 670–697 | `refreshWorkspaceHeaderCache()`：按能力探测 `invalidateSessionHeader` / `forgetSessionHeader` / `refreshSessionHeader` / `invalidateHeader`，退路是 `listStoredHeaders()` + `indexHeaders()` 整表重建 |

**为什么必须清缓存**：`attachSession()` 读 cwd 走 `host.readSessionHeader(id)`，而它的顺序是

```js
const live = this.ctx.get('sessions')?.get(id)   // 1. 活会话
if (live !== undefined) { … 返回 }
const cached = this.headers.get(id)              // 2. 内存缓存 —— 命中就直接返回
if (cached !== undefined) return cached
const headers = await this.listStoredHeaders()   // 3. 只有缓存没有才扫盘
```

磁盘搬完、缓存里还是旧 cwd，`attachSession` 就会拿旧 cwd 去 `realpath()` 并报
`its cwd '<旧路径>' does not resolve, so it cannot be validated` —— **文件明明搬好了却报失败**。
缓存失效的接口不在 `WorkspaceRegistryLike` 的公开契约里，所以按能力探测；
一个都探不到时还有兜底：`stat()` 在异常时会清一次缓存并重试（重试本身就会重建索引）。

改这里的任何一步都要记住两条：

1. **旧位置绝不能在验证时还认得出这条会话。** 一个会话目录里可能同时有多个代际文件
   （实测：`session.v3.jsonl.zstd` 与 `session.v4.jsonl.zstd` 并存），只藏起其中一个是不够的 ——
   后端会在两个项目目录里各找到一个匹配，抛 `duplicate JSONL session id`。
   所以要么整目录内容搬走，要么逐个 aside；**但不要改成「整个目录改名」**：
   `listSessionDirs()` 会列所有目录且不校验目录名，改名后的目录照样会被扫到。
2. **没有回读验证之前不能删旧目录**，而且回滚要把权威代际按**原始字节**写回
   （搬动过程中它已经被改写成新 cwd 了）。

自测第 3b 组把这些不变量钉成了断言。改完**必须**重跑自测。

---

## 十三、导入策略（代码级，没有 config）

**文件**：`index.js`（`importConversation()`，**第 469–610 行**）

| 行为 | 在哪 | 说明 |
| --- | --- | --- |
| 保留原 ID | 528–537 | 内存里没有、磁盘上没有、`stat` 也拿不到 → 沿用原 ID |
| 冲突时换新 ID | 405 & 535 | `mintSessionId()` → `session-<uuid>`；**绝不覆盖**已有日志 |
| 切断血缘 | `format.js` 的 `normalizeHeader()`（第 234 行） | 去掉 `parentSession`/`origin`，`delegationDepth` 归 0 |
| **必须有 `delegationDepth`** | 同上 | 后端的头校验要求它是计数；少了整份日志会被静默判为读不出来 |
| 必须有 cwd | 同上 | 没有 cwd 的记录不会出现在列表里，所以直接拒绝导入 |
| 回读验证 | 566–580 | `backend.stat(id)` 读不回来就是 `ok:false` |
| 原子落盘 | 558–565 | 临时文件 + `rename` |
| 图片还原 | `restoreAttachments()`（第 418 行） | 先 sha256 校验等于条目 id，再写到 `v1/objects/<xx>/<id>` |
| 文件还原 | 同上 | 按归档布局写到 `v1/files/<xx>/<digest>/<leaf>`（本机尚无该目录，属尽力而为） |
| 子代理不导入 | 同上 | `subagents/…` 计入 `skipped`，不影响 `ok` |
| 崩溃尾巴 | `format.js` 的 `parseArtifact()`（第 124 行） | 末帧解不开就丢弃该帧并标注 `droppedTornTail` |
| ZIP64 拒绝 | `format.js` 的 `readZip()`（第 331 行） | 明确报「不支持 ZIP64」，不猜 |

---

## 十四、自带的量测与校验

```powershell
node tools-selftest.cjs
```

11 组 / **132 项**（清单 / 语法 / Host / 会话 id 正则 / 路径守卫 / 危险行为 /
浏览器槽位 / 主题令牌白名单 / **格式层真测** / 版本一致性 / 令牌不入库），全过退出码 0。
其中第 9 组会真的调用 `format.js`：编解码往返、多帧切分是否精确铺满、手工 deflate ZIP 能否读到、
CRC 损坏能否抓到、头记录规范化与改挂 cwd 是否正确。

手动探五条路由（都不需要真的动数据）：

```powershell
foreach ($name in 'delete','export','import','reveal','move') {
  curl.exe -s -o NUL -w "$name -> %{http_code}`n" "http://127.0.0.1:3080/conversation-delete/$name"
}
# 期望五行都是 405：路由在，只是要求 POST

# 路径穿越守卫：期望 409 + "invalid session id"，不删任何文件
$b = Join-Path $env:TEMP 'probe.json'
[IO.File]::WriteAllText($b, '{"sessionId":"../../evil"}')
curl.exe -s -X POST -H "content-type: application/json" --data-binary "@$b" http://127.0.0.1:3080/conversation-delete/delete
```

> 想端到端试「导入」：**先导出一份**，再从侧边栏底部导回来 —— 导入会分配新 ID，不会覆盖原件；
> 试完可以用菜单里的「删除对话」把副本删掉。
> 想试「更换工作区」：先保证有**两个**工作区、并且这条对话**没开着**。
> 想试「删除」：**先造一个一次性会话**（新开会话随便发一句），别拿真在用的对话试。

---

## 十五、改动生效范围与检查清单

| 改了 | 生效 |
| --- | --- |
| `index.js` / `format.js` | 重启 DSH |
| `client.js` | 重启 DSH + 刷新页面 |
| profile 的 `cordis.patch.yml` | 即时 |
| 只改文档（`*.md`） | 不需要重启 |

发版前的固定动作：

- [ ] 改完跑 `node --check index.js`、`node --check client.js`、`node --check format.js`、
      `node tools-selftest.cjs`（应全绿）
- [ ] `package.json` 的 `version` 已更新
- [ ] `CHANGELOG.md` 新增了一节（自测第 10 组会比对顶部版本号）
- [ ] `README.md` 的「版本与下载」表已加行（自测第 10 组会比对）
- [ ] `INSTALL.md` 里出现产物名的地方已更新
- [ ] 重新打 tarball 并确认能装、能用
- [ ] 确认仓库里没有任何令牌（自测第 11 组会自动扫）
