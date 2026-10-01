/**
 * 运行时管控层 · 机制 3：审批语义（ApprovalService）——三档授权 + 豁免通道 + park/resume
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.3.6（审批语义：三档授权、豁免通道与
 *       park/resume，v3 新增）；§5.2.6（TokenRenewalPolicy 对照——授权记忆为会话级、
 *       不自动续期，续期凭据属令牌层，审批授权不共享该通道）；§9.3 第 7 条（park 泄漏
 *       防线：超时自动 deny + 会话关停 cancel 全部 pending，两者均不可配置关闭）；
 *       §5.11.7（三态披露：审批超时 deny ≠ 用户拒绝 deny——abandoned ≠ refuted）。
 * 阶段：S16（智能体审批语义，批次 3a）——三档授权（once/object/class）、豁免通道封闭
 *       枚举、park/resume 一等阻塞、超时自动 deny、cancelAllPending/dispose、
 *       delete-permanent 分档；No-Löb 硬排除（meta/no-lob.ts）随本批次先置（§8.1）。
 *
 * 实现载体（M0 裁定 1A，2026-09-30）：FiberParkHandle 的 park/resume 语义保留，实现不落
 * vendor/cordis Fiber（M0 证实其为插件生命周期原语、无协程挂起原语）。本镜像以
 * Promise + AbortSignal + 定时器落地：park = 请求挂起等待决定；resume = 决定到达后唤醒
 * （decide 回调返回 / resolve() 手动回填，先到先得）；cancel/超时 = AbortSignal/定时器。
 * 并入 dsh 时由 dsh 侧 ApprovalGate 包装层接线（approval/asked/decided 审计对、waterfall
 * 事件、signal 透传；"等待期间会话可响应"由 idle/running 相位机承载），接口语义不变。
 *
 * 判定流（方案 §5.3.6，效果处理器的统一审批流程）：
 *   No-Löb 硬排除 → 豁免判定（封闭枚举）→ 授权记忆 lookup（三档）→ 未命中则 park 等待
 *   审批员决定 → approve/deny/timeout/cancel → 写审计。park 期间事件循环继续（R15）。
 *
 * delete-permanent 分档（R17 雏形）：fs.delete-permanent 不在豁免枚举内（temp-area 仅
 * fs.write、trash-default 仅 fs.trash），除用户预授权（user-preauthorized）外必须逐次
 * 审批——对接 S12 处理器的 deny 位（handlers.ts 未注入审批服务时恒 deny 的语义保持）。
 *
 * SEC 码位论证（§5.11.1 信任语义准入——结论：零新增，SEC-3xxx 段维持留白）：
 * - S16 审批判定是新信任授予通道判定面：approve 产生 GrantRecord（授权记忆 = 可被授予的
 *   信任），按准入纪律属"携带信任语义"的增量——但 §5.11.1 裁定的是"允许存在"，
 *   不是"必须登记诊断码位"；S16 的存在性由本方案 §5.3.6 直接立项，不需码位背书。
 * - SEC 码位（§5.11.6 一码一规则）登记的是诊断可定位性载体。审批服务的每个判定出口
 *   均以封闭枚举字段承载可定位性：approvalDecision（approved/denied/timeout/auto/
 *   auto-by-provenance/exempted）+ exemption（四通道）+ grantId（授权记忆溯源）+ reason
 *   （no-lob / 超时 / 取消 / 用户 note），不依赖自由文本诊断——无"一码一规则"的登记缺口。
 * - 授权判定逻辑不新注入可执行面：decide 为注入的判定回调（镜像模拟"用户/审批员"，
 *   不真连 UI），其返回值仅影响放行判定，不经 new Function/eval 执行，不可被构造为
 *   表达式注入通道（对照 SEC-1015 先例：白名单求值器因 new Function 执行而登记，
 *   本处无执行语义）。
 * - No-Löb 拒绝以 MembraneAuditEntry.reason='no-lob' 承载（§5.11.2 原文形态）。
 * - 因此零码位新增（呼应批次 2b 裁定 14A"纯机制/策略载体零码位"）。若 S23 机器化需要
 *   审批拒绝的细分码位（如三态披露分列统计），届时按 §5.11.9 流程提案，不预登。
 */

