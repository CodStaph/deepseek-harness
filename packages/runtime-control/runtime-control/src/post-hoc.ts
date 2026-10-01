/**
 * 运行时管控层 · 机制 3：会话收尾自检（Post-hoc Review）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.6（第 1894–1925 行）
 * 阶段：S18（批次 3b，M3 智能体运行语义）——把审计链从"只写不回顾的台账"升级为
 *       带收尾清算的闭环（对照 TeleAgent"每轮结束前强制工作目录全量自检"纪律）。
 *
 * 语义要点（方案 §5.6）：
 * - `runPostHocReview` 汇总本生命周期（插件/会话/任务）全部效果调用，与契约声明的
 *   能力面（CapabilityDeclaration）比对：
 *     · 未声明能力而发起效果      → undeclared-capability（error 级）
 *     · 声明了但超出模式/上限范围  → capability-exceeded（error 级）
 *     · fs.write 未标 artifact    → artifact-unmarked（warning 级，缺省按 final 处理）
 * - 写入审计（action:'post-hoc-audit'）并产出结构化报告。
 * - 触发时机：插件 unmount、会话结束、任务收口三者任一发生即执行对应 scope。
 *   lenient 模式下这是唯一系统性清算点——运行时放过的每一笔都会在收尾报告点名。
 * - 与 isolate 联动（方案 §5.5 / §9.3 第 8 条）：每次隔离强制产出 warning 级
 *   post-hoc 报告。
 *
 * SEC 码位结论：纯观测/清算载体——不授予能力、不开辟信任通道，仅对既有效果审计
 * 与契约声明做比对并记账（action:'post-hoc-audit'）。不新增 SEC 码位，SEC-3xxx 段
 * 维持留白（§5.11.1 准入）。
 */

import type { CapabilityDeclaration } from '@deepseek-ai/dsh-assembly'
import type { EffectType } from './effect.ts'
import type { EffectAuditEntry } from './effect.ts'

/** 收尾自检的范围（方案 §5.6 ReviewScope） */
export interface ReviewScope {
  /** 插件 id（可选——scope 三选一：插件/会话/任务） */
  pluginId?: string
  /** 会话 id */
  sessionId?: string
  /** 任务 id */
  taskId?: string
}

/** 收尾自检发现的一类越界（方案 §5.6 PostHocReview.findings 项） */
export interface PostHocFinding {
  effect: EffectAuditEntry
  issue: 'undeclared-capability' | 'capability-exceeded' | 'artifact-unmarked'
  severity: 'error' | 'warning'
  /** 中文可读的越界说明 */
  detail: string
}

/** 收尾自检报告（方案 §5.6 PostHocReview） */
export interface PostHocReview {
  scope: ReviewScope
  /** 本周期内全部效果调用（含豁免/自动批准的） */
  effects: EffectAuditEntry[]
  /** 契约声明的能力面（无契约 = undefined） */
  declaredCapabilities: CapabilityDeclaration | undefined
  /** 发现的越界行为 */
  findings: PostHocFinding[]
}

/** 效果类型 → 能力面键的映射（判定"未声明能力而发起效果"） */
const EFFECT_TO_CAPABILITY: Readonly<Record<string, keyof CapabilityDeclaration>> = {
  'fs.read': 'fs',
  'fs.write': 'fs',
  'fs.stat': 'fs',
  'fs.trash': 'fs',
  'fs.delete-permanent': 'fs',
  'net.fetch': 'network',
  'net.connect': 'network',
  'proc.spawn': 'process',
  'proc.exec': 'process',
  'env.get': 'env',
  'env.set': 'env',
  'mcp.call': 'mcp',
}

/** 变更类 fs 效果类型（artifact 未标 mark 的判定面） */
const FS_WRITE_TYPES: readonly string[] = ['fs.write']

