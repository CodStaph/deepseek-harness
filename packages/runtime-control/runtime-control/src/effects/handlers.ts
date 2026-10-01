/**
 * 运行时管控层 · 机制 3：效果处理器（四类：fs / net / proc / env）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.3.3（效果处理器实现）
 * 阶段：S12（效果系统，批次 2b）——四类处理器 + EffectApi 暴露（api.ts）；
 *       M0 边界扩充（裁定 3A，fs.trash 的 trash 依赖评审闸接口位）；P3 接口位预留
 *       （openBeneath 可替换单点，S12 以 realpath 先行缓解）。
 *
 * 语义要点（方案 §5.3.3）：
 * - 效果系统即 safety monitor：所有副作用不直接调 Node API，而是经受控处理器
 *   逐点检查 sandbox 与 approval 策略。
 * - 每个效果都产生 EffectAuditEntry——免审批不等于不记录（audit 回调）。
 * - 删除两档：fs.trash 回收站式删除（低门槛、默认放行）；fs.delete-permanent
 *   永久删除须契约单独声明 + 审批（S16 落地，本阶段一律 deny）。
 * - 边界以 realpath 先行落地属缓解非闭环（检查与打开间存在 TOCTOU 竞态窗口，
 *   原子化升级 openat2/dirfd 见方案 17.3 P3）；M4 原生桥裁定通过后替换本单点，
 *   不重构处理器（P3 接口位）。
 *
 * 审批语义（方案 §5.3.6）：本批次只落地豁免判定（temp-area / trash-default 两档）
 * + 审批接口位（ApprovalServiceStub）；未命中豁免的写/删一律 deny，真实
 * park/resume 审批随 S16。SEC-3xxx 段留白：本文件为纯机制载体，不新增 SEC 码位。
 */

import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat as fsStat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type {
  EffectAuditEntry,
  EffectHandler,
  EffectRequest,
  EffectResult,
  EffectType,
} from '../effect.ts'
import { checkExfiltration, DEFAULT_SENSITIVE_SCANNERS } from './exfiltration.ts'
import type { SensitiveScanner } from './exfiltration.ts'

/** 沙箱运行模式（对应装配层 sandbox-policy.mode） */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 审批服务接口位（S16 接入真实 ApprovalService）——本阶段仅保留判定钩子 */
export interface ApprovalServiceStub {
  /** 授权记忆查询：命中即免问；S12 注入则参与判定，未注入则全部拒绝 */
  lookupGrant?(req: EffectRequest): unknown
}

/** 审计回调签名（EffectAuditEntry 由处理器统一构造后回调） */
type AuditCallback = (entry: EffectAuditEntry) => void

/** 变更类效果类型集（写 / 回收站删 / 永久删）——read-only 模式整体禁止 */
const MUTATING_TYPES: readonly EffectType[] = [
  'fs.write', 'fs.trash', 'fs.delete-permanent',
]

function isMutating(type: EffectType): boolean {
  return (MUTATING_TYPES as readonly string[]).includes(type)
}

/** 由 sandboxMode 回调读取运行模式，非法值或缺省一律回退 workspace-write */
function resolveSandboxMode(fn?: () => string): SandboxMode {
  const m = fn ? fn() : 'workspace-write'
  return (['read-only', 'workspace-write', 'danger-full-access'] as string[]).includes(m)
    ? (m as SandboxMode)
    : 'workspace-write'
}

/* ─────────────────────── 边界工具 ─────────────────────── */

/**
 * 判断 child 是否位于 parent 目录内（含相等）。
 * 用相对路径判定而非 startsWith 前缀，避免 `/workspace2` 被 `/workspace` 误判。
 */
