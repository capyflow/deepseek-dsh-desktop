/**
 * dsh-desktop-background — host-side DSH plugin.
 *
 * 整窗壁纸的宿主半边：
 *   1. 注册 `{routePath}`(默认 /desktop-wallpaper)HTTP 路由,把当前生效的
 *      壁纸图片(用户自选或内置默认)流式返回给浏览器。选择结果持久化在
 *      $DSH_HOME/desktop-background.json,图片本体复制到 $DSH_HOME/ 下,
 *      因此换图/删源文件/重启都不会丢。
 *   2. 注册三个 IPC(仅 Electron 环境):
 *        dsh-desktop:pick-background   — 原生文件选择器挑本地图片
 *        dsh-desktop:clear-background  — 恢复内置默认壁纸
 *        dsh-desktop:get-background    — 查询当前背景状态
 *      client 端(widget 行)通过 window.dshDesktop.* 调用。
 *
 * 与 dsh-desktop-notify 同款架构:整棵插件树跑在 Electron 主进程,Electron
 * 能力通过 createRequire('electron') 按需取;非 Electron(纯 `dsh web` CLI)
 * 时 IPC 不注册、路由仍生效(服务默认壁纸),包保持可加载。
 *
 * 安全:路由只服务「DSH_HOME 里的副本」或「插件自带默认图」,绝不透传任意
 * 客户端路径;原始路径只用于展示(basename)。
 *
 * @module dsh-desktop-background
 */
import { createRequire } from 'node:module'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 内置默认壁纸(assets/wallpaper.svg,与 scripts/wallpaper.svg 同款)。 */
const DEFAULT_WALLPAPER = join(__dirname, '..', 'assets', 'wallpaper.svg')
/** 状态文件名($DSH_HOME/desktop-background.json)。 */
const STATE_FILENAME = 'desktop-background.json'
/** 允许选择的图片扩展名 → MIME。 */
const IMAGE_MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.apng': 'image/apng',
}
const DEFAULT_CONFIG = { routePath: '/desktop-wallpaper' }

let Electron = null
try {
  if (typeof process !== 'undefined' && process.versions?.electron) {
    Electron = require('electron')
  }
} catch {
  // Not inside Electron: IPC 不注册,路由照常。
}

// ── 状态存储 ────────────────────────────────────────────────────────────

/**
 * 读取后台状态。缺失/损坏一律回退默认(无自定义背景)。
 * @returns {{ custom: string|null, source: string|null, updatedAt: number|null }}
 */
