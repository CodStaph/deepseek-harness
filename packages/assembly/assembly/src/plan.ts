/**
 * 装配控制层 · 装配计划类型
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §4.1.3（AssemblyPlan/CompositionGraph）、
 *       §5.2.3（CapabilityGrantPlan/TokenGrant）、§7.3（管线产出）
 * 阶段：S1（骨架）——装配计划是装配控制层的最终输出、运行时管控层的输入（方案 §3.3）。
 *
 * "类型先行"解锁点（里程碑规划 §3.2）：本文件完成后，M2 运行时线即可基于
 * 这些类型 + mock 装配计划开发令牌预颁发器（S11），M1 收口后联调接线。
 *
 * 注意：resolver.ts 在 S1 阶段为纯类型文件（展开逻辑随 S2 落地）——
 *       M2 线在此之前以 mock 节点填充 nodes 字段。
 */

import type { PluginContract } from './contract.ts'
import type { ValidationResult } from './validators/types.ts'
import type { SecurityAudit } from './security/audit.ts'
import type { EffectiveNode, CompositionLayer } from './resolver.ts'

/**
 * 装配计划唯一标识（S23 / §5.11.4 互指键唯一载体移植）。
 * 装配审计链与效果审计链两本账通过 planId 互指对账（R41）——
 * 三态披露（§5.11.7）与收尾自检（§5.6）据此重建"哪个装配计划下的哪些效果"。
 * 采用时间戳摘要格式：`plan-<ISO 摘要>`，保证一次装配一个稳定标识。
 */
export function makePlanId(now: string = new Date().toISOString()): string {
  // ISO 时间戳（如 2026-10-01T08:00:00.000Z）→ 压缩为无歧义标识（去冒号/点/T/Z，短横线保留日期分段）
  return `plan-${now.replace(/[:.]/g, '-').replace(/Z$/, '')}`
}

/** 装配计划——装配控制层的最终输出（已验证、可执行、带来源标注的装配程序） */
export interface AssemblyPlan {
  /** 装配计划唯一标识——装配/效果两本审计账互指的锚点（§5.11.4，S5 移植落地）。
   *  可选：既有测试/手工构造未填时兼容；运行时互指对账依赖此字段（R41） */
  planId?: string
  /** 方案 §4.1.3 原始字段（下方保持原序，planId 仅新增在上方） */
  /** 展开后的有效配置节点列表 */
  nodes: EffectiveNode[]
  /** 装配图（依赖关系） */
  graph: CompositionGraph
  /** 校验结果 */
  validation: ValidationResult
  /** 安全审计结果 */
  security: SecurityAudit
  /** 能力令牌预颁发计划（v2 新增） */
  capabilities: CapabilityGrantPlan
  /** 装配时间戳 */
  timestamp: string
  /** 覆盖链摘要 */
  layers: CompositionLayer[]
}

/** 装配依赖图 */
export interface CompositionGraph {
  /** 节点列表 */
  nodes: GraphNode[]
  /** 边列表（依赖关系） */
  edges: GraphEdge[]
  /** 环检测结果 */
  hasCycle: boolean
  /** 孤立服务列表 */
  orphans: string[]
}

export interface GraphNode {
  id: string
  plane: 'host' | 'preset' | 'session'
  provides: string[]
  needs: string[]
  optional: string[]
  isolate: boolean
}

export interface GraphEdge {
  /** 依赖方 id */
  from: string
  /** 被依赖方 id */
  to: string
  /** 依赖的服务标识 */
  service: string
  kind: 'hard' | 'optional'
}

/**
 * 能力令牌预颁发计划——由装配控制层产出（方案 §5.2.3）。
 * 运行时管控层据此为每个插件预颁发令牌：令牌的权限范围由契约声明决定，
 * 而非由插件运行时自行索取（方案 §3.3 协作关系第 2 条）。
 */
export interface CapabilityGrantPlan {
  /** 每个插件预颁发的令牌列表 */
  grants: Map<string, TokenGrant[]>
}

/** 单项令牌授予计划 */
export interface TokenGrant {
  /** 目标服务标识 */
  service: string
  /** 允许的方法——根据服务类型和服务膜配置推导 */
  allowedMethods: string[]
  /** 允许的属性 */
  allowedProps: string[]
  /** 过期时间（会话级令牌随会话过期） */
  expiresAt: number
}

/** 装配管线产出状态（方案 §7.3 管线伪码第 7 步） */
export type AssemblyStatus = 'success' | 'validation-error' | 'security-denied'

/**
 * 有效配置节点上的契约便捷视图——运行时管控层从装配计划取某插件契约时使用。
 * 纯工程辅助类型，不占 SEC 码位。
 */
export type ContractOfPlan = Pick<PluginContract, 'plane' | 'isolate'> & {
  contract: PluginContract | undefined
}
