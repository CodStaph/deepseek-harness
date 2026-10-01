#!/usr/bin/env node
/**
 * 红线口径脚本：runtime-control 判定核心"逻辑行"统计（M0 / T0.9 产出）
 *
 * 服务的条款：设计方案 5.11.8（管控层复杂度红线）、验收 R44（红线复测，M2 首测 / M5 终版）。
 * 本脚本在 M0 只固化【口径】并自证可运行；基线数字不在本阶段给出（无实测不给数字）。
 *
 * ── 口径定义（唯一权威，与登记表 SEC-0901 对应）──────────────────────────
 * 1. 词法权威 = TypeScript Scanner（typescript 包）。不使用自写正则/状态机，
 *    避免出现第二口径；字符串/模板串/正则中的 "//" "/*" 由 Scanner 保证不计为注释。
 * 2. 逻辑行 = 至少被一个【非 trivia token】覆盖的行。
 *    trivia = 空白、单行/多行注释、换行、Shebang、冲突标记。
 * 3. 行尾注释（`const a = 1 // x`）所在行计为逻辑行（含代码 token）。
 * 4. 跨行 token（模板字符串等）覆盖的每一行均计为逻辑行。
 * 5. 物理/注释/空行数仅作核对参考，红线判定只看逻辑行。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────
 *   node count-logical-lines.mjs --self-test                  # 内置样例自测（口径自证）
 *   node count-logical-lines.mjs <文件或目录>...               # 统计指定目标
 *   node count-logical-lines.mjs --manifest <清单文件>         # 按清单统计（红线复测入口）
 *        清单格式：每行一个路径（相对清单文件或绝对），# 开头为注释行，空行忽略
 *   node count-logical-lines.mjs --max <N> ...                # 逻辑行合计上限断言，超线退出码 1
 *   node count-logical-lines.mjs --ts <typescript.js 路径>    # 显式指定 typescript 模块
 *
 *   typescript 解析顺序：--ts 显式路径 → $DSH_REPO/node_modules → 当前目录 node_modules → 裸解析。
 *   不可用时直接报错退出，不做启发式降级（单一口径纪律：宁可失败，不产生第二种数字）。
 *
 * ── 将来收口（S23/R44）────────────────────────────────────────────────────
 *   - 清单文件内容（哪些文件算"判定核心"）由用户裁定后登记，清单本身即红线边界；
 *   - 并入 dsh 仓库时可按 scripts/ 目录惯例改写为 .ts 并挂入 CI（check:ci:* 门）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// ── typescript 模块加载（无降级） ──────────────────────────────────────────

function loadTypescript(explicitPath) {
  const require = createRequire(import.meta.url)
  const candidates = []
  if (explicitPath) candidates.push(resolve(explicitPath))
  if (process.env.DSH_REPO) candidates.push(join(process.env.DSH_REPO, 'node_modules', 'typescript', 'lib', 'typescript.js'))
  candidates.push(join(process.cwd(), 'node_modules', 'typescript', 'lib', 'typescript.js'))
  for (const candidate of candidates) {
    try { return require(candidate) } catch { /* 尝试下一候选 */ }
  }
  try { return require('typescript') } catch { /* 落到报错 */ }
  console.error('count-logical-lines: 未找到 typescript 模块。')
  console.error('  方式一：在 dsh 仓库内运行本脚本（其 node_modules 含 typescript）；')
  console.error('  方式二：设置环境变量 DSH_REPO 指向 dsh 仓库根；')
  console.error('  方式三：--ts <typescript.js 绝对路径>。')
  process.exit(2)
}

// ── 行偏移工具 ─────────────────────────────────────────────────────────────

/** 每一行的起始偏移（含第 0 行）；同时得到物理行数。 */
function computeLineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1)
  }
  return starts
}

/** 二分查找：偏移量 → 行号（0 基）。 */
function lineOfOffset(starts, offset) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

// ── 核心口径：单文件分析 ───────────────────────────────────────────────────

function isTrivia(ts, kind) {
  return kind === ts.SyntaxKind.SingleLineCommentTrivia
    || kind === ts.SyntaxKind.MultiLineCommentTrivia
    || kind === ts.SyntaxKind.WhitespaceTrivia
    || kind === ts.SyntaxKind.NewLineTrivia
    || kind === ts.SyntaxKind.ShebangTrivia
    || kind === ts.SyntaxKind.ConflictMarkerTrivia
}

function analyzeText(ts, text) {
  const starts = computeLineStarts(text)
  const physical = starts.length
  const logicalMarks = new Uint8Array(physical)
  let commentLines = 0
  let blankLines = 0

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false)
  scanner.setText(text)
  for (;;) {
    const kind = scanner.scan()
    if (kind === ts.SyntaxKind.EndOfFileToken) break
    if (isTrivia(ts, kind)) continue
    const start = scanner.getTokenStart()
    const end = scanner.getTokenEnd()
    const firstLine = lineOfOffset(starts, start)
    const lastLine = lineOfOffset(starts, Math.max(start, end - 1))
    for (let line = firstLine; line <= lastLine; line++) logicalMarks[line] = 1
  }
  scanner.setText(undefined)

  let logical = 0
  for (let line = 0; line < physical; line++) {
    if (logicalMarks[line]) { logical++ ; continue }
    const begin = starts[line]
    const end = line + 1 < physical ? starts[line + 1] : text.length
    const trimmed = text.slice(begin, end).replace(/\r$/, '').trim()
    if (trimmed === '') blankLines++
    else if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')) commentLines++
  }
  return { physical, logical, commentLines, blankLines }
}

