// exec-policy — 执行子 Agent 的最小工具与目录权限（纯函数，fail closed）
//
// 背景：宿主 SubagentStartRequest 在 0.2.2-rc.1 里没有 toolFilter/sandbox 字段，
// 子 Agent 默认继承首辅 preset 的全部工具与父级 cwd。执行桥必须自己给执行子 Agent
// 单独建约束，不能指望首辅只读守卫覆盖新作用域。
//
// 约束分两层：
//   1) 工具白名单：只有显式允许的工具名可以执行；
//   2) 目录约束：允许工具的路径参数必须落在固定工作根内（解析符号链接与 `..` 后判定）。
// 任何一步无法确认（配置缺失、路径解析失败、工具没有可校验的路径参数）都拒绝执行。
import fs from 'node:fs';
import path from 'node:path';

// 允许工具 → 需要检查的路径参数名。未知工具若出现在白名单里，无法约束其副作用，
// 因此构造策略时就拒绝（见 normalizeExecPolicy）。
// 注意：apply_patch 不在表内。它的参数是整份 patch 文本（`input`），一次调用可以改多个
// 文件，无法用单个 file_path 可靠约束，所以白名单里出现 apply_patch 会被 normalize 拒绝。
export const EXEC_PATH_ARGS = {
  read: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  read_image: ['file_path'],
};

// 明确不支持的工具：没有可靠的单路径约束，或结果越界未实证。白名单里出现时直接拒绝。
export const EXEC_UNSUPPORTED_TOOLS = {
  apply_patch: '参数是整份 patch 文本，可一次修改多个文件，无法用单个 file_path 约束',
  glob: '结果路径未做逐项包含性校验（junction 是否被遍历未实证），暂不允许',
  grep: '命中文件未做逐项包含性校验（junction 是否被遍历未实证），暂不允许',
  pwsh: 'shell 命令无法按路径前缀约束副作用',
  bash: 'shell 命令无法按路径前缀约束副作用',
  run_code: 'PTC 执行通道，不在文件工具白名单内',
};

// Windows 设备名与设备路径：在任意目录下都会被 Win32 解析成设备，绕过目录约束。
const WINDOWS_DEVICE_BASENAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/** 是否为不可接受的 Windows 设备名/设备路径（非 Windows 平台返回 false）。 */
export function isBlockedDevicePath(targetPath) {
  if (process.platform !== 'win32') return false;
  if (!isNonEmptyString(targetPath)) return false;
  const raw = String(targetPath);
  // \\?\ 与 \\.\ 是设备命名空间；\\?\ 还会绕过路径规范化
  if (/^[\\/]{1,2}[?.][\\/]/.test(raw)) return true;
  for (const segment of raw.split(/[\\/]+/)) {
    if (!segment) continue;
    // `.` / `..` 是普通相对段，由 path.resolve 折叠；它们不参与设备名/尾随点判定。
    if (segment === '.' || segment === '..') continue;
    // 不允许备用数据流或设备名的冒号形式；盘符单独放行。
    if (segment.includes(':') && !/^[A-Za-z]:$/.test(segment)) return true;
    const trimmed = segment.replace(/[. ]+$/, '');
    if (WINDOWS_DEVICE_BASENAME.test(trimmed)) return true;
    if (trimmed !== segment) return true; // 尾随空格/点：Win32 会静默裁剪，等于放开另一条路径
  }
  return false;
}

/**
 * 找到目标路径最近的已存在祖先（含自身）。
 * @param {string} targetPath
 * @returns {{path: string, real: string} | null}
 */
