// @ts-check
// #9 弯路：测试实际跑在旧的生产代码上（profile 与生产代码哈希不一致时误读结果）。
//
// 离线这一半只能验证指纹函数本身：改内容必变、缺文件标 MISSING、冻结生效。
// 「宿主加载的代码 vs 磁盘」必须由真机 selftest 返回 codeFingerprint 后比对，
// 即 assertHostCodeFresh —— 离线无法触及宿主进程，这里如实标注不冒充覆盖。
//
// 禁止在测试期间改动真实的 index.mjs：所有内容变更都在 os.tmpdir() 里做。

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test_hooks__ } from '../index.mjs';
import { createChecker } from './fake-host.mjs';

export const name = '09-code-fingerprint';

const { computeDiskFingerprint, assertHostCodeFresh, LOADED_CODE_FINGERPRINT, CODE_FILES } = __test_hooks__;
const __dir = path.dirname(fileURLToPath(import.meta.url));

export async function run() {
  const { cases, run: runCase } = createChecker();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wc-fp-'));
  const FILES = ['a.mjs', 'b.mjs', 'missing.mjs'];

  try {
    writeFileSync(path.join(tmp, 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(path.join(tmp, 'b.mjs'), 'export const b = 2;\n');

    runCase('两文件有 16 位哈希、缺失文件标 MISSING', () => {
      const fp = computeDiskFingerprint(tmp, FILES);
      assert.match(fp.bundleHash, /^[0-9a-f]{16}$/);
      assert.match(fp.files['a.mjs'], /^[0-9a-f]{16}$/);
      assert.match(fp.files['b.mjs'], /^[0-9a-f]{16}$/);
      assert.equal(fp.files['missing.mjs'], 'MISSING');
    });

    runCase('同内容重复计算稳定', () => {
      assert.equal(
        computeDiskFingerprint(tmp, FILES).bundleHash,
        computeDiskFingerprint(tmp, FILES).bundleHash,
      );
    });

    runCase('内容变化 → bundleHash 变化', () => {
      const before = computeDiskFingerprint(tmp, FILES).bundleHash;
      writeFileSync(path.join(tmp, 'a.mjs'), 'export const a = 999;\n');
      const after = computeDiskFingerprint(tmp, FILES).bundleHash;
      assert.notEqual(before, after);
    });

    runCase('文件删除 → 变 MISSING 且 bundleHash 变化', () => {
      const before = computeDiskFingerprint(tmp, FILES).bundleHash;
      rmSync(path.join(tmp, 'b.mjs'));
      const fp = computeDiskFingerprint(tmp, FILES);
      assert.equal(fp.files['b.mjs'], 'MISSING');
      assert.notEqual(fp.bundleHash, before);
    });

    runCase('返回对象与 files 均已冻结，改写抛 TypeError', () => {
      const fp = computeDiskFingerprint(tmp, FILES);
      assert.equal(Object.isFrozen(fp), true);
      assert.equal(Object.isFrozen(fp.files), true);
      assert.throws(() => { /** @type {any} */ (fp).bundleHash = 'x'; }, TypeError);
      assert.throws(() => { /** @type {any} */ (fp.files)['a.mjs'] = 'x'; }, TypeError);
    });
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  runCase('真实指纹：清单内所有源文件均命中，无 MISSING', () => {
    assert.ok(CODE_FILES.length >= 10, `文件清单过短：${CODE_FILES.length}`);
    for (const f of CODE_FILES) {
      assert.notEqual(LOADED_CODE_FINGERPRINT.files[f], 'MISSING', `${f} 缺失`);
    }
    assert.match(LOADED_CODE_FINGERPRINT.bundleHash, /^[0-9a-f]{16}$/);
  });

  runCase('真实指纹已冻结，且带 pid / loadedAt', () => {
    assert.equal(Object.isFrozen(LOADED_CODE_FINGERPRINT), true);
    assert.equal(typeof LOADED_CODE_FINGERPRINT.loadedAt, 'number');
    assert.equal(LOADED_CODE_FINGERPRINT.pid, process.pid);
  });

  runCase('自动发现覆盖全部非测试源码（防止新增模块漏检）', () => {
    const onDisk = readdirSync(path.join(__dir, '..'))
      .filter((n) => /\.(mjs|js)$/.test(n) && !/\.test\.mjs$/.test(n));
    assert.ok(onDisk.length > 0, '目录里没有源码？');
    for (const f of onDisk) {
      assert.ok(CODE_FILES.includes(f), `${f} 未被指纹覆盖`);
    }
  });

  runCase('参与指纹的文件不含 CRLF（行尾转换会让指纹漂移）', () => {
    const dir = path.join(__dir, '..');
    const crlf = Buffer.from('\r\n');
    /** @type {string[]} */
    const offenders = [];
    for (const f of CODE_FILES) {
      if (!/\.(mjs|js|json|ya?ml)$/.test(f)) continue;
      if (readFileSync(path.join(dir, f)).includes(crlf)) offenders.push(f);
    }
    assert.deepEqual(offenders, [], `以下文件含 CRLF，会导致宿主/磁盘指纹不一致：${offenders.join(', ')}`);
  });

  runCase('assertHostCodeFresh：宿主哈希与磁盘一致时通过', () => {
    assert.equal(assertHostCodeFresh({ codeFingerprint: LOADED_CODE_FINGERPRINT }), true);
  });

  runCase('assertHostCodeFresh：宿主哈希被篡改 → ERR_STALE_HOST_CODE', () => {
    assert.throws(
      () => assertHostCodeFresh({ codeFingerprint: { bundleHash: 'deadbeefdeadbeef', files: {} } }),
      /ERR_STALE_HOST_CODE: 宿主运行代码哈希与磁盘不一致/,
    );
  });

  runCase('assertHostCodeFresh：selftest 未带指纹 → ERR_STALE_HOST_CODE', () => {
    assert.throws(() => assertHostCodeFresh({ ok: true }), /ERR_STALE_HOST_CODE/);
    assert.throws(() => assertHostCodeFresh(null), /ERR_STALE_HOST_CODE/);
  });

  return { name, cases };
}
