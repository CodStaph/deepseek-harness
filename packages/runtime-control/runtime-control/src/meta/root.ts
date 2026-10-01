/**
 * 运行时管控层 · 元层登记：root 调用者 + L4 自举面诚实登记
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.10.2（root 调用者登记）+
 *       §5.10.3（自举限制登记 L4）+ §5.11.1（增量准入）+ §5.11.4（审计互指键）
 * 阶段：S22（M5 三面收口·低风险项）——root 调用者（caller: 'dsh-root'）是
 *       宿主自身发起的效应（CLI 初始化、自举清理等），其效果审计须能被识别
 *       与全量记录（R33 雏形"root 全量审计"可识别；精确验收项 R37）。
 *
 * 诚实定性（§5.10.2）：这是"可监控"而非"被约束"——root 是约束的实施者，
 *   不是被约束方。它进效果系统是为了审计完整性，不是自我限制。
 * L4 自举面（§5.10.3 + 14.5）：运行时管控层运行在 CLI 启动的进程内——不可能
 *   约束自己的启动者（谁管管理者）。该残余不做"层内假装覆盖"，登记为 14.5 L4，
 *   靠架构外手段缓解（分发签名链 + 装载期参数拒绝 + 管控层代码签名）。
 *   本模块把这一边界用代码 + 注释明示，不改动任何既有行为。
 *
 * SEC 码位论证：本文件为纯登记 / 标注载体——ROOT_CALLER 常量、isRootCaller
 *   判定、markRootAudit 标注、ROOT_SCOPE_NOTE 登记文本均不引入新判定面、
 *   不产生新诊断码（零新增 SEC 码位）。root 调用者的效果审计复用既有
 *   EffectAuditEntry.caller 语义（§5.10.2：效果请求的 caller 允许 'dsh-root'），
 *   不新增审计字段（§5.11.1 增量准入：纯标注位属"零信任语义、以既有形态承载"）。
 *
 * 并行边界：不修改 effect.ts / effects/* / approval.ts / no-lob.ts / index.ts。
 *   no-lob.ts（§5.11.2 No-Löb 条款）落地时引用本模块导出的 ROOT_CALLER。
 */

import type { EffectAuditEntry } from '../effect.ts'

/** 宿主 root 调用者——审计完整性的登记，不是自我约束（§5.10.2） */
export const ROOT_CALLER = 'dsh-root' as const

/**
 * 判定调用者是否为宿主 root（caller: 'dsh-root'）。
 * root 调用者进效果系统是为审计完整性，不受插件能力上限约束，但全部副作用
 * 照常写审计链——CLI 运行面的每笔操作可回溯（验收 R37）。
 */
export function isRootCaller(caller: string): boolean {
  return caller === ROOT_CALLER
}

/**
 * 在效果审计条目上标注 root 调用——复用 caller 语义（零新增字段）。
 * @param entry  效果审计条目
 * @param root   true：把 caller 设为 ROOT_CALLER（标注为 root 审计）；
 *               false：原样返回（不标注）。缺省 true。
 * @returns 标注后的审计条目（浅拷贝，不改原对象）
 *
 * 设计取舍（§5.11.1 增量准入）：不新增专用标注位字段——root 标识已由
 * caller === ROOT_CALLER 完整承载，新增字段属"零信任语义、以既有形态承载"，
 * 故复用 caller 语义以最小扩散。标注后的审计条目可被 isRootCaller 识别，
 * 供 post-hoc 收尾自检（§5.6）与三态披露（§5.11.7）按 root 维度聚合。
 */
export function markRootAudit(entry: EffectAuditEntry, root = true): EffectAuditEntry {
  if (root) {
    return { ...entry, caller: ROOT_CALLER }
  }
  return entry
}

/**
 * L4 自举面诚实登记说明（§5.10.3 + 14.5）。
 * 供并入 dsh 时挂文档 / 报告——root 自举面同样经受控效果系统、无豁免通道、
 * 全量审计；但"谁管管理者"的残余不在架构内假装覆盖，登记为 L4 架构外缓解。
 */
export const ROOT_SCOPE_NOTE = [
  'L4 自举面诚实登记（Cordis §5.10.3 + 14.5）：',
  "宿主自举代码（CLI 初始化、自举清理等）以 caller: 'dsh-root' 走效果系统，",
  '经受控效果处理器逐点检查，无特殊豁免通道——元层记账（审计照写）永不升级为',
  '对象层豁免（No-Löb，§5.11.2）。root 是约束的实施者而非被约束方，进效果系统',
  '是为审计完整性（R37），不是自我限制。',
  '残余边界：运行时管控层运行在 CLI 启动的进程内，不可能约束自己的启动者',
  '（谁管管理者）。该残余不做层内假装覆盖，登记为 14.5 L4，靠架构外手段缓解：',
  '分发签名链 + 装载期参数拒绝 + 管控层自身代码签名。',
].join('\n')
