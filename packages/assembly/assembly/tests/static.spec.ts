/**
 * S3 静态校验规则迁移——单元测试（13 条全覆盖：每条一个正例 + 一个反例）。
 *
 * 阶段纪律：镜像阶段用 node:test + assert/strict（零测试框架依赖）；
 *       并入 dsh 仓库时按 A1/A2 全量回归 + A2/A7 对拍基准，与真实 verify-cordis-config.ts 对齐。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import {
  staticRules,
  runStaticValidation,
} from '../src/validators/static.ts'
import { SENSITIVE_PATHS } from '../src/security/sensitive.ts'

import type { StaticValidationContext } from '../src/validators/static.ts'
import type { EffectiveNode } from '../src/resolver.ts'
import type { CompositionGraph, GraphNode, GraphEdge } from '../src/plan.ts'
import type { PluginContract } from '../src/contract.ts'

/** 便捷构造一个节点（缺省 host 平面、无能力、无依赖的契约） */
function node(id: string, overrides?: Partial<EffectiveNode>): EffectiveNode {
  return {
    id,
    name: overrides?.name ?? id,
    config: overrides?.config ?? {},
    disabled: overrides?.disabled ?? false,
    ...(overrides?.contract !== undefined ? { contract: overrides.contract } : {}),
    overrides: overrides?.overrides ?? [],
  }
}

/** 便捷构造装配图节点 */
function gn(partial: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    plane: 'host',
    provides: [],
    needs: [],
    optional: [],
    isolate: false,
    ...partial,
  }
}

/** 便捷构造装配图边 */
function ge(partial: Partial<GraphEdge> & { from: string; to: string }): GraphEdge {
  return { service: partial.service ?? 'svc', kind: 'hard', ...partial }
}

function graph(nodes: GraphNode[], edges: GraphEdge[] = [], extra?: Partial<CompositionGraph>): CompositionGraph {
  return {
    nodes,
    edges,
    hasCycle: extra?.hasCycle ?? false,
    orphans: extra?.orphans ?? [],
  }
}

/** 默认契约（host / 无依赖 / 无能力） */
function baseContract(): PluginContract {
  return { provides: [], needs: [], optional: [], plane: 'host', isolate: false }
}

/* ---------- SEC-1001 unknown-plugin ---------- */
test('SEC-1001 正例：节点包名在已声明依赖内，不触发', () => {
  const nodes = [node('a', { name: '@pkg/alpha' })]
  const ctx: StaticValidationContext = { declaredDependencies: new Set(['@pkg/alpha']) }
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]), ctx)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1001').length, 0)
})
test('SEC-1001 反例：引用未声明包，触发 error 且 code 正确', () => {
  const nodes = [node('a', { name: '@pkg/ghost' })]
  const ctx: StaticValidationContext = { declaredDependencies: new Set(['@pkg/alpha']) }
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]), ctx)
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1001')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
  assert.match(hits[0]!.message, /@pkg\/ghost/)
})

/* ---------- SEC-1002 metadata-expression ---------- */
test('SEC-1002 正例：元数据字段无 !!js 表达式，不触发', () => {
  const nodes = [node('a', { config: { group: 'main' } })]
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]))
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1002').length, 0)
})
test('SEC-1002 反例：元数据字段含 !!js 表达式，触发 error', () => {
  const nodes = [node('a', { config: { group: { __jsExpr: 'ctx.env.PROD' } } })]
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]))
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1002')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
  assert.match(hits[0]!.fieldPath ?? '', /group/)
})

/* ---------- SEC-1003 disabled-parse ---------- */
test('SEC-1003 正例：disabled 表达式可编译，不触发', () => {
  const nodes = [node('a', { disabled: { source: 'ctx.env.PROD === "1"' } })]
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]))
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1003').length, 0)
})
test('SEC-1003 反例：disabled 表达式语法错误，触发 error', () => {
  const nodes = [node('a', { disabled: { source: 'ctx.env. ===' } })]
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]))
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1003')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
  assert.match(hits[0]!.message, /disabled 表达式语法错误/)
})

/* ---------- SEC-1004 preset-plane-separation ---------- */
test('SEC-1004 正例：行只属一个平面，不触发', () => {
  const g = graph([gn({ id: 'a', plane: 'host' }), gn({ id: 'b', plane: 'preset' })])
  const r = runStaticValidation([], g)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1004').length, 0)
})
test('SEC-1004 反例：同一行同时存在于 host 与 preset，触发 error', () => {
  const g = graph([gn({ id: 'a', plane: 'host' }), gn({ id: 'a', plane: 'preset' })])
  const r = runStaticValidation([], g)
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1004')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
})

