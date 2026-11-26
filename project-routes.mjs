// T4-A：项目 HTTP 路由定义（纯函数，便于用假 fetchSvc 做真实注册/分发测试）。
// 同路径只注册一次：/project 同时处理 GET(详情)/POST(创建)。
// 所有路由统一做 stateIssue 门禁、非法 JSON→400、相对 URL 安全解析、错误不外泄路径。
const BASE = '/api/dsh-wangchao';

export function buildProjectRoutes({ projectHttp, stateIssue = () => null, jsonResponse }) {
  if (!projectHttp || typeof jsonResponse !== 'function') throw Object.assign(new Error('路由依赖不全'), { code: 'INVALID' });
  const respond = (r) => jsonResponse(r.payload, r.status);
  const withState = async (fn) => {
    if (stateIssue()) return respond({ status: 503, payload: { ok: false, error: '宿主状态不可用' } });
    return fn();
  };
  const readBody = async (request) => {
    let body;
    try { body = await request.json(); }
    catch { return { __invalidJson: true }; }
    // null、数组、字符串、数字等非对象 body 一律 400；不进入业务分发。
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { __invalidJson: true };
    return body;
  };
  const invalidJson = { status: 400, payload: { ok: false, error: '请求体不是有效 JSON 对象' } };

  // key=path，一个 path 只有一个注册项；methods 可含 GET+POST，由 handler 内分流。
  const routes = new Map();
  const define = (path, methods, handler) => {
    const full = BASE + path;
    if (routes.has(full)) throw Object.assign(new Error(`路由重复定义：${full}`), { code: 'INVALID' });
    routes.set(full, { path: full, methods, requestBody: 'buffered', fetch: handler });
  };

  define('/projects', ['GET'], async () => withState(async () => respond(await projectHttp.handle('list', {}))));

  define('/project/recovery-pack', ['GET'], async (request) => withState(async () => {
    let id = null;
    try {
      const raw = String(request?.url ?? '');
      id = new URL(raw, 'http://localhost').searchParams.get('id');
    } catch { id = null; }
    return respond(await projectHttp.handle('recoveryPack', { id: id ?? undefined }));
  }));

  define('/research/search', ['GET'], async (request) => withState(async () => {
    let q = null;
    let limit;
    try {
      const sp = new URL(String(request?.url ?? ''), 'http://localhost').searchParams;
      q = sp.get('q');
      if (sp.has('limit')) limit = sp.get('limit');
    } catch { q = null; }
    return respond(await projectHttp.handle('researchSearch', { q: q ?? undefined, limit }));
  }));

  // /project：同路径合并，GET=详情（id 查询参数），POST=创建
  define('/project', ['GET', 'POST'], async (request) => withState(async () => {
    const method = String(request?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      let id = null;
      try {
        // 相对 URL 用基准补齐后再解析；异常时不抛栈、不外泄路径。
        const raw = String(request?.url ?? '');
        id = new URL(raw, 'http://localhost').searchParams.get('id');
      } catch { id = null; }
      return respond(await projectHttp.handle('get', { id: id ?? undefined }));
    }
    if (method !== 'POST') return respond({ status: 405, payload: { ok: false, error: '方法不允许' } });
    const body = await readBody(request);
    if (body.__invalidJson) return respond(invalidJson);
    return respond(await projectHttp.handle('create', body));
  }));

  // 灵感收件箱：列表只读；捕捉/审阅/纳入研究都是写操作（走同一授权与磁盘锁）。
  define('/project/ideas', ['GET'], async () => withState(async () => respond(await projectHttp.handle('listIdeas', {}))));

  const simplePosts = [
    ['/project/update', 'update'],
    ['/project/transition', 'transitionResearch'],
    ['/project/aliases', 'setAliases'],
    ['/project/link', 'link'],
    ['/project/unlink', 'unlink'],
    ['/project/link/review', 'linkReview'],
    ['/project/fact', 'addFact'],
    ['/project/reminder/review', 'reminderReview'],
    ['/project/idea/capture', 'captureIdea'],
    ['/project/idea/review', 'reviewIdea'],
    ['/project/idea/promote', 'promoteIdea'],
  ];
  for (const [pathName, action] of simplePosts) {
    define(pathName, ['POST'], async (request) => withState(async () => {
      const body = await readBody(request);
      if (body.__invalidJson) return respond(invalidJson);
      return respond(await projectHttp.handle(action, body));
    }));
  }

  // /project/fact/lock：用户主动锁定/解锁事实，locked 必须为布尔值。
  define('/project/fact/lock', ['POST'], async (request) => withState(async () => {
    const body = await readBody(request);
    if (body.__invalidJson) return respond(invalidJson);
    if (typeof body?.locked !== 'boolean') {
      return respond({ status: 400, payload: { ok: false, error: '缺少或非法 locked（必须为布尔值）' } });
    }
    return respond(await projectHttp.handle(body.locked ? 'lockFact' : 'unlockFact', body));
  }));

  // /project/fact/review：统一 decision 字段，缺失/非法→400，禁止默认执行任何审定动作。
  define('/project/fact/review', ['POST'], async (request) => withState(async () => {
    const body = await readBody(request);
    if (body.__invalidJson) return respond(invalidJson);
    const decisionMap = { confirm: 'confirmFact', reject: 'rejectFact', revise: 'reviseFact', supersede: 'supersedeFact' };
    if (!Object.hasOwn(decisionMap, body?.decision)) {
      return respond({ status: 400, payload: { ok: false, error: '缺少或非法 decision（confirm/reject/revise/supersede）' } });
    }
    return respond(await projectHttp.handle(decisionMap[body.decision], body));
  }));

  return [...routes.values()];
}
