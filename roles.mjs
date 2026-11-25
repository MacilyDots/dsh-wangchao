// @ts-check
// 角色注册表迁移：从单一 state.chief 扩展为 state.roles 字典。
// v0.4.0-alpha：单一写入者，兼容别名通过 Object.defineProperty 代理，
// 既有 index.mjs 里 100+ 处 state.chief 引用零改动即可工作。

/** 一期固定角色枚举；executor 保留槽位但不启用。 */
export const ROLE_IDS = ['chief', 'hanlin', 'executor'];

/** 单个角色的默认结构（各角色可带不同字段，这里只给骨架）。 */
export function emptyRole() {
  return { sessionId: null, model: null, enabled: false };
}

/**
 * 把任意旧 state 归一成带 roles 字典的结构。
 * - 仅当 roles.chief 缺失时迁移旧 chief；显式 null 表示首辅已关闭
 * - roles 不是对象 → 重建为空字典
 * - 每个合法 roleId 保证有默认槽位；未知键不纳入固定枚举
 * - 不修改入参以外的对象；返回新的 roles 对象
 * @param {any} s
 * @returns {Record<string, any>}
 */
export function normalizeRoles(s) {
  /** @type {Record<string, any>} */
  const roles = {};
  if (s?.roles && typeof s.roles === 'object' && !Array.isArray(s.roles)) {
    for (const [k, v] of Object.entries(s.roles)) {
      if (ROLE_IDS.includes(k)) roles[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : (k === 'chief' ? null : emptyRole());
    }
  }
  // 新结构明确记录 chief 时优先，避免旧值复活已关闭的首辅。
  const oldChief = s?.chief;
  if (oldChief && typeof oldChief === 'object' && !Array.isArray(oldChief) && !Object.hasOwn(roles, 'chief')) {
    roles.chief = { ...oldChief };
  }
  for (const id of ROLE_IDS) {
    if (!(id in roles)) roles[id] = id === 'chief' ? null : emptyRole();
  }
  return roles;
}

/**
 * 在 state 对象上挂 `chief` 兼容别名（getter/setter 代理 state.roles.chief）。
 * 非枚举：JSON.stringify 不输出 chief，只落 roles；旧代码读写 state.chief 无感。
 * 若 state 已有自有 chief 属性，先删除再定义（迁移已把值搬进 roles）。
 * @param {any} state
 * @returns {any} 同一个 state 对象
 */
export function attachRoleAlias(state) {
  if (!state || typeof state !== 'object') return state;
  if (!state.roles || typeof state.roles !== 'object' || Array.isArray(state.roles)) {
    state.roles = normalizeRoles(state);
  }
  // 迁移 legacy chief 到 roles（若 loadState 路径已做则此处是幂等兜底）
  if (Object.prototype.hasOwnProperty.call(state, 'chief')) {
    const legacy = state.chief;
    if (legacy && typeof legacy === 'object' && !Object.hasOwn(state.roles, 'chief')) {
      state.roles.chief = { ...legacy };
    }
    delete state.chief;
  }
  Object.defineProperty(state, 'chief', {
    configurable: true,
    enumerable: false,
    get() { return this.roles.chief; },
    set(v) { this.roles.chief = v; },
  });
  return state;
}
