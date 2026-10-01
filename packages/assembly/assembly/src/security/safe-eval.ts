/**
 * 装配控制层 · `!!js` 白名单求值器
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §4.3.2（白名单求值器，第 567–627 行）
 * 替换对象：dsh 仓库 `vendor/loader/src/config/utils.ts` 的裸 eval 实现
 *   `new Function('ctx','expr','with (ctx) { return eval(expr) }')` —— 无 AST、无白名单。
 * 阶段：S4（批次 1b·任务 3）；acorn 复用 dsh workspace 既有依赖（M0 T0.2 证实），零新增供应链面。
 *
 * ── 防逃逸设计与局限（诚实声明）────────────────────────────────────────────
 * 1. AST 校验：用 acorn 把表达式解析为 AST，逐节点做「类型白名单 + 类型黑名单 +
 *    自由标识符白名单 + 成员对象白名单 + 成员属性面 + env key 白名单」校验，任何一项
 *    不通过即拒绝进入求值（装载期失败，而非运行期暴雷）。
 * 2. 受控求值：通过校验后，将表达式交 `new Function` 构造的闭包执行，闭包仅以三个
 *    受控参数（ctx / process / dshHomePath）作为自由变量，参数名遮蔽同名全局；校验阶段
 *    已保证表达式体内不存在这 3 个白名单根之外的任何自由标识符，故求值体内无法解析到
 *    `globalThis`、`require`、`module`、真实 `process` 等任意全局。不使用 `eval`，不使用 `with`。
 * 3. 局限（不承诺超越白名单的安全）：白名单是刻意收窄的集合（7 种节点）；MemberExpression
 *    的 object 必须落回白名单根（ctx/process/dshHomePath），因此字符串/数字/正则字面量的
 *    自有方法调用（如 `'x'.trim()`）也会被拒绝——这是安全取舍，不视为缺陷。本求值器只承诺：
 *    通过校验的表达式，在受控闭包对象上求值，不存在可证明的逃逸路径。
 * ─────────────────────────────────────────────────────────────────────────
 *
 * SEC 码位说明：`!!js` 白名单求值违规登记为 **SEC-1015**（2026-09-30 用户裁定：登记）。
 * 论证（§5.11.1 信任语义准入）：白名单求值器是"拒不执行的可执行表达式"判定面——通过校验的
 * 表达式将被 `new Function` 执行，违规检出即拒绝注入，属防御"可被冒充/可破坏一致性"的信任通道，
 * 非纯工程机制；与既有 SEC-1002（非 disabled 元数据含 !!js）、SEC-1003（disabled 语法错误）语义
 * 边界清晰、不重复。登记表建档见《SEC-码位登记表.md》。
 */

import { parse } from 'acorn'
import type { Diagnostic } from '../validators/types.ts'
import type { ExpressionNode } from '../resolver.ts'

/** 白名单上下文——求值表达式仅能访问这些受限对象（方案 §4.3.2） */
export interface SafeEvalContext {
  /** ctx.get(key) ——仅允许访问已注册的服务，参数必须为字符串字面量 */
  get: (key: string) => unknown
  /** process.platform ——只读属性 */
  readonly platform: string
  /** process.env 中的白名单 key（仅白名单键可见） */
  readonly env: Readonly<Record<string, string | undefined>>
  /** dshHomePath(sub) ——仅允许受控路径拼接，不允许任意路径 */
  dshHomePath: (sub: string) => string
  /** process.cwd() ——只读 */
  readonly cwd: string
}

/** 允许的语法结构白名单（方案 §4.3.2） */
export const ALLOWED_SYNTAX = [
  'MemberExpression',      // ctx.get('x')
  'CallExpression',        // ctx.get('x')、dshHomePath('x')
  'LogicalExpression',     // a || b、a && b
  'ConditionalExpression', // a ? b : c
  'BinaryExpression',      // a === b
  'Literal',               // 'string'、123、true
  'Identifier',            // ctx、process
] as const
export type AllowedSyntax = (typeof ALLOWED_SYNTAX)[number]

