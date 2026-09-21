---
description: "Jev 插件参考，用于配置和运行有界模型路由、工具预过滤与上下文权限判定。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jev

[English](README.md) | 中文

## 概述

Jev 可以把编排步骤和执行步骤路由到不同模型，从请求中隐藏明显无关的工具，并要求确认或拒绝已配置的高风险动作。当这三类决策应当遵循部署策略、而不应完全依赖主模型时，可以选择 Jev。每项能力都可单独开关；Jev 不做规划，不编写工具参数，不执行工具，也不替代 DSH 的强制执行机制。

## 目录

- [配置](#config)
- [模型路由](#model-router)
- [工具预过滤](#tool-pre-filter)
- [权限层](#permission-layer)
- [可观测性](#observability)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="config"></a>
## 配置

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

`provider: remote` 还要求 `remoteEndpoint`，并接受 `remoteApiKeyEnv`（存放 Bearer 凭据的环境变量名）与 `remoteTimeoutMs`（默认 2000）。远程后端失败、超时或返回非法响应体时，会回退到内置的确定性实现，因此 Jev 不可用时会降级为本地启发式判断，而不会阻塞回合。

配置错误在插件加载时立刻报错：未知的 provider、bias 或 profile；只配置了一半的 orchestration/execution 路由；与已配置路由冲突的 `routingAvoid` 模式；非正的保留下限；不在 `0..1` 之内的删除比例；以及重名或没有模式的风险规则，都会直接抛出，而不是静默降级。

<a id="model-router"></a>
## 模型路由

选择依据是这一步的角色。被委派的子 Agent（会话 `delegationDepth > 0`）属于执行步骤；顶层 Agent 属于编排步骤，`preferExecutionForRoutineSteps` 可以选择把它的后续步骤也路由到执行模型。优先级依次为：配置中显式的按角色路由；离开命中排除模式的模型；第一条命中的自然语言偏好；最后是无意见——此时保持 DSH 自己的选择不变。

偏好以自然语言书写，并被确定性地解析为有序规则：`Prefer <模型> for <planning|implementation|...>` 把模式绑定到某个角色，`Prefer <模型>` 绑定到所有角色，`Do not use <模型>`、`Never use <模型>`、`Avoid <模型>` 则排除某个模型。模式会匹配 `provider/model` 文本、模型 id 或显示名；同分时由 `routingBias` 决定，因此 `quality` 部署偏好能力词（`pro`、`max`、`thinking`），`cost` 部署偏好经济词（`flash`、`lite`、`mini`）。

候选模型目录最多每 `modelDiscoveryTtlMs`（默认 300000）从 `ctx.llm` 发现一次。发现只是参考信息：不可达的 provider 不贡献任何候选，而没有任何候选时路由器就直接不表态。

<a id="tool-pre-filter"></a>
## 工具预过滤

过滤发生在 `system-prompt/assemble` 中、在其他所有贡献者之后，把 `assembly.tools` 收窄为“名称或描述与观察到的任务共享*有区分度*词项”的工具。目录中大多数工具本就共有的词（如 “file”“workspace”）不携带信号，不能单独保留下一个工具。

它的构造方式是召回优先。以下情况过滤器都不裁剪：工具数量低于 `prefilterMinTools`；尚无可观察的任务文本（回合的第一步在自身提示写入日志之前就已完成装配）；没有任何工具匹配；结果会低于 `prefilterMinRetained`；或删除比例超过 `prefilterMaxRemovalFraction`。匹配 `prefilterAlwaysKeep` 的名称始终保留，Code Mode 的传输工具也始终保留。保留下来的工具仍然只是模型的候选集合：Jev 从不生成工具参数，也从不执行工具。

<a id="permission-layer"></a>
## 权限层

该层观察 `tools/pre-execute`，并且只能*收紧*决策链。它先委派给所有下游监听者，在 Jev 判定为允许时原样返回下游结论，并且只能把 allow 变成 ask 或 deny——绝不会把 deny 变成 allow，也不会把 ask 变成 allow。因此 DSH 的强制约束效力完整保留：Jev 调整的是自主程度，而不是权限本身。

判断优先级依次为：权限文本中命中的 `deny` 子句，然后命中的 `ask` 子句，然后命中的 `allow` 子句，最后是 profile 阈值针对最高风险等级的判定。三个 profile 的语义是固定的——`conservative` 从 `low` 起请求确认，`balanced` 从 `medium` 起，`autonomous` 从 `high` 起，三者都会拒绝 `critical`——因此“直接拒绝”是通过把某条已配置规则提升为 `critical` 而主动选择的。没有命中任何规则的动作会被允许，这正是该层不会打断日常工作的原因。

风险规则属于配置而非常量：每条规则给出一个主题领域、一个严重级别，以及在工具名或序列化参数中出现即命中该规则的若干字面子串。匹配是对用户配置进行大小写不敏感的包含匹配，绝不使用正则表达式。交付的默认规则覆盖破坏性命令、凭据、不可逆变更、大范围修改、对外副作用与金钱代价；其中没有任何一条是 `critical`，因此“直接拒绝”仍需主动开启。

<a id="observability"></a>
## 可观测性

每次决策都会发布实时的 `jev/decision` 事件并写一行 debug 日志，携带能力名、作答后端、原因，以及所选的模型、保留的工具或请求的结论。决策刻意不注入对话。持久化的重建依赖各能力本来就产生的事件：`request/header` 记录被路由的模型与暴露的工具 schema，`approval/asked` 记录权限原因，因此读者可以复现 Jev 的决定，而无需新增 Jev 专有的事件。

<a id="model-experience"></a>
## 模型体验

间接地，通过请求头体现：这一步被路由到的 provider 与 model，以及这一步暴露的工具 schema。

#### KV Cache effect

只有当头内容本身改变时，路由或过滤才会改变请求；而且 Jev 从不追加消息，因此保持当前模型选择与工具集合不变的决策不会触及可复用的前缀，也不会影响由它派生的 KV-cache 条目。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **角色分类是结构性的。** 编排与执行的区分由委派深度决定；除此之外的内容级分类仅限于可选的常规步骤降级。
- **远程后端仅由单元测试覆盖。** 在没有可用凭据的前提下，默认交付的是确定性实现。
- **凭据从环境变量读取。** `remoteApiKeyEnv` 指定变量名；改由 credentials 接入点提供是预期的后续工作。
- **工具相关性是词法匹配。** 有区分度词项的重叠能很好地剔除明显无关的工具，但对近义词效果不佳；召回优先限定了代价。
- **权限子句按关键词多数匹配。** 用词意外的表述会退回到 profile 与风险规则，而不是去猜测。

<a id="dev-note"></a>
### 开发备注

Jev 不发布运行时不变式配套插件：它监听由其他包拥有的事件，也不维护可能与独立观测状态发生偏离的包内事件流、快照或注册表；其私有决策逻辑由包测试覆盖。
