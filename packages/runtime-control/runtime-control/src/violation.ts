/**
 * 运行时管控层 · 机制 4：运行时违规处理（Runtime Violation Handling）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.5（第 1806–1890 行）
 * 阶段：S14（运行时违规处理 + 审计）——本文件落地 DefaultViolationHandler（默认
 *       log-and-throw），把运行时安全违规统一为"可审计、可策略化"的处理器：
 *       先记录审计（走装配审计链 AuditEntry），再按策略抛/降级。
 *
 * SEC 码位论证（呼应批次 2b 裁定 14A）：
 * - 违规处理是"纯策略/观测载体"：log-and-throw 等策略本身不授予任何能力、不开辟
 *   任何信任通道，仅是既有判定（膜/效果/令牌/realm）结果的"记录 + 处置"出口。
 * - 它消费 SecurityViolation（S9）、EffectAuditEntry（S9）与 AuditEntry（装配层 S1）
 *   作为输入，不新增可被注入表达式利用的判定面，不构成信任语义准入。
 * - 因此 S13/S14 段维持 SEC-3xxx 段留白，零码位新增（呼应批次 2b 裁定 14A）。
 *
 * 各策略语义：
 * - 'throw'        ：记录审计后抛回违规（调用方可感知）。
 * - 'log'          ：仅记录审计，不抛（降级为观测，进程存活）。
 * - 'log-and-throw'：记录审计 + 抛回违规（默认，免审批不等于不记录）。
 * - 'isolate'      ：隔离档——撤销令牌 + 卸载插件 + 抛 PluginIsolatedError。
 *                    由 S18（IsolateViolationHandler）落地，本阶段仅声明类型，
 *                    DefaultViolationHandler 遇 'isolate' 拒绝静默实现（见下）。
 *
 * 与装配审计链的对账：本模块经 AuditEntry（action:'security-violation'）写入同一本
 * 装配审计账；厚适配 `auditViolationToDisk` 复用 appendAuditEntry 落盘，供 R 门禁
 * 与对账工具消费（§5.11.4 互指对账在 M2 收口起接入）。
 */

import type { AuditEntry } from '@deepseek-ai/dsh-assembly'
import { appendAuditEntry } from '@deepseek-ai/dsh-assembly'

import type { EffectAuditEntry } from './effect.ts'
import type { MembraneAuditEntry } from './membrane.ts'
import { SecurityViolation } from './membrane.ts'

/** 运行时违规处理策略（v3：新增 isolate 档；isolate 语义由 S18 落地，本阶段仅声明类型） */
export type ViolationPolicy = 'throw' | 'log' | 'log-and-throw' | 'isolate'

/** 违规处理器——对运行时安全违规做统一处置 */
export interface ViolationHandler {
  /** 处理运行时安全违规 */
  handle(violation: SecurityViolation, context: ViolationContext): void
}

/** 违规上下文——违规发生时的环境信息与审计锚点 */
export interface ViolationContext {
  /** 违规发生的插件 id */
  pluginId: string
  /** 违规类型 */
  type: 'membrane' | 'capability' | 'effect' | 'realm'
  /** 调用栈 */
  stack?: string
  /** 审计条目（膜/效果两本审计账互指） */
  auditEntry: MembraneAuditEntry | EffectAuditEntry
}

/** 默认违规处理器——记录审计 + 按策略抛/降级（默认 log-and-throw，方案 §5.5） */
export class DefaultViolationHandler implements ViolationHandler {
  constructor(
    private readonly audit: (entry: AuditEntry) => void,
    private readonly policy: ViolationPolicy = 'log-and-throw',
  ) {}

