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

    /** 校验阶段的滑动条动画（React 内联样式没法写 @keyframes，用一段全局样式）。 */
    const ANIMATION_CSS = 
      '@keyframes zh-typo-indeterminate {'
      + ' 0% { margin-left: -30%; } 100% { margin-left: 100%; }'
      + '}'

    const STRINGS = {
      zh: {
        title: '中文检查',
        replace: '替换',
        ignore: '忽略',
    fluencyBody: '这句话读起来不太通顺。模型对整句的把握偏低，可能有表达或语病问题——这只是提示，不做替换。',
    optFluencyLabel: '整句通顺度（实验）',
    optFluencyHint: '没有具体错字、但整句读起来别扭时提醒一句。专业术语和人名可能误报。',

        sectionIntro: '在输入框里标出中文错别字和半角标点。本地规则永远可用；装上模型后，语义层面的误判也会被挡掉。',
        options: '检查设置',
        on: '开',
        off: '关',
        optEnabledLabel: '启用检查',
        optEnabledHint: '关掉之后输入框完全不受影响。',
        optPunctLabel: '检查半角标点',
        optPunctHint: '把 , ? ; 这类半角标点标出来。',
        optModelLabel: '使用模型',
        optModelHint: '需要先下载模型。关掉只跑规则，仍然立刻响应。',
        optSensitivityLabel: '模型灵敏度',
        optSensitivityHint: '激进会多报，保守会少报。',
        sensLow: '保守',
        sensNormal: '标准',
        sensHigh: '激进',
        optSourceLabel: '下载来源',
        optSourceHint: '自动会先探测哪条线路通，再决定顺序。',
        sourceAuto: '自动',
        sourceMirror: '国内镜像',
        sourceOfficial: '官方',
        sourceCustom: '自定义',
        customPlaceholder: 'https://你的镜像/…/macbert4csc-base-chinese/resolve/main',
        customInvalid: '地址需要以 http:// 或 https:// 开头',
        model: '本地模型',
        stateAbsent: '未安装',
        stateDownloading: '下载中 {percent}%',
        stateVerifying: '校验中',
        statePartial: '下载未完成',
        resume: '继续下载',
        downloadingFile: '{file}（{index}/{count}）· {percent}%',
        partialDetail: '已下载 {size}，还差一部分',
        actionFailed: '操作失败：{error}',
        lastCheck: '上次模型检查：{state} · 命中 {issues} 处 · {ms} ms',
        lastCheckIdle: '上次模型检查：还没有跑过（在输入框里打一句话试试）',
        stateReady: '已就绪',
        stateError: '出错：{error}',
        stateChecking: '检查中…',
        stateUnavailable: '宿主服务不可用',
        cancel: '取消',
        remove: '删除',
        reDownload: '重新下载',
        download: '下载模型',
        noteReady: '模型只在本机运行，输入内容不会上传。删除后自动退回纯规则检查。',
        noteAbsent: '首次需要下载约 103 MB，支持国内镜像。未安装时只做规则检查，输入框照常可用。',
        runtimeMissing: '推理运行时缺失（onnxruntime-node 未安装），模型暂时无法加载。这只影响语义检查，规则检查照常工作。',
        hostUnavailable: '宿主服务不可用（{error}）。若刚更新过插件，重启 DSH 后生效。',
      },
      en: {
        title: 'Chinese check',
        replace: 'Replace',
        ignore: 'Ignore',
    fluencyBody: 'This sentence reads awkwardly. The model is unsure about the whole line — a hint only, nothing is replaced.',
    optFluencyLabel: 'Sentence fluency (experimental)',
    optFluencyHint: 'A one-line note when the whole sentence reads oddly even though no single character is wrong. Jargon and names may trigger it.',

        sectionIntro: 'Flags Chinese typos and half-width punctuation in the composer. The rule engine always works; with the model installed, semantic mistakes are caught too.',
        options: 'Checking options',
        on: 'On',
        off: 'Off',
        optEnabledLabel: 'Enable checking',
        optEnabledHint: 'Turn off to leave the composer completely untouched.',
        optPunctLabel: 'Check half-width punctuation',
        optPunctHint: 'Flags ASCII , ? ; and friends.',
        optModelLabel: 'Use the model',
        optModelHint: 'Requires the model download. Without it, rules only, still instant.',
        optSensitivityLabel: 'Model sensitivity',
        optSensitivityHint: 'Aggressive flags more; conservative flags less.',
        sensLow: 'Conservative',
        sensNormal: 'Normal',
        sensHigh: 'Aggressive',
        optSourceLabel: 'Download source',
        optSourceHint: 'Auto probes which line works first, then decides the order.',
        sourceAuto: 'Auto',
        sourceMirror: 'China mirror',
        sourceOfficial: 'Official',
        sourceCustom: 'Custom',
        customPlaceholder: 'https://your-mirror/…/macbert4csc-base-chinese/resolve/main',
        customInvalid: 'The address must start with http:// or https://',
        model: 'Local model',
        stateAbsent: 'Not installed',
        stateDownloading: 'Downloading {percent}%',
        stateVerifying: 'Verifying',
        statePartial: 'Download incomplete',
        resume: 'Resume download',
        downloadingFile: '{file} ({index}/{count}) · {percent}%',
        partialDetail: '{size} downloaded, the rest is missing',
        actionFailed: 'Action failed: {error}',
        lastCheck: 'Last model check: {state} · {issues} hit(s) · {ms} ms',
        lastCheckIdle: 'Last model check: none yet (type a sentence in the composer)',
        stateReady: 'Ready',
        stateError: 'Failed: {error}',
        stateChecking: 'Checking…',
        stateUnavailable: 'Host service unavailable',
        cancel: 'Cancel',
        remove: 'Remove',
        reDownload: 'Download again',
        download: 'Download model',
        noteReady: 'The model runs on this machine only; nothing you type is uploaded. Removing it falls back to rule-only checking.',
        noteAbsent: 'The first download is about 103 MB and supports mirrors. Without it, only rule-based checking runs; the composer stays fully usable.',
        runtimeMissing: 'The inference runtime (onnxruntime-node) is missing, so the model cannot load. Rule-based checking is unaffected.',
        hostUnavailable: 'Host service unavailable ({error}). If the plugin was just updated, restart DSH.',
      },
    }

    /** `t()` 只做查表，带变量的句子在这里填空，避免把整句拆成碎片拼接。 */
    function format(template, values) {
      if (typeof template !== 'string') return ''
      return template.replace(/\{(\w+)\}/g, (whole, key) => (values[key] === undefined ? whole : String(values[key])))
    }

    // ---- 用户偏好 ----
    const SETTINGS_KEY = 'dsh.zh-typo-check.settings'

    /** 灵敏度档位 → 模型层的 Δ 阈值。阈值越低越容易报，也越容易误报。 */
    const SENSITIVITY = {
      low: 15,
      normal: 12,
      high: 9,
    }

    const DEFAULT_SETTINGS = {
      enabled: true,
      punctuation: true,
      model: true,
      // 实验功能：整句通顺度提示（模型对原文每个字的平均把握偏低时提醒），默认关闭
      fluency: false,
      sensitivity: 'normal',
      source: 'auto',
      customBase: '',
    }

    function loadSettings() {
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY)
        const parsed = raw === null ? {} : JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS }
        return {
          enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_SETTINGS.enabled,
          punctuation: typeof parsed.punctuation === 'boolean' ? parsed.punctuation : DEFAULT_SETTINGS.punctuation,
          model: typeof parsed.model === 'boolean' ? parsed.model : DEFAULT_SETTINGS.model,
          sensitivity: Object.prototype.hasOwnProperty.call(SENSITIVITY, parsed.sensitivity)
            ? parsed.sensitivity
            : DEFAULT_SETTINGS.sensitivity,
          source: ['auto', 'mirror', 'official', 'custom'].includes(parsed.source)
            ? parsed.source
            : DEFAULT_SETTINGS.source,
          customBase: typeof parsed.customBase === 'string' ? parsed.customBase : DEFAULT_SETTINGS.customBase,
        }
      } catch (_error) {
        return { ...DEFAULT_SETTINGS }
      }
    }

    function saveSettings(value) {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(value))
      } catch (_error) { /* private mode: keep it in memory */ }
    }

    /**
     * 偏好存在模块级：输入框浮层和设置页是两个槽位里的组件，
     * 改一处要立刻影响另一处，靠这个小 store 打通。
     */
    const settingsStore = {
      value: null,
      listeners: new Set(),
      get() {
        if (this.value === null) this.value = loadSettings()
        return this.value
      },
      set(patch) {
        this.value = { ...this.get(), ...patch }
        saveSettings(this.value)
        for (const listener of this.listeners) listener(this.value)
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
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
      const [value, setValue] = React.useState(settingsStore.get())
      React.useEffect(() => settingsStore.subscribe(setValue), [])
      return value
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
    function computeView(draft, rev, found, ignored, wave, stamp, fluency) {
      if (typeof draft !== 'string' || draft === '') return null
      const root = document.querySelector('[data-composer-input]')
      if (root === null) return null
      // Never fight the IME: a composing draft is not yet what the user meant.
      if (root.hasAttribute('data-composer-composing') || root.closest('[data-composer-composing]') !== null) return null
      const issues = found.filter((issue) => !ignored.has(ignoreKey(issue)))
      // 没有任何具体错字时才提通顺度：两个提示叠在一起会互相抢注意力，
      // 而且错字是确定性的，优先给它。
      const sentenceLevel = issues.length === 0 && fluency !== null && fluency !== undefined
        && !ignored.has('fluency:' + draft)
      if (issues.length === 0 && !sentenceLevel) return null
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
            line: row.bottom,
            index: 0,
            sentence: true,
          })
        }
      } else {
        for (let i = 0; i < issues.length; i += 1) {
          if (issues[i].end > usable) continue
          for (const rect of rangeRects(index, issues[i].start, issues[i].end)) marks.push({ ...rect, index: i })
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
    function mergeModelIssues(base, modelIssues, text) {
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
          if (prefs.model) {
            const record = modelRef.current.text === text ? modelRef.current : modelCacheRef.current.get(text)
            if (record !== undefined) {
              fromModel = record.issues
              fromFluency = prefs.fluency && record.fluency?.low === true ? record.fluency : null
            }
          }
          const merged = mergeModelIssues(found, fromModel, text)
          next = computeView(text, draftRev, merged, ignoredRef.current, waveRef.current, ignoredRev + ':' + modelVersion, fromFluency)
        }
        setView((previous) => (sameView(previous, next) ? previous : next))
        setActive(null)
        // 偏好参与渲染结果，必须进依赖：关掉标点检查后要立刻生效
      }, [draft, draftRev, ignoredRev, modelVersion, prefs.enabled, prefs.punctuation, prefs.model, prefs.fluency])

      /**
       * 模型检查：停手 400 ms 后问一次宿主。
       *
       * 只在文本变过才发请求；宿主没装模型时返回得很快、issues 为空，
       * 所以"没装模型"这件事在这里不需要特判，也不会拖慢输入。
       */
      React.useEffect(() => {
        if (typeof draft !== 'string') return undefined
        if (!prefs.enabled || !prefs.model) return undefined
        if (draft.length < MODEL_MIN_CHARS || draft.length > MODEL_MAX_CHARS) return undefined
        // 灵敏度变了要重新问一次，所以缓存的文本里带上阈值
        const requestKey = draft + '|' + prefs.sensitivity
        if (requestedRef.current === requestKey) return undefined
        if (modelCacheRef.current.has(draft)) { requestedRef.current = requestKey; return undefined }
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
          fetch(url, { cache: 'no-store', signal: controller.signal })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
              const elapsed = Date.now() - startedAt
              const state = body === null ? 'HTTP 错误' : body.state
              const issues = body !== null && Array.isArray(body.issues) ? body.issues.length : 0
              const detail = body === null
                ? ''
                : [body.reason, body.chars !== undefined ? body.chars + ' 字' : '', body.aligned === false ? '分词未对齐' : '']
                  .filter((part) => typeof part === 'string' && part !== '').join(' · ')
              checkLogStore.set({ state, issues, ms: elapsed, at: Date.now(), detail: body?.error ? body.error : detail })
              if (body === null || body.state !== 'ready' || !Array.isArray(body.issues)) {
                // 这一次没成，下次文本再变还有机会——但不能把这句永久钉死成"查过了"。
                // 早先这里不重置，模型晚装好之后同一句话再也不会被查。
                requestedRef.current = ''
                return
              }
              const record = { text: draft, issues: body.issues, fluency: body.fluency ?? null }
              modelRef.current = record
              modelCacheRef.current.set(draft, record)
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
                ms: Date.now() - startedAt,
                at: Date.now(),
                detail: failure instanceof Error ? failure.message : String(failure),
              })
            })
        }, MODEL_DEBOUNCE_MS)
        return () => window.clearTimeout(timer)
      }, [draft, prefs.enabled, prefs.model, prefs.sensitivity])

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
      const width = 260
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
      if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB'
      return (bytes / 1048576).toFixed(1) + ' MB'
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

    function prefRow(key, label, hint, control) {
      return React.createElement('div', {
        key,
        style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0' },
      }, [
        React.createElement('div', { key: 'text', style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } }, [
          React.createElement('span', {
            key: 'label',
            style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
          }, label),
          React.createElement('span', {
            key: 'hint',
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
          }, hint),
        ]),
        React.createElement('div', { key: 'spacer', style: { flex: 1 } }),
        control,
      ])
    }

    function toggleControl(t, checked, onToggle) {
      return React.createElement('button', {
        type: 'button',
        onClick: onToggle,
        style: {
          appearance: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          minWidth: '52px',
          padding: '4px 12px',
          borderRadius: '999px',
          fontSize: '12px',
          lineHeight: '18px',
          border: checked ? 'none' : '1px solid var(--dsw-alias-border-l2)',
          background: checked ? 'var(--dsw-alias-brand-primary)' : 'transparent',
          color: checked ? '#ffffff' : 'var(--dsw-alias-label-secondary)',
        },
      }, checked ? t('on') : t('off'))
    }

    function segmentStyle(active) {
      return {
        appearance: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        padding: '4px 10px',
        borderRadius: '7px',
        fontSize: '12px',
        lineHeight: '18px',
        border: active ? 'none' : '1px solid var(--dsw-alias-border-l2)',
        background: active ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: active ? '#ffffff' : 'var(--dsw-alias-label-secondary)',
      }
    }

    /** 设置页与插件详情页共用的面板；head 控制要不要自己画标题。 */
    function ZhTypoPanel(props) {
      // 槽位没注入 t 时退回注册期绑定好的那个（同样是"调用时读当前语言"）
      const t = typeof props.t === 'function' ? props.t : boundT
      const prefs = useSettings()
      const [status, setStatus] = React.useState(null)
      // 两种错误分开：轮询失败说明服务不可用，动作失败说明这一次点击没成功。
      // 混在一起会被下一次成功的轮询立刻抹掉，用户就只看到"点了没反应"。
      const [pollError, setPollError] = React.useState(null)
      const [actionError, setActionError] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      const [busy, setBusy] = React.useState(false)
      const lastCheck = useCheckLog()
      /** 点过按钮之后的一段时间内继续轮询：宿主的下载可能还在探测线路，状态没翻过来。 */
      const settleRef = React.useRef(0)

      React.useEffect(() => {
        let alive = true
        let timer = 0
        const poll = async () => {
          try {
            const response = await fetch(MODEL_ENDPOINT + 'status', { cache: 'no-store' })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const next = await response.json()
            if (!alive) return
            setStatus(next)
            setPollError(null)
            // 校验也要继续轮询，否则界面会停在"校验中"；动作刚发生后的几秒也要盯住，
            // 因为宿主的下载可能还在探测线路，状态暂时还是 absent。
            const active = next.state === 'downloading' || next.state === 'verifying'
            if (active || Date.now() < settleRef.current) {
              timer = window.setTimeout(poll, 400)
            }
          } catch (failure) {
            if (alive) setPollError(failure instanceof Error ? failure.message : String(failure))
          }
        }
        poll()
        return () => { alive = false; window.clearTimeout(timer) }
      }, [tick])

      const act = React.useCallback(async (action) => {
        setBusy(true)
        setActionError(null)
        settleRef.current = Date.now() + 5000
        try {
          let url = MODEL_ENDPOINT + action
          if (action === 'download') {
            url += '?source=' + encodeURIComponent(prefs.source)
            if (prefs.source === 'custom') url += '&base=' + encodeURIComponent(prefs.customBase.trim())
          }
          const response = await fetch(url, { cache: 'no-store' })
          if (!response.ok) {
            // 宿主会把"地址无效"之类的具体原因放在 body 里；拿不到就报状态码，
            // 绝不能什么都不显示——那样用户只看到"点了一下没反应"。
            const body = await response.json().catch(() => null)
            setActionError(body !== null && typeof body.error === 'string'
              ? body.error
              : 'HTTP ' + response.status)
          }
        } catch (failure) {
          setActionError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
          setTick((n) => n + 1)
        }
      }, [prefs.source, prefs.customBase])

      const customValid = isValidBase(prefs.customBase)
      const canDownload = prefs.source !== 'custom' || customValid
      const error = actionError ?? pollError
      const state = status?.state ?? 'unknown'
      const progress = status !== null && status.total > 0 ? Math.min(1, status.bytes / status.total) : 0

      const statusText = {
        absent: t('stateAbsent'),
        downloading: format(t('stateDownloading'), { percent: Math.round(progress * 100) }),
        verifying: t('stateVerifying'),
        partial: t('statePartial'),
        ready: t('stateReady'),
        error: format(t('stateError'), { error: status?.error ?? '' }),
        unknown: error === null ? t('stateChecking') : t('stateUnavailable'),
      }[state] ?? state

      return React.createElement('div', {
        'data-zh-typo-settings': '',
        style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: props.head === true ? '4px 2px' : '0', maxWidth: '620px' },
      }, [
        React.createElement('style', { key: 'anim' }, ANIMATION_CSS),
        props.head === true
          ? React.createElement('div', { key: 'head' }, [
            React.createElement('div', {
              key: 'title',
              style: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '4px' },
            }, t('title')),
            React.createElement('div', {
              key: 'desc',
              style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
            }, t('sectionIntro')),
          ])
          : null,

        React.createElement('div', {
          key: 'options',
          style: {
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '10px',
            padding: '6px 16px 10px',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        }, [
          React.createElement('div', {
            key: 'title',
            style: { fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)', padding: '8px 0 2px' },
          }, t('options')),
          prefRow('enabled', t('optEnabledLabel'), t('optEnabledHint'), toggleControl(t, prefs.enabled, () => {
            settingsStore.set({ enabled: !prefs.enabled })
          })),
          prefRow('punct', t('optPunctLabel'), t('optPunctHint'), toggleControl(t, prefs.punctuation, () => {
            settingsStore.set({ punctuation: !prefs.punctuation })
          })),
          prefRow('model', t('optModelLabel'), t('optModelHint'), toggleControl(t, prefs.model, () => {
            settingsStore.set({ model: !prefs.model })
          })),
          prefRow('sens', t('optSensitivityLabel'), t('optSensitivityHint'),
            React.createElement('div', { key: 'seg', style: { display: 'flex', gap: '4px' } },
              ['low', 'normal', 'high'].map((level) => React.createElement('button', {
                key: level,
                type: 'button',
                onClick: () => settingsStore.set({ sensitivity: level }),
                style: segmentStyle(prefs.sensitivity === level),
              }, t(level === 'low' ? 'sensLow' : level === 'high' ? 'sensHigh' : 'sensNormal'))))),
          prefRow('fluency', t('optFluencyLabel'), t('optFluencyHint'), toggleControl(t, prefs.fluency, () => {
            settingsStore.set({ fluency: !prefs.fluency })
          })),          prefRow('source', t('optSourceLabel'), t('optSourceHint'),
            React.createElement('div', { key: 'seg', style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
              ['auto', 'mirror', 'official', 'custom'].map((level) => React.createElement('button', {
                key: level,
                type: 'button',
                onClick: () => settingsStore.set({ source: level }),
                style: segmentStyle(prefs.source === level),
              }, t(level === 'auto' ? 'sourceAuto'
                : level === 'mirror' ? 'sourceMirror'
                  : level === 'official' ? 'sourceOfficial' : 'sourceCustom'))))),
          prefs.source === 'custom'
            ? React.createElement('div', {
              key: 'custom-base',
              style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '0 0 8px' },
            }, [
              React.createElement('input', {
                key: 'input',
                type: 'url',
                spellCheck: false,
                placeholder: t('customPlaceholder'),
                value: prefs.customBase,
                onChange: (event) => settingsStore.set({ customBase: event.target.value }),
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  fontFamily: 'inherit',
                  fontSize: '12px',
                  padding: '6px 10px',
                  borderRadius: '7px',
                  border: '1px solid ' + (customValid ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-state-error-primary)'),
                  background: 'var(--dsw-alias-bg-base)',
                  color: 'var(--dsw-alias-label-primary)',
                },
              }),
              customValid
                ? null
                : React.createElement('span', {
                  key: 'warn',
                  style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
                }, t('customInvalid')),
            ])
            : null,
        ]),

        React.createElement('div', {
          key: 'model',
          style: {
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '10px',
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        }, [
          React.createElement('div', {
            key: 'row',
            style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
          }, [
            React.createElement('span', {
              key: 'name',
              style: { fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
            }, t('model')),
            React.createElement('span', {
              key: 'state',
              style: {
                fontSize: '12px',
                color: state === 'ready'
                  ? 'var(--dsw-alias-state-success-primary)'
                  : state === 'error'
                    ? 'var(--dsw-alias-state-error-primary)'
                    : 'var(--dsw-alias-label-secondary)',
              },
            }, statusText),
            status !== null && state === 'ready'
              ? React.createElement('span', {
                key: 'size',
                style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
              }, formatBytes(status.bytes))
              : null,
            React.createElement('div', { key: 'spacer', style: { flex: 1 } }),
            state === 'downloading'
              ? React.createElement('button', {
                key: 'cancel',
                type: 'button',
                disabled: busy,
                onClick: () => act('cancel'),
                style: buttonStyle(false),
              }, t('cancel'))
              : null,
            state === 'ready'
              ? React.createElement('button', {
                key: 'delete',
                type: 'button',
                disabled: busy,
                onClick: () => act('delete'),
                style: buttonStyle(false),
              }, t('remove'))
              : null,
            state === 'absent' || state === 'error' || state === 'partial'
              ? React.createElement('button', {
                key: 'download',
                type: 'button',
                disabled: busy || !canDownload,
                onClick: () => act('download'),
                style: buttonStyle(true),
              }, state === 'partial' ? t('resume') : state === 'error' ? t('reDownload') : t('download'))
              : null,
          ]),
          state === 'downloading' || state === 'verifying'
            ? React.createElement('div', {
              key: 'bar',
              style: {
                height: '4px',
                borderRadius: '2px',
                background: 'var(--dsw-alias-border-l1)',
                overflow: 'hidden',
                position: 'relative',
              },
            }, React.createElement('div', {
              style: state === 'verifying'
                ? {
                  // 校验阶段没有字节进度，用一条滑动的条表示"在动"
                  width: '30%',
                  height: '100%',
                  background: 'var(--dsw-alias-brand-primary)',
                  animation: 'zh-typo-indeterminate 1.1s ease-in-out infinite',
                }
                : {
                  width: Math.round(progress * 100) + '%',
                  height: '100%',
                  background: 'var(--dsw-alias-brand-primary)',
                  transition: 'width .2s linear',
                },
            }))
            : null,
          state === 'downloading' && status !== null && typeof status.file === 'string' && status.file !== ''
            ? React.createElement('div', {
              key: 'file',
              style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
            }, format(t('downloadingFile'), {
              file: status.file,
              index: (status.fileIndex ?? 0) + 1,
              count: status.fileCount ?? 1,
              percent: Math.round(progress * 100),
            }))
            : null,
          state === 'partial' && status !== null
            ? React.createElement('div', {
              key: 'partial',
              style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
            }, format(t('partialDetail'), { size: formatBytes(status.bytes) }))
            : null,
          React.createElement('div', {
            key: 'last-check',
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
          }, lastCheck.at === 0
            ? t('lastCheckIdle')
            : format(t('lastCheck'), {
              state: lastCheck.detail === '' ? lastCheck.state : lastCheck.state + ' ' + lastCheck.detail,
              issues: lastCheck.issues,
              ms: lastCheck.ms,
            })),
          React.createElement('div', {
            key: 'note',
            style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
          }, state === 'ready' ? t('noteReady') : t('noteAbsent')),
          status !== null && status.runtime === false
            ? React.createElement('div', {
              key: 'runtime',
              style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-warn-primary)' },
            }, t('runtimeMissing'))
            : null,
          actionError !== null
            ? React.createElement('div', {
              key: 'action-error',
              style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
            }, format(t('actionFailed'), { error: actionError }))
            : null,
          pollError !== null
            ? React.createElement('div', {
              key: 'err',
              style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
            }, format(t('hostUnavailable'), { error: pollError }))
            : null,
        ]),
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
          beacon('apply done: 3 slots registered')
        } catch (error) {
          beacon('apply failed: ' + (error instanceof Error ? error.message : String(error)))
          throw error
        }
      },
    }
  },
})
