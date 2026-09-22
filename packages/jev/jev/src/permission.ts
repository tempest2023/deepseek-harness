/**
 * The Jev permission layer: a pure, contextual judgment about one proposed
 * tool call. It answers only "allow / ask / deny" and never enforces, so DSH
 * keeps final control.
 *
 * Judgment precedence, highest first:
 * 1. a matching `deny` clause from the user's prose;
 * 2. a matching `ask` clause;
 * 3. a matching `allow` clause;
 * 4. the autonomy profile's thresholds against the highest matched risk rule.
 *
 * Because the profile decides only the outcome for a matched risk signal, an
 * unrecognized or unremarkable action is allowed. That is deliberate: the PRD
 * optimizes against unnecessary interruptions, and risk rules are the
 * configurable place to say which actions deserve attention.
 *
 * @module @deepseek-ai/dsh-jev/permission
 */

import { tokenize, tokensAgree, containsLiteral } from './text.ts'
import { RISK_LEVELS } from './types.ts'
import type {
  PermissionClause,
  PermissionJudgment,
  PermissionOutcome,
  PermissionProfile,
  PermissionRequest,
  RiskLevel,
  RiskRule,
} from './types.ts'

/** How much of a proposed action's arguments is searched and quoted. */
const ACTION_TEXT_LIMIT = 4000

/**
 * Outcome thresholds for each profile. These define the user-facing profiles
 * rather than being deployment tunables: `conservative` asks as soon as any
 * risk is visible, `autonomous` interrupts only for high severity, and every
 * profile rejects the most severe actions.
 */
const PROFILE_THRESHOLDS: Record<PermissionProfile, { askAt: RiskLevel; denyAt: RiskLevel }> = {
  conservative: { askAt: 'low', denyAt: 'critical' },
  balanced: { askAt: 'medium', denyAt: 'critical' },
  autonomous: { askAt: 'high', denyAt: 'critical' },
}

/** Rank a risk level for comparison. */
function levelRank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level)
}

/**
 * Render one proposed call as a single searchable string: the tool name
 * followed by its serialized arguments, capped so a large payload cannot
 * dominate matching or the decision reason.
 * @param toolName - the tool the model asked to call.
 * @param args - the parsed arguments of that call.
 * @returns the searchable action text.
 */
export function describeAction(toolName: string, args: unknown): string {
  let serialized: string
  try {
    if (typeof args === 'string') serialized = args
    else if (args === undefined) serialized = ''
    else serialized = JSON.stringify(args)
  } catch {
    // Arguments cross a JSON materialization boundary before reaching this
    // point, so a throw is not expected; the fallback only keeps this total.
    serialized = String(args)
  }
  return `${toolName} ${serialized}`.slice(0, ACTION_TEXT_LIMIT)
}

/** Highest-severity risk assessment for one action text. */
export interface RiskAssessment {
  /** Highest matched rule severity. */
  level: RiskLevel
  /** Matched rule names, in rule-configuration order. */
  signals: string[]
}

/**
 * Assess one action against the configured risk rules.
 * @param actionText - the searchable action text from {@link describeAction}.
 * @param rules - configured risk rules.
 * @returns the highest matched level and every matched rule name.
 */
export function assessRisk(actionText: string, rules: readonly RiskRule[]): RiskAssessment {
  let level: RiskLevel = 'none'
  const signals: string[] = []
  for (const rule of rules) {
    if (!rule.patterns.some(pattern => containsLiteral(actionText, pattern))) continue
    signals.push(rule.name)
    if (levelRank(rule.level) > levelRank(level)) level = rule.level
  }
  return { level, signals }
}

/** The best-matching clause for one action text, if any. */
interface ClauseMatch {
  clause: PermissionClause
  /** Fraction of the clause's keywords present in the action text. */
  score: number
}

/**
 * Match one action against clauses with the requested outcome, keeping the
 * most specific match. A clause qualifies when at least one keyword matches
 * and at least half of its keywords match.
 */
function bestClause(
  actionTokens: readonly string[],
  clauses: readonly PermissionClause[],
  outcome: PermissionOutcome,
): ClauseMatch | undefined {
  let best: ClauseMatch | undefined
  for (const clause of clauses) {
    if (clause.outcome !== outcome) continue
    const matched = clause.keywords.filter(keyword =>
      actionTokens.some(token => tokensAgree(keyword, token)),
    ).length
    if (matched === 0 || matched * 2 < clause.keywords.length) continue
    const score = matched / clause.keywords.length
    if (best === undefined || score > best.score) best = { clause, score }
  }
  return best
}

/** Join clause keywords for a reason string. */
function clauseText(match: ClauseMatch): string {
  return match.clause.keywords.join(' ')
}

/**
 * Judge one proposed tool call.
 * @param request - the action, profile, risk rules, and prose clauses.
 * @returns the outcome, highest risk level, matched signals, and a reason.
 */
export function judgePermission(request: PermissionRequest): PermissionJudgment {
  const actionText = describeAction(request.toolName, request.arguments)
  const actionTokens = tokenize(actionText)
  const risk = assessRisk(actionText, request.riskRules)

  const deny = bestClause(actionTokens, request.clauses, 'deny')
  if (deny !== undefined) {
    return {
      outcome: 'deny',
      level: risk.level,
      signals: [`clause:${clauseText(deny)}`, ...risk.signals],
      reason: `permission preference denies "${clauseText(deny)}"`,
    }
  }
  const ask = bestClause(actionTokens, request.clauses, 'ask')
  if (ask !== undefined) {
    return {
      outcome: 'ask',
      level: risk.level,
      signals: [`clause:${clauseText(ask)}`, ...risk.signals],
      reason: `permission preference requires confirmation before "${clauseText(ask)}"`,
    }
  }
  const allow = bestClause(actionTokens, request.clauses, 'allow')
  if (allow !== undefined) {
    return {
      outcome: 'allow',
      level: risk.level,
      signals: [`clause:${clauseText(allow)}`, ...risk.signals],
      reason: `permission preference allows "${clauseText(allow)}" without confirmation`,
    }
  }

  const thresholds = PROFILE_THRESHOLDS[request.profile]
  if (risk.level === 'none') {
    return { outcome: 'allow', level: 'none', signals: [], reason: 'no configured risk rule matched' }
  }
  if (levelRank(risk.level) >= levelRank(thresholds.denyAt)) {
    return {
      outcome: 'deny',
      level: risk.level,
      signals: risk.signals,
      reason: `${request.profile} profile rejects ${risk.level} risk (${risk.signals.join(', ')})`,
    }
  }
  if (levelRank(risk.level) >= levelRank(thresholds.askAt)) {
    return {
      outcome: 'ask',
      level: risk.level,
      signals: risk.signals,
      reason: `${request.profile} profile requires confirmation for ${risk.level} risk (${risk.signals.join(', ')})`,
    }
  }
  return {
    outcome: 'allow',
    level: risk.level,
    signals: risk.signals,
    reason: `${request.profile} profile accepts ${risk.level} risk (${risk.signals.join(', ')})`,
  }
}
