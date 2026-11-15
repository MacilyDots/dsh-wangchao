// dsh-wangchao 边界契约（P2）。
//
// 只描述 boundary.mjs 的 4 组边界函数与 checks/fake-host.mjs 的宿主契约，
// 不给 index.mjs 的 apply() 内部闭包开类型检查（那是 P3 的范围）。
//
// 这是 .d.ts：不参与运行时，也不进代码指纹（CODE_FILE_RE 只匹配 .mjs/.js/.json/.yml）。

/** guard 回调收到的 exec 形状。字段按 2790 行的真实读取顺序声明。 */
export interface ExecShapeInput {
  name?: unknown;
  call?: { name?: unknown } | null | undefined;
  tool?: unknown;
}

/** 工具名命中的字段，按解析优先级排列。 */
export type ExecToolNameField = 'name' | 'call.name' | 'tool';

/** readExecToolName 的返回：命中与未命中是两个互斥分支。 */
export type ExecToolNameResult =
  | { ok: true; name: string; field: ExecToolNameField; fallback: boolean }
  | { ok: false; name: null; field: null; reason: 'missing-exec-name' };

/** inbox 注入目标。唯一合法值是 'next-turn'；驼峰 'nextTurn' 必须抛错。 */
export type InjectTarget = 'next-turn';

/** 注入消息：format v4 要求非空 id 与 producer-owned source kind。 */
export interface InjectMessage {
  id: string;
  role?: string;
  source: { kind: string; [key: string]: unknown };
  content?: unknown;
}

/** 指纹主体（磁盘计算与宿主自报共用的最小形状）。 */
export interface CodeFingerprint {
  readonly bundleHash: string;
  readonly files: Readonly<Record<string, string>>;
}

/** 模块加载时冻结的指纹，额外携带进程信息。 */
export interface LoadedCodeFingerprint extends CodeFingerprint {
  readonly loadedAt: number;
  readonly pid: number;
}

/** selftest 返回中 assertHostCodeFresh 关心的部分。 */
export interface SelftestHostResult {
  codeFingerprint?: CodeFingerprint | null;
  [key: string]: unknown;
}

/** 宿主 tools.register 的单对象契约（双参数形式不是真实契约）。 */
export interface HostToolRegistration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema?: Record<string, unknown>;
    render?: (args: unknown, value: unknown) => unknown;
  };
  execute: (args: unknown, exec: unknown) => unknown;
}

/** 宿主 guard：返回非空字符串即拒绝，返回 undefined / null 放行。 */
export type HostGuardFn = (exec: ExecShapeInput) => string | undefined | null;

/** tools.execute 的入参形状（复数 calls）。 */
export interface HostExecuteInput {
  calls: ReadonlyArray<{ id: string; name: string; arguments?: unknown }>;
  signal?: AbortSignal;
  agent?: unknown;
  log?: unknown;
}

/** tools.execute 的返回形状。 */
export interface HostExecuteResult {
  results: ReadonlyArray<{
    callId: string;
    result: {
      content?: ReadonlyArray<{ type: string; text?: string }>;
      isError?: boolean;
      error?: { message?: string } | unknown;
      meta?: unknown;
    };
  }>;
}
