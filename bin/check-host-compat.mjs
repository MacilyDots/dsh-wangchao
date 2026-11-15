#!/usr/bin/env node
// check:host-compat —— dsh-wangchao 宿主兼容性探针启动器。
//
// 在「真实安装宿主 + 隔离 HOME/DSH_HOME + 假 provider」下启动一个独立 DSH 实例，
// 由 bin/host-compat-probe 插件在宿主进程内真实调用四个接口并把证据写到 JSON：
//   1) agents                          （list / create / get / dispose）
//   2) tools.guard                     （守卫注册、checkGuards 执行点）
//   3) sessionController.observeEvent  （ready 帧 + 真实会话事件帧）
//   4) subagents.startActivation       （真实子 Agent 激活，模型走假 provider）
//
// 退出码：
//   0  PASS      四接口真实调用成功；版本不同会明确提示，并不代表完整兼容
//   1  FAIL      接口缺失/调用失败、无法确认清理、或没有观察到假模型请求
//   2  SKIP      找不到真实安装宿主（或环境不支持），此时不宣称通过
//
// 使用：
//   npm run check:host-compat
//   npm run check:host-compat -- --json
//   npm run check:host-compat -- --host-root "<desktop install root>"
//   npm run check:host-compat -- --keep --timeout-ms 180000
//
// 本脚本不会：写入桌面 profile、读取真实凭证、发出真实模型请求。

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_DIR = path.join(ROOT, 'bin', 'host-compat-probe');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXPECTED = pkg?.dsh?.compat?.dsh ?? null;
const DESKTOP_EXE = 'DeepSeek Harness.exe';
const DEFAULT_TIMEOUT_MS = 150_000;
const HOST_LOG_LIMIT = 60;

