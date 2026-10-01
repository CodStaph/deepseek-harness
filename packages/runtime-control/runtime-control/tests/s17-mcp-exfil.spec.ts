/**
 * S17 测试：MCP 效果处理器 + 数据外发检查（批次 3b）
 * 覆盖：McpEffectHandler 全判定链（契约能力 / server.tool 白名单 / denyParamPatterns /
 *       外发检查 / 审批接入 / 审计要素）；R18（mcp.call 纳入效果审计 + 白名单生效）；
 *       R19（数据外发检查：超上限或含敏感数据被拦截）；NetEffectHandler 复用敏感扫描。
 * 并入 dsh 后以 vitest 运行（批次 1-2 迁移）。
 */

import { test, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { McpCapability } from '@deepseek-ai/dsh-assembly'

import {
  checkExfiltration,
  estimateOutboundBytes,
} from '../src/effects/exfiltration.ts'
import { McpEffectHandler, parseMcpTarget } from '../src/effects/mcp.ts'
import type { McpEffectHandlerOptions } from '../src/effects/mcp.ts'
import { NetEffectHandler } from '../src/effects/handlers.ts'
import { ApprovalService } from '../src/effects/approval.ts'
import type { ApprovalReply } from '../src/effects/approval.ts'
import type { EffectAuditEntry, EffectRequest } from '../src/effect.ts'

function auditSink() {
  const entries: EffectAuditEntry[] = []
  return { entries, cb: (e: EffectAuditEntry) => { entries.push(e) } }
}

const ws = mkdtempSync(join(tmpdir(), 'cordis-s17-ws-'))
afterAll(async () => { await rm(ws, { recursive: true, force: true }) })

/* ─────────────────────── exfiltration 纯函数 ─────────────────────── */

test('S17-1 estimateOutboundBytes：string/Uint8Array/对象/null 计量正确', () => {
  assert.equal(estimateOutboundBytes('hello'), 5)
  assert.equal(estimateOutboundBytes(new Uint8Array([1, 2, 3])), 3)
  assert.equal(estimateOutboundBytes({ a: 1, b: 'x' }), JSON.stringify({ a: 1, b: 'x' }).length)
  assert.equal(estimateOutboundBytes(null), 0)
  assert.equal(estimateOutboundBytes(undefined), 0)
})

test('S17-2 checkExfiltration：not-applicable（纯读式）', () => {
  assert.equal(checkExfiltration('', 10_000), 'not-applicable')
  assert.equal(checkExfiltration(null, 10_000), 'not-applicable')
})

test('S17-3 checkExfiltration：未声明出站能力（ceiling 0/undefined）→ blocked', () => {
  assert.equal(checkExfiltration('payload', 0), 'blocked')
  assert.equal(checkExfiltration('payload', undefined), 'blocked')
})

test('S17-4 checkExfiltration：超上限 → blocked', () => {
  assert.equal(checkExfiltration('abcdef', 5), 'blocked')
})

test('S17-5 checkExfiltration：敏感字段（credentials/authorization/token）→ blocked', () => {
  assert.equal(checkExfiltration({ body: { authorization: 'Bearer xyz' } }, 1000), 'blocked')
  assert.equal(checkExfiltration({ apiKey: 'sk-abc' }, 1000), 'blocked')
  assert.equal(checkExfiltration({ nested: { sessionToken: 'tok' } }, 1000), 'blocked')
})

test('S17-6 checkExfiltration：长会话令牌特征 → blocked；合规 → pass', () => {
  assert.equal(checkExfiltration('Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuvwxyz012345', 2000), 'blocked')
  assert.equal(checkExfiltration({ query: '查找资料', limit: 10 }, 1000), 'pass')
})

test('S17-7 自定义扫描器注入生效', () => {
  const scanner = (d: unknown) => typeof d === 'object' && (d as Record<string, unknown>).evil === true
  assert.equal(checkExfiltration({ evil: true, note: 'x' }, 1000, [scanner]), 'blocked')
})

/* ─────────────────────── McpEffectHandler ─────────────────────── */

function makeHandler(
  overrides: Omit<Partial<McpEffectHandlerOptions>, 'capability' | 'approval'> & {
    capability?: McpCapability | undefined
    approval?: ApprovalService | undefined
  } = {},
) {
  const sink = auditSink()
  const client = { call: async (r: { server: string; tool: string; args: unknown }) => ({ ok: true, echo: r }) }
  const defaultCapability: McpCapability = {
    servers: ['playwright-mcp', 'fetch-mcp'],
    tools: ['playwright-mcp.*', 'fetch-mcp.read', 'fetch-mcp.fetch'],
    denyParamPatterns: ['file://'],
  }
  const hasCapability = Object.prototype.hasOwnProperty.call(overrides, 'capability')
  const hasApproval = Object.prototype.hasOwnProperty.call(overrides, 'approval')
  const { capability: _overCap, approval: _overAppr, ...rest } = overrides
  void _overCap; void _overAppr
  const handler = new McpEffectHandler({
    client,
    audit: sink.cb,
    ...(hasCapability
      ? (_overCap !== undefined ? { capability: _overCap } : {})
      : { capability: defaultCapability }),
    maxOutboundBytes: 1024,
    ...(hasApproval
      ? (_overAppr !== undefined ? { approval: _overAppr } : {})
      : { approval: new ApprovalService({ decide: () => ({ verdict: 'approve' }) }) }),
    ...rest,
  })
  return { sink, handler, client }
}

const mcpReq = (target: string, args: unknown = { q: 1 }, caller = 'tool-x'): EffectRequest => ({
  type: 'mcp.call', target, args: [args], caller,
})

test('S17-8 未声明 mcp 能力：strict 拒绝 / lenient 降级 warning', async () => {
  const strict = makeHandler({ capability: undefined })
  const r1 = await strict.handler.handle(mcpReq('playwright-mcp.goto', { url: 'https://x.com' }))
  assert.equal(r1.ok, false)
  assert.match(r1.error ?? '', /未声明 mcp 能力/)

  const lenient = makeHandler({ capability: undefined, lenient: true })
  const r2 = await lenient.handler.handle(mcpReq('playwright-mcp.goto', { url: 'https://x.com' }))
  assert.equal(r2.ok, true)
  assert.equal(lenient.sink.entries[0]!.reason, 'lenient-undeclared-capability')
})

test('S17-8 server / tool 不在白名单 → 拒绝（R18 白名单生效）', async () => {
  const { handler, sink } = makeHandler({})
  const r1 = await handler.handle(mcpReq('other-mcp.goto', { url: 'x' }))
  assert.equal(r1.ok, false)
  assert.match(r1.error ?? '', /server 不在白名单/)
  assert.equal(sink.entries[0]!.verdict, 'deny')

  // fetch-mcp 只声明 read/fetch 两个工具；bad 不在白名单（tools 非通配该前缀）
  const r2 = await handler.handle(mcpReq('fetch-mcp.bad', {}))
  assert.equal(r2.ok, false)
  assert.match(r2.error ?? '', /工具不在白名单/)
})

test('S17-9 denyParamPatterns：参数命中黑名单 → 拒绝（exfiltrationCheck=blocked）', async () => {
  const { handler, sink } = makeHandler({})
  const r = await handler.handle(mcpReq('fetch-mcp.fetch', { path: 'file:///etc/passwd' }))
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /denyParamPatterns/)
  assert.equal(sink.entries[0]!.exfiltrationCheck, 'blocked')
})

