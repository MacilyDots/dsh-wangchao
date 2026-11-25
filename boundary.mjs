// @ts-check
// dsh-wangchao 边界函数（P2）：可离线自检、有明确契约的纯函数集合。
//
// 为什么单独成文件：
//   tsc 的 checkJs 是文件级开关。给 index.mjs 开 @ts-check 会连带检查 5100 行
//   apply() 内部闭包（属 P3 范围），产生海量噪音。把边界函数集中到这里，就能
//   只对这部分做严格类型检查，同时保持 apply() 一行不动。
//
// 约束（与 P1 一致）：
//   · 这些函数必须被 apply() 内的生产路径真实调用，不能只服务测试；
//   · #1 只记录不抛错：整批工具被误拒的伤害大于漏检（日记第一坑）；
//   · #9 指纹在模块加载时算一次并冻结：动态读盘会跟着磁盘变，永远自洽。
//
// 行尾纪律：参与指纹的文件必须全部是 LF。编辑器把 package.json 写成 CRLF 后，
// 宿主指纹会与磁盘不一致；而 .json 不在 HMR 监听范围，只改它不会触发重载。
// checks/09 有一条断言专门守这个，改完代码记得让插件重载一次。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __moduleFile = fileURLToPath(import.meta.url);
const __moduleDir = path.dirname(__moduleFile);

// 参与指纹的文件：自动发现根目录下的源码与配置。
// 硬编码清单会漏掉新增模块（0.3.0 加 exec-budget / exec-gate-wiring / orphan-tmp /
// writer-epoch-fencing 时四项全部不在旧清单里，等于假阴性），所以改为扫描。
const CODE_FILE_RE = /\.(mjs|js|json|ya?ml)$/;
const CODE_FILE_SKIP_RE = /\.test\.mjs$|\.bak|\.orig$|^\./;

/**
 * 扫描目录，列出参与代码指纹的文件名（不递归）。
 * @param {string} [dir] 目录，默认本模块所在目录。
 * @returns {string[]} 排序后的文件名；目录不可读时返回空数组。
 */
export function discoverCodeFiles(dir = __moduleDir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((n) => CODE_FILE_RE.test(n) && !CODE_FILE_SKIP_RE.test(n))
      .sort();
  } catch {
    return [];
  }
}

/** 本模块加载时快照的源码清单。 */
export const CODE_FILES = Object.freeze(discoverCodeFiles());

/**
 * 按文件字节计算代码指纹。
 * @param {string} [baseDir] 基准目录，默认本模块所在目录。
 * @param {readonly string[] | null} [files] 文件清单；null 表示按 baseDir 自动发现。
 * @returns {import('./types.js').CodeFingerprint} 已冻结的指纹。
 */
export function computeDiskFingerprint(baseDir = __moduleDir, files = null) {
  /** @type {Record<string, string>} */
  const perFile = {};
  const combined = crypto.createHash('sha256');
  const list = files ?? discoverCodeFiles(baseDir);
  for (const rel of list) {
    const full = path.join(baseDir, rel);
    /** @type {string} */
    let digest;
    try {
      digest = fs.existsSync(full)
        ? crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16)
        : 'MISSING';
    } catch (e) {
      digest = 'UNREADABLE:' + String(/** @type {NodeJS.ErrnoException} */ (e)?.code ?? 'ERR');
    }
    perFile[rel] = digest;
    combined.update(`${rel}:${digest}\n`);
  }
  return Object.freeze({
    bundleHash: combined.digest('hex').slice(0, 16),
    files: Object.freeze(perFile),
  });
}

/**
 * 模块加载时锁定的指纹。绝不能在调用时动态读盘：那样哈希会跟着磁盘变，
 * 反而检不出「宿主加载的是旧代码」。
 * @type {import('./types.js').LoadedCodeFingerprint}
 */
export const LOADED_CODE_FINGERPRINT = Object.freeze({
  ...computeDiskFingerprint(__moduleDir),
  loadedAt: Date.now(),
  pid: process.pid,
});

