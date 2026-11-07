# 更新日志

本项目的所有重要变更都会记在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。




## [1.1.0] - 2026-10-06

菜单从「一行」变成一个**对话工具箱**：导出对话、打开对话文件位置、更换工作区、删除对话，
外加侧边栏底部的全局「导入对话」。

### 新增

- **导出对话**（菜单 order 410）：优先调用 DSH 自带的下载控制器 `sessionLogDownload`，
  产出的就是宿主「下载会话日志」那个 ZIP（`dsh-session-<id>.zip`，含子代理后代与附件 payload）；
  该控制器缺席时退回到本插件的 `POST /conversation-delete/export`，输出磁盘上的原始
  `session.v4.jsonl.zstd` 字节。两条路产出的文件本插件的导入都能吃。
- **更换工作区**（会话行菜单 order 440）：`POST /conversation-delete/move`。
  **工作区归属是由会话头的 `cwd` 决定的**（`Workspace` 的契约：账户里有 id **且** canonical cwd 等于工作区路径；
  `attachSession()` 对 cwd 不匹配的直接拒绝），所以这是一次真正的搬家：
  改写 cwd → 把日志挪到新 cwd 对应的项目目录 → 再把账户从旧工作区挪到新工作区。
  安全顺序做得比较细：先把旧文件改名 aside（避免两份同名日志同时在，那会让后端报 duplicate session id）
  → 写新位置（临时文件 + rename）→ **回读验证** `stat`+`locate` 都指向新路径 →
  通过才删旧目录，不通过就整体回滚（删新文件、把旧文件改回原名）。
  活着的会话要先归档停活、等它离开内存才允许搬（不能在 Agent 脚下改 cwd）。
  **目标有两种选法**：①「选择目录…」走宿主的目录选择器（`uiWorkspace.pickDirectory()`），
  选中后用 `workspaces.create({ path })` 为它建立（或复用）工作区，再搬过去；
  ② 从已有工作区列表里挑。第一条是必需的 —— 实测注册表里往往只有一个工作区（当前那个），
  只列已有工作区的话弹窗里根本没得选。
- **导入对话**（侧边栏底部全局动作，order 100；**不在会话行菜单里**）：
  `POST /conversation-delete/import`。
  DSH 此前**没有任何**把会话导回来的入口，这是新行为。三种输入都能识别：
  DSH 导出的 ZIP（根条目 `session.v4.jsonl`）、规范 JSONL 文本、本插件导出的 artifact。
  写入的是后端自己的格式（多帧、每帧带校验和的 zstd 容器，首帧恰好一行头记录），
  写完立刻用 `sessionPersistence.stat()` 回读验证，确认后端真能读出来。
  - **ID 策略**：原 ID 空闲就沿用；被占用则分配新的 `session-<uuid>`，**绝不覆盖**已有日志。
  - **血缘**：导入时切断 `parentSession` / `origin`，`delegationDepth` 归 0，
    让导入的对话成为一条独立的顶层对话（与「更换工作区」不同，那个只搬家、保留血缘）。
  - **附件**：ZIP 里的 `media/<id>.<ext>` 先按内容哈希校验（sha256 必须等于条目 id）再还原到
    `<attachments>/v1/objects/<xx>/<id>`；`files/...` 按归档布局 1:1 还原。
  - **子代理**：`subagents/...` 不导入，在结果的 `skipped` 里列出。
  - **崩溃尾巴**：末帧损坏时按后端恢复语义丢弃该帧，并在结果里标注 `droppedTornTail`。
- **打开文件位置**（菜单 order 420）：`POST /conversation-delete/reveal`，交给宿主的
  `sessionController.openWorkspacePath({ action: 'reveal' })` —— Windows 上就是
  `explorer.exe /select,<file url>`，先经过宿主的 Host 路径校验。失败时弹出带路径的提示框，可一键复制。
