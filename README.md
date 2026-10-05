# dsh-plugin-conversation-delete

给 DeepSeek Harness 网页端加一个**对话工具箱**：会话行 **“…”** 菜单里多出四行
**导出对话 / 打开文件位置 / 更换工作区… / 删除对话**；
另外在**侧边栏底部**（Settings 旁边）加一个全局的 **「导入对话」**
—— 导入是全局动作，不该挂在某一条对话的菜单里。

- 包名：`dsh-plugin-conversation-delete`　仓库名：`HARNESS-Delete-chat`（两者不必同名）
- 类型：**DSH 网页端独立插件**（Host 半 + 浏览器半），装一次后随 DSH 启动自动加载
- 运行时**零第三方依赖**：Host 半只用 Node 内置模块（`node:zlib` / `node:crypto` / `node:fs`），
  浏览器半只用宿主的 `react` 与 `ctx` 服务

---

## 五个功能

| 位置 | 菜单项 | 顺序 | 做什么 |
| --- | --- | --- | --- |
| 会话行“…”菜单 | **导出对话** | 410 | 优先调用 DSH 自带下载控制器，产出宿主那个规范 ZIP（`dsh-session-<id>.zip`，含子代理后代与附件）；拿不到它才退回本插件路由，输出原始 `session.v4.jsonl.zstd` |
| 会话行“…”菜单 | **打开文件位置** | 420 | 在系统文件管理器里定位该对话的文件（Windows 用 `explorer.exe /select,`）；失败时弹出可复制的路径 |
| 会话行“…”菜单 | **更换工作区…** | 440 | 把这条对话搬到另一个工作区：改写它的 cwd、把会话文件挪到新工作区的目录下、改掉工作区归属 |
| 会话行“…”菜单 | **删除对话** | 500 | 停活在跑的会话 → 归档隐藏 → 删除它在磁盘上的会话文件（危险色，放最后一行） |
| **侧边栏底部**全局动作 | **导入对话…** | 100 | 选一个导出的对话文件（`.zip` / `.jsonl` / `.jsonl.zstd`），把它变成一条真实会话写回磁盘 |

### 导出与导入的文件格式

导入能识别三种输入，**导出产出的两种都在这三种里**，所以导出的文件一定能导回来：

| 输入 | 来源 | 说明 |
| --- | --- | --- |
| `.zip` | **DSH 自带导出**（会话标题栏“更多操作 → 下载会话日志”，或 `/export`） | ZIP 根条目 `session.v4.jsonl` 是规范 JSONL；还含 `subagents/…`、`media/…`、`files/…` |
| `.jsonl.zstd` | **本插件的兜底导出** | 磁盘上的原始会话 artifact（多帧 zstd 容器） |
| `.jsonl` | 手工整理 / 从 ZIP 里解出来 | 规范 JSONL 文本 |

导入时：**ID 空闲就沿用原 ID，被占用则分配新 ID，绝不覆盖已有日志**；
切断 `parentSession`/`origin`/`delegationDepth` 血缘，让它成为一条独立的顶层对话；
写完后用 `sessionPersistence.stat()` 回读验证一次。

---

## 删什么、不删什么

| 动作 | 对象 | 说明 |
| --- | --- | --- |
| ✅ 删 | 会话日志文件 | `<DSH_HOME>\sessions\<项目目录>\<会话id>\session.v4.jsonl.zstd` |
| ✅ 删 | 侧边栏那条记录 | 广播 `api-session/removed` + 客户端 `sessions.refresh()` |
| ✅ 停 | 该会话正在跑的工作 | 先归档（`archiveSession { stopActivity: true }`），停 turn / 子代理 / 任务 |
| ✅ 清 | 工作区里的归属记录 | `workspace.detachSession()` + `unpinSession()` |
| ❌ 不动 | 工作目录里的任何文件 | 你的项目文件、`harness work space` 里的东西，一个都不碰 |
| ❌ 不动 | 附件库、其他会话 | `$DSH_HOME\attachments` 与其他 session 目录保持不变 |

