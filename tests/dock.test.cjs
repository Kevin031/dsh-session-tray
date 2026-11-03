'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')

/** 创建独立主进程环境，不启动 Electron 或写真实配置。 @param {object} [saved] @returns {object} */
function mainHarness(saved = { x: 2200, y: 1000 }) {
  const handlers = {}
  const files = new Map([['widget.json', JSON.stringify(saved)]])
  const fakeFs = {
    readFileSync: (file) => { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file) },
    mkdirSync() {},
    writeFileSync: (file, value) => files.set(file, value),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from) },
    unlinkSync: (file) => files.delete(file),
  }
  const area = { x: 1920, y: 0, width: 1920, height: 1040 }
  const fake = {
    Tray: class { constructor() { this.events = {} } isDestroyed() { return false } setToolTip() {} setContextMenu() {} on(name, callback) { this.events[name] = callback } destroy() {} },
    Menu: { buildFromTemplate: value => value },
    app: { on() {}, whenReady: () => ({ then: () => ({ catch() {} }) }) },
    ipcMain: { handle() {}, on: (name, fn) => { handlers[name] = fn } },
    screen: { getDisplayMatching: () => ({ workArea: area }), getPrimaryDisplay: () => ({ workArea: area }) },
  }
  const context = vm.createContext({
    require: (id) => id === 'electron' ? fake : id === 'node:fs' ? fakeFs : id.startsWith('.') ? require(path.join(root, 'helper', id)) : require(id),
    process: { platform: 'win32', env: { DSH_SESSION_TRAY_URL: 'http://localhost', DSH_SESSION_TRAY_TOKEN: 'test', DSH_SESSION_TRAY_CONFIG_PATH: 'widget.json' } },
    console, module: { exports: {} }, __dirname: path.join(root, 'helper'),
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'helper/main.cjs'), 'utf8'), context)
  vm.runInContext('request = async () => ({ status: 200 })', context)
  return { handlers, saved: () => JSON.parse(files.get('widget.json')), run: (code) => vm.runInContext(code, context) }
}

test('首次启动默认单行，行卡片往返尺寸正确', () => {
  const h = mainHarness()
  assert.equal(h.run('sizeFor().height'), 28)
  assert.equal(h.run("Object.hasOwn(config, 'style')"), false)
  h.handlers['set-expanded']({}, true)
  assert.equal(h.run('sizeFor().height'), 82)
  h.handlers['set-expanded']({}, false)
  assert.equal(h.run('sizeFor().height'), 28)
})

test('切换形态立即保存，重启及更新后仍恢复最后选择', () => {
  const h = mainHarness({ x: 2200, y: 1000, width: 420, notifyConversation: false })
  h.handlers['set-expanded']({}, true)
  assert.equal(h.saved().expanded, true)
  const restarted = mainHarness(h.saved())
  assert.equal(restarted.run('sizeFor().height'), 82)
  assert.equal(restarted.run('notificationLayout().density'), 'regular')
  restarted.run('applyManagement({ui:{resetPositionRevision:1}})')
  assert.equal(restarted.saved().expanded, true)
  assert.equal(restarted.saved().width, 420)
  assert.equal(restarted.saved().notifyConversation, false)
  restarted.handlers['set-expanded']({}, false)
  assert.equal(restarted.saved().expanded, false)
  assert.equal(mainHarness(restarted.saved()).run('sizeFor().height'), 28)
})

test('旧版卡片设置可迁移，显式单行优先，非法形态安全回退', () => {
  assert.equal(mainHarness({ style: 'card' }).run('sizeFor().height'), 82)
  assert.equal(mainHarness({ style: 'card', expanded: false }).run('sizeFor().height'), 28)
  for (const expanded of [null, 'true', 1, {}, []]) {
    assert.equal(mainHarness({ expanded }).run('sizeFor().height'), 28)
  }
})

test('副屏展开收起保持底边锚点，大列表高度有限', () => {
  const h = mainHarness()
  h.run('dock = { isDestroyed() { return false }, bounds: { x: 2200, y: 1000, width: 300, height: 28 }, getBounds() { return this.bounds }, setBounds(value) { this.bounds = value } }; snapshot.rows = Array.from({length: 24}, () => ({section: "running"}))')
  for (let i = 0; i < 5; i++) {
    h.handlers['set-expanded']({}, true)
    assert.equal(h.run('dock.bounds.height'), 354)
    assert.equal(h.run('dock.bounds.y + dock.bounds.height'), 1028)
    assert.equal(h.run('dock.bounds.x'), 2200)
    h.handlers['set-expanded']({}, false)
    assert.equal(h.run('dock.bounds.y'), 1000)
  }
})

