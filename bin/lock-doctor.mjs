// exec-budget.lock 诊断与（人工确认后的）清理。**只读诊断永远不修改文件**；
// 清理只在 CLI 显式给出 --state-dir X --confirm X 后执行，且只处理满足全部下列条件的锁：
//   1) 锁文件是 v2 格式（带 hostId/processStartAt/token），内容完整合法；
//   2) 锁记录的 hostId 与当前主机「强身份」（machine-id 级）一致；
//   3) 锁记录的 PID 在本机**明确不存在**（ESRCH）；
//   4) 清理计划与执行之间锁文件内容/大小/mtime 未变化（执行时重新校验；变化即拒绝）。
//
// 安全边界（必须如实告知；工具无法证明这些，也绝不自称「绝对安全」）：
//  - rename 不是「原子比较并交换」：rename 只能把当前路径上的文件原子移走，**原路径在那一瞬间空缺**，
//    其它进程可以在这段时间创建新锁；我们取走的也可能已经是别的实例刚创建的新锁，
//    而恢复动作本身同样存在窗口（恢复前原路径再出现第三个文件时不能覆盖）。
//    实现上用「再次读取校验 + rename 到 quarantine 后核对内容 + 恢复用硬链接/排他复制（目标已存在绝不覆盖）」
//    缩小窗口，但**竞态不可消除**：本工具不承诺也不声称「绝不误删」。
//  - 因此清理的硬性人工前置条件是「事先停止所有使用该 stateDir 的实例」：
//    DSH 桌面端、CLI、独立窗口、任何可能挂载同一 stateDir 的进程全部退出；工具无法证明这一点。
//    违反前置条件时，清理可能短暂移走别的新锁（不会删除其内容；恢复失败时保留在 quarantine 待人工移回）。
//  - 同一台机器上仍可能有另一个 PID 命名空间（容器/虚拟机快照/网络命名空间里的进程）持有同名锁，
//    本机的 PID 探测对它无意义；hostId 只证明「同一台机器」，不证明「同一 PID 命名空间」。
//  - 旧版本锁（无 version/hostId）、JSON 不可解析、主机身份不一致、主机身份只到 hostname 级、
//    PID 状态不可判定（EPERM/未知错误）、PID 仍存在（可能是活锁，也可能是 PID 被复用）→ 一律 unknown，
//    **不据此判死、不提供自动清理**。
//  - processStartAt 由 Date.now()-process.uptime() 反推（±1s），只作诊断提示（如「锁创建于上次开机之前」），
//    不能用来读取任意进程的启动时间，因此不能证明 PID 未被复用；不参与可清理判定。
//  - 主机身份只写不可逆摘要：锁文件与输出只含 hostId = 系统机器标识的 SHA-256 截断值，
//    不落盘/不输出 MachineGuid、machine-id、IOPlatformUUID 明文；hostname 明文仅用于诊断可读性。
//    hostId 不是安全凭据、不用于认证，也不构成「同一台机器」的密码学证明。
//  - 所以清理前必须有人工前置条件：确认没有任何实例正在运行或正在启动同一 stateDir，
//    并对 quarantine/回滚结果做人工核对。工具只负责缩小风险与留下证据，不负责「保证安全」。
//
// 本模块不处理 writer-epoch.json.*.tmp、exec-budget.json.*.tmp 等其它残留（只报告），
// 也不修改账本、不接管锁、不删除 epoch 文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  LOCK_FILE,
  LOCK_VERSION,
  EPOCH_FILE,
  EPOCH_VERSION,
  getHostIdentity,
} from '../writer-epoch-fencing.mjs';

export { LOCK_FILE };

export const LOCK_DOCTOR_VERSION = 1;

const MAX_LOCK_BYTES = 64 * 1024;
const EPOCH_TMP_RE = /^writer-epoch\.json\..+\.tmp$/i;
const LOCK_TMP_RE = /^exec-budget\.lock\..+\.tmp$/i;
const QUARANTINE_RE = /^exec-budget\.lock\..+\.quarantine$/i;
const BUDGET_TMP_RE = /^exec-budget\.json\..+\.tmp$/i;
const HEX16_RE = /^[0-9a-f]{16}$/i;
/** 时钟/uptime 误差容差：判断「锁创建于上次开机之前」时使用，只影响诊断提示。 */
const BOOT_TOLERANCE_MS = 60_000;