**删除不可恢复**，没有回收站，没有撤销。导入会写新文件，但**永不覆盖**已有日志。

---

## 版本与下载

| 版本 | 分支 | 标签 | 产物 | 说明 |
| --- | --- | --- | --- | --- |
| 1.1.0 | [`version/1.1.0`](../../tree/version/1.1.0) | [`v1.1.0`](../../releases/tag/v1.1.0) | `dsh-plugin-conversation-delete-1.1.0.tgz` | 对话工具箱：导出 / 打开文件位置 / 更换工作区 / 删除（会话行菜单）+ 导入（侧边栏底部） |
| 1.0.0 | [`version/1.0.0`](../../tree/version/1.0.0) | [`v1.0.0`](../../releases/tag/v1.0.0) | `dsh-plugin-conversation-delete-1.0.0.tgz` | 首个版本：只有删除对话 |

每个版本另开 `version/<版本号>` 分支；`main` 不直接接收发布推送。

---

## 设计要点

### 1. 删除：为什么先归档、再删文件、而且**不撤销归档**

- 归档是**官方提供的停止手段**：先把 id 写进持久的归档集合，再让所有 `workspace/session-stop`
  提供者去停活；而归档集合正是 `agent/pre-step` 闸门读的东西 —— 被停下的会话不会被再次唤醒。
- 被 GUI 打开过的会话，其 Agent 句柄被 Harness 自己丢掉了（`ApiSessionAgentController` 只留 `agent`，
  不留 `handle`），**没有任何公开 API 能按 id 释放它**，它会一直留在 Host 的 `ctx.sessions` 里直到进程重启；
  而会话列表 = `ctx.sessions.list()` ∪ 磁盘存储。也就是说这种会话删完文件后**内存里那份还在**，
  刷新列表会把它带回来。归档集合是唯一能把它挡在侧边栏外面的东西，所以删除**故意保留归档记录**
  （代价：归档集合里留一个永不复现的 id，惰性无害）。

### 2. 导出：为什么复用宿主实现，而不是自己造 ZIP

DSH 已经有一个完整、正确的导出：`GET /api/session.export` 流式产出 ZIP，包含子代理后代、
图片对象与文件对象，并且导出前会 flush 活会话。它唯一的问题是入口在**会话标题栏**的“更多操作”里，
不在会话列表的右键菜单里。

自己重造一份只会产出「长得像但可能缺附件」的 ZIP，破坏互换性。所以本插件的导出**优先调用**
宿主在客户端提供的控制器：

```js
ctx.get('sessionLogDownload').download(sessionId)   // -> 宿主那个规范 ZIP
```

拿不到这个服务（例如组合里没有该插件）时，才退回自己的 `POST /conversation-delete/export`，
输出磁盘上的原始 artifact 字节 —— 诚实、无损、也一定能被本插件的导入吃回去。

### 3. 导入：为什么必须自己处理 zstd 多帧，以及为什么这是新行为

DSH 里**没有任何**把会话导回来的入口（没有路由、没有命令、没有 UI），所以导入完全由本插件定义。
写进去的必须是后端**自己的格式**：

```
session.v4.jsonl.zstd = 一串可独立解码、各自带校验和的 zstd 帧
  帧1  = 恰好一行头记录（JSON）
  帧2..N = 若干行事件记录（JSONL）
```

两个坑：

- **Node 的公开 zstd API 只解第一帧就停下**（`zstdDecompressSync` 与 `createZstdDecompress` 都是），
  多帧容器它不认。所以必须自己按帧结构切分，再逐帧解。
- 扫描器按帧头里的**校验和标志**算帧长，所以写的时候每帧必须带校验和
  （`{ params: { [ZSTD_c_checksumFlag]: 1 } }`），否则整份文件会被后端判为损坏。

