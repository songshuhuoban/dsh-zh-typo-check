/**
 * L1：拼音混淆集 + 词频语言模型。离线评估用，尚未接进输入框。
 *
 * 和 L0 的根本区别：
 *   L0 认识「错形」——表里有 `因该`，所以知道它错；
 *   L1 不认识任何错形，它只问一句：把某一个字换成同音字之后，
 *      整句话按词切成词的总概率是不是变高了。
 *
 * 这就是标准的 noisy channel：候选来自拼音混淆，判据来自语言模型。
 *
 * 为什么必须整句重算，而不是看局部两字窗口：
 *   `既便宜` 的局部窗口 `既便` 换成 `即便` 是个好词，但整句会从
 *   `既|便宜`（两个好词）变成 `即便|宜`（一个好词 + 一个孤字），分数反而降。
 *   只看局部就一定会误报这一句——实测确实误报了。
 *
 * 天生抓不到的：换错之后读音也变了（`还`→`话`），以及错形本身也是合法词。
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildMask } from './core.mjs'

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data')

/** 单字单独成词的分数。比任何收录的二字词都低，词汇总倾向于抱团。 */
const CHAR_SCORE = -9.0
/** 未收录的多字串（几乎不会出现，DP 只在词典词上跳）的兜底。 */
const OOV_SCORE = -20
/** 基线里已经落在常用词内部的字，不再当作可疑位置。L1_SETTLED_RANK=Infinity 表示「任何词典词」都算落定。 */
const SETTLED_RANK = Number(process.env.L1_SETTLED_RANK ?? 3000)
/** 整句分数至少要涨这么多，才值得打扰用户。 */
const MARGIN = Number(process.env.L1_MARGIN ?? 2.5)
/** 一条草稿最多报几处，避免一句烂文满屏下划线。 */
const MAX_ISSUES = 6

let WORDS = null
let SOUNDS = null
let CHAR_KEY = null
let MAX_LEN = 2

/**
 * 把拼音压成「听起来像」的键：zh/z ch/c sh/s 不分，n/l 不分，in/ing、en/eng、an/ang 不分。
 * @param toneless 无调拼音
 */
export function soundKey(toneless) {
  let s = toneless
  if (s.startsWith('zh')) s = 'z' + s.slice(2)
  else if (s.startsWith('ch')) s = 'c' + s.slice(2)
  else if (s.startsWith('sh')) s = 's' + s.slice(2)
  else if (s.startsWith('n')) s = 'l' + s.slice(1)
  else if (s.startsWith('r')) s = 'l' + s.slice(1)
  if (s.endsWith('ing')) s = s.slice(0, -3) + 'in'
  else if (s.endsWith('eng')) s = s.slice(0, -3) + 'en'
  else if (s.endsWith('ang')) s = s.slice(0, -3) + 'an'
  return s
}

/** 载入词频表与同音索引（由 tools/build-l1-data.mjs 生成）。 */
export async function loadL1(dir = DATA_DIR) {
  if (WORDS !== null) return
  const wordsText = fs.readFileSync(path.join(dir, 'l1-words.txt'), 'utf8')
  WORDS = new Map()
  for (const line of wordsText.split('\n')) {
    if (line === '') continue
    const tab = line.indexOf('\t')
    WORDS.set(line.slice(0, tab), Number(line.slice(tab + 1)))
  }
  for (const word of WORDS.keys()) if (word.length > MAX_LEN) MAX_LEN = word.length

  const soundsText = fs.readFileSync(path.join(dir, 'l1-sounds.txt'), 'utf8')
  SOUNDS = new Map()
  CHAR_KEY = new Map()
  for (const line of soundsText.split('\n')) {
    if (line === '') continue
    const eq = line.indexOf('=')
    const key = line.slice(0, eq)
    const chars = line.slice(eq + 1)
    SOUNDS.set(key, chars)
    for (const ch of chars) {
      const list = CHAR_KEY.get(ch) ?? []
      list.push(key)
      CHAR_KEY.set(ch, list)
    }
  }
}

/** 词频排名换算成分数：排名越小越高。 */
function wordScore(rank) {
  return -Math.log(rank + 1)
}

/**
 * 一段连续汉字的最优切分分数（最大概率分词，DP）。
 * @param chars 字符数组
 * @returns 该串的最高对数概率
 */
export function scoreRun(chars) {
  const n = chars.length
  const best = new Float64Array(n + 1).fill(Number.NEGATIVE_INFINITY)
  best[0] = 0
  for (let i = 0; i < n; i += 1) {
    if (best[i] === Number.NEGATIVE_INFINITY) continue
    const single = best[i] + CHAR_SCORE
    if (single > best[i + 1]) best[i + 1] = single
    for (let len = 2; len <= MAX_LEN && i + len <= n; len += 1) {
      const rank = WORDS.get(chars.slice(i, i + len).join(''))
      const score = best[i] + (rank === undefined ? OOV_SCORE : wordScore(rank))
      if (score > best[i + len]) best[i + len] = score
    }
  }
  return best[n]
}

