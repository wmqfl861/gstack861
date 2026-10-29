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

# 第九轮验证记录：批次 4（渲染产物接入装载链，2026-10-27）

范围：0.4.1。按 `docs/plans/2026-10-27-batch4-render-install.md`（计划审查否决「辅助文件平铺」错误前提——实测 30 个辅助文件全部嵌套于 6 个子目录——并据此重设计为相对子路径 files 映射）交付。

## 实际运行

环境：真实 Windows 本机（win32 10.0.22624 x64），Node.js v24.21.0。

| 命令 | 结果 |
|---|---|
| `npm test` | 187/187（新增 25：install 多文件 11、stage-render 13、端到端 1） |
| **真实产物全链**（本机 CI 渲染产物 `rendered-final`） | `stage-render`：57 技能+根、30 辅助文件 → staging；`install`：58 装载（含 ship/qa 等 sections 多文件技能）；重装幂等 skip 58；`uninstall`：58 清空、目标归零；篡改列出文件 → `USER_FILE_REFUSED`（e2e 测试覆盖） |
| `npm run check` / `doctor` | 通过；版本 0.4.1 |

## 设计要点（计划审查裁定）

- registry 为卸载唯一信任锚：files 摘要对 registry 记录校验，forged 目标 manifest 不得提名删除文件。
- classify 的 skip 判定 files 感知：仅 section 变化的重渲染走备份替换，不残留陈旧文件。
- verifyOwned 服务两个调用点（卸载验证 + classify 漂移判定）。
- 双车道审查均一次通过（Lane A 三项披露裁定无害并经审查者实测探针验证；Lane B 直通规则与上游渲染器逐字核对）。

## 下一验收

宿主技能目录真实装载验收（ZCode/DSH 侧）与 DSH 管线级验证仍待用户解锁项；批次 5 候选：DSH toolRewrites、宿主装载 runbook 实测版。

# 第十轮验证记录：批次 5（宿主装载 runbook + 加固 + 渲染技能消费流程，2026-10-27）

范围：0.4.2。按 `docs/plans/2026-10-27-batch5-host-loading.md`（计划审查修正 DSH 引用节次、钉死逐段前缀冲突规则、消费技能定为 review——其含明文降级模式条款而 careful 会在缺失 bin/ 时硬失败）。

## 实际运行

| 命令/流程 | 结果 |
|---|---|
| `npm test` | 191/191（新增 4：冲突预校验 3 + prompt-file 1） |
| 装载实测 | 真实渲染产物 → stage-render → `install --target <fixture>/.zcode/skills` 58 目录；runbook §2.2/2.3/2.5 回填已实测 |
| **渲染技能消费** | 见 `docs/verification-2026-10-27-render-consumption.md`：ZCode 执行器按装载的 review 技能（降级模式条款+方法论）完成真实审查（SQL 注入 Critical，附证据），任务记账+审批经 ask 桥闭环；边界如实（自动拾取未验证） |
| 车道审查 | Lane A 两处事实错误（相对路径错误码归属、§3 证据链越级）经修复轮更正并复审语义；Lane B 一次通过（非冲突正例测试证明非裸 startsWith） |

## 下一验收

不变：两项用户解锁（DEEPSEEK_API_KEY → DSH 管线+纵向；ZCode 受控新会话 → guard 层+自动拾取+容忍度）。批次 6 候选：解锁后项优先；否则 M3 非设备工作流逐项。

# 第十一轮验证记录：批次 6（安全组消费套件 + install dry-run + 矩阵刷新，2026-10-27）

范围：0.4.3。按 `docs/plans/2026-10-27-batch6-safety-suite.md`（计划审查四组修正：dry-run 显式只读校验集、冻结演示改边界双侧、document-generate 换 Diataxis 产出、Lane A 三处事实纠正）。

| 项 | 结果 |
|---|---|
| `npm test` | 200/200（新增 9：dry-run 全景） |
| install --dry-run | 结构性零写入（审查者通读 dry 调用图核实无 mkdir/write/rename）；拒绝照常抛错 |
| 安全组消费套件 | 见 `docs/verification-2026-10-27-safety-suite.md`：careful（前置失败如实+HIGH 硬拒+MEDIUM 经 ask 桥 reject）、freeze/unfreeze（机制差距如实+边界双侧真实策略评估）、document-generate（Diataxis 两象限产物+审批全闭环）；三任务全程记账 |
| 车道审查 | A/B 均一次通过（B 的 dry 调用图由审查者逐一核对只读性） |

## CI 事件与修复（同轮补录）

首推 876c1c3 的 ubuntu 作业失败（run #40487111559）。根因（取回真实日志定位）：批次 2 引入的双进程竞态测试在快 CI 上，胜者的整个临界区（含锁释放）先于败者首次轮询完成，败者无竞争安装成功——旧断言把「未发生竞争」误报为「互斥失败」（2 !== 1 假阳性）；互斥锁本身（mkdir EEXIST 原子性）无恙。修复：竞态测试加竞争标记（败者见到锁仍成功=真产品缺陷硬失败；未发生竞争=无效尝试，逐次加宽窗口重试，5 次均无竞争则 skip 并注明互斥拒绝本身已由遗留锁测试覆盖）；可竞争路径的全部原断言保留。本机 3 连跑稳定。

## 下一验收

两项用户解锁不变（DSH 密钥 / ZCode 受控会话）。渲染技能消费累计 5 例；下一批候选：解锁后项优先，否则 M3 非设备组继续（/learn /retro /test-audit 等纯工作流技能同模式消费）。

# 第十二轮验证记录：批次 7（工作流技能消费 II + uninstall dry-run，2026-10-27）

范围：0.4.4。按 `docs/plans/2026-10-27-batch7-workflow-suite.md`（计划审查四组修正：镜像真实卸载序列、learn 真实 schema、retro 全框架+Step13 真写、test-audit 价值词汇）。

| 项 | 结果 |
|---|---|
| `npm test` | 211/211（新增 11：uninstall dry-run 全景） |
| uninstall --dry-run | 结构性零变更（审查者通读 dry 链核实）；purge 预演谓词与真实删除共享同源 |
| 工作流消费套件 | 见 `docs/verification-2026-10-27-workflow-suite.md`：learn（真实 schema 教训×2）、retro（全章节+Step13 JSON 快照真写+metrics 降级不杜撰）、test-audit（价值词汇裁决 rewrite，report-only）；渲染技能累计消费 8 例 |
| 车道审查 | Lane B 一次通过；Lane A 单行链接（终审覆盖） |

## 下一验收

两项用户解锁不变（首尾重申）。剩余 M3 非设备纯工作流技能渐次消费；设备依赖组与 M4 待环境。

# 第十三轮验证记录：批次 8（产品套件消费 III + doctor 消费报告，2026-10-27）

范围：0.4.5。按 `docs/plans/2026-10-27-batch8-product-suite.md`（计划审查四组修正：spec 真实五阶段+Standard Issue 模板、deslop 两处依赖、doctor evidence 数组定名、矩阵状态行归属）。

| 项 | 结果 |
|---|---|
| `npm test` | 212/212（新增 1：doctor 消费报告；中途一次 bin/test 计数失配致红、同批修复——如实记录） |
| doctor 消费报告 | `renderedSkillsConsumed: 11` + 四份证据文档 + 两项解锁动作（count/evidence 同字面量同步移动） |
| 产品套件消费 | 见 `docs/verification-2026-10-27-product-suite.md`：office-hours（startup 模板全套+Assignment）、spec（五阶段+Standard Issue+语义审查真实 flagged）、deslop（验证门槛正确→零候选诚实结论）；累计 11 例 |
| 车道审查 | Lane A 一次通过（字面量逐字核对+路径存在性）；Lane B 单行（终审覆盖） |