`format.js` 里的 `scanZstdFrames` 从 `@deepseek-ai/dsh-session-persistence-jsonl` 的切片器移植而来
（按帧头描述符 + 逐块块头走，比“扫魔数”可靠），`buildArtifact` 则把头写成一帧、事件写成另一帧。

### 4. 打开文件位置：为什么不自己 spawn explorer

宿主已经有正式的定位实现：`sessionController.openWorkspacePath({ path, action: 'reveal' })`
在 Windows 上执行 `explorer.exe /select,<file url>`，并且会先把路径过一遍 Host 路径校验
（`verifyDesktopPath`），Explorer 交接后退出码 1 也算成功。

它**不做存在性检查** —— 路径不存在时 Explorer 会默默打开「文档」文件夹而不报错 ——
所以本插件在调用前自己确认路径存在，失败时把路径显示出来供复制。

（`dsh-host-open-in-app` 不是这条路的替代：它是三个 HTTP 路由、只接受**已存在的目录**，
且 `explorer` 那一项是「打开目录」而不是「定位并选中文件」。）

### 5. 更换工作区：为什么必须改写 cwd、并把文件搬走

DSH 里**工作区归属就是由会话头的 `cwd` 定义的**，`Workspace` 的契约写得很直白：

> 隶属关系要求 id 在该工作区的账户里，**且会话头的 canonical cwd 等于工作区路径**；
> `sessionIds` 的读取视图会把 cwd 不匹配的行过滤掉；`attachSession()` 对 cwd 不匹配的直接拒绝。

所以「换工作区」光改记账是做不到的 —— 必须真的改写 cwd。而 cwd 一变，日志该待的目录也变了
（`projectKey(cwd)` 决定它落在哪个项目目录下），于是这次操作是一次**搬家**：

```
改写 header.cwd → 把日志写到新 cwd 的项目目录 → 旧目录删掉
                → 新工作区 attachSession → 旧工作区 detachSession
```

顺序是刻意排的，任何一步失败都能恢复：

1. **把旧会话目录里的每个条目都搬进新目录**（`rename`，同盘只是改元数据）。
   为什么不能只搬「定位到的那一个文件」：一个会话目录里可能同时有多个代际文件 ——
   实测就有 `session.v3.jsonl.zstd`（历史代际）与 `session.v4.jsonl.zstd`（当前代际）并存。
   v3 同样是合法代际，留在旧目录里，后端就会在两个项目目录里各找到这条会话，抛
   `duplicate JSONL session id appears in multiple project directories`。
   （也**不能**图省事把整个目录改名：`listSessionDirs()` 会列所有目录且不校验目录名，
   改名后的目录照样被扫、里面的文件照样算一个代际。）
2. **改写权威代际那一份**：临时文件 + `rename` 覆盖刚搬过来的 `session.v4.jsonl.zstd`，
   内容是按新 cwd 重新编码的完整日志。
3. **回读验证**：`stat(id)` 与 `locate()` 必须都指向新路径（旧目录此时已经空了）。
4. 验证通过才删掉（已空的）旧目录；不通过就整体回滚 —— 搬回去、把权威代际按**原始字节**
   写回、清掉新目录。

另外，活着的会话不能在它脚下改 cwd：先照删除那套归档停活、等它离开内存；等不到就拒绝并说明原因。

**目标怎么选**：弹窗同时给两条路 —— ① 「选择目录…」走宿主的目录选择器，选中后自动为该目录
**建立（或复用）一个工作区**再搬；② 从已有工作区列表里挑。
第一条是必需的：注册表里通常只有一个工作区（当前这个），只列已有工作区的话弹窗里就"没得选"。

### 6. 为什么弹窗不放在菜单项里

