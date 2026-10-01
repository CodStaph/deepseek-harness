/**
 * 运行时管控层 · 机制 4：执行隔离域（Execution Realm）—— standard 级
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.4（5.4.2 级别与默认配置 /
 *       5.4.3 受控 require / 5.4.4 原型链冻结 / 5.4.5 隔离域级别分配）
 * 阶段：S13（批次 2c，M2 运行时线高风险阶段）
 *
 * 本阶段只实现"标准隔离（standard）"机制与测试，不接真实 Cordis loader 挂载
 * （那属并入 dsh 仓库后）。设计遵循方案决策：隔离域级别不自动设为 strict——严格
 * 隔离会破坏大多数现有插件直接 import node:fs 等的行为，须人工逐个评估后指定；
 * 迁移路径为 none → standard →（视情况）strict。
 *
 * 机制三件套：
 * - createWhitelistedRequire：白名单受控 require（精确匹配 + '*' 通配后缀/前缀匹配），
 *   不命中抛 SecurityViolation（auditEntry 形如 { action:'access-denied', property:<spec>,
 *   reason:'module-whitelist' }），并保留 require.resolve/cache/main/extensions。
 * - freezeCriticalPrototypes：冻结关键原型链 + 拦截 __proto__ 赋值抛 SecurityViolation
 *   （防原型污染 / 原型链污染攻击）。
 * - assignRealmLevel：按插件契约 + 信任等级分配隔离域级别（无契约→none；有
 *   capabilities→standard；plane 非 host→standard；host+trusted→none；其余→standard）。
 * - enableRealm：--no-realm 兜底开关的纯函数判定（输入开关输出布尔判定结果，不做 I/O）。
 *
 * SEC 码位结论：本文件为执行隔离域的纯机制载体，违规统一复用 SecurityViolation（膜层，
 * membrane.ts），与 R8/R12 判定语义一致；不新增 SEC 码位，SEC-3xxx 段维持留白。
 *
 * 组织：单文件（按方案 5.4.2 所列 packages/runtime-control/src/realm.ts），分区排列
 * 类型 → 默认配置 → 受控 require → 原型冻结 → 级别分配；未拆 realm/ 子目录以保持
 * 本批次"只新增 realm.ts 与 tests/s13-realm.test.ts 两个文件"的最小落地纪律。
 */

import type { EffectiveNode } from '@deepseek-ai/dsh-assembly'
import { SecurityViolation } from './membrane.ts'

/** 隔离域安全级别 */
export type RealmLevel = 'none' | 'standard' | 'strict'

/**
 * 隔离域配置——某级别的默认行为。
 * 方案 §5.4.2：none 全放行不冻结；standard 白名单 import + 原型冻结 + 禁 eval；
 * strict 完全沙箱（远期，S13 仅类型占位，不启用）。
 */
export interface RealmConfig {
  /** 安全级别 */
  level: RealmLevel
  /** 允许 import 的模块白名单（'*' 通配精确放行；'pattern*' 前缀通配） */
  moduleWhitelist: string[]
  /** 全局对象覆盖（strict 的 read-only process / whitelist require 为远期挂载） */
  globalOverrides: Record<string, unknown>
  /** 是否冻结关键原型链 */
  freezePrototypes: boolean
  /** 是否禁止 eval / new Function */
  disableEval: boolean
}

/** 各级别的默认配置（方案 §5.4.2）。 */
export const REALM_LEVELS: Record<RealmLevel, RealmConfig> = {
  /** 无隔离——现有行为，直接在主 realm 运行 */
  none: {
    level: 'none',
    moduleWhitelist: ['*'],
    globalOverrides: {},
    freezePrototypes: false,
    disableEval: false,
  },
  /** 标准隔离——白名单模块 + 冻结关键原型 + 禁 eval */
  standard: {
    level: 'standard',
    moduleWhitelist: [
      // 白名单——安全模块
      'node:path', 'node:url', 'node:crypto',
      // dsh 内部包
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-*',
      // 禁止：node:fs, node:child_process, node:net 等（必须走效果系统）
    ],
    globalOverrides: {},
    freezePrototypes: true,
    disableEval: true,
  },
  /**
   * 严格隔离——完全沙箱。远期（方案 §5.4.5 决策：不自动启用）。
   * S13 仅类型占位：给出清单但不启用；globalOverrides 的 read-only process 与
   * whitelist require 属并入 dsh 后人工逐包评估时挂载，故此处留空 + 注释占位，
   * 避免对 createReadOnlyProcess 的循环/未定义引用。
   */
  strict: {
    level: 'strict',
    moduleWhitelist: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-*',
    ],
    globalOverrides: {
      // 远期：process: createReadOnlyProcess(), require: createWhitelistedRequire(...)
    },
    freezePrototypes: true,
    disableEval: true,
  },
}

/** 白名单匹配判定——精确命中或 '*' 通配后缀前缀匹配 */
function whitelistMatches(whitelist: readonly string[], specifier: string): boolean {
  return whitelist.some((pattern) => {
    if (pattern.endsWith('*')) return specifier.startsWith(pattern.slice(0, -1))
    return pattern === specifier
  })
}

