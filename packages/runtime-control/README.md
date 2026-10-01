---
description: "The runtime-control package group: the enforcement library under packages/runtime-control/ that confines every fs/net/proc/env/MCP effect behind membranes, tokens, and one audited judgment point."
kind: "package-group"
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'e059aaec-8619-43bf-a5e4-02af58e53eeb'
  PropagateID: 'e059aaec-8619-43bf-a5e4-02af58e53eeb'
  ReservedCode1: 'be83f648-5b08-4c1d-af31-6cb7e9b70d4f'
  ReservedCode2: 'be83f648-5b08-4c1d-af31-6cb7e9b70d4f'
---

# packages/runtime-control

English | [中文](README.zh.md)

## Summary

The `runtime-control/` group owns runtime enforcement: service membranes, capability tokens, the effect system, isolation realms, approval semantics, sandbox profiles, the OS-native bridge, and the meta-discipline sentinels (consistency sentinel, independent rechecker, three-state disclosure). A host chooses it whenever a composed tree's fs, net, proc, env, or MCP effects must pass one audited judgment point instead of scattered provider defaults. The family currently consists of the runtime-control library itself; the assembly group owns the plan it enforces.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

One package delivers the enforcement roles today; the package README owns the exhaustive judgment-chain contracts.

| Package | Role | consumed by |
|---|---|---|
| [`runtime-control/`](runtime-control/README.md) | Runtime enforcement: membranes over `ctx`, the effect system with audit chains, approval, sandbox profiles, the OS-native bridge, and the meta layer | hosts composing agent runtimes from Cordis compositions |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the workspace package map for the grouping, then the plan producer this family enforces.

- [Package groups](../README.md) — how every package lives in exactly one family.
- [Assembly group](../assembly/README.md) — the plan-time family whose `planId` anchors this family's audit chains.
- [Runtime security architecture design](runtime-control/docs/cordis-runtime-security-architecture.zh.md) — the full Chinese design document behind the enforcement layer.
- [Assembly and runtime milestones](runtime-control/docs/cordis-assembly-runtime-milestones.zh.md) — the batch-by-batch implementation and adjudication archive.
- [Redline manifest](../../REDLINE-MANIFEST.conf) — the judgment-core file list and the complexity ceiling this family is bounded by.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

> AI生成