/** 禁止的语法结构黑名单（方案 §4.3.2，二次保险） */
export const FORBIDDEN_SYNTAX = [
  'FunctionExpression',      // 不允许定义函数
  'ArrowFunctionExpression', // 不允许箭头函数
  'NewExpression',           // 不允许 new
  'AssignmentExpression',    // 不允许赋值
  'UpdateExpression',        // 不允许 ++/--
  'AwaitExpression',         // 不允许 await
  'YieldExpression',         // 不允许 yield
  'ImportExpression',        // 不允许 import()
] as const
export type ForbiddenSyntax = (typeof FORBIDDEN_SYNTAX)[number]

/** 白名单 env key 初始集合（方案 §4.3.2，可扩展） */
export const ALLOWED_ENV_KEYS = [
  'DSH_TELEMETRY_MODE',
  'DSH_TELEMETRY_OTLP_URL',
  'DSH_TELEMETRY_DISABLED',
  'DSH_PERMISSION_MODE',
  'DSH_HOME',
  'DEEPSEEK_API_KEY',
] as const
export type AllowedEnvKey = (typeof ALLOWED_ENV_KEYS)[number]

/** 白名单根标识符——自由标识符只能落在这三个根上 */
const ALLOWED_ROOTS = new Set<string>(['ctx', 'process', 'dshHomePath'])
/** process 只读字段白名单 */
const PROCESS_READONLY_KEYS = new Set<string>(['platform', 'cwd'])

// 运行期查找集合（白名单/黑名单/env 键）
const ALLOWED_SYNTAX_SET = new Set<string>(ALLOWED_SYNTAX)
const FORBIDDEN_SYNTAX_SET = new Set<string>(FORBIDDEN_SYNTAX)
const ALLOWED_ENV_KEYS_SET = new Set<string>(ALLOWED_ENV_KEYS)

/** 白名单求值违规（方案 §4.3.2 步骤 6） */
export interface SafeEvalViolation {
  /** 违规位置（AST 类型链） */
  path: string
  /** 违规原因 */
  reason: string
}

/** 求值器违规异常——evaluateJs / safeEvaluateExpression 校验未通过时抛出 */
export class SafeEvalError extends Error {
  readonly violations: readonly SafeEvalViolation[]
  constructor(violations: readonly SafeEvalViolation[]) {
    super(
      violations.length === 0
        ? '!!js 白名单求值失败'
        : `!!js 白名单求值违规 ${violations.length} 处：${violations
            .map((v) => `${v.path} → ${v.reason}`)
            .join('；')}`,
    )
    this.name = 'SafeEvalError'
    this.violations = violations
  }
}

/** 成员链解析结果 */
interface MemberChain {
  /** 链的根标识符（非法链为 null） */
  root: string | null
  /** 属性路径（由外向内，最后一个是紧邻根的属性） */
  props: string[]
  /** 链是否合法（全程为 MemberExpression/Identifier/字面量下标） */
  ok: boolean
}

/** 解析成员链：`a.b.c` → { root:'a', props:['c','b'] } */
function memberChain(node: unknown): MemberChain {
  const props: string[] = []
  let cur: unknown = node
  while (
    cur &&
    typeof cur === 'object' &&
    (cur as { type?: string }).type === 'MemberExpression'
  ) {
    const m = cur as {
      computed?: boolean
      property?: { type?: string; name?: string; value?: unknown }
    }
    let key: string | null = null
    if (m.computed) {
      const p = m.property
      if (p && p.type === 'Literal' && typeof p.value === 'string') key = p.value
    } else {
      const p = m.property
      if (p && p.type === 'Identifier' && typeof p.name === 'string') key = p.name
    }
    if (key === null) return { root: null, props, ok: false }
    props.push(key)
    cur = (cur as { object?: unknown }).object
  }
  const c = cur as { type?: string; name?: string }
  if (c && typeof c === 'object' && c.type === 'Identifier' && typeof c.name === 'string') {
    return { root: c.name, props, ok: true }
  }
  return { root: null, props, ok: false }
}

