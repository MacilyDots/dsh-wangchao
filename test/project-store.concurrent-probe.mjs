// 并发探针：由 project-store.test.mjs 用多个进程同时启动。
// 通过环境变量 T1_FILE 传入目标文件，避免命令行路径转义问题。
import { createProjectStore } from '../project-store.mjs';
const s = createProjectStore({ file: process.env.T1_FILE, canAccessSession: () => true });
try {
  s.create({ title: 'x-' + process.pid, expectedRevision: 0 });
  process.stdout.write('OK');
} catch (e) {
  process.stdout.write(e.code);
}