import { randomUUID } from 'node:crypto'

import type { EffectAuditEntry, EffectRequest, EffectType } from '../effect.ts'
import { assertNotMeta, isMetaCaller } from '../meta/no-lob.ts'
import { isInside, openBeneath } from './handlers.ts'

/* ─────────────────────── 核心类型（方案 §5.3.6） ─────────────────────── */

/** 授权范围——审批通过后记住什么（三档：单次 / 对象级 / 类级，方案 §5.3.6 GrantScope） */
export type GrantScope = 'once' | 'object' | 'class'

/**
 * 审批结果判定——四值：
 * - 'approved' ：用户批准（豁免/授权记忆命中归一为此值，细分档见 auditEntry.approvalDecision）；
 * - 'denied'   ：用户显式拒绝；
 * - 'timeout'  ：等待审批超时自动 deny（§9.3 第 7 条；≠ 用户拒绝，§5.11.7 三态分列）；
 * - 'cancelled'：会话关停/取消唤醒（§9.3 第 7 条；审计以 timeout 语义记账，方案 §5.3.6）。
 */
export type ApprovalDecision = 'approved' | 'denied' | 'timeout' | 'cancelled'

/**
 * 审批员回复——decide 回调与手动回填的输入（方案 §5.3.6 ApprovalDecision 原形态，
 * 更名 Reply 以让位给结果四值枚举）。
 */
export interface ApprovalReply {
  verdict: 'approve' | 'reject'
  /** 批准时选择的记忆范围："就这一次"（once，缺省不记忆）/"这个目标随你写"（object）/"这类操作都放行"（class） */
  scope?: GrantScope
  note?: string
}

/** 授权记忆条目（方案 §5.3.6 ApprovalGrant；扩展 caller/type 字段以承载匹配键） */
export interface GrantRecord {
  id: string
  /** 授权范围：once 不记忆；object 记精确目标；class 记效果类型 + 插件 */
  scope: GrantScope
  /** object 级：精确目标（fs 类经 openBeneath 规范化；net/proc/env/mcp 原样） */
  objectKey?: string
  /** class 级键：`${type}#${caller}`（效果类型 + 插件 id） */
  classKey: string
  /** 授权者：user（显式）| policy（策略自动）| provenance（来源豁免） */
  grantedBy: 'user' | 'policy' | 'provenance'
  issuedAt: number
  /**
   * 会话级授权随会话失效、不跨会话残留（方案 §5.3.6）——会话结束 dispose 作废；
   * 时钟过期为兜底；0 = 仅随会话失效（不按时钟过期）。
   * 对照 §5.2.6：审批授权无续期通道，续期凭据（task-credential）属能力令牌层。
   */
  expiresAt: number
  /** 本轮任务 id——provenance 豁免的判定依据 */
  taskId?: string
  /** 授权归属调用者——grant 不跨调用者消费（R11 fiber 隔离精神；No-Löb：不可自授自消） */
  caller: string
  /** 授权覆盖的效果类型（class 级匹配成分；object 级同样绑定类型） */
  type: EffectType
}

/** recordGrant 入参（id / classKey / issuedAt / expiresAt 缺省由服务生成） */
export interface GrantInput {
  scope: GrantScope
  /** object 级：精确目标键（可省略——批准路径由服务以 objectKeyOf(req) 填充） */
  objectKey?: string
  grantedBy: 'user' | 'policy' | 'provenance'
  type: EffectType
  /** 授权归属调用者（META_CALLERS 被硬排除，R39） */
  caller: string
  /** 缺省按会话级 TTL（DEFAULT_GRANT_TTL_MS）；0 = 仅随会话失效 */
  expiresAt?: number
  taskId?: string
}