export function isInside(child: string, parent: string): boolean {
  if (!parent) return false
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * openBeneath 接口位（方案 §5.3.3 / §17.3 P3）——"边界检查 + 打开"的可替换单点。
 * S12 以 realpath 先行落地（缓解非闭环）：
 * - 已存在路径：解析符号链接后返回真实绝对路径，防符号链接绕过豁免判定；
 * - 不存在路径（创建类操作）：向上回溯到最近存在的祖先目录做 realpath，再拼回
 *   剩余文件名，使"新建"也能落在边界判定内。
 * 竞态：检查（realpath）与真正打开之间仍有 TOCTOU 窗口；M4 原生桥（openat2/dirfd）
 * 裁定通过后替换本实现，处理器无需改动。并入 dsh 时可经依赖评审闸替换。
 */
export function openBeneath(target: string): string {
  const abs = resolve(target)
  try {
    return realpathSync(abs)
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      // 目标尚不存在：向上去首个存在的祖先目录做 realpath，再拼回相对文件名
      let parent = dirname(abs)
      let suffix = basename(abs)
      while (!existsSync(parent)) {
        const up = dirname(parent)
        suffix = join(basename(parent), suffix)
        parent = up
      }
      return join(realpathSync(parent), suffix)
    }
    throw err
  }
}

/** 统一构造效果审计条目（allow/deny 共用） */
function makeAudit(
  req: EffectRequest,
  verdict: 'allow' | 'deny',
  sandboxMode: string,
  extra?: Partial<EffectAuditEntry>,
): EffectAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    type: req.type,
    target: req.target,
    caller: req.caller,
    verdict,
    sandboxMode,
    ...extra,
  }
}

/* ─────────────────────── 豁免判定 ─────────────────────── */

/**
 * 豁免判定（方案 §5.3.6）——命中即免审批，但审计仍记录（exemption 字段）。
 * 本批次实现两档：temp-area（写入临时区）、trash-default（回收站删除）。
 * same-session-artifact（来源豁免）需 ProvenanceRegistry，随审批链 S16 接入。
 */
export function evaluateExemption(
  req: EffectRequest,
  tempAreaRoot: string,
): EffectAuditEntry['exemption'] | undefined {
  if (req.type === 'fs.write' && isInside(openBeneath(req.target), tempAreaRoot)) {
    return 'temp-area'
  }
  if (req.type === 'fs.trash') {
    return 'trash-default'
  }
  return undefined
}

/* ─────────────────────── trash 双后端（裁定 3A 接口位） ─────────────────────── */

/**
 * 回收站抽象后端（裁定 3A"trash 依赖评审闸"接口位）。
 * S12 镜像内不引入 trash npm 包（依赖评审闸未过）；并入 dsh 仓库时经依赖评审
 * 闸换用 trash 包后端（同接口，处理器与 EffectApi 无需改动）。
 */
export interface FsTrashBackend {
  /** 回收站式删除：把目标移入回收区（可恢复，低门槛） */
  trash(path: string): Promise<void>
  /** 永久删除：不可恢复（须契约声明 + 审批，高门槛） */
  deletePermanent(path: string): Promise<void>
}

/** 本地回收后端——realpath 边界内的移动式删除（move-to-trash 语义） */
export class FsLocalTrashBackend implements FsTrashBackend {
  constructor(private readonly trashDir: string) {}

  async trash(p: string): Promise<void> {
    await mkdir(this.trashDir, { recursive: true })
    const dest = join(this.trashDir, `${basename(p)}.${Date.now()}`)
    await rename(p, dest)
  }

  async deletePermanent(p: string): Promise<void> {
    await rm(p, { recursive: true, force: true })
  }
}

/* ─────────────────────── 1. 文件系统处理器 ─────────────────────── */

export class FsEffectHandler implements EffectHandler {
  private readonly sandboxMode: () => string
  private readonly workspaceRoot: () => string
  private readonly tempAreaRoot: string
  private readonly audit: AuditCallback
  private readonly approval?: ApprovalServiceStub
  private readonly trashBackend: FsTrashBackend
  /** P3 原子 open 单点（方案 17.3：S12 realpath 先行；M4 原生桥裁定后注入原生实现） */
  private readonly open: (target: string) => string | Promise<string>

