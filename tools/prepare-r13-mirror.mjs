/** Prepare the frozen public R13 artifacts for another model host. No credentials or research data. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { SEMANTIC_MODEL } from '../src/semantic.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.resolve(process.argv[2] || path.join(root, '.research/model-mirror/repository'))
const supplied = process.argv[3]
const candidates = supplied ? [path.resolve(supplied)] : [
  path.join(root, '.research/semantic-round13/package/model-int8.onnx'),
  path.join(root, '.model-cache/semantic-r13-int8.onnx'),
]
let model
for (const file of candidates) {
  try { await fs.access(file); model = file; break } catch { /* try the next public artifact cache */ }
}
if (!model) throw new Error('Supply the published semantic-r13-int8.onnx as the second argument')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const weights = await fs.readFile(model)
if (weights.length !== SEMANTIC_MODEL.bytes || digest(weights) !== SEMANTIC_MODEL.sha256) {
  throw new Error('Refusing to distribute weights that differ from the frozen public R13 artifact')
}
const files = new Map([[SEMANTIC_MODEL.file, weights]])
for (const spec of Object.values(SEMANTIC_MODEL.vocabs)) {
  const bytes = await fs.readFile(path.join(root, 'bundle/data', spec.file))
  if (digest(bytes) !== spec.sha256) throw new Error('Vocabulary SHA-256 mismatch: ' + spec.file)
  files.set(spec.file, bytes)
}
for (const [name, source] of [
  ['LICENSE', 'LICENSE-APACHE-2.0'], ['LICENSE-APACHE-2.0', 'LICENSE-APACHE-2.0'],
  ['NOTICE', 'NOTICE'], ['MODEL-R13.md', 'MODEL-R13.md'],
]) files.set(name, await fs.readFile(path.join(root, 'bundle', source)))

files.set('README.md', Buffer.from(`---
license: apache-2.0
task:
  - text-classification
frameworks:
  - onnx
tags:
  - chinese
  - english
  - code-switching
  - int8
  - input-anomaly-detection
---

# R13 中英文混排输入异常检测（INT8）

用于 DSH 中文检查插件的本地整句异常提示，支持中文、英文及中英混排。模型在输入可疑时提醒用户检查，不生成替换文本。

本仓库分发固定的 **r13-20261110** 权重及两套词表，三者合计 **27,433,631 字节**。它们与原始 GitHub 模型发布一致；插件版本更新不代表模型权重变化。

## 使用

在 [dsh-zh-typo-check](https://github.com/songshuhuoban/dsh-zh-typo-check) 0.3.2 或更新版本的整句检查卡片中，展开「下载设置」，选择自定义来源，使用本仓库文件的 resolve 版本基址。插件会核对模型大小及 SHA-256。两套词表已随插件分发，本仓库同时提供独立复现所需的词表。

下载托管不提供云端推理。部署后，文字在本机处理。原始训练语料、输入法采集记录和物理随机数档案不在本仓库中。

## 推理约定

- 固定运行时：**onnxruntime-node 1.30.0**，CPU，4 个 intra-op 线程、1 个 inter-op 线程，batch 1。
- 中文及英文分别用各自词表进行 BERT WordPiece 分词，两路都读取完整输入；任一路超过 128 token（包含特殊 token）时跳过模型检查，不截断判断。
- 六个 int64 输入：z_input_ids、z_attention_mask、z_token_type_ids、e_input_ids、e_attention_mask、e_token_type_ids，形状均为 [1, sequence]。
- 输出为异常类 logit 减去 normal/context 两类 logsumexp 的 margin，**不是概率**。
- 严格大于阈值才提示：中文 5.315961837768555，英文 3.8071134090423584，混排 3.1870408058166504。
- 分词、路由和推理实现：[semantic.mjs](https://github.com/songshuhuoban/dsh-zh-typo-check/blob/5580ba2dff607491bab26de27c17d4bc51c6ca49/src/semantic.mjs)、[semantic-tokenizer.mjs](https://github.com/songshuhuoban/dsh-zh-typo-check/blob/5580ba2dff607491bab26de27c17d4bc51c6ca49/src/semantic-tokenizer.mjs)。

## 来源、许可与局限

基于 HFL Chinese ELECTRA 180G small discriminator 与 Google ELECTRA small discriminator 微调，导出双编码器图并量化为 INT8。具体来源版本、修改、已知评测集及限制见 [MODEL-R13.md](MODEL-R13.md)。保留上游 Apache-2.0 许可及 [NOTICE](NOTICE)，不改变训练数据原有的许可条件。

最终已观察的 675 条回归样本中，异常检出 89/104（真实 IME 异常 46/57），正常文本误报 4/301、依赖上下文文本误报 14/270。这些是助手标注、已经检查过的回归集，不是独立人工金标，也不是总体准确率估计。模型仍可能误报或漏报。

## 文件校验

模型 SHA-256：

da4505f9ff00fbdb26aa359b2089a32f4ae6efb56c6e03e275a489d5f1fe1cda

完整文件清单、大小和 SHA-256 见 manifest.json。原始固定发布：[GitHub r13-model-20261110](https://github.com/songshuhuoban/dsh-zh-typo-check/releases/tag/r13-model-20261110)。
`))
files.set('configuration.json', Buffer.from(JSON.stringify({ framework: 'onnx', task: 'text-classification' }, null, 2) + '\n'))
files.set('.gitattributes', Buffer.from('*.onnx filter=lfs diff=lfs merge=lfs -text\n*.txt -text\n'))
const manifest = {
  schema_version: 1, release_id: 'r13-20261110', inference: SEMANTIC_MODEL,
  files: Object.fromEntries([...files].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: digest(bytes) }])),
}
files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
await fs.mkdir(output, { recursive: true })
const unexpected = (await fs.readdir(output)).filter(name => !files.has(name))
if (unexpected.length) throw new Error('Output folder contains unplanned files; choose a fresh folder: ' + unexpected.join(', '))
// Never replace a different artifact when reusing an output folder.
for (const [name, bytes] of files) {
  const file = path.join(output, name)
  let old = null
  try { old = await fs.readFile(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (old && !old.equals(bytes)) throw new Error('Existing file differs; choose a fresh output directory: ' + name)
}
for (const [name, bytes] of files) await fs.writeFile(path.join(output, name), bytes)
console.log(JSON.stringify({ output, files: files.size, total_bytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0), model_sha256: SEMANTIC_MODEL.sha256 }))
