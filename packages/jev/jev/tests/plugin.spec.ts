import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JevPlugin, { resolveConfig } from '@deepseek-ai/dsh-jev'
import type { Config, JevDecision } from '@deepseek-ai/dsh-jev'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Assembled-application suite for the Jev plugin: routing, tool pre-filtering,
 * and permission judgment all run through a real agent loop against a scripted
 * mock adapter (no network, no credential), plus the fail-loud configuration
 * contract.
 */

/** Boot the core spine plus Jev; the caller registers adapters and tools. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JevPlugin, config)
  return ctx
}

function registerTool(ctx: Context, name: string, description: string): void {
  ctx.tools.register(defineContentToolFixture({
    name,
    description,
    parameters: {},
    async execute() { return [{ type: 'text', text: `${name} ran` }] },
  }))
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

async function prompt(ctx: Context, id: string, text = 'go'): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  return agent
}

/** Every tool result in the log, flattened to error flag and text. */
function toolResults(agent: Agent): { isError: boolean; text: string }[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    .map(event => ({
      isError: event.data.message.content[0].isError === true,
      text: event.data.message.content[0].content
        .map(block => block.type === 'text' ? block.text : '')
        .join(' '),
    }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.JEV_TEST_API_KEY
})

describe('model routing', () => {
  it('routes an orchestration step to the configured orchestration model', async () => {
    const ctx = await harness({
      orchestrationProvider: 'mock-pro',
      orchestrationModel: 'deepseek-v4.1-pro',
      toolPrefilterEnabled: false,
      permissionEnabled: false,
    })
    const adapter = new MockAdapter([textResponse('done')])
    ctx.llm.registerAdapter(['mock', 'mock-pro'], adapter)
    await waitForIdle(ctx, await prompt(ctx, 'a1'))

    expect(adapter.requests[0]!.provider).toBe('mock-pro')
    expect(adapter.requests[0]!.model).toBe('deepseek-v4.1-pro')
  })

  it('leaves DSH selection untouched when nothing is configured', async () => {
    const ctx = await harness({ toolPrefilterEnabled: false, permissionEnabled: false })
    const adapter = new MockAdapter([textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    await waitForIdle(ctx, await prompt(ctx, 'a1'))

    expect(adapter.requests[0]!.provider).toBe('mock')
    expect(adapter.requests[0]!.model).toBe('mock')
  })

  it('publishes a routing decision event', async () => {
    const ctx = await harness({
      orchestrationProvider: 'mock-pro',
      orchestrationModel: 'pro',
      toolPrefilterEnabled: false,
      permissionEnabled: false,
    })
    const decisions: JevDecision[] = []
    ctx.on('jev/decision', (decision) => { decisions.push(decision) })
    ctx.llm.registerAdapter(['mock', 'mock-pro'], new MockAdapter([textResponse('done')]))
    await waitForIdle(ctx, await prompt(ctx, 'a1'))

    expect(decisions.some(decision =>
      decision.capability === 'model-router' && decision.selection?.model === 'pro')).toBe(true)
  })

  it('routes a delegated child to the execution model', async () => {
    const ctx = await harness({
      orchestrationProvider: 'mock-pro',
      orchestrationModel: 'pro',
      executionProvider: 'mock-flash',
      executionModel: 'flash',
      toolPrefilterEnabled: false,
      permissionEnabled: false,
    })
    const main = new MockAdapter([textResponse('planned')])
    const child = new MockAdapter([textResponse('executed')])
    ctx.llm.registerAdapter(['mock', 'mock-pro'], main)
    ctx.llm.registerAdapter(['mock-flash'], child)

    // The delegation depth in the session header is the only signal the router
    // needs to classify the child as an execution step.
    const handle = await ctx.agents.create({
      sessionId: SessionId('child-1'),
      meta: { delegationDepth: 1 },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do the subtask' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)
    expect(child.requests[0]!.provider).toBe('mock-flash')
    expect(child.requests[0]!.model).toBe('flash')

    await waitForIdle(ctx, await prompt(ctx, 'main-1'))
    expect(main.requests[0]!.provider).toBe('mock-pro')
    expect(main.requests[0]!.model).toBe('pro')
    await handle.dispose()
  })

  it('routes later steps of a top-level turn to the execution model when configured', async () => {
    const ctx = await harness({
      orchestrationProvider: 'mock-pro',
      orchestrationModel: 'pro',
      executionProvider: 'mock-flash',
      executionModel: 'flash',
      preferExecutionForRoutineSteps: true,
      toolPrefilterEnabled: false,
      permissionEnabled: false,
    })
    registerTool(ctx, 'probe', 'Probe the widget')
    const adapter = new MockAdapter([toolCallResponse('c1', 'probe', {}), textResponse('done')])
    ctx.llm.registerAdapter(['mock', 'mock-pro', 'mock-flash'], adapter)
    await waitForIdle(ctx, await prompt(ctx, 'main-1'))

    expect(adapter.requests[0]!.model).toBe('pro')
    expect(adapter.requests[1]!.model).toBe('flash')
  })

  it('discovers models in the background and tolerates one failing provider', async () => {
    class CatalogAdapter extends MockAdapter {
      constructor() { super([]) }

      override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
        if (provider === 'broken') return Promise.reject(new Error('catalog unavailable'))
        return Promise.resolve([{ provider, id: 'discovered-pro', name: 'Discovered Pro' }])
      }
    }
    const ctx = await harness({
      routingPreferences: 'Prefer model "Discovered Pro".',
      toolPrefilterEnabled: false,
      permissionEnabled: false,
    })
    ctx.llm.registerAdapter(['broken'], new CatalogAdapter())
    ctx.llm.registerAdapter(['catalog'], new CatalogAdapter())
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))

    // The first catalog read starts the asynchronous refresh. A later read
    // observes the successfully discovered provider while the failed one is
    // ignored as advisory data.
    const catalog = (ctx.jev as unknown as { catalog: { list(): unknown[] } }).catalog
    expect(catalog.list()).toEqual([])
    await vi.waitFor(() => { expect(catalog.list()).toHaveLength(1) })
    const agent = await prompt(ctx, 'catalog-1')
    await waitForIdle(ctx, agent)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('catalog')
  })

  it('keeps an empty catalog when no LLM service is installed', async () => {
    const ctx = new Context()
    await ctx.plugin(JevPlugin, {
      toolPrefilterEnabled: false,
      permissionEnabled: false,
      modelDiscoveryTtlMs: 1,
    })
    const catalog = (ctx.jev as unknown as { catalog: { list(): unknown[] } }).catalog
    expect(catalog.list()).toEqual([])
    await Promise.resolve()
    expect(catalog.list()).toEqual([])
  })

  it('recovers when starting a catalog refresh throws', async () => {
    const ctx = await harness({
      toolPrefilterEnabled: false,
      permissionEnabled: false,
      modelDiscoveryTtlMs: 1,
    })
    vi.spyOn(ctx.llm, 'listProviders').mockImplementation(() => { throw new Error('registry unavailable') })
    const catalog = (ctx.jev as unknown as { catalog: { list(): unknown[] } }).catalog

    expect(catalog.list()).toEqual([])
    await Promise.resolve()
    await Promise.resolve()
    expect(catalog.list()).toEqual([])
  })
})

describe('tool pre-filtering', () => {
  it('narrows the tool set once task context is visible', async () => {
    const ctx = await harness({
      modelRouterEnabled: false,
      permissionEnabled: false,
      prefilterMinTools: 2,
      prefilterMinRetained: 1,
      prefilterMaxRemovalFraction: 1,
    })
    registerTool(ctx, 'read_file', 'Read a file from the workspace')
    registerTool(ctx, 'web_search', 'Search the public web')
    registerTool(ctx, 'deploy', 'Deploy the service to production')
    const adapter = new MockAdapter([toolCallResponse('c1', 'deploy', {}), textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    await waitForIdle(ctx, await prompt(ctx, 'a1', 'please read the file and report it'))

    // The first step assembles before its own prompt is logged, so the filter
    // correctly declines; the second step sees the task and prunes. Schemas
    // arrive in the registry's canonical (name-sorted) order.
    expect(adapter.requests[0]!.tools?.map(tool => tool.name)).toEqual(['deploy', 'read_file', 'web_search'])
    expect(adapter.requests[1]!.tools?.map(tool => tool.name)).toEqual(['read_file'])
  })

  it('exposes every tool when the catalog is too small to filter', async () => {
    const ctx = await harness({
      modelRouterEnabled: false,
      permissionEnabled: false,
      prefilterMinTools: 20,
    })
    registerTool(ctx, 'read_file', 'Read a file from the workspace')
    registerTool(ctx, 'deploy', 'Deploy the service to production')
    const adapter = new MockAdapter([toolCallResponse('c1', 'deploy', {}), textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    await waitForIdle(ctx, await prompt(ctx, 'a1', 'please read the file'))

    expect(adapter.requests[1]!.tools?.map(tool => tool.name)).toEqual(['deploy', 'read_file'])
  })

  it('leaves assemblies without an agent or tools unchanged', async () => {
    const ctx = await harness({ modelRouterEnabled: false, permissionEnabled: false })
    const withoutAgent = await ctx.systemPrompt.assemble()
    expect(withoutAgent.tools).toEqual([])

    const agent = await ctx.agentLoop.create(SessionId('empty-tools'), { provider: 'mock', model: 'mock' })
    const withoutTools = await ctx.systemPrompt.assemble({ agent })
    expect(withoutTools.tools).toEqual([])
  })
})

describe('permission judgment', () => {
  it('asks before a destructive call and, without an answerer, denies it', async () => {
    const ctx = await harness({
      modelRouterEnabled: false,
      toolPrefilterEnabled: false,
      permissionProfile: 'balanced',
    })
    registerTool(ctx, 'bash', 'Run a shell command')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', { command: 'rm -rf ./build' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await prompt(ctx, 'a1')
    await waitForIdle(ctx, agent)

    const results = toolResults(agent)
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(true)
    expect(results[0]!.text).toContain('confirmation')
  })

  it('lets an unremarkable call through', async () => {
    const ctx = await harness({
      modelRouterEnabled: false,
      toolPrefilterEnabled: false,
      permissionProfile: 'conservative',
    })
    registerTool(ctx, 'bash', 'Run a shell command')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', { command: 'ls -la' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await prompt(ctx, 'a1')
    await waitForIdle(ctx, agent)

    const results = toolResults(agent)
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(false)
  })

  it('lets an approved confirmation proceed and records why it was asked', async () => {
    const ctx = await harness({
      modelRouterEnabled: false,
      toolPrefilterEnabled: false,
      permissionProfile: 'balanced',
    })
    await ctx.plugin(ApprovalService, {})
    const asked: { toolName: string; reason: string | undefined }[] = []
    ctx.on('approval/request', async (req): Promise<ApprovalOutcome> => {
      asked.push({ toolName: req.toolName, reason: req.reason })
      return 'allowed-once'
    })
    registerTool(ctx, 'bash', 'Run a shell command')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', { command: 'rm -rf ./build' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await prompt(ctx, 'a1')
    await waitForIdle(ctx, agent)

    // The ask reached the answerer with Jev's reason, the approval let the call
    // run, and the durable audit pair carries the same reason for a reader.
    expect(asked).toHaveLength(1)
    expect(asked[0]!.toolName).toBe('bash')
    expect(asked[0]!.reason).toContain('confirmation')
    expect(toolResults(agent)[0]!.isError).toBe(false)
    const audit = agent.session.snapshotEvents()
      .filter((event): event is SessionEvent<'approval/asked'> => event.type === 'approval/asked')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.data.reason).toContain('confirmation')
  })

  it('honors a natural-language allow clause over a risk rule', async () => {
    const ctx = await harness({
      modelRouterEnabled: false,
      toolPrefilterEnabled: false,
      permissionProfile: 'conservative',
      permissionPreferences: 'Allow publishing packages without confirmation.',
    })
    registerTool(ctx, 'bash', 'Run a shell command')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', { command: 'npm publish --access public' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await prompt(ctx, 'a1')
    await waitForIdle(ctx, agent)

    expect(toolResults(agent)[0]!.isError).toBe(false)
  })

  it('never relaxes a mandatory downstream decision', async () => {
    const ctx = await harness({
      modelRouterEnabled: false,
      toolPrefilterEnabled: false,
      permissionProfile: 'autonomous',
      permissionPreferences: 'Allow running shell commands.',
    })
    // A deployment policy that DSH treats as non-overridable, mounted after Jev
    // so it sits downstream of the Jev listener in the waterfall chain.
    ctx.on('tools/pre-execute', async () => ({ kind: 'deny' as const, reason: 'sealed by deployment policy' }))
    registerTool(ctx, 'bash', 'Run a shell command')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', { command: 'rm -rf ./build' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await prompt(ctx, 'a1')
    await waitForIdle(ctx, agent)

    const results = toolResults(agent)
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(true)
    expect(results[0]!.text).toContain('sealed by deployment policy')
  })

  it('never turns a downstream ask into an allow', async () => {
    const ctx = await harness({
      modelRouterEnabled: false,
      toolPrefilterEnabled: false,
      permissionProfile: 'autonomous',
      permissionPreferences: 'Allow running shell commands.',
    })
    ctx.on('tools/pre-execute', async () => ({ kind: 'ask' as const, reason: 'needs human sign-off' }))
    registerTool(ctx, 'bash', 'Run a shell command')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', { command: 'ls -la' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await prompt(ctx, 'a1')
    await waitForIdle(ctx, agent)

    // With no answerer mounted, the preserved ask fails closed carrying the
    // downstream reason — proof Jev left the chain's decision alone.
    const results = toolResults(agent)
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(true)
    expect(results[0]!.text).toContain('needs human sign-off')
  })

  it('denies an action a critical rule rejects', async () => {
    const ctx = await harness({
      modelRouterEnabled: false,
      toolPrefilterEnabled: false,
      permissionRiskRules: [{ name: 'fatal', level: 'critical', patterns: ['drop database'] }],
    })
    registerTool(ctx, 'bash', 'Run a shell command')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', { command: 'drop database production' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await prompt(ctx, 'a1')
    await waitForIdle(ctx, agent)

    const results = toolResults(agent)
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(true)
    expect(results[0]!.text).toContain('rejects critical risk')
  })

  it('preserves registry policy for a direct execution without an agent', async () => {
    const ctx = await harness({ modelRouterEnabled: false, toolPrefilterEnabled: false })
    registerTool(ctx, 'direct', 'Run directly')

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('direct-1'),
      name: 'direct',
      arguments: {},
    })

    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'direct ran' }])
  })
})

