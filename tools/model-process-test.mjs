/** Real native-runtime lifecycle, crash recovery, timeout containment and IPC/file routes. */
import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(root, '.tmp-process-'))
const bundle = path.join(directory, 'bundle')
await fs.cp(path.join(root, 'bundle'), bundle, { recursive: true })
// Separate physical native files: other inference suites may hold their own runtime open.
const originalRuntime = path.dirname(require.resolve('onnxruntime-node/package.json'))
const runtime = path.join(bundle, 'node_modules/onnxruntime-node')
await fs.mkdir(runtime, { recursive: true })
await fs.copyFile(path.join(originalRuntime, 'package.json'), path.join(runtime, 'package.json'))
await fs.cp(path.join(originalRuntime, 'dist'), path.join(runtime, 'dist'), { recursive: true })
const platform = path.join('bin/napi-v6', process.platform, process.arch)
await fs.cp(path.join(originalRuntime, platform), path.join(runtime, platform), { recursive: true })
const common = path.resolve(path.dirname(createRequire(path.join(originalRuntime, 'package.json')).resolve('onnxruntime-common')), '../..')
await fs.cp(common, path.join(bundle, 'node_modules/onnxruntime-common'), { recursive: true, dereference: true })
const { createModelProcess } = await import(pathToFileURL(path.join(bundle, 'model-process.mjs')))
const nativeFile = path.join(runtime, 'bin/napi-v6/win32/x64/onnxruntime_binding.node')
const worker = createModelProcess({ profileDirectory: directory })
const request = part => new Request('http://127.0.0.1/zh-typo-model/' + part)
const isAlive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
async function canWriteNative() {
  const handle = await open(nativeFile, 'r+')
  await handle.close()
}
let short
try {
  assert.equal(worker.pid, null)
  if (process.platform === 'win32') await canWriteNative()
  const status = await (await worker.request(request('status'))).json()
  assert.equal(status.runtime, true)
  assert.equal(status.state, 'absent')
  assert.ok(worker.pid && worker.pid !== process.pid)
  if (process.platform === 'win32') await assert.rejects(canWriteNative, { code: 'EBUSY' })
  console.log('PASS native runtime is loaded in a lazy child, not the Host')

  const crashed = worker.pid
  process.kill(crashed)
  for (let i = 0; i < 200 && worker.pid !== null; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(worker.pid, null)
  assert.equal((await (await worker.request(request('status'))).json()).runtime, true)
  assert.notEqual(worker.pid, crashed)
  console.log('PASS the next request starts a fresh worker after an unexpected exit')
  await worker.dispose()
  assert.equal(isAlive(crashed), false)
  await assert.rejects(worker.request(request('status')), /已停止/)
  if (process.platform === 'win32') await canWriteNative()
  console.log('PASS disposal after a crash releases native files and prevents respawn')

  const next = createModelProcess({ profileDirectory: directory })
  try {
    const result = await (await next.request(request('semantic/status'))).json()
    assert.equal(result.runtime, true)
    const pid = next.pid
    await Promise.all([next.dispose(), next.dispose()])
    assert.equal(isAlive(pid), false)
    if (process.platform === 'win32') await canWriteNative()
  } finally { await next.dispose() }
  console.log('PASS graceful and repeated disposal wait for exit and unlock native files')

  short = createModelProcess({ profileDirectory: directory, requestTimeoutMs: 1 })
  await assert.rejects(short.request(request('status')), /超时|退出/)
  const pid = short.pid
  await short.dispose()
  if (pid) assert.equal(isAlive(pid), false)
  console.log('PASS a timed-out child cannot survive completed disposal')

  const parent = await promisify(execFile)(process.execPath, [path.join(root, 'tools/fixtures/model-parent-exit.mjs'),
    pathToFileURL(path.join(bundle, 'model-process.mjs')).href, directory], { windowsHide: true })
  const orphan = Number(parent.stdout.trim())
  assert.ok(Number.isSafeInteger(orphan) && orphan > 0)
  for (let i = 0; i < 200 && isAlive(orphan); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(isAlive(orphan), false)
  if (process.platform === 'win32') {
    // The orphan has no owner-side close event. Wait for the actual filesystem outcome,
    // which can trail the Windows process-exit signal during kernel image teardown.
    for (let i = 0; i < 200; i++) {
      try { await canWriteNative(); break }
      catch (error) { if (error.code !== 'EBUSY' || i === 199) throw error }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  console.log('PASS parent exit closes the IPC worker and releases native files')
} finally {
  await worker.dispose()
  await short?.dispose()
  assert.ok(directory.startsWith(path.join(root, '.tmp-process-')))
  await fs.rm(directory, { recursive: true, force: true })
}
