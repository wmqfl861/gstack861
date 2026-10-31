# LOCAL M3 Windows 验收报告 — 2026-10-30

验收完成日期：2026-10-31。本报告交付三个模块的原生 Windows 修复与证据；**整体宿主验收为部分完成**：DSH 实际生成 Profile 的插件、索引和 fixture 工具管线已实测，ZCode 配置生命周期已离线验证，当前 ZCode 真实宿主测试受阻。最终合并由 ChatGPT 决定。

## A. 环境

| 项 | 实际值 / 来源 |
|---|---|
| Windows | Microsoft Windows 11 Pro for Workstations，10.0.22624，build 22624 |
| 执行环境 | 原生 Windows Node；Git Bash 仅启动命令，没有 WSL |
| Node.js | v24.21.0；项目要求 >=22 |
| Git | 2.56.0.windows.2 |
| ZCode 桌面 | 3.17.1.9553，读取安装 exe 文件版本 |
| ZCode 内置 CLI | 0.17.1，安装包源码常量；本次没有启动 ZCode CLI/会话 |
| DSH | 0.2.1-rc.3，实际宿主输出；内嵌 Node 24.21.0 |
| 固定 gstack | 5755601dac5d35ebd7dde181fdefe52a023c73d9，共57个顶层源技能 |
| 依赖 | 项目零 npm 依赖；没有全局安装/升级，Bun 不可用 |

最早两个 DSH `--version` 探针先于强化隔离审查，使用普通宿主路径；研究阶段的部分仅用于读取安装包的 Electron 调用也未重定向 home。这些调用没有启动 Profile、工具或模型任务，不能称为完整隔离验收。最终成功的5个DSH进程均使用新建 DSH_HOME、DSH_AGENTS_HOME、USERPROFILE、临时目录与空 cwd，固定中性用户标识，禁用遥测，无继承凭据、代理、任务/模型插件。启动前验证准确的环境键值及 `os.homedir()`。第二次尝试在这些Windows身份字段修正前已于导入DSH前失败，其记录保留在后文。详细披露见 [DSH 可行性记录](evidence/local-m3-2026-10-30/dsh/host-feasibility.md)。

## B. 代码基线与分支

- 仓库：https://github.com/wmqfl861/gstack861 ，PR：https://github.com/wmqfl861/gstack861/pull/3 。
- 开始验收时，远端 PR head/开发分支均为 **680b2f19b2dbef8831e3be1fd996203589b5c41d**（0.4.33）；原始基线完整保存在 `baseline/`。
- 在独立 `gstack861-m3-audit` worktree 验收；起初跟踪 `work/m3-command-aliases-20261029`。原 `gstack861` 的 `main` 保持 `15c32ae2e4afc0b2de600b346d7977921059caa0` 干净；没有 reset、删除 stash、force push、main 推送或合并。
- 验收期间远端有并行成果，先前进到 `3b4ee5b989781b8dd207e238c3ca02d121623411`、`9acc27885d5cbe5e379873dace26b4700e05d937`，最终观察到 **408ededd1764cd45e156a42e2c20b6bad17862bc**。本地没有覆盖或合并这些提交；保存在独立 **audit/local-m3-windows-20261030** 分支，供 ChatGPT 比较并集成。
- 最终测试时 HEAD 仍为基线，修复在工作树；`final-round4/tested-files.json` 逐文件绑定实际测试的源码和测试字节，`source-stability.json` 为 true。
- DSH 成功运行的源码/测试/启动脚本聚合 SHA256：**bf16abf5e6d555a859af8ad88d7d7aebc6606f58ca4463c4a20011b6de5e2b5d**。其中包含本地启动脚本，不能直接当作提交 tree ID。提交 SHA 和推送结果以交付消息及 `delivery.json` 的实际记录为准。

## C. 三大模块测试

### 1. 命令别名 `/connect-chrome` → `/open-gstack-browser`

