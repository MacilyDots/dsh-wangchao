# dsh-wangchao 开发日记

记录开发过程：什么时候、发生了什么、做了什么选择、为什么。

**时间基准**：全部为北京时间（Asia/Hong_Kong），取自各次运行日志与产物的落盘时间，不是事后估算。

项目目录：`B:\DSH\Agent\leader\`。产品名「王朝」，面板名「御书房」，首辅（Leader）是它的第一个子系统。

---

## 2026-11-03 — 契约探针期

这一天的主题只有一个：在写任何界面之前，先把 DSH 的会话与状态契约摸清楚。所有探针输出落在 `_leader-probe\out\`。

| 时间 | 事情 | 选择 / 结论 |
|---|---|---|
| 21:13 | `e1-apply-signature`、`e3-replay`、`e5-imm-vs-mut` | 确认规则对象是不可变替换而不是原地修改，后续所有规则更新都按「替换 + 原子写盘」处理 |
| 21:15–21:31 | `e6`（顺序与饥饿）、`e9`（官方 projection）、`e10`（seed 路径）、`e11`/`e12`（实时）、`e13`/`e14`（冷缓存）、`e15`（首次打开） | 会话摘要的来源定为「官方 projection + 实时事件」，不走自建索引；冷缓存与首次打开的差异被记录下来 |
| 21:36–21:42 | `e16`（writeback）、`e17`（create vs resume）、`e18`（resume options）、`e19`（resume 副作用） | **关键决策：首辅用 `agentLoop.create` 创建、用 `resume` 恢复，两条路径的行为不同**。create 返回的句柄没有 dispose，这个限制后来反复咬人 |
| 21:51–21:53 | `e21`（resume 两阶段） | 恢复要分两步：先拿目标会话，再决定是否接管 |
| 21:56–22:13 | `e22`（背景采集排除）、`e23`（重启回填）、`e24`/`e25`（严格隔离 setup/inject）、`e26`（严格轮询）、`e27`/`e28`（生成与轮询提交） | 形成「严格隔离」口径：首辅会话不进采集、只读、状态包注入但不读正文。轮询提交需要防重入与崩溃恢复 |
| 22:20–22:33 | `toolcheck`、`fixcheck`、`check-main`、`check-rulechanged` | 规则变化后要重算 revoked；工具可见性依赖注入面 |
| 22:52–23:38 | `event-templates`、`assistant-samples`、`web-dryrun`、`once` 系列、`live-web`、`REAL-*` | 真实事件模板与真实模型调用各跑了一轮，确认装配可用 |

**这一天的选择**：宁可多花时间做契约探针，也不先做界面。后续所有 bug 里，凡是「写了界面才发现契约不对」的，都因为这一天省掉了。

---

## 2026-11-04 — 框架落地

| 时间 | 事情 | 选择 / 结论 |
|---|---|---|
| 00:21 | `README.md` | 先写对外说明，明确「这是给会话做摘要与状态面板的插件」，不写内部决策语言 |
| 00:51 | `UI-DESIGN.md` | 面板叫「御书房」，项目/对话双视图，权限范围设置与状态显示分开 |
| 01:12–01:14 | `client.mjs`、`package.json` | 插件包名 `dsh-wangchao`（`dsh-dynasty`/`dsh-cabinet` 已被占用） |

---

## 2026-11-05 — 首辅子系统与验收（主线）

### 上午：首辅接入

| 时间 | 事情 | 选择 / 结论 |
|---|---|---|
| 凌晨 | `index.mjs` 加入 Chief 子系统：`leader_chief_{status,create,resume,close,recover,summon,release,append,selftest,inspect}` | 首辅是「一个受只读约束的 agent」，用工具而不是另建服务 |
| — | `CHIEF_READONLY_ALLOW` 白名单 + `tools.guard` | 只读用白名单：`leader_status/leader_sessions/leader_detail/leader_chief_*`，其余全拒 |
| — | 发现 guard 读 `exec.call?.name` 不生效 | 纠正为读 `exec.name`（顶层），否则所有工具都被判成「无法确认工具名」 |
| — | `leader_chief_selftest` | 用受控 `chief_probe_write` 工具做真实 `tools.execute` 断言，证明「允许执行、写工具零调用」 |

### 下午：状态包与会话语义

| 时间 | 事情 | 选择 / 结论 |
|---|---|---|
| — | 状态包注入（`chiefAttach`） | 只注入计数、项目名、最近建议、生成时间；不注入正文 |
| — | 发现 `inbox.append('nextTurn')` 报错 | 目标是 `'next-turn'`（带连字符）；消息必须有 `id` 与 `source:{kind:'user'}`，否则会话日志损坏 |
| — | 状态包「已注入」语义混乱 | 拆成 `briefAt`（生成）、`briefInjected`（入队）、`briefMsgId`（消息 id）、`briefSkipped`（跳过） |
| — | 重开时报「对话可用但记录仍关闭」 | `applyBriefState()` 统一写 `open`/`conversationEnabled`/`brief*`，并持久化 |
| — | 首次创建时 `briefMsgId` 为 null | 先建 `state.chief` 再 `applyBriefState`，否则写进旧对象 |
| — | 旧状态包移除失败仍继续追加 | 改为按 `briefMsgId` 移除；失败时 `ok:false` 且不开放对话；队列读不到时标记未知 |

### 晚上：假模型与权限验收

| 时间 | 事情 | 选择 / 结论 |
|---|---|---|
| 20:50 起 | 查 `dsh-llm` 契约，发现公开注册接口 `ctx.llm.registerAdapter(providers, adapter)` | **选择：假模型路线**（隔离 HOME + 测试副本），不花真实预算 |
| 21:30 | 第一版假 adapter 注册失败：`providerRetryPolicy is not a function` | 补齐 `providerRetryPolicy`/`imageRequestPricing` 等默认方法 |
| 21:40 | 假 adapter 写坏会话日志：`tool/call … does not match one advertised tool call` | `block-end.arguments` 必须是字符串，与 `tool-call-delta` 拼接口径一致 |
| 21:50 | 正向对照：允许工具真的执行、写工具被拒且零调用 | `chief_probe_write` 只在测试副本注册，执行即计数 |
| 22:20 | 重启后拦截不成立 | 真因：恢复时没带 `provider/model`，`{{model}}` 无值导致 turn 直接失败。修 `al.resume(..., { agentOptions })` |
| 22:33 | 假模型四阶段（pos/neg/before/after） | 正向对照 1 次、守卫开启 0 次、重启后独立 `callId` 且 0 次 |
| 22:38 | 原生 UI 验收 | 真实规则接口 + CDP `Input.insertText`；收紧后 `reject(tightened)`，模型计数不变 |

### 深夜：权限边界的连环缺口

| 时间 | 事情 | 选择 / 结论 |
|---|---|---|
| 22:43 | 退休后拒绝没验成 | 同实例 resume 被「active write handle」挡住；重启测试又发错会话（`sessionId` 被 `state.chief` 覆盖） |
| 22:48 | 修 `raw_send`：只复用同会话句柄、去掉固定 `guardOk`、不补装守卫 | 用户指出「不能只修参数就当权限证明」 |
| 22:56 | 宿主级守卫 | 发现 `agentEvents(ctx, agent)` 的 `ctx` 是「any context of the app」→ 宿主注册能收到所有 agent 的 pre-step。修复退休会话重启后绕过 |
| 23:02 | 隔离边界实测 | `bodyChars: 282` → 正文作为回调参数进入插件。「原文从不进入插件」不再成立 |
| 23:07 | 状态文件损坏 | 加 `stateLoadIssue` 分支：损坏时首辅会话一律拒 |
| 23:10 | 状态文件丢失 | `missing` 不设 `stateLoadIssue`，`recoverOrphanChiefs` 又把它登记成孤儿 → 放行。加「未知首辅」与「孤儿登记」两条拒绝 |
| 23:16 | 普通会话对照 | 普通会话也经过宿主守卫，正文同样进入回调；决策 `allow`，功能正常 |
| 23:24 | `agent/request` 契约 | payload 只有 `turn/step/signal/agent`，无 `messages`；抛错能中断请求 |
| 23:29 | 只装 `agent/request` 的四阶段 | `throw` 之后该会话无新模型调用，无重试/绕过 |
| 23:32 | 隔离探针 | **`session.log` / `agent.systemPrompt` / `session.derived` 里都命中测试标记** → `agent/request` 同样接触正文 |

---

## 关键决策清单

1. **契约探针优先**（11-03）：先摸清会话/状态/恢复契约，再做界面。
2. **首辅是 agent，不是新服务**（11-05）：复用 `agentLoop.create`/`resume`，用工具暴露能力。
3. **只读用白名单**：只有 5 个 `leader_*` 工具允许，其余一律拒；`tools.guard` 按 `exec.name` 判定。
4. **假模型路线**（20:50 起）：隔离 HOME + 注册假 adapter，零真实预算，能精确计数。
5. **撤权语义：收紧即换会话**（22:14）：规则收紧后旧会话停止，下一次召见新建；`rulesEpoch` 不可回退。
6. **宿主级守卫**（22:56）：解决恢复路径不经过 `chiefAttach` 的缺口。
7. **拦截点取舍**：`pre-step`（干净 `reject`，但直接带 `messages`）vs `agent/request`（参数窄、可阻止，但 `agent.session` 仍可达正文）。**尚未定稿**，生产暂时保持 `pre-step`。

---

## 走过的弯路（我自己犯的，按时间）

1. **guard 读错字段**（`exec.call?.name` → `exec.name`）：整批工具被误拒。
2. **inbox target 写成 `nextTurn`**：`Cannot read properties of undefined`。
3. **注入消息缺 `id`/`source`**：会话日志损坏（`format v4 message requires a producer-owned source kind`）。
4. **PowerShell 双引号破坏模板字符串**：`newMsgId` 被改成 `() => msg--`，排查花了很久 → 之后改用 `write` 工具直接落盘脚本。
5. **假模型长时间固定返回 tool-call**：单轮 231 步死循环，后来改成「调一次工具后返回文本」。
6. **测试编排的 ready/go 文件握手失效**：READY 早写出，外部仍报 `ready=false`，导致规则没提交，我一度误判成「插件与路由的 state 不同步」。**真因是测试编排，不是架构**——这条错判已撤回。
7. **恢复没带 provider/model**：turn 直接失败，`{{model}}` 无值，让「重启后拦截」白测两轮。
8. **patch 文件漏装假模型插件**：`chiefProvider: fake` 没有 adapter，请求走了真实 provider，`before` 阶段一直无请求。
9. **profile 与生产代码哈希不一致时误读结果**：有两次测试实际跑的是生产代码（无日志/无 probe），把「decisions: none」当成守卫未触发。

---

## 当前状态（2026-11-05 深夜）

| 能力 | 状态 |
|---|---|
| 采集（范围/排除/路径解析失败拒绝） | 已实现并测试 |
| 御书房面板（双视图、范围设置、首辅右栏） | 已实现 |
| 摘要与纠错 | 已实现，质量验证有限 |
| 首辅对话（假模型、允许工具执行、写工具零调用） | 已验收 |
| 收紧后同一已打开会话拒绝（原生 UI） | 已验收 |
| 退休会话重启后拒绝 | 已验收（宿主级守卫） |
| 状态损坏/丢失时拒绝 | 已验收 |
| **严格隔离（正文不进入插件）** | **不成立**：两个公开拦截点都能接触正文 |
| 抛错时的界面文案 | 未验证 |
| 守卫安装失败注入 | 未验证 |
| 真实模型验收 | 未开始（未申请预算） |
| 移除测试用调试入口（`raw_send`/`debug*`） | 未做 |

---

## 待定

1. 拦截点定稿：`pre-step` 还是 `agent/request`，或等 DSH 提供不含正文的扩展点。
2. 正文接触边界的对外表述。
3. 首辅会话标题与 workspace 归属。
4. 移除生产源码里的调试工具后做一次回归。

---

## 2026-11-06 凌晨 — 摘要链路与收口

| 时间 | 事情 | 选择 / 结论 |
|---|---|---|
| 00:05 | 摘要接口权限泄露 | 撤权后原实现仍返回 `cwd`/版本数/来源/序号/模型/用量；改成只返回 `ok/allowed/status/message` |
| 00:10 | 摘要「生成了却没落盘」 | 用户查出 `leader_summarize` 的保存分支用了未定义的 `now`（ReferenceError）；改成 `storedAt`，`at` 与 `source.generatedAt` 同值 |
| 00:12 | 测试工具吞异常 | `pick()` 先取 `.value`，异常被丢掉；改成保留 `call()` 的 `ok/error/value` |
| 00:15 | 摘要三态 | 允许可见（含来源与 `sentSeqs`）→ 撤权简洁拒绝 → 恢复后原版本可见，全部通过 |
| 00:31 | 人工修订 | 探针拿到版本 id 后提交，`totalVersions:2`，修订版标「来源范围继承」，原版保留 |
| 00:33 | 源码线并行 | 启动独立子代理在 `_dsh-source-probe` 检出 DSH 官方源码，验证更窄的准入点 |
| 00:42 | 人工修订写失败注入 | 注入 `persistState` 失败：`ok:false`、版本数 1→1、磁盘不变（回滚生效） |
| 00:47 | 回归发现候选列表含首辅 | `candidates` 返回 91 行且首辅在内；加过滤后降到 7 行 |
| 00:47 | 移除调试工具 | 生产源码删掉 `raw_send` / `debug` / `debug_rules` 三段，回归仍全绿 |
| 00:48 | 文档 | README 追加「2026-11-06 状态更新」 |
| 00:54 | 摘要生成写失败注入 | `persisted:false`、`failureReason:'persist-failed'`、版本数不变 |

这一整天最大的教训来自用户那次直接指出 `now` 未定义：「生成后没落盘」被我连续两轮归因到假 adapter 和超时，其实是一行变量名错误。以后遇到「有返回值但副作用没发生」，先读保存分支的每一行，而不是怀疑外部依赖。

### 2026-11-06 凌晨 — 面板回归

| 时间 | 事情 | 结果 |
|---|---|---|
| 00:57 | `correct` 路由补丁核对后应用 | 判权/保留/回滚三处逐一核对过才跑 |
| 01:01 | 面板首次浏览器验收失败 | `openPanel.count: 0` —— `client.js` 没同步到 profile，哈希不一致 |
| 01:04 | 第三次通过 | 面板打开、版本列表、未选版本时提交按钮禁用并提示；选中后可用（中间一次失败是 `buildSessionsSection` 作用域 bug） |
| 01:09 | 提交修订回归 | 版本数 7→8，修订内容出现，编辑框清空，选中清除 |
| 01:12 | 撤权清空**未验成** | 测试用页面内 `fetch` 直接调规则接口，绕过了 UI 的 `postRules`，`refreshSummaryPanel()` 没触发；面板仍显示旧内容 |

撤权清空这条要等「通过界面保存规则」的路径才能验证。以后写浏览器回归时，凡是验证「规则变化后的界面反应」，都必须走界面操作，不能用页面内 fetch 抄近路。

### 2026-11-06 凌晨续 — 界面撤权

| 时间 | 事情 | 结果 |
|---|---|---|
| 01:16 | 界面撤权第一次失败 | 找错视图（采集范围不在「对话」也不在「项目」，是独立的 `scope` 视图） |
| 01:19 | 第二次失败 | 切错 tab，仍没找到排除会话的输入框 |
| 01:23 | **界面撤权通过** | 在采集范围界面填入排除会话并保存 → 面板 `hasRevokedMsg:true, hasVersionList:0`，已显示的版本被清空 |
| — | 其他入口撤权 | 未做：本页面之外修改规则时，面板不会自动刷新；需要定时重查或通知机制，当前没有 |
| — | 迟到响应 / 无 ID 旧版本 | 未做 |

界面回归的教训：脚本里点「哪个视图」这种前置条件，必须先在页面上确认实际的 tab 文案，不能按代码里的内部命名猜。

### 2026-11-06 凌晨 — 跨入口撤权与草稿保护

| 时间 | 事情 | 结果 |
|---|---|---|
| 01:26 | 把「后台判权检查」与「打开面板」拆开 | 新增 `checkSummaryAuth`：只更新授权状态，不清草稿与选中；检查失败保持现状 |
| 01:29 | 定时 + 切回页面立即检查 | 15 秒间隔 + `visibilitychange`；effect 依赖面板 sessionId |
| 01:30 | **草稿保护通过** | 面板打开、填草稿、等 17 秒后台检查 → 草稿仍在、版本列表仍在 |
| 01:30 | **跨入口撤权通过** | 页面内 fetch 改规则（模拟另一个窗口）→ 17 秒内面板自动转拒绝态、正文消失 |
| 01:33 | **恢复授权通过** | 接口 reset 后关闭再打开面板 → 版本列表恢复（7 版） |

文档口径按「约每 15 秒检查一次；切回页面时立即检查」，不写「最多延迟 15 秒」——后台标签页会被限速，网络也可能失败。

### 2026-11-06 凌晨 — 源码线结论

独立子代理在 `_dsh-source-probe` 检出官方源码并做了最小准入点验证，结论如下：

| 项 | 结论 |
|---|---|
| 版本对应 | 发行版 `desktopVersion` 是 **0.2.2-rc.1**（先前我记成 0.2.1-rc.5，记错了）；源码 tag `dsh-v0.2.2-rc.1` = commit `66491b0` |
| 贡献规则 | `CONTRIBUTING.zh.md` 明确不接受外部 PR，`has_issues=false`、`has_discussions=true`，只能走 Discussions |
| 能否做窄准入点 | **能**。新增 `agent/admit`：payload 仅 `sessionId/turn/step/signal`，派发不传 thisArg（回调 `this === null`），位置在 `inbox.claim` 与 `assemble` 之前 |
| 为什么 `agent/request` 会碰正文 | `agentEvents()` 融合派发器注入 agent 并把 scope carrier 设为 this；绕开它直接用 `ctx.waterfall` 就没有这个问题 |
| 隔离验证 | 事件面命中 0（深扫 payload/this/arguments 含原型链与 symbol）；**进程面不成立**——插件自己的 ctx 仍能 `ctx.get('sessions')` 读正文 |
| 行为 | 收紧前允许；撤权后 blocked（model 0、claim 0）；其它会话不受影响；guard 抛错 → 失败关闭 |
| 未完成 | 不能构建 monorepo（GitHub 克隆两次中断、tarball 20 分钟），未跑 tsc/test；桌面发行版兼容性未测 |

**结论**：把「发送控制」和「摘要采集」拆开——发送控制走 `agent/admit`（全程不碰正文），摘要采集另走明确授权的读取路径。想在一个扩展点里同时满足两件事才是矛盾的。

### 2026-11-06 凌晨 — 无 ID 回退与判权失败

| 时间 | 事情 | 结果 |
|---|---|---|
| 02:20 | 判权严格化 | 只有 HTTP 成功且明确 `allowed === true` 才算确认授权；401/500、解析失败、语义不明一律按「无法确认」处理 |
| 02:50 | 无 ID 旧版本回退 | 注入 `id: null` 的旧版本后，面板选中最前一版提交 → 落盘 `revisesId: 空`、**`revisesAt: 1700000000000`**（等于无 ID 版本的 at），按时间回退生效 |
| 02:55 | 判权失败提示 | `Network.setBlockedURLs` 拦截 summaries 接口 → 面板出现「授权状态暂时无法确认（上次成功检查：无记录）」；解除拦截后提示消失 |
| — | 慢响应失效 | 未测：代码已改成确认撤权时递增 `sumGenRef`，但没有构造「慢响应 + 撤权」的时序 |

上一轮无 ID 回退失败的原因：我选了版本列表的**最后一个**按钮，但无 ID 版本被 `unshift` 到列表**最前**。列表顺序是 push 顺序（旧→新），选错端就测不到。

### 2026-11-06 上午 — 认证与网络异常分支

| 时间 | 事情 | 结果 |
|---|---|---|
| 08:00 | 修认证分支 | 401/403（登录失效）与其它 HTTP 错误分开：前者清空内容并提示重新登录，后者保留草稿、标「无法确认」 |
| 08:05 | 修提示字段 | 网络异常分支原先写 `lastCheckError`，提示组件读 `authStaleReason`，原因显示不出来；统一成 `authStaleReason` |
| 08:30 | **401 清空** | 拦截 summaries 返回 401 → 面板正文消失、版本列表 0、显示「登录状态已失效」 |
| 08:35 | **慢响应 + 撤权** | 拦截请求延迟 6 秒，期间撤权 → 慢响应回来后旧正文没有重新出现（`sumGenRef` 递增生效） |
| 08:40 | **网络失败** | 拦截接口 → 正文与版本保留、草稿保留、提示「授权状态暂时无法确认（上次成功检查：无记录；原因：网络或请求异常：Failed to fetch）」；恢复后提示消失、草稿仍在 |

网络失败这条第一次被 401 的残留状态掩盖了：401 之后面板已是拒绝态，再测网络失败只能看到拒绝态，看不到「保留内容 + 无法确认」的分支。要测一个分支，得先让面板回到该分支的初始前提。

### 2026-11-06 上午 — 迟到响应（修正版）

| 时间 | 事情 | 结果 |
|---|---|---|
| 08:00 | 上一版慢响应测试**不成立** | 脚本在**请求阶段**暂停 6 秒，服务器收到时规则已收紧，返回的是新拒绝结果，根本没有「旧成功响应」；而且没记录请求是否在撤权前进入暂停 |
| 08:05 | 改成响应阶段截获 | `Fetch.enable({ requestStage: 'Response' })`，截获撤权前那次成功响应，用 `Fetch.getResponseBody` 确认 body 含测试正文标记，暂不放行 |
| 08:08 | **迟到响应通过** | `held: {status:200, hasMark:true}` → 撤权 → 下一次检查返回拒绝、面板清空 → 释放旧成功响应 → `hasModelBody:false, versionItems:0, hasRevoked:true`，旧正文没有重现 |

这次的关键是**握手**：先拿到「确属撤权前的成功响应」这个实体证据（status 200 + body 含标记），再谈它被丢弃。之前那版只证明了最终面板是拒绝态，证明不了「旧响应送达但被丢弃」。

> 口径修正（用户核对后指出）：`cdp-sum9` 截获的是**后台判权请求**，它的成功响应本来不会把摘要正文写回面板；释放操作的 CDP 成功结果也没留档。所以它证明不了「打开摘要的旧成功响应迟到时不会恢复正文」。这条仍需补测。

### 2026-11-06 晚 — Cordis isolate 实测

| 时间 | 事情 | 结果 |
|---|---|---|
| 19:40 | 编译 vendored cordis | `esbuild` 把 `work/vendor/cordis/src/index.ts` 打成 `probe/build/cordis.mjs`（72KB） |
| 19:50 | 最小用例第一版失败 | `provide` 传的是工厂函数，`get` 返回函数而不是实例；改成直接传实例 |
| 20:40 | 语义测试 | 见下表 |
| 21:00 | 补充测试报错 | 同一作用域重复 `provide` 同名服务抛错：`service "svc" has been registered at <root>` |

结果（`probe/ISOLATE-TEST.md`）：

| 用例 | 结果 |
|---|---|
| 子 ctx isolate 后不 provide | `null` —— 隔离作用域内服务被清空，**不回退**到父实现 |
| 隔离 ctx provide | 只影响该 ctx 及后代，原 ctx 仍是父实现 |
| 两个 isolate 同 label | 共享同一实现 |
| 隔离 ctx 访问其它服务 | 正常（`other-root`、`added-svc`） |

**结论**：`isolate(name)` 是「作用域解析」工具，能按 label 合并/隔离某个服务的实现；**不是访问控制**——隔离 ctx 仍能拿到父级其它服务（包括会话服务），所以不能当作「未授权正文不可达」的保障。这与子代理「进程面隔离不成立」的判断一致，现在有了最小实测。

### 2026-11-06 深夜 — 真实 agent-loop 接线（进行中）

| 时间 | 事情 | 结果 |
|---|---|---|
| 23:10 | 从源码打包 agent-loop | 用 esbuild + 自定义 resolver 把 `@deepseek-ai/*` 指到 `work/packages/**/src`（扫到 381 个包），产出 `probe/build/agent-loop.mjs` |
| 23:20 | 缺 zod | `npm install zod` 22 秒；esbuild 要加 `nodePaths` 指向 probe 的 node_modules，否则从源文件位置找不到 |
| 23:35 | 产物可加载 | 导出 `AgentLoop` 等 4 项 |
| 23:45 | cordis + admit 监听 | `new Context()`、`root.on('agent/admit', …)`、`root.plugin(AgentLoop, {})` 都返回成功 |
| 23:50 | **卡住** | `root.get('agentLoop')` 是 `null`：cordis Service 的注册时序没搞清，`plugin()` 挂载 ≠ 服务可用 |
| 19:50（次日） | 按 inject 补齐六个服务 | `AgentLoop.static inject = ['agents','sessions','llm','tools','systemPrompt','sessionProjections']`，补齐替身后**服务激活**，`Service.init` 调用链走通 |
| 20:30 | 新卡点 | `create()` 报 `sessions.prepare is not a function`；补上后又需要真实 Session 对象 |
| 21:20 | 改用仓库现成 harness | 按 `tests/interception.spec.ts` 挂载真实 `LlmRuntime / SessionStore / SessionProjectionRegistry / SystemPrompt / ToolRuntime / AgentRegistry / AgentLoop` + `MockAdapter`，全部打进同一份 bundle |
| 21:40 | 跳过 NativeToolExecutor | 源码副本的 `tools/src/index.ts` barrel 缺 `batch.ts`/`pipeline.ts`，而 `tool-executor-native` 从包根导入这两个符号 → 打包失败。这是副本与发行版的差异 |
| 22:05 | **真实循环里的 admit** | `create` 成功（`probe-1` idle），发消息后 `agent/admit` 被调用，payload 只有 `sessionId / turn / step / signal`，`hasAgent:false`、`hasMessages:false` |
| 22:10 | 仍缺 | admit 放行后模型调用数是 0，说明放行后的流程提前结束；拒绝路径、恢复路径都没测 |
| 23:20 | 修正 resolver 与导入方式 | ① `@deepseek-ai/dsh-tools/pipeline` 之前被映射到包根 index（错），改成按子路径找 `src/pipeline.ts`；② `tool-executor-native` 导出的是 `name/inject/apply`，要用 namespace import，不是 default。之前「源码副本缺 barrel」的判断收回 |
| 23:35 | **requests:0 的真相** | 把等待结果区分成 idle/timeout 后，`turn_ends` 显示 `turn/end` 原因是 error：`The selected tool executor is unavailable` |
| 23:45 | 补执行器后下一层错误 | `session event "system/message" is surface-eligible and requires a surfaceOp marker` |
| 23:55 | **定位 surfaceOp 丢失** | 三处插桩（commit 生成点 / 调用点 / Session.append）：intent 在调用点还在（`surfaceOp:"append"`），到 append 时 opts 为空。调用栈指向 `session.append` 的包装层 |
| 00:05 | **根因是测试代码** | harness 里为记录 `turn/end` 包装 `session.append` 写成 `(type, data) => origAppend(type, data)`，**吞掉了第三个参数**。改成 rest 透传后恢复 |
| 00:15 | **三条路径全部通过** | 允许：`requests:1`、`turn/end:completed`；拒绝：`requests:0`、`turn/end:blocked`；普通会话对照：probe-1 拒绝、probe-2 放行且模型调用 1 次 |

这一轮把 `agent/admit` 从「能触发」推进到「能按 sessionId 选择性拒绝，且允许路径真的调用了模型」。两次阻塞都是**我自己写的测试代码**造成的（包装吞参数、resolver 映射错），不是源码问题——这点要记住：接测试夹具时，先怀疑自己的包装层。

### 2026-11-06 晚 — 源码线收口

| 时间 | 事情 | 结果 |
|---|---|---|
| 20:30 | 三组原始输出落盘 | `probe/out/run-allow.txt`、`run-reject.txt`、`run-control.txt`、`summary.txt`，每份含命令、env、退出码与完整 JSON |
| 20:35 | 类型检查尝试 | 装 typescript 7.0.2 + @types/node，用 `tsc --noEmit -p packages/core/agent-loop/tsconfig.json --typeRoots …` → **失败**：TS6305 项目引用未构建（需先 `tsc -b` 全仓，而全仓依赖 pnpm install） |
| 20:40 | 恢复路径 | **未做**：需要接 `session-persistence-jsonl` 并构造「创建 → 关停 → 新 Context → resume」两阶段 |

口径：**esbuild 打包不是类型检查**，TS6305 也不是真实类型缺陷（是项目引用没构建的连锁结果）。

### 2026-11-06 晚 — 面板慢响应与收尾

| 时间 | 事情 | 结果 |
|---|---|---|
| 21:00 | 确认生产调试入口 | `allowRawSend` / `raw_send` / `leader_chief_debug` 在生产代码里已无残留 |
| 21:30 | **`openSummary` 慢响应** | 截获打开面板的成功响应（`status:200, hasBody:true`）→ 期间关闭面板 → 释放响应 → 面板保持关闭、正文没回来 |
| 21:40 | 文档 | README 的「源码侧结论」改成两层（isolate 作用域 / admit 真实接线），并写明未完成项与「不能装到日常 desktop」 |

这次慢响应测试和之前那次失败的区别：上次截获的是**后台判权请求**（响应不写正文），这次截获的是**打开面板的请求**（响应含正文），并且有「held 时 hasBody=true」这个实体证据。

**口径修正（用户核对后）**：
1. 测试脚本没保存 `continueRequest` 的 CDP 返回结果，也没记录前端「收到并处理」该响应的证据。所以最严谨的表述是「**截获旧响应、关闭面板、尝试释放后，面板未重开**」，不能概括成「所有迟到响应都被丢弃」。
2. 跨入口撤权、401、网络失败、迟到响应这几项验的是**摘要版本面板**，不能写成「首辅撤权的这些场景全部已验」。首辅侧目前只有「原生 UI 同实例收紧拦截」有证据；退休会话原生恢复、异常和重启等边界仍按既有记录。

### 2026-11-06 深夜 — 最小持久化恢复尝试

| 时间 | 事情 | 结果 |
|---|---|---|
| 22:00 | 搭恢复测试框架 | `probe/resume-entry.ts`：Context A 创建 + 发消息 → flush → dispose → Context B `resume` → 再发消息 |
| 22:30 | 补依赖 | 打包 jsonl 后端要 `p-limit`、`@js-temporal/polyfill`、`rrule`，`koffi`（win32 原生）标 external |
| 23:00 | 第一次跑 | persistence 服务可用（`hasPersistence_p1: true`）、创建路径模型调用 1 次；但落盘目录为空，resume `not found` |
| 23:45 | 显式 flush 后 | 目录建出来了（`_no-cwd/resume-probe-1`），但 `flush` 报 `session-persistence-jsonl flush failed`，resume 仍 `not found` |

**恢复路径未通过。** 已确认「服务挂上、目录结构创建」，未确认「写入成功、resume 能读回」。`_no-cwd` 提示会话缺 cwd（`create` 的 meta 为空），这可能是 flush 失败或 resume 找不到的原因之一，但没定位。

### 2026-11-06 深夜 — 观察试用版

| 时间 | 事情 | 结果 |
|---|---|---|
| 21:00 | 加 `observeOnly` 开关 | 守卫安装改成条件表达式；`chiefCreate`/`chiefSummon` 开头直接返回错误 |
| 21:30 | 观察版隔离验证 | `summon: ok=False error=观察版未启用首辅（observeOnly）`、`chief_get: exists=False`；state 里 `sessions=52`、`pollCount=2` |
| 21:40 | 对照（observeOnly=false） | `summon: ok=True`、`chief_get: exists=True` —— 拒绝确实由开关触发 |
| 22:00 | 发现缺陷 | HTTP `/sessions` 在两种模式下都返回 0（state 有 52 条），是探针取数问题，**未定位** |

观察版的关键是**执行路径禁用**，不是界面隐藏：守卫不安装、首辅入口 execute 直接返回错误。`OBSERVE-MODE.md` 记录了启动方式、允许范围、禁用证据与当前缺陷（HTTP 列表返回 0）。
















### 2026-11-06 21:00–21:20 — 正文文案重跑 + 观察版首辅入口补齐

| 时间 | 事情 | 结果 |
|---|---|---|
| 21:08 | 重跑正文失败文案专项 | hang：12.1 秒出横幅「项目总览：响应正文读取超时（12 秒）」，诊断 `overview 200 (正文超过 12 秒未读完)`；badjson：1.5 秒出「响应正文不是有效 JSON」，未误报超时。当前 `client.js` 未再改，三分类成立 |
| 21:15 | 核对观察版首辅入口 | 发现 `leader_chief_recover`、`leader_chief_release`、`leader_chief_inspect` 三个工具入口没有 observeOnly 检查（recover 会清登记写 state，release 会释放句柄写 state）；`leader_chief_selftest` 有重复行 |
| 21:16 | 修 | 三处补拒绝；删重复行 |
| 21:17 | 发现反向问题 | `leader_detail` 被误加了 observeOnly 检查（文案还写着"未启用首辅"），而它读的是被采集的允许会话，与首辅无关 → 删掉 |
| 21:18–21:20 | 逐项验证 | 同一份含「已有首辅记录」的 state，`observeOnly:true` 下 11 个 `leader_chief_*` 入口全部 `denied`、文案一致；`leader_detail`/`leader_tag` 正常。对照 `observeOnly:false`：`chief_status` 返回 `chief`、`chief_recover` 返回 `exists:true`。原始输出 `out/observe-verify-on.json` / `-off.json`，记录 `out/OBSERVE-VERIFY-2026-11-06.md` |

口径修正：上一轮"`chief_get: exists=False`"只覆盖空首辅状态，不能证明有记录时各入口都不可执行；本轮换成 state 里带 chief 记录的逐项调用。

未覆盖：`leader_tag` / `leader_correct` / `leader_summarize` 在观察版下仍可执行（写标签、写摘要版本、非 dryRun 调模型），已在 `OBSERVE-MODE.md` 限制 3 写明。

### 2026-11-06 22:06–22:41 — 观察版收口（HTTP 入口 / 采集诊断 / 浏览器）

| 时间 | 事情 | 结果 |
|---|---|---|
| 22:10 | 补 HTTP 入口 | `chiefRelease`/`chiefClose`/`chiefRecover` 三个函数第一行加 observeOnly 拒绝（HTTP 与工具共用，不只挡工具层） |
| 22:12 | 摘要策略 | `leader_summarize` 在 observeOnly 下拒绝 `dryRun=false`；标签与人工修订保留（写本地状态，不改会话日志） |
| 22:15 | 面板 | 顶部观察版说明条、首辅区只显示「未启用」、修订区写明写本地版本；采集范围栏显示采集诊断 |
| 22:20 | 干净 state 采集 | 52 条（允许 52 / 同步 49），`/sessions` 200 + 52 —— **没有复现 0** |
| 22:23 | 旧复制 state 复测 | `/sessions` 同样 200 + 52；旧日志只有 `count=0` 一行、没有 HTTP 状态，旧脚本 overview 步骤还调的是不存在的 OP → 之前「探针取数问题」的归因证据不足，改记为「当前不复现、无法回溯」 |
| 22:25 | HTTP 首辅前后 | observeOnly=true：summon/release 均 `ok:false`，`chief`+`chiefs` 指纹 `82a799…` 前后不变；对照 false：`release` 返回 `released:true` 且指纹变为 `8a1030…` |
| 22:27 | 工具回归 | 11 个首辅入口全拒；detail/tag 正常；summarize dryRun 正常、非 dry-run 被拒；correct 追加版本成功（1→2） |
| 22:35 | 守卫对照 | `leader_status.preStepGuardInstalled`：观察版 `false`、对照 `true` |
| 22:41 | 浏览器 | 项目 1 组（51 会话）、对话 51 行、采集诊断行完整、观察版提示与首辅禁用一致（`out/final-ui.png`） |

新增的 `diagnostics`（state/索引/匹配/缺 cwd/可见 + 最近一轮允许/同步/跳过原因）是这轮最有用的副产品：以后再有「列表是 0」，能直接看出卡在索引、cwd 还是规则。

### 2026-11-06 22:58–23:15 — 试用前收口

| 时间 | 事情 | 结果 |
|---|---|---|
| 22:58 | 浏览器摘要查看 | 面板正常显示夹具版本、来源与正文 |
| 22:59 | 人工修订 | 提交成功，但「已追加新版本」提示被 `openSummary` 里的 `setSumMsg(null)` 立刻清掉 → 加 `keepMsg` 选项，重跑后提示可见 |
| 23:00 | 规则收紧 | `excludeSessions` 加该会话 → 列表 52→51、该会话消失、诊断同步；清空后恢复 52→会话回来 |
| 23:10 | 试用配置 | 新增 `leader/observe-trial.yml` 与 `OBSERVE-TRIAL.md`（允许目录/状态目录/轮询/停止/回滚）；用该配置实起一次：`observeOnly:true`、采集 52 条、首辅入口拒、无插件告警 |
| 23:12 | 文档边界 | `OBSERVE-MODE.md` 补一句：`dryRun` 预览本身也含已授权会话内容；并链到试用文档 |

顺带发现并修掉一个 UX 缺陷：提交修订成功后，面板重开会把成功提示清掉，用户只能靠版本数自己数。

### 2026-11-06 23:10–23:15 — 试用文档修正 + 首次隔离试用

| 时间 | 事情 | 结果 |
|---|---|---|
| 23:10 | 文档修正 | 删掉「先关日常 desktop」；改为确认端口归属（查命令行能否对上，对不上就换端口，不停别人的进程） |
| 23:11 | 停止口径 | 「等 5 秒」改成按实际状态判断：前台 Ctrl+C 优先；后台只能终止；是否在采集看 `pending.json` 与 `pollCount` 是否还在涨；`pending.json` 恢复能力不当作通用保证 |
| 23:11 | 试用目的 | 新增第零节：`test-home` 看到的是隔离测试会话，只能评估界面与操作感；读真实工作会话要先定范围（当前 `allowCwds: [B:/DSH]` 在真实 HOME 下过宽） |
| 23:12 | 结束口径 | 状态目录改为**保留**（内含标签与人工修订），删除不是回滚步骤 |
| 23:13 | 隔离试用 | 端口空闲 → 起实例 → `observeOnly:true`、采集 52 条、首辅入口拒、三视图正常 → 停止无 pending 残留、`pollCount` 停在 5 |
| 23:14 | 发现 | 版本面板显示「还没有摘要版本」：观察版不生成摘要，新 state 无历史版本；要看内容需先用完整版在同一 stateDir 生成或迁移版本 |

试用记录：`_leader-probe/out/TRIAL-RUN-2026-11-06.md`。

### 2026-11-06 23:20 — 试用收口与真实价值验证准备

| 事情 | 结果 |
|---|---|
| 修正「只有两条路」 | 摘要面板要有内容其实有三种方式，第三种是放**明确标记为测试数据的构造摘要**——不用启完整版、不用真模型。此前浏览器回归（`trial-1/2`）就是这么验的，所以空态不影响那条证据 |
| 产品口径 | 写清面板能说明什么（会话、事件数、同步状态）与不能说明什么（做到哪一步、卡在哪）。一行「已同步」只代表事件读到了，离「几十个会话压成一份项目状态」还差语义摘要这一层 |
| 真实价值验证 | 新增 `OBSERVE-VALUE-PLAN.md`：等指定 3–5 个真实会话后，用 `allowSessions` 显式名单 + 慢轮询 + 独立 stateDir 跑只读验证（面板 + dryRun，成本 0）；判断标准先定——能否说清进展、省不省时间、缺计数还是缺摘要 |
| 边界 | 未读任何真实工作会话，未启真实 HOME 实例；源码恢复线单独排期，不挡价值评估 |

### 2026-11-06 23:45 — 价值验证方案修正（判权是「或」不是「与」）

用户核对 `decideAccess`（`index.mjs:36`）发现方案骨架有误：`allowSessions` 与 `allowCwds` 是**任一命中即允许**，同时填会话名单和目录会把该目录下其它会话一并放进来。方案已改：

| 项 | 改为 |
|---|---|
| 允许条件 | 只填 `allowSessions`，`allowCwds: []`；cwd 仅用于核对名单 |
| 启动核对 | 加「规则来源」一项：`state.json` 里的旧 `rulesOverride` 会覆盖配置文件基线 → 必须用全新空 `stateDir`，并核对 `rules.source === 'config'` |
| 名单外拒绝 | 明确要求验证「同 cwd 名单外会话被 `denied-by-default` 拦掉」，通过才读详情与 dryRun |
| 副作用表述 | 「只读」改成「不调用模型；人工修订与标签会写入独立 Leader 状态；面板与 dryRun 展示已授权会话正文」 |
| 价值对比 | 同批会话、同组问题，分别记有无面板用时；原始会话没写的就记「未提及」，不推断、不算面板功劳 |

判权「或」的语义也补进 `OBSERVE-MODE.md` 与 `OBSERVE-TRIAL.md`，避免以后又按「目录 + 名单」收窄。

### 2026-11-06 23:55–00:20 — 真实会话价值验证（HALO 10 个）

| 时间 | 事情 | 结果 |
|---|---|---|
| 23:55 | 定位会话 | 只读会话文件 header：真实 HOME 579 个会话，13 个 cwd 分组；HALO 组 10 个（24–394 KB） |
| 00:00 | 用户选定 | 组 A 全部 10 个 |
| 00:05 | 执行方式 | 不在真实 HOME 起实例，改为把 10 个会话只读副本拷入 `test-home/sessions`；原文件未动 |
| 00:10 | 核对 | `source: config`、`allowCwds: []`、名单 10 条一致；`/sessions` 恰好 10 条；`denied-by-default: 57` 挡住名单外 |
| 00:15 | 读取 | 10 个会话详情全通；dryRun 全部成功；`dryRun:false` 被拒 |
| 00:20 | 关键发现 | `summaryMaxChars` 默认 6000：10 个会话里 7 个占预算 95%–100%，480 事件那条只装进 5695 字符——默认预算装不下中等会话，要覆盖全过程得分段或调高 |

价值判断（待用户实测）：面板给的是原料（事件数、活动时间、同步状态、拟发送正文），不是「做到哪」的结论。这与「几十个会话压成一份项目状态」还差语义摘要一层。

### 2026-11-07 11:00–11:10 — 截断精确核对与数据清单

| 事情 | 结果 |
|---|---|
| 补 `dryRun` 诊断字段 | `leader_summarize` 返回 `sentSeqs` / `sentCount` / `lastTextSeq` / `lastSentSeq` / `tailGapSeqs`——只看 `chars` 占用判断不了漏了什么 |
| 截断实测 | 7 个会话被截断，只送 44–53 条可送事件（会话有 132–279 条）；`48583f1d` 只送到 seq 98，尾部缺口 380；3 个短会话完整 |
| 覆盖率 | 19%–37%，不是「接近装满」；平均每条 107 字符，6000 字符只够约 55 条 |
| 名单外拒绝补证 | 名单 10 → 9（去掉同 cwd 的 `3c4657c3`），`/sessions` 9 条、`denied-by-default` 57 → 58，`allCwds` 只有那一个目录——同 cwd 被拒成立 |
| 数据清单 | `out/DATA-INVENTORY-2026-11-07.md`：唯一含正文的是 170 个会话副本（5.61 MiB，其中本轮 HALO 10 个 2.17 MiB）；state/json 产物无 >200 字符字符串，不含正文；日志含失效 token |
| 测试准备 | `out/TRUNC-ANALYSIS-2026-11-07.md`：短会话优先、分批交换先后顺序、固定三问、允许「未提及」 |

启动脚本改用 `ProcessStartInfo.EnvironmentVariables` 传环境变量：`cmd /c set A=B&& ...` 链在部分调用方式下会让 `--patch` 参数解析出错（`too many arguments ... got 1: .`）。

### 2026-11-07 11:40–12:00 — 覆盖设计与表述修正

| 事情 | 结果 |
|---|---|
| 覆盖统计（不调模型） | 对 10 个会话用 dryRun 递归切段 + 首尾窗口，比较四种打包：单段 / 全文分段 / 尾部 30 seq / 首尾 |
| 关键数字 | 480 事件那条：单段 1 次覆盖 0–98；全文分段 **8 次** 30765 字符全覆盖；尾段 1 次 1633 字符覆盖 448–478；首尾 2 次 2824 字符覆盖 0–30 + 448–478 |
| 粗估成本 | 10 会话总计：单段 ≈ $0.021、全文分段 ≈ $0.088（44 次调用 / 166 K 字符）、尾部 ≈ $0.017、首尾 ≈ $0.034（按 1200 输出上限粗估，非账单） |
| 结论 | 四种方式看到的内容完全不同：单段与尾段都只覆盖约 20%，一个看头一个看尾。**不下定论**，等用户按覆盖率/质量/成本取舍 |
| 关键事件选取 | 未实现：`leader_summarize` 只支持 fromSeq/toSeq，不支持类型过滤；要做需先加参数 |
| 表述修正 | ① 19%–37% 改为「有文本事件数占比，非语义信息覆盖率」② 不核对尾部正文不能断言「最新结论一定在未发送区」③ 「无 >200 字符」不等于不含正文，改「未发现长字符串，是否含短正文未完全排除」 |

原始数据：`out\cover-probe.json`、`out\cover-summary.json`、文档 `out\COVER-DESIGN-2026-11-07.md`。

### 2026-11-07 11:50–12:10 — 两档摘要方案设计

| 事情 | 结果 |
|---|---|
| 核对短会话前提 | **前提不成立**：`3c4657c3` 预算内覆盖全部 32 条有文本事件，但**12 条被单条截断**（`PREVIEW_CAP=300`，seq 18 的 13,615 字只送 300）；长会话 63 条 |
| `PREVIEW_CAP` | `index.mjs:231` 硬编码常量，"全文摘要"在当前实现里不存在，每条最多 300 字 |
| 长会话分段 | 8 段：0–59 / 60–119 / … / 420–479，每段 3,226–4,473 字符，合计 30,765 |
| 遗漏分类 | 预算截断（单段漏 99–478）、单条截断（63）、系统注入过滤（3，设计如此）、无预览元数据（198） |
| 首尾候选 | 头 1,191 + 尾 1,633 字符，但中段 31–447 的 83 轮工作完全不进模型 |
| 来源与合并 | 每段存 `segmentIndex/fromSeq/toSeq/sentSeqs/singleTruncatedSeqs`；合并单独一次调用，记 `kind:'merged'`、`basedOn: [...]`；长会话 9 次调用 |
| 口径 | dry-run 的"8 次"是潜在调用数不是已发生调用；合并与重试未计入；"全文分段"只保证序号范围切完，不保证正文完整（还有单条截断） |

文档：`out\SUMMARY-DESIGN-2026-11-07.md`；`out\COVER-DESIGN-2026-11-07.md` 已补两条口径。

### 2026-11-07 12:00–12:20 — 单条上限可配置 + 预算截断不再静默丢弃

| 事情 | 结果 |
|---|---|
| 拆开两个上限 | 界面预览固定 `PREVIEW_CAP=300`；摘要输入新增 `cfg.summaryEventMaxChars`（默认 300） |
| 修预算逻辑 | 原逻辑单条超预算就 `break`，把它之后的全部内容静默丢弃 → 改为该条截断送入并记录原始/送入长度，后续逐条记入 `skippedByBudget` |
| 新增诊断 | `summaryEventCap`、`budgetTruncatedCount/Seqs`、`skippedByBudgetCount/Sample` |
| 300 vs 2000 实测 | 长会话：单条截断 63→27，但分段 8→21、总字符 30,765→95,086；短会话：1 段→5 段。**调高上限降低单段覆盖**（长会话单段送达 53 条→34 条） |
| 成本重算 | 长会话 21 段 + 1 合并 ≈ $0.048（原 8+1 ≈ $0.019）；300 上限下的成本表已标注失效 |
| 首尾方案 | 标为探索性候选，不作覆盖保证 |

文档：`out\CAP-COMPARE-2026-11-07.md`。

### 2026-11-07 12:20–12:40 — 续接验证：超长事件尾部不会续接

| 事情 | 结果 |
|---|---|
| 构造验证 | 1.9 万字事件带 HEAD/TAIL 标记，三组配置（cap300/2000、budget1000 强制段预算截断）× 三个窗口，**TAIL 一次都没出现** |
| 结论 | 「全文分段」只覆盖规划的 seq 范围，不覆盖超长事件正文尾部——**不能称为全文分段** |
| 后续不受影响 | 新的预算逻辑漏的是该条自己的尾部，不是它之后的全部内容（后续段正常送入 seq 3–5） |
| 集成路径失败 | 构造会话进不了 DSH 会话索引（新 id 不返回；替换已索引 id 后仍 `allowed: 0`），改走函数级验证（复用生产 `previewOfEx` + 逐行复制打包循环） |
| 遗漏口径 | `skippedByBudget` 225/264 是**单次 full 调用**统计；分段后段内预算截断合计 0，真正的遗漏只剩单条截断与超长尾部 |
| 请求清单 | 短 cap300 = 1 次（单段不合并）；短 cap2000 = 5+1；长 cap300 = 8+1；长 cap2000 = 21+1 |

报告：`out\CONTINUITY-REPORT-2026-11-07.md`。

### 2026-11-07 12:55–13:15 — 续接原型（按字符位置切片）

| 事情 | 结果 |
|---|---|
| 原型 | `_leader-probe/proto-continue.mjs`：片段 = `{seq, part, totalParts, charFrom, charTo}`，单条按 sliceChars 切片、跨段续接；单片超预算独占一段并标 oversized |
| 构造验证 | 19,278 字 + 5 个位置标记，4 组配置：标记各出现一次、顺序正确、gap/overlap 全 0、无超大片段 |
| 真实会话 | 短：32 条 / 52,104 字 → **10 段** 54,445 字；长：279 条 / 169,322 字 → **34 段** 181,948 字；三组 slice 下未完整覆盖均为 0 |
| 系统注入 | 两个会话各 3 条 / 6,237 字，单列不参与摘要 |
| 语义澄清 | 现有 `summaryEventMaxChars` 是**每条总量上限**（超出永久丢失）；续接需要的是**每片长度**。两者不能共用配置名 |
| 成本 | 续接 ≈ 现有 cap300 的 4–6 倍（长会话 35 次请求 $0.078 vs 9 次 $0.019），换 100% 覆盖 |
| 未决 | 合并输入 34×400 字 = 13,600 字，**超过单段 6000 预算**，合并本身还要二次分组；构造会话未进索引的原因未查清 |

报告：`out\CONTINUITY-PROTO-2026-11-07.md`。

### 2026-11-07 13:24–13:50 — 分层合并设计 + 隔离集成测试

| 事情 | 结果 |
|---|---|
| 修原型 | `oversized` 废弃：切片长度按段预算反推（`min(目标, 预算-头部预留)`），放不下直接 `PlanError`，不产出超预算段 |
| 覆盖率口径 | 拆成两个数：正文区间覆盖率（试验配置均 100%，gap/overlap 全 0）与头部开销占比（2.1%–13.8%） |
| 分层合并 | 34 段 → 2 层 4 次合并（每组 14 条，估算 400 字/条）；失败条件四种：单条≥预算、预算只够 1 条、超层数、组内超预算 |
| 集成测试 | 5 组切片配置全部通过：不超预算、无 gap/overlap、标记齐全、顺序单调；slice=20000 被自动收紧到 5936；预算 100 → PlanError |
| 真实会话 | 短 10 段 / 54,445 字；长 34 段 / 181,948 字（均 100% 正文覆盖） |
| 口径修正 | 「4–6 倍成本」改为输入规模比较；`sliceChars=1000` 标为原型参数 |

报告：`out\CONTINUITY-MERGE-2026-11-07.md`；集成测试 `_leader-probe/proto-integration.mjs`（退出码 0）。

### 2026-11-07 13:30–13:45 — 输入构成分析（不含正文）

| 事情 | 结果 |
|---|---|
| 类型分布 | 工具结果占正文 **97.7%–98.9%**；用户+助手消息合计 <2%（短 441 字 / 长 2,883 字） |
| 三方案 | 短：A 全量 10 段/11 请求 27K token、B 工具≤500 2 段/3 请求 3.1K、C 仅消息 1 段/1 请求 340 token；长：A 34 段/38 请求 91K、B 8 段/9 请求 22.8K、C 2 段/3 请求 3.1K |
| 覆盖率口径 | 相对全部正文：A 100%、B 10.1%/21.7%、C 0.85%/1.70%；B/C 区间仍完整，是主动丢弃 |
| 预算检查 | 字符（6000/段）与 token（粗估 3000/段）分别检查，全部 OK；token 用 chars/2 口径，与 `roughInputTokens` 一致 |
| 关键矛盾 | 成本全在工具结果，但"做到哪"的信息密度在消息里；削减工具结果等于去掉证据，不是去噪 |

报告：`out\INPUT-BREAKDOWN-2026-11-07.md`；脚本 `_leader-probe/input-breakdown.mjs`。

### 2026-11-07 13:45–14:00 — B 方案受控试验准备

| 事情 | 结果 |
|---|---|
| 核对表 | 短会话 `3c4657c3` 是「剑握 M3 深度归属批次」的独立复核任务；目标、6 条已完成结果、1 处路径失败（后经 glob 找到）、**REVIEW_RESULT 未产出**，均带 seq |
| 发送内容 | 只保留 seq 8 真实指令（9/10/11 系统注入过滤），11 条工具结果各截前 500 字，最终约 6,228 字符 / 2 段 |
| 请求清单 | 最多 3 次（2 段 + 1 合并，可能不合并），不重试 |
| 费用上限 | 粗估 ≈ $0.0055，拟设 $0.05 上限；已注明 chars÷2 只是粗估，中文可能接近 1 字符/token |
| 停止条件 | 费用、请求数、输入字符、空正文/授权撤销、需要重试，任一触发即停 |
| 口径修正 | 「消息信息密度更高」改为「消息只占字符 1.7%–2%，密度高不高没有证据」 |

方案：`out\TRIAL-PLAN-B-2026-11-07.md`（待确认，未执行）。

### 2026-11-07 13:50–14:15 — B 方案检查补齐

| 事情 | 结果 |
|---|---|
| 实际请求构造 | 段 1 = 5,669 正文 + 466 指令 = **6,135 字符**（已超 6000）；段 2 = 1,025；合并约 1,266；**总计约 8,426**，此前「总计 7,000」未计指令 |
| 停止阈值 | 改为：单次 >6,200、累计 >8,600 即停，按实际构造逐次累计 |
| 预算检查 | 发送前按「1 字符 = 1 token」保守估、输出按 1,200 全额计；无法确认当时价目就停；三次合计保守 ≈ $0.00685 |
| 核对表分层 | 新增「未发送 vs 已发送但摘要遗漏」两类记录：工具结果截掉 46,822 字，任务书/复核报告的 501 字之后各约 13K 字，系统注入 6,237 字，这些漏了不算模型错 |
| 执行能力核实 | `deepseek-flash` 在源码与桌面端 asar 都存在；但 `observeOnly` 下真实调用**硬拒绝** → 方案当前不可执行，需先做受控入口 + 假模型验证 |

方案：`out\TRIAL-PLAN-B-2026-11-07.md`（已更新，仍待确认）。

### 2026-11-07 13:55–14:25 — 受控入口假模型验证（5 场景）

| 事情 | 结果 |
|---|---|
| 受控入口 | `leader_trial_summary`，只在隔离副本 `_leader-probe/dsh-leader-trial.mjs`；被测会话单列、B 方案、最多 3 次、不重试 |
| 发送前检查 | 会话已采集 → 未停止 → 次数 → 单次 ≤6,200 / 累计 ≤8,600 字符 → 价格已确认 → 预算预留 |
| 场景 A | 段1 6,135 + 段2 1,025 + 合并 518（用实际摘要）全成功，累计 $0.008927，假模型调用 3 次 |
| 场景 B | 第 4 次「已达请求上限 3」，调用增量仍 3 |
| 场景 C | 会话不符 → 「指定会话未被采集」，调用增量 0 |
| 场景 D | 预算不足 → 预留 $0.005121 > 上限 $0.0001，调用增量 0 |
| 场景 E | 模型失败 → 第一停、后续「已停止」，调用增量 1 |
| 字符范围 | 计入系统指令 466 + 片段头 + 正文；不含 provider 层 JSON 包装；实测累计 7,678 ≤ 8,600 |
| 预算边界 | token 按「字符×2」假设、价格硬编码 → $0.05 只是发送前估算上限，不是服务端硬上限 |

报告：`out\TRIAL-ENTRY-VERIFY-2026-11-07.md`；脚本 `_leader-probe/trial-verify.ps1`。

### 2026-11-07 16:10–16:40 — 真实调用前最后核对

| 事情 | 结果 |
|---|---|
| 试验白名单 | 新增 `trialAllowedSessions`；场景 F「已采集但不在名单」→ 拒绝，假模型调用 **0** |
| 实时授权 | 发送前用 `readTitleSnapshot` 取最新 cwd 再跑 `decideAccess`；场景 G 收紧 `excludeSessions` 后 → 「发送前授权已失效：excluded-by-session」，调用 **0** |
| 并发 | 加进程内互斥 `trialBusy`；场景 H 两次并发 → 一次成功、一次「并发请求被拒」，调用 **1** |
| 重启 | 次数与预算是**单进程内存状态**，重启归零，未解决；只能约束"测试期间单实例、不重启" |
| 费用表述 | `$0.05` 降级为「本地预估上限」，不是硬上限（token 上界是假设、价格硬编码、包装未计） |
| 请求清单 | 32 条 / 原文 52,104 字 → 发送 5,291 字；截断 9 条（18/23/25/30/32/37/46/51/53）；系统注入 3 条不发 |

脚本：`_leader-probe/trial-verify2.ps1`、`trial-manifest.mjs`；报告：`out/TRIAL-FINAL-CHECK-2026-11-07.md`、`out/TRIAL-REQUEST-MANIFEST-2026-11-07.md`。

### 2026-11-07 16:40–17:00 — 决定不执行真实调用；核对措辞；内阁模式报告评估

| 事情 | 结果 |
|---|---|
| 执行决定 | **不发送**。用户消息明确写「本次消息和我的建议都不构成你的发送授权」，不能把建议当授权 |
| 措辞修正 | 5,291 是**事件正文**（另加片段头 937 + 两次指令 932 + 合并摘要）；100% 是**规划 seq 范围的区间覆盖**，不是原文覆盖 |
| 授权验证边界 | G 只验证「规则收紧 → 拒绝」；**实时 cwd 变化分支未实测**；检查通过后若撤销，已发内容无法撤回 |
| 内阁模式报告 | 核心结论认同（先观察+可信摘要，后团队）。核实到一处实证：`/rules` POST **没有客户端 epoch 校验**，只有服务端递增——报告 3.3 的冲突保护建议是真实缺口 |
| 现状差异 | 大明当前是自绘 320px 侧栏（`ldr-chatpanel`），**不是原生右栏注册**；报告 3.1 的借鉴需要先确认目标 DSH 版本的右栏接口 |

### 2026-11-07 17:00 — 收尾：停在发送前，两条设计约束确认

用户确认：**不取 key、不配置凭据、不调用真实模型**；摘要试验保持当前状态；内阁对照表不插入本轮。

| 约束 | 内容 |
|---|---|
| 规则保存冲突 | 修复时用**独立的规则修订号**；`rulesEpoch` 只表达权限收紧，不能当所有保存操作的版本号 |
| 首辅栏 | 是自绘 320px 侧栏（`ldr-chatpanel`），不是原生右栏；迁移须在目标 DSH 版本单独验证 |
| 后续可选验证 | 凭据解析先用**无效占位值**核实读取路径；cwd 变化用**构造数据**测试；都不需要真实 key |

### 2026-11-07 17:00–17:20 — 多会话规模测算 + 凭据/cwd 验证（均不调模型）

| 事情 | 结果 |
|---|---|
| 规模测算 | 10 份副本：正文 1,773,291 字符；**全量续接 388 次请求 / 186 万字符**；B（工具≤500）**58 次 / 25 万字符**；分级前 5 个 **41 次**、覆盖 76% 事件、5 个会话不可见 |
| 结论 | 全量路线先淘汰（瓶颈不是切片，是"所有工具结果全文进模型"）；B 仍不便宜且丢 70–90% 正文；跨会话合并很便宜（10 条只需 1 次），省的地方在会话摘要 |
| 凭据解析 | 静态查：`DEEPSEEK_API_KEY` **只出现在 tests**，`llm-deepseek` 的 `api-key.ts` 只做格式校验，凭据走 credential 服务；运行时确认需发一次网络请求（401 或 `/models`），**未做**，需授权 |
| cwd 变化 | 改写会话 header 后 DSH 判 **corrupt session log**，`readTitleSnapshot` 失败 → 入口拒绝「无法取得最新元数据」；**cwd 失权分支未验证到，但 fail-closed 被验证**（拒绝且假模型调用 0）；文件已按 SHA256 恢复 |

报告：`out/SCALE-ESTIMATE-2026-11-07.md`、`out/CWD-CRED-VERIFY-2026-11-07.md`。

### 2026-11-07 17:30–18:00 — 规则保存冲突修复与验证

| 事情 | 结果 |
|---|---|
| 修复 | 新增独立 `rulesRevision`（每次保存 +1，含放宽），GET 返回、POST 必须带 `baseRevision`；冲突 409 不写入 |
| 串行性 | 比较与写入在同一同步调用内（`writeFileSync`+`renameSync`），Node 单线程下天然互斥；注释写明「落盘一旦改成异步，此性质失效」 |
| 严格校验 | 缺失 / 字符串 / 负数 / 小数 `baseRevision` 一律 400，不能绕开检查 |
| 草稿保护 | 409 时只刷新服务端现状，**不覆盖用户草稿**，提示可复制后重新提交 |
| 验证 7 场景 | 并发保存 1 成功 1 冲突、revision=1；保存 vs 恢复 1 成功 1 冲突；写盘失败 500 且 revision/规则均不变；重启后 revision 一致 |
| cwd 失权 | 测试替身替换 `readTitleSnapshot`：允许 cwd 下成功（假模型 1 次），换成排除 cwd 后拒绝「发送前授权已失效」，假模型不增加 |
| 凭据来源 | 拦截式探针定位到：**`DEEPSEEK_API_KEY` → `x-api-key` 头 → `/v1/messages`**；不设变量则不发请求；全程零外网（base URL 指向 127.0.0.1:9 + fetch 被拦） |

报告：`out/RULES-CONFLICT-VERIFY-2026-11-07.md`。

### 2026-11-07 18:20–18:35 — 收尾与性能基线方案草案

| 事情 | 结果 |
|---|---|
| 凭据结论 | 限定为「当前隔离配置下的环境变量路径」：占位值从 `DEEPSEEK_API_KEY` 到 `x-api-key`，本地拦截且无外网；不排除其他配置下还有别的来源 |
| 规则修复口径 | **单进程接口验证通过**；浏览器草稿保留、多进程写入未验证 → 试用时仍需单一写入者 |
| 性能基线 | 未在既有文档找到名为「性能基线」的条目，按「轮询/读取/首屏耗时 + 内存」起草 `PERF-BASELINE-PLAN.md`，含指标分档、测量方法、建议阈值 |
| 本轮约束 | 不启动实例、不读更多真实会话、真实 key 与日常实例不动 |

方案：`leader/PERF-BASELINE-PLAN.md`（草案，待确认）。

### 2026-11-07 18:35–18:50 — 性能基线方案第 2 版

| 事情 | 结果 |
|---|---|
| 目标修正 | 区分 **DSH 本体 / 大明观察版**两组开销；host 与 renderer 分开记 CPU 与内存；`readSession` 耗时不等同 CPU 归因；`archive-manager` 对照另列后续 |
| 阈值 | **先不设通过线**；2s / 800ms / 1.5s / 50MiB 降为待验证参考值，先报每次结果、中位数与范围 |
| 样本 | 10 份副本，最长 480 事件 → **`>500` 档标"无样本"**；同时记文件大小、事件数、工具结果规模 |
| 口径修正 | stateDir 用**全新单独命名**、保留既有不删；首屏定义「触发入口 → 表格/空态可见」且不把三个请求相加；`readSession` 分首次/重复并声明 n=3 不覆盖尾部；RSS 差只是观察值，每阶段记持续时间与采样点 |

方案：`leader/PERF-BASELINE-PLAN.md`（第 2 版，待执行）。

### 2026-11-07 18:45–19:05 — 性能基线 A/B 实测（各 3 轮）

| 指标 | A 无大明 | B 有大明 |
|---|---|---|
| 启动（中位） | 4,729 ms | 6,595 ms（A 首轮 6,742 离群） |
| 首屏（中位） | 1,206 ms | 1,042 ms（**不下结论**，样本小且路径不同） |
| host CPU 增量 / 40s 窗口 | **2.31 s** | **16.85 s**（+14.5 s） |
| host 结束常驻 RSS | ~138 MiB | ~292–316 MiB（**+150~180 MiB**） |
| renderer JS heap | 18.1–18.2 MiB | 17.6–18.2 MiB（无差异） |
| renderer DOM 节点 | 848 | 856–857（+8~9） |
| renderer 进程级 CPU | **未取得**（进程列表不稳定） | **未取得** |

- A 组 RSS 是**下降**的（启动峰值 257 → 40 秒后 138 MiB），不能读成"省内存"；对照应看结束时常驻。
- **缺口**：三次 A、三次 B 都没能打开原生会话（选择器未命中真实 DOM）→ 会话打开后的表现无对照数据；`readSession` 首次/重复读取没单独测；首屏用"body 文本 > 60"近似，未记录各请求耗时。
- 排查方向：拆分 poll 内部耗时（listSessions/readSession/写盘）、轮询频率线性性、常驻内存 +150 MiB 来源、单会话读取与事件数关系。

报告：`out/PERF-BASELINE-RESULT-2026-11-07.md`；脚本 `perf-baseline.ps1` / `perf-run.mjs` / `perf-summary.mjs`。

### 2026-11-07 19:05–19:25 — 轮询 CPU 归因

| 事情 | 结果 |
|---|---|
| 先修错 | 第一次 `pollIntervalMs: 5/30` 被当**毫秒**夹到 5000，两组条件相同、数据作废；改 `5000/30000` 重跑 |
| 调用次数 | 30 s：listSessions 4 次、readSession 30 次；5 s：16 次、150 次 |
| **墙钟 ≈ CPU** | 30 s：readSession 墙钟 6.4–7.0 s ≈ CPU 6.5–6.9 s；5 s：27.4–30.6 s ≈ CPU 28–31.3 s |
| 结论 | CPU 与 poll 次数近似线性（4 倍次数约 4.3 倍 CPU）；**readSession 是主要消耗**（墙钟≈CPU，说明在算而非等待）；listSessions 占 10% 以内 |
| 单次 poll | 5 s 组约 1.8 s CPU/次（均摊，非实测）；其中 ~1.7 s 来自 9.4 次 readSession |
| RSS | 30 s 组 +121~143 MiB、5 s 组 +11/−27/+19 —— **方向与"读得越多涨越多"相反**，不支持线性增长，本轮不结论 |
| 未测 | poll 起止与重叠、首屏就绪、renderer 进程 CPU、原生会话打开 |

报告：`out/PERF-ATTRIB-2026-11-07.md`。

### 2026-11-07 19:25–19:45 — 跳读前提验证

| 事情 | 结果 |
|---|---|
| 公开接口 | `listSessions` 的 header 只有 `version/id/createdAt/cwd/isSeeded/delegationDepth`；`readTitleSnapshot` 同；`live`/`persisted` 只是布尔 → **没有 eventCount/lastSeq/updatedAt/修订号** |
| 文件层 | 构造会话追加事件：mtime 变（亚毫秒精度）、size 531→569→603；恢复后回到原值 |
| 结论 | **公开接口无变化标记，跳读前提不成立**；文件 mtime/size 是候选，但 DSH 是否走缓存未验证，不能据此判断"会话变了" |
| 未测 | 会话恢复、索引滞后、元数据缺失、缓存行为（四项里只做了"追加"） |
| 表述修正 | 「listSessions 占 CPU 不到 10%」→ **墙钟占比**；「1.7 秒 CPU 来自读取」→ **均摊估计且对应墙钟**，不等于解压/解析 CPU |

报告：`out/META-CHANGE-2026-11-07.md`。

### 2026-11-07 19:45 — 性能研究进度归档

按要求把这轮研究记录成一份进度文档，暂停继续扩展，等下一步指示。

已完成三段：A/B 基线（各 3 轮）、5s/30s 轮询归因（交替 6 轮）、跳读前提验证（接口无变化标记 + 文件 mtime 可用但未验证缓存）。

未完成 8 项，其中"DSH 读取是否走缓存"是跳读的关键前提；"降频的状态延迟"是 30 秒配置能否成为默认的依据。

进度：`out/PERF-RESEARCH-PROGRESS-2026-11-07.md`。

### 2026-11-07 19:45–20:05 — 第一阶段验收（受限观察版）

| 项 | 结果 |
|---|---|
| 重启持久化 | ✅ 采集 3 会话 → 停 → 重启同 stateDir：3 个仍在、pollCount 1→2、rulesSource=config |
| 授权收紧 | ✅ `POST /rules` exclude → `overview` 返回空；⚠ `state.sessions` 仍保留该会话**元数据**（无正文） |
| 双窗口规则冲突 | 接口层已验证（200/409、陈旧 409、非法 400）；**浏览器双窗口未验证** |
| 关闭插件影响 | ✅ A 组（不加载）正常启动、首屏 ~1.2 s、空闲 CPU 2.3 s/40 s |
| **延迟 / 不漏事件** | ✅ 已补测：正式接口 `agentLoop.create` + `session.append('session/title', …)`；5 s 间隔延迟 ~4.98 s、30 s 间隔 ~29.8–30.1 s；每次追加 events +1、delta=1、settle 不增长；零模型调用 |

延迟报告：`out/LATENCY-2026-11-07.md`。手工拼帧会被判 `stored log is corrupt`，只能走正式接口；`append` 签名是 `(type, data)` 两参数，`user/message` 需 `surfaceOp`，改用 `session/title` 绕过。

### 2026-11-07 20:10–20:25 — 双窗口规则冲突浏览器验证

| 步骤 | 结果 |
|---|---|
| 两窗口打开同一规则 | ✅ 都进入「采集范围」 |
| A 保存 | ✅ 「当前使用面板保存的规则」，服务端 revision=1、source=override |
| B 旧版本保存 | ✅ 冲突提示「规则已被其他窗口修改（服务端修订号 1）…你的修改仍保留在编辑框里」 |
| B 草稿保留 | ✅ 编辑框仍是 B 的输入，A 的规则未被覆盖 |
| B 刷新后重存 | ✅ 刷新后显示服务端当前值，重存成功 revision=2 |

**测试前置坑**：之前只同步 `index.mjs` 没同步 `client.js`，旧客户端不带 `baseRevision`，两窗口保存都报 400；同步后测试才有效。

局限：输入是占位 id，验证的是冲突与草稿行为，不是规则内容持久化；两个窗口是同一实例两个页面，多进程写入仍未验证。

报告：`out/TWO-WINDOW-2026-11-07.md`。

报告：`out/STAGE1-ACCEPTANCE-2026-11-07.md`。

### 2026-11-07 21:05–21:30 — 真实试用接入 3 个指定会话（失败）

| 项 | 结果 |
|---|---|
| 会话元数据 | 187dc4c0：4,664 事件 / 5.04 MB《工具使用型推理Agent中的测量盲区案例研究》；ddae86da：10,183 / 10.27 MB《胎元饮论文另一条线综述》；bb99ba89：5,579 / 4.75 MB《Agent王朝》 |
| 读取成本下限 | 296–320 / 521–615 / 284–487 ms（解压+解析，3 轮） |
| 接入方式 | 真实 HOME 建独立 profile `leader-live`（**没动 desktop**），生产版 index/client + observeOnly + 3 会话 + 30 s + 独立 stateDir |
| **结果** | **3 个会话全部失败**：`contains event type "job/registered" unknown to this harness`；`allowed:3 synced:0 skippedByReason:{unavailable-cooldown:3}` |
| **根因** | 全局 CLI **0.1.7-rc.1** 读桌面端 **0.2.2-rc.1** 写的会话；`job/registered` 是 0.2.x 事件类型，0.1.7 不认识 |
| 清理 | 实例已停、60250 无监听；`leader-live` profile 留在真实 HOME（新增目录，不影响 desktop） |

待定路径：A 在桌面端加载大明（需改 desktop，之前要求不动）/ B 升级全局 CLI / C 换 0.1.7 能读的会话 / D 等跨版本读取。

报告：`out/LIVE-TRIAL-2026-11-07.md`。

### 2026-11-07 21:30–21:55 — A：desktop 接入（配置就位）；B：全局 CLI 更新（已验证）

**A. desktop 接入**
- 记录：desktopVersion 0.2.2-rc.1、23 个依赖、34 个 bundles、patch 780 行；备份 `package.json.bak-leader-20261107-213149` / `cordis.patch.yml.bak-leader-20261107-213149`
- 改动：插件包复制到 `profiles\desktop\node_modules\dsh-leader`；patch 追加 1 个 entry（observeOnly + 3 会话 + 30 s + 独立 stateDir）；**没改 package.json**
- 静态校验：entry 数 =1、包 5 文件齐全、stateDir 未创建
- **未验证**：需重启桌面端（当前会话就跑在桌面端，未自行重启）

**B. 全局 CLI 更新**
- 更新前：0.1.7-rc.1，`C:\Users\t4365\AppData\Roaming\npm\dsh.ps1`
- 目标：0.2.2-rc.1（按桌面端对齐，未追 latest）
- 结果：`dsh --version` = 0.2.2-rc.1 ✅
- **功能验证**：真实 HOME + leader-live 读 `187dc4c0` → events=4,664、lastSyncMs=1,771 ms、无错误 ✅；名单外 579 被拒
- 冒烟：`--help` 正常；`dsh profile list` **命令不存在**（新语法 `dsh [--profile] <name>`）；`dsh web` 触发 web profile 的 peer 警告（dshmarket / dsh-file-mount / archive-manager / dsh-tavern 不兼容 0.2.2-rc.1，会被跳过）

报告：`out/AB-RESULT-2026-11-07.md`。

### 2026-11-07 21:50–22:00 — desktop 接入验收（重启后）

| 项 | 结果 |
|---|---|
| `observeOnly` / `preStepGuardInstalled` | **true / false** ✅ |
| 三条会话 | 全部 `status: ok`、已同步：bb99ba89 5,579 事件（978 ms）、ddae86da 10,183（1,411 ms）、187dc4c0 4,665（786 ms） |
| 名单外被拒 | ✅ `leader_detail('3c4657c3…')` → 「未被采集：不在允许名单内」；poll 里 577 个名单外会话全部 denied-by-default |
| 每轮采集 | 约 **3.2 秒 / 30 秒 ≈ 10.7% 单核**（由 lastSyncMs 相加） |
| CPU 实测 | 65 秒观测 +26.55 s（40.8% 单核）——**受本会话自身活动干扰，不能归因给插件** |
| RSS | 2126 → 858 MiB，波动远超插件可能影响，判为 Electron 回收 |
| **配置修正** | patch 里原先用顶层 `- id: dsh-leader`，与文件 707 行「必须包在 insert 里」不符，已改成 `- insert:` 形式（下次重启生效；当前实例用旧形式工作正常） |
| 未验证 | desktop 日志的 peer 跳过、CPU 净增量、面板呈现、日常体感 |

报告：`out/DESKTOP-ATTACH-RESULT-2026-11-07.md`。

### 2026-11-07 22:00–22:05 — 口径修正与 B 单独报告

| 项 | 修正 |
|---|---|
| 采集耗时 | 「3.2 秒 = 10.7% 单核」**不成立**——3.2 秒是**读取墙钟**，含等待与其他耗时，不等于 CPU；真实 CPU 净增量未测 |
| RSS 下降 | 2126 → 858 MiB **原因未确认**，不能断定 Electron 回收，也不能推断大明的内存影响 |
| 当前实例配置 | 加载的是**改 patch 之前**的顶层形式；`insert` 形式要等下次重启验证（届时重查 observeOnly、守卫、三会话、名单外拒绝） |
| 回退注意 | 覆盖两个备份 + 删目录**不是免检步骤**：先核对备份归属与目录当前内容，避免覆盖接入后新增配置或删掉他用文件 |
| B 单独报告 | 执行了：0.1.7-rc.1 → 0.2.2-rc.1，路径不变；真实会话验证 `job/registered` 可读（events=4,664、lastSyncMs=1,771 ms）；`dsh profile list` 命令已不存在；web profile 4 个插件 peer 不兼容被跳过 |

B 报告：`out/CLI-UPDATE-2026-11-07.md`。

### 2026-11-07 22:16 — 重启后验收（insert 形式生效）

这一轮重启就是上次说的"下次正常重启"，配置已从顶层形式改为 `insert` 形式并生效。

| 项 | 结果 |
|---|---|
| `observeOnly` / `preStepGuardInstalled` | **true / false** ✅ |
| pollCount | 45（持续运行） |
| 三条会话 | 全部 ok、已同步：bb99ba89 5,579 / ddae86da 10,183 / 187dc4c0 4,665 |
| 名单外被拒 | ✅ `leader_detail('3c4657c3…')` → 「未被采集：不在允许名单内」 |
| `insert` 形式 | **加载成功**，无重复注册 |

另按用户要求记录 CLI 兼容缺口（不处理）：`dsh web` 跳过 dshmarket 1.65.0、dsh-file-mount 0.5.1、archive-manager 1.0.4、dsh-tavern 2.4.1；desktop 版本不同（archive-manager 1.1.22 / tavern 2.7.17 / file-mount 0.9.0，未装 dshmarket），**不能直接套用**。

兼容缺口报告：`out/CLI-COMPAT-GAP-2026-11-07.md`。

### 2026-11-07 22:25–22:40 — 候选会话显示标题

用户反馈：采集范围页「候选会话」只显示 id，希望显示对话名称。

| 尝试 | 结果 |
|---|---|
| 列表接口里逐个取标题（200 条） | 3.9 s，1.5 s 预算只拿到 8 条 |
| 批量接口 `readTitleSnapshots` | 1.9 s 超时，0 条（路径不可靠） |
| 只取前 12 条逐个 | 2.5 s，3/12 有标题 |
| **列表快返回 + `/titles` 异步补前 6 条** | 列表 **672 ms** 出；标题首次 **3.3 s** 补上；**二次 4 ms**（TTL 缓存） |

标题真实样例：项目拖拽排序可行性报告、DSH会话加载速度慢、继承: 继承: Agent王朝、GitHub去AI味插件查证。

关键发现：`readTitleSnapshot` 单条约 600 ms，且**没有内置缓存**（同一批二次调用仍 3.3 s）→ 插件内加了 5 分钟 TTL 缓存。

实现：`/api/dsh-leader/candidates` 只返回 id；新增 `/api/dsh-leader/titles?ids=…`（≤20，逐条读+缓存）；前端列表渲染后异步补标题，拿不到就显示 id。

已部署到 desktop（index.mjs + client.js），**需重启生效**。

### 2026-11-07 22:40–22:50 — 第二阶段第 1 步：先看清要发什么

对三个真实会话跑 dryRun（未调模型），结果否定了"全文摘要"路线：

| 会话 | 事件 | 正文字符 | 单次摘要覆盖 | 全文分段 | B 方案 |
|---|---|---|---|---|---|
| 187dc4c0 | 4,665 | 1,322,618 | **1.6%**（到 seq 76） | 261 段 / 283 请求 | 155 段 / 168 请求 |
| ddae86da | 10,183 | 2,582,399 | **0.9%**（到 seq 91） | 508 段 / 549 请求 | 281 段 / 305 请求 |
| bb99ba89 | 5,579 | 1,288,873 | **2.1%**（到 seq 117） | 255 段 / 277 请求 | 124 段 / 134 请求 |

- 单次摘要只覆盖开头 1–2%，等于没看；
- 全文 1,109 次请求、B 方案 607 次——不可行；
- 建议改**滚动增量摘要**（种子 + 增量 + 合并 + 显式标注覆盖范围），成本低两个数量级。

待用户决定：是否按滚动增量做、种子多长、增量触发条件；真实模型仍未授权。

报告：`out/STAGE2-PLAN-2026-11-07.md`。

### 2026-11-07 22:45–23:00 — 第二阶段：覆盖与队列设计 + 构造验证

按用户要求先交设计，不调模型。

| 产出 | 内容 |
|---|---|
| 设计 | `leader/SUMMARY-COVERAGE-DESIGN.md`：采集水印与摘要覆盖**分开**；覆盖用**区间数组**而非单值；`pending` 队列；三条不变量（互不重叠、不跨采集水印、不合并空洞） |
| 模拟 | `_leader-probe/stage2-coverage-sim.mjs`（构造 5,000 事件，纯逻辑） |
| 场景 1 | 开头已摘要 2–84、尾部新事件 → coverage `2-84`、pending `85-4999` |
| 场景 2 | 预算不足 → 只推进 85–124（40 条 / 6,000 字符），剩余留队列 |
| 场景 3 | 写盘失败 → 不推进 |
| 场景 4 | 重复触发 → 处理下一段 165–204，**不重复 125–164** |
| 场景 5 | 撤权 → 触发被拒绝，记录不丢 |
| 场景 6 | 中间有洞 → coverage 两段、缺口两段显式列出 |
| 不变量 | covered 163 + pending 4835 = 4,998，与 seq 2..4999 一致 ✓ |

口径修正：`41/2,315 ≈ 1.8%` 是有文本事件数比例、`seq 0–83` 约 1.8% 序号范围，**都不是语义覆盖率**；"只处理新内容"只减少送给模型的量，**不减少磁盘读取**。

### 2026-11-07 22:55–23:10 — 第二阶段：种子输入对比（三种方案）

预算 6,000 字符、单条 300 字，三个授权会话 dryRun（未调模型、未输出正文）：

| 会话 | 开头 | 最近 | 开头+最近 | 组合的中间缺口 |
|---|---|---|---|---|
| 187dc4c0 | 40 条/5,896 字/3–82 | 50 条/5,814/4565–4663 | 40 条/5,625 | **34–4613** |
| ddae86da | 47/5,935/3–96 | 41/5,974/10091–10181 | 42/5,523 | **46–10136** |
| bb99ba89 | 56/5,781/4–124 | 54/5,980/5401–5523 | 56/5,914 | **68–5461** |

- 6,000 字符只装 40–56 条，占"有文本事件"的 1–2%；
- 组合方案两端都有，但中间缺口数千 seq；
- 单条截断严重：187dc4c0 开头方案截 13 条丢 65,529 字（单条最大 12,527→300）；
- 最近部分截断损失通常更小。

四条设计澄清（已写入设计文档 6.2）：
1. seq 覆盖 ≠ 正文完整送入 → 分 `full`/`partial`/`none`，partial 记字符区间；
2. 系统注入、无正文、预算跳过**分开记**，不合并成"已摘要"；
3. 模型成功+写盘失败 → 覆盖不推进但对可能重复计费，不能宣称"不会重复调用"；
4. 4b 是"只生成计划未应用"，状态机要区分 planned/sent/applied/failed。

报告：`out/STAGE2-SEED-COMPARE.md`；数据 `out/stage2-seed.json`。

### 2026-11-07 23:00–23:20 — 第二阶段：摘要状态最小设计 + 假模型验证

| 事项 | 结果 |
|---|---|
| 数据核对 | `bb99ba89` 末尾 5524–5578 共 55 个事件**全无正文**（26 对 translator/request+result、permission/preset、approval/policy、session/end-seed）→ 最后送 5523 是准确的，但不能说"已覆盖末尾" |
| 状态机 | `planned / sent / applied / failed / unknown`；只有 `applied` 计入覆盖；`unknown`（已发出、结果未知）**不自动重试**，可能已计费 |
| 送入记录 | `sentRecords` 逐条记 `seq/charFrom/charTo/fullChars/kind/time/contentLen`；`partial` 必须单列"只送前 300 字" |
| 覆盖计算 | 由 `applied` 的 `sentRecords` 合并算出，不凭计划区间推进 |
| 输入身份 | `time + contentLen + type` 不符 → `stale`，标"待重新核对" |
| 撤权 | 拒绝新 run、不返回已保存摘要正文；元数据保留 |
| 假模型验证 | 8 场景全过：planned 0 次调用、unknown/failed 不污染覆盖、partial 累计丢字、重复触发 0 重复、撤权阻断、版本变化识别 |
| 已知不足 | `unknown` 的段没自动回 pending（需"待人工确认"队列）；无内容哈希；覆盖是逐事件级别 |

设计：`leader/SUMMARY-STATE-MINIMAL.md`；报告：`out/STAGE2-STATE-DESIGN.md`。

### 2026-11-07 23:05–23:25 — 第二阶段：unknown 队列补齐 + 质量对照准备

| 事项 | 结果 |
|---|---|
| 中断窗口 | **发送前先落 `intent`**，再发请求；重启时 `intent`/`sent` 一律保守标 `unknown` |
| unknown 队列 | 记录来源、seq/字符区间、intentAt/sentAt、`possiblyBilled`；不计入覆盖、不自动重发 |
| 重发 | 新建 run + `replaces` + `possiblyDoubleBilled`，界面提示；旧记录标 `resolvedBy` 但**不删** |
| 内容指纹 | 长文本（≥100 字）存 sha256 前 16 位；短文本只存 `time+len`（避免穷举还原）；**只存指纹不存正文**，说明"已知原文者可验证"的隐私风险 |
| 假模型验证 | 4 场景全过：发送前中断（0 次调用）、发送后未知、明确重发（新 run）、重发再中断（两个 unknown 并存，缺口可见） |
| 质量对照准备 | 已列清单：建议 `bb99ba89`、方案 C（开头+最近）、1 次请求、$0.05 本地预估上限；**等你确认才发** |

设计：`leader/SUMMARY-STATE-MINIMAL.md`（六~八节）；报告：`out/STAGE2-UNKNOWN-QUEUE.md`；准备：`out/STAGE2-QUALITY-PREP.md`。

### 2026-11-07 23:20–23:35 — C 方案精确核算 + 判定标准三处修正

| 事项 | 结果 |
|---|---|
| 装不装得下 | **能**：系统指令 466 字符 + 正文 5,502 = **5,968 ≤ 6,000**，一条请求装下，未拆 |
| 发送范围 | 开头 26 条（seq 4–62，2,766 字）+ 最近 22 条（seq 5473–5523，2,736 字）；中间 63–5472 未覆盖；末尾 5524–5578 无正文 |
| 单条截断 | 6 条截到 300 字，丢 13,561 字（标 partial） |
| 判定修正 1 | "提到中间区间"**不一律判编造**——逐条看是否由已发送内容支持；无支持记"无证据支持"，与"错误"分开 |
| 判定修正 2 | 短文本指纹只是**弱检查**（同时间同长度改写发现不了）；长文本哈希也不是隐私保证 |
| 判定修正 3 | unknown 分"未解决缺口"与"**原未知请求已由新 run 处理**"两种显示；重发仍可能重复计费 |

发送清单：`out/STAGE2-C-SENDLIST.md`（48 条 / 5,502 字符 / 1 次请求 / $0.05 本地预估上限）。**等你确认后才发送**。

### 2026-11-07 23:20–23:30 — 质量对照发送前核对：停止（凭据缺失）

| 检查项 | 结果 |
|---|---|
| 会话授权 | ✅ bb99ba89 可读、5,579 事件 |
| 发送清单 | ✅ 48 条（seq 4–62 + 5473–5523）、5,502 字符 |
| 请求大小 | ✅ 5,968 ≤ 6,000 |
| 模型 | ✅ deepseek-official / deepseek-flash |
| 价格 | ⚠ 硬编码价目，非实时可核实 |
| **凭据** | ❌ **环境变量 DEEPSEEK_API_KEY 在进程/用户/机器级都不存在** |

按「条件不符就停止」的约定，未发送、未读 `.credentials.yaml`（用户拒绝该操作）、未猜 key。

待选：用户设置环境变量，或明确允许从 `.credentials.yaml` 注入。

核对报告：`out/STAGE2-PRE-SEND-CHECK.md`。

### 2026-11-08 00:05–00:35 — 质量对照单次请求（有 usage、无正文）+ 收集器契约核对

| 事项 | 结果 |
|---|---|
| 授权依据 | 用户明确「同意本次试验…最多请求 1 次」；环境变量缺失时我停止并报告，用户随后给 key 文件路径并说"继续做"——**同一授权的延续，非误触发** |
| 请求结果 | 已发送、无错误；usage input 2,560 / output 1,200 / total 3,760；**收集到的摘要正文 0 字符** |
| 费用 | **$0.002208**（本地价目换算，非服务商账单） |
| 原因 | **未确认**——未保存完整流事件、无明确结束原因；不能证明是 reasoning 占额，也不能排除事件转换/收集路径问题 |
| 代码缺陷 | 收集器只处理 `text-delta` 与 `usage`；源码 `llm/src/types.ts` 还有 `reasoning-delta`、`finish.reason` |
| 构造流验证 | `collector-test.mjs` 6 种情况：正常/全 reasoning/混合/长度截断/错误/流中断 → 分别判 ok、no-text、ok、ok(length)、error、interrupted |
| 下次准则 | 只记 chunkKinds、各类字符数、finishReason、usage；不存原始流与 reasoning 正文；调额度前先给上限与费用 |
| 状态 | 1 次已用完，不重试；实例退出、端口无残留；凭据仅注入进程环境变量 |

报告：`out/STAGE2-QUALITY-RESULT.md`。
### 2026-11-08 00:40 — 禁用大明插件（desktop）

| 项 | 内容 |
|---|---|
| 操作 | 在 `profiles\desktop\cordis.patch.yml` 的 dsh-leader entry 加 `disabled: true`（**保留配置**，不做卸载） |
| 备份 | `cordis.patch.yml.bak-disable-leader-20261108-004042`（36,585 字节） |
| 当前配置 | `pollIntervalMs: 120000`、`maxSessionsPerPoll: 1`（用户已手动调过，未改动） |
| 生效 | **需重启桌面端**；当前运行实例里插件仍加载 |
| 状态目录 | `_leader-probe\out\desktop-live-state` 保留，未删除 |

恢复方式：去掉 `disabled: true` 或覆盖备份，重启。
### 2026-11-08 00:45–00:55 — 插件改名 dsh-daming（A）并尝试纳入依赖清单（B）

**A 改名（完成）**
- 包名 `dsh-leader` → `dsh-daming`：package.json、index.mjs（`export const name` 与 10 处 API 路径）、client.js（id/name 与 15 处 fetch）、client.mjs、包内 cordis.patch.yml、observe-trial.yml
- desktop 目录 `node_modules\dsh-leader` 改名 `dsh-daming`，并同步 5 个文件
- desktop `cordis.patch.yml` entry：`id/name: dsh-daming`，保留 `disabled: true`
- 备份：`_leader-probe\backup-leader-rename-20261108-004639`、`cordis.patch.yml.bak-rename-*`、`package.json.bak-add-daming-*`
- 残留检查：0 处 `dsh-leader`
- **API 路径也整体改为 `/api/dsh-daming/`**（前后端同步）

**B 纳入依赖（尝试，未验证）**
- desktop `package.json` 的 dependencies 加入 `"dsh-daming": "link:B:/DSH/Agent/leader"`
- 未改 bundles（加载仍靠 patch insert）
- **未验证**：desktop profile 被 Electron 独占，无法跑 pnpm install；插件管理页是否识别未实测

**待重启验证**：插件是否正常加载（disabled 状态下应为不加载）、改名后 API 是否可用（重新启用时）、管理页是否出现 dsh-daming
### 2026-11-08 00:53 — 禁用验证：确认已停止

| 证据 | 结果 |
|---|---|
| `leader_status` 工具 | **schema 缺失、调用失败** → 插件未注册到本轮实例 |
| state 文件 | 最后一次 poll **00:39:16**，文件修改 00:39:26；重启在 00:42–00:44，之后 `pollCount` 停在 161 无增长 |
| 桌面端 | 用户确认重启后界面无异常 |

当前：插件未加载；改名 `dsh-daming` 已就位（重新启用时生效）；`dependencies` 里的 `dsh-daming: link:...` 保留未撤（B 待定）。
### 2026-11-08 11:40–12:15 — 第二阶段最小实现（隔离副本，假模型）

在 `_leader-probe/proto2/dsh-daming` 接入摘要状态机，**未接生产、未调真实模型**：

| 结构 | 内容 |
|---|---|
| `state.summaryRuns[id][]` | `intent → sent → applied/failed/unknown` |
| `state.summaryCoverage[id][]` | 逐事件 `{seq, charTo, fullChars, kind}` |
| `state.summaryUnknown[id][]` | 待确认队列（已发出、结果未知） |
| `sentRecords` | 实际送入逐条记录，`partial` = charTo < fullChars |
| `coverageSummaryOf()` | 覆盖/缺口由 applied 记录算，不由计划推导 |
| 启动恢复 | `intent`/`sent` 残留 → `unknown`，不自动重发 |

新增 `leader_summary_coverage` 只读工具；`leader_status` 加 `summaryState` 与顶层 `summary`；`observeOnly` 下真实调用需显式 `allowManualSummary: true`。

验证（假模型、隔离会话 `session-0ca5d932`、`summaryMaxChars: 400`）：

| 场景 | 结果 |
|---|---|
| 部分送入 | ✅ 7 条，1 条 partial（280/318） |
| 覆盖空洞 | ✅ 缺口 `0-4、6-8、10-12、14、19-45` 明确列出 |
| 只由 applied 推进 | ✅ applied 后覆盖才 0→7 |
| 中断 → unknown | ✅ sent 时杀进程，重启 `unknownRecoveredAtStartup=1`，覆盖仍 0 |
| 无自动重发 | ✅ 假模型调用日志无新增 |
| intent 写盘失败 | ✅ 拒绝发送，返回「无法记录发送意图，已取消本次请求」 |

未验证：模型返回后写盘失败、真机撤权时序、面板 UI、真实模型。

踩坑：手写 zstd 会话被拒（`stored log is corrupt`），自造会话文件行不通；`stage2-run.ps1` 的 SID 曾硬编码导致隔离环境 `allowed: 0` 白跑两轮。

报告：`_leader-probe/out/STAGE2-MINIMAL-IMPL-2026-11-08.md`。
### 2026-11-08 12:15–12:25 — 第二阶段：面板覆盖显示

`proto2/dsh-daming/client.js` 的会话表「摘要」列新增（两个分支都加，含无摘要版本时）：

- 覆盖条数（完整 / 部分）
- 部分送入时：`N 条只送了前缀，缺 M 字`（`ldr-warn` 样式）
- 未覆盖 seq 区间（超 120 字符截断，完整值放 `title`）
- 待确认段数：`已发出但结果未知，可能已计费，不自动重发`

数据来源 `leader_status.sessions[].summaryState`（后端由 applied 记录算出）。已同步到隔离环境，语法检查通过，**未做浏览器实测**。

### 2026-11-08 12:50–13:10 — 第二阶段 diff 审查（5 个重点 + 3 处修复）

diff 规模：`index.mjs` +268/−4、`client.js` +24；`client.mjs`/`package.json`/`cordis.patch.yml` 哈希一致未改。

**审查发现并修复 3 处：**

| # | 问题 | 修复 |
|---|---|---|
| 1 | `allowManualSummary` 检查挂在 `cfg.observeOnly === true` 下，**配置漏写 observeOnly 时检查失效**，配置遗漏反而更宽松 | 改为无条件 `if (dryRun === false && cfg.allowManualSummary !== true) 拒绝`；非观察模式以后也需显式开启 |
| 2 | 预算截断的 `original`/`sent` 含 `[seq] type: ` 前缀，与单条截断（正文长度）**口径不一致**，`charTo`/`fullChars` 偏大 20–30 字符 | 换算成正文长度：`prefixLen = one.length - l.text.length` |
| 3 | `leader_summary_coverage` 与 `status.summaryState` **没有实时判权**，撤权后仍返回覆盖元数据 | 两处都加 `rec.revoked` + `decideAccess` 检查 |

**确认正确的：** intent 先落盘再发请求（失败即不发）、版本写盘失败回滚且覆盖不推进、只有 applied 才 mergeCoverage、三类未送入分开记、新字段对旧 state 兼容、无遗留端点/故障注入/测试凭据。

**未回滚的取舍（已加注释）：** `finishRun` / `markRunSent` 内部 `persistState()` 不检查返回值——内存与磁盘可能短暂不一致，但崩溃时重启会把 sent/intent 转 unknown、覆盖不推进（保守正确），不会误标 applied。

**审查后仍存风险：** `summaryRuns` 无上限累积；`coverageSummaryOf` 是 O(lastSeq)；`unknown` 队列只能看不能人工关闭；判权用的是 `state.sessions[id].cwd` 缓存值（可能滞后一轮）。

报告：`_leader-probe/out/STAGE2-DIFF-REVIEW-2026-11-08.md`；diff：`out/stage2-index.diff`、`out/stage2-client.diff`。
### 2026-11-08 12:58–13:25 — 修两个可信性缺口（实时判权 + 写盘失败回滚）

**缺口 1：缓存 cwd 不能当实时判权**

新增 `liveCwdOf(id)`（读 `readTitleSnapshot` 取当前 cwd，失败返回 null）与 `liveCwdForSummarized()`（只对有摘要记录的会话批量取）。
`leader_summary_coverage` 与 `status.summaryState` 改用实时 cwd；`status()` 签名改为 `status(liveCwdMap)`，未传 map 时返回 `denied: 'not-checked'`，取不到元数据返回 `metadata-unavailable`。

| 验证 | 结果 |
|---|---|
| 缓存路径允许、实时路径被排除 | ✅ `summaryState: {denied:'out-of-scope'}`、coverage 工具 `excluded-by-cwd`（若用缓存判权会返回 coveredCount=6） |
| 实时元数据不可用 | ✅ 移走会话目录后 `denied:'metadata-unavailable'` |

副作用（有意）：列表过滤仍用缓存 cwd（既有行为），会出现「会话在列表里但 summaryState 是 denied」。

**缺口 2：写盘失败不能假定不会误标 applied**

`markRunSent` / `finishRun` 改为返回 `{ok,error}`；`finishRun` 写盘失败时**回滚内存**（run 状态/appliedAt/usage/error + summaryCoverage）。调用方新增 `coveragePersisted` / `coveragePersistFailed` / `runStatePersistFailed` / `possiblyBilled` / `warn`。

验证（假模型延迟 5s，探针在 run 变 sent 时设 state.json 只读）：
- `real`：`persistedSummary:false`、`possiblyBilled:true`、`failureReason:'persist-failed'`
- **同进程内立刻查询**：run 状态是 `sent`（非 applied），覆盖仍 7 条未变 → 回滚生效
- 恢复可写再触发：新 run applied，旧 sent 保留

**未解决边界**：`sent` 状态无法区分「还在等结果」和「拿到结果但没存」；版本已存但覆盖为 0 时数值不矛盾但易困惑。

**三项补充验证进度**：模型返回后写失败 ✅ 完成；撤权交错 ⚠ 只验了撤权后拒绝，「模型返回瞬间撤权」未做时序测试；浏览器渲染 ❌ 未做。

报告：`_leader-probe/out/STAGE2-AUTHZ-WRITEFAIL-2026-11-08.md`。
### 2026-11-08 13:30–14:35 — 性能回退修复 + sent 歧义 + 撤权交错受阻

**性能回退（已修并验证）**

`liveCwdForSummarized` 原来对每个有摘要记录的会话调 `readTitleSnapshot`（该路径重读整份日志，600ms 量级）。改为复用 `liveCwdMap()`：**一次 `listSessions()`** 建 id→cwd 映射，索引缺失/读取失败一律 fail closed。`leader_summary_coverage` 也改为一次索引供所有行共用；删掉已无引用的 `liveCwdOf`。

探针包装 `sessionQuery` 计数验证：

| 场景 | 耗时 | listSessions | readSession | readTitleSnapshot |
|---|---|---|---|---|
| 实时路径被排除 · coverage | 145 ms | 1 | **0** | **0** |
| 实时路径被排除 · status | 90 ms | 1 | **0** | **0** |
| 索引缺失 · coverage | 127 ms | 1 | **0** | **0** |
| 索引缺失 · status | 75 ms | 1 | **0** | **0** |

判权仍不信任缓存：缓存 cwd 允许、实时 cwd 被排除时，覆盖详情依旧返回 `out-of-scope`。

**sent 歧义（已实现、未复测）**

新增进程内 `unsavedRuns: Map`（**不写 state.json**）：`finishRun` 因 applied 写盘失败而回滚时写入，查询输出附加 `unsaved: true` + `unsavedNote: '模型已返回，结果未保存，可能已计费'`。重启后 Map 清空，run 按 `unknown` 处理。

**撤权交错（未完成）**

`/api/dsh-daming/rules` 返回 401；cookie 需启动时 `?token=` 换取，而 token 只在实例 stdout 一行且**块缓冲到进程结束才落盘**。已试失败：直连 /api、读日志、`DSH_WEB_URL`（桌面端地址无 token）、`webApp.getAdvertisedUrl()`（无 token）、外部写 cookie 文件+探针轮询、`dsh web --help` 找开关（无）。

因此 `toUnknown(..., 'revoked-after-call')` 路径**存在但未做时序验证**。

**浏览器渲染（未做）**：同一 token 障碍，无 token 访问 `/` 返回 401。

报告：`_leader-probe/out/STAGE2-PERF-AUTHZ-2026-11-08.md`。
### 2026-11-08 14:05–15:35 — unsaved 补测 / ConPTY 尝试 / 撤权交错

**unsaved 补测（通过，并修掉一个真缺陷）**

`writefail2` 场景（假模型延迟 6s，探针在 run 变 sent 时设 state.json 只读）：

| 步骤 | 结果 |
|---|---|
| setReadonlyAtSent | true |
| real | persistedSummary=false、possiblyBilled=true、failureReason=persist-failed |
| 同进程立刻查 | covered 仍 7（未推进）；run `state=sent` + **`unsaved:true`** + 「模型已返回，结果未保存，可能已计费」 |
| 恢复后再触发 | 新 run applied，旧 sent 保留 |

**修的缺陷**：版本写盘失败走 `applied:false` 分支，原先不设 unsaved → 改为 `outcome.applied` 或 `outcome.modelReturned` 任一成立即标记；版本写失败调用点传 `modelReturned: true`。

**ConPTY（装了但用不了）**

`node-pty` 装入 `_leader-probe/pty-env` 成功；pty 跑 `cmd /c echo`、`dsh --version` 均正常；但跑完整 `dsh --profile leader-web ...` 进程 exit 1、**输出只有 49 字节**（dsh 一行未打印）；node-pty 自身报 `getConsoleProcessList` 错误。结论：本机 ConPTY 不可用。

**撤权交错（用内部钩子完成）**

按第 5 条实现 `dsh_daming_test_save_rules`：`stateDir` 必须含 `_leader-probe\test-home`、必须 `STAGE2_ALLOW_TEST_HOOK=1`、`reason` 必填并写入 `state.testHookCalls`。

验证（模型挂起 16s，sent 后改规则 excludeSessions）：run 最终 **`unknown` / `revoked-after-call`**、覆盖未推进（仍 7）、unknown 队列含 possiblyBilled、撤权后覆盖详情 `denied:'revoked'`、再次触发被拒、重启后 `unknownTotal:1` 仍在。

**浏览器验收未做成**：token 只在实例 stdout 且非 TTY 下块缓冲到进程结束；再试 pwsh 管道实时处理也无输出。六种状态的数据结构已验证，但没有真实 DOM 渲染。

**待办**：删除测试钩子（验收后）；summaryRuns 无上限；coverageSummaryOf 为 O(lastSeq)；unknown 无人工关闭入口（界面须明确显示仍待确认）；浏览器验收需解决 token 获取。

报告：`_leader-probe/out/STAGE2-UNSAVED-REVOKE-2026-11-08.md`。
### 2026-11-08 14:40–15:55 — 删除测试钩子 / 隔离登录 / 浏览器验收 / 三项收尾

**测试钩子已删**：整块 −41 行；`test_save_rules`/`STAGE2_`/`testHook` 残留 0，`console.log`/`debugger` 0；备份 `backup-before-hook-removal-20261108-143628.mjs.bak`。

**隔离登录**：查源码确认官方**无静态 token / 凭据环境变量**（`browser-auth.ts` 的 secret 存在 credentials 服务，启动 token 每次随机且只在 stdout）。cmd 重定向、pwsh 管道、ConPTY 都拿不到；**改用 `child_process.spawn` + pipe 成功**——Node 父进程读 pipe 不块缓冲，token 立即可读。token 只在启动器内存，换 cookie 后立刻清空；诊断尾部把 `token=xxx` 替换为 `token=***`；cookie 写 0600 临时文件，验收后删除。

**浏览器验收（无头 Edge + CDP）发现两个真缺陷并修复**：
1. 「对话」tab 数据源是 `buildSessions()`，原先没加 `summaryState`（只加在 `leader_status`）→ 面板看不到覆盖；
2. 后端 runs 有 `unsaved`，`client.js` 没渲染 → 补「模型已返回但结果未保存（可能已计费）：N 次」。

最终面板同时显示：覆盖 7 条（完整 6/部分 1）、部分送入缺 38 字、未覆盖 seq 区间、待确认 3 段（不自动重发）、未保存 1 次。撤权状态下覆盖详情完全不出现。窄屏 720×1000 与 `prefers-reduced-motion` 均正常。

**三项收尾**：
- `summaryRuns` 上限：每会话保留最近 50 条，超出丢弃数记 `summaryRunsTrimmed`（覆盖是独立记录，不受影响）；
- `coverageSummaryOf` 不再每次 O(lastSeq)：加 `summaryStateVersion` 版本号 + Map 缓存（key 含 id/version/lastSeq/unsaved 数），5 个状态变更点各 bump 一次，超 64 条清空；
- unknown 界面口径：明确写「不自动重发」；**人工确认入口仍未做**（已知缺口）。

最终 diff：`index.mjs` +472/−10、`client.js` +30；其余文件未改。生产插件仍 `disabled: true`。

报告：`_leader-probe/out/STAGE2-UI-ACCEPTANCE-2026-11-08.md`。
### 2026-11-08 16:00–16:15 — 最终 diff 逐段审查（只报告，未改代码）

审查 `index.mjs` +472/−10、`client.js` +30。按严重性排序，共 6 项：

| # | 严重性 | 问题 | 位置 |
|---|---|---|---|
| P1 | **高** | `trimRuns` 用 `slice(-50)` 不区分状态，可能裁掉 `intent`/`sent` 的 run → 重启时 `recoverUnknownRuns` 看不到它们，**缺口静默消失** | index.mjs:2403-2410 |
| P2 | 中 | `unsavedRuns` 只在 applied 成功时 delete，`failed`/`unknown` 的标记只增不减；`trimRuns` 也不清理被裁 run 的孤儿标记 | 2497/2501/2403 |
| P3 | 中 | `finishRun` 非 applied 且写盘失败时提前 return，漏掉 `bumpSummaryVersion()` → 覆盖视图可能仍显示 `sent`（内存已是 `failed`）；applied 路径因 `mergeCoverage` 内部已 bump 而安全 | 2484-2500 |
| P4 | 中低 | `client.js` 的 `covLine` 对 `{denied:...}` 无分支，会渲染「覆盖 undefined 条」；当前不可达（visibleRows 已过滤），属防御缺口 | client.js:131 |
| P5 | 低 | `trimRuns` 只记丢弃数量不记 runId；`summaryUnknown[].runId` 可能指向已裁剪的 run（unknown 自带 records，数据不丢但两处对不上） | 2408-2409 |
| P6 | 低 | 撤权后顶层 `summary.unknownTotal` 仍计入被撤权会话（仅数字，无 id/seq） | summary 汇总 |

**确认无问题**：applied 失败回滚完整（含「原来没这个 key」的情况）；回滚不回退版本号（只会多失效，方向安全）；缓存不含判权结果、判权全在缓存之外；7 个读取入口都走实时判权（status/coverage/buildSessions/summaries/detail/correct/summarize）；默认关闭真实摘要；旧 state 兼容；损坏 state 拒写；测试钩子/token/cookie/调试日志残留均 0。

**阻断判断**：P1 方向与「不遮住缺口」原则相反，建议转正前修；P2/P3 顺带修；P4 加一行防御；P5/P6 可接受并写进已知限制。

报告：`_leader-probe/out/STAGE2-FINAL-DIFF-REVIEW.md`。
### 2026-11-08 16:00–16:25 — 补两项证据缺口

**观察入口只加在 test-home 测试副本**（`dsh_daming_test_unsaved_size`），三重闸：`STAGE2_ALLOW_TEST_HOOK=1` + `stateDir` 含 `_leader-probe\test-home` + 只读。`proto2` 候选未加。

**缺口 1：非 applied + 写盘失败（已命中）**

给假模型加 `empty-delay` 模式（延迟后返回空正文），探针见 run 变 sent 立刻设只读：

| 步骤 | 结果 |
|---|---|
| setReadonlyAtSent | true |
| real | `empty-summary`、runStatePersistFailed=EPERM、possiblyBilled=true、hasSummary=false |
| 同进程查询 | `lastRunState='sent'`（回滚后的真实状态）、unsaved=null、covered 仍 7 |
| unsavedAfter | size=0、orphan=0 |

未误标 applied；`unsaved` 未设置是正确的（空正文不属于「有结果没保存」）。注：P3 那格难以构造出「缓存与内存不一致」的可见差异，因 `beginSummaryRun`/`markRunSent` 在进入 `finishRun` 前已各 bump 一次。

**缺口 2：unsavedRuns 运行时观察（已命中）**

| 检查 | 结果 |
|---|---|
| 失败后增长 | size 0 → **1**，orphan=0 |
| 再次成功后 | 仍 size=1（旧 run 仍是 sent，标记应保留） |
| 重启后 | **size=0**（模块级 Map，进程重启即空） |

**client.mjs 判断（未执行删除，等用户定）**

56 行，文件头自述「最小加载验证版」，5 处 console 调用；`exports["./client"]` 指向 `client.js`；proto2 全文件 grep 无任何引用。DSH 源码 `packages/client/modules/src/index.ts` 的 `clientExportOf()` 只读 `exports["./client"]`。判断为早期探针，建议删除；删除命令被用户拒绝，暂停。

报告：`_leader-probe/out/STAGE2-EVIDENCE-GAPS-2026-11-08.md`。

### 2026-11-08 16:30–16:40 — 候选定稿：删 client.mjs + 最终 diff 与哈希

**删除 `client.mjs`**（用户决定）：早期「最小加载验证版」探针，56 行、无真实 UI；`package.json` 只导出 `client.js`；DSH `clientExportOf()` 只读 `exports["./client"]`；proto2 全文件 grep 零命中。

| 步骤 | 结果 |
|---|---|
| 候选目录删除 | ✅ 现有 4 个文件 |
| 导出核对 | `exports["."]=./index.mjs`、`exports["./client"]=./client.js`、`platform=web` |
| 加载文件扫描 | index.mjs：钩子 0 / 调试 0；client.js：钩子 0 / 调试 0 |
| 语法 | 两者 `node --check` 均 0 |

**候选哈希**：`index.mjs A831196B…`、`client.js FCA2CA3B…`、`package.json 0052A280…`、`cordis.patch.yml 95F38241…`（后两者与生产**相同**）。

**最终 diff**：

| 文件 | 规模 | SHA-256 |
|---|---|---|
| `FINAL-index.diff` | +578/−10（708 行） | `012B96BB…` |
| `FINAL-client.diff` | +46/−0（67 行） | `9E1AC622…` |
| `FINAL-client-mjs-deletion.diff` | 整文件删除 56 行 | `9A9898BE…` |

删除 diff 用规范 `--- a/… / +++ /dev/null / @@ -1,56 +0,0 @@` 格式（`git diff --no-index` 对不存在文件返回空，改由脚本生成）。

**生产基线核对（未变）**：`index.mjs A8261DA1…`、`client.js 68C520F7…`、`client.mjs 68A4F4B2…`、`package.json 0052A280…`、`cordis.patch.yml 95F38241…`。部署目录仍旧版，插件 `disabled: true`。

**P3 口径修正**：不写「修复完成」，改为「**当前行为正确，修复前差异未复现**」——`bumpSummaryVersion()` 已移到 `finishRun` 开头，但构造不出「修复前返回旧状态」的可见对照（`beginSummaryRun`/`markRunSent` 在进入前已各 bump 一次）。已验证的是回滚后同进程查询返回 `sent`、与内存一致。

报告：`_leader-probe/out/STAGE2-CANDIDATE-FINAL-2026-11-08.md`。

> 时间均为北京时间（Asia/Hong_Kong），取自各次运行日志的落盘时间。

### 2026-11-09 — 项目统一更名为“王朝”

- 产品中文名由“大明”统一为“王朝”。
- 包名、bundle id、客户端 id、API 路由和工具名前缀由 `daming` / `leader` 统一为 `wangchao`。
- 新安装默认 `stateDir` 改为 `<DSH_HOME>/wangchao`；已有显式配置不受影响。
- 当前源码、P0 候选、性能候选、发布目录、隔离测试 profile 和 desktop 禁用配置已同步迁移。
- 历史日记、旧审计、旧备份和第三方浏览器测试数据保留原貌，作为迁移证据。
- 备份目录：`B:\DSH\Agent\_leader-probe\backup-wangchao-rename-20261109-200952`。

## 2026-11-10 至 2026-11-11 — R2 至 R4 隔离改进（2026-11-12 补记）

- **R2**：修复首辅工具守卫验证与默认句柄释放路径，并为重启后未安装守卫的首辅补充发送阻断；优化轮询和并发索引扫描。5 秒放大实验、少量样本下性能有改善，不把结果外推为日常负载。部分界面与热卸载项当时未验证。[R2 汇总](../_leader-probe/r2/R2-SUMMARY-2026-11-10.md)。
- **R3**：修复换代旧首辅被当普通会话放行的问题，加入退休/换代原因提示和工作区归组；移除没有释放句柄能力的旧回退路径。隔离场景实测了旧首辅阻断和普通会话对照，热卸载仍未验证。[R3 汇总](../_leader-probe/r3/R3-SUMMARY-2026-11-11.md)。
- **R4**：处理 `release → summon` 的句柄归属与探针泄漏，区分插件持有和宿主持有；后者不能冒称已释放。R4 记录了一次宿主页面恢复句柄的隔离链路；R5 后续未重新构造出该自然 UI 路径，因此最新阶段仍将其列为需要复核。[R4 汇总](../_leader-probe/r4/R4-SUMMARY-2026-11-11.md)。

## 2026-11-11 — R5 基线收口（2026-11-12 补记）

本节根据 R5 阶段报告补记，不重构未记录的过程时间。R5 在隔离环境复核首辅权限、句柄与试用路径；日常 desktop 保持禁用，未部署、未重启。

- 最终 R5 候选：`B:\DSH\Agent\_leader-probe\r5\candidate-r5\dsh-wangchao`；`index.mjs` SHA-256 `3B174869D285CDACD30E3885B0BA316911ABDB63BE6F997CCF9930EAAF6DFBA2`，`client.js` `A6F81706A28CEAE1F3C166CE453595ECB4C0CF40803254E05E01AE155729FD5A`。
- 复用宿主 Agent 时加入 live 身份校验、接管期间失败关闭与 running 时拒绝；面板增加模型来源，startupReport 不再落入未授权会话 ID。首辅工具拒绝与普通会话对照、规则收紧、关闭/释放后重召见在隔离测试中有证据。
- 宿主持有句柄的自然 UI 路径、真实 running 窗口、热卸载和跨进程 lease 未完整验证。R5 采用注入式宿主复用证据；`/titles` 可按任意 ID 返回标题，不能称为完整隐私隔离。
- 性能样本是 12 个隔离会话、0 个允许会话的空载观察，不代表真实规模。[R5 汇总](../_leader-probe/r5/R5-SUMMARY-2026-11-11.md)；[试用清单](../_leader-probe/r5/TRIAL-CHECKLIST.md)。清单首页的 index 哈希与实际候选、汇总不一致，以本节及汇总中经实测的完整哈希为准。

## 2026-11-11 至 2026-11-12 — R6 单任务隔离闭环（补记）

先建立 Team 任务与独立工作副本，再由主代理单一写入者整合。首辅读取已授权会话的既有摘要及缺口，提出待确认计划；御书房展示计划，浏览器自动化点击确认后调用宿主 `subagents.startActivation`，任务状态与结果持久化并展示。无摘要时明确显示信息不足；假模型固定输出不作为真实项目结论。

- R6 整合候选：`B:\DSH\Agent\_leader-probe\r6-20261111-magpie\integration\dsh-wangchao`；`index.mjs` `E545D7988CCF0B6FF7CFBA045C415AC7BF16EA0BCF1F59617842E0B22473C3D4`，`client.js` `A75584E01D749F300DA43A9F97F1F2BD21BA9C222975A24012DF4058D38C0CC3`。
- 御书房点击确认至结果可见：隔离实例 `flow8` 成功，点击前后截图与记录在其 `out` 目录。`regress7` 的 23 项检查通过；单独验证执行失败、运行中断后重启变 unknown 且不自动重发。
- `/titles` 收紧为只返回已采集且当前获授权会话标题；候选发现和撤权历史仍有既有保留语义，未宣称完整隐私隔离。R6 也修正了规则收紧后 `conversationEnabled` 仍可能显示 true 的问题。
- 实际执行复用宿主 subagent 服务；独立 Team 执行桥只做了模拟，真实 TeamService 接入未验证。执行 Agent 不自动继承首辅守卫；R6 因此只开放显式配置的隔离假模型执行。[R6 阶段报告](../_leader-probe/r6-20261111-magpie/STAGE-REPORT.md)；[相对 R5 的 diff](../_leader-probe/r6-20261111-magpie/FINAL-DIFF-R5.patch)。

## 2026-11-12 — R7 权限、状态与验收（补记）

围绕 R6 的缺口，用独立 Team 工作线处理执行权限、状态恢复、授权竞态和界面，再集中整合验收。中途审查发现身份失败开放、Windows 设备路径、任务目录逃逸及授权复核卡死等问题；完成修复后对最终候选重新验证。

- R7 整合候选：`B:\DSH\Agent\_leader-probe\r7-team\integration\dsh-wangchao`；`index.mjs` `90AF8DDBE4B2982893982117A1BECC829B448A30C1AD6A5C85508543048DA0DA`，`client.js` `670EB031855112FE4AB75B9EDAB1D7E222F0A7C075DFC4AB27B910DD1C58C115`。
- 最终候选执行权限隔离实测 33 项通过：任务目录内 read 成功，禁止工具与目录外 write 被拒，受控写工具体计数为零。派发前验证 guard；可见工具清单未收敛，工具 guard 不是系统安全沙箱。
- 状态文件 v1 原子迁移到 v2；超时标明结果未知且不自动重发，迟到结果不覆盖终态。真实 90 秒假任务超时及运行中断后重启为 unknown 均有隔离实测。执行期间撤权，成功结果在落盘前复核失败时不保存。
- 综合回归 27 项通过；宿主持有句柄仍为探针 `agents.resume` 模拟，真实 UI 持有及真实 busy 窗口尚未完成。御书房 `finalui1` 通过自动点击确认和结果展示；结果仍是固定假模型文本。
- 串行性能采样：3 个允许的合成会话、300 条合成任务、10 秒轮询；45.01 秒窗口 DSH 进程 CPU 增量 1.203 秒，约单核 2.67%，4 次 `/work` 请求约 69–132 ms。单次小样本，不外推真实负载。
- **日常试用阻断**：活动执行期间插件热卸载会移除 guard，子 Agent 可能仍在运行；无跨进程 lease，同一 stateDir 仍只能单实例写入。元数据复核到真正启动间、执行中撤权无法确保停止等窗口仍须如实限定。`allowSessions` 与 `allowCwds` 为并集，排除优先。[R7 阶段报告](../_leader-probe/r7-team/R7-STAGE-REPORT.md)；[相对 R6 的 diff](../_leader-probe/r7-team/FINAL-DIFF-R6.patch)。

本次补记仅更新开发日记；没有部署候选、修改 desktop profile、重启日常环境或调用真实摘要模型。

## 2026-11-12 至 2026-11-13 — R8–R12 连续阶段（实时记录）

按用户要求把 R8–R12 作为一个连续开发阶段，基于 R7 候选并行推进，由主代理统一整合。共同约定见 `r8-r12-continuous/CONTRACT.md`：确认后执行、来源实时判权、未知不重发、预算与审计贯穿、交接只把状态记录当事实。

- 安全线先交了一版「卸载时保留旧 guard」，独立审查指出旧 guard 在 HMR reload 后并不保留（safe5 实测），且模型可自行确认清除门禁、记录损坏会放行。安全线如实回退结论并改方案：去掉模型/配置绕过、记录损坏 sticky 阻断、未确认执行子会话一律拒绝调用（safe6 21/21）；仍留「卸载到新 guard 安装的窗口未测」这一阻断，因此执行入口默认关闭（`cfg.execLifecycleVerified` 缺省 false）。
- 多任务线实现 task-store v3（依赖、取消请求与停止确认、cancelled、依赖失败级联、并发门禁）和薄补位调度器；结果未知/超时/取消永不重发，重启 running→unknown、confirmed→failed。
- 交接线实现可追溯交接：事实仅来自任务状态/人工纠正/覆盖计数，模型摘要标 `notFact`；构建与读取按当前授权复核，规则/首辅状态变化 fail closed；新首辅可读、旧首辅阻断。
- 预算与界面由主代理补齐：`governance` 做用户确认 + 权限 + 本地估算门禁 + 审计，未知成本暂停；界面串接计划/确认/任务/来源缺口/交接/预算/取消与依赖显示。
- 整合后 13 个测试全过；隔离实例 `intflow1` 单任务闭环成功（提案→点击确认→执行→结果→预算 reserve/settle→生命周期 confirmed），`intrestart1` 运行中断后重启为 unknown 且不自动重发模型调用。
- **未实现/未验证**：执行卸载窗口未测、跨进程 lease 未做、实例级多任务/取消未驱动（假模型每进程只提案一个任务）、交接浏览器实例构建未单独驱动（用真实 apply + 假宿主覆盖）、自然宿主 UI 持有/busy 窗口/真实重启迟到子会话未实证。工具 guard 不是系统沙箱。[R8–R12 阶段报告](../_leader-probe/r8-r12-continuous/R8-R12-STAGE-REPORT.md)；[相对 R7 的 diff](../_leader-probe/r8-r12-continuous/FINAL-DIFF-R7.patch)；[真实模型试验草案](../_leader-probe/r8-r12-continuous/REAL-MODEL-TRIAL-DRAFT.md)。

### 补记：执行卸载窗口的宿主边界（推进止点）

查证宿主 `@deepseek-ai/dsh-hmr/lib/index.js`（L1098–1151）：插件热重载的顺序是 `registry.delete(plugin)` → `await fiber.await()`（跑插件清理）→ `reload(替换)`，全程只有 `hmr/change` 和 `hmr/reload`（重载完成后）两个事件，**没有卸载前拦截/等待钩子**。因此插件无法否决自身卸载，也无法在卸载前等待子 Agent 停止——活动执行期间热重载的守卫连续性在插件层不可保证。这是王朝执行路径目前不能用于日常试用的最终边界，需宿主提供卸载前等待/子 Agent 冻结能力，或约定“执行期间不热重载”。

性能采样（最终候选，3 会话/300 任务）：45 秒窗口单核 2.60%、4 次 `/work` 64–130ms，与 R7 同量级，未见新字段回归。以上仍全程隔离假模型，未动 desktop/真实数据。

### 更正：上面的「推进止点」判断错了一半（2026-11-13 复核）

上一条把「插件层不可保证」写成了结论，复核后推翻：宿主边界确实存在（无卸载前拦截钩子、不能否决卸载、`hmr/change` 只对非 loader-entry 文件发），但**守卫连续性不必依赖宿主钩子**。

- `cordis/lib/index.js` L369–384：`fiber.dispose` 返回 async 清理函数，L693–706 `_unload()` 会 `await Promise.all(_disposables)`，L727–731 `fiber.await()` 会等它。所以 `dsh-hmr` L1118 那个 `await` **真的在等插件清理完成**，插件可以在清理里 await 排空子 Agent。「没法在卸载前等子 Agent 停住」是错的。
- 真正的错在守卫注册路径。`dsh-tools` L650 `this.guards.effect(this.ctx, …)` 里的 `this` 不是服务实例——`ctx.tools` 与 `ctx.get('tools')` 都返回**绑定调用者 ctx 的视图**，effect 归属调用插件。三个纯 cordis 探针实测：插件 dispose 后 `guards=0`、守卫失效，**即使插件保留 disposer 不调用也一样**；`ctx.root.get('tools').guard(fn)` 注册的守卫在 dispose 后仍返回 DENY，新实例可再叠一层，交接期无真空。
- 因此 `execLifecycleVerified=false` 现在是**实现未改**，不是宿主能力缺口。待做：守卫改 root 侧注册 + `globalThis[Symbol.for('dsh-wangchao.execGuard')]` 跨实例交接（先装新、再撤旧）+ 真卸载的显式清除入口，然后重跑 safe5 的「reload 后旧白名单 write 仍被拒」，该判定应当通过。真实 DSH 隔离实例尚未复验，目前证据只到 cordis 层。

探针与原始输出：`_leader-probe/r8-r12-continuous/safety/harness/guard-owner-probe{,2,3}.mjs`、`out-guard-owner{,2,3}.txt`。

### 落地：守卫改 root scope + 跨实例交接（safe7 通过）

候选 `integration/dsh-wangchao/index.mjs` 已改：`ctx.root.get('tools').guard(...)` 注册（root 不可用时回退并标 `guardScope:'plugin'`）；交接键 `globalThis[Symbol.for('dsh-wangchao.execGuard')]`，新实例**先装新守卫、再撤旧的**；卸载时一律不撤守卫；`execPolicySummary` 增 `guardScope`/`guardHandoff`。11 个 `.test.mjs` 与 `work-panel.test.cjs` 全过。

隔离实例 `safe7`（新候选 + 假模型 + `SAFETY_CHILD_HANG=1`）：`reload-guard-probe` 21/21，`removeGuard:false/active-executions`，新实例 `restart.blocked:true`；运行期 `guardScope:"root"`；改 patch 触发真实 reload 的高频窗口探测 80 次采样**全被拒、0 真空、0 错误**。

诚实的局限：reload 前后拒绝理由文本相同，80 次只证明「任何时刻都有守卫在拦」，没区分是旧守卫还是新守卫；「旧守卫在窗口期存活」目前只有 cordis 层探针支持。另：真卸载（插件移除且无人接管）时 root 守卫会残留并按旧策略 fail closed，靠进程重启清理，这个口径要定。

顺带修了测试设施的沙箱受限点：`instance.ps1` 里 `Get-NetTCPConnection` / `Get-CimInstance` 在 workspace-write 下不可用（后者会把整个启动脚本挂死，看着像启动失败其实实例已起来），改成 `TcpClient` 与 `Get-Process`；新增 `-Candidate` 参数与 `execLifecycleVerified`/`budgetLimitUsd`（integration 版新增了这两道门禁，旧 safety 版没有）。

### 折中方案实施：preset 后备 + 执行根包含校验（safe12/safe13 验证）

按验收要求把「执行根在父会话 cwd 之下、guard 限任务目录、preset 限父 cwd」落进隔离候选。

- `exec-policy.mjs` 新增 `checkExecutionRootWithin`（两侧 realpath 后按归一化边界比较，覆盖盘符/大小写/分隔符/目录边界/junction，任一不可确认即拒绝）与 `describeLegacyExecRoot`（旧布局只给迁移建议，不移动不删除）。
- `index.mjs` 新增配置 `execFallbackPreset`（默认 `exec-isolated`，空串显式不启用）；启动期预检、派发前强制核对、启动子会话后 `permissionPresets.set` 并读回确认；任一步失败都拒绝派发，不静默降级。状态输出写明「后备边界是整个父会话 cwd，不是单个任务目录；守卫失效期间任务间不隔离」。
- 实测：safe12（`execWorkspaceRoot=work\.exec`）任务目录内写入成功、任务目录外/父 cwd 外/pwsh/穿越/junction 外指/升级越权全部被 guard 拒；普通 session 设 `exec-isolated` 写界外被沙箱拒（preset 单独生效）。safe13（旧布局平级）派发被拒，错误含「不在父会话 cwd 之内」+ 迁移建议，旧目录原样保留。
- 回归：13 个 `.test.mjs` + `work-panel` 全过；新增 `exec-fallback.test.mjs` 22 条断言。

坑：`agents.get(childId)` 能拿到 spawn 出来的子会话，`sessionController.resolveAgent` 解析不到它——第一版后备代码用后者，派发直接失败「执行子会话不可解析」。

### 更正：80 次采样不能证明跨越真实重载

独立只读复核发现上述窗口脚本只向配置追加注释；采样期间没有第二次卸载的日志或生命周期记录，且 loader 对深度相等的配置可能跳过更新。因此原文“改 patch 触发真实 reload”“窗口内任何时刻都有守卫在拦”没有得到该 80 次采样支持，应撤回。21 项检查证实一次配置变更后新实例与门禁状态，不能证明窗口中旧守卫的作用。Cordis 层 root 注册探针仍支持守卫归属；真实移除、重载窗口和守卫来源须另行实测。

### 继续隔离复核：根守卫降级、生命周期和预算

- 根服务不可用时保留上一根守卫，不覆盖其交接登记；执行桥及确认入口均拒绝派发。根守卫交接登记写入不可确认时同样拒绝派发并保留旧守卫。`guard-regression` 独立模拟探针 46/46；该探针不替代真实宿主重载验证。
- 生命周期活动登记写盘失败不调用子 Agent；曾存在的记录文件消失、格式损坏或缺少必要数组时按损坏阻断。本实例自己的活动子会话不再误作重启遗留，真实未确认遗留仍阻断；由真实生命周期文件配合模拟执行桥验证。
- 预算执行抛异常标记结果和费用未知并暂停，结算或审计写入失败也暂停后续派发；未把本地预算当服务商硬上限。上述改动未接触 desktop 或真实数据。
- 独立 `reload-verify` 用实际配置变更和移除 entry 证明实例更替：插件移除后，合成执行子会话身份仍被旧根守卫卸载态拒绝。rv3 的 165 个采样点均有拦截，但切换时请求阻塞导致间隙未采样，且未驱动真实子 Agent，不能据此宣称所有瞬间无空档。[原始报告](../_leader-probe/r8-r12-continuous/reload-verify/REPORT.md)。
- `safety-round2` 在带卸载观测探针的独立副本中使用实际挂起的假模型执行子 Agent，真实改变白名单触发重载，30/30 检查通过：卸载回调同步观察到旧根守卫拒绝，随后新守卫因未确认停止拒绝该子会话，普通会话正对照放行。48 次外部样本未观察到放行，但不覆盖同步交接块的每个瞬间；执行停止并未证明。[报告](../_leader-probe/r8-r12-continuous/safety-round2/RELOAD-WINDOW-REPORT.md)。
- `reload-verify/rv6` 使用候选 index `4E7EB100…` 与实际挂起的假模型执行子 Agent，在同一进程中真实变更配置及移除插件；新旧守卫拒绝理由可区分，移除后对该子会话真实工具写入被拒且文件未产生。206 次离散样本没有放行，但不能证明未采样瞬间零空档；仅覆盖该宿主版本和配置重载路径。[报告](../_leader-probe/r8-r12-continuous/reload-verify/REPORT.md)。
- 补充并发回归：真实生命周期文件配合两个假执行桥，首个执行挂起期间第二个能完成，随后首个完成、生命周期记录回到干净状态；另测磁盘未确认记录与运行中活动 ID 重合时仍拒绝派发。这是模块级模拟，不冒称真实宿主多任务验证。
- 卸载时先停调度器，并在异步依赖检查返回时复查暂停状态；中止信号到来而执行桥挂起时，预算按未知结算并暂停后续补位。针对性测试及当前 14 个脚本回归通过。
- 当时的候选 `4E7EB100…` 的独立假模型实例 `mt-final3` 完成 37/37：两个任务实际并发、提案/排队/运行中取消、结果未知不重发、旧首辅生成交接、新首辅读取和旧首辅发送前阻断。实例内八个核心文件与当时整合候选哈希逐一一致。两次较新候选复验中测试脚本曾分别将取消终态写死为 timeout、在子调用尚未开始时取消并漏传 taskId，修正后用新实例复验；失败证据保留。[后续复核](../_leader-probe/r8-r12-continuous/FOLLOWUP-REVIEW.md)；[实例记录](../_leader-probe/r8-r12-continuous/e2e-verify/iso-mt-handoff/instances/mt-final3/out/e2e-evidence.json)。

### 根守卫生命周期补测与候选漂移

本轮开始 `index.mjs` 为用户指定的 `4E7EB100…`；测试期间并行工作流继续修改整合目录，该文件相继出现 `791D8BB9…`、`92BC2769…`、`10D3BD3E…` 等不同哈希，`exec-policy.mjs` 也改变。本轮不覆盖这些变化；守卫生存期 gv2/gv3 测试使用独立冻结的 4E7 版本，不能把结果直接套给后续候选。[漂移记录](../_leader-probe/r8-r12-continuous/CANDIDATE-DRIFT-20261113.md)。

在该冻结版本中，假模型任务先完成且 `lastSettle.confirmed=true` 后，根守卫仍在；随后完全移除插件时记录 `removeGuard:true/no-active-executions` 只是卸载决策，实际根守卫仍保留，继续拒绝执行子身份。两次真实配置重载以及先移除后重新加载，观测全局层数都为 1；普通会话写入对照正常。活动任务中移除时保护复用同哈希 rv6 的真实工具拒绝证据，不能据此推断其已停止。[生命周期报告](../_leader-probe/r8-r12-continuous/guard-life-verification/REPORT.md)。

真实摘要试验计划只拟一条待用户指定的会话，尚未授权或执行。代码先在本机读完整会话再按 seq 筛选，dryRun 不能展示完整发送 prompt；摘要不走任务 governance 预算，首辅白名单没有摘要工具，真实首辅与假模型专用执行入口不可同时构成真实任务闭环。详见 [代码核查方案](../_leader-probe/r8-r12-continuous/REAL-TRIAL-REVIEW-20261113.md)。

随后补充“任务真实 running → 先完全移除插件 → 尝试完成/停止”的缺失顺序（gv5 31/31、gv6 对照 6/6）：移除前的运行状态、活动集合、门闸等待均有证据；卸载的 abort 使自然完成窗口消失，子会话 turn/end 为 aborted，任务以 timeout 结束、lastSettle.confirmed=false、unresolved 保留，根守卫层数保持 1，普通会话四个阶段均放行；重新加载后新实例接管并因未确认停止阻断派发。[补测报告](../_leader-probe/r8-r12-continuous/guard-life-verification/REPORT-PREGATE.md)。因此「运行中移除→可靠停止」在插件层不可得，按 fail-closed 记录 unknown；不能据此宣称子 Agent 已停止或守卫可安全撤除。

### 方案 B 核实与受控摘要入口（独立副本）

另一对话交付的方案 B 经核对属实：`index.mjs` `6A474F759CB99E4521C55240B099714DC34B000356B63E3B59C18F5ABE4CEFEB`，preset 后备失败改为继续执行并带 `constraint`，新增 `execRequireFallbackPreset` 默认关闭。本轮不改 integration，另建独立副本补上真实摘要的两个缺口：完整预览与一次性受控发送。

受控入口只在 `controlledSummaryTestOnly` + `isolatedTestExecution` + fake/fake-1 + `allowManualSummary` 同时成立时开放，真实模型配置一律 403。预览返回完整系统提示与正文且不发请求；确认时用 SHA-256 绑定会话、seq 范围、cwd、规则版本与 prompt，不一致即拒绝；实例内只接受一次发送尝试。隔离实例 sum4 验证：未认证 401、预览 0 请求、确认后假模型收到的 system 与正文与预览逐字相同、重复与并发确认均 409、模型调用数恒为 1、摘要已落盘。全量回归通过；`auth-race-probe` 因伪造 parent 缺 preset 服务而失败，属探针配置问题，显式关闭后备后复测通过，原失败记录保留。[报告](../_leader-probe/summary-controlled/REPORT.md)。真实 provider、凭据、计费与真实会话仍未验证。

方案 B 的三实例原始证据也逐项核对：b1 后备失败但任务 succeeded、b2 preset 在首次调用前 56ms 生效、b3 两次越权写均被根守卫拒绝且 `outside` 目录不存在，因此窗口期约束确实来自根守卫，preset 只是附加层。

顺带查清一个真实缺陷：`multi-task.test.mjs` 场景 5 偶发失败，根因不是测试抖动，而是 `task-store.propose` 用 `Date.now()` 作 `createdAt`，同毫秒创建时 `nextDispatchableId` 退化成按 id 字典序派发，破坏「先创建先派发」。已改为 `lastCreatedAt` 严格递增（重启后按已有最大值继续），并加 `task-order.test.mjs`；修复后该测试连跑 20 次、全量连跑 3 轮零失败。这是产品语义修复，不是改测试迁就实现。

### 合并进候选（2026-11-13）

用户同意后把受控摘要入口、派发顺序修复、`task-order.test.mjs`、`controlled-summary.test.mjs` 与 `auth-race-probe` 适配合入 `integration/dsh-wangchao`，`order-determinism.mjs` 留在独立目录。合并前备份 `integration-pre-merge-20261113`（`index.mjs` `6A474F…`）。合并后 `index.mjs` `C6FE6B0D…`、`task-store.mjs` `CF76ADB0…`。

合并前实测 integration 自身有两个现存失败：`auth-race-probe`（方案 B 漏适配）与 `multi-task.test.mjs` 12 次失败 5 次。合并后 15 个 `.test.mjs` 加三个探针连跑 3 轮零失败；隔离实例 `mv1` 验证受控入口全流程（未认证 401、预览零请求、预览与实际发送逐字相同、重复 409、调用恒为 1、摘要落盘），实例内插件哈希与 integration 一致，端口已清。已知代价：`createdAt` 不再等于墙钟时间（最多超前任务数量级毫秒）、受控入口属测试脚手架、`auth-race-probe` 不再覆盖有 preset 后备时的授权竞态。

### 部署到桌面（2026-11-14）

用户授权后部署到 `C:\Users\t4365\.dsh\profiles\desktop`：替换插件代码（`index.mjs` `C6FE6B0D…`、`client.js`、`task-store.mjs` `CF76ADB0…` 等 12 个文件），profile 的 `cordis.patch.yml` 从「`disabled: true` + `observeOnly: true`」改为启用 + `observeOnly: false`，`stateDir` 换到新的 `desktop-live-state-v2`，保留原三个授权会话。旧安装与 patch 备份在 `_leader-probe\desktop-deploy-backup-20261114`。

部署前用「桌面同款配置」隔离实例 `dl1` 预检（无 fake provider、无执行配置）：插件正常加载，`/api/dsh-wangchao/{overview,sessions,work,chief}` 均 200，采集到 3 个会话，`dsh.err` 为空；`/work` 显示根守卫已装（`guardScope: root`）、preset 后备因未配执行根而 `exec-policy-unavailable`，符合预期。实例已按 PID+命令行停止，端口清空。

未生效项：插件代码需重启 DSH 才加载；执行入口仍被 fake-only 门禁挡住；真实摘要未开（`allowManualSummary` 未配）。当时误以为首辅会自动继承宿主默认模型；实际创建/恢复时没有下发 provider/model，重启后的真实对话报错，后文已记录修复。

### 御书房侧栏图标

侧栏容器已渲染面板名称，插件此前在图标席位又渲染一次「御书房」，导致重复。将席位改成继承当前文字颜色的殿阁线描 SVG，按钮和面板切换由宿主侧栏处理；桌面安装实际指向 `Agent/leader`，与 integration 客户端同步更新。图标按 16 像素网格绘制，线宽 1.5，跟随宿主传入的尺寸和当前颜色。两个客户端 SHA-256 均为 `2F2C4821452F760B0FBF83D6704002C71F868B7BC634210A667E771D2F3F291E`；语法及 work-panel 测试通过。实际页面显示仍需刷新后确认。

### 桌面首辅守卫兼容修复

桌面部署后召见首辅返回“只读守卫未确认生效”。诊断发现桌面 0.2.2-rc.3 的 `checkGuards` 会把字符串拒绝转换为 `{reason}`，现有自检只认字符串，导致真实拒绝被误判为未拒绝；原隔离验收运行的是全局 CLI 0.2.2-rc.1，没有覆盖桌面版本。自检改为兼容两种有效返回；无效对象和抛错仍判失败，不放宽工具白名单。桌面 rc.3 的隔离实例用假模型验证召见成功，真实 tools.execute 路径六项自检通过（白名单允许、受控写操作在执行前拒绝、普通上下文不受影响）；旧字符串/新对象/格式无效/抛错四种接线探针均符合预期。诊断证据位于 `_leader-probe/chief-rc3-guard/harness/instances/rc3fix2/out/rc3-evidence.json`。独立复核发现执行守卫预检也有同类问题，已共用相同归一化并校验异常不得冒充拒绝；桌面 rc.3 假任务的四项执行预检通过，但后续启动另遇 undefined.id、记 unknown，该执行闭环未通过。该轮桌面与 integration 的 `index.mjs` 为 `70B532AAC1B56BB5295AE888905999E9C4E7CC296807B33421267BDF2B2BCAD1`。重启后首辅只读守卫检查通过，但用户输入时发现模型配置为空。

### 首辅继承宿主默认模型

用户重启后报 `has no provider/model`。当前运行时只读守卫已确认正常；根因是此前我错误地认为 `agents.create/resume` 留空会继承宿主默认值，实际 `AgentModel.current()` 只使用会话已记录的选择或显式 `AgentOptions`，空配置导致报错发生在模型请求前。现已在桌面与 integration 同步修复：未显式配置模型时读取 `agentDefaultModel.currentSelection()`，创建与恢复都传入默认 provider/model/推理档；已有会话记录的选择优先，不覆盖。状态改为读取当前会话实际模型，UI 补充未选模型提示。最终 `index.mjs` `399A7ED28A8D7BA6455CFB2D6E28F53AE597186672A9F4BD8AEB15407492EA94`、`client.js` `5FDA1BD716805344561CEED51B1C7F533977E645079032ACCF3DCA4B93C5A560`。

桌面 rc.3 的隔离假模型实例 model1/model3 验证创建与恢复同一首辅均继承 fake 默认；model2 模拟用户为会话选择 fake-2，释放并恢复后仍保留 fake-2。曾建议用户在当前首辅会话选择模型以避免重启，但用户反馈仍有问题，该办法未在真实界面验证。未发真实模型请求。完整模块回归首次有授权竞态夹具未传 agentOptions，已按宿主契约修正夹具并复测该探针通过。

### 首辅会话导航复核

用户确认先前回答“我是根 agent”的对话 ID 不是首辅；其后点击“打开首辅会话”出现空白工作区选择首页。我此前将原因归为用户打开了新会话过早：新旧会话不同已确认，但导致首辅未正确打开的具体环节仍未证实。对照 rc.3 隔离 GUI：首辅 cwd 未归组时会显示工作区选择；已归组时可直接打开并将客户端选中 session 标识与首辅 ID 核对一致。

已同步稳健性修复到桌面与 integration：前端先刷新会话列表并等待工作区投影包含首辅，预先确认会话可打开，再导航并验证 mainView 保留的是目标；若归属未确认、打开失败或导航被其他操作取代，则不创建普通新会话。服务端归组后检查 workspace 实际包含首辅，已有首辅重复召见时重核。nav7 rc.3 假模型隔离实例召见与手动重开均显示目标 ID；nav8 未归组则留在御书房显示提示；定向测试覆盖打开失败、选中失败及取消。更新后的桌面 index `4B5AB570…`、client `086D1EDD…`；尚未在用户当前桌面实测生效，原因不应冒称已彻底查明。详见 `_leader-probe/chief-default-model/NAV-REPORT.md`。

### 首辅打开失败的实测诊断

用户重启后点击召见仍报“未能确认首辅会话已选中”，并停在空白工作区选择界面。隔离 nav9（预先跨到另一个工作区再开首辅）两次都正确，说明隔离环境缺失了桌面的某个干扰因素。已部署客户端导航诊断（无正文）：`openChiefTarget` 失败/成功都会经 `/api/dsh-wangchao/nav-diag` 把 services 形态、workspace 投影、openSession 前后的 retainInfo/list.retainedBy/selection/archivedSessionIds 写到 `stateDir/nav-diag.jsonl`。

**实测根因（nav-diag 决定性字段）**：`session-chief-mwf78ww3-czbdwd` 自身在 `workspaces.list.archivedSessionIds` 里（`chiefArchived:true`，归档列表共 47 项）。`uiWorkspace.openSession` 打开首辅后，宿主的 `clearArchivedCurrent` 发现当前 mainReference 是归档会话，执行 `clearMain()` 清空 selection 并切回空白 conversation，于是首辅的 mainView 引用被释放、界面停在“选择一个工作区开始”。与之前猜的「未归组/目录竞态」都不同；隔离环境没有归档会话所以复现不出。首辅为何被归档：archive-manager 无定时后台归档（其 README 明示），应是用户手动或“一键归档全部”时被一并归档。

**修复**：`openChiefTarget` 在 openSession 前检测首辅是否在归档集合，若在则先 `workspaces.unarchiveSession(sid)` 并轮询等待界面快照移除后再打开。`chief-navigation.test.cjs` 增加归档用例。长期可选：给首辅配 `cfg.chiefCwd` 到正常目录，避免再次被批量归档误伤（未做，不影响本次修复）。

### 采集范围：连续纳入与候选列表修复

用户反馈「采集范围」里点「纳入允许会话」后页面无法滚动、且加不进更多对话。两处根因叠加：(1) `postRules` 成功分支 `setCand(null)` 清空候选表，内容高度骤降、`.ldr-wrap` 失去可滚动内容，滚动条消失；切走再切回才重新加载。(2) `GET /candidates` 只返回前 200 条，超出部分无法操作；`postRules` 无串行化，连续点击会因 baseRevision 相同而 409，成功后又清空候选表导致每次只能加一个。修复：成功后按 `includedId` 就地改该行 verdict、保留候选表与滚动，不覆盖其他草稿字段；`postRules` 用 `savingRef` 串行化并统一 finally 复位；`load` 增加 `skipRules` 使保存后不再重拉规则；候选接口改 id 字典序 `after` 游标分页 + `hasMore`，前端「加载更多」追加；按钮加 disabled 态；409 文案改为指向实际存在的「刷新」。隔离 GUI（scope1/scope2）连续纳入两条、revision 0→2、候选表与滚动保留；`scope-pagination.test.cjs` 验证 405 条分页且已采集项被删后游标不跳过；集成 20 个测试 + 2 探针全通过。当前桌面与 integration 的 index `8128EEC8…`、client `697FF157…`。



## 2026-11-14 — 御书房界面第二版：两页签 + 左卡右表 + 三抽屉

用户先拿了一份外部建议书（渐进披露 + 主从抽屉），逐条核对后发现它描述的界面并不存在：`WM/Live/Read`、`HEALTHY/DRAINING`、`stoppingLive`、`worker-1/worker-2`、`LIVE/COLD` 模式、`message:delta` 流水、watermark 折线图、压测按钮，在 `index.mjs` / `client.js` / `live-stream.mjs` / `mini-react.js` 里都没有对应字段或入口（`stoppingLive` 是模块内局部变量，`readyTimer` 是 `live-stream.mjs` 的 entry 字段，两者无 HTTP 出口；live stream 只缓冲 `{seq,type,time}`，正文永不保留）。据此否决“照建议书生成单文件 UI”，改为按真实接口重排。

结构确定为用户确认的版本：**2 页签（总览与对话 / 计划与任务）+ 左栏三张摘要卡 + 右栏五列会话表 + 3 个互斥抽屉（会话详情 / 内阁首辅 / 规则与采集范围）**。计划与任务保留为页签（待确认计划需要用户点按钮，且要对照预算暂停与执行守卫口径一起看）。

实现要点：
- 顶栏只用现有字段：`observeOnly` 状态灯、`totals.{sessions,available,unavailable}`、项目数、`pollCount`、`stalePending`、`generatedAt`；不新增任何“看起来实时”的假指标。`stateCorrupt` / `observeOnly` / `rejectedStats` 计数 / 不可用记录仍留在第一屏。
- 会话表：5 列，失败与覆盖缺口压成行尾 `⚠N`（`title` 给全文），抽屉里逐条展开。文案与旧表格逐字一致（部分送入缺字、未覆盖 seq、模型已返回未保存、待确认段、运行历史裁剪），没有因为折叠降低措辞强度。
- 会话详情抽屉：复用 `buildSummaryPanel`（保留 15s 判权检查、401 清空内容、`sumGenRef` 代次）；关闭抽屉时也把代次 +1，迟到响应不能把内容写回已关闭面板（旧实现关闭后迟到响应会重新打开面板）。
- 首辅：原 13 段内容原样搬进抽屉，未打开不构造节点；不再常驻 320px 侧栏。
- 任务队列卡：新增加载 `/work` 的只读摘要（20s、页签切到计划与任务时让位给 WorkPanel 的 15s），读不到就显示“读取失败”，不冒充 0 条计划。
- `mini-react.js` 两处修正（独立页面渲染器，宿主 React 不受影响）：① `patchChildren` 只删“超出长度的尾部”，被替换掉的旧节点会残留（首屏 loading 换正式内容后，页面底部多出一行“正在读取…”）；改为按本轮实际挂上的节点集合收尾删除。② `patchProps` 不再跳过 `className`/`style` 的移除，旧 class 残留会让被复用的节点继承 `ldr-empty`（居中、内边距），表现为整个计划与任务面板文字居中。

验证（全部为实测）：
- `node --check client.js` / `mini-react.js` / `index.mjs` 通过。
- 现有三个测试全过：`work-panel.test.cjs`（请求倒序/撤权/切页签/执行约束渲染）、`chief-navigation.test.cjs`、`scope-pagination.test.cjs`。
- 新增渲染冒烟 `render-smoke.cjs`：用假 React 直接跑 `View()`，断言两页签、左卡右表、⚠ 计数、点行开抽屉、Esc 关闭、首辅 13 段、规则抽屉、切页签关抽屉，并确认旧 `ldr-chatpanel` 已不再渲染。
- 真实浏览器截图核对（`preview-server.mjs` 提供固定夹具 + 真实 `client.js`/`mini-react.js`，Edge headless 1440×980，虚拟时间 4s）：overview / chief / session / scope / work 五张。夹具不是桌面真实数据，只用于版式核对；真实数据的界面仍需在桌面端刷新确认。

局限与待办：插件客户端代码在宿主里是启动时加载，**桌面主窗口需重启 DSH 才看到新版**；独立窗口走 `/api/dsh-wangchao/ui/client.js` 实时读盘，刷新即可。`_leader-probe\hybrid-live-stream\dsh-wangchao` 那份实验副本没有同步本次改动（它属于混合流实验线）。本次未改 `index.mjs`、未动 desktop profile 配置、未调用任何模型。

### 补记：压力夹具暴露的两处版式问题（2026-11-14 深夜）

按用户建议先做真实数据前的自检，用 25 条会话 + 超长阻断原因 + 长 cwd 的压力夹具（`wangchao-ui-v2\verify\preview-server.mjs` 的 `WC_STRESS=1`）在 1440 / 1000 / 760 三个宽度截图，发现并修掉了三处：

1. **cwd 没有上限，把「会话」列撑满**：长 cwd 不做截断时表格自动布局会把摘要列压成三行。改为 `.ldr-ellipsis`（`max-width:320px`，窄屏 200px，`title` 保留全路径）。
2. **≤1100px 时左栏三卡被排到表格下面**：原来的响应式规则把主区 `order:1`、侧栏 `order:2`，主视图被侧栏挤窄后首辅状态与待确认角标要滚过整张表才看得到。改为不换序，三卡在窄屏排成一行（760px 时自动 2+1 换行）。
3. 顺带修 `.ldr-card` 作为 `<button>` 的默认垂直居中：卡片在一行里被拉高时文字会悬在中间，改成 `display:flex;justify-content:flex-start`。

量化：压力夹具下「点会话行 → 抽屉出现」为 `DRAWER_MS=10`（夹具接口 0 延迟，量的是渲染+布局）；真实使用的等待来自 `/summaries` 判权读取。⚠ 悬停文案在 DOM 里逐条核对过，10 个徽标各自带完整的多行说明（部分送入缺字数、未覆盖 seq 区间、未保存次数、待确认段与人工确认数、裁剪条数）。

回归：三个既有测试 + 渲染冒烟重跑全过。截图与脚本在 `B:\DSH\Agent\wangchao-ui-v2`。


### 外观跟随系统（深色模式，2026-11-14 23:5x）

用户要求「外观跟随系统」。做法：把整套配色收成 CSS 令牌，挂在 `.ldr-layout` 上，浅色为默认值，`@media (prefers-color-scheme: dark)` 覆盖成深色。不读宿主内部状态：Electron 里 `prefers-color-scheme` 跟 DSH 的 `ui-theme`（nativeTheme），独立窗口（Edge `--app`）里跟系统设置，两边都等于「跟随系统」。

- 令牌 24 个：底色 / 卡片面 / 代码面 / 正文 / 次正文 / 弱化 / 标签 / 边框两档 / 分隔线 / hover / 选中 / 朱红强调三件套 / 警示底 / 成功 / 主按钮 / 危险按钮边 / 遮罩 / 阴影。深浅两套见 `client.js` 的 `PALETTE`。
- 所有 CSS 与 4 处内联颜色（观察版横幅左边框、首辅阻断左边框 ×2、工作面板分隔线 ×3、项目筛选下拉）都改用 `var(--ldr-*)`。
- `standalone.html` 的 `html,body` 与启动错误条改用 `light-dark()`，避免深色下露出一圈白底。
- 深色下 `.ldr-unavail` 透明度从 .62 提到 .72，否则不可用行几乎看不见。
- 顺带删掉已经没人用的 `.ldr-chat` / `.ldr-chatpanel` / `.ldr-chathead` / `.ldr-chatbody` 四组样式（首辅搬进抽屉后就没有元素用它了）。

验证：用 CDP（`verify/shoot.mjs`，Node 内置 WebSocket）把 `prefers-color-scheme` 强制成 dark 再截图，而不是靠系统设置碰运气。计算样式探针确认 `matchMedia('(prefers-color-scheme: dark)').matches === true`，`.ldr-wrap` 背景 `rgb(28,26,24)`、卡片 `rgb(37,34,32)`、正文 `rgb(233,227,219)`、下拉框文字为浅色（原先只有 UA 样式，深色下会是黑字黑底）。截图：`wangchao-ui-v2/shots/dark-{overview,session,chief,scope,work}.png` 与浅色对照 `light-session.png`。

回归：三个既有测试 + 渲染冒烟全过。局限：桌面主窗口仍需重启 DSH 才加载新客户端包；宿主是否把 `ui-theme` 的 light/dark 手动覆盖映射到 nativeTheme 未在本机切换验证过（当前 profile 是 `preference: system`，两者一致）。

### 按用户反馈调整第二轮（2026-11-15 00:0x）

用户对照截图提了 7 条，全部落地；两处给了选项的，按更干净的那条做：

1. **摘要版本与人工修订顺序**：原来输入框在最前、提示"先在上方选择要修订的版本"却把版本列表放在最下面。改为先渲染「摘要版本（N）」与正文，编辑区只在选中某版后展开；未选中时给一行说明。提交成功后 `openSummary` 会清空选中，编辑区自动收起。
2. **「以此版为基础修订」整行宽**：加 `.ldr-field > button{margin-top:6px;align-self:flex-start}`，同一规则也收住「计划与任务」里的「确认并派发」（此前承诺过的那条）。
3. **遮罩更深**：浅色 `rgba(20,17,14,.45)`、深色 `rgba(0,0,0,.6)`（原 .18 / .55，浅色下几乎分不开）。
4. **项目筛选下拉显示空白**：真因不是配色，是 `mini-react` 在创建 `<select>` 时先写 `value=''` 再挂 option，导致 `selectedIndex` 停在 -1。改成先挂子节点、后写属性（`createDom` 与 `patchVnode` 都改）。实测 `selectedIndex` 由 -1 变 0，显示「全部项目」。宿主 React 路径本来就不受影响。
5. **顶栏与左卡重复入口**：去掉顶栏的「内阁首辅」「规则与采集范围」两个按钮（只留刷新、独立窗口），卡片标题右侧加 `›`，hover 时变强调色并加浅阴影；卡片本身早就是可点的。
6. **页脚与顶栏重复**：删掉「王朝 · 索引生成于 … · 轮询 N 次」页脚及其 `.ldr-foot` 样式；`stalePending` 仍由顶栏 chip 承担。
7. **左栏吸顶**：`.ldr-col-side{position:sticky;top:58px}`（≤1100px 单列时改回 static）。同时把 `.ldr-table-wrap` 的 `max-height:60vh` 去掉——原来表格在小框里内部滚动，整页不动，左栏自然也不会滚走，但长列表挤在 512px 的框里很难读；现在改成整页滚动 + 左栏钉住。实测注入 23 行后 `scrollTop=420`，`.ldr-col-side` 顶到 58（+ 外层 padding），顶栏保持在顶部。

验证：三测试 + 渲染冒烟全过（冒烟里"顶栏有首辅按钮"的断言改成"点卡片"，并加了一条顶栏不得再出现同名按钮的断言）；深色/浅色截图重拍（`dark-overview/session/chief/scope/work`、`light-overview`、`light-session`），压力夹具改为深色并在三种宽度重拍。`shoot.mjs` 增加 `--size=WxH`（`Emulation.setDeviceMetricsOverride`），不再依赖启动参数。

### 视觉升级「玄墨朱批 · 现代工程台」（2026-11-15 00:1x）

用户给了一套完整的视觉规范，按它重做令牌与组件质感。逻辑不变，只动颜色、字号、圆角与间距。

- **4 级明度台阶**（深色）：画布 `#0d0f12` / 卡片与表格 `#14171c` / 抽屉 `#181c23` / 输入与 JSON 内凹 `#0f1216`。原来画布和卡片只差一档、抽屉和主表几乎同色，景深出不来。
- **边框改半透明白**：常规 `rgba(255,255,255,.08)`、hover 与激活 `.18`、行分隔 `.05`，不再用实线灰，深底上更透气。浅色对应 `rgba(20,17,14,.10/.22/.06)`。
- **语义色三档拆分**：青玉 `#34d399`（采集已启用、对话已接通、主按钮）、琥珀 `#fbbf24`（待确认计数、页签角标、卡片左竖线）、朱砂 `#fca5a5`（⚠ 徽标、失败与覆盖缺口、首辅阻断）。原来「待确认」和「阻断」共用同一个朱红，语义糊在一起。
- **主按钮改成青玉描边幽灵按钮**（`bg rgba(52,211,153,.12)` + `border rgba(52,211,153,.32)` + 文字 `#34d399`），和危险按钮（朱砂描边）成对。
- **排版**：正文 `'Segoe UI','Microsoft YaHei UI',system-ui`，等宽 `'Cascadia Mono','Consolas'`；整个 `.ldr-layout` 开 `tabular-nums`，事件数/轮询/seq/时间自动对齐；顶栏标题 14px/700，表头 12px `#6b7280`，抽屉标题 16px/700，区块小标题 12px + `letter-spacing:.04em`。
- **卡片**：圆角 10px、hover 边框提亮 + `translateY(-1px)` + 投影；有告警时左侧 3px 竖线（琥珀=待确认，朱砂=阻断/读取失败），比右上角红圈更像工程台。`/work` 摘要读不到或预算暂停时卡片走朱砂条。
- **表格**：行内边距 12/14、只剩极淡行分隔线、hover 整行 `rgba(255,255,255,.04)`、选中行 `.07`、不可用行 opacity .65。
- **抽屉**：遮罩 `rgba(5,7,10,.62)` + `backdrop-filter: blur(2px)`，左边缘 1px 高亮边 + `-12px 0 32px` 投影，底色比主表亮一阶。
- **按钮统一**：`height:30px; padding:0 12px; border-radius:6px; width:fit-content`，彻底消掉被列向 flex 拉满整行的老问题（此前那条 `align-self` 兜底保留）。

