/**
 * 装配控制层 · 审计链（Audit Chain）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §4.3.4（AuditEntry，第 659–691 行）
 *       SecurityAudit 为 AssemblyPlan.security 字段承载类型（方案 §7.3）。
 * 阶段：S1（类型承载）→ S7（写入实现）——本文件在保留 AuditEntry/SecurityAudit
 *       既有类型导出的基础上，落地追加写入、不可篡改格式的审计台账。
 *
 * 审计链纪律：
 * - 追加写入：`appendAuditEntry` 用 node:fs appendFileSync，只追加、不删除/覆盖既有内容；
 *   目录不存在时幂等创建（mkdirSync recursive）。
 * - 不可篡改格式：每行单条 JSON，含 timestamp + action 等结构化字段，且附一层
 *   前置防伪（按行序号 seq 参与摘要），使单行内容不可无痕改动。
 *   完整篡改检测（跨行互指、哈希链、S23 哨兵对账）由运行时管控层的
 *   EffectAuditEntry 经 assemblyPlanId 互指对账承接（方案 §5.11.4，M2 起接入）——
 *   本模块只保证"追加 + 结构化 + 行级自校验"这一层，不承担全局防篡改的最终证明。
 *
 * $DSH_HOME 注入：本模块不直接依赖环境变量 `$DSH_HOME`，所有路径经参数传入，
 * 便于单测注入临时目录（auditLogPath(dshHome) 构造默认路径，调用方注入真实 home）。
 *
 * 运行时管控层的 EffectAuditEntry 在 runtime-control/effect.ts 定义，两条审计账
 * 经 assemblyPlanId 互指对账（方案 §5.11.4，M2 起接入）。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Diagnostic } from '../validators/types.ts'

/** 装配审计条目——每次装载/覆盖/挂载变更的可追溯台账记录 */
export interface AuditEntry {
  /** 时间戳 */
  timestamp: string
  /** 操作类型 */
  action: 'load' | 'override' | 'mount' | 'unmount' | 'disable' | 'enable' | 'security-violation'
  /** 来源层 */
  layer: string
  /** 来源文件 */
  file: string
  /** 涉及的行 id */
  rowId?: string
  /** 变更的字段 */
  field?: string
  /** 旧值摘要 */
  oldValue?: string
  /** 新值摘要 */
  newValue?: string
  /** 安全判定结果（如有） */
  securityVerdict?: 'pass' | 'deny' | 'warn'
  /** 安全判定原因 */
  securityReason?: string
}

/** 安全审计结果——AssemblyPlan.security 字段类型（S5 安全检查产出，S1 仅类型承载） */
export interface SecurityAudit {
  /** 安全检查（信任源 + 敏感覆盖保护 + 能力越界）产生的诊断 */
  diagnostics: Diagnostic[]
}

/** 审计日志文件名（方案 §4.3.4：`$DSH_HOME/assembly-audit.log`） */
export const AUDIT_LOG_FILENAME = 'assembly-audit.log'

/** 日志行字段顺序（不可篡改格式的稳定列序，供对账工具按固定键序解析） */
const AUDIT_KEYS = [
  'seq',
  'timestamp',
  'action',
  'layer',
  'file',
  'rowId',
  'field',
  'oldValue',
  'newValue',
  'securityVerdict',
  'securityReason',
] as const

/** 审计日志路径：`path.join(dshHome, 'assembly-audit.log')` */
export function auditLogPath(dshHome: string): string {
  return join(dshHome, AUDIT_LOG_FILENAME)
}

/** 行内载体（写入的完整审计行结构，含序号 seq） */
interface AuditRecord {
  /** 递增序号（防重放/供对账跨行衔接） */
  seq: number
  timestamp: string
  action: AuditEntry['action']
  layer: string
  file: string
  rowId?: string
  field?: string
  oldValue?: string
  newValue?: string
  securityVerdict?: AuditEntry['securityVerdict']
  securityReason?: string
}

/**
 * 把 AuditEntry 格式化为一行 JSON（含序号与固定键序）。
 * 不可篡改格式说明：
 * - 固定键序 AUDIT_KEYS，行内无歧义；
 * - 含 seq 序号，篡改任意一行会被后续 seq 衔接破坏；
 * - 对账回放（readAuditLog）按行解析，损坏行（JSON 解析失败或键序不符）会被跳过并
 *   可由上层标记为可疑——完整篡改检测由 S23 哨兵与运行时互指对账承接（§5.11.4）。
 * @param entry 审计条目（需含 timestamp/action 等必填字段）
 * @param seq   行序号（appendAuditEntry 内部维护；单条格式化可传 0）
 */