离线结果：**51/51**。固定上游源 fixture 的两宿主生命周期另有 **4/4**。canonical 原始字节不变；仅替换 frontmatter name token，保留 CRLF、空白和正文原始字节；辅助文件逐字节复制，manifest SHA256/git blob 更新；canonical/alias 分别安装入共享注册表、重复安装 skip、各自卸载。

修复了完整祖先 junction/symlink 验证与 Windows namespace/8.3 物理重叠、reserved/casefold/file-directory key 预检、失败时递归删除调用方目录的问题。清理只删除本次独占创建、身份与生成内容仍吻合的文件；保留用户原地修改、并发子项和无法证明所有权的恢复文件。

真实 DSH 结果：安装链生成的 canonical、alias 和 root fixture 在实际 `systemPrompt.assemble()` 的 `gstack861:skills` 索引中分别出现，名称/路径/摘要正确，没有同名覆盖。这证明该组合的原生索引贡献；没有调用浏览器、斜杠命令或模型。ZCode 实际技能发现尚未执行。

完整上游宿主渲染未执行（缺 Bun）；固定上游源 fixture 与实际渲染证据分开。辅助文件正控显式使用固定上游的真实文档 blob；DSH 主机管线则使用受控技能 fixture。不能将其称为原始技能方法论消费或浏览器功能验证。

### 2. DSH Profile

离线结果：**49/49**。生成器现在输出 guard 与 skills 两个完整 package/shim，指向真实仓库适配器；`skillsAdapterPath` 默认仓库适配器。完整策略验证复用 `loadPolicy`，路径检查复用共享核心，输出失败清理要求身份与内容吻合。Windows URL 测试修正为标准 `pathToFileURL`，保留准确比较并覆盖空格、Unicode和8.3路径。

真实宿主结果：成功运行 **run-2026-10-30T17-31-03.592Z-cce238ac**，5个独立 DSH 进程全部完成。消费的是实际 `stageDshProfile` 生成输出，仅离线将其已存在插件目录暴露到自身 `node_modules`；没有包管理器、下载、替换 shim 或修补生成 patch。

| 控制 | 实际观察 |
|---|---|
| 正常加载 | system-prompt、tools、gstack861-guard、gstack861-skills 均 ACTIVE=2；加载适配器导出与仓库真实适配器一致 |
| Skills 索引 | `systemPrompt.assemble()` 列出3项：connect-chrome、gstack、open-gstack-browser；名称、描述、绝对路径与注册摘要匹配 |
| 合法工具 | 经真实 `ctx.tools.execute()` 执行受控 fixture_write/read，产生并读回准确字节 |
| 越界写入 | `gstack861:OUTSIDE_SCOPE`；工具主体计数不增加，目标不存在 |
| `.git/config` | `gstack861:PROTECTED_PATH`；工具主体不执行，哨兵字节不变 |
| 运行中策略损坏 | `gstack861:POLICY_UNAVAILABLE`；未写入；恢复策略后同一 guard 正常放行并读回 |
| 启动前坏策略 | guard FAILED=3，宿主仍返回0并警告；验收控制器检测失败后**没有派发工具** |
| 缺 systemPrompt | tools/guard/skills PENDING=0，缺服务警告；未派发工具 |
| 损坏注册表 / 篡改技能 | skills FAILED=3，警告分别为 REGISTRY_INVALID / SKILL_TAMPERED；未派发工具 |

**重要限制：启动负控通过表示准确检测到宿主失效，不表示 DSH 自身启动闭锁。** 坏插件时宿主仍能退出0，成功 sibling 可存活；阻止测试继续派发的是验收控制器。一般启动器仍须检查实际激活状态，不能只信 exit code。生成 skills 插件贡献 prompt 索引，没有挂载 native `ctx.skills`，没有验证自动技能扫描/原生文件工具/PTC/子代理/模型消费。

