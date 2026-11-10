/** Local research-package probe. Model instructions never become shell commands. */
import fs from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2), texts = []
let folder = existsSync(path.join(here, 'config.json'))
  ? here : path.resolve(here, '../.research/semantic-qwen35/package')
let backend
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--text') texts.push(args[++i])
  else if (args[i] === '--package') folder = path.resolve(args[++i])
  else if (args[i] === '--backend') backend = args[++i]
  else throw new Error(`Unknown argument: ${args[i]}`)
}
if (!texts.length || texts.some(t => typeof t !== 'string')) {
  throw new Error('Usage: node check.mjs [--package directory] [--backend cpu|vulkan] --text "text"')
}
const cfg = JSON.parse(await fs.readFile(path.join(folder, 'config.json'), 'utf8'))
backend ??= cfg.backend
if (!['cpu', 'vulkan'].includes(backend)) throw new Error('backend must be cpu or vulkan')
if (backend === 'vulkan' && !cfg.vulkan_included) throw new Error('Vulkan is not included in this package')
const model = path.resolve(folder, cfg.model), binary = path.resolve(folder, cfg.server)
const hash = createHash('sha256')
for await (const chunk of createReadStream(model)) hash.update(chunk)
if (hash.digest('hex') !== cfg.model_sha256) throw new Error('Model SHA256 mismatch')

const portSocket = net.createServer()
await new Promise((resolve, reject) => {
  portSocket.once('error', reject)
  portSocket.listen(0, '127.0.0.1', resolve)
})
const port = portSocket.address().port
await new Promise(resolve => portSocket.close(resolve))
const base = `http://127.0.0.1:${port}`
const command = ['-m', model, '--host', '127.0.0.1', '--port', String(port),
  '--ctx-size', '1024', '--parallel', '1', '--threads', '4', '--threads-batch', '4',
  '--batch-size', '512', '--ubatch-size', '128', '--cache-ram', '64', '--fit', 'off',
  '--reasoning', 'off', '--jinja', '--no-webui', '--no-context-shift']
command.push(...(backend === 'cpu'
  ? ['--device', 'none', '--n-gpu-layers', '0', '--no-op-offload', '--no-kv-offload']
  : ['--device', 'Vulkan0', '--n-gpu-layers', '99']))
let tail = '', spawnError
const started = performance.now()
const proc = spawn(binary, command, {
  cwd: path.dirname(binary), shell: false, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(cfg.env_override ?? {}) }
})
proc.on('error', error => { spawnError = error })
for (const stream of [proc.stdout, proc.stderr]) stream.on('data', chunk => { tail = (tail + chunk).slice(-16000) })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function request(route, payload) {
  const response = await fetch(base + route, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(60000)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return response.json()
}
try {
  const deadline = performance.now() + 120000
  let ready = false
  while (performance.now() < deadline) {
    if (spawnError) throw spawnError
    if (proc.exitCode !== null) throw new Error(`Server exited ${proc.exitCode}: ${tail}`)
    try { ready = (await request('/health')).status === 'ok' } catch {}
    if (ready) break
    await sleep(200)
  }
  if (!ready) throw new Error(`Server startup timed out: ${tail}`)
  const startupMs = performance.now() - started
  for (const text of texts) {
    const tick = performance.now()
    const messages = [{ role: 'system', content: cfg.prompt.system }]
    for (const example of cfg.prompt.examples ?? []) {
      messages.push({ role: 'user', content: example.text }, { role: 'assistant', content: example.answer })
    }
    messages.push({ role: 'user', content: cfg.prompt.json_user === false ? text : JSON.stringify(text) })
    const applied = await request('/apply-template', {
      messages, add_generation_prompt: true, chat_template_kwargs: { enable_thinking: false }
    })
    const output = await request('/completion', {
      prompt: applied.prompt, grammar: cfg.prompt.grammar, n_predict: 8,
      stop: Object.keys(cfg.prompt.label_map ?? { '0': 0, '1': 1, '2': 2 }),
      temperature: 0, seed: 0, n_probs: 5, post_sampling_probs: false, cache_prompt: true, stream: false
    })
    const mapping = cfg.prompt.label_map ?? { '0': 0, '1': 1, '2': 2 }
    const label = output.stopping_word in mapping ? output.stopping_word : output.content?.trim()
    if (!(label in mapping) || output.truncated) throw new Error(`Invalid model output: ${JSON.stringify(output)}`)
    const code = mapping[label]
    console.log(JSON.stringify({ text, model: cfg.variant, backend, code, label,
      decision: ['normal', 'anomaly', 'uncertain'][code], warning: code === 1,
      check_ms: performance.now() - tick, startup_ms: startupMs, status: cfg.status }))
  }
} finally {
  if (proc.exitCode === null) {
    proc.kill()
    await Promise.race([once(proc, 'exit').catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000).unref())])
  }
}
