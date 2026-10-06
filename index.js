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
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
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
 * 把「服务给回来的路径」收敛成字符串。
 *
 * 为什么需要它：新版 DSH 里服务暴露的路径**不一定是裸字符串**。桌面版实测会返回对象，
 * 于是 `path.resolve(那个对象)` 直接抛
 * `The "path" argument must be of type string. Received an instance of Object`。
 * web 版返回的是字符串，所以这个坑只在桌面版暴露出来。
 *
 * 兼容三种形态：字符串本身、`{ path }` 包装、以及有意义的 `toString()`（品牌化路径类）。
 * @param value - whatever a service handed back.
 * @returns 可用的路径字符串；读不出字符串时返回 undefined。
 */
function pathText(value) {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object') {
    if (typeof value.path === 'string' && value.path !== '') return value.path
    if (typeof value.toString === 'function') {
      const text = String(value)
      if (text !== '' && text !== '[object Object]') return text
    }
    return undefined
  }
  return undefined
}

/**
 * 从 `backend.locate()` 的返回值里取出路径字符串（桌面版返回的对象也能吃）。
 * @param located - the service's locate() result.
 * @returns 路径字符串；读不出来就 undefined。
 */
function locateTextOf(located) {
  if (located === null || located === undefined) return undefined
  const fromField = pathText(located.path)
  if (fromField !== undefined) return fromField
  return pathText(located)
}

/**
 * Resolve one directory root: plugin config, then an already-computed default,
 * then `$DSH_HOME/<leaf>`, then `~/.dsh/<leaf>`.
 */
function resolveRoot(config, key, precomputed, leaf) {
  const configured = config === null || typeof config !== 'object' ? undefined : pathText(config[key])
  if (configured !== undefined && configured.trim() !== '') return resolve(configured.trim())
  const fallback = pathText(precomputed)
  if (fallback !== undefined && fallback.trim() !== '') return resolve(fallback.trim())
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return join(resolve(home.trim()), leaf)
  return join(homedir(), '.dsh', leaf)
}

/** The backend's own resolved root (class field `root`), when the proxy exposes it. */
function backendRootOf(backend) {
  if (backend === null || backend === undefined) return undefined
  const fromConfig = pathText(backend.config?.root)
  if (fromConfig !== undefined && fromConfig.trim() !== '') return fromConfig.trim()
  const fromField = pathText(backend.root)
  if (fromField !== undefined && fromField.trim() !== '') return fromField.trim()
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
      const locatedText = locateTextOf(located)
    if (locatedText !== undefined) filePath = resolve(locatedText)
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
  /* 同一个多路兜底：桌面版（较新的 DSH）strict 的 ctx.get 拿不到，非 strict / ctx.root 可能拿到 */
  const registry = resolveWorkspaceRegistry(ctx).registry
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
  const locatedText = locateTextOf(located)
  if (locatedText === undefined) {
    report.error = 'the session backend did not return a target path for the imported header'
    return report
  }
  const targetPath = resolve(locatedText)
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

  /* 首选宿主的实现：它会先把路径过一遍 Host 校验，也负责桌面端的差异 */
  const controller = resolveHostService(ctx, ['sessionController'], (value) => typeof value.openWorkspacePath === 'function').service
  if (controller !== undefined) {
    try {
      await controller.openWorkspacePath({ path: target, action: 'reveal' }, AbortSignal.timeout(REVEAL_TIMEOUT_MS))
      report.ok = true
      report.via = 'sessionController'
      return report
    } catch (error) {
      report.failures.push({ step: 'reveal', error: messageOf(error) })
    }
  }

  /*
   * 兜底：有些组合（实测：桌面版的插件 Host）没有 `sessionController`，那就自己叫系统文件管理器。
   * 安全性：`target` 已经确认存在（上面 629 行），且用**参数数组**传（不经过 shell，不拼接命令）。
   * detached + unref + stdio:ignore：不占用宿主进程，Explorer 退出码 1 也算成功（它一贯如此）。
   */
  const spawned = spawnReveal(target)
  if (spawned.ok) {
    report.ok = true
    report.via = spawned.via
    return report
  }
  if (spawned.error !== undefined) {
    report.failures.push({ step: 'spawn', error: spawned.error })
    report.error = spawned.error
    return report
  }
  if (report.error === undefined) {
    report.error = 'the Host cannot reach the desktop from this composition (no sessionController)'
  }
  return report
}

