/**
 * 批次 5（并入批次 1-5）：真实 OS 原生桥测试
 * - 清单校验（裁定 2A 最小签名链，fail-closed）——全平台
 * - Windows Job 通道（P2 真实面）：真实 spawn + Job 销毁 + 幂等 kill——win32 平台
 * - Windows 受限通道（P1 真实面）：AclSandbox 受限进程 + Low integrity 断言——win32 平台
 * - POSIX 进程组（P2）：spawn/exit 语义全平台；组杀 kill 在非 win32 平台验证
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/native/bridge.ts'
import { createNativeOsBridge } from '../src/native/real-bridge.ts'

const onWin32 = process.platform === 'win32'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-real-bridge-'))
  homes.push(dir)
  return dir
}

describe('真实桥·分发清单（裁定 2A 最小签名链）', () => {
  it('清单条目 sha256 不匹配 → 首次受控拉起 fail-closed 拒绝', async () => {
    const dir = tempHome()
    const file = join(dir, 'system.node')
    const bytes = new Uint8Array([1, 2, 3, 4])
    writeFileSync(file, bytes)
    const bridge = createNativeOsBridge({
      platform: 'darwin',
      manifest: {
        version: '1', platform: 'darwin-arm64',
        entries: [{ file, sha256: '0'.repeat(64) }],
      },
      readFile: async (path) => new Uint8Array(await import('node:fs/promises').then(({ readFile }) => readFile(path))),
    })
    await expect(bridge.spawnManaged({
      command: process.execPath, args: ['-e', '0'], cwd: dir, env: {},
    })).rejects.toThrow(/sha256/)
  })

  it('清单内容全部匹配 → 放行受控拉起', async () => {
    const dir = tempHome()
    const file = join(dir, 'system.node')
    const bytes = new Uint8Array([5, 6, 7, 8])
    writeFileSync(file, bytes)
    const bridge = createNativeOsBridge({
      platform: 'darwin',
      manifest: {
        version: '1', platform: 'darwin-arm64',
        entries: [{ file, sha256: sha256Hex(bytes) }],
      },
      readFile: async (p) => new Uint8Array(await import('node:fs/promises').then(({ readFile }) => readFile(p))),
    })
    const proc = await bridge.spawnManaged({
      command: process.execPath, args: ['-e', '0'], cwd: dir, env: {},
    })
    const result = await proc.exited
    expect(result.code).toBe(0)
  })
})

describe('真实桥·工厂形状', () => {
  it('Windows 平台桥带 windows 受限面与 native kind', () => {
    const bridge = createNativeOsBridge({ platform: 'win32' })
    expect(bridge.kind).toBe('native')
    expect(bridge.platform).toBe('win32')
    expect(bridge.windows).toBeDefined()
    expect(typeof bridge.spawnManaged).toBe('function')
    expect(bridge.openBeneathAtomically).toBeTypeOf('function')
  })

  it('POSIX 平台桥不含 windows 面', () => {
    const bridge = createNativeOsBridge({ platform: 'darwin' })
    expect(bridge.windows).toBeUndefined()
    expect(bridge.kind).toBe('native')
  })
})

describe.skipIf(!onWin32)('真实桥·Windows Job 通道（P2）', () => {
  it('spawn 受控进程 → kill 销毁 Job → exited 完成且 alive 变假', async () => {
    const bridge = createNativeOsBridge()
    const proc = await bridge.spawnManaged({
      command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60_000)'],
      cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' },
    })
    expect(proc.pid).toBeGreaterThan(0)
    expect(proc.alive()).toBe(true)
    await proc.kill()
    expect(proc.alive()).toBe(false)
    const result = await proc.exited
    expect(result.code).toBe(1)
  })

  it('kill 幂等：二次 kill 无副作用且 exited 只结算一次', async () => {
    const bridge = createNativeOsBridge()
    const proc = await bridge.spawnManaged({
      command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60_000)'],
      cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' },
    })
    await proc.kill()
    await proc.kill()
    await proc.exited
    await proc.exited
    expect(proc.alive()).toBe(false)
  })

  it('子进程自然退出 → exited 返回其退出码', async () => {
    const bridge = createNativeOsBridge()
    const proc = await bridge.spawnManaged({
      command: process.execPath, args: ['-e', 'process.exit(7)'],
      cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' },
    })
    const result = await proc.exited
    expect(result.code).toBe(7)
  })
})

describe.skipIf(!onWin32)('真实桥·Windows 受限通道（P1）', () => {
  it('runner 受限进程完整性级别为 Low（S-1-16-4096）', async () => {
    // 直接验证 sandbox-windows-acl runner CLI 的受限语义（子进程承载，非 import）。
    const dir = tempHome()
    const require = createRequire(import.meta.url)
    const runner = require.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')
    const child = spawn(process.execPath, [
      runner,
      '--workspace', dir,
      '--temp', tmpdir(),
      '--mode', 'read-only',
      '--',
      'cmd.exe', '/c', 'whoami', '/groups',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    expect(code).toBe(0)
    const output = Buffer.concat(stdout).toString()
    expect(output).toContain('S-1-16-4096')
    expect(Buffer.concat(stderr).toString()).toBe('')
  })

  it('createRestrictedProcess 真实拉起受限进程并可 kill', async () => {
    const bridge = createNativeOsBridge()
    const proc = await bridge.windows!.createRestrictedProcess({
      command: 'cmd.exe', args: ['/c', 'ping', '-n', '30', '-w', '100', '127.0.0.1', '>nul'],
      cwd: process.cwd(), env: {}, integrity: 'low', writeRestricted: true,
    })
    expect(proc.pid).toBeGreaterThan(0)
    expect(proc.alive()).toBe(true)
    await proc.kill()
    const result = await proc.exited
    expect(result.code).not.toBeNull()
  })
})

describe('真实桥·POSIX 进程组（P2）', () => {
  it('受控子进程自然退出 → exited 返回退出码（全平台）', async () => {
    const bridge = createNativeOsBridge({ platform: 'darwin' })
    const proc = await bridge.spawnManaged({
      command: process.execPath, args: ['-e', 'process.exit(3)'],
      cwd: process.cwd(), env: {},
    })
    const result = await proc.exited
    expect(result.code).toBe(3)
  })
})

describe.skipIf(onWin32)('真实桥·POSIX 进程组 kill', () => {
  it('kill(-pid) 组杀受控进程', async () => {
    const bridge = createNativeOsBridge()
    const proc = await bridge.spawnManaged({
      command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60_000)'],
      cwd: process.cwd(), env: {},
    })
    expect(proc.pid).toBeGreaterThan(0)
    await proc.kill()
    const result = await proc.exited
    expect(result.code).not.toBeNull()
  })
})