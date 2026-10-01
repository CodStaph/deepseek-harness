/**
 * S16 审批语义测试（批次 3a）
 * 覆盖：三档授权（once 不记忆 / object 记目标 / class 记效果类型+插件，R13）；
 *       park/resume 一等阻塞（park 期间会话可响应其他请求，R15）；超时自动 deny（R16）；
 *       会话关停 cancelAllPending / dispose（§9.3 第 7 条）；AbortSignal 取消；
 *       豁免通道封闭枚举（temp-area / trash-default / same-session-artifact[R14] /
 *       user-preauthorized）；delete-permanent 分档（R17 雏形）；
 *       ApprovalServiceStub 兼容接线（S12→S16 接入点）。
 * 镜像阶段用 node:test（零框架依赖）；审批服务为纯判定面（无真实 IO），
 * fs 路径仅用于豁免/授权键的规范化锚点。
 */

import { test, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ApprovalService,
  InMemoryProvenanceRegistry,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  evaluateExemptionChannels,
  isUserPreauthorizedGrant,
} from '../src/effects/approval.ts'
import type { ApprovalReply, GrantRecord } from '../src/effects/approval.ts'
import { FsEffectHandler, openBeneath } from '../src/effects/handlers.ts'
import type { ApprovalServiceStub } from '../src/effects/handlers.ts'
import type { EffectAuditEntry, EffectRequest } from '../src/effect.ts'

/** 审计收集器（与 s12-effect.test 一致风格） */
function auditSink() {
  const entries: EffectAuditEntry[] = []
  return { entries, cb: (e: EffectAuditEntry) => { entries.push(e) } }
}

