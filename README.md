# dsh-wangchao

`dsh-wangchao` 是 DeepSeek Harness 的跨会话观察与协作插件。它按明确允许的会话名单读取状态，在「御书房」中提供项目、对话、采集范围和任务视图，并支持手动预览摘要、查看来源覆盖和保存人工修订。

这是一个社区维护的 alpha 项目，不是 DeepSeek 官方插件。

## 当前状态

| 项目 | 说明 |
|---|---|
| 版本 | `0.3.0` |
| 定位 | 跨会话观察、首辅参议、任务调度与受控执行边界 |
| 测试环境 | DeepSeek Harness `0.2.2-rc.3` |
| 许可 | MIT |

面板内自称「王朝」，其中的核心角色称「首辅」（内阁首辅）。

这是公共测试版本。配置格式、状态文件格式和界面仍可能变化。

## 0.3.0 新增

- **崩溃恢复**：状态、任务、治理和执行生命周期记录统一为 tmp→rename 原子写；主文件缺失、残留临时文件或非法记录时拒绝启动，不把读不到当成空账本。
- **摘要引用**：摘要面板与会话引用带 seq、类型、时间元数据，并按最新会话权限实时判权；正文不返回，避免脱敏不可验证。
- **执行预算门禁**：执行子会话的每次模型请求都走本地预估、预留和结算；单次与累计额度、每会话尝试次数、输出 token 上限都会在发送前检查。
- **写权交接**：账本写者带 epoch；插件卸载时先停止接收、在有界时间内等待在途请求、超时记为费用未知后再交接写权，旧回调不能覆盖新写者。
- **缓存计价**：usage 中的缓存读取 token 可按单独的缓存命中价折算；未配置命中价时按标准输入价保守计算，并在状态快照里标明口径。

真实执行链路已在隔离环境用 `deepseek-official/deepseek-flash` 跑通一次：两次请求、一次只读工具调用、任务成功，费用按返回 usage 结算。生产配置默认不开放真实执行。

## 当前能做什么

### 采集与视图

- 只读取 `allowSessions` 或 `allowCwds` 命中的会话。
- 排除规则优先；路径无法解析时拒绝读取。
- 对活跃会话建立实时事件流（`sessionController.observeEvent`），轮询只补齐冷会话，避免活跃会话重复读取。
- 在「总览与对话」「计划与任务」两个页签中查看状态；「采集范围」「内阁首辅」「任务队列」以卡片抽屉展开。
- 手动运行摘要预览，查看实际送入的事件、字符数、截断和成本估算。
- 显示摘要覆盖情况、部分送入、未覆盖区间和未知结果。
- 对摘要进行人工修订，新版本追加保存，原摘要保留。
- 手动给会话写项目标签。

### 首辅

- 召见、打开、关闭、恢复首辅会话；未召见时入口全部拒绝。
- 首辅发送准入由宿主 `agent/pre-step` 统一判定：关闭、退休、规则收紧、状态不可信一律拒绝。
- 拒绝原因写入面板与该会话输入框提示，卸载时清理。
- 首辅只读守卫：在首辅会话上验证工具范围，防止只读角色执行副作用工具。

### 计划与任务

- 首辅提出计划 → 用户在面板确认 → 派发为任务。
- 任务存储（`task-store.mjs`）与调度器（`multi-task.mjs`）记录来源、确认、执行者、结果和失败原因。
- 支持取消任务、查看依赖任务、执行约束和证据来源。

### 执行

- 执行入口带代码门禁：默认只在显式启用的隔离假模型测试配置下允许派发（`isolatedTestExecution: true` + `chiefProvider: 'fake'` + `chiefModel: 'fake-1'`），真实环境一律拒绝。
- 本地预算门禁：`budgetLimitUsd`（默认 0）与 `budgetPermissions`（默认只允许 `read`），只做估算与审计，不是服务商账单硬上限。
- 并行任务上限由 `maxParallelTasks` 控制。

### 独立窗口

- 面板顶栏提供「打开独立窗口」：由 DSH 主机进程拉起 Edge/Chrome 的 `--app` 无边框窗口，加载独立页面（`/api/dsh-wangchao/ui`）。
- 独立页面与侧栏面板复用同一份 `client.js`，由内置的迷你 React 渲染，不使用 DSH 侧栏 slot。
- 独立窗口地址带一次性启动 token，经 DSH 连接层认证后签发 Cookie；无凭据访问返回 401。

装上后不会读取任何会话。需要先在「采集范围」中明确加入目录或会话。

## 当前不做什么

- 不在后台自动调用模型（除显式配置的真实摘要与首辅对话外）。
- 不自动执行真实任务（执行入口被代码门禁挡在测试配置内）。
- 不替用户查找允许名单之外的会话。
- 不保证摘要内容真实、完整或及时。