菜单项**和它所在的菜单一起被卸载**（点完 `setMenuOpen(false)` 就没了）。
所以那四行菜单项（以及侧边栏底部的导入入口）只负责“发起请求”，
对话框统一注册在 `shell.overlay`（跨栏浮层），两者通过一个小型可观察 store 通信。

### 7. 为什么自己写样式

宿主 primitives 的 CSS 类名是构建期哈希（`b1XyZ_item` 这种），插件拿不到也不该依赖。
本插件用自己 `dshcd-` 前缀的类名复刻宿主的菜单行 / 模态框样式，**只引用 `--dsw-*` 主题令牌**，
因此明暗主题都跟着走。

---

## 目录结构

```
HARNESS-Delete-chat/
├── package.json            # 清单：dsh.bundle.patch / dsh.client.platform=web / exports
├── cordis.patch.yml        # bundle 补丁：插入一行 loader 行（安装时被读）
├── index.js                # Host 半：五个路由 + 归档停活 + 删文件 + 导入落盘 + 搬迁换区 + 调宿主定位
├── format.js               # 格式层（纯函数）：zstd 多帧 / ZIP 读取 / JSONL / 头规范化 / 改挂 cwd
├── client.js               # 浏览器半：四行菜单项 + 一个全局导入入口 + 对话框宿主（懒 CJS，无构建）
├── icon.svg                # 插件管理页图标
├── locale/{zh,en}.json     # 插件卡片显示名/描述
├── tools-selftest.cjs      # 自测：11 组检查（含格式层真测）
├── README.md / INSTALL.md / TUNING.md / CHANGELOG.md
├── LICENSE / .gitignore
```

---

## 接口

四条路由都注册在 `ctx.webServer` 上（`kind: 'exact'`），且都只接受 **POST**（否则 `405`）。

### `POST /conversation-delete/delete`　`{ sessionId }`

| HTTP | 含义 |
| --- | --- |
| `200` | `ok: true`，会话文件已删 |
| `409` | `ok: false`（带 `error` 或 `failures[]`） |
| `400` / `405` / `500` | 请求体不合法 / 非 POST / 处理异常 |

响应字段：`ok`、`sessionId`、`sessionsRoot`、`wasLive`、`stillLive`、`archived`、
`removedDirs[]`、`failures[{step,error,path?}]`、`error?`、`note?`。

### `POST /conversation-delete/export`　`{ sessionId }`

成功返回 **原始文件字节**（`application/octet-stream`），并带一个
`x-conversation-filename: dsh-session-<safe-id>.jsonl.zstd` 供浏览器命名；
无文件时 `404` + JSON 报告。

### `POST /conversation-delete/import`　（请求体 = 上传的**原始字节**）

| HTTP | 含义 |
| --- | --- |
| `200` | `ok: true`，已写入并通过回读验证 |
| `409` | `ok: false`（格式不对 / 拒绝覆盖 / 越界写 / 回读失败） |
| `400` / `405` / `500` | 空请求体或超上限 / 非 POST / 处理异常 |

响应字段：`ok`、`originalId`、`sessionId`、`reIded`、`kind`(`zip`/`jsonl`/`artifact`)、`cwd`、
`events`、`bytes`、`artifactBytes`、`verified`、`droppedTornTail`、`extras`、
`restored{media,files}`、`skipped[{entry,reason}]`、`failures[]`、`error?`。

### `POST /conversation-delete/reveal`　`{ sessionId }`

响应：`ok`、`sessionId`、`path`、`kind`(`file`/`directory`)、`failures[]`、`error?`。

### `POST /conversation-delete/move`　`{ sessionId, workspaceId }`

把一条对话搬到另一个工作区（见设计要点 5）。

响应：`ok`、`sessionId`、`workspaceId`、`from{cwd,file}`、`to{workspaceId,path,title}`、
`movedFile{from,to}`、`verified`、`note?`（例如 `already in that workspace`）、
`failures[{step,error}]`（`stop`/`write`/`verify`/`restore`/`cleanup`/`attach`/`detach`）、`error?`。

