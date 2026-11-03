import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { renderLayoutMock } from '../scripts/sync-layout-mock.mjs'
import { registerSettings } from '../settings-client.js'

/** 创建可手动完成的网络响应。 */
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** 仅运行 hooks、保留元素属性，不模拟浏览器布局或生成预览。 */
function hooks() {
  const values = [], cleanups = []
  let cursor = 0, component, mounted = false
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = cursor++
      if (!(index in values)) values[index] = initial
      return [values[index], (value) => { values[index] = value }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in values)) values[index] = { current: initial }
      return values[index]
    },
    useEffect(effect) { if (!mounted) cleanups.push(effect()) },
    useSyncExternalStore(subscribe, snapshot) {
      if (!mounted) cleanups.push(subscribe(() => {}))
      return snapshot()
    },
  }
  return {
    React,
    mount(value) { component = value; return this.render() },
    render() { cursor = 0; const tree = component(); mounted = true; return tree },
    unmount() { for (const cleanup of cleanups.splice(0).reverse()) cleanup?.() },
  }
}

/** 收集树中的按钮或提示节点。 */
function nodes(tree, match) {
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...tree.children.flatMap((child) => nodes(child, match))]
}
/** 读取可观察文案。 */
function text(tree) {
  if (tree == null || tree === false) return ''
  if (typeof tree !== 'object') return String(tree)
  return tree.children.map(text).join(' ')
}
/** 清空网络 promise 链；不依赖真实计时器。 */
async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve() }
/** 创建标准状态。 */
function status(overrides = {}) {
  return { supported: true, platform: 'win32', arch: 'x64', enabled: false, runtime: { available: true, path: 'C:/runtime', version: '40' }, phase: 'stopped', progress: null, error: null, pid: null, ui: {}, ...overrides }
}
/** 标准网络响应。 */
function response(body, code = 200) { return { ok: code >= 200 && code < 300, status: code, text: async () => JSON.stringify(body) } }

/** 建立完全隔离的 fetch、计时器、locale、slot 边界，并在用例结束恢复。 */
function fixture(t) {
  const original = Object.fromEntries(['fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'].map((name) => [name, globalThis[name]]))
  const intervals = new Map(), timeouts = new Map(), calls = [], effects = [], dictionaries = new Map()
  const view = hooks()
  let id = 0, entry, Component, language = 'zh', subscribers = 0
  globalThis.setInterval = (fn, ms) => { const key = ++id; intervals.set(key, { fn, ms }); return key }
  globalThis.clearInterval = (key) => intervals.delete(key)
  globalThis.setTimeout = (fn, ms) => { const key = ++id; timeouts.set(key, { fn, ms }); return key }
  globalThis.clearTimeout = (key) => timeouts.delete(key)
  globalThis.fetch = (url, options) => {
    const pending = deferred()
    calls.push({ url, options, ...pending })
    return pending.promise
  }
  const ctx = {
    effect(effect) { effects.push(effect()) },
    locale: {
      register(ns, lang, dict) { dictionaries.set(lang, dict); return () => dictionaries.delete(lang) },
      bind() { return (key) => dictionaries.get(language)[key] },
      subscribe() { subscribers++; return () => { subscribers-- } },
      getSnapshot() { return language },
    },
    slots: {
      inject(name, callback) { assert.equal(name, 'settings.section'); effects.push(callback()) },
      register(options, component) { entry = options; Component = component; return () => {} },
    },
  }
  registerSettings(ctx, view.React)
  t.after(() => {
    view.unmount()
    for (const cleanup of effects.reverse()) cleanup?.()
    Object.assign(globalThis, original)
  })
  return {
    calls, intervals, timeouts, view, entry,
    mount: () => view.mount(Component),
    tick: () => { for (const item of intervals.values()) item.fn() },
    language: (value) => { language = value },
    subscribers: () => subscribers,
  }
}

