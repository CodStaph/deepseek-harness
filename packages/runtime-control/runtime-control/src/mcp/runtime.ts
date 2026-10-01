/**
 * 运行时管控层 · MCP 深度内建 · 通道唯一化（McpRuntime）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.8.1（第 1961–2003 行）/ §5.8.6（生命周期）
 * 阶段：S19（批次 4a，M4 MCP 深度内建）——把 MCP 连接的持有权从业务层收归运行时
 *       管控层：`McpRuntime` 是**唯一**持有 MCP 连接的组件，业务插件只能经
 *       `effect.mcp.call` 触达（配合 S13 隔离域模块白名单，standard/strict 档不给
 *       业务包 import packages/mcp 的权限）。"MCP 调用必然经过管控"从纪律变为结构——
 *       设计层面保证优先于实现层面兜底（R24）。
 *       批次 4b（S20 沙箱档位）+ 4c（OS 原生桥 P1–P3）：
 *       - `spawnServer` 经 `confineCommand` 沙箱挂载点包裹（最小 env 剥离凭证）+ 
 *         `osBridge.spawnManaged`（P2 进程树）真正拉起；
 *       - mcp-unknown 默认全禁（裁定 2026-10-01，仅显式 dry-run 放行）；
 *       - kill 走进程树终止（堵 setsid 逃逸子进程 / server 孤儿）。
 *
 * 语义要点：
 * - `registerServer`：server 进程注册（归属插件 + 沙箱档位 + spawn/传输方式）。
 * - `call`（实现 S17 的 McpClientAdapter）：工具调用唯一执行入口——未注册的 server
 *   一律拒绝（通道唯一化）；`--legacy-mcp` 旁路保留旧路径（方案 §8.2 迁移）。
 * - `handleInbound`：把 server → client 的反向请求委托给 `InboundRequestHandler`
 *   （三型效果化，5.8.3）。
 * - `attachProtocol`：**从零接线**（M0 上探，裁定 5A）——capabilities 声明 +
 *   setRequestHandler 三型回调。真实 dsh 由 packages/mcp SDK 实现该适配层。
 * - `killServersOf` / `dispose`：生命周期绑定（5.8.6）——isolate 联动 kill + 会话
 *   孤儿清理，堵 v3 残留洞。
 *
 * SEC 码位结论：本文件为纯机制/结构载体——不授予能力、不开辟信任通道，调用面判定
 * 由 McpEffectHandler（mcp.call）与 InboundRequestHandler（反向三型）承载，本组件
 * 仅做连接持有与生命周期登记。零码位新增，SEC-3xxx 段维持留白（§5.11.1 准入）。
 */

import type { McpCapability } from '@deepseek-ai/dsh-assembly'

import { confineCommand } from '../sandbox/confine.ts'
import { makeSandboxProfile } from '../sandbox/sandbox-profiles.ts'
import type { SandboxProfile, SandboxPlatform } from '../sandbox/sandbox-profiles.ts'
import { createMirrorOsBridge } from '../native/bridge.ts'
import type { OsBridge, ManagedProcess } from '../native/bridge.ts'

import type { EffectAuditEntry, EffectResult } from '../effect.ts'
import type { McpClientAdapter } from '../effects/mcp.ts'
import { SecurityViolation } from '../membrane.ts'
import type { SensitiveScanner } from '../effects/exfiltration.ts'
import type { ApprovalService } from '../effects/approval.ts'
import { InboundRequestHandler } from './inbound.ts'
import type {
  InboundRequest,
  InboundSourceLookup,
  LlmSampler,
} from './inbound.ts'

/** MCP server 沙箱档位（S20 的域级配置在批次 4b 落地；本批次仅登记档位标签） */
export type McpServerRealm = 'mcp-trusted' | 'mcp-signed' | 'mcp-unknown'

/** server 进程绑定——生命周期与归属插件绑定（方案 §5.8.1 McpServerBinding） */
export interface McpServerBinding {
  id: string
  /** 归属插件——isolate 时联动 kill（§5.8.6） */
  ownerPlugin: string
  /** 沙箱档位（§5.8.5） */
  realm: McpServerRealm
  /** spawn 参数：最小 env（剥离全部凭证）、限定 cwd */
  spawn: { command: string; args: string[]; env: string[]; cwd: string }
  /** 传输方式：stdio | streamable-http */
  transport: 'stdio' | 'streamable-http'
}

/** 连接生命周期状态 */
export type McpServerState = 'registered' | 'running' | 'stopped'

