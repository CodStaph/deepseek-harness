/**
 * S12 效果系统测试（批次 2b）
 * 覆盖：四类处理器各至少一个正例 + 一个拒绝例；EffectApi dispatch；
 *       openBeneath 单点 / trash 双后端接口位。并入 dsh 后以 vitest 运行（批次 1-2 迁移）。
 * fs 操作一律落在 os.tmpdir() 下的临时工作区，测试结束清理，不触碰真实文件系统。
 */

import { test, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createServer, type Server } from 'node:http'

import {
  FsEffectHandler,
  NetEffectHandler,
  ProcEffectHandler,
  EnvEffectHandler,
  FsLocalTrashBackend,
  openBeneath,
  isInside,
  evaluateExemption,
  createEffectApi,
  SecurityViolation,
} from '../src/index.ts'

import type { EffectAuditEntry, EffectHandler, EffectType } from '../src/index.ts'

/** 审计收集器（node:test 冒烟风格，与 membrane-capability.test 一致） */
function auditSink() {
  const entries: EffectAuditEntry[] = []
  return { entries, cb: (e: EffectAuditEntry) => { entries.push(e) } }
}

const ws = mkdtempSync(join(tmpdir(), 'cordis-s12-ws-'))
const outside = mkdtempSync(join(tmpdir(), 'cordis-s12-out-'))
const tempArea = join(ws, '.temp')
mkdirSync(tempArea, { recursive: true })
// 预置 workspace 内文件
writeFileSync(join(ws, 'ok.txt'), 'hello')

