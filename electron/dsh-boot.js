/**
 * 桌面端专用的 dsh harness 启动器（纯 Node，无 Electron 依赖，可被 smoke 脚本复用）
 *
 * 基于 dsh 官方**稳定公共 API**（@deepseek-ai/dsh-app-boot 的 boot/loadProfile/
 * composeEntries/healProfilesModuleFallback），复刻 CLI `runProfile` 的关键流程：
 * 加载 web profile → 堆叠 patch 层 → 挂载 Cordis 插件树。
 *
 * 特意不 import `@deepseek-ai/dsh/lib/profile-boot-*.js`（tsdown 哈希分块文件名，
 * 版本升级会变）；公共 API 是文档化的稳定面。
 *
 * 启动后整个 harness（HTTP RPC + WebSocket + 静态 SPA）就在本进程内运行，
 * 端口由调用方通过 args 传入 `--port 0`（OS 自动分配），boot 完成后从
 * `ctx.webServer.port` 读取实际端口。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  loadLayeredEnv,
  loadOptionalPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const NAME = 'dsh'

/** 会话遥测行 id，DSH_TELEMETRY_DISABLED 开关的目标（同 CLI） */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** profile 根配置文件名（整个组合都是 patch 层，根必须为空列表） */
const PROFILE_ROOT_FILENAME = 'cordis.yml'
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** dsh 安装锚点：@deepseek-ai/dsh 包的 package.json（bundle 解析的第一锚点） */
const DSH_INSTALL_ANCHOR = fileURLToPath(
  new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url),
)
/** dsh 包内置的 agent-preset 根目录（随包发布在 config/agent-presets） */
const SHIPPED_PRESET_ROOT = fileURLToPath(
  new URL('../node_modules/@deepseek-ai/dsh/config/agent-presets/', import.meta.url),
)

/** home 级用户 patch 层（$DSH_HOME/cordis.patch.yml），高于 profile 自己的层 */
function homePatchPath() {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/**
 * 进程内 boot dsh web profile。
 * @param options.args - 传给 web profile 的命令行参数（如 ['--port', '0']）
 * @param options.onExit - cmdline 请求退出时的回调（桌面端交给 Electron 生命周期）
 * @returns 已激活的 Cordis 根上下文；调用方负责 ctx.fiber.dispose()
 */
export async function bootDshDesktop({ args = [], onExit = () => {} } = {}) {
  // ① 补齐 profile/node_modules 回退链接，让 bare 插件名可解析
  healProfilesModuleFallback(DSH_INSTALL_ANCHOR)

  // ② 加载 web profile（首次自动按 PROFILE_TEMPLATES 初始化）并重写空根配置
  const profile = loadProfile(NAME, 'web', DSH_INSTALL_ANCHOR)
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)

  // ③ 组装 patch 层（应用顺序）：bundle 层 → profile 用户层 → home 层 → 覆盖层
  const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
  const bundlePatches = profile.layers.flatMap((layer) => layer.patches)
  const overlays = []

  const rows = new Map()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  // 内置 agent-presets 根（同 CLI runProfile）：把它挂进 agent-presets 行的 roots
  if (rows.has('agent-presets')) {
    overlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}),
        roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      },
    })
  }
  // 遥测开关（同 CLI）：DSH_TELEMETRY_DISABLED 任何非空值都关闭（隐私开关，宁关勿开）
  if ((process.env.DSH_TELEMETRY_DISABLED ?? '') !== '' && rows.has(TELEMETRY_ROW_ID)) {
    overlays.push({ id: TELEMETRY_ROW_ID, disabled: true })
  }
  // 克隆（同 CLI）：insert 行按引用推入挂载树，后续 id-patch 会原地改动对象
  const patches = structuredClone([...bundlePatches, ...profile.patches, ...homePatches, ...overlays])

  // ④ boot：先加载 .env 快照（副作用：把 DSH_HOME/.env 的值物化进 process.env），
  //    再在 prepare 钩子里提供 cmdline 服务（web-startup 插件必需注入 cmdlineArgs）
  loadLayeredEnv(NAME)
  const ctx = await boot(NAME, join(profile.dir, PROFILE_ROOT_FILENAME), patches, (hostCtx) => {
    provideCmdline(hostCtx, {
      args,
      exit: (code) => onExit(code),
    })
  })
  return ctx
}
