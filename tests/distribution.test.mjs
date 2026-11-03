import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { apply } from '../index.js'

const root = new URL('../', import.meta.url)
test('桌面分发清单覆盖所有实际产物且哈希与源码一致', async () => {
  const manifest = JSON.parse(await readFile(new URL('dist/desktop/manifest.json', root), 'utf8'))
  for (const file of ['main.cjs', 'preload.cjs', 'dock.html', 'notifications.html', 'settings.html', 'taskbar.cjs', 'tray-platform.cjs', 'taskbar-image.cjs']) {
    const bytes = await readFile(new URL(`dist/desktop/${file}`, root))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files[file])
    assert.deepEqual(bytes, await readFile(new URL(`helper/${file}`, root)))
  }
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(pkg.exports['./client'], './dist/client.js')
})

test('Git 安装直接使用预构建产物，不需要生命周期构建授权', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  for (const hook of ['prepare', 'prepack', 'preinstall', 'install', 'postinstall']) {
    assert.equal(pkg.scripts[hook], undefined, `${hook} 会触发 Git 依赖构建策略`)
  }
  const settings = (await readFile(new URL('settings-client.js', root), 'utf8')).replace('export function registerSettings', 'function registerSettings')
  const client = await readFile(new URL('client.js', root), 'utf8')
  const expected = client.replace("    const React = require('react')", `    const React = require('react')\n${settings}`).replace('      apply(ctx) {', '      apply(ctx) {\n        registerSettings(ctx, React)')
  assert.equal(await readFile(new URL('dist/client.js', root), 'utf8'), expected)
})

test('宿主注册的路由在管理器就绪前明确返回503，并可随卸载清理', async () => {
  let route
  let disposed = false
  const cleanups = []
  const ctx = {
    webServer: { register(value) { route = value; return () => { disposed = true } } },
    inject() {},
    effect(callback, label) { if (label.includes('page routes')) cleanups.push(callback()) },
  }
  apply(ctx)
  const response = { destroyed: false, writableEnded: false, writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
  await route.handler({ method: 'GET', url: '/dsh-session-tray/manage/status', headers: {} }, response)
  assert.equal(response.status, 503)
  assert.match(response.body.error, /尚未就绪/)
  cleanups.forEach((dispose) => dispose())
  assert.equal(disposed, true)
})
