/**
 * Client half of the Chinese typo checker.
 *
 * Timing policy (measured, see src/bench.mjs):
 *   - check() costs ~8µs at 60 chars, ~100µs at 1000 chars, ~0.5ms at 3000.
 *     That is two orders of magnitude below a frame, so it runs synchronously
 *     on every draft change: the underline lands in the same paint as the text.
 *   - Measurement reads the editor DOM in that same layout effect, so no frame
 *     is lost between the text and its marks.
 *   - Debounce only exists as a guard for very long drafts (pasted documents),
 *     and scroll/resize are coalesced to one pass per animation frame.
 *
 * Authored as a template: `tools/build-client.mjs` splices the checker core
 * (src/core.mjs) in at the CORE marker so the browser bundle stays one file
 * with no runtime imports beyond React.
 */
window.__ModuleLoader__.load({
  // 必须与 package.json 的 name 完全一致：壳按包名找这个工厂，
  // 名字对不上就是 "entry did not activate"，整个 web boot 会报错。
  // 构建时由 tools/build-client.mjs 从 bundle/package.json 注入。
  id: '__PACKAGE_NAME__',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')

    // ---- checker core (generated from src/core.mjs) ----
    /*__CORE__*/
    // ---- end checker core ----

    // ---- settings persistence bridge (generated from src/config-store.mjs) ----
    /*__CONFIG_STORE__*/
    // ---- end settings persistence bridge ----

    /**
     * 诊断打点：把客户端发生的事写到宿主日志里。
     *
     * 放在工厂作用域，apply 和组件里都能用——之前在 apply 里定义成局部常量，
     * 组件里调用就抛 ReferenceError，而它恰好写在模型结果处理的 .then 里，
     * 异常被 .catch 吞掉，表现为"宿主答了、界面永远不画"。
     */
    function beacon(message) {
      try {
        void fetch('/zh-typo-model/log?msg=' + encodeURIComponent(String(message))).catch(() => {})
      } catch { /* 诊断不能影响功能 */ }
    }

    // 模块一被求值就打点：没有这条日志 = 客户端模块压根没加载
    beacon('factory evaluated, href=' + location.pathname)

    const NS = 'zh-typo-check'
    const MIN_CONFIDENCE = 0.9
    /** Above this many characters a synchronous pass stops being free; debounce it. */
    const LONG_TEXT_THRESHOLD = 4000
    const LONG_TEXT_DEBOUNCE_MS = 140
    const HIDE_DELAY_MS = 140
    const CACHE_LIMIT = 24

    /**
     * 模型检查的节流参数。
     *
     * 规则检查是微秒级，跟着每次按键同步跑；模型一次要 200–300 ms，
     * 只能等用户停手。400 ms 是"打完一句话"的体感分界点——
     * 再短会在输入过程中反复打断，再长用户会觉得没反应。
     */
    const MODEL_DEBOUNCE_MS = 400
    const MODEL_MIN_CHARS = 4
    const MODEL_MAX_CHARS = 500
    const STORAGE_KEY = 'dsh.zh-typo-check.ignored'
    const WARN_TOKEN = '--dsw-alias-state-warn-primary'

    const STRINGS = {
      zh: {
        title: '中文检查',
        replace: '替换',
        ignore: '忽略',
    fluencyBody: '整句意思可能不连贯',
    optFluencyLabel: '整句检查',
    optFluencyHint: '中文、英文和混排；只提示，不改写。',
    semanticReady: '已就绪 · 本地运行',
    semanticDisabled: '已关闭',
    semanticGlobalOff: '检查已暂停',
    semanticRemove: '删除整句模型',
    semanticRetry: '重试下载',
    semanticRuntime: '运行时不可用，请重新安装插件。',
        options: '检查设置',
        on: '开',
        off: '关',
        optEnabledLabel: '启用检查',
        optPunctLabel: '检查半角标点',
        optModelLabel: '中文错字增强',
        optModelHint: '补充单字替换建议；整句异常时暂停。',
        optSensitivityLabel: '错字灵敏度',
        optSensitivityHint: '激进会多报，保守会少报。',
        sensLow: '保守',
        sensNormal: '标准',
        sensHigh: '激进',
        optSourceLabel: '下载来源',
        optional: '可选',
        sentenceSize: '约 27 MB',
        typoSize: '约 104 MB',
        stateFailed: '下载失败',
        typoRemove: '删除错字模型',
        downloadSettings: '下载设置',
        moreSettings: '更多设置',
        customBaseLabel: '自定义下载地址',
        sentencePlaceholder: 'https://你的镜像/semantic-r13',
        sourceGitHub: 'GitHub（官方）',
        sentencePaused: '已暂停（整句异常）',
        sourceAuto: '自动',
        sourceMirror: '国内镜像',
        sourceOfficial: '官方',
        sourceCustom: '自定义',
        customPlaceholder: 'https://你的镜像/…/macbert4csc-base-chinese/resolve/main',
        customInvalid: '地址需要以 http:// 或 https:// 开头',
        settingsSaveFailed: '设置未保存，请重试。',
        settingsNamespaceUnavailable: '设置仅在当前页面生效，请更新 DSH。',
        stateAbsent: '未安装',
        stateDownloading: '下载中 {percent}%',
        stateVerifying: '校验中',
        statePartial: '下载未完成',
        resume: '继续下载',
        lastCheck: '最近模型检查：错字{typo} · 整句{sentence} · {ms} ms',
        sentenceWarning: '已提示',
        sentenceClear: '未提示',
        sentenceLong: '超出长度，未检查',
        sentenceOff: '已关闭',
        sentenceUnavailable: '未就绪',
        stateReady: '已就绪',
        stateError: '出错：{error}',
        stateChecking: '检查中…',
        stateUnavailable: '宿主服务不可用',
        refreshStatus: '刷新状态',
        cancel: '取消',
        download: '下载模型',
      },
      en: {
        title: 'Chinese check',
        replace: 'Replace',
        ignore: 'Ignore',
    fluencyBody: 'The sentence may be incoherent',
    optFluencyLabel: 'Sentence checking',
    optFluencyHint: 'Chinese, English and mixed text. Warnings only.',
    semanticReady: 'Ready · Runs locally',
    semanticDisabled: 'Off',
    semanticGlobalOff: 'Checking paused',
    semanticRemove: 'Remove sentence model',
    semanticRetry: 'Retry download',
    semanticRuntime: 'Runtime unavailable. Reinstall the plugin.',
        options: 'Checking options',
        on: 'On',
        off: 'Off',
        optEnabledLabel: 'Enable checking',
        optPunctLabel: 'Check half-width punctuation',
        optModelLabel: 'Chinese typo enhancement',
        optModelHint: 'Character suggestions, paused for incoherent sentences.',
        optSensitivityLabel: 'Typo sensitivity',
        optSensitivityHint: 'Aggressive flags more; conservative flags less.',
        sensLow: 'Conservative',
        sensNormal: 'Normal',
        sensHigh: 'Aggressive',
        optSourceLabel: 'Download source',
        optional: 'Optional',
        sentenceSize: 'About 27 MB',
        typoSize: 'About 104 MB',
        stateFailed: 'Download failed',
        typoRemove: 'Remove typo model',
        downloadSettings: 'Download settings',
        moreSettings: 'More settings',
        customBaseLabel: 'Custom download URL',
        sentencePlaceholder: 'https://your-mirror/semantic-r13',
        sourceGitHub: 'GitHub (official)',
        sentencePaused: 'paused (incoherent sentence)',
        sourceAuto: 'Auto',
        sourceMirror: 'China mirror',
        sourceOfficial: 'Official',
        sourceCustom: 'Custom',
        customPlaceholder: 'https://your-mirror/…/macbert4csc-base-chinese/resolve/main',
        customInvalid: 'The address must start with http:// or https://',
        settingsSaveFailed: 'Could not save. Please try again.',
        settingsNamespaceUnavailable: 'Settings apply to this page only. Update DSH.',
        stateAbsent: 'Not installed',
        stateDownloading: 'Downloading {percent}%',
        stateVerifying: 'Verifying',
        statePartial: 'Download incomplete',
        resume: 'Resume download',
        lastCheck: 'Last model check: Typos: {typo} · Sentence: {sentence} · {ms} ms',
        sentenceWarning: 'warning',
        sentenceClear: 'no warning',
        sentenceLong: 'too long, not checked',
        sentenceOff: 'off',
        sentenceUnavailable: 'not ready',
        stateReady: 'Ready',
        stateError: 'Failed: {error}',
        stateChecking: 'Checking…',
        stateUnavailable: 'Host service unavailable',
        refreshStatus: 'Refresh status',
        cancel: 'Cancel',
        download: 'Download model',
      },
    }

    /** `t()` 只做查表，带变量的句子在这里填空，避免把整句拆成碎片拼接。 */
    function format(template, values) {
      if (typeof template !== 'string') return ''
      return template.replace(/\{(\w+)\}/g, (whole, key) => (values[key] === undefined ? whole : String(values[key])))
    }

    // ---- 用户偏好 ----
    //
    // 设置存在宿主插件的 Config（DSH 会把它写进 profile 的 cordis.patch.yml），
    // 不再只存 localStorage：桌面版每次启动都会换一个本地端口，origin 一变
    // localStorage 就整份丢失——这正是「重启/升级后配置项被重置」的根因。
    // 旧版 DSH 没有 configForms 时，桥自动退化为只写本地缓存。
    const SETTINGS_KEY = 'dsh.zh-typo-check.settings'
    /** 与宿主 Config 共用的 Loader 条目 id：configForms 按它找配置命名空间。 */
    const CONFIG_NAMESPACE = 'zh-typo-check'

    /** 灵敏度档位 → 模型层的 Δ 阈值。阈值越低越容易报，也越容易误报。 */
    const SENSITIVITY = {
      low: 15,
      normal: 12,
      high: 9,
    }

    /** 隐私模式等场景下 localStorage 可能直接抛异常，这里兜住。 */
    function safeLocalStorage() {
      try {
        return window.localStorage
      } catch (_error) {
        return null
      }
    }

    const configSettings = new ConfigSettings({
      storage: safeLocalStorage(),
      storageKey: SETTINGS_KEY,
      namespace: CONFIG_NAMESPACE,
      onEvent: (message) => beacon('settings ' + message),
    })

    /**
     * 偏好存在模块级：输入框浮层和设置页是两个槽位里的组件，
     * 改一处要立刻影响另一处，靠这个小 store 打通。
     */
    const settingsStore = {
      get() { return configSettings.get() },
      set(patch) { return configSettings.set(patch) },
      subscribe(listener) { return configSettings.subscribe(listener) },
    }


    /**
     * 最近一次模型检查的结果，供设置页显示。
     *
     * 模型层是"静默增强"：没生效时界面上什么都不缺，所以用户没法判断
     * 到底是没有错、还是根本没查。这行诊断就是为了让这件事可观测。
     */
    const checkLogStore = {
      value: { state: 'idle', issues: 0, ms: 0, at: 0, detail: '' },
      listeners: new Set(),
      get() { return this.value },
      set(next) {
        this.value = next
        for (const listener of this.listeners) listener(next)
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    function useCheckLog() {
      const [value, setValue] = React.useState(checkLogStore.get())
      React.useEffect(() => checkLogStore.subscribe(setValue), [])
      return value
    }
    function useSettings() {
      return React.useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get)
    }

    /** 设置错误的订阅/读取器（React 18 的 useSyncExternalStore 要求稳定引用）。 */
    const subscribeSettingsError = (listener) => configSettings.subscribeError(listener)
    const readSettingsError = () => configSettings.getErrorState()

    /** 设置写入失败的最近状态：{ code, message, fields }；null 表示没有错误。 */
    function useSettingsError() {
      return React.useSyncExternalStore(subscribeSettingsError, readSettingsError, readSettingsError)
    }

    /** Resolve the theme warning colour once, so the wave matches light and dark. */
    function resolveWaveColor() {
      try {
        const value = getComputedStyle(document.documentElement).getPropertyValue(WARN_TOKEN).trim()
        if (value !== '') return value
      } catch (_error) { /* fall through */ }
      return '#e8833a'
    }

    /** A 3px repeating wave, tinted with the theme warning colour. */
    function waveImage(color) {
      const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='8' height='3' viewBox='0 0 8 3'>"
        + "<path d='M0 2.1 Q2 0.5 4 2.1 T8 2.1' fill='none' stroke='" + color + "' stroke-width='1.3' stroke-linecap='round'/></svg>"
      return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")'
    }

    // ---- editor text helpers (generated from src/editor.mjs) ----
    /*__EDITOR__*/
    // ---- end editor text helpers ----

    function loadIgnored() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        const parsed = raw === null ? [] : JSON.parse(raw)
        return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [])
      } catch (_error) {
        return new Set()
      }
    }

    function saveIgnored(words) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...words]))
      } catch (_error) { /* private mode: keep the in-memory set only */ }
    }

    const ignoreKey = (issue) => {
        if (issue.kind === 'punct') return 'punct:' + issue.start + ':' + issue.text
        if (issue.kind === 'model') return 'model:' + issue.context
        if (issue.kind === 'fluency') return 'fluency:' + issue.context
        return issue.text
      }

    /** Fallback input subscription: no session, nothing to select. */
    function useNoInput(selector) { return selector(undefined) }

    /** Fallback locale lookup: show the key itself. */
    function identityText(key) { return key }

    /**
     * Build one immutable view: the issues plus the rectangles they occupy.
     * Returns null whenever nothing can be shown safely (no editor, mid-IME,
     * chip present, or the DOM disagrees with the draft).
     */
    const modelChangeListeners = new Set()
    function modelsChanged() { for (const listener of modelChangeListeners) listener() }
    function modelCacheKey(text, prefs) { return text + '\u0000' + [prefs.sensitivity, prefs.model, prefs.fluency].join(':') }

    function computeView(draft, rev, found, ignored, wave, stamp, fluency) {
      if (typeof draft !== 'string' || draft === '') return null
      const root = document.querySelector('[data-composer-input]')
      if (root === null) return null
      // Never fight the IME: a composing draft is not yet what the user meant.
      if (root.hasAttribute('data-composer-composing') || root.closest('[data-composer-composing]') !== null) return null
      const issues = found.filter((issue) => !ignored.has(ignoreKey(issue)))
      // 整句异常独立于局部规则；安装可选错字模型不能让整句提示消失。
      const sentenceLevel = fluency !== null && fluency !== undefined
        && !ignored.has('fluency:' + draft)
      if (issues.length === 0 && !sentenceLevel) return null
      const sentenceIndex = issues.length
      if (sentenceLevel) {
        issues.push({
          start: 0,
          end: Math.max(1, draft.length),
          kind: 'fluency',
          text: draft,
          // 忽略按整句记：这是"这句别提醒我"，不是"这个字别管"
          context: draft,
          message: 'fluencyBody',
          suggestions: [],
          sentence: true,
        })
      }
      const index = buildIndex(root)
      // A chip (file reference) makes the DOM text and the draft text diverge.
      // Trust the region before the first difference rather than going dark.
      let usable = draft.length
      if (index.text !== draft) {
        const shared = Math.min(index.text.length, draft.length)
        let at = 0
        while (at < shared && index.text.charCodeAt(at) === draft.charCodeAt(at)) at += 1
        usable = at
      }
      if (usable === 0) return null
      const marks = []
      // 局部标记排在前面，鼠标命中时优先显示具体问题。
      for (let i = 0; i < sentenceIndex; i += 1) {
        if (issues[i].end > usable) continue
        for (const rect of rangeRects(index, issues[i].start, issues[i].end)) marks.push({ ...rect, index: i })
      }
      if (sentenceLevel) {
        // 整句提示：按「视觉行」切段。每段同时带着整行的矩形——
        // 命中判定读的是 top/height，所以要覆盖整行文字，不能只留一条线，
        // 否则必须精准指到那条虚线才弹提示。
        const rows = new Map()
        for (const rect of rangeRects(index, 0, usable)) {
          const key = Math.round(rect.top)
          const seen = rows.get(key)
          if (seen === undefined) {
            rows.set(key, {
              left: rect.left,
              right: rect.left + rect.width,
              top: rect.top,
              bottom: rect.top + rect.height,
            })
          } else {
            seen.left = Math.min(seen.left, rect.left)
            seen.right = Math.max(seen.right, rect.left + rect.width)
            seen.top = Math.min(seen.top, rect.top)
            seen.bottom = Math.max(seen.bottom, rect.top + rect.height)
          }
        }
        for (const row of rows.values()) {
          if (row.right <= row.left) continue
          marks.push({
            left: row.left,
            top: row.top,
            width: row.right - row.left,
            height: row.bottom - row.top,
            // 虚线画在行底，命中区域是整行文字
            line: row.bottom + (sentenceIndex > 0 ? 3 : 0),
            index: sentenceIndex,
            sentence: true,
          })
        }
      }
      if (marks.length === 0) return null
      return { text: draft, rev, issues, marks, wave, stamp }
    }

    /**
     * 把模型报的位置并进规则的结果里。
     *
     * 同一处两边都报了就以规则为准——规则的判据是确定性的，模型只是补盲区。
     */
    function mergeModelIssues(base, modelIssues, text, sentenceWarning = false) {
      // 句子不连贯时，MLM 的单字替换缺乏可信上下文（例如误把“危”猜成“凸”）。
      // 只暂停模型猜测；确定性的规则仍与整句提示一起显示。
      if (sentenceWarning) return base
      if (!Array.isArray(modelIssues) || modelIssues.length === 0) return base
      const merged = base.slice()
      for (const hit of modelIssues) {
        const start = hit.index
        const end = start + 1
        if (!Number.isInteger(start) || start < 0) continue
        if (merged.some((other) => start < other.end && end > other.start)) continue
        merged.push({
          start,
          end,
          kind: 'model',
          text: hit.original,
          // 忽略时按上下文记，不按单字记：人名这类误报一忽略就是整句话的事，
          // 而按字记会把所有该字的位置一起放过。
          context: typeof text === 'string' ? text.slice(Math.max(0, start - 2), start + 3) : hit.original,
          message: '按上下文更像「' + hit.candidate + '」',
          suggestions: [hit.candidate],
          confidence: 0.85,
        })
      }
      merged.sort((a, b) => a.start - b.start)
      return merged
    }

    /**
     * 新算出来的视图值不值得替换旧的。
     *
     * 除文本和版本号外还必须比这两样：
     *   - `stamp`：忽略列表与模型结果的版本。忽略一条错误时文本没变，
     *     只比文本会把新结果丢掉，表现成"点了忽略没反应"。
     *   - `marks`：实际几何。滚动/换行会让下划线移位而文本不变。
     */
    function sameView(a, b) {
      if (a === null || b === null) return a === b
      return a.text === b.text
        && a.rev === b.rev
        && a.stamp === b.stamp
        && sameGeometry(a.marks, b.marks)
    }

    /** 两组标记是否落在同一位置——用来跳过无意义的重新渲染。 */
    function sameGeometry(a, b) {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i += 1) {
        if (a[i].left !== b[i].left || a[i].top !== b[i].top) return false
        if (a[i].width !== b[i].width || a[i].index !== b[i].index) return false
        if (a[i].height !== b[i].height || a[i].line !== b[i].line || a[i].sentence !== b[i].sentence) return false
      }
      return true
    }

    function TypoLayer(props) {
      // A missing prop must never take the composer down with it: the owner
      // always supplies both, but a fallback keeps the failure local.
      const useInput = typeof props.useInput === 'function' ? props.useInput : useNoInput
      const inputActions = props.inputActions
      const t = typeof props.t === 'function' ? props.t : identityText

      const draft = useInput((state) => (state === undefined || state === null ? '' : state.draft))
      const draftRev = useInput((state) => (state === undefined || state === null ? 0 : state.draftRev))
      const prefs = useSettings()

      const [view, setView] = React.useState(null)
      const [active, setActive] = React.useState(null)
      const [ignoredRev, bumpIgnored] = React.useReducer((n) => n + 1, 0)
      const [modelVersion, setModelVersion] = React.useState(0)
      const ignoredRef = React.useRef(null)
      if (ignoredRef.current === null) ignoredRef.current = loadIgnored()
      const cacheRef = React.useRef(new Map())
      /** 模型最近一次的结果：{ text, issues }。text 不匹配就当没有，避免错位。 */
      const modelRef = React.useRef({ text: '', issues: [] })
      /** 已经发过请求的文本，防止停止输入后每帧都打一次。 */
      const requestedRef = React.useRef('')
      /** 在途的模型请求：同一时刻只留一个，新的开始就把旧的掐掉，别让宿主排队。 */
      const inflightRef = React.useRef(null)
      /** 模型结果的按文本缓存：来回修改同一段文字时不必重问，也不会丢结果。 */
      const modelCacheRef = React.useRef(new Map())
      const hideTimer = React.useRef(0)
      const waveRef = React.useRef('')
      if (waveRef.current === '') waveRef.current = waveImage(resolveWaveColor())

      const refresh = React.useCallback(() => {
        const text = typeof draft === 'string' ? draft : ''
        let next = null
        if (prefs.enabled && text.length <= LONG_TEXT_THRESHOLD) {
          // Cache the verdict per draft text, not per revision: backspacing and
          // retyping the same words then costs a DOM measure, not a re-check.
          // Geometry is never cached, because the same text can move on screen.
          let found = cacheRef.current.get(text)
          if (found === undefined) {
            found = check(text, { minConfidence: MIN_CONFIDENCE })
            cacheRef.current.set(text, found)
            if (cacheRef.current.size > CACHE_LIMIT) {
              cacheRef.current.delete(cacheRef.current.keys().next().value)
            }
          }
          if (!prefs.punctuation) found = found.filter((issue) => issue.kind !== 'punct')
          // 规则先出结果，模型的结果到了再补一次——两者都不阻塞输入。
          let fromModel = []
          let fromFluency = null
          if (prefs.model || prefs.fluency) {
            const key = modelCacheKey(text, prefs)
            const record = modelRef.current.key === key ? modelRef.current : modelCacheRef.current.get(key)
            if (record !== undefined) {
              fromModel = prefs.model ? record.issues : []
              fromFluency = prefs.fluency && record.fluency?.low === true ? record.fluency : null
            }
          }
          const merged = mergeModelIssues(found, fromModel, text, fromFluency !== null)
          next = computeView(text, draftRev, merged, ignoredRef.current, waveRef.current, ignoredRev + ':' + modelVersion, fromFluency)
        }
        setView((previous) => (sameView(previous, next) ? previous : next))
        setActive(null)
        // 偏好参与渲染结果，必须进依赖：关掉标点检查后要立刻生效
      }, [draft, draftRev, ignoredRev, modelVersion, prefs.enabled, prefs.punctuation, prefs.model, prefs.fluency, prefs.sensitivity])

      /**
       * 模型检查：停手 400 ms 后问一次宿主。
       *
       * 只在文本变过才发请求；宿主没装模型时返回得很快、issues 为空，
       * 所以"没装模型"这件事在这里不需要特判，也不会拖慢输入。
       */
      React.useEffect(() => {
        if (typeof draft !== 'string') return undefined
        if (!prefs.enabled || (!prefs.model && !prefs.fluency)) return undefined
        if (draft.length < MODEL_MIN_CHARS) return undefined
        if (draft.length > MODEL_MAX_CHARS) {
          checkLogStore.set({ state: 'skipped', issues: 0, sentence: 'Long', ms: 0, at: Date.now(), detail: '' })
          return undefined
        }
        // 灵敏度变了要重新问一次，所以缓存的文本里带上阈值
        const requestKey = modelCacheKey(draft, prefs)
        if (requestedRef.current === requestKey) return undefined
        if (modelCacheRef.current.has(requestKey)) { requestedRef.current = requestKey; return undefined }
        const timer = window.setTimeout(() => {
          const startedAt = Date.now()
          requestedRef.current = requestKey
          if (inflightRef.current !== null) {
            try { inflightRef.current.abort() } catch { /* ignore */ }
            inflightRef.current = null
          }
          const controller = new AbortController()
          inflightRef.current = controller
          const url = MODEL_ENDPOINT + 'check?text=' + encodeURIComponent(draft)
            + '&delta=' + SENSITIVITY[prefs.sensitivity]
            + '&typo=' + (prefs.model ? '1' : '0') + '&sentence=' + (prefs.fluency ? '1' : '0')
          fetch(url, { cache: 'no-store', signal: controller.signal })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
              const elapsed = Date.now() - startedAt
              const state = body === null ? 'HTTP 错误' : body.state
              const sentenceWarning = prefs.fluency && body?.fluency?.low === true
              const issues = !sentenceWarning && body !== null && Array.isArray(body.issues) ? body.issues.length : 0
              const detail = body === null
                ? ''
                : [body.reason, body.chars !== undefined ? body.chars + ' 字' : '', body.aligned === false ? '分词未对齐' : '']
                  .filter((part) => typeof part === 'string' && part !== '').join(' · ')
              const sentence = body?.semantic?.state === 'ready' ? body.semantic.warning ? 'Warning' : 'Clear'
                : body?.semantic?.state === 'disabled' ? 'Off' : body?.semantic?.state === 'too-long' ? 'Long' : 'Unavailable'
              const typo = body?.typo?.state === 'ready' ? sentenceWarning ? 'Paused' : 'Ready' : body?.typo?.state === 'disabled' ? 'Off' : 'Unavailable'
              checkLogStore.set({ state, issues, typo, sentence, ms: elapsed, at: Date.now(), detail: body?.semantic?.error || body?.error || detail })
              if (body === null || body.state !== 'ready' || !Array.isArray(body.issues)) {
                // 这一次没成，下次文本再变还有机会——但不能把这句永久钉死成"查过了"。
                // 早先这里不重置，模型晚装好之后同一句话再也不会被查。
                requestedRef.current = ''
                return
              }
              if (controller.signal.aborted) return
              const record = { key: requestKey, text: draft, issues: body.issues, fluency: body.fluency ?? null }
              modelRef.current = record
              modelCacheRef.current.set(requestKey, record)
              if (inflightRef.current === controller) inflightRef.current = null
              if (modelCacheRef.current.size > CACHE_LIMIT) {
                modelCacheRef.current.delete(modelCacheRef.current.keys().next().value)
              }
              setModelVersion((n) => n + 1)
            })
            .catch((failure) => {
              if (failure?.name === 'AbortError') return
              requestedRef.current = ''
              checkLogStore.set({
                state: 'HTTP 不可用',
                issues: 0,
                sentence: 'Unavailable',
                ms: Date.now() - startedAt,
                at: Date.now(),
                detail: failure instanceof Error ? failure.message : String(failure),
              })
            })
        }, MODEL_DEBOUNCE_MS)
        return () => {
          window.clearTimeout(timer)
          // 卸载 / 升级（HMR 会销毁组件）时别把请求留在网络上；
          // 下一次 effect 会按新文本重新发。
          if (inflightRef.current !== null) {
            try { inflightRef.current.abort() } catch { /* ignore */ }
            inflightRef.current = null
          }
        }
      }, [draft, prefs.enabled, prefs.model, prefs.fluency, prefs.sensitivity, modelVersion])

      React.useEffect(() => {
        const invalidate = () => {
          if (inflightRef.current) inflightRef.current.abort()
          modelCacheRef.current.clear()
          modelRef.current = { text: '', issues: [] }
          requestedRef.current = ''
          setModelVersion(value => value + 1)
        }
        modelChangeListeners.add(invalidate)
        return () => modelChangeListeners.delete(invalidate)
      }, [])

      // Short drafts: check and measure synchronously, in the very paint that
      // changed the text. This is the whole latency budget.
      React.useLayoutEffect(() => {
        if (typeof draft === 'string' && draft.length <= LONG_TEXT_THRESHOLD) refresh()
      }, [refresh, draft])

      // Long drafts (a pasted document): same pass, but after the typing burst.
      React.useEffect(() => {
        if (typeof draft !== 'string' || draft.length <= LONG_TEXT_THRESHOLD) return undefined
        const timer = window.setTimeout(refresh, LONG_TEXT_DEBOUNCE_MS)
        return () => window.clearTimeout(timer)
      }, [refresh, draft])

      // Scroll and resize only move the marks: coalesce to one pass per frame.
      React.useEffect(() => {
        let frame = 0
        const schedule = () => {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(() => { frame = 0; refresh() })
        }
        const scroller = document.querySelector('[data-input-scroll]')
        window.addEventListener('resize', schedule)
        window.addEventListener('scroll', schedule, true)
        scroller?.addEventListener('scroll', schedule, { passive: true })
        // An IME commit may not change the draft text (the attribute was the
        // only difference), so re-measure when composition ends.
        document.addEventListener('compositionend', schedule, true)
        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame)
          window.removeEventListener('resize', schedule)
          window.removeEventListener('scroll', schedule, true)
          scroller?.removeEventListener('scroll', schedule)
          document.removeEventListener('compositionend', schedule, true)
        }
      }, [refresh])

      React.useEffect(() => () => window.clearTimeout(hideTimer.current), [])

      const showNow = React.useCallback((index, anchor) => {
        window.clearTimeout(hideTimer.current)
        setActive({ index, anchor })
      }, [])

      const hideSoon = React.useCallback(() => {
        window.clearTimeout(hideTimer.current)
        hideTimer.current = window.setTimeout(() => setActive(null), HIDE_DELAY_MS)
      }, [])

      /**
       * 悬停判定走 document 的 mousemove，而不是给标记加 pointerEvents。
       *
       * 波浪线只有 3px 高，指上去很难命中；但把热区放大到整个字，就会挡住点击——
       * 用户想在错字前面放光标时会点不动。所以热区只存在于这张表里，
       * 页面上不占任何可点击面积，点击照常落到编辑器。
       */
      const hitRef = React.useRef([])
      React.useEffect(() => {
        if (view === null) return undefined
        hitRef.current = view.marks
        let frame = 0
        let pointerX = 0
        let pointerY = 0

        /**
         * 指针是不是在气泡上——**直接量它的矩形，不记状态**。
         *
         * 之前用了一个 `overBubble` 布尔标记，在气泡的 mouseenter 置位、mouseleave 复位。
         * 但点「忽略」/「替换」是把气泡卸载掉的，浏览器不会补发 mouseleave，
         * 标记就永远停在 true，之后每个 mousemove 都在第一行返回——
         * 表现就是"点过一次按钮，整段文字再也不弹气泡"。
         * 量矩形没有状态可残留。
         */
        const overBubble = (x, y) => {
          const element = document.querySelector('[data-zh-typo-bubble]')
          if (element === null) return false
          const rect = element.getBoundingClientRect()
          return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
        }

        const measure = () => {
          frame = 0
          const x = pointerX
          const y = pointerY
          if (overBubble(x, y)) return
          let hit = -1
          for (let i = 0; i < hitRef.current.length; i += 1) {
            const mark = hitRef.current[i]
            // 上下各放宽 3px：字的上沿和下沿都不该要求精确
            if (x < mark.left - 2 || x > mark.left + mark.width + 2) continue
            if (y < mark.top - 3 || y > mark.top + mark.height + 3) continue
            hit = i
            break
          }
          if (hit === -1) hideSoon()
          else if (active === null || active.index !== hitRef.current[hit].index) {
            showNow(hitRef.current[hit].index, hitRef.current[hit])
          }
        }

        const onMove = (event) => {
          pointerX = event.clientX
          pointerY = event.clientY
          if (frame !== 0) return
          frame = window.requestAnimationFrame(measure)
        }
        const onLeave = () => hideSoon()

        document.addEventListener('mousemove', onMove, { passive: true })
        document.addEventListener('mouseleave', onLeave)
        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame)
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseleave', onLeave)
        }
      }, [view, active, showNow, hideSoon])

      const applyFix = React.useCallback((issue) => {
        if (view === null) return
        const span = { start: issue.start, end: issue.end, draftRev: view.rev }
        const accepted = inputActions !== undefined && inputActions.insertText(issue.suggestions[0], span)
        setActive(null)
        if (!accepted) refresh()
      }, [view, inputActions, refresh])

      const ignore = React.useCallback((issue) => {
        ignoredRef.current.add(ignoreKey(issue))
        if (issue.kind !== 'punct' && issue.kind !== 'fluency') saveIgnored(ignoredRef.current)
        setActive(null)
        bumpIgnored()
      }, [])

      if (view === null) return null

      const issueOf = (index) => view.issues[index]
      const activeIssue = active === null ? null : issueOf(active.index)

      const layer = React.createElement('div', {
        'data-zh-typo-layer': '',
        style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 900 },
      }, [
        ...view.marks.map((mark, position) => React.createElement('div', {
          key: 'u' + position,
          'data-zh-typo-mark': '',
          style: {
            position: 'fixed',
            left: mark.left + 'px',
            top: ((mark.sentence === true ? mark.line : mark.top + mark.height) - 3) + 'px',
            width: mark.width + 'px',
            height: '3px',
            backgroundImage: mark.sentence === true ? 'none' : view.wave,
            borderBottom: mark.sentence === true ? '2px dashed rgba(37, 99, 235, 0.55)' : 'none',
            backgroundRepeat: 'repeat-x',
            backgroundPosition: 'left bottom',
            // 纯装饰：命中判定由 document 的 mousemove 做，这里不接收任何指针事件
            pointerEvents: 'none',
          },
        })),
        activeIssue === null ? null : activeIssue.sentence === true ? sentenceBubble(active, t, {
          onIgnore: () => ignore(activeIssue),
          onEnter: () => window.clearTimeout(hideTimer.current),
          onLeave: hideSoon,
        }) : bubble(active, activeIssue, t, {
          onApply: () => applyFix(activeIssue),
          onIgnore: () => ignore(activeIssue),
          // 指针进气泡时先别关；真要不要关由 measure 量矩形决定
          onEnter: () => window.clearTimeout(hideTimer.current),
          onLeave: hideSoon,
        }),
      ])

      return ReactDOM.createPortal(layer, document.body)
    }

    /** The suggestion bubble, placed above the marked text unless it would clip. */
    function bubble(active, issue, t, handlers) {
      const anchor = active.anchor
      const width = 240
      const center = anchor.left + anchor.width / 2
      const left = Math.min(Math.max(8, center - width / 2), window.innerWidth - width - 8)
      const above = anchor.top > 96
      const top = above ? anchor.top - 10 : anchor.top + anchor.height + 10

      return React.createElement('div', {
        key: 'bubble',
        'data-zh-typo-bubble': '',
        style: {
          position: 'fixed',
          left: left + 'px',
          top: top + 'px',
          transform: above ? 'translateY(-100%)' : 'none',
          width: width + 'px',
          boxSizing: 'border-box',
          pointerEvents: 'auto',
          // 白底 + 固定色值：气泡浮在正文之上，背景跟着主题变会让字色和底色打架，
          // 白底配深字在任何主题下都稳。
          background: '#ffffff',
          color: '#1f2329',
          border: '1px solid rgba(0,0,0,0.08)',
          borderRadius: '10px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          padding: '10px 12px',
          font: '13px/1.5 var(--dsw-font-family)',
        },
        onMouseEnter: handlers.onEnter,
        onMouseLeave: handlers.onLeave,
      }, [
        React.createElement('div', {
          key: 'body',
          style: { marginBottom: '8px', display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' },
        }, [
          React.createElement('span', {
            key: 'wrong',
            style: {
              color: '#d93026',
              textDecoration: 'line-through',
              textDecorationThickness: '1px',
            },
          }, issue.text),
          React.createElement('span', { key: 'arrow', style: { color: '#8f959e' } }, '→'),
          React.createElement('span', {
            key: 'right',
            style: { color: '#1a7f37', fontWeight: 600 },
          }, issue.suggestions[0]),
        ]),
        React.createElement('div', {
          key: 'actions',
          style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
        }, [
          React.createElement('button', {
            key: 'ignore',
            type: 'button',
            onMouseDown: (event) => event.preventDefault(),
            onClick: handlers.onIgnore,
            style: bubbleButtonStyle(false),
          }, t('ignore')),
          React.createElement('button', {
            key: 'apply',
            type: 'button',
            onMouseDown: (event) => event.preventDefault(),
            onClick: handlers.onApply,
            style: bubbleButtonStyle(true),
          }, t('replace')),
        ]),
      ])
    }

    /** 气泡里的按钮跟着白底走，不复用主题色，免得又出现底色和字色打架。 */
    /**
     * 整句提示的气泡：没有"换成什么字"，只有解释和忽略。
     * 与逐字气泡分开写，避免在同一个函数里堆两套完全不同的内容。
     */
    function sentenceBubble(active, t, handlers) {
      const anchor = active.anchor
      // 只有一句短话，宽度按内容给，别让气泡空一大片
      const width = 168
      const center = anchor.left + anchor.width / 2
      const left = Math.min(Math.max(8, center - width / 2), window.innerWidth - width - 8)
      const above = anchor.top > 96
      const top = above ? anchor.top - 10 : anchor.top + anchor.height + 10
      return React.createElement('div', {
        key: 'sentence-bubble',
        'data-zh-typo-bubble': '',
        style: {
          position: 'fixed',
          left: left + 'px',
          top: top + 'px',
          transform: above ? 'translateY(-100%)' : 'none',
          width: width + 'px',
          boxSizing: 'border-box',
          pointerEvents: 'auto',
          background: '#ffffff',
          color: '#1f2329',
          border: '1px solid rgba(0,0,0,0.08)',
          borderRadius: '10px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          padding: '10px 12px',
          font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        },
        onMouseEnter: handlers.onEnter,
        onMouseLeave: handlers.onLeave,
      }, [
        React.createElement('div', {
          key: 'body',
          style: { marginBottom: '8px' },
        }, t('fluencyBody')),
        React.createElement('div', {
          key: 'actions',
          style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
        }, [
          React.createElement('button', {
            key: 'ignore',
            type: 'button',
            onMouseDown: (event) => event.preventDefault(),
            onClick: handlers.onIgnore,
            style: bubbleButtonStyle(false),
          }, t('ignore')),
        ]),
      ])
    }
    function bubbleButtonStyle(primary) {
      return {
        appearance: 'none',
        border: primary ? 'none' : '1px solid #d0d3d6',
        background: primary ? '#1f2329' : '#ffffff',
        color: primary ? '#ffffff' : '#1f2329',
        borderRadius: '7px',
        padding: '4px 14px',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }
    }

    function buttonStyle(primary) {
      return {
        appearance: 'none',
        border: primary ? 'none' : '1px solid var(--dsw-alias-border-l2)',
        background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: primary ? '#fff' : 'var(--dsw-alias-label-secondary)',
        borderRadius: '7px',
        padding: '4px 12px',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }
    }

    const MODEL_ENDPOINT = '/zh-typo-model/'

    function formatBytes(bytes) {
      if (!bytes) return ''
      if (bytes < 1000000) return (bytes / 1000).toFixed(0) + ' KB'
      return (bytes / 1000000).toFixed(1) + ' MB'
    }

    /**
     * 设置页：模型的下载、校验与删除。
     *
     * 状态完全来自宿主侧的服务，页面本身不缓存任何东西——所以关掉设置页再打开、
     * 或者换一个浏览器，看到的都是同一份真相。
     */
    /** 设置页里的一行：左标题+说明，右侧控件。 */
    /** 自定义下载地址的合法性：只接受 http(s)，与服务端的判断保持一致。 */
    function isValidBase(value) {
      if (typeof value !== 'string' || value.trim() === '') return false
      try {
        const url = new URL(value.trim())
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch (_error) {
        return false
      }
    }

    /** 固定控件宽度，让长说明换行，不把按钮挤成逐字竖排。 */
    function prefRow(key, label, hint, control) {
      return React.createElement('div', { key, className: 'zh-check-pref' }, [
        React.createElement('div', { key: 'text', className: 'zh-check-copy' }, [
          React.createElement('span', { key: 'label', className: 'zh-check-label' }, label),
          hint ? React.createElement('span', { key: 'hint', className: 'zh-check-muted' }, hint) : null,
        ]),
        control,
      ])
    }

    function toggleControl(t, checked, onToggle, label) {
      return React.createElement('button', {
        type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label,
        onClick: onToggle, className: 'zh-check-toggle', style: buttonStyle(checked),
      }, checked ? t('on') : t('off'))
    }

    function segmentStyle(active) {
      return { ...buttonStyle(active), padding: '4px 10px', flex: '1 0 auto', whiteSpace: 'nowrap' }
    }

    const SETTINGS_CSS = `
      [data-zh-typo-settings] { container-type: inline-size; width: 100%; min-width: 0; }
      [data-zh-typo-settings] * { box-sizing: border-box; }
      .zh-check-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
        padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); min-width: 0; }
      .zh-check-pref, .zh-check-header, .zh-check-status { display: flex; align-items: center; gap: 12px; }
      .zh-check-pref { padding: 8px 0; }
      .zh-check-copy { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
      .zh-check-label { font-size: 13px; color: var(--dsw-alias-label-primary); line-height: 20px; }
      .zh-check-muted { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 18px; }
      .zh-check-toggle { flex: 0 0 auto; min-width: 48px; white-space: nowrap; }
      .zh-check-header { justify-content: space-between; }
      .zh-check-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
      .zh-check-badge { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap;
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: 0 5px; }
      .zh-check-status { justify-content: space-between; min-height: 30px; margin-top: 8px; }
      .zh-check-meta { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; min-width: 0; }
      .zh-check-meta > span { white-space: nowrap; }
      .zh-check-actions { display: flex; flex: 0 0 auto; gap: 6px; }
      .zh-check-actions button { white-space: nowrap; }
      .zh-check-advanced { margin-top: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .zh-check-advanced > summary { cursor: pointer; width: fit-content; padding: 4px 0; }
      .zh-check-advanced[open] > summary { margin-bottom: 8px; }
      .zh-check-field { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(160px, 260px);
        align-items: center; gap: 8px 12px; margin-top: 10px; }
      .zh-check-select, .zh-check-url { min-width: 0; width: 100%; font: inherit; font-size: 12px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; padding: 6px 10px;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
      .zh-check-segments { display: flex; gap: 4px; }
      .zh-check-url-row { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; }
      .zh-check-error { font-size: 12px; line-height: 18px; overflow-wrap: anywhere;
        color: var(--dsw-alias-state-error-primary); margin-top: 6px; }
      .zh-check-progress { width: 100%; height: 6px; margin-top: 8px; }
      [data-zh-typo-settings] button:focus-visible, [data-zh-typo-settings] summary:focus-visible,
      [data-zh-typo-settings] input:focus-visible, [data-zh-typo-settings] select:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px;
      }
      @container (max-width: 420px) {
        .zh-check-field { grid-template-columns: minmax(0, 1fr); }
        .zh-check-card { padding: 12px; }
        .zh-check-segments > button { padding: 4px 8px !important; }
      }
    `

    function trashIcon() {
      return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
      React.createElement('path', { d: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7' }))
    }

    /** 保存失败用短暂提示反馈；输入框自己保留未提交草稿。 */
    function SettingsSaveNotice({ error, t }) {
      const [visible, setVisible] = React.useState(false)
      React.useEffect(() => {
        setVisible(error?.code === 'write-failed')
        const timer = window.setTimeout(() => setVisible(false), 4000)
        return () => window.clearTimeout(timer)
      }, [error])
      return visible ? React.createElement('div', { role: 'alert', title: error?.message,
        style: { position: 'fixed', bottom: '24px', right: '24px', zIndex: 2000, padding: '10px 14px',
          maxWidth: 'calc(100vw - 48px)', borderRadius: '8px', boxShadow: '0 4px 16px #0002',
          fontSize: '13px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-state-error-primary)',
          pointerEvents: 'none' },
      }, t('settingsSaveFailed')) : null
    }

    /** 两套模型共用同一张状态卡，来源和操作始终只作用于本卡。 */
    function ModelCard({ t, prefs, sentence }) {
      const [status, setStatus] = React.useState(null)
      const [pollError, setPollError] = React.useState(null)
      const [actionError, setActionError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [tick, setTick] = React.useState(0)
      const observed = React.useRef('')
      const settle = React.useRef(0)
      const settingsError = useSettingsError()
      const sourceKey = sentence ? 'sentenceSource' : 'source'
      const baseKey = sentence ? 'sentenceCustomBase' : 'customBase'
      const enabledKey = sentence ? 'fluency' : 'model'
      const label = t(sentence ? 'optFluencyLabel' : 'optModelLabel')
      const endpoint = MODEL_ENDPOINT + (sentence ? 'semantic/' : '')
      const id = React.useId()
      const [baseDraft, setBaseDraft] = React.useState(prefs[baseKey])
      const baseRef = React.useRef(baseDraft)
      const focused = React.useRef(false)
      baseRef.current = baseDraft
      React.useEffect(() => {
        const failed = settingsError?.code === 'write-failed' && settingsError.fields.includes(baseKey)
        if (!shouldKeepDraft(baseRef.current, prefs[baseKey], { focused: focused.current, failed })) setBaseDraft(prefs[baseKey])
      }, [prefs[baseKey], settingsError, baseKey])
      const commitBase = () => {
        const value = baseRef.current.trim()
        if (value !== configSettings.get()[baseKey]) settingsStore.set({ [baseKey]: value })
      }
      React.useEffect(() => {
        let alive = true, timer, failures = 0
        const poll = async () => {
          try {
            const response = await fetch(endpoint + 'status', { cache: 'no-store' })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const next = await response.json()
            if (!alive) return
            setStatus(next); setPollError(null); failures = 0
            const key = [next.state, next.revision, next.bytes, next.runtime].join(':')
            if (observed.current !== key) { observed.current = key; modelsChanged() }
            if (next.state === 'downloading' || next.state === 'verifying' || Date.now() < settle.current) {
              timer = window.setTimeout(poll, 400)
            }
          } catch (failure) {
            if (!alive) return
            setPollError(failure.message)
            failures += 1
            // 短暂的进程重启/503 不应把下载进度永久冻结。限次后保留手动刷新。
            if (failures <= 3) timer = window.setTimeout(poll, 1000 * 2 ** (failures - 1))
          }
        }
        void poll()
        return () => { alive = false; window.clearTimeout(timer) }
      }, [tick, endpoint])
      const act = async (action) => {
        setBusy(true); setActionError(null); settle.current = Date.now() + 5000
        try {
          let url = endpoint + action
          if (action === 'download') {
            const source = configSettings.get()[sourceKey]
            const query = new URLSearchParams()
            if (!sentence) query.set('source', source)
            if (source === 'custom') query.set('base', baseRef.current.trim())
            if (query.size > 0) url += '?' + query
          }
          const response = await fetch(url, { cache: 'no-store' })
          const next = await response.json()
          if (!response.ok) throw new Error(next.error || 'HTTP ' + response.status)
          setStatus(next); modelsChanged()
        } catch (failure) { setActionError(failure.message) }
        finally { setBusy(false); setTick(value => value + 1) }
      }
      const state = status?.state ?? 'unknown'
      const downloading = state === 'downloading' || state === 'verifying'
      const runtimeMissing = state === 'ready' && status.runtime === false
      const progress = status?.total > 0 ? Math.min(1, status.bytes / status.total) : 0
      const stateText = pollError ? t('stateUnavailable') : runtimeMissing ? t('semanticRuntime') : state === 'ready'
        ? !prefs.enabled ? t('semanticGlobalOff') : prefs[enabledKey] ? t('semanticReady') : t('semanticDisabled')
        : state === 'verifying' ? t('stateVerifying') : state === 'downloading'
          ? format(t('stateDownloading'), { percent: Math.round(100 * progress) })
          : state === 'partial' ? t('statePartial') : state === 'error' ? t('stateFailed')
            : state === 'unknown' ? pollError ? t('stateUnavailable') : t('stateChecking') : t('stateAbsent')
      const valid = isValidBase(baseDraft)
      const saveFailed = settingsError?.code === 'write-failed' && settingsError.fields.includes(baseKey)
      const removeLabel = t(sentence ? 'semanticRemove' : 'typoRemove')
      const error = actionError || pollError || (state === 'error' ? status?.error : null)
      return React.createElement('section', {
        'data-zh-model': sentence ? 'sentence' : 'typo', 'aria-label': label, className: 'zh-check-card',
      }, [
        React.createElement('div', { key: 'header', className: 'zh-check-header' }, [
          React.createElement('div', { key: 'title', className: 'zh-check-title' }, [
            React.createElement('span', { key: 'label', className: 'zh-check-label', style: { fontWeight: 500 } }, label),
            !sentence ? React.createElement('span', { key: 'optional', className: 'zh-check-badge' }, t('optional')) : null,
          ]),
          toggleControl(t, prefs[enabledKey], () => settingsStore.set({ [enabledKey]: !prefs[enabledKey] }), label),
        ]),
        React.createElement('div', { key: 'hint', className: 'zh-check-muted', style: { marginTop: '4px' } }, t(sentence ? 'optFluencyHint' : 'optModelHint')),
        React.createElement('div', { key: 'status', className: 'zh-check-status' }, [
          React.createElement('div', { key: 'meta', className: 'zh-check-meta zh-check-muted', role: 'status', 'aria-live': 'polite' }, [
            React.createElement('span', { key: 'state' }, stateText),
            React.createElement('span', { key: 'size' }, state === 'ready' ? formatBytes(status.bytes) : t(sentence ? 'sentenceSize' : 'typoSize')),
          ]),
          React.createElement('div', { key: 'actions', className: 'zh-check-actions' }, [
            pollError ? React.createElement('button', { key: 'refresh', type: 'button', title: t('refreshStatus'),
              'aria-label': t('refreshStatus'), onClick: () => setTick(value => value + 1), style: buttonStyle(false) },
            React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
              React.createElement('path', { d: 'M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 13.3 3.4M17.9 17.9A8 8 0 0 1 4.6 14.5' }))) : null,
            ['absent', 'error', 'partial'].includes(state) ? React.createElement('button', {
              key: 'download', type: 'button', disabled: busy || (prefs[sourceKey] === 'custom' && !valid),
              onClick: () => act('download'), style: buttonStyle(true),
            }, t(state === 'partial' ? 'resume' : state === 'error' ? 'semanticRetry' : 'download')) : null,
            downloading ? React.createElement('button', { key: 'cancel', type: 'button', disabled: busy,
              onClick: () => act('cancel'), style: buttonStyle(false) }, t('cancel')) : null,
            state === 'ready' ? React.createElement('button', { key: 'remove', type: 'button', disabled: busy,
              title: removeLabel, 'aria-label': removeLabel, onClick: () => act('delete'), style: buttonStyle(false) }, trashIcon()) : null,
          ]),
        ]),
        downloading && !pollError ? React.createElement('progress', { key: 'progress', className: 'zh-check-progress',
          value: state === 'verifying' ? undefined : status.bytes, max: status.total || 1, 'aria-label': label }) : null,
        error || runtimeMissing ? React.createElement('div', { key: 'error', role: 'alert', className: 'zh-check-error' }, error || t('semanticRuntime')) : null,
        React.createElement('details', { key: 'advanced', className: 'zh-check-advanced' }, [
          React.createElement('summary', { key: 'summary' }, t(sentence ? 'downloadSettings' : 'moreSettings')),
          !sentence ? React.createElement('div', { key: 'sensitivity', className: 'zh-check-field' }, [
            React.createElement('span', { key: 'label', id: id + '-sensitivity', title: t('optSensitivityHint') }, t('optSensitivityLabel')),
            React.createElement('div', { key: 'segments', className: 'zh-check-segments', role: 'group', 'aria-labelledby': id + '-sensitivity' },
              ['low', 'normal', 'high'].map(level => React.createElement('button', { key: level, type: 'button',
                'aria-pressed': prefs.sensitivity === level, onClick: () => settingsStore.set({ sensitivity: level }),
                style: segmentStyle(prefs.sensitivity === level) }, t(level === 'low' ? 'sensLow' : level === 'high' ? 'sensHigh' : 'sensNormal')))),
          ]) : null,
          React.createElement('div', { key: 'source', className: 'zh-check-field' }, [
            React.createElement('label', { key: 'label', htmlFor: id + '-source' }, t('optSourceLabel')),
            React.createElement('select', { key: 'select', id: id + '-source', className: 'zh-check-select', value: prefs[sourceKey],
              onChange: event => settingsStore.set({ [sourceKey]: event.target.value }) },
            (sentence ? ['official', 'custom'] : ['auto', 'mirror', 'official', 'custom']).map(value => React.createElement('option', { key: value, value },
              t(value === 'auto' ? 'sourceAuto' : value === 'mirror' ? 'sourceMirror' : value === 'official' ? sentence ? 'sourceGitHub' : 'sourceOfficial' : 'sourceCustom')))),
          ]),
          prefs[sourceKey] === 'custom' ? React.createElement('div', { key: 'base', className: 'zh-check-url-row' }, [
            React.createElement('label', { key: 'label', htmlFor: id + '-base' }, t('customBaseLabel')),
            React.createElement('input', { key: 'input', id: id + '-base', type: 'url', spellCheck: false,
              className: 'zh-check-url', placeholder: t(sentence ? 'sentencePlaceholder' : 'customPlaceholder'), value: baseDraft,
              'aria-invalid': !valid || saveFailed, 'aria-describedby': !valid ? id + '-invalid' : undefined,
              onChange: event => setBaseDraft(event.target.value), onFocus: () => { focused.current = true },
              onBlur: () => { focused.current = false; commitBase() },
              onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } },
            }),
            !valid ? React.createElement('span', { key: 'invalid', id: id + '-invalid', className: 'zh-check-error' }, t('customInvalid')) : null,
          ]) : null,
        ]),
      ])
    }

    /** 设置页和插件详情页共用；全局开关、独立模型卡和可选增强各出现一次。 */
    function ZhTypoPanel(props) {
      const t = typeof props.t === 'function' ? props.t : boundT
      const prefs = useSettings()
      const settingsError = useSettingsError()
      const lastCheck = useCheckLog()
      return React.createElement('div', {
        'data-zh-typo-settings': '', style: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '620px' },
      }, [
        React.createElement('style', { key: 'style' }, SETTINGS_CSS),
        props.head === true ? React.createElement('div', { key: 'title', className: 'zh-check-label', style: { fontSize: '15px', fontWeight: 600 } }, t('title')) : null,
        prefRow('enabled', t('optEnabledLabel'), null, toggleControl(t, prefs.enabled,
          () => settingsStore.set({ enabled: !prefs.enabled }), t('optEnabledLabel'))),
        React.createElement(ModelCard, { key: 'sentence', t, prefs, sentence: true }),
        prefRow('punctuation', t('optPunctLabel'), null, toggleControl(t, prefs.punctuation,
          () => settingsStore.set({ punctuation: !prefs.punctuation }), t('optPunctLabel'))),
        React.createElement(ModelCard, { key: 'typo', t, prefs, sentence: false }),
        React.createElement(SettingsSaveNotice, { key: 'save-notice', error: settingsError, t }),
        settingsError?.code === 'namespace-unavailable' ? React.createElement('div', { key: 'error', role: 'status', className: 'zh-check-error' },
          t('settingsNamespaceUnavailable')) : null,
        lastCheck.at > 0 ? React.createElement('div', { key: 'last-check', className: 'zh-check-muted', title: lastCheck.detail || undefined },
          format(t('lastCheck'), { typo: lastCheck.typo === 'Ready' ? String(lastCheck.issues) : t('sentence' + (lastCheck.typo || 'Unavailable')),
            sentence: t('sentence' + (lastCheck.sentence || 'Unavailable')), ms: lastCheck.ms })) : null,
      ])
    }


    /**
     * 注册期要用的翻译函数：`bind` 返回稳定引用，但调用时才读当前语言，
     * 所以设置页的导航标题能跟着语言切换走。
     */
    let boundT = (key) => key

    function ZhTypoSection(props) {
      return React.createElement(ZhTypoPanel, { ...props, head: true })
    }

    /**
     * 详情页拿到的 subject 形状没有公开类型，所以按"整份 subject 里是否提到本插件"
     * 来判定；拿不准就渲染 null——槽位的契约就是"没内容就返回 null"。
     */
    function subjectMatchesPlugin(subject) {
      if (subject === null || typeof subject !== 'object') return false
      const direct = [
        subject.packageName, subject.name, subject.id, subject.entryId,
        subject.row?.name, subject.row?.entryId,
        subject.bundle?.packageName, subject.manifest?.name,
      ]
      if (direct.some((value) => typeof value === 'string' && value.includes('zh-typo-check'))) return true
      try {
        return JSON.stringify(subject).includes('zh-typo-check')
      } catch (_error) {
        return false
      }
    }

    /** 插件详情页里的「检查设置」区块：画自己的小标题，别重复页面已有的插件名。 */
    function ZhTypoDetailSection(props) {
      if (!subjectMatchesPlugin(props.subject)) return null
      return React.createElement('div', {
        'data-zh-typo-detail': '',
        style: { marginTop: '28px', display: 'flex', flexDirection: 'column', gap: '12px' },
      }, [
        React.createElement('div', {
          key: 'title',
          style: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
        }, boundT('options')),
        React.createElement(ZhTypoPanel, { ...props, head: false, key: 'panel' }),
      ])
    }

    /**
     * 把设置桥接到 Host 的插件配置（configForms）。
     *
     * 这是可选用途：旧版 DSH 没有 configForms 时，插件不能因此整个不加载——
     * 桥接不上就退回 localStorage，行为与旧版一致（只是仍会随 origin 丢失）。
     */
    function attachPersistedSettings(ctx, log) {
      try {
        ctx.inject(['configForms'], (scope) => {
          scope.effect(() => {
            let form = null
            try {
              form = scope.configForms.get(CONFIG_NAMESPACE)
            } catch (error) {
              log('settings bridge failed: ' + (error instanceof Error ? error.message : String(error)))
              return () => {}
            }
            const attached = configSettings.attach(form)
            log('settings bridge ' + (attached ? 'attached to ' + CONFIG_NAMESPACE : 'unavailable'))
            return () => {
              configSettings.detach()
              log('settings bridge detached')
            }
          }, 'zh-typo-check: persisted settings')
        })
      } catch (error) {
        log('settings bridge setup failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const beacon = (message) => {
          try { void fetch('/zh-typo-model/log?msg=' + encodeURIComponent(message)).catch(() => {}) } catch { /* ignore */ }
        }
        try {
          ctx.effect(() => ctx.locale.register(NS, STRINGS), 'zh-typo-check: dictionaries')
          boundT = ctx.locale.bind(NS)
          ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
            name: 'conversation.input.overlay',
            id: 'zh-typo-check',
            order: 10,
            locale: NS,
          }, TypoLayer))
          ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
            name: 'settings.plugins.tab',
            id: 'zh-typo-check',
            order: 20,
            label: () => boundT('title'),
          }, ZhTypoSection))
          ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
            name: 'plugins.detail.section',
            id: 'zh-typo-check',
            order: 30,
            label: () => boundT('options'),
          }, ZhTypoDetailSection))
          // 设置持久化：Host 的 plugin Config 在 profile patch 里，跨重启/升级保留
          attachPersistedSettings(ctx, beacon)
          beacon('apply done: 3 slots registered; settings bridge requested')
        } catch (error) {
          beacon('apply failed: ' + (error instanceof Error ? error.message : String(error)))
          throw error
        }
      },
    }
  },
})
