# 批次 7 实施计划（M3 纯工作流技能消费 II + uninstall dry-run 对称）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核。复用已验证消费模式（累计 5 例）。三目标技能均含自身 Degraded mode 条款；learn/retro 引用 GBrain（gstack 记忆系统）——本仓库未实现，按「机制差距如实+替代产物」处理。

**Goal:** (1) 消费 `learn`（对批次 6 的 careful 拒绝事件捕获教训——GBrain 未实现，教训以结构化记录落 fixture 仓库 `.gstack-memory/`，差距如实）、`retro`（对 fixture 仓 whole 周期做回顾，产出其规定的回顾报告）、`test-audit`（审计 fixture 测试缺口，产出审计发现）；(2) `uninstall --dry-run`（与 install 对称，只读校验+报告）；(3) 文档滞后清偿（README batch6 链接、矩阵行准备）。版本 0.4.4。

**Architecture:** Lane A（文档）与 Lane B（代码：install.mjs+bin+测试）不相交；Task 3 消费+证据+终审推送。

**Tech Stack:** 仓库现状。

**Spec:** 蓝图 M3 记忆/运行质量行、批次 5/6 消费模式、三技能渲染文本。

## Global Constraints

- 消费边界声明同前（上下文注入、自动拾取未验证、非 host_verified、0 付费调用）。
- learn 的 GBrain 依赖：如实记录未实现；教训按 learn 规定的结构（触发条件/教训/来源链接）以本地文件替代产出，明确标注「非 GBrain——下游接入待宿主验收」。
- retro/test-audit 的产物为技能规定格式；引用的数据全部来自 fixture 真实历史（git log/文件）。
- 0 付费调用。

## Review Focus

1. 三技能各自「遵循/跳过/为何」逐项留档；GBrain 差距不得美化。
2. uninstall dry-run 零写入结构性（复用两阶段卸载的校验集，无删除）。
3. 文档滞后一次清偿。

---

### Task 1 (Lane A): 文档滞后清偿

**Files:** `README.md`、`docs/FEATURE_MATRIX.md`
- README：开发文档节补 batch6 JSON+safety-suite 证据链接（一轮滞后）；dry-run 句补 uninstall（Task 3 定稿——Lane A 不写该半句）。
- FEATURE_MATRIX：消费行预备「累计 8 例（Task 3 后生效）」措辞由 Task 3 定稿；Lane A 仅补 dry-run 行 uninstall 半句留白。
- 提交（分支 `b7-lane-a`）：`docs: round-11 links and matrix prep`

### Task 2 (Lane B): uninstall --dry-run

**Files:** `src/install.mjs`、`bin/gstack861.mjs`、`test/install.test.mjs`

**Interfaces:**
- `uninstallSkills({ target, purge, dryRun })`：dryRun=true 时执行只读校验集——validateTarget、assertRegistryPathSafe、loadRegistry、逐技能 verifyOwned（registry 为锚）+ purge 的只读清理预演（若 purge：列出将被清理的备份项=13 位命名+manifest 校验者，不删）——返回 `{ dryRun: true, wouldUninstall: [names], wouldPurge: [names], refusals? }`：verifyOwned 拒绝场景照常抛错（不吞）；refusals 字段删除（拒绝即抛错，报告只含会成功的动作）。跳过锁、跳过全部删除/注册表写入。
- CLI：`uninstall --target DIR [--purge] [--dry-run]`。
- 测试：已安装 target dry-run 报告全量+零变更（目录/注册表字节不变）；漂移目录（用户改动）dry-run 照常 USER_FILE_REFUSED；purge dry-run 报告将清理项且保留用户归档；空注册表 dry-run 空报告不抛；正常 uninstall 行为零变化。

- [ ] 失败测试 → 确认失败 → 实现 → 全绿 → 提交（分支 `b7-lane-b`）：`feat: uninstall --dry-run validates and reports without removing`

### Task 3 (协调者): 三技能消费套件、证据、终审、推送

- [ ] fixture 延续 b6（含 careful 拒绝历史与 git log）；补一个含缺口的小测试文件（供 test-audit 发现真实缺口）
- [ ] **learn 消费**：Degraded 条款适用；对「force-push HIGH 拒绝+越界删除 reject」事件捕获教训（learn 规定结构：触发/教训/来源），落 `.gstack-memory/lessons.jsonl`，GBrain 差距如实
- [ ] **retro 消费**：按其回顾框架对 fixture 周期（baseline→危险变更→拒绝→修复）产出回顾报告
- [ ] **test-audit 消费**：审计 fixture 测试（其方法论：覆盖缺口/断言强度），产出真实发现（如 sum 的 NaN 分支无断言）
- [ ] 全程 tasks 记账；证据 `docs/verification-2026-10-27-workflow-suite.md`
- [ ] VERIFICATION 第十二轮 + 证据 JSON + 0.4.4 + 摘要 → 终审 → 推送 → CI 绿

## Deferred

- 两项用户解锁（首尾重申）；GBrain 真实接入（待宿主验收后评估）；M3 设备依赖组；M4。
