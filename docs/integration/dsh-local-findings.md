# 本机 DSH 真实加载调研（Task 4，只读 + 受控冒烟）

日期：2026-10-26。范围：本机 DeepSeek Harness（DSH）安装的插件发现、配置隔离与 `ctx.tools.guard` 合同核实，以及对 `src/adapters/dsh.mjs` 的真实加载冒烟。

证据分级标注：**[实跑]** = 本次真实执行的命令与输出；**[源码]** = 从本机安装的 asar 内包源码/README 读出，未执行；**[未验证]** = 无法在本机确认，不做断言。

付费模型调用：0 次（全程未设置 `DEEPSEEK_API_KEY`、无任务文本、最小插件树不含任何 LLM 插件）。未运行 `gstack setup`，未修改 `~/.dsh` 与任何用户级配置。

## 安装位置与版本

- 安装目录：`C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness`（Electron 桌面安装）。
- 版本（[实跑] `powershell Get-Item ... .VersionInfo`）：ProductVersion `0.2.1.0`，FileVersion `0.2.1-rc.3`；asar 内 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths` 等包 `package.json` 版本均为 `0.2.1-rc.3`。
- CLI 载体（与 `~/.zcode/skills/dsh/SKILL.md` 一致）：

  ```bash
  ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals \
    "C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" ...
  ```

  内嵌 Node v24.21.0（[实跑] 以该方式执行 `node -e` 得 `node ok v24.21.0`）。
- [实跑] `... cli.js -V`（隔离 `DSH_HOME` 下）输出 `0.2.1-rc.3`，exit 0。
- [未验证] 本机安装与 `upstream.lock.json` 固定提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` 的对应关系：安装目录无法给出 git 提交号，本次未做 commit↔版本映射。

## 插件发现机制

[源码]（`@deepseek-ai/dsh/lib/bin.js`、`dsh/lib/profile-boot-C14i-8IN.js`、`@deepseek-ai/dsh-app-boot/lib/index.js`、`dsh-plugin-manager/README.md`、`dsh-base/README.md`）：

- 没有目录自动扫描。profile 是 `$DSH_HOME/profiles/<name>/` 目录，组合顺序为：`package.json` 的 `dsh.profile.bundles`（有序 bundle 层；in-box 包从安装树 node_modules 解析，外部包经 profile 的 pnpm 依赖安装）→ profile 自身 `cordis.patch.yml` → home 层 `$DSH_HOME/cordis.patch.yml` → `--patch <path>` 叠加层（可重复）→ telemetry 开关。
- 条目格式 `- { id, name, disabled, config }`（可 `!!js` 表达式）；`name` 是包名（可含子路径），经 PluginPackages 运行时解析：安装闭包 + profile `node_modules` 下、`package.json` `dependencies`/`peerDependencies` 已声明且 `<profile>/node_modules/<name>/package.json` 存在的包。**[实跑]** 手放普通目录（不经 pnpm）即可被发现并加载（见冒烟）。
- `dsh plugin --profile <name> add <spec>` 把 spec 转发给 profile 目录内的 pnpm（支持 `file:`/`link:`/registry spec）。**[未验证]** 本次未运行（会触发 pnpm/可能联网）。
- [实跑] 依赖链发现：`gstack861-guard`（`inject: ['tools']`）等待 `tools` 服务，而 `@deepseek-ai/dsh-tools` 自身等待 `systemPrompt` 服务（由 `@deepseek-ai/dsh-system-prompt` 提供）——最小可用树必须同时挂 `system-prompt` 与 `tools`（或直接用 `dsh-base` 基座 profile）。

## 配置格式与隔离方式

