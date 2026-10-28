# 批次 15 计划：TaskStore 取消/中断/恢复接线 + 审批取消矩阵（2026-10-28）

## 目标

关闭外部审查遗留的恢复语义缺口（2026-10-27 审查第 四 节：「`interrupted` 不能转 `cancelled`——已修；没有 owner / lease，无法区分『别的进程在跑』与『进程已崩溃』」）并补齐 FEATURE_MATRIX 第 25 行的「取消、恢复接线」：

1. **租约/心跳/收割/重排**：`running` 任务可被证明"活着"（心跳续租）或"已崩溃"（租约过期后收割为 `interrupted` 再恢复），失控 `failed` 任务可由操作员重排回 `planned` 重试。
2. **审批取消矩阵**：工作流取消时绑定审批的处置纪律——`cancelWorkflow` 助手以**先拒审批后取消任务**的故障安全顺序执行，矩阵测试覆盖全部状态组合与单次消费不变量。

全部**离线**（store + CLI 真实子进程；无密钥任务，0 付费调用）——恢复语义属可信控制器侧，模型不参与。

## Lane A：TaskStore 租约与恢复（src/tasks.mjs + bin/gstack861.mjs + test/tasks.test.mjs）

### A1. 租约字段与接线

- `start(id, subject, { owner, leaseMs })`、`resume(id, subject, { leaseMs })`：`leaseMs ∈ [1, 86400000]`（与审批 TTL 同界）时记录 `leaseExpiresAt = now + leaseMs`。省略 = 无租约（旧记录/旧调用零迁移，向后兼容）。
- `read()` 校验可选 `leaseExpiresAt`（safe integer）。

### A2. 心跳 heartbeat(id, subject, { leaseMs })

- `running → running`（只更新 `updatedAt` 与 `leaseExpiresAt = now + leaseMs`）。
- **活性由调用本身证明**：租约已过期仍可续（GC 延迟下活着的控制器应能续租；若已被收割则 `TASK_WRONG_STATE`，锁内串行化竞争）。
- 无租约记录心跳 → `TASK_LEASE_REQUIRED`（fail-closed：不能凭空发明租约）。

### A3. 收割 reap(id, subject) —— 崩溃恢复

- `running → interrupted`，**仅当**记录带 `leaseExpiresAt` 且 `now >= leaseExpiresAt`（锁内判定，与心跳竞争串行）。
- 活租约 → `TASK_LEASE_ACTIVE`；无租约 → `TASK_LEASE_REQUIRED`（无租约信息 ≠ 崩溃证明，fail-closed）。
- 收割后清除 `leaseExpiresAt`；随后 `resume`（或 `start`）重臂新租约并 bump attempts。
- `reap` 不 bump attempts（收割不是一次尝试；恢复那一下才是）。

### A4. 重排 requeue(id, subject)

- `failed → planned`（操作员重试决策；下次 `start` bump attempts）。
- `cancelled` 保持终态（操作员决定的死亡 → 新建任务，不复活）。`completed`/`running`/`planned` → `TASK_WRONG_STATE`。

### A5. 实现要点

- `transition()` 扩展 opts：`lease`（number=设置 | null=清除 | undefined=不动）+ `guard(record)`（锁内、写前断言，reap 的过期判定用它）。同态迁移（heartbeat）合法。
- 全部走既有锁/临时文件/rename 纪律；错误码 UPPER_SNAKE_CASE：`TASK_LEASE_REQUIRED`、`TASK_LEASE_ACTIVE`、`INVALID_LEASE`。

### A6. CLI 接线

- 新子命令 `tasks heartbeat|reap|requeue --state DIR --id ID --host H --session S --run R --policy-hash HASH --action-file F`。
- `--lease-ms N` 仅 `start|resume|heartbeat`；界检查在构造 store 前（与 --ttl-ms 同款，拒绝不留状态目录）。usage 文本更新。

### A7. Lane A 测试（test/tasks.test.mjs 增量，注入时钟）

- start/resume 带/不带 leaseMs 的记录形状；旧记录（无租约）全部既有测试不回归。
- heartbeat：续租、过期仍可续、收割后心跳 = TASK_WRONG_STATE、无租约 = TASK_LEASE_REQUIRED、非 running = TASK_WRONG_STATE。
- reap：过期收割成功（状态 interrupted、租约清除、attempts 不变）→ resume 重臂+ bump；活租约拒绝；无租约拒绝；与心跳竞争用注入时钟先后模拟（同一锁串行：先收割后心跳失败 / 先心跳后收割拒绝）。
- requeue：failed→planned→start bump；其余状态拒绝。
- leaseMs 界外（0 / 86400001 / 非整数）= INVALID_LEASE。

## Lane B：审批取消矩阵 + cancelWorkflow（src/workflow.mjs 新 + test/workflow.test.mjs 新）

### B1. cancelWorkflow({ taskStore, approvalStore, taskId, approvalId, subject })

- **前置绑定检查**（零转移先拒）：task.subjectHash === subjectDigest(subject) 且 approval.verify(id, subject).binding === 'match'，任一不符 → `WORKFLOW_BINDING_MISMATCH`。
- **顺序 = 故障安全**：先 `approval.reject(id, subject)` 再 `task.cancel(id, subject)`。论证：两步间崩溃时，"审批已拒"是安全终局（不可再消费），任务随后仍可再 cancel；反序则会留下"任务已死但审批仍可消费"的危险中间态。
- 返回 `{ approval, task }` 两条终态记录；第二步失败（如任务已 completed）原样抛 `TASK_WRONG_STATE`——此时审批已拒（安全），助手文档明示。
- 不做自动级联：两库独立是既有设计；助手是操作员纪律原语。