## 下一验收

两项用户解锁不变（首尾重申）。M3 非设备纯工作流消费已覆盖 11 技能；剩余非设备项（diagram/make-pdf 的生成类、context-save/restore 等）可继续；设备依赖组与 M4 待环境。

# 第十四轮验证记录：批次 9（收官消费 + 离线边界固化，2026-10-27）

范围：0.4.6。按 `docs/plans/2026-10-27-batch9-final-suite.md` v2（计划审查修正全部并入：make-pdf/diagram 真实降级路径、context-save/restore 规定细节、边界 13 项、Lane B 移出 README）。

| 项 | 结果 |
|---|---|
| `npm test` | 212/212（doctor 计数 15 断言随 Lane B） |
| 收官消费 | 见 `docs/verification-2026-10-27-final-suite.md`：context-save（规定布局+溯源词逐字）、context-restore（HEAD_MATCHES+Verify first/Next steps 分栏）、diagram（BLOCKED+.mmd 部分产物）、make-pdf（BLOCKED+降级 --to html 交付）；累计 15 例，M3 非设备组收官 |
| 离线边界固化 | README「离线边界」节 13 项逐项注阻塞原因；FEATURE_MATRIX 状态行同步 |
| 车道审查 | 双车道合并后由终审覆盖（Lane A 边界声明逐项核对为终审重点） |

## 下一验收

**离线可推进空间已尽。** 两项用户解锁（首尾重申）是仅剩的可行动路径：① DEEPSEEK_API_KEY → verify-dsh-guard + DSH 纵向 + toolRewrites；② 受控新 ZCode 会话 → guard 层验收 + 自动拾取。解锁后按解锁顺序推进边界 13 项中的对应项。

# 第十五轮验证记录：批次 10a（解锁助具 acceptance-pack，2026-10-27）——补录

（批次 10a 收尾时本段漏写、证据 JSON 已在——现按 docs/verification-2026-10-27-batch10a.json 补录，数字以该文件为准。）

| 项 | 结果 |
|---|---|
| `npm test` | 218/218（新增 6：acceptance-pack） |
| acceptance-pack | 一条命令生成受控验收包；实现者真机冒烟三探针原样运行；手册缺陷（PROTECTED_PATH vs OUTSIDE_SCOPE）发现并修复，生成器引文同步+漂移守卫测试 |

# 第十六轮验证记录：批次 10b（边界②：DSH 技能装载 activation-tested，2026-10-27）

范围：0.4.8。按 `docs/plans/2026-10-27-batch10b-dsh-skills.md`（计划审查经 asar 源码核实 systemPrompt.section API 并裁定机制——附录已录入 findings；手工 profile 强制、无密钥无任务）。

| 项 | 结果 |
|---|---|
| `npm test` | 224/224（新增 6：dsh-skills 插件） |
| **真实激活验证（无密钥、0 付费调用）** | `node scripts/verify-dsh-skills.mjs` 三控全过（exit 0）：正控 taskless 干净激活；负控①坏目录→插件 REGISTRY_INVALID 警告（堆栈命中真实仓库文件 dsh-skills.mjs:46→install.mjs:69）；负控②删 system-prompt 条目→插件 pending（waiting for service: systemPrompt，inject 声明实证非虚设）。审查者独立复跑 3/3 一致 |
| 边界②推进 | 机制待验证 → **activation-tested**；运行时消费（模型真读索引/技能）待①，且届时 readRoots 须覆盖技能目录 |

## 下一验收

边界①（DEEPSEEK_API_KEY）与③（受控 ZCode 会话）不变；边界②运行时半边随①解锁。

# 第十七轮验证记录：批次 11（边界⑨机制半边：模型网关显式配置 + 独立模型复核接线，2026-10-27）

范围：0.4.9。按 `docs/plans/2026-10-27-batch11-model-review.md`（计划审查九组修正并入：重定向封堵、workspace 比较器、https/回环规则、超时可注入、结构化网络错误、黑名单语义、Lane 时序、事实修正、解锁-⑨ 命名）。

| 项 | 结果 |
|---|---|
| `npm test` | 249 pass + 2 POSIX skip（新增 13+1 修复回归：gateway 11+2skip、model-review 14 含中途体中止回归） |
| **无密钥就绪验证** | `node scripts/verify-model-review.mjs` 五段全过（exit 0）：配置正/负、官方端点黑名单、dry 拒绝零调用、本地回声冒烟（断言请求形状+Bearer 来自 apiKeyEnv 所指变量；超时 157ms@150ms 注入） |
| 车道审查 | A 一次通过（loadPolicy 逐行镜像、种键不泄漏实证）；B 一次通过+1 Important（中途体中止结构化）——已修复并加回归测试 |

## 下一验收

解锁清单现为三项：① DEEPSEEK_API_KEY（DSH 管线+纵向+toolRewrites+边界②运行时）；③ 受控 ZCode 会话（guard 层+自动拾取）；**解锁-⑨**（网关配置文件+开关+键→独立模型复核真调用）。均为用户侧一步动作。

# 第十八轮验证记录：解锁①——DSH 管线级 guard 验证通过（2026-10-27）

用户明示本机 DSH 已登录（解锁授权）；密钥自 `~/.dsh/.credentials.yaml` refs 提取、仅进子进程 env、零打印零落盘；隔离 DSH_HOME，~/.dsh 零写入。

| 项 | 结果 |
|---|---|
| `node scripts/verify-dsh-guard.mjs` | **exit 0**：真实密钥任务中模型调真实 `write` 工具写越界路径，guard 于真实管线拒绝（`gstack861:OUTSIDE_SCOPE`），模型遵守拒绝、探针文件未创建。单任务 ~13.3k tokens（一次最小付费调用，≤200 字符提示词硬上限）。证据 `docs/verification-2026-10-27-dsh-pipeline.md` |
| toolRewrites 一手证据 | 真实工具名 `write`/参数 `file_path` 实拍确认（与调研第 7 节一致）；模型面对 guard 拒绝的遵守行为样本 |
| 状态升级 | DSH guard：activation-tested → **pipeline-verified (single keyed run)**；单次 ≠ 穷尽（旁路/PTC/子 Agent 仍 blocked） |

## 解锁后续（批次 12）

边界①余下半边（DSH 纵向流程、toolRewrites 实装进 hosts overlay/示例策略）与边界②运行时半边（gstack861-skills 注入索引被模型真实消费）现已可做——按既定流程（计划→审→并行→审→推送）执行。

# 第十九轮验证记录：批次 12——DSH 纵向 + 边界②运行时 + toolRewrites（2026-10-27）

| 项 | 结果 |
|---|---|
| `npm test` | 266/264+2skip（新增 15：vertical 验证器离线单测，首个 verify 脚本测试模式） |
| `node scripts/verify-dsh-vertical.mjs`（密钥） | **两任务全过 exit 0**：任务 A 模型经索引真实读 SKILL.md 并逐字输出 28 位随机标记；任务 B 范围内写 guard abstain、文件内容精确。~13.6k tokens，本批密钥任务恰 2（上限内） |
| toolRewrites 重渲染差异 | 23 个 .dsh 产物变化；"the Read tool"→"the read tool" 等六短语条目生效（字节等同上游常量子集，审查程序化核对）；Bash 等无据未加 |
| 状态升级 | 边界①全部完成（deny+allow+纵向+toolRewrites）；边界②全部完成（activation+运行时消费）——DSH 技能装载 → runtime-consumption-verified (single keyed run) |

