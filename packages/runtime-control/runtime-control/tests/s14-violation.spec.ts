/**
 * S14 运行时违规处理（DefaultViolationHandler，默认 log-and-throw）测试。
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.5（第 1806–1857 行）。
 * 覆盖：三档已实现策略（throw/log/log-and-throw）的"审计 + 抛/降级"行为、
 *       四类违规域（membrane/capability/effect/realm）的 securityReason 前缀、
 *       效果型审计条目（EffectAuditEntry）的无形状耦合接纳（noErrorOnShape）。
 * 并入 dsh 仓库时转为 vitest describe/it 形态（镜像阶段用 node:test）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import { DefaultViolationHandler } from '../src/violation.ts'
import type { ViolationContext } from '../src/violation.ts'
import { SecurityViolation } from '../src/membrane.ts'
import type { MembraneAuditEntry, EffectAuditEntry } from '../src/index.ts'

import type { AuditEntry } from '@deepseek-ai/dsh-assembly'

/** 审计收集器——捕获 handler 产出的 AuditEntry */
function auditSink() {
  const entries: AuditEntry[] = []
  return { entries, cb: (e: AuditEntry) => { entries.push(e) } }
}

/** 构造膜违规的上下文（type:'membrane'，用 MembraneAuditEntry） */
function membraneContext(overrides: Partial<ViolationContext> = {}): ViolationContext {
  const auditEntry: MembraneAuditEntry = { action: 'access-denied', property: 'p', reason: 'hidden' }
  return { pluginId: 'test-plugin', type: 'membrane', auditEntry, ...overrides }
}

test('S14-1 默认策略 log-and-throw：先记录审计再抛同违规', () => {
  const { entries, cb } = auditSink()
  const handler = new DefaultViolationHandler(cb)
  const violation = new SecurityViolation('boom', {
    action: 'access-denied', property: 'p', reason: 'hidden',
  })
  const context = membraneContext()

  let caught: unknown
  try { handler.handle(violation, context) } catch (e) { caught = e }

  // 抛回的是同一个 violation 对象（可感知、可捕获）
  assert.equal(caught, violation)
  assert.equal(entries.length, 1)

  const entry = entries[0]!
  assert.equal(entry.action, 'security-violation')
  assert.equal(entry.layer, 'test-plugin')
  assert.equal(entry.rowId, 'test-plugin')
  assert.equal(entry.file, '')
  assert.equal(entry.field, 'p')
  assert.equal(entry.newValue, undefined)
  assert.equal(entry.securityVerdict, 'deny')
  assert.equal(entry.securityReason, '[membrane] boom')
})

test('S14-2 policy=log：审计记录但不抛（降级观测）', () => {
  const { entries, cb } = auditSink()
  const handler = new DefaultViolationHandler(cb, 'log')
  const violation = new SecurityViolation('boom', {
    action: 'write-denied', property: 'config', reason: 'readonly',
  })
  const context = membraneContext()

  assert.doesNotThrow(() => handler.handle(violation, context))
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.securityReason, '[membrane] boom')
})

test('S14-3 policy=throw：审计记录 + 抛同违规', () => {
  const { entries, cb } = auditSink()
  const handler = new DefaultViolationHandler(cb, 'throw')
  const violation = new SecurityViolation('fatal', {
    action: 'call-blocked', property: 'setMode', reason: 'blocked',
  })
  const context = membraneContext()

  assert.throws(() => handler.handle(violation, context), (err: unknown) => err === violation)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.securityReason, '[membrane] fatal')
})

test('S14-4 各域类型：securityReason 前缀正确（membrane/capability/effect/realm）', () => {
  const types = ['membrane', 'capability', 'effect', 'realm'] as const
  for (const type of types) {
    const { entries, cb } = auditSink()
    const handler = new DefaultViolationHandler(cb, 'log')
    const violation = new SecurityViolation(`v-${type}`, {
      action: 'access-denied', property: 'p', reason: 'hidden',
    })
    const context = membraneContext({ type })
    handler.handle(violation, context)
    assert.equal(entries.length, 1, `type=${type}`)
    assert.equal(entries[0]!.securityReason, `[${type}] v-${type}`, `type=${type}`)
  }
})

test('S14-5 效果型审计条目（EffectAuditEntry）无形状耦合接纳（noErrorOnShape）', () => {
  const { entries, cb } = auditSink()
  const handler = new DefaultViolationHandler(cb, 'log')
  const violation = new SecurityViolation('fs-denied', {
    action: 'access-denied', property: 'p', reason: 'hidden',
  })
  const auditEntry: EffectAuditEntry = {
    timestamp: new Date().toISOString(),
    type: 'fs.write',
    target: '/data/x.txt',
    caller: 'tool-fs',
    verdict: 'deny',
  }
  const context: ViolationContext = { pluginId: 'tool-fs', type: 'effect', auditEntry }

  // log 档：不抛，仅记录（shape 接纳不因缺少膜专属字段而失败）
  assert.doesNotThrow(() => handler.handle(violation, context))
  assert.equal(entries.length, 1)
  // 效果条目无 property，字段锚点回退到 target
  assert.equal(entries[0]!.field, '/data/x.txt')
  assert.equal(entries[0]!.newValue, undefined)
  assert.equal(entries[0]!.securityReason, '[effect] fs-denied')
  assert.equal(entries[0]!.securityVerdict, 'deny')
})