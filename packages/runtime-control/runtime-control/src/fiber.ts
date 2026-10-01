/**
 * 运行时管控层 · 机制 2：fiber 粒度令牌登记（FiberTokenRegistry）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.2.5（第 1144–1170 行）
 * 阶段：S18（批次 3b，M3 智能体运行语义）——把派生令牌的撤销链落实到结构。
 *
 * 语义要点（方案 §5.2.5）：
 * - 装载期预颁发的令牌是**插件级**；运行期 fiber（subagent spawn/fork、会话）创建时
 *   从插件级令牌派生 fiber 级令牌（deriveFiberToken，见 capability.ts）。
 * - 撤销链沿 `pluginId → fiberId` 精确传播：revokePlugin 撤销该插件全部派生令牌，
 *   revokeFiber(pluginId, fiberId) 只撤单个子代理，兄弟 fiber 不受影响（验收 R22）。
 * - 单个子代理违规时配合 isolate 档可精确摘除，不影响并行兄弟（§5.5/§5.7）。
 * - 本登记册是结构载体：fiber 令牌创建时 register，销毁/撤销时 revoke；登记与撤销
 *   均为同步操作，幂等。
 *
 * SEC 码位结论：纯登记/结构载体（不授予能力、不开辟信任通道），令牌有效性判定仍由
 * CapabilityToken 自身（revoked/expiresAt）承担；不新增 SEC 码位，SEC-3xxx 维持留白。
 */

import type { CapabilityToken } from './capability.ts'

/**
 * fiber 粒度令牌登记册——记录每个 (pluginId, fiberId) 派生的令牌，支持按插件全撤
 * 或按单个 fiber 精确撤销（方案 §5.2.5 撤销链）。
 */
export class FiberTokenRegistry {
  private readonly groups = new Map<string, CapabilityToken<object>[]>()

  /** 分组键：`pluginId#fiberId` */
  private key(pluginId: string, fiberId: string): string {
    return `${pluginId}#${fiberId}`
  }

  /** 登记一个派生令牌（fiber 创建时调用） */
  register(pluginId: string, fiberId: string, token: CapabilityToken<object>): void {
    const k = this.key(pluginId, fiberId)
    const list = this.groups.get(k) ?? []
    list.push(token)
    this.groups.set(k, list)
  }

  /**
   * 撤销单个 fiber 的全部令牌（revokeFiber）——兄弟 fiber 不受影响（R22）。
   * @returns 被撤销的令牌数
   */
  revokeFiber(pluginId: string, fiberId: string): number {
    const k = this.key(pluginId, fiberId)
    const list = this.groups.get(k) ?? []
    for (const t of list) t.revoke()
    this.groups.delete(k)
    return list.length
  }

  /**
   * 撤销某插件全部 fiber 派生令牌（revokePlugin）——配合 isolate 档整体摘除。
   * @returns 被撤销的令牌总数
   */
  revokePlugin(pluginId: string): number {
    let count = 0
    for (const [k, list] of this.groups) {
      if (k.startsWith(`${pluginId}#`)) {
        for (const t of list) t.revoke()
        count += list.length
        this.groups.delete(k)
      }
    }
    return count
  }

  /** 某 fiber 当前登记的令牌数（诊断/测试用） */
  fiberTokenCount(pluginId: string, fiberId: string): number {
    return (this.groups.get(this.key(pluginId, fiberId)) ?? []).length
  }
}