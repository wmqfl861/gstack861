# 批次 8 实施计划（M3 纯工作流技能消费 III + doctor 增强）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核。复用已验证消费模式（累计 8 例）。office-hours（1312 行，55 处 GSTACK_ROOT/gstack-paths 依赖）与 spec（1356 行，31 处）有重度宿主二进制依赖；deslop-shared-libs（201 行，0 处）纯方法论可全量遵循。

**Goal:** (1) 消费 `office-hours`（YC 办公时间六问——对 fixture 项目跑 startup 模式的问题框架与产出结论 memo）、`spec`（五阶段把模糊意图变成可执行规格——对 fixture 的模糊需求产出真规格文档；其 worktree/spawn 依赖如实跳过）、`deslop-shared-libs`（纯方法论：在 fixture 真实代码中找值得共享的抽取——产出其规定的候选清单）；(2) `doctor` 增消费计数与解锁提示（把累计消费例数与两项用户解锁动作打进 doctor 输出，让任何会话一眼看到项目真实状态）；(3) 文档滞后清偿。版本 0.4.5。

**Architecture:** Lane A（代码：doctor 增强+测试）与 Lane B（文档：README/矩阵滞后）不相交；Task 3 消费+证据+终审推送。

**Tech Stack:** 仓库现状。

**Spec:** 蓝图 M3 产品/规格/开发质量行、批次 5-7 消费模式、三技能渲染文本。

## Global Constraints

- 消费边界同前（上下文注入、自动拾取未验证、非 host_verified、0 付费调用）。
- office-hours/spec 的宿主二进制依赖（GSTACK_ROOT 工具、spawn worktree agent）逐项「遵循什么/跳过什么/为何」；可遵循的问题框架/阶段方法论全量遵循，产物为技能规定格式。
- spec 的五阶段产物链（问题→目标→非目标→验收标准→开放问题）必须完整真实；其「spawn agent」步骤以本会话直接执行替代并如实标注。
- 0 付费调用。

## Review Focus

1. 三技能「遵循/跳过/为何」逐项留档；重度依赖技能不得只跑了个壳——方法论骨架必须真实走完。
2. doctor 输出的消费计数来源必须是硬编码于 doctor 的真实轮次清单（随批更新），不得动态扫描证据文档。
3. 文档滞后一次清偿（README batch7 链接、矩阵版本行）。

---

### Task 1 (Lane A): doctor 消费计数与解锁提示

**Files:** `bin/gstack861.mjs`、`test/adapters.test.mjs`

**Interfaces:**
- doctor 输出新增 `consumption: { renderedSkillsConsumed: 8, evidence: [四个证据文档相对路径], note: 'context-injection; auto-pickup unverified' }` 与 `unlocks: { dsh: 'set DEEPSEEK_API_KEY then run node scripts/verify-dsh-guard.mjs', zcode: 'follow docs/integration/zcode-acceptance.md + host-loading.md section 2.4 in a controlled new session' }`（Task 3 后计数为 11——Lane A 写 8，Task 3 升 11）。
- 测试：doctor JSON 断言两字段形状与计数。

- [ ] 失败测试 → 确认失败 → 实现 → 全绿 → 提交（分支 `b8-lane-a`）：`feat: doctor reports consumption count and user unlock actions`

### Task 2 (Lane B): 文档滞后清偿

**Files:** `README.md`、`docs/FEATURE_MATRIX.md`
- README：开发文档节补 batch7 JSON + workflow-suite 证据链接（一轮滞后）。
- FEATURE_MATRIX：状态行 0.4.4→保留（Task 3 升 0.4.5）；消费行「8 例→本批 +3」由 Task 3 定稿——Lane B 不动消费行。
- 提交（分支 `b8-lane-b`）：`docs: round-12 evidence links`

### Task 3 (协调者): 三技能消费、doctor 计数升级、证据、终审、推送

- [ ] fixture 延续（含 lessons/retros 历史与含缺口测试）
- [ ] **office-hours 消费**：startup 模式六问（需求现实/现状/迫切窄楔/观察/…）对 fixture 项目（数学库+危险脚本清理的虚构产品语境）真实作答并产出其结论 memo；宿主依赖跳过逐项留档
- [ ] **spec 消费**：五阶段对模糊需求「让清理安全且可审计」产出完整规格（问题/目标/非目标/验收标准/开放问题）；spawn 步骤以本会话执行替代并标注
- [ ] **deslop-shared-libs 消费**：纯方法论在 fixture 真实代码（math.mjs 与 test 断言模式）中识别共享抽取候选，产出其规定清单
- [ ] doctor 计数 8→11（含测试断言同步）
- [ ] 全程 tasks 记账；证据 `docs/verification-2026-10-27-product-suite.md`；VERIFICATION 第十三轮 + 0.4.5 + 摘要 → 终审 → 推送 → CI 绿

## Deferred

- 两项用户解锁（首尾重申）；M3 设备依赖组；M4。
