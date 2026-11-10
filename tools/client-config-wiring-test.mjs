/**
 * 客户端配置桥接的「接线」验证 —— 不需要浏览器，也不需要真的 DSH。
 *
 * 加载构建产物 bundle/client.js，用假的模块加载器、React 和插件上下文执行
 * apply()，然后断言：
 *   - 三个槽位照旧注册；
 *   - configForms 是可选注入（服务不在时 apply 不能挂）；
 *   - 命名空间取 Loader 条目 id `zh-typo-check`；
 *   - Host 快照就绪后桥接完成，旧 localStorage 设置会被迁移写回 Host。
 *
 * 它防的是「构建产物里 splice 丢了 / configForms 用错 API / 命名空间写错」这类
 * 只有打开页面才会暴露的错误。样式与渲染不在覆盖范围内。
 *
 * Run: node tools/client-config-wiring-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'bundle', 'client.js'), 'utf8')

let pass = 0
let fail = 0
function expect(label, actual, wanted) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted)
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(wanted)}`)
}

/** 最小 React 替身：拿掉组件渲染，只需要 createElement / hooks 占位。 */
const hooks = {
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useRef: (value) => ({ current: value }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useId: () => 'id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props, children }),
  createContext: () => ({ Provider: null, Consumer: null }),
  forwardRef: (render) => render,
}
const fakeReact = hooks
const fakeReactDOM = { createPortal: (node) => node }

/** 假 localStorage：可以预置旧版本的设置。 */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)) },
    dump: () => Object.fromEntries(data),
  }
}

