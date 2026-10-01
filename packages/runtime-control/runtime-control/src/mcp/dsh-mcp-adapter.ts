/**
 * 运行时管控层 · MCP 深度内建 · dsh 真实接线适配层（DshMcpClientAdapter）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.8.1（连接持有权收归管控层）/
 *       §5.8.3（反向请求三型效果化）
 * 阶段：S19（批次 1-4 · 运行时线真实接线）——把 McpRuntime 的 executor 注入点从镜像
 *       mock（defaultInProcessExecutor 的 echo 语义）换成真实 `@modelcontextprotocol/client`
 *       （2.0.0）连接：每台 server 一条 SDK Client + Transport，同时实现 McpCallExecutor
 *       与 McpProtocolAdapter（capabilities 声明 + 反向请求三型回调）。dsh-mcp-client 插件
 *       保持不动（业务侧独立通道）；本层只服务 McpRuntime 的通道唯一化结构。
 *
 * SDK 2.0.0 协议时序事实（源码核实，非猜测）：
 * - `Client.registerCapabilities` 只能在 connect 前调用（connect 后抛错）；capabilities 在
 *   initialize 握手中对 server 声明，握手完成后不可追加——已连接 server 需重连才生效。
 * - `Client.setRequestHandler` 对三型方法先做 capability 断言（未声明对应能力即抛
 *   CapabilityNotSupported），因此 onRequest 的注册以 declareCapabilities 先行为前提；
 *   未声明能力的型不注册（server 侧按握手声明不会发来该型请求）。
 * - 入站 sampling/elicitation 的请求与结果由 SDK 按 era schema 强制验证——适配层对
 *   handler 返回值做最小透传（不发明字段、不伪造成功）；形状不合法时由 SDK 以
 *   JSON-RPC error 回拒 server（诚实失败路径）。
 *
 * 请求/结果转换（最小忠实，不发明字段）：
 * - sampling：params.messages 中 role=user 的 text 内容按序拼接为 prompt；
 *   modelPreferences.hints[0].name → model；maxTokens 原样。其余协议字段
 *   （systemPrompt/includeContext/temperature/tools/toolChoice/stopSequences）不透传——
 *   runtime-control 的 SamplingRequest 是封闭契约，扩展须经 InboundRequestHandler 侧演进。
 * - elicitation：params.message → prompt（requestedSchema/mode 不透传，同上）。
 * - roots：InboundRequest 的 roots 型即 { type, from }，无 payload。
 * - call：req.args 为 undefined 时不带 arguments（协议本就可选）；其余形状原样交给
 *   SDK（非对象形状由协议层 schema 校验拒绝，不在适配层兜底改写）。
 *
 * SEC 码位结论：本文件为纯接线/通道载体——不授予能力、不开辟信任通道、不做任何判定；
 * 调用面判定在 McpEffectHandler（mcp.call），反向三型判定在 InboundRequestHandler。
 * 通道完整性断言（未登记/未连接/重名登记/dispose 后调用 → SecurityViolation）与
 * McpRuntime 的既有拒绝码位同源同码，不扩大判定面。零码位新增，SEC-3xxx 段维持留白
 * （§5.11.1 准入）。
 */

import type {
  CallToolRequest,
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
  ElicitResult,
  ListRootsResult,
  Transport,
} from '@modelcontextprotocol/client'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

import type { InboundRequest } from './inbound.ts'
import type { McpCallExecutor, McpProtocolAdapter } from './runtime.ts'
import { SecurityViolation } from '../membrane.ts'

/**
 * stdio server 连接配置——对齐 dsh-mcp-client `StdioConfig` 的连接所需字段
 * （serverName/command/args/env/cwd；超时与重连策略属插件层，不在此重复）。
 */
