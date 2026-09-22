/**
 * The Jev plugin for DeepSeek Harness: a bounded-judgment layer for model
 * routing, tool pre-filtering, and contextual permission judgment.
 *
 * Jev never replaces the LLM. It answers three closed questions — which
 * available model should serve this step, which tools are plausibly relevant,
 * and whether a proposed action should proceed, ask, or be rejected — while
 * DSH keeps orchestration, enforcement, and final control. Every capability is
 * independently switchable, and the plugin degrades to a no-op when disabled
 * or when its configured backend is unreachable.
 *
 * Runtime wiring:
 * - model routing installs a per-agent selection through
 *   `installModelSelection` and refines it at each `agent/pre-step`;
 * - tool pre-filtering narrows `assembly.tools` in the
 *   `system-prompt/assemble` waterfall, after every other contributor has run;
 * - permission judgment observes `tools/pre-execute` and may only *tighten*
 *   the chain's decision, never relax a downstream deny, and never turn a
 *   downstream ask into an allow.
 *
 * @module @deepseek-ai/dsh-jev
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { createHeuristicProvider } from './heuristic-provider.ts'
import { publishDecision } from './observability.ts'
import type { JevDecision } from './observability.ts'
import { parseModelPreferences, parsePermissionClauses } from './preferences.ts'
import { createRemoteProvider, REMOTE_PROVIDER_ID } from './remote-provider.ts'
import { routeModel } from './router.ts'
import { RISK_LEVELS } from './types.ts'
import type {
  JevProvider,
  JevRole,
  ModelCandidate,
  ModelRef,
  ModelRoutingDecision,
  ModelRoutingPreferences,
  ModelRoutingRequest,
  PermissionJudgment,
  PermissionProfile,
  PermissionRequest,
  RiskRule,
  RoutingBias,
  ToolFilterDecision,
  ToolFilterRequest,
} from './types.ts'

export * from './types.ts'
export { parseModelPreferences, parsePermissionClauses } from './preferences.ts'
export { routeModel, rankCandidate } from './router.ts'
export { selectTools } from './tool-filter.ts'
export { assessRisk, describeAction, judgePermission } from './permission.ts'
export { createHeuristicProvider, HEURISTIC_PROVIDER_ID } from './heuristic-provider.ts'
export { createRemoteProvider, REMOTE_PROVIDER_ID } from './remote-provider.ts'
export { publishDecision } from './observability.ts'
export type { JevAnswerSource, JevCapability, JevDecision } from './observability.ts'
export { matchesAny, tokenize, tokensAgree } from './text.ts'

/** Selectable Jev backends. */
export const JEV_PROVIDERS: readonly string[] = ['heuristic', 'remote']

/** Selectable model-routing biases. */
export const ROUTING_BIASES: readonly RoutingBias[] = ['quality', 'cost', 'latency']

/** Selectable autonomy profiles. */
export const PERMISSION_PROFILES: readonly PermissionProfile[] = ['conservative', 'balanced', 'autonomous']

/**
 * Default risk rules. Every rule is a configurable field rather than a hidden
 * constant: a deployment changes any of them from `cordis.yml`. No default
 * rule is `critical`, so the default profiles never hard-reject an action —
 * denial is opt-in by promoting a rule to `critical`.
 */
export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  {
    name: 'destructive',
    level: 'high',
    patterns: ['rm -rf', 'rm -f', 'drop table', 'truncate', 'reset --hard', 'force push', '--force'],
  },
  {
    name: 'credentials',
    level: 'high',
    patterns: ['.env', 'credential', 'api key', 'api_key', 'apikey', 'secret', 'password', 'private key', 'access token'],
  },
  {
    name: 'irreversible',
    level: 'medium',
    patterns: ['uninstall', 'wipe', 'purge', 'overwrite', 'chmod 777', 'kill -9'],
  },
  {
    name: 'scope',
    level: 'medium',
    patterns: ['chmod -r', 'chown -r', 'recursive', 'find . -delete', 'git clean -xdf', '/etc/', '/usr/', 'system32'],
  },
  {
    name: 'external',
    level: 'medium',
    patterns: ['npm publish', 'deploy', 'upload', 'git push', 'publish', 'send email'],
  },
  {
    name: 'financial',
    level: 'low',
    patterns: ['purchase', 'payment', 'checkout', 'billing', 'subscription', 'transfer funds'],
  },
]

