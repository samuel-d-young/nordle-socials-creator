// Before you invite someone to the repo: node tools/share-check.mjs   (npm run share-check)
// Reads the local, gitignored `.share-deny.txt` (one term per line, case-insensitive; lines starting with # are comments: client names, your own name, drive
// letters, anything that must not be in a shared repo) and looks for those terms in every file git would ship (tracked files and new files that are not ignored).
// It also looks for things that look like keys or tokens. It never prints a secret, only the file and line. Exit code 1 when anything is found.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 1e8 }).split('\n').filter(Boolean);
const files = [...new Set([...git('ls-files'), ...git('ls-files', '--others', '--exclude-standard')])];
const denyFile = join(ROOT, '.share-deny.txt');
const deny = existsSync(denyFile) ? readFileSync(denyFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
if (!deny.length) console.log('note: there is no .share-deny.txt (or it is empty), so only the key check runs. Put your client names, your name and local drive paths in it, one per line.');
const SECRET = [/\bsk-[A-Za-z0-9_-]{20,}/, /\bghp_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bxox[baprs]-[A-Za-z0-9-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /"token"\s*:\s*"[A-Za-z0-9_\-]{24,}"/, /Bearer\s+[A-Za-z0-9._-]{30,}/];
const SKIP = /\.(png|jpe?g|gif|webp|mp4|mov|wav|mp3|woff2?|ttf|otf|ico|pdf|zip|cube)$/i;
const hits = [];
for (const f of files) {
  if (SKIP.test(f) || !existsSync(join(ROOT, f))) continue;
  const p = join(ROOT, f);
  if (statSync(p).size > 2e6) continue;
  const lines = readFileSync(p, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const low = line.toLowerCase();
    for (const t of deny) if (low.includes(t.toLowerCase())) hits.push({ f, n: i + 1, why: `term "${t}"` });
    for (const re of SECRET) if (re.test(line) && !/EXAMPLE/.test(line)) hits.push({ f, n: i + 1, why: 'looks like a key or token' });
  });
}
const byFile = new Map();
for (const h of hits) (byFile.get(h.f) ?? byFile.set(h.f, []).get(h.f)).push(h);
for (const [f, hs] of byFile) console.log(`${f}  (${hs.length}): ${[...new Set(hs.map((h) => h.why))].slice(0, 5).join(', ')}  lines ${hs.slice(0, 8).map((h) => h.n).join(', ')}${hs.length > 8 ? ', ...' : ''}`);
console.log(`\n${files.length} files checked, ${hits.length} hit${hits.length === 1 ? '' : 's'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'}.`);
process.exit(hits.length ? 1 : 0);
