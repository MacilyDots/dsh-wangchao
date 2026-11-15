#!/usr/bin/env node
// exec-budget.lock 诊断 / 显式确认后的清理（随 npm 包发布，见 package.json files 与 bin/）。
//
// 用法：
//   只读诊断（默认，绝不修改文件）：
//     node bin/check-locks.mjs [--state-dir <dir>] [--json]
//   清理（必须同时给出同一目录的 --state-dir 与 --confirm）：
//     node bin/check-locks.mjs --state-dir <dir> --confirm <dir> [--json]
//   或：npm run check:locks -- --state-dir <dir> [--confirm <dir>]
//
// 退出码：0 = 无需人工处理；1 = 用法/内部错误；2 = 需要人工处理（有锁/有残留/状态不可确认/拒绝清理）。
//
// 安全边界：诊断只读；清理只处理「本机强身份（machine-id 级）+ PID 明确不存在 + 计划后内容未变化」的锁。
// rename 窗口与恢复动作都有不可消除的竞态（原路径在 rename 瞬间空缺，其它实例可创建新锁；
// 恢复也绝不覆盖已存在文件）。因此清理的硬性前置条件是：**事先停止所有使用该 stateDir 的实例**。
// 工具无法验证这一点，也不承诺「绝不误删」，只负责缩小窗口与留下证据。详见 README 与 bin/lock-doctor.mjs 头注释。
import path from 'node:path';
import {
  inspectStateDir,
  planLockCleanup,
  executeLockCleanup,
  summarizeReport,
  statWatchedFiles,
  reasonText,
} from './lock-doctor.mjs';

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_ATTENTION = 2;

const HELP = `exec-budget.lock 诊断与清理（dsh-wangchao）

用法：
  node bin/check-locks.mjs [--state-dir <dir>] [--json]
      只读诊断。默认 stateDir = $DSH_HOME/wangchao（未设置 DSH_HOME 时为 ./wangchao）。

  node bin/check-locks.mjs --state-dir <dir> --confirm <dir>
      清理【已确认失效】的锁。--confirm 的值必须与 --state-dir 解析后一致。
      只清理：本机强身份（machine-id 级）+ PID 明确不存在 + 计划后内容未变化的锁。
      旧格式锁、跨主机、主机身份退化、PID 仍存在/不可判定 → 一律拒绝清理。

选项：
  --state-dir <dir>   账本/锁/epoch 所在目录（与 exec-budget.json 同目录）
  --json              输出机器可读 JSON
  --help, -h          显示本帮助

退出码：0 无需人工；1 用法/内部错误；2 需要人工处理。

清理硬性前置条件（工具无法验证，必须由人保证）：
  1) 事先停止所有使用该 stateDir 的实例：DSH 桌面端、CLI、独立窗口等全部退出；
  2) 确认诊断结论为 stale-candidate，且该锁不属于仍在运行的进程；
  3) 理解竞态不可消除：rename 瞬间原路径空缺，其它实例可能创建新锁；恢复动作也不覆盖已存在文件。
     若前置条件不满足，清理可能短暂移走别的新锁（不删除其内容，恢复失败时留在 quarantine）。
工具只负责缩小窗口、留下证据，不承诺「绝不误删」。
`;

function usageError(message) {
  const e = new Error(message);
  e.code = 'USAGE';
  return e;
}

function parseArgs(argv) {
  const out = { stateDir: undefined, confirm: undefined, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--state-dir' || a === '--stateDir') {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('--')) throw usageError('--state-dir 需要一个目录值');
      out.stateDir = String(v);
      i += 1;
    } else if (a.startsWith('--state-dir=')) out.stateDir = a.slice('--state-dir='.length);
    else if (a.startsWith('--stateDir=')) out.stateDir = a.slice('--stateDir='.length);
    else if (a === '--confirm') {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('--')) throw usageError('--confirm 需要目标 stateDir 的值');
      out.confirm = String(v);
      i += 1;
    } else if (a.startsWith('--confirm=')) out.confirm = a.slice('--confirm='.length);
    else throw usageError(`未知参数：${a}`);
  }
  return out;
}

