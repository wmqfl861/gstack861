# Windows 验收批次实施计划（8.3 身份保护 / gitfile gitdir / 次要修复）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 步骤用 `- [ ]` 跟踪。本计划已按本地开发流程规则经过独立子代理计划审核（发现并修正 Task 2 发现机制缺陷）后开工。

**Goal:** 完成 PR #1（claude/review-2026-10-27）的 Windows 验收：修复审查报告第 5 条剩余的 8.3 短名绕过（已在本机两个卷实锤复现）、第 4 条剩余的 gitfile 重定向 gitdir、第四节可低风险速修项，产出 Windows 证据，条件满足后合并。

**Architecture:** Task 1 在 `src/policy.mjs` 引入「规范化用 `fs.realpathSync.native` + 受保护路径按 (dev,ino) 文件身份比较」，保留全部现有名称检查作为补充；Task 2 在祖先遍历中于每级目录内发现 vcs 命名的指针文件并解析 gitdir 重定向；Task 3 批量处理低风险次要修复；Task 4 协调者产出证据、推送并按条件合并。

**Tech Stack:** 仓库现状：Node 22+、零 npm 依赖、node:test + assert/strict、ESM。

**Spec:** `docs/reviews/2026-10-27-claude-review.md`（权威审查报告，第 5 条修复规范见其 §二.5 与附录 A/B）、用户 Windows 验收指令、`docs/BLUEPRINT.md` 红线。

## Global Constraints

- 只用 `node:*` 内建；UPPER_SNAKE 错误码；`node:test` + `assert/strict`；`mkdtempSync` + `t.after`；平台相关断言用 `process.platform` 包裹（win32-only 测试同样包裹）。
- 每个行为修复先写失败测试；**不删除或放宽任何已有测试和断言**（断言值随版本来源变化属于源变更，需在报告中说明）。
- 不修改 `~/.zcode`、`~/.dsh` 或用户级配置；不调用付费模型。
- 不 force push；合并前只推 `claude/review-2026-10-27`（最终合并动作按用户「条件满足后合并」指令在 Task 4 Step 4 执行并在报告中明示）。
- 不把任何功能标为 `host_verified` / `full`；文档只记录真实运行过的命令与输出。
- Windows 上失败而 CI 通过的测试：查根因报告，不为变绿改测试。

## Review Focus

1. **规范化变更的回归面**：`realpathSync.native` 替换后，既有符号链接/悬空链接/大小写测试必须全部保持通过（POSIX 上两 API 等价；Windows 上额外展开 8.3 与规范大小写）。
2. **身份比较的性能与缺失路径**：祖先遍历每级一次 `statSync(bigint)`；不存在的 `.git`/受保护根必须跳过而非抛错（非 git 工作区）。
3. **遍历终止条件**：祖先身份比较必须止于工作区根，不得越级扫描或漏掉工作区根本身。
4. **gitfile 解析的失败闭合**：`.git` 指针文件无 `gitdir:` 行时忽略不崩溃；gitdir 目标**不存在**时不得因 `evaluate` 兜底 catch 把全工作区写入误拒——字符串 `inside` 检查用未 realpath 的 `path.resolve` 结果（覆盖未来子路径），`realpathSync.native` + 身份集合仅在目标存在时尝试（ENOENT 跳过）。
5. **purge 收紧的假阳性**：13 位时间戳 + manifest 校验不得误删我们自己的合法备份（漂移备份链测试必须保持通过）。

---

### Task 1: 8.3 短名与文件身份保护（审查第 5 条）

**Files:**
- Modify: `src/policy.mjs`
- Test: `test/policy.test.mjs`

