/**
 * 装配控制层 · `dsh config` CLI 编排（镜像内可测）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §4.1.2（CLI 产物）
 * 阶段：S2（镜像编排；`--dry-run` 依赖 S3–S7 校验接线、`--capabilities` 依赖 S11 令牌预颁发，本阶段输出占位标注，不假实现）
 *
 * 纪律：
 * - 命名空间为 `dsh config`；
 * - 层文件解析（loadLayers）：JSON 抽象 + 真实 Cordis yml（批次 1-3 接入 adapter-cordis-yaml.ts）
 *   —— .yml/.yaml 走 loadLayersFromYaml（含 `!!js` 保留），.json 走原有简单形态；
 * - 格式化函数（format*）与 `parseArgv` 均为纯函数，可单测；
 * - I/O 仅发生在 `run()`（被调用时），不在模块顶层执行；入口用入口点守卫（import.meta.url 比对），
 *   避免在镜像测试 import 时误执行。
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { expandLayers, diffLayers } from './resolver.ts'
import { isYamlConfigFile, loadLayersFromYaml } from './adapter-cordis-yaml.ts'
import { buildCapabilityGrantPlan } from './capability-grants.ts'
import { safeEvaluateExpression } from './security/safe-eval.ts'
import { SENSITIVE_PATHS } from './security/sensitive.ts'
import { buildDryRunPlan } from './index.ts'
import type { CompositionLayer, EffectiveNode, LayerDiffEntry } from './resolver.ts'
import type { SafeEvalContext } from './security/safe-eval.ts'
import type { AssemblyPlan } from './plan.ts'
import type { Diagnostic } from './validators/types.ts'

/** CLI 子命令 */
export type CliCommand = 'expand' | 'diff' | 'capabilities' | 'dry-run' | 'help'

/** `parseArgv` 的解析结果 */
export interface CliOptions {
  /** 命中的子命令（未命中任一标志则 help） */
  command: CliCommand
  /** 层来源文件路径（非标志参数） */
  sources: string[]
  /** `--lenient-capabilities` 灰度标志（S11 引入，缺省 false = 严格） */
  lenientCapabilities?: boolean
}

/**
 * 解析 CLI argv → 结构化选项（纯函数，可单测）。
 * 标志优先级：capabilities > dry-run > diff > expand > help。
 */
export function parseArgv(argv: readonly string[]): CliOptions {
  const sources: string[] = []
  let command: CliCommand = 'help'
  let lenientCapabilities = false
  for (const a of argv) {
    if (a === '--capabilities') command = 'capabilities'
    else if (a === '--dry-run') command = 'dry-run'
    else if (a === '--diff') command = 'diff'
    else if (a === '--expand') command = 'expand'
    else if (a === '--lenient-capabilities') lenientCapabilities = true
    else if (a === '--help' || a === '-h') command = 'help'
    else if (a.startsWith('-')) { /* 未知标志：忽略 */ }
    else sources.push(a)
  }
  return { command, sources, lenientCapabilities }
}

/**
 * 读取覆盖链层文件：.yml/.yaml 走 Cordis Loader 适配器（批次 1-3，缺省 trusted）；
 * 其余按 JSON 抽象（镜像阶段 `Omit<CompositionLayer,'file'>` 形状）。
 */
export function loadLayers(sources: readonly string[]): CompositionLayer[] {
  if (sources.length === 0) {
    throw new Error('未提供层来源文件（用法：dsh config --expand <层文件>…）')
  }
  return sources.map((file) => {
    if (isYamlConfigFile(file)) {
      const [layer] = loadLayersFromYaml([{ filePath: file }])
      if (layer === undefined) throw new Error(`${file}: YAML 层解析未产出层`)
      return layer
    }
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Omit<CompositionLayer, 'file'>
    return { ...parsed, file }
  })
}

/** 格式化有效配置展开结果（纯函数，可单测） */
export function formatExpanded(nodes: readonly EffectiveNode[]): string {
  return nodes
    .map((n) => {
      const disabled = typeof n.disabled === 'boolean' ? String(n.disabled) : `!!js ${n.disabled.source}`
      const contract = n.contract
        ? ` plane=${n.contract.plane} isolate=${String(n.contract.isolate)} sensitive=${String(n.contract.sensitive ?? false)}`
        : ' (无契约)'
      const ovr = n.overrides.length > 0 ? ` overrides=${n.overrides.length}` : ''
      return `${n.id}\t${n.name}\tdisabled=${disabled}${contract}${ovr}\tconfig=${JSON.stringify(n.config)}`
    })
    .join('\n')
}

