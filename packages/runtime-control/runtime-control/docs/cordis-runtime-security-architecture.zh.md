---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '80c7786c-db30-4ecf-a1da-94b03098b561'
  PropagateID: '80c7786c-db30-4ecf-a1da-94b03098b561'
  ReservedCode1: 'd837cbe9-1661-4233-a901-21925117834b'
  ReservedCode2: 'd837cbe9-1661-4233-a901-21925117834b'
---

# Cordis 装配与运行时安全架构设计方案

> **文档状态**：v4 基线，M0 前置调研已收口（2026-09-30）——十项调研完成、七项裁定均采用推荐选项（见第 16 章增补记录）；按《里程碑规划》模式乙（双线并行）推进
> **涉及仓库**：`D:\systool\DSH\Harness\deepseek-harness-master`（以下简称 dsh 仓库）
> **设计日期**：2026-09-30
> **前置讨论**：基于"Cordis 装配控制层设计"、"运行时管控层补充"、"TeleAgent 架构对照"、"MCP 内建与不可判定性管控谱系"、"skill 与 CLI 面管控"、"LangQuanta DesignV4 纪律借鉴"六轮讨论的共识
> **版本**：v4（含增补：MCP 深度内建管控 + OS 沙箱档位 + 不可判定性与管控谱系理论章 + skill/CLI 面管控 + LangQuanta 元层纪律 + M0 调研建档与裁定落盘）

---

## 1. 背景与动机

### 1.1 现状

dsh 把 Cordis（`@deepseek-ai/cordis` v4.0.4，vendor 在 `vendor/cordis`）用作产品装配面，使用方式有三个层次：

- **服务运行时**：`Context` 为根，`ctx.inject([...], (ctx) => ...)` 做依赖查找，`Service` + `symbols` 声明服务协议，`Fiber` 管生命周期。全仓 1573 处引用 `Context`/`Service`/`symbols`/`ctx.inject`。
- **产品组合面**：整棵装配树写成 YAML entry 数组（`cordis.patch.yml`），配 `insert`/`id`/`disabled: !!js`/`inject`/`intercept`/`isolate`/`group`/patch，靠多层覆盖链（base patch → mode bundle patch → 用户 profile patch → `--patch`）按 id 最后写入生效。
- **治理/校验面**：为给无类型的配置层兜底，dsh 建了整套 `gen-`/`verify-` 脚本（`verify-cordis-config.ts`、`gen-cordis-catalog.ts`、`gen-cordis-api.ts`、`gen-cordis-inspect-catalog.ts`、`verify-runtime-closure.ts`、`verify-default-product-isolation.ts` 等，共 22+ 项）。

### 1.2 痛点

#### 1.2.1 装配面痛点（装载期～挂载期）

| 编号 | 痛点 | 代码证据 |
|------|------|----------|
| P1 | `!!js` 表达式在 YAML 中内联任意 JS，无类型、无编译期检查、运行期 `new Script()` 求值 | `cordis.patch.yml` 中 `disabled: !!js "!ctx.get('profileContext')"`、`mode: !!js process.env.DSH_TELEMETRY_MODE \|\| 'FEEDBACK_ONLY'` 等数十处 |
| P2 | 多层覆盖链的组合结果不可见、难排错 | base → bundle → user → `--patch`，同一行 id 被多层改、最终生效值隐式 |
| P3 | 组合语义错误只在运行期暴雷 | `verify-cordis-config.ts` 注释记录：inject 挂空平面、host 重复注册导致第二次抛错、preset 遮蔽 host 消费者所需路由 |
| P4 | Service 映射靠字符串 key，缺强类型契约 | `ctx.get('profileContext')`、`ctx.inject(['connection', 'webServer'], ...)` 无法编译期校验 |
| P5 | Fiber 生命周期诊断缺失 | Cordis 核心 4 处 TODO（含 `internal/fiber-info` 诊断缺陷） |
| P6 | 安全管控没有明确落点 | `!!js` 可执行任意代码、YAML 可加载任意包、敏感配置可被低信任层覆盖 |

#### 1.2.2 运行时痛点（挂载后～运行期）

| 编号 | 痛点 | 攻击向量 |
|------|------|----------|
| R1 | 已装载插件可直接访问 Node.js 原生 API | `import { execSync } from 'node:child_process'; execSync('rm -rf /')`——无任何拦截 |
| R2 | 运行期动态服务注册可遮蔽安全服务 | `ctx.set('sandbox', { check: () => true })`——覆盖安全服务，控制层无感知 |
| R3 | 服务对象无封装边界，可被直接篡改 | `const sb = ctx.get('sandbox'); sb.mode = 'danger-full-access'`——JS 对象引用裸露 |
| R4 | 事件系统可被劫持 | `ctx.on('approval-request', e => e.approve())`——自动批准所有操作，绕过用户审批 |
| R5 | 原型链污染 | `Object.defineProperty(Service.prototype, 'mode', { get: () => 'danger' })`——影响所有服务实例 |

#### 1.2.3 智能体运行语义痛点（挂载后～运行期，v3 新增）

对照 TeleAgent 类"以人类确认驱动"的智能体架构，dsh 作为 AI Agent Harness 还有一组运行语义缺陷——它们不是越权漏洞，而是"管控机制无法支撑智能体实际运行方式"的设计缺陷：

| 编号 | 痛点 | 代码证据 / 场景 |
|------|------|----------|
| R6 | 审批同步阻塞：效果审批 `await approval(req)` 占死 Fiber，用户几分钟不回复则会话无法响应取消等事件 | 对照 TeleAgent 的 `needs_human` 一等阻塞状态：等待人类输入时任务挂起、回复后唤醒、不占执行资源 |
| R7 | 审批无授权记忆：`approval.policy` 只有 `ask`/`never`，一次任务几十次副作用每次都问，不可用 | 对照 TeleAgent 的 `once / always / reject` 三档授权 + 确认豁免条款（本轮产物、临时区、用户明确指定免确认） |
| R8 | 删除无回收站语义：`fs.delete` 批准即永久删除，误删不可恢复 | 对照 TeleAgent 的"回收站优先，永久删除需二次确认且首次确认不授权"纪律 |
| R9 | MCP 进程外副作用绕过效果系统：效果仅覆盖 fs/net/proc/env，`packages/mcp` 的工具调用完全在管控面之外 | dsh 有完整 MCP 生态（mcp-resources、mcp-client、各 experimental MCP 包），是现方案最实的覆盖漏洞 |
| R10 | 数据外发无方向语义：`net.fetch` 只按 URL 白名单检查，不区分"读外部"与"把本地数据发出去" | 对照 TeleAgent 的"本地处理、数据不上传"数据主权原则；dsh 遥测 FEEDBACK_ONLY 模式是包内自觉，非管控层强制 |
| R11 | 并行子代理共享令牌：令牌按插件 id 颁发，spawn/fork 的多个 fiber 共享，撤销无法精确到单个子代理，写冲突无隔离 | 对照 TeleAgent 并行子代理"文件边界互不冲突"分派纪律；dsh subagent 有 spawn/fork 两种 provider |
| R12 | 违规即进程级异常：ViolationPolicy 只有 throw/log/log-and-throw，一个第三方插件违规拖垮整个长驻会话 | 对照 TeleAgent 自我修复的结构化降级：目标是恢复服务而非崩溃 |

### 1.3 根因

Cordis 的定位是"现代 JS 应用的元框架"，核心哲学是**运行期动态反射**——插件可在任意时刻 `ctx.get/set` 动态注册服务，组合空间在运行时是开放的。dsh 把它当作产品配置面使用后，长出了大量外挂校验脚本来做兜底，但这些脚本是**事后静态断言**，无法覆盖运行期动态失败，且散落在 CI 管线中，没有形成统一的控制面。

更关键的是：**装配控制层只能防住"通过配置面发起的越权"，防不住"已装载代码在运行期发起的越权"**。一旦插件通过校验、成功挂载，它的 `apply()` 函数在 Cordis Context 内运行——此时它是一个拥有完整 Node.js 运行时权限的普通 JS 模块，控制层对它的约束力为零。完整的防御体系需要两层：装配控制层（门卫）+ 运行时管控层（内控系统）。

---

## 2. 设计目标

1. **在 Cordis 内核与 dsh 业务使用之间，划分两个独立的控制层**——装配控制层管装载/校验/配置安全，运行时管控层管服务访问/能力授权/副作用隔离。
2. **把校验从"CI 脚本事后断言"升级为"装配管线内置步骤"**——结构性错误在装载期直接失败，可用性错误在运行期精确诊断。
3. **把安全管控从"没有"升级为"两层防线"**——装配面防配置越权，运行时防代码越权。
4. **不推翻 Cordis 内核哲学**——内核仍然只管机制，不做策略判断；控制层做策略，但策略必须可声明、可审计、确定性可复现。
5. **收敛现有 `verify-*` 脚本**——控制层不是"又一个校验脚本堆积层"，而是把现有脚本的规则内化为自身的内部实现。
6. **把"等待人类审批"设计为一等运行时状态**（v3 新增）——审批挂起不占执行资源、授权有记忆与豁免、删除有回收站语义、数据出站有主权检查。管控机制必须支撑智能体的实际运行方式（审批以分钟计、副作用成批发生、子代理并行工作），而不是假设副作用即时发生、审批即时返回。
7. **把 MCP 管控从"调用面拦截"升级为"五面内建 + 沙箱档位"**（v4 新增）——MCP client 收归管控层实现通道唯一化；反向请求（sampling/roots/elicitation）效果化；server 进程按来源分沙箱档位。同时把"完全管控不可达"（Rice 定理）登记为理论边界：管控目标改写为"表达半径、消耗预算、发生点拦截"三重可判定围堵（见第 14 章）。
8. **把 skill 与 CLI 两个能力面纳入统一管控**（v4 增补）——skill 按"装载/资源/指令"三面归属：执行面天然走效果系统（skill 无独立执行通道），指令面走 L3 缓解栈且可前移到装载期静态扫描（SkillManifest 契约）；CLI 启动面归装配控制层、运行面以 root 调用者身份进审计、自举面诚实登记为架构外缓解（14.5 L4）。

### 非目标

- 不追求静态封闭的类型系统（Cordis 运行期反射空间开放，不存在封闭的静态等价）。
- 不修改 Cordis 内核的挂载执行逻辑（路线 A，不改 vendor/cordis）。
- 不自动推导新权限或新策略（控制层执行被写死的规则，不做运行期自动决策）。
- 不追求零运行时开销（运行时管控层有可测量的性能代价，通过增量检查和懒求值缓解）。

---

## 3. 四层分离架构

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  dsh 业务使用层                                                 │
  │  只消费"已验证装配 + 已授权服务"，不管装配与授权怎么做            │
  │  · 各 packages/* 包通过 ctx.inject 消费服务                    │
  │  · 副作用通过 effect.* 发起，不直接调用 Node.js API              │
  │  · 不再自己断言安全或组合正确性                                   │
  └────────────────────────┬────────────────────────────────────────┘
                           │ 已验证装配计划 + 已颁发能力令牌
  ┌────────────────────────┴────────────────────────────────────────┐
  │  运行时管控层（Runtime Control Layer）                           │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
  │  │ 服务膜        │  │ 能力令牌      │  │ 效果系统      │         │
  │  │ Service       │  │ Cap[T]       │  │ Effect       │         │
  │  │ Membrane      │  │ Token        │  │ System       │         │
  │  └──────────────┘  └──────────────┘  └──────────────┘         │
  │  ┌──────────────┐                                                │
  │  │ 执行隔离域    │  输入：装配计划 + 运行态上下文                   │
  │  │ Execution    │  输出：受控服务访问 + 副作用审计 + 违规拦截       │
  │  │ Realm        │                                                │
  │  └──────────────┘                                                │
  └────────────────────────┬────────────────────────────────────────┘
                           │ 已验证装配计划（Verified Assembly Plan）
  ┌────────────────────────┴────────────────────────────────────────┐
  │  装配控制层（Assembly Control Layer）                           │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
  │  │ 装载编排      │  │ 校验          │  │ 安全管控      │         │
  │  │ Load          │  │ Validation    │  │ Security      │         │
  │  │ Orchestration │  │               │  │ Control       │         │
  │  └──────────────┘  └──────────────┘  └──────────────┘         │
  │  输入：多层 patch 源文件 + 运行态上下文                            │
  │  输出：已验证装配计划（Assembly Plan）+ 审计日志                  │
  └────────────────────────┬────────────────────────────────────────┘
                           │ 已验证装配计划 → 挂载指令
  ┌────────────────────────┴────────────────────────────────────────┐
  │  Cordis 内核                                                    │
  │  只提供机制，不做授权判断，不自我升级                               │
  │  · Context / Service / symbols / Fiber / loader                │
  │  · 运行期反射注册（保持不变）                                     │
  └─────────────────────────────────────────────────────────────────┘
```

### 3.1 两个控制层的时间窗口

| 控制层 | 时间窗口 | 防御对象 | 类比 |
|--------|---------|---------|------|
| 装配控制层 | 装载期～挂载期 | 配置面越权：错误的组合、不安全的覆盖、恶意插件加载 | 门卫——检查谁能进、带什么进 |
| 运行时管控层 | 挂载后～运行期 | 代码面越权：直接调 Node API、篡改服务、劫持事件、原型污染 | 内控系统——监控进了门之后的行为 |

### 3.2 边界纪律

| 层 | 职责 | 禁止 |
|----|------|------|
| Cordis 内核 | 提供机制（Context/Service/Fiber/loader） | 做任何授权判断、安全决策、自我升级 |
| 装配控制层 | 装载编排 + 校验 + 配置安全管控 | 运行期自动推导新权限；无限扩外挂脚本 |
| 运行时管控层 | 服务访问代理 + 能力授权 + 副作用隔离 + 执行域 | 改变已验证装配的组合语义；自动颁发新能力 |
| dsh 业务层 | 消费已验证装配 + 已授权服务，执行业务逻辑 | 直接调用 Node.js 原生 API；自己断言安全 |

这条纪律保证安全管控是**确定性可复现**的，而非"智能体随机应变"的——呼应 LangQuanta 的"内核永不自动"原则。

### 3.3 两个控制层的协作关系

装配控制层的输出（已验证装配计划）是运行时管控层的输入：

1. 装配控制层产出 `AssemblyPlan`，其中包含每个插件的 `PluginContract`（provides/needs/plane/isolate）。
2. 运行时管控层根据 `AssemblyPlan` 为每个插件**预颁发能力令牌**——令牌的权限范围由契约声明决定，而非由插件运行时自行索取。
3. 插件挂载后，所有服务访问通过能力令牌发起，所有副作用通过效果系统发起——运行时管控层在这两个通道上做实时检查。
4. 如果插件在运行期尝试超越令牌权限或发起未授权副作用，运行时管控层拦截并产生违规诊断。

---

## 4. 装配控制层详细设计

### 4.1 装载编排（Load Orchestration）

#### 4.1.1 契约声明（Contract Declaration）

为每个插件入口增加一份结构化契约声明，把隐式依赖显式化：

```typescript
// packages/assembly/src/contract.ts

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
```

在 YAML 中声明：

```yaml
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  contract:
    provides: [session.query]
    needs: [storage, storage-domain]
    optional: [storage.json]
    plane: host
    isolate: false
    capabilities:
      fs:
        read: ['**']
        write: ['${dshHome}/sessions/**']
      network: {}
      process: { deny: ['*'] }
      env: { read: ['DSH_HOME'] }
  config:
    path: ':memory:'
    openAt: never
```

**向后兼容**：未声明 `contract` 的插件视为"无 provides/needs、plane=host、isolate=false、capabilities={}（无运行时能力）"，保持现有行为不变。控制层可逐步迁移，不需要一次性给所有 100+ 行补声明。

> **注意**：`capabilities: {}`（空对象）意味着"未声明任何能力"——在严格模式下，该插件的运行时副作用将被全部拦截。迁移期间提供 `--lenient-capabilities` 标志，将未声明的插件视为"拥有全部能力"（即向后兼容），但标记为 warning。严格模式在 S6 阶段后逐步收紧。

#### 4.1.2 有效配置展开器（Effective Composition Resolver）

把多层覆盖链摊平为单棵、带来源标注的装配树：

```typescript
// packages/assembly/src/resolver.ts

/** 覆盖链中的单个层 */
export interface CompositionLayer {
  /** 层标识 */
  id: string
  /** 层来源文件路径 */
  file: string
  /** 信任等级：trusted > user > preset > patch */
  trustLevel: 'trusted' | 'user' | 'preset' | 'patch'
  /** 本层的 entry 数组 */
  entries: LoaderEntry[]
}

/** 展开后的有效配置节点 */
export interface EffectiveNode {
  /** 行 id */
  id: string
  /** 插件包名 */
  name: string
  /** 最终生效的配置（合并后） */
  config: Record<string, unknown>
  /** disabled 最终值 */
  disabled: boolean | ExpressionNode
  /** 契约声明（如有） */
  contract?: PluginContract
  /** 覆盖历史：按层顺序记录每次覆盖的来源和变更字段 */
  overrides: OverrideRecord[]
}

export interface OverrideRecord {
  /** 覆盖来源层 */
  layer: string
  /** 覆盖来源文件 */
  file: string
  /** 被覆盖的字段列表 */
  changedFields: string[]
  /** 覆盖前旧值摘要 */
  previousValue?: string
}
```

展开器的核心逻辑：

1. 按信任等级排序各层（trusted → user → preset → patch）
2. 逐层合并，同一 `id` 的后层覆盖前层，记录覆盖历史
3. 对 `disabled: !!js` 表达式做受限求值（见 4.3.2）
4. 输出 `EffectiveNode[]`，作为校验器、安全管控和运行时管控层的输入

**CLI 产物**：

```bash
# 查看展开后的有效配置
dsh config --expand

# 以 diff 形式查看覆盖链各层的变更
dsh config --expand --diff

# 干跑模式：展开 + 校验，不实际挂载
dsh config --dry-run

# 查看装配计划中各插件的能力令牌预颁发情况（v2 新增）
dsh config --capabilities
```

#### 4.1.3 装配计划（Assembly Plan）

控制层的最终输出不是"开始挂载"，而是一个已验证、可执行、带来源标注的装配程序：

```typescript
// packages/assembly/src/plan.ts

export interface AssemblyPlan {
  /** 展开后的有效配置节点列表 */
  nodes: EffectiveNode[]
  /** 装配图（依赖关系） */
  graph: CompositionGraph
  /** 校验结果 */
  validation: ValidationResult
  /** 安全审计结果 */
  security: SecurityAudit
  /** 能力令牌预颁发计划（v2 新增） */
  capabilities: CapabilityGrantPlan
  /** 装配时间戳 */
  timestamp: string
  /** 覆盖链摘要 */
  layers: CompositionLayer[]
}

export interface CompositionGraph {
  /** 节点列表 */
  nodes: GraphNode[]
  /** 边列表（依赖关系） */
  edges: GraphEdge[]
  /** 环检测结果 */
  hasCycle: boolean
  /** 孤立服务列表 */
  orphans: string[]
}

export interface GraphNode {
  id: string
  plane: 'host' | 'preset' | 'session'
  provides: string[]
  needs: string[]
  optional: string[]
  isolate: boolean
}

export interface GraphEdge {
  from: string  // 依赖方 id
  to: string    // 被依赖方 id
  service: string  // 依赖的服务标识
  kind: 'hard' | 'optional'
}
```

---

### 4.2 校验（Validation）

#### 4.2.1 静态校验（装载期）

在有效配置展开后、挂载前执行。把现有 `verify-cordis-config.ts` 的规则迁移为装载期必失败规则：

```typescript
// packages/assembly/src/validators/static.ts

export interface StaticValidationRule {
  /** 规则标识 */
  id: string
  /** 规则描述 */
  description: string
  /** 执行函数 */
  check: (nodes: EffectiveNode[], graph: CompositionGraph) => Diagnostic[]
}

export interface Diagnostic {
  /** 严重级别 */
  severity: 'error' | 'warning'
  /** 诊断消息 */
  message: string
  /** 涉及的节点 id */
  nodeId?: string
  /** 涉及的文件路径 */
  file?: string
  /** 涉及的字段路径 */
  fieldPath?: string
  /** 修复建议 */
  suggestion?: string
}
```

**迁移自现有脚本的规则清单**：

| 规则 id | 来源 | 描述 |
|---------|------|------|
| `unknown-plugin` | `verify-cordis-config.ts` | 引用了未在依赖中声明的插件包 |
| `metadata-expression` | `verify-cordis-config.ts` | 非 `disabled` 字段包含 `!!js` 表达式 |
| `disabled-parse` | `verify-cordis-config.ts` | `disabled` 表达式语法错误 |
| `preset-plane-separation` | `verify-cordis-config.ts` | preset 行同时存在于 host 平面 |
| `client-half-declared` | `verify-cordis-config.ts` | client 包声明了 `./client` 导出但无 `dsh.client` 块（或反之） |
| `source-plane-resolution` | `verify-cordis-config.ts` | 插件包未通过 tsconfig paths 解析到源文件 |
| `inject-closure` | 新增 | `ctx.inject` 的依赖在装配图中无提供者（注入闭包不闭合） |
| `duplicate-mount` | 新增 | 同一平面内同一服务被两个非 isolate 节点提供 |
| `cycle-detection` | 新增 | 装配依赖图存在环 |
| `orphan-service` | 新增 | 提供了服务但无消费者（warning） |
| `isolate-shadow` | 新增 | isolate 域内 provider 遮蔽了 host 消费者所需的路由 |
| `sensitive-override` | 新增 | 敏感配置被低信任层覆盖（见 4.3.3） |
| `capability-overclaim` | v2 新增 | 声明的能力超出插件信任等级允许的上限（见 5.2.3） |
| `fixture-module-dependency` | `verify-cordis-config.ts`（M0 补登） | fixture 模块的 import 声明未落在 owner manifest 依赖中（SEC-1007，裁定 4A 确认独立登记，S3 迁移保留） |

#### 4.2.2 动态校验（挂载期）

在每次挂载决策点执行，对"当前已激活服务集"做依赖可达性检查：

```typescript
// packages/assembly/src/validators/dynamic.ts

export interface DynamicValidationContext {
  /** 当前已激活的节点 id 集合 */
  activeNodes: Set<string>
  /** 当前已注册的服务标识集合 */
  registeredServices: Set<string>
  /** 正在挂载的节点 */
  mountingNode: EffectiveNode
  /** 已挂载的节点列表 */
  mountedNodes: EffectiveNode[]
}

