/**
 * 运行时管控层 · 机制 1 接线：installMembrane
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.1.3（与 Cordis 的集成）
 * 阶段：S10（服务膜接线）——覆盖 Context.get，在返回服务对象前装膜。
 *
 * 语义要点（方案原文）：
 * - 不修改 Cordis 内核的 ctx.get() 实现，而是在装配控制层挂载阶段注入：
 *   控制层 loader 挂载插件时拦截其 ctx 的 get，返回服务对象前包装膜。
 * - 仅对普通对象/函数包装膜；原始值（string/number/boolean）不需要。
 * - 未命中任何注册表的服务回退 DEFAULT_MEMBRANE。
 *
 * 镜像说明：本文件以最小 `MembraneContext` 接口模拟 Cordis `Context.get`（返回
 * `T | undefined`，与真实实现一致）；并入 dsh 时与 Cordis Context 类型对齐。
 * 安装后返回一个「还原函数」以便卸载/测试隔离——这是对方案 §5.1.3 的最小
 * 工程增强（方案只讲安装；还原用于卸载与测试）。
 */

import { createMembrane } from './membrane.ts'
import type { MembraneConfig, MembraneAuditEntry } from './membrane.ts'
import { DEFAULT_MEMBRANE } from './membrane.ts'

/** 可安装膜的最小上下文——镜像 Cordis Context 的 get（并入 dsh 时对齐） */
export interface MembraneContext {
  get<T>(key: string): T | undefined
}

/**
 * 为插件 Context 安装服务膜——覆盖 ctx.get，返回服务对象前装膜。
 * @returns 还原函数：调用后把 ctx.get 恢复为原实现（卸载/测试隔离用）。
 */
export function installMembrane(
  ctx: MembraneContext,
  membraneConfigs: ReadonlyMap<string, MembraneConfig>,
  auditCallback: (entry: MembraneAuditEntry) => void,
): () => void {
  const originalGet = ctx.get.bind(ctx)
  const wrappedGet = <T>(key: string): T | undefined => {
    const raw = originalGet<T>(key)
    if (raw === undefined || raw === null) return raw
    const config = membraneConfigs.get(key) ?? DEFAULT_MEMBRANE
    // 仅对普通对象/函数包装膜；原始值（string/number/boolean）不需要
    if (typeof raw === 'object') {
      return createMembrane(raw as object, config, auditCallback) as unknown as T
    }
    return raw
  }
  ctx.get = wrappedGet
  return () => {
    ctx.get = originalGet
  }
}