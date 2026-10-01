---
description: "The assembly library that turns layered cordis.yml sources into a validated, audited composition plan whose planId anchors the runtime-control effect-audit chains."
kind: "package-library"
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '0bb4a577-94ea-4b9d-8c1b-5cadcedadbb9'
  PropagateID: '0bb4a577-94ea-4b9d-8c1b-5cadcedadbb9'
  ReservedCode1: 'f43be63a-9578-4575-8afe-3c122a674b89'
  ReservedCode2: 'f43be63a-9578-4575-8afe-3c122a674b89'
---

# @deepseek-ai/dsh-assembly

English | [中文](README.zh.md)

## Summary

Build and validate a Cordis composition before anything runs: expand layered `cordis.yml` sources into effective nodes, run static and dynamic validation, produce a security audit with sensitive-override protection, and hand out a pre-issued capability plan keyed by `planId`. The CLI entry drives the same pipeline for `dsh config` with stable exit codes and `--dry-run` reporting. Consumers embed `buildDryRunPlan` or `AssemblyController` directly; every plan this library emits is the anchor the runtime-control effect-audit chains reconcile against.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Hosts that need a composition checked and audited before boot reach for this library: it is the plan producer that runs ahead of every mount.

### When to choose it

Choose it when a composition must fail closed at assembly time — unresolvable layers, malformed entries, or sensitive overrides surface as SEC-coded diagnostics before a single service starts. Choose plain Cordis loading instead when a host trusts its configuration source and needs no security audit or capability pre-plan.

### Entry point

The smallest path expands and validates a layered composition:

```ts
import { loadLayersFromYaml, buildDryRunPlan } from '@deepseek-ai/dsh-assembly'

const layers = loadLayersFromYaml(['base.cordis.yml', 'override.cordis.yml'])
const plan = buildDryRunPlan({ layers })
if (plan.status !== 'ok') {
  for (const diagnostic of plan.validation) console.error(diagnostic.code, diagnostic.message)
}
```

Success is a plan carrying `planId`, effective nodes, the composition graph, validation results, a security audit, and a capability pre-issue; failure is a typed diagnostic list with stable SEC codes (`SEC-1001`–`SEC-1014` static, `SEC-2001`–`SEC-2003` dynamic) — never a partial boot. The same pipeline powers `dsh config --expand` / `--dry-run` (boot-free, exit code 0/1 by `dryRunExitCode`).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the pipeline order and the trust model; the observable behavior is fully covered in [Use this package](#use-this-package).

### Pipeline order

`loadLayers`/`loadLayersFromYaml` parse layered sources (`adapter-cordis-yaml.ts` flattens `insert` rows, preserves `group` blocks, tolerates id-only disabled rows, and keeps `!!js` expressions); `expandLayers` resolves them into effective nodes; `buildCompositionGraph` derives the dependency graph; static validation (`validators/static.ts`) rejects the registered error classes with SEC codes; dynamic validation (`simulateDynamicValidation`) runs the same evaluation against plan-time facts; `buildSecurityAudit` produces the audit ledger with sensitive-override protection (`security/sensitive.ts`, `security/trust.ts`); and the capability pre-issue (`plan.ts`, `index.ts`) attaches `makePlanId()` to every plan. `AssemblyController` orchestrates the sequence; `cli.ts` exposes it with stable exit codes, and `verify-cordis-config.ts` in the host repo folds the assembly gate into the config verification script so every assemblable `cordis.yml` in the repository is dry-run-checked as part of hygiene.

### Trust model

The plan is a proposal, never an executor: it names what would run and under which capabilities, and the runtime side (`@deepseek-ai/dsh-runtime-control`) owns every actual verdict. The two books reconcile through the mutual `planId`/`assemblyPlanId` anchor — the assembly's audit ledger and the runtime's effect audit chain point at the same plan identity, so any later enforcement decision can be traced back to the plan that pre-issued its capabilities.

### Source map

| File | Role |
|---|---|
| [`src/resolver.ts`](src/resolver.ts) | Layer expansion, composition diff/graph, sensitive-override rejection |
| [`src/adapter-cordis-yaml.ts`](src/adapter-cordis-yaml.ts) | `cordis.yml` parsing: insert flattening, group preservation, `!!js` handling |
| [`src/validators/static.ts`](src/validators/static.ts) | Static validation with SEC-coded diagnostics |
| [`src/security/`](src/security/) | Audit ledger, trust policy, sensitive-path protection |
| [`src/plan.ts`](src/plan.ts) | `makePlanId` and the capability pre-issue attached to every plan |
| [`src/index.ts`](src/index.ts) | `buildDryRunPlan` and `AssemblyController` over the pipeline |
| [`src/cli.ts`](src/cli.ts) | `dsh config` entry: `loadLayers`, `run`, `dryRunExitCode`, `planStatus` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Assembly group map](../README.md) — what the family owns and where each half lives.
- [Runtime-control library](../../runtime-control/runtime-control/README.md) — the enforcement side that consumes this package's plans and reconciles its audit chains by `planId`.
- [The design archive](docs/cordis-assembly-control-architecture.zh.md) — the full Chinese design document for the assembly control layer (layer expansion, validation gates, security audit, capability pre-issue).

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the composed `cordis_run`/`cordis_stop` surfaces that mount what this library validates, while this library itself registers no prompt, schema, or result text and runs entirely before boot.

#### KV Cache effect

None beyond the composed surfaces: assembly runs at configuration time and contributes no catalog entry, no system-prompt fragment, and no per-tool text; its diagnostics reach a model only when a host renders them through its own surfaces.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These boundaries are registered facts of the current package, not a task backlog.

- **Dynamic validation is plan-time simulation, not execution** — `simulateDynamicValidation` evaluates registered behaviors against plan-time facts; anything that only manifests at runtime (provider liveness, environment drift) is outside what the plan can reject, and the plan's capabilities are pre-issues the runtime may still deny.
- **`!!js` expressions are carried, not analyzed** — YAML layers may embed JavaScript expressions that are preserved verbatim for the loader; this library does not evaluate or constrain them, so a composition's expression safety is the owning layer's responsibility.
- **The assembly gate covers assemblable files only** — repository hygiene dry-runs the `cordis.yml` files that parse as assembly inputs; a malformed file that fails parsing is reported as unparseable rather than receiving assembly diagnostics.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked archives.

#### Future: plan-time schema tightening

Whether the static layer should reject additional config-shape families (beyond the current SEC-coded set) before dynamic simulation is an open direction; any addition must extend the registered SEC catalog first, not grow ad-hoc checks.

</details>

**Runtime invariant:** Every emitted plan carries a fresh `planId` and an append-only audit ledger; the assembly never rewrites history in a superseded plan — a changed composition produces a new plan identity.

> AI生成