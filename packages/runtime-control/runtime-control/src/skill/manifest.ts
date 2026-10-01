/**
 * 运行时管控层 · skill 面管控：SkillManifest 契约（三契同构 + 来源三级）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.9.2（SkillManifest 契约）
 * 阶段：S21（M5 三面收口·skill 面）——skill 的一切"能力"都是借宿主的：
 *       执行面天然走效果系统（skill 无独立执行通道，纯 Markdown 指令），
 *       风险面在指令语义；本文件承载 skill 的"声明面"（manifest），
 *       供装载期静态扫描（scan.ts）与运行期效果归因（attribution.ts）共用。
 *
 * 三契同构（方案 §5.9.2 原文）：SkillManifest 与 PluginContract / McpCapability
 * 同构——一切资源接入先声明能力面。capabilities 复用 assembly 的
 * CapabilityDeclaration（三契共用同一能力形状，全系统一份能力语义）。
 *
 * 来源三级（trusted/signed/unknown）：与 §5.8.5 沙箱档位共用同一信任体系，
 * 全系统一份信任分级，不做第二套。未声明 manifest 的 skill 视为
 * trust: 'unknown'，默认不装载（lenient 模式降级 warning，R35）。
 *
 * parseSkillFile 兼容位（M0 事实修正 T0.6）：dsh skill-filesystem 为手写按键
 * 解析、无严格 schema、未知字段静默忽略、metadata 透传袋；trust/capabilities
 * 为**可选字段**，缺省即 trust:'unknown' + 空能力面。本镜像以解析后的
 * frontmatter 对象承载（并入 dsh 时对齐 dsh-skill-filesystem 的真实 parseSkillFile）。
 *
 * SEC 码位论证：本文件为纯类型/解析载体——不引入判定面、不产出诊断、
 * 不开辟信任通道（§5.11.1 第 3 条）。零码位新增。
 */

import type { CapabilityDeclaration } from '@deepseek-ai/dsh-assembly'

/** skill 来源信任三级（与沙箱档位共用同一信任体系，§5.9.2） */
export type SkillTrust = 'trusted' | 'signed' | 'unknown'

/** 来源等级的信任秩（unknown 最低，供装载决策与诊断排序） */
export const SKILL_TRUST_RANK: Readonly<Record<SkillTrust, number>> = {
  unknown: 0,
  signed: 1,
  trusted: 2,
}

/**
 * SkillManifest——skill 的声明面（三契同构，§5.9.2）。
 * - id：skill 唯一标识
 * - trust：来源信任等级（trusted/signed/unknown）
 * - capabilities：本 skill 引导 LLM 使用的效果面（与运行时 CapabilityDeclaration 同构）
 */
export interface SkillManifest {
  id: string
  trust: SkillTrust
  capabilities: CapabilityDeclaration
}

/**
 * 未声明 manifest 的 skill 的缺省承载（R35 装载判定基准）。
 * 缺省 trust: 'unknown'——unknown skill 默认不装载（lenient 降级 warning）。
 * 缺省 capabilities: {}（空能力面）——不引导任何效果，严格模式零副作用。
 */
export const DEFAULT_UNKNOWN_MANIFEST: SkillManifest = {
  id: '',
  trust: 'unknown',
  capabilities: {},
}

/** parseSkillFile 的输入形态——镜像阶段以解析后的 frontmatter 对象承载 */
export interface SkillFileInput {
  /** skill 标识（frontmatter id；缺省 ''） */
  id?: string
  /** 信任等级（frontmatter trust；缺省 'unknown'） */
  trust?: SkillTrust
  /** 能力面（frontmatter capabilities；缺省 {}） */
  capabilities?: CapabilityDeclaration
}

/** trust 字段白名单（严格校验，未知值降级 unknown，防伪装 trusted） */
const TRUST_VALUES: readonly SkillTrust[] = ['trusted', 'signed', 'unknown']

/**
 * parseSkillFile 兼容位（M0 修正 T0.6）——把 skill 文件解析后的 frontmatter
 * 归一化为 SkillManifest。缺省语义：
 * - trust 缺失或非法 → 'unknown'（安全默认，绝不因缺字段而放行 trusted/signed）；
 * - id 缺失 → ''（标记未标识 skill）；
 * - capabilities 缺失 → {}（空能力面）。
 * 未知字段静默忽略（dsh-skill-filesystem 手写按键解析行为）。
 *
 * @param input skill 文件解析后的 frontmatter 对象
 * @returns 归一化 SkillManifest（trust/capabilities 均为安全默认，不抛出）
 */
export function parseSkillFile(input: SkillFileInput | undefined | null): SkillManifest {
  if (!input || typeof input !== 'object') return { ...DEFAULT_UNKNOWN_MANIFEST }
  const id = typeof input.id === 'string' ? input.id : ''
  const trust: SkillTrust = TRUST_VALUES.includes(input.trust as SkillTrust) ? input.trust as SkillTrust : 'unknown'
  const capabilities = input.capabilities && typeof input.capabilities === 'object' ? input.capabilities : {}
  return { id, trust, capabilities }
}

/** 判断 skill 是否达到某信任等级（≥ 该等级秩） */
export function meetsTrustLevel(manifest: SkillManifest, required: SkillTrust): boolean {
  return SKILL_TRUST_RANK[manifest.trust] >= SKILL_TRUST_RANK[required]
}

/** 来源等级是否能装载（unknown 默认不装载——R35） */
export function isSkillLoadable(manifest: SkillManifest): boolean {
  return manifest.trust !== 'unknown'
}