test('registers localized settings and polls only while mounted without overlapping requests', async (t) => {
  const f = fixture(t)
  assert.equal(f.entry.id, 'dsh-session-tray-settings')
  assert.equal(f.entry.order, 31)
  assert.equal(f.entry.label(), '桌面状态栏')
  assert.equal(f.calls.length, 0)
  f.mount()
  assert.equal(f.calls.length, 1)
  assert.equal([...f.intervals.values()][0].ms, 2000)
  assert.equal(f.calls[0].options.credentials, 'same-origin')
  f.tick(); f.tick()
  assert.equal(f.calls.length, 1)
  f.calls[0].resolve(response(status()))
  await settle()
  assert.match(text(f.view.render()), /已停止/)
  f.language('en')
  assert.equal(f.entry.label(), 'Desktop Status Bar')
  assert.match(text(f.view.render()), /Stopped/)
  f.tick()
  assert.equal(f.calls.length, 2)
  f.view.unmount()
  assert.equal(f.calls[1].options.signal.aborted, true)
  assert.equal(f.intervals.size, 0)
  assert.equal(f.subscribers(), 0)
  f.calls[1].resolve(response(status({ phase: 'running' })))
  await settle()
  assert.match(text(f.view.render()), /Stopped/)
})

test('serializes duplicate clicks, cancels stale GET and waits for authoritative state before unlocking', async (t) => {
  const f = fixture(t)
  f.mount()
  f.calls[0].resolve(response(status()))
  await settle()
  f.tick()
  const stale = f.calls[1]
  const enable = nodes(f.view.render(), (node) => node.type === 'button' && text(node) === '启用')[0]
  enable.props.onClick(); enable.props.onClick()
  assert.equal(stale.options.signal.aborted, true)
  assert.equal(f.calls.length, 3)
  const post = f.calls[2]
  assert.equal(post.url, '/dsh-session-tray/manage/action')
  assert.equal(post.options.method, 'POST')
  assert.equal(post.options.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(post.options.body), { action: 'enable' })
  f.tick()
  assert.equal(f.calls.length, 3)
  stale.resolve(response(status({ phase: 'error', error: 'stale failure' })))
  post.resolve(response({ ok: true }))
  await settle()
  assert.equal(f.calls.length, 4)
  assert.ok(nodes(f.view.render(), (node) => node.type === 'button').every((node) => node.props.disabled))
  assert.doesNotMatch(text(f.view.render()), /stale failure/)
  f.calls[3].resolve(response(status({ enabled: true, phase: 'running', pid: 123 })))
  await settle()
  const disable = nodes(f.view.render(), (node) => node.type === 'button' && text(node) === '停用')[0]
  assert.equal(disable.props.disabled, false)
  assert.match(text(f.view.render()), /123/)
})

test('surfaces failed actions and read failures, recovers on next poll and shows progress', async (t) => {
  const f = fixture(t)
  f.mount()
  f.calls[0].resolve(response(status({ runtime: { available: false } })))
  await settle()
  nodes(f.view.render(), (node) => node.type === 'button' && text(node) === '安装并启用')[0].props.onClick()
  f.calls[1].resolve(response({ error: 'download denied' }, 500))
  await settle()
  f.calls[2].reject(new Error('network offline'))
  await settle()
  let tree = f.view.render()
  assert.match(text(tree), /download denied/)
  assert.match(text(tree), /network offline/)
  assert.ok(nodes(tree, (node) => node.type === 'button').every((node) => node.props.disabled))
  f.tick()
  f.calls[3].resolve(response(status({ enabled: true, phase: 'downloading', progress: 37, runtime: { available: false } })))
  await settle()
  tree = f.view.render()
  assert.doesNotMatch(text(tree), /network offline/)
  assert.equal(nodes(tree, (node) => node.type === 'progress')[0].props.value, 37)
  assert.equal(nodes(tree, (node) => node.type === 'button' && text(node) === '停用')[0].props.disabled, false)
  assert.ok(nodes(tree, (node) => node.type === 'button' && text(node) !== '停用').every((node) => node.props.disabled))
  assert.match(text(tree), /自动下载/)
  assert.doesNotMatch(text(tree), /此处操作的是|hostNote/)
  nodes(tree, (node) => node.type === 'button' && text(node) === '停用')[0].props.onClick()
  assert.deepEqual(JSON.parse(f.calls[4].options.body), { action: 'disable' })
})

