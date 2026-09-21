# Agent Note: The Jev bounded-judgment plugin

Status: implemented

English | [中文](2026-09-18-jev-bounded-judgment-plugin.zh.md)

## Problem

DSH spends its strongest available model on every step of a task, exposes every registered tool to every request, and expresses permission policy as static rules. Each of those is a bounded decision — which model, which tools, proceed or confirm — but each currently costs a general-purpose model call or a deployment-wide rule that cannot represent context.

The product need is a decision layer that is faster and cheaper than asking the LLM: one that selects a model for a step, prunes clearly irrelevant tools from the request, and judges a proposed action against the user's own autonomy preferences. It must not become a second agent loop, and DSH must behave exactly as it does today when the layer is absent.

## Decision

`@deepseek-ai/dsh-jev` ships one optional plugin with three independently switchable capabilities, each attached to an existing extension point:

| Capability | Seam |
|---|---|
| Model router | `installModelSelection` per agent + `agent/pre-step` |
| Tool pre-filter | `system-prompt/assemble` waterfall, after `next()` |
| Permission layer | `tools/pre-execute` waterfall, tightening only |

The three decisions are pure functions (`routeModel`, `selectTools`, `judgePermission`) behind a `JevProvider` interface. The default provider is deterministic and dependency-free, which keeps the plugin useful and testable with no credential and no network; `provider: remote` adds an HTTP backend with a documented JSON contract, response validation at the wire boundary, a deadline, and a fallback to the deterministic provider on any failure.

Routing classifies a step by delegation depth: a top-level agent orchestrates, a delegated child executes. That maps directly onto the model-allocation workflow — strong model for decomposition, efficient model for specified subtask work — without guessing at task semantics from message text. Preferences are prose parsed into ordered role-bound rules, and ties break by a configured bias.

Tool pre-filtering runs after every other prompt contributor so it can only narrow the final set, and it declines to prune whenever a mistake would be expensive: too few tools, no visible task text, no match, below the retained floor, or a removal larger than the configured fraction. Terms that most of the catalog mentions anyway carry no signal.

Permission judgment delegates to the whole downstream chain first, then may only make the outcome more restrictive: an allow can become an ask or a deny, and a deny is never relaxed. DSH's mandatory constraints therefore retain full force while Jev adjusts autonomy. Profiles (`conservative`, `balanced`, `autonomous`) define fixed thresholds over configurable risk rules, and denial is opt-in by promoting a rule to `critical`.

Decisions are published on the live `jev/decision` event and the plugin logger. No Jev-specific session event was added: `request/header` already records the routed model and the exposed tool schemas, and `approval/asked` records the permission reason, so every model-visible consequence stays reconstructable from the log without enlarging the session vocabulary.

## Testing

Package tests cover the decision core directly and the three capabilities through a real agent loop against a scripted mock adapter: role classification for a top-level agent and a `delegationDepth: 1` child, routine-step routing, the exact-route/preference/avoid precedence, the filter's retention bounds and distinctive-term rule, clause precedence, profile thresholds, the ask→answerer→approved-execution path with its durable `approval/asked` reason, and the authority boundary that a downstream deny or ask is never relaxed. Fail-loud configuration is covered at `resolveConfig` and through plugin load.

The assembled-application keyless snapshot required by the testing policy is the named coverage gap here: the snapshot harness replays recorded provider traffic, and recording a fixture whose transcript exercises Jev needs a provider credential this environment does not have. Until that fixture is recorded, the scripted-adapter loop tests are the strongest available evidence, and the snapshot must accompany the first change made with a key available.

## Alternatives considered

**Four packages (service definition, router, pre-filter, permission).** The seam doctrine splits roles when they evolve independently. These three consumers share one configuration surface, one backend, and one decision vocabulary, and the PRD scopes them as one plugin; splitting would have added three package boundaries and three config rows without an independent owner. The service is still exposed as `ctx.jev` for future consumers.

**Reclassify the role from message content.** Reading the claimed messages would route the first step of a turn more precisely, but `agent/pre-step` runs after prompt assembly, so the fresh prompt is not yet in the log and the decision would land one step late. Delegation depth is available at creation time, deterministic, and rebuildable from the session header.

**Filter tools by calling the provider inside `agent/pre-step`.** The pre-filter must observe a task, and pre-step is the first hook that sees the claimed messages — but assembly has already happened, so the filtering would always apply one step late. Assembly-time filtering with a conservative no-op on the first step is both earlier and safer.

**Log Jev decisions as session events.** Durability was already satisfied by `request/header` and `approval/asked`. A new session event would have required extending the merge-extensible event map, regenerating the persistence catalog, and marking the event ignorable for older builds — cost with no reconstruction benefit, since the reasons are already durable for every model-visible effect.

**Hard-deny high-severity actions by default.** A default `critical` rule would reject legitimate work (writing a `.env` file) in every profile. Denial stays opt-in so the shipped defaults can never silently break a task.

## Consequences

Jev can reduce cost and context without changing the agent loop, and a deployment that omits or disables it is unaffected. The plugin adds no prompt text, so its only model-visible effects are the routed model and the exposed tool schemas — both already in the request header.

The cost is four distinct heuristics to keep honest. Role classification cannot see task content beyond delegation depth; tool relevance is lexical, so near-synonyms are retained rather than matched; and permission prose is matched by keyword majorities, so unusual vocabulary falls through to the profile and risk rules. The conservative defaults favor a tool left exposed or a confirmation requested over a pruned requirement or a missed warning.