插件运行在 DSH 主进程内，可以使用 DSH 提供的服务。插件里的权限判断不是安全沙箱。

## 安装

先下载 Release 中的 `dsh-wangchao-0.2.0.tgz`。在保存该文件的终端中执行：

```powershell
$asset = Join-Path $env:USERPROFILE "Downloads\dsh-wangchao-0.2.0.tgz"
dsh plugin --profile demo add "file:$asset"
```

把 `demo` 换成准备试用的 profile。`dsh plugin add` 会自动把 `dsh-wangchao` 加进 `dsh.profile.bundles`，不要同时在用户层 `cordis.patch.yml` 中再写一份同 id 的 `insert`。

需要配置时，使用 id-targeted 覆盖：

```yaml
- id: dsh-wangchao
  config:
    observeOnly: true
    allowSessions: []
    allowCwds: []
```

用多个 profile 试用时，请给每个 profile 设置不同的 `stateDir`。同一个状态目录只能由一个 DSH 实例写入。

重启 DSH 后打开「御书房」。建议第一次使用时只加入一两个测试会话，确认显示、权限撤销和状态文件位置都符合预期后，再扩大范围。

## 默认行为

| 配置 | 默认值 | 结果 |
|---|---|---|
| `observeOnly` | `false` | 完整模式；设为 `true` 则首辅入口全部拒绝 |
| `allowSessions` | `[]` | 不按会话放行 |
| `allowCwds` | `[]` | 不按目录放行 |
| `excludeSessions` | `[]` | 无额外会话排除 |
| `excludeCwds` | `[]` | 无额外目录排除 |
| `allowManualSummary` | `false` | 只允许摘要预览，不调用模型 |
| `pollIntervalMs` | `30000` | 每 30 秒检查一次（最小 5000） |
| `maxSessionsPerPoll` | `10` | 每轮最多处理 10 个会话 |
| `maxParallelTasks` | 默认并行任务上限 | 执行调度上限 |
| `budgetLimitUsd` | `0` | 本地预算门禁 |
| `budgetPermissions` | `['read']` | 执行只允许只读级操作 |
| `isolatedTestExecution` | `false` | 执行派发入口默认拒绝 |
| `stateDir` | `<DSH_HOME>/wangchao` | 插件自己的状态目录 |

`allowSessions` 和 `allowCwds` 是任一命中即可放行，不是同时满足。`excludeSessions` 和 `excludeCwds` 优先于允许规则。

执行派发入口默认拒绝；只有显式设置 `isolatedTestExecution: true` 且首辅使用 `fake` 模型时才允许。真实执行链路尚未在正式环境验证，不属于本版本的支持范围。

## 手动摘要

默认只会执行预览：

```json
{
  "sessionId": "session-id",
  "dryRun": true
}
```

预览会返回拟送入内容、实际事件序号、过滤与截断信息，以及粗估 token 和费用。预览同样包含已授权会话的正文，应按敏感数据对待。

真实模型调用默认关闭。只有同时配置 `allowManualSummary: true`、`summaryProvider`、`summaryModel`，并显式传入 `dryRun: false` 时才会发送请求。该能力仍是实验性功能；长会话的截断、分段和摘要质量尚未充分验证。

摘要校验只检查格式与引用范围，不能证明摘要中的判断真实成立。费用估算来自插件内置价目，最终以服务商账单为准。

## 数据与隐私

- 只采集允许名单中的会话。
- 每次读取前重新检查当前会话元数据和授权规则。
- 候选会话列表只显示会话 ID、路径、创建时间和判定结果，不读取正文。
- 摘要预览会返回已授权会话的正文。
- 状态文件是未加密 JSON，内含会话元数据、摘要、标签、人工修订和任务记录。
- 撤销授权后，相关内容不再显示，但已保存的摘要和标签仍留在状态文件中。
- 插件不上传状态文件，也不包含遥测。

如果要继续使用已保存的分类和摘要，请保留 `stateDir`；如果要彻底清除，应在停用插件后手动删除该目录。

