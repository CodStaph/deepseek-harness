/**
 * 批次 5（并入批次 1-5）：OS 原生桥真实接线——真实 OsBridge 实现
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 第 17 章 + 批次 4c 裁定（A 分批落地）。
 * 本文件把镜像桥（`createMirrorOsBridge`，内存 mock）替换为对接 dsh 仓库**真实原生
 * 能力**的实现，接口契约不变、消费方（mcp/runtime.ts 等）不改。
 *
 * 真实面（探查结论 + 本机实测）：
 * - Windows P2 进程树：`@deepseek-ai/dsh-win32-process` 的 Job Object 通道
 *   （CreateJobObjectW + AssignProcessToJobObject + TerminateJobObject，koffi 绑定就绪）——
 *   `spawnManaged` 挂起创建→入 Job→resume，`kill` 销毁 Job（进程树级，堵 server 孤儿）。
 *   本机实测：spawn 后 poll 存活，terminateJob 后退出码 1。
 * - Windows P1 受限进程：`@deepseek-ai/dsh-sandbox-windows-acl` 的 AclSandbox
 *   （WRITE_RESTRICTED 受限令牌 + Low integrity + 能力 SID）——`windows.createRestrictedProcess`
 *   真实创建受限进程（本机实测子进程完整性级别 S-1-16-4096）。
 *   * 形状适配：AclSandbox 生命周期接口为 `{pid, wait()}`（kill-on-close Job 随宿主死），
 *     主动 kill 以 `taskkill /T /F` 进程树强杀实现；Job 销毁级 kill 留待 AclSandbox 暴露
 *     句柄（登记缺口）。
 * - POSIX P2：`child_process.spawn` detached 进程组 + `kill(-pid)` 组杀；PR_SET_PDEATHSIG
 *   仍无实现（登记缺口：setsid 逃逸子进程承诺暂不成立，见红线登记）。
 * - P3 原子 open：维持 `mirrorOpenBeneath`（realpath 缓解，非闭环）；openat2 原生实现
 *   留待原生线（批次 1-5 不新增原生代码）。
 * - sha256 清单（裁定 2A 最小签名链）：构造真实桥时若提供 `manifest`，首次受控拉起前
 *   先经 `verifyBridgeManifest` 全量校验，任一 mismatch 拒绝（fail-closed）。
 *
 * SEC 码位：零新增（OS 原语桥是机制载体非诊断规则，§5.11.1 纪律第 3 条）；SEC-3xxx 留白。
 */

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import {
  mirrorOpenBeneath,
  verifyBridgeManifest,
} from './bridge.ts'
import type {
  BridgeManifest,
  ManagedProcess,
  OsBridge,
  SpawnManagedOptions,
  WindowsAclBridge,
  WindowsRestrictedProcessOptions,
} from './bridge.ts'

/* ── win32-process 最小类型面（变量化动态 import；tsconfig.base paths 会把包重定向到
    src，静态解析会把 vendor/相关链拉进严格 program。运行期加载真实模块，函数签名按
    实际使用的最小面声明） ── */

type NativePtr = unknown
type Win32Api = object

interface SpawnedJobHandle {
  pid: number
  process: NativePtr
  job: NativePtr
}

interface Win32ProcessModule {
  loadWin32ProcessBindings(): Promise<Win32Api>
  spawnCurrentTokenJobProcess(
    api: Win32Api,
    options: {
      command: string
      args: readonly string[]
      applicationName: string
      cwd: string
      env: Readonly<Record<string, string>>
      stdio: { stdin: number; stdout: number; stderr: number }
    },
  ): SpawnedJobHandle
  terminateJob(api: Win32Api, job: NativePtr, exitCode: number): void
  pollProcessExit(api: Win32Api, process: NativePtr): number | undefined
  closeHandleChecked(api: Win32Api, handle: NativePtr, detail: string): void
}

let win32ModulePromise: Promise<Win32ProcessModule> | undefined
function loadWin32ProcessModule(): Promise<Win32ProcessModule> {
  win32ModulePromise ??= (async () => {
    const specifier = '@deepseek-ai/dsh-win32-process'
    return import(specifier) as Promise<Win32ProcessModule>
  })()
  return win32ModulePromise
}

/** Windows Job 受控进程——Job 句柄级生命周期（P2 真实面）。 */
export class WindowsJobManagedProcess implements ManagedProcess {
  private isAliveFlag = true
  private settled = false
  private timer: NodeJS.Timeout | undefined
  private resolveExitFn!: (value: { code: number | null; signal?: string }) => void
  public readonly exited: Promise<{ code: number | null; signal?: string }>
  public readonly pid: number
  private readonly job: NativePtr
  private readonly process: NativePtr

