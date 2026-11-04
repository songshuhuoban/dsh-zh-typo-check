/**
 * 最终架构的离线评估：规则 + 同音候选 + 上下文模型，三层合流。
 *
 *   node tools/eval-final.mjs [dev|test|all]
 *
 * 三条路：
 *   L0       规则      —— 成语、标点，零延迟、高精度
 *   A 路     同音候选  —— 拼音混淆集提候选，模型给分。精度高，但抓不到读音不同的错
 *   B 路     自由候选  —— 直接问模型"这里该是什么字"，补 A 路的盲区（`还`→`话`）
 *
 * 两路都靠同一个掩码语言模型打分，区别只在候选从哪来。
 */
import { performance } from 'node:perf_hooks'
import { AutoTokenizer, AutoModelForMaskedLM, Tensor } from '@huggingface/transformers'
import { check } from '../src/core.mjs'
import { loadL1, l1Check, commonWordCoverage, homophonesOf, isKnownWord } from '../src/l1.mjs'
import { CORPUS } from '../src/corpus.mjs'

const which = process.argv[2] ?? 'all'
const MODEL = process.env.MODEL ?? 'Xenova/bert-base-chinese'
const A_MARGIN = Number(process.env.A_MARGIN ?? 2.5)
const B_MARGIN = Number(process.env.B_MARGIN ?? 6)
const MAX_POSITIONS = Number(process.env.MAX_POSITIONS ?? 12)

process.env.L1_MARGIN = '-1e9' // 只要候选，判据交给模型

const startedAt = performance.now()
const tokenizer = await AutoTokenizer.from_pretrained(MODEL)
const model = await AutoModelForMaskedLM.from_pretrained(MODEL, { dtype: 'q8' })
await loadL1()
const loadMs = performance.now() - startedAt

const CLS = tokenizer.cls_token_id ?? 101
const SEP = tokenizer.sep_token_id ?? 102
const MASK = tokenizer.mask_token_id

const CJK_IDS = []
const seen = new Set()
for (let id = 0; id < 22000; id += 1) {
  const token = tokenizer.decode([id], { skip_special_tokens: false })
  if (typeof token !== 'string' || token.length !== 1) continue
  if (!/[\u4e00-\u9fff]/u.test(token) || seen.has(token)) continue
  seen.add(token)
  CJK_IDS.push([id, token])
}
const ID_OF = new Map(CJK_IDS.map(([id, ch]) => [ch, id]))

function encodeChars(text) {
  const ids = tokenizer(text, { add_special_tokens: false }).input_ids
  const flat = Array.isArray(ids) ? ids.flat() : ids.data
  return Array.from(flat).map(Number)
}

let inferenceMs = 0
let inferences = 0

/** 掩码一个位置，给出原文分数、最优替代字、以及任意字的打分函数。 */
async function scorePosition(text, index, ids, accept = null) {
  const originalId = ids[index]
  const masked = ids.slice()
  masked[index] = MASK
  const tokens = [CLS, ...masked, SEP]
  const input = BigInt64Array.from(tokens.map((n) => BigInt(n)))
  const attention = BigInt64Array.from(new Array(tokens.length).fill(1n))

  const tick = performance.now()
  const output = await model({
    input_ids: new Tensor('int64', input, [1, tokens.length]),
    attention_mask: new Tensor('int64', attention, [1, tokens.length]),
  })
  inferenceMs += performance.now() - tick
  inferences += 1

  const tensor = output.logits ?? Object.values(output).find((value) => value?.dims?.length === 3)
  const vocabSize = tensor.dims[2]
  const row = tensor.data
  const base = (index + 1) * vocabSize
  const originalScore = Number(row[base + originalId])

  let best = null
  for (const [id, ch] of CJK_IDS) {
    if (id === originalId) continue
    if (accept !== null && !accept(ch)) continue
    const score = Number(row[base + id])
    if (best === null || score > best.score) best = { ch, score }
  }
  const scoreOf = (ch) => {
    const id = ID_OF.get(ch)
    return id === undefined ? null : Number(row[base + id])
  }
  void text
  return { originalScore, best, scoreOf }
}

/** A/B 路共用的"改完得像话"约束：成词或同音。 */
function plausible(text, index, candidate) {
  if (index > 0 && isKnownWord(text[index - 1] + candidate)) return true
  if (index + 1 < text.length && isKnownWord(candidate + text[index + 1])) return true
  return homophonesOf(text[index]).includes(candidate)
}

const rows = CORPUS.filter((row) => which === 'all' || row.split === which)

function matches(prediction, gold) {
  if (prediction.start >= gold.end || prediction.end <= gold.start) return false
  const suggestion = prediction.suggestions[0] ?? ''
  if (prediction.start <= gold.start && prediction.end >= gold.end) return suggestion === gold.fix
  return gold.fix.includes(suggestion)
}

const stats = { tp: 0, fp: 0, fn: 0, fpClean: 0, clean: 0, a: 0, b: 0 }
const perKind = new Map()
const failures = []

