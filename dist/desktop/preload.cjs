'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sessionDock', {
  /**
   * @param {(snapshot: unknown) => void} listener
   */
  onSnapshot(listener) {
    ipcRenderer.on('snapshot', (_event, snapshot) => listener(snapshot))
  },
  /**
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  open(sessionId) {
    return ipcRenderer.invoke('open-session', sessionId)
  },
  /** 打开浮窗右键菜单。 */
  showMenu() {
    ipcRenderer.send('show-menu')
  },
  /**
   * @param {boolean} open
   */
  setExpanded(open) {
    ipcRenderer.send('set-expanded', open)
  },
  /**
   * 从左右边缘开始调宽。主进程继续跟踪光标，直到左键松开。
   * @param {'left' | 'right'} edge
   */
  beginWidthDrag(edge) {
    ipcRenderer.send('width-drag-begin', edge)
  },
  /** 渲染进程仍能收到松开时结束调宽；主进程也会在左键抬起后结束。 */
  endWidthDrag() {
    ipcRenderer.send('width-drag-end')
  },
  /**
   * 双击边缘恢复默认宽度。
   * @param {'left' | 'right'} edge
   */
  resetWidth(edge) {
    ipcRenderer.send('width-reset', edge)
  },
  /**
   * @param {'left' | 'right'} edge
   * @param {number} delta 宽度变化，正数变宽
   */
  nudgeWidth(edge, delta) {
    ipcRenderer.send('width-nudge', { edge, delta })
  },
  /**
   * @param {(open: boolean) => void} listener
   */
  onExpanded(listener) {
    ipcRenderer.on('expanded', (_event, open) => listener(open === true))
  },
  /**
   * @param {(rows: { id: string, title: string, label: string }[]) => void} listener
   */
  onNotifications(listener) {
    ipcRenderer.on('notifications', (_event, rows) => listener(rows))
  },
  /**
   * @param {(layout: { density?: 'compact' | 'regular', width?: number, anchor?: 'top' | 'bottom' }) => void} listener
   */
  onNotificationLayout(listener) {
    ipcRenderer.on('notification-layout', (_event, layout) => listener(layout))
  },
  /**
   * 隐藏当前待确认周期，不确认会话。
   * @param {string} sessionId
   */
  dismissNotification(sessionId) {
    ipcRenderer.send('notification-dismiss', sessionId)
  },
  /**
   * 报告完整内容高度，由主进程按工作区限制窗口，内容仍可滚动。
   * @param {number} height
   */
  notificationHeight(height) {
    ipcRenderer.send('notification-height', height)
  },
  /**
   * 读取对话通知和任务完成通知开关。
   * @returns {Promise<{ notifyConversation: boolean, notifyTaskDone: boolean, taskDoneDurationSeconds: number, notificationPlacement: 'dock' | 'corner' }>}
   */
  /** 手动预览当前样式的模拟通知。 @returns {Promise<{ ok: boolean }>} */
  previewNotification() {
    return ipcRenderer.invoke('notification-preview')
  },
  getNotifyPrefs() {
    return ipcRenderer.invoke('notify-prefs-get')
  },
  /**
   * @param {{ notifyConversation?: boolean, notifyTaskDone?: boolean, taskDoneDurationSeconds?: number, notificationPlacement?: 'dock' | 'corner' }} prefs
   */
  setNotifyPrefs(prefs) {
    ipcRenderer.send('notify-prefs-set', prefs)
  },
  /**
   * @param {(prefs: { notifyConversation?: boolean, notifyTaskDone?: boolean, taskDoneDurationSeconds?: number, notificationPlacement?: 'dock' | 'corner' }) => void} listener
   */
  onNotifyPrefs(listener) {
    ipcRenderer.on('notify-prefs', (_event, prefs) => listener(prefs))
  },
})
