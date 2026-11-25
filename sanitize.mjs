// 诊断/错误信息脱敏：结构化投影 + 模式脱敏，防止凭据进入审计、日志与 API 响应。
//
// 设计原则（对应 GAP-MODEL G3-2）：
//  - 优先「字段白名单投影」：只保留可解释的错误元数据，丢弃任意原始对象/正文。
//  - 再做「模式脱敏」兜底：对常见凭据形状（Bearer/Authorization/api key/token/URL query）替换为 [REDACTED]。
//  - 输出长度有界；永不返回原始对象引用，避免下游再次序列化时泄漏未投影字段。
//  - 本模块不读取任何环境变量或凭据，只处理传入的字符串/对象。

const MAX_OUT = 400;

/** 凭据形状（顺序：先精确头，再键值，再裸 key/token）。 */
const PATTERNS = [
  // Authorization: Bearer xxx / Basic xxx
  [/\b(authorization\s*[:=]\s*)(bearer|basic|digest)?\s*[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  // Bearer xxx（无 Authorization 前缀）
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  // 常见键值：api_key / apiKey / api-key / access_token / token / secret / password / key / cred
  [/\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|credential|secret|password|passwd|token|key|sig|signature)\b(\s*[:=]\s*)("?)[^\s"'&,;]{4,}/gi, '$1$2$3[REDACTED]'],
  // URL query/片段里的 creds
  [/([?&](?:api[_-]?key|access[_-]?token|token|key|secret|sig|signature)=)[^\s&"']+/gi, '$1[REDACTED]'],
  // 键名后空格 + 长值的写法（如 "invalid api_key VALUE"）；只限明确凭据词，避免误伤普通文本
  [/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  // 常见供应商 key 前缀
  [/\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})/g, '[REDACTED]'],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[REDACTED]'],
];

/** 对单个字符串做模式脱敏并截断。 */
export function scrubText(input, maxLen = MAX_OUT) {
  if (typeof input !== 'string' || !input) return '';
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out.length > maxLen ? out.slice(0, maxLen) + '…' : out;
}

/** 允许进入审计/展示的字段（白名单）。 */
const ALLOWED_KEYS = new Set([
  'code', 'type', 'errorCode', 'status', 'statusCode', 'httpStatus', 'name',
  'message', 'msg', 'detail', 'reason', 'model', 'provider', 'retryable',
  'requestId', 'stopReason', 'cause',
]);

/**
 * 结构化投影：只保留白名单字段；嵌套最多 2 层；字符串统一脱敏；绝不返回函数/原型链/大对象。
 * @param {any} value 任意错误/诊断值
 * @param {{maxLen?:number, depth?:number}} [opts]
 */
export function projectDiagnostic(value, opts = {}) {
  const maxLen = opts.maxLen ?? 240;
  const depth = opts.depth ?? 2;
  const seen = new Set();
  const walk = (v, d) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return scrubText(v, maxLen);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v !== 'object' || d <= 0) return typeof v === 'object' ? '[object]' : null;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 8).map((x) => walk(x, d - 1));
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (!ALLOWED_KEYS.has(k)) continue;
      out[k] = walk(val, d - 1);
    }
    return out;
  };
  return walk(value, depth);
}

/**
 * 生成可安全落审计的简短诊断字符串：投影 → 脱敏 → 截断。
 * @param {any} value
 * @param {{maxLen?:number}} [opts]
 */
export function safeDiagnostic(value, opts = {}) {
  const maxLen = opts.maxLen ?? 240;
  const projected = typeof value === 'string' ? scrubText(value, maxLen) : projectDiagnostic(value, { maxLen, depth: 2 });
  if (projected === null) return '';
  if (typeof projected === 'string') return projected;
  let s;
  try { s = JSON.stringify(projected); } catch { s = ''; }
  const scrubbed = scrubText(s, maxLen);
  return scrubbed === '{}' ? '' : scrubbed;
}

/** 便捷：把任意错误对象变成 { code, message } 的安全结构（不含原始 error 引用）。 */
export function safeErrorOf(error, fallbackCode = 'unknown') {
  if (!error) return { code: fallbackCode, message: '' };
  const code = typeof error.code === 'string' && error.code ? error.code : fallbackCode;
  const message = scrubText(typeof error.message === 'string' ? error.message : String(error));
  return { code, message };
}
