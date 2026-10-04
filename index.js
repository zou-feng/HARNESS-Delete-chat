/**
 * dsh-plugin-conversation-delete — Host half.
 *
 * Adds a "删除对话 / Delete conversation" row to the Session row's "..." menu and,
 * on confirmation, removes the conversation for good:
 *
 *   1. a live Agent for that Session is asked to stop (through the Workspace
 *      registry's archive admission events) so nothing keeps writing;
 *   2. the Client is told the Session is gone (`api-session/removed`, the same
 *      forwarded event the Session controller raises on disposal) so the sidebar
 *      row disappears immediately;
 *   3. the Session's own on-disk artifact directory is deleted —
 *      `<sessionsRoot>/<projectDir>/<sessionId>/` (one directory per Session,
 *      holding its `session.v4.jsonl.zstd` log). Nothing outside that directory
 *      is touched: the project's own working-directory files stay untouched.
 *
 * HTTP surface (same-origin, served by the Host's own web carrier):
 *   POST /conversation-delete/delete   { sessionId }  -> JSON report
 *
 * The browser half never deletes anything itself; it only calls this route.
 *
 * @module dsh-plugin-conversation-delete
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

export const name = 'conversation-delete'

/** Services this plugin parks on while they are absent. */
export const inject = ['webServer']

/** A Session id is one path segment; refuse anything that could escape a directory. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** How long the Host waits for a stopped Session to leave the live store. */
const DEFAULT_SETTLE_MS = 2500

/** Resolve the Session artifact root: plugin config, the live backend, then `$DSH_HOME`. */
function sessionsRoot(ctx, config) {
  const configured = config === null || typeof config !== 'object' ? undefined : config.sessionsRoot
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  const backend = ctx.get('sessionPersistence')
  const backendRoot = backend === null || backend === undefined ? undefined : backend.config?.root
  if (typeof backendRoot === 'string' && backendRoot.trim() !== '') return resolve(backendRoot.trim())
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return join(resolve(home.trim()), 'sessions')
  return join(homedir(), '.dsh', 'sessions')
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

/** Read one JSON request body with a hard cap; a malformed or oversized body is a caller error. */
async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
  return parsed
}

/**
 * Delete one conversation: stop its work, drop it from the Client catalogue, and
 * remove its own Session directory. Every step is reported, and a failure in one
 * step never hides the others.
 * @param ctx - Host context carrying the live Session store and Workspace registry.
 * @param config - plugin config; `sessionsRoot` overrides the artifact root.
 * @param sessionId - the Session to delete.
 * @returns a JSON-serializable report.
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
   *    the rest of the process (the Host drops the AgentHandle that could
   *    dispose it), and the catalogue lists live Sessions unconditionally. The
   *    archive entry is therefore what keeps a deleted conversation out of the
   *    sidebar in that case, so it is NOT lifted again afterwards.
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
    const backend = ctx.get('sessionPersistence')
    if (backend !== undefined && typeof backend.locate === 'function' && typeof backend.stat === 'function') {
      try {
        const snapshot = await backend.stat(sessionId)
        const header = snapshot === undefined ? undefined : snapshot.header
        const located = header === undefined ? undefined : backend.locate(header)
        if (located !== undefined && typeof located.path === 'string') candidates.push(dirname(resolve(located.path)))
      } catch (error) {
        report.failures.push({ step: 'locate', error: messageOf(error) })
      }
    }
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

/**
 * Register the deletion route once the web carrier exists.
 * @param ctx - Host root context.
 * @param config - plugin config.
 */
export function apply(ctx, config) {
  const routes = [
    {
      kind: 'exact',
      path: '/conversation-delete/delete',
      handler: (req, res) => {
        const send = (status, body) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(body))
        }
        if (req.method !== 'POST') {
          send(405, { ok: false, error: 'POST required' })
          return
        }
        readJsonBody(req).then(
          (body) => deleteConversation(ctx, config, body.sessionId).then(
            (report) => send(report.ok ? 200 : 409, report),
            (error) => send(500, { ok: false, error: messageOf(error) }),
          ),
          (error) => send(400, { ok: false, error: messageOf(error) }),
        )
      },
    },
  ]

  const register = (injected) => {
    const server = injected !== undefined ? injected : ctx.get('webServer')
    if (server === undefined) {
      console.error('conversation-delete: webServer never appeared; the delete route is unavailable')
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