const STAT = (st) => ({
  size: st.size,
  mtimeMs: st.mtimeMs,
  ino: st.ino,
  isFile: typeof st.isFile === 'function' ? st.isFile() : true,
});

/**
 * 判断某个 PID 在本机是否存在。
 * 返回 { state: 'alive'|'absent'|'unknown'|'invalid', detail? }。
 *  - ESRCH = 明确不存在（唯一可用于「可清理」判断的否定证据）；
 *  - EPERM = 存在但无权探测 → 按 alive 保守处理；
 *  - 其它错误（含 Windows 上的 EINVAL/ACCESS_DENIED 等）→ unknown，不判死。
 */
export function probeProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) return { state: 'invalid' };
  try {
    process.kill(pid, 0);
    return { state: 'alive' };
  } catch (e) {
    const code = e?.code;
    if (code === 'ESRCH') return { state: 'absent' };
    if (code === 'EPERM') return { state: 'alive', detail: 'EPERM' };
    return { state: 'unknown', detail: code ?? String(e?.message ?? e) };
  }
}

/** 系统启动时间估算（毫秒时间戳；os.uptime 秒级精度，仅用于诊断提示）。 */
export function estimateBootTime(now = Date.now()) {
  try {
    return now - os.uptime() * 1000;
  } catch {
    return null;
  }
}

/**
 * 读取锁文件快照（只读）。present：
 *  - true：读到文件（readable=true 时带 raw/data/size/mtimeMs）；
 *  - false：明确不存在（ENOENT）；
 *  - null：状态不可判定（stat/读取异常），调用方必须按 fail-closed 处理。
 */
export function readLockRecord(lockPath, opts = {}) {
  const fsImpl = opts.fsImpl ?? fs;
  const abs = path.resolve(String(lockPath));
  let first;
  try {
    first = fsImpl.statSync(abs);
  } catch (e) {
    if (e?.code === 'ENOENT') return { path: abs, present: false, readable: false };
    return { path: abs, present: null, readable: false, error: e?.code ?? 'STAT_FAILED' };
  }
  const s1 = STAT(first);
  if (!s1.isFile) return { path: abs, present: true, readable: false, isFile: false, ...s1 };
  if (s1.size > MAX_LOCK_BYTES) {
    return { path: abs, present: true, readable: false, tooLarge: true, ...s1 };
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(abs, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { path: abs, present: false, readable: false };
    return { path: abs, present: true, readable: false, ...s1, error: e?.code ?? 'READ_FAILED' };
  }
  let s2;
  try {
    s2 = STAT(fsImpl.statSync(abs));
  } catch (e) {
    return { path: abs, present: null, readable: false, error: e?.code ?? 'STAT_FAILED' };
  }
  let data = null;
  let parseError = null;
  try {
    data = JSON.parse(raw);
  } catch {
    parseError = 'BAD_JSON';
  }
  return { path: abs, present: true, readable: true, isFile: s2.isFile, raw, data, parseError, ...s2 };
}

function signatureOf(record) {
  if (!record || record.present !== true || typeof record.raw !== 'string') return null;
  const h = crypto.createHash('sha256');
  h.update(record.raw, 'utf8');
  h.update(`\u0000size:${record.size}\u0000mtime:${record.mtimeMs}`);
  return h.digest('hex');
}

function sameSignature(record, expected) {
  if (!expected?.signature) return false;
  return signatureOf(record) === expected.signature;
}

/** 锁记录完整性校验：任何一项不合法都意味着「无法确认」，返回原因码。 */
function validateLockRecord(data, now) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'LOCK_NOT_OBJECT' };
  if (data.version === undefined) return { ok: false, reason: 'LOCK_LEGACY_NO_VERSION' };
  if (data.version !== LOCK_VERSION) return { ok: false, reason: 'LOCK_UNKNOWN_VERSION' };
  if (!Number.isSafeInteger(data.pid) || data.pid <= 0 || data.pid > 0xffffffff) return { ok: false, reason: 'LOCK_BAD_PID' };
  if (typeof data.token !== 'string' || data.token.length < 8 || data.token.length > 200) return { ok: false, reason: 'LOCK_BAD_TOKEN' };
  if (typeof data.processStartAt !== 'number' || !Number.isFinite(data.processStartAt) || data.processStartAt <= 0) {
    return { ok: false, reason: 'LOCK_BAD_PROCESS_START_AT' };
  }
  if (typeof data.hostId !== 'string' || !HEX16_RE.test(data.hostId)) return { ok: false, reason: 'LOCK_BAD_HOST_ID' };
  if (data.hostIdSource !== 'machine-id' && data.hostIdSource !== 'hostname') {
    return { ok: false, reason: 'LOCK_BAD_HOST_ID_SOURCE' };
  }
  if (typeof data.hostname !== 'string' || !data.hostname) return { ok: false, reason: 'LOCK_BAD_HOSTNAME' };
  if (typeof data.at !== 'number' || !Number.isFinite(data.at) || data.at <= 0) return { ok: false, reason: 'LOCK_BAD_AT' };
  if (data.processStartAt > now + BOOT_TOLERANCE_MS) return { ok: false, reason: 'LOCK_START_IN_FUTURE' };
  return { ok: true };
}

