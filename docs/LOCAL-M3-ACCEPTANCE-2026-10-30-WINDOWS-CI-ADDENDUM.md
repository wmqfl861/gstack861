# M3 Windows CI 整改补充记录 — 2026-10-30

本记录接续 [初次本地验收报告](LOCAL-M3-ACCEPTANCE-2026-10-30.md)。初次修复提交为 `3b4ee5b989781b8dd207e238c3ca02d121623411`：Linux 本地完整验证通过，推送后的 Windows CI 暴露了必须继续修复的问题。原报告、原输入清单和原始证据包保留为该次交付的历史快照，不能作为本次后续修改的输入清单。

## 真实失败与影响

两个实际 GitHub Actions run 均绑定初次修复提交：

| Run | 触发方式 | Ubuntu offline-contracts | Windows offline-contracts | render-upstream |
| --- | --- | --- | --- | --- |
| [41085856284](https://github.com/wmqfl861/gstack861/actions/runs/41085856284) | push | success | failure | success |
| [41085869998](https://github.com/wmqfl861/gstack861/actions/runs/41085869998) | pull_request | success | failure | success |

两个 Windows runner 均使用 Node **22.16.0**，实际统计均为 **1150 tests / 81 suites / 1105 pass / 24 fail / 21 skipped**。不能套用 Linux 的 1151 项计数。其中 1 项是 DSH 测试的 URL 预期构造错误，23 项为 ZCode 的文件身份/版本比较引起的生命周期与回滚失败。它们没有被删除、跳过或放宽断言。

完整日志分别保留为 `publication/ci-41085856284-failed.log`（SHA-256 `cddf54208e2f6b2aa5cdc06d66f920226f130debf9c1eb264b9ca3226a0a5c89`）和 `publication/ci-41085869998-failed.log`（`7c11c8e4a54edaa652f16b464e5e33e09648ea89cde4f6c4abd6ccf1bb317bad`）。它们是实际 Windows runner 的离线测试输出，不是本地 Windows 或真实 ZCode/DSH 宿主验收。

## DSH 测试 URL 修正

原有测试用 `new URL('file://' + f.adapter)` 生成预期 URL。在 Windows 路径以及含空格、`#`、`%` 的 POSIX 路径上，这不能表达与生产 `pathToFileURL` 相同的文件身份。用含这些字符及中文的独立 TMP 执行原测试，得到 **11 项中 10 通过、1 失败**，精确失败在同一断言。

只修改 `test/dsh-profile.test.mjs`，将预期改为 `pathToFileURL(f.adapter).href`；没有修改 DSH 生产代码。新增一个真实 shim 导入测试，将实际 adapter、policy、JSON 模块按原字节复制到特殊路径，并验证生成 shim 的 `apply` 函数身份、name/inject、URL 路径往返及源文件 SHA-256。普通 TMP 和特殊 TMP 下均为 **18/18**，两次运行覆盖同一组测试，不计成 36 项独立测试。

## ZCode 路径与文件句柄身份

失败集中在 `readExisting()` 将路径 `lstat` 与文件句柄 `fstat` 的完整版本直接比较，以及暂存文件用句柄身份登记、清理时改用路径身份比较。这会拒绝合法配置；普通写入错误后的临时文件清理也会因身份来源差异失效。

已检查 [Node v22.16.0 的 libuv Windows 实现](https://github.com/nodejs/node/blob/v22.16.0/deps/uv/src/win/fs.c)：路径快查询 `GetFileInformationByName(FileStatBasicByNameInfo)` 取得 64 位 `VolumeSerialNumber`，句柄查询经 `FileFsVolumeInformation` 取得 32 位 serial；两者最后都赋给 `st_dev`。`ino`、size、mode、mtime/ctime 走相同的赋值逻辑。源码原件 SHA-256 为 `744ca3739218390ce70c38d71e5d3f3c81b7bfb78bc5f16e5353da1113333fc9`，节选和定位保留在证据中。静态源解释与实际 runner 诊断分别记录，不冒称本机执行了 Windows。

本次修复只规范化 **Windows 的路径↔句柄绑定**：允许完全相同的 dev，或句柄 dev 与路径 dev 的低 32 位相同；仍严格检查 inode 和所有其他版本字段。路径自身的 CAS、目录身份及暂存文件身份继续保存完整 dev，不能全局截断高位。读取前后仍校验完整路径快照和完整句柄快照、原始字节及文件类型/链接条件。

句柄 API 只提供 32 位 serial，不能提供通用的 64 位卷身份认证；完整路径身份及读前/读后检查仍然必要。本修复没有解决不遵守协作锁的恶意并发换路窗口，也不将该兼容比较当作操作系统沙箱。

暂存文件在实际 open 后检查路径与句柄确实绑定，再登记完整路径身份。绑定失败仍关闭 fd；尚未证明归属的文件不能进入删除授权。保留两文件发布、收据所有权、逐项最终检查和比较后回滚的原守卫。

新增回归从真实文件 metadata 派生 64/32 位来源差异，明确标记为故障注入，覆盖完整生命周期、部分写入清理、inode/dev/时间/size/mode 不匹配拒绝、路径 dev 高位变化的 CAS 拒绝以及暂存路径被外部 inode 替换。原断言和期限保持不变；实际 runner 诊断在注入前输出真实平台的路径和句柄字段。

## 本地验证与输入

<!-- WINDOWS-FINAL-LOCAL:BEGIN -->
本次最终本地运行仍为 Ubuntu / Node 24.21.0 / UID 1000，`umask 0022` 与数据盘短 TMP，完整执行后才记录以下结果。

| 命令 | 结果 | exit | 秒 |
| --- | --- | --- | --- |
| `npm test` | 1157 tests / 81 suites；1156 pass / 0 fail / 1 skip | 0 | 284.075 |
| `npm run check` | 115 modules；3 full commit pins；历史 evidence stale 警告保留 | 0 | 38.409 |
| `npm run verify-offline` | 9/9 步；无模型调用 | 0 | 28.415 |
| `npm run doctor` | 退出 0；历史宿主声明不作为本轮实测 | 0 | 2.046 |
| `node bin/gstack861.mjs inventory --upstream upstream/gstack` | 固定上游 57 个源码技能 | 0 | 2.442 |

相对初始 680 基线累计新增 **52 项测试**；本轮在初次修复上新增 6 项。唯一 Linux skip 仍为既有 Windows 8.3 路径测试。原五条用户指定 npm 转发命令的历史通过记录保留；本轮代码变更后重新运行完整全集，未把旧结果套用到新输入。

最终专项 ZCode **38/38**，DSH 普通和特殊 TMP 均 **18/18**。新增四项卷标识注入测试修前 1 通过、3 失败，修后 4/4；其中高位 CAS 的旧版红例在 plan 阶段被兼容错误阻断，不能解释为旧版 CAS 绕过。新增暂存路径外部替换测试单独验证拒绝和关闭 fd。

最终源码上再次执行真实 ZCode Linux CLI 的 15 条生成/安装/发现/诊断命令（`zcode-native-linux-discovery-v3`）。运行前后源 SHA 一致；59 个项目技能加 1 个系统技能、两个独立且未截断的 inspect、Hook pending trust、损坏配置 doctor exit 1 的结果保持不变。仍未执行宿主工具调用。

非作者复核记录 `evidence/windows-ci-independent-review.json`，SHA-256 `f1a7cc614713fe9f8396e631bce1bcfe6446e98de004ebe2ac4573a6bcbee55a`，结论 `PASS_WITH_DOCUMENTED_BOUNDARIES`。

最终冻结输入见 [Windows CI 整改输入清单](LOCAL-M3-ACCEPTANCE-2026-10-30-WINDOWS-CI.inputs.json)，补充原始日志及代码证据见 [补充证据包](LOCAL-M3-ACCEPTANCE-2026-10-30-WINDOWS-CI.evidence.jsonl)。两者使用新文件，不覆盖初次报告的输入和失败记录。
<!-- WINDOWS-FINAL-LOCAL:END -->

后续提交仍在 `work/m3-command-aliases-20261029` 正常提交并推送，PR #3 保持打开。没有修改 main、CI 工作流、全局依赖、原测试期限或原安全权限。

本次源输入使用独立的新版本清单，原输入清单不覆盖；CI 失败日志、新红绿回归及非作者复核使用新的补充证据包。推送后的 CI 结论必须以该次提交的实际 Actions 为准，不能提前写成 success。

## 验收边界

原生 Windows **本地宿主**验收仍因本机会话是 Linux 而阻塞。远端 Windows runner 可以验证 Node 文件系统和离线集成测试，不能证明 ZCode/DSH 宿主已实际加载插件或执行 Hook。DSH 未发现本地安装；ZCode Linux CLI 仅完成技能发现、读取和配置诊断，Hook 为 pending trust。工具调度、超时、updatedInput 冲突及真实宿主失败处理均保持未完成状态。

本轮没有调用真实或付费模型，没有改写用户既有宿主配置，也没有合并 PR。由主协调 Agent 对本次修复及 Windows CI 证据作最终审核，随后安排实际宿主验收。
