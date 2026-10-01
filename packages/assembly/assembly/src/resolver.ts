/**
 * 装配控制层 · 有效配置展开器（S1：仅类型先行；展开逻辑随 S2 落地）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §4.1.2
 * 阶段纪律：本文件在 S1 阶段只承载类型定义（EffectiveNode 是 AssemblyPlan.nodes
 *       的元素类型，属"M1/M2 公共语言"，M2 线构造 mock 装配计划必需）；
 *       多层覆盖链摊平、按信任等级排序合并、覆盖历史记录、`!!js` 受限求值调用
 *       等展开逻辑一律随 S2 落地，本文件不预放任何实现。
 */

import type { PluginContract } from './contract.ts'
import type { CompositionGraph, GraphNode, GraphEdge } from './plan.ts'

/** 覆盖链信任等级：trusted > user > preset > patch */
export type TrustLevel = 'trusted' | 'user' | 'preset' | 'patch'

/**
 * 覆盖链中的单个层（方案 §4.1.2）。
 * `entries` 为 loader 行结构——S2 接线时与 dsh 仓库真实 LoaderEntry 对齐，
 * 此处为最小类型占位（id/name/config/disabled/contract 为展开与契约消费的最小字段集）。
 */
export interface CompositionLayer {
  /** 层标识 */
  id: string
  /** 层来源文件路径 */
  file: string
  /** 信任等级：trusted > user > preset > patch */
  trustLevel: TrustLevel
  /** 本层的 entry 数组 */
  entries: LoaderEntry[]
}

/** loader 行结构（S2 与 dsh 真实类型对齐前的最小占位） */
export interface LoaderEntry {
  /** 行 id */
  id: string
  /** 插件包名 */
  name: string
  /** 行配置 */
  config?: Record<string, unknown>
  /** 禁用标记——可含 `!!js` 表达式（S2/S4 受限求值） */
  disabled?: boolean | ExpressionNode
  /** 契约声明（如有） */
  contract?: PluginContract
}

/** `!!js` 表达式节点（S2/S4 受限求值前的最小占位——表达式源文本） */
export interface ExpressionNode {
  /** 表达式源文本（`!!js ` 前缀后的部分） */
  source: string
}

/** 展开后的有效配置节点 */
export interface EffectiveNode {
  /** 行 id */
  id: string
  /** 插件包名 */
  name: string
  /** 最终生效的配置（合并后） */
  config: Record<string, unknown>
  /** disabled 最终值 */
  disabled: boolean | ExpressionNode
  /** 契约声明（如有） */
  contract?: PluginContract
  /** 覆盖历史：按层顺序记录每次覆盖的来源和变更字段 */
  overrides: OverrideRecord[]
}

export interface OverrideRecord {
  /** 覆盖来源层 */
  layer: string
  /** 覆盖来源文件 */
  file: string
  /** 被覆盖的字段列表 */
  changedFields: string[]
  /** 覆盖前旧值摘要 */
  previousValue?: string
}

/* ──────────────── S2 展开器实现区（保留上方既有类型导出，仅新增） ──────────────── */

/**
 * 敏感配置路径——禁止低信任层覆盖（方案 §4.3.3）。
 * S2 通过 `options.sensitivePaths` 注入（缺省为空 = 不检查）；
 * 并入 dsh 后由 S5 `security/sensitive.ts` 提供真实 `SENSITIVE_PATHS` 常量接线。
 */
export interface SensitivePath {
  /** 行 id */
  rowId: string
  /** 字段路径（支持点路径，如 "exporter.url"） */
  field: string
  /** 允许覆盖的最低信任等级 */
  minTrust: TrustLevel
}

/** 敏感覆盖拒绝详情 */
export interface SensitiveViolation {
  /** 行 id */
  nodeId: string
  /** 被低信任层覆盖的字段路径 */
  field: string
  /** 覆盖方信任等级 */
  layerTrust: TrustLevel
  /** 允许覆盖的最低信任等级 */
  minTrust: TrustLevel
  /** 人读诊断消息 */
  message: string
}

