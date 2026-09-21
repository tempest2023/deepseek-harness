/**
 * A remote Jev backend. It speaks one small JSON contract, validates every
 * response at the wire boundary, bounds each call with a deadline, and falls
 * back to the deterministic provider on any failure so an unavailable backend
 * never blocks a turn.
 *
 * Wire contract: `POST <endpoint>` with
 * `{ kind: 'routeModel' | 'filterTools' | 'judgePermission', request: <decision request> }`
 * and a JSON decision body of the matching public type in reply.
 *
 * @module @deepseek-ai/dsh-jev/remote-provider
 */

import { RISK_LEVELS } from './types.ts'
import type {
  JevProvider,
  ModelRoutingDecision,
  ModelRoutingRequest,
  PermissionJudgment,
  PermissionRequest,
  RiskLevel,
  ToolFilterDecision,
  ToolFilterRequest,
} from './types.ts'

/** Provider id reported in decision events. */
export const REMOTE_PROVIDER_ID = 'remote'

/** Injection contract for the remote provider. */
export interface RemoteProviderOptions {
  /** Absolute HTTP(S) endpoint accepting the documented JSON contract. */
  endpoint: string
  /** Bearer credential, when the backend requires one. */
  apiKey?: string
  /** Per-call deadline in milliseconds. */
  timeoutMs: number
  /** Local provider used when the backend fails or answers invalid JSON. */
  fallback: JevProvider
  /**
   * `fetch` implementation; injected so tests exercise the wire contract
   * without a network. Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch
  /** Reports one fallback so the caller can surface it in observability. */
  onFallback?: (error: unknown) => void
}

/** Reject a value that is not a plain string field. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`remote Jev response field "${field}" must be a non-empty string`)
  }
  return value
}

/** Validate the `routeModel` reply. */
function parseRoutingDecision(raw: unknown): ModelRoutingDecision {
  if (typeof raw !== 'object' || raw === null) throw new Error('remote Jev routeModel reply must be an object')
  const body = raw as Record<string, unknown>
  const reason = requireString(body['reason'], 'reason')
  if (body['selection'] === undefined || body['selection'] === null) return { reason }
  const selection = body['selection']
  if (typeof selection !== 'object') throw new Error('remote Jev routeModel selection must be an object')
  const ref = selection as Record<string, unknown>
  return { selection: { provider: requireString(ref['provider'], 'selection.provider'), model: requireString(ref['model'], 'selection.model') }, reason }
}

/** Validate the `filterTools` reply. */
function parseToolDecision(raw: unknown): ToolFilterDecision {
  if (typeof raw !== 'object' || raw === null) throw new Error('remote Jev filterTools reply must be an object')
  const body = raw as Record<string, unknown>
  const reason = requireString(body['reason'], 'reason')
  if (body['keep'] === undefined || body['keep'] === null) return { reason }
  if (!Array.isArray(body['keep'])) throw new Error('remote Jev filterTools keep must be an array')
  return { keep: body['keep'].map((entry, index) => requireString(entry, `keep[${String(index)}]`)), reason }
}

/** Validate the `judgePermission` reply. */
function parsePermissionJudgment(raw: unknown): PermissionJudgment {
  if (typeof raw !== 'object' || raw === null) throw new Error('remote Jev judgePermission reply must be an object')
  const body = raw as Record<string, unknown>
  const outcome = requireString(body['outcome'], 'outcome')
  if (outcome !== 'allow' && outcome !== 'ask' && outcome !== 'deny') {
    throw new Error(`remote Jev judgePermission outcome must be allow/ask/deny, received "${outcome}"`)
  }
  const level = requireString(body['level'], 'level')
  if (!RISK_LEVELS.includes(level as RiskLevel)) {
    throw new Error(`remote Jev judgePermission level must be a known risk level, received "${level}"`)
  }
  const signals = body['signals']
  if (!Array.isArray(signals)) throw new Error('remote Jev judgePermission signals must be an array')
  return {
    outcome,
    level: level as RiskLevel,
    signals: signals.map((entry, index) => requireString(entry, `signals[${String(index)}]`)),
    reason: requireString(body['reason'], 'reason'),
  }
}

/**
 * Build the remote provider.
 * @param options - endpoint, credential, deadline, fallback, and fetch injection.
 * @returns a provider delegating to the backend, falling back on any failure.
 */
export function createRemoteProvider(options: RemoteProviderOptions): JevProvider {
  const doFetch = options.fetchImpl ?? fetch

  /** Send one decision request, validating the reply. */
  async function ask<T>(
    kind: 'routeModel' | 'filterTools' | 'judgePermission',
    request: unknown,
    parse: (raw: unknown) => T,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error('remote Jev request timed out')) }, options.timeoutMs)
    const forwarded = signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, signal])
    try {
      const response = await doFetch(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` },
        },
        body: JSON.stringify({ kind, request }),
        signal: forwarded,
      })
      if (!response.ok) throw new Error(`remote Jev request failed with status ${String(response.status)}`)
      return parse(await response.json())
    } finally {
      clearTimeout(timer)
    }
  }

  /** Delegate one decision, downgrading to the fallback on any failure. */
  async function withFallback<T>(
    run: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run()
    } catch (error: unknown) {
      options.onFallback?.(error)
      return await fallback()
    }
  }

  return {
    id: REMOTE_PROVIDER_ID,
    routeModel: (request: ModelRoutingRequest, signal?: AbortSignal) => withFallback(
      () => ask('routeModel', request, parseRoutingDecision, signal),
      () => options.fallback.routeModel(request, signal),
    ),
    filterTools: (request: ToolFilterRequest, signal?: AbortSignal) => withFallback(
      () => ask('filterTools', request, parseToolDecision, signal),
      () => options.fallback.filterTools(request, signal),
    ),
    judgePermission: (request: PermissionRequest, signal?: AbortSignal) => withFallback(
      () => ask('judgePermission', request, parsePermissionJudgment, signal),
      () => options.fallback.judgePermission(request, signal),
    ),
  }
}
