import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateZip } from '../runtime-manager.js'

// Minimal stored ZIP; extraction is not exercised by these validator tests.
function archive(entries) {
  const locals = [], central = []
  let offset = 0
  for (const [name, content = '', mode = 0o100755] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(filename.length, 26)
    const row = Buffer.alloc(46)
    row.writeUInt32LE(0x02014b50); row.writeUInt32LE(bytes.length, 20); row.writeUInt32LE(bytes.length, 24)
    row.writeUInt16LE(filename.length, 28); row.writeUInt32LE((mode << 16) >>> 0, 38); row.writeUInt32LE(offset, 42)
    const body = Buffer.concat([local, filename, bytes])
    locals.push(body); central.push(row, filename); offset += body.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
const binary = ['Electron.app/Contents/MacOS/Electron', 'binary']
const framework = 'Electron.app/Contents/Frameworks/Test.framework/'

test('macOS accepts contained framework symlink chains, Windows still rejects symlinks', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tray-zip-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const zip = join(home, 'runtime.zip')
  const entries = [binary,
    [framework + 'Versions/A/', '', 0o40755],
    [framework + 'Versions/A/Test', 'framework'],
    [framework + 'Versions/Current', 'A', 0o120777],
    [framework + 'Test', 'Versions/Current/Test', 0o120777],
  ]
  await writeFile(zip, archive(entries))
  await validateZip(zip, 'darwin')
  await assert.rejects(validateZip(zip, 'win32'), /链接/)
  for (const target of ['/tmp/outside', '../../../../../../../tmp', 'bad\u0000target']) {
    await writeFile(zip, archive([binary, [framework + 'Bad', target, 0o120777]]))
    await assert.rejects(validateZip(zip, 'darwin'), /不安全链接/)
  }
  await writeFile(zip, archive([binary, [framework + 'A', 'B', 0o120777], [framework + 'B', 'A', 0o120777]]))
  await assert.rejects(validateZip(zip, 'darwin'), /循环链接/)
  await writeFile(zip, archive([...entries, [framework + 'Versions/Current/Injected', 'bad']]))
  await assert.rejects(validateZip(zip, 'darwin'), /链接下写入/)
  await writeFile(zip, archive([binary, [framework + 'Bad', 'missing', 0o120777]]))
  await assert.rejects(validateZip(zip, 'darwin'), /不存在/)
})
