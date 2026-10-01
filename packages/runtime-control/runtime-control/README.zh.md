---
description: "面向组装智能体运行时的宿主的运行时管控库：服务膜、能力令牌、效果系统、隔离域、审批语义、沙箱档位、OS 原生桥，以及承载每一次 fs/net/proc/env/MCP 效果的元层哨兵。"
kind: "package-library"
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'a1da4ba0-5818-4c51-82af-6ffe956e7a36'
  PropagateID: 'a1da4ba0-5818-4c51-82af-6ffe956e7a36'
  ReservedCode1: '3ce0776d-48c3-4cdb-936e-7ba7f215d270'
  ReservedCode2: '3ce0776d-48c3-4cdb-936e-7ba7f215d270'
---

# @deepseek-ai/dsh-runtime-control

[English](README.md) | 中文

## 概述

运行时管控层约束组合出的智能体所能产生的一切效果：文件系统、网络、进程、环境与 MCP 调用都要穿过服务膜、能力令牌与同一套效果系统，每次请求被裁决为放行、拦截或豁免并写入审计。宿主可经 `installMembraneOnContext` 把膜挂到 Cordis 的 `ctx.reflect.get` 上，也可直接内嵌效果处理器、MCP 运行时与 OS 原生沙箱桥。判定核心被 1216 逻辑行的红线约束；元层模块（哨兵、重算器、三态披露）只检测不一致，绝不自动改写任何判定。

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

从 Cordis 组合组装智能体运行时的宿主，当组合树可能发出的一切 fs、net、proc、env 或 MCP 调用都必须经过单一可审计判定点而非散落的提供方默认值时，选择本库。

### 何时选择它

当组合需要运行模型生成或插件生成的代码，而其效果需要膜、能力令牌、审批语义与统一违规策略时选择本库。当组合只需要能力缝隙而不需要强制时，请改用普通提供方包——本库是强制层，不是缝隙。

### 入口

最小的挂载路径是包一层 Cordis 上下文，使 `ctx` 解析出的每个服务都过膜注册表：

```ts
import { installMembraneOnContext, SENSITIVE_SERVICE_MEMBRANES, STANDARD_SERVICE_MEMBRANES, buildMembraneRegistry } from '@deepseek-ai/dsh-runtime-control'

installMembraneOnContext(ctx, {
  registry: buildMembraneRegistry([...STANDARD_SERVICE_MEMBRANES, ...SENSITIVE_SERVICE_MEMBRANES]),
})
```

直接消费方内嵌效果系统（`createEffectApi` 加 fs/net/proc/env 处理器）、审批服务（`ApprovalService`，once/object/class 三档授权）、MCP 运行时（`McpRuntime`，经 `DshMcpClientAdapter` 接 `@modelcontextprotocol/client`），或 OS 原生沙箱桥（`createNativeOsBridge`，首次受控拉起前强制 sha256 清单校验）。成功意味着每次请求得到一个判定与一条审计记录；失败是携带结构化理由的 `SecurityViolation` 或拦截——绝不静默放行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

