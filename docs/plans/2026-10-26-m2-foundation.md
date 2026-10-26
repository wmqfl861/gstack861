# M2 基础批次实施计划（任务日志 / 技能生成 / 安装注册 / 审批 CLI / DSH 调研）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按蓝图接续优先级补齐 M2 前置基础：持久任务日志与恢复、固定上游技能生成器、安装/卸载注册、审批操作员 CLI，并完成本机 DSH 真实加载调研。

**Architecture:** 每个模块一个独立 `src/*.mjs` + `test/*.test.mjs`，共享既有 `src/json.mjs` 摘要与 `src/inventory.mjs` 盘点；CLI 接线、版本号与文档由协调者在集成任务统一完成，避免共享文件并发冲突。所有产物只标记 `generated` / `contract_tested`，不宣称宿主验证。

**Tech Stack:** Node.js 22+，零 npm 依赖，node:test + assert/strict，ESM `.mjs`。

**Spec:** `docs/BLUEPRINT.md`（第 4 节 M1/M2、第 7 节接续优先级）、`docs/FEATURE_MATRIX.md`、`README.md` 安全边界。

## Global Constraints

- Node >= 22；只用 `node:*` 内建模块；不新增 npm 依赖；不联网、不调用模型、不执行上游代码。
- 错误风格：`throw new Error('UPPER_SNAKE_CASE')`；拒绝理由必须可从错误码读出。
- 测试：`node:test` + `assert/strict`；fixture 一律 `fs.mkdtempSync` 临时目录 + `t.after` 清理（参照 `test/helpers.mjs`、`test/inventory.test.mjs`）。
- 平台安全：POSIX 权限断言必须 `process.platform !== 'win32'` 条件包裹（参照 `src/approvals.mjs`）；不得写平台无条件的分隔符/权限断言；路径比较用 `path` 模块。
- 文件写入用 `wx` 或临时文件 + `rename`；记录文件大小上限 4096 字节、`nlink === 1`、非符号链接（参照 `ApprovalStore.transition`）。
- 状态诚实：新功能状态只写 `implemented` / `contract_tested`；生成物 `status: 'generated-not-host-verified'`；不把本计划任何产物标为 `host_verified` 或 `full`。
- 实现子代理按顺序派发，各自**提交自己任务的全部文件**（commit 信息用 `feat:`/`test:` 前缀）；共享文件（`bin/`、`package.json`、`README.md`、`docs/FEATURE_MATRIX.md`、`src/adapters/zcode.mjs`）只有协调者的集成任务能改。Task 4（后台调研）不提交，产物由协调者提交。

## Review Focus

1. **两个真实进程并发转移同一任务状态** → 第二个必须得到 `TASK_BUSY` 而不是双双成功（Task 1 双进程测试）。
2. **安装目标已有非本项目文件** → 必须 `USER_FILE_REFUSED` 整体中止，不得部分写入或覆盖（Task 3 两阶段测试：先全部校验后写入）。
3. **生成与盘点之间上游漂移**（生成期间上游被改动）→ `generateSkills` 自行重跑 `inventory()`，脏树/错提交必须拒绝（Task 2）。
4. **staging 内容被篡改**（SKILL.md 与 manifest 摘要不一致）→ `TAMPERED_STAGING`，且因两阶段校验不产生部分安装（Task 3）。
5. **CLI 错误路径**：未知命令/缺参数/坏 JSON 必须退出码非 0 且 stderr 输出 `gstack861:` 前缀错误码，不打印堆栈（Task 5）。

---

### Task 1: 持久任务日志 TaskStore

**Files:**
- Create: `src/tasks.mjs`
- Modify: `src/approvals.mjs`（仅把私有 `subjectHash` 重命名为导出的 `subjectDigest`，行为不变）
- Test: `test/tasks.test.mjs`

