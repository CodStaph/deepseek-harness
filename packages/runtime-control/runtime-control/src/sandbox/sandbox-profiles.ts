/**
 * 运行时管控层 · MCP server 沙箱档位模板（三档 × 三平台）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.8.5（server 进程沙箱档位）
 * 阶段：批次 4b（M4 S20 沙箱档位 + 生命周期）——三平台机制直接复用 sandbox-local
 *       既有链（M0 修订）；本文件承载**模板化配置**，配合逃逸用例回归 CI 防
 *       档位间漂移（9.3 第 9 条）。
 *
 * 三档（方案 5.8.5 表）：
 * - mcp-trusted：仓库内/已验证 server → 标准沙箱（路径绑定 + syscall 白名单 +
 *   资源限额 + 网络禁）。
 * - mcp-signed：签名第三方 server → 同上 + 结果扫描加严 + sampling 默认拒绝。
 * - mcp-unknown：未知来源 → 默认全禁；或仅 dry-run 档（只读协议观察，零权限）。
 *   本批次裁定（2026-10-01）：**默认全禁**，显式启用才可进 dry-run 零权限档
 *   （演进表"安全默认值不转正为放开"）。
 *
 * 三平台机制（M0 修订）：
 * - Linux：复用 sandbox-local 既有 bwrap→landlock 链（最强无 deprecated 风险）；
 *   seccomp-bpf/cgroup 为可选增强、默认不引入。
 * - macOS：复用 seatbelt；mcp-unknown 直接全禁、不降级弱沙箱；OS 移除 seatbelt
 *   则全档位全禁（降级预案）。
 * - Windows：复用 sandbox-windows-acl（WRITE_RESTRICTED + Low integrity + DACL）；
 *   AppContainer 列 mcp-signed 可选上探，默认不启用。
 *
 * SEC 码位结论：本文件为纯配置/模板载体——不授予能力、不开辟信任通道（§5.11.1
 * 第 3 条）。零码位新增，SEC-3xxx 段维持留白。
 */

/** 沙箱目标平台（三平台既有链） */
export type SandboxPlatform = 'linux' | 'macos' | 'windows'

/** 沙箱档位（与 mcp/runtime.ts 的 McpServerRealm 值域一致） */
export type SandboxRealm = 'mcp-trusted' | 'mcp-signed' | 'mcp-unknown'

/** 平台执行机制（模板的落地 runner） */
export type SandboxGateway =
  | 'landlock-bwrap'      // Linux：bwrap→landlock（native 启动器已落地）
  | 'seatbelt'            // macOS：sandbox-exec profile
  | 'windows-acl'         // Windows：restricted token + Low integrity + DACL
  | 'appcontainer-optional' // Windows：mcp-signed 可选上探（默认不启用）
  | 'deny-all'            // mcp-unknown 全禁档（任何平台）
  | 'dry-run'             // mcp-unknown 显式启用的零权限观察档

/** 资源限额（安全默认 + 可调档位模板） */
export interface SandboxResourceLimits {
  maxOutboundBytes: number
  maxMemoryBytes?: number
  maxProcesses?: number
}

/** 单档单平台沙箱配置模板 */
export interface SandboxProfile {
  platform: SandboxPlatform
  realm: SandboxRealm
  gateway: SandboxGateway
  /** 路径绑定：仅读可见（server 无写面） */
  readPaths: readonly string[]
  /** 网络策略：禁网为默认；白名单仅供明确声明的出站通道 */
  network: 'deny' | 'allow-whitelist'
  limits: SandboxResourceLimits
  /** 结果面加严（mcp-signed） */
  resultScanStrict: boolean
  /** sampling 默认拒绝（mcp-signed） */
  samplingDefaultDeny: boolean
  /** 备注（诚实登记平台风险 / 降级预案） */
  note: string
}

/** mcp-unknown 档默认策略（裁定结果落地） */
export type McpUnknownMode = 'deny-all' | 'dry-run'

export const DEFAULT_MCP_UNKNOWN_MODE: McpUnknownMode = 'deny-all'

/* ─────────────── 三平台 × 三档 模板 ─────────────── */

