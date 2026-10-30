# M3 Windows CI 零设备号整改与最终本地验证 — 2026-10-30

本轮修复了真实 Windows CI 暴露的 ZCode 路径设备号为零兼容问题，并完成冻结源码上的本地全量验证与非作者复核。**本报告生成时尚未推送本轮提交，其远端 Windows CI 仍待实际执行；不提前声明 CI 或完整宿主验收通过。** 两轮此前失败、原始基线红例及所有旧报告保留。

本记录接续 [首次验收报告](LOCAL-M3-ACCEPTANCE-2026-10-30.md) 与 [第一轮 Windows 整改报告](LOCAL-M3-ACCEPTANCE-2026-10-30-WINDOWS-CI-ADDENDUM.md)。最初接手基线是 `680b2f19b2dbef8831e3be1fd996203589b5c41d`，首次修复是 `3b4ee5b989781b8dd207e238c3ca02d121623411`，本轮修改基于 `9acc27885d5cbe5e379873dace26b4700e05d937`。开发分支仍为 `work/m3-command-aliases-20261029`；[PR #3](https://github.com/wmqfl861/gstack861/pull/3) 的目标分支是 `audit/full-review-20261029`。本批不推送 main、不强推、不合并 PR。

## A. 环境与输入身份

本地环境仍为 Ubuntu 24.04.1 / Linux 6.8.0-147、Node 24.21.0、npm 12.2.0、Git 2.43.0、UID/GID 1000；工作树位于数据盘 `/mnt/d/codex-workspace/gstack861-m3-acceptance-20261030/feature`，`/mnt/d` 是 `/dev/vdb2`，约 50 GiB 可用。项目、日志、构建和临时测试内容均使用数据盘。测试使用 `umask 0022` 及 `/mnt/d/codex-workspace/g3tmp-1030`。没有重复请求已确认的 Windows 条件；用户已选择先完成当前 Linux 环境验证并记录 Windows 阻塞。

当前本地无原生 Windows 执行入口，未发现真实 DSH 安装。已有非官方 `zcode-app-cli` 包为 `3.16.3-39`，公开 CLI 报告 `0.17.0`，包内 Desktop 元数据为 `3.16.3`；它不是 Windows 官方 Desktop 的验收证据。远端失败证据来自 GitHub `windows-latest` 的实际 Node 22.16.0 进程。

本轮代码修改仅为 `src/zcode-profile.mjs` 与 `test/zcode-profile.test.mjs`；没有修改共享 policy、install、CLI、DSH/alias 生产代码、CI 工作流、期限或安全权限。固定上游仍为 `5755601dac5d35ebd7dde181fdefe52a023c73d9`。

| 冻结输入 | SHA-256 |
| --- | --- |
| `src/zcode-profile.mjs` | `a05472f12b82b2124cd023c5fd817de7368ee295c30187dcc33e93fe4fdf52e2` |
| `test/zcode-profile.test.mjs` | `f64cbeb3f20171ea28f7df5132e108ae1854e7770fa5144b73d09f4a8a0d388b` |
| `test/host-setup-cli.test.mjs`（未变） | `cfd9b81b1f49d4f31752e803f035a9f6b6d40b9ae4d8dccb166b2f0bb74a0a73` |
| [完整输入清单](LOCAL-M3-ACCEPTANCE-2026-10-30-WINDOWS-CI-V2.inputs.json) | `65a9d879162169555fb7dc3fa6de37c2d8f183109e5f4e4ded31f9c6e51b7a89` |

完整门禁前冻结了 235 个已跟踪普通文件；完成后逐项核对，字节没有变化。本报告与新输入/证据文件在其后生成，提交树还需在正常提交后逐项校验。旧报告与旧日志没有被重写。

## B. 真实 Windows 红例及前一轮解释的纠正

两条实际 Actions 均对应 `9acc27885d5cbe5e379873dace26b4700e05d937`：

| Run | 触发 | Ubuntu offline-contracts | Windows offline-contracts | render-upstream |
| --- | --- | --- | --- | --- |
| [41090185937](https://github.com/wmqfl861/gstack861/actions/runs/41090185937) | push | success | failure | success |
| [41090196768](https://github.com/wmqfl861/gstack861/actions/runs/41090196768) | pull_request | success | failure | success |

两边 Windows 均为 **1156 tests / 81 suites / 1108 pass / 27 fail / 21 skipped，exit 1**。27 项失败为 `host-setup-cli` 3 项、`zcode-profile` 24 项；原 23 项 ZCode 失败仍存在，新增 3 个注入测试和 1 个暂存替换夹具也失败。21 项 skip 的名称与第一轮完全一致，包含原有 POSIX/shell 条件及 alias 大小写敏感 fixture；没有新增 ZCode skip。后续 verify-offline、doctor、inventory 因失败被跳过，不计为通过。

新增真实诊断显示 `lstat.dev=0`，`fstat.dev=782947067`，其余已记录 inode、size、mtimeNs、ctimeNs、mode、nlink 相同。**此前仅处理高低位宽差异的方案未修复实际 runner；位宽解释不足，路径 API 为何返回零的底层原因尚未证实。** 前一轮 Linux 通过和静态复核是各自输入的历史事实，不能替代真实 Windows 结果。

两个未截断失败日志及 metadata 收入新证据包：push 日志 SHA-256 `16bba56794d073c9824ba0c2b5c577f88d62beb21d45e87e0116c95e7408a868`；PR 日志 `4b9ee9454eb2e9b10c3ab61e720df03d0acdc52263dc395e8ccc5b66f4b57db8`。逐项审计记录 `evidence/windows-ci-second-failure-summary.json` 的 SHA-256 为 `bc4f3e209df545f00e7f814b57908638c51701aba2c30ad291e7afae12065c87`。

DSH 的结果已不同：两个 run 中 **12 项 profile + 6 项 skills 全部通过**，包括原文件 URL 断言、特殊字符路径真实 shim 导入和两个 adapter 的离线契约。上一轮修正只恢复正确的 `pathToFileURL` 预期，并增加回归，没有弱化原断言。这仍是 Windows 离线证据，未启动 DSH 宿主。

## C. 最小修复与新增回归

Windows 路径设备号为零时，`bindDescriptor()` 独立再次打开同一路径；第二句柄必须与第一个句柄的完整设备号、inode、版本一致，再重新检查路径。零值不会成为任意设备号匹配的通配符。其他设备号不符仍拒绝，已有非零 64/32 位兼容仅用于跨 API 绑定。

`readExisting()` 保留路径和句柄各自完整版本，原始字节、文件类型、单链接、大小上限、读前/读后检查及跨 plan 的 CAS 继续有效。即使之后两个句柄一起返回另一个设备号，保存的 descriptorVersion 仍使旧计划失效。

零设备号目录与锁额外保存、复验句柄 dev/ino；目录内容变化不会被误当作目录身份变化。暂存文件保存路径和句柄身份，发布读回和清理均核对完整身份。未能证明归属的外部文件、锁或暂存路径会保留。句柄均在 finally 中关闭；测试控制没有进入生产接口。

旧注入夹具从两个不一致的原生设备号分别推导预期，导致它在 Windows 自身失配；现改为两种来源共享一个明确的测试卷号。所有文件操作仍使用临时真实文件，注入只作用于测试元数据，不能冒充 Windows 执行。

真实 Windows 还拒绝了旧夹具直接覆盖已打开文件的 rename，返回 EPERM。新夹具先将已打开原文件移动到未占用名称，再以 wx 在原路径创建外部文件，继续严格要求拒绝、关闭 fd、保留两份外部可见字节。没有扩大允许的错误集合；是否在 Windows 实际通过由新 CI 决定。

新增 7 项回归为：零设备号完整安装/幂等/卸载；部分暂存写入的清理；第二句柄同 inode/字节但不同设备号拒绝且两个 fd 关闭；计划后两个文件句柄一起变更设备号的 CAS 拒绝；目录设备身份变更时零写入；锁身份变更时拒绝并保留锁；暂存清理对象身份变更时保留文件并释放自有锁。最后五项分别触及对应守卫，没有依赖无关前置拒绝。

## D. 红绿、完整验证及独立复核

相同测试字节 `98513c2e9e8658a9a0b46c41c57657c28d6fe79950eee2b9a2e6d4520d23796a` 在原 c8 源码上 **2 项全失败，exit 1 / 1.185 秒**，在 a054 修复源码上 **2 项全通过，exit 0 / 1.308 秒**。源码、测试、JSON 依赖及最小复现用 package.json 的红例快照保存在 `tmp/zcode-zero-device-red-snapshot/` 并收入证据包；其中 package.json 只声明模块类型，不冒充原仓库文件。部分写入用例的原红在真正写入之前被兼容判断阻断，不把它称为独立清理漏洞。

| 最终命令 / 记录 | 实际结果 | exit | 秒 |
| --- | --- | --- | --- |
| `node --test test/zcode-profile.test.mjs test/host-setup-cli.test.mjs` / `zcode-zero-device-focused` | 45 tests：38 库测试 + 7 CLI；45 pass / 0 fail / 0 skip | 0 | 18.760 |
| `npm test` / `windows-v2-final-full-tests` | **1164 tests / 81 suites / 1163 pass / 0 fail / 1 skip** | 0 | 228.950 |
| `npm run check` / `windows-v2-final-check` | 115 modules、3 full commit pins；历史 HEAD evidence stale 警告保留 | 0 | 21.708 |
| `npm run verify-offline` / `windows-v2-final-verify-offline` | 9/9 步；含预期缺凭据 BLOCKED 检查；0 模型调用 | 0 | 16.039 |
| `npm run doctor` / `windows-v2-final-doctor` | 完整成功输出归档；不将历史宿主声明当作本次实测 | 0 | 1.204 |
| `node bin/gstack861.mjs inventory --upstream upstream/gstack` / `windows-v2-final-inventory` | 固定上游 57 个源码技能 | 0 | 1.338 |

唯一 Linux skip 仍是既有 Windows 8.3 路径测试。相对原 680 基线累计新增 59 项测试，本轮新增 7 项。用户最初指定的五条 `npm test -- test/<module>` 已在首次冻结输入逐条执行；npm 脚本含全集通配符，不能误报成五个独立套件。本轮执行一次最终完整全集及真正定向的 45 项，不重复把历史输入计作当前通过。原 umask 0002、长 TMP 和早期 fixture 失败继续保留；没有新增这些条件的通过声明。

实际完整门禁命令都使用任务根目录下的 recorder，例如：

```bash
umask 0022
export GSTACK_ACCEPTANCE_TMP=/mnt/d/codex-workspace/g3tmp-1030
python3 record.py windows-v2-final-full-tests ./feature npm test
python3 record.py windows-v2-final-check ./feature npm run check
python3 record.py windows-v2-final-verify-offline ./feature npm run verify-offline
python3 record.py windows-v2-final-doctor ./feature npm run doctor
python3 record.py windows-v2-final-inventory ./feature node bin/gstack861.mjs inventory --upstream upstream/gstack
```

非作者复核记录为 `evidence/windows-zero-device-independent-review.json`，SHA-256 `f8db579abc0c01cdee79e72f1857eea72d5123229cb1e603467c421a78a7d37c`，结论 `PASS_WITH_DOCUMENTED_BOUNDARIES`，本轮范围内没有阻塞发现。作者验证记录 `evidence/zcode-zero-device-validation.json` 的 SHA-256 为 `5695809261dbe6ee3eeba1dff6a842f218b85d3544c29ff096590be2d8e89a35`。两份记录均保留真实 Windows 新 CI 待验证条件；主协调 Agent 的最终验收另行进行。

## E. 最新源码上的真实 Linux CLI

a054 源码上重新执行了 15 条公开生成/安装/发现/诊断命令，`zcode-native-linux-discovery-v4` **exit 0 / 116.190 秒**。每条命令的实际返回值与预期一致，损坏配置 doctor 的预期值为 exit 1；运行前后六个相关源码摘要一致。

实际返回 59 个项目技能与 1 个系统技能，canonical/alias 分别完整读取且未截断；原始 totalDiscovered=119 是发现候选数，不作为 119 个独立技能。`commands list` 仍为 0，未证明 slash 调用。配置被加载，Hook 仍报 `config_project_hooks_pending_trust`；损坏 JSON 报 `config_file_invalid`。观察记录为 `evidence/zcode-native-linux-observations-v4.json`，摘要汇总为 `windows-v2-final-linux-host-summary.json`。

使用独立数据盘 Git fixture，网络命名空间无外部网络，宿主进程降为 UID/GID 1000；provider/credentials 为空，已有用户配置未修改，没有授予正式工作区信任或调用模型。没有把这些结果称作 Hook 实际拦截、Windows Desktop 或 DSH 的宿主验证。

## F. 证据、发布与剩余事项

新证据包 [WINDOWS-CI-V2.evidence.jsonl](LOCAL-M3-ACCEPTANCE-2026-10-30-WINDOWS-CI-V2.evidence.jsonl) 保存本轮完整失败/成功日志、命令 metadata、输入快照、原始红例源码、宿主公开输出和非作者复核。每行有原路径、UTF-8 原文字节数及 SHA-256；可逐行重算摘要。此前两份证据包的 285 条原始记录均核对了磁盘字节，保持不变。构建产物、临时数据库、实际凭据及用户配置不进入提交。

本报告提交前的真实状态：**IMPLEMENTATION_COMPLETE；LOCAL_VALIDATION_COMPLETE；本轮 PUSH 与 REMOTE_CI 待发布核验；HOST_ACCEPTANCE_COMPLETE 未满足。** 完整提交 SHA、远端分支指向、该 SHA 的 Actions 终态及提交树字节核验必须在发布后取得，最终交接消息提供实际链接；不能用上一轮失败 run 或本地通过代替它们。可从 [PR #3 Checks](https://github.com/wmqfl861/gstack861/pull/3/checks) 查看最新提交。

必须保留的边界与待办：

- 原生 Windows 本地宿主和真实 DSH Profile 加载仍被环境阻塞；Windows CI 仅证明对应提交的 Node/文件系统离线测试。
- DSH 插件实际注册、Guard/Skills 激活、apply 抛错但进程仍 exit 0 的行为、合法与越界真实工具调度仍待宿主验收。
- ZCode 真实工具调度、`.git` 拦截、Hook 启动失败/超时、多个 Hook 的 updatedInput 冲突、信任和回滚后的调度，以及 alias 在 Windows/DSH 的宿主发现与调用仍未验证。
- 新的零设备号目录验证需要成功打开目录取得句柄身份；无法取得时拒绝。该兼容层不解决不遵守协作锁的同 UID 恶意竞争，也不构成 OS 沙箱。双文件发布不是崩溃原子的，持久 I/O 错误或无法证明归属的遗留锁/文件需要检查。
- 没有调用真实供应商、付费模型或使用 API key 发起请求；没有安装/升级全局依赖。若未来必须调用模型触发工具，由主协调 Agent 另行决定条件与预算；本批不推断授权。
- 主协调 Agent 负责审核本轮代码、证据和后续 Windows/DSH 实机方案，以及是否合并 PR #3。本批没有扩大到其他项目或平台大规模开发。
