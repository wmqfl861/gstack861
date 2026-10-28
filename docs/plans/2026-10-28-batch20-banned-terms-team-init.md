# 批次 20 计划：banned-terms 移植 + team-init 原生映射 + 大件评估（2026-10-28）

## 目标

1. **Lane A——`gstack861-banned-terms` 移植**（上游 bin 90 行 + lib/banned-terms.ts 167 行 + ship-policy 少量助手）：零依赖 Node，`check|init|validate` 三命令，`.gstack/banned-terms.json` 词表在 diff 新增行中扫描禁词（允许路径豁免）。
2. **Lane B——`gstack861 team-init` 原生映射**（上游 269 行 bash 深度绑定 Claude：CLAUDE.md、.claude/settings.json、vendored 拷贝迁移——**逐字移植对不支持的宿主无意义**）：映射为 `AGENTS.md`（ZCode 指令文件约定）+ 既有 zcode hook / DSH guard 接线的引导生成器，`optional|required` 两模式语义保留（建议 vs 强制）。
3. **大件单独评估**（slug 880 / redact 341+817 / issue-links 202+依赖面）：本批交付评估结论入 OFFLINE-COMPLETE §二（各自的下批次拆解计划与风险），不实施。

## Lane A：bin/gstack861-banned-terms.mjs + test/banned-terms.test.mjs

### 移植面（从上游 lib/banned-terms.ts 逐函数核对）

- **配置**：`.gstack/banned-terms.json` = `{$schema?, terms: (string | {term, allowed_paths, reason?})[], allowed_paths: string[]}`；上限 MAX_TERMS=200 / MAX_TERM=80 / MAX_PATHS=200；未知键=错误；缺失文件=`BANNED_TERMS: none`（ok，非失败）。
- **校验 validateBannedTerms**：结构 + glob 包含律（C1：无 `..`、非绝对、库内 glob）——需从 ship-policy.ts 移植最小助手 `containedRelative`/`globToRegExp`/`matchesAny`（读上游实现逐行对照移植，`globToRegExp` 语义以上游为准：`**`/`*`/`?` 等）。
- **加载 loadBannedTerms(repoRoot, ref?)**：ref 缺省读工作树；给 ref 读 `git show <ref>:<path>`（剥离场景：base 上无此文件→回退工作树）。
- **扫描**：`--files <csv>` 全文件模式 or diff 模式（`git diff --unified=0 --no-color <diffBase>` 解析新增行 `+` 行，`addedLines` 移植；diffBase 缺省 `git merge-base <base> HEAD`；base 缺省 origin/HEAD 不可用时报错要求显式 `--diff-base`/`--files`）。匹配：词边界、大小写不敏感；命中输出 term、file:line、行文本、允许路径；末行 `BANNED_TERMS: ok | found=<n> | none`。
- **init [--force]**：写带注释示例（exampleBannedTermsJson 移植）；已存在无 --force 拒绝。
- **退出码**：0 ok/none；1 found；2 usage（非 git 仓库/未知命令）；3 配置无效（上游 EXIT.refused 对齐我们的 exit 3=ask 先例）。`--json` 全结果。
- **差异账本**：与上游任何偏离（如 EXIT 命名、resultLine 格式简化）逐条记录在文件头。

### 测试（真实 git 仓库 fixture：mkdtemp + git init + commit）

- validate 矩阵（好配置/未知键/超限/坏 glob/非对象）；init 幂等与 --force；none 路径；check --files 全文件扫描含豁免 glob（`docs/**` 豁免 vs 其他命中）；diff 模式（base commit→HEAD 新增禁词命中、未改动行不命中）；--json 结构；exit 码全矩阵；词边界（"legacy-name" 不命中 "legacy-names" 中的子串? —— 以上游 regex 语义为准钉死）。

## Lane B：`gstack861 team-init`（bin/gstack861.mjs 子命令）+ test/team-init.test.mjs + OFFLINE-COMPLETE 更新

### 设计（原生映射，诚实标注非逐字）

`gstack861 team-init {optional|required} [--root DIR]`（缺省 git rev-parse --show-toplevel；非 git 仓库拒绝）：

- **optional**：向 `AGENTS.md`（不存在则创建）追加 `## gstack861 (recommended)` 段——一句项目说明 + 安装/验证命令（`npm run doctor` 与 acceptance-pack 指引）；已有 `## gstack861` 段则跳过（提示先删再跑）。**不**生成 Claude 任何文件。
- **required**：同上追加强制段（"开工前先跑 `node bin/gstack861.mjs doctor`，hosts 状态异常即停"），并打印两宿主的接线命令（zcode：`gstack861 zcode-config --policy ...`；DSH：guard profile 指引一行）——**复用既有入口而非发明新 hook 文件**（与上游 check-gstack.cjs 的差异记入映射说明）。
- **不做** vendored 拷贝迁移（Claude 专属语义）；输出 `TEAM_INIT: <files>` 清单；幂等（第二次跑跳过已有段）。
- 退出码 0/1；参数错误 usage。

### 测试

真实 git fixture：optional/required 两模式生成内容断言（含命令行、无 Claude 字样——映射纯度钉死）；幂等；已有段跳过；非 git 拒绝；--root 显式路径；AGENTS.md 已存在时追加不覆盖。

### OFFLINE-COMPLETE §二 更新

