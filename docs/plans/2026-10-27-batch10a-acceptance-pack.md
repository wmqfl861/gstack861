# 批次 10a 实施计划（解锁助具：受控验收开箱包）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 紧凑批次：单脚本+测试；计划审查与任务审查各一轮。**不越离线边界**：本脚本是解锁 B 的操作助具（降低用户在受控新会话执行 zcode-acceptance.md 与 host-loading §2.4 的摩擦），不新增任何功能宣称， FEATURE_MATRIX 不改。

**Goal:** `scripts/acceptance-pack.mjs --out DIR`：一条命令生成受控验收包——(1) `DIR/workspace`：git 初始化的小 fixture（含一个可编辑文件）+ `DIR/workspace/.zcode/skills` 装载真实渲染技能（若渲染树可用）；(2) `DIR/policy.json`：样例策略（只绑 Read/Write/Edit 三工具；workspace=DIR/workspace；**writeRoots=[DIR/workspace/src]**（proper 子集——使验收清单的「越界写」项有真实目标）、readRoots=[DIR/workspace]；策略文件在 workspace 外且**显式 mode 0o600 写入**（umask 无关，满足 loadPolicy 的 UNSAFE_POLICY_PERMISSIONS）；fixture 的 src/ 目录先建后写策略（directory() 要求真实存在）；(3) `DIR/STEPS.md`：逐步指引（开新会话→按单核对→**把结果记录到 DIR/RESULTS.md 并交回项目**）；zcode-acceptance §6 清单**八行 A–H 全部逐字引用**（操作列以生成的真实绝对路径代入；正斜杠 C:/ 形式，Git Bash 友好）；host-loading §2.4 观察项 A/B 逐字引用，C/D 指针+说明（C 依赖本包 staging）；两份手册以**绝对路径链接**（STEPS.md 在 repo 外，相对链接不解析）；注明移动 DIR 使烘焙路径失效（同手册 §4 第 4 点）；git 缺失时 `GIT_INIT_FAILED` 干净报错；(4) `zcode-config` 片段落 `DIR/hook-snippet.json`（matcher 'Read|Write|Edit'）。渲染树来源：`--rendered DIR --manifest FILE --host zcode`（可选；缺省时跳过技能装载并在 STEPS.md 注明）。提供时：合成 staging 于 `DIR/staging-zcode`（绝对、不存在、与 rendered 不重叠——OVERLAPPING_PATHS 约束），`stageRender` 错误原样透传，链路续接 `installSkills → DIR/workspace/.zcode/skills`；**staging 保留**（§2.4 观察项 C 需对照其中同名 SKILL.md）。

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
- 接口如 Goal；`--out` 绝对路径（相对→ABSOLUTE_PATH_REQUIRED，同其他目录旗标）；错误码 UPPER_SNAKE（OUT_EXISTS/INVALID_RENDERED/GIT_INIT_FAILED 等透传 stage-render）；fixture 文件（src/notes.md）内容含中英文以顺带验证多字节。doctor 的 unlocks 字符串与其精确匹配测试**不动**。
- 测试：out 生成（workspace git repo+src 存在+policy 可 loadPolicy+writeRoots 恰为 src+STEPS.md 含八行 A–H 关键词与绝对路径链接+snippet matcher 正确+policy mode 非 0666）；带 --rendered 完整路径（复用 test/stage.test.mjs 的 renderOutput() 迷你树 recipe；断言技能落 .zcode/skills 且 staging 保留）；--out 非空拒绝；相对 --out 拒绝；缺 --rendered 时 STEPS 注明。

### Task 2 (协调者): 证据、README 解锁节一句话指向本脚本、摘要、终审、推送
- README 离线边界节第③项括注后追加一句「一键生成受控验收包：`node scripts/acceptance-pack.mjs --out DIR`（详见 --help）」；13 项清单/已尽措辞/消费计数均不动。
- VERIFICATION 第十五轮 + 0.4.7 + 摘要 → 终审 → 推送 → CI 绿。
