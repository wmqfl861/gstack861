# 双开发线整合说明 — 2026-11-01（交付 A）

> 读者：独立审核与合并决策代理（ChatGPT）及后续开发者。
> 对象：`integrate/m3-local-acceptance-20261101`（候选整合分支，PR 目标
> `work/m3-command-aliases-20261029`）。本文记录两侧输入、逐文件裁决、移植项、
> 验证结果与证据映射，便于独立复核；`.superpowers/` 下的过程材料（计划、三份
> 裁决报告、审核报告、补丁脚本）按仓库规则不发布。

## 1. 输入与提交序列

| 侧 | SHA | 说明 |
|---|---|---|
| 共同基线 | `680b2f19b2dbef8831e3be1fd996203589b5c41d` | merge-base（与 PR #3 基线一致） |
| 开发线 | `146256f166b314f2d35529bbd71a488e6edf5e01` | `work/m3-command-aliases-20261029` 远端头部（整合时点） |
| 验收线 | `1ac506c0e84f8c1bc0b9bad3cdd952543c0286ed` | `audit/local-m3-windows-20261030`（ChatGPT MERGE-APPROVE 固定接纳范围） |
| M | `2b45122`（两父 merge） | 三方 merge 冲突裁决（§2） |
| P | `7a308f3` | dev 独有修复移植 P1-P4 + 回归（§3） |
| D | （本提交） | 交付记录修正 A1-A5、本说明、补充清单、证据目录 |

历史事实复核：`git diff f4d1bd3..69b0d93 -- src/` = 空（seam 修复未触碰产品代码）。

## 2. 冲突裁决摘要（8 文件）

三份独立裁决（每文件一个只读分析代理，三方 `git show` 对比）+ 整合计划独立
APPROVE（含三项修正，均已落实：六文件改名注记、引用实证口径、P1 语义注明）。

| 文件 | 裁决 | 要点 |
|---|---|---|
| `src/aliases.mjs` | 取验收线 | dev 的 realOutput/控制字符/整键折叠/清理所有权均被 fs-utils inspectPlainPath 体系覆盖或更强（dev 的 `rmSync(dest,{recursive,force})` 恰是验收线测试锁定不许的行为）；**目录前缀折叠变体裁决保留验收线支持语义**（整键折叠检查已完全阻止不敏感 FS 写碰撞；支持语义有测试锁定） |
| `src/dsh-profile.mjs` | 取验收线 | plainDirectory/loadPolicy 包装/SKILLS_ADAPTER_FILE_REQUIRED 均被覆盖或统一（错误码集=验收线全集，`ADAPTER_FILE_REQUIRED` 统一 guard/skills adapter） |
| `src/zcode-profile.mjs` | 取验收线（连带 fs-utils/install/bin/四套测试整体） | dev 多 entry 收据与验收线单一所有者+`ZCODE_RECEIPT_CONFLICT` 冲突（后者测试锁定）；ROLLBACK_CONFLICT 等分类学被验收线恢复协议超集覆盖；dev Windows 注入框架被 windows-identity 取代 |
| 4 个测试文件 | 验收线全保 + 并入 dev 独有有效用例 | 并入：dsh `both generated plugin dependencies…`（安装后激活+真实离线契约端到端，验收线无等价物；适配说明：变量名 `name`→`skillName` 避免遮蔽依赖循环变量，dev 原文其余断言含 `result.files` 包含性检查在复审后已完整恢复）。删除的 dev 用例均被验收线超集/同场景覆盖（junction-overlap、折叠变体第三组、路径形态注入回滚、dev 收据文件名/错误码两套）；双进程竞态测试按审核建议适配后保留（P 提交） |
| `docs/LOCAL-M3-ACCEPTANCE-2026-10-30.md` | 撞名拆分 | 验收线 Windows 报告保持原名（实证引用=HANDOFF+4 个历史 git-status 快照）；开发线 Linux 记录改名 `…-LINUX.md`，更新 3 个 md 链接（两个 ADDENDUM+DELIVERY.md）；**六个字节冻结 jsonl/json 不动**：`WINDOWS-CI-V2.evidence.jsonl`、`-V2.inputs.json`、`WINDOWS-CI.evidence.jsonl`、`-CI.inputs.json`、`2026-10-30.evidence.jsonl`、`-31-DELIVERY.evidence.jsonl`——其内部旧路径由 -LINUX.md 头部注记与本节解释 |

## 3. 移植项 P1-P4（P 提交 `7a308f3`，均复用既有错误码）

| 项 | 内容 | 回归 |
|---|---|---|
| P1 | aliases `renameFrontmatter`：拒绝模糊 YAML key（引号/tag/anchor/alias/合并键）+ name 行宽匹配全行严格校验（`name :` 拼写随之收紧为拒绝——dev 有意收紧，验收线无测试使用该拼写） | dev 两组 YAML 歧义测试并入后全绿；验收线 frontmatter 测试全保绿 |
| P2 | zcode `json()` 严格 UTF-8 fatal 解码（原实现会把损坏字节以 U+FFFD 解析成功并重写回用户配置） | 新增非 UTF-8 config/receipt 用例：两 planner 拒绝且字节不变 |
| P3 | zcode workspace 驱动器根 → `WORKSPACE_INVALID` | 新增用例 |
| P4 | dsh 脚手架 README 5 步文本 + Skills adapter 行 + 缺 import 阻止激活警示 | 两侧测试均不读 README（零断言影响），字节等价性由生成文本自证 |

