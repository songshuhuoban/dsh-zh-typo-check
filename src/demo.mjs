/**
 * 原型跑分：拿真实对话里会出现的句子，看判定内核报什么、漏什么、错什么。
 * 运行：node src/demo.mjs
 */
import { check, annotate } from './core.mjs'

const CASES = [
  {
    text: '这个方案我很满意，但是我们需要在次确认一下，原因该是数据口径变了。',
    expect: ['在次'],
  },
  {
    text: '他迫不急待的想要开始，我们应当一如继往地支持他。',
    expect: ['迫不急待', '一如继往'],
  },
  {
    text: '这次谈判我们绝不能甘败下风，要谈笑风声、从容应对。',
    expect: ['甘败下风', '谈笑风声'],
  },
  {
    text: '按耐不住内心的激动，他迫不急待地冲了出去。',
    expect: ['按耐不住', '迫不急待'],
  },
  {
    text: '这个功能很实用,你觉得呢?',
    expect: [',', '?'],
  },
  {
    text: '请把这段贴在 `const a = 1, b = 2` 里，然后运行 npm run build,再告诉我结果。',
    expect: [],
  },
  {
    text: '打开 D:\\work\\app\\index.ts,看看 useEffect 的依赖数组。',
    expect: [],
  },
  {
    text: '的的确确是这样的，不用担心。',
    expect: [],
  },
  {
    text: '好的，我知道了，明早九点见。',
    expect: [],
  },
  {
    text: '现在我们赶紧过去，别让他们等太久。',
    expect: [],
  },
  {
    text: '这个功能很实用，，你觉得呢？？',
    expect: ['，，', '？？'],
  },
  {
    text: '这次发布会由张总主持，锲而不舍地推进了半年。',
    expect: [],
  },
  {
    text: '他契而不舍地推进了半年,终于有了结果。',
    expect: ['契而不舍', ','],
  },
  {
    // 真实报障：句末「的还」应为「的话」，同时「可以经常」不能误报成「以经」
    text: '我到上海住的还，可以经常包斯成晚餐咯~',
    expect: ['还'],
  },
  {
    text: '他的还不错的，你别担心。',
    expect: [],
  },
  {
    // 二字错形不能落进更长合法词的肚子里
    text: '这件既便宜又好用，值得买。',
    expect: [],
  },
  {
    text: '我们现在见面聊吧。',
    expect: [],
  },
  {
    // 同样的字出现在真错处时仍要报
    text: '我以经吃过了，我们在次确认一下。',
    expect: ['以经', '在次'],
  },
]

let pass = 0
let total = 0
let falsePositives = 0
let missed = 0

for (const testCase of CASES) {
  const issues = check(testCase.text)
  const found = issues.map((issue) => issue.text)
  const ok = found.length === testCase.expect.length && testCase.expect.every((want) => found.includes(want))
  total += 1
  if (ok) pass += 1
  else {
    missed += testCase.expect.filter((want) => !found.includes(want)).length
    falsePositives += found.filter((got) => !testCase.expect.includes(got)).length
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${testCase.text}`)
  if (issues.length > 0) console.log(annotate(testCase.text, issues).split('\n').map((line) => '      ' + line).join('\n'))
  for (const issue of issues) {
    console.log(`      -> [${issue.kind} ${issue.confidence}] ${issue.text} => ${issue.suggestions.join(' / ')}`)
  }
  console.log('')
}

console.log(`通过 ${pass}/${total}   漏报 ${missed}   误报 ${falsePositives}`)
