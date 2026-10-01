/**
 * S6 动态校验（挂载决策点四检查）——单元测试（SEC-2001–2004：每条正例 + 反例）。
 *
 * 阶段纪律：镜像阶段用 node:test + assert/strict（零测试框架依赖）；
 *       并入 dsh 仓库时按 A1/A2 全量回归 + A2/A7 对拍基准，与真实挂载编排对齐。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import {
  checkMissingDependency,
  checkDuplicateRegistration,
  checkIsolateViolation,
  checkServiceDeath,
  runDynamicValidation,
} from '../src/validators/dynamic.ts'

import type { DynamicValidationContext, DynamicDiagnostic } from '../src/validators/dynamic.ts'
import type { EffectiveNode } from '../src/resolver.ts'
import type { PluginContract } from '../src/contract.ts'

/** 便捷构造一个节点（缺省 host 平面、无 provides/needs 契约） */
function enode(id: string, overrides?: Partial<EffectiveNode>): EffectiveNode {
  return {
    id,
    name: overrides?.name ?? id,
    config: overrides?.config ?? {},
    disabled: overrides?.disabled ?? false,
    ...(overrides?.contract !== undefined ? { contract: overrides.contract } : {}),
    overrides: overrides?.overrides ?? [],
  }
}

/** 便捷构造契约（缺省 host / 无依赖 / 无能力） */
function contract(partial?: Partial<PluginContract>): PluginContract {
  return { provides: [], needs: [], optional: [], plane: 'host', isolate: false, ...partial }
}

/** 便捷构造动态校验上下文 */
function dctx(partial: Partial<DynamicValidationContext>): DynamicValidationContext {
  return {
    activeNodes: partial.activeNodes ?? new Set(),
    registeredServices: partial.registeredServices ?? new Set(),
    mountingNode: partial.mountingNode ?? enode('n'),
    mountedNodes: partial.mountedNodes ?? [],
    ...(partial.leavingNode !== undefined ? { leavingNode: partial.leavingNode } : {}),
  }
}

/* ---------- SEC-2001 missing-dependency ---------- */
test('SEC-2001 正例：needs 已在已注册服务集，不触发', () => {
  const mounting = enode('consumer', { contract: contract({ needs: ['store'] }) })
  const c = dctx({
    mountingNode: mounting,
    registeredServices: new Set(['store']),
    activeNodes: new Set(['provider']),
    mountedNodes: [enode('provider', { contract: contract({ provides: ['store'] }) })],
  })
  const r = runDynamicValidation(c)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-2001').length, 0)
})

test('SEC-2001 正例：needs 由挂载节点自身 provides 提供，不触发', () => {
  const mounting = enode('self', { contract: contract({ provides: ['store'], needs: ['store'] }) })
  const c = dctx({ mountingNode: mounting })
  const r = runDynamicValidation(c)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-2001').length, 0)
})

test('SEC-2001 反例：needs 未注册且非自身提供，触发 error 且给出结构化诊断', () => {
  const mounting = enode('consumer', { contract: contract({ needs: ['missing'] }) })
  const potentialProvider = enode('disabled-provider', {
    disabled: true,
    contract: contract({ provides: ['missing'] }),
  })
  const c = dctx({
    mountingNode: mounting,
    mountedNodes: [potentialProvider],
  })
  const hits = runDynamicValidation(c).diagnostics.filter(d => d.code === 'SEC-2001') as DynamicDiagnostic[]
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
  assert.equal(hits[0]!.kind, 'missing-dependency')
  assert.equal(hits[0]!.missingService, 'missing')
  assert.deepEqual(hits[0]!.consumers, ['consumer'])
  assert.equal(hits[0]!.potentialProviders?.[0]?.nodeId, 'disabled-provider')
  assert.equal(hits[0]!.potentialProviders?.[0]?.reason, 'disabled')
})

test('SEC-2001 potentialProviders：平面不匹配提供者标注 plane-mismatch，未挂载提供者标注 not-yet-mounted', () => {
  const mounting = enode('consumer', { contract: contract({ needs: ['store'], plane: 'host' }) })
  const crossPlane = enode('session-pro', { contract: contract({ provides: ['store'], plane: 'session' }) })
  const pending = enode('pending-pro', { contract: contract({ provides: ['store'], plane: 'host' }) })
  const c = dctx({
    mountingNode: mounting,
    mountedNodes: [crossPlane, pending],
  })
  const hits = checkMissingDependency(c)
  const reasons = hits[0]!.potentialProviders ?? []
  assert.ok(reasons.some(p => p.nodeId === 'session-pro' && p.reason === 'plane-mismatch'))
  assert.ok(reasons.some(p => p.nodeId === 'pending-pro' && p.reason === 'not-yet-mounted'))
})

/* ---------- SEC-2002 duplicate-registration ---------- */
test('SEC-2002 正例：挂载提供服务与已激活非 isolate 提供者不同，不触发', () => {
  const mounting = enode('mount-a', { contract: contract({ provides: ['store'] }) })
  const c = dctx({
    mountingNode: mounting,
    activeNodes: new Set(['p']),
    mountedNodes: [enode('p', { contract: contract({ provides: ['other'] }) })],
  })
  const r = runDynamicValidation(c)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-2002').length, 0)
})