- **格式层 `format.js`（新文件）**：zstd 多帧切分（移植自后端 `scanZstdFrames`）、
  artifact 编解码、最小 ZIP 读取器（EOCD → 中央目录 → 本地头 → stored/deflate + CRC 校验）、
  规范 JSONL 解析、头记录规范化（导入用）与改挂工作目录（换工作区用）。
  零第三方依赖，只用 `node:zlib`，可单独 import 做单测。
- 自测扩到 **132 项**，新增**格式层真测**（编解码往返 / 切帧精确铺满 / ZIP 与 CRC /
  头规范化 / 改挂 cwd）与**危险行为守卫**（不覆盖已有日志、不越界写、不撤销归档、
  换工作区必须先 aside 再写、验证失败必须回滚）。

### 变更

- **「导入对话」从会话行菜单挪到侧边栏底部的全局动作区**（`sidebar.footer.action`）：
  导入是全局动作，挂在某一条对话的右键菜单里不合逻辑。宽栏显示图标 + 文字，收成 56px 导轨时只剩图标。
- 菜单项顺序：`410 导出` / `420 打开文件位置` / `440 更换工作区…` / `500 删除`（危险色，仍在最后）。
- 删除行与其余各行共用同一套行组件；行样式为「中性默认 + 危险变体」（`dshcd-row-danger`）。
- 对话框统一成一个 `shell.overlay` 条目（`conversation-delete.dialog`），按请求类型分派
  （确认删除 / 导入 / 更换工作区 / 提示），替代 1.0.0 里单独的确认条目。
- `package.json`：`version` → `1.1.0`，`files` 增加 `format.js`，新增 `exports["./format"]`；
  标题与描述改为「对话工具箱（导出 / 导入 / 定位 / 换区 / 删除）」。
- 中英文字典相应扩充（新增 `move.*`；导入相关沿用 `import.*`）。

### 修复

- **`delegationDepth` 是必填字段**（本版开发中用运行中的后端实测抓出来的）：
  后端的头校验 `snapshotSessionFormatHeader` 要求 `version` / `id` / `createdAt` / `isSeeded` /
  **`delegationDepth`** 全在，少一个整份日志会被判读不出来、会话永远不出现在列表里。
  导入时「切断血缘」原先把 `delegationDepth` 一起删掉了 —— 改为归 0；换工作区则原样保留。
- **多代际会话搬迁必然失败**（第二个用实测抓出来的真 bug）：一个会话目录里可以**同时**躺着
  `session.v3.jsonl.zstd`（历史代际，v3→v4 迁移的来源）与 `session.v4.jsonl.zstd`（当前代际）。
  最初只把「定位到的那个文件」改名 aside，v3 留在旧目录里 —— 而 **v3 同样是合法代际**，
  于是后端在两个项目目录里各找到这条会话，抛
  `duplicate JSONL session id "…" appears in multiple project directories`，
  回读验证必然失败并整体回滚（用户看到的就是「搬迁未能验证，已回滚」）。
  改为**把旧目录里的每个条目都搬进新目录**（多代际一起走，无损），旧目录空掉后再删。
  注意也不能简单地把整个目录改名 aside：后端的 `listSessionDirs()` 会列**所有**目录且
  不校验目录名，改名后的目录照样被扫、里面的文件照样算一个代际，问题只会换个形式回来。
  已用「同一目录放 v3+v4」的探针做过前后对照：旧算法稳定复现，新算法后端视图干净。
- **失败原因不再被吞掉**：原先弹窗只显示一句概括（「搬迁未能验证，已回滚」），
  完全看不出是哪一步、为什么。现在会把 Host 的 `failures[{step,error}]` 明细逐条附在弹窗里。
- **注册表的内存头缓存没跟着搬**（第三个用实测抓出来的真 bug）：`attachSession()` 通过
  `host.readSessionHeader(id)` 拿 cwd，而那个方法的顺序是「活会话 → **内存缓存** → 扫盘」，
  **只有缓存里没有才会去扫盘**。搬迁只更新了磁盘、没清缓存，于是紧随其后的 `attachSession`
  拿**旧 cwd** 去 `realpath()` 校验，报
  `its cwd '<旧路径>' does not resolve, so it cannot be validated` ——
  文件其实已经搬到位了，却被报成失败。现在搬迁成功后（以及回滚后）都会先让缓存失效；
  失效接口按能力探测（`invalidateSessionHeader` / `forgetSessionHeader` / … / 整表重建），
  一个都没有时由 `stat()` 的重试兜底（重试本身就会重建索引）。
