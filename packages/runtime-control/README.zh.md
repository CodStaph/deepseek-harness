---
description: "运行时管控包组：packages/runtime-control/ 下的强制库，把每一次 fs/net/proc/env/MCP 效果约束在膜、令牌与单一可审计判定点之后。"
kind: "package-group"
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '4ef46364-030e-42f9-aa36-5f6d3367e9b4'
  PropagateID: '4ef46364-030e-42f9-aa36-5f6d3367e9b4'
  ReservedCode1: '39cbe9f8-a21b-4306-b3ee-fd81f5812924'
  ReservedCode2: '39cbe9f8-a21b-4306-b3ee-fd81f5812924'
---

# packages/runtime-control

[English](README.md) | 中文

## 概述

`runtime-control/` 组拥有运行时强制：服务膜、能力令牌、效果系统、隔离域、审批语义、沙箱档位、OS 原生桥与元层哨兵（一致性哨兵、独立重算器、三态披露）。当组合树的 fs、net、proc、env 或 MCP 效果必须经过单一可审计判定点而非散落的提供方默认值时，宿主就选择它。该家族目前由运行时管控库自身构成；它所强制的计划由 assembly 组拥有。

## 目录

- [包列表](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包列表

今天由一个包承载强制角色；包 README 拥有完整的判定链契约。

| 包 | 角色 | 消费方 |
|---|---|---|
| [`runtime-control/`](runtime-control/README.zh.md) | 运行时强制：挂 `ctx` 的膜、带审计链的效果系统、审批、沙箱档位、OS 原生桥与元层 | 从 Cordis 组合组装智能体运行时的宿主 |

-----

<a id="related-documentation"></a>
## 相关文档

先看工作区包地图了解分组，再看该家族所强制的计划生产者。

- [包组索引](../README.zh.md) — 每个包如何恰好归属一个家族。
- [Assembly 组](../assembly/README.zh.md) — 其 `planId` 锚定本家族审计链的计划期家族。
- [运行时安全架构设计](runtime-control/docs/cordis-runtime-security-architecture.zh.md) — 强制层背后的完整中文设计文档。
- [装配与运行时里程碑](runtime-control/docs/cordis-assembly-runtime-milestones.zh.md) — 逐批次实施与裁定档案。
- [红线清单](../../REDLINE-MANIFEST.conf) — 约束本家族的判定核心文件清单与复杂度上限。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

> AI生成