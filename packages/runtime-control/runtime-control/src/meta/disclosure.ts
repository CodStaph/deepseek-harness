/**
 * 运行时管控层 · 元层纪律：三态披露与基线指纹（meta/disclosure.ts）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.11.7（三态披露与基线指纹，
 *       §1.6.4 abandoned ≠ refuted 移植）；§5.11.4（基线指纹挂 assemblyPlanId 互指键）。
 * 阶段：S23（批次 5b，M5 元层纪律收口）。
 *
 * 语义要点（方案 §5.11.7 原文）：
 * 效果审计对外报告固定格式：**放行 / 拦截 / 豁免**分列统计 + 基线指纹
 * （assemblyPlanId + 信任策略指纹）。审批超时 deny 与用户拒绝 deny 分列——
 * 超时是元记账，不等于用户判定该拒（LangQuanta abandoned ≠ refuted 同构：找不到 ≠ 不可证）。
 *
 * 本模块把效果审计条目聚合成三态披露报告：
 * - 放行（allowed）：verdict=allow 且未走豁免（approvalDecision 为 approved/auto/auto-by-provenance）；
 * - 拦截（blocked）：verdict=deny 的全部（含超时/用户拒/No-Löb/审计 deny）；
 * - 豁免（exempted）：verdict=allow 且走了豁免通道（exemption 非空）。
 * 其中拦截再分列超时 deny（approvalDecision=timeout）与用户 deny（denied），
 *   超时属元记账非用户判定该拒（§5.11.7 abandoned ≠ refuted）。
 *
 * 基线指纹：assemblyPlanId + 信任策略指纹（trustPolicyFingerprint 由调用方注入，
 *   镜像缺省为空串占位；并入 dsh 时以信任策略配置的摘要填充）。
 *
 * SEC 码位论证（§5.11.1——结论：零新增，SEC-7xxx 段维持留白）：纯观测/报告载体
 * （汇总既有审计条目做分列统计与指纹呈现），不授予能力、不开辟信任通道、不引入新
 * 判定面，零信任语义（§5.11.1 第 3 条：审计视图/报告格式以数据字段承载，不进本表）。
 */

/** 三态披露统计 */
export interface DisclosureStats {
  /** 放行数（verdict=allow 且非豁免） */
  allowed: number
  /** 拦截数（verdict=deny 全部） */
  blocked: number
  /** 豁免数（verdict=allow 且走豁免通道） */
  exempted: number
  /** 拦截中的超时 deny 数（元记账，≠ 用户拒绝，§5.11.7 分列） */
  timeoutDenied: number
  /** 拦截中的用户拒绝 deny 数 */
  userDenied: number
}

/** 基线指纹（§5.11.7） */
export interface BaselineFingerprint {
  /** 装配计划 id（互指键锚点） */
  assemblyPlanId: string
  /** 信任策略指纹（缺省 ''，并入 dsh 时以策略摘要填充） */
  trustPolicyFingerprint: string
}

/** 三态披露报告 */
export interface DisclosureReport {
  stats: DisclosureStats
  /** 基线指纹 */
  fingerprint: BaselineFingerprint
  /** 报告说明（含超时 ≠ 用户拒绝的定性） */
  note: string
}

/** 效果审计条目快照（披露用最小字段集） */
export interface DisclosureAuditEntry {
  verdict: 'allow' | 'deny'
  exemption?: string
  approvalDecision?: string
}

/** 方案 §5.11.7 定性文本 */
export const DISCLOSURE_NOTE =
  '审批超时 deny 是元记账，不等于用户判定该拒（abandoned ≠ refuted，§5.11.7）。'

/**
 * 生成三态披露报告（§5.11.7）——放行/拦截/豁免分列统计 + 基线指纹。
 * 拦截内超时 deny 与用户 deny 分列（元记账 ≠ 用户判定）。
 */
export function buildDisclosureReport(
  entries: readonly DisclosureAuditEntry[],
  fingerprint: BaselineFingerprint,
): DisclosureReport {
  let allowed = 0
  let blocked = 0
  let exempted = 0
  let timeoutDenied = 0
  let userDenied = 0

  for (const e of entries) {
    if (e.verdict === 'allow') {
      if (e.exemption) exempted++
      else allowed++
    } else {
      blocked++
      if (e.approvalDecision === 'timeout') timeoutDenied++
      else if (e.approvalDecision === 'denied') userDenied++
    }
  }

  return {
    stats: { allowed, blocked, exempted, timeoutDenied, userDenied },
    fingerprint,
    note: DISCLOSURE_NOTE,
  }
}