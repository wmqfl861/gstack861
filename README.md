# gstack861

将 gstack 原生适配到 **ZCode** 与 **DeepSeek Harness（DSH）**。一套核心，两套独立宿主适配，不隐藏调用 Claude Code，不把提示词复制当作功能对等。

**当前版本：0.4.12 / foundation。不是完整可用的 gstack 双宿主发行版。**

## 开发文档

- [完整蓝图与阶段验收](docs/BLUEPRINT.md)
- [功能与证据矩阵](docs/FEATURE_MATRIX.md)
- [验证脚本族总表（目的/密钥/状态/证据/统一离线回归）](docs/VERIFICATION-SCRIPTS.md)（`npm run verify-offline`，已入 CI）
- [本轮测试说明及限制](docs/VERIFICATION.md)
- [精确测试文件摘要](docs/verification-2026-10-26.json)（首轮 Linux）；[Windows 轮](docs/verification-2026-10-26-windows.json)；[M2 基础批次](docs/verification-2026-10-26-m2.json)
- [后续轮次](docs/verification-2026-10-27-review-fixes.json)：[Windows 验收](docs/verification-2026-10-27-windows-acceptance.json)、[M2 纵向](docs/verification-2026-10-27-m2-vertical.json)、[纵向流程证据](docs/verification-2026-10-27-vertical-zcode.md)、[批次 2](docs/verification-2026-10-27-batch2.json)、[批次 3](docs/verification-2026-10-27-batch3.json)、[批次 4](docs/verification-2026-10-27-batch4.json)、[批次 5](docs/verification-2026-10-27-batch5.json)、[渲染技能消费证据](docs/verification-2026-10-27-render-consumption.md)、[批次 6](docs/verification-2026-10-27-batch6.json)、[安全套件](docs/verification-2026-10-27-safety-suite.md)、[批次 7](docs/verification-2026-10-27-batch7.json)、[工作流套件](docs/verification-2026-10-27-workflow-suite.md)、[批次 8](docs/verification-2026-10-27-batch8.json)、[产品套件](docs/verification-2026-10-27-product-suite.md)、[批次 9](docs/verification-2026-10-27-batch9.json)、[收官套件](docs/verification-2026-10-27-final-suite.md)、[批次 8](docs/verification-2026-10-27-batch8.json)、[产品套件](docs/verification-2026-10-27-product-suite.md)
- [M2 基础批次实施计划](docs/plans/2026-10-26-m2-foundation.md)
- [本机 DSH 真实加载调研](docs/integration/dsh-local-findings.md)
- [ZCode 受控接入验收手册](docs/integration/zcode-acceptance.md)
- [宿主装载 runbook](docs/integration/host-loading.md)
- [固定上游和宿主提交](upstream.lock.json)

DSH 管线级 guard 验证（真实工具调用拒绝路径）待 `DEEPSEEK_API_KEY` 提供后执行：就绪脚本 `node scripts/verify-dsh-guard.mjs` 已就位，密钥缺失时打印受阻原因并以退出码 2 结束（本仓库不读取 `~/.dsh` 凭据）。

## 已实现

1. 宿主中立策略核心：显式文件工具绑定（0.3.0 起支持 `parser: 'apply-patch'` V4A 补丁解析与 `effectKey`/`readWhen` 按参数区分读写）、读写范围分离、符号链接和路径越界检查、未知工具默认拒绝、配置摘要。
2. ZCode 同步 PreToolUse 协议适配与配置片段生成（支持按绑定工具收窄 matcher）；实际 Node Hook 子进程回归。
3. DSH 原生 `ctx.tools.guard` 插件入口；协议测试通过；并已在本机真实 DSH 0.2.1-rc.3 隔离配置中完成加载/激活冒烟（见调研文档），guard 工具执行级拒绝路径仍未验证。
4. 持久审批状态核心：等待人工批准、会话/操作/配置绑定、过期、拒绝、单次消费、跨进程竞争保护；操作员 CLI（`approvals issue/verify/approve/reject/consume/list/show`）已接通完整审批闭环（含只读绑定校验），原生询问桥 `approvals ask`（阻塞式 stdin 应答，无答案 exit 3 绝不自动同意）已接通；宿主内嵌 UI 仍未接通。
5. 固定提交的上游源技能盘点器：模板去重、文件摘要、宿主依赖提示；不执行上游代码，不自动宣布兼容。
6. 持久任务日志：planned/running/completed/failed/cancelled/interrupted 状态机、断点恢复与 interrupted→cancelled、owner 标记、跨进程转移锁、防篡改记录校验；`tasks` CLI（create/start/resume/complete/fail/cancel/interrupt/show/list）已接通。
7. 固定上游技能生成器：从盘点结果生成宿主技能包（逐字节复制的 SKILL.md + manifest，含占位符与宿主依赖提示、`generated-not-host-verified` 标记），不解析模板、不执行上游代码。
8. 两阶段安装/卸载注册：先全量校验后写入、绝不覆盖或删除用户文件（`USER_FILE_REFUSED`）、幂等跳过、版本漂移自动备份、注册表原子更新；所有权按注册表摘要内容验证，安装/卸载互斥锁与备份/注册表路径安全校验（含 junction 逃逸防护）。

