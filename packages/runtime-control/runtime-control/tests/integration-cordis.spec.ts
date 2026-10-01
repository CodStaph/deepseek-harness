/**
 * 批次 1-4 · 膜挂 Context.get 真实接线测试（integration-cordis）。
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.1.3；阶段 S10/批次 1-4。
 * 覆盖：
 * - wrapReflectGet 包装 reflect.get 底层：对象服务装膜（自定义配置生效 +
 *   未注册回退 DEFAULT_MEMBRANE）、原始值/undefined/null 直通、strict 透传
 * - 还原函数把 reflect.get 恢复为原实现
 * - installMembraneOnContext：最小 { reflect: { get } } 结构对象走通
 *   （真实 Cordis Context 带符号隔离键与内核服务成员，无法手工构造；
 *   mock reflect 即可覆盖包装逻辑——批次 1-4 测试裁定）
 * 编号说明：IC = integration-cordis（本文件不在红线清单，不占 R 编号）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import {
  wrapReflectGet,
  installMembraneOnContext,
  type ReflectLike,
} from '../src/integration-cordis.ts'
import { SecurityViolation } from '../src/membrane.ts'
import type { MembraneAuditEntry, MembraneConfig } from '../src/membrane.ts'
import type { Context } from '@deepseek-ai/cordis'

/** 自定义膜配置——与 DEFAULT_MEMBRANE 可区分（hidden/blocked 为其独有语义） */
const FS_MEMBRANE: MembraneConfig = {
  readonly: ['mode'],
  sealed: [],
  hidden: ['internal'],
  blocked: ['setMode'],
}

/** 审计接收器——收集膜拦截产生的 MembraneAuditEntry */
function auditSink() {
  const entries: MembraneAuditEntry[] = []
  return { entries, cb: (e: MembraneAuditEntry) => { entries.push(e) } }
}

/**
 * mock 反射层——模拟 ReflectService.get：按服务名返回 store 值，
 * 可选记录每次调用的 (name, strict) 实参。
 */
function makeReflect(
  store: Record<string, unknown>,
  calls?: Array<[name: string, strict: boolean | undefined]>,
): ReflectLike {
  return {
    get(name: string, strict?: boolean): unknown {
      calls?.push([name, strict])
      return store[name]
    },
  }
}

/* ─────────────── wrapReflectGet：装膜与直通 ─────────────── */

test('IC-1 对象服务装膜：自定义配置生效、方法透过膜仍可调用', () => {
  const { entries, cb } = auditSink()
  const raw = { mode: 'strict', read: () => 'ok', setMode: () => 'ok', internal: { s: 1 } }
  const reflect = makeReflect({ fs: raw })
  const configs = new Map<string, MembraneConfig>([['fs', FS_MEMBRANE]])
  const restore = wrapReflectGet(reflect, configs, cb)

  const fs = reflect.get('fs') as { mode: string, read: () => string, setMode: () => string, internal: unknown }
  assert.notStrictEqual(fs, raw, '返回的应是膜代理而非原始引用')
  // 属性读取与方法调用（get 返回绑定原始对象的函数）透过膜正常工作
  assert.equal(fs.mode, 'strict')
  assert.equal(fs.read(), 'ok')
  // 自定义配置生效：readonly 拒写、hidden 拒访问、blocked 拒调用
  assert.throws(() => { fs.mode = 'full' }, (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'write-denied')
  assert.throws(() => { void fs.internal }, (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'access-denied')
  assert.throws(() => { fs.setMode() }, (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'call-blocked')
  assert.equal(entries.length, 3)
  restore()
})

test('IC-2 原始值（string/number/boolean）不包装，原样返回', () => {
  const { cb } = auditSink()
  const reflect = makeReflect({ name: 'dsh', answer: 42, flag: true })
  const restore = wrapReflectGet(reflect, new Map(), cb)
  assert.equal(reflect.get('name'), 'dsh')
  assert.equal(reflect.get('answer'), 42)
  assert.equal(reflect.get('flag'), true)
  restore()
})

test('IC-3 未提供（undefined）与空值（null）的服务原样透传', () => {
  const { cb } = auditSink()
  const reflect = makeReflect({ none: undefined, empty: null })
  const restore = wrapReflectGet(reflect, new Map(), cb)
  assert.equal(reflect.get('none'), undefined)
  assert.equal(reflect.get('未注册服务名'), undefined)
  assert.equal(reflect.get('empty'), null)
  restore()
})

test('IC-4 未命中注册表的对象服务回退 DEFAULT_MEMBRANE（默认只读）', () => {
  const { entries, cb } = auditSink()
  const raw = { mode: 'default', value: 1 }
  const reflect = makeReflect({ helper: raw })
  const restore = wrapReflectGet(reflect, new Map(), cb)

  const helper = reflect.get('helper') as { mode: string, value: number }
  assert.notStrictEqual(helper, raw)
  // DEFAULT_MEMBRANE 的 readonly 含 mode：拒写并记审计
  assert.throws(() => { helper.mode = 'x' }, (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'write-denied')
  assert.equal(entries.length, 1)
  // 非 readonly 属性可写——默认膜不扩大拒绝面
  helper.value = 2
  assert.equal(raw.value, 2)
  restore()
})

/* ─────────────── wrapReflectGet：语义保持与还原 ─────────────── */

test('IC-5 strict 实参透传：省略传 undefined、显式实参原样到达底层', () => {
  const { cb } = auditSink()
  const calls: Array<[name: string, strict: boolean | undefined]> = []
  const reflect = makeReflect({ fs: { mode: 'x' } }, calls)
  const restore = wrapReflectGet(reflect, new Map(), cb)
  void reflect.get('fs')
  void reflect.get('fs', false)
  assert.deepEqual(calls, [['fs', undefined], ['fs', false]])
  restore()
})

test('IC-6 还原函数把 reflect.get 恢复为原实现（裸引用直出）', () => {
  const { cb } = auditSink()
  const raw = { mode: 'plain' }
  const reflect = makeReflect({ svc: raw })
  const restore = wrapReflectGet(reflect, new Map(), cb)
  assert.notStrictEqual(reflect.get('svc'), raw)
  restore()
  assert.strictEqual(reflect.get('svc'), raw, '还原后应直出原始引用')
  // 还原是干净的：可再次包装
  const restore2 = wrapReflectGet(reflect, new Map(), cb)
  assert.notStrictEqual(reflect.get('svc'), raw)
  restore2()
})

/* ─────────────── installMembraneOnContext：高层接线 ─────────────── */

test('IC-7 installMembraneOnContext：最小 { reflect: { get } } 结构对象走通', () => {
  const { entries, cb } = auditSink()
  const rawFs = { mode: 'strict', value: 1 }
  const reflect = makeReflect({ fs: rawFs })
  // Context 与 { reflect: ReflectLike } 结构可比（Context.reflect 兼容
  // ReflectLike），故以最小结构对象验证高层接线的转发语义。
  const ctx = { reflect } as Context
  const configs = new Map<string, MembraneConfig>([['fs', FS_MEMBRANE]])
  const restore = installMembraneOnContext(ctx, configs, cb)

  const fs = ctx.reflect.get('fs') as { mode: string }
  assert.notStrictEqual(fs, rawFs, '经 installMembraneOnContext 应装膜')
  assert.throws(() => { fs.mode = 'y' }, (e: unknown) => e instanceof SecurityViolation && e.auditEntry.action === 'write-denied')
  assert.equal(entries.length, 1)
  restore()
  assert.strictEqual(ctx.reflect.get('fs'), rawFs, '还原后直出原始引用')
})