/** 计数 decide 注入器（模拟"用户/审批员"的固定回复） */
function countingDecide(reply: ApprovalReply) {
  const state = { calls: 0, last: undefined as EffectRequest | undefined }
  const decide = (req: EffectRequest): ApprovalReply => {
    state.calls += 1
    state.last = req
    return reply
  }
  return { state, decide }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ws = mkdtempSync(join(tmpdir(), 'cordis-s16-ws-'))
const tempArea = join(ws, '.temp')
mkdirSync(tempArea, { recursive: true })

afterAll(async () => {
  await rm(ws, { recursive: true, force: true })
})

/* ─────────────────────── 三档授权（R13） ─────────────────────── */

test('S16-1 三档授权·once：批准不记忆，重放同类请求再问（R13 雏形）', async () => {
  const sink = auditSink()
  const { state, decide } = countingDecide({ verdict: 'approve', scope: 'once' })
  const svc = new ApprovalService({ decide, audit: sink.cb })

  const r1 = await svc.request({ type: 'fs.write', target: join(ws, 'once.txt'), caller: 'tool-a' })
  assert.equal(r1.decision, 'approved')
  assert.equal(r1.ok, true)
  assert.equal(r1.grantId, undefined) // once 不记忆（R13）
  assert.equal(r1.auditEntry.approvalDecision, 'approved')
  assert.equal(state.calls, 1)

  const r2 = await svc.request({ type: 'fs.write', target: join(ws, 'once.txt'), caller: 'tool-a' })
  assert.equal(state.calls, 2) // 重放再问
  assert.equal(r2.decision, 'approved')
  assert.equal(sink.entries.length, 2)
})

test('S16-2 三档授权·object：记精确目标——同目标免问（auto + user-preauthorized），异目标再问（R13 雏形）', async () => {
  const sink = auditSink()
  const { state, decide } = countingDecide({ verdict: 'approve', scope: 'object' })
  const svc = new ApprovalService({ decide, audit: sink.cb })
  const target = join(ws, 'obj.txt')

  const r1 = await svc.request({ type: 'fs.write', target, caller: 'tool-a' })
  assert.ok(r1.grantId)

  const r2 = await svc.request({ type: 'fs.write', target, caller: 'tool-a' })
  assert.equal(state.calls, 1) // 同目标免问
  assert.equal(r2.decision, 'approved')
  assert.equal(r2.exemption, 'user-preauthorized') // 用户显式授权 → 预授权豁免位
  assert.equal(r2.grantId, r1.grantId) // 同一条授权记忆
  assert.equal(sink.entries.at(-1)?.approvalDecision, 'auto')
  assert.equal(sink.entries.at(-1)?.grantId, r1.grantId)

  await svc.request({ type: 'fs.write', target: join(ws, 'other.txt'), caller: 'tool-a' })
  assert.equal(state.calls, 2) // 异目标再问（object 级不覆盖）
})

test('S16-3 三档授权·class：记效果类型+插件——同类全免、不跨调用者、绑定类型（R13 雏形）', async () => {
  const { state, decide } = countingDecide({ verdict: 'approve', scope: 'class' })
  const svc = new ApprovalService({ decide })

  await svc.request({ type: 'fs.write', target: join(ws, 'c1.txt'), caller: 'tool-a' })
  const r2 = await svc.request({ type: 'fs.write', target: join(ws, 'c2.txt'), caller: 'tool-a' })
  assert.equal(state.calls, 1) // 同类任意目标免问
  assert.equal(r2.exemption, 'user-preauthorized')
  assert.equal(r2.auditEntry.approvalDecision, 'auto')

  const r3 = await svc.request({ type: 'fs.write', target: join(ws, 'c3.txt'), caller: 'tool-b' })
  assert.equal(state.calls, 2) // 不跨调用者消费（fiber 隔离精神）
  assert.equal(r3.decision, 'approved')

  // class 授权绑定效果类型：fs.write 类不覆盖 fs.delete-permanent（须另批）
  await svc.request({ type: 'fs.delete-permanent', target: join(ws, 'c1.txt'), caller: 'tool-a' })
  assert.equal(state.calls, 3)
})

/* ─────────────────────── park/resume 一等阻塞（R15） ─────────────────────── */

test('S16-4 park/resume：请求挂起不阻塞事件循环，手动回填后唤醒（R15 雏形）', async () => {
  const sink = auditSink()
  const svc = new ApprovalService({ audit: sink.cb, timeoutMs: 5_000 })

  const p = svc.request({ type: 'fs.write', target: join(ws, 'park.txt'), caller: 'tool-a' })
  const tickets = svc.listPending()
  assert.equal(tickets.length, 1)
  assert.equal(tickets[0]!.request.target, join(ws, 'park.txt'))
  assert.equal(tickets[0]!.timeoutMs, 5_000)

  // park 期间事件循环可响应（不被占死）
  let loopAlive = false
  await sleep(15).then(() => { loopAlive = true })
  assert.equal(loopAlive, true)
  assert.equal(svc.listPending().length, 1) // 仍未决

  // resume：回填决定唤醒
  assert.equal(svc.resolve(tickets[0]!.id, { verdict: 'approve' }), true)
  const r = await p
  assert.equal(r.decision, 'approved')
  assert.equal(r.auditEntry.approvalDecision, 'approved')
  assert.equal(svc.listPending().length, 0)

  // 已决票据再回填 → false（幂等，先到先得）
  assert.equal(svc.resolve(tickets[0]!.id, { verdict: 'approve' }), false)
})

test('S16-5 park 期间会话可响应其他请求：并发审批互不阻塞（R15）', async () => {
  const sink = auditSink()
  const slowTarget = join(ws, 'slow.txt')
  const svc = new ApprovalService({
    audit: sink.cb,
    timeoutMs: 5_000,
    decide: (req) => {
      if (req.target === slowTarget) {
        return new Promise<ApprovalReply>(() => {}) // 模拟"用户离开"（永不回复）
      }
      return { verdict: 'approve', scope: 'once' }
    },
  })

  const pSlow = svc.request({ type: 'fs.write', target: slowTarget, caller: 'tool-a' })
  const pFast = svc.request({ type: 'fs.write', target: join(ws, 'fast.txt'), caller: 'tool-b' })

  // 快请求立即完成——慢请求 park 不阻塞会话处理新请求
  const rFast = await pFast
  assert.equal(rFast.decision, 'approved')
  assert.equal(svc.listPending().length, 1)

  // 会话仍可响应定时事件（R15：等待期间资源释放）
  await sleep(10)
  assert.equal(svc.listPending().length, 1)

  // resume：手动回填唤醒慢请求
  const [slowTicket] = svc.listPending()
  assert.ok(slowTicket)
  assert.equal(svc.resolve(slowTicket.id, { verdict: 'approve', scope: 'object' }), true)
  const rSlow = await pSlow
  assert.equal(rSlow.decision, 'approved')
  assert.ok(rSlow.grantId)
})

/* ─────────────────────── 超时自动 deny（R16 / §5.11.7 三态） ─────────────────────── */

test('S16-6 审批超时自动 deny：timeout 与用户拒绝分列（R16 / §5.11.7 abandoned ≠ refuted）', async () => {
  const sink = auditSink()
  const svc = new ApprovalService({
    audit: sink.cb,
    timeoutMs: 40,
    decide: () => new Promise<ApprovalReply>(() => {}), // 永不回复
  })
  const r = await svc.request({ type: 'fs.write', target: join(ws, 't.txt'), caller: 'tool-a' })
  assert.equal(r.decision, 'timeout')
  assert.equal(r.ok, false)
  assert.equal(r.auditEntry.approvalDecision, 'timeout')
  assert.equal(r.auditEntry.verdict, 'deny')
  assert.match(r.auditEntry.reason ?? '', /超时/)
  assert.equal(svc.listPending().length, 0)

  // 对照：用户显式拒绝 → 'denied'（与超时分列，三态披露可区分）
  const svc2 = new ApprovalService({
    audit: sink.cb,
    timeoutMs: 40,
    decide: () => ({ verdict: 'reject', note: '不要动这个文件' }),
  })
  const r2 = await svc2.request({ type: 'fs.write', target: join(ws, 't2.txt'), caller: 'tool-a' })
  assert.equal(r2.decision, 'denied')
  assert.equal(r2.ok, false)
  assert.equal(r2.auditEntry.approvalDecision, 'denied')
  assert.match(r2.auditEntry.reason ?? '', /不要动/)
})

test('S16-6b decide 回调故障 fail-closed：以 denied 结算', async () => {
  const sink = auditSink()
  const svc = new ApprovalService({
    audit: sink.cb,
    timeoutMs: 60_000,
    decide: () => { throw new Error('审批面板崩溃') },
  })
  const r = await svc.request({ type: 'fs.write', target: join(ws, 'crash.txt'), caller: 'tool-a' })
  assert.equal(r.decision, 'denied')
  assert.equal(r.auditEntry.approvalDecision, 'denied')
  assert.match(r.auditEntry.reason ?? '', /fail-closed/)
})

/* ─────────────────────── 会话关停 cancel / dispose（§9.3 第 7 条） ─────────────────────── */

test('S16-7 会话关停 cancelAllPending：全部挂起以 cancelled 唤醒且清空（§9.3 第 7 条强制语义）', async () => {
  const sink = auditSink()
  const svc = new ApprovalService({ audit: sink.cb, timeoutMs: 60_000 })

  const p1 = svc.request({ type: 'fs.write', target: join(ws, 'p1.txt'), caller: 'tool-a' })
  const p2 = svc.request({ type: 'fs.write', target: join(ws, 'p2.txt'), caller: 'tool-b' })
  assert.equal(svc.listPending().length, 2)

  const n = svc.cancelAllPending('session-shutdown')
  assert.equal(n, 2)
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.decision, 'cancelled')
  assert.equal(r2.decision, 'cancelled')
  // cancel 以 timeout 语义记账（方案 §5.3.6），reason 区分取消来源
  assert.equal(r1.auditEntry.approvalDecision, 'timeout')
  assert.match(r1.auditEntry.reason ?? '', /session-shutdown/)
  assert.equal(svc.listPending().length, 0)

  // 服务未被破坏：新请求可继续 park 并正常结算
  const p3 = svc.request({ type: 'fs.write', target: join(ws, 'p3.txt'), caller: 'tool-a' })
  assert.equal(svc.listPending().length, 1)
  svc.cancelAllPending()
  assert.equal((await p3).decision, 'cancelled')
})

