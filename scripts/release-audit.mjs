#!/usr/bin/env node
// 净室发布审计（clean-room release audit）。
//
// 目的：在「把仓库当成将要公开的发布物」这个假设下，检查三件事——
//   1) 树里没有本机隐私痕迹、凭据、临时产物（含 git 历史，前提是历史完整）；
//   2) npm 发布包只包含 package.json `files` 白名单声明的运行时文件：测试/检查/CI 不进包，
//      `bin/` 里的运行命令必须进包，`scripts/` 下的开发辅助代码默认不进包（除非被白名单显式声明）；
//   3) 从 tarball 干净安装后能真的 import 成功（净室可运行），且包内文件与工作区逐字节一致。
//
// 范围声明（诚实标注）：
//   · 本审计覆盖「当前工作区磁盘全集 + 本地 git 仓库（含未跟踪文件、完整历史）」。
//   · 不做远端克隆复核：那需要在空目录 `git clone <remote>` 后重跑 `npm run verify`，属于发布流程；
//     审计会在输出里显式打印这一缺口，不把它伪装成已覆盖。
//   · git 历史只在「非 shallow」时扫描；CI 必须 `fetch-depth: 0`，否则审计直接失败而不是静默跳过。

// 三个设计约束（对应踩过的坑）：
//   · 审计对象是「磁盘上真实存在的文件集合」，不是 `git ls-files`：未跟踪的新文件同样必须被扫描；
//     只有在 git 可用时，才额外核对「tracked 文件的磁盘存在性」与「untracked 文件确实被审计」。
//   · 脚本会进入公开仓库，所以不得把本机用户名/机器名/家目录明文写死；这些标识一律在运行时
//     从进程环境读取，报告里也只输出打码后的片段。
//   · 报告必须区分「实测通过」与「无法执行」：无法执行按失败处理，不静默放行。
//
// 用法：node scripts/release-audit.mjs
// 退出码：0 全部通过；1 有任何失败项。

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_NAME = path.basename(ROOT);
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const failures = [];
const passes = [];
let checks = 0;

/**
 * @param {string} label
 * @param {string} [detail]
 */
function pass(label, detail = '') {
  checks += 1;
  passes.push({ label, detail });
  console.log(`[PASS] ${label}${detail ? ' — ' + detail : ''}`);
}

/**
 * @param {string} label
 * @param {string} detail
 */
function fail(label, detail) {
  checks += 1;
  failures.push({ label, detail });
  console.log(`[FAIL] ${label} — ${detail}`);
}

/** 递归列出任意目录下的文件（POSIX 相对路径），用于净室安装目录比对。 */
function walkTree(baseDir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) out.push(path.relative(baseDir, abs).split(path.sep).join('/'));
    }
  };
  visit(baseDir);
  return out.sort();
}

/** 把绝对路径转成审计报告里的相对路径（POSIX 风格）。 */
const relOf = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/** 递归列出工作区文件（跳过 .git / node_modules），返回 POSIX 风格相对路径。 */
function walkFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(relOf(path.join(dir, entry.name)));
    }
  }
  return out.sort();
}

/**
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string, stderr: string, status: number | null }}
 */
function runGit(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

/**
 * 通过 node 调 npm（Windows 上直接 spawn 'npm.cmd' 不可靠）：
 * 优先用 npm 注入的 npm_execpath，其次用 node 安装目录里的 npm-cli.js，最后退回 npm.cmd。
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {{ ok: boolean, stdout: string, stderr: string, status: number | null }}
 */
function runNpm(args, opts = {}) {
  const cwd = opts.cwd ?? ROOT;
  // 嵌套 npm 不能继承外层 `npm run` 注入的 npm_config_*：例如 allow-scripts 这类
  // 安装期配置在 project-scoped install 下会被 npm 直接拒绝（EALLOWSCRIPTS），
  // 导致净室安装在这台机器上必然失败、在 CI 上却通过。审计必须与机器配置无关。
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key)) delete env[key];
  }
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(/** @returns {p is string} */ (p) => Boolean(p) && fs.existsSync(/** @type {string} */ (p)));

  for (const cli of candidates) {
    if (!/npm-cli\.js$/.test(cli)) continue;
    const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
    if (r.error) continue;
    return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  }
  const r = spawnSync('npm.cmd', args, { cwd, env, encoding: 'utf8', windowsHide: true, shell: true });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

/**
 * 从 npm --json 输出里取第一个完整 JSON 数组/对象。
 * @param {string} text
 * @returns {any}
 */
