/**
 * dsh-plugin-conversation-delete — 会话归档格式层（纯函数，无 Cordis 依赖）。
 *
 * 这里放三件事，都是「读/写别人的文件格式」，所以单独成文件、单独可测：
 *
 *  1. **会话磁盘artifact**：`session.v4.jsonl.zstd`。
 *     它不是「一个 zstd 文件」，而是**一串可独立解码、各自带校验和的 zstd 帧**拼起来的容器：
 *       帧1 = 恰好一行头记录（JSON）
 *       帧2..N = 若干行事件记录（JSONL）
 *     Node 的公开 zstd API 只会解出**第一帧**就停下（多帧容器它不认），所以必须自己按帧切分：
 *     先按帧结构算出每帧的字节范围，再逐帧 zstdDecompressSync。
 *     切帧算法移植自 `@deepseek-ai/dsh-session-persistence-jsonl` 的 scanZstdFrames。
 *
 *  2. **ZIP 读取**：DSH 自带的「下载会话日志」导出的是 ZIP（fflate 生成），
 *     根条目 `session.v4.jsonl` 是规范 JSONL。要能把导出的对话导回来，就得读 ZIP。
 *     只实现需要的部分：EOCD → 中央目录 → 本地头 → stored/deflate 解压。
 *
 *  3. **JSONL 解析**：把规范 JSONL 文本拆成「头 + 事件文本」。
 *
 * 不依赖任何第三方包，只用 node:zlib。
 *
 * @module dsh-plugin-conversation-delete/format
 */
import { deflateRawSync, inflateRawSync, zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'

/** Zstandard 帧魔数（小端读出的 uint32 值）。 */
export const ZSTD_MAGIC = 4247762216
/** 会话日志头记录的类型标记。 */
export const SESSION_HEADER_TYPE = 'session'
/** 当前会话日志格式版本（文件名与头记录里的 version 都用它）。 */
export const SESSION_FORMAT_VERSION = 4
/** 会话 artifact 的文件名（= `session.v${version}.jsonl.zstd`）。 */
export const SESSION_LOG_FILENAME = `session.v${String(SESSION_FORMAT_VERSION)}.jsonl.zstd`
/** 导出 ZIP 里根会话日志的条目名。 */
export const SESSION_LOG_ENTRY = `session.v${String(SESSION_FORMAT_VERSION)}.jsonl`
/** 每帧都带校验和 —— 后端的扫描器按帧头里的校验和标志计算帧长，少了它整份文件会被判为损坏。 */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** 一个错误类型，便于调用方区分「格式不对」和「磁盘出错」。 */
export class ConversationFormatError extends Error {
  /**
   * @param message - 面向用户的说明
   * @param detail - 可选的机读细节
   */
  constructor(message, detail) {
    super(message)
    this.name = 'ConversationFormatError'
    this.detail = detail
  }
}

/* ------------------------------------------------------------------ zstd 帧 */

/**
 * 按帧结构切分一个「拼接帧」缓冲，不解压其内容。
 *
 * 移植自后端 scanZstdFrames：解析每帧的帧头（描述符、字典 id、内容长度）+ 逐块走完
 * 块头（3 字节小端：最后一块标志 / 块类型 / 块长度），最后按校验和标志多算 4 字节。
 * 比「扫魔数」可靠：压缩数据里刚好出现魔数也不会被误判成帧边界。
 *
 * @param buffer - 会话 artifact 的全部字节
 * @param maxFrames - 最多切几帧
 * @returns 完整帧的 [start,end) 列表；末尾帧不完整时同时给出 tornStart
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new ConversationFormatError(`corrupt session log: invalid frame magic at byte ${String(offset)}`, { offset })
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new ConversationFormatError(`corrupt session log: reserved frame-header bit at byte ${String(offset - 1)}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new ConversationFormatError(`corrupt session log: reserved block type at byte ${String(offset - 3)}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** 压缩一帧（带校验和），用于写会话 artifact。 */
function compressFrame(input) {
  return zstdCompressSync(input, CHECKSUM_OPTIONS)
}

/**
 * 解出会话 artifact 的头记录与事件文本。
 *
 * @param buffer - `session.v4.jsonl.zstd` 的全部字节
 * @returns header / eventsText / 帧数；末帧损坏时 droppedTornTail 为 true
 */
export function parseArtifact(buffer) {
  const { frames } = scanZstdFrames(buffer)
  if (frames.length === 0) {
    // 没有完整帧：可能是崩溃留下的截断文件，也可能是根本不是这个格式
    throw new ConversationFormatError('not a session log: no complete Zstandard frame found')
  }
  const first = buffer.subarray(frames[0].start, frames[0].end)
  let headerText
  try {
    headerText = zstdDecompressSync(first).toString('utf8')
  } catch (error) {
    throw new ConversationFormatError('not a session log: the first frame failed to decompress', { cause: String(error) })
  }
  if (headerText.length === 0 || headerText.indexOf('\n') !== headerText.length - 1) {
    throw new ConversationFormatError('corrupt session log: the first frame is not exactly one header line')
  }
  let header
  try {
    header = JSON.parse(headerText)
  } catch (error) {
    throw new ConversationFormatError('corrupt session log: the header line is not JSON', { cause: String(error) })
  }

  let droppedTornTail = false
  const parts = []
  for (let index = 1; index < frames.length; index += 1) {
    const frame = buffer.subarray(frames[index].start, frames[index].end)
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'))
    } catch (error) {
      if (index === frames.length - 1) {
        /* 末帧解不开 = 崩溃留下的尾巴，按后端的恢复语义丢弃它，其余照常导入 */
        droppedTornTail = true
        break
      }
      throw new ConversationFormatError(`corrupt session log: frame ${String(index)} failed to decompress`, { cause: String(error) })
    }
  }
  const eventsText = parts.join('')
  if (eventsText.length > 0 && !eventsText.endsWith('\n')) {
    throw new ConversationFormatError('corrupt session log: an event frame does not end with a newline')
  }
  return { header, eventsText, frameCount: frames.length, droppedTornTail }
}

