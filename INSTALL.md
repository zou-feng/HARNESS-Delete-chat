# 在其他电脑上安装

本插件是 **DSH 的网页端独立插件**：装一次，之后**随 DSH 启动自动加载**，重启不丢。
它**不需要任何凭据**（不读 DeepSeek API Key，不联网），也**不需要编译**。

---

## 0. 目标电脑需要什么

| 需要 | 说明 |
| --- | --- |
| **能正常跑的 DSH** | 一键版或源码版都行。没启动过一次的话 `profiles/web` 还不存在，先启动一次 |
| **Node.js** | DSH 自带的就行，不用另装 |
| **插件文件** | 见第 1 步 |
| **`pnpm`**（仅方式一需要） | 一键版通常自带但没加进 PATH，见 2.1 |

**不需要**：联网装依赖、编译器、任何全局包、任何 API Key。

---

## 1. 把插件文件弄到目标电脑

### A. 拷贝整个文件夹（推荐，方便以后改）

把本仓库整个目录拷过去，例如放到 `D:\plugins\HARNESS-Delete-chat`。

### B. 拷打包好的 tarball

从本仓库的 Release 下载 `dsh-plugin-conversation-delete-1.1.0.tgz`，解包：

```powershell
tar -xzf dsh-plugin-conversation-delete-1.1.0.tgz
# 解出 package\ 目录，里面的内容就是插件本体
```

---

## 2. 安装

### 2.1 先确认 `$DSH_HOME` 在哪

```powershell
# 在 DSH 自己的进程里，这个变量是现成的：
$env:DSH_HOME

# 手动判断：哪个目录下同时有 profiles 和 .credentials.yaml，它就是 DSH_HOME
Get-ChildItem -Path D:\, "$env:USERPROFILE" -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'profiles') } |
  Select-Object -ExpandProperty FullName
```

默认是 `~\.dsh`；本机一键版把它设成了 `<安装目录>\data\dsh`。
下面统一记作 `$DSH_HOME`，profile 目录就是 `$DSH_HOME\profiles\web`。

### 方式一：一条命令（需要 pnpm）

```powershell
# 在 DSH 里让 agent 调用：
#   plugin_manager  action: install_bundle   target: <插件目录绝对路径>
# 或者命令行：
dsh plugin add "<插件目录绝对路径>"
```

装完 `$DSH_HOME\profiles\web\package.json` 的 `dsh.profile.bundles` 里会出现
`dsh-plugin-conversation-delete`，并且 profile 的补丁层会自动带上那一行 loader 行。

#### 如果报 `pnpm failed` / `'pnpm' is not recognized`

说明 DSH 进程的 PATH 里没有 pnpm。两条对策：

```powershell
# 对策 1：装一个全局 pnpm（需要联网），装完 pnpm.cmd 会落在 DSH 的 node 目录里，正好在 PATH 上
npm i -g pnpm

# 对策 2：直接走下面的「方式二：手工接线」，不依赖 pnpm
```

### 方式二：手工接线（没有 pnpm 时 —— **本机就是这种**）

```powershell
$pkg = "D:\plugins\HARNESS-Delete-chat"          # 第 1 步放插件的位置
$profile = "$env:DSH_HOME\profiles\web"
$dst = Join-Path $profile 'node_modules\dsh-plugin-conversation-delete'

New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$pkg\*" -Destination $dst -Recurse -Force

# 看一眼装进去的东西（应含 index.js / client.js / package.json / cordis.patch.yml / icon.svg / locale）
Get-ChildItem $dst -Recurse -File | Select-Object -ExpandProperty Name
```

然后把 **本仓库 `cordis.patch.yml` 里那段 `- insert:`** 追加到 profile 的补丁层
`$profile\cordis.patch.yml` 末尾：

```yaml
# ---------------------------------------------------------------
# dsh-plugin-conversation-delete — 会话行“...”菜单里的“删除对话”
# 卸载：删掉下面这段 insert，并移除 node_modules 里的 dsh-plugin-conversation-delete。
# ---------------------------------------------------------------
- insert:
    - id: conversation-delete
      name: dsh-plugin-conversation-delete
```

> ⚠️ **`cordis.patch.yml` 不能带 UTF-8 BOM**，否则 DSH 启动会报
> `must be a top-level YAML array of loader patch entries`。
> 用 `Set-Content -Encoding utf8NoBOM`（PowerShell 7）或直接手改，别用记事本另存为 UTF-8。

