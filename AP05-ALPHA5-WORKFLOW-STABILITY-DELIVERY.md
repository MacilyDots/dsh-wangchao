# AP-05 交付报告：v0.5.0-alpha.5 用户体验、研究工作流与运行稳定性

**日期**：2026-11-26
**执行**：DSH（独立开发树）
**状态**：候选完成，未发布、未触碰生产

---

## 1. 开发基线及工作树

| 项 | 值 |
|---|---|
| 生产目录 | `B:\DSH\Agent\leader`（HEAD `c8a260968471d3ae45a66d4791d3621569882ff5`，公开版本 0.5.0-alpha.4.1） |
| 开发工作树 | `B:\DSH\Agent\_t5\alpha5-workflow-stability`（从生产目录完整复制，含未提交修复与测试；排除 `_tmp-tests`、`.tmp`） |
| 开发分支 | `ap05/alpha5-workflow-stability` |
| 基线快照 | `4031234`（生产 alpha.4.1 + RRP 后端 + 未提交修复的完整快照） |
| 代码固定 HEAD | `58a01a3fd69296930cb69d4bbf279881bbf83995`（交付报告提交紧随其后，见交付消息） |
| 版本 | `package.json` → `0.5.0-alpha.5` |

生产目录核查：HEAD 未变，27 个既有未提交改动未动（与开工时一致），关键文件 SHA-256 前缀与开工时相同（`index.mjs C145A22A`、`client.js 9CC57A23`、`state.mjs 1F69C55A`、`package.json 01B63C8F`）。本工作包未写入生产目录、未重启生产、未改账本。

## 2. 安全契约复核与修复

### P0-1 采集规则合并语义

**结论：原实现确有缺陷，已修复。**

原实现 `state.mjs` 用 `override[k].length > 0 ? override[k] : base[k]` 判断，导致：

- 面板显式清空 `allowCwds` / `allowSessions` 在重启后被配置基线重新放行；
- 任何一次保存都把当时生效的基线固化进 override，后续改配置文件永久失效；
- 轮询域在创建时按值捕获 `rules`，面板收紧规则后仍按旧授权读取并写盘（子代理纯内存复现：规则改成只允许 s2 后，轮询仍读 s1）。

修复（`state.mjs`、`index.mjs`、`poll.mjs`、`client.js`）：

1. 新增 `mergeRules(base, override, format)` 三态：字段缺失＝继承；显式空数组＝空授权集；非空＝覆盖。
2. `state.rulesOverrideFormat = 2` 显式格式标记；`saveRules` 只写调用方给出的字段（稀疏 override），不再固化基线；`resetRules` 删除 override 与格式标记（恢复默认不靠空数组表达）。
3. 旧格式迁移 `migrateRuleOverride`：按 fail-closed 把旧空数组保留为显式空集，打 `rulesMigratedAt` 留痕，不扩大授权范围。
4. 非法格式/字段类型按状态损坏 fail-closed（`validateStateShape`）。
5. `poll.mjs` 改为 `rulesNow()` 每次判权读取当前规则；`index.mjs` 注入 getter。
6. UI 文案明确「留空并保存＝明确不授权」「恢复配置文件基线＝删除面板覆盖」，并对显式空字段给出警告。

定向测试：`test/rules-merge.test.mjs`（12）、`test/rules-e2e.test.mjs`（3，含 POST→state→重启→轮询实时判权）。均通过。

### P0-2 陈旧写锁自动接管安全性

**结论：原接管路径存在真实竞态，已做最小范围加固。**

原实现：读锁 → `kill(pid,0)` ESRCH → 写审计（失败吞掉）→ 按路径 `rmSync` → `wx` 重建锁。问题：删除无身份校验（可删掉竞争者刚建的新锁）、两个进程可同时接管、审计失败 fail-open、接管不推进 epoch、旧写者不回读磁盘身份。

修复（`writer-epoch-fencing.mjs`）：