test('管理命令重置副屏位置，同一版本不重复重置', () => {
  const h = mainHarness()
  h.run('saveConfig = () => {}; syncNotifications = () => {}; dock = { isDestroyed() { return false }, getBounds() { return {x:2200,y:1000,width:300,height:28} }, setBounds(value) { this.bounds=value } }; applyManagement({ui:{resetPositionRevision:1}})')
  assert.equal(h.run('config.x'), null)
  assert.equal(h.run('dock.bounds.x'), 3516)
  h.run('config.x=2222; applyManagement({ui:{resetPositionRevision:1}})')
  assert.equal(h.run('config.x'), 2222)
})

test('三个分组均存在时为每个标题分配高度', () => {
  const h = mainHarness()
  h.run('snapshot.rows = [{section:"running"}, {section:"attention", label:"待回答"}, {section:"attention",label:"已完成"}]')
  h.handlers['set-expanded']({}, true)
  assert.equal(h.run('sizeFor().height'), 204)
})

test('通知跨刷新常驻且去重，新通知置顶，断线不清除，确认后移除', () => {
  const h = mainHarness()
  h.run('reconcileNotificationCycles(notificationCycles, {rows:[{id:"a", title:"旧", section:"attention",label:"待回答"}]})')
  h.run('reconcileNotificationCycles(notificationCycles, {rows:[{id:"a", title:"旧更新", section:"attention",label:"待回答"},{id:"b", title:"新", section:"attention",label:"待批准"}]})')
  assert.equal(h.run('JSON.stringify(visibleNotifications(notificationCycles).map(row => row.id))'), '["b","a"]')
  h.run('reconcileNotificationCycles(notificationCycles, {stale:true,rows:[]})')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 2)
  h.run('reconcileNotificationCycles(notificationCycles, {rows:[{id:"a",section:"attention",label:"待回答"},{id:"b",title:"刚完成",section:"attention",label:"已完成"}]}, 1000)')
  assert.equal(h.run('JSON.stringify(visibleNotifications(notificationCycles).map(row => row.id))'), '["done:b","a"]')
  assert.equal(h.run('visibleNotifications(notificationCycles)[0].kind'), 'done')
})

test('任务完成只在新出现时弹出，默认 10 秒后收起，启动时已完成的不补弹', () => {
  const h = mainHarness()
  h.run('reconcileNotificationCycles(notificationCycles, {rows:[{id:"old", title:"历史", section:"attention", label:"已完成"},{id:"run", title:"进行中", section:"running", label:"运行中"}]}, 1000)')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 0)
  h.run('reconcileNotificationCycles(notificationCycles, {rows:[{id:"old", label:"已完成"},{id:"run", title:"跑完了", label:"已完成"},{id:"fresh", title:"刚完成", label:"已完成"}]}, 2000)')
  assert.equal(h.run('JSON.stringify(visibleNotifications(notificationCycles).map(row => row.id))'), '["done:run","done:fresh"]')
  h.run('reconcileNotificationCycles(notificationCycles, {rows:[{id:"old", label:"已完成"},{id:"run", label:"已完成"},{id:"fresh", label:"已完成"}]}, 2500)')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 2)
  assert.equal(h.run('sweepExpiredNotifications(notificationCycles, 2000 + 9999)'), false)
  assert.equal(h.run('sweepExpiredNotifications(notificationCycles, 2000 + 10000)'), true)
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 0)
  h.run('reconcileNotificationCycles(notificationCycles, {stale:true, rows:[]}, 9000)')
  h.run('reconcileNotificationCycles(notificationCycles, {rows:[{id:"old", label:"已完成"}]}, 9000)')
  h.run('reconcileNotificationCycles(notificationCycles, {rows:[{id:"fresh", title:"再次完成", label:"已完成"}]}, 10000)')
  assert.equal(h.run('visibleNotifications(notificationCycles)[0].title'), '再次完成')
  assert.equal(h.run('visibleNotifications(notificationCycles)[0].label'), '已完成')
})

