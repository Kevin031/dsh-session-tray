window.__ModuleLoader__.load({
  id: 'dsh-session-tray',
  factory(require) {
    const React = require('react')
/**
 * 注册会话悬浮窗设置；由主 Client 的 apply(ctx) 调用，React 使用宿主实例。
 * @param {any} ctx 已注入 slots、locale 的 Client Context。
 * @param {any} React 宿主提供的 React 实例。
 * @returns {void}
 */
function registerSettings(ctx, React) {
  const ns = 'dsh-session-tray-settings'
  const h = React.createElement
  const { useEffect, useRef, useState, useSyncExternalStore } = React
  ctx.effect(() => ctx.locale.register(ns, 'zh', zh))
  ctx.effect(() => ctx.locale.register(ns, 'en', en))
  const t = ctx.locale.bind(ns)
  ctx.effect(() => installSettingsNavIcon())

  /** 设置页挂载期间读取状态，离开页面后终止全部请求及计时器。 */
  function TraySettings() {
    useSyncExternalStore(
      (notify) => ctx.locale.subscribe(notify),
      () => ctx.locale.getSnapshot(),
    )
    const [status, setStatus] = useState(null)
    const [readError, setReadError] = useState('')
    const [actionError, setActionError] = useState('')
    const [pending, setPending] = useState('')
    const [prefsSaving, setPrefsSaving] = useState(false)
    const [notice, setNotice] = useState('')
    const [prefs, setPrefs] = useState({ notifyConversation: true, notifyTaskDone: true, taskDoneDurationSeconds: 10, notificationPlacement: 'dock' })
    const lifecycle = useRef(null)

    useEffect(() => {
      const state = { alive: true, serial: 0, request: null, pending: false, prefsSaving: false, refresh: null }
      lifecycle.current = state
      /** 获取最新状态；所有请求共用门闩，避免轮询重叠。 @param {boolean} [afterAction] */
      async function refresh(afterAction = false) {
        if (!state.alive || state.request || (state.pending && !afterAction)) return
        const serial = ++state.serial
        const controller = new AbortController()
        state.request = controller
        const timeout = setTimeout(() => controller.abort(), 15000)
        try {
          const body = await request('/dsh-session-tray/manage/status', { signal: controller.signal })
          if (!body || typeof body.supported !== 'boolean' || typeof body.enabled !== 'boolean' || !body.runtime || typeof body.runtime.available !== 'boolean' || typeof body.phase !== 'string') {
            throw new Error(t('invalidStatus'))
          }
          if (!state.alive || serial !== state.serial) return
          setStatus(body)
          if (!state.prefsSaving) {
            setPrefs({
              notifyConversation: body.ui?.notifyConversation !== false,
              notifyTaskDone: body.ui?.notifyTaskDone !== false,
              taskDoneDurationSeconds: normalizeDuration(body.ui?.taskDoneDurationSeconds),
              notificationPlacement: body.ui?.notificationPlacement === 'corner' ? 'corner' : 'dock',
            })
          }
          setReadError('')
        } catch (error) {
          if (!state.alive || serial !== state.serial) return
          setReadError(controller.signal.aborted ? t('readTimeout') : message(error))
        } finally {
          clearTimeout(timeout)
          if (state.request === controller) state.request = null
        }
      }
      state.refresh = refresh
      void refresh()
      const timer = setInterval(() => { void refresh() }, 2000)
      return () => {
        state.alive = false
        ++state.serial
        clearInterval(timer)
        state.request?.abort()
        if (lifecycle.current === state) lifecycle.current = null
      }
    }, [])

    /**
     * 操作先取消旧读取，并用递增版本拦截过期结果；成功后重新读取权威状态。
     * @param {'install'|'enable'|'disable'|'restart'|'reset-position'|'preview-notification'} action
     */
    async function act(action) {
      const state = lifecycle.current
      if (!state?.alive || state.pending || state.prefsSaving || (action === 'preview-notification' && (disabled || status?.phase !== 'running'))) return
      state.pending = true
      ++state.serial
      state.request?.abort()
      const controller = new AbortController()
      state.request = controller
      setPending(action)
      setActionError('')
      setNotice('')
      const timeout = setTimeout(() => controller.abort(), 60000)
      try {
        await request(action === 'preview-notification' ? '/dsh-session-tray/manage/preview-notification' : '/dsh-session-tray/manage/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(action === 'preview-notification' ? {} : { action }),
          signal: controller.signal,
        })
        if (state.alive) setNotice(t(action === 'preview-notification' ? 'previewAccepted' : 'accepted'))
      } catch (error) {
        if (state.alive) setActionError(controller.signal.aborted ? t('actionTimeout') : message(error))
      } finally {
        clearTimeout(timeout)
        if (state.request === controller) state.request = null
        // 获取操作后的权威状态前不释放按钮，避免用旧状态再次提交。
        if (state.alive) await state.refresh(true)
        state.pending = false
        if (state.alive) setPending('')
      }
    }

    const working = ['downloading', 'verifying', 'extracting', 'starting'].includes(status?.phase)
    const disabled = !status || !status.supported || !!pending || working || !!readError
    const available = status?.runtime.available === true
    const phaseKey = `phase.${status?.phase}`
    const phase = status ? (Object.hasOwn(en, phaseKey) ? t(phaseKey) : status.phase) : t('loading')
    const progress = typeof status?.progress === 'number' && Number.isFinite(status.progress)
      ? Math.max(0, Math.min(100, status.progress)) : null

    /**
     * @param {'notifyConversation' | 'notifyTaskDone' | 'taskDoneDurationSeconds' | 'notificationPlacement' | 'minimizedToTray'} key
     * @param {boolean | number | string} value
     * @returns {Promise<void>}
     */
    async function savePrefs(key, value) {
      const state = lifecycle.current
      if (!state?.alive || state.prefsSaving || !status?.supported) return
      const next = { ...prefs, [key]: value }
      setPrefs(next)
      state.prefsSaving = true
      setPrefsSaving(true)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      try {
        await request('/dsh-session-tray/manage/notify-prefs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(key === 'minimizedToTray' ? { minimizedToTray: value } : next),
          signal: controller.signal,
        })
        if (state.alive) setActionError('')
      } catch (error) {
        if (state.alive) setActionError(controller.signal.aborted ? t('actionTimeout') : message(error))
      } finally {
        clearTimeout(timeout)
        state.prefsSaving = false
        if (state.alive) await state.refresh(true)
        if (state.alive) setPrefsSaving(false)
      }
    }
    /** @param {string} label @param {any} value @returns {any} */
    function row(label, value) {
      return h('div', { className: 'dst-meta-row', key: label },
        h('dt', null, label), h('dd', null, value))
    }
    /**
     * @param {'notifyConversation' | 'notifyTaskDone'} key
     * @param {string} title
     * @param {string} hint
     * @returns {any}
     */
    function prefSwitch(key, title, hint) {
      const off = !status?.supported || !!readError
      return h('label', { className: 'dst-switch-row' },
        h('span', null, h('strong', null, title), h('small', null, hint)),
        h('span', { className: 'dst-switch' },
          h('input', {
            id: key,
            type: 'checkbox',
            role: 'switch',
            checked: prefs[key] !== false,
            disabled: off,
            onChange: (event) => { void savePrefs(key, event.target.checked === true) },
          }),
          h('i', null)))
    }
    /** @param {'install'|'enable'|'disable'|'restart'|'reset-position'|'preview-notification'} action @param {boolean} off @param {boolean} [primary] @returns {any} */
    function button(action, off, primary = false) {
      return h('button', {
        type: 'button', disabled: (action === 'disable' ? !status || !status.supported || !!pending || !!readError : disabled) || off,
        className: `dst-settings-button${primary ? ' dst-settings-primary' : ''}`,
        onClick: () => { void act(action) },
      }, pending === action ? t('working') : t(`action.${action}`))
    }

    return h('section', { className: 'dst-settings', 'aria-busy': !!pending },
      h('style', null, styles),
      h('header', null, h('h2', null, t('title')), h('p', null, t('description'))),
      status?.supported === false && h('p', { role: 'status', className: 'dst-settings-feedback' }, t('unsupported')),
      h('article', { className: 'dst-card' },
        h('div', { className: 'dst-card-head' },
          h('div', null, h('h3', null, t('runtimeCard')), h('p', null, t('runtimeCardHint'))),
          h('span', { className: 'dst-pill', 'data-phase': status?.phase || 'loading', role: 'status', 'aria-live': 'polite' }, phase)),
        h('dl', { className: 'dst-meta' },
          row(t('host'), status ? `${status.platform || '—'} / ${status.arch || '—'}` : '—'),
          row(t('dependency'), !status ? t('loading') : available ? t('available') : t('missing')),
          row(t('version'), status?.runtime.version || '—'),
          row(t('runtimePath'), h('code', null, status?.runtime.path || '—')),
          row(t('enabled'), !status ? '—' : t(status.enabled ? 'yes' : 'no')),
          row(t('pid'), status?.pid ?? '—'),
        ),
        (working || progress !== null) && h('div', { className: 'dst-settings-progress' },
          h('label', null, t('progress'), progress !== null ? ` · ${Math.round(progress)}%` : ` · ${t('indeterminate')}`,
            h('progress', { max: 100, ...(progress === null ? {} : { value: progress }), 'aria-label': t('progress') }))),
        readError && h('p', { role: 'alert', className: 'dst-settings-error' }, `${t('readError')} ${readError} ${t('autoRetry')}`),
        actionError && h('p', { role: 'alert', className: 'dst-settings-error' }, `${t('actionError')} ${actionError}`),
        status?.error && h('p', { role: 'alert', className: 'dst-settings-error' }, `${t('hostError')} ${status.error}`),
        notice && h('p', { role: 'status', className: 'dst-settings-feedback' }, notice),
        h('div', { className: 'dst-settings-actions' },
          button('install', available, !available),
          button(status?.enabled ? 'disable' : 'enable', false, available),
          button('restart', !available || !status?.enabled),
          button('reset-position', !available),
        ),
        h('p', { className: 'dst-settings-caption' }, t('installNote')),
        h('label', { className: 'dst-switch-row' },
          h('span', null, h('strong', null, t(status?.platform === 'darwin' ? 'minimizedToTaskbar' : 'minimizedToTray')), h('small', null, t(status?.platform === 'darwin' ? 'minimizedToTaskbarHint' : 'minimizedToTrayHint'))),
          h('span', { className: 'dst-switch' },
            h('input', {
              id: 'minimizedToTray', type: 'checkbox', role: 'switch',
              checked: status?.ui?.minimizedToTray === true,
              disabled: disabled || prefsSaving,
              onChange: (event) => { void savePrefs('minimizedToTray', event.target.checked === true) },
            }), h('i', null))),
      ),
      h('article', { className: 'dst-card' },
        h('div', { className: 'dst-card-head' },
          h('div', null, h('h3', null, t('notifyCard')), h('p', null, t('notifyCardHint')))),
        prefSwitch('notifyConversation', t('notifyConversation'), t('notifyConversationHint')),
        prefSwitch('notifyTaskDone', t('notifyTaskDone'), t('notifyTaskDoneHint')),
        h('label', { className: 'dst-duration-row' },
          h('span', null, h('strong', null, t('notificationPlacement')), h('small', null, t('notificationPlacementHint'))),
          h('select', {
            id: 'notificationPlacement', value: prefs.notificationPlacement,
            disabled: !status?.supported || !!readError || prefsSaving,
            onChange: (event) => { void savePrefs('notificationPlacement', event.target.value === 'corner' ? 'corner' : 'dock') },
          }, h('option', { value: 'dock' }, t('placementDock')), h('option', { value: 'corner' }, t('placementCorner')))),
        h('div', { className: 'dst-settings-actions' }, button('preview-notification', status?.phase !== 'running' || prefsSaving)),
        h('p', { className: 'dst-settings-caption' }, t('previewHint')),
        h('label', { className: 'dst-duration-row' },
          h('span', null, h('strong', null, t('taskDoneDuration')), h('small', null, t('taskDoneDurationHint'))),
          h('select', {
            id: 'taskDoneDurationSeconds', value: prefs.taskDoneDurationSeconds,
            disabled: !status?.supported || !!readError,
            onChange: (event) => { void savePrefs('taskDoneDurationSeconds', normalizeDuration(Number(event.target.value))) },
          }, [...new Set([5, 10, 15, 30, 60, prefs.taskDoneDurationSeconds, 0])].map((seconds) =>
            h('option', { key: seconds, value: seconds }, seconds === 0 ? t('neverDismiss') : `${seconds} ${t('seconds')}`)))),
      ),
    )
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-session-tray-settings',
    order: 31,
    label: () => t('title'),
  }, TraySettings))
}

