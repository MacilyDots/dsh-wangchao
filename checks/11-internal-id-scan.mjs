// @ts-check
// 公开包内部编号扫描 —— 发布前门禁。
//
// 起因：alpha.5.1 的 client.js:913 注释里残留了内部缺陷编号（`F-05：…`），
// 而当时的发布前检查 f06InternalIds 只扫了 README / README.en / CHANGELOG / SECURITY-ADVISORY
// 四个 Markdown 文档，源码注释完全在扫描范围之外 —— 检查范围与发布范围脱节。
//
// 本检查把范围固定为 package.json 的 `files` 白名单（即真正会进 tarball 的文件），
// 让"扫了什么"永远等于"发了什么"。新增/删除 files 条目时本检查自动跟随，不需要另改清单。
//
// 另有一条自证：扫描器自身必须能命中已知形态的样本，否则"零命中"可能只是扫描器坏了。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 内部编号与内部轮次标记。命中即为发布前必须清掉的内部语言。 */
const PATTERNS = [
  { name: 'finding-id', re: /\bF-0[0-9]\b/, sample: '（F-05：残留示例）' },
  { name: 'workpackage-id', re: /\bAP-0[0-9]\b/, sample: 'AP-07 发布审核' },
  { name: 'work-package', re: /WORK-PACKAGE/, sample: 'WORK-PACKAGE 交付' },
];

/** 自我验证：扫描器必须能命中样本。返回未能命中的规则名。 */
export function selfTestBlindSpots() {
  return PATTERNS.filter((p) => !p.re.test(p.sample)).map((p) => p.name);
}

/**
 * 扫描 package.json files 白名单里的每个文件。
 * @returns {{ file: string, line: number, pattern: string, text: string }[]}
 */
export function scanPublicFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // package.json 本身不进 files 列表，但它一定会被发布，单独补上。
  const targets = [...new Set([...(Array.isArray(pkg.files) ? pkg.files : []), 'package.json'])];
  /** @type {{ file: string, line: number, pattern: string, text: string }[]} */
  const hits = [];
  for (const rel of targets) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      hits.push({ file: rel, line: 0, pattern: 'missing-file', text: 'files 白名单里的文件不存在' });
      continue;
    }
    const stat = fs.statSync(abs);
    if (!stat.isFile()) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const p of PATTERNS) {
        if (p.re.test(lines[i])) {
          hits.push({ file: rel, line: i + 1, pattern: p.name, text: lines[i].trim().slice(0, 160) });
        }
      }
    }
  }
  return hits;
}

export async function run() {
  /** @type {{ label: string, pass: boolean, error?: string }[]} */
  const cases = [];

  const blind = selfTestBlindSpots();
  cases.push({
    label: '扫描器自证：三条规则都能命中样本',
    pass: blind.length === 0,
    error: blind.length ? `以下规则对样本无反应（扫描会假绿）：${blind.join(', ')}` : undefined,
  });

  const hits = scanPublicFiles();
  cases.push({
    label: '公开包 files 白名单内零内部编号',
    pass: hits.length === 0,
    error: hits.length
      ? hits.map((h) => `${h.file}:${h.line} [${h.pattern}] ${h.text}`).join('\n            ')
      : undefined,
  });

  // 覆盖度自证：确认扫描范围确实等于 files 白名单，而不是静默变成空集。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const expected = new Set([...(pkg.files ?? []), 'package.json']);
  cases.push({
    label: `扫描范围覆盖 files 白名单（${expected.size} 项）`,
    pass: expected.size >= 50,
    error: expected.size < 50 ? `白名单只有 ${expected.size} 项，疑似被误改` : undefined,
  });

  return { name: '11-internal-id-scan', cases };
}
