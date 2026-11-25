/* 御书房独立页面用的迷你 React 兼容层。
 *
 * 目的：让 DSH 的 client.js（React + slots 插件）原样跑在独立页面里，
 * 不复制、不改写业务代码。只实现 client.js 实际用到的 API：
 * createElement / useState / useRef / useCallback / useEffect，以及一个
 * 带最小 diff 的渲染器（复用 DOM 节点，受控输入不丢焦点）。
 *
 * 本版修复 useEffect 的清理语义（隔离补丁，基于 leader/mini-react.js）：
 *  1. effect 可以返回 cleanup；deps 变化时先跑旧 cleanup，再跑新 effect。
 *  2. 组件卸载（被替换、从子节点列表消失、整棵根树被 render 覆盖）时跑
 *     该组件所有 cleanup，并递归覆盖其输出子树里的子组件（子先父后）。
 *  3. 一次提交里先执行所有 cleanup、再执行所有新 effect（React 的被动
 *     副作用顺序），避免父组件 cleanup 落在子组件新 effect 之后。
 *  4. 已卸载实例上的 setState 被忽略，避免卸载后微任务里再渲染一次。
 *
 * 第二轮（独立审查 D1/D2/D3/D5）：
 *  5. effect 执行过程中组件被卸载（例如 effect 里同步 render 换根）时，effect
 *     返回的 cleanup 立即执行，不再丢（D1）。
 *  6. 一次提交失败（render/patch 抛错）时，作废本次新建实例并清掉它们排队的
 *     effect，避免失败树的 effect 在后续提交里“幽灵执行”（D2）。
 *  7. patch 中途抛错后，残留的死实例在下次 patch 里被整树替换而不是被复用
 *     （复用死实例会让该组件此后不再跑 effect）（D3）。
 *  8. 组件自更新的输出根节点被整体替换（元素类型变化 / 元素↔组件）时，把新节点
 *     接进 DOM 并摘掉旧节点；这条路径没有父级 patchChildren 帮忙（D5）。
 *  D4（同一个 vnode 对象跨挂载复用导致误清理）不修：vnode 视为一次性对象，
 *  重复挂载会打 warn；现有 client.js 无此用法（见 README §9）。
 */
