/**
 * 运行时管控层 · 机制 1 真实接线：膜挂 Context.get 底层反射（reflect.get）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.1.3（与 Cordis 的集成）
 * 阶段：S10（服务膜接线）· 批次 1-4（运行时线真实接线）
 *
 * SEC 码位零新增论证（纯接线载体）：本文件不新增任何安全判定逻辑——
 * 拦截、拒绝与审计全部复用 S9 的 membrane.ts（createMembrane /
 * DEFAULT_MEMBRANE）；此处仅把「膜包装点」从镜像版的显式 ctx.get 平移到
 * Cordis 真实底层 Context.reflect.get，属纯接线载体，码位归 S9 既有核算。
 *
 * 与镜像版 integration.ts（installMembrane）的关系（批次 1-4 裁定）：
 * - 镜像版只覆盖「显式 ctx.get() 调用」；真实 Cordis 中 ctx.fs 这类
 *   Proxy 直读同样经由 reflect.get 解析（vendor/cordis/src/reflect.ts 的
 *   handler.get 落到 ctx.reflect.get），包装底层即全覆盖、无漏网。
 * - ReflectService 类型不被 @deepseek-ai/cordis 导出，不能按名导入；
 *   改用最小结构接口 ReflectLike 约束 ctx.reflect（结构兼容、无断言）。
 * - 本文件为纯新增适配层：不修改 Cordis 内核实现，也不改动镜像文件。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createMembrane, DEFAULT_MEMBRANE } from './membrane.ts'
import type { MembraneConfig, MembraneAuditEntry } from './membrane.ts'

/**
 * 最小反射接口——以结构约束 Cordis `Context.reflect`（ReflectService）。
 * 该具体类型未被 @deepseek-ai/cordis 导出；其 get(name, strict?) 与本
 * 接口结构兼容，故以本接口承载，不依赖未导出的类名。
 */
export interface ReflectLike {
  /**
   * 按服务名解析服务值。
   * @param name - 服务名。
   * @param strict - 仅返回当前活跃 fiber 提供的实现（真实实现默认 true）。
   * @returns 服务值；未提供/未激活时为 undefined。
   */
  get(name: string, strict?: boolean): unknown
}

/**
 * 包装反射层的 get——显式 ctx.get 与 Proxy 直读共用的服务解析底层出口。
 * 返回服务对象前装膜：undefined/null 与原始值直通；普通对象按注册表
 * 配置包装为膜代理（缺省回退 DEFAULT_MEMBRANE），拦截与审计全部复用
 * createMembrane。
 * @param reflect - 反射层（结构满足 ReflectLike；真实调用方传 ctx.reflect）。
 * @param membraneConfigs - 膜配置注册表（服务名 → MembraneConfig）。
 * @param auditCallback - 膜拦截审计回调（每次拦截产生 MembraneAuditEntry）。
 * @returns 还原函数：调用后把 reflect.get 恢复为原实现（卸载/测试隔离用）。
 */
export function wrapReflectGet(
  reflect: ReflectLike,
  membraneConfigs: ReadonlyMap<string, MembraneConfig>,
  auditCallback: (entry: MembraneAuditEntry) => void,
): () => void {
  const originalGet = reflect.get.bind(reflect)
  const wrappedGet = (name: string, strict?: boolean): unknown => {
    const raw = originalGet(name, strict)
    // 未提供/未激活（undefined）与空值（null）的服务直通——膜只包装真实服务
    if (raw === undefined || raw === null) return raw
    const config = membraneConfigs.get(name) ?? DEFAULT_MEMBRANE
    // 仅对普通对象包装膜；原始值（string/number/boolean）不需要
    if (typeof raw === 'object') {
      return createMembrane(raw, config, auditCallback)
    }
    return raw
  }
  reflect.get = wrappedGet
  return () => {
    reflect.get = originalGet
  }
}

/**
 * 为插件 Context 安装服务膜（Cordis 真实版）——包装 ctx.reflect.get 底层，
 * 同时覆盖显式 ctx.get 与 Proxy 直读（如 ctx.fs）两条服务解析路径。
 * @param ctx - Cordis Context（真实运行时对象；测试可用最小结构对象替代）。
 * @param membraneConfigs - 膜配置注册表（服务名 → MembraneConfig）。
 * @param auditCallback - 膜拦截审计回调（每次拦截产生 MembraneAuditEntry）。
 * @returns 还原函数：调用后把 reflect.get 恢复为原实现。
 */
export function installMembraneOnContext(
  ctx: Context,
  membraneConfigs: ReadonlyMap<string, MembraneConfig>,
  auditCallback: (entry: MembraneAuditEntry) => void,
): () => void {
  // ctx.reflect 的真实类型（ReflectService）未被 cordis 导出；其 get 与
  // ReflectLike 结构兼容，直接传入，不做 as unknown 断言。
  return wrapReflectGet(ctx.reflect, membraneConfigs, auditCallback)
}