export interface DshMcpStdioServerConfig {
  /** server 登记名（McpRuntime.registerServer 的 binding.id / InboundRequest.from） */
  serverName: string
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

/**
 * Streamable HTTP server 连接配置——对齐 dsh-mcp-client `StreamableHttpConfig`
 * 的连接所需字段（serverName/url/headers）。
 */
export interface DshMcpStreamableHttpServerConfig {
  /** server 登记名（同上） */
  serverName: string
  transport: 'streamable-http'
  url: string
  headers?: Record<string, string>
}

/** 一台 server 的连接配置（判别联合，按 transport 分派） */
export type DshMcpServerConfig = DshMcpStdioServerConfig | DshMcpStreamableHttpServerConfig

/** 缺省 client 身份（对齐包版本；dsh-runtime-control 管控层语义） */
export const DSH_RUNTIME_CONTROL_CLIENT_INFO = { name: 'dsh-runtime-control', version: '0.2.0-rc.2' } as const

/** 构造参数 */
export interface DshMcpClientAdapterOptions {
  /** 本适配层持有的 server 清单（与 McpRuntime 登记表一一对应） */
  servers: readonly DshMcpServerConfig[]
  /**
   * Transport 工厂注入点——测试注入内存 mock；缺省按 transport 类型建
   * StdioClientTransport / StreamableHTTPClientTransport。
   */
  createTransport?: (cfg: DshMcpServerConfig) => Transport
  /** clientInfo 覆盖（缺省 dsh-runtime-control） */
  clientInfo?: { name: string; version: string }
}

/** 单台 server 的连接登记（client 与 transport 一一绑定，SDK Protocol 生命周期同构） */
interface ManagedClient {
  cfg: DshMcpServerConfig
  client: Client
  transport?: Transport
  connected: boolean
}

/** 缺省 Transport 工厂——按 transport 类型分派 SDK 传输实现（对齐 mcp-client/transport.ts 用法） */
function defaultCreateTransport(cfg: DshMcpServerConfig): Transport {
  switch (cfg.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: cfg.command,
        ...(cfg.args !== undefined ? { args: cfg.args } : {}),
        ...(cfg.env !== undefined ? { env: cfg.env } : {}),
        ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
      })
    case 'streamable-http':
      return new StreamableHTTPClientTransport(
        new URL(cfg.url),
        ...(cfg.headers !== undefined ? [{ requestInit: { headers: cfg.headers } }] : []),
      )
  }
}

/** runtime-control 三型声明 → SDK ClientCapabilities（空对象 = 声明该型，不带附加选项） */
function toSdkCapabilities(caps: { sampling?: boolean; roots?: boolean; elicitation?: boolean }): ClientCapabilities {
  return {
    ...(caps.sampling === true ? { sampling: {} } : {}),
    ...(caps.roots === true ? { roots: {} } : {}),
    // form 是 2025-era elicitation 的缺省模式；显式声明（不依赖 SDK 的空对象 preprocess）
    ...(caps.elicitation === true ? { elicitation: { form: {} } } : {}),
  }
}

/**
 * SDK sampling 请求 → InboundRequest（最小忠实转换，见文件头"请求/结果转换"）。
 * messages 中 role=user 的 text 内容按序拼接为 prompt；无 user 文本时 prompt 为空串
 * （敏感核对与 LLM 采样在 InboundRequestHandler 侧按既有契约处理）。
 */
function toSamplingInbound(from: string, request: CreateMessageRequest): InboundRequest {
  const params = request.params
  const userTexts: string[] = []
  for (const message of params.messages) {
    if (message.role !== 'user') continue
    // content 为"单块 | 块数组"联合（SDK SamplingMessageSchema）——两种形态都取 text 块
    const blocks = Array.isArray(message.content) ? message.content : [message.content]
    for (const block of blocks) {
      if (block.type === 'text') userTexts.push(block.text)
    }
  }
  const model = params.modelPreferences?.hints?.[0]?.name
  return {
    type: 'sampling',
    from,
    request: {
      prompt: userTexts.join('\n'),
      ...(model !== undefined ? { model } : {}),
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
    },
  }
}

