/**
 * S19 · 批次 1-4 真实接线测试：DshMcpClientAdapter（runtime-control ↔ SDK Client 适配层）
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.8.1 / §5.8.3。
 * 覆盖（任务批次 1-4 验收面）：
 * - call 转发：mock transport 捕获 client 发出的 tools/call JSON-RPC → adapter.call 返回预置结果
 * - 未登记 server 拒绝（SecurityViolation，通道唯一化）
 * - declareCapabilities → registerCapabilities → initialize 握手 wire 级 capabilities 断言
 * - onRequest 三型接线（sampling / roots / elicitation 入站 → handler 收到 InboundRequest，
 *   返回值经 SDK 透传回 mock）
 * - dispose 关闭全部连接（多台 server）
 * 测试限制诚实登记：
 * - mock transport 完整实现 SDK `Transport` 契约（start/send/close + onclose/onerror/onmessage
 *   回调挂载），initialize 握手按 SDK 真实时序完成（initialize 请求 → 最小响应 serverInfo +
 *   capabilities: {} → notifications/initialized 通知）——因此 call / capabilities / onRequest
 *   三组断言都是真实 SDK Client 走完整握手后的行为，不是半程 mock。
 * - 未验证项：StdioClientTransport / StreamableHTTPClientTransport 的真实建连（不拉起子进程、
 *   不发网络请求——缺省工厂仅做构造参数对齐；本套件经 createTransport 注入点全部走内存 mock）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client'

import { DshMcpClientAdapter } from '../src/mcp/dsh-mcp-adapter.ts'
import type { DshMcpServerConfig } from '../src/mcp/dsh-mcp-adapter.ts'
import { SecurityViolation } from '../src/membrane.ts'
import type { InboundRequest } from '../src/mcp/inbound.ts'

/**
 * 宽形状的 JSON-RPC 消息视图——mock 侧只做方法分派与捕获，不做协议校验
 * （协议校验属 SDK 职责，mock 重复实现反而会与 SDK 假设漂移）。
 */
interface RpcLike {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

/**
 * 最小内存 mock Transport——实现 SDK `Transport` 契约：
 * - send：捕获全部出站消息；对 initialize 请求回最小握手响应，对 tools/call 回预置结果
 *   （经 onmessage 异步回注，模拟真实网络往返时序）；
 * - deliver：测试侧注入入站消息（模拟 server → client 反向请求）；
 * - close：置位并触发 onclose（SDK Client.close 的协议收尾依赖该信号）。
 */
class MockTransport implements Transport {
  /** client → mock 的全部出站消息（initialize 请求 / 通知 / tools/call / 反向请求的响应） */
  readonly outbound: RpcLike[] = []
  /** 预置 tools/call 响应 result（call 转发用例） */
  toolCallResult: Record<string, unknown> = { content: [{ type: 'text', text: 'mock-tool-result' }] }
  closed = false
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  async start(): Promise<void> {
    /* 无连接准备——内存通道无操作 */
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const m = message as RpcLike
    this.outbound.push(m)
    if (m.method === 'initialize' && m.id !== undefined) {
      const params = (m.params ?? {}) as { protocolVersion: string }
      // 最小握手响应：回显请求的协议版本（SDK 检查响应版本在其支持列表内）
      this.replyLater(m.id, {
        protocolVersion: params.protocolVersion,
        capabilities: {},
        serverInfo: { name: 'mock-server', version: '1.0.0' },
      })
      return
    }
    if (m.method === 'tools/call' && m.id !== undefined) {
      this.replyLater(m.id, this.toolCallResult)
      return
    }
    // notifications/initialized 等通知与 client 对入站请求的响应：仅捕获
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }

  /** 模拟 server → client 的入站消息（反向请求注入） */
  deliver(message: RpcLike): void {
    this.onmessage?.(message as JSONRPCMessage)
  }