// 系统工具一律用 System32 绝对路径执行，避免 PATH 被改写时跑到非预期程序。
const SYSTEM_ROOT = (() => {
  const root = process.env.SystemRoot || process.env.windir;
  if (!root || !path.isAbsolute(root)) return null;
  try {
    return fs.statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
})();
function systemTool(...parts) {
  if (process.platform !== 'win32' || !SYSTEM_ROOT) return null;
  const candidate = path.join(SYSTEM_ROOT, ...parts);
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}
const POWERSHELL = systemTool('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const NETSTAT = systemTool('System32', 'netstat.exe');
const TASKKILL = systemTool('System32', 'taskkill.exe');

const args = process.argv.slice(2);
const opt = { json: false, keep: false, help: false, hostRoot: null, hostKind: null, timeoutMs: DEFAULT_TIMEOUT_MS };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') opt.json = true;
  else if (a === '--keep') opt.keep = true;
  else if (a === '--help' || a === '-h') opt.help = true;
  else if (a === '--host-root') opt.hostRoot = args[++i];
  else if (a === '--host-kind') opt.hostKind = args[++i];
  else if (a === '--timeout-ms') opt.timeoutMs = Number(args[++i]);
  else {
    console.error(`check:host-compat: unknown argument "${a}"`);
    process.exit(1);
  }
}

if (opt.help) {
  console.log(`dsh-wangchao host compatibility check

  npm run check:host-compat [-- options]

  --host-root <dir>   desktop install root (contains "${DESKTOP_EXE}") or a global @deepseek-ai/dsh package dir
  --host-kind         desktop | npm
  --timeout-ms <n>    host startup + probe timeout (default ${DEFAULT_TIMEOUT_MS})
  --json              machine readable report on stdout
  --keep              keep the temporary HOME/DSH_HOME directory for inspection

  Host discovery without --host-root: DSH_INSTALL_DIR (desktop install root),
  DSH_NODE_EXECUTABLE (desktop runtime executable or node binary), conventional
  system install locations, then a global @deepseek-ai/dsh npm package.

  Expected host version (package.json dsh.compat.dsh): ${EXPECTED ?? '(not declared)'}
  Exit codes: 0 = PASS, 1 = FAIL, 2 = SKIP (no real host installed).`);
  process.exit(0);
}

// ---------- asar 读取（桌面安装把 dsh 运行时放在 app.asar 内） ----------
function readAsarEntry(asarPath, entryPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const hdr = Buffer.alloc(jsonLen);
    fs.readSync(fd, hdr, 0, jsonLen, 16);
    const header = JSON.parse(hdr.toString('utf8'));
    const base = 8 + headerSize;
    let node = header;
    for (const part of entryPath.split('/').filter(Boolean)) node = node?.files?.[part];
    if (!node || node.size === undefined || node.offset === undefined) return null;
    const buf = Buffer.alloc(Number(node.size));
    fs.readSync(fd, buf, 0, Number(node.size), base + Number(node.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function asarHasEntry(asarPath, entryPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const hdr = Buffer.alloc(jsonLen);
    fs.readSync(fd, hdr, 0, jsonLen, 16);
    let node = JSON.parse(hdr.toString('utf8'));
    for (const part of entryPath.split('/').filter(Boolean)) node = node?.files?.[part];
    return Boolean(node);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- 宿主探测 ----------
function detectDesktop(root) {
  const exe = path.join(root, DESKTOP_EXE);
  const asar = path.join(root, 'resources', 'app.asar');
  if (!fs.existsSync(exe) || !fs.existsSync(asar)) return null;
  let runtime = null;
  try {
    const raw = readAsarEntry(asar, 'dsh/package.json');
    runtime = raw ? JSON.parse(raw.toString('utf8')) : null;
  } catch {
    runtime = null;
  }
  if (!runtime) return null;
  const dshVersion = runtime?.dependencies?.['@deepseek-ai/dsh'] ?? null;
  const cliPath = path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!asarHasEntry(asar, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')) return null;
  return {
    kind: 'desktop',
    root,
    exe,
    asar,
    cliPath,
    nodeCmd: exe,
    nodeArgsPrefix: [],
    runtimeName: runtime.name ?? null,
    runtimeVersion: runtime.version ?? null,
    dshVersion,
  };
}

function detectNpm(root) {
  const pkgFile = path.join(root, 'package.json');
  if (!fs.existsSync(pkgFile)) return null;
  let info = null;
  try { info = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch { return null; }
  if (info.name !== '@deepseek-ai/dsh') return null;
  const cliPath = path.join(root, 'lib', 'bin.js');
  if (!fs.existsSync(cliPath)) return null;
  return { kind: 'npm', root, cliPath, nodeCmd: process.execPath, nodeArgsPrefix: [], runtimeName: info.name, runtimeVersion: info.version, dshVersion: info.version };
}

function npmGlobalRoot() {
  const candidates = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules'));
  return [...new Set(candidates)];
}

// 桌面安装根：优先运行时显式提示，其次常规系统安装位置；不内置任何本机绝对路径。
function envDesktopRoots() {
  const roots = [];
  if (process.env.DSH_INSTALL_DIR) roots.push(path.resolve(process.env.DSH_INSTALL_DIR));
  if (process.env.DSH_NODE_EXECUTABLE) roots.push(path.dirname(path.resolve(process.env.DSH_NODE_EXECUTABLE)));
  return [...new Set(roots)];
}

function conventionalDesktopRoots() {
  const app = 'DeepSeek Harness';
  return [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', app) : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, app) : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], app) : null,
    process.env.ProgramW6432 ? path.join(process.env.ProgramW6432, app) : null,
  ].filter(Boolean);
}

function detectHost() {
  if (opt.hostRoot) {
    const root = path.resolve(opt.hostRoot);
    if (opt.hostKind === 'npm') return detectNpm(root);
    const desk = detectDesktop(root);
    if (desk) return desk;
    return detectNpm(root);
  }
  if (opt.hostKind !== 'npm') {
    // DSH_INSTALL_DIR 既可能指向桌面安装根，也可能指向 @deepseek-ai/dsh 包目录，两种都试。
    for (const r of envDesktopRoots()) {
      const hit = detectDesktop(r) ?? detectNpm(r);
      if (hit) return hit;
    }
    for (const r of conventionalDesktopRoots()) {
      const hit = detectDesktop(r) ?? detectNpm(r);
      if (hit) return hit;
    }
  }
  for (const r of npmGlobalRoot()) {
    const hit = detectNpm(path.join(r, '@deepseek-ai', 'dsh'));
    if (hit) return hit;
  }
  return null;
}

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toPosix = (p) => p.replaceAll('\\', '/');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function yamlQuote(s) {
  return JSON.stringify(String(s));
}

function makePatchFile(outFile, workDir, hostVersion) {
  const cfg = [
    `        outFile: ${yamlQuote(toPosix(outFile))}`,
    `        workDir: ${yamlQuote(toPosix(workDir))}`,
    `        hostVersion: ${yamlQuote(hostVersion ?? 'unknown')}`,
    `        compatDsh: ${yamlQuote(EXPECTED ?? '')}`,
  ].join('\n');
  return `# generated by dsh-wangchao check:host-compat
- insert:
    - id: host-compat-probe
      name: host-compat-probe
      config:
${cfg}
`;
}

function writeProfile(base, probeDir) {
  const home = path.join(base, 'home');
  const work = path.join(base, 'work');
  const out = path.join(base, 'out');
  const profile = path.join(home, 'profiles', 'hostcompat');
  const modules = path.join(profile, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'hostcompat', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2),
  );
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
  fs.cpSync(probeDir, path.join(modules, 'host-compat-probe'), { recursive: true });
  return { home, work, out, profile };
}

function buildChildEnv(home) {
  const tmp = path.join(home, 'tmp');
  const appData = path.join(home, 'appdata');
  const localAppData = path.join(home, 'localappdata');
  for (const dir of [tmp, appData, localAppData]) fs.mkdirSync(dir, { recursive: true });
  // 白名单：只传宿主运行必需的系统变量。不继承 DSH 配置、用户配置、任何凭据或代理设置。
  const allow = ['PATH', 'Path', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'];
  const env = {};
  for (const key of allow) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.DSH_HOME = home;
  env.HOME = home;
  env.USERPROFILE = home;
  // 隔离 Chromium/Electron 与工具的每个用户级数据目录，避免读写真实 AppData。
  env.APPDATA = appData;
  env.LOCALAPPDATA = localAppData;
  env.TEMP = tmp;
  env.TMP = tmp;
  env.ELECTRON_RUN_AS_NODE = '1';
  env.NO_COLOR = '1';
  return env;
}

// netstat 是周期采样：只能发现采样窗口内、被跟踪 PID 的瞬间外连，不能证明「绝无外连」。
// 返回值：数组；null 表示查询不可用（未知），不是「没有外连」。
function sampleForeignConnections(pidSet) {
  if (!NETSTAT) return null;
  const out = [];
  try {
    const res = spawnSync(NETSTAT, ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (res.status !== 0) return null;
    for (const line of String(res.stdout ?? '').split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5 || !/^(TCP|UDP)/.test(cols[0])) continue;
      if (!pidSet.has(cols[cols.length - 1])) continue;
      const remote = cols[2];
      if (/^(127\.|0\.0\.0\.0|\[::1\]|\[::\]|::1|\*)/.test(remote)) continue;
      if (!out.includes(remote)) out.push(remote);
    }
  } catch {
    return null;
  }
  return out;
}

// 进程表快照（System32 绝对路径的 PowerShell）。返回数组；null 表示查询失败（未知）。
function snapshotProcesses() {
  if (process.platform !== 'win32' || !POWERSHELL) return null;
  try {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    const res = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (res.status !== 0) return null;
    const text = String(res.stdout ?? '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
}

// 从根 PID 沿 ParentProcessId 展开后代 PID（只用于本实例的进程树，不按镜像名/路径匹配）。
function descendantsOf(procs, rootPid) {
  const byParent = new Map();
  for (const p of procs) {
    const pid = Number(p?.ProcessId);
    const ppid = Number(p?.ParentProcessId);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push(pid);
  }
  const out = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of byParent.get(current) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

// 等待跟踪的 PID 集合全部消失。返回 number（仍存活数）、null（无法确认，未知）。
// 注意：这是「跟踪集合的消失证据」，不是对全系统进程的穷举证明；PID 复用在极短时间内理论上可能，
// 因此报告把它标注为 tracked-pid-set 而非「系统内绝无残留」。
async function waitTrackedGone(trackedPids, maxMs) {
  if (trackedPids.size === 0) return null;
  const deadline = Date.now() + maxMs;
  let remaining = null;
  while (Date.now() < deadline) {
    const procs = snapshotProcesses();
    if (procs === null) return null;
    const alive = new Set(procs.map((p) => Number(p?.ProcessId)).filter(Number.isInteger));
    remaining = [...trackedPids].filter((pid) => pid !== process.pid && alive.has(pid)).length;
    if (remaining === 0) return 0;
    await sleep(400);
  }
  return remaining;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32' && TASKKILL) {
      // 只停止本探针启动的这一个 PID 及其子进程树；不按镜像名或路径匹配，避免误杀桌面端或其它实例。
      spawnSync(TASKKILL, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {}
}

function tailFile(file, lines) {
  try {
    const text = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
    return text.slice(-lines);
  } catch {
    return [];
  }
}

function summarize(result, host, timings, report) {
  const interfaces = result?.interfaces ?? {};
  const lines = [];
  lines.push(`host: ${host.kind} ${host.root}`);
  lines.push(`host dsh version: ${host.dshVersion ?? 'unknown'} (declared tested version ${EXPECTED ?? 'not declared'})`);
  if (!EXPECTED || host.dshVersion !== EXPECTED) lines.push('Version differs from the declared tested version; probe results are not a full compatibility guarantee.');
  lines.push(`probe: ${result?.status ?? 'no-result'}`);
  for (const [key, value] of Object.entries(interfaces)) {
    const status = value?.status ?? 'missing';
    const detail = value?.error ? ` — ${value.error}` : '';
    lines.push(`  ${key}: ${status}${detail}`);
  }
  const fake = result?.fake ?? {};
  lines.push(`fake provider: registered=${fake.registered ?? false} calls=${fake.calls ?? 0} foreignProviders=${(fake.foreignProviders ?? []).join(',') || 'none'}`);
  if ((fake.providersSeen ?? []).length) lines.push(`host llm providers: ${fake.providersSeen.join(', ')}`);
  const net = result?.network ?? {};
  const netNote = report?.network?.unavailable ? ' (netstat unavailable: NOT a zero-connection proof)' : '';
  lines.push(`network: in-process HTTP requests=${(net.requests ?? []).length} foreign=${(net.foreign ?? []).join(',') || 'none'}; netstat sample-based samples=${report?.network?.samples ?? 0} foreign=${(report?.network?.foreign ?? []).join(',') || 'none'}${netNote}`);
  const leftoverText = report?.leftoverProcesses === null
    ? 'unknown (tracking unavailable; NOT a zero-leftover proof)'
    : (report?.leftoverProcesses ?? '?');
  lines.push(`process: host exit=${JSON.stringify(report?.hostExit ?? null)} tracked=${report?.trackedPids ?? 0} leftover=${leftoverText} (tracked-pid-set, not system-wide)`);
  lines.push(`temp HOME/DSH_HOME: ${report?.tempDirRemoved ? 'removed' : `kept at ${report?.tempDir ?? '?'}`}`);
  if (result?.errors?.length) for (const e of result.errors.slice(0, 5)) lines.push(`error: ${e}`);
  if (result?.notCovered?.length) for (const n of result.notCovered.slice(0, 8)) lines.push(`not covered: ${n}`);
  lines.push(`elapsed: ${timings.elapsedMs}ms`);
  return lines;
}

// ---------- 主流程 ----------
async function main() {
  const startedAt = Date.now();
  const host = detectHost();
  if (!host) {
    const report = {
      status: 'skipped',
      reason: `no real DSH installation found (looked for "${DESKTOP_EXE}" desktop installs and a global @deepseek-ai/dsh package)`,
      expected: EXPECTED,
    };
    if (opt.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`SKIP: ${report.reason}\nExpected host version: ${EXPECTED ?? 'not declared'}`);
    return 2;
  }

  // 版本不同仍运行探针：四项接口通过不等于该宿主版本获得完整兼容承诺。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-compat-'));
  const { home, work, out } = writeProfile(base, PROBE_DIR);
  const outFile = path.join(out, 'result.json');
  const patchFile = path.join(out, 'host-compat.patch.yml');
  const logFile = path.join(out, 'host.log');
  fs.writeFileSync(patchFile, makePatchFile(outFile, work, host.dshVersion));

  const port = await freePort();
  const env = buildChildEnv(home);
  const cliArgs = ['--profile', 'hostcompat', '--patch', patchFile, '--no-open', '--port', String(port)];
  const report = {
    status: 'failed',
    host: { kind: host.kind, root: host.root, runtimeName: host.runtimeName, runtimeVersion: host.runtimeVersion, dshVersion: host.dshVersion },
    expected: EXPECTED,
    versionMatchesDeclared: Boolean(EXPECTED && host.dshVersion === EXPECTED),
    probe: null,
    tempDir: base,
  };

  // 网络观测是采样，不是全覆盖：netstat 只覆盖「被跟踪 PID 集合」在采样窗口内的连接快照；
  // 探针进程内的 fetch 观测是更强的直接证据，但也不覆盖非 fetch 的 HTTP 客户端。
  const networkWatch = { samples: 0, foreign: [], unavailable: false, note: 'periodic netstat sampling for tracked host PIDs; not a proof of zero outbound connections' };
  report.network = networkWatch;
  // 进程追踪：启动期周期性采样 Win32_Process，按 ParentProcessId 展开本实例进程树并跟踪 PID 集合；
  // 结束后以「跟踪 PID 全部消失」为可证实的清理证据，查询失败则标 unknown，不宣称 0 残留。
  const processWatch = { samples: 0, trackedPids: 0, source: 'cim-snapshot', unavailable: false, note: 'tracked from periodic Win32_Process snapshots of the probe-started host PID tree; not an exhaustive system-wide proof' };
  const trackedPids = new Set();
  report.processTracking = processWatch;
  report.hostExit = null;
  let exitCode = 1;

  let child = null;
  let logStream = null;
  try {
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
    child = spawn(host.nodeCmd, [...host.nodeArgsPrefix, host.cliPath, ...cliArgs], {
      cwd: work,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => logStream.write(d));
    child.stderr.on('data', (d) => logStream.write(d));
    let exitInfo = null;
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; report.hostExit = exitInfo; });

    const deadline = Date.now() + opt.timeoutMs;
    let result = null;
    let lastSample = 0;
    while (Date.now() < deadline) {
      if (fs.existsSync(outFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
          if (parsed?.status && parsed.status !== 'running') { result = parsed; break; }
        } catch { /* 半写状态，继续等 */ }
      }
      if (exitInfo) break;
      if (Date.now() - lastSample >= 1000) {
        lastSample = Date.now();
        const procs = snapshotProcesses();
        processWatch.samples += 1;
        if (procs === null) {
          processWatch.unavailable = true;
        } else {
          for (const pid of descendantsOf(procs, child.pid)) trackedPids.add(pid);
          processWatch.trackedPids = trackedPids.size;
          const pidSet = new Set([...trackedPids].map((pid) => String(pid)));
          const foreign = sampleForeignConnections(pidSet);
          networkWatch.samples += 1;
          if (foreign === null) {
            networkWatch.unavailable = true;
          } else {
            for (const remote of foreign) if (!networkWatch.foreign.includes(remote)) networkWatch.foreign.push(remote);
          }
        }
      }
      await sleep(200);
    }

    if (!result) {
      report.status = 'failed';
      report.reason = exitInfo ? `host exited before writing a probe result (code=${exitInfo.code})` : `probe timed out after ${opt.timeoutMs}ms`;
      report.hostLogTail = tailFile(logFile, HOST_LOG_LIMIT);
    } else {
      report.probe = result;
      const statuses = Object.values(result.interfaces ?? {}).map((x) => x?.status);
      const fakeForeign = (result.fake?.foreignProviders ?? []).length;
      const networkForeign = (result.network?.foreign ?? []).length + networkWatch.foreign.length;
      if (result.status === 'ok' && statuses.length === 4 && statuses.every((s) => s === 'ok') && (result.fake?.calls ?? 0) > 0 && fakeForeign === 0 && networkForeign === 0) {
        report.status = 'passed';
      } else if (result.status === 'skipped') {
        report.status = 'skipped';
      } else {
        report.status = 'failed';
        report.reason = 'probe reported incomplete or failing interfaces'
          + (networkForeign ? ` (outbound non-loopback traffic observed: ${networkWatch.foreign.join(',') || result.network?.foreign?.join(',')})` : '');
      }
    }
  } finally {
    killTree(child);
    // 等待被停止的宿主退出（最多 8s），再核对跟踪 PID 集合是否消失。
    if (child && child.exitCode === null) {
      const stopDeadline = Date.now() + 8000;
      while (child.exitCode === null && Date.now() < stopDeadline) await sleep(200);
    }
    if (!report.hostExit && child) report.hostExit = { code: child.exitCode, signal: child.signalCode, killed: true };
    report.leftoverProcesses = await waitTrackedGone(trackedPids, 6000);
    report.trackedPids = trackedPids.size;
    processWatch.trackedPids = trackedPids.size;
    if (report.leftoverProcesses === null || report.leftoverProcesses > 0 || (child && child.exitCode === null)) {
      report.status = 'failed';
      report.reason = `host process cleanup could not be confirmed: ${report.leftoverProcesses ?? 'unknown'}`;
    }
    logStream?.end();
    const elapsedMs = Date.now() - startedAt;
    report.elapsedMs = elapsedMs;
    if (report.status !== 'passed' && report.status !== 'skipped' && !report.hostLogTail) {
      report.hostLogTail = tailFile(logFile, HOST_LOG_LIMIT);
    }
    report.tempDirRemoved = false;
    if (!opt.keep && report.leftoverProcesses === 0 && (!child || child.exitCode !== null)) {
      try { fs.rmSync(base, { recursive: true, force: true }); report.tempDirRemoved = true; } catch {}
    }
    if (opt.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const lines = summarize(report.probe, host, { elapsedMs }, report);
      if (report.reason) lines.push(`reason: ${report.reason}`);
      if (report.status !== 'passed') {
        lines.push('--- host.log tail ---');
        for (const l of (report.hostLogTail ?? []).slice(-30)) lines.push(l);
      }
      console.log(lines.join('\n'));
      console.log(report.status === 'passed' ? 'PASS' : report.status === 'skipped' ? 'SKIP' : 'FAIL');
    }
    exitCode = report.status === 'passed' ? 0 : report.status === 'skipped' ? 2 : 1;
  }
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error('check:host-compat crashed:', e?.stack ?? e);
    process.exitCode = 1;
  });
