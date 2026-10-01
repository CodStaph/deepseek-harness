/**
 * S11（能力令牌预颁发计划）装配层测试。
 * 覆盖：filterAllowedMethods（严格/lenient、声明子面精确放行）、buildCapabilityGrantPlan
 *       （按 needs 颁发、session 过期、lenient 点名）。
 * 并入 dsh 仓库时转为 vitest describe/it 形态（镜像阶段用 node:test）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import {
  buildCapabilityGrantPlan,
  filterAllowedMethods,
  SESSION_TIMEOUT_MS,
} from '../src/index.ts'

import type { EffectiveNode } from '../src/index.ts'
import type { CapabilityDeclaration } from '../src/index.ts'

/** 构造有效配置节点（补全必填字段） */
function node(id: string, contract: {
  plane: 'host' | 'preset' | 'session'
  needs: string[]
  capabilities?: CapabilityDeclaration
}): EffectiveNode {
  return {
    id,
    name: id,
    config: {},
    disabled: false,
    contract: {
      provides: [],
      needs: contract.needs,
      optional: [],
      plane: contract.plane,
      isolate: false,
      ...(contract.capabilities ? { capabilities: contract.capabilities } : {}),
    },
    overrides: [],
  }
}

test('S11-A1 filterAllowedMethods：严格未声明能力→空；lenient→全量', () => {
  const methods = ['read', 'write', 'fetch']
  assert.deepEqual(filterAllowedMethods(methods, undefined), { methods: [], props: [] })
  assert.deepEqual(filterAllowedMethods(methods, undefined, { lenientCapabilities: true }), { methods: [...methods], props: [] })
})

test('S11-A2 filterAllowedMethods：按声明子面精确放行（fs.read 不放行 write）', () => {
  const methods = ['read', 'stat', 'write', 'fetch', 'spawn']
  const caps: CapabilityDeclaration = { fs: { read: ['/**'] }, network: { allow: ['*'] } }
  const { methods: allowed } = filterAllowedMethods(methods, caps)
  assert.deepEqual([...allowed].sort(), ['fetch', 'read'].sort())
  const caps2: CapabilityDeclaration = { fs: { write: ['/tmp/**'] } }
  assert.deepEqual([...filterAllowedMethods(methods, caps2).methods], ['write'])
})

test('S11-A3 buildCapabilityGrantPlan：按 needs 颁发、过滤能力、session 过期、lenient 点名', () => {
  const nodes: EffectiveNode[] = [
    node('plugin-a', { plane: 'host', needs: ['sandbox', 'fs'], capabilities: { fs: { read: ['*'] } } }),
    node('sess-p', { plane: 'session', needs: ['fs'], capabilities: { fs: { read: ['*'] } } }),
    node('legacy-p', { plane: 'host', needs: ['fs'] }), // 未声明 capabilities
  ]
  const reg = new Map([
    ['sandbox', ['check', 'setMode']],
    ['fs', ['read', 'write']],
  ])

  // 严格模式
  const strict = buildCapabilityGrantPlan(nodes, { serviceMethodsRegistry: reg })
  const strictA = strict.plan.grants.get('plugin-a')!
  assert.equal(strictA.length, 2)
  const fsG = strictA.find((g) => g.service === 'fs')!
  assert.deepEqual(fsG.allowedMethods, ['read']) // write 未声明不放行
  assert.equal(strictA.find((g) => g.service === 'sandbox')!.allowedMethods.length, 0)
  const legacyStrict = strict.plan.grants.get('legacy-p')![0]!
  assert.equal(legacyStrict.allowedMethods.length, 0)
  assert.deepEqual(strict.lenientFallbacks, [])

  // session 过期
  const sessG = strict.plan.grants.get('sess-p')![0]!
  assert.ok(sessG.expiresAt > 0 && sessG.expiresAt <= Date.now() + SESSION_TIMEOUT_MS)
  assert.equal(fsG.expiresAt, 0)

  // lenient 模式
  const lenient = buildCapabilityGrantPlan(nodes, { serviceMethodsRegistry: reg, lenientCapabilities: true })
  assert.deepEqual(lenient.plan.grants.get('legacy-p')![0]!.allowedMethods, ['read', 'write'])
  assert.deepEqual(lenient.lenientFallbacks, ['legacy-p'])
})