/**
 * Plugin configuration. Every field is optional and validated at load;
 * misconfiguration fails loud rather than silently degrading.
 */
export interface Config {
  /** Master switch; `false` makes the plugin a no-op. */
  enabled?: boolean
  /** Which bounded-judgment backend answers decisions. */
  provider?: string
  /** Absolute HTTP(S) endpoint for the `remote` backend. */
  remoteEndpoint?: string
  /** Environment variable holding the backend credential, when it needs one. */
  remoteApiKeyEnv?: string
  /** Per-call deadline for the `remote` backend, in milliseconds. */
  remoteTimeoutMs?: number
  /** Enable model routing. */
  modelRouterEnabled?: boolean
  /** Model routing selects this provider for orchestration steps. */
  orchestrationProvider?: string
  /** Model routing selects this model for orchestration steps. */
  orchestrationModel?: string
  /** Model routing selects this provider for execution steps. */
  executionProvider?: string
  /** Model routing selects this model for execution steps. */
  executionModel?: string
  /** Tie-break direction when several available models satisfy a preference. */
  routingBias?: RoutingBias
  /** Natural-language model preferences. */
  routingPreferences?: string
  /** Literal substrings that disqualify a model from selection. */
  routingAvoid?: string[]
  /** Route main-agent steps after the first to the execution model. */
  preferExecutionForRoutineSteps?: boolean
  /** How long a discovered model catalog stays fresh, in milliseconds. */
  modelDiscoveryTtlMs?: number
  /** Enable tool pre-filtering. */
  toolPrefilterEnabled?: boolean
  /** Below this tool count, filtering is skipped entirely. */
  prefilterMinTools?: number
  /** Skip filtering when it would leave fewer than this many tools. */
  prefilterMinRetained?: number
  /** Skip filtering when it would remove more than this fraction of tools. */
  prefilterMaxRemovalFraction?: number
  /** Tool-name wildcard patterns that must always survive filtering. */
  prefilterAlwaysKeep?: string[]
  /** How many recent conversation messages describe the current task. */
  toolFilterTaskMessages?: number
  /** Enable permission judgment. */
  permissionEnabled?: boolean
  /** Autonomy profile used when no prose clause applies. */
  permissionProfile?: PermissionProfile
  /** Natural-language permission preferences. */
  permissionPreferences?: string
  /** Risk rules the profile thresholds are applied to. */
  permissionRiskRules?: RiskRule[]
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().default('heuristic'),
  remoteEndpoint: z.string(),
  remoteApiKeyEnv: z.string(),
  remoteTimeoutMs: z.number().default(2000),
  modelRouterEnabled: z.boolean().default(true),
  orchestrationProvider: z.string(),
  orchestrationModel: z.string(),
  executionProvider: z.string(),
  executionModel: z.string(),
  routingBias: z.union(ROUTING_BIASES).default('quality'),
  routingPreferences: z.string(),
  routingAvoid: z.array(z.string()).default([]),
  preferExecutionForRoutineSteps: z.boolean().default(false),
  modelDiscoveryTtlMs: z.number().default(300_000),
  toolPrefilterEnabled: z.boolean().default(true),
  prefilterMinTools: z.number().default(8),
  prefilterMinRetained: z.number().default(4),
  prefilterMaxRemovalFraction: z.number().default(0.5),
  prefilterAlwaysKeep: z.array(z.string()).default([]),
  toolFilterTaskMessages: z.number().default(3),
  permissionEnabled: z.boolean().default(true),
  permissionProfile: z.union(PERMISSION_PROFILES).default('balanced'),
  permissionPreferences: z.string(),
  permissionRiskRules: z.array(z.object({
    name: z.string().required(),
    level: z.union(RISK_LEVELS).required(),
    patterns: z.array(z.string()).required(),
  })).default([...DEFAULT_RISK_RULES]),
})

