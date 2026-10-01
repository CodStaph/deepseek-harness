/**
 * 运行时管控层 · MCP 深度内建 · 反向请求效果化（InboundRequestHandler）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.8.3（第 2015–2054 行）
 * 阶段：S19（批次 4a，M4 MCP 深度内建）——把 server → client 的三类反向请求
 *       （sampling / roots / elicitation）全部效果化，堵"协议反向面完全开放"的
 *       真实越权通道（方案 §5.8.2 五面覆盖中的"协议反向面"）。
 *
 * 语义要点（方案 §5.8.3 判定纪律）：
 * - sampling 是一条完整外发链：恶意/被注入 server 借宿主 LLM 凭证发起任意 prompt →
 *   LLM 在宿主上下文执行 → 结果回传 server → server 经工具结果带出。
 *   逐环拦截：未声明能力即拒 → prompt 敏感核对 → 模型/token 预算强制 →
 *   **结果回传前过 exfiltration 检查**（与 §5.3.8 联动，R25/R26）。
 * - roots：返回集合 ⊆ 沙箱 workspaceRoot ∩ 声明 roots（R27）——server 请求暴露
 *   文件系统根，按沙箱策略收窄。
 * - elicitation：未声明 → deny；声明则纳入审批流，审批标注来源（"来自 MCP server X"，
 *   防钓鱼式收集，R28）。
 *
 * M0 调研修正（2026-09-30，裁定 5A——接受上探）：dsh 现状 Client capabilities 为空、
 * 无 setRequestHandler——反向请求通道当前完全未接线。S19 从"效果化改造"上探为
 * **从零接线**：本处理器为判定核心；通道声明与回调接线见 `mcp/runtime.ts` 的
 * `attachProtocol`（capabilities 声明 + setRequestHandler 三型回调）。对冲事实：该
 * 攻击面现状为零，上探不构成安全缺口扩大。
 *
 * SEC 码位结论：本文件为效果系统（fs/net/mcp 同源）的**既有判定面的新效果类型接入**——
 * 判定出口以 EffectType 三型（mcp.sampling-request / mcp.roots-request /
 * mcp.elicitation-request，已登记于 effect.ts）与封闭字段承载可定位性，不新增信任
 * 通道、不开辟新授权面——零码位新增，SEC-3xxx 段维持留白（§5.11.1 准入）。
 */

import type { McpCapability } from '@deepseek-ai/dsh-assembly'

import type { EffectAuditEntry, EffectRequest, EffectResult } from '../effect.ts'
import {
  checkExfiltration,
  DEFAULT_SENSITIVE_SCANNERS,
} from '../effects/exfiltration.ts'
import type { SensitiveScanner } from '../effects/exfiltration.ts'
import type { ApprovalService } from '../effects/approval.ts'
import { isInside } from '../effects/handlers.ts'

/** 反向请求类型——三型入 EffectType（effect.ts 已登记对应效果类型） */
export type InboundRequestType = 'sampling' | 'roots' | 'elicitation'

/** sampling 请求（server → 宿主请求 LLM 采样） */
export interface SamplingRequest {
  /** 宿主 LLM 的 prompt（内容敏感核对 + 外传检查对象） */
  prompt: string
  /** 请求的模型（须在契约 sampling.models 白名单内；缺省取白名单首项） */
  model?: string
  /** 请求 token 上限（须 ≤ 契约采样上限，超限截断，R25） */
  maxTokens?: number
}

/** sampling 结果（回传 server 前须过 exfiltration，R26） */
export interface SamplingResult {
  text: string
  model?: string
  tokenCount?: number
}

/** elicitation 请求（server → 宿主请求用户输入） */
export interface ElicitationRequest {
  prompt: string
}

/** 统一反向请求（handle() 输入） */
export type InboundRequest =
  | { type: 'sampling'; from: string; request: SamplingRequest }
  | { type: 'roots'; from: string }
  | { type: 'elicitation'; from: string; request: ElicitationRequest }

/** 反向请求来源解析——由 server id 定位归属插件及其契约能力面 */
export interface InboundSource {
  /** 归属插件 id（审计 caller 用） */
  owner: string
  /** 归属插件的 MCP 能力面（未声明 = undefined → 严格模式 deny / lenient 降级） */
  capability?: McpCapability
}
/** 来源解析回调（dsh 侧从 AssemblyPlan 的 server→owner 注册表取） */
export type InboundSourceLookup = (serverId: string) => InboundSource | undefined

/** 宿主 LLM 采样服务（镜像注入 mock；dsh 侧接宿主 llm 通道） */
export interface LlmSampler {
  sample(req: { prompt: string; model?: string; maxTokens?: number }): Promise<string>
}