/** 格式化覆盖链层间 diff（纯函数，可单测） */
export function formatDiff(diff: readonly LayerDiffEntry[]): string {
  if (diff.length === 0) return '（无层间覆盖变更）'
  return diff
    .map(
      (d) =>
        `#${d.layer} (${d.file})\t${d.nodeId}\t[${d.changedFields.join(', ')}]` +
        `${d.previousValue ? `\t~${d.previousValue}` : ''}`,
    )
    .join('\n')
}

/** 格式化能力令牌预颁发计划（A10：展示预颁发令牌计划，对比契约声明） */
export function formatCapabilities(
  nodes: readonly EffectiveNode[],
  opts?: { lenientCapabilities?: boolean },
): string {
  const { plan, lenientFallbacks } = buildCapabilityGrantPlan(nodes, opts)
  const lines: string[] = []
  for (const [pluginId, grants] of plan.grants) {
    lines.push(`# ${pluginId}`)
    for (const g of grants) {
      const methods = g.allowedMethods.length > 0 ? g.allowedMethods.join(', ') : '（无）'
      lines.push(`  → ${g.service}\t方法=[${methods}]\t属性=[]\t过期=${g.expiresAt}`)
    }
    if (grants.length === 0) lines.push('  （无 needs 服务，未预颁发令牌）')
  }
  if (lenientFallbacks.length > 0) {
    lines.push(`lenient 降级（未声明能力获全量）：${lenientFallbacks.join(', ')}`)
  }
  return lines.join('\n')
}

/** 单条诊断格式化（nodeId/fieldPath/code/severity 摘要） */
function fmtDiagLine(d: Diagnostic): string {
  return `  [${d.severity}]\tcode=${d.code ?? '-'}\tnode=${d.nodeId ?? '-'}\tfield=${d.fieldPath ?? '-'}\t${d.message}`
}

/**
 * 干跑计划格式化（S8 真实编排，纯函数可单测）。
 * error/warning 分列，输出 status 摘要 + 校验/安全各段诊断。
 */
export function formatDryRunPlan(plan: AssemblyPlan): string {
  const vErrors = plan.validation.diagnostics.filter((d) => d.severity === 'error')
  const vWarnings = plan.validation.diagnostics.filter((d) => d.severity === 'warning')
  const sErrors = plan.security.diagnostics.filter((d) => d.severity === 'error')
  const lines: string[] = [
    `dsh config --dry-run\tstatus=${planStatus(plan).toUpperCase()}\t节点=${plan.nodes.length}\t层=${plan.layers.length}\t能力计划=${plan.capabilities.grants.size}`,
    '',
    `== 校验 error（${vErrors.length}） ==`,
    ...(vErrors.length > 0 ? vErrors.map(fmtDiagLine) : ['  （无）']),
    '',
    `== 校验 warning（${vWarnings.length}） ==`,
    ...(vWarnings.length > 0 ? vWarnings.map(fmtDiagLine) : ['  （无）']),
    '',
    `== 安全 error（${sErrors.length}） ==`,
    ...(sErrors.length > 0 ? sErrors.map(fmtDiagLine) : ['  （无）']),
  ]
  return lines.join('\n')
}

/**
 * 由装配计划派生状态（纯函数）——与方案 §7.3 第 7 步口径一致：
 * validation 有 error → validation-error；security 有 error → security-denied；否则 success。
 * 注：AssemblyPlan 本身不含 status 字段（plan.ts 定义），此处按诊断派生，供格式化与退出码复用。
 */
export function planStatus(plan: AssemblyPlan): string {
  if (plan.validation.diagnostics.some((d) => d.severity === 'error')) return 'validation-error'
  if (plan.security.diagnostics.some((d) => d.severity === 'error')) return 'security-denied'
  return 'success'
}

