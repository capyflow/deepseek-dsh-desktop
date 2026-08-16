/**
 * 预加载脚本：以受控方式向页面暴露最小化的桌面环境信息。
 * contextIsolation: true + sandbox: true，页面拿不到 Node 能力。
 */
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
  },
})
