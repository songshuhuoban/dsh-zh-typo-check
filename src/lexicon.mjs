/**
 * 词表与近音字表：给模型当"改完得像话"的约束。
 *
 * 没有这层约束时，模型会不停改写文风——`绝`→`也`、`方`→`答`，
 * 离线评估里加上它之后 F1 从 72.2 涨到 80.5。
 *
 * 数据来自 segmentit 的词频表（rank>0 才算词）和 pinyin-pro 的读音表，
 * 由 tools/build-l1-data.mjs 生成，随插件一起分发。
 */
import path from 'node:path'
import { readFile } from 'node:fs/promises'

let loaded = null

/**
 * @param {string} dir 含 l1-words.txt 与 l1-sounds.txt 的目录
 */
export async function loadLexicon(dir) {
  if (loaded !== null && loaded.dir === dir) return loaded

  const words = new Set()
  const rawWords = await readFile(path.join(dir, 'l1-words.txt'), 'utf8')
  for (const line of rawWords.split('\n')) {
    if (line === '') continue
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    words.add(line.slice(0, tab))
  }

  const charToKey = new Map()
  const keyToChars = new Map()
  const rawSounds = await readFile(path.join(dir, 'l1-sounds.txt'), 'utf8')
  for (const line of rawSounds.split('\n')) {
    if (line === '') continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    const chars = line.slice(eq + 1)
    keyToChars.set(key, chars)
    for (const ch of chars) charToKey.set(ch, key)
  }

  loaded = { dir, words, charToKey, keyToChars, homophoneCache: new Map() }
  return loaded
}

export function isKnownWord(lexicon, word) {
  return lexicon.words.has(word)
}

/** 一个字的近音字（同声调同音节），用于约束候选。 */
export function homophonesOf(lexicon, ch) {
  const cached = lexicon.homophoneCache.get(ch)
  if (cached !== undefined) return cached
  const key = lexicon.charToKey.get(ch)
  const chars = key === undefined ? '' : (lexicon.keyToChars.get(key) ?? '')
  const set = new Set(chars)
  set.delete(ch)
  lexicon.homophoneCache.set(ch, set)
  return set
}

/**
 * 改完必须像话：要么和邻字组成词典词（`的话`、`再次`），要么本身就是同音字。
 * 这一条把大量"语法上行但没必要改"的风格建议挡在外面。
 */
export function plausible(lexicon, text, index, candidate) {
  if (index > 0 && lexicon.words.has(text[index - 1] + candidate)) return true
  if (index + 1 < text.length && lexicon.words.has(candidate + text[index + 1])) return true
  return homophonesOf(lexicon, text[index]).has(candidate)
}

/**
 * 候选是否和邻字组成一个真实存在的词。
 *
 * 这是"低阈值档"的准入条件：`的话`、`再次` 这类改动有词典背书，
 * 模型只要给出很弱的偏好就该听；纯粹同音（`到`→`岛`）不足以降到低阈值——
 * 那样几乎每个位置都能凑出一个同音字，误报会翻十倍。
 */
export function formsWord(lexicon, text, index, candidate) {
  if (index > 0 && lexicon.words.has(text[index - 1] + candidate)) return true
  if (index + 1 < text.length && lexicon.words.has(candidate + text[index + 1])) return true
  return false
}