test('notification switches post the shared prefs and render inside the settings cards', async (t) => {
  const f = fixture(t)
  f.mount()
  f.calls[0].resolve(response(status({ ui: { notifyConversation: true, notifyTaskDone: false } })))
  await settle()
  const tree = f.view.render()
  assert.equal(nodes(tree, (node) => node.props?.className === 'dst-card').length, 2)
  assert.match(text(tree), /桌面端/)
  assert.match(text(tree), /任务完成通知/)
  const task = nodes(tree, (node) => node.type === 'input' && node.props.id === 'notifyTaskDone')[0]
  assert.equal(task.props.checked, false)
  task.props.onChange({ target: { checked: true } })
  assert.equal(f.calls[1].url, '/dsh-session-tray/manage/notify-prefs')
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { notifyConversation: true, notifyTaskDone: true, taskDoneDurationSeconds: 10, notificationPlacement: 'dock' })
})

test('duration selector retains valid values, posts numbers and localizes new-notice guidance', async (t) => {
  const f = fixture(t)
  f.mount()
  f.calls[0].resolve(response(status({ ui: { notifyConversation: false, taskDoneDurationSeconds: 42 } })))
  await settle()
  let tree = f.view.render()
  const select = nodes(tree, (node) => node.type === 'select' && node.props.id === 'taskDoneDurationSeconds')[0]
  assert.equal(select.props.value, 42)
  assert.deepEqual(select.children.map((node) => node.props.value), [5, 10, 15, 30, 60, 42, 0])
  assert.match(text(tree), /修改仅对新通知生效/)
  assert.doesNotMatch(text(tree), /3 秒/)
  select.props.onChange({ target: { value: '0' } })
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { notifyConversation: false, notifyTaskDone: true, taskDoneDurationSeconds: 0, notificationPlacement: 'dock' })
  f.calls[1].resolve(response({ ok: true }))
  await settle()
  f.calls[2].resolve(response(status({ ui: { taskDoneDurationSeconds: 0 } })))
  await settle()
  assert.equal(nodes(f.view.render(), (node) => node.type === 'select' && node.props.id === 'taskDoneDurationSeconds')[0].props.value, 0)
  f.language('en')
  tree = f.view.render()
  assert.match(text(tree), /Changes apply to new notices only/)
  assert.match(text(tree), /Never dismiss automatically/)
})

test('invalid stored durations fall back to 10 seconds without coercing strings', async (t) => {
  const f = fixture(t)
  f.mount()
  for (const value of [undefined, null, '30', -1, 1.5, 86401, Number.MAX_SAFE_INTEGER]) {
    f.calls.at(-1).resolve(response(status({ ui: { taskDoneDurationSeconds: value } })))
    await settle()
    assert.equal(nodes(f.view.render(), (node) => node.type === 'select' && node.props.id === 'taskDoneDurationSeconds')[0].props.value, 10)
    // 每轮开始下一次权威读取，不依赖实际时间。
    f.tick()
  }
})

/** 在隔离 VM 中执行设置页或预览脚本，观察桥接和计时器行为。 */
function browserHarness() {
  const elements = new Map(), events = {}, timers = new Map(), messages = [], writes = []
  let timerId = 0, prefsCallback
  /** 提供脚本实际使用的最小 DOM 边界。 @param {string} id */
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'scenario' ? 'mixed' : '10', checked: true, style: {}, dataset: {}, options: [], handlers: {},
      contentWindow: { postMessage: (message) => messages.push({ ...message, frameId: id }) },
      addEventListener(type, callback) { this.handlers[type] = callback },
      querySelectorAll() { return this.options.filter((option) => 'custom' in option.dataset) },
      appendChild(option) { this.options.push(option) },
    })
    return elements.get(id)
  }
  const context = {
    document: { getElementById: element, createElement: () => ({ dataset: {}, remove() {} }) },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id) => timers.delete(id),
    window: { close() {}, addEventListener: (type, callback) => { events[type] = callback },
      sessionDock: { previewNotification: async () => ({ ok: true }), getNotifyPrefs: async () => ({ taskDoneDurationSeconds: 30, notificationPlacement: 'corner' }), setNotifyPrefs: (value) => writes.push(value), onNotifyPrefs: (callback) => { prefsCallback = callback } } },
  }
  return { context, element, timers, messages, writes, events, applyPrefs: (value) => prefsCallback(value) }
}