1. **原子认领**：`rename(lockPath → exec-budget.lock.takeover-<uuid>.quarantine)`；同目录 rename 原子，只有一个竞争者能成功；删除只针对自己隔离出来的文件，绝不按路径盲删。
2. **身份复核**：读回隔离文件与首读原文逐字比对，不一致说明判定期间锁被替换 → 放回并拒绝（ABA）。
3. **二次进程探测**：隔离后再探 PID；存活即恢复原锁并拒绝。
4. **审计 fail-closed**：先写 `takeover-stale-lock` 审计（含 deadPid/previousEpoch/nextEpoch/legacyLock），写入失败恢复原锁、拒绝接管。
5. **epoch 单调**：接管时 `epoch+1` 落盘；失败恢复原锁。新锁带 `epoch` 与 `v:2`。
6. **写前 fencing**：`assertWritable()` / `handoff()` 回读锁 token/pid，失配 → `LOCK_STOLEN` + fail-closed，旧写者无法继续写账本。
7. 新锁创建仍用 `wx`；被抢先时只拒绝自己，绝不删他人锁。
8. 禁止删除 `writer-epoch.json`，不覆盖账本，不清理状态目录。

定向测试：`test/takeover-safety.test.mjs`（6：双竞争者真实子进程、锁身份变化、审计失败、锁类型不可确认、写前身份替换、接管字段完整）；`writer-epoch-fencing.test.mjs` F4 更新为「epoch 单调 +1」。全部通过。现有 W22 跨进程接管回归通过。

## 3. RRP 各项实际 UI 接入结果

复用既有后端，没有重做项目存储，没有自动模型调用。

| 项 | 实现 | 证据等级 |
|---|---|---|
| P1-1 灵感收件箱 | `project-store.mjs` 新增 `ideas`（同 `projects.json`、同磁盘锁、同 editRevision）；`captureIdea/listIdeas/reviewIdea/promoteIdea`；adapter 4 个 action；routes `/project/ideas`、`/project/idea/{capture,review,promote}`；client.js 左栏收件箱（捕捉、来源会话、确认/忽略/纳入研究） | 单测 + 渲染 + 真实浏览器 |
| P1-2 阶段与生命周期 | 已有阶段/事件接入界面：逐条显示事件（类型、from→to、时间、原因、actor），不再只显示数量 | 渲染 + 真实浏览器 |
| P1-3 事实与证据 | `FACT_STATUS_LABELS` 改为后端真实枚举（含 `disputed`）；事实卡显示 claimKind（用户声明/模型推断/证据支撑）、争议理由、取代关系、确认人；录入与摘要提炼传 `claimKind` | 渲染 + 真实浏览器 |
| P1-4 恢复包 | adapter 注入 `summariesBySession` 与 `lineages`（新增 `readSessionLineage` 接线）；新增 `sanitizeRecoveryPack` 出口脱敏；UI 显示覆盖缺口、会话血缘、版本说明 | 单测 + 渲染 |

关键代码：`project-store.mjs`（ideas 校验/可见性过滤/四个方法）、`project-http-adapter.mjs`、`project-routes.mjs`、`recovery-pack.mjs`、`index.mjs`（lineage 注入）、`client.js`。

测试：`test/project-ui-final.test.mjs` 新增「灵感收件箱：捕捉、去重与纳入研究」；`test/recovery-sanitize.test.mjs` 3 项；`test/rrp-mvp-01.test.mjs` 10 项、`test/project-http-routes.test.mjs` 13 项、`test/project-store.test.mjs` 15 项全部通过。

## 4. 首辅与奏折真实交互证据

