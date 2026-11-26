# 观察试用版（observeOnly）

只做采集与面板读取，**在执行路径上禁用首辅与宿主级守卫，默认不调用模型**。用于在隔离环境判断御书房是否有实际价值，不接真实对话。

## 启动方式

```powershell
$env:DSH_HOME = 'B:\DSH\Agent\_leader-probe\test-home'
dsh --profile leader-web --patch <observe-patch.yml> --no-open --port 59931
```

patch 内容：

```yaml
- insert:
    - id: dsh-wangchao
      name: dsh-wangchao
      config:
        allowCwds: [B:/DSH]
        excludeCwds: [B:\DSH\Agent]
        pollIntervalMs: 5000
        maxSessionsPerPoll: 50
        observeOnly: true
        stateDir: B:/DSH/Agent/_leader-probe/out/observe-state
```

## 禁用了什么（执行路径，不是界面隐藏）

| 项 | 实现位置 | 证据（2026-11-06 重跑） |
|---|---|---|
| 宿主级 `agent/pre-step` 守卫 | 插件加载：`preStepGuardInstalled = cfg.observeOnly === true ? false : installHostPreStepGuard()` | `wangchao_status` 直接返回 `preStepGuardInstalled=false`（观察版）/ `true`（对照），同一份 state |
| 首辅工具入口（11 个） | 每个工具 `execute` 开头统一拒绝：`status / create / resume / close / recover / summon / release / append / selftest / inspect`；`wangchao_detail` 不在其列 | 逐项调用 11 项全部 `{ok:false, error:'观察版未启用首辅（observeOnly）'}` |
| 首辅实现函数（共享层，HTTP 也走） | `chiefCreate` / `chiefSummon` / `chiefResumeProbe` / `chiefRelease` / `chiefClose` / `chiefRecover` 六个函数第一行拒绝 | HTTP `POST /api/dsh-wangchao/chief` 的 `summon` 与 `release` 都返回 `ok:false`，且 state 的 `chief`/`chiefs` 指纹前后不变（hash 相同） |
| 摘要模型调用 | `wangchao_summarize`：`observeOnly === true && dryRun === false` 直接拒绝 | `dryRun:true` 正常返回拟发送内容；`dryRun:false` 返回「观察版默认不调用摘要模型（observeOnly）：仅允许 dryRun」 |

**对照**（同一份含首辅记录的 state、`observeOnly: false`）：`wangchao_chief_status` 返回 `chief`、`wangchao_chief_recover` 返回 `exists:true`、HTTP `summon` → `ok:true`、`release` → `released:true`，且 state 指纹 `82a799… → 8a1030…` 发生变化。拒绝确实由开关触发。

## 没禁用的（有意保留）

| 项 | 理由 |
|---|---|
| `wangchao_detail`（读被采集会话的事件） | 它读的是允许名单内的业务会话，与首辅无关；观察版的核心用途就是这个 |
| `wangchao_tag`（写项目标签） | 写的是王朝自己的本地状态，不改动会话日志；属于第一阶段的整理能力 |
| `wangchao_correct`（人工摘要修订，追加新版本） | 同上，写本地 `summaries`，不覆盖原摘要、不改会话 |
| HTTP `/summaries`（查看已有摘要版本） | 只读本地版本记录，提交时实时判权 |

界面在面板顶部写明了这一点：观察版会写本地记录，但不改会话日志。

**`dryRun` 的预览同样含会话内容**：它返回拟发送给模型的事件正文、seq 区间与字符数。不调模型，但内容已经出现在界面/工具返回里，敏感程度与被读取的会话正文相同——试用时按「已读到这些内容」对待。

**判权是「任一命中即允许」**：`allowSessions` 命中就放行，不再看 `allowCwds`；按会话名单收窄时必须把 `allowCwds` 留空，否则该目录下其它会话会一起进来。

试用配置、启动/停止、回滚步骤见 [OBSERVE-TRIAL.md](OBSERVE-TRIAL.md)；真实会话的价值验证准备见 [OBSERVE-VALUE-PLAN.md](OBSERVE-VALUE-PLAN.md)。

## 采集诊断（面板「采集范围」栏）

`/api/dsh-wangchao/overview` 新增 `diagnostics` 字段，用于回答「列表为什么是 0 条」：

```
采集诊断：state 记录 52 · 实时索引 160 · 索引匹配 51 · 缺 cwd 0 · 当前可见 51
最近一轮（startup）：允许 51 · 同步 48 · 新增事件 0 · 延后 0 · 失败 0
跳过 {"excluded-chief":102,"denied-by-unresolvable-cwd":2,"excluded-by-cwd":5,"unavailable-cooldown":3}
```

- `stateSessions`：`state.json` 里记录数（可能来自以前的采集，不等于本轮采集过）
- `liveIndex` / `liveMatched` / `missingLiveCwd`：实时会话索引总数、能匹配上的数量、缺 cwd 的数量
- `allowedInView`：经过规则与索引双重判定后实际可见的数量
- `lastPoll`：最近一轮的允许/同步/延后/失败计数与跳过原因分类

## 当前限制

1. **`/sessions` 返回 0 的问题未复现，也不能归因**。旧记录 `observe-run*.log` 只有 `sessions: count=0` 一行，没有 HTTP 状态；旧脚本 `api-chief.mjs` 的 sessions 分支只数 `body.sessions`，401/500/空列表都会记成 0。本轮用同一份旧 `observe-state` 与干净采集 state 各跑一次，`/sessions` 均返回 `200` + 52 条。所以此前的「探针取数问题」判断**证据不足**，只能记为「当时未打印状态，无法回溯；当前版本不复现」。
2. 首辅入口是「拒绝」而不是「不存在」：工具仍然注册，只是 execute 直接返回错误。
3. `wangchao_summarize` 的 `dryRun=false` 目前一律拒绝；接模型与预算配置后再单独开。
4. 摘要与人工修订已在隔离环境的浏览器里走通（打开面板 → 提交 → 版本数 1→2），但未在真实日常会话上验证。
5. 52 条 state 不等于「本轮采集了 52 条」：`pollCount` 与 `lastPoll` 才反映本次运行。

## 结论口径

- ✅ 能与干净 state 起、能采集（52 条，允许 51/52、同步 48–49）
- ✅ 11 个首辅工具入口 + HTTP summon/release 全部拒绝，且 state 不变（有 false 对照）
- ✅ 宿主守卫不安装（`preStepGuardInstalled=false`，有对照）
- ✅ 详情读取、项目标签、摘要查看、人工修订可用；`dryRun` 不调模型、非 dry-run 被拒
- ✅ 浏览器实测：项目视图 1 个分组（51 会话）、对话视图 51 行、采集范围显示诊断；观察版提示与实际行为一致
- ✅ 浏览器实测（试用前回归）：摘要面板可打开、人工修订提交成功并显示「已追加新版本」、规则收紧后该会话从列表消失（52→51）、清空后恢复（51→52）
- ✅ 试用配置文件 `observe-trial.yml` 可直接启动，`observeOnly:true`、采集 52 条、首辅入口拒绝
- ❌ `/sessions=0` 未能复现也无法归因（缺少旧日志的 HTTP 状态）
- ❌ 不安装到日常 desktop：本方案只在隔离 HOME 验证