  /** 异步回注响应（微任务 flush，模拟真实网络往返） */
  private replyLater(id: number | string, result: unknown): void {
    const response = { jsonrpc: '2.0' as const, id, result }
    queueMicrotask(() => { this.onmessage?.(response as JSONRPCMessage) })
  }
}

/** 适配层构造 helper：全部 server 经注入的 createTransport 建内存 mock（不真实拉起进程） */
function makeAdapter(transports: Map<string, MockTransport>, serverNames: string[] = ['srv-echo']): DshMcpClientAdapter {
  const servers: DshMcpServerConfig[] = serverNames.map((serverName) => ({
    serverName,
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
  }))
  return new DshMcpClientAdapter({
    servers,
    createTransport: (cfg) => {
      const t = new MockTransport()
      transports.set(cfg.serverName, t)
      return t
    },
  })
}

/** 等待 SDK 的微任务响应链 flush（入站请求处理是异步 then 链） */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** 三型反向请求接线 helper：声明三能力 + 按型返回预置结果（透传断言用） */
async function setupInbound(): Promise<{ t: MockTransport; received: InboundRequest[] }> {
  const transports = new Map<string, MockTransport>()
  const adapter = makeAdapter(transports)
  // 接线顺序与 McpRuntime.attachProtocol 一致：先 declareCapabilities 再 onRequest
  adapter.declareCapabilities({ sampling: true, roots: true, elicitation: true })
  const received: InboundRequest[] = []
  adapter.onRequest(async (request: InboundRequest): Promise<unknown> => {
    received.push(request)
    if (request.type === 'sampling') {
      return { role: 'assistant', model: 'mock-llm', stopReason: 'endTurn', content: { type: 'text', text: '采样结果' } }
    }
    if (request.type === 'roots') {
      return { roots: [{ uri: 'file:///ws/root', name: 'root' }] }
    }
    return { action: 'decline' } // elicitation
  })
  await adapter.connect()
  const t = transports.get('srv-echo')
  assert.ok(t, 'mock transport 应已建立')
  return { t, received }
}

/* ─────────────── call 转发（真实 SDK 握手后） ─────────────── */

test('D1 call 转发：捕获 tools/call JSON-RPC，返回预置结果（按 SDK 原样）', async () => {
  const transports = new Map<string, MockTransport>()
  const adapter = makeAdapter(transports)
  await adapter.connect()
  const t = transports.get('srv-echo')
  assert.ok(t)

  const result = await adapter.call({ server: 'srv-echo', tool: 'echo', args: { q: 1 } })

  // 返回结果 = mock 预置的 CallToolResult（SDK 原样，适配层不改写）
  assert.deepEqual(result, { content: [{ type: 'text', text: 'mock-tool-result' }] })

  // client 发出的 tools/call 请求参数（JSON-RPC 级转发断言）
  const callMsg = t.outbound.find((m) => m.method === 'tools/call')
  assert.ok(callMsg, '应捕获到 tools/call 请求')
  const params = (callMsg?.params ?? {}) as { name?: string; arguments?: unknown }
  assert.equal(params.name, 'echo')
  assert.deepEqual(params.arguments, { q: 1 })
})

/* ─────────────── 通道唯一化（未登记拒绝） ─────────────── */

test('D2 未登记 server 调用被拒（SecurityViolation，通道唯一化）', async () => {
  const adapter = makeAdapter(new Map())
  await adapter.connect()
  await assert.rejects(
    () => adapter.call({ server: 'not-registered', tool: 'x', args: {} }),
    SecurityViolation,
  )
})

/* ─────────────── declareCapabilities → registerCapabilities ─────────────── */

test('D3 declareCapabilities：initialize 握手 wire 级携带三型 capabilities + clientInfo', async () => {
  const transports = new Map<string, MockTransport>()
  const adapter = makeAdapter(transports)
  adapter.declareCapabilities({ sampling: true, roots: true, elicitation: true })
  await adapter.connect()
  const t = transports.get('srv-echo')
  assert.ok(t)

  const init = t.outbound.find((m) => m.method === 'initialize')
  assert.ok(init, '应捕获到 initialize 请求')
  const params = (init?.params ?? {}) as {
    capabilities?: { sampling?: unknown; roots?: unknown; elicitation?: unknown }
    clientInfo?: { name?: string }
  }
  assert.ok(params.capabilities?.sampling, 'initialize 应声明 sampling 能力')
  assert.ok(params.capabilities?.roots, 'initialize 应声明 roots 能力')
  assert.ok(params.capabilities?.elicitation, 'initialize 应声明 elicitation 能力')
  assert.equal(params.clientInfo?.name, 'dsh-runtime-control')
})

/* ─────────────── onRequest 三型接线（入站反向请求） ─────────────── */

test('D4a sampling 入站 → handler 收到 InboundRequest，返回值透传回 mock', async () => {
  const { t, received } = await setupInbound()
  t.deliver({
    jsonrpc: '2.0',
    id: 1,
    method: 'sampling/createMessage',
    params: {
      messages: [{ role: 'user', content: { type: 'text', text: '帮我总结这份文件' } }],
      maxTokens: 64,
    },
  })
  await flush()

  assert.equal(received.length, 1)
  assert.deepEqual(received[0], {
    type: 'sampling',
    from: 'srv-echo',
    request: { prompt: '帮我总结这份文件', maxTokens: 64 },
  })
  const resp = t.outbound.find((m) => m.id === 1 && 'result' in m)
  assert.ok(resp, '应捕获 client 对入站 sampling 请求的响应')
  assert.deepEqual(resp?.result, {
    role: 'assistant',
    model: 'mock-llm',
    stopReason: 'endTurn',
    content: { type: 'text', text: '采样结果' },
  })
})

test('D4b roots 入站 → handler 收到 { type: roots, from }，返回值透传回 mock', async () => {
  const { t, received } = await setupInbound()
  t.deliver({ jsonrpc: '2.0', id: 2, method: 'roots/list' })
  await flush()

  assert.equal(received.length, 1)
  assert.deepEqual(received[0], { type: 'roots', from: 'srv-echo' })
  const resp = t.outbound.find((m) => m.id === 2 && 'result' in m)
  assert.ok(resp, '应捕获 client 对入站 roots 请求的响应')
  assert.deepEqual(resp?.result, { roots: [{ uri: 'file:///ws/root', name: 'root' }] })
})

test('D4c elicitation 入站 → handler 收到 { type: elicitation, request.prompt }，返回值透传回 mock', async () => {
  const { t, received } = await setupInbound()
  t.deliver({
    jsonrpc: '2.0',
    id: 3,
    method: 'elicitation/create',
    params: {
      message: '请输入 API key',
      requestedSchema: { type: 'object', properties: {} },
    },
  })
  await flush()

  assert.equal(received.length, 1)
  assert.deepEqual(received[0], {
    type: 'elicitation',
    from: 'srv-echo',
    request: { prompt: '请输入 API key' },
  })
  const resp = t.outbound.find((m) => m.id === 3 && 'result' in m)
  assert.ok(resp, '应捕获 client 对入站 elicitation 请求的响应')
  assert.deepEqual(resp?.result, { action: 'decline' })
})

/* ─────────────── dispose（生命周期收尾） ─────────────── */

test('D5 dispose 关闭全部连接；dispose 后通道操作被拒', async () => {
  const transports = new Map<string, MockTransport>()
  const adapter = makeAdapter(transports, ['srv-a', 'srv-b'])
  await adapter.connect()
  const a = transports.get('srv-a')
  const b = transports.get('srv-b')
  assert.ok(a)
  assert.ok(b)

  await adapter.dispose()
  assert.equal(a.closed, true)
  assert.equal(b.closed, true)

  await assert.rejects(
    () => adapter.call({ server: 'srv-a', tool: 'x', args: {} }),
    SecurityViolation,
  )
})
