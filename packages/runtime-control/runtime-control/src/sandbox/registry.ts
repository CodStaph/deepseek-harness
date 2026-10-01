/**
 * 运行时管控层 · 残余风险登记簿（§14.5 L1–L5）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §14.5（残余风险登记簿）/
 *       里程碑规划批次 4b（S20 含"残余风险登记簿"）。
 * 阶段：批次 4b（M4 S20）——沙箱档位 + 生命周期绑定落地时，把 L1–L5 每项的状态与
 *       归属如实登记，验收全绿不蕴含架构一致（9.1 第 9 条：未知攻击面以登记簿管理）。
 *
 * 关键纪律（方案 14.5）：
 * - L1 沙箱逃生即使 P1–P3 全做也只是**置信度升级**，不得改写为"已消除"。
 * - L3 语义注入保持"架构性已接受"定性，不得因验收全绿改写为"已消除"。
 * - L4 自举面为架构外缓解，不做层内假装覆盖。
 *
 * SEC 码位结论：登记簿为文本/状态载体，零码位新增。SEC-3xxx 段留白。
 */

export type RiskStatus =
  | '已缓解（置信度维护）'
  | '已缓解'
  | '架构性已接受'
  | '架构外缓解'
  | '已缓解（入口级硬排除）'

export interface ResidualRiskEntry {
  id: 'L1' | 'L2' | 'L3' | 'L4' | 'L5'
  title: string
  status: RiskStatus
  mitigation: string
  /** 证据/归属（[T1]/[T2]/[T3] 或登记项） */
  evidence: string
}

/** 残余风险登记簿（L1–L5，随 S20 生命周期面更新 L1 缓解手段） */
export const RESIDUAL_RISK_REGISTRY: readonly ResidualRiskEntry[] = [
  {
    id: 'L1',
    title: '沙箱逃生（三平台配置漂移 / 机制漏洞 / TOCTOU）',
    status: '已缓解（置信度维护）',
    mitigation: '沙箱配置模板（sandbox-profiles.ts）+ 逃逸用例回归 CI（9.3 第 9 条）；P3 原子 open（openat2/dirfd）把 TOCTOU 从缓解升级为结构性排除，但**仍为置信度升级非消除**（方案 17.5 第 6 条）',
    evidence: '[T1] 逃逸用例集 E01–E14 回归 + [T3] 未知逃逸不承诺',
  },
  {
    id: 'L2',
    title: '规则内滥用（白名单内破坏 / 资源滥用 / 协议演进追新）',
    status: '已缓解',
    mitigation: '资源限额 + 半径约束 + 协议版本跟踪（第 11 章）；沙箱档位网络禁 + 外发预算',
    evidence: '[T1] 逃逸用例 + 资源限额模板',
  },
  {
    id: 'L3',
    title: '语义注入（借宿主合法权限作恶）',
    status: '架构性已接受',
    mitigation: '14.4 四重缓解栈（taint + 结构化输出 + 输出侧监控 + 来源链审批）；skill 指令面同构',
    evidence: '[T1]+[T3] 语义级注入漏检不承诺；不改写为"已消除"',
  },
  {
    id: 'L4',
    title: '自举面（CLI/宿主/管控层自身的完整性——谁管管理者）',
    status: '架构外缓解',
    mitigation: '分发签名链（裁定 2A：sha256 清单最小链，登记对象含 .node/二进制）+ 装载期参数拒绝 + 管控层代码签名（5.10.3）',
    evidence: 'registry 桥清单校验（verifyBridgeManifest）+ L4 登记不假装覆盖',
  },
  {
    id: 'L5',
    title: '管控层自我豁免（被注入后给自己颁发授权/豁免）',
    status: '已缓解（入口级硬排除）',
    mitigation: 'No-Löb：META_CALLERS 不进授权/豁免通道（5.11.2）',
    evidence: '[T1] no-lob.ts 拒绝用例',
  },
]

/** 按编号取登记项（供一致性扫描引用） */
export function getResidualRisk(id: ResidualRiskEntry['id']): ResidualRiskEntry | undefined {
  return RESIDUAL_RISK_REGISTRY.find((r) => r.id === id)
}

/** 登记簿完整性自检：五条齐备、状态合法（CI 一致性扫描入口） */
export function validateResidualRegistry(): { ok: boolean; issues: string[] } {
  const issues: string[] = []
  const ids = new Set(RESIDUAL_RISK_REGISTRY.map((r) => r.id))
  for (const id of ['L1', 'L2', 'L3', 'L4', 'L5'] as const) {
    if (!ids.has(id)) issues.push(`缺少登记 ${id}`)
  }
  const dup = RESIDUAL_RISK_REGISTRY.length - ids.size
  if (dup > 0) issues.push(`存在重复登记 ${dup} 项`)
  return { ok: issues.length === 0, issues }
}