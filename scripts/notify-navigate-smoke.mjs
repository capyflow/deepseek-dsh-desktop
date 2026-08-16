/**
 * 通知导航集成冒烟测试（Electron 主进程环境）。
 *
 * 覆盖本次改造的两条链路，全部走真实组件：
 *   - electron/window-manager.js（main.js 的窗口/导航状态机，测试与线上同一实现）
 *   - electron/preload.js（contextBridge 桥）
 *   - 真实 SPA + dsh-desktop-navigate 客户端插件（sessions.open → UI 切换）
 *
 * 断言信号：客户端运行时把当前会话选择持久化到 localStorage
 * 'dsh.sessions.current'（createSnapshotStore persist），插件成功 open 后
 * 该值应包含目标 sessionId——这是从"通知点击"到"页面切换"的完整端到端证据。
 *
 * 运行（从仓库根目录，工作区与会话作用域一致）：
 *   npx electron scripts/notify-navigate-smoke.mjs
 *
 * 会话 id 取自 ~/.dsh/sessions/<workspace>/ 下已持久化的真实会话。
 */
import { app, ipcMain } from 'electron'
import { readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { bootDshDesktop } from '../electron/dsh-boot.js'
import { createWindowManager } from '../electron/window-manager.js'

app.disableHardwareAcceleration()

/** 本工作区（cwd）已持久化的会话 id 列表。 */
function persistedSessionIds() {
  const workspaceKey = `--${process.cwd().replaceAll('/', '-').replace(/^-/, '')}--`
  const dir = path.join(os.homedir(), '.dsh', 'sessions', workspaceKey)
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

let dshCtx = null
const rendererLogs = []

/** 轮询等待条件成立（默认 15s / 250ms）。 */
async function waitFor(check, { timeout = 15000, label = 'condition' } = {}) {
  const start = Date.now()
  let lastError
  while (Date.now() - start < timeout) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timeout waiting for ${label}${lastError ? ` (last: ${String(lastError)})` : ''}`)
}

async function run() {
  await app.whenReady()
  if (!process.env.DSH_HOME) {
    process.env.DSH_HOME = path.join(os.homedir(), '.dsh')
  }

  const sessions = persistedSessionIds()
  if (sessions.length < 2) {
    throw new Error(`need ≥2 persisted sessions, found ${sessions.length}: ${sessions.join(', ')}`)
  }
  const [sessionA, sessionB] = sessions
  console.log(`[nav-smoke] target sessions: ${sessionA}, ${sessionB}`)

  const ctx = await bootDshDesktop({ args: ['--port', '0'] })
  dshCtx = ctx
  const port = ctx.webServer.port
  console.log(`[nav-smoke] harness on port ${port}`)

  // 与 main.js 完全相同的接线（共用 window-manager 实现）
  const wm = createWindowManager()
  app.on('dsh-desktop:navigate-request', (payload) => wm.navigateRequest(payload))
  // 模拟 main.js 的 macOS 行为：关窗不退出应用（Cmd+W 后可重建窗口）
  app.on('window-all-closed', () => {})
  ipcMain.handle('dsh-desktop:take-navigate', () => wm.takePendingNavigate())
  wm.setPort(port)

  // ── ① 推送路径：窗口已在，通知点击 → 聚焦并推送 → 客户端插件切换会话 ──
  const win = wm.createWindow()
  win.webContents.on('console-message', (_event, _level, message) => {
    rendererLogs.push(String(message))
  })

  // 等 SPA boot + 客户端插件注册完成（title 非空 = 应用壳已渲染）
  await waitFor(
    async () =>
      (await win.webContents.executeJavaScript('document.title')) !== '' &&
      (await win.webContents.executeJavaScript('typeof window.dshDesktop?.takePendingNavigate === "function"')),
    { label: 'SPA boot + preload bridge', timeout: 30000 },
  )
  const titleBefore = await win.webContents.executeJavaScript('document.title')
  console.log(`[nav-smoke] SPA ready (title: ${JSON.stringify(titleBefore)})`)

  // 旁路收集器：独立确认推送到达渲染进程
  await win.webContents.executeJavaScript(
    'window.__navCollected = []; window.dshDesktop.onNavigate((p) => window.__navCollected.push(p)); true',
  )

  // 与 dsh-desktop-notify 通知点击相同的请求
  app.emit('dsh-desktop:navigate-request', { kind: 'session', sessionId: sessionA })

  await waitFor(
    async () => (await win.webContents.executeJavaScript('window.__navCollected.length')) > 0,
    { label: 'push delivery to renderer', timeout: 10000 },
  )
  const collected = await win.webContents.executeJavaScript('JSON.stringify(window.__navCollected)')
  console.log(`[nav-smoke] push payload received: ${collected}`)
  if (!collected.includes(sessionA)) throw new Error('push payload missing sessionId')

  // 客户端插件 open 成功 → 选择持久化到 localStorage
  await waitFor(
    async () => {
      const raw = await win.webContents.executeJavaScript('localStorage.getItem("dsh.sessions.current")')
      return raw !== null && raw.includes(sessionA)
    },
    { label: 'session opened via push', timeout: 20000 },
  )
  console.log('[nav-smoke] ✓ push chain: notification click → renderer → plugin → session opened')

  // ── ② pending 路径：Cmd+W 关窗（应用不退出）→ 通知点击 → 重建窗口并导航 ──
  win.destroy()
  await waitFor(() => wm.window === null, { label: 'window closed' })
  console.log('[nav-smoke] window closed (simulating Cmd+W); app stays alive')

  app.emit('dsh-desktop:navigate-request', { kind: 'session', sessionId: sessionB })
  const win2 = await waitFor(() => wm.window, { label: 'window recreated', timeout: 20000 })
  await waitFor(
    async () => {
      const raw = await win2.webContents.executeJavaScript('localStorage.getItem("dsh.sessions.current")')
      return raw !== null && raw.includes(sessionB)
    },
    { label: 'session opened via pending pull', timeout: 30000 },
  )
  console.log('[nav-smoke] ✓ pending chain: closed window → navigate-request → recreate → plugin pull → session opened')

  // 暂存请求已被客户端插件取走
  const pendingAfter = await win2.webContents.executeJavaScript('window.dshDesktop.takePendingNavigate()')
  if (pendingAfter !== null) {
    throw new Error(`pending navigate not consumed by client plugin: ${JSON.stringify(pendingAfter)}`)
  }
  console.log('[nav-smoke] ✓ pending navigate consumed (delivered exactly once)')

  // 客户端插件不应报 open 失败（真实会话 + 重试兜底）
  const failures = rendererLogs.filter((line) => line.includes('[dsh-desktop-navigate] open session'))
  if (failures.length > 0) {
    throw new Error(`client plugin reported open failures: ${failures.join(' | ')}`)
  }

  console.log('[nav-smoke] OK — push + pending notification-navigation chains verified end-to-end')
  win2.destroy()
  await ctx.fiber.dispose()
  app.exit(0)
}

run().catch(async (error) => {
  console.error('[nav-smoke] FAIL:', error)
  if (dshCtx) await dshCtx.fiber.dispose().catch(() => {})
  app.exit(1)
})
