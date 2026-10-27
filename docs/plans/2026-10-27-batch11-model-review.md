# 批次 11 实施计划（边界⑨机制半边：模型网关显式配置 + 独立模型复核接线）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superagents:subagent-driven-development. 紧凑批次。事实基础：蓝图第 1 节红线「所有模型调用必须使用显式配置……不回退官方端点」「未获授权不执行付费模型」；用户已在目标中授权（我同意授权）；环境中存在 OPENAI_API_KEY 但**项目不得默认盗用**——显式配置文件必须由用户亲手提供（含网关 URL），这正是本批要建的门。

**Goal:** (1) `src/gateway.mjs`：模型网关显式配置的加载与校验（schema：`{ schemaVersion, baseUrl, apiKeyEnv, model, maxTokens, note? }`；apiKeyEnv 指定从哪个环境变量取键——**键不入库**；baseUrl 必须显式、拒绝官方端点域（api.openai.com/api.deepseek.com 等黑名单=「不回退官方端点」的可执行化）；文件位置约束同 policy（绝对路径、0600、工作区外）；未加载配置时一切复核入口拒绝（fail-closed）。(2) `src/model-review.mjs`：独立模型复核执行器——输入（网关配置、审查目标 diff/文件、提示模板），经 OpenAI 兼容 `/chat/completions` 发**单次**封顶调用（maxTokens 上限、提示长度上限、超时），产出结构化裁决 `{ verdict: approve|request_changes, findings[], raw }`；**仅当 GSTACK861_MODEL_CALL=1 显式环境开关**成立才真正发请求，否则 dry 返回 `MODEL_CALL_NOT_ENABLED`（付费红线的代码化）。(3) `scripts/verify-model-review.mjs`：无键/无配置/无开关均可跑的**就绪验证**（配置校验、黑名单拒绝、dry 拒绝、假网关本地 http 冒烟——用 node:http 起本地回声服务器验证请求形状与超时，零付费）。运行时真调用待用户解锁③'：亲手放置网关配置文件并设 GSTACK861_MODEL_CALL=1。版本 0.4.9。

**Architecture:** Lane A（gateway.mjs+测试）与 Lane B（model-review.mjs+verify 脚段+测试）文件不相交；Task 3 文档+证据+终审推送。

**Tech Stack:** 仓库现状（fetch 用 node 全局 fetch；本地回声服务器 node:http）。

**Spec:** 蓝图第 1 节红线、M2「独立模型复核」项、批次 5-10 的就绪验证器模式。

## Global Constraints

- 沿用全部仓库约束；本批 0 付费调用（本地回声服务器不是真网关；MODEL_CALL 开关默认关）。
- 键永不落盘：配置只有 apiKeyEnv 名；执行器运行时读环境变量。
- 官方端点黑名单可执行化（蓝图「不回退官方端点」）：api.openai.com、api.deepseek.com、generativelanguage.googleapis.com 等的 host 匹配拒绝 `OFFICIAL_ENDPOINT_FORBIDDEN`。
- 诚实分级：本批=机制就绪+本地冒烟；真调用待解锁③'（用户放置配置+开关），FEATURE_MATRIX ⑨措辞同步。

## Review Focus

1. fail-closed：无配置/无开关/官方端点/键缺失——每条路径都必须拒绝而非降级。
2. 单次封顶：一次复核=恰好一个 HTTP 请求；maxTokens/提示长/超时三上限在代码里不可绕。
3. 回声冒烟的真实性：断言请求体形状（model/messages/max_tokens）而非仅状态码。

---

### Task 1 (Lane A): src/gateway.mjs + test/gateway.test.mjs
- `loadGateway(filename)`：绝对路径、lstat 检查（同 loadPolicy 风格：普通文件/非符号链接/nlink/大小上限 16KiB）、POSIX 0600（win32 跳过）、schema 校验（schemaVersion 1、baseUrl https? 绝对、model 非空、maxTokens 1-8192、apiKeyEnv /^[A-Z_][A-Z0-9_]*$/、note?≤256）、host 黑名单、`resolveKey()` 从 process.env[apiKeyEnv] 取（缺失→GATEWAY_KEY_MISSING）。
- 测试：合法加载；每条非法形态拒绝（官方端点两种 host、非 https、坏 schema 各字段、相对路径文件、符号链接 POSIX、键缺失）；键永不出现在任何错误/返回里。

### Task 2 (Lane B): src/model-review.mjs + scripts/verify-model-review.mjs + test/model-review.test.mjs
- `runModelReview({ gateway, target: {files:[{path,diff}]}, prompt?, fetchImpl=fetch })`：开关检查（env GSTACK861_MODEL_CALL!=='1'→`MODEL_CALL_NOT_ENABLED`）；提示组装（复核提示模板+diff，总长上限 64KiB→`REVIEW_INPUT_TOO_LARGE`）；单次 POST `${baseUrl}/chat/completions`（AbortSignal 超时 30s→`GATEWAY_TIMEOUT`）；非 2xx→`GATEWAY_ERROR`（含状态码不含响应体键）；解析 choices[0].message.content→尝试 JSON 提取 `{verdict, findings}`（解析失败→`REVIEW_OUTPUT_UNPARSEABLE` 附原文前 1KiB）；返回冻结结构。
- verify 脚本：四段（配置校验正/负、黑名单、dry 拒绝、本地回声冒烟——node:http 服务器捕获请求体断言形状后回固定合法响应；再测超时路径）；全部无键可跑；exit 0/1/2（2=无 node:http 环境等受阻——理论上不存在）。
- 测试：fake fetchImpl 注入断言单次调用与请求体；开关关→拒绝零调用；超时/非2xx/坏输出各拒绝。

### Task 3 (协调者): 文档、证据、终审、推送
- [ ] README 边界⑨更新（机制就绪+解锁③'说明：放置配置文件路径+设开关+跑 verify——一行解锁）；FEATURE_MATRIX ⑨行 planned→ready（runtime 待③'）；VERIFICATION 第十七轮 + 0.4.9 + 摘要 → 终审 → 推送 → CI 绿。
