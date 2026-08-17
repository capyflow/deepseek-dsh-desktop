/**
 * dsh-desktop-background — browser half.
 *
 * 在 设置 → 通用设置 → 外观 区域(Appearance 行下方)注册「背景」行:
 *   - 「选择本地图片…」:走 window.dshDesktop.pickBackground()(原生文件
 *     选择器),选中后宿主把图片复制进 $DSH_HOME 并持久化;
 *   - 「恢复默认」:清掉自定义图片;
 *   - 选完**立即生效**——直接改写 index.html 里注入的
 *     `#dsh-desktop-background` 样式块中的壁纸 url(带时间戳破坏缓存),
 *     无需刷新页面;下次启动也自动沿用(静态样式始终指向
 *     /desktop-wallpaper 动态路由,宿主按持久化状态出图)。
 *
 * 与 dsh-desktop-navigate 同款模块格式(window.__ModuleLoader__.load),
 * 由 dsh-client-modules 通过 package.json 的 dsh.client 声明发现并挂进
 * window.__DSH_BOOT__;行注册沿用主题插件的 slot 模式
 * (ctx.slots.inject("settings.general.item") → ctx.slots.register)。
 *
 * 非桌面环境(window.dshDesktop 缺失)下行仍渲染,但按钮给出提示而不报错。
 *
 * @module dsh-desktop-background/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-background',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    let react_jsx_runtime = require('react/jsx-runtime')
    let _deepseek_ai_dsh_client_runtime_client = require('@deepseek-ai/dsh-client-runtime/client')

    /** 词典命名空间(与行注册的 locale 一致)。 */
    const NS = 'dsh-desktop-background'

    /** 简体中文词典(键集来源)。 */
    const zh = {
      'bg.title': '背景',
      'bg.default': '当前使用内置默认壁纸',
      'bg.applied': '当前使用自定义图片',
      'bg.source': '来源',
      'bg.pick': '选择本地图片…',
      'bg.picking': '选择中…',
      'bg.clear': '恢复默认',
      'bg.clearing': '恢复中…',
      'bg.error': '操作失败',
      'bg.noBridge': '桌面环境不可用(仅桌面版支持)',
    }
    /** 英文词典,键集与 zh 对齐。 */
    const en = {
      'bg.title': 'Background',
      'bg.default': 'Using the built-in default wallpaper',
      'bg.applied': 'Using a custom image',
      'bg.source': 'Source',
      'bg.pick': 'Choose local image…',
      'bg.picking': 'Choosing…',
      'bg.clear': 'Reset to default',
      'bg.clearing': 'Resetting…',
      'bg.error': 'Action failed',
      'bg.noBridge': 'Desktop shell unavailable (desktop app only)',
    }

    // ── 行样式(仿主题插件:data-plugin-css 注入,类名用固定前缀 dsbg_ 避免冲突) ──
    const css = [
      '.dsbg_group{flex-direction:column;gap:10px;padding:16px 0;display:flex}',
      '.dsbg_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
      '.dsbg_actions{flex-wrap:wrap;align-items:center;gap:8px;display:flex}',
      '.dsbg_button{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:var(--dsw-alias-button-ghost-active-fill);border-radius:8px;padding:6px 14px;font-size:13px;line-height:20px}',
      '.dsbg_button:hover:not(:disabled){background:var(--dsw-alias-button-ghost-active-hover)}',
      '.dsbg_button:disabled{cursor:default;opacity:.5}',
      '.dsbg_hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsbg_error{color:var(--dsw-alias-state-error-primary)}',
    ].join('')
    const tagId = 'dsh-desktop-background/BackgroundRow.css'
    // 注意:selector 里不再额外加引号——JSON.stringify(tagId) 自带一对双引号,
    // 恰好作为属性值的引号(与主题插件写法一致)。
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-desktop-background'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ── 行 store:picking/clearing/custom/source/error ▸ 组件只读,动作由注入的动作改 ──
    function createBackgroundStore() {
      return _deepseek_ai_dsh_client_runtime_client.defineStore({
        init: () => ({ picking: false, clearing: false, custom: false, source: null, error: null }),
        actions: {
          setPicking: (d, value) => { d.picking = value },
          setClearing: (d, value) => { d.clearing = value },
          setResult: (d, result) => {
            d.custom = result.custom
            d.source = result.source
            d.error = null
          },
          setError: (d, message) => { d.error = message },
        },
      })
    }

    /** 取路径 basename(浏览器端,兼容 \ 和 /)。 */
    function baseName(path) {
      if (typeof path !== 'string' || path === '') return ''
      const parts = path.split(/[\\/]/)
      return parts[parts.length - 1] || path
    }

    /**
     * 让壁纸立即生效:改写静态样式块里的 url(加时间戳破坏 no-store 也保险走一遍)。
     * 该样式块是 scripts/patch-background.mjs 在 index.html 里注入的,选择器/结构
     * 完全在我们控制下,字符串替换是安全的。
     */
    function refreshWallpaperUrl() {
      const styleEl = typeof document !== 'undefined' ? document.getElementById('dsh-desktop-background') : null
      if (!styleEl) return
      styleEl.textContent = styleEl.textContent.replace(
        /url\("\/desktop-wallpaper[^"]*"\)/g,
        'url("/desktop-wallpaper?v=' + Date.now() + '")',
      )
    }

    /**
     * 渲染「背景」行。
     * @param props - slot 组合 props:{ t, useStore, pick, clear }
     */
    function BackgroundRow(_props) {
      var t = _props.t
      var useStore = _props.useStore
      var pick = _props.pick
      var clear = _props.clear
      var state = useStore((s) => s)
      var sourceLabel = ''
      if (state.custom && state.source) sourceLabel = baseName(state.source)
      return react_jsx_runtime.jsxs('div', {
        className: 'dsbg_group',
        children: [
          react_jsx_runtime.jsx('div', { className: 'dsbg_title', children: t('bg.title') }),
          react_jsx_runtime.jsxs('div', {
            className: 'dsbg_actions',
            children: [
              react_jsx_runtime.jsx('button', {
                type: 'button',
                className: 'dsbg_button',
                disabled: state.picking,
                onClick: pick,
                children: state.picking ? t('bg.picking') : t('bg.pick'),
              }),
              react_jsx_runtime.jsx('button', {
                type: 'button',
                className: 'dsbg_button',
                disabled: state.clearing || !state.custom,
                onClick: clear,
                children: state.clearing ? t('bg.clearing') : t('bg.clear'),
              }),
            ],
          }),
          react_jsx_runtime.jsx('div', {
            className: 'dsbg_hint',
            children: [
              state.custom ? t('bg.applied') + (sourceLabel ? ' · ' + t('bg.source') + ': ' + sourceLabel : '') : t('bg.default'),
              state.error !== null ? react_jsx_runtime.jsxs('span', {
                className: 'dsbg_error',
                children: [t('bg.error') + ': ', state.error],
              }) : null,
            ],
          }),
        ],
      })
    }

    /** 插件 body:注册词典 + 注入「背景」行到通用设置的外观区域。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-desktop-background: row dictionaries')
      const store = createBackgroundStore()

      const injected = (actions) => {
        /** 打开设置时同步一次当前状态(行展示来源/是否自定义)。 */
        const sync = () => {
          const bridge = window.dshDesktop
          if (!bridge?.getBackground) return
          bridge
            .getBackground()
            .then((res) => {
              if (res?.ok) actions.setResult({ custom: !!res.custom, source: res.source ?? null })
            })
            .catch(() => {})
        }
        // 注册时同步一次持久化状态(页面加载后行首次渲染即显示当前背景)
        sync()
        return {
          pick: () => {
            const bridge = window.dshDesktop
            if (!bridge?.pickBackground) {
              actions.setError('desktop bridge unavailable')
              return
            }
            actions.setPicking(true)
            bridge
              .pickBackground()
              .then((res) => {
                if (res?.canceled) return
                if (!res?.ok) actions.setError(res?.error ?? 'pick failed')
                else {
                  actions.setResult({ custom: true, source: res.source ?? null })
                  refreshWallpaperUrl()
                }
              })
              .catch((error) => actions.setError(String(error)))
              .finally(() => actions.setPicking(false))
          },
          clear: () => {
            const bridge = window.dshDesktop
            if (!bridge?.clearBackground) return
            actions.setClearing(true)
            bridge
              .clearBackground()
              .then((res) => {
                if (res?.ok) {
                  actions.setResult({ custom: false, source: null })
                  refreshWallpaperUrl()
                } else {
                  actions.setError(res?.error ?? 'clear failed')
                }
              })
              .catch((error) => actions.setError(String(error)))
              .finally(() => actions.setClearing(false))
          },
          sync,
        }
      }

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'desktop-background',
        order: 20,
        store,
        locale: NS,
        inject: injected,
      }, BackgroundRow))
    }

    /** 服务依赖:行渲染与词典注册需要。 */
    const inject = ['slots', 'locale']

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})