### 浏览器半：槽位注册

| 槽位 | id | order |
| --- | --- | --- |
| `sidebar.workspaces.session.menu.item` | `conversation-delete.export` | 410 |
| 同上 | `conversation-delete.reveal` | 420 |
| 同上 | `conversation-delete.move` | 440 |
| 同上 | `conversation-delete.delete` | 500 |
| `sidebar.footer.action`（侧边栏底部全局动作） | `conversation-delete.import` | 100 |
| `shell.overlay` | `conversation-delete.dialog` | — |

字典命名空间：`conversation-delete`。

---

## 安装速查

```powershell
# 方式 A：标准安装（需要 pnpm）
#   在 DSH 里让 agent 调用 plugin_manager install_bundle，target 指向本目录；
#   或命令行： dsh plugin add <本目录绝对路径>
```

```powershell
# 方式 B：手工接线（机器上没有 pnpm 时 —— 本机就是这种）
$pkg = "<本仓库绝对路径>"                       # 或解包后的 package 目录
$dst = "$env:DSH_HOME\profiles\web\node_modules\dsh-plugin-conversation-delete"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$pkg\*" -Destination $dst -Recurse -Force
# 再把本仓库 cordis.patch.yml 里那段 - insert: 追加到
#   $env:DSH_HOME\profiles\web\cordis.patch.yml （该文件不能带 UTF-8 BOM）
```

重启 DSH 后验证四条路由都在：

