/**
 * 用 profile 里从 npm 装好的那份跑自检，验证发布包在真实安装位置可用。
 * 运行：node tools/verify-installed.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const profileDir = process.env.DSH_PROFILE_DIR
if (!profileDir) {
  console.error('DSH_PROFILE_DIR 未设置')
  process.exit(1)
}

const entry = path.join(profileDir, 'node_modules', 'dsh-zh-typo-check', 'index.js')
const pkg = await import(pathToFileURL(entry).href)

let route = null
pkg.apply({
  webServer: { register: (next) => { route = next; return () => {} } },
  effect: (fn) => fn(),
})

if (route === null) {
  console.error('路由未注册')
  process.exit(1)
}
console.log(`路由前缀: ${route.path}`)

const response = await route.resource(new Request('http://127.0.0.1/zh-typo-model/selftest'))
const report = await response.json()
for (const step of report.steps) {
  const detail = step.ok ? JSON.stringify(step.value).slice(0, 90) : step.error
  console.log(`  ${step.name}: ${step.ok ? 'ok' : 'FAIL'}  ${detail}`)
}
console.log(`整体: ${report.ok}`)
process.exit(report.ok ? 0 : 1)
