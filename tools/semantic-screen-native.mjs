/** Check the shortlisted prototype against the plugin's actual native runtime. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import * as ort from 'onnxruntime-node'
const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = path.join(root, '.research', 'semantic-screen')
const input = JSON.parse(await fs.readFile(path.join(work, 'electra-small-finetuned-native-inputs.json'), 'utf8'))
const session = await ort.InferenceSession.create(path.join(work, 'electra-small-finetuned-int8.onnx'), {
  intraOpNumThreads: 4, interOpNumThreads: 1,
})
let maxLogitDrift = 0
let decisionChanges = 0
const predictions = []
const calibration = []
const run = async row => {
  const feed = {}
  for (const name of session.inputNames) {
    const values = row.inputs[name]
    feed[name] = new ort.Tensor('int64', BigInt64Array.from(values, n => BigInt(n)), [1, values.length])
  }
  const result = await session.run(feed)
  return Number((result.logits ?? Object.values(result)[0]).data[0])
}
try {
  for (const row of input.cal) calibration.push(await run(row))
  for (const row of input.rows) {
    const score = await run(row)
    const warning = score > input.threshold
    maxLogitDrift = Math.max(maxLogitDrift, Math.abs(score - row.score))
    if (warning !== row.warning) decisionChanges += 1
    predictions.push({ label: row.label, score, warning })
  }
} finally { await session.release() }
const report = { protocol: 'same 70 tokenized fixtures; Node plugin dependency vs Python ORT 1.23.2',
  nativeVersion: require('onnxruntime-node/package.json').version,
  maxLogitDrift, decisionChanges, samples: predictions.length }
calibration.sort((a, b) => a - b)
report.nativeThreshold = calibration[Math.ceil(.99 * (calibration.length - 1))]
report.calibrationSamples = calibration.length
report.native_calibration_false_positives = calibration.filter(v => v > report.nativeThreshold).length
report.native_calibrated_metrics = {}
for (const [label, name] of [[0, 'false_positive_rate'], [1, 'recall'], [-1, 'uncertain_warning_rate']]) {
  const rows = predictions.filter(r => r.label === label)
  report[name + '_count'] = [rows.filter(r => r.warning).length, rows.length]
  report.native_calibrated_metrics[name + '_count'] = [rows.filter(r => r.score > report.nativeThreshold).length, rows.length]
}
await fs.writeFile(path.join(work, 'native-runtime-check.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
if (decisionChanges !== 0) process.exitCode = 1
