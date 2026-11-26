# AP-05-R1 安全整改与候选收口交付报告

**日期**：2026-11-26
**范围**：仅整改 Gemini 审核的 F-01 / F-02 / F-03 / F-04，补反例回归与重新打包
**版本**：仍为 `0.5.0-alpha.5`（未正式发布）

---

## 1. 实际整改

### F-01 旧格式迁移与 UI/服务端保存语义

**改动文件**：`state.mjs`、`index.mjs`、`client.js`、`test/*`

1. `migrateRuleOverride` 按维度迁移（不再一刀切）：
   - `allowSessions` / `allowCwds` 的空数组 → 保留显式空集（收紧，不扩大授权）；
   - `excludeSessions` / `excludeCwds` 的空数组 → 删除该键，回落到配置基线拒绝规则；
   - 缺失字段 → 保持缺失（继承）；
   - 非空拒绝规则 → 原样保留；
   - 幂等：已有 `rulesOverrideFormat=2` 直接返回原对象。
2. `saveRules` 只接受显式字段；`null` = 删除该字段覆盖、恢复继承；全部字段删除时同时删除 `rulesOverride` 与格式标记。
3. 服务端新增确认门禁：清空 `excludeCwds` / `excludeSessions` 且配置基线该维度非空时，必须带 `confirmClearExclude:true`，否则 400 `confirm-required`。普通保存、空白输入、默认值都不会触发清除。
4. `client.js`：
   - `saveCurrent` 只提交实际编辑过的字段（稀疏更新）；
   - 每个字段显示来源（面板覆盖 / 继承配置基线）与“本次已编辑（未保存）”；
   - 单字段「恢复为继承配置」按钮（POST `null`）；
   - 清除继承的排除规则必须勾选「我明确要清除继承的排除规则」；
   - 「保存规则（仅提交已编辑字段）」文案明确。
5. `state.mjs` 过时迁移注释同步修正（F-04 关联项）。

### F-02 陈旧写锁接管时序

**改动文件**：`writer-epoch-fencing.mjs`、`test/takeover-safety.test.mjs`、`writer-epoch-fencing.test.mjs`

原实现：rename 认领后、尚未 `wx` 取得新锁时，就写审计并推进 epoch → 竞争写者 C 可先取得新锁并读到旧 epoch，A 再失败退出，造成活跃写者与磁盘 epoch/token 脱节。

整改后的时序（`claimStaleLock` + `acquireLock`）：

1. `claimStaleLock` 只做：读锁 → 校验 pid/kind → 原子 rename 到唯一 quarantine → 内容逐字复核 → 二次探活 → 读取当前 epoch（**只读**）。认领成功不代表取得写权。
2. 调用方用 `wx` 创建新锁；**只有 wx 成功**才进入下一步。
3. 写 `takeover-claimed`（认领意图，不是成功事件）→ 推进 `writer-epoch.json`（`epoch+1`，绑定本 token）→ 写 `takeover-stale-lock`（成功事件）。
4. 任一步失败：释放自己刚创建的锁（token 校验）并恢复旧锁；epoch 写入失败时追加 `takeover-aborted`；绝不写成功事件。
5. wx 失败（竞争者抢先）：不写 epoch、不写任何接管审计、不动 C 的锁；只在原路径仍空时放回旧锁。
6. 已持锁但成功审计写不进去：fail-closed，释放自己的锁并恢复旧锁，epoch 已推进（单调，不回退），留 `takeover-audit-failed`。

**最终决定：保留自动接管**（已按上述时序加固，A–G 交错测试全部通过）。理由：跨平台 rename/wx 已能提供原子互斥与身份复核；禁用会牺牲已审核通过的可用性，而新时序在所有失败路径都保持 fail-closed。若 Gemini 复核认为仍有未覆盖的竞态，可随时降级为人工确认（代码路径已保留）。

### F-03 恢复包脱敏

**改动文件**：`recovery-pack.mjs`、`sanitize.mjs`、`test/recovery-sanitize.test.mjs`

