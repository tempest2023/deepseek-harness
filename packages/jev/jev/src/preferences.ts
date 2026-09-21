/**
 * Natural-language preference parsing for the Jev plugin. Users express model
 * routing and permission intent in prose; this module turns that prose into
 * ordered, deterministic rules the decision core can evaluate.
 *
 * Only the documented leading verbs are recognized (`prefer`, `avoid`,
 * `do not use`, `allow`, `ask before`, `never`). Unrecognized prose is
 * ignored rather than guessed at, so a typo degrades to the configured
 * profile instead of silently changing agent behavior.
 *
 * @module @deepseek-ai/dsh-jev/preferences
 */

import { tokenize } from './text.ts'
import type { JevRole, ModelPreferenceRule, PermissionClause, PermissionOutcome } from './types.ts'

/** Role words that mark a planning/reasoning preference. */
const ORCHESTRATION_WORDS: readonly string[] = [
  'planning', 'plan', 'decomposition', 'decompose', 'architecture', 'architectural',
  'strategy', 'strategic', 'reasoning', 'reason', 'design', 'difficult', 'hard',
  'unclear', 'ambiguous', 'complex', 'overall',
]

/** Role words that mark a delegated-implementation preference. */
const EXECUTION_WORDS: readonly string[] = [
  'implementation', 'implement', 'subtask', 'subtasks', 'execution', 'execute',
  'routine', 'coding', 'code', 'delegated', 'delegation', 'simple', 'straightforward',
  'mechanical', 'specified', 'well-specified',
]

/**
 * Split prose into independent clauses. Bullets, newlines, semicolons, and
 * sentence-final periods separate clauses; each clause is trimmed and empties
 * are dropped.
 * @param text - the user's preference prose.
 * @returns clause strings in their original order.
 */
export function splitClauses(text: string): string[] {
  return text
    .split(/\r?\n|;|\.\s+/u)
    .flatMap(line => line.split(/(?:^|\s)[-*]\s+/u))
    .map(clause => clause.replace(/^\s*(?:\d+[.)]\s*)?/u, '').trim())
    .filter(clause => clause.length > 0)
}

/**
 * Classify the role a preference targets from its prose.
 * @param text - the target phrase, for example "planning and difficult decisions".
 * @returns the matched role, or undefined when the phrase names neither.
 */
export function roleFromText(text: string): JevRole | undefined {
  const lower = text.toLowerCase()
  const orchestration = ORCHESTRATION_WORDS.some(word => lower.includes(word))
  const execution = EXECUTION_WORDS.some(word => lower.includes(word))
  if (orchestration && !execution) return 'orchestration'
  if (execution && !orchestration) return 'execution'
  return undefined
}

