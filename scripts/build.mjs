import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const files = ['main.cjs', 'preload.cjs', 'dock.html', 'notifications.html', 'settings.html', 'taskbar.cjs', 'tray-platform.cjs']
await mkdir(new URL('dist/desktop/', root), { recursive: true })
const hashes = {}
for (const file of files) {
  const source = new URL(`helper/${file}`, root)
  const bytes = await readFile(source)
  await copyFile(source, new URL(`dist/desktop/${file}`, root))
  hashes[file] = createHash('sha256').update(bytes).digest('hex')
}
await writeFile(new URL('dist/desktop/manifest.json', root), JSON.stringify({ schemaVersion: 1, files: hashes }, null, 2) + '\n')
// 动态 Client 使用宿主模块表；构建时内联设置模块，不在浏览器额外请求源码。
const settings = (await readFile(new URL('settings-client.js', root), 'utf8')).replace('export function registerSettings', 'function registerSettings')
const client = await readFile(new URL('client.js', root), 'utf8')
await writeFile(new URL('dist/client.js', root), client.replace("    const React = require('react')", `    const React = require('react')\n${settings}`).replace('      apply(ctx) {', '      apply(ctx) {\n        registerSettings(ctx, React)'))
console.log(`Built ${files.length} desktop resources and settings Client`)
