# dsh-wangchao ROADMAP v0.4.0（王朝作战台）

> 状态：**定稿**（2026-11-18，用户确认 §8 全部接口与字段命名）。
> 取代 `ROADMAP.md`（v0.3.0，最小朝廷）的前台形态与组织模型假设；底层能力（采集/判权、摘要状态机、B6、任务库 v3、attempt 级预算门禁、都察院四类规则）作为可复用零件保留。
> 依据：`ROADMAP-VISION-DRAFT.md`（用户 2026-11-18 构想口述）、Gemini 工程评估（同日）、`DEVELOPMENT-DIARY.md` 至 v0.3.3、当前代码实测（`standalone.html`、`index.mjs`、`multi-task.mjs`、`governance.mjs`）。

## 0. 一句话

把御书房从"侧栏面板"升级为**双形态王朝工作台**：侧栏保留「内阁账房」排障视图；Edge `--app` 独立窗口承载「作战台」——顶部首辅确定性报告条、左栏角色/项目、中栏围绕宿主原生对话、右栏都察院常驻巡查、底部仪表盘卡片。角色少而专，各自绑定模型；大框架固定，小功能卡片化增补。

## 1. 硬边界（不可越过）

沿用并修订旧 ROADMAP「不做的事」：

1. **不做无人监督的自主执行**。v0.4.2 之前所有真实执行必须用户逐次确认；之后的免确认白名单也必须是"单并发 + 低额度 + 限定 `.exec` 目录 + unknown 立即熔断"，不是通用循环。
2. **不做常驻 LLM 都察院**。都察院恢复执法后仍是确定性规则引擎，模型只在首辅/翰林院等专职角色里。
3. **不铺开多部门层级**。角色少而专（首辅、都察院、翰林院，其余按需增补），AI 全能，不按人类官僚机构分部门。
4. **不把摘要校验结果表述为内容真实**。`bodyReturned=false` 与 fail-closed 判权不变。
5. **不改发布审计与工程底线**。任何 GitHub 上传必须过 `publish-audit.ps1` 四步；保持 cordis patch + `client.js` + `standalone.html` 同源架构，不引 Vite/独立 React 构建链。

## 2. 前台双形态与中栏对话承载

### 2.1 侧栏：内阁账房（保留）

现有"左卡右表 + 三抽屉 + 两页签"原样保留，作为排障视图：查 seq 缺口、人工修订摘要、看规则冲突、预算与任务明细。不删除、不重做，避免排障失明。

### 2.2 独立窗口：作战台（新增，默认入口）

布局（独立窗口宽度足够）：

```
┌──────────────────────────────────────────────────────────────┐
│ 首辅报告条：确定性聚合，零 Token；点击展开/追问              │
├────────────┬────────────────────────────────┬────────────────┤
│ 左栏        │ 中栏                            │ 右栏            │
│ 角色席位    │ 对话/只读流水 + 输入框           │ 都察院巡查列表   │
│ 项目/会话   │ （见 §2.3 承载方式）             │ 规则/告警/冻结   │
├────────────┴────────────────────────────────┴────────────────┤
│ 仪表盘：项目进展 · 国库账本 · 翰林院今日奏折（固定卡片+开关） │
└──────────────────────────────────────────────────────────────┘
```

### 2.3 中栏对话承载（已核实的代码事实）

- `standalone.html` L47–68 的 `slots`/`sessions` 是假垫片，`ctx.get('uiWorkspace')` 返回 null；独立窗口**没有**宿主原生会话视图，也没有 `openSession`。
- DSH 原生对话能力（流式、工具审批卡片、B2 `data-chat-anchor-key` 跳转）只在 Electron 主窗口可用。
- `/api/dsh-wangchao/chief`（index.mjs L2454）当前只有 `summon`/`release`，**没有发消息接口**。

因此采用**双向通信设计**，不强求跨进程控制 Electron 路由：

1. **独立窗口内直接对话（一期）**：新增已认证 HTTP 接口 `POST /api/dsh-wangchao/role/message`，body `{ roleId, text, clientMessageId }`。服务端按角色找到对应 agent handle，用现有 `agent.inbox.append(assertValidInjectTarget('next-turn'), msg)`（index.mjs L3194/L4071 同款路径）投递；独立窗口用轻量只读流水渲染消息与状态。此路径可发消息、可看回复，**放弃宿主原生富渲染**。
2. **回主窗展开完整会话**：新增 host 端点 `POST /api/dsh-wangchao/role/open-in-host`（或复用 `standalone-url` 反向桥），由后端通知 Electron 主窗 `uiWorkspace.openSession(sid)`；点"在主窗展开"或点 B2 引用时走这条。独立窗口不强求操控宿主路由。
3. **能力边界必须如实展示**：独立窗口的中栏标注"简化对话视图"，遇到工具审批/代码高亮/seq 精确锚点，统一提示"在主窗口展开完整会话"。

