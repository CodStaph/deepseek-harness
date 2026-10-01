/**
 * 运行时管控层 · 机制 3：MCP 效果处理器（McpEffectHandler）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.3.7（第 1545–1585 行）
 * 阶段：S17（批次 3b，M3 智能体运行语义）——把进程外 MCP 工具调用（`mcp.call`）
 *       纳入效果系统，堵住 v2/v3 跨层外呼整层落在管控面之外的洞（R9/R18）。
 *
 * 语义要点（方案 §5.3.7，判定流）：
 *   req.target = 'serverName.toolName'（方案原文形态）。
 *   1. 契约能力检查：McpCapability.servers / tools 白名单匹配（精确或 '*' 通配）。
 *   2. denyParamPatterns：参数模式黑名单（序列化后子串匹配）。
 *   3. 数据外发检查：估算参数字节 + 敏感扫描（复用 effects/exfiltration.ts），
 *      R19 在 MCP 调用面的落地——参数即出站载荷。
 *   4. 审批：默认 ask（走 ApprovalService.request 完整审批流：豁免/授权记忆/park），
 *      与 fs/net 处理器同纪律——免审批不等于不记录。
 *   5. 执行：经 McpClientAdapter 发起调用（镜像阶段为注入的适配层，非真实 MCP）。
 *   6. 审计：记 server/tool、参数摘要、结果摘要 + exfiltrationCheck。
 *   未声明 mcp 能力的插件调用：严格模式（默认）deny；lenient 降级 warning 放行
 *  （与既有能力过渡语义一致，方案 §5.3.7 诚实边界）。
 *
 * 诚实边界（方案 §5.3.7）：`mcp.call` 管住"发起了什么调用、带了什么参数"——server
 * 进程内部行为不在协议观察面内，由 v4 MCP 深度内建（S19/S20 沙箱档位）压至最小环境。
 *
 * SEC 码位结论：本文件为既有判定面（效果系统 + 审批 + 外发检查）的组合出口，不新增
 * 信任通道——server/tool/参数摘要/结果摘要均为既有 EffectAuditEntry 的数据字段承载，
 * 无新码位；SEC-3xxx 段维持留白（§5.11.1 准入）。
 */

import type { McpCapability } from '@deepseek-ai/dsh-assembly'

import type {
  EffectAuditEntry,
  EffectHandler,
  EffectRequest,
  EffectResult,
} from '../effect.ts'
import { checkExfiltration, DEFAULT_SENSITIVE_SCANNERS } from './exfiltration.ts'
import type { SensitiveScanner } from './exfiltration.ts'
import type { ApprovalService } from './approval.ts'

/** MCP 客户端适配层接口——把真实 MCP client（packages/mcp）调用隔离在效果处理器后 */
export interface McpClientAdapter {
  /** 发起一次 MCP 工具调用（返回工具结果；错误抛以触发 deny） */
  call(req: { server: string; tool: string; args: unknown }): Promise<unknown>
}

/** McpEffectHandler 构造参数 */
export interface McpEffectHandlerOptions {
  /** MCP 客户端适配层（进程外调用实体；镜像阶段为注入的 mock/占位实现） */
  client: McpClientAdapter
  /** 审批服务（S16 完整语义：豁免/授权记忆/park；未注入则 mcp.call 一律 deny） */
  approval?: ApprovalService
  /** 审计回调——每个 mcp.call 都产出 EffectAuditEntry（免审批不等于不记录） */
  audit: (entry: EffectAuditEntry) => void
  /** 插件契约声明的 MCP 能力面（未声明 = undefined → 严格模式 deny / lenient warning） */
  capability?: McpCapability
  /** 数据外发上限（字节）；undefined/0 = 该插件不允许 MCP 出站数据 */
  maxOutboundBytes?: number
  /** 敏感扫描器集（缺省 DEFAULT_SENSITIVE_SCANNERS，可追加插件专项特征） */
  sensitiveScanners?: readonly SensitiveScanner[]
  /** lenient 模式：未声明 mcp 能力时降级 warning 而非 deny（对应 --lenient-capabilities） */
  lenient?: boolean
  /** 沙箱运行模式回调（read-only 下禁止一切 MCP 副作用） */
  sandboxMode?: () => string
}

