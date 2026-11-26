# 观察版试用配置与步骤

适用于隔离环境试跑。**本文档不构成已安装状态**：desktop 配置未改、未连接日常会话。

## 零、这次试用能看到什么

当前配置跑在隔离 HOME `_leader-probe\test-home`，读到的是**隔离环境里的测试会话**（这批会话是历史探针留下的，内容不代表当前工作项目）。所以本轮的用途是：

- 能评估：界面结构、三视图切换、摘要/修订的操作感、规则收紧后的反应速度、采集诊断是否够用
- **不能评估**：真实项目的整理效果——因为看的不是真实工作会话

如果要读真实工作会话，属于另一步，需要先做：

1. 确定具体允许范围（哪些会话），**用 `allowSessions` 显式列 id，并把 `allowCwds` 留空**——判权是「任一命中即允许」，同时填目录会把该目录下其它会话一并放进来；不要沿用 `allowCwds: [B:/DSH]`。
2. 换用真实 HOME 或把真实会话目录单独划进允许列表，重新检查配置后再启动。
3. 明确这次读的是真实内容，按真实数据对待（`dryRun` 预览也含正文）。

配置细节与核对步骤见 [OBSERVE-VALUE-PLAN.md](OBSERVE-VALUE-PLAN.md)。

### 面板现在能说明什么、不能说明什么

能说明：哪些会话存在、各自的 cwd、事件数、最近活动时间、最后同步时间与状态（已同步 / 不可用/待确认）、有没有摘要版本。

**不能说明：会话做到哪一步、卡在哪、结论是什么。** 一行「已同步」只表示事件读到了，不等于这段工作有进展。没有语义摘要时，距离「几十个会话压成一份人能看懂的项目状态」还差一层——这是当前观察版的实际位置，不是某个配置没调好。

## 一、试用配置（可直接用于 `--patch`）

```yaml
- insert:
    - id: dsh-wangchao
      name: dsh-wangchao
      config:
        allowCwds:
          - B:/DSH
        excludeCwds:
          - B:\DSH\Agent
        pollIntervalMs: 5000
        maxSessionsPerPoll: 50
        observeOnly: true
        stateDir: B:/DSH/Agent/_leader-probe/out/observe-trial-state
```

| 项 | 值 | 说明 |
|---|---|---|
| 允许目录 | `B:/DSH` | 会话 cwd 在此目录下才可能被采集 |
| 排除目录 | `B:\DSH\Agent` | 优先级高于允许目录；工具、探针、实验目录全部排除 |
| 允许会话 | 空 | 不追加单个会话白名单；需要时在面板「采集范围」里加 |
| 排除会话 | 空 | 同上 |
| 状态文件 | `B:\DSH\Agent\_leader-probe\out\observe-trial-state\state.json` | 独立目录，不复用生产 state |
| 轮询 | 5000 ms，每轮最多 50 条 | 五秒一轮，足够观察，不连续打满会话索引 |
| 运行方式 | 隔离 HOME `_leader-probe\test-home` + profile `leader-web` + 空闲端口（示例 59981） | 不写日常 HOME 的配置与状态 |

### `observeOnly` 必须显式写 true

源码判断是 `cfg.observeOnly === true`：

- 明确为 `true` → 不安装宿主级 `agent/pre-step` 守卫、首辅入口拒绝、摘要只允许 dryRun。
- 缺省、`false`、写成字符串 `"true"` → **按完整版运行**，会安装宿主守卫。

所以启动后第一件事是核对（从 `wangchao_status` 工具或面板看）：

```
observeOnly: true
preStepGuardInstalled: false
```

两项不满足就停实例，不要继续。

## 二、启动与停止

启动（隔离 HOME）：

```powershell
$env:DSH_HOME = 'B:\DSH\Agent\_leader-probe\test-home'
dsh --profile leader-web --patch B:\DSH\Agent\leader\observe-trial.yml --no-open --port 59981
```

**不需要关闭日常 desktop**：试用用独立 HOME 与独立端口，两者互不共享配置和状态。只要确认 59981 这个端口是给测试实例用的即可（启动前看一眼有没有被占用）。

判断端口归属，不要只看端口号就停进程：

```powershell
$conn = Get-NetTCPConnection -LocalPort 59981 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $pid = $conn.OwningProcess
  $p = Get-Process -Id $pid -ErrorAction SilentlyContinue
  "$pid $($p.ProcessName) $($p.Path)"
  # 能取命令行时再确认是本次启动的实例（隔离 HOME / leader-web / 59981）
  try { (Get-CimInstance Win32_Process -Filter "ProcessId=$pid").CommandLine } catch {}
}
```

只有命令行能对上 `DSH_HOME=...test-home`、`--profile leader-web`、`--port 59981` 的进程才是本实例。对不上就不动它，换个端口。

停止：

- 前台运行时：`Ctrl+C` 属于正常关闭，优先用它。
- 后台 / cmd 启动时：Windows 下没有可靠的优雅关闭信号，只能终止进程；这时按下面的中断处理。

