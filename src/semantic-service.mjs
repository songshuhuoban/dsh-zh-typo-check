/** Profile-scoped R13 download/readiness/lifecycle, independent of typo-model state. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { SEMANTIC_MODEL, semanticRuntime, openSemanticModel } from './semantic.mjs'

export const SEMANTIC_URL = 'https://github.com/songshuhuoban/dsh-zh-typo-check/releases/download/r13-model-20261110/semantic-r13-int8.onnx'
export const SEMANTIC_SOURCES = Object.freeze({
  mirror: 'https://modelscope.cn/models/SimoneWang/dsh-input-anomaly-r13-int8/resolve/r13-261110/semantic-r13-int8.onnx',
  official: SEMANTIC_URL,
})
const SOURCE_NAMES = { mirror: '魔搭', official: 'GitHub', custom: '自定义' }

/** Bound connection and network-idle time, without limiting an actively progressing download. */
async function downloadFrom(source, part, signal, { connectTimeoutMs, idleTimeoutMs, onProgress, onVerify }) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  let timer, timeoutError
  const arm = (ms, message) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timeoutError = new Error(message)
      controller.abort(timeoutError)
    }, ms)
  }
  try {
    arm(connectTimeoutMs, '连接超时')
    const response = await fetch(source, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error('HTTP ' + response.status)
    arm(idleTimeoutMs, '下载长时间无进展')
    const file = await fs.open(part, 'w'), hash = createHash('sha256')
    let written = 0
    try {
      for await (const chunk of response.body) {
        arm(idleTimeoutMs, '下载长时间无进展')
        written += chunk.length
        if (written > SEMANTIC_MODEL.bytes) throw new Error('整句模型文件大小不符')
        await file.writeFile(chunk); hash.update(chunk)
        onProgress(written)
      }
    } finally { await file.close() }
    clearTimeout(timer)
    onVerify()
    if (written !== SEMANTIC_MODEL.bytes || hash.digest('hex') !== SEMANTIC_MODEL.sha256) throw new Error('整句模型校验失败')
    return written
  } catch (error) {
    throw timeoutError && !signal.aborted ? timeoutError : error
  } finally {
    clearTimeout(timer)
    controller.abort()
    signal.removeEventListener('abort', abort)
  }
}

