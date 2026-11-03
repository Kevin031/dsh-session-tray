'use strict'

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } = require('electron')
const { trayPlatform } = require('./tray-platform.cjs')

const bridgeUrl = process.env.DSH_SESSION_TRAY_URL || ''
const token = process.env.DSH_SESSION_TRAY_TOKEN || ''
const configPath = process.env.DSH_SESSION_TRAY_CONFIG_PATH || path.join(os.homedir(), '.dsh', 'dsh-session-tray', 'widget.json')
// 与其他 Electron 插件隔离缓存，避免共享默认 Electron 用户目录产生文件锁。
if (typeof app.setPath === 'function') app.setPath('userData', path.join(path.dirname(configPath), 'electron-data'))

if (!bridgeUrl || !token) {
  console.error('[dsh-session-tray] missing bridge env')
  process.exit(1)
}

/** @type {BrowserWindow | undefined} */
let dock
let snapshot = { stale: true, rows: [] }
let resetPositionRevision = 0
let lastPreviewRevision = 0

/** 接收设置页发出的定位重置和通知开关，避免与助手写配置竞争。 @param {any} next @returns {void} */
function applyManagement(next) {
  applyHostNotifyPrefs(next?.ui)
  const previewRevision = Number(next?.previewRevision || 0)
  if (Number.isSafeInteger(previewRevision) && previewRevision > lastPreviewRevision) {
    lastPreviewRevision = previewRevision
    previewNotification()
  }
  const revision = Number(next?.ui?.resetPositionRevision || 0)
  if (revision <= resetPositionRevision) return
  resetPositionRevision = revision
  config.x = null
  config.y = null
  config.resetPositionRevision = revision
  saveConfig()
  applyBounds()
  syncNotifications()
}
let expanded = false
let placing = false
const BAR_WIDTH = 300
const BAR_WIDTH_MIN = 200
const BAR_WIDTH_MAX = 720
const BAR_HEIGHT = 28
/** 通知卡片宽度。相对最初 300px 放大 1.3 倍，与通知页字号、间距同一比例。 */
const NOTICE_WIDTH = 390
/** @type {BrowserWindow | undefined} */
let settings
/** @type {BrowserWindow | undefined} */
let notifications
/** @typedef {{ row: any, hidden: boolean, order: number, kind: 'pending' | 'done', expiresAt?: number, preview?: boolean, durationSeconds?: number }} NotificationCycle */
/** @type {Map<string, NotificationCycle>} */
const notificationCycles = new Map()
/** 首帧只记录已有完成项，避免启动时把历史完成全部弹出。 @type {Set<string> | null} */
let knownCompletions = null
/** 校验通知时长，0 表示不自动消失。 @param {unknown} value @returns {value is number} */
function validTaskDoneDuration(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86400
}
/** @type {Map<string, { expiresAt: number, timer: ReturnType<typeof setTimeout> }>} */
const completionTimers = new Map()
let notificationReady = false
let notificationPayload = ''
let notificationContentHeight = 180

/**
 * 同步待确认周期，并在新的已完成会话出现时加入按配置计时的通知（只影响新通知）。断线快照不能结束周期。
 * @param {Map<string, NotificationCycle>} cycles
 * @param {{ stale?: boolean, rows?: any[] } | null} next
 * @param {number} [now]
 * @returns {Map<string, NotificationCycle>}
 */
function reconcileNotificationCycles(cycles, next, now = Date.now()) {
  if (!next || next.stale || !Array.isArray(next.rows)) return cycles
  const pending = new Map(next.rows.filter((row) => row && typeof row.id === 'string' && row.section === 'attention' && row.label !== '已完成').map((row) => [row.id, row]))
  const done = new Map(next.rows.filter((row) => row && typeof row.id === 'string' && row.label === '已完成').map((row) => [row.id, row]))
  let order = Math.max(0, ...Array.from(cycles.values(), (entry) => entry.order))
  for (const id of cycles.keys()) {
    if (cycles.get(id)?.kind === 'done') continue
    if (!pending.has(id)) cycles.delete(id)
  }
  for (const [id, row] of pending) {
    const existing = cycles.get(id)
    if (existing) existing.row = row
    else cycles.set(id, { row, hidden: false, order: ++order, kind: 'pending' })
  }
  if (knownCompletions === null) knownCompletions = new Set(done.keys())
  else {
    const fresh = []
    for (const [id, row] of done) {
      if (knownCompletions.has(id)) {
        const existing = cycles.get(`done:${id}`)
        if (existing) existing.row = row
        continue
      }
      fresh.push(/** @type {[string, any]} */ ([id, row]))
    }
    for (const [id, row] of fresh.reverse()) {
      knownCompletions.add(id)
      if (config.notifyTaskDone === false) continue
      cycles.set(`done:${id}`, { row, hidden: false, order: ++order, kind: 'done', expiresAt: config.taskDoneDurationSeconds === 0 ? undefined : now + config.taskDoneDurationSeconds * 1000, durationSeconds: config.taskDoneDurationSeconds })
    }
    for (const id of knownCompletions) if (!done.has(id)) knownCompletions.delete(id)
  }
  return cycles
}

