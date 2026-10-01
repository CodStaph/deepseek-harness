---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '6808bb5a-6833-4239-a926-7ee407008831'
  PropagateID: '6808bb5a-6833-4239-a926-7ee407008831'
  ReservedCode1: '34ed1e8e-f65b-4170-9cc3-a6b097d7220b'
  ReservedCode2: '34ed1e8e-f65b-4170-9cc3-a6b097d7220b'
---

# Cordis 装配控制层设计方案

> **文档状态**：草案，待用户审阅，暂不执行
> **涉及仓库**：`D:\systool\DSH\Harness\deepseek-harness-master`（以下简称 dsh 仓库）
> **设计日期**：2026-09-30
> **前置讨论**：基于"Cordis 是否可以改造成可动态校验的组合装配面"与"在 Cordis 内核与 dsh 使用之间划分装载/校验/安全管控层面"两轮讨论的共识

---

## 1. 背景与动机

### 1.1 现状

dsh 把 Cordis（`@deepseek-ai/cordis` v4.0.4，vendor 在 `vendor/cordis`）用作产品装配面，使用方式有三个层次：

- **服务运行时**：`Context` 为根，`ctx.inject([...], (ctx) => ...)` 做依赖查找，`Service` + `symbols` 声明服务协议，`Fiber` 管生命周期。全仓 1573 处引用 `Context`/`Service`/`symbols`/`ctx.inject`。
- **产品组合面**：整棵装配树写成 YAML entry 数组（`cordis.patch.yml`），配 `insert`/`id`/`disabled: !!js`/`inject`/`intercept`/`isolate`/`group`/patch，靠多层覆盖链（base patch → mode bundle patch → 用户 profile patch → `--patch`）按 id 最后写入生效。
- **治理/校验面**：为给无类型的配置层兜底，dsh 建了整套 `gen-`/`verify-` 脚本（`verify-cordis-config.ts`、`gen-cordis-catalog.ts`、`gen-cordis-api.ts`、`gen-cordis-inspect-catalog.ts`、`verify-cordis-config.ts`、`verify-runtime-closure.ts`、`verify-default-product-isolation.ts` 等，共 22+ 项）。

### 1.2 痛点

| 编号 | 痛点 | 代码证据 |
|------|------|----------|
| P1 | `!!js` 表达式在 YAML 中内联任意 JS，无类型、无编译期检查、运行期 `new Script()` 求值 | `cordis.patch.yml` 中 `disabled: !!js "!ctx.get('profileContext')"`、`mode: !!js process.env.DSH_TELEMETRY_MODE \|\| 'FEEDBACK_ONLY'` 等数十处 |
| P2 | 多层覆盖链的组合结果不可见、难排错 | base → bundle → user → `--patch`，同一行 id 被多层改、最终生效值隐式 |
| P3 | 组合语义错误只在运行期暴雷 | `verify-cordis-config.ts` 注释记录：inject 挂空平面、host 重复注册导致第二次抛错、preset 遮蔽 host 消费者所需路由 |
| P4 | Service 映射靠字符串 key，缺强类型契约 | `ctx.get('profileContext')`、`ctx.inject(['connection', 'webServer'], ...)` 无法编译期校验 |
| P5 | Fiber 生命周期诊断缺失 | Cordis 核心 4 处 TODO（含 `internal/fiber-info` 诊断缺陷） |
| P6 | 安全管控没有明确落点 | `!!js` 可执行任意代码、YAML 可加载任意包、敏感配置可被低信任层覆盖 |

### 1.3 根因

Cordis 的定位是"现代 JS 应用的元框架"，核心哲学是**运行期动态反射**——插件可在任意时刻 `ctx.get/set` 动态注册服务，组合空间在运行时是开放的。dsh 把它当作产品配置面使用后，长出了大量外挂校验脚本来做兜底，但这些脚本是**事后静态断言**，无法覆盖运行期动态失败，且散落在 CI 管线中，没有形成统一的控制面。

---

## 2. 设计目标

