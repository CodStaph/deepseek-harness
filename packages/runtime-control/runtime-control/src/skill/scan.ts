/**
 * 运行时管控层 · skill 面管控：装载期全量静态扫描（scan.ts）
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §5.9.3（装载期全量静态扫描）
 * 阶段：S21（M5 三面收口·skill 面）——skill 是装载期就存在的**静态资产**，
 *       不是运行时动态生成的，因此 L3 缓解可前移（一次性全量扫描）。
 *
 * 三类扫描（方案 §5.9.3）：
 * 1. 越权指令模式扫描（skill-unauthorized-directive）：教 LLM "绕过审批"、
 *    "直接用 child_process"、"忽略 sandbox" 等措辞 → error/warning 级诊断
 *    （R34 装载期越权指令检出）；
 * 2. 敏感内容特征（skill-sensitive-content）：credentials 模式、可疑外发 URL
 *    → 标记（warning）；
 * 3. manifest 与指令一致性（skill-manifest-mismatch）：扫描出的引导动作应落在
 *    manifest 声明内（声明 net:[] 但指令教 LLM fetch → mismatch，error）。
 *
 * 复用 S3 静态校验诊断框架（方案 §4.2.1 / §5.9.3：skill 扫描器与装配期静态
 * 校验复用同一诊断框架）——诊断形状取自 assembly 的 Diagnostic/ValidationResult。
 *
 * SEC 码位论证：skill 装载判定确为新管控面（M5 新增，方案 v4 §5.9），三条扫描
 * 规则构成该面的信任判定；按 §5.11.1 准入与一码一规则，登记 SEC-6xxx 段
 * （见《SEC-码位登记表》§6）。越权指令与 manifest 一致性为装载期门禁
 * （error 级 → 不装载），敏感特征为可配置标记（warning）。
 */

import type { Diagnostic, ValidationResult } from '@deepseek-ai/dsh-assembly'
import type { SkillManifest } from './manifest.ts'

/** skill 面诊断码位（SEC-6xxx，见 SEC 登记表 §6；一码一规则） */
export const SKILL_SCAN_CODES = {
  /** skill-unauthorized-directive：越权指令模式检出（R34） */
  UNAUTHORIZED: 'SEC-6001',
  /** skill-sensitive-content：敏感内容特征标记 */
  SENSITIVE: 'SEC-6002',
  /** skill-manifest-mismatch：指令引导动作超出 manifest 声明（R33 一致性） */
  MANIFEST_MISMATCH: 'SEC-6003',
} as const

/** 结构化诊断构造器（对齐 S3 static.ts 的 diag 形状） */
function diag(
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  skillId: string,
  suggestion?: string,
): Diagnostic {
  const d: Diagnostic = { severity, code, message, nodeId: skillId }
  if (suggestion !== undefined) d.suggestion = suggestion
  return d
}

/** 越权指令模式项 */
export interface UnauthorizedDirectivePattern {
  name: string
  /** 正则——对 skill 指令文本做大小写不敏感匹配 */
  re: RegExp
  /** 命中时的诊断级别（error=装载拒绝 / warning=复核） */
  severity: 'error' | 'warning'
  detail: string
}

/** 越权指令模式库（v1 五条，方案 §5.9.3 示例措辞 + 常见引导规避措辞） */
export const UNAUTHORIZED_DIRECTIVE_PATTERNS: readonly UnauthorizedDirectivePattern[] = [
  {
    name: 'bypass-approval',
    re: /绕过\s*(审批|授权|批准|审核|approval)|skip\s+approval|bypass\s+approval/i,
    severity: 'error',
    detail: '指令教 LLM 绕过审批流程，属装载期高危越权模式',
  },
  {
    name: 'direct-child-process',
    re: /直接\s*(用|调|调用)?\s*(child[\s_-]?process|spawn|exec|fork|node:\s*child)/i,
    severity: 'error',
    detail: '指令教 LLM 直接调用子进程（应走受控 proc.spawn 效果）',
  },
  {
    name: 'ignore-sandbox',
    re: /(忽略|绕过|关闭|不要用)\s*(sandbox|沙箱|沙盒|隔离)/i,
    severity: 'error',
    detail: '指令教 LLM 忽略沙箱约束，属隔离域规避模式',
  },
  {
    name: 'disable-runtime',
    re: /(关闭|禁用|绕过)\s*(效果系统|管控层|runtime[\s_-]?control|安全管控)/i,
    severity: 'error',
    detail: '指令教 LLM 关闭运行时管控，属管控绕过模式',
  },
  {
    name: 'exfil-hint',
    re: /(绕过|规避)\s*(外发|出口|exfil|data[\s_-]?exfil)/i,
    severity: 'warning',
    detail: '指令含外发规避暗示，需人工复核数据外发意图',
  },
]