## 4. 验证（整合树 `7a308f3`，全部真实退出码）

| 门 | 环境 | 结果 |
|---|---|---|
| 全量 | 本机 Windows + Node 24.21.0 | **1389 tests / 1369 pass / 0 fail / 20 skip，exit 0** |
| 全量 | 锁定 Node 22.16.0 直跑（TAP） | **1389/1369/0/20，exit 0** |
| check / verify-offline / doctor / inventory | 锁定 Node 22.16.0 直跑二进制 | 全部 exit 0（check 119 模块；offline 9/9；doctor 自报 v22.16.0；inventory 固定上游 57 技能；upstream submodule 锁 `5755601` 未动） |
| 零设备全量 | win32 preload（lstatSync dev=0） | 首跑 1389/1368/**1**/20（唯一失败=host-setup-cli spawnSync 10s 超时，已知 flake 模式，单独复跑两种条件均 ~1.4s 通过）；复跑 **1389/1369/0/20，exit 0**。两日志并留 |
| 增量说明 | — | 相对验收线 1383：+6 = YAML×2 + strict-UTF-8×1 + drive-root×1 + 双进程竞态×1 + both-generated×1；20 skip 为该树既有 win32 条件跳过集，无新增 skip |

数字口径（A3）：1389/1369/0/20 为**本机 Windows**三环境（Node24/Node22/零设备）一致值；
Linux 开发线历史记录（Ubuntu 1164/1163/0/1、Windows CI 1163/1142/0/21）属于其独立套件，
不得与本树数字互换。CI 矩阵（ubuntu/windows Node 22.16.0 + render）结果以推送后实际 run 为准。

## 5. 渲染与宿主边界（A5）

托管 `render-upstream` 任务在历史各 run 实际执行并成功（托管已验证）；本机未装 Bun、
渲染入口受 CI 执行策略限制，本地未渲染——两者分开标注。DSH/ZCode 真实宿主边界维持
HANDOFF §5 不变（B 轮处理就绪判定与隔离宿主验收）。

## 6. 证据

- 新证据目录：`docs/evidence/post-m3-2026-11-01/`（`.gitattributes` `* -text`；含上述各门
  日志、受影响套件定向记录、清单 `evidence-manifest.json` 逐文件 SHA256）。
- 历史证据：两侧既有目录字节未动；`residual-seam/copied-evidence.json` 原 18 条保留，
  追加 `supplemental-evidence.json` 说明其范围（A2）。
- dev 侧证据自校验（整合前对 `146256f` 树）：DELIVERY 19/19、2026-10-30.evidence
  219/219、WINDOWS-CI 66/66、V2 61/61 全部 SHA256+字节数自洽。

## 7. 合规声明（有记录支持）

无 main 写入、无强推、无改写两侧已发布历史、无全局依赖安装/升级、无用户 ZCode/DSH
配置或凭据读写、无真实模型或付费调用（含子任务与审核）、上游 submodule 未升级；
历史证据字节未动；被 `*.log` 忽略的必要日志逐文件检查后 `add -f`，未整仓强制添加；
`.superpowers/` 未提交。

## 8. DSH 受管就绪入口与三层边界（交付 B，2026-11-01 追加）

`gstack861 dsh-profile-verify --output <profile> --policy <p> --adapter <a> --skills <dir>`
是产品侧的只读就绪聚合门（B3）：structure（package.json 声明 + 双 shim 经
fs-utils 链验证）、shims（**字节级**绑定校验——不动态 import profile 内代码，
verify 自身不执行任何可能被篡改的 shim）、policy（真实 `loadPolicy` 编译）、
skills（`loadRegistry` 条目 SKILL.md digest 逐一比对）。输出 JSON
`{schemaVersion,status,checks[]}`；not-ready 时 exit 1 + stderr
`DSH_PROFILE_NOT_READY`。它不启动宿主、不安装包、不派发工具；宿主进程 exit 0
从来不是就绪证据（run-guide 实测 optional 插件 apply 失败仍 exit 0）。

| 层 | 提供的保护 | 明确不覆盖 |
|---|---|---|
| 产品受管入口 | verify 四检查（派发前就绪判定）+ guard admission（每次工具调用重载策略：运行中策略损坏→`gstack861:POLICY_UNAVAILABLE` 拒绝、越界→OUTSIDE_SCOPE、未映射工具→UNMAPPED_TOOL、SKILL_TAMPERED 拒绝激活且无部分 section） | 未经此入口的启动；宿主激活本身 |
| 宿主自身 | cordis 依赖链：required 插件（system-prompt→tools→guard）FAILED 时宿主不激活该插件 | optional apply 失败仍 exit 0；任意第三方插件行为 |
| 旁路入口 | —（OPEN） | PTC、子代理、自定义执行器、直接 node 脚本绕过 guard 的路径：未实测、未宣称不可绕过 |

"启动时曾经健康"不构成后续授权：guard admission 是每次调用的检查，verify 只是
派发前的聚合判定；两者共同构成本仓库定义的受管路径，旁路路径的封闭依赖宿主侧
或 OS 级边界（见 ZC-07 边界文档）。