## 开发与离线检查

要求 Node.js 22+ 和 Git；核心没有第三方 npm 依赖，不需要 `npm install`。

```sh
git clone --recurse-submodules https://github.com/wmqfl861/gstack861.git
cd gstack861
npm run check
npm test
npm run doctor
node bin/gstack861.mjs inventory --upstream upstream/gstack
```

子模块保留完整上游源码和许可，并固定在锁文件提交。离线单元/协议测试不需要子模块、宿主安装、API Key 或网络；完整上游盘点需要已拉取的子模块。这里没有执行 gstack `setup`，不会安装 Claude Code 或启动模型。离线回归已在 Linux（Node 22）与真实 Windows（Node 24）本机各自跑通；CI 同时跑两个平台。路径策略在 Windows 上接受反斜杠作为原生分隔符，`..`、NUL、悬空符号链接与越界目标在各平台一律拒绝。

## ZCode 接入（实验性，需人工审查与真实宿主验证）

先按 [策略示例](examples/policy.example.json) 填写实际存在的绝对目录。策略文件放在目标工作区之外，权限建议 `0600`。绑定项必须对应审查过的真实文件工具；不要将 Bash/MCP/子任务伪装为文件工具。

```sh
node bin/gstack861.mjs zcode-config --policy /absolute/private/policy.json
```

生成片段默认 matcher 为 `.*`；可用 `--matcher 'Read|Write|Edit'` 把 Hook 范围收窄到策略中绑定的文件工具（见 `src/adapters/zcode.mjs` 的 `zcodeHookConfig`）。

该命令只输出配置片段，不修改用户设置，不自动授予 Hook 信任。按固定版本 ZCode 的 Hooks 文档合并配置并审查 trust digest，创建新会话验证。允许的调用返回空结果，保留 ZCode 自身权限检查；拒绝返回结构化 deny 和退出码 2。

**强范围保护当前会拒绝所有未映射工具，包括 Shell、任意代码执行、MCP 和子任务，因此不是常规开发流程的完整安全安装。**该结论仅针对默认 `.*` matcher；若用 `--matcher` 收窄范围，matcher 之外的工具根本不会进入本守卫，只依赖宿主自身的权限门。它是供受控接入验证的保守基础，不建议直接在生产工作区启用。Hook 启动失败、超时、其他 Hook 顺序和旁路工具仍需宿主级验证。

## DSH 接入（实验性，需真实插件加载验证）

`src/adapters/dsh.mjs` 导出原生 Cordis `name`、`inject` 和 `apply`。将此模块通过 DSH 的本地插件机制加载，配置 `policyPath` 为工作区外绝对路径；插件依赖 `tools` 服务的单调 guard API，缺失时拒绝激活。

策略中的 `bindings.dsh` 默认为空。应先检查该安装实际注册的文件工具名和参数，再显式绑定；本项目不会猜工具名。此阶段 DSH **只接受绝对文件路径**，相对路径会拒绝，直到 Session cwd 语义与继承在真实宿主中验收。没有使用部分兼容的 Claude Hook 桥。

## 上游渲染（CI 受限执行）

为产出可直接使用的宿主技能（而非含 `{{占位符}}` 的骨架），本项目自 0.4.0 起以**受限放宽**方式复用固定上游的 `gen:skill-docs` 渲染管线（蓝图第 1 节「先复用上游工具」）：

