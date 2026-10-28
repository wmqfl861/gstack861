# 批次 23 计划：redact-prepush 移植（790+27+276）+ hook 子命令回填（2026-10-28）

## 范围

| 件 | 行数 | 处置 |
|---|---|---|
| bin/gstack-redact-prepush | 790 | **移植 Lane B**（bin/gstack861-redact-prepush.mjs） |
| lib/sealed-guard.ts | 276 | **移植 Lane A**（src/sealed-guard.mjs；state-root→本项目 GSTACK861_STATE_ROOT 约定映射，账本） |
| lib/fs-utils.ts mkdirpSync | 27 | **移植 Lane A**（src/fs-utils.mjs，bun EEXIST #2635 语义） |
| ship-policy 三助手（containedRelative/globToRegExp/matchesAny） | ~40 | **提升为共享 src/ship-policy.mjs（Lane A）**；banned-terms 改导入（行为保持，29 测试回归兜底） |
| bin/gstack-redact 的 hook install/uninstall 子命令（批次 22 defer） | ~90 | **回填 Lane C**（wrapper 内嵌 `node "${prepushBin}"`；链式 pre-push.local；printf x 哨兵防 fail-open；幂等/刷新陈旧受管钩子语义逐字） |
| 上游 5 测试文件（2206 行） | — | 向量回放基准：scan-range(400)/target(432) 归 **Lane B**；emails(403)/rebase-force-push(207)/hook(764) 归 **Lane C**（依赖真钩子/端到端） |

## 关键语义（从上游读码锁定；审计划复核）

- **fail-closed 三处**：不可解析 ref 行（#2498）、算不出推送 diff（#1946）、超尺寸/超时——都 BLOCKED exit 1 并给 bypass 提示（GSTACK_REDACT_PREPUSH=skip / --no-verify）。
- **env 旁路**：`GSTACK_REDACT_PREPUSH=skip` 开头即 skip（理由 env 可覆写）。
- **diff 语义**：ref 行 `<local ref> <local sha> <remote ref> <remote sha>`；local 全零=删分支跳过；remote 全零/未知尖→新分支（merge-base 回退→独有提交全扫，上限 HISTORY_MAX_COMMITS=50k/超时 5s）；force-push=remote..local 净新增。分块扫描 SCAN_CHUNK 768KiB/重叠 16KiB/MAX 1MiB。
- **sealed-guard**：`.gstack/pregate.json` sealed 规则（paths/transcripts/answer_markers/seed_patterns/local_paths/visibility；64 条/256 regex 上限）；`sealed-allow.tsv`（rule/path/sha/reason）；可见性缓存 sealed-visibility.json（public 24h/private 1h TTL；`gh repo view` 5s 探测，unknown=public 处理）；findings 只报 file/line/rule/commit 不报匹配文本；LOCAL_PATH_RE 三平台家目录。
- **email 历史**：`git log` 历史 revs + tracking remote 的作者邮箱并入 repoPublicEmails 豁免。
- **版本豁免**：VERSION_FILE_CONTENT/CHANGELOG_RELEASE_VERSION 模式行豁免。

## Lane 划分

- **Lane A（库层）**：src/ship-policy.mjs（三助手提升；banned-terms 重构导入+回归）+ src/fs-utils.mjs + src/sealed-guard.mjs（276 全语义；状态根映射 GSTACK861_STATE_ROOT→~/.gstack861）+ 测试（sealed 单元：规则校验/allow 表/可见性缓存 TTL/本地路径三平台/glob 豁免；ship-policy 助手回归=复跑 banned-terms 29 测试）。
- **Lane B（prepush 二进制）**：bin/gstack861-redact-prepush.mjs（790 逐字；git 调用 spawnSync；skip/env/三 fail-closed/diff 三形态/分块/email 历史/版本豁免/committed allowlist）+ scan-range/target 两测试文件适配（node:test+真 git fixture）。
- **Lane C（串行，A+B 合并后）**：bin/gstack861-redact.mjs 回填 install/uninstall 子命令（wrapper 链式/哨兵/幂等/刷新）+ emails/rebase-force-push/hook 三测试适配（真钩子端到端；POSIX-only 段 win32 跳过沿惯例）+ 集成冒烟。

## 密钥预算

0。版本 0.4.22；VERIFICATION 第三十一轮。

## 流程

