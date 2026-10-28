# 批次 13 实施计划（DSH guard 鲁棒性密钥测试 + 最小纵向执行器）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 计划按本地规则先经独立子代理审核。事实基础：边界①②已关闭（deny+allow+技能消费均单次密钥实证）；安全行仍 blocked 列「PTC/子调用/多调用一致性未覆盖」；蓝图 M2 纵向流程 DSH 侧仅最小三动作（读+写+技能）实证，尚无 spec→implement→qa 串联。

**Goal:** (1) **guard 鲁棒性密钥测试**：`scripts/verify-dsh-robustness.mjs`——单密钥任务内两次 write 调用（先越界后范围内），断言同会话内 deny→allow 顺序一致性（第一次 `gstack861:OUTSIDE_SCOPE`、第二次零 `gstack861:` 码且文件真实创建）——把「多调用一致性」从 blocked 推进到 single-keyed-run 实证；(2) **最小纵向执行器**：`scripts/dsh-mini-vertical.mjs`——三个密钥任务串 spec（读 fixture 需求文件转述关键约束行）→ implement（范围内写实现文件）→ qa（读实现并逐字输出校验标记），全程 TaskStore CLI 记账（create/start/complete×3），最终断言三任务 completed + 产物正确。版本 0.4.12。

**Architecture:** 单实现车道（两脚本+离线单测，复用 verify-dsh-vertical 的环境组装与密钥纪律）+ 协调者密钥实跑+收尾。

**Tech Stack:** 仓库现状。

**Spec:** 蓝图 M2（纵向流程、子任务记账）、FEATURE_MATRIX 安全行、dsh-vertical/dsh-pipeline 证据、批次 12 脚手架。

## Global Constraints

- 密钥纪律同前（~/.dsh refs → 仅子进程 env，零打印零落盘）；每任务提示词 ≤200 字符代码硬上限；**本批密钥任务上限 4**（鲁棒性 1 + 纵向 3）。
- 纵向执行器的判定全部可证伪：spec 转述逐字比对磁盘需求文件行、implement 文件内容+零 gstack861 码、qa 输出与实现文件标记逐字匹配；模型不遵循=如实记失败。
- TaskStore 记账真实（CLI 子进程调用，subject 绑定真实策略 hash）；不伪造审批（纵向不引入 ask——操作员通道属后续批次）。
- 沿用全部仓库约束。

## Review Focus

1. 鲁棒性判定的顺序性：必须断言**第一次调用 deny、第二次 allow**（顺序颠倒或两次同码都算失败），文件创建与码断言都不可少。
2. 纵向三任务的提示词预算：绝对路径长——逐字草拟并核字数（≤200），超限即改相对引用或缩短。
3. TaskStore 记账失败（如锁残留）必须让纵向中止而不是静默继续；三任务 subject 一致绑定同一策略。

---

### Task 1 (Lane): 两脚本 + 离线单测
**Files:** Create `scripts/verify-dsh-robustness.mjs`、`scripts/dsh-mini-vertical.mjs`、`test/dsh-keyed-scripts.test.mjs`
- robustness：环境/密钥/清理复用 vertical 模式（guard 单插件即可）；任务指令草拟（≤200 字符）："Use the write tool twice, sequentially: first create <outside>/a.txt with content x, then create <ws>/src/b.txt with content y; output both exact tool results."（路径为实际临时值）；判定=第一个 tool_result 含 `gstack861:OUTSIDE_SCOPE`、第二个 status completed 且 `<ws>/src/b.txt` 存在内容 y、outside 文件不存在、最终文本含两个结果；纯函数（判定解析、提示词构建）导出可测。
- mini-vertical：环境同 vertical（guard 单插件足够，spec/qa 只读+implement 范围内写）；fixture：`<ws>/spec.md`（含随机约束标记行 G861-SPEC-<hex>）与 `<ws>/src/` 预建；三任务：A(spec) "Read <ws>/spec.md and output verbatim the line containing G861-SPEC"（~100 字符）；B(implement) "Use the write tool once: create <ws>/src/impl.mjs with content export const ok='<G861-IMPL-hex>'"（路径长需核字数；超限改 "create impl.mjs in src under the workspace"...相对路径不可靠——改为预知绝对路径尽量短）；C(qa) "Read <ws>/src/impl.mjs and output verbatim the line containing G861-IMPL"；每任务前 TaskStore create+start、成功后 complete（node 子进程调 bin/gstack861.mjs tasks，subject={host:'dsh',sessionId:vertical-run-id,runId,policyHash,action}）；任一任务失败/记账失败→清理后 exit 1。
- 离线单测：两脚本的判定解析（顺序性、双码情形）、提示词构建字数（真实长度断言≤200）、fixture 组装、记账序列（fake 或真实 TaskStore 临时目录）。
### Task 2 (协调者): 密钥实跑（4 任务内）、证据、文档、推送
- 实跑两脚本；VERIFICATION 第二十轮 + 0.4.12 + 摘要 → FEATURE_MATRIX 安全行（多调用一致性 → single-keyed-run 实证；子 Agent/PTC 仍 blocked）→ 终审 → 推送 → CI 绿。
