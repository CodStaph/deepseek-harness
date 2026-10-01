/**
 * S13 执行隔离域测试（批次 2c）
 * 覆盖（node:test + assert/strict，ESM）：
 * - R8 雏形：createWhitelistedRequire 白名单 import——node:child_process 拒 /
 *   node:path 放行 / '@deepseek-ai/dsh-*' 通配符命中；
 * - 原型链冻结：freezeCriticalPrototypes 后 Object.prototype 冻结且 __proto__ 赋值抛
 *   SecurityViolation（R22 雏形——原型污染防护）；
 * - assignRealmLevel 各分支（无契约 / 有 capabilities / host+trusted / 其余）；
 * - enableRealm / --no-realm 兜底（验收 R13）：关闭后 assignRealmLevel 一律 'none'。
 *
 * 环境纪律：
 * - 真实 require 一律经 createRequire(import.meta.url) 取得 originalRequire，避免污染
 *   测试进程的全局 require；通配符命中用例用 stub originalRequire 转发，避免加载
 *   不存在的 '@deepseek-ai/dsh-*' 模块。
 * - freezeCriticalPrototypes 会永久冻结全局原型（不可解冻），该用例置于文件最末；
 *   后续不应再有依赖原型可写性的用例。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import type { EffectiveNode, PluginContract } from '@deepseek-ai/dsh-assembly'

import {
  createWhitelistedRequire,
  freezeCriticalPrototypes,
  assignRealmLevel,
  enableRealm,
  REALM_LEVELS,
} from '../src/realm.ts'
import { SecurityViolation } from '../src/membrane.ts'

const require = createRequire(import.meta.url)

/** 构造 EffectiveNode 最小实例 */
function node(contract?: PluginContract): EffectiveNode {
  return {
    id: 'p1', name: 'p1', config: {}, disabled: false, overrides: [],
    ...(contract !== undefined ? { contract } : {}),
  }
}

function contract(partial: Partial<PluginContract>): PluginContract {
  return {
    provides: [], needs: [], optional: [],
    plane: 'host', isolate: false,
    ...partial,
  }
}

/** 制作记录转发调用的 stub originalRequire（避免真实加载不存在的模块） */
function stubRequire() {
  const seen: string[] = []
  const req = ((s: string) => {
    seen.push(s)
    throw new Error(`stub-hit:${s}`)
  }) as unknown as NodeRequire
  req.resolve = ((s: string) => `resolved:${s}`) as NodeRequire['resolve']
  req.cache = {}
  req.main = undefined
  req.extensions = {} as NodeRequire['extensions']
  return { req, seen }
}

/* ──────────────── R8 雏形：受控 require 白名单 ──────────────── */

test('S13-1 createWhitelistedRequire：白名单外（node:child_process）抛 SecurityViolation（R8 雏形）', () => {
  const wl = REALM_LEVELS.standard.moduleWhitelist
  const controlled = createWhitelistedRequire(wl, require)
  assert.throws(
    () => controlled('node:child_process'),
    (e: unknown) =>
      e instanceof SecurityViolation
      && e.auditEntry.action === 'access-denied'
      && e.auditEntry.property === 'node:child_process'
      && e.auditEntry.reason === 'module-whitelist',
  )
})

test('S13-e2 createWhitelistedRequire：白名单内（node:path）放行并返回真实模块', () => {
  const wl = REALM_LEVELS.standard.moduleWhitelist
  const controlled = createWhitelistedRequire(wl, require)
  const pathMod = controlled('node:path')
  assert.ok(typeof pathMod === 'object' && pathMod !== null)
  assert.equal(typeof (pathMod as { join: unknown }).join, 'function')
})

