# Codex 审计修复批次实施计划（安装加固 / 出处固定 / 校验收口）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复外部 Codex 审计（gpt-6-astra/max，探针实证）发现的 2 Critical + 6 Important 缺陷：卸载数据损失、伪造所有权删除、备份联接逃逸、并发注册表丢失、注册表占用失效、生成器 TOCTOU 出处破坏、非法 matcher、损坏审批记录展示。

**Architecture:** Task 1 集中加固 `src/install.mjs`（所有权=内容验证、备份/注册表路径安全、安装互斥锁）；Task 2 批量修复三个小缺陷面（生成器提交固定读取、matcher 正则可编译、审批/任务读取校验与 CLI 前置验证）；Task 3 协调者做文档、版本 0.2.1、摘要与推送。

**Tech Stack:** 同仓库现状：Node 22+、零 npm 依赖、node:test + assert/strict、ESM。

**Spec:** `docs/BLUEPRINT.md`（红线：绝不覆盖/删除用户文件、状态诚实、TOCTOU 边界声明）、Codex 审计探针输出（本计划测试项逐条对应，见各任务）。

## Global Constraints

- 沿用仓库全部既有约束：`node:*` only、UPPER_SNAKE 错误码、`wx`/tmp+rename、POSIX 断言平台包裹、`mkdtempSync`+`t.after`。
- 新错误码：`INSTALL_BUSY`（安装互斥）、`INVALID_ACTION_FILE`（CLI）；其余复用 `USER_FILE_REFUSED`/`STAGING_INVALID`/`INVALID_MATCHER`/`INVALID_APPROVAL_RECORD`/`INVALID_TASK_RECORD`。
- 实现子代理顺序派发、各自提交单任务文件；共享文件（README/版本/摘要）只归 Task 3。
- 每个 Codex 探针场景必须转化为回归测试（任务内一一对应）。

## Review Focus

1. **伪造一致性所有权**：伪造注册表 + 自洽 manifest + 匹配摘要的攻击者仍可过内容验证——这是 target 可写下的固有边界，必须文档化（README 安全边界 + 本计划 R 裁决），不得声称已消除。
2. **锁残留**：安装锁目录崩溃残留后，下一次安装必须 `INSTALL_BUSY` 而非静默继续（不自动清锁，沿既有模式）。
3. **junction 在 POSIX 无对应物**：junction 测试须 `process.platform === 'win32'` 包裹；symlink 测试保持 POSIX 包裹。
4. **并发语义改变**：并发第二安装从「成功但丢更新」变为 `INSTALL_BUSY` 拒绝——测试断言新语义。
5. **提交固定读取不回归盘点**：`git show <commit>:<path>` 与 inventory 的 blob/摘要仍一致。

---

### Task 1: 安装/卸载安全加固

**Files:**
- Modify: `src/install.mjs`
- Test: `test/install.test.mjs`

**Interfaces:**
- Consumes: 既有 `installSkills`/`uninstallSkills` 签名与 `now` 选项不变（调用方零改动）。
- Produces: 行为变更（内部）：
  1. **安装互斥锁**：`installSkills` 与 `uninstallSkills` 全程持 `target/.gstack861-install.lock`（mkdir 0700，失败抛 `INSTALL_BUSY`，finally rmdir）。
  2. **注册表占用前置校验**（写入阶段前）：lstat 注册表路径——存在且（非普通文件或符号链接/reparse）→ `USER_FILE_REFUSED`，零写入；目录与符号链接两种探针场景都必须在写任何技能文件之前拒绝。
  3. **注册表合并读改写在锁内**：锁内重读现注册表再合并写（消除丢更新）。
  4. **备份路径安全**：使用前校验 `.gstack861-backups`——存在且（非目录或符号链接）→ `USER_FILE_REFUSED`；创建/校验后 `realpathSync(backups)` 必须仍在 `realpathSync(target)` 之内（挡 junction 逃逸），否则 `USER_FILE_REFUSED`。
  5. **卸载内容验证所有权**（替代裸 generator 标记）：对注册表每个条目，卸载前必须同时满足——目录内 `manifest.json` 可解析、`generator === 'gstack861'`、`manifest.sha256 === 注册表记录的 sha256`、`SKILL.md` 字节摘要 === 注册表 sha256、目录 `readdir` 恰为 `['SKILL.md','manifest.json']`（无多余文件）。任一不满足 → `USER_FILE_REFUSED`，两阶段整体零删除。用户修改过 SKILL.md（摘要漂移）或放入额外文件 → 拒绝删除（保护用户数据）。
  6. **purge 收窄**：`--purge` 只删除备份目录内匹配 `/^[a-z0-9][a-z0-9-]*-\d+$/` 的目录项（我们的 `<name>-<时间戳>` 命名），其余条目原样保留，`backupsRemoved` 只计删除数。

