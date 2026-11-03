import { readFile, stat } from 'node:fs/promises'
import { Script } from 'node:vm'
import assert from 'node:assert/strict'

const root = new URL('../', import.meta.url)
const path = new URL('helper/intro.html', root)
const html = await readFile(path, 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
new Script(script)
const sources = JSON.parse(script.match(/const sources = (.*);/)[1])
for (const name of ['dock.html', 'notifications.html', 'settings.html']) {
  assert.equal(sources[name], await readFile(new URL(`helper/${name}`, root), 'utf8'))
}
const outer = html.replace(/<script>[\s\S]*?<\/script>/g, '')
assert.doesNotMatch(outer, /<(?:script|link)[^>]+(?:src|href)\s*=/)
const images = [...outer.matchAll(/<img[^>]+src="([^"]+)"/g)]
assert.equal(images.length, 3)
for (const image of images) assert.match(image[1], /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/)
assert.doesNotMatch(outer, /__(?:INSTALL|RUNTIME|HUB)_GUIDE__/)
assert.match(outer, /id="runtime-install"/)
assert.match(outer, /按钮置灰，属于正常状态/)
assert.match(outer, /id="copy-install"/)
assert.match(outer, /dsh-session-tray/)
assert.match(outer, /git\+ssh:\/\/git@gitlab\.bt\/ywzc\/ai\/dsh\/dsh-plugin-hub\.git/)
assert.doesNotMatch(outer, /安装提示词|发送给 DSH 中的 AI|href="https:\/\/gitlab/)
assert.match(outer, /复制安装地址/)
for (const match of outer.matchAll(/href="([^"]+)"/g)) {
  assert.ok(match[1].startsWith('#') || match[1] === 'https://gitlab.bt/ywzc/ai/dsh/dsh-plugin-hub')
}
assert.ok((await stat(path)).size < 5 * 1024 * 1024)
assert.match(outer, /sandbox="allow-scripts"/)
console.log('PASS: script syntax, exact current UI, standalone assets, Hub-only external links, sandbox and size')
