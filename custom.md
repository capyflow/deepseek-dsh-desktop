# custom.md — 本项目基于官网 DeepSeek Harness 的改造说明

本仓库是 **DeepSeek Harness Desktop**：对官网项目 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
（`@deepseek-ai/dsh` 0.1.0-rc.6 系列）的 Electron 桌面化改造。官网项目本体是 CLI +
Web UI（`dsh web` 起本地服务、浏览器访问）；本改造把它变成开箱即用的原生桌面应用。

## 改造总览

| 层 | 官网原样 | 本仓库改造 |
| --- | --- | --- |
| Harness 核心（Cordis 插件树、agent loop、Web UI） | 原样使用 | 不改一行，仅依赖 |
| 运行形态 | `dsh web` 独立进程 + 浏览器 | Electron 主进程**进程内 boot**，内嵌 WebServer + SPA，单进程 |
| 系统集成 | 无 | 工作区「Open in」终端/文件管理器、系统通知插件 |
| 分发 | npm 包 / CLI | electron-builder 产物（dmg/AppImage/deb/nsis）+ GitHub Release |

## 改造点清单

### 1. Electron 桌面壳（`electron/`）

- `electron/main.js`：主进程。核心思路是 **in-process boot**——不 spawn 子进程、不管理端口冲突：
  `bootDshDesktop()` 在本进程内把整个 web profile 跑起来，WebServer 监听
  `127.0.0.1:<OS 自动分配端口>`（`--port 0`），BrowserWindow 加载该 URL（与 trust fence
  的回环同源要求一致）。**关窗即 dispose 插件树退出**。
- `electron/dsh-boot.js`：桌面端专用启动器。刻意不 import `@deepseek-ai/dsh/lib/profile-boot-*.js`
  （tsdown 哈希分块文件名，升级会变），只用 `@deepseek-ai/dsh-app-boot` 的**稳定公共 API**
  （`boot` / `loadProfile` / `composeEntries` / `healProfilesModuleFallback` / `loadLayeredEnv`），
  复刻 CLI `runProfile` 的关键流程。这是与上游的升级契约：**升级 dsh 对壳子零影响**。
- `electron/preload.js`：contextIsolation + sandbox 下最小能力桥（`window.dshDesktop`），
  页面拿不到 Node 能力，系统操作一律经 `ipcRenderer.invoke` 转主进程。

### 2. 工作区「Open in」系统集成（`electron/open-in.js` + IPC）

渲染进程经 preload 桥 → `dsh-desktop:open-in` IPC → 主进程在**系统应用**中打开目录：
终端（`openInTerminal`）或文件管理器（`openInFileManager`），macOS/Linux 实现，
路径校验：非空绝对路径且目录存在。

### 3. 内置通知插件（`plugins/dsh-desktop-notify`）

官网的 Cordis 插件系统扩展：一个标准 bundle（`dsh.bundle.patch`），挂两个事件面：

- **agent 需要输入**：包装 `ctx.userQuestions.ask`（`ask_user_question` 工具触发），通知先于等待弹出；
- **处理完成 / 出错**：`session/event` 火线监听 `turn/end`，`reason.kind` 为 `completed` / `error`；
  子 agent 的收尾（`origin: 'subagent'`）被过滤。

通知投递：桌面应用把 Cordis 树跑在 Electron **主进程**里，插件直接 `require('electron')`
用原生 `Notification`（点击聚焦窗口）；非 Electron 环境退化为控制台日志，fail-soft 不破坏 agent 循环。

**内置分发机制**（`electron/dsh-boot.js`）：

- `BUILTIN_BUNDLES` + `appendBuiltinBundleLayers()`：把内置插件的 patch 层幂等追加进 bundle 层栈
  （profile 已手动 `dsh plugin add` 过的同名 bundle 跳过，不重复挂载）；
- `healProfilesModuleFallback` 的锚点从 `@deepseek-ai/dsh` 包改为**应用自身 package.json**：
  模块回退闭包 = dsh 全家桶 ∪ 应用直接依赖，内置插件因此进入
  `$DSH_HOME/profiles/node_modules`，全新机器（profile 尚未初始化）也能 bare-import。

### 4. 打包与发布（`package.json` build + `docs/PACKAGING.md`）

- electron-builder：macOS dmg / Linux AppImage+deb / Windows NSIS；`asar: false`；
- **必须在目标平台构建**（node-pty 等原生模块本地编译，dmg 依赖 macOS `hdiutil`）；
- 打包前金丝雀：`npm run smoke`（进程内 boot + SPA 可达）；
- 发布流程：bump 版本 → `npm run dist:mac` → `git tag vX.Y.Z` → GitHub Release 上传 dmg
  （本仓库用 GitHub API + 钥匙串 token，无 gh CLI）。
- 注意：产物未签名（未配置 Developer ID / notarization），Gatekeeper 可能拦截，详见 PACKAGING.md。

### 5. 测试体系（`scripts/`）

| 脚本 | 用途 | 运行 |
| --- | --- | --- |
| `smoke-boot.mjs` | 纯 Node 进程内 boot + HTTP 200 金丝雀 | `npm run smoke` |
| `electron-smoke.mjs` | Electron 全链路：boot → BrowserWindow 加载 SPA → DOM 校验 | `npx electron scripts/electron-smoke.mjs` |
| `notify-test.mjs` | 通知插件端到端：真实触发「需要输入」「处理完成」两条系统通知 | `npx electron scripts/notify-test.mjs` |

## 与上游的边界（升级指南）

- 壳子只依赖 `@deepseek-ai/dsh-app-boot` 稳定公共 API；`package.json` 里 `^0.1.0-rc.6`
  只允许 0.1.x 自动升级，大版本由我们控制节奏；
- 升级步骤：`npm update @deepseek-ai/dsh` → `npm run smoke`（boot 失败 = 公共 API 变了，
  先查再打包）→ `npm run dist`；
- WebUI 随 npm 包分发，壳子只负责开窗口，UI 更新对壳子零影响。

## 版本历史（git）

- `5d5786e` feat: add Electron desktop shell for DeepSeek Harness
- `900a758` docs: add cross-platform packaging guide
- `fd7c6da` chore: add packaging icons and platform window icons
- `9c7baae` feat: add workspace "Open in" terminal/file-manager actions (macOS/Linux)
- `a15aeb1` feat: bundle desktop notification plugin (dsh-desktop-notify) into the app

## 用户数据与插件机制（沿用官网语义）

- `$DSH_HOME/profiles/web`：web profile（package.json 的 `dsh.profile.bundles` + 用户
  `cordis.patch.yml` 补丁层），桌面应用每次启动读取；
- 用户仍可用 CLI `dsh plugin --profile web add <pkg>` 安装树外插件，与内置插件并存
  （内置层幂等，不会与手动安装重复挂载）。
