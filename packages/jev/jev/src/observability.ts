/**
 * Decision observability for the Jev plugin.
 *
 * Decisions are published as the live `jev/decision` event and mirrored to the
 * plugin's logger. They are deliberately NOT injected into the agent
 * conversation: the PRD asks for observable decisions without adding decision
 * traces to the primary model's working context. Durable reconstruction comes
 * from events the capabilities already produce — `request/header` records the
 * routed model and the exposed tool schemas, and `approval/asked` records the
 * permission reason.
 *
 * @module @deepseek-ai/dsh-jev/observability
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelRef, PermissionOutcome } from './types.ts'

/** Which bounded decision a record describes. */
export type JevCapability = 'model-router' | 'tool-prefilter' | 'permission'

/** Which backend answered one decision. */
export type JevAnswerSource = 'backend' | 'local-fallback'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One bounded Jev decision was made. Live-only and informational: nothing
     * in the agent loop consumes it, so a listener failure cannot affect a
     * turn, and the model never sees it.
     * @param decision - the decision record, including which capability asked,
     * which backend answered, and the human-readable reason.
     * @mode emit
     */
    'jev/decision'(decision: JevDecision): void
  }
}

/** One published decision. */
export interface JevDecision {
  /** Capability that asked for the judgment. */
  capability: JevCapability
  /** Provider id that answered (`heuristic` or the configured backend). */
  provider: string
  /** Whether the configured backend answered or the local fallback did. */
  source: JevAnswerSource
  /** Human-readable explanation of the decision. */
  reason: string
  /** Session id of the agent the decision concerned, when one was involved. */
  agentId?: string
  /** Chosen model route for a routing decision. */
  selection?: ModelRef
  /** Retained tool names for a filtering decision. */
  keep?: string[]
  /** Requested enforcement for a permission judgment. */
  outcome?: PermissionOutcome
}

/**
 * Publish one decision.
 * @param ctx - the context to emit on and log through.
 * @param decision - the record to publish.
 */
export function publishDecision(ctx: Context, decision: JevDecision): void {
  ctx.logger('jev').debug(
    '%s: %s [%s/%s]',
    decision.capability,
    decision.reason,
    decision.provider,
    decision.source,
  )
  ctx.emit('jev/decision', decision)
}