/** MCP 工具模式匹配——精确命中或 '*' 通配（'server.*' 形态） */
function mcpPatternMatch(patterns: readonly string[] | undefined, value: string): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((p) => p === value || (p.endsWith('*') && value.startsWith(p.slice(0, -1))))
}

/** 从 'serverName.toolName' 解析 server 与 tool（按首个 '.' 切分；无 '.' 视为 tool 缺省） */
export function parseMcpTarget(target: string): { server: string; tool: string } {
  const dot = target.indexOf('.')
  if (dot < 0) return { server: target, tool: '' }
  return { server: target.slice(0, dot), tool: target.slice(dot + 1) }
}

/** 参数序列化（denyParamPatterns 与字节估算用；对象经 JSON 序列化） */
function serializeArgs(args: unknown): string {
  if (typeof args === 'string') return args
  if (args == null) return ''
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

/** 参数摘要（审计用）——截断长参数字符串，避免审计账膨胀 */
function paramSummary(args: unknown): string {
  const s = serializeArgs(args)
  if (s.length <= 120) return s
  return `${s.slice(0, 120)}…(${s.length}字符)`
}

/** 结果摘要（审计用）——未知结果仅记类型/大小，不落全量载荷 */
function resultSummary(data: unknown): string {
  if (data == null) return String(data)
  if (typeof data === 'string') {
    return data.length > 120 ? `${data.slice(0, 120)}…(${data.length}字符)` : data
  }
  if (typeof data === 'object') {
    try {
      const s = JSON.stringify(data)
      return s.length > 120 ? `${s.slice(0, 120)}…(${s.length}字符)` : s
    } catch {
      return `[object]`
    }
  }
  return String(data)
}

/** 构造统一效果审计条目（allow/deny 共用） */
function makeAudit(
  req: EffectRequest,
  verdict: 'allow' | 'deny',
  extra?: Partial<EffectAuditEntry>,
): EffectAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    type: req.type,
    target: req.target,
    caller: req.caller,
    verdict,
    sandboxMode: 'mcp',
    ...extra,
  }
}

/**
 * MCP 效果处理器——把进程外工具调用纳入效果系统（方案 §5.3.7）。
 * 判定流：契约能力检查 → server/tool 白名单 → denyParamPatterns → 外发检查 →
 *          审批 → 执行 → 审计。
 */
export class McpEffectHandler implements EffectHandler {
  private readonly client: McpClientAdapter
  private readonly approval?: ApprovalService
  private readonly audit: (entry: EffectAuditEntry) => void
  private readonly capability?: McpCapability
  private readonly maxOutboundBytes: number | undefined
  private readonly sensitiveScanner: readonly SensitiveScanner[]
  private readonly lenient: boolean
  private readonly sandboxMode: () => string

  constructor(opts: McpEffectHandlerOptions) {
    this.client = opts.client
    if (opts.approval !== undefined) this.approval = opts.approval
    this.audit = opts.audit
    if (opts.capability !== undefined) this.capability = opts.capability
    this.maxOutboundBytes = opts.maxOutboundBytes
    this.sensitiveScanner = opts.sensitiveScanners ?? [...DEFAULT_SENSITIVE_SCANNERS]
    this.lenient = opts.lenient ?? false
    this.sandboxMode = opts.sandboxMode ?? (() => 'workspace-write')
  }

