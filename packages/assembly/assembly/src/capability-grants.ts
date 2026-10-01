/**
 * 装配控制层 · 能力令牌预颁发计划生成
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.2.3（能力令牌预颁发）、
 *       §7.3 管线第 6–7 步（装配层产出 CapabilityGrantPlan）
 * 阶段：S11（能力令牌预颁发计划）——装配层根据契约 `needs` + `capabilities` 计算
 *       每个插件的预颁发令牌计划（service / allowedMethods / allowedProps / expiresAt），
 *       写入 `AssemblyPlan.capabilities`；运行时 issuer 据此实际颁发 CapabilityToken。
 *
 * 语义要点（方案原文）：
 * - 权限范围由契约声明决定（§3.3 协作关系第 2 条），非插件运行时自行索取。
 * - `capabilities: {}`（空对象）＝未声明任何能力——严格模式副作用全拦；
 *   `--lenient-capabilities` 灰度标志将其降级为"拥有全部能力"（向后兼容，warning）。
 * - 仅放行「已声明能力子面」对应的服务方法（§5.2.3 权限子集）。
 * - session 平面令牌随会话过期；其余平面 0 = 永不过期（生命周期策略 S16）。
 */

import type { EffectiveNode } from './resolver.ts'
import type { CapabilityGrantPlan, TokenGrant } from './plan.ts'
import type { CapabilityDeclaration } from './contract.ts'

/** 会话级令牌缺省过期时间——session 平面插件令牌随会话过期（并入 dsh 对齐会话超时配置） */
export const SESSION_TIMEOUT_MS = 12 * 60 * 60 * 1000

/** 能力子面 → 服务方法名前缀映射。仅声明到的子面，其下注册方法才被放行（§5.2.3 权限子集）。 */
const CAPABILITY_METHOD_PREFIXES: ReadonlyMap<string, readonly string[]> = new Map([
  ['fs.read', ['read', 'readFile', 'readdir']],
  ['fs.write', ['write', 'writeFile', 'appendFile']],
  ['fs.stat', ['stat', 'access', 'exists']],
  ['fs.trash', ['trash']],
  ['fs.delete', ['delete', 'unlink', 'rm']],
  ['fs.permanentDelete', ['permanentDelete', 'deletePermanent']],
  ['network.allow', ['fetch']],
  ['process.allow', ['spawn', 'exec']],
  ['env.read', ['get']],
  ['env.write', ['set']],
  ['mcp.call', ['call']],
  ['mcp.sampling', ['samplingRequest']],
  ['mcp.roots', ['rootsRequest']],
  ['mcp.elicitation', ['elicitationRequest']],
  ['events.listen', ['listen', 'on']],
  ['events.emit', ['emit']],
])

/** 从 capabilities 声明推导命中的能力子面清单 */
export function declaredCapabilities(capabilities?: CapabilityDeclaration): string[] {
  if (!capabilities) return []
  const caps: string[] = []
  if (capabilities.fs?.read) caps.push('fs.read')
  if (capabilities.fs?.write) caps.push('fs.write')
  if (capabilities.fs?.delete) caps.push('fs.delete')
  if (capabilities.fs?.permanentDelete) caps.push('fs.permanentDelete')
  if (capabilities.network?.allow) caps.push('network.allow')
  if (capabilities.process?.allow) caps.push('process.allow')
  if (capabilities.env?.read) caps.push('env.read')
  if (capabilities.env?.write) caps.push('env.write')
  if (capabilities.mcp) caps.push('mcp.call')
  if (capabilities.mcp?.sampling) caps.push('mcp.sampling')
  if (capabilities.mcp?.roots) caps.push('mcp.roots')
  if (capabilities.mcp?.elicitation) caps.push('mcp.elicitation')
  if (capabilities.events?.listen) caps.push('events.listen')
  if (capabilities.events?.emit) caps.push('events.emit')
  return caps
}

/** 服务方法名是否命中某声明子面的前缀 */
export function matchesCapability(method: string, capability: string): boolean {
  const prefixes = CAPABILITY_METHOD_PREFIXES.get(capability) ?? []
  return prefixes.some((p) => method === p || method.startsWith(p))
}

/** 计划生成配置 */
export interface CapabilityGrantOptions {
  /** `--lenient-capabilities` 灰度标志（缺省 false = 严格） */
  lenientCapabilities?: boolean
  /** 服务方法注册表（服务名 → 可用方法名）；缺省空 = 不做方法过滤（全部声明子面放行） */
  serviceMethodsRegistry?: ReadonlyMap<string, readonly string[]>
}

/** 预颁发计划生成结果——含宽松模式回退的插件（收尾报告点名用） */
export interface CapabilityGrantResult {
  plan: CapabilityGrantPlan
  /** 宽松模式降级的插件 id（未声明能力但获全量令牌） */
  lenientFallbacks: string[]
}

/** 按契约 capabilities 过滤服务方法注册表，返回允许方法/属性子集（§5.2.3） */
export function filterAllowedMethods(
  allMethods: readonly string[],
  capabilities: CapabilityDeclaration | undefined,
  opts?: { lenientCapabilities?: boolean },
): { methods: string[]; props: string[] } {
  if (!capabilities) {
    if (opts?.lenientCapabilities) return { methods: [...allMethods], props: [] }
    return { methods: [], props: [] }
  }
  const declared = declaredCapabilities(capabilities)
  const methods = allMethods.filter((m) => declared.some((c) => matchesCapability(m, c)))
  // props 由服务属性面决定，本阶段不按方法前缀推断——默认空（属性访问随服务膜规则）
  return { methods, props: [] }
}

/** 由有效配置节点计算预颁发计划（管线第 6–7 步；方案 §5.2.3） */
export function buildCapabilityGrantPlan(
  nodes: readonly EffectiveNode[],
  options: CapabilityGrantOptions = {},
): CapabilityGrantResult {
  const serviceMethods = options.serviceMethodsRegistry ?? new Map<string, readonly string[]>()
  const grants = new Map<string, TokenGrant[]>()
  const lenientFallbacks: string[] = []

  for (const node of nodes) {
    const contract = node.contract
    if (!contract) continue
    const nodeGrants: TokenGrant[] = []
    for (const service of contract.needs) {
      const allMethods = serviceMethods.get(service) ?? []
      const { methods, props } = filterAllowedMethods(allMethods, contract.capabilities, {
        ...(options.lenientCapabilities !== undefined ? { lenientCapabilities: options.lenientCapabilities } : {}),
      })
      if (!contract.capabilities && options.lenientCapabilities) lenientFallbacks.push(node.id)
      nodeGrants.push({
        service,
        allowedMethods: methods,
        allowedProps: props,
        expiresAt: contract.plane === 'session' ? Date.now() + SESSION_TIMEOUT_MS : 0,
      })
    }
    grants.set(node.id, nodeGrants)
  }
  return { plan: { grants }, lenientFallbacks }
}