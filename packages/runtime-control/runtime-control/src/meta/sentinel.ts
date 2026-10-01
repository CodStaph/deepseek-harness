/**
 * 运行时管控层 · 元层纪律：审计一致性哨兵与通道冻结（meta/sentinel.ts）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.11.3（审计一致性哨兵与通道冻结，
 *       K15 移植）；§5.11.5（判据独立重算器——一致性哨兵与冻结处置共用，recheck.ts 消费）；
 *       §14.3 路线 2.5（复核器非第二判据）；验收 R40。
 * 阶段：S23（批次 5b，M5 元层纪律收口）——No-Löb 已随 S16 落地，此处收口哨兵。
 *
 * 语义要点（方案 §5.11.3 原文）：
 * - isolate（§5.5）摘除的是【行为者】；另一类故障是【元数据矛盾】——授权库与审计链
 *   对不上（同一效果既 allow 又 deny、豁免放行但契约排除）。这类故障摘谁都不对，
 *   正确动作沿 K15 的"冻结 + 不自动改判"。
 * - 触发：授权库记录与审计统计对不上、同目标效果双判定、豁免命中与契约声明矛盾；
 * - 处置：冻结相关豁免通道/授权记忆（降级为全审批）+ 告警 + 登记，不自动改判——
 *   豁免规则本身权威不动，矛盾交人工裁定；
 * - 定性（1.18.5 哥德尔第二边界移植）：哨兵是矛盾实例的【检测器】，不是一致性的
 *   【证明】——哨兵全绿不蕴含无矛盾。
 * - 判定：[T1]——构造授权库与审计链矛盾的注入测试（验收 R40）。
 *
 * 冻结与 isolate 正交：isolate 管行为者，冻结管通道；不新增 ViolationPolicy 档。
 * 本模块为纯检测/冻结建议载体：产出 frozenChannels，由调用方把对应豁免通道/授权记忆
 *   降级为全审批（不改判豁免规则本身，矛盾交人工裁定）。
 *
 * SEC 码位论证（§5.11.1 信任语义准入——结论：零新增，SEC-7xxx 段维持留白）：
 * 一致性哨兵是既有判定面的【矛盾检测器】——不授予能力、不开辟新信任授予通道、
 *   不引入新可执行判定面，仅对既有授权/豁免/审计结果做一致性比对并产出冻结建议，
 *   不构成需登记诊断码位的"可被冒充/可破坏一致性"通道（对照 SEC-1015 因执行语义才登记）。
 * 判定出口以结构化检测结果字段承载可定位性，无自由文本诊断。
 */

/** 检测到的元数据矛盾形态（封闭枚举——新增形态须走 §5.11.9 变更裁定流程） */
export type ConsistencyKind =
  /** 授权库记录与审计账对不上（grant 已记录但审计无对应 allow） */
  | 'grant-audit-mismatch'
  /** 同一目标效果同时存在 allow 与 deny 双判定 */
  | 'dual-verdict'
  /** 豁免命中但契约声明排除该豁免通道（豁免放行与契约矛盾） */
  | 'exemption-conflict'

/** 建议冻结的判定面（R40：冻结豁免通道/授权记忆，降级全审批） */
export type FreezeTarget = 'exemption' | 'grant-memory'

/** 一条检测到的矛盾 */
export interface SentinelConflict {
  kind: ConsistencyKind
  /** 关联的装配计划 id（互指键锚点；可空） */
  planId?: string
  /** 关联的效果类型 */
  type?: string
  /** 关联的目标（路径/URL/工具名） */
  target?: string
  /** 建议冻结的通道 */
  freeze: FreezeTarget
  /** 中文可读的矛盾说明（供人工裁定） */
  detail: string
}

/** 授权记录快照（哨兵比对用，最小字段集） */
export interface GrantSnapshot {
  id: string
  /** 授权覆盖的效果类型 */
  type: string
  /** object 级目标键（可空） */
  objectKey?: string
  /** class 级键 `${type}#${caller}` */
  classKey: string
  /** 授权者 */
  grantedBy: 'user' | 'policy' | 'provenance'
}

/** 效果审计条目快照（哨兵比对用，最小字段集） */
export interface AuditSnapshot {
  type: string
  target: string
  verdict: 'allow' | 'deny'
  exemption?: string
}

/** 哨兵检测输入 */
export interface SentinelInput {
  /** 当前装配计划 id（互指键锚点） */
  planId?: string
  /** 授权记录快照 */
  grants: readonly GrantSnapshot[]
  /** 效果审计条目快照 */
  auditEntries: readonly AuditSnapshot[]
  /** 契约豁免允许面判定（channel → 是否允许；缺省恒 false = 不判该族） */
  contractAllowsExemption?: (channel: string) => boolean
}

