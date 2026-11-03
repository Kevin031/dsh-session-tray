'use strict'

// Resolve from the installed package or a trusted path supplied by the host,
// never from a developer's machine-specific drive.
const koffi = require(process.env.DSH_SESSION_TRAY_KOFFI || 'koffi')

const user32 = koffi.load('user32.dll')
const RECT = koffi.struct('RECT', {
  left: 'int32',
  top: 'int32',
  right: 'int32',
  bottom: 'int32',
})
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' })
const FindWindowW = user32.func('void * __stdcall FindWindowW(str16 className, str16 windowName)')
const FindWindowExW = user32.func('void * __stdcall FindWindowExW(void *parent, void *child, str16 className, str16 windowName)')
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ RECT *rect)')
const GetClientRect = user32.func('bool __stdcall GetClientRect(void *hwnd, _Out_ RECT *rect)')
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(void *hwnd, POINT *point)')
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int32 vKey)')
const VK_LBUTTON = 0x01

/**
 * @param {unknown} hwnd
 * @returns {{ left: number, top: number, right: number, bottom: number } | null}
 */
function rectOf(hwnd) {
  if (!hwnd) return null
  const rect = {}
  if (!GetWindowRect(hwnd, rect)) return null
  return rect
}

/**
 * 在当前 Electron 进程里读通知区矩形。必须和 setBounds 用同一个进程，
 * 否则 DPI 虚拟化会把左边界量偏几十像素。
 * @returns {{ left: number, top: number, right: number, bottom: number } | null}
 */
function notifyRect() {
  const tray = FindWindowW('Shell_TrayWnd', null)
  return rectOf(FindWindowExW(tray, null, 'TrayNotifyWnd', null))
}

/**
 * @param {Buffer} handle BrowserWindow.getNativeWindowHandle()
 * @returns {unknown}
 */
function hwndOf(handle) {
  if (!handle) return null
  const address = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
  return koffi.as(address, 'void *')
}

/**
 * 可见客户区的屏幕矩形。外框在 Windows 上会比状态条高出一截，不能拿来对齐。
 * @param {Buffer} handle
 * @returns {{ left: number, top: number, right: number, bottom: number } | null}
 */
function clientScreenRect(handle) {
  const hwnd = hwndOf(handle)
  if (!hwnd) return null
  const client = {}
  if (!GetClientRect(hwnd, client)) return null
  const origin = { x: 0, y: 0 }
  const far = { x: client.right, y: client.bottom }
  if (!ClientToScreen(hwnd, origin) || !ClientToScreen(hwnd, far)) return null
  return { left: origin.x, top: origin.y, right: far.x, bottom: far.y }
}

/** 左键是否仍按住。调宽时鼠标会离开 28px 高的窗口，不能只靠渲染进程的 pointerup。 @returns {boolean} */
function isLeftButtonDown() {
  return (GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0
}

module.exports = { notifyRect, clientScreenRect, isLeftButtonDown }
