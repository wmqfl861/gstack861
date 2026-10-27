# 首批开发验证记录

日期：2026-10-26。范围：0.1.0 foundation，M0/M1 部分实现。

> 第二轮（Windows 接入）见文末「第二轮验证记录」。

环境：当前隔离执行环境，Linux，Node.js v22.16.0。不是用户云端电脑。

| 命令 | 结果 |
|---|---|
| `npm run check` | 14 个 JS 模块语法检查与三个完整提交号校验通过 |
| `npm test` | 50 passed，0 failed，0 skipped，0 cancelled |
| `npm run doctor` | 成功；明确输出两个宿主 `not-host-verified` |

测试包括：真实临时文件、路径前缀、越界符号链接、悬空链接、硬链接、VCS 目录及符号链接目标保护、非法策略、未知工具、两种 ZCode 字段格式、真实 Node Hook 子进程、DSH guard 回调合同、审批状态/过期/绑定/重放、两个真实进程竞争消费、临时 Git 仓库盘点与版本漂移。

精确测试源码的 Git blob SHA-1 和 SHA-256 见 `verification-2026-10-26.json`。这将检查结果绑定到文件字节，而不是事后声称一个未知提交已测试。

## 没有运行 / 明确受阻

- 用户远程设备：Desktop Commander 返回无在线设备；没有云端安装、测试或同 SHA 验收。
- 当前执行环境无法解析 github.com；没有从这里克隆完整上游，也没有运行完整上游盘点。GitHub 读写使用已连接的 GitHub 工具。
- ZCode 实际安装、Hook 信任、真实事件链和模型任务：未运行。
- DSH 实际插件加载、标准执行器/PTC/子 Agent 继承：未运行；接口替身不构成真实宿主证据。
- 浏览器、Docker、iOS、部署、外部模型审核：未运行。
- 付费模型和其他按量计费服务：0 次调用。
- Windows/macOS：未运行，不声明通过。
- CI 已配置离线检查和完整固定上游盘点；是否执行/通过以 GitHub Actions 的实际运行结果为准，不用本地结果冒充 CI。

## 已知边界与下一验收

这批代码不是完整产品。严格 guard 会阻断未映射工具；DSH 相对路径、审批 UI、原生子任务、技能生成和完整工作流仍待接通。路径预检查不能消除 TOCTOU，审批文件状态没有断电持久性保证。下一步需要真实宿主离线集成及安全旁路测试，然后做不依赖 Claude Code 的真实纵向流程。

# 第二轮验证记录：Windows 真实本机接入

日期：2026-10-26（同日续开发）。范围：0.1.1，把首轮声明「Windows 未运行」的离线矩阵在真实 Windows 本机补齐。

## 实际运行

环境：真实 Windows 本机（win32 10.0.22624 x64），Node.js v24.21.0，Git Bash。不是 CI，也不是首轮的隔离 Linux 环境。

| 命令 | 结果 |
|---|---|
| `npm run check` | 15 个模块语法与 3 个固定提交校验通过 |
| `npm test` | 首跑 49/50：`policy.test.mjs` 平台相关断言失败（详见下） |
| （修复后）`npm test` | 50 passed，0 failed，0 skipped |
| `npm run doctor` | 成功，版本 0.1.1，两宿主仍为 `not-host-verified` |
| `git submodule update --init upstream/gstack` | 成功检出固定提交 5755601 |
| `node bin/gstack861.mjs inventory --upstream upstream/gstack` | 成功：commit 与锁文件一致，57 个顶层源技能，`fullParity: false` |

本轮在真实 Windows 上完成完整上游盘点，补上首轮 `not-run-locally-DNS-unavailable` 的证据缺口；精确文件摘要见 `verification-2026-10-26-windows.json`。摘要按仓库 blob 字节（LF）计算（`git ls-tree`/`git show`，见 `scripts/round-digests.mjs`），与平台行尾转换无关：本轮最初用工作区字节计算时曾因 autocrlf 产生偏差，已修正并与首轮摘要逐项核对一致。

