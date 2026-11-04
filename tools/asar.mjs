// Minimal read-only .asar (SimpleAr) reader: list and extract entries without Electron.
// Usage: node asar.mjs ls <prefix> | cat <path>
import fs from 'node:fs'

const ASAR = process.env.DSH_ASAR || 'D:\\deepseek-harness\\resources\\app.asar'

function readAll (fd, buf, len, pos) {
  let done = 0
  while (done < len) {
    const n = fs.readSync(fd, buf, done, len - done, pos + done)
    if (n <= 0) break
    done += n
  }
  return done
}

const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
readAll(fd, head, 16, 0)
const headerSize = head.readUInt32LE(4)
const hb = Buffer.alloc(headerSize)
readAll(fd, hb, headerSize, 8)
const jsonStart = hb.indexOf(0x7b) // '{'
const header = JSON.parse(hb.subarray(jsonStart).toString('utf8'))
const base = 8 + headerSize
fs.closeSync(fd)

function find (p) {
  let node = { files: header.files }
  for (const s of p.split('/').filter(Boolean)) {
    if (!node.files || !node.files[s]) return null
    node = node.files[s]
  }
  return node
}

const [cmd, arg] = process.argv.slice(2)
const outFile = process.env.OUT_FILE
const out = []
function emit (line) { line.endsWith('\n') ? out.push(line) : out.push(line + '\n') }

if (cmd === 'cat') {
  const node = find(arg)
  if (!node) { console.error('not found: ' + arg); process.exit(1) }
  if (node.files) { console.error('is a directory'); process.exit(1) }
  const fdr = fs.openSync(ASAR, 'r')
  const buf = Buffer.alloc(node.size)
  readAll(fdr, buf, node.size, base + Number(node.offset))
  fs.closeSync(fdr)
  if (outFile) fs.writeFileSync(outFile, buf)
  else process.stdout.write(buf)
  process.exit(0)
} else if (cmd === 'ls') {
  const node = find(arg)
  if (!node) { console.error('not found: ' + arg); process.exit(1) }
  if (!node.files) { emit(arg + '  (file, ' + node.size + ' bytes)') } else {
    for (const [name, child] of Object.entries(node.files)) {
      emit((child.files ? 'd ' : '- ') + name + (child.files ? '' : '   ' + child.size))
    }
  }
} else {
  console.error('usage: node asar.mjs ls <path> | cat <path>')
  process.exit(2)
}

const text = out.join('')
if (outFile) fs.writeFileSync(outFile, text, 'utf8')
else process.stdout.write(text)