/**
 * 豁免通道——封闭枚举（方案 §5.3.6 ExemptionKind + user-preauthorized 通道位；
 * 与 EffectAuditEntry.exemption 枚举对齐）。新增通道 = 携带信任语义的判定面增量，
 * 必须走 §5.11.9 变更裁定流程（§9.3 第 6 条：豁免通道膨胀防线）。
 */
export type ExemptionKind =
  | 'same-session-artifact'
  | 'temp-area'
  | 'trash-default'
  | 'user-preauthorized'

/* ─────────────────────── 来源登记接口位（条款 1） ─────────────────────── */

/**
 * 来源登记接口位（方案 §5.3.6 条款 1——same-session-artifact 的判定依据）。
 * dsh 侧接线时由效果处理器在 fs.write 放行后回填；镜像由 ApprovalService 代登记
 * （接口位不变，替换实现零改动）。
 * No-Löb：豁免判定不可引用调用者自己产生的 provenance 记录为自己作证——
 * 判定入口（evaluateExemptionChannels）先过 isMetaCaller 排除。
 */
export interface ProvenanceRegistry {
  /** 判定 target 是否由 caller 在 taskId 任务内创建 */
  isCreatedBy(caller: string, target: string, taskId?: string): boolean
  /** 登记创建事实（fs.write 放行后回填） */
  recordCreation(caller: string, target: string, taskId?: string): void
}

/** 会话内存 min 实现（接口位标注：dsh 侧接线时替换为持久登记，同接口零改动） */
export class InMemoryProvenanceRegistry implements ProvenanceRegistry {
  private readonly creations = new Set<string>()

  isCreatedBy(caller: string, target: string, taskId?: string): boolean {
    return this.creations.has(provenanceKey(caller, target, taskId))
  }

  recordCreation(caller: string, target: string, taskId?: string): void {
    this.creations.add(provenanceKey(caller, target, taskId))
  }
}

function provenanceKey(caller: string, target: string, taskId?: string): string {
  return `${caller}::${target}::${taskId ?? ''}`
}

/* ─────────────────────── 票据 / 结果 / 选项 ─────────────────────── */

/** 审批票据——一次待人类决策的效果请求（方案 §5.3.6 ApprovalTicket） */
export interface ApprovalTicket {
  id: string
  request: EffectRequest
  createdAt: number
  /** 超时自动 deny——不可配置关闭（§9.3 第 7 条） */
  timeoutMs: number
}

/** 审批结果——request() 的返回（含完整审计条目） */
export interface ApprovalOutcome {
  /** 最终判定（豁免/授权记忆命中归一为 'approved'，细分档见 auditEntry.approvalDecision） */
  decision: ApprovalDecision
  /** 是否放行 */
  ok: boolean
  /** 命中的豁免通道（免审批不等于不记录——审计条目同样记录） */
  exemption?: ExemptionKind
  /** 批准记忆 / 命中授权的条目 id（授权记忆溯源） */
  grantId?: string
  note?: string
  /** 审计条目（approvalDecision/exemption/grantId 已映射） */
  auditEntry: EffectAuditEntry
  /** 对应票据 id */
  ticketId: string
}

/** 构造选项 */
export interface ApprovalServiceOptions {
  /**
   * 审批员判定回调——镜像以可注入 decide 模拟"用户/审批员"（不真连 UI）；
   * dsh 侧由 ApprovalGate 包装层接线（park 期间会话可响应其他请求/取消/新输入）。
   * 回调故障（抛错/拒绝）→ fail-closed 以 denied 结算。
   */
  decide?: (req: EffectRequest, ticketId: string) => ApprovalReply | Promise<ApprovalReply>
  /** 单请求超时缺省（ms）——<=0 回退 DEFAULT_APPROVAL_TIMEOUT_MS（超时不可配置关闭，§9.3 第 7 条） */
  timeoutMs?: number
  /** 审计回调（免审批不等于不记录） */
  audit?: (entry: EffectAuditEntry) => void
  /** 临时区根（temp-area 豁免判定；缺省不启用该通道） */
  tempAreaRoot?: string
  /** 来源登记（same-session-artifact 判定；缺省不启用该通道） */
  provenance?: ProvenanceRegistry
  /** 会话当前任务 id（provenance 判定依据；方案 currentTaskId() 的镜像占位） */
  taskId?: string
  /** 授权记忆会话级 TTL 缺省（ms）；0 = 仅随会话失效（dispose 作废） */
  grantTtlMs?: number
  /** 时钟注入（测试） */
  now?: () => number
  /** 票据 / 授权 id 生成器注入（测试） */
  makeTicketId?: () => string
  makeGrantId?: () => string
}

