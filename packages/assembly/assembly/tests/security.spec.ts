/**
 * S5 安全管控（信任源 + 敏感保护 + 审计链写入）测试
 *
 * 范围：批次 1 任务 4（S5 + S7）
 * - trust：默认策略四档来源矩阵；isSourceAllowed 正反。
 * - sensitive：低信任层覆盖敏感字段 → error 诊断 code=SEC-1013；未命中正例。
 * - audit：格式含 timestamp/action；临时目录写入可还原；追加不覆盖；
 *           目录不存在时创建。
 *
 * 纪律：审计用例全部使用 os.tmpdir() 临时目录，不污染真实 $DSH_HOME。
 * 并入 dsh 仓库时转为 vitest describe/it（镜像阶段用 node:test，零测试框架依赖）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_TRUST_POLICY,
  isSourceAllowed,
  allowedSourcesFor,
} from '../src/security/trust.ts'
import {
  SENSITIVE_PATHS,
  checkSensitiveOverride,
} from '../src/security/sensitive.ts'
import {
  auditLogPath,
  formatAuditEntry,
  appendAuditEntry,
  readAuditLog,
  buildSecurityAudit,
} from '../src/security/audit.ts'

import type { AuditEntry } from '../src/security/audit.ts'
import type { Diagnostic } from '../src/validators/types.ts'
import type { EffectiveNode, TrustLevel } from '../src/resolver.ts'

/** 默认策略期望矩阵：等级 → 各来源是否允许 */
const EXPECTED_MATRIX: Record<TrustLevel, Record<'workspace' | 'vendor' | 'signed' | 'arbitrary', boolean>> = {
  trusted: { workspace: true, vendor: true, signed: true, arbitrary: false },
  user: { workspace: true, vendor: true, signed: true, arbitrary: false },
  preset: { workspace: true, vendor: true, signed: false, arbitrary: false },
  patch: { workspace: true, vendor: false, signed: false, arbitrary: false },
}

test('trust-1 默认策略四档来源矩阵逐项断言', () => {
  for (const level of ['trusted', 'user', 'preset', 'patch'] as const) {
    for (const src of ['workspace', 'vendor', 'signed', 'arbitrary'] as const) {
      assert.equal(
        isSourceAllowed(DEFAULT_TRUST_POLICY, level, src),
        EXPECTED_MATRIX[level][src],
        `${level}/${src} 期望 ${EXPECTED_MATRIX[level][src]}`,
      )
    }
  }
})

test('trust-2 isSourceAllowed 正反（trusted 禁止 arbitrary，patch 仅 workspace）', () => {
  assert.equal(isSourceAllowed(DEFAULT_TRUST_POLICY, 'trusted', 'workspace'), true)
  assert.equal(isSourceAllowed(DEFAULT_TRUST_POLICY, 'trusted', 'arbitrary'), false)
  assert.equal(isSourceAllowed(DEFAULT_TRUST_POLICY, 'patch', 'workspace'), true)
  assert.equal(isSourceAllowed(DEFAULT_TRUST_POLICY, 'patch', 'vendor'), false)
  assert.equal(isSourceAllowed(DEFAULT_TRUST_POLICY, 'patch', 'signed'), false)
})

test('trust-3 allowedSourcesFor 返回各档允许来源集合', () => {
  assert.deepEqual(allowedSourcesFor(DEFAULT_TRUST_POLICY, 'trusted'), ['workspace', 'vendor', 'signed'])
  assert.deepEqual(allowedSourcesFor(DEFAULT_TRUST_POLICY, 'preset'), ['workspace', 'vendor'])
  assert.deepEqual(allowedSourcesFor(DEFAULT_TRUST_POLICY, 'patch'), ['workspace'])
})

/** 构造一个测试用覆盖层 */
function mkLayer(id: string, trustLevel: TrustLevel) {
  return { id, file: `${id}.yaml`, trustLevel, entries: [] }
}

test('sensitive-1 低信任层覆盖敏感字段 → SEC-1013 error 诊断', () => {
  const layerMap = new Map([
    ['base', mkLayer('base', 'trusted')],
    ['profile', mkLayer('profile', 'user')],
    ['patch', mkLayer('patch', 'patch')],
  ])
  const nodes: EffectiveNode[] = [
    {
      id: 'sandbox-policy',
      name: 'sandbox-policy',
      config: { mode: 'danger-full-access' },
      disabled: false,
      overrides: [
        {
          layer: 'patch',
          file: 'patch.yaml',
          changedFields: ['mode'],
          previousValue: 'isolate',
        },
      ],
    },
  ]
  const layerSource = (rowId: string) => layerMap.get(rowId)
  const diags = checkSensitiveOverride(nodes, layerSource)
  assert.equal(diags.length, 1)
  assert.equal(diags[0]?.code, 'SEC-1013')
  assert.equal(diags[0]?.severity, 'error')
  assert.equal(diags[0]?.nodeId, 'sandbox-policy')
  assert.equal(diags[0]?.fieldPath, 'mode')
})

