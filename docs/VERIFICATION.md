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
