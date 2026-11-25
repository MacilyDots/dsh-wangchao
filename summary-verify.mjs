// 宿主摘要校验适配器（T2 证据层的 fail-closed 判定）。
// 宿主接线时把真实 state.summaries / state.summaryRuns / 运行时 unsavedRuns 注入本工厂，
// 得到的 verifySummary 回调交给 createProjectStore。
// 判定契约（与 index.mjs 实现核对）：
//   · versionId 必须存在于 state.summaries[sessionId]（与 sessionId 绑定，防止跨会话 id 复用）；
//   · model 版本由 state==='applied' + appliedAt 的 run 证明已落盘；
//   · run 仍在运行时 unsavedRuns（模型已返回但写盘失败/未确认）时视为未持久化。
// human-edit（人工修订摘要）走与 model 不同的持久化路径（state.corrections/版本追加，无 applied run）。
// 本适配器不对 human-edit 的持久化作契约断言；T2 在无法从注入数据取得可靠持久化证明时
// 一律 fail-closed 拒绝（如下面要求一条可用 run 作为保守证据），完整 human-edit 可信接线留 T4。
// 任何缺失、异常、结构不符一律 false（fail-closed）。
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createSummaryVerifier({ summaries, summaryRuns, unsavedRuns } = {}) {
  return function verifySummary({ sessionId, versionId } = {}) {
    try {
      if (typeof sessionId !== 'string' || !sessionId || typeof versionId !== 'string' || !versionId) return false;
      const versions = summaries?.[sessionId];
      if (!Array.isArray(versions)) return false;
      const version = versions.find((v) => isObj(v) && v.id === versionId);
      if (!version) return false; // 版本不存在或不属于该会话（含伪造）→ 拒绝
      const runs = Array.isArray(summaryRuns?.[sessionId]) ? summaryRuns[sessionId] : [];
      const appliedRun = runs.find((r) => isObj(r) && r.summaryVersionId === versionId
        && r.state === 'applied' && typeof r.appliedAt === 'number' && Number.isFinite(r.appliedAt));
      if (!appliedRun) return false;
      if (unsavedRuns && typeof unsavedRuns.has === 'function' && unsavedRuns.has(appliedRun.id)) return false;
      // T2 保守策略：无论 model 还是 human-edit，都要求一条本会话的可用 applied run
      // 作为“已持久化”的可验证证据；无证据则 fail-closed 拒绝（不是对 human-edit 宿主契约的断言）。
      // human-edit 的完整可信证明机制留到 T4 设计。
      return true;
    } catch {
      return false;
    }
  };
}
