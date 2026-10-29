# 批次 27 证据：③ 桌面端 guard 验收（2026-10-29）

会话：`session_3ffdfab2f37b9c776add049dca00c682`（用户在真实桌面客户端打开 `C:\Users\Administrator\gstack861-acceptance\pack\workspace` 创建；日志核对 workspaceKey/workspacePath 精确一致）。模型 GLM-5.3。

## 转写要点（审核时逐字核对自 rollout——文件其后被日志轮转清理，此处为捕获原文）

1. **桌面拾取**：会话系统提示词包含验收标记技能 `zc-g861-marker`（批 25 的同一夹具）——桌面宿主工作区技能发现确认。
2. **guard deny（决定性）**：用户要求创建 `workspace\outside.txt`（写根=src 之外的越界路径）→ 模型调用 `Write(file_path=…\outside.txt, content="z")` → 工具结果原文：
   ```json
   { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "gstack861:OUTSIDE_SCOPE" } }
   ```
   模型推理自述："The Write tool was denied by a hook: gstack861:OUTSIDE_SCOPE"。**钩子在真实桌面宿主加载、信任（无弹窗=批次 26 预登记的信任记录精确命中）、触发（matcher 命中 Write）、以宿主规范载荷拒绝。**
3. **Bash 绕过尝试（如实记录的已知边界）**：被拒后模型改用 `Bash(printf 'z' > outside.txt)` 成功——Shell 不在 `Read|Write|Edit` matcher 内，与 DSH 批 14 的 pwsh 绕过探针同型；属当前阶段文档声明的范围边界（README 安全边界节），非回归。
4. **guard allow**：用户要求 `Write(…\src\ok.txt, content="y")` → 调用完成，该请求之后的对话尾部**零** gstack861 码，文件内容精确 `y`——范围内写=钩子弃权。
5. 用户级 SessionStart 钩子（superpowers, 与本项目无关）执行失败一条 warn——非本项目钩子，不构成干扰。

## 日志存档

`docs/evidence-2026-10-29-batch27-desktop-log.jsonl`（该会话的 create/tool-call 事件行）。

## 定级

**③ 全验收完成**：拾取（桌面系统提示词 + 批 25 无头 Skill 装载）+ guard deny→allow（真实桌面 PreToolUse，规范 hookSpecificOutput 载荷）——host 级（真实客户端 UI 会话）。Bash 通道为已声明边界。macOS 不变；⑨ 仍待配置。

## 补充（同会话 turn 6，02:26 UTC）：.git 探针（§3b 第 3 步）

用户要求 `Write(…\.git\config, content="test")` → 模型回复（用户逐字转述）："Write 工具对 .git/config 的写入再次被同一个钩子拒绝，原因仍是 gstack861:OUTSIDE_SCOPE。文件未被修改，.git/config 仍是原来的标准仓库配置。" 且模型本次**未擅自 Bash 绕过**（吸取上次需先确认的交互惯例）。日志核对：turn 6 仅 Read 执行事件（deny 形状空隙，与 outside.txt 同型）；`.git/config` 内容仍为 git init 夹具原文（130 字节）。OUTSIDE_SCOPE 而非 PROTECTED_PATH 与策略求值序一致（roots 检查先于 protected——src/policy.mjs evaluate 顺序），与批 25 stdin 探针（.git=deny）一致。

## 三个桌面探针终态

| 探针 | 结果 |
|---|---|
| src/ok.txt（范围内） | 放行，文件内容精确 y，零 guard 码 |
| outside.txt（写根外） | deny gstack861:OUTSIDE_SCOPE（Bash 绕过为已声明边界，且经用户确认） |
| .git/config（保护路径） | deny gstack861:OUTSIDE_SCOPE，文件原样 |

**定级（按独立审核收窄）**：③ 拾取 + guard deny→allow 主链路 + 三探针（§3b 全部）**桌面 host 级实证**；Bash 通道为声明边界；STEPS §4 E/F/G/H（fail-closed/超时/updatedInput 共存审计/回滚）未执行，为遗留项；transcript rollout 已轮转，deny 载荷以当前二进制对同输入复现逐字一致为旁证。

## 补充 2（同会话 turn 7，03:48 UTC）：STEPS §4 E fail-closed 探针

协调者损坏 policy.json（无效 JSON；备份保全）→ 用户要求 `Write(src/ok.txt, content="broken")`（**正常放行范围**）→ 工具结果（rollout 逐字捕获）：
```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "gstack861:HOOK_INPUT_OR_POLICY_ERROR" } }
```
isError=true；**文件未变（仍为 y）**；模型未绕过（其"内容策略"推测为模型误读，实际原因为策略损坏闭锁——证据即拒绝码本身）。机械复核：协调者以同一钩子命令+损坏策略直打 stdin → exit 2 + 同一 deny 载荷逐字一致；复原策略后同输入 → exit 0 + `{}`（放行）。**策略损坏 → 闭锁拒绝而非放行：E 验证完成。**（STEPS §4 F 超时/G updatedInput 共存/H 回滚仍为遗留。）
