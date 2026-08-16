#!/usr/bin/env node
/**
 * 重新应用「工作区 Open in」对 dsh-client-ui-workspace 客户端 bundle 的补丁。
 *
 * 背景：dsh 的 WebUI 客户端模块以编译产物形式安装在 node_modules 里，
 * npm install 会把它们还原成原版，因此本脚本在 install 后（postinstall）
 * 幂等地重新打上补丁。electron/ 下的改动已由 git 跟踪，无需处理。
 *
 * 幂等：若补丁已应用（存在标记注释），直接跳过。
 * 安全：若原始代码片段找不到（dsh 升级改动了源码），打印警告并以 0 退出，
 * 避免中断安装流程。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TARGET =
  process.env.PATCH_TARGET ??
  resolve(__dirname, '../node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js')

/** 补丁标记：已应用则跳过。 */
const MARKER = 'dsh-desktop: 桌面外壳（preload）提供的“在系统中打开”能力'

/** [原始片段, 补丁后片段] 列表，依次替换。 */
const REPLACEMENTS = [
  // 1) 菜单项：新增 “Open in” 父项 + 终端/文件管理器子菜单
  [
    `			const [menuOpen, setMenuOpen] = (0, react.useState)(false);
			const workspaceMenuItems = [{`,
    `			const [menuOpen, setMenuOpen] = (0, react.useState)(false);
			/* ${MARKER}；纯浏览器环境为空。 */
			const desktopShell = window.dshDesktop;
			const workspaceMenuItems = [{`,
  ],
  [
    `			}, {
				id: "delete",
				label: t("delete.workspace"),
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
				danger: true
			}];`,
    `			}, {
				id: "delete",
				label: t("delete.workspace"),
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
				danger: true
			}, {
				id: "openIn",
				label: t("menu.openIn"),
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutline16, {}),
				disabled: desktopShell?.openIn === void 0,
				submenu: [{
					id: "openInTerminal",
					label: t("menu.openInTerminal"),
					icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, {}),
					disabled: desktopShell?.openIn === void 0
				}, {
					id: "openInFileManager",
					label: t("menu.openInFileManager"),
					icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutline16, {}),
					disabled: desktopShell?.openIn === void 0
				}]
			}];`,
  ],
  // 2) onSelect：处理两个新 id
  [
    `							onSelect: (id) => {
								setMenuOpen(false);
								/* v8 ignore next -- workspaceMenuItems carries exactly these two rows today. */
								if (id !== "rename" && id !== "delete") return;
								if (id === "rename") actions.rename();
								else actions.delete();
							},`,
    `							onSelect: (id) => {
								setMenuOpen(false);
								if (id === "rename") actions.rename();
								else if (id === "delete") actions.delete();
								else if (id === "openInTerminal") actions.openInTerminal();
								else if (id === "openInFileManager") actions.openInFileManager();
							},`,
  ],
  // 3) 行 actions：新增 openInTerminal / openInFileManager
  [
    `											delete: () => {
												/* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
												if (group.workspaceId !== void 0) onDeleteRequest(group.workspaceId, group.label);
											}
										}`,
    `											delete: () => {
												/* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
												if (group.workspaceId !== void 0) onDeleteRequest(group.workspaceId, group.label);
											},
											openInTerminal: () => {
												if (group.cwd !== void 0 && group.cwd !== "") window.dshDesktop?.openIn("terminal", group.cwd);
											},
											openInFileManager: () => {
												if (group.cwd !== void 0 && group.cwd !== "") window.dshDesktop?.openIn("fileManager", group.cwd);
											}
										}`,
  ],
  // 4) 中文字典
  [
    `			"menu.addWorkspace": "添加工作区…",`,
    `			"menu.addWorkspace": "添加工作区…",
			"menu.openIn": "打开方式",
			"menu.openInTerminal": "在终端中打开",
			"menu.openInFileManager": "在文件管理器中打开",`,
  ],
  // 5) 英文字典
  [
    `			"menu.addWorkspace": "Add workspace…",`,
    `			"menu.addWorkspace": "Add workspace…",
			"menu.openIn": "Open in",
			"menu.openInTerminal": "Open in Terminal",
			"menu.openInFileManager": "Open in File Manager",`,
  ],
]

let source
try {
  source = readFileSync(TARGET, 'utf8')
} catch (error) {
  console.error(`[patch-open-in] 无法读取 ${TARGET}: ${error.message}`)
  process.exit(1)
}

if (source.includes(MARKER)) {
  console.log('[patch-open-in] 已应用，跳过。')
  process.exit(0)
}

let changed = 0
for (const [from, to] of REPLACEMENTS) {
  const count = source.split(from).length - 1
  if (count !== 1) {
    console.warn(
      `[patch-open-in] 跳过片段（期望 1 处匹配，实际 ${count} 处）：${from.slice(0, 60).replace(/\n/g, '\\n')}…`,
    )
    continue
  }
  source = source.replace(from, to)
  changed += 1
}

if (changed === 0) {
  console.error('[patch-open-in] 未应用任何片段：dsh-client-ui-workspace 可能已升级，需要人工更新本脚本。')
  process.exit(0)
}

writeFileSync(TARGET, source)
console.log(`[patch-open-in] 已应用 ${changed}/${REPLACEMENTS.length} 个片段到 ${TARGET}`)
