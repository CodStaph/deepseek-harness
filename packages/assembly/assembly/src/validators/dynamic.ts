/**
 * 装配控制层 · 动态校验规则集（S6：挂载决策点四检查）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §4.2.2（动态校验，挂载期）
 * 阶段纪律：
 * - 本阶段为「镜像逻辑迁移」——忠实迁移 §4.2.2 的四项检查判定逻辑，输入统一为
 *   `DynamicValidationContext`（当前已激活服务集 + 挂载节点 + 已挂载节点列表），
 *   不接入 dsh 仓库真实挂载编排（那属 M1 收口的 S8 编排接线）。
 * - 使用 validators/types.ts 的 `Diagnostic`/`ValidationResult` 与
 *   validators/static.ts 的「一码一规则」写法；不新建重复类型、不越界实现 S8/挂载编排。
 * - 只依赖 resolver.ts 的类型层字段（EffectiveNode.contract.plane/isolate/provides/needs/optional、
 *   disabled、overrides），不修改 resolver.ts / plan.ts / contract.ts / cli.ts。
 * - 码位纪律：SEC-2001–2004（SEC 登记表 §5，一码一规则）；`kind` 与码位一一对应。
 *
 * 码位映射：
 * - SEC-2001 missing-dependency      挂载节点 N 的 `needs` 不在已注册集且非自身提供（依赖不可达，error）
 * - SEC-2002 duplicate-registration  N 的 `provides` 与已激活非 isolate 节点冲突（重复注册，error）
 * - SEC-2003 isolate-violation       挂载 isolate 域内提供的服务遮蔽 host 消费者所需路由（动态面，warning）
 * - SEC-2004 service-death           节点 unmount/disabled 后其 `provides` 仍被激活节点依赖（服务消亡告警，warning）
 *
 * 语义纪律（与 static.ts 一致）：失败时给出结构化诊断（返回诊断数组）而非裸 throw。
 * severity 档位：重复注册 / 缺失硬依赖 = error；isolate 遮蔽 / 服务消亡 = warning
 * （isolate 遮蔽与静态面 SEC-1012 档位一致）。
 */

import type { EffectiveNode } from '../resolver.ts'
import type { Diagnostic, ValidationResult } from './types.ts'

/** 潜在提供者未激活的原因（§4.2.2 结构化诊断 `potentialProviders` 字段） */
export type ProviderInactiveReason = 'disabled' | 'plane-mismatch' | 'overridden' | 'not-yet-mounted'

/** 动态校验的输入上下文（方案 §4.2.2 L490–499） */
export interface DynamicValidationContext {
  /** 当前已激活的节点 id 集合 */
  activeNodes: Set<string>
  /** 当前已注册的服务标识集合 */
  registeredServices: Set<string>
  /** 正在挂载的节点 */
  mountingNode: EffectiveNode
  /** 已挂载的节点列表 */
  mountedNodes: EffectiveNode[]
  /**
   * 卸载期可选入口：当本字段提供时，`runDynamicValidation` 额外触发 SEC-2004
   * 服务消亡检查（针对被 unmount/disabled 的节点）。缺省不触发。
   * 注：这是对 §4.2.2 上下文的合理扩展，为的是让统一入口能「汇总四检查诊断」
   *   而不破坏方案给出的四字段接口——是否保留此可选字段待主线确认。
   */
  leavingNode?: EffectiveNode
}

/** 动态诊断——在基类 Diagnostic 之上补 kind/缺失服务/消费者/潜在提供者 */
export interface DynamicDiagnostic extends Diagnostic {
  /** 动态校验诊断类型（与 SEC 码位一一对应） */
  kind: 'missing-dependency' | 'duplicate-registration' | 'isolate-violation' | 'service-death'
  /** SEC 码位（SEC-2001–2004，必填以承载一码一规则） */
  code: string
  /** 缺失的服务标识（SEC-2001） */
  missingService?: string
  /** 谁需要这个服务（SEC-2001 的 consumers = 挂载节点；SEC-2004 的 consumers = 依赖消费者） */
  consumers?: string[]
  /** 谁能提供但未激活，以及未激活原因（SEC-2001） */
  potentialProviders?: Array<{ nodeId: string; reason: ProviderInactiveReason }>
}

/** 结构化动态诊断构造器（severity/code/kind/message 必填，其余可选） */
function dyn(
  severity: DynamicDiagnostic['severity'],
  code: string,
  kind: DynamicDiagnostic['kind'],
  message: string,
  nodeId?: string,
  suggestion?: string,
): DynamicDiagnostic {
  const d: DynamicDiagnostic = { severity, code, kind, message }
  if (nodeId !== undefined) d.nodeId = nodeId
  if (suggestion !== undefined) d.suggestion = suggestion
  return d
}

