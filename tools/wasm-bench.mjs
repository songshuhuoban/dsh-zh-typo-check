/**
 * 量 onnxruntime-web（WASM 后端）在 Node 里的推理速度。
 *
 * 浏览器里的速度会受设备影响，但同机对比 WASM 与 native 的差距，
 * 足以决定推理该放宿主进程还是放页面里的 Worker。
 */
import fs from 'node:fs'
import path from 'node:path'
import * as ort from 'onnxruntime-web'
import { pathToFileURL } from 'node:url'

const MODEL = path.resolve(
  'node_modules/@huggingface/transformers/.cache/Xenova/macbert4csc-base-chinese/onnx/model_quantized.onnx'
)
if (!fs.existsSync(MODEL)) {
  console.error('模型不存在：', MODEL)
  process.exit(1)
}

ort.env.wasm.numThreads = 1
ort.env.wasm.simd = true
if (ort.env.wasm.wasmPaths === undefined || ort.env.wasm.wasmPaths === '') {
  ort.env.wasm.wasmPaths = pathToFileURL(path.resolve('node_modules/onnxruntime-web/dist')).href + '/'
}

console.log('加载模型…')
const started = Date.now()
const session = await ort.InferenceSession.create(fs.readFileSync(MODEL), {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
})
console.log(`session 建立 ${((Date.now() - started) / 1000).toFixed(1)} s`)
console.log('输入:', session.inputNames.join(', '))
console.log('输出:', session.outputNames.join(', '))

const LENGTH = 20
const ids = new BigInt64Array(LENGTH)
for (let i = 0; i < LENGTH; i += 1) ids[i] = BigInt(101 + (i % 500) + 100)
ids[0] = 101n
ids[LENGTH - 1] = 102n
const mask = new BigInt64Array(LENGTH).fill(1n)

const feeds = {}
const segment = new BigInt64Array(LENGTH)
for (const name of session.inputNames) {
  // token_type_ids 只能取 0/1，喂成词 id 会直接把 embedding 表打爆
  const data = name.includes('token_type') ? segment : name.includes('mask') ? mask : ids
  feeds[name] = new ort.Tensor('int64', data, [1, LENGTH])
}

// 预热
for (let i = 0; i < 2; i += 1) await session.run(feeds)

const samples = []
for (let i = 0; i < 8; i += 1) {
  const tick = process.hrtime.bigint()
  await session.run(feeds)
  samples.push(Number(process.hrtime.bigint() - tick) / 1e6)
}
samples.sort((a, b) => a - b)
console.log(`\nWASM 单次推理（${LENGTH} token）：median ${samples[Math.floor(samples.length / 2)].toFixed(0)} ms，max ${samples[samples.length - 1].toFixed(0)} ms`)
console.log('对照：native（onnxruntime-node）同模型约 21 ms/次')
