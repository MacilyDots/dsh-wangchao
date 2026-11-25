// 执行准入证据（v0.5.0-alpha.3，工作线 B）。
//
// 取代「裸布尔 execLifecycleVerified」作为派发依据：派发是否允许由一组**实测项**
// 组成的证据对象决定，任一项缺失/不可确认即拒绝。单一配置布尔只能是证据的一项，
// 不能独立打开执行入口。
//
// 证据六项（外加任务归属，派发阶段强制）：
//   1. config     —— 配置口径：隔离 fake 首辅 + 本版冻结的执行路由 + 声明位
//   2. guard      —— 根作用域守卫（安装/scope，派发阶段还要求功能探针通过）
//   3. lifecycle  —— 生命周期记录可读（非损坏/非粘住/非卸载中）
//   4. gate       —— 预算门禁 ready
//   5. writer     —— writer epoch / 锁 / 注册表口径（同 epoch、phase=open）
//   6. identity   —— 共享执行子会话集合与任务归属（childId ↔ taskId 双向可核验）
//
// 本模块是纯函数：不读生产数据、不调模型、不起执行器；所有输入由调用方实测注入。
// 不提供任何「跳过校验」参数；未知字段、错误类型、null 一律按不可确认处理。

export const EXEC_ADMISSION_VERSION = 1;
export const ADMISSION_STAGES = Object.freeze(['confirm', 'dispatch']);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isSafeInt = (v) => Number.isSafeInteger(v);
const isEpoch = (v) => isSafeInt(v) && v >= 0;

/**
 * 本版执行路由口径：未显式配置（继承 fake 首辅）或显式 fake/fake-1 才允许。
 * 真实路由（如 deepseek-official/deepseek-flash）一律拒绝；不做「首辅 fake 即放行」。
 */
export function isExecRouteFrozen(input = {}) {
  const p = isNonEmptyString(input?.execProvider) ? input.execProvider : null;
  const m = isNonEmptyString(input?.execModel) ? input.execModel : null;
  if (p === null && m === null) return true;
  return p === 'fake' && m === 'fake-1';
}

/**
 * 任务归属核验：childId 必须由任务 id 派生、登记进共享集合、且能反查到同一 taskId。
 * 只按请求体字段认定一律不算数：这里只接受调用方闭包持有的 Set/Map 引用。
 */
export function verifyExecTaskBinding(input = {}) {
  const checks = {
    taskId: isNonEmptyString(input?.taskId),
    childId: isNonEmptyString(input?.childId) && input.childId.startsWith('session-exec-'),
    childrenSet: input?.children instanceof Set,
    taskRootsMap: input?.taskRoots instanceof Map,
    taskChildrenMap: input?.taskChildren instanceof Map,
  };
  if (checks.childrenSet) checks.registeredChild = input.children.has(input.childId);
  else checks.registeredChild = false;
  if (checks.taskRootsMap) checks.taskRootRegistered = input.taskRoots.has(input.childId);
  else checks.taskRootRegistered = false;
  if (checks.taskChildrenMap) checks.taskBound = input.taskChildren.get(input.taskId) === input.childId;
  else checks.taskBound = false;
  const ok = Object.values(checks).every((v) => v === true);
  return { ok, checks };
}

/**
 * 组装并判定准入证据。
 * @param {{stage?: string, config?: object, guard?: object, lifecycle?: object,
 *   gate?: object, writer?: object, identity?: object}} input
 * @returns {{ok: boolean, stage: string|null, evidence: object, reasons: string[]}}
 */