验证：三个既有测试 + 渲染冒烟全过；深色 5 张、浅色 2 张、压力夹具 3 个宽度 + 抽屉全部重拍。CDP 计算样式探针确认：画布 `rgb(13,15,18)`、卡片 `rgb(20,23,28)`、表头 `rgb(107,114,128)`、下拉框内凹 `rgb(15,18,22)`。`client.js` `9B3AD171248FFCFB…`。

坑：改卡片语义类时第一次用 PowerShell 字符串拼接替换，把三处调用改成了尾逗号（语法断裂），`node --check` 立即抓到，随后改用 `edit` 精确补回参数；教训是这种多行 JS 拼接不要用 PowerShell 的 `+` 拼数组字面量。

### 独立窗口：认证桥、token 地址与 Edge --app 启动（2026-11-15 00:2x）

目标：御书房从 DSH 侧栏释放为独立窗口，同时不复制第二份前端代码。

实现：
- 独立页面复用同一份 `client.js`：`standalone.html` 提供 `__ModuleLoader__` 垫片 + 假 slots/sessions + `mini-react.js`（迷你 React 兼容层），页面原样加载 `client.js`，`View` 由 mini-react 渲染；面板里只加了一条 `.ldr-layout` 占满窗口的 CSS。
- 认证：桌面 Electron 窗口是 `dsh-app://` + IPC 桥接，没有浏览器 cookie，直接 `window.open('/api/dsh-wangchao/ui')` 会 401。页面和两个静态资源改用 `webServer.register` 精确路由（优先于 connection 的 `/api` 前缀），handler 里调 `connection.authorizeIndex` 做 token 换 cookie；无 token 无 cookie 返回 401。`authorizeIndex` 只认根路径，所以用同一份 headers 构造 `/?token=…` 做一次探测：cookie 有效直接放行，token 有效拿它签发的 `set-cookie` 后返回页面。
- 地址入口：`GET /api/dsh-wangchao/standalone-url`（走认证连接层）返回 `connection.authenticatedUrl(origin + '/api/dsh-wangchao/ui')`。
- 弹窗：桌面主进程 `app.asar\lib\main.js:20278-20281` 把主窗口 `window.open` 硬编码为 deny + http(s) 交给系统浏览器，应用内开窗不可行；改为 host 端点 `POST /api/dsh-wangchao/open-standalone`，用 `spawn` 拉起 Edge/Chrome `--app=<带 token 地址> --user-data-dir=<stateDir>/standalone-browser`，得到无地址栏独立窗口。
- 首版曾用「fetch 拿 URL 再 window.open」，异步回调里的 window.open 被弹窗拦截；改为预取地址、点击时同步打开。第一版还踩过 `authorizeIndex` 的空 token 陷阱：无 token 时也传了 `?token=`（空值），它按「有 token 但无效」直接 401，跳过了 cookie 校验；改成无 token 时走 `/` 路径。

