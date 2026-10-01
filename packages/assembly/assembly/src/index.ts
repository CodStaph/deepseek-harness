/**
 * 装配控制层 · 对外入口
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §7.2（核心接口汇总）
 * 阶段：S1（骨架与契约）+ 批次 1b 并入（S2 展开器与 CLI / S3 静态校验 13 条 /
 *       S4 !!js 白名单求值器 / S5 信任源与敏感保护 / S7 审计链写入）
 *     + 批次 1c 并入（S6 动态校验，挂载决策点四检查；S12 效果系统）
 *     + 批次 1d 并入（S8 verify-* 收敛：`dryRun()` 从显式抛未实现改为真实装配管线
 *       四段式编排；导出 `buildDryRunPlan` 供 CLI 层与测试复用）
 *     + M1 收口并入（`assemble()` 落地：干跑全链 + 放行门禁，产出已验证装配计划）。
 */

import type { AssemblyPlan, AssemblyStatus, CapabilityGrantPlan } from './plan.ts'
import type { EffectiveNode, CompositionLayer, TrustLevel, SensitiveViolation } from './resolver.ts'
import type { Diagnostic, ValidationResult } from './validators/types.ts'
import type { DynamicValidationContext } from './validators/dynamic.ts'
import type { TrustSource } from './security/trust.ts'

import { expandLayers, buildCompositionGraph, SensitiveOverrideError } from './resolver.ts'
import { makePlanId } from './plan.ts'
import { runStaticValidation } from './validators/static.ts'
import { runDynamicValidation } from './validators/dynamic.ts'
import { buildSecurityAudit } from './security/audit.ts'
import { buildCapabilityGrantPlan } from './capability-grants.ts'
import { isSourceAllowed, DEFAULT_TRUST_POLICY } from './security/trust.ts'
import { loadLayers, defaultExpandOptions } from './cli.ts'

export type {
  PluginContract,
  CapabilityDeclaration,
  FsCapability,
  NetworkCapability,
  ProcessCapability,
  EnvCapability,
  EventCapability,
  McpCapability,
} from './contract.ts'

export type {
  AssemblyPlan,
  CompositionGraph,
  GraphNode,
  GraphEdge,
  CapabilityGrantPlan,
  TokenGrant,
  AssemblyStatus,
} from './plan.ts'

export type {
  EffectiveNode,
  CompositionLayer,
  LoaderEntry,
  ExpressionNode,
  OverrideRecord,
  TrustLevel,
  SensitivePath,
  SensitiveViolation,
  ExpandOptions,
  LayerDiffEntry,
} from './resolver.ts'

export { expandLayers, diffLayers, buildCompositionGraph, SensitiveOverrideError } from './resolver.ts'

export type { CapabilityGrantOptions, CapabilityGrantResult } from './capability-grants.ts'
export {
  buildCapabilityGrantPlan,
  filterAllowedMethods,
  declaredCapabilities,
  matchesCapability,
  SESSION_TIMEOUT_MS,
} from './capability-grants.ts'

export type { CliCommand, CliOptions } from './cli.ts'
export { parseArgv, loadLayers, run, dryRunExitCode, planStatus, defaultSafeEvalContext, defaultExpandOptions } from './cli.ts'

export type { JsExpr, YamlLayerSpec } from './adapter-cordis-yaml.ts'
export { loadCordisYaml, isJsExpr, loadLayersFromYaml, isYamlConfigFile } from './adapter-cordis-yaml.ts'

export type { StaticValidationRule, StaticValidationContext } from './validators/static.ts'
export { staticRules, runStaticValidation } from './validators/static.ts'

export type { DynamicValidationContext, DynamicDiagnostic, ProviderInactiveReason } from './validators/dynamic.ts'
export {
  checkMissingDependency,
  checkDuplicateRegistration,
  checkIsolateViolation,
  checkServiceDeath,
  runDynamicValidation,
} from './validators/dynamic.ts'

export type { Diagnostic, ValidationResult } from './validators/types.ts'
export type { AuditEntry, SecurityAudit } from './security/audit.ts'
export { AUDIT_LOG_FILENAME, auditLogPath, formatAuditEntry, appendAuditEntry, readAuditLog, buildSecurityAudit } from './security/audit.ts'

export type { TrustPolicy, TrustLevelConfig } from './security/trust.ts'
export { DEFAULT_TRUST_POLICY, isSourceAllowed, allowedSourcesFor } from './security/trust.ts'

export type { LayerSource } from './security/sensitive.ts'
export { SENSITIVE_PATHS, checkSensitiveOverride } from './security/sensitive.ts'

export type { SafeEvalContext, SafeEvalViolation, AllowedSyntax, ForbiddenSyntax, AllowedEnvKey } from './security/safe-eval.ts'
export {
  ALLOWED_SYNTAX,
  FORBIDDEN_SYNTAX,
  ALLOWED_ENV_KEYS,
  validateExpression,
  evaluateJs,
  safeEvaluateExpression,
  SafeEvalError,
  toDiagnostic,
} from './security/safe-eval.ts'

