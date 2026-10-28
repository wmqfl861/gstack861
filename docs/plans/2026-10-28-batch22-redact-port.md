# 批次 22 计划：redact 扫描核心移植（patterns+engine+CLI）（2026-10-28）

## 范围（按实际读码修正指令的行数口径）

| 上游件 | 行数 | 本批 |
|---|---|---|
| lib/redact-patterns.ts（分类学：模式/层级/类别/占位判定） | **1075**（指令未计入，引擎核心依赖） | **移植（Lane A）** |
| lib/redact-engine.ts（纯扫描+自动脱敏） | 817 | **移植（Lane A）** |
| lib/fs-utils.ts（mkdirpSync） | 27 | **移植（Lane B）** |
| bin/gstack-redact（CLI 扫描路径） | 341 | **移植（Lane C）** |
| bin/gstack-redact-prepush + hook install/uninstall | 790+ | **defer**（独立批次；guardrail 集成件，有自己的 5 个上游测试文件；审计入 OFFLINE-COMPLETE） |

上游测试资产（移植的保真基准）：redact-engine.test.ts、redact-engine-autoredact、redact-unicode-offsets、redact-span-binding、redact-env-value、redact-context-exemptions、redact-dotenv/parcel 假阳性、gstack-redact-cli.test.ts 等。

## Lane A：src/redact-patterns.mjs + src/redact-engine.mjs + test/redact-engine.test.mjs

- **patterns**：PATTERNS/PATTERNS_BY_ID/isPlaceholderSpan 及全部模式数据逐条移植（regex + tier + category + 元数据）；ReDoS 线性时模式保持原样（上游有 pattern-lint 测试——若可移植则一并移植为我们的 lint 测试）。
- **engine**（纯，除 process.env 读取可注入 processEnv）：normalizeWithMap（NFKC+零宽剥离+小集 HTML 实体解码+索引回映原偏移）；maskPreview（≤4 前导字符）；scan（占位抑制按匹配 span、工具栅栏 ```codex-review```/```greptile``` 降级 WARN——除非活格式凭据、可见性只记录不改层级）；credentialEnvValues/NON_SECRET_ENV_NAMES；applyRedactions/redactFindingSpans/redactJsonFindingSpans（含 RedactionEdit）；exitCodeFor（0 无 M/H、2 有 M 无 H、3 有 H；WARN 永不改码）；尺寸上限 fail-closed（超限=单条合成 HIGH "input too large"，默认 1MiB 可覆写）。
- **测试**：适配上游 redact-engine/autoredact/unicode-offsets/span-binding/env-value/context-exemptions/dotenv/parcel 假阳性向量为 node:test（bun/TS→ESM 语法适配，语义不动）；加注入 processEnv 的 env-value 向量。

## Lane B：src/fs-utils.mjs + docs/OFFLINE-COMPLETE.md §二 更新

- fs-utils：mkdirpSync（bun-on-Windows EEXIST #2635 语义——recursive+容已存在）。
- OFFLINE-COMPLETE：redact → ported（扫描核心，本批；上游 17+ 测试文件向量回放）；prepush（790 行）→ deferred 独立批次（特征一句话：pre-push stdin refs 解析、remote..local 增行扫描、新分支 merge-base 回退、删分支跳过、force-push 净新增语义、GSTACK_REDACT_PREPUSH=skip 旁路；guardrail 非 enforcement）。

## Lane C（A+B 合并后串行）：bin/gstack861-redact.mjs + test/redact-cli.test.mjs

- CLI 扫描路径：stdin 缺省/--from-file（**显式空路径报错不落 stdin**——#2679）；--json {findings,counts,repoVisibility,oversize}/人读表；退出码 0/2/3（消费方语义逐字）；旗标 --repo-visibility/--allowlist/--self-email/--repo-public-emails/--auto-redact（逗号分隔 id→脱敏正文 stdout+diff stderr）/--max-bytes；stdin 16MiB 硬顶；**不含** hook install/uninstall 子命令（defer，usage 注明）。
- 测试：适配 gstack-redact-cli.test.ts 向量 + 空路径错误 + 退出码三态 + --auto-redact diff + 上限 fail-closed + oversize JSON。
- 差异账本：bun→node shebang；hook 子命令缺省（defer 注记）；其余逐字。

