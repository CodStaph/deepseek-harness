/**
 * S23 互指键载体测试：AssemblyPlan.planId 生成 + 装配/效果两本账互指锚点。
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.11.4（审计台账互指键，A6 移植）。
 * 覆盖：
 * - makePlanId：稳定生成装配计划唯一标识（R41 对账锚点）
 * - dryRun / assemble 产出的 AssemblyPlan 携带 planId
 * - planId 可在 effect 审计侧用作 assemblyPlanId（互指对账雏形）
 * 测试映射：R41（审计互指键：效果审计可按 assemblyPlanId 对账）。
 * 并入 dsh 后以 vitest 运行（批次 1-2 迁移）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AssemblyController } from '../src/index.ts'
import { makePlanId } from '../src/plan.ts'

/** 写一个 JSON 覆盖链层文件 */
function writeLayer(dir: string, name: string, body: unknown): string {
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify(body, null, 2), 'utf8')
  return file
}

const VALID_LAYER = {
  id: 'base',
  trustLevel: 'trusted',
  entries: [
    {
      id: 'store',
      name: 'store-provider',
      contract: { provides: ['store'], needs: [], optional: [], plane: 'host', isolate: false, capabilities: {} },
    },
  ],
}

test('S23-planId-1 makePlanId：生成 plan- 前缀 + 时间摘要格式（互指键锚点）', () => {
  const id = makePlanId('2026-10-01T08:00:00.000Z')
  assert.match(id, /^plan-/)
  // 时间戳冒号/点被压平，仍保留日期分段
  assert.ok(id.includes('2026-10-01T08'), '应含时间摘要')
  assert.ok(!id.includes(':'), '不应含冒号（文件名安全）')
})

test('S23-planId-2 dryRun 产出的 AssemblyPlan 携带 planId（R41 锚点就绪）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-s23-'))
  try {
    const file = writeLayer(dir, 'valid.json', VALID_LAYER)
    const plan = await new AssemblyController({}).dryRun({ sources: [file] })
    assert.ok(plan.planId, 'AssemblyPlan 应携带 planId')
    assert.match(plan.planId!, /^plan-/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S23-planId-3 assemble 产出的 AssemblyPlan 携带 planId（装配→效果互指链路）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-s23-'))
  try {
    const file = writeLayer(dir, 'valid.json', VALID_LAYER)
    const out = await new AssemblyController({}).assemble({ sources: [file] })
    assert.equal(out.status, 'success')
    assert.ok(out.plan.planId, 'assemble 的 plan 应携带 planId')
    // 效果审计侧 assemblyPlanId 可回填此值（互指对账锚点，§5.11.4）
    const effectEntryAnchor = out.plan.planId
    assert.equal(typeof effectEntryAnchor, 'string')
    assert.match(effectEntryAnchor, /^plan-/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})