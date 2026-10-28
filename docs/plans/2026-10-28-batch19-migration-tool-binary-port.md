# 批次 19 计划：离线余量实施——原生状态迁移工具 + 纯工具二进制移植与全量审计（2026-10-28）

## 目标

实施 OFFLINE-COMPLETE §二 离线余量的第一波，按实际读码后的诚实再定范围：

1. **Lane A——原生迁移工具（本项目自己的已记录债务）**：上游 `gstack-migrate-claude-code` 语义是"重命名上游自己在其他宿主的技能安装"，映射到 gstack861 的真迁移需求是 **0.3.1 状态文件命名空间断裂**（README 已记录："0.3.0 写入的无前缀 `<uuid>.json` 记录升级后等效丢失，需人工改名迁移；不提供自动迁移"）。本批交付 `migrate-state`：自动、安全、可验证地迁移 0.3.0 遗留记录——把文档化的"人工"路径变成工具。
2. **Lane B——纯工具二进制全量前提审计 + 移植真值得移植的**：逐一审计 7 个实名二进制（前提/规模/与本项目架构的关系），落地审计结论；移植唯一零前提且未来 GBrain 直接受益的 `gstack-jsonl-merge`（git merge driver，105 行 bash）为零依赖 Node。

## 上游读码结论（计划基线；审计划复核）

| 二进制 | 规模 | 前提审计结论 |
|---|---|---|
| gstack-jsonl-merge | 105 行 bash | **零前提、宿主无关**：git merge-driver 契约（%O %A %B），拼接去重+ts 排序+sha256 兜底排序。本项目 TaskStore/ApprovalStore 是单文件 JSON 非 JSONL，但 GBrain（⑤）日志正是 append-only JSONL——**移植** |
| gstack-patch-names | 34 行 | 逻辑=技能目录 name: 前缀改写。**本项目已在渲染期解决**（src/stage.mjs renderedDir 前缀映射，stage-render 链实测）——移植即冗余，审计结论"已覆盖"，不移植 |
| gstack-paths | 160 行 | 前提=Claude 插件运行时环境（CLAUDE_PLUGIN_DATA/~/.claude/plans 链）。本项目状态根是**显式绝对 --state**（安全设计：模型不可写工作区外）——**前提不适用**，不移植（移植=为一个我们不支持的宿主发明需求） |
| gstack-slug | 880 行 | 纯工具但体量大，独立批次移植（批次 20 候选） |
| gstack-redact | 341+817（引擎） | bun+TS 引擎，移植需连 lib/redact-engine.ts——独立批次（批次 20 候选） |
| gstack-issue-links | 202 行 | 依赖 gstack-issue-guard 等上游内部件——待其依赖面审计后定（deferred） |
| gstack-banned-terms | 90 行 | 读 git 历史+仓库策略文件，宿主无关——**可移植**（小，但非本批必需；deferred 至二进制批次集中做，避免碎片化） |
| gstack-migrate-claude-code | 20+270 | 语义属上游安装域（见上）——**映射移植为 Lane A** |
| gstack-team-init | 269 行 | bash 团队引导模板——deferred（依赖上游模板内容审计） |

## Lane A：src/migrate.mjs + CLI `migrate-state`（bin/gstack861.mjs）+ test/migrate.test.mjs

### 0.3.0 记录形状（git 已核实，dc2280f^）

- 文件名：`<uuid>.json`（无前缀）。
- task：`{schemaVersion:1, id, subjectHash, state, attempts, createdAt, updatedAt[, owner]}`。
- approval：`{schemaVersion:1, id, subjectHash, state, issuedAt, expiresAt}`。

### migrate.mjs 设计

`migrateStateFiles({ stateDir, dryRun = false, log })` → `{ migrated: [{file, kind}], refused: [{file, reason}], pendingCount }`：