// #1：guard 读错字段（只读 exec.call?.name）导致整批工具被误拒。
// 回退顺序与 2790 行原实现完全一致，只把「命中非首选字段」暴露成信号。
/**
 * 从 guard 回调的 exec 中解析工具名。
 * 顺序固定为 name → call.name → tool，缺一不可（删掉回退会重演整批误拒）。
 * @param {import('./types.js').ExecShapeInput | null | undefined} exec
 * @returns {import('./types.js').ExecToolNameResult}
 */
export function readExecToolName(exec) {
  /** @type {Array<[import('./types.js').ExecToolNameField, unknown]>} */
  const candidates = [
    ['name', exec?.name],
    ['call.name', exec?.call?.name],
    ['tool', exec?.tool],
  ];
  for (const [field, value] of candidates) {
    if (typeof value === 'string' && value) {
      return { ok: true, name: value, field, fallback: field !== 'name' };
    }
  }
  return { ok: false, name: null, field: null, reason: 'missing-exec-name' };
}

// #2：inbox target 写成 'nextTurn'（驼峰），正确值是 'next-turn'。
/** @type {readonly string[]} */
const INJECT_TARGETS = Object.freeze(['next-turn']);

/**
 * 校验 inbox 注入目标，非法值立即抛错（本地构造 bug，抛错安全）。
 * @param {unknown} target
 * @returns {import('./types.js').InjectTarget} 原样返回合法目标。
 */
export function assertValidInjectTarget(target) {
  if (typeof target !== 'string' || !INJECT_TARGETS.includes(target)) {
    throw new Error(
      `ERR_INVALID_INJECT_TARGET: 非法注入目标 ${JSON.stringify(target)}；允许：${INJECT_TARGETS.join(', ')}`,
    );
  }
  return /** @type {import('./types.js').InjectTarget} */ (target);
}

// #3：注入消息缺 id/source 导致会话日志损坏（format v4 要求 producer-owned source kind）。
/**
 * 校验注入消息，缺 id / source 立即抛错。
 * @param {unknown} msg
 * @returns {import('./types.js').InjectMessage} 原样返回合法消息。
 */
export function assertValidInjectMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    throw new Error('ERR_INVALID_INJECT_MESSAGE: 消息必须是对象');
  }
  const m = /** @type {{ id?: unknown, source?: { kind?: unknown } | null }} */ (msg);
  if (typeof m.id !== 'string' || m.id.trim() === '') {
    throw new Error('ERR_INVALID_INJECT_MESSAGE: 缺少非空 id');
  }
  if (!m.source || typeof m.source !== 'object'
    || typeof m.source.kind !== 'string' || m.source.kind === '') {
    throw new Error('ERR_INVALID_INJECT_MESSAGE: 缺少 source（format v4 要求 producer-owned source kind）');
  }
  return /** @type {import('./types.js').InjectMessage} */ (msg);
}

// #9：测试实际跑在旧的生产代码上（profile 与生产代码哈希不一致时误读结果）。
/**
 * 比对宿主自报的指纹与磁盘指纹。
 * @param {import('./types.js').SelftestHostResult | null | undefined} selftestResult
 * @param {string} [baseDir]
 * @returns {true} 一致时返回 true；不一致或缺字段时抛 ERR_STALE_HOST_CODE。
 */
export function assertHostCodeFresh(selftestResult, baseDir = __moduleDir) {
  const host = selftestResult?.codeFingerprint;
  if (!host || typeof host.bundleHash !== 'string') {
    throw new Error('ERR_STALE_HOST_CODE: selftest 返回里没有 codeFingerprint，无法确认宿主加载的代码版本');
  }
  const disk = computeDiskFingerprint(baseDir).bundleHash;
  if (host.bundleHash !== disk) {
    throw new Error(
      `ERR_STALE_HOST_CODE: 宿主运行代码哈希与磁盘不一致（host=${host.bundleHash} disk=${disk}），请先 reload 插件`,
    );
  }
  return true;
}

/**
 * 供 checks/ 使用的边界函数出口。冻结，防止测试侧改写。
 */
export const __test_hooks__ = Object.freeze({
  readExecToolName,
  assertValidInjectTarget,
  assertValidInjectMessage,
  computeDiskFingerprint,
  assertHostCodeFresh,
  discoverCodeFiles,
  LOADED_CODE_FINGERPRINT,
  CODE_FILES,
});
