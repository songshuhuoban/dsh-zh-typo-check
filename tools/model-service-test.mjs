/**
 * 宿主侧模型服务的离线验证。
 *
 * 用一个假的 Cordis 上下文接管 `webServer.register`，拿到路由的 resource，
 * 然后用真实 HTTP 请求（Request 对象）跑一遍完整状态机：
 *   absent → download → ready → 读文件（含 Range）→ delete → absent
 *
 * 运行：node tools/model-service-test.mjs
 * 用 ZH_TYPO_MODEL_URL 指向一个小文件，避免每次都拉 99 MB。
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

const tmpRoot = path.join(os.tmpdir(), `zh-typo-model-test-${process.pid}`)
await fsp.mkdir(tmpRoot, { recursive: true })
process.env.DSH_PROFILE_DIR = tmpRoot
process.env.ZH_TYPO_MODEL_URL = process.env.ZH_TYPO_MODEL_URL
  ?? 'https://huggingface.co/Xenova/bert-base-chinese/resolve/main/tokenizer.json'

const { apply } = await import('../bundle/index.js')

let route = null
const ctx = {
  webServer: { register: (next) => { route = next; return () => { route = null } } },
  effect: (fn) => { fn() },
}
apply(ctx)

const failed = []
function check(label, condition, detail = '') {
  if (condition) console.log(`PASS  ${label}`)
  else { failed.push(label); console.log(`FAIL  ${label}  ${detail}`) }
}

/** 按 webServer 真实规则匹配：等值或以 prefix + '/' 开头。 */
function resolve(pathname) {
  if (route === null) return null
  if (pathname === route.path) return route
  return pathname.startsWith(String(route.path) + '/') ? route : null
}

async function call(sub, init = {}) {
  const request = new Request(`http://127.0.0.1:64024/zh-typo-model/${sub}`, init)
  const matched = resolve(new URL(request.url).pathname)
  if (matched === null) return { status: 404, json: async () => ({ state: 'unmatched' }) }
  const response = await matched.resource(request)
  return response
}

// 前缀不能带尾斜杠：/zh-typo-model/status 只匹配 /zh-typo-model 这个前缀
check('路由已注册且前缀无尾斜杠', route !== null && route.path === '/zh-typo-model', String(route?.path))
check('前缀能匹配到子路径', resolve('/zh-typo-model/status') !== null)
check('带尾斜杠的旧写法会失配', (() => {
  const bad = '/zh-typo-model/'
  return !( '/zh-typo-model/status' === bad || '/zh-typo-model/status'.startsWith(bad + '/') )
})() === true)

let status = await (await call('status')).json()
check('初始为 absent', status.state === 'absent', JSON.stringify(status))
check('目录落在 profile 下', status.directory.startsWith(tmpRoot), status.directory)


// 下载来源：自定义地址的校验
const bad = await call('download?source=custom&base=ftp%3A%2F%2Fx')
check('自定义地址协议不合法时返回 400', bad.status === 400, String(bad.status))
const empty = await call('download?source=custom&base=')
check('自定义地址为空时返回 400', empty.status === 400, String(empty.status))
const unknown = await call('download?source=bogus')
check('未知来源返回 400', unknown.status === 400, String(unknown.status))
const sources = await (await call('sources')).json()
check('sources 给出候选线路', typeof sources.mirror === 'string' && typeof sources.official === 'string', JSON.stringify(sources))
check('sources 的镜像地址含仓库路径', String(sources.mirror).includes('macbert4csc-base-chinese'), String(sources.mirror))

const started = await call('download')
check('下载请求被接受', started.status === 202, String(started.status))

let ready = null
for (let i = 0; i < 240; i += 1) {
  await new Promise((r) => setTimeout(r, 250))
  status = await (await call('status')).json()
  if (status.state === 'ready' || status.state === 'error') { ready = status; break }
}
check('下载完成', ready?.state === 'ready', JSON.stringify(ready))

const installedPath = path.join(tmpRoot, 'models', 'zh-typo-check', 'model_quantized.onnx')
check('文件落盘', fs.existsSync(installedPath), installedPath)
const size = fs.existsSync(installedPath) ? fs.statSync(installedPath).size : 0
check('文件非空', size > 1000, String(size))

const whole = await call('file?v=model_quantized.onnx')
check('整文件 GET 200', whole.status === 200, String(whole.status))
check('content-length 正确', whole.headers.get('content-length') === String(size), whole.headers.get('content-length'))
const bodyBytes = (await whole.arrayBuffer()).byteLength
check('响应体长度一致', bodyBytes === size, `${bodyBytes} vs ${size}`)

const ranged = await call('file?v=model_quantized.onnx', { headers: { range: 'bytes=0-99' } })
check('Range 返回 206', ranged.status === 206, String(ranged.status))
check('Range 长度 100', (await ranged.text()).length === 100)

const missing = await call('file?v=nope.onnx')
check('未知文件 404', missing.status === 404, String(missing.status))

const removed = await (await call('delete')).json()
check('删除后回到 absent', removed.state === 'absent', JSON.stringify(removed))
check('文件已删除', !fs.existsSync(installedPath))

await fsp.rm(tmpRoot, { recursive: true, force: true })
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败：${failed.join('、')}`}`)
process.exit(failed.length === 0 ? 0 : 1)