test('自定义时长只影响新完成通知，不自动消失不创建计时器且仍可手动收起', () => {
  const h = mainHarness()
  h.run('reconcileNotificationCycles(notificationCycles, {rows:[]}, 1000); config.taskDoneDurationSeconds = 5; reconcileNotificationCycles(notificationCycles, {rows:[{id:"a", label:"已完成"}]}, 2000)')
  assert.equal(h.run('notificationCycles.get("done:a").expiresAt'), 7000)
  h.run('config.taskDoneDurationSeconds = 0; reconcileNotificationCycles(notificationCycles, {rows:[{id:"a", label:"已完成"},{id:"b", label:"已完成"}]}, 3000)')
  assert.equal(h.run('notificationCycles.get("done:a").expiresAt'), 7000)
  assert.equal(h.run('notificationCycles.get("done:b").expiresAt'), undefined)
  h.run('sweepExpiredNotifications(notificationCycles, 999999); armCompletionTimers()')
  assert.equal(h.run('completionTimers.size'), 0)
  assert.equal(h.run('visibleNotifications(notificationCycles)[0].id'), 'done:b')
  h.run('notificationCycles.get("done:b").hidden = true')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 0)
})

test('通知偏好同步并保存时长，忽略非法值', () => {
  const h = mainHarness()
  assert.equal(h.run('config.taskDoneDurationSeconds'), 10)
  h.run('saveConfig = () => {}; syncNotifications = () => {}; applyHostNotifyPrefs({taskDoneDurationSeconds:0})')
  assert.equal(h.run('notificationPrefs().taskDoneDurationSeconds'), 0)
  h.run('applyNotificationPrefs({taskDoneDurationSeconds:-1}); applyNotificationPrefs({taskDoneDurationSeconds:"30"})')
  assert.equal(h.run('notificationPrefs().taskDoneDurationSeconds'), 0)
  h.run('applyNotificationPrefs({taskDoneDurationSeconds:30})')
  assert.equal(h.run('notificationPrefs().taskDoneDurationSeconds'), 30)
})

test('通知位置持久化与宿主同步，非法值不覆盖有效选择', () => {
  const h = mainHarness()
  assert.equal(h.run('notificationPrefs().notificationPlacement'), 'dock')
  h.run('syncNotifications = () => {}; applyHostNotifyPrefs({notificationPlacement:"corner"})')
  assert.equal(h.saved().notificationPlacement, 'corner')
  assert.equal(mainHarness(h.saved()).run('config.notificationPlacement'), 'corner')
  h.run('applyNotificationPrefs({notificationPlacement:"invalid"})')
  assert.equal(h.run('notificationPrefs().notificationPlacement'), 'corner')
  h.run('applyNotificationPrefs({notificationPlacement:"dock"})')
  assert.equal(h.run('notificationPrefs().notificationPlacement'), 'dock')
})

test('手动预览忽略开关并去重，支持当前时长与手动关闭', () => {
  const h = mainHarness()
  h.run('syncNotifications=()=>{}; config.notifyTaskDone=false; previewNotification(); previewNotification()')
  assert.equal(h.run('notificationCycles.size'), 1)
  assert.equal(h.run('visibleNotifications(notificationCycles)[0].durationSeconds'), 10)
  assert.match(h.run('visibleNotifications(notificationCycles)[0].title'), /模拟/)
  h.run('sweepExpiredNotifications(notificationCycles, Date.now()+11000)')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 0)
  h.run('config.taskDoneDurationSeconds=0; previewNotification(); sweepExpiredNotifications(notificationCycles,Date.now()+999999)')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 1)
  h.run('notificationCycles.get("__preview-completion__").hidden=true')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 0)
})

test('手动收起只影响当前周期，重复快照不重弹，下一待确认周期可以弹出', () => {
  const h = mainHarness()
  h.run('const pending = {rows:[{id:"a",section:"attention",label:"待确认"}]}; reconcileNotificationCycles(notificationCycles,pending); notificationCycles.get("a").hidden=true; reconcileNotificationCycles(notificationCycles,pending)')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 0)
  h.run('reconcileNotificationCycles(notificationCycles,{rows:[]}); reconcileNotificationCycles(notificationCycles,pending)')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 1)
})

