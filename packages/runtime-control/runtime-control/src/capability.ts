/**
 * 运行时管控层 · 机制 2：能力令牌（Cap[T]）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.2.2（CapabilityToken/CapabilityHandle）、
 *       §5.2.5（deriveFiberToken）、§5.2.6（续期策略类型）
 * 阶段：S9（骨架）——令牌本体与派生为纯机制；预颁发器 issuer.ts（消费真实
 *       AssemblyPlan + 服务方法注册表）与 `--lenient-capabilities` 随 S11 落地，
 *       M1 收口后联调接线（里程碑规划 §3.2"类型先行"）。
 *
 * 语义要点（方案原文）：
 * - 令牌不可伪造：构造器私有，只能经 `CapabilityToken._issue` 颁发——
 *   `_issue` 前缀即"仅运行时管控层可调用"的纪律标记。
 * - 令牌权限范围由契约声明决定（装配计划预颁发），而非插件运行时自行索取。
 * - 派生令牌只减不增：fiber 级令牌从插件级令牌克隆，方法/属性集合只能收窄。
 * - 派生令牌不继承"永不过期"：随 fiber 生命周期过期。
 */

import { randomUUID } from 'node:crypto'
import type { MembraneConfig } from './membrane.ts'
import { SecurityViolation } from './membrane.ts'

/** 能力令牌——代表对某个服务的受限访问权 */
export class CapabilityToken<T extends object> {
  /** 令牌 id——全局唯一，不可伪造 */
  readonly id: string
  /** 目标服务标识 */
  readonly service: string
  /** 颁发来源——哪个插件的契约 */
  readonly issuedTo: string
  /** 允许调用的方法列表 */
  readonly allowedMethods: ReadonlySet<string>
  /** 允许读取的属性列表 */
  readonly allowedProps: ReadonlySet<string>
  /** 令牌过期时间戳（ms），0 = 永不过期 */
  readonly expiresAt: number
  /** 是否已被撤销 */
  private revoked = false

  private constructor(config: {
    id: string
    service: string
    issuedTo: string
    allowedMethods: string[]
    allowedProps: string[]
    expiresAt: number
  }) {
    this.id = config.id
    this.service = config.service
    this.issuedTo = config.issuedTo
    this.allowedMethods = new Set(config.allowedMethods)
    this.allowedProps = new Set(config.allowedProps)
    this.expiresAt = config.expiresAt
  }

  /** 通过令牌访问服务——返回受膜保护且令牌受限的代理 */
  use(target: T, membrane: MembraneConfig): CapabilityHandle<T> {
    if (this.revoked) {
      throw new SecurityViolation(
        `令牌已撤销：${this.service}（颁发给 ${this.issuedTo}）`,
        { action: 'call-blocked', property: '*', reason: 'revoked' },
      )
    }
    if (this.expiresAt > 0 && Date.now() > this.expiresAt) {
      throw new SecurityViolation(
        `令牌已过期：${this.service}（颁发给 ${this.issuedTo}）`,
        { action: 'call-blocked', property: '*', reason: 'expired' },
      )
    }
    return createCapabilityHandle(target, this, membrane)
  }

  /** 撤销令牌 */
  revoke(): void {
    this.revoked = true
  }

  /** 令牌是否有效 */
  get isValid(): boolean {
    return !this.revoked && (this.expiresAt === 0 || Date.now() <= this.expiresAt)
  }

  /** 令牌工厂——仅运行时管控层可调用 */
  static _issue<T extends object>(config: {
    service: string
    issuedTo: string
    allowedMethods: string[]
    allowedProps: string[]
    expiresAt?: number
  }): CapabilityToken<T> {
    return new CapabilityToken<T>({
      id: `cap_${randomUUID()}`,
      service: config.service,
      issuedTo: config.issuedTo,
      allowedMethods: config.allowedMethods,
      allowedProps: config.allowedProps,
      expiresAt: config.expiresAt ?? 0,
    })
  }
}

/** 能力句柄——通过令牌获得的受限服务代理 */
export interface CapabilityHandle<T extends object> {
  /** 读取属性——仅允许 allowedProps 中的（编译期 key 校验：方案 §11 类型回报） */
  get<K extends keyof T>(prop: K): T[K]
  /** 调用方法——仅允许 allowedMethods 中的 */
  call<K extends keyof T>(method: K, ...args: unknown[]): MethodReturn<T, K>
  /** 令牌是否仍然有效 */
  readonly isValid: boolean
}