- **不打开原生会话装守卫**：`chiefSummon → chiefCreate` 用 `svc.create()` 拿可 release 句柄，不调 `ws.openSession`；守卫为 agent 级 `tools.restrict` + 宿主 pre-step。代码证据 + `warroom.test.mjs` 渲染用例。
- **新开议事（fresh）**：原实现 `release → summon` 会 resume 同一 sessionId，历史仍在。已改为释放后清空当前登记（旧会话进 `chiefs` 历史），下一次召见必经 `chiefCreate`，返回 `newSessionId`。测试：`warroom` 与 `role-stream-window` 通过；未做真实 Electron 交互。
- **对话只看本次**：`roleStreamWindow` 的 `sinceSeq/hiddenCount/latestSeq` 已有单测；`fresh` 返回 `summonedAtSeq:-1`，前端不再把旧历史当新会话展示。
- **重启后提示重新召见**：`chiefBlockOf` 在无本进程 agent 时返回 `guard-not-installed`；卡片新增状态行「已召见 / 本进程守卫已验证 / 可发送 / 已退休 / 已冻结 / 权限不足」。
- **职责说明**：首辅卡明确「只读参谋：巡查、分析、问答、提出建议；不执行，不修改已锁定事实」。
- **奏折卡片**：保留 WarRoom 内联展开；「重新生成」改为 `force:true`；`runHanlinDigest` 用 `useRef` 单飞并带 `requestId`，避免同帧连点产生重复请求；来源/模型/缓存提示保留。

证据等级：组件渲染已验证（真 client.js + mini-react + 假 DOM），真实浏览器截图已验证；Electron 真机与真实模型对话未验证。

## 5. 性能测量及配置最后一跳验证

### 采集性能（合成 200 会话，单次读取延迟 5 ms）

数据：`B:\DSH\Agent\_t5\PERF-POLL-BASELINE.json`

| 场景 | 耗时 | 同步 | 延后 | 读取次数 |
|---|---|---|---|---|
| 启动轮 `limit=20` | 303 ms | 20 | 180 | 20 |
| 定时轮 `maxPerPoll=10` | 155–157 ms | 10 | 190 | 10 |
| 并发第二次 poll | 立即返回 `already-polling` | — | — | — |
| 规则收紧后一轮 | — | 0 | — | 0 |

结论：单轮不会重叠（`pendingPoll` + `liveRuntime.polling` 双锁）；启动轮有界（20 个，约 1 秒/会话的真实环境约 20 秒）；无饥饿（最久未检查优先）；规则收紧后不再读取旧授权会话。真实生产 197 s/200 会话为历史实测，本次未在生产重测。

### 配置最后一跳

修复并验证：

- `maxAttemptsPerChild` / `maxTotalTrialRequests` 非法值不再静默回落 2，门禁建立失败（配置错误可见）。
- 账本 `createdAt` 缺失/非法按 fail-closed 计入当日 attempt；`snapshot().invalidCreatedAtCount` 暴露。
- `pollIntervalMs` / `maxSessionsPerPoll` 非法值回落默认（30s / 10），不再产生 `NaN` 定时器。
- `maxTotalTrialRequests` 永久累计，达到上限需人工核对（未放宽度）。
- 每日 attempt 使用进程本地时区自然日重置；reserved 计入当日；cancel/fail/unknown 记 unknown 并阻断新调用（既有语义，未改）。

测试：`test/config-effective.test.mjs` 4 项，直接读 gate/budget 快照与真实账本行为。

### 模型诊断

`GET /api/dsh-wangchao/model-readiness` 增强：

- 保留五态与旧 blocker 名称（兼容都察院/巡检）；
- 新增 `blockersDetailed`（机器可读 code：`missing-route`/`route-not-allowed`/`credential-present`/`no-budget`/`halted`/`unknown-cost`/`over-budget`/`no-estimate`/`bad-output-cap`/`not-observe-only`/`not-frozen` 等）；
- 新增 `gate` / `budget` 实际生效值（ready/error/lockHeld/writerEpoch/attempt 上限/试验请求已用与上限/used/reserved/unknown）；
- 修复翰林摘要错误路径引用未声明 `servedProvider` 的 `ReferenceError`；
- `allowedRoutes` 与门禁白名单对齐（`deepseek-official`、`deepseek-account`）；
- `providerRegistered` / `modelListed` 明确返回 `not-probed`，不把白名单命中冒充「已注册」；
- 不读取、不显示任何凭据值。

