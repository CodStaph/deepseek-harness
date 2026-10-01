/**
 * 运行时管控层 · fs 效果系统真实装配入口
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.3.3（S12 fs 处理器）
 * 批次：1-4 真实装配——把 FsEffectHandler 装配为真实可用的受控 fs 效果链
 *       （真实 node:fs 后端 + 真实 workspace/tempArea 来源）。
 *
 * SEC 零新增论证：本文件为装配载体——判定面在 FsEffectHandler 既有实现
 * （handlers.ts 的边界检查 / 豁免 / 审批接口位），不新增 SEC 码位。
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FsEffectHandler, FsLocalTrashBackend } from '../effects/handlers.ts'
import type { FsTrashBackend } from '../effects/handlers.ts'
import type { EffectAuditEntry } from '../effect.ts'

/** 真实 fs 效果装配绑定 */
export interface RealFsBinding {
  /** 工作区根目录（回调形式，支持运行时动态） */
  workspaceRoot(): string
  /** 临时区根目录（缺省用 os.tmpdir()） */
  tempAreaRoot?: string
  /** 沙箱模式回调（缺省 'workspace-write'） */
  sandboxMode?: () => string
  /** 审计回调 */
  audit: (entry: EffectAuditEntry) => void
}

/**
 * 装配真实可用的受控 fs 效果处理器。
 * trash 后端即真实 node:fs 后端（FsLocalTrashBackend，handlers.ts 已实现），
 * 回收区落在 workspaceRoot/.trash，在此显式装配。
 */
export function bindRealFsEffect(binding: RealFsBinding): FsEffectHandler {
  const tempAreaRoot = binding.tempAreaRoot ?? tmpdir()
  const sandboxMode = binding.sandboxMode ?? (() => 'workspace-write')
  const trashBackend = makeRealTrashBackend(binding.workspaceRoot)

  return new FsEffectHandler({
    workspaceRoot: binding.workspaceRoot,
    tempAreaRoot,
    sandboxMode,
    audit: binding.audit,
    trashBackend,
  })
}

/**
 * 构造真实 trash 后端（FsLocalTrashBackend，回收区落在 workspaceRoot/.trash）。
 * 供外部复用（如直接装配 trash 操作而不经 FsEffectHandler）。
 */
export function makeRealTrashBackend(workspaceRoot: () => string): FsTrashBackend {
  return new FsLocalTrashBackend(join(workspaceRoot(), '.trash'))
}
