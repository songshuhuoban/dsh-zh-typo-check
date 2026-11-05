/**
 * 通顺度探针：模型对"原文每个字"的打分能区分正常句和乱敲的句子吗？
 *
 * 办法：逐字掩码，看模型给"原来的字"多少分，取平均。分越低 = 模型越没料到这个字。
 *
 * 运行：node tools/fluency-probe.mjs
 */
import path from 'node:path'
import { openModel, encode, scoreIndex } from '../src/infer.mjs'

const root = path.resolve(import.meta.dirname, '..')
const model = await openModel(
  path.join(root, 'node_modules/@huggingface/transformers/.cache/Xenova/macbert4csc-base-chinese')
)
await model.tokenizer

const CASES = [
  ['正常', '今天的天气不错，我们去公园走走吧。'],
  ['正常', '这个方案的风险太高，需要再评估一下。'],
  ['正常', '会议纪要已经发到群里了，请大家查收。'],
  ['错字', '这个方案风显太高。'],
  ['错字', '他因该明天就到了。'],
  ['乱敲', '第五个i红啊数据库更好'],
  ['乱敲', '几天呢我哦。'],
  ['乱敲', '阿萨德发噶啥地方'],
  ['病句', '我把饭吃了被他。'],
]

const CJK = /[\u4e00-\u9fff]/u

for (const [kind, text] of CASES) {
  const { ids, aligned } = encode(model, text)
  if (!aligned) {
    console.log(`${kind.padEnd(4)} ${text}  （分词未对齐）`)
    continue
  }
  const scores = []
  for (let i = 0; i < text.length; i += 1) {
    if (!CJK.test(text[i])) continue
    const row = await scoreIndex(model, ids, i, { topK: 1 })
    scores.push(row.original)
  }
  const avg = scores.reduce((s, v) => s + v, 0) / scores.length
  const min = Math.min(...scores)
  console.log(`${kind.padEnd(4)} 平均 ${avg.toFixed(2).padStart(7)}  最低 ${min.toFixed(2).padStart(7)}   ${text}`)
}