test('S16-8 AbortSignal：外部取消以 cancelled 唤醒（防 park 泄漏，§9.3 第 7 条）', async () => {
  const svc = new ApprovalService({ timeoutMs: 60_000 })
  const ctrl = new AbortController()

  const p = svc.request({ type: 'fs.write', target: join(ws, 'sig.txt'), caller: 'tool-a' }, { signal: ctrl.signal })
  await sleep(10)
  assert.equal(svc.listPending().length, 1)
  ctrl.abort(new Error('用户取消会话'))
  const r = await p
  assert.equal(r.decision, 'cancelled')
  assert.equal(r.auditEntry.approvalDecision, 'timeout')
  assert.equal(svc.listPending().length, 0)

  // 信号已中止时发起新请求：立即 cancelled（不留挂起）
  const ctrl2 = new AbortController()
  ctrl2.abort()
  const r2 = await svc.request(
    { type: 'fs.write', target: join(ws, 'sig2.txt'), caller: 'tool-a' },
    { signal: ctrl2.signal },
  )
  assert.equal(r2.decision, 'cancelled')
  assert.equal(svc.listPending().length, 0)
})

test('S16-9 dispose：作废全部授权记忆 + cancel 全部 pending（会话级授权随会话失效）', async () => {
  const sink = auditSink()
  const target = join(ws, 'd.txt')
  const hangTarget = join(ws, 'hang.txt')
  const svc = new ApprovalService({
    audit: sink.cb,
    timeoutMs: 60_000,
    decide: (req) => req.target === hangTarget
      ? new Promise<ApprovalReply>(() => {}) // 挂起制造 pending
      : { verdict: 'approve', scope: 'object' },
  })

  await svc.request({ type: 'fs.write', target, caller: 'tool-a' })
  assert.notEqual(svc.lookupGrant({ type: 'fs.write', target, caller: 'tool-a' }), undefined)

  const p = svc.request({ type: 'fs.write', target: hangTarget, caller: 'tool-b' })
  await sleep(5)
  assert.equal(svc.listPending().length, 1)

  svc.dispose()
  assert.equal((await p).decision, 'cancelled') // pending 全 cancel
  assert.equal(svc.lookupGrant({ type: 'fs.write', target, caller: 'tool-a' }), undefined) // 授权记忆作废
  const after = await svc.request({ type: 'fs.write', target, caller: 'tool-a' })
  assert.equal(after.decision, 'denied') // dispose 后服务关停
  assert.match(after.auditEntry.reason ?? '', /dispose/)
})