export function createSemanticService({ directory, dataDirectory, url = process.env.ZH_TYPO_SEMANTIC_URL || '',
  sources = SEMANTIC_SOURCES, connectTimeoutMs = 8000, idleTimeoutMs = 15000 } = {}) {
  const modelFile = path.join(directory, SEMANTIC_MODEL.file)
  let state = { state: 'absent', bytes: 0, total: SEMANTIC_MODEL.bytes, error: null, engine: 'r13' }
  let verified = null, loading = null, opened = null, download = null, generation = 0, closed = false
  async function status() {
    const runtime = await semanticRuntime()
    const runtimeInfo = { runtime: runtime.available, runtimeVersion: runtime.version, revision: generation }
    if (download) return { ...state, ...runtimeInfo }
    try {
      const stat = await fs.stat(modelFile), stamp = `${stat.size}:${stat.mtimeMs}`
      if (stat.size !== SEMANTIC_MODEL.bytes) throw new Error('整句模型文件不完整，请重新下载')
      if (verified !== stamp) {
        const bytes = await fs.readFile(modelFile)
        if (createHash('sha256').update(bytes).digest('hex') !== SEMANTIC_MODEL.sha256) throw new Error('整句模型校验失败，请重新下载')
        verified = stamp
      }
      state = { ...state, state: 'ready', bytes: stat.size, error: null }
    } catch (error) {
      // A failed download leaves no final file. Preserve its error until an explicit
      // retry/cancel/remove, rather than making the next poll look like a fresh install.
      if (error.code !== 'ENOENT' || state.state !== 'error') {
        state = { ...state, state: error.code === 'ENOENT' ? 'absent' : 'error', bytes: 0,
          error: error.code === 'ENOENT' ? null : error.message }
      }
    }
    return { ...state, ...runtimeInfo }
  }
  async function unload() {
    const pending = loading
    if (pending) { try { await pending } catch {} }
    const current = opened; opened = null; loading = null
    if (current) await current.release()
  }
  async function check(text) {
    if (closed) return { state: 'unavailable', low: null, warning: null, reason: 'stopped' }
    const ready = await status()
    if (ready.state !== 'ready') return { state: ready.state, low: null, warning: null, reason: 'semantic-model-' + ready.state }
    if (!ready.runtime) return { state: 'unavailable', low: null, warning: null, reason: 'no-runtime', error: '整句检查运行时不可用' }
    try {
      if (!opened && !loading) loading = openSemanticModel(modelFile, dataDirectory).then(value => { opened = value; return value }).finally(() => { loading = null })
      const model = opened ?? await loading
      if (closed) return { state: 'unavailable', low: null, warning: null, reason: 'stopped' }
      return await model.check(text)
    } catch (error) {
      return { state: 'unavailable', low: null, warning: null, reason: 'inference-error', error: error.message }
    }
  }
  async function beginDownload(choice = {}) {
    if (download) return state
    if (closed) throw new Error('整句检查已停止')
    // The old API accepted a custom base string. Keep it usable by older clients.
    if (typeof choice === 'string') choice = choice ? { source: 'custom', customBase: choice } : {}
    const source = choice.source ?? 'auto'
    if (!['auto', 'mirror', 'official', 'custom'].includes(source)) throw new Error('未知的下载来源')
    let candidates
    if (source === 'custom') {
      const base = String(choice.customBase ?? '').trim()
      const parsed = new URL(base)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('下载地址需要 http:// 或 https://')
      candidates = [{ source: 'custom', url: base.replace(/\/+$/, '') + '/' + SEMANTIC_MODEL.file }]
    } else if (url) {
      // An explicit deployment/test URL remains authoritative and never contacts a public source.
      candidates = [{ source: 'custom', url }]
    } else candidates = (source === 'auto' ? ['mirror', 'official'] : [source])
      .map(key => ({ source: key, url: sources[key] }))
    const controller = new AbortController(), job = { controller, promise: null }
    download = job
    state = { ...state, state: 'downloading', bytes: 0, error: null, source: candidates[0].source,
      sourceChoice: source, attempt: 1, attempts: candidates.length }
    job.promise = (async () => {
      const part = modelFile + '.part'
      try {
        await fs.mkdir(directory, { recursive: true })
        let written, failures = []
        for (const [index, candidate] of candidates.entries()) {
          if (controller.signal.aborted || closed) throw new Error('下载已取消')
          state = { ...state, state: 'downloading', bytes: 0, source: candidate.source, attempt: index + 1 }
          try {
            written = await downloadFrom(candidate.url, part, controller.signal, {
              connectTimeoutMs, idleTimeoutMs,
              onProgress: bytes => { state = { ...state, bytes } },
              onVerify: () => { state = { ...state, state: 'verifying' } },
            })
            break
          } catch (error) {
            await fs.rm(part, { force: true })
            if (controller.signal.aborted || closed) throw error
            failures.push(SOURCE_NAMES[candidate.source] + '：' + error.message)
          }
        }
        if (written === undefined) throw new Error('下载失败（' + failures.join('；') + '），请重试或更换来源')
        await unload()
        if (controller.signal.aborted || closed) throw new Error('下载已取消')
        await fs.rename(part, modelFile)
        verified = null; generation++; state = { ...state, state: 'ready', bytes: written, error: null }
      } catch (error) {
        await fs.rm(part, { force: true })
        state = { ...state, state: controller.signal.aborted || closed ? 'absent' : 'error', bytes: 0,
          error: controller.signal.aborted || closed ? null : error.message }
      } finally { if (download === job) download = null }
    })()
    return state
  }
  async function cancel() {
    const active = download
    if (active) { active.controller.abort(); await active.promise }
    return status()
  }
  async function remove() {
    await cancel(); await unload()
    await fs.rm(modelFile, { force: true }); verified = null; generation++
    state = { ...state, state: 'absent', bytes: 0, error: null }
    return status()
  }
  async function dispose() { closed = true; await cancel(); await unload() }
  return { status, check, beginDownload, cancel, remove, dispose }
}