验证（隔离实例 ui1–ui12，rc.3）：
- 匿名 401 / 带 token 200+Cookie / 带 Cookie 200 / 静态资源同样；`standalone-url` 返回 token 地址且可直接打开 200。
- CDP：独立页面挂载、页签「总览与对话 / 计划与任务」、规则保存 revision 0→1、首辅召见 `exists=true`、计划与任务渲染、无控制台错误；「项目筛选」下拉框 `selectedIndex=0` 显示「全部项目」。
- `open-standalone` 无凭据 401；带凭据返回 `{ok:true, browser:'msedge.exe', pid}`，进程存活（测试后已清理）。
- 桌面：两次 reload 后 `pollCount` 连续、28 会话 watermark 未回退、`liveSessions/liveRead` 正常、`GET /api/dsh-wangchao/ui` → 401。

局限：桌面客户端包在宿主里是启动时加载，改完需刷新桌面窗口；Edge/Chrome 都不存在时入口 503；host 进程 `spawn` GUI 程序在受限沙箱下未验证。

### GitHub 发布 v0.2.0（2026-11-15 00:2x）

- 0.1.0-alpha.1 → 0.2.0；同步 14 个运行时文件（index/client/live-stream/mini-react/standalone/plan/task/governance/handoff/exec 等）+ README/CHANGELOG/package.json（version、files、compat 到 0.2.2-rc.3）。
- `publish-audit.ps1` 四步全绿（本地工作区 20 文件 / 本地全历史 / 远端克隆工作区 / 远端全历史）；两处误报豁免：`task-store-unavailable` 里的 `sk-` 前缀被当成 API key、`env.LOCALAPPDATA` 被当成环境描述。
- 首次提交作者邮箱 `macily@foxmail.com` 命中「邮箱」规则，改用 `MacilyDots@users.noreply.github.com` 重写提交并 force push。
- Release v0.2.0 + `dsh-wangchao-0.2.0.tgz`（166237 字节，sha256 `722f6a85…`）。

