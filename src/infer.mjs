/**
 * 宿主侧推理：onnxruntime-node + 自己写的分词器。
 *
 * 为什么不把 transformers.js 拖进来：宿主只需要「掩码打分」这一件事，
 * 而 transformers.js 会连带下载一整套 pipeline 代码。这里只依赖
 * onnxruntime-node 一个原生模块，加上 30 行的分词器。
 *
 * 每次调用掩码一个位置，返回该位置的原文字分数和候选字。
 */
import path from 'node:path'
import { loadTokenizer } from './tokenizer.mjs'

const CJK = /[\u4e00-\u9fff]/u

let loaded = null
let runtimeProbe = null

/**
 * 推理运行时是否可用。
 *
 * `onnxruntime-node` 是可选依赖：插件以本地链接方式安装时，包管理器不会装
 * 链接包自己的依赖，这时模型文件在、运行时却不在。宿主需要能如实报告这件事，
 * 而不是等到检查时才抛一个看不懂的错。
 */
export async function probeRuntime() {
  if (runtimeProbe !== null) return runtimeProbe
  try {
    await import('onnxruntime-node')
    runtimeProbe = true
  } catch {
    runtimeProbe = false
  }
  return runtimeProbe
}

/**
 * 打开模型。重复调用返回同一个实例——模型 99 MB，只能读一次。
 * @param {string} dir 含 model_quantized.onnx 与 tokenizer.json 的目录
 */
export async function openModel(dir) {
  if (loaded !== null && loaded.dir === dir) return loaded
  let ort
  try {
    ort = await import('onnxruntime-node')
  } catch {
    const missing = new Error('缺少 onnxruntime-node 推理运行时')
    missing.code = 'E_ORT_MISSING'
    throw missing
  }
  const tokenizer = await loadTokenizer(dir)
  // 下载服务把文件平铺在模型目录里；transformers.js 的缓存则放在 onnx/ 子目录。
  const { existsSync } = await import('node:fs')
  const flat = path.join(dir, 'model_quantized.onnx')
  const nested = path.join(dir, 'onnx', 'model_quantized.onnx')
  const file = existsSync(flat) ? flat : nested
  const session = await ort.InferenceSession.create(file, { graphOptimizationLevel: 'all' })

  const singleChars = tokenizer.singleCharIds()
  loaded = { dir, ort, session, tokenizer, singleChars, inputNames: session.inputNames }
  return loaded
}

export async function closeModel() {
  if (loaded !== null) {
    const previous = loaded
    loaded = null
    await previous.session.release()
  }
}

/**
 * 文本 → 模型输入。
 *
 * 之前这里要求「token 数 === 字符数」才算对齐；中英混排（UNbelievable、API、DSH）
 * 里英文词会合并成少数 token，字符数与 token 数不等，于是整句被判定 not-aligned、
 * 语义检查直接跳过——用户看到的现象就是「开了模型/通顺度却完全没反应」。
 *
 * 现在只要求**每个汉字都有自己的 token**，并返回 汉字下标 → token 下标 的映射；
 * 英文词只是上下文，不参与掩码。`aligned` 仅表示"有没有汉字找不到 token"。
 */
export function encode(model, text) {
  const { ids, charToToken } = model.tokenizer.encodeWithPositions(text)
  let aligned = true
  for (let index = 0; index < text.length; index += 1) {
    if (CJK.test(text[index]) && !charToToken.has(index)) { aligned = false; break }
  }
  return { ids, aligned, charToToken }
}

/**
 * 掩码第 index 个位置，返回原文字分数与按分数排序的候选。
 * `ranked` 只保留前 `topK` 个——判据在候选里从上往下挑，不需要全量。
 * @returns {Promise<{original: number, best: {ch: string, score: number} | null, top: Array<{ch: string, score: number}>, ranked: Array<{ch: string, score: number}>}>}
 */
export async function scoreIndex(model, ids, index, options = {}) {
  const { topK = 5 } = options
  const tokens = [model.tokenizer.cls, ...ids.slice(), model.tokenizer.sep]
  const masked = tokens.slice()
  masked[index + 1] = model.tokenizer.mask

  const length = masked.length
  const inputIds = BigInt64Array.from(masked.map((n) => BigInt(n)))
  const attention = BigInt64Array.from(new Array(length).fill(1n))
  const segments = BigInt64Array.from(new Array(length).fill(0n))

  const feeds = {}
  for (const name of model.inputNames) {
    const data = name.includes('token_type') ? segments : name.includes('mask') ? attention : inputIds
    feeds[name] = new model.ort.Tensor('int64', data, [1, length])
  }

  const output = await model.session.run(feeds)
  const logits = output.logits ?? Object.values(output).find((value) => value?.dims?.length === 3)
  const vocabSize = logits.dims[2]
  const row = logits.data
  const offset = (index + 1) * vocabSize
  const original = Number(row[offset + tokens[index + 1]])

  const ranked = []
  for (const [id, ch] of model.singleChars) {
    if (id === tokens[index + 1]) continue
    ranked.push({ ch, score: Number(row[offset + id]) })
  }
  ranked.sort((a, b) => b.score - a.score)

  return {
    original,
    best: ranked[0] ?? null,
    top: ranked.slice(0, 5),
    ranked: ranked.slice(0, topK),
    scoreOf(ch) {
      const id = model.tokenizer.idOf(ch)
      return id === undefined ? null : Number(row[offset + id])
    },
  }
}

/**
 * 逐字扫描，返回可疑位置与被模型看好的替代字。
 *
 * 约束是**过滤式**的：只有"像话"的候选进入比较（`accept` 判定），
 * 然后取其中最强的那个，且 Δ 必须过线。试过给像话的候选单独设一个低阈值，
 * 结果模型会放着明显更好的候选不用、去挑一个勉强成词的——L2 上报从 10 条涨到 97 条。
 *
 * 注意这里是**一次一个位置**。试过把多个掩码位置堆成 batch 一次跑完
 * （258 ms → 123 ms），但同一个位置单独跑和混在 batch 里得出的 top-1 会不一样
 * （`还`这个位置单独是「话」，和另一个位置同批时变成「哥」）。
 * 这个 int8 量化模型不是 batch 不变的，校验场景不能拿它换速度。
 */
export async function scan(model, text, options = {}) {
  const { minDelta = 10, maxPositions = 12, accept = null } = options
  const { ids, aligned, charToToken } = encode(model, text)
  if (!aligned) return []

  const results = []
  let scanned = 0
  for (let index = 0; index < text.length && scanned < maxPositions; index += 1) {
    if (!CJK.test(text[index])) continue
    const tokenIndex = charToToken.get(index)
    if (tokenIndex === undefined) continue
    scanned += 1
    const scored = await scoreIndex(model, ids, tokenIndex, { topK: 40 })
    if (scored.best === null) continue

    for (const candidate of scored.ranked) {
      if (accept !== null && !accept(candidate.ch, index)) continue
      const delta = candidate.score - scored.original
      if (delta < minDelta) break
      results.push({ index, original: text[index], candidate: candidate.ch, delta })
      break
    }
  }
  return results
}
