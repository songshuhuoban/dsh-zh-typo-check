/**
 * 最小 BERT 分词器。
 *
 * 为什么自己写：宿主侧只需要「中文句子 → 词 id」这一件事，
 * 为了它把 transformers.js（几十 MB）拖进 profile 不值得。
 * 中文基本一字一 token，真正需要判断的只有 ASCII 词和标点，
 * 所以实现量很小——小到可以逐 token 和 transformers.js 对齐验证。
 *
 * 用法：
 *   const tokenizer = await loadTokenizer(dir)   // dir 里有 tokenizer.json
 *   tokenizer.encode('我到上海住的还')            // → [ids]
 */

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/

/**
 * BERT 的 BasicTokenizer，按原版规则：
 *   - 空白切断当前词
 *   - 中文逐字成 token（原版是给中文两侧插空格，效果相同）
 *   - ASCII 标点各自成 token
 *   - 其余字符（全角字母、emoji 等）留在词里交给 WordPiece
 *
 * 最后一条很容易写错：把全角字母当"标点"单独切出来，就查不到词表里的整词，
 * 只能得到一串 [UNK]。和 transformers.js 对齐测试专门盯这一类。
 *
 * 带 span 的版本额外记录每个 token 在原文里的起始偏移（UTF-16 单元），
 * 供 `encodeWithPositions` 建立「汉字下标 → token 下标」的映射。
 * `unbelievable 这是一个超长英文词` 这类中英混排里，英文词会合成一个 token，
 * 字符数与 token 数不再相等——没有映射就没法定位该遮哪个字。
 */
function basicTokenizeSpans(text, lowerCase) {
  const out = []
  let buffer = ''
  let bufferStart = 0
  let offset = 0
  const flush = () => {
    if (buffer !== '') { out.push({ text: buffer, start: bufferStart, cjk: false }); buffer = '' }
  }
  for (const ch of text) {
    const start = offset
    offset += ch.length
    const code = ch.codePointAt(0)
    if (code === 0 || code === 0xfffd || /\s/u.test(ch)) { flush(); continue }
    if (CJK.test(ch)) { flush(); out.push({ text: ch, start, cjk: true }); continue }
    if (isPunctuation(ch)) { flush(); out.push({ text: ch, start, cjk: false }); continue }
    if (buffer === '') bufferStart = start
    buffer += lowerCase ? ch.toLowerCase() : ch
  }
  flush()
  return out
}

/** 只要 token 文本的旧接口（与 transformers.js 的逐 token 对齐测试在用）。 */
function basicTokenize(text, lowerCase) {
  return basicTokenizeSpans(text, lowerCase).map((token) => token.text)
}

/**
 * 标点判定，和 HF tokenizers 的 BertPreTokenizer 一致：
 * ASCII 只认符号区那几段；非 ASCII 则看 Unicode 的 P 类。
 *
 * 这条区分很关键——`，` 和 `…` 属于 P 类要切开，
 * 而 emoji（S 类）和全角字母（L 类）必须留在词里，切开就查不到词表。
 */
function isPunctuation(ch) {
  const code = ch.codePointAt(0)
  if ((code >= 33 && code <= 47)
    || (code >= 58 && code <= 64)
    || (code >= 91 && code <= 96)
    || (code >= 123 && code <= 126)) return true
  return code > 0x7f && /\p{P}/u.test(ch)
}

/** WordPiece：先整词命中，否则最长前缀 + `##` 续接。 */
function wordpiece(token, vocab, unk) {
  if (vocab.has(token)) return [vocab.get(token)]
  const pieces = []
  let start = 0
  while (start < token.length) {
    let end = token.length
    let found = null
    while (start < end) {
      let piece = token.slice(start, end)
      if (start > 0) piece = '##' + piece
      if (vocab.has(piece)) { found = piece; break }
      end -= 1
    }
    if (found === null) return [unk]
    pieces.push(vocab.get(found))
    start = end
  }
  return pieces
}

export async function loadTokenizer(dir) {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const raw = JSON.parse(await readFile(path.join(dir, 'tokenizer.json'), 'utf8'))
  const vocab = new Map()
  for (const [token, id] of Object.entries(raw.model.vocab)) vocab.set(token, id)

  const lowerCase = raw.normalizer?.lowercase === true || raw.do_lower_case === true
  const cls = raw.post_processor?.special_tokens?.cls?.[0]?.ids?.[0] ?? vocab.get('[CLS]') ?? 101
  const sep = raw.post_processor?.special_tokens?.sep?.[0]?.ids?.[0] ?? vocab.get('[SEP]') ?? 102
  const unk = raw.model.unk_token !== undefined ? vocab.get(raw.model.unk_token) : (vocab.get('[UNK]') ?? 100)
  const mask = vocab.get('[MASK]') ?? 103
  const vocabSize = vocab.size

  return {
    vocabSize,
    cls,
    sep,
    mask,
    unk,
    /** 不含 [CLS]/[SEP]，和 transformers.js 的 add_special_tokens:false 对齐 */
    encode(text) {
      const ids = []
      for (const token of basicTokenize(text, lowerCase)) ids.push(...wordpiece(token, vocab, unk))
      return ids
    },
    /**
     * 分词 + 汉字位置映射。
     *
     * @returns {{ids: number[], charToToken: Map<number, number>}}
     *   `charToToken[汉字在原文里的 UTF-16 下标] = 该字在 ids 里的下标`。
     *   英文单词会合并成若干 token，所以只给汉字建映射（掩码打分只遮汉字）。
     */
    encodeWithPositions(text) {
      const ids = []
      const charToToken = new Map()
      for (const token of basicTokenizeSpans(text, lowerCase)) {
        const pieces = wordpiece(token.text, vocab, unk)
        if (token.cjk) charToToken.set(token.start, ids.length)
        ids.push(...pieces)
      }
      return { ids, charToToken }
    },
    /** 加上 [CLS]/[SEP]，供模型直接使用 */
    encodeForModel(text) {
      return [cls, ...this.encode(text), sep]
    },
    /** 汉字单字 → id 的反查表，供掩码打分遍历候选用 */
    singleCharIds() {
      const out = []
      for (const [token, id] of vocab) {
        if (token.length === 1 && CJK.test(token)) out.push([id, token])
      }
      return out
    },
    idOf(token) {
      return vocab.get(token)
    },
  }
}
