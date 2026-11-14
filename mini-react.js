/* 御书房独立页面用的迷你 React 兼容层。
 *
 * 目的：让 DSH 的 client.js（React + slots 插件）原样跑在独立页面里，
 * 不复制、不改写业务代码。只实现 client.js 实际用到的 API：
 * createElement / useState / useRef / useCallback / useEffect，以及一个
 * 带最小 diff 的渲染器（复用 DOM 节点，受控输入不丢焦点）。
 */
(function (global) {
  let current = null;

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
    if (prev && sameDeps(prev.deps, deps)) return prev.fn;
    inst.hooks[i] = { fn, deps };
    return fn;
  }

  function useEffect(fn, deps) {
    const inst = current.instance;
    const i = current.index++;
    const prev = inst.hooks[i];
    if (prev && sameDeps(prev.deps, deps)) return;
    inst.hooks[i] = { deps };
    inst.effects.push(fn);
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

  function createDom(vnode) {
    if (vnode.t === 'text') {
      const node = document.createTextNode(vnode.value);
      vnode.__node = node;
      return node;
    }
    if (typeof vnode.type === 'function') {
      const inst = { hooks: [], effects: [], pending: false, out: null, vnode };
      current = { instance: inst, index: 0 };
      let out;
      try { out = vnode.type(vnode.props); } finally { current = null; }
      const node = createDom(out);
      inst.out = out;
      node.__inst = inst;
      vnode.__node = node;
      runEffects(inst);
      return node;
    }
    const el = document.createElement(vnode.type);
    // 先挂子节点再写属性：<select> 的 value 必须在 option 存在之后设置，
    // 否则 value='' 落在空 select 上会留下 selectedIndex=-1，下拉框显示空白。
    for (const child of vnode.children) el.appendChild(createDom(child));
    patchProps(el, {}, vnode.props);
    vnode.__node = el;
    return el;
  }

  function patchVnode(oldV, newV) {
    if (typeof oldV.type !== typeof newV.type) return createDom(newV);
    if (newV.t === 'text') {
      oldV.__node.nodeValue = newV.value;
      newV.__node = oldV.__node;
      return newV.__node;
    }
    if (typeof newV.type === 'function') {
      const inst = oldV.__node.__inst;
      if (!inst || oldV.type !== newV.type) return createDom(newV);
      current = { instance: inst, index: 0 };
      let out;
      try { out = newV.type(newV.props); } finally { current = null; }
      const node = patchVnode(inst.out, out);
      inst.out = out;
      node.__inst = inst;
      newV.__node = node;
      runEffects(inst);
      return node;
    }
    const el = oldV.__node;
    if (oldV.type !== newV.type || !el || el.nodeType !== 1) return createDom(newV);
    patchChildren(el, oldV.children, newV.children);
    patchProps(el, oldV.props, newV.props);
    newV.__node = el;
    return el;
  }

  function patchChildren(parent, oldChildren, newChildren) {
    // 复用集合：本轮真正挂上去的节点。收尾时父节点下不在集合里的子节点一律删掉。
    const keep = new Set();
    let ref = parent.firstChild;
    for (let i = 0; i < newChildren.length; i++) {
      const oldV = oldChildren[i];
      const newV = newChildren[i];
      let node;
      if (oldV && sameKind(oldV, newV)) node = patchVnode(oldV, newV);
      else node = createDom(newV);
      keep.add(node);
      if (node === ref) ref = ref ? ref.nextSibling : null;
      else parent.insertBefore(node, ref);
    }
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

  function runEffects(inst) {
    if (!inst.effects.length) return;
    const fns = inst.effects;
    inst.effects = [];
    for (const fn of fns) { try { fn(); } catch (e) { console.error('[mini-react effect]', e); } }
  }

  function scheduleInstance(inst) {
    if (inst.pending) return;
    inst.pending = true;
    Promise.resolve().then(() => {
      inst.pending = false;
      try {
        current = { instance: inst, index: 0 };
        let out;
        try { out = inst.vnode.type(inst.vnode.props); } finally { current = null; }
        const node = patchVnode(inst.out, out);
        inst.out = out;
        node.__inst = inst;
        runEffects(inst);
      } catch (e) {
        console.error('[mini-react update]', e);
      }
    });
  }

  function render(vnode, container) {
    container.innerHTML = '';
    const node = createDom(vnode);
    container.appendChild(node);
    vnode.__node = node;
    return node;
  }

  global.MiniReact = {
    createElement,
    useState,
    useRef,
    useCallback,
    useEffect,
    render,
  };
})(window);
