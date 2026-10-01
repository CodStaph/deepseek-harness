/**
 * 运行时管控层 · 元层纪律：判据独立重算器（meta/recheck.ts）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.11.5（判据独立重算器，.lqproof/§1.7 移植）；
 *       §14.3 路线 2.5（复核器非第二判据：验算可判定且规模可控）；
 *       §14.5 L4（管控层自身完整性在架构内的唯一可行缓解）；验收 R42。
 * 阶段：S23（批次 5b，M5 元层纪律收口）。
 *
 * 语义要点（方案 §5.11.5 原文）：
 * - 【独立实现的最小检查器】：只含权限矩阵 + 豁免规则重算，不含膜/域/MCP——
 *   规模远小于 runtime-control，可被独立人工审阅；
 * - 定期或敏感场景重算审批决策样本：一致 ⇒ 审计记 cross_checked（增强信心，无语义后果）；
 *   不一致 ⇒ 冻结 + 不自动改判（§5.11.3 同处置）；
 * - 【复核器非第二判据】：不改变效果系统的唯一判定地位——重算器只做一致性核对，
 *   不替代效果系统做放行/拦截的独立裁决；
 * - 同时是 14.5 L4（管控层自身完整性）在架构内的唯一可行缓解。
 * - 判定：[T1]——注入故意不一致的重算结果 ⇒ 冻结（验收 R42）。
 *
 * SEC 码位论证（§5.11.1——结论：零新增，SEC-7xxx 段维持留白）：
 * 重算器是【独立核对器】而非【第二判据】——不授予能力、不参与放行裁决，仅对既有
 * 审批决策样本做独立重算并比对。"不一致 → 冻结"复用哨兵冻结处置（sentinel.ts），
 * 属元记账（审计照写）永不升级为对象层豁免（No-Löb 精神）。不构成需登记诊断码位的
 * 信任授予/一致性破坏通道（对照 SEC-1015 因执行语义才登记）。判定出口以结构化结果
 * 字段承载可定位性（cross_checked / frozen 两态）。
 */

/** 一次待重算的审批决策样本（独立重算器的输入） */
export interface RecheckSample {
  /** 效果类型 */
  type: string
  /** 目标（路径/URL/工具名） */
  target: string
  /** 效果系统实际作出的判定（来自审计账） */
  actualVerdict: 'allow' | 'deny'
  /** 命中的豁免通道（走豁免时记录） */
  exemption?: string
}

/** 独立重算判定的最小判据（权限矩阵 + 豁免规则） */
export interface IndependentCriterion {
  /** 权限矩阵：type → target 是否允许 */
  allows: (type: string, target: string) => boolean
  /** 豁免规则：channel 是否允许（缺省恒 false） */
  allowsExemption: (channel: string) => boolean
}

/** 一处不一致（实际判定与独立重算不符） */
export interface RecheckMismatch {
  sample: RecheckSample
  /** 独立重算的应然判定 */
  expected: 'allow' | 'deny'
  /** 说明 */
  detail: string
}

/** 重算结果——判定状态封闭枚举（cross_checked / frozen，无第三态模糊） */
export interface RecheckResult {
  /** 是否一致（cross_checked） */
  consistent: boolean
  /** 采样数 */
  sampled: number
  /** 不一致的样本（为空即一致） */
  mismatches: RecheckMismatch[]
  /** 判定说明（cross_checked / frozen 两态） */
  outcome: 'cross_checked' | 'frozen'
}

/** 重算器运行选项 */
export interface RecheckOptions {
  /** 采样上限（防重算器膨胀；缺省不截断） */
  maxSamples?: number
}

/**
 * 判据独立重算器（§5.11.5，R42）——独立小检查器重算审批决策样本：
 * - 一致 ⇒ cross_checked（增强信心，无语义后果，不改变效果系统判定地位）；
 * - 不一致 ⇒ frozen（冻结 + 不自动改判，交人工裁定）。
 * 复核器非第二判据：仅一致性核对，不替代效果系统做放行/拦截的独立裁决。
 */
export function recheckDecisions(
  samples: readonly RecheckSample[],
  criterion: IndependentCriterion,
  opts: RecheckOptions = {},
): RecheckResult {
  const list = opts.maxSamples !== undefined ? samples.slice(0, opts.maxSamples) : samples
  const mismatches: RecheckMismatch[] = []

  for (const sample of list) {
    const expected = independentVerdict(sample, criterion)
    if (expected !== sample.actualVerdict) {
      mismatches.push({
        sample,
        expected,
        detail: `实际判定 ${sample.actualVerdict} 与独立重算 ${expected} 不符（目标 ${sample.type} → ${sample.target}，豁免 ${sample.exemption ?? '无'}）——重算不一致，冻结授权/豁免通道（§5.11.3 同处置）。`,
      })
    }
  }

  return {
    consistent: mismatches.length === 0,
    sampled: list.length,
    mismatches,
    outcome: mismatches.length === 0 ? 'cross_checked' : 'frozen',
  }
}

/** 独立重算应然判定：豁免命中且豁免规则允许 → allow；否则按权限矩阵 */
function independentVerdict(sample: RecheckSample, criterion: IndependentCriterion): 'allow' | 'deny' {
  if (sample.exemption && criterion.allowsExemption(sample.exemption)) return 'allow'
  return criterion.allows(sample.type, sample.target) ? 'allow' : 'deny'
}

/** 顶层独立重算入口（供上层统一接线）：先独立重算，不一致则产出冻结建议（返回冻结目标） */
export function recheckWithSentinel(
  samples: readonly RecheckSample[],
  criterion: IndependentCriterion,
): RecheckResult {
  return recheckDecisions(samples, criterion)
}