const REASON_TEXT = Object.freeze({
  LOCK_STATE_UNREADABLE: '锁文件状态不可读（stat 失败），无法确认是否存在',
  LOCK_UNREADABLE: '锁文件内容不可读',
  LOCK_NOT_REGULAR_FILE: '锁路径不是普通文件',
  LOCK_TOO_LARGE: '锁文件异常大，拒绝解析',
  LOCK_NOT_OBJECT: '锁文件内容不是 JSON 对象',
  LOCK_LEGACY_NO_VERSION: '锁文件是不带 version 的旧格式（无法确认主机与进程身份）',
  LOCK_UNKNOWN_VERSION: '锁文件版本号无法识别（可能由更新版本写入）',
  LOCK_BAD_PID: '锁文件里的 PID 非法',
  LOCK_BAD_TOKEN: '锁文件里的 token 非法',
  LOCK_BAD_PROCESS_START_AT: '锁文件缺少合法的 processStartAt（无法交叉核对进程身份）',
  LOCK_BAD_HOST_ID: '锁文件缺少合法的 hostId（无法确认是否本机）',
  LOCK_BAD_HOST_ID_SOURCE: '锁文件的主机身份来源不可识别',
  LOCK_BAD_HOSTNAME: '锁文件缺少 hostname',
  LOCK_BAD_AT: '锁文件的创建时间非法',
  LOCK_START_IN_FUTURE: '锁的进程启动时间在未来（时钟异常或文件被篡改）',
  LOCK_FROM_OTHER_HOST: '锁来自其它主机或其它机器身份，无法判断持有者是否存活',
  LOCK_HOST_IDENTITY_WEAK: '本机身份只能退化到主机名级（机器标识不可读），不足以判定锁已失效',
  LOCK_PID_ALIVE: '锁记录的 PID 在本机仍存在：可能是活锁，也可能是 PID 被复用；两种情况都不允许清理',
  LOCK_PID_STATE_UNKNOWN: '无法确认锁记录的 PID 是否存活（权限或系统错误）',
  LOCK_PID_INVALID: '锁记录的 PID 无法探测',
  LOCK_UNCLEANABLE_UNKNOWN: '锁状态无法确认，按 fail-closed 不提供自动清理',
});

const reasonText = (code) => REASON_TEXT[code] ?? code;

function hostRelationOf(data, current) {
  if (!current?.hostId) return 'unknown-host';
  if (String(data.hostId).toLowerCase() !== String(current.hostId).toLowerCase()) return 'other-host';
  if (current.hostIdSource === 'machine-id' && data.hostIdSource === 'machine-id') return 'same-host-strong';
  return 'same-host-weak';
}

