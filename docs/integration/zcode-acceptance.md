# ZCode 受控接入验收手册（新会话安装与验收）

日期：2026-10-27。范围：操作员在本机**新 ZCode 会话**中安装 gstack861 PreToolUse 守卫并逐项验收的步骤。本手册与 [README「ZCode 接入」](../../README.md) 保持一致并展开为可执行清单；两者冲突时以 README 为准并回报本项目。

## 0. 状态与出处约定（先读）

本项目**尚未在任何真实 ZCode 会话中执行过本手册**（`npm run doctor` 输出 ZCode 为 `workflow-harness-verified-offline`、DSH 为 `ship-and-recovery-vertical-verified-single-keyed-runs`——两者均非 host-verified；`upstream.lock.json` 中 ZCode `3c5b227649371507ddc4eb46ac5133afe6db1cab` 为 `source-inspected` / `not-run`）。因此本文每条断言标注出处，分三类：

- **[仓库已验证]**：本仓库测试（`npm test`，含真实 Node Hook 子进程）已覆盖的行为，标注测试文件/用例名。
- **[固定提交源码]**：固定提交 ZCode `3c5b227` 的源码/文档结论，出处为 [Claude 审查报告](../reviews/2026-10-27-claude-review.md) 附录 C 核对过的文件位置（本文不复制宿主源码）。
- **[验收项]**：宿主侧行为，本仓库不断言结果，须由操作员按下文清单在新会话中实测确认——这正是本手册存在的目的。

付费模型调用：本手册流程 0 次（探针命令不经过模型；会话内验收对话产生的宿主调用按宿主自身计费规则，与本项目无关）。

## 1. 前提

1. Node.js 22+、本仓库检出（`npm run check` 通过）。
2. 一个**受控试验工作区**（先用临时/试验项目验收，勿直接上生产工作区；README 同此建议）。
3. ZCode 宿主为固定提交对应的版本线；宿主侧 Hooks 机制、设置文件位置与格式、Hook 信任流程**以固定提交文档为准**：`apps/zcode-cli/docs/usage/09-hooks.md`（核对位置见审查报告附录 C）。**[固定提交源码]**

## 2. 准备策略文件（只绑 Read/Write/Edit）

策略模板见 [`examples/policy.example.json`](../../examples/policy.example.json)。验收用最小样例（占位路径替换为**真实存在的绝对目录**）：

```json
{
  "schemaVersion": 1,
  "workspace": "/absolute/experiment-workspace",
  "readRoots": ["/absolute/experiment-workspace"],
  "writeRoots": ["/absolute/experiment-workspace/src"],
  "protectedRoots": [],
  "bindings": {
    "zcode": {
      "Read": { "effect": "read", "pathKey": "file_path" },
      "Write": { "effect": "write", "pathKey": "file_path" },
      "Edit": { "effect": "write", "pathKey": "file_path" }
    },
    "dsh": {}
  }
}
```

硬性约束（全部 **[仓库已验证]**，`src/policy.mjs` `compilePolicy`/`loadPolicy`；`test/policy.test.mjs`）：

- 所有目录必须是绝对路径且真实存在（`DIRECTORY_REQUIRED`/`ABSOLUTE_PATH_REQUIRED`）；workspace 不能是文件系统根（`FILESYSTEM_ROOT_FORBIDDEN`）；read/write/protectedRoots 必须在 workspace 内（`ROOT_OUTSIDE_WORKSPACE`）。
- **策略文件必须放在 workspace 之外**（`POLICY_MUST_BE_OUTSIDE_WORKSPACE`），≤64 KiB、普通文件、非符号链接、硬链接数 1（`UNSAFE_POLICY_FILE`）。
- 权限：POSIX 上必须属主可写、组/其他不可写（`0600` 建议；`UNSAFE_POLICY_PERMISSIONS`）。Windows（win32）**跳过 mode 位检查**——依靠 NTFS ACL 限制读取，这是代码现状而非疏漏。
- `workspace/.git` 自动加入保护，无需手写；VCS 目录写一律拒绝（`PROTECTED_PATH`，含嵌套仓库、worktree 指针与 8.3 短名变体，见 `src/policy.mjs` 机制注释）。
- 只绑定审查过的真实文件工具。**不要**把 Bash/MCP/子任务伪装成文件工具（README 同此）。

## 3. 生成 Hook 配置片段

```sh
node bin/gstack861.mjs zcode-config --policy /absolute/private/policy.json --matcher 'Read|Write|Edit'
```

- `--policy` 必须绝对路径；策略会被真实加载校验，非法即退出码 1 并输出 `gstack861: <CODE>`（`bin/gstack861.mjs`）。**[仓库已验证]**
- `--matcher` 缺省 `.*`（拦下宿主全部工具调用，包括未映射工具——保守但很吵）；`Read|Write|Edit` 把 Hook 范围收窄到策略绑定的文件工具，matcher 之外的工具**根本不进入本守卫**，只依赖宿主自身权限门（README）。matcher 必须可编译为正则，生成器拒绝 `*`、`\`、`a**b` 等（保守输出选择，`src/adapters/zcode.mjs`；`test/adapters.test.mjs`「matcher refusals are a conservative emission choice」）。**[仓库已验证]**

输出（stdout，**不改写任何文件**，`test/adapters.test.mjs`「CLI config generation does not modify existing files」）：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Read|Write|Edit",
          "hooks": [
            {
              "type": "process",
              "command": "<运行 zcode-config 的那个 node 的绝对路径>",
              "args": [
                "<仓库>/bin/gstack861.mjs", "hook", "zcode", "--policy", "/absolute/private/policy.json"
              ],
              "timeoutMs": 10000
            }
          ]
        }
      ]
    }
  }
}
```

