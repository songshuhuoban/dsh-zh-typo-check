/**
 * L0 vs L1 离线评估。
 *
 *   node tools/eval.mjs          # dev + test 一起看
 *   node tools/eval.mjs dev      # 只调参用
 *   node tools/eval.mjs test     # 只验收用
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { check } from '../src/core.mjs'
import { loadL1, l1Check } from '../src/l1.mjs'
import { CORPUS } from '../src/corpus.mjs'

const which = process.argv[2] ?? 'all'
const root = path.resolve(import.meta.dirname, '..')

const loadStarted = performance.now()
await loadL1()
const loadMs = performance.now() - loadStarted

const rows = CORPUS.filter((row) => which === 'all' || row.split === which)

/** 预测与标准答案是否对得上：区间有交集，且给出的改法在该区间里成立。 */
function matches(prediction, gold) {
  if (prediction.start >= gold.end || prediction.end <= gold.start) return false
  const suggestion = prediction.suggestions[0] ?? ''
  if (prediction.start <= gold.start && prediction.end >= gold.end) return suggestion === gold.fix
  return gold.fix.includes(suggestion)
}

function evaluate(label, detector) {
  const stats = { tp: 0, fp: 0, fn: 0, fpClean: 0, clean: 0 }
  const perKind = new Map()
  const started = performance.now()
  let calls = 0

  for (const row of rows) {
    const predictions = detector(row.text)
    calls += 1
    const golds = row.gold
    const used = new Set()

    for (const prediction of predictions) {
      let hit = -1
      for (let g = 0; g < golds.length; g += 1) {
        if (used.has(g)) continue
        if (matches(prediction, golds[g])) { hit = g; break }
      }
      if (hit >= 0) {
        used.add(hit)
        stats.tp += 1
        bump(perKind, row.kind, 'tp')
      } else {
        stats.fp += 1
        bump(perKind, row.kind, 'fp')
        if (row.kind === 'clean') stats.fpClean += 1
      }
    }
    for (let g = 0; g < golds.length; g += 1) {
      if (used.has(g)) continue
      stats.fn += 1
      bump(perKind, row.kind, 'fn')
    }
    if (row.kind === 'clean') stats.clean += 1
  }

  const elapsed = performance.now() - started
  const precision = stats.tp + stats.fp === 0 ? 1 : stats.tp / (stats.tp + stats.fp)
  const recall = stats.tp + stats.fn === 0 ? 1 : stats.tp / (stats.tp + stats.fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  return {
    label,
    ...stats,
    precision,
    recall,
    f1,
    msPerCall: elapsed / Math.max(1, calls),
    perKind,
  }
}

function bump(map, kind, key) {
  const entry = map.get(kind) ?? { tp: 0, fp: 0, fn: 0 }
  entry[key] += 1
  map.set(kind, entry)
}

const union = (text) => {
  const l0 = check(text)
  const l1 = l1Check(text)
  const merged = [...l0]
  for (const issue of l1) {
    if (merged.some((other) => issue.start < other.end && issue.end > other.start)) continue
    merged.push(issue)
  }
  return merged.sort((a, b) => a.start - b.start)
}

const results = [
  evaluate('L0 规则', (text) => check(text)),
  evaluate('L1 混淆+词频', (text) => l1Check(text)),
  evaluate('L0 + L1', union),
]

const pct = (value) => (value * 100).toFixed(1).padStart(5) + '%'
console.log(`\n语料：${rows.length} 句（${which}）  L1 加载 ${loadMs.toFixed(0)} ms\n`)
console.log('方案            精确率   召回率   F1      TP  FP  FN   干净句误报   单句耗时')
console.log('─'.repeat(84))
for (const r of results) {
  console.log(
    `${r.label.padEnd(14)} ${pct(r.precision)}  ${pct(r.recall)}  ${pct(r.f1)}  ` +
    `${String(r.tp).padStart(3)} ${String(r.fp).padStart(3)} ${String(r.fn).padStart(3)}   ` +
    `${String(r.fpClean).padStart(2)}/${String(r.clean).padEnd(3)}     ${r.msPerCall.toFixed(2)} ms`
  )
}

console.log('\n按错误类型拆分（命中/误报/漏报）')
console.log('─'.repeat(84))
const kinds = [...new Set(rows.map((row) => row.kind))]
console.log('方案            ' + kinds.map((k) => k.padEnd(20)).join(''))
for (const r of results) {
  const cells = kinds.map((kind) => {
    const e = r.perKind.get(kind) ?? { tp: 0, fp: 0, fn: 0 }
    return `${e.tp} / ${e.fp} / ${e.fn}`.padEnd(20)
  })
  console.log(r.label.padEnd(16) + cells.join(''))
}

// ---- 体积 ----
const kb = (bytes) => (bytes / 1024).toFixed(0)
const gzipKb = (buffer) => (zlib.gzipSync(buffer).length / 1024).toFixed(0)
const files = ['data/l1-words.txt', 'data/l1-sounds.txt', 'src/l1.mjs', 'src/core.mjs']
console.log('\n体积')
console.log('─'.repeat(84))
let rawTotal = 0
let gzTotal = 0
for (const file of files) {
  const buffer = fs.readFileSync(path.join(root, file))
  rawTotal += buffer.length
  gzTotal += zlib.gzipSync(buffer).length
  console.log(`${file.padEnd(24)} ${kb(buffer.length).padStart(6)} KB    gzip ${gzipKb(buffer).padStart(5)} KB`)
}
console.log(`${'合计'.padEnd(24)} ${kb(rawTotal).padStart(6)} KB    gzip ${gzTotal <= 0 ? 0 : kb(gzTotal).padStart(5)} KB`)