/**
 * 敏感覆盖拒绝错误——装载中止（方案 §4.3.3："产生 error 级 Diagnostic，装载中止"）。
 * 以 throw 承载"拒绝该覆盖 + 中止"，携带全部违章详情。
 */
export class SensitiveOverrideError extends Error {
  readonly violations: readonly SensitiveViolation[]
  constructor(violations: readonly SensitiveViolation[]) {
    super(`敏感配置覆盖被拒绝：${violations.map((v) => v.message).join('；')}`)
    this.name = 'SensitiveOverrideError'
    this.violations = violations
  }
}

/** `expandLayers` 的注入选项（S2 接线点，缺省即安全默认） */
export interface ExpandOptions {
  /**
   * `!!js` 受限求值回调——随 S4 白名单求值器注入（resolver 不直接依赖 safe-eval.ts）。
   * 缺省时遇到表达式节点抛"未实现"，不假实现。
   */
  evaluateDisabled?: (expr: ExpressionNode) => boolean
  /**
   * 敏感配置路径清单——S5 `security/sensitive.ts` 的真实 `SENSITIVE_PATHS` 接线点。
   * 缺省为空 = 不检查。
   */
  sensitivePaths?: readonly SensitivePath[]
}

/** 层间覆盖变更条目（`dsh config --diff` 的输入件） */
export interface LayerDiffEntry extends OverrideRecord {
  /** 受影响的行 id */
  nodeId: string
}

/** 信任优先级：值越大越晚合并、越"后覆盖"越优先（trusted 最高，最后覆盖） */
const TRUST_ORDER: Record<TrustLevel, number> = {
  patch: 0,
  preset: 1,
  user: 2,
  trusted: 3,
}

/** 深合并产生的单字段变更 */
interface MergeChange {
  path: string
  previous: unknown
}

/** 内部合并产物——同时供 `expandLayers`（节点）与 `diffLayers`（diff）消费 */
interface CoreResult {
  nodes: EffectiveNode[]
  diff: LayerDiffEntry[]
  violations: SensitiveViolation[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepClone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => deepClone(x)) as T
  if (isPlainObject(v)) {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v)) o[k] = deepClone(v[k])
    return o as T
  }
  return v
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!(k in b) || !deepEqual(a[k], b[k])) return false
  }
  return true
}

function summaryOf(value: unknown): string {
  if (value === undefined) return '<undefined>'
  const s = JSON.stringify(value)
  if (s === undefined) return String(value)
  return s.length > 120 ? `${s.slice(0, 120)}…` : s
}

/**
 * 深合并 config（对象递归合并、标量/数组替换），并计算真实变更字段路径。
 * `isAllowed(path, value)` 返回 false 时跳过该字段（敏感覆盖拒绝的接线点）。
 */
function mergeConfig(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  isAllowed: (path: string, value: unknown) => boolean,
): { merged: Record<string, unknown>; changed: MergeChange[] } {
  const target = deepClone(base)
  const changed: MergeChange[] = []
  const walk = (t: Record<string, unknown>, inc: Record<string, unknown>, prefix: string): void => {
    for (const key of Object.keys(inc)) {
      const path = prefix ? `${prefix}.${key}` : key
      const iv = inc[key]
      if (isPlainObject(iv) && isPlainObject(t[key])) {
        walk(t[key], iv, path)
      } else if (isAllowed(path, iv)) {
        const previous = t[key]
        if (!deepEqual(previous, iv)) changed.push({ path, previous })
        t[key] = iv
      }
      // else：字段被 isAllowed 拒绝（敏感覆盖）——跳过，保持基座值，不写入
    }
  }
  walk(target, incoming, '')
  return { merged: target, changed }
}

/** 字段路径是否落在候选路径之内（双向：敏感字段为超路径或子路径均可匹配） */
function fieldMatch(candidate: string, field: string): boolean {
  return (
    candidate === field ||
    candidate.startsWith(`${field}.`) ||
    field.startsWith(`${candidate}.`)
  )
}