test('浮窗模式跟随位置宽度，右下角模式独立390px常规样式', () => {
  const h = mainHarness()
  h.run('notificationContentHeight=80; notifications={isDestroyed(){return false},setBounds(value){this.bounds=value}}; dock={isDestroyed(){return false},getBounds(){return {x:2200,y:400,width:300,height:28}}}; positionNotifications()')
  assert.equal(h.run('notifications.bounds.x'), 2200)
  assert.equal(h.run('notifications.bounds.y'), 312)
  assert.equal(h.run('notificationLayout().density'), 'compact')
  h.run('config.notificationPlacement="corner"; positionNotifications()')
  const fixed = h.run('JSON.stringify(notifications.bounds)')
  assert.equal(h.run('notifications.bounds.width'), 390)
  assert.equal(h.run('notificationLayout().density'), 'regular')
  h.run('expanded=true; dock.getBounds=()=>({x:20,y:20,width:600,height:200}); positionNotifications()')
  assert.equal(h.run('JSON.stringify(notifications.bounds)'), fixed)
  h.run('config.notificationPlacement="dock"; config.minimizedToTray=true; positionNotifications()')
  assert.equal(h.run('notifications.bounds.width'), 390)
  h.run('config.minimizedToTray=false; positionNotifications()')
  assert.equal(h.run('notifications.bounds.width'), 600)
})

test('浮窗模式使用所在副屏，右下角模式使用主屏', () => {
  const h = mainHarness()
  h.run('screen.getPrimaryDisplay=()=>({workArea:{x:0,y:0,width:1920,height:1040}}); notificationContentHeight=80; notifications={isDestroyed(){return false},setBounds(value){this.bounds=value}}; dock={isDestroyed(){return false},getBounds(){return {x:2200,y:400,width:300,height:28}}}; positionNotifications()')
  assert.equal(h.run('notifications.bounds.x'), 2200)
  h.run('config.notificationPlacement="corner"; positionNotifications()')
  assert.equal(h.run('notifications.bounds.x'), 1920-390-4)
})

test('通知栈限制在副屏工作区内，超高内容不覆盖浮窗', () => {
  const h = mainHarness()
  const value = JSON.parse(h.run('JSON.stringify(notificationBoundsFor({x:2200,y:800,width:300,height:200},{x:1920,y:0,width:1920,height:1040},4000))'))
  assert.equal(value.x, 2200)
  assert.equal(value.y, 0)
  assert.equal(value.height, 792)
  assert(value.y + value.height < 800)
})

test('托盘模式通知固定在工作区右下角，不跟随浮窗', () => {
  const h = mainHarness()
  const corner = JSON.parse(h.run('JSON.stringify(cornerNotificationBounds({x:1920,y:0,width:1920,height:1040},180))'))
  assert.equal(corner.x, 1920 + 1920 - h.run('NOTICE_WIDTH') - 4)
  assert.equal(corner.y, 1040 - 180 - h.run('CORNER_MARGIN_BOTTOM'))
  assert.equal(h.run('CORNER_MARGIN_BOTTOM'), 4)
  assert.equal(corner.width, h.run('NOTICE_WIDTH'))
  assert.equal(h.run('NOTICE_WIDTH'), 390)
  assert.equal(corner.height, 180)
  const clamped = JSON.parse(h.run('JSON.stringify(cornerNotificationBounds({x:0,y:0,width:800,height:200},5000))'))
  assert.equal(clamped.x, 800 - clamped.width - 4)
  assert.equal(clamped.y, 16)
  assert.equal(clamped.y + clamped.height, 200 - h.run('CORNER_MARGIN_BOTTOM'))
  h.run('config.minimizedToTray = true; notificationContentHeight = 100; notifications = { isDestroyed() { return false }, setBounds(value) { this.bounds = value } }; dock = { isDestroyed() { return false }, getBounds() { return { x: 10, y: 20, width: 300, height: 28 } } }; positionNotifications()')
  assert.equal(h.run('notifications.bounds.x'), 1920 + 1920 - h.run('NOTICE_WIDTH') - 4)
  assert.notEqual(h.run('notifications.bounds.x'), 10)
  assert.equal(h.run('dockMenuTemplate().map(item => item.label).join(",")'), '最小化到托盘,设置')
  assert.equal(h.run('trayMenuTemplate().map(item => item.label).join(",")'), '显示悬浮框,设置')
})

test('最小化到托盘隐藏浮窗并记住模式，图标缺失时不进入', () => {
  const h = mainHarness()
  h.run('dock = { hidden: false, hide() { this.hidden = true }, isDestroyed() { return false }, setAlwaysOnTop() {}, showInactive() { this.shown = true } }; ensureTray = () => true; saveConfig = () => { dock.saved = config.minimizedToTray }; syncNotifications = () => {}')
  assert.equal(h.run('minimizeToTray()'), true)
  assert.equal(h.run('dock.hidden'), true)
  assert.equal(h.run('dock.saved'), true)
  h.run('destroyTray = () => { dock.trayGone = true }; applyBounds = () => {}; restoreFromTray()')
  assert.equal(h.run('config.minimizedToTray'), false)
  assert.equal(h.run('dock.shown'), true)
  assert.equal(h.run('dock.trayGone'), true)
  h.run('config.minimizedToTray = false; ensureTray = () => false')
  assert.equal(h.run('minimizeToTray()'), false)
  assert.equal(h.run('config.minimizedToTray'), false)
})