/** 被登记的 server 运行时状态 */
export interface ManagedServer {
  binding: McpServerBinding
  state: McpServerState
  /** P2 受控进程句柄（批次 4b/4c 落地后由 spawnServer 填入；未 spawn 则无） */
  process?: ManagedProcess
}

/** 生命周期审计事件（与效果审计分开——生命周期不是 Effect 类型，诚实分账） */
export interface McpServerLifecycleEvent {
  action: 'mcp-server-lifecycle'
  serverId: string
  ownerPlugin: string
  transition: 'register' | 'kill' | 'dispose'
  state: McpServerState
  timestamp: string
}

/** 真实 server 调用执行器（镜像注入 mock；并入 dsh 换 SDK transport/进程桥） */
export interface McpCallExecutor {
  call(req: { server: string; tool: string; args: unknown }): Promise<unknown>
}

/** 缺省进程内 mock 执行器——镜像阶段替代真实连接（echo 语义） */
export function defaultInProcessExecutor(): McpCallExecutor {
  return {
    call: async (req) => ({ ok: true, echo: { server: req.server, tool: req.tool, args: req.args } }),
  }
}

/** 协议适配层——真实 MCP SDK 从零接线的注入点（M0 上探，裁定 5A） */
export interface McpProtocolAdapter {
  /** 声明 client capabilities（setRequestHandler 前的协议协商声明） */
  declareCapabilities(caps: { sampling?: boolean; roots?: boolean; elicitation?: boolean }): void
  /** 注册 server → client 反向请求回调（对真实 SDK 的 setRequestHandler 三型） */
  onRequest(handler: (request: InboundRequest) => Promise<unknown>): void
}

/** 构造参数 */
export interface McpRuntimeOptions {
  /** 归属插件能力面解析（ownerPlugin → McpCapability；dsh 侧从 AssemblyPlan 取） */
  getCapability: (owner: string) => McpCapability | undefined
  /** 效果审计回调（反向请求与调用面的判定账，McpEffectHandler 与 inbound 共用） */
  audit: (entry: EffectAuditEntry) => void
  /** 审批服务（inbound elicitation 用） */
  approval?: ApprovalService
  /** 宿主 LLM 采样器（inbound sampling 用） */
  llm?: LlmSampler
  /** 沙箱暴露根区（inbound roots 推导基准） */
  workspaceRoots?: string[]
  /** sampling 结果回传数据上限（字节；缺省 inbound 内置缺省） */
  maxOutboundBytes?: number
  /** 敏感扫描器集（inbound prompt/结果用） */
  sensitiveScanners?: readonly SensitiveScanner[]
  /** lenient 模式：未声明能力降级放行（对应 --lenient-capabilities） */
  lenient?: boolean
  /** `--legacy-mcp` 旁路：保留业务包直连 packages/mcp 的旧路径（§8.2 迁移） */
  legacyMcp?: boolean
  /** OS 原语桥（P2 进程树生命周期；缺省镜像桥） */
  osBridge?: OsBridge
  /** 沙箱档位 profile 解析器（缺省按平台解析三档模板） */
  sandboxProfile?: (realm: McpServerRealm) => SandboxProfile
  /** 沙箱挂载 base env（供最小 env 剥离；缺省 process.env） */
  spawnEnv?: Record<string, string>
  /** 真实连接执行器（缺省 = 镜像进程内 mock） */
  executor?: McpCallExecutor
  /** 生命周期审计回调（spawn/kill/重启全记录，§5.8.6） */
  lifecycle?: (event: McpServerLifecycleEvent) => void
}

/**
 * MCP 运行时——唯一持有 MCP 连接的组件（§5.8.1）。
 * 业务插件只能经 `effect.mcp.call`（McpEffectHandler）触达，McpEffectHandler 的
 * client 即本组件（实现 McpClientAdapter.call）；反向请求经 attachProtocol 接线到
 * InboundRequestHandler。
 */
export class McpRuntime implements McpClientAdapter {
  private readonly servers = new Map<string, ManagedServer>()
  private readonly getCapability: (owner: string) => McpCapability | undefined
  private readonly legacyMcp: boolean
  private readonly executor: McpCallExecutor
  private readonly lifecycle?: (event: McpServerLifecycleEvent) => void
  private readonly inbound: InboundRequestHandler
  private readonly osBridge: OsBridge
  private readonly sandboxProfile: (realm: McpServerRealm) => SandboxProfile
  private readonly spawnEnv: Record<string, string>
  private disposed = false

