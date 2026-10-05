/**
 * dsh-plugin-conversation-delete — Host half.
 *
 * 会话行「...”菜单」背后的四个操作，全部由这里执行：
 *
 *   POST /conversation-delete/delete   删除对话（含磁盘上的会话文件）
 *   POST /conversation-delete/export   导出对话（原始会话 artifact 字节，兜底路径）
 *   POST /conversation-delete/import   导入对话（DSH 导出的 ZIP / 规范 JSONL / 本插件的 artifact）
 *   POST /conversation-delete/reveal   在系统文件管理器里定位该对话的文件
 *
 * 设计要点：
 *
 *  - **导出以 DSH 自带的导出为准**：浏览器半优先调用宿主已提供的 `sessionLogDownload`
 *    客户端服务（它走 `GET /api/session.export`，产出带附件与子代理后代的规范 ZIP）。
 *    这里的 `/export` 是它不可用时的兜底：输出磁盘上的原始 artifact 字节。
 *    两种文件本插件的导入都能吃。
 *  - **导入是新行为**：DSH 目前没有任何「把会话导回来」的入口。写进去的必须是后端自己的格式
 *    （多帧、每帧带校验和的 zstd 容器，首帧恰好一行头记录），所以格式层单独放在 `format.js`。
 *  - **定位文件用宿主自己的实现**：`sessionController.openWorkspacePath({ action: 'reveal' })`
 *    在 Windows 上就是 `explorer.exe /select,<file url>`，且它会先把路径过一遍 Host 路径校验。
 *    它不做存在性检查（路径不存在时 Explorer 会默默打开「文档」文件夹），所以这里先自己确认文件在。
 *  - **删除时故意保留归档记录**：被 GUI 打开过的会话会一直留在 Host 内存里（Harness 自己丢掉了
 *    能释放它的 Agent 句柄），归档集合是唯一能把它挡在侧边栏外面的东西。详见 README。
 *
 * @module dsh-plugin-conversation-delete
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import {
  ConversationFormatError,
  SESSION_LOG_FILENAME,
  bareDigest,
  buildArtifact,
  fileEntryId,
  mediaEntryId,
  normalizeHeader,
  parseArtifact,
  readConversationFile,
  retargetHeader,
} from './format.js'

export const name = 'conversation-delete'

/** Services this plugin parks on while they are absent. */
export const inject = ['webServer']

/** A Session id is one path segment; refuse anything that could escape a directory. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** How long the Host waits for a stopped Session to leave the live store. */
const DEFAULT_SETTLE_MS = 2500

/** Import upload ceiling. */
const DEFAULT_MAX_IMPORT_BYTES = 64 * 1024 * 1024

/** Export read ceiling (a pathological log should not be slurped into memory). */
const DEFAULT_MAX_EXPORT_BYTES = 256 * 1024 * 1024

/** JSON request body ceiling. */
const JSON_BODY_LIMIT = 64 * 1024

/** Reveal deadline: `revealNativePath` resolves as soon as the OS opener takes the request. */
const REVEAL_TIMEOUT_MS = 15000

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The Workspace registry's "live sessions and session persistence hold no such
 * session" refusal. It means there is nothing left to hide — for a delete, not
 * an error. Discrimination is by name: client and Host bundles do not share
 * error-class identity.
 */
function isUnknownSession(error) {
  return error instanceof Error && error.name === 'WorkspaceUnknownSessionError'
}

function delay(ms) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Resolve one directory root: plugin config, then an already-computed default,
 * then `$DSH_HOME/<leaf>`, then `~/.dsh/<leaf>`.
 */
function resolveRoot(config, key, precomputed, leaf) {
  const configured = config === null || typeof config !== 'object' ? undefined : config[key]
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  if (typeof precomputed === 'string' && precomputed.trim() !== '') return resolve(precomputed.trim())
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return join(resolve(home.trim()), leaf)
  return join(homedir(), '.dsh', leaf)
}

/** The backend's own resolved root (class field `root`), when the proxy exposes it. */
function backendRootOf(backend) {
  if (backend === null || backend === undefined) return undefined
  const fromConfig = backend.config?.root
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig.trim()
  const fromField = backend.root
  if (typeof fromField === 'string' && fromField.trim() !== '') return fromField.trim()
  return undefined
}

/** Resolve the Session artifact root. */
function sessionsRoot(ctx, config) {
  return resolveRoot(config, 'sessionsRoot', backendRootOf(ctx.get('sessionPersistence')), 'sessions')
}

/** Resolve the attachment store root (`$DSH_HOME/attachments`, whose objects live under `v1/`). */
function attachmentsRoot(ctx, config) {
  return resolveRoot(config, 'attachmentsRoot', undefined, 'attachments')
}

/** One directory per Session, grouped under a per-project directory: `<root>/<project>/<id>`. */
async function findSessionDirs(root, sessionId) {
  const found = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name, sessionId)
    try {
      const info = await stat(dir)
      if (info.isDirectory()) found.push(dir)
    } catch {
      /* not this project directory */
    }
  }
  return found
}