证据：`docs/verification-2026-10-27-dsh-vertical.md`。仍 blocked：穷尽旁路验证、宿主内嵌 UI、GBrain、设备组（单次运行不宣称穷尽）。

# 第二十轮验证记录：批次 13——DSH 鲁棒性 + 最小纵向（2026-10-28）

| 项 | 结果 |
|---|---|
| `npm test` | 309/307+2skip（新增 43：两密钥脚本离线单测；另加 2 条提示词钉死回归） |
| `verify-dsh-robustness.mjs`（密钥 1 任务） | **PASS**：同会话先 deny（OUTSIDE_SCOPE）后 allow（abstain+文件精确创建）顺序一致；模型遵守 do-both 条款 |
| `dsh-mini-vertical.mjs`（密钥 3×2） | 第一次诚实失败（任务 A `UNMAPPED_TOOL`——模型工具漂移，真实密钥级缺陷，已按 fail 记账）；修复（提示词钉死 read 工具+回归断言）后第二次**全链 PASS**（exit 0）：spec 逐字→implement 精确→qa 逐字，三任务真实记账 |
| 密钥用量 | 本批 7 任务（上限 4+修复复跑 3，原因如实）；项目累计 10 |

证据：`docs/verification-2026-10-28-dsh-robustness-vertical.md`。安全行「多调用一致性」推进为 single-keyed-run 实证；DSH 纵向 spec→qa+记账 vertical-verified（ship/审批未含，子 Agent/PTC 仍 blocked）。

# 第二十一轮验证记录：批次 13 热修——CI ubuntu 红 → 根因 → 复绿（2026-10-28）

| 项 | 结果 |
|---|---|
| 现象 | 8e3459f CI：render-upstream ✓、windows ✓、ubuntu ✗——`dsh-keyed-scripts.test.mjs:65` `windows-style inputs are embedded forward-slash`（Windows 本机过、Linux 失败） |
| 根因 | 代码缺陷：两脚本 `fwd = p => p.split(path.sep).join('/')` 只归一当前平台分隔符；POSIX 上 `path.sep === '/'`，反斜杠输入原样保留。测试钉的是平台无关合同（与同文件 `normPath` 既有约定一致），helper 不满足——修代码不改测试 |
| 独立审核 | 单行热修按比例裁剪：计划审核+成果审核合并为一个独立子代理席位（诊断与修复逐点核实、全仓 `path.sep` 同类排查、安全面 FOREIGN_PATH 核验、新旧 fwd 字节级对照），VERDICT approve |
| 修复 | `verify-dsh-robustness.mjs`/`dsh-mini-vertical.mjs` 两处 fwd 改 `p.split(/[\/]/).join('/')`；测试零改动 |
| 验证 | 定向 43/43；全量 309/307+2skip 与修复前持平；`check.mjs` 通过；POSIX 语义经正则平台无关直接成立 |
| 提交 | 621cabf（代码）→ 摘要于最终 HEAD 重算（本提交）→ push → CI 复核 |

同类排查结论（审核代理输出）：其余 `path.sep` 用点（cliArg ×4、acceptance-pack、render-upstream、测试内局部 fwd）均只作用于平台原生路径，双平台行为不变，不属同类缺陷，未改。

# 第二十二轮验证记录：批次 14——DSH ship 阶段 + 审批集成（2026-10-28）

| 项 | 结果 |
|---|---|
| `npm test` | 328→326/324+2skip（新增 17：ship 纵向离线单测——审成果删除 2 条与 adapters.test.mjs:222-224/:239-244 重复的 CLI 测试；doctor hosts 钉死随状态升级更新） |
| `verify` 密钥运行 1 | 诚实失败：AUTH 401——操作员密钥提取子串误匹配 `MY_DEEPSEEK_API_KEY`（用户今日新增占位条目）；**零计费**（服务端拒绝），编排三段已全过；锚定提取后复跑 |
| `verify` 密钥运行 2 | **PASS exit 0**（恰 1 计费任务）：模型写 `w/ship/` 被 `OUTSIDE_SCOPE` 拒；**改用 pwsh 绕过被 `UNMAPPED_TOOL` 拒**（计划外安全观察：默认拒绝白名单在真实模型探测下工作）；ask 桥审批（reason 只回显不落盘）；shipGate(approved) 后特权发布逐字节校验；consume 单次（重放拒）；任务记账 completed 绑 action-D |
| 密钥用量 | 本批 1 计费任务（401 未计费）；项目累计 **11** |
| 状态升级 | DSH 纵向 → **ship-vertical-verified（单次密钥运行）**：spec→…→ship 全阶段 + 审批门 + 特权发布；FEATURE_MATRIX 第 23/28 行更新；doctor hosts.dsh 同步 |

证据：`docs/verification-2026-10-28-batch14-dsh-ship.md`。审计划 4 项必改全部落实（TTL 900000、CLI 测试去重、泄漏先记账 failed 再中止、控制器 mkdir ship 目录）。仍不宣称：穷尽旁路、宿主内嵌 UI（④）、ZCode 侧 ship 纵向（待③）、真实部署交付（M3+）。

# 第二十三轮验证记录：批次 15——TaskStore 恢复语义 + 审批取消矩阵（2026-10-28）

| 项 | 结果 |
|---|---|
| `npm test` | 326→344/342+2skip（Lane A +11 任务测试；Lane B +7 工作流测试；polish 只收紧未增数） |
| Lane A（b15a，并行子代理） | `src/tasks.mjs` 租约/心跳/收割/重排：进入 running 未给租约必清陈旧租约（审计划发现的健全性洞）；收割↔心跳锁内串行双向钉死；attempts 无双计；CLI `heartbeat|reap|requeue` + `--lease-ms`（界前检查、heartbeat 必填、拒绝不留状态目录） |
| Lane B（b15b，并行子代理） | `src/workflow.mjs` cancelWorkflow：零转移前置绑定检查 → **先拒审批后取消任务**故障安全顺序；第一步失败（过期/已决）零任务突变；崩溃顺序钉死（第二步必败时审批已拒）；审批取消矩阵（可取消态×reject(pending/approved)×consume-拒绝×verify-match）；CLI 增量仅 `approvals reject` 子进程 |
| 独立审计划 | 4 必改（陈旧租约洞/heartbeat 必填/CLI 去重/第一步失败入档）全部落入计划并实现 |
| 独立审成果 | 结论 Yes（可推送）：四必改逐条核实、租约三态全转移路径走查、活探针验证 CLI 拒绝码与零状态目录；3 条 Minor polish（负租约拒绝、60s CLI 租约余量、./workflow 导出）已落实 |
| 密钥用量 | 本批 0 计费（全离线）；项目累计 11 不变 |
| 状态升级 | FEATURE_MATRIX 第 25 行两列 planned → store-recovery-verified（宿主内执行器接线仍 planned） |

证据：计划 `docs/plans/2026-10-28-batch15-taskstore-recovery.md`（含审改记录）；本表即证据（全离线可复现：`npm test` + `node --test test/tasks.test.mjs test/workflow.test.mjs`）。非目标：宿主内执行器中断事件源接线（待③）、真实多进程租约竞争、审批自动级联（设计上不做——cancelWorkflow 是操作员纪律原语）。

# 第二十四轮验证记录：批次 16——DSH 恢复纵向 + ZCode 工作流 harness（2026-10-28）

