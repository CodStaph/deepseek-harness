/**
 * S2 有效配置展开器测试（镜像阶段用 node:test + node:assert/strict；并入 dsh 转 vitest）。
 * 覆盖：信任等级排序、同 id 深合并 + 覆盖历史、disabled 表达式注入求值、
 *       敏感覆盖注入路径拒绝、装配图结构 + 环检测、diff 输出。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import {
  expandLayers,
  diffLayers,
  buildCompositionGraph,
  SensitiveOverrideError,
} from '../src/resolver.ts'
import type {
  CompositionLayer,
  EffectiveNode,
  ExpressionNode,
  ExpandOptions,
} from '../src/resolver.ts'

/** 便捷构造：单 id 单配置的层 */
function layer(
  id: string,
  trustLevel: CompositionLayer['trustLevel'],
  config?: Record<string, unknown>,
  extra: Partial<CompositionLayer> = {},
): CompositionLayer {
  return {
    id,
    file: `${id}.json`,
    trustLevel,
    entries: [{ id: 'svc', name: 'svc', ...(config !== undefined ? { config } : {}) }],
    ...extra,
  }
}

test('S2-1 信任等级排序：trusted 覆盖 user/preset/patch', () => {
  const layers = [
    layer('l-trusted', 'trusted', { mode: 'trusted-mode', level: 't' }),
    layer('l-patch', 'patch', { mode: 'patch-mode', extra: 1 }),
    layer('l-user', 'user', { mode: 'user-mode' }),
    layer('l-preset', 'preset', { preset: true }),
  ]
  const [node] = expandLayers(layers)
  // trusted 最后覆盖 → 生效
  assert.equal(node!.config.mode, 'trusted-mode')
  assert.equal(node!.config.level, 't')
  // 覆盖历史：preset/user/trusted 各覆盖过一次（patch 为基座）
  assert.deepEqual(
    node!.overrides.map((o) => o.layer),
    ['l-preset', 'l-user', 'l-trusted'],
  )
})

test('S2-2 同 id 深合并 + 覆盖历史记录真实变更字段', () => {
  const layers: CompositionLayer[] = [
    {
      id: 'base',
      file: 'a.json',
      trustLevel: 'preset',
      entries: [{ id: 'svc', name: 'svc', config: { x: { b: 1, c: 2 }, keep: 'k' } }],
    },
    {
      id: 'user',
      file: 'b.json',
      trustLevel: 'user',
      entries: [{ id: 'svc', name: 'svc', config: { x: { b: 9 }, arr: [1, 2] } }],
    },
  ]
  const [node] = expandLayers(layers)
  // 深合并：x.b 被覆盖、x.c 保留、keep 保留、arr 新增
  assert.deepEqual(node!.config, { x: { b: 9, c: 2 }, keep: 'k', arr: [1, 2] })
  assert.equal(node!.overrides.length, 1)
  assert.equal(node!.overrides[0]!.layer, 'user')
  assert.ok(node!.overrides[0]!.changedFields.includes('x.b'))
  assert.ok(node!.overrides[0]!.changedFields.includes('arr'))
  assert.ok(!node!.overrides[0]!.changedFields.includes('x.c')) // 未变更字段不记
  assert.ok(node!.overrides[0]!.previousValue!.includes('1')) // 旧值摘要
})

test('S2-2b diffLayers 输出层间覆盖变更条目', () => {
  const layers: CompositionLayer[] = [
    {
      id: 'base',
      file: 'a.json',
      trustLevel: 'preset',
      entries: [{ id: 'svc', name: 'svc', config: { a: 1 } }],
    },
    {
      id: 'user',
      file: 'b.json',
      trustLevel: 'user',
      entries: [{ id: 'svc', name: 'svc', config: { a: 2 } }],
    },
  ]
  const diff = diffLayers(layers)
  assert.equal(diff.length, 1)
  assert.equal(diff[0]!.nodeId, 'svc')
  assert.deepEqual(diff[0]!.changedFields, ['a'])
})

test('S2-3 disabled 表达式通过注入回调求值', () => {
  const expr: ExpressionNode = { source: "ctx.get('flag')" }
  const layers: CompositionLayer[] = [
    { id: 'base', file: 'a.json', trustLevel: 'preset', entries: [{ id: 'svc', name: 'svc', disabled: expr }] },
  ]
  const options: ExpandOptions = { evaluateDisabled: (e) => e.source === "ctx.get('flag')" }
  const [node] = expandLayers(layers, options)
  assert.equal(node!.disabled, true) // 表达式被求值为布尔
})

test('S2-3b 无求值回调时表达式节点抛未实现（不假实现）', () => {
  const layers: CompositionLayer[] = [
    { id: 'base', file: 'a.json', trustLevel: 'preset', entries: [{ id: 'svc', name: 'svc', disabled: { source: 'x' } }] },
  ]
  assert.throws(() => expandLayers(layers), /未实现.*S4/)
})

test('S2-4 敏感覆盖注入路径时低信任覆盖被拒绝', () => {
  // user 覆盖（rank2 < minTrust trusted rank3）→ 拒绝
  const layers: CompositionLayer[] = [
    { id: 'patch', file: 'p.json', trustLevel: 'patch', entries: [{ id: 'sandbox-policy', name: 'sp', config: { mode: 'strict' } }] },
    { id: 'user', file: 'u.json', trustLevel: 'user', entries: [{ id: 'sandbox-policy', name: 'sp', config: { mode: 'danger' } }] },
  ]
  const opts: ExpandOptions = { sensitivePaths: [{ rowId: 'sandbox-policy', field: 'mode', minTrust: 'trusted' }] }
  assert.throws(() => expandLayers(layers, opts), SensitiveOverrideError)

  // 同一条路径由 trusted（rank3 = minTrust trusted）覆盖 → 放行
  const allowed: CompositionLayer[] = [
    { id: 'p', file: 'p.json', trustLevel: 'patch', entries: [{ id: 'sandbox-policy', name: 'sp', config: { mode: 'strict' } }] },
    { id: 't', file: 't.json', trustLevel: 'trusted', entries: [{ id: 'sandbox-policy', name: 'sp', config: { mode: 'safe' } }] },
  ]
  const [n2] = expandLayers(allowed, opts)
  assert.equal(n2!.config.mode, 'safe')
})

test('S2-5 buildCompositionGraph 基本结构 + 环检测', () => {
  const mk = (id: string, provides: string[], needs: string[]): EffectiveNode => ({
    id,
    name: id,
    config: {},
    disabled: false,
    contract: { provides, needs, optional: [], plane: 'host', isolate: false },
    overrides: [],
  })

  // 无环：a 依赖 b
  const a = mk('a', ['a-svc'], ['b-svc'])
  const b = mk('b', ['b-svc'], [])
  const g = buildCompositionGraph([a, b])
  assert.equal(g.hasCycle, false)
  assert.equal(g.edges.length, 1)
  assert.equal(g.edges[0]!.from, 'a')
  assert.equal(g.edges[0]!.to, 'b')
  assert.equal(g.edges[0]!.kind, 'hard')

  // 环：a 依赖 b、b 依赖 a
  const a2 = mk('a', ['a-svc'], ['b-svc'])
  const b2 = mk('b', ['b-svc'], ['a-svc'])
  assert.equal(buildCompositionGraph([a2, b2]).hasCycle, true)

  // 孤立服务
  const c = mk('c', [], [])
  const g3 = buildCompositionGraph([a, b, c])
  assert.deepEqual(g3.orphans, ['c'])
})