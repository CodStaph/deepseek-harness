/**
 * S4 `!!js` 白名单求值器测试
 *
 * 目的：验证 safe-eval.ts 的静态校验（validateExpression）与受限求值（evaluateJs）行为。
 * 并入 dsh 仓库时转为 vitest describe/it 形态（镜像阶段用 node:test，零测试框架依赖）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import {
  ALLOWED_SYNTAX,
  FORBIDDEN_SYNTAX,
  ALLOWED_ENV_KEYS,
  validateExpression,
  evaluateJs,
  safeEvaluateExpression,
  toDiagnostic,
  SafeEvalError,
} from '../src/security/safe-eval.ts'

import type { SafeEvalContext } from '../src/security/safe-eval.ts'

/** 构造测试用受限上下文 */
function makeCtx(overrides: Partial<SafeEvalContext> = {}): SafeEvalContext {
  return {
    get: (key: string) => ({ sandbox: 'value', x: 41 })[key] ?? undefined,
    platform: 'win32',
    env: {
      DSH_TELEMETRY_MODE: 'on',
      DSH_TELEMETRY_OTLP_URL: 'http://localhost:4318',
      DSH_TELEMETRY_DISABLED: 'true',
      DSH_PERMISSION_MODE: 'strict',
      DSH_HOME: '/home/dsh',
      DEEPSEEK_API_KEY: 'sk-test',
      UNDECLARED: 'secret',
    },
    dshHomePath: (sub: string) => `/home/dsh/${sub}`,
    cwd: '/home/dsh',
    ...overrides,
  }
}

test('S4-1 白名单/黑名单清单与方案 §4.3.2 一致', () => {
  assert.deepEqual([...ALLOWED_SYNTAX], [
    'MemberExpression',
    'CallExpression',
    'LogicalExpression',
    'ConditionalExpression',
    'BinaryExpression',
    'Literal',
    'Identifier',
  ])
  assert.deepEqual([...FORBIDDEN_SYNTAX], [
    'FunctionExpression',
    'ArrowFunctionExpression',
    'NewExpression',
    'AssignmentExpression',
    'UpdateExpression',
    'AwaitExpression',
    'YieldExpression',
    'ImportExpression',
  ])
  assert.deepEqual([...ALLOWED_ENV_KEYS], [
    'DSH_TELEMETRY_MODE',
    'DSH_TELEMETRY_OTLP_URL',
    'DSH_TELEMETRY_DISABLED',
    'DSH_PERMISSION_MODE',
    'DSH_HOME',
    'DEEPSEEK_API_KEY',
  ])
})

test('S4-2 合法表达式通过静态校验', () => {
  const passCases = [
    `ctx.get('sandbox')`,
    `ctx.get('x') && process.platform === 'win32'`,
    `dshHomePath('sessions') + '/x'`,
    `process.env.DSH_HOME`,
    `process.env['DSH_PERMISSION_MODE']`,
    `process.platform`,
    `process.cwd`,
    `true`,
    `123`,
    `'str'`,
    `ctx.get('a') ? ctx.get('b') : ctx.get('c')`,
    `(ctx.get('x') || 1) + 2`,
    `ctx.get('x') || ctx.get('y') && process.platform === 'linux'`,
  ]
  for (const expr of passCases) {
    const v = validateExpression(expr)
    assert.deepEqual(v, [], `应通过校验: ${expr} → ${JSON.stringify(v)}`)
  }
})

test('S4-3 非法语法结构被拒绝', () => {
  const failCases: Array<[string, RegExp]> = [
    ['() => 1', /ArrowFunctionExpression|被禁止/],
    ['(function () { return 1 })', /FunctionExpression|被禁止/],
    ['new Foo()', /NewExpression|被禁止/],
    ['x = 1', /AssignmentExpression|被禁止/],
    ['x++', /UpdateExpression|被禁止/],
    ['await foo', /AwaitExpression|被禁止/],
    ['import("x")', /ImportExpression|被禁止/],
    ['`template`', /TemplateLiteral|不在白名单/],
    ['[1,2]', /ArrayExpression|不在白名单/],
    ['({a:1})', /ObjectExpression|不在白名单/],
    ['throw 1', /ThrowStatement|不在白名单/],
  ]
  for (const [expr, re] of failCases) {
    const v = validateExpression(expr)
    assert.ok(v.length > 0, `应拒绝 ${expr}`)
    assert.match(JSON.stringify(v), re, `拒绝原因应匹配：${expr}`)
  }
})

test('S4-4 非法标识符/成员访问被拒绝', () => {
  const failCases = [
    'globalThis',
    'globalThis.x',
    'require("x")',
    'module',
    'process.mainModule',
    'process.execPath',
    'process.version',
    'process.env.UNDECLARED',      // 非白名单 env key
    'process.env["UNDECLARED"]',   // 非白名单 env key（computed 下标）
    'process.env',                 // 裸 env 对象访问（不允许读取整个 env）
    'process.cwd()',               // cwd 为只读属性，不允许被调用
    'process.platform()',          // platform 为只读属性，不允许被调用
    'ctx.foo',                     // ctx 只允许 get
    'dshHomePath.foo',             // dshHomePath 不允许属性
    'ctx.get()',
    'ctx.get(a)',                  // 参数非字符串字面量
    'ctx.get(1)',
    'ctx.get("a", "b")',
    'dshHomePath()',
    'dshHomePath(123)',
    'ctx.get("a") + globalThis',
  ]
  for (const expr of failCases) {
    const v = validateExpression(expr)
    assert.ok(v.length > 0, `应拒绝 ${expr}`)
  }
})

