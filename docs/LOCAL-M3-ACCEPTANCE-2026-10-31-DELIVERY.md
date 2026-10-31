# M3 发布证据归档与协调交接 — 2026-10-31

代码、回归测试及前三份验收报告已随 `408ededd1764cd45e156a42e2c20b6bad17862bc` 推送。本次仅新增本说明、发布证据包及其摘要清单，补齐该代码提交之后生成的实际 CI 成功日志、提交/推送记录、源码快照和最终交接记录。此前提交的 238 个文件逐项确认字节未变；没有新增功能、修改测试或改变 CI 工作流。

开发分支为 `work/m3-command-aliases-20261029`，[PR #3](https://github.com/wmqfl861/gstack861/pull/3) 的目标为 `audit/full-review-20261029`。PR 保持打开，main 未被改写。本次证据提交的完整 SHA 以及它自己的 Actions 结果，在正常推送后由最终交接消息提供；下表 CI 明确属于代码提交 `408ededd…`，不冒充后续提交的结果。

## 已完成验证

本地 Ubuntu 24.04.1、Node 24.21.0、Git 2.43.0，普通用户 UID/GID 1000；数据盘工作目录 `/mnt/d/codex-workspace/gstack861-m3-acceptance-20261030/feature`。本地完整测试使用 umask 0022 和数据盘短 TMP。原生 Windows 实机宿主在本会话不可用。

| 验证 | tests / pass / fail / skip | 结果 |
| --- | --- | --- |
| 本地完整测试 | 1164 / 1163 / 0 / 1，81 suites | exit 0 |
| ZCode 与 CLI 定向 | 45 / 45 / 0 / 0 | exit 0 |
| Ubuntu CI，两个 run 各自 | 1164 / 1163 / 0 / 1，81 suites | success |
| Windows CI，两个 run 各自 | 1163 / 1142 / 0 / 21，81 suites | success |
| 语法 / offline / doctor / inventory | 115 modules；9/9；doctor exit 0；57 个固定上游技能 | 完整记录保留 |

两个实际 run 都绑定代码提交 `408ededd1764cd45e156a42e2c20b6bad17862bc`：

- [push 41096155740](https://github.com/wmqfl861/gstack861/actions/runs/41096155740)：Ubuntu、Windows、render-upstream 全部 success。
- [pull_request 41096165326](https://github.com/wmqfl861/gstack861/actions/runs/41096165326)：Ubuntu、Windows、render-upstream 全部 success。

Windows runner 是 Windows Server 2025 / 10.0.26100 / Node 22.16.0。原先 27 项 Windows 失败在两个 run 中均逐名确认通过；本轮新增的 7 项零设备号回归也都通过。21 项 Windows skip 名称与此前完全相同。两次运行是对同一套测试的重复验证，不算独立套件数量。

实际 Windows 诊断仍为路径 dev=0、句柄 dev=782947067；修复通过独立第二句柄绑定身份，并保留路径/句柄 CAS、目录、锁及清理所有权守卫。没有通过忽略身份、放宽断言、增加超时或跳过失败来获得绿色结果。

## 已归档成果

- [主验收报告](LOCAL-M3-ACCEPTANCE-2026-10-30.md)：三模块修复、原始 680 基线、环境和宿主边界。
- [第一次 Windows CI 整改](LOCAL-M3-ACCEPTANCE-2026-10-30-WINDOWS-CI-ADDENDUM.md)：该轮真实输入与历史结果。
- [零设备号最终整改报告](LOCAL-M3-ACCEPTANCE-2026-10-30-WINDOWS-CI-V2-ADDENDUM.md)：前一轮解释的纠正、红绿、最终本地门禁及非作者复核。
- [本次发布证据包](LOCAL-M3-ACCEPTANCE-2026-10-31-DELIVERY.evidence.jsonl)：19 条逐字节原始文本记录，包含两份完整成功 CI 日志、运行状态、正式交接、正常提交/推送记录、238 文件的提交树校验，以及最终 staged diff。每行保存路径、SHA-256、字节数和 UTF-8 原文。
- [本次证据清单](LOCAL-M3-ACCEPTANCE-2026-10-31-DELIVERY.manifest.json)：完整行清单和包摘要。证据包 SHA-256：`0c5f872f8987b8a2b6eaa437023b4a4f9d9b4129950816f8fd64ad9815acc3f6`。

此前失败和成功日志没有被改写。草稿、临时测试数据库、模型凭据及运行目录不属于正式交付源文件；原始本地副本继续保留在数据盘。本批没有真实模型/付费调用，没有改写用户既有 ZCode/DSH 配置，也没有安装或升级全局依赖。

## 真实宿主结果与未完成项

最新代码的 Linux ZCode CLI 独立 fixture 已执行 15 条公开生成/安装/发现/诊断命令，实际退出值全部符合预期。返回 59 个项目技能和 1 个系统技能；canonical 与 alias 可分别完整读取。原始 totalDiscovered=119 是候选数，不是独立技能数量。损坏配置 doctor 按预期 exit 1。

CLI 包是非官方 zcode-app-cli 3.16.3-39，公开 CLI 版本 0.17.0。Hook 状态仍为 config_project_hooks_pending_trust，commands list 为 0。不能据此声明真实工具拦截、slash 执行、Windows Desktop 或 DSH 插件激活已经通过。

仍待真实宿主条件验证：Windows/ZCode/DSH 的技能发现与调用；DSH Profile 实际注册、Guard/Skills 服务激活、apply 抛错但进程 exit 0 的行为；ZCode 工具调度、.git 保护、Hook 启动失败/超时、多 Hook updatedInput 冲突，以及信任与回滚后的行为。未来如必须通过模型触发工具，应先由主协调 Agent 决定条件和预算，本批没有这项授权。

## 新发现的独立审核分支

本次 fetch 发现 `audit/local-m3-windows-20261030`，实际 SHA `f4d1bd3cdff5f5fa4588038f67b41d627775fb81`。它与本开发分支的共同基线为 `680b2f19b2dbef8831e3be1fd996203589b5c41d`；在证据归档前，两侧各有 3 个独立提交，涉及重叠模块。该分支的源码及证据尚未在本批独立审查，也没有被整合、覆盖或强推。主协调 Agent 应分别审核两侧的输入、实现与证据，再决定整合方案，不应混用两条分支的测试结论。

对代码提交 408ededd 的状态为 IMPLEMENTATION_COMPLETE、LOCAL_VALIDATION_COMPLETE、PUSH_COMPLETE、REMOTE_CI_COMPLETE；HOST_ACCEPTANCE_COMPLETE 未满足，PR 尚未合并。主协调 Agent 负责最终独立验收及合并决定。本次归档提交的推送和 CI 状态以交接消息中的新 SHA 与实际 Actions 为准。

本次文档归档执行 `npm run check`，exit 0，115 modules，耗时 7.578 秒；其原始日志和 metadata 也收入本包。每条 JSONL 内容均与对应原始文件逐字节核对，并验证长度及 SHA-256。代码和测试字节未变，因此没有重复运行本地全集；新提交仍会执行原有完整远端 CI。