/** 校验成员表达式语义（对象白名单 + 属性面 + env key） */
function checkMember(node: unknown, asCallee: boolean, out: SafeEvalViolation[]): void {
  const chain = memberChain(node)
  if (!chain.ok || chain.root === null) {
    out.push({ path: 'member', reason: '成员表达式必须为 ctx/process/dshHomePath 的标识符链' })
    return
  }
  const { root, props } = chain
  if (!ALLOWED_ROOTS.has(root)) {
    out.push({ path: root, reason: `根标识符 ${root} 不在白名单（仅允许 ctx/process/dshHomePath）` })
    return
  }
  if (root === 'ctx') {
    // ctx 仅允许 `.get` 方法，且必须被调用（裸 ctx.get 会泄漏可调用函数）
    if (props.length !== 1 || props[0] !== 'get') {
      out.push({ path: 'ctx', reason: 'ctx 仅允许访问 get 方法' })
    } else if (!asCallee) {
      out.push({ path: 'ctx.get', reason: 'ctx.get 必须被调用，禁止单独取值' })
    }
    return
  }
  if (root === 'dshHomePath') {
    // dshHomePath 仅作为函数调用，不允许取属性
    out.push({ path: 'dshHomePath', reason: 'dshHomePath 不允许属性访问（仅作函数调用）' })
    return
  }
  // root === 'process'
  if (props.length === 1 && PROCESS_READONLY_KEYS.has(props[0] as string)) {
    if (asCallee) {
      out.push({ path: `process.${props[0]}`, reason: `process.${props[0]} 为只读属性，不允许被调用` })
    }
    return
  }
  if (props.length === 2 && props[1] === 'env' && ALLOWED_ENV_KEYS_SET.has(props[0] as string)) {
    if (asCallee) {
      out.push({ path: `process.env.${props[0]}`, reason: 'env 键值为字符串，不允许被调用' })
    }
    return
  }
  out.push({
    path: 'process',
    reason: 'process 仅允许访问 platform/cwd 与白名单 env 键（DSH_TELEMETRY_MODE 等 6 个）',
  })
}

/** 校验调用表达式语义（callee 必须为 ctx.get 或 dshHomePath，参数须为单个字符串字面量） */
function checkCall(node: unknown, out: SafeEvalViolation[]): void {
  const callee = (node as { callee?: unknown }).callee
  const args = (node as { arguments?: unknown[] }).arguments
  const c = callee as { type?: string; name?: string }
  const argIsStringLiteral =
    args !== undefined &&
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === 'object' &&
    (args[0] as { type?: string }).type === 'Literal' &&
    typeof (args[0] as { value?: unknown }).value === 'string'

  if (c?.type === 'Identifier') {
    if (c.name === 'dshHomePath') {
      if (!argIsStringLiteral) {
        out.push({ path: 'dshHomePath', reason: 'dshHomePath() 参数必须为单个字符串字面量' })
      }
      return
    }
    out.push({ path: c.name ?? '<unknown>', reason: '仅允许调用 ctx.get(...) 或 dshHomePath(...)' })
    return
  }
  if (c?.type === 'MemberExpression') {
    const chain = memberChain(callee)
    if (chain.ok && chain.root === 'ctx' && chain.props.length === 1 && chain.props[0] === 'get') {
      if (!argIsStringLiteral) {
        out.push({ path: 'ctx.get', reason: 'ctx.get() 参数必须为单个字符串字面量' })
      }
      return
    }
    out.push({ path: 'call', reason: '仅允许调用 ctx.get(...) 或 dshHomePath(...)' })
    return
  }
  out.push({ path: 'call', reason: '仅允许调用 ctx.get(...) 或 dshHomePath(...)' })
}

/** 递归遍历表达式，校验类型白名单/黑名单与自由标识符 */
function walk(node: unknown, asCallee: boolean, out: SafeEvalViolation[], loc: string): void {
  if (!node || typeof node !== 'object') return
  const type = (node as { type?: string }).type ?? '<unknown>'
  // 类型白名单（白名单即允许集合）+ 黑名单二次保险
  if (!ALLOWED_SYNTAX_SET.has(type)) {
    out.push({ path: loc, reason: `语法结构 ${type} 不在白名单` })
    return
  }
  if (FORBIDDEN_SYNTAX_SET.has(type)) {
    out.push({ path: loc, reason: `语法结构 ${type} 被禁止` })
    return
  }
  switch (type) {
    case 'Identifier': {
      const name = (node as { name?: string }).name ?? ''
      if (!ALLOWED_ROOTS.has(name)) {
        out.push({ path: loc, reason: `标识符 ${name} 不在白名单（仅允许 ctx/process/dshHomePath）` })
      }
      return
    }
    case 'Literal':
      return
    case 'MemberExpression':
      checkMember(node, asCallee, out)
      return
    case 'CallExpression':
      checkCall(node, out)
      // 递归校验参数（对非字面量参数给出更精确诊断）
      for (const a of (node as { arguments?: unknown[] }).arguments ?? []) {
        walk(a, false, out, `${loc}.arg`)
      }
      return
    case 'LogicalExpression':
    case 'BinaryExpression':
      walk((node as { left?: unknown }).left, false, out, `${loc}.left`)
      walk((node as { right?: unknown }).right, false, out, `${loc}.right`)
      return
    case 'ConditionalExpression':
      walk((node as { test?: unknown }).test, false, out, `${loc}.test`)
      walk((node as { consequent?: unknown }).consequent, false, out, `${loc}.consequent`)
      walk((node as { alternate?: unknown }).alternate, false, out, `${loc}.alternate`)
      return
    default:
      return
  }
}