## 6. 完整变更清单

**核心源码**

- `state.mjs`：`RULE_FORMAT_EXPLICIT`、`mergeRules`、`migrateRuleOverride`、格式校验、`baseRules` 导出、轮询参数 NaN 兜底。
- `index.mjs`：规则稀疏保存/回滚、`/rules` GET 格式与显式字段、`poll` 注入 `rulesNow`、`fresh` 新会话、`session-lineage` 注入、model-readiness 增强、配置非法值显式报错、`servedProvider` 修复、`blockersDetailed`、`allowedRoutes` 传入。
- `poll.mjs`：`rulesNow()` 实时判权。
- `writer-epoch-fencing.mjs`：原子认领、身份复核、审计 fail-closed、epoch 推进、写前 fencing。
- `exec-budget.mjs`：非法/缺失 createdAt 的 attempt 计数 fail-closed、`invalidCreatedAtCount`。
- `real-model-readiness.mjs`：默认路由白名单对齐、blocker code。
- `project-store.mjs`：灵感收件箱持久化与四个方法、可见性过滤、schema 校验。
- `project-http-adapter.mjs`：灵感 action、恢复包 summaries/lineages 注入、出口脱敏、`listIdeas` 读操作。
- `project-routes.mjs`：4 条灵感路由。
- `recovery-pack.mjs`：`sanitizeRecoveryPack`。
- `client.js`：规则文案与显式空提示、灵感收件箱、生命周期事件、claimKind/disputed、首辅职责与状态、fresh、奏折 force/单飞、恢复包缺口与血缘。
- `package.json` / `CHANGELOG.md` / `README.md` / `README.en.md`：版本、变更与使用说明。

**测试新增**

`test/rules-merge.test.mjs`、`test/rules-e2e.test.mjs`、`test/takeover-safety.test.mjs`、`test/takeover-race-worker.mjs`、`test/recovery-sanitize.test.mjs`、`test/config-effective.test.mjs`、`test/perf-poll-baseline.mjs`；更新 `writer-epoch-fencing.test.mjs` F4、`test/project-ui-final.test.mjs` 灵感用例、`test/standalone-refs.test.mjs` 定时器断言（改为相对基线，原断言在基线版本即失败，见第 7 节）。

## 7. 定向、回归和实机测试结果

- **定向**：规则 15 项、锁接管 43 项、配置 4 项、恢复包脱敏 3 项、灵感 UI 1 项，全部通过。
- **全量**：66 个测试文件，`tests 393 / pass 392 / fail 0 / skipped 1`（node:test 汇总计数，无失败用例）。
- **自检**：`node checks/all.mjs` 6/6 组、45 断言、`bundleHash=2b8c274d1b2415bb`、无 CRLF。
- **真实浏览器渲染**（Edge headless + 合成宿主 API，非 DSH Web GUI）：
  - `_t5\alpha5-ui-check.png`：御书房三栏、首辅职责与状态、灵感收件箱、底栏卡片；
  - `_t5\alpha5-ui-project.png`：项目工作区、研究阶段、生命周期、事实 claimKind、恢复包按钮；
  - `_t5\alpha5-ui-narrow.png`：760px 窄窗口单列布局。
- **基线即失败项**：`test/standalone-refs.test.mjs` 原先固定断言「常驻 15s 定时器数量=1」，用基线 `client.js` 同样得到 2（未改动代码也失败）。已改为相对基线断言（打开 +1、关闭回基线、反复开关不累积），修复后 17/17 通过。

## 8. 未完成事项及实际阻断

