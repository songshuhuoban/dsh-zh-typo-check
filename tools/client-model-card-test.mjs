/** Execute the actual model card with a small hook scheduler and controlled HTTP failures. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../bundle/client.js', import.meta.url), 'utf8')
const marker = "    return {\n      inject: ['slots', 'locale'],"
assert.equal(source.split(marker).length, 2)
const flush = () => new Promise(resolve => setImmediate(resolve))
function harness(responses) {
  const slots = [], effects = [], timers = new Map()
  let position = 0, timerId = 0, entry, calls = 0
  const react = {
    useState(initial) {
      const at = position++
      if (!(at in slots)) slots[at] = initial
      return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
    },
    useRef(initial) {
      const at = position++
      if (!(at in slots)) slots[at] = { current: initial }
      return slots[at]
    },
    useEffect(effect, deps) {
      const at = position++, previous = slots[at]
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        effects.push(() => { previous?.cleanup?.(); slots[at] = { deps, cleanup: effect() } })
      }
    },
    useId: () => 'model-card-test',
    useSyncExternalStore: (_subscribe, get) => get(),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter(value => value !== null && value !== false) }),
  }
  const window = { localStorage: { getItem: () => null, setItem() {} },
    __ModuleLoader__: { load(value) { entry = value } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id },
    clearTimeout(id) { timers.delete(id) },
  }
  const sandbox = { window, URL, URLSearchParams, location: { pathname: '/' },
    fetch: async url => {
      if (url.includes('/log?')) return {}
      calls += 1
      const next = responses.shift() || { ok: false }
      return { ok: next.ok, status: next.ok ? 200 : 503, json: async () => next.body }
    },
  }
  vm.runInNewContext(source.replace(marker, "    return { test: { ModelCard, configSettings, STRINGS },\n      inject: ['slots', 'locale'],"), sandbox)
  const api = entry.factory(() => react).test
  return {
    ...api, timers, calls: () => calls,
    render() {
      position = 0
      const tree = api.ModelCard({ sentence: true, prefs: api.configSettings.get(), t: key => api.STRINGS.zh[key] || key })
      while (effects.length) effects.shift()()
      return tree
    },
    async nextTimer(expected) {
      const [id, timer] = [...timers.entries()].find(([, timer]) => timer.ms === expected) || []
      assert.ok(timer, `expected retry after ${expected} ms`)
      timers.delete(id); timer.fn(); await flush()
    },
  }
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...tree.children.flatMap(nodes)]
}
const text = tree => nodes(tree).flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ')
const ready = { ok: true, body: { state: 'ready', bytes: 27092583, total: 27092583, runtime: true } }
{
  const h = harness([{ ok: false }, ready])
  h.render(); await flush()
  assert.ok(text(h.render()).includes('宿主服务不可用'))
  await h.nextTimer(1000)
  assert.ok(text(h.render()).includes('已就绪 · 本地运行'), 'transient 503 must recover automatically')
  assert.equal(h.calls(), 2)
}
{
  const h = harness(Array.from({ length: 4 }, () => ({ ok: false })))
  h.render(); await flush()
  for (const delay of [1000, 2000, 4000]) await h.nextTimer(delay)
  const tree = h.render()
  assert.equal(h.calls(), 4, 'automatic retries must be bounded')
  assert.equal(h.timers.size, 0)
  const refresh = nodes(tree).find(node => node.props['aria-label'] === '刷新状态')
  assert.ok(refresh, 'exhausted retries leave an accessible manual refresh')
  refresh.props.onClick(); h.render(); await flush()
  assert.equal(h.calls(), 5)
}
{
  const h = harness([ready])
  const initial = { ...h.configSettings.get(), sentenceSource: 'custom', sentenceCustomBase: 'https://example.test/accepted' }
  const listeners = new Set()
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: initial, user: initial }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set: async () => false,
  }
  h.configSettings.attach(scope)
  let tree = h.render()
  let input = nodes(tree).find(node => node.type === 'input')
  input.props.onFocus(); input.props.onChange({ target: { value: 'https://example.test/unsaved' } })
  tree = h.render(); input = nodes(tree).find(node => node.type === 'input')
  assert.equal(h.configSettings.get().sentenceCustomBase, initial.sentenceCustomBase, 'typing must not persist each key')
  input.props.onBlur(); await flush()
  tree = h.render(); input = nodes(tree).find(node => node.type === 'input')
  assert.equal(h.configSettings.get().sentenceCustomBase, initial.sentenceCustomBase, 'rejected save rolls back committed setting')
  assert.equal(input.props.value, 'https://example.test/unsaved', 'failed save retains the editable draft')
  assert.equal(input.props['aria-invalid'], true)
  assert.equal(input.props.disabled, undefined)
}
console.log('PASS  model status retry/recovery, manual refresh, blur saving and failed-draft preservation')
