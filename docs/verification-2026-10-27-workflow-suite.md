# 工作流技能消费套件 II 证据（2026-10-27，批次 7 Task 3）

范围：按已装载渲染技能消费 `learn`、`retro`、`test-audit`（累计消费 8 例）。边界同前：上下文注入、自动拾取未验证、非 host_verified、0 付费调用。

环境：真实 Windows 本机，Node.js v24.21.0；fixture 延续批次 6（含 careful 拒绝历史），新增含真实价值缺口的测试文件（`sum` 调用无断言）。

## 执行记录（真实命令与产物）

任务记账：learn（24f3908e）、retro（de8a40ad）、test-audit（bee0dfb2）经 tasks CLI 记录，终态均 completed（中途一次 planned 态 `start` 报 `TASK_WRONG_STATE` 的状态异常，随后 start/complete 成功、终态以 `tasks show` 验证为准——如实记录，未深究）。

### learn（任务 24f3908e）

- **按其真实捕获 schema**（`gstack-learnings-log` JSON：`{skill,type,key,insight,confidence,source,files}`——计划审查纠正了我最初杜撰的三元组结构）：对批次 6 两个真实事件（force-push HIGH 拒、越界删除 reject）各捕获一条 `type: pitfall`、`source: observed` 教训，落 fixture `.gstack-memory/lessons.jsonl`。
- **机制差距如实**：learn 的读取路径有明文降级（`|| echo "No learnings yet."`），捕获路径无降级——learnings 二进制与 `$GSTACK_STATE_ROOT` 均依赖 gstack 宿主安装；替代产物明标非 GBrain，下游接入待宿主验收。

### retro（任务 de8a40ad）

- 按其 Steps 框架对 fixture 周期（f8ffffb..4f5e6c4）产出**其规定章节**的回顾（tweetable 摘要/Summary Table/各维信号/3 Things to Improve=recommendations/Habits）；`gstack-retro-metrics` 二进制缺失走其明文降级路径——**数值未杜撰**（其原文 never invent values），计数来自真实 `git log`。
- **Step 13 规定的 JSON 快照真实写入** fixture `.context/retros/2026-10-27-1.json`（scratch fixture 内的技能规定输出）。

### test-audit（任务 bee0dfb2）

- 按其**测试价值**方法论（低价值目录+四问价值条+裁决词汇）：`sum adds numbers` 命中「无断言探针」（目录第 1 类）与 `no_claim`（对 NaN 分支/转换语义零声明）→ **裁决 rewrite**（非 retire——被测函数值得覆盖），修复路径给出（期望值+NaN 分支+转换语义断言）。
- **report-only**：按技能规定未改动任何测试；真正执行退役卡需独立批次+操作员批准。
- **路径与验证披露**：技能规定产物路径 `$GSTACK_STATE_ROOT/...` 依赖 gstack-paths（未安装）→ 替代为 fixture 根的 `test-audit-2026-10-27.md`；validation not run 如实标注。

## 结论

三技能消费均「遵循/替代/差距」逐项留档；两处技能自身降级路径（retro metrics、learn 读取）按其原文执行，两处机制差距（learnings 写入、产物路径）以明标替代产物处理。渲染技能累计消费 **8 例**。