test('SEC-2002 正例：isolate 提供者提供同服务不算冲突，不触发', () => {
  const mounting = enode('mount-a', { contract: contract({ provides: ['store'] }) })
  const c = dctx({
    mountingNode: mounting,
    activeNodes: new Set(['iso']),
    mountedNodes: [enode('iso', { contract: contract({ provides: ['store'], isolate: true }) })],
  })
  const r = runDynamicValidation(c)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-2002').length, 0)
})

test('SEC-2002 反例：挂载 provides 与已激活非 isolate 节点同服务，触发 error', () => {
  const mounting = enode('mount-a', { contract: contract({ provides: ['store'] }) })
  const c = dctx({
    mountingNode: mounting,
    activeNodes: new Set(['p']),
    mountedNodes: [enode('p', { contract: contract({ provides: ['store'] }) })],
  })
  const hits = checkDuplicateRegistration(c)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
  assert.equal(hits[0]!.code, 'SEC-2002')
  assert.equal(hits[0]!.kind, 'duplicate-registration')
  assert.match(hits[0]!.message, /store/)
})

/* ---------- SEC-2003 isolate-violation ---------- */
test('SEC-2003 正例：isolate 挂载提供服务，但无激活 host 消费者需要它，不触发', () => {
  const mounting = enode('iso', {
    contract: contract({ provides: ['store'], isolate: true, plane: 'session' }),
  })
  const c = dctx({
    mountingNode: mounting,
    activeNodes: new Set(['hostc']),
    mountedNodes: [enode('hostc', { contract: contract({ needs: ['other'], plane: 'host' }) })],
  })
  const r = runDynamicValidation(c)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-2003').length, 0)
})

test('SEC-2003 反例：isolate 挂载提供服务，遮蔽激活 host 消费者所需路由，触发 warning', () => {
  const mounting = enode('iso', {
    contract: contract({ provides: ['store'], isolate: true, plane: 'session' }),
  })
  const c = dctx({
    mountingNode: mounting,
    activeNodes: new Set(['hostc']),
    mountedNodes: [enode('hostc', { contract: contract({ needs: ['store'], plane: 'host' }) })],
  })
  const hits = checkIsolateViolation(c)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'warning')
  assert.equal(hits[0]!.code, 'SEC-2003')
  assert.equal(hits[0]!.kind, 'isolate-violation')
  assert.match(hits[0]!.message, /遮蔽/)
})

/* ---------- SEC-2004 service-death ---------- */
test('SEC-2004 正例：卸载节点提供的服务无激活消费者依赖，不触发', () => {
  const leaving = enode('leaving', { contract: contract({ provides: ['store'] }) })
  const hits = checkServiceDeath(leaving, new Set(['other']), [enode('other', { contract: contract({ needs: ['other'] }) })])
  assert.equal(hits.length, 0)
})

test('SEC-2004 反例：卸载节点提供的服务仍被激活节点依赖，触发 warning', () => {
  const leaving = enode('leaving', { contract: contract({ provides: ['store'] }) })
  const consumer = enode('consumer', { contract: contract({ needs: ['store'] }) })
  const hits = checkServiceDeath(leaving, new Set(['consumer']), [consumer])
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'warning')
  assert.equal(hits[0]!.code, 'SEC-2004')
  assert.equal(hits[0]!.kind, 'service-death')
  assert.deepEqual(hits[0]!.consumers, ['consumer'])
})

test('SEC-2004 经 runDynamicValidation 可选触发：ctx.leavingNode 提供时纳入汇总', () => {
  const mounting = enode('mount', { contract: contract({ needs: [] }) })
  const leaving = enode('leaving', { contract: contract({ provides: ['store'] }) })
  const consumer = enode('consumer', { contract: contract({ needs: ['store'] }) })
  const c = dctx({
    mountingNode: mounting,
    leavingNode: leaving,
    activeNodes: new Set(['consumer']),
    mountedNodes: [consumer],
  })
  const r = runDynamicValidation(c)
  const hits = r.diagnostics.filter(d => d.code === 'SEC-2004')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'warning')
})

/* ---------- 汇总：runDynamicValidation 同时产出多码位，severity 档位对齐 ---------- */
test('runDynamicValidation 汇总：缺失依赖 error + isolate 遮蔽 warning 混列', () => {
  const mounting = enode('iso-consumer', {
    contract: contract({ provides: ['iso-svc'], needs: ['missing'], isolate: true, plane: 'session' }),
  })
  const hostc = enode('hostc', { contract: contract({ needs: ['iso-svc'], plane: 'host' }) })
  const c = dctx({
    mountingNode: mounting,
    activeNodes: new Set(['hostc']),
    mountedNodes: [hostc],
  })
  const r = runDynamicValidation(c)
  const codes = new Set(r.diagnostics.map(d => d.code))
  assert.ok(codes.has('SEC-2001'))
  assert.ok(codes.has('SEC-2003'))
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-2001')[0]!.severity, 'error')
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-2003')[0]!.severity, 'warning')
})