/** SDK elicitation 请求 → InboundRequest（params.message → prompt，union 两型公共字段） */
function toElicitationInbound(from: string, request: ElicitRequest): InboundRequest {
  return { type: 'elicitation', from, request: { prompt: request.params.message } }
}

/**
 * dsh 真实接线适配层——每台 server 一条 SDK Client + Transport。
 *
 * 同时实现两个注入面：
 * - `McpCallExecutor`：注入 McpRuntimeOptions.executor（真实连接执行器）；
 * - `McpProtocolAdapter`：注入 McpRuntime.attachProtocol（capabilities + 三型反向请求）。
 *
 * 典型接线顺序（与 McpRuntime.attachProtocol 的调用序一致）：
 * `new DshMcpClientAdapter(...)` → `declareCapabilities(...)` → `onRequest(...)` → `await connect()`。
 */
export class DshMcpClientAdapter implements McpCallExecutor, McpProtocolAdapter {
  private readonly entries = new Map<string, ManagedClient>()
  private readonly createTransport: (cfg: DshMcpServerConfig) => Transport
  private readonly clientInfo: { name: string; version: string }
  private declared: { sampling?: boolean; roots?: boolean; elicitation?: boolean } = {}
  private inbound?: (request: InboundRequest) => Promise<unknown>
  private disposed = false

  constructor(opts: DshMcpClientAdapterOptions) {
    this.createTransport = opts.createTransport ?? defaultCreateTransport
    this.clientInfo = opts.clientInfo ?? DSH_RUNTIME_CONTROL_CLIENT_INFO
    for (const cfg of opts.servers) {
      if (this.entries.has(cfg.serverName)) {
        throw new SecurityViolation(
          `MCP server 重名登记被拒（serverName → client 映射唯一性）：${cfg.serverName}`,
          { action: 'define-denied', property: cfg.serverName, reason: 'mcp-duplicate-server' },
        )
      }
      // capabilities 从空开始——declareCapabilities 在 connect 前经 registerCapabilities 补声明
      const client = new Client(
        { name: this.clientInfo.name, version: this.clientInfo.version },
        { capabilities: {} },
      )
      this.entries.set(cfg.serverName, { cfg, client, connected: false })
    }
  }

  /**
   * 为每台 server 经 createTransport 工厂建 Transport 并完成 MCP 握手（initialize 请求 →
   * 响应 → notifications/initialized）。capabilities 声明须在 connect 前完成（协议时序）。
   */
  async connect(): Promise<void> {
    if (this.disposed) {
      throw new SecurityViolation(
        'DshMcpClientAdapter 已 dispose，不能建立连接',
        { action: 'call-blocked', property: 'dsh-mcp-adapter', reason: 'adapter-disposed' },
      )
    }
    for (const entry of this.entries.values()) {
      if (entry.connected) continue
      const transport = this.createTransport(entry.cfg)
      await entry.client.connect(transport)
      entry.transport = transport
      entry.connected = true
    }
  }

  /**
   * McpCallExecutor.call——工具调用唯一执行入口（判定面在 McpEffectHandler，本层仅通道）。
   * 未登记 / 未连接一律 SecurityViolation（与 McpRuntime 的通道唯一化码位同源）。
   */
  async call(req: { server: string; tool: string; args: unknown }): Promise<unknown> {
    if (this.disposed) {
      throw new SecurityViolation(
        'DshMcpClientAdapter 已 dispose，MCP 调用被拒',
        { action: 'call-blocked', property: req.server, reason: 'adapter-disposed' },
      )
    }
    const entry = this.entries.get(req.server)
    if (entry === undefined) {
      throw new SecurityViolation(
        `MCP server 未登记连接（通道唯一化）：${req.server}`,
        { action: 'call-blocked', property: req.server, reason: 'mcp-unregistered' },
      )
    }
    if (!entry.connected) {
      throw new SecurityViolation(
        `MCP server 尚未建立连接：${req.server}`,
        { action: 'call-blocked', property: req.server, reason: 'mcp-not-connected' },
      )
    }
    // args 原样透传（非对象形状由 SDK 协议层 schema 校验拒绝——不在适配层兜底改写）
    const params: CallToolRequest['params'] = {
      name: req.tool,
      ...(req.args !== undefined ? { arguments: req.args as Record<string, unknown> } : {}),
    }
    // 结果按 SDK 原样返回（CallToolResult：content/isError 等字段不改写）
    return entry.client.callTool(params)
  }