/**
 * 把头记录与事件文本编码成会话 artifact（两帧：头一帧，事件一帧）。
 * @param header - 头记录对象
 * @param eventsText - 事件文本（可空；非空时必须以换行结尾）
 * @returns 完整文件字节
 */
export function buildArtifact(header, eventsText) {
  if (eventsText !== '' && !eventsText.endsWith('\n')) {
    throw new ConversationFormatError('refusing to encode events that do not end with a newline')
  }
  const head = compressFrame(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))
  if (eventsText === '') return head
  return Buffer.concat([head, compressFrame(Buffer.from(eventsText, 'utf8'))])
}

/* --------------------------------------------------------------------- JSONL */

/**
 * 把规范 JSONL 文本拆成头记录与事件文本。导出 ZIP 里的 `session.v4.jsonl` 就是这种文本。
 * @param text - 规范 JSONL
 * @returns header 与 eventsText
 */
export function parseJsonlText(text) {
  const trimmed = text.startsWith('\uFEFF') ? text.slice(1) : text
  const lines = trimmed.split('\n')
  let index = 0
  while (index < lines.length && lines[index].trim() === '') index += 1
  if (index >= lines.length) throw new ConversationFormatError('empty conversation file')
  let header
  try {
    header = JSON.parse(lines[index])
  } catch (error) {
    throw new ConversationFormatError('the first line is not a JSON header', { cause: String(error) })
  }
  const events = lines.slice(index + 1).filter((line) => line.trim() !== '')
  const eventsText = events.length === 0 ? '' : `${events.join('\n')}\n`
  return { header, eventsText, lineCount: events.length }
}

/**
 * 串行化回规范 JSONL（与 DSH 自带导出同构），用于「导出」的兜底路径。
 * @param header - 头记录
 * @param eventsText - 事件文本
 * @returns 规范 JSONL 文本
 */
export function serializeJsonlText(header, eventsText) {
  return `${JSON.stringify(header)}\n${eventsText}`
}

/**
 * 校验并规范化一个会话头记录。
 *
 * 导入时做四件事：
 *  - 确认它确实是会话头，并补齐后端**必需**的字段。后端的头校验
 *    （`snapshotSessionFormatHeader`）要求 `version` / `id` / `createdAt` /
 *    `isSeeded` / **`delegationDepth`** 全都在，少一个整份日志就会被当成读不出来，
 *    会话也就永远不会出现在列表里 —— `delegationDepth` 尤其容易漏，它虽然叫“深度”却是必填。
 *  - 保证 `cwd` 存在（没有 cwd 的记录会被会话列表跳过）。
 *  - 切断血缘：`parentSession` / `origin` 去掉，`delegationDepth` 归 0，
 *    于是导入的对话是一条正常的顶层对话，而不是挂在别人下面的子代理记录。
 *  - 保留 `agentPreset`（恢复这条对话时还能用同一个预设）。
 *
 * @param raw - 文件里的头记录
 * @returns 规范化后的头记录
 */
