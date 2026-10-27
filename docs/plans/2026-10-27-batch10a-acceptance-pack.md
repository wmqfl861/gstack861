# 批次 10a 实施计划（解锁助具：受控验收开箱包）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 紧凑批次：单脚本+测试；计划审查与任务审查各一轮。**不越离线边界**：本脚本是解锁 B 的操作助具（降低用户在受控新会话执行 zcode-acceptance.md 与 host-loading §2.4 的摩擦），不新增任何功能宣称， FEATURE_MATRIX 不改。

**Goal:** `scripts/acceptance-pack.mjs --out DIR`：一条命令生成受控验收包——(1) `DIR/workspace`：git 初始化的小 fixture（含一个可编辑文件）+ `DIR/workspace/.zcode/skills` 装载真实渲染技能（若渲染树可用）；(2) `DIR/policy.json`：样例策略（只绑 Read/Write/Edit，workspace=DIR/workspace，策略在 workspace 外——满足 loadPolicy 约束）；(3) `DIR/STEPS.md`：打印好的两份清单（zcode-acceptance 验收清单摘要 + host-loading §2.4 观察项 A/B）与逐步指引（开新会话→按单核对→把结果交回）；(4) `zcode-config` 片段落 `DIR/hook-snippet.json`。渲染树来源：`--rendered DIR --manifest FILE --host zcode`（可选；缺省时跳过技能装载并在 STEPS.md 注明「本包未含技能装载——自动拾取验收需先装载」）。

**Architecture:** 单模块脚本+测试；无生产代码改动；版本 0.4.7。

**Tech Stack:** 仓库现状（零依赖）。

**Spec:** docs/integration/zcode-acceptance.md（清单）、host-loading.md §2.4（观察项）、批次 4 stage-render、zcode-config。

## Global Constraints

- 不修改 ~/.zcode/~/.dsh；不执行付费调用；脚本只写 `--out` 指定目录。
- STEPS.md 必须逐字引用两份手册的清单项并链接原文（不复制全文）；诚实：技能装载缺失时明示。
- 测试离线（无 bun/无网络）。

## Review Focus

1. 生成的 policy 真能通过 loadPolicy（策略在 workspace 外、只绑文件工具）。
2. STEPS.md 清单项与两份手册一致（逐字核对）。
3. `--out` 拒绝已存在非空目录；路径安全。

---

### Task 1: 脚本+测试（单实现者）

**Files:** Create `scripts/acceptance-pack.mjs`、`test/acceptance-pack.test.mjs`
- 接口如 Goal；错误码 UPPER_SNAKE（OUT_EXISTS/INVALID_RENDERED 等透传 stage-render）；fixture 文件内容含中英文以顺带验证多字节。
- 测试：out 生成（workspace git repo+policy 可 loadPolicy+STEPS.md 含关键清单词+snippet 存在）；带 --rendered 的完整路径（用测试内构造的迷你渲染树）；--out 非空目录拒绝；缺 --rendered 时 STEPS 注明。

### Task 2 (协调者): 证据、README 解锁节一句话指向本脚本、摘要、终审、推送
- README 离线边界节解锁 B 处加「一键生成受控验收包：node scripts/acceptance-pack.mjs --out DIR」。
- VERIFICATION 第十五轮 + 0.4.7 + 摘要 → 终审 → 推送 → CI 绿。
