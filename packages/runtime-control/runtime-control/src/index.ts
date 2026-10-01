/**
 * 运行时管控层 · 对外入口
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §7.2（核心接口汇总）
 * 阶段：S9（骨架）＋S10（服务膜接线）＋S11（令牌预颁发）＋S12（效果系统）＋
 *       S13（执行隔离域 standard）＋S14（运行时违规处理）＋S16（审批语义 +
 *       No-Löb 硬排除）＋S22（root 调用者登记）＋S17（mcp.call 效果 + 外发检查）＋
*       S18（isolate 档 + post-hoc + fiber 撤销 + 写锁）——
 *       已导出膜/令牌/效果类型、膜配置注册表（membrane-config）、installMembrane
 *       （integration）、预颁发器（issuer）、四类效果处理器（effects/handlers）、
 *       EffectApi（effects/api）、隔离域机制（realm）、违规处理器（violation）、
 *       审批服务（effects/approval）、No-Löb 硬排除（meta/no-lob）、root 调用者
 *       登记（meta/root）、MCP 效果处理器与外发检查（effects/mcp、effects/exfiltration）、
 *       收尾自检（post-hoc）、fiber 登记（fiber）、写锁（write-lock）；
 *       + S23（批次 5b）元层纪律收口：一致性哨兵（meta/sentinel）、独立重算器
 *       （meta/recheck）、三态披露与基线指纹（meta/disclosure）。
 *       未落地模块（S15/S19–S22 余项已随批次落地，G 终验项）不预导出。
 *
 * 与装配控制层的依赖方向：runtime-control → assembly 单向（S11 预颁发器与 S14
 * 违规审计消费装配类型）。
 */

export {
  createMembrane,
  SecurityViolation,
  DEFAULT_MEMBRANE,
  SENSITIVE_MEMBRANE,
} from './membrane.ts'
export type {
  MembraneConfig,
  MembraneAuditEntry,
} from './membrane.ts'

export {
  CapabilityToken,
  deriveFiberToken,
  DEFAULT_FIBER_TTL_MS,
} from './capability.ts'
export type {
  CapabilityHandle,
  TokenRenewalPolicy,
} from './capability.ts'

export type {
  EffectType,
  EffectRequest,
  EffectResult,
  EffectHandler,
  EffectAuditEntry,
} from './effect.ts'

/* ──────────────── S10：服务膜接线 ──────────────── */
export {
  SENSITIVE_SERVICE_MEMBRANES,
  STANDARD_SERVICE_MEMBRANES,
  buildMembraneRegistry,
  resolveMembraneConfig,
} from './membrane-config.ts'
export { installMembrane } from './integration.ts'
export type { MembraneContext } from './integration.ts'

/* ──────────────── S11：能力令牌颁发 ──────────────── */
export { issueTokens } from './issuer.ts'
export type { IssueTokenOptions, IssueTokenResult } from './issuer.ts'

/* ──────────────── S12：效果系统（处理器 + API） ──────────────── */
export {
  FsEffectHandler,
  NetEffectHandler,
  ProcEffectHandler,
  EnvEffectHandler,
  FsLocalTrashBackend,
  openBeneath,
  isInside,
  evaluateExemption,
} from './effects/handlers.ts'
export type {
  SandboxMode,
  ApprovalServiceStub,
  FsTrashBackend,
  ProcResult,
} from './effects/handlers.ts'
export { createEffectApi } from './effects/api.ts'
export type { EffectApi } from './effects/api.ts'

/* ──────────────── S17：mcp.call 效果 + 数据外发检查 ──────────────── */
export {
  estimateOutboundBytes,
  checkExfiltration,
  DEFAULT_SENSITIVE_SCANNERS,
  credentialFieldScanner,
  sessionTokenScanner,
} from './effects/exfiltration.ts'
export type { SensitiveScanner } from './effects/exfiltration.ts'
export { McpEffectHandler, parseMcpTarget } from './effects/mcp.ts'
export type { McpClientAdapter, McpEffectHandlerOptions } from './effects/mcp.ts'

/* ──────────────── S13：执行隔离域（standard） ──────────────── */
export {
  createWhitelistedRequire,
  freezeCriticalPrototypes,
  assignRealmLevel,
  enableRealm,
  REALM_LEVELS,
} from './realm.ts'
export type {
  RealmLevel,
  RealmConfig,
  RealmAssignmentOptions,
} from './realm.ts'

