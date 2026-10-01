/**
 * 装配控制层 · 静态校验规则集（S3：14 条规则迁移 + 单元测试驱动）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §4.2.1（StaticValidationRule / 规则清单表）
 * 规则数口径：方案 §4.2.1 清单表 13 条 + M0 补登 SEC-1007（fixture-module-dependency，裁定 4A）
 *           = 14 条；码位 SEC-1001–1014（SEC 登记表 §4）。
 * 阶段纪律：
 * - 本阶段为「镜像逻辑迁移」——忠实迁移每条规则的「判定逻辑」，测试用 mock 数据覆盖正反例。
 * - 输入统一为 `(nodes, graph)` 的节点/装配图抽象，不接入 dsh 仓库真实文件系统扫描
 *   （那属并入 dsh 后 A2/A7 对拍基准，见各规则 JSDoc 的「并入对齐」说明）。
 * - 使用 validators/types.ts 的 `Diagnostic`/`ValidationResult`，不新建重复类型。
 * - 只依赖 resolver.ts 的**类型层字段**（id/name/config/disabled/contract/overrides），
 *   不依赖 S2 展开器运行时输出；plane/isolate/provides/needs/optional 取自 graph 或 contract。
 * - 不修改/新建 resolver.ts、security/*、cli.ts（并行子代理产物）。
 */

import { Script } from 'node:vm'

import { checkSensitiveOverride as runSensitiveOverrideCheck } from '../security/sensitive.ts'
import type { SensitivePath } from '../security/sensitive.ts'
import type { CompositionLayer, EffectiveNode, TrustLevel } from '../resolver.ts'
import type { CompositionGraph } from '../plan.ts'
import type { Diagnostic, ValidationResult } from './types.ts'

/** 嵌套字段路径比较：candidate 是 field 的超路径或子路径均视为命中（含相等） */
/** 运行时能力键（与 contract.ts CapabilityDeclaration 的键对齐，供 SEC-1014 判定） */
type CapabilityKey = 'fs' | 'network' | 'process' | 'env' | 'events' | 'mcp'

/** 静态校验的可选外部判定上下文——缺省项取文件内镜像自洽基线 */
export interface StaticValidationContext {
  /** SEC-1001：已声明的插件依赖包名集合（镜像模型"app manifest 依赖"） */
  declaredDependencies?: ReadonlySet<string>
  /** SEC-1013：敏感路径基线（缺省取 security/sensitive.ts 的 SENSITIVE_PATHS，方案 §4.3.3） */
  sensitivePaths?: readonly SensitivePath[]
  /** SEC-1013：覆盖层 id → 信任等级（镜像 dsh 覆盖链层的 trustLevel） */
  layerTrust?: Readonly<Record<string, TrustLevel>>
  /** SEC-1014：节点 id → 信任等级（缺省 trusted） */
  nodeTrust?: Readonly<Record<string, TrustLevel>>
}

/** 静态校验规则统一接口（方案 §4.2.1） */
export interface StaticValidationRule {
  /** SEC 码位（SEC-1001–1014） */
  id: string
  /** 人类可读描述 */
  name: string
  /** 判定函数——返回本轮诊断（error 与 warning 混列） */
  check(nodes: readonly EffectiveNode[], graph: CompositionGraph, ctx?: StaticValidationContext): Diagnostic[]
}

/** 敏感字段判定复用 security/sensitive.ts 的唯一实现（SEC-1013 一码一规则）；SENSITIVE_PATHS 见方案 §4.3.3 */

/** 非 `disabled` 的元数据字段（镜像 dsh `metadataFields` L41）——这些字段必须保持静态 */
const METADATA_FIELDS = ['id', 'name', 'group', 'inject', 'intercept', 'isolate'] as const

/** 结构化诊断构造器（severity/code/message 必填，其余可选） */
function diag(
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  nodeId?: string,
  fieldPath?: string,
  suggestion?: string,
): Diagnostic {
  const d: Diagnostic = { severity, code, message }
  if (nodeId !== undefined) d.nodeId = nodeId
  if (fieldPath !== undefined) d.fieldPath = fieldPath
  if (suggestion !== undefined) d.suggestion = suggestion
  return d
}

/** 判断是否为保留下来的 Loader `!!js` 表达式（镜像 cordis-yaml.ts `isJsExpr`） */
function isJsExpr(value: unknown): value is { __jsExpr: string } {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).__jsExpr === 'string'
}