/** 单次请求选项 */
export interface ApprovalRequestOptions {
  /** 外部取消信号（会话取消/调用方控制）；abort 即以 cancelled 唤醒（§9.3 第 7 条防泄漏） */
  signal?: AbortSignal
  /** 单次超时覆盖——<=0 回退构造缺省 */
  timeoutMs?: number
}

/** 单请求超时缺省（§9.3 第 7 条：超时自动 deny 不可配置关闭） */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000

/**
 * 授权记忆会话级 TTL 缺省（24h 时钟兜底）——"会话级授权随会话失效，不跨会话残留"
 *（方案 §5.3.6）；会话结束 dispose 作废全部授权记忆。
 */
export const DEFAULT_GRANT_TTL_MS = 24 * 60 * 60 * 1000

/* ─────────────────────── 豁免通道判定（封闭枚举） ─────────────────────── */

/**
 * 授权对象键——fs 类经 openBeneath 规范化（realpath 先行，与 handlers.ts 边界判定同锚），
 * 其余效果类型 target 原样（URL/命令名/环境变量名/MCP 工具名）。
 * 解析失败回退原样（判定继续，落 fail-closed 路径）。
 */
function objectKeyOf(req: EffectRequest): string {
  if (req.type.startsWith('fs.')) {
    try {
      return openBeneath(req.target)
    } catch {
      return req.target
    }
  }
  return req.target
}

/** temp 区判定（路径解析失败视为不在区内——落审批，fail-closed） */
function isInsideSafe(target: string, root: string): boolean {
  try {
    return isInside(openBeneath(target), root)
  } catch {
    return false
  }
}

/**
 * 豁免通道判定（封闭枚举；方案 §5.3.6 evaluateExemption 的扩展形态，逐条款顺序）：
 * 1. same-session-artifact：fs.write 且 provenance 判定"同任务同调用者创建"（R14）；
 * 2. temp-area：fs.write 落临时区；
 * 3. trash-default：fs.trash 回收站式删除，默认安全语义低门槛放行。
 *
 * user-preauthorized 不在此判定——用户明确指定的预授权在授权库 lookupGrant 中体现
 * （方案 §5.3.6 原注："用户明确指定的预授权在授权库 lookupGrant 中体现，不在此重复"），
 * 由 isUserPreauthorizedGrant 在 lookupGrant 命中处判定并记审计。
 *
 * No-Löb 硬排除（R39）：元层调用者永不进豁免通道（含 provenance 自证防线）。
 */
export function evaluateExemptionChannels(
  req: EffectRequest,
  ctx: { tempAreaRoot?: string; provenance?: ProvenanceRegistry; taskId?: string },
): ExemptionKind | undefined {
  // No-Löb：元层调用者永不进豁免通道（授权/豁免双入口纵深防御）
  if (isMetaCaller(req.caller)) return undefined
  if (req.type === 'fs.write') {
    // 条款 1：本轮任务内本调用者创建的产物——写自己写过的文件（provenance 判定）
    if (ctx.provenance && ctx.provenance.isCreatedBy(req.caller, objectKeyOf(req), ctx.taskId)) {
      return 'same-session-artifact'
    }
    // 条款 2：写入指定临时区
    if (ctx.tempAreaRoot && isInsideSafe(req.target, ctx.tempAreaRoot)) {
      return 'temp-area'
    }
  }
  // 条款 3：回收站式删除是默认安全语义，低门槛放行
  if (req.type === 'fs.trash') {
    return 'trash-default'
  }
  return undefined
}

