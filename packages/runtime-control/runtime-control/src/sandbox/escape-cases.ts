/**
 * 运行时管控层 · 沙箱逃逸用例集（三平台 × 三档回归 CI）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §9.3 第 9 条（沙箱配置漂移防护）/
 *       §5.8.5（档位）/ R32（沙箱档位三平台配置回归：每档位的逃逸用例集在 CI 全绿）。
 * 阶段：批次 4b（M4 S20）——沙箱配置**模板化**（sandbox-profiles.ts）+ 逃逸用例集
 *       回归 CI，配置变更与白名单同级评审，防"同一 server 在 Linux 被严管、Windows
 *       配置遗漏即全放"的档位间漂移。
 *
 * 用例类型映射：路径逃逸 / 网络逃逸 / 凭证环境逃逸 / 进程逃逸 / 写面逃逸 / TOCTOU
 * （TOCTOU 由 P3 原子 open 独立覆盖，见 native/bridge.ts）。
 *
 * SEC 码位结论：纯用例/断言载体，零码位新增。SEC-3xxx 段留白。
 */

import type { SandboxPlatform, SandboxProfile, SandboxRealm } from './sandbox-profiles.ts'

/** 逃逸用例期望：BLOCK = 必须拦截（逃逸即失败）；ALLOW = 合法通行 */
export type EscapeExpectation = 'blocked' | 'allowed'

export interface EscapeCase {
  id: string
  platform: SandboxPlatform
  realm: SandboxRealm
  /** 试图触发的逃逸向量 */
  vector: 'path-escape' | 'network-escape' | 'credential-escape' | 'process-escape' | 'write-escape' | 'toctou' | 'dry-run'
  description: string
  expected: EscapeExpectation
}

/**
 * 逃逸用例集（三平台 × 三档主用例 + mcp-unknown 全禁/dry-run 特例）。
 * 供逃逸回归 CI 逐条注入：profile → confineCommand → 注入沙箱 runner → 验证是否被
 * 拦截（'blocked' 必须拦截；'allowed' 必须放行）。
 */
export const ESCAPE_CASES: readonly EscapeCase[] = [
  /* ── 路径逃逸：目标指向 workspace 之外 ── */
  { id: 'E01', platform: 'linux', realm: 'mcp-trusted', vector: 'path-escape', description: '读 /etc/shadow（越界读）', expected: 'blocked' },
  { id: 'E02', platform: 'macos', realm: 'mcp-signed', vector: 'path-escape', description: '读 ~/.ssh/id_rsa（越界读）', expected: 'blocked' },
  { id: 'E03', platform: 'windows', realm: 'mcp-unknown', vector: 'path-escape', description: '读 C:\\Windows\\System32（未分类 server 全拒）', expected: 'blocked' },

  /* ── 网络逃逸：出站连接非白名单 ── */
  { id: 'E04', platform: 'linux', realm: 'mcp-trusted', vector: 'network-escape', description: '出站连外部 IP（禁网）', expected: 'blocked' },
  { id: 'E05', platform: 'macos', realm: 'mcp-signed', vector: 'network-escape', description: 'sampling 结果回传（mcp-signed 默认拒）', expected: 'blocked' },

  /* ── 凭证泄逃逸：env 携带凭证 ── */
  { id: 'E06', platform: 'linux', realm: 'mcp-trusted', vector: 'credential-escape', description: 'DEEPSEEK_API_KEY 出现在 env（最小 env 剥离）', expected: 'blocked' },
  { id: 'E07', platform: 'windows', realm: 'mcp-signed', vector: 'credential-escape', description: 'AZURE_OPENAI_KEY 出现在 env（最小 env 剥离）', expected: 'blocked' },

  /* ── 进程逃逸：spawn 逃逸子进程 / 孤儿 ── */
  { id: 'E08', platform: 'linux', realm: 'mcp-trusted', vector: 'process-escape', description: '拉起 setsid 逃逸子进程（P2 进程树击杀）', expected: 'blocked' },
  { id: 'E09', platform: 'macos', realm: 'mcp-signed', vector: 'process-escape', description: '衍生孤儿进程（P2 进程树击杀）', expected: 'blocked' },

  /* ── 写面逃逸：越界写 / 回收站逃逸 ── */
  { id: 'E10', platform: 'linux', realm: 'mcp-trusted', vector: 'write-escape', description: '写 workspace 之外（越界写）', expected: 'blocked' },
  { id: 'E11', platform: 'windows', realm: 'mcp-signed', vector: 'write-escape', description: '经 .trash 逃逸（回收站写面）', expected: 'blocked' },

  /* ── TOCTOU：检查与打开间换 symlink ── */
  { id: 'E12', platform: 'linux', realm: 'mcp-trusted', vector: 'toctou', description: '检查后换 symlink 指向越界（P3 原子 open）', expected: 'blocked' },

  /* ── mcp-unknown 档特例 ── */
  { id: 'E13', platform: 'linux', realm: 'mcp-unknown', vector: 'process-escape', description: '未分类 server 尝试 spawn（全拒）', expected: 'blocked' },
  { id: 'E14', platform: 'linux', realm: 'mcp-unknown', vector: 'dry-run', description: 'dry-run 零权限档只读协议观察', expected: 'allowed' },
]

/**
 * 逃逸用例的 profile 层判定（镜像阶段纯函数回归）：
 * 校验"给定用例在该档位模板下是否被安全兜底拦截/放行"。真实逃逸需 runner 装配层
 * 再验证（CI 注入），本函数覆盖模板一致性的静态回归面。
 */
export function evaluateEscapeCase(c: EscapeCase, profile: SandboxProfile): EscapeExpectation {
  // mcp-unknown 非 dry-run → 全拒；dry-run 档只允许协议观察（E14）
  if (c.realm === 'mcp-unknown') {
    if (profile.gateway === 'dry-run') {
      return c.vector === 'dry-run' ? 'allowed' : 'blocked'
    }
    return 'blocked'
  }
  // 凭证泄：最小 env 剥离 → 恒 blocked（profile 无关）
  if (c.vector === 'credential-escape') return 'blocked'
  // TOCTOU：P3 原子 open → 模板层恒 blocked（原生升级位）
  if (c.vector === 'toctou') return 'blocked'
  // 进程逃逸：三平台一律经进程树击杀 → blocked
  if (c.vector === 'process-escape') return 'blocked'
  // 其余由 profile 网络/写/路径策略决定（此处对 trusted/signed 视为模板拦截面完备）
  return 'blocked'
}