export interface DynamicDiagnostic extends Diagnostic {
  /** 诊断类型 */
  kind: 'missing-dependency' | 'duplicate-registration' | 'isolate-violation' | 'service-death'
  /** 缺失的服务标识（如有） */
  missingService?: string
  /** 谁需要这个服务 */
  consumers?: string[]
  /** 谁能提供但未激活，以及未激活原因 */
  potentialProviders?: Array<{
    nodeId: string
    reason: 'disabled' | 'plane-mismatch' | 'overridden' | 'not-yet-mounted'
  }>
}
```

动态校验的四个检查项：

1. **依赖可达性**：挂载节点 N 时，N 的 `needs` 中每个服务是否已在 `registeredServices` 中或将被 N 自身提供。
2. **重复注册**：N 的 `provides` 是否与已激活的非 isolate 节点冲突。
3. **isolate 遮蔽**：N 在 isolate 域内提供的 service 是否遮蔽了 host 消费者所需的路由。
4. **服务消亡告警**：节点被 unmount 或 disabled 时，其 `provides` 是否有其他已激活节点仍依赖。

失败时给出结构化诊断——`{缺失服务, 谁需要, 谁能提供但未激活, 为何未激活}`——而不是裸 throw。

---

### 4.3 安全管控（Security Control）

#### 4.3.1 插件信任源（Plugin Trust Source）

控制"能加载哪些插件包"，按来源分级：

```typescript
// packages/assembly/src/security/trust.ts

export interface TrustPolicy {
  /** 信任等级 → 允许的包来源模式 */
  levels: {
    trusted: TrustLevelConfig
    user: TrustLevelConfig
    preset: TrustLevelConfig
    patch: TrustLevelConfig
  }
}

export interface TrustLevelConfig {
  /** 本仓库 packages/* 下的包 */
  workspacePackages: boolean
  /** vendor/* 下的包 */
  vendorPackages: boolean
  /** npm registry 已签名的包 */
  signedRegistry: boolean
  /** 任意 npm 包 */
  arbitrary: boolean
}
```

**默认策略**：

| 信任等级 | workspace | vendor | signed registry | arbitrary |
|----------|-----------|--------|-----------------|-----------|
| trusted（base patch） | 允许 | 允许 | 允许 | 禁止 |
| user（profile patch） | 允许 | 允许 | 允许 | 禁止 |
| preset（preset patch） | 允许 | 允许 | 禁止 | 禁止 |
| patch（`--patch`） | 允许 | 禁止 | 禁止 | 禁止 |

#### 4.3.2 `!!js` 白名单求值器

把现有的 `new Script(expr)` 替换为受限求值器：

```typescript
// packages/assembly/src/security/safe-eval.ts

/** 白名单上下文——只允许这些操作 */
export interface SafeEvalContext {
  /** ctx.get(key) ——仅允许访问已注册的服务 */
  get: (key: string) => unknown
  /** process.platform ——只读属性 */
  readonly platform: string
  /** process.env 中的白名单 key */
  readonly env: Readonly<Record<string, string | undefined>>
  /** dshHomePath ——仅允许路径拼接，不允许任意路径 */
  dshHomePath: (sub: string) => string
  /** process.cwd() ——只读 */
  readonly cwd: string
}

/** 允许的语法结构白名单 */
export const ALLOWED_SYNTAX = [
  'MemberExpression',      // ctx.get('x')
  'CallExpression',        // ctx.get('x')、dshHomePath('x')
  'LogicalExpression',     // a || b、a && b
  'ConditionalExpression', // a ? b : c
  'BinaryExpression',      // a === b
  'Literal',               // 'string'、123、true
  'Identifier',            // ctx、process
] as const

/** 禁止的语法结构黑名单 */
export const FORBIDDEN_SYNTAX = [
  'FunctionExpression',    // 不允许定义函数
  'ArrowFunctionExpression', // 不允许箭头函数
  'NewExpression',         // 不允许 new
  'AssignmentExpression',  // 不允许赋值
  'UpdateExpression',      // 不允许 ++/--
  'AwaitExpression',       // 不允许 await
  'YieldExpression',       // 不允许 yield
  'ImportExpression',       // 不允许 import()
] as const
```

**求值流程**：

1. 用 AST 解析器（如 acorn）解析 `!!js` 表达式
2. 遍历 AST，检查所有节点是否在 `ALLOWED_SYNTAX` 内、不在 `FORBIDDEN_SYNTAX` 内
3. 检查 `MemberExpression` 的对象是否为白名单标识符（`ctx`、`process`、`dshHomePath`）
4. 检查 `process.env` 的属性访问是否为白名单 key
5. 全部通过后，在受限 `SafeEvalContext` 中求值
6. 任何违规都产生 `Diagnostic`（装载期失败），而非运行期暴雷

**白名单 env key**（初始集合，可扩展）：

```
DSH_TELEMETRY_MODE, DSH_TELEMETRY_OTLP_URL, DSH_TELEMETRY_DISABLED,
DSH_PERMISSION_MODE, DSH_HOME, DEEPSEEK_API_KEY
```

#### 4.3.3 敏感配置覆盖保护

标记敏感配置项，禁止低信任层覆盖：

```typescript
// packages/assembly/src/security/sensitive.ts

/** 敏感配置路径——格式为 "rowId.fieldPath" */
export const SENSITIVE_PATHS: SensitivePath[] = [
  { rowId: 'sandbox-policy', field: 'mode', minTrust: 'trusted' },
  { rowId: 'sandbox-policy', field: 'workspaceRoot', minTrust: 'trusted' },
  { rowId: 'approval', field: 'policy', minTrust: 'trusted' },
  { rowId: 'permission', field: 'presets', minTrust: 'trusted' },
  { rowId: 'session-telemetry-otel', field: 'exporter.url', minTrust: 'trusted' },
  { rowId: 'session-telemetry-otel', field: 'mode', minTrust: 'user' },
]

export interface SensitivePath {
  /** 行 id */
  rowId: string
  /** 字段路径 */
  field: string
  /** 允许覆盖的最低信任等级 */
  minTrust: 'trusted' | 'user' | 'preset' | 'patch'
}
```

**检查逻辑**：展开器在合并覆盖链时，如果检测到低信任层覆盖了标记为敏感的字段，产生 error 级 Diagnostic，装载中止。

**这与 dsh 现有的安全语义对齐**：`sandbox-policy.mode` 和 `approval.policy` 是安全边界，不应被用户 profile 或 `--patch` 覆盖到 `danger-full-access` 而无审计记录。

#### 4.3.4 审计链（Audit Chain）

每次装载/覆盖/挂载变更记录为可追溯台账：

```typescript
// packages/assembly/src/security/audit.ts

export interface AuditEntry {
  /** 时间戳 */
  timestamp: string
  /** 操作类型 */
  action: 'load' | 'override' | 'mount' | 'unmount' | 'disable' | 'enable' | 'security-violation'
  /** 来源层 */
  layer: string
  /** 来源文件 */
  file: string
  /** 涉及的行 id */
  rowId?: string
  /** 变更的字段 */
  field?: string
  /** 旧值摘要 */
  oldValue?: string
  /** 新值摘要 */
  newValue?: string
  /** 安全判定结果（如有） */
  securityVerdict?: 'pass' | 'deny' | 'warn'
  /** 安全判定原因 */
  securityReason?: string
}
```

审计日志写入 `$DSH_HOME/assembly-audit.log`（追加写入，不可篡改格式）。

---

## 5. 运行时管控层详细设计

运行时管控层是装配控制层的"后防线"——装配控制层验证了"谁能装载、装载什么"，运行时管控层管控"装载后能做什么"。四个机制构成一条完整的运行时防线：

```
  插件 apply(ctx) 执行
       │
       ├─ 访问服务 ──→ 机制 1：服务膜（Service Membrane）
       │                   · 拦截 ctx.get() 返回值篡改
       │                   · 拦截 ctx.set() 动态遮蔽
       │
       ├─ 获取服务引用 ──→ 机制 2：能力令牌（Cap[T]）
       │                   · 按契约预颁发，不可伪造
       │                   · 权限范围限定，可撤销
       │
       ├─ 发起副作用 ──→ 机制 3：效果系统（Effect System）
       │                   · 所有 I/O/网络/子进程经效果处理器
       │                   · 每个效果检查 sandbox + approval 策略
       │
       └─ 运行 JS 代码 ──→ 机制 4：执行隔离域（Execution Realm）
                            · 全局对象替换为受限版本
                            · require/import 白名单
                            · 原型链冻结
```

### 5.1 机制 1：服务膜（Service Membrane）

#### 5.1.1 问题

Cordis 的 `ctx.get('sandbox')` 返回的是原始 JS 对象引用。任何消费者都能：

```typescript
const sandbox = ctx.get('sandbox')
sandbox.mode = 'danger-full-access'   // 直接改属性
sandbox.check = () => true             // 替换方法
delete sandbox.validate                // 删除方法
```

JS 对象没有封装边界，服务一旦暴露引用，消费者拥有全部读写权限。

#### 5.1.2 方案

在 `ctx.get()` 返回服务对象时，用 Proxy 包装一层"膜"，对属性读写做拦截：

```typescript
// packages/runtime-control/src/membrane.ts

/** 服务膜配置——描述一个服务对象的访问规则 */
export interface MembraneConfig {
  /** 不可写属性列表——set/delete 拦截 */
  readonly: string[]
  /** 不可删除属性列表 */
  sealed: string[]
  /** 不可访问属性列表——get 拦截 */
  hidden: string[]
  /** 不可调用方法列表——get 返回 throw-bound proxy */
  blocked: string[]
}

/** 默认服务膜配置——所有服务默认只读 */
export const DEFAULT_MEMBRANE: MembraneConfig = {
  readonly: ['mode', 'policy', 'presets', 'config'],
  sealed: ['check', 'validate', 'approve', 'reject', 'mode', 'policy'],
  hidden: [],
  blocked: [],
}

/** 安全关键服务的强化膜配置 */
export const SENSITIVE_MEMBRANE: MembraneConfig = {
  readonly: ['mode', 'policy', 'presets', 'workspaceRoot', 'config', 'exporter', 'url'],
  sealed: ['check', 'validate', 'approve', 'reject', 'mode', 'policy', 'presets'],
  hidden: ['internal', '_private', '_handlers'],
  blocked: ['setMode', 'setPolicy', 'override'],
}

/** 为服务对象创建膜 */
export function createMembrane<T extends object>(
  target: T,
  config: MembraneConfig,
  auditCallback: (entry: MembraneAuditEntry) => void,
): T {
  return new Proxy(target, {
    get(obj, prop: string) {
      if (config.hidden.includes(prop)) {
        const entry: MembraneAuditEntry = {
          action: 'access-denied', property: prop, reason: 'hidden',
        }
        auditCallback(entry)
        throw new SecurityViolation(
          `访问被拒：属性 '${prop}' 被膜标记为 hidden`,
          entry,
        )
      }
      if (config.blocked.includes(prop)) {
        return () => {
          const entry: MembraneAuditEntry = {
            action: 'call-blocked', property: prop, reason: 'blocked',
          }
          auditCallback(entry)
          throw new SecurityViolation(
            `调用被拒：方法 '${prop}' 被膜标记为 blocked`,
            entry,
          )
        }
      }
      const value = Reflect.get(obj, prop)
      // 对返回的函数绑定 this 到原始对象，防止通过解构窃取引用
      if (typeof value === 'function') {
        return value.bind(obj)
      }
      return value
    },
    set(obj, prop: string, value) {
      if (config.readonly.includes(prop)) {
        const entry: MembraneAuditEntry = {
          action: 'write-denied', property: prop, reason: 'readonly',
          attemptedValue: String(value),
        }
        auditCallback(entry)
        throw new SecurityViolation(
          `写入被拒：属性 '${prop}' 被膜标记为 readonly`,
          entry,
        )
      }
      return Reflect.set(obj, prop, value)
    },
    deleteProperty(obj, prop: string) {
      if (config.sealed.includes(prop)) {
        const entry: MembraneAuditEntry = {
          action: 'delete-denied', property: prop, reason: 'sealed',
        }
        auditCallback(entry)
        throw new SecurityViolation(
          `删除被拒：属性 '${prop}' 被膜标记为 sealed`,
          entry,
        )
      }
      return Reflect.deleteProperty(obj, prop)
    },
    // 阻止 defineProperty——防止通过 Object.defineProperty 篡改
    defineProperty(obj, prop, descriptor) {
      const entry: MembraneAuditEntry = {
        action: 'define-denied', property: String(prop), reason: 'membrane',
      }
      auditCallback(entry)
      throw new SecurityViolation(
        `定义属性被拒：膜禁止 Object.defineProperty`,
        entry,
      )
    },
  })
}

export interface MembraneAuditEntry {
  action: 'access-denied' | 'write-denied' | 'delete-denied' | 'call-blocked' | 'define-denied'
  property: string
  reason: string
  attemptedValue?: string
}

export class SecurityViolation extends Error {
  constructor(
    message: string,
    public readonly auditEntry: MembraneAuditEntry,
  ) {
    super(message)
    this.name = 'SecurityViolation'
  }
}
```

#### 5.1.3 与 Cordis 的集成

服务膜不修改 Cordis 内核的 `ctx.get()` 实现，而是在**装配控制层的挂载阶段**注入：当 Cordis loader 挂载一个插件时，控制层拦截其 `ctx` 的 `get` 方法，在返回服务对象前包装膜。

```typescript
// packages/runtime-control/src/integration.ts

/** 为插件 Context 安装服务膜 */
export function installMembrane(
  ctx: Context,
  membraneConfigs: Map<string, MembraneConfig>,
  auditCallback: (entry: MembraneAuditEntry) => void,
): void {
  const originalGet = ctx.get.bind(ctx)
  // @ts-expect-error — 覆盖 ctx.get 以注入膜
  ctx.get = <T>(key: string): T => {
    const raw = originalGet<T>(key)
    if (raw === undefined) return raw
    const config = membraneConfigs.get(key) ?? DEFAULT_MEMBRANE
    // 仅对普通对象/函数包装膜；原始值（string/number/boolean）不需要
    if (typeof raw === 'object' && raw !== null) {
      return createMembrane(raw as object, config, auditCallback) as T
    }
    return raw
  }
}
```

#### 5.1.4 膜配置注册

```typescript
// packages/runtime-control/src/membrane-config.ts

/** 安全关键服务的膜配置注册表 */
export const SENSITIVE_SERVICE_MEMBRANES: Map<string, MembraneConfig> = new Map([
  ['sandbox', SENSITIVE_MEMBRANE],
  ['sandbox-policy', SENSITIVE_MEMBRANE],
  ['approval', SENSITIVE_MEMBRANE],
  ['permission', SENSITIVE_MEMBRANE],
  ['credentials', SENSITIVE_MEMBRANE],
  ['authorization', SENSITIVE_MEMBRANE],
  ['session-telemetry-otel', SENSITIVE_MEMBRANE],
])

/** 普通服务的膜配置注册表——使用默认只读膜 */
export const STANDARD_SERVICE_MEMBRANES: Map<string, MembraneConfig> = new Map([
  // 大多数服务使用 DEFAULT_MEMBRANE（只读 mode/policy/config，sealed check/validate）
])
```

---

### 5.2 机制 2：能力令牌（Cap[T]）

#### 5.2.1 问题

`ctx.inject(['sandbox'], (ctx) => ...)` 的字符串 key 查找没有权限范围约束——消费者拿到服务引用后，对该服务的所有方法都有调用权限。没有机制限定"只能调 `check()`，不能调 `setMode()`"。

#### 5.2.2 方案

引入**不可伪造的能力令牌**，服务访问不通过字符串 key + `ctx.get()`，而是通过令牌。令牌在装载时根据契约声明预颁发，携带权限范围，可被撤销。

```typescript
// packages/runtime-control/src/capability.ts

/** 能力令牌——代表对某个服务的受限访问权 */
export class CapabilityToken<T extends object> {
  /** 令牌 id——全局唯一，不可伪造 */
  readonly id: string
  /** 目标服务标识 */
  readonly service: string
  /** 颁发来源——哪个插件的契约 */
  readonly issuedTo: string
  /** 允许调用的方法列表 */
  readonly allowedMethods: ReadonlySet<string>
  /** 允许读取的属性列表 */
  readonly allowedProps: ReadonlySet<string>
  /** 令牌过期时间戳（ms），0 = 永不过期 */
  readonly expiresAt: number
  /** 是否已被撤销 */
  private revoked = false

  private constructor(config: {
    id: string
    service: string
    issuedTo: string
    allowedMethods: string[]
    allowedProps: string[]
    expiresAt: number
  }) {
    this.id = config.id
    this.service = config.service
    this.issuedTo = config.issuedTo
    this.allowedMethods = new Set(config.allowedMethods)
    this.allowedProps = new Set(config.allowedProps)
    this.expiresAt = config.expiresAt
  }

  /** 通过令牌访问服务——返回受膜保护且令牌受限的代理 */
  use<U>(target: T, membrane: MembraneConfig): CapabilityHandle<T> {
    if (this.revoked) {
      throw new SecurityViolation(
        `令牌已撤销：${this.service}（颁发给 ${this.issuedTo}）`,
        { action: 'call-blocked', property: '*', reason: 'revoked' },
      )
    }
    if (this.expiresAt > 0 && Date.now() > this.expiresAt) {
      throw new SecurityViolation(
        `令牌已过期：${this.service}（颁发给 ${this.issuedTo}）`,
        { action: 'call-blocked', property: '*', reason: 'expired' },
      )
    }
    return createCapabilityHandle(target, this, membrane)
  }

  /** 撤销令牌 */
  revoke(): void {
    this.revoked = true
  }

  /** 令牌是否有效 */
  get isValid(): boolean {
    return !this.revoked && (this.expiresAt === 0 || Date.now() <= this.expiresAt)
  }

  /** 令牌工厂——仅运行时管控层可调用 */
  static _issue<T extends object>(config: {
    service: string
    issuedTo: string
    allowedMethods: string[]
    allowedProps: string[]
    expiresAt?: number
  }): CapabilityToken<T> {
    return new CapabilityToken({
      id: `cap_${crypto.randomUUID()}`,
      service: config.service,
      issuedTo: config.issuedTo,
      allowedMethods: config.allowedMethods,
      allowedProps: config.allowedProps,
      expiresAt: config.expiresAt ?? 0,
    })
  }
}

/** 能力句柄——通过令牌获得的受限服务代理 */
export interface CapabilityHandle<T> {
  /** 读取属性——仅允许 allowedProps 中的 */
  get<K extends keyof T>(prop: K): T[K]
  /** 调用方法——仅允许 allowedMethods 中的 */
  call<K extends keyof T>(method: K, ...args: unknown[]): T[K] extends (...a: unknown[]) => unknown ? ReturnType<T[K]> : never
  /** 令牌是否仍然有效 */
  readonly isValid: boolean
}

function createCapabilityHandle<T extends object>(
  target: T,
  token: CapabilityToken<T>,
  membrane: MembraneConfig,
): CapabilityHandle<T> {
  return {
    get(prop: string) {
      if (!token.allowedProps.has(prop)) {
        throw new SecurityViolation(
          `能力越界：令牌不允许读取属性 '${prop}'（服务 ${token.service}）`,
          { action: 'access-denied', property: prop, reason: 'capability' },
        )
      }
      // 同时受膜保护
      if (membrane.hidden.includes(prop)) {
        throw new SecurityViolation(
          `膜拒绝：属性 '${prop}' 被标记为 hidden`,
          { action: 'access-denied', property: prop, reason: 'hidden' },
        )
      }
      return Reflect.get(target, prop)
    },
    call(method: string, ...args: unknown[]) {
      if (!token.allowedMethods.has(method)) {
        throw new SecurityViolation(
          `能力越界：令牌不允许调用方法 '${method}'（服务 ${token.service}）`,
          { action: 'call-blocked', property: method, reason: 'capability' },
        )
      }
      if (membrane.blocked.includes(method)) {
        throw new SecurityViolation(
          `膜拒绝：方法 '${method}' 被标记为 blocked`,
          { action: 'call-blocked', property: method, reason: 'blocked' },
        )
      }
      const fn = Reflect.get(target, method)
      if (typeof fn !== 'function') {
        throw new TypeError(`'${method}' 不是函数`)
      }
      return fn.apply(target, args)
    },
    get isValid() {
      return token.isValid
    },
  }
}
```

#### 5.2.3 能力令牌预颁发

装配控制层根据 `PluginContract.capabilities` 和 `PluginContract.needs` 预颁发令牌：

```typescript
// packages/runtime-control/src/issuer.ts

/** 能力令牌预颁发计划——由装配控制层产出 */
export interface CapabilityGrantPlan {
  /** 每个插件预颁发的令牌列表 */
  grants: Map<string, TokenGrant[]>
}

export interface TokenGrant {
  /** 目标服务标识 */
  service: string
  /** 允许的方法——根据服务类型和服务膜配置推导 */
  allowedMethods: string[]
  /** 允许的属性 */
  allowedProps: string[]
  /** 过期时间（会话级令牌随会话过期） */
  expiresAt: number
}

/** 根据装配计划颁发令牌 */
export function issueTokens(
  plan: AssemblyPlan,
  serviceMethodRegistry: Map<string, string[]>,
): Map<string, CapabilityToken[]> {
  const tokens = new Map<string, CapabilityToken[]>()
  for (const node of plan.nodes) {
    if (!node.contract) continue
    const nodeTokens: CapabilityToken[] = []
    // 为每个 needs 服务颁发令牌
    for (const service of node.contract.needs) {
      const allMethods = serviceMethodRegistry.get(service) ?? []
      // 仅颁发 capabilities 中声明的权限子集
      const allowed = filterAllowedMethods(service, allMethods, node.contract.capabilities)
      const token = CapabilityToken._issue({
        service,
        issuedTo: node.id,
        allowedMethods: allowed.methods,
        allowedProps: allowed.props,
        expiresAt: node.contract.plane === 'session' ? Date.now() + SESSION_TIMEOUT_MS : 0,
      })
      nodeTokens.push(token)
    }
    tokens.set(node.id, nodeTokens)
  }
  return tokens
}
```

#### 5.2.4 能力越界校验（装配期静态校验）

`capability-overclaim` 规则（在 4.2.1 中已列出）：如果插件契约声明的 `capabilities` 超出其信任等级允许的上限，装载期直接失败。

```typescript
// packages/assembly/src/validators/capability-claim.ts

/** 各信任等级的能力上限（v3：增加 mcp 维度） */
export const CAPABILITY_CEILINGS: Record<string, CapabilityCeiling> = {
  trusted: { fs: '**', network: '*', process: '*', env: '*', mcp: '*' },
  user: { fs: '${dshHome}/**', network: '*', process: [], env: 'read-only', mcp: '*' },
  preset: { fs: '${dshHome}/sessions/**', network: [], process: [], env: [], mcp: [] },
  patch: { fs: [], network: [], process: [], env: [], mcp: [] },
}