function findSensitiveViolation(
  nodeId: string,
  path: string,
  layer: CompositionLayer,
  options?: ExpandOptions,
): SensitiveViolation | null {
  const sens = options?.sensitivePaths
  if (!sens || sens.length === 0) return null
  for (const sp of sens) {
    if (sp.rowId !== nodeId || !fieldMatch(path, sp.field)) continue
    if (TRUST_ORDER[layer.trustLevel] < TRUST_ORDER[sp.minTrust]) {
      return {
        nodeId,
        field: path,
        layerTrust: layer.trustLevel,
        minTrust: sp.minTrust,
        message: `${nodeId}.${path} 由 ${layer.trustLevel} 层覆盖，但仅允许 ${sp.minTrust} 及以上信任层覆盖`,
      }
    }
  }
  return null
}

function isDisabledExpression(v: boolean | ExpressionNode): v is ExpressionNode {
  return typeof v === 'object' && v !== null && 'source' in v
}

/**
 * 合并核心——按信任等级排序、逐层合并、记录覆盖历史，产出去敏感判定（expand/diff 共用）。
 * 不在此处抛敏感错误：违章收集到 `violations`，由调用方决定抛 or 忽略。
 */
function resolveCore(
  layers: readonly CompositionLayer[],
  options?: ExpandOptions,
): CoreResult {
  const sorted = [...layers].sort((a, b) => TRUST_ORDER[a.trustLevel] - TRUST_ORDER[b.trustLevel])
  const byId = new Map<string, EffectiveNode>()
  const diff: LayerDiffEntry[] = []
  const violations: SensitiveViolation[] = []

  for (const layer of sorted) {
    for (const entry of layer.entries) {
      const existing = byId.get(entry.id)
      if (!existing) {
        const node: EffectiveNode = {
          id: entry.id,
          name: entry.name,
          config: entry.config ? deepClone(entry.config) : {},
          disabled: entry.disabled ?? false,
          ...(entry.contract !== undefined ? { contract: deepClone(entry.contract) } : {}),
          overrides: [],
        }
        byId.set(entry.id, node)
        continue
      }

      const fields: string[] = []
      const previousValues: string[] = []

      if (entry.config) {
        const { merged, changed } = mergeConfig(existing.config, entry.config, (path, _value) => {
          const v = findSensitiveViolation(entry.id, path, layer, options)
          if (v) {
            violations.push(v)
            return false
          }
          return true
        })
        existing.config = merged
        for (const c of changed) {
          fields.push(c.path)
          previousValues.push(summaryOf(c.previous))
        }
      }
      if (entry.disabled !== undefined) {
        const old = existing.disabled
        if (!deepEqual(old, entry.disabled)) {
          fields.push('disabled')
          previousValues.push(summaryOf(old))
        }
        existing.disabled = entry.disabled
      }
      if (entry.contract !== undefined) {
        const old = existing.contract
        if (!deepEqual(old, entry.contract)) {
          fields.push('contract')
          previousValues.push(summaryOf(old))
        }
        existing.contract = deepClone(entry.contract)
      }

      if (fields.length > 0) {
        const rec: OverrideRecord = {
          layer: layer.id,
          file: layer.file,
          changedFields: fields,
          ...(previousValues.length > 0 ? { previousValue: previousValues.join('; ') } : {}),
        }
        existing.overrides.push(rec)
        diff.push({ nodeId: entry.id, ...rec })
      }
    }
  }

  return { nodes: [...byId.values()], diff, violations }
}

/**
 * 有效配置展开器——多层覆盖链摊平为单棵、带来源标注的装配树（方案 §4.1.2 核心逻辑）。
 * 来源：方案 §4.1.2 / §4.3.2 / §4.3.3；阶段：S2。
 *
 * 处理：
 * 1. 按信任等级排序（patch → preset → user → trusted），后层覆盖前层；
 * 2. 同 id 深合并 config（对象递归合并、数组/标量替换）、覆盖 contract/disabled，记录 OverrideRecord；
 * 3. `disabled` 表达式经 `options.evaluateDisabled` 受限求值（S4 接线点）；
 * 4. `options.sensitivePaths` 注入时，低信任层覆盖敏感字段 → 抛 `SensitiveOverrideError`（装载中止）。
 *
 * 未实现（不假实现）：`!!js` 求值、敏感路径常量均以注入参数接线，缺省抛明确错误。
 */
