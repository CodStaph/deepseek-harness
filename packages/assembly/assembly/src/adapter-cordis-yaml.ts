/**
 * 装配控制层 · dsh Loader YAML 适配器（批次 1-3 并入：真实装配 yml → CompositionLayer）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §4.1.2（层文件解析对齐真实 YAML）；
 *       dsh `scripts/cordis-yaml.ts`（loadCordisYaml 的 Loader entry 分类，S8 收敛基准）。
 * 阶段：批次 1-3（并入 dsh 后装配线真实接线）——装配层消费 dsh 真实 Cordis 装配 yml，
 *       `!!js` 表达式以数据保留（不执行），disabled 表达式转 ExpressionNode 交受限求值。
 *
 * 对齐纪律：
 * - 与 dsh `scripts/cordis-yaml.ts` 同构但独立实现（装配包不依赖 scripts 目录）；
 *   js-yaml 自定义 tag 的 resolve/construct 语义与 scripts 版一致（单一数据形态）。
 * - 信任等级：yml 层本身无 trust 字段，由调用方按来源注入
 *   （bundle 内 trusted / profile 覆盖 user / --patch patch）；缺省 trusted。
 * - group / preset 嵌套 config 保持原样数据不摊平（装配层校验入口级元数据，
 *   嵌套组由 loader 装配（入 dsh 后接真实 loader 装载）。
 *
 * SEC 码位论证：纯输入适配载体（解析 + 形状映射），零信任语义（§5.11.1 第 3 条：
 * 数据字段承载，不进登记表）。零新增码位。
 */

import { readFileSync } from 'node:fs'
import * as yaml from 'js-yaml'

import type { CompositionLayer, ExpressionNode, LoaderEntry, TrustLevel } from './resolver.ts'

/** Loader `!!js` 表达式保留形态（与 dsh scripts/cordis-yaml.ts 的 JsExpr 同构） */
export interface JsExpr {
  __jsExpr: string
}

const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: unknown): JsExpr => {
    if (typeof data !== 'string') throw new TypeError('!!js requires a scalar string')
    return { __jsExpr: data }
  },
})
const schema = yaml.JSON_SCHEMA.extend(jsExprType)

/** 解析 Cordis 配置 yml（`!!js` 保留为数据；根必须是 Loader entry 数组） */
export function loadCordisYaml(source: string): unknown {
  return yaml.load(source, { schema })
}

/** 判定保留的 Loader `!!js` 表达式 */
export function isJsExpr(value: unknown): value is JsExpr {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).__jsExpr === 'string'
}

/** 一个 yml 层来源（文件 + 信任等级） */
export interface YamlLayerSpec {
  /** 层文件路径 */
  filePath: string
  /** 装配信任等级（缺省 trusted） */
  trust?: TrustLevel
}

/** 把单个 Loader entry 行映射为装配层 LoaderEntry（最小字段集） */
function toLoaderEntry(row: unknown): LoaderEntry {
  const r = (row ?? {}) as Record<string, unknown>
  if (typeof r.id !== 'string') throw new Error(`Loader entry 缺 id 字符串：${JSON.stringify(row)}`)
  // Loader「禁用/启用行」语义：仅 id + disabled（无 name），覆盖既有行——name 缺省不抛错。
  const entry: LoaderEntry = { id: r.id, name: typeof r.name === 'string' ? r.name : '' }
  if (typeof r.config === 'object' && r.config !== null) {
    entry.config = r.config as Record<string, unknown>
  }
  const disabled = toDisabled(r.disabled)
  if (disabled !== undefined) entry.disabled = disabled
  return entry
}

/** boolean / `!!js` 表达式 → 装配层 disabled 形态；其余形态（非法）抛错 */
function toDisabled(v: unknown): boolean | ExpressionNode | undefined {
  if (typeof v === 'boolean') return v
  if (isJsExpr(v)) return { source: v.__jsExpr }
  if (v === undefined) return undefined
  throw new Error(`Loader entry disabled 字段仅支持 boolean 或 !!js 表达式，got ${JSON.stringify(v)}`)
}

/** 行收集：Loader `insert` 包装（含嵌套）摊平为直接 entry 行 */
function collectEntries(row: unknown): LoaderEntry[] {
  const r = (row ?? {}) as Record<string, unknown>
  if (Array.isArray(r.insert)) return r.insert.flatMap(collectEntries)
  return [toLoaderEntry(row)]
}

/** 读取一组真实 dsh 装配 yml 文件 → 装配层覆盖链（每文件一层） */
export function loadLayersFromYaml(specs: readonly YamlLayerSpec[]): CompositionLayer[] {
  return specs.map((spec) => {
    const doc = loadCordisYaml(readFileSync(spec.filePath, 'utf8'))
    if (!Array.isArray(doc)) {
      throw new Error(`${spec.filePath}: 装配 yml 根必须是 Loader entry 数组`)
    }
    const entries = doc.flatMap(collectEntries)
    return {
      id: spec.filePath,
      file: spec.filePath,
      trustLevel: spec.trust ?? 'trusted',
      entries,
    }
  })
}

/** 判断文件是否为装配 yml（.yml/.yaml 后缀；供 CLI 分层加载） */
export function isYamlConfigFile(file: string): boolean {
  return file.endsWith('.yml') || file.endsWith('.yaml')
}