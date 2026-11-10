/**
 * Host half: download, verify, serve, delete — and run — the optional Chinese model.
 *
 * 模型存在 profile 目录里（不是浏览器缓存），页面通过这里注册的 HTTP 路由访问它。
 * 推理跑在宿主进程：同一个模型，native 后端 21 ms/次，WASM 要 135 ms/次，
 * 差 6 倍——放到页面里既不划算，也要多下载 13.6 MB 运行时。
 *
 * Routes (all under /zh-typo-model/):
 *   GET    status           当前状态、体积、解析到的目录
 *   GET    download         开始（或继续）下载
 *   GET    cancel           停止下载
 *   GET    delete           删除已安装文件
 *   GET    file?v=name      分发单个文件，支持 Range
 *   GET    check?text=...   用模型检查一句话，返回可疑位置
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

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

/**
 * 推理相关的模块**全部惰性加载**。
 *
 * 宿主插件的 apply() 一旦抛异常，整个插件（连同输入框里的规则检查）都会被拖下水。
 * 而这条链要跨 6 个文件、一个原生模块和两个数据文件，任何一个缺失都不该让
 * 下划线整体消失——模型只是增强，不是前提。
 */
let inferCache = null
async function inferModule() {
  if (inferCache === null) inferCache = await import('./infer.mjs')
  return inferCache
}

// 注意：前缀**不能**带尾斜杠。webServer 的匹配规则是 pathname === prefix || pathname.startsWith(prefix + '/')，/zh-typo-model/ 会要求 /zh-typo-model//status 才命中。
const ROUTE = '/zh-typo-model'

/**
 * 模型：`macbert4csc-base-chinese` 的 int8 ONNX（MacBERT 在 SIGHAN 错字语料上微调过）。
 * 选它是因为掩码预测本来就偏向"这里被写错的字该是什么"，实测比通用 BERT 精确率高 5 个点。
 *
 * 下载来源由用户决定：`auto` 会先探一下哪条线路通、再决定先后；也可以强制镜像、
 * 强制官方，或者填自己的地址（企业内网镜像、本地文件服务器都行）。
 * 每个文件都带 sha256，所以自定义源拿到的东西和官方不一致时会直接失败而不是悄悄装错。
 */
const REPO = 'Xenova/macbert4csc-base-chinese/resolve/main'

const SOURCES = {
  mirror: `https://hf-mirror.com/${REPO}`,
  official: `https://huggingface.co/${REPO}`,
}

const FILES = [
  {
    name: 'model_quantized.onnx',
    path: 'onnx/model_quantized.onnx',
    bytes: 103_596_411,
    sha256: '0c40a55ed4cae6df2fb32c666fb21c75bcea3543cd2dac653e0b4aff22e1e8c7',
  },
  {
    name: 'tokenizer.json',
    path: 'tokenizer.json',
    bytes: 439_124,
    sha256: '7dfbf1966ebf99d471c3796e9b457329d2b2182b817e144f1e904b957745c839',
  },
]

/** 用户给的地址只接受 http(s)，并去掉尾斜杠，方便直接拼文件名。 */
function normalizeBase(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return value.replace(/\/+$/, '')
}

