/**
 * 运行时管控层 · skill 面管控：fs 装载链适配器（对接 dsh 真实 parseSkillFile 产出）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.9.2 / §5.9.3（S21）
 * 批次：1-4 真实装载链接线——把 dsh skill-filesystem 的 ParsedSkill 产出
 *       归一为 runtime-control 的 SkillManifest，供装载期静态扫描（scan.ts）
 *       与运行期效果归因（attribution.ts）消费。
 *
 * 适配边界（结构性最小输入，不引入 skill-filesystem 依赖）：
 * - 真实 ParsedSkill 形状：{ name, description, content, metadata?, ... }
 *   frontmatter 无 trust 字段；信任来源 = SkillSource + trustedHost。
 * - 本适配器以 RealSkillParsed 结构对齐真实形状，trust 由来源推导
 *   （防伪装：不信任来源的 frontmatter 自称 trusted/signed 一律降级 unknown）。
 *
 * SEC 码位论证：本文件为适配/编排载体——不产出诊断、不开辟信任通道、
 * 不新增 SEC 码位。判定面复用 SEC-6001–6004 既有码位（scan.ts 三类扫描）。
 */

import type { CapabilityDeclaration, Diagnostic, ValidationResult } from '@deepseek-ai/dsh-assembly'

import type { SkillFileInput, SkillManifest, SkillTrust } from './manifest.ts'
import { parseSkillFile } from './manifest.ts'
import { scanSkill, decideSkillLoading } from './scan.ts'

/** dsh SkillSource 的宽松字符串类型（语义对应 dsh SkillSource；bundled 是关键值） */
export type RealSkillSourceKind = string

/** 真实 ParsedSkill 的结构对齐形态（不引入 skill-filesystem 依赖） */
export interface RealSkillParsed {
  name: string
  description?: string
  /** 纯 Markdown body（frontmatter 已剥离） */
  content: string
  metadata?: Record<string, unknown>
}

/** 来源信息（对齐 dsh SkillRoot 的 source + trustedHost） */
export interface RealSkillSource {
  kind: RealSkillSourceKind
  trustedHost?: boolean
}

/** 装载评估结果 */
export interface SkillAssessment {
  manifest: SkillManifest
  diagnostics: Diagnostic[]
  load: boolean
  reason: string
}

/** 合法 SkillTrust 白名单（与 manifest.ts TRUST_VALUES 对齐，用于来源推导前校验） */
const TRUST_VALUES: readonly SkillTrust[] = ['trusted', 'signed', 'unknown']

/** 来源是否可信（bundled 或 trustedHost） */
function isSourceTrusted(source: RealSkillSource): boolean {
  return source.kind === 'bundled' || source.trustedHost === true
}

/**
 * 从真实 ParsedSkill + 来源推导 SkillManifest（安全优先）。
 *
 * trust 推导规则（防伪装）：
 * - metadata.trust 若为合法 SkillTrust 值则取之；
 * - 但若来源不信任（kind !== 'bundled' 且无 trustedHost），frontmatter 自称
 *   trusted/signed 一律降级 'unknown'（防伪装——只有可信来源才允许自称 trusted）；
 * - bundled 或 trustedHost 来源允许 frontmatter 声明，缺省 'trusted'。
 *
 * 复用 parseSkillFile 归一逻辑（从 metadata 构造 SkillFileInput 传入），不复制实现。
 */
export function toManifestFromSource(
  parsed: RealSkillParsed,
  source: RealSkillSource,
): SkillManifest {
  const meta = parsed.metadata ?? {}
  const rawTrust = meta.trust

  const declaredTrust: SkillTrust | undefined =
    typeof rawTrust === 'string' && TRUST_VALUES.includes(rawTrust as SkillTrust)
      ? (rawTrust as SkillTrust)
      : undefined

  const trusted = isSourceTrusted(source)

  let trust: SkillTrust
  if (declaredTrust !== undefined) {
    // frontmatter 有合法声明：可信来源尊重，不可信来源强制降级 unknown（防伪装）
    trust = trusted ? declaredTrust : 'unknown'
  } else {
    // frontmatter 无声明：可信来源缺省 trusted，不可信来源缺省 unknown
    trust = trusted ? 'trusted' : 'unknown'
  }

  // capabilities 从 metadata.capabilities 透传（对象时）
  const rawCaps = meta.capabilities
  const capabilities =
    rawCaps !== null && rawCaps !== undefined &&
    typeof rawCaps === 'object' && !Array.isArray(rawCaps)
      ? (rawCaps as CapabilityDeclaration)
      : undefined

  // 复用 parseSkillFile 归一逻辑（从 metadata 构造 SkillFileInput 传入）
  const input: SkillFileInput = { id: parsed.name, trust }
  if (capabilities !== undefined) {
    input.capabilities = capabilities
  }
  return parseSkillFile(input)
}

/**
 * 装载评估——合并 manifest 推导 + 装载期静态扫描 + 装载决策。
 * - manifest = toManifestFromSource(...)
 * - scanSkill({ text, manifest }) → diagnostics
 * - decideSkillLoading({ text, manifest }) → load / reason
 */
export function assessLoadedSkill(
  parsed: RealSkillParsed,
  source: RealSkillSource,
): SkillAssessment {
  const manifest = toManifestFromSource(parsed, source)
  const result: ValidationResult = scanSkill({ text: parsed.content, manifest })
  const decision = decideSkillLoading({ text: parsed.content, manifest })
  return {
    manifest,
    diagnostics: result.diagnostics,
    load: decision.load,
    reason: decision.reason,
  }
}
