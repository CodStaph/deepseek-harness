/**
 * 批次 4b 测试：S20 MCP server 沙箱档位 + 生命周期（+ P2 进程树接线）
 * 覆盖：
 * - 三档 × 三平台沙箱模板（makeSandboxProfile / SANDBOX_PROFILES）
 * - mcp-unknown 默认全禁（裁定 2026-10-01）；显式 dry-run 零权限档放行
 * - confine 挂载点：最小 env 剥离凭证 + gateway argv 包装
 * - 逃逸用例集回归（R32 雏形，evaluateEscapeCase）
 * - 残余风险登记簿完整性（validateResidualRegistry，14.5 L1–L5）
 * - McpRuntime.spawnServer：受控进程拉起（P2）+ mcp-unknown 拒绝 spawn
 * - McpRuntime.killServersOf：进程树 kill 接线（R28，堵孤儿）
 * 并入 dsh 后以 vitest 运行（批次 1-2 迁移）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import type { McpCapability } from '@deepseek-ai/dsh-assembly'

import {
  McpRuntime,
  makeSandboxProfile,
  SANDBOX_PROFILES,
  DEFAULT_MCP_UNKNOWN_MODE,
  minimalEnv,
  confineCommand,
  ESCAPE_CASES,
  evaluateEscapeCase,
  validateResidualRegistry,
  SecurityViolation,
  MemoryManagedProcess,
} from '../src/index.ts'

import type {
  McpRuntimeOptions,
  McpServerBinding,
  ManagedProcess,
} from '../src/index.ts'

function auditSink() {
  const entries: any[] = []
  return { entries, cb: (e: any) => { entries.push(e) } }
}

function capabilityMap() {
  const map = new Map<string, McpCapability | undefined>([['tool-repo', { servers: ['mcp'], tools: ['mcp.tool'] }]])
  return { get: (owner: string) => map.get(owner) }
}

function binding(over: Partial<McpServerBinding> = {}): McpServerBinding {
  return {
    id: 'repo-mcp',
    ownerPlugin: 'tool-repo',
    realm: 'mcp-trusted',
    spawn: { command: 'node', args: ['server.js'], env: [], cwd: '/tmp' },
    transport: 'stdio',
    ...over,
  }
}

function makeRuntime(over: Partial<McpRuntimeOptions> = {}) {
  const sink = auditSink()
  return {
    runtime: new McpRuntime({ getCapability: capabilityMap().get, audit: sink.cb, ...over }),
    sink,
  }
}

/* ─────────────── 三档 × 三平台模板 ─────────────── */

test('S20-1 三档模板齐备：trusted/signed/unknown × linux/macos/windows', () => {
  const realms = ['mcp-trusted', 'mcp-signed', 'mcp-unknown']
  const platforms = ['linux', 'macos', 'windows']
  for (const p of platforms) {
    for (const r of realms) {
      const profile = makeSandboxProfile(p as any, r as any)
      assert.ok(profile, `${p}/${r} 应有模板`)
      assert.equal(profile.platform, p)
      assert.equal(profile.realm, r)
    }
  }
})

test('S20-2 mcp-unknown 默认全禁（裁定）；显式 dry-run 才放行', () => {
  assert.equal(DEFAULT_MCP_UNKNOWN_MODE, 'deny-all')
  const deny = makeSandboxProfile('linux', 'mcp-unknown')
  assert.equal(deny.gateway, 'deny-all') // 默认全禁，安全默认值不转正
  const dry = makeSandboxProfile('linux', 'mcp-unknown', 'dry-run')
  assert.equal(dry.gateway, 'dry-run')
  assert.equal(dry.samplingDefaultDeny, true)
})

test('S20-3 mcp-signed 结果扫描加严 + sampling 默认拒绝；mcp-trusted 为标准档', () => {
  const trusted = makeSandboxProfile('linux', 'mcp-trusted')
  const signed = makeSandboxProfile('linux', 'mcp-signed')
  assert.equal(trusted.resultScanStrict, false)
  assert.equal(signed.resultScanStrict, true)
  assert.equal(signed.samplingDefaultDeny, true)
  assert.equal(SANDBOX_PROFILES.length >= 9, true)
})

/* ─────────────── confine 挂载点（最小 env + argv 包装） ─────────────── */

test('S20-4 minimalEnv 剥离全部凭证键', () => {
  const env = minimalEnv({ DEEPSEEK_API_KEY: 'sk-x', HOME: '/root', PATH: '/usr/bin', OPENAI_API_KEY: 'k' })
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.HOME, '/root')
  assert.equal(env.PATH, '/usr/bin')
})

