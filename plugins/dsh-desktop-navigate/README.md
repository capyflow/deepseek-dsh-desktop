# dsh-desktop-navigate

DSH 桌面客户端的内置客户端插件：点击系统通知（"DSH 处理完成" / "DSH 处理出错"）
后，打开/聚焦应用窗口并自动切换到对应的会话。

## 工作原理

- **host 侧**（`lib/index.js`）：空实现。行必须存在于 patch 树中，这样
  dsh-client-modules 才能扫描到本包（`dsh.client` 声明）并把它编入
  `window.__DSH_BOOT__`。
- **client 侧**（`lib/client.js`）：浏览器模块。通过 preload 桥接的两条通道
  接收导航请求，并调用客户端运行时 `sessions.open(sessionId)` 切换会话：
  - 推：`window.dshDesktop.onNavigate`（窗口已在时，主进程直接推送）；
  - 拉：`window.dshDesktop.takePendingNavigate()`（窗口是关窗后重建的，
    页面加载时取走主进程暂存的请求）。

请求格式：`{ kind: 'session', sessionId }`，由 dsh-desktop-notify 在通知点击
时通过主进程事件 `dsh-desktop:navigate-request` 发起。
