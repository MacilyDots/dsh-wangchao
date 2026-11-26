# AP-06 发布准备与真实环境验收交付报告

**日期**：2026-11-26
**基线裁决**：接受 AP-05-R1 独立增量复审 `CONDITIONAL PASS`；批准 alpha.5 晋级正式离线候选
**版本**：`0.5.0-alpha.5.1`（F-05 小补丁）
**授权边界**：未发布、未推送、未部署生产、未调用真实商业模型

---

## 1. 基线、分支与冻结

| 项 | 值 |
|---|---|
| 上游代码 HEAD | `279da2415c6dd95fa71ee7a0d45e48807f6d1751`（AP-05-R1） |
| 工作分支 | `ap06/alpha5.1`（从 `351870f` 拉出） |
| alpha.5.1 代码 HEAD | `e48f5a346e793c0db14e6148528f803838a87805` |
| 失败候选（保留） | `_t5\ap05-r1-frozen-failed-candidate\dsh-wangchao-0.5.0-alpha.5.failed.tgz`，SHA-256 `6F2EDFA8…` |
| R1 候选（保留） | `_t5\alpha5-r1-public-candidate` HEAD `ed1b4ab`；tarball SHA-256 `C7864DAC…` |
| 生产 | HEAD `c8a2609` 未变，27 个既有未提交改动保持 |

## 2. A 线：F-05 修复与 alpha.5.1 候选

### 2.1 F-05（P2）：已覆盖排除字段再次清空缺少确认

**原因**：UI 的 `inheritedExcludes` 与 `risky` 都附加了 `explicitFields.indexOf(k) < 0`，与服务端“只要基线非空且提交空数组就要求确认”的口径不一致；该字段被面板覆盖过后，UI 不再显示确认勾选框，提交被服务端 400 拦截。

**修复**（`client.js`）：
- 移除两处 `explicitFields` 条件，与服务端口径一致；
- 确认勾选框在“基线该维度非空”时始终显示（无论是否已覆盖）；
- 未确认 / 取消确认都不会发请求；确认后带 `confirmClearExclude:true`；
- 单字段「恢复为继承配置」只提交 `{ [field]: null }`。

**服务端 `confirm-required` 门禁未改动**（`index.mjs` 仍拒绝无确认的空排除提交）。

### 2.2 新增测试

- `test/rules-e2e.test.mjs`：新增“覆盖后再次清空仍需确认”（400 → 确认 200），与既有首次清空、取消、null 恢复、无关字段保存、重启、撤权用例组合覆盖五类场景。
- `test/standalone-refs.test.mjs`：规则 UI 用例改为 `explicitFields=['allowCwds','excludeCwds']`，覆盖：
  1. 首次清空（未确认拦截）；
  2. 覆盖后清空（仍显示确认）；
  3. 勾选后取消确认（不发请求）；
  4. 确认后提交（带 `confirmClearExclude`）；
  5. 恢复继承（只提交该字段 null）；
  6. 无关字段保存（只提交 `allowCwds`）。
- 原始输出：`_t5\ap06-evidence\full-tests.txt`。

### 2.3 报告与版本

- `AP05-R1-SECURITY-CLOSURE-DELIVERY.md` 的“66 文件”更正为 **67 文件**（两处副本均已同步）。
- `package.json` → `0.5.0-alpha.5.1`；CHANGELOG 增加 alpha.5.1 条目。

### 2.4 增量与候选

| 项 | 值 |
|---|---|
| 增量 diff | `_t5\ap06-evidence\alpha5.1-incremental.diff`（`351870f..e48f5a3`，6 文件，+53/−8） |
| 公开候选树 | `_t5\alpha5-1-public-candidate`，HEAD `41e1ca6315b259763c81443f584f909a6da3c213` |
| tarball | `_t5\alpha5-1-release\dsh-wangchao-0.5.0-alpha.5.1.tgz` |
| 大小 / SHA-256 | 373,856 B / `1B54CF5A8A098F2768D5BEDE2C7807B9B2925E599F38950364A468D569F6FC01` |
| manifest | 同目录 `manifest.json`（52/52 逐文件 SHA-256） |
| 发布审计 | `_t5\ap06-evidence\publish-audit-alpha5.1.txt` 全部通过（本地工作区、npm pack、全历史；4 处人工确认误报豁免） |

## 3. B 线：真实环境验收

### 3.1 W21 junction（非受限 Windows 环境）

独立探针 `_t5\ap06-evidence\w21-junction-probe.mjs`：

```json
{
  "node": "v24.19.0", "platform": "win32", "release": "10.0.26300", "arch": "x64",
  "junction": { "ok": true, "isSymbolicLink": true, "realpathEqual": true },
  "w21": { "exitCode": 0, "pass": true,
    "stdout": ["✔ W21 路径别名（junction）不能绕过写锁 (9.641ms)", "ℹ tests 1", "ℹ pass 1", "ℹ fail 0"] }
}
```