test('宿主托盘切换复用真实隐藏恢复，右键操作稀疏回传并保护未确认状态', async () => {
  const h = mainHarness({ notifyConversation: false, notificationPlacement: 'corner' })
  h.run('globalThis.posts=[]; globalThis.acks=[]; request=(method,route,body)=>{posts.push(JSON.parse(body)); return new Promise(resolve=>acks.push(resolve))}; dock={isDestroyed(){return false},hide(){this.hidden=true},showInactive(){this.hidden=false},setAlwaysOnTop(){}}; ensureTray=()=>true; destroyTray=()=>{}; applyBounds=()=>{}; syncNotifications=()=>{}')
  h.run('applyHostNotifyPrefs({minimizedToTray:true})')
  assert.equal(h.run('dock.hidden'), true)
  assert.equal(h.saved().minimizedToTray, true)
  assert.equal(h.run('JSON.stringify(posts)'), '[{"minimizedToTray":true}]')
  h.run('acks.shift()({status:200})')
  await new Promise(resolve => setImmediate(resolve))
  h.run('trayMenuTemplate()[0].click(); applyHostNotifyPrefs({minimizedToTray:true,notifyTaskDone:false})')
  assert.equal(h.run('dock.hidden'), false)
  assert.equal(h.saved().minimizedToTray, false)
  assert.equal(h.saved().notifyTaskDone, false)
  assert.equal(h.run('JSON.stringify(posts[1])'), '{"minimizedToTray":false}')
  h.run('acks.shift()({status:200})')
  await new Promise(resolve => setImmediate(resolve))
  h.run('applyHostNotifyPrefs({minimizedToTray:false})')
  assert.equal(h.run('posts.length'), 2)
  assert.equal(h.saved().notifyConversation, false)
  assert.equal(h.saved().notificationPlacement, 'corner')
})

test('托盘创建失败清除已保存模式、保持浮窗可见并向宿主纠正 false', async () => {
  const h = mainHarness({ minimizedToTray: true })
  h.run('globalThis.posts=[]; request=async(method,route,body)=>{posts.push(JSON.parse(body));return {status:200}}; dock={isDestroyed(){return false},hide(){throw new Error("must not hide")},showInactive(){this.shown=true},setAlwaysOnTop(){}}; ensureTray=()=>false; destroyTray=()=>{}; applyBounds=()=>{}; syncNotifications=()=>{}; presentDock()')
  assert.equal(h.saved().minimizedToTray, false)
  assert.equal(h.run('dock.shown'), true)
  assert.equal(h.run('JSON.stringify(posts)'), '[{"minimizedToTray":false}]')
  await new Promise(resolve => setImmediate(resolve))
})

test('回传中的快速托盘往返串行发送，旧快照不重隐藏', async () => {
  const h = mainHarness()
  h.run('globalThis.posts=[]; globalThis.acks=[]; request=(method,route,body)=>{posts.push(JSON.parse(body));return new Promise(resolve=>acks.push(resolve))}; ensureTray=()=>true; destroyTray=()=>{}; syncNotifications=()=>{}; minimizeToTray(); restoreFromTray()')
  assert.equal(h.run('posts.length'), 1)
  h.run('acks.shift()({status:200})')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.run('JSON.stringify(posts)'), '[{"minimizedToTray":true},{"minimizedToTray":false}]')
  h.run('applyHostNotifyPrefs({minimizedToTray:true})')
  assert.equal(h.run('config.minimizedToTray'), false)
  h.run('acks.shift()({status:200})')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.run('pendingTrayPrefsRevision'), 0)
})

test('真实托盘单击恢复回传宿主，图标读取异常安全回退', async () => {
  const h = mainHarness()
  h.run('globalThis.posts=[]; request=async(method,route,body)=>{posts.push(JSON.parse(body));return {status:200}}; loadTrayImage=()=>({}); syncNotifications=()=>{}; minimizeToTray()')
  await new Promise(resolve => setImmediate(resolve))
  h.run('tray.events.click()')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.saved().minimizedToTray, false)
  assert.equal(h.run('JSON.stringify(posts)'), '[{"minimizedToTray":true},{"minimizedToTray":false}]')
  h.run('loadTrayImage=()=>{throw new Error("bad image")}; minimizeToTray()')
  assert.equal(h.saved().minimizedToTray, false)
  assert.equal(h.run('tray'), undefined)
})

