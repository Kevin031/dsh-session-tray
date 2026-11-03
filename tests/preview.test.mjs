import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { previewPort, startPreview } from '../scripts/preview-server.mjs'
import { renderLayoutMock } from '../scripts/sync-layout-mock.mjs'

 test('预览端口校验拒绝空白、越界与非整数', () => {
  assert.equal(previewPort(), 4179)
  assert.equal(previewPort('4180'), 4180)
  for (const value of ['', ' ', '0', '65536', '4179.5', 'bad']) assert.throws(() => previewPort(value))
})

test('独立预览内嵌当前真实 UI，脚本可解析且没有远程脚本依赖', async () => {
  const html = await renderLayoutMock()
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  new Script(script)
  const json = script.match(/let sources = (.*);/)[1]
  const sources = JSON.parse(json)
  for (const file of ['dock.html', 'notifications.html', 'settings.html']) {
    assert.equal(sources[file], await readFile(new URL('../helper/' + file, import.meta.url), 'utf8'))
  }
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/)
})

test('Vite 预览注入 HMR 客户端，拒绝 Host API，端口占用时安全回退', async () => {
  const first = await startPreview('14379')
  let second
  try {
    second = await startPreview('14379')
    const url = first.resolvedUrls.local[0]
    const html = await (await fetch(url)).text()
    assert.match(html, /@vite\/client/)
    assert.match(html, /tray-ui:update/)
    assert.match(html, /updatePreviewSources/)
    assert.equal((await fetch(new URL('/api/session', url))).status, 403)
    assert.notEqual(first.config.server.port, second.config.server.port)
    const client = await fetch(new URL('/@vite/client', url))
    assert.equal(client.status, 200)
  } finally {
    await second?.close()
    await first.close()
  }
})
