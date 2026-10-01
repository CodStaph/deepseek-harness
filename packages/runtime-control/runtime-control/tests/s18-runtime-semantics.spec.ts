/**
 * S18 测试：isolate 档 + 收尾自检 + fiber 精确撤销 + 按目标写锁（批次 3b）
 * 覆盖：R20（isolate 档：撤令牌+卸载+审计，进程与兄弟插件存活；阈值升级装配期禁用
 *       §9.3 第 8 条）；R21（post-hoc 收尾清算：undeclared/capability-exceeded/
 *       artifact-unmarked）；R22（fiber 粒度令牌：revokeFiber 不伤兄弟 fiber）；
 *       R23（同目标写串行化）。
 * 并入 dsh 后以 vitest 运行（批次 1-2 迁移）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import type { CapabilityDeclaration } from '@deepseek-ai/dsh-assembly'

import { EffectWriteLock } from '../src/write-lock.ts'
import { runPostHocReview } from '../src/post-hoc.ts'
import type { ReviewScope } from '../src/post-hoc.ts'
import { FiberTokenRegistry } from '../src/fiber.ts'
import { CapabilityToken, deriveFiberToken } from '../src/capability.ts'
import {
  IsolateViolationHandler,
  IsolateEscalationTracker,
  PluginIsolatedError,
  DEFAULT_ISOLATE_THRESHOLD,
} from '../src/violation.ts'
import type { RuntimeController, ViolationContext } from '../src/violation.ts'
import { SecurityViolation } from '../src/membrane.ts'
import type { EffectAuditEntry } from '../src/effect.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ─────────────────────── R23：按目标写锁 ─────────────────────── */

test('S18-1 同目标写效果串行化（R23：不交错）', async () => {
  const lock = new EffectWriteLock()
  const order: string[] = []
  await Promise.all([
    lock.withLock('a', async () => { order.push('a1-start'); await sleep(25); order.push('a1-end') }),
    lock.withLock('a', async () => { order.push('a2-start') }),
  ])
  // a2 必须排在 a1 完成之后（串行），否则内容会交错
  assert.ok(order.indexOf('a1-end') < order.indexOf('a2-start'), `order=${order.join('>')}`)
})

test('S18-2 不同目标并行（互不阻塞）', async () => {
  const lock = new EffectWriteLock()
  const order: string[] = []
  const [aDone, bDone] = await Promise.all([
    lock.withLock('a', async () => { await sleep(20); order.push('a') }),
    lock.withLock('b', async () => { order.push('b') }),
  ])
  void aDone; void bDone
  // b 无前置依赖，应早于/并行于 a 完成（不因同锁阻塞）
  assert.ok(order.includes('a') && order.includes('b'))
})

test('S18-3 锁链释放：pendingTargets 归零', async () => {
  const lock = new EffectWriteLock()
  await Promise.all([lock.withLock('x', async () => {}), lock.withLock('x', async () => {})])
  assert.deepEqual(lock.pendingTargets(), [])
})

test('S18-4 前序 effect 抛错不阻塞后续（run 链式）', async () => {
  const lock = new EffectWriteLock()
  const ran: string[] = []
  await lock.withLock('t', async () => { throw new Error('boom') }).catch(() => {})
  await lock.withLock('t', async () => { ran.push('second-ok') })
  assert.deepEqual(ran, ['second-ok'])
})

/* ─────────────────────── R22：fiber 粒度令牌 ─────────────────────── */

test('S18-5 revokeFiber 只撤单个 fiber，兄弟 fiber 不受影响（R22）', () => {
  const reg = new FiberTokenRegistry()
  const parent = CapabilityToken._issue<object>({
    service: 'svc', issuedTo: 'plugin-a', allowedMethods: ['m'], allowedProps: ['p'],
  })
  const f1 = deriveFiberToken(parent, 'fiber-1')
  const f2 = deriveFiberToken(parent, 'fiber-2')
  reg.register('plugin-a', 'fiber-1', f1)
  reg.register('plugin-a', 'fiber-2', f2)

  assert.equal(f1.isValid, true)
  assert.equal(f2.isValid, true)

  const revoked = reg.revokeFiber('plugin-a', 'fiber-1')
  assert.equal(revoked, 1)
  assert.equal(f1.isValid, false) // 单个子代理被精确撤销
  assert.equal(f2.isValid, true)  // 兄弟 fiber 不受影响（R22）
})

test('S18-6 revokePlugin 撤销全部 fiber 令牌（配合 isolate 整体摘除）', () => {
  const reg = new FiberTokenRegistry()
  const parent = CapabilityToken._issue<object>({
    service: 'svc', issuedTo: 'plugin-b', allowedMethods: ['m'], allowedProps: ['p'],
  })
  const f1 = deriveFiberToken(parent, 'f-1')
  const f2 = deriveFiberToken(parent, 'f-2')
  reg.register('plugin-b', 'f-1', f1)
  reg.register('plugin-b', 'f-2', f2)

  const count = reg.revokePlugin('plugin-b')
  assert.equal(count, 2)
  assert.equal(f1.isValid, false)
  assert.equal(f2.isValid, false)
})

/* ─────────────────────── R21：收尾自检（post-hoc） ─────────────────────── */

function auditEntry(type: EffectAuditEntry['type'], target: string, artifact?: string): EffectAuditEntry {
  return {
    timestamp: new Date().toISOString(), type, target, caller: 'tool-p',
    verdict: 'allow', ...(artifact !== undefined ? { artifact } : {}),
  }
}