  constructor(
    private readonly api: Win32Api,
    handle: SpawnedJobHandle,
    private readonly win: Win32ProcessModule,
  ) {
    this.pid = handle.pid
    this.job = handle.job
    this.process = handle.process
    this.exited = new Promise((resolve) => {
      this.resolveExitFn = resolve
    })
    // 轮询退出（WaitForSingleObject 阻塞线程，轮询不阻塞事件循环）。
    this.timer = setInterval(() => this.poll(), 250)
  }

  /** Job 销毁 = 进程树终结（TerminateJobObject）。幂等：二次 kill 无副作用。 */
  kill(): Promise<void> {
    if (!this.isAliveFlag) return Promise.resolve()
    this.isAliveFlag = false
    try {
      try {
        this.win.terminateJob(this.api, this.job, 1)
      } finally {
        closeHandleBestEffort(this.win, this.api, this.job)
        closeHandleBestEffort(this.win, this.api, this.process)
      }
    } finally {
      this.settle({ code: 1, signal: 'SIGKILL' })
    }
    return Promise.resolve()
  }

  alive(): boolean {
    return this.isAliveFlag && !this.settled
  }

  private poll(): void {
    if (this.settled || !this.isAliveFlag) return
    const code = this.win.pollProcessExit(this.api, this.process)
    if (code !== undefined) this.settle({ code })
  }

  private settle(value: { code: number | null; signal?: string }): void {
    if (this.settled) return
    this.settled = true
    clearInterval(this.timer)
    this.resolveExitFn(value)
  }
}

function closeHandleBestEffort(win: Win32ProcessModule, api: Win32Api, handle: NativePtr): void {
  try {
    win.closeHandleChecked(api, handle, 'job lifecycle')
  } catch {
    /* 句柄清理失败不掩盖 kill 语义 */
  }
}

/** Windows 受控 spawn 实现（P2 真实面）。 */
export async function spawnWindowsManaged(opts: SpawnManagedOptions): Promise<ManagedProcess> {
  const win = await loadWin32ProcessModule()
  const api = await win.loadWin32ProcessBindings()
  const spawned = win.spawnCurrentTokenJobProcess(api, {
    command: opts.command,
    args: opts.args,
    applicationName: opts.command,
    cwd: opts.cwd,
    // 宿主环境兑底：显式 env 块若缺失 PATH/SystemRoot，node 等运行时启动即崩溃
    // （实测仅 PATH → child fatal 134）。opts.env 显式值优先。
    env: {
      SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
      ComSpec: process.env.ComSpec ?? 'C:\\Windows\\system32\\cmd.exe',
      PATH: process.env.PATH ?? '',
      ...opts.env,
    },
    stdio: { stdin: 0, stdout: 1, stderr: 2 },
  })
  return new WindowsJobManagedProcess(api, spawned, win)
}

/* ─────────────── Windows 受限进程（P1 真实面，runner 子进程承载） ─────────────── */

/** 受限进程（P1）——经 sandbox-windows-acl 的 runner CLI 子进程承载。 */
export class RestrictedRunnerProcess implements ManagedProcess {
  private isAliveFlag = true
  private settled = false
  private resolveExitFn!: (value: { code: number | null; signal?: string }) => void
  public readonly exited: Promise<{ code: number | null; signal?: string }>
  public readonly pid: number

  constructor(child: ChildProcess) {
    this.pid = child.pid ?? 0
    this.exited = new Promise((resolve) => {
      this.resolveExitFn = resolve
    })
    child.once('exit', (code, signal) => {
      this.isAliveFlag = false
      this.settle({ code, ...(signal === null || signal === undefined ? {} : { signal }) })
    })
    child.once('error', () => {
      this.isAliveFlag = false
      this.settle({ code: null })
    })
  }

  /** 进程树强杀（taskkill /T /F）。受限子进程在 runner 的 kill-on-close Job 内。 */
  kill(): Promise<void> {
    if (!this.isAliveFlag) return Promise.resolve()
    this.isAliveFlag = false
    spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'])
    this.settle({ code: 1, signal: 'SIGKILL' })
    return Promise.resolve()
  }

  alive(): boolean {
    return this.isAliveFlag && !this.settled
  }

  private settle(value: { code: number | null; signal?: string }): void {
    if (this.settled) return
    this.settled = true
    this.resolveExitFn(value)
  }
}

/** 定位 sandbox-windows-acl 的 runner 入口（按 exports map ./runner 解析，不加载包类型）。 */
function resolveSandboxRunner(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')
}

/** Windows 受限进程桥（P1）：经 sandbox-windows-acl 的 runner CLI（子进程承载，零 import）。 */
export class WindowsAclRestrictedBridge implements WindowsAclBridge {
  constructor(private readonly ensureManifest: () => Promise<void>) {}

