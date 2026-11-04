/**
 * 分词器对齐验证：自己写的最小分词器 vs transformers.js。
 *
 * 对齐是硬要求——分词只要差一个 token，掩码位置就整体错位，
 * 后面所有打分都不可信。
 */
import path from 'node:path'
import { AutoTokenizer } from '@huggingface/transformers'
import { loadTokenizer } from '../src/tokenizer.mjs'
import { CORPUS } from '../src/corpus.mjs'

const DIR = path.resolve(
  'node_modules/@huggingface/transformers/.cache/Xenova/macbert4csc-base-chinese'
)

const mine = await loadTokenizer(DIR)
const theirs = await AutoTokenizer.from_pretrained(DIR)

const EXTRA = [
  'Hello World 2026年',
  '我爱你，中国！',
  '这是一段 English 混排 文本。',
  '  空格   很多   ',
  '标点符号：；、？！……',
  'ＡＢＣ全角字母',
  '数字123456',
  'emoji😀测试',
  'bert-base-chinese',
  'unbelievable 这是一个超长英文词',
]

let checked = 0
const failures = []

function same(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

async function compare(text, label) {
  const mineIds = mine.encode(text)
  const theirRaw = theirs(text, { add_special_tokens: false }).input_ids
  const theirIds = Array.from(theirRaw.data ?? theirRaw).map(Number)
  checked += 1
  if (!same(mineIds, theirIds)) {
    failures.push({ label, text, mineIds, theirIds })
  }
}

for (const row of CORPUS) await compare(row.text, row.kind)
for (const text of EXTRA) await compare(text, 'extra')

console.log(`比对 ${checked} 句`)
if (failures.length === 0) {
  console.log('全部一致')
  process.exit(0)
}

console.log(`${failures.length} 句不一致：`)
for (const failure of failures.slice(0, 6)) {
  console.log(`\n  [${failure.label}] ${failure.text}`)
  console.log(`    我方 ${failure.mineIds.length}: ${failure.mineIds.slice(0, 40).join(',')}`)
  console.log(`    参考 ${failure.theirIds.length}: ${failure.theirIds.slice(0, 40).join(',')}`)
}
process.exit(1)