test('desktop settings size matches preview and stays inside small work areas', async () => {
  const source = await readFile(new URL('../helper/main.cjs', import.meta.url), 'utf8')
  const sizing = source.match(/  const width = Math\.min\(560, area\.width\)[\s\S]*?(?=  settings = new BrowserWindow)/)?.[0]
  assert.ok(sizing, '设置窗口应按工作区限制尺寸')
  for (const area of [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -480, y: 40, width: 480, height: 540 }]) {
    const result = runInNewContext(`${sizing}; ({ width, height, x, y })`, { area })
    assert.equal(result.width, Math.min(560, area.width))
    assert.equal(result.height, Math.min(640, area.height))
    assert.ok(result.x >= area.x && result.x + result.width <= area.x + area.width)
    assert.ok(result.y >= area.y && result.y + result.height <= area.y + area.height)
  }
  const page = await renderLayoutMock()
  assert.match(page, /\.settings-frame \{ width: 560px; height: 640px; \}/)
  assert.match(page, /设置 · 560 × 640/)
})

test('desktop settings read, broadcast and save numeric durations while retaining both switches', async () => {
  const source = await readFile(new URL('../helper/settings.html', import.meta.url), 'utf8')
  const f = browserHarness()
  runInNewContext(source.match(/<script>([\s\S]*?)<\/script>/)[1], f.context)
  await settle()
  assert.equal(f.element('task-done-duration').value, '30')
  f.element('task-done-duration').value = '0'
  f.element('task-done-duration').handlers.change()
  assert.deepEqual(JSON.parse(JSON.stringify(f.writes[0])), { notifyConversation: true, notifyTaskDone: true, taskDoneDurationSeconds: 0, notificationPlacement: 'corner' })
  f.applyPrefs({ notifyConversation: false, notifyTaskDone: false, taskDoneDurationSeconds: '60' })
  assert.equal(f.element('task-done-duration').value, '10')
  assert.equal(f.element('notify-conversation').checked, false)
  assert.equal(f.element('notify-task-done').checked, false)
  assert.match(source, /修改仅对新通知生效/)
  assert.doesNotMatch(source, /3 秒/)
})

test('preview replay uses selected duration, preserves existing timer on edits and never times out zero', async () => {
  // 只生成内存字符串，不执行 sync，不写生成文件。
  const page = await renderLayoutMock()
  const f = browserHarness()
  runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], f.context)
  const replay = () => f.element('replay-done').handlers.click()
  const prefs = (seconds, notifyTaskDone = true) => f.events.message({
    source: f.element('settings').contentWindow,
    data: { preview: true, id: 'settings', type: 'prefs', value: { taskDoneDurationSeconds: seconds, notifyTaskDone } },
  })
  replay()
  assert.equal([...f.timers.values()][0].ms, 10000)
  prefs(30)
  assert.equal([...f.timers.values()][0].ms, 10000)
  assert.match(f.element('replay-done').textContent, /30 秒/)
  replay()
  assert.equal([...f.timers.values()][0].ms, 30000)
  prefs(0)
  replay()
  assert.equal(f.timers.size, 0)
  assert.match(f.element('status').textContent, /不自动消失/)
  prefs(-1)
  replay()
  assert.equal([...f.timers.values()][0].ms, 10000)
  prefs(60, false)
  replay()
  assert.equal(f.timers.size, 0)
  assert.match(f.element('status').textContent, /已关闭/)
})

test('unmount aborts an action and ignores its eventual completion without starting another GET', async (t) => {
  const f = fixture(t)
  f.mount()
  f.calls[0].resolve(response(status()))
  await settle()
  nodes(f.view.render(), (node) => node.type === 'button' && text(node) === '启用')[0].props.onClick()
  f.view.unmount()
  assert.equal(f.calls[1].options.signal.aborted, true)
  f.calls[1].resolve(response({ ok: true }))
  await settle()
  assert.equal(f.calls.length, 2)
  assert.equal(f.timeouts.size, 0)
})


test('settings restore selectable dock and corner placement with dock as default', async (t) => {
  const f = fixture(t)
  f.mount()
  f.calls[0].resolve(response(status({ ui: { notifyTaskDone: false, taskDoneDurationSeconds: 30 } })))
  await settle()
  const tree = f.view.render()
  assert.match(text(tree), /桌面右下角/)
  assert.match(text(tree), /默认跟随悬浮框/)
  const placement = nodes(tree, (node) => node.props.id === 'notificationPlacement')[0]
  assert.equal(placement.props.value, 'dock')
  placement.props.onChange({ target: { value: 'corner' } })
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { notifyConversation: true, notifyTaskDone: false, taskDoneDurationSeconds: 30, notificationPlacement: 'corner' })
  f.language('en')
  assert.match(text(f.view.render()), /desktop bottom-right/)
})