test('S17-10 参数含敏感数据 → 外发拦截（R19）', async () => {
  const { handler, sink } = makeHandler({})
  const r = await handler.handle(mcpReq('fetch-mcp.read', { credentials: 'admin/secret' }))
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /外发检查拦截/)
  assert.equal(sink.entries[0]!.exfiltrationCheck, 'blocked')
})

test('S17-11 参数超上限 → 外发 blocked（R19）', async () => {
  const { handler, sink } = makeHandler({ maxOutboundBytes: 10 })
  const r = await handler.handle(mcpReq('fetch-mcp.read', { big: 'x'.repeat(100) }))
  assert.equal(r.ok, false)
  assert.equal(sink.entries[0]!.exfiltrationCheck, 'blocked')
})

test('S17-12 成功调用：allow + 审计含 server/tool/参数摘要/结果摘要/exfiltrationCheck', async () => {
  const { handler, sink } = makeHandler({})
  const r = await handler.handle(mcpReq('fetch-mcp.read', { query: 'math', op: '+' }))
  assert.equal(r.ok, true)
  const entry = sink.entries[0]!
  assert.equal(entry.verdict, 'allow')
  assert.equal(entry.type, 'mcp.call')
  assert.equal(entry.target, 'fetch-mcp.read')
  assert.equal(entry.exfiltrationCheck, 'pass')
  assert.equal(entry.paramsSummary, JSON.stringify({ query: 'math', op: '+' }))
  assert.ok(entry.dataSummary && entry.dataSummary.includes('fetch-mcp'))
})

