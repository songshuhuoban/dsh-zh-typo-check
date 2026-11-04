/**
 * 用**产品实际路径**跑语料：客户端 L0（规则）+ 宿主 check（模型 + 成词/同音约束）。
 *
 * 和 tools/eval-final.mjs 的区别：那边是离线实验台（直接调 transformers.js），
 * 这边走的是真正会发布的那条链（onnxruntime-node + 自写分词器 + 词表约束）。
 *
 * 运行：node tools/host-eval.mjs [dev|test|all]
 */
import path from 'node:path'
import { check } from '../src/core.mjs'
import { CORPUS } from '../src/corpus.mjs'
import { openModel } from '../src/infer.mjs'
import { loadLexicon } from '../src/lexicon.mjs'
import { checkText, loadL1 } from '../src/checker.mjs'

const which = process.argv[2] ?? 'all'
const GUARD = process.env.GUARD !== '0'

const root = path.resolve(import.meta.dirname, '..')
const dataDir = path.join(root, 'data')
const model = await openModel(
  path.join(root, 'node_modules/@huggingface/transformers/.cache/Xenova/macbert4csc-base-chinese')
)
const lexicon = GUARD ? await loadLexicon(dataDir) : null
await loadL1(dataDir)

const rows = CORPUS.filter((row) => which === 'all' || row.split === which)

function matches(prediction, gold) {
  if (prediction.start >= gold.end || prediction.end <= gold.start) return false
  const suggestion = prediction.suggestions[0] ?? ''
  if (prediction.start <= gold.start && prediction.end >= gold.end) return suggestion === gold.fix
  return gold.fix.includes(suggestion)
}

const stats = { tp: 0, fp: 0, fn: 0, fpClean: 0, clean: 0, l0: 0, l2: 0 }
const failures = []
const started = Date.now()

for (const row of rows) {
  const text = row.text
  const merged = [...check(text)].map((issue) => ({ ...issue, route: 'L0' }))
  stats.l0 += merged.length

  const hits = await checkText(model, lexicon, text)
  for (const hit of hits) {
    if (merged.some((issue) => hit.index < issue.end && hit.index + 1 > issue.start)) continue
    stats.l2 += 1
    merged.push({
      start: hit.index,
      end: hit.index + 1,
      text: hit.original,
      suggestions: [hit.candidate],
      route: hit.route,
      delta: hit.delta,
    })
  }

  merged.sort((a, b) => a.start - b.start)
  const used = new Set()
  for (const prediction of merged) {
    let hit = -1
    for (let g = 0; g < row.gold.length; g += 1) {
      if (used.has(g)) continue
      if (matches(prediction, row.gold[g])) { hit = g; break }
    }
    if (hit >= 0) { used.add(hit); stats.tp += 1 }
    else {
      stats.fp += 1
      if (row.kind === 'clean') stats.fpClean += 1
      failures.push(`误报 [${row.kind}] ${text}  ${prediction.text}→${prediction.suggestions[0]} (${prediction.route})`)
    }
  }
  for (let g = 0; g < row.gold.length; g += 1) {
    if (!used.has(g)) stats.fn += 1
  }
  if (row.kind === 'clean') stats.clean += 1
}

const precision = stats.tp + stats.fp === 0 ? 1 : stats.tp / (stats.tp + stats.fp)
const recall = stats.tp + stats.fn === 0 ? 1 : stats.tp / (stats.tp + stats.fn)
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
const pct = (v) => (v * 100).toFixed(1).padStart(5) + '%'

console.log(`\n语料 ${rows.length} 句（${which}）  A/B 两路  GUARD=${GUARD ? 'on' : 'off'}`)
console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)} s，单句 ${((Date.now() - started) / rows.length).toFixed(0)} ms`)
console.log(`上报：L0 ${stats.l0}，L2 ${stats.l2}`)
console.log('')
console.log('方案                          精确率   召回率   F1      TP  FP  FN   干净句误报')
console.log('─'.repeat(80))
console.log(
  `${'L0 规则 + 宿主模型'.padEnd(24)} ${pct(precision)}  ${pct(recall)}  ${pct(f1)}  ` +
  `${String(stats.tp).padStart(3)} ${String(stats.fp).padStart(3)} ${String(stats.fn).padStart(3)}   ` +
  `${String(stats.fpClean).padStart(2)}/${String(stats.clean).padEnd(3)}`
)
if (process.env.SHOW_FAILURES === '1') {
  console.log('\n误报明细')
  for (const line of failures) console.log('  ' + line)
}
