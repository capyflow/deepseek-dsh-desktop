/**
 * smoke 冒烟测试：纯 Node 环境（无需 Electron/显示器）验证核心集成链路
 *
 *  1. 进程内 boot dsh web profile（--port 0 → OS 自动分配）
 *  2. 从 ctx.webServer.port 读出实际端口
 *  3. HTTP 请求首页，确认 SPA 静态资源被正常服务
 *  4. dispose 插件树，干净退出
 *
 * 运行：npm run smoke
 */
import { bootDshDesktop } from '../electron/dsh-boot.js'

console.log('[smoke] booting dsh web profile in-process (port 0 = OS-assigned)...')

const ctx = await bootDshDesktop({ args: ['--port', '0'] })

const port = ctx.webServer?.port
if (!port) {
  throw new Error('ctx.webServer.port unavailable after boot')
}
console.log(`[smoke] web server listening on port ${port}`)

const res = await fetch(`http://127.0.0.1:${port}/`)
const body = await res.text()
console.log(
  `[smoke] GET / -> HTTP ${res.status}, content-type=${res.headers.get('content-type')}, ${body.length} bytes`,
)
if (res.status !== 200) {
  throw new Error(`expected 200, got ${res.status}`)
}

await ctx.fiber.dispose()
console.log('[smoke] OK — dsh boots in-process and serves the SPA; tree disposed cleanly')
process.exit(0)
