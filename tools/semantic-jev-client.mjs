/** Small official-HTTP client with an append-only, crash-conservative spend ledger. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { MODEL, INPUT_USD_PER_MILLION, MAX_REQUEST_TOKENS } from './semantic-jev-questions.mjs'

export const digest = value => createHash('sha256').update(value).digest('hex')
export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')) }
export async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n') }
export async function readLines(file) {
  let raw
  try { raw = await fs.readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

export class JevClient {
  constructor(folder, authorization) {
    if (!authorization.approval || !(authorization.approved_budget_usd > 0)) throw new Error('Cloud experiment approval is missing')
    if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is missing')
    this.folder = folder; this.key = process.env.TYPESAFE_API_KEY
    this.cap = Math.floor(authorization.approved_budget_usd * 1e6 / INPUT_USD_PER_MILLION)
    this.journal = path.join(folder, 'billing.jsonl'); this.reservations = new Map()
    this.billed = 0; this.sequence = 0; this.queue = Promise.resolve(); this.fatal = null
  }
  async initialize() {
    for (const event of await readLines(this.journal)) {
      this.sequence = Math.max(this.sequence, event.sequence ?? 0)
      if (event.kind === 'reserve') this.reservations.set(event.call_id, event.tokens)
      if (event.kind === 'settle') { this.reservations.delete(event.call_id); this.billed += event.input_tokens }
    }
    return this
  }
  clean(value) { return String(value).split(this.key).join('[REDACTED]') }
  append(file, value) {
    this.queue = this.queue.then(() => fs.appendFile(file, JSON.stringify(value) + '\n'))
    return this.queue
  }
  summary() {
    const reserved = [...this.reservations.values()].reduce((a, b) => a + b, 0)
    return { confirmed_input_tokens: this.billed, unresolved_or_active_reservation_tokens: reserved,
      confirmed_usd: this.billed * INPUT_USD_PER_MILLION / 1e6,
      conservative_usd: (this.billed + reserved) * INPUT_USD_PER_MILLION / 1e6,
      authorized_cap_usd: this.cap * INPUT_USD_PER_MILLION / 1e6,
      price_usd_per_million: INPUT_USD_PER_MILLION, attempts_started: this.sequence }
  }
  async reserve(stage, id, attempt) {
    if (this.fatal) throw this.fatal
    const held = [...this.reservations.values()].reduce((a, b) => a + b, 0)
    if (this.billed + held + MAX_REQUEST_TOKENS > this.cap) throw new Error('Experiment budget hard stop')
    const sequence = ++this.sequence, callId = `${stage}:${id}:${sequence}`
    this.reservations.set(callId, MAX_REQUEST_TOKENS)
    await this.append(this.journal, { kind: 'reserve', sequence, call_id: callId,
      stage, id, attempt, tokens: MAX_REQUEST_TOKENS, at_utc: new Date().toISOString() })
    return callId
  }
  async settle(callId, tokens) {
    if (!Number.isInteger(tokens) || tokens < 0 || tokens > MAX_REQUEST_TOKENS) throw new Error('Invalid billable token usage')
    this.reservations.delete(callId); this.billed += tokens
    await this.append(this.journal, { kind: 'settle', call_id: callId, input_tokens: tokens, at_utc: new Date().toISOString() })
  }
  async models() {
    const response = await fetch('https://api.typesafe.ai/v1/models', {
      headers: { Authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(20000)
    })
    const body = this.clean(await response.text())
    if (!response.ok) throw new Error(`Model-list HTTP${response.status}: ${body.slice(0, 500)}`)
    const result = JSON.parse(body); await writeJson(path.join(this.folder, 'available-models.json'), result)
    return result
  }
  async call(payload, stage, id) {
    const serialized = JSON.stringify(payload)
    if (payload.model !== MODEL || Buffer.byteLength(serialized) > 32000) throw new Error('Unexpected model or excessive text payload')
    const requestHash = digest(serialized)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const callId = await this.reserve(stage, id, attempt), tick = performance.now()
      let status, retryAfter, settled = false
      try {
        const response = await fetch('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
          body: serialized, signal: AbortSignal.timeout(20000)
        })
        status = response.status; retryAfter = response.headers.get('retry-after')
        const raw = this.clean(await response.text())
        if (!response.ok) {
          // Published pricing has no failed-request fee; an actual HTTP failure is distinct
          // from a connection/timeout with an unknown billing outcome.
          await this.settle(callId, 0); settled = true
          const error = new Error(`HTTP${status}: ${raw.slice(0, 800)}`)
          error.fatal = ![408, 429, 500, 502, 503, 504, 529].includes(status)
          throw error
        }
        const result = JSON.parse(raw)
        await this.settle(callId, result.usage?.input_tokens); settled = true
        if (result.model !== MODEL) { const error = new Error(`Expected ${MODEL}, received ${result.model}`); error.fatal = true; throw error }
        if (!result.answers || typeof result.answers !== 'object') { const error = new Error('Missing typed answers'); error.fatal = true; throw error }
        return { stage, id, attempt, call_id: callId, request_sha256: requestHash, request: payload,
          response: result, wall_ms: performance.now() - tick, http_status: status }
      } catch (error) {
        await this.append(path.join(this.folder, 'api-errors.jsonl'), { stage, id, attempt, call_id: callId,
          request_sha256: requestHash, request: payload, http_status: status ?? null,
          error: this.clean(error.message), billing_settled: settled, wall_ms: performance.now() - tick })
        if (error.fatal) { this.fatal = error; throw error }
        if (attempt === 3) throw new Error(`Request failed after3 attempts: ${stage}/${id}: ${this.clean(error.message)}`)
        let waitMs = 500 * 2 ** (attempt - 1)
        if (retryAfter) {
          const seconds = Number(retryAfter)
          waitMs = Math.max(waitMs, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now())
        }
        await new Promise(resolve => setTimeout(resolve, Math.max(0, waitMs)))
      }
    }
  }
}
