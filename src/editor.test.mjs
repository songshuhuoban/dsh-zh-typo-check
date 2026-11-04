/**
 * Offset-mapping tests for src/editor.mjs.
 *
 * The failure this guards against is total: if `buildIndex` reconstructs text
 * that differs from the draft by even one character, the plugin refuses to
 * measure and no underline ever appears. A hand-built node graph is enough to
 * pin the paragraph / line-break / chip rules without a browser.
 *
 * Run: node src/editor.test.mjs
 */
import { buildIndex, rangeRects } from './editor.mjs'

// ---- a minimal node graph (just the members buildIndex reads) ----
const text = (data) => ({ nodeType: 3, data })
const el = (tagName, childNodes = [], attrs = []) => ({
  nodeType: 1,
  tagName,
  childNodes,
  hasAttribute: (name) => attrs.includes(name),
})
const root = (...blocks) => ({ children: blocks })

// ---- a Range stub that reports one fixed rectangle ----
let lastRange = null
globalThis.document = {
  createRange: () => {
    const range = {
      startNode: null, startOffset: 0, endNode: null, endOffset: 0,
      setStart(node, offset) { this.startNode = node; this.startOffset = offset },
      setEnd(node, offset) { this.endNode = node; this.endOffset = offset },
      getClientRects: () => [{ left: 10, top: 20, width: 30, height: 18 }],
    }
    lastRange = range
    return range
  },
}

let pass = 0
let fail = 0
function expect(label, actual, wanted) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted)
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(wanted)}`)
}

// 1. one paragraph
expect('单段落', buildIndex(root(el('P', [text('这个方案')]))).text, '这个方案')

// 2. paragraph breaks become newlines
expect(
  '两段落之间补 \\n',
  buildIndex(root(el('P', [text('第一段')]), el('P', [text('第二段')]))).text,
  '第一段\n第二段',
)

// 3. a chip contributes nothing
expect(
  '跳过 chip 子树',
  buildIndex(root(el('P', [text('看这个 '), el('SPAN', [text('@src/a.ts')], ['data-lexical-decorator']), text(' 文件')]))).text,
  '看这个  文件',
)

// 4. an explicit line break inside a paragraph
expect(
  '段内 <br> 记作 \\n',
  buildIndex(root(el('P', [text('上行'), el('BR'), text('下行')]))).text,
  '上行\n下行',
)

// 5. offsets are continuous across nodes
const nested = buildIndex(root(el('P', [text('ab'), el('SPAN', [text('cde')]), text('f')])))
expect('跨节点偏移', nested.nodes.map((n) => [n.start, n.end]), [[0, 2], [2, 5], [5, 6]])
expect('跨节点拼接', nested.text, 'abcdef')

// 6. a range inside one node keeps its offsets
rangeRects(nested, 2, 5)
expect('单节点区间偏移', [lastRange.startOffset, lastRange.endOffset], [0, 3])

// 7. a range spanning nodes is split and clamped
lastRange = null
const rects = rangeRects(nested, 1, 5)
expect('跨节点区间裁成两段', rects.length, 2)

// 8. a range covering only whitespace/no text yields nothing
expect('空区间不产生矩形', rangeRects(nested, 3, 3).length, 0)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail > 0) process.exit(1)