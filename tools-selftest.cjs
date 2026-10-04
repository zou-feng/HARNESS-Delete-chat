#!/usr/bin/env node
/**
 * dsh-plugin-conversation-delete 自测 / 上传前静态自查。
 *
 * 零依赖，只用 Node 内置模块。做的事：
 *   1  清单（package.json）字段齐全、指向的文件真的存在
 *   2  index.js / client.js 语法检查（node --check）
 *   3  Host 半的导出形态与路由路径
 *   4  会话 id 守卫：直接取源码里的真正则来测，拒绝一切跨目录写法
 *   5  路径守卫的形状判定确实按 <root>/<项目>/<会话id> 三段比较
 *   6  危险行为守卫：绝不撤销归档（撤销 = 被打开过的会话会回到列表）
 *   7  浏览器半的两个槽位注册
 *   8  CSS 只引用白名单里的主题令牌（写死颜色会破坏明暗主题）
 *   9  版本一致性：package.json == CHANGELOG 顶部 == README 版本表
 *  10  仓库里没有令牌（PAT 绝不入库）
 *
 * 用法：node tools-selftest.cjs     —— 全部通过退出码 0，否则 1
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

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

/* ------------------------------------------------------------------ 1 清单 */
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
check('exports["./client"] 已声明', typeof clientRel === 'string', String(clientRel))
check('exports["./client"] 指向真实文件', typeof clientRel === 'string' && fs.existsSync(path.join(ROOT, clientRel)), String(clientRel))
const mainRel = typeof pkg.main === 'string' ? pkg.main : pkg.exports && firstPath(pkg.exports['.'])
check('main 指向真实文件', typeof mainRel === 'string' && fs.existsSync(path.join(ROOT, mainRel)), String(mainRel))
check('icon 指向真实文件', typeof pkg.icon === 'string' && fs.existsSync(path.join(ROOT, pkg.icon)), String(pkg.icon))
check('meta.title / meta.description 已填写', !!(pkg.meta && pkg.meta.title && pkg.meta.description))

/* ------------------------------------------------------------------ 2 语法 */
section('2. 语法检查 (node --check)')
for (const file of ['index.js', 'client.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' })
    check('node --check ' + file, true)
  } catch (error) {
    const out = (error && (error.stderr || error.stdout)) ? String(error.stderr || error.stdout) : String(error && error.message)
    check('node --check ' + file, false, out.split('\n').slice(0, 3).join(' | '))
  }
}

/* -------------------------------------------------------------- 3 Host 半 */
section('3. Host 半 index.js')
const host = read('index.js')
check("导出 name = 'conversation-delete'", /export const name = 'conversation-delete'/.test(host))
check("inject 包含 'webServer'", /export const inject = \['webServer'\]/.test(host))
check('导出 apply(ctx, config)', /export function apply\(ctx, config\)/.test(host))
check("路由路径为 '/conversation-delete/delete'", host.includes("path: '/conversation-delete/delete'"))
check('只接受 POST', host.includes("req.method !== 'POST'"))
check('归档时带 stopActivity: true', /archiveSession\(sessionId, \{ stopActivity: true \}\)/.test(host))
check('先广播 api-session/removed 再收尾（存在该广播）', host.includes("ctx.emit('api-session/removed', sessionId)"))
check('删目录用递归 force', /await rm\(dir, \{ recursive: true, force: true \}\)/.test(host))
check('失败分步骤记录', /failures\.push\(\{ step:/.test(host))

/* ------------------------------------------------------- 4 会话 id 守卫 */
section('4. 会话 id 守卫（取源码里的真正则）')
// 注意：本仓库的 JS 不带分号，所以结尾的 `;` 必须可选。
const guardMatch = host.match(/const SESSION_ID = (\/[^\n]*\/);?/)
if (guardMatch === null) {
  check('能从源码里取到 SESSION_ID 正则', false, '正则字面量没找到')
} else {
  const literal = guardMatch[1]
  const lastSlash = literal.lastIndexOf('/')
  const re = new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1))
  check('正则已取到', true, literal)
  const reject = ['', '../../evil', '..', 'a/b', 'a\\b', 'C:\\x', 'a b', 'a\u0000b', '.hidden'.repeat(30)]
  const accept = ['session-b30ed786-5c4f-4e8b-b9ef-2b2bdf72eb1c', '3581c7eb-9a65-4a10-8d89-cdc6236f5588', 'session-1', 'A_1.2-3']
  for (const sample of reject) check('拒绝 ' + JSON.stringify(sample), re.test(sample) === false)
  for (const sample of accept) check('接受 ' + JSON.stringify(sample), re.test(sample) === true)
}

