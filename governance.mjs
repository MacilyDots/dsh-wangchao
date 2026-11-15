// 单实例本地预算与审计；仅作本地估算门禁，不是服务商账单硬上限。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { orphanTmpState } from './orphan-tmp.mjs';
const validUsd = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const text = s => typeof s === 'string' && s.trim().length > 0;

export function openGovernance({ file, limitUsd, allowedPermissions = ['read'] }) {
  if (!text(file) || !validUsd(limitUsd) || !Array.isArray(allowedPermissions)
    || allowedPermissions.some(x => !text(x))) throw new Error('预算或权限配置不可确认');
  let entries, events;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.entries)) throw new Error('invalid state');
    const ids = new Set();
    for (const e of data.entries) {
      if (!e || !text(e.taskId) || ids.has(e.taskId) || !text(e.permission)
        || !validUsd(e.estimateUsd) || !['reserved','settled','unknown'].includes(e.status)
        || (e.status === 'settled' && !validUsd(e.actualEstimateUsd))
        || !Number.isFinite(e.createdAt)) throw new Error('invalid entry');
      ids.add(e.taskId);
    }
    if (data.events !== undefined && (!Array.isArray(data.events) || data.events.some(e => !e || !text(e.kind) || !Number.isFinite(e.at)))) throw new Error('invalid audit');
    entries = data.entries;
    events = data.events ?? [];
  } catch (e) {
    if (e?.code === 'ENOENT') {
      // 主文件缺失但临时文件仍在：上次结算/记账没走完 rename，账本不能当空账本重建
      // （否则未结算费用从合计里消失，本地门禁与账单对不上）。
      if (orphanTmpState(file) !== 'none') throw new Error('预算账本缺失但存在临时文件，需人工恢复（不得当作空账本）', {cause:e});
      entries = []; events = [];
    }
    else throw new Error('预算审计文件不可读，已暂停', {cause:e});
  }
  let closed = false;
  function commit(next, nextEvents = events) {
    if (closed) throw new Error('预算审计不可用');
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), {recursive:true});
      fs.writeFileSync(tmp, JSON.stringify({version:1, entries:next, events:nextEvents}, null, 2), {encoding:'utf8',flag:'wx',mode:0o600});
      fs.renameSync(tmp,file); entries=next; events=nextEvents;
    } catch(e) {
      closed=true;
      try { fs.rmSync(tmp,{force:true}); } catch {}
      throw new Error('预算审计写入失败，已暂停', {cause:e});
    }
  }
  // 重启后未结算不等于零成本；保留未知记录并暂停新的支出。
  if (entries.some(e => e.status === 'reserved')) commit(entries.map(e => e.status === 'reserved' ? {...e,status:'unknown',reason:'重启时费用结算未知'} : e));
  const snapshot = () => { if (closed) throw new Error('预算审计不可用'); return { limitUsd, usedEstimateUsd: entries.reduce((n,e)=>n+(e.status==='settled'?e.actualEstimateUsd:e.estimateUsd),0), unknownCount: entries.filter(e=>e.status==='unknown').length, entries:structuredClone(entries), note:'本地估算，不是服务商账单硬上限' }; };
  return {
    snapshot,
    audit({taskId, kind, detail}) {
      if (!text(taskId) || !['confirmation','dispatch','cancel','pause','outcome','handoff'].includes(kind)) throw new Error('审计记录无效');
      if (detail != null && (typeof detail !== 'string' || detail.length > 300)) throw new Error('审计详情无效');
      if (events.length >= 5000) throw new Error('审计记录已满，已暂停');
      const event = {taskId,kind,at:Date.now(),detail:detail ?? null};
      commit(entries, [...events,event]); return structuredClone(event);
    },
    auditSnapshot() { if (closed) throw new Error('预算审计不可用'); return structuredClone(events); },
    reserve({taskId, confirmation, permission, estimateUsd}) {
      if (closed) throw new Error('预算审计不可用');
      if (!text(taskId) || !confirmation || confirmation.by !== 'user' || !Number.isFinite(confirmation.at)) throw new Error('缺少用户确认');
      if (!allowedPermissions.includes(permission)) throw new Error('操作超出已配置权限');
      if (!validUsd(estimateUsd)) throw new Error('费用估算未知，已暂停');
      if (entries.some(e=>e.taskId===taskId)) throw new Error('该任务已有预算记录，不自动重发');
      const current = snapshot();
      if (current.unknownCount) throw new Error('存在费用未知记录，已暂停');
      if (current.usedEstimateUsd + estimateUsd > limitUsd) throw new Error('本地估算超出预算，已暂停');
      const entry = {taskId,permission,estimateUsd,status:'reserved',createdAt:Date.now(),confirmation:{by:confirmation.by,at:confirmation.at}};
      commit([...entries,entry]); return structuredClone(entry);
    },
    settle(taskId, result) {
      if (closed) throw new Error('预算审计不可用');
      const e=entries.find(x=>x.taskId===taskId);
      if (!e || e.status!=='reserved') throw new Error('预算记录不可结算');
      const next = result?.known===true && validUsd(result.actualEstimateUsd)
        ? {...e,status:'settled',actualEstimateUsd:result.actualEstimateUsd,settledAt:Date.now()}
        : {...e,status:'unknown',reason:'未取得可核实的费用估算',settledAt:Date.now()};
      commit(entries.map(x=>x.taskId===taskId?next:x)); return structuredClone(next);
    },
  };
}