/** {@link Config} with every default materialized and every value validated. */
export interface ResolvedConfig {
  enabled: boolean
  provider: string
  remoteEndpoint: string | undefined
  remoteApiKeyEnv: string | undefined
  remoteTimeoutMs: number
  modelRouterEnabled: boolean
  orchestration: ModelRef | undefined
  execution: ModelRef | undefined
  routingBias: RoutingBias
  routingPreferences: string | undefined
  routingAvoid: readonly string[]
  preferExecutionForRoutineSteps: boolean
  modelDiscoveryTtlMs: number
  toolPrefilterEnabled: boolean
  prefilterMinTools: number
  prefilterMinRetained: number
  prefilterMaxRemovalFraction: number
  prefilterAlwaysKeep: readonly string[]
  toolFilterTaskMessages: number
  permissionEnabled: boolean
  permissionProfile: PermissionProfile
  permissionPreferences: string | undefined
  permissionRiskRules: readonly RiskRule[]
}

/** Require a positive integer config value. */
function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`jev: \`${field}\` must be a positive integer, received ${String(value)}`)
  }
  return value
}

/** Require a unit-interval config value. */
function requireUnitFraction(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`jev: \`${field}\` must be a number between 0 and 1, received ${String(value)}`)
  }
  return value
}

/** Resolve one optional provider/model pair, failing loud on a half-configured route. */
function resolveRoute(
  provider: string | undefined,
  model: string | undefined,
  role: string,
): ModelRef | undefined {
  if (provider === undefined && model === undefined) return undefined
  if (provider === undefined || model === undefined) {
    throw new Error(`jev: the ${role} route requires both provider and model`)
  }
  return { provider, model }
}

/** Validate one risk rule list, failing loud on duplicates and empty patterns. */
function resolveRiskRules(rules: readonly RiskRule[]): RiskRule[] {
  const seen = new Set<string>()
  return rules.map((rule) => {
    if (rule.name.trim().length === 0) throw new Error('jev: every risk rule needs a name')
    if (seen.has(rule.name)) throw new Error(`jev: duplicate risk rule name "${rule.name}"`)
    seen.add(rule.name)
    if (!RISK_LEVELS.includes(rule.level)) {
      throw new Error(`jev: risk rule "${rule.name}" has unknown level "${rule.level}"`)
    }
    const patterns = rule.patterns.map(pattern => pattern.trim()).filter(pattern => pattern.length > 0)
    if (patterns.length === 0) throw new Error(`jev: risk rule "${rule.name}" needs at least one pattern`)
    return { name: rule.name, level: rule.level, patterns }
  })
}

/**
 * Validate raw configuration and materialize every default.
 * @param config - the raw validated config from cordis.
 * @returns the fully resolved configuration.
 * @throws when a value is contradictory or unusable.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const provider = config.provider ?? 'heuristic'
  if (!JEV_PROVIDERS.includes(provider)) {
    throw new Error(`jev: unknown provider "${provider}"; expected one of ${JEV_PROVIDERS.join(', ')}`)
  }
  if (provider === REMOTE_PROVIDER_ID && (config.remoteEndpoint ?? '').trim().length === 0) {
    throw new Error('jev: provider "remote" requires `remoteEndpoint`')
  }
  const routingBias = config.routingBias ?? 'quality'
  if (!ROUTING_BIASES.includes(routingBias)) {
    throw new Error(`jev: unknown routingBias "${routingBias}"; expected one of ${ROUTING_BIASES.join(', ')}`)
  }
  const permissionProfile = config.permissionProfile ?? 'balanced'
  if (!PERMISSION_PROFILES.includes(permissionProfile)) {
    throw new Error(`jev: unknown permissionProfile "${permissionProfile}"; expected one of ${PERMISSION_PROFILES.join(', ')}`)
  }
  const orchestration = resolveRoute(config.orchestrationProvider, config.orchestrationModel, 'orchestration')
  const execution = resolveRoute(config.executionProvider, config.executionModel, 'execution')
  const routingAvoid = (config.routingAvoid ?? []).map(pattern => pattern.trim()).filter(pattern => pattern.length > 0)
  for (const [role, route] of [['orchestration', orchestration], ['execution', execution]] as const) {
    if (route === undefined) continue
    const needles = [`${route.provider}/${route.model}`, route.model]
    if (needles.some(needle => routingAvoid.some(pattern => needle.toLowerCase().includes(pattern.toLowerCase())))) {
      throw new Error(`jev: the configured ${role} route ${route.provider}/${route.model} matches a routingAvoid pattern`)
    }
  }
  return {
    enabled: config.enabled ?? true,
    provider,
    remoteEndpoint: config.remoteEndpoint,
    remoteApiKeyEnv: config.remoteApiKeyEnv,
    remoteTimeoutMs: requirePositiveInteger(config.remoteTimeoutMs ?? 2000, 'remoteTimeoutMs'),
    modelRouterEnabled: config.modelRouterEnabled ?? true,
    orchestration,
    execution,
    routingBias,
    routingPreferences: config.routingPreferences,
    routingAvoid,
    preferExecutionForRoutineSteps: config.preferExecutionForRoutineSteps ?? false,
    modelDiscoveryTtlMs: requirePositiveInteger(config.modelDiscoveryTtlMs ?? 300_000, 'modelDiscoveryTtlMs'),
    toolPrefilterEnabled: config.toolPrefilterEnabled ?? true,
    prefilterMinTools: requirePositiveInteger(config.prefilterMinTools ?? 8, 'prefilterMinTools'),
    prefilterMinRetained: requirePositiveInteger(config.prefilterMinRetained ?? 4, 'prefilterMinRetained'),
    prefilterMaxRemovalFraction: requireUnitFraction(config.prefilterMaxRemovalFraction ?? 0.5, 'prefilterMaxRemovalFraction'),
    prefilterAlwaysKeep: (config.prefilterAlwaysKeep ?? []).map(pattern => pattern.trim()).filter(pattern => pattern.length > 0),
    toolFilterTaskMessages: requirePositiveInteger(config.toolFilterTaskMessages ?? 3, 'toolFilterTaskMessages'),
    permissionEnabled: config.permissionEnabled ?? true,
    permissionProfile,
    permissionPreferences: config.permissionPreferences,
    permissionRiskRules: resolveRiskRules(config.permissionRiskRules ?? DEFAULT_RISK_RULES),
  }
}

/** Collect the text carried by a message's content blocks. */
function blocksText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Read the most recent conversation text describing what the agent is doing.
 * The pre-filter needs a task signal, and the session log is its only
 * model-visible source.
 * @param agent - the agent whose log is read.
 * @param limit - maximum number of recent messages to include.
 * @returns the joined text, or undefined when the log holds none yet.
 */