| 项 | 结果 |
|---|---|
| `npm test` | 344→353/351+2skip（Lane A +3 恢复向量；Lane B +6 harness 测试；成果审查加固后全绿） |
| Lane A 密钥运行 | **PASS exit 0（恰 1 计费任务）**：真实 CLI 崩溃模拟 create→start(lease 5000, attempts=1)→未过期负控 reap 被 TASK_LEASE_ACTIVE 拒→6200ms 真实时钟无心跳→reap=interrupted→resume(lease 900000) running attempts=2→密钥任务 R 在恢复后的记账下读 spec 逐字输出标记行→终检恰 1 条 completed attempts=2 subjectHash 绑 action-R。运行中发现并修复一处装饰性日志缺陷（.parsed 字段，断言一直正确，6826b21） |
| Lane B harness | ZCode 六阶段工作流层**离线** harness 整跑 exit 0（六阶段真实 CLI 记账、review 恢复腿 attempts=2、审批门 pending 负控+ask+consume+重放负控、特权拷贝字节校验、策略腿 OUTSIDE_SCOPE/IN_SCOPE）；注入 `ZCODE_WORKFLOW_INJECT_SHIP_TARGET=1` → exit 1 + SHIP_TARGET_EXISTS（FAIL 不误报 PASS） |
| 密钥用量 | 本批 1 计费；项目累计 **12** |
| 独立审查 | 审计划 4 必改（租约旗标接线/去重定死/注入机制/时序余量）全部落实；审成果 Yes（全量套件/harness/注入/无密钥四项亲手复现，两 Minor 加固已落实：建造器越域旗标必抛 LEASE_SCOPE_VIOLATION） |
| 状态升级 | FEATURE_MATRIX 第 23 行 ZCode 列：六阶段+审批+交付 → 附机器可检离线 harness（offline-workflow-journal-harness 分级，非宿主纵向）；第 25 行：恢复语义已接入 DSH 真实纵向（reap→resume 键控单次运行） |

证据：`docs/verification-2026-10-28-batch16.json`（含密钥转写要点与装饰性修复出处）。诚实边界：恢复纵向为单次密钥运行+进程内崩溃模拟（真实 SIGKILL 多进程竞争仍非目标）；ZCode harness 零模型调用零宿主 API，阶段工件为控制器站位。

# 第二十五轮验证记录：批次 17——doctor verticals 整合 + verify-* 统一回归与文档收口（2026-10-28）

| 项 | 结果 |
|---|---|
| `npm test` | 353→360/358+2skip（Lane A +2 doctor 测试；Lane B +6 一致性/钉死测试；合并树跨 lane 红转绿，0 失败） |
| `npm run verify-offline` | **8/8 步全绿**（6 键控脚本 BLOCKED 冒烟 ~0.2s/个 + ZCode harness 整跑 ~5s + model-review 就绪 ~0.5s；零网络超回环、零模型调用）；已入 CI offline-contracts 两腿 |
| doctor 整合 | hosts 刷新（zcode=`workflow-harness-verified-offline`、dsh=`ship-and-recovery-vertical-verified-single-keyed-runs`）；新增 `verticals` 10 条清单（keyed/status/evidence，证据路径测试断言存在；8dot3 轮次更正为第 5 轮）；networkCalls 首次被测试钉 0 |
| 文档收口 | `docs/VERIFICATION-SCRIPTS.md` 脚本总表（10 行）+ 密钥预算纪律 + CI 安全边界（skills 需本机 DSH、8dot3 卷相关，均不入 runner）；host-loading/zcode-acceptance/acceptance-pack 三处陈旧 `not-host-verified` 字面量更新为如实措辞 |
| 三方一致性 | 表↔文件系统双射、证据存在、doctor↔表键集与 keyed 布尔一致——测试钉死，防漂移 |
| 密钥用量 | 本批 0；项目累计 12 不变 |
| 独立审查 | 审计划 4 必改全部落实（hosts 测试原地改/8dot3 第 5 轮/跨 lane 合并门/陈旧字面量）；审成果 Yes（四项亲手复现：套件、runner、doctor、check；5 条证据抽查属实；无 overclaim） |

成本如实记录：ZCode harness 每条 CI 腿整跑 3 次（自身测试 5.2s + runner 契约测试内 4.4s + CI 步 4.4s ≈ 15s/腿）——批次 17 计划接受并要求记录。runner 冒烟失败诊断输出与步 2/3 对齐（成果审查 Minor 1 已落实）。

# 第二十六轮验证记录：批次 18——终版盘点与收口（2026-10-28）

| 项 | 结果 |
|---|---|
| `npm test` | 360→370/367+3skip（Lane A +3 竞争测试；Lane C +7 真调用入口测试，1 例 win32 symlink 跳过） |
| 双进程租约竞争（Lane A） | **15 次真双进程 reap/heartbeat 竞争全部恰一 exit 0**；胜者分布 reap 6/heartbeat 4；四种合法"胜者×败者码"组合（WRONG_STATE/LEASE_ACTIVE/BUSY）均真实出现；成果审查独立复测 10/10 恒一胜者；双收割者恰一成功 attempts 不变；控制组钉死装置有效性。此前的"真实多进程竞争为非目标"保留意见就此关闭（SIGKILL 竞争仍环境受限） |
| 终版盘点（Lane B） | `docs/OFFLINE-COMPLETE.md`：**不宣称离线已尽**——待解锁 5 项（③ acceptance-pack 含 --rendered 变体、⑨ 精确命令、④+执行器接线、宿主级安装、DSH 键控预算类）、离线余量 3 项（纯工具二进制 slug/paths/patch-names/jsonl-merge/redact/issue-links/banned-terms、原生迁移 migrate-claude-code、team-init——名字逐一核实于上游 5755601）、环境受阻 9 项（各一句"缺什么"）。审计划发现的盘点洞（README⑪/迁移/⑫ 一桶化）全部补上 |
| gateway 真调用入口（Lane C） | `verify-model-review.mjs --gateway-config <abs>`：loadGateway 全 schema 在真实文件上执行→回环覆盖仅在验证之后；`GSTACK861_MODEL_CALL=1`+apiKeyEnv 红线（键值零打印——开发中测试抓到并修正了一处字段名泄漏）；单次封顶由构造保证+测试外部计数；裸模式字节不变。⑨ 的触发方式从"以代码为准"变为一条精确可运行命令 |
| 矩阵真值同步 | L24 DSH→vertical-slice-verified（生命周期切片限定，非 /investigate、/review 方法论）；L25 非目标子句替换+实测分布落终稿；L29 事实修正（document-generate 已于批次 6 消费——成果审查抓到的错误）；L3/README "离线已尽"表述与终版清单对齐（余量显式在案） |
| 密钥用量 | 本批 0；项目累计 12 不变 |
| 独立审查 | 审计划 4 必改（TASK_BUSY 断言集/盘点洞/⑨ 真入口/措辞限定）→ 批次扩三 lane；审成果 with-fixes：2 Important（L29 事实错误、已尽矛盾）+2 Minor 全部由协调者在终稿落实；已知残留：REVIEW_OUTPUT_UNPARSEABLE 详情含网关控制的前 1KiB 响应体（批次 11 既有行为，记为加固项非本批缺陷） |

证据：`docs/verification-2026-10-28-batch18.json`。结论修正：**离线空间未"已尽"——余量=纯工具二进制移植+原生迁移工具（后续批次）；其余待用户解锁（OFFLINE-COMPLETE §一精确触发方式）或环境受阻（§三）。**

