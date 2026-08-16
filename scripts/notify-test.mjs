/**
 * 通知插件端到端测试（需真实桌面环境，macOS 会弹出系统通知）：
 *
 *   Electron 主进程 → 进程内 boot dsh → 触发 dsh-desktop-notify 的两个路径
 *     1. agent 需要输入：包装的 ctx.userQuestions.ask —— 通知先于等待弹出
 *        （传已中止的 AbortSignal，originalAsk 随即抛 ASK_ABORTED，便于脚本退出）
 *     2. 处理完成：session/event 火线监听 turn/end(completed)
 *
 * 运行：npx electron scripts/notify-test.mjs
 */
import { app } from 'electron'
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
  console.log('[notify-test] tree booted')

  // 路径 1：agent 需要输入 —— 通知先弹，ask 因 signal 已中止而抛 ASK_ABORTED
  const questions = ctx.get('userQuestions')
  const aborted = new AbortController()
  aborted.abort()
  try {
    await questions.ask({
      questions: [{ id: 't', header: '通知测试', question: '这是一条「需要输入」测试通知' }],
      signal: aborted.signal,
    })
    console.log('[notify-test] unexpected: ask resolved')
  } catch (error) {
    console.log('[notify-test] ask aborted as expected:', error.code ?? error.message)
  }

  // 路径 2：处理完成 —— 真实 session 追加 turn/end(completed)
  const session = ctx.sessions.create()
  session.append(
    'user/message',
    {
      id: 'm-1',
      role: 'user',
      content: [{ type: 'text', text: '这是一条「处理完成」测试通知' }],
      source: { origin: 'user' },
    },
    { surfaceOp: 'append' },
  )
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  console.log('[notify-test] 两条系统通知已触发，停留 4 秒后退出…')
  await new Promise((resolve) => setTimeout(resolve, 4000))
  await ctx.fiber.dispose()
  console.log('[notify-test] OK')
  app.exit(0)
}

run().catch(async (err) => {
  console.error('[notify-test] FAIL:', err)
  if (dshCtx) await dshCtx.fiber.dispose().catch(() => {})
  app.exit(1)
})