const BASE_LIMITS: SandboxResourceLimits = {
  maxOutboundBytes: 0, // 默认禁外发；mcp-trusted 本地读写不受此限（出站另走 net 白名单）
  maxMemoryBytes: 512 * 1024 * 1024,
  maxProcesses: 8,
}

function standardProfile(
  platform: SandboxPlatform,
  realm: SandboxRealm,
  gateway: SandboxGateway,
  over: Partial<SandboxProfile> = {},
): SandboxProfile {
  return {
    platform,
    realm,
    gateway,
    readPaths: ['/'],
    network: 'deny',
    limits: { ...BASE_LIMITS },
    resultScanStrict: false,
    samplingDefaultDeny: false,
    note: '标准沙箱：路径绑定 + syscall 白名单 + 资源限额 + 网络禁',
    ...over,
  }
}

/** 全平台档位模板：mcp-trusted / mcp-signed / mcp-unknown(dry-run / deny-all) */
export const SANDBOX_PROFILES: readonly SandboxProfile[] = [
  /* ── Linux：bwrap→landlock（三平台最稳，无 deprecated 风险） ── */
  standardProfile('linux', 'mcp-trusted', 'landlock-bwrap'),
  standardProfile('linux', 'mcp-signed', 'landlock-bwrap', {
    resultScanStrict: true,
    samplingDefaultDeny: true,
    note: '标准沙箱 + 结果扫描加严 + sampling 默认拒绝',
  }),
  standardProfile('linux', 'mcp-unknown', 'dry-run', {
    resultScanStrict: true,
    samplingDefaultDeny: true,
    readPaths: [],
    note: 'dry-run 零权限档（只读协议观察；显式启用）',
  }),

  /* ── macOS：seatbelt；mcp-unknown 直接全禁、不降级弱沙箱 ── */
  standardProfile('macos', 'mcp-trusted', 'seatbelt'),
  standardProfile('macos', 'mcp-signed', 'seatbelt', {
    resultScanStrict: true,
    samplingDefaultDeny: true,
    note: 'seatbelt 已标记 deprecated；降级预案：mcp-unknown 全禁，OS 移除则全档位全禁',
  }),
  standardProfile('macos', 'mcp-unknown', 'deny-all', {
    readPaths: [],
    note: 'macOS mcp-unknown 直接全禁、不降级弱沙箱（deprecated 风险预案）',
  }),

  /* ── Windows：ACL restricted token（最弱平台，先补） ── */
  standardProfile('windows', 'mcp-trusted', 'windows-acl'),
  standardProfile('windows', 'mcp-signed', 'windows-acl', {
    resultScanStrict: true,
    samplingDefaultDeny: true,
    note: 'AppContainer 列可选上探（默认不启用，配置成本高）',
  }),
  standardProfile('windows', 'mcp-unknown', 'deny-all', {
    readPaths: [],
    note: 'Windows mcp-unknown 全禁',
  }),
]

/** 按平台 + 档位取模板（缺省回退 deny-all 的安全兜底） */
export function makeSandboxProfile(
  platform: SandboxPlatform,
  realm: SandboxRealm,
  mode: McpUnknownMode = DEFAULT_MCP_UNKNOWN_MODE,
): SandboxProfile {
  // mcp-unknown 默认 deny-all；显式 dry-run 才放 zero-permission 档
  if (realm === 'mcp-unknown' && mode === 'deny-all') {
    return {
      platform,
      realm,
      gateway: 'deny-all',
      readPaths: [],
      network: 'deny',
      limits: { ...BASE_LIMITS, maxOutboundBytes: 0 },
      resultScanStrict: true,
      samplingDefaultDeny: true,
      note: '未知来源默认全禁（安全默认值不转正为放开）',
    }
  }
  const found = SANDBOX_PROFILES.find((p) => p.platform === platform && p.realm === realm)
  if (!found) {
    // 未知组合 → 安全兜底 deny-all（不放行）
    return {
      platform, realm, gateway: 'deny-all', readPaths: [],
      network: 'deny', limits: { ...BASE_LIMITS },
      resultScanStrict: true, samplingDefaultDeny: true,
      note: '未知档位组合：安全兜底全禁',
    }
  }
  return found
}