/**
 * 运行时管控层 · 能力令牌颁发器（issuer）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.2.3（能力令牌预颁发）、
 *       §6.1 管线第 6–7 步（装配层产 CapabilityGrantPlan）与第 10c 步（运行时按计划颁发令牌）
 * 阶段：S11（能力令牌预颁发）——issuer 消费装配控制层产出的 CapabilityGrantPlan，
 *       为每个插件的每个 TokenGrant 实际实例化 CapabilityToken。
 *
 * 职责边界（与装配层 capability-grants.ts 的分工）：
 * - 装配层 `buildCapabilityGrantPlan`：根据契约 needs+capabilities 计算"允许哪些方法/属性"
 *   （过滤逻辑唯一实现，含 lenient 判定），产出 CapabilityGrantPlan。
 * - 运行时 issuer：把计划实例化为令牌——**不做二次过滤**，忠实执行装配层已裁定的权限范围。
 *   令牌不可伪造，一律经 `CapabilityToken._issue` 颁发。
 *
 * 依赖方向：runtime-control → assembly 单向（仅消费装配类型）。
 */

import type { CapabilityGrantPlan } from '@deepseek-ai/dsh-assembly'

import { CapabilityToken } from './capability.ts'

/** 预颁发令牌的目标服务类型（issuer 不持有具体服务实例，用最小对象形状承载令牌） */
type ServiceToken = CapabilityToken<Record<string, unknown>>

/** issuer 预颁发配置 */
export interface IssueTokenOptions {
  /** 服务方法注册表（服务名 → 可用方法名）——装配层计划已含过滤结果，本字段暂不使用，保留以对齐方案签名 */
  serviceMethodsRegistry?: ReadonlyMap<string, readonly string[]>
}

/** 预颁发结果 */
export interface IssueTokenResult {
  /** 每个插件预颁发的令牌表 */
  tokensByPlugin: Map<string, ServiceToken[]>
}

/**
 * 按装配层预颁发计划为每个插件实例化能力令牌（方案 §5.2.3、§6.1 第 10c 步）。
 * 每个 TokenGrant 实例化为一张令牌；权限范围完全来自计划（装配层已过滤）。
 */
export function issueTokens(
  grantsPlan: CapabilityGrantPlan,
  _options: IssueTokenOptions = {},
): IssueTokenResult {
  const tokensByPlugin = new Map<string, ServiceToken[]>()
  for (const [pluginId, grants] of grantsPlan.grants) {
    const tokens: ServiceToken[] = grants.map((g) =>
      CapabilityToken._issue<Record<string, unknown>>({
        service: g.service,
        issuedTo: pluginId,
        allowedMethods: g.allowedMethods,
        allowedProps: g.allowedProps,
        expiresAt: g.expiresAt,
      }),
    )
    tokensByPlugin.set(pluginId, tokens)
  }
  return { tokensByPlugin }
}