- 导出前先 flush 活会话（`ctx.sessions.flush`），避免刚发生的内容不在导出文件里。
- 1.0.0 开发过程中修掉、并入本版的行为：删除后不再调用 `unarchiveSession`
  （撤销归档会把被打开过的会话重新带回列表）。

### 移除

- 无。`POST /conversation-delete/delete` 的请求体、响应字段与菜单行 id（`conversation-delete.delete`）保持不变。

### 兼容性说明

- **1.0.0 的调用方不受影响**：删除路由、请求/响应契约、菜单行 id 与顺序（500）全部保留。
- **与 DSH 自带导出的关系**：导出复用宿主实现，本插件不再自己造 ZIP；导入同时接受宿主 ZIP 与本插件的
  artifact，两边可互换。
- **新增依赖的宿主 API**（均判空降级，缺了也能装）：
  客户端 `ctx.get('sessionLogDownload').download(id)`、`useWorkspaces` / `useSessions`（槽位标准 hook）；
  Host `ctx.get('sessionController').openWorkspacePath({ path, action: 'reveal' })`、
  `ctx.get('sessionPersistence').stat()/locate()`（后两者是私有方法但运行时可达）、
  `workspaceRegistry.get/list()` 与 `Workspace.attachSession/detachSession`。
- **已知限制**：导入只还原根对话，不导入子代理后代；`files/...` 的落盘路径按归档布局推断
  （本机尚无该目录，属尽力而为）；被 GUI 打开过的会话删除后仍需重启才会从 Host 内存里消失
  （见 1.0.0 的说明与 README「设计要点 1」）；**更换工作区**要求目标工作区目录当前存在，
  且该会话不在 Host 内存里（开着就先关掉再换）。

### 1.1.0 覆盖发布追加的修复

以下三项是 1.1.0 首次发布之后，在**真实的桌面版环境**里踩出来并修掉的，已于同日**覆盖更新到同一个 1.1.0 发布**里（不另开版本、不另开分支）：

- **换区之后新旧两个工作区都列着这条对话（点一个亮两个）**：摘旧账时我用
  workspace.sessionIds.includes(id) 预判「旧工作区账上有没有它」，但桌面版里那个 getter
  会**按 cwd 过滤** —— 搬完之后旧工作区根本看不见这条会话，预判永远 false，整段 detach 被跳过，
  于是旧账上那条 id 一直留着。**同一个缺陷也正是之前 workspace.json 损坏的原因**
  （一条会话挂在两个工作区 → 注册表加载时抛异常 → workspaceController 服务不可用）。
  现在：detach 契约是幂等的（不在账上也不写），所以对**其它每个工作区直接调一次**，
  方法名按能力探测（detachSession / emoveSession / detach / orgetSession），
  并在结束后**回读确认**没有别的账上还留着它（留了就记进 ailures 的 detach-verify）。

- **桌面版报 The "path" argument must be of type string. Received an instance of Object**：
  新版 DSH 里服务暴露的路径**不一定是裸字符串** —— 桌面版实测返回对象，web 版返回字符串，
  所以这个坑只在桌面版暴露。path.resolve() 拿到对象会直接抛。
  现在所有来自服务的路径都先经 pathText() 收敛（兼容字符串、{ path } 包装、
  有意义的 	oString()），覆盖 workspace.path、	arget.path、
  sessionPersistence.locate().path、后端 config.root / oot 字段；
  locate() 的返回值统一走 locateTextOf()。