test('sensitive-2 高信任层覆盖敏感字段 → 无诊断（正例）', () => {
  const layerMap = new Map([['base', mkLayer('base', 'trusted')]])
  const nodes: EffectiveNode[] = [
    {
      id: 'sandbox-policy',
      name: 'sandbox-policy',
      config: { mode: 'isolate' },
      disabled: false,
      overrides: [
        { layer: 'base', file: 'base.yaml', changedFields: ['mode'], previousValue: 'none' },
      ],
    },
  ]
  const diags = checkSensitiveOverride(nodes, (r) => layerMap.get(r))
  assert.equal(diags.length, 0)
})

test('sensitive-3 未命中敏感路径字段 → 无诊断（正例）', () => {
  const layerMap = new Map([['patch', mkLayer('patch', 'patch')]])
  const nodes: EffectiveNode[] = [
    {
      id: 'sandbox-policy',
      name: 'sandbox-policy',
      config: { timeout: 5000 },
      disabled: false,
      overrides: [
        { layer: 'patch', file: 'patch.yaml', changedFields: ['timeout'] },
      ],
    },
  ]
  const diags = checkSensitiveOverride(nodes, (r) => layerMap.get(r))
  assert.equal(diags.length, 0)
})

test('sensitive-4 覆盖层来源未知 → 保守报错', () => {
  const nodes: EffectiveNode[] = [
    {
      id: 'approval',
      name: 'approval',
      config: { policy: 'auto' },
      disabled: false,
      overrides: [
        { layer: 'ghost', file: 'ghost.yaml', changedFields: ['policy'] },
      ],
    },
  ]
  const diags = checkSensitiveOverride(nodes, () => undefined)
  assert.equal(diags.length, 1)
  assert.equal(diags[0]?.code, 'SEC-1013')
})

test('sensitive-5 SENSITIVE_PATHS 覆盖方案 6 项示例', () => {
  assert.equal(SENSITIVE_PATHS.length, 6)
  const ids = SENSITIVE_PATHS.map((p) => `${p.rowId}.${p.field}`)
  assert.ok(ids.includes('sandbox-policy.mode'))
  assert.ok(ids.includes('session-telemetry-otel.exporter.url'))
})

function mkEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: '2026-09-30T00:00:00.000Z',
    action: 'load',
    layer: 'base',
    file: 'base.yaml',
    ...over,
  }
}

test('audit-1 formatAuditEntry 含 timestamp/action/seq', () => {
  const line = formatAuditEntry(mkEntry({ action: 'override' }), 7)
  assert.ok(line.includes('"timestamp"'))
  assert.ok(line.includes('"action"'))
  assert.ok(line.includes('"override"'))
  assert.ok(line.includes('"seq":7'))
  const parsed = JSON.parse(line)
  assert.equal(parsed.timestamp, '2026-09-30T00:00:00.000Z')
  assert.equal(parsed.action, 'override')
  assert.equal(parsed.seq, 7)
})

test('audit-2 写入临时目录后可读回还原', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-audit-'))
  try {
    const log = join(dir, 'assembly-audit.log')
    appendAuditEntry(mkEntry(), log)
    const entries = readAuditLog(log)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.action, 'load')
    assert.equal(entries[0]?.layer, 'base')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit-3 追加不覆盖：写两条读回两条', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-audit-'))
  try {
    const log = auditLogPath(dir)
    appendAuditEntry(mkEntry({ action: 'load' }), log)
    appendAuditEntry(mkEntry({ action: 'override' }), log)
    const entries = readAuditLog(log)
    assert.equal(entries.length, 2)
    assert.equal(entries[0]?.action, 'load')
    assert.equal(entries[1]?.action, 'override')
    // 序号递增
    const lines = readAuditLog(log)
    const raw = readFileLines(log)
    const seqs = raw.map((l) => JSON.parse(l).seq as number)
    assert.equal(seqs[1]!, seqs[0]! + 1)
    assert.equal(lines.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit-4 目录不存在时幂等创建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-audit-'))
  try {
    const nested = join(dir, 'a', 'b', 'c')
    const log = join(nested, 'assembly-audit.log')
    appendAuditEntry(mkEntry(), log)
    assert.equal(existsSync(log), true)
    // 已存在的父目录下其余目录未被污染
    assert.deepEqual(readdirSync(dir).sort(), ['a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit-5 损坏行被容忍跳过（回放不抛错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-audit-'))
  try {
    const log = join(dir, 'assembly-audit.log')
    appendAuditEntry(mkEntry(), log)
    // 手写污染：追加一行损坏 JSON
    appendRaw(log, 'not-json{{{')
    const entries = readAuditLog(log)
    assert.equal(entries.length, 1) // 只还原第一条，损坏行被跳过
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit-6 buildSecurityAudit 复用 SecurityAudit 承载', () => {
  const diags: Diagnostic[] = [{ severity: 'error', message: 'x', code: 'SEC-1013' }]
  const audit = buildSecurityAudit(diags)
  assert.equal(audit.diagnostics.length, 1)
  assert.equal(audit.diagnostics[0]?.code, 'SEC-1013')
})

/** 辅助：读取日志行（供审计追加序号断言） */
function readFileLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
}

/** 辅助：追加一行原始内容（模拟损坏行） */
function appendRaw(path: string, content: string): void {
  appendFileSync(path, content + '\n')
}