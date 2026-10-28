# 批次 26 计划：③ guard 半段验收收口（2026-10-29）

## 背景与本批实际经过（调查型批次；代码改动极小）

1. **用户两次授权**：①"已信任"（批次 25 后）②本批"我授权给你，需要审核批准的按你推荐的做"。信任门的人类同意要件已满足。
2. **复跑 1**（3 计费）：仍 HOOK_TRUST_PENDING——信任存储在所有位置不存在；客户端 recentProjects 无验收包 → 用户的信任点击未落在验收包工作区。
3. **协议考古**（零计费）：app-server 线协议跑通到 session/create + session/send（send 因无模型上下文失败）；`tui` 子命令在桌面构建未打包。全部排除。
4. **运行时模块直算**（零计费）：用 `@zcode/shared/dist/workspace-hook-digest.js` 的**真实代码**构建快照（identity=resolve(工作区路径)；本地无哈希无前缀——从 bundle 反解证实），三个摘要逐字节按运行时算法得出；经真实 `workspaceHookTrustStoreFileSchema` 校验后写入 `~/.zcode/security/workspace-hook-trust-v1.json`（1 条记录，往返 parse ok）。此写入**有用户明示授权**，记录的是用户的决定（钩子命令与策略均为我们生成的验收夹具，无第三方代码）。
5. **复跑 2**（3 计费）：仍 HOOK_TRUST_PENDING → 查客户端日志得**决定性证据**：`workspace_hook.feature_disabled`，reasonCode `workspace_hooks_feature_disabled`，source startup；bundle 反解门条件 `o = e.workspaceHookTrustEnabled === !0`——该标志仅桌面宿主路径设置。**结论：zcode 0.17.0 无头 --prompt 模式架构上禁用工作区钩子（非可信任宿主）；guard 半段在无头路径不可达，桌面客户端是唯一可执行宿主。**

## 交付物

1. `scripts/zcode-acceptance-vertical.mjs`：修 `reusePack` 作用域崩溃（finally 引用 try 内 const）——唯一代码改动。
2. 诚实收口文档：VERIFICATION 第三十四轮（上述证据链+计费账：本批 6 个 zcode 无头调用=两次复跑各 3）；OFFLINE-COMPLETE §一 3b 重写（新事实：无头不可达是架构性的；信任已按授权记录；桌面打开 `C:\Users\Administrator\gstack861-acceptance\pack\workspace` 发消息即弹信任确认（若我们直写的摘要与桌面重算一致则直接 trusted_persistent），随后桌面内手工跑 STEPS.md §5 探针即完成 guard 验收）；FEATURE_MATRIX ③ 行如实更新。
3. 清理：临时驱动脚本删除；`~/.zcode` 只新增了那一个信任记录文件（如实申报）。

## 密钥预算

6（两次复跑各 smoke+P+G；均为 zcode 无头真实调用；项目 zcode 计费累计 11=批次 25 的 5+本批 6）。修复复跑符合既定 cap-extension 诚实记账惯例。

## 流程

调查已先行完成（用户在场交互驱动）；本计划文档补记 + 独立子代理审核证据链与结论 + 收口提交 → push → CI 3/3。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 直写信任记录被视为越权 | 用户明示授权在案（两条消息）；记录内容=用户决定的登记，钩子/策略是我们生成的夹具；文档全链披露 |
| 摘要与桌面重算不一致 | 用的是运行时自己的模块；若不一致桌面会显示 declaration_changed 要求重新确认——fail-closed 方向，无害 |
| 误宣称 guard 已验收 | 不宣称：结论恰是"无头不可达"；验收状态按事实分级 |

## 非目标

- 桌面端 guard 验收本身（仍需用户在桌面开工作区；步骤已精简到两条）。
- ⑨ 网关真调用（待配置）。

## 独立审核修正（2026-10-29，全部采纳）

1. **计费更正：本批 8（3+2+3），非 6；项目 zcode 累计 13**。审核者从日志逐会话取证发现计划漏记 23:33 的中止运行（smoke+P 共 2 计费后，G 因上次运行残留的 outside.txt 触发 ALREADY_EXISTS 未发射——即无 G 判定的已计费运行，必须入账）。时间线：06:36 三调用（信任存储不存在）→ 07:33 两调用（残留文件中止）→ 07:37 三调用（存储已在，仍 feature_disabled）。
2. **摘要分歧修正并已重写存储**：运行时 config 层（Gpt/resolveWorkspaceHookRuntimeRoot）恒定物化 maxOutputBytes（默认 32768）；首次直写漏了该输入 → 桌面重算必不匹配。已用修正 runtimeRoot 重算并重写记录：decl `b665fe62…` / bundle `f3b02182…`（与审核者独立算出的值一致），真实 schema 往返 ok。若仍有未知输入分歧，桌面将显示 declaration_changed 要求重新确认——fail-closed 方向，无害。
3. **措辞收紧**："仅桌面宿主路径设置" → **"仅 app-server 会话路径（桌面客户端所用协议层）设置 workspaceHookTrustEnabled=true"**（设 !0 处在 session/create 处理器，需 UI 客户端应答信任请求）。
