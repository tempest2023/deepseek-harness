# Jev

English | [中文](jev.zh.md)

Jev is an optional bounded-decision plugin. It selects a configured model route for an agent step, removes tools that do not match the current task when the configured retention bounds allow filtering, and can tighten a tool execution decision from allow to ask or deny. The agent loop remains responsible for request assembly and execution, and downstream permission decisions cannot be relaxed. Configuration and model-experience details are on the [package README](../../packages/jev/jev/README.md).

Source: [`packages/jev/jev/src/observability.ts`](../../packages/jev/jev/src/observability.ts)

## Live decision record

`jev/decision` publishes one informational record after each judgment. The event is not written to the Session log and never enters model context. Routed models and retained tool schemas remain reconstructable from `request/header`; an approval request records its reason in `approval/asked`.

```ts type-equiv
/** One published decision. */
interface JevDecision {
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
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxjev--jevplugin"></a>

### `ctx.jev` — `JevPlugin`

The Jev service. It owns the configured backend, exposes the three bounded decisions to any consumer, and installs the capability wiring for whichever capabilities the configuration enables.

```ts cordis-catalog
/**
 * Answer one model-routing question and publish the decision.
 * @param request - the routing question.
 * @param signal - cancellation owned by the caller.
 * @returns the routing decision.
 */
async routeModel(request: ModelRoutingRequest, signal?: AbortSignal): Promise<ModelRoutingDecision>

/**
 * Answer one tool pre-filtering question and publish the decision.
 * @param request - the filtering question.
 * @param signal - cancellation owned by the caller.
 * @returns the filtering decision.
 */
async filterTools(request: ToolFilterRequest, signal?: AbortSignal): Promise<ToolFilterDecision>

/**
 * Answer one permission question and publish the decision.
 * @param request - the permission question.
 * @param signal - cancellation owned by the caller.
 * @returns the permission judgment.
 */
async judgePermission(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionJudgment>
```

Source: [`packages/jev/jev/src/index.ts`](../../packages/jev/jev/src/index.ts)

<a id="jev-events"></a>

### `jev/*` events

<a id="jevdecision--emit"></a>

#### `jev/decision` — emit

One bounded Jev decision was made. Live-only and informational: nothing in the agent loop consumes it, so a listener failure cannot affect a turn, and the model never sees it.

```ts cordis-catalog
/**
 * One bounded Jev decision was made. Live-only and informational: nothing
 * in the agent loop consumes it, so a listener failure cannot affect a
 * turn, and the model never sees it.
 * @param decision - the decision record, including which capability asked,
 * which backend answered, and the human-readable reason.
 * @mode emit
 */
'jev/decision'(decision: JevDecision): void
```

Source: [`packages/jev/jev/src/observability.ts`](../../packages/jev/jev/src/observability.ts)
<!-- END GENERATED cordis-surface -->