### 许可评估（2026-11-15 00:3x）

用户问是否改成 Apache-2.0。结论：项目无 vendored 第三方代码（`mini-react.js` 自写，DSH 依赖是 MIT peer），改许可无法律障碍；但个人社区插件用 MIT 足够，Apache 2.0 多出的专利/商标/贡献条款收益有限，而 NOTICE 与修改声明是持续成本。维持 MIT，未改。

## 2026-11-15 — v0.3.0 阶段一/二（B6 崩溃恢复、B2 引用跳转、rc.3 执行桥）

按 ROADMAP v0.3.0 的顺序推进：先 B6、B2 打底，再动真实执行链路。全部在隔离副本 `_leader-probe\v030-integration`，源目录与桌面未改。完整报告见该目录 `REPORT.md`。

### B6：故障注入暴露的真实缺口

原始代码实测（不是推断）有三类静默丢数据：`state.json` 缺失但有同名 `.tmp` 时新建空状态；`state.json` 缺失 + `pending.json` + `tasks/governance/exec-lifecycle` 仍在时同样重建并删掉 pending；`tasks.json` 缺失但生命周期有活动执行或账本有记录时 `/work` 谎报空库。另外 `governance.json` 缺失 + 残留 tmp → 以空账本打开，未结算预留从合计里消失；`exec-lifecycle.json` 同情况把未确认执行判成 `no-record` 放行。

