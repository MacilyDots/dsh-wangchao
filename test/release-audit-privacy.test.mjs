// 净室审计隐私扫描的正反例测试（纯离线，不读写仓库内文件，夹具只写系统临时目录）。
//
// 背景：真实漏检——测试夹具里出现过带正斜杠的本机盘符路径，而旧规则只认反斜杠。
// 这份测试把「路径写法 × 凭据形态」拆成正例（必须命中）与反例（不得误报），
// 并额外守两条底线：审计脚本自扫必须 0 命中；打码样本不得包含原文。
//
// 注意：本文件会被 release-audit 自己扫描，所以所有敏感样例都必须在运行时拼接，
// 源码里不能出现完整字面量（否则正例夹具本身会变成隐私泄漏）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTextPrivacy, isTextFile, mask, PRIVACY_PATTERNS } from '../scripts/release-audit.mjs';

const BS = String.fromCharCode(92); // 反斜杠：不写字面量，避免源码里拼出可被扫描到的路径
const SL = '/';
const __dir = path.dirname(fileURLToPath(import.meta.url));

const ids = (text, identifiers = []) => scanTextPrivacy(text, identifiers).map((h) => h.id);
const hit = (text, id, identifiers = []) => ids(text, identifiers).includes(id);

let pass = 0;
/** @type {{ name: string, error: string }[]} */
const fail = [];
const t = (name, fn) => {
  try { fn(); pass += 1; } catch (e) { fail.push({ name, error: String(e?.message ?? e) }); }
};

// ── 正例：路径写法 ──────────────────────────────────────────────────────
const DRIVE_FWD = 'B:' + SL + 'DSH' + SL + 'Agent' + SL + 'leader';
const DRIVE_BS = 'B:' + BS + 'DSH' + BS + 'Agent' + BS + 'leader';

t('正斜杠盘符路径（真实漏检点）被识别', () => {
  assert.ok(hit('cwd: ' + DRIVE_FWD, 'windows-drive-path'), ids('cwd: ' + DRIVE_FWD).join(','));
});

t('反斜杠盘符路径被识别', () => {
  assert.ok(hit('cwd: ' + DRIVE_BS, 'windows-drive-path'));
});

t('小写盘符与 file URL 被识别', () => {
  const fileUrl = 'file:' + SL + SL + SL + 'c:' + SL + 'dsh';
  assert.ok(hit(fileUrl, 'windows-drive-path'), ids(fileUrl).join(','));
});

t('JSON 转义的双反斜杠被识别', () => {
  const json = '"cwd": "C:' + BS + BS + 'Users' + BS + BS + 'alice"';
  assert.ok(hit(json, 'windows-drive-path'));
});

t('行尾路径（后面没有字符）被识别', () => {
  const line = 'cwd=' + 'D:' + BS;
  assert.ok(hit(line, 'windows-drive-path'));
});

t('UNC 路径、WSL 路径被识别', () => {
  const unc = BS + BS + 'fileserver' + BS + 'team' + BS + 'private';
  assert.ok(hit(unc, 'unc-path'), ids(unc).join(','));
  const wsl = BS + BS + 'wsl$' + BS + 'Ubuntu' + BS + 'home' + BS + 'alice';
  assert.ok(hit(wsl, 'unc-path'), ids(wsl).join(','));
});

t('正斜杠 UNC 路径被识别（但不误伤 URL 协议）', () => {
  const unc = SL + SL + 'fileserver' + SL + 'team' + SL + 'private';
  assert.ok(hit(unc, 'forward-unc-path'), ids(unc).join(','));
});

