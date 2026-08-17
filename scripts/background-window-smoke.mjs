#!/usr/bin/env node
/**
 * dsh-desktop-background 真窗口集成冒烟(Electron + 真实 SPA + 内置插件)。
 * 运行:npx electron --no-sandbox --disable-gpu scripts/background-window-smoke.mjs
 */
import { app } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

app.disableHardwareAcceleration()

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-bg-win-smoke-'))

const { bootDshDesktop } = await import('../electron/dsh-boot.js')
const { createWindowManager } = await import('../electron/window-manager.js')
const { adoptPickedImage, getBackgroundInfo } = await import('../plugins/dsh-desktop-background/lib/index.js')

// 防挂起:超时就退出并报错
const hangGuard = setTimeout(() => {
  console.error('[win-smoke] HANG — forced exit')
  app.exit(2)
}, 90000)

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✔ ${name}`)
  } else {
    failures += 1
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function waitFor(check, { timeout = 30000, label = 'condition' } = {}) {
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

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  writeFileSync(join(process.env.DSH_HOME, 'pick-me.png'), pngBytes)
  const adopted = adoptPickedImage(join(process.env.DSH_HOME, 'pick-me.png'))
  console.log(`[win-smoke] pre-seeded custom background: ${JSON.stringify(adopted)}`)
  check('预置自定义背景成功', adopted.ok === true)

  const ctx = await bootDshDesktop({ args: ['--port', '0'] })
  const port = ctx.webServer.port
  console.log(`[win-smoke] harness on port ${port} (DSH_HOME=${process.env.DSH_HOME})`)

  const wm = createWindowManager()
  wm.setPort(port)
  app.on('window-all-closed', () => {}) // 仿 macOS:关窗不退出
  const win = wm.createWindow()
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log(`[renderer-err] ${String(message).slice(0, 200)}`)
  })

  await waitFor(
    async () =>
      (await win.webContents.executeJavaScript('document.title')) !== '' &&
      (await win.webContents.executeJavaScript('typeof window.dshDesktop?.pickBackground === "function"')),
    { label: 'SPA boot + preload bridge', timeout: 40000 },
  )
  console.log('[win-smoke] SPA ready')

  const bridge = await win.webContents.executeJavaScript(
    'JSON.stringify({ pick: typeof window.dshDesktop?.pickBackground, clear: typeof window.dshDesktop?.clearBackground, get: typeof window.dshDesktop?.getBackground })',
  )
  const bridgeObj = JSON.parse(bridge)
  check('pickBackground 桥存在', bridgeObj.pick === 'function')
  check('clearBackground 桥存在', bridgeObj.clear === 'function')
  check('getBackground 桥存在', bridgeObj.get === 'function')

  // ② 打开设置:找到含「设置」文案的按钮点一下,再轮询「背景」行
  const rowInfo = await waitFor(
    async () => {
      const clicked = await win.webContents
        .executeJavaScript(`(() => {
          const buttons = [...document.querySelectorAll('button')]
          const target = buttons.find((b) => (b.textContent || '').includes('设置'))
          if (!target) return 'no-settings-button'
          target.click()
          return 'clicked:' + (target.textContent || '').trim().slice(0, 20)
        })()`)
        .catch((error) => 'click-error:' + String(error))
      await new Promise((resolve) => setTimeout(resolve, 500))
      return win.webContents
        .executeJavaScript(`(() => {
          const g = document.querySelector('.dsbg_group')
          if (!g) return null
          return JSON.stringify({
            title: (g.querySelector('.dsbg_title') || {}).textContent || '',
            hint: (g.querySelector('.dsbg_hint') || {}).textContent || '',
            style: (document.getElementById('dsh-desktop-background') || {}).textContent || '',
          })
        })()`)
        .catch(() => null)
    },
    { label: '背景行渲染', timeout: 30000 },
  )

  if (rowInfo !== null && rowInfo !== undefined) {
    const row = JSON.parse(rowInfo)
    check('「背景」行已渲染', true)
    check('行标题为「背景」', (row.title || '').includes('背景'), JSON.stringify(row.title))
    check('样式块引用动态路由', (row.style || '').includes('/desktop-wallpaper'), '')
  } else {
    check('「背景」行已渲染', false, '设置面板中未找到 .dsbg_group')
  }

  // ③ 点「恢复默认」→ IPC → 清状态 → 客户端即时改写样式 url
  const clearResult = await win.webContents.executeJavaScript(
    `(async () => {
      const buttons = [...document.querySelectorAll('.dsbg_group button')]
      const target = buttons.find((b) => (b.textContent || '').includes('恢复默认'))
      if (!target) return JSON.stringify({ error: 'no reset button' })
      target.click()
      await new Promise((r) => setTimeout(r, 800))
      let style = ''
      try { style = document.getElementById('dsh-desktop-background').textContent } catch {}
      const state = await window.dshDesktop.getBackground().catch(() => null)
      const hint = (document.querySelector('.dsbg_hint') || {}).textContent || ''
      return JSON.stringify({ styleHasCacheBust: style.includes('/desktop-wallpaper?v='), custom: state ? state.custom : null, hint })
    })()`,
  )
  const clear = JSON.parse(clearResult)
  check('恢复默认后样式 url 带缓存破坏(即时生效)', clear.styleHasCacheBust === true, JSON.stringify(clear))
  check('恢复默认后宿主状态 custom=false', clear.custom === false, JSON.stringify(clear))
  check('行提示回到默认壁纸', (clear.hint || '').includes('默认'), JSON.stringify(clear.hint))

  // ④ 宿主路由回到内置默认 SVG
  const back = await fetch(`http://127.0.0.1:${port}/desktop-wallpaper?v=9`)
  check('路由恢复默认 SVG', back.headers.get('content-type') === 'image/svg+xml')
  check('最终状态 custom=false', getBackgroundInfo().custom === false)

  await ctx.fiber.dispose()
  clearTimeout(hangGuard)
  console.log(failures === 0 ? '[win-smoke] ALL PASS' : `[win-smoke] ${failures} FAILURE(S)`)
  app.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('[win-smoke] fatal:', error)
  app.exit(1)
})