/** 判断该提供者的契约是否被覆盖链改写（推断 `overridden` 原因） */
function hasContractOverride(node: EffectiveNode): boolean {
  return node.overrides.some((o) => o.changedFields.includes('contract'))
}

/**
 * 推断「能提供但未激活」的提供者未激活原因（§4.2.2 结构化诊断）：
 * - disabled        → 提供者自身被停用（node.disabled === true）
 * - plane-mismatch  → 提供者归属平面与挂载节点不同（跨平面路由不可达）
 * - overridden      → 提供者的契约被覆盖链改写（overrides 含 contract 变更）
 * - not-yet-mounted → 前两者均不成立，仅尚未挂载
 * 注：`disabled` 若为未求值的表达式节点（S4 求值面），挂载期动态判定取其生效后状态
 *   不在此处复求值，落入 `not-yet-mounted` 兜底。
 */
function inactiveProviderReason(provider: EffectiveNode, mounting: EffectiveNode): ProviderInactiveReason {
  if (provider.disabled === true) return 'disabled'
  if (provider.contract !== undefined && mounting.contract !== undefined && provider.contract.plane !== mounting.contract.plane) {
    return 'plane-mismatch'
  }
  if (hasContractOverride(provider)) return 'overridden'
  return 'not-yet-mounted'
}

/** 从 mountedNodes 中扫描「能提供某服务但未激活」的潜在提供者（SEC-2001 结构化诊断用） */
function findPotentialProviders(service: string, ctx: DynamicValidationContext): DynamicDiagnostic['potentialProviders'] {
  const out: DynamicDiagnostic['potentialProviders'] = []
  for (const p of ctx.mountedNodes) {
    if (p.id === ctx.mountingNode.id) continue
    if (!(p.contract?.provides ?? []).includes(service)) continue
    if (ctx.activeNodes.has(p.id)) continue // 已激活提供者不在「未激活」候选列
    out.push({ nodeId: p.id, reason: inactiveProviderReason(p, ctx.mountingNode) })
  }
  return out
}

/* ===================================================================================
 * 四检查
 * =================================================================================== */

/**
 * SEC-2001 missing-dependency（依赖可达性，挂载期）。
 * 挂载节点 N 的 `contract.needs` 中每个服务，须在 `registeredServices` 中、
 * 或由 N 自身 `contract.provides` 提供；否则缺失（error）。
 * 缺失时给出结构化诊断：missingService、consumers（=N 的 id）、
 * potentialProviders（扫描谁能提供但未激活并标注原因）。
 * 来源：方案 §4.2.2 检查 1。
 */
export function checkMissingDependency(ctx: DynamicValidationContext): DynamicDiagnostic[] {
  const out: DynamicDiagnostic[] = []
  const n = ctx.mountingNode
  const selfProvides = new Set(n.contract?.provides ?? [])
  for (const need of n.contract?.needs ?? []) {
    if (ctx.registeredServices.has(need) || selfProvides.has(need)) continue
    const potential = findPotentialProviders(need, ctx)
    const d: DynamicDiagnostic = dyn(
      'error',
      'SEC-2001',
      'missing-dependency',
      `挂载节点 ${n.id} 的硬依赖 ${need} 未在已注册服务集且非自身提供（依赖不可达）`,
      n.id,
      `补充挂载提供 ${need} 的节点，或将 ${need} 移入 optional`,
    )
    d.missingService = need
    d.consumers = [n.id]
    if (potential !== undefined && potential.length > 0) d.potentialProviders = potential
    out.push(d)
  }
  return out
}

/**
 * SEC-2002 duplicate-registration（重复注册，挂载点）。
 * 挂载节点 N 的 `contract.provides` 与「已激活的非 isolate 节点」冲突——
 * 同一服务被两个非 isolate 节点提供（isolate 提供者不构成冲突）。error 级。
 * 来源：方案 §4.2.2 检查 2；与 S3 SEC-1009 静态面同语义，此处对「当前已激活集」做动态判定。
 */