- 格式：YAML patch 列表；profile 根 `cordis.yml` 固定为空列表 `[]`（每次启动重写）；patch 以 `insert` 插入、按 `id` 整体覆盖（`config` 是整值替换不是合并）。
- 实用旗标：`--profile <name>`、`--patch <path>`、`--dump-config`（只合成配置树、不挂载插件）、`--dump-config-schema`、`--dump-default-config`、`--from-default-profile`。
- 隔离：[源码] `DSH_HOME` 环境变量整体覆盖 harness home（profiles、sessions、credentials、storages 全在其中；空串视为未设置）；另有 `DSH_AGENTS_HOME` 覆盖共享 agent 配置根（默认 `~/.agents`）。
- **[实跑]** 隔离核验：`DSH_HOME` 指向 temp 目录后，`--dump-config` 输出头显示的 patch 路径即为 temp 路径；全部冒烟运行后 `~/.dsh` 无任何新写入（既有条目 mtime 17:18–18:05，早于冒烟时刻 23:2x；`~/.dsh/sessions` 中无 temp cwd 对应的 slug）。

## ctx.tools.guard 是否存在于该版本

**存在，且合同与适配器预期一致。**

- [源码] `@deepseek-ai/dsh-tools/lib/index.js`（本机 0.2.1-rc.3 编译产物）：`guard(guardFn)` 方法注册"单调同步 guard"，位于可扩展 `tools/pre-execute` waterfall **之后**；guard 返回字符串即拒绝（工具结果为 `Error: <reason>`，isError），返回 `undefined` 放行；没有任何后续监听者能把拒绝改回允许；注册返回精确 disposer。裸 ctx 注册为全局，经 `agent.ctx` 注册仅对该 agent 生效。执行时序（`prepareExecution`）：pre-execute 判 `allow` 才询问 guard（deny/ask 路径不经过 guard）；guard 前另有 `callerCancelled`（signal 已中止 → 直接 aborted 结果）。
- [源码] guard 收到的 exec 对象字段：`token`、`callId`、`rootCallId`、`name`、`signal`（AbortSignal）、`arguments`（深冻结 JSON 快照）、可选 `agent`/`parent`/`schema`、`deferContext()`、`concludeTurn()`。与适配器使用的 `exec.name`、`exec.arguments`、`exec.signal.aborted` 兼容。
- **[实跑]** 执行级证据：负控 profile 中适配器 `apply()` 第 8 行（`typeof ctx?.tools?.guard !== 'function'` 检查）通过、到第 9 行才抛 `POLICY_PATH_REQUIRED` —— 即真实运行中 `ctx.tools.guard` 是函数。

## 受控冒烟（命令、策略、真实输出）

条件：隔离 `DSH_HOME`（OS temp 下 `C:/Users/Administrator/AppData/Local/Temp/dsh-gstack-smoke/home`），`env -u DEEPSEEK_API_KEY`，`DSH_TELEMETRY_DISABLED=1`，cwd 为 temp 沙盒，无任务文本 → 不可能有付费模型调用。适配器加载方式：temp 内 shim 包 `gstack861-guard`（`package.json`: `"name":"gstack861-guard","type":"module","main":"index.mjs"`；`index.mjs` 仅一行 `export * from 'file:///C:/.../gstack861/src/adapters/dsh.mjs';`），即 **加载的是仓库中未改动的真实适配器**（repo 本身不是可安装包，故用 shim 转出口）。

沙盒 profile（`home/profiles/gstacksmoke/`）：`package.json` 声明 `dependencies: {"gstack861-guard": "*"}` + `dsh.profile.bundles: []`；`cordis.yml` 为 `[]`；`cordis.patch.yml`：

```yaml
- insert:
    - id: system-prompt
      name: '@deepseek-ai/dsh-system-prompt'
      config:
        personaPrefix: ''
    - id: tools
      name: '@deepseek-ai/dsh-tools'
    - id: gstack861-guard
      name: 'gstack861-guard'
      config:
        policyPath: 'C:/Users/Administrator/AppData/Local/Temp/dsh-gstack-smoke/policy.json'
```

