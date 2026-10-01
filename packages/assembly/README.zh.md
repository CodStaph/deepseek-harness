---
description: "装配包组：packages/assembly/ 下的计划期组合构建与校验，面向需要在启动前完成 cordis.yml 树检查与审计的宿主。"
kind: "package-group"
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'bd24a221-3e92-424e-ba0d-5cd7499d015b'
  PropagateID: 'bd24a221-3e92-424e-ba0d-5cd7499d015b'
  ReservedCode1: '8d35b34f-c7dc-466d-b55e-a2786868e086'
  ReservedCode2: '8d35b34f-c7dc-466d-b55e-a2786868e086'
---

# packages/assembly

[English](README.md) | 中文

## 概述

`assembly/` 组拥有计划期组合：把分层 `cordis.yml` 源展开为有效节点，执行静态与动态校验，产出安全审计，并附上以 `planId` 为键的能力预颁发。当组合必须在启动前 fail-closed 而非首次挂载时才失败，宿主就选择它。该家族目前由装配库自身构成；计划被接受后发生的一切由 runtime-control 组拥有。

## 目录

- [包列表](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包列表

今天由一个包承载计划期角色；包 README 拥有完整的管线契约。

| 包 | 角色 | 消费方 |
|---|---|---|
| [`assembly/`](assembly/README.zh.md) | 计划期组合：分层展开、静态与动态校验、安全审计、以 `planId` 为键的能力预颁发 | 宿主配置工具（`dsh config`、仓库配置门） |

-----

<a id="related-documentation"></a>
## 相关文档

先看工作区包地图了解分组，再看该计划所供的强制家族。

- [包组索引](../README.zh.md) — 每个包如何恰好归属一个家族。
- [Runtime-control 组](../runtime-control/README.zh.md) — 按 `planId` 对账审计链的强制侧。
- [装配控制层设计](assembly/docs/cordis-assembly-control-architecture.zh.md) — 管线背后的完整中文设计文档。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

> AI生成