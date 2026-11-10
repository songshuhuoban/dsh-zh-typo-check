/** Frozen R13 whole-input bilingual classifier. No network, generation or truncation. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createSemanticTokenizer } from './semantic-tokenizer.mjs'

const require = createRequire(import.meta.url)
export const SEMANTIC_MODEL = Object.freeze({
  id: 'r13', file: 'semantic-r13-int8.onnx', bytes: 27092583,
  sha256: 'da4505f9ff00fbdb26aa359b2089a32f4ae6efb56c6e03e275a489d5f1fe1cda',
  runtime: '1.30.0', maxTokens: 128,
  thresholds: Object.freeze({ en: 3.8071134090423584, zh: 5.315961837768555, mixed: 3.1870408058166504 }),
  vocabs: Object.freeze({
    zh: { file: 'semantic-r13-zh.txt', sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c' },
    en: { file: 'semantic-r13-en.txt', sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3' }
  })
})
export function semanticLanguage(text) {
  return /[\u4e00-\u9fff]/u.test(text) ? /[A-Za-z]{2,}/.test(text) ? 'mixed' : 'zh' : 'en'
}
export async function semanticRuntime() {
  try {
    const ort = await import('onnxruntime-node')
    const version = require('onnxruntime-node/package.json').version
    return { available: version === SEMANTIC_MODEL.runtime, version, ort }
  } catch { return { available: false, version: null } }
}
export async function openSemanticModel(modelFile, dataDir) {
  const runtime = await semanticRuntime()
  if (!runtime.available) throw new Error('整句检查运行时不可用：需要 onnxruntime-node 1.30.0')
  const tokenizers = {}
  for (const [lang, spec] of Object.entries(SEMANTIC_MODEL.vocabs)) {
    const bytes = await fs.readFile(path.join(dataDir, spec.file))
    if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256) throw new Error('整句检查词表校验失败')
    tokenizers[lang] = createSemanticTokenizer(bytes.toString('utf8'))
  }
  const session = await runtime.ort.InferenceSession.create(modelFile, {
    intraOpNumThreads: 4, interOpNumThreads: 1, executionProviders: ['cpu']
  })
  let tail = Promise.resolve(), disposed = false
  return {
    tokenizers,
    check(text) {
      if (disposed) return Promise.reject(new Error('整句检查已停止'))
      const inputs = { zh: tokenizers.zh.encode(text), en: tokenizers.en.encode(text) }
      if (Object.values(inputs).some(ids => ids.length > SEMANTIC_MODEL.maxTokens)) {
        return Promise.resolve({ state: 'too-long', low: null, warning: null, reason: 'input-exceeds128-tokens' })
      }
      const run = tail.then(async () => {
        if (disposed) throw new Error('整句检查已停止')
        const feed = {}
        for (const [lang, ids] of Object.entries(inputs)) {
          const prefix = lang === 'zh' ? 'z_' : 'e_'
          feed[prefix + 'input_ids'] = new runtime.ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length])
          feed[prefix + 'attention_mask'] = new runtime.ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length])
          feed[prefix + 'token_type_ids'] = new runtime.ort.Tensor('int64', new BigInt64Array(ids.length), [1, ids.length])
        }
        const output = await session.run(feed), score = Number(Object.values(output)[0].data[0])
        if (!Number.isFinite(score)) throw new Error('整句检查未返回有效结果')
        const language = semanticLanguage(text), threshold = SEMANTIC_MODEL.thresholds[language]
        return { state: 'ready', engine: SEMANTIC_MODEL.id, score, language, threshold, low: score > threshold, warning: score > threshold }
      })
      tail = run.catch(() => {})
      return run
    },
    async release() { disposed = true; await tail; await session.release() }
  }
}