/** 递归收集值内所有 `!!js` 表达式出现的路径（镜像 collectExpressionPaths /verify L559–570） */
function collectExpressionPaths(value: unknown, path: string, output: string[]): void {
  if (isJsExpr(value)) {
    output.push(path)
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) collectExpressionPaths(value[i], `${path}[${i}]`, output)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) collectExpressionPaths(child, `${path}.${key}`, output)
  }
}

/** 从 specifier 提取裸包名（镜像 dsh `packageNameFromSpecifier` /verify L493–500） */
function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || /^[a-z][a-z+.-]*:/i.test(specifier)) return undefined
  const segments = specifier.split('/')
  if (specifier.startsWith('@')) return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined
  return segments[0] || undefined
}

/** 收集装配图全部服务提供者（graph.provides ∪ 各 contract.provides） */
function collectProviders(nodes: readonly EffectiveNode[], graph: CompositionGraph): Set<string> {
  const providers = new Set<string>()
  for (const gn of graph.nodes) for (const s of gn.provides) providers.add(s)
  for (const node of nodes) for (const s of node.contract?.provides ?? []) providers.add(s)
  return providers
}

/* ===================================================================================
 * 既有 7 条（忠实迁移 verify-cordis-config.ts 的判定逻辑 → Diagnostic）
 * =================================================================================== */

/**
 * SEC-1001 unknown-plugin：引用未在依赖清单中声明的插件包。
 * 源函数：verify-cordis-config.ts `missingPluginDependencies()` L455–477（入口 L240/L288）。
 * 本阶段等价判定：以 `node.name`（插件包名）为"引用"，以 ctx.declaredDependencies 为
 *   "已声明依赖集合"；缺省声明集合 = 本装配内全部节点包名（自洽，不误报）。
 * 并入 dsh 对齐点：需真实读取 apps/cli/package.json 依赖、bundle 依赖与 tests 依赖面，
 *   并含 @deepseek-ai/dsh-host-directory-picker-auto 的 CHOOSER_BACKEND_PACKAGES 递归约束。
 */
function checkUnknownPlugin(nodes: readonly EffectiveNode[], _graph: CompositionGraph, ctx?: StaticValidationContext): Diagnostic[] {
  const declared = ctx?.declaredDependencies ?? new Set(nodes.map(n => packageNameFromSpecifier(n.name)).filter((p): p is string => p !== undefined))
  const out: Diagnostic[] = []
  for (const node of nodes) {
    const pkg = packageNameFromSpecifier(node.name)
    if (pkg === undefined || declared.has(pkg)) continue
    out.push(diag('error', 'SEC-1001',
      `插件包 ${pkg} 未在依赖清单中声明（unknown plugin）`, node.id, undefined,
      `在应用 manifest dependencies 或装配依赖面中声明 ${pkg}`))
  }
  return out
}

/**
 * SEC-1002 metadata-expression：非 `disabled` 元数据字段（id/name/group/inject/intercept/isolate）包含 `!!js`。
 * 源函数：`verify-cordis-config.ts` `metadataExpressionErrors()` L517–539（字段表 L41）。
 * 本阶段等价判定：EffectiveNode 的 id/name 为强类型字符串不可能含 `!!js`，故扫描
 *   `node.config` 上元数据键（id/name/group/inject/intercept/isolate）的值是否含 `__jsExpr`。
 * 并入 dsh 对齐点：dsh 在 yml 顶层 entry 扫描全部元数据字段（含 patch 行），本阶段以 config 承载。
 */
function metadataExpressionCheck(nodes: readonly EffectiveNode[], _graph: CompositionGraph, _ctx?: StaticValidationContext): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const node of nodes) {
    for (const field of METADATA_FIELDS) {
      if (!(field in node.config)) continue
      const paths: string[] = []
      collectExpressionPaths(node.config[field], `config.${field}`, paths)
      for (const p of paths) {
        out.push(diag('error', 'SEC-1002',
          `元数据字段 ${p} 包含未被插值的 !!js 表达式`, node.id, p,
          `将该元数据字段保持静态（移除 !!js，或用 config/disabled 的受控求值面）`))
      }
    }
  }
  return out
}

/**
 * SEC-1003 disabled-parse：`disabled` 的 `!!js` 表达式语法错误（编译期 parse-only）。
 * 源函数：`verify-cordis-config.ts` `disabledExpressionProblem()` L548–557。
 * 本阶段等价判定：`node.disabled` 为 ExpressionNode（含 .source）时，用 `new vm.Script(\`(\${expr})\`)`
 *   仅编译不执行；编译抛错 ⇒ 语法错误。
 * 并入 dsh 对齐点：dsh 先经 cordis-yaml 将 `!!js` 构造为 `{ __jsExpr }` 再编译；本阶段直接用节点表达式源文本。
 */
