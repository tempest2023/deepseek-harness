---
description: "Package map for the Jev bounded-judgment plugin family, covering model routing, tool pre-filtering, and contextual permission judgment."
kind: "package-group"
---

# jev/ — bounded-judgment plugin family

English | [中文](README.zh.md)

## Summary

The Jev family contributes one optional plugin that answers a small set of bounded judgment questions — model role selection, tool relevance, and contextual permission — that would otherwise be answered by the primary model or by static policy. A Jev plugin is a self-contained consumer of core services and extension points, not a swappable capability: DSH keeps the agent loop, the tool pipeline, and enforcement.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`jev/`](jev/README.md) | Model routing, tool pre-filtering, and permission judgment | `ctx.jev` |

Each capability is independently switchable and degrades to a no-op when disabled or when its configured backend is unreachable. Decisions are published on the live `jev/decision` event; durable reconstruction comes from the capabilities' own events (`request/header`, `approval/*`), so no Jev-specific session vocabulary exists.

<a id="related-documentation"></a>
## Related documentation

- [Jev subsystem reference](../../docs/subsystems/jev.md) — behavior, configuration, integration points, and operational limits.
- [Jev plugin Agent Note](../../.agents/notes/implemented/feature/2026-09-18-jev-bounded-judgment-plugin.md) — rationale and rejected alternatives.

<a id="dev-note"></a>
## Dev Note

None.
