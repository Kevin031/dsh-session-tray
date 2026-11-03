'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/** 创建无网络、无 UI 的 Client 函数环境。 @returns {object} */
function fixture() {
  const context = vm.createContext({ window: { __ModuleLoader__: { load() {} } } })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../client.js'), 'utf8'), context)
  return context
}

test('完成行使用最新轮次助手摘要，缺失时不泄漏旧回复', () => {
  const c = fixture()
  vm.runInContext(`globalThis.list = { byId: { a: { title: '会话' } }, projectionsBySession: { a: { values: { turnOutline: [{ response: '旧回复' }, { response: '真实回复…' }] } } } }; globalThis.rows = collectRows(list, { a: { completionUnread: true } }, {})`, c)
  assert.equal(vm.runInContext('rows[0].responsePreview', c), '真实回复...')
  vm.runInContext("list.projectionsBySession.a.values.turnOutline.push({response:''})", c)
  assert.equal(vm.runInContext("responsePreviewOf(list, 'a')", c), '')
  assert.equal(vm.runInContext("responsePreviewOf({}, 'a')", c), '')
  assert.equal(vm.runInContext("collectRows(list, {a:{running:true}}, {})[0].responsePreview", c), undefined)
})
