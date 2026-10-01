/**
 * S1 骨架冒烟测试（非正式验收——A1–A10 门禁属 M1 收口全量回归）。
 * 目的：验证契约/计划类型闭环可构造、入口导出齐备、AssemblyController 骨架
 *       拒绝未实现调用（不假实现）。
 * 并入 dsh 仓库时转为 vitest describe/it 形态（镜像阶段用 node:test，零测试框架依赖）。
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'

import {
  AssemblyController,
} from '../src/index.ts'

import type {
  PluginContract,
  CapabilityDeclaration,
  AssemblyPlan,
  CapabilityGrantPlan,
  EffectiveNode,
  CompositionLayer,
  Diagnostic,
} from '../src/index.ts'

test('S1-1 契约声明可构造（含 v4 MCP 反向请求能力面）', () => {
  const contract: PluginContract = {
    provides: ['session.query'],
    needs: ['storage', 'storage-domain'],
    optional: ['storage.json'],
    plane: 'host',
    isolate: false,
    capabilities: {
      fs: { read: ['**'], write: ['${dshHome}/sessions/**'] },
      network: {},
      process: { deny: ['*'] },
      env: { read: ['DSH_HOME'] },
      mcp: {
        servers: ['search'],
        tools: ['search.web'],
        sampling: { models: ['deepseek-chat'], maxTokens: 4096 },
        roots: ['${dshHome}'],
        elicitation: false,
      },
    },
  }
  assert.equal(contract.plane, 'host')
  const caps: CapabilityDeclaration | undefined = contract.capabilities
  assert.equal(caps?.mcp?.sampling?.maxTokens, 4096)
})

test('S1-2 mock 装配计划可构造（M2 线"类型先行"的输入件）', () => {
  const node: EffectiveNode = {
    id: 'session-query-sqlite',
    name: '@deepseek-ai/dsh-session-query-sqlite',
    config: { path: ':memory:' },
    disabled: false,
    contract: {
      provides: ['session.query'],
      needs: ['storage'],
      optional: [],
      plane: 'host',
      isolate: false,
    },
    overrides: [],
  }
  const layer: CompositionLayer = {
    id: 'base',
    file: 'cordis.yaml',
    trustLevel: 'trusted',
    entries: [],
  }
  const grants: CapabilityGrantPlan = {
    grants: new Map([
      ['session-query-sqlite', [
        { service: 'storage', allowedMethods: ['get'], allowedProps: [], expiresAt: 0 },
      ]],
    ]),
  }
  const diag: Diagnostic = { severity: 'error', message: '示例诊断', code: 'SEC-1001' }
  const plan: AssemblyPlan = {
    nodes: [node],
    graph: {
      nodes: [{ id: node.id, plane: 'host', provides: ['session.query'], needs: ['storage'], optional: [], isolate: false }],
      edges: [{ from: node.id, to: 'storage-row', service: 'storage', kind: 'hard' }],
      hasCycle: false,
      orphans: [],
    },
    validation: { diagnostics: [diag] },
    security: { diagnostics: [] },
    capabilities: grants,
    timestamp: new Date().toISOString(),
    layers: [layer],
  }
  assert.equal(plan.nodes.length, 1)
  assert.equal(plan.capabilities.grants.size, 1)
  assert.equal(plan.validation.diagnostics[0]?.code, 'SEC-1001')
})

test('S1-3 AssemblyController 未实现方法拒绝调用（不假实现）；expand/dryRun/assemble 已随 S2/S8/M1 收口落地', async () => {
  const controller = new AssemblyController({})
  // expand() 已随批次 1b（S2）落地接线——空 sources 走 loadLayers 的显式报错
  await assert.rejects(
    () => controller.expand({ sources: [] }),
    /未提供层来源文件/,
  )
  // dryRun() 已随批次 1d（S8）落地为真实装配管线——空 sources 同样走 loadLayers 显式报错
  await assert.rejects(
    () => controller.dryRun({ sources: [] }),
    /未提供层来源文件/,
  )
  // assemble() 已随 M1 收口接线为干跑全链 + 放行门禁——空 sources 同样走 loadLayers 显式报错
  await assert.rejects(
    () => controller.assemble({ sources: [] }),
    /未提供层来源文件/,
  )
})