  /**
   * McpProtocolAdapter.declareCapabilities——声明 client capabilities（协议协商级）。
   *
   * 协议时序约束（SDK 2.0.0 硬约束）：capabilities 在 initialize 握手时对 server 声明，
   * `Client.registerCapabilities` 对已连接 client 直接抛错。本方法对**未连接**的 client
   * 逐台注册；已连接 server 在其当前连接上的声明不可追加（需重连生效）——缓存的声明
   * 保证后续任何新连接继承。声明不弱化判定：逐台反向请求的判定仍由 InboundRequestHandler
   * 按归属契约执行。合并语义为 append-only（与 SDK mergeCapabilities 一致，不撤销已声明型）。
   */
  declareCapabilities(caps: { sampling?: boolean; roots?: boolean; elicitation?: boolean }): void {
    this.declared = {
      ...this.declared,
      ...(caps.sampling === true ? { sampling: true } : {}),
      ...(caps.roots === true ? { roots: true } : {}),
      ...(caps.elicitation === true ? { elicitation: true } : {}),
    }
    const sdkCaps = toSdkCapabilities(this.declared)
    for (const entry of this.entries.values()) {
      if (entry.connected) continue // 已连接：registerCapabilities 会抛错，协议上不可追加（见 JSDoc）
      entry.client.registerCapabilities(sdkCaps)
    }
    this.wireInboundHandlers()
  }

  /**
   * McpProtocolAdapter.onRequest——注册 server → client 反向请求回调（三型效果化入口）。
   * SDK 侧 `setRequestHandler` 按已声明能力注册对应型（未声明型不注册：capability 断言
   * 硬约束 + server 按握手声明不会发来未声明型）。handler 收到 runtime-control 的
   * InboundRequest，返回值经最小透传交回 SDK（结果验证由 SDK era schema 承担）。
   * 可重复调用（覆盖既有回调）；也可在 declareCapabilities 之前调用（缓存后由声明触达补注册）。
   */
  onRequest(handler: (request: InboundRequest) => Promise<unknown>): void {
    this.inbound = handler
    this.wireInboundHandlers()
  }

  /**
   * 关闭全部 client/transport（SDK `Client.close()` 内部关闭 transport 并触发 onclose）。
   * 幂等；dispose 后任何通道操作均 SecurityViolation（会话收尾，§5.8.6）。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) {
      await entry.client.close()
      entry.connected = false
    }
  }

  /** 按当前已声明能力 + 已缓存 handler，对每台 client 接线三型反向请求（幂等覆盖注册） */
  private wireInboundHandlers(): void {
    const handler = this.inbound
    if (handler === undefined) return
    for (const entry of this.entries.values()) {
      const from = entry.cfg.serverName
      if (this.declared.sampling === true) {
        entry.client.setRequestHandler('sampling/createMessage', async (request) => {
          const result = await handler(toSamplingInbound(from, request))
          return result as CreateMessageResult
        })
      }
      if (this.declared.roots === true) {
        entry.client.setRequestHandler('roots/list', async () => {
          const result = await handler({ type: 'roots', from })
          return result as ListRootsResult
        })
      }
      if (this.declared.elicitation === true) {
        entry.client.setRequestHandler('elicitation/create', async (request) => {
          const result = await handler(toElicitationInbound(from, request))
          return result as ElicitResult
        })
      }
    }
  }
}
