// Mounts: footage and music stay where they are on the computer. A project's nordle.local.json (machine-only, never shared)
// says where each mount points: {"mounts": {"footage": "D:/Some/Folder"}}. Documents refer to a file as
// "mount:footage/Some/File.mp4". Only the render and probe code ever turns that into a real path, and it refuses anything
// that would leave the mount's folder.

import { existsSync, readFileSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const MOUNT_FILE = 'nordle.local.json';
const NAME = /^[a-z0-9][a-z0-9_-]*$/;

export class MountError extends Error {
  constructor(message, code) { super(message); this.name = 'MountError'; this.code = code; }
}

/** The mounts configured for a project: { name: absoluteFolder }. A missing file means no mounts. */
export function loadMounts(projectDir) {
  const file = join(projectDir, MOUNT_FILE);
  if (!existsSync(file)) return {};
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new MountError(`${MOUNT_FILE} is not valid JSON: ${e.message}`, 'mount-config'); }
  const out = {};
  for (const [name, folder] of Object.entries(data?.mounts ?? {})) {
    if (!NAME.test(name)) throw new MountError(`${MOUNT_FILE}: mount name "${name}" is not allowed (use lower-case letters, digits, - and _).`, 'mount-config');
    if (typeof folder !== 'string' || !isAbsolute(folder)) throw new MountError(`${MOUNT_FILE}: mount "${name}" must point at an absolute folder path.`, 'mount-config');
    out[name] = resolve(folder);
  }
  return out;
}

/** "mount:name/rest" -> { name, rest }, or null when the path is an ordinary project path. */
export function parseMountRef(p) {
  if (typeof p !== 'string' || !p.startsWith('mount:')) return null;
  const body = p.slice('mount:'.length);
  const slash = body.indexOf('/');
  const name = slash < 0 ? body : body.slice(0, slash);
  const rest = slash < 0 ? '' : body.slice(slash + 1);
  return { name, rest };
}

/** Is `rest` a plain path that stays inside whatever folder it is joined to? */
export function safeRest(rest) {
  if (typeof rest !== 'string' || rest.includes('\0') || rest.includes('\\')) return false;
  if (rest.startsWith('/') || /^[A-Za-z]:/.test(rest)) return false;
  return !rest.split('/').some((part) => part === '..');
}

/** Syntax check only (no disk access): used by the validator. Returns an error message or null. */
export function mountRefProblem(p) {
  const ref = parseMountRef(p);
  if (!ref) return null;
  if (!NAME.test(ref.name)) return `mount name "${ref.name}" is not valid`;
  if (!ref.rest) return 'a mount path needs a file name after the mount name';
  if (!safeRest(ref.rest)) return `"${p}" is not allowed: a mount path may not contain .., a drive letter or a backslash`;
  return null;
}

function inside(base, abs) {
  return abs === base || abs.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Turn "mount:name/path" (or a project-relative path) into an absolute path.
 * Throws a MountError with a plain-words message when the mount is missing, its folder is not there, or the path escapes.
 */
export function resolveMediaPath(projectDir, p, mounts = loadMounts(projectDir)) {
  const ref = parseMountRef(p);
  if (!ref) {
    if (!safeRest(p)) throw new MountError(`"${p}" is not allowed: paths stay inside the project folder.`, 'path-escape');
    const abs = resolve(projectDir, p);
    if (!inside(resolve(projectDir), abs)) throw new MountError(`"${p}" leaves the project folder.`, 'path-escape');
    return abs;
  }
  if (!NAME.test(ref.name)) throw new MountError(`"${p}": mount name "${ref.name}" is not valid.`, 'mount-name');
  const folder = mounts[ref.name];
  if (!folder) {
    const known = Object.keys(mounts);
    throw new MountError(`Mount "${ref.name}" is not set up on this computer. Add it to ${join(projectDir, MOUNT_FILE)} like {"mounts": {"${ref.name}": "<full folder path>"}}.${known.length ? ` Mounts that exist: ${known.join(', ')}.` : ''}`, 'mount-missing');
  }
  if (!safeRest(ref.rest)) throw new MountError(`"${p}" is not allowed: a mount path may not contain .., a drive letter or a backslash.`, 'mount-escape');
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new MountError(`Mount "${ref.name}" points at ${folder}, which is not available right now (is the drive connected?).`, 'mount-folder-missing');
  }
  const abs = resolve(folder, ...ref.rest.split('/').filter(Boolean));
  if (!inside(folder, abs)) throw new MountError(`"${p}" leaves the mount "${ref.name}".`, 'mount-escape');
  // a symbolic link inside the mount must not lead out of it either
  if (existsSync(abs)) {
    const real = realpathSync(abs);
    const realBase = realpathSync(folder);
    if (!inside(realBase, real)) throw new MountError(`"${p}" leaves the mount "${ref.name}" (through a link).`, 'mount-escape');
  }
  return abs;
}

/** List the files and folders directly inside a directory of a mount (or of the project's sources). */
export function listMountDir(projectDir, name, dir = '', mounts = loadMounts(projectDir)) {
  const folder = mounts[name];
  if (!folder) throw new MountError(`Mount "${name}" is not set up on this computer. Add it to ${join(projectDir, MOUNT_FILE)}.`, 'mount-missing');
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new MountError(`Mount "${name}" points at ${folder}, which is not available right now (is the drive connected?).`, 'mount-folder-missing');
  if (dir && !safeRest(dir)) throw new MountError(`"${dir}" is not allowed.`, 'mount-escape');
  const abs = dir ? resolve(folder, ...dir.split('/').filter(Boolean)) : resolve(folder);
  if (!inside(folder, abs)) throw new MountError('That folder leaves the mount.', 'mount-escape');
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new MountError(`There is no folder "${dir}" in mount "${name}".`, 'mount-missing');
  if (!inside(realpathSync(folder), realpathSync(abs))) throw new MountError('That folder leaves the mount (through a link).', 'mount-escape');
  return readdirSync(abs, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).map((e) => {
    let size = null;
    if (e.isFile()) { try { size = statSync(join(abs, e.name)).size; } catch { /* unreadable */ } }
    return { name: e.name, type: e.isDirectory() ? 'folder' : 'file', size };
  }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
}