修补：新增 `orphan-tmp.mjs` 统一判定 `none/orphan/error`；主文件缺失且有 tmp → 按 corrupt 处理不重建；主文件缺失 + pending + 其它状态产物 → `stateLoadIssue` 全程拒写；任务库缺失有痕迹 → 任务功能停用并给出原因。正常中断路径行为不变（水位续接、`sent`→`unknown` 恰 1 条、二次重启不重复）。

边界：检测只在启动时点；残留 tmp 不删除不提升；无 `fsync`，只保证进程崩溃原子性。

### B2：引用跳转，正文核对这条走不通

服务端 `/refs` 与 `/summaries.segments` 全部落地，边界是「先判权 → 再查版本 → 引用必须真出现在摘要正文 → 区间整段入选发送范围 → 读后复查」。真实 rc.3 宿主用合成种子验收：正常点击窗口 6–10、`cited` 只标 8；收紧规则后 `revoked` 且响应无 seq/events/cwd；恢复后可读；伪造区间 400 `not-a-citation`。

**正文没能返回**：先做的有限规则脱敏被实测反例推翻——`{"password":"abc123"}`、`数据库密码：…`、短 `Bearer`、含空格值全部漏；而「同规则自检无残留」是自证。于是删掉脱敏，改为 `bodyReturned:false`（`reason:'redaction-unverifiable'`），明确记为未满足项。

