#!/usr/bin/env node
/**
 * SEC 诊断码位登记表·机器化单一数据源 + 静态检查（S23 / R43）
 *
 * 服务条款：SEC-码位登记表（M0-调研建档/SEC-码位登记表.md）§7「机器化收口路径」——
 *  1. 本表转为 scripts/sec-catalog（单一数据源：码位/规则/段位/信任论证摘要）；
 *  2. CI 静态检查两条：a) 全仓 `Diagnostic` 抛出点引用的 SEC 码 ⊆ 登记表；b) 登记表内
 *     码位唯一且无悬空规则；
 *  3. 已登记码位的规则语义变更一律走 §5.11.9（提案→独立复核→用户裁定→落地），
 *     CI 只做一致性核对，不做语义审查。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *   node sec-catalog.mjs --self-test              # 内置样例自测（数据源完整性）
 *   node sec-catalog.mjs                          # 检查代码引用 ⊆ 登记表 + 登记表唯一
 *   node sec-catalog.mjs --list                   # 打印全部已登记码位
 *
 * ── 检查项（R43）─────────────────────────────────────────────────────
 *   a. 扫描 packages 下所有 .ts 中的带引号 SEC 码字面量（星号斜杠注意转义），
 *      断言其全部落在登记表内（无未登记码）；
 *   b. 登记表内码位唯一（无重复码位）且每条规则有非空 rule。
 *
 * 登记表数据源内嵌于此（单一数据源；并入 dsh 时改读 scripts/sec-catalog 同仓数据）。
 * 任何码位增删改：先改登记表文档（走 §5.11.9），再同步本数据源——CI 二者比对由
 * 文档人工校对承接（本脚本是数据源 + 一致性核对，不做语义审查）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ── 单一数据源：已登记码位（与 SEC-码位登记表.md 同步） ───────────────────── */
// 段位 §2：0xxx 治理 / 1xxx 装配静态 / 2xxx 装配动态 / 3xxx 运行时(留白) /
//          4xxx 审批(留白) / 5xxx MCP(留白) / 6xxx skill/CLI/root / 7xxx 元层(留白)
export const SEC_CATALOG = [
  // SEC-0xxx：治理与口径元条目（M0 固化）
  { code: 'SEC-0901', rule: 'runtime-control 判定核心逻辑行红线（口径）', section: '3', status: '登记' },
  // SEC-1xxx：装配控制层·静态校验（M1 S3/S4/S5）
  { code: 'SEC-1001', rule: 'unknown-plugin', section: '4', status: '既有' },
  { code: 'SEC-1002', rule: 'metadata-expression', section: '4', status: '既有' },
  { code: 'SEC-1003', rule: 'disabled-parse', section: '4', status: '既有' },
  { code: 'SEC-1004', rule: 'preset-plane-separation', section: '4', status: '既有' },
  { code: 'SEC-1005', rule: 'client-half-declared', section: '4', status: '既有' },
  { code: 'SEC-1006', rule: 'source-plane-resolution', section: '4', status: '既有' },
  { code: 'SEC-1007', rule: 'fixture-module-dependency', section: '4', status: '既有' },
  { code: 'SEC-1008', rule: 'inject-closure', section: '4', status: '规划' },
  { code: 'SEC-1009', rule: 'duplicate-mount', section: '4', status: '规划' },
  { code: 'SEC-1010', rule: 'cycle-detection', section: '4', status: '规划' },
  { code: 'SEC-1011', rule: 'orphan-service', section: '4', status: '规划' },
  { code: 'SEC-1012', rule: 'isolate-shadow', section: '4', status: '规划' },
  { code: 'SEC-1013', rule: 'sensitive-override', section: '4', status: '规划' },
  { code: 'SEC-1014', rule: 'capability-overclaim', section: '4', status: '规划' },
  { code: 'SEC-1015', rule: 'safe-eval-violation', section: '4', status: '登记(S4 裁定 8A)' },
  // SEC-2xxx：装配控制层·动态校验（M1 S6）
  { code: 'SEC-2001', rule: 'missing-dependency', section: '5', status: '已落地(S6)' },
  { code: 'SEC-2002', rule: 'duplicate-registration', section: '5', status: '已落地(S6)' },
  { code: 'SEC-2003', rule: 'isolate-violation', section: '5', status: '已落地(S6)' },
  { code: 'SEC-2004', rule: 'service-death', section: '5', status: '已落地(S6)' },
  // SEC-3xxx：运行时管控层 —— 维持留白（S9–S20 零码位新增，登记表 §5 论证）
  // SEC-4xxx：审批语义 —— 维持留白（S16 零码位，登记表 §5 论证）
  // SEC-5xxx：MCP 深度内建与 OS 沙箱 —— 维持留白（S19/S20/4c 零码位，登记表 §5 论证）
  // SEC-6xxx：skill 面 / CLI 面 / root 登记（M5 S21）
  { code: 'SEC-6001', rule: 'skill-unauthorized-directive', section: '6', status: '已落地(S21)' },
  { code: 'SEC-6002', rule: 'skill-sensitive-content', section: '6', status: '已落地(S21)' },
  { code: 'SEC-6003', rule: 'skill-manifest-mismatch', section: '6', status: '已落地(S21)' },
  { code: 'SEC-6004', rule: 'skill-capability-exceeded', section: '6', status: '已落地(S21)' },
  // SEC-7xxx：元层纪律（哨兵/重算器/码位检查自身）—— S23 落地论证维持留白（零码位）
]