正常流程真实执行主体计数 write=2、read=2；三个拒绝操作没有触发主体。所有5进程记录的网络、子进程、敏感配置读取 tripwire 数均为0，任务/模型/凭据服务缺席。证据支持该受控组合的零模型请求结论，不是OS网络隔离证明；doctor中的常量0没有用作计量。

保留两次失败尝试：第一次在宿主启动前因深路径 Git `.git/refs/heads` 过长失败，hostChildren=0；第二次1个 Electron 子进程在导入DSH前因Windows补入用户环境变量失败。经独立审核后分别缩短 fixture 路径并显式设置/验证 fixture home，再获得上述成功；没有降低校验条件。

### 3. ZCode 配置生命周期

离线结果：**99/99**；模块及 CLI 集成 focused 合计 **213/213**（含 aliases/DSH/Skills），无跳过。原始5个ZCode单元fixture漏传 workspace 的问题已修正，保留安全断言。fresh `.zcode` 先验证再创建和加锁；预览与验证无变更的操作零写入。

计划深度冻结，并以私有状态绑定字节、存在性、文件及目录身份；格式变化、同内容替换、缺失/新建等并发变化均拒绝。共享校验拒绝畸形已知配置结构并保留外国Hook变体/元数据。CLI严格匹配编译策略与选定工作区，策略损坏/删除仍能按所有权卸载。

工作区内旁置 `.zcode/.gstack861-zcode-receipt.json` 记录本次实际插入的完整Hook及原始字段存在性。预先存在的相同Hook不会被认领；卸载只移除收据证明的一条完整记录，保留修改后的Hook、用户字段、预先存在的开关/空容器和并发修改。fresh配置在安全空结果时恢复为不存在；原有JSON值语义保持。实际合并/卸载可能重新格式化JSON；预览、幂等无变更和正常回滚保持准确字节。

收据 intent→配置提交→收据最终化具有故障回归；瞬时读回错误可恢复准确原始状态；组合故障保留真实 pending屏障或明确报告已提交/不确定状态。锁清理失败附独立 cleanupCode，保留主错误。序列化结果与输入使用同一1MiB限额，避免成功写出后无法卸载。临时文件清理同时证明身份与内容：独占创建后仅证明空文件，写入成功返回后才采用预期字节；保留同inode用户修改、部分写入和不可读内容，清理失败不覆盖原事务错误。

CLI每次`--apply`重新构建计划；跨预览到应用的已保存凭证未实现。并发拒绝证据对应保留API计划对象的`planZcodeConfig`→`applyZcodeConfigPlan`，不扩大为CLI承诺。

真实 ZCode 宿主结果：**受阻 / 未运行**。当前安装包没有已确认完整用户配置/home隔离，默认配置读取可自动迁移写入；没有找到受支持的零模型原生文件工具测试入口。未修改用户trust/config、未创建模型会话、未启动历史keyed脚本。真实新会话发现、Hook执行、合法/越界/.git、启动错误、超时、updatedInput共存、实时回滚均未新验证。见[受阻依据](evidence/local-m3-2026-10-30/zcode/host-feasibility.md)。

额外5/5真实仓库CLI适配器子进程控制（合法不干预、越界/.git拒绝、坏策略拒绝及恢复）为**协议证据**；没有调用ZCode工具主体，不能替代上述宿主检查。

## D. 安全审核、问题与修复

实施过程为本地计划→独立审计划→不重叠模块并行开发→独立规格/质量审核→复现问题后按补充计划修复→定向复审。过程规则/计划留在gitignored `.superpowers`；仓库证据只包含实际结果，不提交本地流程规则。

