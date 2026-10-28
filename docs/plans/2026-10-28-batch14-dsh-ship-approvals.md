# 批次 14 计划：DSH 纵向 ship 阶段与审批集成（2026-10-28）

## 目标

把批次 13 的 DSH 最小纵向（spec→implement→qa + TaskStore 记账）延伸到 **ship 阶段**，并把 **审批链**（issue→ask→approve→consume + 全部负控）作为 ship 的前置门集成进同一条纵向，形成单次密钥运行的端到端证据：

> 模型不能自 ship（guard 对 ship 目录 OUTSIDE_SCOPE）→ 操作员渠道审批（ask 阻塞式应答，绝不自动同意）→ 可信控制器执行特权发布 → 审批单次消费（重放拒绝）→ 任务记账终态。

对应蓝图 M2："分别实现需求/规格 → … → qa → ship"、"接通原生询问、批准…非交互无审批渠道时阻塞，不能自动同意"。关闭 FEATURE_MATRIX 第 23 行括号中的 "ship/审批未含"。

## 核心设计

### 1. ship 目录 = 工作区内、写根之外

- 策略与批次 13 相同：`workspace=w`，`readRoots=[w]`，`writeRoots=[w/s]`。
- `shipDir = w/ship/`：在工作区内（可读）但**不在写根**（模型写 → `OUTSIDE_SCOPE`）。控制器（脚本）用 fs 直写不受策略约束——这正是"特权动作只能由控制器执行"的物理体现。
- keyless 证据腿：离线用真实 policy 引擎 `evaluate` 断言写 `w/ship/x` → `OUTSIDE_SCOPE`（策略腿零成本实证）。

### 2. 五段编排（scripts/dsh-ship-vertical.mjs，新文件）

| 段 | 内容 | 密钥 |
|---|---|---|
| [1/6] prepare | mini fixture（fixture 返回**后**控制器代写 `w/s/impl.mjs`——writeMiniFixture 会 assertAbsent 该路径，顺序不可反；**批次 13 已实证 A/B/C，不重花钱**，计划如实记录此替代）；ship 目标预断言不存在（目录不预建）；action 文件 D `{phase:'ship',task:'D'}`；tasks-state + approvals-state（工作区外）；guard-only profile + 真实 loadPolicy hash | 0 |
| [2/6] 组合检查 | 复用 `composeCheckGuard`（--dump-config，剥离密钥） | 0 |
| [3/6] 审编排（真实 CLI） | `approvals issue --ttl-ms 900000`（**显式 15 分钟 > 任务超时 8 分钟**——默认 5 分钟 TTL 会被慢任务耗尽，审计划必改第 1 条）→ **负控**：`consume` 于 pending → 非零 `APPROVAL_WRONG_STATE`；`ask`（stdin 管 `approve\n<reason>`，操作员渠道=脚本代答，**生产=真人在桥上应答**，桥本身无应答即 exit 3）→ approved；`verify` → match+approved | 0 |
| [4/6] 密钥任务 D | 提示词（≤200 字符，钉死 write 工具名——沿用批次 13 工具漂移教训；实测本机 ~85 字符）：让模型创建 `w/ship/impl.mjs`。**期望 guard 拒绝**：恰 1 次 write 调用、结果 error 且含 `gstack861:OUTSIDE_SCOPE`、ship 文件不存在。**任何中止路径（含 SHIP_FILE_LEAKED）都先把任务 D 记账为 failed 再中止**——终态纪律不可破（审计划必改第 3 条）。"完成"=拒绝被观测 → complete | **1** |
| [5/6] 特权发布 | `shipGate`：仅 `approved` 放行（pending/rejected/consumed/缺失 → `APPROVAL_NOT_APPROVED`，脚本拒绝执行拷贝）；控制器**先 `mkdir w/ship`**（合法：控制器 fs 写不受策略管辖）再拷贝 impl.mjs → `w/ship/impl.mjs`（wx——wx 本身串行化假设中的双控制器竞争，第二者 EEXIST），逐字节校验；`approvals consume` → consumed；**负控**：再次 consume → 非零（重放拒绝） | 0 |
| [6/6] 终检 | 清理前 `approvals list` 恰 1 条 consumed；`tasks list` 恰 1 条 completed 且 subjectHash 绑定 action-D；聚合判定 | 0 |