/** 哨兵运行选项 */
export interface SentinelOptions {
  /** 授权记录 → 是否有对应 allow 审计的注入判定（测试注入；缺省按「存在同 target 的 allow」推断） */
  hasAllowAudit?: (grant: GrantSnapshot, audit: readonly AuditSnapshot[]) => boolean
}

/** 哨兵检测结果 */
export interface SentinelResult {
  /** 是否检测到矛盾 */
  conflicted: boolean
  /** 全部矛盾 */
  conflicts: SentinelConflict[]
  /** 建议冻结的通道（去重） */
  freezeTargets: FreezeTarget[]
  /** 哨兵定性（哥德尔第二边界） */
  note: string
}

/** 方案 §5.11.3 定性文本 */
export const SENTINEL_NOTE =
  '哨兵是矛盾实例的检测器，不是一致性的证明——哨兵全绿不蕴含无矛盾（§5.11.3 / 1.18.5）。'

/**
 * 审计一致性哨兵（§5.11.3，R40）——检测授权库与审计账的元数据矛盾，产出冻结建议。
 * 三类矛盾：
 *   1. grant-audit-mismatch：授权记录在审计账中无对应 allow（授权库与审计对不上）；
 *   2. dual-verdict：同一 type+target 同时有 allow 与 deny（双判定矛盾）；
 *   3. exemption-conflict：豁免命中但契约未声明该豁免通道（豁免与契约矛盾）。
 * 冻结建议不自动执行：返回 freezeTargets 供调用方降级对应通道为全审批；矛盾交人工裁定。
 */
export function runSentinel(
  input: SentinelInput,
  opts: SentinelOptions = {},
): SentinelResult {
  const conflicts: SentinelConflict[] = []
  const hasAllowAudit = opts.hasAllowAudit ?? defaultHasAllowAudit

  // 1. 授权库与审计账对不上
  for (const grant of input.grants ?? []) {
    if (!hasAllowAudit(grant, input.auditEntries ?? [])) {
      conflicts.push({
        kind: 'grant-audit-mismatch',
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        type: grant.type,
        ...(grant.objectKey !== undefined ? { target: grant.objectKey } : {}),
        freeze: 'grant-memory',
        detail: `授权记录 ${grant.id}（${grant.classKey}，授权者 ${grant.grantedBy}）在审计账中无对应 allow——授权库与审计账不一致，冻结授权记忆并降级全审批。`,
      })
    }
  }

  // 2) 同目标双判定
  const byKey = new Map<string, { type: string; target: string; allow: boolean; deny: boolean }>()
  for (const e of input.auditEntries ?? []) {
    const key = `${e.type}|${e.target}`
    const rec = byKey.get(key) ?? { type: e.type, target: e.target, allow: false, deny: false }
    if (e.verdict === 'allow') rec.allow = true
    if (e.verdict === 'deny') rec.deny = true
    byKey.set(key, rec)
  }
  for (const rec of byKey.values()) {
    if (rec.allow && rec.deny) {
      conflicts.push({
        kind: 'dual-verdict',
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        type: rec.type,
        target: rec.target,
        freeze: 'exemption',
        detail: `目标 ${rec.type} → ${rec.target} 同时存在 allow 与 deny 双判定——双判定矛盾，冻结豁免通道并降级全审批，矛盾交人工裁定。`,
      })
    }
  }

  // 3) 豁免命中与契约声明矛盾
  const contractAllows = input.contractAllowsExemption ?? (() => false)
  for (const e of input.auditEntries ?? []) {
    if (e.verdict === 'allow' && e.exemption && !contractAllows(e.exemption)) {
      conflicts.push({
        kind: 'exemption-conflict',
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        type: e.type,
        target: e.target,
        freeze: 'exemption',
        detail: `豁免通道 '${e.exemption}' 命中放行 ${e.type} → ${e.target}，但契约声明未允许该豁免通道（豁免放行与契约矛盾）——冻结该豁免通道。`,
      })
    }
  }

  const freezeTargets = [...new Set(conflicts.map((c) => c.freeze))]
  return {
    conflicted: conflicts.length > 0,
    conflicts,
    freezeTargets,
    note: SENTINEL_NOTE,
  }
}

/** 默认「授权有对应 allow 审计」判定：审计账中存在同 type 且同 target 的 allow 即认为匹配 */
function defaultHasAllowAudit(grant: GrantSnapshot, audit: readonly AuditSnapshot[]): boolean {
  return audit.some((e) => e.verdict === 'allow' && e.type === grant.type && (grant.objectKey === undefined || e.target === grant.objectKey))
}