原始文件：`w21-junction-probe.json`、`w21-raw.txt`。结论：**VERIFIED PASS（本机非受限环境）**；Gemini 沙盒中的 EPERM 未复现。

### 3.2 Electron / SEC-1C 阻断

`_t5\ap06-evidence\AP06-ELECTRON-SEC1C-BLOCKERS.md`（DOCUMENT REVIEW）：

- Win11 Sandbox 组件已启用，但 guest 首次初始化三次均停在启动徽标（BLOCKED）；
- 阶段 C–E 未通过，`finalApproved=false`，阶段 E Electron 真机 `NOT RUN`；
- 本轮未启动 Sandbox/Electron、未改系统/BIOS、未提权；
- 解锁需独立隔离测试机或用户裁决，以及最终归档/清单/激活证据绑定审核。

### 3.3 隔离 DSH Web GUI 实测

环境：临时 `DSH_HOME`（`_t5\ap06-webgui-home`）+ 新建 profile `ap06web` + 从 alpha.5.1 tarball 安装插件；`dsh --profile ap06web --no-open --port 61777`；无真实模型、无生产 profile/state 写入。

通过 CDP 驱动 headless Edge（`_t5\ap06-evidence\webgui-cdp-probe.mjs`），结果：

```json
{
  "urlLoaded": true, "sidebarHasWangchao": true, "clicked": true,
  "panelHasRoleSeats": true, "panelHasInspirationInbox": true,
  "panelHasScopeEntry": true, "scopeClicked": true,
  "scopeDrawerHasRules": true, "scopeDrawerHasSource": true
}
```

截图：`webgui-main.png`（御书房在真实 DSH Web GUI 内挂载）、`webgui-rules.png`（规则抽屉与“来源”标注）。原始日志已脱敏（一次性 token → `[REDACTED]`）。

**证据等级**：VERIFIED（真实 DSH Web GUI 宿主挂载 + 规则抽屉渲染）；交互细节（灵感/阶段/事实/恢复包/首辅/翰林院）仍为组件级验证，见第 5 节。

### 3.4 首辅真实 agent 与翰林院验收方案

`_t5\ap06-evidence\AP06-REAL-AGENT-ACCEPTANCE-PLAN.md`：

- 隔离 fake provider 路径（现在可执行）：召见不跳转、只读守卫、`sinceSeq` 窗口、fake 奏折缓存/force/单飞；
- 真实路由路径（需用户逐项授权）：凭据存在性、预算门禁、路由白名单、单次/总请求上限、失败即停；
- 未执行真实商业调用，未开启 Executor/自动审批。

## 4. C 线：发布安全准备

### 4.1 远端克隆第 3/4 步

`_t5\ap06-evidence\publish-audit-remote.txt`：

- 远端工作区 57 文件、远端全历史扫描：**无命中**；
- 可见性：PUBLIC；
- HEAD 不一致（本地候选 `41e1ca6` / 远端 `c8a2609`）——**符合预期**，远端仍是 alpha.4.1；未推送。
- 说明：第 3/4 步机制已跑通；正式发布时需在推送后复跑并确认 HEAD 一致。

### 4.2 alpha.4.1 风险通告与补丁成本（重要更正）

**更正**：R1 报告曾以本地 `limited-ai` 包（`1C4DA2B5…`）推断公开版；本次重新拉取 **npm 实际发布物** `dsh-wangchao@0.5.0-alpha.4.1`（SHA-256 `D39EB65FCE437ECF85E8ACC1F034078588656021B307CC46FE8D4729C5078949`，52 文件，357,895 B）复核：

| 项 | npm alpha.4.1 | alpha.5.1 |
|---|---|---|
| 规则 | 按字段“非空覆盖、空数组回落”；无迁移 | 三态合并 + 维度迁移 |
| UI 保存 | 全量四字段 | 稀疏 + 确认门禁 |
| 自动接管 | **有**（盲 `rmSync`、审计 fail-open、不推进 epoch、无写前 token 校验） | 两阶段安全时序 |

- **F-01 形态不同**：公开 alpha.4.1 不会因迁移清空拒绝项；但面板保存后配置被冻结，配置后来新增的拒绝项可能被旧的非空 override 遮蔽。合成探针 `alpha41-rule-risk-probe.json`：`new-deny` → `allowed-by-cwd`，`old-deny` → `excluded-by-session`。
- **F-02 适用**：公开 alpha.4.1 的自动接管与 R1 修复前的 alpha.5 同类（TOCTOU、双竞争者、误删新锁、审计 fail-open、旧写者无写前 fencing）。
- 通告与临时规避：`_t5\ALPHA41-EXCLUDE-RISK-NOTICE.md`。
- 最小补丁成本：仅 F-02 约 0.5–1 人日；F-01+F-02 约 2 人日（4 文件 + 测试 + 发布流程）；直接以 alpha.5.1 替换实现成本最低。**未执行任何补丁/发版**。