export function checkDuplicateRegistration(ctx: DynamicValidationContext): DynamicDiagnostic[] {
  const out: DynamicDiagnostic[] = []
  const n = ctx.mountingNode
  for (const svc of n.contract?.provides ?? []) {
    for (const p of ctx.mountedNodes) {
      if (p.id === n.id) continue
      if (!ctx.activeNodes.has(p.id)) continue // 只与已激活提供者冲突
      if (p.contract?.isolate) continue // isolate 提供者不算冲突
      if (!(p.contract?.provides ?? []).includes(svc)) continue
      out.push(
        dyn(
          'error',
          'SEC-2002',
          'duplicate-registration',
          `挂载节点 ${n.id} 提供的服务 ${svc} 与已激活非 isolate 节点 ${p.id} 重复注册`,
          n.id,
          '仅保留一个非 isolate 提供者，或将冲突节点置 isolate',
        ),
      )
    }
  }
  return out
}

/**
 * SEC-2003 isolate-violation（isolate 遮蔽，动态面，挂载点）。
 * 挂载节点 N 为 isolate 域内，其 `contract.provides` 中的服务遮蔽了
 * 「已激活 host 平面消费者」所需路由（复用 S3 SEC-1012 静态面的思想，
 * 但在挂载决策点对「当前已激活集」做动态判定）。warning 级。
 * 来源：方案 §4.2.2 检查 3。
 */
export function checkIsolateViolation(ctx: DynamicValidationContext): DynamicDiagnostic[] {
  const out: DynamicDiagnostic[] = []
  const n = ctx.mountingNode
  if (!n.contract?.isolate) return out
  for (const svc of n.contract.provides) {
    for (const c of ctx.mountedNodes) {
      if (c.id === n.id) continue
      if (!ctx.activeNodes.has(c.id)) continue // 只评估当前激活消费者
      if (c.contract?.plane !== 'host') continue
      if (!(c.contract?.needs ?? []).includes(svc)) continue
      out.push(
        dyn(
          'warning',
          'SEC-2003',
          'isolate-violation',
          `isolate 域 ${n.id} 提供服务 ${svc}，遮蔽 host 消费者 ${c.id} 所需路由`,
          n.id,
          '核对是否需在 host 面提供该服务，或隔离域是否应独立',
        ),
      )
    }
  }
  return out
}

/**
 * SEC-2004 service-death（服务消亡告警，卸载期）。
 * 节点 unmount/disabled 后，其 `contract.provides` 中是否有「仍激活节点」依赖。
 * 独立入口（卸载场景）：`checkServiceDeath(leavingNode, activeNodes, mountedNodes)`。
 * warning 级——服务消亡不阻断卸载，仅提示消费者将失去路由。
 * 来源：方案 §4.2.2 检查 4。
 */
export function checkServiceDeath(
  leavingNode: EffectiveNode,
  activeNodes: Set<string>,
  mountedNodes: readonly EffectiveNode[],
): DynamicDiagnostic[] {
  const out: DynamicDiagnostic[] = []
  const affectedConsumers: string[] = []
  for (const svc of leavingNode.contract?.provides ?? []) {
    for (const c of mountedNodes) {
      if (c.id === leavingNode.id) continue
      if (!activeNodes.has(c.id)) continue
      if (!(c.contract?.needs ?? []).includes(svc)) continue
      if (!affectedConsumers.includes(c.id)) affectedConsumers.push(c.id)
      out.push(
        dyn(
          'warning',
          'SEC-2004',
          'service-death',
          `节点 ${leavingNode.id} unmount/disabled 后，其提供的服务 ${svc} 仍被激活节点 ${c.id} 依赖`,
          leavingNode.id,
          '先迁移/替换该服务的消费者路由，再执行卸载',
        ),
      )
    }
  }
  if (affectedConsumers.length > 0) {
    const head = out[0]
    if (head) head.consumers = affectedConsumers
  }
  return out
}

/* ===================================================================================
 * 统一入口
 * =================================================================================== */

/**
 * 动态校验统一入口（方案 §4.2.2 挂载期执行点）。
 * 汇总四检查诊断（error 与 warning 混列，按 severity 区分）。
 * SEC-2001/2002/2003 始终执行；SEC-2004 仅在 `ctx.leavingNode` 携带时可选触发。
 */
export function runDynamicValidation(ctx: DynamicValidationContext): ValidationResult {
  const diagnostics: DynamicDiagnostic[] = []
  diagnostics.push(...checkMissingDependency(ctx))
  diagnostics.push(...checkDuplicateRegistration(ctx))
  diagnostics.push(...checkIsolateViolation(ctx))
  if (ctx.leavingNode !== undefined) {
    diagnostics.push(...checkServiceDeath(ctx.leavingNode, ctx.activeNodes, ctx.mountedNodes))
  }
  return { diagnostics }
}