**seq 级深链做不到**：宿主没有公开的事件级导航 API（`UiSession` 只有 `bindingSource`/`whenAccess`；实验包 inspector 内部有 `anchorSeq→node` 但不导出、默认不装；官方 secret-mask 是对话显示层遮罩，不导出函数）。只能做会话级 `openSession` + 给 seq/类型/时间。

### 真实执行：修好了前置 bug，但不敢开

`undefined.id` 根因确证：宿主 `subagents.startActivation` 的 spec 在 rc.1→rc.3 从嵌套 `request` 改成扁平顶层字段，插件仍按旧形状传参，`spec.parent` 为 `undefined`。去掉包裹后，真实 rc.3 + 假模型闭环跑到 `succeeded`（采集→召见→提议→确认→子会话→结果→账本 settle）。

但真实费用门禁证明不了：`SubagentResult` 无 usage，`maxTokens` 只是单次输出上限；root `llm/stream` 虽在真实执行子 agent 上捕获到 2 step + 1 retry（带子会话 id），却只覆盖单子 agent 串行，并发归属、取消、`prepareCall` 前失败、跨进程、被其它监听短路都没证。现有预算包装还对所有终态硬编码 `actualEstimateUsd: 0`，用于真实模型就是把未知费用记成零。**保持 fake-only，0 次付费请求。**

### mini-react 清理修复

原实现丢弃 effect cleanup、无卸载语义。修复版补了两阶段 drain、卸载遍历、已死实例防护与 `inst.vnode` 旧 props。独立审查列出 D1–D5：D1/D2/D3/D5 修掉，D4（同一 vnode 对象跨挂载复用致误清理）不修——现有 `client.js` 的 vnode 都在渲染函数内新建，不触发；修它要改数据结构。

### 结论

B6 完成；B2 部分完成（正文核对与 seq 深链是能力缺口，不是没做完）；rc.3 执行桥修复并假模型闭环验证；真实执行链路未开放。桌面未同步。

### 补记：attempt 级执行预算门禁接入隔离集成副本（2026-11-15 12:4x）

在 `v030-integration` 把 `budget-gate/exec-budget.mjs` 接入 `index.mjs`：root 注册 `llm/stream` 门禁，只对 `execChildIds` 的执行子会话记账；发送前按「输入字符数 + 输出 maxTokens」做本地估算并原子落 `exec-budget.json`，无法确认 `maxTokens` 时通过 root 的 `llm.resolveModelInfo` 解析模型默认输出上限；请求结束后按 stream usage 结算，无 usage 或抛错即 unknown。任务结算改用 `execBudget.totalsFor(childId)`，`governance.settle` 不再把成功任务硬编码成 `actualEstimateUsd: 0`。`budgetIntercept` 允许未来通过 `execTaskEstimateUsd` 给真实任务预留，但 `runExecutionTask` 的 fake-only 总门禁仍在。

实测（真 rc.3 + fake adapter，0 次付费请求）：
- 正常 usage 1200/300 → `exec-budget.actualUsd=0.00072`，`governance.actualEstimateUsd=0.00072`，任务 succeeded；
- 不上报 usage → attempt 记 unknown、任务级 governance 记 unknown，后续派发暂停；
- 预算 0.0001 低于估算 → 拒绝子进程请求，`exec-budget.json` 不存在，`exec-budget-denials.jsonl` 记原因；
- 接入后六套 B2/B6 回归全绿；源目录和桌面仍未动。

剩余限制：本地估算门禁不是服务商账单硬上限；真实价目、多路由计费桶、并发/取消/跨进程子 Agent、其它 waterfall 短路以及 prepareCall 前失败均未证明。要跑一次真实模型，仍需用户给出测试目录、单次预算、累计预算、模型。



### 整合与真实执行验证（2026-11-15 20:xx）

本轮把隔离验证后的代码合入 `leader` 主分支（桌面 profile 通过 junction 直接指向本目录），版本升到 0.3.0。

- 合并内容：B6 崩溃恢复（task-store / governance / exec-lifecycle / orphan-tmp fail-closed）、B2 摘要引用（index/client/mini-react，24+30+15 测试）、执行预算门禁（exec-budget / writer-epoch-fencing / exec-gate-wiring）以及 P1 自检组（checks/，4 组 31 断言）。
- 生产化处理：删除 `WC_TEST_REAL_PROVIDER/MODEL`、`WC_EXEC_MAX_TOKENS_OVERRIDE`、`WC_GATE_REGISTER_FAIL` 三个环境变量扩权入口；真实路由白名单固定为 `deepseek-official/deepseek-flash`；`maxTokens` 固定 512；执行入口仍要求隔离测试开关，默认不开放真实执行。
- 单次受控真实试验（real6）：2 次 `deepseek-flash` 请求、1 次 `read` 工具调用、真实 usage 2872/102 与 156/136，账本 2 条 settled，`usedUsd=0.001194`，任务 succeeded；路径守卫与 `workspace-write` 约束均生效。试验后实例停止并 disarm。
- 已知边界：预算按未缓存输入计价，`cacheReadTokens` 未单独计价（本次少记约 $0.0000177）；本地估算不是服务商账单硬上限；锁无 lease/TTL，强杀后需人工清锁；`realExecutionTrial` 与 harness 补丁只存在于隔离试验目录，未进生产源码。
- 桌面进程需重启后才会加载本次代码；磁盘上的 junction 目标已更新。

### v0.3.0 收尾：cacheRead 计价与发布材料（2026-11-15 21:xx）

- `exec-budget.mjs` 的 usage 解析新增可选 `cacheReadTokens`；结算价目新增 `cacheHit`。未显式配置命中价时按标准输入价计算（保守上界），`snapshot()` 暴露 `pricePerTokenUsd.cacheHitPricedAsInput`，`note` 明确写出「cache-hit 按标准输入价保守上界估算」，避免和官方缓存折扣价对账时产生歧义。`totalsFor()` 增加 `inputTokens / cacheReadTokens / outputTokens` 汇总。
- `exec-gate-wiring.mjs` 同步透传 `cacheReadTokens` 与可选 `cacheHit`；index 的生产价目改为官方高峰价 `input 0.30 / output 1.20 / cacheHit 0.006`（USD per 1M）。
- 新增测试：C3b（未配命中价按输入价保守计）、C3c（显式命中价单独折算）、C3d（旧 adapter 不报 cacheRead 时行为不变）、W27（接线层 cacheRead 结算与账本保留）。预算/接线共 80 项通过。
- 文档：README 增加 v0.3.0 状态、真实试验结论与边界；新增 CHANGELOG.md，记录 0.3.0 与 0.2.0。
- 发布前审计：`publish-audit.ps1` 检查工作区与 Git 历史中的 key、日志、会话正文、邮箱与路径残留；未 push 远端，待用户确认。

### v0.3.0 正式发布（2026-11-15 21:1x）

- 发布树 `_leader-probe\gh-wangchao` 完成收尾：README 用 v0.3.0 定稿，About 描述改为「跨会话总控与受控协作插件（王朝·御书房）…默认关闭付费执行」；包简介同步。
- 发布审计四步全绿：本地工作区 24 文件、本地 6 个提交全历史、远端克隆工作区与全历史、HEAD 一致 `57ca9f1`；仅豁免 `task-store-unavailable` 的 `sk-` 前缀与 `env.LOCALAPPDATA` 两处误报。仓库原为 PUBLIC。
- 推送 `master` 与 tag `v0.3.0`；GitHub Release `v0.3.0` 已创建并上传 `dsh-wangchao-0.3.0.tgz`（208434 B，SHA256 `4A4209D7…F2155F3B`，GitHub digest 一致）。
- npm：尚未发布。registry 上 `dsh-wangchao` 仍是 0.0.1 占位包，`latest` 指向 0.0.1；按既有约定发布 0.3.0 时使用 `--tag alpha`，不顶掉 `latest`。
- 开发仓库 `leader`（含本日记、测试、checks）不参与公开推送，仅本地保留。