function parseJsonOutput(text) {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error('npm 输出里没有 JSON：' + text.slice(0, 300));
  for (let end = text.length; end > start; end -= 1) {
    const slice = text.slice(start, end).trim();
    if (!slice.endsWith(']') && !slice.endsWith('}')) continue;
    try { return JSON.parse(slice); } catch { /* 继续缩短 */ }
  }
  throw new Error('无法解析 npm 输出：' + text.slice(0, 300));
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 明确按文本读取的扩展名。 */
const TEXT_EXT = new Set([
  '.mjs', '.js', '.cjs', '.json', '.md', '.yml', '.yaml', '.html', '.htm', '.txt', '.ts', '.css',
  '.gitignore', '.gitattributes', '.npmignore', '.editorconfig',
  // 下面这些是曾经的扫描盲区：脚本/配置里最容易出现本机绝对路径，却不在旧白名单里。
  '.ps1', '.psm1', '.cmd', '.bat', '.sh', '.bash', '.zsh', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.jsonl', '.csv', '.lock', '.env', '.example', '.sample', '.rst', '.sql', '.svg',
]);

/** 明显二进制：不读内容。 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.webm', '.mp4', '.tgz', '.gz', '.zip',
  '.woff', '.woff2', '.ttf', '.pdf', '.exe', '.dll', '.node', '.wasm',
]);

/** 不扫描单个文件的最大体积：超过按「未扫描」计数，报告会在结论里点名。 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/**
 * 是否按文本读取。
 * 扩展名白名单只是快路径；未知扩展名/无扩展名文件按内容嗅探，避免
 * `.ps1`、`Dockerfile` 这类文件成为隐私扫描的盲区（旧实现的真实遗漏）。
 * @param {string} rel 相对路径
 * @param {string} [abs] 绝对路径；省略时只按扩展名判断
 * @returns {boolean}
 */
function isTextFile(rel, abs) {
  const base = path.basename(rel);
  const ext = base.startsWith('.') ? base.toLowerCase() : path.extname(base).toLowerCase();
  if (BINARY_EXT.has(ext)) return false;
  if (TEXT_EXT.has(ext)) return true;
  if (!abs) return false;
  try {
    const size = fs.statSync(abs).size;
    if (size > MAX_SCAN_BYTES) return false;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return false;
    const sample = buf.subarray(0, 4096).toString('utf8');
    if (sample.length === 0) return true;
    let printable = 0;
    for (const ch of sample) {
      if (ch === '\n' || ch === '\r' || ch === '\t' || ch >= ' ') printable += 1;
    }
    return printable / sample.length >= 0.9;
  } catch {
    return false;
  }
}

/**
 * 收集「必须被当成发布树一部分」的文件集合：
 * 磁盘全集 ∪ tracked ∪ untracked（未忽略）——未提交的新文件不能被漏掉。
 * @returns {{ files: string[], git: boolean, tracked: string[], untracked: string[], ignoredPresent: string[] }}
 */
function collectFiles() {
  const files = walkFiles();
  const tracked = [];
  const untracked = [];
  let git = false;

  if (fs.existsSync(path.join(ROOT, '.git'))) {
    const g1 = runGit(['-c', 'core.quotepath=false', 'ls-files', '-z', '--cached']);
    const g2 = runGit(['-c', 'core.quotepath=false', 'ls-files', '-z', '--others', '--exclude-standard']);
    if (g1.ok && g2.ok) {
      git = true;
      tracked.push(...g1.stdout.split('\0').filter(Boolean).map((p) => p.split(path.sep).join('/')));
      untracked.push(...g2.stdout.split('\0').filter(Boolean).map((p) => p.split(path.sep).join('/')));
    }
  }

  const union = new Set(files);
  for (const f of tracked) if (fs.existsSync(path.join(ROOT, f))) union.add(f);
  for (const f of untracked) union.add(f);

  const ignoredPresent = git
    ? files.filter((f) => !tracked.includes(f) && !untracked.includes(f))
    : [];

  return { files: [...union].sort(), git, tracked, untracked, ignoredPresent };
}

// ── 隐私模式 ────────────────────────────────────────────────────────────
// 注意：这些是「结构模式」，不含任何本机标识；本机标识在运行时从 env 读取后单独检查。
// 路径类的历史教训：只认反斜杠会漏掉正斜杠写法；只认带结尾斜杠会漏掉行尾路径；
// 只认 drive 路径会漏掉 UNC/WSL/家目录写法。下面的覆盖是对着这些漏检点补的。
const PRIVACY_PATTERNS = [
  { id: 'windows-drive-path', re: /(?:^|[^\w])[A-Za-z]:[\\/](?=[\w.\\/ -]|$)/g, hint: '绝对 Windows 路径' },
  { id: 'unix-home-path', re: /(?:^|[^\w])\/(?:Users|home)\/[A-Za-z0-9._-]+/g, hint: '用户家目录路径' },
  { id: 'win-home-path', re: /(?:^|[^\w])\\(?:Users|home)\\[A-Za-z0-9._-]+/g, hint: 'Windows 家目录路径' },
  { id: 'msys-home-path', re: /(?:^|[^\w])\/[A-Za-z]\/Users\/[A-Za-z0-9._-]+/g, hint: 'MSYS 风格家目录路径' },
  { id: 'unc-path', re: /(?:^|[^\w])\\\\(?!localhost\b|127\.0\.0\.1)[A-Za-z0-9._$-]+\\[^\s'"]+/g, hint: 'UNC 网络路径' },
  { id: 'forward-unc-path', re: /(?:^|[^\w:])\/\/(?!localhost\b|127\.0\.0\.1)[A-Za-z0-9._$-]+\/[^\s'"]+/g, hint: '正斜杠 UNC 路径' },
  { id: 'home-shorthand', re: /(?:^|[^\w])~\//g, hint: '家目录简写路径' },
  { id: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, hint: '私钥块' },
  { id: 'api-key-sk', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, hint: 'API key 形态（sk-）' },
  { id: 'api-key-stripe', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, hint: 'Stripe 风格密钥' },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, hint: 'GitHub token 形态' },
  { id: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, hint: 'GitLab token 形态' },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, hint: 'Slack token 形态' },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, hint: 'Google API key 形态' },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, hint: 'npm token 形态' },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, hint: 'AWS access key 形态' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, hint: 'JWT 形态' },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, hint: 'Bearer token 形态' },
  { id: 'url-basic-auth', re: /https?:\/\/[^\s/@:]+:[^\s/@]+@/g, hint: 'URL 内嵌账号密码' },
  { id: 'email-address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, hint: '邮箱地址' },
];

/** 运行时收集本机标识，打码后用于比对；不写死任何值。 */
function localIdentifiers() {
  /** @type {Map<string,string>} */
  const map = new Map();
  const generic = new Set(['root', 'user', 'users', 'admin', 'runner', 'runneradmin', 'localhost', 'windows', 'pc', 'me']);
  const src = [
    safe(() => os.userInfo().username),
    process.env.USERNAME,
    process.env.USER,
    process.env.LOGNAME,
    process.env.COMPUTERNAME,
    process.env.HOSTNAME,
  ];
  for (const raw of src) {
    const value = String(raw ?? '').trim();
    if (value.length < 3) continue;
    if (generic.has(value.toLowerCase())) continue;
    map.set('account:' + value, value);
  }
  const homes = [safe(() => os.homedir()), process.env.USERPROFILE, process.env.HOME];
  for (const raw of homes) {
    const value = String(raw ?? '').trim();
    // 家目录只取最后一段：完整路径可能包含机器名，且多数场景泄漏的是用户名段。
    const base = value ? path.basename(value.replace(/[\\/]+$/, '')) : '';
    if (base.length >= 3 && !generic.has(base.toLowerCase())) map.set('home:' + base, base);
  }
  return [...map.entries()].map(([id, value]) => ({ id, value }));
}

/** @template T @param {() => T} fn @returns {T | null} */
function safe(fn) {
  try { return fn(); } catch { return null; }
}

/** 打码：只保留首尾各 1 字符。 */
function mask(value) {
  if (value.length <= 2) return '*'.repeat(value.length);
  return value[0] + '*'.repeat(Math.min(8, value.length - 2)) + value[value.length - 1];
}

/**
 * 本机标识匹配：大小写不敏感（Windows 账号不区分大小写），但只在「路径上下文」里命中。
 *
 * 为什么限制上下文：本机账号名可能恰好等于公开署名（GitHub handle / 作者名），
 * 在 LICENSE、package.json、README 正文里出现是正常的，全量匹配会永久误报。
 * 真正的隐私泄漏形态是账号/机器名出现在本机路径里（含 URL 内的账号另行由 URL 规则处理），
 * 所以这里只认「标识紧邻路径分隔符」且该行不是 URL 的情况。
 *
 * @param {string} line
 * @param {{ id: string, value: string }[]} identifiers
 * @returns {{ id: string, hint: string, sample: string }[]}
 */
function matchIdentifiers(line, identifiers) {
  const lower = line.toLowerCase();
  /** @type {{ id: string, hint: string, sample: string }[]} */
  const hits = [];
  if (lower.includes('://')) return hits; // URL 里的账号/仓库名属公开标识，路径规则另管
  for (const ident of identifiers) {
    const token = ident.value.toLowerCase();
    let idx = lower.indexOf(token);
    let inPath = false;
    while (idx >= 0) {
      const before = lower[idx - 1] ?? '';
      const after = lower[idx + token.length] ?? '';
      if (before === '\\' || before === '/' || after === '\\' || after === '/') { inPath = true; break; }
      idx = lower.indexOf(token, idx + 1);
    }
    if (inPath) hits.push({ id: 'local-' + ident.id, hint: '本机标识', sample: mask(ident.value) });
  }
  return hits;
}

/**
 * 扫描一段文本里的隐私模式。返回的每条都带行号，样本一律打码（报告不得出现凭据原文）。
 * 同一函数同时服务工作区扫描与 git 历史扫描，保证两处口径一致。
 * @param {string} text
 * @param {{ id: string, value: string }[]} [identifiers]
 * @returns {{ line: number, id: string, hint: string, sample: string }[]}
 */
function scanTextPrivacy(text, identifiers = []) {
  /** @type {{ line: number, id: string, hint: string, sample: string }[]} */
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of PRIVACY_PATTERNS) {
      pattern.re.lastIndex = 0;
      for (const m of line.matchAll(pattern.re)) {
        hits.push({ line: i + 1, id: pattern.id, hint: pattern.hint, sample: mask(String(m[0]).trim()) });
      }
    }
    for (const h of matchIdentifiers(line, identifiers)) hits.push({ line: i + 1, ...h });
  }
  return hits;
}

