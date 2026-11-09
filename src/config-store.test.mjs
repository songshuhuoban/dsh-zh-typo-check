/**
 * 设置持久化桥的离线测试（src/config-store.mjs）。
 *
 * 这份逻辑要防的是「重启后设置悄悄丢了」：任何一条路径出错，用户看到的都是
 * 默认值回来了。所以这里不碰 DOM / 浏览器，只用一个假的 configForms scope
 * 和假的 localStorage 把同步、写入、失败回滚、补偿写、一次性迁移逐条钉住。
 *
 * Run: node src/config-store.test.mjs
 */
import { ConfigSettings, DEFAULT_SETTINGS, normalizeSettings, parseSettingsJson, shouldKeepDraft } from './config-store.mjs'

let pass = 0
let fail = 0
function expect(label, actual, wanted) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted)
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(wanted)}`)
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 最小 Storage 替身；记录写入内容。 */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)) },
    dump: () => Object.fromEntries(data),
  }
}

/** 假 configForms 表单：快照形状与 dsh-client-ui-settings 的 ConfigFormController 一致。 */
class FakeScope {
  constructor(value = {}, options = {}) {
    this.state = {
      status: options.status ?? 'ready',
      value: { ...DEFAULT_SETTINGS, ...value },
      base: {},
      user: options.user ?? {},
      revision: 1,
      writable: true,
    }
    this.writes = []
    this.mutations = []
    this.listeners = new Set()
    this.mode = 'ok'
    this.mutateMode = 'ok'
    this.held = []
  }

  getSnapshot() {
    return { ...this.state, value: { ...this.state.value }, user: { ...this.state.user } }
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit() {
    for (const listener of this.listeners) listener()
  }

  /** Host 侧外部改动（另一个窗口改了设置 / 迁移完成后的回读）。 */
  hostUpdate(patch) {
    this.state = {
      ...this.state,
      value: { ...this.state.value, ...patch },
      user: { ...this.state.user, ...patch },
      revision: this.state.revision + 1,
    }
    this.emit()
  }

  applyWrites(patch) {
    this.state = {
      ...this.state,
      value: { ...this.state.value, ...patch },
      user: { ...this.state.user, ...patch },
      revision: this.state.revision + 1,
    }
    this.emit()
  }

  set(field, value) {
    this.writes.push({ field, value })
    const mode = this.mode
    if (mode === 'reject') {
      this.mode = 'ok'
      return Promise.resolve(false)
    }
    if (mode === 'hold') {
      return new Promise((resolve) => { this.held.push({ field, value, resolve }) })
    }
    this.applyWrites({ [field]: value })
    return Promise.resolve(true)
  }

  mutate(ops) {
    this.mutations.push(ops)
    if (this.mutateMode === 'reject') {
      this.mutateMode = 'ok'
      return Promise.resolve(false)
    }
    const patch = {}
    for (const op of ops) patch[op.path[0]] = op.value
    this.applyWrites(patch)
    return Promise.resolve(true)
  }
}

// ---- 1. 旧 localStorage 内容的容错 ----
expect('坏 JSON 不抛、返回 null', parseSettingsJson('{oops'), null)
expect('旧版缺 fluency 时补默认值', normalizeSettings({ enabled: false }).fluency, DEFAULT_SETTINGS.fluency)
expect('非法灵敏度退回默认', normalizeSettings({ sensitivity: 'extreme' }).sensitivity, 'normal')
expect('非法来源退回默认', normalizeSettings({ source: 'ftp' }).source, 'auto')
expect('自定义地址保留字符串', normalizeSettings({ customBase: ' https://mirror/base ' }).customBase, ' https://mirror/base ')
expect('非对象输入整体退回默认', normalizeSettings('nope'), { ...DEFAULT_SETTINGS })

// ---- 2. 启动时先用缓存值，Host 就绪后采纳 Host ----
{
  const bridge = new ConfigSettings({})
  expect('没有缓存时用默认值', bridge.get().enabled, DEFAULT_SETTINGS.enabled)

  const scope = new FakeScope({ enabled: false, sensitivity: 'high' })
  expect('attach 返回 true', bridge.attach(scope), true)
  expect('Host 值立即生效', [bridge.get().enabled, bridge.get().sensitivity], [false, 'high'])
}

// ---- 2b. 旧缓存与新 Host 用户设置并存时，Host 优先 ----
{
  const storage = memoryStorage({
    'dsh.zh-typo-check.settings': JSON.stringify({ ...DEFAULT_SETTINGS, enabled: false, sensitivity: 'high' }),
  })
  const bridge = new ConfigSettings({ storage, storageKey: 'dsh.zh-typo-check.settings' })
  expect('初始值来自 localStorage 缓存', [bridge.get().enabled, bridge.get().sensitivity], [false, 'high'])

  const scope = new FakeScope({ enabled: true, sensitivity: 'normal' }, { user: { enabled: true } })
  expect('attach 返回 true', bridge.attach(scope), true)
  expect('Host 用户值覆盖旧缓存', [bridge.get().enabled, bridge.get().sensitivity], [true, 'normal'])
}

// ---- 3. 用户改动：同步生效，异步落 Host ----
{
  const storage = memoryStorage()
  const scope = new FakeScope()
  const bridge = new ConfigSettings({ storage, storageKey: 'k' })
  bridge.attach(scope)

  const seen = []
  bridge.subscribe((value) => seen.push(value.punctuation))
  bridge.set({ punctuation: false })
  expect('set 立即生效（乐观更新）', bridge.get().punctuation, false)
  expect('set 通知订阅者', seen, [false])
  expect('写入排队给 Host', scope.writes.map((w) => w.field), ['punctuation'])
  await flush()
  expect('写入后没有报错', bridge.getErrorState(), null)
  expect('localStorage 缓存同步更新', JSON.parse(storage.getItem('k')).punctuation, false)
}

// ---- 4. Host 拒绝：只回滚该字段并记录该字段的错误 ----
{
  const scope = new FakeScope()
  const bridge = new ConfigSettings({})
  bridge.attach(scope)
  const errors = []
  bridge.subscribeError((state) => errors.push(state))

  scope.mode = 'reject'
  bridge.set({ model: false })
  expect('拒绝前先乐观生效', bridge.get().model, false)
  await flush()
  expect('拒绝后回滚到 Host 值', bridge.get().model, true)
  expect('错误上报给界面', errors.length, 1)
  expect('错误挂在 model 字段上', bridge.getErrorState()?.fields, ['model'])
  expect('错误文案包含原因', String(bridge.getErrorState()?.message).includes('host rejected'), true)
  expect('hasFieldError 可查具体字段', [bridge.hasFieldError('model'), bridge.hasFieldError('enabled')], [true, false])
}

// ---- 5. 并发写：旧写的失败不能覆盖新写的结果 ----
{
  const scope = new FakeScope()
  const bridge = new ConfigSettings({})
  bridge.attach(scope)

  scope.mode = 'hold'
  bridge.set({ fluency: true })
  await flush()
  const first = scope.held.shift()
  bridge.set({ fluency: false })
  await flush()
  const second = scope.held.shift()
  scope.mode = 'ok'

  second.resolve(true)
  await flush()
  expect('后一次写成功后保留新值', bridge.get().fluency, false)

  first.resolve(false)
  await flush()
  expect('旧写失败不触发回滚', bridge.get().fluency, false)
  expect('旧写失败不产生错误', bridge.getErrorState(), null)
}

// ---- 6. Host 外部改动会同步到界面 ----
{
  const scope = new FakeScope()
  const bridge = new ConfigSettings({})
  bridge.attach(scope)
  scope.hostUpdate({ source: 'mirror', customBase: 'https://m' })
  expect('采纳另一个入口写入的值', [bridge.get().source, bridge.get().customBase], ['mirror', 'https://m'])
}

// ---- 7. 一次性迁移：旧 localStorage 设置搬进 Host（一次批量写） ----
{
  const storage = memoryStorage({
    'dsh.zh-typo-check.settings': JSON.stringify({ ...DEFAULT_SETTINGS, punctuation: false, fluency: true }),
  })
  const scope = new FakeScope({}, { user: {} })
  const events = []
  const bridge = new ConfigSettings({ storage, storageKey: 'dsh.zh-typo-check.settings', onEvent: (m) => events.push(m) })
  bridge.attach(scope)
  await flush()
  expect('旧设置用一次 mutate 补写', scope.mutations.length, 1)
  expect(
    '补写内容正确',
    scope.mutations[0].map((op) => [op.path[0], op.value]),
    [['punctuation', false], ['fluency', true]],
  )
  expect('迁移后有事件', events.some((m) => m.includes('flushed')), true)
  expect('迁移后值保持', [bridge.get().punctuation, bridge.get().fluency], [false, true])
}

// ---- 8. Host 已有用户设置时，不被旧缓存覆盖 ----
{
  const storage = memoryStorage({
    'dsh.zh-typo-check.settings': JSON.stringify({ ...DEFAULT_SETTINGS, punctuation: false }),
  })
  const scope = new FakeScope({ punctuation: true }, { user: { punctuation: true } })
  const bridge = new ConfigSettings({ storage, storageKey: 'dsh.zh-typo-check.settings' })
  bridge.attach(scope)
  await flush()
  expect('不覆盖 Host 已有覆盖值', scope.mutations.length + scope.writes.length, 0)
  expect('界面显示 Host 值', bridge.get().punctuation, true)
}

// ---- 9. Host 还没就绪时改的设置，就绪后批量补写 ----
{
  const scope = new FakeScope({}, { status: 'loading' })
  const bridge = new ConfigSettings({})
  bridge.attach(scope)
  bridge.set({ sensitivity: 'low' })
  expect('未就绪时不写 Host', scope.writes.length + scope.mutations.length, 0)
  expect('未就绪时界面仍是新值', bridge.get().sensitivity, 'low')

  scope.state = { ...scope.state, status: 'ready' }
  scope.emit()
  await flush()
  expect('就绪后批量补写', scope.mutations[0].map((op) => [op.path[0], op.value]), [['sensitivity', 'low']])
}

// ---- 10. 旧版 DSH 没有 configForms 时退化成纯本地 ----
{
  const storage = memoryStorage()
  const bridge = new ConfigSettings({ storage, storageKey: 'k' })
  expect('attach(null) 返回 false', bridge.attach(null), false)
  bridge.set({ enabled: false })
  expect('仍然在本地生效', bridge.get().enabled, false)
  expect('仍然写本地缓存', JSON.parse(storage.getItem('k')).enabled, false)
  expect('没有误报错误', bridge.getErrorState(), null)
}

// ---- 11. 输入框草稿的保护条件（只认本字段失败）----
{
  expect('聚焦中保留草稿', shouldKeepDraft('https://a', 'https://b', { focused: true, failed: false }), true)
  expect('本字段保存失败且草稿不同：保留', shouldKeepDraft('https://a', 'https://b', { focused: false, failed: true }), true)
  expect('本字段失败但草稿与已接受值相同：不保留', shouldKeepDraft('https://b', 'https://b', { focused: false, failed: true }), false)
  expect('无失败且失焦：跟随 Host', shouldKeepDraft('https://a', 'https://b', { focused: false, failed: false }), false)
}

// ---- 12. 断开重连：就绪前的改动不能丢 ----
{
  const first = new FakeScope({}, { status: 'loading' })
  const bridge = new ConfigSettings({})
  bridge.attach(first)
  bridge.set({ sensitivity: 'low' })
  expect('就绪前改动先排队', first.writes.length + first.mutations.length, 0)
  bridge.detach()

  const second = new FakeScope({})
  expect('重连返回 true', bridge.attach(second), true)
  await flush()
  expect('重连后补写', second.mutations[0].map((op) => [op.path[0], op.value]), [['sensitivity', 'low']])
}

// ---- 13. 第二次 attach（HMR / provider 重载）也会补写 ----
{
  const bridge = new ConfigSettings({})
  bridge.attach(new FakeScope({}))
  expect('第一次 attach 后已就绪', bridge.ready, true)
  bridge.detach()

  bridge.set({ model: false })
  const second = new FakeScope({})
  bridge.attach(second)
  await flush()
  expect('每次就绪都补写待写值', second.mutations[0].map((op) => [op.path[0], op.value]), [['model', false]])
}

// ---- 14. detach 时还有在途写：转进待补写，重连后重发 ----
{
  const first = new FakeScope({})
  const bridge = new ConfigSettings({})
  bridge.attach(first)
  first.mode = 'hold'
  bridge.set({ punctuation: false })
  await flush()
  bridge.detach()

  const second = new FakeScope({})
  bridge.attach(second)
  await flush()
  expect('在途写重连后重发', second.mutations[0].map((op) => [op.path[0], op.value]), [['punctuation', false]])
}

// ---- 15. 命名空间不可用：报错而不是假装成功；恢复后清除 ----
{
  const scope = new FakeScope({}, { status: 'unavailable' })
  const bridge = new ConfigSettings({})
  const states = []
  bridge.subscribeError((state) => states.push(state))
  expect('attach 仍返回 true（服务在，等命名空间）', bridge.attach(scope), true)
  expect('不可用会报到界面', states.length, 1)
  expect('错误码是命名空间不可用', bridge.getErrorState()?.code, 'namespace-unavailable')

  scope.state = { ...scope.state, status: 'ready' }
  scope.emit()
  expect('恢复后错误清除', bridge.getErrorState(), null)
  expect('恢复后采纳 Host 值', bridge.get().enabled, true)
}

// ---- 16. subscribe 抛异常：attach 失败并复位，不留下半接状态 ----
{
  const broken = {
    getSnapshot: () => ({ status: 'loading' }),
    subscribe: () => { throw new Error('boom') },
  }
  const bridge = new ConfigSettings({})
  expect('subscribe 抛异常时 attach 返回 false', bridge.attach(broken), false)
  expect('失败原因上报', String(bridge.getErrorState()?.message).includes('boom'), true)
  expect('没有留下 scope', bridge.scope, null)
}

// ---- 17. 重要：customBase 失败不能被别的字段成功"治愈" ----
{
  const scope = new FakeScope()
  const bridge = new ConfigSettings({})
  bridge.attach(scope)

  scope.mode = 'reject'
  bridge.set({ customBase: 'https://a' })
  await flush()
  expect('customBase 失败', bridge.hasFieldError('customBase'), true)

  bridge.set({ enabled: false })
  await flush()
  expect('别的字段成功后 customBase 仍算失败', bridge.hasFieldError('customBase'), true)
  expect('错误仍挂着 customBase', bridge.getErrorState()?.fields, ['customBase'])

  bridge.set({ customBase: 'https://b' })
  await flush()
  expect('customBase 自己成功后错误清除', bridge.getErrorState(), null)
}

// ---- 18. 迁移失败：保留待写值、保留旧缓存、可重试 ----
{
  const storage = memoryStorage({
    'dsh.zh-typo-check.settings': JSON.stringify({ ...DEFAULT_SETTINGS, punctuation: false, sensitivity: 'low' }),
  })
  const scope = new FakeScope({}, { user: {} })
  const bridge = new ConfigSettings({ storage, storageKey: 'dsh.zh-typo-check.settings' })
  scope.mutateMode = 'reject'
  bridge.attach(scope)
  await flush()
  expect('迁移失败时记录字段错误', bridge.getErrorState()?.fields, ['punctuation', 'sensitivity'])
  expect('迁移失败不覆盖旧缓存', JSON.parse(storage.getItem('dsh.zh-typo-check.settings')).punctuation, false)
  expect('失败后界面保留旧值', [bridge.get().punctuation, bridge.get().sensitivity], [false, 'low'])

  // 下一次 Host 快照（例如另一个写回执）触发重试
  scope.emit()
  await flush()
  expect('重试成功', bridge.getErrorState(), null)
  expect('Host 最终写入旧值', [scope.state.value.punctuation, scope.state.value.sensitivity], [false, 'low'])
}

// ---- 19. 迁移持续被拒：限次后停止重写，不无限刷 profile ----
{
  const storage = memoryStorage({
    'k': JSON.stringify({ ...DEFAULT_SETTINGS, punctuation: false }),
  })
  const scope = new FakeScope({}, { user: {} })
  const bridge = new ConfigSettings({ storage, storageKey: 'k' })
  scope.mutateMode = 'reject'
  bridge.attach(scope)
  await flush()
  for (let attempt = 0; attempt < 6; attempt += 1) {
    scope.mutateMode = 'reject'
    scope.emit()
    await flush()
  }
  // 1 次初始 + 至多 MAX_PUSH_ATTEMPTS 次重试 = 4 次 mutate
  expect('重试有上限', scope.mutations.length <= 4, true)
  expect('最终仍有错误提示', bridge.getErrorState()?.code, 'write-failed')
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail > 0) process.exit(1)
