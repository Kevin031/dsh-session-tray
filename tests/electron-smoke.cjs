'use strict'
const { app, BrowserWindow, nativeImage } = require('electron')
const { taskbarCanvas } = require('../helper/taskbar-image.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const os = require('node:os')
const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tray-smoke-'))
app.once('will-quit', () => { fs.rmSync(smokeHome, { recursive: true, force: true, maxRetries: 3 }) })
const helper = path.resolve(__dirname, '../dist/desktop')

app.once('browser-window-created', (_event, win) => {
  win.once('ready-to-show', async () => {
    try {
      // 等待生产 ready-to-show 回调完成初始定位。
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (!win.webContents.getURL().endsWith('/dock.html')) return
      // Windows 对原生窗口有最小高度，验证绘制条高度而非系统外框。
      assert.equal(await win.webContents.executeJavaScript("document.getElementById('bar').getBoundingClientRect().height"), 28)
      assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.getElementById('bar')).display"), 'flex')
      for (let i = 0; i < 3; i++) {
        await win.webContents.executeJavaScript("document.getElementById('toggle').click()")
        await new Promise((resolve) => setTimeout(resolve, 100))
        assert.equal(win.getBounds().height, 82)
        assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.getElementById('card')).display"), 'flex')
        assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.getElementById('bar')).display"), 'none')
        await win.webContents.executeJavaScript("document.getElementById('collapse').click()")
        await new Promise((resolve) => setTimeout(resolve, 100))
        // Windows 对原生窗口有最小高度，验证绘制条高度而非系统外框。
      assert.equal(await win.webContents.executeJavaScript("document.getElementById('bar').getBoundingClientRect().height"), 28)
      }
      assert.equal(BrowserWindow.getAllWindows().length, 1)
      if (process.platform === 'darwin') {
        assert.equal(app.dock.isVisible(), false, '助手不应添加额外 Dock 图标')
        assert.equal(win.isVisibleOnAllWorkspaces(), true)
        assert.equal(vm.runInContext('isLeftButtonDown()', context), true, 'macOS 不加载 Windows FFI')
      }
      vm.runInContext('reconcileNotificationCycles(notificationCycles,{rows:[{id:"older",title:"旧通知",section:"attention",label:"待回答"}]}); syncNotifications()', context)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const notices = BrowserWindow.getAllWindows().find((item) => item !== win)
      assert(notices)
      vm.runInContext('reconcileNotificationCycles(notificationCycles,{rows:[{id:"older",title:"旧通知",section:"attention",label:"待回答"},{id:"newer",title:"新通知",section:"attention",label:"待批准"}]}); syncNotifications()', context)
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(await notices.webContents.executeJavaScript("Array.from(document.querySelectorAll('.notice-title'), item=>item.textContent).join(',')"), '新通知,旧通知')
      assert.equal(await notices.webContents.executeJavaScript("getComputedStyle(document.querySelector('.confirm')).color"), 'rgb(255, 255, 255)')
      assert.equal(await notices.webContents.executeJavaScript("document.querySelector('.confirm').textContent"), '去确认')
      assert.equal(await notices.webContents.executeJavaScript("getComputedStyle(document.querySelector('.notice')).padding"), '6px 6px 11px 12px')
      assert.equal(await notices.webContents.executeJavaScript("document.querySelector('.notice-close').getBoundingClientRect().width"), 22)
      // 直接驱动真实主进程布局，验证右下角的独立尺寸和密度。
      vm.runInContext('config.notificationPlacement = "corner"; syncNotifications()', context)
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(notices.getBounds().width, 390)
      const area = vm.runInContext('screen.getPrimaryDisplay().workArea', context)
      assert.equal(notices.getBounds().x, area.x + area.width - 390 - 4)
      if (process.platform === 'darwin') assert.equal(notices.getBounds().y, area.y + 16)
      else assert.equal(notices.getBounds().y + notices.getBounds().height, area.y + area.height - 4)
      assert.equal(await notices.webContents.executeJavaScript("document.body.classList.contains('compact')"), false)
      assert.equal(await notices.webContents.executeJavaScript("getComputedStyle(document.querySelector('.notice')).padding"), '8px 8px 14px 16px')
      assert.equal(await notices.webContents.executeJavaScript("document.querySelector('.notice-close').getBoundingClientRect().width"), 28)
      vm.runInContext('expanded = true; config.width = 540; dock.setBounds({ ...dock.getBounds(), width: 540 }); syncNotifications()', context)
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(notices.getBounds().width, 390)
      vm.runInContext('config.notificationPlacement = "dock"; syncNotifications()', context)
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(notices.getBounds().width, 540)
      vm.runInContext('expanded = false; syncNotifications()', context)
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(await notices.webContents.executeJavaScript("document.body.classList.contains('compact')"), true)
      await notices.webContents.executeJavaScript("window.savedCard = document.querySelector('.notice')")
      vm.runInContext('reconcileNotificationCycles(notificationCycles,{stale:true,rows:[]}); syncNotifications()', context)
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(await notices.webContents.executeJavaScript("window.savedCard === document.querySelector('.notice') && document.querySelectorAll('.notice').length === 2"), true)
      await notices.webContents.executeJavaScript("document.querySelector('.later').click()")
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(await notices.webContents.executeJavaScript("document.querySelectorAll('.notice').length"), 1)
      vm.runInContext('reconcileNotificationCycles(notificationCycles,{rows:[]}); syncNotifications()', context)
      assert.equal(notices.isVisible(), false)
      vm.runInContext('config.notificationPlacement="corner"; syncNotifications()', context)
      // Sample the first visible card on every frame, not just its final settled bounds.
      const firstFrames = notices.webContents.executeJavaScript(`new Promise(resolve => {
        const samples = []; const start = performance.now();
        function sample() {
          const card = document.querySelector('.notice');
          if (card && card.querySelector('.notice-title')?.textContent.includes('通知预览')) samples.push({ top: screenY + card.getBoundingClientRect().top, transform: getComputedStyle(card).transform });
          if (performance.now() - start < 650) requestAnimationFrame(sample); else resolve(samples);
        }
        requestAnimationFrame(sample);
      })`)
      vm.runInContext('config.notifyTaskDone=false; config.taskDoneDurationSeconds=0; previewNotification()', context)
      const samples = await firstFrames
      if (process.platform === 'darwin') {
        assert.ok(samples.length > 5)
        assert.ok(Math.max(...samples.map(item => item.top)) - Math.min(...samples.map(item => item.top)) <= 1, `右上角预览从首帧起不得上下偏移：${JSON.stringify(samples)}`)
        assert.ok(samples.every(item => item.transform === 'none'), '右上角入场仅淡入，不使用垂直位移')
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(notices.isVisible(), true)
      assert.match(await notices.webContents.executeJavaScript("document.querySelector('.notice-title').textContent"), /通知预览/)
      assert.equal(await notices.webContents.executeJavaScript("document.querySelector('.notice-copy').hidden"), true)
      await notices.webContents.executeJavaScript("document.querySelector('.notice-close').click()")
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(notices.isVisible(), false)
      // 替换跳转边界，不打开真实用户会话。
      vm.runInContext('globalThis.openedSessions = []; openSession = async (id) => { openedSessions.push(id); if (id === "fail") throw new Error("mock failure") }', context)
      notices.webContents.send('notifications', [{ id: 'done:done-click', sessionId: 'done-click', title: '完成任务', kind: 'done', durationSeconds: 0, responsePreview: '回复'.repeat(50) }])
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(await notices.webContents.executeJavaScript("document.querySelector('.notice-copy').textContent"), '回复'.repeat(40) + '...')
      assert.equal(await notices.webContents.executeJavaScript("document.querySelector('.notice-copy').hidden"), false)
      assert.equal(await notices.webContents.executeJavaScript("getComputedStyle(document.querySelector('.notice.done')).cursor"), 'pointer')
      assert.equal(await notices.webContents.executeJavaScript("document.querySelector('.notice-open').getAttribute('aria-label')"), '打开会话：完成任务')
      await notices.webContents.executeJavaScript("document.querySelector('.notice-open').click()")
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(vm.runInContext('openedSessions.join(",")', context), 'done-click')
      await notices.webContents.executeJavaScript("document.querySelector('.notice-close').click()")
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(vm.runInContext('openedSessions.length', context), 1)
      notices.webContents.send('notifications', [{ id: 'fail', title: '跳转失败任务', kind: 'done' }])
      await new Promise((resolve) => setTimeout(resolve, 100))
      await notices.webContents.executeJavaScript("document.querySelector('.notice-open').click()")
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(await notices.webContents.executeJavaScript("document.querySelector('.notice-error').hidden"), false)
      assert.equal(await notices.webContents.executeJavaScript("document.querySelector('.notice-error').textContent"), '打开失败，请重试。')
      vm.runInContext('openSettings()', context)
      const settingsWindow = BrowserWindow.getAllWindows().find(item => item !== win && item !== notices)
      assert(settingsWindow)
      await new Promise(resolve => settingsWindow.webContents.once('did-finish-load', resolve))
      const settingsArea = vm.runInContext('screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea', context)
      assert.equal(settingsWindow.getBounds().width, Math.min(560, settingsArea.width))
      assert.equal(settingsWindow.getBounds().height, Math.min(640, settingsArea.height))
      if (settingsArea.width >= 560 && settingsArea.height >= 640) {
        assert.equal(await settingsWindow.webContents.executeJavaScript("document.querySelector('main').scrollHeight <= document.querySelector('main').clientHeight"), true, '常规尺寸不应出现设置内容滚动')
        await settingsWindow.webContents.executeJavaScript("document.getElementById('preview-feedback').textContent = '已请求预览。'")
        assert.equal(await settingsWindow.webContents.executeJavaScript("document.querySelector('main').scrollHeight <= document.querySelector('main').clientHeight"), true, '预览反馈出现后仍应完整展示')
      }
      vm.runInContext('pushNotifyPrefs = async () => {}; applyHostNotifyPrefs({minimizedToTray:true})', context)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(win.isVisible(), false, '设置托盘模式后悬浮框应隐藏')
      assert.equal(vm.runInContext('config.minimizedToTray && !!tray && !tray.isDestroyed()', context), true)
      if (process.platform === 'darwin') {
        assert.equal(vm.runInContext('loadTrayImage().isTemplateImage()', context), true)
        assert.ok(vm.runInContext('tray.getBounds().width', context) > 0, '原生菜单栏图标已创建')
        assert.equal(vm.runInContext('dockMenuTemplate()[0].label', context), '最小化到任务栏')
        vm.runInContext('openedSessions=[]; snapshot={stale:false,rows:[{id:"r1",title:"进行中的任务一",section:"running"},{id:"r2",title:"进行中的任务二",section:"running"},{id:"d1",title:"已完成的任务",section:"attention",label:"已完成"}]}; syncTaskbar()', context)
        const sessionMenu = vm.runInContext('trayMenu()', context)
        assert.equal(sessionMenu.getMenuItemById('taskbar-session:r1').label, '进行中的任务一')
        assert.equal(sessionMenu.getMenuItemById('taskbar-session:d1').label, '已完成的任务')
        await sessionMenu.getMenuItemById('taskbar-session:r1').click()
        await sessionMenu.getMenuItemById('taskbar-session:d1').click()
        assert.equal(vm.runInContext('openedSessions.join(",")', context), 'r1,d1')
        vm.runInContext('snapshot.rows[0].title="重命名后的任务"; syncTaskbar()', context)
        assert.equal(vm.runInContext('trayMenu()', context).getMenuItemById('taskbar-session:r1').label, '重命名后的任务')
        await vm.runInContext('taskbarRenderPromise', context)
        const rendered = await win.webContents.executeJavaScript(`(${taskbarCanvas.toString()})(2,1)`)
        assert.match(rendered.font, /system-ui/)
        if (process.env.DSH_TRAY_RENDER_OUTPUT) fs.writeFileSync(process.env.DSH_TRAY_RENDER_OUTPUT, Buffer.from(rendered.dataURL.split(',')[1], 'base64'))
        const pixels = nativeImage.createFromDataURL(rendered.dataURL).toBitmap()
        let translucent = 0, lightIcon = 0
        const pixelWidth = rendered.width * rendered.scaleFactor
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] > 0 && pixels[i + 3] < 255) translucent++
          if ((i / 4) % pixelWidth < 18 * rendered.scaleFactor && pixels[i] > 220 && pixels[i + 1] > 220 && pixels[i + 2] > 220 && pixels[i + 3] > 200) lightIcon++
        }
        assert.ok(translucent > 20, '圆角与图标应有真实的半透明抗锯齿边缘')
        assert.ok(lightIcon > 20, '深色菜单栏必须有高对比浅色图标笔画')
        assert.equal(vm.runInContext('tray.getTitle()', context), '', '数量渲染为图像 Tag，不再占用文字标题')
        const bothTagsWidth = vm.runInContext('tray.getBounds().width', context)
        assert.equal(vm.runInContext('taskbarSummary().title', context), '运行 2 · 完成 1')
        vm.runInContext('snapshot.rows=[{id:"d1",section:"attention",label:"已完成"},{id:"d2",section:"attention",label:"已完成"}]; syncTaskbar()', context)
        assert.equal(vm.runInContext('tray.getTitle()', context), '')
        await vm.runInContext('taskbarRenderPromise', context)
        assert.equal(vm.runInContext('taskbarSummary().title', context), '完成 2')
        assert.ok(vm.runInContext('tray.getBounds().width', context) < bothTagsWidth, '隐藏零值 Tag 后任务栏宽度应缩小')
        vm.runInContext('syncTaskbar(true)', context)
        assert.equal(vm.runInContext('tray.getTitle()', context), '未连接')
        vm.runInContext('syncTaskbar()', context)
        assert.equal(vm.runInContext('tray.getTitle()', context), '')
        await vm.runInContext('taskbarRenderPromise', context)
        assert.equal(vm.runInContext('taskbarSummary().title', context), '完成 2')
        assert.ok(vm.runInContext('tray.getBounds().width', context) < bothTagsWidth, '隐藏零值 Tag 后任务栏宽度应缩小')
      }
      vm.runInContext('applyHostNotifyPrefs({minimizedToTray:false})', context)
      assert.equal(win.isVisible(), true, '关闭托盘模式后悬浮框应恢复')
      assert.equal(vm.runInContext('config.minimizedToTray', context), false)
      console.log('PASS: 插件设置托盘开关与悬浮框显隐；设置窗口尺寸、内容无滚动及预览反馈；完成通知整卡跳转、关闭隔离、失败提示、通知预览、位置切换及原生浮窗往返、通知新旧堆叠、白字无箭头、断线常驻和节点保留、手动收起与确认清除')
      app.exit(0)
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  })
})
const context = vm.createContext({
  require: (id) => id === 'node:fs' ? { ...fs, readFileSync: () => JSON.stringify({ x: null, y: null }), mkdirSync() {}, writeFileSync() {}, renameSync() {}, unlinkSync() {} } : id.startsWith('.') ? require(path.join(helper, id)) : require(id),
  process: { on: process.on.bind(process), platform: process.platform, pid: process.pid, env: { DSH_SESSION_TRAY_URL: 'http://127.0.0.1:1', DSH_SESSION_TRAY_TOKEN: 'smoke', DSH_SESSION_TRAY_CONFIG_PATH: path.join(smokeHome, 'widget.json') }, exit: (code) => app.exit(code) },
  __dirname: helper, module: { exports: {} }, console, URL, Buffer, setInterval: () => 0, setTimeout,
})
vm.runInContext(fs.readFileSync(path.join(helper, 'main.cjs'), 'utf8'), context)
setTimeout(() => { console.error('Smoke timeout'); app.exit(1) }, 15000).unref()
