/** Frozen final Jev experiment. No key, account settings or plugin data are persisted. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODEL, requestFor, scoreFor, decisionFor, variants } from './semantic-jev-questions.mjs'
import { JevClient, digest, readJson, readLines, writeJson } from './semantic-jev-client.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(ROOT, '.research/semantic-jev')
const command = process.argv[2] ?? 'run-all'
const manifest = await readJson(path.join(WORK, 'manifest.json'))
const approval = await readJson(path.join(WORK, 'authorization.json'))
const data = await readJson(path.join(WORK, 'prepared.json'))
async function verifyFrozen() {
  const manifestHash = digest(await fs.readFile(path.join(WORK, 'manifest.json')))
  if (!approval.approval || approval.manifest_sha256 !== manifestHash) throw new Error('Approval does not cover this sealed experiment')
  if (digest(await fs.readFile(path.join(WORK, 'prepared.json'))) !== manifest.prepared_sha256) throw new Error('Prepared data changed')
  for (const [relative, expected] of Object.entries(manifest.source_sha256)) {
    if (digest(await fs.readFile(path.join(ROOT, relative))) !== expected) throw new Error(`Frozen source changed: ${relative}`)
  }
}
await verifyFrozen()

function pairs(rows, predictions, label) { return rows.map((row, i) => [row, predictions[i]]).filter(([row]) => row.label === label) }
function metrics(rows, predictions) {
  const count = label => { const selected = pairs(rows, predictions, label); return [selected.filter(([, p]) => p.warning).length, selected.length] }
  const output = { n: rows.length, normal_false_positives: count(0), noise_detected: count(1), context_warnings: count(2), languages: {} }
  for (const language of ['zh', 'en', 'mixed']) {
    const ids = rows.flatMap((row, i) => row.language === language ? [i] : [])
    if (!ids.length) continue
    output.languages[language] = Object.fromEntries([[0, 'normal_false_positives'], [1, 'noise_detected'], [2, 'context_warnings']].map(([label, key]) => {
      const matching = ids.filter(i => rows[i].label === label)
      return [key, [matching.filter(i => predictions[i].warning).length, matching.length]]
    }))
  }
  return output
}
const cost = m => m.noise_detected[1] - m.noise_detected[0] + 3 * (m.normal_false_positives[0] + m.context_warnings[0])
function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const p = q => { const x = (sorted.length - 1) * q, a = Math.floor(x), b = Math.ceil(x); return sorted[a] + (sorted[b] - sorted[a]) * (x - a) }
  return { n: sorted.length, p50: p(0.5), p95: p(0.95), max: sorted.at(-1) }
}
const exists = async name => fs.access(path.join(WORK, name)).then(() => true, () => false)
const flatEvaluation = Object.entries(data.evaluation).flatMap(([split, rows]) => rows.map((row, index) => ({ ...row, split, index })))
const originalText = '女哦就是的感受a到啊删掉asd苏打粉二十个s收到'
const original = flatEvaluation.find(row => row.text === originalText)
const probeRows = [original, ...[0, 10, 20, 30, 40, 50, 60, 70, 80].map(i => data.screen[i])]
const latencyRows = [...[0, 10, 20, 30, 40, 50, 60, 70, 80].flatMap(i => [data.screen[i], data.screen[i + 1]]), original,
  flatEvaluation.find(row => row.text === 'That is not what I was asking for.')]

if (!await exists('run-plan.json')) {
  const sources = ['semantic-jev.mjs', 'semantic-jev-client.mjs', 'semantic-jev-run.py']
  await writeJson(path.join(WORK, 'run-plan.json'), { created_at_utc: new Date().toISOString(),
    manifest_sha256: digest(await fs.readFile(path.join(WORK, 'manifest.json'))),
    execution_source_sha256: Object.fromEntries(await Promise.all(sources.map(async name => [name, digest(await fs.readFile(path.join(ROOT, 'tools', name)))]))),
    probe_text_sha256: probeRows.map(row => digest(row.text)), latency_text_sha256: latencyRows.map(row => digest(row.text)),
    serial_latency_cases: 20, probe_cases: 10, paid_call_budget: approval.approved_budget_usd,
    combinations: ['R13 AND Jev', 'R13 OR Jev'], selection_before675: true })
}
const client = await new JevClient(WORK, approval).initialize()

async function batch(stage, rows, variant, concurrency = 6) {
  const file = path.join(WORK, stage + '.jsonl'), prior = await readLines(file), cached = new Map(prior.map(row => [row.id, row]))
  if (cached.size !== prior.length) throw new Error(`Duplicate ${stage} cache IDs`)
  const result = new Array(rows.length), started = performance.now()
  let next = 0, completed = 0, failure
  async function worker() {
    while (!failure && !client.fatal) {
      const index = next++
      if (index >= rows.length) return
      const row = rows[index], id = String(index), payload = requestFor(row.text, variant)
      try {
        let record = cached.get(id)
        if (record && record.request_sha256 !== digest(JSON.stringify(payload))) throw new Error(`Stale request cache: ${stage}/${id}`)
        if (!record) {
          record = await client.call(payload, stage, id)
          // Validate all required typed values before accepting the record as a prediction.
          for (const arm of variant === 'screen' ? Object.keys(variants) : [variant]) scoreFor(record.response.answers, arm)
          record = { ...record, text_sha256: digest(row.text), label: row.label, language: row.language }
          await client.append(file, record)
        }
        result[index] = record; completed++
        if (completed % 50 === 0 || completed === rows.length) console.log(JSON.stringify({ stage, completed, total: rows.length,
          elapsed_seconds: (performance.now() - started) / 1000, billing: client.summary() }))
      } catch (error) { failure = error }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  await writeJson(path.join(WORK, 'budget-summary.json'), client.summary())
  if (failure) throw failure
  if (completed !== rows.length) throw new Error(`Incomplete ${stage}: ${completed}/${rows.length}`)
  return result
}

async function probe() {
  if (await exists('probe-summary.json')) return
  await client.models()
  const records = await batch('probe', probeRows, 'screen', 1)
  await writeJson(path.join(WORK, 'probe-summary.json'), { records, model: MODEL, cases: records.length,
    note: 'Representative protocol check only, not prompt selection or held-out performance.' })
}

async function screen() {
  if (await exists('screen-selection.json')) return
  const records = await batch('screen', data.screen, 'screen'), candidates = []
  for (const [order, variant] of Object.keys(variants).entries()) {
    const scores = records.map(record => scoreFor(record.response.answers, variant))
    for (const threshold of manifest.screen.thresholds) {
      const m = metrics(data.screen, scores.map(score => decisionFor(score, threshold)))
      candidates.push({ variant, threshold, metrics: m, cost: cost(m), order })
    }
  }
  candidates.sort((a, b) => a.cost - b.cost || a.metrics.normal_false_positives[0] - b.metrics.normal_false_positives[0]
    || a.metrics.context_warnings[0] - b.metrics.context_warnings[0] || b.metrics.noise_detected[0] - a.metrics.noise_detected[0] || a.order - b.order || a.threshold - b.threshold)
  const selected = candidates[0]
  await writeJson(path.join(WORK, 'screen-selection.json'), { selected, candidates, sealed_at_utc: new Date().toISOString(),
    screen_sha256: digest(await fs.readFile(path.join(WORK, 'screen.jsonl'))), selection_uses_only_CAL: true })
  console.log(JSON.stringify({ screen_selection: selected }))
}

async function calibrate() {
  if (await exists('threshold-selection.json')) return
  const selected = (await readJson(path.join(WORK, 'screen-selection.json'))).selected
  const records = await batch('cal', data.cal, selected.variant)
  const scores = records.map(record => scoreFor(record.response.answers, selected.variant))
  const normal = scores.filter((_, i) => data.cal[i].label === 0).sort((a, b) => a - b)
  const context = scores.filter((_, i) => data.cal[i].label === 2)
  const fpBudget = Math.floor(0.005 * normal.length)
  const primary = Math.max(normal[normal.length - 1 - fpBudget], ...context)
  const candidates = [...new Set([0, 0.7, 1, ...scores])].map(threshold => {
    const m = metrics(data.cal, scores.map(score => decisionFor(score, threshold)))
    return { threshold, metrics: m, cost: cost(m) }
  }).sort((a, b) => a.cost - b.cost || a.metrics.normal_false_positives[0] - b.metrics.normal_false_positives[0]
    || a.metrics.context_warnings[0] - b.metrics.context_warnings[0] || b.metrics.noise_detected[0] - a.metrics.noise_detected[0] || a.threshold - b.threshold)
  const describe = threshold => ({ threshold, metrics: metrics(data.cal, scores.map(score => decisionFor(score, threshold))) })
  const selection = { variant: selected.variant, thresholds: { primary: describe(primary), fixed_0_7: describe(0.7), cal_cost: candidates[0] },
    cal_normal_n: normal.length, normal_fp_budget: fpBudget, context_warnings_budget: 0,
    cal_sha256: digest(await fs.readFile(path.join(WORK, 'cal.jsonl'))), sealed_at_utc: new Date().toISOString(),
    evaluation675_not_used_for_selection: true, thresholds_are_engineering_comparison_not_user_release_requirements: true }
  if (selection.thresholds.primary.metrics.normal_false_positives[0] > fpBudget || selection.thresholds.primary.metrics.context_warnings[0] !== 0) throw new Error('CAL operating policy violated')
  await writeJson(path.join(WORK, 'threshold-selection.json'), selection)
  console.log(JSON.stringify({ calibration: selection }))
}

async function evaluate() {
  if (await exists('evaluation.json')) return
  const selected = await readJson(path.join(WORK, 'threshold-selection.json'))
  const records = await batch('evaluation', flatEvaluation, selected.variant)
  const reference = await readJson(path.join(ROOT, '.research/semantic-qwen35/r13-reference.json'))
  const baseline = Object.entries(data.evaluation).flatMap(([split]) => reference[split])
  const configurations = {}
  for (const [policy, config] of Object.entries(selected.thresholds)) {
    const predictions = records.map(record => {
      const score = scoreFor(record.response.answers, selected.variant)
      return { score, ...decisionFor(score, config.threshold), wall_ms: record.wall_ms }
    })
    configurations[policy] = { threshold: config.threshold, metrics: metrics(flatEvaluation, predictions), predictions, splits: {} }
    for (const split of Object.keys(data.evaluation)) {
      const ids = flatEvaluation.flatMap((row, i) => row.split === split ? [i] : [])
      configurations[policy].splits[split] = metrics(ids.map(i => flatEvaluation[i]), ids.map(i => predictions[i]))
    }
    configurations[policy].original = predictions[flatEvaluation.findIndex(row => row.text === originalText)]
  }
  const primary = configurations.primary.predictions
  for (const [name, combine] of [['r13_and_jev', (a, b) => a && b], ['r13_or_jev', (a, b) => a || b]]) {
    const predictions = primary.map((pred, i) => ({ warning: combine(baseline[i].warning, pred.warning) }))
    configurations[name] = { metrics: metrics(flatEvaluation, predictions),
      remote_calls_if_cascaded: name === 'r13_and_jev' ? baseline.filter(p => p.warning).length : baseline.filter(p => !p.warning).length,
      note: 'Decision simulation over paired results; not measured cascade latency.' }
  }
  await writeJson(path.join(WORK, 'evaluation.json'), { model: MODEL, variant: selected.variant,
    threshold_selection_sha256: digest(await fs.readFile(path.join(WORK, 'threshold-selection.json'))),
    known_regression_only: true, configurations, latency_concurrent_wall_ms: percentiles(records.map(r => r.wall_ms)),
    complete_valid_predictions: records.length, api_errors: (await readLines(path.join(WORK, 'api-errors.jsonl'))).length,
    completed_at_utc: new Date().toISOString() })
  console.log(JSON.stringify({ evaluation: Object.fromEntries(Object.entries(configurations).map(([k, v]) => [k, v.metrics])) }))
}

async function latency() {
  if (await exists('serial-latency.json')) return
  const selected = await readJson(path.join(WORK, 'threshold-selection.json'))
  const records = await batch('serial-latency', latencyRows, selected.variant, 1)
  await writeJson(path.join(WORK, 'serial-latency.json'), { wall_ms: percentiles(records.map(r => r.wall_ms)),
    rows: records.map((record, i) => ({ text: latencyRows[i].text, wall_ms: record.wall_ms,
      score: scoreFor(record.response.answers, selected.variant), input_tokens: record.response.usage.input_tokens })),
    timing_scope: 'Warm persistent HTTP transport, serial calls, includes internet roundtrip; no SDK or model load. No claim about vendor-side compute time.' })
}

async function combine() {
  const result = { manifest, execution_plan: await readJson(path.join(WORK, 'run-plan.json')),
    authorization: { approved: true, budget_usd: approval.approved_budget_usd, scope: approval.scope },
    screen: await readJson(path.join(WORK, 'screen-selection.json')), calibration: await readJson(path.join(WORK, 'threshold-selection.json')),
    evaluation: await readJson(path.join(WORK, 'evaluation.json')), serial_latency: await readJson(path.join(WORK, 'serial-latency.json')),
    billing: client.summary(), errors: await readLines(path.join(WORK, 'api-errors.jsonl')),
    completed_at_utc: new Date().toISOString() }
  await writeJson(path.join(WORK, 'results.json'), result)
  await writeJson(path.join(ROOT, 'data/semantic-jev-results.json'), result)
  console.log(JSON.stringify({ complete: true, billing: result.billing, result: 'data/semantic-jev-results.json' }))
}

try {
  if (command === 'run-all') { await probe(); await screen(); await calibrate(); await evaluate(); await latency(); await combine() }
  else if (command === 'models') await client.models()
  else if (command === 'probe') await probe()
  else if (command === 'screen') await screen()
  else if (command === 'calibrate') await calibrate()
  else if (command === 'evaluate') await evaluate()
  else if (command === 'latency') await latency()
  else if (command === 'combine') await combine()
  else throw new Error('Unknown command')
} finally { await writeJson(path.join(WORK, 'budget-summary.json'), client.summary()) }
