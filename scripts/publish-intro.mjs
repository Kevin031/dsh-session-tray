import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// 官方包仅提供 stdio 服务，没有更新发布的 CLI 子命令。
// 协议依据 @modelcontextprotocol/sdk shared/stdio.js：每行一条 JSON-RPC 2.0。
const root = new URL('../', import.meta.url)
const buildPath = fileURLToPath(new URL('scripts/build-intro.mjs', root))
const htmlPath = fileURLToPath(new URL('helper/intro.html', root))
const configPath = fileURLToPath(new URL('config/intro-release.json', root))
const packageSpec = '@baioo-zc/omni-link-mcp@0.4.0'
const protocolVersion = '2025-11-25'
const loginHint = '请先在 DSH 中使用 Omni Link 登录（omni_link_login），完成公司 SSO 后再运行本命令。'

/** 解析参数；不接受任意工具、命令或服务地址，避免误发写请求。 */
function parseOptions() {
  const options = { help: false, dryRun: false, timeout: 120000 }
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--timeout') {
      const value = args[++index]
      if (!/^\d+$/.test(value || '') || Number(value) < 1000 || Number(value) > 600000) {
        throw new Error('--timeout 必须是 1000 至 600000 的整数（毫秒）')
      }
      options.timeout = Number(value)
    } else throw new Error(`未知参数：${arg}；运行 --help 查看用法`)
  }
  return options
}

/** 读取非敏感发布配置，绝不读取 MCP 的凭据文件。 */
async function readConfig() {
  let value
  try {
    value = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`无法读取 config/intro-release.json：${error.message}。需要已有发布的 releaseId/shareUrl；本脚本不会新建发布。`)
  }
  if (!value || typeof value.releaseId !== 'string' || !value.releaseId.trim()) {
    throw new Error('config/intro-release.json 必须包含非空字符串 releaseId；本脚本不会新建发布。')
  }
  let url
  try { url = new URL(value.shareUrl) } catch { /* 由下方统一报错。 */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('config/intro-release.json 必须包含有效的 HTTPS shareUrl（不能包含凭据）。')
  }
  return { releaseId: value.releaseId.trim(), shareUrl: url.href }
}

/** 执行既定构建，使用继承 stdio，不捕获构建内容或创建新服务。 */
async function build(timeout) {
  await stat(buildPath)
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [buildPath], { cwd: root, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => {
      stopProcess(child)
      reject(new Error('构建超时，未发送更新请求。'))
    }, timeout)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`构建失败（退出码 ${code}），未发送更新请求。`))
    })
  })
}

/** 结束自建子进程树，避免 Windows 上 npx 包装进程遗留 MCP 服务。 */
function stopProcess(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => child.kill())
  } else child.kill('SIGTERM')
}

/** 检查最终独立 HTML 的基本容量；完整网页验收仍由构建和人工验证负责。 */
async function inspectHtml() {
  const info = await stat(htmlPath)
  if (!info.isFile() || info.size === 0 || info.size > 5 * 1024 * 1024) {
    throw new Error('helper/intro.html 必须是非空普通文件，且不超过 5 MiB。')
  }
  const html = await readFile(htmlPath, 'utf8')
  if (!/<html[\s>]/i.test(html)) throw new Error('helper/intro.html 不是完整 HTML。')
  return info.size
}

/** 最小 MCP 客户端：只支持本脚本所需的请求、通知、ping 和逐行响应。 */
class StdioClient {
  /** 启动固定版本官方 MCP 服务，Windows 的 shell 命令不拼接用户输入。 */
  constructor(timeout) {
    this.timeout = timeout
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.failure = null
    this.child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `npx --yes ${packageSpec}`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn('npx', ['--yes', packageSpec], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.receive(chunk))
    // 丢弃服务端 stderr，避免第三方诊断意外输出敏感内容；错误由协议响应报告。
    this.child.stderr.resume()
    this.child.on('error', () => this.fail(new Error('无法启动 npx；请确认 Node.js/npm 已安装且 npm 源可访问。')))
    this.child.on('close', (code) => this.fail(new Error(`Omni Link MCP 已退出（退出码 ${code}）。请检查 npx/npm 环境。`)))
    this.child.stdin.on('error', () => this.fail(new Error('Omni Link MCP stdin 已关闭。')))
  }

