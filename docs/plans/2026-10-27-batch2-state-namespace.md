# 批次 2 实施计划（状态目录命名空间隔离 + 加固清扫）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核。

**Goal:** 修复真实使用暴露的缺陷——TaskStore 与 ApprovalStore 共用 `--state` 目录时 `tasks list`/`approvals list` 因对方记录不符合本店 schema 而整体 `INVALID_TASK_RECORD`/`INVALID_APPROVAL_RECORD`（fail-closed 但不可用）——并顺带清掉前两批终审遗留的可速修 Minor。版本 0.3.1。

**Architecture:** 缺陷修复采用**文件名命名空间**：TaskStore 记录文件 `task-<uuid>.json`、ApprovalStore 记录文件 `approval-<uuid>.json`（锁目录随文件名），`--state` 语义不变、两店可安全共用一个目录；记录内容仍携带裸 uuid（`id` 字段不变）。原因：校验器区分「外来记录」会削弱防篡改 fail-closed（被篡改的本店记录可能伪装成外来而被跳过），子目录方案会改变 `--state` 语义；文件名前缀是唯一同时保住两者的方案。0.3.0 时代的无前缀记录 0.3.1 起不可见——本仓库自用工具、无外部部署，如实记为破坏性变更。

**Tech Stack:** 仓库现状：Node 22+、零依赖、node:test、ESM。

**Spec:** `docs/verification-2026-10-27-vertical-zcode.md` 新发现第 1 条、`docs/VERIFICATION.md` 第六轮「新发现」、前两批终审 Minor 清单（lane-a/b/c 报告与批次终审）。

## Global Constraints

- 沿用全部仓库约束（零依赖、UPPER_SNAKE、TDD、不删不减既有测试、平台包裹、状态诚实）。
- 破坏性变更（记录文件名前缀）必须在 README「安全与状态边界」与 VERIFICATION 明示，版本 0.3.1。
- 两车道文件不相交才并行（worktree）；DSH 管线级验证继续 blocked 待 `DEEPSEEK_API_KEY`（用户侧提供），本批 0 付费调用。

## Review Focus

1. **命名空间必须完整**：file()、锁目录、list() 过滤、get() 全部走前缀；任何按旧文件名可寻址的残留路径都是漏洞。
2. **fail-closed 不减弱**：把 task 记录改名为 `approval-*.json` 后 approvals 侧必须仍拒绝（校验内容，不信文件名）；反之亦然。
3. **既有测试零修改，两处例外为已核准的值来源变更**（计划审查核实全库仅此两处字面路径）：`test/tasks.test.mjs:126`（`${approvalId}.json`）与 `test/adapters.test.mjs:207`（`${id}.json`）改为前缀路径或 `store.file()`；断言强度不变，报告中列出新旧。其余全部经 `store.file()` 派生，前缀无关（审查者逐条核实）。
4. **加固项不引入新放宽**：JSON.parse 包裹、INVALID_ACTION_FILE 扩展、blobHash 守卫、脚本泄漏修复全部为收紧方向。
5. **脚本车道不破坏 exit 2 blocked 约定**。

---

### Task 1 (Lane 1): 状态目录命名空间隔离 + approvals/CLI 收紧

**Files:**
- Modify: `src/tasks.mjs`、`src/approvals.mjs`、`src/generate.mjs`（blobHash 守卫）、`bin/gstack861.mjs`（action-file 错误收紧）、`package.json`（0.3.1）、`README.md`（破坏性变更声明 + CLI 能力已同步项如需）
- Test: `test/tasks.test.mjs`、`test/approvals.test.mjs`、`test/generate.test.mjs`、`test/adapters.test.mjs`

**Interfaces:**
1. `TaskStore.file(id)` → `<dir>/task-<id>.json`；锁目录 `task-<id>.json.lock`；`list()` 只读 `task-` 前缀且 uuid 合法者；其余同构。`ApprovalStore.file(id)` → `approval-<id>.json`，同构。
2. 共用目录回归测试：同一 `--state` 下 ApprovalStore.issue + TaskStore.create 并存；`tasks list` 只见任务、`approvals list` 只见审批；两店转移互不干扰；`approvals show` 的 CLI 冒烟。
3. 伪装测试：把任务记录文件改名为 `approval-<uuid>.json` → `approvals list/get` 抛 `INVALID_APPROVAL_RECORD`（内容校验仍权威）；反向同理（`INVALID_TASK_RECORD`）；另加双前缀/杂名文件（`task-task-<uuid>.json`、`approval-x.json`）被 list 忽略的解析边界用例。
4. `ApprovalStore.transition/get` 的 `JSON.parse` 包裹 + `object(record)` 守卫（含 null/数组）→ 损坏 JSON（`{`）与非对象记录抛 `INVALID_APPROVAL_RECORD`（对齐 TaskStore.read，一并收口 transition 的 null 原始 TypeError 遗留）。
5. CLI `--action-file` 错误收紧**限枚举类**：读取错误（含 ENOENT）、SyntaxError、RangeError → `gstack861:INVALID_ACTION_FILE`；`absolute()` 的 `ABSOLUTE_PATH_REQUIRED`（相对路径）保持原语义不被吞（实现方式：把 absolute() 移出 try 或按错误类型过滤）；tests 覆盖缺失与坏 JSON 两类。
6. `blobHash(buffer)` 加 `Buffer.isBuffer` 守卫，非 Buffer 抛 `INVALID_BUFFER`；单测。
7. 版本 0.3.1；README 安全边界新增破坏性变更声明：0.3.0 无前缀记录升级后对 list/get 均不可见（等效丢失），需人工迁移；无外部部署。

- [ ] 失败测试（2/3 为核心，先红）→ 确认失败 → 实现 → `npm test` 全绿 → 提交（分支 `lane-1`，≥3 提交：命名空间/parse 包裹与 CLI/守卫与版本）

### Task 2 (Lane 2): verify-dsh-guard 脚本加固

**Files:**
- Modify: `scripts/verify-dsh-guard.mjs`

**Interfaces:**
1. `prepare()` 任何一步失败都清理临时根（把后续步骤包进 try/catch，失败时 `rmSync` 后 rethrow；`main()` 的 finally 不再看到 undefined 根）。
2. 探针父目录 `<root>/outside` 在断言前显式创建（消除次要断言永不触发的空转）。
3. 头部注释与 blocked 输出明示回合语义：单任务内 agentic 轮数由 headless profile 语义约束而非硬上限，付费成本以单任务最小提示词为界。
4. 本批可验证输出不变：`node scripts/verify-dsh-guard.mjs` → exit 2 blocked（实跑确认）。

- [ ] 修改 → 实跑确认 exit 2 → 提交（分支 `lane-2`）

### Task 3 (协调者): 证据、摘要、终审、推送

- [ ] VERIFICATION 第七轮（含破坏性变更声明、DSH 继续 blocked 说明）+ 摘要重算（协议顺序）
- [ ] `npm run check && npm test && npm run doctor && node scripts/verify-dsh-guard.mjs`（预期 exit 2）+ `node scripts/verify-8dot3.mjs`（两卷）全记录
- [ ] 终审（独立子代理）→ 修复轮 → 推送 main → CI 绿确认

## Deferred（本批不做的既定项）

- defineHost 方向裁定与实施（批次 3 专项计划）；原生询问接线；DSH 纵向流程（待密钥）；ZCode guard 层宿主验证（待用户受控新会话）；摘要清单 scripts 纳管约定（批次终审 Minor 3，维持现状）。
