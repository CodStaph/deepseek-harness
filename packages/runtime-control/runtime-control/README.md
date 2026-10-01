---
description: "The runtime-control library for hosts composing agent runtimes: membranes, capability tokens, the effect system, isolation realms, approval semantics, sandbox profiles, the OS-native bridge, and meta-discipline sentinels behind every fs/net/proc/env/MCP effect."
kind: "package-library"
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '21150a13-4268-4a7f-bd66-33fd6c6a3c9c'
  PropagateID: '21150a13-4268-4a7f-bd66-33fd6c6a3c9c'
  ReservedCode1: '556999e4-f125-4e7b-b934-8a4a92edd411'
  ReservedCode2: '556999e4-f125-4e7b-b934-8a4a92edd411'
---

# @deepseek-ai/dsh-runtime-control

English | [中文](README.zh.md)

## Summary

The runtime-control layer confines every effect a composed agent can produce: filesystem, network, process, environment, and MCP calls pass through service membranes, capability tokens, and one effect system that turns each request into an allow, deny, or exemption verdict with audit. Hosts mount it through `installMembraneOnContext` over a Cordis `ctx.reflect.get`, or embed the handlers, the MCP runtime, and the OS-native sandbox bridge directly. The judgment core stays redline-bounded at 1,216 logical lines; meta-discipline modules (sentinel, rechecker, disclosure) detect inconsistency without ever auto-revising a verdict.

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

Hosts that assemble agent runtimes from Cordis compositions reach for this library when every fs, net, proc, env, or MCP call the tree can issue must pass one auditable judgment point instead of scattered provider defaults.

### When to choose it

Choose it when a composition runs model-authored or plugin-authored code whose effects need membranes, capability tokens, approval semantics, and a single violation policy. Choose plain provider packages instead when a composition only needs a capability seam without enforcement — this library is the enforcement, not the seam.

### Entry point

The smallest mounting path wraps a Cordis context so every service `ctx` resolves passes the membrane registry:

```ts
import { installMembraneOnContext, SENSITIVE_SERVICE_MEMBRANES, STANDARD_SERVICE_MEMBRANES, buildMembraneRegistry } from '@deepseek-ai/dsh-runtime-control'

installMembraneOnContext(ctx, {
  registry: buildMembraneRegistry([...STANDARD_SERVICE_MEMBRANES, ...SENSITIVE_SERVICE_MEMBRANES]),
})
```