/* ──────────────── S14：运行时违规处理 + 审计 ──────────────── */
export { DefaultViolationHandler, auditViolationToDisk } from './violation.ts'
export type {
  ViolationPolicy,
  ViolationHandler,
  ViolationContext,
} from './violation.ts'

/* ──────────────── S18：isolate 档 + 阈值升级（违规处理扩展） ──────────────── */
export {
  IsolateViolationHandler,
  PluginIsolatedError,
  IsolateEscalationTracker,
  DEFAULT_ISOLATE_THRESHOLD,
} from './violation.ts'
export type {
  RuntimeController,
  IsolateViolationHandlerOptions,
} from './violation.ts'

/* ──────────────── S16：审批语义（三档授权 + park/resume + No-Löb） ──────────────── */
export {
  ApprovalService,
  evaluateExemptionChannels,
  isUserPreauthorizedGrant,
  InMemoryProvenanceRegistry,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_GRANT_TTL_MS,
} from './effects/approval.ts'
export type {
  GrantScope,
  ApprovalDecision,
  ApprovalReply,
  GrantRecord,
  GrantInput,
  ExemptionKind,
  ProvenanceRegistry,
  ApprovalTicket,
  ApprovalOutcome,
  ApprovalServiceOptions,
  ApprovalRequestOptions,
} from './effects/approval.ts'

/* ──────────────── S16 先置：No-Löb 硬排除（meta/no-lob） ──────────────── */
export {
  META_CALLERS,
  isMetaCaller,
  assertNotMeta,
  assertNotMetaCaller,
} from './meta/no-lob.ts'

/* ──────────────── S22：root 调用者登记 + L4 自举面诚实登记 ──────────────── */
export {
  ROOT_CALLER,
  isRootCaller,
  markRootAudit,
  ROOT_SCOPE_NOTE,
} from './meta/root.ts'

/* ──────────────── S18：并发写锁 + 收尾自检 + fiber 精确撤销 ──────────────── */
export { EffectWriteLock } from './write-lock.ts'
export { runPostHocReview } from './post-hoc.ts'
export type {
  ReviewScope,
  PostHocReview,
  PostHocFinding,
} from './post-hoc.ts'
export { FiberTokenRegistry } from './fiber.ts'

/* ──────────────── S15：严格模式灰度与门禁 ──────────────── */
export { resolveCapabilityMode, isStrictMode, gradientGate } from './strict.ts'
export type {
  CapabilityMode,
  StrictModeOptions,
  GradientInput,
} from './strict.ts'

/* ──────────────── S19：MCP 深度内建（通道唯一化 + 反向请求效果化） ──────────────── */
export { McpRuntime, defaultInProcessExecutor } from './mcp/runtime.ts'
export type {
  McpServerRealm,
  McpServerBinding,
  McpServerState,
  ManagedServer,
  McpServerLifecycleEvent,
  McpCallExecutor,
  McpProtocolAdapter,
  McpRuntimeOptions,
} from './mcp/runtime.ts'
export { InboundRequestHandler, DEFAULT_SAMPLING_OUTBOUND_BYTES } from './mcp/inbound.ts'
export type {
  InboundRequestType,
  SamplingRequest,
  SamplingResult,
  ElicitationRequest,
  InboundRequest,
  InboundSource,
  InboundSourceLookup,
  LlmSampler,
  InboundRequestHandlerOptions,
} from './mcp/inbound.ts'

/* ──────────────── 批次 4b（S20）：MCP server 沙箱档位 + 生命周期 ──────────────── */
export { makeSandboxProfile, SANDBOX_PROFILES, DEFAULT_MCP_UNKNOWN_MODE } from './sandbox/sandbox-profiles.ts'
export type {
  SandboxPlatform,
  SandboxRealm,
  SandboxGateway,
  SandboxResourceLimits,
  SandboxProfile,
  McpUnknownMode,
} from './sandbox/sandbox-profiles.ts'
export { minimalEnv, confineCommand } from './sandbox/confine.ts'
export type { ConfineInput, ConfinedCommand } from './sandbox/confine.ts'
export { ESCAPE_CASES, evaluateEscapeCase } from './sandbox/escape-cases.ts'
export type { EscapeCase, EscapeExpectation } from './sandbox/escape-cases.ts'
export { RESIDUAL_RISK_REGISTRY, getResidualRisk, validateResidualRegistry } from './sandbox/registry.ts'
export type { ResidualRiskEntry, RiskStatus } from './sandbox/registry.ts'

