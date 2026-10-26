# gstack861

将 gstack 原生适配到 **ZCode** 与 **DeepSeek Harness（DSH）**。一套核心，两套独立宿主适配，不隐藏调用 Claude Code，不把提示词复制当作功能对等。

**当前版本：0.1.0 / foundation。不是完整可用的 gstack 双宿主发行版。**

## 开发文档

- [完整蓝图与阶段验收](docs/BLUEPRINT.md)
- [功能与证据矩阵](docs/FEATURE_MATRIX.md)
- [本轮测试说明及限制](docs/VERIFICATION.md)
- [精确测试文件摘要](docs/verification-2026-10-26.json)
- [固定上游和宿主提交](upstream.lock.json)

## 已实现

1. 宿主中立策略核心：显式文件工具绑定、读写范围分离、符号链接和路径越界检查、未知工具默认拒绝、配置摘要。
2. ZCode 同步 PreToolUse 协议适配与配置片段生成；实际 Node Hook 子进程回归。
3. DSH 原生 `ctx.tools.guard` 插件入口；针对固定上游接口的协议测试，尚未加载真实 DSH。
4. 持久审批状态核心：等待人工批准、会话/操作/配置绑定、过期、拒绝、单次消费、跨进程竞争保护。审批 UI 与真实任务执行尚未接通。
5. 固定提交的上游源技能盘点器：模板去重、文件摘要、宿主依赖提示；不执行上游代码，不自动宣布兼容。

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

子模块保留完整上游源码和许可，并固定在锁文件提交。离线单元/协议测试不需要子模块、宿主安装、API Key 或网络；完整上游盘点需要已拉取的子模块。这里没有执行 gstack `setup`，不会安装 Claude Code 或启动模型。

## ZCode 接入（实验性，需人工审查与真实宿主验证）

先按 [策略示例](examples/policy.example.json) 填写实际存在的绝对目录。策略文件放在目标工作区之外，权限建议 `0600`。绑定项必须对应审查过的真实文件工具；不要将 Bash/MCP/子任务伪装为文件工具。

```sh
node bin/gstack861.mjs zcode-config --policy /absolute/private/policy.json
```

该命令只输出配置片段，不修改用户设置，不自动授予 Hook 信任。按固定版本 ZCode 的 Hooks 文档合并配置并审查 trust digest，创建新会话验证。允许的调用返回空结果，保留 ZCode 自身权限检查；拒绝返回结构化 deny 和退出码 2。

**强范围保护当前会拒绝所有未映射工具，包括 Shell、任意代码执行、MCP 和子任务，因此不是常规开发流程的完整安全安装。**它是供受控接入验证的保守基础，不建议直接在生产工作区启用。Hook 启动失败、超时、其他 Hook 顺序和旁路工具仍需宿主级验证。

## DSH 接入（实验性，需真实插件加载验证）

`src/adapters/dsh.mjs` 导出原生 Cordis `name`、`inject` 和 `apply`。将此模块通过 DSH 的本地插件机制加载，配置 `policyPath` 为工作区外绝对路径；插件依赖 `tools` 服务的单调 guard API，缺失时拒绝激活。

策略中的 `bindings.dsh` 默认为空。应先检查该安装实际注册的文件工具名和参数，再显式绑定；本项目不会猜工具名。此阶段 DSH **只接受绝对文件路径**，相对路径会拒绝，直到 Session cwd 语义与继承在真实宿主中验收。没有使用部分兼容的 Claude Hook 桥。

## 安全与状态边界

- Hook/guard 不是操作系统沙箱。TOCTOU 路径竞态、恶意同用户进程、宿主绕过标准管线的执行器均不在本阶段保障内。
- 策略仅认可显式审查的文件工具；工具名称被第三方替换的身份校验尚未完成。
- 审批 API 只提供给可信控制器，未暴露给模型或 CLI。调用 `approve()` 不是用户同意的证明；宿主 UI 必须先取得真实批准。
- 消费在执行之前发生，崩溃可能导致任务未执行但批准已消费；不能自动重发。当前没有断电持久性保证和远端业务幂等保证。
- 状态目录须位于模型不可写的工作区外。锁遗留时拒绝继续，不自动清锁或重新批准。
- 不执行任何付费模型调用；后续功能必须使用显式网关配置，不回退官方端点。

## 后续开发入口

先完成两侧真实宿主离线集成和工具身份/旁路验证，再接上技能生成、原生问答审批、子任务与恢复。随后逐项迁移上游工作流、浏览器 QA、发布、安全审计、记忆和专项能力。具体依赖与验收见蓝图；未验证功能保持 `planned` 或 `blocked`，不能标为 `full`。

## 许可

新增代码使用 MIT 许可。上游 gstack 在子模块内保留其原始许可与版权声明。ZCode、DSH 仅作为接口审查和目标宿主，没有把其源码复制进本仓库。
