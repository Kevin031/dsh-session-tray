import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { renderLayoutMock, syncLayoutMock } from './sync-layout-mock.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const uiFiles = ['dock.html', 'notifications.html', 'settings.html']
let renderPreview = renderLayoutMock

/** 校验端口配置。 @param {string | undefined} value @returns {number} */
export function previewPort(value) {
  const port = value === undefined ? 4179 : Number(value)
  if ((value !== undefined && !value.trim()) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Invalid PREVIEW_PORT: expected an integer between 1024 and 65535')
  }
  return port
}

/** 创建隔离的 Vite 预览配置，不读取用户配置、环境变量文件或真实 Host。 @param {number} port @returns {import('vite').InlineConfig} */
export function previewServerConfig(port) {
  return {
    configFile: false,
    envDir: false,
    root,
    appType: 'mpa',
    clearScreen: false,
    plugins: [{
      name: 'session-tray-preview',
      configureServer(server) {
        server.watcher.add(uiFiles.map(name => resolve(root, 'helper', name)))
        server.watcher.add(resolve(root, 'scripts/sync-layout-mock.mjs'))
        server.middlewares.use(async (request, response, next) => {
          const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
          if (pathname === '/api' || pathname.startsWith('/api/')) {
            response.writeHead(403, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ error: 'PREVIEW_NETWORK_DISABLED' }))
            return
          }
          if (pathname !== '/' && pathname !== '/helper/layout-mock.html') return next()
          try {
            const html = await server.transformIndexHtml('/helper/layout-mock.html', await renderPreview())
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end(html)
          } catch (error) { next(error) }
        })
      },
      transformIndexHtml() {
        return [{ tag: 'script', attrs: { type: 'module' }, children: `
          import { createHotContext } from '/@vite/client';
          const hot = createHotContext('/tray-preview');
          hot.on('tray-ui:update', sources => window.updatePreviewSources(sources));
        `, injectTo: 'body' }]
      },
      async handleHotUpdate(context) {
        const file = resolve(context.file)
        if (uiFiles.some(name => file === resolve(root, 'helper', name))) {
          await syncLayoutMock()
          const sources = Object.fromEntries(await Promise.all(uiFiles.map(async name => [name, await readFile(resolve(root, 'helper', name), 'utf8')])))
          context.server.ws.send({ type: 'custom', event: 'tray-ui:update', data: sources })
          return []
        }
        if (file === resolve(root, 'helper/layout-mock.html')) return []
        if (file === resolve(root, 'scripts/sync-layout-mock.mjs')) {
          // 动态导入新版本生成器，预览容器变化时同步静态文件并重载一次页面。
          const generator = await import('./sync-layout-mock.mjs?update=' + context.timestamp)
          renderPreview = generator.renderLayoutMock
          await generator.syncLayoutMock()
          context.server.ws.send({ type: 'full-reload' })
          return []
        }
      },
    }],
    server: {
      host: '127.0.0.1', port, strictPort: false, open: false, cors: false,
      watch: { ignored: ['**/helper/layout-mock.html'] },
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      fs: { strict: true, allow: [root], deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'] },
    },
  }
}

/** 启动 Vite 开发服务器，失败时释放资源。 @param {string | undefined} value @returns {Promise<import('vite').ViteDevServer>} */
export async function startPreview(value = process.env.PREVIEW_PORT) {
  await syncLayoutMock()
  const server = await createServer(previewServerConfig(previewPort(value)))
  try { await server.listen(); return server }
  catch (error) { await server.close(); throw error }
}
