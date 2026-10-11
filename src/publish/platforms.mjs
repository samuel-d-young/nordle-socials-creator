// Publishing platforms that are listed in the Publishing window so a key can be saved for each, next to Buffer and the export folder.
//
// HONESTY NOTE: Buffer and the export folder are the only two Nordle can actually post through (src/publish/adapters). The others here are
// listed with a place for the owner's API key; Nordle keeps the key in the same private file as the Buffer keys and never shows it again,
// but it does NOT send posts through these services yet (no adapter exists for them, and none was tried against a live account). The window
// says so on every one. They are data: adding an adapter later means writing it and turning `posting` on for that entry.
//
//   settings.platforms.<id> = { token, savedAt }

import { PublishError, changeSettings, loadSettings } from './store.mjs';

export const PLATFORMS = [
  { id: 'sprout', name: 'Sprout Social' },
  { id: 'hootsuite', name: 'Hootsuite' },
  { id: 'later', name: 'Later' },
  { id: 'metricool', name: 'Metricool' },
  { id: 'publer', name: 'Publer' },
  { id: 'planable', name: 'Planable' },
].map((p) => ({ ...p, posting: false, note: `Create an API key or access token in ${p.name}’s own settings and paste it here.` }));

const byId = (id) => PLATFORMS.find((p) => p.id === id);

/** What the window needs: never the key itself, only whether one is saved, when, and its last four characters. */
export function listPlatforms(settings = loadSettings()) {
  return PLATFORMS.map((p) => {
    const saved = settings.platforms?.[p.id];
    return { ...p, configured: !!saved?.token, savedAt: saved?.savedAt ?? null, keyHint: saved?.token ? String(saved.token).slice(-4) : null };
  });
}

/** Save (token: a string) or forget (token: null) the key of one listed platform. */
export function savePlatformKey(id, token) {
  const p = byId(String(id ?? ''));
  if (!p) throw new PublishError(404, `There is no listed platform "${id}". Listed: ${PLATFORMS.map((x) => x.id).join(', ')}.`);
  if (token !== null && (typeof token !== 'string' || token.trim().length < 8 || token.length > 500 || /\s/.test(token.trim()))) {
    throw new PublishError(400, `That does not look like an API key (it is empty, very short or has spaces). Paste the key exactly as ${p.name} shows it.`);
  }
  changeSettings((s) => {
    s.platforms = s.platforms && typeof s.platforms === 'object' ? s.platforms : {};
    if (token === null) delete s.platforms[p.id];
    else s.platforms[p.id] = { token: token.trim(), savedAt: new Date().toISOString() };
  });
  return listPlatforms().find((x) => x.id === p.id);
}
