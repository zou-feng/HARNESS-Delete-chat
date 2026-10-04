# dsh-plugin-conversation-delete

给 DeepSeek Harness 网页端加一个**“删除对话”**：在左侧会话行的 **“…”** 菜单里多一行红色的删除项，
点确认后**既删对话、也删它在磁盘上的会话文件**。

- 包名：`dsh-plugin-conversation-delete`　仓库名：`HARNESS-Delete-chat`（两者不必同名）
- 类型：**DSH 网页端独立插件**（Host 半 + 浏览器半），装一次后随 DSH 启动自动加载
- 运行时**零依赖**：Host 半只用 Node 内置模块，浏览器半只用宿主的 `react` 与 `ctx` 服务

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

**不可恢复。** 它不经过回收站，也没有撤销。

---

## 版本与下载

| 版本 | 分支 | 标签 | 产物 | 说明 |
| --- | --- | --- | --- | --- |
| 1.0.0 | [`version/1.0.0`](../../tree/version/1.0.0) | [`v1.0.0`](../../releases/tag/v1.0.0) | `dsh-plugin-conversation-delete-1.0.0.tgz` | 首个版本：菜单项 + 二次确认 + 删会话文件 |

> 本仓库的 `main` 与 `version/1.0.0` 指向**同一个提交**（空仓库的第一次提交，见下文“空仓库怎么起步”）。
> 之后每个版本都会另开 `version/<版本号>` 分支，`main` 不直接接收发布推送。

---

## 设计要点

### 1. 为什么先归档、再删文件

DSH 里“会话正在跑”和“会话被 GUI 打开过”是两件事，删文件前必须先把前者停掉：

- 归档是**官方提供的停止手段**：`workspaceRegistry.archiveSession(id, { stopActivity: true })`
  会把 id 写进持久的归档集合（先落盘），再让所有 `workspace/session-stop` 提供者去停活；
  而归档集合正是 `agent/pre-step` 闸门读的东西 —— 所以**停下来的会话不会被再次唤醒**。
- 停完才 `rm -rf` 那个会话目录。

### 2. 为什么归档记录**故意不撤销**

被 GUI 打开过的会话，其 Agent 句柄被 Harness 自己丢掉了（`ApiSessionAgentController` 只留 `agent`，不留 `handle`），
**没有任何公开 API 能按 id 释放它**，它会一直留在 Host 的 `ctx.sessions` 里直到进程重启；而会话列表 =
`ctx.sessions.list()` ∪ 磁盘上的存储。也就是说：这种会话删完文件后，**目录能删掉，但内存里那份还在，刷新列表会把它带回来**。

所以插件**保留归档记录**：归档集合让侧边栏默认视图继续隐藏它。代价是归档集合里会留下一个永不复现的 id（惰性、无害）。

### 3. 为什么用 HTTP 路由，而不是 Remote

给浏览器半一个 Host 能力，DSH 有两条路：

- **typert Remote**（`@Remote` + `ctx.remote.$mount`）：最正统，但要手写 `TYPERT` 描述符与 codec，而且客户端 `$mount` **只接受 `mode: 'strict'` 的 codec**（`src-json` 会被拒），要引 zod 或手搓 `create: () => ({ parse })`。
- **`ctx.webServer.register()` 精确路由 + 同源 `fetch`**：宿主自带的 HTTP 载体，无需任何额外声明与 schema。

本插件选后者：同源、无鉴权跳转、零依赖，且本机另一个第三方插件（`dsh-plugin-balance-pet`）已验证这条路在一键版里可用。

### 4. 为什么弹窗不放在菜单项里

菜单项**和它所在的菜单一起被卸载**（点完 `setMenuOpen(false)` 就没了），
所以“确认弹窗”必须注册在另一个槽位：`shell.overlay`（跨栏浮层）。两者通过一个小型可观察 store 通信。

### 5. 为什么自己写样式

宿主 primitives 的 CSS 类名是构建期哈希（`b1XyZ_item` 这种），插件拿不到也不该依赖。
本插件用自己 `dshcd-` 前缀的类名复刻宿主的菜单行 / 模态框样式，**只引用 `--dsw-*` 主题令牌**，因此明暗主题都跟着走。

---

## 目录结构

```
HARNESS-Delete-chat/
├── package.json            # 清单：dsh.bundle.patch / dsh.client.platform=web / exports["./client"]
├── cordis.patch.yml        # bundle 补丁：插入一行 loader 行（安装时被读）
├── index.js                # Host 半：删除路由 + 归档停活 + 删目录 + 广播移除
├── client.js               # 浏览器半：菜单行 + 确认弹窗（懒 CJS 工厂，无构建步骤）
├── icon.svg                # 插件管理页图标
├── locale/
│   ├── zh.json             # 插件卡片显示名/描述（中文）
│   └── en.json             # 同上（英文）
├── tools-selftest.cjs      # 自测脚本：清单/语法/路径守卫/主题令牌
├── README.md               # 本文件
├── INSTALL.md              # 换机安装 / 卸载 / 故障排查
├── TUNING.md               # 调参手册（哪一行、往哪调、安全范围）
├── CHANGELOG.md            # 更新日志
├── LICENSE                 # MIT
└── .gitignore
```

---

## 接口

### Host：`POST /conversation-delete/delete`

请求体（JSON，上限 64 KiB）：

```json
{ "sessionId": "session-b30ed786-5c4f-4e8b-b9ef-2b2bdf72eb1c" }
```