  handle(violation: SecurityViolation, context: ViolationContext): void {
    if (this.policy === 'isolate') {
      // isolate 档属 S18（IsolateViolationHandler），DefaultViolationHandler 不承载该语义。
      // 明确拒绝而非静默降级为 throw，避免进程级异常掩盖隔离意图。
      throw new Error(
        `ViolationPolicy 'isolate' 属 S18（IsolateViolationHandler）范围，DefaultViolationHandler 未实现该档`,
      )
    }

    this.audit(toAuditEntry(violation, context))

    if (this.policy === 'throw' || this.policy === 'log-and-throw') {
      throw violation
    }
  }
}

/** 将违规 + 上下文归一化为装配审计条目（auditEntry 两种形态均可接纳） */
function toAuditEntry(violation: SecurityViolation, context: ViolationContext): AuditEntry {
  const entry = context.auditEntry
  // 字段锚点：膜条目取 property；效果条目无 property，以 target 作为审计字段锚点。
  const field = 'property' in entry ? entry.property : (entry as EffectAuditEntry).target
  // 新值摘要：仅膜条目带 attemptedValue；效果条目无对应新值。
  const newValue = 'attemptedValue' in entry ? entry.attemptedValue : undefined

  return {
    timestamp: new Date().toISOString(),
    action: 'security-violation',
    layer: context.pluginId,
    file: '',
    rowId: context.pluginId,
    field,
    ...(newValue !== undefined ? { newValue } : {}),
    securityVerdict: 'deny',
    securityReason: `[${context.type}] ${violation.message}`,
  }
}

/**
 * 薄适配——把一次违规落盘到装配审计日志（复用 appendAuditEntry）。
 * 供 R 门禁与真实部署在"审计须入磁盘"路径上直接消费；logPath 缺省按
 * appendAuditEntry 默认约定（process.cwd()/assembly-audit.log），调用方可注入。
 */
export function auditViolationToDisk(
  violation: SecurityViolation,
  context: ViolationContext,
  logPath?: string,
): void {
  appendAuditEntry(toAuditEntry(violation, context), logPath)
}

/* ─────────────────────── S18：isolate 档（方案 §5.5 / §9.3 第 8 条） ─────────────────────── */

/**
 * 运行时控制器接口（方案 §5.5）——isolate 档所需的运行时处置入口。
 * 镜像阶段由测试/集成方注入 mock；并入 dsh 时由真实 RuntimeController 实现
 * （revokePlugin 撤销含 fiber 派生的全部令牌，isolatePlugin 卸载插件）。
 */
export interface RuntimeController {
  /** 撤销该插件全部令牌（含 fiber 派生令牌，§5.2.5） */
  revokePlugin(pluginId: string): void
  /** 卸载该插件——经 Cordis unmount 触发其清理逻辑 */
  isolatePlugin(pluginId: string, violation: SecurityViolation): void
  /** 隔离累计达阈值后升级为装配期禁用（写回 patch 层 disabled + 人工审查，§9.3 第 8 条） */
  disablePlugin(pluginId: string, reason: string): void
}

/** 隔离阈值缺省值——同一插件累计隔离达 2 次自动升级装配期禁用（方案 §9.3 第 8 条） */
export const DEFAULT_ISOLATE_THRESHOLD = 2

/**
 * 隔离升级追踪器——记录每插件累计隔离次数，达阈值即触发升级（防"隔离-重启-再违规"
 * 循环，§9.3 第 8 条）。
 */
export class IsolateEscalationTracker {
  private readonly counts = new Map<string, number>()

  constructor(readonly threshold: number = DEFAULT_ISOLATE_THRESHOLD) {}

  /**
   * 记录一次隔离，返回累计次数与是否达阈值。
   * @returns count 累计隔离次数；escalate 达阈值 → 应升级为装配期禁用
   */
  record(pluginId: string): { count: number; escalate: boolean } {
    const count = (this.counts.get(pluginId) ?? 0) + 1
    this.counts.set(pluginId, count)
    return { count, escalate: count >= this.threshold }
  }

  /** 当前累计次数（诊断/测试用） */
  count(pluginId: string): number {
    return this.counts.get(pluginId) ?? 0
  }

