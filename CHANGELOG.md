# 变更记录

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
