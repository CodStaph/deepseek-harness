/**
 * S23 元层纪律收口测试：审计一致性哨兵 + 判据独立重算器 + 三态披露与基线指纹。
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.11.3 / §5.11.5 / §5.11.7。
 * 覆盖：
 * - 哨兵三类矛盾（grant-audit-mismatch / dual-verdict / exemption-conflict）→ 冻结建议（R40）
 * - 哨兵是检测器非证明（哥德尔第二边界定性）
 * - 独立重算器：一致 cross_checked / 不一致 frozen（R42），复核器非第二判据
 * - 三态披露：放行/拦截/豁免分列 + 超时 deny ≠ 用户 deny（基线指纹承载）
 * 测试映射：R40（哨兵冻结）/ R41（互指键 + 基线指纹）/ R42（独立重算一致/冻结）。
 * 并入 dsh 后以 vitest 运行（批次 1-2 迁移）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runSentinel, SENTINEL_NOTE } from '../src/meta/sentinel.ts';
import type { SentinelInput } from '../src/meta/sentinel.ts';
import { recheckDecisions, recheckWithSentinel } from '../src/meta/recheck.ts';
import type { RecheckSample, IndependentCriterion } from '../src/meta/recheck.ts';
import { buildDisclosureReport, DISCLOSURE_NOTE } from '../src/meta/disclosure.ts';
import type { BaselineFingerprint } from '../src/meta/disclosure.ts';

/* ─────────────── 哨兵：授权库与审计账矛盾（R40） ─────────────── */
const FP: BaselineFingerprint = { assemblyPlanId: 'plan-20261001', trustPolicyFingerprint: 'fp-test' };

test('S23-1 哨兵：授权记录无对应 allow 审计 → grant-audit-mismatch + 冻结授权记忆', () => {
    const input: SentinelInput = {
        planId: 'plan-20261001',
        grants: [{ id: 'g1', type: 'net.fetch', classKey: 'net.fetch#tool-net', grantedBy: 'user' }],
        auditEntries: [],
    };
    const r = runSentinel(input);
    assert.equal(r.conflicted, true);
    const c = r.conflicts.find((x) => x.kind === 'grant-audit-mismatch');
    assert.ok(c, '应检出授权-审计不一致');
    assert.equal(c?.freeze, 'grant-memory');
    assert.ok(r.freezeTargets.includes('grant-memory'));
});

test('S23-2 哨兵：授权记录有对应 allow 审计 → 不报 grant-audit-mismatch', () => {
    const input: SentinelInput = {
        planId: 'plan-20261001',
        grants: [{ id: 'g1', type: 'net.fetch', objectKey: 'https://api.example.com', classKey: 'net.fetch#tool-net', grantedBy: 'user' }],
        auditEntries: [{ type: 'net.fetch', target: 'https://api.example.com', verdict: 'allow' }],
    };
    const r = runSentinel(input);
    assert.equal(r.conflicts.some((x) => x.kind === 'grant-audit-mismatch'), false);
});

test('S23-3 哨兵：同目标双判定（allow+deny）→ dual-verdict + 冻结豁免', () => {
    const input: SentinelInput = {
        planId: 'plan-20261001',
        grants: [],
        auditEntries: [
            { type: 'fs.write', target: '/tmp/a.txt', verdict: 'allow' },
            { type: 'fs.write', target: '/tmp/a.txt', verdict: 'deny' },
        ],
    };
    const r = runSentinel(input);
    const c = r.conflicts.find((x) => x.kind === 'dual-verdict');
    assert.ok(c, '应检出双判定矛盾');
    assert.equal(c?.freeze, 'exemption');
});

test('S23-4 哨兵：豁免命中但契约未声明 → exemption-conflict + 冻结豁免', () => {
    const input: SentinelInput = {
        planId: 'plan-20261001',
        grants: [],
        auditEntries: [{ type: 'fs.trash', target: '/x', verdict: 'allow', exemption: 'trash-default' }],
        contractAllowsExemption: (ch) => ch === 'temp-area',
    };
    const r = runSentinel(input);
    const c = r.conflicts.find((x) => x.kind === 'exemption-conflict');
    assert.ok(c, '豁免命中但契约未声明应检出');
    assert.equal(c?.freeze, 'exemption');
});