/** 纯静态校验：通过白名单/黑名单/对象白名单/env 校验返回空数组，否则返回违规列表 */
export function validateExpression(expr: string): SafeEvalViolation[] {
  const violations: SafeEvalViolation[] = []
  let ast: unknown
  try {
    // allowAwaitOutsideFunction/allowReturnOutsideFunction：放宽顶层 await/yield 的
    // parse 限制，使其进入 AST 后由类型黑名单显式拒绝（诊断更精确），而非笼统语法错误
    ast = parse(expr, {
      ecmaVersion: 'latest',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    })
  } catch (e) {
    return [
      { path: '<root>', reason: `表达式语法错误：${e instanceof Error ? e.message : String(e)}` },
    ]
  }
  const body = (ast as { body?: unknown[] }).body
  if (!body || body.length === 0) {
    violations.push({ path: '<root>', reason: '空表达式' })
    return violations
  }
  if (body.length !== 1) {
    violations.push({ path: '<root>', reason: '仅允许单个表达式，不允许多条语句' })
  }
  const stmt = body[0] as { type?: string; expression?: unknown }
  if (stmt.type !== 'ExpressionStatement') {
    violations.push({ path: '<root>', reason: `顶层必须是表达式语句，实际为 ${stmt.type ?? '<unknown>'}` })
  }
  walk(stmt.expression, false, violations, '$expr')
  return violations
}

/** 受限求值：校验通过后，在受控闭包对象上执行；违规抛 SafeEvalError */
export function evaluateJs(expr: string, ctx: SafeEvalContext): unknown {
  const violations = validateExpression(expr)
  if (violations.length > 0) throw new SafeEvalError(violations)
  // 受限快照：process 只暴露 platform/cwd/白名单 env；白名单键浅拷贝，杜绝暴露其余 env
  const processSnapshot = Object.freeze({
    platform: ctx.platform,
    cwd: ctx.cwd,
    env: Object.freeze(snapshotEnv(ctx.env)),
  })
  const dshHomePath = ctx.dshHomePath
  // new Function 以 ctx/process/dshHomePath 为参数名遮蔽同名全局；校验已保证体内无其他自由标识符
  const fn = new Function(
    'ctx',
    'process',
    'dshHomePath',
    `'use strict';\nreturn (${expr});`,
  )
  return fn(ctx, processSnapshot, dshHomePath)
}

/** 包装 ExpressionNode 版本的受限求值 */
export function safeEvaluateExpression(node: ExpressionNode, ctx: SafeEvalContext): unknown {
  return evaluateJs(node.source, ctx)
}

/** 把白名单违规转换为装载期 Diagnostic（code = SEC-1015，2026-09-30 用户裁定登记） */
export function toDiagnostic(
  violations: readonly SafeEvalViolation[],
  opts?: { file?: string; nodeId?: string },
): Diagnostic[] {
  return violations.map((v) => ({
    severity: 'error' as const,
    message: `!!js 白名单求值违规（${v.path}）：${v.reason}`,
    ...(opts?.nodeId !== undefined ? { nodeId: opts.nodeId } : {}),
    ...(opts?.file !== undefined ? { file: opts.file } : {}),
    code: 'SEC-1015',
  }))
}

/** 从上下文 env 提取白名单键快照 */
function snapshotEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const k of ALLOWED_ENV_KEYS) out[k] = env[k]
  return out
}