/** 构造参数 */
export interface InboundRequestHandlerOptions {
  /** 来源解析（serverId → 归属插件 + 能力面） */
  lookup: InboundSourceLookup
  /** 审批服务（elicitation 走审批流；缺省无审批 → elicitation 一律 deny） */
  approval?: ApprovalService
  /** 审计回调（免审批不等于不记录） */
  audit: (entry: EffectAuditEntry) => void
  /** 宿主 LLM 采样器（sampling 执行） */
  llm?: LlmSampler
  /** 沙箱暴露根区（roots 推导交集基准；缺省 undefined = 仅按声明 roots 收窄） */
  workspaceRoots?: string[]
  /** sampling 结果回传数据上限（字节；缺省 DEFAULT_SAMPLING_OUTBOUND_BYTES） */
  maxOutboundBytes?: number
  /** 敏感扫描器集（prompt 与采样结果用；缺省 DEFAULT_SENSITIVE_SCANNERS） */
  sensitiveScanners?: readonly SensitiveScanner[]
  /** lenient 模式：未声明反向能力时降级放行（对应 --lenient-capabilities） */
  lenient?: boolean
}

/** sampling 结果回传缺省数据上限（宿主 LLM 结果通常数 KB，512KB 为防资源耗尽兜底） */
export const DEFAULT_SAMPLING_OUTBOUND_BYTES = 512 * 1024

/** 构造统一效果审计条目（allow/deny 共用；反向请求的 target = 来源 serverId） */
function makeAudit(
  req: InboundRequest,
  type: EffectAuditEntry['type'],
  caller: string,
  verdict: 'allow' | 'deny',
  extra?: Partial<EffectAuditEntry>,
): EffectAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    type,
    target: req.from,
    caller,
    verdict,
    ...extra,
  }
}

/**
 * 反向请求效果化处理器（方案 §5.8.3）。
 * 判定纪律：来源解析 → 能力检查（未声明即拒 / lenient 降级）→ 逐环拦截 →
 * 执行 → 审计。
 */
export class InboundRequestHandler {
  private readonly lookup: InboundSourceLookup
  private readonly approval?: ApprovalService
  private readonly audit: (entry: EffectAuditEntry) => void
  private readonly llm?: LlmSampler
  private readonly workspaceRoots?: string[]
  private readonly maxOutboundBytes: number
  private readonly scanners: readonly SensitiveScanner[]
  private readonly lenient: boolean

  constructor(opts: InboundRequestHandlerOptions) {
    this.lookup = opts.lookup
    if (opts.approval !== undefined) this.approval = opts.approval
    this.audit = opts.audit
    if (opts.llm !== undefined) this.llm = opts.llm
    if (opts.workspaceRoots !== undefined) this.workspaceRoots = opts.workspaceRoots
    this.maxOutboundBytes = opts.maxOutboundBytes ?? DEFAULT_SAMPLING_OUTBOUND_BYTES
    this.scanners = opts.sensitiveScanners ?? [...DEFAULT_SENSITIVE_SCANNERS]
    this.lenient = opts.lenient ?? false
  }

  /** 统一入口——按类型分发到三型判定链 */
  async handle(request: InboundRequest): Promise<EffectResult> {
    switch (request.type) {
      case 'sampling':
        return this.handleSampling(request.from, request.request)
      case 'roots':
        return this.handleRoots(request.from)
      case 'elicitation':
        return this.handleElicitation(request.from, request.request)
    }
  }

  /* ─────────────────── sampling（R25 / R26）─────────────────── */

  /**
   * sampling 效果化——逐环拦截：
   * 1. 来源解析 + 能力检查（sampling 未声明 → strict deny / lenient 降级）
   * 2. prompt 敏感核对（防把宿主自身凭证注入上下文）
   * 3. 模型白名单 + maxTokens 预算强制（超上限截断，R25）
   * 4. 宿主 LLM 采样
   * 5. 结果回传前过 exfiltration（R26——堵"借宿主 LLM 之名，行数据外发之实"）
   */
  async handleSampling(from: string, request: SamplingRequest): Promise<EffectResult> {
    const req: InboundRequest = { type: 'sampling', from, request }
    const src = this.lookup(from)

    if (!src) return this.deny(req, 'mcp.sampling-request', from, `未知 MCP server：${from}`)

    const cap = src.capability?.sampling
    if (!cap) {
      if (this.lenient) {
        return this.allow(req, 'mcp.sampling-request', from, 'lenient-undeclared-capability', undefined, undefined)
      }
      return this.deny(req, 'mcp.sampling-request', from,
        '插件未声明 sampling 能力（strict 拒绝；--lenient-capabilities 可降级）')
    }

    // 2. prompt 敏感核对（含敏感特征 → 拒，防注入宿主上下文）
    const promptExfil = checkExfiltration(request.prompt, this.maxOutboundBytes, this.scanners)
    if (promptExfil === 'blocked') {
      return this.deny(req, 'mcp.sampling-request', from, '采样 prompt 含敏感特征，拒绝注入宿主上下文')
    }

    // 3. 模型白名单（未指定 → 取白名单首项）+ token 预算强制（超上限截断，R25）
    const models = cap.models ?? []
    if (request.model !== undefined && !models.includes(request.model)) {
      return this.deny(req, 'mcp.sampling-request', from,
        `模型不在 sampling 白名单：${request.model}`)
    }
    const model = request.model ?? models[0]
    if (!model) {
      return this.deny(req, 'mcp.sampling-request', from, 'sampling 未声明任何模型')
    }
    const maxTokens = Math.min(request.maxTokens ?? cap.maxTokens, cap.maxTokens)

    // 4. 宿主 LLM 采样（未注入采样器 → deny，诚实边界：不做假 LLM）
    if (!this.llm) {
      return this.deny(req, 'mcp.sampling-request', from, '未注入宿主 LLM 采样器，sampling 拒绝')
    }
    const text = await this.llm.sample({ prompt: request.prompt, model, maxTokens })

    // 5. 结果回传前过 exfiltration（R26——借宿主 LLM 之名的数据外发）
    const outbound = checkExfiltration(text, this.maxOutboundBytes, this.scanners)
    if (outbound === 'blocked') {
      return this.deny(req, 'mcp.sampling-request', from, '采样结果含敏感特征，拦截回传', {
        exfiltrationCheck: 'blocked',
      })
    }

    const result: SamplingResult = { text, model, tokenCount: maxTokens }
    return this.allow(req, 'mcp.sampling-request', from, undefined, {
      dataSummary: resultSummary(text),
      exfiltrationCheck: outbound,
    }, result)
  }