/**
 * 不依赖 `sessionController` 的「在文件管理器里选中它」实现。
 * @param target - an existing absolute path.
 * @returns {{ok: boolean, via?: string, error?: string}}
 */
function spawnReveal(target) {
  let command
  let args
  if (process.platform === 'win32') {
    command = 'explorer.exe'
    args = [`/select,${target}`]
  } else if (process.platform === 'darwin') {
    command = 'open'
    args = ['-R', target]
  } else {
    /* Linux 没有统一的“选中”约定，退化成打开它所在的目录 */
    command = 'xdg-open'
    args = [dirname(target)]
  }
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    /* 必须挂 error 处理：ChildProcess 的 'error' 事件没有监听者会直接抛出去 */
    child.on('error', () => {})
    child.unref()
    return { ok: true, via: command }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
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
  const registry = resolveWorkspaceRegistry(ctx).registry
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
    const text = locateTextOf(located)
    if (text !== undefined) return resolve(text)
  } catch {
    /* never fatal: the caller falls back to the directory scan */
  }
  return undefined
}

/**
 * 尽力取一个宿主服务：strict → 非 strict → `ctx.root` × 若干候选名字。
 *
 * **为什么不能只写 `ctx.get('x')`**：Cordis 4 的 `ctx.get(name)` 默认是 **strict** 的 ——
 * 只返回「提供它的 fiber 当前处于 active」的实现，否则给 `undefined`。另外服务还可能被隔在
 * 别的 `isolate` 作用域里，或者某个组合根本没把它交给插件（桌面版的插件 Host 就是这样：
 * 实测 `workspaceRegistry` 与 `sessionController` 都拿不到，而 `sessions` /
 * `sessionPersistence` / `webServer` / `typert` 都 active）。
 * `usable` 用来确认拿到的真的是那个服务，而不是同名的别的东西。
 *
 * @param ctx - Host root context.
 * @param names - candidate service names, most likely first.
 * @param usable - optional predicate on the resolved value.
 * @returns {{service: object|undefined, source: string|undefined}}
 */
function resolveHostService(ctx, names, usable) {
  const scopes = [{ scope: ctx, label: 'ctx' }]
  try {
    if (ctx !== null && ctx !== undefined && ctx.root !== undefined && ctx.root !== null && ctx.root !== ctx) {
      scopes.push({ scope: ctx.root, label: 'ctx.root' })
    }
  } catch {
    /* root 拿不到就算了 */
  }
  for (const strict of [true, false]) {
    for (const entry of scopes) {
      for (const name of names) {
        let value
        try {
          value = entry.scope.get(name, strict)
        } catch {
          continue
        }
        if (value === undefined || value === null) continue
        if (usable !== undefined && usable(value) !== true) continue
        return { service: value, source: `${entry.label}.get('${name}'${strict ? '' : ', false'})` }
      }
    }
  }
  return { service: undefined, source: undefined }
}

/**
 * 找到工作区注册表：上面那个通用兜底的特例，额外要求拿到的真的像个注册表。
 * @param ctx - Host root context.
 * @returns {{registry: object|undefined, source: string|undefined}}
 */
function resolveWorkspaceRegistry(ctx) {
  const found = resolveHostService(
    ctx,
    ['workspaceRegistry', 'workspaceController', 'workspaces', 'workspace'],
    (value) => typeof value.list === 'function' && typeof value.get === 'function',
  )
  return { registry: found.service, source: found.source }
}