describe('public Jev service', () => {
  const routeRequest = {
    role: 'orchestration' as const,
    candidates: [{ provider: 'deepseek', model: 'pro', name: 'Pro' }],
    preferences: { prefer: [{ pattern: 'Pro', role: 'any' as const }], avoid: [] },
    bias: 'quality' as const,
  }

  it('exposes its provider and publishes direct route decisions with and without a selection', async () => {
    const ctx = await harness({
      modelRouterEnabled: false,
      toolPrefilterEnabled: false,
      permissionEnabled: false,
    })
    const decisions: JevDecision[] = []
    ctx.on('jev/decision', (decision) => { decisions.push(decision) })

    expect(ctx.jev.providerId).toBe('heuristic')
    await expect(ctx.jev.routeModel(routeRequest)).resolves.toMatchObject({
      selection: { provider: 'deepseek', model: 'pro' },
    })
    const noCandidate = await ctx.jev.routeModel({ ...routeRequest, candidates: [] })
    expect(noCandidate.reason).toContain('no candidate models')
    expect(decisions).toMatchObject([
      { capability: 'model-router', source: 'backend', selection: { model: 'pro' } },
      { capability: 'model-router', source: 'backend' },
    ])
    expect(decisions[1]).not.toHaveProperty('selection')
  })

  it('constructs the remote provider with an environment credential', async () => {
    process.env.JEV_TEST_API_KEY = 'test-secret'
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      selection: { provider: 'deepseek', model: 'pro' },
      reason: 'remote route',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    const ctx = await harness({
      provider: 'remote',
      remoteEndpoint: 'https://jev.example/decision',
      remoteApiKeyEnv: 'JEV_TEST_API_KEY',
      modelRouterEnabled: false,
      toolPrefilterEnabled: false,
      permissionEnabled: false,
    })

    expect(ctx.jev.providerId).toBe('remote')
    await expect(ctx.jev.routeModel(routeRequest)).resolves.toMatchObject({ reason: 'remote route' })
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(url).toBe('https://jev.example/decision')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-secret')
  })

  it('uses no authorization header and reports local fallback when remote routing fails', async () => {
    const fetchImpl: typeof fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchImpl)
    const ctx = await harness({
      provider: 'remote',
      remoteEndpoint: 'https://jev.example/decision',
      modelRouterEnabled: false,
      toolPrefilterEnabled: false,
      permissionEnabled: false,
    })
    const decisions: JevDecision[] = []
    ctx.on('jev/decision', (decision) => { decisions.push(decision) })

    await expect(ctx.jev.routeModel(routeRequest)).resolves.toMatchObject({
      selection: { provider: 'deepseek', model: 'pro' },
    })
    expect(decisions[0]).toMatchObject({ provider: 'remote', source: 'local-fallback' })
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(url).toBe('https://jev.example/decision')
    expect(new Headers(init?.headers).get('authorization')).toBeNull()
  })
})