Direct consumers embed the effect system (`createEffectApi` plus the fs/net/proc/env handlers), the approval service (`ApprovalService` with once/object/class grants), the MCP runtime (`McpRuntime` with `DshMcpClientAdapter` over `@modelcontextprotocol/client`), or the OS-native sandbox bridge (`createNativeOsBridge` with sha256 manifest verification before the first confined spawn). Success is a verdict and an audit entry per request; failure is a `SecurityViolation` or a denial with a structured reason — never a silent pass-through.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the three-layer discipline, the judgment chain, and the meta layer; the observable behavior is fully covered in [Use this package](#use-this-package).

### Three-layer discipline

The architecture separates the judgment kernel (this package's effect system and membranes), the proposers (LLM, policies, SMT — anything that may suggest), and the versioned knowledge base. The kernel layer is never automatic: it turns requests into verdicts and records why, and no module in this package rewrites a verdict after the fact. The audit chain every effect appends to carries `assemblyPlanId`, so the two books — the assembly plan from `@deepseek-ai/dsh-assembly` and the runtime effect audit — reconcile by plan id rather than by guesswork.

### The judgment chain

Each service `ctx` resolves goes through `installMembraneOnContext` (the registry wraps `ctx.reflect.get`, including direct `ctx.fs` reads), so a plugin cannot bypass its configured membrane by reaching around the service accessor. Effect requests (`fs`/`net`/`proc`/`env`/`mcp.call`) flow through four handler families into `createEffectApi`; exemptions are closed enumerated channels, and every verdict appends a `EffectAuditEntry` with the `assemblyPlanId` anchor. Violations reach `DefaultViolationHandler` (log-and-throw) or `IsolateViolationHandler` (escalation to a plugin-isolating tracker); approval follows the three-tier grant semantics with park/resume, timeout-as-deny, and provenance registry. MCP goes deeper than a single handler: `McpRuntime` owns server registration and lifecycle (unregistered servers are refused), `InboundRequestHandler` effectizes the three reverse-request kinds (sampling with model allowlists and byte budgets, roots intersected with the sandbox, elicitation under approval), and `checkExfiltration` scans outbound payloads before any bytes leave.

### Sandbox and native bridge

`makeSandboxProfile` and `SANDBOX_PROFILES` map an MCP server to a confinement tier; `confineCommand` and `minimalEnv` produce the command shape; `ESCAPE_CASES` and `RESIDUAL_RISK_REGISTRY` keep the residual-risk ledger explicit. The native bridge (`createNativeOsBridge`) implements the OS realm: Windows Job-object process trees through `@deepseek-ai/dsh-win32-process`, the write-restricted + Low-integrity child through the `@deepseek-ai/dsh-sandbox-windows-acl` runner, POSIX detached process groups with group kill, and sha256 manifest verification before the first spawn (fail-closed). `mirrorOpenBeneath` and `openBeneath` keep path traversal inside the granted roots.

### Meta discipline

The meta modules are detectors, not judges: `runSentinel` compares the grant book against the audit book and reports the three registered conflict kinds (grant-audit-mismatch, dual-verdict, exemption-conflict) with freeze suggestions; `recheckDecisions` recomputes sampled verdicts against an independent minimal criterion and yields `cross_checked` or `frozen`; `buildDisclosureReport` splits allowed / blocked / exempted and keeps timeout-denials distinct from user-denials. None of them changes a verdict on its own — a mismatch freezes the channel and hands the conflict to human adjudication. `meta/no-lob.ts` and `meta/root.ts` carry the No-Löb hard exclusion (meta callers can never assert about their own reliability) and the honest root-caller registration.

### Source map

| File | Role |
|---|---|
| [`src/membrane.ts`](src/membrane.ts) + [`src/membrane-config.ts`](src/membrane-config.ts) | The membrane primitive and the service registry with sensitive/standard profiles |
| [`src/capability.ts`](src/capability.ts) + [`src/issuer.ts`](src/issuer.ts) | Capability tokens with fiber derivation and pre-issuance planning |
| [`src/effect.ts`](src/effect.ts) + [`src/effects/`](src/effects/) | Effect types, the four handler families, the effect API, approval, MCP effects, and exfiltration checks |
| [`src/integration-cordis.ts`](src/integration-cordis.ts) | `installMembraneOnContext`: the membrane mounted over `ctx.reflect.get` |
| [`src/realm.ts`](src/realm.ts) + [`src/violation.ts`](src/violation.ts) | The whitelisted-require isolation realm and the violation policies with escalation |
| [`src/mcp/`](src/mcp/) | `McpRuntime`, the inbound reverse-request handler, and the `@modelcontextprotocol/client` adapter |
| [`src/sandbox/`](src/sandbox/) | Sandbox profiles, command confinement, escape cases, and the residual-risk registry |
| [`src/native/`](src/native/) | The OS-native bridge: Windows Job/ACL children, POSIX groups, manifest verification |
| [`src/skill/`](src/skill/) | Skill manifest parsing, unauthorized-directive scanning, and effect attribution |
| [`src/meta/`](src/meta/) | Sentinel, rechecker, disclosure, No-Löb exclusion, root-caller registration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Runtime-control group map](../README.md) — what the family owns and where each half lives.
- [Assembly library](../../assembly/assembly/README.md) — the plan producer whose `planId` anchors this package's audit chains.
- [The design archive](docs/cordis-runtime-security-architecture.zh.md) — the full Chinese design document this layer implements (membranes, effects, approval, sandbox, meta discipline, SEC catalog, redline ledger).
- [The milestone archive](docs/cordis-assembly-runtime-milestones.zh.md) — the batch-by-batch implementation and adjudication record behind the current code.
- [Redline manifest](../../../REDLINE-MANIFEST.conf) — the ten judgment-core files and the 1,216-logical-line ceiling this package is bounded by.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the composed approval and tool surfaces (the approval service, the fs/net/proc/env/MCP effect handlers) that render its verdicts, while this library registers no prompt, schema, or result text of its own.

#### KV Cache effect

None beyond the composed surfaces: the library contributes no catalog entry and no system-prompt fragment, and its verdicts reach a model only through the consumers that render them; audit chains and disclosure reports are host-side records, never model context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These boundaries are registered facts of the current package, not a task backlog.

- **The judgment core is redline-bounded** — the ten files in [`REDLINE-MANIFEST.conf`](../../../REDLINE-MANIFEST.conf) may not exceed 1,216 logical lines (checked by `scripts/count-logical-lines.mjs`, wired as the `check:redline` gate); growth past the ceiling requires redesign, not an incremental patch.
- **The sentinel detects only the three registered conflict kinds** — grant-audit-mismatch, dual-verdict, and exemption-conflict; a green sentinel run is not a proof of consistency (the detector-not-prover stance is deliberate), and a detected conflict freezes the channel for human adjudication without auto-revising any verdict.
- **POSIX native-bridge gaps are registered, not closed** — detached children do not set `PR_SET_PDEATHSIG`, so a parent crash can orphan a confined child, and `openBeneathAtomically` keeps the realpath semantics of the granted root rather than sealing them.
- **The Windows restricted channel rides a runner child process** — the write-restricted, Low-integrity spawn goes through the `@deepseek-ai/dsh-sandbox-windows-acl` runner CLI, so a runner that fails before executing the command surfaces as a broken-sandbox exit (127), and the runner path must stay in sync with that package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked archives.

#### Future: strict-mode gradient rollout

`resolveCapabilityMode` and `gradientGate` implement the strict-mode gray rollout policy, but no composition in this repository mounts them yet; the rollout plan and its clearing discipline stay in the design archive until a host opts in.

</details>

**Runtime invariant:** Every effect verdict is append-only in the audit chain keyed by `assemblyPlanId`; no module in this package rewrites, auto-revises, or erases a recorded verdict.

> AI生成