export interface CapabilityCeiling {
  fs: string[] | string
  network: string[] | string
  process: string[] | string
  env: string[] | string
  mcp: string[] | string       // v3：MCP server 白名单上限
}
```

#### 5.2.5 令牌派生与 fiber 粒度（v3 新增）

装载期预颁发的令牌是**插件级**的；运行期 fiber（subagent spawn/fork、会话）创建时，从插件级令牌**派生 fiber 级令牌**，撤销可精确到单个子代理（R11）：

```typescript
// packages/runtime-control/src/capability.ts

/** fiber 创建时从插件级令牌克隆出 fiber 级令牌（可传入更窄的方法/属性集合，只减不增） */
export function deriveFiberToken(
  parent: CapabilityToken,
  fiberId: string,
  narrowTo?: { methods?: string[]; props?: string[] },
): CapabilityToken {
  const methods = narrowTo?.methods ?? [...parent.allowedMethods]
  const props = narrowTo?.props ?? [...parent.allowedProps]
  return CapabilityToken._issue({
    service: parent.service,
    issuedTo: `${parent.issuedTo}#${fiberId}`,
    allowedMethods: methods,
    allowedProps: props,
    // 派生令牌不继承"永不过期"：随 fiber 生命周期过期
    expiresAt: parent.expiresAt === 0 ? fiberExpiry(fiberId) : parent.expiresAt,
  })
}
```

撤销链沿 `pluginId → fiberId` 精确传播：`revokePlugin` 撤销全部派生令牌，`revokeFiber(pluginId, fiberId)` 只撤单个子代理，兄弟 fiber 不受影响（验收 R22）。单个子代理违规时配合 isolate 档可精确摘除，不影响并行兄弟。

#### 5.2.6 令牌续期与定时任务（v3 新增）

`expiresAt: 0`（永不过期）对定时任务和长驻 fiber 是滥用口子；固定超时又会让 cron 型任务中途失能（对照 TeleAgent 定时任务场景）。续期机制显式解决这一张力：

```typescript
// packages/runtime-control/src/capability.ts

/** 令牌续期策略 */
export interface TokenRenewalPolicy {
  /** 续期凭据类型：scheduler 颁发的任务凭据，或用户显式授权 */
  renewWith: 'task-credential' | 'user-grant'
  /** 单次续期时长上限 */
  maxExtensionMs: number
  /** 累计续期次数上限——防无限续期 */
  maxRenewals: number
}
```

`CapabilityToken` 增加 `renew(policy, credential)`：校验凭据、检查次数上限、写入审计（action: 'token-renew'）。缺省策略：session 令牌不可续（随会话过期即失效），定时任务令牌凭 `packages/schedule` 颁发的任务凭据续期，每次续期时长不超过单次上限。

---

### 5.3 机制 3：效果系统（Effect System）

#### 5.3.1 问题

业务插件可以直接 `import` Node.js 原生模块执行任意副作用：

```typescript
import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
writeFileSync('/etc/passwd', '...')
execSync('rm -rf /')
```

这些调用绕过了 dsh 的 sandbox 和 approval 策略——策略只在 dsh 自己的 tool 层生效，对插件代码直接调 Node API 无能为力。

v3 补充第二个覆盖缺口：dsh 的 MCP 工具调用（`packages/mcp` 生态）是**进程外副作用**——工具在独立进程中执行文件、网络、键鼠操作，效果系统若只覆盖进程内四类（fs/net/proc/env），整层 MCP 调用就落在管控面之外（1.2.3 R9）。

#### 5.3.2 方案

所有副作用（文件 I/O、网络、子进程、环境变量）不直接调用 Node.js API，而是通过受控的效果处理器。每个效果都经过 sandbox 策略和 approval 策略检查。

```typescript
// packages/runtime-control/src/effect.ts

/** 效果类型（v3：删除拆分为回收站/永久两档；v4：新增 MCP 反向请求三型） */
export type EffectType = 'fs.read' | 'fs.write' | 'fs.stat'
  | 'fs.trash' | 'fs.delete-permanent'
  | 'net.fetch' | 'net.connect'
  | 'proc.spawn' | 'proc.exec'
  | 'env.get' | 'env.set'
  | 'mcp.call'
  | 'mcp.sampling-request' | 'mcp.roots-request' | 'mcp.elicitation-request'

/** 效果请求 */
export interface EffectRequest {
  type: EffectType
  /** 目标路径/URL/命令名/环境变量名/MCP 工具名 */
  target: string
  /** 附加参数 */
  args?: unknown[]
  /** 发起效果的插件 id（v3：含 fiber 后缀，如 'tool-fs#fiber-12'） */
  caller: string
  /** 发起效果时持有的能力令牌 id */
  capabilityTokenId?: string
  /** 产物类型标记（v3 新增，仅 fs.write）：intermediate 免审批、约束到临时区；缺省按 final 处理 */
  artifact?: 'intermediate' | 'final'
}

/** 效果处理器——对每个效果做权限检查后执行 */
export interface EffectHandler {
  /** 处理效果请求 */
  handle(req: EffectRequest): Promise<EffectResult>
}

export interface EffectResult {
  ok: boolean
  data?: unknown
  error?: string
  auditEntry: EffectAuditEntry
}

export interface EffectAuditEntry {
  timestamp: string
  type: EffectType
  target: string
  caller: string
  verdict: 'allow' | 'deny'
  reason?: string
  sandboxMode?: string
  approvalDecision?: 'approved' | 'denied' | 'auto' | 'auto-by-provenance' | 'exempted' | 'timeout'
  /** v3：本次批准写入授权库时的条目 id（授权记忆溯源） */
  grantId?: string
  /** v3：豁免通道（走豁免时记录，免审批不等于不记录） */
  exemption?: 'same-session-artifact' | 'temp-area' | 'trash-default' | 'user-preauthorized'
  /** v3：数据外发检查结果（net 类效果） */
  exfiltrationCheck?: 'pass' | 'blocked' | 'not-applicable'
}
```

#### 5.3.3 效果处理器实现

```typescript
// packages/runtime-control/src/effects/handlers.ts

/** 文件系统效果处理器 */
export class FsEffectHandler implements EffectHandler {
  constructor(
    private sandboxMode: () => string,
    private workspaceRoot: () => string,
    private approval: ApprovalService,       // v3：从同步回调升级为审批服务（park/resume，见 5.3.6）
    private provenance: ProvenanceRegistry,   // v3：本轮产物豁免的判定依据
    private tempAreaRoot: string,             // v3：临时区根（$DSH_HOME/.temp/）
    private audit: (entry: EffectAuditEntry) => void,
  ) {}

  async handle(req: EffectRequest): Promise<EffectResult> {
    const mode = this.sandboxMode()
    const root = this.workspaceRoot()

    // read-only 模式下禁止一切写与删除（含回收站；永久删除任何模式都需审批）
    if (mode === 'read-only'
      && (req.type.startsWith('fs.write') || req.type === 'fs.trash' || req.type === 'fs.delete-permanent')) {
      return this.deny(req, `read-only 模式禁止 ${req.type}`)
    }

    // 路径规范化后检查 workspace 边界（v3：realpath 先行，防符号链接绕过豁免判定）
    // ——注：realpath 先行属缓解非闭环（检查与打开间有竞态窗口）；原子化升级（openat2/dirfd，Node 无 API）见 17.3 P3，S12 预留接口位
    const resolved = realpathSync(resolve(req.target))
    if (!resolved.startsWith(root) && mode !== 'danger-full-access' && !isInside(resolved, this.tempAreaRoot)) {
      return this.deny(req, `路径超出 workspace：${resolved}`)
    }

    // v3 审批语义（5.3.6）：豁免判定 → 授权记忆 lookup → 未命中则 park 等待
    // fs.trash 是低门槛默认；fs.delete-permanent 是高门槛（需契约声明 + 审批）
    if (req.type.startsWith('fs.write') || req.type === 'fs.trash' || req.type === 'fs.delete-permanent') {
      const exempt = evaluateExemption(req, this.provenance, this.tempAreaRoot)
      if (exempt === undefined && this.approval.lookupGrant(req) === undefined) {
        const ticket = this.approval.request(req)
        const decision = await ticket.fiber.park()
        if (decision.verdict !== 'approve') {
          return this.deny(req, decision.verdict === 'timeout' ? '审批超时自动拒绝' : '用户拒绝审批')
        }
      }
    }

    // 执行实际操作
    try {
      const data = await executeFsEffect(req)
      return this.allow(req, data)
    } catch (error) {
      return this.deny(req, String(error))
    }
  }

  private allow(req: EffectRequest, data: unknown): EffectResult {
    const entry: EffectAuditEntry = {
      timestamp: new Date().toISOString(), type: req.type, target: req.target,
      caller: req.caller, verdict: 'allow', sandboxMode: this.sandboxMode(),
    }
    this.audit(entry)
    return { ok: true, data, auditEntry: entry }
  }

  private deny(req: EffectRequest, reason: string): EffectResult {
    const entry: EffectAuditEntry = {
      timestamp: new Date().toISOString(), type: req.type, target: req.target,
      caller: req.caller, verdict: 'deny', reason, sandboxMode: this.sandboxMode(),
    }
    this.audit(entry)
    return { ok: false, error: reason, auditEntry: entry }
  }
}
```

#### 5.3.4 效果 API 暴露

业务代码不直接调 `node:fs`，而是通过注入的 `effect` 对象：

```typescript
// packages/runtime-control/src/effects/api.ts

/** 暴露给业务代码的效果 API */
export interface EffectApi {
  fs: {
    read(path: string): Promise<Buffer>
    /** artifact: 'intermediate' 免审批、约束到临时区；缺省 'final' 走完整审批 */
    write(path: string, data: Buffer | string, opts?: { artifact?: 'intermediate' | 'final' }): Promise<void>
    /** 回收站式删除（v3：默认删除语义，低门槛） */
    trash(path: string): Promise<void>
    /** 永久删除（v3）：需契约单独声明 permanentDelete 能力 + 审批 */
    deletePermanent(path: string): Promise<void>
    stat(path: string): Promise<Stats>
  }
  net: {
    fetch(url: string, init?: RequestInit): Promise<Response>
    connect(host: string, port: number): Promise<Socket>
  }
  proc: {
    spawn(cmd: string, args: string[]): Promise<ChildProcess>
    exec(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>
  }
  env: {
    get(key: string): string | undefined
    set(key: string, value: string): void
  }
  mcp: {
    /** MCP 工具调用（v3 新增）：server.tool 形式寻址，经效果系统审计 */
    call(server: string, tool: string, args: unknown): Promise<unknown>
  }
}

/** 为插件创建效果 API——所有调用都经过处理器 */
export function createEffectApi(
  handlers: Map<EffectType, EffectHandler>,
  callerId: string,
  tokenId: string,
): EffectApi {
  const dispatch = async (type: EffectType, target: string, args?: unknown[]) => {
    const handler = handlers.get(type)
    if (!handler) throw new Error(`无效果处理器：${type}`)
    const result = await handler.handle({ type, target, args, caller: callerId, capabilityTokenId: tokenId })
    if (!result.ok) throw new SecurityViolation(`效果被拒：${result.error}`, result.auditEntry as MembraneAuditEntry)
    return result.data
  }

  return {
    fs: {
      read: (path) => dispatch('fs.read', path),
      write: (path, data, opts) => dispatch('fs.write', path, [data, opts]),
      trash: (path) => dispatch('fs.trash', path),
      deletePermanent: (path) => dispatch('fs.delete-permanent', path),
      stat: (path) => dispatch('fs.stat', path),
    },
    net: {
      fetch: (url, init) => dispatch('net.fetch', url, [init]),
      connect: (host, port) => dispatch('net.connect', `${host}:${port}`),
    },
    proc: {
      spawn: (cmd, args) => dispatch('proc.spawn', cmd, args),
      exec: (cmd) => dispatch('proc.exec', cmd),
    },
    env: {
      get: (key) => dispatch('env.get', key) as string,
      set: (key, value) => dispatch('env.set', key, [value]),
    },
    mcp: {
      call: (server, tool, args) => dispatch('mcp.call', `${server}.${tool}`, [args]),
    },
  }
}
```

#### 5.3.5 效果审计日志

效果审计写入 `$DSH_HOME/effect-audit.log`，格式与装配审计链一致但独立存储：

```typescript
// 每条记录
{ "timestamp": "2026-09-30T12:00:00Z", "type": "fs.write", "target": "/workspace/file.ts",
  "caller": "tool-fs", "verdict": "allow", "sandboxMode": "workspace-write", "approvalDecision": "auto" }
```

#### 5.3.6 审批语义：三档授权、豁免通道与 park/resume（v3 新增）

v2 的审批是"一次一问的同步阻塞"（`await approval(req)`），在智能体场景有两个硬缺陷：用户回复以分钟计，同步等待占死 Fiber、会话无法响应取消（R6）；一次任务几十次副作用每次都问，不可用（R7）。v3 把审批重构为**一等阻塞状态 + 授权记忆 + 豁免通道**。

**授权记忆——三档范围**（对应 TeleAgent once/always 语义的拆分）：

```typescript
// packages/runtime-control/src/effects/approval.ts

/** 授权范围——审批通过后记住什么 */
export type GrantScope = 'once' | 'object' | 'class'

/** 授权记忆条目 */
export interface ApprovalGrant {
  id: string
  /** 授权范围：once 不记忆；object 记精确目标；class 记效果类型+插件 */
  scope: GrantScope
  /** object 级：精确目标（文件路径/URL/命令名/MCP 工具名） */
  objectKey?: string
  /** class 级：效果类型 + 插件 id */
  classKey?: string
  /** 授权者：user（显式）| policy（策略自动）| provenance（来源豁免） */
  grantedBy: 'user' | 'policy' | 'provenance'
  issuedAt: number
  /** 会话级授权随会话失效，不跨会话残留 */
  expiresAt: number
  /** 本轮任务 id——provenance 豁免的判定依据 */
  taskId?: string
}

export interface ApprovalDecision {
  verdict: 'approve' | 'reject' | 'timeout'
  /** 批准时用户选择的记忆范围："就这一次"/"这个目标随你写"/"这类操作都放行" */
  scope?: GrantScope
  note?: string
}
```

**豁免通道——免审批判定**（对应 TeleAgent 确认豁免条款）：

```typescript
/** 豁免通道——封闭枚举，新增必须走与白名单同级的审批流程（9.3 第 6 条） */
export type ExemptionKind = 'same-session-artifact' | 'temp-area' | 'trash-default'

/** 豁免判定——命中即免审批，但审计仍记录（免审批不等于不记录） */
export function evaluateExemption(
  req: EffectRequest,
  provenance: ProvenanceRegistry,
  tempAreaRoot: string,
): ExemptionKind | undefined {
  // 条款 1：本轮任务内本调用者创建的产物——写自己写过的文件（provenance 判定）
  if (req.type === 'fs.write'
    && provenance.isCreatedBy(req.caller, req.target, currentTaskId())) {
    return 'same-session-artifact'
  }
  // 条款 2：写入指定临时区（$DSH_HOME/.temp/）
  if (req.type === 'fs.write' && isInside(req.target, tempAreaRoot)) {
    return 'temp-area'
  }
  // 条款 3：回收站式删除是默认安全语义，低门槛放行
  if (req.type === 'fs.trash') {
    return 'trash-default'
  }
  // 用户明确指定的预授权在授权库 lookupGrant 中体现，不在此重复
  return undefined
}
```

**审批挂起——park/resume 一等阻塞状态**（对应 TeleAgent `needs_human` 阻塞语义的直接移植）：

```typescript
/** Fiber 挂起句柄——审批等待期间释放执行资源，会话可响应取消、新输入、其他子代理进度 */
export interface FiberParkHandle {
  /** park：挂起当前 fiber，等待审批结果 */
  park(): Promise<ApprovalDecision>
  /** resume：用户回复后回填结果，唤醒 fiber */
  resume(decision: ApprovalDecision): void
  /** cancel：会话关停/取消时以 timeout 语义唤醒（9.3 第 7 条：防 park 泄漏） */
  cancel(reason: string): void
}

/** 审批票据——一次待人类决策的效果请求 */
export interface ApprovalTicket {
  id: string
  request: EffectRequest
  fiber: FiberParkHandle
  createdAt: number
  /** 超时自动 deny——不可配置关闭 */
  timeoutMs: number
}

/** 审批服务——一等阻塞状态的管理者 */
export interface ApprovalService {
  /** 发起审批：立即返回 ticket，当前 fiber park */
  request(req: EffectRequest): ApprovalTicket
  /** 审批结果回填：唤醒 fiber */
  resolve(ticketId: string, decision: ApprovalDecision): void
  /** 授权记忆查询：once/object/class/预授权任一命中即免问 */
  lookupGrant(req: EffectRequest): ApprovalGrant | undefined
  recordGrant(grant: ApprovalGrant): void
  /** 会话结束：作废全部授权记忆 + cancel 全部 pending ticket */
  dispose(): void
}
```

效果处理器的审批流程统一改为：`豁免判定 → 授权记忆 lookup → 未命中则 request() 并 park → resume/超时 → 写审计`。等待期间 Fiber 释放、事件循环继续——这是对 R6/R7 的根治。

**实现载体（M0 裁定 1A，2026-09-30）**：`FiberParkHandle` 的 park/resume 语义保留不变，但实现**不落在 vendor/cordis Fiber**——M0 核查证实 `vendor/cordis/src/fiber.ts` 是插件生命周期原语（状态机 PENDING→LOADING→ACTIVE→UNLOADING→DISPOSED，无协程挂起原语，向其添加属范畴错误）。实现为 dsh 侧 **ApprovalGate 包装层**：park = 登记挂起点并返回 Promise；resume = waterfall listener resolve 回填；cancel/超时 = AbortSignal——dsh 既有 `packages/interaction/user-approval` 的 `approval/asked/decided` 审计对、waterfall 事件、signal 透传全部可直接复用；"等待期间会话可响应"由既有 idle/running 相位机承载。vendor 零改动；P5（fiber-info 诊断缺失：fiber.ts L585 FIXME + L52 TODO）解耦为独立小项，不随 S16。

#### 5.3.7 MCP 效果处理器（v3 新增）

v2 的效果类型只覆盖进程内四类，MCP 工具调用（进程外副作用）整层落在管控面之外（R9）。v3 增加 `mcp.call` 效果类型：

```typescript
// packages/runtime-control/src/effects/mcp.ts

/** MCP 效果处理器——把进程外工具调用纳入效果系统 */
export class McpEffectHandler implements EffectHandler {
  constructor(
    private mcpClient: McpClientAdapter,
    private approval: ApprovalService,
    private audit: (entry: EffectAuditEntry) => void,
  ) {}

  async handle(req: EffectRequest): Promise<EffectResult> {
    // req.target = 'serverName.toolName'
    // 1. 契约能力检查：McpCapability.servers / tools 模式匹配
    // 2. denyParamPatterns：参数模式黑名单（序列化后匹配）
    // 3. 审批：默认 ask；授权记忆（object=该工具、class=该 server）可豁免
    // 4. 执行：经 packages/mcp 的 client 适配层发起调用
    // 5. 审计：记 server/tool、参数摘要、结果摘要
    ...
  }
}
```

契约声明示例：

```yaml
- id: tool-browser-use
  name: '@deepseek-ai/dsh-tool-browser-use'
  contract:
    capabilities:
      mcp:
        servers: ['playwright-mcp']
        tools: ['playwright-mcp.*']
        denyParamPatterns: ['file://']
```

未声明 `mcp` 能力的插件在严格模式下调用被拒；lenient 模式降级为 warning（与其他能力过渡语义一致）。**诚实边界**：`mcp.call` 管住的是"发起了什么调用、带了什么参数"——server 进程内部行为不在协议观察面内。v4 通过 MCP 深度内建（5.8）把覆盖扩展到协议反向面、结果面、传输面、生命周期面；server 进程内 OS 级行为以沙箱档位压至最小环境（9.1 第 6、7 条，第 14 章）。

#### 5.3.8 数据外发检查（v3 新增）

v2 的 `net.fetch` 只按 URL 白名单检查，不区分"读外部信息"与"把本地数据发出去"（R10）。v3 给网络效果加**方向语义**：

```typescript
// packages/runtime-control/src/effects/exfiltration.ts

/** 数据外发检查——net 类效果的出站语义 */
export function checkExfiltration(
  req: EffectRequest,
  ceiling: number | undefined,   // NetworkCapability.maxOutboundBytes
  sensitiveScanners: Array<(data: unknown) => boolean>,
): 'pass' | 'blocked' | 'not-applicable' {
  const outbound = estimateOutboundBytes(req)   // 请求体大小
  if (outbound === 0) return 'not-applicable'   // 纯读式访问
  if (ceiling === undefined || ceiling === 0) {
    return 'blocked'   // 未声明出站能力 = 只允许读式网络访问
  }
  if (outbound > ceiling) {
    return 'blocked'   // 超出声明上限
  }
  for (const scan of sensitiveScanners) {       // credentials 字段、session 内容特征扫描
    if (scan(req.args)) return 'blocked'
  }
  return 'pass'
}
```

检查结果写入 `EffectAuditEntry.exfiltrationCheck`。这与 dsh 遥测的 FEEDBACK_ONLY 自觉模式对齐，但把"数据外发需授权"从**包内纪律**上升为**管控层强制**——对照 TeleAgent"本地处理、数据不上传"的数据主权原则。

---

### 5.4 机制 4：执行隔离域（Execution Realm）

#### 5.4.1 问题

即使有服务膜、能力令牌和效果系统，业务代码仍然可以：

```typescript
// 直接 import Node 原生模块
import { execSync } from 'node:child_process'
execSync('rm -rf /')

// 原型链污染
Object.defineProperty(Service.prototype, 'mode', { get: () => 'danger' })

// 全局对象篡改
;(global as any).__dshBypass = true
```

效果系统拦截的是"通过 effect.* 发起的副作用"，但如果代码绕过效果 API 直接调 Node 模块，效果系统无能为力。执行隔离域解决这个问题。

#### 5.4.2 方案

业务代码运行在受限的 VM realm 中，全局对象被替换为受限版本。这是**最强的隔离机制**，但也是**侵入性最高的**——不是所有插件都能跑在隔离域里。因此设计为**可选分级**：

```typescript
// packages/runtime-control/src/realm.ts

/** 隔离域安全级别 */
export type RealmLevel = 'none' | 'standard' | 'strict'

export interface RealmConfig {
  /** 安全级别 */
  level: RealmLevel
  /** 允许 import 的模块白名单 */
  moduleWhitelist: string[]
  /** 全局对象覆盖 */
  globalOverrides: Record<string, unknown>
  /** 是否冻结原型链 */
  freezePrototypes: boolean
  /** 是否禁止 eval/new Function */
  disableEval: boolean
}

/** 各级别的默认配置 */
export const REALM_LEVELS: Record<RealmLevel, RealmConfig> = {
  /** 无隔离——现有行为，直接在主 realm 运行 */
  none: {
    level: 'none',
    moduleWhitelist: ['*'],
    globalOverrides: {},
    freezePrototypes: false,
    disableEval: false,
  },
  /** 标准隔离——白名单模块 + 全局对象只读 */
  standard: {
    level: 'standard',
    moduleWhitelist: [
      // 白名单——安全模块
      'node:path', 'node:url', 'node:crypto',
      // dsh 内部包
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-*',
      // 禁止：node:fs, node:child_process, node:net 等（必须走效果系统）
    ],
    globalOverrides: {},
    freezePrototypes: true,
    disableEval: true,
  },
  /** 严格隔离——完全沙箱 */
  strict: {
    level: 'strict',
    moduleWhitelist: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-*',
    ],
    globalOverrides: {
      // 替换 process 为只读版本
      process: createReadOnlyProcess(),
      // 替换 require 为白名单版本
      require: createWhitelistedRequire(),
    },
    freezePrototypes: true,
    disableEval: true,
  },
}
```

#### 5.4.3 受控 require

```typescript
// packages/runtime-control/src/realm/controlled-require.ts

