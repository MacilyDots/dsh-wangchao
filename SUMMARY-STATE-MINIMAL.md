# 摘要状态：最小设计（可调整，未接生产）

> 只定结构，不定长期格式；种子策略以后可换。

## 一、一次摘要运行（run）

```js
run = {
  id: 'run-<ts>-<rand>',
  state: 'planned' | 'sent' | 'applied' | 'failed' | 'unknown',

  // 计划（可能超预算，不代表会全送）
  plannedSeqs: [3, 5, 9, ...],

  // 实际发送（请求发出前写入，成功与否都保留）
  sentRecords: [
    { seq: 15, type: 'user/message', charFrom: 0, charTo: 300, fullChars: 12527, kind: 'partial' },
    { seq: 18, type: 'assistant/message', charFrom: 0, charTo: 436, fullChars: 436, kind: 'full' },
  ],
  sentChars: 5896,

  requestedAt, respondedAt, appliedAt,
  model: { provider, model, usage },
  summaryVersionId,        // applied 后才有
  error,
}
```

## 二、状态机

```
planned ──→ sent ──→ applied
   │          │
   │          ├──→ failed     （模型报错/空正文）
   │          └──→ unknown    （请求已发出，结果未知：进程中断、超时）
   └──→ failed                （本地准备阶段就失败，未发请求）
```

| 状态 | 含义 | 是否计费 | 是否计入覆盖 |
|---|---|---|---|
| `planned` | 算出要送哪段，**未发请求** | 否 | 否 |
| `sent` | 请求已发出，等待结果 | **可能** | 否 |
| `applied` | 模型返回可用结果 + 写盘成功 | 是 | **是** |
| `failed` | 明确失败（报错/空正文/写盘失败） | 视情况 | 否 |
| `unknown` | 已发出但不知道结果（中断/超时） | **可能** | 否 |

**`unknown` 不自动重试**：可能已经计费。要重发必须由人明确决定，并记一条新 run。

## 三、覆盖由"实际发送"计算，不由计划推进

只有 `state === 'applied'` 的 run 才把 `sentRecords` 并入覆盖：

```js
coverage = {
  seqs: [{ seq, kind: 'full'|'partial', charTo, fullChars }],   // 逐事件
  ranges: [{ from, to }],                                        // 便于展示的连续段
}
```

**关键**：`charTo < fullChars` 就是 `partial`，展示时必须单独说"其中 N 条只送前 300 字，丢 M 字"。

三类"没送"分开记：

| 原因 | 字段 |
|---|---|
| 系统注入过滤 | `excluded.sys[]`（seq + 命中前缀） |
| 无正文事件 | `excluded.noTextCount` |
| 预算跳过 | `excluded.byBudget[]`（seq + 需要字符） |

## 四、输入身份（防止沿用失效区间）

每条送入记录绑定当时的内容指纹：

```js
{ seq, type, charFrom, charTo, fullChars, kind, time, contentLen }
```

**校验**：下次读同一 seq 时，若 `time` 或 `contentLen` 与记录不符 → 该条标 `stale`，所在覆盖段标"待重新核对"，**不沿用旧结论**。

不要求内容哈希（成本高）；`time + contentLen + type` 已能覆盖绝大多数变化。无法确认时一律标 `stale`，不猜。

## 五、撤权优先

- 撤权后：新 run 直接拒绝（`state` 不进入 planned 之后的任何阶段）；
- 已 `applied` 的摘要正文**不返回**（沿用现有判权路径）；
- `coverage`、`runs` 等元数据保留，恢复授权后可继续查看与推进；
- 恢复后是否需要重新核对 `stale`，按第四节规则走。

## 六、unknown 待确认队列（本版新增）

### 6.1 中断窗口与意图持久化

**发送请求之前**先把 run 以 `state: 'intent'` 落盘，再发请求：

```
plan → 写 intent（持久化） → 发请求 → 写 sent → 收响应 → 写 applied
```

重启时：

| 落盘状态 | 处置 |
|---|---|
| `intent`（无 sent 记录） | **保守标 `unknown`**——无法确定请求是否已发出 |
| `sent`（无响应） | 标 `unknown`——请求已发出、结果未知 |
| `applied` | 保持不变 |