/* ---------- SEC-1005 client-half-declared ---------- */
test('SEC-1005 正例：client 半片声明一致，不触发', () => {
  const nodes = [node('a', { config: { shipsClientHalf: true, declaresClient: true } })]
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]))
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1005').length, 0)
})
test('SEC-1005 反例：导出 ./client 但未声明 dsh.client，触发 error', () => {
  const nodes = [node('a', { config: { shipsClientHalf: true, declaresClient: false } })]
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]))
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1005')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
  assert.match(hits[0]!.message, /dsh\.client/)
})

/* ---------- SEC-1006 source-plane-resolution ---------- */
test('SEC-1006 正例：源解析到 .ts 源文件，不触发', () => {
  const nodes = [node('a', { config: { sourceFile: 'src/index.ts' } })]
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]))
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1006').length, 0)
})
test('SEC-1006 反例：命中 built lib/ 产物平面，触发 error', () => {
  const nodes = [node('a', { config: { sourceFile: 'lib/index.js' } })]
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]))
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1006')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
})

/* ---------- SEC-1007 fixture-module-dependency ---------- */
test('SEC-1007 正例：fixture import 落在 owner 依赖内，不触发', () => {
  const nodes = [node('a', { config: { fixtureImports: ['@pkg/util'], ownerDependencies: ['@pkg/util'] } })]
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]))
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1007').length, 0)
})
test('SEC-1007 反例：fixture import 未声明在 owner 依赖，触发 error', () => {
  const nodes = [node('a', { config: { fixtureImports: ['@pkg/ghost'], ownerDependencies: ['@pkg/util'] } })]
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]))
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1007')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
  assert.match(hits[0]!.message, /@pkg\/ghost/)
})

/* ---------- SEC-1008 inject-closure ---------- */
test('SEC-1008 正例：注入依赖在装配图有提供者，不触发', () => {
  const nodes = [node('consumer', { contract: { ...baseContract(), needs: ['store'] } })]
  const g = graph([gn({ id: 'consumer', needs: ['store'] }), gn({ id: 'provider', provides: ['store'] })])
  const r = runStaticValidation(nodes, g)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1008').length, 0)
})
test('SEC-1008 反例：注入依赖无提供者，触发 error', () => {
  const nodes = [node('consumer', { contract: { ...baseContract(), needs: ['missing'] } })]
  const g = graph([gn({ id: 'consumer', needs: ['missing'] }), gn({ id: 'provider', provides: ['other'] })])
  const r = runStaticValidation(nodes, g)
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1008')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
  assert.match(hits[0]!.message, /missing/)
})

/* ---------- SEC-1009 duplicate-mount ---------- */
test('SEC-1009 正例：同一服务仅一个非 isolate 提供者，不触发', () => {
  const g = graph([gn({ id: 'p1', plane: 'host', provides: ['store'] }), gn({ id: 'p2', plane: 'host', provides: ['other'] })])
  const r = runStaticValidation([], g)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1009').length, 0)
})
test('SEC-1009 反例：同平面两非 isolate 提供同一服务，触发 error', () => {
  const g = graph([gn({ id: 'p1', plane: 'host', provides: ['store'] }), gn({ id: 'p2', plane: 'host', provides: ['store'] })])
  const r = runStaticValidation([], g)
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1009')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
  assert.match(hits[0]!.message, /store/)
})

/* ---------- SEC-1010 cycle-detection ---------- */
test('SEC-1010 正例：无环图不触发', () => {
  const g = graph(
    [gn({ id: 'a', provides: ['x'] }), gn({ id: 'b', needs: ['x'] })],
    [ge({ from: 'a', to: 'b', service: 'x' })],
  )
  const r = runStaticValidation([], g)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1010').length, 0)
})
test('SEC-1010 反例：依赖图存在环，触发 error', () => {
  const g = graph(
    [gn({ id: 'a' }), gn({ id: 'b' }), gn({ id: 'c' })],
    [
      ge({ from: 'a', to: 'b', service: 's1' }),
      ge({ from: 'b', to: 'c', service: 's2' }),
      ge({ from: 'c', to: 'a', service: 's3' }),
    ],
  )
  const r = runStaticValidation([], g)
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1010')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
  assert.match(hits[0]!.message, /环/)
})