改完这个文件，profile 配置是 `patchReload: live`，**理论上会即时重挂**；
但 `index.js` / `client.js` 这两个 JS 文件是启动时装载的，**首次安装请重启 DSH** 最稳。

---

## 3. 凭据

**不需要。** 本插件不访问网络、不读 API Key、不写任何凭据文件。
（对比：`dsh-plugin-balance-pet` 需要 `DEEPSEEK_API_KEY`，本插件与它无关。）

---

## 4. 重启 DSH

彻底退出再启动（关掉窗口 / 结束 `node` 进程均可）。重启后插件随 profile 自动加载。

---

## 5. 验证安装成功

### 5.1 看启动日志

正常应出现五行（一个操作一条路由）：

```
conversation-delete: route ready (/conversation-delete/delete)
conversation-delete: route ready (/conversation-delete/export)
conversation-delete: route ready (/conversation-delete/import)
conversation-delete: route ready (/conversation-delete/reveal)
conversation-delete: route ready (/conversation-delete/move)
```

### 5.2 直接请求路由

```powershell
foreach ($name in 'delete','export','import','reveal','move') {
  curl.exe -s -o NUL -w "$name -> %{http_code}`n" "http://127.0.0.1:3080/conversation-delete/$name"
}
```

期望五行**全部是 `405`**：

```
delete -> 405
export -> 405
import -> 405
reveal -> 405
move -> 405
```

`405` 就是成功的证据 —— 路由在，只是要求 POST（用 `curl.exe -s -i` 看完整响应体是
`{"ok":false,"error":"POST required"}`）。

### 5.3 界面上看

打开 DSH 网页端 → 左侧会话列表 → 把鼠标移到任一**会话行**上 → 点行尾的 **“…”** →
菜单最下面应出现四行：**导出对话 / 打开文件位置 / 更换工作区… / 删除对话**（最后一行是危险色）。
删除那一行的位置在「归档会话」下面。

再看**侧边栏底部**（Settings 齿轮旁边那一行）：应有一个 **「导入对话」** 按钮
（侧边栏收成 56px 导轨时只剩图标）。导入是全局动作，所以它在底部而不在会话右键菜单里。

> 没有看到？先**刷新页面**；仍没有就确认第 2 步的 `cordis.patch.yml` 有没有带 BOM、
> 以及 `node_modules\dsh-plugin-conversation-delete` 是不是在 **profile 目录**下（不是 DSH 安装目录下）。

---

## 6. 怎么用

四个功能都在同一个菜单里：鼠标移到会话行 → 点 **“…”**。

### 6.1 导出对话

点 **「导出对话」** → 浏览器立刻下载一个会话归档。

- 正常情况下载的是 **DSH 自己那份规范 ZIP**：`dsh-session-<会话id>.zip`，
  里面除了根对话 `session.v4.jsonl`，还带子代理后代（`subagents/…`）、图片（`media/…`）
  与文件（`files/…`）。这和会话标题栏“更多操作 → 下载会话日志”得到的是同一个文件。
- 如果组合里没有自带导出插件，则退回到本插件路由，下载 `dsh-session-<会话id>.jsonl.zstd`
  （磁盘上的原始会话文件）。两种文件都能被下面的「导入对话」吃回去。

### 6.2 打开文件位置

点 **「打开文件位置」** → 系统文件管理器打开并**选中该对话的文件**。
（Windows 上是 `explorer.exe /select,<文件>`。）

失败时（例如这个会话从来没有落过盘、或组合里没有桌面能力）会弹出提示框，
里面显示该对话文件的完整路径，可以点「复制路径」。

### 6.3 导入对话（在侧边栏底部，不在右键菜单里）

点**侧边栏底部**的 **「导入对话」** → 弹窗里点 **「选择文件…」** → 选一个之前导出的文件。

- 接受 `.zip`（DSH 导出的）、`.jsonl`（规范 JSONL）、`.jsonl.zstd`（本插件导出的）。
- 导入后弹窗会报告：新会话 ID、来源格式、导入了多少行事件、写了多少字节、
  还原了多少附件、有多少条目被跳过。
- **不会覆盖已有对话**：如果原 ID 已被占用，会自动分配一个新 ID（弹窗里会注明）。
- 导入的对话会成为一条**独立的顶层对话**（血缘字段会切断），并自动刷新列表。

> 导入是全局动作，所以它不在某条对话的右键菜单里 —— 那是**导出 / 定位 / 换区 / 删除**的位置。

### 6.4 更换工作区

点 **「更换工作区…」** → 弹窗里显示这条对话**当前的目录**，并给两种选法：

1. **直接选一个目录**：点 **「选择目录…」** → 宿主的目录选择器 → 选中后会自动为该目录
   **建立（或复用）一个工作区**，然后把这条对话搬过去。**这是最常用的一种** ——
   因为注册表里往往只有一个工作区（就是当前这个），列表里自然没别的可选。
2. **从已有工作区里挑**：列表里列出所有工作区（标题 + 路径）。当前所在的那个标着「当前所在」且不可点。

搬完之后：会话 ID 不变、聊天记录一字不改；弹窗会显示会话文件的新位置；
原来的工作区里不再有这条对话，新工作区里会出现它（列表自动刷新）。

**为什么这算"搬"而不是"标记"**：工作区归属是由会话的工作目录（cwd）决定的，
所以插件会改写它的 cwd，并把会话文件从旧工作区的目录挪到新工作区的目录下。

要求：目标目录/工作区目录当前必须存在；**这条对话不能正开着**（开着就先关掉再换 ——
不能在 Agent 脚下改它的工作目录）。

- 工作区归属是由会话的工作目录（cwd）决定的，所以这不只是改一个归属标记：
  **会改写这条对话的 cwd，并把它的会话文件搬到新工作区的目录下。**
- 会话 ID 不变、聊天记录一字不改；搬完弹窗会显示会话文件的新位置。
- 原来的工作区里不再有这条对话，新工作区里会出现它（列表会自动刷新）。
- 要求：目标工作区目录当前必须存在；**这条对话不能正开着**（开着就先关掉再换 ——
  不能在 Agent 脚下改它的工作目录）。

### 6.5 删除对话

1. 点 **「删除对话」**；
2. 弹出确认框，显示**该会话的标题**，并说明会删掉聊天记录与该会话自己的磁盘文件；
3. 点 **「删除」**（或按 Esc / 点遮罩取消）；
4. 侧边栏那条会话消失，磁盘上的会话目录同时被删除。

**这个动作不可恢复，没有回收站，没有撤销。**

删除“当前正打开着的那个对话”时：文件会真的删掉、列表里会被归档隐藏；
但它在 Host 内存里的那份要等 DSH 重启才彻底消失（原因见 README「设计要点 1」）。

---

## 7. 卸载

```powershell
# 方式一装的：
dsh plugin remove dsh-plugin-conversation-delete
# 或：删掉 profiles/web/package.json 里 dsh.profile.bundles 的那一项

