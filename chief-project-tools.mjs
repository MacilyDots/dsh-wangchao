// T4-B：首辅项目只读工具（纯 Node，不依赖 Cordis）。
// 只读：绝不暴露任何写方法；每次调用重建带实时授权的 store（复用 T4-A 同一授权构造）。
// 不向首辅上下文自动注入全量项目数据：projects 只返回数量+元数据+计数，detail 需显式 projectId。

/**
 * @param {object} deps
 * @param {() => Promise<{store:any, stillValid:()=>boolean}>} deps.forRequest
 *   T4-A 的同一构造：await liveCwdMap → 同步 canAccessSession → createProjectStore。
 * @param {() => any} [deps.stateIssue] 宿主状态损坏判定，非 null 时拒绝读取。
 */
export function createChiefProjectTools({ forRequest, stateIssue = () => null } = {}) {
  if (typeof forRequest !== 'function') throw Object.assign(new Error('forRequest 必须提供'), { code: 'INVALID' });
  const noStore = () => ({ ok: false, error: '项目状态不可用' });

  /** wangchao_projects：仅返回授权可见项目的元数据与计数，不含事实正文/会话正文。 */
  const projects = async () => {
    try {
      if (stateIssue()) return noStore();
      const { store, stillValid } = await forRequest();
      const view = store.list();
      if (!stillValid()) return { ok: false, error: '读取期间授权规则变化，请重试' };
      if (stateIssue()) return noStore();
      return {
        ok: true,
        count: view.projects.length,
        projects: view.projects.map((p) => ({
          projectId: p.projectId, title: p.title, goal: p.goal,
          lifecycle: p.lifecycle, revision: p.revision, factCount: p.factCount, updatedAt: p.updatedAt,
        })),
        pendingReminderCount: view.increments.reminders.filter((r) => r.status === 'pending').length,
        hint: '可用 wangchao_project_detail(projectId) 查询单个项目的详情与证据。',
      };
    } catch (e) {
      return { ok: false, error: '项目状态读取失败' };
    }
  };

  /** wangchao_project_detail：显式 projectId；只读，不返回原始会话正文。 */
  const detail = async ({ projectId } = {}) => {
    if (typeof projectId !== 'string' || !projectId.trim()) return { ok: false, error: '缺少 projectId' };
    try {
      if (stateIssue()) return noStore();
      const { store, stillValid } = await forRequest();
      const d = store.get(projectId);
      if (!stillValid()) return { ok: false, error: '读取期间授权规则变化，请重试' };
      if (stateIssue()) return noStore();
      return {
        ok: true,
        project: d.project,
        links: d.links,
        facts: d.facts,
        changes: d.changes,
        reminders: d.reminders,
        watermarks: d.watermarks,
      };
    } catch (e) {
      // 不回显本机路径/磁盘错误原文，只给语义化失败。
      return { ok: false, error: e?.code === 'NOT_FOUND' ? '项目不存在' : '项目详情读取失败' };
    }
  };

  // 工具定义（供 index.mjs 注册）。description 明确只读、无写入、不自动注入全量数据。
  const definitions = [
    {
      name: 'wangchao_projects',
      description: '列出当前授权的王朝项目：只返回项目元数据与事实/提醒计数，不含会话正文或事实全文。调 wangchao_project_detail(projectId) 查单个项目。只读工具。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => projects(),
    },
    {
      name: 'wangchao_project_detail',
      description: '按 projectId 读取单个授权项目的详情：关联会话、带证据的项目事实、人工变更审计、待审阅提醒与来源可访问性。只读工具，不修改任何项目状态。',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: '项目稳定 ID，由 wangchao_projects 返回' } },
        required: ['projectId'],
        additionalProperties: false,
      },
      execute: async (args) => detail({ projectId: args?.projectId }),
    },
  ];

  return { projects, detail, definitions };
}

// 供 CHIEF_READONLY_ALLOW 使用的工具名（单一来源，避免注册与白名单漂移）。
export const CHIEF_PROJECT_TOOL_NAMES = ['wangchao_projects', 'wangchao_project_detail'];
