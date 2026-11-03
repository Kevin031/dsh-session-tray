import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { syncLayoutMock } from './sync-layout-mock.mjs'

const root = new URL('../', import.meta.url)
/** 生成自包含介绍页，内嵌真实 UI 与纯模拟桥接，不连接桌面运行时。 @returns {Promise<string>} */
export async function buildIntro() {
  await syncLayoutMock()
  const template = await readFile(new URL('website/intro.template.html', root), 'utf8')
  const sources = {}
  for (const name of ['dock.html', 'notifications.html', 'settings.html']) {
    sources[name] = await readFile(new URL(`helper/${name}`, root), 'utf8')
  }
  const guide = await readFile(new URL('website/install-guide.webp', root))
  const runtimeGuide = await readFile(new URL('website/runtime-guide.webp', root))
  const hubGuide = await readFile(new URL('website/hub-guide.webp', root))
  const page = template
    .replace('/*__SOURCES__*/{}', JSON.stringify(sources).replaceAll('<', '\\u003c'))
    .replace('__INSTALL_GUIDE__', `data:image/webp;base64,${guide.toString('base64')}`)
    .replace('__RUNTIME_GUIDE__', `data:image/webp;base64,${runtimeGuide.toString('base64')}`)
    .replace('__HUB_GUIDE__', `data:image/webp;base64,${hubGuide.toString('base64')}`)
  const output = new URL('helper/intro.html', root)
  await writeFile(output, page)
  console.log(`Built introduction: ${output.pathname} (${Buffer.byteLength(page)} bytes)`)
  return page
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await buildIntro()
