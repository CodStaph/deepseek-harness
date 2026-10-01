/**
 * 装配控制层 · 契约声明类型
 *
 * 来源：《Cordis装配与运行时安全架构设计方案》v4 §4.1.1
 * 阶段：S1（骨架与契约）——本文件为 M1 装配线与 M2 运行时线的公共类型语言（"类型先行"）
 *
 * 纪律：
 * - 未声明 `contract` 的插件视为"无 provides/needs、plane=host、isolate=false、
 *   capabilities={}（无运行时能力）"，保持现有行为不变（方案 §4.1.1 向后兼容承诺）。
 * - `capabilities: {}`（空对象）= 未声明任何能力——严格模式下运行时副作用将被全部拦截；
 *   迁移期由 `--lenient-capabilities` 降级为 warning（S11 落地）。
 * - 本文件只含类型，不含任何判定逻辑；能力越界判定（capability-overclaim / SEC-1014）
 *   在 S3/S4/S5 落地。
 */

/** 插件契约声明 */
export interface PluginContract {
  /** 本插件提供的服务标识列表 */
  provides: string[]
  /** 硬依赖——缺失即装载失败 */
  needs: string[]
  /** 可选依赖——缺失则降级，不失败 */
  optional: string[]
  /** 归属平面：host | preset | session */
  plane: 'host' | 'preset' | 'session'
  /** 是否开启 isolate 遮蔽域 */
  isolate: boolean
  /** 敏感配置标记——标记后仅高信任层可覆盖 */
  sensitive?: boolean
  /**
   * 运行时能力声明——声明本插件需要发起哪些副作用。
   * 装配控制层校验声明完整性，运行时管控层据此颁发能力令牌。
   * v2 新增字段。
   */
  capabilities?: CapabilityDeclaration
}

/** 运行时能力声明 */
export interface CapabilityDeclaration {
  /** 文件系统访问 */
  fs?: FsCapability
  /** 网络访问 */
  network?: NetworkCapability
  /** 子进程执行 */
  process?: ProcessCapability
  /** 环境变量访问 */
  env?: EnvCapability
  /** 事件监听 */
  events?: EventCapability
  /** MCP 工具调用（v3 新增） */
  mcp?: McpCapability
}

/** MCP 工具调用能力（v3 新增，v4 扩展反向请求） */
export interface McpCapability {
  /** 允许调用的 server 列表（server 名模式） */
  servers?: string[]
  /** 允许调用的工具（server.tool 模式） */
  tools?: string[]
  /** 禁止的参数模式（可选，序列化后子串/正则匹配） */
  denyParamPatterns?: string[]
  /** v4：允许 server 反向请求宿主 LLM（sampling）——模型白名单与 token 上限 */
  sampling?: { models: string[]; maxTokens: number }
  /** v4：允许暴露给 server 的文件系统根（roots 请求）——与 sandbox 策略取交集 */
  roots?: string[]
  /** v4：允许 server 请求用户输入（elicitation）——默认 false，走审批流 */
  elicitation?: boolean
}

export interface FsCapability {
  /** 允许读/写/删除的路径模式列表（glob） */
  read?: string[]
  write?: string[]
  /** 回收站式删除（v3：默认删除语义，低审批门槛） */
  delete?: string[]
  /** 永久删除（v3 新增：必须单独声明，高审批门槛） */
  permanentDelete?: string[]
}

export interface NetworkCapability {
  /** 允许访问的 URL/域名模式列表 */
  allow?: string[]
  /** 禁止访问的 URL/域名模式列表（优先于 allow） */
  deny?: string[]
  /**
   * 出站数据上限（字节，v3 新增）。请求体超过此阈值触发数据外发检查。
   * 缺省 0 表示本插件不允许任何出站数据（只读式网络访问）。
   */
  maxOutboundBytes?: number
}

export interface ProcessCapability {
  /** 允许执行的命令名列表 */
  allow?: string[]
  /** 禁止执行的命令名列表 */
  deny?: string[]
}

export interface EnvCapability {
  /** 允许读取的环境变量名列表 */
  read?: string[]
  /** 允许写入的环境变量名列表 */
  write?: string[]
}

export interface EventCapability {
  /** 允许监听的事件名列表 */
  listen?: string[]
  /** 允许发送的事件名列表 */
  emit?: string[]
}