/** 基线切分里每个字所属词的排名（0 = 孤字）。 */
function settle(chars) {
  const n = chars.length
  const best = new Float64Array(n + 1).fill(Number.NEGATIVE_INFINITY)
  const from = new Int32Array(n + 1).fill(-1)
  best[0] = 0
  for (let i = 0; i < n; i += 1) {
    if (best[i] === Number.NEGATIVE_INFINITY) continue
    const single = best[i] + CHAR_SCORE
    if (single > best[i + 1]) { best[i + 1] = single; from[i + 1] = i }
    for (let len = 2; len <= MAX_LEN && i + len <= n; len += 1) {
      const rank = WORDS.get(chars.slice(i, i + len).join(''))
      const score = best[i] + (rank === undefined ? OOV_SCORE : wordScore(rank))
      if (score > best[i + len]) { best[i + len] = score; from[i + len] = i }
    }
  }
  const covered = new Array(n).fill(Number.POSITIVE_INFINITY)
  let at = n
  while (at > 0) {
    const start = from[at]
    if (start < 0) break
    const word = chars.slice(start, at).join('')
    const rank = word.length === 1 ? Number.POSITIVE_INFINITY : WORDS.get(word)
    if (rank !== undefined && rank <= SETTLED_RANK) {
      for (let k = start; k < at; k += 1) covered[k] = rank
    }
    at = start
  }
  return covered
}

/** 一个字的近音字（同一个 soundKey 组，含多音字的所有读音）。 */
function neighborsOf(ch) {
  const keys = CHAR_KEY.get(ch)
  if (keys === undefined) return ''
  let out = ''
  for (const key of keys) out += SOUNDS.get(key) ?? ''
  return out
}

const HANZI_OR_PUNCT = /[\u4e00-\u9fff]/u

/**
 * 跑 L1。整句重打分：对每个可疑位置，逐个同音替换，看整句分数涨不涨。
 * @param text 原文
 * @param mask 遮罩（1 表示不参与判定）
 * @returns 问题列表，结构与 L0 的 Issue 一致
 */
export function l1Check(text, mask = buildMask(text)) {
  const issues = []
  if (WORDS === null) return issues

  // 连续汉字段
  const runs = []
  let start = -1
  for (let i = 0; i <= text.length; i += 1) {
    const isHan = i < text.length && HANZI_OR_PUNCT.test(text[i]) && mask[i] !== 1
    if (isHan && start < 0) start = i
    if (!isHan && start >= 0) { runs.push([start, i]); start = -1 }
  }

  for (const [from, to] of runs) {
    const chars = [...text.slice(from, to)]
    if (chars.length < 2 || chars.length > 120) continue
    const base = scoreRun(chars)
    const covered = settle(chars)

    const accepted = []
    for (let i = 0; i < chars.length; i += 1) {
      if (covered[i] !== Number.POSITIVE_INFINITY) continue
      let best = null
      for (const candidate of neighborsOf(chars[i])) {
        if (candidate === chars[i]) continue
        const replaced = chars.slice()
        replaced[i] = candidate
        const delta = scoreRun(replaced) - base
        if (best === null || delta > best.delta) best = { delta, candidate }
      }
      if (best !== null && best.delta >= MARGIN) {
        accepted.push({ index: i, delta: best.delta, candidate: best.candidate })
      }
    }

    accepted.sort((a, b) => b.delta - a.delta)
    for (const hit of accepted.slice(0, MAX_ISSUES)) {
      const at = from + hit.index
      issues.push({
        start: at,
        end: at + 1,
        text: text[at],
        kind: 'homophone',
        message: `按上下文更像「${hit.candidate}」`,
        suggestions: [hit.candidate],
        confidence: Math.min(0.97, 0.72 + hit.delta * 0.02),
        l1: { delta: Number(hit.delta.toFixed(2)) },
      })
    }
  }

  return issues.sort((a, b) => a.start - b.start)
}

export function l1Ready() {
  return WORDS !== null && WORDS.size
}

/**
 * 基线切分里每个字是否落在常用词内部（Infinity = 没有被常用词覆盖，位置可疑）。
 * 用途：给上下文模型挑位置——只对可疑位置做掩码推理，把每句的推理次数压到个位数。
 * @param chars 一段连续汉字
 */
export function commonWordCoverage(chars) {
  return settle(chars)
}
/** 一个字的近音字集合（含多音字），给上下文模型做候选约束用。 */
export function homophonesOf(ch) {
  return neighborsOf(ch)
}

/** 这个词在词频表里吗，给上下文模型做"改完得成词"的约束用。 */
export function isKnownWord(word) {
  return WORDS !== null && WORDS.has(word)
}