/**
 * Electron 端到端冒烟测试（headless ozone，无需显示器）：
 *   Electron 主进程 → 进程内 boot dsh → BrowserWindow 真实加载 SPA → 校验页面 DOM
 *
 * 注意：在无显示服务器（X/Wayland）的容器里，Chromium 创建窗口会崩溃
 * （SIGSEGV，GPU/合成器初始化失败），这是环境限制而非代码问题。
 * 请在真实桌面环境运行：
 *   npx electron scripts/electron-smoke.mjs
 */
import { app, BrowserWindow } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { bootDshDesktop } from '../electron/dsh-boot.js'

app.disableHardwareAcceleration()

let dshCtx = null

async function run() {
  await app.whenReady()
  if (!process.env.DSH_HOME) {
    process.env.DSH_HOME = path.join(os.homedir(), '.dsh')
  }

  const ctx = await bootDshDesktop({ args: ['--port', '0'] })
  dshCtx = ctx
  const port = ctx.webServer.port
  console.log(`[electron-smoke] harness on port ${port}`)

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  void win.loadURL(`http://127.0.0.1:${port}`)

  await new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', resolve)
    win.webContents.once('did-fail-load', (_e, code, desc) =>
      reject(new Error(`did-fail-load ${code} ${desc}`)),
    )
    win.webContents.once('render-process-gone', (_e, details) =>
      reject(new Error(`renderer gone: ${details.reason}`)),
    )
  })

  const title = await win.webContents.executeJavaScript('document.title')
  const childCount = await win.webContents.executeJavaScript('document.body ? document.body.children.length : -1')
  const hasRoot = await win.webContents.executeJavaScript('!!document.querySelector("#root")')
  console.log(`[electron-smoke] page loaded: title=${JSON.stringify(title)}, bodyChildren=${childCount}, hasRoot=${hasRoot}`)
  if (childCount <= 0 && !hasRoot) {
    throw new Error('SPA did not render any DOM')
  }

  win.destroy()
  await ctx.fiber.dispose()
  console.log('[electron-smoke] OK — full chain works (Electron → boot → SPA render)')
  app.exit(0)
}

run().catch(async (err) => {
  console.error('[electron-smoke] FAIL:', err)
  if (dshCtx) await dshCtx.fiber.dispose().catch(() => {})
  app.exit(1)
})