本节解释三层纪律、判定链与元层；可观察行为见[使用本包](#use-this-package)。

### 三层纪律

本架构分离判定内核（本包的效果系统与膜）、提议者（LLM、策略、SMT——一切可以"建议"的东西）与版本化知识库。内核层永不自动：它把请求裁决为判定并记录理由，本包没有任何模块会在事后改写判定。每条效果追加的审计链都携带 `assemblyPlanId`，使两本账——`@deepseek-ai/dsh-assembly` 产出的装配计划与本包的运行时效果审计——按计划 id 对账，而不是靠猜测。

### 判定链

`ctx` 解析的每个服务都经过 `installMembraneOnContext`（注册表包住 `ctx.reflect.get`，含 `ctx.fs` 直读），插件无法绕过自己配置的膜去侧取服务。效果请求（`fs`/`net`/`proc`/`env`/`mcp.call`）经四个处理器族流入 `createEffectApi`；豁免是封闭枚举通道，每个判定都追加带 `assemblyPlanId` 锚点的 `EffectAuditEntry`。违规进入 `DefaultViolationHandler`（记录并抛出）或 `IsolateViolationHandler`（升级到插件隔离追踪器）；审批遵循三档授权语义，含 park/resume、超时即拒与来源登记库。MCP 比单个处理器更深：`McpRuntime` 拥有 server 登记与生命周期（未登记 server 直接拒绝），`InboundRequestHandler` 把三类反向请求效果化（sampling 带模型白名单与字节预算、roots 与沙箱取交集、elicitation 走审批），`checkExfiltration` 在任何字节离机前扫描出站载荷。

### 沙箱与原生桥

`makeSandboxProfile` 与 `SANDBOX_PROFILES` 把 MCP server 映射到约束档位；`confineCommand` 与 `minimalEnv` 产出命令形态；`ESCAPE_CASES` 与 `RESIDUAL_RISK_REGISTRY` 让残余风险台账显式可查。原生桥（`createNativeOsBridge`）实现 OS 隔离域：Windows 经 `@deepseek-ai/dsh-win32-process` 走 Job 对象进程树，受限通道经 `@deepseek-ai/dsh-sandbox-windows-acl` 的 runner 产生 write-restricted + Low integrity 子进程，POSIX 用 detached 进程组加组杀，首次拉起前做 sha256 清单校验（fail-closed）。`mirrorOpenBeneath` 与 `openBeneath` 把路径穿越约束在授权根内。

### 元层纪律

元层模块是检测器而非判官：`runSentinel` 比对授权账与审计账，报告三类已登记矛盾（授权-审计不齐、双判定、豁免-契约冲突）并给出冻结建议；`recheckDecisions` 用独立最小判据重算抽样判定，产出 `cross_checked` 或 `frozen`；`buildDisclosureReport` 分列放行/拦截/豁免，并把超时拒绝与用户拒绝分开。它们都不自行改写判定——不一致只会冻结通道并把矛盾交人工裁定。`meta/no-lob.ts` 与 `meta/root.ts` 承载 No-Löb 硬排除（元层调用者永不能断言自身可靠性）与 root 调用者诚实登记。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/membrane.ts`](src/membrane.ts) + [`src/membrane-config.ts`](src/membrane-config.ts) | 膜原语与敏感/标准档服务注册表 |
| [`src/capability.ts`](src/capability.ts) + [`src/issuer.ts`](src/issuer.ts) | 能力令牌、fiber 派生与预颁发计划 |
| [`src/effect.ts`](src/effect.ts) + [`src/effects/`](src/effects/) | 效果类型、四个处理器族、效果 API、审批、MCP 效果与外发检查 |
| [`src/integration-cordis.ts`](src/integration-cordis.ts) | `installMembraneOnContext`：膜挂 `ctx.reflect.get` |
| [`src/realm.ts`](src/realm.ts) + [`src/violation.ts`](src/violation.ts) | 白名单 require 隔离域与含升级路径的违规策略 |
| [`src/mcp/`](src/mcp/) | `McpRuntime`、反向请求处理器与 `@modelcontextprotocol/client` 适配器 |
| [`src/sandbox/`](src/sandbox/) | 沙箱档位、命令约束、逃逸案例与残余风险登记簿 |
| [`src/native/`](src/native/) | OS 原生桥：Windows Job/ACL 子进程、POSIX 进程组、清单校验 |
| [`src/skill/`](src/skill/) | skill 清单解析、未授权指令扫描与效果归因 |
| [`src/meta/`](src/meta/) | 哨兵、重算器、三态披露、No-Löb 排除与 root 登记 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [运行时管控组地图](../README.zh.md) — 该家族拥有什么、每一半在哪里。
- [装配库](../../assembly/assembly/README.zh.md) — 计划生产者，其 `planId` 是本包审计链的锚点。
- [设计档案](docs/cordis-runtime-security-architecture.zh.md) — 本层实现的完整中文设计文档（膜、效果、审批、沙箱、元层纪律、SEC 码位表、红线台账）。
- [里程碑档案](docs/cordis-assembly-runtime-milestones.zh.md) — 当前代码背后的逐批次实施与裁定记录。
- [红线清单](../../../REDLINE-MANIFEST.conf) — 约束本包的十个判定核心文件与 1216 逻辑行上限。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过渲染其判定的组合审批与工具面（审批服务、fs/net/proc/env/MCP 效果处理器），本库自身不注册任何提示词、schema 或结果文本。

#### KV Cache effect

不超出组合面：本库不贡献目录条目，不贡献系统提示词片段，其判定只有经渲染它们的消费方才能到达模型；审计链与三态披露报告是宿主侧记录，绝不进入模型上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是当前包已登记的边界事实，不是任务清单。

- **判定核心受红线约束** — [`REDLINE-MANIFEST.conf`](../../../REDLINE-MANIFEST.conf) 中的十个文件不得超过 1216 逻辑行（由 `scripts/count-logical-lines.mjs` 检查，挂为 `check:redline` 门禁）；越线需要重设计，而非增量补丁。
- **哨兵只检测三类已登记矛盾形态** — 授权-审计不齐、双判定、豁免-契约冲突；哨兵全绿不构成一致性证明（检测器而非证明者的定位是有意为之），检出的矛盾冻结通道交人工裁定，不自动改写任何判定。
- **POSIX 原生桥缺口是登记而非闭合** — detached 子进程未设置 `PR_SET_PDEATHSIG`，父进程崩溃可能遗留受限孤儿；`openBeneathAtomically` 保持授权根的 realpath 语义而非完全封死。
- **Windows 受限通道依赖 runner 子进程** — write-restricted + Low integrity 拉起经 `@deepseek-ai/dsh-sandbox-windows-acl` 的 runner CLI，runner 在执行命令前失败会以坏沙箱退出码（127）呈现，runner 路径须与该包保持同步。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文：未决方向与开放问题。它明确不具备权威性——已交付的行为、边界与接受的依据存在于上文各节、包代码与所链接的档案中。

#### Future: strict-mode gradient rollout

`resolveCapabilityMode` 与 `gradientGate` 实现了严格模式灰度清算策略，但本仓库尚无组合挂载它们；在宿主接入之前，灰度方案与清算纪律保留在设计档案中。

</details>

**运行时不变量：** 每个效果判定在以 `assemblyPlanId` 为键的审计链中只增不改；本包没有任何模块会改写、自动修订或抹去已记录的判定。

> AI生成