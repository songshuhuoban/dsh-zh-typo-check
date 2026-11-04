/**
 * 把宿主侧要用的模块放进 bundle/。
 *
 * bundle/ 是可发布的插件目录，只能引用它自己的文件——所以推理相关的
 * 源码要在构建时复制过去，而不是从 src/ 里 import。
 *
 * Run: node tools/build-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

/** Strip module syntax: only top-level `export` keywords exist in these files. */
function asStatements(file) {
  const source = fs.readFileSync(path.join(root, 'src', file), 'utf8')
  return source
    .replace(/^export\s+/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*$/gm, '')
    .trimEnd()
}

const SPLICES = [
  ['    /*__CORE__*/', asStatements('core.mjs')],
  ['    /*__EDITOR__*/', asStatements('editor.mjs')],
]

const templatePath = path.join(root, 'src', 'client.js')
let output = fs.readFileSync(templatePath, 'utf8')

for (const [marker, code] of SPLICES) {
  if (!output.includes(marker)) {
    console.error(`build-client: marker ${marker.trim()} missing from src/client.js`)
    process.exit(1)
  }
  const indented = code.split('\n').map((line) => (line === '' ? '' : '    ' + line)).join('\n')
  output = output.replace(marker, indented)
}

const outPath = path.join(root, 'bundle', 'client.js')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, output, 'utf8')
console.log(`build-client: bundle/client.js <- src/core.mjs + src/editor.mjs + src/client.js`)

// 宿主侧：推理与分词保持为独立模块，由 index.js 直接 import
const HOST_MODULES = ['core.mjs', 'tokenizer.mjs', 'infer.mjs', 'lexicon.mjs', 'l1.mjs', 'checker.mjs']
for (const file of HOST_MODULES) {
  fs.copyFileSync(path.join(root, 'src', file), path.join(root, 'bundle', file))
}
console.log(`build-client: bundle/{${HOST_MODULES.join(',')}} <- src/`)

// 词表与近音表：模型判据的"像话"约束靠它，1.9 MB 随插件分发
const DATA_FILES = ['l1-words.txt', 'l1-sounds.txt']
fs.mkdirSync(path.join(root, 'bundle', 'data'), { recursive: true })
for (const file of DATA_FILES) {
  fs.copyFileSync(path.join(root, 'data', file), path.join(root, 'bundle', 'data', file))
}
console.log(`build-client: bundle/data/{${DATA_FILES.join(',')}} <- data/`)

// 发布包的 README 用面向使用者的那一份
fs.copyFileSync(path.join(root, 'README.md'), path.join(root, 'bundle', 'README.md'))
console.log('build-client: bundle/README.md <- README.md')