| 缺陷 / 严重性 | 修复及回归证据 |
|---|---|
| Alias A1/A2 高：链接祖先/物理重叠、无所有权递归清理 | 共享路径身份检查+物理比较，独占创建/字节证明清理；aliases51/51 |
| Alias A3 中、A4 低：映射预检、CRLF漂移 | 完整key/摘要预检，name字节切片；保留canonical |
| Installer I1 高：目标祖先穿越 | install/uninstall/dry-run全链共享验证；110/110，原68项保留 |
| DSH 高/中：缺Skills插件、不完整策略和路径校验 | 双插件、真实适配器与完整loadPolicy；49/49及真实加载控制 |
| ZC-01/02/06 高：路径、卸载所有权、CLI工作区绑定 | 共享身份、收据与精确完整Hook、策略匹配；99/99及CLI |
| ZC-03/04/05 中：首次锁、可变/陈旧计划、配置形状 | 安全创建顺序、不可变私有计划、统一校验 |
| 复审R1/R2 Important：同inode修改仍被删除 | 内容+身份双证明；DSH RED47/49→49/49，installer RED107/109及moved负控→110/110 |
| 复审R3/R4/R4b Important：输出大小、收据读回/清理状态 | 18场景RED3/18→18/18；再补清理负控RED2/4→93/93 |
| 最终审核R5 Important：临时文件同inode内容被清理 | 身份+内容证明；6个新增场景及既有部分写入oracle强化，RED2/7→最终99/99 |

修复提交对应本验收分支最终源码提交；精确源码SHA256在`final-round4/tested-files.json`，独立审核结论在`repairs/reviews`。提交ID由提交后`delivery.json`及交付消息记录。全部原始失败、RED/GREEN日志保留；没有删失败测试、放宽断言或新增跳过制造通过。

**仍开放 ZC-07：** portable Node 路径复查无法保证抵御同用户在最后检查后、最终文件系统调用内部的恶意目录替换。保留基线确定性接缝复现；未宣称彻底修复、OS sandbox或原子CAS。需要原生目录句柄/no-reparse/compare-and-swap后端的单独设计。

ZCode运行时Hook启动/超时错误与正常启动后适配器拒绝策略不同。源码显示仅满足PreToolUse的`onError:"deny"`等条件时执行异常转为deny；当前生成器未声明该字段。此处只记录未验证的宿主边界，不修改未经宿主验证的声明语义。收据为本地来源记录，不是抵御恶意同用户伪造的认证。

## E. 完整测试统计

| 阶段 / 命令 | 实际结果 |
|---|---|
| 原始`npm run check` | exit0，115模块，3固定pin；HEAD历史证据stale警告保留 |
| 原始`npm test` | exit1，1104 total /1076 pass /8 fail /20 skip /0 cancelled |
| 首轮修复全量 | 1311 total /1291 pass /0 fail /20 skip，源码稳定 |
| 复审修复全量 | 1335 total /1315 pass /0 fail /20 skip，源码稳定 |
| R5前全量 | 1338 total /1318 pass /0 fail /20 skip，保留为历史 |
| **最终`npm run check`** | **exit0，116模块，3固定pin**；历史HEAD证据警告原样保留 |
| **最终`npm test`** | **exit0，1344 total /1324 pass /0 fail /20 skip /0 cancelled**，约94秒 |
| 最终`npm run verify-offline` | exit0，9/9 PASS |
| 最终`npm run doctor` | exit0，完整JSON；现有主机历史状态未擅自升级 |
| 最终inventory | exit0，固定gitlink，57技能 |
| 最终focused模块/CLI | exit0，213/213，无失败/跳过 |
| DSH真实宿主组合 | 5/5进程控制完成；7个正常工具管线操作及索引证据 |

20项跳过均为原有平台差异（POSIX权限/链接、sh PATH桩、慢管道、signal等），逐条保存在`baseline/summary.json`。Windows URL测试修正标准oracle，没有跳过。`npm test -- 文件`会叠加原脚本wildcard，因此focused使用等价`node --test 精确文件`；完整`npm test`确实执行。

## F. 证据与复现

证据根：[evidence/local-m3-2026-10-30](evidence/local-m3-2026-10-30/)。完整stdout/stderr留档；根`sha256-manifest.json`绑定文件字节，自身不递归包含。

