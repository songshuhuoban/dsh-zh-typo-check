/**
 * 最终架构的离线评估：词典挑位置 + 上下文模型给答案。
 *
 *   node tools/eval-mlm2.mjs [dev|test|all]
 *
 * 分工变了：拼音混淆集不再是必需的中间层。
 *   1. L0 规则        —— 成语、标点，确定性的东西，零延迟
 *   2. 词典预筛       —— 找出"没有被常用词覆盖"的可疑位置，把推理次数压到个位数
 *   3. 掩码语言模型   —— 对每个可疑位置掩码一次，看模型会不会给出明显更好的字
 *
 * 第 3 步不限于同音字，所以 `还`→`话` 这种读音完全不同的错也能抓到。
 */
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { AutoTokenizer, AutoModelForMaskedLM, Tensor } from '@huggingface/transformers'
import { check } from '../src/core.mjs'
import { loadL1, commonWordCoverage, homophonesOf, isKnownWord } from '../src/l1.mjs'
import { CORPUS } from '../src/corpus.mjs'

const which = process.argv[2] ?? 'all'
const MODEL = 'Xenova/bert-base-chinese'
const MARGIN = Number(process.env.MLM_MARGIN ?? 4.5)
const MAX_POSITIONS = Number(process.env.MLM_MAX_POSITIONS ?? 12)

const started = performance.now()
const tokenizer = await AutoTokenizer.from_pretrained(MODEL)
const model = await AutoModelForMaskedLM.from_pretrained(MODEL, { dtype: 'q8' })
await loadL1()
const loadMs = performance.now() - started

const CLS = tokenizer.cls_token_id ?? 101
const SEP = tokenizer.sep_token_id ?? 102
const MASK = tokenizer.mask_token_id

// 单字汉字 token 表：逐 id 解码一次，只在启动时跑一遍。
const CJK_IDS = []
const seen = new Set()
const vocabSize = Number(tokenizer.model?.config?.vocab_size ?? 25000)
for (let id = 0; id < Math.max(vocabSize, 22000); id += 1) {
  const token = tokenizer.decode([id], { skip_special_tokens: false })
  if (typeof token !== 'string' || token.length !== 1) continue
  if (!/[\u4e00-\u9fff]/u.test(token)) continue
  if (seen.has(token)) continue
  seen.add(token)
  CJK_IDS.push([id, token])
}
const ID_OF = new Map(CJK_IDS.map(([id, ch]) => [ch, id]))
console.log(`CJK 单字 token：${CJK_IDS.length}`)

function encodeChars(text) {
  const ids = tokenizer(text, { add_special_tokens: false }).input_ids
  const flat = Array.isArray(ids) ? ids.flat() : ids.data
  return Array.from(flat).map(Number)
}

let inferenceMs = 0
let inferences = 0

/**
 * 掩码一个位置，返回原文分数与最好的替代字。
 * @param text 句子
 * @param index 字下标
 * @param ids 已经编码好的 token
 */
async function scorePosition(text, index, ids) {
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

  const outVocab = output.logits.dims[2]
  const row = output.logits.data
  const base = (index + 1) * outVocab
  const originalScore = Number(row[base + originalId])

  let best = null
  for (const [id, ch] of CJK_IDS) {
    if (id === originalId) continue
    const score = Number(row[base + id])
    if (best === null || score > best.score) best = { ch, id, score }
  }
  void text
  return { originalScore, best, delta: best.score - originalScore }
}


/**
 * 改完必须"像话"：要么和邻字组成词典词（`的话`、`再次`），要么本身就是同音字。
 * 这一条把大量"语法上行但没必要改"的风格建议挡在外面。
 */
function plausible(text, index, candidate) {
  const left = index > 0 ? text[index - 1] + candidate : null
  const right = index + 1 < text.length ? candidate + text[index + 1] : null
  if (left !== null && isKnownWord(left)) return true
  if (right !== null && isKnownWord(right)) return true
  return homophonesOf(text[index]).includes(candidate)
}
const rows = CORPUS.filter((row) => which === 'all' || row.split === which)

