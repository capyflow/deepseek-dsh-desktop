/**
 * DeepSeek Harness Desktop — Electron 主进程
 *
 * 核心思路：dsh 官方支持"进程内 boot"（@deepseek-ai/dsh-app-boot 的 boot() /
 * apps/cli 的 runProfile）。我们直接在自己的进程里把整个 web profile 跑起来：
 *
 *   runProfile({ profile: 'web', args: ['--port', '0'], ... })
 *        │
 *        ▼
 *   Cordis 插件树 ──► WebServer 监听 127.0.0.1:<OS 自动分配端口>
 *        │              ├── /api/*   RPC (HTTP + WebSocket)
 *        │              └── 静态 SPA dist（apps/web 的构建产物）
 *        ▼
 *   BrowserWindow 加载 http://127.0.0.1:<port>   ← 与 trust fence 要求的回环同源一致
 *
 * 单进程、无子进程管理、无端口冲突。关窗即 dispose 插件树退出。
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { bootDshDesktop } from './dsh-boot.js'
import { openInFileManager, openInTerminal } from './open-in.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * 工作区「Open in」的 IPC 接线：渲染进程（preload 桥）→ 主进程 →
 * electron/open-in.js（纯 Node 宿主实现，macOS/Linux）。
 */

/** 校验来自页面的路径：必须是非空绝对路径且目录存在。 */
function validOpenPath(p) {
  return typeof p === 'string' && p.startsWith('/') && p !== '/' && existsSync(p)
}

/** 工作区「Open in」IPC：渲染进程 → 主进程。 */
ipcMain.handle('dsh-desktop:open-in', async (_event, payload) => {
  const { kind, path } = payload ?? {}
  if (!validOpenPath(path)) return { ok: false, error: 'invalid path' }
  if (kind === 'terminal') return openInTerminal(path)
  if (kind === 'fileManager') return openInFileManager(path)
  return { ok: false, error: `unknown kind: ${String(kind)}` }
})

/** 单实例锁：重复启动时聚焦已有窗口 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  void main()
}

/** 已 boot 的 dsh 根上下文（Cordis Context），退出时 dispose */
let dshCtx = null
/** 当前主窗口 */
let mainWindow = null

async function main() {
  // 桌面应用不允许静默崩溃：任何未捕获错误都弹窗并带出日志
  process.on('uncaughtException', (err) => showFatal(err))
  process.on('unhandledRejection', (err) => showFatal(err))

  await app.whenReady()

  // 开发模式（未打包）下 Dock 显示鲸鱼图标；打包后由应用包自带的 icon.icns 提供
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(path.join(__dirname, 'assets', 'icon.png'))
  }

  // 与 CLI 共用 ~/.dsh：桌面端和 dsh CLI 共享同一套配置/凭据/会话。显式设置的 DSH_HOME 优先。
  if (!process.env.DSH_HOME) {
    process.env.DSH_HOME = path.join(os.homedir(), '.dsh')
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('window-all-closed', () => {
    // 本地工具型应用：窗口全关即退出（含 macOS），避免遗留 harness 进程
    app.quit()
  })

  app.on('will-quit', (event) => {
    // 先 dispose dsh 插件树（关服务器、落盘会话），再真正退出
    if (dshCtx) {
      event.preventDefault()
      const ctx = dshCtx
      dshCtx = null
      void ctx.fiber.dispose().finally(() => app.exit(0))
    }
  })

  try {
    const port = await bootDsh()
    createWindow(port)
  } catch (err) {
    showFatal(err)
  }
}

/**
 * 进程内启动 dsh web profile。
 * `--port 0` 让 OS 分配空闲端口，boot 完成后从 ctx.webServer.port 读出实际端口。
 * @returns 实际监听端口
 */
async function bootDsh() {
  const ctx = await bootDshDesktop({
    args: ['--port', '0'],
    onExit: (code) => {
      console.log(`[dsh-desktop] cmdline requested exit(${code})`)
    },
  })
  dshCtx = ctx
  const port = ctx.webServer?.port
  if (!port) {
    throw new Error('dsh web server did not expose a listening port')
  }
  console.log(`[dsh-desktop] harness listening on http://127.0.0.1:${port}`)
  return port
}

/** 创建加载本地 harness UI 的窗口 */
function createWindow(port) {
  mainWindow = new BrowserWindow({
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
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) {
      event.preventDefault()
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 新窗口/外链不放开（后续可做成 openExternal）
    return { action: 'deny' }
  })

  void mainWindow.loadURL(`http://127.0.0.1:${port}`)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** 致命错误：弹窗 + 日志 + 释放 dsh 上下文后退出 */
function showFatal(err) {
  const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err)
  console.error('[dsh-desktop] fatal:', err)
  try {
    dialog.showErrorBox('DeepSeek Harness Desktop', message)
  } catch {
    /* 对话框不可用时忽略（如无显示环境） */
  }
  if (dshCtx) {
    void dshCtx.fiber.dispose().finally(() => app.exit(1))
  } else {
    app.exit(1)
  }
}
