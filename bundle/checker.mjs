/**
 * 宿主侧的完整判定：A 路（同音候选）+ B 路（自由候选），共用同一次前向。
 *
 * 两条路的候选来源不同，判据也不同：
 *   A 路候选来自拼音混淆集，本来就是"听着像"的错字，模型只要给一点点偏好就该信（Δ≥2.5）；
 *   B 路候选是模型自己挑的字，必须给出很强的证据（Δ≥10），否则天天改人文风。
 *
 * 同一个位置两条路都要打分，所以先把位置并起来、每个位置只跑一次前向，
 * 再分别按各自的门槛判断——省掉一半推理。
 */
import { l1Check, l1Ready, loadL1 } from './l1.mjs'
import { encode, scoreIndex, scan } from './infer.mjs'
import { plausible } from './lexicon.mjs'

export const A_MARGIN = Number(process.env.A_MARGIN ?? 2.5)
export const B_MARGIN = Number(process.env.B_MARGIN ?? 12)
/**
 * 不同音的替换要多强才敢报。
 *
 * 中文错字绝大多数是同音/近音（到→岛、因→应），这类候选本来就"听着像"，
 * Δ≥12 已经是强证据。而读音完全不同的替换，模型经常只是被上下文里
 * 更常见的词吸引过去——人名这类词典里没有的词尤其容易被改（`斯成`→`办成`，Δ=13.1）。
 * 真正该报的不同音替换会给出高得多的分数（`的还`→`的话`，Δ=18.0）。
 */
export const B_MARGIN_OTHER = Number(process.env.B_MARGIN_OTHER ?? 15)
export const MAX_POSITIONS = Number(process.env.MAX_POSITIONS ?? 12)

/**
 * @param {object} model   openModel() 的返回值
 * @param {object|null} lexicon  词表；为 null 时 B 路不设"像话"约束
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.minDelta]  覆盖 B 路阈值
 * @param {number[]} [options.scores]  传入数组时，把每个已打分位置的「原字得分」追加进去
 * @returns {Promise<Array<{index:number, original:string, candidate:string, delta:number, route:'A'|'B'}>>}
 */
export async function checkText(model, lexicon, text, options = {}) {
  if (typeof text !== 'string' || text === '') return []
  // 调用方（设置页的灵敏度档位）可以覆盖 B 路阈值；越界值一律夹回安全区间
  const bMargin = Number.isFinite(options.minDelta)
    ? Math.min(30, Math.max(5, options.minDelta))
    : B_MARGIN

  // ---- A 路候选：位置 → 建议字 ----
  const fromA = new Map()
  if (l1Ready()) {
    for (const proposal of l1Check(text)) {
      const candidate = proposal.suggestions?.[0]
      if (typeof candidate === 'string' && !fromA.has(proposal.start)) {
        fromA.set(proposal.start, candidate)
      }
    }
  }

  // ---- B 路位置：只取前 N 个会让长句子的后半段永远扫不到，所以超过上限时均匀取样 ----
  const allPositions = []
  for (let index = 0; index < text.length; index += 1) {
    if (/[\u4e00-\u9fff]/u.test(text[index])) allPositions.push(index)
  }
  const stride = allPositions.length > MAX_POSITIONS
    ? Math.ceil(allPositions.length / MAX_POSITIONS)
    : 1
  const positions = allPositions.filter((_, order) => order % stride === 0).slice(0, MAX_POSITIONS)
  // ---- 打分位置：A 路的优先占位，再补 B 路的位置，总数不超过上限 ----
  // 上限直接决定延迟（每个位置一次前向约 21 ms），不能让它随句子长度涨。
  const union = []
  for (const index of fromA.keys()) {
    if (union.length < MAX_POSITIONS && index >= 0 && index < text.length) union.push(index)
  }
  for (const index of positions) {
    if (union.length >= MAX_POSITIONS) break
    if (!union.includes(index)) union.push(index)
  }
  union.sort((a, b) => a - b)

  const { ids, aligned, charToToken } = encode(model, text)
  if (!aligned) return []

  const accept = lexicon === null ? null : (ch, index) => plausible(lexicon, text, index, ch)
  const scored = new Map()
  for (const index of union) {
    if (index < 0 || index >= text.length) continue
    // 汉字 → token 下标；英文词等非汉字不参与掩码
    const tokenIndex = charToToken.get(index)
    if (tokenIndex === undefined) continue
    const row = await scoreIndex(model, ids, tokenIndex, { topK: 40 })
    scored.set(index, row)
    // 顺带把「模型对原文这个字的评分」交出去：通顺度就是这些分数的平均，
    // 不需要再跑第二轮推理。
    if (Array.isArray(options.scores)) options.scores.push(row.original)
  }

  const results = []
  const taken = new Set()

  // ---- A 路：只看混淆集给的那个字 ----
  for (const [index, candidate] of fromA) {
    const row = scored.get(index)
    if (row === undefined) continue
    const score = row.scoreOf(candidate)
    if (score === null) continue
    const delta = score - row.original
    if (delta < A_MARGIN) continue
    if (accept !== null && !accept(candidate, index)) {
      // 混淆集偶尔也会给出不通顺的字；模型强烈偏好才放行
      if (delta < B_MARGIN) continue
    }
    results.push({ index, original: text[index], candidate, delta, route: 'A' })
    taken.add(index)
  }

  // ---- B 路：在像话的候选里挑最强 ----
  for (const index of positions) {
    if (taken.has(index)) continue
    if (fromA.has(index)) continue
    // 原字本身已经和邻字成词，就别动它。
    // 「会议纪要」会把「要」改成「录」——因为「纪录」是词、Δ 也够大，
    // 但「纪要」本来就是词，这一处根本没错。这条能挡掉整整一类误报。
    if (lexicon !== null && originFormsWord(lexicon, text, index)) continue
    const row = scored.get(index)
    if (row === undefined || row.best === null) continue
    for (const candidate of row.ranked) {
      if (accept !== null && !accept(candidate.ch, index)) continue
      const delta = candidate.score - row.original
      const homophone = lexicon !== null && lexicon.charToKey.get(candidate.ch) === lexicon.charToKey.get(text[index])
      // 同音的替换用调用方给的阈值；不同音的替换永远不低于 B_MARGIN_OTHER
      // （调低灵敏度时不能把"读音完全不同"的门槛一起降下来，否则误报会涌进来）
      if (delta < (homophone ? bMargin : Math.max(bMargin, B_MARGIN_OTHER))) break
      results.push({ index, original: text[index], candidate: candidate.ch, delta, route: 'B' })
      break
    }
  }

  results.sort((a, b) => a.index - b.index)
  return results
}

export { loadL1 }
export const scanText = scan

/**
 * 原字是不是已经和邻字组成一个真实存在的词。
 *
 * 用来挡「会议纪要」→「会议纪录」这类误报：模型觉得「纪录」更常见，
 * 但「纪要」本来就是词，这一处没有错。
 */
export function originFormsWord(lexicon, text, index) {
  if (index > 0 && lexicon.words.has(text[index - 1] + text[index])) return true
  if (index + 1 < text.length && lexicon.words.has(text[index] + text[index + 1])) return true
  return false
}