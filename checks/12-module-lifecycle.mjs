// 12 模块生命周期登记检查
//
// 目的：让「删了模块但没更新登记」「加了模块但没登记」「files 白名单和实际不符」
// 这三类问题在门禁里立刻失败，而不是等到发版才发现包内容对不上。
//
// 它不判断模块该不该存在 —— 那需要人看引用图（见 CONSOLIDATION-C 报告）。
// 它只保证：登记表、源码、发布白名单三者说的是同一件事。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const LIFECYCLES = new Set(['ACTIVE', 'FROZEN', 'DEPRECATED']);

export async function run() {
  const cases = [];
  const push = (label, pass, error) => cases.push({ label, pass, error: pass ? undefined : error });

  let registry = null;
  let pkg = null;
  try { registry = read('checks/module-lifecycle.json'); } catch (e) { push('登记表可读', false, String(e.message)); }
  try { pkg = read('package.json'); } catch (e) { push('package.json 可读', false, String(e.message)); }
  if (!registry || !pkg) return { cases };

  const entries = Array.isArray(registry.modules) ? registry.modules : [];
  push('登记表结构', entries.length > 0, 'checks/module-lifecycle.json 缺少 modules 数组');

  const invalid = entries.filter((e) => !LIFECYCLES.has(e?.lifecycle));
  push(
    `生命周期取值合法（${[...LIFECYCLES].join(' / ')}）`,
    invalid.length === 0,
    `${invalid.length} 项取值非法：${invalid.slice(0, 3).map((e) => `${e?.name}=${e?.lifecycle}`).join(', ')}`,
  );

  // DEAD 出现在登记表里说明「判死但还留着」，这是自相矛盾的状态
  const dead = entries.filter((e) => e?.lifecycle === 'DEAD');
  push('登记表里没有 DEAD 项', dead.length === 0, `${dead.length} 个已判死模块仍在登记：${dead.slice(0, 3).map((e) => e.name).join(', ')}`);

  const missing = entries.filter((e) => !fs.existsSync(path.join(root, e.name)));
  push(
    '登记项在磁盘上存在',
    missing.length === 0,
    `${missing.length} 个已登记但磁盘没有（删了没更新登记？）：${missing.slice(0, 3).map((e) => e.name).join(', ')}`,
  );

  const actual = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.(mjs|js)$/.test(d.name) && !d.name.endsWith('.test.mjs'))
    .map((d) => d.name);
  const registered = new Set(entries.map((e) => e.name));
  const unregistered = actual.filter((n) => !registered.has(n));
  push(
    '根级模块都有登记',
    unregistered.length === 0,
    `${unregistered.length} 个模块未登记：${unregistered.slice(0, 5).join(', ')}`,
  );

  const files = Array.isArray(pkg.files) ? pkg.files : [];
  push('发布白名单存在', files.length > 0, 'package.json 缺少 files 数组');
  const absent = files.filter((f) => !fs.existsSync(path.join(root, f)));
  push('白名单条目都存在', absent.length === 0, `${absent.length} 项不存在：${absent.slice(0, 3).join(', ')}`);

  // 漏发会导致运行时缺模块，且只有装完才发现
  const inFiles = new Set(files);
  const notShipped = entries.filter((e) => /\.(mjs|js)$/.test(e.name) && !inFiles.has(e.name) && e.lifecycle !== 'DEPRECATED');
  push(
    'ACTIVE/FROZEN 模块都在发布白名单内',
    notShipped.length === 0,
    `${notShipped.length} 个模块漏发：${notShipped.slice(0, 3).map((e) => e.name).join(', ')}`,
  );

  const leaked = files.filter((f) => /(^|\/)(test|checks|docs|\.trash|\.git)(\/|$)/.test(f) || /\.test\.mjs$/.test(f));
  push('白名单未混入测试/内部产物', leaked.length === 0, `${leaked.length} 项不应发布：${leaked.slice(0, 5).join(', ')}`);

  return { cases };
}