export function expandLayers(
  layers: readonly CompositionLayer[],
  options?: ExpandOptions,
): EffectiveNode[] {
  const { nodes, violations } = resolveCore(layers, options)
  if (violations.length > 0) throw new SensitiveOverrideError(violations)

  for (const n of nodes) {
    if (!isDisabledExpression(n.disabled)) continue
    const ev = options?.evaluateDisabled
    if (!ev) {
      throw new Error(
        `未实现：!!js 求值随 S4 白名单求值器接线（security/safe-eval.ts，经 options.evaluateDisabled 注入）——` +
          `节点 ${n.id}.disabled 的表达式 "${n.disabled.source}" 待 S4 落地`,
      )
    }
    n.disabled = ev(n.disabled)
  }
  return nodes
}

/**
 * 层间覆盖变更 diff——`dsh config --diff` 的数据源（方案 §4.1.2 CLI 产物）。
 * 来源：方案 §4.1.2；阶段：S2。
 */
export function diffLayers(layers: readonly CompositionLayer[]): LayerDiffEntry[] {
  const { diff } = resolveCore(layers)
  return diff
}

/**
 * 装配依赖图构造——S3 静态校验的输入（GraphNode/GraphEdge/hasCycle/orphans 雏形）。
 * 来源：方案 §4.1.3；阶段：S2。
 * 环检测用基础 DFS；缺依赖提供者（hard needs 无 provider）在此不报错，交由 S3 校验判定。
 */
export function buildCompositionGraph(nodes: readonly EffectiveNode[]): CompositionGraph {
  const graphNodes: GraphNode[] = nodes.map((n) => ({
    id: n.id,
    plane: n.contract?.plane ?? 'host',
    provides: n.contract?.provides ?? [],
    needs: n.contract?.needs ?? [],
    optional: n.contract?.optional ?? [],
    isolate: n.contract?.isolate ?? false,
  }))

  const provider = new Map<string, string>()
  for (const gn of graphNodes) {
    for (const svc of gn.provides) {
      if (!provider.has(svc)) provider.set(svc, gn.id) // 先到先得；重复提供冲突留 S3 判定
    }
  }

  const edges: GraphEdge[] = []
  for (const gn of graphNodes) {
    for (const svc of gn.needs) {
      const to = provider.get(svc)
      if (to) edges.push({ from: gn.id, to, service: svc, kind: 'hard' })
    }
    for (const svc of gn.optional) {
      const to = provider.get(svc)
      if (to) edges.push({ from: gn.id, to, service: svc, kind: 'optional' })
    }
  }

  const hasCycle = detectCycle(graphNodes, edges)
  // 孤立服务 = 既不被依赖、也不依赖任何节点（无任何出入边的独立节点）
  const orphans = graphNodes
    .filter((gn) => {
      const hasIn = edges.some((e) => e.to === gn.id)
      const hasOut = edges.some((e) => e.from === gn.id)
      return !hasIn && !hasOut
    })
    .map((gn) => gn.id)

  return { nodes: graphNodes, edges, hasCycle, orphans }
}

/** 基础 DFS 环检测（gray 集命中即环） */
function detectCycle(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): boolean {
  const adj = new Map<string, string[]>()
  for (const gn of nodes) adj.set(gn.id, [])
  for (const e of edges) adj.get(e.from)?.push(e.to)

  const state = new Map<string, 0 | 1 | 2>()
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0
    if (s === 1) return true
    if (s === 2) return false
    state.set(id, 1)
    for (const next of adj.get(id) ?? []) {
      if (visit(next)) return true
    }
    state.set(id, 2)
    return false
  }

  for (const gn of nodes) {
    if (visit(gn.id)) return true
  }
  return false
}
