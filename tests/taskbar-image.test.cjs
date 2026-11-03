'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { taskbarCanvas } = require('../helper/taskbar-image.cjs')

function render(running, done) {
  const text = [], fills = [], strokes = [], rounded = []
  const context = {
    measureText: value => ({ width: value.length * 6.5 }),
    scale() {}, beginPath() {}, moveTo() {}, lineTo() {},
    roundRect(...args) { rounded.push(args) },
    stroke() { strokes.push(this.strokeStyle) },
    fill() { fills.push(this.fillStyle) },
    fillText(value) { text.push({ value, font: this.font }) },
  }
  const canvas = { getContext: () => context, toDataURL: () => 'data:image/png;base64,test' }
  const result = vm.runInNewContext(`(${taskbarCanvas.toString()})(${running},${done})`, { document: { createElement: () => canvas } })
  return { result, text, fills, strokes, rounded }
}
test('taskbar uses normal system numerals, smooth vector roundRect, two-tone icon and exact Retina representation', () => {
  const both = render(2, 1)
  assert.deepEqual(both.text.map(item => item.value), ['2', '1'])
  assert.ok(both.text.every(item => item.font.includes('system-ui') && !/mono|pixel/i.test(item.font)))
  assert.deepEqual(both.fills, ['#edb869', '#8bc9a6'])
  assert.deepEqual(both.strokes, ['rgba(0,0,0,0.72)', '#f4f5f7'])
  assert.equal(both.result.height, 18)
  assert.equal(both.result.scaleFactor, 2)
  assert.ok(both.result.width <= 56)
  assert.equal(both.rounded.length, 3)
  for (const [running, done, values] of [[0, 1, ['1']], [1, 0, ['1']], [0, 0, []]]) {
    const image = render(running, done)
    assert.deepEqual(image.text.map(item => item.value), values)
    assert.ok(image.result.width < both.result.width)
  }
  assert.ok(render(12, 24).result.width > both.result.width)
})