**Interfaces:**
- Consumes: `src/json.mjs` 的 `digest/object`；`src/approvals.mjs` 的 subject 校验规则（本任务导出）。
- Produces: `subjectDigest(subject)`（从 `src/approvals.mjs` 导出，签名 `(subject) => hex64`）；`src/tasks.mjs` 导出 `class TaskStore`：
  - `constructor(directory, { clock = Date.now } = {})`：绝对路径；`mkdirSync recursive mode 0700`；目录非符号链接、`realpathSync === resolve`；POSIX 下 `(mode & 0o077) === 0` 且属主为当前 uid（照抄 `ApprovalStore` 模式）。
  - `create(subject)` → uuid v4 字符串 id；记录 `{ schemaVersion: 1, id, subjectHash: subjectDigest(subject), state: 'planned', attempts: 0, createdAt, updatedAt }`，`wx`、mode 0600。
  - `start(id, subject)`：`planned|interrupted → running`，`attempts += 1`。
  - `resume(id, subject)`：`interrupted → running`，`attempts += 1`（与 start 对 interrupted 等价，二者都允许）。
  - `complete(id, subject)`：`running → completed`；`fail(id, subject)`：`running → failed`。
  - `cancel(id, subject)`：`planned|running → cancelled`；`interrupt(id, subject)`：`running → interrupted`。
  - `get(id)` → 冻结记录，不存在抛 `NOT_FOUND`；`list({ state } = {})` → 按 id 排序的冻结记录数组。
  - 每次转移：锁目录 `file.lock`（`mkdir 0700`，失败抛 `TASK_BUSY`，`finally rmdir`）；记录校验照抄 `ApprovalStore.transition`（大小 ≤ 4096、`nlink === 1`、schema/id/`subjectHash` 匹配、POSIX mode 0077 为 0）；非法顺序抛 `TASK_WRONG_STATE`；写回用 tmp + rename；`updatedAt` 更新。

- [ ] **Step 1: 写失败测试**（覆盖：create→start→complete 全程状态与 attempts；非法转移 `planned→complete` 抛 `TASK_WRONG_STATE`；subject 绑定不匹配拒绝；`get`/`list` 过滤；跨实例持久化；篡改记录（改 id）抛 `INVALID_TASK_RECORD`；锁目录残留抛 `TASK_BUSY` 不自动清锁；`subjectDigest` 与 `ApprovalStore` 对同一 subject 一致——用 `test/approvals.test.mjs` 的 subject 构造方式；双真实进程并发 `start` 仅一个成功，参照 `test/approvals.test.mjs` 的双进程模式）
- [ ] **Step 2: 跑测试确认失败**：`node --test test/tasks.test.mjs` → FAIL（模块不存在）
- [ ] **Step 3: 实现**：先在 `src/approvals.mjs` 导出 `subjectDigest`（原 `subjectHash` 改名，行为与现有测试不变），再实现 `src/tasks.mjs`
- [ ] **Step 4: 全量回归**：`npm test` → 全部通过（含既有 50 项）
- [ ] **Step 5: 提交并报告**（提交本任务 src+test，跑 `npm test` 全绿后 commit）

### Task 2: 固定上游技能生成器

**Files:**
- Create: `src/generate.mjs`
- Test: `test/generate.test.mjs`

**Interfaces:**
- Consumes: `inventory(root, expectedCommit)`（`src/inventory.mjs`）；`textDigest`（`src/json.mjs`）。
- Produces: `generateSkills({ upstream, commit, staging, host, now = () => new Date().toISOString() })` → `{ schemaVersion: 1, host, staging, generated, needsReview, skills: [{ name, source, blob, sha256, placeholders, needsReview }] }`：
  - `upstream` 绝对存在目录；`commit` 40 位 hex；`staging` 绝对路径，必须不存在或为空目录；`staging` 与 `upstream` 互不包含（`path.relative` 判定，违反抛 `OVERLAPPING_PATHS`）；`host ∈ ['zcode','dsh']` 否则 `INVALID_HOST`。
  - 自行调用 `inventory(upstream, commit)`（继承脏树/错提交拒绝）。
  - 每个技能：`text = git show HEAD:<source>`（`execFileSync` 照抄 `src/inventory.mjs` 的 `git()` 封装）；`placeholders` = `/\{\{([^}]+)\}\}/g` 全部匹配去重排序；`sha256 = textDigest(text)`；写 `staging/<name>/SKILL.md`（`wx`，0644，字节与 git show 完全一致）与 `staging/<name>/manifest.json`（`wx`，0644）：`{ schemaVersion: 1, name, host, source, blob, sha256, placeholders, indicators, needsReview: indicators.length > 0, status: 'generated-not-host-verified', generator: 'gstack861', generatorVersion: '0.2.0', generatedAt: now() }`。
  - 返回值中 `needsReview` = 有 needsReview 技能的数量。

