---
description: "装配库：把分层 cordis.yml 源展开为经过校验、带审计的装配计划，其 planId 是运行时管控效果审计链的对账锚点。"
kind: "package-library"
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '21a3cde7-bb3b-477e-98e0-2e136e1ea2e2'
  PropagateID: '21a3cde7-bb3b-477e-98e0-2e136e1ea2e2'
  ReservedCode1: '4b44356a-1c4c-46fd-9ba4-1e31b6b341aa'
  ReservedCode2: '4b44356a-1c4c-46fd-9ba4-1e31b6b341aa'
---

# @deepseek-ai/dsh-assembly

[English](README.md) | 中文

## 概述

在任何东西运行之前构建并校验 Cordis 组合：把分层 `cordis.yml` 源展开为有效节点，执行静态与动态校验，产出带敏感覆盖保护的安全审计，并给出以 `planId` 为键的预颁发能力计划。CLI 入口以稳定退出码驱动同一管线支撑 `dsh config` 与 `--dry-run` 报告。消费方可直接内嵌 `buildDryRunPlan` 或 `AssemblyController`；本库产出的每个计划都是运行时管控效果审计链对账的锚点。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

需要在启动前完成组合检查与审计的宿主选择本库：它是先于一切挂载运行的计划生产者。

### 何时选择它

当组合必须在装配期 fail-closed 时选择本库——不可解析的分层、畸形条目或敏感覆盖都会以带 SEC 码的诊断在任何一个服务启动之前暴露。当宿主信任其配置来源、不需要安全审计与能力预计划时，请改用普通 Cordis 加载。

### 入口

最小路径是展开并校验一个分层组合：

```ts
import { loadLayersFromYaml, buildDryRunPlan } from '@deepseek-ai/dsh-assembly'

const layers = loadLayersFromYaml(['base.cordis.yml', 'override.cordis.yml'])
const plan = buildDryRunPlan({ layers })
if (plan.status !== 'ok') {
  for (const diagnostic of plan.validation) console.error(diagnostic.code, diagnostic.message)
}
```

成功意味着得到携带 `planId`、有效节点、组合图、校验结果、安全审计与能力预颁发的计划；失败是带稳定 SEC 码的类型化诊断列表（静态 `SEC-1001`–`SEC-1014`，动态 `SEC-2001`–`SEC-2003`）——绝不部分启动。同一管线支撑 `dsh config --expand` / `--dry-run`（boot-free，退出码 0/1 由 `dryRunExitCode` 保证）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

本节解释管线次序与信任模型；可观察行为见[使用本包](#use-this-package)。

### 管线次序

`loadLayers`/`loadLayersFromYaml` 解析分层源（`adapter-cordis-yaml.ts` 摊平 `insert` 行、保留 `group` 块、容忍 id-only 的禁用行、保留 `!!js` 表达式）；`expandLayers` 解析为有效节点；`buildCompositionGraph` 派生依赖图；静态校验（`validators/static.ts`）以 SEC 码拒绝已登记的错误族；动态校验（`simulateDynamicValidation`）以计划期事实运行同一套判定；`buildSecurityAudit` 产出带敏感覆盖保护的审计账本（`security/sensitive.ts`、`security/trust.ts`）；能力预颁发（`plan.ts`、`index.ts`）给每个计划挂上 `makePlanId()`。`AssemblyController` 编排该序列；`cli.ts` 以稳定退出码对外暴露；宿主仓库的 `verify-cordis-config.ts` 把装配门并入配置校验脚本，使仓库中每个可装配的 `cordis.yml` 都在卫生检查中被干跑校验。

### 信任模型

计划是提议，不是执行者：它声明什么会运行、在哪些能力之下运行，而运行侧（`@deepseek-ai/dsh-runtime-control`）拥有一切实际判定。两本账经 `planId`/`assemblyPlanId` 互指锚点对账——装配审计账本与运行时效果审计链指向同一个计划身份，任何后续强制决定都能回溯到预颁发其能力的那个计划。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/resolver.ts`](src/resolver.ts) | 分层展开、组合 diff/依赖图、敏感覆盖拒绝 |
| [`src/adapter-cordis-yaml.ts`](src/adapter-cordis-yaml.ts) | `cordis.yml` 解析：insert 摊平、group 保留、`!!js` 处理 |
| [`src/validators/static.ts`](src/validators/static.ts) | 带 SEC 码诊断的静态校验 |
| [`src/security/`](src/security/) | 审计账本、信任策略、敏感路径保护 |
| [`src/plan.ts`](src/plan.ts) | `makePlanId` 与挂到每个计划上的能力预颁发 |
| [`src/index.ts`](src/index.ts) | 管线之上的 `buildDryRunPlan` 与 `AssemblyController` |
| [`src/cli.ts`](src/cli.ts) | `dsh config` 入口：`loadLayers`、`run`、`dryRunExitCode`、`planStatus` |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [装配组地图](../README.zh.md) — 该家族拥有什么、每一半在哪里。
- [运行时管控库](../../runtime-control/runtime-control/README.zh.md) — 消费本包计划、按 `planId` 对账审计链的强制侧。
- [设计档案](docs/cordis-assembly-control-architecture.zh.md) — 装配控制层的完整中文设计文档（分层展开、校验门禁、安全审计、能力预颁发）。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过挂载本库所校验内容的组合 `cordis_run`/`cordis_stop` 面，本库自身不注册任何提示词、schema 或结果文本，且完全在启动之前运行。

#### KV Cache effect

不超出组合面：装配在配置期运行，不贡献目录条目、系统提示词片段或逐工具文本；其诊断只有经宿主自己的面渲染时才会到达模型。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是当前包已登记的边界事实，不是任务清单。

- **动态校验是计划期模拟，不是执行** — `simulateDynamicValidation` 以计划期事实评估已登记行为；只在运行期显形的东西（提供方存活、环境漂移）不在计划可拒绝的范围内，且计划中的能力是预颁发，运行时仍可拒绝。
- **`!!js` 表达式被携带而非分析** — YAML 分层可嵌入 JavaScript 表达式，本库原样保留给加载器，不求值也不约束；组合的表达式安全由拥有该分层的配置方负责。
- **装配门只覆盖可装配文件** — 仓库卫生检查干跑能解析为装配输入的 `cordis.yml`；解析失败的畸形文件被报告为不可解析，而不是获得装配诊断。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文：未决方向与开放问题。它明确不具备权威性——已交付的行为、边界与接受的依据存在于上文各节、包代码与所链接的档案中。

#### Future: plan-time schema tightening

静态层是否应在动态模拟之前拒绝更多配置形态族（超出当前 SEC 码集合）是开放方向；任何新增都必须先扩展登记的 SEC 码位表，而不是生长出临时检查。

</details>

**运行时不变量：** 每个产出的计划都携带全新 `planId` 与只增不改的审计账本；装配从不改写被替代计划的历史——组合变更即产生新的计划身份。

> AI生成