- banned-terms → ported（本批）；team-init → mapped（本批，映射论证）；**新增大件评估三行**：slug（880 行：交互式重命名流水线，需审计其 TUI/交互前提，建议独立批次+分段移植策略）、redact（341+817：bun+TS 引擎，移植需连 redact-engine.ts 与其测试语料，建议独立批次）、issue-links（202 行：依赖 gstack-issue-guard 等上游内部件，先审计依赖闭包再定）。

## 密钥预算

0（全离线）。项目累计 12 不变。

## 文档与版本（合并后最终 HEAD）

0.4.19；VERIFICATION 第二十八轮；FEATURE_MATRIX 辅助工具相关注记（banned-terms/team-init 落地）；OFFLINE-COMPLETE §二 同步；证据 JSON；摘要重算。

## 流程

计划 → 独立审计划 → 双 lane 并行（A: bin/gstack861-banned-terms.mjs+测试；B: bin/gstack861.mjs team-init 分支+测试+OFFLINE-COMPLETE；bin/gstack861.mjs 只有 B 动）→ 独立审成果 → 合并 → 0.4.19 文档 → 摘要 → push → CI 3/3。

## 风险与对策

| 风险 | 对策 |
|---|---|
| globToRegExp 语义移植偏差 | 逐行对照上游实现 + 边界测试（`**`、`*`、`?`、字面点号）；差异账本 |
| banned-terms 退出码与上游 EXIT 表错位 | 账本记录映射（ok=0/fail=1/usage=2/refused=3）；测试钉死 |
| team-init 被读作"上游等价" | 命令输出与文档三处显式"原生映射（非逐字）"标注；映射论证（CLAUDE.md→AGENTS.md、check-gstack.cjs→既有 zcode hook/DSH guard 入口） |
| 真实 git fixture 在 CI 的可用性 | git 在两 CI 腿均预装（render-upstream 已用 git archive）；mkdtemp+init+config user 快速路径 |

## 非目标

- slug/redact/issue-links 实施（评估先行，独立批次）。
- AGENTS.md 内容的产品化打磨（最小诚实段落即可）。
- 任何 Claude Code 宿主支持。

## 审计划必改落实（2026-10-28，独立审计划 6 项）

1. **policy 源默认值修正**：check 默认 `--policy-from base` = 读 base 分支 tip 的提交副本（`git show <base>:<path>`）；**回退在工作树的是 bin 层**（`if (policyFrom!=='head' && 'absent' in load) load = loadBannedTerms(repoRoot)`），lib 的 loadBannedTerms 只返回 absent。移植面补 `--base`/`--policy-from` 两旗标。
2. **自豁免**：scan 跳过 `.gstack/banned-terms.json` 自身（入 skipped[]）——否则 diff 模式会自标记 init 输出（示例含 "blazing fast"）。测试：init→commit→diff 检查不自标记。
3. **退出码全矩阵**：ok=0 / fail=1（findings、git diff 失败）/ usage=2（非 git、未知命令、无 merge-base）/ refused=3（配置无效、init 已存在无 --force）。**分歧记录**：exit 3=上游 refused 语义，与本项目 approvals ask 的 exit 3（pending 待重问）同数不同义、不同二进制。结果 shape 含 source/terms/scanned_files/skipped。
4. **base 解析链修正**：`--base`（剥 origin/ 前缀）→ `git symbolic-ref refs/remotes/origin/HEAD` → **静默回退 'main'**；usage 错误只发生在随后 merge-base 失败。fixture 注意 init.defaultBranch 差异：测试用显式 `--base`/`--diff-base` 或确保分支名 main。
5. **slug 评估行重写**：非"交互式/TUI"——项目身份 slug/分支解析器 + checkpoint 桶簿记（env 覆盖→标记上溯→canonical-remote slug→v2 缓存；`--classify-checkpoints`/`--adopt-legacy` 等；仅 `--adopt-legacy` 一处 /dev/tty 确认）。OFFLINE-COMPLETE 现有"纯工具但体量大"更准。
6. **AGENTS.md 出处标注**：本仓库 docs/integration 对 AGENTS.md 零记载——它是宿主侧约定，生成文本与文档一律按 host-loading §0 规则标"[宿主侧约定，验收项]"，不作仓库级断言。team-init 打印的接线命令逐字钉死 `gstack861 zcode-config --policy <ABS_PATH>`（仅 --policy/--matcher 存在），测试字符串断言。

另采纳建议：termRegExp 四规则入测试（特殊字符转义/词内空白→`\s+`/仅 `[A-Za-z0-9_]` 边缘加 `\b`/trim+i）；render 末行完整格式 `BANNED_TERMS: ok|found=<n> terms=N files=M source=S`（none 是 bin 层带括号行）；containedRelative 的 path.isAbsolute 平台差异钉稳定检测并携带 MAX_PATTERN=256/MAX_REGEX=512 上限；wholeFiles 静默丢弃缺失/目录/二进制（NUL 前 1024 字节）加二进制测试；team-init 退出码钉 0/1（usage 与非 git 均 1，与 bin 现行 catch-all 一致）；`--root DIR` 定义为绕过 git 要求（上游恒需 git，记为映射差异）；上游"Commit the generated files"尾块按映射重塑记录；redact 评估行补 fs-utils 依赖、issue-links 评估行补"lib 纯分类零导入，闭包边界在 bin 的 issue-guard/gh 调用"。