1. 扫描仅**无前缀** `<uuid>.json`（uuid 严格校验）；`task-*`/`approval-*`/其他文件不碰。
2. 分类判据：`attempts`（integer）在 → task；否则 `expiresAt`（integer）在 → approval；两者都有/都无/解析失败 → **refused**（ambiguous，绝不猜）。
3. 迁移前校验：文件 lstat 常规文件、非符号链接、nlink 1、≤4KiB；record.id === 文件名 uuid；schemaVersion===1；目标前缀文件**不存在**（存在 → refused collision）。
4. 迁移=原子 rename（`<uuid>.json` → `task-<uuid>.json`/`approval-<uuid>.json`）；dryRun 零写入（只报告）。
5. 上限保护：单文件 >4KiB 拒绝；stateDir 必须绝对路径（沿用 store 纪律）；不改文件内容（字节不动，只改名）——旧记录内容对现版 read() 兼容（task 无 leaseExpiresAt 可选字段；approval 同）。
6. 错误码 UPPER_SNAKE_CASE：`ABSOLUTE_STATE_PATH_REQUIRED`、`AMBIGUOUS_RECORD`、`ID_MISMATCH`、`DESTINATION_EXISTS`、`UNSAFE_RECORD_FILE`。

### CLI

`gstack861 migrate-state --state DIR [--dry-run]`：构造 store 级校验前置（绝对路径、目录存在）；输出 JSON 报告；exit 0=全部迁移或无需迁移 / 1=存在 refused；usage 更新。

### 测试（test/migrate.test.mjs）

- 快乐路径：0.3.0 形状 task+approval 各一条（手写字节，含结尾换行）→ dry-run 零写入+报告 → 实迁移 → 新 TaskStore/ApprovalStore `get(id)` 可读且字段完整（端到端证明"等效丢失"被修复）。
- 拒绝矩阵：ambiguous（两字段都有/都无/坏 JSON）、id 不匹配、目标已存在（同名 task- 前缀先建）、符号链接、超大文件、非 uuid 文件名不碰、已前缀文件不碰。
- 混合目录：前缀+无前缀+外来文件共存 → 只动该动的。
- CLI 子进程：dry-run 零写入；exit 码语义；--state 相对路径拒绝。
- 历史保真：迁移后字节与原文件逐字节相等（只改名）。

## Lane B：bin/gstack861-jsonl-merge.mjs + 测试 + OFFLINE-COMPLETE §二审计落盘

### jsonl-merge 移植（零依赖、独立可执行）

- git merge-driver 契约：argv = base ours theirs；结果写 ours（%A）；exit 0 成功 / 1 冲突。
- 语义按上游：读三文件 → 行级拼接 base+ours+theirs → **精确去重**（同字节行只留一份，保留首次出现）→ 排序：行含 ISO `ts` 字段（JSON 行 `"ts":"..."`）按 ts 升序；无 ts 的行按行内容 sha256 升序稳定兜底；**空行与非 JSON 行原样保留但参与去重**（上游语义：dedup exact-duplicate lines + sort by ts when present）。
- 实现：`node:crypto` sha256；无 tmp 文件直接写 ours（git 已在临时区）；参数 <3 → exit 1 + stderr。
- 与上游差异如实记录：上游用 mktemp 临时+trap；Node 版直接写（语义等价，少一个临时文件）；bash 3.2/5.2 兼容 hack 不适用。

### 测试（test/jsonl-merge.test.mjs）

- 契约主路径：base/ours/theirs 各含部分行+重叠行 → ours 被写为去重+ts 排序结果；exit 0。
- 尾部同行冲突场景（上游动机场景）：两机各 append 一行 → 两行都在、按 ts 排序。
- 无 ts 行：sha256 稳定排序（同输入两次运行输出逐字节相等）。
- 去重保序语义：重复行只留首次出现位置类的确定性行为（钉死与上游 bash 一致或记录差异）。
- 错误：参数不足 exit 1；文件不可读 exit 1；不写 ours。

