# custom.md — 本项目基于官网 DeepSeek Harness 的改造说明

本仓库是 **DeepSeek Harness Desktop**：对官网项目 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
（`@deepseek-ai/dsh` 0.1.0-rc.6 系列）的 Electron 桌面化改造。官网项目本体是 CLI +
Web UI（`dsh web` 起本地服务、浏览器访问）；本改造把它变成开箱即用的原生桌面应用。

## 改造总览

| 层 | 官网原样 | 本仓库改造 |
| --- | --- | --- |
| Harness 核心（Cordis 插件树、agent loop、Web UI） | 原样使用 | 不改一行，仅依赖（UI 菜单扩展见「前端 bundle 补丁」行） |
| 运行形态 | `dsh web` 独立进程 + 浏览器 | Electron 主进程**进程内 boot**，内嵌 WebServer + SPA，单进程 |
| 窗口生命周期 | 无窗口概念 | macOS Cmd+W 只关窗不退出、Dock 激活重建窗口、通知点击拉起并导航 |
| 系统集成 | 无 | 工作区「Open in」终端/文件管理器、系统通知 + 点击导航到会话 |
| 前端 bundle 补丁 | 官方编译产物原样 | 对 `dsh-client-ui-workspace` 菜单打补丁，postinstall 幂等重放 |
| 品牌形象 | Electron 默认图标 | DeepSeek 官方鲸鱼图标（`build/` 三平台素材 + 窗口/Dock 图标） |
| 分发 | npm 包 / CLI | electron-builder 产物（dmg/AppImage/deb/nsis）+ GitHub Release |

## 改造点清单

### 1. Electron 桌面壳（`electron/`）

- `electron/main.js`：主进程。核心思路是 **in-process boot**——不 spawn 子进程、不管理端口冲突：
  `bootDshDesktop()` 在本进程内把整个 web profile 跑起来，WebServer 监听
  `127.0.0.1:<OS 自动分配端口>`（`--port 0`），BrowserWindow 加载该 URL（与 trust fence
  的回环同源要求一致）。窗口与导航的状态机抽在 `electron/window-manager.js`（见 §3.1），
  main.js 只做生命周期接线：macOS 关窗不退出（Cmd+W 后可从 Dock/通知重新拉起），
  其他平台关窗即 dispose 插件树退出。
- `electron/window-manager.js`：**窗口/导航状态机**（`createWindow` / `navigateRequest` /
  `takePendingNavigate` / `activate` / `focusExisting`），持有主窗口、harness 端口与
  待交付的导航请求。从 main.js 抽出是为了**可测试**：集成测试（`scripts/notify-navigate-smoke.mjs`）
  与线上共用同一实现，保证被测逻辑与运行一致。
- `electron/dsh-boot.js`：桌面端专用启动器。刻意不 import `@deepseek-ai/dsh/lib/profile-boot-*.js`
  （tsdown 哈希分块文件名，升级会变），只用 `@deepseek-ai/dsh-app-boot` 的**稳定公共 API**
  （`boot` / `loadProfile` / `composeEntries` / `healProfilesModuleFallback` / `loadLayeredEnv`），
  复刻 CLI `runProfile` 的关键流程。这是与上游的升级契约：**升级 dsh 对壳子零影响**。
- `electron/preload.js`：contextIsolation + sandbox 下最小能力桥（`window.dshDesktop`），
  页面拿不到 Node 能力，系统操作一律经 `ipcRenderer.invoke` 转主进程。

### 2. 工作区「Open in」系统集成（`electron/open-in.js` + IPC）

渲染进程经 preload 桥 → `dsh-desktop:open-in` IPC → 主进程在**系统应用**中打开目录：
终端（`openInTerminal`）或文件管理器（`openInFileManager`），macOS/Linux 实现，
路径校验：非空绝对路径且目录存在。UI 侧的「打开方式」菜单来自对官方前端 bundle
的补丁，见 §2.1。

### 2.1 前端 bundle 补丁机制（`scripts/patch-open-in.mjs` + postinstall）

**背景**：dsh 的前端以编译产物随 npm 包发布（`node_modules/@deepseek-ai/
dsh-client-ui-workspace/lib/client.js`），仓库无法直接改官方源码；`npm install`
又会把 bundle 还原成原版。因此「打开方式」菜单以补丁形式实现：

- `package.json` 的 `postinstall` 钩子执行 `scripts/patch-open-in.mjs`，每次安装后
  **幂等**重放 6 处片段：工作区行菜单项（Open in 父项 + 终端/文件管理器子菜单）、
  `onSelect` 分支、行 actions（`openInTerminal`/`openInFileManager`）、中英文字典；
- 纯浏览器环境（无 `window.dshDesktop`）下菜单自动置灰。

**安全设计**：

- 已应用则跳过（按标记注释判断）；
- 每个片段要求**恰好匹配 1 处**，匹配不上就跳过并打印警告、以退出码 0 结束——
  绝不瞎打补丁，`npm install` 不会因此失败；
