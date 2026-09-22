import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemoteProvider, REMOTE_PROVIDER_ID } from '../src/remote-provider.ts'
import type {
  JevProvider,
  ModelRoutingRequest,
  PermissionRequest,
  ToolFilterRequest,
} from '../src/types.ts'

const routeRequest: ModelRoutingRequest = {
  role: 'orchestration',
  candidates: [],
  preferences: { prefer: [], avoid: [] },
  bias: 'quality',
}

const toolRequest: ToolFilterRequest = {
  task: 'read a file',
  tools: [{ name: 'read', description: 'Read a file' }],
  alwaysKeep: [],
  minToolsToFilter: 1,
  minRetained: 1,
  maxRemovalFraction: 1,
}

const permissionRequest: PermissionRequest = {
  toolName: 'bash',
  arguments: { command: 'ls' },
  profile: 'balanced',
  riskRules: [],
  clauses: [],
}

function fallback(): JevProvider {
  return {
    id: 'fallback',
    async routeModel() { return { reason: 'fallback route' } },
    async filterTools() { return { reason: 'fallback tools' } },
    async judgePermission() {
      return { outcome: 'allow', level: 'none', signals: [], reason: 'fallback permission' }
    },
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('remote Jev provider', () => {
  it('sends and validates every decision kind with bearer authorization', async () => {
    const fetchImpl: typeof fetch = vi.fn()
      .mockResolvedValueOnce(response({
        selection: { provider: 'deepseek', model: 'pro' },
        reason: 'best route',
      }))
      .mockResolvedValueOnce(response({ keep: ['read'], reason: 'task match' }))
      .mockResolvedValueOnce(response({
        outcome: 'ask',
        level: 'high',
        signals: ['destructive'],
        reason: 'confirm',
      }))
    const provider = createRemoteProvider({
      endpoint: 'https://jev.example/decide',
      apiKey: 'secret',
      timeoutMs: 100,
      fallback: fallback(),
      fetchImpl,
    })

    expect(provider.id).toBe(REMOTE_PROVIDER_ID)
    await expect(provider.routeModel(routeRequest)).resolves.toEqual({
      selection: { provider: 'deepseek', model: 'pro' },
      reason: 'best route',
    })
    await expect(provider.filterTools(toolRequest)).resolves.toEqual({
      keep: ['read'],
      reason: 'task match',
    })
    await expect(provider.judgePermission(permissionRequest)).resolves.toEqual({
      outcome: 'ask',
      level: 'high',
      signals: ['destructive'],
      reason: 'confirm',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(url).toBe('https://jev.example/decide')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret',
      },
    })
    if (typeof init?.body !== 'string') throw new Error('expected a JSON request body')
    expect(JSON.parse(init.body)).toEqual({ kind: 'routeModel', request: routeRequest })
  })

  it('accepts no-op routing and filtering replies and forwards a caller signal', async () => {
    const fetchImpl: typeof fetch = vi.fn()
      .mockResolvedValueOnce(response({ selection: null, reason: 'no opinion' }))
      .mockResolvedValueOnce(response({ keep: null, reason: 'no opinion' }))
    const provider = createRemoteProvider({
      endpoint: 'https://jev.example/decide',
      timeoutMs: 100,
      fallback: fallback(),
      fetchImpl,
    })
    const caller = new AbortController()

    await expect(provider.routeModel(routeRequest, caller.signal)).resolves.toEqual({ reason: 'no opinion' })
    await expect(provider.filterTools(toolRequest, caller.signal)).resolves.toEqual({ reason: 'no opinion' })
    const init = vi.mocked(fetchImpl).mock.calls[0]![1]
    expect(init?.headers).toEqual({ 'content-type': 'application/json' })
    expect(init?.signal).not.toBe(caller.signal)
  })

  it('uses global fetch when no implementation is injected', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => response({ reason: 'global' }))
    vi.stubGlobal('fetch', fetchImpl)
    const provider = createRemoteProvider({
      endpoint: 'https://jev.example/decide',
      timeoutMs: 100,
      fallback: fallback(),
    })

    await expect(provider.routeModel(routeRequest)).resolves.toEqual({ reason: 'global' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('falls back on HTTP failure and reports the cause', async () => {
    const onFallback = vi.fn()
    const provider = createRemoteProvider({
      endpoint: 'https://jev.example/decide',
      timeoutMs: 100,
      fallback: fallback(),
      fetchImpl: vi.fn(async () => response({ error: true }, 503)),
      onFallback,
    })

    await expect(provider.routeModel(routeRequest)).resolves.toEqual({ reason: 'fallback route' })
    expect(onFallback).toHaveBeenCalledOnce()
    expect(String(onFallback.mock.calls[0]![0])).toContain('status 503')
  })

  it('aborts a timed-out request and falls back', async () => {
    vi.useFakeTimers()
    const fetchImpl: typeof fetch = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    const provider = createRemoteProvider({
      endpoint: 'https://jev.example/decide',
      timeoutMs: 10,
      fallback: fallback(),
      fetchImpl,
    })

    const pending = provider.routeModel(routeRequest)
    await vi.advanceTimersByTimeAsync(10)
    await expect(pending).resolves.toEqual({ reason: 'fallback route' })
  })

  it.each([
    ['routeModel', null],
    ['routeModel', 1],
    ['routeModel', {}],
    ['routeModel', { reason: '', selection: null }],
    ['routeModel', { reason: 'x', selection: 'bad' }],
    ['routeModel', { reason: 'x', selection: { model: 'm' } }],
    ['routeModel', { reason: 'x', selection: { provider: 'p' } }],
    ['filterTools', null],
    ['filterTools', 1],
    ['filterTools', {}],
    ['filterTools', { reason: 'x', keep: 'bad' }],
    ['filterTools', { reason: 'x', keep: [''] }],
    ['judgePermission', null],
    ['judgePermission', 1],
    ['judgePermission', {}],
    ['judgePermission', { outcome: 'later', level: 'none', signals: [], reason: 'x' }],
    ['judgePermission', { outcome: 'allow', level: 'unknown', signals: [], reason: 'x' }],
    ['judgePermission', { outcome: 'allow', level: 'none', signals: 'bad', reason: 'x' }],
    ['judgePermission', { outcome: 'allow', level: 'none', signals: [''], reason: 'x' }],
    ['judgePermission', { outcome: 'allow', level: 'none', signals: [] }],
  ] as const)('falls back when %s returns invalid JSON fields', async (kind, body) => {
    const onFallback = vi.fn()
    const provider = createRemoteProvider({
      endpoint: 'https://jev.example/decide',
      timeoutMs: 100,
      fallback: fallback(),
      fetchImpl: vi.fn(async () => response(body)),
      onFallback,
    })

    const result = kind === 'routeModel'
      ? await provider.routeModel(routeRequest)
      : kind === 'filterTools'
        ? await provider.filterTools(toolRequest)
        : await provider.judgePermission(permissionRequest)
    expect(result.reason).toMatch(/^fallback /)
    expect(onFallback).toHaveBeenCalledOnce()
  })

  it('does not require a fallback observer', async () => {
    const provider = createRemoteProvider({
      endpoint: 'https://jev.example/decide',
      timeoutMs: 100,
      fallback: fallback(),
      fetchImpl: vi.fn(async () => response(null)),
    })

    await expect(provider.filterTools(toolRequest)).resolves.toEqual({ reason: 'fallback tools' })
  })
})
