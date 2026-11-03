import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const root = new URL('../', import.meta.url)
/** 从实际桌面 UI 生成可独立打开的预览。 @returns {Promise<string>} */
export async function renderLayoutMock() {
const sources = {}
for (const file of ['dock.html', 'notifications.html', 'settings.html']) {
  sources[file] = await readFile(new URL(`helper/${file}`, root), 'utf8')
}
// 内嵌源码，既复用真实 UI，又允许通过 file:// 独立打开，不依赖服务器或 Electron。
const sourceJson = JSON.stringify(sources).replaceAll('<', '\\u003c')
const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>桌面状态栏 · 实际 UI 预览</title>
  <style>
    :root { color-scheme: dark; color: #f3f6f7; background: #121518; font: 12px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 40px clamp(16px, 4vw, 64px); }
    main { max-width: 1240px; margin: auto; }
    h1 { margin: 0 0 8px; font-size: 24px; font-weight: 600; }
    .note, output { color: #a0a9b2; }
    .note { max-width: 900px; margin: 0 0 20px; }
    .tools { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 28px; }
    button, select, input { font: inherit; color: inherit; }
    .tools button, select { padding: 6px 10px; background: #242424; border: 1px solid #ffffff30; border-radius: 6px; cursor: pointer; }
    button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #e5b86a; outline-offset: 2px; }
    label { display: flex; align-items: center; gap: 8px; }
    input[type="range"] { width: 140px; accent-color: #e5b86a; }
    .stage { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 32px; }
    .case { min-width: 0; max-width: 100%; }
    h2 { margin: 0 0 12px; color: #a0a9b2; font-size: 12px; font-weight: 500; }
    iframe { display: block; border: 0; max-width: 100%; background: transparent; }
    .dock-frame { width: 300px; height: 28px; }
    .notice-frame { width: 300px; height: 320px; margin-bottom: 10px; }
    .regular-frame { width: 300px; height: 440px; }
    .settings-frame { width: 560px; height: 640px; }
    .tray-control { width: 560px; max-width: 100%; padding: 16px; border: 1px solid #ffffff30; border-radius: 12px; }
    .tray-control label { justify-content: space-between; gap: 16px; }
    .tray-control small { display: block; color: #a0a9b2; }
    .tray-control input { accent-color: #e5b86a; }
    .tray-control button { margin-top: 12px; padding: 6px 10px; border: 1px solid #ffffff30; border-radius: 6px; background: #242424; cursor: pointer; }
    .desktop-scene { position: relative; width: 440px; max-width: 100%; height: 340px; border: 1px dashed #ffffff30; border-radius: 12px; background: #191e23; overflow: auto; }
    .desktop-scene > span { display: block; margin: 12px; color: #a0a9b2; }
    .corner-anchor { position: absolute; right: 4px; bottom: 4px; width: 390px; }
    .corner-anchor.mac { top: 16px; bottom: auto; }
    .corner-frame { width: 390px; max-width: none; height: 260px; }
    .caption { max-width: 440px; margin: 10px 0 0; color: #a0a9b2; }
    #status { display: block; margin-top: 24px; min-height: 36px; }
    @media (max-width: 520px) { body { padding: 24px 16px; } .stage { gap: 24px; } }
  </style>
</head>
<body>
<main>
  <h1>桌面状态栏 · 实际 UI 预览</h1>
  <p class="note">直接复用当前浮窗、通知和设置页面源码。桌面运行时通知默认跟随悬浮框，也可选桌面角落（macOS 右上角、Windows 右下角）；托盘模式使用 390 px。下面把通知放在浮窗上方只对照宽度和密度，不是系统级位置验收；不会连接真实会话、保存桌面设置或操作系统托盘。</p>
  <div class="tools">
    <label>会话场景 <select id="scenario"><option value="mixed">运行中 / 待确认 / 已完成</option><option value="done">全部完成</option><option value="pending">仅待确认</option><option value="empty">无会话</option><option value="stale">未连接</option></select></label>
    <label>浮窗宽度 <input id="width" type="range" min="200" max="720" value="300"><output id="width-value">300 px</output></label>
    <button id="replay" type="button">重播待确认通知</button>
    <button id="replay-done" type="button">重播完成通知 · 10 秒</button>
  </div>
  <div class="stage">
    <section class="case"><h2>单行 · 紧凑通知</h2><iframe id="compact-notices" class="notice-frame" title="单行紧凑通知"></iframe><iframe id="bar" class="dock-frame" title="单行浮窗"></iframe><p class="caption">单行通知为紧凑样式，宽度与浮窗一致。默认跟随悬浮框，选择固定角落时在 macOS 右上角、Windows 右下角显示。左右边缘支持键盘调宽，双击恢复默认。</p></section>
    <section class="case"><h2>展开卡片 · 常规通知</h2><iframe id="regular-notices" class="regular-frame" title="卡片常规通知"></iframe><iframe id="card" class="dock-frame" title="展开会话卡片"></iframe><p class="caption">卡片替换单行。通知为常规样式，宽度与悬浮框一致。默认跟随悬浮框，也可选择屏幕右下角（macOS 为右上角）。托盘模式没有浮窗可对齐，使用 390 px。</p></section>
    <section class="case"><h2>Windows 桌面右下角 · 常规通知</h2><div class="desktop-scene"><span>模拟桌面工作区</span><div class="corner-anchor"><iframe id="corner-notices" class="corner-frame" title="桌面右下角通知"></iframe></div></div><p class="caption">选择桌面右下角时在此显示，跟随悬浮框时在左侧两种密度中显示。距工作区右侧和底部各 4 px。仅模拟位置，不创建系统窗口。</p></section>
    <section class="case"><h2>macOS 桌面右上角 · 常规通知</h2><div class="desktop-scene"><div class="corner-anchor mac"><iframe id="mac-corner-notices" class="corner-frame" title="macOS 右上角通知"></iframe></div></div><p class="caption">macOS 固定角落和菜单栏模式使用右上角，距工作区顶部 16 px、右侧 4 px；工作区已避开菜单栏。仅模拟位置，不创建系统窗口。</p></section>
    <section class="case"><h2>DSH 插件设置 · 桌面端</h2><div class="tray-control"><label><span><strong>最小化到任务栏（Mac）/ 托盘（Win）</strong><small>隐藏浮窗后，Mac 顶部任务栏使用橙/绿数字 Tag 表示运行/完成，0 隐藏，通知继续显示；从图标菜单恢复。</small></span><input id="tray-mode" type="checkbox" role="switch" aria-label="最小化到任务栏或托盘"></label><button id="restore-tray" type="button">模拟恢复悬浮框</button><div id="taskbar-preview" style="display:none;margin-top:16px;padding:10px;border:1px solid #ffffff30;border-radius:8px" aria-label="macOS 任务栏模拟"><button id="taskbar-toggle-menu" type="button" aria-label="模拟展开任务栏会话菜单" style="margin:0;padding:0;background:none;border:0"><svg aria-hidden="true" viewBox="0 0 18 18" style="width:18px;height:18px;vertical-align:middle;margin-right:3px"><g fill="none" stroke-linejoin="round" stroke-linecap="round"><path d="M3.5 3.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM5.5 7.5h1m2.5 0h3.5m-7 3h6" stroke="#000b" stroke-width="2.25"/><path d="M3.5 3.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM5.5 7.5h1m2.5 0h3.5m-7 3h6" stroke="#f4f5f7" stroke-width="1.25"/></g></svg><strong id="taskbar-counts" role="status"></strong></button><div id="taskbar-menu-preview" style="display:none;margin-top:8px;padding:8px;border:1px solid #ffffff30;border-radius:10px;max-width:320px;text-align:left" aria-label="任务栏会话菜单模拟"></div></div></div><p class="caption">仅模拟任务栏计数、点击展开分组会话菜单及标题跳转、浮窗显隐和状态同步；可切换运行、完成、空闲和断线场景，不创建系统托盘或任务栏、不保存真实设置。</p></section>
    <section class="case"><h2>设置 · 560 × 640</h2><iframe id="settings" class="settings-frame" title="会话状态设置"></iframe><p class="caption">通知开关立即应用到预览，关闭通知不影响会话列表。完成通知默认停留 10 秒，也可选不自动消失；时长修改仅对新通知生效，点击重播验证。关闭按钮仅模拟关闭。</p></section>
  </div>
  <output id="status" aria-live="polite">预览已就绪。可点击展开、折叠、会话和通知按钮。</output>
</main>
<script>
let sources = ${sourceJson};
const frames = new Map();
const now = Date.now();
const sampleRows = [
  { id: 'running-1', title: '分析问题诊断界面调整', section: 'running', label: '运行中', updatedAt: now - 120000, contextPercent: 28, usedTokens: 35840, contextWindow: 128000 },
  { id: 'running-2', title: '修复悬浮框输入与光标', section: 'running', label: '运行中', updatedAt: now - 180000, contextPercent: 46, usedTokens: 58880, contextWindow: 128000 },
  { id: 'pending', title: '关联仓库并提交首版至 master', section: 'attention', label: '等待确认', updatedAt: now - 60000 },
  { id: 'done', title: 'DSH 会话状态外显面板', responsePreview: '已完成通知交互调整，支持点击卡片打开对应会话，并保留独立关闭操作。这段模拟回复用于核对长内容截断效果，不会读取真实会话或触发系统操作。更多实现细节可点击卡片进入会话查看。', section: 'attention', label: '已完成', updatedAt: now - 120000, contextPercent: 12, usedTokens: 15360, contextWindow: 128000 },
];
let prefs = { notifyConversation: true, notifyTaskDone: true, taskDoneDurationSeconds: 10, notificationPlacement: 'dock' };
/** 归一化预览通知时长，与桌面设置保持一致。 @param {unknown} value @returns {number} */
function normalizeDuration(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86400 ? value : 10;
}
/** 更新重播按钮；不重置已显示通知的计时器。 */
function updateDurationLabel() {
  const seconds = prefs.taskDoneDurationSeconds;
  document.getElementById('replay-done').textContent = '重播完成通知 · ' + (seconds === 0 ? '不自动消失' : seconds + ' 秒');
}
let trayMode = false;
let taskbarMenuOpen = false;
/** 模拟托盘显隐和从托盘恢复；不触发系统操作。 @param {boolean} value */
function setTrayMode(value) {
  trayMode = value;
  document.getElementById('tray-mode').checked = value;
  for (const id of ['bar', 'card']) frames.get(id).style.display = value ? 'none' : '';
  paintNotices();
  updateTaskbarPreview();
  report(value ? '已模拟最小化到任务栏（Mac）/ 托盘（Win），Mac 显示当前会话数量，通知使用右上角。' : '已模拟恢复悬浮框，托盘开关已关闭。');
}
let pendingVisible = true;
let doneVisible = false;
let manualPreview = false;
let doneDuration = 10;
let doneTimer = 0;
let dockWidth = 300;
const expandedFrames = new Map([['bar', false], ['card', true]]);
/** 返回选定场景的模拟快照。 */
function snapshot() {
  const scenario = document.getElementById('scenario').value;
  const rows = scenario === 'done' ? sampleRows.filter(row => row.id === 'done')
    : scenario === 'pending' ? sampleRows.filter(row => row.id === 'pending')
    : scenario === 'empty' || scenario === 'stale' ? [] : sampleRows;
  return { stale: scenario === 'stale', rows };
}
function updateTaskbarPreview() {
  const next = snapshot();
  const running = next.rows.filter(row => row.section === 'running').length;
  const done = next.rows.filter(row => row.section !== 'running' && row.label === '已完成').length;
  document.getElementById('taskbar-preview').style.display = trayMode ? '' : 'none';
  document.getElementById('taskbar-counts').innerHTML = next.stale ? '未连接' : [
    running > 0 ? '<span title="运行" style="display:inline-block;font:500 11px/14px system-ui,-apple-system,sans-serif;min-width:16px;padding:0 4px;border-radius:4px;vertical-align:middle;background:#edb869;color:#23362d;text-align:center;margin-right:3px">' + running + '</span>' : '',
    done > 0 ? '<span title="完成" style="display:inline-block;font:500 11px/14px system-ui,-apple-system,sans-serif;min-width:16px;padding:0 4px;border-radius:4px;vertical-align:middle;background:#8bc9a6;color:#23362d;text-align:center">' + done + '</span>' : ''
  ].join('');
  const menu = document.getElementById('taskbar-menu-preview');
  menu.style.display = trayMode && taskbarMenuOpen ? '' : 'none';
  const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\"', '&quot;');
  const groups = [{title:'进行中',rows:next.rows.filter(row=>row.section==='running')},{title:'已完成',rows:next.rows.filter(row=>row.section!=='running' && row.label==='已完成')}];
  menu.innerHTML = next.stale ? '未连接 · 等待会话状态' : groups.filter(group=>group.rows.length).map(group=>'<p style=\"margin:4px 0;color:#a0a9b2\">'+group.title+' ('+group.rows.length+')</p>'+group.rows.map(row=>'<button type=\"button\" data-session-id=\"'+escape(row.id)+'\" style=\"display:block;margin:2px 0;width:100%;text-align:left\">'+escape(row.title)+'</button>').join('')).join('') || '暂无运行或完成会话';
}
/** 更新预览操作回执，不调用真实桌面接口。 @param {string} text */
function report(text) { document.getElementById('status').textContent = text; }
/** 将消息广播给已加载的同源预览框架。 @param {string} type @param {unknown} value */
function broadcast(type, value) {
  for (const frame of frames.values()) frame.contentWindow.postMessage({ type, value }, '*');
}
/** 根据开关和模拟生命周期更新两种密度的通知。 */
function paintNotices() {
  const rows = [];
  if (doneVisible && (prefs.notifyTaskDone || manualPreview)) rows.push({ ...sampleRows[3], kind: 'done', durationSeconds: doneDuration });
  if (pendingVisible && prefs.notifyConversation) rows.push({ ...sampleRows[2], kind: 'pending' });
  for (const id of ['compact-notices', 'regular-notices', 'corner-notices', 'mac-corner-notices']) {
    const visible = (id === 'corner-notices' || id === 'mac-corner-notices') === (prefs.notificationPlacement === 'corner' || trayMode);
    frames.get(id)?.contentWindow.postMessage({ type: 'notifications', value: visible ? rows : [] }, '*');
  }
}
/** 调整浮窗宽度，遵循实际 200–720 px 限制。 @param {number} width */
function setWidth(width) {
  dockWidth = Math.max(200, Math.min(720, width));
  document.getElementById('width').value = String(dockWidth);
  document.getElementById('width-value').textContent = dockWidth + ' px';
  for (const id of ['bar', 'card', 'compact-notices', 'regular-notices']) frames.get(id).style.width = dockWidth + 'px';

}
/** 创建独立 UI 文档，在原页面脚本运行前注入桌面接口替身。 @param {string} id @param {string} file @param {boolean} expanded */
function mount(id, file, expanded = false) {
  const frame = document.getElementById(id);
  frames.set(id, frame);
  const initial = { id, expanded, snapshot: snapshot(), prefs, density: (id === 'compact-notices' && !expandedFrames.get('bar')) || (id === 'regular-notices' && !expandedFrames.get('card')) ? 'compact' : 'regular' };
  const bridge = '(' + installBridge.toString() + ')(' + JSON.stringify(initial) + ');';
  frame.addEventListener('load', () => { paintNotices(); setWidth(dockWidth); }, { once: true });
  // 与外层保持相同色彩方案，避免浏览器给透明 iframe 合成白色画布。
  const transparentDocument = sources[file].replace('</head>', '<style>:root { color-scheme: dark; background: transparent; } html, body { background: transparent; }</style></head>');
  frame.srcdoc = transparentDocument.replace('<script>', '<script>' + bridge + '<' + '/script><script>');
}
/** 安装纯浏览器模拟桥接；只向父页面报告 UI 意图。 @param {object} initial */
function installBridge(initial) {
  const listeners = {};
  /** 报告模拟桌面操作。 @param {string} type @param {unknown} value */
  function send(type, value) { parent.postMessage({ preview: true, id: initial.id, type, value }, '*'); }
  /** 注册监听并立即提供初始状态。 @param {string} type @param {Function} callback @param {unknown} value */
  function subscribe(type, callback, value) { listeners[type] = callback; callback(value); }
  window.sessionDock = {
    onSnapshot: callback => subscribe('snapshot', callback, initial.snapshot),
    onExpanded: callback => subscribe('expanded', callback, initial.expanded),
    setExpanded: value => send('expanded', value),
    open: async value => send('open', value),
    showMenu: () => send('menu'),
    beginWidthDrag: () => send('drag'), endWidthDrag: () => {},
    resetWidth: () => send('width', 300),
    nudgeWidth: (edge, delta) => send('nudge', delta),
    onNotifications: callback => subscribe('notifications', callback, initial.prefs.notifyConversation ? [{ id: 'pending', title: '关联仓库并提交首版至 master', label: '等待确认', kind: 'pending' }] : []),
    onNotificationLayout: callback => subscribe('layout', callback, { density: initial.density, anchor: initial.id === 'mac-corner-notices' ? 'top' : 'bottom' }),
    notificationHeight: value => send('height', value),
    dismissNotification: value => send('dismiss', value),
    getNotifyPrefs: async () => initial.prefs,
    setNotifyPrefs: value => send('prefs', value),
    /** 异步模拟完成通知请求；只发给预览父页面。 @returns {Promise<{ok: boolean}>} */
    previewNotification: async () => { send('preview-notification'); return { ok: true }; },
    onNotifyPrefs: callback => subscribe('prefs', callback, initial.prefs),
  };
  window.close = () => send('close');
  window.addEventListener('message', event => {
    if (event.source !== parent) return;
    listeners[event.data.type]?.(event.data.value);
  });
  if (initial.id === 'bar' || initial.id === 'card') {
    new ResizeObserver(() => {
      const expanded = document.body.classList.contains('expanded');
      const list = document.getElementById('card-list');
      send('height', expanded ? 34 + list.scrollHeight : 28);
    }).observe(document.getElementById('card-list'));
    new MutationObserver(() => {
      send('height', document.body.classList.contains('expanded') ? 34 + document.getElementById('card-list').scrollHeight : 28);
    }).observe(document.getElementById('card-list'), { childList: true });
  }
}
window.addEventListener('message', event => {
  const data = event.data;
  if (!data?.preview || frames.get(data.id)?.contentWindow !== event.source) return;
  const frame = frames.get(data.id);
  if (data.type === 'height') frame.style.height = Math.max(data.id.includes('notices') ? 1 : 28, Math.min(520, data.value)) + 'px';
  if (data.type === 'expanded') {
    expandedFrames.set(data.id, data.value === true);
    frame.contentWindow.postMessage({ type: 'expanded', value: data.value === true }, '*');
    const noticeId = data.id === 'bar' ? 'compact-notices' : 'regular-notices';
    frames.get(noticeId).contentWindow.postMessage({ type: 'layout', value: { density: data.value ? 'regular' : 'compact' } }, '*');
    frame.style.height = data.value ? '240px' : '28px';
    report(data.value ? '已展开为会话卡片。' : '已折叠为单行。');
  }
  if (data.type === 'open') report('模拟打开会话：' + (sampleRows.find(row => row.id === data.value)?.title || data.value) + '。不会打开真实会话或自动确认。');
  if (data.type === 'dismiss') {
    if (data.value === 'done') doneVisible = false; else pendingVisible = false;
    paintNotices(); report('通知已收起，会话列表状态不变。');
  }
  if (data.type === 'prefs') {
    prefs = { notifyConversation: data.value?.notifyConversation !== false, notifyTaskDone: data.value?.notifyTaskDone !== false, taskDoneDurationSeconds: normalizeDuration(data.value?.taskDoneDurationSeconds), notificationPlacement: data.value?.notificationPlacement === 'corner' ? 'corner' : 'dock' };
    broadcast('prefs', prefs); updateDurationLabel(); paintNotices(); report('通知偏好已应用到预览；时长修改仅对新通知生效，不写入桌面设置。');
  }
  if (data.type === 'preview-notification') showDone(true);
  if (data.type === 'width') setWidth(data.value);
  if (data.type === 'nudge') setWidth(dockWidth + data.value);
  if (data.type === 'drag') report('浏览器预览不模拟系统级拖动；请使用顶部宽度滑块或边缘方向键。');
  if (data.type === 'close') report('模拟关闭设置；预览中保留设置窗口以便继续核对。');
  if (data.type === 'menu') report('实际右键菜单包含最小化到托盘等操作；此预览不创建系统托盘。');
});
mount('compact-notices', 'notifications.html');
mount('regular-notices', 'notifications.html');
mount('corner-notices', 'notifications.html');
mount('mac-corner-notices', 'notifications.html');

mount('bar', 'dock.html');
mount('card', 'dock.html', true);
mount('settings', 'settings.html');
setWidth(dockWidth);
/** 热更新真实 UI 文档；保留场景、宽度和通知偏好，不刷新外层预览。 @param {Record<string, string>} next */
window.updatePreviewSources = next => {
  sources = next;
  for (const [id, frame] of frames) {
    const file = id === 'settings' ? 'settings.html' : id.includes('notices') ? 'notifications.html' : 'dock.html';
    const expanded = expandedFrames.get(id) === true;
    mount(id, file, expanded);
    frame.addEventListener('load', () => { paintNotices(); setWidth(dockWidth); }, { once: true });
  }
  report('实际 UI 已通过 Vite HMR 更新；当前场景、宽度与通知偏好已保留。');
};
document.getElementById('scenario').addEventListener('change', () => { broadcast('snapshot', snapshot()); updateTaskbarPreview(); report('已切换会话场景，通知重播独立于会话快照。'); });
document.getElementById('width').addEventListener('input', event => setWidth(Number(event.target.value)));
document.getElementById('replay').addEventListener('click', () => {
  pendingVisible = true; paintNotices(); report(prefs.notifyConversation ? '待确认通知保持显示，直到手动收起。' : '对话通知已关闭，请在设置中开启后重播。');
});
/** 重播遵循开关，手动测试忽略开关；均只创建模拟通知。 @param {boolean} manual */
function showDone(manual = false) {
  clearTimeout(doneTimer); doneTimer = 0;
  manualPreview = manual;
  doneDuration = prefs.taskDoneDurationSeconds;
  doneVisible = manual || prefs.notifyTaskDone; paintNotices();
  const seconds = doneDuration;
  report(!doneVisible ? '任务完成通知已关闭。' : seconds === 0 ? '完成通知不自动消失，需手动收起。' : '完成通知停留 ' + seconds + ' 秒后自动收起。');
  if (doneVisible && seconds > 0) doneTimer = setTimeout(() => { doneVisible = false; paintNotices(); }, seconds * 1000);
}
document.getElementById('replay-done').addEventListener('click', () => showDone());
document.getElementById('tray-mode').addEventListener('change', event => setTrayMode(event.target.checked === true));
document.getElementById('taskbar-toggle-menu').addEventListener('click', () => { taskbarMenuOpen = !taskbarMenuOpen; updateTaskbarPreview(); });
document.getElementById('taskbar-menu-preview').addEventListener('click', event => {
  const id = event.target.dataset?.sessionId;
  if (id) report('模拟打开会话：' + (sampleRows.find(row => row.id === id)?.title || id) + '。不会打开真实会话。');
});
document.getElementById('restore-tray').addEventListener('click', () => setTrayMode(false));
</script>
</body>
</html>
`
return page
}

/** 同步静态预览文件。 @returns {Promise<void>} */
export async function syncLayoutMock() {
  await writeFile(new URL('helper/layout-mock.html', root), await renderLayoutMock())
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await syncLayoutMock()
  console.log('Synced layout mock from dock, notifications and settings UI')
}