/** 隐私扫描。 */
function privacyScan(files) {
  const identifiers = localIdentifiers();
  const hits = [];
  let scanned = 0;
  let skippedBinary = 0;
  /** @type {string[]} */
  const largeFiles = [];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    let size;
    try { size = fs.statSync(abs).size; } catch {
      fail('隐私扫描无法读取文件', rel);
      continue;
    }
    if (size > MAX_SCAN_BYTES) { largeFiles.push(rel); continue; }
    if (!isTextFile(rel, abs)) {
      skippedBinary += 1;
      fail('隐私扫描未覆盖二进制或不可读取文件', rel);
      continue;
    }
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch {
      fail('隐私扫描无法读取文件', rel);
      continue;
    }
    if (text.includes('\0')) {
      fail('隐私扫描发现未识别的二进制文件', rel);
      continue;
    }
    scanned += 1;
    for (const h of scanTextPrivacy(text, identifiers)) hits.push({ rel, ...h });
  }
  return { hits, scanned, identifiers: identifiers.length, skippedBinary, largeFiles };
}

// ── 临时/产物/凭据 文件扫描 ──────────────────────────────────────────────
const FORBIDDEN_FILE_PATTERNS = [
  { re: /\.tgz$|\.tar(?:\.gz)?$|\.zip$/i, hint: '打包产物' },
  { re: /\.(?:log|tmp|bak|orig|pid|diff|patch)$/i, hint: '临时/备份文件' },
  { re: /\.bak[-.]|\.swp$|~$/i, hint: '编辑器/备份残留' },
  { re: /(?:^|\/)(?:\.env(?:\.[A-Za-z0-9_.-]+)?|\.npmrc|\.credentials[^/]*)$/i, hint: '环境/凭据配置' },
  { re: /\.(?:pem|key|p12|pfx|jks|keystore)$/i, hint: '密钥材料' },
  { re: /(?:^|\/)(?:node_modules|dist|coverage|_tmp-tests|\.tmp|state|shots)(?:\/|$)/, hint: '依赖/构建/临时目录' },
  { re: /(?:^|\/)[^/]*-fixtures?(?:\/|$)|\/fixtures?\//i, hint: '测试夹具目录' },
  { re: /(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/, hint: '系统残留文件' },
];

/** @param {string[]} files */
function artifactScan(files) {
  const hits = [];
  for (const rel of files) {
    for (const p of FORBIDDEN_FILE_PATTERNS) {
      if (p.re.test(rel)) hits.push({ rel, hint: p.hint });
    }
  }
  return hits;
}

// ── git 历史审计 ────────────────────────────────────────────────────────
/**
 * 在单行文本上跑隐私模式，样本一律打码（审计报告不得出现凭据原文）。
 * @param {string} text
 * @param {string} commit
 * @param {{ id: string, value: string }[]} identifiers
 * @param {{ commit: string, id: string, hint: string, sample: string }[]} hits
 */
function scanHistoryLine(text, commit, identifiers, hits) {
  for (const h of scanTextPrivacy(text, identifiers)) {
    hits.push({ commit, id: h.id, hint: h.hint, sample: h.sample });
  }
}

/**
 * 扫描本地 git 历史。shallow clone 下 `--all` 只覆盖已抓取提交，
 * 不能代表完整历史——这种情况必须判失败，不能声称「历史通过」。
 */
function gitHistoryScan() {
  const shallow = runGit(['rev-parse', '--is-shallow-repository']);
  if (!shallow.ok) {
    fail('git 历史状态可判定', summarize(shallow.stderr || shallow.stdout));
    return;
  }
  if (shallow.stdout.trim() === 'true') {
    fail(
      'git 完整历史可复核（非 shallow clone）',
      'shallow clone 的 --all 只含已抓取提交，不能声称全历史通过；请 git fetch --unshallow，或 CI checkout 设置 fetch-depth: 0',
    );
    return;
  }
  pass('git 完整历史可复核（非 shallow clone）');

  const countRes = runGit(['rev-list', '--all', '--count']);
  const commits = Number(countRes.stdout.trim());
  if (!countRes.ok || !Number.isSafeInteger(commits)) {
    fail('git 历史提交数不可读取', summarize(countRes.stderr || countRes.stdout));
    return;
  }
  if (commits === 0) {
    pass('git 历史为空（无提交可扫描）');
    return;
  }

  const log = spawnSync('git', [
    '-c', 'core.quotepath=false',
    'log', '--all', '--no-color', '--unified=0', '--pretty=format:@@COMMIT %H %s', '-p',
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (log.status !== 0) {
    fail('git 历史可读', summarize(log.stderr));
    return;
  }

  const identifiers = localIdentifiers();
  /** @type {{ commit: string, id: string, hint: string, sample: string }[]} */
  const hits = [];
  let current = '(unknown)';
  for (const line of String(log.stdout).split(/\r?\n/)) {
    if (line.startsWith('@@COMMIT ')) {
      current = line.slice('@@COMMIT '.length).trim();
      scanHistoryLine(line, current, identifiers, hits); // 提交标题同样属于公开历史
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue; // 文件头不是内容
    if (line[0] !== '+' && line[0] !== '-') continue;
    scanHistoryLine(line.slice(1), current, identifiers, hits);
  }

  if (hits.length === 0) {
    pass('git 历史隐私扫描', `${commits} 个提交，未发现本机路径/凭据/邮箱`);
  } else {
    for (const hit of hits.slice(0, 20)) {
      fail(`git 历史隐私 ${hit.commit.slice(0, 8)}`, `${hit.hint}（${hit.id}，样本 ${hit.sample}）`);
    }
    if (hits.length > 20) fail('git 历史隐私', `还有 ${hits.length - 20} 处未列出`);
  }
}

// ── 发布包审计 ──────────────────────────────────────────────────────────
/** 解析 JS 源码里的相对 import 目标（静态 import/export from 与动态 import()）。 */
function relativeImports(source) {
  /** @type {Set<string>} */
  const out = new Set();
  const re = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.\/[^'"\n]+)['"]/g;
  for (const m of source.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** package.json 的 bin 声明（字符串或对象）统一成相对路径数组。 */
function binTargets(pkg) {
  if (typeof pkg?.bin === 'string') return [pkg.bin.replace(/^\.\//, '')];
  if (pkg?.bin && typeof pkg.bin === 'object') {
    return Object.values(pkg.bin).filter((v) => typeof v === 'string').map((v) => String(v).replace(/^\.\//, ''));
  }
  return [];
}

function packagingScan() {
  const pkgPath = path.join(ROOT, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    fail('package.json 可解析', String(/** @type {Error} */ (e).message));
    return;
  }

  const filesList = Array.isArray(pkg.files) ? pkg.files : [];
  if (filesList.length === 0) {
    fail('package.json 声明了 files 白名单', 'files 为空：npm 会打包整个目录');
  } else {
    pass('package.json 声明了 files 白名单', `${filesList.length} 条`);
  }

  const forbiddenEntries = filesList.filter((f) => /^(?:test|checks|\.github)(?:\/|$)|\.test\.mjs$/.test(String(f)));
  if (forbiddenEntries.length > 0) {
    fail('files 白名单不含测试/检查/CI', forbiddenEntries.join(', '));
  } else {
    pass('files 白名单不含测试/检查/CI');
  }

  const missingFiles = filesList.filter((f) => !fs.existsSync(path.join(ROOT, String(f))));
  if (missingFiles.length > 0) fail('files 白名单条目都真实存在', '缺失：' + missingFiles.join(', '));
  else pass('files 白名单条目都真实存在');

  for (const required of ['index.mjs', 'client.js', 'cordis.patch.yml', 'package.json']) {
    if (!fs.existsSync(path.join(ROOT, required))) fail('发布必需文件存在', required);
  }

  const patchPath = pkg?.dsh?.bundle?.patch;
  if (typeof patchPath === 'string' && fs.existsSync(path.join(ROOT, patchPath))) {
    pass('dsh.bundle.patch 指向真实文件', patchPath);
  } else {
    fail('dsh.bundle.patch 指向真实文件', JSON.stringify(patchPath));
  }

  const entries = new Set();
  if (typeof pkg.main === 'string') entries.add(pkg.main.replace(/^\.\//, ''));
  for (const target of Object.values(pkg.exports ?? {})) {
    if (typeof target === 'string') entries.add(target.replace(/^\.\//, ''));
  }
  for (const target of binTargets(pkg)) entries.add(target);

  // npm pack 是发布包内容的唯一权威来源（不是我们自己按白名单推算）。
  const pack = runNpm(['pack', '--dry-run', '--json', '--ignore-scripts']);
  if (!pack.ok) {
    fail('npm pack --dry-run 可执行', summarize(pack.stderr || pack.stdout));
    return;
  }
  let packed = [];
  try {
    const json = parseJsonOutput(pack.stdout);
    const first = Array.isArray(json) ? json[0] : json;
    packed = (first?.files ?? []).map((/** @type {{path: string}} */ f) => String(f.path));
    if (packed.length === 0) throw new Error('pack 输出里没有 files');
    pass('npm pack --dry-run 可执行', `包内 ${packed.length} 个文件，${first?.size ?? '?'} 字节`);
  } catch (e) {
    fail('npm pack 输出可解析', String(/** @type {Error} */ (e).message));
    return;
  }

  const packedSet = new Set(packed);
  // npm 会强制打包 package.json bin 指向的文件（即使没写进 files），所以白名单集合要算上它们。
  const allowed = new Set([
    ...filesList.map(String),
    ...binTargets(pkg),
    'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md',
  ]);
  const unexpected = packed.filter((f) => !allowed.has(f));
  if (unexpected.length > 0) fail('包内不存在白名单之外的文件', unexpected.join(', '));
  else pass('包内不存在白名单之外的文件');

  const leaked = packed.filter((f) => /^(?:test|checks|\.github)(?:\/|$)|\.test\.mjs$/.test(f));
  if (leaked.length > 0) fail('npm 包排除 tests/checks/CI', leaked.join(', '));
  else pass('npm 包排除 tests/checks/CI', '0 条非法路径');

  // 测试资源（fixtures 目录等）不得进包，即使目录名不在 test/ 下。
  const packedTestResources = packed.filter((f) => /(?:^|\/)[^/]*fixtures?(?:\/|$)/i.test(f));
  if (packedTestResources.length > 0) fail('npm 包不含测试资源（fixtures）', packedTestResources.join(', '));
  else pass('npm 包不含测试资源（fixtures）');

  // scripts/：默认是开发辅助代码（审计/校验），不进包；若运行命令确实放这里，
  // 必须在 files 白名单里逐条显式声明——不允许「被 npm 顺手带上」而没人知道。
  const packedScripts = packed.filter((f) => f.startsWith('scripts/'));
  if (packedScripts.length === 0) {
    pass('scripts/ 开发辅助代码未进包');
  } else {
    const unlisted = packedScripts.filter((f) => !filesList.includes(f));
    if (unlisted.length > 0) fail('scripts/ 进包内容必须由 files 白名单显式声明', unlisted.join(', '));
    else pass('scripts/ 进包内容均由白名单显式声明', packedScripts.join(', '));
  }

  for (const entry of entries) {
    if (!packedSet.has(entry)) fail('打包包含 exports/main 入口', `${entry} 未进包`);
  }

  // 相对 import 闭包：从入口出发，跟随 ./ 引用，任何未进包的模块都是运行期必然崩。
  const reachable = new Set();
  const queue = [...entries].filter((e) => /\.(?:mjs|js|cjs)$/.test(e));
  while (queue.length > 0) {
    const rel = queue.pop();
    if (reachable.has(rel)) continue;
    reachable.add(rel);
    if (!packedSet.has(rel)) continue;
    const abs = path.join(ROOT, rel);
    let source = '';
    try { source = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const spec of relativeImports(source)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (!reachable.has(target)) queue.push(target);
    }
  }
  const missingReachable = [...reachable].filter((f) => !packedSet.has(f));
  if (missingReachable.length > 0) fail('打包包含入口的 import 闭包', '缺：' + missingReachable.join(', '));
  else pass('打包包含入口的 import 闭包', `${reachable.size} 个模块`);

  const repoFiles = filesList.map(String);
  const droppedRuntime = repoFiles.filter((f) => /\.(?:mjs|js|html|yml)$/.test(f) && !packedSet.has(f));
  if (droppedRuntime.length > 0) fail('白名单内运行时文件全部进包', droppedRuntime.join(', '));
  else pass('白名单内运行时文件全部进包');

  // bin/：随包发布的锁/宿主命令。npm 会强制包含 package.json bin 指向的文件，
  // 但 bin/ 里的辅助模块若没进 files 白名单会静默丢失——这里逐个点名。
  const binDisk = walkFiles().filter((f) => f.startsWith('bin/'));
  if (binDisk.length === 0) {
    pass('bin/ 无随包命令（当前版本没有 CLI 入口）');
  } else {
    const missingBin = binDisk.filter((f) => !packedSet.has(f));
    if (missingBin.length > 0) fail('bin/ 运行命令全部进包', missingBin.join(', '));
    else pass('bin/ 运行命令全部进包', `${binDisk.length} 个`);

    const declaredBin = binTargets(pkg);
    const undeclared = binDisk.filter((f) => !declaredBin.includes(f) && !filesList.includes(f));
    if (undeclared.length > 0) fail('bin/ 文件有显式声明（bin 字段或 files 白名单）', undeclared.join(', '));
    else pass('bin/ 文件有显式声明（bin 字段或 files 白名单）');
  }
}

/** 单行摘要（避免 CI 日志被整段 npm 输出刷屏）。 */
function summarize(text) {
  return String(text).split(/\r?\n/).filter(Boolean).slice(0, 3).join(' | ').slice(0, 400);
}

// ── 净室安装 ────────────────────────────────────────────────────────────
function cleanRoomInstall() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-release-audit-'));
  try {
    const pack = runNpm(['pack', '--pack-destination', tmp, '--ignore-scripts']);
    if (!pack.ok) {
      fail('构建发布 tarball', summarize(pack.stderr || pack.stdout));
      return;
    }
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) {
      fail('构建发布 tarball', '目录里没有 .tgz');
      return;
    }
    const tgzPath = path.join(tmp, tgz);
    pass('构建发布 tarball', `${tgz} ${fs.statSync(tgzPath).size} 字节`);

    const proj = path.join(tmp, 'cleanroom');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'wc-cleanroom', version: '1.0.0', private: true, type: 'module' }, null, 2));
    const install = runNpm(['install', tgzPath, '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-offline', '--loglevel=error'], { cwd: proj });
    if (!install.ok) {
      fail('净室 npm install <tarball>', summarize(install.stderr || install.stdout));
      return;
    }
    pass('净室 npm install <tarball>');

    const installedDir = path.join(proj, 'node_modules', 'dsh-wangchao');
    if (!fs.existsSync(installedDir)) {
      fail('tarball 安装出 dsh-wangchao 目录');
      return;
    }
    pass('tarball 安装出 dsh-wangchao 目录');

    const leakedDirs = ['test', 'checks', '.github'].filter((d) => fs.existsSync(path.join(installedDir, d)));
    if (leakedDirs.length > 0) fail('安装目录不含测试/检查/CI', leakedDirs.join(', '));
    else pass('安装目录不含测试/检查/CI');

    // 逐文件比对：包内文件必须与工作区字节一致（防止发的是旧产物）。
    const packedRes = runNpm(['pack', '--dry-run', '--json', '--ignore-scripts']);
    let packedFiles = [];
    try {
      const json = parseJsonOutput(packedRes.stdout);
      const first = Array.isArray(json) ? json[0] : json;
      packedFiles = (first?.files ?? []).map((/** @type {{path: string}} */ f) => String(f.path));
    } catch { /* 上一步已经证明 pack 可用，这里失败按差异处理 */ }
    const mismatched = [];
    for (const rel of packedFiles) {
      if (rel === 'package.json') continue; // npm 安装时可能规范化，单独校验字段
      const a = path.join(ROOT, rel);
      const b = path.join(installedDir, rel);
      if (!fs.existsSync(b)) { mismatched.push(rel + '（缺失）'); continue; }
      if (sha256(a) !== sha256(b)) mismatched.push(rel + '（哈希不同）');
    }
    if (packedFiles.length === 0) fail('净室包内文件与工作区一致', '未拿到包内文件清单');
    else if (mismatched.length > 0) fail('净室包内文件与工作区一致', mismatched.slice(0, 8).join(', '));
    else pass('净室包内文件与工作区一致', `${packedFiles.length} 个文件`);

    // 安装目录反向核对：包外文件一个都不该出现（例如开发脚本被 npm 顺手带进安装树）。
    if (packedFiles.length > 0) {
      const packSet = new Set(packedFiles);
      const installedFiles = walkTree(installedDir);
      const extraInstalled = installedFiles.filter((f) => !packSet.has(f));
      if (extraInstalled.length > 0) fail('安装目录只含包内文件', extraInstalled.slice(0, 8).join(', '));
      else pass('安装目录只含包内文件', `${installedFiles.length} 个`);
    }

    const installedPkg = JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (installedPkg.name === pkg.name && installedPkg.version === pkg.version) {
      pass('净室包名与版本一致', `${pkg.name}@${pkg.version}`);
    } else {
      fail('净室包名与版本一致', `${installedPkg.name}@${installedPkg.version} != ${pkg.name}@${pkg.version}`);
    }

    const binList = binTargets(pkg);
    const missingBin = binList.filter((t) => !fs.existsSync(path.join(installedDir, t)));
    if (missingBin.length > 0) fail('净室安装包含 bin 命令', missingBin.join(', '));
    else if (binList.length > 0) pass('净室安装包含 bin 命令', binList.join(', '));

    // 真的执行 import：不仅文件齐全，还要能按 exports 入口加载。
    const probe = [
      "const m = await import('dsh-wangchao');",
      "if (m.name !== 'dsh-wangchao') throw new Error('name 导出异常: ' + m.name);",
      "if (!Array.isArray(m.inject)) throw new Error('inject 导出异常');",
      "const h = m.__test_hooks__;",
      "if (!h || typeof h.discoverCodeFiles !== 'function') throw new Error('__test_hooks__ 缺失');",
      "const fp = h.LOADED_CODE_FINGERPRINT;",
      "if (!/^[0-9a-f]{16}$/.test(fp.bundleHash)) throw new Error('bundleHash 异常: ' + fp.bundleHash);",
      "console.log('CLEANROOM_IMPORT_OK ' + fp.bundleHash);",
    ].join('\n');
    const probeRes = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: proj, encoding: 'utf8', windowsHide: true });
    if (probeRes.status === 0 && probeRes.stdout.includes('CLEANROOM_IMPORT_OK')) {
      pass('净室 import 入口可用', probeRes.stdout.trim().split(/\s+/).pop());
    } else {
      fail('净室 import 入口可用', summarize(probeRes.stderr || probeRes.stdout));
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清理失败不改变结论 */ }
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────
function main() {
console.log('净室发布审计（clean-room release audit）');
console.log(`  工作区：${ROOT_NAME}`);
console.log('');

const { files, git, tracked, untracked, ignoredPresent } = collectFiles();
console.log(`  审计范围：磁盘文件全集（含未跟踪/未提交）${git ? ' + 本地 git 仓库历史' : '；无 git：历史未验证'}`);
console.log('  未覆盖：远端克隆复核（发布流程需在空目录 git clone <remote> 后重跑 npm run verify；主代理另行复核远端 mirror 历史）');
console.log('');
if (git) {
  pass('git 仓库可读', `tracked ${tracked.length}，untracked ${untracked.length}`);
  const missingTracked = tracked.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missingTracked.length > 0) fail('tracked 文件都在磁盘上', missingTracked.join(', '));
  else pass('tracked 文件都在磁盘上');

  // 未提交的新文件必须进入审计集合——这是「只扫 git ls-files」会漏掉的那部分。
  const notAudited = untracked.filter((f) => !files.includes(f));
  if (notAudited.length > 0) fail('未跟踪文件纳入审计', notAudited.join(', '));
  else pass('未跟踪文件纳入审计', `${untracked.length} 个`);
  if (untracked.length > 0) {
    console.log(`        未跟踪但已扫描：${untracked.slice(0, 10).join(', ')}${untracked.length > 10 ? ' …' : ''}`);
  }
  if (ignoredPresent.length > 0) {
    fail('工作区没有 gitignore 之外的残留产物', ignoredPresent.slice(0, 10).join(', '));
  } else {
    pass('工作区没有 gitignore 之外的残留产物');
  }
} else {
  pass('git 不可用，按文件系统全集审计', `${files.length} 个文件`);
  if (ignoredPresent.length > 0) fail('残留产物检查', ignoredPresent.join(', '));
}
console.log(`  审计文件：${files.length}（含未跟踪/未提交内容）`);

const privacy = privacyScan(files);
if (privacy.hits.length === 0 && privacy.largeFiles.length === 0) {
  pass(
    '隐私扫描：无本机路径/凭据/邮箱',
    `扫描 ${privacy.scanned} 个文本文件，比对 ${privacy.identifiers} 个本机标识；跳过二进制 ${privacy.skippedBinary} 个`,
  );
} else {
  for (const hit of privacy.hits.slice(0, 40)) {
    fail(`隐私扫描 ${hit.rel}:${hit.line}`, `${hit.hint}（${hit.id}，样本 ${hit.sample}）`);
  }
  if (privacy.hits.length > 40) fail('隐私扫描', `还有 ${privacy.hits.length - 40} 处未列出`);
  if (privacy.largeFiles.length > 0) {
    fail('隐私扫描覆盖全部文本文件', `${privacy.largeFiles.length} 个文件超过 ${MAX_SCAN_BYTES} 字节未被扫描：${privacy.largeFiles.slice(0, 8).join(', ')}`);
  }
}

const artifacts = artifactScan(files);
if (artifacts.length === 0) pass('产物扫描：无 tarball/日志/临时文件/夹具/凭据文件');
else for (const a of artifacts) fail(`产物扫描 ${a.rel}`, a.hint);

if (git) {
  gitHistoryScan();
} else {
  console.log('  [NOTE] 无 git 仓库：未验证 git 历史（不声称全历史通过）');
}

packagingScan();
cleanRoomInstall();

console.log('');
console.log(`  本报告范围：${git ? '工作区 + 本地 git 仓库历史' : '工作区文件全集（git 历史未验证）'}；远端克隆与 mirror 历史由发布流程单独复核`);
if (failures.length === 0) {
  console.log(`审计结果：PASS（${checks} 项检查全部通过）`);
  process.exit(0);
} else {
  console.log(`审计结果：FAIL（${failures.length} 项失败 / ${checks} 项检查）`);
  for (const f of failures.slice(0, 30)) console.log(`  · ${f.label}：${f.detail}`);
  process.exit(1);
}
}

// 直接执行时跑完整审计；被测试 import 时只取纯函数，不产生副作用。
const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

export {
  PRIVACY_PATTERNS,
  TEXT_EXT,
  BINARY_EXT,
  MAX_SCAN_BYTES,
  isTextFile,
  localIdentifiers,
  matchIdentifiers,
  mask,
  scanTextPrivacy,
};