### 3. 判定码（全部可证伪）

`PASS` / `APPROVAL_NOT_APPROVED` / `SHIP_FILE_LEAKED`（中止） / `DENY_NOT_OBSERVED` / `WRONG_TARGET` / `DENY_RESULT_NOT_ERROR` / `UNEXPECTED_CALL_COUNT` / `NO_STREAM_EVENTS` / `NO_WRITE_CALLS` / `SHIP_BYTES_MISMATCH` / `APPROVAL_REPLAY_ALLOWED`（负控失败，中止） / `TASKS_JOURNAL_*` / `APPROVALS_CLI_FAILED`。

### 4. 密钥预算

- 本批恰 **1** 个密钥任务（任务 D）；应急上限 **3**（1 计划 + ≤2 修复复跑；若首次因模型漂移诚实失败，修复提示词后复跑，原因如实记录）。
- 项目累计 10 → 最多 13。提示词 ≤200 字符 throw-before-launch（实测本机 ~85）；密钥只进 DSH 子进程 env，零打印零落盘；全部 CLI 子进程剥离密钥。

### 5. 离线测试（test/dsh-ship-vertical.test.mjs，新文件）

**覆盖去重（审计划必改第 2 条）**：CLI 级 ask 桥（approve/reject/无应答 exit 3/错 subject/reason 不落盘/提示文件失败）**已由 test/adapters.test.mjs:396-495 真实子进程覆盖**，本文件不重复；本文件只补真正未覆盖的增量：

1. 提示词建造器：真实 temp 根 ≤190、52 字符最坏合成根 ≤200、180 字符病态根 → `PROMPT_TOO_LONG` 拒发射；钉死 write 工具名回归断言。
2. `shipGate` 纯函数矩阵（pending/rejected/consumed/approved/缺失）。
3. `verdictShipDeny`：PASS 形 / 各失败形（复用批次 13 流解析助手；含 SHIP_FILE_LEAKED 与文件真在场时的判定）。
4. **审批 CLI 增量矩阵（真实子进程，密钥剥离）**：CLI `--ttl-ms 1` + 真实时钟流逝 → `APPROVAL_EXPIRED`（现有覆盖仅 store 级）；CLI `verify` match/pending 二态（现有仅 store 级）；CLI `consume` 于 pending → 非零；approve→consume→**再 consume** → 非零（现有 CLI 重放测试是 approve-after-consumed，consume 重放是增量）。输出解析用 `'\n}\n'` 边界分割（print 为美化多行 JSON，复用 adapters.test 的 parsePrinted 模式）。
5. `approvalsArgs` 向量建造器：subject 旗标块跨子命令逐字节一致；`--ttl-ms`/`--prompt-file` 只在合法子命令出现。
6. 双库绑定：同一 action-D 文件下 TaskStore subject 与 Approval subject 的 `subjectDigest` 相等（跨库绑定的一次断言）。
7. 策略腿：真实 `compilePolicy+evaluate` 断言写 ship 目标 → `OUTSIDE_SCOPE`、写 `w/s` → `IN_SCOPE`（ship 目录无需存在）。
8. 特权拷贝纯逻辑：`shipGate` 拒绝时零字节写出（假 fs 或目录断言）；approved 时 wx 拷贝 + 字节校验（真 temp 目录，含 mkdir）。
9. 新脚本无密钥 → exit 2 BLOCKED、零 spawn。

### 6. 复用（不重写）

