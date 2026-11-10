/** Real pinned model + HTTP download/failure/cancel + production host route. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { createSemanticService } from '../src/semantic-service.mjs'
import { SEMANTIC_MODEL } from '../src/semantic.mjs'
import { semanticTestModel } from './semantic-test-model.mjs'

const root = path.resolve(import.meta.dirname, '..'), model = await semanticTestModel()
const temp = await fs.mkdtemp(path.join(root, '.tmp-r13-product-'))
const server = http.createServer((request, response) => {
  if (request.url === '/broken') { response.end('broken'); return }
  if (request.url === '/slow') {
    response.writeHead(200, { 'content-length': String(SEMANTIC_MODEL.bytes) })
    response.write(Buffer.alloc(1024))
    const timer = setInterval(() => response.write(Buffer.alloc(1024)), 20)
    response.on('close', () => clearInterval(timer)); return
  }
  response.writeHead(200, { 'content-length': String(SEMANTIC_MODEL.bytes) })
  createReadStream(model).pipe(response)
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
const services = [], disposers = []
async function waitFor(service, state) {
  for (let i = 0; i < 200; i++) {
    const current = await service.status()
    if (current.state === state) return current
    if (current.state === 'error' && state !== 'error') throw new Error(current.error)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${state}`)
}
function service(name, suffix) {
  const value = createSemanticService({ directory: path.join(temp, name), dataDirectory: path.join(root, 'data'), url: base + suffix })
  services.push(value); return value
}
try {
  const broken = service('broken', '/broken')
  await broken.beginDownload(); assert.match((await waitFor(broken, 'error')).error, /校验失败/)
  assert.equal((await broken.check('普通输入')).warning, null)
  console.log('PASS corrupt model is an error, not a normal prediction')

  const slow = service('cancelled', '/slow')
  await slow.beginDownload(); await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal((await slow.cancel()).state, 'absent')
  assert.equal((await fs.readdir(path.join(temp, 'cancelled'))).length, 0)
  console.log('PASS cancellation closes transfer and removes partial model')

  const good = service('good', '/model')
  assert.equal((await good.status()).state, 'absent'); await good.beginDownload(); await waitFor(good, 'ready')
  const original = '女哦就是的感受a到啊删掉asd苏打粉二十个s收到'
  assert.equal((await good.check(original)).warning, true)
  assert.equal((await good.check('请把 gRPC 的 keepalive 时间改为 30s。')).warning, false)
  assert.equal((await good.check('That is not what I was asking for.')).warning, false)
  assert.equal((await good.check('测试 '.repeat(200))).warning, null)
  await good.remove(); assert.equal((await good.check(original)).warning, null)
  console.log('PASS real bilingual model, long-input abstention, removal and release')

  process.env.DSH_PROFILE_DIR = path.join(temp, 'wrong-env-profile')
  const hostProfile = path.join(temp, 'host')
  process.env.ZH_TYPO_SEMANTIC_URL = base + '/model'
  const plugin = await import('../bundle/index.js')
  let route
  plugin.apply({ get(name) { return name === 'profileContext' ? { dir: hostProfile } : undefined },
    webServer: { register(value) { route = value; return () => { route = null } } },
    effect(run) { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose) } })
  const call = async part => {
    const response = await route.resource(new Request('http://127.0.0.1/zh-typo-model/' + part))
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await call('semantic/status')).body.state, 'absent')
  assert.equal((await call('semantic/download?source=unknown')).status, 400)
  assert.equal((await call('semantic/download?source=custom')).status, 400)
  assert.equal((await call('semantic/download?source=custom&base=file:///bad')).status, 400)
  assert.equal((await call('semantic/download')).status, 202)
  for (let i = 0; i < 200 && (await call('semantic/status')).body.state !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal((await call('semantic/status')).body.state, 'ready')
  assert.equal((await fs.stat(path.join(hostProfile, 'models/zh-typo-check/semantic-r13', SEMANTIC_MODEL.file))).size, SEMANTIC_MODEL.bytes)
  await assert.rejects(fs.stat(process.env.DSH_PROFILE_DIR), { code: 'ENOENT' })
  const checked = await call('check?typo=0&sentence=1&text=' + encodeURIComponent(original))
  assert.equal(checked.body.state, 'ready'); assert.equal(checked.body.fluency.low, true)
  assert.equal(checked.body.semantic.language, 'mixed'); assert.deepEqual(checked.body.issues, [])
  const clean = await call('check?typo=0&sentence=1&text=' + encodeURIComponent('Please update the README before release.'))
  assert.equal(clean.body.semantic.warning, false)
  await call('semantic/delete')
  const absent = await call('check?typo=0&sentence=1&text=' + encodeURIComponent(original))
  assert.equal(absent.body.fluency, null); assert.equal(absent.body.semantic.warning, null)
  console.log('PASS host profile isolation, R13-only original detection and unavailable missing model')
} finally {
  for (const dispose of disposers.reverse()) await dispose()
  for (const value of services) await value.dispose()
  server.closeAllConnections(); server.close()
  assert.ok(path.resolve(temp).startsWith(root + path.sep + '.tmp-r13-product-'))
  await fs.rm(temp, { recursive: true, force: true })
}