### 4.3 公开候选一致性

`_t5\ap06-evidence\candidate-consistency.json`（`check-candidate.mjs`）：

```json
{
  "version": "0.5.0-alpha.5.1", "versionOk": true, "privateFlag": false,
  "dependencies": null, "devDependencies": null, "scripts": null,
  "tarballBytes": 373856,
  "tarballSha256": "1B54CF5A8A098F2768D5BEDE2C7807B9B2925E599F38950364A468D569F6FC01",
  "manifestHashOk": true, "tarFileCount": 52, "manifestFileCount": 52,
  "fileSetMatchesManifest": true, "hashMismatch": [], "forbidden": [], "ok": true
}
```

无运行时依赖、无 devDependencies、无引用 `checks/`/`test/` 的 scripts；版本与 manifest 一致；敏感词扫描零命中。

## 5. 证据等级矩阵

| 项目 | 等级 | 依据 |
|---|---|---|
| F-05 修复与 UI 确认 | **VERIFIED PASS** | 源码 diff + 规则 UI 渲染测试 + 服务端 e2e（首次/覆盖后/取消/恢复/无关字段） |
| alpha.5.1 全量离线回归 | **VERIFIED PASS** | 67 文件、409 tests、408 pass、0 fail、1 skipped；原始输出归档 |
| `checks/all.mjs` | **VERIFIED PASS** | 6/6 组、45 断言；原始输出归档 |
| W21 junction | **VERIFIED PASS** | 非受限本机 junction 创建成功 + W21 1/1；原始 JSON 归档 |
| DSH Web GUI 宿主挂载 | **VERIFIED** | 隔离 profile + 真 Edge CDP：侧栏入口、御书房面板、规则抽屉与来源标注；截图归档 |
| 规则/灵感/阶段/事实/恢复包交互 | **VERIFIED（组件级）** | 真 client.js + mini-react + 假 DOM；非真实宿主点击 |
| 首辅/翰林院真实 agent 往返 | **NOT VERIFIED** | 仅方案；真实模型未调用 |
| Electron 真机 / SEC-1C | **NOT VERIFIED / BLOCKED** | SEC-1C 文档；未启动 |
| 真实商业模型 / Executor | **NOT COVERED** | 未授权 |
| 远端克隆 HEAD 一致 | **NOT VERIFIED（预期不一致）** | 远端仍 alpha.4.1；未推送 |
| alpha.4.1 风险 | **VERIFIED（只读探针）** | npm 实际包源码 + 合成 state/decideAccess；未在生产复现危险竞态 |
| alpha.4.1 补丁 | **NOT IMPLEMENTED** | 仅成本评估 |

## 6. 冻结指纹（AP-06 交付）

| 对象 | 值 |
|---|---|
| alpha.5.1 代码 HEAD | `e48f5a346e793c0db14e6148528f803838a87805` |
| 公开候选 HEAD | `41e1ca6315b259763c81443f584f909a6da3c213` |
| tarball | 373,856 B / `1B54CF5A8A098F2768D5BEDE2C7807B9B2925E599F38950364A468D569F6FC01` |
| manifest | 52 文件全匹配 |
| R1 候选/失败候选 | 均保留，未被覆盖 |
| 生产 leader | `c8a2609`，关键文件 SHA-256 与开工基线一致 |

## 7. 遗留问题与待裁决

1. **alpha.4.1 公开版风险处置**：是否紧急补丁、发布通告或以 alpha.5.1 替换，需项目经理与用户裁决；本轮只准备通告与成本评估。
2. **Electron / SEC-1C**：guest 启动死锁未解，Electron 真机 `NOT RUN`；需独立隔离测试机或裁决豁免。
3. **真实模型/首辅/翰林院**：验收方案就绪，未执行；不得在未授权时调用。
4. **远端克隆第 3/4 步**：机制已跑通，HEAD 一致性需发布推送后复跑。
5. **DSH Web GUI 交互深度**：仅验证挂载、规则抽屉与来源标注；灵感捕捉、阶段切换、事实锁定、恢复包复制、首辅发送未在真实宿主点击（组件级已验）。
6. **测试 skipped 1**：node:test 汇总计数，未计入 PASS。

---

**候选与证据已冻结；未执行 npm publish、dist-tag、GitHub Release、远端推送、生产部署或真实商业模型调用。等待 Gemini 联合审核与项目经理裁决。**