export function nearestExistingAncestor(targetPath) {
  if (!isNonEmptyString(targetPath)) return null;
  let cur = path.resolve(targetPath);
  for (;;) {
    try {
      return { path: cur, real: fs.realpathSync.native(cur) };
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

/** cwd 是否是 <root>/tasks/<id> 形状（重启后用它推断任务隔离根）。 */
export function isTaskDirOf(rootReal, cwd) {
  if (!isNonEmptyString(rootReal) || !isNonEmptyString(cwd)) return false;
  const root = normCompare(rootReal);
  const dir = normCompare(cwd);
  if (!root || !dir) return false;
  const prefix = root + '/tasks/';
  if (!dir.startsWith(prefix)) return false;
  const rest = dir.slice(prefix.length);
  return rest.length > 0 && !rest.includes('/');
}

/**
 * 为单个任务构造策略：把允许根收窄到该任务目录。
 * @param {{allowedTools: Set<string>}} policy - 部署级策略
 * @param {string} taskRootReal - 任务目录的 realpath
 * @returns {{allowedTools: Set<string>, workspaceRoot: string, workspaceRootReal: string} | null}
 */
export function policyForTask(policy, taskRootReal) {
  if (!policy || !(policy.allowedTools instanceof Set) || !isNonEmptyString(taskRootReal)) return null;
  return { allowedTools: policy.allowedTools, workspaceRoot: taskRootReal, workspaceRootReal: taskRootReal };
}

// 已知无路径参数、副作用可忽略的只读工具：允许出现在白名单里，不做目录检查。
export const EXEC_NO_PATH_TOOLS = new Set(['todo_write']);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

function normCompare(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** target 是否等于 root 或在 root 之下（按规范化后的路径边界比较）。 */
export function isWithinRoot(root, target) {
  const r = normCompare(root);
  const t = normCompare(target);
  if (!r || !t) return false;
  if (r === t) return true;
  return t.startsWith(r + '/');
}

/**
 * 核对执行工作根是否落在父会话 cwd 之内。
 *
 * 为什么需要：DSH 的 sandbox preset 边界取 `session.header.cwd`（`dsh-sandbox-policy`
 * L170），而子 Agent 的 header.cwd 继承父（`dsh-subagent` L351），`request.cwd` 只改
 * agent 当前工作目录、不改沙箱边界。因此 preset 只能提供「父 cwd 范围」的后备约束；
 * 要让这个后备至少覆盖任务目录，执行根必须位于父 cwd 之下。
 *
 * 两侧都取 realpath：junction/符号链接解析到真实位置后再比较，盘符、大小写、
 * 分隔符与目录边界由 {@link isWithinRoot} 归一化处理。任何一项无法确认都返回 ok:false，
 * 由调用方拒绝启用后备，不静默降级。
 *
 * @param {unknown} parentCwd - 父会话的 header.cwd
 * @param {unknown} execRootReal - 已 realpath 的执行工作根
 * @returns {{ok: true, parentCwdReal: string, equal: boolean} | {ok: false, reason: string, parentCwdReal?: string}}
 */
export function checkExecutionRootWithin(parentCwd, execRootReal) {
  if (!isNonEmptyString(parentCwd)) return { ok: false, reason: '父会话 cwd 不可确认' };
  if (!isNonEmptyString(execRootReal)) return { ok: false, reason: '执行工作根不可确认' };
  if (!path.isAbsolute(parentCwd)) return { ok: false, reason: '父会话 cwd 不是绝对路径：' + String(parentCwd).slice(0, 200) };
  let parentReal;
  try {
    parentReal = fs.realpathSync.native(parentCwd);
  } catch (e) {
    return { ok: false, reason: '父会话 cwd 无法解析：' + String(e?.code ?? e?.message ?? e) };
  }
  let st = null;
  try { st = fs.statSync(parentReal); } catch { st = null; }
  if (!st || !st.isDirectory()) return { ok: false, reason: '父会话 cwd 不是目录：' + parentReal.slice(0, 200) };
  if (!isWithinRoot(parentReal, execRootReal)) {
    return {
      ok: false,
      parentCwdReal: parentReal,
      reason: `执行工作根不在父会话 cwd 之内：执行根 ${execRootReal.slice(0, 200)}，父 cwd ${parentReal.slice(0, 200)}`,
    };
  }
  return { ok: true, parentCwdReal: parentReal, equal: normCompare(parentReal) === normCompare(execRootReal) };
}

/**
 * 旧布局检测：执行根与父 cwd 平级（不在其下）时给出迁移建议，但**不移动、不删除任何目录**。
 * @param {string} execRootReal
 * @param {string} parentCwdReal
 * @returns {{legacy: boolean, advice: string|null}}
 */
export function describeLegacyExecRoot(execRootReal, parentCwdReal) {
  if (!isNonEmptyString(execRootReal) || !isNonEmptyString(parentCwdReal)) return { legacy: false, advice: null };
  if (isWithinRoot(parentCwdReal, execRootReal)) return { legacy: false, advice: null };
  const rootParent = path.dirname(execRootReal);
  const sameParent = normCompare(rootParent) === normCompare(path.dirname(parentCwdReal));
  return {
    legacy: sameParent,
    advice: sameParent
      ? `执行工作根 ${execRootReal.slice(0, 200)} 与父会话 cwd ${parentCwdReal.slice(0, 200)} 平级，preset 后备将覆盖不到任务目录。`
        + `建议把 execWorkspaceRoot 迁到父 cwd 之下（例如 <父cwd>\\.exec），并把旧目录内容手工迁移；插件不会移动或删除现有执行目录。`
      : `执行工作根 ${execRootReal.slice(0, 200)} 不在父会话 cwd ${parentCwdReal.slice(0, 200)} 之内。`
        + `请把 execWorkspaceRoot 指向父 cwd 之下的目录；插件不会移动或删除现有执行目录。`,
  };
}


/**
 * 把目标路径规范化为绝对真实路径：折叠 `..`/相对段，对不存在的尾段用最近存在祖先的
 * realpath 拼接，避免符号链接与大小写差异绕过目录判定。无法解析时返回 null。
 */
export function canonicalTarget(targetPath, cwd) {
  if (!isNonEmptyString(targetPath)) return null;
  let abs;
  try {
    abs = path.resolve(isNonEmptyString(cwd) ? cwd : process.cwd(), targetPath);
  } catch {
    return null;
  }
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * 规范化执行权限配置。
 * @param {{allowedTools?: string[], workspaceRoot?: string}} cfg - 插件配置
 * @returns {{ok: true, policy: {allowedTools: Set<string>, workspaceRoot: string, workspaceRootReal: string}} | {ok: false, error: string}}
 */
export function normalizeExecPolicy(cfg) {
  const rawAllow = cfg?.allowedTools;
  if (!Array.isArray(rawAllow) || rawAllow.length === 0) {
    return { ok: false, error: 'execAllowedTools 未配置（必须是至少含一个工具名的数组）' };
  }
  const allowed = [];
  for (const item of rawAllow) {
    if (!isNonEmptyString(item)) return { ok: false, error: 'execAllowedTools 含非字符串或空项' };
    const name = item.trim();
    if (allowed.includes(name)) continue;
    if (Object.hasOwn(EXEC_UNSUPPORTED_TOOLS, name)) {
      return { ok: false, error: `execAllowedTools 含不可约束的工具「${name}」：${EXEC_UNSUPPORTED_TOOLS[name]}` };
    }
    if (!Object.hasOwn(EXEC_PATH_ARGS, name) && !EXEC_NO_PATH_TOOLS.has(name)) {
      return { ok: false, error: `execAllowedTools 含无法约束副作用的工具「${name}」：只接受已知文件工具或只读工具` };
    }
    allowed.push(name);
  }
  const rawRoot = cfg?.workspaceRoot;
  if (!isNonEmptyString(rawRoot)) return { ok: false, error: 'execWorkspaceRoot 未配置（必须是已存在的绝对目录）' };
  if (!path.isAbsolute(rawRoot)) return { ok: false, error: 'execWorkspaceRoot 必须是绝对路径：' + rawRoot };
  let rootReal;
  try {
    rootReal = fs.realpathSync.native(rawRoot);
  } catch (e) {
    return { ok: false, error: 'execWorkspaceRoot 无法解析：' + String(e?.code ?? e?.message ?? e) };
  }
  let stat = null;
  try { stat = fs.statSync(rootReal); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) return { ok: false, error: 'execWorkspaceRoot 不是目录：' + rootReal };
  return { ok: true, policy: { allowedTools: new Set(allowed), workspaceRoot: rawRoot, workspaceRootReal: rootReal } };
}

/**
 * 判定一次工具调用是否被允许。纯函数，guard 与自测共用同一实现。
 * @param {{allowedTools: Set<string>, workspaceRootReal: string}} policy
 * @param {{name?: unknown, arguments?: unknown, cwd?: unknown}} call - pipeline 的 exec（arguments 已解析）
 * @returns {{allowed: true} | {allowed: false, reason: string}}
 */
export function decideExecToolCall(policy, call) {
  if (!policy || !(policy.allowedTools instanceof Set) || !isNonEmptyString(policy.workspaceRootReal)) {
    return { allowed: false, reason: '执行权限策略不可确认，拒绝调用' };
  }
  const name = call?.name;
  if (!isNonEmptyString(name)) return { allowed: false, reason: '执行 Agent 工具调用：无法确认工具名，拒绝调用' };
  if (!policy.allowedTools.has(name)) {
    return { allowed: false, reason: `执行 Agent 工具受限：「${name}」不在允许清单内` };
  }
  const args = call?.arguments;
  if (EXEC_NO_PATH_TOOLS.has(name) && !Object.hasOwn(EXEC_PATH_ARGS, name)) return { allowed: true };
  const argKeys = EXEC_PATH_ARGS[name];
  if (!Array.isArray(argKeys) || argKeys.length === 0) {
    return { allowed: false, reason: `执行 Agent 工具受限：「${name}」没有可校验的路径参数` };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { allowed: false, reason: `执行 Agent 工具受限：无法解析「${name}」的参数` };
  }
  const cwd = isNonEmptyString(call?.cwd) ? call.cwd : null;
  if (!cwd) return { allowed: false, reason: '执行 Agent 工具调用：无法确认工作目录，拒绝调用' };
  for (const key of argKeys) {
    const value = args[key];
    if (!isNonEmptyString(value)) {
      return { allowed: false, reason: `执行 Agent 工具受限：「${name}」缺少路径参数 ${key}` };
    }
    // Windows 设备名/设备路径先于目录判定：它们在任意目录下都会被解析成设备。
    if (isBlockedDevicePath(value)) {
      return { allowed: false, reason: `执行 Agent 目录受限：「${name}」目标路径是 Windows 设备名/设备路径：${String(value).slice(0, 120)}` };
    }
    const real = canonicalTarget(value, cwd);
    if (!real) return { allowed: false, reason: `执行 Agent 工具受限：「${name}」的路径无法解析：${String(value).slice(0, 120)}` };
    if (isBlockedDevicePath(real)) {
      return { allowed: false, reason: `执行 Agent 目录受限：「${name}」解析后是设备路径：${String(real).slice(0, 120)}` };
    }
    if (!isWithinRoot(policy.workspaceRootReal, real)) {
      return { allowed: false, reason: `执行 Agent 目录受限：「${name}」目标路径不在执行工作根内：${String(value).slice(0, 160)}` };
    }
  }
  return { allowed: true };
}

/** 任务私有的执行目录：<root>/tasks/<taskId>，必须是 root 的子目录。 */
export function taskDirFor(policy, taskId) {
  const id = String(taskId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return null;
  const dir = path.join(policy.workspaceRootReal, 'tasks', id);
  if (!isWithinRoot(policy.workspaceRootReal, dir)) return null;
  return dir;
}

const EXEC_CHILD_PREFIX = 'session-exec-';

/**
 * 判定一个 Agent 是否为「首辅派生的执行子 Agent」。
 *
 * 判据顺序（强信号在前，且不被父/chief 状态否决）：
 *   1) 已登记 childId（tracked-child）；
 *   2) `session-exec-` 保留前缀（reserved-prefix）——重启/状态损坏后登记为空也受限；
 *   3) 父会话属于首辅（含历任）后，再看 cwd：任务目录形状 / 工作根内（派发窗口期兜底）；
 *      工作目录不可确认时按执行子 Agent 处理（fail closed）。
 * 父不在首辅列表且没有强信号时，判为非执行子（普通会话、普通子 Agent）。
 *
 * @param {{parentSession?: unknown, sessionId?: unknown, cwd?: unknown,
 *   chiefSessionIds?: Iterable<string>|Set<string>, trackedChildIds?: Iterable<string>|Set<string>,
 *   workspaceRootReal?: unknown}} input
 * @returns {{execChild: boolean, reason: string}}
 */
export function isExecChildIdentity(input) {
  const sid = typeof input?.sessionId === 'string' && input.sessionId ? input.sessionId : null;
  const tracked = input?.trackedChildIds instanceof Set ? input.trackedChildIds : new Set(input?.trackedChildIds ?? []);
  // 强信号优先，且不被父/chief 状态否决：登记与保留前缀都是执行桥自己产生的身份。
  // 这样首辅状态损坏、state 回滚、或进程重启后登记清空时，执行子会话仍然受限。
  if (sid !== null && tracked.has(sid)) return { execChild: true, reason: 'tracked-child' };
  if (sid !== null && sid.startsWith(EXEC_CHILD_PREFIX)) return { execChild: true, reason: 'reserved-prefix' };
  const root = typeof input?.workspaceRootReal === 'string' && input.workspaceRootReal ? input.workspaceRootReal : null;
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : null;
  if (root !== null && cwd !== null && isTaskDirOf(root, cwd)) return { execChild: true, reason: 'cwd-task-dir' };
  const parentId = typeof input?.parentSession === 'string' && input.parentSession ? input.parentSession : null;
  if (!parentId) return { execChild: false, reason: 'no-parent' };
  const chiefs = input?.chiefSessionIds instanceof Set ? input.chiefSessionIds : new Set(input?.chiefSessionIds ?? []);
  if (!chiefs.has(parentId)) return { execChild: false, reason: 'parent-not-chief' };
  if (cwd === null) return { execChild: true, reason: 'cwd-unknown-fail-closed' };
  if (root !== null && isWithinRoot(root, cwd)) return { execChild: true, reason: 'cwd-in-root' };
  return { execChild: false, reason: 'not-exec-child' };
}

/**
 * 是否可以在任务结束时释放预留 childId。只有拿到明确成功终态且审计可读才释放；
 * unknown / failed / 启动异常 / childId 不匹配一律保留，避免迟到子会话失去约束。
 * @param {{status?: string, auditAvailable?: boolean}|null} outcome
 * @returns {boolean}
 */
export function shouldReleaseChildOnOutcome(outcome) {
  return !!outcome && outcome.status === 'succeeded' && outcome.auditAvailable === true;
}

/**
 * 有界释放：dispose 可能永久挂起，桥不能被 finally 等待拖死。
 * 返回 'settled' / 'error' / 'timeout'；不据此宣称子 Agent 已停止。
 * @param {(() => unknown)|null|undefined} disposeFn
 * @param {number} timeoutMs
 * @returns {Promise<'settled'|'error'|'timeout'>}
 */
export async function attemptDispose(disposeFn, timeoutMs = 5000) {
  if (typeof disposeFn !== 'function') return 'settled';
  const bounded = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 5000;
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), bounded); });
  const attempt = Promise.resolve().then(() => disposeFn()).then(() => 'settled', () => 'error');
  try { return await Promise.race([attempt, timeout]); }
  finally { if (timer !== null) clearTimeout(timer); }
}

/**
 * 派发前门禁：策略、守卫、执行 preset 任何一个不可确认都不派发（fail closed）。
 * @param {{policyRes?: object, guard?: {installed?: boolean, error?: string|null}, agentPreset?: string|null}} state
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function execDispatchGate(state) {
  const policyRes = state?.policyRes ?? null;
  if (!policyRes || policyRes.ok !== true) {
    return { ok: false, error: '执行权限不可确认，拒绝派发：' + String(policyRes?.error ?? '未配置执行权限策略') };
  }
  const guard = state?.guard ?? null;
  if (!guard || guard.installed !== true) {
    return { ok: false, error: '执行守卫未安装，拒绝派发：' + String(guard?.error ?? 'tools.guard 不可用') };
  }
  const preset = state?.agentPreset;
  if (!isNonEmptyString(preset)) {
    return { ok: false, error: '执行 Agent 的独立 preset 未配置，拒绝派发' };
  }
  return { ok: true };
}
