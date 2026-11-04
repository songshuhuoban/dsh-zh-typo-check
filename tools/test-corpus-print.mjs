/**
 * 给用户的一组测试文本：跑一遍规则层 + 模型层，打印实际会报什么。
 * 运行：node tools/test-corpus-print.mjs
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
  ['A 语义/同音错字（规则抓不到，靠模型）', [
    '我们需要在次确认一下数据口径。',
    '他因该明天就到了。',
    '我以经吃过饭了。',
    '这个方案既使有风险也要上。',
    '他做为团队的负责人很尽责。',
    '他竞然一个人搬完了所有东西。',
    '他弟弟长得很象他。',
    '那段日子过得很坚苦。',
    '请先登陆系统再提交。',
    '皮肤明显松驰了很多。',
    '请你端祥一下这幅画。',
    '肌肉开始萎宿了。',
    '我们在见面的地方等你。',
    '这份资料很有价植。',
  ]],
  ['B 一句话里多处错误（测忽略/替换后其它还能不能用）', [
    '这个功能很实用,你觉得呢?',
    '他冒然答应了对方的要求,还说这是理所当然的.',
    '我到上海住的还，可以经常包斯成晚餐咯~',
  ]],
  ['C 正常文本（不该有任何下划线）', [
    '今天的天气很好，我们一起去公园散步吧。',
    '公司完成了部署，明早开始灰度。',
    '数据安全愈发重要。',
    '张伟和李娜下周去杭州出差。',
    '这个 API 返回的是 JSON，注意大小写。',
    '我在 Windows 上用 PowerShell 跑了一遍。',
    '那份合同里写了违约金条款。',
    '那段日子过得很艰苦。',
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
