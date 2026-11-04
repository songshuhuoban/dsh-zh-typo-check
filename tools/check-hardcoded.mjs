/** 检查某个函数体里是否还有硬编码中文（注释除外）。 */
import fs from 'node:fs'

const file = process.argv[2]
const marker = process.argv[3]
const until = process.argv[4]
const src = fs.readFileSync(file, 'utf8')
const start = src.indexOf(marker)
const end = until === undefined ? src.length : src.indexOf(until, start)
if (start < 0 || end <= start) {
  console.log('范围没找到：', marker, until)
  process.exit(1)
}
const body = src.slice(start, end)
const offenders = []
for (const [index, line] of body.split('\n').entries()) {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
  // 单引号或模板字符串里出现汉字
  if (/'[^']*[\u4e00-\u9fff][^']*'/.test(line) || /`[^`]*[\u4e00-\u9fff][^`]*`/.test(line)) {
    offenders.push(`${index + 1}: ${trimmed}`)
  }
}
console.log(offenders.length === 0 ? '（无硬编码中文）' : offenders.join('\n'))