1. **在 Cordis 内核与 dsh 业务使用之间，划分一个独立的装配控制层**，收拢装载编排、校验、安全管控三块职责。
2. **把校验从"CI 脚本事后断言"升级为"装配管线内置步骤"**——结构性错误在装载期直接失败，可用性错误在运行期精确诊断。
3. **把安全管控从"没有"升级为"有明确落点"**——配置面不再是可以执行任意代码的口子。
4. **不推翻 Cordis 内核哲学**——内核仍然只管机制，不做策略判断；控制层做策略，但策略必须可声明、可审计、确定性可复现。
5. **收敛现有 `verify-*` 脚本**——控制层不是"又一个校验脚本堆积层"，而是把现有脚本的规则内化为自身的内部实现。

### 非目标

- 不追求静态封闭的类型系统（Cordis 运行期反射空间开放，不存在封闭的静态等价）。
- 不修改 Cordis 内核的挂载执行逻辑（路线 A，不改 vendor/cordis）。
- 不自动推导新权限或新策略（控制层执行被写死的规则，不做运行期自动决策）。

---

## 3. 三层分离架构

```
  ┌─────────────────────────────────────────────────────────────┐
  │  dsh 业务使用层                                             │
  │  只消费"已验证装配"，不管装配怎么做                          │
  │  · 各 packages/* 包通过 ctx.inject 消费服务                 │
  │  · 不再自己断言安全或组合正确性                              │
  └────────────────────────┬────────────────────────────────────┘
                           │ 已验证装配计划（Verified Assembly Plan）
  ┌────────────────────────┴────────────────────────────────────┐
  │  装配控制层（Assembly Control Layer）                       │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
  │  │ 装载编排      │  │ 校验          │  │ 安全管控      │     │
  │  │ Load          │  │ Validation    │  │ Security      │     │
  │  │ Orchestration │  │               │  │ Control       │     │
  │  └──────────────┘  └──────────────┘  └──────────────┘     │
  │  输入：多层 patch 源文件 + 运行态上下文                      │
  │  输出：已验证装配计划（Assembly Plan）+ 审计日志             │
  └────────────────────────┬────────────────────────────────────┘
                           │ 已验证装配计划 → 挂载指令
  ┌────────────────────────┴────────────────────────────────────┐
  │  Cordis 内核                                               │
  │  只提供机制，不做授权判断，不自我升级                        │
  │  · Context / Service / symbols / Fiber / loader            │
  │  · 运行期反射注册（保持不变）                                │
  └─────────────────────────────────────────────────────────────┘
```

### 3.1 边界纪律

| 层 | 职责 | 禁止 |
|----|------|------|
| Cordis 内核 | 提供机制（Context/Service/Fiber/loader） | 做任何授权判断、安全决策、自我升级 |
| 装配控制层 | 装载编排 + 校验 + 安全管控 | 运行期自动推导新权限；无限扩外挂脚本 |
| dsh 业务层 | 消费已验证装配，执行业务逻辑 | 自己断言安全或组合正确性 |

这条纪律保证安全管控是**确定性可复现**的，而非"智能体随机应变"的——呼应 LangQuanta 的"内核永不自动"原则。

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
  config:
    path: ':memory:'
    openAt: never
```

**向后兼容**：未声明 `contract` 的插件视为"无 provides/needs、plane=host、isolate=false"，保持现有行为不变。控制层可逐步迁移，不需要一次性给所有 100+ 行补声明。

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
4. 输出 `EffectiveNode[]`，作为校验器和安全管控的输入

**CLI 产物**：

```bash
# 查看展开后的有效配置
dsh config --expand

# 以 diff 形式查看覆盖链各层的变更
dsh config --expand --diff

# 干跑模式：展开 + 校验，不实际挂载
dsh config --dry-run
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
    trusted: {
      /** 本仓库 packages/* 下的包 */
      workspacePackages: boolean
      /** vendor/* 下的包 */
      vendorPackages: boolean
      /** npm registry 已签名的包 */
      signedRegistry: boolean
      /** 任意 npm 包 */
      arbitrary: boolean
    }
    user: {
      workspacePackages: boolean
      vendorPackages: boolean
      signedRegistry: boolean
      arbitrary: boolean
    }
    preset: {
      workspacePackages: boolean
      vendorPackages: boolean
      signedRegistry: boolean
      arbitrary: boolean
    }
    patch: {
      workspacePackages: boolean
      vendorPackages: boolean
      signedRegistry: boolean
      arbitrary: boolean
    }
  }
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