  constructor(opts: {
    sandboxMode?: () => string
    workspaceRoot: () => string
    tempAreaRoot: string
    audit: AuditCallback
    /** 审批服务接口位（S16 接入真实 ApprovalService） */
    approval?: ApprovalServiceStub
    /** 回收后端（缺省用 FsLocalTrashBackend，回收区落在 workspaceRoot/.trash） */
    trashBackend?: FsTrashBackend
    /** P3 原子 open 注入点（缺省 = openBeneath realpath 现状；原生桥升级只换此单点不重构处理器） */
    open?: (target: string) => string | Promise<string>
  }) {
    this.sandboxMode = opts.sandboxMode ?? (() => 'workspace-write')
    this.workspaceRoot = opts.workspaceRoot
    this.tempAreaRoot = opts.tempAreaRoot
    this.audit = opts.audit
    if (opts.approval !== undefined) this.approval = opts.approval
    this.trashBackend = opts.trashBackend ?? new FsLocalTrashBackend(join(opts.workspaceRoot(), '.trash'))
    this.open = opts.open ?? openBeneath
  }

  async handle(req: EffectRequest): Promise<EffectResult> {
    const mode = resolveSandboxMode(this.sandboxMode)
    // read-only 模式禁止一切写与删除（含回收站）
    if (mode === 'read-only' && isMutating(req.type)) {
      return this.deny(req, `read-only 模式禁止 ${req.type}`, mode)
    }

    // 边界检查（P3 open 单点：realpath 现状 / 原生原子实现可替换）
    let resolved: string
    try {
      resolved = await this.open(req.target)
    } catch (err) {
      return this.deny(req, `路径解析失败：${String(err)}`, mode)
    }
    const insideRoot = isInside(resolved, this.workspaceRoot())
    const insideTemp = isInside(resolved, this.tempAreaRoot)
    if (!insideRoot && !insideTemp && mode !== 'danger-full-access') {
      return this.deny(req, `路径超出 workspace：${resolved}`, mode)
    }

    // 审批/豁免（S12：只做豁免 + 接口位，真实 park/resume 随 S16）
    let exemption: EffectAuditEntry['exemption'] | undefined
    if (isMutating(req.type)) {
      if (req.type === 'fs.delete-permanent') {
        return this.deny(req, 'fs.delete-permanent 需契约声明 + 审批（S16 接入）', mode)
      }
      const ex = evaluateExemption(req, this.tempAreaRoot)
      if (ex === 'trash-default' || ex === 'temp-area') {
        exemption = ex
      } else {
        const grant = this.approval?.lookupGrant?.(req)
        if (!grant) {
          return this.deny(req, '未命中豁免且无审批授权（审批语义 S16 接入）', mode)
        }
      }
    }

    // 执行
    try {
      const data = await this.execute(req, resolved)
      return this.allow(req, data, mode, exemption)
    } catch (err) {
      return this.deny(req, String(err), mode)
    }
  }

  private async execute(req: EffectRequest, resolved: string): Promise<unknown> {
    switch (req.type) {
      case 'fs.read':
        return readFile(resolved)
      case 'fs.stat':
        return fsStat(resolved)
      case 'fs.write': {
        const data = (req.args ?? [])[0]
        await mkdir(dirname(resolved), { recursive: true })
        await writeFile(resolved, Buffer.isBuffer(data) ? data : String(data))
        return undefined
      }
      case 'fs.trash':
        await this.trashBackend.trash(resolved)
        return undefined
      case 'fs.delete-permanent':
        await this.trashBackend.deletePermanent(resolved)
        return undefined
      default:
        throw new Error(`fs 处理器不支持效果类型：${req.type}`)
    }
  }

  private allow(
    req: EffectRequest, data: unknown, mode: SandboxMode,
    exemption?: EffectAuditEntry['exemption'],
  ): EffectResult {
    const entry = makeAudit(req, 'allow', mode, exemption ? { exemption } : undefined)
    this.audit(entry)
    return { ok: true, data, auditEntry: entry }
  }

  private deny(req: EffectRequest, reason: string, mode: SandboxMode): EffectResult {
    const entry = makeAudit(req, 'deny', mode, { reason })
    this.audit(entry)
    return { ok: false, error: reason, auditEntry: entry }
  }
}

/* ─────────────────────── 2. 网络处理器 ─────────────────────── */

/** 域名白名单匹配：精确匹配或子域后缀 */
function matchesDomain(hostname: string, domains: readonly string[]): boolean {
  return domains.some((d) => hostname === d || hostname.endsWith(`.${d}`))
}