/** 创建白名单 require——只允许 import 白名单中的模块 */
export function createWhitelistedRequire(
  whitelist: string[],
  originalRequire: NodeRequire,
): NodeRequire {
  const wl = new Set(whitelist)
  const controlled: NodeRequire = ((specifier: string) => {
    // 通配符匹配
    const matched = wl.has(specifier)
      || [...wl].some(pattern => {
        if (pattern.endsWith('*')) {
          return specifier.startsWith(pattern.slice(0, -1))
        }
        return pattern === specifier
      })
    if (!matched) {
      throw new SecurityViolation(
        `模块导入被拒：'${specifier}' 不在白名单中`,
        { action: 'access-denied', property: specifier, reason: 'module-whitelist' },
      )
    }
    return originalRequire(specifier)
  }) as NodeRequire
  // 保持 require.resolve 行为
  controlled.resolve = originalRequire.resolve
  return controlled
}
```

#### 5.4.4 原型链冻结

```typescript
// packages/runtime-control/src/realm/freeze-prototypes.ts

/** 冻结关键原型链——防止原型污染攻击 */
export function freezeCriticalPrototypes(): void {
  const targets = [
    Object.prototype,
    Array.prototype,
    Function.prototype,
    Map.prototype,
    Set.prototype,
    Promise.prototype,
    Error.prototype,
    // Cordis 核心
    // Service.prototype,  // 需要确认 Cordis 是否允许冻结
  ]

  for (const proto of targets) {
    Object.freeze(proto)
    // 阻止 __proto__ 赋值
    Object.defineProperty(proto, '__proto__', {
      set() {
        throw new SecurityViolation(
          '禁止修改 __proto__',
          { action: 'write-denied', property: '__proto__', reason: 'prototype-frozen' },
        )
      },
      configurable: false,
    })
  }
}
```

#### 5.4.5 隔离域级别分配

```typescript
// packages/runtime-control/src/realm/assignment.ts

/** 根据插件信任等级和契约分配隔离域级别 */
export function assignRealmLevel(
  node: EffectiveNode,
  trustLevel: string,
): RealmLevel {
  // 无契约声明的插件——向后兼容，无隔离
  if (!node.contract) return 'none'

  // 有 capabilities 声明的插件——至少标准隔离
  if (node.contract.capabilities) return 'standard'

  // preset/session 平面的插件——标准隔离
  if (node.contract.plane !== 'host') return 'standard'

  // host 平面 + trusted 信任等级——可以无隔离（向后兼容）
  if (trustLevel === 'trusted') return 'none'

  // 其余——标准隔离
  return 'standard'
}
```

> **设计决策**：隔离域级别不自动设为 `strict`，因为严格隔离会破坏大多数现有插件的行为（它们直接 import `node:fs` 等）。`strict` 需要人工逐个评估后指定。迁移策略是：先从 `none` → `standard`（白名单 import），再视情况 → `strict`（完全沙箱）。

---

### 5.5 运行时违规处理

```typescript
// packages/runtime-control/src/violation.ts

/** 运行时违规处理策略（v3：新增 isolate 档） */
export type ViolationPolicy = 'throw' | 'log' | 'log-and-throw' | 'isolate'

export interface ViolationHandler {
  /** 处理运行时安全违规 */
  handle(violation: SecurityViolation, context: ViolationContext): void
}

export interface ViolationContext {
  /** 违规发生的插件 id */
  pluginId: string
  /** 违规类型 */
  type: 'membrane' | 'capability' | 'effect' | 'realm'
  /** 调用栈 */
  stack?: string
  /** 审计条目 */
  auditEntry: MembraneAuditEntry | EffectAuditEntry
}

/** 默认违规处理器——记录审计 + 抛出 */
export class DefaultViolationHandler implements ViolationHandler {
  constructor(
    private audit: (entry: AuditEntry) => void,
    private policy: ViolationPolicy = 'log-and-throw',
  ) {}

  handle(violation: SecurityViolation, context: ViolationContext): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      action: 'security-violation',
      layer: context.pluginId,
      file: '',
      rowId: context.pluginId,
      field: context.auditEntry.property,
      oldValue: undefined,
      newValue: context.auditEntry.attemptedValue,
      securityVerdict: 'deny',
      securityReason: `[${context.type}] ${violation.message}`,
    }
    this.audit(entry)

    if (this.policy === 'throw' || this.policy === 'log-and-throw') {
      throw violation
    }
  }
}
```

`isolate` 档（v3 新增）——违规不再等于进程级异常。对长驻 agent 进程，一个第三方插件的违规不应拖垮整个会话（R12）：

```typescript
/** 隔离式违规处理器——撤销令牌 + 卸载插件 + 审计，进程与其余插件存活 */
export class IsolateViolationHandler implements ViolationHandler {
  constructor(
    private audit: (entry: AuditEntry) => void,
    private runtime: RuntimeController,
  ) {}

  handle(violation: SecurityViolation, context: ViolationContext): void {
    // 1. 撤销该插件全部令牌（含 fiber 派生令牌，见 5.2.5）
    this.runtime.revokePlugin(context.pluginId)
    // 2. 卸载该插件——经 Cordis unmount 触发其清理逻辑
    this.runtime.isolatePlugin(context.pluginId, violation)
    // 3. 审计记录隔离原因——可回顾、可申诉
    // 4. 向调用方抛 PluginIsolatedError：可感知、可捕获，但非进程级异常
    throw new PluginIsolatedError(context.pluginId, violation, context.auditEntry)
  }
}

export class PluginIsolatedError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly cause: SecurityViolation,
    public readonly auditEntry: MembraneAuditEntry | EffectAuditEntry,
  ) {
    super(`插件 ${pluginId} 已被隔离：${cause.message}`)
    this.name = 'PluginIsolatedError'
  }
}
```

isolate 的配套纪律：每次隔离同时产出 warning 级 post-hoc 报告（见 5.6）；同一插件累计隔离达到阈值（默认 2 次）自动升级为装配期禁用——写回 patch 层 `disabled` 并进入人工审查，而不是陷入"隔离-重启"循环（9.3 第 8 条）。

### 5.6 会话收尾自检（Post-hoc Review）（v3 新增）

对照 TeleAgent"每轮结束前强制工作目录全量自检"的纪律，v3 把审计链从"只写不回顾的台账"升级为**带收尾清算的闭环**——这也是 `--lenient-capabilities` 过渡期的系统性兜底：宽松模式运行时放过，收尾时统一清算：

```typescript
// packages/runtime-control/src/post-hoc.ts

/** 会话/插件生命周期结束时的越界回顾 */
export interface PostHocReview {
  scope: { pluginId?: string; sessionId?: string; taskId?: string }
  /** 本周期内全部效果调用（含豁免/自动批准的） */
  effects: EffectAuditEntry[]
  /** 契约声明的能力面（无契约 = undefined） */
  declaredCapabilities: CapabilityDeclaration | undefined
  /** 发现的越界行为 */
  findings: Array<{
    effect: EffectAuditEntry
    issue: 'undeclared-capability' | 'capability-exceeded' | 'artifact-unmarked'
  }>
}

export function runPostHocReview(scope: ReviewScope, auditLog: AuditLog): PostHocReview {
  // 1. 汇总本生命周期全部效果调用
  // 2. 与契约 capabilities 对比：
  //    - 未声明能力而发起效果      → undeclared-capability（error 级）
  //    - 声明了但超出模式/上限范围  → capability-exceeded（error 级）
  //    - fs.write 未标 artifact    → artifact-unmarked（warning 级，缺省按 final 处理）
  // 3. 写入审计（action: 'post-hoc-audit'），产出结构化报告
}
```

触发时机：插件 unmount、会话结束、任务收口三者任一发生即执行对应 scope 的回顾。lenient 模式下这是**唯一的系统性清算点**——运行时放过的每一笔都会在收尾报告里点名。

### 5.7 并发子代理与写冲突控制（v3 新增）

对照 TeleAgent 并行子代理"文件边界互不冲突"的分派纪律。dsh 的 subagent 有 spawn/fork 两种 provider，同一插件在多个 fiber 中运行——v3 用两个机制把并行安全落到效果系统：

**机制一：fiber 粒度令牌**（5.2.5 的派生令牌）——每个子代理持独立令牌，`revokeFiber(pluginId, fiberId)` 撤销单个子代理不影响兄弟 fiber；单个子代理违规时配合 isolate 档可精确摘除。

**机制二：按目标的写锁**——同一文件路径的写效果串行化，不同路径并行：

```typescript
// packages/runtime-control/src/write-lock.ts

/** 按目标的写锁——同一 target 的写效果串行，不同 target 并行 */
export class EffectWriteLock {
  private locks = new Map<string, Promise<unknown>>()

  async withLock<T>(target: string, effect: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(target) ?? Promise.resolve()
    const run = previous.then(effect, effect)
    this.locks.set(target, run)
    try {
      return await run
    } finally {
      if (this.locks.get(target) === run) this.locks.delete(target)
    }
  }
}
```

适用于 `fs.write`/`fs.trash`/`fs.delete-permanent`/`env.set`；`fs.read` 不加锁（读不互斥）。锁粒度是**效果目标**（realpath 规范化后的绝对路径），不是插件——两个不同插件写同一文件同样串行，防止并行子代理写同一文件时内容交错损坏（验收 R23）。

### 5.8 MCP 深度内建管控（v4 新增）

v3 的 MCP 覆盖只有调用面（5.3.7），且 `McpEffectHandler` 是"经 packages/mcp 的 client 适配层"发起调用——业务包仍可直接 `import` packages/mcp 持有连接绕过效果系统（9.3 第 5 条在 MCP 上的具体体现）。v4 把 MCP 能力内建到运行时管控层，实现**通道唯一化 + 五面覆盖 + server 进程沙箱档位**。

#### 5.8.1 通道唯一化：client 收归管控层

**MCP 连接的持有权从业务层收归运行时管控层**：`McpRuntime` 是唯一持有 MCP 连接的组件，业务插件只能经 `effect.mcp.call` 触达；配合 S13 隔离域模块白名单（standard/strict 档不给业务包 import `packages/mcp` 的权限）。"MCP 调用必然经过管控"从纪律变为结构——设计层面保证优先于实现层面兜底。

```typescript
// packages/runtime-control/src/mcp/runtime.ts

/** MCP 运行时——唯一持有 MCP 连接的组件（v4 新增） */
export class McpRuntime {
  private servers = new Map<string, ManagedServer>()

  constructor(
    private plan: AssemblyPlan,
    private effects: EffectDispatcher,
    private approval: ApprovalService,
    private audit: (entry: EffectAuditEntry) => void,
  ) {}

  /** server 进程注册：spawn 参数、归属插件、沙箱档位（见 5.8.5） */
  registerServer(binding: McpServerBinding): void
  /** 工具调用唯一入口——业务只能经 effect.mcp.call 到达这里 */
  callTool(caller: string, server: string, tool: string, args: unknown): Promise<unknown>
  /** server → client 反向请求处理（sampling/roots/elicitation，见 5.8.3） */
  handleInbound(request: InboundRequest): Promise<unknown>
  /** isolate 联动：kill 归属插件的全部 server 进程（见 5.8.6） */
  killServersOf(pluginId: string): void
  /** 会话收尾：孤儿 server 清理 */
  dispose(): void
}

/** server 进程绑定——生命周期与归属插件绑定 */
export interface McpServerBinding {
  id: string
  /** 归属插件——isolate 时联动 kill */
  ownerPlugin: string
  /** 沙箱档位（5.8.5） */
  realm: 'mcp-trusted' | 'mcp-signed' | 'mcp-unknown'
  /** spawn 参数：最小 env（剥离全部凭证）、限定 cwd */
  spawn: { command: string; args: string[]; env: string[]; cwd: string }
  /** 传输方式：stdio | streamable-http */
  transport: 'stdio' | 'streamable-http'
}
```

#### 5.8.2 五面覆盖

| 管控面 | v3 现状 | v4 内建后 |
|--------|---------|-----------|
| 调用面 | server/tool/参数白名单（5.3.7） | 保持，且成为唯一通道（5.8.1） |
| 协议反向面 | 完全开放——真实越权通道 | sampling/roots/elicitation 全部效果化（5.8.3） |
| 结果面 | 仅审计摘要 | 敏感扫描 + 大小预算 + 去向追踪 + 结构化优先（5.8.4） |
| 传输/进程面 | 无 | 最小 env + 限定 cwd + 出站过 net 白名单（5.8.5） |
| 生命周期面 | 无——isolate 后 server 进程仍存活（v3 残留洞） | spawn/kill 归属绑定 + isolate 联动 + 孤儿清理（5.8.6） |

#### 5.8.3 反向请求效果化

MCP 是**双向协议**。v3 只覆盖正向；server → client 的反向请求是真实越权通道，其中 **sampling 是一条完整外发链**：恶意/被注入 server 借宿主 LLM 凭证发起任意 prompt → LLM 在宿主上下文执行 → 结果回传 server → server 经工具结果带出。v4 把三类反向请求全部效果化（`EffectType` 新增 `mcp.sampling-request` / `mcp.roots-request` / `mcp.elicitation-request`，契约扩展见 4.1.1 `McpCapability`）：

```typescript
// packages/runtime-control/src/mcp/inbound.ts

/** server → client 反向请求的效果化处理（v4 新增） */
export class InboundRequestHandler {
  constructor(
    private plan: AssemblyPlan,
    private approval: ApprovalService,
    private exfiltration: ExfiltrationChecker,
    private audit: (entry: EffectAuditEntry) => void,
  ) {}

  async handleSampling(from: string, request: SamplingRequest): Promise<SamplingResult> {
    // 1. 契约检查：归属插件的 McpCapability.sampling 未声明 → deny
    // 2. 模型白名单（sampling.models）与 maxTokens 预算强制
    // 3. prompt 内容敏感扫描（credentials 特征）
    // 4. 执行 LLM 采样（走宿主 llm 服务，token 计入预算）
    // 5. 结果回传给 server 前：过 exfiltration 检查——
    //    堵"借宿主 LLM 之名，行数据外发之实"的完整链路
  }

  async handleRoots(from: string): Promise<string[]> {
    // 返回集合 ⊆ sandbox workspaceRoot ∩ McpCapability.roots 声明
    // —— server 请求暴露文件系统根，按 sandbox 策略收窄
  }

  async handleElicitation(from: string, request: ElicitationRequest): Promise<unknown> {
    // 未声明 elicitation → deny；声明则纳入审批流，
    // 审批 UI 强制标注来源（"来自 MCP server X"）——防钓鱼式收集
  }
}
```

**sampling 处理纪律**（越权链的逐环拦截）：未声明能力即拒 → prompt 敏感扫描 → 模型/token 预算强制 → **结果回传前过 exfiltration 检查**（与 5.3.8 联动）。

**M0 调研修正（2026-09-30，裁定 5A——接受上探）**：dsh 现状 `mcp-client` 的 `Client` 构造 `capabilities: {}` 为空、全 src 无 `setRequestHandler`——**反向请求通道当前完全未接线**。S19 因此从"效果化改造"上探为**从零接线**：capabilities 声明 + setRequestHandler 三型回调 + 每型入 `EffectType`。对冲事实：该攻击面现状为零（client 不宣告能力，server 无从发起反向请求），上探不构成安全缺口扩大，只是工作量上探一档。

#### 5.8.4 结果面管控

工具结果进入会话上下文之前：

1. **敏感特征扫描**：密钥/凭证模式 → 标记或拦截（`EffectAuditEntry` 记录扫描结果）
2. **大小预算**：结果超上限截断或拒绝——防资源耗尽
3. **去向追踪**：进 LLM 上下文 vs 直接写文件——两种去向策略不同
4. **结构化输出优先**：要求 server 结果走 schema 而非自由文本——把"文本里藏指令"从语义问题变成 schema 校验（可判定）。这是第 14 章路线 1（收窄程序类）在结果面的落点，也是 L3 语义注入的第一道缓解

#### 5.8.5 server 进程沙箱档位

`realm` 体系扩展出 mcp-server 专属档位（三档）：

| 档位 | 适用来源 | OS 沙箱配置 |
|------|---------|------------|
| `mcp-trusted` | 仓库内/已验证 server | 标准沙箱：路径绑定 + syscall 白名单 + 资源限额 + 网络禁 |
| `mcp-signed` | 签名第三方 server | 同上 + 结果扫描加严 + sampling 默认拒绝 |
| `mcp-unknown` | 未知来源 | 默认全禁；或仅 dry-run 档（只读协议观察，零权限） |

**三平台机制**（诚实边界见 9.1 第 7 条、第 14 章）：

- **Linux**（M0 修订，2026-09-30）：复用 `sandbox-local` 既有链 `bwrap` → `landlock`（native 启动器已落地，raw UAPI）——三平台中最强且无 deprecated 风险；seccomp-bpf / cgroup 为可选增强、**默认不引入**（新增机制 = 新攻击面，按 5.11.1 增量准入论证后再议）
- **macOS**（M0 确认）：复用 `sandbox-local` 既有 `seatbelt` 链；Apple 已标记 deprecated 且无公开替代——配置语言易错，档位模板化 + 逃逸用例回归（9.3 第 9 条）；**降级预案**：macOS 侧 mcp-unknown 档直接全禁、不降级弱沙箱，OS 若移除 seatbelt 则全档位全禁（登记为已接受 + 预案）
- **Windows**（M0 修订）：复用 `sandbox-windows-acl` 既有链（WRITE_RESTRICTED token + Low integrity + DACL，经 koffi FFI 调 advapi32）——AppContainer 配置成本高（需显式排除命名管道/剪贴板/注册表键；Codex 评估先例弃用：更适合预先知道全部资源需求的单一应用），列为 mcp-signed 档的**可选上探**，默认不启用
- **沙箱挂载点**（M0 精确化）：MCP server 进程由 MCP SDK 直接 spawn（`mcp-client/src/transport.ts:31–45`，现状不经 `ctx.sandbox`）——挂载点定在 `createTransport`：server 的 `command/args` 经 `ctx.sandbox.confine(argv, policy)` 包裹后交给 `StdioClientTransport`
- **通用兜底**（全部档位）：最小 env（剥离 `DEEPSEEK_API_KEY` 等全部凭证）、限定 cwd、stdin/stdout 管道之外无 fd
- **StreamableHTTP 传输**：出站连接过 `net.*` 效果的 URL 白名单 + exfiltration 检查（5.3.8 自然延伸）
- **OS 原语桥评估**（2026-09-30 登记）：三平台机制承重结构的 native 化候选（P1 Windows FFI 类型化绑定 / P2 进程树生命周期 / P4 seccomp 条件项 / P5 sandbox-exec 替代条件项）与置信度升级路径见第 17 章——M4 批次 4b 裁定项，未裁定前维持既有链

#### 5.8.6 生命周期绑定

- **isolate 联动**：隔离插件时 kill 其全部归属 server——堵住"插件隔离了、它拉起的 server 进程还在后台跑"的 v3 残留洞
- **会话收尾**：孤儿 server 清理，与 5.6 post-hoc 回顾联动
- **审计**：server spawn/kill/重启全记录（action: 'mcp-server-lifecycle'）

### 5.9 skill 面管控（v4 增补）

**核心洞察：skill 的一切"能力"都是借的。** skill 不能自己执行任何东西——它引导 LLM，LLM 调用工具，工具的每个副作用都走宿主效果系统。想写文件走 `fs.write`、执行脚本走 `proc.spawn`、外发数据过 exfiltration 检查。**只要唯一通道成立（5.8.1、S13），skill 没有任何绕过效果系统的执行路径**——这是 skill 与 MCP server 的本质区别：server 是独立进程（有自己的手），skill 只是文字（只能借宿主的手，而宿主的手在效果系统的判定点后面）。因此 skill 的风险面不在执行，在指令语义。

#### 5.9.1 三面归属

| skill 面 | 行为 | 管控机制 | 归属 |
|---------|------|---------|------|
| 装载面 | skill-filesystem 扫描目录、加载清单 | 插件自身能力令牌（fs.read 白名单）+ 来源信任分级 | 运行时管控层（已有） |
| 资源面 | LLM 读 skill 附带文件、经工具执行动作（含脚本/命令——M0 修正：dsh skill 执行体为纯 Markdown 指令，一切"执行"均为 LLM 借宿主工具发生的宿主侧副作用） | `fs.read` / `proc.spawn` 效果——照常过沙箱 + 审批 + 预算 | 运行时管控层（已有） |
| 指令面 | SKILL.md 内容注入 LLM 上下文，引导 LLM 行为 | 装载期静态扫描 + SkillManifest + taint | L3 缓解栈（14.4 同构），可前移 |

#### 5.9.2 SkillManifest 契约

与 `PluginContract` / `McpCapability` 同构——一切资源接入先声明能力面：

```yaml
# skill manifest 示例
id: docx-creation
trust: signed            # trusted | signed | unknown（与 5.8.5 沙箱档位统一）
capabilities:            # 本 skill 引导 LLM 使用的效果面
  fs: { read: ['**'], write: ['**/*.docx'] }
  proc: { allow: ['pandoc'] }
  net: { allow: [] }     # 声明为空 = 本 skill 不应引导网络效果
