/** Measure both frozen whole-input sessions sequentially; no decisions/network. */
import fs from 'node:fs/promises'
import * as ort from 'onnxruntime-node'
const [firstFile, secondFile, inputFile, outputFile] = process.argv.slice(2)
const rows = JSON.parse(await fs.readFile(inputFile, 'utf8'))
const options = { intraOpNumThreads: 4, interOpNumThreads: 1 }
const first = await ort.InferenceSession.create(firstFile, options)
const second = await ort.InferenceSession.create(secondFile, options)
const elapsed = [], pairs = []
const margin = values => Number(values[1]) - Math.max(Number(values[0]), Number(values[2]))
try {
  for (const row of rows) {
    const tick = performance.now(), a = {}, b = {}
    for (const name of first.inputNames) {
      const values = row.inputs[`z_${name}`]
      a[name] = new ort.Tensor('int64', BigInt64Array.from(values, BigInt), [1, values.length])
    }
    for (const name of second.inputNames) {
      const values = row.inputs[name]
      b[name] = new ort.Tensor('int64', BigInt64Array.from(values, BigInt), [1, values.length])
    }
    const one = await first.run(a), two = await second.run(b)
    pairs.push([margin(one.logits.data), margin(two.logits.data)])
    elapsed.push(performance.now() - tick)
  }
} finally { await first.release(); await second.release() }
const warm = elapsed.slice(Math.min(5, elapsed.length - 1)).sort((a, b) => a - b)
const at = p => warm[Math.floor((warm.length - 1) * p)]
await fs.writeFile(outputFile, JSON.stringify({pairs, latency_p50_ms: at(.5), latency_p95_ms: at(.95)})+'\n')