策略文件 `policy.json`（workspace 为 temp 下已建空目录，策略文件在 workspace 之外，满足 `loadPolicy` 约束）：

```json
{
  "schemaVersion": 1,
  "workspace": "C:/Users/Administrator/AppData/Local/Temp/dsh-gstack-smoke/workspace",
  "readRoots": ["C:/Users/Administrator/AppData/Local/Temp/dsh-gstack-smoke/workspace"],
  "writeRoots": [],
  "protectedRoots": [],
  "bindings": { "zcode": {}, "dsh": {} }
}
```

统一调用形式（下文以 `dsh` 代指完整的 exe + `--expose-internals` + cli.js 路径，路径见「安装位置与版本」）：

```bash
cd /c/Users/Administrator/AppData/Local/Temp/dsh-gstack-smoke
env -u DEEPSEEK_API_KEY DSH_HOME='C:/Users/Administrator/AppData/Local/Temp/dsh-gstack-smoke/home' \
  DSH_TELEMETRY_DISABLED=1 ELECTRON_RUN_AS_NODE=1 '<exe>' --expose-internals '<cli.js>' --profile <name> [...]
```

**1) `--dump-config`（只合成，不挂载）[实跑]**

```
# == C:\Users\Administrator\AppData\Local\Temp\dsh-gstack-smoke\home\profiles\gstacksmoke\cordis.patch.yml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    personaPrefix: ''
- id: tools
  name: '@deepseek-ai/dsh-tools'
- id: gstack861-guard
  name: gstack861-guard
  config:
    policyPath: C:/Users/Administrator/AppData/Local/Temp/dsh-gstack-smoke/policy.json
exit=0
```

**2) 正控第一次（尚未加 `system-prompt` 条目）[实跑]** —— 插件被发现并导入，但两条目 pending：

```
dsh: warning: 2 entries did not activate
tools (@deepseek-ai/dsh-tools): pending (waiting for service: systemPrompt)
gstack861-guard (gstack861-guard): pending (waiting for service: tools)
exit=0
```

**3) 正控最终版（如上完整 patch）[实跑]**：无任何输出，`exit=0`。无 "did not activate" 警告 = 三个条目全部激活（loader 对未激活条目必打印警告，见 2/4）。

**4) 负控（`gstackneg`：同样三条目，但 guard 条目无 `config.policyPath`）[实跑]**：

```
dsh: warning: 1 entry did not activate
gstack861-guard (gstack861-guard): Error: POLICY_PATH_REQUIRED
    at new apply (file:///C:/Users/Administrator/.zcode/workspace/9c06bcdc-025c-4764-9ec1-da6db48d1f77/gstack861/src/adapters/dsh.mjs:9:53)
    at Fiber.execute (file:///C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:1068:24)
    ...
exit=0
```

堆栈直接指向仓库真实文件 `src/adapters/dsh.mjs:9:53`：证明 (a) 真实适配器 `apply()` 在真实 DSH 中执行；(b) 第 8 行 `ctx.tools.guard` 函数检查在该配置下通过；(c) 配置缺失时按设计失败于激活而非静默。结合 3)：正控中 `apply()` 走完（含 `loadPolicy` 成功与 `ctx.tools.guard(...)` 注册）。

**5) 隔离核验 [实跑]**：见「配置格式与隔离方式」末条；`~/.dsh` 未被触碰，temp home 内仅 profiles 目录，无 `logs/`、无 sessions 写入。

冒烟边界：只验证「加载/激活 + guard 合同存在 + 配置传递」，未执行任何工具调用，因此 guard 回调的拒绝路径（`gstack861:*` 理由串进入工具结果）未在真实执行管线中触发，仍属 contract_tested 而非 host_verified 的工具执行级证据。沙盒保留在 `C:/Users/Administrator/AppData/Local/Temp/dsh-gstack-smoke`（temp 目录，不影响用户配置）。

