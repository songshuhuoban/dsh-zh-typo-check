/** Private IPC worker; no listener, account, credentials, or DSH plugin runtime is initialized. */
import { initializeModelResources, resource, disposeModelResources } from './model-service.mjs'

let initialized = false, stopping = false
const requests = new Set()
async function stop() {
  if (stopping) return
  stopping = true
  const fallback = setTimeout(() => process.exit(1), 5_000)
  try { await Promise.allSettled(requests); await disposeModelResources() }
  finally { clearTimeout(fallback); process.exit(0) }
}
process.on('disconnect', () => { void stop() })
process.on('message', message => {
  if (message?.type === 'initialize' && !initialized && !stopping) {
    initializeModelResources(message.profileDirectory)
    initialized = true
  } else if (message?.type === 'stop') {
    void stop()
  } else if (message?.type === 'request' && initialized && !stopping) {
    const pending = (async () => {
      try {
        const response = await resource(new Request(message.url, { method: message.method }))
        const body = await response.text()
        if (process.connected && !stopping) process.send({ id: message.id, status: response.status, headers: Object.fromEntries(response.headers), body }, () => {})
      } catch (error) {
        if (process.connected && !stopping) process.send({ id: message.id, error: error.message }, () => {})
      }
    })()
    requests.add(pending)
    void pending.finally(() => requests.delete(pending))
  }
})