- `baseline/`：原始完整命令、doctor、inventory、115模块、8失败栈、20跳过、源码文件摘要。
- `aliases/`、`zcode/`、`dsh/pre-fix-repro.json`：原生复现清单、实际/预期、原因影响、保留的脚本与摘要。
- `repairs/`：精选原始RED/GREEN完整日志、实现报告、独立复审结果和文件摘要；不发布本地计划或流程规则。
- `final/`、`final-round2/`、`final-round3/`：前三版全量结果，保留为历史；`final-round4/`为最终源码的check/test/offline/doctor/inventory/focused命令及稳定性证明。
- `dsh/run-2026-10-30T15-42-59.827Z-88e05b11/`：第一次预检失败，0宿主；`dsh/run-2026-10-30T16-17-25.163Z-beb5e55c/`：第二次导入前环境失败。
- `dsh/run-2026-10-30T16-41-27.706Z-a740898f/`：R5前同样五控制成功，保留为历史。**`dsh/run-2026-10-30T17-31-03.592Z-cce238ac/`**：最终5进程完整结果、真实主机stdout/stderr、Git准备、插件/服务/索引/工具/哨兵/计数、生成配置摘要和tested-source.json。
- `zcode/adapter-contract.json`：5项原始适配器协议控制；`host-feasibility.md`列当前宿主受阻的准确接口与源码依据。

DSH无模型执行使用已安装ASAR-aware Electron carrier加载DSH公开Profile API；不是`headless --prompt`。网络/子进程/敏感文件tripwire在安装包导入前生效，启动的准确插件列表无模型/任务/凭据服务；每个负控均不派发工具。0请求结论依据这些实际观测与限制，不是只看退出码。原有DSH/ZCode用户配置没有被本次安装/卸载操作修改，测试配置均属于新fixture。

## G. 交付与剩余问题

| 分类 | 实际状态 |
|---|---|
| 已完成 | 原生Windows基线、三模块复现与修复、共享安装器兼容性、回归、全量复测、DSH实际生成Profile加载/索引/fixture工具管线及失效检测 |
| 已实现但未验证 | ZCode真实新会话配置读取/Skills拾取/Hook运行和UI回滚；DSH原生文件工具/模型技能消费/自动扫描；实际浏览器命令调用 |
| 环境受阻 / 开放 | 当前ZCode完整home隔离与零模型原生工具入口，缺Bun的完整上游渲染，ZC-07原子文件系统边界 |
| 需要另行条件或授权 | disposable Windows账户/VM或有完整隔离的ZCode手工宿主测试；用户现有配置/trust修改需明确授权与备份。付费模型请求本次明确禁止，没有发起 |
| 合并决定 | 交由ChatGPT；仅推送独立验收分支供比对，不合并、不覆盖远端并行成果 |

此结果不宣称完整gstack迁移、双宿主全功能对等、全宿主不可绕过安全或`host_verified`整体认证。实际提交SHA、推送与CI状态在完成后回传。

## H. CI 后续：Windows 身份修复的实际托管结果与残余注入 seam 修复（2026-10-31 追加）

### H.1 实际托管 CI（f4d1bd3，run 41131365406 attempt 1）

| 任务 | 结果 |
|---|---|
| Ubuntu（离线契约/全量） | 成功 |
| 上游渲染 | 成功 |
| Windows | 失败——失败块从诊断轮的 256 缩小到 6 个故障注入用例（`ci-f4d1bd3-windows-annotations.json`） |

### H.2 本地复现与根因（单一、共享）