## 5. 文件级设计

### 5.1 包结构

```
packages/assembly/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # 对外入口
│   ├── contract.ts               # PluginContract 类型定义
│   ├── resolver.ts               # 有效配置展开器
│   ├── plan.ts                   # AssemblyPlan 类型定义
│   ├── pipeline.ts              # 装配管线（四段式编排）
│   │
│   ├── validators/
│   │   ├── static.ts            # 静态校验规则集
│   │   ├── dynamic.ts           # 动态校验规则集
│   │   └── types.ts             # Diagnostic/ValidationResult 类型
│   │
│   ├── security/
│   │   ├── trust.ts             # 插件信任源策略
│   │   ├── safe-eval.ts          # !!js 白名单求值器
│   │   ├── sensitive.ts          # 敏感配置覆盖保护
│   │   └── audit.ts              # 审计链
│   │
│   └── cli/
│       ├── expand.ts            # dsh config --expand
│       └── dry-run.ts           # dsh config --dry-run
│
└── tests/
    ├── contract.spec.ts
    ├── resolver.spec.ts
    ├── static-validators.spec.ts
    ├── dynamic-validators.spec.ts
    ├── safe-eval.spec.ts
    ├── sensitive-override.spec.ts
    └── audit.spec.ts
```

### 5.2 核心接口

```typescript
// packages/assembly/src/index.ts

export { type PluginContract } from './contract'
export { type EffectiveNode, type CompositionLayer, type OverrideRecord } from './resolver'
export { type AssemblyPlan, type CompositionGraph } from './plan'
export { type Diagnostic, type ValidationResult } from './validators/types'
export { type AuditEntry } from './security/audit'

/** 装配控制层主入口 */
export class AssemblyController {
  constructor(config: AssemblyConfig) {}

  /** 执行完整装配管线（展开 → 校验 → 安全 → 产出装配计划） */
  async assemble(input: AssemblyInput): Promise<AssemblyOutput>

  /** 仅展开有效配置（不校验、不挂载） */
  expand(input: AssemblyInput): Promise<EffectiveNode[]>

  /** 干跑：展开 + 校验 + 安全检查，不产出挂载指令 */
  dryRun(input: AssemblyInput): Promise<AssemblyPlan>
}

export interface AssemblyConfig {
  /** 仓库根目录 */
  root: string
  /** 信任策略 */
  trustPolicy: TrustPolicy
  /** 敏感路径配置 */
  sensitivePaths: SensitivePath[]
  /** env 白名单 */
  envWhitelist: string[]
}

export interface AssemblyInput {
  /** 覆盖链各层（按信任等级排序） */
  layers: CompositionLayer[]
  /** 运行态上下文快照 */
  runtime: RuntimeSnapshot
}

export interface RuntimeSnapshot {
  platform: string
  cwd: string
  env: Record<string, string | undefined>
  profileContext?: { name: string }
}

export interface AssemblyOutput {
  plan: AssemblyPlan
  audit: AuditEntry[]
  status: 'success' | 'validation-error' | 'security-denied'
  errors: Diagnostic[]
}
```

### 5.3 装配管线（Pipeline）

```typescript
// packages/assembly/src/pipeline.ts

export async function runPipeline(
  input: AssemblyInput,
  config: AssemblyConfig,
): Promise<AssemblyOutput> {
  // 1. 解析：读取多层 patch 源文件，解析为 entry 数组
  const layers = parseLayers(input, config)

  // 2. 展开：合并覆盖链，求值 disabled 表达式，产出 EffectiveNode[]
  const nodes = resolveEffectiveComposition(layers, input.runtime, config)

  // 3. 构图：根据 contract 声明构建依赖图
  const graph = buildCompositionGraph(nodes)

  // 4. 静态校验：执行所有静态规则
  const staticDiagnostics = runStaticValidators(nodes, graph)

  // 5. 安全检查：信任源、敏感覆盖保护
  const securityDiagnostics = runSecurityChecks(nodes, layers, config)

  // 6. 合并诊断，判定是否通过
  const errors = [...staticDiagnostics, ...securityDiagnostics].filter(d => d.severity === 'error')
  const status = errors.length > 0
    ? (securityDiagnostics.some(d => d.severity === 'error') ? 'security-denied' : 'validation-error')
    : 'success'

  // 7. 产出装配计划
  const plan: AssemblyPlan = { nodes, graph, validation: { diagnostics: staticDiagnostics }, security: { diagnostics: securityDiagnostics }, timestamp: new Date().toISOString(), layers }

  // 8. 写审计日志
  const audit = writeAuditLog(layers, nodes, plan)

  return { plan, audit, status, errors }
}
```