- [ ] **Step 1: 写失败测试**（新增回归，逐条对应 Codex 探针）：(a) 卸载遇用户修改过的 SKILL.md → `USER_FILE_REFUSED` 且目录原样；(b) 卸载遇目录内额外用户文件 → 同上；(c) 伪造注册表（sha 与目录 manifest 不一致）+ marker manifest → 拒绝且外来目录原样；(d) 备份目录为 junction（win32 包裹）→ `USER_FILE_REFUSED` 且 target 外零写入；(e) 备份目录为 symlink（POSIX 包裹）→ 同上；(f) 注册表路径为目录 → `USER_FILE_REFUSED` 零写入；(g) 注册表路径为 symlink（POSIX 包裹）→ 拒绝且符号链接原样；(h) 两真实进程并发安装 → 恰一个成功、另一个 `INSTALL_BUSY`，注册表与成功方一致、无孤儿；(i) 锁目录残留 → `INSTALL_BUSY` 不自动清；(j) purge 后非 `<name>-<数字>` 命名的用户归档目录保留；(k) 既有全部测试语义不回归（幂等 skip、漂移备份、两阶段卸载等——注意 (a) 改变了「漂移后重装再卸载」路径：漂移走备份替换后 target 为新内容，卸载验证针对注册表新 sha，应通过）。
- [ ] **Step 2: 确认失败**：`node --test test/install.test.mjs` → 新用例 FAIL
- [ ] **Step 3: 实现 `src/install.mjs` 加固**
- [ ] **Step 4: 全量回归**：`npm test` 全绿
- [ ] **Step 5: 提交并报告**（`fix: harden install/uninstall ownership, backup and registry paths, add install lock`）

### Task 2: 出处固定与校验收口（三个小缺陷面）

**Files:**
- Modify: `src/generate.mjs`、`src/adapters/zcode.mjs`、`src/approvals.mjs`、`src/tasks.mjs`、`bin/gstack861.mjs`
- Test: `test/generate.test.mjs`、`test/adapters.test.mjs`、`test/approvals.test.mjs`、`test/tasks.test.mjs`

**Interfaces:**
- Consumes: 全部公开签名不变。
- Produces: 行为变更：
  1. `src/generate.mjs`：技能内容读取从 `git show HEAD:<source>` 改为 `git show <commit>:<source>`（commit 为已验证固定值），消除盘点与读取间 HEAD 漂移。
  2. `src/adapters/zcode.mjs`：`zcodeHookConfig` 的 matcher 除字符类外须 `new RegExp(matcher)` 可编译，否则 `INVALID_MATCHER`（挡 `*`、尾部 `\`）。
  3. `src/approvals.mjs` `get()`：lstat 仅 ENOENT → `NOT_FOUND`，其他错误原样抛；记录校验增加 `['pending','approved','rejected','consumed'].includes(record.state)`，否则 `INVALID_APPROVAL_RECORD`。
  4. `src/tasks.mjs` 记录解析：非对象（含 `null`）→ `INVALID_TASK_RECORD`。
  5. `bin/gstack861.mjs`：`approvals` 先验证子命令（`list|show|approve|reject`）再构造 `ApprovalStore`（`approvals bogus` 不留状态目录）；`--action-file` 解析失败 → `INVALID_ACTION_FILE`。

- [ ] **Step 1: 写失败测试**：(a) 生成器 HEAD 切换竞态——fixture 提交两次，`now()` 钩子里把 HEAD 切到新提交，断言 staging 内容/摘要仍是固定提交的（Codex 探针 09 回归）；(b) matcher `'*'`、`'\\'` → `INVALID_MATCHER`；(c) `approvals show` 对 `state:'invented-state'` 记录 → CLI 退出 1 且 stderr `INVALID_APPROVAL_RECORD`；(d) `approvals bogus` → 退出 1 且状态目录未创建；(e) 坏 `--action-file` → `gstack861:INVALID_ACTION_FILE`；(f) tasks 目录写入 `null` JSON → `INVALID_TASK_RECORD`；(g) approvals get() 对不存在 id → `NOT_FOUND`（保持）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现五处修改**
- [ ] **Step 4: 全量回归**：`npm test` 全绿
- [ ] **Step 5: 提交并报告**（`fix: pin generator reads to commit, compile-check matcher, validate read views and CLI inputs`）

### Task 3: 集成（协调者执行）

**Files:**
- Modify: `README.md`、`docs/VERIFICATION.md`、`docs/verification-2026-10-26-m2.json` 或新轮 JSON、`package.json`、`bin/gstack861.mjs`（版本串）

**Interfaces:**
- 版本 0.2.1；README「安全与状态边界」新增两条：卸载所有权为内容验证，target 目录对模型必须不可写（guard 策略保证），完全自洽伪造是既知边界而非已消除；安装互斥锁残留须人工清除。VERIFICATION 第四轮记录（含 Codex 审计来源、修复映射、复测结果）；`scripts/round-digests.mjs` 重算摘要。

- [ ] **Step 1: 文档与版本**
- [ ] **Step 2: `npm run check && npm test && npm run doctor` 全绿**
- [ ] **Step 3: 独立审查子代理审修复 diff → 处理发现**
- [ ] **Step 4: 提交并推送 GitHub**