# 第二十七轮验证记录：批次 19——migrate-state + jsonl-merge 移植 + 二进制审计（2026-10-28）

| 项 | 结果 |
|---|---|
| `npm test` | 370→389/384+5skip（Lane A +10 迁移测试；Lane B +9 merge-driver 测试；均为真实子进程） |
| migrate-state（Lane A） | **0.3.1 文档化债务关闭**：无前缀 0.3.0 记录自动迁移（内容分类 attempts/expiresAt、歧义拒绝绝不猜、只 rename 不动字节、目标冲突拒绝、dry-run 零写入、笔误 --state 零目录创建）；端到端证明=迁移后新 TaskStore/ApprovalStore `get(id)` 读出完整记录。0.3.0 形状经 git dc2280f^ 逐字段核实。开发插曲如实记录：首次写盘 uuid 正则被工具异常损坏（v4 组丢失），测试当场暴露，重写后与 src/tasks.mjs 逐字节比对一致 |
| jsonl-merge 移植（Lane B） | 零依赖 Node git merge driver（上游内嵌 python3 前提消除）；复合键两群全序+行决胜；**侧对称钉死**（merge(base,ours,theirs) ≡ merge(base,theirs,ours)）；ENOENT=空输入；4 项审计划语义修正全部落实 |
| 二进制审计落盘 | OFFLINE-COMPLETE §二 9 行表：ported 1（jsonl-merge）/ covered 1（patch-names→render 链 renderedDir）/ N/A 1（paths→Claude 插件环境前提）/ mapped 1（migrate→本项目 0.3.1 债务）/ deferred 5（slug 880、redact 341+817、issue-links 202、banned-terms 90、team-init 269，各注理由） |
| 密钥用量 | 本批 0；项目累计 12 不变 |
| 独立审查 | 审计划 4 必改（空行丢弃/ts 别名/两群键/ENOENT）全部落实；审成果 with-fixes：**差异账本双向纠错**——CRLF 行为非 upstream-exact（上游 python 文本模式剥 \r，本移植字节导向保留 \r，记为分歧 5）；空串 ts（`??` vs `or`）与顶层数组护栏（上游崩溃退出 vs 本移植哈希群排序）两处真实分歧补记 6/7；UTF-8 边缘记 8。账本已修正后落盘。README 0.3.1 段落同步（人工改名→提供 migrate-state） |

证据：`docs/verification-2026-10-28-batch19.json`。诚实边界：merge driver 与 GBrain（⑤）的集成未发生（无消费方）；migrate-state 针对的 0.3.0 记录在真实部署中不存在（债务是文档性的，工具按形状防御性实现并全矩阵测试）。

# 第二十八轮验证记录：批次 20——banned-terms 移植 + team-init 原生映射（2026-10-28）

| 项 | 结果 |
|---|---|
| `npm test` | 389→426/421+5skip（Lane A +29 banned-terms 真实 git fixture 测试；Lane B +8 team-init 测试） |
| banned-terms 移植（Lane A） | 上游 bin+lib+ship-policy 助手零依赖移植；审计划 4 必改全落地（policy 默认读 base 提交副本+bin 层回退/配置自豁免/退出码全矩阵 0-3 含 refused≠ask 账本注记/base 链静默回退 main）；termRegExp 四规则、addedLines/wholeFiles、render/--json 逐字；5 条差异入账本；**成果审查逐函数语义比对零未记账分歧**，6 项必改逐一活体复现。Lane 开发如实记录 5 处"工具对、预期错"的测试修正 |
| team-init 映射（Lane B） | Claude 专属表面（CLAUDE.md/check-gstack.cjs/.claude/settings/vendored 迁移/git-commit 尾块）映射为 AGENTS.md（宿主侧约定[验收项]标注，仓库不断言）+ 既有 zcode hook/DSH guard 入口（接线命令逐字钉死）；映射表入头注释；幂等（跨模式）；纯度测试钉死零 Claude 字样 |
| 大件评估 | OFFLINE-COMPLETE §二：deferred 5→3（slug 行按审查重写=身份 slug 解析器+checkpoint 簿记非 TUI；redact 补 fs-utils 依赖；issue-links 补闭包边界=bin 的 issue-guard/gh 调用） |
| 密钥用量 | 本批 0；项目累计 12 不变 |
| 独立审查 | 审计划 6 必改（policy 源默认/自豁免/退出矩阵/base 链/slug 特征证伪/AGENTS.md 出处）全部落实；审成果 Yes（逐函数比对+活体 fixture，git<2.28 回退 Minor 已补） |

证据：`docs/verification-2026-10-28-batch20.json`。过程插曲如实记录：批次中段子代理配额受限一次，恢复后重跑计划审查席（结论不受影响，席位完整）。

# 第二十九轮验证记录：批次 21——gstack-slug 两段移植 + 薄 CLI（2026-10-28）

| 项 | 结果 |
|---|---|
| `npm test` | 426→493/488+5skip（Lane A +19 身份解析；Lane B +37 簿记；Lane C +11 CLI；67 条新增全绿） |
| Lane A（21c5a35） | `remote-identity.mjs` TS 孪生逐字（审计划 6 分支全含；上游 27 向量金样回放）+ `slug.mjs` 规则 0-4/STRONG-WEAK 两层 allow-list/v2 缓存零 git spawn（计数证明）/#3003 升级+一次性 LEGACY_NOTICE/双键写/两自愈形状/former-slugs；9 条差异账本 |
| Lane B（629930e） | `slug-checkpoints.mjs` 11 个纯函数（身份/拓扑全注入，导入面纯度有测试断言）；**活体上游脚本对照**：41/41 原语字节相等、24/24 分类矩阵、三模式端到端一致；6 条差异账本 |
| Lane C（f76f1a3） | `bin/gstack861-slug.mjs` 九模式薄 CLI（--get 白名单 exit 2、%q 对等决策、tty→stdin、GSTACK861_STATE_ROOT 隔离——真实 home 快照断言未触碰 ~/.gstack 与 ~/.gstack861）；10 条差异账本 |
| 独立审查 | 审计划 6 必改（API 形状/win 分支/两层标记/#3003 升级方向/四字段刷新/模式契约）；审成果 Yes：审查者独立对**活体上游**复测——27 fixture+15 自选向量字节相等、7 种 CLI 模式端到端一致、6 项必改逐一活体验证；2 Minor（8.3 拼写装饰性双显、断链符号链接目的地方安全偏向）已按建议处理（realpath 保持字节对等+账本；lstat 差异入账本）+ exports 补三模块 |
| 协调者插曲 | 一次过度修复被测试当场拦截：把 realpathSync 换 .native 致 5 条保真测试红（Lane B 的字节对等证据建立在原实现上）——回退并改为账本记录（审查者的最低建议）；教训如实入账 |
| 密钥用量 | 本批 0；项目累计 12 不变 |

证据：`docs/verification-2026-10-28-batch21.json`。离线余量剩 redact（341+817+fs-utils）与 issue-links（202+闭包）两项。

# 第三十轮验证记录：批次 22——redact 扫描核心移植（2026-10-28）

