'use strict'

/**
 * Runs in the existing sandboxed dock renderer. Chromium draws native system-font
 * numerals and antialiased vectors; no pixel font or hand-filled bitmap edges.
 * Keep this function self-contained so it can cross the renderer boundary.
 */
function taskbarCanvas(running, done) {
  const scaleFactor = 2
  const canvas = document.createElement('canvas')
  let context = canvas.getContext('2d')
  const font = '500 11px system-ui, -apple-system, BlinkMacSystemFont, sans-serif'
  context.font = font
  const tags = []
  if (running > 0) tags.push({ text: String(running), color: '#edb869' })
  if (done > 0) tags.push({ text: String(done), color: '#8bc9a6' })
  for (const tag of tags) tag.width = Math.max(16, Math.ceil(context.measureText(tag.text).width) + 8)
  const width = 18 + tags.reduce((sum, tag) => sum + 3 + tag.width, 0)
  const height = 18
  canvas.width = width * scaleFactor
  canvas.height = height * scaleFactor
  context = canvas.getContext('2d')
  context.scale(scaleFactor, scaleFactor)
  context.lineJoin = 'round'
  context.lineCap = 'round'
  context.beginPath()
  context.roundRect(2.5, 3.5, 13, 11, 1)
  context.moveTo(5.5, 7.5); context.lineTo(6.5, 7.5)
  context.moveTo(9, 7.5); context.lineTo(12.5, 7.5)
  context.moveTo(5.5, 10.5); context.lineTo(11.5, 10.5)
  // Menu-bar appearance follows wallpaper, not necessarily the global OS theme.
  // A fine dark keyline plus a light foreground is visible on both backgrounds.
  context.strokeStyle = 'rgba(0,0,0,0.72)'
  context.lineWidth = 2.25
  context.stroke()
  context.strokeStyle = '#f4f5f7'
  context.lineWidth = 1.25
  context.stroke()
  context.font = font
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  let x = 21
  for (const tag of tags) {
    context.beginPath()
    context.roundRect(x, 2, tag.width, 14, 4)
    context.fillStyle = tag.color
    context.fill()
    context.fillStyle = '#23362d'
    context.fillText(tag.text, x + tag.width / 2, 9.5)
    x += tag.width + 3
  }
  return { dataURL: canvas.toDataURL('image/png'), width, height, scaleFactor, font }
}
module.exports = { taskbarCanvas }
