import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

// 仅用于验收最终独立 HTML；特意放在非根路径以核对静态托管兼容性。
const server = createServer(async (request, response) => {
  const page = await readFile(new URL('../helper/intro.html', import.meta.url))
  if (request.url === '/preview/intro/' || request.url === '/preview/intro/index.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(page)
  } else if (request.url === '/favicon.ico') {
    response.writeHead(204).end()
  } else {
    response.writeHead(404).end('Not found')
  }
})
server.listen(4187, '127.0.0.1', () => console.log('Built artifact: http://127.0.0.1:4187/preview/intro/'))
process.once('SIGINT', () => server.close())
process.once('SIGTERM', () => server.close())
