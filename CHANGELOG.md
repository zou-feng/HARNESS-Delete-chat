# 更新日志

本项目的所有重要变更都会记在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

[1.0.0]: https://github.com/zou-feng/HARNESS-Delete-chat/releases/tag/v1.0.0