## 发现并修复的缺陷

`test/policy.test.mjs` 的「file-as-parent, NUL, foreign separators and cwd escapes fail closed」无条件要求 `src\a.txt` 拒绝，但反斜杠在 Windows 是原生分隔符：策略核心（`FOREIGN_PATH` 仅对非 win32 生效）将其解析为工作区内 `src\a.txt` 并 abstain。逐项核对后确认核心行为正确——`..` 分量、NUL、驱动器/UNC 绝对路径、越界 cwd 在两个平台都被拒绝，反斜杠相对路径无法绕过范围检查——错的是测试的平台假设。修复：按平台分离断言（win32 上 abstain，其余 deny），并新增跨平台断言 `src\..\..\secret.txt` 必须拒绝。未改动 `src/policy.mjs`。

## 本轮仍未运行

- macOS：未运行，不声明通过。
- CI（ubuntu + windows 矩阵）：工作流已更新为双平台，通过与否以 GitHub Actions 实际运行结果为准。
- 真实宿主集成（ZCode Hook 信任链、DSH 插件加载）、付费模型调用：与首轮一致，未运行。

## 下一验收

沿用蓝图接续优先级：两侧真实宿主离线集成（在受控会话安装 ZCode Hook、加载 DSH 插件，验证启动失败/超时/旁路工具行为），然后技能生成器与安装注册。

# 第三轮验证记录：M2 前置基础批次

日期：2026-10-26（同日续开发）。范围：0.2.0，按 `docs/plans/2026-10-26-m2-foundation.md` 以多子代理流程交付：持久任务日志、固定上游技能生成器、两阶段安装/卸载注册、审批操作员 CLI、ZCode matcher 收窄，以及本机 DSH 真实加载调研。

## 实际运行

环境：真实 Windows 本机（win32 10.0.22624 x64），Node.js v24.21.0，Git Bash。每个实现任务由独立子代理以 TDD 实现，并由另一个独立子代理对照任务简报做规格+质量双裁决审查；审查发现的遗留项均为 Minor 并记录在案。

| 命令 | 结果 |
|---|---|
| `npm run check` | 21 个模块语法与 3 个固定提交校验通过 |
| `npm test` | 86 passed，0 failed（新增 TaskStore 13、生成器 7、安装 12、集成 4） |
| `npm run doctor` | 成功，版本 0.2.0，两宿主仍为 `not-host-verified` |
| CLI 子进程端到端 | generate→install→幂等 install→uninstall 全链路通过；approvals list/approve/绑定不匹配/重放拒绝通过 |
| DSH 隔离冒烟（子代理执行） | 真实 DSH 0.2.1-rc.3 隔离 `DSH_HOME` 下加载未改动适配器：激活成功；负控按设计失败于 `POLICY_PATH_REQUIRED`；全程 0 次付费调用、未触碰 `~/.dsh`。详见 `docs/integration/dsh-local-findings.md` |

精确文件摘要见 `verification-2026-10-26-m2.json`（按仓库 blob 字节计算）。本批新发现并已记录的宿主行为：DSH `apply()` 抛错只产生 `dsh: warning: N entries did not activate` 且退出码仍为 0——集成验收不能只看退出码，必须解析警告；DSH 最小插件树需同时包含 `system-prompt` 与 `tools` 闭包。

## 本轮仍未运行

- CI（ubuntu + windows 矩阵）：以 GitHub Actions 实际运行结果为准。
- macOS；ZCode 真实宿主 Hook 信任链；DSH guard 在真实工具执行管线中的拒绝路径（`gstack861:*` 理由串进入工具结果）；付费模型调用。
- 生成器/安装器对真实宿主技能目录的写入（安装目标目前仅为测试目录，宿主技能目录布局待各自集成任务）。

## 下一验收

