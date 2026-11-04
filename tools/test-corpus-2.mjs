/**
 * 第二批测试文本：跑一遍规则层 + 模型层，打印实际会报什么。
 * 运行：node tools/test-corpus-2.mjs
 */
import path from 'node:path'
import { check } from '../src/core.mjs'
import { openModel } from '../src/infer.mjs'
import { loadLexicon } from '../src/lexicon.mjs'
import { checkText, loadL1 } from '../src/checker.mjs'

const root = path.resolve(import.meta.dirname, '..')
const dataDir = path.join(root, 'data')
await loadL1(dataDir)
const lexicon = await loadLexicon(dataDir)
const model = await openModel(
  path.join(root, 'node_modules/@huggingface/transformers/.cache/Xenova/macbert4csc-base-chinese')
)

const GROUPS = [
  ['A 同音/近音错字', [
    '请把文件发到我的邮相里。',
    '这个方案的风显太高了。',
    '我们必须要重视这个问提。',
    '这件事对你的生话影响很大。',
    '会议室里的空气很浑浊。',
    '他的建意值得考虑。',
    '请把窗户关好，别让蚊子近来。',
    '这次布署方案还要再讨论一下。',
    '他一口答应了，显得很豪爽。',
  ]],
  ['B 成语误字', [
    '他做事总是一丝不狗。',
    '这个方案美中不族。',
    '大家对他的做法议论纷纷，褒贬不一。',
  ]],
  ['C 半角标点', [
    '你好,请问会议几点开始?',
    '先把结论写出来,再补细节.',
  ]],
  ['D 一句多处错误', [
    '我们必须要重视这个问提,别在拖了。',
    '他的建意不错,但是风显太大.',
  ]],
  ['E 正常文本（不该有任何下划线）', [
    '张总说下周一去深圳出差。',
    '这段代码用 TypeScript 写的，编译通过。',
    '会议纪要已经发到群里了，请大家查收。',
    '这个功能预计在下个版本上线。',
    '我们在 GitHub 上开了一个 issue 跟踪这个问题。',
    '他的方案兼顾成本和进度，大家都没有异议。',
    '请先登录系统再提交。',
    '帐篷在风里晃了一夜。',
  ]],
  ['F 长段落', [
    '今天的评审结论如下：产品侧确认了三个优先级,技术侧还在评估改动范围。整体看风险可控,预计下周三给出排期。',
  ]],
]

for (const [title, rows] of GROUPS) {
  console.log(`\n=== ${title} ===`)
  for (const text of rows) {
    const l0 = check(text).map((i) => `${i.text}→${i.suggestions[0]}`)
    const l2 = (await checkText(model, lexicon, text)).map((i) => `${i.original}→${i.candidate}(${i.route},Δ${i.delta.toFixed(1)})`)
    const parts = []
    if (l0.length > 0) parts.push('规则: ' + l0.join(' '))
    if (l2.length > 0) parts.push('模型: ' + l2.join(' '))
    console.log(`${parts.length === 0 ? '  —' : '  ' + parts.join('   |   ')}`)
    console.log(`    ${text}`)
  }
}
