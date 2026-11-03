window.__ModuleLoader__.load({
  id: 'dsh-session-tray',
  factory(require) {
    const React = require('react')
    const { useEffect, useRef } = React

    /**
     * 无界面观察者。状态来自侧边栏同一对 hook，不在这里重算运行中或未读完成。
     * @param {object} props
     * @param {(selector: (value: any) => any) => any} props.useSessions
     * @param {(selector: (value: any) => any) => any} props.useSessionStatus
     * @param {(selector: (value: any) => any) => any} props.useWorkspaces
     */
    function Watcher({ useSessions, useSessionStatus, useWorkspaces }) {
      const list = useSessions((snap) => snap)
      const status = useSessionStatus((snap) => snap)
      const workspaces = useWorkspaces((snap) => snap)
      const rows = collectRows(list, status, workspaces)
      const signature = JSON.stringify(rows)
      const fails = useRef(0)
      const warned = useRef(false)
      const openSession = Watcher.openSession

      useEffect(() => {
        let stopped = false
        const post = () => {
          if (stopped) return
          fetch('/dsh-session-tray/snapshot', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rows }),
          }).catch((error) => warnOnce(warned, error))
        }
        post()
        const heartbeat = setInterval(post, 5000)
        return () => {
          stopped = true
          clearInterval(heartbeat)
        }
      }, [signature])

      useEffect(() => {
        let stopped = false
        const poll = async () => {
          if (stopped) return
          try {
            const response = await fetch('/dsh-session-tray/pending', { credentials: 'same-origin' })
            if (!response.ok) return
            const body = await response.json()
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
            if (!sessionId) return
            await openRequested(sessionId, openSession, fails, warned)
          } catch (error) {
            warnOnce(warned, error)
          }
        }
        const timer = setInterval(() => { void poll() }, 800)
        void poll()
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [openSession])

      return null
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        Watcher.openSession = (sessionId) => ctx.get?.('uiWorkspace')?.openSession?.(sessionId)
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-session-tray',
          order: 80,
        }, Watcher))
      },
    }
  },
})

/**
 * @param {string} sessionId
 * @param {(sessionId: string) => void} [openSession]
 * @param {{ current: number }} fails
 * @param {{ current: boolean }} warned
 * @returns {Promise<void>}
 */
async function openRequested(sessionId, openSession, fails, warned) {
  try {
    if (typeof openSession !== 'function') {
      warnOnce(warned, new Error('uiWorkspace.openSession missing'))
      await ack(sessionId)
      return
    }
    openSession(sessionId)
    fails.current = 0
    await ack(sessionId)
  } catch (error) {
    fails.current += 1
    if (fails.current < 3) return
    warnOnce(warned, error)
    fails.current = 0
    await ack(sessionId)
  }
}

/**
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
function ack(sessionId) {
  return fetch('/dsh-session-tray/ack', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  }).then(() => undefined)
}

/**
 * @param {{ current: boolean }} warned
 * @param {unknown} error
 */
function warnOnce(warned, error) {
  if (warned.current) return
  warned.current = true
  console.warn('[dsh-session-tray]', error instanceof Error ? error.message : error)
}

/**
 * 只保留侧边栏会标成运行中或待确认的行。子会话来源的活动记到父会话上。
 * @param {any} list
 * @param {any} status
 * @param {any} workspaces
 * @returns {Array<{ id: string, title: string, section: 'running' | 'attention', label: string }>}
 */
