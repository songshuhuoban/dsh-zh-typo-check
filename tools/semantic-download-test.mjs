/** Real pinned bytes over HTTP: domestic-first failover, bounded stalls, overrides and cancellation. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { Transform } from 'node:stream'
import { createSemanticService, SEMANTIC_SOURCES, SEMANTIC_URL } from '../src/semantic-service.mjs'
import { SEMANTIC_MODEL } from '../src/semantic.mjs'
import { semanticTestModel } from './semantic-test-model.mjs'

const root = path.resolve(import.meta.dirname, '..'), model = await semanticTestModel()
const temp = await fs.mkdtemp(path.join(root, '.tmp-r13-download-'))
const requests = [], services = []
const server = http.createServer((request, response) => {
  requests.push(request.url)
  if (request.url.startsWith('/fail')) { response.writeHead(503); response.end(); return }
  if (request.url === '/headers') return
  response.writeHead(200, { 'content-length': String(SEMANTIC_MODEL.bytes) })
  if (request.url === '/stall') { response.write(Buffer.alloc(1024)); return }
  const stream = createReadStream(model)
  response.on('close', () => stream.destroy())
  if (request.url === '/corrupt') {
    let first = true
    stream.pipe(new Transform({ transform(chunk, _encoding, callback) {
      if (first) { chunk = Buffer.from(chunk); chunk[0] ^= 1; first = false }
      callback(null, chunk)
    } })).pipe(response)
  } else if (request.url === '/progress') {
    stream.pipe(new Transform({ transform(chunk, _encoding, callback) {
      setTimeout(() => callback(null, chunk), 3)
    } })).pipe(response)
  } else stream.pipe(response)
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
function service(name, mirror, official = '/good') {
  const value = createSemanticService({ directory: path.join(temp, name), dataDirectory: path.join(root, 'data'),
    sources: { mirror: base + mirror, official: base + official }, connectTimeoutMs: 250, idleTimeoutMs: 150 })
  services.push(value); return value
}
async function settled(value) {
  for (let i = 0; i < 800; i++) {
    const status = await value.status()
    if (!['downloading', 'verifying'].includes(status.state)) return status
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Download did not settle')
}
async function requested(url) {
  for (let i = 0; i < 200 && !requests.includes(url); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(requests.includes(url), 'transfer must start before cancellation')
}
async function noPartial(name) {
  assert.equal((await fs.readdir(path.join(temp, name))).some(file => file.endsWith('.part')), false)
}
try {
  assert.equal(SEMANTIC_SOURCES.official, SEMANTIC_URL)
  assert.ok(SEMANTIC_SOURCES.mirror.includes('/resolve/r13-261110/'))
  {
    requests.length = 0
    const value = service('mirror-first', '/good')
    await value.beginDownload(); await value.beginDownload()
    const status = await settled(value)
    assert.equal(status.state, 'ready'); assert.equal(status.source, 'mirror'); assert.equal(status.attempt, 1)
    assert.deepEqual(requests, ['/good'], 'reachable mirror wins, no official probe or duplicate transfer')
  }
  for (const mirror of ['/fail', '/headers', '/stall', '/corrupt']) {
    requests.length = 0
    const name = mirror.slice(1), value = service(name, mirror)
    await value.beginDownload({ source: 'auto' })
    const status = await settled(value)
    assert.equal(status.state, 'ready', status.error); assert.equal(status.source, 'official'); assert.equal(status.attempt, 2)
    assert.deepEqual(requests, [mirror, '/good'])
    await noPartial(name)
  }
  console.log('PASS domestic-first order and HTTP/header-idle/body-idle/SHA failure fallback')
  {
    requests.length = 0
    const value = service('manual-mirror', '/fail')
    await value.beginDownload({ source: 'mirror' })
    const status = await settled(value)
    assert.equal(status.state, 'error'); assert.match(status.error, /魔搭.*503/)
    assert.deepEqual(requests, ['/fail'], 'forced mirror never switches')
    assert.equal((await value.status()).error, status.error, 'failure stays visible on polling')
    assert.equal((await value.check('正常输入')).warning, null)
    await noPartial('manual-mirror')
    requests.length = 0
    const official = service('manual-official', '/fail')
    await official.beginDownload({ source: 'official' }); assert.equal((await settled(official)).state, 'ready')
    assert.deepEqual(requests, ['/good'], 'forced official never probes mirror')
  }
  {
    requests.length = 0
    const value = service('both-fail', '/fail-mirror', '/fail-official')
    await value.beginDownload(); const status = await settled(value)
    assert.equal(status.state, 'error'); assert.match(status.error, /魔搭.*GitHub/)
    assert.deepEqual(requests, ['/fail-mirror', '/fail-official'])
    await noPartial('both-fail')
    await value.beginDownload({ source: 'custom', customBase: base + '/custom/' })
    assert.equal((await settled(value)).state, 'ready')
    assert.equal(requests.at(-1), '/custom/' + SEMANTIC_MODEL.file)
    assert.equal(requests.length, 3, 'custom retry uses only its own source')
    await value.remove()
    await value.beginDownload(base + '/legacy')
    assert.equal((await settled(value)).state, 'ready')
    assert.equal(requests.at(-1), '/legacy/' + SEMANTIC_MODEL.file)
    await assert.rejects(value.beginDownload({ source: 'ftp' }), /未知/)
    await assert.rejects(value.beginDownload({ source: 'custom', customBase: 'file:///bad' }), /http/)
  }
  console.log('PASS manual choices, persistent errors, custom/legacy addresses and explicit retry')
  for (const mirror of ['/headers', '/stall']) {
    requests.length = 0
    const name = 'cancel-' + mirror.slice(1), value = service(name, mirror)
    await value.beginDownload(); await requested(mirror)
    assert.equal((await value.cancel()).state, 'absent')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.deepEqual(requests, [mirror], 'user cancellation must not trigger failover')
    await noPartial(name)
  }
  {
    requests.length = 0
    const value = service('dispose', '/stall')
    await value.beginDownload(); await requested('/stall'); await value.dispose()
    assert.deepEqual(requests, ['/stall'])
    await noPartial('dispose')
    await assert.rejects(value.beginDownload(), /停止/)
  }
  {
    requests.length = 0
    const value = service('progress', '/progress'), started = Date.now()
    await value.beginDownload(); assert.equal((await settled(value)).state, 'ready')
    assert.ok(Date.now() - started > 250, 'progressing transfer outlives connection/idle budgets')
    assert.deepEqual(requests, ['/progress'])
  }
  console.log('PASS cancellation/disposal without fallback, partial cleanup and slow progressing transfers')
} finally {
  for (const value of services) await value.dispose()
  server.closeAllConnections(); server.close()
  assert.ok(path.resolve(temp).startsWith(root + path.sep + '.tmp-r13-download-'))
  await fs.rm(temp, { recursive: true, force: true })
}