两侧真实宿主离线集成：ZCode 在受控新会话安装 Hook 并验证信任摘要、启动失败与超时行为；DSH 在隔离配置中触发真实工具调用验证 guard 拒绝路径与警告解析；随后把生成/安装接入真实宿主技能目录，并开始 /investigate、/review 纵向流程。

# 第四轮验证记录：外部 Codex 审计修复批次

日期：2026-10-26（同日续开发）。范围：0.2.1，按 `docs/plans/2026-10-26-codex-audit-fixes.md` 修复外部 Codex 审计（gpt-6-astra / 推理等级 max，87,329 tokens）实测发现的 2 Critical + 6 Important 缺陷。

## 审计来源与过程

Codex 以真实探针验证了 12 个场景（探针脚本与输出见其会话日志；报告生成阶段被提供方内容策略中断，探针结果完整保留并经本项目复核采纳）。每个探针场景在本批次中转化为回归测试。每项修复由独立子代理以 TDD 实现，并由独立审查者做规格+质量双裁决。

## 修复映射

| Codex 探针（实测结果） | 修复 | 回归测试 |
|---|---|---|
| 卸载删除用户修改/新增文件（Critical） | 卸载所有权改为注册表摘要×manifest×SKILL.md×无多余文件四重内容验证，任一漂移整体拒绝 | install.test：修改拒绝、额外文件拒绝、兄弟目录与注册表字节保全 |
| 伪造注册表+marker 授权删外来目录（Critical） | 同上——摘要以注册表记录为准，目录自述不可信 | install.test：注册表摘要不一致的 marker 伪造仍拒绝；完全自洽伪造为既知边界（见下） |
| 备份 junction/symlink 逃逸 | 备份路径 lstat 校验 + realpath 必须在 target 内 | install.test：junction（win32 实跑）/symlink（POSIX）|
| 并发安装丢注册表更新 | 目标级互斥锁，第二进程 `INSTALL_BUSY`；注册表锁内读改写 | install.test：真实双进程竞争 |
| 注册表被目录/符号链接占用 | 校验阶段前置 lstat，零写入拒绝 | install.test：(f)(g) |
| 生成器 HEAD 切换竞态（出处破坏） | `git show <commit>:<path>` 固定提交读取 | generate.test：双提交 + now() 钩子切 HEAD，断言固定内容 |
| matcher 放过非法正则 | `new RegExp(matcher)` 编译检查 | adapters.test：`*`、`\`、`a**b` |
| 损坏审批记录展示退出码 0 | `get()` 状态白名单 + ENOENT-only NOT_FOUND | approvals/adapters.test |
| purge 删用户归档 | 只清理 `<name>-<时间戳>` 命名项 | install.test：(j) |
| 坏 action JSON 原始报错 | `INVALID_ACTION_FILE` | adapters.test |
| `approvals bogus` 留状态目录 | 子命令先验证后构造 | adapters.test：文件系统断言目录未创建 |
| tasks null 记录原始 TypeError | `INVALID_TASK_RECORD` | tasks.test |

## 实际运行

环境：真实 Windows 本机（win32 10.0.22624 x64），Node.js v24.21.0。

| 命令 | 结果 |
|---|---|
| `npm run check` | 21 模块与 3 固定提交校验通过 |
| `npm test` | 99 passed，0 failed（新增 8 安装加固 + 5 校验收口） |
| `npm run doctor` | 成功，版本 0.2.1 |

## 既知边界（未修复，已文档化）

- 完全自洽伪造：对安装目标有任意写权限者仍可伪造全部内容与注册表——部署前提是目标处于模型不可写路径（guard 职责），README 已声明。
- staging TOCTOU（蓝图第 5 节明文范围外）、`ApprovalStore.transition()` null 记录原始 TypeError、Windows 状态目录路径拼写多态、POSIX 符号链接探针仅在 CI（ubuntu）执行。

## 下一验收

不变：两侧真实宿主离线集成（ZCode 受控会话 Hook 信任链；DSH guard 真实工具调用拒绝路径，需模型预算授权），随后接入真实宿主技能目录与 /investigate、/review 纵向流程。

# 第五轮验证记录：PR #1 Windows 验收（2026-10-27）

范围：分支 `claude/review-2026-10-27` 的 Windows 本机验收。审查报告 `docs/reviews/2026-10-27-claude-review.md` 中 `968e8de` 已在 Linux 修复的条目（第 1–4、8 错误码、第 5 条 `.git` 名称检查，105/105，见 `docs/verification-2026-10-27-review-fixes.json`）本轮在真实 Windows 复验；剩余项按 `docs/plans/2026-10-27-windows-acceptance.md`（计划经独立子代理审核）以多子代理流程完成：每任务 TDD 实现 + 独立审查（含修复轮与范围化复审）。

环境：真实 Windows 本机（win32 10.0.22624 x64），Node.js v24.21.0，Git Bash。

## 基线（修复前，输出留档于本机临时目录）

| 命令 | 结果 |
|---|---|
| `npm run check` | 通过（22 模块；当时 HEAD 证据门禁仍为硬失败前的清单状态） |
| `npm test` | 104/104 通过（Linux 105，差异为平台包裹用例） |
| `npm run doctor` | 成功，版本 0.2.1 |
| `node bin/gstack861.mjs inventory --upstream upstream/gstack` | 57 个技能，固定提交 5755601 一致 |
| `node scripts/verify-8dot3.mjs`（系统临时卷 + 工作区卷） | **两卷均 `RESULT: alias bypass reproduced`，exit 1**：`PROTEC~1\secret.txt → IN_SCOPE`（自定义受保护目录的 8.3 短名绕过，与审查预测一致；`GIT~1` 已被名称检查拒绝） |

## 修复与验证（修复后）

| 命令 | 结果 |
|---|---|
| `npm test` | 115/115 通过（新增：win32 8.3 用例、gitfile gitdir 4 用例、符号链接指针 2 用例、betweenSteps 出处用例、purge 收紧 2 用例、policyHash 契约用例；平台包裹：win32 8.3 用例在 GitHub Windows runner 8.3 关闭的卷上按设计 skip） |
| `node scripts/verify-8dot3.mjs`（两卷） | **两卷均 `RESULT: no alias bypass on this volume`，exit 0** |
| `npm run check` | exit 0；HEAD 证据门禁按审查第 11 条降级为警告输出 |

探针偶发误报事故（本轮验证期间出现一次）根因：bash 中管道/链式命令后的 `$?` 取到的是管道末命令（如 `tail`）的退出码而非探针进程（当时探针实际未运行）；修正命令写法后复跑确认。所有记录在案的探针运行结果均来自真实运行的探针。

交付映射：8.3/身份比较保护（`dcc0709`+`4811208`）、gitfile 重定向 gitdir 保护与深度2扫描，含符号链接指针形式（`be48f01`+`0637982`+fix round 2；剩余盲区见 `src/policy.mjs` 机制注释与 `docs/verification-2026-10-27-windows-acceptance.json` 的 `knownBoundaries`）、inventory 提交固定读取与 betweenSteps 测试钩子（`de18ec8`）、purge 13 位+manifest 门控（`873221b`）、版本单一来源（`aec6569`）、README updatedInput 共存约束与 matcher 注释更正（`91f8eb8`）、证据门禁降级（`98de530`）、忽略本地草稿目录（`fa24589`）。

## 既知边界（本轮新增/维持）

- gitfile 指针（文件与符号链接两种形式均已覆盖）在目标各级祖先两层以下（如 `ancestor/x/y/.git`）不被发现；既非文件、符号链接也非目录的重解析条目同样不解析；模型经守卫工具种植指针（任意深度的 vcs 命名分量写入，含符号链接）被全深度阻断，盲区仅暴露预先存在的深嵌套指针（`src/policy.mjs` 机制注释；`docs/verification-2026-10-27-windows-acceptance.json` `knownBoundaries`）。
- subst/网络卷 dev/ino 退化时身份比较只会过度保护；巨大扁平目录使每写评估 IO 随广度增长（dirent 扫描已减半）。
- CI（ubuntu+windows）以实际运行结果为准；合并门槛为 CI 绿灯（审查第 11 条）。

## 下一验收

不变：真实宿主离线集成与纵向流程；审查第 6、7、9、10 条设计项待用户决策（见计划 Deferred 节）。

# 第六轮验证记录：M2 纵向批次（2026-10-27）

范围：0.3.0。按 `docs/plans/2026-10-27-m2-vertical.md`（计划经独立子代理审核——否决了 GNU diff 解析器设计并按固定提交宿主源码校准为 V4A 信封）以三车道 git worktree 并行开发：策略表达力（ApplyPatch V4A 解析 + 按参数区分 effect）、次要批二与 approvals/tasks CLI、ZCode 验收手册与 DSH 就绪脚本；合并后**ZCode 宿主真实纵向流程**（见 `docs/verification-2026-10-27-vertical-zcode.md`）。付费模型调用：0 次（DSH 密钥缺失，就绪脚本实测 exit 2 blocked）。

## 实际运行

环境：真实 Windows 本机（win32 10.0.22624 x64），Node.js v24.21.0。

| 命令 | 结果 |
|---|---|
| `npm test` | 139/139（新增 24：V4A/参数 effect 9、次要批 15） |
| `npm run check` | exit 0（HEAD 证据门禁为警告态，按审查第 11 条以 CI 为门槛） |
| `npm run doctor` | 成功，版本 0.3.0 |
| `node scripts/verify-dsh-guard.mjs` | **exit 2 blocked**（DEEPSEEK_API_KEY 缺失；付费路径离线前缀已被实现者与审查者分别实测复现） |
| `node scripts/verify-8dot3.mjs`（两卷） | 均 `no alias bypass`，exit 0 |
| 纵向流程（六阶段+审批+tag） | 全部真实通过，见专项证据文档 |

## 三车道审查结论

Lane A（策略表达力）approved——hash 字节兼容性经审查者对照基线编译器独立复现；GNU 前缀剥离与过度提取两项解释裁定为安全方向正确。Lane B（次要批+CLI）approved——`verify` 只读性、摘要红线、零写入结构保证均对照源码核实；两处测试修改为值来源变更（阈值 1→4MiB、--commit→环境变量），断言强度不减。Lane C（手册+脚本）approved——blocked 路径实测 exit 2、付费路径离线前缀审查者复跑通过；runbook 四处跨车道过期表述已由协调者同步（`efc5679`）。

## 新发现（真实使用暴露，已记录待决）

- TaskStore 与 ApprovalStore 共用状态目录 → `tasks list` 因外来记录 `INVALID_TASK_RECORD` 整体拒绝（fail-closed 不可用）；修复方向留批次 2。
- 其余 Deferred 见计划文档与本轮新增：DSH 管线级验证待密钥；ZCode guard 层宿主验证待受控新会话；原生询问接线、DSH 纵向流程留批次 2。

## 下一验收

批次 2：defineHost 方向裁定与实施（蓝图第 1 节「先复用上游工具」为据）；共享状态目录缺陷修复；原生询问接线；DSH 纵向（待密钥）。

# 第七轮验证记录：批次 2（状态目录命名空间 + 加固清扫，2026-10-27）

范围：0.3.1。按 `docs/plans/2026-10-27-batch2-state-namespace.md`（计划经独立子代理审核，采纳 2 条必需修改：两处字面路径测试豁免、action-file 收紧限枚举类）修复纵向流程暴露的共享状态目录缺陷并清扫前批 Minor。

## 实际运行

环境：真实 Windows 本机（win32 10.0.22624 x64），Node.js v24.21.0。

| 命令 | 结果 |
|---|---|
| `npm test` | 146/146（新增 6：共享目录回归、双向伪装+解析边界、损坏审批记录、受限 CLI 错误、blobHash 守卫） |
| `npm run doctor` | 成功，版本 0.3.1 |
| `node scripts/verify-dsh-guard.mjs` | exit 2 blocked（密钥缺失；回合语义披露已加入；付费调用 0 次） |
| `node scripts/verify-8dot3.mjs`（两卷） | 均 exit 0 |

## 破坏性变更（0.3.0 → 0.3.1）

TaskStore/ApprovalStore 记录文件改用 `task-<uuid>.json` / `approval-<uuid>.json` 前缀命名空间：两店可安全共用一个 `--state` 目录（原缺陷：`tasks list` 因审批记录不满足任务 schema 整体 `INVALID_TASK_RECORD`）。0.3.0 时代的无前缀记录对 list/get 均不可见（等效丢失，需人工改名迁移）；本仓库自用工具、无外部部署。伪装测试证明内容校验仍是权威（改名的记录按内容拒绝）。

## 车道审查结论

Lane 1（命名空间+收紧）approved——两处豁免测试修改经 git diff 逐行核验为纯字面路径替换，断言强度不变；`ABSOLUTE_PATH_REQUIRED` 语义经新增负向断言钉死。Lane 2（脚本加固）approved——exit 2 约定审查者实跑复验，清理路径无泄漏/无双清。

## 下一验收

批次 3：defineHost 方向裁定与实施（专项计划）；原生询问接线；DSH 纵向（待 DEEPSEEK_API_KEY）；ZCode guard 层（待用户受控新会话）。

# 第八轮验证记录：批次 3（上游渲染复用 + 原生询问桥，2026-10-27）

范围：0.4.0。按 `docs/plans/2026-10-27-batch3-render-ask.md`（先经只读调研建立事实基础，再经独立子代理审计划——否决了错误锚点与 push 式注册、纠正门禁为 AND、补根路由断言）交付。

## 交付与验证

环境：真实 Windows 本机（win32 10.0.22624 x64），Node.js v24.21.0。

| 项 | 结果 |
|---|---|
| `npm test` | 161/161（新增 15：编排器 11+1 前缀回归、ask 3） |
| `npm run check` / `doctor` | 通过；版本 0.4.0 |
| `node scripts/render-upstream.mjs`（本地，无 CI 变量） | `RENDER_NOT_ALLOWED` exit 1，零残留，子模块 pristine |
| `node scripts/verify-dsh-guard.mjs` | exit 2 blocked（密钥仍缺） |
| 渲染编排器审查修复轮 | 审查者静态证明两处 CI 必败缺陷（`gstack-upgrade` 前缀错配；artifact 隐藏目录排除），TDD 红线复现后修复，范围化复审接受（复审者独立换装旧代码复现红灯） |
| **渲染 CI 首跑** | 失败（run 40462001245）：`bun run <file>` 在 Node spawnSync 下静默空转（exit 0 零输出）——经本地全保真复现（pinned bun 1.4.2）定位，同批修复 MSYS tar 符号链接与撤销误报守卫 |
| **渲染 CI 二跑** | **成功**（run 40464085183，d7ee2f4）：三作业全绿，render-upstream 每宿主渲染 57 技能+根路由，artifacts 已上传（30 天） |

## 上游渲染红线放宽的精确边界（R1，README 全文）

仅 `gen:skill-docs` 渲染路径；`CI=true && GSTACK861_RENDER=ci` 双门；bun 恰 1.4.2；子模块 `git archive` 副本 + overlay 字面量拼接（锚点全行断言防漂移）；子模块本体渲染前后 pristine 断言；零 npm/零网络（审查复核 107 文件导入闭包）；产物 rendered-experimental，不宣称 conformance/full。

## 车道审查结论

Lane A（渲染）：初审 Needs fixes（2 Critical）→ 修复轮 → 复审接受。Lane B（ask 桥）：一次通过——阻塞语义、摘要红线、退出码 3 唯一性均实证。

## 下一验收

渲染 CI 首跑结果回填与（若绿）产物接入 install 链（批次 4）；DSH 待密钥；ZCode guard 层待受控会话。