`sessionId` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`（单一路径段，拒绝 `../` 之类）。

响应：

| HTTP | 含义 |
| --- | --- |
| `200` | `ok: true`，会话文件已删 |
| `409` | `ok: false`，带 `error` 或 `failures[]`（部分步骤失败） |
| `400` | 方法不是 POST，或请求体不是 JSON 对象 / 超出上限 |
| `405` | 非 POST（对 GET 探测时的回答） |
| `500` | 处理中抛出异常 |

响应字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `ok` | bool | 所有步骤都成功 |
| `sessionId` | string | 回显 |
| `sessionsRoot` | string | 实际用的会话根目录 |
| `wasLive` / `stillLive` | bool | 删除前 / 等待后是否仍在 Host 内存里 |
| `archived` | bool | 本次是否写入了归档记录 |
| `removedDirs` | string[] | 实际删掉的会话目录 |
| `failures` | `{step,error,path?}[]` | 分步失败明细（`archive` / `detach` / `locate` / `delete` / `notify`） |
| `error` | string? | 整体失败原因（如 `invalid session id`） |
| `note` | string? | 仍留在内存时给出的解释 |

### 浏览器半：槽位注册

| 槽位 | id | order | 作用 |
| --- | --- | --- | --- |
| `sidebar.workspaces.session.menu.item` | `conversation-delete.delete` | 500 | “…”菜单里的红色删除行（在归档 400 之后） |
| `shell.overlay` | `conversation-delete.confirm` | — | 二次确认弹窗 |

| 注入 | 内容 |
| --- | --- |
| 菜单行 | `requestDelete({sessionId, displayTitle})` |
| 弹窗 | `store`（可观察 store）、`ctx`、`hooks.deleteRequest`（渲染成 `useDeleteRequest`） |
| 字典 | 命名空间 `conversation-delete`（`ctx.locale.register`） |

---

## 安装速查

```powershell
# 方式 A：标准安装（需要 pnpm）
#   在 DSH 里让 agent 调用 plugin_manager install_bundle，target 指向本目录；
#   或命令行： dsh plugin add <本目录绝对路径>
```

```powershell
# 方式 B：手工接线（机器上没有 pnpm 时 —— 本机就是这种）
$pkg = "<本仓库绝对路径>"                       # 或解包后的目录
$dst = "$env:DSH_HOME\profiles\web\node_modules\dsh-plugin-conversation-delete"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$pkg\*" -Destination $dst -Recurse -Force
# 再把本仓库 cordis.patch.yml 里那段 - insert: 追加到
#   $env:DSH_HOME\profiles\web\cordis.patch.yml
# 该文件不能带 UTF-8 BOM
```

重启 DSH 后验证：

```powershell
curl.exe -s -i http://127.0.0.1:3080/conversation-delete/delete
# 期望 HTTP/1.1 405 + {"ok":false,"error":"POST required"}
```

完整步骤、卸载与故障排查见 **[INSTALL.md](INSTALL.md)**；可调项见 **[TUNING.md](TUNING.md)**。

---

## 踩过的坑（都真的踩了）

1. **这台机器没有 pnpm。** `plugin_manager install_bundle` 直接报
   `'pnpm' 不是内部或外部命令`；corepack 的 `pnpm` 垫片又要求联网拉 pnpm，而该网络请求失败。
   → 只能走方式 B 手工接线，形态与仓库里已有的 `dsh-plugin-balance-pet` 一致。
2. **空仓库没有起点 sha。** 目标仓库是全新的（无提交、无分支），`POST /git/refs` 无从指起。
   → 用 Git Data API：`blobs` → `trees` → `commits(parents: [])` → `refs`，一次造出 `version/1.0.0`。
3. **打开过的会话一定留在内存里。** 见“设计要点 2”，这不是 bug 而是 Harness 现状；
   删“当前正开着的那个对话”时，文件真的会没，但内存那份要重启才彻底消失。
4. **菜单项会被卸载。** 一开始想把确认弹窗写在菜单项组件里 —— 点一下菜单收起，弹窗跟着没了。
5. **`shell.overlay` 是 click-through 的。** 宿主 CSS 是 `.overlayLayer{pointer-events:none}` +
   `.overlayLayer>*{pointer-events:auto}`：**直接子元素**才自动可点。插件的入口自己再写一遍
   `pointer-events:auto` 最稳妥（宿主 Modal 也是这么做的）。
6. **会话目录名不可导入。** `projectKey()/sessionDir()` 是 `dsh-session-persistence-jsonl` 的内部函数，
   `exports` 里没有 `./format`。 → 用 `ctx.sessionPersistence.locate(header).path` 拿精确路径，
   并在 `<sessionsRoot>\*\ <sessionId>` 扫一遍兜底。
7. **不要用 `window.confirm`。** 插件 UI 属于宿主 UI，能用主题令牌就别用浏览器原生弹窗。
8. **令牌不进库。** PAT 只在当次请求头里用，任何文件、任何提交里都没有它。

---

## 开发

```powershell
# 语法自检（Host 半是 ESM，浏览器半是懒 CJS，都能被 node --check 解析）
node --check index.js
node --check client.js

# 自测：清单字段 / 语法 / 会话 id 守卫 / 路径守卫 / 主题令牌白名单
node tools-selftest.cjs
```

改动生效范围：

| 改了 | 生效方式 |
| --- | --- |
| `index.js`（Host 半） | **重启 DSH**（Node ESM 模块按 URL 缓存，热重载不会重新导入） |
| `client.js`（浏览器半） | 浏览器 bundle 在启动时组装，需**重启 DSH** 后再刷新页面 |
| `cordis.patch.yml` | profile 配置为 `patchReload: live`，改完即时重挂 |

---

## 许可

MIT，见 [LICENSE](LICENSE)。