test('恢复前已发出的 snapshot 返回后不会覆盖托盘状态，其余通知偏好仍应用', async () => {
  const h = mainHarness()
  h.run('globalThis.replySnapshot=null; request=(method,route)=>route==="/snapshot" ? new Promise(resolve=>{replySnapshot=resolve}) : Promise.resolve({status:200}); ensureTray=()=>true; destroyTray=()=>{}; syncNotifications=()=>{}; minimizeToTray()')
  await new Promise(resolve => setImmediate(resolve))
  const refresh = h.run('refresh()')
  await new Promise(resolve => setImmediate(resolve))
  h.run('restoreFromTray()')
  await new Promise(resolve => setImmediate(resolve))
  h.run('replySnapshot({status:200,json:{rows:[],ui:{minimizedToTray:true,notifyTaskDone:false}}})')
  await refresh
  assert.equal(h.saved().minimizedToTray, false)
  assert.equal(h.saved().notifyTaskDone, false)
})

test('关闭任务完成通知不再弹出，重新打开也不会补弹已经错过的完成', () => {
  const h = mainHarness()
  h.run('config.notifyTaskDone = false; reconcileNotificationCycles(notificationCycles, {rows:[{id:"run", title:"跑完了", label:"已完成"}]}, 2000)')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 0)
  h.run('config.notifyTaskDone = true; reconcileNotificationCycles(notificationCycles, {rows:[{id:"run", label:"已完成"}]}, 3000)')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 0)
  h.run('reconcileNotificationCycles(notificationCycles, {rows:[{id:"fresh", title:"新完成", label:"已完成"}]}, 4000)')
  assert.equal(h.run('visibleNotifications(notificationCycles)[0].title'), '新完成')
})

test('关闭对话通知隐藏待确认，重新打开后未手动收起的仍会显示', () => {
  const h = mainHarness()
  h.run('reconcileNotificationCycles(notificationCycles, {rows:[{id:"a", section:"attention", label:"待回答"}]})')
  h.run('config.notifyConversation = false')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 0)
  h.run('config.notifyConversation = true')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 1)
  h.run('notificationCycles.get("a").hidden = true; config.notifyConversation = false; config.notifyConversation = true')
  assert.equal(h.run('visibleNotifications(notificationCycles).length'), 0)
})

test('边缘拖动改变宽度并保持对侧不动，同时夹在工作区与上下限内', () => {
  const h = mainHarness()
  const area = { x: 1920, width: 1920 }
  const start = { x: 2200, y: 1000, width: 300, height: 28 }
  const right = JSON.parse(h.run(`JSON.stringify(boundsAfterWidthDrag(${JSON.stringify(start)}, "right", 80, ${JSON.stringify(area)}))`))
  assert.deepEqual(right, { x: 2200, y: 1000, width: 380, height: 28 })
  const left = JSON.parse(h.run(`JSON.stringify(boundsAfterWidthDrag(${JSON.stringify(start)}, "left", -80, ${JSON.stringify(area)}))`))
  assert.equal(left.x, 2120)
  assert.equal(left.x + left.width, 2500)
  const min = JSON.parse(h.run(`JSON.stringify(boundsAfterWidthDrag(${JSON.stringify(start)}, "right", -500, ${JSON.stringify(area)}))`))
  assert.equal(min.width, 200)
  assert.equal(min.x, 2200)
  const max = JSON.parse(h.run(`JSON.stringify(boundsAfterWidthDrag(${JSON.stringify(start)}, "right", 2000, ${JSON.stringify(area)}))`))
  assert.equal(max.width, 720)
  const edge = JSON.parse(h.run(`JSON.stringify(boundsAfterWidthDrag({x:3600,y:1000,width:300,height:28}, "right", 400, ${JSON.stringify(area)}))`))
  assert.equal(edge.x + edge.width, 3840)
  assert.equal(h.run('storedBarWidth("nope")'), null)
  assert.equal(h.run('storedBarWidth(10)'), 200)
  assert.equal(h.run('storedBarWidth(900)'), 720)
})

