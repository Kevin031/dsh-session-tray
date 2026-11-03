import { startPreview } from './preview-server.mjs'

try {
  const server = await startPreview()
  console.log('Session Tray Preview (Vite HMR; mock only)')
  server.printUrls()
  let closing = false
  /** 关闭 HTTP、WebSocket 和文件监听器，只处理一次退出信号。 @returns {Promise<void>} */
  async function close() {
    if (closing) return
    closing = true
    try { await server.close() }
    catch (error) { console.error('Preview shutdown failed:', error); process.exitCode = 1 }
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
} catch (error) {
  console.error('Preview startup failed:', error)
  process.exitCode = 1
}