const CATALOG_CODES = new Set(SEC_CATALOG.map((e) => e.code))

/* ── 自测：登记数据源完整性 ── */

function selfTest() {
  const failures = []
  const seen = new Map()
  for (const e of SEC_CATALOG) {
    if (seen.has(e.code)) failures.push(`重复码位 ${e.code}`)
    seen.set(e.code, e.rule)
  }
  for (const e of SEC_CATALOG) {
    if (!/^SEC-\d{4}$/.test(e.code)) failures.push(`非法码格式 ${e.code}`)
    if (!e.rule) failures.push(`码 ${e.code} 缺规则`)
  }
  if (failures.length > 0) {
    console.error('sec-catalog: 自测失败：')
    failures.forEach((f) => console.error('  - ' + f))
    process.exit(1)
  }
  console.log(`sec-catalog: 自测通过（${SEC_CATALOG.length} 码位唯一且格式合法）。`)
}

/* ── 源码扫描：收集所有带引号 SEC 码字面量 ── */

function collectTsFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'lib') continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) collectTsFiles(p, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p)
  }
}

function collectUsedCodes(files) {
  const used = new Set()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    // 只统计带引号的字符串字面量形态（注释中的 SEC-xxxx 不带引号，不视为"抛出点引用"）
    for (const m of text.matchAll(/['"](SEC-\d{4})['"]/g)) {
      used.add(m[1])
    }
  }
  return used
}

function walkUsedCodes(files) {
  return collectUsedCodes(files)
}

function isDirectory(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

/* ── 主检查：R43 两条 ── */

function check() {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = resolve(here, '..')
  const packages = join(root, 'packages')

  const files = []
  if (isDirectory(packages)) collectTsFiles(packages, files)
  const used = collectUsedCodes(files)
  const codesSeen = new Map()
  const dup = new Set()
  for (const e of SEC_CATALOG) {
    if (codesSeen.has(e.code)) dup.add(e.code)
    codesSeen.set(e.code, e.rule)
  }

  let failures = 0
  // a) 代码引用的码 ⊆ 登记表（无未登记码）
  const unregistered = [...used].filter((c) => !CATALOG_CODES.has(c)).sort()
  if (unregistered.length > 0) {
    failures++
    console.error('sec-catalog: 存在未登记码（Diagnostic 抛出点引用了登记表外码）：')
    unregistered.forEach((c) => console.error(`  - ${c}`))
  }
  // b) 登记表内码唯一（无重复码）
  if (dup.size > 0) {
    failures++
    console.error('sec-catalog: 登记表内存在重复码：')
    dup.forEach((c) => console.error(`  - ${c}`))
  }
  // 登记的码若未在代码中引用（预留/悬空）→ warning 级提示（非失败：预留码合法）
  const registeredUnused = [...CATALOG_CODES].filter((c) => !used.has(c)).sort()
  if (registeredUnused.length > 0) {
    console.warn('sec-catalog: 以下登记码当前未被代码字面量引用（预留/注释登记，非失败）：')
    registeredUnused.forEach((c) => console.warn(`  - ${c}`))
  }

  if (failures > 0) {
    console.error(`sec-catalog: 检查失败（${failures} 类问题）。`)
    process.exit(1)
  }
  console.log(`sec-catalog: 检查通过——扫描 ${files.length} 个 .ts，代码引用 ${used.size} 个码全部在登记表内；登记表 ${SEC_CATALOG.length} 条唯一。`)
}

/* ── 主入口 ── */

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) { selfTest(); return }
  if (args.includes('--list')) {
    for (const e of SEC_CATALOG) console.log(`${e.code}\t${e.rule}\t段${e.section}\t${e.status}`)
    return
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log([
      '用法：',
      '  node sec-catalog.mjs             # 检查代码仓内引用 ⊆ 登记表 + 登记表唯一（R43）',
      '  node sec-catalog.mjs --list      # 打印全部已登记码位',
      '  node sec-catalog.mjs --self-test # 数据源完整性自测',
    ].join('\n'))
    process.exit(0)
  }
  check()
}

main()