for (const row of rows) {
  const text = row.text
  const merged = [...check(text)]
  const ids = encodeChars(text)
  const aligned = ids.length === [...text].length

  if (aligned) {
    // ---- A 路：同音候选，模型打分 ----
    for (const proposal of l1Check(text)) {
      if (merged.some((other) => proposal.start < other.end && proposal.end > other.start)) continue
      const { originalScore, scoreOf } = await scorePosition(text, proposal.start, ids)
      const score = scoreOf(proposal.suggestions[0])
      if (score === null) continue
      if (score - originalScore < A_MARGIN) continue
      stats.a += 1
      merged.push({ ...proposal, confidence: 0.9, route: 'A' })
    }

    // ---- B 路：自由候选，补 A 路的盲区 ----
    const chars = [...text]
    const coverage = commonWordCoverage(chars.map((ch) => (/[\u4e00-\u9fff]/u.test(ch) ? ch : '\u3000')))
    const suspicious = []
    for (let i = 0; i < text.length; i += 1) {
      if (!/[\u4e00-\u9fff]/u.test(text[i])) continue
      if (coverage[i] !== Number.POSITIVE_INFINITY) continue
      suspicious.push(i)
    }

    const free = []
    for (const index of suspicious.slice(0, MAX_POSITIONS)) {
      // 只在"像话"的字里挑最优，否则模型可能给出字形上更像、但读不通的答案。
      const { originalScore, best } = await scorePosition(text, index, ids, (ch) => plausible(text, index, ch))
      if (best === null) continue
      const delta = best.score - originalScore
      if (delta < B_MARGIN) continue
      if (merged.some((other) => index < other.end && index + 1 > other.start)) continue
      free.push({ start: index, end: index + 1, delta, ch: best.ch })
    }
    free.sort((x, y) => y.delta - x.delta)
    for (const hit of free) {
      if (merged.some((other) => hit.start < other.end && hit.end > other.start)) continue
      stats.b += 1
      merged.push({
        start: hit.start,
        end: hit.end,
        text: text[hit.start],
        kind: 'mlm',
        message: `按上下文更像「${hit.ch}」`,
        suggestions: [hit.ch],
        confidence: 0.85,
        route: 'B',
      })
    }
  }

  merged.sort((a, b) => a.start - b.start)
  const used = new Set()
  for (const prediction of merged) {
    let hit = -1
    for (let g = 0; g < row.gold.length; g += 1) {
      if (used.has(g)) continue
      if (matches(prediction, row.gold[g])) { hit = g; break }
    }
    if (hit >= 0) { used.add(hit); stats.tp += 1; bump(perKind, row.kind, 'tp') }
    else {
      stats.fp += 1
      bump(perKind, row.kind, 'fp')
      if (row.kind === 'clean') stats.fpClean += 1
      failures.push(`误报 [${row.kind}] ${text}  ${prediction.text}→${prediction.suggestions[0]} (${prediction.route ?? prediction.kind})`)
    }
  }
  for (let g = 0; g < row.gold.length; g += 1) {
    if (used.has(g)) continue
    stats.fn += 1
    bump(perKind, row.kind, 'fn')
  }
  if (row.kind === 'clean') stats.clean += 1
}

function bump(map, kind, key) {
  const entry = map.get(kind) ?? { tp: 0, fp: 0, fn: 0 }
  entry[key] += 1
  map.set(kind, entry)
}

const precision = stats.tp + stats.fp === 0 ? 1 : stats.tp / (stats.tp + stats.fp)
const recall = stats.tp + stats.fn === 0 ? 1 : stats.tp / (stats.tp + stats.fn)
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
const pct = (v) => (v * 100).toFixed(1).padStart(5) + '%'

console.log(`\n语料 ${rows.length} 句（${which}）  A_MARGIN=${A_MARGIN} B_MARGIN=${B_MARGIN}`)
console.log(`模型加载 ${(loadMs / 1000).toFixed(1)} s   推理 ${inferences} 次，平均 ${(inferenceMs / Math.max(1, inferences)).toFixed(0)} ms/次，单句均摊 ${(inferenceMs / rows.length).toFixed(0)} ms`)
console.log(`上报：A 路 ${stats.a}，B 路 ${stats.b}`)
console.log('')
console.log('方案                         精确率   召回率   F1      TP  FP  FN   干净句误报')
console.log('─'.repeat(78))
console.log(
  `${'L0 + 同音候选 + 自由候选 + 模型'.padEnd(26)} ${pct(precision)}  ${pct(recall)}  ${pct(f1)}  ` +
  `${String(stats.tp).padStart(3)} ${String(stats.fp).padStart(3)} ${String(stats.fn).padStart(3)}   ` +
  `${String(stats.fpClean).padStart(2)}/${String(stats.clean).padEnd(3)}`
)
console.log('\n按类型（命中/误报/漏报）')
for (const [kind, e] of perKind) console.log(`  ${kind.padEnd(12)} ${e.tp} / ${e.fp} / ${e.fn}`)
if (process.env.SHOW_FAILURES === '1' && failures.length > 0) {
  console.log('\n误报明细')
  for (const line of failures) console.log('  ' + line)
}