(function (global) {
  let current = null;

  // 待提交的 effect 槽。一次顶层渲染/patch 结束后统一 drain：
  // 先全部 cleanup，再全部执行新 effect。
  let pendingEffects = [];
  let draining = false;

  // 一次顶层提交里新建的组件实例。提交抛错时用它们作废半成品（D2/D3）。
  let attempt = null;

  function beginAttempt() {
    if (!attempt) attempt = { instances: [] };
    return attempt;
  }

  // ok=false：本次提交失败 —— 新建实例从未跑过 effect，直接作废并把它们的排队槽从队列里摘掉，
  // 否则这些“幽灵 effect”会在下一次 drain 里执行，且永远没有卸载机会。
  function finishAttempt(ok) {
    if (!attempt) return;
    const a = attempt;
    attempt = null;
    if (ok) return;
    for (const inst of a.instances) {
      if (!inst || inst.__dead) continue;
      inst.__dead = true;
      inst.pending = false;
      const hooks = inst.hooks || [];
      for (const slot of hooks) {
        if (!slot || slot.kind !== 'effect') continue;
        slot.queued = false;
        slot.fn = null;
      }
      inst.hooks = [];
    }
    if (a.instances.length) pendingEffects = pendingEffects.filter((item) => !item.inst.__dead);
  }

  // 同一个 vnode 对象被挂载第二次：本渲染器把实例/节点指针存在 vnode 上，
  // vnode 因此是“一次性对象”。不修语义（改动面太大、无法证明安全），只告警一次。
  function warnReusedVnode(vnode) {
    if (vnode.__reuseWarned) return;
    vnode.__reuseWarned = true;
    console.warn('[mini-react] 同一个 vnode 对象被重复挂载：vnode 是一次性对象，请每次渲染重新 createElement，否则实例可能被误清理');
  }


  function wrap(list) {
    const out = [];
    const push = (c) => {
      if (c === null || c === undefined || c === false || c === true) return;
      if (Array.isArray(c)) { c.forEach(push); return; }
      if (typeof c === 'string' || typeof c === 'number') { out.push({ t: 'text', value: String(c) }); return; }
      if (typeof c === 'object') out.push(c);
    };
    list.forEach(push);
    return out;
  }

  function createElement(type, props) {
    const p = Object.assign({}, props || {});
    const key = p.key !== undefined ? p.key : undefined;
    delete p.key;
    return { t: 'el', type, key, props: p, children: wrap(Array.prototype.slice.call(arguments, 2)) };
  }

  function sameDeps(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }

  function useState(initial) {
    const inst = current.instance;
    const i = current.index++;
    if (!inst.hooks[i]) inst.hooks[i] = { v: typeof initial === 'function' ? initial() : initial };
    const slot = inst.hooks[i];
    const set = (next) => {
      // 卸载后不再渲染：cleanup 之后仍可能有一帧微任务/定时器回调触发 setState。
      if (inst.__dead) return;
      const value = typeof next === 'function' ? next(slot.v) : next;
      if (Object.is(value, slot.v)) return;
      slot.v = value;
      scheduleInstance(inst);
    };
    return [slot.v, set];
  }

  function useRef(initial) {
    const inst = current.instance;
    const i = current.index++;
    if (!inst.hooks[i]) inst.hooks[i] = { v: { current: initial } };
    return inst.hooks[i].v;
  }

  function useCallback(fn, deps) {
    const inst = current.instance;
    const i = current.index++;
    const prev = inst.hooks[i];
    if (prev && prev.kind === 'cb' && sameDeps(prev.deps, deps)) return prev.fn;
    inst.hooks[i] = { kind: 'cb', fn, deps };
    return fn;
  }

  function useEffect(fn, deps) {
    const inst = current.instance;
    const i = current.index++;
    const prev = inst.hooks[i];
    // deps 相等就完全跳过：cleanup 留在槽里，等依赖真变化或卸载时再跑。
    if (prev && prev.kind === 'effect' && sameDeps(prev.deps, deps)) return;
    const slot = prev && prev.kind === 'effect'
      ? prev
      : { kind: 'effect', deps: undefined, fn: null, cleanup: null, queued: false };
    slot.deps = deps;
    slot.fn = fn;
    // queued=true 表示「已排队但还没跑」：同一提交内被卸载的实例，靠它把这次 effect 取消掉。
    slot.queued = true;
    inst.hooks[i] = slot;
    pendingEffects.push({ inst, slot });
  }

  function eventName(key) {
    if (key === 'onChange') return 'input';
    if (key === 'onFocus') return 'focus';
    if (key === 'onBlur') return 'blur';
    if (key === 'onSubmit') return 'submit';
    if (key === 'onClick') return 'click';
    if (key === 'onKeyDown') return 'keydown';
    if (key === 'onKeyUp') return 'keyup';
    return null;
  }

  function patchProps(el, oldProps, newProps) {
    for (const key of Object.keys(newProps)) {
      if (key === 'children' || key === 'key') continue;
      const value = newProps[key];
      if (key === 'className' || key === 'class') {
        const cls = value == null ? '' : String(value);
        if (el.className !== cls) el.className = cls;
        continue;
      }
      if (key === 'style') {
        const prev = oldProps.style || {};
        const next = value || {};
        for (const k of Object.keys(prev)) if (!(k in next)) el.style[k] = '';
        for (const k of Object.keys(next)) { try { el.style[k] = next[k]; } catch (e) {} }
        continue;
      }
      const ev = eventName(key);
      if (ev) {
        if (el['__ev_' + key]) el.removeEventListener(ev, el['__ev_' + key]);
        if (typeof value === 'function') {
          const listener = function (event) { return value(event); };
          el.addEventListener(ev, listener);
          el['__ev_' + key] = listener;
        }
        continue;
      }
      if (key === 'value') {
        const str = value == null ? '' : String(value);
        if (el.value !== str) el.value = str;
        continue;
      }
      if (key === 'checked') { el.checked = !!value; continue; }
      if (key === 'disabled') { el.disabled = !!value; continue; }
      if (key === 'spellCheck') { el.spellCheck = !!value; continue; }
      if (key === 'htmlFor') { el.htmlFor = value == null ? '' : String(value); continue; }
      if (/^on[A-Z]/.test(key)) continue;
      if (value === undefined || value === null || value === false) { try { el.removeAttribute(key); } catch (e) {} continue; }
      if (typeof value === 'boolean') { try { el.setAttribute(key, ''); } catch (e) {} continue; }
      try { if (el.getAttribute(key) !== String(value)) el.setAttribute(key, String(value)); } catch (e) {}
    }
    for (const key of Object.keys(oldProps)) {
      if (key in newProps || key === 'children' || key === 'key') continue;
      const ev = eventName(key);
      if (ev) { if (el['__ev_' + key]) { el.removeEventListener(ev, el['__ev_' + key]); delete el['__ev_' + key]; } continue; }
      if (key === 'className' || key === 'class') { el.className = ''; continue; }
      if (key === 'style') { try { el.removeAttribute('style'); } catch (e) {} continue; }
      if (key === 'value' || key === 'checked' || key === 'disabled') continue;
      try { el.removeAttribute(key); } catch (e) {}
    }
  }

  // parentInst：包含这个 vnode 的组件实例（用于 effect 提交顺序的深度）。
  function createDom(vnode, parentInst) {
    if (vnode.__used) warnReusedVnode(vnode);
    vnode.__used = true;
    if (vnode.t === 'text') {
      const node = document.createTextNode(vnode.value);
      vnode.__node = node;
      return node;
    }
    if (typeof vnode.type === 'function') {
      const inst = {
        hooks: [], pending: false, out: null, vnode, __dead: false,
        depth: parentInst ? (parentInst.depth || 0) + 1 : 0,
      };
      if (attempt) attempt.instances.push(inst);
      current = { instance: inst, index: 0 };
      let out;
      try { out = vnode.type(vnode.props); } finally { current = null; }
      const node = createDom(out, inst);
      inst.out = out;
      node.__inst = inst;
      vnode.__inst = inst;
      vnode.__node = node;
      // effect 不在这里执行：先排进队列，等整棵新树建完再统一提交。
      return node;
    }
    const el = document.createElement(vnode.type);
    // 先挂子节点再写属性：<select> 的 value 必须在 option 存在之后设置，
    // 否则 value='' 落在空 select 上会留下 selectedIndex=-1，下拉框显示空白。
    for (const child of vnode.children) el.appendChild(createDom(child, parentInst));
    patchProps(el, {}, vnode.props);
    vnode.__node = el;
    return el;
  }

  // 旧节点被新节点整体替换：先拆旧树（跑 cleanup），再建新树。
  function replaceVnode(oldV, newV, parentInst) {
    if (oldV) unmountVnode(oldV);
    return createDom(newV, parentInst);
  }

  function patchVnode(oldV, newV, parentInst) {
    if (!oldV) return createDom(newV, parentInst);
    if (typeof oldV.type !== typeof newV.type) return replaceVnode(oldV, newV, parentInst);
    if (newV.t === 'text') {
      oldV.__node.nodeValue = newV.value;
      newV.__node = oldV.__node;
      return newV.__node;
    }
    if (typeof newV.type === 'function') {
      const inst = oldV.__inst || (oldV.__node && oldV.__node.__inst);
      // 死实例（上一轮提交失败留下的）不能复用：复用会让该组件此后永远不跑 effect，
      // 整树替换成新实例，走正常的挂载/清理流程（D3）。
      if (!inst || inst.__dead || oldV.type !== newV.type) return replaceVnode(oldV, newV, parentInst);
      current = { instance: inst, index: 0 };
      let out;
      try { out = newV.type(newV.props); } finally { current = null; }
      const node = patchVnode(inst.out, out, inst);
      inst.out = out;
      // 记下最新一版 vnode：scheduleInstance 用它重渲染，若停在挂载时那一版，
      // 组件自更新会拿旧 props 重算（父传 prop=1 后子自更新会显示回 prop=0）。
      inst.vnode = newV;
      node.__inst = inst;
      newV.__inst = inst;
      newV.__node = node;
      return node;
    }
    const el = oldV.__node;
    if (oldV.type !== newV.type || !el || el.nodeType !== 1) return replaceVnode(oldV, newV, parentInst);
    patchChildren(el, oldV.children, newV.children, parentInst);
    patchProps(el, oldV.props, newV.props);
    newV.__node = el;
    return el;
  }

  function patchChildren(parent, oldChildren, newChildren, parentInst) {
    // 复用集合：本轮真正挂上去的节点。收尾时父节点下不在集合里的子节点一律删掉。
    const keep = new Set();
    let ref = parent.firstChild;
    for (let i = 0; i < newChildren.length; i++) {
      const oldV = oldChildren[i];
      const newV = newChildren[i];
      let node;
      if (oldV && sameKind(oldV, newV)) node = patchVnode(oldV, newV, parentInst);
      else {
        // 同位置被换成不同类型的节点：旧子树的组件实例必须先卸载。
        if (oldV) unmountVnode(oldV);
        node = createDom(newV, parentInst);
      }
      keep.add(node);
      if (node === ref) ref = ref ? ref.nextSibling : null;
      else parent.insertBefore(node, ref);
    }
    // 新列表比旧列表短：尾部旧子树的组件实例在这里卸载。
    for (let i = newChildren.length; i < oldChildren.length; i++) unmountVnode(oldChildren[i]);
    // 旧树里没被复用的节点必须真删掉。只按“超出长度的尾部”删除会漏掉被替换掉的旧节点：
    // 表现就是页面底部残留上一版布局的文字（首屏 loading 换成正式内容时最容易出现）。
    for (const child of Array.from(parent.childNodes)) {
      if (!keep.has(child)) parent.removeChild(child);
    }
  }

  function sameKind(a, b) {
    if (a.t !== b.t) return false;
    if (a.t === 'text') return true;
    return a.type === b.type && a.key === b.key;
  }

  function runCleanup(fn) {
    try { fn(); } catch (e) { console.error('[mini-react effect cleanup]', e); }
  }

  // 卸载一个组件实例：跑它所有 effect 槽的 cleanup（hook 顺序）。
  // 子组件由 unmountVnode 先处理，所以整体是「子先父后」。
  function destroyInstance(inst) {
    if (!inst || inst.__dead) return;
    inst.__dead = true;
    inst.pending = false;
    const hooks = inst.hooks || [];
    inst.hooks = [];
    for (let i = 0; i < hooks.length; i++) {
      const slot = hooks[i];
      if (!slot || slot.kind !== 'effect') continue;
      const cleanup = slot.cleanup;
      slot.cleanup = null;
      slot.fn = null;
      slot.queued = false;
      if (typeof cleanup === 'function') runCleanup(cleanup);
    }
  }

  // 卸载一棵 vnode 子树：组件节点先递归它自己的输出，再销毁自己。
  function unmountVnode(v) {
    if (!v || typeof v !== 'object') return;
    if (v.t === 'text') return;
    if (typeof v.type === 'function') {
      const inst = v.__inst || (v.__node && v.__node.__inst);
      if (inst) {
        if (inst.out) unmountVnode(inst.out);
        destroyInstance(inst);
      }
      return;
    }
    if (Array.isArray(v.children)) for (const child of v.children) unmountVnode(child);
  }

  // 提交队列：同一轮的所有 cleanup 先跑完，再按排队顺序跑新 effect。
  // 排序按实例深度从深到浅（稳定排序）：节点树里子组件的 effect 先于祖先执行，
  // 与 React 的被动副作用遍历顺序一致；同深度保持 hook/创建顺序。
  function drainEffects() {
    if (draining) return;
    draining = true;
    try {
      while (pendingEffects.length) {
        const batch = pendingEffects;
        pendingEffects = [];
        batch.sort((a, b) => (b.inst.depth || 0) - (a.inst.depth || 0));
        const run = [];
        for (const item of batch) {
          const slot = item.slot;
          // 已取消（同一提交内被卸载）的 effect 不跑新逻辑，也不会留下 cleanup。
          if (!slot.queued) continue;
          slot.queued = false;
          if (typeof slot.cleanup === 'function') {
            const cleanup = slot.cleanup;
            slot.cleanup = null;
            runCleanup(cleanup);
          }
          run.push(item);
        }
        for (const item of run) {
          if (item.inst.__dead || typeof item.slot.fn !== 'function') continue;
          const fn = item.slot.fn;
          item.slot.fn = null;
          let ret;
          try { ret = fn(); } catch (e) { console.error('[mini-react effect]', e); ret = undefined; }
          if (item.inst.__dead) {
            // effect 执行过程中组件被卸载（典型：effect 里同步 render 换根）。
            // 这个 cleanup 已经没有槽可存、也不会再有卸载流程来找它 —— 立即执行（D1）。
            if (typeof ret === 'function') runCleanup(ret);
          } else if (typeof ret === 'function') {
            item.slot.cleanup = ret;
          }
        }
      }
    } finally {
      draining = false;
    }
  }

  function scheduleInstance(inst) {
    if (!inst || inst.__dead || inst.pending) return;
    inst.pending = true;
    Promise.resolve().then(() => {
      if (inst.__dead) { inst.pending = false; return; }
      inst.pending = false;
      beginAttempt();
      let ok = true;
      try {
        current = { instance: inst, index: 0 };
        let out;
        try { out = inst.vnode.type(inst.vnode.props); } finally { current = null; }
        const prevNode = inst.out ? inst.out.__node : null;
        const node = patchVnode(inst.out, out, inst);
        inst.out = out;
        // 组件自更新的输出根节点可能被整体替换（元素类型变化 / 元素↔组件）：
        // 这条路径上面没有父级 patchChildren，必须自己把新节点接进 DOM 并摘掉旧节点（D5）。
        if (prevNode && node !== prevNode && prevNode.parentNode) {
          prevNode.parentNode.insertBefore(node, prevNode);
          prevNode.parentNode.removeChild(prevNode);
        }
        if (node) node.__inst = inst;
      } catch (e) {
        ok = false;
        console.error('[mini-react update]', e);
      }
      finishAttempt(ok);
      drainEffects();
    });
  }

  // 根容器 -> 根 vnode。用于 render 覆盖同一容器时先卸载旧根树。
  const rootVnodes = new WeakMap();

  function render(vnode, container) {
    const prev = rootVnodes.get(container);
    beginAttempt();
    let node;
    try {
      if (prev) unmountVnode(prev);
      container.innerHTML = '';
      node = createDom(vnode);
      container.appendChild(node);
      vnode.__node = node;
      rootVnodes.set(container, vnode);
    } catch (e) {
      // 挂载失败不留半棵树：作废本次新建实例与它们的排队 effect，容器保持空（D2）。
      finishAttempt(false);
      rootVnodes.delete(container);
      try { container.innerHTML = ''; } catch (e2) {}
      throw e;
    }
    finishAttempt(true);
    drainEffects();
    return node;
  }

  function unmount(container) {
    const prev = rootVnodes.get(container);
    if (prev) {
      rootVnodes.delete(container);
      unmountVnode(prev);
    }
    if (container) container.innerHTML = '';
  }

  global.MiniReact = {
    createElement,
    useState,
    useRef,
    useCallback,
    useEffect,
    render,
    unmount,
  };
})(window);