test('desktop settings default to dock and allow explicit corner placement', async () => {
  const source = await readFile(new URL('../helper/settings.html', import.meta.url), 'utf8')
  const f = browserHarness()
  runInNewContext(source.match(/<script>([\s\S]*?)<\/script>/)[1], f.context)
  await settle()
  f.applyPrefs({ notifyConversation: false, taskDoneDurationSeconds: 42 })
  f.element('notify-task-done').handlers.change()
  assert.equal(f.writes[0].notificationPlacement, 'dock')
  f.element('notification-placement').value = 'corner'
  f.element('notification-placement').handlers.change()
  assert.equal(f.writes[1].notificationPlacement, 'corner')
  assert.equal(f.writes[0].notifyConversation, false)
  assert.equal(f.writes[0].taskDoneDurationSeconds, 42)
})

test('tray switch restores authoritative state and submits only the tray preference', async (t) => {
  const f = fixture(t)
  const toggle = () => nodes(f.view.render(), node => node.props.id === 'minimizedToTray')[0]
  f.mount()
  assert.equal(toggle().props.disabled, true)
  f.calls[0].resolve(response(status({ phase: 'running', ui: { minimizedToTray: true } })))
  await settle()
  assert.equal(toggle().props.checked, true)
  assert.match(text(f.view.render()), /单击系统托盘图标恢复/)
  toggle().props.onChange({ target: { checked: false } })
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { minimizedToTray: false })
  assert.equal(toggle().props.disabled, true)
  f.calls[1].resolve(response({ ok: true }))
  await settle()
  f.calls[2].resolve(response(status({ phase: 'running', ui: { minimizedToTray: false } })))
  await settle()
  assert.equal(toggle().props.checked, false)
  assert.equal(toggle().props.disabled, false)
  f.tick()
  f.calls[3].resolve(response(status({ phase: 'running', ui: { minimizedToTray: true } })))
  await settle()
  assert.equal(toggle().props.checked, true)
  f.language('en')
  assert.match(text(f.view.render()), /Minimize to system tray/)
})

test('mock tray switch hides overlays and restores state without system operations', async () => {
  const page = await renderLayoutMock(), f = browserHarness()
  runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], f.context)
  f.element('tray-mode').handlers.change({ target: { checked: true } })
  assert.equal(f.element('bar').style.display, 'none')
  assert.equal(f.element('card').style.display, 'none')
  assert.match(f.element('status').textContent, /最小化到托盘/)
  f.element('restore-tray').handlers.click()
  assert.equal(f.element('bar').style.display, '')
  assert.equal(f.element('tray-mode').checked, false)
  assert.match(page, /不创建系统托盘/)
})

test('web preview requires running prefs, sends empty JSON and reports success or failure', async (t) => {
  const f = fixture(t)
  const preview = () => nodes(f.view.render(), (node) => node.type === 'button' && text(node) === '预览通知')[0]
  f.mount()
  assert.equal(preview().props.disabled, true)
  f.calls[0].resolve(response(status()))
  await settle()
  assert.equal(preview().props.disabled, true)
  f.tick()
  f.calls[1].resolve(response(status({ phase: 'running', ui: { notifyTaskDone: false, taskDoneDurationSeconds: 42, notificationPlacement: 'corner' } })))
  await settle()
  assert.equal(preview().props.disabled, false)
  const button = preview()
  button.props.onClick(); button.props.onClick()
  assert.equal(f.calls.length, 3)
  assert.equal(f.calls[2].url, '/dsh-session-tray/manage/preview-notification')
  assert.equal(f.calls[2].options.method, 'POST')
  assert.equal(f.calls[2].options.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(f.calls[2].options.body), {})
  f.calls[2].resolve(response({ ok: true }))
  await settle()
  assert.match(text(f.view.render()), /已请求预览/)
  f.calls[3].resolve(response(status({ phase: 'running' })))
  await settle()
  preview().props.onClick()
  f.calls[4].resolve(response({ ok: false, error: 'preview unavailable' }, 503))
  await settle()
  assert.match(text(f.view.render()), /preview unavailable/)
})