/** user-preauthorized 通道位判定：授权记忆中用户显式授权命中即预授权豁免 */
export function isUserPreauthorizedGrant(grant: GrantRecord | undefined): boolean {
  return grant !== undefined && grant.grantedBy === 'user'
}

/* ─────────────────────── ApprovalService ─────────────────────── */

/** park 中的挂起登记（内部） */
interface PendingEntry {
  ticket: ApprovalTicket
  settleOutcome: (o: ApprovalOutcome) => void
  timer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
  settled: boolean
}

/** 唤醒来源（先到先得：决定/超时/取消竞争，幂等结算） */
type SettleSource =
  | { kind: 'reply'; reply: ApprovalReply }
  | { kind: 'timeout' }
  | { kind: 'cancel'; reason: string }

/**
 * 审批服务——一等阻塞状态的管理者（方案 §5.3.6 ApprovalService 接口的类实现）。
 * 效果处理器的统一审批流：No-Löb 硬排除 → 豁免判定 → 授权记忆 lookup →
 * 未命中则 park 等待决定 → approve/deny/timeout/cancel → 写审计。
 *
 * park/resume 一等阻塞：park = 请求挂起（Promise 挂起等待决定，事件循环继续）；
 * resume = 决定到达后唤醒（decide 回调返回 / resolve() 手动回填，先到先得）。
 * 并发性：每个请求独立挂起登记，park 期间服务可继续处理其他请求（R15）。
 *
 * 结构兼容：lookupGrant(req) 满足 handlers.ts 的 ApprovalServiceStub 形态
 * （lookupGrant?(req): unknown）——可经 FsEffectHandler 的 approval 注入位直接接线。
 */
export class ApprovalService {
  private readonly decide?: (req: EffectRequest, ticketId: string) => ApprovalReply | Promise<ApprovalReply>
  private readonly timeoutMs: number
  private readonly audit?: (entry: EffectAuditEntry) => void
  private readonly tempAreaRoot?: string
  private readonly provenance?: ProvenanceRegistry
  private readonly taskId?: string
  private readonly grantTtlMs: number
  private readonly now: () => number
  private readonly makeTicketId: () => string
  private readonly makeGrantId: () => string
  private grants: GrantRecord[] = []
  private readonly pending = new Map<string, PendingEntry>()
  private disposed = false

  constructor(opts: ApprovalServiceOptions = {}) {
    if (opts.decide !== undefined) this.decide = opts.decide
    // 超时不可配置关闭（§9.3 第 7 条）：<=0 / 缺省一律回退缺省值
    this.timeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_APPROVAL_TIMEOUT_MS
    if (opts.audit !== undefined) this.audit = opts.audit
    if (opts.tempAreaRoot !== undefined) this.tempAreaRoot = opts.tempAreaRoot
    if (opts.provenance !== undefined) this.provenance = opts.provenance
    if (opts.taskId !== undefined) this.taskId = opts.taskId
    this.grantTtlMs = opts.grantTtlMs ?? DEFAULT_GRANT_TTL_MS
    this.now = opts.now ?? Date.now
    this.makeTicketId = opts.makeTicketId ?? (() => `ticket_${randomUUID()}`)
    this.makeGrantId = opts.makeGrantId ?? (() => `grant_${randomUUID()}`)
  }

