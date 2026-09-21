import { describe, expect, it } from 'vitest'
import { rankCandidate, routeModel } from '../src/router.ts'
import { createHeuristicProvider, HEURISTIC_PROVIDER_ID } from '../src/heuristic-provider.ts'
import type { ModelCandidate, ModelRoutingRequest } from '../src/types.ts'

const candidates: ModelCandidate[] = [
  { provider: 'deepseek', model: 'deepseek-v4.1-pro', name: 'DeepSeek V4.1 Pro' },
  { provider: 'deepseek', model: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
]

function request(overrides: Partial<ModelRoutingRequest> = {}): ModelRoutingRequest {
  return {
    role: 'orchestration',
    candidates,
    preferences: { prefer: [], avoid: [] },
    bias: 'quality',
    ...overrides,
  }
}

describe('explicit routes', () => {
  it('selects the configured orchestration route for an orchestration step', () => {
    const decision = routeModel(request({
      preferences: { orchestration: { provider: 'deepseek', model: 'deepseek-v4.1-pro' }, prefer: [], avoid: [] },
    }))
    expect(decision.selection).toEqual({ provider: 'deepseek', model: 'deepseek-v4.1-pro' })
    expect(decision.reason).toContain('orchestration')
  })

  it('selects the configured execution route for an execution step', () => {
    const decision = routeModel(request({
      role: 'execution',
      preferences: { execution: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, prefer: [], avoid: [] },
    }))
    expect(decision.selection).toEqual({ provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  })

  it('reports an already-selected configured route without churn', () => {
    const decision = routeModel(request({
      current: { provider: 'deepseek', model: 'deepseek-v4.1-pro' },
      preferences: { orchestration: { provider: 'deepseek', model: 'deepseek-v4.1-pro' }, prefer: [], avoid: [] },
    }))
    expect(decision.reason).toContain('already selected')
  })
})

describe('no opinion', () => {
  it('declines when discovery found no candidates and nothing is configured', () => {
    const decision = routeModel(request({ candidates: [] }))
    expect(decision.selection).toBeUndefined()
    expect(decision.reason).toContain('no candidate')
  })

  it('keeps DSH selection when no preference matches', () => {
    const decision = routeModel(request({ preferences: { prefer: [{ pattern: 'gemini', role: 'any' }], avoid: [] } }))
    expect(decision.selection).toBeUndefined()
  })
})

describe('preferences and avoidance', () => {
  it('applies a role-bound preference', () => {
    const decision = routeModel(request({
      preferences: { prefer: [{ pattern: 'flash', role: 'orchestration' }], avoid: [] },
    }))
    expect(decision.selection).toEqual({ provider: 'deepseek', model: 'deepseek-v4.1-flash' })
    expect(decision.reason).toContain('flash')
  })

  it('reports a naturally preferred route that is already selected', () => {
    const decision = routeModel(request({
      current: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
      preferences: { prefer: [{ pattern: 'flash', role: 'any' }], avoid: [] },
    }))
    expect(decision.reason).toContain('already selected')
  })

  it('ignores a preference bound to the other role', () => {
    const decision = routeModel(request({
      role: 'execution',
      preferences: { prefer: [{ pattern: 'pro', role: 'orchestration' }], avoid: [] },
    }))
    expect(decision.selection).toBeUndefined()
  })

  it('replaces a model that matches an avoid pattern', () => {
    const decision = routeModel(request({
      current: { provider: 'deepseek', model: 'deepseek-v4.1-pro' },
      preferences: { prefer: [], avoid: ['pro'] },
    }))
    expect(decision.selection).toEqual({ provider: 'deepseek', model: 'deepseek-v4.1-flash' })
    expect(decision.reason).toContain('avoid')
  })

  it('uses the first role-eligible preference when replacing an avoided model', () => {
    const decision = routeModel(request({
      current: { provider: 'deepseek', model: 'deepseek-v4.1-pro' },
      preferences: {
        avoid: ['pro'],
        prefer: [
          { pattern: 'flash', role: 'execution' },
          { pattern: 'missing', role: 'any' },
          { pattern: 'flash', role: 'orchestration' },
        ],
      },
    }))
    expect(decision.selection?.model).toBe('deepseek-v4.1-flash')
  })

  it('declines when every candidate is excluded', () => {
    const decision = routeModel(request({ preferences: { prefer: [], avoid: ['deepseek'] } }))
    expect(decision.selection).toBeUndefined()
    expect(decision.reason).toContain('avoid')
  })

  it('matches a pattern against the composite provider/model text', () => {
    const decision = routeModel(request({
      preferences: { prefer: [{ pattern: 'deepseek/deepseek-v4.1-pro', role: 'any' }], avoid: [] },
    }))
    expect(decision.selection).toEqual({ provider: 'deepseek', model: 'deepseek-v4.1-pro' })
  })
})

describe('bias tie-breaks', () => {
  it('prefers the larger model under a quality bias', () => {
    const decision = routeModel(request({ preferences: { prefer: [{ pattern: 'deepseek', role: 'any' }], avoid: [] } }))
    expect(decision.selection?.model).toBe('deepseek-v4.1-pro')
  })

  it('prefers the smaller model under a cost bias', () => {
    const decision = routeModel(request({
      bias: 'cost',
      preferences: { prefer: [{ pattern: 'deepseek', role: 'any' }], avoid: [] },
    }))
    expect(decision.selection?.model).toBe('deepseek-v4.1-flash')
  })

  it('ranks capability tokens above economy tokens', () => {
    expect(rankCandidate({ provider: 'p', model: 'm-pro' }, 'quality'))
      .toBeGreaterThan(rankCandidate({ provider: 'p', model: 'm-flash' }, 'quality'))
    expect(rankCandidate({ provider: 'p', model: 'm-flash' }, 'cost'))
      .toBeGreaterThan(rankCandidate({ provider: 'p', model: 'm-pro' }, 'cost'))
  })

  it('treats latency like cost and keeps equal-rank catalog order', () => {
    expect(rankCandidate({ provider: 'p', model: 'm-flash' }, 'latency'))
      .toBeGreaterThan(rankCandidate({ provider: 'p', model: 'm-pro' }, 'latency'))
    const decision = routeModel(request({
      bias: 'latency',
      preferences: { prefer: [{ pattern: 'deepseek', role: 'any' }], avoid: [] },
    }))
    expect(decision.selection?.model).toBe('deepseek-v4.1-flash')
  })
})

describe('heuristic provider', () => {
  it('delegates all three decisions to the deterministic core', async () => {
    const provider = createHeuristicProvider()
    expect(provider.id).toBe(HEURISTIC_PROVIDER_ID)
    await expect(provider.routeModel(request())).resolves.toEqual(routeModel(request()))
    await expect(provider.filterTools({
      task: 'read',
      tools: [{ name: 'read', description: 'read' }],
      alwaysKeep: [],
      minToolsToFilter: 2,
      minRetained: 1,
      maxRemovalFraction: 1,
    })).resolves.toHaveProperty('reason')
    await expect(provider.judgePermission({
      toolName: 'bash',
      arguments: {},
      profile: 'balanced',
      riskRules: [],
      clauses: [],
    })).resolves.toMatchObject({ outcome: 'allow', level: 'none' })
  })
})
