/**
 * 批次 1-3 测试：Cordis YAML 适配器（adapter-cordis-yaml.ts）
 * 覆盖：
 * - yml 根数组 → CompositionLayer（entries 形状、trustLevel 缺省 trusted）
 * - `!!js` 表达式保留（disabled 转 ExpressionNode、config 内数据保留）
 * - boolean disabled / config 对象保留
 * - 非法行（id/name 缺失）、根非数组、disabled 非法类型抛错
 * - isYamlConfigFile 后缀判定
 * 测试映射：A7 对拍基准（装配层消费 dsh 真实 yml 的数据形态）。
 */

import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isYamlConfigFile, loadCordisYaml, loadLayersFromYaml } from '../src/adapter-cordis-yaml.ts'

function writeTemp(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-adapter-'))
  const file = join(dir, name)
  writeFileSync(file, body, 'utf8')
  return file
}

test('adapter-1 真实 yml 根数组 → 层（entries 形状 + trust 缺省 trusted）', () => {
  const file = writeTemp('cordis.yml', `- id: a\n  name: '@pkg/a'\n`)
  try {
    const layers = loadLayersFromYaml([{ filePath: file }])
    expect(layers).toHaveLength(1)
    expect(layers[0]!.trustLevel).toBe('trusted')
    expect(layers[0]!.entries).toHaveLength(1)
    expect(layers[0]!.entries[0]!).toMatchObject({ id: 'a', name: '@pkg/a' })
  } finally {
    rmSync(join(file, '..'), { recursive: true, force: true })
  }
})

test('adapter-2 trust 可注入（patch 覆盖层）', () => {
  const file = writeTemp('cordis.yml', `- id: a\n  name: '@pkg/a'\n`)
  try {
    const layers = loadLayersFromYaml([{ filePath: file, trust: 'patch' }])
    expect(layers[0]!.trustLevel).toBe('patch')
  } finally {
    rmSync(join(file, '..'), { recursive: true, force: true })
  }
})

test('adapter-3 !!js 保留：disabled 转 ExpressionNode、config 内表达式为数据', () => {
  const file = writeTemp('cordis.yml', `- id: a\n  name: '@pkg/a'\n  disabled: !!js process.env.FLAG === '1'\n  config:\n    workspacePath: !!js process.cwd()\n`)
  try {
    const layers = loadLayersFromYaml([{ filePath: file }])
    const entry = layers[0]!.entries[0]!
    expect(entry.disabled).toEqual({ source: `process.env.FLAG === '1'` })
    expect(entry.config).toEqual({ workspacePath: { __jsExpr: 'process.cwd()' } })
  } finally {
    rmSync(join(file, '..'), { recursive: true, force: true })
  }
})

test('adapter-4 boolean disabled 保留', () => {
  const file = writeTemp('cordis.yml', `- id: a\n  name: '@pkg/a'\n  disabled: true\n`)
  try {
    const layers = loadLayersFromYaml([{ filePath: file }])
    expect(layers[0]!.entries[0]!.disabled).toBe(true)
  } finally {
    rmSync(join(file, '..'), { recursive: true, force: true })
  }
})

test('adapter-5 根非数组 / 行缺 id / disabled 非法类型均抛错', () => {
  const bad = (body: string) => {
    const file = writeTemp('cordis.yml', body)
    try {
      expect(() => loadLayersFromYaml([{ filePath: file }])).toThrow()
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true })
    }
  }
  bad(`a: 1\n`)
  bad(`- name: '@pkg/a'\n`)
  bad(`- id: a\n  name: '@pkg/a'\n  disabled: 42\n`)
})

test('adapter-5 isYamlConfigFile 判定 + loadCordisYaml !!js 保留', () => {
  expect(isYamlConfigFile('a.yml')).toBe(true)
  expect(isYamlConfigFile('a.yaml')).toBe(true)
  expect(isYamlConfigFile('a.json')).toBe(false)
  const doc = loadCordisYaml(`- id: a\n  name: '@pkg/a'\n  disabled: !!js 1 === 1\n`)
  const row = (doc as unknown[])[0] as Record<string, unknown>
  expect(row.disabled).toEqual({ __jsExpr: '1 === 1' })
})

test('adapter-6 Loader insert 包装摊平（含 group 行保留）', () => {
  const file = writeTemp('cordis.yml', `- insert:\n    - id: a\n      name: '@pkg/a'\n    - id: g\n      name: cordis:group\n      group: true\n      config:\n        - id: child\n          name: '@pkg/child'\n`)
  try {
    const layers = loadLayersFromYaml([{ filePath: file }])
    const ids = layers[0]!.entries.map((e) => e.id)
    expect(ids).toEqual(['a', 'g'])
    const group = layers[0]!.entries[1]!
    expect(group.config).toEqual([{ id: 'child', name: '@pkg/child' }])
  } finally {
    rmSync(join(file, '..'), { recursive: true, force: true })
  }
})