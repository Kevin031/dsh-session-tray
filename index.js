/**
 * 会话托盘宿主半边。
 *
 * 页面把侧边栏同一份状态推到本进程；Electron 助手不访问 DSH WebServer
 * （桌面闸门会对插件子进程的裸 HTTP 返回 403），只访问这里的 127.0.0.1 端口。
 * 助手点击后写入待打开会话，页面再调用 uiWorkspace.openSession。
 */
import { createRuntimeManager, validTaskDoneDuration } from './runtime-manager.js'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE = '/dsh-session-tray'
const STALE_MS = 20_000
const BODY_LIMIT = 65_536
const packageRoot = dirname(fileURLToPath(import.meta.url))

/** @type {readonly string[]} */
export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const state = {
    rows: /** @type {TrayRow[]} */ ([]),
    updatedAt: 0,
    pending: /** @type {string | null} */ (null),
  }
  const token = randomBytes(24).toString('hex')
  /** @type {ReturnType<typeof createRuntimeManager> | undefined} */
  let manager
  const bridge = createBridge(state, token, () => manager)
  let stopping = false

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => handlePage(req, res, state, manager),
  }), 'dsh-session-tray: page routes')

  ctx.inject(['tools'], (scope) => scope.effect(() => scope.tools.register({
    name: 'session_tray_manage',
    description: '查看 Windows 桌面状态栏状态，或按用户要求安装运行时、启用、停用、重启与重置位置。运行于 DSH 宿主电脑。',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'install', 'enable', 'disable', 'restart', 'reset-position'] } }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      if (!manager) throw new Error('助手管理器尚未就绪')
      return args.action === 'status' ? manager.status() : manager.action(args.action)
    },
  }), 'dsh-session-tray: management tool'))

  ctx.effect(() => {
    const server = bridge.server
    server.listen(0, '127.0.0.1', () => {
      if (stopping) return
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      if (!port) {
        log(ctx, 'warn', 'private bridge did not bind')
        return
      }
      manager = createRuntimeManager({ packageRoot, url: `http://127.0.0.1:${port}`, token, log: (level, message) => log(ctx, level, message) })
    })
    return async () => {
      stopping = true
      server.close()
      await manager?.dispose()
    }
  }, 'dsh-session-tray: helper')
}

/**
 * @typedef {{ id: string, title: string, section: 'running' | 'attention', label: string }} TrayRow
 */

/**
 * @param {object} state
 * @param {TrayRow[]} state.rows
 * @param {number} state.updatedAt
 * @param {string | null} state.pending
 * @param {string} token
 * @param {() => ReturnType<typeof createRuntimeManager> | undefined} getManager
 */