export function taskText(agent: Agent, limit: number): string | undefined {
  const texts = agent.session.deriveMessages()
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => blocksText(message.content))
    .filter(text => text.trim().length > 0)
    .slice(-limit)
  return texts.length === 0 ? undefined : texts.join('\n')
}

/**
 * Classify the role of one step.
 *
 * Delegation depth is the primary signal: a top-level agent plans, and a
 * delegated child executes — exactly the workflow the PRD describes.
 * `preferExecutionForRoutineSteps` optionally extends that to later steps of a
 * top-level turn.
 * @param agent - the agent the step belongs to.
 * @param step - the step being routed; undefined when routing at creation.
 * @param preferExecutionForRoutineSteps - whether later steps use the execution role.
 * @returns the role of the step.
 */
export function roleFor(
  agent: Agent,
  step: number | undefined,
  preferExecutionForRoutineSteps: boolean,
): JevRole {
  if ((agent.session.header.delegationDepth ?? 0) > 0) return 'execution'
  if (preferExecutionForRoutineSteps && step !== undefined && step > 1) return 'execution'
  return 'orchestration'
}

/** A lazily refreshed, best-effort catalog of the models this deployment exposes. */
interface ModelCatalog {
  /** Read the currently known models, triggering a background refresh when stale. */
  list(): ModelCandidate[]
}

/**
 * Build the discovery catalog. Discovery is advisory — an unreachable or
 * unconfigured provider simply contributes nothing, and a failed refresh keeps
 * the previous list.
 * @param ctx - context used to reach the LLM registry.
 * @param ttlMs - how long a discovered list stays fresh.
 * @returns the catalog.
 */
function createModelCatalog(ctx: Context, ttlMs: number): ModelCatalog {
  let models: ModelCandidate[] = []
  let refreshedAt = 0
  let refreshing = false
  async function refresh(): Promise<void> {
    const llm = ctx.get('llm')
    if (llm === undefined) return
    const discovered: ModelCandidate[] = []
    for (const provider of llm.listProviders()) {
      try {
        for (const model of await llm.listModels(provider.id)) {
          discovered.push({ provider: provider.id, model: model.id, name: model.name })
        }
      } catch {
        // Advisory only: one unreachable provider must not empty the catalog.
      }
    }
    models = discovered
    refreshedAt = Date.now()
  }
  return {
    list(): ModelCandidate[] {
      if (!refreshing && Date.now() - refreshedAt >= ttlMs) {
        refreshing = true
        void refresh().catch(() => {}).finally(() => { refreshing = false })
      }
      return models
    },
  }
}

