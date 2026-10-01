/**
 * 批次 4c 测试：OS 原生桥（P1–P3，方案第 17 章）
 * 覆盖：
 * - P2 镜像桥（createMirrorOsBridge）：spawnManaged / kill / alive
 * - P2 sha256 分发清单（verifyBridgeManifest，裁定 2A 最小签名链）
 * - P1 Windows 类型化绑定接口位（WindowsAclBridge mock）
 * - P3 FsEffectHandler 原子 open 注入单点（升级不重构处理器）
 * 并入 dsh 后以 vitest 运行（批次 1-2 迁移）。
 */

import { test, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMirrorOsBridge,
  sha256Hex,
  verifyBridgeManifest,
  MemoryManagedProcess,
  FsEffectHandler,
} from '../src/index.ts'

import type {
  OsBridge,
  WindowsAclBridge,
  BridgeManifest,
} from '../src/index.ts'

function auditSink() {
  const entries: any[] = []
  return { entries, cb: (e: any) => { entries.push(e) } }
}

/* ─────────────── P2 镜像桥 ─────────────── */

test('4c-1 镜像桥 spawnManaged 返回进程树句柄，kill 后 alive=false', async () => {
  const bridge: OsBridge = createMirrorOsBridge()
  const proc = await bridge.spawnManaged({ command: 'node', args: [], cwd: '/tmp', env: {} })
  assert.ok(proc.pid > 0)
  assert.equal(proc.alive(), true)
  await proc.kill()
  assert.equal(proc.alive(), false)
})

test('4c-2 镜像桥 openBeneathAtomically 走 mirror（realpath 现状）', async () => {
  const bridge: OsBridge = createMirrorOsBridge()
  const dir = mkdtempSync(join(tmpdir(), 'cordis-4c-'))
  const res = await bridge.openBeneathAtomically(dir)
  assert.ok(res.length > 0)
  await rm(dir, { recursive: true, force: true })
})

test('4c-3 P1 Windows 类型化绑定接口位（windowsAclBridge 可注入）', async () => {
  const calls: any[] = []
  const windows: WindowsAclBridge = {
    createRestrictedProcess: async (opts) => {
      calls.push(opts)
      return new MemoryManagedProcess(700)
    },
  }
  const bridge: OsBridge = createMirrorOsBridge({ platform: 'win32', windows })
  const proc = await bridge.windows!.createRestrictedProcess({
    command: 'node', args: ['s.js'], cwd: 'C:\\tmp', env: {},
    integrity: 'low', writeRestricted: true,
  })
  assert.equal(proc.pid, 700)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].integrity, 'low')
})

/* ─────────────── P2 sha256 分发清单（裁定 2A 最小签名链） ─────────────── */

test('4c-4 verifyBridgeManifest：sha256 全匹配放行，任一不匹配拒绝', async () => {
  const files = new Map<string, Uint8Array>([
    ['bridge.node', new TextEncoder().encode('binary-a')],
    ['landlock-run', new TextEncoder().encode('binary-b')],
  ])
  const manifest: BridgeManifest = {
    version: '1', platform: 'linux',
    entries: [
      { file: 'bridge.node', sha256: sha256Hex(files.get('bridge.node')!) },
      { file: 'landlock-run', sha256: sha256Hex(files.get('landlock-run')!) },
    ],
  }
  const read = async (f: string) => files.get(f)!
  const ok1 = await verifyBridgeManifest(manifest, read)
  assert.equal(ok1.ok, true)
  assert.deepEqual(ok1.mismatches, [])

  const tampered: BridgeManifest = { ...manifest, entries: [{ file: 'bridge.node', sha256: 'deadbeef' }] }
  const ok2 = await verifyBridgeManifest(tampered, read)
  assert.equal(ok2.ok, false)
  assert.deepEqual(ok2.mismatches, ['bridge.node'])
})

/* ─────────────── P3 FsEffectHandler 原子 open 注入单点 ─────────────── */

const ws = mkdtempSync(join(tmpdir(), 'cordis-4c-ws-'))
writeFileSync(join(ws, 'ok.txt'), 'hello')

afterAll(async () => {
  await rm(ws, { recursive: true, force: true })
})

test('4c-5 FsEffectHandler open 单点注入：原子 open 替换 realpath（P3 升级不重构处理器）', async () => {
  const sink = auditSink()
  const opened: string[] = []
  // 注入原生原子 open 的镜像替身：记录被调用 + 返回 workspace 内路径
  const open = (target: string) => {
    opened.push(target)
    return target // 原子 open 的返回（此处直接放行；真实 native 做内核态边界校验）
  }
  const h = new FsEffectHandler({
    workspaceRoot: () => ws,
    tempAreaRoot: join(ws, '.temp'),
    audit: sink.cb,
    open,
  })
  const r = await h.handle({ type: 'fs.read', target: join(ws, 'ok.txt'), caller: 'tool-fs' })
  assert.equal(r.ok, true)
  assert.equal(opened.length, 1, '边界检查走注入的 open 单点而非内置 openBeneath')
  assert.equal(String(r.data).trim(), 'hello')
})