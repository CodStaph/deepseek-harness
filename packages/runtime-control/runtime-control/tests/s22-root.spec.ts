/**
 * S22 root 调用者登记 + L4 自举面诚实登记测试。
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.10.2 / §5.10.3 / §5.11.4。
 * 覆盖：ROOT_CALLER 判定、markRootAudit 标注（复用 caller 语义、零新增字段）、
 *       L4 诚实登记常量存在、与普通 caller 区分。
 * 测试映射：R33 雏形（root 全量审计可识别）/ 精确验收项 R37。
 * 并入 dsh 仓库时转为 vitest describe/it 形态（镜像阶段用 node:test）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import {
  ROOT_CALLER,
  isRootCaller,
  markRootAudit,
  ROOT_SCOPE_NOTE,
} from '../src/meta/root.ts'

import type { EffectAuditEntry } from '../src/effect.ts'

/** 构造一条普通调用者的效果审计条目 */
function makeEntry(caller: string): EffectAuditEntry {
  return {
    timestamp: '2026-09-30T00:00:00.000Z',
    type: 'fs.write',
    target: '/workspace/cfg.json',
    caller,
    verdict: 'allow',
  }
}

test('S22-1 ROOT_CALLER 常量为 dsh-root', () => {
  assert.equal(ROOT_CALLER, 'dsh-root')
})

test('S22-2 isRootCaller：识别 root 调用者、排除普通 caller', () => {
  assert.equal(isRootCaller(ROOT_CALLER), true)
  assert.equal(isRootCaller('dsh-root'), true)
  assert.equal(isRootCaller('tool-fs#fiber-12'), false)
  assert.equal(isRootCaller('runtime-control'), false)
  assert.equal(isRootCaller(''), false)
})

test('S22-3 markRootAudit 标注后 audit.caller === ROOT_CALLER（复用 caller 语义，零新增字段）', () => {
  const plain = makeEntry('tool-fs#fiber-1')
  assert.equal(isRootCaller(plain.caller), false)

  const marked = markRootAudit(plain)
  assert.equal(marked.caller, ROOT_CALLER)
  assert.equal(isRootCaller(marked.caller), true)
  // 其余字段保持不变
  assert.equal(marked.type, plain.type)
  assert.equal(marked.target, plain.target)
  assert.equal(marked.verdict, plain.verdict)
  assert.equal(marked.timestamp, plain.timestamp)
  // 原对象未被修改（浅拷贝语义）
  assert.equal(plain.caller, 'tool-fs#fiber-1')
})

test('S22-4 markRootAudit(root=false) 不标注，原样返回', () => {
  const plain = makeEntry('tool-fs#fiber-1')
  const unmarked = markRootAudit(plain, false)
  assert.equal(unmarked.caller, 'tool-fs#fiber-1')
  assert.equal(isRootCaller(unmarked.caller), false)
})

test('S22-5 与普通 caller 区分：root 审计可被识别，普通审计不被误判', () => {
  const rootEntry = markRootAudit(makeEntry('tool-fs#fiber-1'))
  const pluginEntry = makeEntry('tool-net#fiber-3')
  assert.equal(isRootCaller(rootEntry.caller), true)
  assert.equal(isRootCaller(pluginEntry.caller), false)
  assert.notEqual(rootEntry.caller, pluginEntry.caller)
})

test('S22-6 L4 诚实登记常量存在且为非空文本', () => {
  assert.equal(typeof ROOT_SCOPE_NOTE, 'string')
  assert.ok(ROOT_SCOPE_NOTE.length > 0, 'ROOT_SCOPE_NOTE 非空')
  // 关键语义锚点
  assert.ok(ROOT_SCOPE_NOTE.includes('L4'), '含 L4 标识')
  assert.ok(ROOT_SCOPE_NOTE.includes('自举'), '含自举面说明')
  assert.ok(ROOT_SCOPE_NOTE.includes('谁管管理者'), '含残余边界诚实登记')
  assert.ok(ROOT_SCOPE_NOTE.includes('No-Löb'), '含 No-Löb 元层纪律')
  assert.ok(ROOT_SCOPE_NOTE.includes('无特殊豁免通道'), '含无豁免通道声明')
})
