/** Actual packaged route, isolated profile; never alters the user's DSH. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check } from '../src/core.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = path.join(root, '.research', 'semantic-screen')
const profile = path.join(work, 'baseline-profile')
const target = path.join(profile, 'models', 'zh-typo-check')
const cache = path.join(root, 'node_modules', '@huggingface', 'transformers', '.cache', 'Xenova', 'macbert4csc-base-chinese')
await fs.mkdir(target, { recursive: true })
for (const [source, name] of [['tokenizer.json', 'tokenizer.json'], ['onnx/model_quantized.onnx', 'model_quantized.onnx']]) {
  try { await fs.link(path.join(cache, source), path.join(target, name)) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
process.env.DSH_PROFILE_DIR = profile
const { apply } = await import('../bundle/index.js')
let route
const disposers = []
apply({
  webServer: { register(next) { route = next; return () => { route = null } } },
  effect(fn) { const off = fn(); if (typeof off === 'function') disposers.push(off) },
})
const fixture = JSON.parse(await fs.readFile(path.join(root, 'data/mixed-semantic-screen.json'), 'utf8'))
const predictions = []
try {
  for (const [category, label, text] of fixture.rows) {
    const query = new URLSearchParams({ text, delta: '12' })
    const response = await route.resource(new Request('http://localhost/zh-typo-model/check?' + query))
    const result = await response.json()
    if (result.state !== 'ready' || result.reason !== 'checked') throw new Error(JSON.stringify(result))
    const specific = check(text).length + result.issues.length
    predictions.push({ category, label, text, specific, warning: specific === 0 && result.fluency?.low === true,
      fluency: result.fluency, ms: result.ms })
  }
} finally {
  for (const off of disposers.reverse()) await off()
}
const metrics = {}
for (const [label, name] of [[0, 'false_positive_rate'], [1, 'recall'], [-1, 'uncertain_warning_rate']]) {
  const rows = predictions.filter(r => r.label === label)
  const hits = rows.filter(r => r.warning).length
  metrics[name] = rows.length ? hits / rows.length : null
  metrics[name + '_count'] = [hits, rows.length]
}
const report = { version: JSON.parse(await fs.readFile(path.join(root, 'bundle/package.json'), 'utf8')).version,
  protocol: 'actual bundled /check + rules; fluency enabled; sentence warning only when no specific issue, as client computeView does',
  metrics, predictions }
await fs.writeFile(path.join(work, 'current-baseline-result.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ version: report.version, metrics }))