/**
 * 取工作区实体上的某个方法（不同版本命名可能不同），返回**已绑定 this** 的函数。
 * @param workspace - the registry's workspace entity.
 * @param names - candidate method names, most likely first.
 * @returns a bound function, or undefined when none exists.
 */
function pickWorkspaceMethod(workspace, names) {
  if (workspace === null || workspace === undefined) return undefined
  for (const name of names) {
    let fn
    try {
      fn = workspace[name]
    } catch {
      continue
    }
    if (typeof fn === 'function') return fn.bind(workspace)
  }
  return undefined
}

/**
 * 为某个目录拿到（必要时建立）一个工作区。
 *
 * 这一步原来放在浏览器半（调客户端的 `workspaces.create`），但它走的是 typert 网关 →
 * `workspaceController` 这个 Service，而桌面版组合里那条路不通（`gateway/service-unavailable`）。
 * 既然 Host 半本来就要用注册表来改账户归属，索性把「找/建工作区」也放到 Host：
 * 少一次网关往返，也不再受客户端组合差异影响。
 * @param registry - the workspace registry.
 * @param targetPath - the directory the conversation should belong to.
 * @returns {{workspace: object, created: boolean, path: string}}
 */
async function ensureWorkspaceForPath(registry, targetPath) {
  const wanted = pathText(targetPath)
  if (wanted === undefined) throw new Error('no usable directory path was given')
  let canonical = resolve(wanted)
  try {
    canonical = await realpath(wanted)
  } catch {
    /* 目录不存在时 realpath 会抛：保持 resolve() 的结果，由调用方去报「目录不存在」 */
  }
  const existing = registry.list().find((workspace) => {
    /* workspace.path 在桌面版是对象，必须先用 pathText 收敛（否则 path.resolve 会抛） */
    const other = pathText(workspace.path)
    if (other === undefined) return false
    try {
      return resolve(other) === canonical || other === wanted
    } catch {
      return false
    }
  })
  if (existing !== undefined) return { workspace: existing, created: false, path: canonical }
  if (typeof registry.create !== 'function') {
    throw new Error('this composition exposes the workspace registry but not its create(); pick an existing workspace instead')
  }
  const created = await registry.create({ path: canonical })
  const workspace = created !== null && typeof created === 'object' && created.workspace !== undefined ? created.workspace : created
  if (workspace === undefined || workspace === null || typeof workspace.attachSession !== 'function') {
    throw new Error('the workspace registry did not return a usable workspace for that directory')
  }
  return { workspace, created: true, path: canonical }
}

/**
 * Move one conversation to another workspace.
 *
 * 工作区归属是由会话头的 `cwd` 决定的（见 `format.js` 的 `retargetHeader`），
 * 所以这是一次**真正的搬家**：改写 cwd → 把日志挪到新 cwd 对应的项目目录 →
 * 再把工作区账户从旧工作区挪到新工作区（`attachSession` 会校验 cwd 必须等于工作区路径）。
 *
 * 目标可以给 `workspaceId`（已有工作区），也可以只给 `path`（Host 自己去建/找）。
 * 任何一步失败都能恢复，顺序是刻意这样排的：
 *   1. 把旧会话目录里的每个条目都搬进新目录（多代际一起走）；
 *   2. 在新位置把权威代际那一份换成改写 cwd 后的字节；
 *   3. **回读验证**后端能在新位置认出这条会话（`stat` + `locate` 必须都指向新路径）；
 *   4. 验证通过才删掉（已空的）旧目录；不通过就整体回滚。
 */