## 对 src/adapters/dsh.mjs 的差异清单

1. **依赖闭包不足**：`inject: ['tools']` 之下 `dsh-tools` 自身还等待 `systemPrompt` 服务；最小树需同时挂 `@deepseek-ai/dsh-system-prompt` + `@deepseek-ai/dsh-tools`，或采用 `dsh-base` 基座 profile（[实跑] 见冒烟 2/3）。安装片段生成时必须包含这一闭包。
2. **启动失败语义**：`apply()` 抛错不会中止 boot——输出 `dsh: warning: N entries did not activate` 后退出码仍为 0，其余插件照常运行（即宿主可在无 guard 状态下继续运行，进程级不是 fail-closed）。适配器的"invalid policy fails activation"成立（条目确实未激活），但集成验收必须解析该警告输出，不能只看退出码。
3. **guard 时序**：guard 仅在 `tools/pre-execute` waterfall 判 `allow` 后被询问；`exec.signal` 已中止时管线在 guard 之前另有 `callerCancelled` 拦截——与适配器 `exec?.signal?.aborted → 'gstack861:CANCELLED'` 分支同向、不冲突。
4. **exec 形状**：真实 exec 含 `name`/`arguments`（深冻结快照）/`signal`/`token`/`callId`/`rootCallId`/可选 `agent`/`parent`/`schema` 等；适配器的可选链访问兼容，无需改动 [源码]。
5. **打包形态**：适配器经相对导入 `../policy.mjs`；成为真实 profile 依赖需可安装包（包名 `gstack861-guard`，ESM，包含两文件）。本次用 shim re-export 加载了未改动的源文件；正式安装走 `dsh plugin --profile X add <spec>`（pnpm）或手放 `node_modules` + `dependencies` 声明（两者均已被发现机制接受，前者 [未验证]）。
6. **配置传递**：条目 `config.policyPath` 原样到达 `apply(ctx, config)`（正/负控实测）；注意 patch 对 `config` 是整值替换，安装片段需一次性写全。
7. **版本映射**：本机 0.2.1-rc.3 与锁文件提交 `22ddee37...` 的对应关系 [未验证]；升级基线时需先补此映射再做回归。

## 附录（2026-10-27，批次 10b 计划审查补录）：systemPrompt/tools 服务 API [源码]

自本机安装（0.2.1-rc.3，版本↔提交映射仍未验证——第 7 条注意事项不变）的 app.asar 直读：

- `@deepseek-ai/dsh-system-prompt`（lib/index.js + README）：`SystemPrompt extends Service`，提供服务名 `systemPrompt`；消费者以 `inject: ['systemPrompt']` 声明。**对外加性 API**：`section({ name, order, text, interpolate?, complete? })`——在调用上下文注册有序提示节，返回精确 disposer；README「Contribute a prompt section」明示外部贡献可用任意有限 order（示例 order:100）；同名层内重复抛错、非有限 order 抛 TypeError。另有 `context()`（动态事实）、`variable()`、`tools()`（schema 提供者）。`personaPrefix` 是该插件自身配置物化为 `deployment:persona-prefix`（order 0）——**不是**扩展点。
- `@deepseek-ai/dsh-tools`（lib/index.js）：`ctx.tools.register(definition)` 可注册工具（全局或 agent 作用域，返回 disposer，需 `output { schema, render }`）——真实但重于 section，索引场景不需要。
- 宿主 `SECTION_ORDERS`（同 asar）：`TOOL_COMPUTER_USE=3000`、`MCP_SERVERS=3100` 等——外部节取 3050 落于其间。
- 机制裁定：gstack861-skills 插件采用**单一 inject systemPrompt + section(name:'gstack861:skills', order:3050, interpolate:false) + 返回 disposer**；拒绝的替代方案：personaPrefix 搭载（他人配置、无生命周期）、工具注册（需 schema/render，索引场景过重）。