### B2. 取消矩阵（离线实证表）

| 任务态 | task.cancel | 绑定审批 reject(pending) | reject(approved) | reject 后 consume | verify |
|---|---|---|---|---|---|
| planned | ✓ | ✓→rejected | ✓→rejected | ✗ WRONG_STATE | match |
| running | ✓ | ✓ | ✓ | ✗ | match |
| interrupted | ✓ | ✓ | ✓ | ✗ | match |
| completed/failed/cancelled | ✗ WRONG_STATE | （不适用：矩阵只覆盖可取消态）| | | |

- 单次消费不变量贯穿：rejected 后 consume 必失败；consumed 后 reject 必失败。
- 崩溃顺序证明：预置任务为 completed（使第二步必失败）→ cancelWorkflow 仍先拒审批 → 抛错后断言审批 = rejected、任务未被触碰。
- 绑定不匹配：错 subject → WORKFLOW_BINDING_MISMATCH 且两库零转移。
- CLI 级：`tasks cancel|interrupt|resume` + `approvals reject` 经真实子进程各跑一遍主路径（接线证明）。

## 文档与版本

- 版本 0.4.14（package.json 单一来源）。
- FEATURE_MATRIX 第 25 行：两列 planned → `store-recovery-verified`（共享核 store+CLI 离线实证：租约/心跳/收割/重排 + 审批取消矩阵；宿主内执行器接线仍 planned 待③/后续批次）。
- VERIFICATION 第二十三轮 + 证据 JSON（最终 HEAD 重算）；README 边界节加一行恢复语义说明。
- 累计密钥任务不变（本批 0 计费）。

## 流程（本地规则）

计划（本文件）→ 独立子代理审计划 → **两条真并行 lane**（A、B 无共享文件：A 动 tasks.mjs/bin/tasks.test，B 新增 workflow.mjs/workflow.test；合并时 bin 的 usage 若 B 不碰 CLI 则无冲突）→ 各自全量测试 → 独立子代理审成果（整批 diff）→ 合并 main → 摘要最终 HEAD 重算 → push → CI 3/3。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 同态转移（heartbeat running→running）破坏既有转移不变量/测试 | transition 不变式检查放 Lane A 测试首条；既有 20 条任务测试全量回归 |
| reap 与 heartbeat 竞争 | 判定在锁内（guard 钩子）；注入时钟双向模拟 |
| 记录 schema 演进破坏旧状态目录 | leaseExpiresAt 可选字段；read() 对无字段旧记录保持接受（既有测试 + 新增旧形状回归） |
| cancelWorkflow 两步非原子被质疑 | 设计上就以"顺序即安全"回应：先拒后取消；崩溃顺序测试钉死；文档明示非原子 |
| CLI 新旗标解析漏洞 | 界检查前置（构造 store 前拒绝）；子命令白名单先于一切 |

## 非目标

- 宿主内（DSH/ZCode 会话内）的执行器取消接线（待 ③/后续批次，需要真实宿主中断事件源）。
- 审批自动级联（设计上不做，见 B1）。
- 子 Agent 多进程 lease 仲裁的真实多进程压力测试（单进程注入时钟已覆盖语义；真实多进程竞争留待执行器批次）。

## 审计划必改落实（2026-10-28，独立审计划 4 项）

1. **陈旧租约再入洞（健全性）**：`start`/`resume` 进入 `running` 而 `leaseMs` 省略时**必须清空** `leaseExpiresAt`（lease: null）——"省略=无租约"是对结果记录的约束，不是对旧调用者的宽容。否则 `start(leaseMs)→interrupt→resume(无lease)` 会带着必然过期的旧租约回到 running，被收割者"合法"打断。`interrupt`/`requeue`/`cancel`/`complete`/`fail` 离开 running 时同样清除（卫生）。回归测试两条：interrupt→resume-无租约、fail→requeue→start-无租约，断言结果记录无 `leaseExpiresAt`。
2. **heartbeat 的 leaseMs 必填**：store 级省略 = `INVALID_LEASE`；CLI `tasks heartbeat` 的 `--lease-ms` 必填（ask 必填旗标模式）。避免"只摸 updatedAt 不续租"的静默 no-op。
3. **CLI 去重**：`tasks cancel|interrupt|resume` 的子进程覆盖已由 adapters.test.mjs:261/:301 钉死，本批**不再重复**；CLI 级新增仅 `approvals reject` 子命令主路径（现有覆盖只有 ask-带-reject-应答与参数向量）。
4. **cancelWorkflow 第一步失败模式入档**：`APPROVAL_EXPIRED`（transition 在 from-state 检查前查过期）与 `APPROVAL_WRONG_STATE` 在**任何任务转移之前**抛出且被接受（过期审批本就不可消费，安全）；B2 矩阵 reject 各格加"在 TTL 内"脚注；崩溃顺序测试补钉一条第一步失败（过期审批 → 抛错、任务态不变）；"第二步失败"原因列全 completed/failed/cancelled。

另采纳建议：requeue 拒绝列表显式列 interrupted（恢复路径 start/resume/cancel 已覆盖）；无租约崩溃任务的手工恢复路径（interrupt→resume）入 README 边界说明；跨进程时钟偏差 caveat 一句话（同一可信操作员主机内可接受）；bin 需为 heartbeat/resume 加专用分支（第三参数）；版本/矩阵/VERIFICATION/README 统一**合并后**在最终 HEAD 落盘（两 lane 零文档文件重叠）。
