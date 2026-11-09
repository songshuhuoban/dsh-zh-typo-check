/**
 * `check` 路由的端到端验证：真的把模型读起来、真的跑一次推理。
 *
 * 用硬链接把模型放进临时 profile 目录，不复制 99 MB，也不污染真实 profile。
 *
 * 运行：node tools/infer-route-test.mjs
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const tmp = path.join(root, '.tmp-infer-test')
const models = path.join(tmp, 'models', 'zh-typo-check')
const cache = path.join(root, 'node_modules/@huggingface/transformers/.cache/Xenova/macbert4csc-base-chinese')

await fsp.mkdir(models, { recursive: true })
fs.linkSync(path.join(cache, 'tokenizer.json'), path.join(models, 'tokenizer.json'))
fs.linkSync(path.join(cache, 'onnx', 'model_quantized.onnx'), path.join(models, 'model_quantized.onnx'))

process.env.DSH_PROFILE_DIR = tmp
delete process.env.ZH_TYPO_MODEL_URL

const { apply } = await import('../bundle/index.js')
let route = null
apply({
  webServer: { register: (next) => { route = next; return () => { route = null } } },
  effect: (fn) => { fn() },
})

const failed = []
const check = (label, ok, detail = '') => {
  if (ok) console.log(`PASS  ${label}`)
  else { failed.push(label); console.log(`FAIL  ${label}  ${detail}`) }
}

/**
 * 按 webServer 的真实规则匹配路由：
 *   pathname === prefix || pathname.startsWith(prefix + '/')
 * 之前的测试直接调 route.resource()，绕过了匹配环节——前缀写成带尾斜杠也没人发现。
 */
function resolve(pathname) {
  if (route === null) return null
  if (pathname === route.path) return route
  return pathname.startsWith(String(route.path) + '/') ? route : null
}

async function call(sub) {
  const pathname = '/zh-typo-model/' + sub
  const matched = resolve(pathname.split('?')[0])
  if (matched === null) return { status: 404, body: { state: 'unmatched', issues: [] } }
  const response = await matched.resource(new Request(`http://127.0.0.1:64024${pathname}`))
  return { status: response.status, body: await response.json() }
}

// 未装模型时应明确返回"只有规则"
await fsp.rm(path.join(models, 'model_quantized.onnx'), { force: true })
const partial = await call('check?text=' + encodeURIComponent('我到上海住的还'))
check('缺主模型时 state=partial', partial.body.state === 'partial', JSON.stringify(partial.body))
check('不完整时不报问题', partial.body.issues.length === 0)

// 两个文件都没有才是真正的 absent
await fsp.rm(path.join(models, 'tokenizer.json'), { force: true })
const absent = await call('check?text=' + encodeURIComponent('我到上海住的还'))
check('两个文件都缺时 state=absent', absent.body.state === 'absent', JSON.stringify(absent.body))
check('无模型时不报问题', absent.body.issues.length === 0)

// 放回两个文件
fs.linkSync(path.join(cache, 'tokenizer.json'), path.join(models, 'tokenizer.json'))
fs.linkSync(path.join(cache, 'onnx', 'model_quantized.onnx'), path.join(models, 'model_quantized.onnx'))
const status = await call('status')
check('模型就绪', status.body.state === 'ready', JSON.stringify(status.body))
check('报告推理运行时可用', status.body.runtime === true, String(status.body.runtime))

const started = Date.now()
const real = await call('check?text=' + encodeURIComponent('我到上海住的还，可以经常包斯成晚餐咯~'))
const elapsed = Date.now() - started
console.log(`  首次检查 ${elapsed} ms，命中 ${real.body.issues.map((i) => `${i.original}→${i.candidate}`).join(' ') || '（无）'}`)
check('返回 ready', real.body.state === 'ready', JSON.stringify(real.body).slice(0, 120))
check('抓到「还」→「话」', real.body.issues.some((i) => i.original === '还' && i.candidate === '话'))
check('带位置信息', real.body.issues.every((i) => Number.isInteger(i.index) && i.index > 0))

// 稳态延迟：模型已经在内存里之后再检查一次
const warmTick = Date.now()
await call('check?text=' + encodeURIComponent('我到上海住的还，可以经常包斯成晚餐咯~'))
const warm = Date.now() - warmTick
console.log(`  稳态检查 ${warm} ms（模型已加载，按上限取 7 个位置）`)
check('稳态检查 < 500 ms', warm < 500, `${warm} ms`)