## 3. 角色与模型绑定（复用为主）

### 3.1 状态结构

把单一 `state.chief` 扩展为 `state.roles` 字典（兼容迁移）：

```
state.roles = {
  chief:  { sessionId, model: { provider, model, reasoning? }, enabled, handleKind, ... },
  hanlin: { sessionId, model, enabled, ... },
  // 执行役等后续按需增补
}
state.chief 保留为 chief 的兼容别名，旧 state 自动迁移。
```

### 3.2 模型绑定

复用 2026-11-14 已实测的 `agents.create/resume` + `AgentOptions`（provider/model/reasoning）；角色级默认模型写入配置，会话自身持久化选择优先，不覆盖用户在宿主界面手动选的模型（沿用现有 `modelSource` 口径）。

### 3.3 首辅报告条（零 Token 约束）

顶部报告条是**确定性事件聚合**，不每次 poll 调模型。候选字段（聚合自现有 `/overview`、`/work`、`censorate.report`、`exec-budget.snapshot()`）：

```
reportBar = {
  at, newSessions, uncoveredSeqs, tasksAwaitingConfirm,
  budgetUsedUsd, budgetLimitUsd, censorateViolations, hanlinDigestAt
}
```

只有用户点"让首辅分析"或跨过明确阈值（如 `censorateViolations>0`、`unknownCount>0`）时，才把状态包注入首辅会话触发一次模型调用（复用 `chiefAttach` brief 注入路径）。

## 4. 都察院恢复执法（v0.4.1，四条硬性准入契约）

恢复执法前必须把 v0.3.3 降级时暴露的 B1–B4 全部闭环；缺一条不得开启冻结。

### B1 — 越权探针主动重探

不读启动期静态自检快照。触发执法判定、`rulesRevision` 变更、HMR 重载交接后，按有界冷却周期主动重跑受控 `chief_probe_write`/`checkGuards` 探针，确认当前时刻 `guardScope: root` 存活且拒绝越权；探针失败（含超时/异常）按 violation 处理。探针结果带 `probedAt` 与冷却窗口，避免高频开销。

### B2 — append-only 历史违规豁免水位线

持久化 `state.censorateAck = { acknowledgeUpToSeq, at, by, reason, codeScope }`。巡检及执法只对水位线之后的新增违规计数；水位线之前的 append-only 记录（exec-budget-denials、历史 attempt 超限、governance dup）一律不冻结。人工解冻必须写 `ackWatermarks`，且只豁免明确 codeScope，不静默清空全部违规。

### B3 — 持久化冻结 + 启动/运行期双制动

冻结顺序固定：① 原子写入 `state.censorateFreeze = { frozen:true, reason, codes, at, ackBefore }` 并落盘；② 同步调用 **`taskScheduler.pause(reason)`**（`multi-task.mjs` L127，唯一真实 pause 宿主）；③ 记 `governance.audit({kind:'pause',...})`（governance.mjs L56 支持）。巡检函数自身抛异常也走同一路径（fail-closed）。插件启动初始化 scheduler 后，若读到 `censorateFreeze.frozen === true`，在派发任何任务前立即重放 `taskScheduler.pause()`——因为 `pause` 是内存态，重启即失效。不得另建平行冻结标志位替代 scheduler.pause。

### B4 — execGate 初始化失败识别为 init-failed

明确三态：`unconfigured`（配置未启用执行，无账本正常）、`ready`（门禁就绪）、`init-failed`（配置声明启用执行但 execGate/execBudget 初始化异常）。只要配置声明启用执行通道，任何门禁/账本初始化异常一律记 violation（而非 unknown 放行），直接触发 B3 冻结并阻断 `runExecutionTask`。判定依据用配置 `budgetLimitUsd>0` 或显式 `execEnabled`，不再用 `budgetLimitUsd>0 && !!execGate` 把 init-failed 误归为未启用。

### 冻结范围

只冻**新任务派发**与**自动/手动摘要请求**；绝不冻结与首辅的只读对话（出事时仍可问首辅发生了什么）。人工恢复通过写入 B2 的 ack 水位线 + 清除 `censorateFreeze` + 重跑巡检确认无新增 violation 完成。

## 5. 首辅受限自主权（v0.4.2，不早于真实执行闭环）

### 5.1 两级授权

- 一级（免确认）：只读巡查、生成计划、调用翰林院整理——授权范围内免逐次确认。
- 二级（需确认）：真正拉起 `subagents.startActivation` 写文件或花预算——初期保留"一键确认派发"。连续跑稳后再考虑"单次预算 ≤ $0.05 + 限定 `.exec` 目录 + 单并发 + unknown 立即熔断"的免确认白名单。

