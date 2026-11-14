// dsh-wangchao 受控多任务调度器。
//
// 定位：**薄补位器**，不是第二个任务存储。任务状态、依赖、并发上限、取消与终态
// 全部由 task-store 持久化并判定；本模块只在状态变化后反复询问 store「下一个可派发
// 任务」，按 createdAt 顺序调用 store.dispatch，派发结束自动补位。重启语义沿用 R7：
// running → unknown、confirmed → failed，不自动续跑。
//
// 预算/安全包装点：`interceptExecute` 在每次真正调用执行桥之前执行，参数
// `{ task, context, run, scheduler }`。包装方可以：
//   - 先持久化预算记录，再调用 run()；
//   - 预算或安全条件不满足时返回 { status:'failed'|'unknown', failureReason } 且不调用 run()；
//   - 调用 scheduler.pause(reason) 暂停后续自动补位（未知成本必须暂停），确认后 resume()。
// 本模块不实现预算逻辑，也不修改预算记录。
import { DEFAULT_MAX_PARALLEL_TASKS, MAX_PARALLEL_TASKS } from './task-store.mjs';

export const DEFAULT_RETRY_DELAY_MS = 2000;

const text = (v) => typeof v === 'string' && v.trim().length > 0;

export function createScheduler({
  store,
  execute,
  maxParallelTasks,          // 省略时取 store 的配置；两者都给则必须一致
  interceptExecute = null,   // 预算/安全包装；见文件头
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  onEvent = null,
} = {}) {
  for (const method of ['dispatch', 'confirm', 'cancel', 'nextDispatchableId', 'settleBlockedDependencies', 'maxParallelTasks']) {
    if (typeof store?.[method] !== 'function') throw new Error('invalid scheduler configuration');
  }
  if (typeof execute !== 'function') throw new Error('invalid scheduler execution bridge');
  if (interceptExecute !== null && typeof interceptExecute !== 'function') throw new Error('invalid scheduler configuration');
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new Error('invalid scheduler retry delay');
  const storeLimit = store.maxParallelTasks();
  const limit = maxParallelTasks === undefined ? storeLimit : maxParallelTasks;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PARALLEL_TASKS || limit !== storeLimit) {
    throw new Error('invalid scheduler concurrency configuration');
  }
  let pumping = null;
  let repump = false;
  let paused = null;                 // { reason, at } 或 null
  let retryTimer = null;
  const active = new Map();          // taskId -> dispatch promise
  const emit = (event) => { try { onEvent?.(event); } catch {} };

  const runWithIntercept = (task, context) => {
    if (typeof interceptExecute !== 'function') return execute(task, context);
    return interceptExecute({
      task,
      context,
      run: (t = task, c = context) => execute(t, c),
      scheduler: api,
    });
  };

  const scheduleRetry = () => {
    if (retryTimer !== null || retryDelayMs <= 0) return;
    retryTimer = setTimeout(() => { retryTimer = null; void pump().catch(() => {}); }, retryDelayMs);
    retryTimer.unref?.();
  };

  const launch = (id) => {
    const promise = (async () => {
      emit({ type: 'launched', taskId: id, active: [...active.keys()] });
      try {
        await store.dispatch(id, runWithIntercept);
      } catch (e) {
        // 拒绝不是执行失败：store 已经把可确认的失败落盘；这里只记录并在稍后重试补位。
        emit({ type: 'dispatch-rejected', taskId: id, error: String(e?.message ?? e) });
        scheduleRetry();
      } finally {
        active.delete(id);
      }
    })().finally(() => { if (!paused) void pump().catch(() => {}); });
    active.set(id, promise);
  };

  const runCycle = async () => {
    await store.settleBlockedDependencies();
    while (!paused && active.size < limit) {
      const id = await store.nextDispatchableId(new Set(active.keys()));
      // 等待依赖或授权时可能已暂停/卸载，不能继续消费确认过的任务。
      if (!id || paused) break;
      launch(id);
    }
  };

  const pump = async () => {
    if (paused) return null;
    if (pumping) { repump = true; return pumping; }
    pumping = (async () => {
      try {
        do {
          repump = false;
          await runCycle();
        } while (repump && !paused);
      } finally {
        pumping = null;
      }
    })();
    return pumping;
  };

  const latest = async (id, fallback) => {
    try { return await store.get(id); } catch { return fallback; }
  };

  const api = {
    /** 尝试补位：按 createdAt 顺序派发依赖已成功、并发未满的 confirmed 任务。 */
    pump,
    /** 确认后立即补位；queued=true 表示因依赖未就绪或并发已满而留在 confirmed。 */
    async confirmAndDispatch(id, by) {
      const confirmed = await store.confirm(id, by);
      await pump();
      const task = await latest(id, confirmed);
      // 已经在本次补位中启动的任务不再是 queued，即使 store.get 读到的还是 running 前的确认快照。
      const launched = active.has(id);
      return { task, queued: !launched && task?.status === 'confirmed' };
    },
    /** 取消：proposed/confirmed 直接终态；running 只记录请求并尽力 abort，不谎称已停止。 */
    async cancel(id, by, reason) {
      const cancelled = await store.cancel(id, by, reason);
      await pump();
      return latest(id, cancelled);
    },
    /** 预算/安全线暂停自动补位；已在执行的任务不受影响（由各自执行桥的取消语义处理）。 */
    pause(reason) {
      const why = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : '未说明原因';
      paused = { reason: why, at: Date.now() };
      emit({ type: 'paused', reason: why });
      return { ...paused };
    },
    resume() {
      if (!paused) return false;
      paused = null;
      emit({ type: 'resumed' });
      void pump().catch(() => {});
      return true;
    },
    isPaused() { return paused !== null; },
    status() {
      return {
        paused: paused ? { ...paused } : null,
        active: [...active.keys()],
        maxParallelTasks: limit,
        retryPending: retryTimer !== null,
        pumping: pumping !== null,
      };
    },
    /** 等待当前所有已派发任务结束（测试/卸载前使用）；不停止执行。 */
    async whenIdle() {
      for (;;) {
        if (pumping) await pumping;
        if (active.size > 0) {
          await Promise.allSettled([...active.values()]);
          continue;
        }
        // 派发结算与下一次补位之间隔着若干微任务/授权 await：让出一拍再确认是否真的空。
        await new Promise((resolve) => setImmediate(resolve));
        if (!pumping && active.size === 0) return;
      }
    },
    /** 只清理重试定时器与暂停状态，不中止执行中的任务。 */
    dispose() {
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      paused = { reason: 'scheduler disposed', at: Date.now() };
    },
  };
  return api;
}
