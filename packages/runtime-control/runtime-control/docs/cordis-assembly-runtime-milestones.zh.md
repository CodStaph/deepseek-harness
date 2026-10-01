---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '883c32c5-5046-494c-9620-3d7abfaf7091'
  PropagateID: '883c32c5-5046-494c-9620-3d7abfaf7091'
  ReservedCode1: 'e3e3633f-07ae-49a5-864e-cc5240901d3d'
  ReservedCode2: 'e3e3633f-07ae-49a5-864e-cc5240901d3d'
---

# Cordis 装配与运行时安全架构落地里程碑规划

> **文档状态**：**v2 基线**（2026-09-30 重新规划）——M0 已收口（十项调研 + 七项裁定均推荐选项）；执行模式乙·双线并行已启动：批次 1a（S1）与批次 2a 骨架（S9）完成，批次 1b（S2/S3/S4/S5+S7 四任务并行）完成，批次 2a 余（S10 服务膜接线 + S11 令牌预颁发）完成，批次 1c（S6 动态校验）与批次 2b（S12 效果系统）双线并行完成（裁定 9A–16A 全部采用推荐选项），批次 1d（S8 verify-* 收敛）与批次 2c（S13 隔离域 + S14 违规处理）双线并行完成，**M1/M2 正式收口**（assemble() 接线补齐 + A1–A10/R1–R12 雏形全量回归 151/151 + 红线基线 1089 逻辑行已裁定追认，裁定 A1–A5/C1①/C2③ 全部默认推荐），批次 3a（S16 审批语义 + No-Löb 硬排除）与 S22（root 调用者登记）双线并行完成（C2 ③），**批次 3b（S17 mcp.call 效果 + exfiltration 外发检查 / S18 isolate 档 + post-hoc 收尾自检 + fiber 精确撤销 + 按目标写锁）双线并行完成**，**批次 3c（S15 全量回归 + 性能基准门禁 + 严格模式灰度收口）完成——M3 正式收口**（R13–R23 全验收面雏形，全量回归 190/190 + 性能门禁 `test:bench` 通过，严格模式灰度按表行 6/34 裁定：镜像已迁移能力面试点 + 灰度清算纪律），落点镜像工作区 `cordis-mirror/`；本版并入方案第 17 章 OS 原语桥评估（P1–P6），M4 增设原生桥裁定项（批次 4c），S12 增设 P3 接口位预留；**批次 4a（S19 MCP 深度内建：McpRuntime 通道唯一化 + sampling/roots/elicitation 反向请求效果化）已完成**（2026-09-30，全量回归 209/209 + R24–R28 雏形，从零接线见 §5.8.3 M0 修正/裁定 5A）；**批次 4b（S20 沙箱档位 + 生命周期）+ 批次 4c（OS 原生桥 P1–P3，裁定 A）已完成**（2026-10-01，全量回归 227/227 + 性能门禁 PASS；S20 三档 × 三平台模板 + confine 挂载点 + 逃逸用例集 + 残余风险登记簿 + spawnServer 进程树生命周期；P1 Windows 类型化绑定接口位 + P2 进程树 + P3 open 注入单点，表行 9/11/36/37 裁定与登记落地）；**批次 5a（S21 skill 面管控：SkillManifest 三契同构 + 来源三级 + 装载期静态扫描 + 运行期归因/taint）已完成**（2026-10-01，全量回归 245/245 + 性能门禁 PASS；S22 root 登记已随 M3 落地，本批次收口 M5 skill 面；SEC-6xxx 段 6001–6004 四条码位经信任语义论证登记，见 SEC 登记表 §6）；**批次 5b（S23 元层纪律收口：一致性哨兵 + 独立重算器 + 互指键 planId + 三态披露与基线指纹 + SEC 码位表机器化静态检查 + 红线基线终版）已完成**（2026-10-01，全量回归 260/260 + 性能门禁 PASS；sec-catalog 单一数据源挂 CI `check:sec`，R43；红线终版 1216 逻辑行已裁定追认，R44；SEC-7xxx 段经论证维持留白）；**G 终验收口（2026-10-01）**——R1–R44 全量复跑 260/260 + 性能门禁 PASS + 一致性扫描三项通过 + 残余登记簿复核（L3 保持架构性已接受）+ 红线复测 1216 未超；严格模式全量检查表（灰度标志去留清单）已裁定（表行 10，采纳 8 项建议）；M0–G 全里程碑完成（见第 10 节 G 完成记录）
> **规划依据**：《Cordis装配与运行时安全架构设计方案》v4（S1–S23 迁移路径 / A1–A10 + R1–R44 验收标准 / 第 17 章 OS 原语桥评估）
> **涉及仓库**：`D:\systool\DSH\Harness\deepseek-harness-master`（dsh 仓库，全程只读零修改）
> **镜像工作区**：`D:\systool\Harness\cordis-mirror\`（M1/M2 双线代码落点，收口后平移入仓；落点裁定见第 14 节表行 4）
> **规划日期**：2026-09-30
> **编号说明**：本规划 M0–M5 编号自洽于本文档，与 LangQuanta 项目 M 系编号无关

---

## 1. 规划原则

把方案第 8 章 23 个迁移阶段（S1–S23）分解为**可裁定、可并行分派、可逐门禁验收**的里程碑批次。四条纪律贯穿全程：

1. **依赖先行**：批次划分以方案 8.1 依赖注释为硬约束——S16–S18 依赖 S12；S19–S20 依赖 S17；S23 依赖 S16；**No-Löb 排除随 S16 强推先置**。
2. **风险隔离**：四个高风险阶段（S6 / S12 / S13 / S16）各自单独收口，不与其他变更混合提交——失败可精确回滚、精确归因。
3. **兼容灰度**：每个侵入性机制配向后兼容标志（方案 8.2 全清单，见本规划第 12 节演进表），严格模式只在里程碑收口后前移一档，不做一步到位。
4. **验收即门禁**：每个里程碑以方案验收编号（A/R）为唯一放行标准，验收不过不进下一里程碑。全绿 ≠ 架构一致（方案 9.1 第 9 条），终验 G 另含一致性扫描与残余登记簿复核。

---

## 2. 里程碑总览

| 里程碑 | 范围（S 阶段） | 验收门禁 | 风险峰 | 关键前置 |
|--------|---------------|---------|--------|---------|
| **M0** 前置调研与基线建档 | 第 11 章全部依赖项调研；SEC 码位回溯建档；红线口径固化 | 调研报告交用户审阅 | 无 | 无（全并行） |
| **M1** 装配控制层 | S1–S8 | A1–A10 | S6（高） | M0 结论 |
| **M2** 运行时管控层基础 | S9–S14 | R1–R12 | S12、S13（高） | M1 产出的 AssemblyPlan（接口可先行） |
| **M3** 智能体运行语义 | S15–S18 | R13–R23 | S16（高） | S12 完成；Fiber park/resume 结论 |
| **M4** MCP 深度内建 + OS 原生桥 | S19–S20 + 原生桥裁定（P1–P6，方案第 17 章） | R24–R32（原生桥验收承载见第 8 节） | S19、S20（高） | S16 审批语义 + S17 外发检查就绪；P3 依赖 S12 接口位预留 |
| **M5** 三面收口 | S21–S23 | R33–R44 | 中 | S21/S22 仅需 S12；S23 需 S16 |
| **G** 终验 | 全架构 | R1–R44 全量复跑 + 一致性扫描 + 残余登记复核 | — | M5 完成 |

**默认路线**：

```
M0 ─→ M1 ─→ M2 ─→ M3 ─→ M4 ─→ M5 ─→ G
```

**弹性条款**（供压周期时使用，均不违反依赖约束）：

- M1 与 M2 可**双线部分并行**：S9–S12 不依赖装配层实现（膜/令牌/效果本体可独立开发），唯一串行集成点是 S6 与 S10 同在 Cordis 挂载路径。见第 3 节。
- M5 的 S21/S22 仅依赖 S12，**最早可提前至 M3/M4 期间并行插入**（S22 属"机会任务"，方案标注可随时插入）；S23 依赖 S16，最早可在 M3 后启动。默认排在 M4 后是为了终验一次收口。
- S16–S18 与 S13–S15 可交叉推进（方案 8.1 明示）——M3 内部已按此组织。
- **OS 原生桥不占关键路径**（方案第 17 章）：P1/P2/P4/P5 不依赖 M1/M2 主线，仅 P3 依赖 S12 接口位——预研可与 M2/M3 并行（镜像工作区内，不触 dsh 主线），落地 gate 在 M4 批次 4b 裁定。

**执行模式三选一（已裁定 2026-09-30：乙·双线并行）**：

| 模式 | 内容 | 适用 |
|------|------|------|
| 甲·串行稳妥 | M0→M1→M2→M3→M4→M5→G，逐里程碑收口 | 单人/小团队，验收纪律最严 |
| 乙·双线并行（推荐） | M1 与 M2 骨架并行（装配线 S1–S5+S7+S8 ∥ 运行时线 S9–S12），S6+S13 两个高风险点串行收口 | 多代理并行分派，周期最短 |
| 丙·风险前置 | M0 后先做三个高危 PoC（S6 loader 集成、S12 效果系统、Fiber park/resume），可行性验证后再铺开 | 对 S6/S12 触及面心里没底时 |

---

## 3. 依赖关系与并行度分析

### 3.1 硬依赖 DAG

```
S1 ─→ S2 ─→ S3 ─────────────┐
 │      ├─→ S4（白名单求值器）  ├─→ S6（loader 集成，高）─→ S8（收敛 verify-*）
 │      └─→ S5（敏感保护接线）  │
 └─→ S7（审计链，独立）─────────┘
S9 ─→ S10（膜）─┐
 └─→ S11（令牌）─┼─→ S12（效果系统，高）─→ S13（隔离域，高）─→ S14 ─┐
                                    │                              ├─→ S15（全量回归+灰度）
                                    └─→ S16（审批语义，高）─┬─→ S17（mcp.call+外发）─→ S19 ─→ S20
                                                           └─→ S18（isolate/post-hoc/写锁）
