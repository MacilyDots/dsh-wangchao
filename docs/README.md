# 文档索引

本目录只放**权威文档**。历史文档在 `docs/archive/`，保留原貌，不再更新。

## 权威文档（唯一有效）

| 文档 | 作用 | 什么时候看 |
|---|---|---|
| [`../ROADMAP.md`](../ROADMAP.md) | **唯一权威路线图**。六类状态：已交付 / 已实现未接线 / 有意冻结 / 未实现 / 已废弃 / 待重新决策 | 想知道「某功能到底有没有、能不能用」 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 逐版本变更与验证记录 | 想知道「这个版本改了什么」 |
| [`../README.md`](../README.md) / [`../README.en.md`](../README.en.md) | 使用说明 | 装与用 |
| [`../NAMING.md`](../NAMING.md) | 命名与术语体系 | 写代码/写文档前对齐叫法 |
| [`../SECURITY-ADVISORY.md`](../SECURITY-ADVISORY.md) | 安全通告 | 部署前必读 |
| [`../DEVELOPMENT-DIARY.md`](../DEVELOPMENT-DIARY.md) | 开发日记（实测记录，按时间累积） | 查「当时为什么这么定」 |

## 设计文档

| 文档 | 主题 |
|---|---|
| [`../UI-DESIGN.md`](../UI-DESIGN.md) | 御书房界面设计 |
| [`../SUMMARY-COVERAGE-DESIGN.md`](../SUMMARY-COVERAGE-DESIGN.md) | 摘要覆盖区间不变量 |
| [`../SUMMARY-STATE-MINIMAL.md`](../SUMMARY-STATE-MINIMAL.md) | 摘要状态最小集 |
| [`../OBSERVE-MODE.md`](../OBSERVE-MODE.md) / [`../OBSERVE-TRIAL.md`](../OBSERVE-TRIAL.md) / [`../OBSERVE-VALUE-PLAN.md`](../OBSERVE-VALUE-PLAN.md) | 观察模式 |
| [`../PERF-BASELINE-PLAN.md`](../PERF-BASELINE-PLAN.md) | 性能基线 |

## 交付与验收报告

`AP05-*` / `AP06-DELIVERY.md` 等按工作包命名的报告，是**当时的验收证据**，不是当前状态描述。当前状态以 `ROADMAP.md` 为准。

## 归档

[`archive/`](archive/) 下是历史 ROADMAP 与早期设计。**不再更新、不再具有计划效力**，只用于追溯。

## 维护约定

1. 新增文档先想清楚它属于上表哪一类，不属于就别加。
2. 状态变更只改 `ROADMAP.md`，不要在每个文档里各写一份「当前进度」。
3. 归档用移动，不用删除；归档文件保持原貌，不改内容。
4. 移动文档前先确认没有脚本/测试引用它的路径。
