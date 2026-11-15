# dsh-wangchao（王朝 · 御书房）

`dsh-wangchao` 是面向 DeepSeek Harness 的跨会话状态总控、可追溯摘要与受控任务协作插件（基于 DSH `0.2.2-rc.3` 开发与验证，其他版本未作兼容承诺）。

插件以**「默认拒绝（Deny-by-Default）、失败关闭（Fail-Closed）、状态与事实可追溯」**为核心工程原则：未获显式授权的会话正文不进入采集索引；模型生成的摘要显式标注覆盖区间与缺口，且不作为客观事实；任何涉及模型计费或子任务执行的动作，均受独立门禁、Root 级工具守卫与本地预算账本约束。

## 核心特性（v0.3.0）

### 1. 疆域准入与冷热混合采集

- **显式准入与冲突保护**：按 `allowSessions` 与 `allowCwds`（并集判定，排除规则优先）精确控制纳入范围，未命中会话默认拒绝，首辅自身会话自动隔离；修改规则支持修订号校验（`baseRevision`），并发冲突时保留本地草稿并提示刷新重试，不静默覆盖。
- **冷热混合增量同步**：
  - **活跃会话（Live）**：通过宿主 `sessionController.observeEvent` 按会话 ID 订阅实时增量事件，基于单调游标（`seq === watermark + 1`）秒级推进，健康接管期间自动跳过冗余轮询整读。
  - **冷会话（Cold）**：按固定周期分批轮询补齐历史事件，单调推进采集水位线。

### 2. 御书房双页签工作台与独立窗口

- **端内面板与独立窗口同源**：内置轻量 `mini-react` 渲染层，同一份 `client.js` 同时驱动 DSH 侧栏面板与独立全屏窗口（`/api/dsh-wangchao/ui`，支持 Token 换 Cookie 免登与 Edge/Chrome `--app` 独立窗口拉起）。
- **渐进披露布局**：
  - **双页签**：「总览与对话」与「计划与任务」。
  - **左卡右表**：左侧常驻三张状态摘要卡（内阁首辅 / 规则与采集范围 / 任务队列），右侧为五列高密度会话表，异常与覆盖缺口收敛为行尾 `⚠N` 徽标。
  - **三个互斥抽屉**：按需滑出「会话详情与摘要」「内阁首辅」「规则与采集范围」，自动跟随系统深浅色外观（`prefers-color-scheme`）。

### 3. 覆盖可追溯摘要、人工修订与 `[seq]` 引用核对（B2）

- **摘要状态机**：严格区分 `intent → sent → applied / failed / unknown`；仅 `applied` 计入覆盖率，中断或结果未知的请求归入 `unknown` 待确认队列，**永不自动重发**，防止隐式重复计费。
- **精确缺口披露**：逐事件记录完整送入（`full`）与截断送入（`partial`），显式计算未覆盖 `seq` 空洞区间，并标记模型已返回但结果未保存（进程内 `unsaved`）的异常状态。
- **`[seq]` 引用核对**：按最新会话权限实时判权，通过身份指纹（`time + contentLen + sha256`）校验引用与已发送区间；默认不返回原文片段（`bodyReturned=false`），本版本点击可跳转会话并展示 `seq / 类型 / 时间` 元数据。

### 4. 内阁首辅（只读幕僚 Agent）与可追溯交接

- **只读白名单守卫**：首辅复用宿主 Agent 生命周期接口并自动继承默认模型配置，受 `CHIEF_READONLY_ALLOW` 白名单与宿主级守卫双重约束，写操作工具调用恒为 0。
- **可追溯交接（Handoff）**：换代或收紧权限时旧首辅立即阻断；交接包严格区分客观事实（仅限任务状态、人工修订、覆盖计数）与模型摘要（显式标记 `notFact: true`，正文仅出现在摘要区）。

### 5. 受控任务派发、Attempt 级预算门禁与崩溃恢复（B6）