| 项 | 状态 | 原因 |
|---|---|---|
| Electron 真机 UI 验收 | 未做 | 需重启生产宿主与 Electron 环境，属专项阻断 |
| 真实收费模型调用 | 未做 | 工作包明确不发起；真实模型实测证据仍缺 |
| DSH Web GUI 宿主内实测 | 未做 | 仅用独立浏览器 + 合成宿主 API 渲染；未启动替代服务器 |
| 首辅内联对话真实 agent 往返 | 未做 | 需真实宿主与模型 |
| `thinking` 参数诊断 | 未实现 | 该参数不属本插件配置（宿主 llm entry），插件侧只在「正文为空」提示 |
| provider/model 存在性探测 | 明确 `not-probed` | 宿主未暴露目录查询，不用白名单冒充 |

## 9. 候选包路径与 SHA-256

| 项 | 值 |
|---|---|
| 候选目录 | `B:\DSH\Agent\_t5\alpha5-public-candidate` |
| 候选 HEAD（单提交） | `37b00d4999fdea8b42bfa8de83c92bbfa91e4fe1` |
| tarball | `B:\DSH\Agent\_t5\alpha5-release\dsh-wangchao-0.5.0-alpha.5.tgz` |
| 大小 | 371,230 B |
| SHA-256 | `6F2EDFA859658749C08489451EC9740448BFB68440B4EAA7CBAB592333428081` |
| 文件数 | 52（无内部文档、测试、夹具、截图、日志、state） |

## 10. 公开发布审计结果

`publish-audit.ps1`（本地工作区 + npm pack 清单 + 本地全历史）全部通过：

- 工作区已跟踪 55 文件、npm 52 文件，全部在 git 跟踪范围内；
- 全历史 1 个提交，无命中；
- 人工确认并豁免 4 处（同一代码在 HEAD 与历史中出现两次）：
  - `handoff.mjs` 的 `task-store-unavailable` 被 `sk-` 规则误报；
  - `index.mjs` 的 `env.LOCALAPPDATA` 是 Windows Chrome 路径探测，不是本机用户名/路径。
- commit author 使用 GitHub noreply（`MacilyDots@users.noreply.github.com`），不含私人邮箱。
- 远端克隆复核（第 3/4 步）未执行：本工作包未推送远端，留待裁决后执行。

未执行：`npm publish`、dist-tag、GitHub Release、force push、市场条目更新。

## 11. 生产完整性核查

- 生产 `leader` HEAD `c8a2609` 未变；未执行任何写操作。
- 生产账本、审计、state 未读取或写入；所有验证使用临时目录/合成数据。
- 生产目录 27 个既有未提交改动保持原样。
- 未修改 DSH profile、未重启宿主。

## 12. 建议 Gemini 重点独立复核的文件及风险

1. `writer-epoch-fencing.mjs`：接管认领与审计顺序、`verifyOwnership` 对性能与可用性的影响、`releaseLock` 的 read-then-delete 是否仍有 TOCTOU（判断为低风险，但值得复核）。
2. `state.mjs` / `index.mjs` 规则链路：旧格式迁移选择「空集」是否会突然收紧现有生产授权（这是刻意的 fail-closed 取舍，需产品确认）。
3. `poll.mjs`：`rulesNow()` 替换是否覆盖所有判权点，`syncSession` 的 cwd 仍可能用列表快照（既有行为，未改）。
4. `project-store.mjs` 灵感：`ideas` 与 `projects` 共用文件后 schema 校验/可见性过滤是否完整，`promoteIdea` 事务是否可能留下半成品。
5. `recovery-pack.mjs` 脱敏：`scrubText` 是有限规则，不能证明穷尽；恢复包仍不含正文。
6. `client.js`：新增 UI 的 hooks 位置（全部在组件顶部）、`loadIdeas` 对渲染次数的影响、窄窗口下首辅按钮裁切。
7. `exec-budget.mjs`：`createdAt` 缺失计入当日是否会造成老账本永久占名额（安全方向，可能影响可用性）。
8. `index.mjs` `/model-readiness`：新字段是否被都察院/巡检按旧契约消费；`blockersDetailed` 与旧 `blockers` 并存是否会造成误读。

---

**候选 HEAD 已固定；未晋级生产、未发布 npm、未创建公开 Release，等待 Gemini 独立审核与项目经理裁决。**
