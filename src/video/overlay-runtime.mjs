// Runs INSIDE the overlay page (the browser), never in Node. It is passed to page.evaluate, so it has to be one
// self-contained function: no imports, no outside names.
//
// It owns time. setTime(t) shows the layers that are on at t and puts each one where its animation says it is at t, so the
// same picture comes out whether frames are drawn in order or one at a time. Presets are described in docs/VIDEO.md.

export function installOverlayRuntime(cfg) {
  const root = document.getElementById('canvas');
  const u = cfg.u; // canvas pixels per px of the 1080-wide reference
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const EASES = {
    linear: (x) => x,
    in: (x) => x * x,
    out: (x) => 1 - (1 - x) * (1 - x),
    'in-out': (x) => (x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2),
    'in-cubic': (x) => x ** 3,
    'out-cubic': (x) => 1 - (1 - x) ** 3,
    'in-out-cubic': (x) => (x < 0.5 ? 4 * x ** 3 : 1 - ((-2 * x + 2) ** 3) / 2),
    'out-back': (x) => { const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; },
  };
  const ease = (name, x) => (EASES[name] ?? EASES['out-cubic'])(clamp01(x));
  const lerp = (a, b, p) => a + (b - a) * p;

  /** Wrap every character (or word) of the layer's text so it can be revealed one by one. */
  function split(el, mode) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const spans = [];
    for (const node of nodes) {
      const frag = document.createDocumentFragment();
      const pieces = mode === 'chars' ? [...node.nodeValue] : node.nodeValue.split(/(\s+)/);
      for (const piece of pieces) {
        if (piece === '') continue;
        if (mode === 'words' && /^\s+$/.test(piece)) { frag.append(document.createTextNode(piece)); continue; }
        const s = document.createElement('span');
        s.textContent = piece;
        if (!/^\s+$/.test(piece)) spans.push(s);
        frag.append(s);
      }
      node.replaceWith(frag);
    }
    return spans;
  }

  const items = [];
  for (const meta of cfg.layers) {
    const el = [...root.children].find((c) => c.getAttribute('data-layer') === meta.id);
    if (!el) continue;
    const item = {
      meta, el, baseOpacity: el.style.opacity === '' ? 1 : parseFloat(el.style.opacity), baseClip: el.style.clipPath,
      baseLeft: el.style.left, baseTop: el.style.top, baseWidth: el.style.width, baseHeight: el.style.height,
      baseFilter: el.style.filter, baseSpacing: parseFloat(el.style.letterSpacing) || 0, path: el.querySelector('path'), counter: null,
      chars: null, words: null, runs: null, runColors: null, lastHighlight: undefined,
    };
    if (meta.anim.some((a) => a.preset === 'typewriter')) item.chars = split(el, 'chars');
    if (meta.anim.some((a) => a.preset === 'word-by-word')) item.words = split(el, 'words');
    if (meta.caption) item.runs = [...el.querySelectorAll('[data-run]')];
    const count = meta.anim.find((a) => a.preset === 'count-up');
    if (count) item.counter = count;
    el.style.visibility = 'hidden';
    items.push(item);
  }

  const DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1], top: [0, -1], bottom: [0, 1] };

  function applyAnim(a, lt, st) {
    const raw = a.dur > 0 ? (lt - a.start) / a.dur : (lt >= a.start ? 1 : 0);
    const exit = a.preset.endsWith('-out');
    const x = clamp01(raw);
    if (a.keyframes) return applyKeyframes(a, lt - a.start, st);
    const params = a.params ?? {};
    const p = ease(a.ease, x);
    const dist = (params.distance ?? 40) * 1;
    switch (a.preset) {
      case 'fade-in': st.op *= p; break;
      case 'fade-out': st.op *= 1 - p; break;
      case 'rise-in': st.op *= p; st.ty += (1 - p) * dist; break;
      case 'rise-out': st.op *= 1 - p; st.ty -= p * dist; break;
      case 'fall-in': st.op *= p; st.ty -= (1 - p) * dist; break;
      case 'pop': {
        const q = ease('out-back', x);
        st.sc *= lerp(params.from ?? 0.7, 1, q);
        st.op *= Math.min(1, x * 3);
        break;
      }
      case 'slide-in': case 'slide-out': {
        const [dx, dy] = DIRS[params.from ?? params.to ?? 'left'] ?? DIRS.left;
        const d = (params.distance ?? 160);
        const k = exit ? p : 1 - p;
        st.tx += dx * d * k; st.ty += dy * d * k;
        st.op *= exit ? 1 - p : p;
        break;
      }
      case 'wipe': case 'wipe-out': {
        const side = params.from ?? 'left';
        const k = exit ? 1 - p : p; // how much is showing
        const hide = (1 - k) * 100;
        st.clip = side === 'right' ? `inset(0 0 0 ${hide}%)` : side === 'up' || side === 'top' ? `inset(${hide}% 0 0 0)` : side === 'down' || side === 'bottom' ? `inset(0 0 ${hide}% 0)` : `inset(0 ${hide}% 0 0)`;
        break;
      }
      case 'typewriter': st.chars = p; break;
      case 'word-by-word': st.words = p; break;
      case 'scale-in': st.op *= Math.min(1, x * 2.5); st.sc *= lerp(params.from ?? 0.6, 1, p); break;
      case 'blur-in': st.op *= p; st.blur = Math.max(st.blur ?? 0, (1 - p) * (params.amount ?? 24)); break;
      case 'blur-out': st.op *= 1 - p; st.blur = Math.max(st.blur ?? 0, p * (params.amount ?? 24)); break;
      case 'spin-in': { const q = ease('out-back', x); st.op *= Math.min(1, x * 3); st.rot += (1 - q) * (params.degrees ?? -90); st.sc *= lerp(params.from ?? 0.5, 1, q); break; }
      case 'tracking-in': st.op *= p; st.spacing = lerp(params.from ?? 0.5, 0, p); break;
      case 'draw': st.draw = p; break;
      case 'draw-out': st.draw = 1 - p; break;
      case 'reveal-circle': st.clip = `circle(${p * (params.reach ?? 150)}% at ${params.x ?? 50}% ${params.y ?? 50}%)`; break;
      case 'count-up': st.count = p; break;
      case 'shake': { const decay = 1 - p; st.tx += Math.sin(lt * 70) * (params.amount ?? 8) * decay; st.ty += Math.cos(lt * 53) * (params.amount ?? 8) * 0.6 * decay; break; }
      // loops: they run for as long as the layer is there (the period is in seconds)
      case 'float': st.ty += Math.sin(((lt - a.start) / (params.period ?? 3)) * Math.PI * 2) * (params.amplitude ?? 12); break;
      case 'sway': st.rot += Math.sin(((lt - a.start) / (params.period ?? 4)) * Math.PI * 2) * (params.degrees ?? 3); break;
      case 'pulse': st.sc *= 1 + Math.sin(((lt - a.start) / (params.period ?? 1.4)) * Math.PI * 2) * (params.amount ?? 0.04); break;
      case 'drift': st.tx += (lt - a.start) * (params.dx ?? 10); st.ty += (lt - a.start) * (params.dy ?? 0); break;
      default: break;
    }
    return undefined;
  }

  function applyKeyframes(a, rel, st) {
    const byProp = {};
    for (const k of a.keyframes) (byProp[k.prop] ??= []).push(k);
    for (const [prop, list] of Object.entries(byProp)) {
      list.sort((m, n) => m.t - n.t);
      let value = list[0].value;
      if (rel >= list.at(-1).t) value = list.at(-1).value;
      else if (rel > list[0].t) {
        for (let i = 0; i + 1 < list.length; i++) {
          if (rel >= list[i].t && rel <= list[i + 1].t) {
            const span = list[i + 1].t - list[i].t || 1;
            value = lerp(list[i].value, list[i + 1].value, ease(list[i + 1].ease ?? a.ease, (rel - list[i].t) / span));
            break;
          }
        }
      }
      if (prop === 'opacity') st.op *= value;
      else if (prop === 'scale') st.sc *= value;
      else if (prop === 'rotate') st.rot += value;
      else if (prop === 'blur') st.blur = Math.max(st.blur ?? 0, value);
      else if (prop === 'draw') st.draw = value;
      else st.abs[prop] = value;
    }
  }

  function activeWord(times, t) {
    let idx = -1;
    for (let i = 0; i < times.length; i++) if (times[i] <= t + 1e-6) idx = i;
    return idx;
  }

  function setTime(t) {
    for (const it of items) {
      const m = it.meta;
      const on = t >= m.start - 1e-6 && t < m.end - 1e-6;
      if (!on) { it.el.style.visibility = 'hidden'; continue; }
      const lt = t - m.start;
      const st = { op: 1, tx: 0, ty: 0, sc: 1, rot: 0, clip: null, chars: null, words: null, abs: {}, blur: 0, spacing: null, draw: null, count: null };
      for (const a of m.anim) applyAnim(a, lt, st);
      const el = it.el;
      el.style.visibility = 'visible';
      el.style.opacity = String(it.baseOpacity * st.op);
      el.style.translate = st.tx || st.ty ? `${st.tx * u}px ${st.ty * u}px` : '';
      el.style.scale = st.sc !== 1 ? String(st.sc) : '';
      el.style.rotate = st.rot ? `${st.rot}deg` : '';
      el.style.clipPath = st.clip ?? it.baseClip;
      el.style.filter = st.blur > 0.01 ? `${it.baseFilter} blur(${st.blur * u}px)`.trim() : it.baseFilter;
      if (st.spacing !== null) el.style.letterSpacing = `${it.baseSpacing + st.spacing}em`;
      if (st.draw !== null && it.path) it.path.style.strokeDashoffset = String(1 - clamp01(st.draw));
      if (it.counter && st.count !== null) {
        const prm = it.counter.params ?? {};
        const v = lerp(prm.from ?? 0, prm.to ?? 100, st.count);
        const n = Number(v.toFixed(prm.decimals ?? 0));
        const text = prm.separator === false ? String(n) : n.toLocaleString('en-AU', { minimumFractionDigits: prm.decimals ?? 0, maximumFractionDigits: prm.decimals ?? 0 });
        el.textContent = `${prm.prefix ?? ''}${text}${prm.suffix ?? ''}`;
      }
      el.style.left = st.abs.x !== undefined ? `calc(var(--cw) * ${st.abs.x / 100})` : it.baseLeft;
      el.style.top = st.abs.y !== undefined ? `calc(var(--ch) * ${st.abs.y / 100})` : it.baseTop;
      el.style.width = st.abs.w !== undefined ? `calc(var(--cw) * ${st.abs.w / 100})` : it.baseWidth;
      el.style.height = st.abs.h !== undefined ? `calc(var(--ch) * ${st.abs.h / 100})` : it.baseHeight;
      if (it.chars) { const n = Math.floor((st.chars ?? 1) * it.chars.length + 1e-9); it.chars.forEach((s, i) => { s.style.visibility = i < n ? 'visible' : 'hidden'; }); }
      if (it.words) {
        const total = it.words.length;
        it.words.forEach((s, i) => { const o = clamp01(((st.words ?? 1) * total - i) / 1); s.style.opacity = String(o); s.style.display = 'inline-block'; s.style.transform = `translateY(${(1 - o) * 12 * u}px)`; });
      }
      if (it.runs && m.caption) {
        const c = m.caption;
        const active = c.highlight === 'word' ? activeWord(c.wordStarts, t) : c.highlight === 'line' ? -2 : -3;
        if (active !== it.lastHighlight) {
          it.runs.forEach((s, i) => { s.style.color = c.highlight === 'line' ? c.hi : i === active ? c.hi : ''; });
          it.lastHighlight = active;
        }
      }
    }
  }

  /** Where each layer sits when it is fully in (for the safe-zone checks). */
  function measure(t) {
    setTime(t);
    const out = [];
    for (const it of items) {
      if (it.el.style.visibility === 'hidden') continue;
      const el = it.el;
      let r = el.getBoundingClientRect();
      if (el.dataset.type === 'text' || el.dataset.type === 'group') {
        // where the words themselves are (a group's frame or a card behind them does not matter for the safe area)
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        while (walker.nextNode()) {
          if (!walker.currentNode.nodeValue.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          for (const q of range.getClientRects()) { if (q.width < 1) continue; x0 = Math.min(x0, q.left); y0 = Math.min(y0, q.top); x1 = Math.max(x1, q.right); y1 = Math.max(y1, q.bottom); }
        }
        if (x1 > x0) r = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      }
      out.push({ id: it.meta.id, type: el.dataset.type, ignoreSafe: el.dataset.safe === '0', x: r.x, y: r.y, w: r.width, h: r.height });
    }
    return out;
  }

  window.__nv = { setTime, measure, count: items.length, missing: cfg.layers.length - items.length };
  return { count: items.length, missing: cfg.layers.length - items.length };
}