- 执行仅限 `scripts/render-upstream.mjs`，且仅当 `CI=true` **且** `GSTACK861_RENDER=ci` 同时成立（后者是维护者在 CI 同等断言下的受控复现通道）；bun 版本必须恰为 1.4.2。
- 在 `git archive` 生成的**子模块副本**上执行 overlay（`hosts-overlay/zcode.ts`、`dsh.ts`，注册表字面量拼接），`upstream/gstack` 工作树渲染前后断言 pristine；不运行 `setup`、不安装 Claude Code、不调用模型；渲染路径经审查为零 npm 依赖、零网络。
- 产物落 `rendered/.zcode` 与 `rendered/.dsh`（每宿主 57 技能 + 根路由 `gstack`），零未解析占位符，附 `render-manifest-<host>.json`；状态为 **rendered-experimental**——不构成上游 conformance/full 认证，安装链接入待后续批次。产物经 CI artifacts（30 天）获取。装载链已接通（0.4.1）：`stage-render --rendered DIR --manifest FILE --host zcode|dsh --staging DIR` 将渲染树转换为 staging（含嵌套 sections/templates 多文件技能，registry 为卸载信任锚），随后走既有 `install`/`uninstall`。本机已用真实 CI 渲染产物实跑全链（57+根 → 安装 58 → 幂等重装 → 卸载清空）。`install --dry-run` 与 `uninstall --dry-run` 提供零变更预检（只读校验集+动作报告，拒绝照常抛错）。宿主装载（ZCode 工作区装载与 DSH 边界）见 [docs/integration/host-loading.md](docs/integration/host-loading.md)。渲染作业仅在 ubuntu 运行——bun 渲染与平台无关，Windows 矩阵只跑离线契约与测试。

## 离线边界（2026-10-27 固化）

终版逐项盘点见 [docs/OFFLINE-COMPLETE.md](docs/OFFLINE-COMPLETE.md)（待解锁/离线余量/环境受阻三分类）。

截至 2026-10-27，本项目在离线环境（无 API Key、无浏览器栈、无设备、无远端、0 付费调用）内可自主推进的空间已尽。已交付：上游渲染的 CI 受限执行管线（rendered-experimental，零付费调用、零网络渲染路径）、装载链 `stage-render → install → uninstall` 全链实测（含 fixture 工作区装载与幂等重装/卸载清空）、渲染技能宿主消费（累计计数以 `npm run doctor` 报告为准；均非 host_verified，自动拾取未验证）、approvals/tasks/ask 三组原语（操作员 CLI 全量接通，`approvals ask` 无答案绝不自动同意）、install/uninstall dry-run 零变更预检，以及多轮外部独立审查与逐批证据体系（链接见上方开发文档节）。在此边界内，剩余 13 项均受阻于用户解锁或环境，逐项如下：

1. ① DSH 管线+纵向+toolRewrites——**全部完成**：deny（第十八轮）+ allow（批次 12）双向真实管线实证；同会话多调用 deny→allow 一致性实证（批次 13）；spec→implement→qa+记账纵向通过（批次 13，含一次诚实失败与修复复跑）；toolRewrites 六短语实装（渲染 diff 23 文件）；**ship 阶段+审批集成纵向通过（批次 14 密钥单次运行：模型写 ship 目录被拒 OUTSIDE_SCOPE、ask 桥审批、控制器特权发布、审批单次消费+重放拒绝）**。见 dsh-pipeline、dsh-vertical 与 dsh-ship 证据。
2. ② DSH 插件式技能装载——**全部完成**：activation（批次 10b）+ 运行时消费实证（批次 12 密钥任务：模型经注入索引真实读 SKILL.md，逐字输出随机标记）——runtime-consumption-verified (single keyed run)。
3. ③ ZCode guard 层+自动拾取+容忍度（需受控新会话）。一键生成受控验收包：`node scripts/acceptance-pack.mjs --out DIR`（含装好技能的 fixture 工作区、可加载样例策略、Hook 片段与打印好的验收清单，详见 `--help`）。
4. ④ 宿主内嵌询问/审批 UI 接通（区别于③）。
5. ⑤ GBrain 真接入（待①②③）。
6. ⑥ 浏览器 QA/scrape/qa 组（浏览器栈）。
7. ⑦ iOS 组（设备）。
8. ⑧ ship/canary/deploy（远端）。
9. ⑨ 独立模型复核——机制就绪（2026-10-27 批次 11：`loadGateway` 显式网关配置（键只引用环境变量名、官方端点黑名单、https 强制）+ 单次封顶调用执行器（GSTACK861_MODEL_CALL 开关默认关）+ 无密钥就绪验证器 `node scripts/verify-model-review.mjs` 五段实测）。运行时真调用待**解锁-⑨**：亲手放置网关配置文件（工作区外、0600）+ 设 GSTACK861_MODEL_CALL=1 + 设 apiKeyEnv 所指键（注意：自定义网关反向代理官方端点在配置层不可检测，属已知残余）。解锁助具性质的重开，同 10a/10b 先例。
10. ⑩ 子 Agent 执行器/取消/恢复接线与纵向真实执行（待①③后按批推进）。
11. ⑪ 宿主级自动安装/升级/卸载（待③）。
12. ⑫ make-pdf/diagram 完整产物链（重二进制/浏览器，本批以降级/BLOCKED 如实消费）。
13. ⑬ M4 多 OS 矩阵与完整对等（前述全部之后）。

