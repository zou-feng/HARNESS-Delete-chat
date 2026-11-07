#!/usr/bin/env node
/**
 * dsh-plugin-conversation-delete 自测 / 上传前静态自查。
 *
 * 零依赖，只用 Node 内置模块。做的事：
 *   1  清单（package.json）字段齐全、指向的文件真的存在
 *   2  index.js / client.js / format.js 语法检查（node --check）
 *   3  Host 半：四个路由、导出/导入/定位/删除的关键行为
 *   4  会话 id 守卫：直接取源码里的真正则来测，拒绝一切跨目录写法
 *   5  路径守卫的形状判定确实按 <root>/<项目>/<会话id> 三段比较
 *   6  危险行为守卫：不撤销归档、不覆盖已存在的日志、拒绝写到会话根之外
 *   7  浏览器半：四行菜单项 + 对话框宿主 + 导出优先用宿主控制器
 *   8  主题令牌白名单（写死颜色会破坏明暗主题）
 *   9  **格式层真测**（动态 import format.js）：artifact 编解码往返、多帧切分铺满、
 *      ZIP 读取（含 deflate 与 CRC）、头记录规范化
 *  10  版本一致性：package.json == CHANGELOG 顶部 == README 版本表
 *  11  仓库里没有令牌（PAT 绝不入库）
 *
 * 用法：node tools-selftest.cjs     —— 全部通过退出码 0，否则 1
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')
const { deflateRawSync } = require('node:zlib')

const ROOT = __dirname
let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + name)
  } else {
    failures.push(name + (detail === undefined ? '' : '  [' + detail + ']'))
    console.log('  FAIL ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function section(title) {
  console.log('\n' + title)
}

/* --------------------------------------------------- 手工 ZIP（用于格式层测试） */

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index]
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 造一个最小的 deflate ZIP（本地头 + 中央目录 + EOCD），用来喂 readZip。 */
function makeZip(files) {
  const parts = []
  const centrals = []
  let offset = 0
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const deflated = deflateRawSync(content)
    const crc = crc32(content)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    parts.push(local, deflated)
    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)
    offset += local.length + deflated.length
  }
  const centralDirectory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, centralDirectory, eocd])
}

/* ------------------------------------------------------------------------ main */