function matches(prediction, gold) {
  if (prediction.start >= gold.end || prediction.end <= gold.start) return false
  const suggestion = prediction.suggestions[0] ?? ''
  if (prediction.start <= gold.start && prediction.end >= gold.end) return suggestion === gold.fix
  return gold.fix.includes(suggestion)
}

const stats = { tp: 0, fp: 0, fn: 0, fpClean: 0, clean: 0, scanned: 0, proposed: 0 }
const perKind = new Map()
const failures = []

for (const row of rows) {
  const merged = [...check(row.text)]
  const text = row.text
  const ids = encodeChars(text)

  if (ids.length === [...text].length) {
    // 逐段挑可疑位置
    const positions = []
    for (let i = 0; i < text.length; i += 1) {
      if (!/[\u4e00-\u9fff]/u.test(text[i])) continue
      // 每段连续汉字的覆盖率需要重新算，这里用整句近似：整句切分后看该字是否被常用词覆盖
      positions.push(i)
    }
    const coverage = commonWordCoverage([...text].map((ch) => (/[\u4e00-\u9fff]/u.test(ch) ? ch : '\u3000')))
    const suspicious = positions.filter((i) => coverage[i] === Number.POSITIVE_INFINITY).slice(0, MAX_POSITIONS)
    stats.scanned += suspicious.length

    const proposals = []
    for (const index of suspicious) {
      const { delta, best } = await scorePosition(text, index, ids)
      if (delta < MARGIN) continue
      if (!plausible(text, index, best.ch)) continue
      proposals.push({ start: index, end: index + 1, delta, ch: best.ch })
    }
    // 一句话里只留最强的几处，且不能和已经报过的区间重叠：
    // 同一个词上同时报「在→再」和「次→此」是纯噪音。
    proposals.sort((a, b) => b.delta - a.delta)
    for (const proposal of proposals) {
      if (merged.some((other) => proposal.start < other.end && proposal.end > other.start)) continue
      stats.proposed += 1
      merged.push({
        start: proposal.start,
        end: proposal.end,
        text: text[proposal.start],
        kind: 'mlm',
        message: `按上下文更像「${proposal.ch}」`,
        suggestions: [proposal.ch],
        confidence: 0.9,
        mlm: Number(proposal.delta.toFixed(2)),
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
      failures.push(`误报 ${row.text}  ${prediction.text}→${prediction.suggestions[0]} (${prediction.kind})`)
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

console.log(`\n语料 ${rows.length} 句（${which}）  MARGIN=${MARGIN}`)
console.log(`模型加载 ${(loadMs / 1000).toFixed(1)} s   扫描位置 ${stats.scanned}，触发上报 ${stats.proposed}`)
console.log(`推理 ${inferences} 次，平均 ${(inferenceMs / Math.max(1, inferences)).toFixed(0)} ms/次，单句均摊 ${(inferenceMs / rows.length).toFixed(0)} ms`)
console.log('')
console.log('方案                              精确率   召回率   F1      TP  FP  FN   干净句误报')
console.log('─'.repeat(84))
console.log(
  `${'L0 + 词典预筛 + 掩码模型'.padEnd(30)} ${pct(precision)}  ${pct(recall)}  ${pct(f1)}  ` +
  `${String(stats.tp).padStart(3)} ${String(stats.fp).padStart(3)} ${String(stats.fn).padStart(3)}   ` +
  `${String(stats.fpClean).padStart(2)}/${String(stats.clean).padEnd(3)}`
)
console.log('\n按类型（命中/误报/漏报）')
for (const [kind, e] of perKind) console.log(`  ${kind.padEnd(12)} ${e.tp} / ${e.fp} / ${e.fn}`)
if (failures.length > 0 && process.env.SHOW_FAILURES === '1') {
  console.log('\n误报明细')
  for (const line of failures) console.log('  ' + line)
}