test('S18-7 post-hoc：未声明能力 → undeclared-capability（error）', () => {
  const declared: CapabilityDeclaration = { fs: { read: ['/ws/**'] } }
  const scope: ReviewScope = { pluginId: 'tool-p' }
  const report = runPostHocReview(scope, [auditEntry('mcp.call', 'server.tool')], declared)
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0]!.issue, 'undeclared-capability')
  assert.equal(report.findings[0]!.severity, 'error')
})

test('S18-8 post-hoc：声明能力但超出 → capability-exceeded（error）', () => {
  // fs.write 未声明 write 面 → exceeded
  const declared: CapabilityDeclaration = { fs: { read: ['/tmp/**'] } }
  const report = runPostHocReview({}, [auditEntry('fs.write', '/tmp/a')], declared)
  const find = report.findings.find((f) => f.issue === 'capability-exceeded')
  assert.ok(find, '应存在 capability-exceeded finding')
  assert.equal(find?.severity, 'error')
})

test('S18-9 post-hoc：fs.write 未标 artifact → artifact-unmarked（warning）', () => {
  const declared: CapabilityDeclaration = { fs: { write: ['/tmp/**'] } }
  const report = runPostHocReview({}, [auditEntry('fs.write', '/tmp/a')], declared)
  const find = report.findings.find((f) => f.issue === 'artifact-unmarked')
  assert.ok(find, '应存在 artifact-unmarked finding')
  assert.equal(find?.severity, 'warning')
})

test('S18-10 post-hoc：合规调用不产生 finding', () => {
  const declared: CapabilityDeclaration = { fs: { write: ['/tmp/**'] } }
  const report = runPostHocReview({}, [auditEntry('fs.read', '/tmp/a')], declared)
  assert.deepEqual(report.findings, [])
})

/* ─────────────────────── R20：isolate 档 + 阈值升级 ─────────────────────── */

function isolateHarness(threshold = DEFAULT_ISOLATE_THRESHOLD) {
  const auditEntries: unknown[] = []
  const revoked: string[] = []
  const isolated: string[] = []
  const disabled: Array<{ id: string; reason: string }> = []
  const postHoc: Array<{ pluginId: string; warning: string }> = []
  const runtime: RuntimeController = {
    revokePlugin: (id) => { revoked.push(id) },
    isolatePlugin: (id) => { isolated.push(id) },
    disablePlugin: (id, reason) => { disabled.push({ id, reason }) },
  }
  const tracker = new IsolateEscalationTracker(threshold)
  const handler = new IsolateViolationHandler({
    audit: (e) => auditEntries.push(e),
    runtime,
    escalation: tracker,
    onPostHocReview: (r) => postHoc.push(r),
  })
  const violation = new SecurityViolation('cap-overreach', {
    action: 'call-blocked', property: 'p', reason: 'capability',
  })
  const context: ViolationContext = {
    pluginId: 'tool-bad',
    type: 'capability',
    auditEntry: { action: 'access-denied', property: 'p', reason: 'capability' },
  }
  return { handler, violation, context, revoked, isolated, disabled, postHoc, auditEntries }
}

test('S18-11 isolate 档：撤令牌 + 卸载 + 审计 + 抛 PluginIsolatedError（R20 进程存活）', () => {
  const h = isolateHarness()
  let caught: unknown
  try { h.handler.handle(h.violation, h.context) } catch (e) { caught = e }

  assert.ok(caught instanceof PluginIsolatedError, '应抛 PluginIsolatedError（非进程级异常）')
  const err = caught as PluginIsolatedError
  assert.equal(err.pluginId, 'tool-bad')
  // 撤销令牌 + 卸载插件（进程与兄弟插件存活——不抛进程级异常即体现）
  assert.deepEqual(h.revoked, ['tool-bad'])
  assert.deepEqual(h.isolated, ['tool-bad'])
  // 审计记录隔离原因
  assert.equal(h.auditEntries.length, 1)
  // 每次隔离产出 warning 级 post-hoc 报告（§5.5 / §9.3 第 8 条）
  assert.equal(h.postHoc.length, 1)
  assert.match(h.postHoc[0]!.warning, /第 1 次隔离/)
})

test('S18-12 阈值升级：累计隔离达阈值 → 装配期禁用（disablePlugin 而非 isolate）', () => {
  const h = isolateHarness(2)
  for (let i = 0; i < 2; i++) {
    try { h.handler.handle(h.violation, h.context) } catch { /* PluginIsolatedError 被吞 */ }
  }
  // 第 1 次 isolate，第 2 次达阈值 → 升级装配期禁用
  assert.deepEqual(h.isolated, ['tool-bad'])
  assert.equal(h.disabled.length, 1)
  assert.equal(h.disabled[0]!.id, 'tool-bad')
  assert.match(h.disabled[0]!.reason, /累计隔离 2 次达阈值/)
})

test('S18-13 阈值可配：阈值 1 则首次隔离即升级装配期禁用', () => {
  const h = isolateHarness(1)
  try { h.handler.handle(h.violation, h.context) } catch { /* ignored */ }
  assert.deepEqual(h.isolated, [])          // 未走 isolatePlugin
  assert.equal(h.disabled.length, 1)        // 直接装配期禁用
  assert.equal(h.disabled[0]!.id, 'tool-bad')
})