/** Detail fields a published decision may carry beyond its reason; undefined means absent. */
interface JevDecisionDetail {
  selection?: ModelRef | undefined
  keep?: string[] | undefined
  outcome?: 'allow' | 'ask' | 'deny' | undefined
}

/**
 * The Jev service. It owns the configured backend, exposes the three bounded
 * decisions to any consumer, and installs the capability wiring for whichever
 * capabilities the configuration enables.
 */
export class JevPlugin extends Service {
  /** Plugin configuration schema, validated by cordis before construction. */
  static Config: z<Config> = Config

  /** Fully resolved configuration. */
  readonly resolved: ResolvedConfig

  private readonly provider: JevProvider
  private readonly catalog: ModelCatalog
  private fallbacks = 0

  /**
   * @param ctx - the plugin context this service is registered on.
   * @param config - raw configuration, validated by {@link resolveConfig}.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'jev')
    this.resolved = resolveConfig(config)
    const heuristic = createHeuristicProvider()
    if (this.resolved.provider === REMOTE_PROVIDER_ID) {
      const apiKeyEnv = this.resolved.remoteApiKeyEnv
      const apiKey = apiKeyEnv === undefined ? undefined : process.env[apiKeyEnv]
      this.provider = createRemoteProvider({
        endpoint: this.resolved.remoteEndpoint as string,
        ...apiKey === undefined ? {} : { apiKey },
        timeoutMs: this.resolved.remoteTimeoutMs,
        fallback: heuristic,
        onFallback: () => { this.fallbacks += 1 },
      })
    } else {
      this.provider = heuristic
    }
    this.catalog = createModelCatalog(ctx, this.resolved.modelDiscoveryTtlMs)
    if (!this.resolved.enabled) return
    if (this.resolved.modelRouterEnabled) this.installModelRouter()
    if (this.resolved.toolPrefilterEnabled) this.installToolPrefilter()
    if (this.resolved.permissionEnabled) this.installPermissionLayer()
  }

  /** Provider id answering decisions. */
  get providerId(): string {
    return this.provider.id
  }

  /**
   * Answer one model-routing question and publish the decision.
   * @param request - the routing question.
   * @param signal - cancellation owned by the caller.
   * @returns the routing decision.
   */
  async routeModel(request: ModelRoutingRequest, signal?: AbortSignal): Promise<ModelRoutingDecision> {
    return this.answer('model-router', () => this.provider.routeModel(request, signal), decision => ({ selection: decision.selection }))
  }

  /**
   * Answer one tool pre-filtering question and publish the decision.
   * @param request - the filtering question.
   * @param signal - cancellation owned by the caller.
   * @returns the filtering decision.
   */
  async filterTools(request: ToolFilterRequest, signal?: AbortSignal): Promise<ToolFilterDecision> {
    return this.answer('tool-prefilter', () => this.provider.filterTools(request, signal), decision => ({ keep: decision.keep }))
  }

