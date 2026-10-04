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

从本仓库的 Release 下载 `dsh-plugin-conversation-delete-1.0.0.tgz`，解包：

```powershell
tar -xzf dsh-plugin-conversation-delete-1.0.0.tgz
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

正常应出现一行：

```
conversation-delete: route ready (/conversation-delete/delete)
```

### 5.2 直接请求路由

```powershell
curl.exe -s -i http://127.0.0.1:3080/conversation-delete/delete
```

期望：

```
HTTP/1.1 405 Method Not Allowed
content-type: application/json; charset=utf-8

{"ok":false,"error":"POST required"}
```

`405` 就是成功的证据 —— 路由在，只是要求 POST。

### 5.3 界面上看

打开 DSH 网页端 → 左侧会话列表 → 把鼠标移到任一**会话行**上 → 点行尾的 **“…”** →
菜单里应出现**红色的「删除对话」**，位置在「归档会话」下面。

> 没有看到？先**刷新页面**；仍没有就确认第 2 步的 `cordis.patch.yml` 有没有带 BOM、
> 以及 `node_modules\dsh-plugin-conversation-delete` 是不是在 **profile 目录**下（不是 DSH 安装目录下）。

---

## 6. 怎么用

1. 鼠标移到会话行 → 点 **“…”** → 点 **「删除对话」**；
2. 弹出确认框，显示**该会话的标题**，并说明会删掉聊天记录与该会话自己的磁盘文件；
3. 点 **「删除」**（或按 Esc / 点遮罩取消）；
4. 侧边栏那条会话消失，磁盘上的会话目录同时被删除。

**这个动作不可恢复，没有回收站，没有撤销。**

删除“当前正打开着的那个对话”时：文件会真的删掉、列表里会被归档隐藏；
但它在 Host 内存里的那份要等 DSH 重启才彻底消失（原因见 README「设计要点 2」）。

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
| 菜单里没有「删除对话」 | JS 没重启加载 / 包不在 profile 的 `node_modules` / patch 行没加 | 重启 DSH；核对第 2 步的路径与 patch 段 |
| 日志没有 `route ready` | 同上；或 `webServer` 服务缺席（非 web profile） | 确认 profile 是 `web`，且 `cordis.yml` 里有 `webserver` 行 |
| `curl` 返回 `404` 而不是 `405` | 路由没挂上 | 重启 DSH，确认日志 |
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
| 本机插件源码 | `C:\Users\zoufeng\Desktop\harness work space\harness chat del\conversation-delete` |
| Web 入口 | `http://127.0.0.1:3080` |
| pnpm | **本机没有**（corepack 垫片需要联网，也失败）→ 走方式二 |
