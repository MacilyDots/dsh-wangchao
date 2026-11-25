// @ts-check
// 角色消息幂等：以 clientMessageId 为键，挡重复提交与 ID 冲突。
// 只放内存、有上限、有 TTL；不做跨重启去重（重启后客户端应换新 ID）。

export const DEDUPE_MS = 5 * 60 * 1000;
export const DEDUPE_MAX = 1000;

/**
 * @param {Map<string, any>} store
 * @param {{ clientMessageId:any, text:any, roleId:any, now:number, compute:() => Promise<any> }} args
 */
export async function deliverOnce(store, args) {
  const { clientMessageId, text, roleId, now, compute } = args;
  if (typeof clientMessageId !== 'string' || !clientMessageId.trim() || clientMessageId.length > 200 || typeof text !== 'string') {
    return { ok: false, code: 'invalid-message', error: '需要有效的 clientMessageId 和文本' };
  }
  const signature = JSON.stringify([roleId, text]);
  for (const [id, entry] of store) {
    if (entry.done && now - entry.at >= DEDUPE_MS) store.delete(id);
  }
  const prev = store.get(clientMessageId);
  if (prev) {
    if (prev.signature !== signature) return { ok: false, code: 'id-conflict', error: '消息 ID 已用于其他内容' };
    return { ...await prev.promise, deduped: true };
  }
  if (store.size >= DEDUPE_MAX) return { ok: false, code: 'dedupe-full', error: '消息队列繁忙，请稍后重试' };
  const entry = { at: now, signature, done: false, promise: null };
  entry.promise = Promise.resolve().then(compute).finally(() => { entry.done = true; });
  store.set(clientMessageId, entry);
  return entry.promise;
}