要点（**[仓库已验证]**，`src/adapters/zcode.mjs` `zcodeHookConfig`；`test/adapters.test.mjs`「argv, not shell interpolation」）：

- `command` 是 `process.execPath`——**用哪个 node 跑 `zcode-config`，Hook 以后就用哪个 node**；路径含空格无妨（argv 数组传参，不经 shell 拼接）。
- `timeoutMs` 固定 10000（见第 6.F 节验收）。
- 该命令**不修改用户设置、不自动授予 Hook 信任**（README）。

## 4. 合并进 ZCode 设置并确认信任摘要（新会话）

1. 备份当前 ZCode 设置文件。
2. 按固定提交 ZCode 的 Hooks 文档（`apps/zcode-cli/docs/usage/09-hooks.md`，出处见审查报告附录 C）把上面片段的 `hooks` 节合并进设置。**[固定提交源码]** 合并前逐字审查 `command` 与 `args`。
3. 创建**新会话**：宿主加载 Hook 时要求人工信任并展示 trust digest——**核对 digest 与你合并的片段中 `command`+`args` 完全一致后才信任**（README「按固定版本 ZCode 的 Hooks 文档合并配置并审查 trust digest，创建新会话验证」）。digest 确认的具体呈现形式以固定提交文档为准。**[固定提交源码/验收项]**
4. 信任摘要绑定的是命令内容：之后移动仓库/策略文件或换 node，都会使已信任配置与实际命令不一致，须重新合并并重新确认。**[固定提交源码]**

## 5. 离线探针（合并前先跑，不需要宿主）

以下命令在仓库根执行（Git Bash；`/absolute/...` 换成你的真实路径）。它们直接调用 Hook 入口子进程，形态与宿主调用完全相同：

```sh
# 范围内写（writeRoots 内、不存在的文件）：应输出 {} 且 exit 0
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"/absolute/experiment-workspace/src/new-file.txt"}}' \
  | node bin/gstack861.mjs hook zcode --policy /absolute/private/policy.json; echo "exit=$?"

# 越界写（workspace 内但不在 writeRoots）：应输出下方 deny 且 exit 2
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"/absolute/experiment-workspace/notes.txt"}}' \
  | node bin/gstack861.mjs hook zcode --policy /absolute/private/policy.json; echo "exit=$?"

# 受 VCS 保护路径：应 deny 且 exit 2——本样例策略 writeRoots=[src] 时码为 OUTSIDE_SCOPE（src/policy.mjs 先查写根后查保护根）；要观察 PROTECTED_PATH 本码，把样例策略 writeRoots 改为整个 workspace 后重试（policy.test.mjs「VCS metadata remains protected...」即此情形）
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"/absolute/experiment-workspace/.git/config"}}' \
  | node bin/gstack861.mjs hook zcode --policy /absolute/private/policy.json; echo "exit=$?"
```

预期输出形态（**[仓库已验证]**，`src/adapters/zcode.mjs`；`test/adapters.test.mjs`「real hook subprocess accepts a valid request and refuses an out-of-scope request」）：