- **多任务依赖与保序调度（Task Store v3）**：支持计划提案、人工点击确认后派发、任务依赖、并发门禁与运行中取消；基于单调递增时间戳严格按创建顺序保序派发（FIFO）。
- **跨重载 Root 守卫与目录包含校验**：通过 `ctx.root.get('tools').guard` 注册全局守卫，配合 `Symbol.for('dsh-wangchao.execGuard')` 实现跨实例无真空交接（先装新、再撤旧）；派发前强制校验执行工作区位于父会话 `cwd` 之内。
- **Attempt 级预算门禁与写权隔离**：在 `llm/stream` 层拦截执行子会话的每次请求，按完整载荷 `UTF-8 字节数 + 512` 做发送前预留估算，返回后按真实 `usage` 结算；通过 `writerEpoch` 隔离热重载与迟到回调，确保旧实例写者无法覆盖新实例状态。
- **Fail-Closed 崩溃恢复（B6）**：对 `state.json`、任务库、治理记录、执行生命周期记录及残留 `.tmp` / `pending` 文件执行启动期完整性校验；检测到状态损坏或未确认的遗留执行时立即熔断阻断，绝不静默重置为空状态。

## 默认安全边界与已知限制

1. **付费与执行默认关闭**：未显式配置 `allowManualSummary: true` 时拒绝真实摘要调用；未显式配置本地预算额度与执行解锁时，子任务派发默认阻断。
2. **本地估算非服务商账单**：预算门禁的预留与结算基于本地保守上界与单价表，仅作本地准入控制，不等同于云服务商实时账单；`cacheReadTokens` 在未配置缓存命中价时按标准输入价保守估算，并在快照中显式标注口径。
3. **工具守卫非操作系统沙箱**：`tools.guard` 与执行 preset 仅约束 DSH 工具调用层面的越权读写，不替代操作系统级容器或进程沙箱。
4. **单实例写者假设**：`stateDir` 设计为单进程写入（端内面板与独立窗口共用同一 DSH Host 进程），暂不支持多个 DSH 进程同时挂载同一 `stateDir`；写权锁无 lease/TTL，进程强杀后需人工核对清理。
5. **摘要质量验证范围**：真实模型摘要目前仅在少量受控样本上核对过，超长会话、多轮压缩与工具密集场景仍在扩展验证中。

## 安装与启用

从 npm 安装（推荐）：

```powershell
dsh plugin --profile <name> add dsh-wangchao
```

当前 `latest` 指向 0.3.1；需要固定版本时写 `dsh-wangchao@0.3.1`。也可以直接从本地源码安装：

```powershell
dsh plugin --profile <name> add file:<path-to-this-repo>
```

或在目标 profile 的 `cordis.patch.yml` 中挂载配置：

```yaml
- insert:
    - id: dsh-wangchao
      name: dsh-wangchao
      config:
        allowSessions: []
        allowCwds: []
        excludeCwds: []
        excludeSessions: []
        stateDir: "<DSH_HOME>/wangchao"
```

重启 DSH 后，点击侧栏「御书房」图标即可打开面板；面板内的「打开独立窗口」可进入全屏工作台。

## 开发与诊断

以下命令在包含相应脚本的源码目录或安装包目录中执行；当前 npm 0.3.1 尚不包含新增诊断命令。源码仓库的 `npm run check` 和 `npm test` 执行离线自检与测试，`npm run audit` 检查工作区、完整本地 Git 历史及 npm 包；远端仍需另行复核。浅克隆无法完整审计历史，会报告失败。

```powershell
npm run check:locks -- --state-dir "<stateDir>"
npm run check:locks -- --state-dir "<stateDir>" --confirm "<stateDir>"
npm run check:host-compat -- --host-root "<DSH安装目录>"
```

锁诊断默认只读。清理前必须停止所有使用该 `stateDir` 的实例并核对账本；`--confirm` 指定同一目录后，仅本机身份可确认且 PID 明确不存在的锁可进入清理流程。旧格式锁、跨主机、弱身份或进程状态未知均拒绝清理。清理过程中仍有文件竞态，工具无法验证所有实例是否停止，也不处理账本或其他临时文件。`processStartAt` 是估算值，不能证明 PID 未被复用；`hostId` 是机器标识的摘要，不是认证凭据。

宿主兼容探针使用临时 HOME、独立 profile 和假 provider，在真实宿主上检查 `agents`、`tools.guard`、`sessionController.observeEvent` 与 `subagents.startActivation`。退出码 0 表示通过，1 表示失败，2 表示找不到可验证的宿主或跳过。接口通过不代表覆盖 UI、真实模型或其他 DSH 版本；网络采样不能证明不存在所有外连。

## 许可

MIT