### 5.2 前置条件（缺一不可）

单任务预算闭包、usage 归属、运行中取消/停止、跨进程/并发边界实测；此前 real6 单次 $0.001194 试验不够，需桌面端连续受控验证。商业模型/预算由用户逐次授权，插件不自行打开真实执行。

## 6. 仪表盘卡片（固定槽位 + 开关）

| 卡片 | 数据源（一期） |
|---|---|
| 项目进展 | `/overview` + `/work` 现有统计、summaryCoverage |
| 国库账本 | `exec-budget.json` + `governance.json` 本机账本 + 用户手填月度/单日上限；不接外部高权限 API |
| 翰林院今日奏折 | 规则筛选当日有 applied 摘要的会话 → 调 1 次模型生成 → 落盘缓存当天复用 |
| 都察院状态 | `censorate.report` 聚合（右栏详表，底部只显示绿灯/计数） |

不做自由拖拽、不做用户自定义脚本卡片（mini-react 维护成本极高、收益低）。

## 7. 版本切分（防候选漂移）

| 版本 | 内容 | 风险 |
|---|---|---|
| v0.4.0-alpha | 双形态前台骨架、state.roles 多角色注册表、独立窗口简化对话接口、首辅确定性报告条、右栏都察院只读面板、底部三张卡片 | 零执法、零真实模型新入口；不碰 B1–B4 |
| v0.4.1 | 都察院恢复执法（B1–B4 全闭环）、ack 水位线、scheduler.pause 双制动 | 高风险，单独立项验证 |
| v0.4.2 | 真实执行闭环受控验证 + 首辅二级授权 | 涉及真实模型与预算，需用户逐项授权 |

## 8. 接口与字段命名（建议值，待用户确认）

以下按现有代码习惯给出建议值；用户未推翻前按此执行。

| 项 | 建议值 | 依据 |
|---|---|---|
| 角色字典 | `state.roles`；roleId 固定枚举 `chief` / `hanlin` / `executor`，一期不支持自定义 | 现有 `state.chief`/`chiefs` 短命名风格；`roles` 比 `roleRegistry` 简洁 |
| 兼容别名 | `state.chief` 保留为 `state.roles.chief` 的读写别名，旧 state 自动迁移 | 避免既有首辅入口与 UI 一次性断裂 |
| 角色发消息接口 | `POST /api/dsh-wangchao/role/message`，body `{ roleId, text, clientMessageId }` | 与 `/chief`、`/work` 同层级命名；`clientMessageId` 用于幂等去重 |
| 主窗展开接口 | `POST /api/dsh-wangchao/role/open-in-host`，body `{ roleId, sessionId? }` | 不暴露跨进程 Electron 路由，只做后端桥接通知 |
| 冻结标记 | `state.censorateFreeze = { frozen: true, reason, codes, at, ackBefore }` | 用户明确要 `frozen`；与 `execFallback.active` 分属不同对象，不会混淆 |
| ack 水位线 | `state.censorateAck = { ackBefore: { at, seq?, line? }, reason, by }` | 现有 `summaryUnknown[].acknowledged` 用 `{ at, reason }`；异质账本需时间+可选 seq/行号复合口径，避免同一毫秒误判 |
| 首辅报告条 | `reportBar`；字段 `at / newSessions / uncoveredSeqs / tasksAwaitingConfirm / budgetUsedUsd / budgetLimitUsd / censorateViolations / hanlinDigestAt` | 与 `/overview` 字段风格一致，全部确定性聚合 |
| 翰林院缓存键 | 按本地日期 `YYYY-MM-DD` + 当日参与会话数哈希，存 `state.hanlinDigests[dateKey]` | 每天最多生成一次，同日状态变化可判断是否重算 |
| 免确认白名单 | `cfg.execAutoApprove`（对象：`{ enabled, maxUsdPerTask, workspaceRoot, maxConcurrent }`） | 全部执行相关配置已在 cfg 顶层（execFallback/config/budget），保持一致 |

用户已于 2026-11-18 逐项确认上表，本文档定稿。开工顺序按 §7：v0.4.0-alpha（骨架与多角色层）→ v0.4.1（都察院执法）→ v0.4.2（首辅受限自主权）。

## 9. 复用清单（不重造）

采集/准入（decideAccess、实时判权）、摘要状态机与 B2 引用定位、B6 崩溃恢复、Task Store v3 与 scheduler、attempt 级预算门禁与 writer-epoch、首辅 handoff、都察院四类不变量规则、live-stream、独立窗口与主题、13 套测试/checks/净室审计/CI、`publish-audit.ps1` 四步。