test('S13-e3 通配符 "@deepseek-ai/dsh-*" 前缀命中；未命中非白名单抛 SecurityViolation', () => {
  const wl = REALM_LEVELS.standard.moduleWhitelist
  const { req, seen } = stubRequire()
  const controlled = createWhitelistedRequire(wl, req)

  // 通配符命中：不抛 SecurityViolation，转发给 original（stub 抛 stub-hit）
  assert.throws(
    () => controlled('@deepseek-ai/dsh-cache'),
    (e: unknown) => (e as Error).message === 'stub-hit:@deepseek-ai/dsh-cache',
  )
  assert.deepEqual(seen, ['@deepseek-ai/dsh-cache'])

  // 未命中：抛 SecurityViolation（node:fs 被拒——必须走效果系统）
  assert.throws(
    () => controlled('node:fs'),
    (e: unknown) => e instanceof SecurityViolation,
  )
})

test('S13-e4 保留 require.resolve 行为', () => {
  const wl = REALM_LEVELS.standard.moduleWhitelist
  const { req } = stubRequire()
  const controlled = createWhitelistedRequire(wl, req)
  assert.equal(controlled.resolve('node:path'), 'resolved:node:path')
})

/* ──────────────── assignRealmLevel 各分支（方案 5.4.5） ──────────────── */

test('S13-e5 assignRealmLevel：无契约 → none（向后兼容）', () => {
  assert.equal(assignRealmLevel(node(undefined), 'user'), 'none')
})

test('S13-e6 assignRealmLevel：有 capabilities 声明 → standard', () => {
  const n = node(contract({ capabilities: { fs: { read: ['**'] } } }))
  assert.equal(assignRealmLevel(n, 'user'), 'standard')
})

test('S13-e7 assignRealmLevel：preset/session 平面 → standard', () => {
  const preset = node(contract({ plane: 'preset' }))
  const session = node(contract({ plane: 'session' }))
  assert.equal(assignRealmLevel(preset, 'user'), 'standard')
  assert.equal(assignRealmLevel(session, 'trusted'), 'standard')
})

test('S13-e8 assignRealmLevel：host + trusted → none；其余 host 非 trusted → standard', () => {
  const host = node(contract({ plane: 'host' }))
  assert.equal(assignRealmLevel(host, 'trusted'), 'none')
  assert.equal(assignRealmLevel(host, 'user'), 'standard')
  assert.equal(assignRealmLevel(host, 'preset'), 'standard')
  assert.equal(assignRealmLevel(host, 'patch'), 'standard')
})

/* ──────────────── --no-realm 兜底（验收 R13） ──────────────── */

test('S13-e9 enableRealm：缺省启用；noRealm=true 关闭（纯函数，无 I/O）', () => {
  assert.equal(enableRealm(), true)
  assert.equal(enableRealm({}), true)
  assert.equal(enableRealm({ noRealm: true }), false)
  assert.equal(enableRealm({ noRealm: false }), true)
})

test('S13-e10 --no-realm 关闭后 assignRealmLevel 一律 none（无论契约/信任/平面）', () => {
  const cap = node(contract({ capabilities: { fs: { read: ['**'] } } }))
  const session = node(contract({ plane: 'session', capabilities: { network: { allow: [] } } }))
  const trustedHost = node(contract({ plane: 'host' }))
  const noContract = node(undefined)
  for (const n of [cap, session, trustedHost, noContract]) {
    assert.equal(assignRealmLevel(n, 'trusted', { noRealm: true }), 'none')
  }
  // 开启时（enableRealm 判定 true）正常分配
  assert.equal(assignRealmLevel(cap, 'user'), 'standard')
})

/* ──────────────── 原型链冻结（R22 雏形）——必须置于文件最末 ──────────────── */

test('S13-e11 freezeCriticalPrototypes：Object.prototype 冻结 + __proto__ 赋值抛 SecurityViolation（R22 雏形）', () => {
  freezeCriticalPrototypes()
  assert.equal(Object.isFrozen(Object.prototype), true)
  assert.equal(Object.isFrozen(Array.prototype), true)

  const victim: Record<string, unknown> = {}
  assert.throws(
    () => { victim.__proto__ = { injected: true } },
    (e: unknown) =>
      e instanceof SecurityViolation
      && e.auditEntry.action === 'write-denied'
      && e.auditEntry.reason === 'prototype-frozen',
  )
  // 原型未被污染
  assert.equal((victim as unknown as { injected?: boolean }).injected, undefined)
})