export class NetEffectHandler implements EffectHandler {
  private readonly audit: AuditCallback
  private readonly allowedDomains: readonly string[]
  private readonly outboundCeilingBytes: number
  private readonly sensitiveScanners: readonly SensitiveScanner[]
  private readonly sandboxMode: () => string

  constructor(opts: {
    audit: AuditCallback
    /** 域名白名单；net.fetch 白名单非空时约束，net.connect 恒须命中白名单 */
    allowedDomains?: readonly string[]
    /** 单次出站体量上限（字节），超出 → exfiltrationCheck='blocked' 并拒绝 */
    outboundCeilingBytes?: number
    /** 敏感扫描器集（缺省 DEFAULT_SENSITIVE_SCANNERS；R19：含敏感数据的出站被拦截） */
    sensitiveScanners?: readonly SensitiveScanner[]
    sandboxMode?: () => string
  }) {
    this.audit = opts.audit
    this.allowedDomains = opts.allowedDomains ?? []
    this.outboundCeilingBytes = opts.outboundCeilingBytes ?? 10 * 1024 * 1024
    this.sensitiveScanners = opts.sensitiveScanners ?? [...DEFAULT_SENSITIVE_SCANNERS]
    this.sandboxMode = opts.sandboxMode ?? (() => 'workspace-write')
  }

  async handle(req: EffectRequest): Promise<EffectResult> {
    const mode = resolveSandboxMode(this.sandboxMode)
    if (req.type !== 'net.fetch' && req.type !== 'net.connect') {
      return this.deny(req, `net 处理器不支持效果类型：${req.type}`, mode)
    }

    let hostname: string
    try {
      hostname = new URL(req.type === 'net.fetch' ? req.target : `http://${req.target}`).hostname
    } catch (err) {
      return this.deny(req, `URL 无效：${req.target}（${String(err)}）`, mode)
    }

    if (req.type === 'net.connect') {
      if (!matchesDomain(hostname, this.allowedDomains)) {
        return this.deny(req, `目标域不在白名单：${hostname}`, mode)
      }
      const port = (req.args ?? [])[0]
      return this.allow(req, { host: hostname, port, established: false, note: 'S12 未建立真实连接' }, mode)
    }

    // net.fetch：白名单非空则须命中
    if (this.allowedDomains.length > 0 && !matchesDomain(hostname, this.allowedDomains)) {
      return this.deny(req, `目标域不在白名单：${hostname}`, mode)
    }

    // 数据外发检查（方向语义，方案 §5.3.8 / R19：超上限或含敏感数据 → blocked）
    const body = (req.args ?? [])[0] as { body?: unknown } | undefined
    const exfil = checkExfiltration(body?.body, this.outboundCeilingBytes, this.sensitiveScanners)
    if (exfil === 'blocked') {
      return this.deny(req, '出站数据被外发检查拦截（超上限或含敏感数据）', mode, { exfiltrationCheck: 'blocked' })
    }

    try {
      const init = (req.args ?? [])[0] as RequestInit | undefined
      const res = await fetch(req.target, init)
      return this.allow(req, res, mode, { exfiltrationCheck: exfil })
    } catch (err) {
      // 外发检查结果始终落账（即使 fetch 本身失败）——R19 可观测性
      return this.deny(req, String(err), mode, { exfiltrationCheck: exfil })
    }
  }

  private allow(
    req: EffectRequest, data: unknown, mode: SandboxMode,
    extra?: Partial<EffectAuditEntry>,
  ): EffectResult {
    const entry = makeAudit(req, 'allow', mode, extra)
    this.audit(entry)
    return { ok: true, data, auditEntry: entry }
  }

  private deny(
    req: EffectRequest, reason: string, mode: SandboxMode,
    extra?: Partial<EffectAuditEntry>,
  ): EffectResult {
    const entry = makeAudit(req, 'deny', mode, { reason, ...extra })
    this.audit(entry)
    return { ok: false, error: reason, auditEntry: entry }
  }
}

/* ─────────────────────── 3. 进程处理器 ─────────────────────── */

export interface ProcResult {
  stdout: string
  stderr: string
  code: number
}