计划 → 独立审计划 → A/B 并行 → 合并 → C 串行 → 独立审成果（含对上游差分抽查）→ 0.4.22 文档 → 摘要 → push → CI 3/3。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 真 git 端到端 fixture 在 CI 慢/脆 | 上游测试自含 git 场景构造；沿 b20/b22 git fixture 先例（init 回退 <2.28） |
| sealed 可见性缓存写真实 home | 注入 stateRoot（沿 slug.mjs 先例）；测试断言隔离 |
| hook wrapper shell 语义（printf x 哨兵） | 逐字移植+POSIX-only 测试；win32 段跳过并注明 |
| banned-terms 重构引入回归 | 仅 import 替换；29 测试全量回归门 |

## 非目标

- issue-links（最后一项 deferred，后续批次）。
- pregate 体系其余部分（pregate-*.test.ts 属上游 /cso 域）。

## 审计划必改落实（2026-10-28，独立审计划 8 项）

1. **target(432) 移 Lane C**（其 fixture 每测跑 install-prepush-hook 并真 git push）。Lane B 测试基线=scan-range(400)+rebase-force-push(207)（后者直接 spawn 二进制、不需钩子——采纳建议移入 B）；Lane C=emails(403)+target(432)+hook(764)。
2. **超时语义纠正**：唯一超时=email 历史 `git log` 5s（HISTORY_TIMEOUT_MS，**非阻断**——降级豁免+"suppression was limited"注记，退出随 findings）；50k/5s 属 emailScanOptions 而非新分支链。超尺寸阻断=engine.* HIGH 且消息区分"could NOT be scanned"。
3. **diff 链完整化**：unknownRemoteTipBase 三步——①merge-base 于推送目标域默认分支（defaultRemoteBranch：target url→null/remote→其名/unknown→origin；symbolic-ref → <r>/main → <r>/master）②否则"无可达目标域远端跟踪 ref 的最旧提交之父"作 range base（非全扫）③无锚才 emptyTreeOid 全史。**主收窄机制补入**：addedLinesFromNewCommits（rev-list local --not remoteSha --remotes=<target>/*，排除不变集则退两dot区间保 #1946 gitStrict 路径；>500 提交回退；逐提交 `show --cc`）+ pushTarget argv 线程（remote/url/unknown）+ objectExists cat-file -e 门控。
4. **sealed 评估机制入档**：base∪pushed 策略并集（可收紧不可放宽；visibility 仅 base=private 且 push 不言 public 才 private）；publishedCommits（rev-list local --not --remotes=<remote>/* ^remoteSha+objectExists，错→error 报告 exit 1）；逐提交 diff-tree --stdin（路径规则 A/R/C name-status；文本规则 --cc unified=0 增行）；豁免**仅 base 分支** sealed-allow.tsv（sha 7-64 前缀、reason 必填）；状态→退出映射（findings+public/unknown→1；private→warned 非阻断；策略不可读→1）；renderSealed；可见性缓存**写路径**（try/catch 内 mkdirSync recursive+writeFileSync——逐字保真不改 mkdirpSync）；gh 缺失→unknown→按 public 计。
5. **Lane B logSkip 状态根映射**：`<stateRoot>/security/prepush-skip.jsonl`——用 GSTACK861_STATE_ROOT→~/.gstack861（复用 src/slug.mjs defaultStateRoot 模式）；**绝不写 ~/.gstack**；逃逸阀测试注入 GSTACK861_STATE_ROOT。
6. **Lane A 基线补 test/sealed-guard.test.ts（223 行 8 测）**：适配 7（真 argv+stdin 真 git 仓 + 注入 gh 桩 + GSTACK_STATE_ROOT 缓存隔离→GSTACK861_STATE_ROOT）；drop 1（gstack-pregate sealed CLI 测试，随 pregate 非目标，账本）。
7. **win32 分诊预算**：上游把全部 5 文件整排除出 Windows 精选集——本仓 CI 双腿全跑 106 测。逐测 win32 结构性失败以带理由 skip 处理（PATH 上的 POSIX git 桩无法 CreateProcess、Bun.which→Node、mode 位、50k fast-import 120s 计时、bash-on-PATH 包装测试）；不止两处预标段。
8. **hook(764) 的 5 个 "install UX surfaces" 测试不可移植**（读上游仓库 setup/ship 模板与 gstack-config 同意流，本仓无此工件）——显式 drop+账本，不许静默。
