# 变更记录

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

