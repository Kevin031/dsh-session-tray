import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerSettings } from '../settings-client.js'

/** 提供最小 DOM 边界，验证入口识别、弹窗重建及卸载恢复。 */
function fixture() {
  let notify, disconnected = false, removed = false, css = ''
  const buttons = []
  const doc = {
    body: {},
    head: { appendChild(style) { css = style.textContent } },
    createElement() { return { textContent: '', remove() { removed = true } } },
    querySelectorAll(selector) {
      assert.equal(selector, '[data-shortcut-modal="settings"] nav button')
      return buttons.filter((button) => button.isConnected)
    },
    defaultView: { MutationObserver: class {
      constructor(callback) { notify = callback }
      observe() {}
      disconnect() { disconnected = true }
    } },
  }
  /** 新建一个可观察的导航入口。 @param {string} label */
  function button(label) {
    const attributes = new Map()
    const value = { textContent: label, isConnected: true, attributes,
      querySelector: () => ({}),
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
    }
    buttons.push(value)
    return value
  }
  return { doc, button, notify: () => notify(), css: () => css,
    cleaned: () => disconnected && removed }
}

test('only overlay nav receives a theme-inheriting 16px window icon, including reopen and locale changes', (t) => {
  const previous = globalThis.document
  const f = fixture()
  globalThis.document = f.doc
  const cleanups = []
  t.after(() => {
    for (const cleanup of cleanups.reverse()) cleanup?.()
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  })
  const tray = f.button('桌面状态栏')
  const other = f.button('通用设置')
  registerSettings({
    effect(fn) { cleanups.push(fn()) },
    locale: { register() { return () => {} }, bind() { return () => '' } },
    slots: { inject() {} },
  }, { createElement() {} })
  const marked = (button) => button.attributes.has('data-dst-settings-nav')
  assert.equal(marked(tray), true)
  assert.equal(marked(other), false)
  assert.match(f.css(), /background:currentColor/)
  assert.match(f.css(), /width:16px;height:16px/)
  tray.textContent = 'Desktop Status Bar'
  f.notify()
  assert.equal(marked(tray), true)
  tray.isConnected = false
  const reopened = f.button('桌面状态栏')
  f.notify()
  assert.equal(marked(tray), false)
  assert.equal(marked(reopened), true)
  reopened.textContent = 'Another section'
  f.notify()
  assert.equal(marked(reopened), false)
  reopened.textContent = '桌面状态栏'
  f.notify()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup?.()
  assert.equal(marked(reopened), false)
  assert.equal(f.cleaned(), true)
})
