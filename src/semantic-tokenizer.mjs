/** BERT normalization/WordPiece for both frozen R13 vocabularies. No truncation. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2f800}-\u{2fa1f}]/u
const SPECIAL = /(\[UNK\]|\[SEP\]|\[PAD\]|\[CLS\]|\[MASK\])/g
const isSpecial = token => /^\[(UNK|SEP|PAD|CLS|MASK)\]$/.test(token)
function punctuation(ch) {
  const code = ch.codePointAt(0)
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64)
    || (code >= 91 && code <= 96) || (code >= 123 && code <= 126) || /\p{P}/u.test(ch)
}
function basic(text) {
  let cleaned = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code === 0 || code === 0xfffd) continue
    if (ch === '\t' || ch === '\n' || ch === '\r' || /\p{Zs}/u.test(ch)) { cleaned += ' '; continue }
    if (/[\p{Cc}\p{Cf}]/u.test(ch)) continue
    cleaned += CJK.test(ch) ? ' ' + ch + ' ' : ch
  }
  const out = []
  for (const word of cleaned.trim().split(/\s+/u)) {
    const normalized = word.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '')
    let buffer = ''
    for (const ch of normalized) {
      if (punctuation(ch)) { if (buffer) out.push(buffer); buffer = ''; out.push(ch) }
      else buffer += ch
    }
    if (buffer) out.push(buffer)
  }
  return out
}
export function createSemanticTokenizer(vocabText) {
  const lines = vocabText.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const vocab = new Map(lines.map((token, index) => [token, index]))
  const required = ['[CLS]', '[SEP]', '[UNK]', '[PAD]', '[MASK]']
  if (required.some(token => !vocab.has(token))) throw new Error('Invalid R13 vocabulary')
  function pieces(word) {
    const chars = [...word]
    if (chars.length > 100) return [vocab.get('[UNK]')]
    const ids = []; let start = 0
    while (start < chars.length) {
      let found = null, end = chars.length
      for (; end > start; end--) {
        const token = (start ? '##' : '') + chars.slice(start, end).join('')
        if (vocab.has(token)) { found = vocab.get(token); break }
      }
      if (found === null) return [vocab.get('[UNK]')]
      ids.push(found); start = end
    }
    return ids
  }
  return {
    encode(text) {
      const ids = [vocab.get('[CLS]')]
      for (const part of String(text).split(SPECIAL)) {
        if (!part) continue
        if (isSpecial(part)) ids.push(vocab.get(part))
        else for (const word of basic(part)) ids.push(...pieces(word))
      }
      ids.push(vocab.get('[SEP]'))
      return ids
    }
  }
}
