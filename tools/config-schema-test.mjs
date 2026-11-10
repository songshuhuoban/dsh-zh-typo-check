/**
 * 宿主侧配置 schema 的离线验证。
 *
 * 设置要跨重启保留，靠的是 DSH 把宿主 Config 里的 **volatile** 字段写进
 * profile 的 cordis.patch.yml。所以这里钉住三件事：
 *   1. Config 导出存在、字段集合与客户端桥完全一致（漏一个 = 该设置不持久）；
 *   2. 每个字段都标了 volatile（没标的字段 DSH 不会热更/持久化）；
 *   3. 默认值与客户端默认值一致，非法值会被 schema 拒绝（别把坏值写进 profile）。
 *
 * Run: node tools/config-schema-test.mjs
 * 需要开发依赖 @deepseek-ai/schemastery（`pnpm install` 后即有）。
 */
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SETTINGS, SETTINGS_FIELDS } from '../src/config-store.mjs'

let plugin = null
try {
  plugin = await import('../bundle/index.js')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('@deepseek-ai/schemastery')) {
    console.log('SKIP  宿主配置 schema 测试：缺少 @deepseek-ai/schemastery（先运行 pnpm install）')
    process.exit(0)
  }
  throw error
}

let pass = 0
let fail = 0
function expect(label, actual, wanted) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted)
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(wanted)}`)
}
function expectThrows(label, run) {
  let threw = false
  try { run() } catch (_error) { threw = true }
  expect(label, threw, true)
}

// ---- 1. schema 结构与默认值 ----
const Config = plugin.Config
expect('导出 Config', typeof Config, 'function')
expect('Config 可序列化（DSH 按 toJSON 投影表单）', typeof Config?.toJSON, 'function')
const serialized = Config.toJSON()
const dict = serialized.refs[serialized.uid].dict
expect('字段集合与客户端一致', Object.keys(dict).sort(), [...SETTINGS_FIELDS].sort())

for (const field of SETTINGS_FIELDS) {
  expect(`${field} 是 volatile 字段`, dict[field]?.meta?.volatile === true || serialized.refs[dict[field]]?.meta?.volatile === true, true)
}

const parsed = Config({})
const defaults = {}
for (const field of SETTINGS_FIELDS) defaults[field] = parsed[field]?.get?.() ?? parsed[field]
expect('默认值与客户端 DEFAULT_SETTINGS 一致', defaults, { ...DEFAULT_SETTINGS })

// ---- 2. 非法值被拒绝（避免被设置服务写进 profile patch）----
expectThrows('拒绝非法灵敏度', () => Config({ sensitivity: 'extreme' }))
expectThrows('拒绝非法下载来源', () => Config({ source: 'ftp' }))
expectThrows('拒绝非法整句来源', () => Config({ sentenceSource: 'ftp' }))
for (const source of ['auto', 'mirror', 'official', 'custom']) {
  const parsed = Config({ sentenceSource: source }).sentenceSource
  expect('接受整句来源 ' + source, parsed?.get?.() ?? parsed, source)
}
expectThrows('拒绝非字符串整句地址', () => Config({ sentenceCustomBase: 42 }))
expectThrows('拒绝非布尔开关', () => Config({ enabled: 'yes' }))
expectThrows('拒绝非字符串自定义地址', () => Config({ customBase: 42 }))

// ---- 3. 宿主 apply 在测试上下文里能完成注册（apply 内部吞异常，所以断言副作用而不是"没抛"）----
process.env.DSH_PROFILE_DIR = path.join(os.tmpdir(), `zh-typo-config-test-${process.pid}`)
let route = null
const fakeCtx = {
  webServer: { register: (next) => { route = next; return () => { route = null } } },
  effect: (fn) => { fn() },
}
plugin.apply(fakeCtx)
expect('apply 注册了模型路由', route !== null && route.path === '/zh-typo-model', true)

// configSummary 是 apply 读取 volatile refs 的唯一入口，单独钉住三种输入形状：
// undefined（测试上下文）/ Ref 对象（真实宿主）/ 普通值（非 volatile 降级环境）。
expect('导出 configSummary', typeof plugin.configSummary, 'function')
expect('configSummary 读 undefined refs 得到空快照', JSON.parse(plugin.configSummary(undefined)), {})

const refs = {}
for (const field of SETTINGS_FIELDS) refs[field] = { get: () => DEFAULT_SETTINGS[field] }
const fromRefs = JSON.parse(plugin.configSummary(refs))
expect('configSummary 读 Ref', [fromRefs.enabled, fromRefs.sensitivity, fromRefs.source], [true, 'normal', 'auto'])

const plain = {}
for (const field of SETTINGS_FIELDS) plain[field] = DEFAULT_SETTINGS[field]
plain.fluency = false // 旧用户显式关闭的设置必须保持 false。
const fromPlain = JSON.parse(plugin.configSummary(plain))
// customBase 不进启动痕迹（可能是内网地址），这里只钉住属性读取方式
expect('configSummary 兼容普通值（旧 schemastery）', [fromPlain.fluency, fromPlain.enabled], [false, true])

// 读取器抛异常 / 值不可序列化时不能影响 apply：configSummary 只写诊断，兜底成 '<unreadable>'
const throwingRefs = { enabled: { get: () => { throw new Error('boom') } } }
const fromThrowing = JSON.parse(plugin.configSummary(throwingRefs))
expect('configSummary 读取抛异常时降级', fromThrowing.enabled, '<unreadable>')

route = null
plugin.apply(fakeCtx, refs)
expect('带 refs 的 apply 也能完成注册', route !== null && route.path === '/zh-typo-model', true)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail > 0) process.exit(1)
