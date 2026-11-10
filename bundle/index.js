/** DSH plugin configuration and routes; native inference runs in a disposable child. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import z from '@deepseek-ai/schemastery'
import { createModelProcess } from './model-process.mjs'
import { initializeModelResources, serveFile } from './model-service.mjs'

/**
 * 老版本 DSH 自带的 schemastery（3.18.x）没有 `.volatile()`。
 * 那种环境里降级成普通字段：插件照常加载、设置不持久化，而不是整个插件 import 失败。
 */
function live(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema
}

/**
 * 用户偏好（volatile 配置）。
 *
 * 为什么不放浏览器 localStorage：DSH Desktop 每次启动都用 `--port 0` 起本地服务，
 * 页面 origin 每次不同，localStorage 按 origin 隔离 —— 重启/升级后设置一定丢。
 * 声明成 Cordis Config 的 volatile 字段后，DSH 的 settings 服务会把改动写进
 * profile 的 `cordis.patch.yml`（与模型文件同属 profile，跨重启、跨插件升级保留）。
 *
 * 字段与 `src/config-store.mjs` 的 SETTINGS_FIELDS 一一对应；改这里必须同步那边。
 */
export const Config = z.object({
  enabled: live(z.boolean().default(true).description('Underline Chinese typos in the composer.')),
  punctuation: live(z.boolean().default(true).description('Also flag half-width ASCII punctuation.')),
  model: live(z.boolean().default(true).description('Use the local model for semantic checks when installed.')),
  fluency: live(z.boolean().default(true).description('Use the local whole-input Chinese, English and mixed-language semantic checker.')),
  sensitivity: live(z.union([z.const('low'), z.const('normal'), z.const('high')]).default('normal')
    .description('Model sensitivity: conservative, normal, or aggressive.')),
  source: live(z.union([z.const('auto'), z.const('mirror'), z.const('official'), z.const('custom')]).default('auto')
    .description('Preferred model download source.')),
  customBase: live(z.string().default('').description('Custom download base URL (http/https).')),
})

export const inject = ['webServer']

function bootLog(line) {
  // 同时写一份到固定位置，便于排查客户端加载问题
  try {
    const stamp = new Date().toISOString()
    fs.appendFileSync(path.join(os.tmpdir(), 'zh-typo-boot.log'), `${stamp}  ${line}\n`)
  } catch { /* 诊断日志本身不该影响加载 */ }
}

/** 插件在客户端的包名，用于查客户端模块表。 */
const PACKAGE_NAME = 'dsh-zh-typo-check'

/** volatile 配置以 Ref 形式传进 apply；这里只取一份可读快照写进启动痕迹。（导出供单测） */
export function configSummary(refs) {
  const fields = ['enabled', 'punctuation', 'model', 'fluency', 'sensitivity', 'source']
  const value = {}
  for (const field of fields) {
    const ref = refs?.[field]
    try {
      value[field] = ref !== null && typeof ref === 'object' && typeof ref.get === 'function' ? ref.get() : ref
    } catch {
      value[field] = '<unreadable>'
    }
  }
  try {
    return JSON.stringify(value)
  } catch {
    return '<unserializable>'
  }
}

/**
 * 查一遍客户端模块表：我们的条目在不在、路径是什么、文件在不在。
 *
 * 页面上的下划线全部由客户端半边绘制，如果它没被装配进 boot graph，
 * 界面就是"插件装着、但在跑"却什么都没发生。这段诊断就是回答那个问题的。
 */
function inspectClientEntry(ctx) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('clientModules') : ctx.clientModules
    if (service === undefined || service === null) {
      bootLog('clientModules service unavailable')
      return
    }
    const graph = typeof service.graph === 'function' ? service.graph() : null
    const entry = graph?.entries?.find((item) => item.id === PACKAGE_NAME)
    const clientPath = typeof service.clientPath === 'function' ? service.clientPath(PACKAGE_NAME) : undefined
    let exists = false
    try { exists = clientPath !== undefined && fs.existsSync(clientPath) } catch { /* ignore */ }
    bootLog(`client graph: entries=${graph?.entries?.length ?? '?'} `
      + `ours=${entry === undefined ? 'MISSING' : JSON.stringify(entry)} `
      + `clientPath=${clientPath ?? 'undefined'} exists=${String(exists)}`)

    // 取两条别人的 url 做对照，看我们的 `??` 是不是异常
    const others = (graph?.entries ?? []).filter((item) => item.id !== PACKAGE_NAME).slice(0, 2)
    bootLog(`client graph peers: ${JSON.stringify(others.map((item) => item.url))}`)

    // 用宿主自己的 fetchBundle 真取一次：能取到就说明壳侧没问题，
    // 取不到就说明是这条 bundle URL 的问题，而不是客户端代码的问题。
    if (entry !== undefined && typeof service.fetchBundle === 'function') {
      void service.fetchBundle(new Request('http://127.0.0.1/' + String(entry.url).replace(/^\/+/, '')))
        .then(async (response) => {
          let head = ''
          try { head = (await response.text()).slice(0, 120).replace(/\s+/g, ' ') } catch { /* ignore */ }
          bootLog(`fetchBundle status=${response.status} length=${response.headers.get('content-length') ?? '?'} head=${head}`)
        })
        .catch((error) => bootLog(`fetchBundle failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  } catch (error) {
    bootLog(`client graph inspect failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function apply(ctx, refs) {
  const profile = typeof ctx.get === 'function' ? ctx.get('profileContext') : ctx.profileContext
  const profileDirectory = typeof profile?.dir === 'string' ? profile.dir : null
  initializeModelResources(profileDirectory)
  const worker = createModelProcess({ profileDirectory })
  ctx.effect(() => () => worker.dispose(), 'zh-typo-check: stop native worker')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/zh-typo-model',
    async resource(request) {
      const sub = new URL(request.url).pathname.slice('/zh-typo-model'.length).replace(/^\/+/, '')
      // Preserve Range streaming without copying model weights over IPC.
      if (sub.startsWith('file')) return serveFile(request)
      try { return await worker.request(request) }
      catch (error) {
        return Response.json({ state: 'error', runtime: false, error: error.message,
          issues: [], fluency: null, semantic: { state: 'unavailable', warning: null, low: null, reason: 'worker-error' } }, { status: 503 })
      }
    },
  }), 'zh-typo-check: model routes')
  bootLog('apply done, settings=' + configSummary(refs))
  inspectClientEntry(ctx)
}
