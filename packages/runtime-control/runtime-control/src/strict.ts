/**
 * 运行时管控层 · 机制 0：严格模式灰度与门禁（CapabilityMode / gradient gate）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §8.2（向后兼容与灰度演进）/
 *       里程碑规划 §12（灰度与回退标志演进表）、表行 6/34（严格模式灰度范围：
 *       镜像全量试点 + 灰度清算纪律）
 * 阶段：S15（批次 3c，M3 收口）——严格模式灰度启动 + 性能门禁纪律的判定侧。
 *
 * 语义要点：
 * - 灰度演进：默认 `lenient`（向后兼容，未声明能力以 warning 放行）；`--strict`
 *   切换到 `strict`（未声明能力拒绝）。前一档全量回归绿 + post-hoc 清算零未解释
 *   越界，才允许进入下一档（§12 统一纪律；S6 后第一档可收紧，本处第二档）。
 * - `gradientGate`：进入严格档的前置判定——回归全绿 且 收尾清算零未解释越界。
 *   纯函数判定（输入报表输出布尔），由集成方在"进档决策点"调用；台账登记
 *   （action:'gradient-check'）由调用方落账，本模块不写 IO。
 * - 与各机制的关系：McpEffectHandler/lenient、--lenient-capabilities、--no-realm
 *   均以本模块的 resolveCapabilityMode 为统一灰度开关（§12 演进表，M5 终验去留）。
 *
 * SEC 码位结论：纯模式判定/观测载体（不授予能力、不开辟信任通道，仅选择既有
 * 判定面的严/宽口径），零新增码位；SEC-3xxx 段维持留白（§5.11.1 准入）。
 */

/** 能力判定模式——宽松（向后兼容，未声明以 warning 放行）/ 严格（未声明即拒） */
export type CapabilityMode = 'lenient' | 'strict'

/** 灰度开关输入（CLI 标志/装配选项的统一映射） */
export interface StrictModeOptions {
  /** `--strict`：显式切严格模式（优先于缺省 lenient） */
  strict?: boolean
  /** `--no-lenient-capabilities`：关闭宽松能力（等价切严格） */
  noLenientCapabilities?: boolean
}

/**
 * 解析灰度模式（方案 §8.2）——缺省 lenient（向后兼容）。
 * strict=true 或 noLenientCapabilities=true → strict；否则 lenient。
 */
export function resolveCapabilityMode(opts?: StrictModeOptions): CapabilityMode {
  if (opts?.strict === true) return 'strict'
  if (opts?.noLenientCapabilities === true) return 'strict'
  return 'lenient'
}

/** 严格模式判定（供各机制消费：未声明能力时按模式决定拒/放行） */
export function isStrictMode(mode: CapabilityMode): boolean {
  return mode === 'strict'
}

/** 进严格档的前置条件输入（回归绿 + 收尾清算结果） */
export interface GradientInput {
  /** 上一档全量回归是否全绿 */
  regressionGreen: boolean
  /** 上一档收尾清算中未解释越界数（post-hoc findings 中未申诉/未修复的 error 级项） */
  unaccountedFindings: number
}

/**
 * 灰度清算纪律判定（§12 / 表行 34）——只有"前一档回归全绿 + 收尾清算零未解释越界"
 * 才允许进入下一档。纯函数，不做 IO。
 */
export function gradientGate(input: GradientInput): boolean {
  return input.regressionGreen && input.unaccountedFindings === 0
}