### 补记：npm 0.3.0 已发布（2026-11-15 21:21Z）

- `npm publish --tag alpha` 成功：`dsh-wangchao@0.3.0`，dist-tag `alpha` 指向 0.3.0；`latest` 仍是 0.0.1 占位包，未被顶掉。
- registry 元数据有短暂延迟，首次 `npm view` 仍显示 0.0.1；重试 publish 返回 “cannot publish over 0.3.0”，再查 `dist-tags` 确认为 `latest: 0.0.1 / alpha: 0.3.0`。
- 发布包与 GitHub Release 资产同为 22 个文件、208434 B；npm shasum `31d5479f75e52fa8d9f91cc503fcc0eb0e3f6506`。

### 0.3.1 发布与 npm 安装验收（2026-11-15 21:4x）

- README 安装章节补 npm 方式：`dsh plugin --profile <name> add dsh-wangchao`，并保留本地源码安装；版本 0.3.1（纯文档补丁）。
- 发布树审计本地 + 远端全绿（HEAD `6858707`），tag `v0.3.1` 已推送，GitHub Release 上传 `dsh-wangchao-0.3.1.tgz`（208565 B，SHA256 `92BF6E23…77E8699`）。
- npm 发布 `dsh-wangchao@0.3.1`，dist-tag `latest` 已指向 0.3.1；`alpha` 保留 0.3.0；`0.0.1` 占位包已标记 deprecated。
- npm 安装验收：临时 DSH profile 用 `dsh plugin add dsh-wangchao@0.3.1` 安装成功，启动后 `/api/dsh-wangchao/work` 返回 200、`guardInstalled=true`、预算门禁按预期未启用。注意：pnpm 对 `latest` 的元数据缓存可能滞后，首次未指定版本会解析到旧的 0.0.1；显式版本或清缓存可避免。
- 清理：删除今日临时目录 `_npm-verify`、`_release-verify`、`prod-smoke` 及三个空 `waterfall-fake-data-*`；大型历史实验目录未动（`out` 20GB、`r6-20261111-magpie` 6.5GB 等），待用户逐项指认。

### B2 事件级引用定位落地 + 上游真锚点卡点记录（2026-11-16 00:2x）

**结论修正**：B2 之前记的「精确跳 seq 做不到，只能等上游」下早了。实测查证后分两层：
- **能做（本轮已做）**：按事件类型尽力定位——用户消息、工具调用可精确定位到行；助手/流式事件只能定位到所在轮次。
- **仍卡上游（未做）**：任意 `seq → 精确锚点` 的稳定公开接口。

**一、本轮实现（`leader` 源码，未发布）**

服务端 `index.mjs`：
- 新增导出 `refAnchorOf(event)`：只产出定位标识，不碰正文——`user/message` → `{kind:'message', id}`；`tool/call` → `{kind:'call', id}`；`tool/result` → 复用所属调用的 `callId`；`assistant/message|attempt|live-chunk` → `{kind:'turn', turn, step?}`；其余事件返回 `null`（不猜）。
- `selectRefEvents` 每条卡片新增 `anchor` 字段；`REF_BODY_POLICY.anchorSemantics` 写明「message/call 可精确定位到行，turn 只定位到轮次」，正文策略不变（仍 `bodyReturned:false`）。

客户端 `client.js`：
- 引用面板每张事件卡片加「定位」按钮（仅 `anchor` 存在时出现）；主按钮落到引用区间内第一条可定位事件。
- `jumpToHostSession(sid, ev, onProgress)`：先 `openSession` + `selectPanel(null)`，再按锚点找宿主聊天行——消息级匹配 `data-chat-anchor-key` 的 messageId 尾部，调用级匹配 `data-chat-call-id` 或 `anchor-key="call:<id>"`，轮次级匹配 `data-chat-turn`。
- 定位是有界轮询（150ms 后首次、200ms×最多 12 次）：命中则 `scrollIntoView` + 1.6s 描边高亮；超时如实报「当前已加载窗口里没有 seq N 对应的行，请向上滚动加载更早历史后重试」，**不把附近的一条说成精确定位**。
- 轮次级命中单独措辞：「已定位到 seq N 所在轮次（该事件没有独立可见行）」。

**二、顺带修掉的既有缺陷（与 B2 无关，但会阻断一切验证）**

`index.mjs` 调用了 `createPollDomain`，但**没有从 `poll.mjs` 导入**（P3 第二刀提取时漏了 import）。后果是 `apply()` 在 1652 行直接抛 `ReferenceError: createPollDomain is not defined`，插件整体加载失败。已补 `import { createPollDomain } from './poll.mjs';`。桌面进程重启前不会暴露这个错。

**三、上游卡点（第二条，仍未解）**