**Interfaces:**
- Consumes: 现有 `targetPath`/`directory`/`vcsComponent`/`evaluate` 结构。
- Produces（内部行为，公开签名不变）：
  1. `directory()` 与 `targetPath()` 的规范化调用从 `fs.realpathSync` 改为 `fs.realpathSync.native`（Windows 上展开 8.3 短名并规范大小写；POSIX 等价）。
  2. 新增 `existingIdentity(p)`：`fs.statSync(p, { bigint: true })` 返回 `dev`/`ino` 二元组字符串，ENOENT 等缺失返回 `null`，其余错误上抛。
  3. `evaluate` 写效果分支：受保护身份集合 = `policy.protectedRoots` 与 `targetPath(workspace/.git)`（存在者）的并集（注意 `compilePolicy` 已把 `workspace/.git` 推入 protectedRoots——并集是有意冗余，防止该行为未来变化，勿去重省略）；从 `target.path` 逐级 `path.dirname` 向上遍历**已存在的祖先**（含目标自身）至 `policy.workspace`（含）为止，任一祖先身份命中集合 → `PROTECTED_PATH`。现有名称检查（`vcsComponent` 分量检查、`inside` 字符串比较）全部保留作为补充。
  4. win32-only 测试：长名受保护目录（如 `protected-long-directory-name`）经 `cmd /c dir /a /x` 读取其 8.3 短名（无短名则 `t.skip`），经短名写入 secret 文件 → `PROTECTED_PATH`；同策略下合法写入路径仍 `abstain`。

- [x] **Step 1: 失败测试**（win32-only 8.3 短名绕过用例；并附「必须原样保持通过」的既有回归清单：符号链接解析、悬空链接、VCS symlink target、大小写无关前缀等）
- [x] **Step 2: 确认失败**（`node --test test/policy.test.mjs`，win32 上新用例 FAIL：`IN_SCOPE`）
- [x] **Step 3: 实现规范化与身份比较**
- [x] **Step 4: 全量回归**（`npm test` 全绿；重跑 `node scripts/verify-8dot3.mjs` 两卷 → `RESULT: no alias bypass on this volume`，exit 0）
- [x] **Step 5: 提交并报告**

### Task 2: gitfile 重定向 gitdir 保护（审查第 4 条余项）

**Files:**
- Modify: `src/policy.mjs`
- Test: `test/policy.test.mjs`

**Interfaces:**
- Consumes: Task 1 的祖先遍历、`existingIdentity` 与 `vcsComponent`。
- Produces: 祖先遍历的每一级**已存在祖先目录 A**（含 `policy.workspace`）中，用 `readdir(A)` 找出名称命中 `vcsComponent` 且 `lstat` 为**普通文件**的条目（覆盖 `.git` 与 `git~N` 指针拼写；目录形式的 `.git` 已被既有逻辑覆盖）：读取内容，匹配 `/^gitdir:\s*(\S+)\s*$/m`；命中则 `dir = path.resolve(dirname(gitfile), 目标)`——该目录**无论是否存在**都加入本次评估的字符串 `inside` 受保护检查（覆盖未来创建的子路径）；仅当其存在时再经 `fs.realpathSync.native` 规范并加入受保护身份集合（ENOENT 跳过，不得让 `evaluate` 兜底 catch 把全工作区写入误拒）。内容不含 `gitdir:` 行 → 忽略。写 gitfile 本身已被现有名称检查拒绝。
- 测试：`wt/.git` 为文件内容 `gitdir: ../real-git-data`；`writeRoots` 覆盖全工作区；写 `real-git-data/hooks/pre-commit` → `PROTECTED_PATH`；写 gitdir 内新文件 → `PROTECTED_PATH`；写普通路径 → `abstain`；`.git` 文件内容为垃圾 → 不崩溃且普通写入仍 `abstain`；gitdir 指向不存在路径 → 不崩溃且普通写入仍 `abstain`，但写该不存在 gitdir 的未来子路径仍被拒。

- [x] **Step 1-5**: 同 Task 1 流程（失败测试 → 确认失败 → 实现 → 全量回归 → 提交报告）

### Task 3: 低风险次要修复批（审查第四节精选 + 第 6/11 条文档面）

**Files:**
- Modify: `src/inventory.mjs`、`src/install.mjs`、`src/generate.mjs`、`bin/gstack861.mjs`、`src/adapters/zcode.mjs`、`scripts/check.mjs`、`README.md`、`.gitignore`
- Test: `test/inventory.test.mjs`、`test/install.test.mjs`、`test/generate.test.mjs`、`test/adapters.test.mjs`

