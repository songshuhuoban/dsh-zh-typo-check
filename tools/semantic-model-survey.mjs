/** Public, anonymous HF metadata only. The card/README supplies task evidence. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ids = [
  'uer/chinese_roberta_L-2_H-128', 'hfl/minirbt-h256',
  'hfl/chinese-electra-180g-small-discriminator', 'hfl/rbt3',
  'ckiplab/albert-tiny-chinese', 'microsoft/Multilingual-MiniLM-L12-H384',
  'pszemraj/gibberish_detector_onnx-quant-avx2', 'flowxai/gibberish',
  'Qwen/Qwen3.5-0.8B',
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  'kotoshu/grammar-cjk', 'EstherT/sentence-acceptability', 'CodeTed/Chinese_Grammarly',
]
const results = []
for (const id of ids) {
  const response = await fetch('https://huggingface.co/api/models/' + id + '?blobs=true', { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(id + ': HTTP ' + response.status)
  const info = await response.json()
  results.push({ id, revision: info.sha, pipeline: info.pipeline_tag ?? null,
    license: info.cardData?.license ?? null, languages: info.cardData?.language ?? null,
    files: info.siblings.filter(f => /\.(onnx|bin|safetensors|gguf)$/.test(f.rfilename))
      .map(f => ({ path: f.rfilename, bytes: f.size ?? null })) })
  const card = await fetch('https://huggingface.co/' + id + '/resolve/' + info.sha + '/README.md', { signal: AbortSignal.timeout(30000) })
  if (card.ok) {
    const directory = path.join(root, '.research', 'semantic-screen', 'cards')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, id.replaceAll('/', '--') + '.md'), await card.text())
  }
}
const output = path.join(root, '.research', 'semantic-screen', 'hf-survey.json')
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, JSON.stringify({ date: '2026-11-09', models: results }, null, 2) + '\n')
for (const row of results) console.log(JSON.stringify(row))
