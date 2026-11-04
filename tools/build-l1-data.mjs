/**
 * 从 segmentit 内置词典里抽出 L1 需要的两份数据，写成紧凑文本，用于离线评估。
 *
 *   data/l1-words.txt    二字词 + 词频排名，制表符分隔
 *   data/l1-sounds.txt   同音组，`soundKey=字字字` 每行一组
 *
 * 运行时（含将来的浏览器端）只加载这两份，不加载 segmentit 的 3.6MB 词典。
 *
 * Run: node tools/build-l1-data.mjs [maxRank]
 */
import fs from 'node:fs'
import path from 'node:path'
import segmentitPkg from 'segmentit'
import { pinyin } from 'pinyin-pro'
import { soundKey } from '../src/l1.mjs'

const MAX_RANK = Number(process.argv[2] ?? 1e9)
const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'data')

const segment = segmentitPkg.useDefault(new segmentitPkg.Segment())
const table = segment.DICT.TABLE
const entries = Object.entries(table)

// ---- words ----
const isHanzi = (ch) => /[\u4e00-\u9fff]/u.test(ch)
const words = entries
  .filter(([word, meta]) => word.length >= 2 && word.length <= 4 && [...word].every(isHanzi) && meta.f > 0 && meta.f <= MAX_RANK)
  .sort((a, b) => a[1].f - b[1].f)

const wordsText = words.map(([word, meta]) => `${word}\t${meta.f}`).join('\n') + '\n'

// ---- sounds ----
const chars = new Set()
for (const [word] of entries) for (const ch of word) if (isHanzi(ch)) chars.add(ch)

const groups = new Map()
for (const ch of chars) {
  // 带声调：同音组里再按声调分开。实测这一步砍掉了绝大部分误报
  // （到 dào / 岛 dǎo、一 yī / 异 yì 只是同音不同调）。
  const readings = String(pinyin(ch, { multiple: true, toneType: 'num' })).split(/\s+/u)
  for (const reading of readings) {
    const match = /^([a-z]+)(\d)$/u.exec(reading)
    if (match === null) continue
    const key = soundKey(match[1]) + match[2]
    const bucket = groups.get(key) ?? []
    if (!bucket.includes(ch)) bucket.push(ch)
    groups.set(key, bucket)
  }
}

const soundsText = [...groups]
  .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([key, list]) => `${key}=${list.join('')}`)
  .join('\n') + '\n'

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'l1-words.txt'), wordsText, 'utf8')
fs.writeFileSync(path.join(outDir, 'l1-sounds.txt'), soundsText, 'utf8')

const kb = (text) => (Buffer.byteLength(text, 'utf8') / 1024).toFixed(0)
console.log(`l1-words.txt   ${words.length} words  ${kb(wordsText)} KB`)
console.log(`l1-sounds.txt  ${chars.size} chars / ${groups.size} groups  ${kb(soundsText)} KB`)
