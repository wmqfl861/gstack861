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

1. 鲁棒性判定按审查裁定：流序两调 outside→inside、按路径/结果归属配对（无 callId 依赖）、零码仅查第二个 tool_result、文件双侧断言、缺第二调=独立理由的诚实 FAIL 不重试。
2. 纵向三任务的提示词预算：绝对路径长——逐字草拟并核字数（≤200），超限即改相对引用或缩短。
3. TaskStore 记账失败（如锁残留）必须让纵向中止而不是静默继续；三任务 subject 一致绑定同一策略。

---

### Task 1 (Lane): 两脚本 + 离线单测
**Files:** Create `scripts/verify-dsh-robustness.mjs`、`scripts/dsh-mini-vertical.mjs`、`test/dsh-keyed-scripts.test.mjs`
- robustness：环境/密钥/清理复用 vertical 模式（guard 单插件即可）；提示词（**审查实测中文变体 145-168 字符，英文版 176-186**；计划字面稿 268-278 已否决）：极简脚手架（mkdtemp 前缀 1-2 字符、单字母目录 `root/o/a.txt` 越界/`root/w/s/b.txt` 范围内、单字符内容）+ 中文指令含「第一个报错也要执行第二个」（~168 字符，管线 deny 运行已证中文指令服从）；运行期对**实际构建的提示词** throw-before-launch 上限（防病态 tmpdir）；离线测试用合成超长 root 断言构建器 ≤200。**判定**（审查裁定）：不依赖 callId——按流序断言恰好两个 write tool_call 且 outside→inside 顺序；按路径/结果归属（含 OUTSIDE_SCOPE 的 tool_result 属第一个、completed 属第二个）；**零码检查仅限第二个 tool_result**（最终文本合法转述 OUTSIDE_SCOPE，全流零码会假失败）；`w/s/b.txt` 存在+内容 y、`o/a.txt` 不存在；任何其他形状（重试/多调/缺第二调）=诚实 FAIL（「模型 deny 后未执行第二调——模型行为非 guard 失败」独立理由、exit 1、安全行保持 blocked、**不自动重试**）；超时 480s；纯函数导出可测。
- mini-vertical：环境同 vertical（guard 单插件足够，spec/qa 只读+implement 范围内写）；fixture：`<ws>/spec.md`（含随机约束标记行 G861-SPEC-<hex>）与 `<ws>/src/` 预建；三任务：A(spec) "Read <ws>/spec.md and output verbatim the line containing G861-SPEC"（~100 字符）；B(implement) "Use the write tool once: create {abs impl.mjs} with content export const ok='G861-IMPL-<8hex>'"（审查实测 155-160 字符，标记钉死 8 位 hex；**相对路径回退已划除**——适配器不传 cwd，相对路径必被 INVALID_PATH_OR_CALL 拒，必须绝对路径）；C(qa) "Read <ws>/src/impl.mjs and output verbatim the line containing G861-IMPL"；每任务一个**同一 action 文件**贯穿 create/start/complete（subjectDigest 稳定性——transitions 逐次比对）；policyHash 取自 loadPolicy(policyPath).policyHash（与 guard 同文件同 hash）；--state/--action-file 绝对路径；密钥任务失败先 tasks fail 再清理（终态真实）；清理前 tasks list 断言终态；任何 CLI 非零/不可解析→清理+exit 1。
- 离线单测：两脚本的判定解析（顺序性、双码情形）、提示词构建字数（真实长度断言≤200）、fixture 组装、记账序列（fake 或真实 TaskStore 临时目录）。
### Task 2 (协调者): 密钥实跑（4 任务内）、证据、文档、推送
- 实跑两脚本；VERIFICATION 第二十轮 + 0.4.12 + 摘要 → FEATURE_MATRIX 安全行（多调用一致性 → single-keyed-run 实证；子 Agent/PTC 仍 blocked）→ 终审 → 推送 → CI 绿。