/**
 * Refuse a path that is not exactly one Session directory below the configured
 * root: `<root>/<project>/<id>`, with `<project>` a single path segment. A
 * Session id never contains a separator, so this cannot address anything else.
 */
function isInsideSessionDir(root, dir, sessionId) {
  const normalizedRoot = resolve(root)
  const normalizedDir = resolve(dir)
  if (!normalizedDir.startsWith(normalizedRoot + sep)) return false
  if (basename(normalizedDir) !== sessionId) return false
  return dirname(dirname(normalizedDir)) === normalizedRoot
}

/** Read one raw request body with a hard cap. */
async function readRawBody(req, limitBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error(`request body exceeds ${String(limitBytes)} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Read one JSON request body with a hard cap; a malformed or oversized body is a caller error. */
async function readJsonBody(req, limitBytes = JSON_BODY_LIMIT) {
  const raw = await readRawBody(req, limitBytes)
  if (raw.length === 0) return {}
  const parsed = JSON.parse(raw.toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
  return parsed
}

/**
 * Locate a Session's artifact on disk.
 *
 * `stat` supplies the stored header and `locate` turns it straight into the exact
 * log path; both are reachable through the Cordis service proxy although the
 * abstract persistence contract does not declare them. A directory scan is the
 * fallback, and it is also what makes `exists` trustworthy (an older format
 * generation uses a different file name).
 *
 * @returns `{ filePath, dir, exists, live, header }`
 */
async function resolveArtifact(ctx, config, sessionId) {
  const root = sessionsRoot(ctx, config)
  const sessions = ctx.get('sessions')
  const liveSession = sessions === undefined ? undefined : sessions.get(sessionId)
  const backend = ctx.get('sessionPersistence')

  let header
  if (backend !== undefined && typeof backend.stat === 'function') {
    try {
      const snapshot = await backend.stat(sessionId)
      if (snapshot !== undefined && snapshot.header !== undefined) header = snapshot.header
    } catch {
      /* unreadable header: fall through to the directory scan */
    }
  }

  let filePath
  if (header !== undefined && backend !== undefined && typeof backend.locate === 'function') {
    try {
      const located = backend.locate(header)
      if (located !== undefined && typeof located.path === 'string' && located.path !== '') filePath = resolve(located.path)
    } catch {
      /* locate is a private extra: never fatal */
    }
  }

  if (filePath === undefined) {
    const inside = (await findSessionDirs(root, sessionId)).find((dir) => isInsideSessionDir(root, dir, sessionId))
    if (inside !== undefined) filePath = join(inside, SESSION_LOG_FILENAME)
  }

  let exists = filePath !== undefined && existsSync(filePath)
  if (!exists) {
    for (const dir of await findSessionDirs(root, sessionId)) {
      if (!isInsideSessionDir(root, dir, sessionId)) continue
      try {
        const candidate = (await readdir(dir)).find((entry) => entry.startsWith('session.v') || entry === 'session.jsonl')
        if (candidate !== undefined) {
          filePath = join(dir, candidate)
          exists = true
          break
        }
      } catch {
        /* unreadable directory: keep looking */
      }
    }
  }
  const dir = filePath === undefined ? undefined : dirname(filePath)
  return { filePath, dir, exists, live: liveSession !== undefined, header }
}

/**
 * Flush a live Session so an export includes events still buffered in memory.
 * A failure here is not fatal — the stored log is still a valid (slightly older) export.
 */
async function flushLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || typeof sessions.flush !== 'function') return
  const live = sessions.get(sessionId)
  if (live === undefined) return
  try {
    await sessions.flush(live)
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------- 删除 */

/**
 * Delete one conversation: stop its work, drop it from the Client catalogue, and
 * remove its own Session directory. Every step is reported, and a failure in one
 * step never hides the others.
 */
async function deleteConversation(ctx, config, sessionId) {
  const report = {
    ok: false,
    sessionId,
    sessionsRoot: sessionsRoot(ctx, config),
    wasLive: false,
    archived: false,
    stillLive: false,
    removedDirs: [],
    failures: [],
  }
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    report.error = 'invalid session id'
    return report
  }

  const sessions = ctx.get('sessions')
  report.wasLive = sessions !== undefined && sessions.get(sessionId) !== undefined

  /*
   * Two things happen here, and the archive is kept deliberately:
   *
   *  - Running work must stop before its log disappears. Archiving is the
   *    shipped way: it is written durably first, then every
   *    `workspace/session-stop` provider is asked, and the archive set is what
   *    the `agent/pre-step` gate reads — so a woken Session cannot take a step.
   *  - A Session that has been opened in the Web UI stays in the live store for
   *    the rest of the process, and the catalogue lists live Sessions
   *    unconditionally. The archive entry is therefore what keeps a deleted
   *    conversation out of the sidebar in that case, so it is NOT lifted again.
   *
   * A Session that is neither live nor persisted is already gone; not an error.
   */
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
      report.archived = true
    } catch (error) {
      if (!isUnknownSession(error)) report.failures.push({ step: 'archive', error: messageOf(error) })
    }
    /* Drop the durable workspace membership of a Session that no longer exists. */
    try {
      for (const workspace of registry.list()) {
        if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId) && typeof workspace.detachSession === 'function') {
          await workspace.detachSession(sessionId)
        }
      }
      await registry.unpinSession(sessionId)
    } catch (error) {
      report.failures.push({ step: 'detach', error: messageOf(error) })
    }
  }

  if (report.wasLive && sessions !== undefined) {
    const settleMs = typeof config?.settleMs === 'number' && config.settleMs >= 0 ? config.settleMs : DEFAULT_SETTLE_MS
    const deadline = Date.now() + settleMs
    while (Date.now() < deadline && sessions.get(sessionId) !== undefined) await delay(100)
    report.stillLive = sessions.get(sessionId) !== undefined
  }

  const root = report.sessionsRoot
  const candidates = await findSessionDirs(root, sessionId)
  if (candidates.length === 0) {
    /* Fall back to the backend's own artifact location when the scan found nothing. */
    const resolvedPath = await resolveArtifact(ctx, config, sessionId)
    if (resolvedPath.dir !== undefined) candidates.push(resolvedPath.dir)
  }

  for (const dir of candidates) {
    if (!isInsideSessionDir(root, dir, sessionId)) {
      report.failures.push({ step: 'delete', path: dir, error: 'refused: path is not a session directory below the configured root' })
      continue
    }
    try {
      await rm(dir, { recursive: true, force: true })
      report.removedDirs.push(dir)
    } catch (error) {
      report.failures.push({ step: 'delete', path: dir, error: messageOf(error) })
    }
  }

  /*
   * Tell the Client the Session is gone last, once the files are really gone, so
   * an in-flight catalogue pull cannot resurrect the row afterwards. This is the
   * same forwarded event the Session controller raises on disposal, and the
   * forwarder does not care which plugin emitted it.
   */
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch (error) {
    report.failures.push({ step: 'notify', error: messageOf(error) })
  }

  report.ok = report.failures.length === 0
  if (report.stillLive) {
    report.note = 'the conversation was still open on the Host, so it stays archived out of the sidebar until the app restarts; its files are already deleted'
  }
  return report
}

/* ------------------------------------------------------------------- 导出 */

/** One safe browser download filename for one Session's raw artifact. */
function exportFilename(sessionId) {
  return `dsh-session-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl.zstd`
}

/** Read one conversation's raw artifact bytes (the fallback export path). */
async function exportConversation(ctx, config, sessionId) {
  const report = { ok: false, sessionId, filePath: undefined, bytes: undefined, live: false, failures: [] }
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    report.error = 'invalid session id'
    return report
  }
  await flushLiveSession(ctx, sessionId)
  const resolvedPath = await resolveArtifact(ctx, config, sessionId)
  report.filePath = resolvedPath.filePath
  report.live = resolvedPath.live
  if (resolvedPath.filePath === undefined || !resolvedPath.exists) {
    report.error = 'this conversation has no stored file on disk yet'
    return report
  }
  const limit = typeof config?.maxExportBytes === 'number' && config.maxExportBytes > 0 ? config.maxExportBytes : DEFAULT_MAX_EXPORT_BYTES
  try {
    const info = await stat(resolvedPath.filePath)
    if (info.size > limit) {
      report.error = `the conversation file is ${String(info.size)} bytes, above the ${String(limit)}-byte export ceiling`
      return report
    }
    report.bytes = await readFile(resolvedPath.filePath)
    report.ok = true
  } catch (error) {
    report.failures.push({ step: 'read', error: messageOf(error) })
    report.error = messageOf(error)
  }
  return report
}

/* ------------------------------------------------------------------- 导入 */

/** A fresh session id in the same shape the store mints. */
function mintSessionId() {
  return `session-${randomUUID()}`
}

/**
 * Restore the attachment objects an exported ZIP carries.
 *
 * Images are content-addressed: the entry is `media/<attachmentId>.<ext>` and the
 * object lives at `<attachments>/v1/objects/<id[0:2]>/<id>`, so the id is verified
 * against sha256 of the bytes before anything is written. Files are restored
 * one-to-one under `<attachments>/v1/files/...` (best effort: this machine has no
 * such directory yet, so that mapping is taken from the archive layout itself).
 */
async function restoreAttachments(ctx, config, extras, entries) {
  const restored = { media: 0, files: 0 }
  const skipped = []
  const root = join(attachmentsRoot(ctx, config), 'v1')
  for (const name of extras) {
    const content = entries.get(name)
    if (content === undefined) continue
    const mediaId = mediaEntryId(name)
    if (mediaId !== undefined) {
      const digest = bareDigest(mediaId).toLowerCase()
      const actual = createHash('sha256').update(content).digest('hex')
      if (actual !== digest) {
        skipped.push({ entry: name, reason: 'content does not match its content-addressed id' })
        continue
      }
      const target = join(root, 'objects', digest.slice(0, 2), digest)
      try {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content)
        restored.media += 1
      } catch (error) {
        skipped.push({ entry: name, reason: messageOf(error) })
      }
      continue
    }
    const fileRef = fileEntryId(name)
    if (fileRef !== undefined) {
      const digest = bareDigest(fileRef.digest).toLowerCase()
      const actual = createHash('sha256').update(content).digest('hex')
      const target = join(root, 'files', fileRef.prefix, digest, fileRef.leaf)
      try {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content)
        restored.files += 1
        if (actual !== digest) skipped.push({ entry: name, reason: 'restored, but its bytes do not match the archive digest' })
      } catch (error) {
        skipped.push({ entry: name, reason: messageOf(error) })
      }
      continue
    }
    if (name.startsWith('subagents/')) {
      skipped.push({ entry: name, reason: 'subagent transcripts are not imported (only the root conversation is)' })
    }
  }
  return { restored, skipped }
}

/**
 * Import one conversation file: validate it, place a real Session artifact for it,
 * and report what was written. Nothing is overwritten and nothing is deleted.
 */
async function importConversation(ctx, config, buffer) {
  const report = {
    ok: false,
    originalId: undefined,
    sessionId: undefined,
    reIded: false,
    kind: undefined,
    cwd: undefined,
    events: 0,
    bytes: buffer.length,
    artifactBytes: 0,
    droppedTornTail: false,
    extras: 0,
    restored: { media: 0, files: 0 },
    skipped: [],
    failures: [],
  }
  let parsed
  try {
    parsed = readConversationFile(buffer)
  } catch (error) {
    report.error = error instanceof ConversationFormatError ? error.message : messageOf(error)
    return report
  }
  report.kind = parsed.kind
  report.extras = parsed.extras.length
  let header
  try {
    header = normalizeHeader(parsed.header)
  } catch (error) {
    report.error = error instanceof ConversationFormatError ? error.message : messageOf(error)
    return report
  }
  report.originalId = header.id
  if (!SESSION_ID.test(header.id)) {
    report.error = 'the header carries a session id that is not a safe path segment'
    return report
  }
  report.cwd = header.cwd
  report.events = parsed.eventsText === '' ? 0 : parsed.eventsText.split('\n').length - 1
  report.droppedTornTail = parsed.droppedTornTail === true

  const backend = ctx.get('sessionPersistence')
  if (backend === undefined || backend === null) {
    report.error = 'session persistence is unavailable in this composition'
    return report
  }
  if (typeof backend.locate !== 'function') {
    report.error = 'this session backend does not expose locate(); importing is unavailable'
    return report
  }

  /* Keep the original id when it is free; otherwise mint a fresh one so a re-import never clobbers the original. */
  const sessions = ctx.get('sessions')
  const takenByLive = sessions !== undefined && sessions.get(header.id) !== undefined
  const takenPath = backend.locate(header)
  const takenOnDisk = takenPath !== undefined && typeof takenPath.path === 'string' && existsSync(takenPath.path)
  let storedTaken = false
  if (!takenByLive && !takenOnDisk && typeof backend.stat === 'function') {
    try {
      storedTaken = (await backend.stat(header.id)) !== undefined
    } catch {
      storedTaken = false
    }
  }
  if (takenByLive || takenOnDisk || storedTaken) {
    header.id = mintSessionId()
    report.reIded = true
  }
  report.sessionId = header.id

  const located = backend.locate(header)
  if (located === undefined || typeof located.path !== 'string' || located.path === '') {
    report.error = 'the session backend did not return a target path for the imported header'
    return report
  }
  const targetPath = resolve(located.path)
  const targetDir = dirname(targetPath)
  const root = sessionsRoot(ctx, config)
  if (!isInsideSessionDir(root, targetDir, header.id)) {
    report.failures.push({ step: 'place', error: `refused: ${targetDir} is not a session directory below ${root}` })
    report.error = 'refused to write outside the configured session root'
    return report
  }
  if (existsSync(targetPath)) {
    report.error = 'a stored log already exists at the target path; refusing to overwrite it'
    return report
  }

  let artifact
  try {
    artifact = buildArtifact(header, parsed.eventsText)
  } catch (error) {
    report.error = messageOf(error)
    return report
  }
  report.artifactBytes = artifact.length

  const temporary = join(targetDir, `import-${randomUUID()}.tmp`)
  try {
    await mkdir(targetDir, { recursive: true })
    await writeFile(temporary, artifact)
    await rename(temporary, targetPath)
  } catch (error) {
    report.failures.push({ step: 'write', error: messageOf(error) })
    report.error = messageOf(error)
    try {
      if (existsSync(temporary)) await unlink(temporary)
    } catch {
      /* leave the temp file rather than hide the real failure */
    }
    return report
  }

  /* Prove the backend can read back what was just written — the only real proof the encoding is right. */
  if (typeof backend.stat === 'function') {
    try {
      const snapshot = await backend.stat(header.id)
      report.verified = snapshot !== undefined
      if (snapshot === undefined) {
        report.failures.push({ step: 'verify', error: 'the session backend cannot read the imported file back' })
      }
    } catch (error) {
      report.verified = false
      report.failures.push({ step: 'verify', error: messageOf(error) })
    }
  }

  if (parsed.kind === 'zip' && parsed.extras.length > 0 && parsed.entries instanceof Map) {
    const outcomes = await restoreAttachments(ctx, config, parsed.extras, parsed.entries)
    report.restored = outcomes.restored
    report.skipped = outcomes.skipped
  }

  report.ok = report.failures.length === 0
  if (!report.ok && report.error === undefined) report.error = report.failures[0].error
  return report
}

/* ------------------------------------------------------------------- 定位 */

/**
 * Reveal one conversation's file in the OS file manager.
 *
 * The Host owns the reveal (`sessionController.openWorkspacePath` with
 * `action: 'reveal'`): on Windows that is `explorer.exe /select,<file url>` with
 * Explorer's own escaping, and the path passes the controller's Host-path gate
 * first. It performs no existence check — an unresolvable path silently opens the
 * user's Documents folder — so existence is verified here.
 */
async function revealConversation(ctx, config, sessionId) {
  const report = { ok: false, sessionId, path: undefined, kind: undefined, failures: [] }
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    report.error = 'invalid session id'
    return report
  }
  const resolvedPath = await resolveArtifact(ctx, config, sessionId)
  let target = resolvedPath.exists ? resolvedPath.filePath : resolvedPath.dir
  let kind = resolvedPath.exists ? 'file' : 'directory'
  if (target === undefined || !existsSync(target)) {
    target = undefined
    kind = undefined
  }
  if (target === undefined) {
    report.error = 'this conversation has no file on disk to show'
    return report
  }
  report.path = target
  report.kind = kind

  const controller = ctx.get('sessionController')
  if (controller === undefined || typeof controller.openWorkspacePath !== 'function') {
    report.error = 'the Host cannot reach the desktop from this composition (no sessionController)'
    return report
  }
  try {
    await controller.openWorkspacePath({ path: target, action: 'reveal' }, AbortSignal.timeout(REVEAL_TIMEOUT_MS))
    report.ok = true
  } catch (error) {
    report.failures.push({ step: 'reveal', error: messageOf(error) })
    report.error = messageOf(error)
  }
  return report
}

/* --------------------------------------------------------------- 更换工作区 */

/**
 * 让工作区注册表**丢掉它对这条会话头记录的缓存**，下次读的时候必须重新扫盘。
 *
 * 为什么必须要这一步：`attachSession()` 是通过 `host.readSessionHeader(id)` 拿 cwd 的，而那个
 * 方法的顺序是「活会话 → **内存缓存** → 扫盘」——
 * **只有缓存里没有才会去扫盘**。我的搬迁把磁盘更新了，缓存里却还留着旧 cwd；
 * 紧接着的 attachSession 于是拿旧 cwd 去 `realpath()`，报
 * `its cwd 'C:\…旧路径' does not resolve, so it cannot be validated`。
 *
 * `WorkspaceRegistryLike` 上没有公开的失效接口，所以这里按能力探测，找到哪个用哪个；
 * 一个都没有也没关系：调用方会在 `stat()` 失败时重试一次，重试本身就会重建索引。
 * @param ctx - Host root context.
 * @param sessionId - the session whose cached header is stale.
 */
async function refreshWorkspaceHeaderCache(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  for (const method of ['invalidateSessionHeader', 'forgetSessionHeader', 'refreshSessionHeader', 'invalidateHeader']) {
    if (typeof registry[method] !== 'function') continue
    try {
      await registry[method](sessionId)
      return
    } catch {
      /* 探测失败就继续试下一个 */
    }
  }
  /* 退而求其次：能整表重建也行（公开的 listStoredHeaders/indexHeaders 组合） */
  if (typeof registry.listStoredHeaders === 'function' && typeof registry.indexHeaders === 'function') {
    try {
      await registry.indexHeaders(await registry.listStoredHeaders())
    } catch {
      /* 交给调用方的重试 */
    }
  }
}

/**
 * `backend.locate(header).path`，拿不到就返回 undefined。
 * `locate` 是后端类上的私有便利方法（抽象契约里没有），所以一律当成「有则用、无则退」。
 */
function locatePath(backend, header) {
  if (backend === undefined || typeof backend.locate !== 'function') return undefined
  try {
    const located = backend.locate(header)
    if (located !== undefined && typeof located.path === 'string' && located.path !== '') return resolve(located.path)
  } catch {
    /* never fatal: the caller falls back to the directory scan */
  }
  return undefined
}

/**
 * Move one conversation to another workspace.
 *
 * 工作区归属是由会话头的 `cwd` 决定的（见 `format.js` 的 `retargetHeader`），
 * 所以这是一次**真正的搬家**：改写 cwd → 把日志挪到新 cwd 对应的项目目录 →
 * 再把工作区账户从旧工作区挪到新工作区（`attachSession` 会校验 cwd 必须等于工作区路径）。
 *
 * 任何一步失败都能恢复，顺序是刻意这样排的：
 *   1. 先把旧文件改名 aside —— 后端立刻不再认它，但字节还在原地；
 *   2. 再写新位置（临时文件 + rename）；
 *   3. **回读验证**后端能在新位置认出这条会话（`stat` + `locate` 必须都指向新路径）；
 *   4. 验证通过才删旧目录；不通过就把新文件删掉、把旧文件改回来。
 * 全程不会出现「两份同时在」的状态（那会让后端报 duplicate session id）。
 */
async function moveConversation(ctx, config, sessionId, workspaceId) {
  const report = { ok: false, sessionId, workspaceId, from: undefined, to: undefined, verified: false, failures: [] }
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    report.error = 'invalid session id'
    return report
  }
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    report.error = 'invalid workspace id'
    return report
  }

  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    report.error = 'the workspace registry is unavailable in this composition'
    return report
  }
  let target
  try {
    target = registry.get(workspaceId)
  } catch (error) {
    report.error = messageOf(error)
    return report
  }
  if (target === undefined) {
    report.error = 'no workspace has that id'
    return report
  }
  const targetPath = resolve(target.path)
  let targetIsDirectory = false
  try {
    targetIsDirectory = (await stat(targetPath)).isDirectory()
  } catch {
    targetIsDirectory = false
  }
  if (!targetIsDirectory) {
    report.error = `the workspace directory does not exist: ${targetPath}`
    return report
  }
  report.to = { workspaceId: String(target.id), path: targetPath, title: String(target.title) }

  const backend = ctx.get('sessionPersistence')
  if (backend === undefined || typeof backend.stat !== 'function') {
    report.error = 'the session backend does not expose stat(); moving is unavailable'
    return report
  }

  /* 活着的会话不能在它脚下改 cwd：先归档停活，等它离开内存 */
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && sessions.get(sessionId) !== undefined) {
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
    } catch (error) {
      if (!isUnknownSession(error)) report.failures.push({ step: 'stop', error: messageOf(error) })
    }
    const settleMs = typeof config?.settleMs === 'number' && config.settleMs >= 0 ? config.settleMs : DEFAULT_SETTLE_MS
    const deadline = Date.now() + settleMs
    while (Date.now() < deadline && sessions.get(sessionId) !== undefined) await delay(100)
    if (sessions.get(sessionId) !== undefined) {
      report.error = 'this conversation is still open on the Host; close it and try again'
      return report
    }
  }

  let snapshot
  try {
    snapshot = await backend.stat(sessionId)
  } catch (error) {
    /* 缓存里的旧路径已经不在了 → 让缓存失效后重试一次（正是「上一次搬迁只改了一半」的情形） */
    await refreshWorkspaceHeaderCache(ctx, sessionId)
    try {
      snapshot = await backend.stat(sessionId)
    } catch (retryError) {
      report.error = messageOf(retryError)
      return report
    }
  }
  if (snapshot === undefined || snapshot.header === undefined) {
    report.error = 'this conversation has no stored log on disk'
    return report
  }
  const currentHeader = snapshot.header
  const currentPath = locatePath(backend, currentHeader)
  if (currentPath === undefined) {
    report.error = 'the session backend did not return the current log path'
    return report
  }
  if (!existsSync(currentPath)) {
    report.error = 'the stored log is missing from disk'
    return report
  }

  const currentCwd = typeof currentHeader.cwd === 'string' && currentHeader.cwd !== '' ? resolve(currentHeader.cwd) : undefined
  report.from = { cwd: currentCwd, file: currentPath }
  if (currentCwd !== undefined && currentCwd === targetPath) {
    /* 已经在该工作区：只补一次账户归属，不搬文件 */
    try {
      await target.attachSession(sessionId)
      report.ok = true
      report.verified = true
      report.note = 'already in that workspace'
    } catch (error) {
      report.failures.push({ step: 'attach', error: messageOf(error) })
      report.error = messageOf(error)
    }
    return report
  }

  let parsed
  try {
    parsed = parseArtifact(await readFile(currentPath))
  } catch (error) {
    report.error = `cannot read the stored log: ${messageOf(error)}`
    return report
  }
  let moved
  try {
    moved = retargetHeader(parsed.header, targetPath)
  } catch (error) {
    report.error = error instanceof ConversationFormatError ? error.message : messageOf(error)
    return report
  }
  let artifact
  try {
    artifact = buildArtifact(moved, parsed.eventsText)
  } catch (error) {
    report.error = messageOf(error)
    return report
  }

  const newPath = locatePath(backend, moved)
  if (newPath === undefined) {
    report.error = 'the session backend did not return a target path'
    return report
  }
  const newDir = dirname(newPath)
  const root = sessionsRoot(ctx, config)
  if (!isInsideSessionDir(root, newDir, sessionId)) {
    report.error = 'refused to write outside the configured session root'
    return report
  }
  /*
   * 两个不同的 cwd 有可能映射到同一个项目目录名（编码是有损的：`C:\a-b` 与 `C:\a\b` 同名），
   * 那种情况就是「原地改 cwd」，不搬文件，只把权威代际重写一遍。
   */
  const oldDir = dirname(currentPath)
  const sameDirectory = resolve(oldDir) === resolve(newDir)
  if (!sameDirectory && existsSync(newPath)) {
    report.error = 'a stored log already exists at the target path; refusing to overwrite it'
    return report
  }

  /*
   * 搬家：把旧会话目录里的**每个条目**都挪进新目录，然后在新目录里把权威代际那一份
   * 换成改写 cwd 后的字节。
   *
   * 为什么不是「只把定位到的那一个文件改名 aside」：一个会话目录里可以同时躺着**多个代际**
   * ——实测就有 `session.v3.jsonl.zstd`（历史代际，迁移来源）与 `session.v4.jsonl.zstd`
   * （当前代际）并存的会话。v3 同样是合法代际，只改名 v4 的话，旧目录**仍然**被后端认作
   * 这条会话的位置，`findLog()` 就会在两个项目目录里各找到一个 → 抛
   * `duplicate JSONL session id appears in multiple project directories` → 回读验证失败。
   * 也不能简单地把整个目录改名：`listSessionDirs()` 会列**所有**目录且不校验目录名，
   * 改名后的目录照样被扫、里面的文件照样算一个代际，问题只会换个形式回来。
   * 所以：整目录内容一起搬走，旧目录彻底空掉。
   */
  const authoritativeInOld = join(oldDir, basename(currentPath))
  const authoritativeInNew = join(newDir, basename(currentPath))
  const originalBytes = await readFile(currentPath)

  if (!sameDirectory && existsSync(newDir)) {
    report.error = 'a session directory already exists at the target location; refusing to merge into it'
    return report
  }

  const moves = []
  const undoMoves = async function () {
    for (const move of [...moves].reverse()) {
      try {
        await rename(move.to, move.from)
      } catch (error) {
        report.failures.push({ step: 'restore', error: messageOf(error) })
      }
    }
  }
  const restoreAuthoritative = async function () {
    /* 权威那一份按原始字节写回：即便上面的搬动只完成了一部分，也能还原成原样 */
    try {
      await writeFile(authoritativeInOld, originalBytes)
    } catch (error) {
      report.failures.push({ step: 'restore', error: messageOf(error) })
    }
  }

  try {
    if (!sameDirectory) {
      await mkdir(newDir, { recursive: true })
      for (const entry of await readdir(oldDir, { withFileTypes: true })) {
        if (!entry.isFile() && !entry.isDirectory()) continue
        const from = join(oldDir, entry.name)
        const to = join(newDir, entry.name)
        await rename(from, to)
        moves.push({ from, to })
      }
    }
  } catch (error) {
    report.failures.push({ step: 'stage', error: messageOf(error) })
    report.error = `cannot move the stored session directory: ${messageOf(error)}`
    await undoMoves()
    await restoreAuthoritative()
    if (!sameDirectory) {
      try {
        await rm(newDir, { recursive: true, force: true })
      } catch {
        /* 留个记录不如留个能看懂的失败 */
      }
    }
    return report
  }

  const temporary = join(newDir, `move-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, artifact)
    await rename(temporary, authoritativeInNew)
  } catch (error) {
    report.failures.push({ step: 'write', error: messageOf(error) })
    report.error = messageOf(error)
    try {
      if (existsSync(temporary)) await unlink(temporary)
    } catch {
      /* 宁可留下临时文件，也不要盖住真正的失败原因 */
    }
    await undoMoves()
    await restoreAuthoritative()
    if (!sameDirectory) {
      try {
        await rm(newDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    return report
  }

  /* 回读验证：后端必须能在新位置认出这条会话（旧目录已经空了，不会再撞 duplicate） */
  try {
    const after = await backend.stat(sessionId)
    const afterPath = after === undefined || after.header === undefined ? undefined : locatePath(backend, after.header)
    report.verified = afterPath !== undefined && resolve(afterPath) === newPath
    if (!report.verified) report.failures.push({ step: 'verify', error: 'the backend did not resolve the log at its new path' })
  } catch (error) {
    report.verified = false
    report.failures.push({ step: 'verify', error: messageOf(error) })
  }

  if (!report.verified) {
    /* 验证没过就整体回滚：搬回去、把权威那一份按原字节写回、清掉新目录 */
    await undoMoves()
    await restoreAuthoritative()
    if (!sameDirectory) {
      try {
        await rm(newDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    await refreshWorkspaceHeaderCache(ctx, sessionId)
    report.error = 'the move could not be verified and was rolled back'
    return report
  }

  /*
   * 磁盘改完了，但工作区注册表的内存缓存里还留着**旧 cwd**。不清掉它，紧接着的
   * `attachSession()` 就会拿旧 cwd 去做 realpath 校验并报
   * 「its cwd '<旧路径>' does not resolve」—— 事情其实已经搬成功了，却报成失败。
   */
  await refreshWorkspaceHeaderCache(ctx, sessionId)

  /* 成功：旧目录应该已经空了，直接删掉 */
  if (!sameDirectory) {
    try {
      await rm(oldDir, { recursive: true, force: true })
    } catch (error) {
      report.failures.push({ step: 'cleanup', error: messageOf(error) })
    }
  }
  report.movedFile = { from: currentPath, to: newPath }
  report.movedEntries = moves.length

  /* 账户归属：先挂到新工作区（它会校验 cwd == 工作区路径），再把别处的一律摘掉 */
  try {
    await target.attachSession(sessionId)
  } catch (error) {
    report.failures.push({ step: 'attach', error: messageOf(error) })
  }
  try {
    for (const workspace of registry.list()) {
      if (workspace.id === target.id) continue
      if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId) && typeof workspace.detachSession === 'function') {
        await workspace.detachSession(sessionId)
      }
    }
  } catch (error) {
    report.failures.push({ step: 'detach', error: messageOf(error) })
  }

  report.ok = report.failures.length === 0
  if (!report.ok && report.error === undefined) report.error = report.failures[0].error
  return report
}

/* -------------------------------------------------------------------- 路由 */

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendBytes(res, status, bytes, headers) {
  res.statusCode = status
  res.setHeader('content-type', 'application/octet-stream')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(bytes.length))
  for (const [header, value] of Object.entries(headers ?? {})) res.setHeader(header, value)
  res.end(bytes)
}

/**
 * Register the routes once the web carrier exists.
 * @param ctx - Host root context.
 * @param config - plugin config.
 */
export function apply(ctx, config) {
  /** Routes that take a JSON body. */
  const jsonRoutes = [
    { path: '/conversation-delete/delete', run: (body) => deleteConversation(ctx, config, body.sessionId), okStatus: 200, failStatus: 409 },
    { path: '/conversation-delete/reveal', run: (body) => revealConversation(ctx, config, body.sessionId), okStatus: 200, failStatus: 409 },
    { path: '/conversation-delete/move', run: (body) => moveConversation(ctx, config, body.sessionId, body.workspaceId), okStatus: 200, failStatus: 409 },
  ]

  const routes = jsonRoutes.map((entry) => ({
    kind: 'exact',
    path: entry.path,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST required' })
        return
      }
      readJsonBody(req).then(
        (body) => entry.run(body).then(
          (report) => sendJson(res, report.ok ? entry.okStatus : entry.failStatus, report),
          (error) => sendJson(res, 500, { ok: false, error: messageOf(error) }),
        ),
        (error) => sendJson(res, 400, { ok: false, error: messageOf(error) }),
      )
    },
  }))

  routes.push({
    kind: 'exact',
    path: '/conversation-delete/export',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST required' })
        return
      }
      readJsonBody(req).then(
        (body) => exportConversation(ctx, config, body.sessionId).then(
          (report) => {
            if (!report.ok) {
              sendJson(res, 404, report)
              return
            }
            sendBytes(res, 200, report.bytes, { 'x-conversation-filename': exportFilename(String(report.sessionId)) })
          },
          (error) => sendJson(res, 500, { ok: false, error: messageOf(error) }),
        ),
        (error) => sendJson(res, 400, { ok: false, error: messageOf(error) }),
      )
    },
  })

  routes.push({
    kind: 'exact',
    path: '/conversation-delete/import',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST required' })
        return
      }
      const limit = typeof config?.maxImportBytes === 'number' && config.maxImportBytes > 0 ? config.maxImportBytes : DEFAULT_MAX_IMPORT_BYTES
      readRawBody(req, limit).then(
        (buffer) => {
          if (buffer.length === 0) {
            sendJson(res, 400, { ok: false, error: 'the request body is empty' })
            return
          }
          importConversation(ctx, config, buffer).then(
            (report) => sendJson(res, report.ok ? 200 : 409, report),
            (error) => sendJson(res, 500, { ok: false, error: messageOf(error) }),
          )
        },
        (error) => sendJson(res, 400, { ok: false, error: messageOf(error) }),
      )
    },
  })

  const register = (injected) => {
    const server = injected !== undefined ? injected : ctx.get('webServer')
    if (server === undefined) {
      console.error('conversation-delete: webServer never appeared; the routes are unavailable')
      return
    }
    for (const route of routes) {
      try {
        ctx.effect(() => server.register(route))
        console.log(`conversation-delete: route ready (${route.path})`)
      } catch (error) {
        console.error(`conversation-delete: cannot claim ${route.path}: ${messageOf(error)}`)
      }
    }
  }

  const direct = ctx.get('webServer')
  if (direct !== undefined) {
    register(direct)
    return
  }
  ctx.inject(['webServer'], register)
}
