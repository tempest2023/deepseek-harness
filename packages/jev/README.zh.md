---
description: "Jev 有界判断插件族的包映射，覆盖模型路由、工具预过滤与上下文权限判定。"
kind: "package-group"
---

# jev/ — 有界判断插件族

[English](README.md) | 中文

## 概述

Jev 插件族提供一个可选插件，用来回答少量有界判断问题——模型角色选择、工具相关性、以及带上下文的权限判定——这些问题原本要由主模型或静态策略回答。Jev 插件是核心服务与扩展点的自包含消费者，而不是可替换的能力：Agent 循环、工具流水线与强制执行仍然属于 DSH。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx key |
|---|---|---|
| [`jev/`](jev/README.zh.md) | 模型路由、工具预过滤与权限判定 | `ctx.jev` |

每项能力都可以单独开关，并在被禁用或其配置的后端不可达时退化为空操作。决策发布在实时的 `jev/decision` 事件上；持久化重建依赖各能力自身的事件（`request/header`、`approval/*`），因此不存在 Jev 专有的会话词汇。

<a id="related-documentation"></a>
## 相关文档

- [Jev 子系统参考](../../docs/subsystems/jev.zh.md)——行为、配置、接入点与运行限制。
- [Jev 插件 Agent Note](../../.agents/notes/implemented/feature/2026-09-18-jev-bounded-judgment-plugin.zh.md)——设计理由与被否决的备选方案。

<a id="dev-note"></a>
## 开发备注

无。