test('web preview is blocked while current placement preferences are saving', async (t) => {
  const f = fixture(t)
  f.mount(); f.calls[0].resolve(response(status({ phase: 'running' })))
  await settle()
  const tree = f.view.render()
  const preview = nodes(tree, node => node.type === 'button' && text(node) === '预览通知')[0]
  nodes(tree, node => node.props.id === 'notificationPlacement')[0].props.onChange({ target: { value: 'corner' } })
  preview.props.onClick()
  assert.equal(f.calls.length, 2)
  assert.equal(nodes(f.view.render(), node => node.type === 'button' && text(node) === '预览通知')[0].props.disabled, true)
})

test('desktop preview stays disabled until prefs resolve and handles success, false and rejection', async () => {
  const source = await readFile(new URL('../helper/settings.html', import.meta.url), 'utf8')
  const f = browserHarness(), prefs = deferred(), preview = deferred()
  f.context.window.sessionDock.getNotifyPrefs = () => prefs.promise
  let calls = 0
  f.context.window.sessionDock.previewNotification = () => { calls++; return preview.promise }
  runInNewContext(source.match(/<script>([\s\S]*?)<\/script>/)[1], f.context)
  // 初始 disabled 来自真实 HTML；测试替身显式保留该标记。
  assert.match(source, /id="preview-notification"[^>]*disabled/)
  f.element('preview-notification').disabled = true
  await f.element('preview-notification').handlers.click()
  assert.equal(calls, 0)
  prefs.resolve({ notifyTaskDone: false, taskDoneDurationSeconds: 42, notificationPlacement: 'corner' })
  await settle()
  assert.equal(f.element('preview-notification').disabled, false)
  const pending = f.element('preview-notification').handlers.click()
  assert.equal(f.element('preview-notification').disabled, true)
  await f.element('preview-notification').handlers.click()
  assert.equal(calls, 1)
  preview.resolve({ ok: true }); await pending
  assert.match(f.element('preview-feedback').textContent, /已请求预览/)
  f.context.window.sessionDock.previewNotification = async () => ({ ok: false })
  await f.element('preview-notification').handlers.click()
  assert.match(f.element('preview-feedback').textContent, /预览失败/)
  f.context.window.sessionDock.previewNotification = async () => { throw new Error('IPC failed') }
  await f.element('preview-notification').handlers.click()
  assert.match(f.element('preview-feedback').textContent, /IPC failed/)
  assert.equal(f.element('preview-notification').disabled, false)
})

test('mock manual preview ignores automatic switch and shows selected corner placement and duration', async () => {
  const page = await renderLayoutMock(), f = browserHarness()
  runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], f.context)
  const send = (type, value) => f.events.message({ source: f.element('settings').contentWindow, data: { preview: true, id: 'settings', type, value } })
  send('prefs', { notifyTaskDone: false, notificationPlacement: 'corner', taskDoneDurationSeconds: 42 })
  send('preview-notification')
  assert.equal([...f.timers.values()][0].ms, 42000)
  const latest = (id) => f.messages.filter(message => message.frameId === id && message.type === 'notifications').at(-1).value
  assert.equal(latest('corner-notices').find(row => row.kind === 'done').durationSeconds, 42)
  assert.equal(latest('compact-notices').length, 0)
  send('prefs', { notifyTaskDone: false, notificationPlacement: 'dock', taskDoneDurationSeconds: 0 })
  assert.equal(latest('compact-notices').find(row => row.kind === 'done').durationSeconds, 42)
  send('preview-notification')
  assert.equal(f.timers.size, 0)
  assert.equal(latest('compact-notices').find(row => row.kind === 'done').durationSeconds, 0)
  assert.match(f.element('settings').srcdoc, /previewNotification: async/)
  assert.doesNotMatch(f.element('settings').srcdoc, /fetch\(/)
})

test('preview keeps notice width with the overlay and labels corner placement as non-runtime', async () => {
  const page = await renderLayoutMock()
  const f = browserHarness()
  runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], f.context)
  f.element('width').handlers.input({ target: { value: '620' } })
  assert.equal(f.element('bar').style.width, '620px')
  assert.equal(f.element('regular-notices').style.width, '620px')
  assert.match(page, /不是系统级位置验收/)
  assert.match(page, /屏幕右下角/)
  assert.match(page, /\.corner-anchor \{[^}]*right: 4px; bottom: 4px;/)
  assert.match(page, /距工作区右侧和底部各 4 px/)
})