- `sanitizeRecoveryPack` 改为**整棵 JSON 深度投影**：所有字符串走 `scrubText`，结构与标量保留，深度 8 层截断；`markdown` 单独用 20000 上限并同样脱敏。
- 不再逐字段补丁：`aliases`、`lifecycleEvents[].reason/actor`、嵌套对象、未来新增自由文本字段自动覆盖。
- `sanitize.mjs` 新增 URL userinfo 脱敏规则（`https://user:password@host`）。
- 出口覆盖：JSON、Markdown、HTTP 路由响应、复制源（markdown 即复制内容），UI 预览使用同一 payload。
- 合成哨兵：`sk-…` API Key、Bearer、启动 token、带凭据 URL、嵌套对象、aliases、生命周期事件；不读取真实凭据。
- 结构保持：`kind/fromStage/toLifecycle/status/citations` 等语义字段不变，正常研究文本不被改写。

### F-04 注释与公开包清理

- `state.mjs` 迁移注释与实际实现一致（按维度迁移）。
- `chief-analysis.mjs` 删除 `ROADMAP §3.3` 引用；`real-model-readiness.mjs` 删除 `ROADMAP-V040 §5.2` 引用。
- 公开运行时源码已无 `ROADMAP` 字样；内部开发树中的 ROADMAP / 开发日记 / 测试未删除。

## 2. Gemini 三个反例的修复前后对照

### PROBE_1_P01_MIGRATION

| | 迁移前（旧语义） | 修复前 alpha.5 | 修复后 R1 |
|---|---|---|---|
| 基线 `excludeSessions:['s-secret']` + 旧 override 全空 | `excluded-by-session` | `allowed-by-cwd`（拒绝被清空） | `excluded-by-session` |
| 基线 `excludeCwds:[secret]` + 旧 override 全空 | `excluded-by-cwd` | `allowed-by-cwd` | `excluded-by-cwd` |
| 仅编辑 allowCwds | — | 全量提交，排除字段被覆盖 | 只提交 allowCwds，排除保持继承 |
| 清空继承排除 | — | 直接生效 | 400 `confirm-required` / UI 需勾选确认 |

回归：`test/rules-migration-security.test.mjs`（以 `decideAccess` 实际结果断言，含“迁移后不得扩大授权”的全候选矩阵）、`test/rules-e2e.test.mjs`（稀疏保存、确认门禁、null 恢复、重启、撤权）。

### PROBE_2_P02_RACE

| | 修复前 | 修复后 |
|---|---|---|
| A rename 后、wx 前 C 抢先 | A 已写 epoch 8 与审计；C 持锁读到 7；C stop 后磁盘仍 8 | A wx 失败，不写 epoch/审计；C 持锁 epoch 7，stop 后 8 |
| 失败者修改 writerToken | 是 | 否 |
| 虚假成功审计 | 有 | 无（只可能有 claimed/aborted） |

回归：`test/takeover-safety.test.mjs` T7（确定性注入 C 抢先）、T8（epoch 写失败）、T3（审计失败）、T2（身份变化/迟到观察者）、T1（真实双进程）、T9（PID 存活/EPERM/未知）、T10（账本不被触碰）。

### PROBE_3_SANITIZE

| | 修复前 | 修复后 |
|---|---|---|
| `pack.aliases` 含哨兵 | 泄漏 | `[REDACTED]` |
| `lifecycleEvents[].reason/actor` | 泄漏 | `[REDACTED]` |
| 嵌套对象 / URL userinfo | 未覆盖 | 深度投影 + URL 口令遮罩 |
| HTTP JSON 出口 | 泄漏 | 无残留 |

回归：`test/recovery-sanitize.test.mjs` 6 项（含路由出口）。

## 3. 新增并发与权限回归证据

- 权限：`rules-migration-security` 7 项、`rules-merge` 12 项、`rules-e2e` 5 项；覆盖基线含排除规则的迁移、非空旧拒绝、缺失字段、显式清空允许/排除、恢复默认、连续迁移、重启、撤销后在途摘要请求被拒。
- 并发：`takeover-safety` 10 项（T1–T10），含真实双进程、确定性竞态注入、审计/epoch 故障注入、PID 探测异常、账本只读。
- 写前 fencing：T5（锁被替换后 `LOCK_STOLEN`、不删他人锁）。

