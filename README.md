# DeepSeek Harness Desktop

将 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 打包成桌面端软件的 Electron 壳。

## 架构

```
┌──────────────────────────────────────────────────────┐
│ Electron 主进程 (electron/main.js)                    │
│                                                      │
│  bootDshDesktop() ──► 进程内 boot dsh web profile    │
│       │                (electron/dsh-boot.js)        │
│       │                  │                           │
│       ▼                  ▼                           │
│  Cordis 插件树 ──────► WebServer 监听 127.0.0.1:0    │
│                            ├── /api/*  RPC+WS        │
│                            └── 静态 SPA dist          │
│       │                                              │
│       ▼                                              │
│  BrowserWindow 加载 http://127.0.0.1:<OS分配端口>     │
└──────────────────────────────────────────────────────┘
```

**核心思路**：dsh 官方支持"进程内 boot"（`@deepseek-ai/dsh-app-boot` 的公共 API）。
整个 harness 直接跑在 Electron 主进程里——**无子进程管理、无端口冲突**
（`--port 0` 让 OS 自动分配）、关窗即 `ctx.fiber.dispose()` 干净退出。

> 为什么不用 `@deepseek-ai/dsh/lib/profile-boot-*.js`？
> 它是 tsdown 哈希分块文件名（如 `profile-boot-BnJoK_kl.js`），版本升级会变。
> `electron/dsh-boot.js` 用文档化的稳定公共 API（`boot`/`loadProfile`/
> `composeEntries`/`healProfilesModuleFallback`）复刻了 CLI 的启动流程。

## 快速开始

```bash
npm install
npm run dev            # 启动桌面应用（需要图形环境）
npm run smoke          # 纯 Node 冒烟：进程内 boot + SPA 可访问（无需显示器）
npm run smoke:electron # Electron 端到端冒烟（需要图形环境）
```

## 打包

```bash
npm run dist:linux     # AppImage + deb（产物在 release/）
npm run dist:win       # NSIS 安装包（需在 Windows 或装 wine）
npm run dist:mac       # DMG（需 macOS）
```

## 升级 dsh / 合并官方更新

**本仓库不 vendor 官方源码**：dsh 及其 UI 以 npm 依赖形式引入（见
`package.json` 的 `@deepseek-ai/*`，如 `@deepseek-ai/dsh`、
`@deepseek-ai/dsh-client-ui-workspace`）。官方发布新版本 = 发布新 npm 包，
"合并官方最新代码" = **升级依赖 → 重放补丁 → 验证 → 重新打包**。

```bash
# 1) 升级依赖（把目标版本写进 package.json 后执行，或直接指定 latest）
npm install @deepseek-ai/dsh@latest @deepseek-ai/dsh-app-boot@latest \
            @deepseek-ai/dsh-cmdline@latest @deepseek-ai/dsh-home-paths@latest

# 2) postinstall 会自动重放「Open in」补丁，务必观察输出：
#    [patch-open-in] 已应用 6/6 个片段        → 补丁正常
#    [patch-open-in] 跳过片段（期望 1 处匹配…）→ 上游 bundle 结构变了，见下
```

**补丁失配时**（上游重编译了 `dsh-client-ui-workspace`，精确匹配失败）：

1. 功能影响仅是「打开方式」菜单暂时消失——脚本匹配不上就跳过并以 0 退出，
   不会导致 `npm install` 失败或应用崩溃；
2. 更新 `scripts/patch-open-in.mjs` 的 `REPLACEMENTS`：用 `npm pack
   @deepseek-ai/dsh-client-ui-workspace@<新版本>` 拉出原包，对比新 bundle，
   把对应的几段代码抄进片段即可；
3. 重新 `npm install` 验证输出变为「已应用 6/6」。

**验证与分发**：

```bash
npm run smoke          # 进程内 boot + SPA 可访问（纯 Node，无需显示器）
npm run dev            # 启动应用，检查工作区行 ⋯ 菜单里的「打开方式」
npm run dist:mac       # 重新打包分发（已安装的应用是旧快照，升级后必须重打包才生效）
```

**其他注意事项**：

- 查看当前依赖版本：`npm ls @deepseek-ai/dsh-client-ui-workspace`
- `electron/` 下的代码是本仓库自有的壳代码，官方 npm 更新不会覆盖它们；
  升级 dsh 时唯一需要留意的兼容点是 `electron/dsh-boot.js` 使用的
  `@deepseek-ai/dsh-app-boot` 公共 API（README 开头有说明）。
- 若将来官方原生实现了「Open in」（或 UI 结构大改使补丁失去意义），
  删除 `scripts/patch-open-in.mjs` 和 `package.json` 里的 `postinstall`
  钩子即可干净移除，不留残留。

## 用户数据

- `DSH_HOME` 环境变量优先；未设置时默认 `~/.dsh`——**与 dsh CLI 共用同一套**
  profile、会话、凭据、`.env`（桌面端和 CLI 可以无缝切换使用）。
- 遥测开关：设置 `DSH_TELEMETRY_DISABLED=1` 即关闭（同 dsh CLI）。

## 工作区「Open in」

工作区行的 `⋯` 菜单新增「打开方式（Open in）」子菜单，可在**系统终端**或
**文件管理器**中打开工作区目录（macOS / Linux）：

- macOS：文件管理器走 `open`（Finder）；终端优先 iTerm2，未安装则回退
  Terminal.app。
- Linux：文件管理器走 `xdg-open`；终端按 `gnome-terminal` → `konsole` →
  `xfce4-terminal` → `kitty` → `alacritty` → `wezterm` → `xterm` 顺序探测，
  也可用环境变量 `DSH_DESKTOP_TERMINAL` 指定（通用 `-e sh -c` 形式）。
- 纯浏览器环境（无桌面壳）下该菜单自动置灰。

实现：`electron/open-in.js`（纯 Node 宿主逻辑）+ `electron/main.js` 的
`dsh-desktop:open-in` IPC + `electron/preload.js` 的 `dshDesktop.openIn` 桥 +
对 `dsh-client-ui-workspace` 客户端 bundle 的补丁（`scripts/patch-open-in.mjs`，
已在 `postinstall` 中自动重放，`npm install` 后无需手工处理）。

## 已验证

- [x] 进程内 boot dsh web profile，OS 自动分配端口，SPA HTTP 200
      （系统 Node v22 与 Electron 的 Node 运行时各跑一遍）
- [x] `node-addon-require-builtin` 原生插件（N-API v9）在 Electron ABI 下正常加载
- [ ] BrowserWindow 真实渲染——需图形环境验证（容器/无显示器环境下
      Chromium 窗口创建会 SIGSEGV，属环境限制）

## 已知边界（v0.1）

- 未实现 `cordis.patch.yml` 热更新 watcher（桌面端固定窗口，重启生效）
- 外链点击默认拦截（`setWindowOpenHandler` deny），后续可接 `shell.openExternal`
- 未做托盘/系统菜单/自动更新
