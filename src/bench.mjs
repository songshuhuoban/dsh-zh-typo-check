/**
 * 量一量 check() 的单次成本，用数据决定"防抖还是每帧"。
 * 运行：node src/bench.mjs
 */
import { check } from './core.mjs'

const UNIT = '这个方案我很满意，但是我们需要在次确认一下，原因该是数据口径变了。他迫不急待的想要开始，我们应当一如继往地支持他。'

function makeText (chars) {
  let text = ''
  while (text.length < chars) text += UNIT
  return text.slice(0, chars)
}

const SIZES = [20, 60, 150, 400, 1000, 3000, 10000]

for (const size of SIZES) {
  const text = makeText(size)
  // 预热
  for (let i = 0; i < 50; i += 1) check(text)

  const samples = []
  for (let i = 0; i < 300; i += 1) {
    const start = process.hrtime.bigint()
    check(text)
    samples.push(Number(process.hrtime.bigint() - start) / 1000)
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]
  const p95 = samples[Math.floor(samples.length * 0.95)]
  const max = samples[samples.length - 1]
  console.log(
    `${String(size).padStart(6)} 字  median ${median.toFixed(1).padStart(8)} µs` +
    `   p95 ${p95.toFixed(1).padStart(8)} µs   max ${max.toFixed(1).padStart(8)} µs`
  )
}
