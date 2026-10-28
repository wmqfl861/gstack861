# DSH 纵向验证证据：技能运行时消费 + allow 路径 + toolRewrites 渲染差异（202-10-27 批次 12）

范围：`node scripts/verify-dsh-vertical.mjs` 两项密钥任务全部通过（exit 0）+ 本地 CI 同款重渲染差异实证。密钥处理同第十八轮（~/.dsh refs → 仅子进程 env，零打印零落盘）。本批密钥任务恰 2 个（上限内），用量 ~13.6k tokens。

## 任务 A：边界②运行时消费（技能索引 → 真实读取）

指令（123/200 字符）："Read the SKILL.md of skill review listed in the gstack861 skills index, then output verbatim the line containing G861-MARK."

真实流水（节选）：

```
thinking: The path is given: <ws>\skills\review\SKILL.md   ← 模型从注入索引取得路径
tool_call: {"tool":"read","input":{"file_path":"<ws>/skills/review/SKILL.md"}}
tool_result: 8 行文件内容（含 G861-MARK-e1e800d4: c7de2bff-9c28c87f14，28 位随机十六进制不可猜标记）
final: G861-MARK-e1e800d4: c7de2bff-9c28c87f14              ← 逐字匹配，PASS
```

判定链：索引只暴露 name|description|path——标记行只能来自真实读文件；guard 未拒绝（read 在 readRoots 内）。**gstack861-skills 注入被模型真实消费：实证（单次密钥运行）。**

## 任务 B：allow 半边（范围内写，guard abstain）

指令（181/200 字符）：在 `workspace/src/`（writeRoots）创建预断言不存在的唯一文件，内容 `vertical-ok`。

```
tool_call: {"tool":"write","input":{"file_path":"<ws>/src/g861-1eae0a44f8ce.txt","content":"vertical-ok"}}
tool_result: status completed, "Created file"   ← 零 gstack861: 码（abstain）
```

判定：文件存在+内容逐字+零 `gstack861:` 码——**guard 的 allow 路径首次实证**（与第十八轮的 deny 路径互补：现在双向都有真实管线证据）。

## toolRewrites 渲染差异（本地 CI 同款重渲染，bun 1.4.2）

`CI=true GSTACK861_RENDER=ci` 重渲染 → 与旧渲染（无 toolRewrites）diff：**23 个 .dsh 技能文件变化**；样例（gstack-autoplan）：

```
- ...using the Read tool.   （旧）
+ ...using the read tool.   （新）
```

六个 Read/Write/Edit 短语条目（字节等同 EXEC_STYLE_TOOL_REWRITES 子集，审查者程序化核对）在产物中生效；Bash/Agent/Grep/Glob 无据不加。**toolRewrites 实装完成（证据=渲染 diff + pipeline 工具名实拍）。**

## 状态升级与边界

- 边界①**全部完成**：管线级 deny（第十八轮）+ allow（本轮任务 B）+ 纵向最小流（技能消费+读+写）+ toolRewrites 实装（本轮）。
- 边界②**全部完成**：activation（批次 10b）+ 运行时消费（本轮任务 A）。DSH 技能装载状态 → **runtime-consumption-verified (single keyed run)**。
- 仍 blocked：旁路/PTC/子 Agent 穷尽验证、宿主内嵌 UI、GBrain、设备组——与既知边界一致。单次运行不宣称穷尽。
