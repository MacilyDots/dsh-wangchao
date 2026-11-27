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
// alpha.5.2（R-06）扩展：
//   1. 编号不再按"1 位数字"写死。独立审核实测 `F-10`、`AP-10` 在原规则下返回 false ——
//      两位数及以上的编号整类漏扫。现统一用 `\d{1,3}`。
//   2. 补齐实际在用的编号族：`D-xx`（缺陷）、`R-xx`（整改）、`P<n>-<n>`（审查条目）、
//      `R<n>`（轮次标记）。这些和 `F-xx` 是同一类内部语言，只清一族等于没清。
//   3. 工作包标识支持子阶段后缀：`AP-05-R1`、`AP-08-R1`。
//
// 误报处理（宁少勿滥）：所有规则都要求左词边界，且数字位数有上限，因此
//   `AF-05` / `F-16abc` / `F-0016` / `R123` 这类串扰形态天然不命中；selfTest 把这些
//   形态作为反例固定下来，规则一放宽就会先在这里失败，而不是把噪音倒进发布审计。
//
// 另有一条自证：扫描器自身必须能命中已知形态的样本，否则"零命中"可能只是扫描器坏了。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 内部编号规则。
 * `samples`  必须命中（正例自证）。
 * `negatives` 必须不命中（误报护栏自证）。
 * @type {{ name: string, re: RegExp, samples: string[], negatives: string[] }[]}
 */
const PATTERNS = [
  {
    name: 'finding-id',
    // F-05 / F-10 / F-100；不匹配 AF-05（无左边界）、F-0016（超 3 位）、F-16abc（无右边界）
    re: /\bF-\d{1,3}\b/,
    samples: ['（F-05：残留示例）', '见 F-10 条目', 'F-100 号缺陷'],
    negatives: ['AF-05 不是独立编号', 'F-0016 是型号', 'F-16abc 不是编号'],
  },
  {
    name: 'workpackage-id',
    // AP-08 / AP-10 / AP-100；带子阶段后缀 AP-05-R1 / AP-08-R1
    re: /\bAP-\d{1,3}(?:-[A-Z]{1,2}\d{0,2})?\b/,
    samples: ['AP-07 发布审核', 'AP-10 复审', 'AP-100 归档', 'AP-05-R1 收尾', 'AP-08-R1 补丁'],
    negatives: ['CAP-05 是别的词', 'AP-0016 超位数', 'AP-10abc 不是编号'],
  },
  {
    name: 'defect-id',
    // D-05 这类缺陷/整改编号
    re: /\bD-\d{1,3}\b/,
    samples: ['D-05 修复', 'D-10 复核', 'D-100 归档'],
    negatives: ['ID-05 不是独立编号', 'D-0016 超位数'],
  },
  {
    name: 'rectify-id',
    // R-01 这类整改编号
    re: /\bR-\d{1,3}\b/,
    samples: ['R-01 整改', 'R-06 扫描范围'],
    negatives: ['DR-05 不是独立编号', 'R-0016 超位数'],
  },
  {
    name: 'review-id',
    // P0-1 / P1-6 这类内部审查条目
    re: /\bP\d-\d{1,3}\b/,
    samples: ['（审查 P1-6）', 'P0-1 实测缺陷'],
    negatives: ['XP1-6 不是独立编号', 'P1-0016 超位数'],
  },
  {
    name: 'round-tag',
    // R1 / R5 这类内部轮次标记；两位数以上（R10）不收，避免把常见缩写拖进来
    re: /\bR\d\b/,
    samples: ['（R5）句柄所有权', 'R2 u11/u12', 'R8 连续阶段'],
    negatives: ['R10 不收', 'R123 不收', 'AR5 不是独立标记', 'R5abc 不是标记'],
  },
  {
    name: 'work-package',
    re: /WORK-PACKAGE/,
    samples: ['WORK-PACKAGE 交付'],
    negatives: ['workpackage 连写不收'],
  },
];

/** 自我验证：返回正例未命中的规则名。 */
export function selfTestBlindSpots() {
  return PATTERNS
    .filter((p) => p.samples.some((s) => !p.re.test(s)))
    .map((p) => p.name);
}

/** 误报护栏自证：返回反例被误命中的规则名。 */
export function selfTestFalsePositives() {
  return PATTERNS
    .filter((p) => p.negatives.some((s) => p.re.test(s)))
    .map((p) => p.name);
}

/** 当前规则集（只读快照，供测试与审计引用）。 */
export function ruleSummary() {
  return PATTERNS.map((p) => ({ name: p.name, source: p.re.source, samples: p.samples.length, negatives: p.negatives.length }));
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
    label: `扫描器自证：${PATTERNS.length} 条规则都命中正例（含两位/三位编号）`,
    pass: blind.length === 0,
    error: blind.length ? `以下规则对正例无反应（扫描会假绿）：${blind.join(', ')}` : undefined,
  });

  const falsePos = selfTestFalsePositives();
  cases.push({
    label: '扫描器误报护栏：串扰形态不命中（AF-05 / F-0016 / R123 等）',
    pass: falsePos.length === 0,
    error: falsePos.length ? `以下规则会误报非内部编号形态：${falsePos.join(', ')}` : undefined,
  });

  const hits = scanPublicFiles();
  cases.push({
    label: '公开包 files 白名单内零内部编号',
    pass: hits.length === 0,
    error: hits.length
      ? `${hits.length} 处命中：\n            ` + hits.map((h) => `${h.file}:${h.line} [${h.pattern}] ${h.text}`).join('\n            ')
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

  // 覆盖度自证之二：白名单内实际读到的字节数，防止文件被清空后"零命中"假绿。
  let bytes = 0;
  let readable = 0;
  for (const rel of expected) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    readable += 1;
    bytes += fs.statSync(abs).size;
  }
  cases.push({
    label: `扫描覆盖度：实际读到 ${readable} 个文件 / ${bytes} 字节`,
    pass: readable >= 50 && bytes > 200000,
    error: readable < 50 || bytes <= 200000 ? `扫描面过小（${readable} 文件 / ${bytes} 字节），可能是误读空集` : undefined,
  });

  return { name: '11-internal-id-scan', cases };
}
