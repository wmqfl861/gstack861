# gstack861 双宿主原生适配蓝图

状态：开发中；不是 gstack 完整替代品。日期：2026-10-26。

## 1. 目标与不可退让的约束

将固定版本的 garrytan/gstack 在 Claude Code 上的功能，分别原生适配到 zai-org/ZCode 和 deepseek-ai/deepseek-harness（DSH）。一套共享核心、两套平等的宿主适配；每个宿主都可以独立使用，不以另一个宿主或隐藏的 Claude Code 进程代执行。功能、审批、安全边界、产物和失败行为都在验收范围内；界面不必相同，模型质量单独评测。

- 不把复制 Markdown、成功生成技能文件或模拟测试等同于完整适配。
- 不把缺失能力静默降级为警告，也不把 blocked / not_run 算作通过。
- 不硬编码模型网关和凭据；所有模型调用必须使用显式配置，配置版本绑定任务与审批。
- 未获授权不执行付费模型、图像或其他按量计费调用；不自动付费重试，不回退官方接口。
- 不提交密钥、账户、会话记录、Cookie 或用户工作区内容。
- GitHub 代码、测试证据和蓝图同步更新；只报告真实运行过的检查。
- 先复用上游工具和工作流，再隔离宿主差异；不顺便重建通用 Agent 平台。

## 2. 冻结基线

| 项目 | 审查基线提交 | 用途 |
|---|---|---|
| garrytan/gstack | 5755601dac5d35ebd7dde181fdefe52a023c73d9 | 功能及工作流对等基线 |
| zai-org/ZCode | 3c5b227649371507ddc4eb46ac5133afe6db1cab | 原生 Hook、插件、CLI 合同 |
| deepseek-ai/deepseek-harness | 22ddee3792402c3e70ec5f86a63c3e3e895a2f60 | 插件与工具执行管线合同 |

以上为本轮经 GitHub 读取的引用，不代表已安装或实测这些宿主。上游通过固定提交子模块复用，不把自动更新的 main 当验收基线。升级必须更新锁文件、生成差异清单、重新跑回归。

## 3. 架构

```text
                     gstack861 shared core
  upstream inventory / workflow contracts / approval binding / policy
                /                                  \
      ZCode native adapter                    DSH native adapter
  synchronous process hooks             ctx.tools.guard + native plugins
  skills / commands / UI approvals       commands / sessions / child agents
                \                                  /
          pinned gstack tools, browser and workflow resources
```

业务方法、验收标准、工具包装与产物格式共用；宿主发现、工具参数、审批和会话事件分别适配。MCP 仅作为可选工具接口，不替代宿主执行和安全控制。

## 4. 交付阶段与验收门槛

### M0：可复现基线与功能盘点

- 固定三个项目提交；保留上游许可和出处。
- 编写递归技能盘点器：枚举源技能而非重复统计其他宿主生成物，保留文件摘要；发现宿主硬编码和外部命令绑定。
- 维护每功能 × 每宿主矩阵：planned / implemented / contract_tested / host_verified / blocked。
- 新增或删除上游技能必须产生可审查差异；未知功能不得自动判定支持。

退出条件：锁文件可验证；盘点可重复；功能矩阵不混淆实现与真实宿主验收。

### M1：原生安全与审批基础

- 宿主中立的调用结构、策略校验和结构化拒绝理由。
- 路径限制检查绝对路径、相对工作目录、符号链接和路径前缀边界；策略错误默认拒绝。
- ZCode：同步 PreToolUse 输入/输出适配；显式生成安装片段，不擅自修改用户设置或授予信任。
- DSH：使用原生单调 guard，不依赖会在配置失败时继续运行的 Claude Hook 兼容桥。
- 审批绑定操作摘要、配置摘要和会话；拒绝、过期、重放、参数变更、配置变更都有测试。
- 初期严格范围保护中禁止 Shell、任意代码、未审核 MCP、子任务等不能证明被隔离的入口；不能用正则声明完整沙箱。

退出条件：核心与两种协议的自动化测试通过。真实宿主加载、旁路工具、生命周期继承仍须另做集成验收；未完成前不得宣称全宿主强制隔离。

### M2：两侧各自跑通真实纵向流程

分别实现需求/规格 → 规划 → 实现 → review → qa → ship；使用目标宿主自己的执行器。先做一个有真实代码与本地测试的受控项目，再扩大覆盖。

- 替换 /spec --execute 等启动 claude 的隐式依赖。
- 接通原生询问、批准、取消、暂停、恢复；非交互无审批渠道时阻塞，不能自动同意。
- 独立复核使用隔离上下文和可配置模型；具名 Codex/Claude 集成只能真实调用，不能冒充。
- 任务持久化、断点恢复、工具结果、父子取消与最终完成证据统一。

退出条件：两侧独立、无 Claude Code 安装环境中的真实流程均通过；付费测试须另获预算授权。

### M3：完整功能扩展