- 最坏影响：上游重编译 bundle 后补丁失配，「打开方式」菜单暂时消失，需按告警
  人工更新 `REPLACEMENTS` 片段（用 `npm pack` 拉原包对比）；
- 若官方原生实现该功能（或 UI 结构大改使补丁失去意义），删除脚本 + postinstall
  钩子即可干净移除。

### 3. 内置通知插件（`plugins/dsh-desktop-notify`）

官网的 Cordis 插件系统扩展：一个标准 bundle（`dsh.bundle.patch`），挂两个事件面：

- **agent 需要输入**：包装 `ctx.userQuestions.ask`（`ask_user_question` 工具触发），通知先于等待弹出；
- **处理完成 / 出错**：`session/event` 火线监听 `turn/end`，`reason.kind` 为 `completed` / `error`；
  子 agent 的收尾（`origin: 'subagent'`）被过滤。

通知投递：桌面应用把 Cordis 树跑在 Electron **主进程**里，插件直接 `require('electron')`
用原生 `Notification`（点击聚焦窗口并导航到对应会话，见 §3.1）；非 Electron 环境退化
为控制台日志，fail-soft 不破坏 agent 循环。

**内置分发机制**（`electron/dsh-boot.js`）：

- `BUILTIN_BUNDLES`（`['dsh-desktop-notify', 'dsh-desktop-navigate']`）+
  `appendBuiltinBundleLayers()`：把内置插件的 patch 层幂等追加进 bundle 层栈
  （profile 已手动 `dsh plugin add` 过的同名 bundle 跳过，不重复挂载）；
- `healProfilesModuleFallback` 的锚点从 `@deepseek-ai/dsh` 包改为**应用自身 package.json**：
  模块回退闭包 = dsh 全家桶 ∪ 应用直接依赖，内置插件因此进入
  `$DSH_HOME/profiles/node_modules`，全新机器（profile 尚未初始化）也能 bare-import；
- 内置插件以 `file:` 依赖声明在 `package.json`（`dsh-desktop-notify` /
  `dsh-desktop-navigate`），随仓库版本走。

### 3.1 通知点击 → 会话导航（`plugins/dsh-desktop-navigate` + 主进程窗口生命周期）

点击「处理完成/出错」通知不再只是聚焦窗口，而是**直接打开对应会话**。完整链路：

1. 通知点击 → `dsh-desktop-notify` 携带 `sessionId` 调用 `navigateToSession()`
   （`ElectronApp.emit('dsh-desktop:navigate-request', { kind: 'session', sessionId })`；
   非 Electron 环境 no-op）；
2. `electron/main.js` 的 `dsh-desktop:navigate-request` 事件（实现在
   `electron/window-manager.js`，main.js 与集成测试共用）：窗口在 → 还原/聚焦并
   **push**（`webContents.send('dsh-desktop:navigate')`）；窗口不在（macOS Cmd+W
   关窗后）→ 记入 `pendingNavigate` 并重建窗口，由页面加载后 **pull**；
3. `electron/preload.js` 桥：`dshDesktop.onNavigate(cb)`（push 订阅）与
   `dshDesktop.takePendingNavigate()`（pull 取走，取走即清空、只交付一次）；
4. `plugins/dsh-desktop-navigate` 是标准 dsh **客户端插件**（`dsh.client` 声明 +
   `exports["./client"]`，host 侧为 no-op 入口）：浏览器半区在插件加载时挂上
   push/pull 双通道，收到请求后经客户端运行时 `ctx.sessions.open(sessionId)`
   切换到对应会话；会话列表未就绪时短暂重试后放弃，fail-soft 不破坏 UI。

配套的 **macOS 窗口生命周期**改造（`electron/window-manager.js` + `electron/main.js`）：

- `window-all-closed` 在 macOS 不再退出应用（Cmd+W 只关窗，符合平台习惯）；
  其他平台保持关窗即退出；
- `app.on('activate')`（点击 Dock 图标）无窗口时用已 boot 的端口重建窗口
  （`setPort()` 缓存的端口）；
- `dsh-desktop:take-navigate` IPC 供客户端插件取走待交付的导航请求
  （`takePendingNavigate()`，取走即清空、只交付一次）。

### 4. 打包与发布（`package.json` build + `docs/PACKAGING.md`）

- electron-builder：macOS dmg / Linux AppImage+deb / Windows NSIS；`asar: false`；
- **必须在目标平台构建**（node-pty 等原生模块本地编译，dmg 依赖 macOS `hdiutil`）；
- 打包前金丝雀：`npm run smoke`（进程内 boot + SPA 可达）；
- 发布流程：bump 版本 → `npm run dist:mac` → `git tag vX.Y.Z` → GitHub Release 上传 dmg
  （本仓库用 GitHub API + 钥匙串 token，无 gh CLI）。
- 注意：产物未签名（未配置 Developer ID / notarization），Gatekeeper 可能拦截，详见 PACKAGING.md。

### 4.1 应用图标（DeepSeek 鲸鱼）