function disabledParseCheck(nodes: readonly EffectiveNode[], _graph: CompositionGraph, _ctx?: StaticValidationContext): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const node of nodes) {
    if (typeof node.disabled === 'boolean' || node.disabled === undefined) continue
    const expr = (node.disabled as { source?: unknown }).source
    if (typeof expr !== 'string') continue
    try {
      new Script(`(${expr})`) // 仅编译不执行
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      out.push(diag('error', 'SEC-1003',
        `disabled 表达式语法错误: ${detail}`, node.id, 'disabled', `修正 disabled 的 !!js 表达式语法`))
    }
  }
  return out
}

/**
 * SEC-1004 preset-plane-separation：preset 行同时存在于 host 平面（一行只属一个平面）。
 * 源函数：`verify-cordis-config.ts` `validatePresetPlaneSeparation()` L139–166。
 * 本阶段等价判定：同一行（node id）出现在 graph 的 host 平面与 preset 平面 ⇒ 违规
 *   （含 isolate 遮蔽与 host 单例重复注册两类失败面）。
 * 并入 dsh 对齐点：dsh 扫描 host 基线与各 preset overlay 文件的定义与禁用关系，
 *   本阶段以 graph 平面标注近似。
 */
function presetPlaneCheck(_nodes: readonly EffectiveNode[], graph: CompositionGraph, _ctx?: StaticValidationContext): Diagnostic[] {
  const planesById = new Map<string, Set<string>>()
  for (const gn of graph.nodes) {
    const set = planesById.get(gn.id) ?? new Set<string>()
    set.add(gn.plane)
    planesById.set(gn.id, set)
  }
  const out: Diagnostic[] = []
  for (const [id, planes] of planesById) {
    if (planes.has('host') && planes.has('preset')) {
      out.push(diag('error', 'SEC-1004',
        `行 ${id} 同时存在于 host 与 preset 平面；一行只属一个平面`, id, undefined,
        `将行 ${id} 从 host 或 preset 平面移除其一`))
    }
  }
  return out
}

/**
 * SEC-1005 client-half-declared：client 包 `./client` 导出与 `dsh.client` 声明不一致。
 * 源函数：`validateClientHalvesDeclared()` L106–119。
 * 本阶段等价判定：node.config 以镜像约定键承载 `shipsClientHalf`（是否导出 ./client）
 *   与 `declaresClient`（是否声明 dsh.client）——两者不一致 ⇒ 违规。
 * 并入 dsh 对齐点：需真实读取 packages/client 下各包 package.json 的 exports["./client"] 与 dsh.client。
 */
function clientHalfCheck(nodes: readonly EffectiveNode[], _graph: CompositionGraph, _ctx?: StaticValidationContext): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const node of nodes) {
    if (node.config.shipsClientHalf !== true && node.config.declaresClient !== true) continue
    const ships = node.config.shipsClientHalf === true
    const declares = node.config.declaresClient === true
    if (ships !== declares) {
      out.push(diag('error', 'SEC-1005',
        ships
          ? `导出 ./client 但未声明 dsh.client，其浏览器半片永不投递`
          : `声明了 dsh.client 但未导出 ./client 提供半片`,
        node.id, undefined, ships ? '补充 dsh.client 声明' : '补充 ./client 导出'))
    }
  }
  return out
}

/**
 * SEC-1006 source-plane-resolution：插件包未通过 tsconfig paths 解析到 `.ts/.tsx` 源文件（防 built lib/ 回退）。
 * 源函数：`validateSourcePlaneResolution()` L413–453。
 * 本阶段等价判定：node.config.sourceFile 若存在，须以 `.ts`/`.tsx` 结尾；
 *   命中 `.js`/`.d.ts`（built lib/ 产物面）或缺失映射 ⇒ 违规。
 * 并入 dsh 对齐点：需以 tsconfig.base.json 的 paths + ts.resolveModuleName 真实解析。
 */
