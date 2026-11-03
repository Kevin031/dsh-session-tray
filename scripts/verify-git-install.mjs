import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const root = new URL('../', import.meta.url)
const temp = await mkdtemp(join(tmpdir(), 'tray-git-install-'))
const source = join(temp, 'source')
const consumer = join(temp, 'consumer')
const pnpm = process.env.TRAY_TEST_PNPM || 'pnpm'

/** 执行真实 Git / pnpm，不绕过生命周期安全策略。 @param {string} command @param {string[]} args @param {string} cwd */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', timeout: 180000 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`)
}

try {
  await mkdir(source)
  await mkdir(consumer)
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  // 只复制被发布的代码和产物，不复用工作区 node_modules，也不为消费者授予 allowBuilds。
  for (const file of ['package.json', 'index.js', 'runtime-manager.js', 'client.js', 'settings-client.js', 'cordis.patch.yml', 'icon.svg', 'locale', 'assets', 'helper', 'scripts', 'dist']) {
    await cp(new URL(file, root), join(source, file), { recursive: true })
  }
  run('git', ['init', '--quiet'], source)
  run('git', ['add', '.'], source)
  run('git', ['-c', 'user.name=DistributionTest', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'distribution-fixture'], source)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'tray-git-consumer', private: true }))
  // 使用全新隔离 store，避免复用已获批或已准备好的 Git 包缓存。
  const spec = `git+${pathToFileURL(source).href}`
  run(pnpm, ['add', spec, '--store-dir', join(temp, 'store'), '--config.ignore-scripts=false'], consumer)
  const installed = join(consumer, 'node_modules', pkg.name)
  const actual = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(actual.version, pkg.version)
  for (const hook of ['prepare', 'prepack', 'preinstall', 'install', 'postinstall']) assert.equal(actual.scripts[hook], undefined)
  for (const file of ['dist/client.js', 'dist/desktop/main.cjs', 'dist/desktop/preload.cjs', 'dist/desktop/dock.html', 'dist/desktop/notifications.html', 'dist/desktop/settings.html', 'dist/desktop/taskbar.cjs', 'dist/desktop/tray-platform.cjs', 'dist/desktop/manifest.json']) {
    assert.deepEqual(await readFile(join(installed, file)), await readFile(new URL(file, root)))
  }
  const host = await import(pathToFileURL(join(installed, 'index.js')).href)
  assert.equal(typeof host.apply, 'function')
  console.log(`PASS: ${pkg.name}@${pkg.version} installed from clean Git source without allowBuilds; shipped artifacts and Host import verified`)
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