// 自检路由：重启后一条 curl 就能看清每一层
const self = await call('selftest')
console.log('  自检: ' + self.body.steps.map((s) => `${s.name}=${s.ok ? 'ok' : 'FAIL'}`).join(' '))
check('自检整体通过', self.body.ok === true, JSON.stringify(self.body.steps.filter((s) => !s.ok)))
check('自检看到已就绪的模型', self.body.model?.state === 'ready', String(self.body.model?.state))
const selfCheck = self.body.steps.find((s) => s.name === 'check')
check('自检端到端抓到「还」→「话」',
  Array.isArray(selfCheck?.value) && selfCheck.value.some((v) => v.includes('还→话')),
  JSON.stringify(selfCheck))

const clean = await call('check?text=' + encodeURIComponent('今天的天气很好，我们一起去公园散步吧。'))
check('正常句子无命中', clean.body.issues.length === 0, JSON.stringify(clean.body.issues))

const tooLong = await call('check?text=' + encodeURIComponent('好'.repeat(501)))
check('超长文本直接跳过', tooLong.body.issues.length === 0)

const empty = await call('check?text=')
check('空文本不报错', empty.status === 200 && empty.body.issues.length === 0)


// 灵敏度参数：阈值调高后，Δ 不够的候选应该被压掉
const strict = await call('check?text=' + encodeURIComponent('他弟弟长得很象他。') + '&delta=15')
const loose = await call('check?text=' + encodeURIComponent('他弟弟长得很象他。') + '&delta=9')
check('灵敏度调高会压掉弱候选', strict.body.issues.length === 0, JSON.stringify(strict.body.issues))
check('灵敏度调低仍会报', loose.body.issues.some((i) => i.original === '象'), JSON.stringify(loose.body.issues))

// 不带 delta 参数时必须用默认阈值，不能被 Number(null)=0 带偏
const dflt = await call('check?text=' + encodeURIComponent('他弟弟长得很象他。'))
check('缺省 delta 走默认阈值', dflt.body.issues.some((i) => i.original === '象'), JSON.stringify(dflt.body.issues))

// 并发相同请求应共用一次推理（否则宿主会排队，最新的一句反而最晚回来）
const dupUrl = 'check?text=' + encodeURIComponent('这个方案的风显太高了，我们可以再想想。') + '&delta=12'
const singleTick = Date.now()
const single = await call(dupUrl)
const singleMs = Date.now() - singleTick
const concTick = Date.now()
const burst = await Promise.all([call(dupUrl), call(dupUrl), call(dupUrl)])
const concMs = Date.now() - concTick
console.log(`  单次 ${singleMs} ms，并发 3 次共 ${concMs} ms`)
check('并发结果与单次一致',
  burst.every((r) => JSON.stringify(r.body.issues) === JSON.stringify(single.body.issues)),
  JSON.stringify(burst.map((r) => r.body.issues.length)))
check('并发请求被合并（不到串行的两倍）', concMs < singleMs * 2, `${concMs} vs ${singleMs}`)

// 通顺度：复用逐字打分，正常句显著高于乱敲句
const fluencyOf = async (text) => {
  const r = await call('check?text=' + encodeURIComponent(text) + '&delta=12')
  return r.body.fluency
}
const normal = await fluencyOf('今天的天气不错，我们去公园走走吧。')
const garbled = await fluencyOf('第五个i红啊数据库更好')
// 中英混排：英文词会让 token 数 ≠ 字符数；之前整句被判 not-aligned 直接跳过，
// 用户看到的就是「开了模型/通顺度也完全没反应」。
const mixed = await call('check?text=' + encodeURIComponent('我到上海住的还，可以用API测试') + '&delta=12')
check('中英混排仍能抓到「还」→「话」',
  mixed.body.aligned === true && mixed.body.issues.some((i) => i.original === '还' && i.candidate === '话'),
  JSON.stringify({ aligned: mixed.body.aligned, issues: mixed.body.issues }))
const mixedGarbled = await fluencyOf('你公司大佛IG你哦as士大夫回家英特人阿斯顿')
check('中英混排乱句仍返回通顺度', mixedGarbled !== null && mixedGarbled.samples > 0, JSON.stringify(mixedGarbled))
check('中英混排乱句被判为不通顺', mixedGarbled !== null && mixedGarbled.low === true, String(mixedGarbled?.avg))
console.log(`  正常 ${normal?.avg}，乱敲 ${garbled?.avg}，混排乱句 ${mixedGarbled?.avg}（阈值 ${normal?.threshold}）`)
check('正常句不被判为不通顺', normal !== null && normal.low === false, String(normal?.avg))
check('乱敲句被判为不通顺', garbled !== null && garbled.low === true, String(garbled?.avg))
check('通顺度来自已有打分（有采样数）', normal !== null && normal.samples > 0, String(normal?.samples))
await fsp.rm(tmp, { recursive: true, force: true })
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败：${failed.join('、')}`}`)
process.exit(failed.length === 0 ? 0 : 1)