/** 运行命令并采集输出（无 shell，避免命令注入） */
function runCommand(cmd: string, args: readonly string[]): Promise<ProcResult> {
  return new Promise((resolveOut) => {
    execFile(cmd, [...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? Number((err as { code?: number }).code ?? 1) : 0
      resolveOut({ stdout, stderr, code })
    })
  })
}

export class ProcEffectHandler implements EffectHandler {
  private readonly allowedCommands: ReadonlySet<string>
  private readonly audit: AuditCallback
  private readonly sandboxMode: () => string

  constructor(opts: {
    /** 命令白名单（命令路径或 basename 均命中）；缺省空 → 默认全部拒绝 */
    allowedCommands?: readonly string[]
    audit: AuditCallback
    sandboxMode?: () => string
  }) {
    this.allowedCommands = new Set(opts.allowedCommands ?? [])
    this.audit = opts.audit
    this.sandboxMode = opts.sandboxMode ?? (() => 'workspace-write')
  }

  async handle(req: EffectRequest): Promise<EffectResult> {
    const mode = resolveSandboxMode(this.sandboxMode)
    if (req.type !== 'proc.spawn' && req.type !== 'proc.exec') {
      return this.deny(req, `proc 处理器不支持效果类型：${req.type}`, mode)
    }
    const cmd = req.target
    if (!this.allowedCommands.has(cmd) && !this.allowedCommands.has(basename(cmd))) {
      return this.deny(req, `命令不在白名单：${cmd}`, mode)
    }
    const args = (req.args ?? []) as readonly string[]
    try {
      const result = await runCommand(cmd, args)
      const entry = makeAudit(req, 'allow', mode)
      this.audit(entry)
      return { ok: true, data: result, auditEntry: entry }
    } catch (err) {
      return this.deny(req, String(err), mode)
    }
  }

  private deny(req: EffectRequest, reason: string, mode: SandboxMode): EffectResult {
    const entry = makeAudit(req, 'deny', mode, { reason })
    this.audit(entry)
    return { ok: false, error: reason, auditEntry: entry }
  }
}

/* ─────────────────────── 4. 环境变量处理器 ─────────────────────── */

export class EnvEffectHandler implements EffectHandler {
  private readonly allowedEnvKeys: ReadonlySet<string>
  private readonly readonlyEnvKeys: ReadonlySet<string>
  private readonly audit: AuditCallback
  private readonly sandboxMode: () => string

  constructor(opts: {
    /** 环境变量读白名单 */
    allowedEnvKeys?: readonly string[]
    /** 写入拒绝的键（即使不在读白名单） */
    readonlyEnvKeys?: readonly string[]
    audit: AuditCallback
    sandboxMode?: () => string
  }) {
    this.allowedEnvKeys = new Set(opts.allowedEnvKeys ?? [])
    this.readonlyEnvKeys = new Set(opts.readonlyEnvKeys ?? [])
    this.audit = opts.audit
    this.sandboxMode = opts.sandboxMode ?? (() => 'workspace-write')
  }

  async handle(req: EffectRequest): Promise<EffectResult> {
    const mode = resolveSandboxMode(this.sandboxMode)

    if (req.type === 'env.get') {
      if (!this.allowedEnvKeys.has(req.target)) {
        return this.deny(req, `环境变量不在读白名单：${req.target}`, mode)
      }
      const entry = makeAudit(req, 'allow', mode)
      this.audit(entry)
      return { ok: true, data: process.env[req.target], auditEntry: entry }
    }

    if (req.type === 'env.set') {
      if (this.readonlyEnvKeys.has(req.target) || !this.allowedEnvKeys.has(req.target)) {
        return this.deny(req, `环境变量写入被拒：${req.target}`, mode)
      }
      const value = String((req.args ?? [])[0] ?? '')
      process.env[req.target] = value
      const entry = makeAudit(req, 'allow', mode)
      this.audit(entry)
      return { ok: true, data: undefined, auditEntry: entry }
    }

    return this.deny(req, `env 处理器不支持效果类型：${req.type}`, mode)
  }

  private deny(req: EffectRequest, reason: string, mode: SandboxMode): EffectResult {
    const entry = makeAudit(req, 'deny', mode, { reason })
    this.audit(entry)
    return { ok: false, error: reason, auditEntry: entry }
  }
}