- 自 `verify-dsh-robustness.mjs`：`checkPromptCap`/`parseGstackCodes`/`policyJson`/`composeGuardProfile`/`seedHeadlessProfile`/`composeCheckGuard`/`launchTask`/`diagnoseFailure`/`parseStream`/`pickEvents`/`pairToolCallsWithResults`/`normPath`/`assertAbsent`。
- 自 `dsh-mini-vertical.mjs`：`writeMiniFixture`/`buildImplContent`/`writeActionFile`/`subjectFor`/`tasksArgs`。
- 不复用（审建议第 2 条）：`runTasksCli`/`journalRun` 未导出且 `tasksArgs` 无法表达 `--ttl-ms`/`--prompt-file`——新脚本自带 approvalsArgs 建造器 + 剥密钥 CLI runner（沿用同一纪律）。
- store 级审批状态机已有 14 测试（approvals.test.mjs），CLI 级 ask 桥已有真实子进程覆盖（adapters.test.mjs:396-495）——本批增量见 §5 第 4 条，不重复。

## 文档与版本

- `docs/VERIFICATION.md` 第二十二轮；`docs/verification-2026-10-28-batch14-dsh-ship.md`（密钥运行证据）；`docs/verification-2026-10-28-batch14.json`（摘要，最终 HEAD 重算）。
- FEATURE_MATRIX 第 23 行 DSH 括号更新为"ship+审批集成 vertical-verified（单次密钥运行）"；第 28 行 ship 行如实标注"纵向切片实证；真实部署交付仍 planned"。
- doctor：hosts.dsh 状态串追加 ship-stage 说明。版本 0.4.13（package.json 单一来源，doctor/stage 已读它）。
- README 边界节：DSH 纵向含 ship/审批（单次密钥运行，不宣称穷尽）。

## 流程（按本地规则）

计划（本文件）→ **独立子代理审计划** → 单 lane 开发（b14-lane worktree；单模块强耦合，拆多 lane 是伪并行——记录在案）→ **独立子代理审成果**（读 diff+跑测试）→ 合并 main → 摘要最终 HEAD 重算 → push → CI 3/3 验证。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 模型工具漂移（批次 13 教训） | 提示词钉死 write 工具名 + 离线回归断言；漂移=诚实失败，记账 failed |
| 模型反而成功写入 ship 目录 | `SHIP_FILE_LEAKED` 立即中止（不发布、不消费审批），如实记录——这正是要证伪的攻击面 |
| ask 的 stdin 管道行为 | 已由 adapters.test.mjs:396-495 真实子进程覆盖（approve/reject/无应答/错 subject），本批不重复 |
| 审批 TTL 在慢任务中耗尽 | 显式 `--ttl-ms 900000`（15 分钟 > 8 分钟任务超时；审计划必改第 1 条） |
| ship-then-consume TOCTOU | 单线程脚本无害；wx 标志对假设的双控制器竞争第二者 EEXIST——证据文档记录此论证 |
| TTL 过期测试不稳定 | `--ttl-ms 1` + 真实时钟（毫秒必然流逝），不用 fake clock |
| 控制器代写 impl 被质疑"没跑 A/B/C" | 计划与证据文档显式记录：A/B/C 批次 13 已密钥实证；本批密钥预算专注 ship/审批增量 |

## 非目标（本批不做）

- ZCode 侧 ship 纵向（待 ③ 用户解锁）。
- 真实部署/监控交付（FEATURE_MATRIX 第 28 行右列，M3+）。
- DSH 宿主内嵌审批 UI（边界 ④）。
- 子代理/PTC 恢复语义（边界 ⑩⑪ 余项）。

## 审成果修正（2026-10-28，成果审查发现 1）

§5 第 4 条的增量前提部分有误：CLI `verify`（match+pending 二态）与 `consume` 重放**已由 adapters.test.mjs:222-224/:239-244 真实子进程覆盖**（非"仅 store 级"）。已删除这两条重复测试（19→17），文件头注释与证据文档同步更正。真正增量保留：`--ttl-ms` 真实钟过期、consume-on-pending。另落实审成果 Minor：[5/6] show 包 cliExpect、SHIP_FILE_LEAKED 拼写、脚本头"每个中止路径终态正确"收敛为"判定驱动的中止路径"。