- `build/icon.svg` 是主图标源文件：**官方鲸鱼 path 直接取自
  `@deepseek-ai/dsh-web-frontend` 的 `favicon.svg`**（与 dsh UI 里的 `FishLogo`
  同源），白色鲸鱼 + 品牌蓝渐变圆角底（`#679EFE → #4176E6`，对应官方设计 token
  `deepseek-400` / `deepseek-500`）；
- 由它生成三平台素材：`build/icon.png`（1024px，Linux）、`build/icon.icns`
  （macOS，sips + iconutil 生成全尺寸集）、`build/icon.ico`（Windows，256px PNG
  嵌入 ICO）、`build/icon-256.png`（ico 生成中间产物）；`package.json` 各平台
  `icon` 字段分别引用；
- `electron/assets/icon.png`（512px）供运行时使用：macOS 开发模式（未打包）Dock
  图标（`app.dock.setIcon`）与 Linux 窗口图标（`BrowserWindow.icon`）——
  打包后的 macOS/Windows 由应用包/可执行文件自带的图标提供。

### 5. 测试体系（`scripts/`）

| 脚本 | 用途 | 运行 |
| --- | --- | --- |
| `smoke-boot.mjs` | 纯 Node 进程内 boot + HTTP 200 金丝雀 | `npm run smoke` |
| `electron-smoke.mjs` | Electron 全链路：boot → BrowserWindow 加载 SPA → DOM 校验 | `npx electron scripts/electron-smoke.mjs` |
| `notify-test.mjs` | 通知插件端到端：真实触发「需要输入」「处理完成」两条系统通知 | `npx electron scripts/notify-test.mjs` |
| `notify-navigate-smoke.mjs` | 通知导航端到端：真实 Electron + 真实 SPA + 真实持久化会话，验证**推送**（窗口在→切会话）与 **pending**（关窗→通知点击→重建窗口→切会话）两条链路；断言客户端运行时 `localStorage['dsh.sessions.current']` 与插件无失败日志 | `npm run smoke:navigate` |

## 与上游的边界（升级指南）

- 壳子只依赖 `@deepseek-ai/dsh-app-boot` 稳定公共 API；`package.json` 里 `^0.1.0-rc.6`
  只允许 0.1.x 自动升级，大版本由我们控制节奏；
- 升级步骤：`npm update @deepseek-ai/dsh` → **观察 postinstall 输出**
  （`[patch-open-in] 已应用 6/6` 为正常；出现「跳过片段」警告 = 上游重编译了
  `dsh-client-ui-workspace`，需按 §2.1 更新补丁脚本）→ `npm run smoke`
  （boot 失败 = 公共 API 变了，先查再打包）→ 手动检查「打开方式」菜单 →
  `npm run dist`；
- WebUI 随 npm 包分发，壳子只负责开窗口；本改造对 WebUI 的唯一接触点是 §2.1 的
  bundle 补丁（postinstall 幂等重放、失配安全跳过），升级时留意日志即可；
- 内置插件（`dsh-desktop-notify` / `dsh-desktop-navigate`）是 `file:` 依赖随仓库走，
  不随官方 npm 更新。

## 版本历史（git）

- `5d5786e` feat: add Electron desktop shell for DeepSeek Harness
- `900a758` docs: add cross-platform packaging guide
- `fd7c6da` chore: add packaging icons and platform window icons
- `9c7baae` feat: add workspace "Open in" terminal/file-manager actions (macOS/Linux)
- `a15aeb1` feat: bundle desktop notification plugin (dsh-desktop-notify) into the app
- `f308df8` docs: add custom.md (desktop customization notes) and notify-test script

**当前未提交的工作区改动**（通知点击导航 + macOS 窗口生命周期，尚未入库）：

- `electron/window-manager.js`（新）：窗口/导航状态机，main.js 与集成测试共用
- `electron/main.js`：macOS 关窗保活 + activate 重建 + 导航事件/IPC 接线（改用 window-manager）
- `electron/preload.js`：`onNavigate` / `takePendingNavigate` 桥
- `plugins/dsh-desktop-notify/lib/index.js`：通知点击携带会话并导航
- `plugins/dsh-desktop-navigate/`（新）：客户端插件（通知点击 → 打开会话）
- `electron/dsh-boot.js` / `package.json`：把 navigate 插件纳入 `BUILTIN_BUNDLES`
  与 `file:` 依赖；`package.json` 新增 `smoke:navigate` 脚本
- `scripts/notify-navigate-smoke.mjs`（新）：通知导航端到端集成测试（见 §5）
- `scripts/electron-smoke.mjs`：修复既有 bug——创建窗口后从未 `loadURL`，
  `did-finish-load` 永不触发、脚本必然挂死；补上行后恢复可用

## 用户数据与插件机制（沿用官网语义）

- `$DSH_HOME/profiles/web`：web profile（package.json 的 `dsh.profile.bundles` + 用户
  `cordis.patch.yml` 补丁层），桌面应用每次启动读取；
- 用户仍可用 CLI `dsh plugin --profile web add <pkg>` 安装树外插件，与内置插件并存
  （内置层幂等，不会与手动安装重复挂载）。