| 项 | 结果 |
|---|---|
| `npm test` | 493→847/840+7skip（Lane A +330 上游向量回放；Lane C +24 CLI 契约测试，2 例 POSIX-only slow-pipe 跳过） |
| Lane A（da15255） | `redact-patterns`（1075 行：44 模式+全部上下文校验器+spanBounds AUDIT-SYNC）+`redact-engine`（817 行：审计划 5 组语义全含——email 豁免簇/sourcePath #3048/五栅栏标签/结构守护 skipped/null 扣留契约）；fixtures 逐字节（git blob 哈希相等）；**差分 harness 对类型剥离的原版上游 TS 直比：TAXONOMY IDENTICAL + ENGINE IDENTICAL OVER CORPUS**（用后删除）；cso 导入断言随 cso 批、spawn-bin 尾块按约移 Lane C 回填 |
| Lane B（e5a082b） | OFFLINE-COMPLETE §二：redact 扫描核心本批完成（不宣称整支移植）；prepush 790+27 deferred 行（特征+state-root/sealed-guard 依赖闭包+5 个上游测试文件名）；**并发现批次 21 遗留的 slug 行表格损坏（协调者 sed 工件）——本批收尾修复** |
| Lane C（0fc4e33） | `gstack861-redact` 扫描路径 CLI：四态退出码（usage=1 与 M=2/H=3 区分）、空路径 #2679 不落 stdin、非法 max-bytes #1824、16MiB 引擎前边界、--auto-redact 正文+diff、bd621cc0 排空语义逐字、hook 子命令按 RC3 连 import 一并删除；spawn-bin 尾块回填兑现 |
| 独立审查 | 审计划 4 必改全部落实；审成果 Yes：审查者**独立差分复测约 4500 次比较零分歧**（上游语料 722 向量×2 矩阵 + 60 对抗构造×3 矩阵 + 全 redact API），四态退出/回填/账本/文档逐项活体验证；发现上游自身一处死代码（WARN 降级分支不可达——移植逐字保真，记入 prepush 批次上下文） |
| 密钥用量 | 本批 0；项目累计 12 不变 |

证据：`docs/verification-2026-10-28-batch22.json`。离线余量剩 prepush（790+27）与 issue-links（202）两项（各自依赖闭包已入 OFFLINE-COMPLETE §二）。

# 第三十一轮验证记录：批次 23——redact-prepush 移植 + hook 回填（2026-10-28）

| 项 | 结果 |
|---|---|
| `npm test` | 847→967/957+10skip（本批 +120：Lane B 24 = scan-range 16+rebase 8；Lane C 84 = emails 20+target 28+hook 36；Lane A 12 = sealed 7+ship-policy 5；skip 3 例 win32 结构性带理由） |
| Lane A（4a4d98a） | ship-policy 三助手提升共享库（banned-terms 重构导入，29 测试回归门）+ fs-utils（#2635）+ sealed-guard 276 全语义（并集只紧不松/豁免仅 base 分支 sha 前缀/private-warn 非阻断/可见性缓存 TTL+尽力写路径逐字）；状态根 GSTACK861_STATE_ROOT 映射绝不触碰 ~/.gstack；上游 sealed-guard.test.ts 7/8 适配（1 pregate 随非目标 drop 入账）；一次性 driver 全 6 场景真 git 验证 |
| Lane B（ce099af） | prepush 790 逐字移植（三 fail-closed/三步 diff 链+addedLinesFromNewCommits 收窄优先/分块扫描/committed allowlist/email 历史 5s 非阻断降级/版本豁免/字节精确输出）；logSkip 状态根注入钉死；win32 零跳过（Git-for-Windows sh 跑钩子） |
| Lane C（26b9a99） | hook install/uninstall 回填（wrapper 与上游模板仅两处账本替换：marker 名、node 路径；printf x 哨兵/链式 .local/幂等/陈旧刷新/卸载还原逐字）；emails/target/hook 84 向量适配；**drop 7 测全部逐条入账**（hook install-UX 6——计划误写 5，Lane 诚实修正+1 sealed pregate） |
| 独立审查 | 审计划 8 必改全部活体验证（含审查者自制 fixture 复验收窄优先双向、email 降级配对向量、~/.gstack 零触碰）；对上游规范化差分**仅剩账本类差异**；钩子 wrapper 活装字节比对 |
| 密钥用量 | 本批 0；项目累计 12 不变 |

证据：`docs/verification-2026-10-28-batch23.json`。离线余量仅剩 issue-links（202 行，闭包=gh 调用前提待审）。

# 第三十二轮验证记录：批次 24——issue-links 移植，离线余量清零（2026-10-29）

| 项 | 结果 |
|---|---|
| `npm test` | 967→996/976+20skip（Lane A +19 库向量[7 bin 副本收尾删除]；Lane B +17 bin 向量；skip 10=win32 shim 结构性带理由+10 既有） |
| Lane A（c05234b） | `issue-links` 188 逐字（零导入保零导入）+ `tracker-guard` 117（INJECTION_PATTERNS 13 正则内联+账本）+ resolveBaseBranch 提升共享库（banned-terms 三度重构，29 门绿）；上游 ship-issue-intent 5 纯库向量+tracker-guard 7 库向量适配 |
| Lane B（17eda93） | `gstack861-issue-guard` 98 + `gstack861-issue-links` 202（result-codes 两码含 docs 后缀逐字、EXIT_TABLE_HELP 字节同、guard 子进程 process.execPath 调 .mjs）；8 bin 向量适配（7+1 构造性免 shim）+ gh 缺失极性向量双腿（--issue 降级序列/零 spawn 反断言/--stdin 信封）；shim 类 POSIX 腿、win32 带理由 skip |
| 独立审查 | 审计划 4 必改（**向量源更正**：上游 ship-issue-intent.test.ts 存在，废弃"自行构造"；INJECTION_PATTERNS 依赖；result-codes 格式；win32 shim 分诊）；审成果 Yes：四文件对上游规范化 diff 仅账本类+7 处前缀改名补账本；活体冒烟逐字匹配计划序列；**7 个过期 skip 副本按建议删除**（skip 只给不能跑的测试，不给覆盖两次的） |
| 密钥用量 | 本批 0；项目累计 12 不变 |
| 里程碑 | **OFFLINE-COMPLETE §二 离线余量清零**——上游纯工具二进制族（jsonl-merge/banned-terms/team-init[映射]/migrate[映射]/slug/redact 全家/issue-links 全家）全部 ported/mapped；剩余全部为 §一用户解锁或 §三环境受阻 |

证据：`docs/verification-2026-10-29-batch24.json`。

# 第三十三轮验证记录：批次 25——③ ZCode 受控会话验收（无头真实派生）（2026-10-29）