// ── 文件收集 ────────────────────────────────────────────────────────────────

function collectDirectory(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib' || entry.name === 'dist') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collectDirectory(path, files)
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) files.push(path)
  }
}

function expandTargets(targets) {
  const files = []
  for (const target of targets) {
    const stat = statSync(target)
    if (stat.isDirectory()) collectDirectory(target, files)
    else files.push(target)
  }
  return files
}

function readManifest(manifestPath) {
  const base = dirname(resolve(manifestPath))
  const files = []
  const text = readFileSync(manifestPath, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    files.push(isAbsolute(line) ? line : resolve(base, line))
  }
  return files
}

// ── 自测（口径自证：内置样例 + 期望值断言） ─────────────────────────────────

const SELF_TEST_SAMPLES = [
  {
    name: '注释与空行全剔除',
    source: [
      '#!/usr/bin/env node',            // shebang → trivia
      '/**', ' * JSDoc 块', ' */',      // 3 行块注释
      '// 单行注释',                     // 1 行注释
      '', '   ',                        // 空行 ×2
    ].join('\n'),
    expect: 0,
  },
  {
    name: '代码行、尾随注释、行内块注释',
    source: [
      'const a = 1 // 尾随注释',        // 逻辑（含代码）
      '/* 行首块注释 */ const b = 2',    // 逻辑（含代码）
      '/*', '块注释中间行', '*/',        // 全 trivia
      'const c = 3',                    // 逻辑
    ].join('\n'),
    expect: 3,
  },
  {
    name: '字符串/模板串/正则中的伪注释不计为注释',
    source: [
      'const s = "// 不是注释"',        // 逻辑
      'const u = "/* 也不是"',           // 逻辑
      'const t = `跨行', '模板串`',      // 逻辑 ×2（token 覆盖两行）
      'const r = /a\\/\\/*/g',          // 逻辑（正则含 /* 不当注释）
    ].join('\n'),
    expect: 5,
  },
  {
    name: '类型与泛型（.ts 形态）',
    source: [
      'interface T {', '  a: string', '}',   // 逻辑 ×3
      'const f = <T,>(x: T): T => x',         // 逻辑
    ].join('\n'),
    expect: 4,
  },
]

function selfTest(ts) {
  let failures = 0
  for (const sample of SELF_TEST_SAMPLES) {
    const result = analyzeText(ts, sample.source)
    const ok = result.logical === sample.expect
    if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${sample.name}: 逻辑行 ${result.logical}（期望 ${sample.expect}，物理 ${result.physical}，注释 ${result.commentLines}，空行 ${result.blankLines}）`)
  }
  if (failures > 0) {
    console.error(`count-logical-lines: 自测失败 ${failures} 例，口径实现与登记口径不一致。`)
    process.exit(1)
  }
  console.log('count-logical-lines: 自测全部通过，口径与登记一致。')
}

// ── 主入口 ─────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log([
      '用法：',
      '  node count-logical-lines.mjs --self-test',
      '  node count-logical-lines.mjs [--max N] <文件或目录>...',
      '  node count-logical-lines.mjs [--max N] --manifest <清单文件>',
      '选项：--max N  逻辑行合计上限（红线断言，超线退出码 1）；--ts <路径>  指定 typescript.js',
    ].join('\n'))
    process.exit(0)
  }

  const explicitTs = optionValue(args, '--ts')
  const ts = loadTypescript(explicitTs)

  if (args.includes('--self-test')) {
    selfTest(ts)
    return
  }

  let max
  const maxIndex = args.indexOf('--max')
  if (maxIndex >= 0) {
    max = Number(args[maxIndex + 1])
    if (!Number.isFinite(max) || max < 0) {
      console.error('count-logical-lines: --max 需要非负整数。')
      process.exit(2)
    }
  }

  const positional = collectPositional(args)
  let files = []
  const manifestPath = optionValue(args, '--manifest')
  if (manifestPath) {
    files = readManifest(manifestPath)
  } else {
    if (positional.length === 0) { console.error('count-logical-lines: 缺少统计目标。'); process.exit(2) }
    files = expandTargets(positional)
  }
  if (files.length === 0) { console.error('count-logical-lines: 未发现任何统计目标。'); process.exit(2) }

  let total = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const result = analyzeText(ts, text)
    total += result.logical
    console.log(`${String(result.logical).padStart(6)} 逻辑行  ${file}（物理 ${result.physical}，注释 ${result.commentLines}，空行 ${result.blankLines}）`)
  }
  console.log(`${String(total).padStart(6)} 逻辑行  合计（${files.length} 文件）`)

  if (max !== undefined) {
    if (total > max) {
      console.error(`count-logical-lines: 红线越界 —— 逻辑行合计 ${total} > 上限 ${max}（5.11.8：超线触发枪毙重设计）。`)
      process.exit(1)
    }
    console.log(`count-logical-lines: 红线内（${total} ≤ ${max}）。`)
  }
}

/** 取出所有非选项的位置参数（含其后紧跟的选项值之外的所有裸参数）。 */
function collectPositional(args) {
  const positional = []
  const valueFlags = new Set(['--ts', '--max', '--manifest'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (valueFlags.has(arg)) { i++ ; continue }
    if (arg.startsWith('--')) continue
    positional.push(arg)
  }
  return positional
}

function optionValue(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

main()
