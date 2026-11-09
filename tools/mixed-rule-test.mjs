/**
 * 中英混排的规则层验证（不需要模型）。
 *
 * 这是高频场景：英文单词、代码、URL、点文件旁边紧挨着中文标点，规则层不能把这些
 * 当成"中文里的半角标点"报出来；同时混排句里的中文错字（的还→的话）仍要报。
 *
 * Run: node tools/mixed-rule-test.mjs
 */
import { check } from '../src/core.mjs'

let pass = 0
let fail = 0
function expect(label, actual, wanted) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted)
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(wanted)}`)
}

// ---- 1. 正确的中英混排：规则层不能误报 ----
const CLEAN = [
  '这个 API 的 timeout 设置需要调整一下。',
  '记得把 token 放到 .env 文件里。',
  '把 config.json 里的参数改成 true。',
  '看这个文档 https://example.com/api?x=1&y=2 就行了。',
  '调用 getUserInfo() 获取用户信息。',
  '服务器跑在 127.0.0.1:8080 端口上。',
  '前端用 React，后端用 Node.js 写。',
  '这个 PR 合并前记得跑一下测试。',
  '用 npm install 装一下依赖。',
  'Please update the README before release.',
]
for (const text of CLEAN) {
  const issues = check(text)
  expect(`不误报：${text}`, issues.map((issue) => `${issue.kind}:${issue.text}`), [])
}

// ---- 2. 混排里的中文错字仍要报 ----
const TYPO = [
  ['我到上海住的还，可以用API测试。', 'word', '话'],
  ['会议上大家各抒己见。', null, null],
]
expect('混排句里的「的还」仍被规则抓到',
  check(TYPO[0][0]).map((issue) => `${issue.kind}:${issue.suggestions[0]}`),
  ['word:话'])
expect('纯中文正常句仍然零命中', check(TYPO[1][0]), [])

// ---- 3. 中文语境里的半角标点仍要报（别为了混排把规则关掉）----
const PUNCT = ['你好,世界', '这个方案还不错,可以试试', '真的吗?我看看']
for (const text of PUNCT) {
  expect(`中文半角标点仍报：${text}`,
    check(text).filter((issue) => issue.kind === 'punct').length > 0, true)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail > 0) process.exit(1)