export function normalizeHeader(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConversationFormatError('the header is not a JSON object')
  }
  if (raw.type !== SESSION_HEADER_TYPE) {
    throw new ConversationFormatError(`not a session log: header type is ${JSON.stringify(raw.type)}`)
  }
  if (typeof raw.id !== 'string' || raw.id === '') {
    throw new ConversationFormatError('the header has no session id')
  }
  if (typeof raw.cwd !== 'string' || raw.cwd === '') {
    /* 会话列表会跳过没有 cwd 的记录，导入了也看不见 —— 直接拒绝比留个隐形会话好 */
    throw new ConversationFormatError('the header has no working directory (cwd); this conversation would never appear in the list')
  }
  const header = { ...raw }
  header.type = SESSION_HEADER_TYPE
  header.version = typeof header.version === 'number' ? header.version : SESSION_FORMAT_VERSION
  header.id = raw.id
  const createdAt = typeof header.createdAt === 'number' && Number.isFinite(header.createdAt) ? header.createdAt : Date.now()
  header.createdAt = createdAt
  header.isSeeded = header.isSeeded === true
  /* 必填：后端的头校验要求它是一个计数 */
  header.delegationDepth = 0
  /* 切断血缘：导入的对话是一条独立的顶层对话 */
  delete header.parentSession
  delete header.origin
  return header
}

/* --------------------------------------------------------------- 更换工作区 */

/**
 * 把一条已经存在的会话头记录改挂到另一个工作目录（cwd）。
 *
 * 为什么必须真改 cwd：**工作区归属就是由 cwd 定义的**。`Workspace` 的契约写着
 * 「隶属关系要求 id 在该工作区的账户里，**且会话头的 canonical cwd 等于工作区路径**」，
 * 而且 `attachSession()` 对 cwd 不匹配的会话会直接拒绝、`sessionIds` 的读取视图也会把
 * cwd 不匹配的行过滤掉。所以「换工作区」不是改记账，而是真的改写 cwd
 * （并把日志挪到新 cwd 对应的项目目录下，见 Host 半的 moveConversation）。
 *
 * 与导入用的 {@link normalizeHeader} **故意不同**：这里保留血缘
 * （`parentSession` / `origin` / `delegationDepth`），因为它只是搬家，不是变成一条新对话。
 * 但仍然补齐后端要求的必填字段（`delegationDepth` 少了整份日志会被判读不出来）。
 *
 * @param raw - 磁盘上读出来的头记录
 * @param cwd - 目标工作区的绝对路径
 * @returns 改挂后的头记录（id 不变）
 */
export function retargetHeader(raw, cwd) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConversationFormatError('the header is not a JSON object')
  }
  if (raw.type !== SESSION_HEADER_TYPE) {
    throw new ConversationFormatError(`not a session log: header type is ${JSON.stringify(raw.type)}`)
  }
  if (typeof raw.id !== 'string' || raw.id === '') {
    throw new ConversationFormatError('the header has no session id')
  }
  if (typeof cwd !== 'string' || cwd === '') {
    throw new ConversationFormatError('a target workspace path is required')
  }
  const header = { ...raw, cwd }
  header.type = SESSION_HEADER_TYPE
  header.version = typeof header.version === 'number' ? header.version : SESSION_FORMAT_VERSION
  header.createdAt = typeof header.createdAt === 'number' && Number.isFinite(header.createdAt) ? header.createdAt : Date.now()
  header.isSeeded = header.isSeeded === true
  header.delegationDepth = typeof header.delegationDepth === 'number' ? header.delegationDepth : 0
  return header
}

/* ----------------------------------------------------------------------- ZIP */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50

/** 手写 CRC-32（IEEE），避免依赖只在较新 Node 才有的 zlib.crc32。 */
function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index]
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 读取一个 ZIP，返回「条目名 → 内容」。
 *
 * 只做需要的部分：从文件尾找 EOCD，走中央目录（中央目录里的长度永远是准的，
 * 所以即使流式 ZIP 在本地头里把长度写成 0、真值放在数据描述符里也没问题），
 * 再按本地头定位数据，stored 直接用、deflate 用 inflateRawSync。
 *
 * @param buffer - ZIP 字节
 * @returns 条目 Map（保序），以及是否含 ZIP64 记录
 */
