import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRuntimeManager, ELECTRON_VERSION } from '../runtime-manager.js'

/** 创建完全隔离的临时目录与假进程。 @param {import('node:test').TestContext} t @param {object} [overrides] */
async function fixture(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'tray-manager-test-'))
  const packageRoot = join(home, 'package')
  await mkdir(join(packageRoot, 'dist', 'desktop'), { recursive: true })
  await writeFile(join(packageRoot, 'dist', 'desktop', 'main.cjs'), '// fake')
  // 默认隔离为已停用，自动安装场景显式传 initialEnabled，避免用例间隐式下载。
  if (overrides.initialEnabled !== undefined || !overrides.freshInstall) {
    await mkdir(join(home, '.dsh', 'dsh-session-tray'), { recursive: true })
    await writeFile(join(home, '.dsh', 'dsh-session-tray', 'manager.json'), JSON.stringify({ schemaVersion: 1, enabled: overrides.initialEnabled ?? false, ui: { resetPositionRevision: 0 } }))
  }
  const calls = []
  let pid = 100
  const deps = { home, platform: 'win32', arch: 'x64', env: { ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' },
    /** @param {string} executable @param {string[]} args @param {object} options */
    spawn(executable, args, options) {
      const child = new EventEmitter()
      child.pid = ++pid
      child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true }
      calls.push({ executable, args, options, child })
      return child
    },
    /** 禁止真实网络。 */
    download() { throw new Error('unexpected network') },
    ...overrides,
  }
  const manager = createRuntimeManager({ packageRoot, url: 'http://127.0.0.1:1234', token: 'secret', deps })
  t.after(async () => { await manager.dispose(); await rm(home, { recursive: true, force: true }) })
  return { home, packageRoot, calls, manager }
}

/** 让微任务和进程事件完成。 */
async function tick() { await new Promise((resolve) => setImmediate(resolve)) }

/** 等待状态变化，超时提供最后状态。 @param {ReturnType<typeof createRuntimeManager>} manager @param {(state: any) => boolean} predicate */
async function until(manager, predicate) {
  for (let i = 0; i < 200; i++) {
    const state = manager.status()
    if (predicate(state)) return state
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(JSON.stringify(manager.status()))
}

/** 构造无压缩 ZIP 的最小结构（仅测试验证器，无真实解压）。 @param {string} name */
function zipFor(name) {
  const bytes = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(bytes.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(bytes.length, 28)
  const body = Buffer.concat([local, bytes])
  const directory = Buffer.concat([central, bytes])
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, directory, end])
}

