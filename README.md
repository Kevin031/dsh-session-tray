# DSH 桌面状态栏

在宿主桌面显示运行中、待确认和已完成会话，支持通知、可调宽度浮窗以及托盘/菜单栏模式。

## 平台支持

| 平台 | 架构 | 运行时 | 隐藏后恢复入口 |
| --- | --- | --- | --- |
| Windows | x64、arm64 | 官方 Electron Windows ZIP | 系统托盘单击或右键菜单 |
| macOS | Intel x64、Apple Silicon arm64 | 官方 Electron.app | 顶部菜单栏图标菜单 |

首次安装并启用时自动下载固定版本 Electron 45.1.0，校验官方 SHA256 后安装。macOS 使用系统 ditto 保留执行权限、应用签名和框架链接；安装前检查相对链接、循环链接、路径穿越以及链接下的写入。Windows 继续使用 PowerShell Expand-Archive，保留既有运行时目录和配置，不要求迁移。

macOS 助手不增加额外 Dock 图标，浮窗和通知支持所有桌面与全屏空间。最小化到任务栏后，以系统字体的橙/绿数字 Tag 显示运行/完成数量，零值隐藏；图标使用高对比描边，圆角和数字使用 Retina 抗锯齿绘制。点击任务栏菜单可按“进行中 / 已完成”查看会话标题并跳转；会话重命名和状态变化会同步更新。固定通知位于右上角，仅淡入，不使用垂直入场动画；Windows 固定通知保持右下角。

调宽依赖 Pointer Capture，macOS 不加载 Windows user32。Windows 可从宿主解析可选 koffi，全局按键探测不可用时仍回退 Pointer Capture，不再依赖开发机固定盘符。

## 安装与使用

通过 DSH 插件管理器安装本目录；这是持久安装，会作用于当前 profile。无需安装生命周期脚本授权。

设置 → 桌面状态栏：查看下载进度、启停、重启、重置位置、切换托盘模式、设置通知和预览通知。助手响应管理器退出信号，不会因不可关闭浮窗而阻塞停用/重启。

## 验证

```sh
npm ci --ignore-scripts
npm run sync:layout-mock
npm run check
```

测试覆盖 Windows/macOS × x64/arm64 的运行时选择、下载文件名、安装校验、ready 握手、重启/停用，以及 macOS 框架链接安全校验。

原生集成测试（使用本机安装的 Electron 路径）：

```sh
/path/to/Electron tests/electron-smoke.cjs
```

本次交付在 macOS arm64 上通过 99 项自动测试、TypeScript checkJs、真实 Electron 浮窗/通知/菜单栏测试，以及当前 DSH profile 的启动、重启、停用和重新启用。Windows 与 Intel Mac 的平台分支经过隔离回归测试，尚未在对应真机验收；Web 设置入口已确认注册，但插件管理器图标的实际页面渲染未做人工视觉验收。
