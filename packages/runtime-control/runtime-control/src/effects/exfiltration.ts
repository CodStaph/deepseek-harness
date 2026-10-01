/**
 * 运行时管控层 · 机制 3：数据外发检查（Exfiltration Check）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.3.8（第 1587–1615 行）
 * 阶段：S17（批次 3b，M3 智能体运行语义）——把"数据外发需授权"从包内纪律上升为
 *       管控层强制（方案 §5.3.8）：给 net 类与 mcp.call 出站效果加方向语义，
 *       检查结果写入 `EffectAuditEntry.exfiltrationCheck`。
 *
 * 语义要点（方案原文）：
 * - `estimateOutboundBytes`：把待发载荷折算为字节数——纯读式访问（无出站体）返回 0。
 * - `checkExfiltration` 三态：'pass'（体量合规且无敏感内容）/ 'blocked'（超上限或
 *   含敏感特征）/ 'not-applicable'（无出站体，纯读式访问）。
 * - 上限语义：`ceiling === undefined || 0` = 未声明出站能力 → 只允许读式网络访问，
 *   任何出站体量一律 'blocked'。
 * - 敏感扫描器是注入式策略：默认扫描凭证字段与长会话令牌特征；调用方（net / mcp
 *   处理器）可追加自有扫描器（如插件专项的 session 内容特征）。
 * - 对照 TeleAgent"本地处理、数据不上传"数据主权原则与 dsh 遥测 FEEDBACK_ONLY 自觉
 *   模式：把"数据外发需授权"从包内纪律上升为管控层强制。
 *
 * SEC 码位结论：本文件为纯判定/观测载体——不授予能力、不开辟信任通道，仅对既有
 * 出站载荷做合规判定并记账。不新增 SEC 码位，SEC-3xxx 段维持留白（§5.11.1 信任语义
 * 准入：纯工程机制以数据字段承载可定位性，exfiltrationCheck 三态即封闭枚举）。
 */

/**
 * 出站载荷估算——把待发 body 折算为字节数。
 * string / Uint8Array 按实际字节；对象经 JSON 序列化后计量（避免 String(obj) 坍缩为
 * "[object Object]"）；null/undefined 视为无出站体。
 */
export function estimateOutboundBytes(body: unknown): number {
  if (typeof body === 'string') return Buffer.byteLength(body)
  if (body instanceof Uint8Array) return body.byteLength
  if (body == null) return 0
  if (typeof body === 'object') {
    try {
      return Buffer.byteLength(JSON.stringify(body))
    } catch {
      return Buffer.byteLength(String(body))
    }
  }
  return Buffer.byteLength(String(body))
}

/**
 * 敏感数据扫描器——对出站载荷做"是否含敏感特征"的布尔判定。
 * 注入式：默认提供字段名扫描与会话令牌特征扫描两类；调用方可按数据主权策略追加。
 */
export type SensitiveScanner = (data: unknown) => boolean

/** 深度遍历对象/数组，返回全部叶子值（便于字段名与值扫描） */
function leafEntries(data: unknown, path: string[] = []): Array<{ path: string[]; value: unknown }> {
  const out: Array<{ path: string[]; value: unknown }> = []
  if (Array.isArray(data)) {
    data.forEach((v, i) => out.push(...leafEntries(v, [...path, String(i)])))
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (v && typeof v === 'object') out.push(...leafEntries(v, [...path, k]))
      else out.push({ path: [...path, k], value: v })
    }
  } else {
    out.push({ path, value: data })
  }
  return out
}

/** 敏感字段名集合（凭证/会话标识特征）——命中任一非空值即判敏感 */
const SENSITIVE_FIELD_NAMES: readonly string[] = [
  'credential', 'credentials', 'authorization', 'apiKey', 'api_key', 'accessKey',
  'token', 'accessToken', 'access_token', 'refreshToken', 'sessionToken',
  'secret', 'clientSecret', 'password', 'passwd', 'privateKey', 'private_key',
  'sessionId', 'session_id', 'cookie', 'csrf',
]

/** 字段名扫描器——出站载荷含敏感字段名且值非空即判敏感 */
export function credentialFieldScanner(data: unknown): boolean {
  for (const entry of leafEntries(data)) {
    const field = entry.path[entry.path.length - 1] ?? ''
    if (entry.value != null && entry.value !== '' && SENSITIVE_FIELD_NAMES.includes(field)) {
      return true
    }
  }
  return false
}

/**
 * 会话令牌特征扫描器——出站字符串中出现典型会话/令牌形态即判敏感：
 * - `Bearer ` 前缀；
 * - 长 token（≥ 32 位字母数字/下划线连缀，base64/hex/jwt 形态）。
 */
export function sessionTokenScanner(data: unknown): boolean {
  const text = serializeLeafValues(data)
  if (/(?:Bearer|Basic)\s+\S+/i.test(text)) return true
  if (/[A-Za-z0-9_\-.]{32,}/.test(text)) return true
  return false
}

/** 收集载荷全部叶子值并拼接成文本（供正则扫描） */
function serializeLeafValues(data: unknown): string {
  const parts: string[] = []
  for (const entry of leafEntries(data)) {
    if (typeof entry.value === 'string' || typeof entry.value === 'number') {
      parts.push(String(entry.value))
    }
  }
  return parts.join(' ')
}

/** 默认敏感扫描器集——net/mcp 出站检查的统一初始策略（调用方可追加） */
export const DEFAULT_SENSITIVE_SCANNERS: readonly SensitiveScanner[] = [
  credentialFieldScanner,
  sessionTokenScanner,
]

/**
 * 数据外发检查（方案 §5.3.8）——出站载荷的方向语义判定。
 * @param data     出站载荷（net 的 body / mcp 的参数 args）
 * @param ceiling  出站数据上限（NetworkCapability.maxOutboundBytes 或 mcp 策略上限）；
 *                 undefined/0 = 未声明出站能力 → 只允许读式访问
 * @param scanners 敏感扫描器集（缺省用 DEFAULT_SENSITIVE_SCANNERS）
 * @returns 'pass'（合规）/ 'blocked'（超限或含敏感）/ 'not-applicable'（无出站体）
 */
export function checkExfiltration(
  data: unknown,
  ceiling: number | undefined,
  scanners: readonly SensitiveScanner[] = DEFAULT_SENSITIVE_SCANNERS,
): 'pass' | 'blocked' | 'not-applicable' {
  const outbound = estimateOutboundBytes(data)
  if (outbound === 0) return 'not-applicable' // 纯读式访问
  if (ceiling === undefined || ceiling === 0) return 'blocked' // 未声明出站能力
  if (outbound > ceiling) return 'blocked' // 超出声明上限
  for (const scan of scanners) {
    if (scan(data)) return 'blocked' // 敏感内容
  }
  return 'pass'
}