test('S16-10 timeoutMs<=0 回退缺省：超时不可配置关闭（§9.3 第 7 条）', async () => {
  const svc = new ApprovalService({ timeoutMs: 0, decide: () => new Promise<ApprovalReply>(() => {}) })
  const p = svc.request({ type: 'fs.write', target: join(ws, 'nofail.txt'), caller: 'tool-a' })
  await sleep(30)
  assert.equal(svc.listPending().length, 1) // 未因 timeoutMs:0 立即超时
  svc.cancelAllPending()
  assert.equal((await p).decision, 'cancelled')
})

/* ─────────────────────── 豁免通道封闭枚举（免审批但记录） ─────────────────────── */

test('S16-11 豁免·temp-area：临时区写入免问，审计记 exempted + temp-area', async () => {
  const sink = auditSink()
  const { state, decide } = countingDecide({ verdict: 'approve' })
  const svc = new ApprovalService({ decide, audit: sink.cb, tempAreaRoot: tempArea })

  const r = await svc.request({ type: 'fs.write', target: join(tempArea, 'inter.txt'), caller: 'tool-a' })
  assert.equal(r.decision, 'approved')
  assert.equal(state.calls, 0) // 未问询
  assert.equal(r.exemption, 'temp-area')
  assert.equal(r.auditEntry.approvalDecision, 'exempted')
  assert.equal(r.auditEntry.verdict, 'allow') // 免审批不等于不记录
  assert.equal(r.auditEntry.exemption, 'temp-area')
})