- 放行 = 弃权（abstain）：stdout `{}`，exit 0。**空结果不是预批准**——宿主自身权限检查原样保留。
- 拒绝：exit 2，stdout：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "gstack861:OUTSIDE_SCOPE"
  }
}
```

拒绝码一览（`src/policy.mjs`、`bin/gstack861.mjs`）：`OUTSIDE_SCOPE`（越出对应读写根）、`PROTECTED_PATH`（VCS/受保护根）、`UNMAPPED_TOOL`（matcher `.*` 下未绑定工具）、`MISSING_PATH`、`PATH_TRAVERSAL`、`INVALID_PATH_OR_CALL`、`INVALID_EVENT`、`UNSAFE_WRITE_TARGET`（目标已存在且非普通文件或硬链接数 >1）、`INPUT_TOO_LARGE`（stdin 超 4 MiB，0.3.0 起；`toolInput` 双份发送使有效内容约减半）、`CWD_REQUIRED`（相对路径或缺 `cwd` 的 apply-patch 绑定调用）、`UNSAFE_POLICY_FILE`/`POLICY_MUST_BE_OUTSIDE_WORKSPACE`（策略文件本身不合规）、`HOOK_INPUT_OR_POLICY_ERROR`（其余启动/解析失败，fail-closed）。除显式列出的码外，一切异常都收敛为拒绝而非放行。

## 6. 新会话验收清单

逐项执行并记录结果（这是 ZCode 宿主验证的原始证据；通过与否都请回填到证据文档）。

| # | 项 | 操作 | 预期 | 出处 |
|---|---|---|---|---|
| A | 安装生效 | 完成第 4 节后在新会话发起一次范围内 Read | 宿主加载了 Hook（无启动报错）；读取正常 | 验收项 |
| B | 放行 = 弃权，不越过宿主权限 | 让模型写 `writeRoots` 内文件 | 守卫不拦截；**宿主自身权限提示/策略仍照常生效**（守卫永不预批） | [仓库已验证] 弃权语义（`src/adapters/zcode.mjs` 注释）+ `test/adapters.test.mjs`「abstaining result」；宿主侧表现为验收项 |
| C | 越界拒 | 让模型写 `writeRoots` 外、workspace 内文件 | 工具调用被拒，理由含 `gstack861:OUTSIDE_SCOPE`；目标文件未被创建 | [仓库已验证] 同上探针；会话内链路为验收项 |
| D | VCS 保护 | 让模型改 `workspace/.git/` 下文件 | 拒绝：样例策略（writeRoots=[src]）下码为 `OUTSIDE_SCOPE`；writeRoots 改为整个 workspace 时为 `PROTECTED_PATH`（保护根检查仍生效，二者皆正确拒绝） | 同 C |
| E | 启动失败 fail-closed | 临时把片段中 `--policy` 指向不存在的路径（或临时改坏策略文件权限）再触发一次范围内调用；随后还原 | 该次调用被拒（`gstack861:HOOK_INPUT_OR_POLICY_ERROR` 或策略专属码），**绝不静默放行**；用第 5 节探针可离线复现诊断 | [仓库已验证] `test/adapters.test.mjs`「denies invalid JSON, missing policy, and oversized payloads」 |
| F | 超时行为 | 在**一次性验收用**设置里把 `timeoutMs` 改为 `1`，触发一次范围内调用，观察并记录宿主处置（放行/拒绝/报错）；测完还原 `10000` | 记录实测结果。本仓库**不断言**宿主超时语义——`timeoutMs: 10000` 只是片段设定值 | 片段值 [仓库已验证]；超时处置为验收项（README「仍需宿主级验证」） |
| G | updatedInput 共存禁令 | 审计该设置里**所有其他** Hook/插件：任何一个都**不得**返回 `updatedInput` | 必须为 0 个，否则本守卫验收不通过（见下） | [固定提交源码] 审查报告 §二.6 |
| H | 回滚 | 见第 7 节 | 干净移除，无残留 | [仓库已验证] 未改写任何文件 + 验收项 |

**G 项依据（必须原文知晓）**：ZCode 中所有 PreToolUse Hook 依次执行但拿到的是**同一份原始输入**（`packages/core/src/hooks/runner.ts`）；任一 Hook 返回的 `updatedInput` 按「最后写入者胜」合并（`hooks/output.ts` 的 `mergeHookRunResult`）；合并后的输入只做 schema 校验、**不会重跑 Hook**（`tool/executor/call-runner.ts`）；之后 PermissionRequest Hook 还能再改输入（`tool/executor/hook-flow.ts`）（出处：审查报告 §二.6，对照固定提交 `3c5b227`）。因此只要存在会改写输入的 Hook/插件，本守卫的弃权/拒绝就可能作用于**过期路径**——该约束属于宿主接入验收项，代码无法强制（README「安全与状态边界」同此）。

## 7. 回滚

1. 还原第 4 节第 1 步的设置备份，或从设置中删除合并进去的整个 `hooks` 节（只删本守卫的 `PreToolUse` 条目，勿动其他配置）。
2. **新开会话**确认：无 Hook 信任提示、工具调用不再出现 `gstack861:` 拒绝。
3. 策略文件可保留或删除。除设置文件外，安装过程**没有写入任何其他位置**（`zcode-config` 只输出片段；Hook 运行时不落盘）。**[仓库已验证]**

## 8. 已知边界（引用，不在此重复）

- 守卫不是操作系统沙箱；TOCTOU、恶意同用户进程、宿主旁路执行器不在保障内——见 README「安全与状态边界」。
- `ApplyPatch` 形态的修改自 0.3.0 起可通过 `parser: 'apply-patch'` 绑定评估（V4A 信封解析，逐路径全量写保护）；本手册样例策略未包含该绑定，故验收会话中此类调用仍被拒，属预期（绑定方法见 `src/policy.mjs` 与 `test/policy.test.mjs`）。
- stdin 4 MiB 上限（0.3.0 起）与 `toolInput` 双份发送的实际有效上限（审查报告 §二.8 描述的是提升前状态）。
- 强范围保护（默认 `.*` matcher）会拒绝所有未映射工具，不是常规开发流程的完整安全安装（README「ZCode 接入」）。

## 9. 验收后的证据

把第 6 节逐项结果（含命令、输出摘要、时间、环境）记录进 `docs/verification-*.md` 对应轮次；在此之前，ZCode 宿主层保持非 host-verified（`npm run doctor` 显示 `workflow-harness-verified-offline`——离线工作流证据，仍非宿主认证），不得升级为 `host_verified`。