/**
 * 兼容当前宿主固定的设置导航图标；只标记本插件入口，卸载时对称恢复。
 * @param {Document} [doc] 页面文档。
 * @returns {() => void} 清理观察器、样式和入口标记。
 */
function installSettingsNavIcon(doc = globalThis.document) {
  if (!doc?.body || !doc.defaultView?.MutationObserver) return () => {}
  const attribute = 'data-dst-settings-nav'
  const selector = '[data-shortcut-modal="settings"] nav button'
  const labels = new Set([zh.title, en.title])
  const marked = new Set()
  const style = doc.createElement('style')
  // 原创“桌面 + 右下悬浮窗口”图形；遮罩继承 currentColor，适配深浅主题。
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4M7 22h3M9 18v4"/><rect x="12" y="11" width="10" height="10" rx="2"/><path d="M12 14h10"/></svg>'
  const mask = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  style.textContent = `[${attribute}]>svg:first-child{display:none}[${attribute}]::before{content:"";display:block;flex:0 0 16px;width:16px;height:16px;background:currentColor;mask:${mask} center/contain no-repeat;-webkit-mask:${mask} center/contain no-repeat}`
  doc.head.appendChild(style)
  /** 标题只用于识别入口，不依赖宿主构建生成的 CSS 类名或菜单位置。 */
  function update() {
    for (const button of marked) {
      if (!button.isConnected || !labels.has(button.textContent.trim())) {
        button.removeAttribute(attribute)
        marked.delete(button)
      }
    }
    for (const button of doc.querySelectorAll(selector)) {
      if (!labels.has(button.textContent.trim()) || !button.querySelector('svg')) continue
      button.setAttribute(attribute, '')
      marked.add(button)
    }
  }
  const observer = new doc.defaultView.MutationObserver(update)
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true })
  update()
  return () => {
    observer.disconnect()
    style.remove()
    for (const button of marked) button.removeAttribute(attribute)
    marked.clear()
  }
}

