/**
 * 设置持久化桥：把「检查设置」接到宿主插件的 Config（DSH volatile 配置）上。
 *
 * 为什么不是 localStorage：DSH Desktop 每次启动都用 `--port 0` 起本地 Web 服务
 * （Electron 侧只拿到运行时端口），页面 origin 每次都变。localStorage 按 origin
 * 隔离，所以浏览器里存的设置在「重启 / 升级」后必然消失。宿主的 profile patch
 * 不随端口走，DSH 的设置服务会把插件 volatile 字段写进它——这才能跨启动、跨升级。
 *
 * 本文件是纯逻辑，不碰 DOM：测试用假的 scope / storage 直接跑（见 config-store.test.mjs）。
 *
 * 桥的职责：
 *   1. 把 Host 配置快照变成一份完整的设置（缺字段/坏值退回默认值）；
 *   2. 用户改动先立即生效（乐观更新），再写 Host；按字段记账，某个字段写失败
 *      只回滚该字段，不能因为别的字段写成功就把错误吞掉；
 *   3. Host 就绪前的本地改动、以及旧版本 localStorage 里的设置，用一次批量
 *      mutate 补写；失败保留待写值并限次重试，不覆盖旧缓存。
 */

/** 与宿主 bundle/index.js 的 Config 字段一一对应；漏一个就会导致该设置不持久。 */
export const SETTINGS_FIELDS = [
  'enabled',
  'punctuation',
  'model',
  'fluency',
  'sensitivity',
  'source',
  'customBase',
  'sentenceSource',
  'sentenceCustomBase',
]

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  punctuation: true,
  model: true,
  // 整句检查可独立下载；保留已有用户显式关闭的偏好。
  fluency: true,
  sensitivity: 'normal',
  source: 'auto',
  customBase: '',
  sentenceSource: 'official',
  sentenceCustomBase: '',
})

const SENSITIVITY_LEVELS = ['low', 'normal', 'high']
const SOURCE_LEVELS = ['auto', 'mirror', 'official', 'custom']
/** 迁移/补写最多尝试几次；Host 顽固拒绝时别无限重写 profile。 */
const MAX_PUSH_ATTEMPTS = 3

/**
 * 读旧版 localStorage 时别信内容：任何字段类型不对都退回默认值。
 * 旧版 loadSettings 漏了 fluency，这里一并修掉。
 */
export function normalizeSettings(raw) {
  const next = { ...DEFAULT_SETTINGS }
  if (raw === null || typeof raw !== 'object') return next
  if (typeof raw.enabled === 'boolean') next.enabled = raw.enabled
  if (typeof raw.punctuation === 'boolean') next.punctuation = raw.punctuation
  if (typeof raw.model === 'boolean') next.model = raw.model
  if (typeof raw.fluency === 'boolean') next.fluency = raw.fluency
  if (SENSITIVITY_LEVELS.includes(raw.sensitivity)) next.sensitivity = raw.sensitivity
  if (SOURCE_LEVELS.includes(raw.source)) next.source = raw.source
  if (typeof raw.customBase === 'string') next.customBase = raw.customBase
  // 旧版自定义地址同时用于两套模型。缺少新字段时沿用，避免升级切换下载地址。
  next.sentenceSource = ['official', 'custom'].includes(raw.sentenceSource)
    ? raw.sentenceSource : next.source === 'custom' ? 'custom' : 'official'
  next.sentenceCustomBase = typeof raw.sentenceCustomBase === 'string'
    ? raw.sentenceCustomBase : next.source === 'custom' ? next.customBase : ''
  return next
}

/** schema 默认值不代表用户选过新来源；按 user 层判断旧版共享地址是否需要迁移。 */
function hostSettings(snapshot) {
  const raw = { ...snapshot.value }
  if (snapshot.user !== null && typeof snapshot.user === 'object') {
    for (const field of ['sentenceSource', 'sentenceCustomBase']) {
      if (!Object.prototype.hasOwnProperty.call(snapshot.user, field)) delete raw[field]
    }
  }
  return normalizeSettings(raw)
}

/** JSON 文本 → 设置；解析失败返回 null（调用方决定退回什么）。 */
export function parseSettingsJson(text) {
  if (typeof text !== 'string' || text === '') return null
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return normalizeSettings(parsed)
  } catch (_error) {
    return null
  }
}

/** Host 快照里的 user 层是否为空：空表示用户从没在 Host 侧改过任何字段。 */
function isEmptyUserLayer(user) {
  if (user === undefined || user === null) return true
  if (typeof user !== 'object' || Array.isArray(user)) return true
  return Object.keys(user).length === 0
}

