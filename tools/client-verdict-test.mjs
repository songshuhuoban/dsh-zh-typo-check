/** Regression tests execute the built client. Only the DOM boundary is stubbed. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(process.env.CLIENT_TEST_BUNDLE || new URL('../bundle/client.js', import.meta.url), 'utf8')
const marker = "    return {\n      inject: ['slots', 'locale'],"
assert.equal(source.split(marker).length, 2, 'test seam must identify the actual factory return')
let entry, editor = null
const sandbox = {
  console, URL, URLSearchParams, location: { pathname: '/' },
  fetch: async () => ({ ok: true }),
  window: { localStorage: { getItem: () => null, setItem() {} }, __ModuleLoader__: { load(value) { entry = value } } },
  document: {
    querySelector: () => editor,
    createRange() {
      let node, start, end
      return {
        setStart(value, offset) { node = value; start = offset },
        setEnd(_value, offset) { end = offset },
        getClientRects() {
          return node.rows.filter(row => row.start < end && row.end > start).map(row => ({
            left: 10 + (Math.max(start, row.start) - row.start) * 8, top: row.top, height: 18,
            width: (Math.min(end, row.end) - Math.max(start, row.start)) * 8,
          }))
        },
      }
    },
  },
}
vm.runInNewContext(source.replace(marker, "    return { test: { computeView, mergeModelIssues, sameGeometry },\n      inject: ['slots', 'locale'],"), sandbox)
const { computeView, mergeModelIssues, sameGeometry } = entry.factory(() => ({})).test
function setEditor(draft, split = draft.length) {
  const node = { nodeType: 3, data: draft, rows: [
    { start: 0, end: split, top: 20 }, ...(split < draft.length ? [{ start: split, end: draft.length, top: 44 }] : []),
  ] }
  editor = { children: [{ nodeType: 1, tagName: 'P', childNodes: [node], hasAttribute: () => false }],
    hasAttribute: () => false, closest: () => null }
}
const abnormal = '这个方案有点危显是的管理开始地灵龛你看了'
const guesses = [
  { index: 6, original: '危', candidate: '凸' },
  { index: 7, original: '显', candidate: '险' },
]
const warning = { low: true }
setEditor(abnormal)
const view = (found, fluency = warning, ignored = new Set()) => computeView(abnormal, 2, found, ignored, 'wave', 'stamp', fluency)
const withoutModel = view([])
assert.equal(withoutModel.issues[0].kind, 'fluency')
const withModel = view(mergeModelIssues([], guesses, abnormal, true))
assert.equal(withModel.issues.length, 1, 'incoherent context must pause unreliable MLM guesses')
assert.equal(withModel.issues[0].kind, 'fluency', 'optional model must not suppress sentence warning')
assert.deepEqual(JSON.parse(JSON.stringify(withModel)), JSON.parse(JSON.stringify(withoutModel)))
assert.equal(withModel.issues[0].suggestions.length, 0, 'whole-sentence warning must not offer a rewrite')

const normal = '这个方案有点危显，需要再评估风险。'
setEditor(normal)
const normalIssues = mergeModelIssues([], guesses.slice(1), normal, false)
assert.equal(normalIssues[0].suggestions[0], '险', 'coherent sentences retain character corrections')
const normalView = computeView(normal, 3, normalIssues, new Set(), 'wave', 'stamp', null)
assert.equal(normalView.issues.length, 1)
assert.equal(normalView.marks[0].sentence, undefined)

setEditor(abnormal, 10)
const rule = { start: 6, end: 7, kind: 'word', text: '危', context: 'context', suggestions: ['险'] }
const ruleAndSentence = view(mergeModelIssues([rule], guesses, abnormal, true))
assert.deepEqual(Array.from(ruleAndSentence.issues, issue => issue.kind), ['word', 'fluency'])
assert.equal(ruleAndSentence.marks[0].index, 0, 'specific rule wins mouse hit testing')
const sentenceMarks = ruleAndSentence.marks.filter(mark => mark.sentence)
assert.equal(sentenceMarks.length, 2, 'wrapped sentence must mark both visual lines')
assert.ok(sentenceMarks.every(mark => mark.index === 1), 'sentence marks must reference the appended issue')
assert.deepEqual(Array.from(sentenceMarks, mark => mark.top), [20, 44])
assert.equal(sentenceMarks[0].line, 41, 'blue underline must leave room for local rule underline')
assert.equal(sameGeometry(sentenceMarks, sentenceMarks.map(mark => ({ ...mark, line: mark.line + 1 }))), false, 'line-height changes must redraw underlines')
assert.equal(view([rule], warning, new Set(['fluency:' + abnormal])).issues.length, 1, 'ignoring sentence preserves rules')
assert.equal(view([], warning, new Set(['fluency:' + abnormal])), null)
assert.equal(view([], null), null, 'normal input with no issues stays undecorated')
editor.hasAttribute = () => true
assert.equal(view([]), null, 'never decorate IME composition')
console.log('PASS  client verdict consistency, safe suggestions, rule priority, wrapping, ignore and IME')