test('S20-5 confineCommand：linux bwrap 前缀包装 + 剥离凭证；deny-all 不包裹', () => {
  const baseEnv = { PATH: '/usr/bin', DEEPSEEK_API_KEY: 'sk' }
  const linux = confineCommand(
    { command: 'node', args: ['server.js'], cwd: '/tmp' },
    makeSandboxProfile('linux', 'mcp-trusted'),
    baseEnv,
  )
  assert.equal(linux.confined, true)
  assert.equal(linux.argv[0], 'bwrap') // gateway 前缀
  assert.equal(linux.env.DEEPSEEK_API_KEY, undefined)

  const deny = confineCommand(
    { command: 'node', args: ['x'], cwd: '/tmp' },
    makeSandboxProfile('windows', 'mcp-unknown'),
    baseEnv,
  )
  assert.equal(deny.confined, false) // 全禁档不包裹（调用方应拦截 spawn）
})

/* ─────────────── 逃逸用例集回归（R32） ─────────────── */

test('S20-6 逃逸用例静态回归：每档模板拦截面完备', () => {
  const denied = ESCAPE_CASES.filter((c) => c.expected === 'blocked')
  const profile = makeSandboxProfile('linux', 'mcp-trusted')
  for (const c of denied) {
    assert.equal(evaluateEscapeCase(c, profile), 'blocked', `${c.id} 应被拦截`)
  }
})

test('S20-7 dry-run 档仅允许只读协议观察（E14）', () => {
  const dryProfile = makeSandboxProfile('linux', 'mcp-unknown', 'dry-run')
  const e14 = ESCAPE_CASES.find((c) => c.id === 'E14')!
  const e13 = ESCAPE_CASES.find((c) => c.id === 'E13')!
  assert.equal(evaluateEscapeCase(e14, dryProfile), 'allowed')
  assert.equal(evaluateEscapeCase(e13, dryProfile), 'blocked')
})

/* ─────────────── 残余风险登记簿（14.5） ─────────────── */

test('S20-8 残余风险登记簿完整性：L1–L5 齐备无重复', () => {
  const { ok, issues } = validateResidualRegistry()
  assert.equal(ok, true, issues.join('; '))
})

/* ─────────────── McpRuntime.spawnServer + 生命周期（P2） ─────────────── */

test('S20-9 spawnServer：mcp-trusted 拉起受控进程（P2 进程树句柄）', async () => {
  const { runtime } = makeRuntime()
  runtime.registerServer(binding())
  const proc = await runtime.spawnServer('repo-mcp')
  assert.ok(proc.pid > 0)
  assert.equal(runtime.getServer('repo-mcp')?.state, 'running')
  assert.ok(runtime.getServer('repo-mcp')?.process)
})

test('S20-10 mcp-unknown 默认全拒：spawnServer 抛 SecurityViolation', async () => {
  const { runtime } = makeRuntime()
  runtime.registerServer(binding({ id: 'unknown-mcp', realm: 'mcp-unknown' }))
  await assert.rejects(() => runtime.spawnServer('unknown-mcp'), SecurityViolation)
})

test('S20-11 killServersOf：进程树 kill（P2），隔离插件后 server 进程终止', async () => {
  const { runtime } = makeRuntime()
  runtime.registerServer(binding())
  await runtime.spawnServer('repo-mcp')
  const proc = runtime.getServer('repo-mcp')!.process as ManagedProcess
  assert.equal(proc.alive(), true)
  runtime.killServersOf('tool-repo')
  assert.equal(runtime.getServer('repo-mcp')?.state, 'stopped')
  assert.equal(proc.alive(), false) // P2 进程树终止
})

test('S20-12 dispose：孤儿 server 进程树清理', async () => {
  const { runtime } = makeRuntime()
  runtime.registerServer(binding())
  runtime.registerServer(binding({ id: 'other-mcp', ownerPlugin: 'tool-other' }))
  await runtime.spawnServer('repo-mcp')
  const proc = runtime.getServer('repo-mcp')!.process as ManagedProcess
  runtime.dispose()
  assert.equal(proc.alive(), false)
})

/* ─────────────── P2 原生桥内存进程句柄 ─────────────── */

test('S20-13 MemoryManagedProcess：kill 幂等 + exited resolve', async () => {
  const p = new MemoryManagedProcess(42)
  assert.equal(p.pid, 42)
  assert.equal(p.alive(), true)
  await p.kill()
  assert.equal(p.alive(), false)
  const exited = await p.exited
  assert.equal(exited.signal, 'SIGKILL')
  await p.kill() // 幂等
  assert.equal(p.alive(), false)
})