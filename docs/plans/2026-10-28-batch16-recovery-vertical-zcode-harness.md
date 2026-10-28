# 批次 16 计划：DSH 恢复纵向（reap→resume 键控复跑）+ ZCode 工作流层离线 harness（2026-10-28）

## 目标

1. **DSH 恢复纵向（Lane A，1 个密钥任务）**：把批次 15 的租约/收割/恢复语义接进真实 DSH 纵向——记账 `create→start(短租约)→模拟控制器崩溃（不心跳）→租约过期→reap→interrupted→resume(新租约，attempts=2)→密钥任务在恢复后的记账下完成`。证明：崩溃后的任务日志可恢复，且恢复尝试承载真实模型任务并终态正确。
2. **ZCode 工作流层离线 harness（Lane B，0 密钥）**：ZCode 侧"六阶段+审批+交付"此前只有人工记录的工作流证据（FEATURE_MATRIX 第 23 行 workflow-evidence）。本批把它做成**机器可检、可重复**的离线 harness：六阶段（spec→plan→implement→review→qa→ship）真实 CLI 记账、review 阶段内置 interrupt→resume 恢复腿、ship 阶段审批门（issue→ask 管道应答→verify→特权拷贝→consume）、ZCode 策略腿（`evaluate` 证明 zcode Write 绑定下 ship 目录 OUTSIDE_SCOPE）。诚实定级：**offline-workflow-journal-harness**（工作流层，非宿主纵向、非 host_verified——不含任何 ZCode 模型调用）。

## Lane A：scripts/dsh-recovery-vertical.mjs（密钥 1 任务）+ test/dsh-recovery-vertical.test.mjs

### 编排（5 段）

| 段 | 内容 | 密钥 |
|---|---|---|
| [1/4] 脚手架 | 复用 mini fixture 模式（writeMiniFixture + 控制器代写 impl 作 A–C 站位）+ guard-only profile + 真实 loadPolicy hash + action 文件 `{phase:'recovery',task:'R'}` | 0 |
| [2/4] 崩溃模拟（真实 CLI） | `tasks create→start --lease-ms 2000` → **不启动任何任务、不心跳**（控制器"死"在 start 之后）→ 真实时钟等待 >2s → `tasks reap` → interrupted → `tasks resume --lease-ms 900000` → running（attempts=2）；每步 exit 0 + 状态断言；未过期先试一次 reap 必失败（TASK_LEASE_ACTIVE，顺序正确性负控） | 0 |
| [3/4] 密钥任务 R | 提示词复用任务 A 模式（读 spec.md 逐字输出标记行，钉死 read 工具，≤200 字符 throw-before-launch）；`verdictMarker` 复用判定；PASS→`tasks complete` | **1** |
| [4/4] 终检 | 清理前 `tasks list` 恰 1 条：state=completed 且 **attempts=2**（崩溃一次+恢复一次，无双计）；subjectHash 绑 action-R | 0 |

- 崩溃等待用真实时钟（2s 租约 + ~2.5s 等待）；判定码：`PASS | REAP_PREMATURE_SUCCEEDED | REAP_FAILED | RESUME_FAILED | TASK_VERDICT_FAIL | JOURNAL_FINAL_STATE_WRONG`。
- 无密钥 → exit 2 BLOCKED（沿用三段式输出）。
- 复用：`writeMiniFixture/buildSpecMarkerLine?（mini 导出 writeActionFile/subjectFor/tasksArgs/verdictMarker）` + robustness 的 `checkPromptCap/policyJson/composeGuardProfile/seedHeadlessProfile/composeCheckGuard/launchTask/diagnoseFailure`。buildSpecPrompt 直接复用（读 spec 转述标记行）。

### Lane A 离线测试

提示词上限三档（真实根 ≤190 / 52 字符合成根 ≤200 / 180 病态根拒发射）+ 钉 read 工具；崩溃-恢复 CLI 矩阵（`--lease-ms 1` + 25ms 真实流逝 → reap 成功 → resume attempts=2；未过期 reap = TASK_LEASE_ACTIVE；heartbeat 缺 --lease-ms = INVALID_ARGUMENTS——若与 b15 既有测试重复则只保留本脚本特有向量）；无密钥 exit 2；verdict 复用断言。

## Lane B：scripts/zcode-workflow-vertical.mjs + test/zcode-workflow-vertical.test.mjs（全新离线）

### 设计

- `STAGES = ['spec','plan','implement','review','qa','ship']`，host=`zcode` 的 subject（sessionId/runId/policyHash 绑真实 `loadPolicy`）。
- 每阶段：`tasks create→start→（控制器写该阶段工件文件，含不可猜标记）→complete`；一阶段一 action 文件贯穿。
- **review 阶段内置恢复腿**：start 后 `interrupt`（模拟中断）→ `resume`（attempts=2）→ 工件 → complete——多阶段日志与批次 15 恢复语义的组合证明。
- **ship 门**：审批 `issue --ttl-ms 900000` → **负控** pending 时 gate 拒绝 → `ask`（stdin 管 approve，操作员渠道站位）→ approved → `verify` match → 控制器 wx 特权拷贝（源=implement 工件，目标=workspace 内 ship 目录）逐字节校验 → `consume` → **负控**重放拒绝 → ship 阶段记账 complete。
- **ZCode 策略腿（离线）**：自建 zcode 绑定策略（`bindings.zcode.Write.write/file_path` + `Edit.read`？最小：Write+Read），`evaluate` 断言：zcode Write 到 ship 目标 = `OUTSIDE_SCOPE`；到 writeRoot 内 = `IN_SCOPE`。ZCode 侧"模型不能自 ship"的策略层证明（与批次 14 DSH 键控负控同构，但明确标注：ZCode 侧无键控宿主运行，只是策略引擎级）。
- 终检：`approvals list` 恰 1 consumed；`tasks list` 恰 6 条全 completed、review 条 attempts=2；六工件+ship 产物字节校验。
- 完全离线可跑：`node scripts/zcode-workflow-vertical.mjs` exit 0/1——**测试里整跑一遍**（这是本 harness 的强度：全链真实 CLI 子进程，机器可检）。
- 判定码 UPPER_SNAKE_CASE 全覆盖；诚实分级注释（offline-workflow-journal-harness）。