function sourcePlaneCheck(nodes: readonly EffectiveNode[], _graph: CompositionGraph, _ctx?: StaticValidationContext): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const node of nodes) {
    const sourceFile = node.config.sourceFile
    if (typeof sourceFile !== 'string') continue
    if (!/\.tsx?$/i.test(sourceFile)) {
      out.push(diag('error', 'SEC-1006',
        `插件 ${node.name} 的源 ${sourceFile} 未解析到 .ts/.tsx 源（命中产物平面，干净检出会断）`,
        node.id, 'config.sourceFile', '在 tsconfig paths 补源映射，使 tsx 源启动不依赖 built lib/'))
    }
  }
  return out
}

/**
 * SEC-1007 fixture-module-dependency：fixture 模块 import 未落在 owner manifest 依赖。
 * 源函数：`packageTestFixtureDependencyErrors()` L329–364；M0 裁定 4A 独立登记，S3 保留该检查。
 * 本阶段等价判定：node.config.fixtureImports（镜像键）列出的 import 的包名必须出现在
 *   node.config.ownerDependencies（owner manifest 依赖面）内；缺失 ⇒ 违规。
 * 并入 dsh 对齐点：需真实扫 fixture 目录（.ts / .mjs 文件）+ 读 owner package.json + ts.preProcessFile 解析 import。
 */
function fixtureModuleCheck(nodes: readonly EffectiveNode[], _graph: CompositionGraph, _check?: StaticValidationContext): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const node of nodes) {
    const imports = node.config.fixtureImports
    if (!Array.isArray(imports)) continue
    const owners = new Set(Array.isArray(node.config.ownerDependencies) ? node.config.ownerDependencies : [])
    for (const imp of imports) {
      if (typeof imp !== 'string') continue
      const pkg = packageNameFromSpecifier(imp)
      if (pkg !== undefined && !owners.has(pkg)) {
        out.push(diag('error', 'SEC-1007',
          `fixture import ${imp} 未落在 owner manifest 依赖（${node.config.ownerDependencies}）`,
          node.id, undefined, `在 owner 的 dependencies/devDependencies 中声明 ${pkg}`))
      }
    }
  }
  return out
}

/* ===================================================================================
 * 规划新增 6 条（基于 nodes/graph 直接实现）
 * =================================================================================== */

/**
 * SEC-1008 inject-closure：`ctx.inject` 的依赖在装配图中无提供者（注入闭包不闭合）。
 * 来源：方案 §4.2.1 新增；S3 落地。
 * 本阶段判定：node.contract.needs（硬依赖）若无任何节点/契约提供且非自身提供 ⇒ 违规（error）。
 */
function injectClosureCheck(nodes: readonly EffectiveNode[], graph: CompositionGraph, _ctx?: StaticValidationContext): Diagnostic[] {
  const providers = collectProviders(nodes, graph)
  const out: Diagnostic[] = []
  for (const node of nodes) {
    const self = new Set(node.contract?.provides ?? [])
    for (const need of node.contract?.needs ?? []) {
      if (self.has(need) || providers.has(need)) continue
      out.push(diag('error', 'SEC-1008',
        `注入依赖 ${need} 在装配图中无提供者（注入闭包不闭合）`, node.id, undefined,
        `补充提供 ${need} 的节点，或将 ${need} 移入 optional`))
    }
  }
  return out
}

/**
 * SEC-1009 duplicate-mount：同一平面内同一服务被两个非 isolate 节点提供。
 * 来源：本方案 §4.2.1 新增；S3 落地。
 * 本阶段判定：对 graph.nodes 按（plane, provides 服务）分组，非 isolate 节点 ≥2 提供同一服务 ⇒ 违规（error）。
 */
function duplicateMountCheck(_nodes: readonly EffectiveNode[], graph: CompositionGraph, _ctx?: StaticValidationContext): Diagnostic[] {
  const byKey = new Map<string, string[]>() // `${plane}::${service}` → 提供节点 id
  for (const gn of graph.nodes) {
    if (gn.isolate) continue
    for (const s of gn.provides) {
      const key = `${gn.plane}::${s}`
      const list = byKey.get(key) ?? []
      list.push(gn.id)
      byKey.set(key, list)
    }
  }
  const out: Diagnostic[] = []
  for (const [key, providers] of byKey) {
    if (providers.length < 2) continue
    const [plane, service] = key.split('::')
    out.push(diag('error', 'SEC-1009',
      `同一平面 ${plane} 内服务 ${service} 被多个非 isolate 节点重复提供（${providers.join(', ')}）`,
      providers[1], undefined, '仅保留一个非 isolate 提供者，或将冲突节点置 isolate'))
  }
  return out
}