/**
 * 干跑退出码判定（纯函数，可单测）——A7：有 error 非 0。
 * 派生状态非 success（validation-error / security-denied）→ 1；否则 0。
 */
export function dryRunExitCode(plan: AssemblyPlan): number {
  return planStatus(plan) === 'success' ? 0 : 1
}

/** 帮助文本（纯函数） */
export function formatHelp(): string {
  return [
    'dsh config <子命令>',
    '',
    '子命令：',
    '  --expand <层文件…>   展开覆盖链为有效配置',
    '  --diff <层文件…>     输出覆盖链各层间变更 diff',
    '  --capabilities <层文件…>  能力令牌预颁发计划（A10）',
    '  --dry-run            干跑：展开 + 静态校验 + 动态校验 + 安全审计，不挂载',
    '  --lenient-capabilities  未声明能力插件视为全能力 + warning（S11 灰度）',
    '  --help               显示本帮助',
    '',
    '层文件：镜像阶段用 JSON 对象字面量抽象（并入 dsh 后对齐 cordis-yaml.ts）。',
  ].join('\n')
}

/**
 * CLI 展开阶段的受限求值上下文（S4 接线，批次 1b）。
 * 装载期无运行时服务注册表——`ctx.get` 返回 undefined（表达式据此短路）；
 * env 只允许白名单键（求值器内部再取快照，见 safe-eval.ts snapshotEnv）；
 * `dshHomePath` 基于 `$DSH_HOME`（缺省 cwd），仅做受控拼接。
 * 导出侳 AssemblyController.expand() 与测试复用（同一接线上下文）。
 */
export function defaultSafeEvalContext(): SafeEvalContext {
  const dshHome = process.env.DSH_HOME ?? process.cwd()
  return {
    get: (_key: string) => undefined,
    platform: process.platform,
    env: process.env,
    dshHomePath: (sub: string) => (sub ? `${dshHome}/${sub}` : dshHome),
    cwd: process.cwd(),
  }
}

/** 展开选项（S4 求值 + S5 敏感路径接线，缺省即安全默认）；导出供 AssemblyController 复用 */
export function defaultExpandOptions() {
  const safe = defaultSafeEvalContext()
  return {
    sensitivePaths: SENSITIVE_PATHS,
    evaluateDisabled: (expr: Parameters<typeof safeEvaluateExpression>[0]) =>
      Boolean(safeEvaluateExpression(expr, safe)),
  }
}

/**
 * CLI 编排入口（含 I/O）。格式化逻辑见各 format* 纯函数。
 */
export function run(argv: readonly string[]): string {
  const opts = parseArgv(argv)
  switch (opts.command) {
    case 'expand': {
      const layers = loadLayers(opts.sources)
      return formatExpanded(expandLayers(layers, defaultExpandOptions()))
    }
    case 'diff': {
      const layers = loadLayers(opts.sources)
      return formatDiff(diffLayers(layers))
    }
    case 'capabilities': {
      const layers = loadLayers(opts.sources)
      return formatCapabilities(expandLayers(layers, defaultExpandOptions()), {
        ...(opts.lenientCapabilities !== undefined ? { lenientCapabilities: opts.lenientCapabilities } : {}),
      })
    }
    case 'dry-run': {
      const plan = buildDryRunPlan(
        { sources: opts.sources },
        { ...(opts.lenientCapabilities !== undefined ? { lenientCapabilities: opts.lenientCapabilities } : {}) },
      )
      return formatDryRunPlan(plan)
    }
    case 'help':
    default:
      return formatHelp()
  }
}

/** 入口守卫：仅当本文件作为主模块执行时才触发 I/O（import 时不执行） */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  const argv = process.argv.slice(2)
  process.stdout.write(`${run(argv)}\n`)
  // A7：退出码在入口块处理——有 error（status 非 success）→ 1；缺省 run() 不触碰 process
  const opts = parseArgv(argv)
  if (opts.command === 'dry-run') {
    try {
      const plan = buildDryRunPlan(
        { sources: opts.sources },
        { ...(opts.lenientCapabilities !== undefined ? { lenientCapabilities: opts.lenientCapabilities } : {}) },
      )
      process.exitCode = dryRunExitCode(plan)
    } catch {
      process.exitCode = 1
    }
  }
}