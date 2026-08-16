/**
 * DeepSeek Harness Desktop — 主窗口与通知导航的窗口管理（纯逻辑层）。
 *
 * 从 electron/main.js 抽出的可测试窗口状态机：持有主窗口、harness 端口与
 * 待交付的导航请求，提供 createWindow / navigateRequest / takePendingNavigate
 * / activate / focusExisting。main.js 只负责把 Electron 生命周期事件接到
 * 这里；集成测试（scripts/notify-navigate-smoke.mjs）直接使用同一实现，
 * 保证被测逻辑与线上一致。
 *
 * 导航协议（与 dsh-desktop-notify 插件、dsh-desktop-navigate 客户端插件约定）：
 *   - 请求：`{ kind: 'session', sessionId }`
 *   - 窗口在 → 聚焦并把请求推给渲染进程（webContents.send 'dsh-desktop:navigate'）
 *   - 窗口不在（macOS Cmd+W 关窗后应用仍在运行）→ 暂存请求并重建窗口，
 *     客户端插件在页面加载后通过 take-navigate IPC 取走（取走即清空）
 */
import { BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 创建窗口管理器。 */
export function createWindowManager() {
  /** 当前主窗口 */
  let mainWindow = null
  /** harness 实际监听端口（窗口关闭后重建窗口时复用） */
  let mainPort = null
  /** 待交付的导航请求（见模块注释） */
  let pendingNavigate = null

  /**
   * 创建加载本地 harness UI 的窗口（复用已 boot 的端口）。
   * @returns 新创建的 BrowserWindow
   */
  function createWindow() {
    if (mainPort === null) {
      throw new Error('window-manager: no harness port set — call setPort() after boot')
    }
    const port = mainPort
    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 940,
      minHeight: 600,
      title: 'DeepSeek Harness Desktop',
      autoHideMenuBar: true,
      backgroundColor: '#0f1115',
      // Linux 窗口图标（macOS/Windows 使用应用包/可执行文件自带的图标，此处不生效）
      ...(process.platform === 'linux' ? { icon: path.join(__dirname, 'assets', 'icon.png') } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // 只允许停留在本地 harness 源内；外部导航一律拦截
    win.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`http://127.0.0.1:${port}/`)) {
        event.preventDefault()
      }
    })
    win.webContents.setWindowOpenHandler(() => {
      // 新窗口/外链不放开（后续可做成 openExternal）
      return { action: 'deny' }
    })

    void win.loadURL(`http://127.0.0.1:${port}`)
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null
    })
    mainWindow = win
    return win
  }

  return {
    /** 当前主窗口（可能为 null）。 */
    get window() {
      return mainWindow
    },
    /** harness 端口（boot 完成 setPort 之后才可用）。 */
    get port() {
      return mainPort
    },
    /** 设置 harness 端口（boot 完成后调用；之后 createWindow/activate 复用）。 */
    setPort(port) {
      mainPort = port
    },
    /** 创建主窗口（复用已 setPort 的端口）。 */
    createWindow,
    /**
     * 通知点击导航（由 dsh-desktop-notify 经 app 事件 'dsh-desktop:navigate-request'
     * 触发）：窗口在 → 聚焦并推送；窗口不在 → 暂存请求并重建窗口。
     * @param payload - `{ kind: 'session', sessionId }`
     */
    navigateRequest(payload) {
      pendingNavigate = payload ?? null
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
        mainWindow.webContents.send('dsh-desktop:navigate', payload)
      } else if (mainPort !== null) {
        createWindow()
      }
    },
    /**
     * 客户端插件（dsh-desktop-navigate）在页面加载后取走暂存的导航请求。
     * 取走即清空：每个请求只交付一次。
     * @returns 暂存的请求或 null
     */
    takePendingNavigate() {
      const payload = pendingNavigate
      pendingNavigate = null
      return payload
    },
    /**
     * macOS activate：点击 Dock 图标。无窗口则重建，有窗口则聚焦。
     */
    activate() {
      if (mainWindow) {
        mainWindow.focus()
      } else if (mainPort !== null) {
        createWindow()
      }
    },
    /**
     * 单实例锁 second-instance：重复启动时只聚焦已有窗口（不重建）。
     */
    focusExisting() {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    },
  }
}
