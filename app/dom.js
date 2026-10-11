// Tiny DOM helpers: element builder, icons, toasts, dialogs.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (val === null || val === undefined || val === false) continue;
        if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val; // custom properties need setProperty
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

const ICONS = {
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 4M6.7 6.7A17 17 0 0 0 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  line: '<path d="M5 19L19 5"/>',
  group: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3"/>',
  message: '<path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.2-4.4A8 8 0 1 1 21 12z"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  grid: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  alignLeft: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  alignCenter: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  alignRight: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  alignJustify: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  eyeView: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  cursor: '<path d="M5 4l14 7-6 2-2 6z"/>',
  clipboard: '<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V4h6v1M9 11h6M9 15h6"/>',
  // the Studio
  chevL: '<path d="M14.5 5l-7 7 7 7"/>',
  chevR: '<path d="M9.5 5l7 7-7 7"/>',
  chevD: '<path d="M5 9.5l7 7 7-7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  system: '<rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16.5V20"/>',
  month: '<rect x="3.5" y="5" width="17" height="15" rx="1"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  wall: '<rect x="4" y="4" width="7" height="9"/><rect x="13" y="4" width="7" height="9"/><rect x="4" y="15" width="7" height="5"/><rect x="13" y="15" width="7" height="5"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  queue: '<rect x="5" y="7" width="14" height="13" rx="1"/><path d="M8 4h8M9 13.5l2.2 2.2L15.5 11"/>',
  plan: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  insights: '<path d="M3.5 19.5l5.5-7 4 3.5 7.5-10"/><path d="M15.5 6h5v5"/>',
  keys: '<rect x="2.5" y="6.5" width="19" height="11" rx="1.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7 14h10"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  alert: '<path d="M12 4l9.5 16h-19z"/><path d="M12 10v4.5M12 17.2v.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/>',
  playOutline: '<path d="M8 5.5v13l11-6.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  undoArrow: '<path d="M9 14L4 9l5-5"/><path d="M4 9h9a6 6 0 0 1 0 12h-4"/>',
  skip: '<path d="M5 5l9 7-9 7zM18 5v14"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  home: '<path d="M4 11l8-7 8 7M6 10v10h12V10"/>',
  dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  calendarSend: '<rect x="3.5" y="5" width="17" height="15" rx="1"/><path d="M3.5 9.5h17M8 3v4M16 3v4M10 15h5M13 13l2 2-2 2"/>',
  // the video editor
  split: '<path d="M12 3v18M7.5 8L4 12l3.5 4M16.5 8L20 12l-3.5 4"/>',
  zoomIn: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4.5 4.5M8.5 11h5M11 8.5v5"/>',
  zoomOut: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4.5 4.5M8.5 11h5"/>',
  fit: '<path d="M3.5 12h17M7 8.5L3.5 12 7 15.5M17 8.5l3.5 3.5-3.5 3.5"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z"/><path d="M6 8h4M14 8h4"/>',
  ripple: '<path d="M3.5 12h6M14.5 12h6M10 8l4 4-4 4"/>',
  stepBack: '<path d="M6 5v14M18 5.5L9 12l9 6.5z"/>',
  stepForward: '<path d="M18 5v14M6 5.5L15 12l-9 6.5z"/>',
  toStart: '<path d="M5 5v14M19 5.5L9 12l10 6.5z"/>',
  toEnd: '<path d="M19 5v14M5 5.5L15 12 5 18.5z"/>',
  trimIn: '<path d="M8 4v16M8 12h12M16 8l4 4-4 4"/>',
  trimOut: '<path d="M16 4v16M16 12H4M8 8l-4 4 4 4"/>',
  pin: '<path d="M12 21s6-5.5 6-10.5a6 6 0 0 0-12 0C6 15.5 12 21 12 21z"/><circle cx="12" cy="10.5" r="2"/>',
  film: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4"/>',
};

export function icon(name, size) {
  const span = document.createElement('span');
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"${size ? ` style="width:${size}px;height:${size}px"` : ''}>${ICONS[name] ?? ''}</svg>`;
  return span;
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  wrapped.flush = (...a) => { clearTimeout(t); fn(...a); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

let toastBox;
export function toast(message, kind = 'info', ms = 4200) {
  toastBox ??= document.body.appendChild(h('div', { class: 'toasts' }));
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  toastBox.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? Math.max(ms, 7000) : ms);
}

/** Show a dialog. `build(body)` fills it; `actions` are buttons; resolves with the id of the action taken (or null). */
export function dialog({ title, build, actions, onOpen }) {
  return new Promise((resolve) => {
    const body = h('div', { class: 'db' });
    const dlg = h('dialog', {}, h('div', { class: 'dh' }, title), body, h('div', { class: 'df' }));
    const foot = dlg.querySelector('.df');
    let result = null;
    const finish = (id) => { result = id; dlg.close(); };
    build?.(body, finish);
    for (const a of actions ?? [{ id: 'ok', label: 'OK', primary: true }]) {
      foot.append(h('button', { class: `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`, onclick: () => finish(a.id) }, a.label));
    }
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); finish(actions?.find((a) => a.primary)?.id ?? 'ok'); } });
    document.body.append(dlg);
    dlg.showModal();
    onOpen?.(body);
  });
}

export async function confirmBox(message, { ok = 'OK', danger = false, title = 'Are you sure?' } = {}) {
  const r = await dialog({
    title, build: (b) => b.append(h('p', {}, message)),
    actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: ok, primary: !danger, danger }],
  });
  return r === 'ok';
}

/** Ask for one or more text values. fields: [{name,label,value,type,options}] */
export async function promptBox(title, fields, { ok = 'OK' } = {}) {
  const inputs = {};
  const r = await dialog({
    title,
    build: (b) => {
      for (const f of fields) {
        const input = f.options
          ? h('select', { class: 'field' }, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)))
          : f.multiline ? h('textarea', { class: 'field', rows: 3, value: f.value ?? '' }) : h('input', { class: 'field', type: f.type ?? 'text', value: f.value ?? '', placeholder: f.placeholder ?? '' });
        inputs[f.name] = input;
        b.append(h('div', { class: 'row', style: { alignItems: f.multiline ? 'flex-start' : 'center' } }, h('label', { style: { width: '90px' } }, f.label), h('div', { class: 'grow' }, input)));
      }
    },
    onOpen: () => inputs[fields[0].name]?.focus(),
    actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: ok, primary: true }],
  });
  if (r !== 'ok') return null;
  return Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
}

/** Keep the focused input (and its caret) across a re-render of `root`. */
export function preserveFocus(root, fn) {
  const a = document.activeElement;
  const key = a && root.contains(a) ? a.dataset?.field : null;
  const range = key && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;
  fn();
  if (!key) return;
  const next = root.querySelector(`[data-field="${CSS.escape(key)}"]`);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (range && 'setSelectionRange' in next) { try { next.setSelectionRange(...range); } catch { /* not a text field */ } }
}