/**
 * 装配输入——覆盖链源与运行时环境。
 * S2 展开器落地时扩展为完整的层解析输入（层文件路径、信任等级推导、运行时上下文）。
 */
export interface AssemblyInput {
  /** 覆盖链各层的源文件路径（S2 解析器消费） */
  sources: readonly string[]
}

/** 装配输出——管线第 8 步产出（方案 §7.3） */
export interface AssemblyOutput {
  /** 已验证装配计划 */
  plan: AssemblyPlan
  /** 管线状态 */
  status: AssemblyStatus
  /** error 级诊断（放行门禁：空数组 = 可挂载） */
  errors: Diagnostic[]
}

/**
 * 装配配置——信任策略与安全开关。
 * S2–S5 落地时补白名单 env key、信任源策略、敏感路径登记等配置面。
 */
export interface AssemblyConfig {
  /** `--lenient-capabilities` 灰度标志（S11 引入；缺省 false = 严格） */
  lenientCapabilities?: boolean
}

/**
 * 信任等级排序（trusted > user > preset > patch）；仅作 `nodeTrustLevels` 的内部秩判定。
 */
const TRUST_RANK: Record<TrustLevel, number> = { patch: 0, preset: 1, user: 2, trusted: 3 }

/**
 * 推导每个节点的信任等级——取覆盖链中定义该节点（id）的最高信任层。
 * 用于安全审计的信任源检查（S5 信任面）；镜像阶段节点来源缺省 workspace。
 */
function nodeTrustLevels(nodes: readonly EffectiveNode[], layers: readonly CompositionLayer[]): Map<string, TrustLevel> {
  const rank = new Map<string, { level: TrustLevel; r: number }>()
  for (const layer of layers) {
    for (const entry of layer.entries) {
      const cur = rank.get(entry.id)
      const r = TRUST_RANK[layer.trustLevel]
      if (!cur || r > cur.r) rank.set(entry.id, { level: layer.trustLevel, r })
    }
  }
  const out = new Map<string, TrustLevel>()
  for (const n of nodes) {
    const got = rank.get(n.id)
    out.set(n.id, got?.level ?? 'user')
  }
  return out
}

/**
 * 最小信任源检查（S5 信任面，镜像）。
 * 镜像阶段层文件不携带真实包来源（workspace/vendor/signed/arbitrary），
 * 统一按缺省来源 workspace 判定——workspace 在各信任等级均被允许，
 * 故缺省不产诊断；并入 dsh 后按真实 provenance 注入来源再判定。
 * SEC 码位：本阶段不新增码位；信任诊断在此不发射（默认 workspace 恒放行），
 * 真实来源接入时登记专用码位（SEC 登记表 §5.11.1 信任语义准入面）。
 */
function trustDiagnostics(nodes: readonly EffectiveNode[], layers: readonly CompositionLayer[]): Diagnostic[] {
  const trustByNode = nodeTrustLevels(nodes, layers)
  const out: Diagnostic[] = []
  for (const n of nodes) {
    const level = trustByNode.get(n.id) ?? 'user'
    const source: TrustSource = 'workspace'
    if (!isSourceAllowed(DEFAULT_TRUST_POLICY, level, source)) {
      out.push({
        severity: 'error',
        message: `节点 ${n.id} 的来源 ${source} 不被信任等级 ${level} 允许`,
        nodeId: n.id,
      })
    }
  }
  return out
}

/**
 * 动态校验「逐个节点挂载」模拟（S6 → S8 编排接线）。
 * 对每个节点分别作为 `mountingNode` 跑 `runDynamicValidation`，模拟挂载期四检查，
 * 累计并按（code|nodeId|message）去重，得到整条装配线的动态校验诊断。
 * 上下文：registeredServices = 全部节点 provides 并集；activeNodes/mountedNodes = 全部节点。
 */
export function simulateDynamicValidation(nodes: readonly EffectiveNode[]): Diagnostic[] {
  const registeredServices = new Set<string>()
  for (const n of nodes) for (const s of n.contract?.provides ?? []) registeredServices.add(s)
  const activeNodes = new Set(nodes.map((n) => n.id))
  const mountedNodes = [...nodes]
  const seen = new Map<string, Diagnostic>()
  for (const n of nodes) {
    const ctx: DynamicValidationContext = { activeNodes, registeredServices, mountedNodes, mountingNode: n }
    for (const d of runDynamicValidation(ctx).diagnostics) {
      const key = `${d.code}|${d.nodeId}|${d.message}`
      if (!seen.has(key)) seen.set(key, d)
    }
  }
  return [...seen.values()]
}

/** 敏感覆盖拒绝（S5，装载中止）→ 装配计划 security 诊断（复用 SEC-1013，不新增码位） */
function sensitiveDenyDiag(v: SensitiveViolation): Diagnostic {
  return {
    severity: 'error',
    code: 'SEC-1013',
    message: v.message,
    nodeId: v.nodeId,
    fieldPath: v.field,
  }
}

