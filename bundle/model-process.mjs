/** A plugin-owned process keeps native DLLs out of the hot-reloaded DSH Host. */
import { fork } from 'node:child_process'

/**
 * Forward small model-service responses over IPC; model files stay on the Host's streaming route.
 * Disposal stops accepting work and waits for actual child exit before package removal can start.
 */
export function createModelProcess({ profileDirectory, requestTimeoutMs = 60_000, shutdownTimeoutMs = 5_000 } = {}) {
  let active = null, stopped = false, sequence = 0
  function start() {
    if (stopped) throw new Error('检查服务已停止')
    if (active) return active
    const child = fork(new URL('./model-worker.mjs', import.meta.url), [], {
      windowsHide: true, execArgv: process.versions.electron ? ['--expose-internals'] : [],
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    const run = { child, pending: new Map(), exited: null }
    run.exited = new Promise(resolve => child.once('close', (code, signal) => {
      if (active === run) active = null
      rejectPending(run, new Error(`检查进程已退出（${signal || code}）`))
      resolve()
    }))
    child.on('error', error => rejectPending(run, error))
    child.on('message', message => {
      const pending = run.pending.get(message?.id)
      if (!pending) return
      run.pending.delete(message.id); clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(new Response(message.body, { status: message.status, headers: message.headers }))
    })
    active = run
    child.send({ type: 'initialize', profileDirectory }, error => {
      if (error) { rejectPending(run, error); child.kill() }
    })
    return run
  }
  function rejectPending(run, error) {
    for (const pending of run.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    run.pending.clear()
  }
  return {
    get pid() { return active?.child.pid ?? null },
    request(request) {
      let run
      try { run = start() } catch (error) { return Promise.reject(error) }
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          rejectPending(run, new Error('检查超时，请重试'))
          // Keep this run active until its close event: a retry cannot race an exiting writer.
          run.child.kill()
        }, requestTimeoutMs)
        run.pending.set(id, { resolve, reject, timer })
        run.child.send({ type: 'request', id, url: request.url, method: request.method }, error => {
          if (error) { rejectPending(run, error); run.child.kill() }
        })
      })
    },
    async dispose() {
      stopped = true
      const run = active
      if (!run) return
      rejectPending(run, new Error('检查服务已停止'))
      const timer = setTimeout(() => run.child.kill(), shutdownTimeoutMs)
      try {
        if (run.child.connected) run.child.send({ type: 'stop' }, error => { if (error) run.child.kill() })
        else run.child.kill()
        await run.exited
      } finally { clearTimeout(timer) }
    },
  }
}
