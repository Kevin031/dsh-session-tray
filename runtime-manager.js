/** Electron 安装与助手生命周期；默认启用时自动补齐运行时，状态查询不产生网络请求。 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Electron 宿主的 node:fs 会把 default_app.asar 虚拟为目录，运行时安装必须操作物理文件。
const require = createRequire(import.meta.url)
/** @returns {typeof import('node:fs')} */
function physicalFs() {
  try { return require('original-fs') } catch (error) {
    if (process.versions.electron) throw new Error(`Electron original-fs 不可用：${message(error)}`)
    return nodeFs
  }
}
const nativeFs = physicalFs()
const { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, createReadStream, createWriteStream } = nativeFs
const fs = nativeFs.promises

// 固定官方稳定版本，不接受来自 UI、环境变量或远端清单的版本覆盖。
export const ELECTRON_VERSION = '45.1.0'
const RELEASE = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`
const ZIP_LIMIT = 350 * 1024 * 1024
const EXPANDED_LIMIT = 1200 * 1024 * 1024

/** 0 表示不自动消失；限制秒数，避免计时器溢出。 @param {unknown} value @returns {value is number} */
export function validTaskDoneDuration(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86400
}

/** @typedef {{platform?: string, arch?: string, home?: string, env?: NodeJS.ProcessEnv, spawn?: typeof spawn, download?: typeof download, extract?: typeof extract, removeTemp?: typeof removeTemp, startupTimeoutMs?: number, stopTimeoutMs?: number}} Dependencies */

/**
 * 创建独立管理器。deps 仅供可信的宿主/单元测试注入，不得映射到 HTTP 请求参数。
 * action 返回 Promise<JSON 状态>；install 立即返回，安装在后台运行。dispose 必须 await。
 * @param {{packageRoot: string, url: string, token: string, log?: (level: 'info'|'warn', message: string) => void, deps?: Dependencies}} options
 */
export function createRuntimeManager({ packageRoot, url, token, log = () => {}, deps = {} }) {
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const root = join(home, '.dsh', 'dsh-session-tray')
  const configPath = join(root, 'manager.json')
  const runtimeDir = join(root, 'runtime', `${ELECTRON_VERSION}-${arch}`)
  const supported = platform === 'win32' && ['x64', 'arm64'].includes(arch)
  const launch = deps.spawn ?? spawn
  let disposed = false
  let child = null
  let startupTimer = null
  let installJob = null
  let controller = null
  let queue = Promise.resolve()
  let stopPromise = null
  let disposePromise = null
  /** @type {{ schemaVersion: number, enabled: boolean, ui: { resetPositionRevision: number, notifyConversation?: boolean, notifyTaskDone?: boolean, taskDoneDurationSeconds?: number, notificationPlacement?: 'dock' | 'corner', minimizedToTray?: boolean } }} */
  let config = { schemaVersion: 1, enabled: true, ui: { resetPositionRevision: 0 } }
  let configError = null
  let recoveryError = null
  try {
    if (existsSync(configPath)) {
      const saved = JSON.parse(readFileSync(configPath, 'utf8'))
      if (saved?.schemaVersion !== 1 || typeof saved.enabled !== 'boolean' || !saved.ui || typeof saved.ui !== 'object' || Array.isArray(saved.ui)) throw new Error('manager.json 格式或版本无效')
      config = { schemaVersion: 1, enabled: saved.enabled, ui: { ...saved.ui, resetPositionRevision: Number.isSafeInteger(saved.ui.resetPositionRevision) && saved.ui.resetPositionRevision >= 0 ? saved.ui.resetPositionRevision : 0 } }
    }
  } catch (error) { configError = message(error) }
  const state = { supported, platform, arch, enabled: config.enabled, runtime: { available: false, path: null, version: null }, phase: 'stopped', progress: null, error: configError, pid: null, ui: config.ui }

  /** 刷新本地可执行文件，外部兼容路径版本未知，不执行探测命令。 */
  function discover() {
    const choices = [env.DSH_SESSION_TRAY_ELECTRON, join(runtimeDir, 'electron.exe'), join(home, '.dsh', 'electron', 'electron.exe')].filter(Boolean)
    const path = supported ? choices.find((candidate) => { try { return existsSync(candidate) && readExecutable(candidate) } catch { return false } }) : null
    state.runtime = { available: Boolean(path), path: path || null, version: path === join(runtimeDir, 'electron.exe') ? ELECTRON_VERSION : null }
  }
  /**
   * 管理配置里的显式开关优先；没有时回退到悬浮框自己保存的 widget.json。
   * @returns {{ notifyConversation: boolean, notifyTaskDone: boolean, taskDoneDurationSeconds: number, notificationPlacement: 'dock' | 'corner', minimizedToTray: boolean }}
   */
  function resolvedNotifyPrefs() {
    /** @type {{ notifyConversation?: unknown, notifyTaskDone?: unknown, taskDoneDurationSeconds?: unknown, notificationPlacement?: unknown, minimizedToTray?: unknown }} */
    let widget = {}
    try { widget = JSON.parse(readFileSync(join(root, 'widget.json'), 'utf8')) } catch { widget = {} }
    return {
      minimizedToTray: typeof config.ui.minimizedToTray === 'boolean' ? config.ui.minimizedToTray : widget.minimizedToTray === true,
      notifyConversation: typeof config.ui.notifyConversation === 'boolean' ? config.ui.notifyConversation : widget.notifyConversation !== false,
      notifyTaskDone: typeof config.ui.notifyTaskDone === 'boolean' ? config.ui.notifyTaskDone : widget.notifyTaskDone !== false,
      notificationPlacement: config.ui.notificationPlacement === 'dock' || config.ui.notificationPlacement === 'corner' ? config.ui.notificationPlacement : widget.notificationPlacement === 'corner' ? 'corner' : 'dock',
      taskDoneDurationSeconds: validTaskDoneDuration(config.ui.taskDoneDurationSeconds) ? config.ui.taskDoneDurationSeconds : validTaskDoneDuration(widget.taskDoneDurationSeconds) ? widget.taskDoneDurationSeconds : 10,
    }
  }
  /** 返回隔离副本，防止 UI 改写内部状态。通知开关始终带上，供设置页和悬浮框同步。 */
  function status() {
    const copy = JSON.parse(JSON.stringify(state))
    copy.ui = { ...copy.ui, ...resolvedNotifyPrefs() }
    return copy
  }
  /**
   * 只更新通知偏好，不重启进程。
   * @param {{ notifyConversation?: unknown, notifyTaskDone?: unknown, taskDoneDurationSeconds?: unknown, notificationPlacement?: unknown, minimizedToTray?: unknown }} prefs
   * @returns {ReturnType<typeof status>}
   */
  function setNotifyPrefs(prefs) {
    if (disposed) return status()
    const next = { ...config.ui }
    if (typeof prefs?.minimizedToTray === 'boolean') next.minimizedToTray = prefs.minimizedToTray
    if (typeof prefs?.notifyConversation === 'boolean') next.notifyConversation = prefs.notifyConversation
    if (typeof prefs?.notifyTaskDone === 'boolean') next.notifyTaskDone = prefs.notifyTaskDone
    if (validTaskDoneDuration(prefs?.taskDoneDurationSeconds)) next.taskDoneDurationSeconds = prefs.taskDoneDurationSeconds
    if (prefs?.notificationPlacement === 'dock' || prefs?.notificationPlacement === 'corner') next.notificationPlacement = prefs.notificationPlacement
    save({ ...config, ui: next })
    return status()
  }
  let previewRevision = 0
  /** 请求桌面助手显示模拟通知，不自动启动已停用的助手。 @returns {{ ok: boolean, revision: number }} */
  function previewNotification() {
    if (disposed || state.phase !== 'running') throw new Error('桌面助手尚未运行，请先启用')
    return { ok: true, revision: ++previewRevision }
  }
  /** 返回当前待预览版本，供可信桥接轮询。 @returns {number} */
  function notificationPreviewRevision() { return previewRevision }
  /** 记录错误，不允许 logger 异常破坏清理。 @param {unknown} error */
  function fail(error) {
    state.error = message(error)
    state.phase = 'error'
    state.progress = null
    try { log('warn', state.error) } catch {}
  }
  /** 原子替换配置；失败时不改变内存设置。 @param {typeof config} next */
  function save(next) {
    mkdirSync(root, { recursive: true })
    const temp = join(root, `.manager-${randomUUID()}.tmp`)
    try {
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      renameSync(temp, configPath)
    } finally { try { unlinkSync(temp) } catch {} }
    config = next
    state.enabled = next.enabled
    state.ui = next.ui
  }
  /** 清除握手超时。 */
  function clearStartup() { if (startupTimer) clearTimeout(startupTimer); startupTimer = null }
  /** 串行执行生命周期操作，单个失败不会阻断后续操作。 @param {() => Promise<void>|void} operation @param {boolean} [propagate] */
  function enqueue(operation, propagate = false) {
    const result = queue.then(operation)
    queue = result.catch(fail)
    return propagate ? result : queue
  }
  /** 等待真实退出后才释放 child；停止超时不允许启动第二个进程。 */
  async function stop() {
    clearStartup()
    if (!child) return
    if (stopPromise) return stopPromise
    const current = child
    stopPromise = new Promise((resolve, reject) => {
      /** 移除等待器。 */
      const cleanup = () => { clearTimeout(timer); current.removeListener('exit', done); current.removeListener('error', onError) }
      /** 退出确认。 */
      const done = () => { cleanup(); resolve() }
      /** 错误并不代表进程已退出。 @param {Error} error */
      const onError = (error) => { cleanup(); reject(error) }
      const timer = setTimeout(() => { cleanup(); reject(new Error('助手停止超时；未确认退出，拒绝启动重复进程')) }, deps.stopTimeoutMs ?? 5000)
      current.once('exit', done)
      current.once('error', onError)
      try { current.kill() } catch (error) { cleanup(); reject(error) }
    })
    try { await stopPromise } finally { stopPromise = null }
  }
  /** 仅在收到可信 bridge 的 ready 后设置 running。 */
  function start() {
    if (disposed || !supported || !config.enabled || child) return
    discover()
    if (!state.runtime.available) { state.phase = 'stopped'; state.pid = null; return }
    const entry = join(packageRoot, 'dist', 'desktop', 'main.cjs')
    if (!existsSync(entry)) throw new Error(`助手构建产物不存在：${entry}`)
    /** @type {NodeJS.ProcessEnv} */
    const childEnv = { ...env, DSH_SESSION_TRAY_URL: url, DSH_SESSION_TRAY_TOKEN: token, DSH_SESSION_TRAY_ICON: join(packageRoot, 'assets', 'tray.png'), DSH_SESSION_TRAY_CONFIG_PATH: join(root, 'widget.json'), DSH_SESSION_TRAY_MANAGER_CONFIG_PATH: configPath }
    delete childEnv.ELECTRON_RUN_AS_NODE
    state.phase = 'starting'
    state.error = null
    const current = launch(state.runtime.path, [entry], { env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    child = current
    state.pid = current.pid ?? null
    current.stdout?.on('data', (chunk) => { try { log('info', String(chunk).trim()) } catch {} })
    current.stderr?.on('data', (chunk) => { try { log('warn', String(chunk).trim()) } catch {} })
    current.on('error', (error) => {
      if (child !== current) return
      clearStartup()
      if (!current.pid) { child = null; state.pid = null }
      fail(new Error(`助手 spawn 失败：${message(error)}`))
    })
    current.once('exit', (code, signal) => {
      if (child !== current) return
      clearStartup()
      child = null
      state.pid = null
      if (disposed || stopPromise || !config.enabled) { if (state.phase !== 'error') state.phase = 'stopped' }
      else fail(new Error(`助手意外退出：code=${code}, signal=${signal ?? 'none'}`))
    })
    startupTimer = setTimeout(() => {
      if (child !== current || (state.phase !== 'starting' && !recoveryError)) return
      fail(new Error('助手启动超时：未收到私有 bridge ready 握手'))
      void enqueue(stop)
    }, deps.startupTimeoutMs ?? 15000)
  }
  /** @param {number} pid */
  function ready(pid) {
    if (!disposed && child && Number.isSafeInteger(pid) && pid === child.pid && (state.phase === 'starting' || recoveryError)) {
      clearStartup(); state.phase = 'running'; state.error = recoveryError; recoveryError = null
    }
    return status()
  }
  /** 后台安装；所有失败都会进入可查询状态，临时文件总是清理。 */
  async function install() {
    let temp
    let stoppedPrevious = false
    const abort = new AbortController()
    controller = abort
    try {
      state.error = null; state.progress = 0; state.phase = 'downloading'
      await fs.mkdir(dirname(runtimeDir), { recursive: true })
      temp = await fs.mkdtemp(join(dirname(runtimeDir), '.install-'))
      const archive = `electron-v${ELECTRON_VERSION}-win32-${arch}.zip`
      const zip = join(temp, 'electron.zip')
      const sums = join(temp, 'SHASUMS256.txt')
      const get = deps.download ?? download
      await get(`${RELEASE}/SHASUMS256.txt`, sums, { signal: abort.signal, limit: 1024 * 1024, onProgress: () => {} })
      await get(`${RELEASE}/${archive}`, zip, { signal: abort.signal, limit: ZIP_LIMIT, onProgress: (progress) => { state.progress = progress } })
      abort.signal.throwIfAborted()
      state.phase = 'verifying'; state.progress = null
      const lines = (await fs.readFile(sums, 'utf8')).split(/\r?\n/)
      const hashes = lines.map((line) => /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line)).filter((line) => line?.[2] === archive)
      if (hashes.length !== 1) throw new Error('官方 SHA256 清单缺少唯一的目标文件记录')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(zip, { signal: abort.signal })) hash.update(chunk)
      if (hash.digest('hex') !== hashes[0][1].toLowerCase()) throw new Error('Electron SHA256 校验失败')
      await validateZip(zip)
      abort.signal.throwIfAborted()
      state.phase = 'extracting'
      const staging = join(temp, 'unpacked')
      await (deps.extract ?? extract)(zip, staging, abort.signal)
      abort.signal.throwIfAborted()
      if (!(await fs.stat(join(staging, 'electron.exe'))).isFile()) throw new Error('解压结果缺少 electron.exe')
      // 先停止旧进程，避免文件锁和两个助手并存；绝不删除已安装目录。
      stoppedPrevious = Boolean(child)
      await enqueue(stop, true)
      abort.signal.throwIfAborted()
      if (!existsSync(runtimeDir)) await renameWithRetry(staging, runtimeDir, abort.signal)
      else if (!readExecutable(join(runtimeDir, 'electron.exe'))) throw new Error('目标运行时目录已存在但无效，请手动检查')
      await enqueue(() => {
        if (disposed) return
        discover()
        save({ ...config, enabled: true })
        state.phase = 'idle'
        start()
      })
    } catch (error) {
      if (!disposed && !abort.signal.aborted) {
        // 安装失败不能无声终止原先正常工作的兼容运行时。
        if (stoppedPrevious && !child && config.enabled) {
          await enqueue(() => { try { start(); if (child) recoveryError = message(error) } catch (restoreError) { try { log('warn', `恢复原助手失败：${message(restoreError)}`) } catch {} } })
        }
        fail(error)
      }
    }
    finally {
      if (temp) await (deps.removeTemp ?? removeTemp)(temp).catch((error) => {
        // 清理不是安装结果，不得掩盖 SHA/解压/rename/启动的首个错误或破坏 running。
        try { log('warn', `安装临时目录清理失败（保留主状态）：${temp}：${message(error)}`) } catch {}
      })
      controller = null; installJob = null
    }
  }
  /** @param {'install'|'enable'|'disable'|'restart'|'reset-position'} name */
  async function action(name) {
    if (disposed) return status()
    if (!['install', 'enable', 'disable', 'restart', 'reset-position'].includes(name)) { fail(new Error('未知运行时操作')); return status() }
    if (name === 'install') {
      if (!supported) fail(new Error('仅支持 Windows x64/arm64'))
      else if (!installJob) installJob = install()
      return status()
    }
    // 禁用需要先取消并等待安装，不能在安装尾声又自动启用。
    if (name === 'disable' && installJob) { controller?.abort(); await installJob }
    await enqueue(async () => {
      if (disposed) return
      state.error = null
      recoveryError = null
      if (name === 'reset-position') {
        save({ ...config, ui: { ...config.ui, resetPositionRevision: config.ui.resetPositionRevision >= Number.MAX_SAFE_INTEGER ? 1 : config.ui.resetPositionRevision + 1 } })
        return
      }
      if (name === 'disable') { save({ ...config, enabled: false }); await stop(); state.phase = 'stopped'; return }
      if (!supported) throw new Error('仅支持 Windows x64/arm64')
      if (installJob) return
      save({ ...config, enabled: true })
      if (name === 'restart') await stop()
      discover()
      if (!state.runtime.available) {
        if (!installJob) installJob = install()
      } else start()
    })
    return status()
  }
  /** 幂等释放，等待安装清理及实际进程退出。 */
  function dispose() {
    if (disposePromise) return disposePromise
    disposed = true
    controller?.abort()
    clearStartup()
    disposePromise = (async () => { if (installJob) await installJob; await enqueue(stop); if (!child) { state.phase = 'stopped'; state.pid = null }; return status() })()
    return disposePromise
  }
  discover()
  if (configError) state.phase = 'error'
  else if (supported && config.enabled) {
    if (state.runtime.available) void enqueue(start)
    else installJob = install()
  }
  return { status, action, setNotifyPrefs, previewNotification, notificationPreviewRevision, ready, dispose }
}

/** 原子移动遇到 Windows 短暂文件锁时有限重试，不删除目标也不降级为复制。 @param {string} source @param {string} destination @param {AbortSignal} signal */
async function renameWithRetry(source, destination, signal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try { await fs.rename(source, destination); return } catch (error) {
      if (attempt >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }
}

/** 清理只针对 mkdtemp 创建的已知目录，容忍 Windows 杀毒程序短暂文件锁。 @param {string} path */
async function removeTemp(path) {
  await fs.rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

/** @param {unknown} error @returns {string} */
function message(error) { return error instanceof Error ? error.message : String(error) }

/** 检查普通文件，避免将目录作为可执行文件。 @param {string} path */
function readExecutable(path) { try { const stat = statSync(path); return stat.isFile() && stat.size > 0 } catch { return false } }

/**
 * 只允许官方发布入口及 GitHub 官方资产重定向；总超时含响应体，有限跳转/大小。
 * @param {string} url @param {string} destination
 * @param {{signal: AbortSignal, limit: number, onProgress: (progress: number|null) => void}} options
 */
async function download(url, destination, { signal, limit, onProgress }) {
  const timeout = AbortSignal.timeout(180000)
  const combined = AbortSignal.any([signal, timeout])
  let response
  for (let hop = 0; hop <= 5; hop++) {
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.username || target.password || target.port || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) throw new Error('下载重定向不是受信任的 GitHub HTTPS 资源')
    response = await fetch(target, { signal: combined, redirect: 'manual', headers: { 'user-agent': 'dsh-session-tray-runtime', 'accept-encoding': 'identity' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location || hop === 5) throw new Error('下载重定向过多或缺少目标')
      url = new URL(location, target).href
      continue
    }
    break
  }
  if (!response?.ok || !response.body) throw new Error(`Electron 下载失败：HTTP ${response?.status}`)
  const total = Number(response.headers.get('content-length')) || null
  if (total && total > limit) { await response.body.cancel(); throw new Error('下载文件超过大小限制') }
  let received = 0
  /** @param {AsyncIterable<Uint8Array>} source */
  async function* bounded(source) {
    for await (const chunk of source) {
      received += chunk.length
      if (received > limit) throw new Error('下载文件超过大小限制')
      onProgress(total ? Math.min(100, Math.floor(received / total * 100)) : null)
      yield chunk
    }
  }
  await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(destination, { flags: 'wx' }), { signal: combined })
  if (total && received !== total) throw new Error('下载文件长度不匹配')
}

/**
 * 验证中心目录和本地头，禁止 ZIP64、多卷、加密、链接、路径穿越、Windows ADS/保留名及覆盖。
 * @param {string} path
 */
async function validateZip(path) {
  const data = await fs.readFile(path)
  if (data.length > ZIP_LIMIT || data.length < 22) throw new Error('ZIP 大小无效')
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break }
  }
  if (end < 0) throw new Error('ZIP 缺少有效目录')
  const count = data.readUInt16LE(end + 10)
  const size = data.readUInt32LE(end + 12)
  const offset = data.readUInt32LE(end + 16)
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || count !== data.readUInt16LE(end + 8) || count === 65535 || count > 20000 || offset + size !== end) throw new Error('不支持的 ZIP 目录格式')
  const names = new Set()
  const ranges = []
  let expanded = 0
  let cursor = offset
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 目录损坏')
    const flags = data.readUInt16LE(cursor + 8)
    const method = data.readUInt16LE(cursor + 10)
    const compressed = data.readUInt32LE(cursor + 20)
    const uncompressed = data.readUInt32LE(cursor + 24)
    const length = data.readUInt16LE(cursor + 28)
    const extra = data.readUInt16LE(cursor + 30)
    const comment = data.readUInt16LE(cursor + 32)
    const local = data.readUInt32LE(cursor + 42)
    const next = cursor + 46 + length + extra + comment
    if (next > end || flags & 1 || ![0, 8].includes(method) || data.readUInt16LE(cursor + 34) || compressed === 0xffffffff || uncompressed === 0xffffffff || local === 0xffffffff) throw new Error('不支持的 ZIP 条目')
    const rawName = data.subarray(cursor + 46, cursor + 46 + length)
    // Electron 官方文件名为 ASCII；拒绝编码歧义，而非依赖解压器的编码猜测。
    if ([...rawName].some((byte) => byte < 32 || byte > 126)) throw new Error('ZIP 文件名编码无效')
    const name = rawName.toString('ascii')
    const parts = name.replace(/\/$/, '').split('/')
    if (!name || name.includes('\\') || parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('ZIP 包含不安全路径')
    const key = parts.join('/').toLowerCase()
    if (names.has(key)) throw new Error('ZIP 包含重复路径')
    names.add(key)
    const mode = data.readUInt32LE(cursor + 38) >>> 16
    if ((mode & 0xf000) && ![0x8000, 0x4000].includes(mode & 0xf000)) throw new Error('ZIP 不允许链接或特殊文件')
    expanded += uncompressed
    if (expanded > EXPANDED_LIMIT) throw new Error('ZIP 解压大小超过限制')
    if (local + 30 > offset || data.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP 本地头无效')
    const localLength = data.readUInt16LE(local + 26)
    const body = local + 30 + localLength + data.readUInt16LE(local + 28)
    if (body + compressed > offset || !data.subarray(local + 30, local + 30 + localLength).equals(rawName) || data.readUInt16LE(local + 6) !== flags || data.readUInt16LE(local + 8) !== method) throw new Error('ZIP 本地头和目录不匹配')
    validateExtra(data.subarray(cursor + 46 + length, cursor + 46 + length + extra))
    validateExtra(data.subarray(local + 30 + localLength, body))
    ranges.push([local, body + compressed])
    cursor = next
  }
  if (cursor !== end || !names.has('electron.exe')) throw new Error('ZIP 目录不完整或缺少 electron.exe')
  ranges.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) throw new Error('ZIP 条目数据重叠')
}

/** 拒绝 ZIP64 和 Unicode 路径覆盖，防止解压器与校验器解释不同路径。 @param {Buffer} extra */
function validateExtra(extra) {
  let cursor = 0
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) throw new Error('ZIP 扩展字段损坏')
    const id = extra.readUInt16LE(cursor)
    const size = extra.readUInt16LE(cursor + 2)
    if ([0x0001, 0x7075].includes(id)) throw new Error('ZIP 包含不支持的路径或 ZIP64 扩展')
    cursor += 4 + size
    if (cursor > extra.length) throw new Error('ZIP 扩展字段长度无效')
  }
}

/** 固定脚本、环境传路径，不拼接用户输入的 PowerShell 命令。 @param {string} zip @param {string} destination @param {AbortSignal} signal */
async function extract(zip, destination, signal) {
  const script = "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:DSH_TRAY_ZIP -DestinationPath $env:DSH_TRAY_OUT"
  await new Promise((resolve, reject) => {
    const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { shell: false, windowsHide: true, stdio: 'ignore', env: { ...process.env, DSH_TRAY_ZIP: zip, DSH_TRAY_OUT: destination }, signal, timeout: 120000 })
    let failure = null
    child.once('error', (error) => { failure = error })
    // close 在进程退出后触发；取消时不能只等 error 就删除仍在写入的临时目录。
    child.once('close', (code) => failure ? reject(failure) : code === 0 ? resolve() : reject(new Error(`Expand-Archive 失败：${code}`)))
  })
}