function buildContext(opts = {}) {
  return {
    hostIdentity: opts.hostIdentity ?? getHostIdentity(),
    probePid: opts.probePid ?? probeProcess,
    now: opts.now ?? Date.now(),
    bootTime: opts.bootTime ?? estimateBootTime(opts.now ?? Date.now()),
  };
}

/**
 * 对锁记录做 fail-closed 分类。
 * verdict：
 *  - absent：没有锁；
 *  - live：本机强/弱身份一致且 PID 仍存在 → 视作活锁，绝不能删；
 *  - stale-candidate：本机强身份一致 + PID 明确不存在 → 唯一允许进入人工清理流程的状态；
 *  - unknown：旧格式/跨主机/弱身份/PID 状态不可判定/内容非法 → 不判死、不自动清理。
 */
export function classifyLockRecord(record, ctx = buildContext()) {
  const now = ctx.now ?? Date.now();
  const bootTime = ctx.bootTime ?? estimateBootTime(now);
  const base = {
    verdict: 'unknown',
    cleanable: false,
    hostRelation: null,
    pid: null,
    pidState: null,
    reasons: [],
    evidence: {},
  };
  const unknown = (reason, extra = {}) => ({
    ...base,
    ...extra,
    verdict: 'unknown',
    cleanable: false,
    reasons: [reason, ...(extra.reasons ?? [])],
  });

  if (record?.present === false) {
    return { ...base, verdict: 'absent', cleanable: false, reasons: [], evidence: { present: false } };
  }
  if (record?.present !== true) return unknown('LOCK_STATE_UNREADABLE');
  if (!record.readable) {
    return unknown(record.tooLarge ? 'LOCK_TOO_LARGE' : 'LOCK_UNREADABLE', { evidence: { path: record.path, error: record.error ?? null } });
  }
  if (!record.isFile) return unknown('LOCK_NOT_REGULAR_FILE');
  if (record.parseError) return unknown('LOCK_NOT_OBJECT', { evidence: { path: record.path, parseError: record.parseError } });

  const data = record.data;
  const integrity = validateLockRecord(data, now);
  if (!integrity.ok) return unknown(integrity.reason, { evidence: { path: record.path } });

  const hostRelation = hostRelationOf(data, ctx.hostIdentity);
  const probe = ctx.probePid(data.pid);
  const pidState = probe.state ?? 'unknown';
  const evidence = {
    present: true,
    path: record.path,
    size: record.size,
    mtimeAt: Number.isFinite(record.mtimeMs) ? new Date(record.mtimeMs).toISOString() : null,
    hostname: data.hostname,
    hostId: data.hostId,
    hostIdSource: data.hostIdSource,
    hostRelation,
    pid: data.pid,
    pidState,
    pidDetail: probe.detail ?? null,
    tokenPrefix: data.token.slice(0, 8),
    lockCreatedAt: new Date(data.at).toISOString(),
    lockAgeMs: now - data.at,
    processStartAt: new Date(data.processStartAt).toISOString(),
    processStartAtSource: 'uptime-estimate',
    createdBeforeBoot: bootTime !== null && data.processStartAt < bootTime - BOOT_TOLERANCE_MS,
    pidStartTimeComparable: false,
  };
  const withEvidence = (extra) => ({ ...base, ...extra, evidence });

  if (hostRelation === 'unknown-host' || hostRelation === 'other-host') {
    return withEvidence({ verdict: 'unknown', hostRelation, pid: data.pid, pidState, reasons: ['LOCK_FROM_OTHER_HOST'] });
  }
  if (pidState === 'alive') {
    return withEvidence({ verdict: 'live', hostRelation, pid: data.pid, pidState, reasons: ['LOCK_PID_ALIVE'] });
  }
  if (pidState !== 'absent') {
    return withEvidence({
      verdict: 'unknown',
      hostRelation,
      pid: data.pid,
      pidState,
      reasons: [pidState === 'invalid' ? 'LOCK_PID_INVALID' : 'LOCK_PID_STATE_UNKNOWN'],
    });
  }
  // PID 明确不存在：只有「强主机身份」才允许进入人工清理候选。
  if (hostRelation !== 'same-host-strong') {
    return withEvidence({ verdict: 'unknown', hostRelation, pid: data.pid, pidState, reasons: ['LOCK_HOST_IDENTITY_WEAK'] });
  }
  return withEvidence({ verdict: 'stale-candidate', cleanable: true, hostRelation, pid: data.pid, pidState, reasons: [] });
}

