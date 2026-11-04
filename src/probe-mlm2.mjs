/**
 * 探针 2：不只用同音字做候选，直接让掩码语言模型给出它认为该出现的字。
 *
 * 关键问题：`还`→`话` 这种"读音都不一样、但我们知道该是话"的错误，
 * 模型能不能自己提出来？如果能，候选集就不再受拼音表限制。
 */
import { AutoTokenizer, AutoModelForMaskedLM, Tensor, env } from '@huggingface/transformers'

env.cacheDir = '.model-cache'

const MODEL = 'Xenova/bert-base-chinese'
const tokenizer = await AutoTokenizer.from_pretrained(MODEL)
const model = await AutoModelForMaskedLM.from_pretrained(MODEL, { dtype: 'q8' })

const CLS = tokenizer.cls_token_id ?? 101
const SEP = tokenizer.sep_token_id ?? 102
const MASK = tokenizer.mask_token_id
const idToToken = tokenizer.model?.vocab ?? null

function encodeChars(text) {
  const ids = tokenizer(text, { add_special_tokens: false }).input_ids
  const flat = Array.isArray(ids) ? ids.flat() : ids.data
  return Array.from(flat).map(Number)
}

let vocabList = null
function tokenOf(id) {
  if (vocabList === null) {
    vocabList = new Map()
    for (let i = 0; i < 25000; i += 1) {
      const token = tokenizer.decode([i], { skip_special_tokens: false })
      if (typeof token === 'string' && token.length === 1) vocabList.set(i, token)
    }
  }
  return vocabList.get(id) ?? null
}

/**
 * 掩码一个位置，返回原文的排名、以及模型最看好的几个候选。
 * @param text 句子
 * @param index 字下标
 * @param topK 取前几名
 */
async function probe(text, index, topK = 6) {
  const ids = encodeChars(text)
  const originalId = ids[index]
  const masked = ids.slice()
  masked[index] = MASK
  const tokens = [CLS, ...masked, SEP]
  const input = BigInt64Array.from(tokens.map((n) => BigInt(n)))
  const attention = BigInt64Array.from(new Array(tokens.length).fill(1n))

  const output = await model({
    input_ids: new Tensor('int64', input, [1, tokens.length]),
    attention_mask: new Tensor('int64', attention, [1, tokens.length]),
  })
  const vocab = output.logits.dims[2]
  const row = output.logits.data
  const offset = (index + 1) * vocab

  const scores = []
  for (let id = 0; id < vocab; id += 1) {
    const ch = tokenOf(id)
    if (ch === null) continue
    if (!/[\u4e00-\u9fff]/u.test(ch)) continue
    scores.push({ id, ch, score: Number(row[offset + id]) })
  }
  scores.sort((a, b) => b.score - a.score)
  const originalScore = Number(row[offset + originalId])
  const rank = scores.filter((s) => s.score > originalScore).length + 1
  const best = scores.slice(0, topK)
  const bestHomophone = scores.find((s) => s.ch !== text[index])
  return { original: text[index], originalScore, rank, best, bestHomophone, scoreOf: (ch) => scores.find((s) => s.ch === ch)?.score ?? null }
}

const CASES = [
  ['我到上海住的还，可以经常包斯成晚餐咯~', '还'],
  ['我以经吃过饭了。', '以'],
  ['我们需要在次确认一下。', '在'],
  ['他因该明天就到。', '因'],
  ['这件事我们绝不能退让。', '绝'],
  ['他的弟弟长得很象他。', '象'],
  ['这简值是个奇迹。', '值'],
  ['那段日子过得很坚苦。', '坚'],
  ['皮肤明显松驰了很多。', '驰'],
  ['请先登陆系统再提交。', '陆'],
  ['这笔钱应该记在帐号上。', '帐'],
]

for (const [text, target] of CASES) {
  const index = text.indexOf(target)
  if (index < 0) { console.log(`skip ${text}`); continue }
  const result = await probe(text, index, 5)
  const top = result.best.map((s) => `${s.ch}`).join('')
  console.log(`\n${text}`)
  console.log(`  原文「${result.original}」排名 ${result.rank}   模型前五: ${top}`)
  console.log(`  分数: 原=${result.originalScore.toFixed(2)}  首选=${result.best[0].ch}:${result.best[0].score.toFixed(2)}`)
}
