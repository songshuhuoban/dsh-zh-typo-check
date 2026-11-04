/**
 * 反例集：专门找判定内核的误报。这里记录的不是"修好了"，而是"当前会错成什么样"，
 * 用来证明仅靠词表+规则的天花板在哪里。
 * 运行：node src/adversarial.mjs
 */
import { check } from './core.mjs'

const CASES = [
  '现在在现场的人已经到齐了。',
  '他存在在这里，一直在等着。',
  '我认为应该是这样的。',
  '这个问题的原因该是配置项写错了。',
  '他的账户余额不足。',
  '这套体系已经很成熟了。',
  '事故发生的原因还没有查明。',
  '我在做一次完整的回归测试。',
  '他说的对，我们就按这个来。',
  '这段代码的依赖关系很复杂。',
  '会议上大家各抒己见。',
  '我们需要在短期内完成部署。',
  '警方包围巢穴之后展开了搜查。',
  '公司大肆业务扩张，风险随之而来。',
  '遵循私人约定也是一种保障。',
  '数据安全愈发重要，必须提前准备。',
]

let flagged = 0
for (const text of CASES) {
  const issues = check(text)
  if (issues.length === 0) {
    console.log(`干净  ${text}`)
    continue
  }
  flagged += 1
  console.log(`误报  ${text}`)
  for (const issue of issues) console.log(`      -> ${issue.kind} ${issue.text} => ${issue.suggestions.join(' / ')}`)
}
console.log(`\n${CASES.length} 句里误报 ${flagged} 句`)
