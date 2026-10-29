# 批次 28 计划：⑨ model-review 真调用（本机显式网关）（2026-10-29）

## 授权与设计对齐

- 用户持续授权付费调用（批次 13 起 DeepSeek 密钥已用于 12 个计费任务；本批"继续开发直至收工"+"按你推荐做"）。
- 蓝图红线："所有模型调用必须使用显式配置，配置版本绑定任务与审批"——本批的网关配置是**操作员显式创建**的自定义网关（本机 HTTPS 127.0.0.1），**不是**官方端点回退：`loadGateway` 黑名单（api.openai.com/api.deepseek.com/generativelanguage…）继续生效且被尊重——网关脚本向 DeepSeek 的转发是网关自身职责，与 model-review 引擎的防回退构造无关（同"任何自定义网关最终都连某家模型 API"）。
- 密钥纪律不变：DEEPSEEK_API_KEY 从 ~/.dsh/.credentials.yaml 锚定提取（批次 14 教训），**仅**进网关子进程 env；零打印/零落盘/不入 git；NODE_EXTRA_CA_CERTS 只含本批自签 CA。

## 设计：scripts/dev-gateway.mjs（新，工具脚本）+ 一次性运行

1. **自签证书**：启动时生成 CA+服务器证书写入 OS temp（mkdtemp）——`node:crypto` 的 `generateKeyPairSync`/`X509Certificate` 无自签 API，用 `openssl` 子进程（Windows Git Bash 自带）或预生成一次由脚本内嵌 PEM。**取舍：内嵌预生成 PEM**（离线、确定性、无 openssl 依赖风险）；CA 同时写 temp 供 NODE_EXTRA_CA_CERTS。
2. **HTTPS 服务器**（node:https，127.0.0.1:0 随机端口）：单一 `POST /chat/completions` 处理器——读 body → `fetch('https://api.deepseek.com/chat/completions', {method:POST, headers:{Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}`,'content-type':'application/json'}, body})` → 原样回传状态码与 body。单请求上限（计数器>1 → 429）对齐"单次封顶"红线。GET /healthz 探活返回 200。
3. **网关配置**（工作区外，如 `C:/Users/Administrator/gstack861-acceptance/gateway.json`）：
   ```json
   {"schemaVersion":1,"baseUrl":"https://127.0.0.1:<port>","apiKeyEnv":"GSTACK861_DEV_GATEWAY_KEY","model":"deepseek-chat","maxTokens":1024,"note":"batch-28 local explicit gateway; forwards to DeepSeek; single-call cap"}
   ```
   `GSTACK861_DEV_GATEWAY_KEY` 为占位值（网关不校验 Authorization——它只认自己的 DEEPSEEK_API_KEY env）；满足 loadGateway 的 apiKeyEnv 存在性检查。
4. **真调用**：`NODE_EXTRA_CA_CERTS=<ca.pem> GSTACK861_MODEL_CALL=1 GSTACK861_DEV_GATEWAY_KEY=local node scripts/verify-model-review.mjs --gateway-config <abs>`——五段就绪检查后单次 `runModelReview`；预期 VERDICT 输出或结构化错误码，exit 0/1。
5. **验证点**：网关日志（内存计数+打印状态码与耗时，不打印 body/密钥）；verify 输出；单请求封顶断言（如引擎意外二连发，网关 429 → GATEWAY_ERROR，本身即红线证据）。

## 测试（test/dev-gateway.test.mjs）

- 离线单测：配置 schema 校验通过（本机 host 不在黑名单）；单请求上限逻辑（mock fetch 计数）；健康检查；内嵌证书可被 Node TLS 接受（自连 /healthz 成功——这同时就是 TLS 链路证明）。
- 不测 DeepSeek 在线路径（那是协调者的一次性真调用）。

## 密钥预算

恰 1 个计费调用（单次 chat completion，maxTokens 1024）。项目 zcode 13、DSH 12 不变；本批新增 1（DeepSeek，走网关）。

## 流程

计划（本文件）→ 独立审计划 → 实现+测试 → 协调者真调用（1 次）→ 独立审成果 → 0.4.27 文档（FEATURE_MATRIX ⑨ 行 mechanism-ready→runtime-verified）→ 摘要 → push → CI 3/3。

## 风险

| 风险 | 对策 |
|---|---|
| DeepSeek 对 deepseek-chat 的响应形状与引擎解析不符 | 引擎容错（REVIEW_OUTPUT_UNPARSEABLE 结构化码）本身就是验收对象之一；如实记录任一结果 |
| 自签 TLS 被 fetch 拒 | NODE_EXTRA_CA_CERTS（Node fetch 尊重之）；离线自连测试先证链路 |
| 密钥泄漏 | 仅网关子进程 env；脚本不含键值；测试全离线；证据只记状态码/耗时 |
| 被解读为绕过黑名单 | 计划明示设计对齐论证：黑名单防的是 model-review 路径直连官方端点，本批是显式网关路径（蓝图原文允许且要求显式配置） |

## 非目标

- G/H 桌面探针、④-⑧、macOS（不变）。
- 网关通用化（多上游/路由/鉴账）——一次性工具，够用即止。

## 审计划必改落实（2026-10-29，独立审计划 6 项）

1. **流程描述更正**：--gateway-config 走**三段**（loadGateway→红线→单调用），非五段就绪；真调用前另跑一次无参就绪检查（`node scripts/verify-model-review.mjs`）作为独立步骤。
2. **证书 SAN 必含 `IP Address: 127.0.0.1`**（另加 `IP Address: ::1`、`DNS: localhost`）——IP 字面量主机只匹配 IP SAN。
3. **内嵌证书有效期 ≥3650 天**（测试进 CI 永续跑）；过期是已声明的未来断裂轴。
4. **TLS 自证测试须 spawn 独立子进程**并在其 env 设 NODE_EXTRA_CA_CERTS 后真 fetch /healthz（进程内设 env 对已启动进程无效；自定义 ca 选项不算证明机制）。
5. **计数器只计 POST /chat/completions；/healthz 不计数**。
6. **FEATURE_MATRIX ⑨ 行措辞**：配置为**协调者/操作员在用户持续授权下显式放置**（非"用户手放"）。

另采纳建议：上游转发**只**构造 `{Authorization: Bearer ${DEEPSEEK_API_KEY}, content-type}`，绝不展开透传来进请求头（否则占位 Bearer 会 401）；处理器容忍尾斜杠；网关打印机器可读 `PORT <n>` 行，协调者按序 healthz→写配置→verify→杀网关→证据含 counter==1 日志；预算措辞改为"至多 1 个计费调用（超时情形上游可能已完成并计费，按上限记账）"。