test('S17-13 未注入审批服务 → mcp.call 拒绝（S16 语义：无审批不执行）', async () => {
  const { handler } = makeHandler({ approval: undefined })
  const r = await handler.handle(mcpReq('fetch-mcp.read', { q: 1 }))
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /未注入审批服务/)
})

test('S17-14 审批拒绝 → mcp.call 拒绝', async () => {
  const rejectDecide = (): ApprovalReply => ({ verdict: 'reject' })
  const approval = new ApprovalService({ decide: rejectDecide })
  const { handler } = makeHandler({ approval })
  const r = await handler.handle(mcpReq('fetch-mcp.read', { q: 1 }))
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /未获审批/)
})

test('S17-15 审批批准 → allow（decide approve 通道）', async () => {
  const approveDecide = (): ApprovalReply => ({ verdict: 'approve' })
  const approval = new ApprovalService({ decide: approveDecide })
  const { handler, sink } = makeHandler({ approval })
  const r = await handler.handle(mcpReq('fetch-mcp.read', { q: 1 }))
  assert.equal(r.ok, true)
  assert.ok(sink.entries.some((e) => e.verdict === 'allow' && e.approvalDecision === 'approved'))
})

test('S17-16 parseMcpTarget：解析 server.tool 与缺省形态', () => {
  assert.deepEqual(parseMcpTarget('playwright-mcp.goto'), { server: 'playwright-mcp', tool: 'goto' })
  assert.deepEqual(parseMcpTarget('nodot'), { server: 'nodot', tool: '' })
})

/* ─────────────────────── NetEffectHandler 复用敏感扫描（R19） ─────────────────────── */

test('S17-17 NetEffectHandler：出站含敏感凭证被拦截（R19）', async () => {
  const sink = auditSink()
  const handler = new NetEffectHandler({
    audit: sink.cb,
    allowedDomains: ['api.example.com'],
    outboundCeilingBytes: 10 * 1024,
  })
  const r = await handler.handle({
    type: 'net.fetch', target: 'https://api.example.com/push',
    args: [{ body: { data: 'hello', token: 'sk-abc' } }], caller: 'tool-net',
  })
  assert.equal(r.ok, false)
  assert.equal(sink.entries[0]!.exfiltrationCheck, 'blocked')
})

test('S17-18 NetEffectHandler：外发判定 pass（不进真实 fetch 的纯判定路径）', async () => {
  const sink = auditSink()
  const handler = new NetEffectHandler({
    audit: sink.cb, allowedDomains: ['api.example.com'], outboundCeilingBytes: 1024,
  })
  // 外发检查在真实 fetch 之前完成：合规 body → 先判 pass 再尝试 fetch
  await handler.handle({
    type: 'net.fetch', target: 'https://api.example.com/push',
    args: [{ body: { note: 'ok' } }], caller: 'tool-net',
  })
  // blocked 判定不进 fetch；无论 fetch 成败，外发检查结果都落账为 pass（R19 可观测性）
  assert.equal(sink.entries[0]!.exfiltrationCheck, 'pass')
})