function scanStateDir(stateDir, fsImpl) {
  try {
    const names = fsImpl.readdirSync(stateDir);
    return { dirExists: true, readable: true, names: [...names].sort() };
  } catch (e) {
    if (e?.code === 'ENOENT') return { dirExists: false, readable: false, names: [] };
    return { dirExists: null, readable: false, names: [], error: e?.code ?? 'READDIR_FAILED' };
  }
}

function readEpochInfo(stateDir, fsImpl) {
  const f = path.join(stateDir, EPOCH_FILE);
  let raw;
  try {
    raw = fsImpl.readFileSync(f, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { present: false };
    return { present: null, error: e?.code ?? 'READ_FAILED' };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { present: true, error: 'BAD_EPOCH_JSON' };
  }
  if (!data || data.version !== EPOCH_VERSION || !Number.isSafeInteger(data.epoch) || data.epoch < 0) {
    return { present: true, error: 'BAD_EPOCH' };
  }
  return {
    present: true,
    version: data.version,
    epoch: data.epoch,
    updatedAt: Number.isFinite(data.updatedAt) ? new Date(data.updatedAt).toISOString() : null,
  };
}

/**
 * 只读诊断一个 stateDir：锁分类 + epoch 元数据 + 相关残留清单。
 * 绝不创建目录、绝不写任何文件。
 */
export function inspectStateDir(stateDir, opts = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new Error('缺少 stateDir');
  const fsImpl = opts.fsImpl ?? fs;
  const ctx = buildContext(opts);
  const abs = path.resolve(stateDir);
  const scanned = scanStateDir(abs, fsImpl);
  const lockPath = path.join(abs, LOCK_FILE);
  // 目录不存在 → 明确无锁；目录不可读（readdir 失败）→ 锁状态不可判定（present=null → unknown），
  // 不能因为读不到就当成 absent（fail-closed）。
  const record = scanned.dirExists === true
    ? readLockRecord(lockPath, { fsImpl })
    : { path: lockPath, present: scanned.dirExists === false ? false : null, readable: false };
  const classification = classifyLockRecord(record, ctx);
  const epoch = scanned.dirExists === true ? readEpochInfo(abs, fsImpl) : { present: false };
  const names = scanned.names;
  const orphans = {
    epochTmp: names.filter((n) => EPOCH_TMP_RE.test(n)),
    lockTmp: names.filter((n) => LOCK_TMP_RE.test(n)),
    quarantine: names.filter((n) => QUARANTINE_RE.test(n)),
    budgetTmp: names.filter((n) => BUDGET_TMP_RE.test(n)),
  };
  const orphanCount = Object.values(orphans).reduce((n, list) => n + list.length, 0);
  const lock = {
    ...classification,
    path: lockPath,
    recordPresent: record.present,
  };
  const needsAttention = scanned.dirExists === null || orphanCount > 0
    || classification.verdict !== 'absent' || (epoch.present !== false && epoch.error !== undefined);
  return {
    doctorVersion: LOCK_DOCTOR_VERSION,
    generatedAt: new Date(ctx.now).toISOString(),
    stateDir: abs,
    stateDirExists: scanned.dirExists,
    stateDirReadable: scanned.readable,
    stateDirError: scanned.error ?? null,
    host: {
      hostId: ctx.hostIdentity.hostId,
      hostIdSource: ctx.hostIdentity.hostIdSource,
      hostname: ctx.hostIdentity.hostname,
      platform: ctx.hostIdentity.platform,
      arch: ctx.hostIdentity.arch,
    },
    lock,
    epoch,
    orphans,
    orphanCount,
    needsAttention,
    purpose: 'diagnose-only',
    note: '只读诊断：本命令不会修改/删除任何文件；锁存在不等于可清理，清理必须另行显式 --confirm。',
  };
}

/**
 * 生成清理计划（仍不修改任何文件）。
 * 只有 verdict='stale-candidate' 才返回 ok；其余一律拒绝并给出原因。
 */
export function planLockCleanup(stateDir, opts = {}) {
  const report = inspectStateDir(stateDir, opts);
  const base = { ok: false, report, stateDir: report.stateDir, lockPath: report.lock.path };
  if (report.stateDirExists !== true) {
    return { ...base, code: 'NO_STATE_DIR', message: 'stateDir 不存在或不可读，拒绝清理' };
  }
  if (report.lock.recordPresent === false) {
    return { ...base, code: 'NO_LOCK', message: '没有 exec-budget.lock，无需清理' };
  }
  if (report.lock.verdict !== 'stale-candidate' || report.lock.cleanable !== true) {
    return {
      ...base,
      code: 'LOCK_NOT_CLEANABLE',
      message: `锁状态为 ${report.lock.verdict}，不满足清理条件（只清理「本机强身份 + PID 明确不存在」的锁）`,
    };
  }
  const record = readLockRecord(report.lock.path, { fsImpl: opts.fsImpl ?? fs });
  if (record.present !== true || !record.readable || !record.data) {
    return { ...base, code: 'LOCK_NOT_CLEANABLE', message: '锁文件在计划阶段再次读取失败，拒绝清理' };
  }
  return {
    ok: true,
    code: 'PLAN_READY',
    stateDir: report.stateDir,
    lockPath: report.lock.path,
    expected: {
      token: record.data.token,
      pid: record.data.pid,
      hostId: record.data.hostId,
      signature: signatureOf(record),
      size: record.size,
      mtimeMs: record.mtimeMs,
    },
    report,
    message: '清理计划已生成（尚未删除任何文件）：执行仍会重新校验；请确认没有其它实例正在运行或启动该 stateDir',
  };
}

/**
 * 把 quarantine 文件恢复回原路径，**绝不覆盖已存在的新锁**：
 *  - 目标已存在 → 直接失败（TARGET_EXISTS），保留 quarantine；
 *  - 优先 linkSync（原子；目标已存在会 EEXIST）；
 *  - 文件系统不支持硬链接时退化为 copyFileSync + COPYFILE_EXCL（排他创建，仍不覆盖），
 *    复制窗口崩溃可能留下不完整锁文件 → 诊断按内容非法判 unknown（fail-closed）。
 */
function restoreQuarantine(fsImpl, quarantinePath, lockPath) {
  try {
    try {
      fsImpl.statSync(lockPath);
      return { ok: false, reason: 'TARGET_EXISTS' };
    } catch (e) {
      if (e?.code !== 'ENOENT') return { ok: false, reason: e?.code ?? 'STAT_FAILED' };
    }
    let linkError = null;
    try {
      fsImpl.linkSync(quarantinePath, lockPath);
      fsImpl.rmSync(quarantinePath, { force: true });
      return { ok: true, via: 'hardlink' };
    } catch (e) {
      linkError = e;
      if (e?.code === 'EEXIST') return { ok: false, reason: 'TARGET_EXISTS' };
      if (typeof fsImpl.copyFileSync !== 'function') {
        return { ok: false, reason: e?.code ?? 'LINK_FAILED' };
      }
    }
    try {
      const EXCL = fsImpl.constants?.COPYFILE_EXCL ?? 1;
      fsImpl.copyFileSync(quarantinePath, lockPath, EXCL);
      fsImpl.rmSync(quarantinePath, { force: true });
      return { ok: true, via: 'copy-excl' };
    } catch (e) {
      if (e?.code === 'EEXIST') return { ok: false, reason: 'TARGET_EXISTS' };
      return { ok: false, reason: e?.code ?? linkError?.code ?? 'RESTORE_FAILED' };
    }
  } catch (e) {
    return { ok: false, reason: e?.code ?? 'RESTORE_FAILED' };
  }
}

/**
 * 执行清理（唯一会删除文件的函数）。流程：
 *   1) 重新读取锁文件，内容/大小/mtime 必须与计划完全一致（否则 LOCK_CHANGED，不删）；
 *   2) 重新分类，必须仍是 stale-candidate（否则 VERDICT_CHANGED，不删）；
 *   3) rename 到同目录 quarantine 名（原路径在 rename 瞬间空缺，这是不可消除的竞态窗口）；
 *   4) 校验 quarantine 内容与计划一致 → 删除；不一致（取走的可能已是别人的新锁）→ 尝试恢复原路径，
 *      恢复用硬链接/排他复制，目标已存在绝不覆盖；
 *   5) 若恢复失败 → 保留 quarantine 并报错，交人工移回核对。
 * 前置条件（无法验证、必须人工保证）：事先停止所有使用该 stateDir 的实例。
 * 本函数不会删除 epoch/账本/其它残留。
 */
export function executeLockCleanup(plan, opts = {}) {
  if (!plan || plan.ok !== true || plan.code !== 'PLAN_READY') throw new Error('需要先通过 planLockCleanup 生成 ok 的清理计划');
  const fsImpl = opts.fsImpl ?? fs;
  const { lockPath, expected } = plan;
  const ctx = buildContext(opts);
  const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

  const before = readLockRecord(lockPath, { fsImpl });
  if (before.present === false) return fail('LOCK_VANISHED', '锁文件已不存在（可能已被人工/其它实例清理），未执行任何删除');
  if (before.present !== true || !before.readable) return fail('LOCK_UNREADABLE', '锁文件不可读，拒绝清理');
  if (!sameSignature(before, expected)) return fail('LOCK_CHANGED', '锁文件在计划之后发生变化（内容/大小/mtime 不一致），拒绝清理；请重新诊断');
  if (before.data?.token !== expected.token) return fail('LOCK_CHANGED', '锁文件 token 与计划不一致，拒绝清理');

  const recheck = classifyLockRecord(before, ctx);
  if (recheck.verdict !== 'stale-candidate' || recheck.cleanable !== true) {
    return fail('VERDICT_CHANGED', `锁状态在计划之后变为 ${recheck.verdict}，拒绝清理`, { classification: recheck });
  }

  const dir = path.dirname(lockPath);
  const quarantinePath = path.join(dir, `${LOCK_FILE}.${crypto.randomUUID()}.quarantine`);
  try {
    fsImpl.renameSync(lockPath, quarantinePath);
  } catch (e) {
    if (e?.code === 'ENOENT') return fail('LOCK_VANISHED', '锁文件在取走前消失，未执行任何删除');
    return fail('RENAME_FAILED', `无法把锁文件原子移到 quarantine（${e?.code ?? e}），未执行任何删除`);
  }

  const moved = readLockRecord(quarantinePath, { fsImpl });
  if (!sameSignature(moved, expected)) {
    // 竞争替换：取走的不是我们检查过的那个文件（可能是别的实例刚创建的新锁）。
    // 绝不删除其内容；尝试恢复原路径；恢复也绝不覆盖原路径上可能已出现的新文件。
    const restore = restoreQuarantine(fsImpl, quarantinePath, lockPath);
    if (restore.ok) {
      return fail('LOCK_REPLACED',
        '检查与取走之间锁文件被替换：已把被取走的文件恢复回原路径，未删除任何内容；但竞态窗口内可能仍有第三写者，请立即重新诊断',
        { restored: true });
    }
    return fail('LOCK_REPLACED_RESTORE_FAILED',
      '检查与取走之间锁文件被替换，且原路径已被占用（不能覆盖）；被取走的文件保留在 quarantine 路径，'
      + '请立即人工核对并移回；这正说明清理前没有停止所有实例，竞态窗口无法由工具消除',
      { restored: false, quarantinePath });
  }

  try {
    fsImpl.rmSync(quarantinePath, { force: true });
  } catch (e) {
    const restore = restoreQuarantine(fsImpl, quarantinePath, lockPath);
    return fail('QUARANTINE_DELETE_FAILED',
      `校验通过但删除 quarantine 文件失败（${e?.code ?? e}）；${restore.ok ? '已恢复原锁文件' : '原路径已被占用，锁文件保留在 quarantine 路径'}`,
      { restored: restore.ok, ...(restore.ok ? {} : { quarantinePath }) });
  }

  const after = readLockRecord(lockPath, { fsImpl });
  return {
    ok: true,
    code: 'CLEANED',
    message: after.present === true
      ? '已删除失效锁；rename 窗口内已有新写者创建新锁（属正常接管，请勿再次删除）'
      : '已删除失效锁（quarantine 校验通过）；若清理前未停止所有实例，仍可能存在未观察到的竞争',
    precondition: '清理前必须已停止所有使用该 stateDir 的实例（工具无法验证）；竞态窗口不可消除',
    removed: true,
    quarantinePath: null,
    recreated: after.present === true,
    stateDir: plan.stateDir,
  };
}

/**
 * 记录清理不应触碰的旁证文件状态（账本 / epoch）：清理前后对比，用来证明工具只删了锁。
 * 返回 { 'exec-budget.json': {size,mtimeMs}|null|{error}, ... }；null 表示不存在。
 */
export function statWatchedFiles(stateDir, fsImpl = fs) {
  const out = {};
  for (const name of ['exec-budget.json', EPOCH_FILE]) {
    try {
      const st = fsImpl.statSync(path.join(stateDir, name));
      out[name] = { size: st.size, mtimeMs: st.mtimeMs };
    } catch (e) {
      out[name] = e?.code === 'ENOENT' ? null : { error: e?.code ?? 'STAT_FAILED' };
    }
  }
  return out;
}

/** 清理后给人工复核用的摘要（不含 token 明文）。 */export function summarizeReport(report) {
  const lock = report.lock;
  const lines = [];
  lines.push(`stateDir：${report.stateDir}`);
  lines.push(`本机身份：${report.host.hostname}（${report.host.hostIdSource}，hostId=${report.host.hostId}）`);
  if (report.stateDirExists === null) lines.push('目录状态：不可读（无法确认锁状态）');
  else if (report.stateDirExists === false) lines.push('目录状态：不存在（插件尚未初始化或路径写错；没有锁）');
  if (lock.verdict === 'absent') lines.push('锁文件：不存在');
  else {
    lines.push(`锁文件：${lock.path}`);
    lines.push(`结论：${lock.verdict}（cleanable=${lock.cleanable}）`);
    if (lock.pid !== null) {
      lines.push(`pid=${lock.pid}，pidState=${lock.pidState}，hostRelation=${lock.hostRelation ?? 'unknown'}`);
      if (lock.evidence?.lockCreatedAt) {
        const ageSec = Number.isFinite(lock.evidence.lockAgeMs) ? Math.round(lock.evidence.lockAgeMs / 1000) : null;
        lines.push(`锁创建时间：${lock.evidence.lockCreatedAt}${ageSec === null ? '' : `（约 ${ageSec} 秒前）`}`);
      }
      if (lock.evidence?.processStartAt) {
        lines.push(`记录的进程启动时间（估算，仅作提示、不参与清理判定）：${lock.evidence.processStartAt}${lock.evidence.createdBeforeBoot ? '；早于当前系统启动，可能来自上次开机' : ''}`);
      }
    }
    for (const r of lock.reasons) lines.push(`  - ${reasonText(r)}`);
  }
  if (report.orphanCount > 0) {
    for (const [k, list] of Object.entries(report.orphans)) {
      if (list.length) lines.push(`残留 ${k}：${list.join('、')}`);
    }
  }
  if (report.epoch.present === true) lines.push(`epoch：v${report.epoch.version} epoch=${report.epoch.epoch}`);
  return lines;
}

export { reasonText, validateLockRecord };