export function assembleExecAdmission(input = {}) {
  const stage = ADMISSION_STAGES.includes(input?.stage) ? input.stage : null;
  const cfg = input?.config ?? {};
  const guard = input?.guard ?? {};
  const lc = input?.lifecycle ?? {};
  const gate = input?.gate ?? {};
  const writer = input?.writer ?? {};
  const identity = input?.identity ?? {};
  const reasons = [];
  const check = (name, pass) => { if (pass !== true) reasons.push(name); return pass === true; };

  const routeFrozen = isExecRouteFrozen(cfg);
  const evidence = {
    version: EXEC_ADMISSION_VERSION,
    stage,
    config: {
      isolatedTestExecution: check('config.isolatedTestExecution', cfg.isolatedTestExecution === true),
      chiefProviderFake: check('config.chiefProviderFake', cfg.chiefProvider === 'fake'),
      chiefModelFake1: check('config.chiefModelFake1', cfg.chiefModel === 'fake-1'),
      // alpha.2 冻结：执行子 Agent 的真实路由不开放；合并进证据，不删旧门禁。
      execRouteFrozen: check('config.execRouteFrozen', routeFrozen === true),
      // 声明位仍是证据的一项，但单独为真绝不构成准入。
      declaredVerified: check('config.declaredVerified', cfg.declaredVerified === true),
      censorateNotFrozen: check('config.censorateNotFrozen', cfg.censorateFrozen === false),
      stateReadable: check('config.stateReadable', cfg.stateUnreadable === false),
    },
    guard: {
      installed: check('guard.installed', guard.installed === true),
      rootScope: check('guard.rootScope', guard.scope === 'root'),
      preflightOk: stage === 'dispatch'
        ? check('guard.preflightOk', guard.preflightOk === true)
        : null,
    },
    lifecycle: {
      notShuttingDown: check('lifecycle.notShuttingDown', lc.shuttingDown === false),
      restartReadable: check('lifecycle.restartReadable', lc.restartBlocked === false),
      notCorrupt: check('lifecycle.notCorrupt', lc.corrupt === false),
      persistOk: check('lifecycle.persistOk', lc.persistError === null),
      beginOk: stage === 'dispatch'
        ? check('lifecycle.beginOk', lc.beginOk === true)
        : null,
    },
    gate: {
      ready: check('gate.ready', gate.ready === true),
      errorNull: check('gate.errorNull', gate.error === null),
    },
    writer: {
      epochConfirmed: check('writer.epochConfirmed', isEpoch(writer.epoch)),
      registryEpochMatches: check('writer.registryEpochMatches',
        isEpoch(writer.registryEpoch) && writer.registryEpoch === writer.epoch),
      registryPhaseOpen: check('writer.registryPhaseOpen', writer.registryPhase === 'open'),
      lockHeld: check('writer.lockHeld', writer.lockHeld === true),
      notStopping: check('writer.notStopping', writer.stopping === false),
      notClosed: check('writer.notClosed', writer.closed === false),
      notFailClosed: check('writer.notFailClosed', writer.failClosed === null),
    },
    identity: {
      childrenSet: check('identity.childrenSet', identity.children instanceof Set),
      taskRootsMap: check('identity.taskRootsMap', identity.taskRoots instanceof Map),
      taskChildrenMap: check('identity.taskChildrenMap', identity.taskChildren instanceof Map),
    },
  };

  if (stage === null) reasons.push('stage');
  let binding = null;
  if (stage === 'dispatch') {
    binding = verifyExecTaskBinding({
      taskId: identity.taskId, childId: identity.childId,
      children: identity.children, taskRoots: identity.taskRoots, taskChildren: identity.taskChildren,
    });
    evidence.identity.binding = binding.checks;
    if (!binding.ok) reasons.push('identity.binding:' + Object.keys(binding.checks).filter((k) => binding.checks[k] !== true).join('|'));
  } else {
    evidence.identity.binding = null;
  }
  // 检查项计数：确认阶段 20 项，派发阶段 27 项（含 7 项绑定）。少于这个数说明结构被改坏。
  evidence.checkedCount = countChecked(evidence);
  return {
    ok: reasons.length === 0,
    stage,
    evidence,
    reasons,
  };
}

function countChecked(evidence) {
  let n = 0;
  for (const group of ['config', 'guard', 'lifecycle', 'gate', 'writer', 'identity']) {
    for (const v of Object.values(evidence[group] ?? {})) if (typeof v === 'boolean') n += 1;
  }
  for (const v of Object.values(evidence.identity?.binding ?? {})) if (typeof v === 'boolean') n += 1;
  return n;
}

/** 只把原因摘要写入审计，不写正文字段；长度受 governance.audit 约束。 */
export function admissionAuditDetail(result) {
  const reasons = Array.isArray(result?.reasons) ? result.reasons : ['unknown'];
  return String(result?.ok === true ? 'admission:ok' : 'admission-denied:' + reasons.join(','))
    .replace(/[^\x20-\x7e\u4e00-\u9fff:,.|_-]/g, ' ').slice(0, 300);
}
