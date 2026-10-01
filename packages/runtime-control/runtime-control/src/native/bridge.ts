/**
 * 运行时管控层 · OS 原生桥（OS 原语桥）——窄原生包 TS 侧接口契约
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 第 17 章（OS 原语桥评估 P1–P6）
 * 阶段：批次 4c（M4 OS 原生桥裁定）——裁定 2（A 分批落地）：P1+P2 同批，P3 紧随
 *       独立小收口；P4/P5 条件触发登记维持；P6 远期评估维持。
 *
 * 价值判据（方案 17.1）：只有"结构性不可达"与"承重结构加固"配得上原生——
 * - P2 进程树生命周期 = 结构性不可达：Node 无 Job Object / PR_SET_PDEATHSIG API，
 *   `taskkill /T` 事后查询式有竞态，killpg 对 setsid 逃逸子进程失效。R28（isolate
 *   联动 kill）承重，堵"server 孤儿"生命周期面（五面之一）。
 * - P1 Windows FFI 类型化 = 承重结构加固：koffi 手写 ABI + 裸指针，ABI 偏移/对齐/
 *   句柄生命周期任何一处错误都是静默安全洞；windows-rs 类型化绑定把正确性交给
 *   编译器，windows-acl `partial` → `full` 的候选路径。
 * - P3 fs TOCTOU 原子链 = 结构性不可达：Node fs 无 dirfd/openat API，realpath 先行
 *   属缓解非闭环（检查与打开间竞态窗口）；openat2 RESOLVE_BENEATH 升级 L1 置信度。
 *
 * 镜像纪律：镜像不引入 Rust 工具链 / prebuilds 分发（并入 dsh 仓库时沿
 * `@deepseek-ai/node-addon-system` 既有轨道 + prebuilds.json 分发 + sha256 清单签名，
 * 即裁定 2A 最小签名链）。本文件定义**类型化接口契约 + 镜像 mock**，并入 dsh 时
 * 以真实 native 实现替换 mock，接口不变、消费方不改。
 *
 * SEC 码位结论：P1–P6 零码位新增（OS 原语桥是机制载体非诊断规则，§5.11.1 纪律
 * 第 3 条）；落地后若引入新诊断面，再按增量准入走 SEC 论证。SEC-3xxx 段维持留白。
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'

/** MCP server 沙箱档位（与 mcp/runtime.ts 的 McpServerRealm 保持同一值域） */
export type OsRealm = 'mcp-trusted' | 'mcp-signed' | 'mcp-unknown'

/** 受控进程句柄（P2）——进程树级生命周期，堵 setsid 逃逸子进程 */
export interface ManagedProcess {
  /** 进程组根 PID */
  pid: number
  /**
   * 终止整个进程树：Windows = Job Object 销毁；POSIX = PR_SET_PDEATHSIG + 进程组
   * 击杀（对 setsid 逃逸子进程也生效，弥补 killpg 失效）。幂等：二次 kill 无副作用。
   */
  kill(): Promise<void>
  /** 进程（树）退出信号——spawn 侧 resolve；测试可手动触发 */
  exited: Promise<{ code: number | null; signal?: string }>
  /** 是否存活（是否被 kill 过） */
  alive(): boolean
}

/** P2 spawn 参数（窄最小面：只服务 MCP server 受控 spawn，不做通用 spawn） */
export interface SpawnManagedOptions {
  command: string
  args: string[]
  cwd: string
  /** 最小 env（已剥离全部凭证；native 侧负责最终装配） */
  env: Record<string, string>
  /** 沙箱档位——native 侧决定 Job Object / PDEATHSIG + 进程组装配 */
  realm?: OsRealm
  /** 目标平台（缺省 = 当前进程平台） */
  platform?: NodeJS.Platform
}

/** P1 Windows 受限令牌装配参数（类型化绑定替换 koffi 手写 ABI/裸指针） */
export interface WindowsRestrictedProcessOptions {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** 完整性级别（Low integrity，复用 sandbox-windows-acl 既有） */
  integrity: 'low'
  /** WRITE_RESTRICTED 受限写令牌 */
  writeRestricted: boolean
}

