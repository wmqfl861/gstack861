# 批次 17 计划：doctor 状态整合 + verify-* 脚本族统一回归与文档收口（2026-10-28）

## 目标

1. **doctor 状态整合（Lane A）**：批次 16 的恢复纵向与 ZCode harness 尚未进 doctor 输出（hosts 串仍停在批次 14 措辞）。新增机器可读 `verticals` 段：全部 10 个验证/工作流脚本的 {keyed, status, evidence}，hosts 两串刷新为如实措辞；证据路径必须真实存在（测试断言）。
2. **verify-* 脚本族统一回归与文档收口（Lane B）**：`docs/VERIFICATION-SCRIPTS.md` 参考总表（脚本×目的×密钥×状态×证据×运行方式×预算纪律）+ `scripts/verify-offline.mjs` 统一离线回归 runner（CI 安全：密钥脚本 BLOCKED 冒烟 + 离线 harness 整跑）+ `npm run verify-offline` + CI 增一步统一回归。测试钉死"表↔文件系统↔doctor"三方一致性。

全批 0 密钥。

## 现状事实（已核实）

- doctor 当前 hosts：zcode=`not-host-verified`、dsh=`ship-vertical-verified-single-keyed-runs`（批次 14 措辞，落后两批）。
- 脚本族（10 个）：`verify-8dot3`（win 探针）、`verify-dsh-guard`/`verify-dsh-vertical`/`verify-dsh-robustness`（键控，无密钥 exit 2）、`verify-dsh-skills`（无密钥但**需本机 DSH**，CI 不可跑）、`verify-model-review`（无密钥就绪检查）、`dsh-mini-vertical`/`dsh-ship-vertical`/`dsh-recovery-vertical`（键控 exit 2）、`zcode-workflow-vertical`（纯离线 exit 0）。
- 证据文档名（已 ls 核实）：`docs/verification-2026-10-27-dsh-pipeline.md`、`-dsh-vertical.md`、`docs/verification-2026-10-28-dsh-robustness-vertical.md`、`docs/verification-2026-10-28-batch14-dsh-ship.md`、`docs/verification-2026-10-28-batch16.json`、`docs/verification-2026-10-27-batch10b.json`（skills activation）、`docs/verification-2026-10-27-batch11.json`（model-review 就绪）等。

## Lane A：doctor 整合（bin/gstack861.mjs + test/adapters.test.mjs）

- hosts 刷新：zcode=`workflow-harness-verified-offline`（六阶段人工工作流证据 + 批次 16 机器可检离线 harness；**非 host_verified**）；dsh=`ship-and-recovery-vertical-verified-single-keyed-runs`。
- 新增 `verticals` 对象（键=脚本名，值={keyed, status, evidence}）：
  - `verify-dsh-guard`：keyed, `deny-verified (2026-10-27)`, dsh-pipeline.md
  - `verify-dsh-skills`：keyless-by-design, `activation-verified (3 controls, batch 10b)`, batch10b.json
  - `verify-dsh-vertical`：keyed, `skills-runtime+allow-path verified (2026-10-27)`, dsh-vertical.md
  - `verify-dsh-robustness`：keyed, `deny->allow consistency verified (2026-10-28)`, batch13 md
  - `verify-model-review`：keyless, `five-segment readiness verified (batch 11)`, batch11.json
  - `dsh-mini-vertical`：keyed, `spec->implement->qa + journaling vertical-verified (2026-10-28, incl. 1 honest fail + fix)`, batch13 md
  - `dsh-ship-vertical`：keyed, `ship+approvals vertical-verified (2026-10-28)`, batch14 md
  - `dsh-recovery-vertical`：keyed, `reap->resume recovery vertical-verified (2026-10-28)`, batch16 json
  - `zcode-workflow-vertical`：offline, `offline-workflow-journal-harness PASS (2026-10-28)`, batch16 json
  - `verify-8dot3`：manual-probe, `windows-only alias probe (run recorded in VERIFICATION round 20 era; $?-chain artifact honestly noted)`, VERIFICATION.md
- 状态串保持英文短措辞（doctor 是机器读的 JSON）；每条 status 语气与 VERIFICATION 各轮一致，不升级不宣称 host_verified/full。
- 测试（adapters.test.mjs 增量）：doctor 输出 verticals 恰 10 键且与上述脚本名集合相等；每个 evidence 路径 `fs.existsSync` 为真；hosts 两串钉死新值；`networkCalls/modelCalls` 仍 0。

## Lane B：统一回归 + 文档收口（docs/VERIFICATION-SCRIPTS.md + scripts/verify-offline.mjs + package.json + test/verification-scripts.test.mjs + .github/workflows/ci.yml）

### B1. docs/VERIFICATION-SCRIPTS.md

参考总表，列：脚本 | 目的（一句）| 密钥 | CI 可跑 | 运行方式 | 状态 | 证据。表后两节：密钥预算纪律（≤200 字符 throw-before-launch、密钥仅进子进程 env、逐批上限与累计数以 VERIFICATION 为准）与"CI 安全边界"（verify-dsh-skills 需本机 DSH、verify-8dot3 卷相关，均不入统一回归，标注 manual/local-only）。

### B2. scripts/verify-offline.mjs（统一离线回归 runner）