```powershell
foreach ($p in 'delete','export','import','reveal','move') {
  curl.exe -s -o NUL -w "$p -> %{http_code}`n" -X GET "http://127.0.0.1:3080/conversation-delete/$p"
}
# 期望五行都是 405（路由在，只是要求 POST）
```

完整步骤、卸载与故障排查见 **[INSTALL.md](INSTALL.md)**；可调项见 **[TUNING.md](TUNING.md)**。

---

## 踩过的坑（都真的踩了）

1. **这台机器没有 pnpm。** `plugin_manager install_bundle` 报 `'pnpm' 不是内部或外部命令`；
   corepack 的垫片又要求联网拉 pnpm，而该请求失败。→ 只能手工接线。
2. **空仓库没有起点 sha。** 上传 1.0.0 时目标仓库是全新的：GitHub 对**没有任何提交**的仓库
   拒绝一切 Git Data 写入（`POST /git/blobs` 直接 409 `Git Repository is empty.`）。
   → 引导提交只能用 Contents API 建，再把完整内容作为它的子提交接上。
3. **Node 的公开 zstd API 只解第一帧。** 601 KB 的会话文件，`zstdDecompressSync` 只返回 318 字节
   （头记录），`createZstdDecompress` 同样在第二帧前停下。多帧容器必须自己按帧切分。
4. **每帧必须带校验和。** 后端的帧扫描器按帧头里的校验和标志计算帧长；少了它整份文件被判损坏。
5. **打开过的会话一定留在内存里**（见设计要点 1），所以删除时归档记录不能撤。
6. **菜单项会被卸载**，所以确认弹窗必须注册在 `shell.overlay`。
7. **`shell.overlay` 是 click-through 的**：宿主 CSS 是 `.overlayLayer{pointer-events:none}` +
   `.overlayLayer>*{pointer-events:auto}`，只有**直接子元素**才自动可点；入口自己再写一遍
   `pointer-events:auto` 最稳（宿主 Modal 也这么做）。
8. **`explorer.exe /select,` 传的是 file URL 且要转义 `,` 与 `=`**，路径不存在时它不报错而是打开
   「文档」文件夹 —— 所以调用前自己确认存在。
9. **附件是内容寻址的**：`media/<id>.<ext>` 里的 id 就是对象文件名的 sha256，
   还原前先按它校验字节，验不过就不写。
10. **会话目录名不可导入**：`projectKey()/sessionDir()` 是后端内部函数，`exports` 里没有 `./format`。
    → 一律用 `ctx.sessionPersistence.locate(header).path` 拿精确路径，再用三段形状守卫兜底。
11. **不要用 `window.confirm`**：插件 UI 属于宿主 UI，能用主题令牌就别用浏览器原生弹窗。
12. **`delegationDepth` 是头记录的必填字段**（实测抓到的）：后端的头校验
    `snapshotSessionFormatHeader` 要求 `version`/`id`/`createdAt`/`isSeeded`/**`delegationDepth`** 全在。
    导入时「切断血缘」把它一起删掉了 —— 后果不是报错，而是后端**静默不认**这份日志，
    会话永远不出现在列表里。现在导入把它归 0，换工作区原样保留。
13. **全局动作要放全局槽位**：「导入对话」一开始被我放进会话行菜单，逻辑上错位
    （导入不属于某一条对话）—— 现在挂在 `sidebar.footer.action`。
14. **一个会话目录里可以有多个代际文件**：实测有 `session.v3.jsonl.zstd`（历史代际）与
    `session.v4.jsonl.zstd`（当前代际）**并存**的会话。搬迁那条对话时只把定位到的 v4
    「改名 aside」是不够的 —— v3 同样是合法代际，旧目录仍然被认作这条会话的位置，
    后端于是抛 `duplicate JSONL session id … appears in multiple project directories`，
    回读验证失败、整体回滚。正确做法是**把旧目录的每个条目都搬走**；而**不能**改成
    「整个目录改名 aside」：`listSessionDirs()` 会列所有目录且不校验目录名，
    改名后的目录照样被扫、里面的文件照样算一个代际。
15. **失败明细要显示出来**：只显示一句概括（「搬迁未能验证，已回滚」）等于没报错 ——
    上面那个 duplicate 就是这么被埋在 `failures[]` 里看不见的。现在弹窗会把
    `failures[{step,error}]` 逐条附上。
16. **注册表缓存的是「会话头」，不是磁盘**：`attachSession()` 读 cwd 走
    `host.readSessionHeader(id)`，顺序是「活会话 → **内存缓存** → 扫盘」，
    **缓存命中就不扫盘**。搬迁只改磁盘、不清缓存，它就会拿旧 cwd 去 `realpath()`，
    报 `its cwd '<旧路径>' does not resolve, so it cannot be validated` ——
    文件明明已经搬好了，却报成失败。
    → 任何改写会话头 cwd 的操作，改完磁盘必须**立刻让缓存失效**，再去做别的后端调用。
    该失效接口不在公开契约里，所以按能力探测，并用 `stat()` 重试兜底。
17. **令牌不进库**：PAT 只在当次请求头里用，任何文件、任何提交里都没有它；自测第 11 组每次都会扫。

---

## 开发

```powershell
# 语法自检（Host 半与格式层是 ESM，浏览器半是懒 CJS，都能被 node --check 解析）
node --check index.js
node --check client.js
node --check format.js

# 自测：11 组（清单 / 语法 / Host / id 守卫 / 路径守卫 / 危险行为 /
#              浏览器槽位 / 主题令牌白名单 / 格式层真测 / 版本一致性 / 令牌不入库）
node tools-selftest.cjs
```

改动生效范围：

| 改了 | 生效方式 |
| --- | --- |
| `index.js`（Host 半） | **重启 DSH**（Node ESM 模块按 URL 缓存，热重载不会重新导入） |
| `format.js` | 同 `index.js`（被 Host 半 import） |
| `client.js`（浏览器半） | 浏览器 bundle 在启动时组装，需**重启 DSH** 后再刷新页面 |
| `cordis.patch.yml`（profile 里的那段） | 即时（profile 配置为 `patchReload: live`） |
| 只改 `*.md` | 不需要重启 |

---

## 许可

MIT，见 [LICENSE](LICENSE)。