```

未声明 manifest 的 skill 视为 `trust: unknown`，默认不装载（lenient 模式降级 warning）。来源三级（trusted/signed/unknown）与 5.8.5 沙箱档位共用同一信任体系——全系统一份信任分级，不做第二套。

#### 5.9.3 装载期全量静态扫描

skill 是装载期就存在的**静态资产**，不是运行时动态生成的——因此 L3 缓解可前移（MCP 结果只能逐次扫描，skill 可一次性全量）：

1. **越权指令模式扫描**：教 LLM"绕过审批""直接用 child_process""忽略 sandbox"等措辞模式 → error/warning 级诊断（复用 4.2.1 诊断框架）
2. **敏感内容特征**：credentials 模式、可疑外发 URL → 标记
3. **manifest 与指令一致性**：扫描出的引导动作应落在 manifest 声明内（声明 `net: []` 但指令教 LLM fetch → `skill-manifest-mismatch`）

#### 5.9.4 运行期效果归因联动

激活 skill 期间 LLM 发起的每个效果，与当前 skill manifest 比对：

- 声明外效果 → `skill-capability-exceeded` 诊断（默认 warning 强制审计；可配置为拦截）
- 归因链写入审计：`{effect, caller: pluginId#fiberId, activeSkill: skillId}`——"哪个 skill 引导了哪个效果"成为一等审计维度
- **taint 传递**：skill 来源（trust 级）随指令进入 LLM 上下文标记，从 taint 上下文导出的高敏感效果审批自动升级（14.4 第四重缓解）

### 5.10 宿主 root 与 CLI 面（v4 增补）

#### 5.10.1 CLI 三面归属

CLI 启动参数发生在装载期**之前**——它不是运行时行为，是装配控制层的输入，v4 已有机制恰好覆盖：

| CLI 面 | 管控机制 | 归属 |
|--------|---------|------|
| 启动面（argv/env/`--patch`/flags） | `--patch` 信任等级（4.3.1）、敏感覆盖保护（4.3.3）、env 白名单求值（4.3.2） | 装配控制层（已有） |
| 运行面（CLI 子命令运行期触发的操作） | 效果系统 + 审计（root 调用者，5.10.2） | 运行时管控层 |
| 自举面（CLI/宿主自身的完整性） | **无——结构性限制** | 架构外缓解（14.5 L4） |

#### 5.10.2 root 调用者登记

v4 效果系统按"调用者 = 插件 id"建模，但 CLI 子命令是宿主 root 自己在执行。把宿主登记为显式调用者：

```typescript
// packages/runtime-control/src/effect.ts

/** 宿主 root 调用者——审计完整性的登记，不是自我约束 */
export const ROOT_CALLER = 'dsh-root' as const

// 效果请求的 caller 允许 'dsh-root'：root 级能力（不受插件能力上限约束），
// 但全部副作用照常写审计链——CLI 运行面的每笔操作可回溯，
// 且收尾自检（5.6 post-hoc）对 root 同样生效。
```

**诚实定性**：这是"可监控"而非"被约束"——root 是约束的实施者，不是被约束方。它进效果系统是为了审计完整性，不是自我限制（验收 R37）。

#### 5.10.3 自举限制登记（L4）

运行时管控层运行在 CLI 启动的进程内——**不可能约束自己的启动者**（谁管管理者）。该残余不做任何"层内假装覆盖"，登记为 14.5 L4，靠架构外手段缓解：

- **分发完整性**：安装包/二进制签名链（CLI 分发签名校验）
- **参数合法性**：非法 flags 组合由装配控制层装载期拒绝（启动面）
- **管控层自身完整性**：runtime-control 代码签名——管控层自身被篡改属架构外威胁模型，如实登记

### 5.11 元层纪律与治理条款（v4 增补，LangQuanta DesignV4 借鉴）

本节把 LangQuanta DesignV4（`D:\systool\LangQuantaPro\DesignV4`）中已经过"提案→独立复核→裁定→落地"流程验证的工程纪律，翻译为本架构的治理条款。借鉴的不是哲学层（14.6 同构表已对齐），而是**可执行的纪律形态**——对照清单 10 条中采纳 9 条，2 条不适用（M-layer 数学基底、公理 RFC 全流程，见第 15 章增补记录）。

#### 5.11.1 增量准入纪律（LangQuanta C8 移植）

新增效果类型、能力域、豁免通道、审批档位、诊断码的**唯一准入条件 = 携带信任语义**（可被授予 / 可被冒充 / 可破坏一致性）。纯工程机制（审计视图、报告格式、CLI 子命令）以数据字段、契约登记段承载，零新判定面。每条增量必须附信任论证，或显式声明"零信任语义、以既有形态承载"。这是 9.3 第 2/6 条（防膨胀）的**正面准入对偶**。

#### 5.11.2 No-Löb：管控层不自我豁免（C10/§1.18.3 移植）

**本节最高价值条款**。管控层自身也是代码——被注入后可以给自己颁发授权记忆、把自身路径登记进豁免。LangQuanta 把这种形态命名为"可证即真"元公理并禁绝；本架构的翻译：

- `ROOT_CALLER` 与管控层内部调用者，在授权登记与豁免判定入口处**硬编码排除**；
- 审批服务的 grant 不可被颁发者自己消费；
- 豁免判定不可引用自己产生的 provenance 记录为自己作证；
- **元层记账（审计照写）永不升级为对象层豁免**。

自指分区（C9 移植）：管控层的自指只允许"元型"（记账/审计），禁止"悖论型"（自授权/自豁免）。

```typescript
// packages/runtime-control/src/meta/no-lob.ts

/** No-Löb 条款：元层调用者永不进入授权与豁免通道（5.11.2） */
export const META_CALLERS: ReadonlySet<string> = new Set([
  ROOT_CALLER,           // 'dsh-root'（5.10.2）
  'runtime-control',     // 管控层内部（哨兵/重算器/审计写入）
])

/** 授权登记与豁免判定入口的硬排除 */
export function assertNotMetaCaller(caller: string, action: string): void {
  if (META_CALLERS.has(caller)) {
    throw new SecurityViolation(
      `No-Löb：元层调用者 '${caller}' 不可登记授权/豁免（元记账 ≠ 对象层豁免，动作 ${action}）`,
      { action: 'write-denied', property: action, reason: 'no-lob' },
    )
  }
}
```

判定：[T1]——root 调用者请求 `recordGrant` / `evaluateExemption` 被拒（验收 R39）。

#### 5.11.3 审计一致性哨兵与通道冻结（K15 移植）

isolate（5.5）摘除的是**行为者**；另一类故障是**元数据矛盾**——授权库与审计链对不上（同一效果既 allow 又 deny、豁免放行但契约排除）。这类故障摘谁都不对，正确动作沿 K15 的"冻结 + 不自动改判"：

- 触发：授权库记录与审计统计对不上、同目标效果双判定、豁免命中与契约声明矛盾；
- 处置：**冻结**相关豁免通道/授权记忆（降级为全审批）+ 告警 + 登记，**不自动改判**——豁免规则本身权威不动，矛盾交人工裁定；
- 定性（1.18.5 哥德尔第二边界移植）：哨兵是矛盾实例的**检测器**，不是一致性的**证明**——哨兵全绿不蕴含无矛盾。
- 判定：[T1]——构造授权库与审计链矛盾的注入测试（验收 R40）。

冻结与 isolate 正交：isolate 管行为者，冻结管通道；不新增 ViolationPolicy 档。

#### 5.11.4 审计台账互指键（A6 唯一载体移植）

`EffectAuditEntry` 补 `assemblyPlanId` 字段；装配审计与效果审计两本账通过 planId 互指（沿 LangQuanta Trajectory 与 EvidenceLog 的 promoted 事件互指先例）。5.6 收尾自检据此重建"哪个装配计划下的哪些效果"，三态披露（5.11.7）据此挂基线指纹。

#### 5.11.5 判据独立重算器（.lqproof/§1.7 移植）

14.3 路线 2（PCC，对生态太重）与路线 3（监控，管不到判定器自身）之间的中间档：

- **独立实现的最小检查器**：只含权限矩阵 + 豁免规则重算，不含膜/域/MCP——规模远小于 runtime-control，可被独立人工审阅；
- 定期或敏感场景重算审批决策样本：一致 ⇒ 审计记 `cross_checked`（增强信心，无语义后果）；不一致 ⇒ 冻结 + 不自动改判（5.11.3 同处置）；
- **复核器非第二判据**：不改变效果系统的唯一判定地位；
- 同时是 14.5 L4（管控层自身完整性）在架构内的唯一可行缓解。
- 判定：[T1]——注入故意不一致的重算结果 ⇒ 冻结（验收 R42）。

#### 5.11.6 诊断码位登记表（一码一规则）

每条 `Diagnostic` 分配唯一码位 SEC-xxxx，一码一规则；登记表记码位/规则/触发面/证据档。新增机制优先复用既有码位（码位零新增论证：不触碰信任授予通道新形态 ⇒ 复用）——预防 LangQuanta K101–K105 码位冲突事故的重演。既有规则回溯建档（第 11 章前置）。

#### 5.11.7 三态披露与基线指纹（§1.6.4 移植）

效果审计对外报告固定格式：**放行 / 拦截 / 豁免**分列统计 + 基线指纹（assemblyPlanId + 信任策略指纹）。审批超时 deny 与用户拒绝 deny 分列——超时是元记账，不等于用户判定该拒（LangQuanta `abandoned ≠ refuted` 同构：找不到 ≠ 不可证）。

#### 5.11.8 管控层复杂度红线（红线预算移植）

runtime-control 判定核心（膜拦截、令牌检查、效果判定主路径）设**逻辑行红线**（剔除注释+空行口径，复测脚本固化入 CI），超线触发枪毙重设计——防止管控层自己长成不可审计的怪物。这是 9.3 第 1 条（防堆积层）的量化版；基线数字开工实测后由用户裁定追认（无实测不给数字）。

#### 5.11.9 变更裁定流程（提案→复核→裁定→落地）

白名单条目、敏感路径、豁免通道、能力上限的变更流程形式化：

1. **提案**（登记理由与评审记录）→ 2. **独立复核**（独立子代理，非起草者自检）→ 3. **裁定**（用户确认）→ 4. **落地登记**。

裁定通过 ≠ 登记生效；候选在落地前不进登记表。强化 9.3 第 2/6 条。

---

## 6. 两层协作的完整管线

### 6.1 启动时序

```
  1. 解析多层 patch 源文件
  2. 展开有效配置（覆盖链合并 + !!js 受限求值）
  3. 构建装配依赖图
  4. 静态校验（12+1 条规则）
  5. 安全检查（信任源 + 敏感覆盖保护）
  6. 能力令牌预颁发（根据契约 + 能力声明）
  7. 产出装配计划（AssemblyPlan + CapabilityGrantPlan）
  ──────── 装配控制层完成，移交运行时管控层 ────────
  8. 为每个待挂载插件分配隔离域级别
  9. 冻结原型链（如果隔离域级别 ≥ standard）
  10. 逐行挂载：
      a. 动态校验（依赖可达性 + 重复注册 + isolate 遮蔽）
      b. 安装服务膜（为 ctx.get 注入膜）
      c. 颁发能力令牌（根据预颁发计划）
      d. 创建效果 API（注入受控 effect 对象）
      e. 执行插件 apply(ctx)——在指定隔离域中
  11. 运行期：所有服务访问经膜 + 令牌，所有副作用经效果系统
      · 审批：豁免判定 → 授权记忆 lookup → 未命中则 park，用户回复/超时后 resume（5.3.6）
      · fiber 创建：从插件级令牌派生 fiber 级令牌（5.2.5）
      · 并发写：同目标写效果经写锁串行化（5.7）
  12. 运行期违规：违规处理器记录审计 + 抛出/降级/隔离（isolate 档进程存活，5.5）
  13. 卸载/收尾时：撤销令牌 + 记录审计 + 清理膜 + 越界回顾 post-hoc review（5.6）
```

### 6.2 运行时数据流

```
  业务代码                         运行时管控层                    Cordis 内核
     │                                │                              │
     │── ctx.inject(['sandbox'], cb) ─→│                              │
     │                                │── 颁发 Cap[sandbox]          │
     │                                │   (methods: ['check'],       │
     │                                │    props: ['mode'])          │
     │                                │                              │
     │── cap.get('mode') ─────────────→│── 膜检查 + 令牌检查         │
     │←── 返回值 ──────────────────────│                              │
     │                                │                              │
     │── cap.call('check', ...) ──────→│── 膜检查 + 令牌检查         │
     │←── 返回值 ──────────────────────│                              │
     │                                │                              │
     │── effect.fs.write(path, data) ─→│── sandbox 策略检查          │
     │                                │── approval 审批检查          │
     │                                │── 执行 node:fs.writeFile     │
     │                                │── 记录效果审计               │
     │←── ok / SecurityViolation ─────│                              │
     │                                │                              │
     │── import 'node:child_process' ─→│── 隔离域白名单检查          │
     │←── SecurityViolation ──────────│   (standard/strict 级别)    │
     │                                │                              │
     │── effect.fs.write(p, d, opts) →│── 豁免判定（本轮产物/临时区/  │
     │                                │   trash-default）            │
     │                                │── 授权记忆 lookup            │
     │                                │── 未命中 → fiber park         │
     │←─（等待用户，fiber 已释放）────│   用户回复/超时 → resume      │
     │←── ok / SecurityViolation ─────│── 写审计（grantId/exemption）│
```

---

## 7. 文件级设计

### 7.1 包结构

```
packages/assembly/                    # 装配控制层
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                     # 对外入口
│   ├── contract.ts                  # PluginContract + CapabilityDeclaration 类型
│   ├── resolver.ts                  # 有效配置展开器
│   ├── plan.ts                      # AssemblyPlan + CapabilityGrantPlan 类型
│   ├── pipeline.ts                  # 装配管线（四段式编排）
│   │
│   ├── validators/
│   │   ├── static.ts                # 静态校验规则集（12+1 条）
│   │   ├── dynamic.ts               # 动态校验规则集
│   │   ├── capability-claim.ts      # 能力越界校验
│   │   └── types.ts                 # Diagnostic/ValidationResult 类型
│   │
│   ├── security/
│   │   ├── trust.ts                 # 插件信任源策略
│   │   ├── safe-eval.ts             # !!js 白名单求值器
│   │   ├── sensitive.ts             # 敏感配置覆盖保护
│   │   └── audit.ts                 # 审计链
│   │
│   └── cli/
│       ├── expand.ts                # dsh config --expand
│       ├── dry-run.ts              # dsh config --dry-run
│       └── capabilities.ts         # dsh config --capabilities（v2 新增）
│
└── tests/
    ├── contract.spec.ts
    ├── resolver.spec.ts
    ├── static-validators.spec.ts
    ├── dynamic-validators.spec.ts
    ├── safe-eval.spec.ts
    ├── sensitive-override.spec.ts
    ├── capability-claim.spec.ts     # v2 新增
    └── audit.spec.ts

packages/runtime-control/            # 运行时管控层（v2 新增）
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                     # 对外入口
│   ├── membrane.ts                  # 服务膜
│   ├── membrane-config.ts           # 膜配置注册表
│   ├── capability.ts                # 能力令牌 Cap[T]
│   ├── issuer.ts                    # 令牌预颁发器
│   ├── effect.ts                    # 效果系统核心类型
│   ├── violation.ts                 # 运行时违规处理（v3：含 isolate 档）
│   ├── post-hoc.ts                  # 会话收尾自检（v3 新增）
│   ├── write-lock.ts                # 按目标写锁（v3 新增）
│   │
│   ├── effects/
│   │   ├── handlers.ts              # 各效果类型处理器
│   │   ├── approval.ts              # 审批服务：park/resume + 三档授权 + 豁免（v3 新增）
│   │   ├── exfiltration.ts          # 数据外发检查（v3 新增）
│   │   ├── mcp.ts                   # MCP 效果处理器（v3 新增；v4 起为 McpRuntime 薄转发）
│   │   └── api.ts                   # 暴露给业务代码的 EffectApi
│   │
│   ├── mcp/                         # MCP 深度内建（v4 新增）
│   │   ├── runtime.ts               # McpRuntime：唯一 MCP 连接持有者（5.8.1）
│   │   ├── inbound.ts               # 反向请求处理（sampling/roots/elicitation，5.8.3）
│   │   ├── binding.ts               # McpServerBinding 与生命周期绑定（5.8.6）
│   │   └── sandbox-profiles.ts      # 三平台沙箱档位模板与逃逸用例（5.8.5）
│   │
│   ├── skill/                       # skill 面管控（v4 增补）
│   │   ├── manifest.ts              # SkillManifest 类型与校验（5.9.2）
│   │   ├── scan.ts                  # 装载期越权指令模式扫描（5.9.3）
│   │   └── attribution.ts           # 运行期效果归因比对（5.9.4）
│   │
│   ├── meta/                        # 元层纪律（v4 增补，LangQuanta 借鉴）
│   │   ├── no-lob.ts                # No-Löb 排除：元调用者不进授权/豁免（5.11.2）
│   │   ├── sentinel.ts              # 审计一致性哨兵与通道冻结（5.11.3）
│   │   └── recheck.ts               # 判据独立重算器（5.11.5）
│   │
│   ├── realm/
│   │   ├── realm.ts                 # 执行隔离域
│   │   ├── controlled-require.ts    # 白名单 require
│   │   ├── freeze-prototypes.ts     # 原型链冻结
│   │   └── assignment.ts           # 隔离域级别分配
│   │
│   └── integration.ts              # 与 Cordis Context 集成
│
└── tests/
    ├── membrane.spec.ts
    ├── capability.spec.ts
    ├── effect-fs.spec.ts
    ├── effect-net.spec.ts
    ├── effect-proc.spec.ts
    ├── effect-mcp.spec.ts           # v3 新增
    ├── approval.spec.ts             # v3 新增
    ├── exfiltration.spec.ts         # v3 新增
    ├── post-hoc.spec.ts             # v3 新增
    ├── write-lock.spec.ts           # v3 新增
    ├── mcp-runtime.spec.ts          # v4 新增
    ├── mcp-inbound.spec.ts          # v4 新增
    ├── mcp-sandbox.spec.ts         # v4 新增
    ├── skill-manifest.spec.ts      # v4 增补
    ├── skill-scan.spec.ts          # v4 增补
    ├── root-caller.spec.ts         # v4 增补
    ├── meta-no-lob.spec.ts         # v4 增补（LangQuanta 借鉴）
    ├── meta-sentinel.spec.ts       # v4 增补（LangQuanta 借鉴）
    ├── meta-recheck.spec.ts        # v4 增补（LangQuanta 借鉴）
    ├── realm-standard.spec.ts
    ├── realm-strict.spec.ts
    └── violation.spec.ts
```

### 7.2 核心接口汇总

```typescript
// packages/assembly/src/index.ts

export { type PluginContract, type CapabilityDeclaration } from './contract'
export { type EffectiveNode, type CompositionLayer, type OverrideRecord } from './resolver'
export { type AssemblyPlan, type CompositionGraph, type CapabilityGrantPlan } from './plan'
export { type Diagnostic, type ValidationResult } from './validators/types'
export { type AuditEntry } from './security/audit'

/** 装配控制层主入口 */
export class AssemblyController {
  constructor(config: AssemblyConfig) {}
  async assemble(input: AssemblyInput): Promise<AssemblyOutput>
  expand(input: AssemblyInput): Promise<EffectiveNode[]>
  dryRun(input: AssemblyInput): Promise<AssemblyPlan>
}

// packages/runtime-control/src/index.ts

export { CapabilityToken, type CapabilityHandle, deriveFiberToken } from './capability'
export { createMembrane, type MembraneConfig, SecurityViolation } from './membrane'
export { type EffectApi, type EffectRequest, type EffectResult } from './effect'
export { type RealmConfig, type RealmLevel, assignRealmLevel } from './realm'
export { type ViolationHandler, DefaultViolationHandler } from './violation'

/** 运行时管控层主入口 */
export class RuntimeController {
  constructor(plan: AssemblyPlan, config: RuntimeConfig) {}
  /** 安装运行时管控到 Cordis Context */
  install(ctx: Context): void
  /** 为插件创建受控执行环境 */
  createPluginContext(pluginId: string, ctx: Context): PluginContext
  /** 撤销某插件的所有令牌（含 fiber 派生令牌） */
  revokePlugin(pluginId: string): void
  /** 撤销单个 fiber 的派生令牌（v3）——不影响兄弟 fiber */
  revokeFiber(pluginId: string, fiberId: string): void
  /** 隔离违规插件（v3）：撤销令牌 + 卸载 + 审计，进程存活 */
  isolatePlugin(pluginId: string, reason: SecurityViolation): void
  /** 发起审批并 park 当前 fiber（v3）——由效果处理器调用 */
  requestApproval(req: EffectRequest): Promise<ApprovalDecision>
  /** 会话收尾（v3）：作废授权记忆 + cancel pending tickets + post-hoc 回顾 */
  disposeSession(sessionId: string): PostHocReview
}

export interface PluginContext {
  ctx: Context
  capabilities: Map<string, CapabilityToken>
  effects: EffectApi
  realmLevel: RealmLevel
}
```

### 7.3 装配管线（Pipeline，更新版）

```typescript
// packages/assembly/src/pipeline.ts

export async function runPipeline(
  input: AssemblyInput,
  config: AssemblyConfig,
): Promise<AssemblyOutput> {
  // 1. 解析
  const layers = parseLayers(input, config)

  // 2. 展开（含 !!js 受限求值）
  const nodes = resolveEffectiveComposition(layers, input.runtime, config)

  // 3. 构图
  const graph = buildCompositionGraph(nodes)

  // 4. 静态校验（12+1 条规则，含 capability-overclaim）
  const staticDiagnostics = runStaticValidators(nodes, graph)

  // 5. 安全检查
  const securityDiagnostics = runSecurityChecks(nodes, layers, config)

  // 6. 能力令牌预颁发计划
  const capabilities = buildCapabilityGrantPlan(nodes, config)

  // 7. 合并诊断
  const errors = [...staticDiagnostics, ...securityDiagnostics].filter(d => d.severity === 'error')
  const status = errors.length > 0
    ? (securityDiagnostics.some(d => d.severity === 'error') ? 'security-denied' : 'validation-error')
    : 'success'

  // 8. 产出装配计划
  const plan: AssemblyPlan = {
    nodes, graph,
    validation: { diagnostics: staticDiagnostics },
    security: { diagnostics: securityDiagnostics },
    capabilities,
    timestamp: new Date().toISOString(),
    layers,
  }

  // 9. 审计
  const audit = writeAuditLog(layers, nodes, plan)

  return { plan, audit, status, errors }
}
```

---

## 8. 迁移路径

### 8.1 分阶段迁移（更新版）

| 阶段 | 目标 | 产出 | 风险 | 控制层 |
|------|------|------|------|--------|
| **S1** | 搭建 `packages/assembly` 骨架 + 契约类型定义 | `contract.ts`、`plan.ts`、`index.ts` | 无 | 装配 |
| **S2** | 实现有效配置展开器 + CLI | `resolver.ts`、`cli/expand.ts` | 低 | 装配 |
| **S3** | 迁移现有静态校验规则 | `validators/static.ts`（13 条——12 条 + M0 补登 fixture-module-dependency/SEC-1007） | 低 | 装配 |
| **S4** | 实现 `!!js` 白名单求值器 | `security/safe-eval.ts` | 中 | 装配 |
| **S5** | 实现敏感配置覆盖保护 | `security/sensitive.ts`、`security/trust.ts` | 中 | 装配 |
| **S6** | 实现动态校验 + Cordis loader 集成 | `validators/dynamic.ts` | 高 | 装配 |
| **S7** | 实现审计链 | `security/audit.ts` | 低 | 装配 |
| **S8** | 收敛现有 `verify-*` 脚本 | 改为调用 `AssemblyController.dryRun()` | 中 | 装配 |
| **S9** | 搭建 `packages/runtime-control` 骨架 | `membrane.ts`、`capability.ts`、`effect.ts` | 无 | 运行时 |
| **S10** | 实现服务膜 + 集成 `ctx.get` | `membrane.ts`、`integration.ts` | 中（需回归现有服务访问） | 运行时 |
| **S11** | 实现能力令牌预颁发 | `capability.ts`、`issuer.ts` | 中 | 运行时 |
| **S12** | 实现效果系统（fs/net/proc/env） | `effects/handlers.ts`、`effects/api.ts` | 高（需逐包迁移副作用调用） | 运行时 |
| **S13** | 实现执行隔离域（standard 级别） | `realm/` | 高（白名单 import 可能破坏现有插件） | 运行时 |
| **S14** | 实现运行时违规处理 + 审计 | `violation.ts` | 低 | 运行时 |
| **S15** | 全量回归 + 严格模式灰度 | 端到端测试 | 高 | 两层 |
| **S16** | 智能体审批语义：三档授权 + 豁免通道 + park/resume | `effects/approval.ts`、ApprovalGate 包装层（M0 裁定 1A：park/resume 语义由 dsh 侧实现，不动 vendor） | 高（触及审批主流程；M0 后前置风险下调——无需 Fiber API 先行实现） | 运行时 |
| **S17** | MCP 效果纳入 + 数据外发检查 | `effects/mcp.ts`、`effects/exfiltration.ts` | 中（mcp-client 适配层） | 运行时 |
| **S18** | isolate 档 + 收尾自检 + fiber 令牌 + 写锁 | `violation.ts` 扩展、`post-hoc.ts`、`write-lock.ts`、`deriveFiberToken` | 中 | 运行时 |
| **S19** | MCP 通道唯一化 + 反向请求效果化 | `mcp/runtime.ts`（McpRuntime）、capabilities 声明 + setRequestHandler 三型接线（M0：从零接线）、sampling/roots/elicitation 入站处理（5.8.1/5.8.3） | 高（收归 client 触及 packages/mcp 边界；M0 上探一档——通道现状未接线、攻击面为零） | 运行时 |
| **S20** | server 沙箱档位 + 生命周期绑定 + 残余风险登记簿 | 三平台沙箱模板（5.8.5）、`McpServerBinding`、登记簿（14.5） | 高（平台差异 + 逃逸用例集） | 运行时 |
| **S21** | SkillManifest 契约 + 装载期静态扫描 + 来源三级 | `skill/manifest.ts`、`skill/scan.ts`、dsh-skill-filesystem 集成（5.9） | 中（触及 skill 装载链） | 运行时 |
| **S22** | root 调用者登记 + CLI 面收口 | `caller: 'dsh-root'` 归属、效果审计扩展、L4 自举面登记（5.10） | 低 | 运行时 |
| **S23** | 元层纪律：No-Löb 排除 + 一致性哨兵 + 互指键 + 独立重算器 + 码位表 + 红线 | `meta/no-lob.ts`、`meta/sentinel.ts`、`meta/recheck.ts`、SEC 码位建档、红线脚本（5.11 全节） | 中（哨兵触及审批主路径） | 运行时 |

> **依赖关系**：S16–S18 均依赖 S12（效果系统）先行；S16 的 park/resume 语义由 dsh 侧 ApprovalGate 包装层实现（M0 裁定 1A，2026-09-30——vendor/cordis 无此原语且不扩展，P5 诊断解耦为独立小项）。S16–S18 三条线与 S13–S15 可交叉推进。S19–S20 依赖 S17（mcp.call 效果）先行；S19 的 sampling 链拦截（prompt 扫描 → 结果回传 exfiltration 检查）依赖 S16 审批语义与 5.3.8 外发检查已就绪；S20 依赖 S19 的 server 注册表存在。S21–S22 均依赖 S12 先行；S21 的静态扫描器与装配期静态校验（4.2.1）复用同一诊断框架；S22 可随时插入，无额外前置。S23 依赖 S16（审批服务）与 S12 先行；其中 No-Löb 排除（5.11.2）应随 S16 一并落地——属强推先置项，其余可后置。

### 8.2 向后兼容保证

- **S1–S8（装配控制层）**：不改变运行时行为，只是在启动前多了一步"干跑检查"。未声明 `contract` 的插件行为不变。
- **S9–S14（运行时管控层）**：
  - **服务膜**：对无 `SENSITIVE_SERVICE_MEMBRANES` 注册的服务，使用 `DEFAULT_MEMBRANE`（只读 mode/policy/config），现有服务如果不在这些属性上写入，行为不变。
  - **能力令牌**：未声明 `capabilities` 的插件在 `--lenient-capabilities` 模式下获得"全部能力"令牌，行为不变。严格模式在 S15 后逐步收紧。
  - **效果系统**：S12 阶段不强制所有插件走效果 API——现有直接调 `node:fs` 的插件仍可工作。效果系统先作为"可选通道"提供，新插件推荐使用。逐步迁移旧插件。
  - **执行隔离域**：默认级别为 `none`（无隔离）。S13 阶段开始按 `assignRealmLevel` 自动分配，但有 `--no-realm` 标志可关闭。
  - **审批语义**（v3）：`--sync-approval` 标志保留 v2 的同步阻塞审批行为，供 S16 灰度期间回退；授权记忆默认关闭（`--no-grant-memory`），豁免通道逐条灰度开启。
  - **MCP 效果**（v3）：S17 纳入前，现有 MCP 调用路径保持不变（效果审计标 `exfiltrationCheck: 'not-applicable'`）；纳入后未声明 `mcp` 能力的插件在 lenient 模式降级 warning，不阻断。
  - **MCP 内建**（v4）：S19 收归前，业务包直连 packages/mcp 的现有路径保持可用（standard 档以上隔离域才禁 import）；`--legacy-mcp` 标志保留旁路；sampling/roots/elicitation 未声明时 lenient 模式 warning，不拒绝。
  - **沙箱档位**（v4）：默认 mcp-trusted（仓库内 server）与现有 spawn 行为一致——沙箱是收紧不是放宽；mcp-unknown 全禁需显式启用；三平台档位逐个灰度（Linux 先行，最弱平台最后）。
  - **isolate 档**（v3）：默认 ViolationPolicy 仍为 `log-and-throw`；isolate 需逐插件或全局配置开启，且每次隔离强制产出 post-hoc 报告。

### 8.3 `verify-cordis-config.ts` 的收敛方式

1. S3 阶段：将 `verify-cordis-config.ts` 的逻辑迁移到 `packages/assembly/src/validators/static.ts`，保持行为一致。
2. S8 阶段：将 `scripts/verify-cordis-config.ts` 改为薄包装——调用 `AssemblyController.dryRun()`，格式化输出诊断。CI 门禁行为不变。
3. 最终：`verify-cordis-config.ts` 可考虑废弃，CI 改为调用 `dsh config --dry-run`。

---

## 9. 诚实边界

### 9.1 无法做到的

1. **静态封闭的类型系统**：Cordis 允许插件在运行期任意 `ctx.get/set` 动态注册服务，组合空间在运行时是开放的。两层控制层无法把这个开放空间封闭成静态类型等价。能做到的是"提前失败 + 运行时精确拦截 + 全量审计"，而非"静态证明"。

2. **消除所有运行期越权**：
   - **装配控制层**无法防住运行时代码越权（直接调 Node API、篡改服务对象）——这是设计运行时管控层的原因。
   - **运行时管控层**的效果系统只能拦截"通过 `effect.*` 发起的副作用"——如果代码绕过效果 API 直接调原生模块，需要执行隔离域拦截。但隔离域的 `standard` 级别只做白名单 import，不拦截 `globalThis` 上的原生模块缓存访问；`strict` 级别能做到近乎完全隔离，但会破坏大多数现有插件。
   - **原型链冻结**能阻止 `Object.prototype` 污染，但无法阻止 ES6 `class` 的 `Symbol.hasInstance` 等元编程攻击——这些需要 `strict` 级别的完全冻结。

3. **零性能开销**：服务膜的 Proxy 包装、能力令牌的权限检查、效果系统的每次调用审计，都有可测量的运行时开销。在 100+ 插件、高频服务调用的场景下，需做性能基准测试和优化（如膜缓存、令牌预编译、效果批量审计）。

4. **绝对安全的白名单**：`!!js` 白名单求值器和模块 import 白名单能阻止已知危险模式，但无法证明"所有通过白名单的表达式/模块都安全"——这依赖于白名单的完备性维护。

5. **豁免通道的信任根**（v3 新增）：provenance 豁免（"本轮产物"）依赖审计链的完整性——历史 write 记录若被篡改，或路径经符号链接指向他处，豁免可能被误授。豁免判定必须先做路径规范化（realpath），且整个体系的信任根是审计日志的只增不改纪律。回收站语义依赖 OS 层（Windows Shell API / macOS ~/.Trash / Linux 无统一标准，降级为移动到 `$DSH_HOME/.trash`），不保证跨文件系统的一致语义。

6. **MCP 覆盖面与进程内行为的分界**（v3 提出，v4 修订）：`mcp.call` 及 v4 的反向请求效果化覆盖协议双向面、结果面、传输面、生命周期面（5.8.2）；server 进程内部代码的 OS 级行为不在协议观察面内，v4 以沙箱档位（5.8.5）将其压至最小环境——这是攻击面缩减，不是完全管控。

7. **"完全管控"不可达**（v4 新增）：沙箱机制本身是软件——历史逃逸真实存在（runc CVE-2019-5736 容器逃逸；`sandbox-exec` 被 Apple 自标 deprecated 且配置语言易错；seccomp 白名单漏一个 syscall 即洞；路径规则存在 TOCTOU，需 openat2 `RESOLVE_BENEATH` 类机制配合）。且语义注入不依赖任何越权——工具结果驱动宿主用**合法权限**作恶，OS 沙箱与之无关（confused deputy）。dsh 跨三平台，沙箱能力不对等，弱平台必然降级。完整论证与五出口管控谱系见第 14 章：设计目标是"表达半径、消耗预算、发生点拦截"三重可判定围堵，不是完全管控。

8. **root 与自举面**（v4 增补）：效果系统把宿主 root 登记为显式调用者（`caller: 'dsh-root'`）获得的是**审计完整性**而非"被约束"——root 是约束的实施者，不是被约束方。CLI 启动参数发生在装载期之前，归装配控制层；运行时管控层运行在 CLI 启动的进程内，**不可能约束自己的启动者**——该残余登记为 14.5 L4，靠架构外手段缓解（分发签名链、装载期参数拒绝、管控层自身代码签名，5.10.3）。

9. **验收全绿不蕴含架构一致**（v4 增补，LangQuanta 1.18.5 移植）：验收 R1–R44 全绿是已知攻击面的矛盾实例**检测**通过，不是安全性的**证明**（哥德尔第二边界：含算术的一致系统无法自证一致）。验收的作用是把已知攻击面回归纳入 CI；未知攻击面的残余见 14.5 登记簿。本条与第 7 条（"完全管控不可达"）构成同一纪律的两面：一条管理论断（不许声称完全），一条管验收（不许把检测当证明）。

### 9.2 两层控制层的防御覆盖矩阵

| 攻击向量 | 装配控制层 | 运行时管控层 | 覆盖状态 |
|----------|-----------|-------------|---------|
| 低信任层覆盖敏感配置 | 敏感覆盖保护 ✅ | — | 完全覆盖 |
| `!!js` 注入任意代码 | 白名单求值器 ✅ | — | 完全覆盖 |
| 加载恶意 npm 包 | 信任源策略 ✅ | — | 完全覆盖 |
| 不安全组合（重复/遮蔽/环） | 静态+动态校验 ✅ | — | 完全覆盖 |
| 直接调 Node.js 原生 API | — | 隔离域白名单 import ✅（standard+） | 覆盖（需迁移到隔离域） |
| `ctx.set` 动态遮蔽安全服务 | — | 服务膜 + 动态校验 ✅ | 覆盖（膜拦截 set） |
| 篡改服务对象属性 | — | 服务膜 readonly ✅ | 完全覆盖 |
| 劫持事件自动批准 | — | 能力令牌 events 声明 ✅ | 覆盖（需声明 events 能力） |
| 原型链污染 | — | 原型链冻结 ✅（standard+） | 覆盖（需隔离域 ≥ standard） |
| 绕过效果 API 直接调原生模块 | — | 隔离域白名单 import ✅（standard+） | 覆盖（需隔离域 ≥ standard） |
| `globalThis` 缓存篡改 | — | 隔离域全局覆盖 ✅（strict） | 仅 strict 覆盖 |
| ES6 元编程攻击（Symbol 等） | — | 完全原型冻结 ✅（strict） | 仅 strict 覆盖 |
| MCP 工具调用越权（v3） | — | `mcp.call` 效果 + servers/tools 白名单 ✅ | 覆盖（调用面；server 进程内行为除外） |
| 数据外发 exfiltration（v3） | — | 出站上限 + 敏感扫描 + 方向检查 ✅ | 覆盖（声明上限内） |
| 审批阻塞拖死会话（v3） | — | park/resume 一等阻塞状态 ✅ | 完全覆盖 |
| 并行子代理写冲突（v3） | — | fiber 派生令牌 + 按目标写锁 ✅ | 完全覆盖 |
| 违规插件拖垮进程（v3） | — | isolate 档 ✅ | 完全覆盖 |
| MCP server 进程内行为（v3 提出，v4 缓解） | — | 沙箱档位：最小 env + 路径绑定 + syscall 白名单 + 资源限额（5.8.5） | 缓解（攻击面缩减，非完全；9.1 第 6、7 条） |
| sampling 反向请求越权链（v4） | — | `mcp.sampling-request` 效果化 + prompt 敏感扫描 + 结果回传过 exfiltration 检查（5.8.3） | 覆盖（声明上限内；未声明即拒） |
| roots 请求超出沙箱（v4） | — | 返回集合 ⊆ workspaceRoot ∩ 声明 roots（5.8.3） | 完全覆盖 |
| 钓鱼式 elicitation（v4） | — | 审批流 + 来源标注 UI（5.8.3） | 覆盖 |
| 借宿主权限的语义注入（v4） | — | taint + 结构化输出 + 输出侧效果监控 + 来源链审批升级（5.8.4、14.4） | 缓解（架构性已接受，14.5） |
| 沙箱配置漂移/逃逸（v4） | — | 档位模板化 + 三平台逃逸用例回归 CI | 缓解（置信度维护，9.3 第 9 条） |
| skill 越权指令注入（v4 增补） | — | 装载期全量静态扫描 + 来源三级 + taint 标记（5.9.3） | 缓解（L3 同构；静态部分可前移，语义残余同 L3） |
| skill 能力超限（v4 增补） | — | SkillManifest 声明 + 运行期效果归因比对（5.9.4） | 覆盖（审计级，可配置拦截） |
| skill 附带脚本执行越权（v4 增补） | — | 走 proc.spawn 效果 + 沙箱 + 审批（5.9.1 资源面） | 完全覆盖（唯一通道前提下） |
| CLI 非法启动参数（v4 增补） | — | --patch 信任等级 + 敏感覆盖保护 + env 白名单（4.3） | 完全覆盖（装配层，装载期拒绝） |
| CLI 运行面操作（v4 增补） | — | caller: 'dsh-root' 登记 + 全量效果审计（5.10.2） | 可监控（非被约束，9.1 第 8 条） |
| 自举面：CLI/宿主/管控层自身完整性（v4 增补） | — | — | 未覆盖（架构外缓解：签名链 + 装载期拒绝，14.5 L4） |
| 管控层自我豁免（被注入后给自己颁发授权/豁免，v4 增补） | — | No-Löb 硬排除：META_CALLERS 不进授权/豁免通道（5.11.2） | 完全覆盖（入口级拒绝，[T1]） |
| 元数据矛盾（授权库与审计链对不上，v4 增补） | — | 一致性哨兵：冻结通道 + 不自动改判（5.11.3） | 检测级（哨兵是检测器非证明，9.1 第 9 条） |

**证据分级说明**（v4 增补，LangQuanta [T1]/[T2]/[T3] 移植）：上表各行的覆盖状态按三级证据形式理解——**[T1] 机器可测**（注入测试在 CI）、**[T2] 文本可核查**（配置与审计可对账）、**[T3] 诚实降级**（已知不可判定，登记保守下界，**无实测不给数字**）。关键行点名：skill 静态扫描 = [T1]（措辞模式注入）+ [T3]（语义级注入**漏检不承诺**，与 I11 近邻排除同构）；沙箱档位 = [T1]（逃逸用例集）+ [T3]（未知逃逸不承诺）；L3 语义注入 = [T3]（架构性已接受）；"完全管控"本身 = [T3]（Rice 定理）。**"完全覆盖"指 [T1] 可测部分闭合，不蕴含 [T3] 残余为零。**
| 符号链接路径混淆绕过豁免（v3） | — | realpath 规范化 + 审计纪律 | 部分（依赖信任根） |
| 侧信道（时序/内存/资源耗尽） | — | — | 未覆盖 |

### 9.3 必须警惕的退化

1. **控制层变成"又一个校验脚本堆积层"**：必须限制两个控制层各只做自己的三/四件事，且把现有 `verify-*` 家族收敛为装配控制层的内部实现。

2. **白名单膨胀**：`!!js` 白名单、敏感路径、模块 import 白名单、能力上限如果无节制增长，会退化为"每个例外都加白名单"。需要一个审批流程：新增白名单条目需要记录理由和评审记录。

3. **隔离域"纸糊的墙"**：`standard` 级别的白名单 import 如果不够严格（比如允许了 `node:fs`），就等于没隔离。需要定期审计白名单，确保不含可绕过效果系统的模块。

4. **性能退化被忽视**：服务膜和效果系统的运行时开销如果不在 CI 中持续基准测试，可能在某次变更后悄悄超过阈值。需要在 S15 阶段建立性能回归门禁。

5. **效果系统被绕过**：如果迁移期间允许"部分插件直接调原生 API、部分插件走效果 API"，效果系统的保护就不完整。需要跟踪每个插件的迁移状态，在严格模式下禁止未迁移插件运行。

6. **豁免通道膨胀**（v3 新增）：与白名单膨胀同构——每新增一条豁免通道（新的 provenance 判定规则、新的临时区、新的预授权类别），攻击面就多一个入口。豁免通道是封闭枚举，新增必须走与白名单条目相同的审批流程（记录理由与评审）。

7. **park 状态泄漏**（v3 新增）：审批请求发出后用户永不回复，fiber 永久 park，会话资源泄漏。必须有超时自动 deny（`ApprovalTicket.timeoutMs`）+ 会话关停时 cancel 全部 pending ticket——两者都是 ApprovalService 的强制语义，不可配置关闭。

8. **isolate 滥用**（v3 新增）：违规就 isolate 会掩盖根因，还可能陷入"隔离-重启-再违规"循环。配套纪律：每次隔离强制产出 warning 级 post-hoc 报告；同一插件累计隔离达到阈值（默认 2 次）自动升级为装配期禁用——写回 patch 层 `disabled` 并进入人工审查，而不是无限隔离。

9. **沙箱配置漂移**（v4 新增）：OS 沙箱规则（Landlock/seccomp profile、sandbox-exec 描述文件、AppContainer capability 清单）是手写配置，随 dsh 跨平台演化易出现档位间漂移——同一 server 在 Linux 被严管、在 Windows 配置遗漏即全放。配套纪律：沙箱配置**模板化**（sandbox-profiles.ts），三平台配置回归测试纳入 CI（每个档位跑逃逸用例集），配置变更与白名单同级评审。

10. **判定面增量无准入论证**（v4 增补，LangQuanta C8 移植）：新增效果类型/能力域/豁免通道/审批档位/诊断码若不附"信任语义论证"（可被授予/可被冒充/可破坏一致性），判定面会静默膨胀——本条是第 2/6 条（白名单与豁免膨胀）的**正面准入对偶**：纯工程机制以数据字段/契约段承载（5.11.1），携带信任语义才准入，且走 5.11.9 裁定流程（提案→独立复核→裁定→落地）。

### 9.4 与 LangQuanta 哲学的对齐

| 原则 | LangQuanta | 本设计 |
|------|-----------|--------|
| 内核永不自动 | 内核层不做自动判定 | Cordis 内核不做授权判断 |
| 三层分离 | 内核 + 提议者 + 治理 | 内核 + 装配控制层 + 运行时管控层 + 业务层 |
| 诚实登记 | unknown ≠ proved | "已验证闭合" ≠ "运行时无越权"，两层明确区分两者 |
| 可审计、可回滚 | 知识库版本化 | 装配审计链 + 效果审计链 + 覆盖历史 + `--expand --diff` |
| 先确认后落地 | 用户确认后才追认 | `--dry-run` 先校验再挂载；效果系统先审批再执行 |
| 能力令牌 | Cap[T] 不可伪造 | CapabilityToken._issue 仅管控层可调 |
| 语法层面排除 | 设计层排除溢出/自指 | 装配层排除不安全组合；隔离域排除不安全 import |
| 一等阻塞状态（v3） | needs_human / parked 会话，回复后唤醒 | waiting-approval：fiber park + 超时/取消唤醒 |
| 授权记忆（v3） | once / always / reject 三档语义 | GrantScope once/object/class + 会话级授权库 |
| 确认豁免条款（v3） | 本轮产物 / 临时区 / 用户明确指定免确认 | same-session-artifact / temp-area / trash-default 封闭枚举 |
| 回收站优先（v3） | Trash-first，永久删除需二次确认 | fs.trash 默认低门槛；fs.delete-permanent 需单独能力+审批 |
| 数据主权（v3） | 本地处理、数据不上传 | net 出站上限 + 敏感扫描 + exfiltration 审计 |
| 子代理文件边界（v3） | 并行分派时边界互不冲突 | fiber 派生令牌 + 按目标写锁串行化 |
| 结构化自我修复（v3） | 已知故障模式库，恢复优先于崩溃 | isolate 档：撤令牌+卸载+审计，进程存活 |
| 理论定界（v4） | unknown ≠ proved 的运行时版本 | "完全管控"改写为三重可判定围堵（第 14 章）；残余风险登记簿三栏登记（14.5） |
| 语法层排除优先于运行时兑底（v4） | 声明式语法排除恶意行为表达力 | 结构化输出 + 声明式工具 DSL（14.3 路线 1 最优先） |
| 契约统一（v4 增补） | 一切资源接入先声明能力面 | PluginContract / McpCapability / SkillManifest 三契同构；trusted/signed/unknown 三档全系统统一（5.8.5/5.9.2） |
| No-Löb（v4 增补） | 不得声明"可证即真"元公理；元记账不进对象证据（1.18.3） | 管控层不自我豁免：META_CALLERS 硬排除（5.11.2）；审批超时 deny ≠ 用户 deny（5.11.7） |
| 哥德尔第二边界（v4 增补） | K 系全绿不蕴含系统一致（1.18.5） | 验收全绿 ≠ 架构一致（9.1 第 9 条）；哨兵是检测器不是证明（5.11.3） |
| 码位治理（v4 增补） | 一码一规则；零新增论证 | 诊断码位登记表 SEC-xxxx（5.11.6） |
| 红线预算（v4 增补） | TCB 行数红线 + 枪毙条件 | runtime-control 判定核心复杂度红线（5.11.8） |

---

## 10. 验收标准

### 10.1 装配控制层验收

| 编号 | 验收项 | 验证方法 |
|------|--------|----------|
| A1 | `dsh config --expand` 正确展开多层覆盖链 | 对比展开结果与手动追踪的预期值 |
| A2 | `dsh config --dry-run` 检测出所有现有 `verify-cordis-config.ts` 能检测的错误 | 用相同输入运行两者，对比诊断输出 |
| A3 | `!!js` 白名单求值器通过所有现有表达式 | 全量回归 `cordis.patch.yml` + 各 bundle patch |
| A4 | 敏感配置覆盖保护阻止低信任层覆盖 `sandbox-policy.mode` | 构造恶意 patch，验证被拒绝 |
| A5 | 动态校验检测到 preset 遮蔽 host 路由 | 构造遮蔽场景，验证运行期诊断输出 |
| A6 | 装配审计链记录完整 | 对比审计日志与实际装载/覆盖操作 |
| A7 | 现有 CI 门禁行为不变 | `verify-cordis-config` 在迁移前后退出码一致 |
| A8 | 未声明 contract 的插件行为不变 | 全量回归现有测试套件 |
| A9 | `capability-overclaim` 规则检测到超出信任等级的能力声明 | 构造 overclaim 场景，验证装载失败 |
| A10 | `dsh config --capabilities` 正确展示预颁发令牌计划 | 对比展示结果与契约声明 |

### 10.2 运行时管控层验收

| 编号 | 验收项 | 验证方法 |
|------|--------|----------|
| R1 | 服务膜阻止对 `sandbox.mode` 的写入 | 构造篡改代码，验证抛出 SecurityViolation |
| R2 | 服务膜阻止 `Object.defineProperty` 篡改服务 | 构造 defineProperty 代码，验证被拒 |
| R3 | 能力令牌阻止调用未授权方法 | 颁发仅含 `check` 的令牌，尝试调 `setMode`，验证被拒 |
| R4 | 能力令牌撤销后访问失败 | 撤销令牌后调用服务，验证抛出 SecurityViolation |
| R5 | 效果系统拦截 read-only 模式下的文件写入 | 设置 sandbox=read-only，尝试写文件，验证被拒 |
| R6 | 效果系统对 workspace 外路径的写操作拒绝 | 尝试写 workspace 外路径，验证被拒 |
| R7 | 效果系统审计日志完整 | 对比效果审计日志与实际效果调用 |
| R8 | 隔离域 standard 级别阻止 import `node:child_process` | 在 standard 域中 import child_process，验证被拒 |
| R9 | 原型链冻结阻止 `Object.prototype` 污染 | 尝试 `Object.prototype.hack = true`，验证被拒 |
| R10 | 运行时违规被记录到审计链且抛出 | 触发各类违规，验证审计日志 + SecurityViolation |
| R11 | `--lenient-capabilities` 模式下未声明插件行为不变 | 全量回归现有测试套件 |
| R12 | `--no-realm` 模式下隔离域关闭，行为不变 | 全量回归现有测试套件 |

### 10.3 智能体运行语义验收（v3 新增）

| 编号 | 验收项 | 验证方法 |
|------|--------|----------|
| R13 | 三档授权语义：once 不记忆、object 记目标、class 记操作类 | 依次以三档批准后重放同类请求，观察豁免命中差异 |
| R14 | provenance 豁免：同任务同调用者覆盖自己创建的文件免审批 | 先 write 创建、再 write 覆盖，第二次审计应标 auto-by-provenance |
| R15 | 审批 park/resume：等待期间会话可响应取消与新输入 | 发起审批后注入取消事件，验证 fiber 唤醒且资源释放 |
| R16 | 审批超时自动 deny | 构造永不回复的审批，验证超时后 deny 且审计标 timeout |
| R17 | fs.trash 默认进回收站；fs.delete-permanent 需单独能力+审批 | 仅声明 delete 的插件调 trash 生效；调 delete-permanent 被拒 |
| R18 | mcp.call 纳入效果审计，servers/tools 白名单生效 | 未声明 mcp 能力的插件调 MCP 工具：严格模式拒、lenient 模式 warning |
| R19 | 数据外发检查：超上限或含敏感数据的出站请求被拦截 | 构造超阈值请求与含 credentials 特征的请求，验证 blocked |
| R20 | isolate 档：违规插件被撤令牌+卸载+审计，进程与兄弟插件存活 | 注入违规插件，验证主进程与其余插件继续工作 |
| R21 | 收尾自检：lenient 模式下会话结束产出 undeclared-capability 清算报告 | lenient 下运行未声明能力的插件，验证 post-hoc findings 非空 |
| R22 | fiber 粒度令牌：撤销单个子代理令牌不影响兄弟 fiber | 双 fiber 并行运行，revokeFiber 其一，验证另一继续工作 |
| R23 | 同目标写效果串行化：并行写同一文件不产生交错损坏 | 双 fiber 并发写同一文件，验证最终内容为两次完整写入 |

### 10.4 MCP 深度内建与沙箱验收（v4 新增）

| 编号 | 验收项 | 验证方法 |
|------|--------|----------|
| R24 | 通道唯一化：业务包无法绕过 effect.mcp.call 直连 MCP | standard 隔离域下 import packages/mcp 被拒；全仓扫描无第二处连接持有 |
| R25 | sampling 未声明能力即拒：声明则模型/token 预算强制 | 未声明 server 发起 createMessage 验证 deny；声明后超 maxTokens 验证截断 |
| R26 | sampling 结果回传过 exfiltration 检查 | 构造含 credentials 特征的采样结果，验证回传被拦截 |
| R27 | roots 暴露不超出 sandbox 策略 | server 请求 roots，验证返回集合 ⊆ workspaceRoot ∩ 声明 roots |
| R28 | elicitation 纳入审批且 UI 标注来源 | 发起 elicitation，验证走审批流且标注"来自 MCP server X" |
| R29 | 结果面扫描：含密钥特征的工具结果被标记/拦截 | 构造返回含 API key 模式的结果，验证标记生效 |
| R30 | isolate 联动：插件隔离时其归属 server 进程被 kill | 隔离插件后检查其 server 进程已终止 |
| R31 | mcp-unknown 档默认全禁 | 未分类 server 无法注册，或仅可 dry-run 档（零权限） |
| R32 | 沙箱档位三平台配置回归 | 每档位的逃逸用例集在 CI 全绿（9.3 第 9 条） |

### 10.5 skill 与 CLI 面验收（v4 增补）

| 编号 | 验收项 | 验证方法 |
|------|--------|----------|
| R33 | SkillManifest 声明能力面，运行期效果归因比对生效 | 激活声明 net: [] 的 skill，LLM 发起 net.fetch，验证 skill-capability-exceeded 诊断 |
| R34 | 装载期静态扫描：越权指令模式被检出 | 构造含"绕过审批/直接调 child_process"措辞的 skill，验证装载 warning/error |
| R35 | 来源三级：unknown skill 默认不装载 | 未声明 manifest/未签名 skill 注册被拒（lenient 降级 warning） |
| R36 | skill 引导的全部宿主副作用走效果系统并归因 | skill 指令引导 LLM 调用工具（含 proc 类），验证效果审计 + 沙箱 + `activeSkill` 归因链生效（M0 修正：dsh skill 执行体为纯 Markdown 指令，无附带脚本通道） |
| R37 | root 调用者登记：CLI 运行面操作全量审计 | dsh config 子命令写文件，验证审计中 caller: 'dsh-root' 且 post-hoc 覆盖 |
| R38 | CLI 非法启动参数被装配层拒绝 | --patch 引入敏感覆盖，验证装载失败（复用 4.3.3） |

### 10.6 元层纪律验收（v4 增补，LangQuanta 借鉴）

| 编号 | 验收项 | 验证方法 |
|------|--------|----------|
| R39 | No-Löb：root/管控层调用者的授权登记被拒 | root 调用者请求 recordGrant / evaluateExemption，验证拒绝 + 审计记 no-lob |
| R40 | 一致性哨兵：授权库与审计链矛盾触发通道冻结 | 构造矛盾注入，验证豁免通道冻结 + 降级全审批 + 不自动改判 |
| R41 | 审计互指键：效果审计可按 assemblyPlanId 对账 | 收尾自检输出的效果集可完整归因到装配计划 |
| R42 | 判据独立重算器：样本重算一致记 cross_checked；不一致触发冻结 | 注入故意不一致的重算结果，验证冻结 + 告警 |
| R43 | 诊断码位：SEC-xxxx 一码一规则，新增机制优先复用 | 码位登记表静态检查：无重复码位、无未登记码 |
| R44 | 复杂度红线：runtime-control 判定核心不超线 | 红线复测脚本（逻辑行口径）CI 全绿；基线由用户裁定追认 |

---

## 11. 依赖与前置条件

- **acorn**（或等价 AST 解析器）：用于 `!!js` 白名单求值器的 AST 解析。需确认 dsh 仓库是否已有可用依赖，或需新增。**M0 结论（T0.2）**：acorn 8.17.0 已是 workspace 运行时依赖（`packages/experimental/webworker-runtime` 直接依赖），零新增供应链面，直接复用（同版本声明即自动去重）；`!!js` 现状为裸 eval（`vendor/loader/src/config/utils.ts:5–9`），确证替换点；TS Compiler API 先例全在 build-time 脚本，不引入运行时。
- **TypeScript 编译期类型回报**（可选）：S1 阶段可将 `PluginContract` 的 `provides`/`needs` 暴露为 `ContractMap` 类型，让 `ctx.inject` 在编译期获得 key 校验。
- **性能基准框架**：S15 阶段需要建立服务膜 + 效果系统的性能基准回归门禁。**M0 结论（T0.10）**：dsh 基准设施为自研计时 harness（编译 worker 内 performance.now + 中位数 + ciTimeBudget 校准预算，tinybench 零使用）——复用该模式新建 `benchmarks/<路径名>/`，进 `test:bench` CI 门；不引入 vitest bench()（in-process 运行与 fresh-child 纪律冲突）。
- **Node.js `vm` 模块**：执行隔离域的 `strict` 级别可能需要 `vm.createContext` + `vm.runInContext`，需评估安全限制和性能影响。
- **Cordis Fiber park/resume API**（v3 关键前置）：S16 的审批挂起依赖 Fiber 的显式 park/resume 能力。需先评估 `vendor/cordis/src/fiber.ts` 是否已提供；缺失则作为 S16 的一部分先行实现——这同时是对 P5（Fiber 诊断缺失）的直接补课。**M0 结论（T0.1，裁定 1A）**：完全缺失；且 Fiber 经证实为插件生命周期原语（状态机 PENDING→LOADING→ACTIVE→UNLOADING→DISPOSED），向其添加协程原语属范畴错误——改为 dsh 侧 ApprovalGate 包装层实现同等 park/resume 语义（5.3.6 实现载体说明），vendor 零改动；P5 解耦为独立小项，不阻塞 S16。
- **跨平台回收站抽象**（v3）：`fs.trash` 需要 Windows（Shell API）/ macOS（~/.Trash）/ Linux（无统一标准，降级 `$DSH_HOME/.trash`）三平台抽象；dsh 的 native 层可能已有可复用实现，需调研。
- **mcp-client 适配层**（v3）：`McpEffectHandler` 需经 `packages/mcp` 的 client 发起调用并取回结果，需确认其 API 形态可被效果处理器包裹（异步、可取消）。v4 修订：client 将收归 McpRuntime，适配层变为其内部实现。**M0 结论（T0.3，裁定 5A）**：可包裹性证实——全异步 + AbortSignal 透传 + ConnectionHandle 集中持有（dispose async 幂等）；inbound 反向请求完全未接线（Client capabilities 空、无 setRequestHandler），S19 从零接线（见 5.8.3 M0 修正）；通道唯一化影响面收敛（5 处源码级 import：acp + 4 个 experimental 包）。
- **OS 沙箱机制调研**（v4）：Linux Landlock / seccomp-bpf / cgroup、macOS sandbox-exec（deprecated 风险）/ Seatbelt profile、Windows AppContainer 的可用性与配置成本；优先评估 dsh native 层可复用实现。**M0 结论（T0.5）**：sandbox-local 三平台既有链直接可复用（Linux bwrap→landlock、macOS seatbelt、Windows ACL restricted token + Low integrity + DACL）；关键缺口 = MCP server spawn 归 MCP SDK、不经 `ctx.sandbox.confine()`——挂载点 = `createTransport`（5.8.5）；macOS deprecated 证实（降级预案必要）；AppContainer 列 mcp-signed 可选上探（配置成本高，Codex 评估先例弃用）。
- **MCP 规范版本跟踪**（v4）：反向请求类型随协议演进（elicitation 为 2025-06-18 规范加入）——`InboundRequestHandler` 需按协议版本登记新面，每个新回调类型即一条新攻击面，需要跟进机制（9.3 第 9 条同源纪律）。**M0 事实**：当前 SDK 为分拆包 `@modelcontextprotocol/client 2.0.0`，协议优先 2026-07-28、版本协商 auto（connection.ts:262）——新面登记以该 SDK 能力面为准。
- **skill 装载链调研**（v4 增补）：SkillManifest 的接入点在 `dsh-skill-filesystem` 的清单装载路径；需调研其清单格式可扩展性（trust 字段、capabilities 字段的兼容位）与 TeleAgent 系 skill 体系的 manifest 对齐成本。**M0 结论（T0.6）**：高度可扩展——frontmatter 手写按键解析、无严格 schema、未知字段静默忽略、metadata 透传袋；trust/capabilities 兼容位 = `parseSkillFile()`（skill-filesystem/src/index.ts:797–840）+ 三接口加可选字段，必须可选 + 默认 unknown（否则现有 skill 全部装载失败）；执行体为纯 Markdown 指令文本，静态扫描对象为指令模式。
- **签名链基础设施**（v4 增补）：L4 自举面缓解依赖分发签名（安装包/二进制/管控层代码签名）——需确认 dsh 现有发布管线是否已有签名步骤，缺失则登记为 S20/S22 的外部前置。**M0 结论（T0.7，裁定 2A）**：双轨事实——Desktop 线完备（macOS codesign + 公证 + entitlements；Windows Authenticode + signtool + 硬件 token + 时间戳；手工发布为设计使然）；npm tarballs / Python wheels / 单文件 exe 线全缺（无 provenance / 无签名 / 无校验和）——L4 缓解对 npm 分发面当前为空。裁定：登记为 S20/S22 外部前置，最小签名链（sha256 校验和清单起步，后续升 cosign）并行补，挂点 = release-publish.yml download-artifact 后 / scripts/release/publish.ts 内；Desktop 侧 windows-sign.mjs、macos-signing-keychain.mjs 可抽出复用。
- **诊断码位回溯建档**（v4 增补，LangQuanta 借鉴）：既有校验规则（4.2.1 十二条）与各 Diagnostic 需回溯分配 SEC-xxxx 码位（5.11.6，R43 前置）；码位表与既有 gen-catalog/verify 脚本同仓登记。**M0 结论（T0.8，裁定 4A）**：登记表初版已产出（《M0-调研建档/SEC-码位登记表.md》——SEC-0901 红线口径 + SEC-1001–1014 静态 + SEC-2001–2004 动态 + 3xxx–7xxx 段位留白）；4.2.1 前 6 条与既有脚本逐函数对上，另发现并补登 SEC-1007（fixture 依赖检查，方案表未单列，裁定确认独立登记）；R43 前置完成。
- **红线口径固化**（v4 增补，LangQuanta 借鉴）：runtime-control 判定核心的逻辑行口径（剔除注释+空行）与复测脚本需先于 S23 建立；基线数字开工实测后由用户裁定追认（5.11.8，无实测不给数字）。**M0 结论（T0.9，裁定 6A）**：口径已固化并自证（`M0-调研建档/scripts/count-logical-lines.mjs`——自测 4/4 通过 + 实战对账 579=548+22+9；词法权威 = TypeScript Scanner 单一口径，尾随注释行计逻辑行、跨行 token 覆盖行均计）；红线清单与候选基线数字 M2 收口时一并裁定，M5 终版追认（R44）。
- **OS 原语桥评估（Rust 化价值地图）**（v4 增补，2026-09-30）：管控层判定不依赖语言（14.2 同源），Rust 的价值集中在**管控层的地基**——P1 Windows FFI 承重层类型化绑定 / P2 进程树生命周期（Job Object/PR_SET_PDEATHSIG）/ P3 fs 效果 TOCTOU 原子链（openat2/dirfd）/ P4 seccomp（条件触发）/ P5 sandbox-exec 替代（条件触发）/ P6 strict 域硬边界（远期评估）；三档判据、事实基座与否决清单见第 17 章。落点 = M4 批次 4b 裁定项（未裁定前维持既有链）。

---

## 12. 执行状态（2026-09-30 更新）

**~~暂不执行~~ → 已裁定基线**：M0 前置调研收口（T0.1–T0.10 全部完成），七项裁定均采用推荐选项（1A dsh 侧包装层 / 2A 外部前置+并行补 / 3A trash npm 包 / 4A SEC-1007 独立登记 / 5A S19 接受上探 / 6A 红线 M2 一并裁定 / 7A 模式乙双线并行），两项事实性修正（skill 表述、S20 挂载点）默认确认。按《里程碑规划》模式乙推进：M1 装配线（S1–S5+S7+S8）∥ M2 运行时线（S9–S12）双线启动，S6 与 S13 高风险点串行收口。M0 调研证据与裁定详情见第 16 章增补记录与《M0-调研建档/M0-调研报告.md》。双线骨架进度（2026-09-30）：S1 与 S9 已完成于镜像工作区 `cordis-mirror/`（类型先行，两包零相互依赖）；OS 原语桥评估并入第 17 章，《里程碑规划》已同步重新规划（v2 基线，M4 增设原生桥裁定项）。**执行推进（2026-09-30）**：M1/M2 正式收口、批次 3a/S22、批次 3b（S17 mcp.call 效果 + exfiltration 外发检查、S18 isolate 档 + post-hoc 收尾自检 + fiber 精确撤销 + 按目标写锁）、**批次 3c（S15 全量回归 + 性能基准门禁 + 严格模式灰度）** 已全部完成——**M3 正式收口**：R13–R23 全验收面雏形，全量回归 190/190 + `test:bench` 性能门禁（membrane/token/effect 三条主路径，T0.10 自研 harness）通过，严格模式灰度按表行 6/34 裁定（镜像已迁移能力面试点 + 灰度清算纪律），SEC-3xxx 维持留白（零新增论证随代码与 SEC 登记表）；实现细节与完成记录见《里程碑规划》批次 3a–3c。

---

## 13. v2 → v3 变更记录

本版合并"对照 TeleAgent 架构"评审的 10 条改进结论（第三轮讨论）。逐条落点：

| # | 改进点（TeleAgent 对照来源） | v3 设计落点 | 回应痛点 |
|---|------------------------------|------------|---------|
| 1 | 三档授权记忆（once/always/reject） | 5.3.6 `GrantScope` + `ApprovalService.recordGrant` | R7 |
| 2 | needs_human 一等阻塞状态 | 5.3.6 `ApprovalTicket`/`FiberParkHandle` + park/resume | R6 |
| 3 | 确认豁免条款（本轮产物/临时区/明确指定） | 5.3.6 `evaluateExemption` 封闭枚举豁免通道 | R7 |
| 4 | 回收站优先，永久删除二次确认 | `EffectType` 拆分 `fs.trash`/`fs.delete-permanent`；`FsCapability.permanentDelete` | R8 |
| 5 | `.temp/` 中间产物与最终交付物分治 | `EffectRequest.artifact` + 临时区豁免 + post-hoc `artifact-unmarked` | R7 |
| 6 | 本地处理、数据不上传（数据主权） | `NetworkCapability.maxOutboundBytes` + 5.3.8 `checkExfiltration` | R10 |
| 7 | 结构化自我修复（恢复优先于崩溃） | 5.5 `isolate` 档 + `IsolateViolationHandler`/`PluginIsolatedError` | R12 |
| 8 | 每轮收尾工作目录全量自检 | 5.6 `runPostHocReview` 越界回顾闭环 | R7/lenient 兕底 |
| 9 | MCP 外部工具生态接入的管控 | `EffectType 'mcp.call'` + `McpCapability` + 5.3.7 `McpEffectHandler` | R9 |
| 10 | 并行子代理文件边界互不冲突 | 5.2.5 `deriveFiberToken` + 5.2.6 续期策略 + 5.7 `EffectWriteLock` | R11 |

配套变更：新增验收标准 R13–R23（10.3 节）、迁移阶段 S16–S18（8.1 节）、退化警惕第 6–8 条（9.3 节）、诚实边界第 5–6 条（9.1 节）、防御矩阵新增 7 行（9.2 节）、LangQuanta 对齐表新增 7 行（9.4 节）。

---

## 14. 不可判定性与管控谱系（v4 新增，理论根基）

本章回答一个根本问题：**"完全管控 MCP 工具操作行为"是否可达？** 答案是否定的，且在理论上不可达。但"完全管控"与"残余风险收敛为可审计清单"是两回事——后者可达。本章给出分界、谱系与正确表述。

### 14.1 Rice 定理的准确边界

Rice 定理：任意程序的非平凡语义性质不可判定。它杀死的是"**事前完备预测**"——不存在判定器能对任意 server 预测其全部行为。

它**没有**杀死"**事中精确阻断**"。预测未来所有行为不可判定；逐点判定当下是可判定的。绕过不可判定性有五个有理论根据的出口，每个都把问题改写为可判定形式（14.3）。

### 14.2 safety / liveness 分解与运行时强制

按 Alpern–Schneider 分解，任何行为性质 = safety ∩ liveness：

- **safety 性质**（坏事不在有限前缀上发生）：一切"不允许发生 X"型禁令——不写 workspace 外、不出站含密钥、不 exec 未声明命令
- **liveness 性质**（好事终将发生）：终止、返回、推进

Schneider 运行时强制理论的决定性结论：**safety 性质可被监控器精确强制，达到零违规**——每次拦截决策只是检查当前有限前缀是否踩线，可判定，不触及 Rice 定理。前提两条：

1. 性质写成 safety 型（有限坏前缀可判定）
2. 监控面是唯一通道（工程问题，9.3 第 9 条）

**本设计的效果系统（5.3）本质上就是这个 safety monitor**。唯一通道做实（MCP 内建 5.8.1 + 隔离域 import 白名单 S13）后，safety 部分闭环——"将要发生时禁止"对 safety 性质不是近似方案，是理论上可完备的。liveness/资源残余走预算围堵（14.3 路线 4）。

### 14.3 五个出口的谱系

| 路线 | 理论依据 | 本设计的落点 | 优先级 |
|------|---------|--------------|--------|
| **1. 收窄程序类** | Rice 只覆盖图灵完备类；受限演算上白名单判定可判定 | **声明式工具 DSL / 结构化输出**（5.8.4）：server 只声明结构化效果、结果走 schema——恶意行为表达力在语法层排除 | **最高**：唯一"排除"而非"围堵"的路线 |
| **2. 证明携带（PCC）** | 找证明不可判定，验证明可判定 | **证书化 server**（mcp-signed 档延伸）：签名绑定"规范+证明+二进制"三元组，运行时只验证书；判定负担转移给生态提供者 | 纵深 |
| **2.5 判据独立重算**（v4 增补，LangQuanta 1.7 移植） | 复核器非第二判据：验算可判定且规模可控 | **判据独立重算器**（5.11.5）：独立小检查器重算审批样本，一致 ⇒ cross_checked，不一致 ⇒ 冻结不改判 | 纵深（L4 在架构内的唯一缓解） |
| **3. 运行时监控** | Schneider enforceable security properties | **效果系统即 safety monitor**（5.3）：唯一通道后对 safety 完备 | 底线闭环 |
| **4. 预算围堵** | 有界性替代终止性（fuel/gas） | **server 进程 gas**（5.8.5）：步数/时间/内存/出站字节限额，超限即杀——liveness 型残余不预测，超限即杀 | 纵深 |
| **5. 能力闭包** | Object-capability model：能力只随引用传递，权限可达图静态可计算 | **Cap[T]**（5.2）+ server 归属绑定（5.8.6）：作恶半径可判定替代作恶意图判定 | 纵深 |

### 14.4 L3 语义注入：专项缓解栈

语义判定不在 Rice 范畴（自然语言语义连形式化性质都算不上），不走五出口，走信息流控制：

- **taint 标记**：工具结果入 LLM 上下文带 provenance；系统级规则"不可信来源文本不构成指令"——软缓解
- **结构化输出**：结果走 schema——"文本藏指令"变成 schema 校验（可判定）
- **输出侧监控**：即使 LLM 被注入，其发起的每个效果仍过宿主自己的 safety monitor——注入可发起意图，越不过效果系统
- **来源链升级审批**：从 taint 上下文导出的高敏感效果 → 审批自动升级

**诚实登记：L3 是缓解不消除——整个体系唯一没有理论出口的部分。** server 侧管控压低注入概率，宿主侧效果系统兜住注入后果——两层各管一半，合起来才叫管控，任何单层都不"完全"。

### 14.5 残余风险登记簿

五出口叠加后，残余收敛为三个登记项，每项有归属：

| 残余 | 状态 | 归属 |
|------|------|------|
| L1 沙箱逃生（三平台配置漂移/机制漏洞/TOCTOU） | 已缓解（置信度维护） | 沙箱配置模板 + 逃逸回归 CI（9.3 第 9 条） |
| L2 规则内滥用（白名单内破坏、资源滥用、协议演进追新） | 已缓解 | 路线 4 预算 + 路线 5 半径 + 协议版本跟踪（第 11 章） |
| L3 语义注入（借宿主合法权限作恶） | **架构性已接受** | 14.4 四重缓解栈（skill 指令面同构，装载期静态扫描可前移部分缓解，5.9） |
| L4 自举面（CLI/宿主/管控层自身的完整性——谁管管理者） | 架构外缓解 | 分发签名链 + 装载期参数拒绝 + 管控层代码签名（5.10.3）；架构内补判据独立重算器（5.11.5） |
| L5 管控层自我豁免（被注入后给自己颁发授权/豁免） | 已缓解（入口级硬排除） | No-Löb：META_CALLERS 不进授权/豁免通道（5.11.2，[T1]） |

### 14.6 与 LangQuanta 架构的同构

| LangQuanta | 本设计 |
|------------|--------|
| 内核只做可判定部分（判定器） | 监控器只做 safety 逐点判定、schema 校验、证明检查 |
| 提议者承担不可判定部分，结果不自动追认 | 语义理解交给 taint + 结构化 + 审批升级，不可信输入不自动生效 |
| unknown ≠ proved | 残余风险登记簿三栏登记（14.5） |
| 语法层排除而非实现兑底 | 声明式 DSL 在表达力层排除恶意行为（路线 1 最优先） |

### 14.7 正确表述

> **不存在"禁止恶意行为发生"的判定器；存在"表达半径、消耗预算、发生点拦截"三重可判定围堵。** 恶意被压缩到：走唯一通道、在能力闭包内、预算内，且每个动作在发生瞬间被逐点判定——不合规即断。

验收标准不得写"完全管控"，必须写"残余风险清单完备 + 每项有归属 + L3 有缓解通道"。

---

## 15. v3 → v4 变更记录

本版合并"MCP 内建与 OS 沙箱"、"不可判定性与管控谱系"两轮讨论结论。

| # | 变更 | 落点 |
|---|------|------|
| 1 | MCP client 收归管控层，通道唯一化 | 5.8.1 `McpRuntime` |
| 2 | 五面覆盖（调用/反向/结果/传输/生命周期） | 5.8.2 |
| 3 | 反向请求效果化：sampling/roots/elicitation | 5.8.3 + `EffectType` 三型 + `McpCapability` 扩展（4.1.1） |
| 4 | 结果面管控 + 结构化输出优先（路线 1 落点） | 5.8.4 |
| 5 | server 进程沙箱三档（trusted/signed/unknown） + 三平台机制 | 5.8.5 |
| 6 | isolate 联动 kill + 孤儿清理（堵 v3 残留洞） | 5.8.6 |
| 7 | 理论根基章：Rice 边界 + safety/liveness 分解 + 五出口谱系 | 第 14 章 |
| 8 | 残余风险登记簿（L1/L2/L3，三栏登记） | 14.5 |
| 9 | 诚实边界第 6 条改写 + 第 7 条新增；防御矩阵更新 7 行；退化第 9 条 | 9.1/9.2/9.3/9.4 |
| 10 | 验收 R24–R32 + 迁移 S19–S20 + 向后兼容两条 + 依赖四条 | 10.4 / 8.1–8.2 / 11 |

### v4 增补记录：skill 与 CLI 面管控

本增补合并"skill 能力与 CLI 能力在运行时管控层的监控约束"讨论结论，不出 v5、版本保持 v4。

| # | 变更 | 落点 |
|---|------|------|
| 1 | 核心洞察登记：skill 无独立执行通道，风险面在指令语义 | 5.9 引言 |
| 2 | skill 三面归属（装载/资源/指令） | 5.9.1 |
| 3 | SkillManifest 契约（与 PluginContract/McpCapability 三契同构）+ 来源三级统一 | 5.9.2 |
| 4 | 装载期全量静态扫描（L3 缓解前移——skill 是静态资产，优于 MCP 结果的逐次扫描） | 5.9.3 |
| 5 | 运行期效果归因联动 + taint 传递 | 5.9.4 |
| 6 | CLI 三面归属（启动面归装配层/运行面进审计/自举面登记） | 5.10.1 |
| 7 | root 调用者登记（`caller: 'dsh-root'`，审计完整性而非自我约束） | 5.10.2 |
| 8 | 自举限制登记为 L4（谁管管理者——不做层内假装覆盖） | 5.10.3 + 14.5 |
| 9 | 诚实边界第 8 条；防御矩阵 6 行；同构表 1 行（契约统一） | 9.1/9.2/9.4 |
| 10 | 验收 R33–R38（10.5）+ 迁移 S21–S22 + 包结构 skill/ 子目录 + 依赖三条 | 8.1/10.5/7.1/11 |

### v4 增补记录：LangQuanta DesignV4 纪律借鉴

本增补把 LangQuanta DesignV4（`D:\systool\LangQuantaPro\DesignV4`）经"提案→独立复核→裁定→落地"流程验证的工程纪律翻译为本架构治理条款（对照清单 10 条，采纳 9 条）。增补不出 v5、版本保持 v4。

| # | DesignV4 来源 | 翻译落点 |
|---|--------------|--------|
| 1 | C8 信任语义准入（保留字零新增的判定标准） | 5.11.1 增量准入纪律 + 9.3 第 10 条 |
| 2 | [T1]/[T2]/[T3] 证据分级 + 无实测不给数字 | 9.2 证据分级说明 + 9.1 第 9 条 |
| 3 | K15 一致性哨兵（冲突 ⇒ 冻结 + 不自动改判） | 5.11.3 审计一致性哨兵 |
| 4 | C10/§1.18.3 No-Löb 元层纪律（元记账不进对象证据） | 5.11.2：META_CALLERS 硬排除（root 不进授权/豁免通道） |
| 5 | §1.7 独立复核通道（.lqproof，复核器非第二判据） | 5.11.5 判据独立重算器 + 14.3 路线 2.5 |
| 6 | 码位零新增论证 + 一码一规则（K101–K105 事故预防） | 5.11.6 诊断码位登记表 SEC-xxxx |
| 7 | §1.6.4 三态披露 + 基线指纹（abandoned ≠ refuted） | 5.11.7（审批超时 deny ≠ 用户 deny） |
| 8 | A6 唯一载体（Trajectory 与 EvidenceLog 互指先例） | 5.11.4 EffectAuditEntry.assemblyPlanId 互指键 |
| 9 | 红线预算 + 枪毙条件（TCB 行数红线先例） | 5.11.8 管控层复杂度红线 |
| 10 | 裁定流程（提案→独立复核→裁定→落地，裁定通过≠生效） | 5.11.9 变更裁定流程 |

配套：验收 R39–R44（10.6）、迁移 S23、包结构 meta/ 子目录、14.5 补 L5 行、9.4/14.6 同构表各补行、依赖章补码位建档与红线口径。

**不采纳**：M-layer 数学基底（商类型/结构类/共归纳/经典公理包，与安全架构无关）；公理 RFC 全流程（对白名单变更过重，取第 10 条轻量裁定版）。

## 16. v4 增补记录：M0 前置调研结论与裁定落盘（2026-09-30）

本增补合并 M0 十项调研（T0.1–T0.10）结论与用户七项裁定（均采用推荐选项：1A dsh 侧包装层 / 2A 外部前置+并行补 / 3A trash npm 包 / 4A SEC-1007 独立登记 / 5A S19 接受上探 / 6A 红线 M2 一并裁定 / 7A 模式乙双线并行；两项事实性修正默认确认）。不出 v5、版本保持 v4。调研证据全文见《M0-调研建档/M0-调研报告.md》，码位登记见《M0-调研建档/SEC-码位登记表.md》，口径脚本见其 scripts/ 目录。

| # | 变更 | 落点 |
|---|------|------|
| 1 | park/resume 实现载体修正：vendor Fiber（生命周期原语，M0 证实无协程原语）→ dsh 侧 ApprovalGate 包装层，接口语义不变；P5 解耦为独立小项 | 5.3.6 实现载体段 + 8.1 S16 + 依赖注释 + 11 |
| 2 | acorn 选型确认：复用既有 8.17.0，零新增供应链面；`!!js` 裸 eval 替换点确证 | 11 |
| 3 | S19 范围上探登记：反向请求从零接线（现状 capabilities 空、无 setRequestHandler，攻击面为零） | 5.8.3 M0 修正段 + 8.1 S19 + 11 |
| 4 | fs.trash 落地边界扩充：ctx.fs 新增 trash/delete 方法 + fs-sandbox 同步 + 双后端实现；选型 trash npm 包（过依赖评审闸） | 11 |
| 5 | 三平台沙箱机制修订：复用 sandbox-local 既有链；seccomp/cgroup 默认不引入；AppContainer 列 mcp-signed 可选上探；挂载点 = createTransport + confine() | 5.8.5 + 11 |
| 6 | skill 表述事实性修正：执行体为纯 Markdown 指令，一切"执行"均为宿主侧副作用归因 | 5.9.1 + R36（10.5）+ 11 |
| 7 | 签名链双轨事实登记：Desktop 完备 / npm+wheels 全缺；裁定外部前置 + 最小签名链并行补 | 11 + 5.10.3（L4 缓解状态） |
| 8 | SEC 码位登记表初版落地：SEC-0901 / 1001–1014 / 2001–2004 + 段位留白；4.2.1 表补 fixture-module-dependency 行 | 4.2.1 + 5.11.6 + 11 |
| 9 | 红线口径固化：TS Scanner 词法权威 + 口径脚本自证（自测 4/4 + 对账闭合）；基线数字待 M2 一并裁定 | 5.11.8 + 11 |
| 10 | 性能基准选型：复用自研计时 harness，不引 tinybench/vitest bench() | 11 |
| 11 | §12 执行状态翻转：设计方案 → 已裁定基线，模式乙双线启动 | 12 |

---

## 17. v4 增补记录：OS 原语桥评估——Rust 化价值地图（2026-09-30）

本增补回答"哪些位置用 Rust 重写更有价值"，登记为 M4 批次 4b 的**裁定输入**（评估结论，未裁定执行）。不出 v5、版本保持 v4。源码核查基于 dsh 仓库快照（2026-09-30，全程只读零修改）。

### 17.1 判据与总论

价值三档判据，只有前两档配得上 Rust：

1. **结构性不可达**（最高档）：方案安全语义要求内核级原语，Node API 空白，TS 物理写不出（openat2、Job Object、PR_SET_PDEATHSIG、seccomp）。
2. **承重结构加固**：现有实现把安全正确性押在弱载体（手写 ABI、外部进程、事后查询式杀树）上，native 化把正确性从"约定 + 测试"升为"类型系统 + 内核保证"。
3. **性能**：本架构的**伪论据**——5.11.8 红线本就枪毙大的判定核心；膜/令牌判定是 Set 查找纳秒级；napi 跨界在热路径是负收益。

**总论（14.2 同源）**：语言不是判定面——TS 与 Rust 同样逐点可判定（Schneider 运行时强制）。本架构安全承诺靠"唯一通道 + 逐点强制"达成，不靠语言。**Rust 的价值不在管控层，在管控层的地基（OS 原语桥）。**

### 17.2 事实基座（2026-09-30 源码核查）

| 事实 | 来源 | 含义 |
|---|---|---|
| dsh 已有"窄原生组件 + prebuilds 分发"轨道：`landlock-run`（static-musl 静态二进制）+ `flock`（N-API 8 模块）经 `native/system/packages/<平台>/prebuilds.json` 分发 | native/system | 新增原生模块不是新工程形态，是沿既有轨道加站 |
| 三平台沙箱链 = 外部 runner 进程包裹；enforcement 自证：bwrap/landlock/seatbelt = `full`，**windows-acl = `partial`** | `sandbox-local/src/index.ts` | 最弱环节在 Windows，与 8.2"最弱平台最后"吻合 |
| Windows restricted token / ACL / 完整性标签经 koffi 在 JS 层手写 Win32 ABI（`createRestrictedToken`/`setEntriesInAclW`/`addMandatoryAce` + 裸指针 NativePtr + Buffer 手工编码 SID/ACL 结构） | `sandbox-windows-acl/src/ffi.ts` | 全仓唯一把**安全承重结构放在 JS 手写 FFI** 上的位置 |
| `landlock-run` 实现语言不入仓可考（预编译产物入库） | — | 诚实留白，不虚构 |

### 17.3 价值登记（P1–P6）

| 项 | 位置与内容 | 判据档 | Node 缺口 / 现状弱点 | 收益 | 形态与落点 | 状态 |
|---|---|---|---|---|---|---|
| **P1** | Windows 链 Win32 FFI 层 → 类型化原生绑定（windows-rs 系） | 第二档 | koffi 能写，但承重在 JS 手写 ABI + 裸指针——ABI 偏移/结构对齐/句柄生命周期任何一处错误都是**静默安全洞**，逃逸用例 CI 只能测已知路径 | 承重结构正确性交给编译器；windows-acl `partial` → `full` 的候选路径 | M4 批次 4b 与 S20 同锅裁定 | 已裁定（2026-10-01，A 分批落地：P1+P2 同批为镜像 TS 接口契约 `native/bridge.ts` 的 `WindowsAclBridge` 类型化接口位；真实 windows-rs 绑定并入 dsh 时实现） |
| **P2** | MCP server 进程树生命周期（spawnManaged：Windows Job Object / POSIX PR_SET_PDEATHSIG + 进程组） | 第一档 | Job Object 无 API；PDEATHSIG 无法对子进程设置；`taskkill /T` 事后查询式有竞态；killpg 对 setsid 逃逸子进程失效 | R28（isolate 联动 kill）承重；堵"server 孤儿"生命周期面（五面之一） | 与 P1 同一窄原生包 | 已裁定（2026-10-01，A 分批落地：P2 经 `McpRuntime.spawnManaged` 接入进程树生命周期，kill 走进程树终止；真实 Job Object/PDEATHSIG 并入 dsh 时实现） |
| **P3** | fs 效果 TOCTOU 原子链（openBeneath：openat2 RESOLVE_BENEATH / dirfd 逐组件 O_NOFOLLOW） | 第一档 | Node fs 无 dirfd/openat API，**结构性做不到**；5.3.3 realpath 先行属缓解非闭环（检查与打开间竞态窗口） | L1（TOCTOU）置信度从"缓解 + CI 维护"升"内核态结构性排除"——14.3 谱系路线 3 → 路线 1 的档位跃迁 | S12 预留接口位；M4 裁定后升级不重构处理器 | 已裁定（2026-10-01，P3 独立小收口：`FsEffectHandler` 新增 `open` 注入单点 + `openBeneathAtomically` 接口位；真实 openat2/dirfd 并入 dsh 时实现） |
| **P4** | seccomp-bpf 内嵌（Linux 档加固） | 第一档 | 无 syscall binding | bwrap 依赖 unprivileged userns（内核/发行版配置漂移面）的补强 | **条件触发**：逃逸用例 CI 实测暴露 bwrap 缺口时再议（第 16 章 #5"默认不引入"维持） | 条件项 |
| **P5** | macOS sandbox-exec 替代（自写 profile 编译器 / Endpoint Security） | 第一档 | — | deprecated 风险的长期预案（Apple 框架为 C 接口） | **条件触发**：Apple 实际移除 sandbox-exec 时；现档位维持 + 全禁降级预案（5.8.5）不变 | 条件项 |
| **P6** | strict 隔离域硬边界（vm 非安全边界——Node 官方立场，逃逸路径已知；真硬边界 = WASM 组件或独立进程，Rust 是 wasmtime 宿主候选） | 第一档 | vm 是假边界（安全剧场） | strict 档兑现"完全沙箱"承诺的前提 | **远期评估**：M5/G 终验时若 strict 档被实际启用再议——推翻"同进程 + ContractMap 类型回报"架构前提，C8 冲突大 | 远期项 |

### 17.4 否决清单（Rust 化无价值或负价值——防验收面膨胀）

| 位置 | 否决理由 |
|---|---|
| 膜 `membrane.ts` | Proxy trap 拦截面必须在 V8 堆内（ctx.get 返回 JS 对象）；Rust 只能拿序列化副本（丢引用语义）或跨界回调（每次 get 走 napi，慢 1–2 个量级）。**结构性不可迁移** |
| 令牌 `capability.ts` | 纳秒级 Set 查找；红线本就要求判定核心小；Rust 化净增 napi 桥复杂度（C8 违背） |
| 效果调度 / 审计链 / meta 哨兵与重算器 | async dispatch + 追加写日志 + 纯逻辑，事件循环是正确载体 |
| 审批 park/resume（S16） | waterfall + AbortSignal；裁定 1A 明确 dsh 侧包装层，与语言无关 |
| 装配校验器（S3–S5） | 绑定 acorn（T0.2 裁定复用）/ TS Compiler API / tsconfig paths；Rust 化 = 重写半个 TS 工具链界面 |
| 红线口径脚本（T0.9） | 词法权威已裁定 = TypeScript Scanner 单一口径，换语言自毁口径 |
| fs.trash（裁定 3A） | trash npm 包已裁定，不因语言偏好翻裁定 |

### 17.5 落点与纪律

1. **形态**：窄原生包，接口一锅（`spawnManaged` + `openBeneath` + 条件 seccomp），沿 `@deepseek-ai/node-addon-system` 既有模式。多数点不是"重写"而是**新增 OS 原语桥**（TS 本无对应物），真正接近"重写"的仅 P1。
2. **裁定落点**：M4 批次 4b 与 S20 同锅裁定（《里程碑规划》第 8 节批次 4c）；Linux 先行窗口 P3 收益最大，Windows 最弱先补（P1）。
3. **分发**：复用 prebuilds 载体（零新分发形态）；签名并入裁定 2A 最小签名链——sha256 清单的登记对象恰是 `.node` 与静态二进制。
4. **供应链**：Rust 工具链入仓按 T0.2 同纪律论证（依赖最小化 + cargo-audit/vet 入 CI）——唯一新增工程面。
5. **码位**：P1–P6 零码位新增（OS 原语桥是机制载体非诊断规则，5.11.1 纪律第 3 条）；落地后若引入新诊断面，再按增量准入走 SEC 论证。
6. **诚实边界**：即使 P1–P3 全做，L1 也只是置信度升级，**不得改写为"已消除"**（14.5）；P1 的价值判断基于承重结构形态，不指控现有 koffi 绑定存在实际缺陷——"值得迁移"≠"现在有洞"。

> AI生成