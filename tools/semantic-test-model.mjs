import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { SEMANTIC_MODEL } from '../src/semantic.mjs'
import { SEMANTIC_URL } from '../src/semantic-service.mjs'
const root = path.resolve(import.meta.dirname, '..')
export async function semanticTestModel() {
  const cache = path.join(root, '.model-cache', SEMANTIC_MODEL.file)
  const candidates = [process.env.SEMANTIC_TEST_MODEL, cache,
    path.join(root, '.research/semantic-round13/package/model-int8.onnx')].filter(Boolean)
  for (const file of candidates) {
    try {
      const bytes = await fs.readFile(file)
      if (bytes.length === SEMANTIC_MODEL.bytes && createHash('sha256').update(bytes).digest('hex') === SEMANTIC_MODEL.sha256) return file
    } catch {}
  }
  const response = await fetch(SEMANTIC_URL, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`Pinned R13 test model unavailable: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== SEMANTIC_MODEL.bytes || createHash('sha256').update(bytes).digest('hex') !== SEMANTIC_MODEL.sha256) throw new Error('R13 test model checksum mismatch')
  await fs.mkdir(path.dirname(cache), { recursive: true }); await fs.writeFile(cache, bytes)
  return cache
}