### OFFLINE-COMPLETE §二 更新

审计表落盘（上面 9 行表直接入文档）：ported=1（jsonl-merge）、covered=1（patch-names→render 链）、N/A=1（paths→前提为 Claude 插件环境+本项目显式状态根设计）、mapped=1（migrate→Lane A 本批）、deferred=5（slug/redact/issue-links/banned-terms/team-init，各注规模与理由，二进制批次集中做）。

## 密钥预算

0（全离线）。项目累计 12 不变。

## 文档与版本（合并后最终 HEAD）

0.4.18；VERIFICATION 第二十七轮；FEATURE_MATRIX 生命周期相关行注记（迁移工具落地=json 文档化债务关闭；辅助工具行注记 jsonl-merge 移植+审计表）；README 0.3.1 迁移段落更新（"人工改名"→"0.4.18 起提供 migrate-state"）；证据 JSON；摘要重算。

## 流程

计划 → 独立审计划 → 双 lane 并行（A: src/migrate.mjs+bin+test/migrate.test.mjs；B: bin/gstack861-jsonl-merge.mjs+test+docs/OFFLINE-COMPLETE.md §二；零文件重叠——bin/gstack861.mjs 只有 A 动）→ 独立审成果 → 合并 → 0.4.18 文档 → 摘要 → push → CI 3/3。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 0.3.0 形状凭记忆写错 | 已从 git dc2280f^ 实际源码核出字段；测试用字节级手写 fixture |
| 分类判据误伤 | ambiguous 一律 refused 绝不猜；混合字段负控测试 |
| 迁移破坏数据 | 只 rename 不改字节（测试逐字节断言）；collision/unsafe 拒绝；dry-run |
| jsonl-merge 排序不稳定 | sha256 兜底+同输入两次运行逐字节相等测试 |
| 与上游语义漂移 | 差异显式记录在文件头注释与 VERIFICATION |

## 非目标

- slug/redact/issue-links/banned-terms/team-init 的移植（deferred，二进制批次）。
- GBrain 本体（⑤，前置③）。
- 上游 migrate-claude-code 的 1:1 直译（语义映射论证已给：那是上游安装域）。

## 审计划必改落实（2026-10-28，独立审计划 4 项，全部 Lane B jsonl-merge 语义）

1. **空行丢弃**：上游跳过空行（strip 尾 \n 后为空即 continue）——移植遵循，非 JSON 行保留。
2. **ts 键完整语义**：整行 JSON.parse → `obj.ts ?? obj.timestamp`，**仅当为字符串**才用作键；解析失败/非字符串/缺失 → sha256 兜底。测试覆盖 timestamp 别名与非字符串 ts 兜底。
3. **两群全序+行内容决胜**：键 = `(0, ts, lineContent)` 与 `(1, sha256hex, lineContent)`——ts 群整体在 hash 群之前；同键按原始行字节决胜（上游注释明示这是修 ours/theirs 交换分歧的关键）。**新增侧对称测试**：merge(base, ours, theirs) 逐字节 === merge(base, theirs, ours)。
4. **ENOENT≠不可读**：三输入任一 ENOENT 视为空（git merge-driver 常态：base 缺失正常）；非 ENOENT IO 错误 → exit 1 不写 ours。测试含缺 base 用例。

另采纳建议：Lane A 校验不构造 store（两构造器都会 mkdir——笔误 --state 会静默建目录）；Windows rename 可静默覆盖已存在目标——预检查是唯一防线，代码注释注明 TOCTOU 接受；pendingCount 语义定死（dry-run=would-migrate 数，实跑=refused 余量）；审计表补一句"上游内嵌 python3 前提，移植后消除"；输出行尾钉 LF（上游仅剥尾 \n，CRLF 行的 \r 属内容）；删除"首次出现位置"措辞（重排序后不可观测，侧对称测试才是有意义的钉子）。
