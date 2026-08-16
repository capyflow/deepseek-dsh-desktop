# 跨平台打包指南

把 DeepSeek Harness Desktop 打包成各平台安装包的完整说明。

## 核心原则：必须在目标平台上构建

**本项目的原生模块（node-pty、node-addon-require-builtin 等）在 `npm install` 时
本地编译（node-gyp），没有跨平台预编译产物**；macOS 的 dmg 打包还依赖 macOS 的
`hdiutil`。因此：

> ❌ 不支持在 Linux 上交叉编译 macOS/Windows 包
> ✅ 每个平台各自 `npm install && npm run dist`

## 通用前置

| 依赖 | 版本要求 |
|---|---|
| Node.js | ≥ 22（dsh 用到 `node:sqlite` 等新特性） |
| npm | 随 Node 自带 |

```bash
npm install
npm run smoke   # 打包前必跑：验证 dsh 进程内 boot + SPA 可达（金丝雀测试）
```

## Linux

```bash
npm run dist:linux        # 产出 AppImage + deb 到 release/
npx electron-builder --linux --arm64   # 需要 arm64 机器或交叉打包环境
```

- 运行时依赖：桌面环境（X/Wayland）；`host.pickDirectory`（原生目录选择器）需要
  `zenity` 或 `kdialog`
- 沙箱：Linux 沙箱用预编译的 `landlock-run`（随 npm 包分发），无需系统额外安装；
  在未启用 user namespace 的系统上运行 AppImage 可能需要 `--no-sandbox`

## macOS（Apple Silicon / Intel）

**必须在 macOS 机器上构建**（Apple Silicon 构建 Apple Silicon 包；Intel 同理）。

```bash
npm run dist:mac                 # 当前架构
npx electron-builder --mac --arm64   # 强制 arm64
npx electron-builder --mac --x64     # 强制 x64
```

- 产物：`release/*.dmg`
- **签名/公证**：本项目默认未配置代码签名。正式分发前需在
  `package.json` 的 `build.mac` 配置 Developer ID 证书与 notarization，
  否则 macOS 的 Gatekeeper 会拦截未签名应用
- 原生模块（node-pty 等）在安装时用 Xcode Command Line Tools 编译，
  需先安装：`xcode-select --install`

## Windows

```bash
npm run dist:win       # 在 Windows 上执行；产出 NSIS 安装包
```

- 在 Linux 上可用 wine 交叉构建（不推荐，原生模块编译容易踩坑）
- electron-builder 打包时自动执行 `@electron/rebuild` 重编原生模块
- 首次构建会下载 NSIS 工具链，需要网络

## 升级 dsh（含 WebUI）

壳子与 dsh 只通过稳定公共 API（`@deepseek-ai/dsh-app-boot`）交互，
WebUI 更新对壳子零影响（UI 随 npm 包分发，壳子只负责开窗口）。

```bash
npm update @deepseek-ai/dsh   # 拉新版本（含新 UI）
npm run smoke                 # 金丝雀：boot 失败 = 公共 API 变了，先查再打包
npm run dist                  # 重新打包
```

- `package.json` 中 `^0.1.0-rc.6` 只允许 `0.1.x` 范围内自动升级，
  `0.2.0` 等大版本不会自动拉取——升级节奏由你控制

## 架构决策记录（为什么升级压力小）

| 决策 | 原因 |
|---|---|
| 进程内 boot（`app-boot` 公共 API） | 不用 `@deepseek-ai/dsh/lib/profile-boot-*.js`（哈希分块文件名，发版就变） |
| `"asar": false` | dsh 的 `healProfilesModuleFallback` 符号链接穿不过 asar |
| `DSH_HOME` 默认 `~/.dsh` | 与 dsh CLI 共享配置/凭据/会话 |
| `--port 0` | OS 自动分配端口，桌面端永不撞端口 |