/**
 * 同源请求只接受成功响应；错误正文和网络异常均交由页面展示。
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch {
    throw new Error(`HTTP ${response.status}: invalid JSON`)
  }
  if (!response.ok || body?.ok === false) {
    const detail = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : ''
    throw new Error(detail || `HTTP ${response.status}`)
  }
  return body
}

/** @param {unknown} error @returns {string} */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 读取有效整数秒数；无效设置回退到默认 10 秒。 @param {unknown} value @returns {number} */
function normalizeDuration(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86400 ? value : 10
}

const zh = {
  title: '桌面状态栏', description: '在宿主电脑桌面查看运行中和待确认的会话。',
  runtimeCard: '桌面端', runtimeCardHint: '检测、安装并控制悬浮框进程。',
  minimizedToTaskbar: '最小化到任务栏', minimizedToTaskbarHint: '隐藏悬浮框，以橙/绿数字 Tag 显示运行中和已完成数量，0 不显示；点击图标菜单恢复。通知继续显示。',
  minimizedToTray: '最小化到托盘', minimizedToTrayHint: '开启后隐藏悬浮框，通知继续显示；通过 Windows 托盘或 macOS 菜单栏菜单恢复。重启后保留此设置。',
  notifyCard: '通知', notifyCardHint: '控制通知开关与完成通知停留时长，不影响悬浮框里的会话列表。',
  notifyConversation: '对话通知', notifyConversationHint: '有消息待确认时弹出。',
  notifyTaskDone: '任务完成通知', notifyTaskDoneHint: '会话执行完成时弹出。',
  notificationPlacement: '通知位置', placementDock: '跟随悬浮框', placementCorner: '桌面角落（Mac 右上 / Win 右下）',
  notificationPlacementHint: '默认跟随悬浮框，也可固定在桌面角落：macOS 右上角、Windows 桌面右下角。宽度跟随悬浮框；收起后使用 390 px。',
  previewAccepted: '已请求预览。', previewHint: '手动预览忽略任务完成通知开关，使用当前时长和位置；仅模拟通知，不打开真实会话。',
  'action.preview-notification': '预览通知',
  taskDoneDuration: '完成通知停留时长', taskDoneDurationHint: '默认 10 秒；不自动消失时需手动收起。修改仅对新通知生效。',
  neverDismiss: '不自动消失', seconds: '秒',
  host: '宿主平台', dependency: '桌面运行依赖', version: '依赖版本', runtimePath: '依赖路径', enabled: '已启用', status: '运行状态', pid: '进程 ID',
  loading: '正在读取…', available: '已就绪', missing: '未安装', yes: '是', no: '否',
  unsupported: '此宿主平台不支持桌面悬浮窗，无法执行管理操作。',
  progress: '安装进度', indeterminate: '处理中', working: '正在处理…',
  readError: '状态读取失败：', actionError: '操作失败：', hostError: '宿主错误：', autoRetry: '将自动重试读取。',
  accepted: '操作已提交，实际结果以运行状态为准。',
  invalidStatus: '宿主返回的状态格式不正确。', readTimeout: '读取超时。',
  actionTimeout: '等待操作超时，宿主可能仍在处理；请先查看最新状态，避免重复提交。',
  installNote: '首次启用会自动下载桌面运行依赖并启动；安装失败可点击“安装并启用”重试。停用会取消安装并保留已有依赖，下次启动仍保持停用。',
  'action.install': '安装并启用', 'action.enable': '启用', 'action.disable': '停用', 'action.restart': '重启', 'action.reset-position': '重置位置',
  'phase.idle': '待启动', 'phase.downloading': '正在下载', 'phase.verifying': '正在校验', 'phase.extracting': '正在解压',
  'phase.starting': '正在启动', 'phase.running': '运行中', 'phase.stopped': '已停止', 'phase.error': '发生错误',
}
const en = {
  title: 'Desktop Status Bar', description: 'See running sessions and sessions needing attention on the host desktop.',
  runtimeCard: 'Desktop runtime', runtimeCardHint: 'Detect, install, and control the overlay process.',
  minimizedToTaskbar: 'Minimize to taskbar', minimizedToTaskbarHint: 'Show running and completed counts as orange/green numeric tags in the macOS menu bar. Zero counts are hidden. Use its menu to restore; notices stay active.',
  minimizedToTray: 'Minimize to system tray', minimizedToTrayHint: 'Hide the overlay while keeping notices active. Restore from the Windows tray or macOS menu bar menu. This setting persists across restarts.',
  notifyCard: 'Notifications', notifyCardHint: 'Controls popup notices and completion notice duration. The overlay session list is unchanged.',
  notifyConversation: 'Conversation notices', notifyConversationHint: 'Pop up when a message needs confirmation.',
  notifyTaskDone: 'Task completion notices', notifyTaskDoneHint: 'Pop up when a session finishes.',
  notificationPlacement: 'Notice placement', placementDock: 'Follow overlay', placementCorner: 'Desktop corner (Mac top-right / Win bottom-right)',
  notificationPlacementHint: 'Follow the overlay by default, or pin notices to the macOS top-right or Windows desktop bottom-right. Width follows the overlay; tray mode uses 390 px.',
  previewAccepted: 'Preview requested.', previewHint: 'Manual preview ignores the task completion switch and uses the current duration and placement. Simulated notice only; no real session opens.',
  'action.preview-notification': 'Preview notice',
  taskDoneDuration: 'Completion notice duration', taskDoneDurationHint: 'Default: 10 seconds. Never-dismiss notices must be dismissed manually. Changes apply to new notices only.',
  neverDismiss: 'Never dismiss automatically', seconds: 'seconds',
  host: 'Host platform', dependency: 'Desktop runtime', version: 'Runtime version', runtimePath: 'Runtime path', enabled: 'Enabled', status: 'Runtime status', pid: 'Process ID',
  loading: 'Loading…', available: 'Ready', missing: 'Not installed', yes: 'Yes', no: 'No',
  unsupported: 'This host platform does not support the desktop overlay. Management actions are unavailable.',
  progress: 'Installation progress', indeterminate: 'In progress', working: 'Working…',
  readError: 'Could not read status:', actionError: 'Action failed:', hostError: 'Host error:', autoRetry: 'Status will refresh automatically.',
  accepted: 'Action submitted. Check the runtime status for the actual result.',
  invalidStatus: 'The host returned an invalid status response.', readTimeout: 'Status request timed out.',
  actionTimeout: 'The action timed out, but the host may still be processing it. Check the latest status before trying again.',
  installNote: 'Enabling automatically downloads the desktop runtime if missing and starts the overlay. Use Install and enable to retry failures. Disabling cancels installation, keeps existing files and remains disabled across restarts.',
  'action.install': 'Install and enable', 'action.enable': 'Enable', 'action.disable': 'Disable', 'action.restart': 'Restart', 'action.reset-position': 'Reset position',
  'phase.idle': 'Idle', 'phase.downloading': 'Downloading', 'phase.verifying': 'Verifying', 'phase.extracting': 'Extracting',
  'phase.starting': 'Starting', 'phase.running': 'Running', 'phase.stopped': 'Stopped', 'phase.error': 'Error',
}

