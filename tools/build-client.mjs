/**
 * 构建脚本：把源码装配成可发布的运行时代码。
 *
 * 目录约定（DSH 的 bundle 规则）：
 *   /package.json        包清单，也是 npm 的发布清单
 *   /cordis.patch.yml    插件行（必须在包根）
 *   /bundle/             运行时文件：入口、client、宿主模块、词表、locale、图标
 *
 * 所以构建产物全部写进 bundle/，src/ 与 tools/ 不进 npm 包。
 *
 * Run: node tools/build-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'bundle')

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
  ['    /*__CONFIG_STORE__*/', asStatements('config-store.mjs')],
]

const templatePath = path.join(root, 'src', 'client.js')
let output = fs.readFileSync(templatePath, 'utf8')

// 客户端模块的注册 id 必须等于包名，壳才找得到。手写会漂移，从清单里读。
const manifest = JSON.parse(fs.readFileSync(path.join(outDir, '..', 'package.json'), 'utf8'))
void manifest
const bundleManifest = JSON.parse(fs.readFileSync(path.join(root, 'bundle', 'package.json'), 'utf8'))
if (!output.includes("'__PACKAGE_NAME__'")) {
  console.error('build-client: the client template lost its __PACKAGE_NAME__ placeholder')
  process.exit(1)
}
output = output.replace("'__PACKAGE_NAME__'", JSON.stringify(bundleManifest.name))
console.log(`build-client: client module id = ${bundleManifest.name}`)

for (const [marker, code] of SPLICES) {
  if (!output.includes(marker)) {
    console.error(`build-client: marker ${marker.trim()} missing from src/client.js`)
    process.exit(1)
  }
  const indented = code.split('\n').map((line) => (line === '' ? '' : '    ' + line)).join('\n')
  output = output.replace(marker, indented)
}

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'client.js'), output, 'utf8')
console.log('build-client: bundle/client.js <- src/{core,editor,config-store}.mjs + src/client.js')

// 宿主侧：推理与分词保持为独立模块，由 index.js 直接 import
const HOST_MODULES = ['core.mjs', 'tokenizer.mjs', 'infer.mjs', 'lexicon.mjs', 'l1.mjs', 'checker.mjs', 'semantic-tokenizer.mjs', 'semantic.mjs', 'semantic-service.mjs']
for (const file of HOST_MODULES) {
  fs.copyFileSync(path.join(root, 'src', file), path.join(outDir, file))
}
console.log(`build-client: bundle/{${HOST_MODULES.join(',')}} <- src/`)

// 词表与近音表：模型判据的"像话"约束靠它，1.9 MB 随插件分发
const DATA_FILES = ['l1-words.txt', 'l1-sounds.txt', 'semantic-r13-zh.txt', 'semantic-r13-en.txt']
fs.mkdirSync(path.join(outDir, 'data'), { recursive: true })
for (const file of DATA_FILES) {
  fs.copyFileSync(path.join(root, 'data', file), path.join(outDir, 'data', file))
}
console.log(`build-client: bundle/data/{${DATA_FILES.join(',')}} <- data/`)

// 发布包要带使用者看的 README 和许可证（npm 从包根读取）
for (const file of ['README.md', 'LICENSE', 'MODEL-R13.md', 'NOTICE', 'LICENSE-APACHE-2.0']) {
  fs.copyFileSync(path.join(root, file), path.join(outDir, file))
}
console.log('build-client: bundle/{README.md,LICENSE} <- 仓库根')
