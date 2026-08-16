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

## 用户数据

- `DSH_HOME` 环境变量优先；未设置时默认 `~/.dsh`——**与 dsh CLI 共用同一套**
  profile、会话、凭据、`.env`（桌面端和 CLI 可以无缝切换使用）。
- 遥测开关：设置 `DSH_TELEMETRY_DISABLED=1` 即关闭（同 dsh CLI）。

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