| 功能组 | 至少包含 |
|---|---|
| 产品与规格 | office-hours、spec、产品/CEO 评审 |
| 规划 | eng/design/devex review、autoplan |
| 开发与质量 | review、investigate、deslop-shared-libs、test-audit |
| 浏览器与测试 | browse、qa、qa-only、scrape、cookies、pair-agent |
| 设计 | consultation、shotgun、html、design-review、devex-review |
| 交付 | ship、document-release、document-generate、land-and-deploy |
| 运行质量 | canary、benchmark、eval-plan |
| 安全 | careful、freeze、guard、unfreeze、cso |
| 记忆 | learn、retro、GBrain setup/sync |
| 辅助工具 | make-pdf、diagram、doctor、egress 等独立二进制 |
| 专项 | iOS QA/fix/design-review/clean/sync、远程接入 |
| 生命周期 | 安装、升级、迁移、卸载、团队引导、命令别名 |

该表是分组索引，不替代从固定上游生成的完整清单。设备、Docker、浏览器、账号、视觉/图像模型等前提逐项声明，缺失时 blocked，而非缩减功能后标记 full。

### M4：完整对等与维护

- 相同项目和输入在两个宿主分别验收；产物、行为和安全一致性比较。
- Windows / Linux / macOS 支持按真实测试矩阵发布，不推断跨平台通过。
- 测试安装升级失败回滚、用户文件保护、配置迁移、取消、崩溃恢复和重复调用防护。
- 仅当全部适用基线项 host_verified，才发布 full 支持。

## 5. 安全边界

宿主 Hook 和插件不是操作系统沙箱。路径检查到实际打开文件之间有竞态；Shell、第三方插件、远程执行、预存硬链接和宿主不经过标准管线的入口需要额外隔离。ZCode Hook 启动失败/超时也不保证阻断，必须增加启动诊断与宿主级强制策略，实测后才能宣称 enforced。

DSH guard 只覆盖使用标准工具执行管线的执行器；自定义执行器、PTC 外层与子调用、子 Agent 继承均需验证。不能把一次回调拒绝称为整个 Agent 的不可绕过安全边界。

## 6. 证据标准

每轮记录：代码树或提交摘要、命令、Node/宿主/模型版本、通过/失败/跳过数量、环境和未运行项。unit、protocol-contract、host-integration、live-model、device 五类证据分开。没有执行的命令不得写成成功。

验收至少包括：两边工具名及参数映射、恶意路径/符号链接、损坏配置、未知工具、缺少审批、审批重放、取消、中断恢复、付费调用预算拒绝、上游版本漂移、用户自有文件不被覆盖。

## 7. 首批实现范围与下一步

本轮目标：M0 的锁文件与盘点基础；M1 的策略核心、审批绑定、ZCode Hook 与 DSH guard 接线及离线回归。完成后在 README 和测试报告列出实际范围，不宣称 M2–M4 已完成。

接续优先级：真实宿主离线集成 → 技能生成器和安装注册 → /investigate、/review 纵向真实执行 → 子任务/审批/恢复 → 浏览器 QA → ship → 全量功能组。

## 8. 审查过的上游依据

- gstack：docs/ADDING_A_HOST.md、docs/hosts.md、README.md。
- ZCode：apps/zcode-cli/docs/usage/09-hooks.md；同步 Hook、trust digest 与错误行为。
- DSH：packages/core/tools/src/contracts.ts、packages/core/tools/README.md、docs/tool-execution-pipeline.md；guard 在 pre-execute 之后执行。
- DSH Claude Hook bridge：packages/experimental/hooks-claude-code/README.md；不能把部分协议兼容误判为完整等价。

这些文件均应按第 2 节固定提交访问。后续实现引用具体文件、必要时记录 blob 摘要。

## 9. 2026-10-29 全库范围审计修复

基线 15c32ae（0.4.32），修复交付 0.4.33。详见 [本轮审计](AUDIT-2026-10-29.md)。新增执行边界网关复验、输出脱敏/大小限制、备份清理内容证明、安装父目录链接拒绝、缓存校验及发布 hook 用户文件保护。此次是质量修复，不将任何未完成的 M2–M4 项提升为已验收。


## 10. 2026-10-30 M3 offline host-lifecycle implementation

The command-alias gap is implemented as a rewritten copy, not a symlink. Two additional offline-capable lifecycle components are added:

- DSH profile scaffold generator: writes a disposable profile with the required Cordis dependency chain (`@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-tools`, native guard, skills index). The local plugin packages re-export the repository adapters by file URL. It does not install packages or touch user DSH home.
- ZCode workspace config planner/apply/uninstall: previews without mutation by default, merges while preserving unrelated config, uses a per-workspace lock and optimistic concurrency, and removes only the exact owned hook. CLI apply requires explicit `--apply`.

These are contract-level offline implementations. They do not replace fresh-session trust/activation checks, and do not upgrade host certification. The work branch and PR must pass Linux/Windows CI and code review before the milestone is considered accepted.
