# gstack861

将 gstack 原生适配到 **ZCode** 与 **DeepSeek Harness（DSH）**。一套核心，两套独立宿主适配，不隐藏调用 Claude Code，不把提示词复制当作功能对等。

**当前版本：0.2.1 / foundation。不是完整可用的 gstack 双宿主发行版。**

## 开发文档

- [完整蓝图与阶段验收](docs/BLUEPRINT.md)
- [功能与证据矩阵](docs/FEATURE_MATRIX.md)
- [本轮测试说明及限制](docs/VERIFICATION.md)
- [精确测试文件摘要](docs/verification-2026-10-26.json)（首轮 Linux）；[Windows 轮](docs/verification-2026-10-26-windows.json)；[M2 基础批次](docs/verification-2026-10-26-m2.json)
- [M2 基础批次实施计划](docs/plans/2026-10-26-m2-foundation.md)
- [本机 DSH 真实加载调研](docs/integration/dsh-local-findings.md)
- [固定上游和宿主提交](upstream.lock.json)

## 已实现

1. 宿主中立策略核心：显式文件工具绑定、读写范围分离、符号链接和路径越界检查、未知工具默认拒绝、配置摘要。
2. ZCode 同步 PreToolUse 协议适配与配置片段生成（支持按绑定工具收窄 matcher）；实际 Node Hook 子进程回归。
3. DSH 原生 `ctx.tools.guard` 插件入口；协议测试通过；并已在本机真实 DSH 0.2.1-rc.3 隔离配置中完成加载/激活冒烟（见调研文档），guard 工具执行级拒绝路径仍未验证。
4. 持久审批状态核心：等待人工批准、会话/操作/配置绑定、过期、拒绝、单次消费、跨进程竞争保护；操作员 CLI（`approvals list/show/approve/reject`）已接通审批通道，宿主内询问 UI 仍未接通。
5. 固定提交的上游源技能盘点器：模板去重、文件摘要、宿主依赖提示；不执行上游代码，不自动宣布兼容。
6. 持久任务日志：planned/running/completed/failed/cancelled/interrupted 状态机、断点恢复标记、跨进程转移锁、防篡改记录校验。
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

## 安全与状态边界

- Hook/guard 不是操作系统沙箱。TOCTOU 路径竞态、恶意同用户进程、宿主绕过标准管线的执行器均不在本阶段保障内。staging 目录在校验与写入之间同样存在 TOCTOU 窗口，蓝图第 5 节边界适用。
- ZCode PreToolUse Hook 看到的是宿主分发的**原始输入**：任何其他 Hook/插件返回 `updatedInput` 的改写都会在守卫判定之后按最后写入者胜出合并，使本守卫的弃权或拒绝作用于过期路径。因此本守卫**不得与任何返回 `updatedInput` 的 Hook/插件共存**，该约束属于宿主接入验收项，而非代码可强制。
- 安装/卸载的所有权判定是内容验证（注册表记录摘要 × 目录 manifest × SKILL.md 字节 × 无多余文件），不是密码学证明：对目标目录拥有任意写权限者仍可构造完全自洽的伪造。因此**安装目标必须处于模型不可写路径**（由宿主侧 guard 策略保证），这是部署前提而非代码强制。
- 卸载遇到用户修改过的技能文件或目录内多余文件会整体拒绝（`USER_FILE_REFUSED`），不删除用户数据；`--purge` 只清理符合本项目备份命名（`<name>-<时间戳>`）的目录，用户放入备份目录的其他内容保留。
- `install`/`uninstall` 通过目标内锁目录互斥；崩溃残留的锁以 `INSTALL_BUSY` 拒绝后续操作，须人工确认后清除，不自动解锁。
- 策略仅认可显式审查的文件工具；工具名称被第三方替换的身份校验尚未完成。
- 审批状态转换只提供给可信控制器；人工操作员 CLI（`approvals approve|reject`）本身即是这样一个可信控制器。其前提是状态目录位于模型可写的工作区之外，且守卫生效时模型工具无法调用该 CLI。审批 API 不暴露给模型工具。调用 `approve()` 不是用户同意的证明；宿主 UI 必须先取得真实批准。
- 消费在执行之前发生，崩溃可能导致任务未执行但批准已消费；不能自动重发。当前没有断电持久性保证和远端业务幂等保证。
- 状态目录须位于模型不可写的工作区外。锁遗留时拒绝继续，不自动清锁或重新批准。
- 不执行任何付费模型调用；后续功能必须使用显式网关配置，不回退官方端点。

## 后续开发入口

先完成两侧真实宿主离线集成和工具身份/旁路验证，再接上技能生成、原生问答审批、子任务与恢复。随后逐项迁移上游工作流、浏览器 QA、发布、安全审计、记忆和专项能力。具体依赖与验收见蓝图；未验证功能保持 `planned` 或 `blocked`，不能标为 `full`。

## 许可

新增代码使用 MIT 许可。上游 gstack 在子模块内保留其原始许可与版权声明。ZCode、DSH 仅作为接口审查和目标宿主，没有把其源码复制进本仓库。