  /* ─────────────────── roots（R27）─────────────────── */

  /**
   * roots 效果判定——server 请求暴露文件系统根。
   * 返回集合 ⊆ 沙箱 workspaceRoots ∩ 声明 roots（未声明 roots → 空）。
   */
  async handleRoots(from: string): Promise<EffectResult> {
    const req: InboundRequest = { type: 'roots', from }
    const src = this.lookup(from)
    if (!src) return this.deny(req, 'mcp.roots-request', from, `找不到来源 MCP server：${from}`)

    const declared = src.capability?.roots ?? []
    let exposed = declared

    // 与沙箱暴露根区取交集（R27：不超出 sandbox 策略）
    if (this.workspaceRoots && this.workspaceRoots.length > 0) {
      exposed = declared.filter((root) => this.workspaceRoots!.some((ws) => isInside(root, ws)))
    }

    return this.allow(req, 'mcp.roots-request', from, undefined, {
      reason: `roots-exposed-${exposed.length}`,
    }, exposed)
  }

  /* ─────────────────── elicitation（R28）─────────────────── */

  /**
   * elicitation 效果判定——未声明 → deny；声明则走审批流。
   * 审批全程保留来源标注（"来自 MCP server X"）——防钓鱼式收集（R28）。
   */
  async handleElicitation(from: string, request: ElicitationRequest): Promise<EffectResult> {
    const req: InboundRequest = { type: 'elicitation', from, request }
    const src = this.lookup(from)
    if (!src) return this.deny(req, 'mcp.elicitation-request', from, `找不到来源 MCP server：${from}`)

    if (src.capability?.elicitation !== true) {
      return this.deny(req, 'mcp.elicitation-request', from, '未声明 elicitation 能力，拒绝请求用户输入')
    }

    // 纳入审批流（缺省未注入审批 → 一律 deny，S16"无审批不执行"）
    if (!this.approval) {
      return this.deny(req, 'mcp.elicitation-request', from, '未注入审批服务，elicitation 拒绝（S16 语义）')
    }
    const effectReq: EffectRequest = {
      type: 'mcp.elicitation-request',
      target: from,
      caller: src.owner,
      args: [request],
    }
    const outcome = await this.approval.request(effectReq)
    if (!outcome.ok) {
      return this.deny(req, 'mcp.elicitation-request', from,
        `elicitation 未获审批：${outcome.decision}`, {
          ...(outcome.auditEntry.approvalDecision !== undefined ? { approvalDecision: outcome.auditEntry.approvalDecision } : {}),
        })
    }

    // 审批通过：返回带来源标注（R28——"来自 MCP server X"）
    return this.allow(req, 'mcp.elicitation-request', from, undefined, {
      ...(outcome.auditEntry.approvalDecision !== undefined ? { approvalDecision: outcome.auditEntry.approvalDecision } : {}),
      ...(outcome.auditEntry.exemption !== undefined ? { exemption: outcome.auditEntry.exemption } : {}),
      ...(outcome.auditEntry.grantId !== undefined ? { grantId: outcome.auditEntry.grantId } : {}),
    }, {
      prompt: request.prompt,
      from,
      note: `来自 MCP server ${from}`,
    })
  }

  private allow(
    req: InboundRequest, type: EffectAuditEntry['type'], caller: string,
    reason: string | undefined, extra: Partial<EffectAuditEntry> | undefined,
    data: unknown,
  ): EffectResult {
    const entry = makeAudit(req, type, caller, 'allow', { ...extra, ...(reason ? { reason } : {}) })
    this.audit(entry)
    return { ok: true, data, auditEntry: entry }
  }

  private deny(
    req: InboundRequest, type: EffectAuditEntry['type'], caller: string,
    reason: string, extra?: Partial<EffectAuditEntry>,
  ): EffectResult {
    const entry = makeAudit(req, type, caller, 'deny', { reason, ...extra })
    this.audit(entry)
    return { ok: false, error: reason, auditEntry: entry }
  }
}

/** 采样结果摘要（审计用）——截断长文本防审计账膨胀 */
function resultSummary(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}…(${text.length}字符)` : text
}