## 密钥预算

0。版本 0.4.21；VERIFICATION 第三十轮。

## 流程

计划 → 独立审计划 → A/B 并行 → 合并 → C 串行 → 独立审成果 → 0.4.21 文档 → 摘要 → push → CI 3/3。

## 风险与对策

| 风险 | 对策 |
|---|---|
| patterns 数据移植错漏 | 逐条移植+上游测试向量回放兜底；PATTERNS_BY_ID 完整性断言 |
| Unicode 归一化偏移回映移植偏差 | 上游 unicode-offsets 测试逐向量回放 |
| 上游 TS 测试适配走样 | 仅语法适配（bun:test→node:test），断言值不动 |
| CLI 与引擎接口错位 | Lane C 在 A 合并后开工，导入真实模块 |

## 非目标

- prepush 钩子（790 行，独立批次）。
- /cso、document-skills 等其它 redact 消费方（上游另有测试文件，属其宿主域）。

## 审计划必改落实（2026-10-28，独立审计划 4 项）

1. **engine 清单补 5 组导出语义**：email 豁免簇（selfEmail/repoPublicEmails/@example.\*/noreply 系 localpart + isSshGitRemote 三形态按 URL 形状判定、512 前瞻）；`ScanOptions.sourcePath`（#3048——patterns 的 isSourceExpression 凭它豁免 TS/JSX 源码，CLI --from-file 写入）；工具栅栏标签全集 **codex-review|greptile|eval|codex|tool-output 五种**；applyRedactions 结构守护（markdown 链接目标/JSON 字符串值内 span→skipped，RedactResult.skipped 即 --auto-redact 的 skipped 来源）；redactFindingSpans/redactJsonFindingSpans 的 **null 扣留契约**（marker-only 模式 pem/gcp 或 span 不可定位→null；JSON 跨 token/碰结构→null、number-token 整体加引号+转义加宽 #3185、非 JSON 退化普通 splice）。patterns 定性修正：**数据 + ~550 行上下文校验器**（Luhn/Shannon 熵/isCredentialShapedEnvName/parcel/坐标/CI-id/版本声明/dotenv/UUID 内含/URL 占位/env-read/call-expression/TS-source/schema-field）；span 推导两侧（patterns spanBounds 镜像引擎 group-1-else-match-0）必须同步——点名审计项。
2. **测试适配 4 类非纯库依赖逐条定策**：engine.test.ts 尾部 #3048 与 unicode-offsets 尾例 **spawn 真 bin**→移入 Lane C 回填（A 阶段裁除、C 阶段补）；unicode-offsets/span-binding 的 **lib/cso/process 导入**（各 1-2 断言）→随 cso 批次回填并显式标注；env-value 读 **bin/gstack-brain-lock.sh**→改写为内联断言集合内容；context-exemptions 读 **48KB fixtures（flow.svg/flow.excalidraw）**→fixtures 随 Lane A 移植入 test/fixtures/redact-diagram/。pattern-lint 为纯库测试→**承诺移植**。
3. **fs-utils 移入 prepush 批**（本批扫描路径零消费者；CLI defer 子命令时连 mkdirpSync/spawnSync import 一并删）。**Lane B 收缩为纯文档**：OFFLINE-COMPLETE §二 更新措辞用"扫描核心（本批完成）"+ prepush 特征句补 state-root/sealed-guard 依赖半句。
4. **退出码四态**：0 clean / **1 usage**（空 --from-file #2679、非法 --max-bytes #1824、未知子命令、TTY 无 stdin）/ 2 MEDIUM / 3 HIGH（边界超限进引擎前即 3）；`process.exitCode` 排空语义（bd621cc0 回归）入测试；slow-pipe 两组 **POSIX-only**（上游自注排除 Windows curated subset）——win32 平台条件跳过（沿仓库惯例）。exports 注册：src 两模块入 package.json exports（沿仓库现状）。
