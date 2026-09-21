# Jev

[English](jev.md) | 中文

Jev 是可选的有限决策插件。它为 agent 步骤选择已配置的模型路由；当配置的保留范围允许筛选时，移除与当前任务不匹配的工具；还可以把工具执行决定从允许收紧为询问或拒绝。agent loop 仍负责请求组装与执行，并且 Jev 不能放宽下游的权限决定。配置和模型体验详情见[包 README](../../packages/jev/jev/README.zh.md)。

源码：[`packages/jev/jev/src/observability.ts`](../../packages/jev/jev/src/observability.ts)

## 实时决策记录

`jev/decision` 会在每次判断后发布一条信息性记录。该事件不会写入 Session 日志，也绝不会进入模型上下文。路由后的模型和保留的工具 schema 仍可通过 `request/header` 重建；审批请求则会在 `approval/asked` 中记录原因。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
