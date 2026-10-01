/**
 * 运行时管控层 · 机制 3：效果 API 暴露（EffectApi）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.3.4
 * 阶段：S12（效果系统，批次 2b）——业务代码不直接调 node:fs/node:net，而是经
 *       注入的 effect 对象，所有调用经处理器逐点检查后执行。
 *
 * 语义要点（方案 §5.3.4）：
 * - fs.write 支持 artifact:'intermediate'（免审批、约束到临时区）；缺省按 final 走完整审批。
 * - mcp.call 随 S17 接线：经注入的 McpEffectHandler 纳入效果系统（server/tool 白名单、
 *   参数外发检查、审批），dispatch 统一处理，缺处理器仍抛 SecurityViolation。
 * - 被拒效果统一抛 SecurityViolation，携带由 EffectAuditEntry 转换的兼容审计字段。
 */

import { SecurityViolation } from '../membrane.ts'
import type { MembraneAuditEntry } from '../membrane.ts'
import type { EffectHandler, EffectRequest, EffectType } from '../effect.ts'

/** 暴露给业务代码的效果 API（所有调用都经处理器） */
export interface EffectApi {
  fs: {
    read(path: string): Promise<Buffer>
    /** artifact:'（intermediate' 免审批、约束到临时区；缺省 'final' 走完整审批 */
    write(path: string, data: Buffer | string, opts?: { artifact?: 'intermediate' | 'final' }): Promise<void>
    /** 回收站式删除（默认删除语义，低门槛） */
    trash(path: string): Promise<void>
    /** 永久删除（须契约单独声明 permanentDelete 能力 + 审批，S16） */
    deletePermanent(path: string): Promise<void>
    stat(path: string): Promise<unknown>
  }
  net: {
    fetch(url: string, init?: unknown): Promise<unknown>
    connect(host: string, port: number): Promise<unknown>
  }
  proc: {
    spawn(cmd: string, args: string[]): Promise<unknown>
    exec(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>
  }
  env: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string): Promise<void>
  }
  mcp: {
    /** MCP 工具调用（S17 接线），本阶段抛 SecurityViolation 占位 */
    call(server: string, tool: string, args: unknown): Promise<never>
  }
}

/**
 * 为插件创建效果 API——所有调用都经过处理器 dispatch。
 * @param handlers 效果类型 → 处理器映射
 * @param callerId 发起效果的插件 id（含 fiber 后缀）
 * @param tokenId  发起效果时持有的能力令牌 id
 */
export function createEffectApi(
  handlers: Map<EffectType, EffectHandler>,
  callerId: string,
  tokenId: string,
): EffectApi {
  const dispatch = async (type: EffectType, target: string, args?: unknown[]) => {
    const handler = handlers.get(type)
    if (!handler) {
      const entry: MembraneAuditEntry = {
        action: 'call-blocked', property: type, reason: 'no-handler',
      }
      throw new SecurityViolation(`无效果处理器：${type}`, entry)
    }
    const req: EffectRequest = { type, target, caller: callerId, capabilityTokenId: tokenId, ...(args !== undefined ? { args } : {}) }
    const result = await handler.handle(req)
    if (!result.ok) {
      // 被拒 → 抛 SecurityViolation，以 MembraneAuditEntry 承载审计兼容字段
      throw new SecurityViolation(`效果被拒：${result.error}`, {
        action: 'call-blocked',
        property: type,
        reason: result.error ?? 'denied',
        attemptedValue: target,
      })
    }
    return result.data
  }

  return {
    fs: {
      read: (path) => dispatch('fs.read', path) as Promise<Buffer>,
      write: (path, data, opts) => dispatch('fs.write', path, [data, opts]) as Promise<void>,
      trash: (path) => dispatch('fs.trash', path) as Promise<void>,
      deletePermanent: (path) => dispatch('fs.delete-permanent', path) as Promise<void>,
      stat: (path) => dispatch('fs.stat', path),
    },
    net: {
      fetch: (url, init) => dispatch('net.fetch', url, [init]),
      connect: (host, port) => dispatch('net.connect', `${host}:${port}`, [port]),
    },
    proc: {
      spawn: (cmd, args) => dispatch('proc.spawn', cmd, args),
      exec: (cmd) => dispatch('proc.exec', cmd) as Promise<{ stdout: string; stderr: string; code: number }>,
    },
    env: {
      get: (key) => dispatch('env.get', key) as Promise<string | undefined>,
      set: (key, value) => dispatch('env.set', key, [value]) as Promise<void>,
    },
    mcp: {
      /** MCP 工具调用（S17 接线）——经 McpEffectHandler 纳入效果系统（白名单/外发/审批） */
      call: (server, tool, args) => dispatch('mcp.call', `${server}.${tool}`, [args]) as Promise<never>,
    },
  }
}