  /**
   * 发起审批：未命中豁免与授权记忆时 park（一等阻塞等待决定），命中则免问放行。
   * No-Löb：元层调用者直接拒（不进授权/豁免通道，审计照写）。
   */
  request(req: EffectRequest, opts: ApprovalRequestOptions = {}): Promise<ApprovalOutcome> {
    const ticketId = this.makeTicketId()

    // No-Löb 硬排除：元层调用者不进授权/豁免通道——直接拒。
    // 元记账照写（审计仍记录），但永不升级为对象层豁免（方案 §5.11.2）。
    if (isMetaCaller(req.caller)) {
      return Promise.resolve(this.noLobOutcome(req, ticketId))
    }

    // 会话已关停：服务不可用，一律拒（不 park——防 dispose 后泄漏挂起）
    if (this.disposed) {
      return Promise.resolve(this.staticOutcome(req, ticketId, 'denied', false, {
        approvalDecision: 'denied',
        reason: '审批服务已 dispose（会话已关停）',
      }))
    }

    // 豁免判定（封闭枚举）——命中即免审批，但审计仍记录
    const ex = evaluateExemptionChannels(req, {
      ...(this.tempAreaRoot !== undefined ? { tempAreaRoot: this.tempAreaRoot } : {}),
      ...(this.provenance !== undefined ? { provenance: this.provenance } : {}),
      ...(this.taskId !== undefined ? { taskId: this.taskId } : {}),
    })
    if (ex) {
      const entry = this.emitAudit(req, 'allow', {
        // R14：same-session-artifact 以 auto-by-provenance 分列；其余豁免通道记 exempted
        approvalDecision: ex === 'same-session-artifact' ? 'auto-by-provenance' : 'exempted',
        exemption: ex,
      })
      this.recordProvenance(req)
      return Promise.resolve({
        decision: 'approved', ok: true, exemption: ex,
        auditEntry: entry, ticketId,
      })
    }

    // 授权记忆 lookup——once/object/class/预授权任一命中即免问
    const grant = this.lookupGrant(req)
    if (grant) {
      const exemption = isUserPreauthorizedGrant(grant) ? 'user-preauthorized' : undefined
      const entry = this.emitAudit(req, 'allow', {
        approvalDecision: grant.grantedBy === 'provenance' ? 'auto-by-provenance' : 'auto',
        ...(exemption !== undefined ? { exemption } : {}),
        grantId: grant.id,
      })
      this.recordProvenance(req)
      return Promise.resolve({
        decision: 'approved', ok: true, grantId: grant.id,
        ...(exemption !== undefined ? { exemption } : {}),
        auditEntry: entry, ticketId,
      })
    }

    // park：一等阻塞——等待审批员决定（decide 回调 / resolve 回填 / 超时 / cancel）
    return this.park(req, ticketId, opts)
  }

  /**
   * 手动回填审批决定（resume 通道；与 decide 回调先到先得）。
   * @returns 票据存在且未决时 true；票据不存在/已决时 false（幂等）
   */
  resolve(ticketId: string, reply: ApprovalReply): boolean {
    if (!this.pending.has(ticketId)) return false
    this.settle(ticketId, { kind: 'reply', reply })
    return true
  }

  /**
   * 登记授权记忆（META_CALLERS 硬排除——元层调用者抛 SecurityViolation，R39）。
   * once 档可入库但不进免问匹配（R13：once 不记忆）。
   */
  recordGrant(input: GrantInput): GrantRecord {
    // No-Löb 硬排除：元层调用者不可登记授权（grant 不可被颁发者自己消费的前置防线）
    assertNotMeta(input.caller, `recordGrant(${input.type})`)
    const grant: GrantRecord = {
      id: this.makeGrantId(),
      scope: input.scope,
      ...(input.objectKey !== undefined ? { objectKey: input.objectKey } : {}),
      classKey: `${input.type}#${input.caller}`,
      grantedBy: input.grantedBy,
      issuedAt: this.now(),
      expiresAt: input.expiresAt !== undefined
        ? input.expiresAt
        : (this.grantTtlMs > 0 ? this.now() + this.grantTtlMs : 0),
      ...((input.taskId ?? this.taskId) !== undefined ? { taskId: input.taskId ?? this.taskId } : {}),
      caller: input.caller,
      type: input.type,
    }
    this.grants.push(grant)
    return grant
  }

