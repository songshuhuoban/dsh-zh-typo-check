/**
 * 卸载 / 升级生命周期验证（宿主半边）。
 *
 * DSH 原地更新插件时会先停掉旧版本（dispose 所有 effect），再装载新版本。
 * 如果旧版本占着路由、native 模型会话或在途下载不放，升级就会「卡在停止并移除」。
 * 这个测试按 DSH 的方式跑一遍：apply → 用返回的 disposer 卸载 → 再 apply（模拟换版本），
 * 并真的起一个不响应的本地 HTTP 服务验证卸载会中断正在进行的下载。
 *
 * Run: node tools/uninstall-test.mjs
 */
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = path.join(os.tmpdir(), `zh-typo-uninstall-test-${process.pid}`)
await fsp.rm(tmpRoot, { recursive: true, force: true })
await fsp.mkdir(tmpRoot, { recursive: true })
process.env.DSH_PROFILE_DIR = tmpRoot

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}  ${detail}`) }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 假 Cordis 上下文：effect 返回的 disposer 会被卸载时按逆序调用。 */
function makeCtx() {
  const routes = new Map()
  const disposers = []
  const ctx = {
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    // 宿主 apply 里的可选诊断会读 clientModules；没有就跳过
    get() { return undefined },
  }
  return {
    ctx,
    routes,
    /** DSH 停插件的等价动作：逆序释放所有 effect。 */
    dispose() {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        dispose()
      }
    },
  }
}

async function statusOf(host) {
  const route = host.routes.get('/zh-typo-model')
  if (route === undefined) return { status: 404, body: null }
  const response = await route.resource(new Request('http://127.0.0.1:64024/zh-typo-model/status'))
  return { status: response.status, body: await response.json() }
}

// 不响应的下载源：连接挂着，靠卸载时的 AbortController 中断
let downloadRequested = false
let downloadClosed = false
const server = http.createServer((req) => {
  downloadRequested = true
  req.on('close', () => { downloadClosed = true })
  // 故意不写响应：模拟正在下载 100 MB 模型的中途
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
process.env.ZH_TYPO_MODEL_URL = `http://127.0.0.1:${port}/model_quantized.onnx`

const { apply } = await import('../bundle/index.js')

// ---- 1. 首次加载 ----
const first = makeCtx()
let firstError = null
try { apply(first.ctx) } catch (error) { firstError = error }
check('加载插件不抛错', firstError === null, firstError?.message)
check('注册了模型路由', first.routes.has('/zh-typo-model'))
const initial = await statusOf(first)
check('路由可用（status 200）', initial.status === 200, String(initial.status))
check('初始状态 absent', initial.body?.state === 'absent', JSON.stringify(initial.body))

// ---- 2. 下载进行中直接卸载 ----
const started = await first.routes.get('/zh-typo-model').resource(
  new Request('http://127.0.0.1:64024/zh-typo-model/download?source=custom&base=http%3A%2F%2F127.0.0.1%3A1'),
)
check('下载请求被接受', started.status === 202, String(started.status))
await delay(200)
check('下载连接已建立', downloadRequested)

first.dispose()
check('卸载后路由被注销', !first.routes.has('/zh-typo-model'))
await delay(300)
check('卸载会中断在途下载', downloadClosed)
const leftovers = await fsp.readdir(tmpRoot, { recursive: true }).catch(() => [])
check('卸载后没有残留 .part 文件', leftovers.every((name) => !String(name).endsWith('.part')), JSON.stringify(leftovers))

// ---- 3. 卸载可重复调用（DSH 可能重复 dispose） ----
let repeatError = null
try { first.dispose() } catch (error) { repeatError = error }
check('重复卸载不抛错', repeatError === null, repeatError?.message)

// ---- 4. 再加载（等价于升级后新代码启动 / 重新启用）----
const second = makeCtx()
let secondError = null
try { apply(second.ctx) } catch (error) { secondError = error }
check('升级后重新加载不抛错', secondError === null, secondError?.message)
check('重新注册路由成功（不因旧路由残留而重复注册）', second.routes.has('/zh-typo-model'))
const again = await statusOf(second)
check('新实例路由可用', again.status === 200, String(again.status))
second.dispose()

server.close()
await fsp.rm(tmpRoot, { recursive: true, force: true })

console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
