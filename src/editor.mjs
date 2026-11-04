/**
 * Editor text <-> draft offset mapping.
 *
 * The composer is a Lexical contenteditable, not a textarea, so the only
 * reliable source of glyph geometry is the DOM itself. These helpers walk the
 * editor's text nodes once and answer two questions:
 *
 *   - which draft offsets does the DOM currently represent (buildIndex), and
 *   - where on screen does a draft range sit (rangeRects).
 *
 * They deliberately stay free of React and of any Harness package so they can
 * be unit-tested against a hand-built node graph.
 */

/**
 * Concatenate the editor's visible text in draft order and remember where every
 * text node starts. Chips (decorator nodes) are skipped: draft offsets around
 * them would not match their DOM, so the caller drops the whole measurement
 * when the two disagree.
 *
 * @param root the composer's contenteditable element
 * @returns {{ text: string, nodes: Array<{start:number,end:number,node:Text}> }}
 */
export function buildIndex(root) {
  const nodes = []
  let text = ''
  const walk = (element) => {
    for (const child of element.childNodes) {
      if (child.nodeType === 3) {
        nodes.push({ start: text.length, end: text.length + child.data.length, node: child })
        text += child.data
        continue
      }
      if (child.nodeType !== 1) continue
      if (child.tagName === 'BR') { text += '\n'; continue }
      if (child.hasAttribute('data-lexical-decorator')) continue
      walk(child)
    }
  }
  const blocks = root.children
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    if (block.hasAttribute('data-lexical-decorator')) continue
    if (text !== '' || i > 0) text += '\n'
    walk(block)
  }
  return { text, nodes }
}

/**
 * Viewport rectangles covering one draft range, split across text nodes.
 *
 * @param index result of buildIndex
 * @param start draft offset of the first character
 * @param end draft offset just past the last character
 * @returns viewport rectangles, in reading order
 */
export function rangeRects(index, start, end) {
  const rects = []
  for (const entry of index.nodes) {
    if (entry.end <= start) continue
    if (entry.start >= end) break
    const from = Math.max(start, entry.start) - entry.start
    const to = Math.min(end, entry.end) - entry.start
    if (to <= from) continue
    const range = document.createRange()
    range.setStart(entry.node, from)
    range.setEnd(entry.node, to)
    for (const rect of range.getClientRects()) {
      if (rect.width > 0.5 && rect.height > 0.5) {
        rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      }
    }
  }
  return rects
}