  async handle(req: EffectRequest): Promise<EffectResult> {
    if (req.type !== 'mcp.call') {
      return this.deny(req, `mcp 处理器不支持效果类型：${req.type}`)
    }
    if (this.sandboxMode() === 'read-only') {
      return this.deny(req, 'read-only 模式禁止 mcp.call')
    }

    // 1. 契约能力检查：未声明 mcp 能力 → 严格模式 deny / lenient 降级 warning
    if (!this.capability) {
      if (this.lenient) {
        return this.allow(req, {
          reason: 'lenient-undeclared-capability',
          exfiltrationCheck: 'not-applicable',
        })
      }
      return this.deny(req, '插件未声明 mcp 能力（strict 模式拒绝；--lenient-capabilities 可降级）')
    }

    // 2. 解析 server.tool 并做白名单匹配
    const { server, tool } = parseMcpTarget(req.target)
    if (!server || !tool) {
      return this.deny(req, `mcp.call target 须为 'server.tool'：${req.target}`)
    }
    if (!mcpPatternMatch(this.capability.servers, server)) {
      return this.deny(req, `MCP server 不在白名单：${server}`)
    }
    if (!mcpPatternMatch(this.capability.tools, `${server}.${tool}`)) {
      return this.deny(req, `MCP 工具不在白名单：${server}.${tool}`)
    }

    // 3. denyParamPatterns：参数模式黑名单（序列化后子串匹配）
    const args = (req.args ?? [])[0]
    const serialized = serializeArgs(args)
    for (const pattern of this.capability.denyParamPatterns ?? []) {
      if (serialized.includes(pattern)) {
        return this.deny(req, `参数命中 denyParamPatterns：'${pattern}'`, {
          exfiltrationCheck: 'blocked',
        })
      }
    }

    // 4. 数据外发检查（方案 §5.3.8 方向语义在 MCP 调用面的应用）
    const exfil = checkExfiltration(args, this.maxOutboundBytes, this.sensitiveScanner)
    if (exfil === 'blocked') {
      return this.deny(req, 'MCP 参数含敏感数据或超上限（数据外发检查拦截）', { exfiltrationCheck: 'blocked' })
    }

    // 5. 审批（默认 ask；豁免/授权记忆命中免问；未注入审批服务一律 deny）
    if (!this.approval) {
      return this.deny(req, '未注入审批服务，mcp.call 拒绝（S16 语义：无审批不执行）', {
        exfiltrationCheck: exfil,
      })
    }
    const outcome = await this.approval.request(req)
    if (!outcome.ok) {
      // cancelled 以 timeout 语义记账（§5.3.6），直接取审计字段而非 decision
      return this.deny(req, `MCP 调用未获审批：${outcome.decision}`, {
        ...(outcome.auditEntry.approvalDecision !== undefined ? { approvalDecision: outcome.auditEntry.approvalDecision } : {}),
        exfiltrationCheck: exfil,
      })
    }

    // 6. 执行 + 审计（豁免/授权记忆命中同样走放行；auditEntry 补 effect 侧审计）
    return this.executeAndAudit(req, server, tool, args, exfil, {
      ...(outcome.auditEntry.approvalDecision !== undefined ? { approvalDecision: outcome.auditEntry.approvalDecision } : {}),
      ...(outcome.auditEntry.exemption !== undefined ? { exemption: outcome.auditEntry.exemption } : {}),
      ...(outcome.auditEntry.grantId !== undefined ? { grantId: outcome.auditEntry.grantId } : {}),
    })
  }

  private async executeAndAudit(
    req: EffectRequest,
    server: string,
    tool: string,
    args: unknown,
    exfil: EffectAuditEntry['exfiltrationCheck'],
    extra: Partial<EffectAuditEntry>,
  ): Promise<EffectResult> {
    try {
      const data = await this.client.call({ server, tool, args })
      const entry = makeAudit(req, 'allow', {
        ...(exfil !== undefined ? { exfiltrationCheck: exfil } : {}),
        dataSummary: resultSummary(data),
        paramsSummary: paramSummary(args),
        ...extra,
      })
      this.audit(entry)
      return { ok: true, data, auditEntry: entry }
    } catch (err) {
      return this.deny(req, `MCP 调用执行失败：${String(err)}`, {
        ...(exfil !== undefined ? { exfiltrationCheck: exfil } : {}),
        ...extra,
      })
    }
  }

  private allow(req: EffectRequest, extra?: Partial<EffectAuditEntry>): EffectResult {
    const entry = makeAudit(req, 'allow', extra)
    this.audit(entry)
    return { ok: true, data: undefined, auditEntry: entry }
  }

  private deny(req: EffectRequest, reason: string, extra?: Partial<EffectAuditEntry>): EffectResult {
    const entry = makeAudit(req, 'deny', { reason, ...extra })
    this.audit(entry)
    return { ok: false, error: reason, auditEntry: entry }
  }
}