/* ──────────────── 批次 4c：OS 原生桥（P1–P3，方案第 17 章） ──────────────── */
export {
  sha256Hex,
  verifyBridgeManifest,
  mirrorOpenBeneath,
  createMirrorOsBridge,
  MemoryManagedProcess,
} from './native/bridge.ts'
export type {
  OsRealm,
  ManagedProcess,
  SpawnManagedOptions,
  WindowsRestrictedProcessOptions,
  WindowsAclBridge,
  AtomicOpen,
  OsBridge,
  ManifestEntry,
  BridgeManifest,
} from './native/bridge.ts'

/* ──────────────── 批次 5（并入批次 1-5）：真实 OS 原生桥（P1–P2 真实接线） ──────────────── */
export {
  createNativeOsBridge,
  WindowsJobManagedProcess,
  RestrictedRunnerProcess,
  WindowsAclRestrictedBridge,
  PosixProcessGroupManagedProcess,
} from './native/real-bridge.ts'
export type { NativeOsBridgeOptions } from './native/real-bridge.ts'

/* ──────────────── M5 批次 5a（S21）：skill 面管控（manifest + 扫描 + 归因） ──────────────── */
export {
  parseSkillFile,
  DEFAULT_UNKNOWN_MANIFEST,
  SKILL_TRUST_RANK,
  meetsTrustLevel,
  isSkillLoadable,
} from './skill/manifest.ts'
export type { SkillTrust, SkillManifest, SkillFileInput } from './skill/manifest.ts'
export {
  SKILL_SCAN_CODES,
  UNAUTHORIZED_DIRECTIVE_PATTERNS,
  scanUnauthorizedDirectives,
  scanSensitiveContent,
  scanManifestConsistency,
  scanSkill,
  decideSkillLoading,
} from './skill/scan.ts'
export type { UnauthorizedDirectivePattern, SkillScanInput } from './skill/scan.ts'
export {
  SKILL_ATTRIBUTION_CODES,
  skillCapabilityVerdict,
  attributeSkillEffect,
  skillExceededDiagnostic,
} from './skill/attribution.ts'
export type { SkillAttributionInput, SkillAttributionResult } from './skill/attribution.ts'

/* ──────────────── M5 批次 5b（S23）：元层纪律收口（哨兵/重算器/三态披露） ──────────────── */
export {
  runSentinel,
  SENTINEL_NOTE,
} from './meta/sentinel.ts'
export type {
  ConsistencyKind,
  FreezeTarget,
  SentinelConflict,
  GrantSnapshot,
  AuditSnapshot,
  SentinelInput,
  SentinelOptions,
  SentinelResult,
} from './meta/sentinel.ts'
export {
  recheckDecisions,
  recheckWithSentinel,
} from './meta/recheck.ts'
export type {
  RecheckSample,
  IndependentCriterion,
  RecheckMismatch,
  RecheckResult,
  RecheckOptions,
} from './meta/recheck.ts'
export {
  buildDisclosureReport,
  DISCLOSURE_NOTE,
} from './meta/disclosure.ts'
export type {
  DisclosureStats,
  BaselineFingerprint,
  DisclosureReport,
  DisclosureAuditEntry,
} from './meta/disclosure.ts'

/* ──────────────── 批次 1-4（运行时线真实接线）：膜挂 Context.get ──────────────── */
export { wrapReflectGet, installMembraneOnContext } from './integration-cordis.ts'
export type { ReflectLike } from './integration-cordis.ts'

/* ──────────────── 批次 1-4（运行时线真实接线）：McpRuntime 接 mcp-client ──────────────── */
export { DshMcpClientAdapter, DSH_RUNTIME_CONTROL_CLIENT_INFO } from './mcp/dsh-mcp-adapter.ts'
export type {
  DshMcpStdioServerConfig,
  DshMcpStreamableHttpServerConfig,
  DshMcpServerConfig,
  DshMcpClientAdapterOptions,
} from './mcp/dsh-mcp-adapter.ts'

/* ──────────────── 批次 1-4（运行时线真实接线）：skill 真装载链接入 ──────────────── */
export { toManifestFromSource, assessLoadedSkill } from './skill/fs-adapter.ts'
export type {
  RealSkillSourceKind,
  RealSkillParsed,
  RealSkillSource,
  SkillAssessment,
} from './skill/fs-adapter.ts'

/* ──────────────── 批次 1-4（运行时线真实接线）：fs 真实装配链 ──────────────── */
export { bindRealFsEffect, makeRealTrashBackend } from './fs/real-fs-handler.ts'
export type { RealFsBinding } from './fs/real-fs-handler.ts'