### Lane B 离线测试

阶段表与 action 文件形状；恢复腿语义（review attempts=2 其余=1）；审批负控矩阵（pending gate 拒/重放拒）；策略腿两断言；subject digest（host zcode）；**整个 harness 子进程跑通 exit 0**；故障注入一例（预损坏一处使 harness exit 1——如伪造 ship 目录已存在 → STAGING/ship 拒绝路径，证 FAIL 不会被误报 PASS）。

## 密钥预算

本批恰 1（Lane A 任务 R）；应急上限 2。累计 11 → 最多 13。Lane B 零密钥。

## 文档与版本（合并后最终 HEAD 落盘）

0.4.15；VERIFICATION 第二十四轮；FEATURE_MATRIX：第 23 行 ZCode 列注记"六阶段工作流层机器可检 harness（离线）"，第 25 行注记恢复语义已接入 DSH 真实纵向（reap→resume 键控单次运行）；README 边界节一行（ZCode harness 分级 + DSH 恢复纵向）；证据 JSON 最终 HEAD 重算。

## 流程

计划 → 独立审计划 → 双 lane 并行（A: scripts/dsh-recovery-vertical + 测试；B: scripts/zcode-workflow-vertical + 测试；零文件重叠）→ 协调者在 lane A worktree 跑密钥任务 → 独立审成果（整批 diff + 密钥证据）→ 合并 → 0.4.15 文档 → 摘要 → push → CI 3/3。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 密钥任务模型漂移 | 复用已验证的任务 A 提示词模式（批次 13 修复后两轮全过）+ 工具名钉死 |
| reap 时机（真实时钟 2s）抖动 | 等待 2.5s（25% 余量）；reap 失败 = 诚实 FAIL 码 REAP_FAILED，不重试 |
| 与 b15 既有 CLI 测试重复 | Lane A 测试只做本脚本特有向量，reap/heartbeat 通用矩阵已由 tasks.test.mjs 钉死 |
| ZCode harness 被误读为"宿主纵向" | 命名、注释、FEATURE_MATRIX 措辞三处显式 offline-workflow-journal-harness 分级 |
| ship 目录已存在破坏 wx | fixture 预断言不存在（assertAbsent）；终检含字节校验 |

## 非目标

- ZCode 键控/宿主内运行（需 ③ 用户解锁）。
- 真实多进程崩溃（本批是单进程模拟崩溃：start 后不心跳；真实 SIGKILL 竞争属非目标，同批次 15）。
- 六阶段的模型侧工作（ZCode 侧阶段工件是控制器站位，与 DSH 纵向的 A–C 站位同一诚实处理）。

## 审计划必改落实（2026-10-28，独立审计划 4 项）

1. **复用缺口显式化**：`tasksArgs` 不发射 `--lease-ms`——新脚本自行为 `start`/`resume` 追加（reap/complete 不得携带，CLI 会以 INVALID_ARGUMENTS 拒绝）；`runTasksCli`/`journalRun` 未导出——Lane A 自带剥密钥 CLI runner（批次 14 同款）。`buildSpecPrompt`/`SPEC_TAG` 均已导出（原计划的问号删除）；脚手架用导出的 `prepareMini` + 追加 `action-recovery.json`。
2. **测试去重定死**：Lane A 新测试只保留 (a) 真实时钟 CLI 过期矩阵（`--lease-ms 1`+25ms → reap 成功 → resume → CLI 输出 attempts=2——现有覆盖只有假钟 store 级与 CLI 负控）、(b) 新脚本无密钥 exit 2 三段式、(c) spec 提示词真实根 ≤190。TASK_LEASE_ACTIVE 未过期负控、heartbeat 必填、52/180 字符档、read 工具钉死、verdictMarker 全形均已有覆盖，不再重复。
3. **故障注入机制修正**：wx 拒绝的是已存在的 ship **目标文件**（不是目录——mkdir recursive 幂等）；setup 的 assertAbsent 会先撞 ALREADY_EXISTS——注入设计为跳过 setup 断言直接预置目标文件、断言 harness 把裸 EEXIST 映射为具名判定码（`SHIP_TARGET_EXISTS`）并 exit 1；EEXIST 抛出本身已由批次 14 测试钉死，不重复。
4. **reap 时序余量对准负控腿**：成功腿（等待 ≥2.5s vs 2s 租约）结构性安全；紧的是未过期负控（必须在 2s 内完成 spawn+guard）。改为 `--lease-ms 5000` + ~6.2s 等待（同为 25% 余量但负控窗口 5s），风险表同步改。

另采纳建议：Lane B 自带 zcode 宿主的 subject/args 建造器（approvalsArgs/subjectFor 硬编码 dsh）、复用导出的 `parsePrintedDocs`、策略腿断言限定"本 harness 自编译策略下 ship 目录在工作区内而写根外"（通用 IN/OUT 已有覆盖）、`resume --lease-ms 900000` 处注释引用批次 14 SHIP_TTL_MS 同一论证、FEATURE_MATRIX 头部状态行同步 0.4.15、证据工件命名 `docs/verification-2026-10-28-batch16.json`。
