/** Persistent native R13 scorer; JSON lines keep inputs separate from commands. */
import { createRequire } from 'node:module'
import readline from 'node:readline'
import * as ort from 'onnxruntime-node'

const require = createRequire(import.meta.url)
const [model] = process.argv.slice(2)
if (!model) throw new Error('A local ONNX model path is required')
const session = await ort.InferenceSession.create(model, { intraOpNumThreads: 4, interOpNumThreads: 1 })
console.log(JSON.stringify({ ready: true, native_version: require('onnxruntime-node/package.json').version }))
try {
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const request = JSON.parse(line), feed = {}, tick = performance.now()
    for (const name of session.inputNames) {
      const values = request.inputs[name]
      feed[name] = new ort.Tensor('int64', BigInt64Array.from(values, BigInt), [1, values.length])
    }
    const result = await session.run(feed)
    const values = Array.from(Object.values(result)[0].data, Number)
    if (values.length !== 1) throw new Error('Expected one binary margin')
    console.log(JSON.stringify({ raw_score: values[0], native_ms: performance.now() - tick }))
  }
} finally {
  await session.release()
}
