/**
 * 运行时管控层 · 机制 1：服务膜（Service Membrane）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.1.2
 * 阶段：S9（骨架）——膜本体为纯机制、不接线：与 Cordis `ctx.get` 的集成
 *       （integration.ts 的 installMembrane）与膜配置注册表（membrane-config.ts）
 *       随 S10 落地；本阶段膜可独立构造与测试（R1 的雏形用例）。
 *
 * 语义要点（方案原文）：
 * - JS 对象没有封装边界，服务一旦暴露引用，消费者拥有全部读写权限——膜是 Proxy 拦截层。
 * - get 返回的函数绑定 this 到原始对象，防止通过解构窃取引用。
 * - defineProperty 一律拒绝——防 Object.defineProperty 篡改。
 * - 每次拦截都产生 MembraneAuditEntry 回调——免审批不等于不记录。
 */

/** 服务膜配置——描述一个服务对象的访问规则 */
export interface MembraneConfig {
  /** 不可写属性列表——set/delete 拦截 */
  readonly: string[]
  /** 不可删除属性列表 */
  sealed: string[]
  /** 不可访问属性列表——get 拦截 */
  hidden: string[]
  /** 不可调用方法列表——get 返回 throw-bound proxy */
  blocked: string[]
}

/** 默认服务膜配置——所有服务默认只读 */
export const DEFAULT_MEMBRANE: MembraneConfig = {
  readonly: ['mode', 'policy', 'presets', 'config'],
  sealed: ['check', 'validate', 'approve', 'reject', 'mode', 'policy'],
  hidden: [],
  blocked: [],
}

/** 安全关键服务的强化膜配置 */
export const SENSITIVE_MEMBRANE: MembraneConfig = {
  readonly: ['mode', 'policy', 'presets', 'workspaceRoot', 'config', 'exporter', 'url'],
  sealed: ['check', 'validate', 'approve', 'reject', 'mode', 'policy', 'presets'],
  hidden: ['internal', '_private', '_handlers'],
  blocked: ['setMode', 'setPolicy', 'override'],
}

/** 膜审计条目——每次拦截的记录单元 */
export interface MembraneAuditEntry {
  action: 'access-denied' | 'write-denied' | 'delete-denied' | 'call-blocked' | 'define-denied'
  property: string
  reason: string
  attemptedValue?: string
}

/** 运行时安全违规——携带审计条目的结构化异常（违规处理器 S14 消费） */
export class SecurityViolation extends Error {
  constructor(
    message: string,
    public readonly auditEntry: MembraneAuditEntry,
  ) {
    super(message)
    this.name = 'SecurityViolation'
  }
}

/** 为服务对象创建膜——对属性读写删定义做拦截并回调审计 */
export function createMembrane<T extends object>(
  target: T,
  config: MembraneConfig,
  auditCallback: (entry: MembraneAuditEntry) => void,
): T {
  return new Proxy(target, {
    get(obj, prop: string | symbol) {
      const key = String(prop)
      if (config.hidden.includes(key)) {
        const entry: MembraneAuditEntry = {
          action: 'access-denied', property: key, reason: 'hidden',
        }
        auditCallback(entry)
        throw new SecurityViolation(
          `访问被拒：属性 '${key}' 被膜标记为 hidden`,
          entry,
        )
      }
      if (config.blocked.includes(key)) {
        return () => {
          const entry: MembraneAuditEntry = {
            action: 'call-blocked', property: key, reason: 'blocked',
          }
          auditCallback(entry)
          throw new SecurityViolation(
            `调用被拒：方法 '${key}' 被膜标记为 blocked`,
            entry,
          )
        }
      }
      const value = Reflect.get(obj, prop)
      // 对返回的函数绑定 this 到原始对象，防止通过解构窃取引用
      if (typeof value === 'function') {
        return value.bind(obj)
      }
      return value
    },
    set(obj, prop: string | symbol, value) {
      const key = String(prop)
      if (config.readonly.includes(key)) {
        const entry: MembraneAuditEntry = {
          action: 'write-denied', property: key, reason: 'readonly',
          attemptedValue: String(value),
        }
        auditCallback(entry)
        throw new SecurityViolation(
          `写入被拒：属性 '${key}' 被膜标记为 readonly`,
          entry,
        )
      }
      return Reflect.set(obj, prop, value)
    },
    deleteProperty(obj, prop: string | symbol) {
      const key = String(prop)
      if (config.sealed.includes(key)) {
        const entry: MembraneAuditEntry = {
          action: 'delete-denied', property: key, reason: 'sealed',
        }
        auditCallback(entry)
        throw new SecurityViolation(
          `删除被拒：属性 '${key}' 被膜标记为 sealed`,
          entry,
        )
      }
      return Reflect.deleteProperty(obj, prop)
    },
    // 阻止 defineProperty——防止通过 Object.defineProperty 篡改
    defineProperty(_obj, prop: string | symbol, _descriptor: PropertyDescriptor) {
      const entry: MembraneAuditEntry = {
        action: 'define-denied', property: String(prop), reason: 'membrane',
      }
      auditCallback(entry)
      throw new SecurityViolation(
        `定义属性被拒：膜禁止 Object.defineProperty`,
        entry,
      )
    },
  })
}
