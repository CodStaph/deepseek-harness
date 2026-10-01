/**
 * S9 骨架冒烟测试（非正式验收——R1–R12 门禁属 M2 收口全量回归）。
 * 覆盖：膜四类拦截（R1 雏形）、令牌越界/撤销/过期（R2 雏形）、派生令牌只减不增（R22 雏形）。
 * 并入 dsh 仓库时转为 vitest describe/it 形态（镜像阶段用 node:test，零测试框架依赖）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import {
  createMembrane,
  SecurityViolation,
  DEFAULT_MEMBRANE,
  SENSITIVE_MEMBRANE,
  CapabilityToken,
  deriveFiberToken,
} from '../src/index.ts'

import type {
  MembraneAuditEntry,
  EffectRequest,
  EffectAuditEntry,
} from '../src/index.ts'

function auditSink() {
  const entries: MembraneAuditEntry[] = []
  return { entries, cb: (e: MembraneAuditEntry) => { entries.push(e) } }
}

test('S9-1 膜拦截 readonly 写入并产生审计条目（R1 雏形）', () => {
  const { entries, cb } = auditSink()
  const svc = { mode: 'workspace-write', policy: 'strict', check: () => true }
  const wrapped = createMembrane(svc, DEFAULT_MEMBRANE, cb)
  assert.throws(
    () => { wrapped.mode = 'danger-full-access' },
    (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'write-denied',
  )
  assert.equal(entries[0]?.attemptedValue, 'danger-full-access')
  // 原始对象未被污染
  assert.equal(svc.mode, 'workspace-write')
})

test('S9-2 膜拦截 sealed 删除、hidden 访问、blocked 调用、defineProperty（R1 雏形）', () => {
  const { entries, cb } = auditSink()
  const svc = {
    mode: 'x',
    check: () => true,
    internal: { secret: 1 },
    setMode: () => {},
  }
  const wrapped = createMembrane(svc, SENSITIVE_MEMBRANE, cb)
  assert.throws(() => { delete (wrapped as { check?: unknown }).check }, (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'delete-denied')
  assert.throws(() => { void wrapped.internal }, (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'access-denied')
  assert.throws(() => { wrapped.setMode() }, (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'call-blocked')
  assert.throws(() => { Object.defineProperty(wrapped, 'mode', { value: 'y' }) }, (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'define-denied')
  assert.equal(entries.length, 4)
})

test('S9-3 膜放行正常读、函数绑定 this（防解构窃取）', () => {
  const { cb } = auditSink()
  const svc = { mode: 'read-only', check() { return this.mode } }
  const wrapped = createMembrane(svc, DEFAULT_MEMBRANE, cb)
  assert.equal(wrapped.mode, 'read-only')
  const stolen = wrapped.check
  assert.equal((stolen as () => string)(), 'read-only')
})

test('S9-4 令牌：越界方法/属性拦截、放行声明内访问（R2 雏形）', () => {
  const svc = { mode: 'workspace-write', policy: 'strict', check: () => 'ok', setMode: () => {} }
  const token = CapabilityToken._issue<typeof svc>({
    service: 'sandbox',
    issuedTo: 'tool-fs',
    allowedMethods: ['check'],
    allowedProps: ['mode'],
  })
  const handle = token.use(svc, DEFAULT_MEMBRANE)
  assert.equal(handle.get('mode'), 'workspace-write')
  assert.equal(handle.call('check'), 'ok')
  // setMode 在服务上存在但不在令牌 allowedMethods 内；policy 同理——均运行时拦截
  assert.throws(() => handle.call('setMode'), /能力越界.*setMode/)
  assert.throws(() => handle.get('policy'), /能力越界.*policy/)
})

test('S9-5 令牌：撤销后 use 拒绝；过期令牌拒绝（R2 雏形）', () => {
  const svc = { check: () => 'ok' }
  const token = CapabilityToken._issue({ service: 's', issuedTo: 'p', allowedMethods: ['check'], allowedProps: [] })
  token.revoke()
  assert.equal(token.isValid, false)
  assert.throws(() => token.use(svc, DEFAULT_MEMBRANE), /令牌已撤销/)

  const expired = CapabilityToken._issue({
    service: 's', issuedTo: 'p',
    allowedMethods: ['check'], allowedProps: [],
    expiresAt: Date.now() - 1,
  })
  assert.equal(expired.isValid, false)
  assert.throws(() => expired.use(svc, DEFAULT_MEMBRANE), /令牌已过期/)
})

test('S9-6 派生令牌只减不增、随 fiber 过期、精确归属（R22 雏形）', () => {
  const svc = { a: () => 1, b: () => 2, mode: 'm' }
  const parent = CapabilityToken._issue<typeof svc>({
    service: 'svc', issuedTo: 'tool-fs',
    allowedMethods: ['a', 'b'], allowedProps: ['mode'],
  })
  const child = deriveFiberToken(parent, 'fiber-12', { methods: ['a'] })
  assert.equal(child.issuedTo, 'tool-fs#fiber-12')
  assert.equal(child.allowedMethods.size, 1)
  assert.equal(child.allowedProps.size, 1) // props 未传则继承（只减不增）
  // 父令牌永不过期（0），派生令牌不继承——须有有限过期时间
  assert.equal(parent.expiresAt, 0)
  assert.ok(child.expiresAt > Date.now())

  // 撤销父令牌不影响已派生令牌的独立对象语义（撤销链传播由 S16/S18 注册表实现）
  parent.revoke()
  assert.throws(() => parent.use(svc, DEFAULT_MEMBRANE), /令牌已撤销/)
  const childHandle = child.use(svc, DEFAULT_MEMBRANE)
  assert.equal(childHandle.call('a'), 1)
})

test('S9-7 效果类型与审计条目字段闭环（含 v4 互指键预留）', () => {
  const req: EffectRequest = {
    type: 'fs.write',
    target: '/workspace/file.ts',
    caller: 'tool-fs#fiber-12',
    capabilityTokenId: 'cap_x',
    artifact: 'intermediate',
  }
  const entry: EffectAuditEntry = {
    timestamp: new Date().toISOString(),
    type: req.type,
    target: req.target,
    caller: req.caller,
    verdict: 'allow',
    approvalDecision: 'exempted',
    exemption: 'same-session-artifact',
    exfiltrationCheck: 'not-applicable',
    assemblyPlanId: 'plan-20260930',
  }
  assert.equal(entry.assemblyPlanId, 'plan-20260930')
  assert.equal(req.artifact, 'intermediate')
})
