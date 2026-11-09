/**
 * 宿主侧推理验证：模型给出的答案必须和 transformers.js 一致。
 *
 * 重点看那句真实错句：「我到上海住的还，可以经常包斯成晚餐咯~」
 * 之前用 transformers.js 测到「还」这个位置首选是「话」（Δ=+8.63），
 * 这里用 onnxruntime-node + 自写分词器重跑，数字应当对得上。
 */
import path from 'node:path'
import { openModel, scan, scoreIndex, encode } from '../src/infer.mjs'

const DIR = path.resolve(
  'node_modules/@huggingface/transformers/.cache/Xenova/macbert4csc-base-chinese'
)

const failed = []
const check = (label, ok, detail = '') => {
  if (ok) console.log(`PASS  ${label}`)
  else { failed.push(label); console.log(`FAIL  ${label}  ${detail}`) }
}

const started = Date.now()
const model = await openModel(DIR)
console.log(`模型加载 ${Date.now() - started} ms，输入 ${model.inputNames.join('/')}`)

check('单字候选覆盖充足', model.singleChars.length > 5000, String(model.singleChars.length))

// ---- 1. 用户报的那句话：`还` 应该被判成 `话` ----
const TEXT = '我到上海住的还，可以经常包斯成晚餐咯~'
const { ids, aligned } = encode(model, TEXT)
check('分词与原文逐字对齐', aligned, `${ids.length} vs ${[...TEXT].length}`)

const hai = TEXT.indexOf('还')
const tick = Date.now()
const scored = await scoreIndex(model, ids, hai, { topK: 5 })
const elapsed = Date.now() - tick
console.log(`  「还」原文=${scored.original.toFixed(2)}  前五: ` +
  scored.top.map((item) => `${item.ch} ${item.score.toFixed(2)}`).join('  '))
check('首选是「话」', scored.best?.ch === '话', String(scored.best?.ch))
check('单次推理 < 200 ms', elapsed < 200, `${elapsed} ms`)

// ---- 2. 中英混排：英文词会合并 token，但不能因此跳过整句语义检查 ----
// 回归：用户输入「…的还，可以用API测试」时 encode 判 not-aligned，开了模型/通顺度也毫无反应。
const MIXED = '我到上海住的还，可以用API测试'
const mixedEncoded = encode(model, MIXED)
const mixedHai = MIXED.indexOf('还')
const mixedToken = mixedEncoded.charToToken.get(mixedHai)
check('中英混排仍对齐（每个汉字有 token）', mixedEncoded.aligned,
  `${mixedEncoded.ids.length} tokens / ${[...MIXED].length} chars`)
check('汉字能映射到 token 下标', Number.isInteger(mixedToken), String(mixedToken))
const mixedScored = await scoreIndex(model, mixedEncoded.ids, mixedToken, { topK: 5 })
const mixedHua = mixedScored.scoreOf('话')
check('混排下「话」的分数明显高于原字',
  mixedHua !== null && mixedHua - mixedScored.original >= 8,
  `话=${mixedHua} 原字=${mixedScored.original}`)

// ---- 3. 逐字扫描能定位到错字 ----
const before = TEXT.indexOf('包斯')
const hits = await scan(model, TEXT, { minDelta: 8, maxPositions: 20 })
const hitText = hits.map((h) => `${h.original}→${h.candidate}(${h.delta.toFixed(1)})`).join(' ')
console.log(`  扫描命中: ${hitText || '（无）'}`)
check('扫到了「还」', hits.some((h) => h.index === hai && h.candidate === '话'))
void before

// ---- 3. 正常句子不该被改 ----
const CLEAN = '今天的天气很好，我们一起去公园散步吧。'
const cleanHits = await scan(model, CLEAN, { minDelta: 10, maxPositions: 20 })
console.log(`  正常句命中: ${cleanHits.map((h) => `${h.original}→${h.candidate}`).join(' ') || '（无）'}`)
check('正常句子零命中', cleanHits.length === 0, JSON.stringify(cleanHits))

console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败：${failed.join('、')}`}`)
process.exit(failed.length === 0 ? 0 : 1)