/* ---------- SEC-1011 orphan-service ---------- */
test('SEC-1011 正例：提供的服务有消费者，不触发', () => {
  const g = graph(
    [gn({ id: 'p', provides: ['store'] }), gn({ id: 'c', needs: ['store'] })],
    [ge({ from: 'p', to: 'c', service: 'store' })],
  )
  const r = runStaticValidation([], g)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1011').length, 0)
})
test('SEC-1011 反例：提供服务但无消费者，触发 warning（severity 必须是 warning）', () => {
  const g = graph([gn({ id: 'p', provides: ['lonely'] })])
  const r = runStaticValidation([], g)
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1011')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'warning')
  assert.match(hits[0]!.message, /lonely/)
})

/* ---------- SEC-1012 isolate-shadow ---------- */
test('SEC-1012 正例：isolate 提供服务但 host 无消费者，不触发', () => {
  const g = graph([gn({ id: 'iso', isolate: true, plane: 'session', provides: ['store'] })])
  const r = runStaticValidation([], g)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1012').length, 0)
})
test('SEC-1012 反例：isolate provider 遮蔽 host 消费者所需路由，触发 warning', () => {
  const g = graph([
    gn({ id: 'iso', isolate: true, plane: 'session', provides: ['store'] }),
    gn({ id: 'hostc', plane: 'host', needs: ['store'] }),
  ])
  const r = runStaticValidation([], g)
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1012')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'warning')
  assert.match(hits[0]!.message, /遮蔽/)
})

/* ---------- SEC-1013 sensitive-override（复用 security/sensitive.ts 唯一实现） ---------- */
test('SEC-1013 正例：敏感字段（sandbox-policy.mode）由 trusted 层覆盖，不触发', () => {
  const nodes = [node('sandbox-policy', {
    config: { mode: 'standard' },
    overrides: [{ layer: 'base', file: 'base.yml', changedFields: ['mode'] }],
  })]
  const ctx: StaticValidationContext = { layerTrust: { base: 'trusted' } }
  const r = runStaticValidation(nodes, graph([gn({ id: 'sandbox-policy' })]), ctx)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1013').length, 0)
})
test('SEC-1013 反例：sandbox-policy.mode 被 patch 层覆盖，触发 error（minTrust=trusted）', () => {
  assert.ok(SENSITIVE_PATHS.some(p => p.rowId === 'sandbox-policy' && p.field === 'mode' && p.minTrust === 'trusted'))
  const nodes = [node('sandbox-policy', {
    config: { mode: 'danger-full-access' },
    overrides: [{ layer: 'hotfix', file: 'patch.yml', changedFields: ['mode'] }],
  })]
  const ctx: StaticValidationContext = { layerTrust: { hotfix: 'patch' } }
  const r = runStaticValidation(nodes, graph([gn({ id: 'sandbox-policy' })]), ctx)
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1013')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
  assert.match(hits[0]!.message, /mode/)
  assert.equal(hits[0]!.nodeId, 'sandbox-policy')
})

/* ---------- SEC-1014 capability-overclaim ---------- */
test('SEC-1014 正例：声明能力未超信任上限，不触发', () => {
  const nodes = [node('a', { contract: { ...baseContract(), capabilities: { fs: {} } } })]
  const ctx: StaticValidationContext = { nodeTrust: { a: 'patch' } }
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]), ctx)
  assert.equal(r.diagnostics.filter(d => d.code === 'SEC-1014').length, 0)
})
test('SEC-1014 反例：声明能力超出信任等级上限，触发 error', () => {
  const nodes = [node('a', { contract: { ...baseContract(), capabilities: { process: { allow: ['ls'] } } } })]
  const ctx: StaticValidationContext = { nodeTrust: { a: 'patch' } }
  const r = runStaticValidation(nodes, graph([gn({ id: 'a' })]), ctx)
  const hits = r.diagnostics.filter(d => d.code === 'SEC-1014')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.severity, 'error')
  assert.match(hits[0]!.message, /process/)
})

/* ---------- 汇总：14 条齐备（方案 §4.2.1 表 13 条 + M0 补登 SEC-1007）、码位唯一且按 SEC 序 ---------- */
test('staticRules 恰为 14 条，SEC 码位唯一且按序', () => {
  const expected = [
    'SEC-1001', 'SEC-1002', 'SEC-1003', 'SEC-1004', 'SEC-1005',
    'SEC-1006', 'SEC-1007', 'SEC-1008', 'SEC-1009', 'SEC-1010',
    'SEC-1011', 'SEC-1012', 'SEC-1013', 'SEC-1014',
  ]
  assert.equal(staticRules.length, 14)
  assert.equal(new Set(staticRules.map(r => r.id)).size, 14)
  assert.deepEqual(staticRules.map(r => r.id), expected)
})