export function readZip(buffer) {
  /* 从尾部往前找 EOCD（注释最长 64KiB） */
  const lowest = Math.max(0, buffer.length - 65557)
  let eocd = -1
  for (let index = buffer.length - 22; index >= lowest; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new ConversationFormatError('not a ZIP archive: no end-of-central-directory record found')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new ConversationFormatError('ZIP64 archives are not supported by this build')
  }
  if (buffer.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    throw new ConversationFormatError('ZIP64 archives are not supported by this build')
  }
  if (centralOffset + centralSize > buffer.length) throw new ConversationFormatError('corrupt ZIP: central directory is out of range')

  const entries = new Map()
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length) throw new ConversationFormatError('corrupt ZIP: truncated central directory')
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new ConversationFormatError(`corrupt ZIP: bad central directory entry at byte ${String(offset)}`)
    const method = buffer.readUInt16LE(offset + 10)
    const expectedCrc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength

    const isDirectory = name.endsWith('/')
    if (isDirectory) continue

    if (localOffset + 30 > buffer.length) throw new ConversationFormatError(`corrupt ZIP: entry ${JSON.stringify(name)} has an out-of-range local header`)
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new ConversationFormatError(`corrupt ZIP: entry ${JSON.stringify(name)} has a bad local header`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > buffer.length) throw new ConversationFormatError(`corrupt ZIP: entry ${JSON.stringify(name)} is truncated`)
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)

    let content
    if (method === 0) content = Buffer.from(raw)
    else if (method === 8) {
      try {
        content = inflateRawSync(raw)
      } catch (error) {
        throw new ConversationFormatError(`corrupt ZIP: entry ${JSON.stringify(name)} failed to inflate`, { cause: String(error) })
      }
    } else throw new ConversationFormatError(`unsupported ZIP compression method ${String(method)} for ${JSON.stringify(name)}`)

    if (content.length !== uncompressedSize) {
      throw new ConversationFormatError(`corrupt ZIP: entry ${JSON.stringify(name)} has the wrong uncompressed size`)
    }
    if (crc32(content) !== expectedCrc) {
      throw new ConversationFormatError(`corrupt ZIP: entry ${JSON.stringify(name)} failed its CRC check`)
    }
    entries.set(name, content)
  }
  return { entries }
}

/**
 * 为一个「导入」输入自动识别格式并取出会话头与事件文本。
 *
 * 接受三种输入：
 *  - DSH 自带导出的 ZIP（根条目 `session.v4.jsonl`）
 *  - 规范 JSONL 文本（导出 ZIP 里的那个条目本身）
 *  - 本插件导出的会话 artifact（`session.v4.jsonl.zstd`，多帧 zstd）
 *
 * @param buffer - 上传的字节
 * @returns header / eventsText / 识别出的格式 / 附带的附件与子代理条目名（ZIP 时还带 entries）
 */
export function readConversationFile(buffer) {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    const { entries } = readZip(buffer)
    const rootEntry = entries.get(SESSION_LOG_ENTRY) ?? entries.get('session.jsonl')
    if (rootEntry === undefined) {
      throw new ConversationFormatError(`the ZIP has no ${SESSION_LOG_ENTRY} entry (looked for the conversation root log)`)
    }
    const parsed = parseJsonlText(rootEntry.toString('utf8'))
    const extras = [...entries.keys()].filter((name) => name !== SESSION_LOG_ENTRY && name !== 'session.jsonl')
    return { ...parsed, kind: 'zip', extras, entries }
  }
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC) {
    const parsed = parseArtifact(buffer)
    return { ...parsed, kind: 'artifact', extras: [] }
  }
  /* 剩下的按规范 JSONL 文本处理（导出 ZIP 里的那个条目、或手工整理的文本） */
  const parsed = parseJsonlText(buffer.toString('utf8'))
  return { ...parsed, kind: 'jsonl', extras: [] }
}

/* ------------------------------------------------------------------ 附件还原 */

/** ZIP 里 `media/<id>.<ext>` 的条目名 → 附件对象的存储 id。 */
export function mediaEntryId(name) {
  const match = /^media\/([^/]+)\.[A-Za-z0-9]+$/u.exec(name)
  return match === null ? undefined : match[1]
}

/** ZIP 里 `files/<xx>/<digest>/<name>` 的条目名 → 存储 id 与叶子名。 */
export function fileEntryId(name) {
  const match = /^files\/([0-9a-f]{2})\/([0-9a-f]+)\/(.+)$/u.exec(name)
  if (match === null) return undefined
  return { prefix: match[1], digest: match[2], leaf: match[3] }
}

/** `sha256:<hex>` 或裸 hex 都归一成裸 hex。 */
export function bareDigest(id) {
  return String(id).replace(/^sha256:/u, '')
}
