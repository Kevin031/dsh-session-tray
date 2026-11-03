'use strict'

/**
 * Windows 托盘的点击差异。
 * `setContextMenu` 在 Windows 上只接管右键，左键必须自己绑定。
 * 当前左键用于从托盘恢复悬浮框，不在左键再弹一次菜单。
 * @param {string} platform `process.platform`
 * @returns {{ leftClickPopsMenu: boolean }}
 */
function trayPlatform(platform) {
  return { leftClickPopsMenu: platform === 'win32' }
}

module.exports = { trayPlatform }