**本地状态无法保证外部模型请求"恰好一次"**。这是设计接受的事实，不是缺陷。

### 6.2 队列结构

```js
state.summaries[id].unknown = [
  {
    runId, records: [ {seq, type, charFrom, charTo, fullChars, kind, time, contentLen, fingerprint} ],
    sentChars, intentAt, sentAt,
    possiblyBilled: true,
    resolvedBy: null,        // 重发成功后的新 runId
  }
]
```

### 6.3 展示与操作

- 列表里**独立显示**：来源会话、事件 seq 与字符区间、请求时间、"可能已计费"；
- **不计入已摘要**，不自动重发；
- 用户手动重发时：**新建 run**，带 `replaces: <oldRunId>` 与 `possiblyDoubleBilled: true`，并提示"这次可能重复计费"；
- 重发成功后旧 unknown 记 `resolvedBy`，**但记录不删除**——缺口历史要保留；
- 后续任务可以继续，但缺口在列表里一直可见，不因"跑过一轮"被遮盖。

## 七、内容指纹与隐私

`time + contentLen` 不足以识别"同长度改写"。补一层指纹：

| 内容长度 | 指纹 | 理由 |
|---|---|---|
| ≥ 100 字 | `sha256(type \0 time \0 text)` 前 16 位 | 内容足够长，碰撞概率低 |
| < 100 字 | `short:time:len` | 短文本哈希可被字典猜测，存哈希等于间接泄露 |

**隐私风险与保存范围**：

- 指纹存在 `state.json` 里，**只存哈希/长度，不存正文**；
- 长文本的 sha256 不可逆，但**已知原文的人可以验证**（比对哈希即可确认某句话在不在会话里）；
- 短文本（如"好的""继续"）**不存哈希**，避免被穷举还原；
- 指纹只用于"这段覆盖是否还对应同一内容"，不用于任何展示或导出。

**无法确认版本一致时**：标 `stale` / "待核对"，**不沿用旧覆盖结论**。

## 八、假模型验证（unknown 队列三条）

脚本 `_leader-probe/stage2-unknown-sim.mjs`：

| 场景 | 结果 |
|---|---|
| 1 发送前中断 | intent 已落盘、**假模型调用 0 次**；重启后 run-1 → `unknown`，缺口 `2-32` 可见 |
| 2 发送后结果未知 | sent 已落盘；重启后 → `unknown`，缺口可见 |
| 3 用户明确重发 | 新建 `run-2`、`replaces: run-1`、`possiblyDoubleBilled: true`；成功后 coverage 31（21 full + 10 partial），**旧 unknown 仍保留** |
| 4 重发后再次中断 | 两个 `unknown` 并存（run-1、run-2），缺口 `2-32` 出现两次、都可见 |

**关键**：没有任何一条路径会自动重发；缺口不会因为后续 run 成功而消失。

## 九、已知不足

| 现有 | 新结构 | 说明 |
|---|---|---|
| `state.sessions[id].watermark` | 不动 | 仍是**采集**水位 |
| `state.summaries[id][]` | 不动 | 摘要版本存储 |
| 新增 `state.summaries[id].runs[]` | 新 | 每次 run 的记录 |
| 新增 `state.summaries[id].coverage` | 新 | 由 applied 的 run 计算 |

**本轮不写入生产 state**，只做设计与模拟。

## 十、为什么这是"最小可调整"

- 不绑定种子策略：`run` 只管"这次送了什么"，策略层决定 `plannedSeqs` 怎么来；
- 不绑定模型：`model` 字段不参与逻辑；
- 覆盖与 run 解耦：以后换摘要算法，只要 `sentRecords` 语义不变，覆盖计算就不用改。

## 十一、已知不足（补充）

- 没有做内容哈希，`time + contentLen` 可能漏掉"同长度改写"；
- `unknown` 的人工确认流程还没设计；
- 覆盖是**逐事件**粒度，不是"这段摘要覆盖了哪些结论"——后者需要质量对照，本轮不做。
