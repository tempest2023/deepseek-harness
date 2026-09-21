/**
 * The Jev tool pre-filter: a pure, deliberately conservative reduction of the
 * tool schemas exposed to the primary model.
 *
 * The filter is recall-first. It declines to prune in every situation where a
 * mistake would be expensive — too few tools, no observable task, a result
 * below the retained floor, or a removal larger than the configured fraction —
 * and it always retains explicitly protected names. The model still performs
 * the real tool selection from whatever survives.
 *
 * @module @deepseek-ai/dsh-jev/tool-filter
 */

import { matchesAny, tokenize, tokensAgree } from './text.ts'
import type { ToolFilterDecision, ToolFilterRequest } from './types.ts'

/** Whether a tool's token set mentions a task token. */
function mentions(toolTokens: readonly string[], taskToken: string): boolean {
  return toolTokens.some(toolToken => tokensAgree(taskToken, toolToken))
}

/**
 * Drop task tokens that most of the catalog mentions anyway. A word present in
 * half the tools ("file", "workspace") cannot distinguish the tool the task
 * wants, and treating it as a match would retain nearly everything. The floor
 * of two keeps a small catalog from losing its only real signal.
 */
function distinctiveTokens(
  taskTokens: readonly string[],
  toolTokenSets: readonly (readonly string[])[],
): string[] {
  const ubiquitousAt = Math.max(2, Math.ceil(toolTokenSets.length / 2))
  return taskTokens.filter(taskToken =>
    toolTokenSets.filter(toolTokens => mentions(toolTokens, taskToken)).length < ubiquitousAt,
  )
}

/**
 * Decide which tools stay exposed for the current step.
 * @param request - task text, candidate tools, protected names, and retention bounds.
 * @returns the retained names, or no opinion when pruning is unsafe or useless.
 */
export function selectTools(request: ToolFilterRequest): ToolFilterDecision {
  const { task, tools, alwaysKeep, minToolsToFilter, minRetained, maxRemovalFraction } = request
  if (tools.length < minToolsToFilter) {
    return { reason: `tool count ${tools.length} is below the filtering threshold ${minToolsToFilter}` }
  }
  const taskTokens = task === undefined ? [] : tokenize(task)
  if (taskTokens.length === 0) {
    return { reason: 'no task context observed; exposing every tool' }
  }
  const toolTokenSets = tools.map(tool => tokenize(`${tool.name} ${tool.description}`))
  const distinctive = distinctiveTokens(taskTokens, toolTokenSets)
  if (distinctive.length === 0) {
    return { reason: 'the task shares only ubiquitous terms with the catalog; exposing every tool' }
  }

  const retained: string[] = []
  for (const [index, tool] of tools.entries()) {
    if (matchesAny(tool.name, alwaysKeep)) {
      retained.push(tool.name)
      continue
    }
    const toolTokens = toolTokenSets[index] as readonly string[]
    const score = distinctive.filter(taskToken => mentions(toolTokens, taskToken)).length
    if (score > 0) retained.push(tool.name)
  }

  const removed = tools.length - retained.length
  if (retained.length === 0) {
    return { reason: 'no tool matched the observed task; exposing every tool' }
  }
  if (retained.length < minRetained) {
    return { reason: `filtering would leave ${retained.length} tools, below the floor ${minRetained}` }
  }
  if (removed / tools.length > maxRemovalFraction) {
    return { reason: `filtering would remove ${removed}/${tools.length} tools, above the allowed fraction` }
  }
  if (removed === 0) {
    return { reason: 'every tool was plausibly relevant' }
  }
  return { keep: retained, reason: `retained ${retained.length}/${tools.length} tools relevant to the observed task` }
}
