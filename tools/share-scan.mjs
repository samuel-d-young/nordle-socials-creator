// The parts of the share gate (tools/share-check.mjs) that can be tested without a git repo: reading the term lists and
// deciding which hits are already known.
//
// `.share-allow.txt` (local, gitignored, like `.share-deny.txt`) lists hits the owner has looked at and kept on purpose, one per
// line as `<file> | <term>`: the file as git names it (forward slashes; `*` matches any run of characters), the term as it is in
// the deny list (any letter case). A line starting with # is a comment. An allowed hit is counted, not listed, so a new hit is
// never lost among old ones. Key and token hits can never be allowed.

export const readTerms = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

export function parseAllow(text) {
  const rules = [];
  const bad = [];
  for (const line of readTerms(text)) {
    const at = line.indexOf('|');
    const file = at < 0 ? '' : line.slice(0, at).trim().replace(/\\/g, '/');
    const term = at < 0 ? '' : line.slice(at + 1).trim().toLowerCase();
    if (!file || !term) { bad.push(line); continue; }
    const re = new RegExp(`^${file.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    rules.push({ file, term, re });
  }
  return { rules, bad };
}

// hit: { f, term } for a deny-list hit; a hit with no term (a key or token) is never allowed
export const isAllowed = (rules, hit) => Boolean(hit.term) && rules.some((r) => r.term === hit.term.toLowerCase() && r.re.test(hit.f));