/** 空能力令牌计划（敏感覆盖中止时返回，避免未定义） */
function emptyGrants(): CapabilityGrantPlan {
  return { grants: new Map() }
}

/**
 * 干跑真实管线——四段式编排（S8 收口，供 `AssemblyController.dryRun` 与 CLI 接线共用）。
 * 段序：展开（loadLayers + expandLayers）→ 静态校验（S3）→ 动态校验（S6，逐个节点挂载）
 *       → 安全审计（信任源检查）→ 能力令牌预颁发计划（S11）。
 * 失败语义：除 `loadLayers` 文件读取失败外一律不抛出——敏感覆盖（S5）以 SEC-1013 诊断
 *       装载中止，其余以 status + diagnostics 呈现。
 */
export function buildDryRunPlan(input: AssemblyInput, config: AssemblyConfig = {}): AssemblyPlan {
  const layers = loadLayers(input.sources)
  let nodes: EffectiveNode[]
  try {
    nodes = expandLayers(layers, defaultExpandOptions())
  } catch (error) {
    if (error instanceof SensitiveOverrideError) {
      const security = buildSecurityAudit(error.violations.map(sensitiveDenyDiag))
      return {
        planId: makePlanId(),
        nodes: [],
        graph: buildCompositionGraph([]),
        validation: { diagnostics: [] },
        security,
        capabilities: emptyGrants(),
        timestamp: new Date().toISOString(),
        layers,
      }
    }
    throw error
  }

  const graph = buildCompositionGraph(nodes)
  const staticResult = runStaticValidation(nodes, graph)
  const dynamicDiags = simulateDynamicValidation(nodes)
  const validation: ValidationResult = { diagnostics: [...staticResult.diagnostics, ...dynamicDiags] }
  const security = buildSecurityAudit(trustDiagnostics(nodes, layers))
  const capabilities = buildCapabilityGrantPlan(nodes, {
    ...(config.lenientCapabilities !== undefined ? { lenientCapabilities: config.lenientCapabilities } : {}),
  }).plan
  return { planId: makePlanId(), nodes, graph, validation, security, capabilities, timestamp: new Date().toISOString(), layers }
}

/**
 * 装配控制层主入口。
 *
 * 实现状态（随批次推进逐阶段填充）：
 * - `expand()`  → ✅ S2 已落地（批次 1b）：多层覆盖链摊平 + S4 受限求值 + S5 敏感覆盖保护接线
 * - `dryRun()`  → ✅ S8 已落地（批次 1d）：真实装配管线四段式编排（展开 + 静态 + 动态 + 安全 + 令牌计划）
 * - `assemble()`→ ✅ M1 收口已接线：干跑全链 + 放行门禁，产出已验证装配计划（真实挂载编排在并入 dsh 后）
 */
export class AssemblyController {
  private readonly config: AssemblyConfig

  constructor(config: AssemblyConfig = {}) {
    this.config = config
  }

  /** 展开有效配置（多层覆盖链摊平 + 覆盖历史 + S4 求值 + S5 敏感保护）——S2 ✅ */
  async expand(input: AssemblyInput): Promise<EffectiveNode[]> {
    const layers = loadLayers(input.sources)
    return expandLayers(layers, defaultExpandOptions())
  }

  /** 干跑：展开 + 静态校验 + 动态校验 + 安全审计 + 令牌预颁发计划，不实际挂载——S8 ✅ */
  async dryRun(input: AssemblyInput): Promise<AssemblyPlan> {
    return buildDryRunPlan(input, this.config)
  }

  /**
   * 完整装配（干跑通过后产出可执行装配程序）——M1 收口 ✅。
   * 管线（方案 §7.3 第 8 步）：干跑全链 + 放行门禁。status 派生与 CLI `planStatus`
   * 同口径：validation 有 error → 'validation-error'；security 有 error →
   * 'security-denied'；否则 'success'；errors = error 级诊断全集（空 = 可挂载）。
   *
   * 镜像诚实边界：真实挂载执行（装膜/发令牌/apply 插件，方案 §7.3 第 9–11 步）属
   * 并入 dsh 后的 Cordis 编排，镜像内不重复实现挂载——assemble 产出的是"已验证
   * 可挂载装配程序"，不是挂载动作本身。
   */
  async assemble(input: AssemblyInput): Promise<AssemblyOutput> {
    const plan = buildDryRunPlan(input, this.config)
    const status: AssemblyStatus =
      plan.validation.diagnostics.some((d) => d.severity === 'error') ? 'validation-error'
      : plan.security.diagnostics.some((d) => d.severity === 'error') ? 'security-denied'
      : 'success'
    const errors: Diagnostic[] = [
      ...plan.validation.diagnostics.filter((d) => d.severity === 'error'),
      ...plan.security.diagnostics.filter((d) => d.severity === 'error'),
    ]
    return { plan, status, errors }
  }
}