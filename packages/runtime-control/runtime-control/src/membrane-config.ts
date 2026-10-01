/**
 * 运行时管控层 · 服务膜配置注册表
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.1.4
 * 阶段：S10（服务膜接线）——注册表把「安全关键服务」与「普通服务」映射到对应膜配置，
 *       `installMembrane`（integration.ts）在挂载阶段据 registry 给 `ctx.get` 返回的服务对象装膜。
 *
 * 语义要点（方案原文）：
 * - 安全关键服务（sandbox/approval/permission/credentials/authorization/…）用 SENSITIVE_MEMBRANE——
 *   hidden internal 面、blocked setMode/setPolicy/override，阻断最危险变更面。
 * - 普通服务缺省走 DEFAULT_MEMBRANE（只读 mode/policy/config，sealed check/validate）。
 * - 注册表是「名 → 膜」的静态映射；真实服务实例与注册表键的对应关系在并入 dsh 时
 *   按 Cordis 实际注入的服务名对齐（镜像阶段以方案 §5.1.4 清单为基准）。
 */

import type { MembraneConfig } from './membrane.ts'
import { DEFAULT_MEMBRANE, SENSITIVE_MEMBRANE } from './membrane.ts'

/** 安全关键服务的膜配置注册表——强膜（阻断危险变更面 + 隐藏内部实现） */
export const SENSITIVE_SERVICE_MEMBRANES: ReadonlyMap<string, MembraneConfig> = new Map([
  ['sandbox', SENSITIVE_MEMBRANE],
  ['sandbox-policy', SENSITIVE_MEMBRANE],
  ['approval', SENSITIVE_MEMBRANE],
  ['permission', SENSITIVE_MEMBRANE],
  ['credentials', SENSITIVE_MEMBRANE],
  ['authorization', SENSITIVE_MEMBRANE],
  ['session-telemetry-otel', SENSITIVE_MEMBRANE],
])

/**
 * 普通服务的膜配置注册表——使用默认只读膜。
 * 缺省机制在 integration.ts：未命中任何注册表的服务回退到 DEFAULT_MEMBRANE。
 */
export const STANDARD_SERVICE_MEMBRANES: ReadonlyMap<string, MembraneConfig> = new Map([
  // 大多数服务使用 DEFAULT_MEMBRANE（只读 mode/policy/config，sealed check/validate）
])

/** 从「敏感 + 普通」两张注册表合并出服务→膜配置的完整查询表 */
export function buildMembraneRegistry(
  sensitive: ReadonlyMap<string, MembraneConfig> = SENSITIVE_SERVICE_MEMBRANES,
  standard: ReadonlyMap<string, MembraneConfig> = STANDARD_SERVICE_MEMBRANES,
): ReadonlyMap<string, MembraneConfig> {
  const merged = new Map<string, MembraneConfig>(standard)
  for (const [service, config] of sensitive) merged.set(service, config)
  return merged
}

/** 查询某服务的膜配置——未注册回退默认膜 */
export function resolveMembraneConfig(
  service: string,
  registry: ReadonlyMap<string, MembraneConfig> = buildMembraneRegistry(),
): MembraneConfig {
  return registry.get(service) ?? DEFAULT_MEMBRANE
}