- **多代际会话搬迁必然失败**（用户实测抓到）：一个会话目录里可以**同时**躺着
  `session.v3.jsonl.zstd`（历史代际）与 `session.v4.jsonl.zstd`（当前代际），v3 同样是合法代际。
  原先只把「定位到的那一个文件」改名 aside，v3 留在旧目录里 → 后端在两个项目目录里各找到这条
  会话 → 抛 `duplicate JSONL session id … appears in multiple project directories` →
  回读验证失败并回滚。
  现在改为**把旧目录里的每个条目都搬进新目录**（多代际一起走，无损），旧目录空掉后再删。
  也不能改成「整个目录改名 aside」：`listSessionDirs()` 会列所有目录且不校验目录名。
- **注册表的内存头缓存没跟着搬**（用户实测抓到）：`attachSession()` 通过
  `host.readSessionHeader(id)` 拿 cwd，顺序是「活会话 → **内存缓存** → 扫盘」，
  **缓存命中就不扫盘**。搬迁只改磁盘、不清缓存，它就会拿**旧 cwd** 去 `realpath()` 并报
  `its cwd '<旧路径>' does not resolve, so it cannot be validated` —— 文件其实已经搬好了。
  现在搬迁成功后（以及回滚后）先让缓存失效，接口按能力探测，并用 `stat()` 重试兜底。
- **搬迁误依赖客户端网关**：原来「为目录建工作区」走浏览器半的 `workspaces.create`
  （typert 网关 → `workspaceController`），在没有挂这个服务的组合里直接报
  `gateway/service-unavailable: … active Service "workspaceController" is unavailable`。
  现在客户端只把**目录路径**交给 `/move`，由 Host 用注册表自己「找/建」工作区。
- **删除的归档步骤也是 strict 查找**：在拿不到注册表的组合里会**静默跳过归档**
  （删掉的对话在重启前可能又回到列表）。现在与换区共用同一个多路兜底。
- **失败明细不再被吞掉**：弹窗会附上 Host 的 `failures[{step,error}]`，
  否则用户只会看到一句「搬迁未能验证，已回滚」，根本看不出是哪一步。
- **服务解析多路兜底**：`ctx` → `ctx.root` × strict / 非 strict × 若干候选名字。
  Cordis 4 的 `ctx.get(name)` 默认 strict（只认「提供者当前 active」的实现），
  且服务可能被隔在别的 `isolate` 作用域里。命中来源会记进报告（`registrySource`）。
- **只读能力探测路由** `POST /conversation-delete/capabilities`：逐个报告服务能否解析、
  解析来源、注册表里的工作区清单、会话根目录。用于回答「这个 DSH 组合里到底哪个功能能用」。
- **手输目标路径**：目录选择器在某些组合里不可用时的退路（`uiWorkspace.pickDirectory`）。
- 弹窗打开时先探测一次能力：拿不到注册表就直接说明，而不是等你选完目录再失败。
- **实测差异（同一份代码、同一个 DSH 版本 `0.2.0-rc.2`）**：
  web profile 里 `sessions` / `sessionPersistence` / `sessionController` / `webServer` /
  `workspaceRegistry` **全部可用**；桌面版的**插件 Host** 里只有
  `sessions` / `sessionPersistence` / `webServer` / `typert` 可用，
  `workspaceRegistry` 与 `sessionController` **都拿不到**（四个候选名字 + 非 strict + `ctx.root`
  全试过）。因此在那套组合里：**删除 / 导出 / 导入可用**，
  **更换工作区与打开文件位置不可用**（插件会明确说明原因，不再抛网关错误）。


## [1.0.0] - 2026-10-04

首个版本。此前仓库为空，没有可比的历史版本。

### 新增

- **会话行“…”菜单里的「删除对话」**：注册到 `sidebar.workspaces.session.menu.item`
  （`id: conversation-delete.delete`，`order: 500`），排在宿主自带的
  置顶(100) / 重命名(200) / 分叉(300) / 归档(400) 之后，样式为宿主一致的**危险色**菜单行。
- **二次确认弹窗**：注册到 `shell.overlay`（`id: conversation-delete.confirm`）。
  显示该会话标题，并明确写出「聊天记录 + 该会话自己的磁盘文件会被删除；工作目录里的文件不受影响」。
  支持 Esc 关闭、点遮罩关闭、关闭按钮自动聚焦。