async function main() {
  /* ---------------------------------------------------------------- 1 清单 */
  section('1. 清单 package.json')
  const pkg = JSON.parse(read('package.json'))
  check('name', pkg.name === 'dsh-plugin-conversation-delete', pkg.name)
  check('version 是语义化版本', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version)
  check('type = module', pkg.type === 'module', pkg.type)
  check('license 已声明', typeof pkg.license === 'string' && pkg.license.length > 0)
  check('files 白名单存在', Array.isArray(pkg.files) && pkg.files.length > 0)
  const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  check('dsh.bundle.patch 已声明', typeof patchRel === 'string')
  check('dsh.bundle.patch 指向真实文件', typeof patchRel === 'string' && fs.existsSync(path.join(ROOT, patchRel)), String(patchRel))
  check('dsh.client.platform = web', !!(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web'))

  function firstPath(entry) {
    if (typeof entry === 'string') return entry
    if (entry && typeof entry === 'object') return entry.default || entry.types
    return undefined
  }
  const clientRel = pkg.exports && firstPath(pkg.exports['./client'])
  check('exports["./client"] 指向真实文件', typeof clientRel === 'string' && fs.existsSync(path.join(ROOT, clientRel)), String(clientRel))
  const formatRel = pkg.exports && firstPath(pkg.exports['./format'])
  check('exports["./format"] 指向真实文件', typeof formatRel === 'string' && fs.existsSync(path.join(ROOT, formatRel)), String(formatRel))
  check('files 列了 format.js', Array.isArray(pkg.files) && pkg.files.includes('format.js'))
  const mainRel = typeof pkg.main === 'string' ? pkg.main : pkg.exports && firstPath(pkg.exports['.'])
  check('main 指向真实文件', typeof mainRel === 'string' && fs.existsSync(path.join(ROOT, mainRel)), String(mainRel))
  check('icon 指向真实文件', typeof pkg.icon === 'string' && fs.existsSync(path.join(ROOT, pkg.icon)), String(pkg.icon))
  check('meta.title / meta.description 已填写', !!(pkg.meta && pkg.meta.title && pkg.meta.description))

  /* ---------------------------------------------------------------- 2 语法 */
  section('2. 语法检查 (node --check)')
  for (const file of ['index.js', 'client.js', 'format.js']) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' })
      check('node --check ' + file, true)
    } catch (error) {
      const out = (error && (error.stderr || error.stdout)) ? String(error.stderr || error.stdout) : String(error && error.message)
      check('node --check ' + file, false, out.split('\n').slice(0, 3).join(' | '))
    }
  }

  /* ------------------------------------------------------------- 3 Host 半 */
  section('3. Host 半 index.js')
  const host = read('index.js')
  check("导出 name = 'conversation-delete'", /export const name = 'conversation-delete'/.test(host))
  check("inject 包含 'webServer'", /export const inject = \['webServer'\]/.test(host))
  check('导出 apply(ctx, config)', /export function apply\(ctx, config\)/.test(host))
  check('从 ./format.js 引入格式层', /from '\.\/format\.js'/.test(host))
  for (const routePath of ['/conversation-delete/delete', '/conversation-delete/export', '/conversation-delete/import', '/conversation-delete/reveal', '/conversation-delete/move', '/conversation-delete/capabilities']) {
    check('注册路由 ' + routePath, host.includes(`path: '${routePath}'`))
  }
  // 六条路由共用三个处理器（delete/reveal/move/capabilities 走同一张 jsonRoutes 表），每个处理器各有一道 POST 闸门。
  check('每条路由都拒绝非 POST', (host.match(/POST required/g) || []).length >= 3)
  /*
   * Cordis 4 的 `ctx.get(name)` 默认 strict（只认提供者当前 active 的实现），而且服务可能被隔在别的
   * isolate 作用域里、或新版改了名字 —— 桌面版就是这样，同一个插件在 web 上拿得到 registry、
   * 在桌面版拿到 undefined。所以查找必须多路兜底，并且要有能力探测路由把真相吐出来。
   */
  check('registry 查找多路兜底（ctx / ctx.root × strict / 非 strict × 候选名字）', /function resolveWorkspaceRegistry\(ctx\)/.test(host) && host.includes("'workspaceRegistry', 'workspaceController'") && /ctx\.root/.test(host) && /scope\.get\(name, strict\)/.test(host))
  check('registry 命中来源会记进报告', host.includes('report.registrySource = found.source'))
  check('Host 侧自己找/建工作区（不再依赖客户端网关）', /async function ensureWorkspaceForPath\(registry, targetPath\)/.test(host) && host.includes('registry.create({ path: canonical })'))
  check('/move 支持只给 path', host.includes('moveConversation(ctx, config, body.sessionId, body.workspaceId, body.path)'))
  check('能力探测路由报告服务解析结果', /async function capabilitiesReport\(ctx, config\)/.test(host) && host.includes('workspaceCreate:') && host.includes('workspaceRegistry: { available:'))
  check('归档时带 stopActivity: true', /archiveSession\(sessionId, \{ stopActivity: true \}\)/.test(host))
  check('广播 api-session/removed', host.includes("ctx.emit('api-session/removed', sessionId)"))
  check('删目录用递归 force', /await rm\(dir, \{ recursive: true, force: true \}\)/.test(host))
  check('导出前先 flush 活会话', /async function flushLiveSession/.test(host) && /await flushLiveSession\(ctx, sessionId\)/.test(host))
  check('导入时把事件与头一起编码', /buildArtifact\(header, parsed\.eventsText\)/.test(host))
  check('导入后回读验证', /the session backend cannot read the imported file back/.test(host))
  check('导入用临时文件 + rename 原子落盘', /await rename\(temporary, targetPath\)/.test(host))
  check('图片附件按内容哈希校验后再写', /createHash\('sha256'\)\.update\(content\)\.digest\('hex'\)/.test(host))
  check('定位走宿主的 sessionController', /controller\.openWorkspacePath\(\{ path: target, action: 'reveal' \}/.test(host))
  check('定位前自己确认路径存在', /if \(target === undefined \|\| !existsSync\(target\)\)/.test(host))

  /* --------------------------------------------- 3b 更换工作区的安全顺序 */
  check('更换工作区会改写 cwd（retargetHeader）', /retargetHeader\(parsed\.header, targetPath\)/.test(host))
  /*
   * 这一段是踩出来的：只把「定位到的那个文件」改名 aside 是不够的 ——
   * 一个会话目录里可以同时有 session.v3 与 session.v4 两个代际，v3 同样是合法代际，
   * 留在旧目录里就会让后端在两个项目目录里各找到这条会话（duplicate）→ 验证必失败。
   * 所以必须把旧目录的每个条目都搬走。
   */
  check('整目录内容一起搬走（多代际一起走）', /await readdir\(oldDir, \{ withFileTypes: true \}\)/.test(host) && /moves\.push\(\{ from, to \}\)/.test(host))
  check('新位置用临时文件 + rename 覆盖权威代际', /await rename\(temporary, authoritativeInNew\)/.test(host))
  check('拒绝并入已存在的目标会话目录', host.includes('refusing to merge into it'))
  check('回读验证必须指向新路径', /resolve\(afterPath\) === newPath/.test(host))
  check('验证失败整体回滚（含按原字节写回权威代际）', host.includes('the move could not be verified and was rolled back') && host.includes('restoreAuthoritative') && /await writeFile\(authoritativeInOld, originalBytes\)/.test(host))
  check('台账：搬走的条目数会回报', host.includes('report.movedEntries = moves.length'))
  /*
   * 「移动后新旧两个工作区都列出这条对话、点一个亮两个」的根：摘旧账时用 sessionIds 预判，
   * 桌面版那个 getter 按 cwd 过滤 —— 搬完旧工作区根本看不见它，预判 false，detach 被整段跳过。
   * detach 契约是幂等的，所以对每个其它工作区直接调一次，并回读确认。
   */
  check('摘除不再用 sessionIds 预判（幂等直调 + 候选方法名）', host.includes("['detachSession', 'removeSession', 'detach', 'forgetSession']") && /function pickWorkspaceMethod\(workspace, names\)/.test(host))
  check('摘除后有回读确认（别的账上不该再留着它）', host.includes("step: 'detach-verify'") && host.includes('still accounted by workspace(s)'))
  check('摘除结果会回报（detachedFrom）', host.includes('report.detachedFrom = detachedFrom'))
  /*
   * 桌面版踩出来的：新版 DSH 里服务暴露的路径**不一定是字符串**（web 版是字符串，
   * 所以只在桌面版暴露）。`path.resolve(那个对象)` 会直接抛
   * `The "path" argument must be of type string. Received an instance of Object`。
   */
  check('服务返回的路径统一收敛成字符串（pathText / locateTextOf）', /function pathText\(value\)/.test(host) && /function locateTextOf\(located\)/.test(host))
  check('不再裸用服务给的 paths（workspace.path / target.path / located.path）', /resolve\(workspace\.path\)/.test(host) === false && /resolve\(target\.path\)/.test(host) === false && /resolve\(located\.path\)/.test(host) === false)
  check('locate() 的结果一律走 locateTextOf', (host.match(/locateTextOf\(/g) || []).length >= 4)
  check('pathText 兼容 { path } 包装与 toString', host.includes("if (typeof value.path === 'string' && value.path !== '') return value.path") && host.includes("if (text !== '' && text !== '[object Object]') return text"))
  check('成功才清理旧目录', /await rm\(oldDir, \{ recursive: true, force: true \}\)/.test(host))
  check('原地改 cwd（两个 cwd 映射到同一项目目录）不当成搬家', /const sameDirectory = resolve\(oldDir\) === resolve\(newDir\)/.test(host))
  check('账户归属走 attachSession/detachSession', /await target\.attachSession\(sessionId\)/.test(host) && /workspace\.detachSession\(sessionId\)/.test(host))
  check('活着的会话要先停活才允许搬家', host.includes('this conversation is still open on the Host; close it and try again'))
  check('拒绝覆盖新位置的已有日志', host.includes('a stored log already exists at the target path; refusing to overwrite it'))
  /*
   * 这一条也是踩出来的：工作区注册表把会话头缓存在内存里，`attachSession()` 读的就是那个缓存
   * （只有缓存里没有才会去扫盘）。磁盘搬完却不清缓存，它就会拿**旧 cwd** 去做 realpath 校验，
   * 报「its cwd '<旧路径>' does not resolve, so it cannot be validated」——
   * 明明已经搬成功了，却被报成失败。
   */
  check('搬完必须让注册表的头缓存失效（否则 attachSession 读到旧 cwd）', /await refreshWorkspaceHeaderCache\(ctx, sessionId\)/.test(host))
  check('缓存失效是按能力探测的（不假设某个私有方法一定在）', host.includes('invalidateSessionHeader') && host.includes('listStoredHeaders'))
  check('stat 撞到失效缓存会清缓存后重试一次', /snapshot = await backend\.stat\(sessionId\)[\s\S]{0,500}await refreshWorkspaceHeaderCache\(ctx, sessionId\)[\s\S]{0,500}snapshot = await backend\.stat\(sessionId\)/.test(host))

  /* ------------------------------------------------------- 4 会话 id 守卫 */
  section('4. 会话 id 守卫（取源码里的真正则）')
  const guardMatch = host.match(/const SESSION_ID = (\/[^\n]*\/);?/)
  if (guardMatch === null) {
    check('能从源码里取到 SESSION_ID 正则', false, '正则字面量没找到')
  } else {
    const literal = guardMatch[1]
    const lastSlash = literal.lastIndexOf('/')
    const re = new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1))
    check('正则已取到', true, literal)
    for (const sample of ['', '../../evil', '..', 'a/b', 'a\\b', 'C:\\x', 'a b', 'a\u0000b', '.hidden'.repeat(30)]) {
      check('拒绝 ' + JSON.stringify(sample), re.test(sample) === false)
    }
    for (const sample of ['session-b30ed786-5c4f-4e8b-b9ef-2b2bdf72eb1c', '3581c7eb-9a65-4a10-8d89-cdc6236f5588', 'session-1', 'A_1.2-3']) {
      check('接受 ' + JSON.stringify(sample), re.test(sample) === true)
    }
  }

  /* --------------------------------------------------------- 5 路径守卫 */
  section('5. 路径守卫形状判定')
  check('isInsideSessionDir 存在', /function isInsideSessionDir\(root, dir, sessionId\)/.test(host))
  check('要求 basename === sessionId', host.includes('basename(normalizedDir) !== sessionId'))
  check('要求祖父目录 === sessionsRoot', host.includes('dirname(dirname(normalizedDir)) === normalizedRoot'))
  check('要求位于 root 之下', host.includes('normalizedDir.startsWith(normalizedRoot + sep)'))

  /* ----------------------------------------------------- 6 危险行为守卫 */
  section('6. 危险行为守卫')
  check('绝不调用 unarchiveSession（撤销归档会让旧会话回到列表）', /unarchiveSession/.test(host) === false)
  check('导入拒绝覆盖已存在的日志', host.includes('refusing to overwrite it'))
  check('导入拒绝写到会话根之外', host.includes('refused to write outside the configured session root'))
  check('删除目标只来自会话目录扫描 / locate', host.includes('findSessionDirs(root, sessionId)') && host.includes('backend.locate(header)'))
  check('请求体大小有上限', /DEFAULT_MAX_IMPORT_BYTES = 64 \* 1024 \* 1024/.test(host))

  /* ------------------------------------------------------------ 7 浏览器半 */
  section('7. 浏览器半 client.js')
  const client = read('client.js')
  check("菜单槽位 'sidebar.workspaces.session.menu.item'", client.includes("var MENU_SLOT = 'sidebar.workspaces.session.menu.item'"))
  check("全局动作槽位 'sidebar.footer.action'", client.includes("var FOOTER_SLOT = 'sidebar.footer.action'"))
  check("对话框槽位 'shell.overlay'", client.includes("var OVERLAY_SLOT = 'shell.overlay'"))
  const wanted = [
    ['conversation-delete.export', 410],
    ['conversation-delete.reveal', 420],
    ['conversation-delete.move', 440],
    ['conversation-delete.delete', 500],
  ]
  for (const [id, order] of wanted) {
    check(`注册 ${id} (order ${order})`, client.includes(`id: '${id}', order: ${order}`))
  }
  // 导入是全局动作：不能再出现在某条会话的右键菜单里（用户明确纠正过这一点）
  check('导入不在会话行菜单里（已挪到全局动作区）', client.includes("id: 'conversation-delete.import', order: 430") === false)
  check('导入注册到 sidebar.footer.action', /ctx\.slots\.inject\(FOOTER_SLOT/.test(client) && client.includes("id: 'conversation-delete.import'"))
  check('全局导入入口按 wide 决定是否显示文字', client.includes('props.wide === true'))
  check('更换工作区用标准的 useWorkspaces / useSessions', client.includes('props.useWorkspaces') && client.includes('props.useSessions') && client.includes('useWorkspaces(function'))
  check('槽位 hook 缺失时有兜底（不让弹窗崩掉）', client.includes('typeof props.useWorkspaces === ') && client.includes('function emptyHook('))
  check('更换工作区把当前工作区标为不可选', client.includes("t('move.current')") && /disabled: busy \|\| isCurrent/.test(client))
  // 只列已有工作区是不够的：注册表里常常只有一个（当前那个），必须能直接指定位置。
  check('更换工作区能直接选一个目录（目录选择器 + 把路径交给 Host）', client.includes('uiWorkspace.pickDirectory()') && client.includes('moveByPath(String(path))'))
  /*
   * 这一段是桌面版踩出来的：客户端的 `workspaces.create` 走 typert 网关 → workspaceController，
   * 桌面版组合里那条路直接报 gateway/service-unavailable。所以「找/建工作区」挪到 Host（用注册表），
   * 客户端只把目录路径交给 /move。
   */
  check('换区不再依赖客户端网关的 workspace/create', client.includes('workspaceService.create') === false && client.includes('postJson(MOVE_URL, { sessionId: request.sessionId, path: path })'))
  check('目录选择器缺失时也能手输路径', client.includes("t('move.noPicker')") && client.includes("t('move.pathPlaceholder')") && client.includes('submitTypedPath'))
  check('弹窗打开时先问一次能力，并显示 registry 不可用', client.includes('CAPABILITIES_URL') && client.includes("t('move.noRegistry')"))
  check('hook 选择器自身也防 undefined（避免条目崩掉）', client.includes('snapshot === null || snapshot === undefined ? undefined : snapshot.items'))
  check('失败时把 Host 的失败明细一起显示给用户', client.includes("message += '\\n· ' + String(failure.step)"))
  check('删除行仍是危险色', /danger: true/.test(client))
  check('菜单行是 role=menuitem 按钮', client.includes("role: 'menuitem'"))
  check('对话框是 role=dialog + aria-modal', client.includes("role: 'dialog'") && client.includes("'aria-modal': true"))
  check('支持 Esc 关闭', client.includes("event.key !== 'Escape'"))
  check('浮层入口自己声明 pointer-events:auto', client.includes('pointer-events:auto'))
  check('导出优先用宿主 sessionLogDownload 控制器', client.includes("ctx.get('sessionLogDownload')") && client.includes('controller.download(sessionId)'))
  check('导出有本插件路由兜底', client.includes('EXPORT_URL'))
  check('导入走二进制上传', client.includes("'content-type': 'application/octet-stream'"))
  check('导入接受 zip/jsonl/zstd', client.includes("var IMPORT_ACCEPT = '.zip,.jsonl,.zstd'"))
  check('删除前先调用宿主的归档动作', client.includes('uiWorkspace.archiveSession(sessionId, { stopActivity: true })'))
  check('操作后刷新会话目录', client.includes('sessions.refresh()'))
  check('定位失败时给出可复制路径', client.includes('navigator.clipboard') && client.includes("'dshcd-path'"))
  /*
   * 桌面版的插件 Host 没有 sessionController（实测），「打开文件位置」因此用不了。
   * 兜底是自己叫系统文件管理器：必须走参数数组（不经过 shell）、必须挂 'error' 处理
   * （ChildProcess 的 'error' 事件没有监听者会直接抛出来把宿主带崩）、必须 unref 不占住宿主。
   */
  check('没有 sessionController 时自己叫文件管理器', /function spawnReveal\(target\)/.test(host) && host.includes("spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })"))
  check('spawn 兜底挂了 error 处理并 unref', host.includes("child.on('error', () => {})") && host.includes('child.unref()'))
  check('spawn 兜底是跨平台的（explorer / open -R / xdg-open）', host.includes('/select,') && host.includes("args = ['-R', target]") && host.includes('args = [dirname(target)]'))
  check('不 require 宿主 primitives', client.includes("require('@deepseek-ai/dsh-client-ui-primitives')") === false)

  /* --------------------------------------------------------- 8 主题令牌 */
  section('8. 主题令牌白名单')
  // 白名单 = Theme inspect 列出的令牌 ∪ 宿主已发布 CSS 里真实使用的令牌。
  const ALLOWED_TOKENS = new Set([
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3',
    '--dsw-alias-brand-primary', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary', '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary', '--dsw-specific-sidebar-fill',
    '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-hover-danger',
    '--dsw-alias-bg-mask-1', '--dsw-mask-blur', '--dsw-elevation-prominent', '--dsw-radius-md',
    '--dsw-radius-sm', '--dsw-radius-panel', '--dsw-alias-menu-icon',
    '--dsh-frame-overlay-top', '--dsh-frame-chrome-top',
  ])
  const used = [...client.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map((m) => m[1])
  const unknown = [...new Set(used)].filter((token) => ALLOWED_TOKENS.has(token) === false)
  check('CSS 变量全部在白名单内', unknown.length === 0, unknown.join(', '))
  check('至少用到若干令牌（正则没写错）', used.length >= 10, 'used=' + String(used.length))

  /* --------------------------------------------------------- 9 格式层真测 */
  section('9. 格式层真测（format.js）')
  let fmt = null
  try {
    fmt = await import(pathToFileURL(path.join(ROOT, 'format.js')).href)
  } catch (error) {
    check('动态 import format.js', false, String(error && error.message))
  }
  if (fmt !== null) {
    check('动态 import format.js', true)
    const header = {
      type: 'session', version: 4, id: 'session-11111111-2222-3333-4444-555555555555',
      createdAt: 1791105000000, cwd: 'C:\\Users\\zoufeng\\Desktop\\harness work space\\harness chat del', isSeeded: false,
    }
    const events = [
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'user/message', seq: 1, time: 2, data: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] } }),
    ].join('\n') + '\n'
    const artifact = fmt.buildArtifact(header, events)
    check('artifact 以 zstd 魔数开头', artifact.readUInt32LE(0) === fmt.ZSTD_MAGIC)
    const back = fmt.parseArtifact(artifact)
    check('头记录往返一致', JSON.stringify(back.header) === JSON.stringify(header))
    check('事件文本往返一致', back.eventsText === events)
    const scanned = fmt.scanZstdFrames(artifact)
    check('切帧精确铺满（无空隙/无剩余）', scanned.frames.length === 2 && scanned.frames[0].start === 0 && scanned.frames[scanned.frames.length - 1].end === artifact.length)
    check('空事件也能编码成单帧', (() => { const p = fmt.parseArtifact(fmt.buildArtifact(header, '')); return p.eventsText === '' && p.frameCount === 1 })())
    check('拒绝不以换行结尾的事件', (() => { try { fmt.buildArtifact(header, 'no-newline'); return false } catch { return true } })())

    const canonical = `${JSON.stringify(header)}\n${events}`
    const mediaId = 'a'.repeat(64)
    const zip = makeZip([
      [fmt.SESSION_LOG_ENTRY, Buffer.from(canonical, 'utf8')],
      ['media/' + mediaId + '.png', Buffer.from([1, 2, 3, 4, 5])],
      ['files/ab/ab' + 'c'.repeat(62) + '/note.txt', Buffer.from('hello file', 'utf8')],
    ])
    const fromZip = fmt.readConversationFile(zip)
    check('识别 ZIP 并取出根日志', fromZip.kind === 'zip' && fromZip.eventsText === events)
    check('ZIP 列出附件条目', fromZip.extras.length === 2, JSON.stringify(fromZip.extras))
    check('ZIP 附带 entries（供附件还原）', fromZip.entries instanceof Map && fromZip.entries.size === 3)
    check('media 条目解析出附件 id', fmt.mediaEntryId('media/' + mediaId + '.png') === mediaId)
    check('files 条目解析出 digest 与叶子名', (() => { const r = fmt.fileEntryId('files/ab/ab' + 'c'.repeat(62) + '/note.txt'); return r !== undefined && r.digest === 'ab' + 'c'.repeat(62) && r.leaf === 'note.txt' })())
    check('ZIP CRC 校验能抓出损坏', (() => { const broken = Buffer.from(zip); broken[60] = broken[60] ^ 0xff; try { fmt.readConversationFile(broken); return false } catch { return true } })())
    check('规范 JSONL 可直接识别', fmt.readConversationFile(Buffer.from(canonical, 'utf8')).kind === 'jsonl')
    check('原始 artifact 可直接识别', fmt.readConversationFile(artifact).kind === 'artifact')

    const normalized = fmt.normalizeHeader({ ...header, parentSession: 'p', origin: 'subagent', delegationDepth: 1 })
    check('规范化切断血缘（去掉 parentSession/origin）', normalized.parentSession === undefined && normalized.origin === undefined)
    // 后端的头校验要求 delegationDepth 存在且是一个计数 —— 缺了整份日志会被判读不出来
    check('规范化把 delegationDepth 归 0（必填，不能删）', normalized.delegationDepth === 0)
    check('规范化补齐后端要求的全部必填字段', ['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'].every((key) => normalized[key] !== undefined))
    check('规范化保留 cwd', normalized.cwd === header.cwd)
    check('规范化保留 agentPreset', fmt.normalizeHeader({ ...header, agentPreset: 'cordis' }).agentPreset === 'cordis')

    // 更换工作区：改挂 cwd，但**保留**血缘（它只是搬家，不是变成一条新对话）
    const moved = fmt.retargetHeader({ ...header, parentSession: 'p', origin: 'subagent', delegationDepth: 2 }, 'D:\\other\\project')
    check('retargetHeader 改写 cwd', moved.cwd === 'D:\\other\\project')
    check('retargetHeader 保留 id', moved.id === header.id)
    check('retargetHeader 保留血缘', moved.parentSession === 'p' && moved.origin === 'subagent' && moved.delegationDepth === 2)
    check('retargetHeader 补齐必填字段', ['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'].every((key) => moved[key] !== undefined))
    check('retargetHeader 改挂后仍能编码往返', (() => {
      const a = fmt.buildArtifact(moved, events)
      const p = fmt.parseArtifact(a)
      return p.header.cwd === 'D:\\other\\project' && p.eventsText === events
    })())
    check('retargetHeader 拒绝空 cwd', (() => { try { fmt.retargetHeader(header, ''); return false } catch { return true } })())
    check('retargetHeader 拒绝 type 不对的头', (() => { try { fmt.retargetHeader({ type: 'x', id: 'a' }, 'D:\\x'); return false } catch { return true } })())
    check('规范化拒绝没有 cwd 的头', (() => { try { fmt.normalizeHeader({ type: 'session', id: 'a', createdAt: 1, isSeeded: false }); return false } catch { return true } })())
    check('规范化拒绝 type 不对的头', (() => { try { fmt.normalizeHeader({ type: 'other', id: 'a', cwd: 'C:\\x' }); return false } catch { return true } })())
  }

  /* ------------------------------------------------------- 10 版本一致性 */
  section('10. 版本一致性')
  const changelog = read('CHANGELOG.md')
  const clVersions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])
  check('CHANGELOG 有版本小节', clVersions.length > 0, clVersions.join(','))
  check('CHANGELOG 顶部版本 == package.json version', clVersions[0] === pkg.version, String(clVersions[0]) + ' vs ' + pkg.version)
  const assetName = pkg.name + '-' + pkg.version + '.tgz'
  const readme = read('README.md')
  check('README 版本表含当前版本行', readme.includes('| ' + pkg.version + ' |'), '未找到 | ' + pkg.version + ' |')
  check('README 提到产物名 ' + assetName, readme.includes(assetName))
  const install = read('INSTALL.md')
  check('INSTALL.md 提到产物名 ' + assetName, install.includes(assetName))
  check('TUNING.md 存在且非空', read('TUNING.md').length > 500)

  /* ---------------------------------------------------- 11 令牌不入库 */
  section('11. 令牌 / 密钥不入库')
  const SECRET_PATTERNS = [
    /ghp_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /gho_[A-Za-z0-9]{20,}/,
    /ghs_[A-Za-z0-9]{20,}/,
  ]
  const SKIP_DIRS = new Set(['.git', 'node_modules'])
  const textExtensions = new Set(['.js', '.cjs', '.mjs', '.json', '.md', '.yml', '.yaml', '.txt', '.svg', '.css', '.html'])
  const offenders = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name))
        continue
      }
      const full = path.join(dir, entry.name)
      if (textExtensions.has(path.extname(entry.name)) === false) continue
      const text = fs.readFileSync(full, 'utf8')
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(text)) offenders.push(path.relative(ROOT, full))
      }
    }
  }
  walk(ROOT)
  check('仓库内没有任何 GitHub 令牌', offenders.length === 0, offenders.join(', '))

  /* --------------------------------------------------------------- 汇总 */
  console.log('\n' + '='.repeat(56))
  if (failures.length === 0) {
    console.log('全部通过：' + String(passed) + ' 项')
    process.exit(0)
  }
  console.log('通过 ' + String(passed) + ' 项，失败 ' + String(failures.length) + ' 项：')
  for (const failure of failures) console.log('  - ' + failure)
  process.exit(1)
}

main().catch((error) => {
  console.error('自测脚本自身出错：' + String(error && error.stack ? error.stack : error))
  process.exit(2)
})
