/** Profile-scoped R13 download/readiness/lifecycle, independent of typo-model state. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { SEMANTIC_MODEL, semanticRuntime, openSemanticModel } from './semantic.mjs'

export const SEMANTIC_URL = 'https://github.com/songshuhuoban/dsh-zh-typo-check/releases/download/r13-model-20261110/semantic-r13-int8.onnx'
export function createSemanticService({ directory, dataDirectory, url = process.env.ZH_TYPO_SEMANTIC_URL || SEMANTIC_URL } = {}) {
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
  async function beginDownload(base) {
    if (download) return state
    if (closed) throw new Error('整句检查已停止')
    let source = url
    if (base) {
      const parsed = new URL(base)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('下载地址需要 http:// 或 https://')
      source = base.replace(/\/+$/, '') + '/' + SEMANTIC_MODEL.file
    }
    const controller = new AbortController(), job = { controller, promise: null }
    download = job
    state = { ...state, state: 'downloading', bytes: 0, error: null }
    job.promise = (async () => {
      const part = modelFile + '.part'
      try {
        await fs.mkdir(directory, { recursive: true })
        const response = await fetch(source, { signal: controller.signal, redirect: 'follow' })
        if (!response.ok || !response.body) throw new Error('下载失败：HTTP ' + response.status)
        const file = await fs.open(part, 'w'), hash = createHash('sha256')
        let written = 0
        try {
          for await (const chunk of response.body) {
            written += chunk.length
            if (written > SEMANTIC_MODEL.bytes) throw new Error('整句模型文件大小不符')
            await file.write(chunk); hash.update(chunk)
            state = { ...state, bytes: written }
          }
        } finally { await file.close() }
        state = { ...state, state: 'verifying' }
        if (written !== SEMANTIC_MODEL.bytes || hash.digest('hex') !== SEMANTIC_MODEL.sha256) throw new Error('整句模型校验失败，请重试')
        if (controller.signal.aborted || closed) throw new Error('下载已取消')
        await unload(); await fs.rename(part, modelFile)
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