async function moveConversation(ctx, config, sessionId, workspaceId, targetDirectory) {
  const report = { ok: false, sessionId, workspaceId, from: undefined, to: undefined, verified: false, failures: [] }
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    report.error = 'invalid session id'
    return report
  }
  const wantsPath = (workspaceId === undefined || workspaceId === null || workspaceId === '')
  if (wantsPath && (typeof targetDirectory !== 'string' || targetDirectory === '')) {
    report.error = 'invalid workspace id'
    return report
  }
  if (!wantsPath && typeof workspaceId !== 'string') {
    report.error = 'invalid workspace id'
    return report
  }

  const found = resolveWorkspaceRegistry(ctx)
  const registry = found.registry
  report.registrySource = found.source
  if (registry === undefined) {
    report.error = 'the workspace registry is unavailable in this composition'
    return report
  }
  let target
  try {
    if (wantsPath) {
      /* 只给了目录：Host 自己去找/建工作区（这样浏览器半不必依赖客户端网关的 workspace/create） */
      const ensured = await ensureWorkspaceForPath(registry, targetDirectory)
      target = ensured.workspace
      report.workspaceCreated = ensured.created
    } else {
      target = registry.get(workspaceId)
    }
  } catch (error) {
    report.error = messageOf(error)
    return report
  }
  if (target === undefined) {
    report.error = 'no workspace has that id'
    return report
  }
  /* target.path 在桌面版是对象（web 版是字符串），一律先收敛成字符串再用 */
  const targetText = pathText(target.path)
  if (targetText === undefined) {
    report.error = 'the workspace did not report a usable directory path'
    return report
  }
  const targetPath = resolve(targetText)
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

  /* 账户归属：先挂到新工作区（它会校验 cwd == 工作区路径），再把**其它每个**工作区上的它摘掉 */
  try {
    await target.attachSession(sessionId)
  } catch (error) {
    report.failures.push({ step: 'attach', error: messageOf(error) })
  }
  const detachedFrom = []
  for (const workspace of registry.list()) {
    if (workspace.id === target.id) continue
    /*
     * **不要用 `workspace.sessionIds.includes(id)` 预判**。桌面版实测：那个 getter 会按 cwd 过滤，
     * 搬完之后旧工作区根本「看不见」这条会话，预判永远是 false —— 于是 detach 被整段跳过，
     * 旧账上一直留着这条 id，侧边栏就在新旧两个工作区里都列出它，点一个亮两个。
     * 而 detach 的契约写明是**幂等**的（不在账上也不写），所以直接对每个其它工作区调一次即可。
     */
    const detach = pickWorkspaceMethod(workspace, ['detachSession', 'removeSession', 'detach', 'forgetSession'])
    if (detach === undefined) {
      report.failures.push({ step: 'detach', error: `workspace ${String(workspace.id)} exposes no detach method` })
      continue
    }
    try {
      await detach(sessionId)
      detachedFrom.push(String(workspace.id))
    } catch (error) {
      report.failures.push({ step: 'detach', error: messageOf(error) })
    }
  }
  report.detachedFrom = detachedFrom

  /* 回读确认：别的账上不该再留着它（留着就是侧边栏重复显示的根） */
  try {
    const stillAttached = []
    for (const workspace of registry.list()) {
      if (workspace.id === target.id) continue
      let ids
      try {
        ids = workspace.sessionIds
      } catch {
        ids = undefined
      }
      if (Array.isArray(ids) && ids.includes(sessionId)) stillAttached.push(String(workspace.id))
    }
    if (stillAttached.length > 0) {
      report.failures.push({ step: 'detach-verify', error: `still accounted by workspace(s) ${stillAttached.join(', ')}` })
    }
  } catch {
    /* 回读本身失败不影响搬迁结果 */
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
 * 读 Loader 的插件条目状态（只读）。
 *
 * 排查「某个包为什么没挂上」时这是最直接的证据：桌面版里连 DSH 自己的「新建工作区」都报
 * `active Service "workspaceController" is unavailable`，而 App 的日志目录是空的。
 * Loader 的服务名就是 `loader`，`ctx.loader.entries()` 能拿到每个条目的
 * `options.id` / `options.name` / `options.disabled` 与 `fiber.state`
 * （Cordis 里 2 = active，其余为 pending / loading / failed / disposed）。
 * @param ctx - Host root context.
 * @returns {{available: boolean, error?: string, rows: object[]}}
 */
function loaderRows(ctx) {
  const loader = resolveHostService(ctx, ['loader'], (value) => typeof value.entries === 'function').service
  if (loader === undefined) return { available: false, rows: [] }
  const rows = []
  try {
    for (const entry of loader.entries()) {
      const options = entry !== null && entry !== undefined && entry.options !== undefined ? entry.options : {}
      const fiber = entry !== null && entry !== undefined ? entry.fiber : undefined
      const failure = fiber !== undefined && fiber !== null ? fiber.error : undefined
      rows.push({
        id: options.id === undefined || options.id === null ? undefined : String(options.id),
        name: options.name === undefined || options.name === null ? undefined : String(options.name),
        state: fiber === undefined || fiber === null || fiber.state === undefined ? undefined : Number(fiber.state),
        disabled: options.disabled === true,
        error: failure === undefined || failure === null ? undefined : String(failure.message !== undefined ? failure.message : failure).slice(0, 300),
      })
    }
  } catch (error) {
    return { available: true, rows, error: messageOf(error) }
  }
  return { available: true, rows }
}

/**
 * 报告「这个组合里哪些能力真的可用」。
 *
 * 存在的理由很实际：同一个插件在 web profile 上「更换工作区」能用，在桌面版上却报
 * `the workspace registry is unavailable in this composition` —— 因为 Cordis 4 的
 * `ctx.get(name)` 默认 strict（只认提供者当前 active 的实现），而且服务可能被隔在别的 isolate
 * 作用域里。光看客户端的报错根本判断不出是哪一层的问题，所以给一条专门的探测路由：
 * 它把每个服务的解析结果、命中的来源、注册表里的工作区清单、以及 Loader 里没起来的插件条目
 * 都吐出来。只读，不改任何状态。
 * @param ctx - Host root context.
 * @param config - plugin config.
 */
async function capabilitiesReport(ctx, config) {
  const found = resolveWorkspaceRegistry(ctx)
  const services = {}
  for (const name of ['sessions', 'sessionPersistence', 'sessionController', 'webServer', 'sessionLogDownload', 'typert']) {
    const found = resolveHostService(ctx, [name])
    services[name] = found.service === undefined ? 'unavailable' : `available (${found.source})`
  }

  let workspaces = []
  if (found.registry !== undefined) {
    try {
      workspaces = found.registry.list().map((workspace) => ({
        id: String(workspace.id),
        title: String(workspace.title),
        path: pathText(workspace.path),
        sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : undefined,
      }))
    } catch (error) {
      workspaces = [{ error: messageOf(error) }]
    }
  }

  /*
   * Loader 里的插件条目：只挑「没起来」或与 workspace 有关的，
   * 否则串太长。这一节就是回答「为什么这个服务不在」的直接证据。
   */
  const loader = loaderRows(ctx)
  const interesting = loader.rows.filter((row) => row.state !== 2
    || (row.id !== undefined && /workspace/i.test(row.id))
    || (row.name !== undefined && /workspace/i.test(row.name)))

  return {
    ok: true,
    sessionsRoot: sessionsRoot(ctx, config),
    attachmentsRoot: attachmentsRoot(ctx, config),
    workspaceRegistry: { available: found.registry !== undefined, source: found.source, workspaces },
    workspaceCreate: found.registry !== undefined && typeof found.registry.create === 'function',
    services,
    plugins: { available: loader.available, error: loader.error, total: loader.rows.length, interesting },
    routes: ['delete', 'export', 'import', 'reveal', 'move', 'capabilities'],
  }
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
    { path: '/conversation-delete/move', run: (body) => moveConversation(ctx, config, body.sessionId, body.workspaceId, body.path), okStatus: 200, failStatus: 409 },
    { path: '/conversation-delete/capabilities', run: () => capabilitiesReport(ctx, config), okStatus: 200, failStatus: 409 },
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