- 依序 spawnSync 子进程并聚合（每步打印 ✓/✗ 与退出码，任一失败总体 exit 1）：
  1. 六个键控脚本的 **BLOCKED 冒烟**（env DEEPSEEK_API_KEY=''）→ 期望 exit 2 + /BLOCKED/（它们在 env 检查即返回，无需 DSH，CI 安全）。
  2. `zcode-workflow-vertical` 整跑 → 期望 exit 0 + /RESULT: PASS/。
  3. `verify-model-review` → 期望 exit 0（若 CI 环境缺配置导致非 0，则按其设计判定——先在本机与 CI 实证；不稳则移出 runner 并在表中标注 local-only，如实记录）。
- 自身零网络零模型；开头打印所跑清单与总耗时。
- package.json scripts 增 `"verify-offline": "node scripts/verify-offline.mjs"`。

### B3. CI

`.github/workflows/ci.yml` 的 offline-contracts（ubuntu+windows 两腿）在测试步骤后追加 `npm run verify-offline`（约 +10–15s/腿）。render-upstream 腿不动。

### B4. test/verification-scripts.test.mjs（三方一致性，避免与既有单脚本测试重复）

1. **表↔文件系统双射**：解析 md 表格 → 与 `ls scripts/{verify,dsh,zcode}-*.mjs` 集合相等（无孤儿无幽灵）。
2. **证据存在**：表中每个证据路径 existsSync。
3. **doctor↔表一致**：doctor 输出的 verticals 键集 === 表中脚本列集合（跨 lane 集成断言）。
4. **runner 契约**：`node scripts/verify-offline.mjs`（子进程）exit 0（它编排的是已测行为，这里是编排级断言，不重复语义覆盖）。
5. md 表中 keyed 列与 doctor verticals 的 keyed 布尔一致。

## 密钥预算

0（全离线）。项目累计 12 不变。

## 文档与版本（合并后最终 HEAD）

0.4.16；VERIFICATION 第二十五轮；FEATURE_MATRIX 状态行刷新（doctor 整合 + 统一回归入 CI）；README 开发文档节提一句 VERIFICATION-SCRIPTS.md；证据 JSON `docs/verification-2026-10-28-batch17.json` 最终 HEAD 重算。

## 流程

计划 → 独立审计划 → 双 lane 并行（A: bin+adapters.test；B: md+runner+package.json+ci.yml+新测试；零文件重叠）→ 独立审成果 → 合并 → 0.4.16 文档 → 摘要 → push → CI 3/3（此时 CI 已含 verify-offline 步）。

## 风险与对策

| 风险 | 对策 |
|---|---|
| verify-model-review 在 CI 缺配置不稳 | 预案明确：实证不稳即移出 runner、表中标注 local-only，VERIFICATION 如实记录（不硬塞） |
| doctor verticals 与 md 表漂移 | 测试钉死三方一致（双射+键集相等+keyed 布尔一致） |
| CI 时长增长 | 实测 +10–15s/腿；键控冒烟都是 env 检查即返回 |
| 表格解析脆弱（md 手写） | 测试用行前缀 `| scripts/` 精确切片解析；表格式在测试里钉一行样本 |
| 证据文件名写错 | 测试 existsSync 逐条断言（会红） |

## 非目标

- 任何键控运行（本批 0 计费）。
- verify-dsh-skills 的 CI 化（需本机 DSH，结构性不可行）。
- doctor 的网络/深度探测（保持零网络零模型）。

## 审计划必改落实（2026-10-28，独立审计划 4 项）

1. **hosts 测试是改不是增**：既有测试 `doctor makes no claim...`（adapters.test.mjs:350-357）钉着旧 hosts 串与 `modelCalls===0`——**原地更新**两串 + 补 `networkCalls===0`（现无任何测试钉它）；`modelCalls` 不重复钉。新增 verticals 测试只覆盖：恰 10 键集合 + 每条 evidence existsSync。
2. **8dot3 轮次改为第 5 轮**（PR #1 Windows 验收；$?-chain 诚实记录在 VERIFICATION.md:163；第 6/7 轮有复跑）。原"round 20 era"有误——不得把错误轮次钉进机器可读输出。
3. **跨 lane 合并门显式化**：B4.3/B4.5（doctor↔表一致）读的是 Lane A 的 verticals 输出，单 lane 内必红——合并前的 lane 验收以"本 lane 文件自洽"为准，**成果审查在本地合并树上跑**（沿批次 15/16 既定流程）。
4. **陈旧字面量归属**：host-loading.md:15,152、zcode-acceptance.md:7,167、acceptance-pack.mjs:119,189 中"doctor 显示 not-host-verified（直到受控验收）"的表述归 **Lane A** 同批更新为新串的如实措辞（zcode 新串 `workflow-harness-verified-offline` 仍非 host-verified，语义不变、字面更新）。

另采纳建议：证据文件名逐条写死（batch13 证据 = docs/verification-2026-10-28-dsh-robustness-vertical.md，同时覆盖 robustness 与 mini-vertical）；runner 显式传 `env: { ...process.env, DEEPSEEK_API_KEY: '' }`；verify-dsh-guard/vertical 的无密钥单测钉死归 Lane B 新测试顺带补上（各一行 exit-2+/BLOCKED/，此前无单测钉过）；三重执行成本（~15s/腿实测构成）在 VERIFICATION 如实记录。
