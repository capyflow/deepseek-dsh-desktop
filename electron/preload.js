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
})