## 4. 自动接管最终决定及理由

**保留自动接管**，但改为“先取得锁、后写身份”的两阶段时序，并新增 claimed/aborted/audit-failed 审计阶段。理由：

- rename + wx 在本机 NTFS/Windows 上提供原子互斥；内容复核消除 ABA；二次探活覆盖 PID 复用/异常；
- 所有失败路径不推进 epoch、不写成功事件、不删他人锁；
- 禁用会回退已审核的自动恢复能力，且没有证据表明仍存在未覆盖的双写路径；
- 若复审发现新反例，`claimStaleLock` 可独立降级为“只隔离 + 人工确认”。

## 5. 实际 UI 与 Web 宿主验证范围

**已验证（独立浏览器 + 合成宿主 API，非 DSH Web GUI / Electron）**：

- `ap05-r1-ui-main.png`：御书房三栏、首辅职责/状态、灵感收件箱、底栏卡片。
- `ap05-r1-ui-detail.png`：项目工作区、研究阶段、生命周期、事实 claimKind、恢复包入口。
- `ap05-r1-ui-rules.png`：规则抽屉；每字段来源（面板覆盖/继承配置基线）、恢复继承按钮、清除排除确认提示。
- `ap05-r1-ui-narrow.png`：760px 单列布局。

**组件级交互（真 client.js + mini-react + 假 DOM）**：

- 规则编辑：只提交已编辑字段；未确认清空排除被前端拦截；勾选后带 `confirmClearExclude`（`standalone-refs` 新增用例）。
- 灵感捕捉/去重/纳入研究、阶段事件、事实锁定/claimKind、恢复包生成/复制/脱敏（`project-ui-final`、`warroom`、`recovery-sanitize`）。

**NOT VERIFIED**：Electron 真机、DSH Web GUI 宿主内实测、首辅真实 agent 往返、真实收费模型、真实翰林院生成（仅 fake provider/合成数据）。未重启生产 DSH。

## 6. W21 补测结果

在允许创建 junction 的本机权限环境执行：

`node --test --test-name-pattern 'W21' wiring.test.mjs` → **PASS（1/1）**，无跳过、无删断言、无提权。全量回归中 W21 同样通过。

## 7. 完整回归结果

| 项 | 结果 |
|---|---|
| `checks/all.mjs` | 6/6 组、45 断言、0 失败；`bundleHash=620083ac647ef3b1` |
| 全量离线（66 文件） | **409 tests / 408 pass / 0 fail / 1 skipped** |
| 定向 | F-01 24 项、F-02 10 项 + 35 项 fence 单测、F-03 6 项、UI 18 项，全部通过 |
| 关联回归 | `wiring`、`fence-integration`、`rrp-mvp-01`、`project-http-routes`、`project-store`、`project-facts`、`chief-project-tools`、`config-effective`、`warroom`、`standalone-refs` 全部通过 |

## 8. 新候选 HEAD、哈希与安装包

| 项 | 值 |
|---|---|
| 代码 HEAD | `279da2415c6dd95fa71ee7a0d45e48807f6d1751` |
| 公开候选树 | `B:\DSH\Agent\_t5\alpha5-r1-public-candidate` |
| 候选 HEAD | `ed1b4abbb452b0452b31382c7bcaf1f039b8a44d` |
| tarball | `B:\DSH\Agent\_t5\alpha5-r1-release\dsh-wangchao-0.5.0-alpha.5.tgz` |
| 大小 | 373,513 B |
| SHA-256 | `C7864DACC23E8E7DA56EA54FB4C18132A89F98B27D928BF844732DBAE5A0C0AE` |
| 文件数 | 52（无内部文档、测试、夹具、截图、日志、state） |
| manifest | `B:\DSH\Agent\_t5\alpha5-r1-release\manifest.json`（逐文件 SHA-256） |
| 发布审计 | `publish-audit.ps1` 全部通过；4 处人工确认误报豁免（`task-store-unavailable` / `LOCALAPPDATA`） |