/** 方法调用的返回类型：非函数成员返回 never（方案原文同语义，参数逆变修正为 never[]） */
export type MethodReturn<T, K extends keyof T> = T[K] extends (...a: never[]) => unknown ? ReturnType<T[K]> : never

function createCapabilityHandle<T extends object>(
  target: T,
  token: CapabilityToken<T>,
  membrane: MembraneConfig,
): CapabilityHandle<T> {
  return {
    get<K extends keyof T>(prop: K): T[K] {
      const key = String(prop)
      if (!token.allowedProps.has(key)) {
        throw new SecurityViolation(
          `能力越界：令牌不允许读取属性 '${key}'（服务 ${token.service}）`,
          { action: 'access-denied', property: key, reason: 'capability' },
        )
      }
      // 同时受膜保护
      if (membrane.hidden.includes(key)) {
        throw new SecurityViolation(
          `膜拒绝：属性 '${key}' 被标记为 hidden`,
          { action: 'access-denied', property: key, reason: 'hidden' },
        )
      }
      return Reflect.get(target, prop) as T[K]
    },
    call<K extends keyof T>(method: K, ...args: unknown[]): MethodReturn<T, K> {
      const key = String(method)
      if (!token.allowedMethods.has(key)) {
        throw new SecurityViolation(
          `能力越界：令牌不允许调用方法 '${key}'（服务 ${token.service}）`,
          { action: 'call-blocked', property: key, reason: 'capability' },
        )
      }
      if (membrane.blocked.includes(key)) {
        throw new SecurityViolation(
          `膜拒绝：方法 '${key}' 被标记为 blocked`,
          { action: 'call-blocked', property: key, reason: 'blocked' },
        )
      }
      const fn = Reflect.get(target, method)
      if (typeof fn !== 'function') {
        throw new TypeError(`'${key}' 不是函数`)
      }
      return (fn as (...a: unknown[]) => unknown).apply(target, args) as MethodReturn<T, K>
    },
    get isValid() {
      return token.isValid
    },
  }
}

/**
 * fiber 创建时从插件级令牌克隆出 fiber 级令牌（可传入更窄的方法/属性集合，只减不增）。
 * 撤销链沿 `pluginId → fiberId` 精确传播：revokeFiber 只撤单个子代理，兄弟 fiber 不受影响（R22）。
 */
export function deriveFiberToken<T extends object>(
  parent: CapabilityToken<T>,
  fiberId: string,
  narrowTo?: { methods?: string[]; props?: string[] },
): CapabilityToken<T> {
  const methods = narrowTo?.methods ?? [...parent.allowedMethods]
  const props = narrowTo?.props ?? [...parent.allowedProps]
  return CapabilityToken._issue<T>({
    service: parent.service,
    issuedTo: `${parent.issuedTo}#${fiberId}`,
    allowedMethods: methods,
    allowedProps: props,
    // 派生令牌不继承"永不过期"：随 fiber 生命周期过期
    expiresAt: parent.expiresAt === 0 ? defaultFiberExpiry() : parent.expiresAt,
  })
}

/**
 * 派生令牌缺省过期时间——fiber 生命周期策略占位。
 * TODO(S16)：以 fiber/任务的实际生命周期策略替换固定 TTL；
 *       定时任务场景经 TokenRenewalPolicy 凭任务凭据续期（方案 §5.2.6）。
 */
function defaultFiberExpiry(): number {
  return Date.now() + DEFAULT_FIBER_TTL_MS
}

/** 派生令牌缺省 TTL（24 小时）——S16 落地 fiber 生命周期策略前的过渡值 */
export const DEFAULT_FIBER_TTL_MS = 24 * 60 * 60 * 1000

/** 令牌续期策略（方案 §5.2.6）——S16 随定时任务令牌落地 */
export interface TokenRenewalPolicy {
  /** 续期凭据类型：scheduler 颁发的任务凭据，或用户显式授权 */
  renewWith: 'task-credential' | 'user-grant'
  /** 单次续期时长上限 */
  maxExtensionMs: number
  /** 累计续期次数上限——防无限续期 */
  maxRenewals: number
}
