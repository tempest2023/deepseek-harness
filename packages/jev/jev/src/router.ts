/**
 * The Jev model router: a pure function that answers one bounded question —
 * which available model should serve this step — without calling a model,
 * generating arguments, or driving the agent loop.
 *
 * Precedence, highest first:
 * 1. an explicit per-role model from configuration;
 * 2. leaving an avoided model that DSH would otherwise use;
 * 3. the first matching natural-language preference for the step's role;
 * 4. no opinion, which leaves DSH's own selection untouched.
 *
 * The router never invents a model: every selection names a candidate from the
 * supplied catalog or an explicitly configured route.
 *
 * @module @deepseek-ai/dsh-jev/router
 */

import { containsLiteral } from './text.ts'
import type {
  ModelCandidate,
  ModelRef,
  ModelRoutingDecision,
  ModelRoutingRequest,
  RoutingBias,
} from './types.ts'

/** Model-name tokens that suggest a large, capable model. */
const CAPABILITY_TOKENS: readonly string[] = [
  'pro', 'max', 'opus', 'ultra', 'thinking', 'reasoner', 'reasoning', 'large', 'plus',
]

/** Model-name tokens that suggest a small, cheap, fast model. */
const ECONOMY_TOKENS: readonly string[] = [
  'flash', 'lite', 'mini', 'small', 'nano', 'fast', 'turbo', 'air', 'micro',
]

/** Every text form a pattern may match for one candidate. */
function candidateNeedles(candidate: ModelCandidate): string[] {
  return [
    `${candidate.provider}/${candidate.model}`,
    candidate.model,
    ...candidate.name === undefined ? [] : [candidate.name],
  ]
}

/**
 * Rank a candidate for tie-breaking. Equal ranks keep catalog order, so the
 * function stays deterministic for a deterministic catalog.
 * @param candidate - the candidate to rank.
 * @param bias - desired direction.
 * @returns a numeric rank where higher is better for the requested bias.
 */
export function rankCandidate(candidate: ModelCandidate, bias: RoutingBias): number {
  const haystack = candidateNeedles(candidate).join(' ').toLowerCase()
  const capability = CAPABILITY_TOKENS.filter(token => haystack.includes(token)).length
  const economy = ECONOMY_TOKENS.filter(token => haystack.includes(token)).length
  const tier = capability - economy
  return bias === 'quality' ? tier : -tier
}

/** Whether a candidate matches one configured avoid pattern. */
function isAvoided(candidate: ModelCandidate, avoid: readonly string[]): boolean {
  return candidateNeedles(candidate).some(needle =>
    avoid.some(pattern => containsLiteral(needle, pattern)),
  )
}

/** Whether a candidate matches one preference pattern. */
function matchesPattern(candidate: ModelCandidate, pattern: string): boolean {
  return candidateNeedles(candidate).some(needle => containsLiteral(needle, pattern))
}

/** Refine an array after the router has proved it contains a candidate. */
function isNonEmpty<T>(values: readonly T[]): values is readonly [T, ...T[]] {
  return values.length > 0
}

/** Pick the best candidate under the configured bias, or undefined for an empty list. */
function selectBest(
  candidates: readonly [ModelCandidate, ...ModelCandidate[]],
  bias: RoutingBias,
): ModelCandidate
function selectBest(
  candidates: readonly ModelCandidate[],
  bias: RoutingBias,
): ModelCandidate | undefined
function selectBest(
  candidates: readonly ModelCandidate[],
  bias: RoutingBias,
): ModelCandidate | undefined {
  let best: ModelCandidate | undefined
  let bestRank = Number.NEGATIVE_INFINITY
  for (const candidate of candidates) {
    const rank = rankCandidate(candidate, bias)
    if (rank > bestRank) {
      best = candidate
      bestRank = rank
    }
  }
  return best
}

/** Project a candidate onto the public selection type. */
function ref(candidate: ModelCandidate): ModelRef {
  return { provider: candidate.provider, model: candidate.model }
}

/** Whether two selections name the same route. */
function sameRoute(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
  return left !== undefined && right !== undefined
    && left.provider === right.provider && left.model === right.model
}

/**
 * Choose a model for one step.
 * @param request - role, current selection, candidate catalog, preferences, and bias.
 * @returns the routing decision; `selection` is absent when the router has no opinion.
 */
export function routeModel(request: ModelRoutingRequest): ModelRoutingDecision {
  const { role, current, candidates, preferences, bias } = request
  const preferred = role === 'orchestration' ? preferences.orchestration : preferences.execution
  if (preferred !== undefined) {
    if (sameRoute(preferred, current)) {
      return { selection: preferred, reason: `configured ${role} model is already selected` }
    }
    return { selection: preferred, reason: `configured ${role} model` }
  }

  const usable = candidates.filter(candidate => !isAvoided(candidate, preferences.avoid))
  if (!isNonEmpty(usable)) {
    return {
      reason: candidates.length === 0
        ? 'no candidate models available; keeping DSH selection'
        : 'every known candidate is excluded by avoid patterns; keeping DSH selection',
    }
  }

  if (current !== undefined && isAvoided({ ...current }, preferences.avoid)) {
    const replacement = selectBest(
      usable.filter(candidate => matchesPatternForRole(candidate, role, preferences.prefer)),
      bias,
    ) ?? selectBest(usable, bias)
    return { selection: ref(replacement), reason: `current model matches an avoid pattern; replaced with ${role} default` }
  }

  for (const rule of preferences.prefer) {
    if (rule.role !== 'any' && rule.role !== role) continue
    const matched = usable.filter(candidate => matchesPattern(candidate, rule.pattern))
    if (matched.length === 0) continue
    const chosen = selectBest(matched, bias) as ModelCandidate
    if (sameRoute(chosen, current)) {
      return { selection: ref(chosen), reason: `preferred model "${rule.pattern}" already selected` }
    }
    return { selection: ref(chosen), reason: `preferred model "${rule.pattern}" for ${role}` }
  }

  return { reason: 'no configured preference matched; keeping DSH selection' }
}

/** Whether a candidate satisfies any role-eligible preference rule. */
function matchesPatternForRole(
  candidate: ModelCandidate,
  role: ModelRoutingRequest['role'],
  rules: ModelRoutingRequest['preferences']['prefer'],
): boolean {
  return rules.some(rule => (rule.role === 'any' || rule.role === role) && matchesPattern(candidate, rule.pattern))
}