test('S4-5 白名单 env key 精确控制', () => {
  for (const key of ALLOWED_ENV_KEYS) {
    assert.deepEqual(validateExpression(`process.env.${key}`), [], `白名单键应通过：${key}`)
  }
  for (const bad of ['UNDECLARED', 'DSH_NOPE', 'HOME', 'PATH']) {
    assert.ok(validateExpression(`process.env.${bad}`).length > 0, `非白名单键应拒绝：${bad}`)
  }
})

test('S4-6 求值正确性：短路与值', () => {
  const ctx = makeCtx()
  // 短路：true || ... 不调用 get
  let getCalls = 0
  const shortCtx: SafeEvalContext = { ...ctx, get: () => { getCalls += 1; return 'nope' } }
  assert.equal(evaluateJs(`true || ctx.get('x')`, shortCtx), true)
  assert.equal(getCalls, 0, '短路 || 不应调用 ctx.get')

  assert.equal(evaluateJs(`process.platform === 'win32'`, ctx), true)
  assert.equal(evaluateJs(`process.platform`, ctx), 'win32')
  assert.equal(evaluateJs(`process.cwd`, ctx), '/home/dsh')
  assert.equal(evaluateJs(`process.env.DSH_HOME`, ctx), '/home/dsh')
  assert.equal(evaluateJs(`process.env.DEEPSEEK_API_KEY`, ctx), 'sk-test')
  assert.equal(evaluateJs(`ctx.get('sandbox')`, ctx), 'value')
  assert.equal(evaluateJs(`ctx.get('x')`, ctx), 41)
  assert.equal(evaluateJs(`dshHomePath('sessions') + '/x'`, ctx), '/home/dsh/sessions/x')
  assert.equal(evaluateJs(`ctx.get('a') ? 1 : 2`, ctx), 2)
  assert.equal(evaluateJs(`(ctx.get('x') || 0) + 1`, ctx), 42)
  assert.equal(evaluateJs(`'win32' === process.platform && true`, ctx), true)
})

test('S4-7 safeEvaluateExpression 与 toDiagnostic（code=SEC-1015）', () => {
  const ctx = makeCtx()
  assert.equal(safeEvaluateExpression({ source: `ctx.get('sandbox')` }, ctx), 'value')
  const violations = validateExpression('new Date()')
  assert.ok(violations.length > 0)
  const diags = toDiagnostic(violations, { file: 'x.yaml', nodeId: 'node-1' })
  assert.equal(diags.length, violations.length)
  assert.equal(diags[0]?.severity, 'error')
  assert.equal(diags[0]?.nodeId, 'node-1')
  assert.equal(diags[0]?.file, 'x.yaml')
  assert.equal(diags[0]?.code, 'SEC-1015', '码位已裁定登记（裁定 8A）')
})

test('S4-8 非法表达式求值抛 SafeEvalError', () => {
  const ctx = makeCtx()
  assert.throws(() => evaluateJs('new Date()', ctx), SafeEvalError)
  assert.throws(() => evaluateJs('x => x', ctx), SafeEvalError)
  assert.throws(() => evaluateJs('process.env.UNDECLARED', ctx), SafeEvalError)
  assert.throws(() => safeEvaluateExpression({ source: 'globalThis' }, ctx), SafeEvalError)
})

test('S4-9 语法错误产生违规（非静默）', () => {
  const v = validateExpression('ctx.get(') // 未闭合
  assert.ok(v.length > 0)
  assert.match(v[0]?.reason ?? '', /语法错误/)
})

test('S4-10 求值体内 process 为受限快照（参数遮蔽全局，防逃逸核心证据）', () => {
  // mock-os 不是任何真实平台名——若求值命中全局 process 而非快照，此断言必失败
  const ctx = makeCtx({ platform: 'mock-os', env: { DSH_HOME: '/mock/home' }, cwd: '/mock/cwd' })
  assert.equal(evaluateJs('process.platform', ctx), 'mock-os')
  assert.equal(evaluateJs(`process.platform === 'mock-os'`, ctx), true)
  assert.notEqual(evaluateJs('process.platform', ctx), process.platform, '不得命中全局 process')
  assert.equal(evaluateJs('process.env.DSH_HOME', ctx), '/mock/home')
  assert.equal(evaluateJs('process.cwd', ctx), '/mock/cwd')
})

test('S4-11 逃逸向量补充自检（构造器/原型/返回值成员/重复调用）', () => {
  const escapes = [
    'process.env.constructor',
    'process.constructor',
    'process.env.DSH_HOME.constructor',
    'ctx.get("x").constructor',
    'ctx.constructor',
    'dshHomePath.call(null, "x")',
    'ctx.get("x")()',
    '(process.env.DSH_HOME).length',
    'process.env["DSH_HOME"]["length"]',
    'ctx.env',
    'ctx.platform',
    'ctx.get("x").get("y")',
    'typeof process',
    '!true',
    '-1',
    '(ctx.get("a"), ctx.get("b"))',
  ]
  for (const expr of escapes) {
    assert.ok(validateExpression(expr).length > 0, `逃逸向量应被拒绝：${expr}`)
  }
})