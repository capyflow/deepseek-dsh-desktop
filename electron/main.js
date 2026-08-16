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
 * 单进程、无子进程管理、无端口冲突。窗口与导航状态机在 window-manager.js
 * （main.js 只做生命周期接线）。
 */
import { app, dialog, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { bootDshDesktop } from './dsh-boot.js'
import { openInFileManager, openInTerminal } from './open-in.js'
import { createWindowManager } from './window-manager.js'

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

/** 主窗口与通知导航状态机（窗口、端口、待交付导航请求） */
const wm = createWindowManager()

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

  // 单实例：重复启动只聚焦已有窗口
  app.on('second-instance', () => wm.focusExisting())

  app.on('window-all-closed', () => {
    // macOS：Cmd+W 只关窗口不退出应用（符合平台习惯），Dock 图标/通知点击
    // 可随时把窗口重新拉起来（见 activate / navigate-request 处理）。
    // 其他平台：窗口全关即退出，避免遗留 harness 进程。
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  // macOS：点击 Dock 图标时，无窗口则重建窗口，有窗口则聚焦
  app.on('activate', () => wm.activate())

  // 通知点击导航：窗口在 → 聚焦并推送；窗口不在（Cmd+W 关窗后）→ 暂存请求
  // 并重建窗口，由客户端插件在页面加载后取走（take-navigate IPC）。
  app.on('dsh-desktop:navigate-request', (payload) => wm.navigateRequest(payload))

  // 客户端插件加载时取走待交付的导航请求（取走即清空，只交付一次）
  ipcMain.handle('dsh-desktop:take-navigate', () => wm.takePendingNavigate())

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
    wm.setPort(port)
    wm.createWindow()
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