/**
 * 到期的完成通知不再显示；待确认通知不因时间消失。
 * @param {Map<string, NotificationCycle>} cycles
 * @param {number} [now]
 * @returns {boolean}
 */
function sweepExpiredNotifications(cycles, now = Date.now()) {
  let changed = false
  for (const entry of cycles.values()) {
    if (entry.kind === 'done' && !entry.hidden && Number.isFinite(entry.expiresAt) && /** @type {number} */ (entry.expiresAt) <= now) {
      entry.hidden = true
      changed = true
    }
  }
  return changed
}

/** 按完成时刻计时，窗口尚未就绪时也开始倒数。 */
function armCompletionTimers() {
  for (const [key, entry] of notificationCycles) {
    if (entry.kind !== 'done' || entry.hidden || !Number.isFinite(entry.expiresAt)) continue
    const armed = completionTimers.get(key)
    if (armed && armed.expiresAt === entry.expiresAt) continue
    if (armed) clearTimeout(armed.timer)
    const expiresAt = /** @type {number} */ (entry.expiresAt)
    const timer = setTimeout(() => {
      completionTimers.delete(key)
      const current = notificationCycles.get(key)
      if (!current || current.expiresAt !== expiresAt || current.hidden) return
      current.hidden = true
      syncNotifications()
    }, Math.max(0, expiresAt - Date.now()))
    if (typeof timer.unref === 'function') timer.unref()
    completionTimers.set(key, { expiresAt, timer })
  }
}

/**
 * 返回可显示通知。新通知置顶；完成通知使用独立键，避免覆盖待确认卡片。
 * @param {Map<string, NotificationCycle>} cycles
 * @returns {{ id: string, title: string, label: string, kind: 'pending' | 'done' }[]}
 */
/**
 * 设置关闭时不弹出对应通知。手动收起仍然优先，重新打开开关不会复活已收起的卡片。
 * @param {'pending' | 'done'} kind
 * @returns {boolean}
 */
function notifyEnabled(kind) {
  if (kind === 'done') return config.notifyTaskDone !== false
  return config.notifyConversation !== false
}

function visibleNotifications(cycles) {
  return Array.from(cycles.entries()).filter(([, entry]) => !entry.hidden && (entry.preview || notifyEnabled(entry.kind))).sort((left, right) => right[1].order - left[1].order).map(([id, entry]) => ({
    id,
    title: entry.row.title || '未命名会话',
    sessionId: entry.row.id || id,
    responsePreview: entry.row.responsePreview || '',
    label: entry.kind === 'done' ? '已完成' : (entry.row.label || '待确认'),
    kind: entry.kind,
    durationSeconds: entry.durationSeconds,
  }))
}

/**
 * 右下角和托盘模式固定使用390px常规样式，不受浮窗影响。
 * 浮窗上方模式跟随浮窗宽度，单行用紧凑样式，展开用常规样式。
 * @returns {{ density: 'compact' | 'regular', width: number }}
 */
function notificationLayout() {
  const fixed = config.notificationPlacement === 'corner' || config.minimizedToTray === true
  const compact = !fixed && expanded !== true
  return { density: compact ? 'compact' : 'regular', width: fixed ? NOTICE_WIDTH : currentDockWidth() }
}

/**
 * 优先放在浮窗上方；空间不足时选择下方或侧面，始终夹在工作区内。
 * 宽度与浮条相同时，左右边缘和浮条对齐。
 * @param {Electron.Rectangle} bounds
 * @param {Electron.Rectangle} area
 * @param {number} contentHeight
 * @param {number} [noticeWidth]
 * @returns {Electron.Rectangle}
 */
function notificationBoundsFor(bounds, area, contentHeight, noticeWidth = NOTICE_WIDTH) {
  const gap = 8
  const width = Math.min(noticeWidth, area.width)
  const above = Math.max(0, bounds.y - area.y - gap)
  const below = Math.max(0, area.y + area.height - bounds.y - bounds.height - gap)
  const desired = Math.max(1, Math.ceil(contentHeight))
  let available = above
  let side = 'above'
  if (above < Math.min(desired, 120) && below > above) { available = below; side = 'below' }
  let x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))
  if (available < Math.min(desired, 120)) {
    const right = area.x + area.width - bounds.x - bounds.width - gap
    const left = bounds.x - area.x - gap
    if (right >= width || left >= width) {
      x = right >= width ? bounds.x + bounds.width + gap : bounds.x - width - gap
      available = area.height
      side = 'side'
    }
  }
  const height = Math.min(desired, Math.max(1, available), area.height)
  const y = side === 'above' ? bounds.y - gap - height : side === 'below' ? bounds.y + bounds.height + gap : bounds.y
  if (side !== 'side' && width === bounds.width) x = bounds.x
  return { x: Math.round(x), y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))), width, height }
}

/** 右下角通知与工作区右缘留 4px，比原位置向右移动 12px。 */
const CORNER_MARGIN_X = 4
/** 保留通知栈顶部安全间距，不随水平位置调整而改变。 */
const CORNER_MARGIN_TOP = 16
/** 通知与工作区底边的间距。工作区已经避开任务栏，这里只留一点缝。 */
const CORNER_MARGIN_BOTTOM = 4