/**
 * 输入框草稿什么时候**不该**被 Host 值覆盖。
 *
 * 两种情况必须保留用户输入（否则出现"填了地址、保存失败、内容被抹掉"）：
 *   1. 输入框正在聚焦；
 *   2. 该字段自己的写入失败、且草稿与已接受值不同 —— 用户的修改还没落盘。
 * 注意只认**这个字段**的失败：别的字段写成功不能解除这里的保护。
 *
 * @param {string} draft 输入框当前文本
 * @param {string} committed Host / 已接受的值
 * @param {{focused?: boolean, failed?: boolean}} [state]
 * @returns {boolean}
 */
export function shouldKeepDraft(draft, committed, state = {}) {
  if (state.focused === true) return true
  return state.failed === true && draft !== committed
}

/**
 * 单例设置桥。
 *
 * 不直接依赖 window：storage 由调用方传入，缺失时退化成「只在内存里」。
 */
export class ConfigSettings {
  /**
   * @param {{storage?: Storage|null, storageKey?: string, namespace?: string, onEvent?: (message: string) => void}} [options]
   */
  constructor(options = {}) {
    this.storage = options.storage ?? null
    this.storageKey = options.storageKey ?? 'dsh.zh-typo-check.settings'
    this.namespace = options.namespace ?? 'zh-typo-check'
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}