以 `preload-zero-device.mjs` 注入托管 runner 实测元数据分裂（路径 API `lstat` dev=0，句柄 API `fstat` dev 非零、ino/kind/nlink 相同），6/6 用例本地失败且错误文本与断言行号与托管注解逐字一致；零设备全量基线 1383/1357/6/20，失败集合恰为 CI 六例（协调者与独立审核代理分别跑出相同结果）。根因：dev=0 路径下每个生成文件在数据 fd 生命周期内新增只读 witness open/close 流量，旧注入 seam 按"文件名匹配的任意 close"或"lstat dev 与 fstat dev 相等"触发——注入在错误时机触发（witness close 时 wx fd 仍钉住目录，Windows 对含打开句柄目录的 rename 失败，注入半途而废）或永不触发（dev 0 恒不等于 fstat dev）。失败状态下产品行为全部为正确拒绝（STAGING_NOT_EMPTY / 保留 operator 数据 / fail-closed），属测试装置过时而非产品缺陷。

### H.3 修复：仅测试注入 seam（计划获独立 APPROVE 后实施）

| 文件 | 调整 | 不变项 |
|---|---|---|
| test/aliases.test.mjs（4 处 close 钩子） | descriptors 记录 `{name, flags}`，仅在生成写 fd（`'wx'`）关闭时触发注入——即用例名义时点"生成文件写入完成关闭后、下一生成写之前" | 全部断言（STAGING_NOT_EMPTY、operator 字节保留、目录仅 operator.txt、replaced/edited）逐字保留 |
| test/fs-utils.test.mjs:259 | close 故障由 `readFailed` 门控，只在主读错误后的清理 close 抛出（该用例主题） | caught===denied EACCES、句柄全关断言不变 |
| test/install.test.mjs:1708 | 原文件按 ino 匹配（去掉在设备分裂下恒为假的 dev 合取；temp 内仅一个文件） | EIO 主错误、temp 保留、字节/ino 保留、refused=true 及全部终态断言不变 |

`src/` 零改动：五个冻结源码 SHA256（cbff271d/02eaf82f/131d1b21/4f098532/0c525632 前缀）修复前后逐字符相同。

### H.4 验证（隔离串行）

- 定向 6 例零设备：6/6 通过，exit 0。
- 零设备全量：1383/1363/0 失败/20 跳过，exit 0。
- 常规全量 Node 24.21.0 与锁定 Node 22.16.0：均 1383/1363/0/20，exit 0（Node 22 日志为 TAP 格式即真 22 运行的硬证据）。
- Node 22.16.0 直跑 check（119 模块）/verify-offline（9/9）/doctor（自报 v22.16.0）：全部 exit 0。
- 过载 flake 如实记录：三个全量并行首轮出现过载假失败（host-setup-cli 的 spawnSync 10s 超时×3、29 秒停滞下 NTFS 文件 ID 复用×1），均不在修改集、修复前单任务基线通过；并行日志保留为对照（`overload-flake-*.log`），隔离串行重跑与独立复审代理自跑均为零失败。

### H.5 独立审核链与证据

计划审核（agent_3966d0e5）APPROVE，含一项必改：witness close 故障分支（src/fs-utils.mjs `independentDescriptor` 的 `catch { if (!failed) fail(code) }`）在 `readFailed` 门控后失去全套件唯一（且属意外获得的）覆盖——该分支在绿色平台本就无覆盖、方向为 fail-closed，本次未移除任何有意覆盖；已列为后续独立用例候补并在此披露。成果复审 APPROVE（diff 与工作树逐字节一致、六处门控精确、断言/错误集合零变更、独立复跑全部零失败），其必改项（npm run 内 PATH 劫持导致三个 Node 22 辅助日志实跑于系统 Node 24）已在发布前以锁定二进制直跑重生成修正。证据：`ci-followup/residual-seam/`（18 文件，`copied-evidence.json` 逐文件 SHA256）。本地零设备注入是托管条件的本地复现，不冒充托管证据；本次推送后的三个托管任务为最终兼容门。

### H.6 边界（维持 OPEN）

已批准的线性 sweep 时序权衡（两次外层扫描间完全恢复的瞬时祖先替换可能失去内部观察机会）、witness close 故障分支覆盖缺口（上文）、ZC-07 最终 syscall 同用户替换竞态——均保持 OPEN，未因本次 seam 修复改变。