export function readState() {
  try {
    const raw = readFileSync(join(resolveDshHome(), STATE_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    const custom = typeof parsed?.custom === 'string' && parsed.custom !== '' ? parsed.custom : null
    if (custom !== null && basename(custom) !== custom) return { custom: null, source: null, updatedAt: null }
    return {
      custom,
      source: typeof parsed?.source === 'string' ? parsed.source : null,
      updatedAt: typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : null,
    }
  } catch {
    return { custom: null, source: null, updatedAt: null }
  }
}

/** 写回状态(原子的:先写临时文件再 rename)。 */
export function writeState(state) {
  const home = resolveDshHome()
  mkdirSync(home, { recursive: true })
  const target = join(home, STATE_FILENAME)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  rmSync(target, { force: true })
  copyFileSync(tmp, target)
  rmSync(tmp, { force: true })
}

/** 当前实际生效的壁纸文件绝对路径(custom 副本优先,否则内置默认)。 */
export function currentWallpaperPath() {
  const { custom } = readState()
  if (custom !== null) {
    const candidate = join(resolveDshHome(), custom)
    if (existsSync(candidate)) return candidate
  }
  return DEFAULT_WALLPAPER
}

/**
 * 把用户选中的图片复制进 $DSH_HOME 并更新状态。
 * @param sourcePath 用户选中的原图绝对路径
 * @returns {{ ok: true, fileName: string, source: string } | { ok: false, error: string }}
 */
export function adoptPickedImage(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath === '') return { ok: false, error: 'empty path' }
  const ext = extname(sourcePath).toLowerCase()
  if (!(ext in IMAGE_MIME)) return { ok: false, error: `unsupported image type: ${ext || '(none)'}` }
  if (!existsSync(sourcePath)) return { ok: false, error: 'file not found' }
  try {
    const home = resolveDshHome()
    mkdirSync(home, { recursive: true })
    // 先清旧副本再复制:清理逻辑按 desktop-background-* 前缀匹配,
    // 若放在复制之后会把刚复制的新文件自己删掉。
    for (const old of existingCustomFiles()) rmSync(old, { force: true })
    const fileName = `desktop-background-${Date.now()}${ext}`
    copyFileSync(sourcePath, join(home, fileName))
    writeState({ custom: fileName, source: sourcePath, updatedAt: Date.now() })
    return { ok: true, fileName, source: sourcePath }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** DSH_HOME 下所有 desktop-background-* 历史副本(用于换图时清理)。 */
function existingCustomFiles() {
  let home = null
  try {
    home = resolveDshHome()
  } catch {
    return []
  }
  const entries = []
  try {
    for (const name of readdirSyncSafe(home)) {
      if (name.startsWith('desktop-background-') && name !== STATE_FILENAME) entries.push(join(home, name))
    }
  } catch {
    /* 目录不存在时无所谓 */
  }
  return entries
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 清除自定义背景(删副本 + 状态置空)。 */
export function clearBackground() {
  try {
    for (const old of existingCustomFiles()) rmSync(old, { force: true })
    writeState({ custom: null, source: null, updatedAt: null })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 当前背景概览(client 行展示用)。 */
export function getBackgroundInfo() {
  const state = readState()
  return {
    ok: true,
    custom: state.custom !== null,
    fileName: state.custom,
    source: state.source,
    updatedAt: state.updatedAt,
    mime: state.custom !== null ? IMAGE_MIME[extname(state.custom).toLowerCase()] ?? 'application/octet-stream' : 'image/svg+xml',
  }
}

// ── HTTP 路由 ──────────────────────────────────────────────────────────

/** 流式返回一个文件;不存在或非文件时 404。 */
function serveFile(req, res, filePath, mime) {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      // 换图后浏览器要立刻拿到新图:禁缓存,配 query 参数刷新
      'Cache-Control': 'no-store',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(filePath).pipe(res)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}

function serveWallpaper(req, res) {
  const { custom } = readState()
  let filePath = null
  if (custom !== null) {
    const candidate = join(resolveDshHome(), custom)
    if (existsSync(candidate)) filePath = candidate
  }
  if (filePath === null) filePath = DEFAULT_WALLPAPER
  const mime =
    extname(filePath).toLowerCase() in IMAGE_MIME
      ? IMAGE_MIME[extname(filePath).toLowerCase()]
      : 'application/octet-stream'
  serveFile(req, res, filePath, mime)
}

// ── Cordis 插件入口 ─────────────────────────────────────────────────────

/**
 * @param ctx - root application context (应用启动后 webServer 已存在)
 * @param rawConfig - entry config,可被后续 patch 层覆盖
 * @returns disposer
 */
function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const routePath = typeof config.routePath === 'string' && config.routePath.startsWith('/') ? config.routePath : DEFAULT_CONFIG.routePath
  const disposers = []

  // 1) HTTP 路由:让浏览器的 CSS url(routePath)拿到当前壁纸
  const webServer = ctx.get?.('webServer')
  if (webServer?.register) {
    try {
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: routePath,
          handler: (req, res) => serveWallpaper(req, res),
        }),
      )
      console.log(`[dsh-desktop-background] wallpaper route ${routePath} ready`)
    } catch (error) {
      console.warn(`[dsh-desktop-background] route registration failed: ${String(error)}`)
    }
  } else {
    console.warn('[dsh-desktop-background] webServer unavailable — wallpaper route not registered')
  }

  // 2) IPC(仅 Electron 主进程环境)
  const ipc = Electron?.ipcMain
  const dialog = Electron?.dialog
  if (ipc) {
    try {
      ipc.handle('dsh-desktop:pick-background', async () => {
        try {
          const result = await dialog.showOpenDialog({
            title: '选择背景图片',
            properties: ['openFile'],
            filters: [
              { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'avif', 'apng'] },
            ],
          })
          if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
          return adoptPickedImage(result.filePaths[0])
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      })
      disposers.push(() => ipc.removeHandler('dsh-desktop:pick-background'))

      ipc.handle('dsh-desktop:clear-background', () => clearBackground())
      disposers.push(() => ipc.removeHandler('dsh-desktop:clear-background'))

      ipc.handle('dsh-desktop:get-background', () => getBackgroundInfo())
      disposers.push(() => ipc.removeHandler('dsh-desktop:get-background'))
    } catch (error) {
      console.warn(`[dsh-desktop-background] IPC wiring failed: ${String(error)}`)
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* disposer 失败不阻断后续清理 */
      }
    }
  }
}

export { apply }
export default apply