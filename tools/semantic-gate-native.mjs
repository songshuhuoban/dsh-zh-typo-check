/** Native small learned gate, optionally with both whole-input base models. */
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as ort from 'onnxruntime-node'
const require = createRequire(import.meta.url)
const [mode, ...args] = process.argv.slice(2)
if (!['pairs', 'full'].includes(mode)) throw new Error('pairs/full mode required')
const [firstFile, secondFile, gateFile, inputFile, outputFile] = mode === 'full' ? args : ['', '', ...args]
const options = { intraOpNumThreads: 4, interOpNumThreads: 1 }
const gate = await ort.InferenceSession.create(gateFile, options)
const first = mode === 'full' ? await ort.InferenceSession.create(firstFile, options) : null
const second = mode === 'full' ? await ort.InferenceSession.create(secondFile, options) : null
const rows = JSON.parse(await fs.readFile(inputFile, 'utf8'))
const logits = [], margins = [], pairs = [], elapsed = []
try {
  for (const row of rows) {
    const tick = performance.now()
    let pair = row
    if (mode === 'full') {
      const a = {}, b = {}
      for (const name of first.inputNames) {
        const v = row.inputs[`z_${name}`]
        a[name] = new ort.Tensor('int64', BigInt64Array.from(v, BigInt), [1, v.length])
      }
      for (const name of second.inputNames) {
        const v = row.inputs[name]
        b[name] = new ort.Tensor('int64', BigInt64Array.from(v, BigInt), [1, v.length])
      }
      const one = await first.run(a), two = await second.run(b)
      pair = [...one.logits.data, ...two.logits.data].map(Number)
    }
    const result = await gate.run({logits_pair: new ort.Tensor('float32', Float32Array.from(pair), [1, 6])})
    const values = [...result.logits.data].map(Number)
    logits.push(values); pairs.push(pair); margins.push(values[1] - Math.max(values[0], values[2]))
    elapsed.push(performance.now() - tick)
  }
} finally { await gate.release(); if (first) await first.release(); if (second) await second.release() }
const warm = elapsed.slice(Math.min(5, elapsed.length - 1)).sort((a,b)=>a-b)
const q = p => warm[Math.floor((warm.length-1)*p)]
await fs.writeFile(outputFile, JSON.stringify({native_version: require('onnxruntime-node/package.json').version,
  logits, margins, pairs, latency_p50_ms: q(.5), latency_p95_ms: q(.95)})+'\n')