- [ ] **Step 1: 写失败测试**（复用 `test/inventory.test.mjs` 的 `repository(t)` fixture 模式；断言：SKILL.md 字节 === `git show` 输出；manifest 各字段精确匹配，`review` 因 indicators 非空 `needsReview: true`、`investigate` 为 false；placeholders `['TOOLS']`；非空 staging 抛 `STAGING_NOT_EMPTY`；staging 在 upstream 内抛 `OVERLAPPING_PATHS`；非法 host 抛 `INVALID_HOST`；脏 upstream 继承 `UPSTREAM_DIRTY`）
- [ ] **Step 2: 确认失败**：`node --test test/generate.test.mjs` → FAIL
- [ ] **Step 3: 实现 `src/generate.mjs`**
- [ ] **Step 4: 全量回归**：`npm test` 全通过
- [ ] **Step 5: 提交并报告**（提交本任务 src+test，跑 `npm test` 全绿后 commit）

### Task 3: 安装 / 卸载注册

**Files:**
- Create: `src/install.mjs`
- Test: `test/install.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 manifest 结构（上表）；`textDigest`。
- Produces: `src/install.mjs` 导出：
  - `installSkills({ staging, target })` → `{ installed: [names], skipped: [names], backedUp: [names] }`（两阶段：先校验全部再写入）：
    - `staging` 绝对存在目录；`target` 绝对路径，不存在则 `mkdir recursive 0755`，存在则必须是普通目录且非符号链接；staging 无技能目录抛 `NO_SKILLS`；条目缺 `manifest.json` 抛 `STAGING_INVALID`。
    - manifest 校验：`schemaVersion === 1`、`generator === 'gstack861'`、`sha256` hex64、`name === 目录名` 且 `/^[a-z0-9][a-z0-9-]*$/`；`SKILL.md` 的 `textDigest` 必须等于 `manifest.sha256` 否则 `TAMPERED_STAGING`。
    - `target/<name>` 不存在 → 安装（SKILL.md + manifest.json，`wx`）；存在且其 manifest 缺失或 `generator !== 'gstack861'` → `USER_FILE_REFUSED`；存在且 `sha256` 相同 → `skipped`；不同 → 先把 `target/<name>` 移入 `target/.gstack861-backups/<name>-<Date.now()>/` 再安装，计入 `backedUp`。
    - 注册表 `target/.gstack861-registry.json`：`{ schemaVersion: 1, updatedAt, skills: [{ name, sha256 }] }`，tmp + rename 原子写。
  - `uninstallSkills({ target, purge = false })` → `{ uninstalled: [names], backupsRemoved: 数量 }`：按注册表两阶段——先全部验证每个 `target/<name>/manifest.json` 的 `generator === 'gstack861'`（缺失或不符抛 `USER_FILE_REFUSED`，整体中止不删任何东西），再统一删除目录；注册表重写为空列表；`purge: true` 额外删除 `.gstack861-backups`。
- [ ] **Step 1: 写失败测试**（空目标安装→installed 两人；重复安装→skipped 且文件未变；目标被 foreign 文件占用→`USER_FILE_REFUSED` 且已校验的其他条目也**没有**写入；staging 篡改（改 SKILL.md 内容）→`TAMPERED_STAGING` 零写入；版本漂移→backedUp、备份目录含旧 SKILL.md、目标为新内容；卸载只删注册表内自有目录、注册表外的目录原样保留、卸载后再卸载返回空；purge 清备份；伪造注册表指向 foreign 目录→整体 `USER_FILE_REFUSED` 不删）
- [ ] **Step 2: 确认失败**：`node --test test/install.test.mjs` → FAIL
- [ ] **Step 3: 实现 `src/install.mjs`**
- [ ] **Step 4: 全量回归**：`npm test` 全通过
- [ ] **Step 5: 提交并报告**（提交本任务 src+test，跑 `npm test` 全绿后 commit）

### Task 4: 本机 DSH 真实加载调研（只读 + 一份发现文档）

**Files:**
- Create: `docs/integration/dsh-local-findings.md`

**Interfaces:**
- Consumes: `C:\Users\Administrator\.zcode\skills\dsh\SKILL.md`（本机 dsh CLI 用法）、`upstream.lock.json` 的 DSH 提交。
- Produces: 发现文档，固定小节：`安装位置与版本`、`插件发现机制`、`配置格式与隔离方式（env/flag）`、`ctx.tools.guard 是否存在于该版本`、`受控冒烟（命令、策略、真实输出）或 blocked 原因`、`对 src/adapters/dsh.mjs 的差异清单`。
- 约束：只读调研；**不得修改用户级 DSH 配置**；冒烟仅当能用隔离配置目录（独立 HOME/env）运行时执行，运行前把完整命令写入文档；不调用付费模型（dsh 冒烟若会触发模型调用则记 blocked）。

- [ ] **Step 1: 读 dsh skill 文档与本机 DSH 安装，确认版本、插件加载、guard API**
- [ ] **Step 2: 若可隔离：跑一次插件加载冒烟（加载 gstack861 guard，观察激活/拒绝输出）；否则记录 blocked 与确切原因**
- [ ] **Step 3: 写 `docs/integration/dsh-local-findings.md`，只记录真实运行过的命令与输出**
- [ ] **Step 4: 报告**（不提交；后台并行任务，产物由协调者审核后提交）

### Task 5: 集成（协调者执行，不派子代理）

**Files:**
- Modify: `bin/gstack861.mjs`、`src/adapters/zcode.mjs`、`package.json`、`README.md`、`docs/FEATURE_MATRIX.md`、`docs/VERIFICATION.md`、`scripts/round-digests.mjs`
- Test: `test/adapters.test.mjs`（新增 matcher 与 CLI 子进程用例）

**Interfaces:**
- `zcodeHookConfig({ nodePath, cliPath, policyPath, matcher = '.*' })`：matcher 必须 `/^[A-Za-z0-9_|.\\-*]+$/` 否则 `INVALID_MATCHER`；其余行为不变。
- CLI 新命令（错误路径统一：stderr `gstack861:CODE`、exit 1，不打印堆栈）：
  - `generate --upstream PATH --staging DIR --host zcode|dsh`（commit 取自锁文件）
  - `install --staging DIR --target DIR`；`uninstall --target DIR [--purge]`
  - `approvals list --state DIR`；`approvals approve|reject --state DIR --id ID --host H --session S --run R --policy-hash HASH --action-file ABS_JSON_PATH`
- `package.json`：version `0.2.0`；exports 增加 `./tasks`、`./generate`、`./install`。
- `scripts/round-digests.mjs`：文件清单加入新文件；上一轮对照文件改为参数（默认 `docs/verification-2026-10-26-windows.json`）。
- 文档：README「已实现」增列 4 项并更新版本；FEATURE_MATRIX 三行状态推进为 `contract_tested`（任务日志、生成器、安装）与 `implemented`（审批 CLI）；VERIFICATION 第三轮记录 + 新摘要 JSON。

- [ ] **Step 1: matcher 失败测试 → 实现 → 通过**（matcher 只覆盖绑定工具；非法 matcher 抛错；旧调用不变）
- [ ] **Step 2: CLI 失败测试（子进程）→ 实现新命令 → 通过**（generate→install→uninstall 全链路子进程冒烟；approvals approve 后 core consume 成功；错误路径 exit 1 + 错误码前缀）
- [ ] **Step 3: 版本、exports、README、FEATURE_MATRIX、VERIFICATION、摘要 JSON**
- [ ] **Step 4: `npm run check && npm test && npm run doctor` 全绿**
- [ ] **Step 5: 独立审查子代理审整个 diff → 处理发现 → 提交并推送 GitHub**
