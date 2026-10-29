# 批次 32 计划：STEPS §4 G——updatedInput 共存审计（静态+运行时双证）（2026-10-29）

## 目标

关闭 STEPS §4 遗留 **G（与其他 Hook/updatedInput 共存审计）**。约束原文（README 安全边界节）：守卫的弃权作用于原始输入，任何返回 `updatedInput` 的 Hook/插件按"最后写入者胜"在其后合并——故**本守卫不得与任何返回 updatedInput 的 PreToolUse 钩子共存**。

## 审计方法（全离线、只读）

三层证据：
1. **脚本层**：本机与守卫共存的唯一钩子 = 用户级 SessionStart superpowers 钩子（`~/.zcode/cli/config.json` 事件清单实测仅此一条；验收工作区另有守卫自身的 PreToolUse）。读该钩子脚本 + 安全试运行（只读+打印）：grep `updatedInput` 零命中；实际输出形如 `{"additionalContext": "…"}`。
2. **宿主 schema 层**（bundle 反解）：`hookSpecificOutput` 判别联合中 **`updatedInput` 字段仅存在于 PreToolUse 变体**；SessionStart 变体只携带 `additionalContext`——结构上 SessionStart 钩子不可能返回 updatedInput。
3. **运行时层**（既有证据复用）：批次 27 桌面验收会话在本机**全插件栈**（10 个官方插件）+ superpowers 钩子共存下运行——日志中唯一的钩子事件是 superpowers SessionStart 失败一条；守卫的 PreToolUse deny 三次全部以正确载荷生效（outside/.git/E 探针），弃权路径未受任何共存者干扰。插件缓存目录 grep PreToolUse 钩子注册：无命中。

## 结论落盘

G 判定：**共存约束满足**（本环境与守御共存的钩子均不返回 updatedInput；PreToolUse 事件上无其他钩子）。写入 batch-27 证据文档补充 4 + VERIFICATION 第四十二轮 + OFFLINE-COMPLETE 3b 遗留更新（G 完成，余 F/H 桌面交互）。

## 密钥预算

0（纯静态审计+既有证据复用；钩子试运行零模型调用）。

## 流程

计划（本文件）→ 独立审计划 → 审计执行（上述三层命令重跑留档）→ 独立审成果 → 0.4.31 文档 → 摘要 → push → CI 3/3。

## 风险

| 风险 | 对策 |
|---|---|
| 试运行钩子有副作用 | 只读审计其源码后运行；脚本仅 cat+printf（已读全文确认） |
| "共存约束满足"被误读为普适 | 措辞限定"本机当前环境"；README 约束本身不变（部署前提） |

## 非目标

- F（超时探针，桌面交互）/H（UI 回滚，桌面交互）——仍为用户侧遗留。
- 任何代码/测试改动（零改动批次）。

## 审计划必改落实（2026-10-29，独立审计划 3 项，建议 4 条全采纳）

1. **Schema 措辞更正**：updatedInput 存在于 PreToolUse 变体（直接字段）**与 PermissionRequest 变体的 decision.allow 分支**（运行时映射 decision:"modify"/modifiedInput @~5163397）；SessionStart/UserPromptSubmit/PostToolUse/PostToolUseFailure/Stop 五变体仅 additionalContext，运行时处理函数 SessionStart 分支同样只读 additionalContext。本机 PreToolUse 与 PermissionRequest 事件上均无其他注册钩子（宿主自报 hookCount:0）。
2. **合并路径引证**：Gvo=mergeHookRunResult @~5236066 `t.updatedInput!==void 0&&(e.updatedInput=t.updatedInput)`（钩子间最后写入者胜）；消费点仅限 PreToolUse 授权（~12838735 输入交换）与 PermissionRequest（~12848913）——正是 G 审计的共存面。
3. **运行时腿工件钉死**：全量日志 `~/.zcode/cli/log/zcode-2026-10-29.jsonl`（行 38750，session_3ffdfab2 过滤），非仓内摘录（摘录零钩子事件——只含 create/tool-call）。
4. 建议采纳：plugin 行引宿主自报（hookCount:0, enabledPluginCount:11, pluginCount:15）；两配置快照哈希入档；脚本描述改"只读 SKILL.md + printf/cat 输出，零写入"；补充 superpowers 钩子在该会话实际失败（94ms 未输出）与内建 builtin.sessionMailbox.drain（additionalContext-only）两点。

## 审计执行结果（2026-10-29，协调者按修正方法重跑三层）

- **脚本层**：`~/.zcode/cli/config.json` 事件清单=恰一条（SessionStart `startup|clear|compact` → superpowers）；脚本 grep updatedInput=0；试运行输出 `{"additionalContext": …}`（零写入）。验收工作区仅守卫自身 PreToolUse。两配置 sha256 快照：用户级 7673f66549327fb2、工作区 2396879aeb6ea7b7。
- **Schema 层**：见必改 1/2。
- **运行时层**：session_3ffdfab2 全日志钩子事件恰一条（superpowers SessionStart 失败 94ms，未输出任何内容——干扰可能性为零）；宿主自报 hookCount:0；守卫三次 deny 全部正确生效。
- **G 判定：共存约束满足（本机当前环境；部署前提条款不变）**。