/**
 * SEC-1010 cycle-detection：装配依赖图存在环。
 * 来源：本方案 §4.2.1 新增；S3 落地。
 * 本阶段判定：以 graph.edges（from→to）建邻接表做 DFS 环检测；并复核 graph.hasCycle 一致性。
 */
function cycleDetectionCheck(_nodes: readonly EffectiveNode[], graph: CompositionGraph, _ctx?: StaticValidationContext): Diagnostic[] {
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
  }
  const out: Diagnostic[] = []
  const cycle = findCycle(adjacency)
  if (cycle !== undefined) {
    out.push(diag('error', 'SEC-1010',
      `装配依赖图存在环（涉及 ${cycle}）`, cycle, undefined,
      '拆解环内某条边（改用可选依赖或移除循环引用）'))
  } else if (graph.hasCycle) {
    // graph 标记存在环但 edges 面未能复现 —— 保留诊断，防闭环面口径漂移
    out.push(diag('error', 'SEC-1010',
      '装配依赖图标记存在环（hasCycle=true），但 edges 面未复现', undefined, undefined,
      '核对 graph.edges 与 hasCycle 的一致性'))
  }
  return out
}

/** 邻接表 DFS 环检测——返回环上一个节点 id，无环返回 undefined */
function findCycle(adjacency: ReadonlyMap<string, string[]>): string | undefined {
  const color = new Map<string, 0 | 1 | 2>() // 0=白/未访问, 1=灰/栈中, 2=黑/已完成
  const visit = (id: string): boolean => {
    color.set(id, 1)
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next)
      if (c === 1) return true
      if (c === undefined && visit(next)) return true
    }
    color.set(id, 2)
    return false
  }
  for (const id of adjacency.keys()) {
    if (color.get(id) === undefined && visit(id)) return id
  }
  return undefined
}

/**
 * SEC-1011 orphan-service：提供了服务但无消费者（warning 级）。
 * 来源：本方案 §4.2.1 新增；S3 落地（warning）。
 * 本阶段判定：某节点提供 service，且该 service 未被任何 edge 消费、也不被自身消费 ⇒ warning。
 */
function orphanServiceCheck(_nodes: readonly EffectiveNode[], graph: CompositionGraph, _ctx?: StaticValidationContext): Diagnostic[] {
  const consumed = new Set<string>()
  for (const edge of graph.edges) consumed.add(edge.service)
  const out: Diagnostic[] = []
  for (const gn of graph.nodes) {
    for (const s of gn.provides) {
      if (consumed.has(s)) continue
      out.push(diag('warning', 'SEC-1011',
        `服务 ${s} 被 ${gn.id} 提供但无任何消费者`, gn.id, undefined,
        '确认该服务是否仍需要，否则移除提供或补挂载消费者'))
    }
  }
  return out
}

/**
 * SEC-1012 isolate-shadow：isolate 域内 provider 遮蔽 host 消费者所需路由。
 * 来源：本方案 §4.2.1 新增；S3 静态面（S6 动态面联动）。
 * 本阶段判定：某服务由 isolate 节点提供，且存在 host 平面节点需要该服务 ⇒ 遮蔽（warning）。
 */
function isolateShadowCheck(_nodes: readonly EffectiveNode[], graph: CompositionGraph, _ctx?: StaticValidationContext): Diagnostic[] {
  const hostNeeds = new Set<string>()
  for (const gn of graph.nodes) if (gn.plane === 'host') for (const n of gn.needs) hostNeeds.add(n)
  const out: Diagnostic[] = []
  for (const gn of graph.nodes) {
    if (!gn.isolate) continue
    for (const s of gn.provides) {
      if (hostNeeds.has(s)) {
        out.push(diag('warning', 'SEC-1012',
          `isolate 域 ${gn.id} 提供服务 ${s}，遮蔽 host 消费者所需路由`, gn.id, undefined,
          '核对是否需在 host 面提供该服务，或隔离域是否应独立'))
      }
    }
  }
  return out
}

/**
 * SEC-1013 sensitive-override：敏感配置被低信任层覆盖（方案 §4.3.3）。
 * 来源：本方案 §4.3.3 新增；判定复用 security/sensitive.ts 的 `checkSensitiveOverride`
 * （一码一规则的唯一实现，本规则只做输入适配）。
 * 输入适配：`ctx.layerTrust`（层 id → 信任等级）构造 LayerSource；未提供时层未知，
 * 命中敏感路径的覆盖按 fail-closed 保守报错（不可证明信任则拒绝）。
 * 节点级 contract.sensitive 标记的覆盖门槛语义方案未定义，属后续细化项（不在本规则发明）。
 */
