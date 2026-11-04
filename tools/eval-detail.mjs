/**
 * 逐句诊断：打印 L0+L1 的漏报与误报，用来决定下一步调什么。
 * node tools/eval-detail.mjs [dev|test]
 */
import { check } from '../src/core.mjs'
import { loadL1, l1Check } from '../src/l1.mjs'
import { CORPUS } from '../src/corpus.mjs'

const which = process.argv[2] ?? 'dev'
await loadL1()

const rows = CORPUS.filter((row) => row.split === which)

function matches(prediction, gold) {
  if (prediction.start >= gold.end || prediction.end <= gold.start) return false
  const suggestion = prediction.suggestions[0] ?? ''
  if (prediction.start <= gold.start && prediction.end >= gold.end) return suggestion === gold.fix
  return gold.fix.includes(suggestion)
}

const union = (text) => {
  const merged = [...check(text)]
  for (const issue of l1Check(text)) {
    if (merged.some((other) => issue.start < other.end && issue.end > other.start)) continue
    merged.push(issue)
  }
  return merged.sort((a, b) => a.start - b.start)
}

for (const row of rows) {
  if (row.kind === 'punct') continue
  const predictions = union(row.text)
  const missed = row.gold.filter((gold) => !predictions.some((p) => matches(p, gold)))
  const wrong = predictions.filter((p) => !row.gold.some((gold) => matches(p, gold)))
  if (missed.length === 0 && wrong.length === 0) continue

  console.log(`\n[${row.kind}] ${row.text}`)
  if (row.gold.length > 0) {
    console.log('   应报: ' + row.gold.map((g) => `${row.text.slice(g.start, g.end)}→${g.fix}`).join('  '))
  }
  if (missed.length > 0) console.log('   漏报: ' + missed.map((g) => `${row.text.slice(g.start, g.end)}→${g.fix}`).join('  '))
  if (wrong.length > 0) console.log('   误报: ' + wrong.map((p) => `${p.text}→${p.suggestions[0]}(${p.kind})`).join('  '))
}
