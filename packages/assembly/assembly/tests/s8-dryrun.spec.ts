/**
 * S8 verify-* 收敛——`AssemblyController.dryRun` 真实装配管线 + CLI `--dry-run` 编排（批次 1d）。
 *
 * 验收映射：
 * - A2（--dry-run 检出所有 verify 能检出的错误）：合法输入 → success + 空 error；
 *   重复注册（SEC-2002）/ 缺失依赖（SEC-2001）→ 检出对应诊断 + status 非 success。
 * - A7（退出码一致：有 error 非 0）：`run(['--dry-run', 错误文件])` 输出含 error，
 *   且纯函数 `dryRunExitCode(plan)` 对非 success 计划返回 1（不真跑进程退出）。
 *
 * 纪律：镜像阶段用 node:test + assert/strict（零测试框架依赖）；层文件用 JSON
 *       （对齐 loadLayers 期望结构：id/trustLevel/entries[id/name/contract]），
 *       写临时目录，finally 清理。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AssemblyController } from '../src/index.ts'
import { run, formatDryRunPlan, dryRunExitCode, planStatus } from '../src/cli.ts'

import type { AssemblyPlan } from '../src/plan.ts'

/** 写一个 JSON 覆盖链层文件，返回绝对路径 */
function writeLayer(dir: string, name: string, body: unknown): string {
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify(body, null, 2), 'utf8')
  return file
}

/** 合法层：provider 提供 store，consumer 依赖 store（host 平面，无能力） */
const VALID_LAYER = {
  id: 'base',
  trustLevel: 'trusted',
  entries: [
    {
      id: 'store',
      name: 'store-provider',
      contract: { provides: ['store'], needs: [], optional: [], plane: 'host', isolate: false, capabilities: {} },
    },
    {
      id: 'app',
      name: 'app-consumer',
      contract: { provides: [], needs: ['store'], optional: [], plane: 'host', isolate: false, capabilities: {} },
    },
  ],
}

/** 重复注册层：两个非 isolate 节点提供同一服务 dup → SEC-2002（动态）+ SEC-1009（静态） */
const DUPLICATE_LAYER = {
  id: 'dup',
  trustLevel: 'trusted',
  entries: [
    { id: 'a', name: 'a', contract: { provides: ['dup'], needs: [], optional: [], plane: 'host', isolate: false } },
    { id: 'b', name: 'b', contract: { provides: ['dup'], needs: [], optional: [], plane: 'host', isolate: false } },
  ],
}

/** 缺失依赖层：节点 c 需要 ghost，无任何提供者 → SEC-2001（动态）+ SEC-1008（静态） */
const MISSING_LAYER = {
  id: 'missing',
  trustLevel: 'trusted',
  entries: [
    {
      id: 'c',
      name: 'c',
      contract: { provides: [], needs: ['ghost'], optional: [], plane: 'host', isolate: false, capabilities: {} },
    },
  ],
}

test('S8 合法输入 → dryRun 返回 success + 空 error（A2 检出面）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-s8-'))
  try {
    const file = writeLayer(dir, 'valid.json', VALID_LAYER)
    const controller = new AssemblyController({})
    const plan = await controller.dryRun({ sources: [file] })
    assert.equal(planStatus(plan), 'success')
    assert.equal(dryRunExitCode(plan), 0)
    const errors = plan.validation.diagnostics.filter((d) => d.severity === 'error')
    assert.equal(errors.length, 0)
    assert.equal(plan.nodes.length, 2)
    assert.ok(plan.capabilities.grants.size >= 0)
    assert.ok(plan.timestamp)
    assert.equal(plan.layers.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S8 重复注册输入 → dryRun 检出 SEC-2002 + status 非 success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-s8-'))
  try {
    const file = writeLayer(dir, 'dup.json', DUPLICATE_LAYER)
    const plan = await new AssemblyController({}).dryRun({ sources: [file] })
    assert.equal(planStatus(plan), 'validation-error')
    assert.equal(dryRunExitCode(plan), 1)
    const codes = new Set(plan.validation.diagnostics.map((d) => d.code))
    assert.ok(codes.has('SEC-2002'), '应检出动态重复注册 SEC-2002')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S8 缺失依赖输入 → dryRun 检出 SEC-2001 + status 非 success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-s8-'))
  try {
    const file = writeLayer(dir, 'missing.json', MISSING_LAYER)
    const plan = await new AssemblyController({}).dryRun({ sources: [file] })
    assert.equal(dryRunExitCode(plan), 1)
    const codes = new Set(plan.validation.diagnostics.map((d) => d.code))
    assert.ok(codes.has('SEC-2001'), '应检出动态缺失依赖 SEC-2001')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S8 CLI 层：run([--dry-run, 合法文件]) 输出含 SUCCESS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-s8-'))
  try {
    const file = writeLayer(dir, 'valid.json', VALID_LAYER)
    const out = run(['--dry-run', file])
    assert.match(out, /SUCCESS/)
    assert.match(out, /校验 error/)
    assert.match(out, /安全 error/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S8 CLI 层：run([--dry-run, 错误文件]) 输出含 error，且 dryRunExitCode=1（A7）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-s8-'))
  try {
    const file = writeLayer(dir, 'dup.json', DUPLICATE_LAYER)
    const out = run(['--dry-run', file])
    assert.match(out, /error/)
    assert.doesNotMatch(out, /SUCCESS/)

    const plan: AssemblyPlan = await new AssemblyController({}).dryRun({ sources: [file] })
    assert.equal(dryRunExitCode(plan), 1)
    // 纯函数判定的可测性：合法计划 → 0
    const validFile = writeLayer(dir, 'valid.json', VALID_LAYER)
    const validPlan: AssemblyPlan = await new AssemblyController({}).dryRun({ sources: [validFile] })
    assert.equal(dryRunExitCode(validPlan), 0)

    // 格式化含 status 摘要
    assert.match(formatDryRunPlan(plan), /status=(VALIDATION-ERROR|SECURITY-DENIED)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ──────────────── M1 收口：assemble() 放行门禁 ──────────────── */

test('M1 收口：assemble 合法输入 → status=success + errors 空（可挂载）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-s8-'))
  try {
    const file = writeLayer(dir, 'valid.json', VALID_LAYER)
    const out = await new AssemblyController({}).assemble({ sources: [file] })
    assert.equal(out.status, 'success')
    assert.equal(out.errors.length, 0)
    assert.equal(out.plan.nodes.length, 2)
    assert.ok(out.plan.capabilities.grants.size >= 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M1 收口：assemble 错误输入 → 非 success + errors 非空（拒绝挂载）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-s8-'))
  try {
    const dupFile = writeLayer(dir, 'dup.json', DUPLICATE_LAYER)
    const dupOut = await new AssemblyController({}).assemble({ sources: [dupFile] })
    assert.equal(dupOut.status, 'validation-error')
    assert.ok(dupOut.errors.length > 0)
    assert.ok(dupOut.errors.some((d) => d.code === 'SEC-2002'))

    const missFile = writeLayer(dir, 'missing.json', MISSING_LAYER)
    const missOut = await new AssemblyController({}).assemble({ sources: [missFile] })
    assert.equal(missOut.status, 'validation-error')
    assert.ok(missOut.errors.some((d) => d.code === 'SEC-2001'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})