function checkSensitiveOverride(nodes: readonly EffectiveNode[], _graph: CompositionGraph, ctx?: StaticValidationContext): Diagnostic[] {
  const layerTrust = ctx?.layerTrust ?? {}
  const layerMap = new Map<string, CompositionLayer>()
  for (const [layerId, trustLevel] of Object.entries(layerTrust)) {
    layerMap.set(layerId, { id: layerId, file: '', trustLevel, entries: [] })
  }
  return runSensitiveOverrideCheck(nodes, (layerId) => layerMap.get(layerId), ctx?.sensitivePaths)
}

/** SEC-1014 能力清单基线：各信任等级允许声明的能力键（镜像 §5.2.3；随 S5/S11 细化） */
const CAPABILITY_ALLOWANCE: Record<TrustLevel, readonly CapabilityKey[]> = {
  trusted: ['fs', 'network', 'process', 'env', 'events', 'mcp'],
  user: ['fs', 'network', 'env', 'events', 'mcp'],
  preset: ['fs', 'env', 'events'],
  patch: ['fs', 'env'],
}

/**
 * SEC-1014 capability-overclaim：声明的能力超出插件信任等级允许上限（方案 §5.2.3）。
 * 来源：本方案 §5.2.3 新增；S4/S5 落地（终态语义随 S5 能力面 / S11 令牌面细化）。
 * 本阶段基础版：node.contract.capabilities 声明的能力键 ⊆ 其信任等级允许集；否则违规（error）。
 */
function capabilityOverclaimCheck(nodes: readonly EffectiveNode[], _graph: CompositionGraph, ctx?: StaticValidationContext): Diagnostic[] {
  const nodeTrust = ctx?.nodeTrust ?? {}
  const out: Diagnostic[] = []
  for (const node of nodes) {
    const caps = node.contract?.capabilities
    if (caps === undefined) continue
    const trust = nodeTrust[node.id] ?? 'trusted'
    const allowed = new Set(CAPABILITY_ALLOWANCE[trust])
    for (const key of Object.keys(caps) as CapabilityKey[]) {
      if (allowed.has(key)) continue
      out.push(diag('error', 'SEC-1014',
        `能力 ${key} 超出信任等级 ${trust} 允许上限`, node.id, `contract.capabilities.${key}`,
        `将该能力声明下移信任等级，或由更高信任层注入`))
    }
  }
  return out
}

/* ===================================================================================
 * 规则集汇总 + 统一入口
 * =================================================================================== */

/** 14 条静态规则（方案 §4.2.1 表 13 条 + M0 补登 SEC-1007），按 SEC 码顺序 */
export const staticRules: StaticValidationRule[] = [
  { id: 'SEC-1001', name: 'unknown-plugin', check: checkUnknownPlugin },
  { id: 'SEC-1002', name: 'metadata-attribute', check: metadataExpressionCheck },
  { id: 'SEC-1003', name: 'disabled-parse', check: disabledParseCheck },
  { id: 'SEC-1004', name: 'preset-plane-separation', check: presetPlaneCheck },
  { id: 'SEC-1005', name: 'client-half-declared', check: clientHalfCheck },
  { id: 'SEC-1006', name: 'source-plane-resolution', check: sourcePlaneCheck },
  { id: 'SEC-1007', name: 'fixture-module-dependency', check: fixtureModuleCheck },
  { id: 'SEC-1008', name: 'inject-closure', check: injectClosureCheck },
  { id: 'SEC-1009', name: 'duplicate-mount', check: duplicateMountCheck },
  { id: 'SEC-1010', name: 'cycle-detection', check: cycleDetectionCheck },
  { id: 'SEC-1011', name: 'orphan-service', check: orphanServiceCheck },
  { id: 'SEC-1012', name: 'isolate-shadow', check: isolateShadowCheck },
  { id: 'SEC-1013', name: 'sensitive-override', check: checkSensitiveOverride },
  { id: 'SEC-1014', name: 'capability-overclaim', check: capabilityOverclaimCheck },
]

/** 汇总所有规则产出（诊断混列，由调用方按 severity 区分） */
export function runStaticValidation(
  nodes: readonly EffectiveNode[],
  graph: CompositionGraph,
  ctx?: StaticValidationContext,
): ValidationResult {
  const diagnostics: Diagnostic[] = []
  for (const rule of staticRules) diagnostics.push(...rule.check(nodes, graph, ctx))
  return { diagnostics }
}