/**
 * 判断一条效果是否落在契约声明的能力面内。
 * - 能力面缺失（该域未声明）→ 未声明能力（undeclared-capability）。
 * - 能力面存在但效果为写/外呼而契约未授权对应子域 → 超范围（capability-exceeded）。
 *   S18 以"能力域存在即视为允许发起该域效果"为最小判据；精确到路径/URL/命令/工具的
 *   范围比对依赖能力面具体结构（FsCapability.read/write/delete、NetworkCapability.allow、
 *   ProcessCapability.allow、McpCapability.servers/tools），此处给出可扩展的骨架判定。
 */
function capabilityVerdict(
  type: EffectType,
  declared: CapabilityDeclaration | undefined,
): { kind: 'ok' } | { kind: 'undeclared' } | { kind: 'exceeded' } {
  const face = EFFECT_TO_CAPABILITY[type]
  if (!declared || !face) return { kind: 'ok' } // 无契约或无能力面对应 → 不判越界
  const cap = declared[face]
  if (!cap) return { kind: 'undeclared' }

  // 写类 fs 效果：需声明了对应写/删除面
  if (type === 'fs.write' || type === 'fs.trash' || type === 'fs.delete-permanent') {
    const fsCap = cap as { write?: string[]; delete?: string[]; permanentDelete?: string[] }
    if (type === 'fs.write' && !fsCap.write) return { kind: 'exceeded' }
    if (type === 'fs.trash' && !fsCap.delete) return { kind: 'exceeded' }
    if (type === 'fs.delete-permanent' && !fsCap.permanentDelete) return { kind: 'exceeded' }
  }
  if (type === 'mcp.call') {
    const mcpCap = cap as { servers?: string[]; tools?: string[] }
    if (!mcpCap.servers && !mcpCap.tools) return { kind: 'exceeded' }
  }
  if (type === 'env.set') {
    const envCap = cap as { write?: string[] }
    if (!envCap.write) return { kind: 'exceeded' }
  }
  return { kind: 'ok' }
}

/**
 * 运行会话/插件生命周期结束时的越界回顾（方案 §5.6）。
 * 汇总本 scope 全部效果调用，与契约能力面比对，产出 findings；findings 写入审计
 * （action:'post-hoc-audit'，由调用方经 auditCallback 落账）。
 */
export function runPostHocReview(
  scope: ReviewScope,
  effects: readonly EffectAuditEntry[],
  declaredCapabilities: CapabilityDeclaration | undefined,
): PostHocReview {
  const findings: PostHocFinding[] = []
  const seen = new Set<string>()

  for (const effect of effects) {
    // 1. 未声明能力而发起效果（error 级）
    const verdict = capabilityVerdict(effect.type, declaredCapabilities)
    if (verdict.kind === 'undeclared') {
      findings.push({
        effect,
        issue: 'undeclared-capability',
        severity: 'error',
        detail: `发起未声明能力的效果：${effect.type} → ${effect.target}`,
      })
    } else if (verdict.kind === 'exceeded') {
      findings.push({
        effect,
        issue: 'capability-exceeded',
        severity: 'error',
        detail: `声明能力但超出范围：${effect.type} → ${effect.target}`,
      })
    }

    // 2. fs.write 未标 artifact → artifact-unmarked（warning 级，缺省按 final）
    const artifact = (effect as { artifact?: string }).artifact
    if (FS_WRITE_TYPES.includes(effect.type) && artifact === undefined) {
      // 以 trace id 防重复点名（同一效果多维度发现合并进同一条 finding）
      const key = `${effect.timestamp}-${effect.type}-${effect.target}`
      if (!seen.has(key)) {
        seen.add(key)
        findings.push({
          effect,
          issue: 'artifact-unmarked',
          severity: 'warning',
          detail: `fs.write 未标 artifact（缺省按 final 处理）：${effect.target}`,
        })
      }
    }
  }

  return {
    scope,
    effects: [...effects],
    declaredCapabilities,
    findings,
  }
}