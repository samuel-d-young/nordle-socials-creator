// Edits as JSON Patch (RFC 6902: add, remove, replace, move, copy, test), with the inverse patch worked out as the
// edit is applied, so every change can be undone exactly. Also the "locks" check. Pure: runs in Node and in the browser.

export class PatchError extends Error {
  constructor(message, opIndex) { super(message); this.name = 'PatchError'; this.opIndex = opIndex; }
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export function parsePointer(pointer) {
  if (typeof pointer !== 'string') throw new PatchError('a path must be a string');
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new PatchError(`bad path "${pointer}" (must start with /)`);
  const parts = pointer.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const p of parts) if (FORBIDDEN.has(p)) throw new PatchError(`path "${pointer}" is not allowed`);
  return parts;
}

export function toPointer(parts) {
  return parts.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

export const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

function arrayIndex(key, length, { allowEnd }, path) {
  if (!/^(0|[1-9]\d*)$/.test(key)) throw new PatchError(`"${key}" is not an array position (in ${path})`);
  const i = Number(key);
  if (i > length || (!allowEnd && i === length)) throw new PatchError(`position ${i} is outside the list (in ${path}, length ${length})`);
  return i;
}

function walk(root, parts, path) {
  let node = root;
  for (const key of parts) {
    if (Array.isArray(node)) node = node[arrayIndex(key, node.length, { allowEnd: false }, path)];
    else if (node && typeof node === 'object' && Object.hasOwn(node, key)) node = node[key];
    else throw new PatchError(`nothing at ${path}`);
  }
  return node;
}

export function getAt(doc, pointer) { return walk(doc, parsePointer(pointer), pointer); }
export function hasAt(doc, pointer) { try { walk(doc, parsePointer(pointer), pointer); return true; } catch { return false; } }

function parentOf(root, pointer) {
  const parts = parsePointer(pointer);
  if (parts.length === 0) throw new PatchError('the whole document cannot be edited with this operation');
  return { parent: walk(root, parts.slice(0, -1), pointer), key: parts[parts.length - 1], parts };
}

function insert(root, pointer, value) {
  const { parent, key, parts } = parentOf(root, pointer);
  if (Array.isArray(parent)) {
    const i = key === '-' ? parent.length : arrayIndex(key, parent.length, { allowEnd: true }, pointer);
    parent.splice(i, 0, value);
    return { inverse: { op: 'remove', path: toPointer([...parts.slice(0, -1), i]) } };
  }
  if (!parent || typeof parent !== 'object') throw new PatchError(`cannot add inside ${pointer}`);
  if (Object.hasOwn(parent, key)) {
    const old = clone(parent[key]);
    parent[key] = value;
    return { inverse: { op: 'replace', path: pointer, value: old } };
  }
  parent[key] = value;
  return { inverse: { op: 'remove', path: pointer } };
}

function take(root, pointer) {
  const { parent, key, parts } = parentOf(root, pointer);
  if (Array.isArray(parent)) {
    const i = arrayIndex(key, parent.length, { allowEnd: false }, pointer);
    const [old] = parent.splice(i, 1);
    return { old, inverse: { op: 'add', path: toPointer([...parts.slice(0, -1), i]), value: clone(old) } };
  }
  if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new PatchError(`nothing to remove at ${pointer}`);
  const old = parent[key];
  delete parent[key];
  return { old, inverse: { op: 'add', path: pointer, value: clone(old) } };
}

/**
 * Apply operations to a copy of `doc`.
 * @returns {{doc:any, inverse:object[]}} the new document and the patch that undoes these operations
 */
export function applyOps(doc, ops) {
  if (!Array.isArray(ops)) throw new PatchError('operations must be a list');
  const work = clone(doc);
  const inverse = [];
  ops.forEach((op, index) => {
    try {
      if (!op || typeof op !== 'object') throw new PatchError('an operation must be an object');
      switch (op.op) {
        case 'add': {
          if (!('value' in op)) throw new PatchError('add needs a value');
          if (op.path === '') throw new PatchError('the whole document cannot be replaced with add');
          inverse.push(insert(work, op.path, clone(op.value)).inverse);
          break;
        }
        case 'remove': inverse.push(take(work, op.path).inverse); break;
        case 'replace': {
          if (!('value' in op)) throw new PatchError('replace needs a value');
          const { parent, key, parts } = parentOf(work, op.path);
          if (Array.isArray(parent)) {
            const i = arrayIndex(key, parent.length, { allowEnd: false }, op.path);
            inverse.push({ op: 'replace', path: toPointer([...parts.slice(0, -1), i]), value: clone(parent[i]) });
            parent[i] = clone(op.value);
          } else {
            if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new PatchError(`nothing to replace at ${op.path}`);
            inverse.push({ op: 'replace', path: op.path, value: clone(parent[key]) });
            parent[key] = clone(op.value);
          }
          break;
        }
        case 'move': {
          if (op.from === op.path) break;
          if (op.path.startsWith(`${op.from}/`)) throw new PatchError('cannot move something inside itself');
          const taken = take(work, op.from);
          inverse.push(taken.inverse); // undo of the removal comes last in the reversed list
          const added = insert(work, op.path, taken.old);
          inverse.push(added.inverse);
          break;
        }
        case 'copy': inverse.push(insert(work, op.path, clone(getAt(work, op.from))).inverse); break;
        case 'test':
          if (!deepEqual(getAt(work, op.path), op.value)) throw new PatchError(`test failed at ${op.path}`);
          break;
        default: throw new PatchError(`unknown operation "${op.op}"`);
      }
    } catch (e) {
      if (e instanceof PatchError) { e.opIndex = index; e.message = `operation ${index + 1} (${op?.op} ${op?.path}): ${e.message}`; }
      throw e;
    }
  });
  return { doc: work, inverse: inverse.reverse() };
}

/** The paths an operation list touches (for deciding whether two edits can be merged). */
export function touchedPaths(ops) {
  return ops.flatMap((o) => [o.path, o.from].filter((p) => typeof p === 'string'));
}

export const isPrefix = (a, b) => a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);

