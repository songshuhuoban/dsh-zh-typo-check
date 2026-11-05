/**
 * 在现有语料上验证「通顺度」信号的分离度：正常句 vs 有错句。
 * 打分 = 逐字掩码后，模型给"原来的字"的 logit 平均值。
 */
import path from 'node:path'
import { openModel, encode, scoreIndex } from '../src/infer.mjs'
import { CORPUS } from '../src/corpus.mjs'

const root = path.resolve(import.meta.dirname, '..')
const model = await openModel(
  path.join(root, 'node_modules/@huggingface/transformers/.cache/Xenova/macbert4csc-base-chinese')
)

const CJK = /[\u4e00-\u9fff]/u

async function fluency(text) {
  const { ids, aligned } = encode(model, text)
  if (!aligned) return null
  const scores = []
  for (let i = 0; i < text.length; i += 1) {
    if (!CJK.test(text[i])) continue
    const row = await scoreIndex(model, ids, i, { topK: 1 })
    scores.push(row.original)
  }
  if (scores.length === 0) return null
  return {
    avg: scores.reduce((s, v) => s + v, 0) / scores.length,
    min: Math.min(...scores),
  }
}

const clean = []
const broken = []
for (const row of CORPUS) {
  const value = await fluency(row.text)
  if (value === null) continue
  ;(row.kind === 'clean' ? clean : broken).push({ ...value, text: row.text, kind: row.kind })
}

const stat = (rows) => {
  const sorted = rows.map((r) => r.avg).sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  return { n: sorted.length, min: sorted[0], p10: at(0.1), median: at(0.5), max: sorted[sorted.length - 1] }
}

const f = (v) => v.toFixed(2).padStart(7)
const c = stat(clean)
const b = stat(broken)
console.log(`正常句 ${c.n} 条:  最低 ${f(c.min)}  p10 ${f(c.p10)}  中位 ${f(c.median)}  最高 ${f(c.max)}`)
console.log(`有错句 ${b.n} 条:  最低 ${f(b.min)}  p10 ${f(b.p10)}  中位 ${f(b.median)}  最高 ${f(b.max)}`)

console.log('\n正常句里最低的 6 条：')
for (const row of clean.sort((x, y) => x.avg - y.avg).slice(0, 6)) {
  console.log(`  ${f(row.avg)}  ${row.text}`)
}
console.log('\n有错句里最高的 6 条（最像正常句）：')
for (const row of broken.sort((x, y) => y.avg - x.avg).slice(0, 6)) {
  console.log(`  ${f(row.avg)}  [${row.kind}] ${row.text}`)
}
