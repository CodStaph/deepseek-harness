/**
 * S10（服务膜接线）＋S11（令牌颁发）冒烟测试。
 * 覆盖：installMembrane 接线（R1 雏形扩展）、膜配置注册表解析、issuer 按装配层计划颁发令牌。
 * （令牌计划的过滤/lenient 语义在装配层 capability-grants 测试覆盖；issuer 只忠实实例化。）
 * 并入 dsh 仓库时转为 vitest describe/it 形态（镜像阶段用 node:test）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import {
  installMembrane,
  SENSITIVE_SERVICE_MEMBRANES,
  buildMembraneRegistry,
  resolveMembraneConfig,
  issueTokens,
  SecurityViolation,
  DEFAULT_MEMBRANE,
} from '../src/index.ts'

import type { MembraneAuditEntry } from '../src/index.ts'
import type { CapabilityGrantPlan, TokenGrant } from '@deepseek-ai/dsh-assembly'

function auditSink() {
  const entries: MembraneAuditEntry[] = []
  return { entries, cb: (e: MembraneAuditEntry) => { entries.push(e) } }
}

/** 构造装配层预颁发计划（CapabilityGrantPlan） */
function planWith(grants: Record<string, TokenGrant[]>): CapabilityGrantPlan {
  const map = new Map<string, TokenGrant[]>()
  for (const [k, v] of Object.entries(grants)) map.set(k, v)
  return { grants: map }
}

test('S10-1 installMembrane 对对象服务装膜、原始值不包装、未注册回退默认膜', () => {
  const { entries, cb } = auditSink()
  const services = {
    sandbox: { mode: 'strict', setMode: () => {}, internal: { s: 1 } },
    helper: { mode: 'x' },
    plain: 42,
  }
  const ctx = {
    get: <T,>(key: string): T | undefined => services[key as keyof typeof services] as T,
  }
  const restore = installMembrane(ctx, new Map([['sandbox', SENSITIVE_SERVICE_MEMBRANES.get('sandbox')!]]), cb)

  // sandbox 走 SENSITIVE_MEMBRANE：写入/隐藏访问被拒
  const sandbox = ctx.get('sandbox')
  assert.throws(() => { (sandbox as { mode: string }).mode = 'full' }, (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'write-denied')
  assert.throws(() => { void (sandbox as { internal?: unknown }).internal }, (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'access-denied')

  // helper 未注册 → DEFAULT_MEMBRANE
  const helper = ctx.get('helper')
  assert.throws(() => { (helper as { mode: string }).mode = 'y' }, (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'write-denied')

  // 原始值不包装，原样返回
  assert.equal(ctx.get('plain'), 42)
  assert.equal(entries.length, 3)
  // 还原后不再拦截
  restore()
  assert.equal((ctx.get('sandbox') as { mode: string }).mode, 'strict')
})

test('S10-2 膜配置注册表：敏感/普通/合并解析', () => {
  const reg = buildMembraneRegistry()
  assert.equal(reg.get('sandbox'), SENSITIVE_SERVICE_MEMBRANES.get('sandbox'))
  assert.equal(resolveMembraneConfig('credentials'), SENSITIVE_SERVICE_MEMBRANES.get('credentials'))
  assert.equal(resolveMembraneConfig('未知服务'), DEFAULT_MEMBRANE)
  // 敏感覆盖普通
  const merged = buildMembraneRegistry(
    new Map([['custom', SENSITIVE_SERVICE_MEMBRANES.get('sandbox')!]]),
    new Map([['custom', DEFAULT_MEMBRANE]]),
  )
  assert.equal(merged.get('custom'), SENSITIVE_SERVICE_MEMBRANES.get('sandbox'))
})

test('S11-1 issueTokens：按计划为每个插件实例化令牌', () => {
  const plan = planWith({
    'plugin-a': [
      { service: 'fs', allowedMethods: ['read'], allowedProps: [], expiresAt: 0 },
      { service: 'sandbox', allowedMethods: [], allowedProps: [], expiresAt: 0 },
    ],
  })
  const { tokensByPlugin } = issueTokens(plan)
  const tokens = tokensByPlugin.get('plugin-a')!
  assert.equal(tokens.length, 2)
  assert.equal(tokens[0]!.service, 'fs')
  assert.ok(tokens[0]!.allowedMethods.has('read'))
  assert.equal(tokens[0]!.issuedTo, 'plugin-a')
  assert.equal(tokens[1]!.allowedMethods.size, 0)
})

test('S11-2 issueTokens：忠实执行计划（不二次过滤）、过期时间透传', () => {
  const plan = planWith({
    'sess-p': [{ service: 'fs', allowedMethods: ['read', 'write'], allowedProps: ['mode'], expiresAt: 123456 }],
    'host-p': [{ service: 'fs', allowedMethods: ['read'], allowedProps: [], expiresAt: 0 }],
  })
  const { tokensByPlugin } = issueTokens(plan)
  const sess = tokensByPlugin.get('sess-p')![0]!
  assert.equal(sess.expiresAt, 123456)
  assert.equal(sess.allowedMethods.size, 2)
  assert.equal(sess.allowedProps.size, 1)
  const host = tokensByPlugin.get('host-p')![0]!
  assert.equal(host.expiresAt, 0)
})