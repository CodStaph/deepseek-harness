/**
 * 运行时管控层 · skill 面管控：运行期效果归因 + taint 传递（attribution.ts）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.9.4（运行期效果归因联动）
 * 阶段：S21（M5 三面收口·skill 面）——激活 skill 期间 LLM 发起的每个效果，
 *       与当前 skill manifest 比对，归因链成为一等审计维度。
 *
 * 语义要点（方案 §5.9.4）：
 * - 声明外效果 → skill-capability-exceeded 诊断（默认 warning 强制审计；
 *   可配置为拦截；R33 雏形）；
 * - 归因链写入审计：{ effect, caller: pluginId#fiberId, activeSkill: skillId }
 *   ——"哪个 skill 引导了哪个效果"成为一等审计维度（R36）；
 * - taint 传递：skill 来源（trust 级）随指令进入 LLM 上下文标记，从 taint
 *   上下文导出的高敏感效果审批自动升级（14.4 第四重缓解）。
 *
 * SEC 码位论证：运行期归因诊断确为新管控面判定（M5 新增，方案 v4 §5.9.4），
 * 登记 SEC-6xxx 段（SEC-6004 skill-capability-exceeded）。归因链写入为审计
 * 字段扩展（activeSkill），非诊断规则，不占码位（§5.11.1 第 3 条）。
 */

import type { CapabilityDeclaration } from '@deepseek-ai/dsh-assembly'
import type { EffectAuditEntry, EffectType } from '../effect.ts'
import type { SkillManifest } from './manifest.ts'
import { SKILL_TRUST_RANK } from './manifest.ts'

/** skill 归因诊断码位（SEC-6xxx 段，见 SEC 登记表 §6） */
export const SKILL_ATTRIBUTION_CODES = {
  /** skill-capability-exceeded：激活 skill 引导的效果超出 manifest 声明（R33） */
  CAPABILITY_EXCEEDED: 'SEC-6004',
} as const

/** 效果类型 → 能力面键（与 post-hoc 同构；skill 归因判定复用） */
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

/** 高敏感效果类型——taint 来源 unknown 时审批自动升级（14.4 第四重缓解） */
const HIGH_SENSITIVE_TYPES: ReadonlySet<string> = new Set<string>([
  'fs.delete-permanent',
  'proc.spawn',
  'proc.exec',
  'net.fetch',
  'net.connect',
  'mcp.call',
])

/**
 * 判断一条效果是否落在 skill manifest 声明的能力面内。
 * @returns 'ok' 声明面内 / 'undeclared' 未声明该域 / 'exceeded' 声明但超出子域
 */
export function skillCapabilityVerdict(
  type: EffectType,
  declared: CapabilityDeclaration | undefined,
): { kind: 'ok' } | { kind: 'undeclared' } | { kind: 'exceeded' } {
  const face = EFFECT_TO_CAPABILITY[type]
  if (!declared || !face) return { kind: 'ok' } // 无 manifest 或无能力面对应 → 不判越界
  const cap = declared[face]
  if (!cap) return { kind: 'undeclared' }

  // 写类 fs 效果：需声明了对应写/删除子面
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
  // 网络效果：声明 { allow: [] }（空引导集）= 本 skill 不应引导任何网络效果
  if (type === 'net.fetch' || type === 'net.connect') {
    const netCap = cap as { allow?: string[] }
    if (!netCap.allow || netCap.allow.length === 0) return { kind: 'exceeded' }
  }
  return { kind: 'ok' }
}

/** 运行期 skill 归因输入 */
export interface SkillAttributionInput {
  /** 发起的效果（含 caller 与类型） */
  effect: EffectAuditEntry
  /** 当前激活的 skill manifest */
  activeSkill: SkillManifest
}

/** 归因判定结果 */
export interface SkillAttributionResult {
  /** 归因是否落在声明面内 */
  inScope: boolean
  /** 越界类别（inScope=false 时） */
  issue?: 'capability-exceeded'
  /** 是否需要审批升级（taint 传递，高敏感效果） */
  approvalUpgrade: boolean
  /** 归因后的审计标注（activeSkill + caller） */
  entry: EffectAuditEntry
}

/**
 * 运行期效果归因（§5.9.4）——比对效果与当前 skill manifest，写入 activeSkill 归因链。
 * - inScope=false 且 issue='capability-exceeded' → 默认 warning 强制审计（R33 雏形）；
 * - approvalUpgrade=true → 从 taint 上下文导出的高敏感效果审批自动升级。
 * 归因链以审计字段 activeSkill 承载（新审计维度），caller 保留插件/fiber 语义。
 */
export function attributeSkillEffect(input: SkillAttributionInput): SkillAttributionResult {
  const { effect, activeSkill } = input
  const verdict = skillCapabilityVerdict(effect.type, activeSkill.capabilities)
  const inScope = verdict.kind === 'ok'
  const entry: EffectAuditEntry = { ...effect, activeSkill: activeSkill.id || effect.caller }

  // taint 传递：unknown/signed 来源的高敏感效果升级审批
  const approvalUpgrade =
    HIGH_SENSITIVE_TYPES.has(effect.type) &&
    SKILL_TRUST_RANK[activeSkill.trust] < SKILL_TRUST_RANK.trusted

  if (!inScope) {
    return { inScope, issue: 'capability-exceeded', approvalUpgrade, entry }
  }
  return { inScope, approvalUpgrade, entry }
}

/**
 * 生成 skill 归因诊断（skill-capability-exceeded，R33）。
 * 默认 warning（强制审计，可配置为拦截）；并入 dsh 时挂效果审计账。
 */
export function skillExceededDiagnostic(result: SkillAttributionResult): import('@deepseek-ai/dsh-assembly').Diagnostic {
  return {
    severity: 'warning',
    code: SKILL_ATTRIBUTION_CODES.CAPABILITY_EXCEEDED,
    message: `skill 归因越界：效果 ${result.entry.type} 超出 manifest 声明能力面（activeSkill=${result.entry.activeSkill}）`,
    ...(result.entry.activeSkill !== undefined ? { nodeId: result.entry.activeSkill } : {}),
  }
}