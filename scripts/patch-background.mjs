#!/usr/bin/env node
/**
 * dsh-desktop 整窗壁纸补丁 (postinstall 自动执行)
 *
 * 原理：dsh web 前端（@deepseek-ai/dsh-web-frontend/dist）每次请求都会重新
 * 读取磁盘上的 index.html，因此给 index.html 注入一段 <style> 并放一张
 * wallpaper.svg，刷新页面即可生效，无需重启应用、也不用改 node_modules 源码。
 *
 * 本脚本幂等，作用对象 = 仓库 node_modules 里的 dist + release/ 下所有已打包
 * 应用的 dist（两者都打补丁，谁在跑谁生效）。
 *
 * 自定义壁纸：替换 scripts/wallpaper.svg 后重跑 `node scripts/patch-background.mjs`
 * 即可（或直接改 dist 里的 /wallpaper.svg）。想换样式/颜色，改下方 buildCss() 的
 * 覆盖层参数。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const WALLPAPER = resolve(__dirname, 'wallpaper.svg')
const WALLPAPER_URL = '/desktop-wallpaper'
const STYLE_ID = 'dsh-desktop-background'

/** 需要替换背景的表面：layout 主框架/侧边栏 + conversation 全屏视图根节点 */
const PLUGIN_LAYOUT_CLASSES = ['frame', 'sidebarCol', 'centerCol', 'detailsCol']
const PLUGIN_CONV_MODULES = ['dsh-client-ui-layout', 'dsh-client-ui-conversation']

/**
 * 定位所有 dsh-web-frontend dist 根目录：
 *   - 仓库 node_modules/@deepseek-ai/dsh-web-frontend/dist
 *   - release/ 下打包应用里的同名 dist（electron-builder asar:false 时是
 *     <app>/Contents/Resources/app/node_modules/...）
 */
function findDistRoots() {
  const roots = []
  const push = (p) => {
    if (existsSync(join(p, 'index.html'))) roots.push(p)
  }
  push(join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'))
  const scan = (dir, depth) => {
    if (depth <= 0) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'dsh-web-frontend') {
          const dist = join(full, 'dist')
          if (existsSync(join(dist, 'index.html'))) roots.push(dist)
          continue
        }
        if (ent.name === 'node_modules') {
          // 打包应用里只检查 dsh-web-frontend 这一条已知路径，不深入扫整棵树
          const dist = join(full, '@deepseek-ai', 'dsh-web-frontend', 'dist')
          if (existsSync(join(dist, 'index.html'))) roots.push(dist)
          continue
        }
        scan(full, depth - 1)
      }
    }
  }
  scan(join(repoRoot, 'release'), 6)
  return roots
}

/** 从已安装的插件 client.js 里提取真实类名（版本升级后类名会变，动态提取防漂移）。
 *  返回完整类名（如 "pI_x6G_frame"、"hHd-Xa_root"、"wSkVaW_root"）。 */
function extractClasses() {
  const out = { frame: null, sidebarCol: null, sidebarRoot: null, roots: [] }
  const layoutFile = join(
    repoRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-layout', 'lib', 'client.js',
  )
  const convFile = join(
    repoRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js',
  )
  const sidebarFile = join(
    repoRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'lib', 'client.js',
  )
  if (existsSync(layoutFile)) {
    const css = readFileSync(layoutFile, 'utf8')
    for (const name of PLUGIN_LAYOUT_CLASSES) {
      const m = css.match(new RegExp(`\\.([A-Za-z0-9_]+)_${name}\\{`))
      if (m) out[name] = `${m[1]}_${name}`
    }
  }
  if (existsSync(convFile)) {
    const css = readFileSync(convFile, 'utf8')
    // 全屏视图根节点：_root{...background:var(--dsw-alias-bg-base)...} 的不透明白底要换成半透明
    const re = /\.([A-Za-z0-9_]+)_root\{[^}]*background:var\(--dsw-alias-bg-base\)/g
    let m
    while ((m = re.exec(css))) out.roots.push(`${m[1]}_root`)
  }
  if (existsSync(sidebarFile)) {
    const css = readFileSync(sidebarFile, 'utf8')
    // 侧边栏内容根节点：_root{...background:var(--dsw-specific-sidebar-fill)...}
    // 它把侧边栏列(pI_x6G_sidebarCol)的半透明完全盖住，壁纸透不过去，
    // 必须同样换成半透明（注意前缀可能含连字符，如 "hHd-Xa_root"）。
    const m = css.match(/\.([A-Za-z0-9_-]+)_root\{[^}]*background:var\(--dsw-specific-sidebar-fill\)/)
    if (m) out.sidebarRoot = `${m[1]}_root`
  }
  return out
}

/** 生成注入的 <style> 内容（浅色/深色两套遮罩；无毛玻璃，见下文注释） */
function buildCss(cls) {
  const frame = cls.frame
  const surfaces = [cls.sidebarCol, cls.sidebarRoot, ...cls.roots].filter(Boolean)
  if (!frame || surfaces.length === 0) {
    console.warn('[patch-background] 未能从插件提取类名（插件未安装？），跳过样式注入')
    return null
  }
  const surfaceSel = surfaces.map((s) => `.${s}`).join(', ')
  // 双层背景：第一层是动态路由 /desktop-wallpaper（宿主按持久化状态出图，
  // 404/未加载插件时该层透明，露出第二层静态默认壁纸 wallpaper.svg），
  // 客户端「换图即时生效」也靠改写第一层的 url 实现。
  //
  // 注意：这里**故意不**用 backdrop-filter 毛玻璃 —— 它会让元素成为
  // fixed/absolute 后代的包含块，把设置弹窗等全窗浮层“锁”进侧边栏
  // （0.1.4 出现过同样的 bug）。半透明遮罩足以保证可读性。
  return `/* ===== dsh desktop 整窗壁纸（patch-background.mjs 注入，勿手改） ===== */
.${frame} {
  background: url("${WALLPAPER_URL}") center / cover no-repeat fixed, url("/wallpaper.svg") center / cover no-repeat fixed !important;
}
${surfaceSel} {
  background: rgba(248, 249, 252, 0.76) !important;
}
body[data-ds-dark-theme] ${surfaceSel} {
  background: rgba(11, 13, 19, 0.66) !important;
}`
}

/** 幂等注入/更新 <style id=dsh-desktop-background> */
function injectStyle(indexHtml, css) {
  if (!css) return indexHtml
  const style = `<style id="${STYLE_ID}">\n${css}\n</style>`
  const re = new RegExp(`<style id="${STYLE_ID}">[\\s\\S]*?</style>`)
  if (re.test(indexHtml)) return indexHtml.replace(re, style)
  return indexHtml.replace('</head>', `${style}\n  </head>`)
}

const distRoots = findDistRoots()
if (distRoots.length === 0) {
  console.error('[patch-background] 未找到任何 dsh-web-frontend dist，退出')
  process.exit(1)
}

const cls = extractClasses()
const css = buildCss(cls)

for (const dist of distRoots) {
  copyFileSync(WALLPAPER, join(dist, 'wallpaper.svg'))
  const indexPath = join(dist, 'index.html')
  const html = readFileSync(indexPath, 'utf8')
  const next = css ? injectStyle(html, css) : html
  if (next !== html) writeFileSync(indexPath, next)
  console.log(`[patch-background] patched ${dist} (frame=#${cls.frame}, sidebar=#${cls.sidebarCol}, sidebarRoot=#${cls.sidebarRoot}, roots=[${cls.roots.join(', ')}])`)
}