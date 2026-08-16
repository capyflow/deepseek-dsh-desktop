# dsh-desktop-notify

DSH 宿主插件：当 agent **需要你输入**或**处理完成**（或出错）时，弹出系统通知。

- 桌面应用（Electron）内：使用 **Electron 主进程原生通知**（macOS 通知中心），点击"完成/出错"通知会聚焦应用窗口并**自动切换到对应会话**（经 `dsh-desktop:navigate-request` 主进程事件 → dsh-desktop-navigate 客户端插件；窗口已关则先重建再导航）。
- 其他场景（如 CLI `dsh web` 跑在普通 Node 里）：退化为控制台日志，插件依然可加载、不会报错。

## 工作原理

插件是 DSH 标准 bundle（`package.json` 声明 `dsh.bundle.patch`），以 Cordis 插件形式挂进 web profile 的插件树，钩住两个官方事件面：

| 时机 | 钩子 | 说明 |
| --- | --- | --- |
| agent 需要用户输入 | `ctx.userQuestions.ask` | agent 调用 `ask_user_question` 工具时（包装服务方法，通知先于等待发出） |
| 处理完成 / 出错 | `session/event` 火线监听 `turn/end` | `reason.kind === 'completed'` 或 `'error'`；子 agent（`origin: 'subagent'` / `delegationDepth > 0`）的收尾被过滤，不打扰你 |

通知正文会带上会话里最近一条用户消息的摘录（最长 80 字符）。

关键实现细节：

- **进程内 boot**：桌面应用把整个 Cordis 树跑在 Electron 主进程里（`electron/dsh-boot.js`），所以插件直接 `require('electron')` 用原生 `Notification`，无需 IPC。
- **fail-soft**：所有钩子都包了 try/catch，通知失败只记日志，绝不影响 agent 循环或提问流程。
- **quietWhenFocused**：窗口有焦点时不弹"完成"通知（你正看着呢）；"需要输入"的通知永远弹——它是阻塞性的。
- 卸载/热重载时恢复被包装的 `ask` 方法、自动移除事件监听。

## 安装

先决条件：`pnpm` 在 PATH 上（`/opt/homebrew/bin/pnpm`）。

```bash
# 官方入口：dsh plugin 会在 profile 目录里跑 pnpm，装完后自动对账
# dsh.profile.bundles（见 @deepseek-ai/dsh 的 plugin 命令实现）
npx -y @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add \
  /Users/aaron/com.capyflow/deepseek-dsh-desktop/plugins/dsh-desktop-notify
```

或者手动等价步骤（效果相同）：

```bash
cd ~/.dsh/profiles/web
pnpm add file:/Users/aaron/com.capyflow/deepseek-dsh-desktop/plugins/dsh-desktop-notify
# 然后把 "dsh-desktop-notify" 追加进 package.json 的 dsh.profile.bundles
```

重启桌面应用即可生效（`dsh plugin` 对账会把它加进 `dsh.profile.bundles`，下次 boot 时
Loader 从 profile 目录解析并挂载）。

## 配置

插件 entry 的 `config` 可在更晚的补丁层按 `id: desktop-notify` 覆盖（profile 自己的
`cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`、或 `--patch` 覆盖层）。例如在
`~/.dsh/profiles/web/cordis.patch.yml` 里加：

```yaml
- id: desktop-notify
  config:
    notifyOnInput: true
    notifyOnComplete: true
    notifyOnError: false      # 出错不弹
    quietWhenFocused: false   # 有焦点也弹完成通知
```

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `notifyOnInput` | `true` | agent 提问时通知 |
| `notifyOnComplete` | `true` | 回合以 `completed` 结束时通知 |
| `notifyOnError` | `true` | 回合以 `error` 结束时通知 |
| `quietWhenFocused` | `true` | 窗口有焦点时抑制完成/出错通知（输入通知不受影响） |

## 卸载

```bash
npx -y @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web remove dsh-desktop-notify
```

## 扩展点

- 还想在 **浏览器端**（非桌面、纯 `dsh web`）弹系统通知：给本包加 `dsh.client` 双面声明，
  浏览器半用 Web Notification API，宿主半把事件桥过去（当前实现只做控制台回退）。
- 想通知其他事件（如工具权限审批 `approval/asked`、`max-tokens` 中断）：在
  `session/event` 监听器里按 `event.type` 扩展即可，payload 结构与 `dsh-session` 的
  `SessionEventMap` 一致。
