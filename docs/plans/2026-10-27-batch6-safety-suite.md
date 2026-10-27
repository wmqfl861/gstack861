# 批次 6 实施计划（M3 安全组+文档生成消费套件 / install dry-run / 文档矩阵刷新）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核。复用批次 5 已验证的渲染技能消费模式（上下文注入、降级条款如实引用、tasks 记账、ask 桥审批）。

**Goal:** (1) **安全组消费套件**：在单一 fixture 场景上按渲染技能消费 `careful`（前置失败如实记录+遵循实质建议内容——批次 3 计划审查预核过该路径）、`freeze`/`unfreeze`（其机制依赖 gstack 宿主钩子的部分如实标注「我方未实现」，可映射到本仓库原语的部分用**真实策略评估**演示边界冻结语义——writeRoots=[边界目录]：边界内写入→abstain/IN_SCOPE、危险写入（删除脚本目标）→deny/OUTSIDE_SCOPE 双侧留档（=））、`document-generate`（按其方法论实际产出的 Diataxis 象限文档——依其决策矩阵为 fixture 产出 reference 与 how-to 文档；Step 9 的 gstack-redact/gh 依赖如实记为跳过的机制差距）；(2) `install --dry-run`（校验+报告动作零写入）；(3) 文档矩阵刷新（FEATURE_MATRIX 0.4.2 行、README 链接滞后项）。版本 0.4.3。

**Architecture:** Lane A（文档）与 Lane B（代码：install.mjs+bin+测试）不相交；Task 3（协调者）执行消费套件+证据+终审推送。

**Tech Stack:** 仓库现状。

**Spec:** 蓝图 M3 安全组/文档行、批次 5 消费模式（`docs/verification-2026-10-27-render-consumption.md`）、批次 3 计划审查对 careful 的预核（前置硬失败路径的处理裁定）、上游固定提交技能文本（渲染产物内）。

## Global Constraints

- 沿用全部仓库约束；消费证据边界声明与批次 5 相同（上下文注入、自动拾取未验证、不升 host_verified）。
- **freeze/unfreeze 消费的真实性红线**：渲染技能若指示使用 gstack 自有钩子/工具，如实记录「依赖宿主 gstack 安装，本仓库未实现该机制」；仅当能映射到本仓库真实原语（策略评估/审批/任务）时才演示，且演示必须真实执行（如 compilePolicy(writeRoots=[]) + evaluate 真实 deny）。禁止把角色扮演写成机制验证。
- careful 的 analytics 前置失败如实记录（引用其输出/条款），仅遵循其实质建议内容。
- 0 付费调用。

## Review Focus

1. 消费套件每个技能的「遵循了什么/跳过了什么/为何」逐项留档；机制差距不得美化。
2. `--dry-run` 零写入是结构性的（校验全链路复用，prepareTarget 之前返回）。
3. FEATURE_MATRIX 刷新不越级（新证据行如实、状态不升 host_verified）。
4. 文档滞后三连（矩阵版本、README batch5 链接、host-loading 交叉引用）一次清零。

---

### Task 1 (Lane A): 文档矩阵刷新

**Files:** `docs/FEATURE_MATRIX.md`、`README.md`

- FEATURE_MATRIX：状态行现为 0.4.0（陈旧三轮）——Lane A 刷新为 0.4.2 内容，Task 3 统一升 0.4.3；新增行：渲染技能宿主消费（此前实证 1 例（review）；本批 +4（careful/freeze/unfreeze/document-generate），仍非自动拾取）、install dry-run（contract_tested）；（不改 VERIFICATION 历史轮次的测试计数——第十一轮自记本批数字。）
- README：开发文档节补 `docs/verification-2026-10-27-batch5.json` 与 `docs/verification-2026-10-27-render-consumption.md` 链接（同轮两件均未链，滞后一轮）；上游渲染节补 dry-run 一句（Task 3 后定稿数字）；host-loading §2.4 已含 zcode-acceptance 交叉引用则跳过。
- 提交（分支 `b6-lane-a`）：`docs: refresh feature matrix and evidence links`

### Task 2 (Lane B): install --dry-run

**Files:** `src/install.mjs`、`bin/gstack861.mjs`、`test/install.test.mjs`

**Interfaces:**
- `installSkills({ staging, target, now, dryRun })`：dryRun=true 时执行**显式只读校验集**：stagingPlan 全链（files 摘要+跨键冲突）+ prepareTarget 的目标校验（绝对路径；已存在则普通目录非符号链接→INVALID_TARGET，但不执行其 mkdir）+ assertRegistryPathSafe + loadRegistry + classify + prepareBackups 的只读拒绝检查（已存在备份根须普通非符号链接目录，不建目录）；然后返回 `{ dryRun: true, wouldInstall, wouldSkip, wouldBackUp }` 不写入——若校验会拒绝则照常抛错（dry-run 不吞错误）。**跳过**：prepareTarget 的 mkdir、withInstallLock、tmp 清理、prepareBackups 的创建、全部写入（结构性零写入；报告不持锁，不报 INSTALL_BUSY、可能读到陈旧 registry——证据注明）。
- CLI：`install --staging S --target T [--dry-run]`（布尔旗标沿用 uninstall --purge 模式）。
- 测试：全新 target dry-run 报告 wouldInstall 全量且 target 不存在；已安装 target 报 wouldSkip；漂移场景报 wouldBackUp；篡改 staging dry-run 照常 TAMPERED（拒绝不被吞）；正常 install 行为零变化。

- [ ] 失败测试 → 确认失败 → 实现 → 全绿 → 提交（分支 `b6-lane-b`）：`feat: install --dry-run validates and reports without writing`

### Task 3 (协调者): 安全组+文档生成消费套件、证据、终审、推送

- [ ] fixture 场景：小仓库含一个「危险变更」（删除脚本+强推指令）+ 一份待发布变更集
- [ ] **careful 消费**：读渲染技能，前置失败如实记录；遵循其实质建议对危险变更输出警告与替代方案；经 ask 桥取得 approve/reject
- [ ] **freeze/unfreeze 消费**：渲染技能文本遵循；机制差距如实（依赖 gstack 钩子→未实现）；用真实冻结策略（writeRoots=[]）评估危险写入 → deny 留档；unfreeze 恢复 → abstain 留档
- [ ] **document-generate 消费**：按其方法论产出 fixture 的 RELEASE.md（真实文档）
- [ ] 全程 tasks 记账；证据 `docs/verification-2026-10-27-safety-suite.md`
- [ ] VERIFICATION 第十一轮 + 证据 JSON + 版本 0.4.3 + 摘要（协议顺序）→ 终审 → 推送 → CI 绿

## Deferred

- 两项用户解锁（本批首尾重申）；M3 设备依赖组；M4；DSH 插件式技能装载。