- 官方 [Discussion #4602](https://github.com/deepseek-ai/deepseek-harness/discussions/4602)「按 seq 中心寻址（afterSeq）+ 打开锚点」查询时状态仍是 **open**（建于 2026-08-26，最后更新同日）。要「任意 seq 都能保证精确落点」，得等这个能力。
- 安装版 `0.2.2-rc.3` 自带的实验性 Session Inspector 已有 `seq → chat node` 解析（`session-log/chat-target.ts` 给 `anchorSeq: event.seq`，`chat-node/reveal-target.ts` 按 tool → exact → kind → nearest 优先级解析），但**不能作为 API 复用**：包只导出浏览器 bundle 和空的 `apply()`，模型类与解析函数都是内部模块。可复用的只有算法逻辑（约 137 行），前提是自持 `ChatConversationViewNode[]` 与已加载事件窗口。
- Inspector 的精确命中本身也不完备：助手节点的 `anchorSeq` 可能取首个可见 chunk 的 seq 或 interrupted 时的 settled.seq，`assistant/message` 的 seq 因此会落空并退到 kind/nearest；`tool/result`、流式 delta、`turn/start` 等没有独立聊天节点。

**四、边界与未验证项**

1. **未在真实桌面宿主做端到端验证**：本轮只有假 DOM（真 `client.js` + `mini-react`）覆盖定位调用序列与文案；跨会话切换后宿主是否真的渲染出目标行、真实 `data-chat-*` 属性是否与测试一致，均未实测。
2. **依赖宿主 DOM 属性**（`data-chat-anchor-key` / `data-chat-call-id` / `data-chat-turn`）：这是宿主聊天视图的实现细节，不是公开契约，宿主改版可能失效。失效时的表现是「如实说没找到」，不会静默错跳。
3. **旧历史需分页**：只解析已加载窗口；更早的行得用户先向上滚/点「加载更早」。客户端拿不到 `loadOlder`（`uiWorkspace` 没有该能力），所以没有自动翻页。
4. **turn 级不是逐条**：多条助手事件共用一条可见行，这是宿主渲染事实，不是实现偷懒。

**五、测试与自检**

- `node test/seq-refs.test.mjs` → 34 用例（新增 `refAnchorOf` 三类：正常映射 / 无标识返回 null / 锚点不含正文；`selectRefEvents` 带 anchor 且仍无正文）。
- `node test/refs-route.test.mjs` → 24 用例（字段清单加 `anchor`，并断言 anchor 只允许 `id/kind/step/turn` 四类键）。
- `node test/standalone-refs.test.mjs` → 17 用例（新增：主按钮精确定位并写回文案；轮次级定位文案；定位失败如实报未找到）。
- `node checks/all.mjs` → 4/4 组、33 条断言全过；`checks/typecheck.mjs` → SKIP（本机无 tsc，既有情况）。

**六、待办**

- 真实桌面端到端验收：重启桌面 → 打开某会话摘要 → 点引用 → 确认跨会话切换后确实滚动到目标行、高亮正常、旧历史场景给出正确提示。
- 版本与发布：本轮未改 `package.json` 版本、未发布 npm/GitHub Release。验收通过后再定 0.3.2。

### 工程自检、锁诊断与宿主探针（2026-11-16）

- 发布树新增离线测试、自检、净室审计与 Windows Node 24 CI，测试和 `checks/` 不纳入 npm 包；写锁新增进程启动时间及主机标识摘要，提供只读诊断和显式确认清理；宿主探针使用隔离 HOME 与假 provider 检查四项接口。
- 发布仓 `master` 提交 `d938b8adfc22f71535707773b7998fdb717b30d5` 已推送，未发布 npm 新版或 GitHub Release。远端完整克隆同提交：12 套测试、4 组 33 条自检及 29 项净室审计通过；GitHub Actions CI 通过。桌面 DSH 0.2.2-rc.3 隔离假模型四接口通过；rc.1 对照曾超时，另一独立探针报告三个接口通过、执行子 Agent 接口失败，不能将结果外推到其他版本。
- 审计发现旧发布仓为浅克隆，之前声称本地“全历史”只覆盖 7 个提交；本次完整克隆覆盖 11 个可达提交。既有改写前提交仍可通过 GitHub SHA 访问，含公开联系邮箱，普通克隆与 `--all` 无法覆盖这类不可达对象。测试夹具迁入时发现并移除了本机路径，补充路径与凭据扫描及回归测试。
- 本轮未合并上面 B2 开发树的未提交改动；锁清理仍须先停用所有使用同一 stateDir 的实例并核对账本，工具无法消除竞态。宿主进程和网络检查为采样，不代表穷尽所有子进程与外连。

### P3 拆分引入的两个致命回归（2026-11-16 收口时发现并修复）

收口 B2 前跑开发树全套测试，`b6-recovery.test.mjs` 失败。用 HEAD 干净副本对照：HEAD 上同样失败（子进程退出码 1 而非预期的 70），说明**不是 B2 引入，而是 P3 拆分时就已坏，且一直没被发现**——leader 没有一条命令跑全部测试，`checks/` 只测边界契约，不触发 `apply()` 的轮询路径。

两个独立缺陷，都会让采集失效：

1. **漏 import**：`index.mjs` 调用 `createPollDomain` 却没有从 `poll.mjs` 导入（P3 刀2 提取时漏掉）。`apply()` 直接抛 `ReferenceError`，插件整体加载失败。
2. **跨模块写 const**：`poll.mjs` 从 deps 解构 `liveStreams / polling / stoppingLive / pendingPoll` 后直接赋值。解构出来的绑定是 const，赋值抛 `TypeError: Assignment to constant variable`。实测后果是 `startupReport.error` 变成该错误、`readCalls=0`——**启动轮询第一步就断，采集整轮不工作**；live stream 那条赋值还被 `catch {}` 静默吞掉，只剩「永远退回轮询」。

修复：运行时状态改为可变盒子 `liveRuntime = { streams, polling, stoppingLive, pendingPoll }`，`index.mjs` 与 `poll.mjs` 操作同一对象（不再各持一个裸 `let`）；补上 `createPollDomain` 的 import。修复后诊断探针 `readCalls=1`、`startupReport` 正常（`synced=1`），b6 三套、预算、围栏、wiring 与三个 refs 测试全部通过。

教训：提取模块时，**被写入的跨模块状态必须换成共享容器**，只改读取方不会报错；而「模块能 import 成功」不等于「`apply()` 能跑起来」——只测纯函数与边界的自检不会发现这类断裂。

**桌面当时已在跑坏版本**：`desktop-live-state-v2/state.json` 的 `startupReport.error = "Assignment to constant variable."`，最后一次正常 `lastPollReport` 停在 21:49；进程 23:58 重启后采集实际停摆（定时轮询的异常又被 `.catch(() => {})` 吞掉），但界面仍在显示旧数据。junction 指向 `leader`，磁盘一改就变，**必须重启桌面 DSH 才加载新代码**。

### v0.3.2 发布（2026-11-16）

- `leader` 提交 `d2ade66`：B2 事件级引用定位（`refAnchorOf` + 客户端定位/高亮）+ 上述 P3 回归修复。开发树验证：b6 三套、预算、围栏、wiring、三个 refs（34/24/17）与 `checks/` 4 组 33 条全过。
- 桌面同款隔离实例（临时 HOME + 独立 profile + junction 到 `leader`）验证新代码：`startupReport` 无错误、`stateLoadIssue=null`、`pollCount=1`，宿主正常启动。桌面主进程未重启（会中断当前会话），需用户操作。
- 发布树同步：`client.js`、`seq-refs.test.mjs` 与发布仓同源，直接同步；`refs-route` / `standalone-refs` 保留发布仓的路径脱敏后同步；`index.mjs` 结构不同（发布树未做 P3 拆分），手工移植 `refAnchorOf`、`anchorSemantics` 与 `selectRefEvents` 的 `anchor` 字段。发布仓补回 0.3.2 版本号、CHANGELOG、README 诊断章节。
- 发布前把仓库根残留的三个历史 tarball（0.2.0/0.3.0/0.3.1）移到 `_leader-probe/release-assets`，净室审计才通过（审计按磁盘全集扫，`.gitignore` 里的产物同样算残留）。
- 验证：本地与远端完整克隆各跑一遍 `npm run verify`——12 套测试、4 组 33 条自检、29 项净室审计全过；私有发布审计四步全绿（51 文件 / 12 提交 / 远端工作区与全历史 / HEAD 一致 `a47f0a7`）。
- 推送 `master` `a47f0a7`，GitHub Actions CI（windows-latest + Node 24）`success`；Release `v0.3.2` 上传 `dsh-wangchao-0.3.2.tgz`（242498 B，SHA256 `27F2F353…2B75BD`，GitHub digest 一致）；`npm publish` 0.3.2，`latest` 已指向 0.3.2（`alpha` 仍 0.3.0），shasum `45864bab…7ff717`。临时目录 `npm i dsh-wangchao@0.3.2` 验收：5 个 `bin/` 文件在包内，`check-locks` 与 `check-host-compat` 的 `--help` 均可运行。
- **桌面重启后实测（2026-11-16 19:49）**：用户重启 DSH（主进程 19:27 启动）后，`desktop-live-state-v2/state.json` 的 `startupReport.error` 消失，改为正常报告（`allowed=31, synced=10, deferred=1, failed=0, indexSource=single-listing(persisted=744,live=0), durationMs=12290`）；`pollCount` 从冻结的 4515 增长到 4598，`lastPollReport` 时间 19:49:21、`reason=timer`、`synced=10`，`stateLoadIssue=null`。P3 采集断裂确认已修复。
- **待用户实测**：引用卡片「定位」按钮在真实界面跳到宿主会话对应行并高亮；助手/流式事件提示「定位到所在轮次」。这两项依赖宿主聊天行的 `data-chat-*` 属性，只有隔离假 DOM 验证，真实桌面需点一次确认。

### B2 隔离 rc.3 真页面 CDP 实点（2026-11-16 晚）

桌面本身没有摘要版本（`allowManualSummary` 未开），无法在真实桌面点定位；按用户选择用隔离 rc.3 宿主 + 假 provider + 合成授权会话做真页面 CDP 验证，不打开桌面真实摘要。全部证据在 `_leader-probe\b2-cdp-20261116`：`REPORT.md`（单点定位）、`REPORT-B2FINISH.md`（区间/records/缺陷补丁）。

**已实测通过**：

- 真宿主原生 DOM：点摘要里的 `[9]` → `/refs` 返回 `anchor={kind:'message',id:559d7b41…}`；打开会话后宿主原生行 `data-chat-anchor-key='13:input-message559d7b41…'` 与该 id 完全一致，`scrollIntoView`+描边高亮命中，1.6s 后自动消退。没有注入 DOM，未发真实模型请求。
- 区间引用与逐条发送记录：合成夹具 `[9-11]` 在真页面点开，`/refs(9,11)` 返回 `sentEvidence=records`，seq 9/10/11 的 `sentConfirmed=true`、`sentKind=full/partial/full`，上下文 seq 7/8/12/13 为 false。正文仍 `bodyReturned=false`。
- 伪造与撤权：非引用区间 `[9]`/`[10-11]` → 400 `not-a-citation`；跨度 `[1-45]` → 400 `span-too-large`；精确撤权回读 `allowSessions` 不含该 SID 后，`/refs`、`/summaries` 均 `allowed=false,status=revoked` 且无 events/versions。

**独立复核发现的两个残留风险（用户决定保留现状、记录不修）**：

1. **跨会话归属**：客户端 `locateInHost` 在 `openSession` 后从整个 `[data-conversation-scroll]` 找锚点；message 用完整 id 尾匹配（跨会话碰撞概率低），turn 只按数字匹配（跨会话必然重复）。没有公开可靠的"当前宿主 DOM 属于目标 sid"API；turn 级跨会话错跳只在源码层可构造，本轮假摘要只引用 user/message，未触发。撤权后 pending 定位：撤权完成时约 120ms 目标行仍 `outlined=true`，但无法确定高亮开始于撤权完成前还是后；静态缺少 generation/abort，不能声称已取消。
2. **`summaryVersionId` 未关联 run**：实际摘要完成后只把版本 id 写进 `result`，没写回 `summaryRuns[].applied`；而 `/refs` 用 `appliedRun.summaryVersionId === version.id` 找逐条记录，导致盘上 records 齐全也降级成 `seqs-only`。隔离副本补丁（finishRun applied 分支写回 `summaryVersionId`）经假模型正常流程验证可让 `/refs` 自动变 `records`，34/34 单测通过；未合并到生产树。

用户明确选择：**保留 0.3.2 的自动高亮行为，把上述未覆盖风险记入文档，不发新版本、不合并实验补丁**。`leader` 与发布仓工作区保持干净（`35cc786` / `a47f0a7`），本轮所有修复草稿已撤回，隔离进程和端口已清理。

### 都察院只读版合入 leader（2026-11-17）

更正上一段：`summaryVersionId` 修复随后按用户新指令合入（见下）。

都察院自动冻结版经多轮独立审查与真机 CDP 验证，暴露 B1–B4 四个阻断（陈旧越权探针、append-only 历史违规无豁免→永久冻结、异常冻结未 pause→烧任务、execGate 初始化失败 fail-open）。用户选择**降级为只读巡检**，消除整条冻结/恢复状态机：`censorate.mjs` 保留四类不变量审计、零 LLM/零写盘，每采集周期更新内存报告，`/overview` 暴露 code/severity/计数，界面顶部有违规告警条（不阻断操作）；冻结闸、`censorate-release`、state 冻结字段全部移除。隔离 rc.3 真页面 CDP 11 条断言通过；候选 11 个测试文件 + checks 4/4 通过。

按用户「只合并 leader、发布树不动」的指令，将只读版与 `summaryVersionId` 修复合入本目录（`index/client/exec-budget/task-store.mjs` + 新增 `censorate.mjs`、`test/censorate.test.mjs`）。合并后本目录 11 个测试文件 + checks 4/4 通过。**发布仓 `gh-wangchao` 保持 `a47f0a7`（v0.3.2 已发布状态）未动，未推送、未发版、未重启桌面。**

教训：本轮我两次过早宣布「完成」、并把未完成候选误同步进桌面 junction 指向的 `leader` 与发布仓（产生误提交）；已如实汇报、reset 本地历史、只按用户明确指令合并验证过的范围。后续任何合并/发布必须先对齐「验证过哪棵树就只合并哪棵树」，发布树改动必须重新走完整审计。

### v0.3.3 发布（2026-11-18）

更正上一段「发布仓未动」：随后用户明确要求把只读版移植到发布树并完整发布，已在独立副本 `gh-port` 逐项移植（发布树是单体 index，无 state/poll/boundary 分模块，不能整目录复制）。

- 桌面重启后实测：新代码已加载，`startupReport` 无错、`pollCount` 增长、`censorateReport.ok=true/violations=0/unknowns=6`（执行未启用等默认态，正常）；无冻结残留。首辅需重新召见并选模型才能对话，与都察院无关。
- 发布树 `18bc707`：13/13 测试、checks 4/4、净室审计 29 项全过；本地工作区 + 13 提交全历史审计通过；推送 master 后 CI success（44128854032）。手动 clone 远端（HEAD 一致、非浅、13 提交）跑 13/13 + 29 项审计全过；publish-audit 脚本自带二次 clone 瞬时失败，改用已验证 clone 内容复核通过。
- GitHub Release `v0.3.3` 上传 `dsh-wangchao-0.3.3.tgz`（249956 B，SHA256 `509A0BA6…DFCC`）；npm publish 0.3.3，`latest` 指向 0.3.3（`alpha` 仍 0.3.0），shasum `fa3005b1…a23`。临时目录 `npm i dsh-wangchao@0.3.3` 验收：版本正确、`censorate.mjs` 随包发布且可 import。
- 发布树版本号 0.3.3，README/CHANGELOG 写明都察院为只读巡检、不冻结不阻断；`leader` 与发布仓内容同源（同名文件哈希一致）。桌面仍是 23:38 启动的进程，已加载 leader 的只读巡检代码。

### v0.4.0-alpha 隔离开发（2026-11-18，未合并、未发布）

在 `_leader-probe/wc-v040-alpha` 隔离副本开发，正式 `leader` 树与发布仓保持 v0.3.3 不动。

**已完成并验证：**
- `roles.mjs`：`state.roles` 注册表 + `state.chief` 非枚举读写别名，旧 state 自动迁移；`roles.test.mjs` 10/10（含关闭状态不被旧字段复活、JSON 不落 chief）。
- `deliver-dedupe.mjs`：`role/message` 的 clientMessageId 幂等（并发去重、ID 冲突、TTL、上限）；4/4 测试。
- `report-bar.mjs` + `GET /report-bar`：确定性聚合，仅按 `visibleRows()` 实时判权后的会话统计；未知字段给 null；4/4 测试。
- `POST /role/message`：一期只放行 chief，复用 wangchao_chief_append 的守卫路径与 assertValidInject；补观察模式/状态不可用/首辅阻断拒绝。
- 作战台 UI：`client.js` 新增 WarRoom（顶栏报告条 / 左角色项目 / 中简化对话 / 右都察院 / 底四卡），`standalone.html` 默认进作战台，账房可切换保留；`warroom.test.mjs` 3/3 真 mini-react 假 DOM 挂载、切换、发送。
- checks 新增 04-warroom，全套 5 组 38 断言通过；standalone-refs 17/17 无回归。

**补充完成（同日稍后）：**
- `role-stream.mjs` + `GET /role/stream`：用 `ctx.sessionQuery.readSession` 读**当前首辅 sid** 的消息流水（纯函数提取 user/assistant 文本，跳过 brief 注入、截断 2000 字、最近 50 条）。授权严格：只当前 chief + guard 已验证 + live agent 匹配，读前读后复查 sid。这项不进采集范围、不改 state，不违反"首辅会话不进采集"边界。4/4 测试；作战台中栏真机假 DOM 渲染出流水。
- 主窗展开桥：`POST /role/open-in-host` 写 `stateDir/host-nav.json` 一次性指令；主窗 client 20s 轮询 `GET .../pending` 调 `uiWorkspace.openSession`，读后即删，60s 过期丢弃。host-nav 2/2 测试；作战台按钮 5/5 交互测试。
- `warroom.test.mjs` 用真 mini-react 假 DOM 验证默认作战台、账房双向切换、发消息调接口、流水渲染、主窗桥按钮。

**仍未满足：**
- `hanlinDigestAt` 只做字段聚合，翰林院生成逻辑（当天一次、按会话数哈希缓存）未实现；`newSessions` 无可靠来源，返回 null 不编造。
- 桌面端真实窗口未验收（尤其 host-nav 20s 轮询跳转、首辅会话 readSession 的实际文本结构）；未合并到 leader、未进发布树、未发版。

**阶段验证**：10 套测试全过（censorate / deliver-dedupe / host-nav / refs-route / report-bar / role-stream / roles / seq-refs / standalone-refs / warroom），checks 5 组 38 断言全过。

**下一步**：桌面端真窗口验收 v0.4.0-alpha；实现翰林院摘要缓存；再进入 B1–B4。

### v0.4.1 进展与回退（2026-11-18，未合并）

- 完成纯函数模块 `censorate-enforce.mjs`：B4 execGate 三态、B2 ack 水位线（仅按明确 codeScope + 同源水位线 + 完整记录序号豁免）、B3 冻结判定、B1 探针冷却（异常 fail-closed）；`censorate-enforce.test.mjs` 4/4。
- **重要纠错**：B2 初稿允许按时间/任意 id 豁免违规，会把未列入 codeScope 的违规一起豁免，违反路线图；已重写为只豁免指定代码+指定账本+水位线内的完整记录集合，并补反例测试。
- 曾尝试把 B1–B4 直接接进 `runCensorate`，但在没有端到端测试、且探针异常被伪装成"已拒绝"的情况下写入了落盘/pause 逻辑；发现后已**全部回滚** host 接线，`index.mjs` 都察院仍为只读巡检，无残留引用，全量 11 套测试 + 5 组自检通过。
- 结论：B1–B4 的纯逻辑已备，但 host 执法接线（落盘冻结、启动重放、scheduler.pause 双制动、派发/摘要闸口、ack 恢复接口）尚未实现；都察院未恢复执法。
- 追加 `enforceDecision()` 编排纯函数并测试（默认只读不冻结；违规冻结；已冻结保持；ack 后解冻），censorate-enforce 测试 5/5。仍未接 host：当前 `state.censorateReport.findings` 只有 code/severity/detail/ids，没有 source/records，B2 水位线在真实数据上无法作用；强行接线会造成 ack 无效、永久冻结。下一步先让 censorate finding 携带可审计记录元数据，再接 host 执法。
- B2 证据链打通：`censorate.mjs` 的 finding() 增加可选 source/records，attempt-cap-exceeded、settled-no-usd、governance dup/bad-entry 等账本类违规携带全量账本下标作为序号；`index.mjs` 写 state.censorateReport 时保留 source/records。censorate.test 新增"账本 finding 带证据 + ack 水位线豁免"用例，14/14 通过。边界：seq 只在 auditEntries() 全量账本下有效，snapshot() 最近 20 条切片记 entries-truncated unknown，不能当水位线。host 执法接线仍未接。

### v0.4.1 host 执法接线再次回滚（2026-11-18，重要）

曾把 B1–B4 接进 index.mjs（探针、装饰器、冻结落盘、pause/resume、派发/摘要闸口、ack 路由、启动重放），集成测试一度通过，但随后发现三个**结构性**缺陷，全部回滚，index.mjs 恢复只读巡检，已全量验证 11/11 测试 + 5/5 自检：
1. ack 路由先 `delete freeze + persist` 再重跑巡检：两步之间崩溃会丢掉冻结标记，重启重放失效，用户无感知地绕过冻结。必须改成单一原子操作（先在内存判定，最后只写一次盘），或引入两阶段确认。
2. `governance.audit({taskId:null,kind:'pause'})` 会被 governance.mjs 拒绝（要求非空 taskId）。此前用 try/catch 吞掉，等于没有审计。
3. B1 主动探针使用 faux agent `{parentSession:'censorate-probe-parent'}`，未证明会命中真实执行守卫；probeOverreach 异常现在按 allowed:true（触发冻结）处理，但没有真机验证，贸然启用会对正常配置误冻结。

结论：v0.4.1 的纯函数（censorate-enforce.mjs）与 B2 证据链（censorate.mjs finding 带 source/records）保留；host 执法未启用。**不要**再用 try/catch 掩盖审计或落盘失败，也不要在未验证探针身份前接回执法。下一轮前置：先分别验证上述三个原语，再逐条接回。
- 前置原语（可测试，仍未接 host）：① `freezeAuditTaskId()` 通过真实 governance.audit 契约测试（test/freeze-audit.test.mjs 1/1）；② `prepareAckPatch()` 一次原子写同时落 ack 水位线与冻结待复核标记，不再先删标记后重跑（censorate-enforce.test 7/7）；③ 回滚时误删的 B2 证据映射（index.mjs findings 保留 source/records）已恢复。
- 全量：11 套测试 + 5 组自检通过。都察院仍只读，host 执法未启用。
- 纠错（重要）：此前判断"B1 探针 faux 身份未命中执行守卫、会造成假通过"是错的。实测 `isExecChildIdentity({sessionId:'censorate-probe-child',parentSession:'censorate-probe-parent',cwd:null,chiefSessionIds:含父id})` 返回 execChild:true/reason='cwd-unknown-fail-closed'；去掉 chief 注册才失效。用 `session-exec-censorate-probe` 则走 reserved-prefix、稳定命中且不依赖注册。test/probe-identity.test.mjs 2/2。日记中凡说"探针身份未验证/无效"以此条为准。
- **B1 已接入 host（首个真正接线的 v0.4.1 契约）**：runCensorate 用 `probeOverreach` 主动重探，faux 身份 `session-exec-censorate-probe` 命中执行守卫链；拒绝=守卫生效(allowed:false)，放行/异常=违规；冷却 30s，rulesRevision 传 state.rulesRevision。报告带 probe.probedAt/cached/probeError。test/b1-probe-integration.test.mjs 2/2（启动主动重探、冷却内不重复）；14 套测试 + 5 组自检全过。其余 B2/B3/B4 仍只有纯函数，未接 host。
- **B4 已接入巡检报告**：runCensorate 用 execGateState() 判三态；配置声明启用执行但门禁未建/未就绪（如 execMaxTokens 非法）→ budget 快照 ready:false+error → censorate 报 budget.gate-init-failed violation（不再误归"未启用"）；未配置执行仍是 null→unknown 正常态。test/b4-gate-state.test.mjs 2/2（纯函数 + 真 apply 集成）；15 套测试 + 5 组自检全过。
- v0.4.1 当前：B1、B4 已接 host 并集成验证；B2、B3 仍为纯函数（证据链/冻结/审计ID/原子ack补丁），未接执法；都察院仍只读。
- **B2 报告口径已接入（不触发执法）**：巡检报告新增 enforceableViolations（经 ack 水位线过滤后的违规数）与 ackApplied；原始 violations/findings 全量保留供排障，不静默清历史。test/b2-report.test.mjs 1/1；另加 b3-freeze-scope.test.mjs 3/3 确认契约类违规/B4 init-failed 不可被 ack 豁免（安全边界）。17 套测试 + 5 组自检全过。
- v0.4.1 当前：B1（主动探针）、B4（三态）、B2（报告豁免口径）已接 host；B3 全链路（落盘冻结 + scheduler.pause 双制动 + 启动重放 + ack 恢复接口）仍未接，都察院仍只读。

### v0.4.1 B3 全链路已接入 host（2026-11-18）

前几轮反复回滚后，本轮用"先写失败测试再接线"完成 B3：
- 执法显式开关 `cfg.censorateEnforce === true`，默认只读不变。
- 冻结顺序按路线图：① persistState 原子写 `state.censorateFreeze`；② `taskScheduler.pause(reason)`；③ `governance.audit({taskId: freezeAuditTaskId(), kind:'pause'})`。落盘/审计失败如实记录到报告（freezePersistError/freezeAuditError），不吞错；落盘失败仍紧急 pause。
- 启动重放：读到持久化冻结即 pause，且普通巡检 `allowUnfreeze:false` 不会撤销（专门回归测试 b3-no-auto-unfreeze 1/1）。
- ack 路由 `POST /censorate/ack`：严格校验 codeScope/ackBefore/reason → `prepareAckPatch` 一次原子写（水位线+待复核，冻结不删）→ `runCensorate({allowUnfreeze:true})` 重跑 → 仍有未豁免违规返回 409 保持冻结；无违规则清标记+第二次原子写+resume。写失败恢复冻结内存态，不 resume。
- 派发/摘要闸口：`freezeAllows` 阻断新任务派发与真实摘要（dryRun 预览不阻断），首辅只读对话不受影响。
- 集成测试：b3-enforcement-integration 3/3（启动重放、init-failed 冻结落盘+pause、ack 原子恢复含参数非法不清冻结）+ b3-no-auto-unfreeze 1/1。全量 19 套测试 + 5 组自检通过。

v0.4.1 至此 B1–B4 全部接入 host 并有集成测试；执法默认关闭（censorateEnforce），桌面真实环境验收未做，未合并 leader、未发布。
- **安全漏洞修复（ack 水位线越界）**：ack 路由原接受任意 seq（如 999999），会提前豁免未来所有账本记录，解冻后未来违规也不冻结，违背 B2。新增 `validateAckWatermark()`：source 必须是已知账本（exec-budget/governance）、seq≤当前账本末尾（数组下标，与 censorate 证据同口径）；账本读不出则 fail-closed 拒绝 ack。tests: censorate-enforce 8/8、b3-enforcement-integration 3/3（含超大 seq 被拒）。20 套测试 + 5 组自检全过。
- v0.4.1 边界核实：默认 censorateEnforce 关闭时 init-failed 不冻结/不落盘/不 pause、violation 仍显示、ack 路由 409（test/readonly-default 1/1）；派发闸口在 runExecutionTask，摘要闸口在 summaryToolDefinition.execute（summary-controlled confirm 经此路径）；任务确认改状态但 scheduler.pause 阻断补位，符合"只冻新派发"。

### 独立审查发现并修复（2026-11-18 深夜）

子代理只读审查发现两个真实缺陷，均已修复并验证：
1. B1 探针异常被缓存 30s（censorate-enforce fresh 判定未排除 probeError）：HMR/宿主瞬时故障后守卫已恢复，ack 重跑仍复用异常结果，30s 内 100% 409；异常持续则永久不可恢复。修复：异常结果不缓存，下一轮必重探；host 把 checkGuards 缺失/异常改为 throw（由 probeOverreach 记为 probeError），不再返回 allowed:true 伪装成越权放行。新增纯函数测试与 b1-probe-integration 第 3 条（异常不缓存，3/3）。
2. ack 409 无诊断：现在返回 remainingCodes 与 probeError，明确区分"非账本违规需修复根因"与"探针异常"。
另补 ack 写盘失败故障注入（monkey-patch fs.renameSync 注入失败）：旧水位线与冻结标记保留、scheduler 仍暂停，b3-enforcement-integration 5/5。
全量 20 套测试 + 5 组自检通过。

未修限制（如实记录）：探针 faux 身份无任务根，守卫拒绝来自"无法确认任务隔离根"而非白名单判定；即探针只证明守卫在场且 fail-closed，不覆盖白名单/路径约束损坏的假阴性。要覆盖需给探针分配真实任务根并进入 decideExecToolCall 分支。
- **修复 B1 探针假阴性（子代理审查缺陷2）**：旧探针 faux 未登记任务根，守卫在"无法确认任务隔离根"就 fail-closed，白名单损坏也测不出。现探针临时登记 session-exec-censorate-probe + taskDirFor(execWorkspaceRoot,'censorate-probe')，同步 try/finally 清理，进入 decideExecToolCall 白名单分支；检查项扩为越权 write 被拒+安全 read 放行+白名单外工具(pwsh)被拒。执行未配置(execPolicyRes.ok=false)时探针不适用→overreachCalls=null→censorate unknown，不误冻（符合 B4 unconfigured）。b1-probe-integration 4/4，新增"白名单损坏被检出"回归。全量 20 套测试 + 5 组自检通过。子代理三大疑点至此全部处理（缺陷1 异常缓存、缺陷2 检测面、缺陷3 409 诊断）。

### 最终状态更正（2026-11-19，以本节为准）

前面几节有两处过时表述，在此更正：
1. "v0.4.1 未合并 leader" 已不成立 —— 已合并并提交。
2. "子代理三大疑点全部处理" 之后又做了第二波独立审查，发现 3 个更严重的缺陷（下文已修）。

**第二波审查修复（提交 88750ab）**：
- P0-1 init-failed 冻结在空账本时无法恢复：新增 noLedger ack，配置修复重启后可恢复。
- P0-2 单条 ack 覆盖导致多来源账本违规无法分别豁免：censorateAck 升级为 watermarks 多来源表，追加不覆盖。
- P1 探针冷却窗口内守卫失效 fail-open：移除缓存，每轮真探。
- 附带：ack 重校验冻结状态、probeError 阻断解冻、水位线满拒绝丢弃旧确认。
- 23 套测试 + 6 组自检通过。

**诊断接线（提交 5e0b10e）**：v0.4.2 授权判定与翰林院缓存骨架接入 wangchao_exec_policy 只读诊断，不再是死代码；不改执行行为，免确认默认禁用（fail-closed）。24 套测试 + 6 组自检通过。

**master 提交序列**：5be2906（v0.4.0-alpha + v0.4.1 主体）→ c1edca0（翰林院确定性部分）→ 88750ab（审查 P0-1/P0-2/P1 修复）→ 5e0b10e（诊断接线）。工作树干净，未发布。

**真机现状**：desktop profile 的 dsh-wangchao 是 junction 指向 leader，磁盘代码已是最新；但当前 DSH 进程（22:05/22:08 启动）早于今日修改，运行中的仍是旧代码，需用户重启 DSH 才能加载。默认 stateDir ~/.dsh/wangchao 不存在，说明桌面实例可能未激活或用了自定义配置；真机验收需用户重启后确认。

---

### v0.5.0-alpha.4 发布与真机接入（2026-11-24 晚 ~ 11-25）

**alpha.4 发布验收**
- 翰林院成功路径补 governance outcome 审计（generated/reused 区分；审计失败 500 audit-failed，不写缓存、不返回正文、不重试）。仅 fake provider 验证（3 例），alpha.3 的两次真实调用早于该修复。
- Writer Fencing 恢复契约复核：`writer-epoch.json` 是跨进程 epoch 权威，正常交接 `epoch+1` 先落盘再释放锁；异常退出保留。**恢复只删 `exec-budget.lock`，保留 epoch 文件**（此前"连 epoch 一起删"的做法已废弃，会导致 epoch 回退）。合成目录实测链 `1→2→2→2→2→3→4`，旧写者写入报 `STALE_WRITER`，历史账本/审计/摘要/任务哈希前后一致。
- 发布物：`dsh-wangchao-0.5.0-alpha.4-limited-ai.tgz`（336,576 B，SHA256 `AA6AB38A…`）；候选晋升至 alpha.4 时仅 index.mjs + package.json 变化。

**生产插件升级（alpha.4.1）**
- 凭据改走 DSH credentials 服务：`real-model-readiness.mjs` 增加 `DEFAULT_CREDENTIAL_REF='DEEPSEEK_API_KEY'` 与 `credentialState` 入参；`index.mjs` 新增 `probeCredential()`，优先 `ctx.get('credentials').resolve()`，失败回落环境变量，resolve 异常按不可用（fail-closed）。生产 `.credentials.yaml` 里确有 `refs.DEEPSEEK_API_KEY`，因此无需再注入环境变量。
- 版本 `0.5.0-alpha.4.1`；生产 `leader` 由 0.3.1 升级（覆盖 10 + 新增 12，24 个旧测试/文档保留未删），回滚备份 `_t5\leader-backup-20261124-224631`。

**采集规则的核心缺陷（11-25 修复）**
- 症状：改 profile 的 `allowCwds` 完全无效，851 个会话里 831 个 `denied-by-default`，当前会话永远采不到。
- 真因：`state.mjs` 里规则是二选一——`state.rulesOverride ? override : config`。面板保存过一次规则后，配置文件永久失效；而 override 的 `allowCwds` 是空数组。
- 修复：改为按字段合并——override 非空字段优先，**空数组视为未设置、回落配置文件基线**（`baseRules`/`overRules`）。
- 过程教训：运行中的插件内存持有旧 rules，**直接改 state.json 会在 8 秒内被回写覆盖**（实测两次），必须改代码或停机改。

**启动性能**
- 实测启动轮 200 个会话耗时 **197 秒**（`durationMs:197175`），索引扫描仅 440 ms，瓶颈是逐会话同步（约 1 秒/个）；5 秒轮询 < 单轮 12 秒，长期重叠跑。
- 改为启动轮 `poll('startup',{limit:20})`（约 20 秒）、轮询间隔 15000 ms。异步化方案试过会破坏 b6-recovery 的时序断言（apply 末尾写盘先于 poll），已回退为同步。

**UI 收敛（client.js）**
- 删除双视图 `standaloneMode` 与"切换到内阁账房"，收敛为单一视图；标题最终为「御书房」。
- 采集台账从底部卡片移到顶栏按钮（底部 6 卡挤两行被视口裁掉），抽屉内复用 `buildSessionsSection`，点行经 `onOpenSession` 打开会话详情抽屉（引用核对/定位/修订，原挂在 ledger 里，删除时一度丢失，已接回）。
- 补"采集范围"入口（原也只在 ledger 顶栏，删视图后用户无法改规则）；`onOpenScope` 接 `openScopeDrawer`。
- 响应式：`.wc-grid` / `.wc-bottom` 加 1180px、760px 断点；`.wc-layout` 高度链（`height:100%` + `.wc-main-fill`）让三栏随窗口伸缩、底部卡片固定可见。
- 显示层全中文化：新增 `FACT_KIND_LABELS` / `FACT_STATUS_LABELS` / `LINK_STATUS_LABELS` / `REMINDER_STATUS_LABELS` / `PROJECT_LIFECYCLE_LABELS` / `SYNC_STATE_LABELS` 及对应 label 函数；`coverageText`、`changeKindLabel` 去混排；`state 记录`→`本地状态记录`、`cwd`→`工作目录`、`seq`→`序号`、`default`→`默认`。技术码（guard.exec-boundary 等）、数据 id、HTTP 状态码按原样保留。

**脚本编码坑（第三次）**
- `.cmd` 写中文 → cmd.exe 按 GBK 解析 UTF-8，命令被拆碎；`.ps1` 无 BOM → PowerShell 5.1 按 ANSI 解析，报"缺少 }"。
- 规则已固化：`.ps1` 一律 UTF-8 with BOM；`.cmd` 纯 ASCII + GBK936 + CRLF；交付前用 5.1 与 7 各 `Parser::ParseFile` 校验。
- 新增 `B:\DSH\Agent\clear-wangchao-lock.cmd/.ps1`：退出 DSH 后双击清残留写锁（pid 存活则拒绝，只删锁不动 epoch）。

**当前未解决**
- 真实模型仍调不通：翰林院报 `未注册 provider adapter "deepseek-official"`，生产 desktop profile 未加载 DeepSeek provider bundle（alpha.3 的隔离 profile 里有，生产没有）。`hanlinDigestEnabled` / `chiefAnalysisEnabled` / `chiefCwd: B:\DSH` 已配好，但 provider 缺失导致请求发不出去。
- 预算门禁初始化会因残留 `exec-budget.lock` 失败（`budget.gate-init-failed`），每次重启前需清锁。
- 真实 Executor、自动审批、都察院越权探针仍冻结（`execLifecycleVerified` 无赋值入口）。

**生产当前哈希（2026-11-25 20:09 快照 `_t5\leader-snapshot-20261125-200952`）**
- index.mjs `6753C3AFCDFCA800…`、client.js `0BD35F82BC970D29…`、state.mjs `5A5CE3911DDA171D…`、poll.mjs `CEBD9012935D66A9…`、package.json `2654404BFB37A879…`（版本 0.5.0-alpha.4.1）
### 合并 AP-IMPL-01（Gemini）候选（2026-11-25 晚）

- 先提交本人当日改动：`8ac0a19`（67 文件，+11516/−332），此前 leader 自 11-19 起有 68 个未提交变更。
- 合并前核对：Gemini 候选基线 = leader@73f5d1a 工作区，其 4 个修改文件（project-facts/store/http-adapter/routes）在生产当前哈希与其基线逐个一致 → 干净叠加，**零文件冲突**（与本日改动的 index/client/state/poll/checks/测试无交集）。生产目录在合并前未被它改动（23 文件哈希与 20:09 快照一致）。
- 合入 8 个文件：4 改 + 新增 `idea-capture.mjs` / `research-search.mjs` / `recovery-pack.mjs` / `session-lineage.mjs` + `test/rrp-mvp-01.test.mjs`。
- `client.js` 补 RRP 新枚举中文化：`hypothesis/user_stance/dead_end/open_question`、`CLAIM_KINDS`（用户声明/模型推断/证据支撑）、`stage`（火花/探索中/已验证/已确立）、`entityType`（灵感/研究/项目）、`lifecycleEvents`（搁置/重燃/恢复/阶段变更）。
- 回归：checks 6/6（45 断言）、rrp-mvp-01 8/8、`test/*.test.mjs` 222 pass、根级 133/133、warroom 7/7、standalone-refs 17/17。
- 未接 UI 的部分（Gemini 亦如实标注）：research stage / 锁定事实 / 恢复包"生成-复制"按钮、灵感收件箱面板——仅纯函数与只读 HTTP 路由就绪；`client.js` 交接面待定归属。
### 陈旧写锁自动接管（2026-11-25 晚）

- 问题：DSH 关窗口/被结束进程时给不了 cordis 卸载机会，`exec-budget.lock` 必留；旧契约"锁存在即拒绝、不自动接管"导致**每次重启都要人工清锁**。
- 契约变更：`acquireLock` 遇 EEXIST 时先探测持锁 pid——`process.kill(pid,0)` 返回 ESRCH 才判定写者已退出并接管；**只删锁**，`writer-epoch.json` 与账本一概不动（epoch 继续单调）；接管写审计 `exec-budget-lock-recovery.jsonl`（action/deadPid/原锁内容）。
- 仍 fail-closed 的情形：写者存活、锁内容不可解析、pid 不可确认、锁被本进程持有、删除失败。
- 测试：F4 拆为三例（陈旧锁接管+审计+epoch 沿用、存活写者拒绝且锁不删、不可解析拒绝），W22 由"退出后仍拒绝"改为"退出后被安全接管"，fence 37/37、根级 135/135、checks 6/6、test 222 pass。
- `clear-wangchao-lock.cmd` 保留，仅用于锁内容损坏等插件无法自行确认的极端情形。
### 真实模型首次调通与两个阻断修复（2026-11-25 晚）

- **真实调用已打通**：20:32 一次翰林院摘要请求在 `exec-budget.json` 记 `settled`，`actualUsd=0.000342`，`usage: input 115 / output 256`。此前"未注册 provider adapter"与 API key 失效（401）两处已先后修掉。
- 但该次输出 256 token 全是思考块：`deepseek-flash` 默认 `reasoningEffort=high`，正文为空 → runner 抛"模型未返回正文文本"。已在 profile 的 `llm-deepseek` entry 加 `thinking: disabled`（该线路只服务插件小请求）。实测对照：思考开 output 94（含正文 38 字），思考关 output 18（正文 33 字）。
- **总上限硬编码**：`MAX_TOTAL_TRIAL_REQUESTS = 2` 是 alpha.2 试验期边界，两条记录即用满，之后一律 403。现在 `createExecGateWiring` 的 `maxTotalTrialRequests` 由 `cfg.maxTotalTrialRequests` 透传（缺省仍为 2，保持测试语义），生产 profile 显式设 `100`。真正的费用闸门仍是 `budgetLimitUsd: 0.05` + `budgetSingleUsd: 0.01` + unknown 阻断。
- 错误文案修正：「假模型未返回文本」→「模型未返回正文文本（provider=…）」，原文案在真实调用失败时显示"假模型"，误导排查方向。
- 手工清账本的教训：上一轮把 unknown 改 settled 时漏了 `usage` 字段，导致账本校验失败、门禁 init-failed；验证时又用 `reserve()` 直接写生产账本留下残留条（被重启转 unknown 再次阻断）。**改账本必须补齐校验字段，验证只能用副本目录。**
- 首辅对话报"会话不可用或已被阻断"属正常：`state.chief.sessionId` 为空，需先在左栏召见首辅。
### 闸门配置链与巡检口径对齐（2026-11-25 深夜）

- **attempt 上限按日重置**（`3f4bcf4`）：`MAX_ATTEMPTS_PER_CHILD=2` 按 `childId` 永久累计，而翰林固定 `childId=hanlin-digest`，一生只能跑 2 次。改为只统计当日记录，新增 `maxAttemptsPerChild` 配置（缺省 2，生产 10）。新增 E1b（昨日不占今日名额）、E1c（可配置）两例。
- **gate 未透传（假修复）**（`fa99afb`）：上一轮把 `cfg.maxAttemptsPerChild` 传给了 `createExecGateWiring`，但 `exec-gate-wiring.mjs:505` 打开账本时没往下传，账本仍用默认 2。截图里"当日 attempt 已达上限 **2**"（不是 10）就是证据。`snapshot()` 原本还把该值硬编码成常量，诊断信息同样骗人。
- **巡检口径对齐**（`c108423`）：都察院 `budget.attempt-cap-exceeded` 原硬编码 `>2` 且统计全部历史，在账本改成"每日上限 + 自然日重置"后把 3 条合法记录判成违规。改为读 `budgetTask.maxAttemptsPerChild`（缺省 2）+ 只算当日，`createdAt` 由 index 透传。真实账本验证：3 条 hanlin-digest + 上限 10 → 违规 0。

### 首辅召见与对话体验（2026-11-25 深夜）

- **召见入口丢失**（`6d1e13f`）：召见按钮原在旧 ledger 侧栏 `chiefCard`，收敛单视图时那条分支不再渲染，左栏只剩只读 `roleSeats`，用户无任何途径召见。已在 `left` 的 roleSeats 之后补「内阁首辅」操作卡（状态/阻断原因/召见按钮），View 通过 `onSummonChief` 传入 `summonChief`。
- **重启后必须重新召见**：`chiefBlockOf` 第 3988 行 `if (chiefAgent === null || chiefReadonlyOk !== true) → guard-not-installed`。只读守卫是 agent 作用域、`chiefAgent` 是进程内变量，DSH 重启后消失，而持久化的 `roles.chief.open` 仍为 true → "看起来已召见、实际发不出去"。这是刻意的 fail-closed，不是缺陷；但需要 UI 明示（左栏卡会显示 `发送已禁用：本进程尚未重新召见并验证只读守卫`）。
- **对话区体验**：全部历史堆在中栏把输入框顶到很下面（`ef027a6`）。改为 `.wc-msg` `max-height:42vh` 内部滚动、只渲染最近 40 条并提示折叠数量、`msgRef`+`useEffect` 自动滚到最新（`71c67a7`，effect 必须放在 `messages/sendMsg` 声明之后，否则 TDZ）。

### 奏折 UI 两次失败与回滚（2026-11-25 深夜）

- **第一错：数据源取错**（`9c0a930`）。`details.hanlin` 在 `/api/dsh-wangchao/report-bar` 响应里，`/overview` 没有 `details`。按钮条件写成 `ov.details.hanlin.digest` → 恒假 → 按钮永不出现。
- **第二错：作用域与 hooks 位置**（`12f80a9` → 回滚 `4e6d36c`）。抽屉渲染在 View 作用域，`bar` 是 WarRoom 的 state → `ReferenceError`；同时 `useState`/`useEffect` 被插在 View 函数体中部（第 4158 行，前面有条件返回）→ hooks 顺序违规 → **整个御书房白屏**。
- 处理：全部撤掉（按钮/抽屉分支/hanlinSection/相关 state+effect），标题恢复原样。后端 `overview`/`report-bar` 的 `digest`/`digestSource`/`digestModel` 字段保留，后续重做直接复用。
- 重做规矩：奏折正文应在**翰林卡片内部展开**（WarRoom 作用域内就有 `bar`），不要走抽屉、不要跨组件取数、hooks 只放在组件顶部。

### 本次教训（必须记住的错）

1. **查 state 用错字段**：`state.chief` 是 `roles.chief` 的**非枚举别名**（`state.mjs:44` `Object.defineProperty`），`JSON.stringify` 不输出它。我据此两次误判"未召见/未持久化"，真实数据在 `roles.chief` 且一直是 `open: true`。读持久化状态前先确认字段是否可枚举。
2. **改配置必须验证"最后一跳"**：`maxTotalTrialRequests` 和 `maxAttemptsPerChild` 都出现过"index 传了、gate 没往下传"，配置形同虚设。验证方式是打印实际生效值（`gate.snapshot()`），不是看代码传参。
3. **验证脚本不许写生产账本**：用 `reserve()` 在生产账本上试跑，留下 `reserved` 残留（被重启转 unknown 再次阻断），且 `attemptId` 由内部生成、按前缀清理无效。只读验证用副本目录。
4. **UI 改动先小步验证**：这次连续两处运行期错误（未定义变量 + hooks 顺序）都没有被 `node --check` 和现有测试覆盖到，因为测试不渲染抽屉。加 UI 前先确认作用域与 hooks 位置，必要时补一个渲染测试。
5. **用户厌倦重启**：UI 改动必须攒成一批再让用户重启，不能"发现一个改一个"。

### 待办（下一次开工）

- 奏折正文：按上述规矩在翰林卡片内展开，一次做对并补渲染测试。
- 首辅内联对话：用户明确不要"召见后跳回原生会话"（`summonChief` 里的 `ws.openSession(sid)`），中栏也不该是会话流水查看器（当前 `/role/stream` 返回原始事件流，含历史对话）。需先实测"后台 agent 不打开会话能否装守卫并发送"，再决定是否去掉跳转。
- 首辅卡文案与职责说明：让用户一眼看清首辅＝只读参谋（巡查/提案/问答），不是执行者。

### 御书房最终收口与奏折卡片内联重做（2026-11-25 23:47）

- **后端收口**（`role-stream.mjs`、`index.mjs`）：
  - 新增 `roleStreamWindow(events, { limit, sinceSeq })`，`GET /api/dsh-wangchao/role/stream` 支持 `?sinceSeq=<n>` 并返回 `totalCount / hiddenCount / latestSeq`。
  - `POST /api/dsh-wangchao/chief`：`action:'summon'` 额外返回 `summonedAtSeq`，新增 `action:'fresh'`（退休旧首辅并新建干净会话，`summonedAtSeq:-1`）。
- **前端收口**（`client.js`）：
  - DSH 完成召见不跳转（删自动 `ws.openSession`）、首辅卡就地激活/新开议事、只看本次对话（`sinceSeq` + 历史折叠 + 自适应短轮询）、中栏 Flex 沉底 + `[seq]` 朱批锚点 + `/work` 提案卡、左栏检索框去折行、右栏 `[未知]` 柔化不造假。
  - **奏折卡片内联展开**：严格按上述规矩在 `WarRoom` 顶部声明 `hanlinOpen` state、直接在「翰林院奏折」卡片内联展开/收起 `barHanlin.digest`（不走 `View` 抽屉、不跨组件取数），并在 `test/warroom.test.mjs` 补齐真实渲染断言（8/8 通过）。
- **合并全量验证**：`node --check client.js`、`checks/all.mjs`（6/6 组、45 断言、`bundleHash=f3055b485c9797f1`、无 CRLF）与 8 份测试文件（`warroom` 8/8、`project-ui-final` 6/6、`role-stream-window` 2/2、`rrp-mvp-01` 9/9、`project-http-routes` 13/13、`project-store` 15/15、`project-facts` 22/22、`chief-project-tools` 9/9）全部通过。

### 公开发布与市场收录（2026-11-26）

**发布前清理**
- 审计首轮 114 处命中：`DEVELOPMENT-DIARY.md` 含本机路径/用户名/邮箱，`OBSERVE-*`、`ROADMAP-*` 等内部文档含盘符路径，测试夹具含伪凭证形态，Git 历史含旧提交邮箱。
- 处理：不在旧提交上覆盖（那只是把脏内容再推进一格），直接 orphan 单提交 `225fc05`；删本地旧 master/分支/tag，只保留一个提交。旧历史完整备份为 `B:\DSH\Agent\_publish-backups\dsh-wangchao-before-clean-20261126-002413.bundle`。
- 公开树只保留运行时源码、`README.md` / `README.en.md`、`LICENSE`、`CHANGELOG.md`、`package.json`、`cordis.patch.yml` 和三张预览图；内部日记、roadmap、测试/夹具、checks 不进入公开树与 npm 包。
- 两处审计误报显式豁免并人工确认：`task-store-unavailable` 被 `sk-` 规则命中；`env.LOCALAPPDATA` 是 Windows Chrome 路径探测。

**GitHub**
- 远端原为 PUBLIC，不能先用 private 缓冲；先删远端旧 tag（`v0.1.0-alpha.1` 至 `v0.3.3`），否则旧历史仍会被 `git log --all` 扫出，再 force push 单提交。
- 远端克隆复核：工作区、全历史、HEAD 比对全绿。
- About 改为说人话；Release `v0.5.0-alpha.4.1` 标为 Latest；补 `LICENSE` 与预构建 tarball 资产。
- README 图片首次未进提交：`.gitignore` 的 `*.png` 把 `promo-screenshots/*.png` 一起挡住。补 `!promo-screenshots/*.png` 例外后 `c8a2609` 补传，raw 地址复核为 `200 image/png`。

**npm**
- `private:false`，补 `files` 白名单、repository/homepage/bugs/author/license/keywords；移除引用未发布 checks/test 的 scripts。
- 发布 `dsh-wangchao@0.5.0-alpha.4.1`，先走 `alpha` tag；后因市场安装优先 npm `latest`，把 `latest` 也指到该版本，避免市场装回 `0.3.3`。
- 包内容 52 文件、357.9 kB；下载 tarball 核对，无内部文档、测试、夹具。
- npm 发布返回 `+ name@version` 不等于立即可见；用带 cache-bust 的 registry 查询确认版本、tarball 与 dist-tags。

**dsh-market 收录**
- 纠正流程：`dsh-market` 本身是市场应用，不收插件条目；收录入口是 `awesome-dsh-plugin` 的 `data/plugins/<owner>__<repo>.yml` PR。
- 基于 upstream `main` `5712c57` 新建 `add-dsh-wangchao`，只加 `MacilyDots__dsh-wangchao.yml`（`workflow` 分类，tarball 指向 GitHub Release）。
- PR #18868 已合并；`plugins.json` 与生成的 README 均已出现该条目，市场详情页显示 0.5.0。
- 首次贡献 PR 检查约 45 分钟；`READMEs match data/plugins`、awesome-lint、probe tests、build 全过。

**本次教训**
1. 公开发布不要沿用旧历史：只看 HEAD 会漏掉旧邮箱、旧文档和测试夹具；orphan 单提交 + 删远端旧 tag 才彻底。
2. `.gitignore` 的 `*.png` 会把 README 截图一起挡住；图片要 `git add -f` 或加例外，并从 raw 地址复核。
3. 市场收录不是改市场仓库；先确认目录源与安装优先级（npm > tarball > 源码）。
4. npm 发布成功提示不等于立即可见；以 registry 产物和 tarball 能否下载为准。

**验证**
- `node --check client.js`；`checks/all.mjs` 6/6 组、45 断言；`warroom` 10/10、`project-ui-final` 6/6。
- `publish-audit.ps1` 本地工作区、npm pack 清单、本地全历史、远端克隆工作区、远端全历史、HEAD 比对全部通过。