/** Strip quotes and trailing punctuation from a model pattern. */
function cleanPattern(raw: string): string {
  return raw
    .replace(/^(?:(?:the\s+)?model|the)\s+/iu, '')
    .replace(/^[\s"'`]+/u, '')
    .replace(/[\s"'`.,;:]+$/u, '')
    .trim()
}

/** Parsed model preferences. */
export interface ParsedModelPreferences {
  /** Ordered prefer rules, most specific (role-bound) first. */
  prefer: ModelPreferenceRule[]
  /** Literal substrings that disqualify a model. */
  avoid: string[]
}

/**
 * Parse model-routing prose into rules.
 *
 * Recognized forms:
 * - `Prefer <model> for <planning|implementation|...>` binds a pattern to a role.
 * - `Prefer <model>` binds a pattern to every role.
 * - `Do not use <model>` / `Don't use <model>` / `Never use <model>` /
 *   `Avoid <model>` adds an avoid pattern.
 *
 * @param text - the user's model preferences, or undefined when unset.
 * @returns the parsed rules; empty arrays when nothing recognizable is present.
 */
export function parseModelPreferences(text: string | undefined): ParsedModelPreferences {
  const prefer: ModelPreferenceRule[] = []
  const avoid: string[] = []
  if (text === undefined) return { prefer, avoid }
  for (const clause of splitClauses(text)) {
    const avoidMatch = /^(?:do not|don't|never|avoid)\s+(?:use\s+)?(.+)$/iu.exec(clause)
    if (avoidMatch !== null) {
      const pattern = cleanPattern(avoidMatch[1] as string)
      if (pattern.length > 0) avoid.push(pattern)
      continue
    }
    const preferMatch = /^prefer\s+(.+)$/iu.exec(clause)
    if (preferMatch === null) continue
    const body = preferMatch[1] as string
    const forMatch = /^(.*?)\s+for\s+(.+)$/iu.exec(body)
    const pattern = cleanPattern(forMatch === null ? body : forMatch[1] as string)
    if (pattern.length === 0) continue
    prefer.push({ pattern, role: forMatch === null ? 'any' : roleFromText(forMatch[2] as string) ?? 'any' })
  }
  // Role-bound rules are more specific than role-agnostic ones; stable within each group.
  return {
    prefer: [
      ...prefer.filter(rule => rule.role !== 'any'),
      ...prefer.filter(rule => rule.role === 'any'),
    ],
    avoid,
  }
}

/** Strips a trailing "without confirmation" style qualifier from an allow clause. */
function stripWaiver(raw: string): string {
  return raw
    .replace(/[,;]?\s*(?:with|and)\s+no\s+(?:confirmation|approval|prompt(?:ing)?)\b.*$/iu, '')
    .replace(/[,;]?\s*without\s+(?:confirmation|approval|asking|prompt(?:ing)?|a\s+prompt)\b.*$/iu, '')
    .trim()
}

/** Split a permission clause body into the individual actions it lists. */
function splitActions(raw: string): string[] {
  return raw
    .split(/,|\s+or\s+/iu)
    .map(part => part.trim().replace(/^(?:and|then)\s+/iu, '').replace(/^(?:before|when|any)\s+/iu, ''))
    .filter(part => part.length > 0)
}

/**
 * Parse permission prose into ordered clauses.
 *
 * Recognized forms:
 * - `Allow <action>` grants normal behavior for the action.
 * - `Ask before <action>` / `Ask <action>` / `Require confirmation before <action>`
 *   requires confirmation.
 * - `Never <action>` / `Do not <action>` / `Deny <action>` / `Block <action>`
 *   rejects the action.
 *
 * A clause listing several actions is split, so one sentence can express
 * different outcomes for different actions.
 *
 * @param text - the user's permission preferences, or undefined when unset.
 * @returns clauses grouped by outcome (deny, ask, allow), each in source order.
 */
export function parsePermissionClauses(text: string | undefined): PermissionClause[] {
  if (text === undefined) return []
  const deny: PermissionClause[] = []
  const ask: PermissionClause[] = []
  const allow: PermissionClause[] = []
  for (const clause of splitClauses(text)) {
    const denyMatch = /^(?:never|do not|don't|deny|block|reject|refuse)\s+(.+)$/iu.exec(clause)
    if (denyMatch !== null) {
      for (const action of splitActions(denyMatch[1] as string)) {
        const keywords = tokenize(action)
        if (keywords.length > 0) deny.push({ outcome: 'deny', keywords })
      }
      continue
    }
    const askMatch = /^(?:ask|ask me|ask before|require confirmation|confirm before|confirm)\s*(?:before|when|for|to)?\s+(.+)$/iu
      .exec(clause)
    if (askMatch !== null) {
      for (const action of splitActions(askMatch[1] as string)) {
        const keywords = tokenize(action)
        if (keywords.length > 0) ask.push({ outcome: 'ask', keywords })
      }
      continue
    }
    const allowMatch = /^(?:allow|permit|let me|feel free to)\s+(.+)$/iu.exec(clause)
    if (allowMatch !== null) {
      for (const action of splitActions(stripWaiver(allowMatch[1] as string))) {
        const keywords = tokenize(action)
        if (keywords.length > 0) allow.push({ outcome: 'allow', keywords })
      }
    }
  }
  return [...deny, ...ask, ...allow]
}

/** Every outcome, exported for config validation and tests. */
export const PERMISSION_OUTCOMES: readonly PermissionOutcome[] = ['allow', 'ask', 'deny']
