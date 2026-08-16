/**
 * 预加载脚本：以受控方式向页面暴露最小化的桌面环境信息与能力。
 * contextIsolation: true + sandbox: true，页面拿不到 Node 能力；
 * 所有系统操作（打开终端/文件管理器）都经 ipcRenderer 转交主进程执行。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
  },
  /**
   * 在系统应用中打开目录。
   * @param kind 'terminal' | 'fileManager'
   * @param path 目标目录绝对路径
   * @returns Promise<{ ok: boolean; error?: string }>
   */
  openIn: (kind, path) => ipcRenderer.invoke('dsh-desktop:open-in', { kind, path }),
  /**
   * 订阅通知点击导航事件（主进程推送）。
   * @param callback 收到 { kind: 'session', sessionId } 时调用
   * @returns 取消订阅的函数
   */
  onNavigate: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload)
      } catch {}
    }
    ipcRenderer.on('dsh-desktop:navigate', listener)
    return () => {
      ipcRenderer.removeListener('dsh-desktop:navigate', listener)
    }
  },
  /**
   * 取走待交付的导航请求（窗口是关窗后重建的、页面加载时调用）。
   * 取走即清空：每个请求只交付一次。
   * @returns Promise<{ kind: 'session', sessionId: string } | null>
   */
  takePendingNavigate: () => ipcRenderer.invoke('dsh-desktop:take-navigate'),
})