- **Host 删除路由** `POST /conversation-delete/delete`：一次请求完成
  「停活 → 归档 → 清工作区归属 → 删会话目录 → 广播移除」，并返回**分步骤**的执行报告
  （`wasLive` / `archived` / `stillLive` / `removedDirs` / `failures`）。
- **会话文件删除**：删掉 `<sessionsRoot>\<项目目录>\<会话id>\` 整个目录
  （内含 `session.v4.jsonl.zstd`）。路径有两个来源：后端精确位置
  `ctx.sessionPersistence.locate(header).path`，以及 `<sessionsRoot>\*\ <会话id>` 扫描兜底。
- **路径穿越守卫**：`sessionId` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`；
  删除目标还必须是 `<root>\<项目>\<会话id>` 的三段形状，否则拒绝并计入 `failures`。
- **客户端目录同步**：删完调 `sessions.refresh()`，并广播宿主允许转发的
  `api-session/removed`，让侧边栏立刻少一行。
- **自带中英文字典**（命名空间 `conversation-delete`），随宿主语言切换。
- **`tools-selftest.cjs`**：零依赖自测，10 组检查（清单 / 语法 / Host 导出 / 会话 id 正则 /
  路径守卫 / 危险行为 / 浏览器槽位 / 主题令牌白名单 / 版本一致性 / **令牌不入库**）。
- 文档：`README.md`（含版本与下载表）、`INSTALL.md`（换机安装 / 卸载 / 故障排查）、
  `TUNING.md`（按行号的调参手册）、本文件。

### 变更

- 无（首个版本）。

### 修复

- 无（首个版本）。开发过程中修掉的自身缺陷已并入本版：
  - 归档后原本会撤销归档 → 被 GUI 打开过的会话会重新出现在侧边栏；
    现改为**保留归档记录**（原因见 README「设计要点 2」）。
  - 广播移除事件原本发生在删文件**之前** → 期间若有一次列表拉取会把行带回来；
    现改为**删完文件最后广播**。

### 移除

- 无。

### 兼容性说明

- 面向 **DSH 网页端（`dsh.client.platform: web`）**，Host 半 + 浏览器半双面插件，随 profile 启动自动加载。
- **不注入任何服务**给别的包：只用宿主已有的 `slots` / `locale` / `webServer` /
  `sessions` / `workspaceRegistry` / `sessionPersistence`；读服务一律走 `ctx.get()` 并判空。
- 宿主 API 依赖（均在 DSH `0.2.0-rc.2` 上实测通过）：
  `ctx.webServer.register({kind:'exact'})`、`ctx.workspaceRegistry.archiveSession/unpinSession/list`、
  `Workspace.detachSession`、`ctx.sessionPersistence.stat/locate`、`ctx.emit('api-session/removed')`、
  客户端 `ctx.slots.inject/register`、`ctx.locale.register`、`uiWorkspace.archiveSession`、`sessions.refresh`。
- **已知限制**：被 GUI 打开过的会话，其 Agent 句柄由 Harness 持有并已丢弃，
  **没有任何公开 API 能按 id 释放它** —— 因此这类会话删除后，磁盘文件确实没了、
  侧边栏也被归档隐藏，但它要等 DSH 重启才从 Host 内存里彻底消失。
  这是 Harness 的现状，不是本插件可以绕过的（要支持“删除任意活着的会话”必须改 Harness 本体，
  例如让 `ApiSessionAgentController` 保留 `AgentHandle` 并暴露一个 remote 删除方法）。
- **不会动的数据**：工作目录里的任何文件、`$DSH_HOME\attachments`、其他会话目录。
- **残留（无害）**：`$DSH_HOME\storages\workspace.json` 的归档集合会留下该会话 id（惰性、永不复现）；
  `$DSH_HOME\storages\session_projcache\sessions\<id>.json` 是该会话的**可再生标题缓存**，
  未做清理（它属于另一个插件的存储格式，不去伸手）。

[1.1.0]: https://github.com/zou-feng/HARNESS-Delete-chat/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/zou-feng/HARNESS-Delete-chat/releases/tag/v1.0.0
