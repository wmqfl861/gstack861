# DSH 鲁棒性与最小纵向验证证据（2026-10-28 批次 13）

密钥纪律同前（~/.dsh refs → 仅子进程 env，零打印零落盘）。本批密钥任务 7 个（计划上限 4 + 一次修复复跑 3，原因见下），单任务均 ≤200 字符提示词、~7k tokens。

## 鲁棒性：同会话 deny→allow 一致性（1 密钥任务，PASS）

中文指令 162/200 字符（含「第一个报错也要执行第二个」条款）。真实流水：模型先调 `write` 写 `o/a.txt`（越界）→ `gstack861:OUTSIDE_SCOPE`（status error）→ **模型遵守条款继续第二次** `write` `w/s/b.txt`（范围内）→ status completed、零 guard 码、文件精确创建；越界文件不存在。判定器按流序+路径归属配对（无 callId 依赖）。「多调用一致性」自 blocked 推进为 **single-keyed-run 实证**。

## 最小纵向 spec→implement→qa + TaskStore 记账

**第一次运行（诚实失败）**：任务 B/C 通过；任务 A 失败 `gstack861:UNMAPPED_TOOL`——提示词只说 "Read..."，模型漂移选择了未映射的读取工具（策略本身已绑定 read/write）。这是只有密钥路径才能暴露的真实缺陷，被可证伪判定路径如实捕获并按 `tasks fail` 记账。修复：A/C 提示词显式 "Use the read tool"（~+21 字符仍在预算内）+ 离线回归断言（提示词必须以该短语开头）。修复本身经车道审查后的协调者变更，已补回归测试（309 全绿）。

**第二次运行（PASS，真实 exit 0）**：
- A(spec)：读 `<ws>/spec.md` → 逐字输出 `G861-SPEC-473bd2ef: d680a75e`（随机标记）。
- B(implement)：范围内 `write` `<ws>/s/impl.mjs` → guard abstain、内容精确 `export const ok='G861-IMPL-42aa61ff'`。
- C(qa)：读实现文件 → 逐字回显同一行。
- 记账：每任务同一 action 文件贯穿 create→start→completed（subjectDigest 稳定）；清理前 `tasks list` 断言恰好 3 条记录、终态正确、绑定真实 policyHash。

## 状态升级

- 安全行：「多调用一致性」→ single-keyed-run 实证（子 Agent/PTC/旁路穷尽仍 blocked）。
- 纵向流程（DSH 侧）：spec→implement→qa + 记账 → **vertical-verified (single keyed run)**；ship 阶段与审批接入未含。
- 模型漂移教训入库：密钥任务提示词必须钉死工具名（回归断言已固化）。