S12 ─→ S21（skill）    S12 ─→ S22（root 登记，无其他前置）
S16+S12 ─→ S23（元层；No-Löb 已随 S16 先置）
```

### 3.2 并行分派要点

- **类型先行**：S1 的 `PluginContract`/`AssemblyPlan`/`CapabilityDeclaration` 类型是 M1、M2 全部任务的公共语言——S1 完成后两条线即解耦，M2 的令牌预颁发器可基于类型 + mock 装配计划开发，M1 收口后联调接线。
- **集成点收口串行**：S6（动态校验 + loader 集成）与 S10（膜安装）同触及 Cordis 挂载执行路径——两者合并为唯一"挂载集成收口"，单独提交、单独全量回归。
- **独立可测机制先做**：S3 校验器（接口 `(nodes, graph) => diagnostics`）、S4 求值器、S7 审计链、S5 规则本体，均可类型驱动 + 测试数据先行，接线留到 S2 展开器就绪后。
- S21 的静态扫描器与 S3 **复用同一诊断框架**（方案 5.9.3），S21 开工前确认 S3 的 Diagnostic 体系已稳定。
- **OS 原生桥独立线**（方案第 17 章）：P1/P2/P4/P5 与 M1/M2 主线零依赖，仅 P3 锚定 S12 的 fs 处理器接口位——原生桥可全程并行预研，落地时点由 M4 批次 4b 裁定 gate；裁定不通过则各点维持现状登记，不产生任何主线性返工。

---

## 4. M0：前置调研与基线建档

**性质**：纯调研 + 文档建档，不改任何运行时行为。全部任务可并行分派独立子代理。

| 任务 | 内容 | 产出 | 服务的后续阶段 |
|------|------|------|--------------|
| T0.1 | **Fiber park/resume 评估**（关键路径）：核查 `vendor/cordis/src/fiber.ts` 是否已提供 park/resume；缺失则给出实现方案（同时是 P5 Fiber 诊断缺陷的直接补课） | 评估结论 + 实现位置建议 | S16（决定其是否需先行实现一步） |
| T0.2 | **acorn 可用性**：dsh 仓库已有依赖或需新增 | 依赖清单 | S4 |
| T0.3 | **mcp-client API 形态**：确认可被效果处理器包裹（异步、可取消） | 适配层设计输入 | S17、S19 |
| T0.4 | **跨平台回收站抽象**：dsh native 层可复用性（Windows Shell API / macOS ~/.Trash / Linux 降级 `$DSH_HOME/.trash`） | 抽象方案 | S16（fs.trash） |
| T0.5 | **OS 沙箱机制调研**：Linux Landlock/seccomp-bpf/cgroup、macOS sandbox-exec（deprecated 风险）、Windows AppContainer 配置成本 | 三平台档位可行性矩阵 | S20 |
| T0.6 | **skill 装载链调研**：`dsh-skill-filesystem` 清单格式可扩展性（trust/capabilities 字段兼容位） | 接入点方案 | S21 |
| T0.7 | **签名链基础设施**：dsh 发布管线是否已有签名步骤；缺失则登记为 S20/S22 外部前置（方案第 11 章预告） | 现状登记 | S20、S22（L4 缓解） |
| T0.8 | **SEC 码位回溯建档**：既有校验规则（4.2.1 十二+一条）逐条分配 SEC-xxxx 码位，一码一规则登记 | 码位登记表初版 | R43 前置，S23 收口 |
| T0.9 | **红线口径固化**：runtime-control 判定核心"逻辑行口径"（剔除注释+空行）复测脚本建立；**基线数字不在此阶段给出**（无实测不给数字） | 口径脚本 | M2 收口首次实测，M5 用户裁定追认 |
| T0.10 | **性能基准框架选型**：服务膜 + 效果系统的开销测量方案 | 框架选型 | S15（M3 建门禁） |

**收口**：调研报告汇总交用户审阅；若结论与方案假设不符（尤其 T0.1），相应批次范围回炉调整——这是 M0 存在的意义。

**M0 收口记录（2026-09-30）**：十项任务全部完成（产出《M0-调研建档/M0-调研报告.md》+《SEC-码位登记表.md》+ 口径脚本 count-logical-lines.mjs，自测 4/4）。七项裁定均采用推荐选项：1A Fiber=dsh 侧包装层 / 2A 签名链=外部前置+并行补 / 3A 回收站=trash npm 包 / 4A SEC-1007=独立登记 / 5A S19=接受上探 / 6A 红线=M2 一并裁定 / 7A 执行模式=乙·双线并行。六条回炉建议全部采纳并已落入方案 v4 增补记录（第 16 章）与本文档第 5–9 节标注。dsh 仓库全程零修改（只读调研）。

---

## 5. M1：装配控制层（S1–S8，验收 A1–A10）

**目标**：装载期门卫上线。向后兼容承诺：不改变运行时行为，只在启动前多一步干跑检查（方案 8.2）。

### 批次 1a：骨架与契约（串行起步，规模小）✅ 已完成（2026-09-30）

- **S1**：`packages/assembly` 骨架 + `contract.ts`（PluginContract + CapabilityDeclaration）+ `plan.ts`（AssemblyPlan + CapabilityGrantPlan）+ `index.ts`。
- 完成后 M2 线即可解锁（类型先行）。

**批次 1a 完成记录（2026-09-30）**：S1 骨架已落地于镜像工作区 `cordis-mirror/packages/assembly/`，编译自检通过（tsc 6.0.3 严格模式，对齐 dsh 仓库 ESM/Node24）+ 冒烟 3/3。落地文件：`contract.ts`（契约与六面能力声明，含 v4 McpCapability 反向请求三型）/ `plan.ts`（AssemblyPlan + CompositionGraph + CapabilityGrantPlan + TokenGrant + AssemblyStatus）/ `resolver.ts`（**纯类型**——EffectiveNode/CompositionLayer 等展开器类型属公共语言先行落地，展开逻辑留 S2）/ `validators/types.ts`（Diagnostic 含 SEC 码位预留字段 code）/ `security/audit.ts`（AuditEntry + SecurityAudit 类型）/ `index.ts`（AssemblyController 骨架——expand/dryRun/assemble 三方法显式抛"未实现"并标注落地阶段，不假实现）。**零码位新增**（纯类型骨架，不触碰新信任授予通道；SEC-1001–1014 既有登记覆盖 S3 规则面）。M2 线自此解锁：令牌预颁发器可基于类型 + mock 装配计划开发。

### 批次 1b：四任务并行分派

| 子任务 | 阶段 | 说明 | 风险 |
|--------|------|------|------|
| 1 | **S2** 展开器 + CLI | `resolver.ts` 多层覆盖链摊平 + `dsh config --expand/--diff/--dry-run/--capabilities` | 低 |
| 2 | **S3** 静态校验迁移 | `validators/static.ts` 14 条规则（方案 §4.2.1 清单 13 条 + M0 补登 fixture 依赖检查/SEC-1007，裁定 4A；本行原记"13 条（12+1）"系计数误差，以方案表与登记表为准），迁移 `verify-cordis-config.ts` 逻辑，行为一致（A2/A7 对拍基准） | 低 |
| 3 | **S4** `!!js` 白名单求值器 | `security/safe-eval.ts`：AST 白名单/黑名单 + 受限求值上下文；全量回归现有表达式（A3）。M0（T0.2）：AST 解析复用既有 acorn 8.17.0，零新增依赖 | 中 |
| 4 | **S5 + S7** | `security/trust.ts`（信任源四档策略）+ `security/sensitive.ts`（敏感覆盖保护，接线在 S2 展开器合并点）+ `security/audit.ts`（审计链，独立） | 中 |

**批次 1b 完成记录（2026-09-30，四任务并行分派四子代理）**：

- **S2**：`resolver.ts` 展开逻辑落地（保留 S1 类型导出）——信任序 patch→preset→user→trusted 逐层摊平、深合并（对象递归/标量数组替换）+ 真实变更字段路径的覆盖历史（OverrideRecord）、`disabled: !!js` 经注入回调受限求值、低信任层覆盖敏感字段抛 `SensitiveOverrideError`（装载中止，§4.3.3）、`buildCompositionGraph` 供 S3 消费；`cli.ts` 落地 `--expand/--diff`（`--dry-run` 待 S6/S11、`--capabilities` 待 S11，均显式占位标注不假实现）；层文件解析为 JSON 抽象，并入 dsh 时对齐 cordis-yaml.ts。
- **S3**：`validators/static.ts` 14 条规则齐备（SEC-1001–1014，码序唯一）——7 条既有规则忠实迁移 `verify-cordis-config.ts` 判定逻辑（每条 JSDoc 标注源函数行号/本阶段等价判定/并入对齐点），7 条新增规则基于 (nodes, graph) 直接实现；`StaticValidationContext` 可选第三参承载外部判定输入（declaredDependencies/sensitivePaths/layerTrust/nodeTrust）。A2/A7 对拍基准属并入 dsh 后全量回归。
- **S4**：`security/safe-eval.ts` 落地——acorn AST 双名单（7 白/8 黑）+ 三根标识符白名单（ctx/process/dshHomePath）+ process 属性面 + env 键白名单（6 键）+ `new Function` 参数遮蔽受控求值（无 eval/无 with，process 为冻结快照）；16 类逃逸向量用例全拒。**码位裁定（2026-09-30，裁定 8A）**：登记表 1001–1014 无"白名单求值违规"语义匹配项（1002 查非 disabled 元数据含 !!js、1003 查 disabled 语法错误，均非白名单校验违规）；按 §5.11.9 流程提案→独立复核→用户裁定，**登记 SEC-1015 并回填 toDiagnostic() code**（信任语义论证见 SEC 登记表 §4）。
- **S5+S7**：`security/trust.ts`（四档默认策略矩阵 + isSourceAllowed/allowedSourcesFor）+ `security/sensitive.ts`（SENSITIVE_PATHS 6 项 + checkSensitiveOverride，**SEC-1013 唯一实现**）+ `security/audit.ts` 写入实现（seq 单调序号单行 JSON 追加写入、回放容忍损坏行；不可篡改终证由 S23 哨兵与互指对账承接）。
- **主线集成接线（本批次收口）**：CLI `--expand` 默认接 S4 求值 + S5 敏感路径（defaultExpandOptions）；**SEC-1013 语义统一到方案 §4.3.3**——S3 规则面改为复用 sensitive.ts 唯一实现（一码一规则，消除子代理镜像基线的字段名偏差）；`SensitivePath` 类型唯一来源归 resolver.ts（sensitive→resolver 单向依赖，无循环）；`index.ts` 并入批次 1b 全部导出，`AssemblyController.expand()` 真实接线（dryRun/assemble 仍显式抛未实现，标注缺口 S6/S11 与 M1 收口）。
- **验收基线**：tsc 6.0.3 严格编译全绿；node:test 71/71（S1 3 / S2 7 / S3 29 / S4 11 / S5+S7 14 / S9 7）。**SEC 码位**：S3/S5 落在既有 1001–1014；S4 于批次收口后经裁定 8A 登记 SEC-1015（见上）；SEC-3xxx 段维持留白。dsh 仓库零修改复检 PASS。

### 批次 1c：高风险单独收口

- **S6** 动态校验 + Cordis loader 集成：挂载决策点四检查（依赖可达性 / 重复注册 / isolate 遮蔽 / 服务消亡告警），结构化诊断替代裸 throw。
- 收口动作：独立提交 + 全量回归现有测试套件 + 现有服务装载行为逐一对拍。

**批次 1c 完成记录（2026-09-30，与批次 2b 双线并行分派）**：
- **S6**：`validators/dynamic.ts` 落地挂载决策点四检查——SEC-2001 依赖不可达（error，含 missingService/consumers/potentialProviders 结构化诊断）/ SEC-2002 重复注册（error）/ SEC-2003 isolate 遮蔽（warning，动态面）/ SEC-2004 服务消亡告警（warning，卸载期独立入口 `checkServiceDeath`）；统一入口 `runDynamicValidation(ctx)` 汇总四检查，`leavingNode` 可选触发 2004。语义纪律：失败返回结构化诊断数组而非裸 throw；severity 档位与静态面 SEC-1012 一致。
- **接线**：并入 assembly/index.ts 导出；对 §4.2.2 上下文的合理扩展（`leavingNode` 可选字段保留——裁定 9A、`code` 在 DynamicDiagnostic 提升为必填、potentialProviders 原因推断口径接受——裁定 10A）已裁定，见第 14 节表行 12–13。
- **验收基线**：tsc 6.0.3 严格编译全绿；node:test 101/101（S6 新增 9）。dsh 仓库零修改复检 PASS。**SEC-2001–2004 已在登记表 §5 建档，零新增码位**。

### 批次 1d：收敛

- **S8**：`scripts/verify-*.ts` 家族改为 `AssemblyController.dryRun()` 薄包装，CI 门禁退出码一致（A7）。

**批次 1d 完成记录（2026-09-30，与批次 2c 双线并行分派）**：
- **S8（dryRun 整链 + CLI 收敛）**：`AssemblyController.dryRun()` 从"显式抛未实现"落地为真实装配管线——展开（S2+S4+S5 敏感保护）→ 静态校验（S3，SEC-1001–1014）→ 动态校验（S6，逐个节点挂载模拟四检查，SEC-2001–2003）→ 安全审计（S5 信任源面，buildSecurityAudit）→ 令牌预颁发计划（S11，buildCapabilityGrantPlan）；`buildDryRunPlan`/`simulateDynamicValidation` 导出，`planStatus` 派生 status（validation error → 'validation-error' / security error → 'security-denied' / 否则 'success'）。
- **CLI 收敛**：`cli.ts` 占位 `formatDryRun()` 移除，改为 `formatDryRunPlan(plan)`（error/warning 分列输出）+ `dryRunExitCode` 纯函数；入口按 status 非 success 设 `process.exitCode = 1`（A7：退出码一致）；`--expand/--diff/--capabilities` 行为不变。
- **S8 语义**：动态校验诊断复用既有 SEC-2001–2004（装配期不触发 SEC-2004 服务消亡，语义留 S16/卸载期）；敏感覆盖中止复用 SEC-1013。**零码位新增**。
- **验收基线**：tsc 6.0.3 严格编译全绿；node:test 新增 5 例（S8-1 合法输入 success / SEC-2002 重复注册检出 / SEC-2001 缺失依赖检出 / CLI 合法输出 SUCCESS / CLI 错误输入 dryRunExitCode=1）。S1-3 用例同步更新（dryRun 已实现，空 sources 走 loadLayers 显式报错）。dsh 仓库零修改复检 PASS。

**验收门禁（A1–A10）**：展开正确性、干跑对拍、白名单全量回归、恶意 patch 拒绝、遮蔽诊断、审计完整、CI 行为不变、未声明契约插件行为不变、overclaim 检出、令牌计划展示。

---

## 6. M2：运行时管控层基础（S9–S14，验收 R1–R12）

**目标**：内控系统上线：膜、令牌、效果、隔离域、违规处理。

### 批次 2a：骨架与双机制并行（S9 ✅ 已完成 2026-09-30；S10 ✅ S11 ✅ 已完成 2026-09-30）

- **S9**：`packages/runtime-control` 骨架。
- 并行：**S10** 服务膜（createMembrane + 膜配置注册表 + `installMembrane`）、**S11** 能力令牌（CapabilityToken + issuer + `--lenient-capabilities`）。
- 膜与令牌本体独立可测；与 M1 的接线（真实 AssemblyPlan 驱动预颁发）在 M1 收口后联调。

**S9 完成记录（2026-09-30）**：runtime-control 骨架已落地于 `cordis-mirror/packages/runtime-control/`，编译自检通过 + 冒烟 7/7。落地文件：`membrane.ts`（createMembrane 四类拦截 + SecurityViolation 结构化异常 + DEFAULT/SENSITIVE 双膜配置）/ `capability.ts`（CapabilityToken 私有构造 + `_issue` 工厂 + CapabilityHandle 编译期 key 校验（方案第 11 章类型回报）+ deriveFiberToken 只减不增 + TokenRenewalPolicy 类型）/ `effect.ts`（EffectType 全集含 v4 反向请求三型 + EffectAuditEntry 含互指键 assemblyPlanId）/ `index.ts`（仅导出已落地机制，不预导出 S10–S14 模块）。与 M1 的接线文件（issuer.ts / integration.ts）与灰度标志按批次规划留 S10/S11。骨架阶段两包零相互依赖（未来依赖方向 runtime-control → assembly 单向）。**SEC-3xxx 段维持留白**：膜/令牌/效果的判定逻辑码位待 S10–S12 落地时逐条论证登记，骨架零码位新增。

**批次 2a 余完成记录（2026-09-30）**：S10 服务膜接线 + S11 令牌预颁发双落地于镜像工作区。

- **S10**：`membrane-config.ts`（SENSITIVE_SERVICE_MEMBRANES 七项安全关键服务强膜 + STANDARD_SERVICE_MEMBRANES 默认膜 + buildMembraneRegistry 合并查询 + resolveMembraneConfig 兜底默认，方案 §5.1.4）/ `integration.ts`（installMembrane 覆盖 Context.get、返回对象前装膜、未注册回退 DEFAULT_MEMBRANE、原始值不包装，返回还原函数供卸载/测试隔离——对方案 §5.1.3 的最小工程增强）；两模块并入 runtime-control/index.ts 导出。
- **S11（镜像落地职责分工）**：方案 §5.2.3 的 filterAllowedMethods 过滤逻辑与预颁发计划生成下沉到装配层 `capability-grants.ts`（buildCapabilityGrantPlan 产出 CapabilityGrantPlan，含 `--lenient-capabilities` 判定、声明子面精确放行、session 过期）；运行时 `issuer.ts` 改为忠实消费计划实例化令牌（不二次过滤）——与方案 §6.1 管线第 6–7 步（装配层产计划）与第 10c 步（运行时按计划颁发）对齐，保持 runtime-control → assembly 单向依赖。`--lenient-capabilities` 灰度标志接入 CLI，`--capabilities` 子命令展示预颁发计划（A10 雏形）。
- **验收基线**：tsc 6.0.3 严格编译全绿；node:test 78/78（S10 2 + S11 装配层 3 + S11 运行时 2 = 新增 7）。dsh 仓库零修改复检 PASS。**SEC-3xxx 段维持留白**：issuer/计划生成为纯机制，未触碰新信任授予通道形态（§5.11.1 码零新增论证）；过滤语义落在既有 capabilities 声明 + SEC-1014 覆盖面。

### 批次 2b：高风险单独收口

- **S12** 效果系统：fs/net/proc/env 四类处理器 + `EffectApi` 暴露。**M0 边界扩充（裁定 3A）**：fs.trash 落地 = trash npm 包（过依赖评审闸）+ `ctx.fs` 服务新增 trash/delete 方法 + fs-sandbox 策略层同步 + fs-local/fs-sandbox 双后端实现。
- **P3 接口位预留（方案 17.3，v2 新增）**：fs 处理器的"边界检查 + 打开"实现为可替换单点（openBeneath 接口位）——S12 以 realpath 先行落地，M4 原生桥裁定通过后原子化升级不重构处理器；裁定不通过则维持 realpath 缓解，L1 登记不变。
- 迁移策略（方案 8.2）：**先作可选通道**——现有直接调 `node:fs` 的插件照常工作，新插件推荐走效果 API；逐包迁移，跟踪每插件迁移状态（9.3 第 5 条）。
- 收口动作：独立提交 + 每类效果处理器注入测试 + 性能首次基线测量。

**批次 2b 完成记录（2026-09-30，与批次 1c 双线并行分派）**：
- **S12**：`effects/handlers.ts` 落地四类处理器——FsEffectHandler（read-only 拒写/删、openBeneath realpath 边界、temp-area/trash-default 豁免、trash 双后端接口位、fs.delete-permanent 高门槛 deny）/ NetEffectHandler（域名白名单 + 出站数据外发检查 exfiltrationCheck）/ ProcEffectHandler（命令白名单，无 shell exec）+ EnvEffectHandler（读写白名单）；`effects/api.ts` 落地 `EffectApi` + `createEffectApi`（dispatch → SecurityViolation）。
- **M0 边界扩充（裁定 3A）**：`FsTrashBackend` 抽象接口 + `FsLocalTrashBackend`（本地 move-to-trash）；镜像内未引入 trash npm 包（依赖评审闸未过），并入 dsh 时经闸换包后端。**P3 接口位**：`openBeneath` 可替换单点以 realpath 先行落地（缓解非闭环，TOCTOU 竞态见方案 17.3）。
- **验收基线**：tsc 6.0.3 严格编译全绿；node:test 101/101（S12 新增 10）。dsh 仓库零修改复检 PASS。**SEC-3xxx 段维持留白**：四类处理器与 EffectApi 均为纯机制载体，未触碰新信任授予通道形态（§5.11.1 码零新增论证），判定逻辑码位留待后续阶段（S14 违规处理/S16 审批）落地时逐条论证登记。
- **待裁定项已裁定**（2026-09-30，裁定 11A–16A 全部采用推荐选项）：豁免通道权限覆盖面维持现状（11A）、env.get 异步化接受（12A）、net.connect/proc.spawn 占位语义接受（13A）、SEC-3xxx 段维持留白（14A）、trash 后端镜像占位维持（15A）、性能基线归入 S15（16A）——见第 14 节表行 14–19。

### 批次 2c：并行双任务

- **S13** 执行隔离域 standard 级（白名单 import + 原型链冻结 + `--no-realm` 兜底）——高风险：白名单可能破坏现有插件，逐一灰度验证。
- **S14** 违规处理 + 运行时审计（violation.ts，默认 `log-and-throw`）。

**批次 2c 完成记录（2026-09-30，与批次 1d 双线并行分派，S13/S14 双任务并行）**：

- **S13（执行隔离域 standard）**：`runtime-control/src/realm.ts` 落地机制三件套——`createWhitelistedRequire`（精确 + `*` 通配白名单，不命中抛 SecurityViolation，保留 require.resolve/cache/main/extensions，§5.4.3）/ `freezeCriticalPrototypes`（Object/Array/Function/Map/Set/Promise 六原型冻结 + `__proto__` 赋值拦截，§5.4.4）/ `assignRealmLevel`（§5.4.5 五分支）+ `REALM_LEVELS` 默认配置（§5.4.2，strict 仅类型占位远期不启用）。`--no-realm` 兜底以纯函数 `enableRealm({noRealm})` + `assignRealmLevel(...,{noRealm:true})→none` 承载（R12，零 I/O）。**工程细化**：`Error.prototype` 移出冻结集（实测冻结后 `Error.prototype.name` 不可写，`SecurityViolation` 及所有 Error 子类无法实例化，测试运行器自身错误构造失效——与方案对 `Service.prototype`"需确认是否允许冻结"的谨慎一致，JSDoc 已记录）。
- **S14（违规处理 + 运行时审计）**：`runtime-control/src/violation.ts` 落地 `ViolationPolicy`（'throw'|'log'|'log-and-throw'|'isolate'，isolate 声明为 S18 语义且 DefaultViolationHandler 明确拒绝而非静默降级）+ `ViolationContext`（pluginId/type: membrane|capability|effect|realm/auditEntry）+ `DefaultViolationHandler`（默认 log-and-throw：先经 `toAuditEntry` 归一化入装配审计链 `AuditEntry`，再按策略抛/降级）+ 薄适配 `auditViolationToDisk`（复用 appendAuditEntry 落盘）。`IsolateViolationHandler`/`PluginIsolatedError` 标注 S18 落地，不预实现。
- **SEC 码位**：S13/S14 均为纯机制/纯策略载体，违规复用 `SecurityViolation`（膜层），**零码位新增，SEC-3xxx 段维持留白**（论证入库于 SEC 登记表 §5.2 与两文件头 JSDoc，呼应裁定 14A）。
- **红线候选基线首次实测（T0.9 口径，M2 收口一并裁定）**：`count-logical-lines.mjs` 对 runtime-control 判定核心 10 文件实测——膜 110 + 令牌 175 + 效果类型 38 + issuer 28 + 膜配置 27 + 膜集成 26 + 隔离域 111 + 违规处理 61 + 效果处理器 427 + 效果 API 86 = **合计 1089 逻辑行**。**候选清单与数字交用户裁定追认（方案 5.11.8：基线由用户裁定后才生效；M5 终版追认不变）**。
- **挂载集成收口（模式乙）**：S6（dryRun 动态校验）与 S10（installMembrane 膜安装）同点全量回归一次通过（npm test 全量含 S6/S8/S10/S12/S13/S14 各机制，dsh 仓库零修改复检 PASS）。
- **验收基线**：tsc 6.0.3 严格编译全绿；node:test 122/122（S13 11 + S14 5 + S8 5 新增 21 例；既有 101 全量保持）。dsh 仓库零修改复检 PASS。

**收口附加项**：
- **红线候选基线首次实测**：膜拦截 + 令牌检查 + 效果判定主路径的逻辑行统计（T0.9 口径）已执行，**候选数字 1089 逻辑行（10 文件）待用户裁定追认**（方案 5.11.8：无实测不给数字；本处首次实测）。
- 挂载集成收口（若选模式乙）：S6 + S10 同点集成一次全量回归（已执行通过，见上）。

**验收门禁（R1–R12）**：膜拦截写入/defineProperty、令牌越界/撤销、read-only 拦截、workspace 外拒绝、效果审计完整、隔离域 import 拦截、原型污染拦截、违规入审计、lenient/no-realm 两模式全量回归不变。

---

## 7. M3：智能体运行语义（S15–S18，验收 R13–R23）

**目标**：管控机制支撑智能体实际运行方式——审批以分钟计、副作用成批发生、子代理并行工作。

### 前置（M0 裁定 1A 更新，2026-09-30）

- ~~Fiber park/resume 先行实现（作为 S16 第一步，同时补课 P5）~~ → **ApprovalGate 包装层**：T0.1 证实 vendor Fiber 无协程挂起原语（属插件生命周期原语），park/resume 语义由 dsh 侧包装层实现（复用 user-approval 既有 waterfall / AbortSignal / approval-asked-decided 审计对），vendor 零改动；P5（fiber-info 诊断）解耦为独立小项，不阻塞本批次。

### 批次 3a：审批语义（高风险单独收口）

- **S16** `effects/approval.ts`：三档授权（once/object/class）+ 封闭枚举豁免通道（same-session-artifact / temp-area / trash-default）+ park/resume 一等阻塞 + 超时自动 deny + 会话关停 cancel 全部 pending ticket（9.3 第 7 条强制语义）。
- **No-Löb 硬排除随本批次落地**（`meta/no-lob.ts`，META_CALLERS 不进授权/豁免通道——方案 8.1 强推先置项，服务 R39）。
- 回退标志：`--sync-approval`（保 v2 同步阻塞）、`--no-grant-memory`（授权记忆默认关）。

**批次 3a 完成记录（2026-09-30，与 S22 双线并行分派，C2 ③）**：

- **S16（审批语义）**：`effects/approval.ts` 落地 `ApprovalService`——三档授权（once 不记忆 / object 精确目标规范化 / class 同类全免不跨调用者）+ park/resume 一等阻塞（Promise 挂起 + decide 回调注入 + 手动 resolve 回填，先到先得幂等）+ 超时自动 deny（缺省 120s，`<=0` 回退缺省不可关闭，§9.3 第 7 条）+ `cancelAllPending`/`AbortSignal`/`dispose`（会话级授权随会话失效）+ 豁免通道封闭枚举（evaluateExemptionChannels：same-session-artifact 含 InMemoryProvenanceRegistry min 实现 / temp-area / trash-default；user-preauthorized 由 lookupGrant 命中 `grantedBy:'user'` 承载）+ delete-permanent 分档（不在低门槛豁免、须审批）。
- **No-Löb 硬排除（`meta/no-lob.ts`）**：`META_CALLERS`（'dsh-root'/'runtime-control'/'meta'/'meta#system'，精确匹配防前缀误伤）四个接线点（request 入口直接拒 / recordGrant 抛 SecurityViolation `reason:'no-lob'` / 豁免判定纵深 / lookupGrant 不消费授权记忆）。
- **ROOT_CALLER 统一收编**：no-lob.ts 与 root.ts（S22）最初各自定义 ROOT_CALLER；S22 落地后由主代理统一收编为 root.ts 唯一来源、no-lob.ts re-export——消除重复定义，文件接口不变。
- **审计字段**：九态（approvalDecision approved/denied/timeout/cancelled + exemption 四通道 + grantId 溯源 + reason），复用 effect.ts 既有字段集（零 effect.ts 改动），超时与用户拒绝按 §5.11.7 分列。
- **SEC 码位**：零新增，SEC-3xxx 段维持留白——S16 审批判定确为信任授予通道判定面，但 §5.11.1 准入裁定的是"允许存在"（由 §5.3.6 立项）而非"必须登记诊断码位"；判定出口以封闭枚举字段承载可定位性；decide 为注入回调不经执行面。No-Löb 拒绝以 `reason:'no-lob'` 承载。
- **验收基线**：tsc 6.0.3 严格编译全绿；node:test 151/151（S16 17 + No-Lob 4 + 既有 130）。dsh 仓库零修改复检 PASS。回退标志 `--sync-approval`/`--no-grant-memory` 作为选项承载，CLI 接线并入 dsh 启动器（镜像 `dsh config` 不含运行启动标志）。
- **未触及**：S17（mcp.call/exfiltration，R19）、S18（isolate 档/post-hoc/fiber 令牌/write-lock）——按批次 3b/3c 推进；effect.ts 零改动。

### 批次 3b：S16 后双任务并行

- **S17**：`mcp.call` 效果纳入 + `effects/exfiltration.ts` 数据外发检查（maxOutboundBytes + 敏感扫描 + 方向语义）。
- **S18**：isolate 档（IsolateViolationHandler + 阈值升级装配期禁用，9.3 第 8 条）+ `post-hoc.ts` 收尾自检 + `deriveFiberToken` fiber 粒度令牌 + `write-lock.ts` 按目标写锁。

**批次 3b 完成记录（2026-09-30，S17/S18 双线并行，M3 收官）**：

- **S17（mcp.call 效果 + 外发检查）**：
  - `effects/exfiltration.ts` 落地数据外发检查——`estimateOutboundBytes`（string/Uint8Array/对象 JSON 计量）+ `checkExfiltration` 三态（'pass'/'blocked'/'not-applicable'，ceiling 0/undefined=未声明出站能力→只允许读式）+ 敏感扫描器注入式策略（`DEFAULT_SENSITIVE_SCANNERS`：credentialFieldScanner 凭证字段名 + sessionTokenScanner 长令牌/Bearer 特征），对照 §5.3.8 与 TeleAgent 数据主权原则。
  - `effects/mcp.ts` 落地 `McpEffectHandler`（§5.3.7）：`McpClientAdapter` 抽象进程外调用适配层（镜像注入 mock，并入 dsh 换 packages/mcp 真适配）+ 判定链（契约能力检查 → server/tool 白名单匹配（精确或 '*' 通配）→ denyParamPatterns 参数黑名单 → 外发检查（复用 exfiltration）→ 审批 request → 执行 → 审计 server/tool/参数摘要/结果摘要/exfiltrationCheck）；未声明 mcp 能力 strict 拒绝 / lenient 降级 warning；未注入审批服务一律 deny（S16 语义）。
  - `api.ts` mcp.call 由占位抛错改为经注入 handler 分发接线；NetEffectHandler 复用外发检查（敏感扫描，R19），fetch 失败路径也落 exfiltrationCheck 保证可观测。
  - **SEC 码位**：零新增，SEC-3xxx 段维持留白（纯判定/观测载体，无信任通道，§5.11.1 准入）。
  - 语义精确化：`EffectAuditEntry.exfiltrationCheck` 对纯读式（无出站体）回 'not-applicable'（原 S12 测试断言 'pass' 已同步更新）。

- **S18（isolate 档 + post-hoc + fiber 精确撤销 + 写锁）**：
  - `violation.ts` 扩展 S18 isolate 档：`RuntimeController` 接口（revokePlugin / isolatePlugin / disablePlugin）+ `PluginIsolatedError`（非进程级异常）+ `IsolateViolationHandler`（撤令牌+卸载+审计隔离原因+抛 PluginIsolatedError，进程与兄弟插件存活，R20）+ `IsolateEscalationTracker`（同一插件累计隔离达阈值默认 2 次自动升级装配期禁用，写回 patch 层 disabled，§9.3 第 8 条防"隔离-重启"循环）+ 每次隔离产出 warning 级 post-hoc 报告（§5.5 配套纪律）。
  - `post-hoc.ts` 落地收尾自检：`runPostHocReview`（scope 插件/会话/任务三选一）→ 汇总效果调用与契约能力面比对 → findings 三型（undeclared-capability / capability-exceeded error 级 + artifact-unmarked warning 级），lenient 模式下唯一系统性清算点（R21）。
  - `fiber.ts` 落地 `FiberTokenRegistry`：register/revokeFiber（只撤单 fiber，兄弟不受影响 R22）/revokePlugin（整体摘除），配合 isolate 精确摘除单个子代理（§5.2.5 撤销链）。
  - `write-lock.ts` 落地 `EffectWriteLock`：同一 target 写效果串行化、不同 target 并行（R23 防并行子代理写同一文件交错损坏）；适用于 fs.write/trash/delete-permanent/env.set，fs.read 不加锁。
  - **SEC 码位**：零新增（纯机制/结构载体，不授予能力、不开辟信任通道）。
  - 未触及：S15（全量回归+灰度，批次 3c）、S19/S20（MCP 深度内建，批次 4a/4b）——`realm.ts`/`approval.ts`/`handlers.ts` 均已在此前批次落地，本批次只新增模块与薄接线。

### 批次 3c：全量回归与灰度收口

- **S15**：全量回归 + 严格模式灰度启动。
- 性能基准回归门禁建立（T0.10 选型落地，9.3 第 4 条：开销变化可见）。

**批次 3c 完成记录（2026-09-30，M3 正式收口）**：

- **严格模式灰度启动（`src/strict.ts`）**：`resolveCapabilityMode`（缺省 lenient 向后兼容 / `--strict` / `--no-lenient-capabilities` 切严格）+ `isStrictMode` + 灰度清算纪律判定 `gradientGate`（前一档全量回归绿 + post-hoc 清算零未解释越界才允许进下一档，§12 纪律 / 表行 34）。作为各机制 lenient/strict 判定的统一灰度开关（对照 §8.2 演进表）。
- **性能基准回归门禁（`benchmarks/runtime-control/bench-runtime-control.mjs`）**：自研计时 harness（T0.10：performance.now + 中位数 + 循环放大 + 预算常量写死不可被环境变量覆盖）——测量膜拦截 / 令牌检查 / 效果判定（temp-area 豁免写）三条判定核心主路径；首次实测基线（2026-09-30）：membrane 0.0007ms / token 0.0003ms / effect-fs-write 4.36ms，预算 = 基线 × ~3.5 headroom（0.1 / 0.1 / 15ms）；`npm run test:bench` 进 CI 门，数量级劣化即失败（§9.3 第 4 条：开销变化可见）。
- **全量回归**：183 → **190/190** 全绿（S15 新增 7 例）；dsh 仓库零修改复检 PASS。
- **SEC 码位**：零新增（纯模式判定/观测载体），SEC-3xxx 段维持留白。
- **验收门禁（R13–R23）**：M3 全验收面雏形就绪——三档授权 / provenance 豁免 / park/resume / 超时自动 deny / trash 分档 / MCP 白名单（R18）/ 外发拦截（R19）/ isolate 存活（R20）/ post-hoc 清算（R21）/ fiber 精确撤销（R22）/ 同目标写串行（R23）。
- **灰度收口结论**：严格模式灰度范围 = 镜像已迁移能力面（裁定 C2 ①，表行 34）；isolate 档开启按 §8.2（默认 log-and-throw，逐插件/全局配置开启 + post-hoc 强制）；全部灰度标志去留清单留待 G 终验（表行 10，本批次不预判）。

**用户裁定点**：严格模式灰度范围与推进时间表（capabilities 严格化自 S6 后已可第一档收紧，本处定第二档）——**已裁定（C2 ①，2026-09-30）**：镜像全量试点 + 灰度清算纪律，范围=镜像已迁移能力面。

---

## 8. M4：MCP 深度内建（S19–S20，验收 R24–R32）

**目标**：MCP 管控从调用面单点升级为五面内建 + OS 沙箱档位；堵 v3 残留洞（isolate 后 server 进程存活）。

### 批次 4a：通道唯一化 + 反向请求（高风险）

- **S19**：`mcp/runtime.ts` McpRuntime 收归全部 MCP 连接持有权 + `mcp/inbound.ts` 反向请求效果化（sampling/roots/elicitation 三型入 EffectType）。**M0 上探（裁定 5A）**：inbound 现状完全未接线（Client capabilities 空、无 setRequestHandler）——本批次含从零接线（capabilities 声明 + setRequestHandler 三型），攻击面现状为零。
- sampling 链逐环拦截依赖已就绪：S16 审批 + S17 外发检查（M3 产出）。
- 回退标志：`--legacy-mcp` 旁路；未声明能力 lenient 降级 warning。

**批次 4a 完成记录（2026-09-30，M4 首个高风险阶段单独收口）**：

- **S19（MCP 通道唯一化 + 反向请求效果化）**：
  - `mcp/runtime.ts` 落地 `McpRuntime`（实现 S17 `McpClientAdapter`，方案 §5.8.1）——`servers` Map **唯一**持有 MCP 连接；`registerServer`（McpServerBinding：归属插件/沙箱档位/spawn/传输方式，档位 OS 级配置留批次 4b）/ `call`（未登记 server 一律 `SecurityViolation` 拒绝——通道唯一化 R24；`--legacy-mcp` 旁路保留旧路径，§8.2 迁移）/`callTool`（业务层经 effect.mcp.call 到达的薄转发）/`killServersOf`（isolate 联动 kill，§5.8.6 堵 v3 残留洞）/`dispose`（孤儿清理）；生命周期以独立 `McpServerLifecycleEvent` 审计（不污染效果审计账）。
  - `mcp/inbound.ts` 落地 `InboundRequestHandler`（§5.8.3）——三型反向请求效果化入 `EffectType`（sampling-request/roots-request/elicitation-request）：sampling 逐环拦截（来源解析 → 未声明即拒/lenient 降级 → prompt 敏感核对 → 模型白名单 → maxTokens 预算截断 R25 → 宿主 LLM 采样 → **结果回传前 exfiltration** R26）；roots ⊆ 沙箱 workspaceRoot ∩ 声明 roots（R27）；elicitation 未声明即拒/走审批流 + 来源标注"来自 MCP server X"（R28）。
  - **M0 上探落地（裁定 5A）**：`attachProtocol` 从零接线——capabilities 声明汇总 + `setRequestHandler` 三型回调统一注册（真实 SDK 适配层注入点）。
  - **SEC 码位**：零新增，SEC-3xxx 段维持留白——本组件为既有判定面的新效果类型接入，判定出口以 EffectType 三型 + 后端字段承载，不新增信任通道（§5.11.1 准入）。
  - **验收基线**：tsc 6.0.3 严格编译全绿；node:test 新增 19 例（S19-1~19，R24–R28 雏形 + 通道唯一化 + 生命周期 + 从零接线）；**全量回归 209/209**（190 基线 + S19 19）。dsh 仓库零修改复检 PASS。

### 批次 4b：沙箱档位 + 生命周期（高风险）

- **S20**：三档沙箱（mcp-trusted/mcp-signed/mcp-unknown）+ 三平台模板化配置（`sandbox-profiles.ts`）+ 逃逸用例集回归 CI（9.3 第 9 条）+ `McpServerBinding` 生命周期绑定（isolate 联动 kill + 孤儿清理）+ 残余风险登记簿。**M0 精确化**：三平台机制直接复用 sandbox-local 既有链（bwrap/Landlock、Seatbelt、Windows ACL restricted token）；seccomp/cgroup 默认不引入、AppContainer 列 mcp-signed 可选上探；沙箱挂载点 = `createTransport` 处经 `ctx.sandbox.confine()` 包裹 argv。
- 平台灰度顺序：**Linux 先行，最弱平台最后**（方案 8.2）。

### 批次 4c：OS 原生桥裁定与落地（P1–P6，方案第 17 章；v2 新增）

- **裁定输入**：方案第 17 章价值地图（P1 Windows FFI 类型化绑定 / P2 进程树生命周期 / P3 TOCTOU 原子链 / P4 seccomp / P5 sandbox-exec 替代 / P6 strict 域硬边界）+ S12 接口位预留状态 + 逃逸用例 CI 首轮结果 + 预研产出（若已开展，见第 2 节弹性条款）。
- **裁定项**：第 14 节表行 11——落地范围三选一（推荐 A：P1+P2 随 S20 同锅裁定、P3 紧随独立小收口；B：仅 P2；C：全部暂缓维持现状登记）。
- **裁定通过后的落地序列**：窄原生包（沿 node-addon-system 模式，接口一锅 spawnManaged/openBeneath）→ prebuilds 分发接入（零新分发形态）→ 签名并入裁定 2A 最小链（sha256 清单对象即 .node/静态二进制）→ cargo-audit/vet 入 CI（T0.2 同纪律，唯一新增工程面）→ 验收承载落地（见下）。
- **不混批纪律**：原生桥落地不与 S19/S20 混提交——独立收口、独立回归（与 S6/S12/S13/S16 同纪律）；P4/P5 为条件触发项（触发条件见方案 17.3），裁定不含预做。

**批次 4b 完成记录（2026-10-01，与批次 4c 双线并行）**：

- **S20（沙箱档位 + 生命周期）**：
  - `sandbox/sandbox-profiles.ts`：三档 × 三平台模板（trusted 标准档 / signed 结果扫描加严 + sampling 默认拒 / unknown 全禁或显式 dry-run）；`makeSandboxProfile` 未知组合安全兜底 deny-all；`DEFAULT_MCP_UNKNOWN_MODE='deny-all'`（表行 9 裁定落地：安全默认值不转正）。
  - `sandbox/confine.ts`：`ctx.sandbox.confine` 挂载点（M0 精确化落地）——`minimalEnv` 剥离凭证 + `confineCommand` 按 gateway 渲染 runner argv（landlock-bwrap / seatbelt / windows-acl / dry-run / deny-all）；沙箱是收紧不是放宽。
  - `sandbox/escape-cases.ts`：逃逸用例集 E01–E14（路径/凭证/网络/进程/写面/TOCTOU + mcp-unknown 全拒 & dry-run 只读观察），`evaluateEscapeCase` 静态回归（R32 雏形）。
  - `sandbox/registry.ts`：残余风险登记簿（14.5 L1–L5）`RESIDUAL_RISK_REGISTRY` + `validateResidualRegistry` 完整性自检（CI 一致性扫描入口）。
  - `mcp/runtime.ts` 增强：`spawnServer`（confine 挂载 + `osBridge.spawnManaged` 进程树拉起 + mcp-unknown 非 dry-run 拒绝）；`killServersOf`/`dispose` 走进程树 kill（P2 接入，堵 server 孤儿）。
  - **验收**：tsc 6.0.3 严格全绿；新增 S20 测试 13 例；**全量回归 227/227**（209 基线 + S20 13 + 4c 5）；性能门禁 PASS；dsh 仓库零修改复检 PASS。SEC-3xxx 段维持留白（纯配置/机制载体，§5.11.1 第 3 条）。

**批次 4c 完成记录（2026-10-01，与批次 4b 双线并行，裁定 A 分批落地）**：

- **P1+P2 同批**：`native/bridge.ts` 落地窄原生包 TS 接口契约——`ManagedProcess` / `spawnManaged`（P2 进程树生命周期，Windows Job Object / POSIX PDEATHSIG 接口位）/ `openBeneathAtomically`（P3）/ `WindowsAclBridge`（P1 类型化绑定接口位，替换 koffi 手写 ABI）/ `sha256Hex` + `verifyBridgeManifest`（裁定 2A 最小签名链）/ `createMirrorOsBridge` + `MemoryManagedProcess`（镜像 mock，并入 dsh 换真实 native 实现，接口不变）。
- **P3 独立小收口**：`effects/handlers.ts` 的 `FsEffectHandler` 新增 `open` 注入单点（缺省 `openBeneath` realpath 现状；原生原子实现替换即升级，处理器不重构）——方案 17.3 / §5.3.3 接口位落地。
- **验收**：新增测试 5 例（4c-1~5，P1 注入位 / P2 进程树 / sha256 清单 / P3 open 单点）；全量回归 227/227 + 性能门禁 PASS；dsh 零修改复检 PASS。SEC-3xxx 段维持留白（OS 原语桥是机制载体非诊断规则，方案 17.5 第 5 条）。
- **并仓工程面（唯一新增）**：cargo-audit/vet 入 CI（T0.2 同纪律）；prebuilds 分发 + sha256 清单签名（裁定 2A）；真实 native 实现（windows-rs / openat2 / Job Object）并入 dsh 仓库时替换镜像 mock，接口不变。

**验收门禁（R24–R32）**：通道唯一化全仓扫描、sampling 未声明即拒/预算强制、采样结果外发拦截、roots ⊆ 沙箱交集、elicitation 来源标注、结果面扫描、isolate 联动 kill、mcp-unknown 默认全禁、三平台逃逸用例 CI 全绿。

**原生桥验收承载（裁定后生效，第 11 节纪律）**：优先强化既有 R28（kill 语义升级为 Job Object/PDEATHSIG 实测，含逃逸子进程用例）与 R32（TOCTOU 用例：窗口内换 symlink 必被拒；P1 落地后 koffi 路径 vs 类型化路径行为对拍 + enforcement partial→full 评估）；确需新增 R 编号时，先按 5.11.1 过码位准入再入验收池——防验收面静默膨胀。

**用户裁定点**：第 14 节表行 9（mcp-unknown 档位默认策略）+ 表行 11（OS 原生桥落地范围）。

---

## 9. M5：三面收口——skill / CLI / 元层（S21–S23，验收 R33–R44）

**目标**：剩余三个能力面纳入统一管控 + LangQuanta 元层纪律全部落地。

### 批次 5a：双任务并行

- **S21**：`skill/manifest.ts`（SkillManifest 三契同构 + 来源三级 trusted/signed/unknown）+ `skill/scan.ts` 装载期全量静态扫描（越权指令模式 / 敏感特征 / manifest 一致性）+ `skill/attribution.ts` 运行期效果归因 + taint 传递。复用 S3 诊断框架。**M0 事实修正**：dsh skill 执行体为纯 Markdown 指令（无脚本通道）——扫描对象为指令文本模式，R36 语义按"宿主侧副作用归因到 skill 来源"对齐；trust/capabilities 兼容位 = parseSkillFile 可选字段 + 默认 unknown。
- **S22**：`caller: 'dsh-root'` root 调用者登记 + 效果审计扩展 + L4 自举面诚实登记。低风险，本可前插任意里程碑（见第 2 节弹性条款）。

**S22 完成记录（2026-09-30，按 C2 ③ 与批次 3a 双线并行前插）**：
- `meta/root.ts` 落地：`ROOT_CALLER='dsh-root'` 常量（唯一来源）+ `isRootCaller` 判定 + `markRootAudit` 标注（复用 `EffectAuditEntry.caller` 语义，零新增审计字段——§5.11.1 最小扩散）+ `ROOT_SCOPE_NOTE`（L4 自举面诚实登记文本：root 自举面同样经受控效果系统、无豁免通道、全量审计；明示"谁管管理者"残余不做层内假装覆盖，登记为 14.5 L4 靠架构外手段缓解）。
- **与 No-Löb 收编**：no-lob.ts 的 META_CALLERS 引用 ROOT_CALLER（S22 落地后从 root.ts 导入，唯一来源）。
- **SEC 码位**：零新增（纯登记/标注载体）。验收映射 R37 雏形（root 调用者识别/标注基础设施）。
- **验收基线**：tsc 全绿；node:test 6 例（S22-1~6）。dsh 零修改。S21 维持 M3 后（依赖 S3 诊断框架稳定）。

**批次 5a 完成记录（2026-10-01，M5 首收口——S21 落地；S22 已在 M3 落地）**：

- **S21（skill 面管控，三件套 + 审计字段扩展）**：
  - `skill/manifest.ts`：`SkillManifest` 三契同构（与 PluginContract/McpCapability 同构，capabilities 复用 assembly 的 CapabilityDeclaration）+ 来源三级 `SkillTrust`（trusted/signed/unknown，与沙箱档位共用同一信任体系，§5.9.2）+ `parseSkillFile` 兼容位（缺省 unknown + 空能力面；非法 trust 降级 unknown 绝不伪装，防 super-admin 注入；R35 雏形）+ `meetsTrustLevel`/`isSkillLoadable` 装载判定。
  - `skill/scan.ts`：装载期全量静态扫描（§5.9.3 三类）——越权指令模式 `UNAUTHORIZED_DIRECTIVE_PATTERNS`（v1 五条：绕过审批/直接调 child_process/忽略 sandbox/关闭管控/外发规避暗示）+ 敏感内容特征 `scanSensitiveContent`（凭证字段/外发 URL+出行动词）+ manifest 一致性 `scanManifestConsistency`（指令引导动作超出 manifest 声明面 → mismatch）；统一入口 `scanSkill` + 装载决策 `decideSkillLoading`（unknown 默认不装载 + 越权 error 拒绝，R5）；**复用 S3 诊断框架**（Diagnostic/ValidationResult 形状取自 assembly，方案 §4.2.1/§5.9.3 复用要求）。
  - `skill/attribution.ts`：运行期效果归因（§5.9.4）——`skillCapabilityVerdict`（效果类型 × manifest 能力面比对：undeclared/exceeded/ok）+ `attributeSkillEffect`（`activeSkill` 归因链写入审计 + taint 传递：unknown/signed 来源的高敏感效果审批自动升级）+ `skillExceededDiagnostic`（capability-exceeded，R33 雏形）。`EffectAuditEntry` 新增可选 `activeSkill` 字段（§5.9.4 一等审计维度，最小字段扩散）。
  - **SEC 码位（SEC-6xxx 段首次落地）**：四条规则经 §5.11.1 信任语义论证登记——SEC-6001 skill-unauthorized-directive（R34）/ SEC-6002 skill-sensitive-content / SEC-6003 skill-manifest-mismatch（R33 一致性）/ SEC-6004 skill-capability-exceeded（R33 归因）——见 SEC 登记表 §6。skill 面为 M5 新管控面，越权措辞与 manifest 不一致构成可被冒充信任通道（与装配面 1001–1014 同族但面不同）。
  - **验收基线**：tsc 6.0.3 严格编译全绿；node:test 新增 18 例（S21-1~18，R33/R34/R35/R36 雏形）；**全量回归 245/245**（227 基线 + S21 18）。性能门禁 PASS（membrane 0.0005 / token 0.0003 / effect-fs-write 3.75ms）。dsh 仓库零修改复检 PASS。
  - **未触及**：S23（元层纪律，批次 5b）——哨兵/重算器/互指键收口/码位表静态检查/红线终版；skill 的真实装载链集成（dsh-skill-filesystem）并入 dsh 时对齐。

### 批次 5b：元层纪律收口

- **S23**（No-Löb 已随 S16 落地，此处收口其余）：
  - `meta/sentinel.ts` 审计一致性哨兵 + 通道冻结（矛盾 ⇒ 冻结 + 不自动改判）
  - `meta/recheck.ts` 判据独立重算器（复核器非第二判据）
  - 互指键 `EffectAuditEntry.assemblyPlanId`（A6 唯一载体移植）
  - SEC 码位登记表收口 + 静态检查（无重复码位、无未登记码）
  - 三态披露 + 基线指纹（放行/拦截/豁免分列；审批超时 deny ≠ 用户 deny）
  - 红线基线终版：M2 候选数字 + 全周期实测 → **交用户裁定追认**（R44：基线由用户裁定后才生效）

**验收门禁（R33–R44）**：skill 归因比对、越权指令检出、unknown 默认不装载、skill 脚本走效果系统、root 全量审计、CLI 非法参数拒绝、No-Löb 拒绝、哨兵冻结、互指键对账、重算器一致/冻结、码位静态检查、红线复测 CI 全绿。

**批次 5b 完成记录（2026-10-01，S23 元层纪律收口——M5 收口，批次 5a 承接 skill 面）**：

- **一致性哨兵（`meta/sentinel.ts`，§5.11.3，R40）**：`runSentinel` 检测三类元数据矛盾——grant-audit-mismatch（授权库记录无对应 allow 审计）/ dual-verdict（同目标 allow+deny 双判定）/ exemption-conflict（豁免命中但契约未声明）；产出冻结建议 `freezeTargets`（exemption / grant-memory 封闭枚举）+ 告警 + 登记，**不自动改判**（矛盾交人工裁定）。哥德尔第二边界定性 `SENTINEL_NOTE`（哨兵是检测器非证明）。冻结与 isolate 正交（isolate 管行为者、冻结管通道），不新增 ViolationPolicy 档。
- **判据独立重算器（`meta/recheck.ts`，§5.11.5，R42）**：`recheckDecisions` 独立最小检查器（权限矩阵 + 豁免规则，不含膜/域/MCP）重算审批样本——一致 ⇒ `cross_checked`（增强信心无语义后果）/ 不一致 ⇒ `frozen`（§5.11.3 同处置，不自动改判）；复核器非第二判据（不改变效果系统唯一判定地位）；是 14.5 L4（管控层自完整性）架构内唯一可行缓解。
- **三态披露与基线指纹（`meta/disclosure.ts`，§5.11.7，R41）**：`buildDisclosureReport` 放行/拦截/豁免分列统计 + 基线指纹（assemblyPlanId + trustPolicyFingerprint）；审批超时 deny 与用户 deny 分列（abandoned ≠ refuted，§5.11.7）。
- **互指键 planId（§5.11.4，A6 移植，R41）**：装配侧 `AssemblyPlan.planId` 唯一载体（`makePlanId` 时间摘要格式）+ 装配 index 接线；效果侧 `EffectAuditEntry.assemblyPlanId` 已有（S1 骨架），两本账按 planId 互指对账；三态披露与收尾自检据此挂基线指纹。
- **SEC 码位表机器化收口（§5.11.6 / 登记表 §7，R43）**：`scripts/sec-catalog.mjs` 单一数据源（SEC_CATALOG 内嵌 24 条）+ CI 静态检查两条——a) 代码引用码 ⊆ 登记表（扫 82 个 .ts，23 个引用码全在表内）/ b) 登记表 24 条唯一；挂 `npm run check:sec`（并入 `test` 门）。**SEC-7xxx 段经 §5.11.1 论证维持留白**（哨兵/重算器为检测器与核对器，非信任授予通道，对照 SEC-1015 执行语义先例；论证存档于登记表 §7.1）。
- **红线基线终版（§5.11.8，R44）**：count-logical-lines.mjs 对 `REDLINE-MANIFEST.conf`（判定核心 10 文件，M2 裁定追认清单）全周期实测 **合计 1216 逻辑行**（膜 110/令牌 175/效果 41/issuer 28/膜配置 27/膜集成 26/隔离域 111/违规 185/处理器 431/API 82）。较 M2 候选 1089 增 127 行，来源 M3–M5 各批次增补——**已裁定追认（2026-10-01，R44）**。
- **验收基线**：tsc 6.0.3 严格编译全绿；node:test 新增 15 例（S23 meta 12 + planId 3）；**全量回归 260/260**（245 基线 + S23 15）+ `check:sec` PASS。dsh 仓库零修改复检 PASS。SEC-3xxx/4xxx/5xxx/7xxx 段维持留白。

---

## 10. G：终验

- **R1–R44 全量复跑**（不抽样）。
- **一致性扫描**：两本审计账互指对账、码位登记表复核、诊断框架统一性。
- **残余风险登记簿复核**：L1–L5 每项状态与归属核实（14.5）；L3 语义注入保持"架构性已接受"定性，不得因验收全绿改写为"已消除"。
- **严格模式全量检查表**：全部灰度标志的最终去留决定（哪些转正、哪些保留）。
- **P6 远期评估复核**（方案 17.3）：strict 隔离域若在灰度中被实际启用，评估硬边界载体（WASM 组件/独立进程，Rust 为 wasmtime 宿主候选）——vm 非安全边界的登记在此复核；未启用则维持登记不承诺。
- 依据 9.1 第 9 条如实登记：全绿是已知攻击面矛盾实例检测通过，不是安全性的证明。

**G 终验完成记录（2026-10-01）**：R1–R44 全量复跑 **260/260** 全绿（不抽样）+ 性能门禁 PASS（membrane 0.0007ms / token 0.0009ms / effect-fs-write 4.92ms，均低于预算）；一致性扫描三项通过——①两本审计账经 `assemblyPlanId`/`planId` 互指对账锚点齐备（s23-planid 3 + s23-meta 12 + membrane 集成用例覆盖）；②SEC 码位登记表复核：`sec-catalog` 静态检查 24 条唯一、代码引用 23 码 ⊆ 表，文档与数据源核对一致，3xxx/4xxx/5xxx/7xxx 段维持留白；③诊断框架 static（SEC-1xxx）/dynamic（`DynamicDiagnostic extends Diagnostic`，SEC-2xxx）/skill（scan.ts 复用统一 Diagnostic，SEC-6xxx）三面共用统一基类；残余风险登记簿 L1–L5 齐备（validateResidualRegistry 自检被 s20 测试覆盖），**L3 语义注入保持「架构性已接受」定性，未因验收全绿改写为「已消除」**；红线复测 `REDLINE-MANIFEST.conf` 10 文件 **1216 逻辑行**与 M5 终版基线一致（未超红线）；P6 远期评估复核：strict 隔离域为仅类型占位、未在灰度实际启用 → 维持「登记不承诺」（硬边界载体 wasmtime 等不登记）；严格模式全量检查表（灰度标志去留清单）**已裁定（表行 10，采纳 8 项去留建议）**——详见表行 10。按 9.1 第 9 条如实登记：全绿是已知攻击面矛盾实例检测通过，不是安全性的证明。**G 终验收口，M0–G 全里程碑完成。**

---

## 11. 验收—里程碑总映射

| 验收块 | 编号 | 里程碑 | 证据分级 |
|--------|------|--------|---------|
| 装配控制层 | A1–A10 | M1 | [T1] 机器可测为主 |
| 运行时管控基础 | R1–R12 | M2 | [T1] |
| 智能体运行语义 | R13–R23 | M3 | [T1]（R15 park 语义含运行时行为验证） |
| MCP 深度内建与沙箱 | R24–R32 | M4 | [T1]（R32 沙箱逃逸 = [T1]+[T3]：未知逃逸不承诺）；原生桥裁定落地后优先强化 R28/R32，新增编号须先过码位准入 |
| skill 与 CLI 面 | R33–R38 | M5 | [T1]+[T3]（R34 语义级漏检不承诺） |
| 元层纪律 | R39–R44 | M5 | [T1]（R44 红线基线待用户追认） |

新增验收项（如有）一律先分配 SEC 码位并附信任语义论证（5.11.1）再入验收池——防验收面静默膨胀。

---

## 12. 灰度与回退标志演进表

| 标志 | 引入于 | 作用 | 预定转正/退出 |
|------|--------|------|--------------|
| `--lenient-capabilities` | M2（S11） | 未声明契约插件视为全能力 + warning | M3 灰度收紧 → M5 后评估移除 |
| `--no-realm` | M2（S13） | 关闭隔离域，行为不变 | S13 灰度稳定后移除 |
| `--sync-approval` | M3（S16） | 回退 v2 同步阻塞审批 | park/resume 稳定后移除 |
| `--no-grant-memory` | M3（S16） | 授权记忆默认关闭 | 豁免通道逐条灰度后转正 |
| `--legacy-mcp` | M4（S19） | 业务包直连 packages/mcp 旁路 | 通道唯一化稳定后移除 |
| mcp-unknown 全禁开关 | M4（S20） | 未知来源 server 默认全禁 | 默认保持全禁（安全默认值不转正为放开） |
| isolate 档启用开关 | M3（S18） | 逐插件/全局开启 | 达阈值自动升级装配期禁用（9.3 第 8 条） |
| `--patch` 信任限制 | M1（S5） | patch 层仅允许 workspace 包 | 常驻安全默认值 |

每档严格化前移的统一纪律：**前一档全量回归绿 + post-hoc 清算零未解释越界**，才允许进入下一档（lenient 放过的必须在收尾报告点名归零）。

---

## 13. 统一收口纪律（每个里程碑必做）

1. **全量回归**：dsh 现有测试套件 + 本里程碑新增测试，全绿放行。
2. **验收编号逐条对账**：A/R 编号 → 测试用例 → 运行证据，缺一条不放行。
3. **码位登记同步**：本里程碑新增诊断/效果类型/能力域的 SEC 码位与信任语义论证随代码入库（5.11.1）。
4. **审计互指核验**：装配审计链与效果审计链按 assemblyPlanId 对账（M2 起）。
5. **文档与决策记录**：里程碑决策记录（含否决项与理由）登记入册；存量文档修改先建 `.swp` 备份、确认无误后经用户确认再清理。
6. **红线复测**：M2 首测、M5 终版，均走 T0.9 口径脚本。

---

## 14. 待用户裁定事项

| # | 事项 | 裁定点 | 裁定结果（2026-09-30） |
|---|------|--------|----------------------|
| 1 | 执行模式：甲串行 / 乙双线并行 / 丙风险前置 | 启动前 | **已裁定：乙·双线并行** |
| 2 | 启动里程碑（默认 M0） | 启动前 | **已裁定：M0 收口，M1/M2 双线启动** |
| 3 | Fiber park/resume 实现位置（vendor 内补课 vs dsh 侧包装层）——T0.1 结论出来后 | M0 收口 | **已裁定（1A）：dsh 侧包装层 ApprovalGate；P5 解耦为独立小项** |
| 4 | M1/M2 双线并行的具体分派（若选模式乙） | M0 收口 | **随 7A 生效：装配线 S1–S5+S7+S8 ∥ 运行时线 S9–S12；S6/S13 串行收口；批次分派见第 5/6 节。代码落点（2026-09-30 用户指示）：镜像开发于 `D:\systool\Harness\cordis-mirror\`，dsh 仓库全程只读零修改，收口后平移入仓** |
| 5 | S21/S22 是否提前插入 M3/M4 期并行 | M2 收口 | **已裁定（C2 ③，2026-09-30）：S22（root 登记，低风险）与批次 3a 双线并行前插；S21（skill 扫描，依赖 S3 诊断框架稳定）维持 M3 后** |
| 6 | 严格模式灰度范围与时间表（第二档） | M3 收口 | **已裁定（C2 ①，2026-09-30）：镜像全量试点 + 灰度清算纪律**——严格化范围限定镜像已迁移能力面（strict 默认 + 回退标志）；每档严格化前移统一纪律：前一档全量回归绿 + post-hoc 清算零未解释越界，才允许进入下一档（§12 表）；时间表随批次 3c 灰度收口落地 |
| 7 | 红线基线数字追认（M2 候选 → 终版） | M2 收口 / M5 收口 | **已裁定（6A，2026-09-30）：红线清单与候选基线 M2 收口一并裁定。M2 候选已裁定追认（A1 ①）：判定核心 10 文件合计 1089 逻辑行；M5 终版已裁定追认（2026-10-01）：全周期实测 1216 逻辑行（较 1089 增 127 行，来源 M3–M5 增补）** |
| 8 | 签名链基础设施缺失时，S20/S22 是否登记为外部前置搁置 | M0 收口 | **已裁定（2A）：登记外部前置；最小签名链（sha256 清单起步）并行补** |
| 9 | mcp-unknown 档位默认策略（全禁 vs 仅 dry-run 零权限档） | M4 开工前 | **已裁定（2026-10-01）：默认全禁，显式启用才可进 dry-run 零权限档**——演进表"安全默认值不转正为放开"落地；批次 4b（S20）按此接线（spawnServer 拒绝 mcp-unknown 非 dry-run 档） |
| 10 | G 终验后灰度标志去留清单 | G 收口 | **已裁定（2026-10-01，采纳 8 项去留建议）**：转出/常驻——`--lenient-capabilities` 移除（装配侧已缺省严格，宽松口由 post-hoc 清算承接）、`--legacy-mcp` 并入 dsh 时移除旁路（通道唯一化 R24 已落地）、mcp-unknown 全禁（deny-all）与 `--patch` 信任限制转正为常驻安全默认值；保留——`--no-realm`（none 兜底，并入 dsh 验证 standard 后定）、`--sync-approval`（park/resume 稳定后移除）、`--no-grant-memory`（默认关，豁免通道全量灰度后转正）、isolate 档启用开关（达阈值自动升级装配期禁用） |
| 11 | **OS 原生桥落地范围**（P1–P6，方案第 17 章）：A 分批落地（推荐——P1+P2 随 S20 同锅，P3 紧随独立小收口；P4/P5 条件触发登记维持；P6 远期评估维持）/ B 最小集仅 P2（R28 承重的结构性不可达项）/ C 全部暂缓（维持 realpath 缓解 + 外部 runner 现状，仅保留评估登记） | M4 批次 4b 收口 | **已裁定（2026-10-01）：A 分批落地**——P1+P2 随批次 4b 同批（窄原生包接口 + 进程树生命周期接入 McpRuntime.spawnServer），P3 紧随独立小收口（FsEffectHandler open 注入单点，不重构处理器）；P4/P5 条件触发登记维持；P6 远期评估维持 |
| 12 | **S6 `DynamicValidationContext.leavingNode` 可选字段**：保留（统一入口可汇总四检查，独立入口 `checkServiceDeath` 仍存在）/ 移除（严格贴合方案四字段） | 批次 1c 收口 | **已裁定（9A）：保留** |
| 13 | **S6 `potentialProviders.reason` 推断口径**：接受镜像阶段最小推断（disabled/plane-mismatch/overridden/not-yet-mounted 四因，表达式节点兜底）/ 并入 dsh 时细化 | 批次 1c 收口 | **已裁定（10A）：接受现口径，并入 dsh 时如需细化走变更流程** |
| 14 | **S12 豁免通道权限覆盖面**：维持现状（临时区写豁免、读不豁免）/ 额外收紧或放开 | 批次 2b 收口 | **已裁定（11A）：维持现状** |
| 15 | **S12 `env.get` 返回类型异步化**：接受 `Promise<string\|undefined>`（dispatch 异步的诚实实现）/ 强制同步签名 | 批次 2b 收口 | **已裁定（12A）：接受异步化，并入 dsh 时消费方按 Promise 对齐** |
| 16 | **S12 `net.connect`/`proc.spawn` 占位语义**：接受当前占位（connect 描述性占位、spawn 统一采集 stdout/stderr/code）/ 立即实现真实句柄 | 批次 2b 收口 | **已裁定（13A）：接受占位语义，真实句柄随 S19/S20 或 M3 spawnManaged 落地** |
| 17 | **S12 SEC-3xxx 段是否提前登记**：维持留白（纯机制载体，零码位新增论证）/ 提前登记审批判定码位 | 批次 2b 收口 | **已裁定（14A）：维持留白，S14/S16 落地时逐条论证登记** |
| 18 | **trash 后端镜像占位策略**：维持镜像 `FsLocalTrashBackend`（零新增依赖）/ 提前引入 trash npm 包 | 批次 2b 收口 | **已裁定（15A）：维持镜像占位，并入 dsh 时统一走依赖评审闸换包后端** |
| 19 | **批次 2b 性能首次基线测量归属**：归入 S15（自研计时 harness 统一落地）/ 本轮新建临时基准 | 批次 2b 收口 | **已裁定（16A）：归入 S15，不在本轮新建半套基准** |
| 20 | **红线候选基线清单与数字追认**（批次 2c 首测）：runtime-control 判定核心 10 文件（膜 110/令牌 175/效果类型 38/issuer 28/膜配置 27/膜集成 26/隔离域 111/违规 61/效果处理器 427/效果 API 86）合计 **1089 逻辑行** | 批次 2c 收口 | **已裁定（A1 ①，2026-09-30）：接受当前清单与数字，M5 终版追认不变** |
| 21 | **S13 隔离域冻结集剔除 `Error.prototype`**（对方案 §5.4.4 原清单的有意偏差）：接受（冻结致 `Error.prototype.name` 不可写，`SecurityViolation` 与全部 Error 子类无法实例化）/ 还原清单 | 批次 2c 收口 | **已裁定（A2 ①，2026-09-30）：接受剔除，Error 污染防护与逐类评估留 strict 级（S18/P6 远期）** |
| 22 | **S8 dry-run 动态校验不触发 SEC-2004**（装配期仅 2001/2002/2003；2004 服务消亡属卸载期独立入口） | 批次 1d 收口 | **已裁定（A3 ①，2026-09-30）：接受现状，2004 保持卸载期语义** |
| 23 | **S8 信任源最小实现**（镜像缺省 workspace 恒放行、不发射诊断；专用码位随并入 dsh 真实 provenance 注入再论证） | 批次 1d 收口 | **已裁定（A4 ①，2026-09-30）：接受登记** |
| 24 | **S14 违规审计归属**（违规写入装配审计链 AuditEntry 同账本，非独立运行日志；互指对账 S23 承接） | 批次 2c 收口 | **已裁定（A5 ①，2026-09-30）：接受同账本** |
| 25 | **M1/M2 正式收口先行**（S1–S8 与 S9–S14 全落地）：先做 A1–A10 + R1–R12 门禁全量回归 + `assemble()` 接线补齐（目前仍抛"未实现"）+ 红线基线终版确认，再进 M3 / 跳过收口直接批次 3a | M1/M2 收口 | **已裁定（C1 ①，2026-09-30）：正式收口后进 M3** |
| 26 | **下一批次**：批次 3a（S16 审批语义 + No-Löb 硬排，高风险单独收口）与 S22（root 登记机会任务）双线并行 / 仅 3a / 仅 S22 | M1/M2 收口 | **已裁定（C2 ③，2026-09-30）：3a + S22 双线并行** |
| 27 | **exfiltrationCheck 三态语义精确化**（纯读式/无出站体 → 'not-applicable'，原 S12 断言 'pass' 同步更新） | 批次 3b 收口 | **已裁定（A1 ①，2026-09-30）：接受三态语义（§5.3.8 方向语义），纯读不构成外发** |
| 28 | **mcp 默认敏感扫描策略**：`DEFAULT_SENSITIVE_SCANNERS`（凭证字段名 + ≥32 字符长串/Bearer 特征）作为 McpEffectHandler 与 NetEffectHandler 出站检查默认；误报面登记 L2 | 批次 3b 收口 | **已裁定（A2 ①，2026-09-30）：接受为默认，数据主权优先；误报可按需按插件级收紧** |
| 29 | **mcp.call 无审批注入恒拒绝 + lenient 未声明能力降级放行**（镜像阶段未注入 ApprovalService 一律 deny，S16"无审批不执行"） | 批次 3b 收口 | **已裁定（A3 ①，2026-09-30）：接受安全默认值，真实接线并入 dsh** |
| 30 | **isolate 阈值升级装配期禁用接线**（IsolateEscalationTracker 达阈值 → disablePlugin 回调；写回 patch 层 disabled 属并入 dsh 后装配层接线，镜像留接口位） | 批次 3b 收口 | **已裁定（A4 ①，2026-09-30）：接受接口位，并入 dsh 时经 disablePlugin 接线** |
| 31 | **fiber 撤销与 isolate 的接线归属**（FiberTokenRegistry 独立登记，revokeFiber/revokePlugin 经 RuntimeController 注入） | 批次 3b 收口 | **已裁定（A5 ①，2026-09-30）：接受独立登记，可注入可复用** |
| 32 | **net.fetch 失败路径也落 exfiltrationCheck 审计**（fetch 本身失败仍记录外发判定，R19 可观测性） | 批次 3b 收口 | **已裁定（A6 ①，2026-09-30）：接受，判定结果始终落账** |
| 33 | **下一批次**：批次 3c（S15 全量回归 + 性能基准门禁 + 严格模式灰度收口）整批收口 / 回归+门禁先行灰度后随裁定 | 批次 3b 收口 | **已裁定（C1 ①，2026-09-30）：批次 3c 整批收口** |
| 34 | **严格模式灰度范围（第二档，对应表行 6）**：镜像全插件试点 + 灰度清算纪律（前一档全量回归绿 + post-hoc 清算零未解释越界才进下一档） | 批次 3b 收口 | **已裁定（C2 ①，2026-09-30）：接受建议，范围限定镜像已迁移能力面** |
| 35 | **批次 4a 收尾默认项**：sampling 未注入宿主 LLM 采样器 → 一律 deny（S17 无审批不执行同纪律）；结果回传上限 `DEFAULT_SAMPLING_OUTBOUND_BYTES=512KB`（防资源耗尽兜底）；生命周期审计独立 `McpServerLifecycleEvent`（不并入效果审计账） | 批次 4a 收口 | **登记（2026-09-30）：沿用 S16/S17 注入式安全默认，均不新增信任边界/码位，无单独用户裁定项** |
| 36 | **批次 4b 收尾默认项（S20）**：`spawnServer` 经 `confineCommand` 沙箱挂载点包裹（最小 env 剥离凭证 + gateway 前缀）+ `osBridge.spawnManaged` 进程树拉起；mcp-unknown 默认全拒（表行 9 裁定接线）；kill/dispose 走进程树终止（P2）；逃逸用例集（E01–E14）入回归；残余风险登记簿（14.5 L1–L5）齐备 | 批次 4b 收口 | **登记（2026-10-01）：均为裁定驱动的机制接线/结构载体，零码位新增，SEC-3xxx 段留白；无单独用户裁定项** |
| 37 | **批次 4c 收口默认项（P1–P3）**：窄原生包 TS 接口契约（`native/bridge.ts`：spawnManaged/openBeneathAtomically/WindowsAclBridge + sha256 清单）+ 镜像 mock（`createMirrorOsBridge`）；`verifyBridgeManifest` 承载裁定 2A 最小签名链；P3 升级 = FsEffectHandler `open` 注入单点（不重构处理器）；cargo-audit/vet 入 CI 为并仓时唯一新增工程面 | 批次 4c 收口 | **登记（2026-10-01）：镜像实现接口契约 + mock，真实 native 并入 dsh 时替换；零码位新增；无单独用户裁定项** |
| 38 | **批次 5a 收口默认项（S21）**：skill 三件套（manifest 三契同构 + 来源三级 + parseSkillFile 兼容位；scan 三类装载期静态扫描复用 S3 诊断框架；attribution 运行期归因 + taint 传递）落地；`EffectAuditEntry` 新增可选 `activeSkill` 归因字段（§5.9.4 一等审计维度，最小字段扩散）；SEC-6xxx 段四条码位（6001–6004）经 §5.11.1 信任语义论证登记（skill 面新管控，可被冒充通道）；全量回归 245/245 + 性能门禁 PASS | 批次 5a 收口 | **登记（2026-10-01）：S21 交付 + 码位登记随 SEC 登记表 §6 落地；无单独用户裁定项（均按方案 §5.9 既有立项与登记纪律执行）** |
| 39 | **批次 5b 收口默认项（S23）**：一致性哨兵（`meta/sentinel.ts`，三类矛盾 + 冻结建议 + 不自动改判）+ 判据独立重算器（`meta/recheck.ts`，cross_checked/frozen + 非第二判据）+ 三态披露与基线指纹（`meta/disclosure.ts`，放行/拦截/豁免 + 超时 deny ≠ 用户 deny）+ 互指键 planId（`AssemblyPlan.planId` + `EffectAuditEntry.assemblyPlanId`，§5.11.4）+ SEC 码位表机器化（`scripts/sec-catalog.mjs` 单一数据源 + CI `check:sec` 两条）+ 红线终版实测 1216 逻辑行（`REDLINE-MANIFEST.conf` 10 文件） | 批次 5b 收口 | **登记（2026-10-01）：哨兵/重算器/三态披露为纯检测/核对/观测载体，互指键为纯数据载体，零码位新增，SEC-3xxx/4xxx/5xxx/7xxx 段维持留白（论证存档登记表 §7.1）；SEC 码位表机器化收口（R43）；红线基线终版 1216 逻辑行已裁定追认（R44，2026-10-01）** |
| 38 | **批次 5a 收口默认项（S21）**：skill 三件套（manifest 三契同构 + 来源三级 + parseSkillFile 兼容位；scan 三类装载期静态扫描复用 S3 诊断框架；attribution 运行期归因 + taint 传递）落地；`EffectAuditEntry` 新增可选 `activeSkill` 归因字段（§5.9.4 一等审计维度，最小字段扩散）；SEC-6xxx 段四条码位（6001–6004）经 §5.11.1 信任语义论证登记（skill 面新管控，可被冒充通道）；全量回归 245/245 + 性能门禁 PASS | 批次 5a 收口 | **登记（2026-10-01）：S21 交付 + 码位登记随 SEC 登记表 §6 落地；无单独用户裁定项（均按方案 §5.9 既有立项与登记纪律执行）** |

---

## 15. 本规划的诚实边界

1. **本规划基于 v4 方案文档推导，未做代码级核验**。vendor/cordis Fiber API 现状、dsh 仓库脚本细节、mcp-client 形态等均属 M0 调研项——若调研结论与方案假设不符，相应批次范围调整，属规划内预期行为而非规划失败。
2. **里程碑顺序默认按方案 8.1 依赖推导**。优先级权衡（如"是否把 MCP 深度内建提前以先行堵 R9 缺口"）是用户决策空间，本规划不预设结论，仅通过弹性条款保留调整自由度。
3. **规模标注为相对量级，不含日历工期**。工期取决于并行分派人力与回归基线大小，不虚构时间数字（无实测不给数字）。
4. **验收全绿不蕴含架构一致**（方案 9.1 第 9 条同源纪律）：G 终验的作用是把已知攻击面回归纳入 CI，未知攻击面残余以登记簿管理，不以"全绿"为由宣称安全完结。
5. **P1–P6 为评估登记而非执行承诺**（方案第 17 章，v2 新增）：落地范围待 M4 批次 4b 裁定（第 14 节表行 11）；任何原生桥落地都只是 L1 置信度升级，不得据此把登记簿改写为"已消除"；P1 价值判断基于承重结构形态，不指控现有实现存在实际缺陷。

> AI生成