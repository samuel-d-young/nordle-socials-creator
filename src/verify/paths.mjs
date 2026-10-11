// Finding the files a document refers to. Photos and clips normally sit inside the project; footage and music that stay where
// they are on the owner's disks are named "mount:<name>/<path>" and the folder for <name> is in nordle.local.json
// ({"mounts": {"<name>": "<folder>"}}), which never leaves the machine.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

const MOUNT = /^mount:([A-Za-z0-9_-]+)\/(.+)$/;

export function readLocalSettings(projectDir) {
  try { return JSON.parse(readFileSync(join(projectDir, 'nordle.local.json'), 'utf8')); } catch { return {}; }
}

export function readProjectSettings(projectDir) {
  try { return JSON.parse(readFileSync(join(projectDir, 'nordle.project.json'), 'utf8')); } catch { return {}; }
}

/** A project path that is safe to join: no drive letter, no backslash, no "..". */
export const isSafeRel = (p) => typeof p === 'string' && p.length > 0 && !isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.includes('\\') && !p.split('/').includes('..') && !p.includes('\0');

/**
 * Where a project path really is on this machine.
 * @returns {{ref:string, abs:string|null, exists:boolean, mount:string|null, reason?:string}}
 */
export function resolveMedia(projectDir, ref, local = readLocalSettings(projectDir)) {
  const m = MOUNT.exec(String(ref ?? ''));
  if (m) {
    const base = local.mounts?.[m[1]];
    if (!base) return { ref, abs: null, exists: false, mount: m[1], reason: `the folder "${m[1]}" is not set up on this computer (nordle.local.json mounts)` };
    if (!isSafeRel(m[2])) return { ref, abs: null, exists: false, mount: m[1], reason: 'the path leaves its folder' };
    const abs = resolve(base, m[2]);
    if (abs !== resolve(base) && !abs.startsWith(resolve(base) + sep)) return { ref, abs: null, exists: false, mount: m[1], reason: 'the path leaves its folder' };
    return { ref, abs, exists: existsSync(abs), mount: m[1], ...(existsSync(abs) ? {} : { reason: `the file is not at ${abs}` }) };
  }
  if (!isSafeRel(ref)) return { ref, abs: null, exists: false, mount: null, reason: 'the path is not a safe project path' };
  const abs = resolve(projectDir, ref);
  if (abs !== resolve(projectDir) && !abs.startsWith(resolve(projectDir) + sep)) return { ref, abs: null, exists: false, mount: null, reason: 'the path leaves the project' };
  return { ref, abs, exists: existsSync(abs), mount: null };
}

export const sizeOf = (file) => { try { return statSync(file).size; } catch { return 0; } };

/** Same file, written differently? (./a\b.jpg and a/b.jpg) */
export const normaliseRef = (ref) => String(ref ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