## 安全与状态边界

- Hook/guard 不是操作系统沙箱。TOCTOU 路径竞态、恶意同用户进程、宿主绕过标准管线的执行器均不在本阶段保障内。staging 目录在校验与写入之间同样存在 TOCTOU 窗口，蓝图第 5 节边界适用。
- ZCode PreToolUse Hook 看到的是宿主分发的**原始输入**：任何其他 Hook/插件返回 `updatedInput` 的改写都会在守卫判定之后按最后写入者胜出合并，使本守卫的弃权或拒绝作用于过期路径。因此本守卫**不得与任何返回 `updatedInput` 的 Hook/插件共存**，该约束属于宿主接入验收项，而非代码可强制。
- 安装/卸载的所有权判定是内容验证（注册表记录摘要 × 目录 manifest × SKILL.md 字节 × 无多余文件），不是密码学证明：对目标目录拥有任意写权限者仍可构造完全自洽的伪造。因此**安装目标必须处于模型不可写路径**（由宿主侧 guard 策略保证），这是部署前提而非代码强制。
- 卸载遇到用户修改过的技能文件或目录内多余文件会整体拒绝（`USER_FILE_REFUSED`），不删除用户数据；`--purge` 只清理同时满足 13 位数字时间戳命名（`<name>-<13位时间戳>`）且目录内 `manifest.json` 校验为本项目（`generator === 'gstack861'`）生成的目录，用户放入备份目录的其他内容保留。
- `install`/`uninstall` 通过目标内锁目录互斥；崩溃残留的锁以 `INSTALL_BUSY` 拒绝后续操作，须人工确认后清除，不自动解锁。
- 策略仅认可显式审查的文件工具；工具名称被第三方替换的身份校验尚未完成。
- 审批状态转换只提供给可信控制器；人工操作员 CLI（`approvals approve|reject`）本身即是这样一个可信控制器。其前提是状态目录位于模型可写的工作区之外，且守卫生效时模型工具无法调用该 CLI。审批 API 不暴露给模型工具。调用 `approve()` 不是用户同意的证明；宿主 UI 必须先取得真实批准。
- 消费在执行之前发生，崩溃可能导致任务未执行但批准已消费；不能自动重发。当前没有断电持久性保证和远端业务幂等保证。
- 任务租约（`--lease-ms` + `heartbeat`/`reap`）是单机文件时钟语义：收割者时钟超前超过租约长度即可误判刚续租的任务为崩溃（跨进程时钟偏差固有）；无租约的崩溃任务不会被自动收割（fail-closed），操作员手工路径为 `interrupt` → `resume`/`start`。`cancelWorkflow`（`./workflow` 导出）以"先拒审批后取消任务"的顺序提供故障安全的取消纪律，两步非原子是设计明示。恢复语义已获一次真实 DSH 键控纵向实证（`scripts/dsh-recovery-vertical.mjs`：崩溃模拟→收割→恢复→密钥任务 completed attempts=2，单次运行）；ZCode 六阶段工作流层有机器可检离线 harness（`scripts/zcode-workflow-vertical.mjs`，offline-workflow-journal-harness 分级：真实 CLI 记账+审批门，零模型调用，非宿主纵向）。
- 状态目录须位于模型不可写的工作区外。锁遗留时拒绝继续，不自动清锁或重新批准。
- **0.3.1 破坏性变更（状态文件命名空间隔离）**：任务与审批记录分别改用 `task-<uuid>.json` 与 `approval-<uuid>.json` 文件名，两类存储从此可安全共用一个 `--state` 目录。0.3.0 写入的无前缀 `<uuid>.json` 记录升级后对 `list`/`get` 均不可见（等效丢失），需按各自前缀人工改名迁移；当前没有外部部署，故不提供自动迁移。文件名只划分命名空间，记录内容校验（含 id、状态机）仍是权威——伪装成对方前缀的记录一律 `INVALID_*_RECORD` 拒绝。
- 不执行任何付费模型调用；后续功能必须使用显式网关配置，不回退官方端点。

## 后续开发入口

先完成两侧真实宿主离线集成和工具身份/旁路验证，再接上技能生成、原生问答审批、子任务与恢复。随后逐项迁移上游工作流、浏览器 QA、发布、安全审计、记忆和专项能力。具体依赖与验收见蓝图；未验证功能保持 `planned` 或 `blocked`，不能标为 `full`。

## 许可

新增代码使用 MIT 许可。上游 gstack 在子模块内保留其原始许可与版权声明。ZCode、DSH 仅作为接口审查和目标宿主，没有把其源码复制进本仓库。