  /**
   * Answer one permission question and publish the decision.
   * @param request - the permission question.
   * @param signal - cancellation owned by the caller.
   * @returns the permission judgment.
   */
  async judgePermission(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionJudgment> {
    return this.answer('permission', () => this.provider.judgePermission(request, signal), judgment => ({ outcome: judgment.outcome }))
  }

  /** Delegate one decision, publish it, and attach the chosen detail field. */
  private async answer<T extends { reason: string }>(
    capability: JevDecision['capability'],
    run: () => Promise<T>,
    detail: (value: T) => JevDecisionDetail,
  ): Promise<T> {
    const before = this.fallbacks
    const value = await run()
    const extra = detail(value)
    const decision: JevDecision = {
      capability,
      provider: this.provider.id,
      source: this.fallbacks > before ? 'local-fallback' : 'backend',
      reason: value.reason,
      ...extra.selection === undefined ? {} : { selection: extra.selection },
      ...extra.keep === undefined ? {} : { keep: extra.keep },
      ...extra.outcome === undefined ? {} : { outcome: extra.outcome },
    }
    publishDecision(this.ctx, decision)
    return value
  }

  /** Install per-agent routing: an initial selection plus per-step refinement. */
  private installModelRouter(): void {
    const parsed = parseModelPreferences(this.resolved.routingPreferences)
    const preferences: ModelRoutingPreferences = {
      ...this.resolved.orchestration === undefined ? {} : { orchestration: this.resolved.orchestration },
      ...this.resolved.execution === undefined ? {} : { execution: this.resolved.execution },
      prefer: parsed.prefer,
      avoid: [...this.resolved.routingAvoid, ...parsed.avoid],
    }
    this.ctx.on('agent/created', ({ agent }) => {
      const ref: ModelSelectionRef = { current: undefined, assembled: undefined }
      ref.current = this.selectionFor(agent, undefined, preferences)
      installModelSelection(agent.ctx, ref)
      // The step being prepared has already assembled its prompt, so this
      // handler routes the NEXT step: computing `step + 1` here keeps the
      // selection exactly one step ahead instead of one step behind.
      agent.ctx.on('agent/pre-step', async ({ step }, next) => {
        const upcoming = this.selectionFor(agent, step + 1, preferences)
        if (upcoming !== undefined) ref.current = upcoming
        return next()
      })
    })
  }

  /** Route one selection for an agent, publishing the decision. */
  private selectionFor(
    agent: Agent,
    step: number | undefined,
    preferences: ModelRoutingPreferences,
  ): ModelSelection | undefined {
    const role = roleFor(agent, step, this.resolved.preferExecutionForRoutineSteps)
    const current = agent.options.provider === undefined || agent.options.model === undefined
      ? undefined
      : { provider: agent.options.provider, model: agent.options.model }
    const decision = routeModel({
      role,
      ...current === undefined ? {} : { current },
      candidates: this.catalog.list(),
      preferences,
      bias: this.resolved.routingBias,
    })
    publishDecision(this.ctx, {
      capability: 'model-router',
      provider: this.provider.id,
      source: 'backend',
      reason: decision.reason,
      agentId: agent.id,
      ...decision.selection === undefined ? {} : { selection: decision.selection },
    })
    return decision.selection
  }

  /** Install the tool pre-filter inside prompt assembly. */
  private installToolPrefilter(): void {
    const alwaysKeep = [...this.resolved.prefilterAlwaysKeep, RUN_CODE_NAME]
    this.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const resolved: PromptAssembly = await next()
      const agent = context.agent
      if (agent === undefined || resolved.tools.length === 0) return resolved
      const task = taskText(agent, this.resolved.toolFilterTaskMessages)
      const decision = await this.filterTools({
        ...task === undefined ? {} : { task },
        tools: resolved.tools.map(tool => ({ name: tool.name, description: tool.description })),
        alwaysKeep,
        minToolsToFilter: this.resolved.prefilterMinTools,
        minRetained: this.resolved.prefilterMinRetained,
        maxRemovalFraction: this.resolved.prefilterMaxRemovalFraction,
      })
      if (decision.keep === undefined) return resolved
      const keep = new Set(decision.keep)
      return { ...resolved, tools: resolved.tools.filter(tool => keep.has(tool.name)) }
    })
  }

  /** Install permission judgment as a tightening-only pre-execute listener. */
  private installPermissionLayer(): void {
    const clauses = parsePermissionClauses(this.resolved.permissionPreferences)
    this.ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const downstream = await next()
      // Direct executions have no agent and no answerer to ask, so they keep
      // the registry's own policy exactly as it was.
      if (exec.agent === undefined) return downstream
      const judgment = await this.judgePermission({
        toolName: exec.name,
        arguments: exec.arguments,
        profile: this.resolved.permissionProfile,
        riskRules: this.resolved.permissionRiskRules,
        clauses,
      }, exec.signal)
      if (judgment.outcome === 'allow') return downstream
      // Escalation only: a mandatory downstream deny is never relaxed, and an
      // existing ask already carries its own reason.
      if (judgment.outcome === 'deny' && downstream.kind !== 'deny') {
        return { kind: 'deny', reason: judgment.reason }
      }
      if (judgment.outcome === 'ask' && downstream.kind === 'allow') {
        return { kind: 'ask', reason: judgment.reason }
      }
      return downstream
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Jev bounded-judgment service. */
    jev: JevPlugin
  }
}

export default JevPlugin