/** 构造官方清单和假下载。 @param {Buffer} zip @param {string} [digest] */
function installer(zip, digest = createHash('sha256').update(zip).digest('hex')) {
  return {
    /** @param {string} url @param {string} destination @param {object} options */
    async download(url, destination, options) {
      assert.match(url, /^https:\/\/github\.com\/electron\/electron\/releases\/download\//)
      options.signal.throwIfAborted()
      await writeFile(destination, url.endsWith('.txt') ? `${digest}  electron-v${ELECTRON_VERSION}-win32-x64.zip\n` : zip)
    },
    /** @param {string} zipPath @param {string} destination */
    async extract(zipPath, destination) {
      await mkdir(destination, { recursive: true })
      await writeFile(join(destination, 'electron.exe'), 'fake executable')
    },
  }
}

test('已停用时无运行时不下载；状态隔离且可序列化', async (t) => {
  const { manager, calls } = await fixture(t)
  await tick()
  assert.equal(manager.status().phase, 'stopped')
  assert.equal(manager.status().runtime.available, false)
  assert.equal(calls.length, 0)
  const state = manager.status(); state.ui.changed = true
  assert.equal(manager.status().ui.changed, undefined)
  assert.doesNotThrow(() => JSON.stringify(state))
})

test('通知开关写入管理配置，缺省时回退 widget.json', async (t) => {
  const { manager, home } = await fixture(t)
  await writeFile(join(home, '.dsh', 'dsh-session-tray', 'widget.json'), JSON.stringify({ notifyConversation: false, notifyTaskDone: true }))
  assert.equal(manager.status().ui.notifyConversation, false)
  assert.equal(manager.status().ui.notifyTaskDone, true)
  const saved = manager.setNotifyPrefs({ notifyTaskDone: false })
  assert.equal(saved.ui.notifyTaskDone, false)
  assert.equal(JSON.parse(await readFile(join(home, '.dsh', 'dsh-session-tray', 'manager.json'))).ui.notifyTaskDone, false)
})

test('任务完成时长默认10秒，支持常驻与持久化，非法值不覆盖已有配置', async (t) => {
  const { manager, home } = await fixture(t)
  assert.equal(manager.status().ui.taskDoneDurationSeconds, 10)
  await writeFile(join(home, '.dsh', 'dsh-session-tray', 'widget.json'), JSON.stringify({ taskDoneDurationSeconds: 30 }))
  assert.equal(manager.status().ui.taskDoneDurationSeconds, 30)
  assert.equal(manager.setNotifyPrefs({ taskDoneDurationSeconds: 0 }).ui.taskDoneDurationSeconds, 0)
  for (const value of [-1, 1.5, '10', null, Infinity, 86401]) {
    assert.equal(manager.setNotifyPrefs({ taskDoneDurationSeconds: value }).ui.taskDoneDurationSeconds, 0)
  }
  assert.equal(manager.setNotifyPrefs({ notifyTaskDone: false }).ui.taskDoneDurationSeconds, 0)
  assert.equal(JSON.parse(await readFile(join(home, '.dsh', 'dsh-session-tray', 'manager.json'))).ui.taskDoneDurationSeconds, 0)
})

test('通知位置默认浮窗上方，可回退窗口配置并持久化独立右下角模式', async (t) => {
  const { manager, home } = await fixture(t)
  assert.equal(manager.status().ui.notificationPlacement, 'dock')
  await writeFile(join(home, '.dsh', 'dsh-session-tray', 'widget.json'), JSON.stringify({ notificationPlacement: 'corner' }))
  assert.equal(manager.status().ui.notificationPlacement, 'corner')
  assert.equal(manager.setNotifyPrefs({ notificationPlacement: 'dock' }).ui.notificationPlacement, 'dock')
  assert.equal(manager.setNotifyPrefs({ notificationPlacement: 'invalid' }).ui.notificationPlacement, 'dock')
  assert.equal(manager.setNotifyPrefs({ notificationPlacement: 'corner' }).ui.notificationPlacement, 'corner')
  assert.equal(manager.setNotifyPrefs({ notifyConversation: false }).ui.notificationPlacement, 'corner')
  assert.equal(JSON.parse(await readFile(join(home, '.dsh', 'dsh-session-tray', 'manager.json'))).ui.notificationPlacement, 'corner')
})

test('托盘模式默认显示浮窗，回退 widget、独立持久化且不覆盖通知偏好', async (t) => {
  const { manager, home } = await fixture(t)
  const root = join(home, '.dsh', 'dsh-session-tray')
  assert.equal(manager.status().ui.minimizedToTray, false)
  await writeFile(join(root, 'widget.json'), JSON.stringify({ minimizedToTray: true, notifyConversation: false, notificationPlacement: 'corner' }))
  assert.equal(manager.status().ui.minimizedToTray, true)
  const prefs = manager.setNotifyPrefs({ minimizedToTray: false }).ui
  assert.equal(prefs.minimizedToTray, false)
  assert.equal(prefs.notifyConversation, false)
  assert.equal(prefs.notificationPlacement, 'corner')
  for (const value of ['true', 1, null, {}]) assert.equal(manager.setNotifyPrefs({ minimizedToTray: value }).ui.minimizedToTray, false)
  manager.setNotifyPrefs({ notifyTaskDone: false })
  assert.equal(manager.status().ui.minimizedToTray, false)
  const saved = JSON.parse(await readFile(join(root, 'manager.json')))
  assert.equal(saved.ui.minimizedToTray, false)
  assert.equal(saved.ui.notifyConversation, undefined)
  const restarted = createRuntimeManager({ packageRoot: home, url: 'http://localhost', token: 'test', deps: { home, platform: 'linux' } })
  assert.equal(restarted.status().ui.minimizedToTray, false)
  await restarted.dispose()
})

test('预览请求仅在运行就绪时允许，版本只在请求时递增且不持久化', async (t) => {
  const { manager, calls, home } = await fixture(t)
  assert.throws(() => manager.previewNotification(), /尚未运行/)
  const executable = join(home, 'electron.exe')
  await writeFile(executable, 'fake executable')
  // 此用例管理器未注入兼容路径，使用现有隔离安装路径。
  const runtime = join(home, '.dsh', 'dsh-session-tray', 'runtime', `${ELECTRON_VERSION}-x64`)
  await mkdir(runtime, { recursive: true })
  await writeFile(join(runtime, 'electron.exe'), 'fake executable')
  await manager.action('enable')
  await until(manager, (state) => state.phase === 'starting')
  manager.ready(calls[0].child.pid)
  assert.equal(manager.previewNotification().revision, 1)
  assert.equal(manager.previewNotification().revision, 2)
  assert.equal(manager.notificationPreviewRevision(), 2)
  assert.equal(manager.status().ui.previewRevision, undefined)
})

test('首次加载自动安装并启动，状态查询和重复安装不会重复下载', async (t) => {
  let downloads = 0
  const install = installer(zipFor('electron.exe'))
  const { manager, calls } = await fixture(t, {
    freshInstall: true,
    ...install,
    /** @param {string} url @param {string} destination @param {object} options */
    async download(url, destination, options) { downloads++; await install.download(url, destination, options) },
  })
  assert.equal(manager.status().enabled, true)
  assert.equal(manager.status().phase, 'downloading')
  manager.status(); manager.status()
  await manager.action('install')
  await until(manager, (state) => state.phase === 'starting')
  assert.equal(downloads, 2)
  assert.equal(calls.length, 1)
  assert.equal(manager.ready(calls[0].child.pid).phase, 'running')
})

test('首次自动下载可停用取消，停用偏好持久化', async (t) => {
  const entered = new EventEmitter()
  let downloads = 0
  const started = once(entered, 'start')
  const { manager, calls, home } = await fixture(t, {
    freshInstall: true,
    /** @param {string} url @param {string} destination @param {{signal: AbortSignal}} options */
    async download(url, destination, { signal }) {
      downloads++
      entered.emit('start')
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  await started
  await manager.action('disable')
  assert.equal(manager.status().enabled, false)
  assert.equal(manager.status().phase, 'stopped')
  assert.equal(calls.length, 0)
  assert.equal(downloads, 1)
  assert.equal(JSON.parse(await readFile(join(home, '.dsh', 'dsh-session-tray', 'manager.json'))).enabled, false)
})

test('已启用配置自动安装，失败可见且不会由查询触发重试', async (t) => {
  let downloads = 0
  const { manager } = await fixture(t, {
    initialEnabled: true,
    async download() { downloads++; throw new Error('offline') },
  })
  await until(manager, (state) => state.phase === 'error')
  assert.match(manager.status().error, /offline/)
  manager.status(); await tick()
  assert.equal(downloads, 1)
})

test('无运行时时点击启用自动安装，无需单独安装操作', async (t) => {
  const { manager, calls } = await fixture(t, installer(zipFor('electron.exe')))
  await manager.action('enable')
  await until(manager, (state) => state.phase === 'starting')
  assert.equal(calls.length, 1)
  assert.equal(manager.status().enabled, true)
})

test('安装后台校验、原子落盘、启用；ready pid 必须匹配', async (t) => {
  const { manager, calls, home } = await fixture(t, installer(zipFor('electron.exe')))
  const initial = await manager.action('install')
  assert.equal(initial.phase, 'downloading')
  await until(manager, (state) => state.phase === 'starting')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(calls[0].options.env.KEEP, 'yes')
  assert.match(calls[0].args[0], /dist[\\/]desktop[\\/]main\.cjs$/)
  assert.equal(manager.ready(999).phase, 'starting')
  assert.equal(manager.ready(calls[0].child.pid).phase, 'running')
  assert.equal(manager.status().runtime.version, ELECTRON_VERSION)
  assert.equal(JSON.parse(await readFile(join(home, '.dsh', 'dsh-session-tray', 'manager.json'))).enabled, true)
  await manager.action('disable')
  assert.equal(manager.status().phase, 'stopped')
  await manager.action('enable')
  assert.equal(calls.length, 2)
  await manager.action('reset-position')
  assert.equal(manager.status().ui.resetPositionRevision, 1)
  assert.equal(calls.length, 2)
})

test('SHA256 错误禁止解压和启动', async (t) => {
  let extracted = false
  const { manager, calls } = await fixture(t, { ...installer(zipFor('electron.exe'), '0'.repeat(64)), async extract() { extracted = true } })
  await manager.action('install')
  const state = await until(manager, (state) => state.phase === 'error')
  assert.match(state.error, /SHA256/)
  assert.equal(extracted, false); assert.equal(calls.length, 0)
})

test('路径穿越 ZIP 即使 hash 正确也拒绝', async (t) => {
  let extracted = false
  const { manager } = await fixture(t, { ...installer(zipFor('../electron.exe')), async extract() { extracted = true } })
  await manager.action('install')
  assert.match((await until(manager, (state) => state.phase === 'error')).error, /不安全路径/)
  assert.equal(extracted, false)
})

test('兼容旧 runtime，启动失败、退出及超时均可见', async (t) => {
  const { manager, home, calls } = await fixture(t, { startupTimeoutMs: 20 })
  await mkdir(join(home, '.dsh', 'electron'), { recursive: true })
  await writeFile(join(home, '.dsh', 'electron', 'electron.exe'), 'fake')
  await manager.action('enable')
  await until(manager, (state) => state.phase === 'error')
  assert.match(manager.status().error, /启动超时/)
  await tick()
  await manager.action('enable')
  calls.at(-1).child.emit('error', new Error('spawn broken'))
  assert.match(manager.status().error, /spawn 失败/)
  await manager.action('restart')
  calls.at(-1).child.emit('exit', 7, null)
  assert.match(manager.status().error, /意外退出/)
})

test('停止没有退出确认不能 restart 产生第二个进程', async (t) => {
  const { manager, home, calls } = await fixture(t, { stopTimeoutMs: 10 })
  await mkdir(join(home, '.dsh', 'electron'), { recursive: true })
  await writeFile(join(home, '.dsh', 'electron', 'electron.exe'), 'fake')
  await manager.action('enable')
  calls[0].child.kill = () => true
  await manager.action('restart')
  assert.equal(calls.length, 1)
  assert.match(manager.status().error, /停止超时/)
  calls[0].child.emit('exit', 0, null)
})

test('dispose 取消下载并且不会安装或启动；幂等', async (t) => {
  const entered = new EventEmitter()
  const { manager, calls } = await fixture(t, {
    /** @param {string} url @param {string} destination @param {object} options */
    async download(url, destination, { signal }) {
      entered.emit('start')
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  const started = once(entered, 'start')
  await manager.action('install')
  await started
  const first = manager.dispose(); const second = manager.dispose()
  assert.equal(first, second)
  await first
  assert.equal(manager.status().phase, 'stopped')
  assert.equal(calls.length, 0)
})

test('未知 action 明确拒绝，不启用不下载', async (t) => {
  const { manager, calls } = await fixture(t)
  assert.match((await manager.action('not-an-action')).error, /未知运行时操作/)
  assert.equal(calls.length, 0)
})

test('并发 install 去重；disable 中止安装且保持禁用', async (t) => {
  let downloads = 0
  const entered = new EventEmitter()
  const { manager } = await fixture(t, {
    /** @param {string} url @param {string} destination @param {object} options */
    async download(url, destination, { signal }) {
      downloads++
      entered.emit('start')
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  const started = once(entered, 'start')
  await Promise.all([manager.action('install'), manager.action('install')])
  await started
  await manager.action('disable')
  assert.equal(downloads, 1)
  assert.equal(manager.status().enabled, false)
  assert.equal(manager.status().phase, 'stopped')
})

test('清理 EBUSY 不覆盖主错误', async (t) => {
  const { manager } = await fixture(t, {
    ...installer(zipFor('electron.exe'), '0'.repeat(64)),
    /** 模拟临时目录文件锁。 */
    async removeTemp() { throw new Error('EBUSY default_app.asar') },
  })
  await manager.action('install')
  await until(manager, (state) => state.phase === 'error')
  await tick()
  assert.match(manager.status().error, /SHA256/)
  assert.doesNotMatch(manager.status().error, /EBUSY/)
})

test('清理 EBUSY 不破坏安装成功及 ready 状态', async (t) => {
  const { manager, calls } = await fixture(t, {
    ...installer(zipFor('electron.exe')),
    /** 模拟临时目录文件锁。 */
    async removeTemp() { throw new Error('EBUSY default_app.asar') },
  })
  await manager.action('install')
  await until(manager, (state) => state.phase === 'starting')
  await tick()
  manager.ready(calls[0].child.pid)
  assert.equal(manager.status().phase, 'running')
  assert.equal(manager.status().error, null)
})

test('非 Windows/macOS 平台不联网安装', async (t) => {
  const { manager } = await fixture(t, { platform: 'linux' })
  assert.equal(manager.status().supported, false)
  assert.match((await manager.action('install')).error, /Windows/)
})

for (const platform of ['win32', 'darwin']) for (const arch of ['x64', 'arm64']) {
  test(`${platform}/${arch} 安装、校验、ready、重启及停用`, async (t) => {
    const executable = platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe'
    const zip = zipFor(executable)
    const digest = createHash('sha256').update(zip).digest('hex')
    const urls = []
    const { manager, calls } = await fixture(t, {
      platform, arch,
      // Keep installer cleanup deterministic; fixture teardown removes its whole home.
      async removeTemp() {},
      async download(url, destination) {
        urls.push(url)
        await writeFile(destination, url.endsWith('.txt') ? `${digest}  electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip\n` : zip)
      },
      async extract(_zip, destination, _signal, receivedPlatform) {
        assert.equal(receivedPlatform, platform)
        const target = join(destination, executable)
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, 'fake executable', { mode: 0o755 })
      },
    })
    assert.equal(manager.status().supported, true)
    await manager.action('install')
    await until(manager, state => state.phase === 'starting')
    assert.equal(urls.length, 2)
    assert.ok(urls[1].endsWith(`-${platform}-${arch}.zip`))
    assert.ok(calls[0].executable.endsWith(executable))
    assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined)
    assert.match(calls[0].options.env.DSH_SESSION_TRAY_ICON, platform === 'darwin' ? /trayTemplate.png$/ : /tray.png$/)
    manager.ready(calls[0].child.pid)
    assert.equal(manager.status().phase, 'running')
    assert.equal(manager.status().runtime.version, ELECTRON_VERSION)
    await manager.action('restart')
    assert.equal(calls.length, 2)
    manager.ready(calls[1].child.pid)
    await manager.action('disable')
    assert.equal(manager.status().phase, 'stopped')
    assert.equal(manager.status().enabled, false)
    assert.equal(manager.status().runtime.available, true)
  })
}

test('macOS 拒绝没有可执行权限的兼容运行时', async (t) => {
  const { home, manager } = await fixture(t, { platform: 'darwin' })
  const executable = join(home, '.dsh', 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  await mkdir(join(executable, '..'), { recursive: true })
  await writeFile(executable, 'not executable', { mode: 0o644 })
  await manager.action('enable')
  await until(manager, state => state.phase === 'error')
  assert.equal(manager.status().runtime.available, false)
})
