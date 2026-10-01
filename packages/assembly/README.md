---
description: "The assembly package group: plan-time composition building and validation under packages/assembly/, for hosts that need a cordis.yml tree checked and audited before boot."
kind: "package-group"
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '53ef4d41-52b5-4bc9-a728-a923dbbb8e47'
  PropagateID: '53ef4d41-52b5-4bc9-a728-a923dbbb8e47'
  ReservedCode1: 'fc62df2c-ce1c-42b5-82bd-48e9ee0d9c52'
  ReservedCode2: 'fc62df2c-ce1c-42b5-82bd-48e9ee0d9c52'
---

# packages/assembly

English | [中文](README.zh.md)

## Summary

The `assembly/` group owns plan-time composition: expanding layered `cordis.yml` sources into effective nodes, validating the result statically and dynamically, producing the security audit, and attaching the capability pre-issue keyed by `planId`. A host chooses it whenever a composition must fail closed before boot rather than at first mount. The family currently consists of the assembly library itself; the runtime-control group owns what happens after the plan is accepted.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

One package delivers the plan-time roles today; the package README owns the exhaustive pipeline contracts.

| Package | Role | consumed by |
|---|---|---|
| [`assembly/`](assembly/README.md) | Plan-time composition: layer expansion, static and dynamic validation, security audit, capability pre-issue keyed by `planId` | host config tooling (`dsh config`, the repository config gate) |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the workspace package map for the grouping, then the enforcement family this plan feeds.

- [Package groups](../README.md) — how every package lives in exactly one family.
- [Runtime-control group](../runtime-control/README.md) — the enforcement side that reconciles its audit chains against this group's `planId`.
- [Assembly control layer design](assembly/docs/cordis-assembly-control-architecture.zh.md) — the full Chinese design document behind the pipeline.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

> AI生成