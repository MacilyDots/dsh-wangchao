# dsh-wangchao 权威路线图

**最后更新**：2026-11-27（CONSOLIDATION-01 收口）
**适用版本**：`0.5.0-alpha.5.2`（候选）
**已发布版本**：`0.5.0-alpha.5.1`（npm `latest` / `alpha` 双 tag）
**生产在用版本**：`0.5.0-alpha.4.1`

> 本文件是**唯一权威路线图**。历史 ROADMAP（`ROADMAP-V040.md`、`ROADMAP-VISION-DRAFT.md`、`_t5` 下各 worktree 副本）已移入 `docs/archive/`，仅作历史对照，不再具有计划效力。
>
> 状态标记严格区分以下六类，**不混用**：
>
> | 标记 | 含义 |
> |---|---|
> | **已交付** | 代码在发布包里、有测试、有验收证据，用户可用 |
> | **已实现未接线** | 后端逻辑完整，但前端/入口没接，用户碰不到 |
> | **有意冻结** | 能力存在但**主动关闭**，有明确安全理由，不是遗漏 |
> | **未实现** | 只有设计或完全没有 |
> | **已废弃** | 曾经存在，已被替代或删除，不再计划恢复 |
> | **待重新决策** | 与用户预期或现场事实冲突，需先定方向再动手 |

---

## 1. 当前基线（实测）

| 项 | 值 |
|---|---|
| 候选源码 | `B:\DSH\Agent\_t5\alpha52-host-fix`，HEAD `11a07d6` + 本轮改动 |
| 源码文件 | 127 个（删除 `plan-evidence.mjs` 后） |
| 根模块 | 42 个非测试模块 + 2 个 `.js` |
| HTTP 路由 | 47 条（`index.mjs` 26 + `project-routes.mjs` 18 + 静态 3） |
| 测试 | 284 tests / 283 pass / 1 skip / 0 fail |
| 质量门禁 | `checks/all.mjs` 7 组 / 50 断言 / 0 失败 |
| 发布白名单 | `files` 51 项 |
| 候选包 | `dsh-wangchao-0.5.0-alpha.5.2.tgz`，384,438 B，SHA-256 `0625792C…B77F` |

---

## 2. 能力状态总表

### 2.1 已交付