# 方式二装的（手工）：
#   1) 删掉 profiles/web/cordis.patch.yml 里那段 - insert:（id: conversation-delete）
#   2) 删掉 profiles/web/node_modules/dsh-plugin-conversation-delete 整个目录
Remove-Item "$env:DSH_HOME\profiles\web\node_modules\dsh-plugin-conversation-delete" -Recurse -Force
```

卸载**不会**影响你已经删掉的会话（它们本来就已经没了），也不会动任何会话文件。

---

## 8. 故障排查

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 启动报 `must be a top-level YAML array of loader patch entries` | profile 的 `cordis.patch.yml` 带了 UTF-8 BOM | 去掉 BOM 重存（`utf8NoBOM`） |
| 菜单里没有那四行 | JS 没重启加载 / 包不在 profile 的 `node_modules` / patch 行没加 | 重启 DSH；核对第 2 步的路径与 patch 段 |
| 日志只有 1 行 `route ready`（或没有） | 装的是 1.0.0 的旧文件，或被 ESM 缓存住了 | 重启 DSH；确认 `node_modules` 里的 `index.js`/`format.js` 是 1.1.0 的 |
| `curl` 返回 `404` 而不是 `405` | 路由没挂上 | 重启 DSH，确认日志 |
| 点「导出」没有任何反应 | 浏览器的下载被拦截；或宿主导出控制器与路由都不可用 | 看浏览器下载列表；用 `curl` 打第 5.2 步确认 `export` 是 405 |
| 导出的 ZIP 里没有图片/子代理 | 走的是本插件兜底导出（只有根对话） | 正常，兜底只导出原始 artifact；要完整归档请在会话标题栏用宿主的“下载会话日志” |
| 点「导入」报 `the ZIP has no session.v4.jsonl entry` | 选的不是会话归档（例如是别的 zip） | 选 DSH 导出的 `dsh-session-*.zip`、`.jsonl` 或 `.jsonl.zstd` |
| 点「导入」报 `the header has no working directory (cwd)` | 归档里的头记录没有 cwd，导入了也不会出现在列表里 | 这样的文件无法导入；用 DSH 正常导出的归档 |
| 点「导入」报 `refusing to overwrite it` | 目标路径已有同名日志 | 正常保护；重试会分配新 ID，如仍报错说明目标 id 目录被占用 |
| 点「导入」报 `the session backend cannot read the imported file back` | 写进去了但后端读不出来（后端不是 jsonl 或格式代不同） | 把这条报错原文贴出来；`format.js` 的自测（第 9 组）可先本地验证 |
| 导入完成后列表里没有新对话 | 客户端还没刷新 | 已自动调用 `sessions.refresh()`；不行就刷新页面 |
| 点「打开文件位置」没反应/打开了「文档」 | 该会话没有落盘文件，或路径已不存在（Explorer 对不存在的路径不报错） | 看提示框里的路径；「导出」一次可以确认文件是否存在 |
| 点「打开文件位置」报 `no sessionController` | 组合里没有会话控制器（非 web profile） | 该功能需要桌面能力，在无头组合里不适用 |
| 侧边栏底部看不到「导入对话」 | JS 没重启加载，或侧边栏收成了很窄的导轨 | 重启 DSH；导轨态下它只剩一个上传图标（鼠标悬停有提示） |
| 点「更换工作区」后弹窗里只有一个工作区 | 你确实只添加了一个工作区 | 先在侧边栏添加工作区目录，再回来移动 |
| 点某条对话的「更换工作区」报「这条对话仍开着」 | 删除/移动都要求会话不在 Host 内存里 | 先切到别的对话（或新建对话）再操作 |
| 「更换工作区」报目标工作区目录不存在 | 工作区记录还在，但目录被移走/删掉了 | 恢复该目录，或把对话移到别的工作区 |
| 「更换工作区」成功后列表没变 | 客户端还没刷新 | 已自动 `sessions.refresh()`；不行就刷新页面 |
| 点「删除」后弹红字 `删除失败：invalid session id` | 会话 id 含非法字符（正常会话不会） | 这是路径穿越守卫，属预期行为 |
| 点「删除」后弹红字 `删除失败：...` 且 `failures` 里有 `delete` | 文件被占用（例如该会话正在写入） | 关掉那个对话再删；或重启 DSH 后删 |
| 删完刷新页面，那行又回来了 | 删的是**正开着的**会话，内存那份仍在，列表把它带了回来 | 它已被归档隐藏；重启 DSH 后彻底消失 |
| 想删的会话在“已归档”筛选视图里还看得见 | 同上：内存里那份还在 | 重启 DSH；或点“取消归档”后重新删 |
| `plugin_manager install_bundle` 报 `pnpm-missing` | DSH 进程 PATH 里没有 pnpm | 见 2.1 的对策 1 / 方式二 |

---

## 9. 附录：本机（已完成安装）的实际路径参考

| 项 | 实际值 |
| --- | --- |
| DSH 安装目录 | `D:\deepseek harness\Deepseekharnessoneclickinstall-main` |
| `DSH_HOME` | `D:\deepseek harness\Deepseekharnessoneclickinstall-main\data\dsh` |
| profile | `...\data\dsh\profiles\web` |
| 插件安装位置 | `...\profiles\web\node_modules\dsh-plugin-conversation-delete` |
| 补丁层 | `...\profiles\web\cordis.patch.yml`（末尾那段 `- insert:`） |
| 会话文件根 | `...\data\dsh\sessions` |
| 会话目录形状 | `...\sessions\--C-Users-zoufeng-Desktop-...--\<会话id>\session.v4.jsonl.zstd` |
| 附件对象根 | `...\data\dsh\attachments\v1\objects\<sha256 前两位>\<sha256>` |
| 本仓库（源码） | `C:\Users\zoufeng\Desktop\harness work space\harness chat del\HARNESS-Delete-chat` |
| Web 入口 | `http://127.0.0.1:3080` |
| pnpm | **本机没有**（corepack 垫片需要联网，也失败）→ 走方式二 |