  /**
   * 授权记忆查询（三档）——兼容 handlers.ts ApprovalServiceStub 形态
   * （命中返回条目 truthy，未命中 undefined）。
   * once 不记忆（R13）；object 记精确目标；class 记效果类型 + 插件。
   * No-Löb 纵深防御：元层调用者永不消费授权记忆（grant 不可被颁发者自己消费）。
   */
  lookupGrant(req: EffectRequest): GrantRecord | undefined {
    if (isMetaCaller(req.caller)) return undefined
    const key = objectKeyOf(req)
    const now = this.now()
    for (const g of this.grants) {
      if (g.scope === 'once') continue // once 档不进免问记忆（R13）
      if (g.expiresAt > 0 && now > g.expiresAt) continue // 会话级授权时钟兜底
      if (g.caller !== req.caller) continue // grant 不跨调用者消费（fiber 隔离精神）
      if (g.type !== req.type) continue // 授权绑定效果类型（class 键成分）
      if (g.scope === 'object' && g.objectKey !== key) continue // object 级精确目标
      return g
    }
    return undefined
  }

  /**
   * 会话关停：cancel 全部挂起请求（§9.3 第 7 条强制语义，不可配置关闭）。
   * @returns 取消的挂起数
   */
  cancelAllPending(reason = 'session-shutdown'): number {
    const ids = [...this.pending.keys()]
    for (const id of ids) {
      this.settle(id, { kind: 'cancel', reason })
    }
    return ids.length
  }

  /** 会话结束：作废全部授权记忆 + cancel 全部 pending（方案 §5.3.6 dispose） */
  dispose(): void {
    this.disposed = true
    this.cancelAllPending('dispose（会话结束）')
    this.grants = []
  }

  /** 当前挂起票据（只读快照——测试与 dsh 侧 ApprovalGate 面板的观察口） */
  listPending(): ApprovalTicket[] {
    return [...this.pending.values()].map((e) => e.ticket)
  }

  /* ─────────────────────── 内部实现 ─────────────────────── */

  /** park：注册挂起登记 + 超时定时器 + 取消信号 + decide 驱动（事件循环不阻塞） */
  private park(req: EffectRequest, ticketId: string, opts: ApprovalRequestOptions): Promise<ApprovalOutcome> {
    const timeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : this.timeoutMs
    const ticket: ApprovalTicket = {
      id: ticketId, request: req, createdAt: this.now(), timeoutMs,
    }
    return new Promise<ApprovalOutcome>((settleOutcome) => {
      const entry: PendingEntry = { ticket, settleOutcome, settled: false }
      this.pending.set(ticketId, entry)

      // 超时自动 deny（§9.3 第 7 条；§5.11.7：超时 deny ≠ 用户 deny，三态分列）
      entry.timer = setTimeout(() => this.settle(ticketId, { kind: 'timeout' }), timeoutMs)

      // 外部取消信号（§9.3 第 7 条防泄漏：abort 即唤醒，不留永久 park）
      if (opts.signal) {
        const signal = opts.signal
        if (signal.aborted) {
          this.settle(ticketId, { kind: 'cancel', reason: '请求信号已中止' })
        } else {
          entry.signal = signal
          entry.onAbort = () => {
            const reasonText = String((signal as { reason?: unknown }).reason ?? '')
            this.settle(ticketId, { kind: 'cancel', reason: reasonText ? `请求信号中止：${reasonText}` : '请求信号中止' })
          }
          signal.addEventListener('abort', entry.onAbort)
        }
      }

      // 审批员判定回调驱动（镜像模拟"用户/审批员"；回调故障 fail-closed——
      // 同步抛错同样转入失败分支，不在 Promise executor 内逃逸）
      if (this.decide) {
        let driven: Promise<ApprovalReply>
        try {
          driven = Promise.resolve(this.decide(req, ticketId))
        } catch (err) {
          driven = Promise.reject(err)
        }
        driven.then(
          (reply) => this.settle(ticketId, { kind: 'reply', reply }),
          (err) => this.settle(ticketId, {
            kind: 'reply',
            reply: { verdict: 'reject', note: `审批员回调故障（fail-closed）：${String(err)}` },
          }),
        )
      }
    })
  }

