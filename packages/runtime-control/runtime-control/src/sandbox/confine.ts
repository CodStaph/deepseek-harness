/**
 * 运行时管控层 · MCP server 沙箱挂载点（ctx.sandbox.confine）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.8.5（M0 精确化：挂载点定在
 *       createTransport——server 的 command/args 经 `ctx.sandbox.confine(argv, policy)`
 *       包裹后交给 StdioClientTransport）。
 * 阶段：批次 4b（M4 S20 沙箱档位）——沙箱是收紧不是放宽；mcp-trusted 默认档与
 *       现有 spawn 行为一致。
 *
 * 通用兜底（全部档位，方案 5.8.5）：
 * - 最小 env：剥离 DEEPSEEK_API_KEY 等全部凭证
 * - 限定 cwd
 * - stdin/stdout 管道之外无 fd（native 装配层保证）
 * 平台 runner 包装（bwrap/seatbelt/ACL）由 gateway 决定；镜像渲染为 argv 前缀，
 * 真实装配并入 dsh 时经 sandbox-local / native 桥实现。
 *
 * SEC 码位结论：纯机制/模板载体，零码位新增（§5.11.1 第 3 条）。SEC-3xxx 段留白。
 */

import type { SandboxProfile, SandboxGateway } from './sandbox-profiles.ts'

/** 需剥离的凭证键集（镜像最小集合；并入 dsh 可配置化） */
const CREDENTIAL_KEYS: readonly string[] = [
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AZURE_OPENAI_KEY',
  'GITHUB_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'HF_TOKEN',
]

/** 最小 env：剥离全部凭证键（其余透传） */
export function minimalEnv(baseEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(baseEnv)) {
    if (!CREDENTIAL_KEYS.includes(k)) out[k] = v
  }
  return out
}

/** 挂载入参：server 的 command/args（createTransport 处捕获） */
export interface ConfineInput {
  command: string
  args: readonly string[]
  cwd: string
  /** 沙箱暴露读根区（路径绑定） */
  workspaceRoot?: string
}

/** confine 结果——交给 StdioClientTransport 的最终 argv/env/cwd */
export interface ConfinedCommand {
  argv: readonly string[]
  env: Record<string, string>
  cwd: string
  /** 是否经沙箱 runner 包裹（false = deny-all 或原样） */
  confined: boolean
  gateway: SandboxGateway
}

/** 按 gateway 渲染 runner argv 前缀（镜像描述性渲染；真实装配并入 dsh） */
function renderGatewayPrefix(gateway: SandboxGateway, profile: SandboxProfile): string[] {
  switch (gateway) {
    case 'landlock-bwrap':
      // bwrap 路径绑定 + 资源限额（描述性；真实规则由 sandbox-local 装配）
      return ['bwrap', '--unshare-net', '--ro-bind', '/', '/', '--bind', profile.readPaths[0] ?? '/', profile.readPaths[0] ?? '/']
    case 'seatbelt':
      return ['sandbox-exec', '-p', '(version 1)(deny default)(allow process-exec)']
    case 'windows-acl':
    case 'appcontainer-optional':
      // Windows ACL 在 native spawn 层装配（P1 类型化绑定），argv 不包装
      return []
    case 'deny-all':
      return [] // 由调用方在 spawn 前拦截（不可 spawn）
    case 'dry-run':
      return [] // 零权限观察档：可 spawn，但经 dry-run 处理器拦截执行
  }
}

/**
 * ctx.sandbox.confine 挂载点：把 MCP server 的 command/args 包裹为沙箱化执行。
 * - 最小 env 剥离凭证（全档位）
 * - 按 gateway 渲染 runner 前缀
 * - 限定 cwd
 */
export function confineCommand(
  input: ConfineInput,
  profile: SandboxProfile,
  baseEnv: Record<string, string>,
): ConfinedCommand {
  const env = minimalEnv(baseEnv)
  const confined = profile.gateway !== 'deny-all'
  const prefix = renderGatewayPrefix(profile.gateway, profile)
  return {
    argv: [...prefix, input.command, ...input.args],
    env,
    cwd: input.cwd,
    confined,
    gateway: profile.gateway,
  }
}