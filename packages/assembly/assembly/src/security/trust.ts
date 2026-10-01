/**
 * 装配控制层 · 插件信任源（Plugin Trust Source）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §4.3.1（第 529–566 行）
 * 阶段：S5（安全管控）——信任策略是"能加载哪些插件包"的准入面，
 *       S2 展开器判定某层来源时经 `isSourceAllowed` 与 `allowedSourcesFor` 查询，
 *       越权来源产生 error 级 Diagnostic（信任源越界随 S5 装配进安全检查）。
 *
 * 默认策略表（方案 §4.3.1）：
 * | 信任等级 | workspace | vendor | signed registry | arbitrary |
 * |----------|-----------|--------|-----------------|-----------|
 * | trusted  | 允许      | 允许   | 允许            | 禁止      |
 * | user     | 允许      | 允许   | 允许            | 禁止      |
 * | preset   | 允许      | 允许   | 禁止            | 禁止      |
 * | patch    | 允许      | 禁止   | 禁止            | 禁止      |
 */

import type { TrustLevel } from '../resolver.ts'

/** 单信任等级允许的包来源模式 */
export interface TrustLevelConfig {
  /** 本仓库 packages/* 下的包 */
  workspacePackages: boolean
  /** vendor/* 下的包 */
  vendorPackages: boolean
  /** npm registry 已签名的包 */
  signedRegistry: boolean
  /** 任意 npm 包 */
  arbitrary: boolean
}

/** 信任策略——信任等级 → 允许的包来源模式 */
export interface TrustPolicy {
  levels: Record<'trusted' | 'user' | 'preset' | 'patch', TrustLevelConfig>
}

/** 包来源分类 */
export type TrustSource = 'workspace' | 'vendor' | 'signed' | 'arbitrary'

/**
 * 默认信任策略（方案 §4.3.1 默认策略表）。
 * 三个等级（trusted/user/preset）都禁止 arbitrary；patch 最严，仅允许 workspace。
 */
export const DEFAULT_TRUST_POLICY: TrustPolicy = {
  levels: {
    trusted: { workspacePackages: true, vendorPackages: true, signedRegistry: true, arbitrary: false },
    user: { workspacePackages: true, vendorPackages: true, signedRegistry: true, arbitrary: false },
    preset: { workspacePackages: true, vendorPackages: true, signedRegistry: false, arbitrary: false },
    patch: { workspacePackages: true, vendorPackages: false, signedRegistry: false, arbitrary: false },
  },
}

/** TrustSource → TrustLevelConfig 字段映射（源码行对齐） */
const SOURCE_KEY: Record<TrustSource, keyof TrustLevelConfig> = {
  workspace: 'workspacePackages',
  vendor: 'vendorPackages',
  signed: 'signedRegistry',
  arbitrary: 'arbitrary',
}

/**
 * 判定某信任等级是否允许加载给定来源的包（方案 §4.3.1）。
 * @param policy 信任策略（缺省传入 DEFAULT_TRUST_POLICY）
 * @param level  覆盖链信任等级（trusted > user > preset > patch）
 * @param source 包来源分类
 */
export function isSourceAllowed(policy: TrustPolicy, level: TrustLevel, source: TrustSource): boolean {
  return policy.levels[level][SOURCE_KEY[source]]
}

/**
 * 返回某信任等级在当前策略下允许的全部来源（用于准入消息与调试）。
 * @param policy 信任策略
 * @param level  覆盖链信任等级
 */
export function allowedSourcesFor(policy: TrustPolicy, level: TrustLevel): TrustSource[] {
  const cfg = policy.levels[level]
  return (Object.keys(SOURCE_KEY) as TrustSource[]).filter((s) => cfg[SOURCE_KEY[s]])
}