  /** 结算（幂等：先到先得——决定/超时/取消竞争，首个到达者生效） */
  private settle(ticketId: string, source: SettleSource): void {
    const entry = this.pending.get(ticketId)
    if (!entry || entry.settled) return
    entry.settled = true
    this.pending.delete(ticketId)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)

    const req = entry.ticket.request

    if (source.kind === 'timeout') {
      entry.settleOutcome(this.staticOutcome(req, ticketId, 'timeout', false, {
        approvalDecision: 'timeout',
        reason: `审批超时自动 deny（等待 ${entry.ticket.timeoutMs}ms 无决定；§9.3 第 7 条）`,
      }))
      return
    }

    if (source.kind === 'cancel') {
      // cancel 以 timeout 语义记账（方案 §5.3.6 FiberParkHandle.cancel；§9.3 第 7 条防泄漏）
      entry.settleOutcome(this.staticOutcome(req, ticketId, 'cancelled', false, {
        approvalDecision: 'timeout',
        reason: `会话关停/取消：${source.reason}（cancelled，以 timeout 语义记账）`,
      }))
      return
    }

    const reply = source.reply
    if (reply.verdict === 'approve') {
      let grantId: string | undefined
      if (reply.scope && reply.scope !== 'once') {
        // 批准且选择记忆范围 → 登记授权记忆（once 不记忆，R13）
        const grant = this.recordGrant({
          scope: reply.scope,
          objectKey: objectKeyOf(req),
          grantedBy: 'user',
          type: req.type,
          caller: req.caller,
        })
        grantId = grant.id
      }
      const auditEntry = this.emitAudit(req, 'allow', {
        approvalDecision: 'approved',
        ...(grantId !== undefined ? { grantId } : {}),
        ...(reply.note !== undefined ? { reason: reply.note } : {}),
      })
      this.recordProvenance(req)
      entry.settleOutcome({
        decision: 'approved', ok: true,
        ...(grantId !== undefined ? { grantId } : {}),
        ...(reply.note !== undefined ? { note: reply.note } : {}),
        auditEntry, ticketId,
      })
      return
    }

    entry.settleOutcome(this.staticOutcome(req, ticketId, 'denied', false, {
      approvalDecision: 'denied',
      reason: reply.note ? `用户拒绝：${reply.note}` : '用户拒绝',
    }))
  }

  /** No-Löb 拒绝结果（审计照写：元记账，永不升级为对象层豁免） */
  private noLobOutcome(req: EffectRequest, ticketId: string): ApprovalOutcome {
    return this.staticOutcome(req, ticketId, 'denied', false, {
      approvalDecision: 'denied',
      reason: `No-Löb：元层调用者 '${req.caller}' 不进授权/豁免通道（方案 §5.11.2，R39）`,
    })
  }

  /** 统一构造结果 + 审计条目（verdict 由 ok 派生） */
  private staticOutcome(
    req: EffectRequest,
    ticketId: string,
    decision: ApprovalDecision,
    ok: boolean,
    extra: Partial<EffectAuditEntry>,
  ): ApprovalOutcome {
    const auditEntry = this.emitAudit(req, ok ? 'allow' : 'deny', extra)
    return { decision, ok, auditEntry, ticketId }
  }

  /** 统一构造效果审计条目并回调（免审批不等于不记录） */
  private emitAudit(
    req: EffectRequest,
    verdict: 'allow' | 'deny',
    extra?: Partial<EffectAuditEntry>,
  ): EffectAuditEntry {
    const entry: EffectAuditEntry = {
      timestamp: new Date(this.now()).toISOString(),
      type: req.type,
      target: req.target,
      caller: req.caller,
      verdict,
      ...extra,
    }
    this.audit?.(entry)
    return entry
  }

  /** fs.write 放行后代登记创建事实（接口位：dsh 侧接线时可由效果处理器登记，同接口） */
  private recordProvenance(req: EffectRequest): void {
    if (req.type === 'fs.write' && this.provenance) {
      this.provenance.recordCreation(req.caller, objectKeyOf(req), this.taskId)
    }
  }
}