| 项 | 结果 |
|---|---|
| `npm test` | 996→1004/984+20skip（+8 离线测试：config.json 合并目标/HOOK_TRUST_PENDING 分类/汇总判定/提示词/host=zcode 向量/无开关 exit 2；doctor↔表↔fs 三方同步 11 行） |
| 机制发现 | **ZCode 有无头 CLI**（ELECTRON_RUN_AS_NODE=1 + zcode.cjs --prompt/--cwd/--mode/--json；as-node 绕过应用引导）——③"需用户开新会话"的定式写于无人调查此前；审计划另纠正两阻断错：合并目标是 **.zcode/config.json**（无 settings.json）且 0.17.0 工作区钩子有信任门 |
| 零成本探针 | skills list --cwd **发现**标记技能（项目域）；钩子 stdin 三探针 src=pass/outside=deny/.git=deny（真实钩子命令直打） |
| 密钥运行 | 冒烟 **PASS**（真实会话 sessionId/response/usage 39.5k tokens；--json 输出为最终汇总对象——事件流不在 stdout，判定改汇总制）；任务 P（技能装载）**PASS**（标记行逐字+零 guard 码）；任务 G（guard 双向）**HOOK_TRUST_PENDING**（越界文件被创建且无 deny 转述——最强假设为信任门使钩子未运行；Bash 通道/钩子运行但放行两角落无宿主诊断不可区分，如实措辞；非 guard 失败亦绝不计 PASS）。汇总制判定放弃了事件流版的"恰两次 Write 调用"检查（CALL_COUNT_WRONG/WRONG_TARGET 两码随之删除——损失如实入账）；--pack-root 稳定包复跑选项使信任手势可操作（信任跨运行持久性未验证）。doctor hosts.zcode 维持 workflow-harness-verified-offline：guard 半段未竟前不升级（偏离计划承诺，理由如实） |
| 记账 | 5 个 zcode 无头计费调用（预算 3→5 如实：两次零成本阶段门拦截[缺 ELECTRON_RUN_AS_NODE、探针参数拼重]+一次冒烟后记账 bug[校验器喂字符串当对象]；DSH b13 cap-extension 先例）；项目 DSH 累计 12 + zcode 5 |
| 过程插曲 | 三次诚实失败-修复循环全部在阶段门或判定层拦截；批次 17 三方一致性护栏第三次当场抓住新脚本未入总表 |
| 状态升级 | ③ 拾取半段：**工作区技能发现+Skill 工具装载=host 级实证（真实无头会话）**——不宣称上下文自动注入/UI 会话/host_verified full；guard 半段：待一次用户信任手势（OFFLINE-COMPLETE §一 精确步骤） |

证据：本表+脚本转写要点；版本 caveat：证据针对本机 zcode 0.17.0，与锁文件提交 3c5b227 映射未验证（同 DSH 第 7 条）。

# 第三十四轮验证记录：批次 26——③ guard 半段收口（架构性结论）（2026-10-29）

| 项 | 结果 |
|---|---|
| 中心结论 | **zcode 0.17.0 无头 `--prompt` 模式架构性禁用工作区钩子**——非可信任宿主。证据链：客户端日志 `workspace_hook.feature_disabled`（reasonCode workspace_hooks_feature_disabled, source startup, identityDigest=sha256(工作区路径)前 12 hex 吻合；全天 13 个无头会话每会话恰一条）+ bundle 反解门条件 `workspaceHookTrustEnabled===true`（仅 app-server session/create 路径设置——桌面客户端所用协议层；--prompt 无头路径无任何设真点）。独立审核者复核 4 处标志引用后确认无翻案反例 |
| ③ 状态定级 | 拾取半段 host 级实证（批次 25）；guard 半段**无头不可达**（本批新知），桌面客户端为唯一可执行宿主；信任决定已按用户明示授权（两条消息在案）以运行时真实模块+真实 schema 登记入 `~/.zcode/security/workspace-hook-trust-v1.json`（唯一新增文件，全链披露；首次直写漏 maxOutputBytes=32768 输入→审核发现确定性分歧→已用修正输入重写：decl b665fe62…/bundle f3b02182…，与审核者独立重算一致） |
| 协议考古（零计费） | app-server 线协议跑通 session/create+send（send 因无模型上下文 prompt_failed）；tui 未打包；四条代理路径全排除后才得出架构性结论 |
| 密钥账（审核更正） | 本批 **8**（06:36 三调用[存储不存在]+07:33 两调用[残留 outside.txt 触发 ALREADY_EXISTS 中止，G 未发射——如实入账]+07:37 三调用[存储已在，仍 feature_disabled]）；项目 zcode 累计 **13**、DSH 12 |
| 代码改动 | 仅 `zcode-acceptance-vertical.mjs` 的 reusePack 作用域修复（finally 引用 try 内 const 崩溃） |
| 独立审核 | 拒绝现稿→三项修正全部落实：计费 8/13+中止运行披露；摘要分歧重写；措辞收紧（app-server 协议层非"桌面路径"） |

证据：本表+客户端日志（zcode-2026-10-29.jsonl 的 feature_disabled 条目）+bundle 反解片段（审核报告在案）。OFFLINE-COMPLETE §一 3b 同步重写：桌面打开 `…\pack\workspace` 发一条消息即弹信任确认（若修正摘要与桌面重算一致则直接 trusted_persistent，否则按提示再点一次确认——两步内完成），随后桌面内手工跑 STEPS.md §5 探针（钩子三态已在 stdin 直打级验证）即完成 guard 验收。

# 第三十五轮验证记录：批次 27——③ 桌面端 guard 验收（用户交互执行）（2026-10-29）

| 项 | 结果 |
|---|---|
| `npm test` | 1004/984+20skip（无代码改动；纯验收批次+两份证据文档） |
| 桌面会话 | 用户在真实桌面客户端打开验收包工作区（session_3ffdfab2…，日志核对 workspaceKey 一致） |
| ③ 拾取（桌面半段） | 系统提示词含 `zc-g861-marker`（rollout 捕获）——加上批次 25 无头 Skill 装载，拾取双宿主形态齐 |
| ③ guard deny | `Write(outside.txt)` → PreToolUse 钩子以规范载荷拒绝：`{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"gstack861:OUTSIDE_SCOPE"}}`（rollout 捕获原文；当前二进制对同输入复现逐字一致） |
| ③ guard allow | `Write(src/ok.txt)` → 完成、文件精确 y、该请求后对话零 guard 码 |
| ③ .git 探针 | `Write(.git/config)` → deny 同码、文件原样（用户逐字转述+日志 deny 形状+文件字节三重核） |
| 信任命中 | 无弹窗=批 26 预登记信任记录精确命中（审核者用运行时真实管线重算摘要 b665fe62… 逐字匹配） |
| Bash 绕过 | 首次发生（经用户确认后执行）——Shell 不在 matcher 为声明边界（README 安全边界节；DSH 批 14 pwsh 同型）；.git 探针时模型未擅自绕过 |
| 独立审核 | 七项实证全过+多处超文档主张的独立佐证（mtime 对齐/tool-result artifact/唯一性排查）；必改措辞落实：定级收窄为"主链路+三探针桌面 host 级实证"，STEPS §4 E/F/G/H 为遗留 |
| 密钥用量 | 本批桌面会话模型调用由用户交互产生（约 8 次请求；非代理计费——如实分类） |

证据：`docs/evidence-2026-10-29-batch27-desktop-session.md` + `-desktop-log.jsonl`。

# 第三十六轮验证记录：批次 27 补充——STEPS §4 E fail-closed 探针（2026-10-29）

| 项 | 结果 |
|---|---|
| E（fail-closed） | 损坏 policy.json → 桌面真实会话 `Write(src/ok.txt)`（正常放行范围）被**闭锁拒绝** `gstack861:HOOK_INPUT_OR_POLICY_ERROR`（规范 hookSpecificOutput 载荷，rollout 逐字捕获）；文件未变；模型未绕过。机械复现：同一钩子命令+损坏策略 stdin 直打 → exit 2 同载荷；复原后 → exit 0 `{}`。策略已复原、备份已清 |
| 密钥用量 | 桌面用户交互驱动（非代理计费） |

遗留更新：STEPS §4 剩 F（钩子超时）/G（updatedInput 共存审计）/H（UI 回滚）。证据：`docs/evidence-2026-10-29-batch27-desktop-session.md` 补充 2。

# 第三十七轮验证记录：F 探针处置——遗留项+验收包复原（2026-10-29）

