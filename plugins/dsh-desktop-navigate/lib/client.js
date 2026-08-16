/**
 * dsh-desktop-navigate — browser half.
 *
 * Bridges the desktop shell to the web session UI: when the user clicks a
 * desktop notification ("DSH 处理完成" / "DSH 处理出错"), the Electron main
 * process delivers a navigation request through two channels:
 *
 *   1. push — `window.dshDesktop.onNavigate` fires on the live window
 *      (ipcRenderer 'dsh-desktop:navigate').
 *   2. pull — `window.dshDesktop.takePendingNavigate()` returns (and clears)
 *      a request that arrived while no window was open, e.g. a window that
 *      was recreated after Cmd+W on macOS. The pull happens once at plugin
 *      load, covering requests that arrived before the page existed.
 *
 * Each request carries `{ kind: 'session', sessionId }`; the plugin switches
 * the web UI to that session through the client runtime's `sessions.open`.
 * Fail-soft by design: a missing bridge, an unknown session, or a late list
 * never breaks the UI — the open is retried briefly while the session list
 * loads, then logged.
 *
 * @module dsh-desktop-navigate/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-navigate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** Services required before the navigate listener mounts. */
    const inject = ['sessions']

    /** How long to keep retrying an open while the session list loads. */
    const OPEN_RETRY_ATTEMPTS = 10
    const OPEN_RETRY_DELAY_MS = 400

    /**
     * Open the session behind a notification click. The sessions list is
     * pulled on connect, so an early request may hit an unknown session:
     * retry briefly, then give up quietly.
     * @param ctx - client root context.
     * @param sessionId - target session id.
     * @param attempt - current retry attempt (0-based).
     */
    function openSession(ctx, sessionId, attempt = 0) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      try {
        ctx.sessions.open(sessionId)
      } catch (error) {
        if (attempt < OPEN_RETRY_ATTEMPTS) {
          setTimeout(() => openSession(ctx, sessionId, attempt + 1), OPEN_RETRY_DELAY_MS)
        } else {
          console.warn(`[dsh-desktop-navigate] open session ${sessionId} failed: ${String(error)}`)
        }
      }
    }

    /**
     * Client plugin body.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      const api = window.dshDesktop
      if (api == null) return
      if (typeof api.takePendingNavigate === 'function') {
        // Request arrived while no window was open (window recreated after
        // Cmd+W): pull the pending target once at load.
        api
          .takePendingNavigate()
          .then((payload) => {
            if (payload?.kind === 'session') openSession(ctx, payload.sessionId)
          })
          .catch(() => {})
      }
      if (typeof api.onNavigate === 'function') {
        // Live window: push channel from the main process.
        api.onNavigate((payload) => {
          if (payload?.kind === 'session') openSession(ctx, payload.sessionId)
        })
      }
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