test('自定义宽度用于展开和重置位置，重置位置不清宽度', () => {
  const h = mainHarness()
  h.run('saveConfig = () => {}; syncNotifications = () => {}; config.width = 420; dock = { isDestroyed() { return false }, getBounds() { return this.bounds || { x: 2200, y: 1000, width: 300, height: 28 } }, setBounds(value) { this.bounds = value } }')
  h.handlers['set-expanded']({}, true)
  assert.equal(h.run('dock.bounds.width'), 420)
  h.run('applyManagement({ui:{resetPositionRevision:1}})')
  assert.equal(h.run('config.width'), 420)
  assert.equal(h.run('config.x'), null)
  assert.equal(h.run('dock.bounds.width'), 420)
  assert.equal(h.run('dock.bounds.x'), 3396)
})

test('靠近屏幕顶边展开不会越界', () => {
  const h = mainHarness()
  h.run('config.y = 0; dock = { isDestroyed() { return false }, getBounds() { return { x: 2200, y: 0 } }, setBounds(value) { this.bounds = value } }')
  h.handlers['set-expanded']({}, true)
  assert.equal(h.run('dock.bounds.y'), 0)
})

/** 模拟最小 DOM，执行真实渲染脚本的切换与键盘事件。 @returns {object} */
function rendererHarness() {
  const nodes = new Map()
  /** @returns {object} */
  function node() {
    return { children: [], attrs: {}, events: {}, classList: { toggle() {}, add() {}, remove() {} }, append(...items) { this.children.push(...items) }, replaceChildren() { this.children = [] }, setAttribute(k, v) { this.attrs[k] = v }, addEventListener(k, fn) { this.events[k] = fn }, removeEventListener() {}, focus() { this.focused = true } }
  }
  /** @param {string} id @returns {object} */
  function get(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id) }
  const events = {}
  const document = { body: node(), hasFocus: () => true, getElementById: get, querySelector: get, querySelectorAll: () => [], createElement: node, addEventListener: (key, fn) => { events[key] = fn } }
  get('label').parentElement = node()
  const calls = []
  const opened = []
  const callbacks = {}
  const widthCalls = []
  const window = { setInterval() {}, clearInterval() {}, sessionDock: { open: (id) => opened.push(id), setExpanded: (value) => calls.push(value), onExpanded: (fn) => { callbacks.expanded = fn }, onSnapshot: (fn) => { callbacks.snapshot = fn }, beginWidthDrag: (edge) => widthCalls.push(['begin', edge]), endWidthDrag: () => widthCalls.push(['end']), resetWidth: (edge) => widthCalls.push(['reset', edge]), nudgeWidth: (edge, delta) => widthCalls.push(['nudge', edge, delta]) } }
  const html = fs.readFileSync(path.join(root, 'helper/dock.html'), 'utf8')
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { document, window })
  return { get, calls, opened, events, callbacks, widthCalls }
}

test('全部已完成时单行轮播任务名和已完成，而不是只显示空闲', () => {
  const h = rendererHarness()
  h.callbacks.snapshot({ stale: false, rows: [
    { id: 'a', title: '修悬浮框', section: 'attention', label: '已完成', contextPercent: 12, usedTokens: 1200, contextWindow: 10000 },
    { id: 'b', title: '补测试', section: 'attention', label: '已完成' },
  ] })
  assert.equal(h.get('label').textContent, '修悬浮框')
  assert.equal(h.get('label-state').textContent, '已完成')
  assert.equal(h.get('label-state').hidden, false)
  assert.equal(h.get('label-state').className, 'state done')
  assert.equal(h.get('mark').className, 'dot done')
  assert.equal(h.get('bar-summary').children.map((item) => item.textContent).join(' '), '完成 2')
  assert.equal(h.get('context-ring').children.length, 1)
  h.callbacks.snapshot({ stale: false, rows: [
    { id: 'run', title: '仍在运行', section: 'running', label: '运行中' },
    { id: 'done', title: '修悬浮框', section: 'attention', label: '已完成' },
  ] })
  assert.equal(h.get('label').textContent, '仍在运行')
  assert.equal(h.get('label-state').className, 'state')
  h.callbacks.snapshot({ stale: false, rows: [
    { id: 'wait', title: '待确认任务', section: 'attention', label: '待回答' },
    { id: 'done', title: '修悬浮框', section: 'attention', label: '已完成' },
  ] })
  assert.equal(h.get('label').textContent, '空闲')
  assert.equal(h.get('label-state').hidden, true)
  h.callbacks.snapshot({ stale: false, rows: [] })
  assert.equal(h.get('label').textContent, '空闲')
  assert.equal(h.get('mark').className, 'dot idle')
})

