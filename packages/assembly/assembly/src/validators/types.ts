/**
 * 装配控制层 · 诊断与校验结果类型
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §4.2.1（Diagnostic）
 * 阶段：S1（骨架）——诊断框架是静态校验（S3）、动态校验（S6）、
 *       skill 静态扫描（S21）共用的公共语言（方案 §5.9.3 复用要求）。
 *
 * 码位纪律（SEC 登记表 §1）：
 * - 一码一规则：`code` 字段承载 SEC-xxxx 码位，一个码位只对应一条诊断规则。
 * - 抛出诊断的规则实现引用的 SEC 码必须在《SEC-码位登记表.md》内（R43 静态检查）。
 * - 纯工程机制（审计视图/报告格式/CLI 子命令）不占码位。
 * - 本文件只定义类型骨架；13 条静态规则的实现随 S3 迁移，SEC-1001–1014 已回溯建档。
 */

/** 结构化诊断——装载期与挂载期校验的统一输出 */
export interface Diagnostic {
  /** 严重级别 */
  severity: 'error' | 'warning'
  /** 诊断消息 */
  message: string
  /** 涉及的节点 id */
  nodeId?: string
  /** 涉及的文件路径 */
  file?: string
  /** 涉及的字段路径 */
  fieldPath?: string
  /** 修复建议 */
  suggestion?: string
  /**
   * SEC 诊断码位（SEC-xxxx）——一码一规则（方案 §5.11.6）。
   * 规则实现落地（S3/S6）时逐条回填登记表内码位；本骨架字段先行为空。
   */
  code?: string
}

/** 校验结果——装载期静态校验的汇总承载（AssemblyPlan.validation 字段类型） */
export interface ValidationResult {
  /** 本轮校验产生的全部诊断（error 与 warning 混列，按 severity 区分） */
  diagnostics: Diagnostic[]
}