原失败候选包保留未覆盖：
`B:\DSH\Agent\_t5\ap05-r1-frozen-failed-candidate\dsh-wangchao-0.5.0-alpha.5.failed.tgz`，
SHA-256 仍为 `6F2EDFA859658749C08489451EC9740448BFB68440B4EAA7CBAB592333428081`。

## 9. alpha.4.1 公开版本风险对照

只读检查公开包 `wangchao-alpha41-package\dsh-wangchao-0.5.0-alpha.4.1-limited-ai.tgz`：

| 项 | alpha.4.1 | alpha.5 R1 |
|---|---|---|
| 规则合并 | `state.rulesOverride ? normalizeRuleSet(override) : normalizeRuleSet(cfgRules)`，整份覆盖，无字段继承 | 三态按字段合并 |
| UI 保存 | `saveCurrent` 全量提交四个字段 | 只提交已编辑字段 + 确认门禁 |
| 自动接管 | **无**；`EEXIST` 直接 `LOCK_HELD`，要求人工清理 | 有，两阶段安全时序 |

**F-01：公开 alpha.4.1 存在同类风险**。只读探针（alpha.4.1 源码 + 合成 state）：

```
rulesOverride: { allowCwds:[root], excludeCwds:[], allowSessions:[], excludeSessions:[] }
config:        { allowCwds:[root], excludeCwds:[secret], excludeSessions:['s-secret'] }
=> secretSession: allowed-by-cwd
=> secretDir:     allowed-by-cwd
```

即：只要 `state.json` 里存在 `rulesOverride` 且排除字段为空，配置文件的 `excludeCwds` / `excludeSessions` 会被整份覆盖掉，受限会话/目录被放行。**影响范围**：alpha.4.1 公开版、已通过面板保存过规则且配置文件后来新增/修改过排除规则的实例。

**建议临时措施（交项目经理决定，未执行）**：
1. 检查 `state.json` 是否存在 `rulesOverride`；若存在且 `excludeCwds`/`excludeSessions` 为空、而配置有排除规则 → 删除整个 `rulesOverride`（等价“恢复默认”）并重启；
2. 或临时把排除规则改为只靠 `excludeSessions`/`excludeCwds` 的配置，并在面板保存后核对实际生效值；
3. 若要紧急修复公开版，需要单独授权打补丁/发版；本轮未执行。

**F-02：公开 alpha.4.1 不存在自动接管**（`EEXIST` 直接拒绝，人工清锁），因此 PROBE_2 的竞态不适用于公开版；该风险是 alpha.5 新引入并已在本轮修复。生产 `leader` 目录的未发布代码包含自动接管，但未发布、未在本轮修改。

## 10. 生产完整性

- 生产 `leader` HEAD `c8a260968471d3ae45a66d4791d3621569882ff5` 未变，27 个既有未提交改动保持。
- 关键文件 SHA-256 与开工基线一致（`index.mjs C145A22A…`、`client.js 9CC57A23…`、`state.mjs 1F69C55A…`、`package.json 01B63C8F…`）。
- 未读取生产凭据/会话正文，未写生产账本，未 `reserve()`，未调用商业模型，未改 profile/Junction/state，未启动第二个 Electron。
- 所有验证使用临时目录、合成数据、fake provider。

## 11. 剩余未验证事项

- Electron 真机 UI 验收、DSH Web GUI 宿主内实测（NOT VERIFIED）。
- 首辅真实 agent 往返、真实翰林院生成、真实收费模型调用（NOT VERIFIED / NOT COVERED）。
- 远端克隆复核与公开发布步骤（未推送，留待裁决）。
- alpha.4.1 紧急补丁未实施（需项目经理与用户授权）。
- 恢复包脱敏仍是有限规则（`scrubText`），不能证明穷尽；已覆盖常见凭据形态与 URL userinfo。

---

**代码与候选已冻结；未发布 npm、未改 dist-tag、未创建 GitHub Release、未推送远端、未晋级生产。等待 Gemini 增量复审。**