const normPath = (p) => {
  const r = path.resolve(String(p));
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

function defaultStateDir() {
  const home = process.env.DSH_HOME;
  return home ? path.join(home, 'wangchao') : path.join(process.cwd(), 'wangchao');
}

function printReport(report) {
  const lines = summarizeReport(report);
  lines.push('');
  const verdict = report.lock.verdict;
  if (verdict === 'absent' && report.orphanCount === 0) {
    lines.push(report.stateDirExists === false
      ? '结论：stateDir 不存在（按无锁处理：插件尚未初始化或路径写错）。'
      : '结论：没有锁，也没有需要人工处理的残留。');
  } else if (verdict === 'live') {
    lines.push('结论：锁由本机当前运行中的进程持有（live）。若这是你正在运行的实例，属正常状态，绝不要清理；');
    lines.push('      只有确认该进程已退出、但重启仍报 LOCK_HELD 时，才需要人工处理（届时重新诊断）。');
  } else if (verdict === 'stale-candidate') {
    lines.push('结论：锁看起来已失效（本机强身份 + PID 明确不存在），但仍需人工确认后清理；本工具不会自动清理。');
    lines.push('硬性前置条件：先停止所有使用该 stateDir 的实例（DSH 桌面端/CLI/独立窗口全部退出），工具无法验证。');
    lines.push('确认后执行（--confirm 的值必须与 --state-dir 一致）：');
    lines.push(`  node bin/check-locks.mjs --state-dir "${report.stateDir}" --confirm "${report.stateDir}"`);
  } else if (verdict === 'unknown') {
    lines.push('结论：锁状态无法确认（旧格式/跨主机/身份不足/PID 不可判定），按 fail-closed 不提供自动清理。');
    lines.push(`原因：${report.lock.reasons.map(reasonText).join('；') || '锁状态无法确认'}`);
    lines.push('处理方式：人工核对该锁来源后自行决定（本工具不删除任何内容）。');
  } else {
    lines.push('结论：存在需要人工处理的残留；本工具不会自动清理。');
  }
  if (report.orphanCount > 0) {
    lines.push('残留的 tmp/quarantine 文件请人工核对后处理（本工具不清理）：');
    for (const [k, list] of Object.entries(report.orphans)) {
      if (list.length) lines.push(`  ${k}: ${list.map((n) => path.join(report.stateDir, n)).join('、')}`);
    }
  }
  if (report.epoch.error) lines.push(`epoch 文件异常：${report.epoch.error}`);
  lines.push('');
  lines.push(report.note);
  return lines.join('\n');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stdout.write(`参数错误：${e?.message ?? e}\n\n${HELP}`);
    return EXIT_USAGE;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  const stateDir = args.stateDir ?? defaultStateDir();

  // 清理模式：--confirm 必须存在，且与 --state-dir 指向同一目录（防止误对错误目录操作）。
  if (args.confirm !== undefined) {
    if (args.stateDir === undefined) throw usageError('清理必须同时给出 --state-dir <dir> 与 --confirm <dir>');
    if (normPath(args.confirm) !== normPath(stateDir)) {
      throw usageError('--confirm 的目标目录必须与 --state-dir 完全一致');
    }
    const plan = planLockCleanup(stateDir);
    if (!plan.ok) {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ mode: 'cleanup', ...plan }, null, 2)}\n`);
      } else {
        process.stdout.write(`拒绝清理：${plan.message}\n\n${printReport(plan.report)}\n`);
      }
      return EXIT_ATTENTION;
    }
    const PLAN_PRECONDITIONS = [
      '事先停止所有使用该 stateDir 的实例（DSH 桌面端、CLI、独立窗口等全部退出）',
      '确认诊断结论为 stale-candidate，且该锁不属于仍在运行的进程',
      '理解竞态不可消除：rename 瞬间原路径空缺，其它实例可能创建新锁；恢复动作不覆盖已存在文件',
    ];
    if (!args.json) {
      process.stdout.write('清理前置条件（必须满足；工具无法验证）：\n');
      for (const [i, item] of PLAN_PRECONDITIONS.entries()) process.stdout.write(`  ${i + 1}) ${item}\n`);
      process.stdout.write('\n');
    }
    const watchedBefore = statWatchedFiles(stateDir);
    const result = executeLockCleanup(plan);
    const watchedAfter = statWatchedFiles(stateDir);
    const watchedChanged = Object.keys(watchedBefore)
      .filter((k) => JSON.stringify(watchedBefore[k]) !== JSON.stringify(watchedAfter[k]));
    if (args.json) {
      process.stdout.write(`${JSON.stringify({
        mode: 'cleanup',
        plan: { stateDir: plan.stateDir, lockPath: plan.lockPath },
        preconditions: { required: PLAN_PRECONDITIONS, verifiedByTool: false },
        result,
        watched: { before: watchedBefore, after: watchedAfter, changed: watchedChanged },
      }, null, 2)}\n`);
    } else if (result.ok) {
      process.stdout.write(`清理完成：${result.message}\n`);
      if (watchedChanged.length === 0) {
        process.stdout.write('旁证：exec-budget.json / writer-epoch.json 未变化（本工具只删了锁文件）。\n');
      } else {
        process.stdout.write(`警告：账本/epoch 文件在清理期间发生变化（${watchedChanged.join('、')}），说明可能仍有实例在写该 stateDir，请立即人工核对。\n`);
      }
    } else {
      process.stdout.write(`清理失败：${result.code} — ${result.message}\n`);
    }
    if (watchedChanged.length > 0) return EXIT_ATTENTION;
    return result.ok ? EXIT_OK : EXIT_ATTENTION;
  }

  let report;
  try {
    report = inspectStateDir(stateDir);
  } catch (e) {
    process.stdout.write(`${args.json ? JSON.stringify({ error: String(e?.message ?? e) }) : `诊断失败：${e?.message ?? e}`}\n`);
    return EXIT_USAGE;
  }
  if (args.json) process.stdout.write(`${JSON.stringify({ mode: 'diagnose', ...report }, null, 2)}\n`);
  else process.stdout.write(`${printReport(report)}\n`);
  return report.needsAttention ? EXIT_ATTENTION : EXIT_OK;
}

try {
  process.exitCode = main();
} catch (e) {
  if (e?.code === 'USAGE') {
    process.stdout.write(`参数错误：${e.message}\n\n${HELP}`);
    process.exitCode = EXIT_USAGE;
  } else {
    process.stderr.write(`内部错误：${e?.stack ?? e}\n`);
    process.exitCode = EXIT_USAGE;
  }
}