function collectRows(list, status, workspaces) {
  const byId = list?.byId && typeof list.byId === 'object' ? list.byId : {}
  const ids = new Set([...Object.keys(byId), ...statusIds(status)])
  const archived = archivedIds(workspaces)
  /** @type {Set<string>} */
  const childRunning = new Set()
  /** @type {Map<string, unknown>} */
  const childPending = new Map()
  for (const id of ids) {
    const row = byId[id] ?? {}
    if (!isSubagent(row)) continue
    const parent = parentId(row)
    const entry = statusEntry(status, id)
    if (!parent) continue
    if (entry.running) childRunning.add(parent)
    if (entry.pending) childPending.set(parent, entry.pending)
  }

  /** @type {Array<{ id: string, title: string, section: 'running' | 'attention', label: string, updatedAt: number, responsePreview?: string, contextPercent?: number, usedTokens?: number, contextWindow?: number }>} */
  const rows = []
  for (const id of ids) {
    const row = byId[id] ?? {}
    if (isSubagent(row) || row.blank === true || archived.has(id)) continue
    const entry = statusEntry(status, id)
    const pending = entry.pending || childPending.get(id)
    const running = entry.running || childRunning.has(id)
    let section = /** @type {'running' | 'attention' | ''} */ ('')
    let label = ''
    if (pending) {
      section = 'attention'
      label = pendingLabel(pending)
    } else if (running) {
      section = 'running'
      label = '运行中'
    } else if (entry.completionUnread) {
      section = 'attention'
      label = '已完成'
    }
    if (!section) continue
    const context = contextOf(list, id)
    rows.push({
      id,
      title: clip(String(row.displayTitle || row.title || '未命名会话'), 60),
      section,
      label,
      updatedAt: Number(row.updatedAt) || 0,
      ...context,
      ...(label === '已完成' ? { responsePreview: responsePreviewOf(list, id) } : {}),
    })
  }
  rows.sort((left, right) => right.updatedAt - left.updatedAt || left.title.localeCompare(right.title, 'zh'))
  return rows.slice(0, 24).map(({ id, title, section, label, updatedAt, contextPercent, usedTokens, contextWindow, responsePreview }) => ({
    id,
    title,
    section,
    label,
    updatedAt,
    ...(responsePreview === undefined ? {} : { responsePreview }),
    ...(contextPercent === undefined ? {} : { contextPercent, usedTokens, contextWindow }),
  }))
}

/** 从最新已结束轮次读取助手文本摘要；缺失时不回退旧轮次。 @param {any} list @param {string} id @returns {string} */
function responsePreviewOf(list, id) {
  const values = list?.projectionsBySession?.[id]?.values ?? list?.byId?.[id]?.projectionValues
  const outline = values?.turnOutline
  const response = Array.isArray(outline) ? outline.at(-1)?.response : ''
  return typeof response === 'string' ? response.replace(/…$/, '...') : ''
}

/**
 * 与输入框下的上下文环同一算法：projectedTokens 优先，否则 pressureTokens，除以 contextWindow。
 * @param {any} list
 * @param {string} id
 * @returns {{ contextPercent: number, usedTokens: number, contextWindow: number } | {}}
 */
function contextOf(list, id) {
  const values = list?.projectionsBySession?.[id]?.values ?? list?.byId?.[id]?.projectionValues
  const pressure = values?.contextPressure
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  const windowSize = pressure?.contextWindow
  if (typeof used !== 'number' || typeof windowSize !== 'number' || windowSize <= 0) return {}
  return {
    contextPercent: Math.min(100, Math.round(used / windowSize * 100)),
    usedTokens: used,
    contextWindow: windowSize,
  }
}

function statusIds(status) {
  if (status instanceof Map) return [...status.keys()]
  if (status && typeof status === 'object') return Object.keys(status)
  return []
}

/**
 * @param {any} status
 * @param {string} id
 * @returns {{ running: boolean, completionUnread: boolean, pending: unknown }}
 */
function statusEntry(status, id) {
  const entry = status instanceof Map ? status.get(id) : status?.[id]
  return {
    running: entry?.running === true,
    completionUnread: entry?.completionUnread === true,
    pending: entry?.pendingInteraction || null,
  }
}

/**
 * @param {any} row
 * @returns {boolean}
 */
function isSubagent(row) {
  if (row?.origin === 'subagent') return true
  return typeof row?.delegationDepth === 'number' && row.delegationDepth > 0
}

/**
 * @param {any} row
 * @returns {string}
 */
function parentId(row) {
  const id = row?.parentSessionId || row?.parentSession
  return typeof id === 'string' ? id : ''
}

/**
 * @param {any} workspaces
 * @returns {Set<string>}
 */
function archivedIds(workspaces) {
  const found = new Set()
  const value = workspaces?.archivedSessionIds ?? workspaces?.archivedSessions ?? workspaces?.archived
  const list = value instanceof Set ? [...value] : Array.isArray(value) ? value : []
  for (const id of list) if (typeof id === 'string') found.add(id)
  return found
}

/**
 * @param {any} pending
 * @returns {string}
 */
function pendingLabel(pending) {
  const kind = String(pending?.kind || pending?.type || '')
  if (kind === 'approval' || kind === 'permission') return '待批准'
  if (kind === 'plan' || kind === 'plan-review') return '待审阅'
  if (kind === 'question') return '待回答'
  return '待确认'
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