/** 探一条线路通不通：拿最小的那个文件做 HEAD，比拉主模型便宜得多。 */
async function reachable(base) {
  try {
    const response = await fetch(`${base}/tokenizer.json`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(4000),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * 决定这次下载的线路顺序。
 *   auto     先并发探两条，通的排前面（都不通就按镜像、官方的顺序硬试）
 *   mirror   只走国内镜像
 *   official 只走官方
 *   custom   只用用户给的地址
 */
async function basesFor(source, customBase) {
  if (source === 'custom') {
    const base = normalizeBase(customBase)
    return base === null ? null : [base]
  }
  if (source === 'mirror') return [SOURCES.mirror]
  if (source === 'official') return [SOURCES.official]
  const order = [SOURCES.mirror, SOURCES.official]
  const probe = await Promise.all(order.map((base) => reachable(base)))
  const up = order.filter((_, index) => probe[index])
  if (up.length === 0) return order
  return [...up, ...order.filter((base) => !up.includes(base))]
}

/** Test hook: point the plugin at a smaller stand-in while exercising the flow. */
function fileSpecs() {
  const override = process.env.ZH_TYPO_MODEL_URL
  if (override === undefined || override === '') return FILES
  return [{ name: 'model_quantized.onnx', path: '', urls: [override], bytes: 0, sha256: null }]
}

/** 一个文件的全部候选 URL：整条线路列表，前一条失败就换下一条。 */
function urlsOf(spec, bases) {
  if (Array.isArray(spec.urls)) return spec.urls
  return bases.map((base) => `${base}/${spec.path}`)
}

let current = null
let hostProfileDir = null

function modelDir() {
  const profileDir = hostProfileDir ?? process.env.DSH_PROFILE_DIR
  const base = profileDir !== undefined && profileDir !== ''
    ? profileDir
    : path.join(os.homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'desktop')
  return path.join(base, 'models', 'zh-typo-check')
}

function freshState() {
  return {
    state: 'absent', // absent | downloading | verifying | ready | error
    bytes: 0,
    total: 0,
    error: null,
    installed: {},
    directory: modelDir(),
    updatedAt: Date.now(),
  }
}

function touch(patch) {
  current = { ...(current ?? freshState()), ...patch, updatedAt: Date.now() }
  return current
}

async function installedFiles() {
  const dir = modelDir()
  const installed = {}
  for (const spec of fileSpecs()) {
    try {
      const stat = await fsp.stat(path.join(dir, spec.name))
      installed[spec.name] = stat.size
    } catch (_error) { /* not installed */ }
  }
  return installed
}

/** Recompute the idle state from disk; used on boot, after delete, and after cancel. */
async function refreshFromDisk() {
  if (current?.state === 'downloading' || current?.state === 'verifying') return current
  const installed = await installedFiles()
  const specs = fileSpecs()
  const present = specs.filter((spec) => (installed[spec.name] ?? 0) > 0).length
  const bytes = Object.values(installed).reduce((sum, n) => sum + n, 0)
  const total = specs.reduce((sum, spec) => sum + (spec.bytes || 0), 0)
  if (present === specs.length && specs.length > 0) {
    return touch({ state: 'ready', bytes, total: bytes, installed, error: null })
  }
  // 只下了一半：明确报 partial，别让用户以为一点都没下
  if (present > 0) {
    return touch({ state: 'partial', bytes, total, installed, error: null, file: '' })
  }
  return touch({ state: 'absent', bytes, total: 0, installed, error: null, file: '' })
}

/**
 * 下载一个文件。
 *
 * @param spec        文件描述
 * @param bases       线路顺序
 * @param signal      取消信号（取消时这里抛 AbortError，由 runDownload 识别）
 * @param onProgress  (written, expected) => void，用于整体进度累加
 * @param onVerify    () => void，落盘完成、开始校验时调用
 */
async function downloadOne(spec, bases, signal, onProgress, onVerify) {
  const dir = modelDir()
  await fsp.mkdir(dir, { recursive: true })
  const target = path.join(dir, spec.name)
  const part = `${target}.part`

  // 线路依次尝试：前面的挂了就换下一条，全挂了才报错。
  let lastError = null
  for (const url of urlsOf(spec, bases)) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (response.body === null) throw new Error('empty body')

      const expected = Number(response.headers.get('content-length') ?? 0) || spec.bytes || 0
      const handle = await fsp.open(part, 'w')
      let written = 0
      try {
        for await (const chunk of response.body) {
          await handle.write(chunk)
          written += chunk.length
          onProgress(written, Math.max(expected, written))
        }
      } finally {
        await handle.close()
      }

      if (spec.sha256 !== null && spec.sha256 !== undefined) {
        // 校验 103 MB 要几百毫秒，值得单独给一个状态
        onVerify()
        const hash = crypto.createHash('sha256')
        hash.update(await fsp.readFile(part))
        const actual = hash.digest('hex')
        if (actual !== spec.sha256) {
          await fsp.rm(part, { force: true })
          throw new Error(`校验失败（应为 ${spec.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
        }
      }
      await fsp.rename(part, target)
      return written
    } catch (error) {
      // 取消不是失败：不换线路、不报错，直接把半成品删掉
      if (error?.name === 'AbortError' || signal?.aborted === true) {
        await fsp.rm(part, { force: true })
        throw error
      }
      lastError = error
      await fsp.rm(part, { force: true })
    }
  }
  throw new Error(`${spec.name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/** 正在跑的下载任务；取消要真的能中断网络请求，而不只是改状态。 */
let downloadJob = null

/**
 * @param {{source?: string, customBase?: string}} choice 用户选的下载来源
 */
async function runDownload(choice = {}) {
  const specs = fileSpecs()
  const totalBytes = specs.reduce((sum, spec) => sum + (spec.bytes || 0), 0)
  const controller = new AbortController()
  downloadJob = { controller }

  // 先把状态切成 downloading 再去做线路探测。
  // 探测要发两次 HEAD（各自最多 4 秒），如果等探测完才改状态，
  // 这期间界面看到的还是 absent——用户会觉得"点了没反应"。
  touch({
    state: 'downloading',
    phase: 'probing',
    bytes: 0,
    total: totalBytes,
    file: specs[0]?.name ?? '',
    fileIndex: 0,
    fileCount: specs.length,
    source: choice.source ?? 'auto',
    bases: [],
    error: null,
  })

  const bases = await basesFor(choice.source ?? 'auto', choice.customBase)
  if (bases === null) {
    touch({ state: 'error', error: '自定义地址无效：需要以 http:// 或 https:// 开头', phase: '' })
    return
  }
  if (controller.signal.aborted) return

  let doneBytes = 0
  touch({ phase: 'downloading', bases })

  try {
    for (const [index, spec] of specs.entries()) {
      touch({ file: spec.name, fileIndex: index, fileCount: specs.length })
      const written = await downloadOne(
        spec,
        bases,
        controller.signal,
        (current) => touch({ bytes: doneBytes + current, total: Math.max(totalBytes, doneBytes + current) }),
        () => touch({ state: 'verifying' }),
      )
      doneBytes += written
      touch({ state: 'downloading', bytes: doneBytes })
    }
    const installed = await installedFiles()
    const size = Object.values(installed).reduce((sum, n) => sum + n, 0)
    touch({ state: 'ready', bytes: size, total: size, installed, file: '', error: null })
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      // 用户取消：回到磁盘上真实的状态（可能是 partial）
      current = freshState()
      await refreshFromDisk()
      return
    }
    touch({ state: 'error', error: error instanceof Error ? error.message : String(error), file: '' })
  } finally {
    if (downloadJob !== null && downloadJob.controller === controller) downloadJob = null
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** 一次检查最多看这么多字：输入框里再长也该靠规则兜底，不该让模型拖着。 */
const MAX_CHECK_CHARS = 500

/** 在途的相同检查请求：同一句话被连发多次时共用一次推理。 */
const inflightChecks = new Map()

/** 最近一次 check 请求，用于判断客户端到底有没有在提问。 */
let lastCheck = null

let cachedModel = null
let cachedLexicon
let semanticService = null
async function semanticHandle() {
  if (semanticService === null) {
    const { createSemanticService } = await import('./semantic-service.mjs')
    semanticService = createSemanticService({
      directory: path.join(modelDir(), 'semantic-r13'),
      dataDirectory: path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'),
    })
  }
  return semanticService
}

/** 词表与同音索引只读一次；读不到就退回"不设约束"，而不是让检查整体失败。 */
async function lexiconHandle() {
  if (cachedLexicon !== undefined) return cachedLexicon
  try {
    const { loadLexicon } = await import('./lexicon.mjs')
    const { loadL1 } = await import('./l1.mjs')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const dataDir = path.join(here, 'data')
    await loadL1(dataDir)
    cachedLexicon = await loadLexicon(dataDir)
  } catch {
    cachedLexicon = null
  }
  return cachedLexicon
}

/** 惰性打开模型；文件被删掉后下次调用会重新打开。 */
async function modelHandle() {
  const dir = modelDir()
  if (cachedModel !== null && cachedModel.dir === dir) return cachedModel.model
  const { openModel } = await inferModule()
  const model = await openModel(dir)
  cachedModel = { dir, model }
  return model
}

async function serveFile(request) {
  const url = new URL(request.url)
  const name = url.searchParams.get('v') ?? ''
  if (!fileSpecs().some((spec) => spec.name === name)) return json({ error: 'unknown file' }, 404)
  const target = path.join(modelDir(), name)

  let stat
  try {
    stat = await fsp.stat(target)
  } catch (_error) {
    return json({ error: 'not installed' }, 404)
  }

  const range = request.headers.get('range')
  if (range !== null) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match !== null) {
      const start = match[1] === '' ? 0 : Number(match[1])
      const end = match[2] === '' ? stat.size - 1 : Math.min(Number(match[2]), stat.size - 1)
      if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${stat.size}` } })
      const stream = fs.createReadStream(target, { start, end })
      return new Response(Readable.toWeb(stream), {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${stat.size}`,
          'accept-ranges': 'bytes',
        },
      })
    }
  }

  const stream = fs.createReadStream(target)
  return new Response(Readable.toWeb(stream), {
    status: 200,
    headers: {
      'content-type': name.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream',
      'content-length': String(stat.size),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    },
  })
}

/** The single resource answering every /zh-typo-model/ request. */
async function resource(request) {
  const url = new URL(request.url)
  const sub = url.pathname.slice(ROUTE.length).replace(/^\//, '')

  if (sub.startsWith('semantic/')) {
    const service = await semanticHandle(), action = sub.slice('semantic/'.length)
    try {
      if (action === 'status') return json(await service.status())
      if (action === 'download') {
        const base = url.searchParams.get('base') ?? ''
        if (base && normalizeBase(base) === null) return json({ error: '下载地址需要 http:// 或 https://' }, 400)
        await service.beginDownload(base)
        return json(await service.status(), 202)
      }
      if (action === 'cancel') return json(await service.cancel())
      if (action === 'delete') return json(await service.remove())
    } catch (error) { return json({ state: 'error', error: error.message }, 500) }
    return json({ error: 'not found' }, 404)
  }

  // 这个路由只接受 GET/HEAD：Web 资源路由对其它方法直接 405，
  // 所以下载与删除也走 GET，靠语义化路径区分。
  if (sub === 'status') {
    const { probeRuntime } = await inferModule().catch(() => ({ probeRuntime: async () => false }))
    return json({ ...(await refreshFromDisk()), runtime: await probeRuntime().catch(() => false), lastCheck })
  }
  if (sub === 'download') {
    if (current?.state === 'downloading') return json(current, 202)
    const source = url.searchParams.get('source') ?? 'auto'
    if (!['auto', 'mirror', 'official', 'custom'].includes(source)) {
      return json({ state: current?.state ?? 'absent', error: '未知的下载来源' }, 400)
    }
    const customBase = url.searchParams.get('base') ?? ''
    if (source === 'custom' && normalizeBase(customBase) === null) {
      return json({ state: current?.state ?? 'absent', error: '自定义地址无效：需要以 http:// 或 https:// 开头' }, 400)
    }
    void runDownload({ source, customBase })
    return json(current ?? freshState(), 202)
  }
  if (sub === 'log') {
    // 客户端模块加载时往这里打点：模块没加载就没有这条，
    // 加载了但 apply 抛异常会带 error。两种失败因此可以区分。
    const msg = url.searchParams.get('msg') ?? ''
    bootLog(`[client] ${msg.slice(0, 400)}`)
    return json({ ok: true })
  }  if (sub === 'sources') {
    // 给设置页展示的候选线路（不含用户自己填的那条）
    return json({ automatic: 'auto', mirror: SOURCES.mirror, official: SOURCES.official })
  }
  if (sub === 'cancel') {
    // 真的中断网络请求，再按磁盘上的实际情况重算状态——
    // 只是把状态改掉的话，后台的下载会继续跑到 ready，用户会以为"取消没用"。
    if (downloadJob !== null) {
      downloadJob.controller.abort()
      downloadJob = null
    }
    current = freshState()
    return json(await refreshFromDisk())
  }
  if (sub.startsWith('file')) return serveFile(request)

  /**
   * 自检：一层一层往下走，每层单独 try，前一层挂了后面照样报。
   * 重启之后一条 curl 就能看清到底是哪一层没起来。
   */
  if (sub === 'selftest') {
    const report = { ok: true, steps: [] }
    const step = async (name, run) => {
      try {
        const value = await run()
        report.steps.push({ name, ok: true, value })
        return value
      } catch (error) {
        report.ok = false
        report.steps.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
        return null
      }
    }

    await step('runtime', async () => {
      const { probeRuntime } = await inferModule()
      return await probeRuntime()
    })
    const status = await step('model-files', async () => {
      const next = await refreshFromDisk()
      return { state: next.state, bytes: next.bytes }
    })
    let realLexicon = null
    await step('lexicon', async () => {
      realLexicon = await lexiconHandle()
      return realLexicon === null ? null : { words: realLexicon.words.size }
    })
    await step('l1', async () => {
      const { l1Ready } = await import('./l1.mjs')
      return l1Ready()
    })
    await step('tokenizer', async () => {
      const { encode } = await inferModule()
      const model = await modelHandle()
      const sample = '我到上海住的还'
      const { ids, aligned } = encode(model, sample)
      return { aligned, ids: ids.length }
    })
    await step('check', async () => {
      const model = await modelHandle()
      const { checkText } = await import('./checker.mjs')
      const issues = await checkText(model, realLexicon, '我到上海住的还，可以经常包斯成晚餐咯~')
      return issues.map((issue) => `${issue.original}→${issue.candidate}(${issue.route})`)
    })
    report.model = status
    return json(report)
  }

  if (sub === 'check') {
    const text = url.searchParams.get('text') ?? ''
    const chars = [...text].length
    const wantsTypo = url.searchParams.get('typo') !== '0'
    const wantsSemantic = url.searchParams.get('sentence') !== '0'
    if (text === '' || chars > MAX_CHECK_CHARS) {
      return json({ state: 'ready', issues: [], chars, reason: text === '' ? 'empty-text' : 'too-long',
        fluency: null, semantic: { state: text === '' ? 'empty' : 'too-long', warning: null } })
    }
    const startedAt = Date.now(), status = await refreshFromDisk()
    const rawDelta = url.searchParams.get('delta'), delta = rawDelta === null ? Number.NaN : Number(rawDelta)
    const cacheKey = [text, String(delta), wantsTypo, wantsSemantic].join('\u0000')
    let pending = inflightChecks.get(cacheKey)
    if (!pending) {
      pending = (async () => {
        const semanticTask = wantsSemantic
          ? semanticHandle().then(service => service.check(text)).catch(error => ({ state: 'unavailable', warning: null, low: null, error: error.message }))
          : Promise.resolve({ state: 'disabled', warning: null, low: null })
        let issues = [], aligned = true, typoState = wantsTypo ? status.state : 'disabled', typoError = null
        if (wantsTypo && status.state === 'ready') {
          try {
            const model = await modelHandle(), lexicon = await lexiconHandle()
            const { checkText } = await import('./checker.mjs'), { encode } = await inferModule()
            aligned = encode(model, text).aligned
            issues = await checkText(model, lexicon, text, { minDelta: Number.isFinite(delta) ? delta : undefined })
            typoState = 'ready'
          } catch (error) { typoState = 'unavailable'; typoError = error.message }
        }
        const semantic = await semanticTask
        const ready = typoState === 'ready' || semantic.state === 'ready'
        return { state: ready ? 'ready' : typoState === 'unavailable' || semantic.state === 'unavailable' ? 'error' : status.state,
          issues, chars, aligned, reason: ready ? 'checked' : 'model-unavailable',
          threshold: Number.isFinite(delta) ? delta : null,
          fluency: semantic.state === 'ready' ? semantic : null, semantic,
          typo: { state: typoState, error: typoError } }
      })().finally(() => inflightChecks.delete(cacheKey))
      inflightChecks.set(cacheKey, pending)
    }
    const result = await pending
    lastCheck = { at: Date.now(), chars, issues: result.issues.length, semantic: result.semantic.state,
      warning: result.semantic.warning === true, threshold: Number.isFinite(delta) ? delta : null }
    return json({ ...result, ms: Date.now() - startedAt })
  }

  if (sub === 'delete') {
    for (const spec of fileSpecs()) {
      await fsp.rm(path.join(modelDir(), spec.name), { force: true })
      await fsp.rm(path.join(modelDir(), `${spec.name}.part`), { force: true })
    }
    current = freshState()
    return json(await refreshFromDisk())
  }
  return json({ error: 'not found' }, 404)
}

export const inject = ['webServer']

/**
 * 启动痕迹写进临时目录。
 *
 * 宿主插件的加载期错误在这里没有任何可观测通道（没有日志文件、路由没起来时也无从查起），
 * 所以 apply() 每一步都留一行。排查宿主侧问题时把这段留着，代价只有几行代码。
 */
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
    } catch (_error) {
      value[field] = '<unreadable>'
    }
  }
  try {
    return JSON.stringify(value)
  } catch (_error) {
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
  try {
    // profileContext is the launcher's authoritative profile. DSH_PROFILE_* is
    // normally provided to agent shell tools, not to the host's own process.env.
    const profile = typeof ctx.get === 'function' ? ctx.get('profileContext') : ctx.profileContext
    hostProfileDir = typeof profile?.dir === 'string' && profile.dir ? profile.dir : null
    // 诊断不能影响加载：configSummary 可能遇到不可序列化的 Ref，放进 try 里。
    bootLog(`apply start, webServer=${typeof ctx.webServer}, effect=${typeof ctx.effect}, settings=${configSummary(refs)}`)
    current = freshState()
    if (ctx.webServer === undefined || ctx.webServer === null) {
      bootLog('no webServer service, model routes disabled')
      return
    }
    ctx.effect(() => {
      try {
        const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE, resource })
        bootLog(`route registered at ${ROUTE}`)
        return dispose
      } catch (error) {
        bootLog(`register failed: ${error instanceof Error ? error.stack : String(error)}`)
        throw error
      }
    }, 'zh-typo-check: model routes')

    /**
     * 卸载 / 升级（DSH 会先停掉旧版本再换新代码）时把长生命周期资源放掉。
     *
     * 路由由上面的 effect 负责注销；这里补上进程级资源：正在下载的网络请求、
     * 合并表、已打开的 ONNX 会话。旧版本被停止后如果 native 句柄还挂在宿主进程里，
     * 升级后新旧两代就会同时持有它，属于"卸载没做干净"。
     */
    ctx.effect(() => () => {
      try {
        if (downloadJob !== null) {
          downloadJob.controller.abort()
          downloadJob = null
        }
      } catch { /* 卸载不能因为清理失败而阻塞 */ }
      const pendingChecks = [...inflightChecks.values()]
      inflightChecks.clear()
      const oldSemantic = semanticService
      semanticService = null
      const semanticCleanup = oldSemantic?.dispose().catch(() => {})
      current = freshState()
      lastCheck = null
      cachedModel = null
      cachedLexicon = undefined
      const typoCleanup = Promise.allSettled(pendingChecks).then(async () => {
        try { const infer = await inferCache; infer?.closeModel?.() } catch { /* shutdown */ }
      })
      return Promise.allSettled([semanticCleanup, typoCleanup]).then(() => {
        bootLog('released: download aborted, model unloaded')
      })
    }, 'zh-typo-check: release on unload')

    void refreshFromDisk()
    inspectClientEntry(ctx)
    bootLog('apply done')
  } catch (error) {
    bootLog(`apply failed: ${error instanceof Error ? error.stack : String(error)}`)
  }
}
