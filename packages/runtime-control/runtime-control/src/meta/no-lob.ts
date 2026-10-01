/**
 * 运行时管控层 · 元层纪律：No-Löb 硬排除（meta/no-lob.ts）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.11.2（No-Löb：管控层不自我豁免，
 *       C10/§1.18.3 移植）；§8.1 依赖注释（S23 依赖 S16 先行，其中 No-Löb 排除
 *       应随 S16 一并落地——属强推先置项，其余 S23 内容后置）；服务验收 R39。
 * 阶段：S16 先置（批次 3a）——随审批语义（effects/approval.ts）同期落地；
 *       S23 其余内容（一致性哨兵、互指键、独立重算器、码位表、红线）后置。
 *
 * 语义要点（方案 §5.11.2 原文，本节为"最高价值条款"）：
 * - 管控层自身也是代码——被注入后可以给自己颁发授权记忆、把自身路径登记进豁免。
 *   LangQuanta 把这种形态命名为"可证即真"元公理并禁绝。
 * - ROOT_CALLER 与管控层内部调用者，在授权登记与豁免判定入口处硬编码排除；
 * - 审批服务的 grant 不可被颁发者自己消费；
 * - 豁免判定不可引用自己产生的 provenance 记录为自己作证；
 * - 元层记账（审计照写）永不升级为对象层豁免。
 * - 自指分区（C9 移植）：管控层的自指只允许"元型"（记账/审计），
 *   禁止"悖论型"（自授权/自豁免）。
 *
 * 与审批服务的接线点（S16，effects/approval.ts 内接线）：
 * - ApprovalService.request        ：元层调用者发起审批 → 直接拒（不进授权/豁免，审计照写）；
 * - ApprovalService.recordGrant    ：元层调用者登记授权 → 抛 SecurityViolation（本条款，R39）；
 * - evaluateExemptionChannels      ：元层调用者永不命中豁免通道（判定入口纵深防御）；
 * - ApprovalService.lookupGrant    ：元层调用者永不消费授权记忆（grant 不可自授自消）。
 *
 * ROOT_CALLER 归属说明：方案 §5.10.2 将其定义于 meta/root.ts（S22 root 调用者
 * 登记）。S22 落地后本文件从 root.ts 导入 ROOT_CALLER（唯一来源），并 re-export
 * 供 No-Löb 调用方兼容引用——本文件对外接口不变。
 *
 * SEC 码位论证（§5.11.1 信任语义准入）：本文件为 No-Löb 条款的纯机制载体（入口级硬排除，
 * 零新判定面、零可执行面）——拒绝以 MembraneAuditEntry.reason='no-lob' 承载
 * （方案 §5.11.2 原文形态），可定位性由封闭枚举字段承载。结论：零新增 SEC 码位，
 * SEC-3xxx 段维持留白（呼应批次 2b 裁定 14A）。
 */

import { SecurityViolation } from '../membrane.ts'
import { ROOT_CALLER } from './root.ts'

/** ROOT_CALLER 唯一来源为 meta/root.ts（S22 收口后统一收编）；此处 re-export 供 No-Löb 调用方兼容引用 */
export { ROOT_CALLER }

/**
 * No-Löb 条款：元层调用者永不进入授权与豁免通道（方案 §5.11.2）。
 * 封闭枚举——新增成员属"携带信任语义的判定面增量"，必须走 §5.11.9 变更裁定流程
 * （提案 → 独立复核 → 裁定 → 落地登记），不随日常开发扩充。
 *
 * - 'dsh-root'        ：宿主 root（root 是约束的实施者；其副作用照常审计 = 元记账，
 *                      但审批授权对 root 不可颁发/消费——防"被注入后给自己授权"）；
 * - 'runtime-control' ：管控层内部调用者（哨兵/重算器/审计写入，方案 §5.11.2 原文成员）；
 * - 'meta'            ：元层命名空间调用者形态（S23 哨兵/重算器/码位表的先置位）；
 * - 'meta#system'      ：元层系统 fiber 后缀形态（同上）。
 *
 * fiber 后缀形态（如 'runtime-control#fiber-1'）随 S23 细化；本阶段按方案原文精确匹配，
 * 防止前缀匹配误伤对象层插件 id（如 'runtime-control-helper'）。
 */
export const META_CALLERS: ReadonlySet<string> = new Set<string>([
  ROOT_CALLER,
  'runtime-control',
  'meta',
  'meta#system',
])

/** 元层调用者判定——No-Löb 排除的查询入口（授权/豁免双通道共用） */
export function isMetaCaller(caller: string): boolean {
  return META_CALLERS.has(caller)
}

/**
 * 授权登记与豁免判定入口的硬排除——元层调用者抛 SecurityViolation（R39）。
 * 审计形态沿用方案 §5.11.2 原文：action 'write-denied'、reason 'no-lob'。
 *
 * @param caller 效果请求/授权登记的调用者 id
 * @param action 被拒动作（审计 property 锚点，如 'recordGrant' / 'evaluateExemption'）
 */
export function assertNotMeta(caller: string, action: string = 'grant-or-exemption'): void {
  if (META_CALLERS.has(caller)) {
    throw new SecurityViolation(
      `No-Löb：元层调用者 '${caller}' 不可登记授权/豁免（元记账 ≠ 对象层豁免，动作 ${action}）`,
      { action: 'write-denied', property: action, reason: 'no-lob' },
    )
  }
}

/** 方案 §5.11.2 原命名（assertNotMetaCaller）的别名——两命名等价，供 S23 引用收口 */
export { assertNotMeta as assertNotMetaCaller }
