/**
 * 运行时管控层 · 机制 3：效果系统核心类型（Effect System）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.3.2
 * 阶段：S9（骨架）——本文件为效果系统全部公共类型；四类效果处理器
 *       （fs/net/proc/env）与 EffectApi 暴露随 S12 落地（effects/handlers.ts、
 *       effects/api.ts）；MCP 效果处理器随 S17、审批语义随 S16。
 *
 * 语义要点（方案原文）：
 * - 效果系统即 safety monitor（方案 §14.3 路线 3）：所有副作用（文件 I/O、网络、
 *   子进程、环境变量、MCP 调用与反向请求）不直接调用 Node.js API，而是经
 *   受控的效果处理器，逐点检查 sandbox 与 approval 策略。
 * - 每个效果都产生 EffectAuditEntry——免审批不等于不记录。
 * - fs.trash / fs.delete-permanent 两档拆分（v3）：回收站为默认删除语义、低门槛；
 *   永久删除须契约单独声明 + 审批。
 * - v4：MCP 反向请求三型（sampling/roots/elicitation）入效果类型——S19 接线。
 */

/** 效果类型（v3：删除拆分为回收站/永久两档；v4：新增 MCP 反向请求三型） */
export type EffectType = 'fs.read' | 'fs.write' | 'fs.stat'
  | 'fs.trash' | 'fs.delete-permanent'
  | 'net.fetch' | 'net.connect'
  | 'proc.spawn' | 'proc.exec'
  | 'env.get' | 'env.set'
  | 'mcp.call'
  | 'mcp.sampling-request' | 'mcp.roots-request' | 'mcp.elicitation-request'

/** 效果请求 */
export interface EffectRequest {
  type: EffectType
  /** 目标路径/URL/命令名/环境变量名/MCP 工具名 */
  target: string
  /** 附加参数 */
  args?: unknown[]
  /** 发起效果的插件 id（v3：含 fiber 后缀，如 'tool-fs#fiber-12'） */
  caller: string
  /** 发起效果时持有的能力令牌 id */
  capabilityTokenId?: string
  /** 产物类型标记（v3 新增，仅 fs.write）：intermediate 免审批、约束到临时区；缺省按 final 处理 */
  artifact?: 'intermediate' | 'final'
}

/** 效果处理器——对每个效果做权限检查后执行 */
export interface EffectHandler {
  /** 处理效果请求 */
  handle(req: EffectRequest): Promise<EffectResult>
}

/** 效果执行结果 */
export interface EffectResult {
  ok: boolean
  data?: unknown
  error?: string
  auditEntry: EffectAuditEntry
}

/** 效果审计条目——运行时管控层的第二本审计账（与装配审计链互指对账，§5.11.4） */
export interface EffectAuditEntry {
  timestamp: string
  type: EffectType
  target: string
  caller: string
  verdict: 'allow' | 'deny'
  reason?: string
  sandboxMode?: string
  approvalDecision?: 'approved' | 'denied' | 'auto' | 'auto-by-provenance' | 'exempted' | 'timeout'
  /** v3：本次批准写入授权库时的条目 id（授权记忆溯源） */
  grantId?: string
  /** v3：豁免通道（走豁免时记录，免审批不等于不记录） */
  exemption?: 'same-session-artifact' | 'temp-area' | 'trash-default' | 'user-preauthorized'
  /** v3：数据外发检查结果（net 类效果） */
  exfiltrationCheck?: 'pass' | 'blocked' | 'not-applicable'
  /** S17：MCP 调用参数摘要（截断，防审计账膨胀；方案 §5.3.7 审计要素） */
  paramsSummary?: string
  /** S17：MCP 调用结果摘要（截断；方案 §5.3.7 审计要素） */
  dataSummary?: string
  /**
   * v4（§5.11.4，A6 唯一载体移植）：本效果所属装配计划的互指键——
   * 装配审计链与效果审计链按 assemblyPlanId 对账的锚点。
   * M2 收口起（统一收口纪律第 4 条）由运行时管控层写入。
   */
  assemblyPlanId?: string
  /**
   * S21（§5.9.4）：激活 skill 引导的归因链——"哪个 skill 引导了哪个效果"
   * 成为一等审计维度。由 skill/attribution.ts 的 attributeSkillEffect 写入。
   * 仅 skill 激活期间的效果带此标注；非 skill 引导效果缺省无此字段。
   */
  activeSkill?: string
}
