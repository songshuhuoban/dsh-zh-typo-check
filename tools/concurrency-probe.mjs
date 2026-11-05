/**
 * 并发压力测试：同一进程内并发发 N 个 check，看宿主是排队还是互相拖慢。
 * 运行：node tools/concurrency-probe.mjs
 */
const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:56736'
const TEXT = encodeURIComponent('这个方案的风显太高了，我们可以再想想。')
const URL_ = `${BASE}/zh-typo-model/check?text=${TEXT}&delta=12`

async function once() {
  const started = Date.now()
  const response = await fetch(URL_)
  const body = await response.json()
  return { wall: Date.now() - started, ms: body.ms ?? null, issues: body.issues?.length ?? 0 }
}

// 预热：把模型加载掉，避免首次加载干扰
await once()

const N = 6
const started = Date.now()
const results = await Promise.all(Array.from({ length: N }, once))
const total = Date.now() - started

console.log(`并发 ${N} 个请求`)
console.log(`  总墙钟: ${total} ms`)
console.log(`  单次墙钟: ${results.map((r) => r.wall).join(', ')}`)
console.log(`  服务端耗时: ${results.map((r) => r.ms).join(', ')}`)
console.log(`  命中数: ${results.map((r) => r.issues).join(', ')}`)

const seq = []
for (let i = 0; i < N; i += 1) seq.push(await once())
console.log(`\n串行 ${N} 个请求`)
console.log(`  总墙钟: ${seq.reduce((sum, r) => sum + r.wall, 0)} ms`)
console.log(`  单次墙钟: ${seq.map((r) => r.wall).join(', ')}`)
