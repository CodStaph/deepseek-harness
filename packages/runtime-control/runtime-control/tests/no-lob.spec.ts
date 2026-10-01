/**
 * No-Löb 硬排除测试（批次 3a，随 S16 先置——方案 §8.1 依赖注释）
 * 覆盖（服务验收 R39）：
 * - isMetaCaller：元层调用者封闭枚举判定；
 * - assertNotMeta / assertNotMetaCaller：授权登记与豁免判定入口抛 SecurityViolation；
 * - META_CALLERS 调用审批请求 → 直接拒：不进授权通道（decide 不被调）、
 *   不进豁免通道（temp 区内 target 也不命中豁免），审计照写（元记账 ≠ 对象层豁免）；
 * - recordGrant：元层调用者登记被拒；
 * - lookupGrant：元层调用者永不消费授权记忆（纵深防御）。
 */

import { test, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  META_CALLERS,
  ROOT_CALLER,
  isMetaCaller,
  assertNotMeta,
  assertNotMetaCaller,
} from '../src/meta/no-lob.ts'
import { SecurityViolation } from '../src/membrane.ts'
import { ApprovalService } from '../src/effects/approval.ts'
import type { EffectAuditEntry } from '../src/effect.ts'

const ws = mkdtempSync(join(tmpdir(), 'cordis-nolob-ws-'))
const tempArea = join(ws, '.temp')
mkdirSync(tempArea, { recursive: true })

afterAll(async () => {
  await rm(ws, { recursive: true, force: true })
})

test('NL-1 isMetaCaller：元层调用者封闭枚举判定', () => {
  assert.equal(ROOT_CALLER, 'dsh-root') // 方案 §5.10.2
  assert.equal(isMetaCaller('dsh-root'), true)
  assert.equal(isMetaCaller('runtime-control'), true)
  assert.equal(isMetaCaller('meta'), true)
  assert.equal(isMetaCaller('meta#system'), true)
  // 对象层调用者（含 fiber 后缀）不命中
  assert.equal(isMetaCaller('tool-fs'), false)
  assert.equal(isMetaCaller('tool-fs#fiber-1'), false)
  assert.equal(isMetaCaller('runtime-control-helper'), false) // 精确匹配不前缀误伤
  assert.equal(isMetaCaller(''), false)
  assert.ok(META_CALLERS.size >= 4)
  assert.ok(META_CALLERS.has(ROOT_CALLER))
})

test('NL-2 assertNotMeta：元层调用者登记授权/豁免抛 SecurityViolation（R39）', () => {
  assert.throws(
    () => assertNotMeta('dsh-root', 'recordGrant'),
    (e: unknown) => {
      assert.ok(e instanceof SecurityViolation)
      assert.match(e.message, /No-Löb/)
      assert.match(e.message, /dsh-root/)
      assert.match(e.message, /元记账/) // 元记账 ≠ 对象层豁免
      assert.equal(e.auditEntry.action, 'write-denied')
      assert.equal(e.auditEntry.property, 'recordGrant')
      assert.equal(e.auditEntry.reason, 'no-lob') // 方案 §5.11.2 原文审计形态
      return true
    },
  )
  // 方案原命名别名（assertNotMetaCaller）等价
  assert.throws(() => assertNotMetaCaller('runtime-control', 'evaluateExemption'), SecurityViolation)
  // 对象层调用者不抛
  assert.doesNotThrow(() => assertNotMeta('tool-fs', 'recordGrant'))
  assert.doesNotThrow(() => assertNotMetaCaller('tool-fs', 'evaluateExemption'))
})

test('NL-3 META_CALLERS 审批请求直接拒：不进授权通道（decide 不被调）、不进豁免通道（R39）', async () => {
  const entries: EffectAuditEntry[] = []
  let decideCalls = 0
  const svc = new ApprovalService({
    audit: (e) => { entries.push(e) },
    tempAreaRoot: tempArea,
    decide: () => { decideCalls += 1; return { verdict: 'approve', scope: 'class' } },
  })

  // target 落在临时区：若无 No-Löb 排除本应命中 temp-area 豁免——验证豁免通道同样不进
  const r = await svc.request({ type: 'fs.write', target: join(tempArea, 'self.txt'), caller: 'dsh-root' })
  assert.equal(r.decision, 'denied')
  assert.equal(r.ok, false)
  assert.equal(r.exemption, undefined)
  assert.equal(decideCalls, 0) // 审批员通道未进入
  assert.match(r.auditEntry.reason ?? '', /No-Löb/)
  assert.equal(r.auditEntry.approvalDecision, 'denied')
  assert.equal(r.auditEntry.verdict, 'deny') // 元记账照写（审计仍记录）

  // 管控层内部调用者：fs.trash 本应命中 trash-default 豁免——同样直接拒
  const r2 = await svc.request({ type: 'fs.trash', target: join(ws, 'x.txt'), caller: 'runtime-control' })
  assert.equal(r2.decision, 'denied')
  assert.equal(r2.exemption, undefined)
  assert.equal(decideCalls, 0)

  // 对照：对象层调用者的 trash 请求正常走豁免
  const r3 = await svc.request({ type: 'fs.trash', target: join(ws, 'x.txt'), caller: 'tool-fs' })
  assert.equal(r3.decision, 'approved')
  assert.equal(r3.exemption, 'trash-default')
  assert.equal(decideCalls, 0)
})

test('NL-4 recordGrant：元层调用者登记被拒，对象层调用者正常登记（R39）', () => {
  const svc = new ApprovalService()
  assert.throws(
    () => svc.recordGrant({ scope: 'class', grantedBy: 'policy', type: 'fs.write', caller: 'runtime-control' }),
    (e: unknown) => e instanceof SecurityViolation && e.auditEntry.reason === 'no-lob',
  )
  assert.throws(
    () => svc.recordGrant({ scope: 'object', objectKey: '/x', grantedBy: 'user', type: 'fs.write', caller: ROOT_CALLER }),
    SecurityViolation,
  )

  // 对象层调用者正常登记 + classKey 派生正确
  const g = svc.recordGrant({ scope: 'class', grantedBy: 'user', type: 'fs.write', caller: 'tool-fs' })
  assert.equal(g.scope, 'class')
  assert.equal(g.classKey, 'fs.write#tool-fs')
  assert.notEqual(svc.lookupGrant({ type: 'fs.write', target: '/any', caller: 'tool-fs' }), undefined)

  // 纵深防御：元层调用者永不消费授权记忆（即使同类授权已存在）
  assert.equal(svc.lookupGrant({ type: 'fs.write', target: '/any', caller: 'dsh-root' }), undefined)
  assert.equal(svc.lookupGrant({ type: 'fs.write', target: '/any', caller: 'meta' }), undefined)
})