test('待确认独立于已完成，分组和汇总保持运行、待确认、完成顺序', () => {
  const h = rendererHarness()
  h.callbacks.snapshot({ stale: false, rows: [
    { id: 'done', title: '完成任务', section: 'attention', label: '已完成' },
    { id: 'pending', title: '确认任务', section: 'attention', label: '待回答' },
    { id: 'running', title: '运行任务', section: 'running', label: '运行中' },
  ] })
  const list = h.get('card-list').children
  assert.deepEqual(list.filter((item) => item.className.startsWith('section')).map((item) => item.textContent), ['运行中', '待确认', '已完成'])
  assert.deepEqual(list.filter((item) => item.type === 'button').map((item) => item.children[1].textContent), ['运行任务', '确认任务', '完成任务'])
  assert.deepEqual(h.get('card-counts').children.map((item) => item.textContent), ['运行 1', '待确认 1', '完成 1'])
})

test('展开后跳转各分组会话及快照刷新均不收起卡片', () => {
  const h = rendererHarness()
  const snapshot = { stale: false, rows: [
    { id: 'running', section: 'running', label: '运行中' },
    { id: 'pending', section: 'attention', label: '待回答' },
    { id: 'done', section: 'attention', label: '已完成' },
  ] }
  h.callbacks.snapshot(snapshot)
  h.get('toggle').events.click()
  for (const button of h.get('card-list').children.filter((item) => item.type === 'button')) {
    button.events.click()
    assert.equal(h.get('toggle').attrs['aria-expanded'], 'true')
    assert.equal(h.get('collapse').attrs['aria-expanded'], 'true')
    assert.deepEqual(h.calls, [true])
  }
  assert.deepEqual(h.opened, ['running', 'pending', 'done'])
  for (const next of [snapshot, { stale: false, rows: [] }, { stale: true, rows: [] }]) {
    h.callbacks.snapshot(next)
    assert.equal(h.get('collapse').attrs['aria-expanded'], 'true')
    assert.deepEqual(h.calls, [true])
  }
  h.get('collapse').events.click()
  assert.equal(h.get('toggle').attrs['aria-expanded'], 'false')
  assert.deepEqual(h.calls, [true, false])
})

test('左右边缘按下开始调宽，松开结束，双击恢复，方向键按所在边缘增减', () => {
  const h = rendererHarness()
  const left = h.get('resize-left')
  left.events.pointerdown({ button: 0, pointerId: 1, preventDefault() {} })
  assert.deepEqual(h.widthCalls[0], ['begin', 'left'])
  left.events.pointerup()
  assert.deepEqual(h.widthCalls[1], ['end'])
  left.events.dblclick({ preventDefault() {} })
  assert.deepEqual(h.widthCalls[2], ['reset', 'left'])
  left.events.keydown({ key: 'ArrowLeft', shiftKey: false, preventDefault() {} })
  assert.deepEqual(h.widthCalls[3], ['nudge', 'left', 16])
  h.get('resize-right').events.keydown({ key: 'ArrowRight', shiftKey: true, preventDefault() {} })
  assert.deepEqual(h.widthCalls[4], ['nudge', 'right', 48])
  left.events.pointerdown({ button: 2, pointerId: 2, preventDefault() {} })
  assert.equal(h.widthCalls.length, 5)
})

test('Escape 不收起卡片，只有切换控件改变展开状态', () => {
  const h = rendererHarness()
  h.get('toggle').events.click()
  h.events.keydown?.({ key: 'Escape' })
  assert.equal(h.get('collapse').attrs['aria-expanded'], 'true')
  assert.deepEqual(h.calls, [true])
  h.get('collapse').events.click()
  assert.equal(h.get('toggle').attrs['aria-expanded'], 'false')
  assert.deepEqual(h.calls, [true, false])
})

test('点击行展开、点击收起和宿主同步可以连续往返', () => {
  const h = rendererHarness()
  h.get('toggle').events.click()
  assert.equal(h.get('toggle').attrs['aria-expanded'], 'true')
  assert.equal(h.get('collapse').focused, true)
  h.get('collapse').events.click()
  assert.equal(h.get('toggle').attrs['aria-expanded'], 'false')
  h.get('toggle').events.click()
  h.get('collapse').events.click()
  assert.deepEqual(h.calls, [true, false, true, false])
  h.callbacks.expanded(true)
  assert.equal(h.get('toggle').attrs['aria-expanded'], 'true')
  assert.equal(h.calls.length, 4)
})