const styles = `
.dst-settings{color:inherit;font-family:inherit;font-size:13px;line-height:1.5;max-width:760px;min-width:0}
.dst-settings h2,.dst-settings h3,.dst-settings p,.dst-settings button,.dst-settings code,.dst-settings small,.dst-settings dt,.dst-settings dd,.dst-pill{font-size:13px}
.dst-settings h2{line-height:1.4;font-weight:600;margin:0 0 8px}
.dst-settings h3{line-height:1.4;font-weight:600;margin:0}
.dst-settings header p{margin:0 0 16px}
.dst-settings p{overflow-wrap:anywhere}
.dst-card{margin:0 0 16px;padding:16px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:12px;background:color-mix(in srgb,currentColor 4%,transparent)}
.dst-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}
.dst-card-head p{margin:4px 0 0;opacity:.72}
.dst-pill{flex:none;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:999px;padding:2px 10px;line-height:1.6}
.dst-pill[data-phase="running"]{color:var(--dsw-alias-state-business-primary);border-color:currentColor}
.dst-meta{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px 16px;margin:0 0 4px}
.dst-meta-row{display:contents}
.dst-meta dt{opacity:.72}
.dst-meta dd{min-width:0;margin:0;overflow-wrap:anywhere}
.dst-meta code{white-space:normal}
.dst-settings-progress{margin:12px 0 0}
.dst-settings-progress progress{display:block;width:100%;height:8px;margin-top:8px;accent-color:var(--dsw-alias-state-business-primary)}
.dst-settings-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.dst-settings-button{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;padding:7px 13px;min-height:34px;cursor:pointer}
.dst-settings-button:not(:disabled):hover{background:color-mix(in srgb,currentColor 7%,transparent)}
.dst-settings-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dst-settings-primary{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.dst-settings-button:disabled{opacity:.45;cursor:not-allowed}
.dst-settings-error{border-left:3px solid var(--dsw-alias-state-business-primary);padding:8px 12px;margin:12px 0;white-space:pre-wrap}
.dst-settings-feedback{margin:12px 0}
.dst-settings-caption{opacity:.72;margin:12px 0 0}
.dst-switch-row{display:grid;grid-template-columns:minmax(0,1fr) 36px;gap:2px 16px;align-items:center;padding:12px 0;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}
.dst-switch-row strong{display:block;font-weight:600}
.dst-switch-row small{display:block;opacity:.72}
.dst-duration-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;align-items:center;padding:12px 0;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}
.dst-duration-row strong,.dst-duration-row small{display:block}
.dst-duration-row small{opacity:.72}
.dst-duration-row select{font:inherit;color:inherit;background:var(--dsw-alias-bg-base,Canvas);border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:6px;padding:6px;max-width:100%}
.dst-duration-row select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
@media(max-width:480px){.dst-duration-row{grid-template-columns:minmax(0,1fr)}}
.dst-switch{position:relative;width:36px;height:20px}
.dst-switch input{position:absolute;inset:0;margin:0;opacity:0;cursor:pointer}
.dst-switch input:disabled{cursor:not-allowed}
.dst-switch i{display:block;height:20px;border-radius:999px;background:color-mix(in srgb,currentColor 18%,transparent)}
.dst-switch i::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.28)}
.dst-switch input:checked+i{background:var(--dsw-alias-state-business-primary)}
.dst-switch input:checked+i::after{transform:translateX(16px)}
.dst-switch input:focus-visible+i{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dst-switch input:disabled+i{opacity:.45}
@media (prefers-reduced-motion:reduce){.dst-switch i,.dst-switch i::after{transition:none}}
`

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
        registerSettings(ctx, React)
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
