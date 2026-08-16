/**
 * 工作区「Open in」的宿主实现（纯 Node，无 Electron 依赖，可独立测试）。
 * macOS 用 `open`（Finder / Terminal.app / iTerm2），Linux 依次探测常见
 * 终端模拟器与 xdg-open。子进程脱离宿主进程生命周期（detached + unref），
 * 应用退出后终端/文件管理器窗口继续存活。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** 探测 PATH 中是否存在可执行命令。 */
export function hasCommand(bin) {
  try {
    return spawnSync('sh', ['-c', `command -v "${bin}"`], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/** 启动独立子进程；`error` 事件即启动失败（如 ENOENT）。 */
export function detach(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.once('error', (err) => resolve({ ok: false, error: `${cmd}: ${err.message}` }))
    child.once('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}

/** 在终端模拟器中打开目录（macOS / Linux）。 */
export async function openInTerminal(dir) {
  if (process.platform === 'darwin') {
    // 优先 iTerm2（若已安装），否则回退系统 Terminal.app；两者都支持
    // `open -a <App> <dir>`：新窗口以该目录为 cwd 打开。
    const appName = existsSync('/Applications/iTerm.app') ? 'iTerm' : 'Terminal'
    const result = await detach('open', ['-a', appName, dir])
    return result.ok ? { ok: true, app: appName } : result
  }
  if (process.platform === 'linux') {
    // 可用 DSH_DESKTOP_TERMINAL 指定终端（通用 -e 形式）；否则按常见终端探测。
    const envTerm = process.env.DSH_DESKTOP_TERMINAL
    const quoted = dir.replace(/'/g, `'\\''`)
    const shellCmd = `cd '${quoted}' && exec "$SHELL"`
    const candidates = envTerm
      ? [{ bin: envTerm, args: ['-e', 'sh', '-c', shellCmd] }]
      : [
          { bin: 'gnome-terminal', args: ['--working-directory=' + dir] },
          { bin: 'konsole', args: ['--workdir', dir] },
          { bin: 'xfce4-terminal', args: ['--working-directory=' + dir] },
          { bin: 'kitty', args: ['--directory', dir] },
          { bin: 'alacritty', args: ['--working-directory', dir] },
          { bin: 'wezterm', args: ['start', '--cwd', dir] },
          { bin: 'xterm', args: ['-e', 'sh', '-c', shellCmd] },
        ]
    for (const candidate of candidates) {
      if (!hasCommand(candidate.bin)) continue
      const result = await detach(candidate.bin, candidate.args)
      return result.ok ? { ok: true, app: candidate.bin } : result
    }
    return { ok: false, error: '未找到可用终端；可通过环境变量 DSH_DESKTOP_TERMINAL 指定' }
  }
  return { ok: false, error: `unsupported platform: ${process.platform}` }
}

/** 在系统文件管理器中打开目录（macOS Finder / Linux 默认文件管理器）。 */
export async function openInFileManager(dir) {
  if (process.platform === 'darwin') {
    const result = await detach('open', [dir])
    return result.ok ? { ok: true, app: 'Finder' } : result
  }
  if (process.platform === 'linux') {
    if (hasCommand('xdg-open')) {
      const result = await detach('xdg-open', [dir])
      return result.ok ? { ok: true, app: 'xdg-open' } : result
    }
    return { ok: false, error: 'xdg-open not found' }
  }
  return { ok: false, error: `unsupported platform: ${process.platform}` }
}