中断是否打断了采集，依据实际状态判断，不要按时间猜（5 秒是轮询间隔，不是单轮耗时上限）：

```powershell
$dir = 'B:\DSH\Agent\_leader-probe\out\observe-trial-state'
Test-Path "$dir\pending.json"                    # 存在 → 有一轮采集未正常收尾
$st = Get-Content "$dir\state.json" -Raw -Encoding utf8 | ConvertFrom-Json
$st.pollCount; $st.lastPollAt                    # 隔几秒再读一次，pollCount 不再增长才算停了
```

`pending.json` 存在时下次启动会带「上次未正常收尾」标记（`stalePending`）。这个恢复能力只在此前特定的中断窗口验证过，不能当作通用保证——遇到它先看 `wangchao_status` 的 `pollCount`/`lastPollAt` 是否恢复推进，再决定是否继续。

不常驻、不开机自启、不写入 desktop 的 profile 配置。

## 三、试用期间的边界

**读**：只能读允许范围内（`B:\DSH` 下、且不在 `B:\DSH\Agent`）的会话事件与标题；每次打开详情/摘要都用最新会话元数据重新判权。

**写**（只写王朝自己的本地状态，不改任何会话日志）：

- 项目标签（`wangchao_tag`）→ `state.json` 的 `projects`
- 人工摘要修订（`wangchao_correct`）→ `state.json` 的 `summaries`，追加新版本，不覆盖原摘要

**不写**：不向任何会话追加消息、不创建/召见/恢复/释放首辅、不安装宿主级发送前守卫。

**不发模型请求**：`wangchao_summarize` 只有 `dryRun: true` 可用；`dryRun: false` 直接拒绝。

**注意 dryRun 预览本身也含会话内容**：`dryRun` 返回的是拟发送给模型的事件正文、seq 区间与字符数。它不调模型，但内容已经在面板/工具返回里出现，敏感程度与被读取的会话正文相同。

**摘要面板默认是空的**：观察版不生成摘要，新建的 state 没有历史版本，点「版本 / 修订」只会显示「还没有摘要版本」。要让摘要查看有内容，有三种方式：

1. 在同一 `stateDir` 上用完整版生成过摘要，再切观察版读；
2. 从已有 state 迁移版本记录；
3. 在隔离 state 里放**明确标记为测试数据的构造摘要**（或此前假模型生成的测试版本）——不需要启用完整版宿主守卫，也不需要真实模型调用。

第 3 种只验证得了界面与操作（打开面板、选中、提交修订、版本增加），验证不了摘要内容对真实项目是否有意义；后者要真实会话。

## 四、试用步骤

1. 确认 59981 未被占用；被占用就换端口，不去停不属于本实例的进程。日常 desktop 无需关闭。
2. 写 `observe-trial.yml`（内容见上），确认 `observeOnly: true` 与 `stateDir` 指向新目录。
3. 起实例，用日志里的 token 打开面板。
4. 核对模式：`wangchao_status` → `observeOnly:true`、`preStepGuardInstalled:false`。不满足就停，不要继续。
5. 看三视图：项目 / 对话 / 采集范围；采集范围应显示采集诊断行。
6. 抽样点一个会话「版本 / 修订」，确认摘要面板能打开、人工修订能提交并出现「已追加新版本」提示。
7. 试用结束按上面的方式停止（前台优先 Ctrl+C）。

## 五、结束后的保留

**保留状态目录**：`B:\DSH\Agent\_leader-probe\out\observe-trial-state`（内含采集记录、项目标签、人工修订版本）。试用结果要你来查看，所以不做自动清理。

删除该目录会一并清掉标签与人工修订，属于丢弃结果，不是回滚步骤。确实要删时单独确认。

回滚本身很简单：

1. 停实例（见上）。
2. 日常 desktop 无需回滚：本方案没有写过它的 profile 配置、规则文件或会话。
3. 隔离 HOME 的 profile 依赖如需恢复，删掉 `_leader-probe\test-home\profiles\leader-web\node_modules\dsh-wangchao` 后重新复制生产代码。这一条不影响本次试用结论，可以留到需要时再做。

## 六、本轮已验证 / 未验证

已验证（2026-11-06 22:58–23:00，隔离实例）：

- 摘要面板打开、版本内容与来源显示
- 人工修订提交成功（版本数 1 → 2，「已追加新版本」提示可见）
- 规则收紧（加入 `excludeSessions`）后该会话从列表消失（52 → 51），清空后恢复（51 → 52）
- 采集诊断行随规则变化同步更新（可见 52 → 51 → 52）

未验证：

- 真实工作会话（本轮及本次试用都在 `test-home` 隔离环境；要读真实会话按第零节重新定范围）
- 长时间运行（轮询累积、状态文件增长）
- 多实例并发、重启恢复
- `pending.json` 的恢复只在特定中断窗口验证过，不是通用保证