t('家目录路径：Unix / Windows / MSYS 三种写法都识别，且不要求结尾斜杠', () => {
  const unixUsers = SL + 'Users' + SL + 'alice';
  const unixHome = SL + 'home' + SL + 'bob' + SL + 'proj';
  const winHome = BS + 'Users' + BS + 'alice';
  const msys = SL + 'c' + SL + 'Users' + SL + 'alice';
  assert.ok(hit(unixUsers, 'unix-home-path'), ids(unixUsers).join(','));
  assert.ok(hit(unixHome, 'unix-home-path'));
  assert.ok(hit(winHome, 'win-home-path'), ids(winHome).join(','));
  assert.ok(hit(msys, 'msys-home-path'), ids(msys).join(','));
});

t('家目录简写路径被识别', () => {
  const shorthand = '~' + SL + 'secrets' + SL + 'id_rsa';
  assert.ok(hit(shorthand, 'home-shorthand'), ids(shorthand).join(','));
});

// ── 正例：本机标识与凭据形态 ────────────────────────────────────────────
t('本机标识只在路径上下文中命中，且大小写不敏感', () => {
  const identifiers = [{ id: 'account:tester', value: 'tester' }];
  const pathLine = SL + 'home' + SL + 'TESTER' + SL + 'proj';
  assert.ok(hit(pathLine, 'local-account:tester', identifiers), '路径中的账号名应命中');
  const proseLine = 'Copyright (c) 2026 TESTER';
  assert.equal(hit(proseLine, 'local-account:tester', identifiers), false, '公开署名不得误报');
  const urlLine = 'https:' + SL + SL + 'github.com' + SL + 'TESTER' + SL + 'repo';
  assert.equal(hit(urlLine, 'local-account:tester', identifiers), false, 'URL 中的账号名属公开标识');
});

t('常见凭据形态被识别（sk / stripe / github / gitlab / slack / google / npm / aws）', () => {
  const cases = [
    ['sk-' + 'A'.repeat(24), 'api-key-sk'],
    ['sk_live_' + 'a'.repeat(20), 'api-key-stripe'],
    ['ghp_' + 'a'.repeat(30), 'github-token'],
    ['glpat-' + 'a'.repeat(24), 'gitlab-token'],
    ['xoxb-' + '1234567890' + '-abcdef', 'slack-token'],
    ['AIza' + 'a'.repeat(35), 'google-api-key'],
    ['npm_' + 'a'.repeat(36), 'npm-token'],
    ['AKIA' + 'ABCDEFGHIJKLMNOP', 'aws-access-key'],
  ];
  for (const [text, id] of cases) assert.ok(hit(text, id), id + ' 未命中：' + ids(text).join(','));
});

t('JWT / Bearer / URL 内嵌账号密码 / 邮箱 / 私钥块被识别', () => {
  const jwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
  assert.ok(hit(jwt, 'jwt'), ids(jwt).join(','));
  assert.ok(hit('Bearer ' + 'b'.repeat(24), 'bearer-token'));
  const basic = 'https:' + SL + SL + 'user' + ':' + 'pass' + '@' + 'example.com';
  assert.ok(hit(basic, 'url-basic-auth'), ids(basic).join(','));
  assert.ok(hit('someone' + '@' + 'corp.example', 'email-address'));
  const pem = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  assert.ok(hit(pem, 'private-key-block'), ids(pem).join(','));
});

// ── 反例：不得误报 ──────────────────────────────────────────────────────
t('反例：URL / 自定义协议 / 相对路径不误报', () => {
  const negatives = [
    'http:' + SL + SL + 'dsh.invalid' + SL + 'api',
    'https:' + SL + SL + 'github.com' + SL + 'MacilyDots' + SL + 'dsh-wangchao',
    'dsh-app:' + SL + SL + 'entry?x=1',
    'path.join("..", "index.mjs")',
    './test/seq-refs.test.mjs',
  ];
  for (const text of negatives) assert.deepEqual(ids(text), [], '误报：' + text + ' → ' + ids(text).join(','));
});

t('反例：时间/中文冒号/键值对不误报', () => {
  for (const text of ['12:30:45', '方案 C: 默认拒绝', 'key: value']) {
    assert.deepEqual(ids(text), [], '误报：' + text);
  }
});