test('S16-12 豁免·trash-default：回收站式删除低门槛免问', async () => {
  const { state, decide } = countingDecide({ verdict: 'approve' })
  const svc = new ApprovalService({ decide })
  const r = await svc.request({ type: 'fs.trash', target: join(ws, 'old.txt'), caller: 'tool-a' })
  assert.equal(state.calls, 0)
  assert.equal(r.exemption, 'trash-default')
  assert.equal(r.auditEntry.approvalDecision, 'exempted')
})

test('S16-13 provenance 豁免：同调用者覆盖自己创建的产物免问，审计标 auto-by-provenance（R14 雏形）', async () => {
  const sink = auditSink()
  const { state, decide } = countingDecide({ verdict: 'approve', scope: 'once' })
  const provenance = new InMemoryProvenanceRegistry()
  const svc = new ApprovalService({ decide, audit: sink.cb, provenance, taskId: 'task-1' })
  const target = join(ws, 'prov.txt')

  // 第一次：创建（无 provenance 记录）→ 问询批准，服务代登记创建事实
  const r1 = await svc.request({ type: 'fs.write', target, caller: 'tool-a' })
  assert.equal(state.calls, 1)
  assert.equal(r1.decision, 'approved')
  assert.equal(provenance.isCreatedBy('tool-a', openBeneath(target), 'task-1'), true)

  // 第二次：覆盖自己创建的产物 → same-session-artifact 免问，标 auto-by-provenance
  const r2 = await svc.request({ type: 'fs.write', target, caller: 'tool-a' })
  assert.equal(state.calls, 1)
  assert.equal(r2.exemption, 'same-session-artifact')
  assert.equal(r2.auditEntry.approvalDecision, 'auto-by-provenance')

  // 另一调用者写同文件：无 provenance 记录（不可引用他人创建事实作证）→ 须问询
  await svc.request({ type: 'fs.write', target, caller: 'tool-b' })
  assert.equal(state.calls, 2)
})

/* ─────────────────────── delete-permanent 分档（R17 雏形） ─────────────────────── */

test('S16-14 delete-permanent 分档：不进低门槛豁免、须审批；用户预授权可免后续问询', async () => {
  const sink = auditSink()
  const { state, decide } = countingDecide({ verdict: 'reject', note: '不许永久删' })
  const svc = new ApprovalService({ decide, audit: sink.cb, tempAreaRoot: tempArea })

  // 即使 target 落在临时区，delete-permanent 也不命中 temp-area（该豁免仅 fs.write）→ 问询 → 拒绝
  const r1 = await svc.request({
    type: 'fs.delete-permanent', target: join(tempArea, 'x.txt'), caller: 'tool-a',
  })
  assert.equal(state.calls, 1)
  assert.equal(r1.decision, 'denied')
  assert.equal(r1.ok, false)
  assert.equal(r1.exemption, undefined)

  // 批准 object 级后同目标免问（user-preauthorized——用户显式预授权）
  const svc2 = new ApprovalService({
    audit: sink.cb,
    tempAreaRoot: tempArea,
    decide: () => ({ verdict: 'approve', scope: 'object' }),
  })
  const t = join(ws, 'perm-target.txt')
  const d1 = await svc2.request({ type: 'fs.delete-permanent', target: t, caller: 'tool-a' })
  assert.equal(d1.decision, 'approved')
  assert.ok(d1.grantId)
  const d2 = await svc2.request({ type: 'fs.delete-permanent', target: t, caller: 'tool-a' })
  assert.equal(d2.exemption, 'user-preauthorized')
  assert.equal(d2.auditEntry.approvalDecision, 'auto')
  assert.equal(d2.grantId, d1.grantId)
})

