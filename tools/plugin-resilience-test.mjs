/**
 * 韧性验证：推理链任意一环坏掉，插件仍要能加载、能下载、能删。
 *
 * 做法是真的把 bundle 复制一份，把 infer.mjs 换成一个一 import 就抛异常的模块，
 * 然后按宿主的方式 apply() 一次。
 *
 * 运行：node tools/plugin-resilience-test.mjs
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
// 临时副本放在仓库内（.tmp-* 已被 gitignore）：宿主入口现在静态依赖
// @deepseek-ai/schemastery，放在系统临时目录会解析不到仓库的 node_modules。
const tmp = path.join(root, `.tmp-resilience-${process.pid}`)
const bundle = path.join(tmp, 'bundle')

await fsp.rm(tmp, { recursive: true, force: true })
await fsp.cp(path.join(root, 'bundle'), bundle, { recursive: true })

// 把推理模块换成"一加载就炸"
fs.writeFileSync(path.join(bundle, 'infer.mjs'), 'throw new Error("模拟推理运行时损坏")\n', 'utf8')

process.env.DSH_PROFILE_DIR = path.join(tmp, 'profile')
delete process.env.ZH_TYPO_MODEL_URL

const failed = []
const check = (label, ok, detail = '') => {
  if (ok) console.log(`PASS  ${label}`)
  else { failed.push(label); console.log(`FAIL  ${label}  ${detail}`) }
}

let route = null
let applyError = null
try {
  const { apply } = await import(pathToFileURL(path.join(bundle, 'index.js')).href)
  apply({
    webServer: { register: (next) => { route = next; return () => { route = null } } },
    effect: (fn) => { fn() },
  })
} catch (error) {
  applyError = error
}

check('插件加载不因推理模块损坏而失败', applyError === null, applyError?.message)
check('路由仍然注册', route !== null)

async function call(sub) {
  const response = await route.resource(new Request(`http://127.0.0.1:64024/zh-typo-model/${sub}`))
  return { status: response.status, body: await response.json() }
}

const status = await call('status')
check('status 仍可用', status.status === 200, String(status.status))
check('status 如实报告 runtime=false', status.body.runtime === false, String(status.body.runtime))
check('status 报告模型缺失', status.body.state === 'absent', String(status.body.state))

const check1 = await call('check?text=' + encodeURIComponent('我到上海住的还'))
check('check 不抛 500', check1.status < 500, `${check1.status} ${JSON.stringify(check1.body)}`)
check('check 明确说没有模型', check1.body.issues.length === 0 && ['absent', 'no-runtime'].includes(check1.body.state), JSON.stringify(check1.body))

const self = await call('selftest')
check('selftest 仍可用', self.status === 200, String(self.status))
check('selftest 标记整体失败', self.body.ok === false)
const runtimeStep = self.body.steps.find((step) => step.name === 'runtime')
check('selftest 指出 runtime 这一层挂了', runtimeStep?.ok === false, JSON.stringify(runtimeStep))

const del = await call('delete')
check('delete 仍可用', del.status === 200 && del.body.state === 'absent', JSON.stringify(del.body))

await fsp.rm(tmp, { recursive: true, force: true })
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败：${failed.join('、')}`}`)
process.exit(failed.length === 0 ? 0 : 1)
