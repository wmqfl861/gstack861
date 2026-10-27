# 批次 7 实施计划（M3 纯工作流技能消费 II + uninstall dry-run 对称）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核。复用已验证消费模式（累计 5 例）。三目标技能均含自身 Degraded mode 条款；learn/retro 引用 GBrain（gstack 记忆系统）——本仓库未实现，按「机制差距如实+替代产物」处理。

**Goal:** (1) 消费 `learn`（对批次 6 的 careful 拒绝事件按 learn 自身规定的捕获 schema（gstack-learnings-log JSON：{skill,type,key,insight,confidence,source,files}）记录——GBrain/learnings 二进制未实现，替代产物落 fixture 仓库 `.gstack-memory/lessons.jsonl` 并明标非 GBrain；source 用其证据枚举（observed））、`retro`（按其 Steps 0-14 框架与规定章节（tweetable 摘要/Summary Table/Trends/各维信号/3 Things to Improve 等）对 fixture 周期产出回顾报告；metrics 二进制缺失走其明文降级路径（never invent values，如实披露）；**Step 13 规定的 JSON 快照真实写入 fixture `.context/retros/<date>-<N>.json`**）、`test-audit`（按其**测试价值**方法论——低价值目录/四问价值条/退役卡/裁决 retire-rewrite-extend-retain——审计 fixture 测试；NaN 分支发现以其词汇表述（no_claim/断言强度→rewrite/extend 裁决）；报告路径的 $GSTACK_STATE_ROOT/gstack-paths 依赖缺失→替代路径披露+validation not run 如实标注）；(2) `uninstall --dry-run`（与 install 对称；**镜像真实卸载序列**：目标校验（缺失目标→空报告不抛错）→ regularFile 注册表检查（缺失→空报告）→ loadRegistry → 逐技能 verifyOwned（抛错保留）→ purge 只读预演列表；**不含 assertRegistryPathSafe**——真实卸载从不调用它）；(3) 文档滞后清偿（README batch6 链接、矩阵行准备）。版本 0.4.4。

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
- `uninstallSkills({ target, purge, dryRun })`：dryRun=true 时**镜像真实序列**（插入点=目标校验块后、withInstallLock 前）：目标字符串/绝对/符号链接检查（缺失目标→`{dryRun:true,wouldUninstall:[],wouldPurge:[]}` 空报告不抛错，与真实行为一致）→ regularFile 注册表（缺失→空报告）→ loadRegistry+去重 → 逐技能 verifyOwned（registry 为锚，抛错照常不吞）→ 若 purge：只读列出将被清理的备份项（命名 `/^[a-z0-9][a-z0-9-]*-d{13,}$/`（13 位及以上）**且** manifest.generator===gstack861；损坏 manifest 保留）并计算备份根是否会清空。返回 `{ dryRun: true, wouldUninstall, wouldPurge }`——**wouldUninstall=[...recorded.keys()]（含已缺失目录的注册名，镜像真实返回）**。跳过锁（不报 INSTALL_BUSY、可能陈旧——证据注明）、跳过全部删除与注册表写入。
- CLI：`uninstall --target DIR [--purge] [--dry-run]`。
- 测试：已安装 target dry-run 报告全量+零变更（目录/注册表字节不变）；注册但目录已缺失→计入 wouldUninstall（镜像 install.test.mjs:609 的真实语义）；漂移目录 dry-run 照常 USER_FILE_REFUSED；purge dry-run 报告将清理项、保留用户归档与损坏 manifest 项、报告根是否清空；缺失目标与缺失注册表→空报告不抛；符号链接/junction 目标→INVALID_TARGET 零写入（平台对偶）；CLI `uninstall --dry-run` 报告形状；正常 uninstall 行为零变化。

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
