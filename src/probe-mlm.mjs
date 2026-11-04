/**
 * 探针：用中文 BERT 的掩码语言模型给单字替换打分。
 *
 * 问题只有一个——它能不能分得清「肌肉」和「鸡肉」这种一元词频分不清的上下文。
 * 如果能，才值得为它做下载界面。
 */
import { AutoTokenizer, AutoModelForMaskedLM, Tensor, env } from '@huggingface/transformers'

env.cacheDir = '.model-cache'

const MODEL = 'Xenova/bert-base-chinese'

console.log('loading model…')
const started = Date.now()
const tokenizer = await AutoTokenizer.from_pretrained(MODEL)
const model = await AutoModelForMaskedLM.from_pretrained(MODEL, { dtype: 'q8' })
console.log(`loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`)

/** 编码成 [CLS] ids [SEP]，返回字符 id 与偏移。 */
function encodeChars(text) {
  const ids = tokenizer(text, { add_special_tokens: false }).input_ids
  const flat = Array.isArray(ids) ? ids.flat() : ids.data
  return Array.from(flat).map((n) => Number(n))
}

const cls = tokenizer.cls_token_id ?? 101
const sep = tokenizer.sep_token_id ?? 102
const maskId = tokenizer.mask_token_id

/**
 * 在 index 处掩码，返回「原文那个字」与「候选字」的对数概率差。
 * 正数表示候选更合适。
 */
async function compare(text, index, candidate) {
  const ids = encodeChars(text)
  const originalId = ids[index]
  const candidateIds = encodeChars(candidate)
  const candidateId = candidateIds[0]

  const masked = ids.slice()
  masked[index] = maskId
  const input = BigInt64Array.from([cls, ...masked, sep].map((n) => BigInt(n)))
  const attention = BigInt64Array.from(new Array(masked.length + 2).fill(1n))

  const output = await model({
    input_ids: new Tensor('int64', input, [1, masked.length + 2]),
    attention_mask: new Tensor('int64', attention, [1, masked.length + 2]),
  })
  const logits = output.logits
  const [, length, vocab] = logits.dims
  const at = index + 1
  const row = logits.data
  const offset = at * vocab
  const scoreOriginal = Number(row[offset + originalId])
  const scoreCandidate = Number(row[offset + candidateId])
  return { delta: scoreCandidate - scoreOriginal, scoreOriginal, scoreCandidate, length }
}

const CASES = [
  ['他的脾气越来越急躁。', '肌', null],
  ['肌肉萎缩需要长期康复。', '肌', '鸡'],
  ['这件事我们绝不能退让。', '绝', '决'],
  ['警方包围了巢穴。', '围', '为'],
  ['那段日子过得很艰苦。', '坚', '艰'],
  ['我以经吃过饭了。', '以', '已'],
  ['我们需要在次确认。', '在', '再'],
  ['他因该明天就到。', '因', '应'],
  ['这简值是个奇迹。', '简', '简直'],
]

for (const [text, _ignore, candidate] of CASES) {
  if (candidate === null) continue
  const index = text.indexOf(_ignore)
  if (index < 0) { console.log(`skip ${text}`); continue }
  const target = candidate.length === 2 ? candidate[1] : candidate
  const result = await compare(text, index, target)
  const verdict = result.delta > 0 ? '候选更优 ← 会误报/命中' : '原文更优'
  console.log(`${text}  ${text[index]}→${target}  Δ=${result.delta.toFixed(2)}  ${verdict}`)
}