    /** localStorage 里是否真有旧版本的设置（决定要不要做一次性迁移）。 */
    this.hasCache = false
    /** 当前展示值（可能比 Host 已接受值超前：乐观更新）。 */
    this.value = this.readCache()
    /** Host 已接受的值；写失败时回滚到它。 */
    this.committed = { ...this.value }
    /** attach 那一刻的本地缓存，用于一次性迁移。 */
    this.cacheAtAttach = null
    /** configForms 里本插件的 form；null 表示宿主没提供（旧版 DSH）。 */
    this.scope = null
    this.ready = false
    this.syncing = false
    this.unsubscribe = null
    /** 单字段用户写入：字段 → 写序号（并发时只让最新一次失败触发回滚）。 */
    this.pending = new Map()
    this.sequence = 0
    /** 待批量补写的值（就绪前改动 / 迁移）；字段 → 期望值。 */
    this.pendingPush = new Map()
    this.pushInFlight = false
    this.pushAttempts = 0
    /** 迁移是否已处理过（只做一次；失败由 pendingPush 负责重试）。 */
    this.migrated = false
    /** 写失败字段：字段 → 最近一次错误文案。 */
    this.failedFields = new Map()
    this.namespaceUnavailable = false
    /** 对外错误状态：{ code, message, fields } 或 null。 */
    this.errorState = null
    this.listeners = new Set()
    this.errorListeners = new Set()
  }

  get() {
    return this.value
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** @returns {{code: string, message: string, fields: string[]}|null} */
  getErrorState() {
    return this.errorState
  }

  /** 兼容旧调用：只取错误文案。 */
  getError() {
    return this.errorState === null ? null : this.errorState.message
  }

  /** 某个字段自己的最近一次写入是否失败（输入框草稿保护只认这个）。 */
  hasFieldError(field) {
    return this.failedFields.has(field)
  }

  subscribeError(listener) {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  /**
   * 用户改设置：先本地生效，再逐字段写 Host。
   * Host 没接上时先排队（pendingPush），接上后一次批量补写。
   */
  set(patch) {
    if (patch === null || typeof patch !== 'object') return this.value
    const merged = { ...this.value }
    for (const field of SETTINGS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) merged[field] = patch[field]
    }
    const next = normalizeSettings(merged)
    const changed = SETTINGS_FIELDS.filter((field) => next[field] !== this.value[field])
    if (changed.length === 0) return this.value

    this.value = next
    this.writeCache()
    this.notify()

    if (this.ready && this.scope !== null) {
      for (const field of changed) this.pendingPush.delete(field)
      this.persistFields(changed)
    } else {
      for (const field of changed) this.pendingPush.set(field, this.value[field])
    }
    return this.value
  }

  /**
   * 接上 configForms 的 form。
   * @returns 是否接上；没接上时设置只在本地生效（旧版 DSH 仍可用）。
   */
  attach(scope) {
    this.detach()
    if (scope === null || typeof scope !== 'object'
      || typeof scope.getSnapshot !== 'function' || typeof scope.subscribe !== 'function') {
      return false
    }
    this.scope = scope
    this.cacheAtAttach = { ...this.value }
    try {
      this.unsubscribe = scope.subscribe(() => this.syncFromScope())
    } catch (error) {
      this.unsubscribe = null
      this.scope = null
      this.ready = false
      this.reportError(['attach'], error)
      return false
    }
    this.onEvent('bridge attached')
    this.syncFromScope()
    if (!this.ready) this.onEvent('bridge attached, namespace not ready')
    return true
  }

  detach() {
    if (this.unsubscribe !== null) {
      try { this.unsubscribe() } catch (_error) { /* ignore */ }
      this.unsubscribe = null
    }
    // 在途写在重连后没法再跟踪回执，把期望值转进 pendingPush，重连后重新补写；
    // pendingPush 本身也不清，否则「就绪前改动 / 迁移」会在 provider 重载后丢。
    for (const field of this.pending.keys()) this.pendingPush.set(field, this.value[field])
    this.pending.clear()
    this.scope = null
    this.ready = false
  }

  dispose() {
    this.detach()
    this.pendingPush.clear()
    this.listeners.clear()
    this.errorListeners.clear()
  }

  /** Host 快照变化：采纳已接受的值，安排补偿写，处理命名空间不可用。 */
  syncFromScope() {
    if (this.scope === null) return
    if (this.syncing) return
    let snapshot
    try {
      snapshot = this.scope.getSnapshot()
    } catch (_error) {
      return
    }
    if (snapshot === null || typeof snapshot !== 'object') return
    // status: loading（Host 还没回）| ready | unavailable
    if (snapshot.status === 'unavailable') {
      // configForms 在、但本插件的配置命名空间不在（设置服务没起来 / Config 没有 volatile 字段）。
      // 不能假装"已接上"然后静默只写本地缓存——那正是本次要修的静默丢失。
      if (!this.namespaceUnavailable) {
        this.namespaceUnavailable = true
        this.onEvent('namespace unavailable: ' + this.namespace)
        this.recomputeError()
      }
      return
    }
    if (snapshot.status !== 'ready' || snapshot.value === null || typeof snapshot.value !== 'object') return

    // 快照监听可能在写 Host 的回执里同步触发；重入会把刚算出的补偿值覆盖掉，
    // 所以整段串行执行，内部触发的快照留到后续回调再处理。
    this.syncing = true
    try {
      const host = hostSettings(snapshot)
      this.committed = { ...host }
      if (this.namespaceUnavailable) {
        this.namespaceUnavailable = false
        this.failedFields.clear()
        this.recomputeError()
      } else if (this.failedFields.has('attach')) {
        // 连接期错误在真正就绪后就没有意义了（合成字段，不属于任何设置项）
        this.failedFields.delete('attach')
        this.recomputeError()
      }

      // 首次就绪且 Host 从没被改过：把旧版本 localStorage 里真实存在的设置排进补写。
      // migrated 只表示"看过旧缓存"，真正是否写成由 pendingPush 成功与否决定（可重试）。
      if (!this.migrated) {
        this.migrated = true
        if (this.hasCache && this.cacheAtAttach !== null && isEmptyUserLayer(snapshot.user)) {
          for (const field of SETTINGS_FIELDS) {
            if (this.cacheAtAttach[field] !== host[field] && !this.pendingPush.has(field)) {
              this.pendingPush.set(field, this.cacheAtAttach[field])
              this.value = { ...this.value, [field]: this.cacheAtAttach[field] }
            }
          }
        }
        // 将旧共享来源固定为独立偏好；之后修改错字来源不再影响整句模型。
        if (host.source === 'custom' && host.sentenceSource === 'custom') {
          for (const field of ['sentenceSource', 'sentenceCustomBase']) {
            if (!Object.prototype.hasOwnProperty.call(snapshot.user ?? {}, field)
              && !this.pendingPush.has(field)) {
              this.pendingPush.set(field, host[field])
              this.value = { ...this.value, [field]: host[field] }
            }
          }
        }
      }

      const next = { ...this.value }
      for (const field of SETTINGS_FIELDS) {
        // 在途单字段写 / 待批量补写 / 失败待重试的字段保留本地值，别被旧快照盖回去
        if (this.pending.has(field) || this.pendingPush.has(field) || this.failedFields.has(field)) continue
        next[field] = host[field]
      }
      const changed = SETTINGS_FIELDS.some((field) => next[field] !== this.value[field])
      this.ready = true
      this.value = next
      if (changed) {
        this.writeCache()
        this.notify()
      }
      if (this.pendingPush.size > 0) this.flushPendingPush()
      else if (changed === false && !this.pushInFlight) this.onEvent('ready, ' + SETTINGS_FIELDS.length + ' fields')
    } finally {
      this.syncing = false
    }
  }

  /**
   * 批量补写（迁移 / 就绪前改动）：能一次 mutate 就一次提交，避免"部分成功"。
   * 失败时保留期望值与错误，最多重试 MAX_PUSH_ATTEMPTS 次；旧缓存不被覆盖。
   */
  flushPendingPush() {
    if (this.pushInFlight || this.scope === null || this.pendingPush.size === 0) return
    if (this.pushAttempts >= MAX_PUSH_ATTEMPTS) {
      this.pendingPush.clear()
      this.recomputeError()
      this.onEvent('gave up flushing pending settings')
      return
    }
    const entries = [...this.pendingPush.entries()]
    const ops = entries.map(([field, value]) => ({ op: 'set', path: [field], value }))
    this.pushInFlight = true
    let result
    try {
      result = typeof this.scope.mutate === 'function'
        ? this.scope.mutate(ops)
        : Promise.all(entries.map(([field, value]) => this.scope.set(field, value))).then((accepted) => accepted.every(Boolean))
    } catch (error) {
      this.pushInFlight = false
      this.pushAttempts += 1
      this.reportError(entries.map(([field]) => field), error)
      return
    }
    Promise.resolve(result).then(
      (accepted) => {
        this.pushInFlight = false
        if (accepted === false) {
          this.pushAttempts += 1
          this.reportError(entries.map(([field]) => field), new Error('host rejected the pending settings'))
          return
        }
        for (const [field, value] of entries) {
          if (this.pendingPush.get(field) === value) this.pendingPush.delete(field)
          this.failedFields.delete(field)
        }
        this.pushAttempts = 0
        this.onEvent('flushed ' + entries.length + ' field(s)')
        this.recomputeError()
      },
      (error) => {
        this.pushInFlight = false
        this.pushAttempts += 1
        this.reportError(entries.map(([field]) => field), error)
      },
    )
  }

  /** 逐字段写 Host；configForms 自己会串行化并处理 revision 冲突。 */
  persistFields(fields) {
    if (this.scope === null) return
    for (const field of fields) {
      if (!SETTINGS_FIELDS.includes(field)) continue
      const token = ++this.sequence
      this.pending.set(field, token)
      let result
      try {
        result = this.scope.set(field, this.value[field])
      } catch (error) {
        this.failed(field, token, error)
        continue
      }
      Promise.resolve(result).then(
        (accepted) => {
          if (accepted === false) this.failed(field, token, new Error('host rejected the write'))
          else this.accepted(field, token)
        },
        (error) => this.failed(field, token, error),
      )
    }
  }

  accepted(field, token) {
    if (this.pending.get(field) !== token) return
    this.pending.delete(field)
    this.committed = { ...this.committed, [field]: this.value[field] }
    // 只清这个字段自己的失败，别让"另一个字段写成功"解除输入框草稿保护
    if (this.failedFields.delete(field)) this.recomputeError()
  }

  /** 写失败：只回滚该字段到 Host 已接受值，并保留它自己的错误状态。 */
  failed(field, token, error) {
    if (this.pending.get(field) !== token) return
    this.pending.delete(field)
    let recovered = null
    try {
      const snapshot = this.scope === null ? null : this.scope.getSnapshot()
      if (snapshot !== null && snapshot.status === 'ready' && snapshot.value !== null && typeof snapshot.value === 'object') {
        recovered = hostSettings(snapshot)
      }
    } catch (_error) { /* 用上一次提交值兜底 */ }
    const base = recovered ?? this.committed
    this.committed = { ...this.committed, [field]: base[field] }
    this.value = { ...this.value, [field]: base[field] }
    this.writeCache()
    this.notify()
    this.reportError([field], error)
  }

  /** 记录失败字段并重算对外错误；别的字段的失败互不覆盖。 */
  reportError(fields, error) {
    const message = error instanceof Error ? error.message : String(error)
    for (const field of fields) this.failedFields.set(field, message)
    this.onEvent('write failed: ' + message)
    this.recomputeError()
  }

  /** 对外错误状态：命名空间不可用优先；否则展示最近一个字段失败。 */
  recomputeError() {
    let next = null
    if (this.namespaceUnavailable) {
      next = { code: 'namespace-unavailable', message: 'settings namespace unavailable', fields: [] }
    } else if (this.failedFields.size > 0) {
      const fields = [...this.failedFields.keys()]
      const message = this.failedFields.get(fields[fields.length - 1])
      next = { code: 'write-failed', message, fields }
    }
    if (next === null ? this.errorState === null : (this.errorState !== null
      && this.errorState.code === next.code && this.errorState.message === next.message
      && JSON.stringify(this.errorState.fields) === JSON.stringify(next.fields))) return
    this.errorState = next
    for (const listener of this.errorListeners) listener(this.errorState)
  }

  notify() {
    for (const listener of this.listeners) listener(this.value)
  }

  readCache() {
    if (this.storage === null) return { ...DEFAULT_SETTINGS }
    try {
      const raw = this.storage.getItem(this.storageKey)
      const parsed = parseSettingsJson(raw)
      if (parsed !== null) this.hasCache = true
      return parsed ?? { ...DEFAULT_SETTINGS }
    } catch (_error) {
      return { ...DEFAULT_SETTINGS }
    }
  }

  writeCache() {
    if (this.storage === null) return
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.value))
    } catch (_error) { /* 隐私模式：只保留内存值 */ }
  }
}
