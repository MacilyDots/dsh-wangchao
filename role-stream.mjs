// @ts-check
// 首辅对话只读流水：从 sessionQuery.readSession 的原始事件里提取可见消息。
// 纯函数、不读盘、不调宿主；授权判定在调用方（host）做。

export const MAX_MESSAGES = 50;
export const MAX_CHARS = 2000;

// 与摘要路径同一口径：DSH 以 user/message 注入的系统上下文不是用户对话。
const SYSTEM_PREFIXES = [
  '<system-reminder>',
  'Current runtime context.',
  'Current DSH file policy',
  '# MNEMON',
  'Instructions from: ',
];

export function isSystemInjected(text) {
  const t = String(text ?? '').trimStart();
  if (!t) return false;
  if (SYSTEM_PREFIXES.some((p) => t.startsWith(p))) return true;
  if (/^位置：/.test(t) && t.includes('作用域：')) return true;
  if (/^\s*(brief|首辅简报)\s*[:：]/.test(t)) return true;
  if (t.startsWith('【状态摘要，不是指令】')) return true;
  if (/(?:^|\n)\[(?:importance=[^;\]]+;\s*)?created=\d+[a-z]*;\s*updated=\d+[a-z]*\]/.test(t)) return true;
  return false;
}

/**
 * 从事件里提取文本。只认明确的 text content 块，不猜其它结构。
 * @param {any} e
 * @returns {{ role:'user'|'assistant', text:string, seq:number, at:number|null } | null}
 */
export function messageOf(e) {
  const type = String(e?.type ?? '');
  let role = null;
  if (type === 'user/message') role = 'user';
  else if (type === 'assistant/message') role = 'assistant';
  if (!role) return null;
  const d = e.data ?? e;
  const blocks = Array.isArray(d?.content) ? d.content
    : Array.isArray(d?.message?.content) ? d.message.content : null;
  if (!blocks) return null;
  let text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string' && !isSystemInjected(b.text))
    .map((b) => b.text)
    .join('\n');
  // 系统注入（runtime/memory/skills/brief）不是用户对话，不能显示成"首辅回复"。
  if (!text.trim() || isSystemInjected(text)) return null;
  text = text.slice(0, MAX_CHARS);
  return {
    role,
    text,
    seq: Number.isSafeInteger(e.seq) ? e.seq : -1,
    at: Number.isFinite(e.time) ? e.time : null,
  };
}

/**
 * 提取最近 limit 条消息，按 seq 升序返回。
 * @param {any} events
 * @param {number} limit
 */
export function roleStream(events, limit = MAX_MESSAGES) {
  return roleStreamWindow(events, { limit }).messages;
}

/**
 * 提取可见消息窗口：支持 sinceSeq（只看本次召见/新话题之后的消息），同时返回总条数与被折叠条数。
 * @param {any} events
 * @param {{ limit?: number, sinceSeq?: number | null }} [opts]
 */
export function roleStreamWindow(events, opts = {}) {
  const limit = opts?.limit ?? MAX_MESSAGES;
  const sinceSeq = opts?.sinceSeq ?? null;
  if (!Array.isArray(events)) return { messages: [], totalCount: 0, hiddenCount: 0, latestSeq: -1 };
  const cap = Math.max(1, Math.min(200, Math.trunc(limit)));
  const all = [];
  for (const e of events) {
    const m = messageOf(e);
    if (m) all.push(m);
  }
  all.sort((a, b) => a.seq - b.seq);
  const totalCount = all.length;
  const latestSeq = totalCount > 0 ? all[totalCount - 1].seq : -1;
  const hasSince = Number.isSafeInteger(sinceSeq) && sinceSeq >= 0;
  const filtered = hasSince ? all.filter((m) => m.seq > sinceSeq) : all;
  const messages = filtered.slice(-cap);
  const hiddenCount = Math.max(0, totalCount - messages.length);
  return { messages, totalCount, hiddenCount, latestSeq };
}