  /** 将流切分为受限长度的逐行 JSON-RPC 消息，并按 id 分派。 */
  receive(chunk) {
    this.buffer += chunk
    if (this.buffer.length > 10 * 1024 * 1024) return this.fail(new Error('MCP 响应超过缓冲区上限。'))
    let newline
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      let message
      try { message = JSON.parse(line) } catch { return this.fail(new Error('MCP stdout 含无效 JSON，已停止。')) }
      if (message.jsonrpc !== '2.0') return this.fail(new Error('MCP 返回无效的 JSON-RPC 版本。'))
      if (message.method && message.id !== undefined) {
        this.send(message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`MCP 协议错误（${message.error.code}）。`))
      else if (!Object.hasOwn(message, 'result')) pending.reject(new Error('MCP 响应缺少 result。'))
      else pending.resolve(message.result)
    }
  }

  /** 发送单行消息，不记录请求或凭据。 */
  send(message) {
    if (this.failure) throw this.failure
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /** 发送有独立超时的请求；写请求不会自动重试。 */
  request(method, params) {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} 超时（${this.timeout} ms）。`))
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ jsonrpc: '2.0', id, method, params }) } catch (error) { this.fail(error) }
    })
  }

  /** 拒绝全部等待请求并停止服务。 */
  fail(error) {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    stopProcess(this.child)
  }

  /** 完成握手后通知初始化完成，仅接受已确认的协议版本。 */
  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'dsh-session-tray-publish-intro', version: '1.0.0' },
    })
    if (result.protocolVersion !== protocolVersion || !result.capabilities?.tools) {
      throw new Error('MCP 服务协议版本或 tools 能力不匹配。')
    }
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  /** 解析官方工具的 JSON 文本返回值及业务错误，不透传未知响应内容。 */
  async callTool(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args })
    let data
    try {
      const content = result.content?.find((item) => item.type === 'text')
      data = JSON.parse(content.text)
    } catch { throw new Error(`${name} 返回了无法解析的数据。`) }
    if (result.isError) {
      if (data.code === 'AUTH_REQUIRED' || data.code === 'TOKEN_EXPIRED' || data.status === 401) throw new Error(loginHint)
      // 只输出已知错误码与 HTTP 状态，不输出服务端原始消息或未知字段。
      const code = /^[A-Z_]+$/.test(data.code || '') ? data.code : 'OMNI_API_ERROR'
      throw new Error(`${name} 失败：${code}${Number.isInteger(data.status) ? `（HTTP ${data.status}）` : ''}。`)
    }
    return data
  }

  /** 关闭本次连接；不退出用户账号，不删除授权。 */
  close() {
    this.fail(new Error('MCP 连接已关闭。'))
  }
}

/** 主流程：本地预检 → 构建 → MCP 授权查询 → 仅一次更新已有发布。 */
async function main() {
  const options = parseOptions()
  if (options.help) {
    console.log(`用法：node scripts/publish-intro.mjs [--dry-run] [--timeout 毫秒]\n\n默认：构建 helper/intro.html，并更新 config/intro-release.json 中已有的 releaseId。\n配置：{ "releaseId": "已有发布ID", "shareUrl": "https://..." }\n--dry-run  仅检查本地配置、构建入口和已有 HTML，不构建、不启动 npx、不发请求。\n--timeout  每个构建/MCP 请求超时，默认 120000 ms，范围 1000–600000。\n--help     显示帮助，无文件写入和网络请求。\n\n使用 npx --yes ${packageSpec}，需 Node.js >= 18.16 和可用的 npm。\n仅调用 omni_link_auth_status、omni_link_update_content，不新建、不修改权限、不自动登录。\n${loginHint}\n更新超时或响应丢失时结果可能未确认，先在 Omni Link 核实，不要盲目重试。`)
    return
  }
  const config = await readConfig()
  await stat(buildPath)
  if (!options.dryRun) await build(options.timeout)
  const size = await inspectHtml()
  console.log(`${options.dryRun ? '[dry-run] ' : ''}目标发布：${config.releaseId}\n分享地址（配置）：${config.shareUrl}\n文件：${htmlPath}\n大小：${size} bytes / 5 MiB\n模式：独立 HTML；autoExtractZip: true（不改变现有发布类型/权限）。`)
  if (options.dryRun) {
    console.log(`本地预检通过；未构建、未启动 npx、未查询授权、未发送更新请求。正式运行将使用 ${packageSpec}。`)
    return
  }
  const client = new StdioClient(options.timeout)
  let updateAttempted = false
  /** 用户中断时关闭子进程；更新开始后明确结果未知。 */
  function interrupt() {
    console.error(updateAttempted ? '操作中断：更新可能已发送，请先在 Omni Link 核实结果，不要盲目重试。' : '操作中断，未发送更新请求。')
    client.close()
    process.exitCode = 130
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    await client.initialize()
    const auth = await client.callTool('omni_link_auth_status')
    if (auth.authenticated !== true) throw new Error(loginHint)
    updateAttempted = true
    await client.callTool('omni_link_update_content', { releaseId: config.releaseId, filePath: htmlPath, autoExtractZip: true })
    console.log(`Omni Link 已确认内容更新成功。\n分享地址（配置）：${config.shareUrl}\n未修改访问权限、展示设置或介绍；未查询这些设置。`)
  } catch (error) {
    if (updateAttempted) console.error('更新曾尝试发送；若超时、断连或返回 OUTCOME_UNVERIFIED，请先在 Omni Link 核实结果。本脚本不会自动重试或新建。')
    throw error
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    client.close()
  }
}

main().catch((error) => {
  console.error(`发布失败：${error.message}`)
  if (!process.exitCode) process.exitCode = 1
})