/** Build the operation that sets a value at a path, choosing add or replace from what is there now. */
export function setOp(doc, pointer, value) {
  if (value === undefined) return hasAt(doc, pointer) ? { op: 'remove', path: pointer } : null;
  return { op: hasAt(doc, pointer) ? 'replace' : 'add', path: pointer, value };
}

/** Operations that set several values, creating any missing parent objects (such as overrides) on the way. */
export function buildSetOps(doc, entries) {
  const ops = [];
  let tmp = doc;
  for (const { pointer, value } of entries) {
    const step = [];
    const parts = pointer.split('/');
    for (let i = 2; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (!hasAt(tmp, prefix) && value !== undefined) step.push({ op: 'add', path: prefix, value: {} });
    }
    let probe = tmp;
    try { probe = step.length ? applyOps(tmp, step).doc : tmp; } catch { /* handled below */ }
    const main = setOp(probe, pointer, value);
    // setting a value to what it already is changes nothing, so it makes no edit (and no history entry)
    if (main && !(main.op === 'replace' && deepEqual(getAt(probe, pointer), value))) step.push(main);
    if (step.length) { ops.push(...step); tmp = applyOps(tmp, step).doc; }
  }
  return ops;
}

// ---- locks ---------------------------------------------------------------------------------------------------------

function lockedNodes(doc) {
  const found = [];
  const visit = (layers, page, trail) => {
    for (const l of layers ?? []) {
      if (l.lock) found.push({ page, layer: l.id, key: `${page}/${[...trail, l.id].join('/')}`, node: l });
      if (l.children) visit(l.children, page, [...trail, l.id]);
    }
  };
  (doc.pages ?? []).forEach((p) => {
    if (p.lock) found.push({ page: p.id, layer: null, key: p.id, node: p });
    visit(p.layers, p.id, []);
  });
  visit(doc.layers, 'overlay', []);
  return found;
}

function findNode(doc, entry) {
  if (entry.layer === null) return (doc.pages ?? []).find((p) => p.id === entry.page);
  const search = (layers) => {
    for (const l of layers ?? []) {
      if (l.id === entry.layer) return l;
      const inner = l.children && search(l.children);
      if (inner) return inner;
    }
    return undefined;
  };
  if (entry.page === 'overlay') return search(doc.layers);
  return search((doc.pages ?? []).find((p) => p.id === entry.page)?.layers);
}

/**
 * Anything locked in `before` must be unchanged (and still present) in `after`. A locked page protects everything on it.
 * Returns a list of {page, layer, message}; empty means the edit respects every lock.
 */
export function lockViolations(before, after) {
  const out = [];
  for (const entry of lockedNodes(before)) {
    const now = findNode(after, entry);
    const what = entry.layer ? `layer "${entry.layer}" on page "${entry.page}"` : `page "${entry.page}"`;
    if (!now) out.push({ page: entry.page, layer: entry.layer, message: `${what} is locked and cannot be removed` });
    else if (!deepEqual(entry.node, now)) out.push({ page: entry.page, layer: entry.layer, message: `${what} is locked and cannot be changed` });
  }
  return out;
}