describe('configuration fails loud', () => {
  it('materializes the default risk rules when none are configured', () => {
    expect(resolveConfig({}).permissionRiskRules).not.toHaveLength(0)
  })

  it('rejects the remote provider without an endpoint', () => {
    expect(() => resolveConfig({ provider: 'remote' })).toThrow(/requires `remoteEndpoint`/)
  })

  it('rejects a half-configured route', () => {
    expect(() => resolveConfig({ orchestrationProvider: 'deepseek' })).toThrow(/requires both provider and model/)
  })

  it('rejects an avoid pattern that contradicts a configured route', () => {
    expect(() => resolveConfig({
      orchestrationProvider: 'deepseek',
      orchestrationModel: 'deepseek-v4.1-pro',
      routingAvoid: ['pro'],
    })).toThrow(/matches a routingAvoid pattern/)
  })

  it('rejects a non-positive retention floor', () => {
    expect(() => resolveConfig({ prefilterMinRetained: 0 })).toThrow(/prefilterMinRetained/)
  })

  it('rejects a removal fraction outside the unit interval', () => {
    expect(() => resolveConfig({ prefilterMaxRemovalFraction: 1.5 })).toThrow(/prefilterMaxRemovalFraction/)
  })

  it('rejects duplicate risk rule names', () => {
    expect(() => resolveConfig({
      permissionRiskRules: [
        { name: 'dup', level: 'low', patterns: ['a'] },
        { name: 'dup', level: 'high', patterns: ['b'] },
      ],
    })).toThrow(/duplicate risk rule/)
  })

  it('rejects a risk rule with no usable pattern', () => {
    expect(() => resolveConfig({
      permissionRiskRules: [{ name: 'empty', level: 'low', patterns: ['  '] }],
    })).toThrow(/at least one pattern/)
  })

  it('rejects empty rule names and unknown rule levels', () => {
    expect(() => resolveConfig({
      permissionRiskRules: [{ name: '  ', level: 'low', patterns: ['x'] }],
    })).toThrow(/needs a name/)
    expect(() => resolveConfig({
      permissionRiskRules: [{ name: 'rule', level: 'unknown', patterns: ['x'] }],
    } as unknown as Config)).toThrow(/unknown level/)
  })

  it('rejects unknown routing and permission options', () => {
    expect(() => resolveConfig({ routingBias: 'random' } as unknown as Config)).toThrow(/unknown routingBias/)
    expect(() => resolveConfig({ permissionProfile: 'reckless' } as unknown as Config)).toThrow(/unknown permissionProfile/)
  })

  it('trims list configuration and removes blank entries', () => {
    const resolved = resolveConfig({
      routingAvoid: ['  slow ', '  '],
      prefilterAlwaysKeep: [' read_* ', ''],
      permissionRiskRules: [{ name: 'rule', level: 'low', patterns: [' danger ', ''] }],
    })
    expect(resolved.routingAvoid).toEqual(['slow'])
    expect(resolved.prefilterAlwaysKeep).toEqual(['read_*'])
    expect(resolved.permissionRiskRules).toEqual([{ name: 'rule', level: 'low', patterns: ['danger'] }])
  })

  it('surfaces a schema violation through plugin load', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(JevPlugin, { provider: 'nonsense' })).rejects.toThrow()
  })

  it('is a no-op when disabled', async () => {
    const ctx = await harness({ enabled: false })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', { command: 'rm -rf ./build' }),
      textResponse('done'),
    ])
    registerTool(ctx, 'bash', 'Run a shell command')
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await prompt(ctx, 'a1')
    await waitForIdle(ctx, agent)

    expect(toolResults(agent)[0]!.isError).toBe(false)
  })
})
