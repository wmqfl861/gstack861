# M3 本地验收、修复与交付记录 — 2026-10-30

本批完成三个模块的 Linux 离线反例、修复、回归及非作者交叉复核，并使用已安装的 ZCode Linux CLI 检查真实技能发现和配置诊断。**没有完成原生 Windows 实机验收、DSH 宿主加载或 ZCode 工具调度安全验收。** 用户已明确选择“先完成当前环境验证并记录 Windows 阻塞”。本文不把离线 fixture、静态源码审查、宿主 `doctor` 或 CI 测试等同于真实宿主端到端验收。

## A. 环境与执行边界

| 项目 | 实际环境 |
| --- | --- |
| 操作系统 | Ubuntu 24.04.1 LTS，Linux 6.8.0-147-generic，x86_64 |
| 原生 Windows | 当前会话无 Windows 执行入口；没有使用 WSL 冒充 Windows |
| 用户 | `ubuntu`，UID/GID 1000；产品测试由普通用户执行 |
| 数据盘 | `/mnt/d`，`/dev/vdb2`，ext4；验收期间约 50 GiB 可用 |
| 工作树 | `/mnt/d/codex-workspace/gstack861-m3-acceptance-20261030/feature` |
| 固定基线工作树 | 同一任务目录下 `baseline`，detached HEAD |
| 临时目录 | `/mnt/d/codex-workspace/g3tmp-1030`；宿主隔离 fixture 在任务目录 `tmp/` |
| Node / npm / Git | `v24.21.0` / `12.2.0` / `2.43.0` |
| ZCode | 已安装的非官方 `zcode-app-cli` npm 包 `3.16.3-39`；实际 CLI 报告 `0.17.0`，包内 Desktop runtime 元数据为 `3.16.3`。不是 Windows 官方 Desktop 实测 |
| DSH | PATH 和有界目录检查未发现安装；没有可报告的实际宿主版本 |

没有安装或升级全局依赖，没有调用真实或付费模型，没有使用 API key 发起请求。真实 ZCode CLI 仅运行公开的帮助、技能列表/读取和 `doctor` 命令，置于没有外部网络接口的网络命名空间；`sudo` 仅用于建立该命名空间，随即用 `setpriv` 降回 UID/GID 1000。用户 HOME 未重定向；设置、provider、空 credentials、session、storage 和诊断路径均用公开配置点指向独立数据盘 fixture。未修改用户既有 ZCode/DSH 配置，也未授予正式工作区 Hook 信任。

初始 shell 的 `umask 0002` 使部分既有 fixture 生成可被组写的 policy，触发既有严格权限拒绝；较长 TMP 路径还触发既有提示长度断言。最终门禁使用 `umask 0022` 和较短的数据盘 TMP 路径。没有放宽权限、断言或超时，也没有修改这些无关 fixture 来消除失败。`0002` 和长路径下的完整测试兼容性仍不是本批通过声明。

## B. 代码基线与工作区