/* --------------------------------------------------------- 5 路径守卫 */
section('5. 路径守卫形状判定')
check('isInsideSessionDir 存在', /function isInsideSessionDir\(root, dir, sessionId\)/.test(host))
check('要求 basename === sessionId', host.includes('basename(normalizedDir) !== sessionId'))
check('要求祖父目录 === sessionsRoot', host.includes('dirname(dirname(normalizedDir)) === normalizedRoot'))
check('要求位于 root 之下', host.includes('normalizedDir.startsWith(normalizedRoot + sep)'))
check('拒绝时计入 failures 而不是静默跳过', host.includes("error: 'refused: path is not a session directory below the configured root'"))

/* ----------------------------------------------------- 6 危险行为守卫 */
section('6. 危险行为守卫')
check('绝不调用 unarchiveSession（撤销归档会让旧会话回到列表）', /unarchiveSession/.test(host) === false)
check('删除目标只来自会话目录扫描 / locate，不来自请求体', host.includes('findSessionDirs(root, sessionId)') && host.includes('backend.locate(header)'))
check('请求体大小有上限', /limitBytes = 64 \* 1024/.test(host))

/* ------------------------------------------------------------ 7 浏览器半 */
section('7. 浏览器半 client.js')
const client = read('client.js')
check("注册菜单槽位 'sidebar.workspaces.session.menu.item'", client.includes("var MENU_SLOT = 'sidebar.workspaces.session.menu.item'"))
check("注册浮层槽位 'shell.overlay'", client.includes("var OVERLAY_SLOT = 'shell.overlay'"))
check("菜单 id 'conversation-delete.delete'", client.includes("id: 'conversation-delete.delete'"))
check("弹窗 id 'conversation-delete.confirm'", client.includes("id: 'conversation-delete.confirm'"))
check('声明了自己的 locale 命名空间', client.includes("var NS = 'conversation-delete'"))
check('中英字典都有', /var zh = \{/.test(client) && /var en = \{/.test(client))
const orderMatch = client.match(/order: (\d+)/)
check('菜单项 order 在归档(400)之后', orderMatch !== null && Number(orderMatch[1]) > 400, orderMatch === null ? '没找到' : orderMatch[1])
check('菜单行是 role=menuitem 按钮', client.includes("role: 'menuitem'"))
check('弹窗是 role=dialog + aria-modal', client.includes("role: 'dialog'") && client.includes("'aria-modal': true"))
check('支持 Esc 关闭', client.includes("event.key !== 'Escape'"))
check('浮层入口自己声明 pointer-events:auto', client.includes('pointer-events:auto'))
check('删除前先调用宿主的归档动作', client.includes('uiWorkspace.archiveSession(sessionId, { stopActivity: true })'))
check('删除后刷新会话目录', client.includes('sessions.refresh()'))
check('不 require 宿主 primitives', client.includes("require('@deepseek-ai/dsh-client-ui-primitives')") === false)

/* --------------------------------------------------------- 8 主题令牌 */
section('8. 主题令牌白名单')
// 白名单 = Theme inspect 列出的令牌 ∪ 宿主已发布 CSS 里真实使用的令牌。
// 只允许引用这些，写死颜色会破坏明暗主题。
const ALLOWED_TOKENS = new Set([
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3',
  '--dsw-alias-brand-primary', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary', '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary', '--dsw-specific-sidebar-fill',
  '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-bg-mask-1', '--dsw-mask-blur', '--dsw-elevation-prominent', '--dsw-radius-md',
  '--dsw-radius-sm', '--dsw-radius-panel',
  '--dsh-frame-overlay-top', '--dsh-frame-chrome-top',
])
const used = [...client.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map((m) => m[1])
const unknown = [...new Set(used)].filter((token) => ALLOWED_TOKENS.has(token) === false)
check('CSS 变量全部在白名单内', unknown.length === 0, unknown.join(', '))
check('至少用到若干令牌（正则没写错）', used.length >= 10, 'used=' + String(used.length))

/* ------------------------------------------------------- 9 版本一致性 */
section('9. 版本一致性')
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

/* ---------------------------------------------------- 10 令牌不入库 */
section('10. 令牌 / 密钥不入库')
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
for (const f of failures) console.log('  - ' + f)
process.exit(1)
