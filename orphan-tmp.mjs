// 原子写（tmp + rename）的残留检测。
// 主文件缺失、但同名临时文件还在：说明上次落盘没走完 rename，或主文件被外部删除。
// 这种情况不能当作「没有记录」，否则未确认的执行/未结算的费用会被静默抹掉。
import fs from 'node:fs';
import path from 'node:path';

/** 返回 'none'（无残留）/ 'orphan'（有临时文件）/ 'error'（目录不可读，调用方按保守处理）。 */
export function orphanTmpState(file) {
  let names;
  try { names = fs.readdirSync(path.dirname(file)); }
  catch (e) { return e?.code === 'ENOENT' ? 'none' : 'error'; }
  const base = path.basename(file);
  return names.some((n) => n.startsWith(base + '.') && n.endsWith('.tmp')) ? 'orphan' : 'none';
}