  constructor(opts: McpRuntimeOptions) {
    this.getCapability = opts.getCapability
    this.legacyMcp = opts.legacyMcp ?? false
    this.executor = opts.executor ?? defaultInProcessExecutor()
    if (opts.lifecycle !== undefined) this.lifecycle = opts.lifecycle
    this.osBridge = opts.osBridge ?? createMirrorOsBridge()
    this.sandboxProfile = opts.sandboxProfile ?? ((realm) => makeSandboxProfile(toSandboxPlatform(process.platform), realm))
    this.spawnEnv = opts.spawnEnv ?? {}

    // 通道反向来源解析：serverId → 归属插件 + 能力面
    const lookup: InboundSourceLookup = (serverId) => {
      const managed = this.servers.get(serverId)
      if (!managed) return undefined
      const capability = this.getCapability(managed.binding.ownerPlugin)
      return {
        owner: managed.binding.ownerPlugin,
        ...(capability !== undefined ? { capability } : {}),
      }
    }
    this.inbound = new InboundRequestHandler({
      lookup,
      audit: opts.audit,
      ...(opts.approval !== undefined ? { approval: opts.approval } : {}),
      ...(opts.llm !== undefined ? { llm: opts.llm } : {}),
      ...(opts.workspaceRoots !== undefined ? { workspaceRoots: opts.workspaceRoots } : {}),
      ...(opts.maxOutboundBytes !== undefined ? { maxOutboundBytes: opts.maxOutboundBytes } : {}),
      ...(opts.sensitiveScanners !== undefined ? { sensitiveScanners: opts.sensitiveScanners } : {}),
      ...(opts.lenient !== undefined ? { lenient: opts.lenient } : {}),
    })
  }

  /* ─────────────────── 通道唯一化（R21/§5.8.1）─────────────────── */

  /** server 进程注册——登记为通道内合法连接（生命周期登记 + 能力汇总） */
  registerServer(binding: McpServerBinding): void {
    if (this.disposed) {
      throw new SecurityViolation(
        'McpRuntime 已 dispose，不能注册 server',
        { action: 'call-blocked', property: binding.id, reason: 'runtime-disposed' },
      )
    }
    this.servers.set(binding.id, { binding, state: 'registered' })
    this.emitLifecycle('register', binding.id, binding.ownerPlugin, 'registered')
  }

  /** 查询已登记 server（只读；未登记返回 undefined） */
  getServer(serverId: string): ManagedServer | undefined {
    return this.servers.get(serverId)
  }

  /** 标记 server 进入 running 状态（dsh 侧 spawn 成功后调用；镜像登记状态机） */
  markRunning(serverId: string): void {
    const m = this.servers.get(serverId)
    if (m) m.state = 'running'
  }

  /**
   * 工具调用唯一执行入口（实现 S17 McpClientAdapter）。
   * 通道唯一化：未登记的 server 一律拒绝（legacyMcp 旁路除外）。
   */
  async call(req: { server: string; tool: string; args: unknown }): Promise<unknown> {
    if (this.disposed) {
      throw new SecurityViolation(
        'McpRuntime 已 dispose，MCP 调用被拒',
        { action: 'call-blocked', property: req.server, reason: 'runtime-disposed' },
      )
    }
    const managed = this.servers.get(req.server)
    if (!managed) {
      if (this.legacyMcp) return this.executor.call(req) // --legacy-mcp 旁路
      throw new SecurityViolation(
        `MCP server 未登记连接（通道唯一化）：${req.server}`,
        { action: 'call-blocked', property: req.server, reason: 'mcp-unregistered' },
      )
    }
    if (managed.state === 'stopped') {
      throw new SecurityViolation(
        `MCP server 已停止：${req.server}`,
        { action: 'call-blocked', property: req.server, reason: 'mcp-stopped' },
      )
    }
    return this.executor.call(req)
  }

  /** 效果调用入口（业务层经 effect.mcp.call 到达此处的薄转发，§5.8.1） */
  async callTool(_caller: string, server: string, tool: string, args: unknown): Promise<unknown> {
    return this.call({ server, tool, args })
  }

  /* ─────────────────── 反向请求（§5.8.3）─────────────────── */

  /** server→client 反向请求处理（三型效果化，委托 InboundRequestHandler） */
  async handleInbound(request: InboundRequest): Promise<EffectResult> {
    return this.inbound.handle(request)
  }

  /* ─────────────────── 生命周期（§5.8.6）─────────────────── */