- 开发分支：`work/m3-command-aliases-20261029`。
- PR：[wmqfl861/gstack861#3](https://github.com/wmqfl861/gstack861/pull/3)，目标为 `audit/full-review-20261029`，不是 `main`。
- 接手时 PR head 和远端开发分支均为 `680b2f19b2dbef8831e3be1fd996203589b5c41d`。
- 接手时远端 `main` 为 `15c32ae`，审核基线分支为 `4264717`；各完整引用保存在发布核验记录中。
- `upstream/gstack` 固定为 `5755601dac5d35ebd7dde181fdefe52a023c73d9`；固定源码技能数为 **57**，root router 另计。
- 使用现有 clone 的独立 worktree；开始时工作树干净、无 stash。保留其他分支，不使用 reset、clean、强推，也不合并 PR。

实际修改的生产代码仅为 `src/aliases.mjs`、`src/dsh-profile.mjs`、`src/zcode-profile.mjs`。测试修改为 `test/aliases.test.mjs`、`test/dsh-profile.test.mjs`、`test/zcode-profile.test.mjs`、`test/host-setup-cli.test.mjs`。公共 policy、install、stage、JSON 工具、CLI、宿主 adapter/overlay、上游 submodule 和 CI 工作流保持原实现。

最终输入清单见 [输入 SHA-256 清单](LOCAL-M3-ACCEPTANCE-2026-10-30.inputs.json)。先冻结 229 个已跟踪文件，再在最终完整运行前记录 v2：唯一差异是新测试的 POSIX mode 断言按平台执行，生产代码没有变化。提交树校验以清单中每个文件的字节摘要为准，不能把早期候选的测试结果套用到后续源代码。

## C. 三大模块结果

### C1. 命令别名

修复了五类可复现问题：

| 编号 / 级别 | 原问题与影响 | 修复 |
| --- | --- | --- |
| AL1 / P1 | 仅做词法路径包含判断，输出祖先 symlink 可以让生成路径物理落入 canonical staging | 写入前解析已有路径前缀及源 realpath，拒绝物理重叠 |
| AL2 / P2 | 整文件 UTF-8 解码和重编码改写 CRLF 或非 UTF-8 正文字节 | 用 Buffer 切片仅替换 frontmatter 中的 name 值 |
| AL3 / P2 | commit/files 类型、保留文件名、大小写或文件/目录碰撞可生成安装器拒收的产物 | 生成前校验 manifest、摘要和完整辅助文件路径集合 |
| AL4 / P1 | 写入失败时递归删除调用者原有 output 目录 | 只清理本次已成功创建的 alias 子目录；不删除原有 output |
| AL5 / P2 | 重复、带引号、tag、anchor 或 alias 形式的 YAML name 产生歧义身份 | 接受固定上游使用的简单顶层键格式，拒绝歧义形式；不伪称通用 YAML 解析器 |

原 4 项 alias 测试全部通过，说明其覆盖不足。独立外部反例 6 项在原实现全部失败，修后相同条件全部通过；早期扩展测试修前 15 项中 6 通过、9 失败。非作者复核又发现 AL5 的 tag/anchor 缺口：4 个真实生成案例修前全部违反拒绝断言，补丁后全部通过；对应新测试使计数从 17/18 变为 **18/18**。PyYAML 只用于说明旧输出的歧义，未计作宿主证据。

最终实际 CLI fixture 对 `zcode`、`dsh` 两种 host 标签共运行 28 条命令，覆盖 alias-stage、原始字节/二进制辅助文件、摘要、真实 install registry、重复安装、dry-run、用户文件占用/改写、uninstall 和重复卸载。现有 install/stage 回归 **83/83**。这些 fixture 没有启动 DSH 或执行技能正文。

真实 Linux 宿主检查从固定基线 [CI run 41046662516](https://github.com/wmqfl861/gstack861/actions/runs/41046662516) 下载 `rendered-skills` 和 `render-manifests`，通过真实 stage-render、alias-stage 和 install 链安装到独立 Git 工作区。没有在本地伪设 CI 环境执行上游 renderer。

已安装的 ZCode CLI 实际列出 **59 个项目技能（57 个固定技能 + root router + alias）及 1 个系统内置技能**。`skills inspect` 分别完整读取 `open-gstack-browser` 和 `connect-chrome`，名称、路径独立，没有发现身份冲突。`commands list` 返回 **0**，因此这里只证明技能发现/读取，不证明斜杠命令调用、浏览器启动或模型消费；DSH 和 Windows 中的独立发现仍未验证。

### C2. DSH Profile

原实现声明了 `gstack861-skills` 本地依赖，却没有生成对应 package/index 文件。补齐该插件 shim，并绑定仓库中真实 `dsh-skills.mjs`；Guard shim 仍使用显式提供的 Guard adapter。配置补丁顺序为 `system-prompt → tools → gstack861-guard → gstack861-skills`；Skills adapter 的 `systemPrompt` 依赖明确保留。

将仅检查 JSON 表面的策略验证改为调用公共 **`loadPolicy`**，保留策略在 workspace 外的约束、权限验证和路径正规化；输入、输出、adapter、policy 和 skills 根的祖先目录在生成前拒绝链接。没有在生成时执行调用方提供的 adapter，也没有自动安装依赖。

| 编号 / 级别 | 已复现的问题 |
| --- | --- |
| DSH-M3-001 / P1 | 缺少实际本地 Skills 插件包，声明与输出不一致 |
| DSH-M3-002 / P2 | profile 生成声称成功，但真实 Guard 的共享 policy 校验会拒绝同一输入 |
| DSH-M3-003 / P2 | workspace/policy 物理包含关系未使用共享正规化结果 |
| DSH-M3-004 / P2 | 只检查叶子，祖先 symlink/junction 可绕过输入与输出检查 |

原定向测试 10/10；新增 profile 测试在原源码上为 11 项中 4 通过、7 失败；修后 profile + skills **17/17**。另有 6 个外部业务反例修前全部失败、修后全部通过。

离线验收用真实 install registry、真实 CLI 生成 8 个 profile 文件并导入两个实际 shim；adapter `apply()` 连接的是明确标注的**离线 service recorder**，不是 Cordis/DSH 宿主。验证了 inject 元数据、Guard admission 的范围内/越界/未知工具/取消情况、损坏 policy、技能摘要篡改及缺少传递依赖时真实 `ERR_MODULE_NOT_FOUND`。该 fixture 不执行文件工具，且其 writeRoots 包含技能目录，不能据此声称部署技能目录已经获得写保护。

真实 `scripts/verify-dsh-skills.mjs` 返回 **exit 2 / BLOCKED**，没有找到 DSH。生成输出继续标记 `scaffolded-not-host-verified`，README 要求确认插件实际注册。**DSH apply 抛错后进程仍 exit 0 的宿主行为没有在本机验证；不能用生成成功或离线 apply 通过替代这项验收。**

### C3. ZCode 配置生命周期

固定基线存在首次安装无法创建 `.zcode` 就尝试加锁、卸载缺少对称路径校验、只比较正规化 JSON 而忽略原始字节变化、浅层冻结可改写计划、外部 existingConfig 绕过磁盘错误、Hook 身份忽略额外 metadata、空卸载产生写入/失败等问题。原测试有 5 个 fixture 漏传 workspace；补齐 fixture 参数，保留原有断言，另建真正触及这些行为的独立 Git fixture 反例。

修复后的计划深冻结并绑定内部 WeakMap；CAS 同时检查文件存在性、原始字节、device/inode、size、mtime/ctime 和 mode。两个 planner 及 apply 对称检查 workspace/config 祖先及链接，先验证再创建目录和协作锁。Hook 使用完整规范化对象身份匹配，保留其他 Hook、其他事件及额外 metadata。

采用独立 `.zcode/.gstack861-zcode-config.json` 所有权收据，记录本安装创建的容器字段和完整自有条目。没有向宿主 Hook schema 塞入私有字段。卸载保留原有 `hooks.enabled: true` 和用户配置；干净安装卸载后原 `hooks === undefined` 断言仍成立。收据缺失时采取保守处理；损坏、链接或并发修改时拒绝。多组自有 Hook 身份可分别卸载。

| 证据 | 结果与归属 |
| --- | --- |
| `zcode-baseline-lifecycle-red-v2` → `zcode-fixed-lifecycle-v2` | 原始 680 基线的 11 个有效场景全部失败；相同业务条件修后 11/11 |
| `zcode-baseline-new-regressions` | 早期 22 项测试快照在原源码上 6 通过、16 失败；不是 16 个独立漏洞，其中部分被更早的首次安装问题阻断 |
| `zcode-post-publication-v1-control-red` | 在独立副本重建缺少最后两行校验的相邻候选，证明发布期间 receipt 修改必须再次验证；这是候选对照，不冒称历史 680 反例 |
| `zcode-readback-eio-red` → `zcode-readback-eio-green` | 非作者发现候选在 rename 成功后首次读取 EIO 时漏记 publication，残留 config 并撤回 receipt；在真实文件生命周期中，对 `fs.openSync` 注入一次 EIO；修前 exit 1、修后 exit 0 |
| `zcode-expanded-both-v4` | 最终 26 项库测试 + 7 项 CLI 测试，共 **33/33**，0 跳过；其中一项为既有 DSH CLI 测试 |

回滚修复在 mutation 成功后立即登记 publication，再进行可能失败的读回；回滚前必须证明已发布版本或 staged inode/预期字节仍匹配。额外测试验证遇到外部写入时保留外部字节并报告冲突。真实双进程 READY 屏障测试使两个进程预先持有同一快照，释放屏障后仅一个成功发布，另一个被 CAS/锁拒绝。没有延长原有期限。

最终新增测试中的 POSIX `0600` 精确断言仅在非 Windows 执行；所有平台仍执行整个测试，检查普通文件、非 symlink、单链接及完整生命周期。这是静态平台契约修正，不是声称 Windows 失败后被跳过；POSIX mode 不证明 Windows ACL。Alias 的一个新增大小写文件系统 fixture 仅适用于大小写敏感文件系统；独立的 manifest-only 碰撞拒绝测试覆盖所有平台。

真实 ZCode Linux CLI 的独立工作区已验证预览无 config 写入、apply 后项目配置被读取、uninstall 后配置可读取，以及损坏 JSON 时 `doctor` 返回 exit 1 / `config_file_invalid`。安装后 `doctor` 明确返回 `config_project_hooks_pending_trust`：**配置读入但 Hook 未激活**。没有调用模型以触发工具，也没有把直接调用我们 adapter 的结果称为宿主拦截。合法/越界路径实际工具执行、`.git` 拦截、启动失败、超时、多个 Hook 的 updatedInput 冲突及信任/回滚后的实际调度仍未验证。

## D. 独立安全审核与剩余边界

Alias 作者与 DSH 作者相互交叉复核；ZCode 由 DSH 作者作非作者复核。三个审阅均直接阅读最终源文件、测试、反例和原始日志，而不是仅认可作者的通过声明。使用 codebase-memory 图定位与覆盖检查；图中旧源 metadata 和排除的 test/bin 路径通过当前源码完整读取补足。

审阅范围包括路径遍历、祖先链接/junction、硬链接、物理重叠、用户文件所有权、并发修改、失败回滚、损坏配置、插件缺失、子进程返回码、错误输出和 Windows 路径/权限语义。实际关闭了 AL5 第二种歧义键及 ZCode publication/readback EIO 两个非作者发现。最终范围内未发现剩余阻断；这不等于总体架构或主协调 Agent 已验收。

独立记录在证据包中的路径：

- `evidence/alias-independent-review.json`，SHA-256 `bec5a149081d52c002641f77450331df234e3a980578ff347c28d65bf8da09d5`。
- `evidence/dsh-independent-review.json`，SHA-256 `b9584d66f7afa934d90c916fc8c10f640efdd0c29dfb4f963cbd79e3f50db385`。
- `evidence/zcode-independent-review.json`，SHA-256 `763bee33d3aafac07d0d683d5f25261053c16352a415bc2a07d1647c5b0e807d`。

明确保留以下边界：

1. 文件操作的祖先检查不是对同 UID 恶意并发替换的操作系统级隔离；协作锁不能围栏不遵守锁的 writer 在最后 rename 窗口写入。
2. config/receipt 两文件更新可在普通错误时比较后回滚，但不具备进程崩溃原子性；持久 I/O 错误、遗留锁或外部冲突可能需要检查。收据摘要检测漂移，不提供对恶意任意写入者的密码学授权。
3. DSH profile 的依赖存在性、真实服务注册及 Guard fail-closed 必须由实际宿主验证，exit 0 不足以证明成功。
4. ZCode 配置读取、技能发现和我们的 deny 返回值都不证明宿主一定拦截；Hook 超时与 updatedInput 合并行为仍为未完成项。
5. 原生 Windows 的 junction、ACL、编码和宿主安全需要实机验收。远端 Windows CI 的离线测试即使通过，也不能替代这一项。

## E. 完整测试统计与原始失败

执行器 `record.py` 为每条命令保存完整 stdout/stderr、argv、cwd、UID、平台、时间、实际退出码和日志 SHA-256，数据均落在数据盘。最终运行使用 `umask 0022`，`TMPDIR/TMP/TEMP=/mnt/d/codex-workspace/g3tmp-1030`，模型开关为 0，并去除已知模型凭据环境变量。

```bash
umask 0022
export GSTACK_ACCEPTANCE_TMP=/mnt/d/codex-workspace/g3tmp-1030
python3 record.py final-full-tests ./feature npm test
python3 record.py final-check ./feature npm run check
python3 record.py final-verify-offline ./feature npm run verify-offline
python3 record.py final-doctor ./feature npm run doctor
python3 record.py final-inventory ./feature node bin/gstack861.mjs inventory --upstream upstream/gstack
```

以上 `final-full-tests/check/verify-offline/doctor/inventory` 记录属于 v1 输入快照；生产代码与 v2 相同。最终 v2 的全量门禁是下表五条 `final-requested-*` 记录，不能仅凭文件名前缀 `final` 混淆运行输入。

`npm test` 实际脚本为 `node --test test/*.test.mjs`。用户要求的五条 `npm test -- test/<module>.test.mjs` 仍逐条实际执行；每条都包含完整通配符集合，不能称为五个独立专项套件。真正定向测试使用 `node --test 文件...`，68 项选定文件测试是 1151 项全集的一部分。

<!-- FINAL-RESULTS:BEGIN -->
| 记录 / 输入 | 实际命令 | Tests / pass / fail / skip | exit | 秒 |
| --- | --- | --- | --- | --- |
| `final-check` / v1 | `npm run check` | 见下文专项输出 | 0 | 9.405 |
| `final-full-tests` / v1 | `npm test` | 1151/1150/0/1 | 0 | 81.403 |
| `final-verify-offline` / v1 | `npm run verify-offline` | 见下文专项输出 | 0 | 5.042 |
| `final-doctor` / v1 | `npm run doctor` | 见下文专项输出 | 0 | 0.663 |
| `final-inventory` / v1 | `node bin/gstack861.mjs inventory --upstream upstream/gstack` | 见下文专项输出 | 0 | 1.115 |
| `final-requested-aliases` / v2 | `npm test -- test/aliases.test.mjs` | 1151/1150/0/1 | 0 | 78.350 |
| `final-requested-dsh-profile` / v2 | `npm test -- test/dsh-profile.test.mjs` | 1151/1150/0/1 | 0 | 83.492 |
| `final-requested-dsh-skills` / v2 | `npm test -- test/dsh-skills.test.mjs` | 1151/1150/0/1 | 0 | 82.737 |
| `final-requested-zcode-profile` / v2 | `npm test -- test/zcode-profile.test.mjs` | 1151/1150/0/1 | 0 | 226.054 |
| `final-requested-host-setup` / v2 | `npm test -- test/host-setup-cli.test.mjs` | 1151/1150/0/1 | 0 | 216.129 |

全集为 **1151 tests / 81 suites**，1150 通过、0 失败、1 跳过；五次 v2 运行计数一致，完整退出状态均为 0。相对固定基线新增 **46 项测试**。唯一 Linux skip 是既有 `writes through 8.3 short-name aliases of protected roots are blocked (win32)`；没有增加 Linux skip。
<!-- FINAL-RESULTS:END -->

`npm run check` 检查 **115 个模块**和 3 个完整 commit pin，返回 0。它仍输出历史 HEAD evidence stale 警告；没有修改历史 evidence 使其消失。`verify-offline` 为 9/9 步，包括 7 个无 key 的 BLOCKED smoke、离线 workflow journal harness 和 model-review readiness，**不是 9 次真实模型调用**。项目 `doctor` 返回 0，但其中 DSH keyed vertical 等文字引用的是历史报告，不是本批宿主验收结果。

历史失败完整保留并区分原因：

| 原始记录 | 实际结果 | 解释 |
| --- | --- | --- |
| `baseline-tests` | 1105 tests / 1083 pass / 21 fail / 1 skip，exit 1 | 初始长 TMP + umask 0002；包含环境 fixture 失败及本次 M3 问题 |
| `baseline-standard-tests` | 1105 / 1093 / 11 / 1，exit 1 | 初次 detached worktree 未初始化 submodule，多 4 项上游文件缺失；已随后初始化，保留该次日志 |
| `baseline-complete-tests` | **1105 / 1097 / 7 / 1，exit 1** | 子模块完整、短 TMP、0022 的固定 680 原始基线；7 项包括 2 个产品 CLI 失败及 5 个原测试 fixture 漏参数失败 |
| `baseline-verify-offline` | exit 1 | 原始 0002 fixture 的 `UNSAFE_POLICY_PERMISSIONS`，没有放宽该守卫 |
| `alias-requested-npm-tests` | 1105 / 1097 / 7 / 1，exit 1 | 原始用户命令是全量；不是 alias-only 失败 |
| `zcode-npm-forwarded-selection` | 1146 / 1145 / 0 / 1，exit 0 | 修复中间版本；早于最终 AL5/EIO/平台断言，不作为最终快照门禁 |

最早 ZCode 外部 helper 参数传递错误、两个报告文件名与 recorder 冲突的 `FileExistsError`、初次 sudo 环境导致的宿主 probe 错误均保留。它们是测试工具/报告生成问题，不计作产品反例，也没有用其失败数量充当独立漏洞数。

## F. 证据、输入身份和发布

- [完整原始文本证据包](LOCAL-M3-ACCEPTANCE-2026-10-30.evidence.jsonl)：每行包含原相对路径、SHA-256、字节数和未经截断的 UTF-8 文本。对 `text.encode('utf-8')` 取摘要可验证原始日志字节。包含失败日志、命令 metadata、独立审阅和外部复现脚本；不包含临时数据库、模型凭据、node_modules、渲染构建产物或 symlink fixture。
- [最终运行输入](LOCAL-M3-ACCEPTANCE-2026-10-30.inputs.json)：版本化最终源输入清单及基线身份。
- 日志和审阅文件保留于数据盘 `/mnt/d/codex-workspace/gstack861-m3-acceptance-20261030/evidence/`；fixture 的准确路径见各原始记录，包括任务 `tmp/`、`evidence/dsh-offline-fixture/` 和 `/mnt/d/codex-workspace/g3tmp-1030/`。外部复现脚本位于任务根目录及 `tmp/`。原日志没有被成功重跑覆盖。
- 真实 Linux 宿主输出以 `zcode-native-linux-v2-*` 为最终输入版本，`zcode-native-linux-observations-v2.json` 核对运行前后源 SHA；第一次宿主执行与探针输出亦保留。
- 历史基线远端 CI：两个 run 的 Ubuntu/Windows offline-contracts 失败，render-upstream 成功；[push run 41046656408](https://github.com/wmqfl861/gstack861/actions/runs/41046656408)、[PR run 41046662516](https://github.com/wmqfl861/gstack861/actions/runs/41046662516)。没有把历史失败替换为本地通过。

本文件在正常提交前生成。提交/推送、远端分支 SHA 和对应 Actions 要在发布后单独核验，不能在这里预填成功。交付消息将提供实际完整 SHA 和对应 Actions 链接；也可从 [PR #3 Checks](https://github.com/wmqfl861/gstack861/pull/3/checks) 核查目标 head。未直接推送 main、未 force push、未绕过 CI、未合并 PR。

## G. 剩余事项与交接状态

| 状态 | 本批结论 |
| --- | --- |
| 已完成 | Linux 下三个模块的确定性反例、最小修复、回归、原始证据和非作者代码/证据复核；实际 ZCode Linux CLI 的独立技能发现、读取及配置诊断 |
| 已实现但未验证 | DSH 完整 profile 宿主注册、真实工具经 Guard 调度；ZCode Hook 实际执行、超时/错误处理和多 Hook 合并；alias 在 DSH/Windows 的真实发现与调用 |
| 被环境阻塞 | 当前本地原生 Windows 实机验收；当前真实 DSH Profile 加载和 Guard/Skills 服务激活 |
| 需要后续授权/条件 | 如未来只能通过模型触发宿主工具，需要主协调 Agent 另行决定调用方式与预算；本批没有推断模型或付费授权。修改既有宿主配置仍需备份和明确授权 |
| 主协调 Agent 决策 | 对修复、所述剩余边界及证据作最终独立审核；安排 Windows/DSH 实机及 ZCode 信任后的工具验收；决定是否合并 PR #3 |

**完整 Windows 宿主验收未完成，不能标为 HOST_ACCEPTANCE_COMPLETE。** 本批提供可复核的代码和当前环境能取得的真实证据，不扩大为 Windows 生产重构、真实模型调用或付费接入。
