# 变更记录

## 0.3.2 — 2026-11-16

### 新增

- **事件级引用定位**：引用卡片按事件类型给出定位锚点——用户消息与工具调用可精确定位到宿主会话里的对应行，助手与流式事件只能定位到所在轮次。打开会话后有界轮询等待渲染，命中则滚动并高亮；找不到如实提示，不把附近一条说成精确定位。锚点只含定位标识（`messageId` / `callId` / `turn+step`），不返回正文，`bodyReturned=false` 与实时判权口径不变。定位依赖宿主聊天视图的行属性（`data-chat-anchor-key` / `data-chat-call-id` / `data-chat-turn`），属实现细节而非公开契约，宿主改版后失效时表现为「如实说没找到」。
- **写锁诊断**：`exec-budget.lock` 增加 `processStartAt` 与主机标识摘要；新增 `npm run check:locks` 只读诊断与显式 `--confirm` 清理。只清理「本机强身份 + PID 明确不存在」的锁，旧格式、跨主机、弱身份或进程状态未知一律拒绝。清理前必须停止所有使用同一 `stateDir` 的实例；rename 与恢复仍有竞态，工具不承诺绝不误删，也不处理账本与其它残留。
- **宿主兼容探针**：`npm run check:host-compat` 用临时 `HOME`/独立 profile 与假 provider，在真实宿主上验证 `agents`、`tools.guard`、`sessionController.observeEvent`、`subagents.startActivation` 四个接口。退出码 `0` 通过 / `1` 失败 / `2` 找不到可验证宿主。版本与 `dsh.compat.dsh` 不同仍会探测，但只报接口级结果，不构成兼容承诺。进程与网络检查均为采样，不覆盖非 Windows 平台、`fork` 子 Agent 与真实模型网络。
- **离线测试与净室审计**：`npm run check`（4 组边界自检）、`npm test`（12 套离线测试）、`npm run audit`（工作区 + 未跟踪文件 + 完整 Git 历史 + npm 包净室安装），测试与检查不纳入 npm 包。GitHub Actions 在 `windows-latest` + Node 24 上跑全部三项，并要求 `fetch-depth: 0`（浅克隆会让历史审计直接失败）。

### 变更

- `README` 补充诊断命令与限制说明；发布目录不再保留历史 tarball，发布产物改放仓库外。

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

