// Local-only lifecycle instrumentation for an account-free DSH profile.
import { appendFileSync, closeSync, openSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
export const inject = ['webServer', 'pluginManager']
export function apply(ctx) {
  const profile = ctx.get('profileContext')
  const trace = (phase, detail = {}) => appendFileSync(join(profile.dir, 'upgrade-trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), phase, ...detail }) + '\n')
  const manager = ctx.pluginManager
  const nativeLocks = () => readdirSync(join(profile.dir, 'node_modules/onnxruntime-node/bin'), { recursive: true })
    .filter(name => /win32[\\/]x64[\\/].*\.(?:dll|node)$/.test(name)).map(name => {
      try { closeSync(openSync(join(profile.dir, 'node_modules/onnxruntime-node/bin', name), 'r+')); return { name, writable: true } }
      catch (error) { return { name, writable: false, code: error.code } }
    })
  const releases = []
  for (const method of ['runPnpm', 'reload', 'publishAndReload', 'configure', 'removeBundle', 'setBundleEnabled', 'installBundle']) {
    const original = manager[method]
    if (typeof original !== 'function') continue
    manager[method] = async function (...args) {
      const start = performance.now()
      trace(method + ':begin', { args: args.map(arg => typeof arg === 'function' ? '<callback>' : arg) })
      if (method === 'runPnpm' && args[0][0] === 'remove') trace('locks-before-remove', { files: nativeLocks() })
      try {
        const result = await original.apply(this, args)
        trace(method + ':end', { ms: performance.now() - start, result })
        return result
      } catch (error) {
        trace(method + ':error', { ms: performance.now() - start, error: String(error), stack: error?.stack })
        throw error
      }
    }
    releases.push(() => { manager[method] = original })
  }
  ctx.on('plugin-manager/operation', operation => trace('operation', { operation }))
  ctx.on('plugin-manager/update-state', state => trace('update-state', { state }))
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/upgrade-diagnostic', resource: async request => {
    const url = new URL(request.url)
    const command = url.pathname.split('/').at(-1)
    const name = url.searchParams.get('name') || 'dsh-zh-typo-check'
    try {
      let result
      if (command === 'state') result = { hmr: ctx.get('hmr') !== undefined, bundles: await manager.listBundles() }
      else if (command === 'locks') {
        result = nativeLocks()
      }
      else if (command === 'remove') result = await manager.removeBundle(name)
      else if (command === 'update') result = await manager.updateBundle(name, url.searchParams.get('version') || '0.3.0', { registry: 'https://registry.npmjs.org', requestId: 'rootfix-local' })
      else if (command === 'disable') result = await manager.setBundleEnabled(name, false)
      else if (command === 'add') result = await manager.installBundle(name + '@' + (url.searchParams.get('version') || '0.3.0'), { registry: 'https://registry.npmjs.org', saveExact: true, enabled: true })
      else return new Response('unknown command', { status: 404 })
      return Response.json(result)
    } catch (error) {
      trace('request:error', { error: String(error) })
      return Response.json({ error: String(error), stack: error?.stack }, { status: 500 })
    }
  } }))
  ctx.effect(() => () => releases.reverse().forEach(release => release()))
  trace('ready', { pid: process.pid, hmr: ctx.get('hmr') !== undefined })
}
