#!/usr/bin/env node
/**
 * dsh-desktop-background 集成冒烟测试(纯 Node,不开窗口,不碰线上 ~/.dsh)。
 *
 * 覆盖:
 *   1. 宿主路由 /desktop-wallpaper 就绪,默认返回内置 SVG 壁纸;
 *   2. GET / 的 __DSH_BOOT__ 出现 dsh-desktop-background 客户端条目,
 *      且注入的样式块第二层兜底 url 仍是 /wallpaper.svg;
 *   3. adoptPickedImage 把图复制进 DSH_HOME → 路由出图内容=副本内容;
 *   4. clearBackground 清空 → 路由回到内置默认,MIME 恢复 image/svg+xml。
 *
 * 运行:node scripts/background-smoke.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-bg-smoke-'))

const { bootDshDesktop } = await import('../electron/dsh-boot.js')
const { adoptPickedImage, clearBackground, getBackgroundInfo } = await import(
  '../plugins/dsh-desktop-background/lib/index.js'
)

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✔ ${name}`)
  } else {
    failures += 1
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main() {
  const ctx = await bootDshDesktop({ args: ['--port', '0'] })
  const port = ctx.webServer?.port
  console.log(`[bg-smoke] harness on port ${port}, DSH_HOME=${process.env.DSH_HOME}`)

  // 等路由就绪(插件 apply 在 boot 完成前/后激活,给一点余量)
  const base = `http://127.0.0.1:${port}`
  let routeUp = false
  for (let i = 0; i < 40; i += 1) {
    try {
      const probe = await fetch(`${base}/desktop-wallpaper`)
      if (probe.status === 200) { routeUp = true; break }
    } catch { /* boot 未完成 */ }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  check('路由 /desktop-wallpaper 就绪', routeUp)

  // ① 默认壁纸
  const def = await fetch(`${base}/desktop-wallpaper`)
  const defType = def.headers.get('content-type')
  const defBody = await def.text()
  check('默认出图 content-type=image/svg+xml', defType === 'image/svg+xml', defType)
  check('默认出图内容为 SVG', defBody.includes('<svg'), defBody.slice(0, 40))

  // ② 客户端发现 + 样式块
  const index = await (await fetch(`${base}/`)).text()
  check('客户端条目 dsh-desktop-background 进入 __DSH_BOOT__', index.includes('"id":"dsh-desktop-background"'))
  const styleMatch = index.match(/<style id="dsh-desktop-background">[\s\S]*?<\/style>/)
  check('样式块已注入', styleMatch !== null)
  check(
    '样式块主层指向动态路由、兜底层指向静态 svg',
    styleMatch !== null && styleMatch[0].includes('url("/desktop-wallpaper")') && styleMatch[0].includes('url("/wallpaper.svg")'),
  )

  // ③ 选图 → 路由出图 = 副本
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  const picked = join(process.env.DSH_HOME, 'pick-me.png')
  writeFileSync(picked, pngBytes)
  const adopted = adoptPickedImage(picked)
  check('adoptPickedImage 成功', adopted.ok === true, JSON.stringify(adopted))
  const info = getBackgroundInfo()
  check('状态标记为自定义', info.custom === true)
  const custom = await fetch(`${base}/desktop-wallpaper?v=1`)
  const customBody = Buffer.from(await custom.arrayBuffer())
  check('路由出图 = 复制的图片内容', customBody.equals(pngBytes), `len=${customBody.length}`)
  check('自定义出图 MIME=image/png', (custom.headers.get('content-type') ?? '').includes('image/png'))

  // ④ 恢复默认
  const cleared = clearBackground()
  check('clearBackground 成功', cleared.ok === true)
  const back = await fetch(`${base}/desktop-wallpaper?v=2`)
  check('恢复后回到 SVG', back.headers.get('content-type') === 'image/svg+xml')
  check('恢复后信息 custom=false', getBackgroundInfo().custom === false)

  await ctx.fiber.dispose()
  console.log(failures === 0 ? '[bg-smoke] ALL PASS' : `[bg-smoke] ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[bg-smoke] fatal:', error)
  process.exit(1)
})