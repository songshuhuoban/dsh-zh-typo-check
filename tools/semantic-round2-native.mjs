/** Generic local scoring: no decision, text parsing, UI, or network access. */
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as ort from 'onnxruntime-node'
const require = createRequire(import.meta.url)
const [modelFile, inputFile, outputFile] = process.argv.slice(2)
if (!modelFile || !inputFile || !outputFile) throw new Error('model/input/output paths required')
const rows = JSON.parse(await fs.readFile(inputFile, 'utf8'))
const session = await ort.InferenceSession.create(modelFile, { intraOpNumThreads: 4, interOpNumThreads: 1 })
const margins = [], logits = [], elapsed = []
try {
  for (const row of rows) {
    const tick = performance.now()
    const feed = {}
    for (const name of session.inputNames) {
      const values = row.inputs[name]
      feed[name] = new ort.Tensor('int64', BigInt64Array.from(values, BigInt), [1, values.length])
    }
    const result = await session.run(feed)
    const output = Array.from((result.logits ?? Object.values(result)[0]).data, Number)
    logits.push(output)
    margins.push(output.length === 1 ? output[0] : output[1] - Math.max(output[0], output[2]))
    elapsed.push(performance.now() - tick)
  }
} finally { await session.release() }
const warm = elapsed.slice(Math.min(5, elapsed.length - 1)).sort((a,b)=>a-b)
const quantile = p => warm[Math.floor((warm.length - 1)*p)]
await fs.writeFile(outputFile, JSON.stringify({ native_version: require('onnxruntime-node/package.json').version,
  margins, logits, latency_p50_ms: quantile(.5), latency_p95_ms: quantile(.95) }) + '\n')