  /**
   * 批次 4b/4c（S20 + P2）：把已登记 server 拉起为受控进程。
   * - 经 `confineCommand` 沙箱挂载点包裹 argv（最小 env 剥离凭证）
   * - 经 `osBridge.spawnManaged` 建立进程树句柄（P2：Job Object / PDEATHSIG）
   * - mcp-unknown 默认全拒（裁定：仅显式 dry-run 放行）
   */
  async spawnServer(serverId: string): Promise<ManagedProcess> {
    const managed = this.servers.get(serverId)
    if (!managed) {
      throw new SecurityViolation(
        `MCP server 未登记：${serverId}`,
        { action: 'call-blocked', property: serverId, reason: 'mcp-unregistered' },
      )
    }
    const b = managed.binding
    const profile = this.sandboxProfile(b.realm)
    const confined = confineCommand(
      { command: b.spawn.command, args: b.spawn.args, cwd: b.spawn.cwd },
      profile,
      this.spawnEnv,
    )
    if (!confined.confined) {
      throw new SecurityViolation(
        `沙箱档位 ${b.realm} 禁止 spawn（默认全禁），拒绝拉起：${serverId}`,
        { action: 'call-blocked', property: serverId, reason: 'mcp-unknown-denied' },
      )
    }
    const argv0 = confined.argv[0]
    if (argv0 === undefined) {
      throw new SecurityViolation(
        `沙箱 confine 未产出命令 argv[0]，拒绝拉起：${serverId}`,
        { action: 'call-blocked', property: serverId, reason: 'confine-no-argv' },
      )
    }
    const proc = await this.osBridge.spawnManaged({
      command: argv0,
      args: confined.argv.slice(1),
      cwd: confined.cwd,
      env: confined.env,
      realm: b.realm,
    })
    managed.process = proc
    managed.state = 'running'
    return proc
  }

  /** 隔离联动：kill 归属插件的全部 server 进程（堵"插件隔离了 server 还在后台跑"洞） */
  killServersOf(ownerPlugin: string): void {
    for (const [serverId, managed] of this.servers) {
      if (managed.binding.ownerPlugin === ownerPlugin && managed.state !== 'stopped') {
        // P2：进程树终止（setsid 逃逸子进程也击杀）
        if (managed.process) void managed.process.kill()
        managed.state = 'stopped'
        this.emitLifecycle('kill', serverId, ownerPlugin, 'stopped')
      }
    }
  }

  /** 会话收尾：孤儿 server 清理 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [serverId, managed] of this.servers) {
      if (managed.state !== 'stopped') {
        if (managed.process) void managed.process.kill()
        managed.state = 'stopped'
        this.emitLifecycle('dispose', serverId, managed.binding.ownerPlugin, 'stopped')
      }
    }
    this.servers.clear()
  }

  /* ─────────────────── 从 0 接线（M0 上探，裁定 5A）─────────────────── */

  /**
   * 协议适配层接线——capabilities 声明 + server_request 回调注册（真实 SDK 注入点）。
   * 能力声明为协议协商级（任一台已登记 server 声明即宣告支持）；逐台判定仍由
   * InboundRequestHandler 按归属契约逐环执行，声明不弱化判定。
   */
  attachProtocol(adapter: McpProtocolAdapter): void {
    const cap: { sampling?: boolean; roots?: boolean; elicitation?: boolean } = {}
    for (const managed of this.servers.values()) {
      const m = this.getCapability(managed.binding.ownerPlugin)
      if (m?.sampling) cap.sampling = true
      if (m?.roots) cap.roots = true
      if (m?.elicitation) cap.elicitation = true
    }
    adapter.declareCapabilities(cap)
    // 三型统一回调——真实 SDK 的 setRequestHandler 各型均落到这一入口
    adapter.onRequest((request: InboundRequest): Promise<unknown> => this.handleInbound(request))
  }

  private emitLifecycle(
    transition: McpServerLifecycleEvent['transition'],
    serverId: string,
    ownerPlugin: string,
    state: McpServerState,
  ): void {
    if (!this.lifecycle) return
    this.lifecycle({
      action: 'mcp-server-lifecycle',
      serverId,
      ownerPlugin,
      transition,
      state,
      timestamp: new Date().toISOString(),
    })
  }
}

/** NodeJS.Platform → 沙箱平台（未知平台安全兜底 windows） */
function toSandboxPlatform(p: NodeJS.Platform): SandboxPlatform {
  if (p === 'linux') return 'linux'
  if (p === 'darwin') return 'macos'
  return 'windows'
}