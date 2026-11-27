# 变更记录

## 0.5.0-alpha.5.2 — 2026-11-27

> 本版只修宿主可靠性与发布前审计，不发布、不改 dist-tag、不建 Release。

### 修复

- **翰林院摘要不再依赖宿主 fake provider adapter**：隔离 fake 路由改为把 runner 置空，走 `generateHanlinDigest` 内置的确定性统计摘要。返回与审计明确标记 `source=deterministic`、`model=null`、`fallback=true`，报告条与奏折抽屉同时显示该来源；真实模型路由（预算与身份门禁）保持原样。真实宿主上原先对 `llm.prepareCall({provider:'fake'})` 报「no adapter registered」并返回 502，本版不再出现。
- **首辅分析的同源 fake 分支**：只在本宿主确实没有 fake adapter 时，把错误转成 `fake-adapter-missing` 的明确不可用状态与配置指引，不伪造分析正文、不放宽真实模型门禁。
- **首辅消息可靠回执**：`/role/message` 不再用「followup 没抛错」冒充送达。投递后以会话事件核对，返回 `submitted / accepted / dispatched / replied / failed / cancelled / stale-session / timeout-unknown` 八态；新增 `GET /role/message/status?clientMessageId=` 供用户主动核对。核对同时读宿主自己的 `turn/end` 结论：模型调用失败（如无凭据、输出上限被拒）时回执明确 `failed` 并带上宿主原始原因，不再停留在「未确认」。没有可用模型路由时投递前就 `503 model-unavailable`。同一 `clientMessageId` 幂等复用，不自动重发。`fresh` / 退休后旧会话的消息回执返回 `stale-session`，迟到回复不进入新议事窗口。前端只在核对到进入会话时显示「已送达」并清空输入框；未确认保留原文，失败给出具体原因，重复发送前先核对上一条回执。
- **`fresh` / `summon` 回执基线修正**：会话 id 实际在 `chief.sessionId`，旧代码读顶层 `sessionId` 恒为 undefined，导致 `summonedAtSeq` 与 `newSessionId` 从不返回，前端无法正确切换议事窗口基线。
- **会话形状诊断**：不再把 `h.agent.session.length ?? null` 当成事件数；改为如实返回 `sessionShape`（kind / lengthKnown / eventsLength / hasAppend / keys），让「消息是否进入会话」可以从会话事件读取，而不是猜。

### 发布前审计

- 内部编号扫描从一位数字的 `F-0x` / `AP-0x` 扩展到两位及三位（含工作包子阶段后缀）/ 缺陷编号 / 整改编号 / 内部审查条目 / 轮次标记，带正例自证与串扰形态误报护栏；范围仍是 `package.json files` 白名单（公开文档与运行时源码）。公开包 53 个文件零命中。
- 公开源码里 52 处历史内部编号已从注释中清掉，技术说明原文保留；详见交付报告 before/after 清单。

### 工程收口（CONSOLIDATION-01）

- **删除 plan-evidence.mjs**：零消费者，其 planEvidence 已被 plan-tools.mjs 的严格超集实现取代并在 :219 实际调用。删前核查：静态 import 0 处、动态 import 0 处、测试引用 0 处、	ypes.d.ts 不提；删后 
ode --check 127 文件 0 失败，全量 284 tests 通过。发布白名单同步移除该行。
- **首辅回执的因果归属修正**：轮次结论原先按「投递前 1 秒回溯窗口」匹配 	urn/end，导致①无时间戳的历史事件被当成本轮结论、②上一轮的失败污染本轮、③消息已落盘后宿主报错时回执停在 dispatched 看不到原因。改为以「消息在事件数组中的位置」作因果锚点：锚点之后才看 	urn/end；无锚点时要求事件必须带时间戳，且同会话存在其它已落盘 msgId 时不采用（避免并发串味）。新增 6 项回归，覆盖无时间戳、上一轮污染、落盘后失败、部分回复后失败、重复/迟到事件、并发归因。
- **测试命令修正**：
ode --test test/ 在 Node 24 上会把目录当模块解析并失败，正确形式是 
ode --test "test/**/*.test.mjs"；根级 7 个 *.test.mjs（137 断言）需单独跑。
- 历史 ROADMAP-V040.md / ROADMAP-VISION-DRAFT.md 归档到 docs/archive/；ROADMAP.md 重写为唯一权威版本。

### 验证

- `node checks/all.mjs`：7/7 组、50 条断言通过。
- 离线测试：详见交付报告中的真实统计（逐文件带超时执行）。
- 隔离宿主验证：详见 `AP09-ALPHA52-HOST-RELIABILITY-DELIVERY.md`；未取得实证的项目标 `NOT VERIFIED`。

## 0.5.0-alpha.5.1 — 2026-11-26

### 修复

- 规则面板：当配置基线存在非空排除规则、且该字段已被面板覆盖过时，再次清空该字段现在会显示确认勾选框；未确认 / 取消确认不会提交，确认后带 `confirmClearExclude:true`。服务端安全门禁未放宽。
- 单字段「恢复为继承配置」可直接删除该字段覆盖，无需先清空再保存。

### 文档

- 修正测试文件数量说明；新增升级与配置迁移说明、已知限制与安全通告。

## 0.5.0-alpha.5 — 2026-11-26

### 修复（安全优先）