## 配置

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `observeOnly` | boolean | `false` | 设为 `true` 时首辅入口全部拒绝 |
| `allowSessions` | string[] | `[]` | 允许采集的会话 ID |
| `allowCwds` | string[] | `[]` | 允许采集的目录 |
| `excludeSessions` | string[] | `[]` | 排除的会话 ID |
| `excludeCwds` | string[] | `[]` | 排除的目录 |
| `pollIntervalMs` | number | `30000` | 轮询间隔，最小 5000 毫秒 |
| `maxSessionsPerPoll` | number | `10` | 单轮最多读取的会话数 |
| `maxParallelTasks` | number | 默认上限 | 并行执行任务上限 |
| `budgetLimitUsd` | number | `0` | 本地预算门禁 |
| `budgetPermissions` | string[] | `['read']` | 允许的执行级别 |
| `isolatedTestExecution` | boolean | `false` | 仅隔离测试时开启执行派发 |
| `stateDir` | string | `<DSH_HOME>/wangchao` | 状态目录 |
| `allowManualSummary` | boolean | `false` | 是否允许实验性真实摘要 |
| `summaryProvider` | string | 未设置（真实调用前必须配置） | 摘要 provider |
| `summaryModel` | string | 未设置（真实调用前必须配置） | 摘要模型 |
| `summaryMaxTokens` | number | `1200` | 输出 token 上限 |
| `summaryMaxChars` | number | `6000` | 单次送入字符上限 |
| `summaryEventMaxChars` | number | `300` | 单条事件的正文截取上限 |
| `summaryBudgetUsd` | number | `0.03` | 单次请求的本地估算预算 |
| `chiefProvider` / `chiefModel` | string | 未设置 | 首辅会话使用的模型；未设置时跟随宿主默认 |

在面板中修改采集规则时，服务端会检查规则修订号。两个窗口同时编辑时，较旧的保存会收到冲突提示，不会覆盖较新的规则。

同一个 `stateDir` 只能由一个 DSH 实例写入。多进程同时使用尚未支持。

## 卸载

```powershell
dsh plugin --profile demo remove dsh-wangchao
```

如果用户层还保留 `- id: dsh-wangchao` 的配置覆盖，请一并删除，然后重启 DSH。

卸载不会自动删除状态目录。需要保留摘要和标签时不要清理它；确定不再使用时，再单独备份或删除。

## 升级与回退

升级前记录当前版本和 `stateDir`，并备份状态目录。回退时先移除新版本，再安装之前的 tarball。

状态文件当前使用 `version: 2`。新版本会忽略不认识的额外字段；跨较大版本回退前仍应先备份状态。

## 已知限制

- 只在 DeepSeek Harness `0.2.2-rc.3` 上验证过。
- 这是 alpha 版本，接口、配置和数据格式仍可能调整。
- 执行派发入口默认拒绝；只有显式设置 `isolatedTestExecution: true` 且首辅使用 `fake` 模型时才允许。真实执行只在隔离试验中跑通过一次，不属于默认支持范围。
- 首辅对话的权限边界依赖宿主 `agent/pre-step`，插件自身不是安全沙箱。
- 摘要质量只在一个构造样本上完成过真实调用核对。长会话、多轮压缩和工具密集场景尚未验证。
- 长事件和长会话可能被截断。预览中的覆盖信息表示实际送入范围，不代表正文语义完整。
- 自动检查存在轮询延迟。授权会话超过 `maxSessionsPerPoll` 时，一个会话可能需要多个周期才会被检查。
- 独立窗口依赖本机 Edge 或 Chrome 的 `--app` 模式；两者都不存在时入口不可用。
- 目前只保证单进程写入状态文件；多进程共享必须在后续版本中解决。
- 崩溃恢复只覆盖启动时的检测与拒绝；运行中写盘失败后的自动恢复、无 fsync 的掉电语义未证明。
- 面板的网络错误处理用测试工具模拟过，真实代理、cookie 和 CORS 组合仍需更多验证。
- 尚未完成完整类型检查和全仓测试。

## 这个项目以后要做什么

`0.2` 在 `0.1` 的观察与摘要基础上，加入了实时事件流、首辅对话、计划与任务调度，以及不依赖 DSH 侧栏的独立窗口。接下来优先做三件事：

1. 提高摘要与任务结果的可信度。让摘要区分事实、计划、未完成事项和模型建议，并为每条结论保留事件来源。
2. 增加运行健康观察。记录轮询耗时、失败、积压、更新延迟和资源占用，方便判断问题出在插件、DSH 宿主还是某个大会话。
3. 完善人工控制。提供摘要纠错、未知请求确认、采集范围撤销和清晰的状态恢复入口。

更后面的方向是由首辅按用户明确授权的任务组织多个执行 Agent，记录分派、回执、来源、成本和验收结果。Agent 的产出必须回到首辅统一判断，不能自行扩大权限，也不能把模型生成的计划当成已经完成的工作。

这些是项目方向，不是当前版本已具备的功能，也没有确定的完成时间。

## 参与试用

试用时请先使用测试 profile 和独立 `stateDir`。反馈问题时可以提供版本、配置键、错误信息和可复现步骤，但不要附上真实会话正文、凭据或未脱敏的状态文件。

## 许可

MIT