/**
 * 通知固定在给定工作区右下角，不跟随悬浮框位置。
 * @param {Electron.Rectangle} area
 * @param {number} contentHeight
 * @param {number} [noticeWidth]
 * @returns {Electron.Rectangle}
 */
function cornerNotificationBounds(area, contentHeight, noticeWidth = NOTICE_WIDTH) {
  const marginX = CORNER_MARGIN_X
  const marginBottom = CORNER_MARGIN_BOTTOM
  const width = Math.min(noticeWidth, Math.max(1, area.width - marginX * 2))
  const height = Math.min(Math.max(1, Math.ceil(contentHeight)), Math.max(1, area.height - marginBottom - CORNER_MARGIN_TOP))
  return {
    x: Math.round(Math.max(area.x, area.x + area.width - width - marginX)),
    y: Math.round(Math.max(area.y, area.y + area.height - height - marginBottom)),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/**
 * 浮窗模式优先上方，右下角及托盘模式固定在给定工作区右下角。
 * @param {'dock' | 'tray'} mode
 * @param {Electron.Rectangle | null} dockBounds
 * @param {Electron.Rectangle} area
 * @param {number} contentHeight
 * @param {number} [noticeWidth]
 * @returns {Electron.Rectangle}
 */
function notificationWindowBounds(mode, dockBounds, area, contentHeight, noticeWidth = NOTICE_WIDTH) {
  return mode === 'dock' && dockBounds
    ? notificationBoundsFor(dockBounds, area, contentHeight, noticeWidth)
    : cornerNotificationBounds(area, contentHeight, noticeWidth)
}

/** 右下角固定在主屏幕，浮窗模式跟随所在屏幕；不改变焦点。 */
function positionNotifications() {
  if (!notifications || notifications.isDestroyed()) return
  const fixed = config.notificationPlacement === 'corner' || config.minimizedToTray === true
  const bounds = !fixed && dock && !dock.isDestroyed() ? dock.getBounds() : null
  const area = bounds ? screen.getDisplayMatching(bounds).workArea : screen.getPrimaryDisplay().workArea
  const layout = notificationLayout()
  notifications.setBounds(notificationWindowBounds(bounds ? 'dock' : 'tray', bounds, area, notificationContentHeight, layout.width))
}

/** 把单行紧凑样式同步到通知页。窗口未就绪时由下次 syncNotifications 补发。 */
function publishNotificationLayout() {
  if (!notifications || notifications.isDestroyed() || !notificationReady) return
  notifications.webContents.send('notification-layout', notificationLayout())
}

/** 创建独立的可滚动通知栈窗口，不抢夺当前应用的焦点。 */
function createNotifications() {
  notifications = new BrowserWindow({
    show: false, frame: false, transparent: true, thickFrame: false, roundedCorners: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, focusable: true,
    width: notificationLayout().width, height: 180,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  notifications.setAlwaysOnTop(true, 'screen-saver')
  notifications.once('ready-to-show', () => {
    notificationReady = true
    notificationPayload = ''
    syncNotifications()
  })
  notifications.on('closed', () => { notifications = undefined; notificationReady = false; notificationPayload = '' })
  void notifications.loadFile(path.join(__dirname, 'notifications.html'))
}

/** 显示独立模拟完成通知；重复点击替换同一条，不影响真实会话。 @returns {{ ok: boolean }} */
function previewNotification() {
  const key = '__preview-completion__'
  const previous = completionTimers.get(key)
  if (previous) { clearTimeout(previous.timer); completionTimers.delete(key) }
  const order = Math.max(0, ...Array.from(notificationCycles.values(), (entry) => entry.order)) + 1
  const seconds = config.taskDoneDurationSeconds
  notificationCycles.set(key, {
    row: { title: '通知预览 · 这是一条模拟任务完成通知' }, hidden: false, kind: 'done', order, preview: true,
    durationSeconds: seconds, expiresAt: seconds === 0 ? undefined : Date.now() + seconds * 1000,
  })
  syncNotifications()
  return { ok: true }
}

/** 仅在可见通知数据改变时发送，保留渲染节点、键盘焦点与动画。 */
function syncNotifications() {
  armCompletionTimers()
  const rows = visibleNotifications(notificationCycles)
  if ((!notifications || notifications.isDestroyed()) && rows.length) createNotifications()
  if (!notifications || notifications.isDestroyed() || !notificationReady) return
  publishNotificationLayout()
  const payload = JSON.stringify(rows)
  if (payload !== notificationPayload) {
    notificationPayload = payload
    notifications.webContents.send('notifications', rows)
  }
  if (!rows.length) { notifications.hide(); return }
  positionNotifications()
  if (!notifications.isVisible()) notifications.showInactive()
}
/** @type {{ x: number | null, y: number | null, width: number | null, expanded: boolean, resetPositionRevision: number, minimizedToTray: boolean, notifyConversation: boolean, notifyTaskDone: boolean, taskDoneDurationSeconds: number, notificationPlacement: 'dock' | 'corner' }} */
let config = loadConfig()
expanded = config.expanded
resetPositionRevision = config.resetPositionRevision
/** @type {Electron.Tray | undefined} */
let tray
// 本地托盘操作尚未回传时不接受旧快照；版本也用于丢弃操作前已在途的快照。
let trayPrefsRevision = 0
let pendingTrayPrefsRevision = 0
let trayPrefsPushInFlight = false

/**
 * @returns {{ x: number | null, y: number | null, width: number | null, expanded: boolean, resetPositionRevision: number, minimizedToTray: boolean, notifyConversation: boolean, notifyTaskDone: boolean, taskDoneDurationSeconds: number, notificationPlacement: 'dock' | 'corner' }}
 */
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return {
      x: Number.isFinite(raw.x) ? raw.x : null,
      y: Number.isFinite(raw.y) ? raw.y : null,
      width: storedBarWidth(raw.width),
      // 显式布尔值优先；兼容旧版本已经保存的卡片形态。
      expanded: typeof raw.expanded === 'boolean' ? raw.expanded : raw.style === 'card',
      resetPositionRevision: Number.isSafeInteger(raw.resetPositionRevision) ? raw.resetPositionRevision : 0,
      minimizedToTray: raw.minimizedToTray === true,
      notifyConversation: raw.notifyConversation !== false,
      notifyTaskDone: raw.notifyTaskDone !== false,
      taskDoneDurationSeconds: validTaskDoneDuration(raw.taskDoneDurationSeconds) ? raw.taskDoneDurationSeconds : 10,
      notificationPlacement: raw.notificationPlacement === 'corner' ? 'corner' : 'dock',
    }
  } catch {
    return { x: null, y: null, width: null, expanded: false, resetPositionRevision: 0, minimizedToTray: false, notifyConversation: true, notifyTaskDone: true, taskDoneDurationSeconds: 10, notificationPlacement: 'dock' }
  }
}

/**
 * 只暴露通知偏好，避免设置页读到窗口坐标。
 * @returns {{ notifyConversation: boolean, notifyTaskDone: boolean, taskDoneDurationSeconds: number, notificationPlacement: 'dock' | 'corner' }}
 */
function notificationPrefs() {
  return { notifyConversation: config.notifyConversation !== false, notifyTaskDone: config.notifyTaskDone !== false, taskDoneDurationSeconds: config.taskDoneDurationSeconds, notificationPlacement: config.notificationPlacement }
}

/**
 * @param {unknown} prefs
 * @returns {void}
 */
function applyNotificationPrefs(prefs) {
  const next = /** @type {{ notifyConversation?: unknown, notifyTaskDone?: unknown, taskDoneDurationSeconds?: unknown, notificationPlacement?: unknown }} */ (prefs || {})
  let changed = false
  if (typeof next.notifyConversation === 'boolean' && next.notifyConversation !== config.notifyConversation) {
    config.notifyConversation = next.notifyConversation
    changed = true
  }
  if (typeof next.notifyTaskDone === 'boolean' && next.notifyTaskDone !== config.notifyTaskDone) {
    config.notifyTaskDone = next.notifyTaskDone
    changed = true
  }
  if (validTaskDoneDuration(next.taskDoneDurationSeconds) && next.taskDoneDurationSeconds !== config.taskDoneDurationSeconds) {
    config.taskDoneDurationSeconds = next.taskDoneDurationSeconds
    changed = true
  }
  if ((next.notificationPlacement === 'dock' || next.notificationPlacement === 'corner') && next.notificationPlacement !== config.notificationPlacement) {
    config.notificationPlacement = next.notificationPlacement
    changed = true
  }
  if (!changed) return false
  saveConfig()
  syncNotifications()
  if (settings && !settings.isDestroyed()) settings.webContents.send('notify-prefs', notificationPrefs())
  return true
}

/**
 * 插件设置页通过管理配置下发开关。只在值变化时写入，避免和本地保存来回覆盖。
 * @param {any} ui
 * @returns {void}
 */
function applyHostNotifyPrefs(ui) {
  if (!ui || typeof ui !== 'object') return
  applyNotificationPrefs({
    ...(typeof ui.notifyConversation === 'boolean' ? { notifyConversation: ui.notifyConversation } : {}),
    ...(typeof ui.notifyTaskDone === 'boolean' ? { notifyTaskDone: ui.notifyTaskDone } : {}),
    ...(validTaskDoneDuration(ui.taskDoneDurationSeconds) ? { taskDoneDurationSeconds: ui.taskDoneDurationSeconds } : {}),
    ...(['dock', 'corner'].includes(ui.notificationPlacement) ? { notificationPlacement: ui.notificationPlacement } : {}),
  })
  if (!pendingTrayPrefsRevision && typeof ui.minimizedToTray === 'boolean' && ui.minimizedToTray !== config.minimizedToTray) {
    if (ui.minimizedToTray) minimizeToTray()
    else restoreFromTray()
  }
}

/** 把悬浮框设置页的开关同步回宿主，托盘操作只推送对应字段。 @param {object} [prefs] @returns {Promise<void>} */
async function pushNotifyPrefs(prefs = notificationPrefs()) {
  try {
    const response = await request('POST', '/notify-prefs', JSON.stringify(prefs))
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
  } catch (error) {
    console.error('[dsh-session-tray] notify prefs sync failed:', error instanceof Error ? error.message : error)
    throw error
  }
}

/** 串行回传本地托盘状态，失败保留待同步状态，由下一轮刷新重试。 @returns {Promise<void>} */
async function pushTrayPrefs() {
  const revision = pendingTrayPrefsRevision
  if (!revision || trayPrefsPushInFlight) return
  trayPrefsPushInFlight = true
  const minimizedToTray = config.minimizedToTray
  try {
    await pushNotifyPrefs({ minimizedToTray })
    if (pendingTrayPrefsRevision === revision) pendingTrayPrefsRevision = 0
  } catch {} finally {
    trayPrefsPushInFlight = false
    if (pendingTrayPrefsRevision && pendingTrayPrefsRevision !== revision) void pushTrayPrefs()
  }
}

/** 记录本地托盘状态变化，避免在回传确认前被宿主旧值覆盖。 */
function syncTrayPrefs() {
  pendingTrayPrefsRevision = ++trayPrefsRevision
  void pushTrayPrefs()
}

/** 原子替换用户配置，避免中断写入后下次启动只能恢复默认值。 @returns {void} */
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const temp = `${configPath}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, configPath)
  } finally {
    try { fs.unlinkSync(temp) } catch {}
  }
}

/**
 * @param {string} method
 * @param {string} route
 * @param {string} [body]
 * @returns {Promise<{ status: number, json: any }>}
 */
function request(method, route, body) {
  const target = new URL(route, bridgeUrl)
  return new Promise((resolve, reject) => {
    const req = http.request(target, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = text ? JSON.parse(text) : null } catch { json = null }
        resolve({ status: res.statusCode || 0, json })
      })
    })
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/**
 * 已保存宽度夹在可用范围内；缺省或损坏时保持默认，不把非法值写回。
 * @param {unknown} value
 * @returns {number | null}
 */
function storedBarWidth(value) {
  const width = Number(value)
  if (!Number.isFinite(width)) return null
  return Math.round(Math.min(BAR_WIDTH_MAX, Math.max(BAR_WIDTH_MIN, width)))
}

/** @returns {number} */
function barWidth() {
  return config.width ?? BAR_WIDTH
}

/**
 * 优先用窗口实际宽度，这样拖动过程中通知能跟着边缘走。
 * @returns {number}
 */
function currentDockWidth() {
  if (dock && !dock.isDestroyed()) {
    const width = dock.getBounds().width
    if (Number.isFinite(width) && width >= 1) return Math.round(width)
  }
  return barWidth()
}

/**
 * 工作区比上限更窄时，上限让位于工作区；下限也不能超过工作区。
 * @param {number} areaWidth
 * @returns {{ min: number, max: number }}
 */
function widthLimits(areaWidth) {
  const max = Math.max(1, Math.min(BAR_WIDTH_MAX, Math.floor(areaWidth)))
  return { min: Math.min(BAR_WIDTH_MIN, max), max }
}

/**
 * 右边缘拖动保持左边不动；左边缘拖动保持右边不动。结果始终落在工作区内。
 * @param {{ x: number, y: number, width: number, height: number }} start
 * @param {'left' | 'right'} edge
 * @param {number} dx
 * @param {{ x: number, width: number }} area
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function boundsAfterWidthDrag(start, edge, dx, area) {
  const limits = widthLimits(area.width)
  const rightLimit = area.x + area.width
  if (edge === 'right') {
    const available = Math.max(1, rightLimit - start.x)
    let width = Math.round(start.width + dx)
    width = Math.min(width, limits.max, available)
    width = Math.max(width, Math.min(limits.min, available))
    return { x: start.x, y: start.y, width, height: start.height }
  }
  const right = start.x + start.width
  const minX = Math.max(area.x, right - limits.max)
  const maxX = right - Math.min(limits.min, Math.max(1, right - area.x))
  const x = Math.min(Math.max(Math.round(start.x + dx), minX), maxX)
  return { x, y: start.y, width: right - x, height: start.height }
}

/** @type {{ edge: 'left' | 'right', startX: number, bounds: Electron.Rectangle, timer: ReturnType<typeof setInterval> } | null} */
let widthDrag = null
/** @type {(() => boolean) | false | null} */
let leftButtonProbe = null

/** 探测失败时不在轮询里结束拖动，改等渲染进程的 pointerup。 @returns {boolean} */
function isLeftButtonDown() {
  if (leftButtonProbe === false) return true
  try {
    if (!leftButtonProbe) leftButtonProbe = require('./taskbar.cjs').isLeftButtonDown
    return leftButtonProbe()
  } catch (error) {
    leftButtonProbe = false
    console.error('[dsh-session-tray] width drag button probe failed:', error instanceof Error ? error.message : error)
    return true
  }
}

/** @param {unknown} edge @returns {'left' | 'right' | null} */
function normalizeWidthEdge(edge) {
  return edge === 'left' || edge === 'right' ? edge : null
}

/**
 * @param {'left' | 'right'} edge
 * @returns {void}
 */
function beginWidthDrag(edge) {
  if (!dock || dock.isDestroyed() || config.minimizedToTray) return
  if (widthDrag) clearInterval(widthDrag.timer)
  const bounds = dock.getBounds()
  placing = true
  widthDrag = { edge, startX: screen.getCursorScreenPoint().x, bounds, timer: setInterval(stepWidthDrag, 16) }
}

/** 按屏幕光标持续改宽度。鼠标离开细条后仍跟踪，直到左键松开。 */
function stepWidthDrag() {
  if (!widthDrag || !dock || dock.isDestroyed()) {
    endWidthDrag()
    return
  }
  if (!isLeftButtonDown()) {
    endWidthDrag()
    return
  }
  const dx = screen.getCursorScreenPoint().x - widthDrag.startX
  const next = boundsAfterWidthDrag(widthDrag.bounds, widthDrag.edge, dx, workAreaFor(widthDrag.bounds))
  const current = dock.getBounds()
  if (current.x === next.x && current.width === next.width) return
  dock.setBounds(next)
  config.width = next.width
  config.x = next.x
  positionNotifications()
}

/** @param {boolean} [save] */
function endWidthDrag(save = true) {
  if (widthDrag) clearInterval(widthDrag.timer)
  widthDrag = null
  placing = false
  if (save && dock && !dock.isDestroyed()) rememberPosition()
}

/**
 * 键盘微调。delta 是宽度变化，左边缘调整时右边固定。
 * @param {'left' | 'right'} edge
 * @param {number} widthDelta
 * @returns {void}
 */
function nudgeBarWidth(edge, widthDelta) {
  if (!dock || dock.isDestroyed() || !Number.isFinite(widthDelta) || widthDelta === 0) return
  const bounds = dock.getBounds()
  const dx = edge === 'left' ? -widthDelta : widthDelta
  const next = boundsAfterWidthDrag(bounds, edge, dx, workAreaFor(bounds))
  placing = true
  dock.setBounds(next)
  placing = false
  config.width = next.width
  config.x = next.x
  rememberPosition()
}

/**
 * 双击边缘恢复默认宽度，并保持被双击的对侧边缘不动。
 * @param {'left' | 'right'} edge
 * @returns {void}
 */
function resetBarWidth(edge) {
  if (!dock || dock.isDestroyed()) return
  const bounds = dock.getBounds()
  const area = workAreaFor(bounds)
  const width = Math.min(BAR_WIDTH, widthLimits(area.width).max)
  const dx = edge === 'left' ? bounds.width - width : width - bounds.width
  const next = boundsAfterWidthDrag(bounds, edge, dx, area)
  placing = true
  dock.setBounds(next)
  placing = false
  config.width = next.width
  config.x = next.x
  rememberPosition()
}

/** @returns {{ width: number, height: number }} */
function sizeFor() {
  const width = barWidth()
  if (!expanded) return { width, height: BAR_HEIGHT }
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : []
  const groups = Number(rows.some((row) => row.section === 'running'))
    + Number(rows.some((row) => row.section === 'attention' && row.label !== '已完成'))
    + Number(rows.some((row) => row.section === 'attention' && row.label === '已完成'))
  const list = Math.min(320, Math.max(48, 8 + groups * 22 + rows.length * 32))
  return { width, height: 34 + list }
}

/**
 * 用窗口当前所在的屏幕，而不是主屏幕。否则拖到副屏后一点击就会被夹回主屏。
 * @param {{ x: number, y: number, width: number, height: number }} bounds
 * @returns {Electron.Rectangle}
 */
function workAreaFor(bounds) {
  return screen.getDisplayMatching(bounds).workArea
}

function applyBounds() {
  if (!dock) return
  const current = dock.getBounds()
  let x = config.x ?? current.x
  let y = config.y ?? current.y
  const home = config.x === null || config.y === null ? screen.getPrimaryDisplay().workArea : null
  const area = workAreaFor({ x: home ? home.x : x, y: home ? home.y : y, width: Math.max(barWidth(), 1), height: BAR_HEIGHT })
  const size = sizeFor()
  size.width = Math.min(size.width, widthLimits(area.width).max)
  if (home) {
    x = home.x + home.width - size.width - 24
    y = home.y + home.height - BAR_HEIGHT - 8
  }
  const panel = size.height - BAR_HEIGHT
  const maxX = area.x + area.width - Math.min(size.width, 40)
  x = Math.min(Math.max(area.x, x), Math.max(area.x, maxX))
  const maxY = area.y + area.height - BAR_HEIGHT
  y = Math.min(Math.max(area.y, y), maxY)
  if (y - panel < area.y) y = Math.min(maxY, area.y + panel)
  placing = true
  dock.setBounds({ x, y: y - panel, width: size.width, height: size.height })
  placing = false
  positionNotifications()
}

/** 保存用户拖动后的浮窗位置，并同步通知位置。 */
function rememberPosition() {
  if (!dock || placing) return
  const bounds = dock.getBounds()
  config.x = bounds.x
  config.y = bounds.y + sizeFor().height - BAR_HEIGHT
  saveConfig()
  positionNotifications()
}

/**
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function openSession(sessionId) {
  // 预览整卡即便可点击，也绝不进入真实会话跳转链路。
  if (sessionId === '__preview-completion__') return
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(sessionId)) return
  await request('POST', '/open', JSON.stringify({ sessionId }))
  await shell.openExternal('dsh://open').catch((error) => {
    console.error('[dsh-session-tray] dsh://open failed:', error)
  })
}

async function refresh() {
  try {
    await pushTrayPrefs()
    const trayRevision = trayPrefsRevision
    const response = await request('GET', '/snapshot')
    if (response.status !== 200) return
    const next = JSON.stringify(response.json?.rows ?? [])
    const prev = JSON.stringify(snapshot.rows ?? [])
    snapshot = response.json
    applyManagement(trayRevision === trayPrefsRevision ? snapshot : { ...snapshot, ui: { ...snapshot.ui, minimizedToTray: undefined } })
    reconcileNotificationCycles(notificationCycles, snapshot)
    syncNotifications()
    dock?.webContents.send('snapshot', snapshot)
    if (next !== prev && expanded) applyBounds()
  } catch (error) {
    console.error('[dsh-session-tray] snapshot failed:', error instanceof Error ? error.message : error)
  }
}

function createDock() {
  dock = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    thickFrame: false,
    roundedCorners: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    width: BAR_WIDTH,
    height: 36,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  dock.setAlwaysOnTop(true, 'screen-saver')
  void dock.loadFile(path.join(__dirname, 'dock.html'))
  dock.once('ready-to-show', () => {
    presentDock()
    dock?.webContents.send('expanded', expanded)
    dock?.webContents.send('snapshot', snapshot)
    void request('POST', '/ready', JSON.stringify({ pid: process.pid })).catch((error) => {
      console.error('[dsh-session-tray] ready handshake failed:', error.message)
    })
  })
  dock.on('moved', rememberPosition)

}

app.on('window-all-closed', () => {})

/** @type {{ reconcileNotificationCycles: typeof reconcileNotificationCycles, visibleNotifications: typeof visibleNotifications, notificationBoundsFor: typeof notificationBoundsFor, cornerNotificationBounds: typeof cornerNotificationBounds, notificationWindowBounds: typeof notificationWindowBounds, sweepExpiredNotifications: typeof sweepExpiredNotifications }} */
module.exports = { reconcileNotificationCycles, visibleNotifications, notificationBoundsFor, cornerNotificationBounds, notificationWindowBounds, sweepExpiredNotifications }

ipcMain.on('notification-dismiss', (event, sessionId) => {
  if (!notifications || event.sender !== notifications.webContents) return
  const entry = notificationCycles.get(String(sessionId || ''))
  if (entry) entry.hidden = true
  syncNotifications()
})
ipcMain.on('notification-height', (event, height) => {
  if (!notifications || event.sender !== notifications.webContents || !Number.isFinite(height) || height <= 0) return
  notificationContentHeight = Math.ceil(height)
  positionNotifications()
})
ipcMain.handle('open-session', (_event, sessionId) => openSession(String(sessionId || '')))
ipcMain.on('set-expanded', (_event, open) => {
  expanded = open === true
  config.expanded = expanded
  saveConfig()
  applyBounds()
  publishNotificationLayout()
})
ipcMain.on('width-drag-begin', (event, edge) => {
  if (!dock || event.sender !== dock.webContents) return
  const side = normalizeWidthEdge(edge)
  if (side) beginWidthDrag(side)
})
ipcMain.on('width-drag-end', (event) => {
  if (!dock || event.sender !== dock.webContents) return
  endWidthDrag()
})
ipcMain.on('width-reset', (event, edge) => {
  if (!dock || event.sender !== dock.webContents) return
  const side = normalizeWidthEdge(edge)
  if (side) resetBarWidth(side)
})
ipcMain.on('width-nudge', (event, payload) => {
  if (!dock || event.sender !== dock.webContents) return
  const side = normalizeWidthEdge(payload?.edge)
  const delta = Number(payload?.delta)
  if (side && Number.isFinite(delta) && Math.abs(delta) <= BAR_WIDTH_MAX) nudgeBarWidth(side, delta)
})
function closeSettings() {
  if (!settings || settings.isDestroyed()) {
    settings = undefined
    return
  }
  settings.close()
  settings = undefined
}

/**
 * 浮窗右键菜单。最小化后窗口隐藏，恢复入口改到托盘菜单。
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function dockMenuTemplate() {
  return [
    { label: '最小化到托盘', click: () => minimizeToTray() },
    { label: '设置', click: () => openSettings() },
  ]
}

/**
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function trayMenuTemplate() {
  return [
    { label: '显示悬浮框', click: () => restoreFromTray() },
    { label: '设置', click: () => openSettings() },
  ]
}

/**
 * 运行时注入的图标优先；源码目录和打包目录各留一个回退。
 * @returns {Electron.NativeImage | null}
 */
function loadTrayImage() {
  const candidates = [
    process.env.DSH_SESSION_TRAY_ICON,
    path.join(__dirname, '..', 'assets', 'tray.png'),
    path.join(__dirname, '..', '..', 'assets', 'tray.png'),
  ]
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) return image
  }
  return null
}

/** @returns {Electron.Menu} */
function trayMenu() {
  return Menu.buildFromTemplate(trayMenuTemplate())
}

/**
 * 创建系统托盘图标。Windows 右键由 setContextMenu 接管，左键单独恢复悬浮框。
 * @returns {boolean}
 */
function ensureTray() {
  if (tray && !tray.isDestroyed()) return true
  try {
    const image = loadTrayImage()
    if (!image) throw new Error('tray icon missing')
    tray = new Tray(image)
    tray.setToolTip('会话悬浮框（单击显示，右键菜单）')
    tray.setContextMenu(trayMenu())
    if (trayPlatform(process.platform).leftClickPopsMenu) tray.on('click', () => restoreFromTray())
    tray.on('double-click', () => restoreFromTray())
    return true
  } catch (error) {
    console.error('[dsh-session-tray] tray creation failed:', error instanceof Error ? error.message : error)
    destroyTray()
    return false
  }
}

/** 移除托盘图标。重复调用安全。 */
function destroyTray() {
  if (!tray || tray.isDestroyed()) {
    tray = undefined
    return
  }
  tray.destroy()
  tray = undefined
}

/**
 * 隐藏浮窗但保留进程、轮询和通知窗口。图标不可用时不进入该模式。
 * @returns {boolean}
 */
function minimizeToTray() {
  if (!ensureTray()) {
    restoreFromTray()
    return false
  }
  config.minimizedToTray = true
  saveConfig()
  if (dock && !dock.isDestroyed()) dock.hide()
  syncNotifications()
  syncTrayPrefs()
  return true
}

/** 从托盘恢复悬浮框。通知仍固定在屏幕右下角。 */
function restoreFromTray() {
  config.minimizedToTray = false
  saveConfig()
  destroyTray()
  if (dock && !dock.isDestroyed()) {
    dock.setAlwaysOnTop(true, 'screen-saver')
    applyBounds()
    dock.showInactive()
  }
  syncNotifications()
  syncTrayPrefs()
}

/** 按已保存模式显示浮窗或托盘。图标失败时清除假状态并回传宿主。 */
function presentDock() {
  if (!dock || dock.isDestroyed()) return
  applyBounds()
  if (config.minimizedToTray) {
    minimizeToTray()
    return
  }
  destroyTray()
  dock.showInactive()
}

function showContextMenu() {
  const menu = Menu.buildFromTemplate(dockMenuTemplate())
  menu.popup({ window: dock })
}

/** 打开设置窗口；常规尺寸完整展示选项，小屏幕限制在可用工作区内。 */
function openSettings() {
  if (settings && !settings.isDestroyed()) {
    settings.show()
    settings.focus()
    return
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(560, area.width)
  const height = Math.min(640, area.height)
  const x = Math.round(area.x + (area.width - width) / 2)
  const y = Math.round(area.y + (area.height - height) / 2)
  settings = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    thickFrame: false,
    roundedCorners: false,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  settings.setAlwaysOnTop(true, 'screen-saver')
  void settings.loadFile(path.join(__dirname, 'settings.html'))
  settings.once('ready-to-show', () => {
    settings?.setBackgroundColor('#00000000')
    settings?.show()
    setTimeout(() => {
      settings?.on('blur', () => closeSettings())
    }, 200)
  })
  settings.on('closed', () => {
    settings = undefined
  })
}

ipcMain.handle('notify-prefs-get', (event) => {
  if (!settings || event.sender !== settings.webContents) return { notifyConversation: true, notifyTaskDone: true, taskDoneDurationSeconds: 10, notificationPlacement: 'dock' }
  return notificationPrefs()
})
ipcMain.handle('notification-preview', (event) => {
  if (!settings || event.sender !== settings.webContents) throw new Error('仅设置窗口可预览通知')
  return previewNotification()
})
ipcMain.on('notify-prefs-set', (event, prefs) => {
  if (!settings || event.sender !== settings.webContents) return
  if (applyNotificationPrefs(prefs)) void pushNotifyPrefs().catch(() => {})
})
ipcMain.on('show-menu', () => showContextMenu())

app.whenReady().then(() => {
  createDock()
  screen.on('display-metrics-changed', () => { applyBounds(); positionNotifications() })
  screen.on('display-removed', () => { applyBounds(); positionNotifications() })
  void refresh()
  setInterval(() => { void refresh() }, 1000)
  setInterval(() => {
    if (!dock || dock.isDestroyed()) return
    dock.setAlwaysOnTop(true, 'screen-saver')
    if (notifications && !notifications.isDestroyed()) notifications.setAlwaysOnTop(true, 'screen-saver')
  }, 2000)
  console.error('[dsh-session-tray] dock ready')
}).catch((error) => {
  console.error('[dsh-session-tray] startup failed:', error)
  process.exit(1)
})