| 能力 | 落点 | 证据 |
|---|---|---|
| 会话采集与实时判权闸门 | `poll.mjs`、`state.mjs` | 生产运行中 |
| `state.json` 原子持久化 + 孤儿 tmp 检测 | `state.mjs`、`orphan-tmp.mjs` | 5 个消费者，不是死代码 |
| pending 恢复（限定窗口） | `state.mjs` | 有限窗口设计 |
| 摘要链路 + 人工修订 | `summary-*.mjs`、`corrections` | — |
| 首辅对话（B1） | `index.mjs` role 路由 | 8 态回执（D-06，alpha.5.2） |
| 首辅消息可靠回执（八态） | `index.mjs` `role/message/status` | 12 项测试，含并发归因 |
| 人工纠错 UI（B3） | `client.js` | — |
| 御书房工作台（B4 及第二版） | `client.js` | — |
| 命名体系（B7） | `NAMING.md` | — |
| 实时事件流 | `live-stream.mjs` | — |
| 预算账本与门禁 | `exec-budget.mjs`、`governance.mjs`、`exec-admission.mjs` | 已接线（`budgetLimitUsd>0` 即构造） |
| 执行守卫 | `authorize-tier.mjs`、`boundary.mjs`、`exec-policy.mjs` | 真实执行仍受限制 |
| 都察院确定性审计 | `censorate.mjs`、`censorate-enforce.mjs` | 规则引擎，非 LLM |
| 任期与交接 | `handoff.mjs`、`retire` 相关 | facts 与 notFact 分离 |
| 翰林院摘要 | `hanlin-digest.mjs` | alpha.5.2 起 fake 路径走确定性摘要，零收费 |
| 规则迁移 `rulesOverride` v2 | `state.mjs` `migrateRuleOverride` | alpha.5.1，四字段 → 两字段 + `format=2` |
| 升级/回滚安全工具 | `_t5\ap08-upgrade\r1\`（工作线外资产） | A–L 13 项演练 PASS |

### 2.2 已实现未接线

| 能力 | 状态 | 缺什么 |
|---|---|---|
| `/hanlin/digest/cancel` | 后端全通，无前端、无测试 | 取消按钮与状态回显 |
| `/project/update` | 后端全通（写操作，带 `expectedRevision` 乐观锁），无前端、无测试 | 编辑入口 |

> 这两项都是**写操作**，补 UI 超出「最小接线」范围，需单独排期。

### 2.3 有意冻结

| 能力 | 冻结理由 |
|---|---|
| 真实 Executor 执行 | 安全默认。`execEnabled: false`，需显式开启 + 预算门禁 + root 守卫 |
| Electron / SEC-1C 相关 | 历史 BLOCKED，未解 |
| 首辅对话跨轮次上下文 | 只在单轮内闭环，不扩到多轮自主 |
| `multi-task.mjs` | 职责与现有单任务链路重叠，冻结不扩展 |

### 2.4 未实现

| 项 | 说明 |
|---|---|
| B2 引用跳转 | 摘要正文 `[seq]` 解析为可点击锚点 |
| B5 摘要质量扩展 | 工具密集会话、长会话滚动增量、多轮压缩识别 |
| B6 崩溃恢复其余窗口 | 读会话中途退出、写 state 中途、双残留仲裁 |
| C3 首辅退休四方式 | 主动告老 / 满额 / 罢免 / 换模型重开 |
| 多进程共享 stateDir | 需 lockfile + pid + lease 单写者互斥 |
| F3 主文件模块化 | `index.mjs` 与 `client.js` 渐进拆分 |
| S4 规则迁移 | 28 条裸 UUID 的处置，等用户裁决 |

### 2.5 已废弃

| 项 | 废弃时间 | 处置 |
|---|---|---|
| `plan-evidence.mjs` | 2026-11-27 | 已删除，`plan-tools.mjs` 是其严格超集 |
| `.cmd` 启动器（演练脚手架） | 2026-11-27 | 全部移入 `.trash-cmd`，测试路径不再生成 |
| `Restore-Compatible-State.mjs` | 2026-11-27 | 由 `Verify-State.mjs` 的 rollback 模式取代 |
| alpha.5.2 首版候选包（`3E319440…`） | 2026-11-27 | 被 `0625792C…` 取代，不得发布 |
| `-RestoreData` 独立审批口径 | 2026-11-27 | 改为「默认含兼容业务状态恢复」 |

### 2.6 待重新决策

| 项 | 冲突点 | 需要谁定 |
|---|---|---|
| 28 条裸 UUID 授权 | 无法从数据判断授权意图，四场景判权矩阵已出 | 用户 |
| 市场分发链路 | DSH 市场装 0.3.3、网站命令装 4.1、`npm i` 装 5.1 | 用户（P0） |
| `model-readiness` UI | 后端有、外部脚本在调、无前端展示 | 用户 |
| `idea-capture.mjs` | 有源码与测试，是否退出运行发布包 | 用户 |
| 真实模型四次最小调用 | 需专项授权（≈$0.003） | 用户 |

---

## 3. 阶段规划（剩余）

### 阶段 A：生产晋级（阻塞在用户授权）

1. 用户批准停机与 Junction 切换
2. 用 AP-08-R1 的 `r1\Invoke-Upgrade.ps1` 升级到 `0.5.0-alpha.5.2`
3. 御书房人工冒烟
4. 保留回滚路径（`Invoke-Rollback.ps1 -CodeOnly` 或带数据回滚）

**前置条件**：市场链路修复完成，否则新用户装到的仍是 0.3.3。

### 阶段 B：市场链路修复（P0，独立于代码）

按依赖顺序，不能反：
1. 给 `v0.5.0-alpha.5.1` 补 Release 附件（现在 `assets=[]`，URL 404）
2. 修 `latest` 语义（去掉 prerelease 标记或显式设 latest）
3. 改市场 YAML 的 `tarball` 指向（走 PR）
4. 强制刷新索引，校验 `versions[]` 变为单条

### 阶段 C：功能补齐（用户决定优先级）

- B2 引用跳转（B5 的验收工具，先做收益高）
- B5 摘要质量扩展
- B6 崩溃恢复其余窗口
- C3 首辅退休四方式

### 阶段 D：工程治理

- F3 `index.mjs` / `client.js` 渐进拆分（只拆有测试覆盖的低耦合只读逻辑）
- G 质量门禁持续运行

---

## 4. 不做的事

- 不做无人监督的自主执行
- 不做常驻 LLM 都察院
- 不铺开多部门层级（最小朝廷）
- 不把摘要校验结果表述为「内容真实」
- 不为降行数机械拆分文件
- 不建设通用插件注册框架
- 不把独立插件全量内化进王朝
- 不在没有测试覆盖时改动安全写入路径 / 账本 / Writer Fencing

---

## 5. 历史对照

早期规划的完成情况见 `docs/archive/ROADMAP-V040.md` 与其后的 AP-05 ~ AP-09 交付报告。本轮（CONSOLIDATION-01）只做工程收口，不新增功能。
