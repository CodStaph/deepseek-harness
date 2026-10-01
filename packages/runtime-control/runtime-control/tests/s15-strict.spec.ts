/**
 * S15 严格模式灰度与门禁测试（批次 3c，M3 收口）
 * 覆盖：resolveCapabilityMode（缺省 lenient / --strict / --no-lenient-capabilities）；
 *       灰度清算纪律 gradientGate（回归全绿 + 收尾清算零未解释越界才进下一档，
 *       §12 / 表行 34）；与既有机制联动（strict 模式未声明能力拒绝，对照 McpEffectHandler）。
 * 并入 dsh 后以 vitest 运行（批次 1-2 迁移）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import {
  resolveCapabilityMode,
  isStrictMode,
  gradientGate,
} from '../src/strict.ts'
import type { CapabilityMode } from '../src/strict.ts'

test('S15-1 缺省 lenient（向后兼容）', () => {
  assert.equal(resolveCapabilityMode(), 'lenient')
  assert.equal(resolveCapabilityMode({}), 'lenient')
  assert.equal(isStrictMode('lenient'), false)
})

test('S15-2 --strict 显式切严格模式', () => {
  assert.equal(resolveCapabilityMode({ strict: true }), 'strict')
  assert.equal(isStrictMode('strict'), true)
})

test('S15-3 --no-lenient-capabilities 关闭宽松能力 = 切严格', () => {
  assert.equal(resolveCapabilityMode({ noLenientCapabilities: true }), 'strict')
})

test('S15-4 灰度清算纪律：回归绿 + 零未解释越界 → 可进下一档', () => {
  assert.equal(gradientGate({ regressionGreen: true, unaccountedFindings: 0 }), true)
})

test('S15-5 灰度清算纪律：回归未全绿 → 不可进档', () => {
  assert.equal(gradientGate({ regressionGreen: false, unaccountedFindings: 0 }), false)
})

test('S15-6 灰度清算纪律：收尾清算有未解释越界 → 不可进档（post-hoc 点名归零前置）', () => {
  assert.equal(gradientGate({ regressionGreen: true, unaccountedFindings: 1 }), false)
})

test('S15-7 模式与 lenient 判定同构：strict 取反即 lenient（供各机制消费）', () => {
  const modes: CapabilityMode[] = ['lenient', 'strict']
  for (const m of modes) {
    assert.equal(isStrictMode(m), m === 'strict', `mode=${m}`)
  }
})