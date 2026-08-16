/**
 * dsh-desktop-notify — host-side DSH plugin.
 *
 * Fires a system notification in two situations:
 *   1. the agent asks the human for input (`ctx.userQuestions.ask`), and
 *   2. a root agent's turn ends — reason `completed` (or `error`).
 *
 * Delivery: inside the Electron desktop app the whole Cordis tree runs in the
 * Electron MAIN process (in-process boot), so Electron's native
 * `Notification` is used directly, with a click focusing the app window.
 * Outside Electron (plain `dsh web` via CLI) the same events degrade to a
 * console line, so the bundle stays loadable in every profile.
 *
 * Fail-soft by design: a notification failure must never break the agent
 * loop or the ask flow — every hook is wrapped and only logs.
 *
 * @module dsh-desktop-notify
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Electron main-process `Notification`/`app`, or null when this process is
 * not inside Electron. Resolved once at module load; guarded so plain Node
 * (the CLI `dsh web`) never fails on the import.
 */
let ElectronNotification = null
let ElectronApp = null
try {
  if (typeof process !== 'undefined' && process.versions?.electron) {
    const electron = require('electron')
    ElectronNotification = electron?.Notification ?? null
    ElectronApp = electron?.app ?? null
  }
} catch {
  // Not inside Electron: fall back to console logging.
}

/** Whether any Electron window currently holds focus. */
function anyWindowFocused() {
  if (ElectronApp === null) return false
  try {
    const { BrowserWindow } = require('electron')
    return BrowserWindow.getAllWindows().some((window) => window.isFocused())
  } catch {
    return false
  }
}

const DEFAULT_CONFIG = {
  notifyOnInput: true,
  notifyOnComplete: true,
  notifyOnError: true,
  quietWhenFocused: true,
}

/** Show one notification; console fallback outside Electron. Never throws. */
function notify(title, body, { quietWhenFocused = false } = {}) {
  if (quietWhenFocused && anyWindowFocused()) return
  if (ElectronNotification !== null) {
    try {
      const notification = new ElectronNotification({ title, body })
      notification.on?.('click', () => {
        try {
          ElectronApp?.focus({ steal: true })
        } catch {}
      })
      notification.show()
      return
    } catch (error) {
      console.warn(`[dsh-desktop-notify] native notification failed: ${String(error)}`)
    }
  }
  console.log(`[dsh-desktop-notify] ${title} — ${body}`)
}

/** Visible text of the session's last user message (text blocks only). */
function lastUserText(session) {
  try {
    const events = session?.events
    if (!Array.isArray(events)) return ''
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'user/message') continue
      const blocks = event.data?.content ?? []
      return blocks
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim()
    }
  } catch {
    // Never let a projection failure escape into the firehose listener.
  }
  return ''
}

/** One-line, length-capped snippet for notification bodies. */
function snippet(text, max = 80) {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/**
 * Subagent sessions end with their own `turn/end` events — those are inner
 * loop noise, not something to notify the human about. Only root sessions
 * (no `subagent` origin, zero delegation depth) notify.
 */
function isRootSession(session) {
  const header = session?.header
  return header?.origin !== 'subagent' && (header?.delegationDepth ?? 0) === 0
}

/**
 * Cordis plugin entry (`name: 'dsh-desktop-notify'` in the bundle patch).
 * @param ctx - the root application context.
 * @param rawConfig - the entry's `config`, overridable by later patch layers.
 * @returns a disposer restoring the wrapped service method.
 */
function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }

  // 1) Agent asks for human input — wrap `ctx.userQuestions.ask`. The wrap is
  //    installed at activation (the entry injects `userQuestions`) and sees
  //    every ask regardless of which UI provider is registered later.
  const questions = ctx.get('userQuestions')
  let restoreAsk = null
  if (questions !== undefined && config.notifyOnInput) {
    const originalAsk = questions.ask.bind(questions)
    questions.ask = async (request) => {
      try {
        const list = request?.questions ?? []
        const first = list[0]
        const title = 'DSH 需要你的输入'
        const body = first
          ? `${first.header ? `${first.header}：` : ''}${first.question}${list.length > 1 ? `（共 ${list.length} 个问题）` : ''}`
          : 'Agent 正在等待你的回答'
        notify(title, body) // input-required is blocking: never quietWhenFocused
      } catch (error) {
        console.warn(`[dsh-desktop-notify] input notification failed: ${String(error)}`)
      }
      return originalAsk(request)
    }
    restoreAsk = () => {
      questions.ask = originalAsk
    }
  }

  // 2) Turn completion / error — the `session/event` firehose on the app
  //    context (`(session, event)`), same subscription the web gateway uses.
  //    `ctx.on` ties the listener to this plugin's fiber: it is torn down
  //    automatically on reload/dispose.
  const disposeEvents = ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'turn/end') return
      if (!isRootSession(session)) return
      const reason = event.data?.reason?.kind
      const task = snippet(lastUserText(session))
      if (reason === 'completed' && config.notifyOnComplete) {
        notify('DSH 处理完成', task ? `「${task}」` : 'Agent 已完成处理', {
          quietWhenFocused: config.quietWhenFocused,
        })
      } else if (reason === 'error' && config.notifyOnError) {
        notify('DSH 处理出错', task ? `「${task}」处理失败` : 'Agent 处理失败', {
          quietWhenFocused: config.quietWhenFocused,
        })
      }
    } catch (error) {
      console.warn(`[dsh-desktop-notify] completion notification failed: ${String(error)}`)
    }
  })

  return () => {
    disposeEvents?.()
    restoreAsk?.()
  }
}

export { apply }
export default apply
