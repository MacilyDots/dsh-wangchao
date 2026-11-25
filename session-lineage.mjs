// B5：可选只读会话血缘（消费 ~/.dsh/session-inherit/history.json，零运行时强依赖）。
// 约束：
//  - 仅只读解析 v1/v2 history.json，绝不写入、绝不自动合并研究项目；
//  - 识别 sourceSessionId -> derivedSessionId，区分 inherit / rescue / unknown；
//  - 文件缺失、JSON 损坏、循环或冲突时优雅降级（degraded=true），记录 anomalies 与 coverageGaps；
//  - 权限校验始终 Fail-Closed：任一端未授权则不暴露受限会话 ID。
import fs from 'node:fs';

const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;

function classifyKind(entry) {
  const mode = typeof entry?.mode === 'string' ? entry.mode.toLowerCase() : '';
  if (mode.startsWith('service-') || mode.includes('rescue') || mode.includes('degen')) return 'rescue';
  if (mode === '' || mode === 'manual' || mode === 'ui' || mode === 'command' || mode === 'inherit') return 'inherit';
  return 'unknown';
}

export function readSessionLineage({ historyFile, canAccessSession } = {}) {
  if (typeof canAccessSession !== 'function') {
    throw Object.assign(new Error('缺少实时权限判定函数 canAccessSession'), { code: 'INVALID' });
  }
  const permitted = (sid) => {
    try { return canAccessSession(sid) === true; } catch { return false; }
  };

  const out = {
    available: false,
    degraded: false,
    edges: [],
    anomalies: [],
    coverageGaps: [],
    redactedCount: 0,
  };

  if (!nonempty(historyFile)) {
    out.degraded = true;
    out.coverageGaps.push('未配置会话继承历史路径（historyFile）');
    return out;
  }

  let rawText;
  try {
    rawText = fs.readFileSync(historyFile, 'utf8');
  } catch (e) {
    out.degraded = true;
    out.coverageGaps.push(e?.code === 'ENOENT' ? '会话继承历史文件不存在（已降级为空血缘）' : `会话继承历史不可读：${e?.code ?? 'IO_ERROR'}`);
    return out;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    out.degraded = true;
    out.anomalies.push({ code: 'CORRUPT_JSON', message: 'history.json 损坏无法解析，已降级为空血缘' });
    out.coverageGaps.push('会话继承历史 JSON 损坏');
    return out;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    out.degraded = true;
    out.anomalies.push({ code: 'INVALID_SHAPE', message: 'history.json 顶层结构非法' });
    return out;
  }

  const sources = parsed.version === 2 && parsed.sources && typeof parsed.sources === 'object'
    ? parsed.sources
    : parsed;

  const parentByChild = new Map();
  for (const [sourceId, list] of Object.entries(sources)) {
    if (!nonempty(sourceId) || !Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object' || !nonempty(item.child)) continue;
      const derivedId = item.child;
      if (sourceId === derivedId) {
        out.degraded = true;
        out.anomalies.push({ code: 'SELF_LOOP', message: `检测到自引用血缘（已跳过）` });
        continue;
      }
      if (parentByChild.has(derivedId) && parentByChild.get(derivedId) !== sourceId) {
        out.degraded = true;
        out.anomalies.push({ code: 'CONFLICT_PARENT', message: '同一派生会话存在多个冲突来源（已标记冲突）' });
      } else {
        parentByChild.set(derivedId, sourceId);
      }

      // Fail-Closed 权限过滤：任一端未授权即隐藏，不泄露未授权 ID。
      if (!permitted(sourceId) || !permitted(derivedId)) {
        out.redactedCount += 1;
        continue;
      }
      out.edges.push({
        sourceSessionId: sourceId,
        derivedSessionId: derivedId,
        kind: classifyKind(item),
        state: typeof item.state === 'string' ? item.state : 'ok',
        at: Number.isFinite(item.at) ? item.at : null,
        conflict: parentByChild.get(derivedId) !== sourceId,
      });
    }
  }

  out.available = true;
  if (out.redactedCount > 0) {
    out.coverageGaps.push(`有 ${out.redactedCount} 条血缘记录因权限不足已隐藏`);
  }
  return out;
}