/** 敏感凭证特征（与 exfiltration 敏感扫描器同构：凭证字段名 + 长令牌/Bearer 特征） */
const SENSITIVE_CREDENTIAL_RE = /(password|passwd|api[\s_-]?key|secret|token|credential|authorization|bearer\s)/i
/** 可疑外发 URL（http(s) 字面量） */
const OUTBOUND_URL_RE = /https?:\/\/[^\s"']+/i
/** 出行动词（引导数据外发） */
const OUTBOUND_VERB_RE = /(curl|fetch|httpx?请求|发送到|上传到|外发|导出到)/i

/** 指令引导的能力域——用于 manifest 一致性比对（出现即视为"引导该能力"） */
const FS_HINT_RE = /(写入|写文件|修改文件|删除文件|创建文件|fs\.|路径|\.txt|\.docx|\.md|\.json)/i
const NET_HINT_RE = /(https?:\/\/|fetch|接口|api|请求|下载|上传|网络)/i
const PROC_HINT_RE = /(child[\s_-]?process|spawn|exec|shell|命令|进程|pandoc|运行程序|执行程序)/i
const ENV_HINT_RE = /(环境变量|process\.env|env\s+)/i

/**
 * 越权指令模式扫描（§5.9.3 第 1 条）——命中任意模式产出诊断（R34）。
 */
export function scanUnauthorizedDirectives(text: string): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const p of UNAUTHORIZED_DIRECTIVE_PATTERNS) {
    if (p.re.test(text)) {
      out.push(diag(p.severity, SKILL_SCAN_CODES.UNAUTHORIZED, p.detail, ''))
    }
  }
  return out
}

/**
 * 敏感内容特征扫描（§5.9.3 第 2 条）——凭证字段名、可疑外发 URL。
 * 命中 → warning（可观测标记，不阻断装载；并入 dsh 时按插件级策略收紧）。
 */
export function scanSensitiveContent(text: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const hasCredential = SENSITIVE_CREDENTIAL_RE.test(text)
  const hasOutbound = OUTBOUND_URL_RE.test(text) && OUTBOUND_VERB_RE.test(text)
  if (hasCredential) {
    out.push(diag('warning', SKILL_SCAN_CODES.SENSITIVE,
      '指令含凭证类敏感特征（password/api-key/secret/token 等），LLM 可能接触敏感信息', ''))
  }
  if (hasOutbound) {
    out.push(diag('warning', SKILL_SCAN_CODES.SENSITIVE,
      '指令含外发 URL 与出行动词，存在数据外发引导风险，需与 manifest net 声明核对', ''))
  }
  return out
}

/** 判断能力面声明是否为空（{} 或 {allow:[]} 等空引导集） */
function isEmptyCapability(cap: unknown): boolean {
  if (typeof cap !== 'object' || cap === null) return true
  const keys = Object.keys(cap)
  if (keys.length === 0) return true
  // { allow: [] } / { read: [] } 等空白名单视同空引导面
  return keys.every((k) => Array.isArray((cap as Record<string, unknown>)[k]) && ((cap as Record<string, unknown>)[k] as unknown[]).length === 0)
}

/**
 * manifest 与指令一致性（§5.9.3 第 3 条）——扫描指令引导的能力域，
 * 与 manifest.capabilities 声明比对；未声明该域或声明为空而指令引导 → mismatch。
 */
export function scanManifestConsistency(text: string, manifest: SkillManifest): Diagnostic[] {
  const out: Diagnostic[] = []
  const caps = manifest.capabilities ?? {}
  const hints: Array<[string, boolean, unknown]> = [
    ['fs', FS_HINT_RE.test(text), caps.fs],
    ['network', NET_HINT_RE.test(text), caps.network],
    ['process', PROC_HINT_RE.test(text), caps.process],
    ['env', ENV_HINT_RE.test(text), caps.env],
  ]
  for (const [face, hinted, declared] of hints) {
    if (!hinted) continue
    if (declared === undefined || isEmptyCapability(declared)) {
      out.push(diag('error', SKILL_SCAN_CODES.MANIFEST_MISMATCH,
        `指令引导 ${face} 能力，但 manifest 未声明该域或声明为空（指令超出声明面）`,
        manifest.id, `在 manifest.capabilities.${face} 声明该能力，或移除指令引导`))
    }
  }
  return out
}

/** skill 静态扫描输入 */
export interface SkillScanInput {
  /** SKILL.md 指令文本（纯 Markdown body；M0 修正：无脚本通道，扫描对象为指令文本模式） */
  text: string
  /** 已解析 SkillManifest（可选；缺省按 unknown 空能力面判定） */
  manifest?: SkillManifest
}

/**
 * 装载期全量静态扫描（§5.9.3 统一入口）——三类扫描合并，复用 S3 诊断框架。
 */
export function scanSkill(input: SkillScanInput): ValidationResult {
  const manifest = input.manifest ?? { id: '', trust: 'unknown' as const, capabilities: {} }
  const diagnostics: Diagnostic[] = [
    ...scanUnauthorizedDirectives(input.text),
    ...scanSensitiveContent(input.text),
    ...scanManifestConsistency(input.text, manifest),
  ]
  return { diagnostics }
}

/**
 * skill 装载决策（R35）——未知来源默认不装载；越权 error 级诊断也拒绝装载。
 */
export function decideSkillLoading(
  input: SkillScanInput,
): { load: boolean; reason: string } {
  const manifest = input.manifest ?? { id: '', trust: 'unknown' as const, capabilities: {} }
  const result = scanSkill(input)
  const errors = result.diagnostics.filter((d) => d.severity === 'error')
  if (manifest.trust === 'unknown') {
    return { load: false, reason: 'skill 来源 unknown，默认不装载（R35）' }
  }
  if (errors.length > 0) {
    return { load: false, reason: `装载期扫描检出 ${errors.length} 条 error（越权/不一致），拒绝装载` }
  }
  return { load: true, reason: '来源可信 + 装载期扫描无 error' }
}