- **采集规则合并语义**：区分「字段缺失＝继承配置」「显式空数组＝该项明确不授权」「非空数组＝覆盖」。面板保存只提交实际编辑过的字段；清除继承的排除规则需要显式确认。旧格式迁移按维度处理：允许维度空数组保留为空集（收紧），拒绝维度空数组改回继承基线，避免升级时清掉配置里的拒绝规则。「恢复配置文件基线」删除覆盖而不是用空数组表达。
- **轮询实时判权**：采集轮询改为每次读取当前规则，修复「面板收紧规则后仍按启动时快照继续读取并写盘」。
- **陈旧写锁自动接管**：改为原子认领（rename 到唯一隔离文件）＋内容身份复核＋二次进程探测；接管前先写审计，审计失败或 epoch 写入失败一律 fail-closed 并放回原锁；接管推进 epoch，写前回读锁 token 做 fencing。双竞争者只有一个能接管，绝不按路径盲删他人新锁。

### 新增

- **御书房项目工作区（RRP）**：灵感收件箱（捕捉 / 去重 / 确认 / 忽略 / 纳入研究）、研究阶段与生命周期事件逐条展示、事实主张类型（用户声明 / 模型推断 / 证据支撑）与争议原因展示、恢复包覆盖缺口与会话血缘展示；恢复包出口统一脱敏凭据形态文本。
- **首辅职责说明与状态徽标**：明确「只读参谋」边界，区分已召见 / 本进程守卫已验证 / 可发送 / 已退休 / 已冻结 / 权限不足；「新开议事」创建全新会话，不再复用旧历史。
- **模型诊断细分**：`/model-readiness` 返回门禁与账本的实际生效值（attempt 上限、试验请求已用/上限、used/reserved/unknown、writer epoch），blocker 带机器可读 code；provider/model 存在性未探测时明确 `not-probed`。

### 变更

- `maxAttemptsPerChild` / `maxTotalTrialRequests` 非法配置改为显式失败（不再静默回落到 2）。
- 账本 `createdAt` 缺失/非法的旧条目按 fail-closed 计入当日 attempt，不再变相放宽上限。
- 采集轮询间隔与会话上限对非法值回落默认（30s / 10），避免 `NaN` 定时器。

### 验证

- 离线 393 项测试通过（含规则语义、锁接管竞争、恢复包脱敏、UI 渲染、配置最后一跳）。
- `checks/all.mjs` 6/6 组、45 条断言通过。
- 合成 200 会话性能测量：启动 20 个会话 303 ms，单轮 10 个 156 ms，并发轮询被 `already-polling` 拒绝，规则收紧后 0 次读取。

## 0.5.0-alpha.4.1 — 2026-11-24

- 凭据改走 DSH credentials 服务（`DEEPSEEK_API_KEY`），无需再注入环境变量；resolve 失败按不可用 fail-closed。
- 生产插件由 0.3.1 升级到 alpha.4.1，补回滚备份。

## 0.5.0-alpha.4 — 2026-11-24

- 翰林院成功路径补 governance outcome 审计；审计失败 500 audit-failed，不写缓存、不返回正文。
- Writer Fencing 恢复契约：只删写锁，保留 `writer-epoch.json`，epoch 单调递增，旧写者写入报 `STALE_WRITER`。

## 0.3.1 — 2026-11-15

### 文档

- README 增加 npm 安装方式：`dsh plugin --profile <name> add dsh-wangchao`；本地源码安装保留为备选。
- 明确 `latest` 指向 0.3.1，需要固定版本时显式写版本号。

## 0.3.0 — 2026-11-15

### 新增

- **B6 崩溃恢复**：`state.json`、`tasks.json`、`governance.json`、`exec-lifecycle.json` 统一 tmp→rename 原子写；主文件缺失、残留 tmp、非法账本记录一律 fail-closed；启动时把未结算的 reserved 转为 unknown，不静默当作空账本。
- **B2 摘要引用**：会话级引用与 seq/type/time 元数据；实时判权；正文不返回（`bodyReturned=false`），只有元数据与 `openSession`；独立页支持宿主跳转。
- **执行预算门禁**：`exec-budget.mjs` 逐次预留/结算、单次与累计上限、usage 严校验；`writer-epoch-fencing.mjs` 写权 epoch、有界停止、超时落 unknown、旧回调拒写；`exec-gate-wiring.mjs` 512 输出上限、真实请求计数、单写者磁盘锁与路径别名拒绝。
- **`cacheReadTokens` 计价**：usage 可带 `cacheReadTokens`；显式配置 `cacheHit` 价目时单独折算，未配置时按标准输入价保守计，并在 `snapshot().note` 与 `pricePerTokenUsd.cacheHitPricedAsInput` 标注口径。
- **P1 自检**：`checks/` 四组 31 条断言，覆盖执行工具名解析、inject 目标枚举、消息 schema、代码指纹。

### 变更

- 版本 0.2.0 → 0.3.0。
- 生产源码删除 `WC_TEST_REAL_PROVIDER` / `WC_TEST_REAL_MODEL` / `WC_EXEC_MAX_TOKENS_OVERRIDE` / `WC_GATE_REGISTER_FAIL` 四个试验环境变量扩权入口；真实路由白名单固定为 `deepseek-official/deepseek-flash`，`maxTokens` 固定 512。

### 验证

- 离线：预算 80 项、围栏 35 项、B6 3 套、B2 3 套（24/30/15）、P1 4 组（31 断言）全部通过。
- 真实执行：隔离 rc.3 宿主 + `deepseek-official/deepseek-flash`，2 次请求、1 次 `read` 工具调用、任务 `succeeded`；账本 `$0.001194`，累计估算 `$0.0142152`。

### 已知边界

- 预算为本地估算门禁，不是服务商账单硬上限。
- 写权锁无 lease/TTL，强杀后需人工清理；无 fsync，掉电语义未证明。
- 真实执行默认关闭，只有显式隔离测试配置才派发。

## 0.2.0 — 2026-11-12

- 首次发布：跨会话采集、御书房面板、按需摘要、首辅只读守卫、独立窗口入口。
- 摘要路由、撤权、人工修订与独立页清理的隔离验证。

