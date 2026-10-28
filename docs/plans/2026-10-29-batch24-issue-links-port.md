# 批次 24 计划：issue-links 移植（最后一项离线余量）（2026-10-29）

## 前提审计结论（已读码）

- `lib/issue-links.ts`（188）：**纯分类零导入**——直接移植。
- `bin/gstack-issue-links`（202）：git log（离线可测）+ `gh`（GraphQL closing-PRs/related-PRs/flake 搜索——网络与凭据门控）+ `gstack-issue-guard` 子进程。**gh 缺失时的失败极性就是上游行为**（ISSUE_LOOKUP_FAILED/降级 Refs）——离线可测。
- `bin/gstack-issue-guard`（98）：依赖 `lib/tracker-guard.ts`（117，untrusted 信封——移植）+ `lib/bin-context.ts` 的 `flagValue`（397 行中只取这一个——提取+账本）。
- `resolveBaseBranch`：已内联于 banned-terms——**提升入 src/ship-policy.mjs**（b23 三助手同款，banned-terms 改导入+29 测试回归门）。
- 上游无 issue-links 专属测试文件（仅 tracker-guard.test.ts）——lib 单元向量自行构造 + tracker-guard 测试适配 + bin 离线路径 git fixture。

## Lane A（库层）

- `src/issue-links.mjs`：188 逐字（lineSources/mentionsIn/promotionCandidates/receiptIssues/relatedPrs/renderIssueLines/resolveLinks/selectFlakes 及类型）。
- `src/tracker-guard.mjs`：117 逐字（wrapUntrustedTrackerContent 信封格式）+ 适配上游 tracker-guard.test.ts。
- `src/ship-policy.mjs` += resolveBaseBranch 提升；banned-terms 改导入（回归门 29 测试）。
- 测试：lib 分类单元向量（Fixes trailer 各形/裸提及/跨仓/部分修复/promotion/Flake 匹配/render 行格式）+ tracker-guard 适配。

## Lane B（bin 层，A 先合 main 后收尾验证——b23 先例）

- `bin/gstack861-issue-guard.mjs`：98 逐字（gh argv 数组、issue 号先验证、失败极性非零无信封、空内容是数据）；flagValue 本地实现（上游 bin-context 提取，账本）。
- `bin/gstack861-issue-links.mjs`：202 逐字（flags 解析/git runner/gh runner 含 GraphQL 分页 MAX_PAGES=10/issue-guard 子进程调用路径→我们的 bin/分类渲染/--json/--out/退出码 0|1|2/HELP）。
- 测试（git fixture + gh 缺失极性）：纯提及分类主路径（无 --issue → 全 Refs）；--issue 时 gh 缺失 → ISSUE_UNREADABLE 降级 Refs + exit 1；promotion 候选输出；--no-auto-links；--json/--out 形状；usage exit 2；issue-guard：gh 缺失非零无 stdout 信封、--stdin 信封路径（离线完整可测）。

## 密钥/版本/流程

0 密钥；0.4.23；VERIFICATION 第三十二轮。计划→审→A/B 并行（B 收尾合 main-with-A）→审成果（含对上游差分抽查）→文档→摘要→push→CI 3/3。

## 风险

| 风险 | 对策 |
|---|---|
| gh 路径无离线正向测试 | 失败极性即上游 gh 缺失行为；正向 gh 行为不宣称已测（账本+VERIFICATION 明示） |
| 信封格式移植偏差 | tracker-guard.test.ts 适配兜底 |
| banned-terms 二次重构回归 | 29 测试门（b23 先例） |

## 非目标

- gh 在线正向行为（环境/凭据门控，同 §一解锁类）。
- bin-context 其余 397 行（无消费者）。

## 审计划必改落实（2026-10-29，独立审计划 4 项）

1. **测试基线更正**：上游 **test/ship-issue-intent.test.ts（252 行 13 测）** 即向量源（意图分类含 `v1.2.3 (#301)`/`Fixes #14 and #15` 非 trailer 形、resolveLinks 降级、promotion、selectFlakes 全拒绝理由、relatedPrs 各形态 + bin e2e 经 gh PATH shim：--out/--json 回执形状、ISSUE_LINKS: none、usage、closing-PR 两页分页、--no-auto-links、ISSUE_LOOKUP_FAILED 极性、--ci-run 拒绝、app-viewer 作者链）。**适配上游向量+账本 drop**（b20/b23 惯例），废弃"自行构造"；其中 shell 出 gstack-ship-receipt 的两段断言（54-56、207-224）drop+账本（ship-receipt 非目标）。tracker-guard-wiring.test.ts（148，上游自身仓库扫描）记 out-of-scope 账本。
2. **tracker-guard 依赖修正**：上游 :30 `import { INJECTION_PATTERNS } from "./jsonl-store"`（13 正则表）——**内联该表**（单一消费者）+账本，非移植 jsonl-store；全角/零宽逃逸测试依赖此表存在。
3. **result-codes 表面定策**：issue-links 用 resultLineWithDocs('ISSUE_LOOKUP_FAILED')（含 docs 链后缀，上游测试逐字断言）与 resultLine('ISSUE_UNREADABLE')——**按上游格式移植这两个码**（含 troubleshooting.md 链后缀），EXIT_TABLE_HELP 字节相同（上游断言全串）；账本记"仅此两码+退出表，非全表移植"。
4. **win32 双腿分诊预算**：gh PATH shim（#!/bin/sh 名为 gh）在 win32 CreateProcess 只解析 .exe——shim 类测试（tracker-guard 4 + bin 8）POSIX 腿跑、win32 带理由 skip；win32 跑 gh 缺失子集（ENOENT 极性/--stdin/非数字拒绝/未知模式/纯库向量）。"离线完整可测"限定 POSIX 腿，不作无限定宣称。

另采纳：B 的三处强制适配显式命名（Bun.stdin.text→Node stdin 读、Bun.fileURLToPath→node:url、guard 子进程改 `spawnSync(process.execPath, [<bin>.mjs,'issue',n])` 保 60s/16MiB/cwd）；--issue 离线 stderr 序列钉死（needRepo 先出一条 ISSUE_LOOKUP_FAILED(gh exited null) 再逐 issue ISSUE_UNREADABLE、stdout 降级 Refs、exit 1；无 --issue 路径零 gh spawn 反断言）；--out 语义（mkdir recursive+2 空格 JSON+尾换行）入测试；lane 形状注明为 b23 先例的适配（无 C）；resolveBaseBranch 保持 2 参形。