/** 与 dsh-client-ui-settings 的 ConfigFormController 同形状的假 form。 */
function fakeForm(options = {}) {
  const state = {
    status: options.status ?? 'ready',
    value: {
      enabled: true,
      punctuation: true,
      model: true,
      fluency: true,
      sensitivity: 'normal',
      source: 'auto',
      customBase: '',
      ...options.value,
    },
    base: {},
    user: options.user ?? {},
    revision: 1,
    writable: true,
  }
  const writes = []
  const mutations = []
  const listeners = new Set()
  const applyPatch = (patch) => {
    state.value = { ...state.value, ...patch }
    state.user = { ...state.user, ...patch }
    state.revision += 1
    for (const listener of listeners) listener()
  }
  return {
    writes,
    mutations,
    getSnapshot: () => ({ ...state, value: { ...state.value }, user: { ...state.user } }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (field, value) => {
      writes.push({ field, value })
      applyPatch({ [field]: value })
      return Promise.resolve(true)
    },
    mutate: (ops) => {
      mutations.push(ops)
      const patch = {}
      for (const op of ops) patch[op.path[0]] = op.value
      applyPatch(patch)
      return Promise.resolve(true)
    },
  }
}

/** 跑一次 bundle 的 factory + apply。 */
function runClient(options = {}) {
  const storage = memoryStorage(options.storage ?? {})
  const beacons = []
  // form 在 apply 之外创建：这样"没有写 Host"的断言检查的是同一个对象，而不是恒真的新对象
  const form = fakeForm(options.form)
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    fetch: (url) => {
      try {
        const target = new URL(String(url), 'http://127.0.0.1')
        beacons.push(target.searchParams.get('msg') ?? '')
      } catch (_error) { /* ignore */ }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    },
  }
  const fakeWindow = {
    localStorage: storage,
    innerWidth: 1280,
    setTimeout,
    clearTimeout,
    addEventListener: () => {},
    removeEventListener: () => {},
    __ModuleLoader__: null,
  }
  sandbox.window = fakeWindow
  sandbox.location = { pathname: '/' }
  sandbox.document = {
    documentElement: {},
    querySelector: () => null,
    createRange: () => ({ setStart: () => {}, setEnd: () => {}, getClientRects: () => [] }),
    head: { appendChild: () => {} },
  }
  const context = vm.createContext(sandbox)

  let captured = null
  fakeWindow.__ModuleLoader__ = {
    load: (entry) => { captured = entry },
  }
  vm.runInContext(source, context)
  if (captured === null) throw new Error('bundle 没有调用 __ModuleLoader__.load')

  let registrationError = null
  let moduleExports = null
  try {
    moduleExports = captured.factory((name) => {
      if (name === 'react') return fakeReact
      if (name === 'react-dom') return fakeReactDOM
      throw new Error('unexpected require: ' + name)
    })
  } catch (error) {
    registrationError = error
  }

  return {
    id: captured.id,
    beacons,
    storage,
    form,
    exports: moduleExports,
    registrationError,
    /** 执行插件的 apply：fakeConfigForms = null 时模拟旧版 DSH（没有该服务）。 */
    apply(fakeConfigForms) {
      const slots = []
      const injected = { namespaces: [], services: [] }
      const disposers = []
      /** 模拟 Cordis effect：调用并记住返回的 disposer，卸载时统一释放。 */
      const keep = (fn) => {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      }
      const ctx = {
        effect: keep,
        locale: {
          register: () => () => {},
          bind: () => (key) => key,
        },
        slots: {
          inject: (name, register) => { register() },
          register: (definition, component) => { slots.push({ definition, component }); return () => {} },
        },
        inject: (services, callback) => {
          injected.services.push(...services)
          if (fakeConfigForms === null) return
          callback({
            effect: keep,
            configForms: {
              get: (namespace) => {
                injected.namespaces.push(namespace)
                return form
              },
            },
          })
        },
      }
      let error = null
      try { moduleExports.apply(ctx) } catch (failure) { error = failure }
      return {
        slots,
        form,
        injected,
        error,
        /** DSH 升级前「停止旧版本」：逆序释放 effect（含配置桥订阅）。 */
        dispose() {
          while (disposers.length > 0) disposers.pop()()
        },
      }
    },
  }
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---- 1. 模块注册 id 与工厂 ----
const client = runClient()
expect('模块 id 是包名', client.id, 'dsh-zh-typo-check')
expect('工厂执行不抛', client.registrationError, null)
expect('导出 apply 与 inject', typeof client.exports?.apply, 'function')
expect('inject 仍只需要 slots / locale', client.exports?.inject, ['slots', 'locale'])

// 命名空间必须等于 bundle patch 里 insert 的 Loader 条目 id（不是 npm 包名）——
// 这是配置持久化能接上的前提，所以从真实 patch 文件交叉验证。
const patchSource = fs.readFileSync(path.join(root, 'bundle', 'cordis.patch.yml'), 'utf8')
const patchEntryId = /-\s+id:\s*([^\s]+)/.exec(patchSource)?.[1]
expect('bundle patch 里有 Loader 条目 id', typeof patchEntryId, 'string')

// ---- 2. configForms 服务可用：接线完成，迁移旧 localStorage 设置 ----
{
  const run = runClient({
    storage: {
      'dsh.zh-typo-check.settings': JSON.stringify({ enabled: true, punctuation: false, model: true }),
    },
  })
  const applied = run.apply({ available: true })
  await flush()
  expect('apply 不抛错', applied.error, null)
  expect(
    '三个槽位照旧注册',
    applied.slots.map((slot) => slot.definition.name),
    ['conversation.input.overlay', 'settings.plugins.tab', 'plugins.detail.section'],
  )
  expect('按 Loader 条目 id 取配置命名空间', applied.injected.namespaces, [patchEntryId])
  expect(
    '桥接完成（beacon 可见）',
    run.beacons.some((message) => message.includes('settings bridge attached to ' + patchEntryId)),
    true,
  )
  expect(
    '旧 localStorage 设置被批量迁移写回 Host',
    run.form.mutations.map((ops) => ops.map((op) => [op.path[0], op.value])),
    [[['punctuation', false]]],
  )

  // 卸载 / 升级：DSH 会先停掉旧版本（释放所有 effect），再装载新版本。
  // 这里验证配置桥订阅会被释放，且重新 apply（新页面/新版本）能干净地再接上。
  applied.dispose()
  expect(
    '卸载时释放配置桥（beacon 可见）',
    run.beacons.some((message) => message.includes('settings bridge detached')),
    true,
  )
  const reapplied = run.apply({ available: true })
  await flush()
  expect('升级后重新接上配置桥', reapplied.error, null)
  expect('重新接上后命名空间不变', reapplied.injected.namespaces.at(-1), patchEntryId)
  expect(
    '桥接按新实例重新建立（attach 两次）',
    run.beacons.filter((message) => message.includes('settings bridge attached to ' + patchEntryId)).length,
    2,
  )
  reapplied.dispose()
}

// ---- 3. 旧版 DSH 没有 configForms：apply 仍成功，退回本地缓存 ----
{
  const run = runClient()
  const applied = run.apply(null)
  await flush()
  expect('没有 configForms 时 apply 也不抛', applied.error, null)
  expect('槽位注册不受影响', applied.slots.length, 3)
  expect(
    '如实记录服务不可用',
    run.beacons.some((message) => message.includes('settings bridge requested')),
    true,
  )
  expect('没有误写 Host', run.form.writes.length + run.form.mutations.length, 0)
}

// ---- 4. Host 已有用户设置时不迁移 ----
{
  const run = runClient({
    storage: {
      'dsh.zh-typo-check.settings': JSON.stringify({ enabled: true, punctuation: false }),
    },
    form: { user: { punctuation: true } },
  })
  const applied = run.apply({ available: true })
  await flush()
  expect('Host 用户设置优先，不迁移', run.form.writes.length + run.form.mutations.length, 0)
}

// ---- 5. 命名空间不可用：apply 不挂，并留下可诊断的 beacon ----
{
  const run = runClient({ form: { status: 'unavailable' } })
  const applied = run.apply({ available: true })
  await flush()
  expect('命名空间不可用时 apply 仍然成功', applied.error, null)
  expect(
    '记录命名空间不可用（含命名空间名）',
    run.beacons.some((message) => message.includes('namespace unavailable') && message.includes(patchEntryId)),
    true,
  )
  expect('没有写 Host', run.form.writes.length + run.form.mutations.length, 0)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail > 0) process.exit(1)