function createBridge(state, token, getManager) {
  const server = createServer((req, res) => {
    if (!authorized(req, token)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname
    if (req.method === 'GET' && path === '/snapshot') {
      sendJson(res, 200, { ...publicSnapshot(state), ui: getManager()?.status().ui ?? {}, previewRevision: getManager()?.notificationPreviewRevision() ?? 0 })
      return
    }
    if (req.method === 'POST' && path === '/ready') {
      readBody(req).then((body) => {
        getManager()?.ready(Number(parseJson(body)?.pid))
        sendJson(res, 200, { ok: true })
      }).catch(() => sendJson(res, 400, { error: 'invalid readiness' }))
      return
    }
    if (req.method === 'POST' && path === '/notify-prefs') {
      readBody(req).then((body) => {
        getManager()?.setNotifyPrefs(parseJson(body) || {})
        sendJson(res, 200, { ok: true })
      }).catch(() => sendJson(res, 400, { error: 'invalid notify prefs' }))
      return
    }
    if (req.method === 'POST' && path === '/open') {
      readBody(req).then((body) => {
        const id = sessionIdOf(parseJson(body)?.sessionId)
        if (!id) {
          sendJson(res, 400, { error: 'invalid session' })
          return
        }
        state.pending = id
        sendJson(res, 200, { ok: true })
      }).catch((error) => sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' }))
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })
  return { server }
}

/**
 * 管理写操作只接受同源 JSON，拒绝表单型跨站请求。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function sameOriginManagement(req) {
  const origin = req.headers.origin
  return String(req.headers['content-type'] || '').startsWith('application/json')
    && req.headers['sec-fetch-site'] !== 'cross-site'
    && (!origin || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`)
}

/**
 * 页面与宿主同域，走 DSH 已有的浏览器闸门，不把私有令牌交给页面。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ rows: TrayRow[], updatedAt: number, pending: string | null }} state
 */
function handlePage(req, res, state, manager) {
  const path = new URL(req.url || '/', 'http://127.0.0.1').pathname
  if (path.startsWith(`${ROUTE}/manage/`)) {
    if (!manager) return sendJson(res, 503, { error: '助手管理器尚未就绪' })
    if (req.method === 'GET' && path === `${ROUTE}/manage/status`) return sendJson(res, 200, manager.status())
    if (req.method === 'POST' && path === `${ROUTE}/manage/preview-notification`) {
      if (!sameOriginManagement(req)) return sendJson(res, 403, { error: '管理操作必须来自同源设置页面' })
      readBody(req).then(() => {
        sendJson(res, 200, manager.previewNotification())
      }).catch((error) => sendJson(res, 400, { error: error.message }))
      return
    }
    if (req.method === 'POST' && path === `${ROUTE}/manage/notify-prefs`) {
      if (!sameOriginManagement(req)) return sendJson(res, 403, { error: '管理操作必须来自同源设置页面' })
      readBody(req).then((body) => {
        const prefs = parseJson(body) || {}
        if (typeof prefs.minimizedToTray !== 'boolean' && typeof prefs.notifyConversation !== 'boolean' && typeof prefs.notifyTaskDone !== 'boolean' && !validTaskDoneDuration(prefs.taskDoneDurationSeconds) && !['dock', 'corner'].includes(prefs.notificationPlacement)) return sendJson(res, 400, { error: '无效通知设置' })
        sendJson(res, 200, manager.setNotifyPrefs(prefs))
      }).catch((error) => sendJson(res, 400, { error: error.message }))
      return
    }
    if (req.method === 'POST' && path === `${ROUTE}/manage/action`) {
      // 管理操作只接受同源 JSON，拒绝表单型跨站请求。
      if (!sameOriginManagement(req)) return sendJson(res, 403, { error: '管理操作必须来自同源设置页面' })
      readBody(req).then(async (body) => {
        const action = parseJson(body)?.action
        if (!['install', 'enable', 'disable', 'restart', 'reset-position'].includes(action)) return sendJson(res, 400, { error: '无效操作' })
        sendJson(res, 200, await manager.action(action))
      }).catch((error) => sendJson(res, 400, { error: error.message }))
      return
    }
    return sendJson(res, 404, { error: 'not found' })
  }
  if (req.method === 'POST' && path === `${ROUTE}/snapshot`) {
    readBody(req).then((body) => {
      const rows = sanitizeRows(parseJson(body)?.rows)
      state.rows = rows
      state.updatedAt = Date.now()
      sendJson(res, 200, { ok: true, count: rows.length })
    }).catch((error) => sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' }))
    return
  }
  if (req.method === 'GET' && path === `${ROUTE}/pending`) {
    sendJson(res, 200, { sessionId: state.pending })
    return
  }
  if (req.method === 'GET' && path === `${ROUTE}/health`) {
    sendJson(res, 200, { count: state.rows.length, updatedAt: state.updatedAt, pending: state.pending !== null })
    return
  }
  if (req.method === 'POST' && path === `${ROUTE}/ack`) {
    readBody(req).then((body) => {
      const id = sessionIdOf(parseJson(body)?.sessionId)
      if (id && id === state.pending) state.pending = null
      sendJson(res, 200, { ok: true })
    }).catch((error) => sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' }))
    return
  }
  sendJson(res, 404, { error: 'not found' })
}

/**
 * @param {{ rows: TrayRow[], updatedAt: number }} state
 */
function publicSnapshot(state) {
  const stale = state.updatedAt === 0 || Date.now() - state.updatedAt > STALE_MS
  return { stale, rows: stale ? [] : state.rows, updatedAt: state.updatedAt }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} token
 * @returns {boolean}
 */
function authorized(req, token) {
  const header = req.headers.authorization
  return header === `Bearer ${token}`
}

/**
 * @param {unknown} value
 * @returns {TrayRow[]}
 */
function sanitizeRows(value) {
  if (!Array.isArray(value)) return []
  /** @type {TrayRow[]} */
  const rows = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const id = sessionIdOf(/** @type {{ id?: unknown }} */ (item).id)
    const section = /** @type {{ section?: unknown }} */ (item).section
    if (!id || (section !== 'running' && section !== 'attention')) continue
    const updatedAt = Number(/** @type {{ updatedAt?: unknown }} */ (item).updatedAt)
    const percent = Number(/** @type {{ contextPercent?: unknown }} */ (item).contextPercent)
    const usedTokens = Number(/** @type {{ usedTokens?: unknown }} */ (item).usedTokens)
    const contextWindow = Number(/** @type {{ contextWindow?: unknown }} */ (item).contextWindow)
    rows.push({
      id,
      section,
      title: clip(String(/** @type {{ title?: unknown }} */ (item).title || '未命名会话'), 60),
      label: clip(String(/** @type {{ label?: unknown }} */ (item).label || ''), 12),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      ...(typeof item.responsePreview === 'string' ? { responsePreview: item.responsePreview.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 240) } : {}),
      ...(Number.isInteger(percent) && percent >= 0 && percent <= 100
        && Number.isFinite(usedTokens) && Number.isFinite(contextWindow) && contextWindow > 0
        ? { contextPercent: percent, usedTokens, contextWindow }
        : {}),
    })
    if (rows.length >= 24) break
  }
  return rows
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sessionIdOf(value) {
  const id = String(value ?? '')
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? id : ''
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clip(text, max) {
  const clean = text.replace(/[\u0000-\u001f]/g, ' ').trim()
  const points = Array.from(clean)
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : points.join('')
}

/**
 * @param {string} text
 * @returns {any}
 */
function parseJson(text) {
  if (!text) return null
  return JSON.parse(text)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {'info' | 'warn'} level
 * @param {string} message
 */
function log(ctx, level, message) {
  const line = `[dsh-session-tray] ${message}`
  const logger = /** @type {{ info?: Function, warn?: Function } | undefined} */ (ctx.logger)
  if (level === 'warn') logger?.warn?.(line)
  else logger?.info?.(line)
  if (!logger) console[level === 'warn' ? 'warn' : 'info'](line)
}
