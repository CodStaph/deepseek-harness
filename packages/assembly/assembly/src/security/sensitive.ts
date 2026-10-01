/**
 * 装配控制层 · 敏感配置覆盖保护
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §4.3.3（第 628–658 行）
 * 阶段：S5（安全管控）——标记敏感配置项，禁止低信任层覆盖。
 *
 * 检查逻辑（方案 §4.3.3）：展开器在合并覆盖链时，若检测到某覆盖历史命中的
 * 字段落在 SENSITIVE_PATHS 内，且覆盖层信任等级低于该敏感路径的 minTrust，
 * 则产生 error 级 Diagnostic（code=SEC-1013），装载中止。
 *
 * SEC 引用：SEC-1013 sensitive-override（SEC 登记表 §2，S5 落地）。
 * 本模块是 SEC-1013 判定的**唯一实现**——S3 静态校验面（validators/static.ts 的
 * SEC-1013 规则）经 `paths` 参数复用本实现，一码一规则不重复实现（SEC 登记表 §1）。
 * 接线点：S2 展开器合并覆盖链时调用 `checkSensitiveOverride`；因 S2 展开后
 * EffectiveNode.overrides[].layer 是层字符串 id，需由调用方经 `layerSource` 回调
 * 映射到 CompositionLayer（含 trustLevel）。本模块不直接依赖 resolver 的展开
 * 状态，单测用内联 mock 层映射解耦。
 */

import type { Diagnostic } from '../validators/types.ts'
import type { EffectiveNode, CompositionLayer, SensitivePath } from '../resolver.ts'

// SensitivePath 类型的唯一来源在 resolver.ts（S2 展开器与 S5 检查共用，依赖方向 sensitive → resolver 单向）
export type { SensitivePath }

/** 敏感配置路径表（方案 §4.3.3 的 6 项示例） */
export const SENSITIVE_PATHS: readonly SensitivePath[] = [
  { rowId: 'sandbox-policy', field: 'mode', minTrust: 'trusted' },
  { rowId: 'sandbox-policy', field: 'workspaceRoot', minTrust: 'trusted' },
  { rowId: 'approval', field: 'policy', minTrust: 'trusted' },
  { rowId: 'permission', field: 'presets', minTrust: 'trusted' },
  { rowId: 'session-telemetry-otel', field: 'exporter.url', minTrust: 'trusted' },
  { rowId: 'session-telemetry-otel', field: 'mode', minTrust: 'user' },
]

/** 层来源回调——按层 id 解析 CompositionLayer（S2 集成时接入真实展开器） */
export type LayerSource = (layerId: string) => CompositionLayer | undefined

/** 信任等级序：trusted(3) > user(2) > preset(1) > patch(0) */
const TRUST_ORDER: Record<'trusted' | 'user' | 'preset' | 'patch', number> = {
  trusted: 3,
  user: 2,
  preset: 1,
  patch: 0,
}

/** 层信任等级低于给定等级则返回 true（用于"覆盖层 trustLevel < minTrust"判定） */
function isBelow(layer: 'trusted' | 'user' | 'preset' | 'patch', min: 'trusted' | 'user' | 'preset' | 'patch'): boolean {
  return TRUST_ORDER[layer] < TRUST_ORDER[min]
}

/**
 * 逐节点 + 逐覆盖历史检查敏感覆盖保护。
 * 对每个节点，遍历其 overrides 的每条覆盖记录：
 *   - 对被覆盖的每个字段（changedFields），匹配 SENSITIVE_PATHS（rowId+field）；
 *   - 命中且覆盖层 trustLevel < minTrust → 产生 error 级 Diagnostic（code=SEC-1013）。
 *
 * @param nodes       展开后的有效配置节点（S2 输出）
 * @param layerSource 层回调：把 EffectiveNode.overrides[].layer（层 id）映射为 CompositionLayer；
 *                    映射不到（未知层）则按最保守处理——信任未知视为不可信，产生诊断。
 * @param paths       敏感路径基线（缺省 SENSITIVE_PATHS；S3 静态校验面可经 ctx 覆盖注入）
 * @returns error 级诊断列表（code=SEC-1013）
 */
export function checkSensitiveOverride(
  nodes: readonly EffectiveNode[],
  layerSource: LayerSource,
  paths: readonly SensitivePath[] = SENSITIVE_PATHS,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const node of nodes) {
    for (const ov of node.overrides) {
      const layer = layerSource(ov.layer)
      // 覆盖层未知 → 无法证明其信任等级，保守起见按不可信处理（error）
      if (!layer) {
        for (const field of ov.changedFields) {
          const sp = paths.find((p) => p.rowId === node.id && p.field === field)
          if (sp) {
            diagnostics.push(sensitiveDiag(node, ov, field, sp.minTrust, `${ov.layer} 层来源未知`))
          }
        }
        continue
      }
      for (const field of ov.changedFields) {
        const sp = paths.find((p) => p.rowId === node.id && p.field === field)
        if (sp && isBelow(layer.trustLevel, sp.minTrust)) {
          diagnostics.push(
            sensitiveDiag(node, ov, field, sp.minTrust, `${layer.trustLevel} < ${sp.minTrust}`),
          )
        }
      }
    }
  }
  return diagnostics
}

/** 构造 SEC-1013 诊断（字段路径/修复建议来自命中规则） */
function sensitiveDiag(
  node: EffectiveNode,
  ov: { layer: string; file: string },
  field: string,
  minTrust: string,
  reason: string,
): Diagnostic {
  return {
    severity: 'error',
    message: `敏感配置字段被低信任层覆盖：${node.id}.${field}（${reason}，最低信任 ${minTrust}）`,
    code: 'SEC-1013',
    nodeId: node.id,
    file: ov.file,
    fieldPath: field,
    suggestion: `将该覆盖移到信任等级不低于 ${minTrust} 的层，或移除该覆盖`,
  }
}