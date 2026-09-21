---
description: "Jev plugin reference for configuring and operating bounded model routing, tool pre-filtering, and contextual permission judgment."
kind: "package-reference"
---

# @deepseek-ai/dsh-jev

English | [中文](README.zh.md)

## Summary

Jev can route orchestration and execution steps to different models, hide clearly irrelevant tools from a request, and require confirmation or reject configured high-risk actions. Choose it when these three decisions should follow deployment policy instead of relying entirely on the primary model. Each capability is optional, and Jev never plans, writes tool arguments, executes tools, or replaces DSH enforcement.

## Table of Contents

- [Config](#config)
- [Model router](#model-router)
- [Tool pre-filter](#tool-pre-filter)
- [Permission layer](#permission-layer)
- [Observability](#observability)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="config"></a>
## Config

```yaml
- id: jev
  name: '@deepseek-ai/dsh-jev'
  config:
    enabled: true                  # master switch; false makes the plugin a no-op
    provider: heuristic            # heuristic | remote
    modelRouterEnabled: true
    orchestrationProvider: deepseek
    orchestrationModel: deepseek-v4.1-pro
    executionProvider: deepseek
    executionModel: deepseek-v4.1-flash
    routingBias: quality           # quality | cost | latency
    routingPreferences: >-
      Prefer DeepSeek V4.1 Pro for planning and difficult decisions.
      Prefer DeepSeek V4.1 Flash for delegated implementation tasks.
    routingAvoid: []
    preferExecutionForRoutineSteps: false
    toolPrefilterEnabled: true
    prefilterMinTools: 8
    prefilterMinRetained: 4
    prefilterMaxRemovalFraction: 0.5
    prefilterAlwaysKeep: []
    toolFilterTaskMessages: 3
    permissionEnabled: true
    permissionProfile: balanced    # conservative | balanced | autonomous
    permissionPreferences: >-
      Allow normal file edits, package installation, test execution, and git
      operations without confirmation. Ask before deleting files, changing
      credentials, publishing externally, spending money, or performing
      actions that are difficult to reverse.
```

`provider: remote` additionally requires `remoteEndpoint` and accepts `remoteApiKeyEnv` (the environment variable holding the bearer credential) and `remoteTimeoutMs` (default 2000). A remote backend that fails, times out, or answers an invalid body falls back to the built-in deterministic provider, so an unavailable Jev degrades to local heuristics rather than blocking a turn.

Configuration fails loud at plugin load: an unknown provider, bias, or profile; a half-configured orchestration/execution route; an `routingAvoid` pattern that contradicts a configured route; a non-positive retention bound; a removal fraction outside `0..1`; and a duplicate or pattern-less risk rule all throw instead of degrading silently.

<a id="model-router"></a>
## Model router

Roll selection follows the role of the step. A delegated child (session `delegationDepth > 0`) is an execution step; a top-level agent is an orchestration step, and `preferExecutionForRoutineSteps` optionally routes its later steps to the execution model too. Precedence is: an explicit per-role route from configuration, then leaving a model that matches an avoid pattern, then the first matching natural-language preference, then no opinion — which leaves DSH's own selection untouched.

Preferences are prose, parsed deterministically into ordered rules: `Prefer <model> for <planning|implementation|...>` binds a pattern to a role, `Prefer <model>` binds it to every role, and `Do not use <model>`, `Never use <model>`, and `Avoid <model>` exclude a model. A pattern matches the `provider/model` text, the model id, or the display name; ties break by `routingBias`, so a `quality` deployment prefers capability tokens (`pro`, `max`, `thinking`) and a `cost` deployment prefers economy tokens (`flash`, `lite`, `mini`).

The candidate catalog is discovered from `ctx.llm` at most once per `modelDiscoveryTtlMs` (default 300000). Discovery is advisory: an unreachable provider contributes nothing, and with no candidates the router simply has no opinion.

<a id="tool-pre-filter"></a>
## Tool pre-filter

The filter runs inside `system-prompt/assemble` after every other contributor, narrowing `assembly.tools` to tools whose name or description shares a *distinctive* term with the observed task. Terms that most of the catalog mentions anyway ("file", "workspace") carry no signal and cannot keep a tool on their own.

It is recall-first by construction. The filter declines to prune when the tool set is below `prefilterMinTools`, when no task text is visible yet (the first step of a turn assembles before its own prompt is logged), when no tool matches, when the result would fall below `prefilterMinRetained`, or when it would remove more than `prefilterMaxRemovalFraction` of the catalog. Names matching `prefilterAlwaysKeep` always survive, and the Code Mode transport tool is always kept. Whatever survives is still the model's candidate set: Jev never generates tool arguments and never executes a tool.

<a id="permission-layer"></a>
## Permission layer

The layer observes `tools/pre-execute` and may only *tighten* the chain. It delegates to every downstream listener first, returns their decision unchanged when Jev would allow, and can turn an allow into an ask or a deny — never a deny into an allow, and never an ask into an allow. DSH's mandatory constraints therefore keep their full force; Jev adjusts autonomy, not authority.

Judgment precedence is: a matching `deny` clause from the permission prose, then a matching `ask` clause, then a matching `allow` clause, then the profile's thresholds against the highest matched risk rule. The profiles define fixed semantics — `conservative` confirms from `low` severity upward, `balanced` from `medium`, `autonomous` from `high`, and all three reject `critical` — so denial is opt-in by promoting a configured rule to `critical`. An action no rule matches is allowed, which is what keeps the layer from interrupting ordinary work.

Risk rules are configuration, not constants: each names a subject area, a severity, and the literal substrings whose presence in the tool name or serialized arguments flags it. Matching is case-insensitive substring matching over user configuration, never a regular expression. The shipped defaults cover destructive commands, credentials, irreversible changes, broad-scope modification, external side effects, and financial consequences; none of them is `critical`, so denial stays opt-in.

<a id="observability"></a>
## Observability

Every decision publishes the live `jev/decision` event and a debug log line, carrying the capability, the answering backend, the reason, and the chosen model, retained tools, or requested outcome. Decisions are deliberately not injected into the conversation. Durable reconstruction comes from the events the capabilities already produce: `request/header` records the routed model and the exposed tool schemas, and `approval/asked` records the permission reason, so a reader can replay what Jev decided without a Jev-specific session event.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the request header: the routed provider and model for the step, and the tool schemas the step exposes.

#### KV Cache effect

Routing or filtering changes the request only when it changes what that header contains, and Jev never appends a message, so a decision that keeps the current selection and tool set leaves the reusable prefix — and any KV-cache entries derived from it — untouched.

## Known Limitations and Deferred Work

- **Role classification is structural.** Delegation depth decides orchestration versus execution; task-content classification beyond that is limited to the optional routine-step downgrade.
- **The remote backend is exercised by unit tests only.** With no credential available, the shipped default is the deterministic provider.
- **The credential is read from the environment.** `remoteApiKeyEnv` names a variable; routing it through the credentials seam is the intended follow-up.
- **Tool relevance is lexical.** Distinctive-term overlap prunes clearly unrelated tools well and near-synonyms poorly; recall-first bounds the cost.
- **Permission clauses match keyword majorities.** Prose with unexpected vocabulary falls through to the profile and risk rules rather than guessing.

<a id="dev-note"></a>
### Dev Note

No runtime invariant companion is published: Jev listens to events owned by other packages and keeps no package-owned event stream, snapshot, or registry whose independently observed state could diverge; package tests cover its private decision logic.
