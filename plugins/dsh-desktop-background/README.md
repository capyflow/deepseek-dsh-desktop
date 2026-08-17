# dsh-desktop-background

给 DeepSeek Harness Desktop 加「背景」功能:在 **设置 → 通用设置 → 外观** 区域
(Appearance 行下方)提供一行:

- **选择本地图片…** — 原生文件选择器挑一张图片(支持 png/jpg/jpeg/webp/gif/svg/bmp/avif/apng),
  立刻作为整窗壁纸,无需刷新;
- **恢复默认** — 回到内置默认壁纸(深蓝紫星云)。

## 组成

| 文件 | 角色 |
| --- | --- |
| `cordis.patch.yml` | bundle patch:把 `desktop-background` 行挂进 web profile 树 |
| `lib/index.js` | 宿主端:注册 `/desktop-wallpaper` 路由 + pick/clear/get 三个 IPC |
| `lib/client.js` | 浏览器端:设置行 UI + 换图即时生效 |
| `assets/wallpaper.svg` | 内置默认壁纸(与 `scripts/wallpaper.svg` 同款,可自行替换) |

## 原理

- 背景样式由 `scripts/patch-background.mjs` 注入进 SPA 的 `index.html`
  (`<style id="dsh-desktop-background">`),其中的壁纸 url 指向动态路由
  `/desktop-wallpaper`——宿主端按持久化状态出图(用户图片副本 / 内置默认)。
- 用户选图后,宿主把图片**复制**进 `$DSH_HOME/desktop-background-<ts>.<ext>`,
  状态存 `$DSH_HOME/desktop-background.json`;client 改写样式块 url(时间戳
  破缓存),**当前页面立即生效,重启也自动沿用**。
- 选图是原生对话框,走 `window.dshDesktop.pickBackground()` 桥
  (`electron/preload.js` 暴露);非 Electron 环境桥缺失时行只是提示不可用。

## 开发

改完插件后需要:重启桌面应用(宿主路由/IPC 在 boot 时挂载);若改了
`scripts/patch-background.mjs` 的注入内容,重跑 `node scripts/patch-background.mjs`
并刷新页面。