/**
 * 创建白名单 require（方案 §5.4.3）——只允许 import 白名单中的模块。
 * 不命中抛 SecurityViolation；保留 originalRequire 的 resolve/cache/main/extensions。
 */
export function createWhitelistedRequire(
  whitelist: readonly string[],
  originalRequire: NodeRequire,
): NodeRequire {
  const controlled: NodeRequire = ((specifier: string) => {
    if (!whitelistMatches(whitelist, specifier)) {
      throw new SecurityViolation(
        `模块导入被拒：'${specifier}' 不在白名单中`,
        { action: 'access-denied', property: specifier, reason: 'module-whitelist' },
      )
    }
    return originalRequire(specifier)
  }) as NodeRequire
  // 保留 require 静态行为（方案 §5.4.3：保持 require.resolve 行为）
  controlled.resolve = originalRequire.resolve
  controlled.cache = originalRequire.cache
  controlled.main = originalRequire.main
  controlled.extensions = originalRequire.extensions
  return controlled
}

/**
 * 冻结关键原型链（方案 §5.4.4）——防原型污染攻击。
 *
 * 语义要点：先替换各原型上的 '__proto__' setter（抛 SecurityViolation）再
 * Object.freeze。顺序不可颠倒——freeze 后属性变为不可配置，无法再改 setter。
 * 幂等：第二次调用时属性已不可配置则跳过 setter 覆盖；已冻结则跳过重复冻结。
 *
 * 副作用警告：本函数对全局原型 Object/Array/Function/Map/Set/Promise 执行冻结，
 * 会永久影响同一进程后续代码（原型不可解冻），故测试须置于用例末尾或在独立
 * 子进程/对复制对象执行。真实接线由 dsh 集成方决定启用时机。
 *
 * 细化（相对方案 §5.4.4）：Error.prototype 不纳入本阶段冻结集——冻结 Error.prototype
 * 会使 Error.prototype.name 变为不可写，而本层 SecurityViolation（extends Error，
 * 构造时执行 this.name = 'SecurityViolation'）及所有 Error 子类将无法实例化，连测试
 * 运行器自身的错误构造也会失效。方案原清单含 Error.prototype，此处按"standard 级
 * 必须保持错误构造可用"的工程约束剔除；Error 原型污染防护与逐类评估留待后续/严格
 * 级，与设计 Service.prototype"需确认是否允许冻结"的谨慎一致。
 */
export function freezeCriticalPrototypes(): void {
  const targets = [
    Object.prototype,
    Array.prototype,
    Function.prototype,
    Map.prototype,
    Set.prototype,
    Promise.prototype,
    // Error.prototype 不纳入 standard 级冻结（见函数头 JSDoc 细化说明）：
    //   冻结后 Error.prototype.name 不可写，SecurityViolation 及所有 Error 子类
    //   无法实例化，连测试运行器自身错误构造也会失效。
    // Cordis 核心：Service.prototype 需确认 Cordis 是否允许冻结，S13 不冻结
  ]
  for (const proto of targets) {
    // 先设 __proto__ 拦截（仅当仍可配置，保证幂等），再冻结
    const desc = Object.getOwnPropertyDescriptor(proto, '__proto__')
    if (desc && desc.configurable) {
      Object.defineProperty(proto, '__proto__', {
        enumerable: false,
        configurable: false,
        ...(desc.get !== undefined ? { get: desc.get } : {}),
        set() {
          throw new SecurityViolation(
            '禁止修改 __proto__',
            { action: 'write-denied', property: '__proto__', reason: 'prototype-frozen' },
          )
        },
      })
    }
    if (!Object.isFrozen(proto)) Object.freeze(proto)
  }
}

/**
 * --no-realm 兜底开关（验收 R13）——纯函数判定，不做 I/O。
 * 返回是否启用隔离域；noRealm=true → false（关闭隔离域、行为不变，向后兼容）。
 */
export function enableRealm(flag?: { noRealm?: boolean }): boolean {
  return flag?.noRealm !== true
}

/** 隔离域级别分配选项（--no-realm 兜底的纯函数输入） */
export interface RealmAssignmentOptions {
  /** 关闭隔离域（对应验收 R13）：true → assignRealmLevel 一律返回 'none' */
  noRealm?: boolean
}

/**
 * 根据插件契约 + 信任等级分配隔离域级别（方案 §5.4.5）。
 * 规则（方案原文）：
 *   1. 无契约声明 → 'none'（向后兼容，无隔离）；
 *   2. 有 capabilities 声明 → 'standard'（至少标准隔离）；
 *   3. preset/session 平面 → 'standard'；
 *   4. host 平面 + trusted 信任等级 → 'none'（向后兼容）；
 *   5. 其余 → 'standard'。
 * 当 opts.noRealm 为真，一律返回 'none'（关闭隔离域、行为不变）。
 */
export function assignRealmLevel(
  node: EffectiveNode,
  trustLevel: string,
  opts?: RealmAssignmentOptions,
): RealmLevel {
  if (opts?.noRealm === true) return 'none'
  if (!node.contract) return 'none'
  if (node.contract.capabilities) return 'standard'
  if (node.contract.plane !== 'host') return 'standard'
  if (trustLevel === 'trusted') return 'none'
  return 'standard'
}