### 5.4 与 Cordis loader 的集成点

控制层不替换 Cordis loader，而是在 loader 之前插入一个"预装配"步骤：

```
现有流程：
  patch YAML → Cordis loader → 挂载执行

改造后：
  patch YAML → [AssemblyController.dryRun] → 通过？
                    ↓ 是                      ↓ 否
  装配计划 → Cordis loader → 挂载执行    报错中止（含结构化诊断）
```

**集成方式**：在 `packages/boot/app-boot/src/profile.ts` 的启动流程中，在调用 Cordis loader 的 `apply()` 之前，插入 `AssemblyController.dryRun()` 调用。如果 `status !== 'success'`，打印诊断信息并退出，不进入挂载。

**动态校验集成**：Cordis loader 的挂载是逐行的。在每行 mount 决策点，调用 `DynamicValidator.check()`，如果返回 error 级诊断，中止该行挂载并报告。

---

## 6. 迁移路径

### 6.1 分阶段迁移

| 阶段 | 目标 | 产出 | 风险 |
|------|------|------|------|
| **S1** | 搭建 `packages/assembly` 骨架 + 契约类型定义 | `contract.ts`、`plan.ts`、`index.ts`、空壳测试 | 无 |
| **S2** | 实现有效配置展开器 + CLI | `resolver.ts`、`cli/expand.ts`、`dsh config --expand` 可用 | 低 |
| **S3** | 迁移现有静态校验规则 | 把 `verify-cordis-config.ts` 的 12 条规则迁移为 `validators/static.ts` | 低（逻辑不变，只是搬位置） |
| **S4** | 实现 `!!js` 白名单求值器 | `security/safe-eval.ts`、替换展开器中的 `new Script()` | 中（需逐个验证现有 `!!js` 表达式全部通过白名单） |
| **S5** | 实现敏感配置覆盖保护 | `security/sensitive.ts`、`security/trust.ts` | 中（需确认现有配置不触发误报） |
| **S6** | 实现动态校验 | `validators/dynamic.ts`、与 Cordis loader 集成 | 高（触及启动流程） |
| **S7** | 实现审计链 | `security/audit.ts` | 低 |
| **S8** | 收敛现有 `verify-*` 脚本 | 将 `verify-cordis-config.ts` 改为调用 `packages/assembly` 的 API | 中（需保持 CI 门禁行为一致） |

### 6.2 `verify-cordis-config.ts` 的收敛方式

现有 `verify-cordis-config.ts` 是一个独立的 CI 脚本，在 `package.json` 中通过 `verify-cordis-config` 脚本调用。收敛方式：

1. S3 阶段：将 `verify-cordis-config.ts` 的逻辑迁移到 `packages/assembly/src/validators/static.ts`，保持行为一致。
2. S8 阶段：将 `scripts/verify-cordis-config.ts` 改为薄包装——调用 `AssemblyController.dryRun()`，格式化输出诊断。CI 门禁行为不变。
3. 最终：`verify-cordis-config.ts` 可考虑废弃，CI 改为调用 `dsh config --dry-run`（如果该命令已稳定）。

### 6.3 向后兼容保证

- **未声明 `contract` 的插件**：视为无 provides/needs、plane=host、isolate=false，行为不变。
- **现有 `!!js` 表达式**：S4 阶段逐个验证，确保白名单覆盖所有现有用例。如有不兼容的表达式，在迁移阶段放宽白名单或重构该表达式，而非直接报错。
- **CI 门禁**：S3/S8 阶段保持 `verify-cordis-config` 的退出码语义不变。
- **运行时行为**：S6 之前的阶段不改变 Cordis loader 的实际挂载行为，只是在启动前多了一步"干跑检查"。

---

## 7. 诚实边界

