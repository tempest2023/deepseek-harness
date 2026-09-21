/**
 * Decision vocabulary for the Jev bounded-judgment layer: the request and
 * decision types the three capabilities exchange with a provider, free of
 * Cordis and service imports so pure decision logic and tests can consume them.
 *
 * @module @deepseek-ai/dsh-jev/types
 */

/** One registered provider/model route. */
export interface ModelRef {
  /** Registered provider route key. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/**
 * What the current step is for. The router selects a model per role rather
 * than orchestrating arbitrary calls: `orchestration` covers understanding
 * intent, decomposition, and architectural decisions; `execution` covers
 * clearly specified subtask work once decomposition has happened.
 */
export type JevRole = 'orchestration' | 'execution'

/** Tie-break direction when several available models satisfy a preference. */
export type RoutingBias = 'quality' | 'cost' | 'latency'

/** One available model the router may select, with its display metadata. */
export interface ModelCandidate extends ModelRef {
  /** Human-readable model name, when the catalog advertises one. */
  name?: string
}

/** One natural-language preference bound to a role (or to every role). */
export interface ModelPreferenceRule {
  /** Case-insensitive substring matched against `provider/model`, the model id, and the display name. */
  pattern: string
  /** Role the preference was written for; `any` applies to every role. */
  role: JevRole | 'any'
}

/** Everything the router may consider beyond the candidate list. */
export interface ModelRoutingPreferences {
  /** Explicit model for orchestration steps, when configured. */
  orchestration?: ModelRef
  /** Explicit model for execution steps, when configured. */
  execution?: ModelRef
  /** Ordered natural-language preferences, most specific first. */
  prefer: readonly ModelPreferenceRule[]
  /** Case-insensitive substrings that disqualify a model. */
  avoid: readonly string[]
}

/** One routing question: which model should serve this step? */
export interface ModelRoutingRequest {
  /** Role of the step being routed. */
  role: JevRole
  /** Model DSH would use without routing, when one is already selected. */
  current?: ModelRef
  /** Models available to the user; empty when discovery has produced nothing yet. */
  candidates: readonly ModelCandidate[]
  /** Configured preferences constraining the decision. */
  preferences: ModelRoutingPreferences
  /** Tie-break direction among equally preferred candidates. */
  bias: RoutingBias
}

/** The router's answer. An absent `selection` means "no opinion — keep DSH's own choice". */
export interface ModelRoutingDecision {
  /** Chosen route, or undefined when the router declines to override. */
  selection?: ModelRef
  /** Human-readable explanation, surfaced through observability only. */
  reason: string
}

/** One tool the pre-filter may retain or drop. */
export interface ToolCandidate {
  /** Registered tool name. */
  name: string
  /** Model-facing description text. */
  description: string
}

/** One pre-filter question: which of these tools are plausibly relevant now? */
export interface ToolFilterRequest {
  /** Observed task text; undefined when no context is available yet. */
  task?: string
  /** Every currently assemblable tool. */
  tools: readonly ToolCandidate[]
  /** Tool-name patterns that must survive filtering regardless of score. */
  alwaysKeep: readonly string[]
  /** Filtering is skipped entirely below this tool count. */
  minToolsToFilter: number
  /** Filtering is skipped when it would leave fewer than this many tools. */
  minRetained: number
  /** Filtering is skipped when it would remove more than this fraction of tools. */
  maxRemovalFraction: number
}

/** The pre-filter's answer. `keep: undefined` means "no opinion — expose every tool". */
export interface ToolFilterDecision {
  /** Retained tool names, or undefined when the filter declines to prune. */
  keep?: string[]
  /** Human-readable explanation, surfaced through observability only. */
  reason: string
}

/** Risk severity, ordered from least to most severe. */
export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical'

/** Every risk level in ascending severity order; index doubles as the comparison rank. */
export const RISK_LEVELS: readonly RiskLevel[] = ['none', 'low', 'medium', 'high', 'critical']

/**
 * One named, configurable risk rule: a subject area and the literal text
 * patterns whose presence in a proposed action suggests that area is touched.
 */
export interface RiskRule {
  /** Stable rule name, named in the judgment reason and decision event. */
  name: string
  /** Severity this rule assigns when it matches. */
  level: RiskLevel
  /** Case-insensitive literal substrings; matching is substring, never regex. */
  patterns: string[]
}

/** User-facing autonomy profile. */
export type PermissionProfile = 'conservative' | 'balanced' | 'autonomous'

/** The permission outcome a judgment asks DSH to enforce. */
export type PermissionOutcome = 'allow' | 'ask' | 'deny'

/** One natural-language permission clause. */
export interface PermissionClause {
  /** Outcome the clause asks for. */
  outcome: PermissionOutcome
  /** Significant lowercase keywords extracted from the clause text. */
  keywords: readonly string[]
}

/** One permission question about a proposed tool call. */
export interface PermissionRequest {
  /** Tool the model asked to call. */
  toolName: string
  /** Parsed arguments of the proposed call. */
  arguments: unknown
  /** Configured autonomy profile. */
  profile: PermissionProfile
  /** Configurable risk rules. */
  riskRules: readonly RiskRule[]
  /** Ordered natural-language clauses; later, more specific clauses win. */
  clauses: readonly PermissionClause[]
}

/** The permission layer's answer. */
export interface PermissionJudgment {
  /** Outcome to enforce; `allow` leaves DSH's own decision untouched. */
  outcome: PermissionOutcome
  /** Highest rule severity observed, or `none`. */
  level: RiskLevel
  /** Matched risk-rule names and clause keywords, most specific first. */
  signals: readonly string[]
  /** Human-readable explanation, carried into `approval/asked` for asks. */
  reason: string
}

/**
 * One bounded-judgment backend. Every method answers a single closed question
 * and returns a decision; implementations never execute tools, generate
 * arguments, or drive the agent loop.
 */
export interface JevProvider {
  /** Identify the provider in decision events. */
  readonly id: string
  /**
   * Choose a model for one step.
   * @param request - role, current selection, candidates, preferences, and bias.
   * @param signal - cancellation owned by the calling capability, when one exists.
   * @returns the routing decision.
   */
  routeModel(request: ModelRoutingRequest, signal?: AbortSignal): Promise<ModelRoutingDecision>
  /**
   * Choose which candidate tools stay exposed to the primary model.
   * @param request - task text, candidate tools, and retention bounds.
   * @param signal - cancellation owned by the calling capability, when one exists.
   * @returns the filtering decision.
   */
  filterTools(request: ToolFilterRequest, signal?: AbortSignal): Promise<ToolFilterDecision>
  /**
   * Judge one proposed tool call against configured permissions.
   * @param request - the action, profile, risk rules, and clauses.
   * @param signal - cancellation owned by the calling capability, when one exists.
   * @returns the permission judgment.
   */
  judgePermission(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionJudgment>
}
