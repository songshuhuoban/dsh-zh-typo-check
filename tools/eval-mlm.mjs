/**
 * L0 + L1 候选 + 上下文模型重打分 的离线评估。
 *
 *   node tools/eval-mlm.mjs [dev|test|all]
 *
 * 分工：
 *   L1 的拼音混淆集  → 提出候选（便宜，本地，无需模型）
 *   中文 BERT 的 MLM → 判断这个候选在整句里是不是比原文更顺（贵，需要模型）
 *   L0 规则         → 管成语、标点这些确定性错误
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { AutoTokenizer, AutoModelForMaskedLM, Tensor } from '@huggingface/transformers'
import { check } from '../src/core.mjs'
import { loadL1, l1Check } from '../src/l1.mjs'
import { CORPUS } from '../src/corpus.mjs'

const which = process.argv[2] ?? 'all'
const MODEL = 'Xenova/bert-base-chinese'
const MLM_MARGIN = Number(process.env.MLM_MARGIN ?? 2.5)

process.env.L1_MARGIN = '-1e9' // 只取候选，判据交给模型

const loadStarted = performance.now()
const tokenizer = await AutoTokenizer.from_pretrained(MODEL)
const model = await AutoModelForMaskedLM.from_pretrained(MODEL, { dtype: 'q8' })
await loadL1()
const loadMs = performance.now() - loadStarted

const CLS = tokenizer.cls_token_id ?? 101
const SEP = tokenizer.sep_token_id ?? 102
const MASK = tokenizer.mask_token_id

function encodeChars(text) {
  const ids = tokenizer(text, { add_special_tokens: false }).input_ids
  const flat = Array.isArray(ids) ? ids.flat() : ids.data
  return Array.from(flat).map(Number)
}

let inferenceMs = 0
let inferences = 0

/** 在 index 处掩码，返回候选字相对原文的对数概率差。 */
async function rerank(text, index, candidate) {
  const ids = encodeChars(text)
  const candidateId = encodeChars(candidate)[0]
  if (ids.length !== [...text].length) return null // 分词不是一字一 token，放弃对齐
  const masked = ids.slice()
  const originalId = masked[index]
  masked[index] = MASK
  const tokens = [CLS, ...masked, SEP]
  const input = BigInt64Array.from(tokens.map((n) => BigInt(n)))
  const attention = BigInt64Array.from(new Array(tokens.length).fill(1n))

  const started = performance.now()
  const output = await model({
    input_ids: new Tensor('int64', input, [1, tokens.length]),
    attention_mask: new Tensor('int64', attention, [1, tokens.length]),
  })
  inferenceMs += performance.now() - started
  inferences += 1

  const logits = output.logits
  const vocab = logits.dims[2]
  const row = logits.data
  const offset = (index + 1) * vocab
  return Number(row[offset + candidateId]) - Number(row[offset + originalId])
}

const rows = CORPUS.filter((row) => which === 'all' || row.split === which)

function matches(prediction, gold) {
  if (prediction.start >= gold.end || prediction.end <= gold.start) return false
  const suggestion = prediction.suggestions[0] ?? ''
  if (prediction.start <= gold.start && prediction.end >= gold.end) return suggestion === gold.fix
  return gold.fix.includes(suggestion)
}

async function evaluateMlm() {
  const stats = { tp: 0, fp: 0, fn: 0, fpClean: 0, clean: 0, kept: 0, dropped: 0 }
  const perKind = new Map()

  for (const row of rows) {
    const merged = [...check(row.text)]
    for (const proposal of l1Check(row.text)) {
      if (merged.some((other) => proposal.start < other.end && proposal.end > other.start)) continue
      const delta = await rerank(row.text, proposal.start, proposal.suggestions[0])
      if (delta === null) continue
      if (delta < MLM_MARGIN) { stats.dropped += 1; continue }
      stats.kept += 1
      merged.push({ ...proposal, confidence: 0.9, mlm: Number(delta.toFixed(2)) })
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
      }
    }
    for (let g = 0; g < row.gold.length; g += 1) {
      if (used.has(g)) continue
      stats.fn += 1
      bump(perKind, row.kind, 'fn')
    }
    if (row.kind === 'clean') stats.clean += 1
  }
  return { stats, perKind }
}

function bump(map, kind, key) {
  const entry = map.get(kind) ?? { tp: 0, fp: 0, fn: 0 }
  entry[key] += 1
  map.set(kind, entry)
}

const started = performance.now()
const { stats, perKind } = await evaluateMlm()
const totalMs = performance.now() - started

const precision = stats.tp + stats.fp === 0 ? 1 : stats.tp / (stats.tp + stats.fp)
const recall = stats.tp + stats.fn === 0 ? 1 : stats.tp / (stats.tp + stats.fn)
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
const pct = (v) => (v * 100).toFixed(1).padStart(5) + '%'

console.log(`\n语料：${rows.length} 句（${which}）`)
console.log(`模型加载 ${(loadMs / 1000).toFixed(1)} s   推理 ${inferences} 次，平均 ${(inferenceMs / Math.max(1, inferences)).toFixed(0)} ms/次`)
console.log(`候选保留 ${stats.kept}，被模型否决 ${stats.dropped}\n`)
console.log('方案                     精确率   召回率   F1      TP  FP  FN   干净句误报')
console.log('─'.repeat(78))
console.log(
  `${'L0 + L1候选 + 上下文模型'.padEnd(24)} ${pct(precision)}  ${pct(recall)}  ${pct(f1)}  ` +
  `${String(stats.tp).padStart(3)} ${String(stats.fp).padStart(3)} ${String(stats.fn).padStart(3)}   ` +
  `${String(stats.fpClean).padStart(2)}/${String(stats.clean).padEnd(3)}`
)
console.log(`\n按类型（命中/误报/漏报）`)
for (const [kind, e] of perKind) console.log(`  ${kind.padEnd(12)} ${e.tp} / ${e.fp} / ${e.fn}`)

const modelFile = ['.model-cache/Xenova/bert-base-chinese/onnx/model_quantized.onnx', '.model-cache/Xenova/bert-base-chinese/onnx/model_q8.onnx']
console.log('\n模型文件')
let found = false
for (const candidate of modelFile) {
  if (fs.existsSync(candidate)) {
    const bytes = fs.statSync(candidate).size
    console.log(`  ${candidate}  ${(bytes / 1048576).toFixed(1)} MB`)
    found = true
  }
}
if (!found) {
  const dir = path.join('.model-cache', 'Xenova', 'bert-base-chinese')
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, { recursive: true })) {
      if (String(entry).endsWith('.onnx')) console.log(`  ${entry}  ${(fs.statSync(path.join(dir, String(entry))).size / 1048576).toFixed(1)} MB`)
    }
  }
}
console.log(`  总耗时 ${(totalMs / 1000).toFixed(1)} s`)
void zlib