### 7.1 无法做到的

1. **静态封闭的类型系统**：Cordis 允许插件在运行期任意 `ctx.get/set` 动态注册服务，组合空间在运行时是开放的。控制层无法把这个开放空间封闭成静态类型等价。它能做到的是"提前失败 + 运行时精确诊断"，而非"静态证明"。

2. **消除所有运行期组合错误**：可用性错误（provider 条件激活后的依赖缺口、isolate 遮蔽后的消费者路由变更）本质上依赖运行态信息，只能运行时检测。控制层能做的是把诊断从"裸 throw"升级为"结构化诊断"。

3. **绝对安全的 `!!js`**：白名单求值器能阻止已知危险模式（函数定义、new、import、赋值），但无法证明"所有通过白名单的表达式都安全"——这依赖于白名单的完备性维护。它把攻击面从"任意 JS"收窄到"白名单内的安全子集"，但不等于零风险。

### 7.2 必须警惕的退化

1. **控制层变成"又一个校验脚本堆积层"**：必须限制它只做装载/校验/安全三件事，且把现有 `verify-*` 家族收敛为内部实现，而非无限扩外挂。
2. **白名单膨胀**：`!!js` 白名单和敏感路径配置如果无节制增长，会退化为"每个例外都加白名单"的治标不治本。需要一个审批流程：新增白名单条目需要记录理由和评审记录。
3. **动态校验的性能开销**：每次挂载决策都做依赖可达性检查，在 100+ 行的装配规模下可能影响启动速度。需要做增量检查（只检查受变更影响子图）或懒检查（仅在错误发生时回溯）。

### 7.3 与 LangQuanta 哲学的对齐

| 原则 | LangQuanta | 本设计 |
|------|-----------|--------|
| 内核永不自动 | 内核层不做自动判定 | Cordis 内核不做授权判断 |
| 三层分离 | 内核 + 提议者 + 治理 | 内核 + 控制层 + 业务层 |
| 诚实登记 | unknown ≠ proved | "已验证闭合" ≠ "运行时无异常"，控制层明确区分两者 |
| 可审计、可回滚 | 知识库版本化 | 审计链 + 覆盖历史 + `--expand --diff` |
| 先确认后落地 | 用户确认后才追认 | `--dry-run` 先校验再挂载 |

---

## 8. 验收标准

| 编号 | 验收项 | 验证方法 |
|------|--------|----------|
| A1 | `dsh config --expand` 正确展开 `cordis.patch.yml` 的多层覆盖链 | 对比展开结果与手动追踪的预期值 |
| A2 | `dsh config --dry-run` 检测出所有现有 `verify-cordis-config.ts` 能检测的错误 | 用相同输入运行两者，对比诊断输出 |
| A3 | `!!js` 白名单求值器通过所有现有 `cordis.patch.yml` 中的表达式 | 全量回归 `cordis.patch.yml` + 各 bundle patch |
| A4 | 敏感配置覆盖保护阻止低信任层覆盖 `sandbox-policy.mode` | 构造恶意 patch 尝试覆盖，验证被拒绝 |
| A5 | 动态校验检测到 preset 遮蔽 host 路由 | 构造遮蔽场景，验证运行期诊断输出 |
| A6 | 审计链记录完整 | 对比审计日志与实际装载/覆盖操作 |
| A7 | 现有 CI 门禁行为不变 | `verify-cordis-config` 在迁移前后退出码一致 |
| A8 | 未声明 contract 的插件行为不变 | 全量回归现有测试套件 |

---

## 9. 依赖与前置条件

- **acorn**（或等价 AST 解析器）：用于 `!!js` 白名单求值器的 AST 解析。需确认 dsh 仓库是否已有可用依赖，或需新增。
- **TypeScript 编译期类型回报**（可选）：S1 阶段可将 `PluginContract` 的 `provides`/`needs` 暴露为 `ContractMap` 类型，让 `ctx.inject` 在编译期获得 key 校验。此为增量改进，不阻塞主线。

---

## 10. 暂不执行说明

本文档为设计方案，**暂不执行**。待用户审阅确认后，再决定：

1. 是否按此方案落地；
2. 是否需要调整架构或优先级；
3. 从哪个阶段（S1–S8）开始。

> AI生成