test('S23-5 哨兵：全绿不蕴含无矛盾（哥德尔第二边界定性）', () => {
    const input: SentinelInput = { planId: 'p', grants: [], auditEntries: [] };
    const r = runSentinel(input);
    assert.equal(r.conflicted, false);
    assert.equal(r.conflicts.length, 0);
    assert.equal(r.note, SENTINEL_NOTE);
    assert.ok(SENTINEL_NOTE.includes('不是一致性的证明'));
});

/* ─────────────── 独立重算器（R42，复核器非第二判据） ─────────────── */
const CRIT: IndependentCriterion = {
    allows: (type, target) => type === 'net.fetch' && target === 'https://api.example.com',
    allowsExemption: (ch) => ch === 'trash-default',
};

test('S23-6 重算：样本一致 → cross_checked', () => {
    const samples: RecheckSample[] = [
        { type: 'net.fetch', target: 'https://api.example.com', actualVerdict: 'allow' },
        { type: 'fs.write', target: '/x', actualVerdict: 'deny' },
    ];
    const r = recheckDecisions(samples, CRIT);
    assert.equal(r.consistent, true);
    assert.equal(r.outcome, 'cross_checked');
    assert.equal(r.mismatches.length, 0);
});

test('S23-7 重算：样本不一致 → frozen（注入故意不一致）', () => {
    const samples: RecheckSample[] = [
        { type: 'net.fetch', target: 'https://evil.com', actualVerdict: 'allow' },
    ];
    const r = recheckDecisions(samples, CRIT);
    assert.equal(r.consistent, false);
    assert.equal(r.outcome, 'frozen');
    assert.equal(r.mismatches.length, 1);
    assert.equal(r.mismatches[0]!.expected, 'deny');
});

test('S23-8 重算：豁免命中且豁免规则允许 → allow（与效果系统一致）', () => {
    const samples: RecheckSample[] = [
        { type: 'fs.trash', target: '/tmp/a', actualVerdict: 'allow', exemption: 'trash-default' },
    ];
    const r = recheckDecisions(samples, CRIT);
    assert.equal(r.consistent, true);
    assert.equal(r.outcome, 'cross_checked');
});

test('S23-9 recheckWithSentinel：一致 → cross_checked，不触发冻结', () => {
    const r = recheckWithSentinel([
        { type: 'net.fetch', target: 'https://api.example.com', actualVerdict: 'allow' },
    ], CRIT);
    assert.equal(r.outcome, 'cross_checked');
    assert.equal(r.consistent, true);
});

/* ─────────────── 三态披露与基线指纹（R41 / §5.11.7） ─────────────── */
test('S23-10 三态披露：放行/拦截/豁免分列 + 基线指纹', () => {
    const r = buildDisclosureReport([
        { verdict: 'allow' },
        { verdict: 'allow', exemption: 'temp-area' },
        { verdict: 'deny' },
    ], FP);
    assert.equal(r.stats.allowed, 1);
    assert.equal(r.stats.exempted, 1);
    assert.equal(r.stats.blocked, 1);
    assert.equal(r.fingerprint.assemblyPlanId, 'plan-20261001');
    assert.equal(r.fingerprint.trustPolicyFingerprint, 'fp-test');
});

test('S23-11 超时 deny ≠ 用户 deny：分列统计（abandoned ≠ refuted）', () => {
    const r = buildDisclosureReport([
        { verdict: 'deny', approvalDecision: 'timeout' },
        { verdict: 'deny', approvalDecision: 'denied' },
        { verdict: 'deny', approvalDecision: 'timeout' },
    ], FP);
    assert.equal(r.stats.blocked, 3);
    assert.equal(r.stats.timeoutDenied, 2);
    assert.equal(r.stats.userDenied, 1);
    assert.equal(r.note, DISCLOSURE_NOTE);
    assert.ok(DISCLOSURE_NOTE.includes('不等于用户判定该拒'));
});

test('S23-12 豁免放行不计入 allowed，计入 exempted', () => {
    const r = buildDisclosureReport([
        { verdict: 'allow', exemption: 'same-session-artifact' },
        { verdict: 'allow', exemption: 'trash-default' },
        { verdict: 'allow' },
    ], FP);
    assert.equal(r.stats.exempted, 2);
    assert.equal(r.stats.allowed, 1);
});