  /** 重置（插件重装 / 人工审查通过后） */
  reset(pluginId: string): void {
    this.counts.delete(pluginId)
  }
}

/**
 * 插件隔离错误——隔离后向调用方抛出（可感知、可捕获，但非进程级异常，方案 §5.5）。
 */
export class PluginIsolatedError extends Error {
  constructor(
    public readonly pluginId: string,
    public override readonly cause: SecurityViolation,
    public readonly auditEntry: MembraneAuditEntry | EffectAuditEntry,
  ) {
    super(`插件 ${pluginId} 已被隔离：${cause.message}`)
    this.name = 'PluginIsolatedError'
  }
}

/** IsolateViolationHandler 构造参数 */
export interface IsolateViolationHandlerOptions {
  /** 审计回调（隔离原因 → 装配审计链，复用 toAuditEntry 归一化） */
  audit: (entry: AuditEntry) => void
  /** 运行时控制器（撤令牌 + 卸载 + 装配期禁用升级） */
  runtime: RuntimeController
  /** 隔离升级追踪器（缺省新建，阈值 2；可注入已带历史计数的实例） */
  escalation?: IsolateEscalationTracker
  /** 每次隔离产出 warning 级 post-hoc 报告的注入回调（方案 §5.5；scope 已带隔离上下文） */
  onPostHocReview?: (report: { pluginId: string; warning: string }) => void
}

/**
 * 隔离式违规处理器（方案 §5.5，S18 落地）——违规不再等于进程级异常。
 * 流程：记录审计 → 撤销插件令牌 → 升级阈值判定（达阈值 → 装配期禁用，否则卸载隔离）
 * → 产出 warning 级 post-hoc 报告 → 抛 PluginIsolatedError（非进程级异常）。
 */
export class IsolateViolationHandler implements ViolationHandler {
  private readonly audit: (entry: AuditEntry) => void
  private readonly runtime: RuntimeController
  private readonly escalation: IsolateEscalationTracker
  private readonly onPostHocReview?: (report: { pluginId: string; warning: string }) => void

  constructor(opts: IsolateViolationHandlerOptions) {
    this.audit = opts.audit
    this.runtime = opts.runtime
    this.escalation = opts.escalation ?? new IsolateEscalationTracker()
    if (opts.onPostHocReview !== undefined) this.onPostHocReview = opts.onPostHocReview
  }

  handle(violation: SecurityViolation, context: ViolationContext): void {
    // 1. 审计记录隔离原因（可回顾、可申诉）
    this.audit(toAuditEntry(violation, context))

    // 2. 撤销该插件全部令牌（含 fiber 派生令牌）
    this.runtime.revokePlugin(context.pluginId)

    // 3. 阈值升级判定（§9.3 第 8 条：达阈值弃 isolate 改装配期禁用，避免循环）
    const { count, escalate } = this.escalation.record(context.pluginId)
    if (escalate) {
      // 升级为装配期禁用——写回 patch 层 disabled 并进入人工审查，不再无限隔离
      this.runtime.disablePlugin(
        context.pluginId,
        `累计隔离 ${count} 次达阈值 ${this.escalation.threshold}，升级为装配期禁用（人工审查）`,
      )
    } else {
      // 卸载该插件——经 Cordis unmount 触发其清理逻辑
      this.runtime.isolatePlugin(context.pluginId, violation)
    }

    // 4. 每次隔离产出 warning 级 post-hoc 报告（§5.5 配套纪律）
    this.onPostHocReview?.({
      pluginId: context.pluginId,
      warning: `插件 ${context.pluginId} 第 ${count} 次隔离（${violation.message}）——post-hoc 清算点名`,
    })

    // 5. 抛 PluginIsolatedError：可感知、可捕获，但非进程级异常
    throw new PluginIsolatedError(context.pluginId, violation, context.auditEntry)
  }
}