/** P1 Windows 原生 FFI 类型化绑定（windows-rs 系）——koffi 手写 ABI 的承重替换位 */
export interface WindowsAclBridge {
  /** 创建受限进程（restricted token + Low integrity + DACL），返回进程树句柄 */
  createRestrictedProcess(opts: WindowsRestrictedProcessOptions): Promise<ManagedProcess>
}

/** P3 原子 open 签名（openBeneath 接口位的 native 升级面）——返回边界内的规范路径 */
export type AtomicOpen = (target: string) => Promise<string>

/** OS 原语桥统一入口——消费方只依赖此接口，不感知 native/mock 差异 */
export interface OsBridge {
  readonly kind: 'native' | 'mirror'
  readonly platform: NodeJS.Platform
  /** P2 受控进程树 spawn（isolate 联动 kill / 孤儿清理经此） */
  spawnManaged(opts: SpawnManagedOptions): Promise<ManagedProcess>
  /** P3 原子化 open（openat2/dirfd；镜像回退 realpath 现状） */
  openBeneathAtomically(target: string): Promise<string>
  /** P1 Windows 类型化绑定（仅 Windows；其余平台 undefined） */
  windows?: WindowsAclBridge
}

/* ─────────────── sha256 清单（裁定 2A 最小签名链，登记对象 = .node/静态二进制） ─────────────── */

/** 分发清单条目 */
export interface ManifestEntry {
  file: string
  sha256: string
}

export interface BridgeManifest {
  version: string
  platform: string
  entries: ManifestEntry[]
}

/** 计算单文件 sha256（镜像/并仓一致口径） */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 校验桥接清单——所有条目 sha256 全匹配才放行。镜像阶段纯函数可测；
 * 并入 dsh 时在加载 .node/二进制前调用（裁定 2A 最小签名链落地）。
 */
export async function verifyBridgeManifest(
  manifest: BridgeManifest,
  readFile: (file: string) => Promise<Uint8Array>,
): Promise<{ ok: boolean; mismatches: string[] }> {
  const mismatches: string[] = []
  for (const entry of manifest.entries) {
    const buf = await readFile(entry.file)
    if (sha256Hex(buf) !== entry.sha256) mismatches.push(entry.file)
  }
  return { ok: mismatches.length === 0, mismatches }
}

/* ─────────────── P3 原子 open 现状（realpath 兜底，镜像） ─────────────── */

/**
 * P3 镜像回退实现：与 handlers.ts 的 `openBeneath` 语义一致（realpath 缓解非闭环）。
 * 并入 dsh 时由 native openat2/dirfd 实现替换——签名不变，消费方不改（S12 接口位）。
 */
export async function mirrorOpenBeneath(target: string): Promise<string> {
  const abs = pathResolve(target)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/* ─────────────── 镜像桥（内存 mock——验证生命周期接线，不真正 spawn 子进程） ─────────────── */

/** 内存版受控进程（记录 kill 语义；便于测试 R28 联动 kill 接线） */
export class MemoryManagedProcess implements ManagedProcess {
  private aliveFlag = true
  private resolveExitFn!: (v: { code: number | null; signal?: string }) => void
  public readonly exited: Promise<{ code: number | null; signal?: string }>

  constructor(
    public readonly pid: number,
    private readonly onKill?: () => void,
  ) {
    this.exited = new Promise((resolve) => {
      this.resolveExitFn = resolve
    })
  }

  kill(): Promise<void> {
    if (!this.aliveFlag) return Promise.resolve()
    this.aliveFlag = false
    this.onKill?.()
    this.resolveExitFn({ code: 0, signal: 'SIGKILL' })
    return Promise.resolve()
  }

  alive(): boolean {
    return this.aliveFlag
  }
}

/** 镜像桥——测试沙箱档位 + 生命周期接线用；并入 dsh 换真实 native 实现 */
export function createMirrorOsBridge(opts?: {
  platform?: NodeJS.Platform
  windows?: WindowsAclBridge
}): OsBridge {
  let nextPid = 1000
  return {
    kind: 'mirror',
    platform: opts?.platform ?? process.platform,
    async spawnManaged(_opts: SpawnManagedOptions): Promise<ManagedProcess> {
      return new MemoryManagedProcess(nextPid++)
    },
    openBeneathAtomically: mirrorOpenBeneath,
    ...(opts?.windows !== undefined ? { windows: opts.windows } : {}),
  }
}