  async createRestrictedProcess(opts: WindowsRestrictedProcessOptions): Promise<ManagedProcess> {
    await this.ensureManifest()
    // runner CLI 契约（runner.ts 头部）：node runner.js --workspace <dir> --temp <dir>
    // --mode read-only -- <argv...>；受限令牌 + Low integrity 由 runner 进程创建；
    // stdio 直通（bytes flow straight through），退出码镜像。失败 stderr
    // `windows-acl-run: <detail>` + 127，子进程绝不无限制拉起。
    // workspace 仅校验存在（read-only 无写权授予）；temp 用系统临时根（存在即可）。
    const runner = resolveSandboxRunner()
    const child = spawn(process.execPath, [
      runner,
      '--workspace', opts.cwd,
      '--temp', tmpdir(),
      '--mode', 'read-only',
      '--', opts.command, ...opts.args,
    ], {
      stdio: 'inherit',
    })
    return new RestrictedRunnerProcess(child)
  }
}

/* ─────────────── POSIX 进程组（P2 真实面，PDEATHSIG 缺口登记） ─────────────── */

/** POSIX 进程组受管进程——kill(-pid) 组杀。 */
export class PosixProcessGroupManagedProcess implements ManagedProcess {
  private isAliveFlag = true
  public readonly exited: Promise<{ code: number | null; signal?: string }>
  public readonly pid: number

  constructor(private readonly child: ChildProcess) {
    this.pid = child.pid ?? 0
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.isAliveFlag = false
        resolve({ code, ...(signal === null || signal === undefined ? {} : { signal }) })
      })
      child.once('error', () => {
        this.isAliveFlag = false
        resolve({ code: null })
      })
    })
  }

  /**
   * 进程组终止。登记缺口：契约文字承诺 PR_SET_PDEATHSIG（对 setsid 逃逸子进程也生效），
   * 仓库内无 prctl 实现——当前为 detached 进程组组杀，逃逸子进程不在组内时失效。
   */
  kill(): Promise<void> {
    if (!this.isAliveFlag) return Promise.resolve()
    this.isAliveFlag = false
    try {
      process.kill(-this.pid, 'SIGTERM')
    } catch {
      // 进程组已不存在（子进程已退出）
    }
    return Promise.resolve()
  }

  alive(): boolean {
    return this.isAliveFlag && this.child.exitCode === null && this.child.signalCode === null
  }
}

async function spawnPosixManaged(opts: SpawnManagedOptions): Promise<ManagedProcess> {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: 'inherit',
  })
  return new PosixProcessGroupManagedProcess(child)
}

/* ─────────────── 清单校验（裁定 2A 最小签名链接线） ─────────────── */

function makeManifestGuard(options: NativeOsBridgeOptions): () => Promise<void> {
  const manifest = options.manifest
  if (manifest === undefined) return async () => {}
  const readFileFn = options.readFile ?? ((file: string) => readFile(file))
  let validated = false
  return async () => {
    if (validated) return
    const { ok, mismatches } = await verifyBridgeManifest(manifest, readFileFn)
    if (!ok) {
      throw new Error(`OS 原生桥：分发清单 sha256 校验失败（${mismatches.join(', ')}）`)
    }
    validated = true
  }
}

export interface NativeOsBridgeOptions {
  /** 目标平台（缺省 = 当前进程平台；测试注入用） */
  platform?: NodeJS.Platform
  /** 分发清单——提供则首次受控拉起前强制校验（fail-closed） */
  manifest?: BridgeManifest
  /** 清单读取注入（测试用；缺省 node:fs readFile） */
  readFile?: (file: string) => Promise<Uint8Array>
}

/**
 * 真实 OS 原生桥——镜像 mock 的并入替换（接口与 createMirrorOsBridge 一致）。
 * Windows：Job 进程树 + AclSandbox 受限；POSIX：detached 进程组；P3 维持 realpath。
 */
export function createNativeOsBridge(options: NativeOsBridgeOptions = {}): OsBridge {
  const platform = options.platform ?? process.platform
  const ensureManifest = makeManifestGuard(options)
  if (platform === 'win32') {
    return {
      kind: 'native',
      platform,
      async spawnManaged(opts: SpawnManagedOptions): Promise<ManagedProcess> {
        await ensureManifest()
        return spawnWindowsManaged(opts)
      },
      openBeneathAtomically: mirrorOpenBeneath,
      windows: new WindowsAclRestrictedBridge(ensureManifest),
    }
  }
  return {
    kind: 'native',
    platform,
    async spawnManaged(opts: SpawnManagedOptions): Promise<ManagedProcess> {
      await ensureManifest()
      return spawnPosixManaged(opts)
    },
    openBeneathAtomically: mirrorOpenBeneath,
  }
}