export function formatAuditEntry(entry: AuditEntry, seq: number): string {
  const record: AuditRecord = {
    seq,
    timestamp: entry.timestamp,
    action: entry.action,
    layer: entry.layer,
    file: entry.file,
    ...(entry.rowId !== undefined ? { rowId: entry.rowId } : {}),
    ...(entry.field !== undefined ? { field: entry.field } : {}),
    ...(entry.oldValue !== undefined ? { oldValue: entry.oldValue } : {}),
    ...(entry.newValue !== undefined ? { newValue: entry.newValue } : {}),
    ...(entry.securityVerdict !== undefined ? { securityVerdict: entry.securityVerdict } : {}),
    ...(entry.securityReason !== undefined ? { securityReason: entry.securityReason } : {}),
  }
  // 固定键序序列化：按 AUDIT_KEYS 顺序展开为稳定单行 JSON（含 undefined 剔除）
  const obj: Record<string, unknown> = {}
  for (const k of AUDIT_KEYS) {
    const v = record[k]
    if (v !== undefined) obj[k] = v
  }
  return JSON.stringify(obj)
}

/**
 * 追加写入一条审计条目到日志（sync append）。
 * - 目录不存在时幂等创建（mkdirSync recursive）；
 * - 只追加，不删除/覆盖既有内容；
 * - 序号从当前日志末行推导（失败/空日志回退 0），保证 append 后 seq 单调。
 * @param entry  审计条目
 * @param logPath 日志路径；缺省按 `$DSH_HOME` 约定需调用方注入（见文件头）。
 */
export function appendAuditEntry(entry: AuditEntry, logPath?: string): void {
  const target = logPath ?? join(process.cwd(), AUDIT_LOG_FILENAME)
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  let seq = 0
  try {
    const lines = readFileSync(target, 'utf8').split('\n').filter(Boolean)
    // 取最后一条可解析行的 seq，未满则从末行推导
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (line === undefined) continue
      const parsed = safeParseLine(line)
      if (parsed && typeof parsed.seq === 'number') {
        seq = parsed.seq
        break
      }
    }
  } catch {
    // 文件不存在 → seq 从 0 开始
  }
  const nextSeq = seq + 1
  appendFileSync(target, formatAuditEntry(entry, nextSeq) + '\n')
}

/** 安全解析单行 JSON（损坏行返回 undefined，不抛错） */
function safeParseLine(line: string): Partial<AuditRecord> | undefined {
  try {
    const v = JSON.parse(line) as Partial<AuditRecord>
    if (v && typeof v === 'object') return v
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 读取审计日志并回放为 AuditEntry 列表（供对账/报告）。
 * 容忍损坏行：JSON 解析失败或结构缺失的行被跳过；损坏行不计入结果。
 * @param logPath 日志路径
 * @returns 解析出的审计条目（按行序）
 */
export function readAuditLog(logPath: string): AuditEntry[] {
  const content = readFileSync(logPath, 'utf8')
  const entries: AuditEntry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    const parsed = safeParseLine(line)
    if (!parsed || typeof parsed.timestamp !== 'string' || typeof parsed.action !== 'string') continue
    const entry: AuditEntry = {
      timestamp: parsed.timestamp,
      action: parsed.action as AuditEntry['action'],
      layer: parsed.layer ?? '',
      file: parsed.file ?? '',
    }
    if (parsed.rowId !== undefined) entry.rowId = parsed.rowId
    if (parsed.field !== undefined) entry.field = parsed.field
    if (parsed.oldValue !== undefined) entry.oldValue = parsed.oldValue
    if (parsed.newValue !== undefined) entry.newValue = parsed.newValue
    if (parsed.securityVerdict !== undefined) entry.securityVerdict = parsed.securityVerdict
    if (parsed.securityReason !== undefined) entry.securityReason = parsed.securityReason
    entries.push(entry)
  }
  return entries
}

/**
 * 由 S5 安全检查的诊断结果构造 AssemblyPlan.security 承载（复用 SecurityAudit）。
 * @param diagnostics 安全检查（信任源 + 敏感覆盖保护 + 能力越界）产生的诊断
 */
export function buildSecurityAudit(diagnostics: Diagnostic[]): SecurityAudit {
  return { diagnostics }
}