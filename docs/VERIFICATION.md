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