/* ─────────────────────── ApprovalServiceStub 接线（S12→S16 接入点） ─────────────────────── */

test('S16-15 ApprovalServiceStub 接线：FsEffectHandler 注入审批服务，授权记忆命中放行（S12→S16 接入点验证）', async () => {
  const sink = auditSink()
  const svc = new ApprovalService({ audit: sink.cb, tempAreaRoot: tempArea })

  // 结构兼容：ApprovalService 可直接赋给 handlers.ts 的 ApprovalServiceStub
  const stub: ApprovalServiceStub = svc
  assert.equal(typeof stub.lookupGrant, 'function')

  const file = join(ws, 'grantme.txt')
  // 预登记 object 级用户预授权（objectKey 与处理器 openBeneath 同锚）
  svc.recordGrant({
    scope: 'object', objectKey: openBeneath(file), grantedBy: 'user',
    type: 'fs.write', caller: 'tool-fs',
  })

  const h = new FsEffectHandler({
    workspaceRoot: () => ws, tempAreaRoot: tempArea, audit: sink.cb, approval: svc,
  })
  const w = await h.handle({ type: 'fs.write', target: file, caller: 'tool-fs', args: ['granted'] })
  assert.equal(w.ok, true) // 授权记忆命中 → 放行
  assert.equal(await readFile(file, 'utf8'), 'granted')
  assert.equal(w.auditEntry.verdict, 'allow')

  // 对照：无审批服务的处理器 → 未命中豁免且无授权 → deny（S12 既有行为不变）
  const h2 = new FsEffectHandler({ workspaceRoot: () => ws, tempAreaRoot: tempArea, audit: sink.cb })
  const w2 = await h2.handle({ type: 'fs.write', target: join(ws, 'nogrant.txt'), caller: 'tool-fs', args: ['x'] })
  assert.equal(w2.ok, false)
  assert.match(w2.error ?? '', /未命中豁免且无审批授权/)
})

/* ─────────────────────── 纯函数与常量 ─────────────────────── */

test('S16-16 豁免通道封闭枚举判定 + 缺省常量', () => {
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 120_000) // 缺省超时 120s
  const ctx = { tempAreaRoot: tempArea }

  // temp-area 仅 fs.write；fs.read / delete-permanent 不命中
  assert.equal(evaluateExemptionChannels({ type: 'fs.read', target: join(tempArea, 'a'), caller: 't' }, ctx), undefined)
  assert.equal(evaluateExemptionChannels({ type: 'fs.delete-permanent', target: join(tempArea, 'a'), caller: 't' }, ctx), undefined)
  assert.equal(evaluateExemptionChannels({ type: 'fs.write', target: join(tempArea, 'a'), caller: 't' }, ctx), 'temp-area')
  // trash-default 对 fs.trash 恒命中（无需 tempAreaRoot）
  assert.equal(evaluateExemptionChannels({ type: 'fs.trash', target: '/x', caller: 't' }, {}), 'trash-default')

  // user-preauthorized 通道位判定
  assert.equal(isUserPreauthorizedGrant(undefined), false)
  const g: GrantRecord = {
    id: 'g1', scope: 'object', classKey: 'fs.write#t', grantedBy: 'user',
    issuedAt: 0, expiresAt: 0, caller: 't', type: 'fs.write',
  }
  assert.equal(isUserPreauthorizedGrant(g), true)
  assert.equal(isUserPreauthorizedGrant({ ...g, grantedBy: 'policy' }), false)
})