afterAll(async () => {
  await rm(ws, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

/* ─────────────────────── fs 处理器 ─────────────────────── */

test('S12-1 fs.read：workspace 内 allow；workspace 外（realpath 逃逸）deny（R6 雏形）', async () => {
  const sink = auditSink()
  const h = new FsEffectHandler({
    workspaceRoot: () => ws, tempAreaRoot: tempArea, audit: sink.cb,
  })
  const r1 = await h.handle({ type: 'fs.read', target: join(ws, 'ok.txt'), caller: 'tool-fs' })
  assert.equal(r1.ok, true)
  assert.equal(String(r1.data).trim(), 'hello')

  const r2 = await h.handle({ type: 'fs.read', target: join(outside, 'x.txt'), caller: 'tool-fs' })
  assert.equal(r2.ok, false)
  assert.match(r2.error ?? '', /路径超出 workspace/)
  assert.equal(sink.entries[1]!.verdict, 'deny')
})

test('S12-2 fs.write：temp-area 豁免 allow（audit.exemption=temp-area）；workspace 外 deny', async () => {
  const sink = auditSink()
  const h = new FsEffectHandler({
    workspaceRoot: () => ws, tempAreaRoot: tempArea, audit: sink.cb,
  })
  const w1 = await h.handle({
    type: 'fs.write', target: join(tempArea, 'inter.txt'), caller: 'tool-fs',
    args: ['inter-data'],
  })
  assert.equal(w1.ok, true)
  assert.equal(sink.entries[0]!.exemption, 'temp-area')
  assert.equal(await readFile(join(tempArea, 'inter.txt'), 'utf8'), 'inter-data')

  const w2 = await h.handle({
    type: 'fs.write', target: join(outside, 'out.txt'), caller: 'tool-fs', args: ['x'],
  })
  assert.equal(w2.ok, false)
  assert.match(w2.error ?? '', /路径超出/)
})

test('S12-3 read-only 模式 fs.write / fs.trash 一律 deny（R5 雏形）', async () => {
  const sink = auditSink()
  const h = new FsEffectHandler({
    sandboxMode: () => 'read-only',
    workspaceRoot: () => ws, tempAreaRoot: tempArea, audit: sink.cb,
  })
  const w = await h.handle({ type: 'fs.write', target: join(tempArea, 'ro.txt'), caller: 'p', args: ['x'] })
  assert.equal(w.ok, false)
  assert.match(w.error ?? '', /read-only/)
  const t = await h.handle({ type: 'fs.trash', target: join(ws, 'ok.txt'), caller: 'p' })
  assert.equal(t.ok, false)
  assert.match(t.error ?? '', /read-only/)
})

test('S12-4 fs.trash 低门槛放行（trash-default 豁免）；fs.delete-permanent 高门槛 deny', async () => {
  const sink = auditSink()
  const target = join(ws, 'trashme.txt')
  writeFileSync(target, 'bye')
  const h = new FsEffectHandler({
    workspaceRoot: () => ws, tempAreaRoot: tempArea, audit: sink.cb,
  })
  const t = await h.handle({ type: 'fs.trash', target, caller: 'p' })
  assert.equal(t.ok, true)
  assert.equal(sink.entries[0]!.exemption, 'trash-default')
  // 文件已移入回收区，原路径消失
  assert.equal(existsSync(target), false)

  const d = await h.handle({ type: 'fs.delete-permanent', target: join(ws, 'ok.txt'), caller: 'p' })
  assert.equal(d.ok, false)
  assert.match(d.error ?? '', /契约.*审批|审批/)
})

/* ───────────────────────────── net 处理器 ───────────────────────────── */

let server: Server | undefined
let baseUrl = ''
function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => { res.end('pong') })
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      baseUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
}

afterAll(async () => { server?.close() })

test('S12-5 net.fetch 白名单内 allow（含 exfiltrationCheck）；白名单外 deny', async () => {
  await startServer()
  const sink = auditSink()
  const h = new NetEffectHandler({ audit: sink.cb, allowedDomains: ['127.0.0.1'] })
  const ok = await h.handle({ type: 'net.fetch', target: `${baseUrl}/ping`, caller: 'p' })
  assert.equal(ok.ok, true)
  // S17 语义精确化：无出站体（纯读式 GET）→ not-applicable（原 S12 断言 pass）
  assert.equal(sink.entries[0]!.exfiltrationCheck, 'not-applicable')

  const denied = await h.handle({ type: 'net.fetch', target: 'http://example.com/', caller: 'p' })
  assert.equal(denied.ok, false)
  assert.match(denied.error ?? '', /白名单/)
})

test('S12-6 net.fetch 出站超 ceiling → exfiltrationCheck=blocked 且 deny', async () => {
  const sink = auditSink()
  const h = new NetEffectHandler({
    audit: sink.cb, allowedDomains: ['127.0.0.1'], outboundCeilingBytes: 16,
  })
  const r = await h.handle({
    type: 'net.fetch', target: `${baseUrl}/big`, caller: 'p',
    args: [{ body: 'x'.repeat(100) }],
  })
  assert.equal(r.ok, false)
  assert.equal(sink.entries[0]!.exfiltrationCheck, 'blocked')
})

/* ───────────────────────────── proc 处理器 ───────────────────────────── */

test('S12-7 proc 白名单命令 allow；白名单外 deny', async () => {
  const sink = auditSink()
  const h = new ProcEffectHandler({ allowedCommands: [basename(process.execPath)], audit: sink.cb })
  const ok = await h.handle({
    type: 'proc.exec', target: process.execPath, caller: 'p',
    args: ['-e', 'console.log("hi")'],
  })
  assert.equal(ok.ok, true)
  const out = ok.data as { stdout: string }
  assert.match(out.stdout, /hi/)

  const denied = await h.handle({ type: 'proc.spawn', target: 'nope-cmd', caller: 'p', args: [] })
  assert.equal(denied.ok, false)
  assert.match(denied.error ?? '', /白名单/)
})

/* ───────────────────────────── env 处理器 ───────────────────────────── */

test('S12-8 env.get 白名单键 allow；env.set 被拒键 deny', async () => {
  const sink = auditSink()
  const h = new EnvEffectHandler({
    allowedEnvKeys: ['CORDIS_TEST_KEY', 'CORDIS_RO_KEY'],
    readonlyEnvKeys: ['CORDIS_RO_KEY'],
    audit: sink.cb,
  })
  process.env.CORDIS_TEST_KEY = 'v1'
  const g = await h.handle({ type: 'env.get', target: 'CORDIS_TEST_KEY', caller: 'p' })
  assert.equal(g.ok, true)
  assert.equal(g.data, 'v1')

  const gDenied = await h.handle({ type: 'env.get', target: 'CORDIS_SECRET', caller: 'p' })
  assert.equal(gDenied.ok, false)
  assert.match(gDenied.error ?? '', /读白名单/)

  const sDenied = await h.handle({ type: 'env.set', target: 'CORDIS_RO_KEY', caller: 'p', args: ['x'] })
  assert.equal(sDenied.ok, false)
  assert.match(sDenied.error ?? '', /写入被拒/)
})

/* ─────────────────────── EffectApi 暴露 ─────────────────────── */

test('S12-9 createEffectApi：成功返回 data；被拒抛 SecurityViolation', async () => {
  const sink = auditSink()
  const fsH = new FsEffectHandler({
    workspaceRoot: () => ws, tempAreaRoot: tempArea, audit: sink.cb,
  })
  const handlers = new Map<EffectType, EffectHandler>([['fs.read', fsH], ['fs.write', fsH]])
  const api = createEffectApi(handlers, 'tool-fs#fiber-1', 'cap_x')

  const buf = await api.fs.read(join(ws, 'ok.txt'))
  assert.equal(buf.toString().trim(), 'hello')

  await assert.rejects(
    () => api.fs.write(join(outside, 'z.txt'), 'data'),
    (e: unknown) => e instanceof SecurityViolation && /效果被拒/.test((e as Error).message),
  )
})

/* ───────────────── openBeneath 单点 / trash 双后端接口位 ─────────────────────── */

test('S12-10 openBeneath 单点 + FsLocalTrashBackend 可调用（P3 / 裁定 3A）', async () => {
  // openBeneath 对已存在路径解析真实路径
  const real = openBeneath(join(ws, 'ok.txt'))
  assert.equal(real, join(ws, 'ok.txt'))
  // isInside 边界工具
  assert.equal(isInside(join(ws, 'a', 'b'), ws), true)
  assert.equal(isInside(outside, ws), false)

  // 豁免判定：temp-area 写入命中；workspace 内 final 写入不命中
  const exTemp = evaluateExemption(
    { type: 'fs.write', target: join(tempArea, 'e.txt'), caller: 'p' },
    tempArea,
  )
  assert.equal(exTemp, 'temp-area')
  const exNone = evaluateExemption(
    { type: 'fs.write', target: join(ws, 'ok.txt'), caller: 'p' },
    tempArea,
  )
  assert.equal(exNone, undefined)

  // FsLocalTrashBackend 本地回收：文件移入回收区
  const trashFile = join(ws, 'local-trash.txt')
  writeFileSync(trashFile, 'data')
  const trashDir = join(ws, '.trash')
  const backend = new FsLocalTrashBackend(trashDir)
  await backend.trash(trashFile)
  assert.equal(existsSync(trashFile), false)
  // 回收区出现被移入文件
  const moved = readdirSync(trashDir)
  assert.ok(moved.length > 0)

  // deletePermanent：真删仅限边界内测试文件（非用户文件）
  const permFile = join(ws, 'perm.txt')
  writeFileSync(permFile, 'x')
  await backend.deletePermanent(permFile)
  assert.equal(existsSync(permFile), false)
})