**Interfaces:**
1. `inventory(root, expectedCommit, { betweenSteps } = {})`：ls-tree 与 show 改用 `actual` 提交号；新增可选 `betweenSteps` 钩子（脏检查后调用，默认 no-op）供测试注入 HEAD 切换（现有调用点均为两参，无冲突）。测试：两提交仓库 + 钩子切到新提交 → 盘点内容仍是固定提交的。
2. `src/install.mjs` purge：备份清理条件改为 `/^[a-z0-9][a-z0-9-]*-\d{13,}$/` **且** 目录内 `manifest.json` 的 `generator === 'gstack861'`；不满足则保留不计入。测试：`notes-2024` 用户目录保留；manifest 损坏的备份项保留；合法 13 位时间戳备份仍被清理（既有漂移备份链测试保持通过）。
3. 版本单一来源：`src/generate.mjs` 的 `GENERATOR_VERSION` 与 `bin/gstack861.mjs` doctor 版本改读 `package.json`（`fs.readFileSync` + JSON.parse）。既有断言 literal `'0.2.0'` 的测试（`test/generate.test.mjs` 两处）改为对照 package.json 版本（值来源变更，断言强度不变，报告中展示新旧断言；`test/install.test.mjs` 的 `'0.2.0'` 是测试自建 fixture，不改）。
4. README「安全与状态边界」新增第 6 条约束：ZCode 下 PreToolUse 看到的是原始输入，任何返回 `updatedInput` 的其他 Hook/插件都会使本守卫的判定作用于过期输入——**不得与任何改写输入的 Hook 共存**，纳入宿主验收；`src/adapters/zcode.mjs` 注释更正：拒绝 `*` 是保守选择，宿主实际把 `*` 当全匹配（审查第四节指出的注释失实）。
5. `scripts/check.mjs` 证据门禁降级为警告输出（审查第 11 条：CI 绿灯是合并门槛，摘要门证明不了测试跑过）；保留 `round-digests.mjs` 用法不变。
6. `.gitignore` 增加 `.superpowers/`（标注为仓库卫生项，非审查修复）。

- [x] **Step 1-5**: 行为项（1、2、3）先失败测试 → 实现 → 全量回归；文档/配置项（4、5、6）随实现提交。**逐项独立提交**（审查建议，便于追溯）。

### Task 4: 证据、推送与合并（协调者执行）

**Files:**
- Create: `docs/verification-2026-10-27-windows-acceptance.json`
- Modify: `docs/VERIFICATION.md`

**Interfaces:**
- Windows 证据 JSON 记录真实命令与输出摘要：基线（check 22 模块 / test 104→新增后全绿 / doctor / inventory 57）、8dot3 探针修复前（两卷 `alias bypass reproduced`）与修复后（两卷 exit 0）、平台差异说明（Linux 105 vs Windows 104 的平台包裹用例）；**交叉引用**（不修改）历史轮次 `docs/verification-2026-10-27-review-fixes.json`；推送后记录 CI Actions 运行链接（审查第 11 条）。
- VERIFICATION.md 增补 Windows 验收轮次；摘要按既定协议（先提交代码 → 新 HEAD 重算 → 单独提交清单）。
- 推送分支 → 查 CI（Actions 页面）→ 绿后按用户指令合并。

- [x] **Step 1: 证据文件与 VERIFICATION 增补**
- [x] **Step 2: `npm run check && npm test && node scripts/verify-8dot3.mjs`（两卷）全绿**
- [x] **Step 3: 摘要重算（协议顺序）→ 提交 → 推送分支**
- [x] **Step 4: CI 绿 → 合并（本地 merge 到 main 并推送，按用户「条件满足后合并」指令；在最终报告中明示此动作）**

## Deferred（明确不在本轮，留档可审计）

- 审查第 7 条（ApplyPatch / 按参数区分 effect）与第 9、10 条（上游 defineHost 复用、DSH 沙箱为主）——架构方向，需用户决策。
- 第 8 条余项（512 KiB 实际上限，需提高上限或只解析所需字段）。
- §四余项：生成器字节 blob 哈希与 `manifest.blob` 校验；`.gstack861-tmp-*` 残留在下次安装时清理；TaskStore interrupted→cancelled 与 owner/lease；ApprovalStore 只存摘要操作员看不到内容；`generate --commit` 生产 CLI 暴露与 install 锁文件校验；staging 完整性/同 host 校验；双进程竞争测试忙等观察的偶发风险。
- purge 对备份目录内多余文件的额外保护（timestamp+manifest 之外，镜像 verifyOwned 的两文件校验）——可选加固。