| 项 | 结果 |
|---|---|
| F（钩子超时） | 已备未执（挂起钩子+config 备份就绪，用户多次核查期未执行桌面探针）→ 按授权记为**遗留**；未来步骤与预期（宿主文档先验=超时不保证阻断）入 batch27 证据补充 3 |
| 验收包复原 | config.json 逐字节还原（decl/bundle 摘要与信任存储**双匹配**——预登记信任继续有效）；hanging-hook.mjs 删除；stdin 探针 exit 0 `{}` 复原验证 |
| 密钥用量 | 0 |

遗留总表更新：⑨（网关配置）、F/G/H、④-⑧、macOS。证据：`docs/evidence-2026-10-29-batch27-desktop-session.md` 补充 3。

# 第三十八轮验证记录：批次 28——⑨ model-review 真调用（本机显式网关）（2026-10-29）

| 项 | 结果 |
|---|---|
| `npm test` | 1004→1008/988+20skip（+4：证书效期≥9 年断言、子进程 TLS 自证 [带 CA 成功/不带 CA 必拒双测]、单调用封顶 [首 POST 计数、次 POST 429]） |
| 审计划 | 6 必改全部落实（三段流程更正/IP SAN/10 年效期 vs CI/子进程 env 证明法/healthz 不计数/⑨ 行措辞为操作员放置） |
| 运行 1（未计费） | GATEWAY_ERROR 401——协调者首版编排的键传递缺陷（DS_KEY env 未能到达网关子进程；直连上游同键 curl=200 证明键本身有效）。401=服务端认证拒绝、未推理未计费。修复编排后复跑 |
| 运行 2（**恰 1 计费**） | **PASS exit 0**：三段流程（loadGateway→红线→单调用）；verdict `request_changes` 1 finding（模型对夹具 diff 的合理评审——"changelog 式片段非真实代码 diff"），usage 159 tokens；网关侧独立断言 `POST -> upstream 200 (posts=1)`——单次封顶由外部装置证实 |
| 密钥纪律 | DEEPSEEK_API_KEY 锚定提取→仅网关子进程 env；网关上游头**只**自建（绝不透传占位 Bearer）；两版编排均零打印/零落盘；运行后网关杀除、全部临时件清理 |
| 状态升级 | FEATURE_MATRIX ⑨ 行：mechanism-ready → **runtime-verified (single real call)**；配置为协调者在用户持续授权下显式放置（本机 127.0.0.1 网关，黑名单尊重——防回退构造未被触碰） |

证据：本表+网关日志行 `POST -> upstream 200 in 1641ms (posts=1)`（转写）。密钥用量：本批 1 计费（401 未计费）；项目 zcode 13、DSH 12、网关路径 1。

批次 28 成果审查补记：3 项 Important 已修——(1) 封顶计数器改为门通过时同步递增（原 await 后递增存在 TOCTOU 窗口）；(2) 封顶测试收紧为首次恰 200、二次恰 429（原断言接受 ERR 即通过）；(3) 测试上游改为本地 stub（DEV_GATEWAY_UPSTREAM 覆盖；原测试会向真实第三方端点发未认证 POST——与 README 离线声明不符，如实更正）。上游 fetch 加 30s 超时；开发密钥对公开性账本注记入脚本头。401 运行的键验证 curl 端点为 POST /chat/completions 同路径（该次为验证键有效性、未过网关、按用户既有授权记账为一次探活——严格说本次批计量应为 1 计费+1 探活，如实并列）。FEATURE_MATRIX ⑨ 行归属措辞：操作员放置（本行由 OFFLINE-COMPLETE §2 与本记录承载完整表述）。就绪检查独立步骤未单列（三段流程自身覆盖配置可读性）——如实声明。

# 第三十九轮验证记录：批次 29——DSH 键控消费 careful + design-review（2026-10-29）

| 项 | 结果 |
|---|---|
| `npm test` | 1008→1016/996+20skip（+8：钉定上游 frontmatter 字节断言、3 条目 fixture 链、提示词钉 read 工具回归、判定码全形含 RC5 检测基础、CLI 向量、action 文件、无密钥 exit 2） |
| 审计划 | 5 必改落实（成果审查后补齐 2 项遗漏：verify-offline 注册与设计行注记——初稿误记"全部落实"，本行如实更正（三向登记/上游路径与描述修正[tmpl 块标量不可用→取渲染 frontmatter 字节实测]/记账机器显式化/判据收窄为批次 12 任务 A 同款·不计入 15 例/SKILL_NOT_IN_INDEX 定义化） |
| 运行 1（2 计费） | careful **PASS**（标记逐字）；design-review **GUARD_CODES_PRESENT: gstack861:UNMAPPED_TOOL**——模型工具漂移（批次 13 同型真实缺陷，可证伪判定如实捕获并记 fail） |
| 修复 | 提示词钉死 "Use the read tool"（+回归断言）；复跑（2 计费）**全 PASS**：两技能均经 index→read 消费（标记逐字+零码）；记账 completed×2 绑各自 action 文件；终检恰 2 条终态正确+subjectHash 绑定 |
| 密钥用量 | 本批 4 计费（运行 1 的 2 + 修复复跑 2——cap 3→4 如实扩展，b13 先例）；项目 DSH 12→16 |
| 定级 | §一5 部分完成：careful+design-review **能力切片消费实证**（装载→index→真实读），非 15 例方法论消费（合成 fixture，计划明示）；freeze/cso 与设计组其余 4 技能为后续预算类 |

证据：本表+脚本转写要点。fixup：模板非导出函数（dshInstall/dsh/childEnv/composeCheck）本地复刻；残留 require_node_crypto 引用两次键控运行前各修一次（第一次导致 scaffold 失败未计费）。

批次 29 成果审查补记：4 项 Important 全部修复——(1) verify-offline 注册补齐（七键控冒烟，9/9 绿）；(2) FEATURE_MATRIX「浏览器/QA/设计」行 design-review 落地注记；(3) composeCheck 恢复 agent 栈断言（agent-default-model+headless）；(4) 键控发射补 DSH_PERMISSION_MODE=danger-full-access（家族惯例，头注释说明）。Minor 清理：未用 import 删除、actionFile 占位改省略+崩溃注释、blocked() 上限历史注记。

# 第四十轮验证记录：批次 30——DSH 键控消费 freeze + cso（§一5 安全组收尾）（2026-10-29）

| 项 | 结果 |
|---|---|
| `npm test` | 1016→1020/1000+20skip（+4：resolveSkills 矩阵[缺省顺序钉死/未知/空/重复拒绝+freeze,cso 字节解析]、白名单 8 条目 git-show 字节全钉、--skills fixture 形状、无效参数先于密钥门 exit 1） |
| 审计划 | 6 必改全部落实（白名单=名称→字节钉定描述映射[8 条目计数更正]/校验先于密钥门+重复拒绝/线程路径补全[prepareConsumption 穿参]/恰-2 全去参数化/C30 标识/文档范围补全） |
| 键控运行 | **首跑即全 PASS exit 0**（恰 2 计费）：freeze+cso 均经 index→read 消费（G861-C30 标记逐字+零码）；记账 completed×2 绑各自 action 文件；终检恰 2 条+subjectHash 绑定；安全组三技能（careful/freeze/cso）至此全部能力切片消费完毕 |
| 参数化 | `--skills a,b`（白名单校验；缺省=careful,design-review 向后兼容）；blocked()/日志/记账计数全部由 N 派生 |
| 密钥用量 | 本批 2 计费；项目 DSH 16 → 18 |

证据：本表+脚本转写要点。§一5 剩余：设计组 4 技能（design-consultation/shotgun/html/devex）——同命令一键可续。