t('反例：中立示例路径与占位符不误报', () => {
  for (const text of [SL + 'example' + SL + 'project', SL + 'example' + SL + 'private' + SL + 'logs', '<DSH_HOME>' + SL + 'wangchao', '$HOME' + SL + 'wangchao']) {
    assert.deepEqual(ids(text), [], '误报：' + text + ' → ' + ids(text).join(','));
  }
});

t('反例：localhost 的 UNC 别名不误报（写锁测试里的合法夹具）', () => {
  const local = BS + BS + 'localhost' + BS + 'C$' + BS + 'tmp';
  assert.deepEqual(ids(local), [], '误报：' + local);
  const localFwd = SL + SL + 'localhost' + SL + 'share' + SL + 'x';
  assert.deepEqual(ids(localFwd), [], '误报：' + localFwd);
});

// ── 底线：审计脚本自扫 0 命中（规则不得扫描到自己的正则源码）────────────
t('反斜杠盘符的旧规则漏检正斜杠写法（回归说明，不依赖旧实现）', () => {
  const legacy = /(?:^|[^\w])[A-Za-z]:\\(?=[\w.\\-])/g;
  const forward = 'cwd: ' + DRIVE_FWD;
  assert.equal(forward.match(legacy), null, '旧规则本应漏检正斜杠路径');
  const current = PRIVACY_PATTERNS.find((p) => p.id === 'windows-drive-path').re;
  current.lastIndex = 0;
  assert.ok(forward.match(current), '现行规则必须识别正斜杠路径');
});

t('审计脚本自扫 0 命中（含正则源码与注释）', () => {
  const source = fs.readFileSync(path.join(__dir, '..', 'scripts', 'release-audit.mjs'), 'utf8');
  assert.deepEqual(scanTextPrivacy(source), [], '审计脚本自己触发了隐私规则：' + JSON.stringify(scanTextPrivacy(source).slice(0, 5)));
});

// ── 打码：报告不得包含原文 ──────────────────────────────────────────────
t('命中样本已打码，报告不含凭据原文', () => {
  const secret = 'sk-' + 'Z'.repeat(30);
  const [h] = scanTextPrivacy('token ' + secret);
  assert.ok(h, '应当命中');
  assert.equal(h.sample.includes(secret), false, '样本泄露了完整密钥');
  assert.equal(h.sample.includes('ZZZZZZZZZ'), false, '样本泄露了密钥主体');
});

t('mask：长样本不保留完整内容，短样本全掩码', () => {
  const sample = mask(DRIVE_FWD);
  assert.equal(sample.includes('DSH'), false, '掩码保留了敏感片段：' + sample);
  assert.equal(mask('ab'), '**');
});

// ── 扫描覆盖：扩展名白名单曾经漏掉的文本文件 ────────────────────────────
t('文本判定：.ps1 与无扩展名文件纳入扫描，二进制排除', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-audit-text-'));
  try {
    const ps1 = path.join(tmp, 'setup.ps1');
    const dockerfile = path.join(tmp, 'Dockerfile');
    const png = path.join(tmp, 'logo.png');
    fs.writeFileSync(ps1, 'Write-Host ok\n', 'utf8');
    fs.writeFileSync(dockerfile, 'FROM node:24\n', 'utf8');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    assert.equal(isTextFile('setup.ps1', ps1), true);
    assert.equal(isTextFile('Dockerfile', dockerfile), true);
    assert.equal(isTextFile('logo.png', png), false);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

if (fail.length > 0) {
  for (const f of fail) console.error('FAIL ' + f.name + '\n     ' + f.error);
  console.error(`\nFAIL ${pass} / ${pass + fail.length}：隐私扫描正反例`);
  process.exit(1);
}
console.log(`PASS ${pass} / ${pass}：净室审计隐私扫描正反例（路径写法 / 凭据形态 / 误报 / 自扫 / 打码 / 文本覆盖）`);
